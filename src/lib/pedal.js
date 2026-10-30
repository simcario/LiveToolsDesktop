// Bluetooth devices connected to this computer (Rust side, bluetooth.rs), to
// show which page-turner pedal is ready. Read again every few seconds while a
// view shows them: pedals connect and go to sleep on their own.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

/** [{ id, name, kind: 'classic' | 'le', input }] or null while the first read runs. */
export function useBluetoothDevices(active = true, every = 4000) {
  const [devices, setDevices] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    const read = () =>
      invoke('bluetooth_devices')
        .then((list) => {
          if (cancelled) return;
          setDevices(list);
          setError(null);
        })
        .catch((e) => !cancelled && setError(String(e)));
    read();
    const t = setInterval(read, every);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [active, every]);
  return { devices, error };
}

/** The connected device that is most likely the pedal (an input device). */
export const pedalDevice = (devices) => devices?.find((d) => d.input) || null;
