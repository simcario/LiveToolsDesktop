// The player: loads a song of the setlist into the Rust engine (downloading
// its media first), applies the local mix and the output matrix, drives the
// transport and, when asked, the band ("Guida la band").
import { useCallback, useEffect, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { convertFileSrc } from '@tauri-apps/api/core';
import { audioFades, clickMixOf, clickMuteSpans, clickVolumeOf, cueTrackOf, fadeStop, isVideoItem, padHoldOf, padLeadOf, playedAutomation, regionsOf, rehearsalGroup, stemsOf, VIDEO_AUDIO_ID, videoAudioStem, videoFades, videoOf } from '../shared/media.js';
import { tempoSections } from '../shared/tempoMap.js';
import { clearStageMute, setStageMute, trackMuted, writeMix } from './songMix';
import { isSeparator } from '../shared/setlists.js';
import { eqOf, inputOf } from '../shared/eq.js';
import { dbToGain, engine, engineStatus, onSongEnded, onStretchProgress, subscribeStatus } from './engine';
import { driveStage } from './data';
import { editDraft } from './drafts';
import { setNdiStill, setNdiVideoSource } from './ndi';
import { liveCueLocal, liveCuePlan, makeLiveCues } from './cueTrack';
import { ensureFile, missingFiles, requestPeaks } from './mediaCache';
import { clickVoice, getMix, setMix } from './settings';
import { GRID_KEY } from './arrange';
import { analyze, getSyncChoice, gridUnsure, rangeKey, resolveSource, setSyncChoice, syncSpec } from './sync';
import { beatMapOf, publishBeatMap } from './beatMap';
import { midiTargeted, sendSongMidi } from './midi';
import { isLinked, keepsPitch, keyPitch, playedKey, songChange, transitionOf, transitionPlan } from './songChange';

function routeOf(stem, settings) {
  return getMix(stem.id).route || settings.outputs[stem.role || 'main'] || settings.outputs.main;
}

// The mix of the live performance is saved with the song by who can edit it (draft,
// "Salva"): volume and pan (Mixer), mute of the tracks (stems[].muted), automation.
// The others keep their own track mutes on this computer, as before.
const editableSong = (item, canEdit) => !!item && !!canEdit && item.songEditable !== false;

// Mix context of a song: { local } (local = the track mutes of this computer).
const mixOf = (song, canEdit) => ({ local: !editableSong(song, canEdit) });

// The mute of a track: one state for the Arrangement, the Mixer and the Palco (see songMix.js trackMuted).
const isMuted = trackMuted;

// Volume of a rehearsal group (Palco mixer), on this computer: added to that of each of its tracks.
export const groupMixKey = (group) => `group:${group}`;
const groupGain = (stem) => getMix(groupMixKey(rehearsalGroup(stem))).gainDb || 0;
// Volume and pan of a track are those saved with the song (Mixer, "Salva"):
// the same on every computer and on the web. Mute, solo and the output stay local.
const ownGain = (stem) => Number(stem.gain) || 0;

// mix: { local } (see mixOf).
function trackMix(stem, settings, solo, mix) {
  const route = routeOf(stem, settings);
  return {
    gainDb: ownGain(stem) + groupGain(stem),
    pan: Number(stem.pan) || 0,
    // Channel section (Mixer → click on the track name), saved with the song too.
    inputDb: inputOf(stem),
    eq: eqOf(stem),
    mute: isMuted(stem, mix?.local),
    solo: !!solo,
    outStart: route.start,
    outMode: route.mode,
    // Volume automation of the Arrangement with the mute automation in it, if the R of
    // the channel is on ([] clears it in the engine).
    auto: playedAutomation(stem).map((p) => [p.t, p.db]),
  };
}

/** Count-in bars: one value for every song (Impostazioni → Trasporto → Precount). */
export const countInOf = (settings) => Number(settings.defaultCountIn) || 0;

// The tracks the cues of a song are heard from: the live one made from the
// cue sheet, and the "Cues" stem of the mixdown (an audio track as the others).
const renderedCuesId = (item) => stemsOf(item).find((s) => s.generated === 'cues')?.id ?? null;
const cueKeyOf = (item) => `${liveCuePlan(item)?.stem.path ?? ''}|${renderedCuesId(item) ?? ''}`;

const num = (v) => (Number(v) > 0 ? Number(v) : null);

// Length of a video file (seconds) from its metadata, null when it can't be read.
function videoLength(src) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    let done = false;
    const finish = (d) => {
      if (done) return;
      done = true;
      v.removeAttribute('src');
      v.load();
      resolve(d);
    };
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => finish(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => finish(null);
    setTimeout(() => finish(null), 10000);
    v.src = src;
  });
}

// The sections for the tempo map, cut by the tempo changes of the song (shared/tempoMap.js) when it has any.
const sectionSpecs = (item) =>
  (tempoSections(item) || item.sections || []).map((s) => ({
    label: s.label || null,
    bars: num(s.bars),
    bpm: num(s.bpm),
    timeSig: s.timeSig || null,
    ramp: s.ramp || null,
  }));

function songSpec(item, tracks, settings) {
  return {
    id: item.id,
    tracks,
    // The tempo typed in the Arrangement (grid.bpm) keeps its decimals.
    bpm: num(item.grid?.bpm) || num(item.bpm),
    timeSig: item.timeSig || null,
    countInBars: countInOf(settings),
    sections: sectionSpecs(item),
    clickMute: clickMuteOf(item),
    clickAuto: clickVolumeSpec(item),
  };
}

// Spans where the click of the song is silent, for the engine (to the end = far away).
const clickMuteOf = (item) => clickMuteSpans(item).map((s) => [s.from, Number.isFinite(s.to) ? s.to : 1e9]);
// Volume automation of the click, for the engine: [second, dB].
const clickVolumeSpec = (item) => clickVolumeOf(item).map((p) => [p.t, p.db]);

// Analyses the reference stem chosen for the grid (click or rhythm).
async function analyzeSource(item, available, choice, setBusy) {
  const src = resolveSource(
    available.map((a) => a.stem),
    choice,
  );
  const range = rangeKey(item);
  if (!src) return { choice, source: null, analysis: null, error: null, range };
  const source = { id: src.stem.id, name: src.stem.name, mode: src.mode };
  setBusy(`Allineo “${item.title}” a “${src.stem.name}”…`);
  try {
    const local = available.find((a) => a.stem.id === src.stem.id).local;
    return { choice, source, analysis: await analyze(item, src, local), error: null, range };
  } catch (e) {
    return { choice, source, analysis: null, error: String(e?.message || e), range };
  }
}
// Placement of the grid's reference stem, when it was moved or cut (as it
// was before the edits by hand, see lib/arrange.js GRID_KEY).
const refRegions = (item, sync) => {
  if (!sync?.source) return null;
  const all = regionsOf(item);
  const kept = all[GRID_KEY];
  return kept?.stemId === sync.source.id ? kept.regions : all[sync.source.id] || null;
};

// The automatic grid is doubtful: where it comes from and what to do.
const unsureText = (item, sync) =>
  `Griglia di “${item.title}” incerta (${Math.round(sync.analysis.confidence * 100)}%, da “${sync.source?.name}”): il click potrebbe non cadere a tempo. Controllala nell’Arrangement e fissala a mano se serve`;

// lanLive: the song on stage from the local network (lib/stageNet.js), ahead of setlist.live while connected.
export function usePlayer({ user, setlist, items, settings, canDrive, canEdit, notify, lanLive = null }) {
  const [loaded, setLoaded] = useState(null); // { itemId, duration, tempo, tracks: [{ stem, local, info, error }], video }
  const [busy, setBusy] = useState(null);
  const [downloading, setDownloading] = useState(null); // files of the song being loaded, not on disk yet
  const [solos, setSolos] = useState({});
  const token = useRef(0);
  // The next song prepared for a transition: { itemId, prepared, item } once the engine has it.
  const queued = useRef(null);
  const queueToken = useRef(0);
  const [padOn, setPadOn] = useState(false);
  // Pad of a video item that ends in the next song (padHold): { from, into, hold, fadeOut },
  // and the release of that fade out while it goes.
  const padHold = useRef(null);
  const [padRelease, setPadRelease] = useState(null);
  const ctx = useRef({});
  const midiSent = useRef(null); // song whose patches went out last
  const songNow = items.find((i) => i.id === loaded?.itemId) || null;
  ctx.current = { setlist, items, settings, canDrive, canEdit, user, loaded, solos };
  // Mix context of a song (the loaded one or the next).
  const mixFor = (item) => mixOf(item, ctx.current.canEdit);

  // Everything a song needs before the engine: files on disk, grid, live cues,
  // stems in another key or tempo. `send(spec)` gives it to the engine (load or
  // queue as the next song); null when `alive()` turns false on the way.
  const prepare = useCallback(async (item, { send, alive, ui }) => {
    const { settings: st } = ctx.current;
    const mix = mixFor(item);
    // The cue sheet is played from a local track (muted with the cue track).
    const cuePlan = liveCuePlan(item);
    const stems = stemsOf(item);
    const video = videoOf(item);
    const toFetch = missingFiles([...stems, ...(video ? [video] : [])].map((m) => ({ path: m.path, size: m.size })));
    ui.setDownloading(toFetch.length ? toFetch : null);
    if (stems.length || video) ui.setBusy(`${toFetch.length ? 'Scarico' : 'Preparo'} “${item.title}”…`);
    const locals = await Promise.all(stems.map((s) => ensureFile({ path: s.path, size: s.size })));
    const videoLocal = video ? await ensureFile({ path: video.path, size: video.size }) : null;
    if (alive() && toFetch.length) {
      ui.setDownloading(null);
      ui.setBusy(`Preparo “${item.title}”…`);
    }
    let cueLocal = cuePlan ? await liveCueLocal(cuePlan).catch(() => null) : null;
    if (!alive()) return null;
    const available = stems.map((stem, i) => ({ stem, local: locals[i] })).filter((x) => x.local);
    const missing = stems.length - available.length;
    const placed = regionsOf(item);
    const change = songChange(item);
    const specOf = ({ stem, local }) => ({ id: stem.id, path: local, name: stem.name, regions: placed[stem.id] || [], ...trackMix(stem, st, false, mix) });
    const spec = { ...songSpec(item, available.map(specOf), st), rate: change.rate };
    const sync = await analyzeSource(item, available, getSyncChoice(item.id), ui.setBusy);
    if (!alive()) return null;
    spec.sync = syncSpec(item, sync.analysis, sync.choice, refRegions(item, sync));
    // Video item: its sound is a track read from the video file, with its fades and end
    // (the ones of the picture unless set apart); the song lasts as the longer of
    // picture and sound, with or without sound.
    const fades = isVideoItem(item) ? videoFades(item) : null;
    if (fades && videoLocal) {
      const at = Number(video.offset) || 0;
      const sound = audioFades(item);
      const stem = videoAudioStem(item);
      available.push({ stem, local: videoLocal });
      spec.tracks = [...spec.tracks, { ...specOf({ stem, local: videoLocal }), regions: [{ at, from: 0, len: sound.end, fadeIn: sound.in, fadeOut: sound.out }] }];
      const length = await videoLength(convertFileSrc(videoLocal));
      if (!alive()) return null;
      if (length) spec.length = at + Math.max(fadeStop(fades, length), fadeStop(sound, length));
    }
    const withCues = () => {
      if (!cueLocal) return;
      const cue = { stem: cuePlan.stem, local: cueLocal };
      available.push(cue);
      spec.tracks = [...spec.tracks, specOf(cue)];
    };
    // Key or tempo changed: the engine plays files rendered once (cached on disk);
    // the waveforms and every time stay those of the original files.
    const stretch = async () => {
      if (!change.changed) return spec;
      const stemOf = new Map(available.map((a) => [a.stem.id, a.stem]));
      const off = onStretchProgress(({ done, total }) => ui.setBusy(`Cambio ${change.semitones ? 'tonalità' : 'tempo'} di “${item.title}”: ${done}/${total}…`));
      ui.setBusy(`Cambio ${change.semitones ? 'tonalità' : 'tempo'} di “${item.title}”…`);
      try {
        const res = await engine.stretchTracks(spec.tracks.map((tr) => ({ path: tr.path, semitones: keepsPitch(stemOf.get(tr.id) || {}) ? 0 : change.semitones, rate: change.rate })));
        const failed = res.filter((r) => r.error);
        if (failed.length) throw new Error(failed[0].error);
        return { ...spec, tracks: spec.tracks.map((tr, i) => ({ ...tr, path: res[i].path })) };
      } finally {
        off();
      }
    };
    withCues();
    let result = await send(await stretch());
    if (!alive()) return null;
    // First load after a change of the cues: the track needs the tempo map.
    if (cuePlan && !cueLocal && result.tempo && result.duration > 0) {
      ui.setBusy(`Creo le cue di “${item.title}”…`);
      cueLocal = await makeLiveCues(cuePlan, result.tempo, result.duration).catch((e) => {
        notify(`Cue non create: ${e?.message || e}`, true);
        return null;
      });
      if (!alive()) return null;
      if (cueLocal) {
        withCues();
        result = await send(await stretch());
        if (!alive()) return null;
      }
    }
    return {
      missing,
      state: {
        itemId: item.id,
        duration: result.duration,
        tempo: result.tempo,
        rate: change.rate,
        change: `${change.semitones}:${change.rate}`,
        // A video without sound has no track to show.
        tracks: available.map((a, i) => ({ ...a, info: result.tracks[i]?.info, error: result.tracks[i]?.error })).filter((a) => !(a.stem.instrument === 'video' && a.error)),
        video: videoLocal ? { ...video, local: videoLocal, src: convertFileSrc(videoLocal), fades } : null,
        sync,
        // Cue tracks asked for (also when a file could not be had): see the cue effect.
        cueKey: cueKeyOf(item),
      },
    };
  }, [notify]);

  // A song is now the one in the player (loaded, or taken over by a transition).
  const commit = useCallback(
    (item, prepared) => {
      const { state, missing } = prepared;
      const { settings: st, setlist: sl, canDrive: drive, user: u } = ctx.current;
      setSolos({});
      setLoaded(state);
      if (state.sync.error) notify(`Griglia non allineata: ${state.sync.error}`, true);
      requestPeaks(state.tracks.map((a) => a.local));
      if (missing) notify(`${missing} tracce di “${item.title}” non disponibili (offline o non scaricate)`, true);
      else if (!state.sync.error && gridUnsure(item, state.sync)) notify(unsureText(item, state.sync), true);
      else if (!state.sync.error) notify(null);
      // Patch changes of the song for the keyboards (Impostazioni › MIDI), once per song: the same
      // song loaded again (key, tempo or cues changed) does not reset the sounds while it plays.
      if (midiSent.current !== item.id) {
        midiSent.current = item.id;
        if (st.midi.auto && midiTargeted(st.midi)) sendSongMidi(item, st.midi).catch((e) => notify(`MIDI: ${e.message}`, true));
      }
      if (st.driveStage && drive && sl && sl.live?.itemId !== item.id) {
        driveStage(sl, item.id, u).catch((e) => notify(`Guida la band: ${e.message}`, true));
      }
    },
    [notify],
  );

  const load = useCallback(
    async (item, { play = false } = {}) => {
      if (!item || isSeparator(item)) return;
      const t = ++token.current;
      queued.current = null;
      try {
        const prepared = await prepare(item, { send: (spec) => engine.load(spec), alive: () => t === token.current, ui: { setBusy, setDownloading } });
        if (!prepared) return;
        commit(item, prepared);
        if (play) await engine.play(ctx.current.settings.countIn);
      } catch (e) {
        notify(`Caricamento non riuscito: ${e?.message || e}`, true);
      } finally {
        if (t === token.current) {
          setBusy(null);
          setDownloading(null);
        }
      }
    },
    [notify, prepare, commit],
  );

  // Grid source / fine correction of the song in the player, applied live.
  const changeSync = useCallback(
    async (patch) => {
      const l = ctx.current.loaded;
      const item = l && ctx.current.items.find((i) => i.id === l.itemId);
      if (!item) return;
      const choice = setSyncChoice(item.id, patch);
      let sync = { ...l.sync, choice };
      if ('source' in patch) {
        sync = await analyzeSource(item, l.tracks, choice, setBusy);
        setBusy(null);
        if (sync.error) notify(`Griglia non allineata: ${sync.error}`, true);
        else if (gridUnsure(item, sync)) notify(unsureText(item, sync), true);
      }
      const tempo = await engine.setSync(syncSpec(item, sync.analysis, choice, refRegions(item, sync)));
      setLoaded((cur) => (cur?.itemId === item.id ? { ...cur, tempo: tempo || cur.tempo, sync } : cur));
    },
    [notify],
  );

  // Stems moved or cut in the Arrangement (item = the song with the new
  // regions): heard at once, grid included when its reference stem moved.
  const applyRegions = useCallback(async (item, regions) => {
    const l = ctx.current.loaded;
    if (!l || l.itemId !== item.id) return;
    const duration = await engine.setRegions(regions);
    let tempo = null;
    if (l.sync?.source && regions[l.sync.source.id]) {
      tempo = await engine.setSync(syncSpec(item, l.sync.analysis, l.sync.choice || getSyncChoice(item.id), refRegions(item, l.sync)));
    }
    setLoaded((cur) => (cur?.itemId === item.id ? { ...cur, duration: duration ?? cur.duration, tempo: tempo || cur.tempo } : cur));
  }, []);

  // Grid set by hand (song.grid): preview while dragging, without saving.
  const previewGrid = useCallback(async (grid) => {
    const l = ctx.current.loaded;
    const item = l && ctx.current.items.find((i) => i.id === l.itemId);
    if (!item) return;
    const tempo = await engine.setSync(syncSpec({ ...item, grid }, l.sync?.analysis, l.sync?.choice || getSyncChoice(item.id), refRegions(item, l.sync)));
    setLoaded((cur) => (cur?.itemId === item.id && tempo ? { ...cur, tempo } : cur));
  }, []);

  // Into the song's draft; once saved, every computer of the band gets the same grid.
  const saveGrid = useCallback((grid) => {
    const l = ctx.current.loaded;
    if (!l) return;
    const clean = {
      from: grid.from ?? null,
      to: grid.to ?? null,
      anchors: (grid.anchors || []).map((a) => ({ beat: a.beat, t: Math.round(a.t * 10000) / 10000 })),
      bpm: grid.bpm ?? null,
    };
    editDraft(l.itemId, { item: { grid: clean } });
  }, []);

  // The song's grid changed (here or on another computer): apply it, and redo
  // the analysis when its range changed.
  const loadedGrid = items.find((i) => i.id === loaded?.itemId)?.grid;
  const gridJson = JSON.stringify(loadedGrid ?? null);
  useEffect(() => {
    const l = ctx.current.loaded;
    const item = l && ctx.current.items.find((i) => i.id === l.itemId);
    if (!item || !l.sync) return undefined;
    let cancelled = false;
    (async () => {
      let sync = l.sync;
      if (sync.range !== rangeKey(item)) {
        sync = await analyzeSource(item, l.tracks, sync.choice || getSyncChoice(item.id), setBusy);
        setBusy(null);
        if (cancelled) return;
        if (sync.error) notify(`Griglia non allineata: ${sync.error}`, true);
      }
      const tempo = await engine.setSync(syncSpec(item, sync.analysis, sync.choice || getSyncChoice(item.id), refRegions(item, sync)));
      if (!cancelled) setLoaded((cur) => (cur?.itemId === item.id ? { ...cur, tempo: tempo || cur.tempo, sync } : cur));
    })();
    return () => {
      cancelled = true;
    };
    // Only when the stored grid changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridJson]);

  // Sections changed (markers of the Palco view, undo, another computer): new
  // tempo map at once, the tracks go on playing.
  const loadedSections = loaded && items.find((i) => i.id === loaded.itemId);
  const sectionsJson = loadedSections ? JSON.stringify(sectionSpecs(loadedSections)) : null;
  useEffect(() => {
    const id = ctx.current.loaded?.itemId;
    if (!sectionsJson || !id) return;
    engine.setSections(JSON.parse(sectionsJson)).then((tempo) => {
      if (tempo) setLoaded((cur) => (cur?.itemId === id ? { ...cur, tempo } : cur));
    });
  }, [sectionsJson]);

  // Mute or volume automation of the click changed (Arrangement, R/W, undo): heard at once.
  const clickMuteJson = loadedSections ? JSON.stringify([clickMuteOf(loadedSections), clickVolumeSpec(loadedSections)]) : null;
  const sentClickMute = useRef(null);
  useEffect(() => {
    const id = ctx.current.loaded?.itemId;
    if (!clickMuteJson || !id) return;
    const key = `${id}|${clickMuteJson}`;
    if (sentClickMute.current === key) return;
    sentClickMute.current = key;
    const [spans, auto] = JSON.parse(clickMuteJson);
    engine.setClickMute(spans, auto).catch(() => {});
  }, [clickMuteJson]);

  // Cues edited in the Arrangement: the cue track is remade and swapped in the
  // engine, heard at once without reloading the song. Adding the first cue,
  // removing them all, a new mixdown or its file deleted reload the song.
  const cueSong = items.find((i) => i.id === loaded?.itemId);
  const cueKey = cueSong ? cueKeyOf(cueSong) : null;
  const cueRun = useRef(0);
  useEffect(() => {
    const l = ctx.current.loaded;
    const item = l && ctx.current.items.find((i) => i.id === l.itemId);
    if (!item || l.cueKey === cueKeyOf(item)) return;
    const idx = l.tracks.findIndex((tr) => tr.stem.live);
    const cur = l.tracks[idx];
    const plan = liveCuePlan(item);
    const want = plan && { stem: plan.stem, plan };
    const fileChanged = l.cueKey.split('|')[1] !== (renderedCuesId(item) ?? '');
    const run = ++cueRun.current;
    (async () => {
      try {
        if (fileChanged || !cur || !want) {
          const at = engineStatus().position;
          await load(item);
          if (run === cueRun.current) engine.locate(at);
          return;
        }
        const local = (await liveCueLocal(want.plan).catch(() => null)) || (await makeLiveCues(want.plan, l.tempo, l.duration));
        if (run !== cueRun.current || ctx.current.loaded?.itemId !== item.id || !local) return;
        const res = await engine.replaceTrack(cur.stem.id, want.stem.id, local);
        engine.setTrack(want.stem.id, trackMix(want.stem, ctx.current.settings, false, mixFor(item)));
        setLoaded((c) =>
          c?.itemId === item.id
            ? { ...c, cueKey: cueKeyOf(item), tracks: c.tracks.map((tr, i) => (i === idx ? { stem: want.stem, local, info: res.info, error: null } : tr)) }
            : c,
        );
        requestPeaks([local]);
      } catch (e) {
        notify(`Cue non aggiornate: ${e?.message || e}`, true);
      }
    })();
  }, [cueKey, load, notify]);

  // Mix of the song changed (Mixer, Arrangement, Palco, undo, "Scarta", "Ripristina volumi", another
  // computer): volume, pan, group, mute, automation of the song, channel section (gain, EQ) and
  // the groups of the loaded tracks follow at once.
  const mixSong = songNow;
  const mixSheet = cueTrackOf(mixSong);
  const mixJson = mixSong
    ? JSON.stringify([
        stemsOf(mixSong).map((s) => [s.id, s.gain, s.pan, s.role, s.instrument, s.input, s.eq, !!s.muted, s.auto, s.muteAuto, s.autoRead]),
        mixSheet.gain,
        mixSheet.pan,
        mixSheet.input,
        mixSheet.eq,
        mixSheet.muted,
        // The sound of a video item (its strip in the Mixer).
        isVideoItem(mixSong) ? [mixSong.video?.gain, mixSong.video?.pan, mixSong.video?.input, mixSong.video?.eq, mixSong.video?.muted] : null,
        editableSong(mixSong, canEdit),
      ])
    : null;
  const applied = useRef(new Map()); // stem id → mix sent to the engine (JSON)
  useEffect(() => {
    const l = ctx.current.loaded;
    const item = l && ctx.current.items.find((i) => i.id === l.itemId);
    if (!item) return;
    const byId = new Map(stemsOf(item).map((s) => [s.id, s]));
    const sheet = cueTrackOf(item);
    const mix = mixFor(item);
    const next = new Map();
    l.tracks.forEach(({ stem }) => {
      const src = stem.live
        ? { gain: sheet.gain, pan: sheet.pan, input: sheet.input, eq: sheet.eq, role: stem.role, instrument: stem.instrument, muted: sheet.muted }
        : stem.id === VIDEO_AUDIO_ID
          ? videoAudioStem(item)
          : byId.get(stem.id);
      if (!src) return;
      const now = { ...stem, gain: Number(src.gain) || 0, pan: Number(src.pan) || 0, input: src.input, eq: src.eq, role: src.role, instrument: src.instrument, muted: !!src.muted, auto: src.auto, muteAuto: src.muteAuto, autoRead: src.autoRead };
      const same =
        ['gain', 'pan', 'role', 'instrument', 'muted'].every((k) => now[k] === stem[k]) &&
        now.input === stem.input &&
        JSON.stringify(now.eq) === JSON.stringify(stem.eq) &&
        JSON.stringify([now.auto, now.muteAuto, now.autoRead]) === JSON.stringify([stem.auto, stem.muteAuto, stem.autoRead]);
      if (!same) next.set(stem.id, now);
      const sent = trackMix(now, ctx.current.settings, !!ctx.current.solos[stem.id], mix);
      const key = JSON.stringify(sent);
      if (same && applied.current.get(stem.id) === key) return;
      applied.current.set(stem.id, key);
      engine.setTrack(stem.id, sent);
    });
    if (next.size) {
      setLoaded((c) => (c?.itemId === l.itemId ? { ...c, tracks: c.tracks.map((tr) => (next.has(tr.stem.id) ? { ...tr, stem: next.get(tr.stem.id) } : tr)) } : c));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mixJson]);

  const songs = items.filter((i) => !isSeparator(i));

  const step = useCallback(
    (dir) => {
      const { loaded: l, items: its } = ctx.current;
      const list = its.filter((i) => !isSeparator(i));
      const i = list.findIndex((x) => x.id === l?.itemId);
      const next = list[i < 0 ? 0 : i + dir];
      if (next) load(next, { play: false });
    },
    [load],
  );

  const toggle = useCallback(
    (fallbackItem) => {
      const s = engineStatus();
      if (s.playing) return engine.stop();
      if (!ctx.current.loaded) return load(fallbackItem, { play: true });
      return engine.play(ctx.current.settings.countIn);
    },
    [load],
  );

  const launch = useCallback(
    (item) => {
      const s = engineStatus();
      if (ctx.current.loaded?.itemId === item.id) {
        if (s.playing) return engine.stop();
        return engine.play(ctx.current.settings.countIn);
      }
      return load(item, { play: true });
    },
    [load],
  );

  // Mute of a track: with the song for who can edit it (draft), else on this computer as solo and output.
  // Volume and pan go through the song (Mixer).
  const setTrack = useCallback((stem, patch) => {
    const { solo, mute, ...persist } = patch;
    const { loaded: l, items: its, canEdit: ce } = ctx.current;
    const song = its.find((i) => i.id === l?.itemId);
    // M of the track (Arrangement): the mute of the Palco on it goes, the song's (or this computer's) is set.
    if (mute !== undefined) clearStageMute(stem);
    const songStem = stemsOf(song).find((s) => s.id === stem.id);
    if (mute !== undefined && !stem.live && editableSong(song, ce) && songStem) {
      // Into the draft (the mix effect above sends it to the engine); already so in the song: only the engine.
      if (!!songStem.muted !== !!mute) writeMix(song, { stems: stemsOf(song).map((s) => (s.id === stem.id ? { ...s, muted: !!mute } : s)) }, `${mute ? 'Mutata' : 'Riattivata'} “${stem.name}”`);
      else engine.setTrack(stem.id, { mute: !!mute });
    } else if (mute !== undefined && stem.id === VIDEO_AUDIO_ID && editableSong(song, ce) && song.video) {
      // The sound of a video item: its mute is saved on the video.
      if (!!song.video.muted !== !!mute) writeMix(song, { video: { ...song.video, muted: !!mute } }, `${mute ? 'Mutato' : 'Riattivato'} l’audio del video`);
      else engine.setTrack(stem.id, { mute: !!mute });
    } else if (mute !== undefined) persist.mute = mute;
    if (Object.keys(persist).length) setMix(stem.id, persist);
    if (solo !== undefined) setSolos((s) => ({ ...s, [stem.id]: solo }));
    const mix = {};
    if (persist.mute !== undefined) mix.mute = persist.mute;
    if (solo !== undefined) mix.solo = solo;
    if ('route' in patch) {
      // null = back to the output of the stem's role.
      const r = routeOf(stem, ctx.current.settings);
      mix.outStart = r.start;
      mix.outMode = r.mode;
    }
    engine.setTrack(stem.id, mix);
  }, []);

  // Output matrix changed: re-route the loaded tracks that follow their role.
  useEffect(() => {
    loaded?.tracks.forEach(({ stem }) => {
      const r = routeOf(stem, settings);
      engine.setTrack(stem.id, { outStart: r.start, outMode: r.mode });
    });
  }, [settings.outputs, loaded]);

  // The tracks of a group in the loaded song, as the song has them now (draft, undo). The live cue
  // track keeps its own mute (cue lane: muted after the mixdown) unless it is all the group has.
  const groupStems = (group) => {
    const { loaded: l, items: its } = ctx.current;
    const song = its.find((i) => i.id === l?.itemId);
    const byId = new Map(stemsOf(song).map((s) => [s.id, s]));
    const sheet = cueTrackOf(song);
    const all = (l?.tracks || [])
      .map(({ stem }) => (stem.live ? { ...stem, muted: !!sheet.muted } : stem.id === VIDEO_AUDIO_ID && song?.video ? { ...stem, muted: !!song.video.muted } : byId.get(stem.id) || stem))
      .filter((stem) => rehearsalGroup(stem) === group);
    return all.some((s) => !s.live) ? all.filter((s) => !s.live) : all;
  };

  /** Tracks of a group muted now (Arrangement, Mixer and Palco see the same): { muted, total, names } (names: the muted ones). */
  const groupMute = (group) => {
    const { loaded: l, items: its, canEdit: ce } = ctx.current;
    const local = !editableSong(its.find((i) => i.id === l?.itemId), ce);
    const stems = groupStems(group);
    const muted = stems.filter((s) => isMuted(s, local));
    return { muted: muted.length, total: stems.length, names: muted.map((s) => s.name) };
  };

  // Mute of a group (Palco mixer, Rehearsal bar, telecomando) = all its tracks, on this computer only:
  // never into the song (no "Salva"), shown as well by the Arrangement and the Mixer.
  const setGroupMute = useCallback((group, mute) => {
    const stems = groupStems(group);
    stems.forEach((stem) => {
      setStageMute(stem, mute);
      engine.setTrack(stem.id, { mute: !!mute });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A touch on a group: all its tracks muted, or all back in the mix when they all were.
  const toggleGroup = useCallback((group) => {
    const m = groupMute(group);
    setGroupMute(group, m.muted < m.total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Palco mixer: volume of a group (kept on this computer, for every song) or solo of all its tracks.
  const setGroup = useCallback((group, patch) => {
    const tracks = (ctx.current.loaded?.tracks || []).filter(({ stem }) => rehearsalGroup(stem) === group);
    if (patch.gainDb !== undefined) {
      setMix(groupMixKey(group), { gainDb: patch.gainDb });
      tracks.forEach(({ stem }) => engine.setTrack(stem.id, { gainDb: ownGain(stem) + patch.gainDb }));
    }
    if (patch.solo !== undefined) {
      setSolos((s) => ({ ...s, ...Object.fromEntries(tracks.map(({ stem }) => [stem.id, patch.solo])) }));
      tracks.forEach(({ stem }) => engine.setTrack(stem.id, { solo: patch.solo }));
    }
  }, []);

  // Click: metronome on its own output (left out with the click group in rehearsal).
  // Volume of this device plus that of the loaded song (Mixer, saved with it); muted by the song too.
  const songClick = clickMixOf(songNow);
  useEffect(() => {
    const r = settings.outputs.click;
    engine.setClick({
      enabled: settings.click.enabled && r.mode !== 'off' && !songClick.muted,
      gain: dbToGain(Math.min(12, settings.click.gainDb + songClick.gain)),
      outStart: r.start,
      mono: r.mode !== 'stereo',
      ...clickVoice(settings.click),
    });
  }, [settings.click, settings.outputs.click, songClick.gain, songClick.muted]);

  useEffect(() => {
    engine.setMaster(settings.masterDb);
  }, [settings.masterDb]);

  // Precount changed: the tempo map is built at load, so reload the song where it was
  // (while playing it applies to the next load).
  const countInBars = countInOf(settings);
  const lastCountIn = useRef(countInBars);
  useEffect(() => {
    if (lastCountIn.current === countInBars) return;
    lastCountIn.current = countInBars;
    const l = ctx.current.loaded;
    const item = l && ctx.current.items.find((i) => i.id === l.itemId);
    if (!item || engineStatus().playing) return;
    const at = engineStatus().position;
    load(item)
      .then(() => engine.locate(Math.max(at, 0)))
      .catch(() => {});
  }, [countInBars, load]);

  // Reload of the song in the player where it was (tempo / metre changed, draft
  // discarded), after the render that brings its new fields; it keeps playing.
  const [reloadTick, setReloadTick] = useState(0);
  const reload = useCallback(() => setReloadTick((n) => n + 1), []);
  useEffect(() => {
    if (!reloadTick) return;
    const l = ctx.current.loaded;
    const item = l && ctx.current.items.find((i) => i.id === l.itemId);
    if (!item) return;
    const { position: at, playing } = engineStatus();
    load(item)
      .then(() => {
        engine.locate(Math.max(at, 0));
        if (playing) engine.play(ctx.current.settings.countIn);
      })
      .catch(() => {});
  }, [reloadTick, load]);

  // End of the song: its transition says what follows (Playback). Cue next
  // loads the next one; the linked ones were already queued in the engine, and
  // if that failed the next one is at least cued.
  useEffect(
    () =>
      onSongEnded(() => {
        const { loaded: l, items: its, settings: st } = ctx.current;
        const item = its.find((i) => i.id === l?.itemId);
        const mode = transitionOf(item, st);
        if (mode === 'cue') {
          // Prepara il prossimo: loaded where the transition says it starts.
          const list = its.filter((i) => !isSeparator(i));
          const next = list[list.findIndex((x) => x.id === item?.id) + 1];
          const from = Math.max(0, Number(item?.linkStart) || 0);
          if (next)
            load(next).then(() => {
              if (from && ctx.current.loaded?.itemId === next.id) engine.locate(from);
            });
        } else if (isLinked(mode)) step(1);
      }),
    [step, load],
  );

  // The song after the one loaded, and how to get there.
  const songList = items.filter((i) => !isSeparator(i));
  const loadedIndex = songList.findIndex((x) => x.id === loaded?.itemId);
  const nextSong = loadedIndex >= 0 ? songList[loadedIndex + 1] || null : null;
  const loadedSong = loadedIndex >= 0 ? songList[loadedIndex] : null;
  const linkMode = loadedSong ? transitionOf(loadedSong, settings) : null;
  const nextKey = nextSong && isLinked(linkMode) ? `${loaded.itemId}>${nextSong.id}:${linkMode}:${loaded.duration}:${nextSong.updatedAt?.seconds ?? ''}` : null;
  // The fine tuning of the transition (Transizioni page): changing it only moves the
  // next song in the engine, without preparing it again.
  const planOf = (l, next) => {
    const from = ctx.current.items.find((i) => i.id === l.itemId);
    return transitionPlan(from, transitionOf(from, ctx.current.settings), l.duration, l.tempo, next, l.rate || 1);
  };
  const planJson = nextKey ? JSON.stringify(planOf(loaded, nextSong)) : null;
  const lastSent = useRef(null); // { token, spec } of the next song in the engine

  // AutoLink, overlap and crossfade: the next song is prepared and waits in the
  // engine, which starts it at the frame of the transition without gaps.
  useEffect(() => {
    const t = ++queueToken.current;
    queued.current = null;
    lastSent.current = null;
    if (!nextKey) {
      engine.cancelNext().catch(() => {});
      return undefined;
    }
    const l = ctx.current.loaded;
    const next = ctx.current.items.find((i) => i.id === nextSong.id);
    const alive = () => t === queueToken.current && ctx.current.loaded?.itemId === l.itemId;
    const quiet = { setBusy: () => {}, setDownloading: () => {} };
    // A stale preparation must not reach the engine after a newer one.
    const send = (spec) => {
      if (!alive()) return Promise.reject(new Error('superata'));
      lastSent.current = { token: t, spec, next };
      return engine.queueNext(spec, planOf(l, next));
    };
    prepare(next, { send, alive, ui: quiet })
      .then((prepared) => {
        if (prepared && alive()) queued.current = { itemId: next.id, item: next, prepared };
      })
      .catch((e) => alive() && notify(`Transizione verso “${next.title}” non pronta: ${e?.message || e}`, true));
    return () => {
      queueToken.current += 1;
    };
    // The key holds what matters: the song, the next one and the transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextKey, prepare, notify]);

  // Offset, fades or start changed: the same next song, queued again with the new plan.
  useEffect(() => {
    const sent = lastSent.current;
    const l = ctx.current.loaded;
    if (!planJson || !sent || sent.token !== queueToken.current || !l || !queued.current) return;
    if (engineStatus().next?.songId !== sent.next.id) return; // already taken over
    engine.queueNext(sent.spec, JSON.parse(planJson)).catch((e) => notify(`Transizione non aggiornata: ${e?.message || e}`, true));
  }, [planJson, notify]);

  // The engine changed song: the next one is now the song in the player.
  useEffect(
    () =>
      subscribeStatus((s) => {
        const q = queued.current;
        if (!q || s.songId !== q.itemId || ctx.current.loaded?.itemId === q.itemId) return;
        queued.current = null;
        token.current += 1;
        commit(q.item, q.prepared);
      }),
    [commit],
  );

  // Key or tempo of the song in the player changed (here or by the band): its stems
  // are rendered again and it goes on from the same point.
  const changeNow = loadedSong ? (({ semitones, rate }) => `${semitones}:${rate}`)(songChange(loadedSong)) : null;
  useEffect(() => {
    if (!changeNow || !loaded?.change || changeNow === loaded.change) return;
    reload();
  }, [changeNow, loaded?.change, reload]);

  // The bars of the song in the player for the Player palco of the web (lib/beatMap.js), once the grid has settled.
  const tempoKey = loaded ? `${loaded.itemId}:${JSON.stringify(loaded.tempo?.segments?.length)}:${loaded.tempo?.origin}:${loaded.duration}` : null;
  useEffect(() => {
    if (!tempoKey || !canEdit || !setlist?.id) return undefined;
    const timer = setTimeout(() => {
      const l = ctx.current.loaded;
      const item = l && ctx.current.items.find((i) => i.id === l.itemId);
      if (item && !isVideoItem(item)) publishBeatMap(setlist.id, item, beatMapOf(l.tempo, l.duration)).catch(() => {});
    }, 4000);
    return () => clearTimeout(timer);
  }, [tempoKey, canEdit, setlist?.id, loaded?.tempo]);

  // Pad Player: the key of the song in the player, or the one chosen live.
  // A video item has no key: the pad gives the one of the song after it.
  const padSong = isVideoItem(loadedSong) ? nextSong : loadedSong;
  const padKey = settings.pad.mode === 'live' ? keyPitch(settings.pad.key) : keyPitch(playedKey(padSong));
  useEffect(() => {
    const r = settings.outputs.pad || settings.outputs.main;
    engine
      .setPad({
        enabled: padOn && padKey != null && r.mode !== 'off',
        key: padKey ?? 0,
        gain: dbToGain(settings.pad.gainDb),
        outStart: r.start,
        mono: r.mode !== 'stereo',
        ...(!padOn && padRelease ? { release: padRelease } : {}),
      })
      .catch(() => {});
  }, [padOn, padKey, padRelease, settings.pad.gainDb, settings.outputs.pad, settings.outputs.main]);

  // "Start pad with song": the pad comes in when a song starts.
  useEffect(() => {
    let was = engineStatus().playing;
    return subscribeStatus((s) => {
      if (s.playing && !was && ctx.current.settings.pad.withSong) setPadOn(true);
      was = s.playing;
    });
  }, []);

  // Video item with padLead: the pad comes in that many seconds before the end of
  // the video (once per load), in the key of the next song, and goes on into it.
  const padFired = useRef(null);
  useEffect(
    () =>
      subscribeStatus((s) => {
        const { loaded: l, items: its } = ctx.current;
        const item = l && its.find((i) => i.id === l.itemId);
        const lead = padLeadOf(item);
        if (lead == null || !s.playing || s.songId !== item.id || padFired.current === item.id) return;
        if (s.position >= l.duration - lead) {
          padFired.current = item.id;
          const hold = padHoldOf(item);
          padHold.current = hold && { from: item.id, into: null, ...hold };
          setPadRelease(null);
          setPadOn(true);
        }
      }),
    [],
  );
  // padHold: after `hold` seconds of the song after the video the pad fades out
  // in `fadeOut` seconds (a longer release in the engine), then the release is back to normal.
  useEffect(
    () =>
      subscribeStatus((s) => {
        const h = padHold.current;
        if (!h || !s.playing || !s.songId || s.songId === h.from) return;
        if (!h.into) h.into = s.songId;
        if (s.songId !== h.into || s.position < h.hold) return;
        padHold.current = null;
        setPadRelease(h.fadeOut);
        setPadOn(false);
      }),
    [],
  );
  useEffect(() => {
    // Loaded again (or another song): it can fire again.
    padFired.current = null;
  }, [loaded?.itemId]);

  // Tracks Fade: out while playing, back in if already out (or going out).
  const toggleFade = useCallback(() => {
    const s = engineStatus();
    if (!s.playing) return;
    engine.fade(s.fadeTarget > 0.5, Number(ctx.current.settings.fadeSeconds) || 5);
  }, []);

  // Palco Sync: follow the song chosen by the band's master.
  const liveItemId = lanLive?.itemId || setlist?.live?.itemId;
  useEffect(() => {
    if (!settings.followStage || !liveItemId || engineStatus().playing) return;
    if (ctx.current.loaded?.itemId === liveItemId) return;
    const item = ctx.current.items.find((i) => i.id === liveItemId);
    if (item) load(item);
  }, [liveItemId, settings.followStage, load]);

  // Where the song in the engine is, for the video of a video item that goes on
  // after the next song took over (overlap, crossfade).
  const lastPos = useRef(null);
  useEffect(
    () =>
      subscribeStatus((s) => {
        // Per song: the status that brings the next one must not hide where the one before was.
        if (!s.playing || !s.songId) return;
        const cur = lastPos.current || {};
        // A new song: only the one before is kept.
        if (cur.last !== s.songId) lastPos.current = cur.last ? { [cur.last]: cur[cur.last] } : {};
        lastPos.current.last = s.songId;
        lastPos.current[s.songId] = { position: s.position, at: Date.now() };
      }),
    [],
  );

  // Picture of the setlist on the video output when there is no video (ScreenImage.jsx).
  const screen = setlist?.screenImage?.path ? setlist.screenImage : null;
  const [still, setStill] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!screen) setStill(null);
    else
      ensureFile({ path: screen.path, size: screen.size })
        .then((local) => alive && setStill(local ? convertFileSrc(local) : null))
        .catch(() => alive && setStill(null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen?.path]);
  useEffect(() => {
    setNdiStill(still);
  }, [still]);

  // The video output window asks for the current source when it opens.
  const video = loaded?.video;
  const shownVideo = useRef(null);
  useEffect(() => {
    const song = ctx.current.loaded?.itemId || null;
    const payload = video ? { src: video.src, offset: video.offset || 0, name: video.name, fades: video.fades || null, song, still } : { src: null, still };
    const prev = shownVideo.current;
    shownVideo.current = video ? { ...video, itemId: ctx.current.loaded?.itemId } : null;
    // A video item still playing when the next song took over: its picture fades out by itself.
    const p = prev && lastPos.current?.[prev.itemId];
    if (prev?.fades && p && engineStatus().playing && prev.src !== video?.src) {
      const at = p.position + (Date.now() - p.at) / 1000;
      emit('video-source', { ...payload, tail: { src: prev.src, offset: prev.offset || 0, fades: prev.fades, at, since: Date.now() } });
    } else emit('video-source', payload);
    setNdiVideoSource(video);
    const un = listen('video-hello', () => emit('video-source', payload));
    return () => {
      un.then((f) => f());
    };
  }, [video, still]);

  const loadedItem = items.find((i) => i.id === loaded?.itemId) || null;

  return {
    loaded,
    loadedItem,
    busy,
    downloading,
    solos,
    toggleGroup,
    setGroupMute,
    groupMute,
    setGroup,
    // The track mutes are saved with the song (draft) rather than on this computer.
    mixSaved: editableSong(songNow, canEdit),
    padOn,
    padKey,
    togglePad: () => {
      // By hand: no fade out planned any more, and the normal release.
      padHold.current = null;
      setPadRelease(null);
      setPadOn((v) => !v);
    },
    toggleFade,
    nextSong,
    linkMode,
    songs,
    load,
    reload,
    launch,
    toggle,
    step,
    setTrack,
    changeSync,
    previewGrid,
    saveGrid,
    applyRegions,
    // The patches of the song in the player, sent now (Impostazioni › MIDI, “Invia ora”).
    sendMidi: () => sendSongMidi(loadedItem, ctx.current.settings.midi),
    stop: () => engine.stop(),
    locate: (seconds) => engine.locate(seconds),
  };
}
