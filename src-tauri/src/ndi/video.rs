//! The video of the song decoded with Media Foundation (the codecs of Windows,
//! the same files the video window plays), one frame at a time at the time
//! asked: the NDI output follows the audio engine, like the video window.

use windows::core::{GUID, HSTRING};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::VT_I8;

use super::sdk::{Frame, BGRX};

const STREAM: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
const UNITS: f64 = 10_000_000.0; // Media Foundation counts in 100 ns

/// Within this much ahead the decoder reads on instead of seeking.
const READ_AHEAD: f64 = 1.0;

struct Format {
    height: u32,
    stride: i32,
    // Picture inside the decoded frame (x, y, w, h).
    crop: (u32, u32, u32, u32),
}

pub struct Decoder {
    reader: IMFSourceReader,
    format: Format,
    fps: (i32, i32),
    duration: f64,
    frame: Option<Frame>,
    // Time span of the frame held.
    start: f64,
    end: f64,
    eos: bool,
}

fn startup() -> windows::core::Result<()> {
    thread_local!(static STARTED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) });
    if STARTED.get() {
        return Ok(());
    }
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        MFStartup(MF_VERSION, MFSTARTUP_FULL)?;
    }
    STARTED.set(true);
    Ok(())
}

fn read_format(reader: &IMFSourceReader) -> windows::core::Result<Format> {
    unsafe {
        let mt = reader.GetCurrentMediaType(STREAM)?;
        let size = mt.GetUINT64(&MF_MT_FRAME_SIZE)?;
        let (width, height) = ((size >> 32) as u32, size as u32);
        let stride = mt.GetUINT32(&MF_MT_DEFAULT_STRIDE).map_or(width as i32 * 4, |s| s as i32);
        let mut crop = (0, 0, width, height);
        let mut area = [0u8; std::mem::size_of::<MFVideoArea>()];
        if mt.GetBlob(&MF_MT_MINIMUM_DISPLAY_APERTURE, &mut area, None).is_ok() {
            let a: MFVideoArea = std::ptr::read_unaligned(area.as_ptr() as *const MFVideoArea);
            let (x, y) = (a.OffsetX.value.max(0) as u32, a.OffsetY.value.max(0) as u32);
            let (w, h) = (a.Area.cx.max(0) as u32, a.Area.cy.max(0) as u32);
            if w > 0 && h > 0 && x + w <= width && y + h <= height {
                crop = (x, y, w, h);
            }
        }
        Ok(Format { height, stride, crop })
    }
}

impl Decoder {
    pub fn open(path: &str) -> Result<Self, String> {
        let err = |e: windows::core::Error| format!("video per NDI: {}", e.message());
        startup().map_err(err)?;
        unsafe {
            let mut attrs = None;
            MFCreateAttributes(&mut attrs, 1).map_err(err)?;
            let attrs = attrs.ok_or("video per NDI: attributi non creati")?;
            // Conversion to RGB32 by the reader (any codec of the system); the
            // "advanced" processor is about 4x faster than the basic one.
            attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1).map_err(err)?;
            let reader = MFCreateSourceReaderFromURL(&HSTRING::from(path), &attrs).map_err(err)?;
            let _ = reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false);
            reader.SetStreamSelection(STREAM, true).map_err(err)?;
            let mt = MFCreateMediaType().map_err(err)?;
            mt.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(err)?;
            mt.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32).map_err(err)?;
            reader.SetCurrentMediaType(STREAM, None, &mt).map_err(err)?;
            let format = read_format(&reader).map_err(err)?;
            let fps = reader
                .GetCurrentMediaType(STREAM)
                .and_then(|t| t.GetUINT64(&MF_MT_FRAME_RATE))
                .ok()
                .map(|r| ((r >> 32) as i32, r as i32))
                .filter(|&(n, d)| n > 0 && d > 0)
                .unwrap_or((30, 1));
            let duration = reader
                .GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
                .map_or(f64::INFINITY, |v| v.Anonymous.Anonymous.Anonymous.uhVal as f64 / UNITS);
            Ok(Decoder { reader, format, fps, duration, frame: None, start: 0.0, end: 0.0, eos: false })
        }
    }

    /// The frame on screen at `t` seconds of the video: before the start the
    /// first one, after the end the last one (like the paused video window).
    pub fn frame_at(&mut self, t: f64) -> Option<&Frame> {
        let t = t.clamp(0.0, (self.duration - 0.05).max(0.0));
        let held = self.frame.is_some() && t >= self.start;
        if held && (t < self.end || self.eos) {
            return self.frame.as_ref();
        }
        if !(held && t - self.end < READ_AHEAD) {
            self.seek(t);
        }
        while !self.eos {
            match self.read(t) {
                Ok(true) => break,
                Ok(false) => {}
                Err(_) => {
                    self.eos = true;
                }
            }
        }
        self.frame.as_ref()
    }

    fn seek(&mut self, t: f64) {
        let mut pos = PROPVARIANT::default();
        unsafe {
            let v = &mut *pos.Anonymous.Anonymous;
            v.vt = VT_I8;
            v.Anonymous.hVal = (t * UNITS) as i64;
            let _ = self.reader.SetCurrentPosition(&GUID::zeroed(), &pos);
        }
        self.eos = false;
        self.start = f64::INFINITY; // nothing held from here on
        self.end = f64::NEG_INFINITY;
    }

    /// Decodes the next frame; true once the one covering `t` is held.
    fn read(&mut self, t: f64) -> windows::core::Result<bool> {
        let (mut flags, mut ts, mut sample) = (0u32, 0i64, None);
        unsafe { self.reader.ReadSample(STREAM, 0, None, Some(&mut flags), Some(&mut ts), Some(&mut sample))? };
        let flags = flags as i32;
        if flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0 != 0 {
            self.format = read_format(&self.reader)?;
        }
        if flags & (MF_SOURCE_READERF_ENDOFSTREAM.0 | MF_SOURCE_READERF_ERROR.0) != 0 {
            self.eos = true;
            if self.frame.is_some() {
                self.start = self.start.min(t);
            }
            return Ok(true);
        }
        let Some(sample) = sample else { return Ok(false) };
        let frame_len = self.fps.1 as f64 / self.fps.0 as f64;
        let start = ts as f64 / UNITS;
        let len = unsafe { sample.GetSampleDuration() }.map_or(frame_len, |d| d as f64 / UNITS);
        let end = start + if len > 0.0 { len } else { frame_len };
        // Frames before the one asked are decoded but not copied.
        if end <= t {
            return Ok(false);
        }
        self.copy(&sample)?;
        self.start = start.min(t);
        self.end = end;
        Ok(true)
    }

    fn copy(&mut self, sample: &IMFSample) -> windows::core::Result<()> {
        let f = &self.format;
        let (cx, cy, cw, ch) = f.crop;
        let pitch = f.stride.unsigned_abs() as usize;
        let row = cw as usize * 4;
        let frame = self.frame.get_or_insert_with(|| Frame::black(cw, ch));
        if frame.width != cw || frame.height != ch {
            *frame = Frame::black(cw, ch);
        }
        frame.fourcc = BGRX;
        frame.fps = self.fps;
        unsafe {
            let buffer = sample.ConvertToContiguousBuffer()?;
            let (mut ptr, mut len) = (std::ptr::null_mut(), 0u32);
            buffer.Lock(&mut ptr, None, Some(&mut len))?;
            if !ptr.is_null() && (len as usize) >= pitch * f.height as usize {
                let src = std::slice::from_raw_parts(ptr, len as usize);
                for y in 0..ch as usize {
                    let line = cy as usize + y;
                    // A negative stride means the rows are stored bottom up.
                    let line = if f.stride < 0 { f.height as usize - 1 - line } else { line };
                    let at = line * pitch + cx as usize * 4;
                    frame.data[y * row..(y + 1) * row].copy_from_slice(&src[at..at + row]);
                }
            }
            buffer.Unlock()?;
        }
        Ok(())
    }
}
