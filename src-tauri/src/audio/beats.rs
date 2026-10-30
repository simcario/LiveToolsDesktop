//! Beat analysis used to line the engine's tempo map up with the audio.
//!
//! - "click" mode: a recorded click track. Every hit is detected (sample
//!   accurate), gaps are filled, the accented hit gives the downbeat: the
//!   result is the actual beat list, so tempo changes are followed exactly.
//! - "rhythm" mode: any rhythmic stem (drums, loops…). The onset envelope is
//!   matched against a beat comb around the song's BPM to find the exact
//!   tempo and where bar 1 falls.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::decode::{Next, Source};

/// Analysis hop in samples (≈ 5.8 ms at 44.1 kHz).
const HOP: usize = 256;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAnalysis {
    pub mode: String,
    /// Click mode: every beat of the click (seconds), gaps filled.
    pub beats: Vec<f64>,
    /// Click mode: index in `beats` of bar 1, beat 1.
    pub downbeat: usize,
    pub beats_per_bar: u32,
    /// Time of bar 1, beat 1 (seconds).
    pub origin: f64,
    pub bpm: f64,
    /// 0..1: how regular the click is / how clearly the rhythm fits the grid.
    pub confidence: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    pub path: String,
    /// "click" | "rhythm"
    pub mode: String,
    /// Tempo of the song (rhythm mode starts from here).
    pub bpm: Option<f64>,
    pub beats_per_bar: Option<u32>,
    /// BPM refers to the dotted quarter (6/8, 12/8…): the grid unit is the eighth.
    #[serde(default)]
    pub compound: bool,
    /// Rhythm mode: analyse only up to here (first section when the tempo changes).
    pub window: Option<f64>,
    /// Rhythm mode: analyse from here (where the steady rhythm starts); bar 1
    /// is looked for from this point.
    #[serde(default)]
    pub from: Option<f64>,
}

impl SyncRequest {
    fn cache_key(&self) -> String {
        format!(
            "v1|{}|{:?}|{:?}|{}|{:?}|{:?}",
            self.mode, self.bpm, self.beats_per_bar, self.compound, self.window, self.from
        )
    }
}

#[derive(Serialize, Deserialize)]
struct Cached {
    key: String,
    result: SyncAnalysis,
}

/// Analyses (or reads the cached analysis next to the media file).
pub fn analyze(req: &SyncRequest) -> Result<SyncAnalysis, String> {
    let path = Path::new(&req.path);
    let cache = path.with_extension(format!(
        "{}.sync.json",
        path.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    let key = req.cache_key();
    if let (Ok(src), Ok(c)) = (std::fs::metadata(path), std::fs::metadata(&cache)) {
        if c.modified().ok() >= src.modified().ok() {
            if let Some(hit) = std::fs::read_to_string(&cache)
                .ok()
                .and_then(|t| serde_json::from_str::<Cached>(&t).ok())
                .filter(|c| c.key == key)
            {
                return Ok(hit.result);
            }
        }
    }
    let (x, sr) = decode_mono(path)?;
    let result = match req.mode.as_str() {
        "click" => analyze_click(&x, sr, req)?,
        _ => analyze_rhythm(&x, sr, req)?,
    };
    if let Ok(text) = serde_json::to_string(&Cached { key, result: result.clone() }) {
        let _ = std::fs::write(&cache, text);
    }
    Ok(result)
}

fn decode_mono(path: &Path) -> Result<(Vec<f32>, u32), String> {
    let mut src = Source::open(path)?;
    let sr = src.sample_rate;
    let mut out = Vec::new();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match src.next(&mut buf)? {
            Next::End => break,
            Next::Frames => out.extend(buf.chunks_exact(2).map(|f| (f[0] + f[1]) * 0.5)),
        }
    }
    if out.len() < sr as usize {
        return Err("Traccia troppo corta per l’analisi".into());
    }
    Ok((out, sr))
}

/// Onset strength per hop: rise of the log energy (transients stand out,
/// sustained notes don't). `emphasis` (0..1) tilts the signal towards the
/// highs; drums keep it low so the kick still counts.
fn envelope(x: &[f32], emphasis: f32) -> Vec<f32> {
    let n = x.len() / HOP;
    let mut o = vec![0f32; n];
    let (mut prev, mut last) = (0f32, 0f32);
    for (k, v) in o.iter_mut().enumerate() {
        let mut e = 0f32;
        for &s in &x[k * HOP..(k + 1) * HOP] {
            let hp = s - emphasis * prev;
            prev = s;
            e += hp * hp;
        }
        let l = (1.0 + 1000.0 * e / HOP as f32).ln();
        *v = (l - last).max(0.0);
        last = l;
    }
    o
}

/// Transients of a track (seconds), for the warp magnet: peaks of the onset
/// envelope well above the local level, at least 60 ms apart.
pub fn onsets(path: &Path) -> Result<Vec<f64>, String> {
    let (x, sr) = decode_mono(path)?;
    let o = envelope(&x, 0.3);
    let max = o.iter().cloned().fold(0f32, f32::max);
    if max <= 0.0 {
        return Ok(Vec::new());
    }
    let fr = sr as f64 / HOP as f64;
    let (half, gap) = ((0.25 * fr) as usize, (0.06 * fr) as usize);
    let mut out: Vec<f64> = Vec::new();
    let mut last: Option<usize> = None;
    for k in 1..o.len().saturating_sub(1) {
        let v = o[k];
        if v < 0.08 * max || v < o[k - 1] || v < o[k + 1] {
            continue;
        }
        let (a, b) = (k.saturating_sub(half), (k + half).min(o.len()));
        let local = o[a..b].iter().sum::<f32>() / (b - a) as f32;
        if v < 2.0 * local {
            continue;
        }
        if last.is_some_and(|l| k - l < gap) {
            continue;
        }
        last = Some(k);
        // The rise starts in the hop before the peak of the derivative.
        out.push((k.saturating_sub(1) * HOP) as f64 / sr as f64);
    }
    Ok(out)
}

fn median(v: &mut [f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn percentile(v: &[f32], p: f32) -> f32 {
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    s[((s.len() - 1) as f32 * p) as usize]
}

struct Hit {
    t: f64,
    amp: f32,
    /// Zero-crossing rate right after the hit: a proxy of the click's pitch.
    zcr: f32,
}

fn click_hits(x: &[f32], sr: u32) -> Vec<Hit> {
    // A click track is clean (silence between hits): plain energy and a low
    // threshold catch the soft unaccented clicks too.
    let o = envelope(x, 0.0);
    let max = o.iter().cloned().fold(0f32, f32::max);
    if max <= 0.0 {
        return Vec::new();
    }
    let thr = 0.08 * max;
    let min_gap = ((0.07 * sr as f64) / HOP as f64).ceil() as usize;
    let mut peaks: Vec<usize> = Vec::new();
    for k in 1..o.len().saturating_sub(1) {
        if o[k] < thr || o[k] < o[k - 1] || o[k] < o[k + 1] {
            continue;
        }
        match peaks.last_mut() {
            Some(last) if k - *last < min_gap => {
                if o[k] > o[*last] {
                    *last = k;
                }
            }
            _ => peaks.push(k),
        }
    }
    let win = (0.015 * sr as f64) as usize;
    peaks
        .into_iter()
        .map(|k| {
            // Sample-accurate start: first sample above 20% of the hit's peak.
            let a = k.saturating_sub(2) * HOP;
            let b = ((k + 3) * HOP).min(x.len());
            let pk = x[a..b].iter().fold(0f32, |m, s| m.max(s.abs()));
            let start = (a..b).find(|&i| x[i].abs() >= 0.2 * pk).unwrap_or(k * HOP);
            let end = (start + win).min(x.len());
            let zc = x[start..end].windows(2).filter(|w| (w[0] >= 0.0) != (w[1] >= 0.0)).count();
            Hit { t: start as f64 / sr as f64, amp: pk, zcr: zc as f32 / (end - start).max(1) as f32 }
        })
        .collect()
}

/// Which hits are accented: by pitch if the click uses two sounds, else by level.
fn accents(hits: &[Hit]) -> Option<Vec<bool>> {
    let pick = |vals: Vec<f32>, spread: f32| -> Option<Vec<bool>> {
        let (lo, hi) = (percentile(&vals, 0.1), percentile(&vals, 0.9));
        if lo <= 0.0 || hi / lo < spread {
            return None;
        }
        let mid = (lo + hi) / 2.0;
        Some(vals.iter().map(|v| *v > mid).collect())
    };
    pick(hits.iter().map(|h| h.zcr).collect(), 1.15).or_else(|| pick(hits.iter().map(|h| h.amp).collect(), 1.12))
}

fn analyze_click(x: &[f32], sr: u32, req: &SyncRequest) -> Result<SyncAnalysis, String> {
    let mut hits = click_hits(x, sr);
    if hits.len() < 8 {
        return Err("Nella traccia click non ci sono abbastanza colpi".into());
    }
    let mut iois: Vec<f64> = hits.windows(2).map(|w| w[1].t - w[0].t).collect();
    let global = median(&mut iois);
    // Drop flams / double triggers closer than 60% of a beat.
    let mut clean: Vec<Hit> = Vec::with_capacity(hits.len());
    for h in hits.drain(..) {
        match clean.last() {
            Some(prev) if h.t - prev.t < global * 0.6 => {
                if h.amp > prev.amp {
                    *clean.last_mut().unwrap() = h;
                }
            }
            _ => clean.push(h),
        }
    }

    // Beat list with the gaps (breaks without click) filled at the local tempo.
    let mut beats: Vec<f64> = vec![clean[0].t];
    let mut accent_src: Vec<Option<usize>> = vec![Some(0)];
    let mut recent: Vec<f64> = Vec::new();
    let mut regular = 0usize;
    for (i, h) in clean.iter().enumerate().skip(1) {
        let mut window = recent.clone();
        let local = if window.is_empty() { global } else { median(&mut window) };
        let d = h.t - beats.last().unwrap();
        let n = (d / local).round().max(1.0) as usize;
        let step = d / n as f64;
        for _ in 1..n {
            beats.push(beats.last().unwrap() + step);
            accent_src.push(None);
        }
        if (step - local).abs() < local * 0.06 {
            regular += 1;
        }
        recent.push(step);
        if recent.len() > 8 {
            recent.remove(0);
        }
        beats.push(h.t);
        accent_src.push(Some(i));
    }
    let confidence = regular as f32 / (clean.len() - 1) as f32;

    // Downbeat and beats per bar from the accented hits.
    let hint = req.beats_per_bar.filter(|b| (1..=16).contains(b)).unwrap_or(4);
    let mut bpb = hint;
    let mut first = 0usize;
    if let Some(acc) = accents(&clean) {
        let idx: Vec<usize> = accent_src
            .iter()
            .enumerate()
            .filter_map(|(bi, s)| s.filter(|&hi| acc[hi]).map(|_| bi))
            .collect();
        if idx.len() >= 2 {
            let mut hist = [0usize; 17];
            for w in idx.windows(2) {
                let g = w[1] - w[0];
                if (2..=16).contains(&g) {
                    hist[g] += 1;
                }
            }
            let (g, count) = hist.iter().enumerate().max_by_key(|(_, c)| **c).unwrap();
            if *count * 10 >= (idx.len() - 1) * 6 {
                bpb = g as u32;
            }
            first = idx[0];
        }
    }
    let downbeat = first.min(beats.len() - 1);
    let mut gaps: Vec<f64> = beats[downbeat..].windows(2).map(|w| w[1] - w[0]).collect();
    let unit = median(&mut gaps).max(1e-3);
    let bpm = if req.compound { 60.0 / unit / 3.0 } else { 60.0 / unit };
    Ok(SyncAnalysis {
        mode: "click".into(),
        origin: beats[downbeat],
        beats,
        downbeat,
        beats_per_bar: bpb,
        bpm,
        confidence,
    })
}

/// Tempo when the song has none: autocorrelation of the onset envelope, 60-200 BPM.
fn estimate_bpm(o: &[f32], fr: f64) -> f64 {
    let (lo, hi) = ((fr * 60.0 / 200.0) as usize, (fr * 60.0 / 60.0) as usize);
    let mut best = (0f64, 120.0);
    for lag in lo.max(1)..=hi.min(o.len() / 2) {
        let r: f64 = o.iter().zip(&o[lag..]).map(|(a, b)| (*a * *b) as f64).sum();
        let bpm = fr * 60.0 / lag as f64;
        // Prefer the usual range (octave errors).
        let w = (-((bpm / 120.0).log2().powi(2)) / 0.5).exp();
        if r * w > best.0 {
            best = (r * w, bpm);
        }
    }
    best.1
}

fn analyze_rhythm(x: &[f32], sr: u32, req: &SyncRequest) -> Result<SyncAnalysis, String> {
    let fr = sr as f64 / HOP as f64;
    let mut o = envelope(x, 0.5);
    // Analysis range: frames outside it count as silence, times stay absolute.
    let skip = req.from.filter(|f| *f > 0.0).map_or(0, |f| ((f * fr) as usize).min(o.len()));
    if let Some(w) = req.window.filter(|w| *w > 4.0) {
        o.truncate(((w * fr) as usize).min(o.len()));
    }
    if o.len() < skip + (4.0 * fr) as usize {
        return Err("Intervallo di analisi troppo corto (servono almeno 4 secondi)".into());
    }
    o[..skip].fill(0.0);
    let max = o.iter().cloned().fold(0f32, f32::max);
    if max <= 0.0 {
        return Err("La traccia ritmica è silenziosa".into());
    }
    let bpm0 = req.bpm.filter(|b| *b > 20.0).unwrap_or_else(|| estimate_bpm(&o, fr));
    // Grid unit in frames: quarter (or eighth in compound meters).
    let unit = |bpm: f64| fr * 60.0 / bpm / if req.compound { 3.0 } else { 1.0 };
    let at = |pos: f64| -> f32 {
        let i = pos.round() as isize;
        (i - 1..=i + 1)
            .filter(|&j| j >= 0 && (j as usize) < o.len())
            .map(|j| o[j as usize])
            .fold(0f32, f32::max)
    };
    let comb = |period: f64, phase: f64| -> f32 {
        let mut s = 0f32;
        let mut p = phase;
        while p < o.len() as f64 {
            s += at(p);
            p += period;
        }
        s
    };

    let mut best = (f32::MIN, bpm0, 0f64);
    let mut sum_at_best = 0f32;
    let mut n_at_best = 0usize;
    let mut bpm = bpm0 * 0.98;
    while bpm <= bpm0 * 1.02 {
        let period = unit(bpm);
        let (mut local_best, mut local_phase, mut total, mut n) = (f32::MIN, 0f64, 0f32, 0usize);
        let mut phase = 0.0;
        while phase < period {
            let s = comb(period, phase);
            total += s;
            n += 1;
            if s > local_best {
                local_best = s;
                local_phase = phase;
            }
            phase += 0.5;
        }
        if local_best > best.0 {
            best = (local_best, bpm, local_phase);
            sum_at_best = total;
            n_at_best = n;
        }
        bpm += 0.02;
    }
    let (score, bpm, phase) = best;
    let period = unit(bpm);
    let mean = sum_at_best / n_at_best.max(1) as f32;
    let confidence = if score > 0.0 { (1.0 - mean / score).clamp(0.0, 1.0) } else { 0.0 };

    // Bar 1: the grid beat where the track starts. Which beat of the bar that is
    // can't be told reliably from a drum stem (after pre-emphasis the snare
    // outweighs the kick): the UI lets the user move it by whole beats.
    let bpb = req.beats_per_bar.filter(|b| (1..=16).contains(b)).unwrap_or(4);
    let start = o.iter().position(|v| *v > 0.3 * max).unwrap_or(skip) as f64;
    let origin = phase + ((start - phase) / period).round().max(0.0) * period;
    Ok(SyncAnalysis {
        mode: "rhythm".into(),
        beats: Vec::new(),
        downbeat: 0,
        beats_per_bar: bpb,
        origin: origin / fr,
        bpm,
        confidence,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blip(x: &mut [f32], at: usize, sr: usize, freq: f32, amp: f32) {
        for i in 0..(sr / 50) {
            if at + i < x.len() {
                let env = (-(i as f32) / (sr as f32 * 0.008)).exp();
                x[at + i] += amp * env * (std::f32::consts::TAU * freq * i as f32 / sr as f32).sin();
            }
        }
    }

    #[test]
    fn click_track_beats_and_downbeat() {
        let sr = 44_100usize;
        let mut x = vec![0f32; sr * 12];
        // 1 s of silence, then 120 BPM in 3/4, accent (higher pitch) on 1;
        // a 2-beat break without click in the middle.
        let start = sr;
        for b in 0..20 {
            if b == 9 || b == 10 {
                continue;
            }
            let accent = b % 3 == 0;
            blip(&mut x, start + b * sr / 2, sr, if accent { 1600.0 } else { 880.0 }, if accent { 0.9 } else { 0.55 });
        }
        let req = SyncRequest { path: String::new(), mode: "click".into(), bpm: None, beats_per_bar: Some(4), compound: false, window: None, from: None };
        let r = analyze_click(&x, sr as u32, &req).unwrap();
        assert_eq!(r.beats_per_bar, 3);
        assert_eq!(r.downbeat, 0);
        assert!((r.origin - 1.0).abs() < 0.003, "origin {}", r.origin);
        assert!((r.bpm - 120.0).abs() < 0.5, "bpm {}", r.bpm);
        assert_eq!(r.beats.len(), 20);
        assert!((r.beats[10] - 6.0).abs() < 0.003, "filled beat {}", r.beats[10]);
    }

    #[test]
    fn rhythm_track_offset() {
        let sr = 44_100usize;
        let mut x = vec![0f32; sr * 20];
        // Kick on 1 and 3, snare on 2 and 4, hats on the eighths, 100 BPM, starting at 0.37 s.
        let beat = 0.6;
        for b in 0..30 {
            let t = ((0.37 + b as f64 * beat) * sr as f64) as usize;
            blip(&mut x, t, sr, if b % 2 == 0 { 120.0 } else { 2500.0 }, 0.9);
            blip(&mut x, t + (beat / 2.0 * sr as f64) as usize, sr, 7000.0, 0.25);
        }
        let req = SyncRequest { path: String::new(), mode: "rhythm".into(), bpm: Some(100.0), beats_per_bar: Some(4), compound: false, window: None, from: None };
        let r = analyze_rhythm(&x, sr as u32, &req).unwrap();
        assert!((r.bpm - 100.0).abs() < 0.3, "bpm {}", r.bpm);
        assert!((r.origin - 0.37).abs() < 0.012, "origin {}", r.origin);
    }

    #[test]
    fn rhythm_from_a_later_point() {
        let sr = 44_100usize;
        let mut x = vec![0f32; sr * 24];
        // A free intro (loose hits) up to 6 s, then 90 BPM from 6.2 s.
        for t in [0.3, 1.1, 2.6, 3.05, 4.7] {
            blip(&mut x, (t * sr as f64) as usize, sr, 300.0, 0.9);
        }
        let beat = 60.0 / 90.0;
        for b in 0..24 {
            let t = ((6.2 + b as f64 * beat) * sr as f64) as usize;
            blip(&mut x, t, sr, if b % 2 == 0 { 120.0 } else { 2500.0 }, 0.9);
        }
        let req = SyncRequest {
            path: String::new(),
            mode: "rhythm".into(),
            bpm: Some(90.0),
            beats_per_bar: Some(4),
            compound: false,
            window: None,
            from: Some(5.5),
        };
        let r = analyze_rhythm(&x, sr as u32, &req).unwrap();
        assert!((r.bpm - 90.0).abs() < 0.3, "bpm {}", r.bpm);
        assert!((r.origin - 6.2).abs() < 0.012, "origin {}", r.origin);
    }

    #[test]
    fn onsets_find_the_hits() {
        let sr = 44_100usize;
        let mut x = vec![0f32; sr * 3];
        for t in [0.5, 1.0, 1.5, 2.25] {
            blip(&mut x, (t * sr as f64) as usize, sr, 200.0, 0.8);
        }
        let dir = std::env::temp_dir().join("livetools-onsets-test.wav");
        write_wav(&dir, &x, sr as u32);
        let found = onsets(&dir).unwrap();
        let _ = std::fs::remove_file(&dir);
        assert_eq!(found.len(), 4, "{found:?}");
        for (f, t) in found.iter().zip([0.5, 1.0, 1.5, 2.25]) {
            assert!((f - t).abs() < 0.012, "{f} vs {t}");
        }
    }

    fn write_wav(path: &Path, x: &[f32], sr: u32) {
        let mut b = Vec::new();
        let data = (x.len() * 2) as u32;
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&sr.to_le_bytes());
        b.extend_from_slice(&(sr * 2).to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&data.to_le_bytes());
        for v in x {
            b.extend_from_slice(&((v.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
        }
        std::fs::write(path, b).unwrap();
    }
}
