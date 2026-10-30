//! LiveTools Desktop: plays the sequences (multitrack stems), click and videos
//! of the LiveTools setlists. The UI (React, ../src) reads the setlists from
//! Firestore like the web app; this side owns audio and the media cache.

mod audio;
mod bluetooth;
mod media;
mod oauth;

use std::time::Duration;

use audio::beats::{self, SyncAnalysis, SyncRequest};
use audio::device::{self, DeviceEntry, DeviceInfo};
use audio::tempo::{SyncSpec, TempoMap};
use audio::engine::{SongLoad, TrackLoad};
use audio::{ClickParams, Engine, SongSpec, TrackMix};
use tauri::{Emitter, State};

#[tauri::command]
fn audio_devices() -> Vec<DeviceEntry> {
    device::list()
}

#[tauri::command(async)]
fn open_audio_device(engine: State<'_, Engine>, name: Option<String>, buffer: Option<u32>) -> Result<DeviceInfo, String> {
    engine.0.lock().open_device(name, buffer)
}

#[tauri::command(async)]
fn engine_load(engine: State<'_, Engine>, song: SongSpec) -> Result<SongLoad, String> {
    engine.0.lock().load(song)
}

#[tauri::command]
fn engine_unload(engine: State<'_, Engine>) {
    engine.0.lock().unload();
}

#[tauri::command]
fn engine_play(engine: State<'_, Engine>, count_in: bool) {
    engine.0.lock().play(count_in);
}

#[tauri::command]
fn engine_stop(engine: State<'_, Engine>) {
    engine.0.lock().stop();
}

#[tauri::command]
fn engine_locate(engine: State<'_, Engine>, seconds: f64) {
    engine.0.lock().locate(seconds);
}

#[tauri::command]
fn engine_set_track(engine: State<'_, Engine>, id: String, mix: TrackMix) {
    engine.0.lock().set_track(&id, mix);
}

#[tauri::command]
fn engine_set_click(engine: State<'_, Engine>, click: ClickParams) {
    engine.0.lock().set_click(click);
}

#[tauri::command]
fn engine_preview_click(engine: State<'_, Engine>, kind: audio::tempo::ClickKind) {
    engine.0.lock().preview_click(kind);
}

#[tauri::command]
fn engine_set_master(engine: State<'_, Engine>, gain_db: f32) {
    engine.0.lock().set_master(gain_db);
}

/// Lines the grid up with a click or rhythm stem (result cached next to the file).
#[tauri::command]
async fn analyze_sync(request: SyncRequest) -> Result<SyncAnalysis, String> {
    tauri::async_runtime::spawn_blocking(move || beats::analyze(&request))
        .await
        .map_err(|e| e.to_string())?
}

/// Transients of a local file (warp magnet).
#[tauri::command]
async fn track_onsets(path: String) -> Result<Vec<f64>, String> {
    tauri::async_runtime::spawn_blocking(move || beats::onsets(std::path::Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn engine_set_regions(engine: State<'_, Engine>, regions: std::collections::HashMap<String, Vec<audio::stream::Region>>) -> Option<f64> {
    engine.0.lock().set_regions(regions)
}

#[tauri::command]
fn engine_replace_track(engine: State<'_, Engine>, id: String, new_id: String, path: String) -> Result<TrackLoad, String> {
    engine.0.lock().replace_track(&id, new_id, path)
}

#[tauri::command]
fn engine_set_sync(engine: State<'_, Engine>, sync: Option<SyncSpec>) -> Option<TempoMap> {
    engine.0.lock().set_sync(sync)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (engine, monitor, garbage) = Engine::new();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(engine)
        .setup(move |app| {
            media::init(app.handle());
            // ~30 status updates per second to every window (transport, meters, video sync).
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("livetools-status".into())
                .spawn(move || loop {
                    std::thread::sleep(Duration::from_millis(33));
                    while let Ok(g) = garbage.try_recv() {
                        drop(g);
                    }
                    let _ = handle.emit("engine-status", monitor.status());
                })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            audio_devices,
            open_audio_device,
            engine_load,
            engine_unload,
            engine_play,
            engine_stop,
            engine_locate,
            engine_set_track,
            engine_set_click,
            engine_set_master,
            engine_preview_click,
            engine_set_sync,
            engine_set_regions,
            engine_replace_track,
            analyze_sync,
            track_onsets,
            media::media_dir,
            media::media_info,
            media::set_media_dir,
            media::cache_status,
            media::download_media,
            media::request_peaks,
            media::store_media_chunk,
            media::store_media_done,
            oauth::google_sign_in,
            bluetooth::bluetooth_devices,
        ])
        .run(tauri::generate_context!())
        .expect("errore all'avvio di LiveTools");
}
