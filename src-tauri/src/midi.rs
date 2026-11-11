//! MIDI out: the patches of a song (Bank Select, Program Change, Control Change,
//! SysEx, built in JS by shared/midi-patch.js) sent to the keyboards when the
//! song becomes the one in the player. Ports are named as Windows names them;
//! a connection stays open until the port goes away, then it is opened again
//! by name (an interface unplugged and plugged back in keeps working).
//! rtpMIDI (network MIDI) shows up here as one more port.

use midir::{MidiOutput, MidiOutputConnection};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::OnceLock;

const CLIENT: &str = "LiveTools";

fn connections() -> &'static Mutex<HashMap<String, MidiOutputConnection>> {
    static C: OnceLock<Mutex<HashMap<String, MidiOutputConnection>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn output() -> Result<MidiOutput, String> {
    MidiOutput::new(CLIENT).map_err(|e| format!("MIDI non disponibile: {e}"))
}

fn port_names() -> Result<Vec<String>, String> {
    let out = output()?;
    Ok(out.ports().iter().filter_map(|p| out.port_name(p).ok()).collect())
}

fn connect(name: &str) -> Result<MidiOutputConnection, String> {
    let out = output()?;
    let port = out
        .ports()
        .into_iter()
        .find(|p| out.port_name(p).ok().as_deref() == Some(name))
        .ok_or_else(|| format!("Uscita MIDI “{name}” non collegata"))?;
    out.connect(&port, CLIENT).map_err(|e| format!("Uscita MIDI “{name}” occupata o non disponibile: {e}"))
}

/// Names of the MIDI outputs of this computer.
#[tauri::command]
pub async fn midi_outputs() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(port_names).await.map_err(|e| e.to_string())?
}

fn send_all(port: &str, messages: &[Vec<u8>]) -> Result<usize, String> {
    let mut conns = connections().lock();
    for attempt in 0..2 {
        if !conns.contains_key(port) {
            let conn = connect(port)?;
            conns.insert(port.to_string(), conn);
        }
        let conn = conns.get_mut(port).expect("just inserted");
        let mut sent = 0;
        let mut failed = None;
        for m in messages.iter().filter(|m| !m.is_empty()) {
            match conn.send(m) {
                Ok(()) => sent += 1,
                Err(e) => {
                    failed = Some(e.to_string());
                    break;
                }
            }
        }
        match failed {
            None => return Ok(sent),
            // The port went away (unplugged): open it again once, by name.
            Some(e) => {
                if let Some(c) = conns.remove(port) {
                    c.close();
                }
                if attempt == 1 || sent > 0 {
                    return Err(format!("Invio MIDI a “{port}” non riuscito: {e}"));
                }
            }
        }
    }
    unreachable!()
}

/// Sends `messages` (each a whole MIDI message, SysEx included) to the output `port`: how many went out.
#[tauri::command]
pub async fn midi_send(port: String, messages: Vec<Vec<u8>>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || send_all(&port, &messages)).await.map_err(|e| e.to_string())?
}

/// Closes the open connections (another app wants the port, or the app is closing).
#[tauri::command]
pub fn midi_release() {
    for (_, c) in connections().lock().drain() {
        c.close();
    }
}

// ---------- MIDI in (controllers for MIDI learn) ----------
//
// The ports listened to send every message to the page as the event "midi-in"
// { port, data } (lib/midiLearn.js maps them to the controls). A watcher opens
// the ports again when they come back (an interface unplugged and plugged in)
// and drops those that went away. Clock and active sensing are not sent on.

use midir::{MidiInput, MidiInputConnection};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Default)]
struct Listen {
    all: bool,
    ports: Vec<String>,
    open: HashMap<String, MidiInputConnection<()>>,
    failed: HashMap<String, String>,
    watching: bool,
}

fn listen_state() -> &'static Mutex<Listen> {
    static L: OnceLock<Mutex<Listen>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(Listen::default()))
}

#[derive(Clone, Serialize)]
struct MidiIn {
    port: String,
    data: Vec<u8>,
}

fn input_names() -> Vec<String> {
    match MidiInput::new(CLIENT) {
        Ok(input) => input.ports().iter().filter_map(|p| input.port_name(p).ok()).collect(),
        Err(_) => Vec::new(),
    }
}

fn open_input(app: &AppHandle, name: &str) -> Result<MidiInputConnection<()>, String> {
    let mut input = MidiInput::new(CLIENT).map_err(|e| e.to_string())?;
    input.ignore(midir::Ignore::TimeAndActiveSense);
    let port = input
        .ports()
        .into_iter()
        .find(|p| input.port_name(p).ok().as_deref() == Some(name))
        .ok_or_else(|| "non collegato".to_string())?;
    let app = app.clone();
    let port_name = name.to_string();
    input
        .connect(
            &port,
            CLIENT,
            move |_, data, _| {
                if data.first().is_some_and(|b| *b >= 0xf8) {
                    return;
                }
                let _ = app.emit("midi-in", MidiIn { port: port_name.clone(), data: data.to_vec() });
            },
            (),
        )
        .map_err(|e| format!("occupato da un altro programma ({e})"))
}

// Opens the wanted ports that are there and closes the others.
fn sync_inputs(app: &AppHandle) {
    let names = input_names();
    let mut l = listen_state().lock();
    let wanted: Vec<String> = names.iter().filter(|n| l.all || l.ports.contains(n)).cloned().collect();
    let stale: Vec<String> = l.open.keys().filter(|n| !wanted.contains(n)).cloned().collect();
    for n in stale {
        if let Some(c) = l.open.remove(&n) {
            c.close();
        }
    }
    l.failed.retain(|n, _| wanted.contains(n));
    for n in wanted {
        if l.open.contains_key(&n) {
            continue;
        }
        match open_input(app, &n) {
            Ok(c) => {
                l.failed.remove(&n);
                l.open.insert(n, c);
            }
            Err(e) => {
                l.failed.insert(n, e);
            }
        }
    }
}

#[derive(Serialize)]
pub struct InputPort {
    name: String,
    listening: bool,
    error: Option<String>,
}

/// The MIDI inputs of this computer and whether LiveTools is listening to each.
#[tauri::command]
pub async fn midi_inputs() -> Result<Vec<InputPort>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let names = input_names();
        let l = listen_state().lock();
        names
            .into_iter()
            .map(|name| InputPort { listening: l.open.contains_key(&name), error: l.failed.get(&name).cloned(), name })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Listens to every input (`all`) or to the inputs named in `ports`; nothing when both are empty.
#[tauri::command]
pub async fn midi_listen(app: AppHandle, all: bool, ports: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let start = {
            let mut l = listen_state().lock();
            l.all = all;
            l.ports = ports;
            let start = !l.watching && (l.all || !l.ports.is_empty());
            if start {
                l.watching = true;
            }
            start
        };
        sync_inputs(&app);
        if start {
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(2));
                sync_inputs(&app);
            });
        }
    })
    .await
    .map_err(|e| e.to_string())
}
