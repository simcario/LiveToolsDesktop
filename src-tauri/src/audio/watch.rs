//! Interfaces plugged in and out while the program runs. A thread looks at the
//! outputs of the system every second: a new one is announced to the UI (which
//! shows the audio settings); when the stream dies (the interface was pulled
//! out, Windows or Android invalidated it) or the interface in use is no longer
//! listed, the engine reopens the default output by itself.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::Serialize;

use super::device::{AudioHost, DeviceInfo};
use super::engine::Monitor;

const EVERY: Duration = Duration::from_millis(1000);

// Automatic detection on (the default) or off (Impostazioni: the user picks the interface by hand;
// the list is still followed, so turning it on again does not announce what was already there).
static ENABLED: AtomicBool = AtomicBool::new(true);

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

/// What changed, for the UI (event "audio-devices").
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceChange {
    /// Outputs that appeared.
    pub added: Vec<String>,
    /// Outputs that are gone.
    pub removed: Vec<String>,
    /// The interface that was playing and is lost: the default one took its place.
    pub lost: Option<String>,
    /// The interface open now (None: none could be opened, see `error`).
    pub device: Option<DeviceInfo>,
    pub error: Option<String>,
}

/// `reopen` opens the default output (locks the engine); `emit` sends to the UI.
pub fn start(host: AudioHost, monitor: Arc<Monitor>, reopen: impl Fn() -> Result<DeviceInfo, String> + Send + 'static, emit: impl Fn(DeviceChange) + Send + 'static) {
    thread::Builder::new()
        .name("livetools-devices".into())
        .spawn(move || {
            let mut known: Option<BTreeSet<String>> = None;
            // Tries left after a failed reopen: the system may take a moment to pick the new default.
            let mut retries = 0u32;
            loop {
                thread::sleep(EVERY);
                let names: BTreeSet<String> = host.names().into_iter().collect();
                let (added, removed): (Vec<String>, Vec<String>) = match &known {
                    Some(k) => (names.difference(k).cloned().collect(), k.difference(&names).cloned().collect()),
                    None => (Vec::new(), Vec::new()),
                };
                known = Some(names);
                if !ENABLED.load(Ordering::Relaxed) {
                    retries = 0;
                    continue;
                }

                let current = monitor.device.read().clone();
                let died = monitor.device_error.lock().is_some();
                // ASIO drivers are not in the list; the stream error tells when they go.
                let gone = current.as_ref().is_some_and(|d| d.host != "ASIO" && removed.contains(&d.name));
                // Nothing open (no output at startup, or the last reopen failed): try again with the new one.
                let closed = current.is_none() && (!added.is_empty() || retries > 0);
                // Android moves the default output to what is plugged in (USB, headphones).
                let follow = cfg!(target_os = "android") && !added.is_empty();
                let mut change = DeviceChange { added, removed, ..Default::default() };
                if died || gone || closed || follow {
                    if died || gone {
                        change.lost = current.as_ref().map(|d| d.name.clone());
                        eprintln!("[audio] scheda persa: {:?}", change.lost);
                    }
                    match reopen() {
                        Ok(info) => {
                            retries = 0;
                            change.device = Some(info);
                        }
                        Err(e) => {
                            retries = if died || gone { 5 } else { retries.saturating_sub(1) };
                            // Said once, not at every try.
                            if retries == 5 || retries == 0 {
                                change.error = Some(e);
                            }
                        }
                    }
                } else {
                    change.device = current;
                }
                let reopened = died || gone || closed || follow;
                if reopened || !change.added.is_empty() || !change.removed.is_empty() {
                    emit(change);
                }
            }
        })
        .expect("thread schede audio");
}
