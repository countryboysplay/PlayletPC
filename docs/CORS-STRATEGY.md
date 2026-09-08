# CORS strategy — Playlet Desktop

## The one-sentence verdict

**Every JSON/text API call goes through the Rust `api_fetch` command. Every media
byte (`<img>`, `<video>`, `<audio>`) is loaded directly by the element from the
raw URL. Nothing uses the webview's own `fetch()` against a remote host in the
packaged app.**

## Why the webview's origin makes this necessary

The packaged app is served from `http://tauri.localhost` (Windows/WebView2 uses
the custom-protocol-on-localhost scheme, not `file://`). That is a real origin, so
every `fetch()` the renderer makes is a genuine cross-origin request:

- Simple `GET`s to an Invidious instance often work, because most instances send
  `Access-Control-Allow-Origin: *` on `/api/v1/*`. **Often is not always.** Some
  instances (especially self-hosted and Cloudflare-fronted ones) send no ACAO
  header at all, or send a specific origin. Those fail, and the failure is a
  generic `TypeError: Failed to fetch` with the real reason only in the DevTools
  console — indistinguishable from "instance is down" in your error handling.
- Anything with a non-simple header (`Authorization` for Invidious accounts, a
  custom header) triggers a preflight `OPTIONS`. A large share of instances do not
  handle `OPTIONS` on the API routes.
- Redirects to `googlevideo.com` (`/latest_version`) will not survive a CORS
  fetch: googlevideo does not send ACAO for arbitrary origins.
- You cannot control this per instance, and the user picks the instance. Any
  design where "it depends on how the instance is configured" is a design that
  generates bug reports you cannot reproduce.

Rust `reqwest` is not a browser. It sends no `Origin`, does no preflight, ignores
ACAO entirely, and follows redirects across hosts. That is the whole trick.

## The decision table

| Request | Transport | Why |
|---|---|---|
| `GET /api/v1/videos/{id}`, `/search`, `/trending`, `/channels`, `/comments` | **Rust `api_fetch`** | ACAO is not guaranteed per instance |
| SponsorBlock `/api/skipSegments` | **Rust `api_fetch`** | ACAO is fine today, but one code path is cheaper than two, and the 404-means-empty handling lives in one place |
| Invidious auth / subscriptions (`Authorization: Bearer`) | **Rust `api_fetch`** | Custom header ⇒ preflight ⇒ dead on most instances. Also keeps the token out of `window` |
| Instance health probe / instance list from `api.invidious.io` | **Rust `api_probe` / `api_fetch`** | Probing must work *before* the instance is trusted |
| DASH/HLS **manifest** and segments (MSE) | **Direct in the player, via the instance-proxied URL** (`/api/manifest/dash/id/<id>?local=true`) | MSE fetches segments itself; those fetches *are* CORS-controlled, and Invidious sends ACAO on its own proxy routes. Never pipe segments through IPC |
| `<video src>` / `<audio src>` progressive (`formatStreams`) | **Direct, raw googlevideo URL** | Media elements without `crossorigin` are exempt from CORS. Only CSP `media-src` gates them |
| `<img src>` thumbnails (`ytimg.com`, `ggpht.com`) | **Direct, raw URL** | Same — no CORS on plain `<img>`. Only CSP `img-src` |
| Anything that must reach a `<canvas>` (frame grabs, ambient-light effect) | **Direct via the instance proxy `?local=true`** | Canvas readback taints without CORS. Adding `crossorigin="anonymous"` to a googlevideo URL breaks playback entirely — use the instance proxy, which does send ACAO |

### The trap, stated plainly

Adding `crossorigin="anonymous"` to a `<video>` or `<img>` — which people do
reflexively, or which a UI library does for you — **switches that element from
"no CORS" to "CORS enforced"** and instantly breaks googlevideo/ytimg loading.
If thumbnails or playback break after a component library upgrade, check for an
injected `crossorigin` attribute first.

## Why not just widen the HTTP plugin's scope?

`tauri-plugin-http` exposes a `fetch()` to JS whose allowlist ("scope") is
**compiled into the binary**. "Arbitrary user-chosen instance" can only be
written as `https://*`, so the renderer would hold an unrestricted, CORS-free
HTTP client. Invidious descriptions and comments are attacker-controlled HTML —
one XSS and that is an SSRF + exfiltration primitive with nothing left to stop it.

`api_fetch` checks the host against a **runtime** allowlist instead
(`src-tauri/src/net.rs`):

- fixed hosts/suffixes: `sponsor.ajay.app`, `*.googlevideo.com`, `*.ytimg.com`,
  `*.ggpht.com`, `*.youtube.com`
- plus whatever origins the user has actually added as instances
- private/loopback IPs allowed **only** if the user explicitly added them
  (self-hosted Invidious on a LAN is legitimate); `169.254.169.254` never
- method restricted to GET/POST/HEAD, request headers allowlisted (no
  `cookie`/`authorization`/`origin` pass-through from JS), 24 MB response cap,
  timeouts capped at 60 s

Adding an instance needs no rebuild — the frontend calls `set_allowed_hosts`.
**If you add an instance in the UI and forget to call `syncAllowlist()`, every
request to it fails with `host not allowed` and it will look exactly like a CORS
bug.** It is not.

The wildcard-scope version is kept, disabled, at
`src-tauri/capabilities/http-broad.json.disabled` if you ever need to A/B it.

## The abstraction the frontend sees

`src/lib/api/http.ts` — call sites never pick a transport:

```ts
const video = await getJson<VideoDetails>(`${instance}/api/v1/videos/${id}`);
```

Internally: `isTauri()` → `invoke('api_fetch')`; plain browser dev server →
`/__proxy?url=…` (a Vite middleware in `vite.config.ts`, dev only). Swapping
Tauri for Electron later means editing one function (`viaRust`) — the Electron
fallback's `api:fetch` IPC channel returns the identical `HttpResponse` shape on
purpose.

Layered on top:
- `getJsonCached()` — TTL cache + in-flight dedupe (Invidious rate-limits hard,
  and Svelte components mount twice in dev)
- `InvidiousClient` (`invidious.ts`) — automatic failover to the next instance on
  5xx/429/network error, no failover on a real 4xx
- `media.ts` — the only place that produces URLs handed to media elements
