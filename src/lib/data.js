// Firestore: same collections and queries as the web app.
import { useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { collection, doc, onSnapshot, orderBy, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore';
import { syncCustomGroups } from '../shared/media.js';
import { canEditSong, useLinkedSongs, withSongMedia } from '../shared/songs.js';
import { auth, db } from './firebase';
import { syncScenes } from './scenes';

export function useAuthUser() {
  const [user, setUser] = useState(undefined); // undefined = loading
  useEffect(
    () =>
      onAuthStateChanged(auth, (u) => {
        setUser(u);
        if (u) {
          // Same profile document the web app maintains (roles are assigned there).
          setDoc(
            doc(db, 'users', u.uid),
            {
              uid: u.uid,
              email: (u.email || '').toLowerCase(),
              displayName: u.displayName || '',
              photoURL: u.photoURL || '',
              lastLoginAt: serverTimestamp(),
            },
            { merge: true },
          ).catch((e) => console.warn('Profilo non aggiornato', e));
        }
      }),
    [],
  );
  return user;
}

const byUpdated = (a, b) => (b.updatedAt?.toMillis?.() ?? 0) - (a.updatedAt?.toMillis?.() ?? 0);

function useQueryList(q) {
  const [list, setList] = useState(null);
  useEffect(() => {
    if (!q) return setList(null);
    return onSnapshot(
      q,
      (s) => setList(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (e) => {
        console.error(e);
        setList([]);
      },
    );
  }, [q]);
  return list;
}

// Setlists I own and setlists shared with me.
export function useSetlists(user) {
  const uid = user?.uid;
  const email = (user?.email || '').toLowerCase();
  const mineQ = useMemo(() => (uid ? query(collection(db, 'setlists'), where('ownerUid', '==', uid)) : null), [uid]);
  const sharedQ = useMemo(
    () => (email ? query(collection(db, 'setlists'), where('members', 'array-contains', email)) : null),
    [email],
  );
  const mine = useQueryList(mineQ);
  const shared = useQueryList(sharedQ);
  return useMemo(() => {
    if (!mine && !shared) return null;
    const map = new Map();
    [...(mine || []), ...(shared || [])].forEach((s) => map.set(s.id, s));
    return [...map.values()].sort(byUpdated);
  }, [mine, shared]);
}

// items carry the media of their library song (see shared/songs.js);
// itemDocs are the documents as stored, for the setlist history.
export function useSetlist(id, user, isAdmin = false) {
  const [setlist, setSetlist] = useState(null);
  const [itemDocs, setItems] = useState([]);
  useEffect(() => {
    setSetlist(null);
    setItems([]);
    if (!id) return undefined;
    const u1 = onSnapshot(
      doc(db, 'setlists', id),
      (s) => setSetlist(s.exists() ? { id: s.id, ...s.data() } : null),
      () => setSetlist(null),
    );
    const u2 = onSnapshot(
      query(collection(db, 'setlists', id, 'items'), orderBy('order')),
      (s) => setItems(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
      () => setItems([]),
    );
    return () => {
      u1();
      u2();
    };
  }, [id]);
  const linked = useLinkedSongs(itemDocs);
  const uid = user?.uid;
  const email = (user?.email || '').toLowerCase();
  const items = useMemo(
    () => withSongMedia(itemDocs, linked, (song) => canEditSong(song, uid, email, isAdmin)),
    [itemDocs, linked, uid, email, isAdmin],
  );
  return { setlist, items, itemDocs };
}

// "Guida la band": the song loaded here becomes the current one for everybody.
export function driveStage(setlist, itemId, user) {
  const email = (user.email || '').toLowerCase();
  return updateDoc(doc(db, 'setlists', setlist.id), {
    live: { ...(setlist.live || {}), itemId, at: serverTimestamp(), by: email, byName: user.displayName || email },
  });
}

// Permissions from the web app: 'user' (everyone who signs in) creates setlists
// and songs, 'viewer' (set by the super admin) only receives them and
// administration of the setlist tool (super admin or delegated admin), which
// also allows creating. Same rule as canCreate('setlist') on the web.
export function useAccess(user) {
  const [role, setRole] = useState('');
  const [superAdmin, setSuperAdmin] = useState(false);
  const [toolAdmin, setToolAdmin] = useState(false);
  useEffect(() => {
    if (!user) return undefined;
    const subs = [
      onSnapshot(doc(db, 'users', user.uid), (s) => setRole(s.data()?.role || 'user'), () => setRole('')),
      onSnapshot(doc(db, 'config', 'app'), (s) => setSuperAdmin(s.data()?.superAdminUid === user.uid), () => setSuperAdmin(false)),
      onSnapshot(doc(db, 'tools', 'setlist'), (s) => setToolAdmin((s.data()?.admins || []).includes(user.uid)), () => setToolAdmin(false)),
    ];
    return () => subs.forEach((u) => u());
  }, [user]);
  const isAdmin = superAdmin || toolAdmin;
  return { role, isAdmin, canCreate: isAdmin || role === 'user' };
}

// Plan and usage of the signed-in user (users/{uid}.plan / .usage, counted by the
// Cloud Functions) and whether the limits are applied yet (config/app.plansEnforced).
export function useAccount(user) {
  const [profile, setProfile] = useState(null);
  const [config, setConfig] = useState({});
  useEffect(() => {
    if (!user) {
      syncCustomGroups(null, null);
      syncScenes(null, null);
      return undefined;
    }
    const subs = [
      onSnapshot(
        doc(db, 'users', user.uid),
        (s) => {
          setProfile(s.data() || {});
          // Gruppi Rehearsal added by this account, the same on every computer and tablet (shared/media.js).
          if (s.exists()) syncCustomGroups(db, user.uid, s.data().rehearsalGroups);
          // Scene del mix of the account (lib/scenes.js).
          syncScenes(db, user.uid, s.exists() ? s.data().mixScenes : undefined);
        },
        () => setProfile({}),
      ),
      onSnapshot(doc(db, 'config', 'app'), (s) => setConfig(s.data() || {}), () => setConfig({})),
    ];
    return () => subs.forEach((u) => u());
  }, [user]);
  // The super admin has no limits.
  return { profile, enforced: config.plansEnforced === true, superAdmin: !!user && config.superAdminUid === user.uid };
}
