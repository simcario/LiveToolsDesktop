// The player: loads a song of the setlist into the Rust engine (downloading
// its media first), applies the local mix and the output matrix, drives the
// transport and, when asked, the band ("Guida la band").
import { useCallback, useEffect, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { convertFileSrc } from '@tauri-apps/api/core';
import { regionsOf, rehearsalGroup, stemsOf, videoOf } from '../shared/media.js';
import { isSeparator } from '../shared/setlists.js';
import { dbToGain, engine, engineStatus, onSongEnded } from './engine';
import { driveStage } from './data';
import { editDraft } from './drafts';
import { liveCueLocal, liveCuePlan, makeLiveCues } from './cueTrack';
import { ensureFile, missingFiles, requestPeaks } from './mediaCache';
import { clickVoice, getMix, setMix } from './settings';
import { GRID_KEY } from './arrange';
import { analyze, getSyncChoice, rangeKey, resolveSource, setSyncChoice, syncSpec } from './sync';

function routeOf(stem, settings) {
  return getMix(stem.id).route || settings.outputs[stem.role || 'main'] || settings.outputs.main;
}

// Rehearsal: groups (instrument, click, guide) left out of the mix in this
// session, on top of the mute of each track.
const isMuted = (stem, leftOut) => (getMix(stem.id).mute ?? !!stem.muted) || !!leftOut?.[rehearsalGroup(stem)];

function trackMix(stem, settings, solo, leftOut) {
  const m = getMix(stem.id);
  const route = routeOf(stem, settings);
  return {
    gainDb: m.gainDb ?? stem.gain ?? 0,
    pan: m.pan ?? stem.pan ?? 0,
    mute: isMuted(stem, leftOut),
    solo: !!solo,
    outStart: route.start,
    outMode: route.mode,
  };
}

/** Count-in bars: one value for every song (Impostazioni → Trasporto → Precount). */
export const countInOf = (settings) => Number(settings.defaultCountIn) || 0;

// The track the cues of a song are heard from: the live one ({ stem, plan }),
// the up-to-date rendered "Cues" stem ({ stem }) or none.
function wantedCueStem(item) {
  const plan = liveCuePlan(item);
  if (plan) return { stem: plan.stem, plan };
  const rendered = stemsOf(item).find((s) => s.generated === 'cues');
  return rendered ? { stem: rendered } : null;
}

function songSpec(item, tracks, settings) {
  const num = (v) => (Number(v) > 0 ? Number(v) : null);
  return {
    id: item.id,
    tracks,
    // The tempo typed in the Arrangement (grid.bpm) keeps its decimals.
    bpm: num(item.grid?.bpm) || num(item.bpm),
    timeSig: item.timeSig || null,
    countInBars: countInOf(settings),
    sections: (item.sections || []).map((s) => ({
      label: s.label || null,
      bars: num(s.bars),
      bpm: num(s.bpm),
      timeSig: s.timeSig || null,
    })),
  };
}

// Analyses the reference stem chosen for the grid (click or rhythm).
async function analyzeSource(item, available, choice, setBusy) {
  const src = resolveSource(
    available.map((a) => a.stem),
    choice,
  );
  const range = rangeKey(item);
  if (!src) return { choice, source: null, analysis: null, error: null, range };
  const source = { id: src.stem.id, name: src.stem.name, mode: src.mode };
  setBusy(`Allineo la griglia a “${src.stem.name}”…`);
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

export function usePlayer({ user, setlist, items, settings, canDrive, notify }) {
  const [loaded, setLoaded] = useState(null); // { itemId, duration, tempo, tracks: [{ stem, local, info, error }], video }
  const [busy, setBusy] = useState(null);
  const [downloading, setDownloading] = useState(null); // files of the song being loaded, not on disk yet
  const [solos, setSolos] = useState({});
  const [leftOut, setLeftOut] = useState({}); // rehearsal group → true
  const token = useRef(0);
  const ctx = useRef({});
  ctx.current = { setlist, items, settings, canDrive, user, loaded, solos, leftOut };

  const load = useCallback(
    async (item, { play = false } = {}) => {
      if (!item || isSeparator(item)) return;
      const t = ++token.current;
      const { settings: st, leftOut: out } = ctx.current;
      // Cues not rendered to a file (or changed since): played from a local track.
      const cuePlan = liveCuePlan(item);
      const stems = stemsOf(item).filter((s) => s.id !== cuePlan?.skip);
      const video = videoOf(item);
      try {
        const toFetch = missingFiles([...stems, ...(video ? [video] : [])].map((m) => ({ path: m.path, size: m.size })));
        setDownloading(toFetch.length ? toFetch : null);
        if (stems.length || video) setBusy(`${toFetch.length ? 'Scarico' : 'Preparo'} “${item.title}”…`);
        const locals = await Promise.all(stems.map((s) => ensureFile({ path: s.path, size: s.size })));
        const videoLocal = video ? await ensureFile({ path: video.path, size: video.size }) : null;
        if (t === token.current && toFetch.length) {
          setDownloading(null);
          setBusy(`Preparo “${item.title}”…`);
        }
        let cueLocal = cuePlan ? await liveCueLocal(cuePlan).catch(() => null) : null;
        if (t !== token.current) return;
        const available = stems.map((stem, i) => ({ stem, local: locals[i] })).filter((x) => x.local);
        const missing = stems.length - available.length;
        const placed = regionsOf(item);
        const specOf = ({ stem, local }) => ({ id: stem.id, path: local, name: stem.name, regions: placed[stem.id] || [], ...trackMix(stem, st, false, out) });
        const spec = songSpec(item, available.map(specOf), st);
        const sync = await analyzeSource(item, available, getSyncChoice(item.id), setBusy);
        if (t !== token.current) return;
        spec.sync = syncSpec(item, sync.analysis, sync.choice, refRegions(item, sync));
        const withCues = () => {
          if (!cueLocal) return;
          const cue = { stem: cuePlan.stem, local: cueLocal };
          available.push(cue);
          spec.tracks = [...spec.tracks, specOf(cue)];
        };
        withCues();
        let result = await engine.load(spec);
        if (t !== token.current) return;
        // First load after a change of the cues: the track needs the tempo map.
        if (cuePlan && !cueLocal && result.tempo && result.duration > 0) {
          setBusy(`Creo le cue di “${item.title}”…`);
          cueLocal = await makeLiveCues(cuePlan, result.tempo, result.duration).catch((e) => {
            notify(`Cue non create: ${e?.message || e}`, true);
            return null;
          });
          if (t !== token.current) return;
          if (cueLocal) {
            withCues();
            result = await engine.load(spec);
            if (t !== token.current) return;
          }
        }
        setSolos({});
        setLoaded({
          itemId: item.id,
          duration: result.duration,
          tempo: result.tempo,
          tracks: available.map((a, i) => ({ ...a, info: result.tracks[i]?.info, error: result.tracks[i]?.error })),
          video: videoLocal ? { ...video, local: videoLocal, src: convertFileSrc(videoLocal) } : null,
          sync,
        });
        if (sync.error) notify(`Griglia non allineata: ${sync.error}`, true);
        requestPeaks(available.map((a) => a.local));
        if (missing) notify(`${missing} tracce di “${item.title}” non disponibili (offline o non scaricate)`, true);
        else if (!sync.error) notify(null);
        if (play) await engine.play(st.countIn);
        const { setlist: sl, canDrive: drive, user: u } = ctx.current;
        if (st.driveStage && drive && sl && sl.live?.itemId !== item.id) {
          driveStage(sl, item.id, u).catch((e) => notify(`Guida la band: ${e.message}`, true));
        }
      } catch (e) {
        notify(`Caricamento non riuscito: ${e?.message || e}`, true);
      } finally {
        if (t === token.current) {
          setBusy(null);
          setDownloading(null);
        }
      }
    },
    [notify],
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

  // Cues edited in the Arrangement: the cue track is remade (or the rendered
  // "Cues" file taken) and swapped in the engine, heard at once without
  // reloading the song. Adding the first cue or removing them all reloads.
  const cueSong = items.find((i) => i.id === loaded?.itemId);
  const cueWanted = cueSong ? wantedCueStem(cueSong) : null;
  const cueRun = useRef(0);
  useEffect(() => {
    const l = ctx.current.loaded;
    const item = l && ctx.current.items.find((i) => i.id === l.itemId);
    if (!item) return;
    const idx = l.tracks.findIndex((tr) => tr.stem.live || tr.stem.generated === 'cues');
    const cur = l.tracks[idx];
    const want = wantedCueStem(item);
    if ((cur?.stem.path ?? null) === (want?.stem.path ?? null)) return;
    const run = ++cueRun.current;
    (async () => {
      try {
        if (!cur || !want) {
          const at = engineStatus().position;
          await load(item);
          if (run === cueRun.current) engine.locate(at);
          return;
        }
        const local = want.plan
          ? (await liveCueLocal(want.plan).catch(() => null)) || (await makeLiveCues(want.plan, l.tempo, l.duration))
          : await ensureFile({ path: want.stem.path, size: want.stem.size });
        if (run !== cueRun.current || ctx.current.loaded?.itemId !== item.id || !local) return;
        const res = await engine.replaceTrack(cur.stem.id, want.stem.id, local);
        const { settings: st, leftOut: out } = ctx.current;
        engine.setTrack(want.stem.id, trackMix(want.stem, st, false, out));
        setLoaded((c) =>
          c?.itemId === item.id ? { ...c, tracks: c.tracks.map((tr, i) => (i === idx ? { stem: want.stem, local, info: res.info, error: null } : tr)) } : c,
        );
        requestPeaks([local]);
      } catch (e) {
        notify(`Cue non aggiornate: ${e?.message || e}`, true);
      }
    })();
  }, [cueWanted?.stem.path, load, notify]);

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

  const setTrack = useCallback((stem, patch) => {
    const { solo, ...persist } = patch;
    if (Object.keys(persist).length) setMix(stem.id, persist);
    if (solo !== undefined) setSolos((s) => ({ ...s, [stem.id]: solo }));
    const mix = {};
    if (patch.gainDb !== undefined) mix.gainDb = patch.gainDb;
    if (patch.pan !== undefined) mix.pan = patch.pan;
    if (patch.mute !== undefined) mix.mute = patch.mute || !!ctx.current.leftOut[rehearsalGroup(stem)];
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

  // Rehearsal: a group in or out of the mix, for every song of the session.
  const toggleGroup = useCallback((group) => setLeftOut((o) => ({ ...o, [group]: !o[group] })), []);
  useEffect(() => {
    loaded?.tracks.forEach(({ stem }) => engine.setTrack(stem.id, { mute: isMuted(stem, leftOut) }));
  }, [leftOut, loaded]);

  // Click: metronome on its own output (left out with the click group in rehearsal).
  useEffect(() => {
    const r = settings.outputs.click;
    engine.setClick({
      enabled: settings.click.enabled && r.mode !== 'off' && !leftOut.click,
      gain: dbToGain(settings.click.gainDb),
      outStart: r.start,
      mono: r.mode !== 'stereo',
      ...clickVoice(settings.click),
    });
  }, [settings.click, settings.outputs.click, leftOut.click]);

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

  // End of the song: cue the next one (Ableton "follow action" for a set).
  useEffect(
    () =>
      onSongEnded(() => {
        if (ctx.current.settings.autoAdvance) step(1);
      }),
    [step],
  );

  // Palco Sync: follow the song chosen by the band's master.
  const liveItemId = setlist?.live?.itemId;
  useEffect(() => {
    if (!settings.followStage || !liveItemId || engineStatus().playing) return;
    if (ctx.current.loaded?.itemId === liveItemId) return;
    const item = ctx.current.items.find((i) => i.id === liveItemId);
    if (item) load(item);
  }, [liveItemId, settings.followStage, load]);

  // The video output window asks for the current source when it opens.
  const video = loaded?.video;
  useEffect(() => {
    const payload = video ? { src: video.src, offset: video.offset || 0, name: video.name } : null;
    emit('video-source', payload);
    const un = listen('video-hello', () => emit('video-source', payload));
    return () => {
      un.then((f) => f());
    };
  }, [video]);

  const loadedItem = items.find((i) => i.id === loaded?.itemId) || null;

  return {
    loaded,
    loadedItem,
    busy,
    downloading,
    solos,
    leftOut,
    toggleGroup,
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
    stop: () => engine.stop(),
    locate: (seconds) => engine.locate(seconds),
  };
}
