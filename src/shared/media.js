// Media of the songs: the stems of a sequence (multitrack) and a video, stored
// in Firebase Storage and described on the song document. The LiveTools
// desktop app downloads them and plays them in sync.
//
// song.stems = [{ id, name, file, path, size, type, role, instrument, gain, pan, muted }]
// song.video = { id, name, file, path, size, type, offset } | null
//
// The media belong to the song of the library (songs/{songId}, files at
// songs/{songId}/{id}-{file}): every setlist using the song plays the same
// files (see songs.js). Songs added before the library keep them on the
// setlist item (setlists/{setlistId}/items/{itemId}/{id}-{file}). Mix values
// (gain in dB, pan -1..1, muted) are the defaults: each desktop can override
// them locally, together with the routing of each role to its outputs.

import { arrayUnion, doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { deleteObject, getBytes, ref, uploadBytes, uploadBytesResumable } from 'firebase/storage';
import { newId } from './setlists';

// Role of a stem: decides the output it goes to on the desktop (output matrix).
export const STEM_ROLES = {
  main: { label: 'Main (PA)', hint: 'Out 1-2: va all’impianto' },
  click: { label: 'Click', hint: 'Solo in cuffia (in-ear)' },
  guide: { label: 'Guide / Cue', hint: 'Guide vocali e cue in cuffia' },
  monitor: { label: 'Solo monitor', hint: 'In cuffia, non all’impianto' },
};

export const AUDIO_EXTENSIONS = ['wav', 'aif', 'aiff', 'flac', 'mp3', 'ogg', 'm4a', 'aac'];
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm'];

const MIME = {
  wav: 'audio/wav',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

export const extension = (name) => (/\.([a-z0-9]+)$/i.exec(name || '')?.[1] || '').toLowerCase();

// Browsers often leave the type empty for flac/aiff: fall back to the extension.
export function contentType(file) {
  return file.type || MIME[extension(file.name)] || 'application/octet-stream';
}

export function isAudioFile(file) {
  return contentType(file).startsWith('audio/') || AUDIO_EXTENSIONS.includes(extension(file.name));
}

export function isVideoFile(file) {
  return contentType(file).startsWith('video/') || VIDEO_EXTENSIONS.includes(extension(file.name));
}

// "03 - Click.wav" → "Click"
export function stemName(fileName) {
  return (fileName || '')
    .replace(/\.[^.]+$/, '')
    .replace(/^[\s\d._-]+(?=\D)/, '')
    .replace(/[_]+/g, ' ')
    .trim() || fileName;
}

export function guessRole(name) {
  const n = (name || '').toLowerCase();
  if (/\b(click|metro(nome)?|clic)\b/.test(n)) return 'click';
  if (/\b(guide|guida|cue|cues|count|conteggio)\b/.test(n)) return 'guide';
  return 'main';
}

// Instrument played by a stem: the rehearsal mix of a musician leaves out the
// stems of their instrument (and keeps the rest of the band, click and guides).
export const INSTRUMENTS = {
  drums: 'Batteria',
  perc: 'Percussioni',
  bass: 'Basso',
  guitar: 'Chitarre',
  keys: 'Tastiere',
  synth: 'Synth / Pad',
  vocals: 'Voce',
  bvox: 'Cori',
  brass: 'Fiati',
  strings: 'Archi',
  other: 'Altro',
};

const INSTRUMENT_PATTERNS = [
  ['bvox', /\b(cori|coro|choir|bvs?|bgv|backing ?vo(x|cals?)|harmon(y|ies))\b/],
  ['vocals', /\b(voce|voci|vox|vocals?|lead ?vo(x|cal)|lv|canto)\b/],
  ['drums', /\b(drums?|batteria|kick|cassa|snare|rullante|toms?|hi-?hats?|overheads?|oh|loops?)\b/],
  ['perc', /\b(perc(ussion[ie]?|s)?|shaker|tamb(ourine|urello)?|conga|bongo|cajon)\b/],
  ['bass', /\b(bass[oi]?|sub ?bass|bs)\b/],
  ['guitar', /\b(gtrs?|guitars?|chitarr[ae]|eg|ag|acoustic|elettrica)\b/],
  ['synth', /\b(synths?|pads?|arp|sequencer|seq|fx|sweep)\b/],
  ['keys', /\b(keys|keyboards?|tastier[ae]|piano|pno|organ|organo|rhodes|wurli|hammond|b3)\b/],
  ['brass', /\b(brass|fiati|horns?|sax|trumpets?|tromb(a|e|one)|trombones?)\b/],
  ['strings', /\b(strings?|archi|violin[io]?|viola|cello|violoncello)\b/],
];

export function guessInstrument(name) {
  const n = (name || '').toLowerCase().replace(/[_]+/g, ' ');
  return INSTRUMENT_PATTERNS.find(([, re]) => re.test(n))?.[0] || 'other';
}

// Click and guides are never "an instrument": they go in every rehearsal mix.
export function instrumentOf(stem) {
  if (stem.role === 'click' || stem.role === 'guide') return null;
  return INSTRUMENTS[stem.instrument] ? stem.instrument : guessInstrument(stem.name);
}

// Part of a musician on stage (device settings, e.g. "Master / Tastiere") → instrument.
export function partInstrument(part) {
  if (!part) return null;
  const found = guessInstrument(part);
  return found === 'other' ? null : found;
}

// Group of a stem in the rehearsal mix: its instrument, or click / guide,
// each switched on and off as a whole.
export const rehearsalGroup = (stem) => (stem.role === 'click' || stem.role === 'guide' ? stem.role : instrumentOf(stem));

export const groupLabel = (group) => (group === 'click' ? 'Click' : group === 'guide' ? 'Guide' : INSTRUMENTS[group] || group);

/** Groups of the audible stems of a song: instruments first, then click and guides. */
export function rehearsalGroups(item) {
  const present = new Set(stemsOf(item).filter((s) => !s.muted).map(rehearsalGroup));
  return [...Object.keys(INSTRUMENTS), 'click', 'guide'].filter((k) => present.has(k));
}

// "03 Amazing Grace - Rehearsal senza Basso.wav"
export function rehearsalFileName(item, left, number) {
  const title = (item.title || 'Brano').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  const num = number ? `${String(number).padStart(2, '0')} ` : '';
  const without = left.length ? ` senza ${left.map(groupLabel).join(', ')}` : '';
  return `${num}${title} - Rehearsal${without}.wav`;
}

export const stemsOf = (item) => (Array.isArray(item?.stems) ? item.stems : []);
export const videoOf = (item) => (item?.video?.path ? item.video : null);

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

// Owner of the media of a song: { songId } for the songs of the library,
// { setlistId, itemId } for older songs that keep them on the setlist item.
export const mediaTarget = (setlistId, item) => (item?.songId ? { songId: item.songId } : { setlistId, itemId: item.id });

const mediaFolder = (t) => (t.songId ? `songs/${t.songId}/` : `setlists/${t.setlistId}/items/${t.itemId}/`);

const mediaDoc = (db, t) => (t.songId ? doc(db, 'songs', t.songId) : doc(db, 'setlists', t.setlistId, 'items', t.itemId));

function mediaPath(target, id, file) {
  const safe = file.replace(/[^\w.\- ]+/g, '_');
  return `${mediaFolder(target)}${id}-${safe}`;
}

/**
 * Uploads a file of a song. Resolves with the media descriptor (not yet saved
 * on the song). onProgress receives 0..1; returns { promise, cancel }.
 */
export function uploadMedia(storage, target, file, onProgress) {
  const id = newId();
  const path = mediaPath(target, id, file.name);
  const type = contentType(file);
  const task = uploadBytesResumable(ref(storage, path), file, {
    contentType: type,
    customMetadata: { originalName: file.name },
  });
  const promise = new Promise((resolve, reject) => {
    task.on(
      'state_changed',
      (s) => onProgress?.(s.totalBytes ? s.bytesTransferred / s.totalBytes : 0),
      reject,
      () => resolve({ id, name: stemName(file.name), file: file.name, path, size: file.size, type }),
    );
  });
  return { promise, cancel: () => task.cancel() };
}

/** Copies a file already in Storage to another owner (same descriptor, new path). */
export async function copyMediaFile(storage, media, target) {
  const path = mediaPath(target, media.id || newId(), media.file || media.name || 'file');
  const bytes = await getBytes(ref(storage, media.path));
  await uploadBytes(ref(storage, path), bytes, {
    contentType: contentType({ type: media.type, name: media.file || media.path }),
    customMetadata: { originalName: media.file || '' },
  });
  return { ...media, path };
}

// arrayUnion keeps parallel uploads on the same song from overwriting each other.
export function addStem(db, target, media) {
  const stem = { ...media, role: guessRole(media.name), instrument: guessInstrument(media.name), gain: 0, pan: 0, muted: false };
  return updateDoc(mediaDoc(db, target), { stems: arrayUnion(stem), updatedAt: serverTimestamp() });
}

export function saveStems(db, target, stems) {
  return updateDoc(mediaDoc(db, target), { stems, updatedAt: serverTimestamp() });
}

// PDF score of the song (see score.js).
export function saveScore(db, target, score) {
  return updateDoc(mediaDoc(db, target), { score, updatedAt: serverTimestamp() });
}

export function saveVideo(db, target, video) {
  return updateDoc(mediaDoc(db, target), { video, updatedAt: serverTimestamp() });
}

// Cue sheet of the song (spoken guides placed on the grid, see the desktop
// "Cue" view): { resolution: 4 | 8, cues: [{ g, label }] }, g = beat from
// bar 1 (x.5 = the eighth after the beat). It lives with the media: the
// "Cues" stem rendered from it is one of the song's stems (generated: 'cues').
export const cueTrackOf = (song) => ({
  resolution: song?.cueTrack?.resolution === 8 ? 8 : 4,
  cues: (song?.cueTrack?.cues || []).filter((c) => Number.isFinite(c?.g) && c.label),
  // Cues the "Cues" stem was rendered from (to tell when it is out of date).
  renderedKey: song?.cueTrack?.renderedKey ?? null,
});

export function saveCueTrack(db, target, cueTrack) {
  return updateDoc(mediaDoc(db, target), { cueTrack, updatedAt: serverTimestamp() });
}

// Placement of the stems on the song's timeline, set in the desktop
// Arrangement (clips moved, bars inserted): { [stemId]: [{ at, from, len }] }
// = play the file from `from` seconds, `len` long (null: to its end), at
// `at` seconds of the song (muted: silent, kept in place). A stem without
// regions plays whole from 0.
export const regionsOf = (song) => (song?.regions && typeof song.regions === 'object' ? song.regions : {});

export function saveRegions(db, target, regions) {
  return updateDoc(mediaDoc(db, target), { regions, updatedAt: serverTimestamp() });
}

/** Fields of the song's media document, saved together (one write). */
export function saveMediaFields(db, target, fields) {
  return updateDoc(mediaDoc(db, target), { ...fields, updatedAt: serverTimestamp() });
}

// Duplicated setlists keep pointing at the files of the original: only the
// song (or item) that uploaded a file may delete it.
export const ownsMedia = (target, path) => (path || '').startsWith(mediaFolder(target));

// A file already gone from Storage must not block removing it from the list.
export async function deleteMediaFile(storage, path, owner) {
  if (owner && !ownsMedia(owner, path)) return;
  try {
    await deleteObject(ref(storage, path));
  } catch (e) {
    if (e?.code !== 'storage/object-not-found') throw e;
  }
}

export const mediaPaths = (song) =>
  [...stemsOf(song).map((s) => s.path), videoOf(song)?.path, song?.score?.path].filter(Boolean);

// Best effort: the list is already saved without them.
const deleteFiles = (storage, paths, owner) =>
  Promise.all(paths.map((p) => deleteMediaFile(storage, p, owner).catch(() => {})));

/** Deletes the whole sequence of a song: every stem leaves the song and Storage. */
export async function deleteAllStems(db, storage, target, stems) {
  await saveStems(db, target, []);
  await deleteFiles(storage, stems.map((s) => s.path).filter(Boolean), target);
}

// Every file of a library song, before deleting the song itself.
export const deleteSongMedia = (storage, song) => deleteFiles(storage, mediaPaths(song), { songId: song.id });

// A song removed from a setlist loses the files uploaded on the item (songs
// added before the library). Library media are not the item's: they stay with
// the song in "Brani".
export const deleteItemMedia = (storage, setlistId, item) =>
  deleteFiles(storage, mediaPaths(item), { setlistId, itemId: item.id });
