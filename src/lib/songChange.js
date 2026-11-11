// What Playback sets per song of a setlist, on the setlist item (shared by the band):
// key and tempo changed offline (item.transpose in semitones, item.tempoBpm) and
// the transition to the next song (item.transition).
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { transposeKey } from '../shared/music.js';
import { db } from './firebase';
import { isVideoItem } from '../shared/media.js';

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

// Without a transition of its own a song follows the auto-advance of this computer;
// a video item goes straight on into the next song (AutoLink).
export const defaultTransition = (item, settings) => (isVideoItem(item) ? 'autolink' : settings.autoAdvance ? 'cue' : 'stay');
export const transitionOf = (item, settings) => (TRANSITIONS.some((t) => t[0] === item?.transition) ? item.transition : defaultTransition(item, settings));
export const isLinked = (mode) => mode === 'autolink' || mode === 'overlap' || mode === 'crossfade';

const XFADE = 5;
// Limits of the fine tuning of a linked transition (Transizioni page), in seconds.
export const LINK_PAUSE_MAX = 30;
export const LINK_FADE_MAX = 30;

// Length of the first section of a song from its data (null when unknown).
function firstSectionSeconds(item) {
  const s = item?.sections?.[0];
  const bpm = num(s?.bpm) || baseBpm(item);
  const beats = Number(/^(\d+)/.exec(s?.timeSig || item?.timeSig || '4/4')?.[1]) || 4;
  return s && num(s.bars) && bpm ? (num(s.bars) * beats * 60) / bpm / songChange(item).rate : null;
}

// Start of the last section of the song playing, from its tempo map.
export function lastSectionStart(tempo) {
  const segs = (tempo?.segments || []).filter((s) => !s.countIn);
  for (let i = segs.length - 1; i > 0; i -= 1) if (segs[i].label !== segs[i - 1].label) return segs[i].start;
  return null;
}

const given = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * How a linked transition goes, in the seconds heard (the speed of the songs applied):
 * { offset, fadeOut, fadeIn, start, own } or null for Prepara / Resta.
 *  offset: from the end of this song to the start of the next one (< 0 over it, > 0 a pause);
 *  fadeOut: this song fades out from there (0 = it goes on to its end); fadeIn: the next one comes in;
 *  start: second of the next song it starts from (original seconds, as its sections).
 * Without the fields of the item (linkOffset, linkFadeOut, linkFadeIn, linkStart) it is the type's own.
 * song: { duration (original seconds), rate, lastStart (original seconds of its last section) }.
 */
export function linkTiming(item, mode, song, next) {
  if (!isLinked(mode)) return null;
  const rate = song.rate || 1;
  const length = Math.max(0, (song.duration || 0) / rate);
  const offset = given(item?.linkOffset);
  const fadeOut = given(item?.linkFadeOut);
  const fadeIn = given(item?.linkFadeIn);
  const start = Math.max(0, given(item?.linkStart) ?? 0);
  const own = [offset, fadeOut, fadeIn].some((v) => v != null) || start > 0;
  if (mode === 'autolink') {
    return { offset: clamp(offset ?? 0, 0, LINK_PAUSE_MAX), fadeOut: 0, fadeIn: clamp(fadeIn ?? 0, 0, LINK_FADE_MAX), start, own };
  }
  if (mode === 'crossfade') {
    const off = -clamp(-(offset ?? -XFADE), 0, length);
    return { offset: off, fadeOut: clamp(fadeOut ?? -off, 0, LINK_FADE_MAX), fadeIn: clamp(fadeIn ?? -off, 0, LINK_FADE_MAX), start, own };
  }
  // Overlap: by default the last section of this one, the first of the next or 5 s, the shortest.
  const last = song.lastStart != null ? (song.duration - song.lastStart) / rate : null;
  const auto = Math.min(...[XFADE, last, firstSectionSeconds(next)].filter((x) => x > 0));
  return { offset: -clamp(-(offset ?? -auto), 0, length), fadeOut: clamp(fadeOut ?? 0, 0, LINK_FADE_MAX), fadeIn: clamp(fadeIn ?? 0, 0, LINK_FADE_MAX), start, own };
}

// The fields of the fine tuning, removed (a new type starts from its own values).
export const LINK_RESET = { linkOffset: null, linkFadeOut: null, linkFadeIn: null };

// When and how the engine changes song: { mode, at, fade, fadeIn, start } in seconds of the
// song playing (fade too: the engine divides it by the speed), fadeIn in seconds heard.
export function transitionPlan(item, mode, duration, tempo, next, rate = 1) {
  const t = linkTiming(item, mode, { duration, rate, lastStart: lastSectionStart(tempo) }, next);
  if (!t) return null;
  return { mode, at: Math.max(0, duration + t.offset * rate), fade: t.fadeOut * rate, fadeIn: t.fadeIn, start: t.start };
}

// Fields of a setlist item written at once for the whole band (null removes the change).
export function setItemFields(setlistId, itemId, patch) {
  return updateDoc(doc(db, 'setlists', setlistId, 'items', itemId), { ...patch, updatedAt: serverTimestamp() });
}
