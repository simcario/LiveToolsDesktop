//! Telecomando: a phone or a tablet with LiveTools Mobile drives this computer over the
//! same Wi-Fi (play, songs of the setlist, sections, Video and Gobbo windows …).
//! Only on the local network: no internet, no cloud. Shared with LiveTools Mobile
//! (mobile/scripts/sync-desktop.mjs copies this file): the computer hosts, the phone joins.
//!
//! - The computer that accepts the remote hosts: a TCP server (port 47324, or any free one)
//!   and a UDP beacon broadcast every second on port 47323 { app: "livetools-remote", v, id,
//!   name, port, code } (code: whether a code is asked, never the code itself).
//! - Lines of JSON over TCP. Remote → computer: hello { id, name, device, code }, cmd { cmd,
//!   args }, ping { at, rtt }. Computer → remote: welcome { host }, denied { reason },
//!   state { key, value } (one part of what the computer shows), pong { at }.
//! - A wrong code closes the connection: only who knows the code (Impostazioni › Rete locale
//!   on the computer) drives it, not every LiveTools on the Wi-Fi of a festival.
//!
//! Events: "remote-net" { t: "cmd" | "peers" | "status" (host side) ; "status" | "state" |
//! "beacons" (remote side) }. Separate from stagenet.rs: the computer takes the remote also
//! when it does not lead the band.

use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const BEACON_PORT: u16 = 47323;
const HOST_PORT: u16 = 47324;
const VERSION: u64 = 1;
const STALE: Duration = Duration::from_secs(5);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn instance_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| format!("{:016x}", rand::random::<u64>()))
}

fn emit(app: &AppHandle, payload: Value) {
    let _ = app.emit("remote-net", payload);
}

fn send_line(stream: &mut TcpStream, msg: &Value) -> bool {
    let mut line = msg.to_string();
    line.push('\n');
    stream.write_all(line.as_bytes()).is_ok()
}

// ---------- Host (the computer) ----------

struct Peer {
    stream: TcpStream,
    info: Value,
    addr: String,
    rtt: Option<u64>,
    seen: Instant,
    /// Gave the right code: gets the state and its commands are taken.
    allowed: bool,
}

struct Host {
    stop: Arc<AtomicBool>,
    port: u16,
    info: Value,
    /// What the computer shows, by part (song, transport, setlist …): sent whole to who joins.
    state: Map<String, Value>,
    peers: HashMap<u64, Peer>,
    shared: String,
}

static NEXT_PEER: AtomicU64 = AtomicU64::new(1);

fn host_slot() -> &'static Mutex<Option<Host>> {
    static H: OnceLock<Mutex<Option<Host>>> = OnceLock::new();
    H.get_or_init(|| Mutex::new(None))
}

fn code_of(info: &Value) -> String {
    info["code"].as_str().unwrap_or("").trim().to_string()
}

fn peers_json(h: &Host) -> Value {
    let mut list: Vec<Value> = h
        .peers
        .values()
        .filter(|p| p.allowed)
        .map(|p| {
            let mut v = p.info.clone();
            v["addr"] = json!(p.addr);
            v["rtt"] = json!(p.rtt);
            v
        })
        .collect();
    list.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    Value::Array(list)
}

// To the remotes that gave the code; the ones that do not take it are dropped.
fn broadcast(h: &mut Host, msg: &Value) -> bool {
    let before = h.peers.len();
    h.peers.retain(|_, p| !p.allowed || send_line(&mut p.stream, msg));
    h.peers.len() != before
}

fn share_peers(app: &AppHandle, h: &mut Host) {
    let peers = peers_json(h);
    h.shared = peers.to_string();
    emit(app, json!({ "t": "peers", "peers": peers }));
}

fn serve_peer(app: AppHandle, id: u64, stream: TcpStream) {
    let Ok(reader) = stream.try_clone() else { return };
    let _ = reader.set_read_timeout(Some(STALE));
    for line in BufReader::new(reader).lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let mut slot = host_slot().lock();
        let Some(h) = slot.as_mut() else { break };
        let code = code_of(&h.info);
        let host_info = json!({ "id": instance_id(), "name": h.info["name"] });
        let Some(peer) = h.peers.get_mut(&id) else { break };
        peer.seen = Instant::now();
        match msg["t"].as_str() {
            Some("hello") => {
                peer.info = json!({ "id": msg["id"], "name": msg["name"], "device": msg["device"] });
                if !code.is_empty() && msg["code"].as_str().unwrap_or("").trim() != code {
                    let reason = if msg["code"].as_str().unwrap_or("").is_empty() { "code" } else { "wrong" };
                    send_line(&mut peer.stream, &json!({ "t": "denied", "reason": reason }));
                    let _ = peer.stream.shutdown(std::net::Shutdown::Both);
                    emit(&app, json!({ "t": "denied", "name": msg["name"], "addr": peer.addr }));
                    break;
                }
                peer.allowed = true;
                let mut ok = send_line(&mut peer.stream, &json!({ "t": "welcome", "host": host_info }));
                let parts: Vec<Value> = h.state.iter().map(|(k, v)| json!({ "t": "state", "key": k, "value": v })).collect();
                if let Some(p) = h.peers.get_mut(&id) {
                    for m in &parts {
                        ok = ok && send_line(&mut p.stream, m);
                    }
                }
                share_peers(&app, h);
                if !ok {
                    break;
                }
            }
            Some("ping") => {
                peer.rtt = msg["rtt"].as_u64();
                if !send_line(&mut peer.stream, &json!({ "t": "pong", "at": msg["at"] })) {
                    break;
                }
            }
            Some("cmd") if peer.allowed => {
                let from = peer.info["name"].clone();
                emit(&app, json!({ "t": "cmd", "cmd": msg["cmd"], "args": msg["args"], "from": from }));
            }
            _ => {}
        }
    }
    let mut slot = host_slot().lock();
    if let Some(h) = slot.as_mut() {
        if let Some(p) = h.peers.remove(&id) {
            if p.allowed {
                share_peers(&app, h);
            }
        }
    }
}

fn bind_host() -> Result<TcpListener, String> {
    (0..10)
        .find_map(|i| {
            if i > 0 {
                thread::sleep(Duration::from_millis(60));
            }
            TcpListener::bind(("0.0.0.0", HOST_PORT)).ok()
        })
        .map(Ok)
        .unwrap_or_else(|| TcpListener::bind(("0.0.0.0", 0)))
        .map_err(|e| format!("Telecomando non disponibile: {e}"))
}

fn start_host(app: AppHandle, info: Value) -> Result<u16, String> {
    let listener = bind_host()?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    *host_slot().lock() = Some(Host { stop: stop.clone(), port, info, state: Map::new(), peers: HashMap::new(), shared: "[]".into() });

    {
        let (app, stop) = (app.clone(), stop.clone());
        thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, addr)) => {
                        let _ = stream.set_nonblocking(false);
                        let _ = stream.set_nodelay(true);
                        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                        let Ok(writer) = stream.try_clone() else { continue };
                        let id = NEXT_PEER.fetch_add(1, Ordering::Relaxed);
                        if let Some(h) = host_slot().lock().as_mut() {
                            h.peers.insert(id, Peer { stream: writer, info: json!({}), addr: addr.ip().to_string(), rtt: None, seen: Instant::now(), allowed: false });
                        }
                        let app = app.clone();
                        thread::spawn(move || serve_peer(app, id, stream));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(100)),
                    Err(_) => thread::sleep(Duration::from_millis(300)),
                }
            }
        });
    }

    {
        let (app, stop) = (app.clone(), stop.clone());
        thread::spawn(move || {
            let sock = UdpSocket::bind(("0.0.0.0", 0)).ok();
            if let Some(s) = &sock {
                let _ = s.set_broadcast(true);
            }
            while !stop.load(Ordering::Relaxed) {
                let beacon = {
                    let mut slot = host_slot().lock();
                    let Some(h) = slot.as_mut() else { break };
                    let before = h.peers.len();
                    h.peers.retain(|_, p| p.seen.elapsed() < STALE);
                    if h.peers.len() != before || peers_json(h).to_string() != h.shared {
                        share_peers(&app, h);
                    }
                    json!({
                        "app": "livetools-remote", "v": VERSION, "id": instance_id(), "port": h.port,
                        "name": h.info["name"], "code": !code_of(&h.info).is_empty(),
                    })
                };
                if let Some(s) = &sock {
                    let _ = s.send_to(beacon.to_string().as_bytes(), (Ipv4Addr::BROADCAST, BEACON_PORT));
                }
                thread::sleep(Duration::from_secs(1));
            }
        });
    }
    emit(&app, json!({ "t": "status", "hosting": true, "port": port }));
    Ok(port)
}

fn stop_host(app: &AppHandle) {
    if let Some(h) = host_slot().lock().take() {
        h.stop.store(true, Ordering::Relaxed);
        for (_, p) in h.peers {
            let _ = p.stream.shutdown(std::net::Shutdown::Both);
        }
        emit(app, json!({ "t": "status", "hosting": false }));
        emit(app, json!({ "t": "peers", "peers": [] }));
    }
}

/// Takes the remote (`info`: { name, code }; empty code = nobody asked for one), or stops (`None`).
#[tauri::command]
pub fn remote_host(app: AppHandle, info: Option<Value>) -> Result<Option<u16>, String> {
    let Some(info) = info else {
        stop_host(&app);
        return Ok(None);
    };
    {
        let mut slot = host_slot().lock();
        if let Some(h) = slot.as_mut() {
            let new_code = code_of(&info) != code_of(&h.info);
            h.info = info;
            // A new code: who was connected with the old one gives it again.
            if new_code {
                h.peers.retain(|_, p| {
                    let _ = p.stream.shutdown(std::net::Shutdown::Both);
                    false
                });
            }
            emit(&app, json!({ "t": "status", "hosting": true, "port": h.port }));
            share_peers(&app, h);
            return Ok(Some(h.port));
        }
    }
    start_host(app, info).map(Some)
}

/// One part of what the computer shows (`key`: "song", "transport" …) to every remote, only when it changes.
#[tauri::command]
pub fn remote_publish(key: String, value: Value) {
    let mut slot = host_slot().lock();
    if let Some(h) = slot.as_mut() {
        if h.state.get(&key) == Some(&value) {
            return;
        }
        let msg = json!({ "t": "state", "key": key, "value": value });
        h.state.insert(key, value);
        broadcast(h, &msg);
    }
}

// ---------- Beacons (the remote looks for the computers) ----------

struct Beacon {
    info: Value,
    seen: Instant,
}

struct Scan {
    on: bool,
    beacons: HashMap<String, Beacon>,
}

fn scan_slot() -> &'static Mutex<Scan> {
    static S: OnceLock<Mutex<Scan>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Scan { on: false, beacons: HashMap::new() }))
}

fn beacons_json(s: &Scan) -> Value {
    Value::Array(s.beacons.values().filter(|b| b.seen.elapsed() < STALE).map(|b| b.info.clone()).collect())
}

fn start_scan(app: AppHandle) -> Result<(), String> {
    let sock = UdpSocket::bind(("0.0.0.0", BEACON_PORT)).map_err(|e| format!("Telecomando: porta {BEACON_PORT} occupata ({e})"))?;
    let _ = sock.set_read_timeout(Some(Duration::from_secs(1)));
    thread::spawn(move || {
        let mut buf = [0u8; 2048];
        loop {
            if !scan_slot().lock().on {
                break;
            }
            let got = sock.recv_from(&mut buf);
            let mut s = scan_slot().lock();
            let before = s.beacons.len();
            s.beacons.retain(|_, b| b.seen.elapsed() < STALE);
            let mut changed = s.beacons.len() != before;
            if let Ok((n, from)) = got {
                if let Ok(mut v) = serde_json::from_slice::<Value>(&buf[..n]) {
                    if v["app"] == "livetools-remote" && v["id"].as_str().is_some_and(|id| id != instance_id()) {
                        v["addr"] = json!(SocketAddr::new(from.ip(), v["port"].as_u64().unwrap_or(HOST_PORT as u64) as u16).to_string());
                        let id = v["id"].as_str().unwrap_or("").to_string();
                        changed |= s.beacons.get(&id).map(|b| b.info != v).unwrap_or(true);
                        s.beacons.insert(id, Beacon { info: v, seen: Instant::now() });
                    }
                }
            }
            if changed {
                emit(&app, json!({ "t": "beacons", "beacons": beacons_json(&s) }));
            }
        }
    });
    Ok(())
}

/// Listens to the computers that take the remote (`on`), or stops: the ones heard now.
/// The app on Android wraps it (multicast lock) in its own command of the same name.
#[cfg(desktop)]
#[tauri::command]
pub fn remote_scan(app: AppHandle, on: bool) -> Result<Value, String> {
    scan(app, on)
}

pub fn scan(app: AppHandle, on: bool) -> Result<Value, String> {
    let start = {
        let mut s = scan_slot().lock();
        let start = on && !s.on;
        s.on = on;
        if !on {
            s.beacons.clear();
        }
        start
    };
    if start {
        if let Err(e) = start_scan(app) {
            scan_slot().lock().on = false;
            return Err(e);
        }
    }
    Ok(beacons_json(&scan_slot().lock()))
}

/// Whether the beacons are listened to now (Android keeps the multicast lock while one scan is on).
#[allow(dead_code)]
pub fn scanning() -> bool {
    scan_slot().lock().on
}

// ---------- Client (the remote) ----------

struct Join {
    addr: String,
    info: Value,
    gen: u64,
    stream: Option<TcpStream>,
    /// welcome + the parts of the state: sent again to a page that reloads.
    last: Vec<Value>,
    welcomed: bool,
}

fn join_slot() -> &'static Mutex<Option<Join>> {
    static J: OnceLock<Mutex<Option<Join>>> = OnceLock::new();
    J.get_or_init(|| Mutex::new(None))
}

static JOIN_GEN: AtomicU64 = AtomicU64::new(0);

fn still(gen: u64) -> bool {
    join_slot().lock().as_ref().is_some_and(|j| j.gen == gen)
}

fn parse_addr(addr: &str) -> Option<SocketAddr> {
    addr.parse::<SocketAddr>().ok().or_else(|| addr.parse::<IpAddr>().ok().map(|ip| SocketAddr::new(ip, HOST_PORT)))
}

fn run_client(app: AppHandle, gen: u64) {
    let rtt = Arc::new(AtomicU64::new(u64::MAX));
    while still(gen) {
        let (addr, info) = match join_slot().lock().as_ref() {
            Some(j) => (j.addr.clone(), j.info.clone()),
            None => return,
        };
        let Some(sock) = parse_addr(&addr) else {
            emit(&app, json!({ "t": "status", "addr": addr, "connected": false, "error": "Indirizzo non valido" }));
            return;
        };
        match TcpStream::connect_timeout(&sock, Duration::from_secs(2)) {
            Ok(mut stream) => {
                let _ = stream.set_nodelay(true);
                let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                let _ = stream.set_read_timeout(Some(STALE));
                let hello = json!({ "t": "hello", "id": instance_id(), "name": info["name"], "device": info["device"], "code": info["code"] });
                if !send_line(&mut stream, &hello) {
                    thread::sleep(Duration::from_secs(2));
                    continue;
                }
                if let Some(j) = join_slot().lock().as_mut() {
                    if j.gen == gen {
                        j.stream = stream.try_clone().ok();
                    }
                }
                {
                    let (rtt, mut w) = (rtt.clone(), stream.try_clone());
                    thread::spawn(move || {
                        while let Ok(s) = w.as_mut() {
                            let r = rtt.load(Ordering::Relaxed);
                            let ping = json!({ "t": "ping", "at": now_ms(), "rtt": if r == u64::MAX { Value::Null } else { json!(r) } });
                            if !still(gen) || !send_line(s, &ping) {
                                break;
                            }
                            thread::sleep(Duration::from_secs(1));
                        }
                    });
                }
                let mut denied = false;
                for line in BufReader::new(stream).lines() {
                    if !still(gen) {
                        return;
                    }
                    let Ok(line) = line else { break };
                    let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                    match msg["t"].as_str() {
                        Some("welcome") => {
                            let status = json!({ "t": "status", "addr": addr, "connected": true, "host": msg["host"] });
                            if let Some(j) = join_slot().lock().as_mut() {
                                if j.gen == gen {
                                    j.welcomed = true;
                                    j.last = vec![status.clone()];
                                }
                            }
                            emit(&app, status);
                        }
                        Some("denied") => {
                            denied = true;
                            emit(&app, json!({ "t": "status", "addr": addr, "connected": false, "denied": msg["reason"] }));
                        }
                        Some("pong") => {
                            if let Some(at) = msg["at"].as_u64() {
                                let r = now_ms().saturating_sub(at);
                                rtt.store(r, Ordering::Relaxed);
                                emit(&app, json!({ "t": "rtt", "rtt": r }));
                            }
                        }
                        Some("state") => {
                            if let Some(j) = join_slot().lock().as_mut() {
                                if j.gen == gen {
                                    j.last.retain(|m| m["t"] != "state" || m["key"] != msg["key"]);
                                    j.last.push(msg.clone());
                                }
                            }
                            emit(&app, msg);
                        }
                        _ => {}
                    }
                }
                if !still(gen) {
                    return;
                }
                let mut was = false;
                if let Some(j) = join_slot().lock().as_mut() {
                    if j.gen == gen {
                        j.stream = None;
                        j.last.clear();
                        was = std::mem::replace(&mut j.welcomed, false);
                    }
                }
                // A wrong code: no use trying again with the same one.
                if denied {
                    if let Some(j) = join_slot().lock().as_mut() {
                        if j.gen == gen {
                            j.gen = 0;
                        }
                    }
                    return;
                }
                if was {
                    emit(&app, json!({ "t": "status", "addr": addr, "connected": false }));
                }
            }
            Err(e) => {
                emit(&app, json!({ "t": "status", "addr": addr, "connected": false, "error": e.to_string() }));
            }
        }
        thread::sleep(Duration::from_secs(2));
    }
}

/// Drives the computer at `addr` ("ip:port", or "ip" for the usual port) with `info`
/// { name, device, code }; `None` lets it go.
#[tauri::command]
pub fn remote_connect(app: AppHandle, addr: Option<String>, info: Value) {
    let mut slot = join_slot().lock();
    if let Some(j) = slot.as_ref() {
        if j.gen != 0 && Some(&j.addr) == addr.as_ref() && j.info == info {
            // Already there (or trying): a page that reloaded learns it again.
            if !j.welcomed {
                emit(&app, json!({ "t": "status", "addr": j.addr, "connected": false }));
            }
            j.last.iter().for_each(|m| emit(&app, m.clone()));
            return;
        }
        if let Some(s) = &j.stream {
            let _ = s.shutdown(std::net::Shutdown::Both);
        }
    }
    let Some(addr) = addr else {
        *slot = None;
        drop(slot);
        emit(&app, json!({ "t": "status", "addr": null, "connected": false }));
        return;
    };
    let gen = JOIN_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    *slot = Some(Join { addr, info, gen, stream: None, last: Vec::new(), welcomed: false });
    drop(slot);
    thread::spawn(move || run_client(app, gen));
}

/// A command to the computer driven (`cmd`: "play", "load" …, `args`: what it needs). False when not connected.
#[tauri::command]
pub fn remote_send(cmd: String, args: Option<Value>) -> bool {
    let mut slot = join_slot().lock();
    let Some(j) = slot.as_mut() else { return false };
    if !j.welcomed {
        return false;
    }
    let Some(s) = j.stream.as_mut() else { return false };
    send_line(s, &json!({ "t": "cmd", "cmd": cmd, "args": args.unwrap_or(Value::Null) }))
}
