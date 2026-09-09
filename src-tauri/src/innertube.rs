//! Direct YouTube (InnerTube) transport.
//!
//! This is the "Playlet" backend, mirroring what the upstream Roku app does: talk to
//! YouTube's own private API and hand the renderer something Invidious-shaped, so the
//! app does not depend on the public Invidious network (which, as of this build, has
//! largely stopped serving video).
//!
//! Why this lives in Rust rather than the webview:
//!   * InnerTube requires per-client `User-Agent` and `X-YouTube-Client-*` headers.
//!     The generic `api_fetch` command deliberately refuses to let the renderer set
//!     those, and that restriction is worth keeping.
//!   * The client identity (version, visitor id) is shared state that needs
//!     refreshing on a timer, not per-request work in the UI.
//!
//! Client choice is not arbitrary - it was measured against the live API:
//!   * VISIONOS returns direct, unciphered stream URLs with no `n` parameter, no
//!     PoToken requirement, and - critically - no 60-second serve limit. It handles
//!     playback. This is also what yt-dlp uses by default.
//!   * IOS also returns direct URLs but YouTube stops serving it after exactly
//!     60.000 seconds of media, so it is a fallback only. TVHTML5 and ANDROID_VR
//!     answer LOGIN_REQUIRED; WEB answers UNPLAYABLE without a PoToken.
//!   * IOS/VISIONOS search/browse returns opaque `elementRenderer` blobs, so WEB
//!     handles search, browse and recommendations, where classic renderers remain.
//!
//! VISIONOS has exactly one extra requirement, measured by elimination:
//!   * `X-Goog-Visitor-Id` must carry the scraped visitor id. Without it the player
//!     answers LOGIN_REQUIRED ("Sign in to confirm you're not a bot"), with or
//!     without cookies.
//! Not required, despite appearances while working this out: `signatureTimestamp`
//! (no format is ciphered, so there is nothing to time-stamp) and the consent
//! cookies. The cookies are still sent because they cost nothing and keep the
//! identity scrape clear of consent interstitials.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use tauri_plugin_http::reqwest;

const YOUTUBE_ORIGIN: &str = "https://www.youtube.com";
const INNERTUBE_BASE: &str = "https://www.youtube.com/youtubei/v1/";

const WEB_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                      (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const IOS_UA: &str = "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)";
const VISIONOS_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 \
                           (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

/// Used only until the real version is scraped from the YouTube home page.
const WEB_VERSION_FALLBACK: &str = "2.20260907.06.00";
const IOS_VERSION: &str = "20.10.4";
const VISIONOS_VERSION: &str = "1.02";

/// Consent and preference cookies, as yt-dlp seeds them. Measured as NOT required
/// for the player call, but they keep the identity scrape from landing on a consent
/// interstitial in regions that serve one, and they cost nothing.
const CONSENT_COOKIES: &str = "SOCS=CAI; PREF=hl=en&tz=UTC";

/// The scraped identity goes stale; YouTube ships a new web build most days.
const IDENTITY_TTL: Duration = Duration::from_secs(6 * 60 * 60);

/// How long a *failed* identity scrape is allowed to stick around.
///
/// `fetch_identity` cannot fail loudly - it falls back to a hardcoded web version and
/// `visitor_data: None` - so a single transient network blip at startup used to be
/// cached like a good identity for the full six hours. Without the visitor id every
/// playback client answers `LOGIN_REQUIRED - Sign in to confirm you're not a bot`, so
/// the app looked permanently broken while browsing kept working. Retry these quickly
/// instead, but not on literally every request, so an offline machine does not refetch
/// the home page once per call.
const IDENTITY_RETRY_TTL: Duration = Duration::from_secs(60);

const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

/// Endpoints the renderer is allowed to reach. Anything else is refused, so a
/// compromised renderer cannot use this command as a general YouTube API client.
const ALLOWED_ENDPOINTS: &[&str] = &["player", "search", "browse", "next", "resolve_url"];

#[derive(Clone, Debug)]
struct Identity {
    web_version: String,
    visitor_data: Option<String>,
    fetched_at: Instant,
}

pub struct InnertubeState {
    identity: Mutex<Option<Identity>>,
}

impl InnertubeState {
    pub fn new() -> Self {
        Self {
            identity: Mutex::new(None),
        }
    }

    fn cached(&self) -> Option<Identity> {
        let guard = self.identity.lock().unwrap();
        match guard.as_ref() {
            // An identity with no visitor id is a failed scrape, not a usable identity.
            // Expire it fast so the next call retries rather than serving six hours of
            // LOGIN_REQUIRED.
            Some(id) => {
                let ttl = if id.visitor_data.is_some() {
                    IDENTITY_TTL
                } else {
                    IDENTITY_RETRY_TTL
                };
                if id.fetched_at.elapsed() < ttl {
                    Some(id.clone())
                } else {
                    None
                }
            }
            None => None,
        }
    }

    fn store(&self, identity: Identity) {
        *self.identity.lock().unwrap() = Some(identity);
    }
}

/// Pull the current web client version and visitor id out of the YouTube home page.
///
/// A stale `clientVersion` is not cosmetic: browse calls start answering HTTP 400
/// once it drifts far enough from what YouTube is serving.
async fn fetch_identity(http: &reqwest::Client) -> Identity {
    let mut web_version = WEB_VERSION_FALLBACK.to_string();
    let mut visitor_data = None;

    let response = http
        .get(YOUTUBE_ORIGIN)
        .header(reqwest::header::USER_AGENT, WEB_UA)
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
        .header(reqwest::header::COOKIE, CONSENT_COOKIES)
        .timeout(Duration::from_secs(15))
        .send()
        .await;

    if let Ok(response) = response {
        if let Ok(body) = response.text().await {
            if let Some(found) = extract_between(&body, "\"INNERTUBE_CLIENT_VERSION\":\"", '"') {
                web_version = found;
            }
            visitor_data = extract_between(&body, "\"visitorData\":\"", '"');
        }
    }

    Identity {
        web_version,
        visitor_data,
        fetched_at: Instant::now(),
    }
}

/// Minimal scraper: the value between a literal marker and the next terminator.
fn extract_between(haystack: &str, marker: &str, terminator: char) -> Option<String> {
    let start = haystack.find(marker)? + marker.len();
    let rest = &haystack[start..];
    let end = rest.find(terminator)?;
    let value = &rest[..end];
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

async fn identity(state: &InnertubeState, http: &reqwest::Client) -> Identity {
    if let Some(cached) = state.cached() {
        return cached;
    }
    let fresh = fetch_identity(http).await;
    state.store(fresh.clone());
    fresh
}

fn web_context(identity: &Identity) -> Value {
    let mut client = json!({
        "clientName": "WEB",
        "clientVersion": identity.web_version,
        "hl": "en",
        "gl": "US",
    });
    if let Some(visitor) = &identity.visitor_data {
        client["visitorData"] = json!(visitor);
    }
    json!({ "client": client })
}

/// A client identity: the context YouTube is given, plus the matching transport headers.
///
/// More than one is kept on purpose. YouTube tightens clients at different times -
/// TVHTML5 and ANDROID_VR both answer LOGIN_REQUIRED from a desktop IP as of this
/// build, while IOS answers OK - so the frontend walks a ladder rather than depending
/// on any single identity remaining open.
struct ClientProfile {
    context: Value,
    ua: &'static str,
    header_name: &'static str,
    header_version: String,
    /// Whether the scraped visitor id should be sent as `X-Goog-Visitor-Id`.
    /// True for the web family and for VISIONOS, which requires it.
    send_visitor_id: bool,
}

/// The ONE place an InnerTube request is built.
///
/// There used to be two of these - `yt_innertube` and `player_response` - and they
/// drifted: the second never sent `X-Goog-Visitor-Id`, so VISIONOS answered
/// LOGIN_REQUIRED there, every mid-playback URL refresh fell through to a capped
/// client, and playback froze about twenty seconds in. Nothing caught it because
/// both paths looked correct in isolation. Keep it single.
fn innertube_request(
    state: &crate::AppState,
    endpoint: &str,
    profile: &ClientProfile,
    identity: &Identity,
    payload: String,
) -> reqwest::RequestBuilder {
    let mut request = state
        .http
        .post(format!("{INNERTUBE_BASE}{endpoint}"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::USER_AGENT, profile.ua)
        .header(reqwest::header::ORIGIN, YOUTUBE_ORIGIN)
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
        .header(reqwest::header::COOKIE, CONSENT_COOKIES)
        .header("X-YouTube-Client-Name", profile.header_name)
        .header("X-YouTube-Client-Version", profile.header_version.clone())
        .timeout(Duration::from_secs(30))
        .body(payload);

    // Required by VISIONOS, used by the web family, and never sent alongside an
    // account token (the token and the visitor id are two different identities).
    if profile.send_visitor_id {
        if let Some(visitor) = &identity.visitor_data {
            request = request.header("X-Goog-Visitor-Id", visitor);
        }
    }

    request
}

fn profile_for(name: &str, identity: &Identity) -> ClientProfile {
    match name {
        // Apple Vision Pro. Direct URLs, no cipher, no `n`, no PoToken, and no
        // 60-second serve limit - the only client measured to stream a whole video.
        // Requires X-Goog-Visitor-Id (send_visitor_id below) or it answers
        // LOGIN_REQUIRED.
        "visionos" => ClientProfile {
            context: json!({
                "client": {
                    "clientName": "VISIONOS",
                    "clientVersion": VISIONOS_VERSION,
                    "deviceMake": "Apple",
                    "deviceModel": "RealityDevice17,1",
                    "userAgent": VISIONOS_UA,
                    "osName": "visionOS",
                    "osVersion": "26.5.23O471",
                    "hl": "en",
                    "gl": "US",
                }
            }),
            ua: VISIONOS_UA,
            header_name: "101",
            header_version: VISIONOS_VERSION.to_string(),
            send_visitor_id: true,
        },
        "ios" => ClientProfile {
            context: json!({
                "client": {
                    "clientName": "IOS",
                    "clientVersion": IOS_VERSION,
                    "deviceMake": "Apple",
                    "deviceModel": "iPhone16,2",
                    "osName": "iPhone",
                    "osVersion": "18.3.2.22D82",
                    "hl": "en",
                    "gl": "US",
                }
            }),
            ua: IOS_UA,
            header_name: "5",
            header_version: IOS_VERSION.to_string(),
            send_visitor_id: false,
        },
        "android_vr" => ClientProfile {
            context: json!({
                "client": {
                    "clientName": "ANDROID_VR",
                    "clientVersion": "1.61.48",
                    "deviceMake": "Oculus",
                    "deviceModel": "Quest 3",
                    "osName": "Android",
                    "osVersion": "12",
                    "androidSdkVersion": 32,
                    "hl": "en",
                    "gl": "US",
                }
            }),
            ua: "com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12; GB) gzip",
            header_name: "28",
            header_version: "1.61.48".to_string(),
            send_visitor_id: false,
        },
        // The client the upstream Roku app uses. Kept in the ladder so it is picked up
        // automatically if it opens back up on a given network.
        "tv" => ClientProfile {
            context: json!({
                "client": {
                    "clientName": "TVHTML5",
                    "clientVersion": "7.20250101.10.00",
                    "hl": "en",
                    "gl": "US",
                }
            }),
            ua: "Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 \
                 (KHTML, like Gecko) Version/16.0 Safari/605.1.15",
            header_name: "7",
            header_version: "7.20250101.10.00".to_string(),
            send_visitor_id: false,
        },
        "web_embedded" => ClientProfile {
            context: json!({
                "client": {
                    "clientName": "WEB_EMBEDDED_PLAYER",
                    "clientVersion": "1.20260907.00.00",
                    "hl": "en",
                    "gl": "US",
                },
                "thirdParty": { "embedUrl": "https://www.youtube.com" }
            }),
            ua: WEB_UA,
            header_name: "56",
            header_version: "1.20260907.00.00".to_string(),
            send_visitor_id: true,
        },
        _ => ClientProfile {
            context: web_context(identity),
            ua: WEB_UA,
            header_name: "1",
            header_version: identity.web_version.clone(),
            send_visitor_id: true,
        },
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InnertubeRequest {
    /// One of ALLOWED_ENDPOINTS.
    pub endpoint: String,
    /// "ios" for playback, "web" for everything else.
    #[serde(default)]
    pub client: Option<String>,
    /// Endpoint-specific fields (videoId, query, browseId, params, continuation...).
    #[serde(default)]
    pub payload: Option<Value>,
    /// A YouTube TV access token, when the user has signed in.
    ///
    /// This is what makes TVHTML5 usable: signed out it answers LOGIN_REQUIRED or
    /// "The page needs to be reloaded" no matter what else is sent.
    #[serde(default)]
    pub access_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InnertubeResponse {
    pub status: u16,
    pub ok: bool,
    pub body: String,
    pub elapsed_ms: u64,
    /// Echoed so the frontend can surface which client answered when debugging.
    pub client: String,
}

#[tauri::command]
pub async fn yt_innertube(
    state: State<'_, crate::AppState>,
    req: InnertubeRequest,
) -> Result<InnertubeResponse, String> {
    let endpoint = req.endpoint.trim().to_ascii_lowercase();
    if !ALLOWED_ENDPOINTS.contains(&endpoint.as_str()) {
        return Err(format!("endpoint not allowed: {endpoint}"));
    }

    let identity = identity(&state.innertube, &state.http).await;
    let client_key = req.client.as_deref().unwrap_or("web").to_ascii_lowercase();
    let mut profile = profile_for(&client_key, &identity);

    // Upstream Playlet sends the visitor id only when it is NOT using an access token
    // (`useAccessToken` in PlayerEndpoint.bs). Sending both looks like two different
    // identities for one request, so follow the same rule.
    let authenticated = req
        .access_token
        .as_deref()
        .is_some_and(|token| !token.is_empty());
    if authenticated {
        if let Some(client) = profile.context.get_mut("client") {
            if let Some(map) = client.as_object_mut() {
                map.remove("visitorData");
            }
        }
        profile.send_visitor_id = false;
    }

    let mut body = match req.payload {
        Some(Value::Object(map)) => Value::Object(map),
        _ => json!({}),
    };
    body["context"] = profile.context.clone();

    // The re-exported reqwest is built without the `json` feature, so serialize here.
    let payload = serde_json::to_string(&body).map_err(|e| format!("bad payload: {e}"))?;

    let mut request = innertube_request(&state, &endpoint, &profile, &identity, payload);

    if let Some(token) = req.access_token.as_deref().filter(|t| !t.is_empty()) {
        request = request.header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
    }

    let started = Instant::now();
    let mut response = request
        .send()
        .await
        .map_err(|e| format!("innertube request failed: {e}"))?;

    let status = response.status();

    // Channel browse responses run to several megabytes, so read with a cap rather
    // than trusting the payload to be small.
    let mut buf: Vec<u8> = Vec::with_capacity(128 * 1024);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("innertube read failed: {e}"))?
    {
        if buf.len() + chunk.len() > MAX_BODY_BYTES {
            return Err("innertube response too large".into());
        }
        buf.extend_from_slice(&chunk);
    }

    Ok(InnertubeResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        body: String::from_utf8_lossy(&buf).into_owned(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        client: client_key,
    })
}

/// Fetch a player response for one video, for internal callers.
///
/// The media proxy uses this to mint a replacement stream URL when googlevideo
/// retires the current one; see `media::refresh_stream_url`.
pub async fn player_response(
    state: &crate::AppState,
    video_id: &str,
    client: &str,
) -> Result<Value, String> {
    let identity = identity(&state.innertube, &state.http).await;
    let profile = profile_for(client, &identity);

    let body = json!({
        "context": profile.context,
        "videoId": video_id,
        "contentCheckOk": true,
        "racyCheckOk": true,
    });
    let payload = serde_json::to_string(&body).map_err(|e| format!("bad payload: {e}"))?;

    let response = innertube_request(state, "player", &profile, &identity, payload)
        .send()
        .await
        .map_err(|e| format!("player request failed: {e}"))?;

    let text = response
        .text()
        .await
        .map_err(|e| format!("player read failed: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("player parse failed: {e}"))
}

/// Pull the stream URL for one itag out of a player response.
pub fn stream_url_for_itag(player: &Value, itag: &str) -> Option<String> {
    let streaming = player.get("streamingData")?;
    for key in ["adaptiveFormats", "formats"] {
        if let Some(list) = streaming.get(key).and_then(|v| v.as_array()) {
            for format in list {
                let matches = format
                    .get("itag")
                    .map(|v| match v {
                        Value::Number(n) => n.to_string() == itag,
                        Value::String(s) => s == itag,
                        _ => false,
                    })
                    .unwrap_or(false);
                if matches {
                    if let Some(url) = format.get("url").and_then(|v| v.as_str()) {
                        return Some(url.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Force a refresh of the scraped client identity. Useful when browse starts
/// returning 400, which is the symptom of a stale client version.
#[tauri::command]
pub async fn yt_refresh_identity(state: State<'_, crate::AppState>) -> Result<String, String> {
    let fresh = fetch_identity(&state.http).await;
    let version = fresh.web_version.clone();
    state.innertube.store(fresh);
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity_with_visitor() -> Identity {
        Identity {
            web_version: "2.20260907.06.00".to_string(),
            visitor_data: Some("VISITOR_DATA_FIXTURE".to_string()),
            fetched_at: Instant::now(),
        }
    }

    /// VISIONOS answers LOGIN_REQUIRED without `X-Goog-Visitor-Id`. This is the
    /// header whose absence in the second (now deleted) request builder froze
    /// playback ~20 seconds in, so assert the profile demands it.
    #[test]
    fn visionos_requires_the_visitor_id() {
        let profile = profile_for("visionos", &identity_with_visitor());
        assert!(profile.send_visitor_id, "VISIONOS must send X-Goog-Visitor-Id");
        assert_eq!(profile.header_name, "101");
        assert_eq!(profile.context["client"]["clientName"], "VISIONOS");
    }

    /// The player ladder must never fall back to a client that half-works. IOS
    /// answers OK and hands over direct URLs, then stops serving at 60s - which
    /// reads as a player bug, not a client bug. See media::refresh_stream_url.
    #[test]
    fn ios_is_not_a_silent_fallback() {
        // The profile still exists (useful for diagnostics) but callers that pick
        // a replacement client must not reach for it.
        let source = include_str!("media.rs");
        let ladder_line = source
            .lines()
            .find(|l| l.contains("for client in ["))
            .expect("refresh_stream_url ladder not found");
        assert!(
            ladder_line.contains("visionos"),
            "URL refresh must try visionos: {ladder_line}"
        );
        assert!(
            !ladder_line.contains("\"ios\""),
            "URL refresh must not fall back to the 60s-capped ios client: {ladder_line}"
        );
    }

    /// A failed scrape must not be cached like a good identity.
    ///
    /// `fetch_identity` cannot fail loudly - it falls back to `visitor_data: None` -
    /// and that used to be cached for the full six hours. Without the visitor id every
    /// playback client answers LOGIN_REQUIRED, so one network blip at startup broke
    /// playback for the rest of the day while browsing carried on working.
    #[test]
    fn a_visitorless_identity_is_not_cached_for_the_full_ttl() {
        let state = InnertubeState::new();

        // A good identity, scraped just now, is served from cache.
        state.store(Identity {
            web_version: "2.0".to_string(),
            visitor_data: Some("VISITOR".to_string()),
            fetched_at: Instant::now(),
        });
        assert!(state.cached().is_some(), "a fresh good identity should be cached");

        // A failed scrape older than the retry window must NOT be served.
        state.store(Identity {
            web_version: "2.0".to_string(),
            visitor_data: None,
            fetched_at: Instant::now() - (IDENTITY_RETRY_TTL + Duration::from_secs(1)),
        });
        assert!(
            state.cached().is_none(),
            "a visitor-less identity must expire after IDENTITY_RETRY_TTL so the next call re-scrapes"
        );

        // A good identity that old is still perfectly valid.
        state.store(Identity {
            web_version: "2.0".to_string(),
            visitor_data: Some("VISITOR".to_string()),
            fetched_at: Instant::now() - (IDENTITY_RETRY_TTL + Duration::from_secs(1)),
        });
        assert!(
            state.cached().is_some(),
            "the short retry window must apply only to failed scrapes"
        );
    }

    #[test]
    fn visionos_without_a_visitor_id_sends_no_header() {
        // Guards the actual failure mode: the header is attached only when the scrape
        // produced something, and its absence is exactly what YouTube rejects.
        let empty = Identity {
            web_version: "2.0".to_string(),
            visitor_data: None,
            fetched_at: Instant::now(),
        };
        let profile = profile_for("visionos", &empty);
        assert!(profile.send_visitor_id, "policy stays on even with nothing to send");
        assert!(
            empty.visitor_data.is_none(),
            "and with no visitor id there is no header - the request YouTube refuses"
        );
    }

    /// Every web-family client carries the scraped visitor id; the mobile-app
    /// clients do not, because they authenticate differently.
    #[test]
    fn visitor_id_policy_per_client() {
        let id = identity_with_visitor();
        for client in ["web", "web_embedded", "visionos"] {
            assert!(
                profile_for(client, &id).send_visitor_id,
                "{client} should send the visitor id"
            );
        }
        for client in ["ios", "android_vr", "tv"] {
            assert!(
                !profile_for(client, &id).send_visitor_id,
                "{client} should not send the visitor id"
            );
        }
    }
}
