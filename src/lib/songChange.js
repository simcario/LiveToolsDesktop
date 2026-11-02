// What Playback sets per song of a setlist, on the setlist item (shared by the band):
// key and tempo changed offline (item.transpose in semitones, item.tempoBpm) and
// the transition to the next song (item.transition).
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { transposeKey } from '../shared/music.js';
import { db } from './firebase';

const PITCH = { C: 0, 'B#': 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, F: 5, 'E#': 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11 };
export const PAD_KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// Pitch class of a key ("F#m" → 6), null when there is none.
export function keyPitch(key) {
  const m = /^([A-G][#b]?)/.exec((key || '').trim());
  return m && PITCH[m[1]] !== undefined ? PITCH[m[1]] : null;
}

export const MAX_TRANSPOSE = 6;
export const MAX_TEMPO_DELTA = 20; // BPM, as Playback

const num = (v) => (Number(v) > 0 ? Number(v) : null);
export const baseBpm = (item) => num(item?.grid?.bpm) || num(item?.bpm);

// The change of a song: semitones, speed (1 = its tempo) and the tempo it plays at.
export function songChange(item) {
  const semitones = Math.max(-MAX_TRANSPOSE, Math.min(MAX_TRANSPOSE, Math.round(Number(item?.transpose) || 0)));
  const base = baseBpm(item);
  const want = num(item?.tempoBpm);
  const rate = base && want ? Math.max(0.5, Math.min(2, want / base)) : 1;
  return { semitones, rate, bpm: base ? Math.round(base * rate * 10) / 10 : null, changed: semitones !== 0 || Math.abs(rate - 1) > 1e-4 };
}

// The key the song is heard in.
export const playedKey = (item) => transposeKey(item?.key || '', songChange(item).semitones);

// Click, guides and cues change tempo but keep their pitch.
export const keepsPitch = (stem) => ['click', 'guide'].includes(stem.role) || stem.generated === 'cues' || !!stem.live;

// Transitions of Playback, from a song to the next.
export const TRANSITIONS = [
  ['cue', 'Prepara il prossimo', 'A fine brano carica il successivo, senza farlo partire'],
  ['stay', 'Resta nel brano', 'A fine brano resta selezionato questo'],
  ['autolink', 'AutoLink', 'A fine brano parte subito il successivo'],
  ['overlap', 'Sovrapponi', 'Il successivo parte a pieno volume sull’ultima parte di questo (al massimo 5 s)'],
  ['crossfade', 'Dissolvenza', 'Gli ultimi 5 s di questo sfumano mentre entra il successivo'],
];
export const transitionLabel = (mode) => TRANSITIONS.find((t) => t[0] === mode)?.[1] || mode;

// Without a transition of its own a song follows the auto-advance of this computer.
export const transitionOf = (item, settings) => (TRANSITIONS.some((t) => t[0] === item?.transition) ? item.transition : settings.autoAdvance ? 'cue' : 'stay');
export const isLinked = (mode) => mode === 'autolink' || mode === 'overlap' || mode === 'crossfade';

const XFADE = 5;

// Length of the first section of a song from its data (null when unknown).
function firstSectionSeconds(item) {
  const s = item?.sections?.[0];
  const bpm = num(s?.bpm) || baseBpm(item);
  const beats = Number(/^(\d+)/.exec(s?.timeSig || item?.timeSig || '4/4')?.[1]) || 4;
  return s && num(s.bars) && bpm ? (num(s.bars) * beats * 60) / bpm / songChange(item).rate : null;
}

// Start of the last section of the song playing, from its tempo map.
function lastSectionStart(tempo) {
  const segs = (tempo?.segments || []).filter((s) => !s.countIn);
  for (let i = segs.length - 1; i > 0; i -= 1) if (segs[i].label !== segs[i - 1].label) return segs[i].start;
  return null;
}

// When and how the engine changes song: { mode, at, fade } in seconds of the song playing.
export function transitionPlan(mode, duration, tempo, next) {
  if (mode === 'autolink') return { mode: 'overlap', at: duration, fade: 0 };
  if (mode === 'crossfade') return { mode: 'crossfade', at: Math.max(0, duration - XFADE), fade: Math.min(XFADE, duration) };
  const last = lastSectionStart(tempo);
  const lengths = [XFADE, last != null ? duration - last : null, firstSectionSeconds(next)].filter((x) => x > 0);
  return { mode: 'overlap', at: Math.max(0, duration - Math.min(...lengths)), fade: 0 };
}

// Fields of a setlist item written at once for the whole band (null removes the change).
export function setItemFields(setlistId, itemId, patch) {
  return updateDoc(doc(db, 'setlists', setlistId, 'items', itemId), { ...patch, updatedAt: serverTimestamp() });
}
