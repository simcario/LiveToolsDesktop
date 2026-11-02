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
  jump: null,
  next: null, // the next song waiting to take over (transition): { songId, mode, at }
  fade: 1, // Tracks Fade: gain of the tracks now, and where it is going
  fadeTarget: 1,
  rate: 1, // speed of the song loaded (tempo changed): times stay those of the original
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
  return status.position + Math.min(0.1, (performance.now() - receivedAt) / 1000) * (status.rate || 1);
}

const progressListeners = new Set();
listen('stretch-progress', (e) => progressListeners.forEach((f) => f(e.payload)));

// Progress of a change of key or tempo: f({ done, total }).
export function onStretchProgress(f) {
  progressListeners.add(f);
  return () => progressListeners.delete(f);
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
  // At `at` seconds the playhead moves to `to`, without gaps; repeat = loop.
  scheduleJump: (jump) => invoke('engine_schedule_jump', { jump }),
  cancelJump: () => invoke('engine_cancel_jump'),
  setTrack: (id, mix) => invoke('engine_set_track', { id, mix }),
  setClick: (click) => invoke('engine_set_click', { click }),
  previewClick: (kind) => invoke('engine_preview_click', { kind }),
  setMaster: (gainDb) => invoke('engine_set_master', { gainDb }),
  setSync: (sync) => invoke('engine_set_sync', { sync }),
  setSections: (sections) => invoke('engine_set_sections', { sections }),
  setRegions: (regions) => invoke('engine_set_regions', { regions }),
  replaceTrack: (id, newId, path) => invoke('engine_replace_track', { id, newId, path }),
  // Tracks Fade: the tracks out (or back in) in `seconds`; click and pad go on.
  fade: (out, seconds) => invoke('engine_fade', { out: !!out, seconds }),
  setPad: (pad) => invoke('engine_set_pad', { pad }),
  // The next song takes over at transition.at seconds: { mode: 'overlap' | 'crossfade', at, fade }.
  queueNext: (song, transition) => invoke('engine_queue_next', { song, transition }),
  cancelNext: () => invoke('engine_cancel_next'),
  // Stems in another key / tempo, rendered once: [{ path, semitones, rate }] → [{ path, error }].
  stretchTracks: (jobs) => invoke('stretch_tracks', { jobs }),
};

export function formatTime(sec) {
  const neg = sec < 0;
  const s = Math.abs(sec);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  const t = Math.floor((s * 10) % 10);
  return `${neg ? '-' : ''}${m}:${String(r).padStart(2, '0')}.${t}`;
}
