// Song map of the Palco view: the sections of the song on the tempo map, and
// where a jump lands on the grid.
import { engine, engineStatus } from './engine';
import { gridBeats } from './grid';

// When a jump happens, from the playhead.
export const JUMP_QUANTS = [
  ['beat', 'Movimento', 'Salta al prossimo movimento'],
  ['bar', 'Battuta', 'Salta alla prossima battuta'],
  ['section', 'Fine sezione', 'Salta alla fine della sezione in corso'],
];

// The readers need a moment to get ahead: a beat closer than this is too late.
const MIN_LEAD = 0.12;

// Every section has its colour, in the order of the song.
const COLORS = ['#38bdf8', '#f59e0b', '#a78bfa', '#34d399', '#f472b6', '#fb923c', '#84cc16', '#e879f9', '#2dd4bf', '#f43f5e', '#facc15', '#818cf8'];

export const SECTION_NAMES = ['Intro', 'Strofa', 'Pre-ritornello', 'Ritornello', 'Bridge', 'Solo', 'Interludio', 'Outro'];

// Sections that take up room on the song: the ones the markers work on.
const placed = (item) => (item?.sections || []).filter((s) => Number(s.bars) >= 1);

/** Beats of the song from bar 1 (no count-in). */
export function songBeats(tempo, duration) {
  if (!tempo || !(duration > 0)) return [];
  return gridBeats(tempo, tempo.origin - 1, duration).filter((b) => b.g != null);
}

/**
 * Sections of the song on the grid: [{ index, label, name, color, start, end,
 * bar, barIndex, endBar }]. They follow one another from bar 1, the last one
 * goes on to the end of the song, as in the tempo map (src-tauri/src/audio/tempo.rs).
 * index: place among the ones the marker edits work on.
 */
export function songSections(item, beats, duration) {
  const bars = beats.filter((b) => b.inBar === 0);
  const list = [];
  let at = 0;
  placed(item).forEach((s, i) => {
    const n = Math.floor(Number(s.bars));
    if (!s.gap && bars[at]) {
      const name = (s.label || '').trim();
      const nth = list.length;
      list.push({ index: i, name, label: name || `Sezione ${nth + 1}`, color: COLORS[nth % COLORS.length], start: bars[at].t, bar: bars[at].bar, barIndex: at, bars: n });
    }
    at += n;
  });
  const sections = list.map((s, i) => {
    const next = list[i + 1];
    return { ...s, end: next ? next.start : duration, endBar: next ? next.bar : null };
  });
  return sections.filter((s) => s.end > s.start);
}

export function sectionIndexAt(sections, t) {
  return sections.findIndex((s) => t >= s.start && t < s.end);
}

/** When a jump asked now happens: on the next beat, bar or end of the section. */
export function jumpTime(quant, position, beats, sections) {
  const from = position + MIN_LEAD;
  if (quant === 'section') {
    const end = sections.find((s) => s.end >= from && s.start <= position)?.end;
    if (end != null) return end;
  }
  const hit = beats.find((b) => b.t >= from && (quant === 'beat' || b.inBar === 0));
  return hit ? hit.t : from;
}

// Resolutions of the grid on the waveform: bars between two lines, or every beat.
export const GRID_RESOLUTIONS = [
  ['8', '8 battute'],
  ['4', '4 battute'],
  ['2', '2 battute'],
  ['1', 'Battuta'],
  ['beat', 'Movimento'],
];

/** Beats that are a line of the grid at a resolution. */
export function gridLines(beats, res) {
  if (res === 'beat') return beats;
  const n = Number(res) || 1;
  return beats.filter((b) => b.inBar === 0 && (b.bar - 1) % n === 0);
}

/** Time of the line nearest to t, or t itself with no lines. */
export function nearestLine(lines, t) {
  let best = t;
  let gap = Infinity;
  lines.forEach((b) => {
    if (Math.abs(b.t - t) < gap) {
      gap = Math.abs(b.t - t);
      best = b.t;
    }
  });
  return best;
}

// ---------- Markers on the waveform ----------
// A marker is the start of a section. A section is stored as a number of bars
// after the one before. When the first marker is not on bar 1 (a precount in the
// audio), the bars before it are a leading entry with `gap: true`, which is not a
// section: it keeps the tempo and metre of the one it comes from, so the grid and
// the cues don't notice. Bar indexes count the bars of the song from 0.

/** Bars of the song from the beats. */
export const songBars = (beats) => beats.filter((b) => b.inBar === 0);

/** Index of the bar nearest to t. */
export function nearestBarIndex(bars, t) {
  let best = 0;
  bars.forEach((b, i) => {
    if (Math.abs(b.t - t) < Math.abs(bars[best].t - t)) best = i;
  });
  return best;
}

// A new section has no tempo of its own, so the grid (and the cues on it) stays
// exactly as it was. The metre is what the setlist editor and the web need to keep it.
const newSection = (item, label, bars) => ({ label, bars, bpm: null, timeSig: item.timeSig || '4/4' });
const gapOf = (s, bars) => ({ ...s, label: '', bars, gap: true });
const withoutGap = ({ gap, ...s }) => s;

/**
 * What the sections do to the grid, whatever their names and markers: runs of
 * bars with the same tempo and metre (same rules as the tempo map, tempo.rs; the
 * last one goes on to the end). [] = the song's own tempo and metre throughout.
 */
export function sectionTiming(item) {
  const base = item?.timeSig || '4/4';
  const runs = [];
  (item?.sections || [])
    .filter((s) => Number(s.bpm) > 0 || s.timeSig)
    .forEach((s) => {
      const bpm = Number(s.bpm) > 0 ? Number(s.bpm) : null;
      const sig = s.timeSig || base;
      const bars = Math.max(1, Math.floor(Number(s.bars) || 1));
      const last = runs.at(-1);
      if (last && last[1] === bpm && last[2] === sig) last[0] += bars;
      else runs.push([bars, bpm, sig]);
    });
  if (runs.length) runs.at(-1)[0] = null;
  return runs.length === 1 && runs[0][1] === null && runs[0][2] === base ? [] : runs;
}

const startsOf = (list) => {
  let at = 0;
  return list.map((s) => {
    const start = at;
    at += Math.floor(Number(s.bars));
    return start;
  });
};

/** Marker added on bar `bar`: { sections, index } with the new one, or null if one is already there. */
export function addMarker(item, bar, totalBars, label = '') {
  const list = placed(item);
  if (!list.length) {
    if (bar === 0) return { sections: [newSection(item, label, totalBars)], index: 0 };
    return { sections: [gapOf(newSection(item, '', bar), bar), newSection(item, label, Math.max(1, totalBars - bar))], index: 1 };
  }
  if (bar === 0 && list[0].gap) return { sections: [{ ...withoutGap(list[0]), label }, ...list.slice(1)], index: 0 };
  const starts = startsOf(list);
  if (starts.includes(bar)) return null;
  const i = starts.filter((s) => s < bar).length - 1;
  const end = i === list.length - 1 ? Math.max(totalBars, starts[i] + Number(list[i].bars)) : starts[i + 1];
  // The new one goes on with the tempo and metre of the section it splits.
  const sections = [...list.slice(0, i), { ...list[i], bars: bar - starts[i] }, { ...withoutGap(list[i]), label, bars: end - bar }, ...list.slice(i + 1)];
  return { sections, index: i + 1 };
}

/**
 * Marker `index` moved on bar `bar`, staying between its neighbours: { sections,
 * index } with its new place, or null if it can't move. Moving the first one
 * opens or closes the bars before it, so all the indexes may shift by one.
 */
export function moveMarker(item, index, bar) {
  const list = placed(item);
  const s = list[index];
  if (!s || s.gap) return null;
  const starts = startsOf(list);
  const end = starts[index] + Math.floor(Number(s.bars));
  const prev = list[index - 1];
  const to = Math.max(!prev || prev.gap ? 0 : starts[index - 1] + 1, Math.min(end - 1, bar));
  if (to === starts[index]) return null;
  if (!prev) return { sections: [gapOf(s, to), { ...s, bars: end - to }, ...list.slice(1)], index: 1 };
  if (prev.gap && to === 0) return { sections: [{ ...s, bars: end }, ...list.slice(2)], index: 0 };
  return { sections: list.map((x, i) => (i === index - 1 ? { ...x, bars: to - starts[i] } : i === index ? { ...x, bars: end - to } : x)), index };
}

/** Marker removed: the section before takes its bars (removing the first, the one after). */
export function removeMarker(item, index) {
  const list = placed(item);
  const into = index === 0 ? 1 : index - 1;
  if (!list[index]) return null;
  const rest = list.flatMap((s, i) => (i === index ? [] : i === into ? [{ ...s, bars: Number(s.bars) + Number(list[index].bars) }] : [s]));
  return rest.every((s) => s.gap) ? [] : rest;
}

export function renameMarker(item, index, label) {
  return placed(item).map((s, i) => (i === index ? { ...s, label } : s));
}

// ---------- Moving between sections ----------

/** Goes to a section: on the grid and without gaps while playing, at once when stopped. */
export function jumpToSection(s, quant, beats, sections) {
  const st = engineStatus();
  if (!st.playing || st.position < 0) engine.locate(s.start);
  else engine.scheduleJump({ at: jumpTime(quant, st.position, beats, sections), to: s.start, repeat: false });
}
