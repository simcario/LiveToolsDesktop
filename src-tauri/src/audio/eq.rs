//! Channel section of a track (Mixer → click on the track name): input gain and
//! EQ, high pass, five bands (bell or shelf), low pass. The same filters as the
//! web rehearsal (web/src/lib/eq.js): RBJ biquads, 12 dB/oct passes, shelves
//! with slope 1.
//!
//! Cost: a band with gain 0 or a pass turned off is not run at all; every active
//! filter is 5 multiplications and 4 additions per sample and channel, so seven
//! of them on sixteen stereo tracks at 48 kHz stay around 1% of a tablet core.
//! The coefficients are worked out on the audio thread only when the settings
//! change (a version number), never per block.
//!
//! The spectrum of the graph: the audio thread copies the track looked at
//! (post EQ, before the fader) into a ring of 4096 samples, read by the UI
//! about twenty times a second only while a channel section is open.

use super::atomic::AtomicF32;
use parking_lot::Mutex;
use serde::Deserialize;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};

pub const BANDS: usize = 5;
const MAX_FILTERS: usize = BANDS + 2;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct PassSpec {
    pub on: bool,
    pub f: f32,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum BandType {
    #[default]
    Bell,
    Low,
    High,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct BandSpec {
    pub t: BandType,
    pub f: f32,
    pub g: f32,
    pub q: f32,
}

/// As saved on the stem (see eq.js), sent by the player with every track mix.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct EqSpec {
    pub on: bool,
    pub hpf: PassSpec,
    pub lpf: PassSpec,
    pub bands: Vec<BandSpec>,
}

/// Fixed size copy of the spec, read by the audio thread (no allocation).
#[derive(Clone, Copy, Debug, Default)]
pub struct EqParams {
    pub on: bool,
    pub hpf: PassSpec,
    pub lpf: PassSpec,
    pub bands: [BandSpec; BANDS],
}

impl From<&EqSpec> for EqParams {
    fn from(s: &EqSpec) -> Self {
        let mut bands = [BandSpec::default(); BANDS];
        for (b, x) in bands.iter_mut().zip(s.bands.iter()) {
            *b = *x;
        }
        Self { on: s.on, hpf: s.hpf, lpf: s.lpf, bands }
    }
}

/// The channel section of a track, written by the UI, read by the callback.
pub struct ChannelControl {
    pub input: AtomicF32,
    pub params: Mutex<EqParams>,
    pub version: AtomicU32,
}

impl ChannelControl {
    pub fn new() -> Self {
        Self { input: AtomicF32::new(1.0), params: Mutex::new(EqParams::default()), version: AtomicU32::new(0) }
    }

    pub fn set_eq(&self, spec: &EqSpec) {
        *self.params.lock() = EqParams::from(spec);
        self.version.fetch_add(1, Ordering::Release);
    }
}

#[derive(Clone, Copy, Default)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
}

enum Kind {
    Hpf,
    Lpf,
    Band(BandType),
}

fn coefs(kind: Kind, f: f32, g: f32, q: f32, sr: f32) -> Biquad {
    let f = f.clamp(10.0, sr * 0.49) as f64;
    let w = 2.0 * std::f64::consts::PI * f / sr as f64;
    let (cw, sw) = (w.cos(), w.sin());
    let (b0, b1, b2, a0, a1, a2);
    match kind {
        Kind::Hpf | Kind::Lpf => {
            let al = sw / (2.0 * std::f64::consts::FRAC_1_SQRT_2);
            let hp = matches!(kind, Kind::Hpf);
            b0 = if hp { (1.0 + cw) / 2.0 } else { (1.0 - cw) / 2.0 };
            b1 = if hp { -(1.0 + cw) } else { 1.0 - cw };
            b2 = b0;
            a0 = 1.0 + al;
            a1 = -2.0 * cw;
            a2 = 1.0 - al;
        }
        Kind::Band(BandType::Bell) => {
            let a = 10f64.powf(g as f64 / 40.0);
            let al = sw / (2.0 * (q as f64).max(0.1));
            b0 = 1.0 + al * a;
            b1 = -2.0 * cw;
            b2 = 1.0 - al * a;
            a0 = 1.0 + al / a;
            a1 = -2.0 * cw;
            a2 = 1.0 - al / a;
        }
        Kind::Band(t) => {
            let a = 10f64.powf(g as f64 / 40.0);
            let al = sw / 2.0 * std::f64::consts::SQRT_2;
            let s = 2.0 * a.sqrt() * al;
            if t == BandType::Low {
                b0 = a * (a + 1.0 - (a - 1.0) * cw + s);
                b1 = 2.0 * a * (a - 1.0 - (a + 1.0) * cw);
                b2 = a * (a + 1.0 - (a - 1.0) * cw - s);
                a0 = a + 1.0 + (a - 1.0) * cw + s;
                a1 = -2.0 * (a - 1.0 + (a + 1.0) * cw);
                a2 = a + 1.0 + (a - 1.0) * cw - s;
            } else {
                b0 = a * (a + 1.0 + (a - 1.0) * cw + s);
                b1 = -2.0 * a * (a - 1.0 + (a + 1.0) * cw);
                b2 = a * (a + 1.0 + (a - 1.0) * cw - s);
                a0 = a + 1.0 - (a - 1.0) * cw + s;
                a1 = 2.0 * (a - 1.0 - (a + 1.0) * cw);
                a2 = a + 1.0 - (a - 1.0) * cw - s;
            }
        }
    }
    Biquad { b0: (b0 / a0) as f32, b1: (b1 / a0) as f32, b2: (b2 / a0) as f32, a1: (a1 / a0) as f32, a2: (a2 / a0) as f32 }
}

/// Filters of one track on the audio thread, one fixed slot each (high pass,
/// the five bands, low pass): coefficients, state (L, R), on or skipped.
pub struct EqState {
    version: u32,
    rate: f32,
    filters: [Biquad; MAX_FILTERS],
    z: [[f32; 4]; MAX_FILTERS],
    active: [bool; MAX_FILTERS],
}

impl EqState {
    pub fn new() -> Self {
        Self { version: u32::MAX, rate: 0.0, filters: [Biquad::default(); MAX_FILTERS], z: [[0.0; 4]; MAX_FILTERS], active: [false; MAX_FILTERS] }
    }

    fn refresh(&mut self, c: &ChannelControl, sr: f32) {
        let v = c.version.load(Ordering::Acquire);
        if v == self.version && sr == self.rate {
            return;
        }
        // The UI is writing: the filters of the block before, the new ones next block.
        let Some(p) = c.params.try_lock().map(|p| *p) else { return };
        let mut want: [Option<Biquad>; MAX_FILTERS] = [None; MAX_FILTERS];
        if p.on {
            if p.hpf.on {
                want[0] = Some(coefs(Kind::Hpf, p.hpf.f, 0.0, 0.0, sr));
            }
            for (i, b) in p.bands.iter().enumerate() {
                if b.g.abs() > 1e-3 {
                    want[i + 1] = Some(coefs(Kind::Band(b.t), b.f, b.g.clamp(-24.0, 24.0), b.q, sr));
                }
            }
            if p.lpf.on {
                want[MAX_FILTERS - 1] = Some(coefs(Kind::Lpf, p.lpf.f, 0.0, 0.0, sr));
            }
        }
        for (i, w) in want.into_iter().enumerate() {
            match w {
                Some(b) => {
                    // A filter turned on starts from silence; one being moved keeps its state.
                    if !self.active[i] {
                        self.z[i] = [0.0; 4];
                    }
                    self.filters[i] = b;
                    self.active[i] = true;
                }
                None => self.active[i] = false,
            }
        }
        self.version = v;
        self.rate = sr;
    }

    /// Input gain and EQ, in place on stereo frames (interleaved).
    pub fn process(&mut self, c: &ChannelControl, buf: &mut [f32], sr: f32) {
        self.refresh(c, sr);
        let input = c.input.load();
        if (input - 1.0).abs() > 1e-6 {
            buf.iter_mut().for_each(|x| *x *= input);
        }
        for i in 0..MAX_FILTERS {
            if !self.active[i] {
                continue;
            }
            let f = self.filters[i];
            let [mut l1, mut l2, mut r1, mut r2] = self.z[i];
            for fr in buf.chunks_exact_mut(2) {
                let x = fr[0];
                let y = f.b0 * x + l1;
                l1 = f.b1 * x - f.a1 * y + l2;
                l2 = f.b2 * x - f.a2 * y;
                fr[0] = y;
                let x = fr[1];
                let y = f.b0 * x + r1;
                r1 = f.b1 * x - f.a1 * y + r2;
                r2 = f.b2 * x - f.a2 * y;
                fr[1] = y;
            }
            // No denormals in the silence after a song (slow on some CPUs).
            let flush = |v: f32| if v.abs() < 1e-18 { 0.0 } else { v };
            self.z[i] = [flush(l1), flush(l2), flush(r1), flush(r2)];
        }
    }
}

pub const TAP_LEN: usize = 4096;

/// Ring the audio thread fills with the track looked at (mono); torn reads
/// only blur one frame of the graph.
pub struct Tap {
    ring: Vec<AtomicF32>,
    pos: AtomicUsize,
}

impl Tap {
    pub fn new() -> Self {
        Self { ring: (0..TAP_LEN).map(|_| AtomicF32::new(0.0)).collect(), pos: AtomicUsize::new(0) }
    }

    pub fn write(&self, stereo: &[f32]) {
        let mut p = self.pos.load(Ordering::Relaxed);
        for fr in stereo.chunks_exact(2) {
            self.ring[p % TAP_LEN].store((fr[0] + fr[1]) * 0.5);
            p = p.wrapping_add(1);
        }
        self.pos.store(p, Ordering::Release);
    }

    pub fn clear(&self) {
        self.ring.iter().for_each(|x| x.store(0.0));
    }

    /// Spectrum of the last 4096 samples: `bins` values in dBFS, log spaced from 20 Hz to 20 kHz.
    pub fn spectrum(&self, sr: f32, bins: usize) -> Vec<f32> {
        let end = self.pos.load(Ordering::Acquire);
        let n = TAP_LEN;
        let mut re: Vec<f32> = (0..n)
            .map(|i| {
                let w = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos();
                self.ring[end.wrapping_add(i) % n].load() * w
            })
            .collect();
        let mut im = vec![0f32; n];
        fft(&mut re, &mut im);
        // Hann window: coherent gain 0.5; a full-scale sine reads 0 dBFS.
        let norm = 4.0 / n as f32;
        let mag: Vec<f32> = (0..n / 2).map(|k| (re[k] * re[k] + im[k] * im[k]).sqrt() * norm).collect();
        let hz = sr / n as f32;
        let (lo, hi) = (20f32.ln(), 20000f32.ln());
        (0..bins)
            .map(|b| {
                let f0 = (lo + (hi - lo) * b as f32 / bins as f32).exp();
                let f1 = (lo + (hi - lo) * (b + 1) as f32 / bins as f32).exp();
                let (k0, k1) = (((f0 / hz) as usize).max(1), ((f1 / hz).ceil() as usize).min(n / 2 - 1));
                let m = if k1 > k0 { mag[k0..k1].iter().copied().fold(0.0, f32::max) } else { mag[k0.min(n / 2 - 1)] };
                20.0 * m.max(1e-6).log10()
            })
            .collect()
    }
}

/// In place radix-2 FFT (n a power of two).
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * std::f32::consts::PI / len as f32;
        let (wr, wi) = (ang.cos(), ang.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1f32, 0f32);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let tr = re[b] * cr - im[b] * ci;
                let ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let nc = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nc;
            }
        }
        len <<= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_eq_is_a_bypass() {
        let c = ChannelControl::new();
        c.set_eq(&EqSpec { on: true, bands: vec![BandSpec { t: BandType::Bell, f: 1000.0, g: 0.0, q: 1.0 }], ..Default::default() });
        let mut s = EqState::new();
        let mut buf = vec![0.5f32; 64];
        s.process(&c, &mut buf, 48000.0);
        assert!(buf.iter().all(|x| (*x - 0.5).abs() < 1e-6));
        assert!(s.active.iter().all(|a| !a));
    }

    #[test]
    fn high_pass_removes_dc() {
        let c = ChannelControl::new();
        c.set_eq(&EqSpec { on: true, hpf: PassSpec { on: true, f: 100.0 }, ..Default::default() });
        let mut s = EqState::new();
        let mut buf = vec![1.0f32; 48000 * 2];
        s.process(&c, &mut buf, 48000.0);
        assert!(buf[buf.len() - 1].abs() < 1e-3);
    }

    #[test]
    fn spectrum_of_a_sine() {
        let t = Tap::new();
        let buf: Vec<f32> = (0..TAP_LEN).flat_map(|i| {
            let v = (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / 48000.0).sin();
            [v, v]
        }).collect();
        t.write(&buf);
        let s = t.spectrum(48000.0, 96);
        let (i, peak) = s.iter().enumerate().fold((0, -200.0), |a, (i, v)| if *v > a.1 { (i, *v) } else { a });
        let f = (20f32.ln() + (20000f32.ln() - 20f32.ln()) * (i as f32 + 0.5) / 96.0).exp();
        assert!((800.0..1250.0).contains(&f), "{f}");
        assert!(peak > -3.0 && peak < 1.0, "{peak}");
    }
}
