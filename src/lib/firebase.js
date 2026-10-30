// Same Firebase project as the web app (src/shared/firebaseConfig.js reads it from .env).
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, indexedDBLocalPersistence, initializeAuth } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
} from 'firebase/firestore';
import { connectStorageEmulator, getStorage } from 'firebase/storage';
import firebaseConfig from '../shared/firebaseConfig.js';

export const app = initializeApp(firebaseConfig);
// No popup/redirect resolver: sign-in goes through the system browser (Rust side).
export const auth = initializeAuth(app, { persistence: indexedDBLocalPersistence });
// Offline cache: the setlists stay available on stage without a network.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
});
export const storage = getStorage(app);

export const useEmulators = import.meta.env.VITE_USE_EMULATORS === 'true';
if (useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8085);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
}
