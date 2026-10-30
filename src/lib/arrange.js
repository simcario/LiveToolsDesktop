// Editing of the song's timeline in the Arrangement view: stems moved on (or
// off) the grid and bars inserted at the playhead. Stems are placed by
// regions (shared/media.js regionsOf): the engine plays each file through
// them, so no audio file is ever rewritten.
import { cueTrackOf, regionsOf, stemsOf, videoOf } from '../shared/media.js';
import { recordStep } from './arrangeHistory';
import { editDraft } from './drafts';
import { gridBeats } from './grid';
import { gridOf } from './sync';

const WHOLE = [{ at: 0, from: 0, len: null }];

// regions._grid = { stemId, regions }: placement of the grid's reference stem
// frozen at its first edit by hand, so moving or trimming that stem does not
// drag the grid along (inserted bars still move it). Not a stem: the engine
// and the web rehearsal only read regions by stem id.
export const GRID_KEY = '_grid';

/** All the regions with the grid pinned where it was before editing `stemId` by hand. */
export function keepGrid(all, before, stemId) {
  if (all[GRID_KEY]?.stemId === stemId) return all;
  return { ...all, [GRID_KEY]: { stemId, regions: before } };
}

/** Regions of a stem (the whole file from 0 when it was never moved). */
export const stemRegions = (item, stemId) => {
  const r = regionsOf(item)[stemId];
  return Array.isArray(r) && r.length ? r : WHOLE;
};

export const moveRegions = (regions, delta) => regions.map((r) => ({ ...r, at: Math.round((r.at + delta) * 1e4) / 1e4 }));

/** Opens a gap of `d` seconds at `p`: regions across it are cut in two. */
export function insertGap(regions, p, d) {
  return regions.flatMap((r) => {
    const end = r.len == null ? Infinity : r.at + r.len;
    if (r.at >= p) return [{ ...r, at: r.at + d }];
    if (end <= p) return [r];
    const head = p - r.at;
    return [
      { ...r, len: head },
      { ...r, at: p + d, from: r.from + head, len: r.len == null ? null : r.len - head },
    ];
  });
}

/** Nearest beat of the grid to t (seconds), or t without a grid. */
export function snapToBeat(tempo, t) {
  const beats = gridBeats(tempo, t - 4, t + 4);
  if (!beats.length) return t;
  return beats.reduce((best, b) => (Math.abs(b.t - t) < Math.abs(best - t) ? b.t : best), beats[0].t);
}

/** Bar line at or before t (not in the count-in): { t, g, bar, beats, beat }. */
export function barAt(tempo, t) {
  const bars = gridBeats(tempo, 0, t + 0.001).filter((b) => b.inBar === 0 && b.g != null);
  const b = bars.at(-1);
  return b ? { t: b.t, g: b.g, bar: b.bar, beats: b.seg.beats, beat: b.seg.beat } : null;
}

// Sections typed with a bar count: the one holding `bar` grows by n.
function growSection(sections, bar, n) {
  let first = 1;
  let done = false;
  const next = (sections || []).map((s) => {
    const bars = Number(s.bars) || 0;
    if (!done && bars && bar < first + bars) {
      done = true;
      return { ...s, bars: bars + n };
    }
    first += bars;
    return s;
  });
  return done ? next : null;
}

/**
 * Inserts n empty bars at the bar where the playhead is: every stem is cut
 * there and what follows moves later, together with the grid, the cues, the
 * prompter changes and the sections, into the song’s draft. Resolves with the updated item (to
 * reload the player) and a note for what could not follow (the video).
 */
export async function insertBars({ item, tempo, position, n }) {
  const bar = barAt(tempo, Math.max(0, position));
  if (!bar) throw new Error('Griglia non disponibile: imposta BPM e metro del brano');
  const p = bar.t;
  const d = n * bar.beats * bar.beat;
  const shiftBeats = n * bar.beats;
  const notes = [];

  // Media document: regions, cue sheet, video.
  const regions = { ...regionsOf(item) };
  stemsOf(item).forEach((s) => {
    regions[s.id] = insertGap(stemRegions(item, s.id), p, d);
  });
  if (regions[GRID_KEY]) regions[GRID_KEY] = { ...regions[GRID_KEY], regions: insertGap(regions[GRID_KEY].regions, p, d) };
  const media = { regions };
  if (item.cueTrack) {
    const sheet = cueTrackOf(item);
    media.cueTrack = { ...item.cueTrack, cues: sheet.cues.map((c) => (c.g >= bar.g ? { ...c, g: c.g + shiftBeats } : c)) };
  }
  const video = videoOf(item);
  if (video) {
    if ((video.offset || 0) >= p) media.video = { ...video, offset: (video.offset || 0) + d };
    else notes.push('il video non si può tagliare: resta dov’è');
  }
  const beforeMedia = Object.fromEntries(Object.keys(media).map((k) => [k, item[k] ?? null]));

  // Setlist item: hand grid, prompter changes, sections, duration.
  const fields = {};
  const grid = gridOf(item);
  if (grid.anchors.length) {
    const kept = grid.anchors.filter((a) => a.beat < bar.g).concat(grid.anchors.filter((a) => a.beat >= bar.g).map((a) => ({ beat: a.beat + shiftBeats, t: a.t + d })));
    // The new bars keep the tempo of the bar where they go.
    const pins = [
      { beat: bar.g, t: p },
      { beat: bar.g + shiftBeats, t: p + d },
    ].filter((x) => !kept.some((a) => a.beat === x.beat));
    fields.grid = { ...item.grid, anchors: [...kept, ...pins].sort((a, b) => a.beat - b.beat) };
  }
  if (item.prompter?.cues?.length) {
    fields.prompter = { ...item.prompter, cues: item.prompter.cues.map((c) => (c.t >= p ? { ...c, t: Math.round((c.t + d) * 1000) / 1000 } : c)) };
  }
  const sections = growSection(item.sections, bar.bar, n);
  if (sections) fields.sections = sections;
  if (item.duration) fields.duration = Math.round(item.duration + d);
  // Into the song's draft, saved with "Salva".
  editDraft(item.id, { media, item: fields });
  const beforeItem = Object.fromEntries(Object.keys(fields).map((k) => [k, item[k] ?? null]));
  // For undo / redo (lib/arrangeHistory).
  const step = { label: `${n === 1 ? '1 battuta inserita' : `${n} battute inserite`} alla battuta ${bar.bar}`, reload: true, before: { media: beforeMedia, item: beforeItem }, after: { media, item: fields } };
  return { item: { ...item, ...media, ...fields }, bar: bar.bar, seconds: d, notes, step };
}

// ---------- Tempo and metre of the song (transport bar) ----------

/**
 * Tempo ({ bpm }) or metre ({ timeSig }) of the song in the player, typed in
 * the transport bar: the song's fields (the "Brano" panel follows), the
 * sections that had the same value and the tempo of the grid, which wins
 * over the one detected in the audio. Into the song's draft, undoable; the
 * tempo map is built at load, so the song is reloaded where it was.
 */
export function changeTempo({ song, player, notify }, patch) {
  const g = gridOf(song);
  if ('bpm' in patch && g.anchors.length > 1) {
    notify('Con più ancoraggi della griglia a mano il tempo segue gli ancoraggi: toglili con Griglia a mano → Automatica', true);
    return;
  }
  const fields = {};
  let sections = song.sections || [];
  if ('bpm' in patch) {
    fields.bpm = Math.round(patch.bpm);
    fields.grid = { ...g, bpm: patch.bpm };
    sections = sections.map((s) => (Number(s.bpm) > 0 && Number(s.bpm) === Number(song.bpm) ? { ...s, bpm: fields.bpm } : s));
  }
  if ('timeSig' in patch) {
    fields.timeSig = patch.timeSig;
    sections = sections.map((s) => (s.timeSig && s.timeSig === (song.timeSig || '4/4') ? { ...s, timeSig: patch.timeSig } : s));
  }
  if (JSON.stringify(sections) !== JSON.stringify(song.sections || [])) fields.sections = sections;
  const before = Object.fromEntries(Object.keys(fields).map((k) => [k, song[k] ?? null]));
  const label = 'bpm' in patch ? `Tempo ${Math.round(patch.bpm * 100) / 100} BPM` : `Metro ${patch.timeSig}`;
  editDraft(song.id, { item: fields });
  recordStep(song.id, { label, reload: true, before: { media: {}, item: before }, after: { media: {}, item: fields } });
  player.reload();
  notify(`${label} · “Salva” nell’Arrangement per tenerlo`);
}

// ---------- Segments (regions) of one track ----------

/** End of a segment on the timeline (an open one lasts to the end of its file). */
export const segmentEnd = (g, fileSeconds) => (g.len == null ? g.at + Math.max(0, (fileSeconds || 0) - (g.from || 0)) : g.at + g.len);

/** Index of the segment heard at t (a later one wins where they overlap), or -1. */
export function segmentIndexAt(regions, t, fileSeconds) {
  let best = -1;
  regions.forEach((g, i) => {
    if (t >= g.at && t < segmentEnd(g, fileSeconds) && (best < 0 || g.at >= regions[best].at)) best = i;
  });
  return best;
}

export const moveSegment = (regions, index, delta) =>
  regions.map((g, i) => (i === index ? { ...g, at: Math.round((g.at + delta) * 1e4) / 1e4 } : g));

/** A track whose segments were all deleted plays nothing (not the whole file). */
export const removeSegment = (regions, index) => {
  const next = regions.filter((_, i) => i !== index);
  return next.length ? next : [{ at: 0, from: 0, len: 0 }];
};

/** Cuts the segment heard at t in two: { regions, index } (the right part) or null. */
export function cutAt(regions, t, fileSeconds) {
  const i = segmentIndexAt(regions, t, fileSeconds);
  if (i < 0) return null;
  const g = regions[i];
  const head = t - g.at;
  const end = segmentEnd(g, fileSeconds);
  if (head < 0.01 || end - t < 0.01) return null;
  const right = { ...g, at: t, from: (g.from || 0) + head, len: g.len == null ? null : g.len - head };
  const next = [...regions.slice(0, i), { ...g, len: head }, right, ...regions.slice(i + 1)];
  return { regions: next, index: i + 1 };
}

const MIN_LEN = 0.01;
const r4 = (t) => Math.round(t * 1e4) / 1e4;

/**
 * Segment `index` with its start or end edge moved to t: a trim, the audio
 * stays where it is (the start can go back to the start of the file).
 */
export function trimSegment(regions, index, edge, t, fileSeconds) {
  return regions.map((g, i) => {
    if (i !== index) return g;
    const from = g.from || 0;
    const end = segmentEnd(g, fileSeconds);
    if (edge === 'start') {
      const at = Math.min(end - MIN_LEN, Math.max(g.at - from, t));
      const d = at - g.at;
      return { ...g, at: r4(at), from: r4(from + d), len: g.len == null ? null : r4(g.len - d) };
    }
    const fileEnd = g.at - from + (fileSeconds || 0);
    return { ...g, len: r4(Math.max(g.at + MIN_LEN, Math.min(fileEnd, t)) - g.at) };
  });
}

export const toggleSegmentMute = (regions, index) => regions.map((g, i) => (i === index ? { ...g, muted: !g.muted } : g));
