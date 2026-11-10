// Files of the Plus plan on the Google Drive the user connected (functions/drive.js).
// Shared with the desktop and the tablet app (scripts/sync-shared.mjs).
//
// A file on Drive has a media path like any other, so the local caches and the
// players treat it the same way:   drive/<folder of the song>/<Drive file id>/<name>
// e.g. drive/songs/abc123/1AbCdEf/Basso.wav. The folder of the song makes it
// "owned" by that song (ownsMedia in media.js), as for the files in Storage.
// Only the account that connected that Drive can read it: Plus is for personal use.

import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../lib/firebase';

export const DRIVE_PREFIX = 'drive/';
export const isDrivePath = (path) => typeof path === 'string' && path.startsWith(DRIVE_PREFIX);
/** Path of the media without the drive/ prefix (the part compared with the song's folder). */
export const driveInner = (path) => (isDrivePath(path) ? path.slice(DRIVE_PREFIX.length) : path);
/** Google Drive file id of a drive/… path. */
export const driveIdOf = (path) => {
  const parts = driveInner(path).split('/');
  return parts[parts.length - 2] || '';
};
export const drivePath = (folder, id, name) => `${DRIVE_PREFIX}${folder}${id}/${name}`;

const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
export const driveMediaUrl = (path) => `${API}/${encodeURIComponent(driveIdOf(path))}?alt=media`;

const callable = (name) => httpsCallable(getFunctions(app, 'europe-west1'), name);

let cached = null; // { accessToken, expiresAt, folderId, email }
let pending = null;

/** Access token of the connected Drive (kept until a minute before it expires). */
export async function driveToken({ fresh = false } = {}) {
  if (!fresh && cached && cached.expiresAt - 60_000 > Date.now()) return cached;
  pending ??= callable('driveToken')()
    .then(({ data }) => (cached = data))
    .finally(() => {
      pending = null;
    });
  return pending;
}

export const forgetDriveToken = () => {
  cached = null;
};

/** The code from the Google popup (web only) makes the connection on the server. */
export const connectDrive = (code) => callable('driveConnect')({ code }).then((r) => (forgetDriveToken(), r.data));
export const disconnectDrive = () => callable('driveDisconnect')().then(() => forgetDriveToken());

function driveError(status) {
  if (status === 404 || status === 403) {
    return new Error('File non raggiungibile su Google Drive: è sul Drive di un altro account o è stato eliminato.');
  }
  if (status === 401) return new Error('Accesso a Google Drive scaduto: ricollega Drive dalla pagina Account.');
  return new Error(`Google Drive non ha risposto (${status}).`);
}

/** fetch with the Drive token; one retry with a new token after a 401. */
export async function driveFetch(url, init = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { accessToken } = await driveToken({ fresh: attempt > 0 });
    const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${accessToken}` } });
    if (res.status !== 401 || attempt > 0) {
      if (!res.ok) throw driveError(res.status);
      return res;
    }
  }
  throw driveError(401);
}

/** Response with the content of a drive/… file (streamed, for progress). */
export const driveDownload = (path) => driveFetch(driveMediaUrl(path));

/** Bytes of a drive/… file. */
export const driveBytes = async (path) => (await driveDownload(path)).arrayBuffer();

/**
 * Uploads a file to the LiveTools folder of the connected Drive (resumable upload).
 * Resolves with { id, size }; onProgress receives 0..1; returns { promise, cancel }.
 */
export function uploadToDrive(file, { name, type, properties = {} }, onProgress) {
  let xhr = null;
  let canceled = false;
  const promise = (async () => {
    const { accessToken, folderId } = await driveToken();
    const start = await fetch(`${UPLOAD}?uploadType=resumable&fields=id,size`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': type,
        'X-Upload-Content-Length': String(file.size),
      },
      body: JSON.stringify({ name, mimeType: type, parents: folderId ? [folderId] : undefined, appProperties: { livetools: '1', ...properties } }),
    });
    if (!start.ok) throw driveError(start.status);
    const session = start.headers.get('Location');
    if (!session) throw new Error('Google Drive non ha aperto il caricamento.');
    if (canceled) throw Object.assign(new Error('Caricamento annullato'), { code: 'storage/canceled' });
    return new Promise((resolve, reject) => {
      xhr = new XMLHttpRequest();
      xhr.open('PUT', session);
      xhr.setRequestHeader('Content-Type', type);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const r = JSON.parse(xhr.responseText || '{}');
          resolve({ id: r.id, size: Number(r.size) || file.size });
        } else reject(driveError(xhr.status));
      };
      xhr.onerror = () => reject(new Error('Caricamento su Google Drive interrotto.'));
      // Same code as an upload to Storage canceled by the user: callers already ignore it.
      xhr.onabort = () => reject(Object.assign(new Error('Caricamento annullato'), { code: 'storage/canceled' }));
      xhr.send(file);
    });
  })();
  return {
    promise,
    cancel: () => {
      canceled = true;
      xhr?.abort();
    },
  };
}

/** Copy of a Drive file (another song takes it: each song owns its files). Resolves with the new id. */
export async function copyDriveFile(path, name) {
  const { folderId } = await driveToken();
  const res = await driveFetch(`${API}/${encodeURIComponent(driveIdOf(path))}/copy?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: folderId ? [folderId] : undefined }),
  });
  return (await res.json()).id;
}

/**
 * Deletes a Drive file. Never an error: a file already gone, on another account's
 * Drive or with Drive not connected here stays where it is (it costs LiveTools
 * nothing) and must not block removing the song.
 */
export async function deleteDriveFile(path) {
  try {
    await driveFetch(`${API}/${encodeURIComponent(driveIdOf(path))}`, { method: 'DELETE' });
  } catch (e) {
    console.warn('File su Google Drive non eliminato', path, e.message);
  }
}
