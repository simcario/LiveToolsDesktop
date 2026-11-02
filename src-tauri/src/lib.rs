//! LiveTools Desktop: plays the sequences (multitrack stems), click and videos
//! of the LiveTools setlists. The UI (React, ../src) reads the setlists from
//! Firestore like the web app; this side owns audio and the media cache.

mod audio;
mod bluetooth;
mod media;
mod ndi;
mod oauth;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use audio::beats::{self, SyncAnalysis, SyncRequest};
use audio::device::{DeviceEntry, DeviceInfo};
use audio::tempo::{SyncSpec, TempoMap};
use audio::engine::{JumpSpec, SongLoad, TrackLoad, TransitionSpec};
use audio::stretch::{self, StretchJob, StretchResult};
use audio::{ClickParams, Engine, SongSpec, TrackMix};
use tauri::{Emitter, Manager, State};

#[tauri::command(async)]
fn audio_devices(engine: State<'_, Engine>) -> Vec<DeviceEntry> {
    engine.0.lock().devices()
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
fn engine_schedule_jump(engine: State<'_, Engine>, jump: JumpSpec) {
    engine.0.lock().schedule_jump(jump);
}

#[tauri::command]
fn engine_cancel_jump(engine: State<'_, Engine>) {
    engine.0.lock().cancel_jump();
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

#[tauri::command]
fn engine_fade(engine: State<'_, Engine>, out: bool, seconds: f32) {
    engine.0.lock().fade(out, seconds);
}

#[tauri::command]
fn engine_set_pad(engine: State<'_, Engine>, pad: audio::render::PadParams) {
    engine.0.lock().set_pad(pad);
}

#[tauri::command(async)]
fn engine_queue_next(engine: State<'_, Engine>, song: SongSpec, transition: TransitionSpec) -> Result<SongLoad, String> {
    engine.0.lock().queue_next(song, transition)
}

#[tauri::command]
fn engine_cancel_next(engine: State<'_, Engine>) {
    engine.0.lock().cancel_next();
}

/// Renders the stems of a song in another key or tempo (cached next to each
/// file); "stretch-progress" { done, total } after each one.
#[tauri::command]
async fn stretch_tracks(app: tauri::AppHandle, jobs: Vec<StretchJob>) -> Result<Vec<StretchResult>, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    tauri::async_runtime::spawn_blocking(move || {
        stretch::render_all(jobs, cancel, |done, total| {
            let _ = app.emit("stretch-progress", serde_json::json!({ "done": done, "total": total }));
        })
    })
    .await
    .map_err(|e| e.to_string())
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

#[tauri::command]
fn engine_set_sections(engine: State<'_, Engine>, sections: Vec<audio::tempo::SectionSpec>) -> Option<TempoMap> {
    engine.0.lock().set_sections(sections)
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
        .manage(ndi::Ndi::new(monitor.clone()))
        .setup(move |app| {
            media::init(app.handle());
            // ~30 status updates per second to every window (transport, meters, video sync).
            let handle = app.handle().clone();
            let mut jump_seen = 0;
            let mut next_seen = 0;
            std::thread::Builder::new()
                .name("livetools-status".into())
                .spawn(move || loop {
                    std::thread::sleep(Duration::from_millis(33));
                    while let Ok(g) = garbage.try_recv() {
                        drop(g);
                    }
                    let fired = monitor.shared.jump_fired.load(Ordering::Relaxed);
                    if fired != jump_seen {
                        jump_seen = fired;
                        handle.state::<Engine>().0.lock().jump_fired(fired);
                    }
                    let changed = monitor.shared.next_fired.load(Ordering::Relaxed);
                    if changed != next_seen {
                        next_seen = changed;
                        handle.state::<Engine>().0.lock().next_fired(changed);
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
            engine_schedule_jump,
            engine_cancel_jump,
            engine_set_track,
            engine_set_click,
            engine_set_master,
            engine_preview_click,
            engine_set_sync,
            engine_set_sections,
            engine_set_regions,
            engine_replace_track,
            engine_fade,
            engine_set_pad,
            engine_queue_next,
            engine_cancel_next,
            stretch_tracks,
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
            ndi::ndi_status,
            ndi::ndi_configure,
            ndi::ndi_video_source,
            ndi::ndi_prompter_frame,
        ])
        .run(tauri::generate_context!())
        .expect("errore all'avvio di LiveTools");
}
