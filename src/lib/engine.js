// Bridge to the Rust audio engine: commands, and the status it emits ~30
// times per second (shared by every window, also the video output).
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
  pad: [0, 0], // [left, right] peak of the pad
  click: 0, // peak of the system click (metronome)
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

// Runs frame() at display rate while the song plays, otherwise once for each status that
// arrives (a locate, a stop) and for each kick(): a requestAnimationFrame loop always on keeps
// the browser making frames at rest, a tenth of a core on a tablet for nothing.
export function animateWhilePlaying(frame) {
  let raf = 0;
  let alive = true;
  const run = () => {
    raf = 0;
    if (!alive) return;
    frame();
    if (status.playing || status.waiting) raf = requestAnimationFrame(run);
  };
  const kick = () => {
    if (!raf && alive) raf = requestAnimationFrame(run);
  };
  listeners.add(kick);
  kick();
  return {
    kick,
    stop: () => {
      alive = false;
      listeners.delete(kick);
      cancelAnimationFrame(raf);
    },
  };
}

export function onSongEnded(f) {
  endedListeners.add(f);
  return () => endedListeners.delete(f);
}

export const engineStatus = () => status;

// Playhead heard, at display rate (for requestAnimationFrame). The engine sends the position
// coming out of the speakers ~30 times per second; each status reaches the page a little late,
// by a different amount each time (the main thread is busy, above all on a tablet). Starting
// again from each status made the playhead and the leds shake around the click: here a clock
// runs at the speed of the song, kept on the status that arrive the soonest (a status late can
// only be behind), and it slowly follows the clock of the interface.
let clock = null; // { off: position - now × rate, rate, songId }
let shownAt = -Infinity;

const tick = () => {
  const s = status;
  if (!s.playing || s.waiting) {
    clock = null;
    return;
  }
  const rate = s.rate || 1;
  const off = s.position - (receivedAt / 1000) * rate;
  if (!clock || clock.rate !== rate || clock.songId !== s.songId || Math.abs(off - clock.off) > 0.08) {
    clock = { off, rate, songId: s.songId };
    shownAt = -Infinity;
  } else if (off > clock.off) clock.off += (off - clock.off) * 0.5;
  else clock.off += (off - clock.off) * 0.03;
};
listeners.add(tick);

// Development only: what the engine sends and the playhead drawn, read over the devtools.
if (import.meta.env.DEV) window.__engine = { status: () => status, receivedAt: () => receivedAt, live: () => livePosition(), beat: () => liveBeat() };

export function livePosition() {
  if (!status.playing || status.waiting || !clock) return status.position;
  // Never backwards while it plays (a correction of the clock is spread over the frames).
  const t = Math.max(shownAt, (performance.now() / 1000) * clock.rate + clock.off);
  shownAt = t;
  return t;
}

// Bar, beat and beats per bar heard now (leds of the metronome), at display rate: the beat
// after the one in the status comes with it (nextBeat), without waiting for the next status.
// aheadMs: looks that much ahead (the frame being drawn shows a little later).
export function liveBeat(aheadMs = 0) {
  const s = status;
  const n = s.nextBeat;
  if (s.playing && !s.waiting && n && livePosition() + (aheadMs / 1000) * (s.rate || 1) >= n[0]) return { bar: n[1], beat: n[2], beats: n[3] };
  return { bar: s.bar, beat: s.beat, beats: s.beats };
}

// The leds of the metronome and bar.beat, written straight into the DOM in the frame where the
// beat falls: through a React render they lit a frame later (~28 ms behind the click on a tablet).
// Returns refs for the box of the leds (its <i>, one per beat) and for the text bar.beat; React
// only renders when the beats per bar change. The text gets is-count during the count-in.
export function useBeatDisplay() {
  const leds = useRef(null);
  const text = useRef(null);
  const [beats, setBeats] = useState(() => liveBeat().beats);
  useEffect(() => {
    let key = '';
    const anim = animateWhilePlaying(() => {
      // Half a frame ahead: the frame being drawn reaches the screen about then.
      const v = liveBeat(8);
      const on = status.playing ? v.beat : 0;
      const k = `${v.bar}.${v.beat}/${v.beats}/${on}`;
      if (k === key) return;
      key = k;
      if (v.beats !== beats) setBeats(v.beats);
      if (text.current) {
        text.current.textContent = `${v.bar}.${v.beat}`;
        text.current.classList.toggle('is-count', v.bar < 0);
      }
      const items = leds.current?.children || [];
      for (let i = 0; i < items.length; i += 1) items[i].classList.toggle('on', i + 1 === on);
    });
    return anim.stop;
  }, [beats]);
  return { beats, leds, text };
}

// The leds of the metronome and bar.beat: a render only when the beat changes.
export function useLiveBeat() {
  const [b, setB] = useState(() => liveBeat());
  useEffect(() => {
    let key = '';
    const anim = animateWhilePlaying(() => {
      const v = liveBeat();
      const k = `${v.bar}.${v.beat}/${v.beats}`;
      if (k !== key) {
        key = k;
        setB(v);
      }
    });
    return anim.stop;
  }, []);
  return b;
}

const progressListeners = new Set();
listen('stretch-progress', (e) => progressListeners.forEach((f) => f(e.payload)));

// Progress of a change of key or tempo: f({ done, total }).
export function onStretchProgress(f) {
  progressListeners.add(f);
  return () => progressListeners.delete(f);
}

const deviceListeners = new Set();
listen('audio-devices', (e) => deviceListeners.forEach((f) => f(e.payload)));

// Interfaces plugged in or out (src-tauri audio/watch.rs):
// f({ added: [names], removed: [names], lost: name|null, device: info|null, error: string|null }).
// `lost`: the interface in use is gone and the default output took its place (song stopped).
/** Automatic detection of the interfaces plugged in and out, on or off (Impostazioni audio). */
export const setAudioWatch = (enabled) => invoke('audio_watch', { enabled }).catch(() => {});

export function onDeviceChange(f) {
  deviceListeners.add(f);
  return () => deviceListeners.delete(f);
}

export const dbToGain =(db) => (db <= -60 ? 0 : 10 ** (db / 20));

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
  // Spectrum (dBFS, log spaced 20 Hz–20 kHz) of loaded track `track` after its EQ; null stops it.
  spectrum: (track, bins = 160) => invoke('engine_spectrum', { track, bins }),
  setClick: (click) => invoke('engine_set_click', { click }),
  previewClick: (kind) => invoke('engine_preview_click', { kind }),
  setMaster: (gainDb) => invoke('engine_set_master', { gainDb }),
  setSync: (sync) => invoke('engine_set_sync', { sync }),
  setSections: (sections) => invoke('engine_set_sections', { sections }),
  // Spans [from, to] (seconds of the song) where the click is silent (its mute automation).
  setClickMute: (spans, auto) => invoke('engine_set_click_mute', { spans, auto }),
  setRegions: (regions) => invoke('engine_set_regions', { regions }),
  replaceTrack: (id, newId, path) => invoke('engine_replace_track', { id, newId, path }),
  // Tracks Fade: the tracks out (or back in) in `seconds`; click and pad go on.
  fade: (out, seconds) => invoke('engine_fade', { out: !!out, seconds }),
  setPad: (pad) => invoke('engine_set_pad', { pad }),
  // The next song takes over at transition.at seconds (after the end: a pause): { mode, at, fade (out), fadeIn, start }.
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
