// Local copies of the stems, videos and PDF scores of the songs. Files are downloaded
// once (Rust side, <media folder>/<storage path>), or copied there when
// uploaded from this computer, and then played offline.
import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getDownloadURL, ref } from 'firebase/storage';
import { stemsOf, videoOf } from '../shared/media.js';
import { scoreOf } from '../shared/score.js';
import { storage } from './firebase';

// storage path → { local, ready, downloading, received, total, error }
let state = {};
const listeners = new Set();
const set = (path, patch) => {
  state = { ...state, [path]: { ...(state[path] || {}), ...patch } };
  listeners.forEach((f) => f());
};
const subscribe = (f) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

listen('media-progress', (e) => {
  const { path, received, total } = e.payload;
  set(path, { received, total });
});

export function useMediaCache() {
  return useSyncExternalStore(subscribe, () => state);
}

export function mediaOf(item) {
  const list = stemsOf(item).map((s) => ({ path: s.path, size: s.size }));
  const v = videoOf(item);
  if (v) list.push({ path: v.path, size: v.size });
  const score = scoreOf(item);
  if (score) list.push({ path: score.path, size: score.size });
  return list;
}

/** Checks which files of these items are already on disk. */
export async function checkCache(items) {
  const entries = items.flatMap(mediaOf).filter((e) => !state[e.path]?.downloading);
  if (!entries.length) return;
  const res = await invoke('cache_status', { entries });
  res.forEach((r) => set(r.path, { local: r.local, ready: r.ready }));
}

const queue = [];
let running = 0;
const MAX_PARALLEL = 3;

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    running += 1;
    job().finally(() => {
      running -= 1;
      pump();
    });
  }
}

/** Downloads one file if missing; resolves with its local path (or null). */
export function ensureFile(entry) {
  const cur = state[entry.path];
  if (cur?.ready) return Promise.resolve(cur.local);
  if (cur?.promise) return cur.promise;
  const promise = new Promise((resolve) => {
    queue.push(async () => {
      set(entry.path, { downloading: true, error: null, received: 0, total: entry.size || 0 });
      try {
        const url = await getDownloadURL(ref(storage, entry.path));
        const local = await invoke('download_media', { url, path: entry.path });
        set(entry.path, { local, ready: true, downloading: false, promise: null });
        resolve(local);
      } catch (e) {
        set(entry.path, { downloading: false, error: String(e?.message || e), promise: null });
        resolve(null);
      }
    });
    pump();
  });
  set(entry.path, { promise, error: null, received: 0 });
  return promise;
}

/** The files not on disk yet, among [{ path, size }]. */
export const missingFiles = (files) => files.filter((f) => !state[f.path]?.ready);

/** How much of these files is done, 0..1, weighted by size (failed ones count as done). */
export function downloadProgress(files, cache = state) {
  let done = 0;
  let total = 0;
  files.forEach((f) => {
    const c = cache[f.path] || {};
    const size = f.size || c.total || 1;
    total += size;
    done += c.ready || c.error ? size : Math.min(c.received || 0, size);
  });
  return total ? done / total : 0;
}

const CHUNK = 8 * 1024 * 1024;

/**
 * Copies a file uploaded from this computer into the cache under its storage
 * path, so it is ready to play without downloading it back.
 */
export function storeLocal(path, file) {
  const promise = copyLocal(path, file);
  set(path, { promise });
  return promise;
}

async function copyLocal(path, file) {
  set(path, { downloading: true, error: null, received: 0, total: file.size });
  try {
    let offset = 0;
    do {
      const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
      await invoke('store_media_chunk', bytes, { headers: { 'x-path': encodeURIComponent(path), 'x-offset': String(offset) } });
      offset += bytes.length;
      set(path, { received: offset });
    } while (offset < file.size);
    const local = await invoke('store_media_done', { path, size: file.size });
    set(path, { local, ready: true, downloading: false, promise: null });
    return local;
  } catch (e) {
    // Not fatal: the file is downloaded instead.
    console.warn('Copia locale non riuscita', e);
    set(path, { downloading: false, received: 0, promise: null });
    return ensureFile({ path, size: file.size });
  }
}

export function ensureItems(items) {
  return Promise.all(items.flatMap(mediaOf).map(ensureFile));
}

/** 'none' | 'ready' | 'partial' | 'downloading' | 'error' for a song. */
export function itemCacheState(item, cache = state) {
  const files = mediaOf(item);
  if (!files.length) return 'none';
  const st = files.map((f) => cache[f.path] || {});
  if (st.some((s) => s.downloading)) return 'downloading';
  if (st.every((s) => s.ready)) return 'ready';
  if (st.some((s) => s.error)) return 'error';
  return 'partial';
}

// ---------- Waveforms ----------
// local path → { peaks: Uint8Array, pps, duration }
let peaks = {};
const requested = new Set();
const peakListeners = new Set();

listen('media-peaks', (e) => {
  const { path, peaks: data, peaksPerSec, duration, error } = e.payload;
  if (error) return;
  peaks = { ...peaks, [path]: { peaks: Uint8Array.from(data), pps: peaksPerSec, duration } };
  peakListeners.forEach((f) => f());
});

export function usePeaks() {
  return useSyncExternalStore(
    (f) => {
      peakListeners.add(f);
      return () => peakListeners.delete(f);
    },
    () => peaks,
  );
}

export function requestPeaks(paths) {
  const fresh = paths.filter((p) => p && !requested.has(p));
  fresh.forEach((p) => requested.add(p));
  if (fresh.length) invoke('request_peaks', { paths: fresh });
}
