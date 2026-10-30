import {
  addDoc,
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { itemPayload } from './setlists';

// Audit log (setlists/{id}/history) and restorable versions
// (setlists/{id}/versions: full snapshot of title, columns, event and items).

const AUTO_SNAPSHOT_MS = 30 * 60 * 1000;
const lastSnapshot = new Map(); // setlistId → ms, avoids a read for every edit

export function logChange(setlistId, user, text) {
  return addDoc(collection(db, 'setlists', setlistId, 'history'), {
    text,
    by: (user.email || '').toLowerCase(),
    byName: user.displayName || user.email || '',
    at: serverTimestamp(),
  }).catch(() => {});
}

function snapshotOf(setlist, items) {
  return {
    title: setlist.title || '',
    columns: setlist.columns || [],
    event: setlist.event || null,
    items: items.map((it) => ({ id: it.id, ...itemPayload(it) })),
  };
}

export function saveVersion(setlist, items, user, label) {
  lastSnapshot.set(setlist.id, Date.now());
  return addDoc(collection(db, 'setlists', setlist.id, 'versions'), {
    label: label || 'Versione salvata',
    ...snapshotOf(setlist, items),
    songCount: items.filter((it) => it.type !== 'separator').length,
    by: (user.email || '').toLowerCase(),
    byName: user.displayName || user.email || '',
    at: serverTimestamp(),
  });
}

// Before the first change of an editing session, keep a copy of the setlist
// as it was, so a last-minute change can be undone.
export async function autoSnapshot(setlist, items, user) {
  const known = lastSnapshot.get(setlist.id);
  if (known && Date.now() - known < AUTO_SNAPSHOT_MS) return;
  lastSnapshot.set(setlist.id, Date.now());
  try {
    const s = await getDocs(query(collection(db, 'setlists', setlist.id, 'versions'), orderBy('at', 'desc'), limit(1)));
    const latest = s.docs[0]?.data().at?.toMillis?.() ?? 0;
    if (Date.now() - latest < AUTO_SNAPSHOT_MS) {
      lastSnapshot.set(setlist.id, latest);
      return;
    }
    await saveVersion(setlist, items, user, 'Salvataggio automatico prima delle modifiche');
  } catch {
    // history is best effort: never block an edit
  }
}

export async function restoreVersion(setlist, currentItems, version, user) {
  await saveVersion(setlist, currentItems, user, 'Prima del ripristino');
  const b = writeBatch(db);
  currentItems.forEach((it) => b.delete(doc(db, 'setlists', setlist.id, 'items', it.id)));
  version.items.forEach(({ id, ...data }, i) =>
    b.set(doc(db, 'setlists', setlist.id, 'items', id), {
      ...data,
      order: i,
      completed: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }),
  );
  b.update(doc(db, 'setlists', setlist.id), {
    title: version.title || setlist.title,
    columns: version.columns || [],
    event: version.event || null,
    updatedAt: serverTimestamp(),
  });
  await b.commit();
  const when = version.at?.toDate?.().toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) || '';
  await logChange(setlist.id, user, `Ripristinata la versione del ${when}`);
}

export function touchSetlist(setlistId) {
  return updateDoc(doc(db, 'setlists', setlistId), { updatedAt: serverTimestamp() }).catch(() => {});
}
