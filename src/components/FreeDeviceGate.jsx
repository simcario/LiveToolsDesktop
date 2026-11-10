// Free plan: one device only (shared/device.js). The first device used becomes
// the account's one; on any other the app shows why it cannot be used.
import { useEffect } from 'react';
import { signOut } from 'firebase/auth';
import { openUrl } from '@tauri-apps/plugin-opener';
import { auth } from '../lib/firebase';
import { useAccount } from '../lib/data';
import { blockedBy, deviceLabel, registerDevice } from '../shared/device.js';
import { WEB_ACCOUNT } from './PreferencesPanel';

export default function FreeDeviceGate({ user, children }) {
  const { profile, enforced, superAdmin } = useAccount(user);
  useEffect(() => {
    if (profile) registerDevice(user.uid, profile, { superAdmin }).catch((e) => console.warn('Dispositivo non registrato', e));
  }, [user, profile, superAdmin]);
  const other = blockedBy(profile, { enforced, superAdmin });
  if (!other) return children;
  return (
    <div className="login">
      <div className="login-card">
        <h2>Account in uso su un altro dispositivo</h2>
        <p>
          Con il piano <b>Free</b> LiveTools funziona su un solo dispositivo: quello con cui hai cominciato, cioè{' '}
          <b>{deviceLabel(other)}</b>. Le tue tracce sono salvate lì e da questo computer non si possono usare.
        </p>
        <p className="hint">
          Per usare LiveTools anche qui passa al piano Plus o Pro. Se hai cambiato computer, scrivi all’amministratore per
          spostare l’account sul nuovo.
        </p>
        <button className="btn btn-primary" onClick={() => openUrl(WEB_ACCOUNT).catch(() => {})}>
          Vedi i piani
        </button>
        <button className="btn" onClick={() => signOut(auth)}>
          Esci ({user.email})
        </button>
      </div>
    </div>
  );
}
