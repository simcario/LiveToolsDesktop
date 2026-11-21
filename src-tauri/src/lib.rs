//! LiveTools Desktop: plays the sequences (multitrack stems), click and videos
//! of the LiveTools setlists. The UI (React, ../src) reads the setlists from
//! Firestore like the web app; this side owns audio and the media cache.

mod audio;
mod bluetooth;
mod media;
mod midi;
mod ndi;
mod oauth;
mod remote;
mod stagenet;

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

/// Automatic detection of the audio interfaces plugged in and out (audio/watch.rs), on or off.
#[tauri::command]
fn audio_watch(enabled: bool) {
    audio::watch::set_enabled(enabled);
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
fn engine_spectrum(monitor: State<'_, std::sync::Arc<audio::engine::Monitor>>, track: Option<usize>, bins: usize) -> Vec<f32> {
    monitor.spectrum(track, bins)
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

/// Calibration of the latency of an NDI output (see ndi::Ndi::calibrate).
#[tauri::command(async)]
fn ndi_calibrate(ndi: State<'_, ndi::Ndi>, engine: State<'_, Engine>, kind: String, count: u32, interval_ms: u64) -> Result<(), String> {
    ndi.calibrate(&kind, count, interval_ms, || engine.0.lock().calib_beep())
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

/// Where a song's video starts, from its sound matched against the stems.
#[tauri::command]
async fn align_video(request: audio::align::AlignRequest) -> Result<audio::align::AlignResult, String> {
    tauri::async_runtime::spawn_blocking(move || audio::align::align(&request))
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
fn engine_set_click_mute(engine: State<'_, Engine>, spans: Vec<[f64; 2]>, auto: Option<Vec<[f64; 2]>>) {
    engine.0.lock().set_click_mute(spans, auto)
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
        .manage(monitor.clone())
        .setup(move |app| {
            media::init(app.handle());
            // Interfaces plugged in and out: the default output takes over a lost one.
            let (reopen, emit) = (app.handle().clone(), app.handle().clone());
            audio::watch::start(
                app.state::<Engine>().0.lock().host_handle(),
                monitor.clone(),
                move || reopen.state::<Engine>().0.lock().recover_device(),
                move |change| {
                    let _ = emit.emit("audio-devices", change);
                },
            );
            // ~30 status updates per second to every window (transport, meters, video sync)
            // while something plays; at rest only the changes (StatusPacer).
            let handle = app.handle().clone();
            let mut jump_seen = 0;
            let mut next_seen = 0;
            let mut pacer = audio::engine::StatusPacer::new();
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
                    let status = monitor.status();
                    if pacer.admit(&status) {
                        let _ = handle.emit("engine-status", status);
                    }
                })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            midi::midi_outputs,
            midi::midi_send,
            midi::midi_release,
            midi::midi_inputs,
            midi::midi_listen,
            stagenet::stage_net_host,
            stagenet::stage_net_publish,
            stagenet::stage_net_scan,
            stagenet::stage_net_join,
            stagenet::stage_net_address,
            remote::remote_host,
            remote::remote_publish,
            remote::remote_scan,
            remote::remote_connect,
            remote::remote_send,
            audio_devices,
            audio_watch,
            open_audio_device,
            engine_load,
            engine_unload,
            engine_play,
            engine_stop,
            engine_locate,
            engine_schedule_jump,
            engine_cancel_jump,
            engine_set_track,
            engine_spectrum,
            engine_set_click,
            engine_set_master,
            engine_preview_click,
            engine_set_sync,
            engine_set_sections,
            engine_set_click_mute,
            engine_set_regions,
            engine_replace_track,
            engine_fade,
            engine_set_pad,
            engine_queue_next,
            engine_cancel_next,
            stretch_tracks,
            analyze_sync,
            track_onsets,
            align_video,
            media::media_dir,
            media::media_info,
            media::disk_space,
            media::set_media_dir,
            media::cache_status,
            media::download_media,
            media::request_peaks,
            media::store_media_chunk,
            media::store_media_done,
            media::delete_local_media,
            media::delete_cached_media,
            media::delete_live_cues,
            oauth::google_sign_in,
            bluetooth::bluetooth_devices,
            ndi::ndi_status,
            ndi_calibrate,
            ndi::ndi_configure,
            ndi::ndi_video_source,
            ndi::ndi_prompter_frame,
            ndi::ndi_video_still,
        ])
        // Closing the main window closes the program: video, gobbo and mixer windows too.
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("errore all'avvio di LiveTools");
}
