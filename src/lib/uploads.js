// Stems, videos and PDF scores uploaded from this computer (same Storage paths and item
// fields as the web app). Uploads keep going while moving between songs and
// pages, and each file is also copied into the local cache.
import { useSyncExternalStore } from 'react';
import { addStem, deleteMediaFile, mediaTarget, saveScore, saveVideo, uploadMediaFile, videoOf } from '../shared/media.js';
import { scoreOf } from '../shared/score.js';
import { auth, db, storage } from './firebase';
import { explainDenied, mediaDestination } from '../shared/planGuard.js';
import { storeLocal } from './mediaCache';

// [{ key, itemId, kind: 'stems' | 'video' | 'score', name, progress 0..1, phase: 'mp3' | 'upload', cancel }]
let uploads = [];
const listeners = new Set();
const emit = (next) => {
  uploads = next;
  listeners.forEach((f) => f());
};
const patch = (key, p) => emit(uploads.map((u) => (u.key === key ? { ...u, ...p } : u)));
const drop = (key) => emit(uploads.filter((u) => u.key !== key));

export function useUploads() {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    () => uploads,
  );
}

/** onDone(text) for the history, onError(text) for the status bar. */
export async function startUploads({ setlistId, item, kind, files, onDone, onError }) {
  const target = mediaTarget(setlistId, item);
  // LiveTools cloud or the owner's Google Drive, within the plan (planGuard.js).
  let dest;
  try {
    dest = await mediaDestination(auth.currentUser, target, files);
  } catch (e) {
    onError(`Caricamento non avviato: ${explainDenied(e)}`);
    return;
  }
  const { store, mp3, device, error: limit } = dest;
  if (limit) {
    onError(limit);
    return;
  }
  files.forEach((file) => {
    const key = `${item.id}-${file.name}-${Date.now()}-${Math.random()}`;
    // WAV, AIFF and FLAC become MP3 here first (mp3.js); the original stays where it is on disk.
    const up = uploadMediaFile(storage, target, file, (progress, phase) => patch(key, { progress, phase }), { store, mp3, device });
    const { promise, cancel } = up;
    emit([...uploads, { key, itemId: item.id, kind, name: file.name, progress: 0, cancel }]);
    promise
      .then(async (media) => {
        // Free plan (store 'local'): this copy is the only one, wait for it.
        const copy = storeLocal(media.path, up.file);
        if (store === 'local' && !(await copy)) throw new Error('copia sul disco non riuscita');
        if (kind === 'stems') {
          await addStem(db, target, media);
          onDone(`Aggiunta la traccia “${media.name}” a “${item.title}”`);
        } else if (kind === 'score') {
          const previous = scoreOf(item);
          await saveScore(db, target, media);
          if (previous) await deleteMediaFile(storage, previous.path, target).catch(() => {});
          onDone(`Caricato lo spartito di “${item.title}”`);
        } else {
          const previous = videoOf(item);
          await saveVideo(db, target, { ...media, offset: previous?.offset || 0 });
          if (previous) await deleteMediaFile(storage, previous.path, target).catch(() => {});
          onDone(`Caricato il video di “${item.title}”`);
        }
      })
      .catch((e) => {
        if (e?.code !== 'storage/canceled') onError(`${file.name}: ${explainDenied(e)}`);
      })
      .finally(() => drop(key));
  });
}
