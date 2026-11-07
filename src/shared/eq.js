// Channel section of a track (desktop/tablet Mixer → click on the track name):
// input gain and EQ, saved with the song on the stem (stem.input, stem.eq) or on
// the cue track (cueTrack.input, cueTrack.eq). The desktop engine (Rust,
// audio/eq.rs) and the web rehearsal (offline, eqProcess below) use the same
// filters: RBJ biquads, 12 dB/oct high/low pass, shelves with slope 1.
//
// stem.eq = { on, hpf: { on, f }, lpf: { on, f }, bands: [{ t: 'bell'|'low'|'high', f, g, q }] × 5 }
// A band with gain 0 does nothing (and costs nothing).

export const EQ_BANDS = 5;
export const EQ_FREQ = [20, 20000];
export const EQ_GAIN = 15; // ± dB of a band
export const EQ_Q = [0.3, 10];
export const INPUT_GAIN = 24; // ± dB of the input gain
export const BAND_TYPES = { bell: 'Campana', low: 'Shelf basso', high: 'Shelf alto' };

const DEFAULT_BANDS = [
  { t: 'low', f: 100, g: 0, q: 1 },
  { t: 'bell', f: 300, g: 0, q: 1 },
  { t: 'bell', f: 1000, g: 0, q: 1 },
  { t: 'bell', f: 3000, g: 0, q: 1 },
  { t: 'high', f: 8000, g: 0, q: 1 },
];

const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);

/** EQ of a stem (or of the cue track) with every field present and in range. */
export function eqOf(src) {
  const e = src?.eq || {};
  return {
    on: e.on !== false,
    hpf: { on: !!e.hpf?.on, f: clamp(e.hpf?.f, EQ_FREQ[0], EQ_FREQ[1], 80) },
    lpf: { on: !!e.lpf?.on, f: clamp(e.lpf?.f, EQ_FREQ[0], EQ_FREQ[1], 16000) },
    bands: DEFAULT_BANDS.map((d, i) => {
      const b = e.bands?.[i] || {};
      return {
        t: BAND_TYPES[b.t] ? b.t : d.t,
        f: clamp(b.f, EQ_FREQ[0], EQ_FREQ[1], d.f),
        g: clamp(b.g, -EQ_GAIN, EQ_GAIN, 0),
        q: clamp(b.q, EQ_Q[0], EQ_Q[1], d.q),
      };
    }),
  };
}

export const inputOf = (src) => clamp(src?.input, -INPUT_GAIN, INPUT_GAIN, 0);

/** Does the EQ change the sound at all? */
export const eqActive = (eq) => eq.on && (eq.hpf.on || eq.lpf.on || eq.bands.some((b) => b.g !== 0));

/** The flat EQ (what "Piatto" goes back to). */
export const flatEq = () => eqOf(null);

// RBJ cookbook coefficients, normalised (a0 = 1): [b0, b1, b2, a1, a2].
function coefs(kind, f, g, q, sr) {
  const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;
  if (kind === 'hpf' || kind === 'lpf') {
    const al = sw / (2 * Math.SQRT1_2);
    const hp = kind === 'hpf';
    b0 = hp ? (1 + cw) / 2 : (1 - cw) / 2;
    b1 = hp ? -(1 + cw) : 1 - cw;
    b2 = b0;
    a0 = 1 + al;
    a1 = -2 * cw;
    a2 = 1 - al;
  } else if (kind === 'bell') {
    const A = 10 ** (g / 40);
    const al = sw / (2 * q);
    b0 = 1 + al * A;
    b1 = -2 * cw;
    b2 = 1 - al * A;
    a0 = 1 + al / A;
    a1 = -2 * cw;
    a2 = 1 - al / A;
  } else {
    const A = 10 ** (g / 40);
    const al = (sw / 2) * Math.SQRT2; // slope 1
    const s = 2 * Math.sqrt(A) * al;
    if (kind === 'low') {
      b0 = A * (A + 1 - (A - 1) * cw + s);
      b1 = 2 * A * (A - 1 - (A + 1) * cw);
      b2 = A * (A + 1 - (A - 1) * cw - s);
      a0 = A + 1 + (A - 1) * cw + s;
      a1 = -2 * (A - 1 + (A + 1) * cw);
      a2 = A + 1 + (A - 1) * cw - s;
    } else {
      b0 = A * (A + 1 + (A - 1) * cw + s);
      b1 = -2 * A * (A - 1 + (A + 1) * cw);
      b2 = A * (A + 1 + (A - 1) * cw - s);
      a0 = A + 1 - (A - 1) * cw + s;
      a1 = 2 * (A - 1 - (A + 1) * cw);
      a2 = A + 1 - (A - 1) * cw - s;
    }
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

/** The filters that do something, in the order of the engine: high pass, bands, low pass. */
export function eqFilters(eq, sr) {
  if (!eq.on) return [];
  const list = [];
  if (eq.hpf.on) list.push(coefs('hpf', eq.hpf.f, 0, 0, sr));
  eq.bands.forEach((b) => b.g !== 0 && list.push(coefs(b.t, b.f, b.g, b.q, sr)));
  if (eq.lpf.on) list.push(coefs('lpf', eq.lpf.f, 0, 0, sr));
  return list;
}

// |H(e^jw)| in dB of one biquad.
function magDb([b0, b1, b2, a1, a2], w) {
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2;
  const ni = -(b1 * s1 + b2 * s2);
  const dr = 1 + a1 * c1 + a2 * c2;
  const di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di) || 1e-12);
}

/** Response of the EQ (dB) at each frequency of `freqs`: the curve of the graph. */
export function eqResponse(eq, freqs, sr = 48000) {
  const fs = eqFilters(eq, sr);
  return freqs.map((f) => fs.reduce((sum, c) => sum + magDb(c, (2 * Math.PI * f) / sr), 0));
}

/** Response of one filter alone (the shaded area of the band selected). */
export function bandResponse(eq, which, freqs, sr = 48000) {
  const b = which === 'hpf' || which === 'lpf' ? { t: which, ...eq[which], g: 0, q: 0 } : eq.bands[which];
  const c = coefs(b.t, b.f, b.g, b.q, sr);
  return freqs.map((f) => magDb(c, (2 * Math.PI * f) / sr));
}

/** Input gain and EQ applied in place to a channel (web rehearsal, offline). */
export function eqProcess(data, src, sr) {
  const eq = eqOf(src);
  const input = inputOf(src);
  if (input !== 0) {
    const k = 10 ** (input / 20);
    for (let i = 0; i < data.length; i += 1) data[i] *= k;
  }
  eqFilters(eq, sr).forEach(([b0, b1, b2, a1, a2]) => {
    let z1 = 0;
    let z2 = 0;
    for (let i = 0; i < data.length; i += 1) {
      const x = data[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      data[i] = y;
    }
  });
}

/** Does the channel section of this track change the sound? (to process it or not). */
export const channelActive = (src) => inputOf(src) !== 0 || eqActive(eqOf(src));

export const freqText = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2).replace(/\.?0+$/, '')}k` : `${Math.round(f)}`);
