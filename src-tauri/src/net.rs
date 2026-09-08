//! The ONLY network egress path the webview can reach.
//!
//! Why this exists instead of `import { fetch } from '@tauri-apps/plugin-http'`:
//! the plugin's allowlist ("scope") is baked into the binary at build time. An
//! app that talks to *arbitrary user-chosen Invidious instances* can only express
//! that as `https://*`, which hands the renderer an unrestricted, CORS-free HTTP
//! client. Invidious video descriptions and comments are attacker-controlled
//! HTML; one XSS and that scope is an SSRF + exfiltration primitive.
//!
//! Here the allowlist is RUNTIME state: fixed infrastructure hosts (SponsorBlock,
//! googlevideo, ytimg) plus whatever instances the user actually configured.
//! Adding an instance needs no rebuild, and nothing else on the internet is
//! reachable from the renderer.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_plugin_http::reqwest;
use url::{Host, Url};

pub type HttpClient = reqwest::Client;

/// Hosts that are always reachable regardless of which instance the user picked.
pub const FIXED_HOSTS: &[&str] = &[
    "sponsor.ajay.app",
    "api.sponsor.ajay.app",
    "sponsorblock.inf.re",
    "dearrow.ajay.app",
    "returnyoutubedislikeapi.com",
    "api.invidious.io", // public instance directory
    "www.youtube.com",
    "youtube.com",
    "m.youtube.com",
    "i.ytimg.com",
];

/// Suffix matches, always reachable. googlevideo hosts are randomized per session
/// (rr3---sn-xxxx.googlevideo.com) so only a suffix rule can work.
pub const FIXED_SUFFIXES: &[&str] = &[
    ".googlevideo.com",
    ".ytimg.com",
    ".ggpht.com",
    ".youtube.com",
    ".sponsor.ajay.app",
];

/// Request headers the renderer is allowed to set. Deliberately excludes
/// cookie / authorization / origin -- credentials are attached here, not there.
const ALLOWED_REQ_HEADERS: &[&str] = &[
    "accept",
    "accept-language",
    "content-type",
    "range",
    "if-none-match",
    "if-modified-since",
];

const MAX_BODY_BYTES: usize = 24 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 15_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
const UA: &str = concat!("PlayletDesktop/", env!("CARGO_PKG_VERSION"), " (Windows)");

pub fn build_client() -> HttpClient {
    reqwest::Client::builder()
        .user_agent(UA)
        .connect_timeout(Duration::from_secs(8))
        .pool_idle_timeout(Duration::from_secs(30))
        // Invidious instances redirect a lot (/latest_version -> googlevideo).
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .expect("failed to build http client")
}

// ---------------------------------------------------------------- allowlist

pub struct HostAllowlist {
    user: Mutex<HashSet<String>>,
}

impl HostAllowlist {
    pub fn new() -> Self {
        Self {
            user: Mutex::new(HashSet::new()),
        }
    }

    pub fn replace(&self, hosts: impl IntoIterator<Item = String>) {
        let set: HashSet<String> = hosts
            .into_iter()
            .filter_map(|h| normalize_host(&h))
            .collect();
        *self.user.lock().unwrap() = set;
    }

    /// Accepts either ["https://yewtu.be", ...] or [{"url": "https://yewtu.be"}, ...]
    pub fn replace_from_json(&self, v: &serde_json::Value) {
        let mut out = Vec::new();
        if let Some(arr) = v.as_array() {
            for item in arr {
                if let Some(s) = item.as_str() {
                    out.push(s.to_string());
                } else if let Some(s) = item.get("url").and_then(|u| u.as_str()) {
                    out.push(s.to_string());
                }
            }
        }
        self.replace(out);
    }

    pub fn snapshot(&self) -> Vec<String> {
        let mut v: Vec<String> = self.user.lock().unwrap().iter().cloned().collect();
        v.sort();
        v
    }

    pub fn is_user_host(&self, host: &str) -> bool {
        self.user.lock().unwrap().contains(host)
    }
}

/// "https://yewtu.be/feed/x" | "yewtu.be" | "YEWTU.BE:443" -> Some("yewtu.be")
fn normalize_host(input: &str) -> Option<String> {
    let s = input.trim();
    if s.is_empty() {
        return None;
    }
    let with_scheme = if s.contains("://") {
        s.to_string()
    } else {
        format!("https://{s}")
    };
    Url::parse(&with_scheme)
        .ok()?
        .host_str()
        .map(|h| h.to_ascii_lowercase())
}

fn is_fixed(host: &str) -> bool {
    FIXED_HOSTS.contains(&host) || FIXED_SUFFIXES.iter().any(|s| host.ends_with(s))
}

fn is_private_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified()
        }
        IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified(),
    }
}

/// Validate + authorize. Returns the parsed URL or a user-presentable reason.
fn authorize(url: &str, allow: &HostAllowlist) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|_| format!("invalid url: {url}"))?;

    match parsed.scheme() {
        // http is only tolerated for a self-hosted instance the user explicitly
        // added; see the check further down.
        "https" | "http" => {}
        other => return Err(format!("blocked scheme: {other}")),
    }

    let host_str = parsed
        .host_str()
        .ok_or_else(|| "url has no host".to_string())?
        .to_ascii_lowercase();

    // Cloud metadata / obvious SSRF targets: never, not even if the user asks.
    if host_str == "169.254.169.254" || host_str == "metadata.google.internal" {
        return Err("blocked host".into());
    }

    let user_allowed = allow.is_user_host(&host_str);

    // A private/loopback address is reachable ONLY if the user explicitly added it
    // (self-hosted Invidious on a LAN is a legitimate, common setup).
    if matches!(parsed.host(), Some(Host::Ipv4(_)) | Some(Host::Ipv6(_))) {
        let bare = host_str.trim_start_matches('[').trim_end_matches(']');
        if let Ok(ip) = bare.parse::<IpAddr>() {
            if is_private_ip(&ip) && !user_allowed {
                return Err(format!("blocked private address: {host_str}"));
            }
        }
    }
    if (host_str == "localhost" || host_str.ends_with(".localhost")) && !user_allowed {
        return Err("blocked localhost".into());
    }

    if parsed.scheme() == "http" && !user_allowed {
        return Err(format!(
            "plain http is only allowed for instances you added: {host_str}"
        ));
    }

    if user_allowed || is_fixed(&host_str) {
        Ok(parsed)
    } else {
        Err(format!(
            "host not allowed: {host_str} (add it as an instance in Settings first)"
        ))
    }
}

// ---------------------------------------------------------------- commands

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRequest {
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse {
    pub status: u16,
    pub ok: bool,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub body: String,
    pub elapsed_ms: u64,
}

#[tauri::command]
pub async fn api_fetch(
    state: State<'_, crate::AppState>,
    req: ApiRequest,
) -> Result<ApiResponse, String> {
    let url = authorize(&req.url, &state.allow)?;

    let method = match req
        .method
        .as_deref()
        .unwrap_or("GET")
        .to_ascii_uppercase()
        .as_str()
    {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "HEAD" => reqwest::Method::HEAD,
        other => return Err(format!("method not allowed: {other}")),
    };

    let timeout = Duration::from_millis(
        req.timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .min(MAX_TIMEOUT_MS),
    );

    let mut rb = state.http.request(method, url).timeout(timeout);

    if let Some(h) = req.headers {
        for (k, v) in h {
            let lk = k.to_ascii_lowercase();
            if ALLOWED_REQ_HEADERS.contains(&lk.as_str()) {
                rb = rb.header(lk, v);
            }
        }
    }
    if let Some(b) = req.body {
        rb = rb.body(b);
    }

    let started = Instant::now();
    let mut resp = rb.send().await.map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status();
    let final_url = resp.url().to_string();

    let mut headers = HashMap::new();
    for (k, v) in resp.headers().iter() {
        if let Ok(s) = v.to_str() {
            headers.insert(k.as_str().to_ascii_lowercase(), s.to_string());
        }
    }

    // Streamed read with a hard cap -- an unbounded .bytes() on a proxied video
    // URL will happily eat all RAM.
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("read failed: {e}"))? {
        if buf.len() + chunk.len() > MAX_BODY_BYTES {
            return Err("response too large (>24MB) -- stream this URL instead".into());
        }
        buf.extend_from_slice(&chunk);
    }

    Ok(ApiResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        url: final_url,
        headers,
        body: String::from_utf8_lossy(&buf).into_owned(),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub url: String,
    pub reachable: bool,
    pub status: u16,
    pub latency_ms: u64,
    pub software: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

/// Health/latency check for the instance picker. Bypasses the user allowlist on
/// purpose (you must be able to test an instance before adding it) but is
/// hard-restricted to GET https://<host>/api/v1/stats -- it cannot be pointed at
/// an arbitrary path, method, or scheme.
#[tauri::command]
pub async fn api_probe(
    state: State<'_, crate::AppState>,
    instance: String,
) -> Result<ProbeResult, String> {
    let host = normalize_host(&instance).ok_or("invalid instance")?;
    if host == "169.254.169.254" || host == "metadata.google.internal" {
        return Err("blocked host".into());
    }
    let url = format!("https://{host}/api/v1/stats");
    let started = Instant::now();

    let resp = state
        .http
        .get(&url)
        .timeout(Duration::from_secs(6))
        .send()
        .await;

    Ok(match resp {
        Ok(r) => {
            let status = r.status().as_u16();
            let latency_ms = started.elapsed().as_millis() as u64;
            // The re-exported reqwest is built without the `json` feature, so parse
            // the body explicitly. A stats endpoint that returns junk is still a
            // reachable instance, hence the fallback to Null rather than an error.
            let json: serde_json::Value = match r.text().await {
                Ok(body) => serde_json::from_str(&body).unwrap_or(serde_json::Value::Null),
                Err(_) => serde_json::Value::Null,
            };
            ProbeResult {
                url: format!("https://{host}"),
                reachable: (200..300).contains(&status),
                status,
                latency_ms,
                software: json
                    .pointer("/software/name")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                version: json
                    .pointer("/software/version")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                error: None,
            }
        }
        Err(e) => ProbeResult {
            url: format!("https://{host}"),
            reachable: false,
            status: 0,
            latency_ms: started.elapsed().as_millis() as u64,
            software: None,
            version: None,
            error: Some(e.to_string()),
        },
    })
}

/// Called by the frontend whenever the user's instance list changes.
/// This is the whole reason arbitrary instances work without a wildcard scope.
#[tauri::command]
pub async fn set_allowed_hosts(
    state: State<'_, crate::AppState>,
    hosts: Vec<String>,
) -> Result<Vec<String>, String> {
    if hosts.len() > 64 {
        return Err("too many instances (max 64)".into());
    }
    state.allow.replace(hosts);
    Ok(state.allow.snapshot())
}

#[tauri::command]
pub async fn allowed_hosts(state: State<'_, crate::AppState>) -> Result<Vec<String>, String> {
    Ok(state.allow.snapshot())
}
