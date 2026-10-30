//! Disk streaming: one thread per track decodes ahead into a lock-free ring
//! buffer that the audio callback reads. Seeking spawns a new reader.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use rtrb::{Consumer, Producer, RingBuffer};
use serde::Deserialize;

use super::decode::{Next, Source};
use super::resample::Resampler;

/// Seconds of audio decoded ahead of the playhead.
const AHEAD_SECONDS: usize = 3;

/// Reading side, owned by the audio callback.
pub struct TrackStream {
    pub rx: Consumer<f32>,
    pub eof: Arc<AtomicBool>,
}

/// Stops the reader thread when dropped.
pub struct DecoderHandle {
    stop: Arc<AtomicBool>,
}

impl Drop for DecoderHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Where a piece of the file plays on the song's timeline: from `from`
/// seconds of the file, `len` seconds long (None: to the end of the file),
/// starting at `at` seconds of the song. A track is a list of them (moved
/// clips, bars inserted in the middle); none = the whole file from 0.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    pub at: f64,
    #[serde(default)]
    pub from: f64,
    #[serde(default)]
    pub len: Option<f64>,
    /// Muted segment: silent, but kept in its place.
    #[serde(default)]
    pub muted: bool,
}

/// The regions as played: sorted, and the whole file when there are none.
pub fn normalize(regions: &[Region]) -> Vec<Region> {
    if regions.is_empty() {
        return vec![Region { at: 0.0, from: 0.0, len: None, muted: false }];
    }
    let mut r: Vec<Region> = regions.iter().filter(|r| !r.muted && r.from >= 0.0 && r.len.is_none_or(|l| l > 0.0)).cloned().collect();
    r.sort_by(|a, b| a.at.total_cmp(&b.at));
    r
}

/// End of the track on the timeline (file length needed for open regions).
pub fn timeline_end(regions: &[Region], file_seconds: Option<f64>) -> Option<f64> {
    normalize(regions)
        .iter()
        .map(|r| r.len.or(file_seconds.map(|f| (f - r.from).max(0.0))).map(|l| r.at + l))
        .try_fold(0f64, |m, e| e.map(|e| m.max(e)))
}

pub fn spawn(path: PathBuf, start_seconds: f64, dst_rate: u32, regions: Vec<Region>) -> (DecoderHandle, TrackStream) {
    let (tx, rx) = RingBuffer::<f32>::new(dst_rate as usize * 2 * AHEAD_SECONDS);
    let stop = Arc::new(AtomicBool::new(false));
    let eof = Arc::new(AtomicBool::new(false));
    let (stop2, eof2) = (stop.clone(), eof.clone());
    thread::Builder::new()
        .name("livetools-disk".into())
        .spawn(move || {
            if let Err(e) = run(&path, start_seconds, dst_rate, &normalize(&regions), tx, &stop2) {
                eprintln!("[stream] {}: {e}", path.display());
            }
            eof2.store(true, Ordering::Release);
        })
        .expect("thread di lettura");
    (DecoderHandle { stop }, TrackStream { rx, eof })
}

/// Writes interleaved stereo samples (whole frames); false when stopped.
fn push(tx: &mut Producer<f32>, mut data: &[f32], stop: &AtomicBool) -> bool {
    while !data.is_empty() {
        if stop.load(Ordering::Relaxed) {
            return false;
        }
        let n = tx.slots().min(data.len()) & !1;
        if n == 0 {
            thread::sleep(Duration::from_millis(4));
            continue;
        }
        if let Ok(chunk) = tx.write_chunk_uninit(n) {
            chunk.fill_from_iter(data[..n].iter().copied());
        }
        data = &data[n..];
    }
    true
}

/// Silence (frames) between two regions.
fn push_silence(tx: &mut Producer<f32>, frames: u64, stop: &AtomicBool) -> bool {
    let zeros = [0f32; 8192];
    let mut left = frames as usize * 2;
    while left > 0 {
        let n = left.min(zeros.len());
        if !push(tx, &zeros[..n], stop) {
            return false;
        }
        left -= n;
    }
    true
}

/// Plays the regions from `start` (song seconds, >= 0): silence where no
/// region plays, the file where one does (a later region wins an overlap).
fn run(path: &PathBuf, start: f64, dst_rate: u32, regions: &[Region], mut tx: Producer<f32>, stop: &AtomicBool) -> Result<(), String> {
    let rate = dst_rate as f64;
    let frame_at = |t: f64| ((t - start) * rate).round().max(0.0) as u64;
    let mut written: u64 = 0;
    for (k, r) in regions.iter().enumerate() {
        let next_at = regions.get(k + 1).map(|n| n.at);
        let mut src = Source::open(path)?;
        let file_len = src.frames.map(|f| f as f64 / src.sample_rate as f64);
        let len = r.len.or(file_len.map(|l| (l - r.from).max(0.0)));
        let mut end = len.map_or(f64::INFINITY, |l| r.at + l);
        if let Some(n) = next_at {
            end = end.min(n);
        }
        let end_frame = if end.is_finite() { Some(frame_at(end)) } else { None };
        if end_frame.is_some_and(|e| e <= written) {
            continue;
        }
        let at_frame = frame_at(r.at);
        if at_frame > written {
            if !push_silence(&mut tx, at_frame - written, stop) {
                return Ok(());
            }
            written = at_frame;
        }
        let now = start + written as f64 / rate;
        let offset = r.from + (now - r.at).max(0.0);
        if file_len.is_some_and(|l| offset >= l) {
            continue;
        }
        src.seek(offset)?;
        let mut rs = Resampler::new(src.sample_rate, dst_rate);
        let mut decoded = Vec::with_capacity(16_384);
        let mut pending: Vec<f32> = Vec::with_capacity(32_768);
        let mut ended = false;
        loop {
            if stop.load(Ordering::Relaxed) {
                return Ok(());
            }
            if pending.is_empty() {
                if ended {
                    break;
                }
                decoded.clear();
                match src.next(&mut decoded)? {
                    Next::Frames => rs.process(&decoded, &mut pending),
                    Next::End => {
                        rs.flush(&mut pending);
                        ended = true;
                    }
                }
                continue;
            }
            let mut frames = (pending.len() / 2) as u64;
            if let Some(e) = end_frame {
                frames = frames.min(e.saturating_sub(written));
            }
            if !push(&mut tx, &pending[..frames as usize * 2], stop) {
                return Ok(());
            }
            written += frames;
            if end_frame.is_some_and(|e| written >= e) {
                break;
            }
            pending.clear();
        }
    }
    Ok(())
}
