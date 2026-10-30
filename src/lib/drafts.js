// Edits of a song in the Arrangement (tracks moved or trimmed, bars inserted,
// cues, grid, tempo and metre) are kept on this computer until "Salva": per
// item, the changed fields of its media document (regions, cueTrack, video:
// the library song or the item) and of the setlist item (bpm, timeSig,
// sections, grid, prompter, duration). The items of the app are shown and
// played with their draft on top, so everything follows at once; saving
// writes both documents, discarding drops the draft. Drafts survive a
// restart of the app (localStorage) until saved or discarded.
import { useMemo, useSyncExternalStore } from 'react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
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

/**
 * Writes the draft of `item` (the item as shown, draft included): media
 * document and setlist item, the library song too for its song fields (as
 * the setlist editor does). The draft is dropped once written.
 */
export async function saveDraft(setlistId, item) {
  const d = drafts[item.id];
  if (!d) return;
  if (Object.keys(d.media).length) await saveMediaFields(db, mediaTarget(setlistId, item), d.media);
  if (Object.keys(d.item).length) {
    await updateDoc(doc(db, 'setlists', setlistId, 'items', item.id), { ...d.item, updatedAt: serverTimestamp() });
    // updateSong writes every song field: the item as shown carries them all.
    if (item.songId && item.songEditable && Object.keys(d.item).some((k) => SONG_FIELDS.includes(k))) await updateSong(item.songId, item).catch(() => {});
  }
  // Only what was saved: edits made meanwhile stay in the draft.
  if (drafts[item.id] === d) discardDraft(item.id);
}
