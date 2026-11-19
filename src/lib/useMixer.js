// Mixer of the song in the player (Dettaglio → Mixer, or its own window with F3,
// as Cubase's MixConsole), one strip per track of the multitrack. Volume, pan, role and instrument are
// saved with the song, and so is the channel section of each track (input gain
// and EQ, opened from the track name): they go into its draft (lib/drafts.js, "Salva" writes
// them for the whole band and the web), can be undone and come back on the
// next load. So does the mute of the tracks (the mix of the live performance); solo and a
// direct output stay on this computer, and so does the mute for who can't edit the song.
//
// The state is plain data and every command is an action object, so the
// mixer window (MixerWindow.jsx) drives the same model over Tauri events.
import { useEffect, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { automationOf, automationRead, clickMixOf, cueTrackOf, groupLabel, groupOptions, instrumentOf, muteAutomationOf, STEM_ROLES, stemsOf, VIDEO_AUDIO_ID, videoAudioStem } from '../shared/media.js';
import { hasAutomation, isWriting, releaseTouch, toggleRead, toggleWrite, useAutoWrite, writeMute, writeVolume } from './autoWrite';
import { channelActive, eqOf, flatEq, inputOf } from '../shared/eq.js';
import { editDraft, isDirty, saveDraft, savedMessage, useDrafts } from './drafts';
import { recordStep } from './arrangeHistory';
import { laneColor } from './lanes';
import { getMix, outputOptions, parseRoute, routeValue, setMix, useMix, useSettings } from './settings';
import { engine, useEngineStatus } from './engine';
import { clearStageMute, trackMuted } from './songMix';

export const MIXER_WINDOW = 'mixer';

/** F3 / mixer button: opens the mixer window, or closes it when open. */
export async function toggleMixerWindow() {
  const open = await WebviewWindow.getByLabel(MIXER_WINDOW);
  if (open) {
    await open.close();
    return;
  }
  // eslint-disable-next-line no-new
  new WebviewWindow(MIXER_WINDOW, { url: `index.html?view=${MIXER_WINDOW}`, title: 'LiveTools · Mixer', width: 1100, height: 440 });
}

// As in the Sequenze view of the setlist: the role decides the outputs, the instrument the rehearsal group.
const ROLE_OPTIONS = Object.entries(STEM_ROLES).map(([value, r]) => ({ value, label: r.label, hint: r.hint }));

export function useMixer({ player, lanes, canEdit: canEditSetlist, setlistId, notify }) {
  useMix(); // mute and outputs of this computer
  useDrafts();
  useAutoWrite(); // W of the channels
  const [settings, update] = useSettings(); // the system click: its volume, on/off and output are of this computer
  const playing = useEngineStatus((s) => s.playing);
  const channels = useEngineStatus((s) => s.device?.channels ?? 2);
  const [saving, setSaving] = useState(false);
  const song = player.loadedItem;
  const loaded = player.loaded?.itemId === song?.id ? player.loaded : null;
  const canEdit = !!song && canEditSetlist && song.songEditable !== false;
  const sheet = cueTrackOf(song);

  // Every track of the multitrack, in the order of the sequence (also those not
  // downloaded or not played), then the live cue track; values of the song, draft included.
  const index = new Map((loaded?.tracks || []).map((tr, i) => [tr.stem.id, i]));
  const live = loaded?.tracks.find((tr) => tr.stem.live)?.stem;
  // The sound of a video item, when it is loaded: its values are those of the video.
  const videoSound = index.has(VIDEO_AUDIO_ID) ? [videoAudioStem(song)] : [];
  const all = [...stemsOf(song), ...videoSound, ...(live ? [{ ...live, gain: sheet.gain, pan: sheet.pan, input: sheet.input, eq: sheet.eq, muted: sheet.muted }] : [])];
  const strips = all.map((stem) => {
    const m = getMix(stem.id);
    return {
      id: stem.id,
      name: stem.live ? 'Cues' : stem.name,
      file: stem.file || null,
      index: index.has(stem.id) ? index.get(stem.id) : -1,
      color: laneColor(lanes, stem),
      live: !!stem.live,
      // The sound of the video: role, instrument and automations stay as they are.
      video: stem.id === VIDEO_AUDIO_ID,
      role: stem.role || 'main',
      instrument: instrumentOf(stem),
      gain: Number(stem.gain) || 0,
      pan: Number(stem.pan) || 0,
      input: inputOf(stem),
      eq: eqOf(stem),
      // The channel section changes the sound (badge on the strip).
      channel: channelActive(stem),
      // The cue track has only the mute of the song (on after the mixdown).
      mute: trackMuted(stem, !canEdit),
      solo: !!player.solos[stem.id],
      route: m.route ? routeValue(m.route) : null,
      // Automations (R/W, as Cubase): the strip moves its fader and M with them while it plays.
      auto: stem.live ? [] : automationOf(stem),
      muteAuto: stem.live ? [] : muteAutomationOf(stem),
      hasAuto: !stem.live && hasAutomation(stem),
      read: !stem.live && automationRead(stem),
      write: !stem.live && stem.id !== VIDEO_AUDIO_ID && isWriting(stem.id),
    };
  });
  const songClick = clickMixOf(song);
  const changed = strips.some((s) => s.gain !== 0 || s.pan !== 0) || songClick.gain !== 0;
  const state = {
    song: song ? { id: song.id, title: song.title } : null,
    loaded: !!loaded,
    strips,
    outputs: outputOptions(channels),
    roles: ROLE_OPTIONS,
    instruments: groupOptions(stemsOf(song)), // Gruppo Rehearsal: built-in groups + those added
    canEdit,
    changed,
    dirty: !!song && isDirty(song.id),
    saving,
    // The system click (metronome of the engine), the same for every song.
    // gain and muted are the song's (saved with it, as a track's), on top of this device's volume and on/off.
    click: { enabled: settings.click.enabled, deviceDb: settings.click.gainDb, route: routeValue(settings.outputs.click), gain: songClick.gain, muted: songClick.muted },
  };

  // A fader drag is one undo step: begun on the first move, recorded on release.
  const pending = useRef(null);
  // kind 'media' (tracks, cue track, video) or 'item' (the click of the song).
  const write = (fields, label, live, kind = 'media') => {
    const before = Object.fromEntries(Object.keys(fields).map((k) => [k, song[k] ?? null]));
    editDraft(song.id, { [kind]: fields });
    const step = (b, a) => ({ label, before: { media: {}, item: {}, [kind]: b }, after: { media: {}, item: {}, [kind]: a } });
    if (live) {
      if (pending.current?.id !== song.id || pending.current.kind !== kind) {
        end();
        pending.current = { id: song.id, label, before, kind };
      }
      pending.current.after = fields;
      return;
    }
    pending.current = null;
    recordStep(song.id, step(before, fields));
  };
  const end = () => {
    const p = pending.current;
    pending.current = null;
    if (p) recordStep(p.id, { label: p.label, before: { media: {}, item: {}, [p.kind]: p.before }, after: { media: {}, item: {}, [p.kind]: p.after } });
  };
  const writeClick = (patch, label, live) => write({ clickMix: { ...clickMixOf(song), ...patch } }, label, live, 'item');
  const setStem = (id, patch, label, live) => {
    if (id === 'cues-live') {
      write({ cueTrack: { ...(song.cueTrack || {}), ...patch } }, label, live);
      return;
    }
    if (id === VIDEO_AUDIO_ID) {
      if (song.video) write({ video: { ...song.video, ...patch } }, label, live);
      return;
    }
    write({ stems: stemsOf(song).map((s) => (s.id === id ? { ...s, ...patch } : s)) }, label, live);
  };
  const stemOf = (id) => all.find((x) => x.id === id);
  // Playback stopped: the fader being written lets go.
  useEffect(() => {
    if (!playing) releaseTouch();
  }, [playing]);
  // Mute, solo, output: in the engine when the track is loaded, else only remembered here.
  const local = (stem, patch) => (index.has(stem.id) ? player.setTrack(stem, patch) : setMix(stem.id, patch));

  const dispatch = (a) => {
    const stem = stemOf(a.id);
    switch (a.type) {
      case 'gain':
        // W armed while it plays: the fader writes the volume automation.
        if (canEdit && stem && !stem.live && stem.id !== VIDEO_AUDIO_ID && writeVolume(song, stem, a.value)) break;
        if (canEdit && stem) setStem(a.id, { gain: Math.round(a.value * 10) / 10 }, `Volume ${stem.name}`, a.live);
        break;
      case 'pan':
        if (canEdit && stem) setStem(a.id, { pan: Math.round(a.value * 100) / 100 }, `Pan ${stem.name}`, a.live);
        break;
      case 'input':
        if (canEdit && stem) setStem(a.id, { input: Math.round(a.value * 10) / 10 }, `Gain ${stem.name}`, a.live);
        break;
      case 'eq':
        if (canEdit && stem) setStem(a.id, { eq: a.value || flatEq() }, `EQ ${stem.name}`, a.live);
        break;
      case 'end':
        releaseTouch();
        end();
        break;
      case 'role':
        if (canEdit && stem && !stem.live && stem.id !== VIDEO_AUDIO_ID) {
          setStem(a.id, { role: a.value }, `${stem.name} → ${STEM_ROLES[a.value]?.label || a.value}`, false);
          // Back on a role: the output follows it again.
          if (getMix(a.id).route) local(stem, { route: null });
        }
        break;
      case 'instrument':
        if (canEdit && stem && !stem.live && stem.id !== VIDEO_AUDIO_ID) setStem(a.id, { instrument: a.value }, `${stem.name} → ${groupLabel(a.value)}`, false);
        break;
      case 'route':
        if (stem) local(stem, { route: a.value ? parseRoute(a.value) : null });
        break;
      case 'read':
        if (canEdit && stem && !stem.live && stem.id !== VIDEO_AUDIO_ID) toggleRead(song, stem);
        break;
      case 'write':
        if (canEdit && stem && !stem.live && stem.id !== VIDEO_AUDIO_ID) toggleWrite(song, stem);
        break;
      case 'mute':
        if (canEdit && stem && !stem.live && stem.id !== VIDEO_AUDIO_ID && writeMute(song, stem)) break;
        if (stem) {
          // M here: the mute of the Palco on the track goes; only the song's (or this computer's) stays.
          const on = !trackMuted(stem, !canEdit);
          clearStageMute(stem);
          if (stem.live && !canEdit) break;
          if (canEdit && !!stem.muted === on) engine.setTrack(stem.id, { mute: on });
          else if (stem.live) setStem(a.id, { muted: on }, on ? 'Traccia cue mutata' : 'Traccia cue riattivata', false);
          else if (canEdit) setStem(a.id, { muted: on }, `${on ? 'Mutata' : 'Riattivata'} “${stem.name}”`, false);
          else local(stem, { mute: on });
        }
        break;
      case 'solo':
        if (stem && index.has(stem.id)) player.setTrack(stem, { solo: !player.solos[stem.id] });
        break;
      case 'reset': {
        if (!canEdit || !song) break;
        const media = { stems: stemsOf(song).map((s) => ({ ...s, gain: 0, pan: 0 })) };
        if (song.cueTrack) media.cueTrack = { ...song.cueTrack, gain: 0, pan: 0 };
        if (song.video && index.has(VIDEO_AUDIO_ID)) media.video = { ...song.video, gain: 0, pan: 0 };
        write(media, 'Volumi ripristinati', false);
        if (songClick.gain !== 0) writeClick({ gain: 0 }, 'Volume del click ripristinato', false);
        notify(`“${song.title}”: volumi a 0 dB e pan al centro. “Salva” per tenerli, Ctrl+Z nell’Arrangement per annullare`);
        break;
      }
      case 'save':
        if (!song || !isDirty(song.id) || saving) break;
        setSaving(true);
        saveDraft(setlistId, song)
          .then((res) => notify(savedMessage(song.title, res)))
          .catch((e) => notify(`“${song.title}” non salvato: ${e.message || e}`, true))
          .finally(() => setSaving(false));
        break;
      // Volume and M of the click strip are the song's (draft, Salva); who can't edit it turns the click of this device on and off.
      case 'clickGain':
        if (canEdit) writeClick({ gain: Math.round(a.value * 10) / 10 }, 'Volume del click', a.live);
        break;
      case 'clickMute':
        if (canEdit) writeClick({ muted: !songClick.muted }, songClick.muted ? 'Click riattivato nel brano' : 'Click mutato nel brano', false);
        else update((s) => ({ click: { ...s.click, enabled: !s.click.enabled } }));
        break;
      case 'clickToggle':
        update((s) => ({ click: { ...s.click, enabled: !s.click.enabled } }));
        break;
      case 'clickRoute': {
        const r = parseRoute(a.value);
        if (r) update((s) => ({ outputs: { ...s.outputs, click: r } }));
        break;
      }
      case 'play':
        player.toggle(song);
        break;
      case 'window':
        toggleMixerWindow();
        break;
      default:
    }
  };

  return { state, dispatch };
}

/** Main window: the model sent to the mixer window, and its commands applied here. */
export function useMixerBridge(mixer) {
  const ref = useRef(mixer);
  ref.current = mixer;
  const json = JSON.stringify(mixer.state);
  useEffect(() => {
    emit('mixer-state', JSON.parse(json));
  }, [json]);
  useEffect(() => {
    const offs = [
      listen('mixer-hello', () => emit('mixer-state', ref.current.state)),
      listen('mixer-action', (e) => ref.current.dispatch(e.payload)),
    ];
    return () => offs.forEach((p) => p.then((f) => f()));
  }, []);
}
