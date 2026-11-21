//! NDI® outputs: the video of the song and the Gobbo (lyrics) as sources on
//! the network, for vMix, OBS, a switcher or an NDI screen. They run without
//! the output windows: the video is decoded here at the position of the audio
//! engine, the Gobbo picture is drawn by the UI (lib/ndi.js) when the slide
//! changes and sent again here at a steady frame rate.

mod sdk;
#[cfg(windows)]
mod video;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::audio::engine::Monitor;
use crate::audio::render::clock_ns;
use sdk::{Frame, Runtime, Sender, RGBX};

/// Size of the Gobbo picture drawn by the UI.
const PROMPTER_SIZE: (u32, u32) = (1920, 1080);
/// Shown by the video output while there is no video.
const BLACK_SIZE: (u32, u32) = (1920, 1080);
/// How long an output nobody receives waits for a receiver before looking at `stop` again.
const RECEIVER_WAIT_MS: u32 = 250;
/// How long a calibration flash stays white.
const FLASH_NS: u64 = 300_000_000;

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Video,
    Prompter,
}

/// The calibration of the latency (Impostazioni › Uscite NDI, with the phone as remote):
/// the output shows black, and white for FLASH_NS from `flash_at` (`clock_ns`), when the
/// beep of the engine is heard. The phone films the screen and listens to the speakers.
#[derive(Clone, Copy)]
struct Calib {
    kind: Kind,
    flash_at: u64,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct OutputConfig {
    pub enabled: bool,
    pub name: String,
    /// Milliseconds the network and the receiver keep the picture: it is sent that much ahead.
    #[serde(default)]
    pub latency: f64,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct NdiConfig {
    pub video: OutputConfig,
    pub prompter: OutputConfig,
}

#[derive(Clone, Debug, Deserialize)]
pub struct VideoSource {
    pub path: String,
    #[serde(default)]
    pub offset: f64,
    /// Fades to and from black (seconds) of a video item.
    #[serde(default, rename = "fadeIn")]
    pub fade_in: f64,
    #[serde(default, rename = "fadeOut")]
    pub fade_out: f64,
    /// Where the picture stops (seconds of the video, 0 = the end of the file): black after.
    #[serde(default)]
    pub end: f64,
}

/// Level of the picture at `t` seconds of a video `duration` long (as fadeLevel in media.js).
#[cfg_attr(not(windows), allow(dead_code))]
fn fade_level(t: f64, duration: f64, fade_in: f64, fade_out: f64, end: f64) -> f32 {
    let mut g = 1f64;
    let duration = if end > 0.0 { if duration > 0.0 { duration.min(end) } else { end } } else { duration };
    if end > 0.0 && t >= duration {
        return 0.0;
    }
    if fade_in > 0.0 {
        g = g.min(t / fade_in);
    }
    if fade_out > 0.0 && duration > 0.0 {
        g = g.min((duration - t) / fade_out);
    }
    g.clamp(0.0, 1.0) as f32
}

#[derive(Clone, Debug, Serialize)]
pub struct NdiStatus {
    /// Runtime missing.
    error: Option<String>,
    /// Why each output did not start.
    video_error: Option<String>,
    prompter_error: Option<String>,
    video: bool,
    prompter: bool,
}

/// An output running on its own thread, stopped when dropped.
struct Output {
    name: String,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Output {
    fn start(rt: &Arc<Runtime>, name: &str, run: impl FnOnce(Sender, Arc<AtomicBool>) + Send + 'static) -> Result<Self, String> {
        let sender = Sender::new(rt.clone(), name)?;
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let thread = std::thread::Builder::new()
            .name("livetools-ndi".into())
            .spawn(move || run(sender, flag))
            .map_err(|e| e.to_string())?;
        Ok(Output { name: name.into(), stop, thread: Some(thread) })
    }
}

impl Drop for Output {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[derive(Default)]
struct Shared {
    // Changed with a new generation, so the video thread reopens the file.
    video: Mutex<(u64, Option<VideoSource>)>,
    prompter: Mutex<Option<Arc<Frame>>>,
    /// Picture of the setlist on the video output when there is no video to show.
    still: Mutex<Option<Arc<Frame>>>,
    /// Seconds the video is sent ahead of the audio heard (latency of NDI and of the receiver).
    video_lead: Mutex<f64>,
    calib: Mutex<Option<Calib>>,
}

impl Shared {
    /// While `kind` is being calibrated: whether the flash is on now.
    fn flash(&self, kind: Kind) -> Option<bool> {
        let c = (*self.calib.lock())?;
        if c.kind != kind {
            return None;
        }
        let now = clock_ns();
        Some(c.flash_at > 0 && now >= c.flash_at && now < c.flash_at + FLASH_NS)
    }
}

fn solid(width: u32, height: u32, white: bool) -> Frame {
    let mut f = Frame::black(width, height);
    if white {
        f.data.fill(255);
    }
    f
}

struct Inner {
    runtime: Option<Arc<Runtime>>,
    error: Option<String>,
    video_error: Option<String>,
    prompter_error: Option<String>,
    video: Option<Output>,
    prompter: Option<Output>,
}

pub struct Ndi {
    inner: Mutex<Inner>,
    shared: Arc<Shared>,
    monitor: Arc<Monitor>,
}

impl Ndi {
    pub fn new(monitor: Arc<Monitor>) -> Self {
        Ndi {
            inner: Mutex::new(Inner { runtime: None, error: None, video_error: None, prompter_error: None, video: None, prompter: None }),
            shared: Arc::default(),
            monitor,
        }
    }

    fn status(inner: &Inner) -> NdiStatus {
        NdiStatus {
            error: inner.error.clone(),
            video_error: inner.video_error.clone(),
            prompter_error: inner.prompter_error.clone(),
            video: inner.video.is_some(),
            prompter: inner.prompter.is_some(),
        }
    }

    fn configure(&self, config: NdiConfig) -> NdiStatus {
        let mut inner = self.inner.lock();
        inner.error = None;
        if !config.video.enabled {
            inner.video_error = None;
        }
        if !config.prompter.enabled {
            inner.prompter_error = None;
        }
        *self.shared.video_lead.lock() = config.video.latency.clamp(0.0, 2000.0) / 1000.0;
        let wanted = |c: &OutputConfig, o: &Option<Output>| c.enabled && o.as_ref().map(|o| o.name.as_str()) != Some(c.name.trim());
        // Same name again: the old source goes away first.
        if !config.video.enabled || wanted(&config.video, &inner.video) {
            inner.video = None;
        }
        if !config.prompter.enabled || wanted(&config.prompter, &inner.prompter) {
            inner.prompter = None;
        }
        let start_video = config.video.enabled && inner.video.is_none();
        let start_prompter = config.prompter.enabled && inner.prompter.is_none();
        if !start_video && !start_prompter {
            return Self::status(&inner);
        }
        if inner.runtime.is_none() {
            match Runtime::load() {
                Ok(rt) => inner.runtime = Some(rt),
                Err(e) => {
                    inner.error = Some(e);
                    return Self::status(&inner);
                }
            }
        }
        let rt = inner.runtime.clone().unwrap();
        if start_video {
            let (shared, monitor) = (self.shared.clone(), self.monitor.clone());
            match Output::start(&rt, config.video.name.trim(), move |s, stop| video_loop(s, stop, shared, monitor)) {
                Ok(o) => (inner.video, inner.video_error) = (Some(o), None),
                Err(e) => inner.video_error = Some(e),
            }
        }
        if start_prompter {
            let shared = self.shared.clone();
            match Output::start(&rt, config.prompter.name.trim(), move |s, stop| prompter_loop(s, stop, shared)) {
                Ok(o) => (inner.prompter, inner.prompter_error) = (Some(o), None),
                Err(e) => inner.prompter_error = Some(e),
            }
        }
        Self::status(&inner)
    }

    /// Calibration of the latency of output `kind` ("video" | "prompter"): `count` beeps
    /// `interval_ms` apart, each with a white flash on the output when it is heard.
    pub fn calibrate(&self, kind: &str, count: u32, interval_ms: u64, mut beep: impl FnMut()) -> Result<(), String> {
        let kind = match kind {
            "video" => Kind::Video,
            "prompter" => Kind::Prompter,
            _ => return Err("uscita NDI sconosciuta".into()),
        };
        {
            let inner = self.inner.lock();
            let on = if kind == Kind::Video { inner.video.is_some() } else { inner.prompter.is_some() };
            if !on {
                return Err("Accendi prima l’uscita NDI".into());
            }
        }
        if self.monitor.shared.playing.load(Ordering::Relaxed) {
            return Err("Ferma il brano prima di calibrare".into());
        }
        struct Clear<'a>(&'a Mutex<Option<Calib>>);
        impl Drop for Clear<'_> {
            fn drop(&mut self) {
                *self.0.lock() = None;
            }
        }
        *self.shared.calib.lock() = Some(Calib { kind, flash_at: 0 });
        let _clear = Clear(&self.shared.calib);
        // Black for a moment first: the camera of the phone adjusts to it.
        std::thread::sleep(std::time::Duration::from_millis(800));
        let heard = &self.monitor.shared.calib_heard;
        for _ in 0..count.clamp(1, 30) {
            let before = heard.load(Ordering::Relaxed);
            beep();
            let asked = std::time::Instant::now();
            let at = loop {
                let at = heard.load(Ordering::Relaxed);
                if at != before {
                    break at;
                }
                if asked.elapsed().as_millis() > 1000 {
                    return Err("La scheda audio non suona: controlla Audio & uscite".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            };
            *self.shared.calib.lock() = Some(Calib { kind, flash_at: at });
            std::thread::sleep(std::time::Duration::from_millis(interval_ms.clamp(500, 5000)));
        }
        Ok(())
    }
}

fn video_loop(sender: Sender, stop: Arc<AtomicBool>, shared: Arc<Shared>, monitor: Arc<Monitor>) {
    let black = Frame::black(BLACK_SIZE.0, BLACK_SIZE.1);
    let white = solid(BLACK_SIZE.0, BLACK_SIZE.1, true);
    let mut seen = u64::MAX;
    #[cfg(windows)]
    let mut decoder: Option<(video::Decoder, VideoSource)> = None;
    #[cfg(windows)]
    let mut faded: Option<Frame> = None;
    while !stop.load(Ordering::Relaxed) {
        // Nobody receives the source: wait for someone (the video is picked up at the playhead then).
        if !sender.has_receivers(RECEIVER_WAIT_MS) {
            continue;
        }
        // Calibration: black and the flashes, without the compensation (it is what is measured).
        if let Some(on) = shared.flash(Kind::Video) {
            sender.send(if on { &white } else { &black });
            continue;
        }
        let (generation, source) = shared.video.lock().clone();
        let lead = *shared.video_lead.lock();
        #[cfg(windows)]
        {
            if generation != seen {
                seen = generation;
                decoder = source.and_then(|s| match video::Decoder::open(&s.path) {
                    Ok(d) => Some((d, s)),
                    Err(e) => {
                        eprintln!("{e}");
                        None
                    }
                });
            }
            // The video keeps its own times, slaved to the engine like the video window,
            // ahead by the latency of the network so it is seen with the audio.
            let frame = decoder.as_mut().and_then(|(d, s)| {
                let t = monitor.position() + lead - s.offset;
                let level = fade_level(t, d.duration(), s.fade_in, s.fade_out, s.end);
                d.frame_at(t).map(|f| (f, level))
            });
            match frame {
                Some((f, level)) if level < 0.999 => {
                    // Fading: a copy of the frame towards black.
                    let out = faded.get_or_insert_with(|| Frame::black(f.width, f.height));
                    out.width = f.width;
                    out.height = f.height;
                    out.fourcc = f.fourcc;
                    out.fps = f.fps;
                    out.data.resize(f.data.len(), 0);
                    let k = (level * 256.0) as u32;
                    out.data.iter_mut().zip(&f.data).for_each(|(o, i)| *o = ((*i as u32 * k) >> 8) as u8);
                    sender.send(out);
                }
                Some((f, _)) => sender.send(f),
                None => match shared.still.lock().clone() {
                    Some(still) => sender.send(&still),
                    None => sender.send(&black),
                },
            }
        }
        #[cfg(not(windows))]
        {
            let _ = (generation, source, lead, &monitor, &mut seen);
            sender.send(&black);
        }
    }
}

fn prompter_loop(sender: Sender, stop: Arc<AtomicBool>, shared: Arc<Shared>) {
    let black = Arc::new(Frame::black(PROMPTER_SIZE.0, PROMPTER_SIZE.1));
    let white = solid(PROMPTER_SIZE.0, PROMPTER_SIZE.1, true);
    while !stop.load(Ordering::Relaxed) {
        if !sender.has_receivers(RECEIVER_WAIT_MS) {
            continue;
        }
        if let Some(on) = shared.flash(Kind::Prompter) {
            sender.send(if on { &white } else { &black });
            continue;
        }
        let frame = shared.prompter.lock().clone().unwrap_or_else(|| black.clone());
        sender.send(&frame);
    }
}

#[tauri::command]
pub fn ndi_status(ndi: State<'_, Ndi>) -> NdiStatus {
    Ndi::status(&ndi.inner.lock())
}

#[tauri::command(async)]
pub fn ndi_configure(ndi: State<'_, Ndi>, config: NdiConfig) -> NdiStatus {
    ndi.configure(config)
}

/// The video of the song loaded (local file), or none.
#[tauri::command]
pub fn ndi_video_source(ndi: State<'_, Ndi>, source: Option<VideoSource>) {
    let mut v = ndi.shared.video.lock();
    v.0 = v.0.wrapping_add(1);
    v.1 = source;
}

/// The picture of the setlist for the video output without a video: RGBA pixels
/// of BLACK_SIZE as the raw request body, empty = none.
#[tauri::command]
pub fn ndi_video_still(ndi: State<'_, Ndi>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("immagine NDI non valida".into());
    };
    if data.is_empty() {
        *ndi.shared.still.lock() = None;
        return Ok(());
    }
    let (width, height) = BLACK_SIZE;
    if data.len() != (width * height * 4) as usize {
        return Err("immagine NDI di dimensioni errate".into());
    }
    *ndi.shared.still.lock() = Some(Arc::new(Frame { width, height, fourcc: RGBX, fps: (30, 1), data: data.clone() }));
    Ok(())
}

/// The Gobbo picture: RGBA pixels of PROMPTER_SIZE as the raw request body.
#[tauri::command]
pub fn ndi_prompter_frame(ndi: State<'_, Ndi>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("frame NDI non valido".into());
    };
    let (width, height) = PROMPTER_SIZE;
    if data.len() != (width * height * 4) as usize {
        return Err("frame NDI di dimensioni errate".into());
    }
    let frame = Frame { width, height, fourcc: RGBX, fps: (30, 1), data: data.clone() };
    *ndi.shared.prompter.lock() = Some(Arc::new(frame));
    Ok(())
}
