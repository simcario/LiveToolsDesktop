// Rete locale di palco (desktop and tablet; src-tauri/src/stagenet.rs): the band in
// sync over the stage Wi-Fi, also without internet. Who leads ("Guida") hosts and
// publishes the song on stage; who follows ("Segui palco") finds the host of the same
// setlist by itself (or at the address written in the settings) and loads its song.
// With internet the same goes through Firestore too (setlist.live): the local network
// wins while connected, so a dead connection on stage does not stop the band.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { engineStatus, subscribeStatus } from './engine';

export const STAGE_PARTS = ['Master / Tastiere', 'Batteria', 'Voce', 'Chitarra', 'Basso', 'Fonico', 'Luci', 'Ospite'];

const EMPTY = { hosting: false, port: null, peers: [], joined: null, connected: false, rtt: null, error: null, beacons: [], state: null, host: null };
let net = EMPTY;
const subs = new Set();
const set = (patch) => {
  net = { ...net, ...patch };
  subs.forEach((f) => f());
};

let listening = null;
function listenOnce() {
  if (listening) return;
  listening = listen('stage-net', ({ payload: p }) => {
    if (p.t === 'status') {
      const patch = {};
      if ('hosting' in p) Object.assign(patch, { hosting: p.hosting, port: p.port ?? null });
      if ('joined' in p) Object.assign(patch, { joined: p.joined, connected: !!p.connected, error: p.error || null });
      if ('rtt' in p) patch.rtt = p.rtt;
      if (p.connected === false) Object.assign(patch, { rtt: null, state: null, host: null });
      set(patch);
      // stateAt: when it arrived (performance.now), to place the transport of who leads in time (lib/backup.js).
    } else if (p.t === 'state') set({ state: p.state, host: p.host, stateAt: performance.now() });
    else if (p.t === 'peers') set({ peers: p.peers || [] });
    else if (p.t === 'beacons') set({ beacons: p.beacons || [] });
  }).catch(() => {
    listening = null;
  });
}

/** { hosting, peers, joined, connected, rtt, error, beacons, state, host } of the local network. */
export function useStageNetState() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => net,
  );
}

/** The song on stage from the local network for this setlist: { itemId, at, byName } or null. */
export const lanLiveOf = (state, setlistId) => (state.connected && state.state?.setlist === setlistId && state.state.live?.itemId ? state.state.live : null);

const deviceKind = () => (/android|iphone|ipad/i.test(navigator.userAgent) ? 'tablet' : 'desktop');

/**
 * Hosts or follows on the local network as the settings say, mounted once in the main window.
 * `loadedItem`: the song in the player (published while leading). Returns the network state.
 */
export function useStageNet({ setlist, user, settings, canDrive, loadedItem, notify }) {
  const state = useStageNetState();
  const opts = settings.stageNet;
  const setlistId = setlist?.id || null;
  const host = opts.enabled && settings.driveStage && canDrive && !!setlistId;
  const follow = opts.enabled && settings.followStage && !host && !!setlistId;
  const name = user?.displayName || user?.email || 'LiveTools';
  const info = { setlist: setlistId, title: setlist?.title || '', name, part: opts.part || '', device: deviceKind() };
  const infoKey = JSON.stringify(info);
  const say = useRef(notify);
  say.current = notify;

  useEffect(listenOnce, []);

  // Leading: the server and its beacon. A new name, title or role only updates them: stopping
  // and starting again could leave the server on another port (who wrote the address loses it).
  const infoRef = useRef(infoKey);
  infoRef.current = infoKey;
  useEffect(() => {
    if (!host) return undefined;
    invoke('stage_net_host', { info: JSON.parse(infoRef.current) }).catch((e) => say.current?.(`Rete locale: ${e?.message || e}`, true));
    return () => {
      invoke('stage_net_host', { info: null }).catch(() => {});
    };
  }, [host]);
  useEffect(() => {
    if (host) invoke('stage_net_host', { info: JSON.parse(infoKey) }).catch(() => {});
  }, [host, infoKey]);

  // The song on stage, to everybody connected (the time only when it changes), and the
  // transport (play, stop, where) for a computer di riserva (lib/backup.js): on every
  // change, on a jump, and once a second while playing.
  const itemId = host ? loadedItem?.id || null : null;
  const since = useRef({ itemId: null, at: 0 });
  useEffect(() => {
    if (!host) return undefined;
    if (since.current.itemId !== itemId) since.current = { itemId, at: Date.now() };
    const live = { itemId, at: since.current.at, byName: name };
    let last = null;
    const publish = (s) => {
      const transport = { itemId, playing: !!s.playing, waiting: !!s.waiting, position: s.position || 0, rate: s.rate || 1 };
      invoke('stage_net_publish', { state: { setlist: setlistId, live, transport } }).catch(() => {});
      last = { ...transport, t: performance.now() };
    };
    publish(engineStatus());
    return subscribeStatus((s) => {
      const now = performance.now();
      const expected = last.playing && !last.waiting ? last.position + ((now - last.t) / 1000) * last.rate : last.position;
      const changed = !!s.playing !== last.playing || !!s.waiting !== last.waiting || (s.rate || 1) !== last.rate;
      const jumped = Math.abs((s.position || 0) - expected) > 0.25;
      if (changed || jumped || (s.playing && now - last.t > 1000)) publish(s);
    });
  }, [host, itemId, setlistId, name]);

  // Following: listen to the beacons, join the host of this setlist (or the address written by hand).
  useEffect(() => {
    if (!follow) return undefined;
    invoke('stage_net_scan', { on: true })
      .then((beacons) => set({ beacons }))
      .catch((e) => set({ error: String(e?.message || e) }));
    return () => {
      invoke('stage_net_scan', { on: false }).catch(() => {});
      set({ beacons: [] });
    };
  }, [follow]);

  const manual = (opts.address || '').trim();
  const found = state.beacons.find((b) => b.setlist === setlistId);
  const target = follow ? manual || found?.addr || null : null;
  useEffect(() => {
    invoke('stage_net_join', { addr: target, info: JSON.parse(infoKey) }).catch(() => {});
  }, [target, infoKey]);
  useEffect(
    () => () => {
      invoke('stage_net_join', { addr: null, info: {} }).catch(() => {});
    },
    [],
  );

  return state;
}

/** "3 ms", "—". */
export const rttText = (rtt) => (rtt == null ? '—' : `${rtt} ms`);
