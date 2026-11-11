// Tempo and metre changes inside a song, set in the desktop Arrangement (lane "Click · Tempo"):
//   item.tempoChanges = [{ bar, bpm, ramp, timeSig }]
// from bar `bar` (counted from 1: 2 = the second bar of the song) the tempo is
// `bpm`, at once (ramp 0) or gradually over `ramp` bars (rallentando or
// accelerando: the tempo reaches `bpm` at bar + ramp), and the bars are in
// `timeSig` (e.g. "6/8"). Either can be missing (null): a change of metre only
// keeps the tempo, a change of tempo only keeps the metre. The audio is not
// touched: they move the click, the grid and the cues on it, for songs whose
// recording changes tempo. Shared by the desktop engine (tempo.rs reads the
// sections made here), the web metronome and the grid of the web player.

export const MIN_BPM = 20;
export const MAX_BPM = 400;
export const MAX_RAMP = 64;

const clampBpm = (v) => Math.round(Math.max(MIN_BPM, Math.min(MAX_BPM, Number(v))) * 100) / 100;

/** "6/8" and the like (1–32 beats of 1, 2, 4, 8, 16, 32), or null. */
export function cleanTimeSig(v) {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(String(v ?? ''));
  if (!m) return null;
  const [n, d] = [Number(m[1]), Number(m[2])];
  return n >= 1 && n <= 32 && [1, 2, 4, 8, 16, 32].includes(d) ? `${n}/${d}` : null;
}

/** Valid changes of a song, by bar (one per bar): a tempo, a metre or both. */
export function tempoChangesOf(item) {
  const byBar = new Map();
  (Array.isArray(item?.tempoChanges) ? item.tempoChanges : []).forEach((c) => {
    const bar = Math.floor(Number(c?.bar));
    const bpm = Number(c?.bpm) > 0 ? clampBpm(c.bpm) : null;
    const timeSig = cleanTimeSig(c?.timeSig);
    if (!(bar >= 2) || (!bpm && !timeSig)) return;
    const ramp = bpm ? Math.max(0, Math.min(MAX_RAMP, Math.floor(Number(c.ramp) || 0))) : 0;
    byBar.set(bar, { bar, bpm, ramp, timeSig });
  });
  return [...byBar.values()].sort((a, b) => a.bar - b.bar);
}

/** Cleaned list to store (the same rules as tempoChangesOf). */
export const cleanTempoChanges = (list) => tempoChangesOf({ tempoChanges: list });

/** The changes after `bar` moved by `bars` (bars inserted or removed before them). */
export const shiftTempoChanges = (list, bar, bars) => cleanTempoChanges((list || []).map((c) => (c.bar >= bar ? { ...c, bar: c.bar + bars } : c)));

// Sections as the tempo map reads them (tempo.rs plan): only those with a tempo or a metre.
const runsOf = (item) =>
  (item?.sections || [])
    .filter((s) => Number(s.bpm) > 0 || s.timeSig)
    .map((s) => ({ label: s.label || null, bars: Math.max(1, Math.floor(Number(s.bars) || 1)), bpm: Number(s.bpm) > 0 ? Number(s.bpm) : null, timeSig: s.timeSig || null }));

/**
 * Sections for the tempo map with the tempo changes in them: the sections cut
 * where a change starts or a ramp ends, each piece with its tempo (null: the
 * song's) or with `ramp: { from, to, start, end }` = the piece goes from
 * start to end (0..1) of a ramp from `from` (null: the song's tempo) to `to`.
 * null when the song has no tempo changes (the sections as they are).
 */
export function tempoSections(item) {
  const changes = tempoChangesOf(item);
  if (!changes.length) return null;
  const sig = item?.timeSig || '4/4';
  const runs = runsOf(item);
  if (!runs.length) runs.push({ label: null, bars: null, bpm: null, timeSig: null });
  // Start (bar index from 0) of each run; the last one goes on for ever.
  let at = 0;
  const starts = runs.map((r) => {
    const s = at;
    at += r.bars || 0;
    return s;
  });
  const runAt = (bar) => Math.max(0, starts.findLastIndex((s) => s <= bar));
  // The changes of tempo; those of metre on their own.
  const events = changes.filter((c) => c.bpm).map((c) => ({ at: c.bar - 1, bpm: c.bpm, ramp: c.ramp }));
  const sigs = changes.filter((c) => c.timeSig).map((c) => ({ at: c.bar - 1, timeSig: c.timeSig }));
  // Tempo just before bar `bar`, with the changes before `upto` (index) only.
  const tempoBefore = (bar, upto) => {
    const prev = events.slice(0, upto).findLast((c) => c.at < bar);
    const r = runAt(Math.max(0, bar - 1));
    // A section with its own tempo that starts after that change wins over it.
    if (prev && !(runs[r].bpm && starts[r] > prev.at)) return prev.bpm;
    return runs[r].bpm;
  };
  const cuts = new Set(starts);
  sigs.forEach((c) => cuts.add(c.at));
  events.forEach((c) => {
    cuts.add(c.at);
    if (c.ramp) cuts.add(c.at + c.ramp);
  });
  const list = [...cuts].sort((a, b) => a - b);
  return list.map((a, i) => {
    const b = list[i + 1] ?? null;
    const r = runAt(a);
    const run = runs[r];
    // The metre: the last change of metre, unless a section with its own starts after it.
    const sc = sigs.findLast((c) => c.at <= a);
    const timeSig = sc && !(run.timeSig && starts[r] > sc.at) ? sc.timeSig : run.timeSig || sig;
    const piece = { label: starts[r] === a ? run.label : null, bars: b == null ? null : b - a, bpm: null, timeSig };
    const ci = events.findLastIndex((c) => c.at <= a);
    const c = events[ci];
    // The section's own tempo when it starts after the last change.
    if (!c || (run.bpm && starts[r] > c.at)) return { ...piece, bpm: run.bpm };
    if (c.ramp && a < c.at + c.ramp) {
      const end = Math.min(b ?? c.at + c.ramp, c.at + c.ramp);
      return { ...piece, bpm: null, ramp: { from: tempoBefore(c.at, ci), to: c.bpm, start: (a - c.at) / c.ramp, end: (end - c.at) / c.ramp } };
    }
    return { ...piece, bpm: c.bpm };
  });
}

/**
 * Tempo of click k of n of a piece (`base` = the song's tempo): constant, or
 * on a ramp in the middle of the click (same rule as tempo.rs).
 */
export function pieceBpm(piece, base, k = 0, n = 1) {
  const r = piece?.ramp;
  if (!r) return Number(piece?.bpm) > 0 ? Number(piece.bpm) : base;
  const from = Number(r.from) > 0 ? Number(r.from) : base;
  const u = r.start + ((r.end - r.start) * (k + 0.5)) / Math.max(1, n);
  return from + (r.to - from) * u;
}
