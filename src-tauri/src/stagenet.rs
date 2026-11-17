//! Rete locale di palco: the band in sync over the stage Wi-Fi, also without internet
//! (Firestore stays the way when there is one). Shared with LiveTools Mobile
//! (mobile/scripts/sync-desktop.mjs copies this file).
//!
//! - The device that leads the band ("Guida") hosts: a TCP server (port 47322, or any
//!   free one) and a UDP beacon broadcast every second on port 47321
//!   { app: "livetools", v, id, setlist, title, name, port }.
//! - The devices that follow ("Segui palco") listen to the beacons, join the host of
//!   their setlist and get its state (the song on stage) at once, plus who is connected.
//! - Lines of JSON over TCP. Client → host: hello { id, name, part, device },
//!   ping { at, rtt }. Host → clients: state { … }, peers [ … ], pong { at }.
//!
//! Every change reaches the page as the event "stage-net": { t: "state" | "peers" |
//! "status" | "beacons", … }. Only std networking: no new dependency.

use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const BEACON_PORT: u16 = 47321;
const HOST_PORT: u16 = 47322;
const VERSION: u64 = 1;
// A peer or a beacon not heard for this long is gone.
const STALE: Duration = Duration::from_secs(5);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn instance_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| format!("{:016x}", rand::random::<u64>()))
}

fn emit(app: &AppHandle, payload: Value) {
    let _ = app.emit("stage-net", payload);
}

fn send_line(stream: &mut TcpStream, msg: &Value) -> bool {
    let mut line = msg.to_string();
    line.push('\n');
    stream.write_all(line.as_bytes()).is_ok()
}

// ---------- Host ----------

struct Peer {
    stream: TcpStream,
    info: Value,
    addr: String,
    rtt: Option<u64>,
    seen: Instant,
}

struct Host {
    stop: Arc<AtomicBool>,
    port: u16,
    info: Value,
    state: Value,
    peers: HashMap<u64, Peer>,
    // The list last shared: shared again when someone comes, goes or their latency changes.
    shared: String,
}

static NEXT_PEER: AtomicU64 = AtomicU64::new(1);

fn host_slot() -> &'static Mutex<Option<Host>> {
    static H: OnceLock<Mutex<Option<Host>>> = OnceLock::new();
    H.get_or_init(|| Mutex::new(None))
}

fn peers_json(h: &Host) -> Value {
    let mut list: Vec<Value> = h
        .peers
        .values()
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

// Sends `msg` to every peer; the ones that do not take it are dropped.
fn broadcast(h: &mut Host, msg: &Value) -> bool {
    let before = h.peers.len();
    h.peers.retain(|_, p| send_line(&mut p.stream, msg));
    h.peers.len() != before
}

fn share_peers(app: &AppHandle, h: &mut Host) {
    loop {
        let msg = json!({ "t": "peers", "peers": peers_json(h) });
        if !broadcast(h, &msg) {
            h.shared = msg.to_string();
            emit(app, msg);
            return;
        }
    }
}

fn serve_peer(app: AppHandle, id: u64, stream: TcpStream) {
    let reader = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let _ = reader.set_read_timeout(Some(STALE));
    for line in BufReader::new(reader).lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let mut slot = host_slot().lock();
        let Some(h) = slot.as_mut() else { break };
        let Some(peer) = h.peers.get_mut(&id) else { break };
        peer.seen = Instant::now();
        match msg["t"].as_str() {
            Some("hello") => {
                peer.info = json!({
                    "id": msg["id"], "name": msg["name"], "part": msg["part"], "device": msg["device"],
                });
                let state = json!({ "t": "state", "state": h.state, "host": h.info });
                if let Some(p) = h.peers.get_mut(&id) {
                    send_line(&mut p.stream, &state);
                }
                share_peers(&app, h);
            }
            Some("ping") => {
                peer.rtt = msg["rtt"].as_u64();
                let pong = json!({ "t": "pong", "at": msg["at"] });
                if !send_line(&mut peer.stream, &pong) {
                    break;
                }
            }
            _ => {}
        }
    }
    // Gone: off the list for everybody.
    let mut slot = host_slot().lock();
    if let Some(h) = slot.as_mut() {
        if h.peers.remove(&id).is_some() {
            share_peers(&app, h);
        }
    }
}

fn bind_host() -> Result<TcpListener, String> {
    // The usual port, also just after a server that is closing (it lets it go within ~100 ms):
    // who wrote the address by hand keeps finding it. Another port only when it stays taken.
    (0..10)
        .find_map(|i| {
            if i > 0 {
                thread::sleep(Duration::from_millis(60));
            }
            TcpListener::bind(("0.0.0.0", HOST_PORT)).ok()
        })
        .map(Ok)
        .unwrap_or_else(|| TcpListener::bind(("0.0.0.0", 0)))
        .map_err(|e| format!("Rete locale non disponibile: {e}"))
}

fn start_host(app: AppHandle, info: Value) -> Result<u16, String> {
    let listener = bind_host()?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    *host_slot().lock() = Some(Host { stop: stop.clone(), port, info: info.clone(), state: Value::Null, peers: HashMap::new(), shared: String::new() });

    // Who joins.
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
                            h.peers.insert(id, Peer { stream: writer, info: json!({}), addr: addr.ip().to_string(), rtt: None, seen: Instant::now() });
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

    // The beacon, and the peers not heard any more.
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
                    let now = json!({ "t": "peers", "peers": peers_json(h) }).to_string();
                    if h.peers.len() != before || now != h.shared {
                        share_peers(&app, h);
                    }
                    json!({
                        "app": "livetools", "v": VERSION, "id": instance_id(), "port": h.port,
                        "setlist": h.info["setlist"], "title": h.info["title"], "name": h.info["name"],
                    })
                };
                if let Some(s) = &sock {
                    let bytes = beacon.to_string();
                    let _ = s.send_to(bytes.as_bytes(), (Ipv4Addr::BROADCAST, BEACON_PORT));
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

/// Leads the band on the local network (`info`: { setlist, title, name, part, device }), or stops (`None`).
#[tauri::command]
pub fn stage_net_host(app: AppHandle, info: Option<Value>) -> Result<Option<u16>, String> {
    let Some(info) = info else {
        stop_host(&app);
        return Ok(None);
    };
    {
        let mut slot = host_slot().lock();
        if let Some(h) = slot.as_mut() {
            // Already hosting: only the setlist or the name changed (or the page reloaded: tell it again).
            h.info = info;
            emit(&app, json!({ "t": "status", "hosting": true, "port": h.port }));
            emit(&app, json!({ "t": "peers", "peers": peers_json(h) }));
            return Ok(Some(h.port));
        }
    }
    start_host(app, info).map(Some)
}

/// The state of the band (the song on stage …): sent to everybody connected, and to whoever joins later.
#[tauri::command]
pub fn stage_net_publish(state: Value) {
    let mut slot = host_slot().lock();
    if let Some(h) = slot.as_mut() {
        if h.state == state {
            return;
        }
        h.state = state;
        let msg = json!({ "t": "state", "state": h.state, "host": h.info });
        broadcast(h, &msg);
    }
}

// ---------- Beacons ----------

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
    let sock = UdpSocket::bind(("0.0.0.0", BEACON_PORT)).map_err(|e| format!("Rete locale: porta {BEACON_PORT} occupata ({e})"))?;
    let _ = sock.set_read_timeout(Some(Duration::from_secs(1)));
    thread::spawn(move || {
        let mut buf = [0u8; 2048];
        loop {
            if !scan_slot().lock().on {
                break;
            }
            let got = sock.recv_from(&mut buf);
            let mut s = scan_slot().lock();
            let before: Vec<String> = s.beacons.keys().cloned().collect();
            s.beacons.retain(|_, b| b.seen.elapsed() < STALE);
            let mut changed = s.beacons.len() != before.len();
            if let Ok((n, from)) = got {
                if let Ok(mut v) = serde_json::from_slice::<Value>(&buf[..n]) {
                    if v["app"] == "livetools" && v["id"].as_str().is_some_and(|id| id != instance_id()) {
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

/// Listens to the hosts on the network (`on`), or stops: the hosts heard now. The app on
/// Android wraps it (multicast lock) in its own command of the same name.
#[cfg(desktop)]
#[tauri::command]
pub fn stage_net_scan(app: AppHandle, on: bool) -> Result<Value, String> {
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

// ---------- Client ----------

struct Join {
    addr: String,
    info: Value,
    gen: u64,
    stream: Option<TcpStream>,
    /// The last state and peers from the host: sent again to a page that reloads.
    last: Vec<Value>,
    /// The host answered: connected only from its first message, not when the socket opens
    /// (a USB bridge or another program on the port accepts too, with nobody behind).
    answered: bool,
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

// Connects, reads until the host goes away, then tries again every 2 s while still wanted.
fn run_client(app: AppHandle, gen: u64) {
    let rtt = Arc::new(AtomicU64::new(u64::MAX));
    while still(gen) {
        let (addr, info) = match join_slot().lock().as_ref() {
            Some(j) => (j.addr.clone(), j.info.clone()),
            None => return,
        };
        let Some(sock) = parse_addr(&addr) else {
            emit(&app, json!({ "t": "status", "joined": addr, "connected": false, "error": "Indirizzo non valido" }));
            return;
        };
        match TcpStream::connect_timeout(&sock, Duration::from_secs(2)) {
            Ok(mut stream) => {
                let _ = stream.set_nodelay(true);
                let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                let _ = stream.set_read_timeout(Some(STALE));
                let hello = json!({ "t": "hello", "id": instance_id(), "name": info["name"], "part": info["part"], "device": info["device"] });
                if !send_line(&mut stream, &hello) {
                    thread::sleep(Duration::from_secs(2));
                    continue;
                }
                if let Some(j) = join_slot().lock().as_mut() {
                    if j.gen == gen {
                        j.stream = stream.try_clone().ok();
                    }
                }
                // Ping every second: the host shows the latency of everybody.
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
                for line in BufReader::new(stream).lines() {
                    if !still(gen) {
                        return;
                    }
                    let Ok(line) = line else { break };
                    let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                    let first = join_slot().lock().as_mut().is_some_and(|j| j.gen == gen && !std::mem::replace(&mut j.answered, true));
                    if first {
                        emit(&app, json!({ "t": "status", "joined": addr, "connected": true }));
                    }
                    match msg["t"].as_str() {
                        Some("pong") => {
                            if let Some(at) = msg["at"].as_u64() {
                                let r = now_ms().saturating_sub(at);
                                rtt.store(r, Ordering::Relaxed);
                                emit(&app, json!({ "t": "status", "joined": addr, "connected": true, "rtt": r }));
                            }
                        }
                        Some(kind @ ("state" | "peers")) => {
                            if let Some(j) = join_slot().lock().as_mut() {
                                if j.gen == gen {
                                    j.last.retain(|m| m["t"].as_str() != Some(kind));
                                    j.last.push(msg.clone());
                                }
                            }
                            emit(&app, msg)
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
                        was = std::mem::replace(&mut j.answered, false);
                    }
                }
                // Only who had answered goes away: a socket that opened and closed was never there.
                if was {
                    emit(&app, json!({ "t": "status", "joined": addr, "connected": false }));
                }
            }
            Err(e) => {
                emit(&app, json!({ "t": "status", "joined": addr, "connected": false, "error": e.to_string() }));
            }
        }
        thread::sleep(Duration::from_secs(2));
    }
}

/// Follows the host at `addr` ("ip:port", or "ip" for the usual port) with `info` { name, part, device }; `None` leaves.
#[tauri::command]
pub fn stage_net_join(app: AppHandle, addr: Option<String>, info: Value) {
    let mut slot = join_slot().lock();
    if let Some(j) = slot.as_ref() {
        if Some(&j.addr) == addr.as_ref() {
            // Already there (or trying): a page that reloaded learns it again.
            emit(&app, json!({ "t": "status", "joined": j.addr, "connected": j.stream.is_some() && j.answered }));
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
        emit(&app, json!({ "t": "status", "joined": null, "connected": false }));
        emit(&app, json!({ "t": "peers", "peers": [] }));
        return;
    };
    let gen = JOIN_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    *slot = Some(Join { addr, info, gen, stream: None, last: Vec::new(), answered: false });
    drop(slot);
    thread::spawn(move || run_client(app, gen));
}

/// The address of this device on the network (to write by hand on the others), when it has one.
#[tauri::command]
pub fn stage_net_address() -> Option<String> {
    // A UDP "connect" sends nothing: it only asks which interface would be used.
    ["8.8.8.8:80", "192.168.255.255:9", "10.255.255.255:9", "172.31.255.255:9"].iter().find_map(|to| {
        let s = UdpSocket::bind(("0.0.0.0", 0)).ok()?;
        s.connect(to).ok()?;
        let ip = s.local_addr().ok()?.ip();
        (!ip.is_unspecified() && !ip.is_loopback()).then(|| ip.to_string())
    })
}
