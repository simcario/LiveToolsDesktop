// Mix edits of the song made outside the Mixer (mute of a track in the
// Arrangement, volume and mute of the groups in the Palco mixer): into the
// song's draft as the Mixer does (lib/drafts.js, "Salva" writes them for the
// whole band and the web), one undo step per gesture (a fader drag is one).
import { editDraft } from './drafts';
import { recordStep } from './arrangeHistory';

let pending = null; // { id, label, before, after } of the drag going on

/** Writes media fields of the song into its draft; `live` = part of a drag (closed by endMix). */
export function writeMix(song, media, label, live = false) {
  if (!song) return;
  const before = Object.fromEntries(Object.keys(media).map((k) => [k, song[k] ?? null]));
  editDraft(song.id, { media });
  if (live) {
    if (pending && (pending.id !== song.id || pending.label !== label)) endMix();
    if (!pending) pending = { id: song.id, label, before };
    pending.after = media;
    return;
  }
  endMix();
  recordStep(song.id, { label, before: { media: before, item: {} }, after: { media, item: {} } });
}

/** Fields of the setlist item (and of its library song) into the draft, one undo step. */
export function writeItem(song, item, label) {
  if (!song) return;
  endMix();
  const before = Object.fromEntries(Object.keys(item).map((k) => [k, song[k] ?? null]));
  editDraft(song.id, { item });
  recordStep(song.id, { label, before: { media: {}, item: before }, after: { media: {}, item } });
}

/** End of a drag: its undo step. */
export function endMix() {
  const p = pending;
  pending = null;
  if (p) recordStep(p.id, { label: p.label, before: { media: p.before, item: {} }, after: { media: p.after, item: {} } });
}
