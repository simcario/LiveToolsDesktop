// Undo / redo of the Arrangement edits of a song: tracks moved, bars
// inserted, cues placed, cue track added or removed, grid set by hand.
// Every step keeps the fields it changed, before and after, on the two
// documents they live on: the media (regions, cueTrack, video: the library
// song or the item) and the setlist item (grid, prompter, sections,
// duration). Undo writes "before" back, redo writes "after", into the
// song's draft (lib/drafts.js, saved with "Salva"). Files in Storage
// (rendered cues) are not part of it. History is per song and lasts until
// the app is closed or the draft is discarded.
import { useSyncExternalStore } from 'react';
import { editDraft } from './drafts';

const MAX = 100;
let stacks = {}; // itemId → { past: [step], future: [step] }
const listeners = new Set();
const emit = () => listeners.forEach((f) => f());
const EMPTY = { past: [], future: [] };

// Firestore has no undefined: a field that was missing comes back as null.
const clean = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, v === undefined ? null : v]));

/**
 * Records an edit already written. step = { label, reload?, before: { media,
 * item }, after: { media, item } }; reload: the player must reload the song.
 */
export function recordStep(itemId, step) {
  const s = stacks[itemId] || EMPTY;
  const norm = {
    ...step,
    before: { media: clean(step.before.media), item: clean(step.before.item) },
    after: { media: clean(step.after.media), item: clean(step.after.item) },
  };
  stacks = { ...stacks, [itemId]: { past: [...s.past.slice(-(MAX - 1)), norm], future: [] } };
  emit();
}

export function useHistory(itemId) {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    () => stacks[itemId] || EMPTY,
  );
}

function write(item, side) {
  editDraft(item.id, side);
  return { ...item, ...side.media, ...side.item };
}

/** History of a song dropped (its draft was discarded: the steps no longer apply). */
export function clearHistory(itemId) {
  if (!stacks[itemId]) return;
  const { [itemId]: _gone, ...rest } = stacks;
  stacks = rest;
  emit();
}

/**
 * Undoes (dir -1) or redoes (dir 1) the last step of the song. Resolves with
 * { step, item } (item = the song as it is now) or null with nothing to do.
 */
export async function travel(item, dir) {
  const s = stacks[item.id] || EMPTY;
  const from = dir < 0 ? s.past : s.future;
  const step = from.at(-1);
  if (!step) return null;
  const next = write(item, dir < 0 ? step.before : step.after);
  stacks = {
    ...stacks,
    [item.id]: dir < 0 ? { past: s.past.slice(0, -1), future: [...s.future, step] } : { past: [...s.past, step], future: s.future.slice(0, -1) },
  };
  emit();
  return { step, item: next };
}
