//! YouTube TV sign-in (OAuth 2.0 device flow).
//!
//! Why this exists: the TVHTML5 client refuses to play for a signed-out session. With
//! no `visitorData` it answers LOGIN_REQUIRED ("Sign in to confirm you're not a bot");
//! with any `visitorData` it answers "The page needs to be reloaded". That is true for
//! every client version, both client-name ids, real signature timestamps, all `/tv`
//! session cookies, and with or without a valid PoToken - so the gate is the account,
//! not attestation. See docs/INNERTUBE.md.
//!
//! This mirrors upstream Playlet's `OAuth.bs` step for step, because it is the same
//! flow every living-room YouTube app uses:
//!
//!   1. GET /tv, find `<script id="base-js" src="...">`
//!   2. GET that bundle, extract the OAuth client id and secret
//!   3. POST /o/oauth2/device/code -> a short user code the person types at
//!      google.com/device
//!   4. Poll /o/oauth2/token until they approve
//!   5. Refresh with the refresh token thereafter
//!
//! The client id belongs to YouTube's own TV app; it is not a secret and not the
//! user's. The refresh token IS sensitive and is stored in the app's data directory.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use tauri_plugin_http::reqwest;

const TV_UA: &str = "Mozilla/5.0(SMART-TV; Linux; Tizen 4.0.0.2) AppleWebkit/605.1.15 \
                     (KHTML, like Gecko) SamsungBrowser/9.2 TV Safari/605.1.15";

const TV_URL: &str = "https://www.youtube.com/tv";
const DEVICE_CODE_URL: &str = "https://www.youtube.com/o/oauth2/device/code";
const TOKEN_URL: &str = "https://www.youtube.com/o/oauth2/token";

/// The scopes the TV app itself requests.
const SCOPE: &str = "http://gdata.youtube.com https://www.googleapis.com/auth/youtube-paid-content";

/// Device model string the living-room client sends.
const DEVICE_MODEL: &str = "ytlr::";

const DEVICE_GRANT: &str = "http://oauth.net/grant_type/device/1.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientIdentity {
    pub client_id: String,
    pub client_secret: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    pub device_code: String,
    /// What the user types at the verification URL.
    pub user_code: String,
    pub verification_url: String,
    /// Seconds between polls, as dictated by the server.
    pub interval: u64,
    pub expires_in: u64,
    pub client_id: String,
    pub client_secret: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenResult {
    /// "authorized", "pending", "slow_down", "expired", or "denied".
    pub state: String,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    /// Unix seconds at which the access token stops working.
    pub expires_at: Option<u64>,
    pub error: Option<String>,
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The value between a marker and the next terminator.
fn between<'a>(haystack: &'a str, marker: &str, terminator: char) -> Option<&'a str> {
    let start = haystack.find(marker)? + marker.len();
    let rest = &haystack[start..];
    let end = rest.find(terminator)?;
    Some(&rest[..end])
}

/// Extract `clientId:"...",<anything>:"..."` - the id/secret pair, adjacent in the bundle.
///
/// Written by hand rather than with a regex crate: the pattern is one lookahead and
/// pulling in a regex engine for it is not worth the build time.
fn extract_client_identity(js: &str) -> Option<ClientIdentity> {
    let mut cursor = 0usize;
    while let Some(found) = js[cursor..].find("clientId:\"") {
        let at = cursor + found;
        let after_id = at + "clientId:\"".len();
        let Some(id_end) = js[after_id..].find('"') else { break };
        let client_id = &js[after_id..after_id + id_end];

        // The secret is the next quoted string after the following colon.
        let tail_start = after_id + id_end + 1;
        let window_end = (tail_start + 200).min(js.len());
        let window = &js[tail_start..window_end];

        if let Some(colon) = window.find(":\"") {
            let secret_start = colon + 2;
            if let Some(secret_end) = window[secret_start..].find('"') {
                let client_secret = &window[secret_start..secret_start + secret_end];
                if !client_id.is_empty() && !client_secret.is_empty() {
                    return Some(ClientIdentity {
                        client_id: client_id.to_string(),
                        client_secret: client_secret.to_string(),
                    });
                }
            }
        }
        cursor = after_id;
    }
    None
}

async fn client_identity(http: &reqwest::Client) -> Result<ClientIdentity, String> {
    let html = http
        .get(TV_URL)
        .header(reqwest::header::USER_AGENT, TV_UA)
        .header(reqwest::header::REFERER, TV_URL)
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("could not load the YouTube TV page: {e}"))?
        .text()
        .await
        .map_err(|e| format!("could not read the YouTube TV page: {e}"))?;

    // <script id="base-js" src="...">
    let src = between(&html, "id=\"base-js\" src=\"", '"')
        .or_else(|| between(&html, "id='base-js' src='", '\''))
        .ok_or("the YouTube TV page no longer exposes a base-js script")?;

    let bundle_url = if src.starts_with("http") {
        src.to_string()
    } else {
        format!("https://www.youtube.com{src}")
    };

    let js = http
        .get(&bundle_url)
        .header(reqwest::header::USER_AGENT, TV_UA)
        .timeout(Duration::from_secs(90))
        .send()
        .await
        .map_err(|e| format!("could not load the TV app bundle: {e}"))?
        .text()
        .await
        .map_err(|e| format!("could not read the TV app bundle: {e}"))?;

    extract_client_identity(&js).ok_or_else(|| {
        "the TV app bundle no longer contains a recognisable OAuth client identity".to_string()
    })
}

/// Begin sign-in: returns the code the user types at the verification URL.
#[tauri::command]
pub async fn yt_oauth_start(state: State<'_, crate::AppState>) -> Result<DeviceCode, String> {
    let identity = client_identity(&state.http).await?;

    let body = serde_json::json!({
        "client_id": identity.client_id,
        "scope": SCOPE,
        "device_id": uuid_v4(),
        "device_model": DEVICE_MODEL,
    });

    let response = state
        .http
        .post(DEVICE_CODE_URL)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::USER_AGENT, TV_UA)
        .header(reqwest::header::REFERER, TV_URL)
        .timeout(Duration::from_secs(30))
        .body(serde_json::to_string(&body).map_err(|e| e.to_string())?)
        .send()
        .await
        .map_err(|e| format!("could not start sign-in: {e}"))?;

    let text = response
        .text()
        .await
        .map_err(|e| format!("could not read the sign-in response: {e}"))?;
    let json: Value =
        serde_json::from_str(&text).map_err(|_| format!("unexpected sign-in response: {text}"))?;

    if let Some(error) = json.get("error").and_then(|v| v.as_str()) {
        return Err(format!("YouTube refused to start sign-in: {error}"));
    }

    Ok(DeviceCode {
        device_code: json
            .get("device_code")
            .and_then(|v| v.as_str())
            .ok_or("no device code returned")?
            .to_string(),
        user_code: json
            .get("user_code")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        verification_url: json
            .get("verification_url")
            .and_then(|v| v.as_str())
            .unwrap_or("https://www.google.com/device")
            .to_string(),
        interval: json.get("interval").and_then(|v| v.as_u64()).unwrap_or(5),
        expires_in: json.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(1800),
        client_id: identity.client_id,
        client_secret: identity.client_secret,
    })
}

/// One poll of the token endpoint. The frontend drives the loop so it can show progress
/// and let the user give up, rather than blocking a command for half an hour.
#[tauri::command]
pub async fn yt_oauth_poll(
    state: State<'_, crate::AppState>,
    device_code: String,
    client_id: String,
    client_secret: String,
) -> Result<TokenResult, String> {
    let body = serde_json::json!({
        "client_id": client_id,
        "client_secret": client_secret,
        "code": device_code,
        "grant_type": DEVICE_GRANT,
    });

    let text = state
        .http
        .post(TOKEN_URL)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::USER_AGENT, TV_UA)
        .header(reqwest::header::REFERER, TV_URL)
        .timeout(Duration::from_secs(30))
        .body(serde_json::to_string(&body).map_err(|e| e.to_string())?)
        .send()
        .await
        .map_err(|e| format!("sign-in poll failed: {e}"))?
        .text()
        .await
        .map_err(|e| format!("sign-in poll unreadable: {e}"))?;

    let json: Value =
        serde_json::from_str(&text).map_err(|_| format!("unexpected poll response: {text}"))?;

    if let Some(error) = json.get("error").and_then(|v| v.as_str()) {
        let state_name = match error {
            "authorization_pending" => "pending",
            "slow_down" => "slow_down",
            "expired_token" => "expired",
            "access_denied" => "denied",
            _ => "error",
        };
        return Ok(TokenResult {
            state: state_name.to_string(),
            access_token: None,
            refresh_token: None,
            expires_at: None,
            error: Some(error.to_string()),
        });
    }

    let access_token = json
        .get("access_token")
        .and_then(|v| v.as_str())
        .map(String::from);
    let expires_in = json.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600);

    Ok(TokenResult {
        state: if access_token.is_some() { "authorized" } else { "pending" }.to_string(),
        access_token,
        refresh_token: json
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .map(String::from),
        expires_at: Some(now_unix() + expires_in),
        error: None,
    })
}

/// Exchange a refresh token for a new access token.
#[tauri::command]
pub async fn yt_oauth_refresh(
    state: State<'_, crate::AppState>,
    refresh_token: String,
    client_id: String,
    client_secret: String,
) -> Result<TokenResult, String> {
    let body = serde_json::json!({
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    });

    let text = state
        .http
        .post(TOKEN_URL)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::USER_AGENT, TV_UA)
        .timeout(Duration::from_secs(30))
        .body(serde_json::to_string(&body).map_err(|e| e.to_string())?)
        .send()
        .await
        .map_err(|e| format!("token refresh failed: {e}"))?
        .text()
        .await
        .map_err(|e| format!("token refresh unreadable: {e}"))?;

    let json: Value =
        serde_json::from_str(&text).map_err(|_| format!("unexpected refresh response: {text}"))?;

    if let Some(error) = json.get("error").and_then(|v| v.as_str()) {
        // invalid_grant means the user revoked access; the app must sign out.
        let state_name = if matches!(error, "invalid_grant" | "invalid_client" | "unauthorized_client") {
            "revoked"
        } else {
            "error"
        };
        return Ok(TokenResult {
            state: state_name.to_string(),
            access_token: None,
            refresh_token: None,
            expires_at: None,
            error: Some(error.to_string()),
        });
    }

    let expires_in = json.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600);
    Ok(TokenResult {
        state: "authorized".to_string(),
        access_token: json
            .get("access_token")
            .and_then(|v| v.as_str())
            .map(String::from),
        refresh_token: json
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .map(String::from),
        expires_at: Some(now_unix() + expires_in),
        error: None,
    })
}

/// Random UUID v4, so the device identity is not shared between installs.
fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    for chunk in bytes.chunks_mut(8) {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as u64 ^ d.as_secs())
            .unwrap_or(0)
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        for (i, b) in chunk.iter_mut().enumerate() {
            *b = ((n >> (i * 8)) & 0xff) as u8;
        }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

#[cfg(test)]
mod tests {
    use super::{extract_client_identity, uuid_v4};

    #[test]
    fn client_identity_is_extracted_from_a_bundle() {
        let js = r#"var x={clientId:"861556708454-abc.apps.googleusercontent.com",clientSecret:"SboVhoG9s0rNafixCSGGKXAT"};"#;
        let found = extract_client_identity(js).expect("should extract");
        assert_eq!(found.client_id, "861556708454-abc.apps.googleusercontent.com");
        assert_eq!(found.client_secret, "SboVhoG9s0rNafixCSGGKXAT");
    }

    #[test]
    fn minified_key_names_still_work() {
        // The secret's key is minified in the real bundle, so it must not be matched by name.
        let js = r#"a={clientId:"id-value",Aa:"secret-value"},b=1"#;
        let found = extract_client_identity(js).expect("should extract");
        assert_eq!(found.client_id, "id-value");
        assert_eq!(found.client_secret, "secret-value");
    }

    #[test]
    fn missing_identity_is_reported() {
        assert!(extract_client_identity("nothing to see here").is_none());
    }

    #[test]
    fn uuid_has_the_right_shape() {
        let id = uuid_v4();
        assert_eq!(id.len(), 36);
        assert_eq!(id.chars().filter(|c| *c == '-').count(), 4);
        assert_eq!(&id[14..15], "4");
    }
}
