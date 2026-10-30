// Library of songs ("Brani"). Every song added to a setlist is also saved
// here, and songs can be created on their own, shared and added to other
// setlists. A setlist item keeps its own copy of the song fields (key, BPM,
// notes… may change from one show to the next) and points to the library song
// with item.songId; the media (stems, video) are always read from the library
// song, so every setlist plays the same files and deleting them deletes them
// everywhere.
//
// songs/{songId} = { ...SONG_FIELDS, stems, video, ownerUid, ownerEmail,
//                    ownerName, editors, viewers, members, createdAt, updatedAt }

import { useEffect, useMemo, useState } from 'react';
import { collection, deleteDoc, doc, getDocs, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { copyMediaFile, deleteItemMedia, deleteSongMedia, mediaPaths, stemsOf, videoOf } from './media';
import { getRole, isSeparator } from './setlists';

// Fields shared by library songs and setlist items (custom column values stay
// on the item: columns belong to the setlist).
export const SONG_FIELDS = [
  'title',
  'artist',
  'playback',
  'key',
  'bpm',
  'timeSig',
  'duration',
  'genre',
  'countInBars',
  'clickMode',
  'drumNotes',
  'chart',
  'lyrics',
  'chartUrl',
  'midi',
  'sections',
];

const LIST_FIELDS = ['midi', 'sections'];

export function songFields(source) {
  return Object.fromEntries(SONG_FIELDS.map((k) => [k, source?.[k] ?? (LIST_FIELDS.includes(k) ? [] : null)]));
}

// Fields of a new setlist item made from a library song.
export const itemFromSong = (song) => ({ ...songFields(song), songId: song.id });

export const SONG_ROLE_HINTS = {
  editor: 'Modifica il brano, le tracce e il video',
  viewer: 'Vede il brano e può aggiungerlo alle sue scalette',
};

/**
 * Creates a library song. The id is known at once (the item that links it is
 * written in the same moment, also offline); `done` settles with the server.
 */
export function createSong(user, data) {
  const ref = doc(collection(db, 'songs'));
  const done = setDoc(ref, {
    ...songFields(data),
    title: (data.title || '').trim() || 'Senza titolo',
    stems: [],
    video: null,
    ownerUid: user.uid,
    ownerEmail: (user.email || '').toLowerCase(),
    ownerName: user.displayName || '',
    editors: [],
    viewers: [],
    members: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return { id: ref.id, done };
}

export const updateSong = (songId, fields) =>
  updateDoc(doc(db, 'songs', songId), { ...songFields(fields), updatedAt: serverTimestamp() });

export const canEditSong = (song, uid, email, isAdmin) =>
  !!song && (song.ownerUid === uid || isAdmin || (song.editors || []).includes(email));

export const canManageSong = (song, uid, isAdmin) => !!song && (song.ownerUid === uid || isAdmin);

/** Deletes a library song with all its stems and video from Storage. */
export async function deleteSong(storage, song) {
  await deleteSongMedia(storage, song);
  await deleteDoc(doc(db, 'songs', song.id));
}

const byTitle = (a, b) => (a.title || '').localeCompare(b.title || '', 'it', { sensitivity: 'base' });

function useSongQuery(q) {
  const [list, setList] = useState(null);
  useEffect(() => {
    if (!q) return setList(null);
    return onSnapshot(
      q,
      (s) => setList(s.docs.map((d) => ({ id: d.id, songId: d.id, ...d.data() }))),
      (e) => {
        console.error(e);
        setList([]);
      },
    );
  }, [q]);
  return list;
}

// My songs and the songs shared with me. Each song also carries songId (its
// own id), so the media components treat it like a linked setlist item.
export function useLibrary(uid, email) {
  const mineQ = useMemo(() => (uid ? query(collection(db, 'songs'), where('ownerUid', '==', uid)) : null), [uid]);
  const sharedQ = useMemo(() => (email ? query(collection(db, 'songs'), where('members', 'array-contains', email)) : null), [email]);
  const mine = useSongQuery(mineQ);
  const shared = useSongQuery(sharedQ);
  return useMemo(() => {
    if (!mine && !shared) return { mine, shared, all: null };
    const map = new Map();
    [...(mine || []), ...(shared || [])].forEach((s) => map.set(s.id, s));
    return { mine: mine?.sort(byTitle) ?? null, shared: shared?.sort(byTitle) ?? null, all: [...map.values()].sort(byTitle) };
  }, [mine, shared]);
}

// Library songs linked by the items: songId → song, null when it no longer
// exists, false when it can't be read.
export function useLinkedSongs(items) {
  const ids = useMemo(() => [...new Set(items.map((it) => it.songId).filter(Boolean))].sort().join(','), [items]);
  const [songs, setSongs] = useState({});
  useEffect(() => {
    if (!ids) return undefined;
    const unsubs = ids.split(',').map((id) =>
      onSnapshot(
        doc(db, 'songs', id),
        (s) => setSongs((m) => ({ ...m, [id]: s.exists() ? { id, ...s.data() } : null })),
        () => setSongs((m) => ({ ...m, [id]: false })),
      ),
    );
    return () => unsubs.forEach((u) => u());
  }, [ids]);
  return songs;
}

/**
 * Items with the media of their library song. canEdit(song) tells whether the
 * user may change those media (songEditable). A song deleted from the library
 * leaves the item on its own (no songId), like the songs added before it.
 */
export function withSongMedia(items, songs, canEdit) {
  return items.map((it) => {
    if (!it.songId) return it;
    const song = songs[it.songId];
    if (song === null) {
      // eslint-disable-next-line no-unused-vars
      const { songId, ...rest } = it;
      return rest;
    }
    if (!song) return { ...it, stems: [], video: null, score: null, cueTrack: null, regions: null, songEditable: false };
    return { ...it, stems: song.stems || [], video: song.video || null, score: song.score || null, cueTrack: song.cueTrack || null, regions: song.regions || null, songEditable: canEdit(song) };
  });
}

// ---------- Import from the setlists ----------

const nameKey = (s) => `${(s.title || '').trim().toLowerCase()}|${(s.artist || '').trim().toLowerCase()}`;

// Songs of the setlists I can edit that are not in the library yet, grouped
// by song: same title and artist, and the same files (duplicated setlists
// share them). A version without files joins the only one with files.
async function songsToImport(user, setlists, isAdmin) {
  const email = (user.email || '').toLowerCase();
  const editable = setlists.filter((s) => ['owner', 'admin', 'editor'].includes(getRole(s, user.uid, email, isAdmin)));
  const groups = new Map(); // name → Map(files → [{ setlistId, item }])
  for (const s of editable) {
    let snap;
    try {
      snap = await getDocs(collection(db, 'setlists', s.id, 'items'));
    } catch {
      continue;
    }
    snap.docs.forEach((d) => {
      const item = { id: d.id, ...d.data() };
      if (isSeparator(item) || item.songId || !(item.title || '').trim()) return;
      const name = nameKey(item);
      const files = mediaPaths(item).sort().join('|');
      if (!groups.has(name)) groups.set(name, new Map());
      const byFiles = groups.get(name);
      if (!byFiles.has(files)) byFiles.set(files, []);
      byFiles.get(files).push({ setlistId: s.id, item });
    });
  }
  return [...groups.values()].flatMap((byFiles) => {
    const bare = byFiles.get('');
    const withFiles = [...byFiles].filter(([k]) => k).map(([, list]) => list);
    if (bare && withFiles.length === 1) return [[...withFiles[0], ...bare]];
    return [...byFiles.values()];
  });
}

/**
 * Brings the songs of my setlists into the library. Each song becomes (or
 * joins, by title and artist) a library song; its stems and video are copied
 * under the song and the copies on the setlist items are deleted, so the
 * files exist once. onProgress({ step, total, text }).
 */
export async function importFromSetlists({ user, setlists, library, isAdmin, storage, onProgress }) {
  const email = (user.email || '').toLowerCase();
  const groups = await songsToImport(user, setlists, isAdmin);
  const result = { created: 0, linked: 0, items: 0, files: 0, errors: [] };
  const taken = new Set();
  for (let g = 0; g < groups.length; g += 1) {
    const list = groups[g];
    const source = list.find((e) => mediaPaths(e.item).length)?.item || list[0].item;
    const files = mediaPaths(source).length;
    const progress = (text) => onProgress?.({ step: g + 1, total: groups.length, text });
    progress(source.title);
    try {
      // An editable library song with the same name, unless both have files.
      const existing = (library || []).find(
        (s) => !taken.has(s.id) && nameKey(s) === nameKey(source) && canEditSong(s, user.uid, email, isAdmin) && !(files && mediaPaths(s).length),
      );
      let songId = existing?.id;
      if (existing) {
        result.linked += 1;
      } else {
        const created = createSong(user, source);
        await created.done;
        songId = created.id;
        result.created += 1;
      }
      taken.add(songId);

      if (files) {
        const target = { songId };
        let n = 0;
        const copy = (m) => {
          n += 1;
          progress(`${source.title} · file ${n}/${files}`);
          return copyMediaFile(storage, m, target);
        };
        const stems = [];
        for (const s of stemsOf(source)) stems.push(await copy(s));
        const video = videoOf(source) ? await copy(videoOf(source)) : null;
        const score = source.score?.path ? await copy(source.score) : null;
        await updateDoc(doc(db, 'songs', songId), { stems, video, score, updatedAt: serverTimestamp() });
        result.files += files;
      }

      for (const { setlistId, item } of list) {
        await updateDoc(doc(db, 'setlists', setlistId, 'items', item.id), {
          songId,
          ...(mediaPaths(item).length && { stems: [], video: null, score: null }),
          updatedAt: serverTimestamp(),
        });
        result.items += 1;
      }
      // The items now play the library copies: the originals can go.
      if (files) await Promise.all(list.map(({ setlistId, item }) => deleteItemMedia(storage, setlistId, item)));
    } catch (e) {
      result.errors.push(`${source.title}: ${e.message}`);
    }
  }
  return result;
}

export function importSummary(r) {
  if (!r.items && !r.errors.length) return 'Nessun brano da importare: le scalette sono già nella libreria.';
  const parts = [`${r.items} brani delle scalette collegati`, `${r.created} nuovi in libreria`];
  if (r.linked) parts.push(`${r.linked} uniti a brani esistenti`);
  if (r.files) parts.push(`${r.files} file copiati`);
  if (r.errors.length) parts.push(`${r.errors.length} errori`);
  return `${parts.join(' · ')}.`;
}
