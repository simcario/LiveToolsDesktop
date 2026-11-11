// Palco Sync, presence (as the web app's lib/presence.js): while a setlist is
// open this device keeps a heartbeat in setlists/{id}/presence/{uid}, so the
// band sees it in the web Lineup too; it answers the ping of who leads; and it
// lists who is connected — from internet (Firestore) and from the stage
// network (lib/stageNet.js, also without internet) — telling when someone leaves.
import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, deleteDoc, doc, onSnapshot, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import { newId } from '../shared/setlists.js';

const BEAT_MS = 25000;
const ONLINE_MS = 70000;

const deviceLabel = () => (/android/i.test(navigator.userAgent) ? 'Tablet LiveTools' : 'Computer LiveTools');

/** Heartbeat of this device on the open setlist, with the stage part (Impostazioni › Rete locale). */
export function usePresence(setlistId, user, part) {
  useEffect(() => {
    if (!setlistId || !user) return undefined;
    const r = doc(db, 'setlists', setlistId, 'presence', user.uid);
    const beat = () =>
      setDoc(
        r,
        {
          uid: user.uid,
          email: (user.email || '').toLowerCase(),
          name: user.displayName || user.email || '',
          photoURL: user.photoURL || '',
          device: deviceLabel(),
          lastSeen: serverTimestamp(),
        },
        { merge: true },
      ).catch(() => {});
    beat();
    const timer = setInterval(beat, BEAT_MS);
    return () => {
      clearInterval(timer);
      deleteDoc(r).catch(() => {});
    };
  }, [setlistId, user]);

  useEffect(() => {
    if (!setlistId || !user) return;
    setDoc(doc(db, 'setlists', setlistId, 'presence', user.uid), { part: part || '' }, { merge: true }).catch(() => {});
  }, [setlistId, user, part]);
}

/** Answers the ping of who leads (setlist.live.ping) once per id. */
export function usePingResponder(setlistId, uid, ping) {
  const answered = useRef(null);
  useEffect(() => {
    if (!setlistId || !uid || !ping?.id || answered.current === ping.id) return;
    answered.current = ping.id;
    updateDoc(doc(db, 'setlists', setlistId, 'presence', uid), { pingAck: ping.id, pingAckAt: serverTimestamp() }).catch(() => {});
  }, [setlistId, uid, ping?.id]);
}

/** Who has the setlist open, from internet: [{ uid, name, part, device, pingAck, photoURL }]. */
export function useOnlineMembers(setlistId) {
  const [docs, setDocs] = useState([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!setlistId) return setDocs([]);
    return onSnapshot(
      collection(db, 'setlists', setlistId, 'presence'),
      (s) => setDocs(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
      () => setDocs([]),
    );
  }, [setlistId]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);
  return useMemo(() => docs.filter((d) => now - (d.lastSeen?.toMillis?.() ?? now) < ONLINE_MS), [docs, now]);
}

// One row per person and device: the same account on the computer and on the tablet
// (main and backup, or the leader with the tablet on the music stand) is two rows.
const keyOf = (name, device) => `${(name || '').trim().toLowerCase()}|${device || ''}`;
const lanDevice = (kind) => (kind === 'tablet' ? 'Tablet LiveTools' : 'Computer LiveTools');

/**
 * The band connected, internet and stage network together, one row per person and device:
 * [{ key, name, part, device, me, cloud, lan, rtt, pingAck, leads }], me first.
 * net: state of lib/stageNet.js (peers when leading, host when following).
 */
export function bandOf(members, net, user) {
  const myName = user?.displayName || user?.email || '';
  const rows = new Map();
  const add = (name, device, patch) => {
    if (!(name || '').trim()) return;
    const key = keyOf(name, device);
    const cur = rows.get(key) || { key, name, part: '', device, me: false, cloud: false, lan: false, rtt: null };
    rows.set(key, { ...cur, ...patch, part: patch.part || cur.part });
  };
  add(myName, deviceLabel(), { me: true });
  members.forEach((m) => {
    // This account: its presence document is this device (or another of mine, seen on the stage network).
    if (m.uid === user?.uid) return add(myName, deviceLabel(), { cloud: true, pingAck: m.pingAck });
    add(m.name || m.email, m.device || '', { uid: m.uid, part: m.part || '', cloud: true, pingAck: m.pingAck });
  });
  // On the stage network: the same person through internet too, when the device matches.
  const lanRow = (name, kind, patch) => {
    const device = lanDevice(kind);
    const mine = keyOf(name, device) === keyOf(myName, deviceLabel());
    if (mine) return; // this device itself
    add(name, device, { ...patch, lan: true, me: false, other: keyOf(name, '') === keyOf(myName, '') });
  };
  (net?.peers || []).forEach((p) => lanRow(p.name, p.device, { rtt: p.rtt ?? null, part: p.part || '' }));
  if (net?.connected && net.host?.name) lanRow(net.host.name, net.host.device, { rtt: net.rtt ?? null, part: net.host.part || '', leads: true });
  return [...rows.values()].sort((a, b) => (b.me ? 1 : 0) - (a.me ? 1 : 0) || a.name.localeCompare(b.name));
}

/**
 * Tells (notify) who leaves the band while Palco Sync is on: a person seen
 * connected for a while who is no longer there, from internet nor stage network.
 */
export function useBandLeaveNotice(band, active, notify) {
  const prev = useRef(new Map()); // key → { row, since }
  const say = useRef(notify);
  say.current = notify;
  useEffect(() => {
    const now = Date.now();
    const next = new Map();
    band.forEach((r) => !r.me && next.set(r.key, { row: r, since: prev.current.get(r.key)?.since ?? now }));
    if (active) {
      const gone = [...prev.current.values()].filter((p) => !next.has(p.row.key) && now - p.since > 10000).map((p) => p.row);
      if (gone.length) {
        const who = gone.map((r) => (r.other ? `il tuo ${r.device === 'Tablet LiveTools' ? 'tablet' : 'computer'}` : `${r.name.split(' ')[0]}${r.part ? ` (${r.part})` : ''}`)).join(', ');
        say.current?.(`${who[0].toUpperCase()}${who.slice(1)} ${gone.length === 1 ? 'si è scollegato' : 'si sono scollegati'} da Palco Sync`, true);
      }
    }
    prev.current = next;
  }, [band, active]);
}

/** Who leads asks everybody to answer (setlist.live.ping); returns { id, at } of the ping sent. */
export async function sendPing(setlist) {
  const id = newId();
  const at = performance.now();
  await updateDoc(doc(db, 'setlists', setlist.id), { live: { ...(setlist.live || {}), ping: { id, at: serverTimestamp() } } });
  return { id, at };
}

export function initials(name) {
  const parts = (name || '?').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}
