// Mixer of the song in the player (Dettaglio → Mixer, or its own window with F3,
// as Cubase's MixConsole), one strip per track of the multitrack. Volume, pan, role and instrument are
// saved with the song, and so is the channel section of each track (input gain
// and EQ, opened from the track name): they go into its draft (lib/drafts.js, "Salva" writes
// them for the whole band and the web), can be undone and come back on the
// next load. Mute, solo and a direct output stay on this computer.
//
// The state is plain data and every command is an action object, so the
// mixer window (MixerWindow.jsx) drives the same model over Tauri events.
import { useEffect, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { cueTrackOf, instrumentOf, INSTRUMENTS, rehearsalGroup, STEM_ROLES, stemsOf } from '../shared/media.js';
import { channelActive, eqOf, flatEq, inputOf } from '../shared/eq.js';
import { editDraft, isDirty, saveDraft, useDrafts } from './drafts';
import { recordStep } from './arrangeHistory';
import { laneColor } from './lanes';
import { getMix, outputOptions, parseRoute, routeValue, setMix, useMix } from './settings';
import { useEngineStatus } from './engine';

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
const INSTRUMENT_OPTIONS = Object.entries(INSTRUMENTS).map(([value, label]) => ({ value, label }));

export function useMixer({ player, lanes, canEdit: canEditSetlist, setlistId, notify }) {
  useMix(); // mute and outputs of this computer
  useDrafts();
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
  const all = [...stemsOf(song), ...(live ? [{ ...live, gain: sheet.gain, pan: sheet.pan, input: sheet.input, eq: sheet.eq, muted: sheet.muted }] : [])];
  const strips = all.map((stem) => {
    const m = getMix(stem.id);
    return {
      id: stem.id,
      name: stem.live ? 'Cues' : stem.name,
      file: stem.file || null,
      index: index.has(stem.id) ? index.get(stem.id) : -1,
      color: laneColor(lanes, stem),
      live: !!stem.live,
      role: stem.role || 'main',
      instrument: instrumentOf(stem),
      gain: Number(stem.gain) || 0,
      pan: Number(stem.pan) || 0,
      input: inputOf(stem),
      eq: eqOf(stem),
      // The channel section changes the sound (badge on the strip).
      channel: channelActive(stem),
      // The cue track has only the mute of the song (on after the mixdown).
      mute: stem.live ? !!stem.muted : (m.mute ?? !!stem.muted),
      solo: !!player.solos[stem.id],
      out: !!player.leftOut[rehearsalGroup(stem)],
      route: m.route ? routeValue(m.route) : null,
    };
  });
  const changed = strips.some((s) => s.gain !== 0 || s.pan !== 0);
  const state = {
    song: song ? { id: song.id, title: song.title } : null,
    loaded: !!loaded,
    strips,
    outputs: outputOptions(channels),
    roles: ROLE_OPTIONS,
    instruments: INSTRUMENT_OPTIONS,
    canEdit,
    changed,
    dirty: !!song && isDirty(song.id),
    saving,
  };

  // A fader drag is one undo step: begun on the first move, recorded on release.
  const pending = useRef(null);
  const write = (media, label, live) => {
    const before = Object.fromEntries(Object.keys(media).map((k) => [k, song[k] ?? null]));
    editDraft(song.id, { media });
    if (live) {
      if (pending.current?.id !== song.id) pending.current = { id: song.id, label, before };
      pending.current.after = media;
      return;
    }
    pending.current = null;
    recordStep(song.id, { label, before: { media: before, item: {} }, after: { media, item: {} } });
  };
  const end = () => {
    const p = pending.current;
    pending.current = null;
    if (p) recordStep(p.id, { label: p.label, before: { media: p.before, item: {} }, after: { media: p.after, item: {} } });
  };
  const setStem = (id, patch, label, live) => {
    if (id === 'cues-live') {
      write({ cueTrack: { ...(song.cueTrack || {}), ...patch } }, label, live);
      return;
    }
    write({ stems: stemsOf(song).map((s) => (s.id === id ? { ...s, ...patch } : s)) }, label, live);
  };
  const stemOf = (id) => all.find((x) => x.id === id);
  // Mute, solo, output: in the engine when the track is loaded, else only remembered here.
  const local = (stem, patch) => (index.has(stem.id) ? player.setTrack(stem, patch) : setMix(stem.id, patch));

  const dispatch = (a) => {
    const stem = stemOf(a.id);
    switch (a.type) {
      case 'gain':
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
        end();
        break;
      case 'role':
        if (canEdit && stem && !stem.live) {
          setStem(a.id, { role: a.value }, `${stem.name} → ${STEM_ROLES[a.value]?.label || a.value}`, false);
          // Back on a role: the output follows it again.
          if (getMix(a.id).route) local(stem, { route: null });
        }
        break;
      case 'instrument':
        if (canEdit && stem && !stem.live) setStem(a.id, { instrument: a.value }, `${stem.name} → ${INSTRUMENTS[a.value] || a.value}`, false);
        break;
      case 'route':
        if (stem) local(stem, { route: a.value ? parseRoute(a.value) : null });
        break;
      case 'mute':
        if (stem?.live) {
          if (canEdit) setStem(a.id, { muted: !stem.muted }, stem.muted ? 'Traccia cue riattivata' : 'Traccia cue mutata', false);
        } else if (stem) local(stem, { mute: !(getMix(stem.id).mute ?? !!stem.muted) });
        break;
      case 'solo':
        if (stem && index.has(stem.id)) player.setTrack(stem, { solo: !player.solos[stem.id] });
        break;
      case 'reset': {
        if (!canEdit || !song) break;
        const media = { stems: stemsOf(song).map((s) => ({ ...s, gain: 0, pan: 0 })) };
        if (song.cueTrack) media.cueTrack = { ...song.cueTrack, gain: 0, pan: 0 };
        write(media, 'Volumi ripristinati', false);
        notify(`“${song.title}”: volumi a 0 dB e pan al centro. “Salva” per tenerli, Ctrl+Z nell’Arrangement per annullare`);
        break;
      }
      case 'save':
        if (!song || !isDirty(song.id) || saving) break;
        setSaving(true);
        saveDraft(setlistId, song)
          .then(() => notify(`Salvato “${song.title}”`))
          .catch((e) => notify(`“${song.title}” non salvato: ${e.message || e}`, true))
          .finally(() => setSaving(false));
        break;
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
