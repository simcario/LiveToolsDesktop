// Local copies of the stems, videos and PDF scores of the songs. Files are downloaded
// once (Rust side, <media folder>/<storage path>), or copied there when
// uploaded from this computer, and then played offline.
import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getDownloadURL, ref } from 'firebase/storage';
import { isLocalPath, setLocalFiles, stemsOf, videoOf } from '../shared/media.js';
import { driveMediaUrl, driveToken, isDrivePath } from '../shared/drive.js';

// Files of the Free plan (local/…): only in this cache, nothing to download.
setLocalFiles({ remove: (path) => invoke('delete_local_media', { path }).then(() => set(path, { ready: false, local: null })) });
export const LOCAL_MISSING = 'File solo sul dispositivo che lo ha aggiunto: qui non c’è.';
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

// Plus plan: the file is on the Google Drive the owner connected (shared/drive.js);
// Rust downloads it with the access token. One retry with a new token.
async function fromDrive(path) {
  const url = driveMediaUrl(path);
  try {
    return await invoke('download_media', { url, path, bearer: (await driveToken()).accessToken });
  } catch (e) {
    if (!/scaduto/.test(String(e))) throw e;
    return invoke('download_media', { url, path, bearer: (await driveToken({ fresh: true })).accessToken });
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
        if (isLocalPath(entry.path)) throw new Error(LOCAL_MISSING);
        const local = isDrivePath(entry.path) ? await fromDrive(entry.path) : await invoke('download_media', { url: await getDownloadURL(ref(storage, entry.path)), path: entry.path });
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

// Android's IPC carries JSON only (no raw body): chunks go as base64, smaller.
const ANDROID = /android/i.test(navigator.userAgent);
const CHUNK_SIZE = ANDROID ? 2 * 1024 * 1024 : CHUNK;

const base64Of = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

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
      const part = file.slice(offset, offset + CHUNK_SIZE);
      const body = ANDROID ? await base64Of(part) : new Uint8Array(await part.arrayBuffer());
      await invoke('store_media_chunk', body, { headers: { 'x-path': encodeURIComponent(path), 'x-offset': String(offset) } });
      offset += part.size;
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
