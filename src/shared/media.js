// Media of the songs: the stems of a sequence (multitrack) and a video, stored
// in Firebase Storage and described on the song document. The LiveTools
// desktop app downloads them and plays them in sync.
//
// song.stems = [{ id, name, file, path, size, type, role, instrument, gain, pan, input, eq, muted }]
// (input, eq: channel section of the Mixer, see eq.js)
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
import { copyDriveFile, deleteDriveFile, driveInner, drivePath, isDrivePath, uploadToDrive } from './drive';

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
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
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

// Uncompressed or lossless audio: converted to MP3 before going to the cloud (mp3.js).
// MP3, AAC, Ogg… are already small and stay as they are.
export const LOSSLESS_EXTENSIONS = ['wav', 'aif', 'aiff', 'flac'];
export const isLossless = (file) => LOSSLESS_EXTENSIONS.includes(extension(file?.name));

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
  if (stem.instrument === VIDEO_GROUP) return VIDEO_GROUP;
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

// 'metro': the system click of the web rehearsal, synthesised on the grid of the song.
const GROUP_LABELS = { click: 'Click', metro: 'Click di sistema', guide: 'Guide', video: 'Video' };
export const groupLabel = (group) => GROUP_LABELS[group] || INSTRUMENTS[group] || group;

/** Groups of the audible stems of a song: instruments first, then click and guides. */
export function rehearsalGroups(item) {
  if (isVideoItem(item)) return videoOf(item) ? [VIDEO_GROUP] : [];
  const present = new Set(stemsOf(item).filter((s) => !s.muted).map(rehearsalGroup));
  // Cues without a "Cues" file: the rehearsal makes them (lib/cue-track.js), in the guides.
  if (present.size && cueTrackOf(item).cues.length) present.add('guide');
  return [...Object.keys(INSTRUMENTS), 'click', 'guide'].filter((k) => present.has(k));
}

/** Groups of the web rehearsal: those of the stems plus the system click, next to the audio one. */
export function rehearsalMixGroups(item) {
  const groups = rehearsalGroups(item);
  if (isVideoItem(item)) return groups;
  if (groups.length) groups.splice(groups.length - (groups.includes('guide') ? 1 : 0), 0, 'metro');
  return groups;
}

export const stemsOf = (item) => (Array.isArray(item?.stems) ? item.stems : []);
export const videoOf = (item) => (item?.video?.path ? item.video : null);

// ---------- Video items ----------
// A setlist item can be only a video (playback 'video', e.g. the opening video):
// no stems, its sound is the one of the video file, heard as a track of the
// group "Video", and it links to the next song (AutoLink unless another
// transition is chosen). On the item, for the whole band: fade in and out of
// picture and sound (videoFadeIn / videoFadeOut, seconds) and padLead, the
// seconds before the end of the video when the pad comes in, in the key of the
// next song (a song without intro can then start straight away). padHold: the
// seconds the pad goes on into the next song before fading out in padFadeOut
// seconds (none: it goes on until PAD turns it off).
export const VIDEO_GROUP = 'video';
export const isVideoItem = (item) => item?.playback === 'video';
export const VIDEO_FADE_MAX = 30;
export const PAD_LEAD_MAX = 120;
const seconds = (v, fallback, max) => (v === null || v === undefined || v === '' ? fallback : Math.max(0, Math.min(max, Number(v) || 0)));
const endOf = (v) => (Number(v) > 0 ? Number(v) : null);
// Picture and sound of a video item each have a fade in, a fade out and an end (`end`:
// seconds of the video where it stops, null = the end of the file; the fade out ends
// there). videoFadeIn / videoFadeOut / videoEnd are the picture; the sound follows
// them unless `audioApart` (Transizioni page): then audioFadeIn / audioFadeOut / audioEnd.
// So the picture can fade to the picture of the setlist while the sound goes on, or the
// sound fade out under the picture.
export const videoFades = (item) => ({ in: seconds(item?.videoFadeIn, 0, VIDEO_FADE_MAX), out: seconds(item?.videoFadeOut, 3, VIDEO_FADE_MAX), end: endOf(item?.videoEnd) });
export const audioApart = (item) => !!item?.audioApart;
export const audioFades = (item) => {
  const pic = videoFades(item);
  if (!audioApart(item)) return pic;
  return { in: seconds(item.audioFadeIn, pic.in, VIDEO_FADE_MAX), out: seconds(item.audioFadeOut, pic.out, VIDEO_FADE_MAX), end: endOf(item.audioEnd) };
};
/** Where picture or sound stops (seconds of the video): its end, at most the length of the file. */
export const fadeStop = (fades, duration) => (fades?.end > 0 ? (Number.isFinite(duration) && duration > 0 ? Math.min(duration, fades.end) : fades.end) : duration);
export const padLeadOf = (item) => (isVideoItem(item) && Number(item?.padLead) > 0 ? Math.min(PAD_LEAD_MAX, Number(item.padLead)) : null);
export const PAD_HOLD_MAX = 300;
export const PAD_FADE_MAX = 30;
/** How the pad of a video item ends in the next song: { hold, fadeOut } seconds, or null (it goes on). */
export const padHoldOf = (item) =>
  padLeadOf(item) != null && Number(item?.padHold) > 0
    ? { hold: Math.min(PAD_HOLD_MAX, Number(item.padHold)), fadeOut: Math.max(0.5, seconds(item?.padFadeOut, 4, PAD_FADE_MAX)) }
    : null;
// The sound of the video as a track: it plays from the video file itself. Its strip in
// the desktop Mixer saves volume, pan, mute and channel section on the video (video.gain…).
export const VIDEO_AUDIO_ID = 'video-audio';
export const videoAudioStem = (item) => {
  const v = item?.video || {};
  return { id: VIDEO_AUDIO_ID, name: 'Audio del video', role: 'main', instrument: VIDEO_GROUP, gain: Number(v.gain) || 0, pan: Number(v.pan) || 0, input: v.input, eq: v.eq, muted: !!v.muted };
};
/** Level of picture or sound (0..1) at `t` seconds of a video `duration` long, with its fades (and end). */
export function fadeLevel(t, duration, fades) {
  let g = 1;
  const stop = fadeStop(fades, duration);
  // Stopped before the end of the file: nothing after.
  if (fades.end > 0 && t >= stop) return 0;
  if (fades.in > 0) g = Math.min(g, t / fades.in);
  if (fades.out > 0 && Number.isFinite(stop) && stop > 0) g = Math.min(g, (stop - t) / fades.out);
  return Math.max(0, Math.min(1, g));
}

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

// Free plan: the files stay on the device that added them (device.js), under
// local/<folder of the song>/<id>-<name>. Nothing goes to the network; each app
// keeps the bytes in its own cache (setLocalFiles) and the other devices only
// see that the file exists.
export const LOCAL_PREFIX = 'local/';
export const isLocalPath = (path) => (path || '').startsWith(LOCAL_PREFIX);
let localFiles = null;
/**
 * The app's store of the files on this device: { remove(path) } deletes a
 * local/… file, { evict(path) } the copy of a cloud file downloaded here.
 */
export const setLocalFiles = (impl) => {
  localFiles = impl;
};
const innerPath = (path) => (isLocalPath(path) ? path.slice(LOCAL_PREFIX.length) : driveInner(path));

const mediaDoc = (db, t) => (t.songId ? doc(db, 'songs', t.songId) : doc(db, 'setlists', t.setlistId, 'items', t.itemId));

const safeName = (file) => file.replace(/[^\w.\- ]+/g, '_');

function mediaPath(target, id, file) {
  return `${mediaFolder(target)}${id}-${safeName(file)}`;
}

/**
 * Uploads a file of a song. Resolves with the media descriptor (not yet saved
 * on the song). onProgress receives 0..1; returns { promise, cancel }.
 * store: 'cloud' (LiveTools Storage), 'drive' (the Google Drive the user
 * connected, Plus plan: drive.js) or 'local' (only this device, Free plan: the
 * caller keeps the file in its cache). The choice is mediaDestination in planGuard.js.
 */
export function uploadMedia(storage, target, file, onProgress, { store = 'cloud', device = null } = {}) {
  const id = newId();
  if (store === 'local') {
    onProgress?.(1);
    const media = { id, name: stemName(file.name), file: file.name, path: LOCAL_PREFIX + mediaPath(target, id, file.name), size: file.size, type: contentType(file), store: 'local', device };
    return { promise: Promise.resolve(media), cancel: () => {} };
  }
  if (store === 'drive') {
    const type = contentType(file);
    const up = uploadToDrive(file, { name: file.name, type, properties: { mediaId: id } }, onProgress);
    const promise = up.promise.then((r) => ({
      id,
      name: stemName(file.name),
      file: file.name,
      path: drivePath(mediaFolder(target), r.id, safeName(file.name)),
      size: r.size,
      type,
      store: 'drive',
    }));
    return { promise, cancel: up.cancel };
  }
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

/**
 * uploadMedia, converting first a WAV, AIFF or FLAC file to MP3 when `mp3`
 * (mediaDestination in planGuard.js decides). onProgress(0..1, phase) with phase
 * 'mp3' while converting and 'upload' after. Returns { promise, cancel, file }:
 * `file` is the File really uploaded once the promise settles (the MP3, or the
 * original), for the local cache.
 */
export function uploadMediaFile(storage, target, file, onProgress, { store = 'cloud', mp3 = false, device = null } = {}) {
  if (!mp3 || !isLossless(file)) {
    const up = uploadMedia(storage, target, file, (p) => onProgress?.(p, 'upload'), { store, device });
    return { ...up, file };
  }
  const abort = new AbortController();
  let upload = null;
  const handle = {
    file,
    cancel: () => {
      abort.abort();
      upload?.cancel();
    },
  };
  onProgress?.(0, 'mp3');
  handle.promise = import('./mp3')
    .then(({ toMp3 }) => toMp3(file, (p) => onProgress?.(p, 'mp3'), abort.signal))
    .then((converted) => {
      if (abort.signal.aborted) throw Object.assign(new Error('Caricamento annullato'), { code: 'storage/canceled' });
      handle.file = converted;
      upload = uploadMedia(storage, target, converted, (p) => onProgress?.(p, 'upload'), { store });
      return upload.promise;
    });
  return handle;
}

/** Copies a file already in Storage to another owner (same descriptor, new path). */
export async function copyMediaFile(storage, media, target) {
  // Only on the device that has it, cached under its path: the same file.
  if (isLocalPath(media.path)) return { ...media };
  // On Google Drive: a copy on the same Drive, owned by the new song.
  if (isDrivePath(media.path)) {
    const name = media.file || media.name || 'file';
    return { ...media, path: drivePath(mediaFolder(target), await copyDriveFile(media.path, name), safeName(name)) };
  }
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

// Score of the song, a PDF or an image (see score.js).
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
  // Mix of the cue track made from the sheet (desktop live track, web rehearsal): dB, -1..1.
  gain: Number(song?.cueTrack?.gain) || 0,
  pan: Number(song?.cueTrack?.pan) || 0,
  // Channel section (Mixer → click on the track name): input gain dB and EQ, see eq.js.
  input: Number(song?.cueTrack?.input) || 0,
  eq: song?.cueTrack?.eq || null,
  // Mute of the cue track for the whole band (saved with the song): on after the
  // mixdown into the "Cues" file, which is then the track heard. Songs rendered
  // before the mute existed: muted when they have the file.
  muted: typeof song?.cueTrack?.muted === 'boolean' ? song.cueTrack.muted : stemsOf(song).some((s) => s.generated === 'cues'),
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

// Volume automation of a stem (desktop Arrangement, "Automazione" tool):
// stems[].auto = [{ t, db }] = seconds of the song and level in dB on top of
// the fader (0 = as the fader, AUTO_MIN_DB = silent); a straight line in dB
// between two points, the first and the last hold before and after them.
// Missing or [] = no automation. The desktop engine and the web rehearsal play it the same way.
export const AUTO_MIN_DB = -60;
export const AUTO_MAX_DB = 6;

export function automationOf(stem) {
  return (Array.isArray(stem?.auto) ? stem.auto : [])
    .filter((p) => Number.isFinite(p?.t) && Number.isFinite(p?.db))
    .map((p) => ({ t: Math.max(0, p.t), db: Math.max(AUTO_MIN_DB, Math.min(AUTO_MAX_DB, p.db)) }))
    .sort((a, b) => a.t - b.t);
}

/** Level of the automation at second t (dB, 0 without automation). */
export function automationDb(points, t) {
  if (!points?.length) return 0;
  if (t <= points[0].t) return points[0].db;
  const last = points[points.length - 1];
  if (t >= last.t) return last.db;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  return b.t > a.t ? a.db + ((b.db - a.db) * (t - a.t)) / (b.t - a.t) : b.db;
}

/** Linear gain of the automation at second t (1 without automation). */
export const automationGain = (points, t) => {
  const db = automationDb(points, t);
  return db <= AUTO_MIN_DB ? 0 : 10 ** (db / 20);
};

/** Points after second `t` moved by `delta` seconds (bars inserted, start of the song moved). */
export const shiftAutomation = (points, t, delta) => (points || []).map((p) => (p.t >= t ? { ...p, t: Math.max(0, Math.round((p.t + delta) * 1e4) / 1e4) } : p));

// Mute automation of a stem (R/W of the channel as in Cubase, or drawn with the
// Automazione tool): stems[].muteAuto = [{ t, on }] = from second t of the song the
// track is muted (on) or plays again; before the first point it plays.
// stems[].autoRead === false = the R of the channel is off: its automations
// (volume and mute) stay in the song but are not played.
export const automationRead = (stem) => stem?.autoRead !== false;

export function muteAutomationOf(stem) {
  const list = (Array.isArray(stem?.muteAuto) ? stem.muteAuto : [])
    .filter((p) => Number.isFinite(p?.t))
    .map((p) => ({ t: Math.max(0, p.t), on: !!p.on }))
    .sort((a, b) => a.t - b.t);
  // Only the changes of state count.
  const out = [];
  list.forEach((p) => {
    if (out.length && Math.abs(out[out.length - 1].t - p.t) < 1e-4) out.pop();
    if (p.on !== (out.length ? out[out.length - 1].on : false)) out.push(p);
  });
  return out;
}

/** Muted by the mute automation at second t. */
export function automationMutedAt(points, t) {
  let on = false;
  for (const p of points || []) {
    if (p.t > t) break;
    on = p.on;
  }
  return on;
}

/** Muted spans of the mute automation: [{ from, to }] (to = Infinity up to the end). */
export const muteSpans = (points) =>
  (points || []).reduce((spans, p) => {
    if (p.on) spans.push({ from: p.t, to: Infinity });
    else if (spans.length && spans[spans.length - 1].to === Infinity) spans[spans.length - 1].to = p.t;
    return spans;
  }, []);

// Mute and volume automation of the system click (lane Click · Tempo of the desktop Arrangement):
// item.clickAuto = { muteAuto: [{ t, on }], auto: [{ t, db }], autoRead } as a stem's, for instance
// to stop the click at the end of a song and leave the tempo free.
export const clickAutoOf = (item) => (item?.clickAuto && typeof item.clickAuto === 'object' ? item.clickAuto : {});

/** Spans [{ from, to }] (seconds of the song) where the click is silent; [] with R off. */
export const clickMuteSpans = (item) => (automationRead(clickAutoOf(item)) ? muteSpans(muteAutomationOf(clickAutoOf(item))) : []);

// Volume automation of the click: item.clickAuto.auto = [{ t, db }] as a stem's auto
// (dB on top of the click's level, -60 = silent); the count-in keeps its level.
/** Volume points of the click that are played; [] with R off. */
export const clickVolumeOf = (item) => (automationRead(clickAutoOf(item)) ? automationOf(clickAutoOf(item)) : []);

/** The click is silenced at second t (spans of clickMuteSpans). */
export const clickMutedIn = (spans, t) => spans.some((s) => t >= s.from && t < s.to);

// A change of the mute is a 5 ms ramp (no click).
const MUTE_RAMP = 0.005;

/**
 * The volume curve that is played (desktop engine, web rehearsal): the volume
 * automation with the mute automation in it (silence where it mutes), [] with
 * the R of the channel off or without automations.
 */
export function playedAutomation(stem) {
  if (!automationRead(stem)) return [];
  const vol = automationOf(stem);
  const mutes = muteAutomationOf(stem);
  if (!mutes.length) return vol;
  const at = (t, on) => ({ t: Math.max(0, t), db: on ? AUTO_MIN_DB : automationDb(vol, t) });
  const pts = vol.map((p) => at(p.t, automationMutedAt(mutes, p.t)));
  mutes.forEach((m) => {
    if (m.t >= MUTE_RAMP) pts.push(at(m.t - MUTE_RAMP, !m.on));
    pts.push(at(m.t, m.on));
  });
  // Stable sort: at the same second the change of the mute comes after the ramp.
  return pts.sort((a, b) => a.t - b.t);
}

/** Fields of the song's media document, saved together (one write). */
export function saveMediaFields(db, target, fields) {
  return updateDoc(mediaDoc(db, target), { ...fields, updatedAt: serverTimestamp() });
}

// Duplicated setlists keep pointing at the files of the original: only the
// song (or item) that uploaded a file may delete it.
export const ownsMedia = (target, path) => innerPath(path || '').startsWith(mediaFolder(target));

// A file already gone from Storage must not block removing it from the list.
// The file goes from the cloud (Storage or Drive) and from this device: the
// copy downloaded to play offline and the data made from it (peaks, analysis).
export async function deleteMediaFile(storage, path, owner) {
  if (owner && !ownsMedia(owner, path)) return;
  if (isLocalPath(path)) {
    await localFiles?.remove?.(path);
    return;
  }
  if (isDrivePath(path)) {
    await deleteDriveFile(path);
  } else {
    try {
      await deleteObject(ref(storage, path));
    } catch (e) {
      if (e?.code !== 'storage/object-not-found') throw e;
    }
  }
  await localFiles?.evict?.(path);
}

export const mediaPaths = (song) =>
  [...stemsOf(song).map((s) => s.path), videoOf(song)?.path, song?.score?.path].filter(Boolean);

// For the confirmation of a deletion: what happens to these files in the cloud.
export function deletionNote(target, paths) {
  const owned = paths.filter((p) => ownsMedia(target, p)).length;
  const everywhere = target.songId ? ' e da tutte le scalette che usano il brano' : '';
  const gone =
    owned === 1
      ? `Il file viene eliminato definitivamente dallo storage cloud e da questo dispositivo${everywhere}.`
      : `I ${owned} file vengono eliminati definitivamente dallo storage cloud e da questo dispositivo${everywhere}.`;
  const kept = paths.length - owned;
  return [owned > 0 && gone, kept > 0 && `${kept === 1 ? 'Un file resta' : `${kept} file restano`} nello storage perché ${kept === 1 ? 'appartiene' : 'appartengono'} alla scaletta da cui questa è stata duplicata.`]
    .filter(Boolean)
    .join(' ');
}

const notDeleted = (failed) => new Error(`${failed.length} file non eliminati dallo storage cloud: ${failed[0].reason?.message || failed[0].reason}`);

// Every file is attempted. A failure rejects, so the caller keeps the reference
// and the deletion can be retried instead of leaving the file orphaned.
async function deleteFiles(storage, paths, owner) {
  const failed = (await Promise.allSettled(paths.map((p) => deleteMediaFile(storage, p, owner)))).filter((r) => r.status === 'rejected');
  if (failed.length) throw notDeleted(failed);
}

/** Deletes the whole sequence of a song: every stem leaves Storage and the song; a stem whose file can't be deleted stays listed. */
export async function deleteAllStems(db, storage, target, stems) {
  const results = await Promise.allSettled(stems.map((s) => deleteMediaFile(storage, s.path, target)));
  await saveStems(db, target, stems.filter((_, i) => results[i].status === 'rejected'));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) throw notDeleted(failed);
}

// Every file of a library song, before deleting the song itself.
export const deleteSongMedia = (storage, song) => deleteFiles(storage, mediaPaths(song), { songId: song.id });

// A song removed from a setlist loses the files uploaded on the item (songs
// added before the library). Library media are not the item's: they stay with
// the song in "Brani".
export const deleteItemMedia = (storage, setlistId, item) =>
  deleteFiles(storage, mediaPaths(item), { setlistId, itemId: item.id });
