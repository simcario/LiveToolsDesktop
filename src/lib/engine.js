// Bridge to the Rust audio engine: commands, and the status it emits ~30
// times per second (shared by every window, also the video output).
import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const EMPTY = {
  playing: false,
  waiting: false,
  position: 0,
  duration: 0,
  songId: null,
  bar: 1,
  beat: 1,
  beats: 4,
  ended: false,
  underruns: 0,
  meters: [],
  outputs: [],
  device: null,
  deviceError: null,
};

let status = EMPTY;
let receivedAt = 0;
const listeners = new Set();
const endedListeners = new Set();

listen('engine-status', (e) => {
  status = e.payload;
  receivedAt = performance.now();
  if (status.ended) endedListeners.forEach((f) => f());
  listeners.forEach((f) => f());
});

const subscribe = (f) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

export function useEngineStatus(select = (s) => s) {
  return useSyncExternalStore(subscribe, () => select(status));
}

// Raw subscription for components that update the DOM directly (meters).
export function subscribeStatus(f) {
  const run = () => f(status);
  listeners.add(run);
  return () => listeners.delete(run);
}

export function onSongEnded(f) {
  endedListeners.add(f);
  return () => endedListeners.delete(f);
}

export const engineStatus = () => status;

// Smooth playhead between two status updates (for requestAnimationFrame).
export function livePosition() {
  if (!status.playing || status.waiting) return status.position;
  return status.position + Math.min(0.1, (performance.now() - receivedAt) / 1000);
}

export const dbToGain = (db) => (db <= -60 ? 0 : 10 ** (db / 20));

export const engine = {
  devices: () => invoke('audio_devices'),
  openDevice: (name, buffer) => invoke('open_audio_device', { name: name || null, buffer: buffer || null }),
  load: (song) => invoke('engine_load', { song }),
  unload: () => invoke('engine_unload'),
  play: (countIn) => invoke('engine_play', { countIn: !!countIn }),
  stop: () => invoke('engine_stop'),
  locate: (seconds) => invoke('engine_locate', { seconds }),
  setTrack: (id, mix) => invoke('engine_set_track', { id, mix }),
  setClick: (click) => invoke('engine_set_click', { click }),
  previewClick: (kind) => invoke('engine_preview_click', { kind }),
  setMaster: (gainDb) => invoke('engine_set_master', { gainDb }),
  setSync: (sync) => invoke('engine_set_sync', { sync }),
  setRegions: (regions) => invoke('engine_set_regions', { regions }),
  replaceTrack: (id, newId, path) => invoke('engine_replace_track', { id, newId, path }),
};

export function formatTime(sec) {
  const neg = sec < 0;
  const s = Math.abs(sec);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  const t = Math.floor((s * 10) % 10);
  return `${neg ? '-' : ''}${m}:${String(r).padStart(2, '0')}.${t}`;
}
