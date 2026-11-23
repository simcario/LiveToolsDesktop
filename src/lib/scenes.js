// Scene del mix: versions of the mix of every song, picked with one click (Arrangement, Mixer, telecomando).
// E.g. "Base" (the song as saved), "Live con la band" (the tracks of the instruments played on stage
// muted, with their automations), "Tutto aperto" (no fixed mute).
//
// A scene is of the account (users/{uid}.mixScenes, with a copy on this device that works offline, as the
// Gruppi Rehearsal): { id, name, muteGroups: [group], clearMutes }. Its rules hold for every song:
//  - muteGroups: the tracks of these Rehearsal groups are muted (Chitarre, Basso, Batteria…);
//  - clearMutes: the fixed mutes of the song are off (the mute automations stay).
// On top of them each song keeps what was changed in it while the scene was active: media field
// `scenes: { [sceneId]: { stems: { [stemId]: { muted, gain, auto, muteAuto, autoRead } }, click: { clickMix, clickAuto }, cue: { muted, gain } } }`,
// saved with the song (draft, "Salva") as the rest of its mix.
//
// How: the items of the app are shown and played with the active scene on top (useDraftItems), so the
// engine, the Arrangement, the Mixer and the Palco follow without knowing about it. Every edit of the mix
// goes through editDraft: with a scene active, splitForScene keeps those fields out of the song's own
// mix and writes them into its scene.
import { useSyncExternalStore } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { rehearsalGroup, stemsOf } from '../shared/media.js';

export const SCENE_FIELDS = ['muted', 'gain', 'auto', 'muteAuto', 'autoRead'];
const DEFAULTS = { muted: false, gain: 0, auto: [], muteAuto: [], autoRead: true };
const ACTIVE_KEY = 'livetools-desktop:mix-scene';
const LIST_KEY = 'lt.mixScenes';

const norm = (f, v) => (v === undefined || v === null ? DEFAULTS[f] : f === 'gain' ? Number(v) || 0 : f === 'muted' ? !!v : f === 'autoRead' ? v !== false : v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function readJson(key, fallback) {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(key) || 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key, v) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(v));
  } catch {
    // not kept on this device
  }
}

let account = null; // { db, uid }
const listKey = () => (account ? `${LIST_KEY}.${account.uid}` : LIST_KEY);
const cleanScene = (s) =>
  s && typeof s.id === 'string' && s.id
    ? { id: s.id, name: String(s.name || 'Scena').trim() || 'Scena', muteGroups: Array.isArray(s.muteGroups) ? s.muteGroups.filter((g) => typeof g === 'string') : [], clearMutes: !!s.clearMutes }
    : null;
const cleanList = (list) => (Array.isArray(list) ? list.map(cleanScene).filter(Boolean) : []);

let state = { list: cleanList(readJson(LIST_KEY, [])), active: readJson(ACTIVE_KEY, null) };
const listeners = new Set();
function set(next) {
  state = { ...state, ...next };
  listeners.forEach((f) => f());
}
const subscribe = (f) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

/** { list, active, scene } — scene: the active one, null = Base (the song as saved). */
export const useScenes = () => useSyncExternalStore(subscribe, () => state);
export const scenesState = () => state;
export const activeScene = () => state.list.find((s) => s.id === state.active) || null;

/** The scene picked on this computer (null = Base). */
export function setActiveScene(id) {
  const next = id && state.list.some((s) => s.id === id) ? id : null;
  writeJson(ACTIVE_KEY, next);
  set({ active: next });
}

function saveList(list) {
  const clean = cleanList(list);
  writeJson(listKey(), clean);
  set({ list: clean, active: clean.some((s) => s.id === state.active) ? state.active : null });
  if (account)
    updateDoc(doc(account.db, 'users', account.uid), { mixScenes: clean }).catch((e) => console.warn('Scene non salvate sull’account (riprovo alla prossima modifica)', e));
}

/**
 * Each snapshot of the profile (users/{uid}): the scenes of the account, null uid when signing out.
 * The first time the account has none, those made on this device go up.
 */
export function syncScenes(db, uid, cloud) {
  if (!uid) {
    account = null;
    return;
  }
  const first = account?.uid !== uid;
  account = { db, uid };
  if (Array.isArray(cloud)) {
    const list = cleanList(cloud);
    writeJson(listKey(), list);
    set({ list, active: list.some((s) => s.id === state.active) ? state.active : null });
  } else if (first) {
    const local = cleanList(readJson(listKey(), readJson(LIST_KEY, [])));
    if (local.length) saveList(local);
    else set({ list: [], active: null });
  }
}

const newId = () => `sc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A new scene (copy of `from` rules, if given); it becomes the active one. Returns its id. */
export function createScene(name, from = null) {
  const id = newId();
  saveList([...state.list, { id, name, muteGroups: from?.muteGroups || [], clearMutes: !!from?.clearMutes }]);
  setActiveScene(id);
  return id;
}
export const updateScene = (id, patch) => saveList(state.list.map((s) => (s.id === id ? { ...s, ...patch, id } : s)));
export function deleteScene(id) {
  saveList(state.list.filter((s) => s.id !== id));
}

// ---------- The items with the scene on top ----------

// The value a field gets from the rules of the scene (before what the song changed in it).
function ruled(stem, scene) {
  const r = Object.fromEntries(SCENE_FIELDS.map((f) => [f, norm(f, stem[f])]));
  if (scene.clearMutes) r.muted = false;
  if (scene.muteGroups.length && !stem.live && scene.muteGroups.includes(rehearsalGroup(stem))) r.muted = true;
  return r;
}

function withFields(stem, values) {
  const next = { ...stem };
  SCENE_FIELDS.forEach((f) => {
    if (!(f in values)) return;
    const v = values[f];
    if (same(v, DEFAULTS[f]) && !(f in stem)) delete next[f];
    else next[f] = v;
  });
  return next;
}

/** The item as the scene plays it (same object with no scene, or when the item has no tracks). */
export function applyScene(item, scene = activeScene()) {
  if (!item || !scene) return item;
  const own = item.scenes?.[scene.id] || {};
  const over = own.stems || {};
  const out = { ...item, sceneId: scene.id };
  if (Array.isArray(item.stems)) out.stems = item.stems.map((s) => withFields(s, { ...ruled(s, scene), ...(over[s.id] || {}) }));
  if (own.click?.clickMix !== undefined) out.clickMix = own.click.clickMix;
  if (own.click?.clickAuto !== undefined) out.clickAuto = own.click.clickAuto;
  if (own.cue && item.cueTrack) out.cueTrack = { ...item.cueTrack, ...own.cue };
  return out;
}

// Saved items (with their drafts but no scene), for splitForScene: itemId → item.
const bases = new Map();
export const registerBase = (item) => item && bases.set(item.id, item);
/** The saved item, without draft and scene (to write the song's own fields). */
export const baseOf = (itemId) => bases.get(itemId) || null;

/**
 * editDraft with a scene active: the mix fields written for the tracks, the click and the cue track
 * go into song.scenes[scene] (only where they differ from what the rules give), the song's own mix
 * stays as it is. `cur` = the draft so far. Returns { media, item } to write.
 */
export function splitForScene(itemId, { media = {}, item = {} }, cur) {
  const scene = activeScene();
  const saved = bases.get(itemId);
  const touches = 'stems' in media || 'cueTrack' in media || 'clickMix' in item || 'clickAuto' in item;
  if (!scene || !saved || !touches) return { media, item };
  const base = { ...saved, ...(cur?.media || {}), ...(cur?.item || {}) };
  const scenes = { ...(base.scenes || {}) };
  const own = { ...(scenes[scene.id] || {}) };
  const m = { ...media };
  const it = { ...item };

  if (Array.isArray(media.stems)) {
    const before = new Map(stemsOf(base).map((s) => [s.id, s]));
    const over = { ...(own.stems || {}) };
    m.stems = media.stems.map((w) => {
      const b = before.get(w.id);
      if (!b) return w; // a new track: all of it into the song
      const r = ruled(b, scene);
      const o = {};
      SCENE_FIELDS.forEach((f) => {
        const v = norm(f, w[f]);
        if (!same(v, r[f])) o[f] = v;
      });
      if (Object.keys(o).length) over[w.id] = o;
      else delete over[w.id];
      // The song keeps its own values of these fields.
      const keep = { ...w };
      SCENE_FIELDS.forEach((f) => {
        if (f in b) keep[f] = b[f];
        else delete keep[f];
      });
      return keep;
    });
    own.stems = over;
  }
  if (media.cueTrack && base.cueTrack) {
    const cue = {};
    ['muted', 'gain'].forEach((f) => {
      const v = norm(f, media.cueTrack[f]);
      if (!same(v, norm(f, base.cueTrack[f]))) cue[f] = v;
    });
    m.cueTrack = { ...media.cueTrack, muted: base.cueTrack.muted ?? false, gain: base.cueTrack.gain ?? 0 };
    if (Object.keys(cue).length) own.cue = cue;
    else delete own.cue;
  }
  ['clickMix', 'clickAuto'].forEach((k) => {
    if (!(k in item)) return;
    const click = { ...(own.click || {}) };
    if (same(item[k] ?? null, base[k] ?? null)) delete click[k];
    else click[k] = item[k] ?? null;
    delete it[k];
    if (Object.keys(click).length) own.click = click;
    else delete own.click;
  });

  const empty = !Object.keys(own.stems || {}).length && !own.cue && !own.click;
  if (empty) delete scenes[scene.id];
  else scenes[scene.id] = own;
  m.scenes = Object.keys(scenes).length ? scenes : null;
  return { media: m, item: it };
}

/** The song has its own changes in the scene (badge, "Togli le modifiche del brano"). */
export const songHasScene = (item, sceneId) => !!item?.scenes?.[sceneId];

/** Fields to write to drop what the song changed in a scene (back to its rules). */
export function clearSongScene(item, sceneId) {
  const scenes = { ...(item?.scenes || {}) };
  delete scenes[sceneId];
  return { scenes: Object.keys(scenes).length ? scenes : null };
}
