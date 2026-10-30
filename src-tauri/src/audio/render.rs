//! Real-time renderer, called by the audio interface callback. It never locks
//! or allocates: commands arrive on a lock-free queue, replaced objects are
//! handed back to a non real-time thread to be dropped.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU8, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::Arc;

use rtrb::Consumer;
use serde::Deserialize;

use super::atomic::AtomicF32;
use super::stream::TrackStream;
use super::tempo::{ClickKind, TempoFrames};

pub const MAX_OUTPUTS: usize = 64;
const MAX_BLOCK: usize = 4096;

pub const OUT_STEREO: u8 = 0;
pub const OUT_MONO: u8 = 1;
pub const OUT_OFF: u8 = 2;

/// State shared by the engine, the audio callback and the UI ticker.
pub struct Shared {
    pub playing: AtomicBool,
    /// Waiting for the disk readers before moving the playhead.
    pub waiting: AtomicBool,
    pub position: AtomicI64,
    pub sample_rate: AtomicU32,
    pub channels: AtomicU32,
    pub ended: AtomicBool,
    pub underruns: AtomicU32,
    pub master: AtomicF32,
    pub out_peaks: Vec<AtomicF32>,
}

impl Shared {
    pub fn new() -> Self {
        Self {
            playing: AtomicBool::new(false),
            waiting: AtomicBool::new(false),
            position: AtomicI64::new(0),
            sample_rate: AtomicU32::new(48_000),
            channels: AtomicU32::new(2),
            ended: AtomicBool::new(false),
            underruns: AtomicU32::new(0),
            master: AtomicF32::new(1.0),
            out_peaks: (0..MAX_OUTPUTS).map(|_| AtomicF32::new(0.0)).collect(),
        }
    }
}

/// Mix of one track, written by the UI, read by the callback.
pub struct TrackControl {
    pub gain: AtomicF32,
    pub pan: AtomicF32,
    pub mute: AtomicBool,
    pub solo: AtomicBool,
    pub out_start: AtomicU32,
    pub out_mode: AtomicU8,
    pub peak_l: AtomicF32,
    pub peak_r: AtomicF32,
}

impl TrackControl {
    pub fn new() -> Self {
        Self {
            gain: AtomicF32::new(1.0),
            pan: AtomicF32::new(0.0),
            mute: AtomicBool::new(false),
            solo: AtomicBool::new(false),
            out_start: AtomicU32::new(0),
            out_mode: AtomicU8::new(OUT_STEREO),
            peak_l: AtomicF32::new(0.0),
            peak_r: AtomicF32::new(0.0),
        }
    }
}

/// Synthesised metronome sounds (no samples: nothing to load or allocate).
#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClickSound {
    /// Short sine blip, same as the web metronome.
    #[default]
    Beep,
    Woodblock,
    Cowbell,
    /// Rim / drumstick: resonant noise burst.
    Stick,
    HiHat,
}

/// Level and pitch of one kind of beat, relative to the sound's own.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(default)]
pub struct KindMix {
    /// Linear gain (0 = silent).
    pub gain: f32,
    /// Frequency ratio (1 = the sound's pitch).
    pub pitch: f32,
}

impl Default for KindMix {
    fn default() -> Self {
        Self { gain: 1.0, pitch: 1.0 }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(default)]
pub struct ClickKinds {
    pub accent: KindMix,
    pub beat: KindMix,
    pub group: KindMix,
    pub count: KindMix,
}

impl ClickKinds {
    fn of(&self, kind: ClickKind) -> KindMix {
        match kind {
            ClickKind::Accent => self.accent,
            ClickKind::Beat => self.beat,
            ClickKind::Group => self.group,
            ClickKind::Count => self.count,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickParams {
    pub enabled: bool,
    /// Linear gain.
    pub gain: f32,
    pub out_start: u32,
    pub mono: bool,
    #[serde(default)]
    pub sound: ClickSound,
    #[serde(default)]
    pub kinds: ClickKinds,
}

impl Default for ClickParams {
    fn default() -> Self {
        Self { enabled: false, gain: 0.8, out_start: 0, mono: false, sound: ClickSound::Beep, kinds: ClickKinds::default() }
    }
}

pub struct RtTrack {
    pub control: Arc<TrackControl>,
    pub stream: Option<TrackStream>,
    /// Frames missed during an underrun, skipped later to stay in sync.
    deficit: usize,
}

impl RtTrack {
    pub fn new(control: Arc<TrackControl>, stream: Option<TrackStream>) -> Self {
        Self { control, stream, deficit: 0 }
    }
}

pub enum RtCmd {
    Tracks { tracks: Box<Vec<RtTrack>>, position: i64 },
    Streams { streams: Box<Vec<Option<TrackStream>>>, position: i64 },
    Tempo(Option<Box<TempoFrames>>),
    Click(ClickParams),
    /// One click with the current sound, heard only while stopped (settings).
    PreviewClick(ClickKind),
    Duration(i64),
    /// count_in: the count-in clicks sound even with the click off.
    Play { count_in: bool },
    Stop,
}

/// Objects replaced in the callback, dropped by the UI ticker thread.
pub enum Garbage {
    Tracks(#[allow(dead_code)] Box<Vec<RtTrack>>),
    Streams(#[allow(dead_code)] Box<Vec<Option<TrackStream>>>),
    Tempo(#[allow(dead_code)] Box<TempoFrames>),
}

struct ClickVoice {
    sound: ClickSound,
    phase: f32,
    inc: f32,
    phase2: f32,
    inc2: f32,
    /// Woodblock pitch drop, fading to 0.
    drop: f32,
    drop_k: f32,
    amp: f32,
    peak: f32,
    attack: u32,
    decay: f32,
    age: u32,
    left: u32,
    rng: u32,
    // State-variable filter (TPT) for the noise sounds.
    k: f32,
    a1: f32,
    a2: f32,
    a3: f32,
    ic1: f32,
    ic2: f32,
}

const TAU: f32 = std::f32::consts::TAU;

impl ClickVoice {
    fn idle() -> Self {
        Self {
            sound: ClickSound::Beep,
            phase: 0.0,
            inc: 0.0,
            phase2: 0.0,
            inc2: 0.0,
            drop: 0.0,
            drop_k: 0.0,
            amp: 0.0,
            peak: 0.0,
            attack: 1,
            decay: 0.0,
            age: 0,
            left: 0,
            rng: 0x9E37_79B9,
            k: 1.0,
            a1: 0.0,
            a2: 0.0,
            a3: 0.0,
            ic1: 0.0,
            ic2: 0.0,
        }
    }

    fn trigger(&mut self, kind: ClickKind, sr: f32, params: &ClickParams) {
        let i = match kind {
            ClickKind::Accent => 0,
            ClickKind::Count => 1,
            ClickKind::Group => 2,
            ClickKind::Beat => 3,
        };
        // Frequency and level by kind, length in seconds, filter damping.
        let (freqs, peaks, secs, damping): ([f32; 4], [f32; 4], f32, f32) = match params.sound {
            ClickSound::Beep => ([1600.0, 1200.0, 1100.0, 880.0], [0.9, 0.9, 0.9, 0.55], 0.045, 1.0),
            ClickSound::Woodblock => ([1250.0, 1000.0, 950.0, 800.0], [0.9, 0.9, 0.9, 0.6], 0.06, 1.0),
            ClickSound::Cowbell => ([800.0, 680.0, 640.0, 560.0], [0.7, 0.7, 0.7, 0.45], 0.14, 1.0),
            ClickSound::Stick => ([2400.0, 2000.0, 1900.0, 1700.0], [0.9, 0.9, 0.9, 0.6], 0.035, 0.12),
            ClickSound::HiHat => ([9000.0, 8000.0, 7600.0, 7000.0], [0.8, 0.8, 0.8, 0.5], 0.05, 1.2),
        };
        let mix = params.kinds.of(kind);
        let peak = peaks[i] * mix.gain.max(0.0);
        let freq = (freqs[i] * mix.pitch.clamp(0.1, 8.0)).min(sr * 0.45);
        if peak <= 1e-4 {
            self.left = 0;
            return;
        }
        let len = ((secs * sr) as u32).max(1);
        self.sound = params.sound;
        self.phase = 0.0;
        self.phase2 = 0.0;
        self.inc = TAU * freq / sr;
        self.inc2 = TAU * freq * if params.sound == ClickSound::Cowbell { 1.48 } else { 2.73 } / sr;
        self.drop = 0.6;
        self.drop_k = (-1.0 / (0.004 * sr)).exp();
        self.peak = peak;
        self.amp = 0.0;
        let attack = if matches!(params.sound, ClickSound::Stick | ClickSound::HiHat) { 0.0005 } else { 0.002 };
        self.attack = ((attack * sr) as u32).max(1);
        self.decay = (0.0001f32 / peak).powf(1.0 / len as f32);
        self.age = 0;
        self.left = len;
        let g = (std::f32::consts::PI * freq / sr).tan();
        self.k = damping;
        self.a1 = 1.0 / (1.0 + g * (g + damping));
        self.a2 = g * self.a1;
        self.a3 = g * self.a2;
        self.ic1 = 0.0;
        self.ic2 = 0.0;
    }

    fn noise(&mut self) -> f32 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 17;
        self.rng ^= self.rng << 5;
        self.rng as f32 / u32::MAX as f32 * 2.0 - 1.0
    }

    /// One filter step: (band, high).
    fn svf(&mut self, x: f32) -> (f32, f32) {
        let v3 = x - self.ic2;
        let v1 = self.a1 * self.ic1 + self.a2 * v3;
        let v2 = self.ic2 + self.a2 * self.ic1 + self.a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;
        (v1, x - self.k * v1 - v2)
    }

    fn next(&mut self) -> f32 {
        if self.left == 0 {
            return 0.0;
        }
        if self.age < self.attack {
            self.amp = self.peak * (self.age + 1) as f32 / self.attack as f32;
        } else {
            self.amp *= self.decay;
        }
        let s = match self.sound {
            ClickSound::Beep => self.phase.sin(),
            ClickSound::Woodblock => {
                self.drop *= self.drop_k;
                self.phase.sin() + 0.3 * self.drop * self.phase2.sin()
            }
            ClickSound::Cowbell => {
                let (a, b) = (self.phase, self.phase2);
                0.5 * (a.sin() + 0.3 * (3.0 * a).sin() + b.sin() + 0.3 * (3.0 * b).sin())
            }
            ClickSound::Stick => {
                let x = self.noise();
                let (band, _) = self.svf(x);
                2.5 * self.k * band + 0.3 * self.phase.sin()
            }
            ClickSound::HiHat => {
                let x = self.noise();
                0.9 * self.svf(x).1
            }
        } * self.amp;
        // The woodblock starts sharp and falls to its pitch in a few ms.
        let rise = if self.sound == ClickSound::Woodblock { 1.0 + self.drop } else { 1.0 };
        self.phase += self.inc * rise;
        if self.phase > TAU {
            self.phase -= TAU;
        }
        self.phase2 += self.inc2;
        if self.phase2 > TAU {
            self.phase2 -= TAU;
        }
        self.age += 1;
        self.left -= 1;
        s
    }
}

pub struct Renderer {
    cmds: Consumer<RtCmd>,
    garbage: SyncSender<Garbage>,
    shared: Arc<Shared>,
    tracks: Vec<RtTrack>,
    tempo: Option<Box<TempoFrames>>,
    click: ClickParams,
    voice: ClickVoice,
    preview: Option<ClickKind>,
    duration: i64,
    waited: usize,
    count_in: bool,
    scratch: Vec<f32>,
}

impl Renderer {
    pub fn new(cmds: Consumer<RtCmd>, garbage: SyncSender<Garbage>, shared: Arc<Shared>) -> Self {
        Self {
            cmds,
            garbage,
            shared,
            tracks: Vec::new(),
            tempo: None,
            click: ClickParams::default(),
            voice: ClickVoice::idle(),
            preview: None,
            duration: 0,
            waited: 0,
            count_in: false,
            scratch: vec![0.0; MAX_BLOCK * 2],
        }
    }

    fn trash(&self, g: Garbage) {
        // If the queue is full the object is dropped here: rare and harmless.
        let _ = self.garbage.try_send(g);
    }

    fn apply_commands(&mut self) {
        while let Ok(cmd) = self.cmds.pop() {
            match cmd {
                RtCmd::Tracks { mut tracks, position } => {
                    std::mem::swap(&mut self.tracks, &mut *tracks);
                    self.trash(Garbage::Tracks(tracks));
                    self.locate(position);
                }
                RtCmd::Streams { mut streams, position } => {
                    for (t, s) in self.tracks.iter_mut().zip(streams.iter_mut()) {
                        std::mem::swap(&mut t.stream, s);
                        t.deficit = 0;
                    }
                    self.trash(Garbage::Streams(streams));
                    self.locate(position);
                }
                RtCmd::Tempo(t) => {
                    if let Some(old) = std::mem::replace(&mut self.tempo, t) {
                        self.trash(Garbage::Tempo(old));
                    }
                }
                RtCmd::Click(c) => self.click = c,
                RtCmd::PreviewClick(k) => self.preview = Some(k),
                RtCmd::Duration(d) => self.duration = d,
                RtCmd::Play { count_in } => {
                    self.preview = None;
                    self.voice.left = 0;
                    self.count_in = count_in;
                    self.shared.ended.store(false, Ordering::Relaxed);
                    self.shared.waiting.store(true, Ordering::Relaxed);
                    self.waited = 0;
                    self.shared.playing.store(true, Ordering::Relaxed);
                }
                RtCmd::Stop => {
                    self.shared.playing.store(false, Ordering::Relaxed);
                    self.voice.left = 0;
                }
            }
        }
    }

    fn locate(&mut self, position: i64) {
        self.shared.position.store(position, Ordering::Relaxed);
        self.shared.waiting.store(true, Ordering::Relaxed);
        self.waited = 0;
        self.voice.left = 0;
    }

    /// Every reader has a quarter of a second ready (or has finished).
    fn streams_ready(&self, sr: usize) -> bool {
        let need = (sr / 4) * 2;
        self.tracks.iter().all(|t| match &t.stream {
            None => true,
            Some(s) => s.rx.slots() >= need || s.eof.load(Ordering::Acquire),
        })
    }

    /// Fills `out` (interleaved, `ch` channels).
    pub fn process(&mut self, out: &mut [f32], ch: usize) {
        out.fill(0.0);
        self.apply_commands();
        if ch == 0 {
            return;
        }
        let sr = self.shared.sample_rate.load(Ordering::Relaxed) as usize;
        let frames = out.len() / ch;
        if !self.shared.playing.load(Ordering::Relaxed) {
            let preview = self.preview.take().map(|k| [(0, k)]);
            self.mix_click(out, frames, ch, sr, preview.as_ref().map_or(&[], |p| &p[..]));
            return;
        }
        if self.shared.waiting.load(Ordering::Relaxed) {
            // Start only when the disk readers are ahead (at most 1.5 s of waiting).
            self.waited += frames;
            if !self.streams_ready(sr) && self.waited < sr * 3 / 2 {
                return;
            }
            self.shared.waiting.store(false, Ordering::Relaxed);
        }
        let mut done = 0;
        while done < frames {
            let n = (frames - done).min(MAX_BLOCK);
            self.render_block(&mut out[done * ch..(done + n) * ch], n, ch, sr);
            done += n;
        }
        for c in 0..ch.min(MAX_OUTPUTS) {
            let mut peak = 0f32;
            for f in 0..frames {
                peak = peak.max(out[f * ch + c].abs());
            }
            self.shared.out_peaks[c].store_max(peak);
        }
        let pos = self.shared.position.load(Ordering::Relaxed);
        if self.duration > 0 && pos >= self.duration + sr as i64 / 2 {
            self.shared.playing.store(false, Ordering::Relaxed);
            self.shared.ended.store(true, Ordering::Relaxed);
        }
    }

    fn render_block(&mut self, out: &mut [f32], frames: usize, ch: usize, sr: usize) {
        let pos = self.shared.position.load(Ordering::Relaxed);
        let master = self.shared.master.load();
        let any_solo = self.tracks.iter().any(|t| t.control.solo.load(Ordering::Relaxed));
        // Tracks start at 0: the count-in (negative positions) is click only.
        let lead = if pos < 0 { ((-pos) as usize).min(frames) } else { 0 };
        let n = frames - lead;

        for t in self.tracks.iter_mut() {
            let Some(stream) = t.stream.as_mut() else { continue };
            if n == 0 {
                continue;
            }
            if t.deficit > 0 {
                let skip = t.deficit.min(stream.rx.slots() / 2);
                if let Ok(chunk) = stream.rx.read_chunk(skip * 2) {
                    chunk.commit_all();
                }
                t.deficit -= skip;
            }
            let take = n.min(stream.rx.slots() / 2);
            let buf = &mut self.scratch[..take * 2];
            if let Ok(chunk) = stream.rx.read_chunk(take * 2) {
                let (a, b) = chunk.as_slices();
                buf[..a.len()].copy_from_slice(a);
                buf[a.len()..].copy_from_slice(b);
                chunk.commit_all();
            }
            if take < n && !stream.eof.load(Ordering::Acquire) {
                t.deficit += n - take;
                self.shared.underruns.fetch_add(1, Ordering::Relaxed);
            }

            let c = &t.control;
            let audible = !c.mute.load(Ordering::Relaxed) && (!any_solo || c.solo.load(Ordering::Relaxed));
            let mode = c.out_mode.load(Ordering::Relaxed);
            let gain = c.gain.load() * master;
            let pan = c.pan.load().clamp(-1.0, 1.0);
            let (gl, gr) = (gain * (1.0 - pan).min(1.0), gain * (1.0 + pan).min(1.0));
            let (mut pl, mut pr) = (0f32, 0f32);
            let mut start = c.out_start.load(Ordering::Relaxed) as usize;
            let stereo = mode == OUT_STEREO && ch >= 2;
            // Outputs the interface doesn't have fall back to the first ones.
            if (stereo && start + 1 >= ch) || start >= ch {
                start = 0;
            }
            for i in 0..take {
                let l = buf[i * 2] * gl;
                let r = buf[i * 2 + 1] * gr;
                pl = pl.max(l.abs());
                pr = pr.max(r.abs());
                if !audible || mode == OUT_OFF {
                    continue;
                }
                let o = (lead + i) * ch + start;
                if stereo {
                    out[o] += l;
                    out[o + 1] += r;
                } else {
                    out[o] += (l + r) * 0.5;
                }
            }
            if audible {
                c.peak_l.store_max(pl);
                c.peak_r.store_max(pr);
            }
        }

        if let Some(tempo) = self.tempo.as_ref() {
            let click = self.click;
            let count_in = self.count_in;
            let mut triggers = [(0usize, ClickKind::Beat); 16];
            let mut count = 0;
            tempo.clicks_in(pos, pos + frames as i64, |f, kind, in_count_in| {
                // A requested count-in always sounds, even with the click off.
                if (click.enabled || (count_in && in_count_in)) && count < triggers.len() {
                    triggers[count] = ((f - pos) as usize, kind);
                    count += 1;
                }
            });
            self.mix_click(out, frames, ch, sr, &triggers[..count]);
        }

        self.shared.position.store(pos + frames as i64, Ordering::Relaxed);
    }

    /// Adds the click voice to its output, triggering it at the given frames.
    fn mix_click(&mut self, out: &mut [f32], frames: usize, ch: usize, sr: usize, triggers: &[(usize, ClickKind)]) {
        if triggers.is_empty() && self.voice.left == 0 {
            return;
        }
        let click = self.click;
        let mut start = click.out_start as usize;
        let stereo = !click.mono && ch >= 2;
        if (stereo && start + 1 >= ch) || start >= ch {
            start = 0;
        }
        let mut next = 0;
        for i in 0..frames {
            while next < triggers.len() && triggers[next].0 == i {
                self.voice.trigger(triggers[next].1, sr as f32, &click);
                next += 1;
            }
            if self.voice.left == 0 {
                if next >= triggers.len() {
                    break;
                }
                continue;
            }
            let s = self.voice.next() * click.gain;
            let o = i * ch + start;
            out[o] += s;
            if stereo {
                out[o + 1] += s;
            }
        }
    }
}
