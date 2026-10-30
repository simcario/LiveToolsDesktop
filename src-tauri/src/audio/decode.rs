//! File decoding with Symphonia: opening, probing, seeking to a time and
//! converting any layout to interleaved stereo f32.

use std::fs::File;
use std::path::Path;

use serde::Serialize;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

pub struct Source {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    pub sample_rate: u32,
    pub channels: usize,
    pub frames: Option<u64>,
    sample_buf: Option<SampleBuffer<f32>>,
    /// Frames still to drop after an accurate seek.
    skip: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInfo {
    pub duration: Option<f64>,
    pub sample_rate: u32,
    pub channels: usize,
}

pub enum Next {
    /// Interleaved stereo frames.
    Frames,
    End,
}

impl Source {
    pub fn open(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }
        let probed = symphonia::default::get_probe()
            .format(
                &hint,
                mss,
                &FormatOptions { enable_gapless: true, ..Default::default() },
                &MetadataOptions::default(),
            )
            .map_err(|e| format!("Formato non supportato: {e}"))?;
        let format = probed.format;
        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL && t.codec_params.sample_rate.is_some())
            .ok_or("Nessuna traccia audio nel file")?;
        let params = track.codec_params.clone();
        let decoder = symphonia::default::get_codecs()
            .make(&params, &DecoderOptions::default())
            .map_err(|e| format!("Codec non supportato: {e}"))?;
        Ok(Self {
            track_id: track.id,
            sample_rate: params.sample_rate.unwrap_or(44_100),
            channels: params.channels.map(|c| c.count()).unwrap_or(2).max(1),
            frames: params.n_frames,
            format,
            decoder,
            sample_buf: None,
            skip: 0,
        })
    }

    pub fn info(&self) -> ProbeInfo {
        ProbeInfo {
            duration: self.frames.map(|f| f as f64 / self.sample_rate as f64),
            sample_rate: self.sample_rate,
            channels: self.channels,
        }
    }

    /// Accurate seek: the next frames returned start exactly at `seconds`.
    pub fn seek(&mut self, seconds: f64) -> Result<(), String> {
        if seconds <= 0.0 {
            return Ok(());
        }
        let time = Time::new(seconds.trunc() as u64, seconds.fract());
        let seeked = self
            .format
            .seek(SeekMode::Accurate, SeekTo::Time { time, track_id: Some(self.track_id) })
            .map_err(|e| format!("Seek non riuscito: {e}"))?;
        self.decoder.reset();
        self.skip = seeked.required_ts.saturating_sub(seeked.actual_ts);
        Ok(())
    }

    /// Decodes the next packet and appends interleaved stereo frames to `out`.
    pub fn next(&mut self, out: &mut Vec<f32>) -> Result<Next, String> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(p) => p,
                Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(Next::End),
                Err(Error::ResetRequired) => {
                    self.decoder.reset();
                    continue;
                }
                Err(e) => return Err(e.to_string()),
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            let decoded = match self.decoder.decode(&packet) {
                Ok(d) => d,
                Err(Error::DecodeError(_)) => continue,
                Err(e) => return Err(e.to_string()),
            };
            let spec = *decoded.spec();
            let cap = decoded.capacity() as u64;
            if self.sample_buf.as_ref().is_none_or(|b| b.capacity() < cap as usize * spec.channels.count()) {
                self.sample_buf = Some(SampleBuffer::new(cap, spec));
            }
            let buf = self.sample_buf.as_mut().unwrap();
            buf.copy_interleaved_ref(decoded);
            let ch = spec.channels.count().max(1);
            let mut samples = buf.samples();
            if self.skip > 0 {
                let frames = (samples.len() / ch) as u64;
                let drop = self.skip.min(frames);
                self.skip -= drop;
                samples = &samples[drop as usize * ch..];
                if samples.is_empty() {
                    continue;
                }
            }
            out.reserve(samples.len() / ch * 2);
            for frame in samples.chunks_exact(ch) {
                let (l, r) = if ch == 1 { (frame[0], frame[0]) } else { (frame[0], frame[1]) };
                out.push(l);
                out.push(r);
            }
            return Ok(Next::Frames);
        }
    }
}

pub fn probe(path: &Path) -> Result<ProbeInfo, String> {
    Source::open(path).map(|s| s.info())
}

pub const PEAKS_PER_SEC: u32 = 100;

/// Waveform overview: max |sample| every 1/100 s, quantized to 0..255.
/// Cached next to the media file (".peaks") so a song opens instantly the next time.
pub fn peaks(path: &Path) -> Result<(Vec<u8>, f64), String> {
    let cache = path.with_extension(format!(
        "{}.peaks",
        path.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    if let (Ok(meta_src), Ok(meta_cache)) = (std::fs::metadata(path), std::fs::metadata(&cache)) {
        if meta_cache.modified().ok() >= meta_src.modified().ok() {
            if let Ok(bytes) = std::fs::read(&cache) {
                if bytes.len() >= 8 {
                    let duration = f64::from_le_bytes(bytes[..8].try_into().unwrap());
                    return Ok((bytes[8..].to_vec(), duration));
                }
            }
        }
    }

    let mut src = Source::open(path)?;
    let per_bucket = (src.sample_rate / PEAKS_PER_SEC).max(1) as usize;
    let mut out = Vec::new();
    let mut peaks = Vec::new();
    let (mut acc, mut n, mut total) = (0f32, 0usize, 0u64);
    loop {
        out.clear();
        match src.next(&mut out)? {
            Next::End => break,
            Next::Frames => {
                for f in out.chunks_exact(2) {
                    acc = acc.max(f[0].abs()).max(f[1].abs());
                    n += 1;
                    if n == per_bucket {
                        peaks.push((acc.min(1.0) * 255.0) as u8);
                        acc = 0.0;
                        n = 0;
                    }
                }
                total += (out.len() / 2) as u64;
            }
        }
    }
    if n > 0 {
        peaks.push((acc.min(1.0) * 255.0) as u8);
    }
    let duration = total as f64 / src.sample_rate as f64;
    let mut bytes = duration.to_le_bytes().to_vec();
    bytes.extend_from_slice(&peaks);
    let _ = std::fs::write(&cache, bytes);
    Ok((peaks, duration))
}
