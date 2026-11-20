// Telecomando, the computer side (src-tauri/src/remote.rs, lib/remote.js): with
// Impostazioni › Rete locale › Telecomando on, a phone or tablet on the same Wi-Fi
// drives this computer. It gets what the computer shows (setlist, song, sections,
// transport, the output windows) and sends the commands that a click would give.
import { useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isSeparator } from '../shared/setlists.js';
import { compareGroups, groupLabel, rehearsalGroup } from '../shared/media.js';
import { engine, engineStatus, subscribeStatus } from './engine';
import { getMix, useMix } from './settings';
import { buildLanes, laneColor } from './lanes';
import { groupMixKey } from './usePlayer';
import { prompterShare } from './cues';
import { jumpToSection, sectionIndexAt, songBeats, songSections } from './sections';
import { newRemoteCode, onRemoteMessage, useRemoteState } from './remote';

const clampDb = (db) => Math.min(6, Math.max(-60, Math.round(db * 2) / 2));
const same = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-3;

function groupsOf(tracks) {
  const by = new Map();
  tracks.forEach(({ stem }) => {
    const g = rehearsalGroup(stem);
    if (!by.has(g)) by.set(g, []);
    by.get(g).push(stem.id);
  });
  return [...by].sort((a, b) => compareGroups(a[0], b[0]));
}

const publish = (key, value) => invoke('remote_publish', { key, value }).catch(() => {});

/**
 * Mounted once in the main window of the desktop. `prompter`: the Gobbo of the song in the
 * player (usePrompterOutput), for the Leggio of the remote. `outputs`: { video, prompter } open now;
 * `toggleOutput(kind)` opens or closes the window.
 */
export function useRemoteHost({ settings, update, chooseSetlist, mixer, setlist, setlists, items, player, prompter, outputs, toggleOutput, notify, user }) {
  const remote = useRemoteState();
  useMix(); // volumes of the groups and track mutes of this computer
  const opts = settings.remote;
  const on = !!opts.enabled;
  const name = user?.displayName || user?.email || 'LiveTools';

  // A code the first time it is turned on.
  useEffect(() => {
    if (on && !opts.code) update((s) => ({ remote: { ...s.remote, code: newRemoteCode() } }));
  }, [on, opts.code, update]);

  const info = JSON.stringify({ name, code: opts.code || '' });
  const started = useRef(false);
  useEffect(() => {
    if (!on || !opts.code) return undefined;
    started.current = true;
    return () => {
      started.current = false;
      invoke('remote_host', { info: null }).catch(() => {});
    };
  }, [on, opts.code]);
  useEffect(() => {
    if (on && opts.code) invoke('remote_host', { info: JSON.parse(info) }).catch((e) => notify?.(`Telecomando: ${e?.message || e}`, true));
  }, [on, opts.code, info, notify]);

  // Who comes and goes, on the status bar.
  const known = useRef(null);
  useEffect(() => {
    if (!remote.hosting) {
      known.current = null;
      return;
    }
    const names = remote.peers.map((p) => p.name || p.addr);
    if (known.current) {
      names.filter((n) => !known.current.includes(n)).forEach((n) => notify?.(`Telecomando collegato: ${n}`));
      known.current.filter((n) => !names.includes(n)).forEach((n) => notify?.(`Telecomando scollegato: ${n}`));
    }
    known.current = names;
  }, [remote.hosting, remote.peers, notify]);

  // ---------- What the remote shows ----------

  const loaded = player.loaded;
  const song = player.loadedItem;
  const beats = useMemo(() => songBeats(loaded?.tempo, loaded?.duration || 0), [loaded?.tempo, loaded?.duration]);
  const sections = useMemo(() => songSections(song, beats, loaded?.duration || 0), [song, beats, loaded?.duration]);
  const groups = useMemo(() => groupsOf(loaded?.tracks || []), [loaded?.tracks]);
  const firstStem = useMemo(() => new Map((loaded?.tracks || []).map(({ stem }) => [rehearsalGroup(stem), stem]).reverse()), [loaded?.tracks]);
  const hosting = remote.hosting;

  const songs = useMemo(() => items.filter((i) => !isSeparator(i)), [items]);
  const lanes = useMemo(() => buildLanes(songs), [songs]);
  const list = useMemo(() => {
    let n = 0;
    return items.map((i) =>
      isSeparator(i) ? { id: i.id, sep: true, title: i.title || '' } : { id: i.id, n: ++n, title: i.title || 'Senza titolo', artist: i.artist || '', key: i.key || '', bpm: i.bpm || null },
    );
  }, [items]);

  useEffect(() => {
    if (!hosting) return;
    publish('setlist', {
      id: setlist?.id || null,
      title: setlist?.title || '',
      setlists: (setlists || []).map((s) => ({ id: s.id, title: s.title || 'Senza titolo' })),
      items: list,
    });
  }, [hosting, setlist?.id, setlist?.title, setlists, list]);

  // The groups of the Palco mixer: volume (this computer), mute of their tracks (as the Arrangement), solo.
  const groupList = JSON.stringify(
    groups.map(([g, ids]) => {
      const m = player.groupMute(g);
      return { id: g, label: groupLabel(g), color: firstStem.get(g) ? laneColor(lanes, firstStem.get(g)) : null, gain: getMix(groupMixKey(g)).gainDb || 0, muted: m.muted, total: m.total, out: m.total > 0 && m.muted === m.total, solo: ids.every((id) => player.solos[id]) };
    }),
  );
  useEffect(() => {
    if (!hosting) return;
    publish('song', {
      loadedId: loaded?.itemId || null,
      title: song?.title || '',
      artist: song?.artist || '',
      key: song?.key || '',
      bpm: loaded?.tempo?.bpm || song?.bpm || null,
      timeSig: loaded?.tempo?.timeSig || song?.timeSig || null,
      busy: player.busy || null,
      sections: sections.map((s) => ({ label: s.label, color: s.color, start: s.start, end: s.end })),
      groups: JSON.parse(groupList),
    });
  }, [hosting, loaded?.itemId, loaded?.tempo, song, player.busy, sections, groupList]);

  // The whole Mixer of the song (as the Arrangement's, lib/useMixer.js), for its screen on the remote.
  // The automation curves stay here: the remote does not follow them while playing.
  const mixerJson = JSON.stringify(mixer ? { ...mixer.state, strips: mixer.state.strips.map((x) => ({ ...x, auto: [], muteAuto: [] })) } : null);
  useEffect(() => {
    if (hosting) publish('mixer', JSON.parse(mixerJson));
  }, [hosting, mixerJson]);

  // The fixed strips of the Palco mixer: master, metronome, pad (this computer).
  useEffect(() => {
    if (!hosting) return;
    publish('mix', { master: settings.masterDb || 0, click: settings.click.gainDb || 0, pad: settings.pad?.gainDb ?? -10 });
  }, [hosting, settings.masterDb, settings.click.gainDb, settings.pad?.gainDb]);

  useEffect(() => {
    if (!hosting) return;
    publish('controls', {
      view: settings.view,
      page: settings.page,
      video: !!outputs.video,
      prompter: !!outputs.prompter,
      click: !!settings.click.enabled,
      eighths: !!settings.click.eighths,
      countIn: !!settings.countIn,
      autoAdvance: !!settings.autoAdvance,
      pad: !!player.padOn,
      followStage: !!settings.followStage,
      driveStage: !!settings.driveStage,
    });
  }, [hosting, settings.view, settings.page, outputs.video, outputs.prompter, settings.click.enabled, settings.click.eighths, settings.countIn, settings.autoAdvance, player.padOn, settings.followStage, settings.driveStage]);

  // The Gobbo, for the Leggio of the remote: sent when the song or its slides change (the remote places it on the transport).
  const share = JSON.stringify(prompterShare(prompter));
  useEffect(() => {
    if (hosting) publish('prompter', JSON.parse(share));
  }, [hosting, share]);

  // The transport: on every change, on a jump and 4 times a second while playing (the remote moves the clock in between).
  useEffect(() => {
    if (!hosting) return undefined;
    let last = null;
    const send = (s) => {
      const t = {
        playing: !!s.playing,
        waiting: !!s.waiting,
        position: s.position || 0,
        duration: s.duration || 0,
        rate: s.rate || 1,
        bar: s.bar,
        beat: s.beat,
        beats: s.beats,
        jump: s.jump ? { at: s.jump.at, to: s.jump.to, repeat: !!s.jump.repeat } : null,
        fadeDown: (s.fadeTarget ?? 1) < 0.5,
        songId: s.songId || null,
      };
      publish('transport', t);
      last = { ...t, t: performance.now() };
    };
    send(engineStatus());
    return subscribeStatus((s) => {
      const now = performance.now();
      const expected = last.playing && !last.waiting ? last.position + ((now - last.t) / 1000) * last.rate : last.position;
      const changed =
        !!s.playing !== last.playing ||
        !!s.waiting !== last.waiting ||
        (s.duration || 0) !== last.duration ||
        JSON.stringify(s.jump ? { at: s.jump.at, to: s.jump.to, repeat: !!s.jump.repeat } : null) !== JSON.stringify(last.jump) ||
        ((s.fadeTarget ?? 1) < 0.5) !== last.fadeDown ||
        (s.songId || null) !== last.songId;
      const jumped = Math.abs((s.position || 0) - expected) > 0.25;
      if (changed || jumped || (s.playing && now - last.t > 250)) send(s);
    });
  }, [hosting]);

  // ---------- Commands ----------

  const ctx = useRef({});
  ctx.current = { settings, update, chooseSetlist, mixer, player, songs, sections, beats, toggleOutput, notify };
  useEffect(
    () =>
      onRemoteMessage((m) => {
        const c = ctx.current;
        if (m.t === 'denied') {
          c.notify?.(`Telecomando: ${m.name || m.addr} ha provato a collegarsi con un codice sbagliato`, true);
          return;
        }
        const a = m.args || {};
        const st = engineStatus();
        const p = c.player;
        const s = c.settings;
        switch (m.cmd) {
          case 'play':
            p.toggle(p.loadedItem || c.songs[0]);
            break;
          case 'stop':
            p.stop();
            break;
          case 'prev':
            p.step(-1);
            break;
          case 'next':
            p.step(1);
            break;
          case 'back':
            if (!st.playing) engine.locate(0);
            break;
          case 'load': {
            const it = c.songs.find((i) => i.id === a.itemId);
            if (!it) break;
            if (a.play) p.launch(it);
            else p.load(it);
            break;
          }
          case 'section': {
            const sec = c.sections[a.index];
            if (!sec) break;
            if (same(st.jump?.to, sec.start)) engine.cancelJump();
            else jumpToSection(sec, s.jumpQuant, c.beats, c.sections);
            break;
          }
          case 'loop': {
            const cur = c.sections[sectionIndexAt(c.sections, Math.max(0, st.position))];
            const infinite = !!a.infinite;
            const isOn = infinite ? !!st.jump?.repeat : !!cur && !st.jump?.repeat && same(st.jump?.to, cur.start) && same(st.jump?.at, cur.end);
            if (isOn) engine.cancelJump();
            else if (cur) engine.scheduleJump({ at: cur.end, to: cur.start, repeat: infinite });
            break;
          }
          case 'cancel':
            engine.cancelJump();
            break;
          case 'fade':
            p.toggleFade();
            break;
          case 'pad':
            p.togglePad();
            break;
          case 'click':
            c.update({ click: { ...s.click, enabled: !s.click.enabled } });
            break;
          case 'eighths':
            c.update({ click: { ...s.click, eighths: !s.click.eighths } });
            break;
          case 'countIn':
            c.update({ countIn: !s.countIn });
            break;
          case 'autoAdvance':
            c.update({ autoAdvance: !s.autoAdvance });
            break;
          case 'output':
            if (a.kind === 'video' || a.kind === 'prompter') c.toggleOutput(a.kind);
            break;
          case 'view':
            if (['stage', 'arrangement', 'prompter', 'score'].includes(a.view)) c.update({ page: 'live', view: a.view });
            break;
          case 'setlist':
            if (a.id && !st.playing) (c.chooseSetlist || ((id) => c.update({ setlistId: id })))(a.id);
            break;
          case 'groupOut': // remotes before the mute of the tracks
            if (a.group) p.toggleGroup(a.group);
            break;
          case 'groupMute':
            if (a.group) p.setGroupMute(a.group, !!a.on);
            break;
          case 'groupGain':
            if (a.group && Number.isFinite(a.db)) p.setGroup(a.group, { gainDb: clampDb(a.db) });
            break;
          case 'master':
            if (Number.isFinite(a.db)) c.update({ masterDb: clampDb(a.db) });
            break;
          case 'clickGain':
            if (Number.isFinite(a.db)) c.update({ click: { ...s.click, gainDb: clampDb(a.db) } });
            break;
          case 'padGain':
            if (Number.isFinite(a.db)) c.update({ pad: { ...s.pad, gainDb: clampDb(a.db) } });
            break;
          case 'mixer':
            // An action of the Mixer screen of the remote, as from the Mixer window (F3).
            if (a.action?.type && !['window', 'play'].includes(a.action.type)) c.mixer?.dispatch(a.action);
            break;
          case 'groupSolo':
            if (a.group) p.setGroup(a.group, { solo: !!a.on });
            break;
          default:
        }
      }),
    [],
  );

  return remote;
}
