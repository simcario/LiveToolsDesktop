//! Key and tempo of a song changed offline, as Playback does: each stem is
//! rendered once with Signalsmith Stretch into a WAV next to its file, then
//! played like any other file. Click, guides and cues keep their pitch.

use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use signalsmith_stretch::Stretch;

use super::decode::{Next, Source};

/// Frames of output rendered at a time.
const CHUNK: usize = 8192;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StretchJob {
    pub path: String,
    /// Change of key (0 for click, guides and cues).
    #[serde(default)]
    pub semitones: f32,
    /// Speed: new tempo / original tempo (1 = same tempo).
    #[serde(default = "one")]
    pub rate: f64,
}

fn one() -> f64 {
    1.0
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StretchResult {
    pub path: Option<String>,
    pub error: Option<String>,
}

/// Steps of a change that give the same file: 1/100 of a semitone, 1/10000 of speed.
fn cache_path(src: &Path, semitones: f32, rate: f64) -> PathBuf {
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("");
    src.with_extension(format!("{ext}.k{:+}r{}.wav", (semitones * 100.0).round() as i32, (rate * 10_000.0).round() as i64))
}

pub fn is_identity(semitones: f32, rate: f64) -> bool {
    semitones.abs() < 0.005 && (rate - 1.0).abs() < 5e-5
}

/// The file of `job`, rendered if not done yet (or older than its source).
pub fn render(job: &StretchJob, cancel: &AtomicBool) -> Result<PathBuf, String> {
    let src = Path::new(&job.path);
    let rate = job.rate.clamp(0.5, 2.0);
    if is_identity(job.semitones, rate) {
        return Ok(src.to_path_buf());
    }
    let out = cache_path(src, job.semitones, rate);
    if let (Ok(a), Ok(b)) = (std::fs::metadata(src), std::fs::metadata(&out)) {
        if b.modified().ok() >= a.modified().ok() && b.len() > 44 {
            return Ok(out);
        }
    }
    // Written aside and renamed at the end: a render cut halfway is never played.
    let tmp = out.with_extension("wav.part");
    let result = render_to(src, &tmp, job.semitones, rate, cancel);
    match result {
        Ok(()) => {
            std::fs::rename(&tmp, &out).map_err(|e| format!("{}: {e}", out.display()))?;
            Ok(out)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Input of the stretcher: the decoded file, then silence.
struct Input {
    src: Source,
    buf: Vec<f32>,
    pos: usize,
    ended: bool,
}

impl Input {
    /// The next `frames` frames (interleaved stereo) into `out`, zeros past the end.
    fn read(&mut self, frames: usize, out: &mut Vec<f32>) -> Result<(), String> {
        out.clear();
        while out.len() < frames * 2 {
            if self.pos >= self.buf.len() {
                if self.ended {
                    out.resize(frames * 2, 0.0);
                    break;
                }
                self.buf.clear();
                self.pos = 0;
                if let Next::End = self.src.next(&mut self.buf)? {
                    self.ended = true;
                }
                continue;
            }
            let n = (frames * 2 - out.len()).min(self.buf.len() - self.pos);
            out.extend_from_slice(&self.buf[self.pos..self.pos + n]);
            self.pos += n;
        }
        Ok(())
    }
}

fn render_to(src: &Path, dst: &Path, semitones: f32, rate: f64, cancel: &AtomicBool) -> Result<(), String> {
    let source = Source::open(src)?;
    let sr = source.sample_rate;
    // Without the length in the header the file is counted first.
    let in_frames = match source.frames {
        Some(f) => f as usize,
        None => count_frames(src)?,
    };
    let out_frames = (in_frames as f64 / rate).round() as usize;
    let mut input = Input { src: source, buf: Vec::with_capacity(16_384), pos: 0, ended: false };

    let mut st = Stretch::preset_default(2, sr);
    st.set_transpose_factor_semitones(semitones, None);
    let in_lat = st.input_latency();
    let out_lat = st.output_latency();

    let mut w = WavWriter::create(dst, sr)?;
    let mut inbuf = Vec::with_capacity(CHUNK * 4);
    let mut outbuf = vec![0f32; CHUNK * 2];
    // As exact() of the library: pre-roll centred on the start, then the output latency dropped.
    input.read(in_lat, &mut inbuf)?;
    st.seek(&inbuf, rate);
    let (mut produced, mut consumed, mut drop) = (0usize, 0usize, out_lat);
    let mut emit = |w: &mut WavWriter, out: &[f32]| {
        let skip = drop.min(out.len() / 2);
        drop -= skip;
        w.write(&out[skip * 2..])
    };
    while produced < out_frames {
        if cancel.load(Ordering::Relaxed) {
            return Err("Annullato".into());
        }
        let n = CHUNK.min(out_frames - produced);
        let want = (((produced + n) as f64 * rate).round() as usize).min(in_frames).saturating_sub(consumed);
        input.read(want, &mut inbuf)?;
        consumed += want;
        let out = &mut outbuf[..n * 2];
        st.process(&inbuf, &mut *out);
        produced += n;
        emit(&mut w, out)?;
    }
    let mut tail = vec![0f32; out_lat * 2];
    st.flush(&mut tail);
    emit(&mut w, &tail)?;
    w.finish()
}

fn count_frames(path: &Path) -> Result<usize, String> {
    let mut src = Source::open(path)?;
    let mut buf = Vec::with_capacity(16_384);
    let mut n = 0;
    loop {
        buf.clear();
        match src.next(&mut buf)? {
            Next::Frames => n += buf.len() / 2,
            Next::End => return Ok(n),
        }
    }
}

/// 32-bit float stereo WAV, sizes written at the end.
struct WavWriter {
    file: BufWriter<File>,
    samples: u64,
}

impl WavWriter {
    fn create(path: &Path, sample_rate: u32) -> Result<Self, String> {
        let file = File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut w = Self { file: BufWriter::new(file), samples: 0 };
        w.header(sample_rate, 0).map_err(|e| e.to_string())?;
        Ok(w)
    }

    fn header(&mut self, sample_rate: u32, data_bytes: u32) -> std::io::Result<()> {
        let f = &mut self.file;
        f.write_all(b"RIFF")?;
        f.write_all(&(36 + data_bytes).to_le_bytes())?;
        f.write_all(b"WAVEfmt ")?;
        f.write_all(&16u32.to_le_bytes())?;
        f.write_all(&3u16.to_le_bytes())?; // IEEE float
        f.write_all(&2u16.to_le_bytes())?;
        f.write_all(&sample_rate.to_le_bytes())?;
        f.write_all(&(sample_rate * 8).to_le_bytes())?;
        f.write_all(&8u16.to_le_bytes())?;
        f.write_all(&32u16.to_le_bytes())?;
        f.write_all(b"data")?;
        f.write_all(&data_bytes.to_le_bytes())
    }

    fn write(&mut self, samples: &[f32]) -> Result<(), String> {
        for s in samples {
            self.file.write_all(&s.to_le_bytes()).map_err(|e| e.to_string())?;
        }
        self.samples += samples.len() as u64;
        Ok(())
    }

    fn finish(mut self) -> Result<(), String> {
        let bytes = u32::try_from(self.samples * 4).map_err(|_| "File troppo lungo per un WAV")?;
        self.file.flush().map_err(|e| e.to_string())?;
        let mut file = self.file.into_inner().map_err(|e| e.to_string())?;
        file.seek(SeekFrom::Start(4)).map_err(|e| e.to_string())?;
        file.write_all(&(36 + bytes).to_le_bytes()).map_err(|e| e.to_string())?;
        file.seek(SeekFrom::Start(40)).map_err(|e| e.to_string())?;
        file.write_all(&bytes.to_le_bytes()).map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Renders the jobs on a few threads; `progress(done, total)` after each one.
pub fn render_all(jobs: Vec<StretchJob>, cancel: Arc<AtomicBool>, progress: impl Fn(usize, usize) + Sync) -> Vec<StretchResult> {
    let total = jobs.len();
    let workers = std::thread::available_parallelism().map_or(2, |n| n.get()).clamp(1, 4).min(total.max(1));
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let results: Vec<parking_lot::Mutex<Option<StretchResult>>> = (0..total).map(|_| parking_lot::Mutex::new(None)).collect();
    std::thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(job) = jobs.get(i) else { break };
                let r = match render(job, &cancel) {
                    Ok(p) => StretchResult { path: Some(p.to_string_lossy().into_owned()), error: None },
                    Err(e) => StretchResult { path: None, error: Some(e) },
                };
                *results[i].lock() = Some(r);
                progress(done.fetch_add(1, Ordering::Relaxed) + 1, total);
            });
        }
    });
    results.into_iter().map(|r| r.into_inner().unwrap_or(StretchResult { path: None, error: Some("Non elaborato".into()) })).collect()
}
