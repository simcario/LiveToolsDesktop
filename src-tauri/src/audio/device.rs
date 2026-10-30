//! Audio interface. cpal streams are not Send on every platform, so a
//! dedicated thread owns the open stream and receives open/close requests.

use std::sync::atomic::Ordering;
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::thread;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, FromSample, SampleFormat, SizedSample, StreamConfig, SupportedBufferSize, SupportedStreamConfig};
use parking_lot::Mutex;
use serde::Serialize;

use super::render::{Renderer, Shared, MAX_OUTPUTS};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub name: String,
    pub channels: u32,
    pub sample_rate: u32,
    pub buffer_size: Option<u32>,
    pub host: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEntry {
    pub name: String,
    pub channels: u32,
    pub is_default: bool,
}

enum HostCmd {
    Open {
        name: Option<String>,
        buffer: Option<u32>,
        renderer: Box<Renderer>,
        reply: Sender<Result<DeviceInfo, String>>,
    },
    Close {
        reply: Sender<()>,
    },
}

pub struct AudioHost {
    tx: Sender<HostCmd>,
}

impl AudioHost {
    pub fn start(shared: Arc<Shared>, error: Arc<Mutex<Option<String>>>) -> Self {
        let (tx, rx) = channel::<HostCmd>();
        thread::Builder::new()
            .name("livetools-audio-host".into())
            .spawn(move || {
                let mut current: Option<cpal::Stream> = None;
                for cmd in rx {
                    match cmd {
                        HostCmd::Open { name, buffer, renderer, reply } => {
                            current = None;
                            *error.lock() = None;
                            let res = open(name, buffer, *renderer, &shared, &error).map(|(s, info)| {
                                current = Some(s);
                                info
                            });
                            let _ = reply.send(res);
                        }
                        HostCmd::Close { reply } => {
                            current = None;
                            let _ = reply.send(());
                        }
                    }
                }
                drop(current);
            })
            .expect("thread audio");
        Self { tx }
    }

    pub fn open(&self, name: Option<String>, buffer: Option<u32>, renderer: Renderer) -> Result<DeviceInfo, String> {
        let (reply, rx) = channel();
        self.tx
            .send(HostCmd::Open { name, buffer, renderer: Box::new(renderer), reply })
            .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())?
    }

    pub fn close(&self) {
        let (reply, rx) = channel();
        if self.tx.send(HostCmd::Close { reply }).is_ok() {
            let _ = rx.recv();
        }
    }
}

fn supported(f: SampleFormat) -> bool {
    matches!(f, SampleFormat::F32 | SampleFormat::I16 | SampleFormat::I32 | SampleFormat::U16)
}

fn max_channels(device: &cpal::Device) -> u32 {
    device
        .supported_output_configs()
        .map(|it| it.map(|c| c.channels() as u32).max().unwrap_or(2))
        .unwrap_or(2)
}

pub fn list() -> Vec<DeviceEntry> {
    let host = cpal::default_host();
    let default = host.default_output_device().and_then(|d| d.name().ok());
    host.output_devices()
        .map(|devices| {
            devices
                .filter_map(|d| {
                    let name = d.name().ok()?;
                    Some(DeviceEntry { channels: max_channels(&d), is_default: Some(&name) == default.as_ref(), name })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The configuration with the most output channels at the interface's own
/// sample rate: multichannel interfaces expose every output (click, cues…).
fn best_config(device: &cpal::Device) -> Result<SupportedStreamConfig, String> {
    let default = device.default_output_config().map_err(|e| e.to_string())?;
    let sr = default.sample_rate();
    let mut best: Option<SupportedStreamConfig> = None;
    if let Ok(ranges) = device.supported_output_configs() {
        for range in ranges {
            if range.min_sample_rate() > sr || range.max_sample_rate() < sr || !supported(range.sample_format()) {
                continue;
            }
            let c = range.with_sample_rate(sr);
            let better = match &best {
                None => true,
                Some(b) => {
                    c.channels() > b.channels()
                        || (c.channels() == b.channels()
                            && c.sample_format() == SampleFormat::F32
                            && b.sample_format() != SampleFormat::F32)
                }
            };
            if better {
                best = Some(c);
            }
        }
    }
    Ok(best.unwrap_or(default))
}

fn open(
    name: Option<String>,
    buffer: Option<u32>,
    renderer: Renderer,
    shared: &Arc<Shared>,
    error: &Arc<Mutex<Option<String>>>,
) -> Result<(cpal::Stream, DeviceInfo), String> {
    let host = cpal::default_host();
    let device = name
        .as_ref()
        .and_then(|n| host.output_devices().ok()?.find(|d| d.name().ok().as_ref() == Some(n)))
        .or_else(|| host.default_output_device())
        .ok_or("Nessuna uscita audio disponibile")?;
    let cfg = best_config(&device)?;
    let mut config: StreamConfig = cfg.config();
    let mut buffer_size = None;
    if let (Some(b), SupportedBufferSize::Range { min, max }) = (buffer, cfg.buffer_size()) {
        if b >= *min && b <= *max {
            config.buffer_size = BufferSize::Fixed(b);
            buffer_size = Some(b);
        }
    }
    let channels = (config.channels as u32).min(MAX_OUTPUTS as u32);
    shared.sample_rate.store(config.sample_rate.0, Ordering::Relaxed);
    shared.channels.store(channels, Ordering::Relaxed);

    let stream = match cfg.sample_format() {
        SampleFormat::F32 => build::<f32>(&device, &config, renderer, error),
        SampleFormat::I16 => build::<i16>(&device, &config, renderer, error),
        SampleFormat::I32 => build::<i32>(&device, &config, renderer, error),
        SampleFormat::U16 => build::<u16>(&device, &config, renderer, error),
        f => Err(format!("Formato campioni non supportato: {f}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((
        stream,
        DeviceInfo {
            name: device.name().unwrap_or_default(),
            channels,
            sample_rate: config.sample_rate.0,
            buffer_size,
            host: host.id().name().to_string(),
        },
    ))
}

fn build<T: SizedSample + FromSample<f32>>(
    device: &cpal::Device,
    config: &StreamConfig,
    mut renderer: Renderer,
    error: &Arc<Mutex<Option<String>>>,
) -> Result<cpal::Stream, String> {
    let ch = config.channels as usize;
    let mut mix = vec![0f32; 8192 * ch];
    let error = error.clone();
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
                if mix.len() < data.len() {
                    mix.resize(data.len(), 0.0);
                }
                let mix = &mut mix[..data.len()];
                renderer.process(mix, ch);
                for (d, s) in data.iter_mut().zip(mix.iter()) {
                    *d = T::from_sample(s.clamp(-1.0, 1.0));
                }
            },
            move |e| {
                eprintln!("[audio] {e}");
                *error.lock() = Some(e.to_string());
            },
            None,
        )
        .map_err(|e| e.to_string())
}
