// Computer di riserva: a second computer that follows who leads the band on the
// stage network (lib/stageNet.js) and plays along with it — same song, same play
// and stop, same place — on its own outputs. A hardware switch (or moving the
// cables) puts it on the PA if the main computer stops; and when the main one
// is gone from the network while playing, the backup goes on and, if allowed,
// leads the band by itself (Guida), so tablets and other computers follow it.
import { useEffect, useRef } from 'react';
import { engine, engineStatus } from './engine';

// Out of step by more than this: the backup moves to where the main one is.
const MAX_DRIFT = 0.04;
// Not again before this, so a slow network does not keep it jumping.
const RESYNC_EVERY = 1500;
// A jump of who leads (section, loop, a click on the waveform): followed at once.
const JUMP = 0.25;
const HERE = /android/i.test(navigator.userAgent) ? 'questo dispositivo' : 'questo computer';
// Gone for this long while playing: the main computer stopped.
const GONE_AFTER = 2500;

/** Where who leads is now, from the last transport received: seconds of the song. */
export function hostPosition(t, at, rtt) {
  if (!t.playing || t.waiting) return t.position;
  return t.position + ((performance.now() - at + (rtt || 0) / 2) / 1000) * (t.rate || 1);
}

/**
 * Keeps this computer in step with who leads while it is the computer di riserva
 * (Impostazioni › Rete locale). Mounted once in the main window.
 */
export function useBackup({ settings, update, net, player, items, canDrive, notify }) {
  const on = !!settings.stageNet.backup && settings.stageNet.enabled && settings.followStage && !settings.driveStage;
  const last = useRef(null); // { t: transport, at }
  const lastSync = useRef(0);
  const loading = useRef({ id: null, at: 0 });
  const lead = useRef(0); // seconds this device starts late after a move (learned)
  const ctx = useRef({});
  ctx.current = { player, items, net, settings, update, canDrive, notify };

  // A new transport from who leads.
  const t = on && net.connected ? net.state?.transport : null;
  const stateAt = net.stateAt;
  useEffect(() => {
    if (t) last.current = { t, at: stateAt };
  }, [t, stateAt]);

  // In step: the same song, playing or not, at the same place.
  useEffect(() => {
    if (!on) return undefined;
    const tick = () => {
      const { player: p, items: its, net: n } = ctx.current;
      const l = last.current;
      if (!l || !n.connected) return;
      const { t: tr, at } = l;
      const s = engineStatus();
      const here = p.loaded?.itemId;
      if (tr.itemId && tr.itemId !== here) {
        // Another song on stage: this one too, at once (also while playing: the main one moved on).
        const item = its.find((i) => i.id === tr.itemId);
        const now = performance.now();
        if (item && !p.busy && (loading.current.id !== item.id || now - loading.current.at > 5000)) {
          loading.current = { id: item.id, at: now };
          p.load(item, { play: false });
        }
        return;
      }
      if (!tr.itemId) return;
      const target = hostPosition(tr, at, n.rtt);
      if (tr.playing && !tr.waiting && !s.playing) {
        engine.locate(target + lead.current);
        engine.play(false);
        lastSync.current = performance.now();
      } else if (!tr.playing && s.playing) {
        engine.stop();
        engine.locate(tr.position);
      } else if (!tr.playing && !s.playing && Math.abs(s.position - tr.position) > 0.5) {
        engine.locate(tr.position);
      } else if (tr.playing && s.playing && !s.waiting) {
        const drift = s.position - target;
        const jumped = Math.abs(drift) > JUMP;
        if (Math.abs(drift) > MAX_DRIFT && (jumped || performance.now() - lastSync.current > RESYNC_EVERY)) {
          // Still behind (or ahead) after the last move: this device takes that long to start
          // again from a new place; it is learned and the next move aims that much further.
          if (!jumped && performance.now() - lastSync.current < 6000) lead.current = Math.max(0, Math.min(0.25, lead.current - drift));
          engine.locate(target + lead.current);
          lastSync.current = performance.now();
        }
      }
    };
    const timer = setInterval(tick, 100);
    return () => clearInterval(timer);
  }, [on]);

  // The main computer gone while playing: go on, and lead the band if allowed.
  const connected = on && net.connected;
  const wasConnected = useRef(false);
  useEffect(() => {
    if (connected) {
      wasConnected.current = true;
      return undefined;
    }
    if (!on || !wasConnected.current) return undefined;
    wasConnected.current = false;
    const timer = setTimeout(() => {
      const { net: n, settings: st, update: up, canDrive: cd, notify: say } = ctx.current;
      if (n.connected) return;
      const playing = engineStatus().playing;
      if (st.stageNet.takeover && cd) {
        up({ driveStage: true, followStage: false });
        say?.(`Il computer principale non risponde: ${playing ? 'la musica continua da qui e ' : ''}${HERE} ora guida la band`, true);
      } else say?.(`Il computer principale non risponde${playing ? ': la musica continua da qui' : ''}`, true);
    }, GONE_AFTER);
    return () => clearTimeout(timer);
  }, [connected, on]);
}
