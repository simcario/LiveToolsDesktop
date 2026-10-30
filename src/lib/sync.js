// Alignment of the click/grid with the audio of the song.
// Source: a click stem (beat by beat) or a rhythmic stem (tempo + bar 1),
// chosen automatically or by the user; per song, kept on this computer.
// The grid set by hand is stored on the song (`grid`, shared by the band):
//   { from, to, anchors: [{ beat, t }], bpm }
// from/to = range of the automatic analysis (seconds, null = whole track);
// anchors = warp (beat 0 = bar 1, beat 1) that replaces the analysis; bpm =
// tempo when there is a single anchor, or typed in the Arrangement (it wins
// over the tempo detected in the audio).
import { invoke } from '@tauri-apps/api/core';

const KEY = 'livetools-desktop:sync';
const CLICK_RE = /\b(click|clic|metro(nome)?)\b/i;
const RHYTHM_RE = /(drum|batt|perc|kick|cassa|snare|rullante|hat|loop|beat|groove|ritm|tom)/i;

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

// { source: 'auto' | 'none' | stemId, nudgeMs, shiftBeats }
export function getSyncChoice(itemId) {
  return { source: 'auto', nudgeMs: 0, shiftBeats: 0, ...(readAll()[itemId] || {}) };
}

export function setSyncChoice(itemId, patch) {
  const all = readAll();
  all[itemId] = { ...getSyncChoice(itemId), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage unavailable
  }
  return all[itemId];
}

export const isClickStem = (s) => s.role === 'click' || CLICK_RE.test(s.name || '') || CLICK_RE.test(s.file || '');

/** The best reference among the stems: click first, then drums/loops, then the first main stem. */
export function autoSource(stems) {
  const click = stems.find(isClickStem);
  if (click) return { stem: click, mode: 'click' };
  const rhythm = stems.find((s) => RHYTHM_RE.test(s.name || '') || RHYTHM_RE.test(s.file || ''));
  if (rhythm) return { stem: rhythm, mode: 'rhythm' };
  const main = stems.find((s) => (s.role || 'main') === 'main');
  return main ? { stem: main, mode: 'rhythm' } : null;
}

export function resolveSource(stems, choice) {
  if (choice.source === 'none') return null;
  if (choice.source !== 'auto') {
    const stem = stems.find((s) => s.id === choice.source);
    if (stem) return { stem, mode: isClickStem(stem) ? 'click' : 'rhythm' };
  }
  return autoSource(stems);
}

function sigInfo(timeSig) {
  const [n, d] = String(timeSig || '4/4').split('/').map(Number);
  const beats = n > 0 && n <= 16 ? n : 4;
  return { beats, compound: d === 8 && n % 3 === 0 && n > 3 };
}

// With tempo changes in the sections only bar 1 is taken from the audio.
function tempoChanges(item) {
  const bpms = (item.sections || []).map((s) => Number(s.bpm)).filter((b) => b > 0);
  return bpms.some((b) => b !== bpms[0]) || (bpms.length > 0 && Number(item.bpm) > 0 && bpms[0] !== Number(item.bpm));
}

function firstSection(item) {
  const s = (item.sections || [])[0];
  const bpm = Number(s?.bpm) || Number(item.bpm);
  if (!s?.bars || !bpm) return null;
  return (Number(s.bars) * sigInfo(s.timeSig || item.timeSig).beats * 60) / bpm;
}

export function gridOf(item) {
  const g = item?.grid || {};
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    from: num(g.from),
    to: num(g.to),
    anchors: (Array.isArray(g.anchors) ? g.anchors : [])
      .filter((a) => Number.isInteger(a?.beat) && a.beat >= 0 && Number.isFinite(a?.t))
      .sort((a, b) => a.beat - b.beat),
    bpm: Number(g.bpm) > 0 ? Number(g.bpm) : null,
  };
}

/** Changes when the analysis has to be redone. */
export const rangeKey = (item) => {
  const g = gridOf(item);
  return `${g.from ?? ''}|${g.to ?? ''}`;
};

export function analyze(item, source, local) {
  const sig = sigInfo(item.timeSig);
  const g = gridOf(item);
  const section = source.mode === 'rhythm' && tempoChanges(item) ? firstSection(item) : null;
  return invoke('analyze_sync', {
    request: {
      path: local,
      mode: source.mode,
      bpm: Number(item.bpm) > 0 ? Number(item.bpm) : null,
      beatsPerBar: sig.beats,
      compound: sig.compound,
      window: g.to ?? (section ? (g.from || 0) + section : null),
      from: g.from,
    },
  });
}

/** Engine sync spec from an analysis plus the user's corrections. */
// `regions`: placement of the reference stem (the analysis is in file time).
export function syncSpec(item, analysis, choice, regions = null) {
  const g = gridOf(item);
  if (g.anchors.length) return { kind: 'anchors', anchors: g.anchors, bpm: g.bpm ?? analysis?.bpm ?? null };
  if (!analysis) return null;
  const nudge = (Number(choice.nudgeMs) || 0) / 1000;
  const shift = Number(choice.shiftBeats) || 0;
  if (analysis.mode === 'click') {
    const at = Math.max(0, Math.min(analysis.beats.length - 2, analysis.downbeat + shift));
    const beats = analysis.beats.slice(at);
    // Tempo typed by hand (Arrangement): bar 1 from the click stem, then that tempo.
    if (g.bpm) {
      const first = regions ? placeBeats(beats, regions)[0] : beats[0];
      if (Number.isFinite(first)) return { kind: 'offset', origin: first + nudge, bpm: g.bpm };
    }
    return { kind: 'beats', beats: (regions ? placeBeats(beats, regions) : beats).map((t) => t + nudge), beatsPerBar: analysis.beatsPerBar };
  }
  const sig = sigInfo(item.timeSig);
  const beat = 60 / analysis.bpm / (sig.compound ? 3 : 1);
  const placed = regions ? placeInRegions(regions, analysis.origin) : null;
  const origin = placed ?? (regions?.[0] ? analysis.origin + regions[0].at - regions[0].from : analysis.origin);
  return {
    kind: 'offset',
    origin: origin + shift * beat + nudge,
    // The detected tempo is more precise than the song's, unless sections change
    // it or it was typed by hand in the Arrangement (grid.bpm).
    bpm: tempoChanges(item) ? null : g.bpm ?? analysis.bpm,
  };
}

// ---------- Reference stem moved or cut (Arrangement) ----------

/** Song time of second t of a file played through regions (null: not played). */
export function placeInRegions(regions, t) {
  for (const r of regions || []) {
    const len = r.len == null ? Infinity : r.len;
    if (t >= r.from && t < r.from + len) return r.at + (t - r.from);
  }
  return null;
}

// Beats of the click moved with its regions; gaps opened by inserted bars
// get beats at the tempo around them.
function placeBeats(beats, regions) {
  const placed = beats.map((t) => placeInRegions(regions, t)).filter((t) => t != null).sort((a, b) => a - b);
  if (placed.length < 3) return placed;
  const steps = placed.slice(1).map((t, i) => t - placed[i]).sort((a, b) => a - b);
  const m = steps[steps.length >> 1];
  const out = [placed[0]];
  for (let i = 1; i < placed.length; i += 1) {
    const gap = placed[i] - placed[i - 1];
    if (gap > m * 1.5) {
      const k = Math.round(gap / m);
      for (let j = 1; j < k; j += 1) out.push(placed[i - 1] + (gap * j) / k);
    }
    out.push(placed[i]);
  }
  return out;
}
