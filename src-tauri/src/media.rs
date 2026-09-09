//! Media proxy served on a custom URI scheme.
//!
//! Why this exists: googlevideo sends `Access-Control-Allow-Origin` only for the
//! origin `https://www.youtube.com`. From the app's own origin there is no ACAO at
//! all, and an OPTIONS preflight answers 400. A `<video src>` does not care - media
//! elements are CORS-exempt unless you set `crossorigin` - but MSE does: shaka fetches
//! DASH segments with XHR/fetch, so adaptive playback would fail outright.
//!
//! Routing media through this process fixes three things at once:
//!   1. CORS, because this handler answers with `Access-Control-Allow-Origin: *`.
//!   2. IP binding. googlevideo URLs are tied to the client that requested the player
//!      response - which is this process, not the webview.
//!   3. Range requests survive intact, so seeking works.
//!
//! It is a proxy, not an open relay: only YouTube media hosts are reachable, and only
//! GET/HEAD.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::http::{Request, Response, StatusCode};
use tauri::{Manager, UriSchemeContext, UriSchemeResponder};
use tauri_plugin_http::reqwest;
use url::Url;

/// The scheme the frontend addresses. On Windows this resolves to
/// `http://playletmedia.localhost/...`.
pub const SCHEME: &str = "playletmedia";

/// Hosts this proxy will fetch from. Everything else is refused, so the handler
/// cannot be used as a general-purpose request forwarder.
fn host_allowed(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host.ends_with(".googlevideo.com")
        || host.ends_with(".ytimg.com")
        || host.ends_with(".ggpht.com")
        || host == "manifest.googlevideo.com"
        || host.ends_with(".youtube.com")
}

/// Headers worth forwarding upstream. `range` is handled separately - see `closed_range`.
const FORWARD_REQUEST_HEADERS: &[&str] = &["accept", "accept-encoding", "if-none-match", "if-modified-since"];

/// Slice returned when the caller did not ask for a bounded range.
const DEFAULT_CHUNK_BYTES: u64 = 2 * 1024 * 1024;

// There is no byte budget. An earlier version of this file assumed a 20MB cap,
// because that is where itag 137 happened to stop -- but the limit is ~60 SECONDS
// of media, so the byte offset it lands on scales with bitrate. At 144p it is
// about 1MB, at 4K about 40MB. A byte threshold is therefore wrong at every
// bitrate but one, and made the proxy re-request the player for every low-bitrate
// segment past the wall. `StreamUrlCache::capped` learns the boundary instead.
// See docs/STATE-AND-NEXT.md §3.

/// Normalise a Range header into a CLOSED byte range.
///
/// googlevideo answers **403** - not 200, not 416 - to any request for one of these
/// stream URLs that does not carry a bounded `bytes=start-end`. Both a missing Range
/// and an open-ended `bytes=0-` are rejected, which is measurable and reproducible:
///
///   bytes=0-219            -> 206
///   bytes=220-2421         -> 206
///   bytes=1000000-1200000  -> 206
///   bytes=0-               -> 403
///   (no Range header)      -> 403
///
/// So the proxy guarantees upstream always sees a closed range. Returning 206 with a
/// Content-Range is exactly what a media client expects; it simply asks for the next
/// slice, which is what shaka and the video element already do.
fn closed_range(incoming: Option<&str>) -> String {
    let raw = incoming.unwrap_or("").trim();

    if let Some(spec) = raw.strip_prefix("bytes=") {
        // Only the first range of a multi-range request is honoured; media clients
        // never send more than one, and forwarding several risks a multipart reply.
        let spec = spec.split(',').next().unwrap_or("").trim();
        if let Some((start, end)) = spec.split_once('-') {
            let start_value = start.trim().parse::<u64>().unwrap_or(0);
            let end_trimmed = end.trim();
            if !end_trimmed.is_empty() {
                if let Ok(end_value) = end_trimmed.parse::<u64>() {
                    if end_value >= start_value {
                        return format!("bytes={start_value}-{end_value}");
                    }
                }
            }
            // Open-ended "bytes=N-": bound it.
            return format!(
                "bytes={start_value}-{}",
                start_value.saturating_add(DEFAULT_CHUNK_BYTES).saturating_sub(1)
            );
        }
    }

    format!("bytes=0-{}", DEFAULT_CHUNK_BYTES - 1)
}

/// Headers worth returning to the webview.
const FORWARD_RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
    "expires",
    "last-modified",
    "etag",
];

fn error_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Pull the upstream URL out of the request.
///
/// The frontend encodes it as `?u=<percent-encoded absolute url>` rather than
/// splicing it into the path, so query strings and slashes survive untouched.
/// `v` carries the video id, which is what makes a stale URL recoverable.
fn target_url(request: &Request<Vec<u8>>) -> Option<(Url, Option<String>)> {
    let raw = request.uri().to_string();
    let parsed = Url::parse(&raw).ok()?;
    let encoded = parsed.query_pairs().find(|(k, _)| k == "u")?.1.into_owned();
    let video_id = parsed
        .query_pairs()
        .find(|(k, _)| k == "v")
        .map(|(_, v)| v.into_owned())
        .filter(|v| !v.is_empty());
    Some((Url::parse(&encoded).ok()?, video_id))
}

/// googlevideo stream URLs carry their own `itag`, so the format can be re-identified
/// in a fresh player response without the frontend telling us which one it wanted.
fn itag_of(url: &Url) -> Option<String> {
    url.query_pairs()
        .find(|(k, _)| k == "itag")
        .map(|(_, v)| v.into_owned())
}

/// Replacement URLs, keyed by "videoId/itag".
///
/// Concurrent segment requests all hit the byte limit at roughly the same moment, so
/// without this every one of them would mint its own player request.
pub struct StreamUrlCache {
    entries: Mutex<HashMap<String, (String, Instant)>>,
    /// Keys whose stream is known to be past the serve limit, so minting a fresh
    /// URL is pointless. Learned empirically -- see `mark_capped`.
    capped: Mutex<HashSet<String>>,
}

impl StreamUrlCache {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            capped: Mutex::new(HashSet::new()),
        }
    }

    fn is_capped(&self, key: &str) -> bool {
        self.capped.lock().unwrap().contains(key)
    }

    /// Record that a freshly minted URL was refused at this offset too, so later
    /// segments on the same stream skip the refresh entirely.
    fn mark_capped(&self, key: &str) {
        let mut capped = self.capped.lock().unwrap();
        if capped.len() > 64 {
            capped.clear();
        }
        capped.insert(key.to_string());
    }

    fn get(&self, key: &str) -> Option<String> {
        let entries = self.entries.lock().unwrap();
        entries.get(key).and_then(|(url, at)| {
            if at.elapsed() < REFRESH_TTL {
                Some(url.clone())
            } else {
                None
            }
        })
    }

    fn put(&self, key: String, url: String) {
        let mut entries = self.entries.lock().unwrap();
        if entries.len() > 64 {
            entries.clear();
        }
        entries.insert(key, (url, Instant::now()));
    }

    /// Drop a cached URL that has itself gone stale.
    fn invalidate(&self, key: &str) {
        self.entries.lock().unwrap().remove(key);
    }
}

/// A refreshed URL has the same ~60-second budget, so it is only reused briefly.
const REFRESH_TTL: Duration = Duration::from_secs(60);

pub fn handle<R: tauri::Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    // A preflight can still be issued by the webview; answer it here rather than
    // letting it travel upstream, where googlevideo would reject it.
    if request.method() == tauri::http::Method::OPTIONS {
        let response = Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
            .header("Access-Control-Allow-Headers", "range, accept, content-type")
            .header("Access-Control-Max-Age", "86400")
            .body(Vec::new())
            .unwrap_or_else(|_| Response::new(Vec::new()));
        responder.respond(response);
        return;
    }

    if request.method() != tauri::http::Method::GET && request.method() != tauri::http::Method::HEAD {
        responder.respond(error_response(StatusCode::METHOD_NOT_ALLOWED, "method not allowed"));
        return;
    }

    let Some((url, video_id)) = target_url(&request) else {
        responder.respond(error_response(StatusCode::BAD_REQUEST, "missing or invalid ?u= target"));
        return;
    };

    if url.scheme() != "https" {
        responder.respond(error_response(StatusCode::BAD_REQUEST, "only https targets are proxied"));
        return;
    }

    match url.host_str() {
        Some(host) if host_allowed(host) => {}
        _ => {
            responder.respond(error_response(StatusCode::FORBIDDEN, "host not proxyable"));
            return;
        }
    }

    // Copy what we need before moving into the async task.
    let mut forwarded: Vec<(String, String)> = Vec::new();
    for name in FORWARD_REQUEST_HEADERS {
        if let Some(value) = request.headers().get(*name) {
            if let Ok(value) = value.to_str() {
                forwarded.push(((*name).to_string(), value.to_string()));
            }
        }
    }

    let range = closed_range(
        request
            .headers()
            .get("range")
            .and_then(|value| value.to_str().ok()),
    );
    forwarded.push(("range".to_string(), range));

    let is_head = request.method() == tauri::http::Method::HEAD;

    let app = ctx.app_handle().clone();
    let http: reqwest::Client = app.state::<crate::AppState>().http.clone();

    tauri::async_runtime::spawn(async move {
        let state = app.state::<crate::AppState>();
        let method = if is_head {
            reqwest::Method::HEAD
        } else {
            reqwest::Method::GET
        };

        let fetch = |target: Url| {
            let mut builder = http.request(method.clone(), target);
            for (name, value) in forwarded.clone() {
                builder = builder.header(name, value);
            }
            builder.send()
        };

        // If a replacement URL for this format was already minted, prefer it: the
        // original is, by definition, out of budget.
        let cache_key = video_id
            .as_deref()
            .zip(itag_of(&url))
            .map(|(video, itag)| format!("{video}/{itag}"));
        let first_target = cache_key
            .as_deref()
            .and_then(|key| state.stream_urls.get(key))
            .and_then(|cached| Url::parse(&cached).ok())
            .unwrap_or_else(|| url.clone());

        let mut upstream = match fetch(first_target.clone()).await {
            Ok(response) => response,
            Err(err) => {
                responder.respond(error_response(
                    StatusCode::BAD_GATEWAY,
                    &format!("upstream request failed: {err}"),
                ));
                return;
            }
        };

        // A 403 has two distinct causes, and only one of them is recoverable:
        //
        //   * The URL expired (they last a few hours). A fresh URL fixes it.
        //   * The read is past the ~60-second serve limit. Measured: a brand new
        //     URL is ALSO 403 at that offset, while the same new URL serves 0-2MB
        //     fine. Re-requesting the player there is pure waste, so don't.
        //
        // We cannot tell these apart from the byte offset -- 60 seconds is ~1MB at
        // 144p and ~40MB at 4K. So try the refresh once, and if the fresh URL is
        // refused at the same offset, remember that and stop trying for this stream.
        let past_cap = cache_key
            .as_deref()
            .is_some_and(|key| state.stream_urls.is_capped(key));

        if upstream.status().as_u16() == 403 && !past_cap {
            if let Some(key) = cache_key.as_deref() {
                state.stream_urls.invalidate(key);
            }
            if let Some(fresh) = refresh_stream_url(&state, &url, video_id.as_deref()).await {
                if let Ok(parsed) = Url::parse(&fresh) {
                    if let Ok(retry) = fetch(parsed).await {
                        if retry.status().is_success() {
                            if let Some(key) = cache_key {
                                state.stream_urls.put(key, fresh);
                            }
                        } else if retry.status().as_u16() == 403 {
                            // A brand new URL refused at the same offset: this is
                            // the serve limit, not expiry. Don't refresh again.
                            if let Some(key) = cache_key.as_deref() {
                                state.stream_urls.mark_capped(key);
                            }
                        }
                        upstream = retry;
                    }
                }
            }
        }

        let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);

        let mut builder = Response::builder()
            .status(status)
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Expose-Headers", "content-length, content-range, accept-ranges");

        for name in FORWARD_RESPONSE_HEADERS {
            if let Some(value) = upstream.headers().get(*name) {
                if let Ok(value) = value.to_str() {
                    builder = builder.header(*name, value);
                }
            }
        }

        // Media segments are a few MB; a full read keeps the handler simple and is
        // well within budget. The manifest never points at a whole-file URL.
        let body = match upstream.bytes().await {
            Ok(bytes) => bytes.to_vec(),
            Err(err) => {
                responder.respond(error_response(
                    StatusCode::BAD_GATEWAY,
                    &format!("upstream read failed: {err}"),
                ));
                return;
            }
        };

        let response = builder
            .body(body)
            .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "failed to build response"));
        responder.respond(response);
    });
}

/// Mint a replacement stream URL for the same itag.
///
/// Returns None when the video id is unknown (nothing to re-request), when the player
/// refuses, or when the fresh response has no matching format - in which case the
/// caller surfaces the original 403 rather than pretending to recover.
async fn refresh_stream_url(
    state: &tauri::State<'_, crate::AppState>,
    stale: &Url,
    video_id: Option<&str>,
) -> Option<String> {
    let video_id = video_id?;
    let itag = itag_of(stale)?;

    // VISIONOS first, and no `ios` at all. A refreshed IOS URL is capped at 60
    // seconds of media, so swapping one in mid-playback replaces a working stream
    // with a broken one - the stall looks like a player bug rather than a refresh
    // bug, which is exactly how it hid.
    for client in ["visionos", "android_vr", "tv"] {
        let Ok(player) = crate::innertube::player_response(state, video_id, client).await else {
            continue;
        };
        if let Some(url) = crate::innertube::stream_url_for_itag(&player, &itag) {
            return Some(url);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{closed_range, StreamUrlCache};

    #[test]
    fn closed_ranges_pass_through() {
        assert_eq!(closed_range(Some("bytes=0-219")), "bytes=0-219");
        assert_eq!(closed_range(Some("bytes=220-2421")), "bytes=220-2421");
    }

    #[test]
    fn open_ended_and_missing_ranges_are_bounded() {
        // Both of these are answered with 403 by googlevideo if passed through as-is.
        assert_eq!(closed_range(Some("bytes=0-")), "bytes=0-2097151");
        assert_eq!(closed_range(None), "bytes=0-2097151");
        assert_eq!(closed_range(Some("bytes=1000-")), "bytes=1000-2098151");
    }

    #[test]
    fn malformed_ranges_fall_back_to_a_valid_slice() {
        assert_eq!(closed_range(Some("")), "bytes=0-2097151");
        assert_eq!(closed_range(Some("garbage")), "bytes=0-2097151");
        assert_eq!(closed_range(Some("bytes=abc-def")), "bytes=0-2097151");
        // end < start is nonsense; bound from the start offset instead.
        assert_eq!(closed_range(Some("bytes=500-100")), "bytes=500-2097651");
    }

    #[test]
    fn only_the_first_range_of_a_multi_range_request_is_used() {
        assert_eq!(closed_range(Some("bytes=0-99,200-299")), "bytes=0-99");
    }
    #[test]
    fn capped_streams_are_remembered_so_the_url_is_not_refreshed_again() {
        let cache = StreamUrlCache::new();
        assert!(!cache.is_capped("vid:137"));

        cache.mark_capped("vid:137");
        assert!(cache.is_capped("vid:137"));
        // The verdict is per stream, not global: another format is unaffected.
        assert!(!cache.is_capped("vid:140"));
    }
}
