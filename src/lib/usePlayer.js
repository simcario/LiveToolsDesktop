// The player: loads a song of the setlist into the Rust engine (downloading
// its media first), applies the local mix and the output matrix, drives the
// transport and, when asked, the band ("Guida la band").
import { useCallback, useEffect, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { convertFileSrc } from '@tauri-apps/api/core';
import { regionsOf, rehearsalGroup, stemsOf, videoOf } from '../shared/media.js';
import { isSeparator } from '../shared/setlists.js';
import { dbToGain, engine, engineStatus, onSongEnded, onStretchProgress, subscribeStatus } from './engine';
import { driveStage } from './data';
import { editDraft } from './drafts';
import { setNdiVideoSource } from './ndi';
import { liveCueLocal, liveCuePlan, makeLiveCues } from './cueTrack';
import { ensureFile, missingFiles, requestPeaks } from './mediaCache';
import { clickVoice, getMix, setMix } from './settings';
import { GRID_KEY } from './arrange';
import { analyze, getSyncChoice, rangeKey, resolveSource, setSyncChoice, syncSpec } from './sync';
import { beatMapOf, publishBeatMap } from './beatMap';
import { isLinked, keepsPitch, keyPitch, playedKey, songChange, transitionOf, transitionPlan } from './songChange';

function routeOf(stem, settings) {
  return getMix(stem.id).route || settings.outputs[stem.role || 'main'] || settings.outputs.main;
}

// Rehearsal: groups (instrument, click, guide) left out of the mix in this
// session, on top of the mute of each track.
const isMuted = (stem, leftOut) => (getMix(stem.id).mute ?? !!stem.muted) || !!leftOut?.[rehearsalGroup(stem)];

// Volume of a rehearsal group (Palco mixer), on this computer: added to that of each of its tracks.
export const groupMixKey = (group) => `group:${group}`;
const groupGain = (stem) => getMix(groupMixKey(rehearsalGroup(stem))).gainDb || 0;
const ownGain = (stem) => getMix(stem.id).gainDb ?? stem.gain ?? 0;

function trackMix(stem, settings, solo, leftOut) {
  const m = getMix(stem.id);
  const route = routeOf(stem, settings);
  return {
    gainDb: ownGain(stem) + groupGain(stem),
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

const num = (v) => (Number(v) > 0 ? Number(v) : null);

const sectionSpecs = (item) =>
  (item.sections || []).map((s) => ({
    label: s.label || null,
    bars: num(s.bars),
    bpm: num(s.bpm),
    timeSig: s.timeSig || null,
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

export function usePlayer({ user, setlist, items, settings, canDrive, canEdit, notify }) {
  const [loaded, setLoaded] = useState(null); // { itemId, duration, tempo, tracks: [{ stem, local, info, error }], video }
  const [busy, setBusy] = useState(null);
  const [downloading, setDownloading] = useState(null); // files of the song being loaded, not on disk yet
  const [solos, setSolos] = useState({});
  const [leftOut, setLeftOut] = useState({}); // rehearsal group → true
  const token = useRef(0);
  // The next song prepared for a transition: { itemId, prepared, item } once the engine has it.
  const queued = useRef(null);
  const queueToken = useRef(0);
  const [padOn, setPadOn] = useState(false);
  const ctx = useRef({});
  ctx.current = { setlist, items, settings, canDrive, user, loaded, solos, leftOut };

  // Everything a song needs before the engine: files on disk, grid, live cues,
  // stems in another key or tempo. `send(spec)` gives it to the engine (load or
  // queue as the next song); null when `alive()` turns false on the way.
  const prepare = useCallback(async (item, { send, alive, ui }) => {
    const { settings: st, leftOut: out } = ctx.current;
    // Cues not rendered to a file (or changed since): played from a local track.
    const cuePlan = liveCuePlan(item);
    const stems = stemsOf(item).filter((s) => s.id !== cuePlan?.skip);
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
    const specOf = ({ stem, local }) => ({ id: stem.id, path: local, name: stem.name, regions: placed[stem.id] || [], ...trackMix(stem, st, false, out) });
    const spec = { ...songSpec(item, available.map(specOf), st), rate: change.rate };
    const sync = await analyzeSource(item, available, getSyncChoice(item.id), ui.setBusy);
    if (!alive()) return null;
    spec.sync = syncSpec(item, sync.analysis, sync.choice, refRegions(item, sync));
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
        tracks: available.map((a, i) => ({ ...a, info: result.tracks[i]?.info, error: result.tracks[i]?.error })),
        video: videoLocal ? { ...video, local: videoLocal, src: convertFileSrc(videoLocal) } : null,
        sync,
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
      else if (!state.sync.error) notify(null);
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
    if (patch.gainDb !== undefined) mix.gainDb = patch.gainDb + groupGain(stem);
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

  // Palco mixer: volume of a group (kept, for every song) or solo of all its tracks.
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

  // End of the song: its transition says what follows (Playback). Cue next
  // loads the next one; the linked ones were already queued in the engine, and
  // if that failed the next one is at least cued.
  useEffect(
    () =>
      onSongEnded(() => {
        const { loaded: l, items: its, settings: st } = ctx.current;
        const item = its.find((i) => i.id === l?.itemId);
        const mode = transitionOf(item, st);
        if (mode === 'cue' || isLinked(mode)) step(1);
      }),
    [step],
  );

  // The song after the one loaded, and how to get there.
  const songList = items.filter((i) => !isSeparator(i));
  const loadedIndex = songList.findIndex((x) => x.id === loaded?.itemId);
  const nextSong = loadedIndex >= 0 ? songList[loadedIndex + 1] || null : null;
  const loadedSong = loadedIndex >= 0 ? songList[loadedIndex] : null;
  const linkMode = loadedSong ? transitionOf(loadedSong, settings) : null;
  const nextKey = nextSong && isLinked(linkMode) ? `${loaded.itemId}>${nextSong.id}:${linkMode}:${loaded.duration}:${nextSong.updatedAt?.seconds ?? ''}` : null;

  // AutoLink, overlap and crossfade: the next song is prepared and waits in the
  // engine, which starts it at the frame of the transition without gaps.
  useEffect(() => {
    const t = ++queueToken.current;
    queued.current = null;
    if (!nextKey) {
      engine.cancelNext().catch(() => {});
      return undefined;
    }
    const l = ctx.current.loaded;
    const next = ctx.current.items.find((i) => i.id === nextSong.id);
    const plan = transitionPlan(linkMode, l.duration, l.tempo, next);
    const alive = () => t === queueToken.current && ctx.current.loaded?.itemId === l.itemId;
    const quiet = { setBusy: () => {}, setDownloading: () => {} };
    // A stale preparation must not reach the engine after a newer one.
    const send = (spec) => (alive() ? engine.queueNext(spec, plan) : Promise.reject(new Error('superata')));
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
      if (item) publishBeatMap(setlist.id, item, beatMapOf(l.tempo, l.duration)).catch(() => {});
    }, 4000);
    return () => clearTimeout(timer);
  }, [tempoKey, canEdit, setlist?.id, loaded?.tempo]);

  // Pad Player: the key of the song in the player, or the one chosen live.
  const padKey = settings.pad.mode === 'live' ? keyPitch(settings.pad.key) : keyPitch(playedKey(loadedSong));
  useEffect(() => {
    const r = settings.outputs.pad || settings.outputs.main;
    engine
      .setPad({ enabled: padOn && padKey != null && r.mode !== 'off', key: padKey ?? 0, gain: dbToGain(settings.pad.gainDb), outStart: r.start, mono: r.mode !== 'stereo' })
      .catch(() => {});
  }, [padOn, padKey, settings.pad.gainDb, settings.outputs.pad, settings.outputs.main]);

  // "Start pad with song": the pad comes in when a song starts.
  useEffect(() => {
    let was = engineStatus().playing;
    return subscribeStatus((s) => {
      if (s.playing && !was && ctx.current.settings.pad.withSong) setPadOn(true);
      was = s.playing;
    });
  }, []);

  // Tracks Fade: out while playing, back in if already out (or going out).
  const toggleFade = useCallback(() => {
    const s = engineStatus();
    if (!s.playing) return;
    engine.fade(s.fadeTarget > 0.5, Number(ctx.current.settings.fadeSeconds) || 5);
  }, []);

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
    setNdiVideoSource(video);
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
    setGroup,
    padOn,
    padKey,
    togglePad: () => setPadOn((v) => !v),
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
    stop: () => engine.stop(),
    locate: (seconds) => engine.locate(seconds),
  };
}
