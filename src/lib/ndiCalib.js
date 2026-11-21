// Calibration of the latency of an NDI output with the phone (Impostazioni › Uscite NDI).
// The phone drives this computer as Telecomando (lib/remote.js): it gets the part of state
// `calib`, films the screen that receives the output and listens to the speakers; here
// ndi_calibrate (src-tauri/src/ndi) beeps on every output and flashes the NDI output white
// when the beep is heard. The phone sends back how much later the flash came than the beep:
// that is the compensation.
//   phase: waiting (the phone gets ready) → running (flashes) → measuring (the phone works it
//   out) → done | error; idle = nothing.
import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { onRemoteMessage } from './remote';
import { NDI_MAX_LATENCY } from './ndi';

export const CALIB_COUNT = 8;
export const CALIB_INTERVAL = 1500; // ms between two flashes

const IDLE = { run: null, kind: null, phase: 'idle', name: '', result: null, error: null };
let state = IDLE;
let onResult = null;
const subs = new Set();

function set(patch) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
  const { run, kind, phase, name, result, error } = state;
  invoke('remote_publish', { key: 'calib', value: phase === 'idle' ? null : { run, kind, phase, name, result, error, count: CALIB_COUNT, interval: CALIB_INTERVAL } }).catch(() => {});
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  onRemoteMessage((m) => {
    if (m.cmd !== 'calib') return;
    const a = m.args || {};
    if (!state.run || a.run !== state.run) return;
    switch (a.action) {
      case 'ready':
        if (state.phase !== 'waiting') return;
        set({ phase: 'running', from: m.name || null });
        invoke('ndi_calibrate', { kind: state.kind, count: CALIB_COUNT, intervalMs: CALIB_INTERVAL })
          .then(() => a.run === state.run && set({ phase: 'measuring' }))
          .catch((e) => a.run === state.run && set({ phase: 'error', error: String(e?.message || e) }));
        break;
      case 'result': {
        if (state.phase !== 'measuring' && state.phase !== 'running') return;
        // Video earlier than the audio: nothing to compensate (the picture cannot be held back here).
        const ms = Math.max(0, Math.min(NDI_MAX_LATENCY, Math.round((Number(a.ms) || 0) / 10) * 10));
        set({ phase: 'done', result: { ms, measured: Math.round(Number(a.ms) || 0), n: a.n || 0, spread: Math.round(a.spread || 0) } });
        onResult?.(state.kind, ms);
        break;
      }
      case 'fail':
        set({ phase: 'error', error: a.reason || 'Il telefono non è riuscito a misurare' });
        break;
      case 'cancel':
        set(IDLE);
        break;
      default:
    }
  });
}

/** Starts the calibration of output `kind` ("video" | "prompter"); `apply(kind, ms)` sets the compensation found. */
export function startNdiCalibration(kind, name, apply) {
  listen();
  onResult = apply;
  set({ ...IDLE, run: `${Date.now()}`, kind, name, phase: 'waiting' });
}

export const cancelNdiCalibration = () => set(IDLE);

export function useNdiCalibration() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );
}
