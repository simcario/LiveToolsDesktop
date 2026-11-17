// Telecomando (src-tauri/src/remote.rs): a phone or tablet with LiveTools Mobile drives
// the computer over the same Wi-Fi. This file is the remote side and the store shared
// by both; the computer side is lib/remoteHost.js. Copied into the mobile app.
import { useEffect, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// hosting/port/peers: this computer takes the remote. addr/connected/host/denied/state/beacons: this device drives one.
const EMPTY = { hosting: false, port: null, peers: [], addr: null, connected: false, host: null, denied: null, error: null, rtt: null, beacons: [], state: {}, stateAt: {} };
let net = EMPTY;
const subs = new Set();
const set = (patch) => {
  net = { ...net, ...patch };
  subs.forEach((f) => f());
};

const cmdListeners = new Set();
let listening = null;
function listenOnce() {
  if (listening) return;
  listening = listen('remote-net', ({ payload: p }) => {
    if (p.t === 'status') {
      const patch = {};
      if ('hosting' in p) Object.assign(patch, { hosting: p.hosting, port: p.port ?? null });
      if ('addr' in p) {
        Object.assign(patch, { addr: p.addr, connected: !!p.connected, error: p.error || null });
        if (p.connected) Object.assign(patch, { host: p.host || null, denied: null });
        else Object.assign(patch, { rtt: null, state: {}, stateAt: {} });
        if (p.denied) patch.denied = p.denied;
      }
      set(patch);
    } else if (p.t === 'state') set({ state: { ...net.state, [p.key]: p.value }, stateAt: { ...net.stateAt, [p.key]: performance.now() } });
    else if (p.t === 'rtt') set({ rtt: p.rtt });
    else if (p.t === 'peers') set({ peers: p.peers || [] });
    else if (p.t === 'beacons') set({ beacons: p.beacons || [] });
    else if (p.t === 'cmd' || p.t === 'denied') cmdListeners.forEach((f) => f(p));
  }).catch(() => {
    listening = null;
  });
}

/** The state of the remote, on both sides (see EMPTY). */
export function useRemoteState() {
  useEffect(listenOnce, []);
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => net,
  );
}

/** Computer side: every command from a remote ({ t: 'cmd', cmd, args, from }) and every refused code ({ t: 'denied' }). */
export function onRemoteMessage(f) {
  listenOnce();
  cmdListeners.add(f);
  return () => cmdListeners.delete(f);
}

// ---------- The remote (phone / tablet) ----------

/** Listens to the computers that take the remote while mounted with `on`. */
export function useRemoteScan(on) {
  useEffect(() => {
    if (!on) return undefined;
    listenOnce();
    invoke('remote_scan', { on: true })
      .then((beacons) => set({ beacons: beacons || [] }))
      .catch((e) => set({ error: String(e?.message || e) }));
    return () => {
      invoke('remote_scan', { on: false }).catch(() => {});
      set({ beacons: [] });
    };
  }, [on]);
}

/** Drives the computer at `addr` (null: lets it go); info: { name, device, code }. */
export function remoteConnect(addr, info = {}) {
  listenOnce();
  if (addr) set({ addr, denied: null, error: null });
  return invoke('remote_connect', { addr: addr || null, info: addr ? info : {} }).catch(() => {});
}

/** A command to the computer driven: false when not connected. */
export const remoteSend = (cmd, args = null) => invoke('remote_send', { cmd, args }).catch(() => false);

/**
 * Where the song of the computer is now: its position moved on by the time passed since the
 * last status (sent a few times a second), as the clock on the computer.
 */
export function remotePosition(state, stateAt, now = performance.now()) {
  const t = state.transport;
  if (!t) return 0;
  if (!t.playing || t.waiting) return t.position || 0;
  const at = stateAt.transport ?? now;
  return Math.min(t.duration || Infinity, (t.position || 0) + ((now - at) / 1000) * (t.rate || 1));
}

/** A fresh 4-digit code for the remote. */
export const newRemoteCode = () => String(Math.floor(1000 + Math.random() * 9000));
