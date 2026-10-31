// Preferences of this computer (audio interface, output matrix, transport),
// kept locally: they describe the hardware on stage, not the user.
import { useCallback, useSyncExternalStore } from 'react';
import { DEFAULT_PEDAL, pedalOf } from '../shared/score.js';

const KEY = 'livetools-desktop:settings';
const MIX_KEY = 'livetools-desktop:mix';

// Output matrix: where each stem role goes. start = first output (0-based).
export const DEFAULT_SETTINGS = {
  audioDevice: null,
  bufferSize: null,
  outputs: {
    main: { start: 0, mode: 'stereo' },
    click: { start: 2, mode: 'mono' },
    guide: { start: 3, mode: 'mono' },
    monitor: { start: 2, mode: 'stereo' },
  },
  // Metronome: synthesised sound and, for each kind of beat, level (dB) and
  // pitch (semitones) on top of the sound's own.
  click: { enabled: true, gainDb: -6, sound: 'beep', kinds: {} },
  masterDb: 0,
  countIn: true,
  defaultCountIn: 1,
  followStage: false,
  driveStage: false,
  autoAdvance: true,
  followPlayhead: true,
  snapGrid: true, // Arrangement: moved clips land on the beats
  arrTool: 'select', // Arrangement tool: select, move, cut, mute, erase
  page: 'live', // bottom page tabs: live (player), setlist (editor) or songs (library)
  view: 'session',
  setlistId: null,
  pxPerSec: 40,
  // Zones around the main view: open or closed and size in px (see components/Zones.jsx).
  zones: {
    left: { open: true, size: 270 },
    lower: { open: true, size: 230 },
    right: { open: true, size: 400 },
  },
  prompterLead: 0,
  prompterNext: true,
  updateCheck: true, // look for a new release at startup (never installs on its own)
  pedal: DEFAULT_PEDAL, // page turner of the PDF score: keys for next / previous page, layout
};

function read(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: keep it for this session
  }
}

function merge(saved) {
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    outputs: { ...DEFAULT_SETTINGS.outputs, ...(saved?.outputs || {}) },
    click: { ...DEFAULT_SETTINGS.click, ...(saved?.click || {}) },
    pedal: pedalOf(saved?.pedal),
    zones: {
      left: { ...DEFAULT_SETTINGS.zones.left, ...(saved?.zones?.left || {}) },
      lower: { ...DEFAULT_SETTINGS.zones.lower, ...(saved?.zones?.lower || {}) },
      right: { ...DEFAULT_SETTINGS.zones.right, ...(saved?.zones?.right || {}) },
    },
  };
}

export const toggleZone = (s, zone) => ({ zones: { ...s.zones, [zone]: { ...s.zones[zone], open: !s.zones[zone].open } } });

let settings = merge(read(KEY, {}));
let mix = read(MIX_KEY, {});
const listeners = new Set();
const notify = () => listeners.forEach((f) => f());
const subscribe = (f) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

export function useSettings() {
  const value = useSyncExternalStore(subscribe, () => settings);
  const update = useCallback((patch) => {
    settings = merge({ ...settings, ...(typeof patch === 'function' ? patch(settings) : patch) });
    write(KEY, settings);
    notify();
  }, []);
  return [value, update];
}

export const getSettings = () => settings;

// Local mix of each stem (by stem id), on top of the defaults saved on the web.
export function useMix() {
  return useSyncExternalStore(subscribe, () => mix);
}

export function getMix(stemId) {
  return mix[stemId] || {};
}

export function setMix(stemId, patch) {
  mix = { ...mix, [stemId]: { ...(mix[stemId] || {}), ...patch } };
  write(MIX_KEY, mix);
  notify();
}

export const CLICK_SOUNDS = [
  ['beep', 'Beep (come l’app web)'],
  ['woodblock', 'Legnetto (woodblock)'],
  ['cowbell', 'Campanaccio (cowbell)'],
  ['stick', 'Bacchetta (rim)'],
  ['hiHat', 'Hi-hat'],
];

// Kinds of beat the engine tells apart (ClickKind in render.rs).
export const CLICK_KINDS = [
  ['accent', 'Primo movimento', 'Il battere di ogni battuta'],
  ['beat', 'Altri movimenti', 'I quarti dopo il primo'],
  ['group', 'Gruppi', 'Inizio di ogni gruppo nei tempi composti (6/8, 12/8)'],
  ['count', 'Count-in', 'I battiti del count-in dopo il primo'],
];

export const DEFAULT_KIND = { db: 0, semitones: 0 };
export const clickKind = (click, kind) => ({ ...DEFAULT_KIND, ...(click.kinds?.[kind] || {}) });

/** Sound and per-beat mix as the engine wants them (linear gain, pitch ratio). */
export function clickVoice(click) {
  const kinds = Object.fromEntries(
    CLICK_KINDS.map(([k]) => {
      const { db, semitones } = clickKind(click, k);
      return [k, { gain: db <= -40 ? 0 : 10 ** (db / 20), pitch: 2 ** (semitones / 12) }];
    }),
  );
  return { sound: click.sound || 'beep', kinds };
}

export const OUTPUT_ROLES = [
  ['main', 'Main (PA)'],
  ['click', 'Click'],
  ['guide', 'Guide / Cue'],
  ['monitor', 'Solo monitor'],
];

// Select options for an interface with `channels` outputs.
export function outputOptions(channels) {
  const n = Math.max(2, channels || 2);
  const opts = [];
  for (let i = 0; i + 1 < n; i += 2) opts.push({ value: `stereo:${i}`, label: `Out ${i + 1}-${i + 2}` });
  for (let i = 0; i < n; i += 1) opts.push({ value: `mono:${i}`, label: `Out ${i + 1} (mono)` });
  opts.push({ value: 'off', label: 'Nessuna' });
  return opts;
}

export const routeValue = (r) => (r?.mode === 'off' ? 'off' : `${r?.mode || 'stereo'}:${r?.start || 0}`);

export function parseRoute(value) {
  if (value === 'off') return { mode: 'off', start: 0 };
  const [mode, start] = value.split(':');
  return { mode, start: Number(start) || 0 };
}
