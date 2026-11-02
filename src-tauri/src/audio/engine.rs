//! Engine controller: loads songs, drives the transport and the mix. Runs on
//! the command threads; talks to the audio callback only through the queue
//! and atomics.
//!
//! A song with its tempo changed plays files rendered at the new speed
//! (stretch.rs): inside, times are those of the files; to the UI every time
//! (position, duration, jumps, regions) stays that of the original song.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use rtrb::{Producer, RingBuffer};
use serde::{Deserialize, Serialize};

use super::decode::{self, ProbeInfo};
use super::device::{AudioHost, DeviceEntry, DeviceInfo};
use super::render::{ClickParams, Garbage, NextSong, PadParams, Renderer, RtCmd, RtTrack, Shared, TrackControl, OUT_MONO, OUT_OFF, OUT_STEREO};
use super::stream::{self, DecoderHandle, Region, TrackStream};
use super::tempo::{ClickKind, SectionSpec, SyncSpec, TempoMap};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSpec {
    pub id: String,
    pub path: String,
    /// Placement on the timeline (moved clips, inserted bars); empty = from 0.
    #[serde(default)]
    pub regions: Vec<Region>,
    #[serde(flatten)]
    pub mix: TrackMix,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMix {
    pub gain_db: Option<f32>,
    pub pan: Option<f32>,
    pub mute: Option<bool>,
    pub solo: Option<bool>,
    pub out_start: Option<u32>,
    /// "stereo" | "mono" | "off"
    pub out_mode: Option<String>,
}

fn one() -> f64 {
    1.0
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongSpec {
    pub id: String,
    pub tracks: Vec<TrackSpec>,
    pub bpm: Option<f64>,
    pub time_sig: Option<String>,
    #[serde(default)]
    pub count_in_bars: u32,
    #[serde(default)]
    pub sections: Vec<SectionSpec>,
    /// Grid lined up with a click or rhythm stem (None: song data from 0).
    #[serde(default)]
    pub sync: Option<SyncSpec>,
    /// Speed of the files of the tracks: new tempo / original tempo (they are
    /// already rendered at it). Bpm, sections, sync and regions stay the original ones.
    #[serde(default = "one")]
    pub rate: f64,
}

impl SongSpec {
    fn tempo(&self) -> TempoMap {
        TempoMap::from_sync(self.sync.as_ref(), self.bpm, self.time_sig.as_deref(), self.count_in_bars, &self.sections)
    }

    fn rate(&self) -> f64 {
        if self.rate.is_finite() {
            self.rate.clamp(0.5, 2.0)
        } else {
            1.0
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackLoad {
    pub id: String,
    pub info: Option<ProbeInfo>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongLoad {
    pub id: String,
    pub duration: f64,
    pub tempo: TempoMap,
    pub tracks: Vec<TrackLoad>,
}

/// A move of the playhead planned ahead: at `at` seconds it goes to `to`.
/// With `repeat` it is a loop, armed again each time.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpSpec {
    pub at: f64,
    pub to: f64,
    #[serde(default)]
    pub repeat: bool,
}

/// How the next song takes over, at `at` seconds of the one playing:
/// "overlap" (this one goes on to its end, also AutoLink with `at` = the end)
/// or "crossfade" in `fade` seconds.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionSpec {
    pub mode: String,
    pub at: f64,
    #[serde(default)]
    pub fade: f64,
}

/// The next song waiting in the engine.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NextInfo {
    pub song_id: String,
    pub mode: String,
    pub at: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub playing: bool,
    pub waiting: bool,
    /// Seconds (negative during the count-in).
    pub position: f64,
    pub duration: f64,
    pub song_id: Option<String>,
    pub bar: i64,
    pub beat: u32,
    pub beats: u32,
    pub ended: bool,
    pub underruns: u32,
    /// The jump or loop waiting to happen.
    pub jump: Option<JumpSpec>,
    /// The next song waiting to take over.
    pub next: Option<NextInfo>,
    /// Tracks Fade: gain now (0..1) and where it is going.
    pub fade: f32,
    pub fade_target: f32,
    /// Speed of the song loaded (1 = its own tempo).
    pub rate: f64,
    /// [left, right] peak of each track since the last status.
    pub meters: Vec<[f32; 2]>,
    /// Peak of each output of the interface.
    pub outputs: Vec<f32>,
    pub device: Option<DeviceInfo>,
    pub device_error: Option<String>,
}

/// What the status ticker needs, readable without the controller lock.
pub struct Monitor {
    pub shared: Arc<Shared>,
    pub controls: RwLock<Vec<Arc<TrackControl>>>,
    pub tempo: RwLock<Option<TempoMap>>,
    pub song: RwLock<Option<(String, f64)>>,
    pub rate: RwLock<f64>,
    pub jump: RwLock<Option<JumpSpec>>,
    pub next: RwLock<Option<NextInfo>>,
    pub device: RwLock<Option<DeviceInfo>>,
    pub device_error: Arc<Mutex<Option<String>>>,
}

impl Monitor {
    /// Seconds of the song now, without taking the meters (NDI video).
    pub fn position(&self) -> f64 {
        let s = &self.shared;
        let sr = s.sample_rate.load(Ordering::Relaxed).max(1) as f64;
        s.position.load(Ordering::Relaxed) as f64 / sr * *self.rate.read()
    }

    pub fn status(&self) -> Status {
        let s = &self.shared;
        let sr = s.sample_rate.load(Ordering::Relaxed).max(1) as f64;
        let rate = *self.rate.read();
        let position = s.position.load(Ordering::Relaxed) as f64 / sr * rate;
        let (bar, beat, beats) = self.tempo.read().as_ref().map_or((1, 1, 4), |t| t.position(position));
        let channels = s.channels.load(Ordering::Relaxed) as usize;
        let song = self.song.read().clone();
        Status {
            playing: s.playing.load(Ordering::Relaxed),
            waiting: s.waiting.load(Ordering::Relaxed),
            position,
            duration: song.as_ref().map_or(0.0, |x| x.1),
            song_id: song.map(|x| x.0),
            bar,
            beat,
            beats,
            ended: s.ended.swap(false, Ordering::Relaxed),
            underruns: s.underruns.load(Ordering::Relaxed),
            jump: *self.jump.read(),
            next: self.next.read().clone(),
            fade: s.fade.load(),
            fade_target: s.fade_target.load(),
            rate,
            meters: self.controls.read().iter().map(|c| [c.peak_l.swap(0.0), c.peak_r.swap(0.0)]).collect(),
            outputs: s.out_peaks.iter().take(channels).map(|p| p.swap(0.0)).collect(),
            device: self.device.read().clone(),
            device_error: self.device_error.lock().clone(),
        }
    }
}

struct Loaded {
    spec: SongSpec,
    ids: Vec<String>,
    paths: Vec<Option<PathBuf>>,
    /// Placement of each track in the times of the files (see `rate`).
    regions: Vec<Vec<Region>>,
    /// Length of each file (seconds), for the timeline end of its regions.
    files: Vec<Option<f64>>,
    decoders: Vec<Option<DecoderHandle>>,
    controls: Vec<Arc<TrackControl>>,
    tempo: TempoMap,
    /// In the times of the files.
    duration: f64,
    rate: f64,
}

impl Loaded {
    /// Seconds of the original song → seconds of the files.
    fn real(&self, t: f64) -> f64 {
        t / self.rate
    }

    /// Length of the original song.
    fn song_duration(&self) -> f64 {
        self.duration * self.rate
    }
}

/// The jump in the audio thread, with the readers already filling its streams.
struct Armed {
    id: u64,
    spec: JumpSpec,
    decoders: Vec<Option<DecoderHandle>>,
}

/// The next song in the audio thread, its readers already at its start.
struct Pending {
    id: u64,
    song: Loaded,
}

/// Regions of the original song in the times of files played at `rate`.
fn scale_regions(regions: &[Region], rate: f64) -> Vec<Region> {
    regions
        .iter()
        .map(|r| Region { at: r.at / rate, from: r.from / rate, len: r.len.map(|l| l / rate), muted: r.muted })
        .collect()
}

/// One reader per track, from `from` seconds of the files.
fn spawn_readers(song: &Loaded, from: f64, sr: u32) -> (Vec<Option<DecoderHandle>>, Vec<Option<TrackStream>>) {
    song.paths
        .iter()
        .zip(&song.regions)
        .map(|(p, regions)| match p {
            Some(path) => {
                let (d, s) = stream::spawn(path.clone(), from, sr, regions.clone());
                (Some(d), Some(s))
            }
            None => (None, None),
        })
        .unzip()
}

pub struct Controller {
    host: AudioHost,
    monitor: Arc<Monitor>,
    garbage: SyncSender<Garbage>,
    cmd: Option<Producer<RtCmd>>,
    song: Option<Loaded>,
    click: ClickParams,
    pad: PadParams,
    armed: Option<Armed>,
    jump_seq: u64,
    next: Option<Pending>,
    /// Readers of the song before, still heard in the crossfade or overlap.
    tail: Vec<Option<DecoderHandle>>,
}

pub struct Engine(pub Mutex<Controller>);

fn db_to_gain(db: f32) -> f32 {
    if db <= -60.0 {
        0.0
    } else {
        10f32.powf(db / 20.0)
    }
}

fn apply_mix(c: &TrackControl, m: &TrackMix) {
    if let Some(db) = m.gain_db {
        c.gain.store(db_to_gain(db));
    }
    if let Some(p) = m.pan {
        c.pan.store(p);
    }
    if let Some(v) = m.mute {
        c.mute.store(v, Ordering::Relaxed);
    }
    if let Some(v) = m.solo {
        c.solo.store(v, Ordering::Relaxed);
    }
    if let Some(v) = m.out_start {
        c.out_start.store(v, Ordering::Relaxed);
    }
    if let Some(mode) = &m.out_mode {
        let v = match mode.as_str() {
            "mono" => OUT_MONO,
            "off" => OUT_OFF,
            _ => OUT_STEREO,
        };
        c.out_mode.store(v, Ordering::Relaxed);
    }
}

impl Engine {
    /// The receiver collects what the audio thread replaces; drain it periodically.
    pub fn new() -> (Self, Arc<Monitor>, Receiver<Garbage>) {
        let shared = Arc::new(Shared::new());
        let device_error = Arc::new(Mutex::new(None));
        let monitor = Arc::new(Monitor {
            shared: shared.clone(),
            controls: RwLock::new(Vec::new()),
            tempo: RwLock::new(None),
            song: RwLock::new(None),
            rate: RwLock::new(1.0),
            jump: RwLock::new(None),
            next: RwLock::new(None),
            device: RwLock::new(None),
            device_error: device_error.clone(),
        });
        let (garbage, garbage_rx) = sync_channel(256);
        let controller = Controller {
            host: AudioHost::start(shared, device_error),
            monitor: monitor.clone(),
            garbage,
            cmd: None,
            song: None,
            click: ClickParams::default(),
            pad: PadParams::default(),
            armed: None,
            jump_seq: 0,
            next: None,
            tail: Vec::new(),
        };
        (Self(Mutex::new(controller)), monitor, garbage_rx)
    }
}

impl Controller {
    fn shared(&self) -> &Shared {
        &self.monitor.shared
    }

    fn sample_rate(&self) -> u32 {
        self.shared().sample_rate.load(Ordering::Relaxed)
    }

    fn send(&mut self, cmd: RtCmd) {
        let Some(tx) = self.cmd.as_mut() else { return };
        let mut cmd = cmd;
        // The callback drains the queue every few ms: wait briefly if it is full.
        for _ in 0..200 {
            match tx.push(cmd) {
                Ok(()) => return,
                Err(rtrb::PushError::Full(c)) => {
                    cmd = c;
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
            }
        }
    }

    pub fn devices(&self) -> Vec<DeviceEntry> {
        self.host.list()
    }

    pub fn open_device(&mut self, name: Option<String>, buffer: Option<u32>) -> Result<DeviceInfo, String> {
        let position = self.position();
        self.shared().playing.store(false, Ordering::Relaxed);
        self.host.close();
        self.cmd = None;
        let attempt = |buffer: Option<u32>| {
            let (tx, rx) = RingBuffer::<RtCmd>::new(256);
            let renderer = Renderer::new(rx, self.garbage.clone(), self.monitor.shared.clone());
            self.host.open(name.clone(), buffer, renderer).map(|info| (info, tx))
        };
        // Some drivers refuse a size inside their range (ASIO has a granularity):
        // better the interface's own buffer than no audio.
        let opened = attempt(buffer).or_else(|e| if buffer.is_some() { attempt(None) } else { Err(e) });
        *self.monitor.device.write() = opened.as_ref().ok().map(|(info, _)| info.clone());
        let (info, tx) = opened?;
        self.cmd = Some(tx);
        self.send(RtCmd::Click(self.click));
        self.send(RtCmd::Pad(self.pad));
        // Streams are resampled for the interface: reload the song at the same point.
        if let Some(spec) = self.song.as_ref().map(|s| s.spec.clone()) {
            self.load(spec)?;
            self.locate(position.max(0.0));
        }
        Ok(info)
    }

    /// Seconds of the original song.
    pub fn position(&self) -> f64 {
        let rate = self.song.as_ref().map_or(1.0, |s| s.rate);
        self.shared().position.load(Ordering::Relaxed) as f64 / self.sample_rate().max(1) as f64 * rate
    }

    /// Opens the tracks of a song, each reader at its start.
    fn open_song(&self, spec: SongSpec) -> (Loaded, Vec<RtTrack>, SongLoad) {
        let sr = self.sample_rate();
        let tempo = spec.tempo();
        let rate = spec.rate();
        let mut loads = Vec::new();
        let mut controls = Vec::new();
        let mut rt = Vec::new();
        let mut decoders = Vec::new();
        let mut paths = Vec::new();
        let mut files = Vec::new();
        let mut regions = Vec::new();
        let mut duration = 0f64;
        for t in &spec.tracks {
            let control = Arc::new(TrackControl::new());
            apply_mix(&control, &t.mix);
            let path = PathBuf::from(&t.path);
            let (info, error) = match decode::probe(&path) {
                Ok(i) => (Some(i), None),
                Err(e) => (None, Some(e)),
            };
            let placed = scale_regions(&t.regions, rate);
            let (decoder, stream) = if info.is_some() {
                let (d, s) = stream::spawn(path.clone(), 0.0, sr, placed.clone());
                (Some(d), Some(s))
            } else {
                (None, None)
            };
            let file = info.as_ref().and_then(|i| i.duration);
            if let Some(d) = stream::timeline_end(&placed, file) {
                duration = duration.max(d);
            }
            paths.push(info.as_ref().map(|_| path));
            files.push(file);
            regions.push(placed);
            loads.push(TrackLoad { id: t.id.clone(), info, error });
            rt.push(RtTrack::new(control.clone(), stream));
            controls.push(control);
            decoders.push(decoder);
        }
        let result = SongLoad { id: spec.id.clone(), duration: duration * rate, tempo: tempo.clone(), tracks: loads };
        let song = Loaded {
            ids: spec.tracks.iter().map(|t| t.id.clone()).collect(),
            regions,
            files,
            spec,
            paths,
            decoders,
            controls,
            tempo,
            duration,
            rate,
        };
        (song, rt, result)
    }

    /// The song for the monitor: tracks, grid, length and speed.
    fn publish(&self, song: &Loaded) {
        *self.monitor.controls.write() = song.controls.clone();
        *self.monitor.tempo.write() = Some(song.tempo.clone());
        *self.monitor.song.write() = Some((song.spec.id.clone(), song.song_duration()));
        *self.monitor.rate.write() = song.rate;
    }

    /// Frames per second of the original song for the audio thread.
    fn fps(&self, rate: f64) -> f64 {
        self.sample_rate() as f64 / rate
    }

    pub fn load(&mut self, spec: SongSpec) -> Result<SongLoad, String> {
        self.shared().playing.store(false, Ordering::Relaxed);
        self.cancel_jump();
        self.cancel_next();
        self.tail.clear();
        let sr = self.sample_rate();
        let (song, rt, result) = self.open_song(spec);
        self.publish(&song);
        self.send(RtCmd::Tracks { tracks: Box::new(rt), position: 0 });
        self.send(RtCmd::Tempo(Some(Box::new(song.tempo.frames_per(self.fps(song.rate))))));
        self.send(RtCmd::Duration((song.duration * sr as f64) as i64));
        // Old readers stop when their handles drop.
        self.song = Some(song);
        Ok(result)
    }

    pub fn unload(&mut self) {
        self.shared().playing.store(false, Ordering::Relaxed);
        self.cancel_jump();
        self.cancel_next();
        self.tail.clear();
        self.send(RtCmd::Tracks { tracks: Box::new(Vec::new()), position: 0 });
        self.send(RtCmd::Tempo(None));
        self.send(RtCmd::Duration(0));
        self.monitor.controls.write().clear();
        *self.monitor.tempo.write() = None;
        *self.monitor.song.write() = None;
        *self.monitor.rate.write() = 1.0;
        self.song = None;
    }

    /// Prepares the next song: at `t.at` seconds of this one it takes over,
    /// from its start, without waiting for the disk. In place of the one waiting.
    pub fn queue_next(&mut self, spec: SongSpec, t: TransitionSpec) -> Result<SongLoad, String> {
        self.cancel_next();
        let Some(cur) = self.song.as_ref() else { return Err("Nessun brano caricato".into()) };
        let sr = self.sample_rate() as f64;
        let end = cur.song_duration();
        let at = t.at.clamp(0.0, end);
        let at_frame = (cur.real(at) * sr).floor() as i64;
        let overlap = t.mode != "crossfade";
        let xfade = (t.fade.clamp(0.0, 30.0) / cur.rate * sr) as i64;
        let (song, rt, result) = self.open_song(spec);
        let tempo = song.tempo.frames_per(self.fps(song.rate));
        self.jump_seq += 1;
        let id = self.jump_seq;
        *self.monitor.next.write() = Some(NextInfo { song_id: song.spec.id.clone(), mode: t.mode.clone(), at });
        self.send(RtCmd::Next(Box::new(NextSong {
            id,
            at: at_frame,
            tracks: Box::new(rt),
            tempo: Some(Box::new(tempo)),
            duration: (song.duration * sr) as i64,
            overlap,
            xfade,
        })));
        self.next = Some(Pending { id, song });
        Ok(result)
    }

    pub fn cancel_next(&mut self) {
        if let Some(old) = self.next.take() {
            // The callback may be taking it right now: its readers must not be stopped.
            old.song.decoders.into_iter().flatten().for_each(DecoderHandle::detach);
            self.send(RtCmd::CancelNext);
        }
        *self.monitor.next.write() = None;
    }

    /// The audio thread changed song (`id`): the next one is the song loaded now,
    /// the readers of the one before stay until its tail ends.
    pub fn next_fired(&mut self, id: u64) {
        if self.next.as_ref().is_none_or(|n| n.id != id) {
            return;
        }
        let Some(next) = self.next.take() else { return };
        if let Some(armed) = self.armed.take() {
            armed.decoders.into_iter().flatten().for_each(DecoderHandle::detach);
        }
        *self.monitor.jump.write() = None;
        *self.monitor.next.write() = None;
        self.publish(&next.song);
        if let Some(old) = self.song.replace(next.song) {
            self.tail = old.decoders;
        }
    }

    /// Moves the playhead and drops the jump or loop that was waiting.
    pub fn locate(&mut self, seconds: f64) {
        self.cancel_jump();
        self.seek(seconds);
    }

    /// Plans a move of the playhead, in place of the one that was waiting.
    pub fn schedule_jump(&mut self, spec: JumpSpec) {
        if let Some(old) = self.armed.take() {
            old.decoders.into_iter().flatten().for_each(DecoderHandle::detach);
        }
        self.arm(spec);
    }

    fn arm(&mut self, spec: JumpSpec) {
        let sr = self.sample_rate();
        let Some(song) = self.song.as_ref() else {
            *self.monitor.jump.write() = None;
            return;
        };
        let rate = sr as f64;
        let end = song.song_duration().max(0.0);
        // Rounded down: a beat computed on a frame must not fall before the playhead (see clicks_in).
        let at = (song.real(spec.at.clamp(0.0, end)) * rate).floor() as i64;
        let to = (song.real(spec.to.clamp(0.0, end)) * rate).floor() as i64;
        let (decoders, streams) = spawn_readers(song, to as f64 / rate, sr);
        self.jump_seq += 1;
        let id = self.jump_seq;
        self.armed = Some(Armed { id, spec, decoders });
        *self.monitor.jump.write() = Some(spec);
        self.send(RtCmd::Jump { id, at, to, streams: Box::new(streams) });
    }

    pub fn cancel_jump(&mut self) {
        if let Some(old) = self.armed.take() {
            // The callback may be firing it right now: its readers must not be stopped.
            old.decoders.into_iter().flatten().for_each(DecoderHandle::detach);
            self.send(RtCmd::CancelJump);
        }
        *self.monitor.jump.write() = None;
    }

    /// The audio thread made jump `id`: its readers are the current ones; a loop is armed again.
    pub fn jump_fired(&mut self, id: u64) {
        if self.armed.as_ref().is_none_or(|a| a.id != id) {
            return;
        }
        let Some(armed) = self.armed.take() else { return };
        if let Some(song) = self.song.as_mut() {
            song.decoders = armed.decoders;
        }
        if armed.spec.repeat {
            self.arm(armed.spec);
        } else {
            *self.monitor.jump.write() = None;
        }
    }

    /// Moves the playhead (original seconds); negative positions are inside the count-in.
    fn seek(&mut self, seconds: f64) {
        let sr = self.sample_rate();
        let Some(song) = self.song.as_ref() else { return };
        let seconds = song.real(seconds.max(-song.tempo.pre_roll).min(song.song_duration().max(0.0)));
        let from = seconds.max(0.0);
        let (decoders, streams) = spawn_readers(song, from, sr);
        if let Some(song) = self.song.as_mut() {
            song.decoders = decoders;
        }
        self.tail.clear();
        let position = (seconds * sr as f64).round() as i64;
        self.send(RtCmd::Streams { streams: Box::new(streams), position });
    }

    /// From the start of the song the count-in plays first (if requested).
    pub fn play(&mut self, count_in: bool) {
        if self.shared().playing.load(Ordering::Relaxed) {
            return;
        }
        let mut with_count_in = false;
        if let Some(song) = &self.song {
            let at_start = self.position().abs() < 0.01;
            if count_in && at_start && song.tempo.count_in > 0.0 {
                with_count_in = true;
                // The count-in ends on bar 1: start early only if the audio
                // doesn't leave room for it.
                let pre = song.tempo.pre_roll;
                if pre > 0.0 {
                    self.seek(-pre);
                }
            }
        }
        self.send(RtCmd::Play { count_in: with_count_in });
    }

    /// New placement of some tracks (id → regions), heard from where the
    /// playhead is; returns the new length of the song.
    pub fn set_regions(&mut self, regions: std::collections::HashMap<String, Vec<Region>>) -> Option<f64> {
        let sr = self.sample_rate();
        let position = self.position();
        let song = self.song.as_mut()?;
        for (i, id) in song.ids.iter().enumerate() {
            if let Some(r) = regions.get(id) {
                song.regions[i] = scale_regions(r, song.rate);
                song.spec.tracks[i].regions = r.clone();
            }
        }
        let duration = self.refresh_duration(sr)?;
        self.locate(position);
        Some(duration)
    }

    /// Another file for one loaded track (the live cue track remade after an
    /// edit of the cues), with its new id; mix kept, heard from where the
    /// playhead is.
    pub fn replace_track(&mut self, id: &str, new_id: String, path: String) -> Result<TrackLoad, String> {
        let sr = self.sample_rate();
        let position = self.position();
        let song = self.song.as_mut().ok_or("Nessun brano caricato")?;
        let i = song.ids.iter().position(|x| x == id).ok_or_else(|| format!("Traccia {id} non caricata"))?;
        let path_buf = PathBuf::from(&path);
        let info = decode::probe(&path_buf)?;
        song.files[i] = info.duration;
        song.paths[i] = Some(path_buf);
        song.ids[i] = new_id.clone();
        song.spec.tracks[i].id = new_id.clone();
        song.spec.tracks[i].path = path;
        self.refresh_duration(sr);
        self.locate(position);
        Ok(TrackLoad { id: new_id, info: Some(info), error: None })
    }

    /// Length of the song from its tracks, sent to the audio thread; returns the original length.
    fn refresh_duration(&mut self, sr: u32) -> Option<f64> {
        let song = self.song.as_mut()?;
        let duration = song
            .regions
            .iter()
            .zip(&song.files)
            .zip(&song.paths)
            .filter(|(_, p)| p.is_some())
            .filter_map(|((r, f), _)| stream::timeline_end(r, *f))
            .fold(0f64, f64::max);
        song.duration = duration;
        let id = song.spec.id.clone();
        let original = song.song_duration();
        *self.monitor.song.write() = Some((id, original));
        self.send(RtCmd::Duration((duration * sr as f64) as i64));
        Some(original)
    }

    fn send_tempo(&mut self) -> Option<TempoMap> {
        let song = self.song.as_mut()?;
        let tempo = song.spec.tempo();
        song.tempo = tempo.clone();
        let rate = song.rate;
        *self.monitor.tempo.write() = Some(tempo.clone());
        let frames = tempo.frames_per(self.fps(rate));
        self.send(RtCmd::Tempo(Some(Box::new(frames))));
        Some(tempo)
    }

    /// New alignment of the grid with the audio, without reloading the tracks.
    pub fn set_sync(&mut self, sync: Option<SyncSpec>) -> Option<TempoMap> {
        self.song.as_mut()?.spec.sync = sync;
        self.send_tempo()
    }

    /// New sections of the song, heard at once: only the tempo map changes, not the tracks.
    pub fn set_sections(&mut self, sections: Vec<SectionSpec>) -> Option<TempoMap> {
        self.song.as_mut()?.spec.sections = sections;
        self.send_tempo()
    }

    /// Ableton style: stop, and stop again to go back to the start.
    pub fn stop(&mut self) {
        if self.shared().playing.load(Ordering::Relaxed) {
            self.cancel_jump();
            self.send(RtCmd::Stop);
            self.shared().playing.store(false, Ordering::Relaxed);
            self.tail.clear();
        } else {
            self.locate(0.0);
        }
    }

    pub fn set_track(&mut self, id: &str, mix: TrackMix) {
        let Some(song) = &self.song else { return };
        if let Some(i) = song.ids.iter().position(|x| x == id) {
            if let Some(c) = song.controls.get(i) {
                apply_mix(c, &mix);
            }
        }
    }

    /// Tracks Fade: the tracks go out (or back in) in `seconds`; click and pad stay.
    pub fn fade(&mut self, out: bool, seconds: f32) {
        self.send(RtCmd::Fade { target: if out { 0.0 } else { 1.0 }, seconds });
    }

    pub fn set_pad(&mut self, pad: PadParams) {
        self.pad = pad;
        self.send(RtCmd::Pad(pad));
    }

    pub fn set_click(&mut self, click: ClickParams) {
        self.click = click;
        self.send(RtCmd::Click(click));
    }

    /// One click with the current sound (heard only while stopped).
    pub fn preview_click(&mut self, kind: ClickKind) {
        self.send(RtCmd::PreviewClick(kind));
    }

    pub fn set_master(&mut self, gain_db: f32) {
        self.shared().master.store(db_to_gain(gain_db));
    }
}
