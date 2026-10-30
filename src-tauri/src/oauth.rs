//! Google sign-in for a desktop app: authorization code + PKCE in the system
//! browser with a loopback redirect. The resulting ID token signs in to
//! Firebase from the UI (signInWithCredential), same account as the web app.
//!
//! Needs an OAuth client of type "Desktop app" in the Firebase project's
//! Google Cloud console. Its id/secret come from the build environment
//! (LIVETOOLS_GOOGLE_CLIENT_ID / LIVETOOLS_GOOGLE_CLIENT_SECRET) or from
//! <app config>/oauth.json: { "clientId": "...", "clientSecret": "..." }.
//! For desktop clients Google does not treat the secret as confidential.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::distributions::Alphanumeric;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientConfig {
    client_id: String,
    client_secret: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleTokens {
    id_token: String,
    access_token: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    id_token: Option<String>,
    access_token: Option<String>,
}

const PAGE_OK: &str = "<!doctype html><meta charset=utf-8><title>LiveTools</title>\
<body style=\"background:#0b0f17;color:#f8fafc;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0\">\
<div style=\"text-align:center\"><h1 style=\"color:#f59e0b\">Accesso completato</h1><p>Puoi chiudere questa scheda e tornare a LiveTools.</p></div>";

fn client_config(app: &AppHandle) -> Result<ClientConfig, String> {
    if let Some(id) = option_env!("LIVETOOLS_GOOGLE_CLIENT_ID") {
        return Ok(ClientConfig {
            client_id: id.to_string(),
            client_secret: option_env!("LIVETOOLS_GOOGLE_CLIENT_SECRET").map(str::to_string),
        });
    }
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?.join("oauth.json");
    let text = std::fs::read_to_string(&path).map_err(|_| {
        format!(
            "Login Google non configurato: manca il client OAuth desktop ({}). Vedi README.md.",
            path.display()
        )
    })?;
    serde_json::from_str(&text).map_err(|e| format!("oauth.json non valido: {e}"))
}

fn random(len: usize) -> String {
    rand::thread_rng().sample_iter(&Alphanumeric).take(len).map(char::from).collect()
}

#[tauri::command]
pub async fn google_sign_in(app: AppHandle) -> Result<GoogleTokens, String> {
    let cfg = client_config(&app)?;
    tauri::async_runtime::spawn_blocking(move || sign_in(&app, cfg))
        .await
        .map_err(|e| e.to_string())?
}

fn sign_in(app: &AppHandle, cfg: ClientConfig) -> Result<GoogleTokens, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let redirect = format!("http://127.0.0.1:{}", listener.local_addr().map_err(|e| e.to_string())?.port());
    let verifier = random(64);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random(24);
    let auth_url = url::Url::parse_with_params(
        "https://accounts.google.com/o/oauth2/v2/auth",
        &[
            ("client_id", cfg.client_id.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("response_type", "code"),
            ("scope", "openid email profile"),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", state.as_str()),
            ("prompt", "select_account"),
        ],
    )
    .map_err(|e| e.to_string())?;
    app.opener().open_url(auth_url.as_str(), None::<&str>).map_err(|e| e.to_string())?;

    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(300);
    let code = loop {
        if Instant::now() > deadline {
            return Err("Tempo scaduto per l’accesso con Google".into());
        }
        let (mut sock, _) = match listener.accept() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let _ = sock.set_nonblocking(false);
        let _ = sock.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buf = [0u8; 8192];
        let n = sock.read(&mut buf).unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]);
        let target = req.split_whitespace().nth(1).unwrap_or("/");
        let query = url::Url::parse(&format!("http://localhost{target}")).ok();
        let param = |k: &str| query.as_ref()?.query_pairs().find(|(q, _)| q == k).map(|(_, v)| v.into_owned());
        if param("state").as_deref() != Some(state.as_str()) {
            // Favicon and other stray requests.
            let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            continue;
        }
        let body = if param("error").is_some() { "Accesso annullato." } else { PAGE_OK };
        let _ = write!(
            sock,
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        if let Some(e) = param("error") {
            return Err(format!("Accesso Google annullato ({e})"));
        }
        break param("code").ok_or("Risposta di Google senza codice")?;
    };

    let mut form = vec![
        ("code", code.as_str()),
        ("client_id", cfg.client_id.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("grant_type", "authorization_code"),
        ("code_verifier", verifier.as_str()),
    ];
    if let Some(secret) = cfg.client_secret.as_deref() {
        form.push(("client_secret", secret));
    }
    let tokens: TokenResponse = ureq::post("https://oauth2.googleapis.com/token")
        .send_form(&form)
        .map_err(|e| match e {
            ureq::Error::Status(_, r) => r.into_string().unwrap_or_default(),
            e => e.to_string(),
        })?
        .into_json()
        .map_err(|e| e.to_string())?;
    Ok(GoogleTokens {
        id_token: tokens.id_token.ok_or("Google non ha restituito l’ID token")?,
        access_token: tokens.access_token,
    })
}
