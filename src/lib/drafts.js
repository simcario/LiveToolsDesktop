// Edits of a song in the Arrangement (tracks moved or trimmed, bars inserted,
// cues, grid, tempo and metre) are kept on this computer until "Salva": per
// item, the changed fields of its media document (regions, cueTrack, video:
// the library song or the item) and of the setlist item (bpm, timeSig,
// sections, grid, prompter, duration). The items of the app are shown and
// played with their draft on top, so everything follows at once; saving
// writes both documents, discarding drops the draft. Drafts survive a
// restart of the app (localStorage) until saved or discarded. Saving works
// offline too: see "Saves waiting for the network" below.
import { useMemo, useSyncExternalStore } from 'react';
import { doc, serverTimestamp, updateDoc, waitForPendingWrites } from 'firebase/firestore';
import { mediaTarget, saveMediaFields } from '../shared/media.js';
import { SONG_FIELDS, updateSong } from '../shared/songs.js';
import { db } from './firebase';

const KEY = 'livetools-desktop:drafts';

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

let drafts = read(); // itemId → { media: {}, item: {} }
const listeners = new Set();
function commit(next) {
  drafts = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(drafts));
  } catch {
    // storage unavailable: the draft lasts until the app is closed
  }
  listeners.forEach((f) => f());
}

const subscribe = (f) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

export const useDrafts = () => useSyncExternalStore(subscribe, () => drafts);
export const draftOf = (itemId) => drafts[itemId] || null;
export const isDirty = (itemId) => !!drafts[itemId];

/** Changes fields of the song's draft: { media, item } (undefined = missing → null, as in Firestore). */
export function editDraft(itemId, { media = {}, item = {} }) {
  const nul = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === undefined ? null : v]));
  const cur = drafts[itemId] || { media: {}, item: {} };
  commit({ ...drafts, [itemId]: { media: { ...cur.media, ...nul(media) }, item: { ...cur.item, ...nul(item) } } });
}

export function discardDraft(itemId) {
  if (!drafts[itemId]) return;
  const { [itemId]: _gone, ...rest } = drafts;
  commit(rest);
}

/** The item with its draft on top. */
export const withDraft = (item, d = drafts[item?.id]) => (item && d ? { ...item, ...d.media, ...d.item } : item);

/** Items of the setlist with their drafts (same objects when nothing changed). */
export function useDraftItems(items) {
  const all = useDrafts();
  return useMemo(() => items.map((it) => withDraft(it, all[it.id])), [items, all]);
}

// ---------- Saves waiting for the network ----------
// Offline a Firestore write is applied at once to the local cache (kept on disk
// with its queue) but its promise only settles when the server answers. So a
// save does not wait for it: offline, or when the server is silent for
// ACK_WAIT ms, the song counts as saved on this device and its draft moves
// here until the server confirms. If the server refuses it, the draft comes back.
const PENDING_KEY = 'livetools-desktop:pending-saves';
const ACK_WAIT = 4000;

function readPending() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');
  } catch {
    return {};
  }
}

let pending = readPending(); // itemId → { title, draft, at }
const pendingListeners = new Set();
const failListeners = new Set();
function commitPending(next) {
  pending = next;
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    // storage unavailable
  }
  pendingListeners.forEach((f) => f());
}
const subscribePending = (f) => {
  pendingListeners.add(f);
  return () => pendingListeners.delete(f);
};
const dropPending = (itemId, entry) => {
  if (pending[itemId] && (!entry || pending[itemId] === entry)) {
    const { [itemId]: _gone, ...rest } = pending;
    commitPending(rest);
  }
};

/** itemId → { title, at } of the songs saved here and not yet sent to the band. */
export const usePendingSaves = () => useSyncExternalStore(subscribePending, () => pending);

/** A save refused by the server once back online: f({ title, error }); its draft is back. */
export function onSaveFailed(f) {
  failListeners.add(f);
  return () => failListeners.delete(f);
}

// Saves queued in an earlier run of the app: Firestore keeps their writes on disk
// and sends them when the network is back; once all are acknowledged they are done.
if (Object.keys(pending).length) {
  const before = pending;
  waitForPendingWrites(db)
    .then(() => Object.keys(before).forEach((id) => dropPending(id, before[id])))
    .catch(() => {});
}

const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** The message after a save: saved for the band, or on this device until the network is back. */
export const savedMessage = (title, res) => (res?.queued ? `“${title}” salvato su questo dispositivo: arriva alla band appena torna la connessione` : `Salvato “${title}”`);

/**
 * Writes the draft of `item` (the item as shown, draft included): media
 * document and setlist item, the library song too for its song fields (as
 * the setlist editor does). The draft is dropped once written.
 * Returns { queued: true } when the device is offline (or the server does not
 * answer): the writes wait in the local cache and go out with the network.
 */
export async function saveDraft(setlistId, item) {
  const d = drafts[item.id];
  if (!d) return { queued: false };
  // All started at once: each is in the local cache as soon as it is called.
  const writes = [];
  if (Object.keys(d.media).length) writes.push(saveMediaFields(db, mediaTarget(setlistId, item), d.media));
  if (Object.keys(d.item).length) {
    writes.push(updateDoc(doc(db, 'setlists', setlistId, 'items', item.id), { ...d.item, updatedAt: serverTimestamp() }));
    // updateSong writes every song field: the item as shown carries them all.
    if (item.songId && item.songEditable && Object.keys(d.item).some((k) => SONG_FIELDS.includes(k))) writes.push(updateSong(item.songId, item).catch(() => {}));
  }
  const acked = Promise.all(writes);
  let timer;
  const wait = new Promise((resolve) => {
    if (offline()) resolve('queued');
    else timer = setTimeout(() => resolve('queued'), ACK_WAIT);
  });
  let outcome;
  try {
    outcome = await Promise.race([acked.then(() => 'done'), wait]);
  } finally {
    clearTimeout(timer);
  }
  // Only what was saved: edits made meanwhile stay in the draft.
  if (drafts[item.id] === d) discardDraft(item.id);
  if (outcome === 'done') return { queued: false };

  const entry = { title: item.title || '', draft: d, at: Date.now() };
  commitPending({ ...pending, [item.id]: entry });
  acked.then(
    () => dropPending(item.id, entry),
    (error) => {
      dropPending(item.id, entry);
      // Back as a draft, under the edits made since then.
      const cur = drafts[item.id] || { media: {}, item: {} };
      commit({ ...drafts, [item.id]: { media: { ...d.media, ...cur.media }, item: { ...d.item, ...cur.item } } });
      failListeners.forEach((f) => f({ itemId: item.id, title: entry.title, error }));
    },
  );
  return { queued: true };
}
