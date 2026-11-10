// Limits of the plans (plans.js) checked before writing, so that the user reads
// why instead of a "permission denied", and the place where audio and video go:
// the LiveTools cloud (Pro) or the Google Drive the user connected (Plus, drive.js).
// The Firestore and Storage rules apply the same limits; until
// config/app.plansEnforced is true nothing is blocked. Shared with the desktop and
// the tablet app (scripts/sync-shared.mjs).
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { contentType, extension, isLossless } from './media';
import { formatBytes, planOf } from './plans';
import { deviceId } from './device';

// Neutral on purpose: inside the Android app no purchase outside Google Play may be suggested.
const UPGRADE = 'Il piano si cambia da Impostazioni → Account.';
// Scores (PDF and images) up to 20 MB go to the cloud with every plan (storage.rules: isScore).
const SCORE_MAX = 20 * 1024 * 1024;
export const isScoreFile = (file) => /^(application\/pdf|image\/(jpeg|png|webp))$/.test(contentType(file)) && file.size < SCORE_MAX;

async function read(...path) {
  try {
    const s = await getDoc(doc(db, ...path));
    return s.exists() ? s.data() : null;
  } catch {
    return undefined; // not readable (rules, offline without cache): the server decides
  }
}

async function config() {
  const c = (await read('config', 'app')) || {};
  return { enforced: c.plansEnforced === true, superAdminUid: c.superAdminUid || null };
}

/**
 * null, or why `user` cannot create another library song (Free: 10 songs).
 * `setlist`: the setlist the song is created in; when it is someone else's the
 * song goes to its owner (songs.js createSong) and their plan counts.
 */
export async function songLimitError(user, setlist = null) {
  const { enforced, superAdminUid } = await config();
  const ownerUid = setlist?.ownerUid || user?.uid;
  if (!enforced || !user || ownerUid === superAdminUid) return null;
  const mine = ownerUid === user.uid;
  const profile = await read('users', ownerUid);
  if (profile === undefined || (!mine && profile === null)) return null;
  const plan = planOf(profile);
  const used = Number(profile?.usage?.songs) || 0;
  if (!Number.isFinite(plan.songs) || used < plan.songs) return null;
  if (!mine) {
    const who = setlist.ownerName || setlist.ownerEmail || 'il proprietario della scaletta';
    return `I brani nuovi di questa scaletta vanno nella libreria di ${who}, che ha già ${used} brani: il suo piano ${plan.label} ne consente ${plan.songs}.`;
  }
  return `Hai già ${used} brani nella libreria: il piano ${plan.label} ne consente ${plan.songs}. ${UPGRADE}`;
}

/**
 * null, or why `members` (the people of `setlist` after a change, owner
 * excluded) are too many: the Pro plan allows 6 different people per setlist.
 * Removing people is always allowed.
 */
export async function teamLimitError(setlist, members) {
  const after = new Set(members).size;
  const before = new Set(setlist?.members || []).size;
  const { enforced, superAdminUid } = await config();
  if (!enforced || after <= before || !setlist?.ownerUid || setlist.ownerUid === superAdminUid) return null;
  const profile = await read('users', setlist.ownerUid);
  if (!profile) return null;
  const plan = planOf(profile);
  if (plan.id !== 'pro' || after <= plan.members) return null;
  return `Con il piano ${plan.label} una scaletta si condivide con al massimo ${plan.members} persone, oltre al proprietario.`;
}

// Owner of the song (library) or of the setlist (older songs) the media go to.
async function ownerOf(target) {
  const owner = target.songId ? await read('songs', target.songId) : await read('setlists', target.setlistId);
  return owner?.ownerUid || null;
}

/**
 * Plus: whether the uncompressed files (WAV, AIFF, FLAC) go to Drive as MP3
 * (users/{uid}.mediaFormat: 'mp3', the default, or 'original'). In the cloud they
 * always go as MP3.
 */
export const MEDIA_FORMATS = {
  mp3: 'Converti in MP3 (320 kbps, occupa circa un quinto)',
  original: 'Carica i file così come sono',
};
export const mediaFormatOf = (profile) => (profile?.mediaFormat === 'original' ? 'original' : 'mp3');
export const saveMediaFormat = (uid, format) => updateDoc(doc(db, 'users', uid), { mediaFormat: format === 'original' ? 'original' : 'mp3' });

// Size of a file once uploaded: an MP3 320 kbps is about a quarter of a 16-bit
// 44.1 kHz WAV (less for 24 bits or 48 kHz), a bit less than half of a FLAC.
const uploadedSize = (f, mp3) => (mp3 && isLossless(f) ? Math.ceil((f.size || 0) * (extension(f.name) === 'flac' ? 0.45 : 0.25)) : f.size || 0);

/** Drive connected and working on a profile. */
export const driveReady = (profile) => !!profile?.drive?.email && profile.drive.status !== 'revoked';

/**
 * Where `files` go for the song `target` ({ songId } or { setlistId, itemId }):
 * { store: 'cloud' | 'drive', mp3, error: null } or { store: null, error: why not }.
 * mp3: convert the uncompressed audio first (media.js uploadMediaFile).
 * - scores: always the LiveTools cloud;
 * - Pro owner (or the super admin): the cloud, within 25 GB;
 * - Free owner: only on their device (store 'local', nothing is uploaded);
 * - Plus owner: their connected Google Drive, only when they upload themselves
 *   (nobody can write on someone else's Drive);
 * - with the limits still off, whoever has not connected a Drive keeps using the cloud.
 */
export async function mediaDestination(user, target, files) {
  const CLOUD = { store: 'cloud', mp3: true, error: null };
  const media = files.filter((f) => !isScoreFile(f));
  if (!media.length) return CLOUD;
  const { enforced, superAdminUid } = await config();
  const ownerUid = await ownerOf(target);
  if (!ownerUid || ownerUid === superAdminUid) return CLOUD;
  const mine = ownerUid === user?.uid;
  const profile = await read('users', ownerUid);
  // Someone else's profile that cannot be read: the Storage rules decide.
  if (profile === undefined || (!mine && profile === null)) return CLOUD;
  const plan = planOf(profile);

  if (plan.media === 'drive') {
    if (mine && driveReady(profile)) return { store: 'drive', mp3: mediaFormatOf(profile) === 'mp3', error: null };
    if (!enforced) return CLOUD;
    if (!mine) {
      return { store: null, error: 'Il proprietario del brano ha il piano Plus: audio e video stanno sul suo Google Drive e li carica solo lui.' };
    }
    return {
      store: null,
      error:
        profile?.drive?.status === 'revoked'
          ? 'L’accesso a Google Drive è stato revocato: ricollega Drive da Impostazioni → Account.'
          : 'Con il piano Plus audio e video vanno sul tuo Google Drive: collegalo da Impostazioni → Account.',
    };
  }
  if (!enforced) return CLOUD;
  // Free: only on this device (device.js), which is the account's one device.
  if (plan.media === 'local') {
    if (mine) return { store: 'local', mp3: false, device: deviceId(), error: null };
    return { store: null, error: 'Il proprietario del brano ha il piano Free: audio e video restano sul suo dispositivo e li aggiunge solo lui.' };
  }
  if (plan.media !== 'cloud') {
    return {
      store: null,
      error: mine
        ? `Con il piano ${plan.label} audio e video non vanno nel cloud LiveTools: serve il piano Plus (sul tuo Google Drive) o Pro. ${UPGRADE}`
        : 'Il proprietario del brano non ha un piano che conserva audio e video: questi file non si possono caricare.',
    };
  }
  const used = Number(profile?.usage?.bytes) || 0;
  const adding = media.reduce((a, f) => a + uploadedSize(f, true), 0);
  if (used + adding <= plan.storage) return CLOUD;
  return {
    store: null,
    error: mine
      ? `Spazio nel cloud esaurito: usi ${formatBytes(used)} di ${formatBytes(plan.storage)} e questi file occupano circa ${formatBytes(adding)}. Elimina tracce o video che non usi più.`
      : 'Lo spazio nel cloud del proprietario del brano è esaurito: questi file non si possono caricare.',
  };
}

/** Text for an error of a write refused by the rules, which may be a plan limit. */
export const explainDenied = (e) =>
  /permission|unauthorized|insufficient/i.test(`${e?.code || ''} ${e?.message || ''}`)
    ? `Operazione non consentita: controlla il tuo ruolo e i limiti del piano (Impostazioni → Account).${e?.code ? ` [${e.code}]` : ''}`
    : e?.message || String(e);
