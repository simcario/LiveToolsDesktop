use std::path::Path;

// LIVETOOLS_* variables can also come from desktop/.env (not committed): they
// are compiled into the app (see oauth.rs). Real environment variables win.
fn load_env_file(path: &Path) {
    println!("cargo:rerun-if-changed={}", path.display());
    let Ok(text) = std::fs::read_to_string(path) else { return };
    // Windows editors often save UTF-8 with a BOM.
    for line in text.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim().trim_start_matches("export ").trim();
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if key.starts_with("LIVETOOLS_") && std::env::var_os(key).is_none() {
            println!("cargo:rustc-env={key}={value}");
        }
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=LIVETOOLS_GOOGLE_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=LIVETOOLS_GOOGLE_CLIENT_SECRET");
    load_env_file(Path::new("../.env"));
    tauri_build::build()
}
