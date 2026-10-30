//! Local cache of the media stored in Firebase Storage. Files keep their
//! storage path under the media folder (<app data>/media unless the user picks
//! another one), so the same file shared by duplicated setlists is downloaded once.

use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::decode;
use crate::audio::Engine;

// ---------- Media folder ----------
// The chosen folder is kept in <app data>/config.json (None = default), so
// Rust knows it before the webview starts.

static MEDIA_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);
static MOVING: AtomicBool = AtomicBool::new(false);

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    media_dir: Option<PathBuf>,
}

fn config_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("config.json"))
}

fn default_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("media"))
}

/// Lets the webview play videos from a folder outside <app data>.
fn allow_assets(app: &AppHandle, dir: &Path) {
    let _ = app.asset_protocol_scope().allow_directory(dir, true);
}

/// Called once at startup: reads the chosen media folder.
pub fn init(app: &AppHandle) {
    let custom = config_file(app)
        .ok()
        .and_then(|f| fs::read(f).ok())
        .and_then(|b| serde_json::from_slice::<Config>(&b).ok())
        .and_then(|c| c.media_dir);
    if let Some(dir) = &custom {
        allow_assets(app, dir);
    }
    *MEDIA_DIR.write().unwrap() = custom;
}

pub fn media_root(app: &AppHandle) -> Result<PathBuf, String> {
    let custom = MEDIA_DIR.read().unwrap().clone();
    let dir = match custom {
        Some(d) => d,
        None => default_root(app)?,
    };
    fs::create_dir_all(&dir).map_err(|e| format!("Cartella media non disponibile ({}): {e}", dir.display()))?;
    Ok(dir)
}

/// Storage path → local path, refusing anything that could escape the cache.
pub fn local_path(app: &AppHandle, storage_path: &str) -> Result<PathBuf, String> {
    let rel = Path::new(storage_path);
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("Percorso non valido: {storage_path}"));
    }
    Ok(media_root(app)?.join(rel))
}

#[derive(Deserialize)]
pub struct CacheEntry {
    path: String,
    size: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheState {
    path: String,
    local: String,
    ready: bool,
}

#[tauri::command]
pub fn media_dir(app: AppHandle) -> Result<String, String> {
    Ok(media_root(&app)?.to_string_lossy().into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    path: String,
    default_path: String,
    is_default: bool,
    files: usize,
    bytes: u64,
}

/// Every file under `root`, as (path relative to root, size).
fn walk(root: &Path) -> Result<Vec<(PathBuf, u64)>, String> {
    let mut out = Vec::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            if meta.is_dir() {
                dirs.push(entry.path());
            } else {
                let rel = entry.path().strip_prefix(root).map_err(|e| e.to_string())?.to_path_buf();
                out.push((rel, meta.len()));
            }
        }
    }
    Ok(out)
}

/// Current media folder, the default one and how much it holds.
#[tauri::command]
pub async fn media_info(app: AppHandle) -> Result<MediaInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = media_root(&app)?;
        let files = walk(&root)?;
        Ok(MediaInfo {
            is_default: MEDIA_DIR.read().unwrap().is_none(),
            path: root.to_string_lossy().into_owned(),
            default_path: default_root(&app)?.to_string_lossy().into_owned(),
            files: files.len(),
            bytes: files.iter().map(|f| f.1).sum(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveProgress {
    done: u64,
    total: u64,
}

/// Moves every cached file into `path` (None or empty = default folder) and
/// makes it the media folder. The song is unloaded first; on any error the
/// files already moved go back and the folder does not change.
#[tauri::command]
pub async fn set_media_dir(app: AppHandle, engine: tauri::State<'_, Engine>, path: Option<String>) -> Result<String, String> {
    if !ACTIVE.lock().unwrap().is_empty() {
        return Err("Attendi la fine dei download in corso".into());
    }
    let target = match path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => default_root(&app)?,
    };
    if !target.is_absolute() {
        return Err("Indica un percorso completo, es. D:\\LiveTools Media".into());
    }
    if MOVING.swap(true, Ordering::SeqCst) {
        return Err("Spostamento già in corso".into());
    }
    engine.0.lock().unload();
    let res = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || -> Result<PathBuf, String> {
            let old = media_root(&app)?;
            move_tree(&app, &old, &target)?;
            let is_default = target == default_root(&app)?;
            let config = Config { media_dir: (!is_default).then(|| target.clone()) };
            let json = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
            fs::write(config_file(&app)?, json).map_err(|e| e.to_string())?;
            allow_assets(&app, &target);
            *MEDIA_DIR.write().unwrap() = config.media_dir;
            Ok(target)
        }
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    MOVING.store(false, Ordering::SeqCst);
    res.map(|p| p.to_string_lossy().into_owned())
}

fn move_tree(app: &AppHandle, old: &Path, new: &Path) -> Result<(), String> {
    let existed = new.exists();
    fs::create_dir_all(new).map_err(|e| format!("Impossibile creare {}: {e}", new.display()))?;
    let o = old.canonicalize().map_err(|e| e.to_string())?;
    let n = new.canonicalize().map_err(|e| e.to_string())?;
    if o == n {
        return Ok(());
    }
    if n.starts_with(&o) || o.starts_with(&n) {
        if !existed {
            let _ = fs::remove_dir(new);
        }
        return Err("La nuova cartella non può stare dentro quella attuale, né contenerla".into());
    }
    let files = walk(&o)?;
    let total: u64 = files.iter().map(|f| f.1).sum();
    let mut done = 0u64;
    let mut last = Instant::now();
    // Same disk: rename. Another disk: copy now, delete the originals at the end.
    let mut moved: Vec<&Path> = Vec::new();
    let mut copied: Vec<&Path> = Vec::new();
    let mut failure = None;
    for (rel, size) in &files {
        let (src, dest) = (o.join(rel), n.join(rel));
        let step = dest.parent().map_or(Ok(()), fs::create_dir_all).and_then(|_| match fs::rename(&src, &dest) {
            Ok(()) => {
                moved.push(rel);
                Ok(())
            }
            Err(_) => fs::copy(&src, &dest).map(|_| copied.push(rel)),
        });
        if let Err(e) = step {
            failure = Some(format!("{}: {e}", rel.display()));
            break;
        }
        done += size;
        if last.elapsed() > Duration::from_millis(150) {
            last = Instant::now();
            let _ = app.emit("media-move-progress", MoveProgress { done, total });
        }
    }
    if let Some(err) = failure {
        for rel in moved {
            let _ = fs::rename(n.join(rel), o.join(rel));
        }
        for rel in copied {
            let _ = fs::remove_file(n.join(rel));
        }
        prune(&n);
        if !existed {
            let _ = fs::remove_dir(&n);
        }
        return Err(format!("Spostamento annullato, i media restano dove sono. {err}"));
    }
    for rel in copied {
        let _ = fs::remove_file(o.join(rel));
    }
    prune(&o);
    let _ = app.emit("media-move-progress", MoveProgress { done: total, total });
    Ok(())
}

/// Removes the empty folders under `root` (not `root` itself).
fn prune(root: &Path) {
    fn rec(dir: &Path) -> bool {
        let Ok(entries) = fs::read_dir(dir) else { return false };
        let mut empty = true;
        for entry in entries.flatten() {
            let p = entry.path();
            if !(p.is_dir() && rec(&p) && fs::remove_dir(&p).is_ok()) {
                empty = false;
            }
        }
        empty
    }
    rec(root);
}

#[tauri::command]
pub fn cache_status(app: AppHandle, entries: Vec<CacheEntry>) -> Result<Vec<CacheState>, String> {
    entries
        .into_iter()
        .map(|e| {
            let local = local_path(&app, &e.path)?;
            let size = fs::metadata(&local).ok().map(|m| m.len());
            let ready = match (size, e.size) {
                (Some(s), Some(expected)) => s == expected,
                (Some(_), None) => true,
                _ => false,
            };
            Ok(CacheState { path: e.path, local: local.to_string_lossy().into_owned(), ready })
        })
        .collect()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    path: &'a str,
    received: u64,
    total: u64,
}

static ACTIVE: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Downloads `url` (a Storage download URL) to the cache; emits "media-progress".
#[tauri::command]
pub async fn download_media(app: AppHandle, url: String, path: String) -> Result<String, String> {
    if MOVING.load(Ordering::SeqCst) {
        return Err("Spostamento dei media in corso".into());
    }
    let dest = local_path(&app, &path)?;
    {
        let mut active = ACTIVE.lock().unwrap();
        if active.contains(&path) {
            return Err("Download già in corso".into());
        }
        active.push(path.clone());
    }
    let res = tauri::async_runtime::spawn_blocking({
        let (app, path, dest) = (app.clone(), path.clone(), dest.clone());
        move || download(&app, &url, &path, &dest)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    ACTIVE.lock().unwrap().retain(|p| p != &path);
    res.map(|_| dest.to_string_lossy().into_owned())
}

fn download(app: &AppHandle, url: &str, path: &str, dest: &Path) -> Result<(), String> {
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let resp = ureq::get(url).timeout(Duration::from_secs(30)).call().map_err(|e| e.to_string())?;
    let total = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let part = dest.with_extension("part");
    let mut file = fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 256 * 1024];
    let mut received = 0u64;
    let mut last = Instant::now();
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        received += n as u64;
        if last.elapsed() > Duration::from_millis(150) {
            last = Instant::now();
            let _ = app.emit("media-progress", Progress { path, received, total });
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    if total > 0 && received != total {
        let _ = fs::remove_file(&part);
        return Err("Download incompleto".into());
    }
    fs::rename(&part, dest).map_err(|e| e.to_string())?;
    let _ = app.emit("media-progress", Progress { path, received, total: received });
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PeaksEvent {
    path: String,
    peaks_per_sec: u32,
    peaks: Vec<u8>,
    duration: f64,
    error: Option<String>,
}

static PEAK_JOBS: Mutex<usize> = Mutex::new(0);

/// Computes the waveform of each local file in the background ("media-peaks" events).
#[tauri::command]
pub fn request_peaks(app: AppHandle, paths: Vec<String>) {
    for path in paths {
        let app = app.clone();
        thread::spawn(move || {
            // At most 3 files decoded at once, to leave the disk to playback.
            loop {
                let mut jobs = PEAK_JOBS.lock().unwrap();
                if *jobs < 3 {
                    *jobs += 1;
                    break;
                }
                drop(jobs);
                thread::sleep(Duration::from_millis(50));
            }
            let res = decode::peaks(Path::new(&path));
            *PEAK_JOBS.lock().unwrap() -= 1;
            let ev = match res {
                Ok((peaks, duration)) => PeaksEvent { path, peaks_per_sec: decode::PEAKS_PER_SEC, peaks, duration, error: None },
                Err(e) => PeaksEvent { path, peaks_per_sec: decode::PEAKS_PER_SEC, peaks: Vec::new(), duration: 0.0, error: Some(e) },
            };
            let _ = app.emit("media-peaks", ev);
        });
    }
}

// ---------- Files uploaded from this computer ----------
// The webview sends the file in chunks (raw body, path and offset in the
// headers) while it uploads it to Storage, so it never has to be downloaded.

fn header<'a>(request: &'a tauri::ipc::Request<'_>, name: &str) -> Result<&'a str, String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("Intestazione {name} mancante"))
}

#[tauri::command]
pub fn store_media_chunk(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Dati non validi".into());
    };
    let path = url::form_urlencoded::parse(format!("p={}", header(&request, "x-path")?).as_bytes())
        .next()
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    let offset: u64 = header(&request, "x-offset")?.parse().map_err(|_| "Offset non valido".to_string())?;
    let part = local_path(&app, &path)?.with_extension("part");
    if let Some(dir) = part.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut file = if offset == 0 {
        fs::File::create(&part)
    } else {
        fs::OpenOptions::new().append(true).open(&part)
    }
    .map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() != offset {
        return Err("Blocco fuori sequenza".into());
    }
    file.write_all(bytes).map_err(|e| e.to_string())
}

/// Completes a stored file: checks the size and moves it into the cache.
#[tauri::command]
pub fn store_media_done(app: AppHandle, path: String, size: u64) -> Result<String, String> {
    let dest = local_path(&app, &path)?;
    let part = dest.with_extension("part");
    let len = fs::metadata(&part).map_err(|e| e.to_string())?.len();
    if len != size {
        let _ = fs::remove_file(&part);
        return Err("Copia locale incompleta".into());
    }
    fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}
