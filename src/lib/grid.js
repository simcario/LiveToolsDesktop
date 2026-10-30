// Grid of the tempo map as beats (for drawing and for the warp editor), and
// the warp operations on the anchors of the song's grid (see sync.js).

// Clicks of a segment, or null when it goes on until the next one / forever.
function clicksOf(s, next) {
  if (s.clicks != null) return s.clicks;
  if (s.bars != null) return s.bars * s.beats;
  return next ? Math.round((next.start - s.start) / s.beat) : null;
}

/**
 * Beats of the map between t0 and t1: { t, g, bar, inBar, seg }. g is the
 * beat counted from bar 1 (null in the count-in), the unit of the anchors.
 */
export function gridBeats(tempo, t0, t1) {
  const out = [];
  const segs = tempo?.segments || [];
  let g0 = 0;
  segs.forEach((s, i) => {
    const n = clicksOf(s, segs[i + 1]);
    const end = n != null ? s.start + n * s.beat : Infinity;
    const first = s.firstBeat || 0;
    for (let k = Math.max(0, Math.ceil((t0 - s.start) / s.beat - 1e-9)); ; k += 1) {
      const t = s.start + k * s.beat;
      if (t >= Math.min(end, t1) - 1e-9 || (n != null && k >= n)) break;
      const b = first + k;
      out.push({ t, g: s.countIn ? null : g0 + k, bar: s.firstBar + Math.floor(b / s.beats), inBar: b % s.beats, seg: s });
    }
    if (!s.countIn && n != null) g0 += n;
  });
  return out;
}

/** Time of beat g in the map (null if outside it). */
export function timeOfBeat(tempo, g) {
  let g0 = 0;
  const segs = tempo?.segments || [];
  for (let i = 0; i < segs.length; i += 1) {
    const s = segs[i];
    if (s.countIn) continue;
    const n = clicksOf(s, segs[i + 1]);
    if (n == null || g < g0 + n) return s.start + (g - g0) * s.beat;
    g0 += n;
  }
  return null;
}

const MIN_GAP = 0.03; // s between two anchors

/** Allowed range for anchor `beat` given the other anchors (times grow with beats). */
export function anchorRange(anchors, beat) {
  let lo = -Infinity;
  let hi = Infinity;
  anchors.forEach((a) => {
    if (a.beat < beat) lo = Math.max(lo, a.t + MIN_GAP);
    if (a.beat > beat) hi = Math.min(hi, a.t - MIN_GAP);
  });
  return [lo, hi];
}

/**
 * Anchors after moving beat `beat` to time `t`. With no anchors yet, bar 1
 * stays where it is (pinned at `origin`), as in a DAW's time warp.
 */
export function moveAnchor(anchors, beat, t, origin) {
  let list = anchors.filter((a) => a.beat !== beat);
  if (!anchors.length && beat !== 0 && Number.isFinite(origin)) list = [{ beat: 0, t: origin }];
  const [lo, hi] = anchorRange(list, beat);
  if (lo > hi) return anchors;
  return [...list, { beat, t: Math.min(hi, Math.max(lo, t)) }].sort((a, b) => a.beat - b.beat);
}

/** Whole grid moved by `delta` seconds (with no anchors: beat `beat` pinned where it lands). */
export function shiftAnchors(anchors, delta, beat, t) {
  if (!anchors.length) return [{ beat, t }];
  return anchors.map((a) => ({ ...a, t: a.t + delta }));
}

export const removeAnchor = (anchors, beat) => anchors.filter((a) => a.beat !== beat);

/** Nearest transient to t within `max` seconds, or null. `onsets` is sorted. */
export function nearestOnset(onsets, t, max) {
  if (!onsets?.length) return null;
  let lo = 0;
  let hi = onsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (onsets[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  const c = [onsets[lo], onsets[lo - 1]].filter((v) => v !== undefined);
  const best = c.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
  return Math.abs(best - t) <= max ? best : null;
}

/** BPM from tap intervals (s): median of the last ones, null with fewer than 3 taps. */
export function tapBpm(taps) {
  if (taps.length < 3) return null;
  const d = taps
    .slice(1)
    .map((t, i) => t - taps[i])
    .slice(-8)
    .sort((a, b) => a - b);
  const m = d[d.length >> 1];
  return m > 0 ? Math.round((60 / m) * 100) / 100 : null;
}
