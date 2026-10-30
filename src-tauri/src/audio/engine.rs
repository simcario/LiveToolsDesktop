//! Engine controller: loads songs, drives the transport and the mix. Runs on
//! the command threads; talks to the audio callback only through the queue
//! and atomics.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use rtrb::{Producer, RingBuffer};
use serde::{Deserialize, Serialize};

use super::decode::{self, ProbeInfo};
use super::device::{AudioHost, DeviceEntry, DeviceInfo};
use super::render::{ClickParams, Garbage, Renderer, RtCmd, RtTrack, Shared, TrackControl, OUT_MONO, OUT_OFF, OUT_STEREO};
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
}

impl SongSpec {
    fn tempo(&self) -> TempoMap {
        TempoMap::from_sync(self.sync.as_ref(), self.bpm, self.time_sig.as_deref(), self.count_in_bars, &self.sections)
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
    pub device: RwLock<Option<DeviceInfo>>,
    pub device_error: Arc<Mutex<Option<String>>>,
}

impl Monitor {
    pub fn status(&self) -> Status {
        let s = &self.shared;
        let sr = s.sample_rate.load(Ordering::Relaxed).max(1) as f64;
        let position = s.position.load(Ordering::Relaxed) as f64 / sr;
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
    regions: Vec<Vec<Region>>,
    /// Length of each file (seconds), for the timeline end of its regions.
    files: Vec<Option<f64>>,
    decoders: Vec<Option<DecoderHandle>>,
    tempo: TempoMap,
    duration: f64,
}

pub struct Controller {
    host: AudioHost,
    monitor: Arc<Monitor>,
    garbage: SyncSender<Garbage>,
    cmd: Option<Producer<RtCmd>>,
    song: Option<Loaded>,
    click: ClickParams,
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
        // Streams are resampled for the interface: reload the song at the same point.
        if let Some(spec) = self.song.as_ref().map(|s| s.spec.clone()) {
            self.load(spec)?;
            self.locate(position.max(0.0));
        }
        Ok(info)
    }

    pub fn position(&self) -> f64 {
        self.shared().position.load(Ordering::Relaxed) as f64 / self.sample_rate().max(1) as f64
    }

    pub fn load(&mut self, spec: SongSpec) -> Result<SongLoad, String> {
        self.shared().playing.store(false, Ordering::Relaxed);
        let sr = self.sample_rate();
        let tempo = spec.tempo();

        let mut loads = Vec::new();
        let mut controls = Vec::new();
        let mut rt = Vec::new();
        let mut decoders = Vec::new();
        let mut paths = Vec::new();
        let mut files = Vec::new();
        let mut duration = 0f64;
        for t in &spec.tracks {
            let control = Arc::new(TrackControl::new());
            apply_mix(&control, &t.mix);
            let path = PathBuf::from(&t.path);
            let (info, error) = match decode::probe(&path) {
                Ok(i) => (Some(i), None),
                Err(e) => (None, Some(e)),
            };
            let (decoder, stream) = if info.is_some() {
                let (d, s) = stream::spawn(path.clone(), 0.0, sr, t.regions.clone());
                (Some(d), Some(s))
            } else {
                (None, None)
            };
            let file = info.as_ref().and_then(|i| i.duration);
            if let Some(d) = stream::timeline_end(&t.regions, file) {
                duration = duration.max(d);
            }
            paths.push(info.as_ref().map(|_| path));
            files.push(file);
            loads.push(TrackLoad { id: t.id.clone(), info, error });
            rt.push(RtTrack::new(control.clone(), stream));
            controls.push(control);
            decoders.push(decoder);
        }

        *self.monitor.controls.write() = controls;
        *self.monitor.tempo.write() = Some(tempo.clone());
        *self.monitor.song.write() = Some((spec.id.clone(), duration));
        self.send(RtCmd::Tracks { tracks: Box::new(rt), position: 0 });
        self.send(RtCmd::Tempo(Some(Box::new(tempo.frames(sr)))));
        self.send(RtCmd::Duration((duration * sr as f64) as i64));

        let result = SongLoad { id: spec.id.clone(), duration, tempo: tempo.clone(), tracks: loads };
        // Old readers stop when their handles drop.
        self.song = Some(Loaded {
            ids: spec.tracks.iter().map(|t| t.id.clone()).collect(),
            regions: spec.tracks.iter().map(|t| t.regions.clone()).collect(),
            files,
            spec,
            paths,
            decoders,
            tempo,
            duration,
        });
        Ok(result)
    }

    pub fn unload(&mut self) {
        self.shared().playing.store(false, Ordering::Relaxed);
        self.send(RtCmd::Tracks { tracks: Box::new(Vec::new()), position: 0 });
        self.send(RtCmd::Tempo(None));
        self.send(RtCmd::Duration(0));
        self.monitor.controls.write().clear();
        *self.monitor.tempo.write() = None;
        *self.monitor.song.write() = None;
        self.song = None;
    }

    /// Moves the playhead; negative positions are inside the count-in.
    pub fn locate(&mut self, seconds: f64) {
        let sr = self.sample_rate();
        let Some(song) = self.song.as_mut() else { return };
        let seconds = seconds.max(-song.tempo.pre_roll).min(song.duration.max(0.0));
        let from = seconds.max(0.0);
        let mut streams: Vec<Option<TrackStream>> = Vec::with_capacity(song.paths.len());
        let mut decoders = Vec::with_capacity(song.paths.len());
        for (p, regions) in song.paths.iter().zip(&song.regions) {
            match p {
                Some(path) => {
                    let (d, s) = stream::spawn(path.clone(), from, sr, regions.clone());
                    decoders.push(Some(d));
                    streams.push(Some(s));
                }
                None => {
                    decoders.push(None);
                    streams.push(None);
                }
            }
        }
        song.decoders = decoders;
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
                    self.locate(-pre);
                }
            }
        }
        self.send(RtCmd::Play { count_in: with_count_in });
    }

    /// New alignment of the grid with the audio, without reloading the tracks.
    /// New placement of some tracks (id â†’ regions), heard from where the
    /// playhead is; returns the new length of the song.
    pub fn set_regions(&mut self, regions: std::collections::HashMap<String, Vec<Region>>) -> Option<f64> {
        let sr = self.sample_rate();
        let position = self.position();
        let song = self.song.as_mut()?;
        for (i, id) in song.ids.iter().enumerate() {
            if let Some(r) = regions.get(id) {
                song.regions[i] = r.clone();
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

    /// Length of the song from its tracks, sent to the audio thread.
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
        *self.monitor.song.write() = Some((id, duration));
        self.send(RtCmd::Duration((duration * sr as f64) as i64));
        Some(duration)
    }

    pub fn set_sync(&mut self, sync: Option<SyncSpec>) -> Option<TempoMap> {
        let sr = self.sample_rate();
        let song = self.song.as_mut()?;
        song.spec.sync = sync;
        let tempo = song.spec.tempo();
        song.tempo = tempo.clone();
        *self.monitor.tempo.write() = Some(tempo.clone());
        self.send(RtCmd::Tempo(Some(Box::new(tempo.frames(sr)))));
        Some(tempo)
    }

    /// Ableton style: stop, and stop again to go back to the start.
    pub fn stop(&mut self) {
        if self.shared().playing.load(Ordering::Relaxed) {
            self.send(RtCmd::Stop);
            self.shared().playing.store(false, Ordering::Relaxed);
        } else {
            self.locate(0.0);
        }
    }

    pub fn set_track(&mut self, id: &str, mix: TrackMix) {
        let Some(song) = &self.song else { return };
        if let Some(i) = song.ids.iter().position(|x| x == id) {
            if let Some(c) = self.monitor.controls.read().get(i) {
                apply_mix(c, &mix);
            }
        }
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
