//! Lines a song's video up with its multitrack: the sound of the video file is
//! matched against the stems mixed as the engine plays them (regions included),
//! and the result is the offset of the video (seconds of the song where the
//! video starts, the `video.offset` of the app: negative = the video starts
//! before the song, its first part is not shown).
//!
//! Both sides become an onset envelope (rise of the log energy, 100 per second),
//! so the levels and the mix of the video don't matter, only where the notes
//! start. A coarse search over every possible shift (20 per second) is refined
//! around the best one at full resolution.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::decode::{Next, Source};
use super::stream::Region;

/// Envelope frames per second.
const FPS: f64 = 100.0;
/// Frames pooled together by the coarse search.
const POOL: usize = 5;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignStem {
    pub path: String,
    /// Where the stem plays (as the engine): none = from 0, the whole file.
    #[serde(default)]
    pub regions: Vec<Region>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignRequest {
    pub video: String,
    pub stems: Vec<AlignStem>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignResult {
    /// Seconds of the song where the video starts.
    pub offset: f64,
    /// 0..1: how much the best match stands out from the second best.
    pub confidence: f32,
}

/// Energy of the file per frame (mono, emphasised towards the highs a little).
fn energy(path: &Path) -> Result<Vec<f32>, String> {
    let mut src = Source::open(path)?;
    let hop = src.sample_rate as f64 / FPS;
    let mut out = Vec::new();
    let mut buf = Vec::new();
    let (mut acc, mut n, mut prev) = (0f32, 0usize, 0f32);
    let mut next_edge = hop;
    let mut pos = 0f64;
    loop {
        buf.clear();
        match src.next(&mut buf)? {
            Next::End => break,
            Next::Frames => {
                for f in buf.chunks_exact(2) {
                    let s = (f[0] + f[1]) * 0.5;
                    let hp = s - 0.3 * prev;
                    prev = s;
                    acc += hp * hp;
                    n += 1;
                    pos += 1.0;
                    if pos >= next_edge {
                        out.push(acc / n.max(1) as f32);
                        acc = 0.0;
                        n = 0;
                        next_edge += hop;
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Onset strength from the energy, normalised (mean 0, deviation 1).
fn onsets(e: &[f32]) -> Vec<f32> {
    let mut o = Vec::with_capacity(e.len());
    let mut last = 0f32;
    for &v in e {
        let l = (1.0 + 1000.0 * v).ln();
        o.push((l - last).max(0.0));
        last = l;
    }
    let n = o.len().max(1) as f32;
    let mean = o.iter().sum::<f32>() / n;
    let sd = (o.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / n).sqrt();
    if sd > 0.0 {
        o.iter_mut().for_each(|v| *v = (*v - mean) / sd);
    }
    o
}

/// Places the energy of a stem as the engine plays it.
fn place(mix: &mut Vec<f32>, e: &[f32], regions: &[Region]) {
    let whole = [Region { at: 0.0, from: 0.0, len: None, muted: false, fade_in: 0.0, fade_out: 0.0 }];
    let regions = if regions.is_empty() { &whole[..] } else { regions };
    for r in regions.iter().filter(|r| !r.muted) {
        let from = (r.from.max(0.0) * FPS).round() as usize;
        if from >= e.len() {
            continue;
        }
        let len = r.len.map_or(e.len() - from, |l| ((l.max(0.0) * FPS).round() as usize).min(e.len() - from));
        let at = (r.at * FPS).round() as i64;
        for k in 0..len {
            let d = at + k as i64;
            if d < 0 {
                continue;
            }
            let d = d as usize;
            if d >= mix.len() {
                mix.resize(d + 1, 0.0);
            }
            mix[d] += e[from + k];
        }
    }
}

fn pool(o: &[f32]) -> Vec<f32> {
    o.chunks(POOL).map(|c| c.iter().sum::<f32>()).collect()
}

/// Match of `v` shifted by `lag` frames against `m` (dot product over the overlap / √overlap).
fn score(v: &[f32], m: &[f32], lag: i64) -> f32 {
    let a = (-lag).max(0) as usize; // first frame of v that overlaps
    let b = lag.max(0) as usize; // its frame in m
    if a >= v.len() || b >= m.len() {
        return f32::MIN;
    }
    let n = (v.len() - a).min(m.len() - b);
    let dot: f32 = v[a..a + n].iter().zip(&m[b..b + n]).map(|(x, y)| x * y).sum();
    dot / (n as f32).sqrt()
}

pub fn align(req: &AlignRequest) -> Result<AlignResult, String> {
    if req.stems.is_empty() {
        return Err("Il brano non ha tracce audio con cui confrontare il video".into());
    }
    // Every file in its own thread: decoding is most of the time.
    let (video, stems) = std::thread::scope(|s| {
        let v = s.spawn(|| energy(Path::new(&req.video)));
        let st: Vec<_> = req.stems.iter().map(|x| s.spawn(move || energy(Path::new(&x.path)).map(|e| (e, x)))).collect();
        (v.join(), st.into_iter().map(|h| h.join()).collect::<Vec<_>>())
    });
    let video = video.map_err(|_| "Analisi del video interrotta".to_string())?.map_err(|e| format!("Audio del video non leggibile: {e}"))?;
    if video.len() < (5.0 * FPS) as usize || video.iter().all(|&e| e < 1e-9) {
        return Err("Il video non ha audio con cui sincronizzarlo".into());
    }
    let mut mix = Vec::new();
    for st in stems {
        // A stem that can't be read is left out; the others still give the match.
        if let Ok(Ok((e, x))) = st {
            place(&mut mix, &e, &x.regions);
        }
    }
    if mix.len() < (5.0 * FPS) as usize {
        return Err("Le tracce del brano non sono leggibili".into());
    }
    let (v, m) = (onsets(&video), onsets(&mix));

    // Coarse: every shift with at least a quarter of the shorter one (and 5 s) in common.
    let (cv, cm) = (pool(&v), pool(&m));
    let min_overlap = ((cv.len().min(cm.len()) / 4) as i64).max((5.0 * FPS) as i64 / POOL as i64);
    let lo = -(cv.len() as i64 - min_overlap);
    let hi = cm.len() as i64 - min_overlap;
    if lo > hi {
        return Err("Video o tracce troppo corti per sincronizzarli".into());
    }
    let coarse: Vec<(i64, f32)> = (lo..=hi).map(|l| (l, score(&cv, &cm, l))).collect();
    let &(best, top) = coarse.iter().max_by(|a, b| a.1.total_cmp(&b.1)).unwrap();
    if top <= 0.0 {
        return Err("Non trovo punti in comune tra il video e le tracce".into());
    }
    // Second best peak at least a second away: how clear the match is.
    let away = (FPS as i64 / POOL as i64).max(1);
    let second = coarse.iter().filter(|(l, _)| (l - best).abs() > away).map(|&(_, s)| s).fold(0f32, f32::max);
    let confidence = (1.0 - second / top).clamp(0.0, 1.0);

    // Fine: ±2 coarse frames at full resolution, then the vertex of the parabola.
    let centre = best * POOL as i64;
    let span = 2 * POOL as i64;
    let fine: Vec<(i64, f32)> = (centre - span..=centre + span).map(|l| (l, score(&v, &m, l))).collect();
    let k = fine.iter().enumerate().max_by(|a, b| a.1 .1.total_cmp(&b.1 .1)).map(|(i, _)| i).unwrap();
    let mut lag = fine[k].0 as f64;
    if k > 0 && k + 1 < fine.len() {
        let (a, b, c) = (fine[k - 1].1 as f64, fine[k].1 as f64, fine[k + 1].1 as f64);
        let d = a - 2.0 * b + c;
        if d < 0.0 {
            lag += (0.5 * (a - c) / d).clamp(-0.5, 0.5);
        }
    }
    // Frame k of the video's sound is at frame k + lag of the song.
    Ok(AlignResult { offset: (lag / FPS * 1000.0).round() / 1000.0, confidence })
}
