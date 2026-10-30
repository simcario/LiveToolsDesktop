// Spoken cues ("Chorus", "Bridge", "One, two, three, four"…) placed on the
// beats of a song (cue sheet: shared/media.js cueTrackOf) and rendered into a
// "Cues" stem with the guide role, so the band hears them in the in-ears on
// every desktop. The clips are bundled with the app (public/cues).
import { invoke } from '@tauri-apps/api/core';
import { gridBeats } from './grid';
import { cueTrackOf, deleteMediaFile, mediaTarget, saveStems, stemsOf, uploadMedia } from '../shared/media.js';
import { db, storage } from './firebase';
import { storeLocal } from './mediaCache';

const LABELS = [
  'One!', 'Two!', 'Three!', 'Four!', 'Five!', 'Six!', 'Seven!', 'Eight!', 'Intro', 'Verse one', 'Verse two', 'Verse three',
  'Pre-chorus', 'Chorus', 'Post-chorus', 'Bridge', 'Instrumental', 'Interlude', 'Solo', 'Guitar solo', 'Piano solo', 'Drum solo',
  'Breakdown', 'Build up', 'Drop', 'Vamp', 'Tag', 'Refrain', 'Turnaround', 'Transition', 'Pickup', 'Fill', 'Break', 'Stop time',
  'A cappella', 'Unison', 'Harmony', 'Call and response', 'Ad libs', 'Spontaneous worship', 'Free worship', 'Prayer', 'Repeat',
  'Repeat twice', 'One more time', 'Last time', 'Final chorus', 'Double chorus', 'Half time', 'Double time', 'Modulate',
  'Key change', 'Softly', 'Build slowly', 'Get louder', 'Bring it down', 'Strip it back', 'Full band', 'Band in', 'Drums in',
  'Bass in', 'Keys in', 'Guitars in', 'Vocals in', 'Lead vocal in', 'Choir in', 'All in', 'Hold', 'Sustain', 'Cut', 'Mute',
  'Ritardando', 'Accelerando', 'Watch the director', 'Big ending', 'Final hit', 'End on cue', 'Fade out', 'Outro', 'Ending',
  'Coda', 'Silence', 'Count in', 'One, two, three, four', 'Ready', 'Get ready', 'Stand by', 'Go', 'Stop',
];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// label → clip file, in the order of the recording (01-one.wav …).
export const CUE_CLIPS = LABELS.map((label, i) => ({ label, file: `cues/${String(i + 1).padStart(2, '0')}-${slug(label)}.wav` }));
const FILE_OF = Object.fromEntries(CUE_CLIPS.map((c) => [c.label, c.file]));

const pick = (...n) => n.map((i) => LABELS[i - 1]);
export const CUE_GROUPS = [
  ['Conteggio', pick(1, 2, 3, 4, 5, 6, 7, 8, 83, 84)],
  ['Sezioni', pick(9, 10, 11, 12, 13, 14, 15, 16, 47, 48, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 79, 80, 81)],
  ['Ripetizioni', pick(43, 44, 45, 46)],
  ['Arrangiamento', pick(31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 49, 50, 51, 52)],
  ['Dinamica', pick(53, 54, 55, 56, 57, 68, 69, 70, 71, 72, 73, 78, 82)],
  ['Strumenti', pick(58, 59, 60, 61, 62, 63, 64, 65, 66, 67)],
  ['Comandi', pick(74, 75, 76, 77, 85, 86, 87, 88, 89)],
];

export const COUNT_LABELS = LABELS.slice(0, 8);

/**
 * Bars of the song with their cells (one per beat, two with eighths):
 * [{ bar, label, cells: [{ g, t }] }]. g is the beat from bar 1 (cue sheet
 * unit); the count-in has no cells (it comes before the stems).
 */
export function cueBars(tempo, duration, resolution) {
  const beats = gridBeats(tempo, 0, duration).filter((b) => b.g != null);
  const bars = [];
  beats.forEach((b, i) => {
    let row = bars.at(-1);
    if (!row || row.bar !== b.bar) {
      row = { bar: b.bar, label: b.inBar === 0 && b.seg.start >= b.t - 1e-6 ? b.seg.label || '' : '', cells: [] };
      bars.push(row);
    }
    row.cells.push({ g: b.g, t: b.t, beat: b.inBar });
    if (resolution === 8) {
      const next = beats[i + 1]?.t ?? b.t + b.seg.beat;
      row.cells.push({ g: b.g + 0.5, t: (b.t + next) / 2, beat: b.inBar, half: true });
    }
  });
  return bars;
}

/** Seconds of cue position g in the bars (null when outside the song). */
export function cueTime(bars, g) {
  for (const row of bars) {
    const c = row.cells.find((x) => Math.abs(x.g - g) < 1e-6);
    if (c) return c.t;
  }
  return null;
}

let preview = null;
const clipCache = new Map(); // file → ArrayBuffer

async function clipBytes(file) {
  if (!clipCache.has(file)) {
    const res = await fetch(`/${file}`);
    if (!res.ok) throw new Error(`Clip mancante: ${file}`);
    clipCache.set(file, await res.arrayBuffer());
  }
  return clipCache.get(file).slice(0);
}

/** Plays a clip on the computer's default output (to choose the cue). */
export async function previewCue(label) {
  const file = FILE_OF[label];
  if (!file) return;
  preview = preview || new AudioContext();
  const buf = await preview.decodeAudioData(await clipBytes(file));
  const src = preview.createBufferSource();
  src.buffer = buf;
  src.connect(preview.destination);
  src.start();
}

function wav(samples, rate) {
  const data = samples.length * 2;
  const v = new DataView(new ArrayBuffer(44 + data));
  const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, data, true);
  for (let i = 0; i < samples.length; i += 1) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Blob([v], { type: 'audio/wav' });
}

const RATE = 48000;

/** Renders the cue sheet into a mono WAV as long as the song (plus `tail` seconds). */
export async function renderCueTrack(cues, bars, duration, tail = 3) {
  const ctx = new OfflineAudioContext(1, Math.ceil((duration + tail) * RATE), RATE);
  const decoded = new Map();
  for (const c of cues) {
    const t = cueTime(bars, c.g);
    const file = FILE_OF[c.label];
    if (t == null || t < 0 || !file) continue;
    if (!decoded.has(file)) decoded.set(file, await ctx.decodeAudioData(await clipBytes(file)));
    const src = ctx.createBufferSource();
    src.buffer = decoded.get(file);
    src.connect(ctx.destination);
    src.start(t);
  }
  const out = await ctx.startRendering();
  return wav(out.getChannelData(0), RATE);
}

/**
 * Uploads the rendered cues as the song's "Cues" stem (guide role), in place
 * of the previous one, and keeps a local copy ready to play.
 */
export async function publishCueTrack(setlistId, item, blob, onProgress) {
  const target = mediaTarget(setlistId, item);
  const file = new File([blob], 'Cues.wav', { type: 'audio/wav' });
  const media = await uploadMedia(storage, target, file, onProgress).promise;
  storeLocal(media.path, file);
  const stems = stemsOf(item);
  const old = stems.filter((s) => s.generated === 'cues');
  const stem = { ...media, name: 'Cues', role: 'guide', instrument: 'other', gain: 0, pan: 0, muted: false, generated: 'cues' };
  await saveStems(db, target, [...stems.filter((s) => s.generated !== 'cues'), stem]);
  await Promise.all(old.map((s) => deleteMediaFile(storage, s.path, target).catch(() => {})));
}

/** Signature of a cue sheet (the rendered stem records the one it was made from). */
export const sheetKey = (cues) => JSON.stringify([...cues].sort((a, b) => a.g - b.g).map((c) => [c.g, c.label]));

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// ---------- Live cue track (desktop only) ----------
// Without the audio file (or when the cues changed after rendering it), the
// player makes the "Cues" track itself from the cue sheet when it loads the
// song: rendered once on this computer, kept in the local media cache and
// never uploaded. The web app only hears the rendered file.

/**
 * What the player does with the cues of a song: null when there are none or
 * the "Cues" stem is up to date; otherwise the local track to play and the
 * out-of-date stem to leave out.
 */
export function liveCuePlan(item) {
  const sheet = cueTrackOf(item);
  if (!sheet.cues.length) return null;
  const rendered = stemsOf(item).find((s) => s.generated === 'cues');
  const key = sheetKey(sheet.cues);
  if (rendered && sheet.renderedKey === key) return null;
  // Everything the grid depends on: a change makes a new local file.
  const sig = hash(
    JSON.stringify([key, item.bpm, item.timeSig, item.sections, item.grid, item.countInBars, stemsOf(item).map((s) => s.id).sort(), item.regions || null]),
  );
  return {
    skip: rendered?.id ?? null,
    stem: { id: 'cues-live', name: 'Cues (live)', role: 'guide', instrument: 'other', gain: 0, pan: 0, muted: false, live: true, path: `local/cues/${item.id}-${sig}.wav` },
    resolution: sheet.resolution,
    cues: sheet.cues,
  };
}

/** Local path of the live track if this computer already made it. */
export async function liveCueLocal(plan) {
  const [r] = await invoke('cache_status', { entries: [{ path: plan.stem.path }] });
  return r?.ready ? r.local : null;
}

/** Renders the live track with the song's tempo map and stores it locally. */
export async function makeLiveCues(plan, tempo, duration) {
  // No tail: the song's length includes this track, and remaking it after an
  // edit must not make the song longer each time.
  const blob = await renderCueTrack(plan.cues, cueBars(tempo, duration, plan.resolution), duration, 0);
  return storeLocal(plan.stem.path, new File([blob], 'Cues.wav', { type: 'audio/wav' }));
}

/** Back to the live track: the rendered "Cues" stem leaves the song and Storage. */
export async function removeRenderedCues(setlistId, item) {
  const target = mediaTarget(setlistId, item);
  const old = stemsOf(item).filter((s) => s.generated === 'cues');
  await saveStems(db, target, stemsOf(item).filter((s) => s.generated !== 'cues'));
  await Promise.all(old.map((s) => deleteMediaFile(storage, s.path, target).catch(() => {})));
}
