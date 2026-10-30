import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { GoogleAuthProvider, signInWithCredential, signInWithEmailAndPassword } from 'firebase/auth';
import { auth, useEmulators } from '../lib/firebase';

// Same Google account as the web app. The browser part of the sign-in runs
// in the system browser (Rust: oauth.rs), then Firebase gets the ID token.
export default function Login() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [email, setEmail] = useState('');

  const google = async () => {
    setBusy(true);
    setError(null);
    try {
      const { idToken, accessToken } = await invoke('google_sign_in');
      await signInWithCredential(auth, GoogleAuthProvider.credential(idToken, accessToken));
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const emulator = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signInWithEmailAndPassword(auth, email, 'password');
    } catch (er) {
      setError(er.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-card">
        <img src="/brand/logo-full.png" alt="LiveTools" />
        <p className="muted" style={{ margin: 0 }}>
          Player di sequenze multitraccia e video per le tue scalette.
        </p>
        {useEmulators ? (
          <form onSubmit={emulator} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input type="email" placeholder="Email (emulatore)" value={email} onChange={(e) => setEmail(e.target.value)} />
            <button className="btn btn-primary" disabled={busy}>
              Entra
            </button>
          </form>
        ) : (
          <button className="btn btn-primary" onClick={google} disabled={busy} style={{ height: 40 }}>
            {busy ? 'Completa l’accesso nel browser…' : 'Accedi con Google'}
          </button>
        )}
        {error && <p className="error">{error}</p>}
        <p className="small faint" style={{ margin: 0 }}>
          Usa lo stesso account dell’app web: vedrai le stesse scalette.
        </p>
      </div>
    </div>
  );
}
