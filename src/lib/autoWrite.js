// R and W of a channel, as in Cubase (Arrangement header and Mixer strip).
// R (read, saved with the song: stems[].autoRead) = its automations of volume and
// mute are played; off = they stay in the song but the track plays at its fader.
// W (write, only on this computer and until the app closes: never armed for the
// whole band) = while the song plays, moving its fader in the Mixer writes the
// volume automation (Touch: from where it is grabbed to where it is let go,
// then back to the curve that was there) and its M writes a change of the mute
// at that second. Everything goes into the song's draft ("Salva"), one undo step per gesture.
import { useSyncExternalStore } from 'react';
import { AUTO_MAX_DB, AUTO_MIN_DB, automationDb, automationMutedAt, automationOf, automationRead, clickAutoOf, muteAutomationOf, stemsOf } from '../shared/media.js';
import { engineStatus, livePosition } from './engine';
import { endMix, writeItem, writeMix } from './songMix';

let writing = {}; // stem id → true
const listeners = new Set();
const subscribe = (f) => {
  listeners.add(f);
  return () => listeners.delete(f);
};
export const useAutoWrite = () => useSyncExternalStore(subscribe, () => writing);
export const isWriting = (id) => !!writing[id];

function setWriting(id, on) {
  writing = { ...writing };
  if (on) writing[id] = true;
  else delete writing[id];
  listeners.forEach((f) => f());
}

const songStem = (song, id) => stemsOf(song).find((s) => s.id === id);
const writeStem = (song, id, patch, label, live) => writeMix(song, { stems: stemsOf(song).map((s) => (s.id === id ? withPatch(s, patch) : s)) }, label, live);
// undefined in a patch = the field goes away (Firestore takes no undefined).
function withPatch(stem, patch) {
  const next = { ...stem, ...patch };
  Object.keys(patch).forEach((k) => patch[k] === undefined && delete next[k]);
  return next;
}

// The system click (lane Click · Tempo): mute and volume, as item.clickAuto; its W is under CLICK_ID.
export const CLICK_ID = 'click';
const writeClick = (song, patch, label) => {
  const next = { ...clickAutoOf(song), ...patch };
  Object.keys(patch).forEach((k) => patch[k] === undefined && delete next[k]);
  const mute = muteAutomationOf(next);
  const auto = automationOf(next);
  const empty = !mute.length && !auto.length && next.autoRead !== false;
  const clean = { ...next, muteAuto: mute, auto };
  if (!auto.length) delete clean.auto;
  writeItem(song, { clickAuto: empty ? null : clean }, label);
};

/** Mute points of the click into the song (Ctrl+click with the Automazione tool, Canc). */
export const setClickMute = (song, points, label) => writeClick(song, { muteAuto: points }, label);

/** Volume points of the click into the song (Automazione tool). */
export const setClickVolume = (song, points, label) => writeClick(song, { auto: points }, label);

/** Mute and volume of the click together (a whole edit, Canc). */
export const setClickAutomation = (song, { muteAuto, auto }, label) => writeClick(song, { muteAuto, auto }, label);

/** The click has volume or mute automation. */
export const clickHasAutomation = (song) => hasAutomation(clickAutoOf(song));

/** R of the click. */
export function toggleClickRead(song) {
  const on = !automationRead(clickAutoOf(song));
  writeClick(song, { autoRead: on ? undefined : false }, `Lettura automazione del click ${on ? 'attiva' : 'spenta'}`);
}

/** W of the click (here only); arming it turns on R too. */
export function toggleClickWrite(song) {
  const on = !writing[CLICK_ID];
  setWriting(CLICK_ID, on);
  if (on && !automationRead(clickAutoOf(song))) writeClick(song, { autoRead: undefined }, 'Lettura automazione del click attiva');
}

/** "On" of the click with W armed while the song plays: a change of its mute here. false = not handled. */
export function writeClickMute(song) {
  const t = writeTime();
  if (!song || t == null || !writing[CLICK_ID]) return false;
  const pts = muteAutomationOf(clickAutoOf(song));
  const on = !automationMutedAt(pts, t);
  writeClick(song, { muteAuto: [...pts.filter((p) => Math.abs(p.t - t) > 0.02), { t: Math.round(t * 1e4) / 1e4, on }], autoRead: undefined }, `${on ? 'Click fermato' : 'Click ripartito'} a ${t.toFixed(1)} s`);
  return true;
}

/** Has volume or mute automation. */
export const hasAutomation = (stem) => automationOf(stem).length > 0 || muteAutomationOf(stem).length > 0;

/** R of the channel: on or off (saved with the song). */
export function toggleRead(song, stem) {
  const s = songStem(song, stem.id);
  if (!s) return;
  const on = !automationRead(s);
  writeStem(song, s.id, { autoRead: on ? undefined : false }, `Lettura automazione di “${s.name}” ${on ? 'attiva' : 'spenta'}`);
}

/** W of the channel: armed here; arming it turns on R too (as Cubase). */
export function toggleWrite(song, stem) {
  const s = songStem(song, stem.id);
  if (!s) return;
  const on = !writing[s.id];
  if (!on) releaseTouch();
  setWriting(s.id, on);
  if (on && !automationRead(s)) writeStem(song, s.id, { autoRead: undefined }, `Lettura automazione di “${s.name}” attiva`);
}

/** W off for every track (another song loaded). */
export function disarmAll() {
  releaseTouch();
  if (Object.keys(writing).length) {
    writing = {};
    listeners.forEach((f) => f());
  }
}

/** Second of the song where the playhead is while it plays (count-in excluded), else null. */
export function writeTime() {
  const s = engineStatus();
  if (!s.playing || s.waiting) return null;
  const t = livePosition();
  return t >= 0 ? t : null;
}

/** The track writes now: W armed and the song playing. */
export const writesNow = (stem) => !!stem && !stem.live && isWriting(stem.id) && writeTime() != null;

/**
 * M of a track with W armed while the song plays: a change of the mute at this
 * second (the automation from here flips). false = not handled (an ordinary M).
 */
export function writeMute(song, stem) {
  const t = writeTime();
  const s = songStem(song, stem?.id);
  if (!s || t == null || !isWriting(s.id)) return false;
  const pts = muteAutomationOf(s);
  const on = !automationMutedAt(pts, t);
  const next = [...pts.filter((p) => Math.abs(p.t - t) > 0.02), { t: Math.round(t * 1e4) / 1e4, on }].sort((a, b) => a.t - b.t);
  writeStem(song, s.id, { muteAuto: next, autoRead: undefined }, `${on ? 'Mute' : 'Fine del mute'} scritto in “${s.name}” a ${t.toFixed(1)} s`);
  return true;
}

// Touch writing of the volume: { songId, stemId, t0, base, written, label }.
let touch = null;
let touchSong = null;
const MIN_GAP = 0.04; // s between two written points
const RETURN = 0.15; // s to go back to the curve after letting the fader go

const clampDb = (db) => Math.max(AUTO_MIN_DB, Math.min(AUTO_MAX_DB, Math.round(db * 10) / 10));

function curve(t) {
  const { base, written, t0 } = touch;
  return [...base.filter((p) => p.t < t0 - 1e-3 || p.t > t + 1e-3), ...written].sort((a, b) => a.t - b.t);
}

/**
 * Fader of a track moved with W armed while the song plays: the level is written
 * at this second (dB on top of the fader saved with the song). false = not handled.
 */
export function writeVolume(song, stem, faderDb) {
  const t = writeTime();
  const s = songStem(song, stem?.id);
  if (!s || t == null || !isWriting(s.id)) return false;
  const db = clampDb(faderDb - (Number(s.gain) || 0));
  // Another track, or the playhead went back (loop, jump): a new pass from here.
  if (touch && (touch.songId !== song.id || touch.stemId !== s.id || t < touch.last - 0.05)) releaseTouch();
  if (!touch) touch = { songId: song.id, stemId: s.id, t0: t, last: t, base: automationOf(s), written: [], label: `Automazione del volume scritta in “${s.name}”` };
  touchSong = song;
  const w = touch.written;
  const prev = w[w.length - 1];
  if (prev && t - prev.t < MIN_GAP) prev.db = db;
  else w.push({ t: Math.round(t * 1e4) / 1e4, db });
  touch.last = t;
  writeStem(song, s.id, { auto: curve(t), autoRead: undefined }, touch.label, true);
  return true;
}

/** Fader let go (or W off, playback stopped): back to the curve that was there, one undo step. */
export function releaseTouch() {
  const k = touch;
  const song = touchSong;
  touch = null;
  touchSong = null;
  if (!k || !song) return;
  const tEnd = k.last + RETURN;
  const back = { t: Math.round(tEnd * 1e4) / 1e4, db: clampDb(automationDb(k.base, tEnd)) };
  const kept = k.base.filter((p) => p.t < k.t0 - 1e-3 || p.t > tEnd + 1e-3);
  const pts = simplify([...kept, ...thin(k.written), back].sort((a, b) => a.t - b.t));
  const s = songStem(song, k.stemId);
  if (s) writeStem(song, s.id, { auto: pts, autoRead: undefined }, k.label, true);
  endMix();
}

// The written points without those on the line between their neighbours (0.3 dB),
// at most what the engine holds (render.rs MAX_AUTO = 512).
function thin(points) {
  let tol = 0.3;
  let out = rdp(points, tol);
  while (out.length > 400) {
    tol *= 1.6;
    out = rdp(points, tol);
  }
  return out;
}
/** Points drawn by hand (Alt+drag in the Arrangement) thinned as the written ones. */
export const thinAutomation = (points) => thin(points);
const simplify = (points) => (points.length > 500 ? rdp(points, 1) : points);

function rdp(points, tol) {
  if (points.length < 3) return points.slice();
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const pa = points[a];
    const pb = points[b];
    let worst = -1;
    let far = 0;
    for (let i = a + 1; i < b; i += 1) {
      const p = points[i];
      const line = pb.t > pa.t ? pa.db + ((pb.db - pa.db) * (p.t - pa.t)) / (pb.t - pa.t) : pa.db;
      const d = Math.abs(p.db - line);
      if (d > far) {
        far = d;
        worst = i;
      }
    }
    if (worst >= 0 && far > tol) {
      keep[worst] = true;
      stack.push([a, worst], [worst, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
