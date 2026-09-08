//! Network path for YouTube's attestation (BotGuard / PoToken) endpoints.
//!
//! Kept as its own command rather than widening `api_fetch`, because this needs to
//! send headers that command deliberately refuses (`x-goog-api-key`, a browser
//! `User-Agent`) to hosts that are not Invidious instances. Narrowing the surface is
//! cheaper than auditing a general-purpose client:
//!
//!   * only the two `google.internal.waa.v1.Waa` RPC methods are reachable,
//!   * only on `jnn-pa.googleapis.com`,
//!   * POST only, with a body this process passes through unread.
//!
//! Why it exists at all: googlevideo serves only ~20MB of any one format to a client
//! that cannot attest, and the TVHTML5 client - which is not capped - answers
//! LOGIN_REQUIRED without a PoToken. See docs/INNERTUBE.md.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_plugin_http::reqwest;

const ATTESTATION_HOST: &str = "jnn-pa.googleapis.com";

/// The RPC methods the renderer may call. Anything else is refused.
const ALLOWED_METHODS: &[&str] = &[
    "google.internal.waa.v1.Waa/Create",
    "google.internal.waa.v1.Waa/GenerateIT",
];

/// Public key the YouTube web client itself sends; not a secret, and not the user's.
const GOOG_API_KEY: &str = "AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw";

/// The challenge is authored for a browser, so it must be requested as one.
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttestationRequest {
    /// One of ALLOWED_METHODS.
    pub method: String,
    /// JSON body, passed through verbatim.
    pub body: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttestationResponse {
    pub status: u16,
    pub ok: bool,
    pub body: String,
}

#[tauri::command]
pub async fn yt_attestation(
    state: State<'_, crate::AppState>,
    req: AttestationRequest,
) -> Result<AttestationResponse, String> {
    let method = req.method.trim().trim_start_matches('/');
    if !ALLOWED_METHODS.contains(&method) {
        return Err(format!("attestation method not allowed: {method}"));
    }
    if req.body.len() > MAX_BODY_BYTES {
        return Err("attestation request body too large".into());
    }

    let url = format!("https://{ATTESTATION_HOST}/$rpc/{method}");

    let response = state
        .http
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/json+protobuf")
        .header(reqwest::header::USER_AGENT, BROWSER_UA)
        .header(reqwest::header::ORIGIN, "https://www.youtube.com")
        .header(reqwest::header::REFERER, "https://www.youtube.com/")
        .header("x-goog-api-key", GOOG_API_KEY)
        .header("x-user-agent", "grpc-web-javascript/0.1")
        .timeout(Duration::from_secs(30))
        .body(req.body)
        .send()
        .await
        .map_err(|e| format!("attestation request failed: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("attestation read failed: {e}"))?;

    Ok(AttestationResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        body,
    })
}
