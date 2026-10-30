// App updates: checks the release feed (plugins.updater in tauri.conf.json),
// downloads the signed installer and runs it. Shared state for the status bar
// chip and the Preferences section.
import { useSyncExternalStore } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

// status: idle | checking | none | available | downloading | installing | error
let state = { status: 'idle', current: null, version: null, notes: '', date: null, done: 0, total: 0, error: null, checkedAt: null };
let pending = null; // Update object returned by check()
const listeners = new Set();
const set = (patch) => {
  state = { ...state, ...patch };
  listeners.forEach((f) => f());
};
const subscribe = (f) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

getVersion()
  .then((current) => set({ current }))
  .catch(() => {});

export function useUpdater(select = (s) => s) {
  return useSyncExternalStore(subscribe, () => select(state));
}

/** Looks for a newer release. With `silent` a failure (offline at the venue) leaves no error behind. */
export async function checkForUpdates({ silent = false } = {}) {
  if (['checking', 'downloading', 'installing'].includes(state.status)) return;
  set({ status: 'checking', error: null });
  try {
    const update = await check({ timeout: 15000 });
    pending = update;
    if (update) set({ status: 'available', version: update.version, notes: update.body || '', date: update.date || null });
    else set({ status: 'none', version: null, notes: '' });
  } catch (e) {
    set(silent ? { status: 'idle' } : { status: 'error', error: String(e) });
  }
  set({ checkedAt: Date.now() });
}

/** Downloads and runs the installer: on Windows the app closes and the installer reopens it. */
export async function installUpdate() {
  if (!pending) return;
  set({ status: 'downloading', done: 0, total: 0, error: null });
  try {
    await pending.downloadAndInstall((e) => {
      if (e.event === 'Started') set({ total: e.data.contentLength || 0 });
      else if (e.event === 'Progress') set({ done: state.done + e.data.chunkLength });
      else if (e.event === 'Finished') set({ status: 'installing' });
    });
    await relaunch();
  } catch (e) {
    set({ status: 'error', error: String(e) });
  }
}
