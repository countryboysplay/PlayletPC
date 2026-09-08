# Playlet Desktop — Playback Layer

Target: Tauri + WebView2 on Windows 11 (Chromium-class engine), Electron as fallback.
Source of truth for media: an arbitrary Invidious instance's REST API.

Everything in this folder compiles clean under `tsc --strict` with `noUnusedLocals`.
The SponsorBlock controller has a runnable behaviour suite (24 assertions, all passing).

---

## 1. Recommendation: **shaka-player**, with a plain `<video>` muxed path as the floor

### The decision in one line

You need adaptive video+audio from **separate** DASH representations (that is what
`adaptiveFormats` is), **and** HLS for livestreams, **and** VP9/AV1/Opus, **and** a
network stack you can hijack to escape CORS. Exactly one library does all four:
shaka-player.

### Option-by-option, for this exact use case

| Option | DASH VOD | Live HLS | VP9/AV1/Opus | Escape hatch for CORS | Verdict |
|---|---|---|---|---|---|
| **shaka-player** | native, its core competency | yes (MSE-based HLS parser) | yes, codec preference is configurable | **yes — `registerScheme()`** | **Ship this** |
| dash.js | yes | no | yes | request-modifier only, still WebView fetch | Needs hls.js beside it; two ABR engines, two bug surfaces |
| hls.js | no | yes | yes | loader is swappable | Useless for VOD here — Invidious VOD is DASH, not HLS |
| plain `<video src>` | no | Chromium/WebView2 **cannot** play HLS natively | muxed streams are h264/AAC only | n/a | Fallback only, 720p ceiling |

**shaka-player — why it wins**

- It is the only one of the three that speaks **both** DASH and HLS from one
  engine, one ABR implementation, one error taxonomy. Playlet needs both: VOD
  goes through `/api/manifest/dash/id/:id`, livestreams go through `hlsUrl`. One
  library means one set of failure modes to instrument, not two.
- `preferredVideoCodecs` / `preferredAudioCodecs` let you *prefer* VP9 and
  *demote* AV1 without removing it — which matters because Chromium will happily
  select an AV1 rendition and then software-decode it into a fan-screaming
  frame-drop festival on any pre-Tiger-Lake / pre-RTX-30 laptop.
- `shaka.net.NetworkingEngine.registerScheme()` lets you replace the transport
  for **every** manifest and segment request. That is the hook that lets you
  route media through Tauri's Rust-side HTTP plugin and delete CORS as a class of
  bug (see `tauri-net.ts`). dash.js's `RequestModifier` can add headers but
  cannot replace the transport; hls.js can swap the loader but does not do DASH.
- Mature error model: `shaka.util.Error` carries `{category, code, data}` where
  `data[1]` is the HTTP status. That is what makes "403 on a googlevideo segment
  → this instance's URLs are IP-bound → rotate instance or force the proxy"
  a *programmatic* decision instead of a string match. `errors.ts` does exactly
  that.

**Failure modes you will actually hit with shaka**

- Bundle size ~400 KB gzipped, and it is not tree-shakeable in any meaningful
  way. Mitigated here by dynamic `import()` in `shaka.ts` — the player module
  loads on first playback, not at app start.
- Its HLS parser is not Safari's. Some live edge cases (discontinuities, weird
  `EXT-X-MAP`) that a native player shrugs off will throw. Handled: HLS
  candidates fall through to DASH, then to muxed.
- `addTextTrackAsync` is strict about MIME. Handled: captions are fetched by us,
  normalised to start with `WEBVTT`, and handed over as a `blob:` URL with an
  explicit `text/vtt`.

**dash.js — concrete failure modes**

- No HLS at all. You would ship hls.js beside it, and now you have two ABR
  controllers with different buffer heuristics, two quality-track models to map
  into one UI, and two error vocabularies. Every QoE metric you collect has to be
  normalised across both.
- Historically stricter about SegmentBase/sidx DASH than shaka — and Invidious's
  generated manifest is exactly that shape (`init` + `index` byte ranges on
  googlevideo URLs). Any instance running an older Invidious that emits a
  slightly off manifest fails on dash.js and plays on shaka.

**hls.js — concrete failure modes**

- Invidious VOD does not expose HLS. `hlsUrl` is populated for livestreams (and
  post-live DVR); for a normal video it is null. hls.js would leave you on the
  muxed 360p path for the entire VOD library. Non-starter as the primary.

**plain `<video>` on a muxed `formatStreams` URL — failure modes**

- **No HLS in WebView2.** Chromium has never shipped native HLS. Livestreams are
  simply unplayable on this path. This alone disqualifies it as the only path.
- `MEDIA_ERR_SRC_NOT_SUPPORTED` (code 4) is what you get for a **403**, an
  expired URL, *and* a genuine codec mismatch. The element gives you nothing to
  distinguish them. `fromMediaError()` in `errors.ts` deliberately maps code 4 to
  `STREAM_FORBIDDEN` rather than `CODEC_UNSUPPORTED`, because on googlevideo URLs
  that is the correct prior by a wide margin — but it is a guess, and guessing is
  what this path forces on you.
- No ABR, no quality switching without a full reload-and-reseek (implemented
  anyway in `setProgressiveQuality`, with the seek restore).

### Is the muxed-only path a viable simple fallback? Yes — with a hard ceiling

**Viable, and you should ship it, but only as the floor.**

- **Quality ceiling: 720p, realistically 360p.** `formatStreams` is itag 22
  (720p h264 + AAC) and itag 18 (360p h264 + AAC). YouTube has been dropping
  itag 22 from responses for years; on a large share of videos — and on
  essentially all videos over ~1080p source, all VP9/AV1-only uploads, and all
  livestreams — **360p is the only muxed rendition that exists**. Do not describe
  this path as "720p" in the UI; read the actual `qualityLabel` you got.
- Audio is AAC-LC stereo. No Opus, no 5.1.
- No livestreams. No adaptive switching, so one congested minute means a stall,
  not a quality dip.

Its value is that it is the one path with **no MSE, no manifest parsing, and no
segment-level CORS** — a single GET with byte-range support. When the DASH path
dies for reasons you cannot diagnose in the field, this often still plays. That
is worth a 360p rung. It is not worth being your architecture.

### Is `local=true` proxying required for playback to work at all?

**Not always required, but you must implement it, and it must be one setting away
from being the default.**

The mechanics: an Invidious instance asks YouTube for the video, and YouTube
returns `googlevideo.com/videoplayback?...` URLs that are signed and, in the
common case, **bound to the IP that requested them** — the *instance's* IP, not
your user's. They also carry an `expire` timestamp (~6 hours).

Consequences:

- **Direct playback from the desktop app frequently 403s**, immediately or —
  worse — 40 minutes in, when a URL's window closes or YouTube's rate limiter
  notices a second IP on the same signature.
- **`local=true` fixes it by routing every segment through the instance**, which
  requests upstream from the IP the URLs were signed for. It is the reliable path.
- The cost is real: you are spending a volunteer's bandwidth on your 1080p
  stream, and proxied endpoints are the first thing instance operators rate-limit
  or disable. Some instances disable the proxy entirely; some *only* work proxied.

So: `proxyMode: 'auto'` tries direct first (fast, polite), then falls through to
proxied on `STREAM_FORBIDDEN` / `CORS_BLOCKED`, and `recover({forceProxy:true})`
handles the mid-playback case without losing the user's position. Expose
`proxyMode: 'always'` in settings, because for some instance/ISP pairs it is the
only thing that plays, and users will find that out before you do.

**CORS from a desktop app**: your WebView origin is `tauri://localhost` (or
`http://tauri.localhost` on Windows). Every request to an instance is
cross-origin. `googlevideo.com` does send permissive CORS headers on
`/videoplayback` (YouTube's own web player depends on it), and most Invidious
instances send `Access-Control-Allow-Origin: *` on `/api/v1/*` — but "most" is
not "all", hardened instances behind Cloudflare often do not, and a preflight on
a `Range` request to a proxy that answers 403 to `OPTIONS` is a silent failure
with a console message that names the wrong cause. **Install
`installFetchSchemePlugin()` and route shaka through Tauri's HTTP plugin.** The
request then happens in Rust, outside the WebView security context: no CORS, no
preflight, no forbidden-header restrictions (you can set `Referer` and
`User-Agent`, which the WebView will not let you do and which googlevideo cares
about). This is the single highest-value integration in the folder.

---

## 2. Files

All paths under `src/lib/player/`:

| File | What it is |
|---|---|
| `types.ts` | Invidious REST shapes (`formatStreams`, `adaptiveFormats`, captions, live flags) + player-facing types |
| `errors.ts` | `PlaybackError` with a typed `code`, plus `instanceFailure` / `retryable` flags. Translates `shaka.util.Error` and `MediaError` into it. **This is the contract your instance-rotation logic switches on.** |
| `emitter.ts` | Tiny typed event emitter; a throwing subscriber cannot break playback |
| `invidious.ts` | Instance URL building, `local=true` handling, proxy URL rewriting, fetch with typed failures + jittered backoff, `fetchVideo`, `fetchCaptionList`, `fetchCaptionAsBlobUrl`. `configureHttp({fetchImpl})` injects Tauri's fetch |
| `sources.ts` | Candidate list construction — **the ordering is the degradation policy** (live: HLS→HLS proxied→DASH→muxed; VOD: DASH→DASH proxied→muxed→muxed proxied) |
| `shaka.ts` | Lazy dynamic import + structural facade over shaka (keeps shaka out of the first chunk and its churning `.d.ts` out of your build) |
| `tauri-net.ts` | `installFetchSchemePlugin()` — routes every shaka request through Rust-side fetch. Kills CORS |
| `player.ts` | `PlayletPlayer`: `load/play/pause/seek/setQuality/getQualities/setVolume/destroy`, events, ABR + manual height pinning, captions, stall watchdog, mid-stream 403 recovery |
| `sponsorblock.ts` | `SponsorBlockController` + `attachSponsorBlock()` + `fetchSponsorSegments()` (hash-prefix API, so you never send a raw video id) |
| `sponsorblock.test.ts` | 24 assertions covering skip, merge, seek-back, poi, full, mute, micro-seek, end-of-video, notify |
| `index.ts` | Public surface, with a wiring example including instance rotation |
| `shims.d.ts`, `tsconfig.json`, `tsconfig.test.json` | Build plumbing |

Run the tests: `npm i && npx tsc -p tsconfig.test.json && echo '{"type":"commonjs"}' > dist/package.json && node dist/sponsorblock.test.js`

### Player API

```ts
const player = new PlayletPlayer(videoEl, { proxyMode: 'auto', quality: 'auto' });

await player.load(video, { instance, startTime: 42, captionLanguage: 'en' });
await player.play();  player.pause();  player.seek(120);
await player.setQuality('auto');   // ABR
await player.setQuality(1080);     // pins nearest available height <= 1080
player.getQualities();             // [{id:'auto',...}, {id:'3',height:1080,...}, ...]
player.setVolume(0.8);  player.setMuted(true);  player.setMaxHeight(720);
player.getTextTracks();  await player.setTextTrack('en');
await player.recover({ forceProxy: true });   // reload at the same position
await player.destroy();

player.on('timeupdate', p => {});     // ~10Hz — required by SponsorBlock
player.on('buffering', p => {});
player.on('qualitychange', p => {});
player.on('sourcefallback', p => {}); // a candidate died, we degraded
player.on('warning', p => {});        // non-fatal
player.on('error', p => {});          // fatal for this load
```

Instance rotation is driven entirely by the error type:

```ts
catch (e) {
  if (isPlaybackError(e) && e.instanceFailure) tryNextInstance();
  else surfaceToUser(e);   // CODEC_UNSUPPORTED / VIDEO_UNAVAILABLE / DRM — rotating won't help
}
```

### Notable design decisions

- **10 Hz tick, not the element's `timeupdate`.** `HTMLMediaElement` fires
  `timeupdate` at ~4 Hz. At that granularity SponsorBlock plays up to 250 ms of
  every sponsor before the skip lands, which users notice and report as "the
  skip is broken". The player runs its own 100 ms ticker.
- **Startup is the QoE metric.** `abr.defaultBandwidthEstimate` is set low
  (1.2 Mbps) so the first segment is a low rung that arrives fast, then ABR
  climbs. Starting optimistically is the classic 6-second-spinner bug.
- **Buffer deep on VOD** (`bufferingGoal: 40 s`). Invidious segment throughput is
  spiky and free; buffer depth is the cheapest rebuffer insurance available.
- **VP9 preferred over AV1 by default.** AV1 saves ~30% bitrate and costs you the
  battery and the frame rate on any machine without hardware AV1 decode. It stays
  available as an explicit user choice.
- **Stall watchdog** — 12 s of no progress while unpaused triggers
  `recover({forceProxy})`. This is what catches YouTube's throttling and silent
  segment-server death, which produce a spinner rather than an error event.

---

## 3. npm dependencies

```bash
npm install shaka-player
npm install --save-dev typescript
```

That is the entire runtime dependency list — one package. Optionally, for the
Tauri integration (you almost certainly already have these):

```bash
npm install @tauri-apps/api @tauri-apps/plugin-http
```

And in `src-tauri/Cargo.toml` + capabilities, enable `tauri-plugin-http` with a
scope covering your instance list and `https://*.googlevideo.com/*`.

If you go the Electron fallback route: same `shaka-player` dependency; replace
the Tauri fetch with `net.fetch` from the main process (or set
`webSecurity: false` in dev only — never ship it), and the scheme plugin from
`tauri-net.ts` works unchanged with a different `fetchImpl`.

No dependency on hls.js or dash.js. Do not add them; they would be a second ABR
engine solving a problem shaka already solves.

---

## 4. Pitfalls — what will actually break, and what to do about it

**1. 403 on googlevideo URLs, immediately.**
The stream URLs are signed against the instance's IP. Your desktop app is a
different IP.
→ Detect it: `PlaybackError.code === 'STREAM_FORBIDDEN'` (shaka NETWORK/1001 with
`data[1] === 403`). Retry the same video with `local=true`
(`proxyMode: 'always'`); the candidate list already contains that rung. If the
proxied rung also 403s, the instance itself is being blocked upstream — rotate
instances (`instanceFailure` is true for this code).

**2. 403 *mid-playback*, 40 minutes in.**
`expire` on the URL has passed (~6 h window), or the second-IP heuristic tripped.
This is the nastiest one because the video started fine, so your telemetry blames
the network.
→ `onShakaError` catches it and calls `recover({forceProxy:true})`, which reloads
the manifest and resumes at the same `currentTime`. Re-fetch `/api/v1/videos/:id`
first if the reload also fails — the URLs in your cached video object are dead and
no amount of retrying will revive them. **Never cache an Invidious video response
for longer than ~30 minutes.**

**3. IP mismatch that manifests as "works for me".**
Direct playback works fine on your dev machine (same country as your favourite
instance) and fails for half your users.
→ Do not treat direct playback as validated until you have tested against
instances in a different country from the client. Ship `proxyMode` as a visible
setting; make the failure path automatic rather than a support ticket.

**4. Rate limiting / bot checks (429, or a 200 with an HTML body).**
Volunteer instances rate-limit aggressively, and Cloudflare-fronted ones return a
challenge page with HTTP 200.
→ `requestJson()` throws `INSTANCE_HTTP_ERROR` when the body will not parse as
JSON, precisely to catch the 200-HTML case; 429 maps to
`INSTANCE_RATE_LIMITED`. Both are `instanceFailure: true`. Keep a ranked instance
list, apply a cooldown to any instance that returns 429, and back off with
jitter (already implemented) — never hammer a retry loop at a volunteer host.

**5. Throttling (the slow death).**
YouTube throttles requests whose `n` parameter was not correctly transformed.
Symptom: playback starts, then segments arrive at ~50 KB/s and the buffer bleeds
out. There is no error event — just a spinner.
→ The stall watchdog fires after 12 s of no progress and reloads through the
proxy. Also instrument `bufferedAhead` from `timeupdate`: a monotonically
decreasing buffer under a stable bitrate *is* the throttling signature, and you
want that on a dashboard, not in a bug report.

**6. Codec gaps.**
WebView2/Chromium hardware-decodes VP9 nearly everywhere on Win11 and h264
always. AV1 hardware decode requires Intel Xe / RTX 30 / RDNA2 or newer;
otherwise dav1d software decode will drop frames at 1440p+ and cook a laptop
battery. Opus in an MP4 container is also handled inconsistently on older
WebView2 builds.
→ `preferredVideoCodecs: ['vp9','avc1','av01']` by default; AV1 only if the user
opts in. `preferredAudioCodecs: ['opus','mp4a']` with automatic fallback.
`CODEC_UNSUPPORTED` is explicitly `instanceFailure: false` — rotating instances
for a codec problem just wastes the user's time on four identical failures.

**7. CORS preflight against an arbitrary instance.**
Cross-origin from `tauri://localhost`, with `Range` headers that trigger
preflight, against an instance that may answer `OPTIONS` with a 403. The console
error names the wrong cause, and shaka cannot distinguish a CORS rejection from
a dead host (both are NETWORK/1002 with no status).
→ `installFetchSchemePlugin()`. Requests go through Rust; CORS does not apply.
Do the same for captions (`fetchCaptionAsBlobUrl` already fetches through the
injected fetch and hands the engine a same-origin `blob:` URL). Do **not** reach
for `webSecurity: false` or a wildcard CSP — that is a real security regression
in an app that renders third-party content, and it does not fix the
forbidden-header problem anyway.

**8. Captions that 404 or arrive without a `WEBVTT` header.**
Some instances serve caption bodies that shaka's VTT parser rejects outright.
→ Fetched as text, normalised (prepend `WEBVTT` if missing), served as a blob.
Caption failures emit `warning`, never `error` — a missing subtitle track must
never fail a load.

**9. Livestream specifics.**
`liveNow` videos have no `formatStreams`, so the muxed fallback does not exist for
them; `isPostLiveDvr` videos are served as HLS even though `liveNow` is false.
Seeking must be clamped to `seekRange()`, not `duration`.
→ Both handled in `sources.ts` and `getSeekableRange()`. Live also gets a
shallower buffer (20 s) and a higher rebuffering goal, because deep buffering on
live just increases latency-to-live for no QoE gain.

**10. SponsorBlock fighting the user.**
The failure everyone ships at least once: user drags back to rewatch something,
the controller skips them forward again, user drags back, infinite fight.
→ A manual seek landing inside an already-skipped segment permanently disables
that segment for the session; a seek to *before* it re-arms it. Our own seeks are
tagged (`pendingSeekTarget` + 4 s window) so they are never misread as user
intent. Overlapping and near-duplicate segments are merged before any seek
happens. Segments with under 350 ms of remaining savings are not worth a decoder
flush and are skipped over. `actionType: 'full'` never moves the playhead; `poi`
is an offer, not an action. All of this is covered by the test file.

**11. Privacy: never send the raw video id to the SponsorBlock API.**
→ `fetchSponsorSegments` sends a 4-character SHA-256 prefix and filters
client-side. This is the documented, privacy-preserving endpoint; using
`/api/skipSegments?videoID=` leaks the user's full watch history to a third party.
