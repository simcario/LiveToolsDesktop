//! Real-time renderer, called by the audio interface callback. It never locks
//! or allocates: commands arrive on a lock-free queue, replaced objects are
//! handed back to a non real-time thread to be dropped.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, AtomicU8, Ordering};
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
    /// Id of the last jump that happened (0: none yet).
    pub jump_fired: AtomicU64,
    /// Id of the last change to the next song (transition) that happened.
    pub next_fired: AtomicU64,
    pub master: AtomicF32,
    /// Tracks Fade: gain of the tracks (1 = in, 0 = faded out), and where it is going.
    pub fade: AtomicF32,
    pub fade_target: AtomicF32,
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
            jump_fired: AtomicU64::new(0),
            next_fired: AtomicU64::new(0),
            master: AtomicF32::new(1.0),
            fade: AtomicF32::new(1.0),
            fade_target: AtomicF32::new(1.0),
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

/// Pad Player: a synthesised ambient pad in a key, on its own output. It plays
/// with the transport stopped too, and moves to a new key with a crossfade.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PadParams {
    pub enabled: bool,
    /// Pitch class of the key: 0 = C … 11 = B.
    pub key: u8,
    /// Linear gain.
    pub gain: f32,
    pub out_start: u32,
    pub mono: bool,
}

impl Default for PadParams {
    fn default() -> Self {
        Self { enabled: false, key: 0, gain: 0.5, out_start: 0, mono: false }
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
    /// At frame `at` the playhead moves to `to`, the readers already ahead:
    /// no wait and no gap. Replaces the jump armed before.
    Jump { id: u64, at: i64, to: i64, streams: Box<Vec<Option<TrackStream>>> },
    CancelJump,
    /// Tracks Fade: the tracks go to `target` (0 or 1) in `seconds`; click and pad don't fade.
    Fade { target: f32, seconds: f32 },
    Pad(PadParams),
    /// At frame `at` the next song takes the place of this one, from its start:
    /// with `overlap` this one goes on to its end at full volume, otherwise the
    /// two crossfade in `xfade` frames.
    Next(Box<NextSong>),
    CancelNext,
    /// count_in: the count-in clicks sound even with the click off.
    Play { count_in: bool },
    Stop,
}

pub struct NextSong {
    pub id: u64,
    pub at: i64,
    pub tracks: Box<Vec<RtTrack>>,
    /// Taken by the callback when it changes song (no allocation there).
    pub tempo: Option<Box<TempoFrames>>,
    pub duration: i64,
    pub overlap: bool,
    pub xfade: i64,
}

/// Objects replaced in the callback, dropped by the UI ticker thread.
pub enum Garbage {
    Tracks(#[allow(dead_code)] Box<Vec<RtTrack>>),
    Streams(#[allow(dead_code)] Box<Vec<Option<TrackStream>>>),
    Tempo(#[allow(dead_code)] Box<TempoFrames>),
    /// The song that ended its crossfade or overlap (moving a Vec allocates nothing).
    Tail(#[allow(dead_code)] Vec<RtTrack>),
    Next(#[allow(dead_code)] Box<NextSong>),
}

struct ArmedJump {
    id: u64,
    at: i64,
    to: i64,
    streams: Box<Vec<Option<TrackStream>>>,
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

/// Partials of the pad over the root of the key (2nd octave): ratio and level.
/// Root, fifth, octaves and a ninth, no third: it fits major and minor songs.
const PAD_PARTIALS: [(f32, f32); 7] = [(1.0, 0.5), (2.0, 0.42), (3.0, 0.34), (4.0, 0.26), (4.5, 0.13), (6.0, 0.12), (8.0, 0.06)];
const PAD_OSC: usize = PAD_PARTIALS.len() * 2;
/// Seconds to come in and to go out (also between two keys).
const PAD_ATTACK: f32 = 2.5;
const PAD_RELEASE: f32 = 3.5;

/// One key of the pad: two slightly detuned sines per partial, one per side,
/// each partial breathing at its own slow rate.
struct PadVoice {
    key: u8,
    level: f32,
    target: f32,
    phase: [f32; PAD_OSC],
    inc: [f32; PAD_OSC],
    lfo: [f32; PAD_PARTIALS.len()],
    lfo_inc: [f32; PAD_PARTIALS.len()],
}

impl PadVoice {
    fn idle() -> Self {
        Self {
            key: u8::MAX,
            level: 0.0,
            target: 0.0,
            phase: [0.0; PAD_OSC],
            inc: [0.0; PAD_OSC],
            lfo: [0.0; PAD_PARTIALS.len()],
            lfo_inc: [0.0; PAD_PARTIALS.len()],
        }
    }

    fn set_key(&mut self, key: u8, sr: f32) {
        self.key = key;
        let root = 65.406 * 2f32.powf(key as f32 / 12.0);
        for (j, (ratio, _)) in PAD_PARTIALS.iter().enumerate() {
            for (side, cents) in [(0, -4.0f32), (1, 4.0)] {
                let f = (root * ratio * 2f32.powf(cents / 1200.0)).min(sr * 0.45);
                self.inc[j * 2 + side] = TAU * f / sr;
                self.phase[j * 2 + side] = (j * 2 + side) as f32 * 0.7;
            }
            self.lfo_inc[j] = TAU * (0.05 + 0.037 * j as f32) / sr;
            self.lfo[j] = j as f32 * 1.3;
        }
    }

    fn sounding(&self) -> bool {
        self.level > 0.0 || self.target > 0.0
    }

    /// (left, right) of one frame.
    fn next(&mut self, up: f32, down: f32) -> (f32, f32) {
        if self.level < self.target {
            self.level = (self.level + up).min(self.target);
        } else if self.level > self.target {
            self.level = (self.level - down).max(self.target);
        }
        if self.level <= 0.0 {
            return (0.0, 0.0);
        }
        let (mut l, mut r) = (0f32, 0f32);
        for (j, (_, amp)) in PAD_PARTIALS.iter().enumerate() {
            let a = amp * (0.7 + 0.3 * self.lfo[j].sin());
            l += a * self.phase[j * 2].sin();
            r += a * self.phase[j * 2 + 1].sin();
            self.lfo[j] = (self.lfo[j] + self.lfo_inc[j]) % TAU;
        }
        for k in 0..PAD_OSC {
            self.phase[k] += self.inc[k];
            if self.phase[k] > TAU {
                self.phase[k] -= TAU;
            }
        }
        // Equal power: no dip in the volume while two keys cross.
        let g = (self.level * std::f32::consts::FRAC_PI_2).sin() * 0.4;
        (l * g, r * g)
    }
}

/// Gain of a crossfade at `x` (0 → 1), equal power.
fn xfade_curve(x: f32) -> f32 {
    (x.clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2).sin()
}

/// Mixes a deck of tracks into `out`: `n` frames from frame `lead` of the
/// block, frame f weighted by `env[f]`. Reports underruns only for the deck playing.
#[allow(clippy::too_many_arguments)]
fn mix_tracks(tracks: &mut [RtTrack], scratch: &mut [f32], out: &mut [f32], lead: usize, n: usize, ch: usize, env: &[f32], master: f32, underruns: Option<&AtomicU32>) {
    if n == 0 {
        return;
    }
    let any_solo = tracks.iter().any(|t| t.control.solo.load(Ordering::Relaxed));
    for t in tracks.iter_mut() {
        let Some(stream) = t.stream.as_mut() else { continue };
        if t.deficit > 0 {
            let skip = t.deficit.min(stream.rx.slots() / 2);
            if let Ok(chunk) = stream.rx.read_chunk(skip * 2) {
                chunk.commit_all();
            }
            t.deficit -= skip;
        }
        let take = n.min(stream.rx.slots() / 2);
        let buf = &mut scratch[..take * 2];
        if let Ok(chunk) = stream.rx.read_chunk(take * 2) {
            let (a, b) = chunk.as_slices();
            buf[..a.len()].copy_from_slice(a);
            buf[a.len()..].copy_from_slice(b);
            chunk.commit_all();
        }
        if take < n && !stream.eof.load(Ordering::Acquire) {
            if let Some(u) = underruns {
                t.deficit += n - take;
                u.fetch_add(1, Ordering::Relaxed);
            }
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
            let k = env[lead + i];
            let l = buf[i * 2] * gl * k;
            let r = buf[i * 2 + 1] * gr * k;
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
}

/// Length of the fade around a jump: 4 ms.
fn jump_ramp(sr: usize) -> i64 {
    (sr as i64 / 250).max(1)
}

/// Gain of frame `f` of a block: `until` frames from the block start to the
/// jump, `fade_in` frames left of the fade after the last one.
fn jump_envelope(f: i64, until: Option<i64>, fade_in: i64, ramp: i64) -> f32 {
    let out = until.map_or(1.0, |u| ((u - f) as f32 / ramp as f32).clamp(0.0, 1.0));
    let start = if fade_in > 0 { ((ramp - fade_in + f + 1) as f32 / ramp as f32).clamp(0.0, 1.0) } else { 1.0 };
    out * start
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
    jump: Option<ArmedJump>,
    /// Frames left of the fade after a jump.
    fade_in: usize,
    scratch: Vec<f32>,
    /// Gain of each frame of the block: of the song playing, and of the one going out.
    env: Vec<f32>,
    tail_env: Vec<f32>,
    next: Option<Box<NextSong>>,
    /// The song before, still heard during a crossfade or an overlap.
    tail: Vec<RtTrack>,
    tail_on: bool,
    /// Position of the tail's fade (1 → 0) and its step per frame (0: overlap).
    tail_x: f32,
    tail_step: f32,
    /// Crossfade in of the song playing: frames done and length.
    xin_done: i64,
    xin_len: i64,
    /// Tracks Fade.
    fade_gain: f32,
    fade_target: f32,
    fade_step: f32,
    pad: PadParams,
    pads: [PadVoice; 2],
    pad_on: usize,
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
            jump: None,
            fade_in: 0,
            scratch: vec![0.0; MAX_BLOCK * 2],
            env: vec![1.0; MAX_BLOCK],
            tail_env: vec![0.0; MAX_BLOCK],
            next: None,
            tail: Vec::new(),
            tail_on: false,
            tail_x: 0.0,
            tail_step: 0.0,
            xin_done: 0,
            xin_len: 0,
            fade_gain: 1.0,
            fade_target: 1.0,
            fade_step: 0.0,
            pad: PadParams::default(),
            pads: [PadVoice::idle(), PadVoice::idle()],
            pad_on: 0,
        }
    }

    /// The song before stops being heard (stop, new song, move of the playhead).
    fn drop_tail(&mut self) {
        self.tail_on = false;
        if !self.tail.is_empty() {
            let tail = std::mem::take(&mut self.tail);
            self.trash(Garbage::Tail(tail));
        }
    }

    fn reset_fade(&mut self) {
        self.fade_gain = 1.0;
        self.fade_target = 1.0;
        self.shared.fade.store(1.0);
        self.shared.fade_target.store(1.0);
    }

    fn set_pad(&mut self, p: PadParams, sr: f32) {
        let key = p.key % 12;
        let [a, b] = &mut self.pads;
        let (cur, other) = if self.pad_on == 0 { (a, b) } else { (b, a) };
        if !p.enabled {
            cur.target = 0.0;
            other.target = 0.0;
        } else if cur.key == key && cur.sounding() {
            cur.target = 1.0;
        } else if other.key == key && other.sounding() {
            // Back to the key that was going out.
            cur.target = 0.0;
            other.target = 1.0;
            self.pad_on ^= 1;
        } else if !cur.sounding() {
            cur.set_key(key, sr);
            cur.target = 1.0;
        } else {
            // New key: this one goes out while the other comes in.
            cur.target = 0.0;
            other.level = 0.0;
            other.set_key(key, sr);
            other.target = 1.0;
            self.pad_on ^= 1;
        }
        self.pad = p;
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
                    self.drop_tail();
                    self.reset_fade();
                    self.xin_len = 0;
                    self.locate(position);
                }
                RtCmd::Streams { mut streams, position } => {
                    for (t, s) in self.tracks.iter_mut().zip(streams.iter_mut()) {
                        std::mem::swap(&mut t.stream, s);
                        t.deficit = 0;
                    }
                    self.trash(Garbage::Streams(streams));
                    self.drop_tail();
                    self.xin_len = 0;
                    self.locate(position);
                }
                RtCmd::Fade { target, seconds } => {
                    let sr = self.shared.sample_rate.load(Ordering::Relaxed) as f32;
                    self.fade_target = target.clamp(0.0, 1.0);
                    self.fade_step = 1.0 / (seconds.max(0.01) * sr);
                    self.shared.fade_target.store(self.fade_target);
                }
                RtCmd::Pad(p) => {
                    let sr = self.shared.sample_rate.load(Ordering::Relaxed) as f32;
                    self.set_pad(p, sr);
                }
                RtCmd::Next(next) => {
                    if let Some(old) = self.next.replace(next) {
                        self.trash(Garbage::Next(old));
                    }
                }
                RtCmd::CancelNext => {
                    if let Some(old) = self.next.take() {
                        self.trash(Garbage::Next(old));
                    }
                }
                RtCmd::Tempo(t) => {
                    if let Some(old) = std::mem::replace(&mut self.tempo, t) {
                        self.trash(Garbage::Tempo(old));
                    }
                }
                RtCmd::Click(c) => self.click = c,
                RtCmd::PreviewClick(k) => self.preview = Some(k),
                RtCmd::Duration(d) => self.duration = d,
                RtCmd::Jump { id, at, to, streams } => {
                    if let Some(old) = self.jump.replace(ArmedJump { id, at, to, streams }) {
                        self.trash(Garbage::Streams(old.streams));
                    }
                }
                RtCmd::CancelJump => {
                    if let Some(old) = self.jump.take() {
                        self.trash(Garbage::Streams(old.streams));
                    }
                }
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
                    self.drop_tail();
                    self.reset_fade();
                    self.xin_len = 0;
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

    fn fire_jump(&mut self, sr: usize) {
        let Some(mut jump) = self.jump.take() else { return };
        for (t, s) in self.tracks.iter_mut().zip(jump.streams.iter_mut()) {
            std::mem::swap(&mut t.stream, s);
            t.deficit = 0;
        }
        self.trash(Garbage::Streams(jump.streams));
        self.shared.position.store(jump.to, Ordering::Relaxed);
        self.shared.jump_fired.store(jump.id, Ordering::Relaxed);
        self.fade_in = jump_ramp(sr) as usize;
    }

    /// The next song takes the place of this one, which becomes the tail.
    fn fire_next(&mut self) {
        let Some(mut next) = self.next.take() else { return };
        if let Some(jump) = self.jump.take() {
            self.trash(Garbage::Streams(jump.streams));
        }
        let old_tail = std::mem::take(&mut self.tail);
        if !old_tail.is_empty() {
            self.trash(Garbage::Tail(old_tail));
        }
        // tracks ← next, tail ← the song that was playing, next.tracks ← the empty Vec.
        std::mem::swap(&mut self.tracks, &mut *next.tracks);
        std::mem::swap(&mut self.tail, &mut *next.tracks);
        for t in self.tracks.iter_mut() {
            t.deficit = 0;
        }
        self.tail_on = true;
        self.tail_x = 1.0;
        self.tail_step = if next.overlap { 0.0 } else { 1.0 / next.xfade.max(1) as f32 };
        self.xin_done = 0;
        self.xin_len = if next.overlap { 0 } else { next.xfade.max(1) };
        if let Some(tempo) = next.tempo.take() {
            if let Some(old) = self.tempo.replace(tempo) {
                self.trash(Garbage::Tempo(old));
            }
        }
        self.duration = next.duration;
        self.count_in = false;
        self.voice.left = 0;
        self.fade_in = 0;
        self.reset_fade();
        self.shared.position.store(0, Ordering::Relaxed);
        self.shared.next_fired.store(next.id, Ordering::Relaxed);
        self.trash(Garbage::Next(next));
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
        self.process_transport(out, frames, ch, sr);
        // The pad plays with the transport stopped too.
        self.mix_pad(out, frames, ch, sr);
        for c in 0..ch.min(MAX_OUTPUTS) {
            let mut peak = 0f32;
            for f in 0..frames {
                peak = peak.max(out[f * ch + c].abs());
            }
            self.shared.out_peaks[c].store_max(peak);
        }
    }

    fn process_transport(&mut self, out: &mut [f32], frames: usize, ch: usize, sr: usize) {
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
            let mut n = (frames - done).min(MAX_BLOCK);
            // Blocks end exactly on the jump and on the change of song, whatever the size of the buffer.
            if self.jump.as_ref().is_some_and(|j| j.at <= self.shared.position.load(Ordering::Relaxed)) {
                self.fire_jump(sr);
            }
            if self.next.as_ref().is_some_and(|x| x.at <= self.shared.position.load(Ordering::Relaxed)) {
                self.fire_next();
            }
            let pos = self.shared.position.load(Ordering::Relaxed);
            for at in [self.jump.as_ref().map(|j| j.at), self.next.as_ref().map(|x| x.at)].into_iter().flatten() {
                if at > pos && at < pos + n as i64 {
                    n = (at - pos) as usize;
                }
            }
            self.render_block(&mut out[done * ch..(done + n) * ch], n, ch, sr);
            done += n;
        }
        let pos = self.shared.position.load(Ordering::Relaxed);
        if self.duration > 0 && pos >= self.duration + sr as i64 / 2 && self.next.is_none() {
            self.shared.playing.store(false, Ordering::Relaxed);
            self.shared.ended.store(true, Ordering::Relaxed);
            self.drop_tail();
        }
    }

    fn render_block(&mut self, out: &mut [f32], frames: usize, ch: usize, sr: usize) {
        let pos = self.shared.position.load(Ordering::Relaxed);
        let master = self.shared.master.load();
        // Tracks start at 0: the count-in (negative positions) is click only.
        let lead = if pos < 0 { ((-pos) as usize).min(frames) } else { 0 };
        let n = frames - lead;

        // Gain of the tracks frame by frame: Tracks Fade, crossfade with the song
        // before, a few ms around a jump so that the cut doesn't click (the metronome is not faded).
        let ramp = jump_ramp(sr);
        let until = self.jump.as_ref().map(|j| j.at - pos);
        let fade_in = self.fade_in as i64;
        let around_jump = fade_in > 0 || until.is_some_and(|u| u < frames as i64 + ramp);
        let mut g = self.fade_gain;
        for f in 0..frames {
            if g < self.fade_target {
                g = (g + self.fade_step).min(self.fade_target);
            } else if g > self.fade_target {
                g = (g - self.fade_step).max(self.fade_target);
            }
            let mut k = g;
            if around_jump {
                k *= jump_envelope(f as i64, until, fade_in, ramp);
            }
            if self.xin_len > 0 {
                k *= xfade_curve((self.xin_done + f as i64) as f32 / self.xin_len as f32);
            }
            self.env[f] = k;
            if self.tail_on {
                let x = (self.tail_x - self.tail_step * f as f32).max(0.0);
                self.tail_env[f] = g * xfade_curve(x);
            }
        }
        self.fade_gain = g;
        self.shared.fade.store(g);

        mix_tracks(&mut self.tracks, &mut self.scratch, out, lead, n, ch, &self.env, master, Some(&self.shared.underruns));
        if self.xin_len > 0 {
            self.xin_done += frames as i64;
            if self.xin_done >= self.xin_len {
                self.xin_len = 0;
            }
        }
        if self.tail_on {
            mix_tracks(&mut self.tail, &mut self.scratch, out, 0, frames, ch, &self.tail_env, master, None);
            self.tail_x = (self.tail_x - self.tail_step * frames as f32).max(0.0);
            let dry = self.tail.iter().all(|t| t.stream.as_ref().is_none_or(|s| s.eof.load(Ordering::Acquire) && s.rx.slots() == 0));
            if self.tail_x <= 0.0 || dry {
                self.drop_tail();
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

        self.fade_in = self.fade_in.saturating_sub(frames);
        self.shared.position.store(pos + frames as i64, Ordering::Relaxed);
    }

    /// Adds the pad (both keys while they cross) to its output.
    fn mix_pad(&mut self, out: &mut [f32], frames: usize, ch: usize, sr: usize) {
        if !self.pads.iter().any(PadVoice::sounding) {
            return;
        }
        let p = self.pad;
        let gain = p.gain * self.shared.master.load();
        let mut start = p.out_start as usize;
        let stereo = !p.mono && ch >= 2;
        if (stereo && start + 1 >= ch) || start >= ch {
            start = 0;
        }
        let up = 1.0 / (PAD_ATTACK * sr as f32);
        let down = 1.0 / (PAD_RELEASE * sr as f32);
        for i in 0..frames {
            let (mut l, mut r) = (0f32, 0f32);
            for v in self.pads.iter_mut() {
                if v.sounding() {
                    let (a, b) = v.next(up, down);
                    l += a;
                    r += b;
                }
            }
            let o = i * ch + start;
            if stereo {
                out[o] += l * gain;
                out[o + 1] += r * gain;
            } else {
                out[o] += (l + r) * 0.5 * gain;
            }
        }
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
