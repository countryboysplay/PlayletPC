# Where this project stands, and what to do next

Last updated: 2026-09-08 (second revision). Written as a handoff — read this before
touching playback.

**SOLVED. Playback works, end to end.** The 60-second wall was never a policy limit — it
was an artifact of *which client* was being asked. The **VISIONOS** client returns direct,
unciphered URLs with no PoToken requirement and no serve limit, and streams a whole video.
It is now the first rung of the player ladder. Section 3 has the evidence.

Everything below about SABR, PoTokens and attestation is kept because it is true of the
IOS/WEB/TV clients and because SABR is the fallback if VISIONOS is ever closed — but none
of it is on the critical path any more.

---

## 1. What this is

`playlet-desktop/` is a Windows 11 port of [Playlet for Roku](https://github.com/iBicha/playlet)
(AGPL-3.0). The parent directory is the original Roku sideload package and must not be
modified.

Tauri v2 (Rust + WebView2) + Svelte 5 + TypeScript, shipped as a single ~4 MB NSIS
installer. Per-user install to `%LOCALAPPDATA%\Playlet`, no admin required, unsigned
(SmartScreen warns once — *More info → Run anyway*).

```
npm install
npm run desktop              # dev
npm run desktop:build:nsis   # installer -> src-tauri/target/release/bundle/nsis/
npm test                     # 334 offline assertions against captured fixtures
npm run test:live            # 26 assertions against live YouTube
npm run check                # svelte-check, 165 files
cd src-tauri && cargo test --bin playlet-desktop   # 10 Rust tests
```

## 2a. SOLVED: playback topped out at 1080p

Reported 2026-09-09, fixed the same day. **The cause was a bare `vp9` codec string,
and it was invisible to every check that looked plausible.**

VISIONOS - the client this app plays with - returns `codecs="vp9"` in its
`adaptiveFormats`. Other clients (IOS, for one) return `codecs="vp09.00.51.08"`. Both
forms are accepted by `MediaSource.isTypeSupported`, so nothing looked wrong. But shaka
does not filter on `isTypeSupported`; it calls
`navigator.mediaCapabilities.decodingInfo()`, and Chromium **rejects the bare form as
under-specified**, answering `supported: false` at *every* resolution.

Measured in Chromium (the WebView2 engine), 2026-09-09:

| codec string | `isTypeSupported` | `decodingInfo` @2160p60 |
|---|---|---|
| `video/webm; codecs="vp9"` | **true** | **supported: false** |
| `video/webm; codecs="vp09.00.51.08"` | true | supported, smooth, powerEfficient |

shaka drops every variant whose `decodingInfo` is unsupported
(`StreamUtils.checkVariantSupported_`), so the whole VP9 ladder vanished, leaving AV1
and H.264 - and `preferredVideoCodecs` then selected H.264, whose YouTube ladder stops
at **1080p**. No error, no log line, just half the ladder missing.

**Two fixes, both required:**

1. `innertube-dash.ts::fullyQualifyCodecs` expands a bare `vp9`/`vp8` into its full
   RFC 6381 form, computing the VP9 level from width x height x frame rate. The level
   table reproduces YouTube's own assignments exactly, rung for rung (144p->11,
   240p->20, 360p->21, 480p->30, 720p60->40, 1080p60->41, 1440p60->50, 2160p60->51).
2. `player.ts::codecPreferenceList` matched on `'vp9'`, which does not
   `startsWith`-match `vp09...`. Once (1) emits qualified strings, the old list would
   have fallen through to H.264 and re-created the same ceiling. It now lists `vp09`
   before `vp9`. Shaka's matcher is a prefix test, and the first preference with any
   match wins outright - so a near-miss is not a near-miss, it is a silent codec
   downgrade.

Covered by `tests/dash-fixtures.test.ts` (the level table and an end-to-end MPD
assertion that no bare `vp9` survives) and `tests/live-account.test.ts`, which builds
a manifest from a live 4K response and asserts the full 2160p ladder is reachable.

**The lesson worth keeping:** three of the four candidates originally written down here
(a `preferredQuality` setting, `maxAdaptiveHeight`, `result.skipped`) were all wrong,
and all were checkable. The real cause was one layer lower than any of them, in a
browser API contract, and the only thing that found it was asking the engine directly
what it supported instead of reasoning about what it should support.

## 2. What works today

- **Browsing is complete and solid.** Search (with protobuf-encoded filters), channels
  (videos/shorts/live tabs, continuations), playlists, recommendations, watch history,
  local subscriptions, resume positions, settings — all verified against live YouTube.
- **SponsorBlock** — hash-prefix API, per-category skip/ask/mark, 24 passing controller
  tests covering seek-back, overlaps, `poi_highlight`, `full`, mute.
- **The whole InnerTube pipeline** — Rust transport with scraped client identity, the
  response mapper (242 fixture assertions), the DASH manifest generator (92 assertions),
  and the media proxy.
- **Playback works**, at up to 2160p, with a locally generated manifest, via the
  VISIONOS client (§3). Whole videos, not the first minute.

## 3. Playback: solved by the VISIONOS client

Verified 2026-09-09. `VISIONOS` (Apple Vision Pro, `X-YouTube-Client-Name: 101`,
`clientVersion 1.02`) returns **32 adaptive formats, every one with a direct `url`, no
`signatureCipher`, no `n` parameter and no `pot`** — and no serve limit:

| position in file | result |
|---|---|
| 1% | HTTP 206, media |
| 50% | HTTP 206, media |
| 99.9% | HTTP 206, media |

The one extra requirement, established by elimination: **`X-Goog-Visitor-Id` must carry the
scraped visitor id.** Without it the player answers `LOGIN_REQUIRED — Sign in to confirm
you're not a bot`. Measured as *not* required: `signatureTimestamp` (nothing is ciphered)
and the consent cookies (sent anyway; they cost nothing and keep the identity scrape off
consent interstitials).

Wired in at `src-tauri/src/innertube.rs` (`profile_for`) and
`src/lib/api/innertube.ts` (`PLAYER_CLIENT_LADDER`). Guarded by live assertions in
`tests/live-dash.test.ts` that read media at 1/50/99% of the file — the bar is still
*play past 60 seconds*, never *a request succeeded*.

**How it was found:** installing yt-dlp and watching it download the full video on the same
machine and IP that was failing, then reading `--print-traffic`. Credit to yt-dlp; their
[PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide) pointed the way.
Hours of protocol-level probing had not found it.

**Caveat:** this is policy, not protocol. VISIONOS will presumably be restricted like every
client before it. The ladder falls back to IOS, and the SABR client in `tools/sabr/` is the
deeper fallback.

## 4. The old wall, for reference (IOS/WEB/TV clients)

**These clients serve only the first ~60 seconds of media.**
Over legacy `videoplayback` this appears as HTTP 403 past that offset, permanently.
Over SABR it appears as HTTP 200 with an empty body — no error, no media.

The boundary is **exactly 60.000 seconds** of playback position, measured 2026-09-08 with
fresh stateless SABR requests at increasing positions (`tools/sabr/seek-probe.mjs`):

| position | media returned |
|---|---|
| 40 s | 639 KiB |
| 55 s | 519 KiB |
| 58 s | 519 KiB |
| 59 s | 519 KiB |
| **60 s** | **0** |
| 61 s, 65 s, 120 s, 300 s, 600 s | 0 |

**Videos shorter than 60 s play to completion.** `jNQXAC9IVRw` (19 s) returns every
segment through to the end. So this is "the first 60 seconds of any video", not a
per-request or per-format quota.

Earlier measurement on `FPsDC1cclVI` (3983 s), stepping in 512 KB chunks, which is what
first made this look like a `videoplayback` quirk:

| itag | quality | bitrate | bytes served | seconds of media |
|---|---|---|---|---|
| 160 | 144p | 138k | 0.5 MiB | **58.9 s** |
| 133 | 240p | 297k | 1.0 MiB | **53.4 s** |
| 137 | 1080p | 5.4M | 20.0 MiB | **59.7 s** |

It is a *duration* cap, not a byte cap. **Lowering quality does not help** — 144p gets
the same 60 seconds as 4K.

In the app it presents as playback dying after ~5 seconds of wall-clock, because shaka
buffers far ahead: at high bitrate it requests past the 60-second boundary within
seconds and treats the resulting 403 as fatal.

## 5. Hypotheses already disproved — do not repeat these

Each of these was tested against the live API and **failed**. They cost days; they are
recorded so nobody spends that again.

| Hypothesis | Result |
|---|---|
| It's a 20 MB byte cap | No — it's ~60 s of media. The "20 MB" was a coincidence of itag 137's bitrate. |
| It's a rate limit that resets | No — retried the same range after 5 s, 15 s, 30 s, 60 s: all 403. |
| Refresh the URL from a new `/player` call | No — a brand new URL is *also* 403 at that offset, while serving `bytes=0-2MB` fine. |
| Request shape is wrong | No — identical for `Range` header, `&range=` query param, `&rn=`/`&rbuf=`, `&cpn=`. |
| Wrong client identity | No — emulated upstream byte-for-byte: iOS 21.16.2, its exact `CreateContextClientIOS` context, `cpn`, full `contentPlaybackContext`, `attestationRequest`, its Firefox `VIDEO_PLAYER_USER_AGENT` for media. Cap unchanged. |
| A PoToken lifts it | No — genuine 12-hour tokens minted (server rejects tampered ones). Playback identical with a valid token, a bogus token, and none. `pot` is not in the URL's `sparams`. |
| Use TVHTML5 (what Roku uses) | No — refuses with **no** `visitorData` (`LOGIN_REQUIRED`) and with **any** `visitorData` ("The page needs to be reloaded"). Tested across 4 client versions incl. downgraded `5.20260114`, client-name headers `7` and `2`, Tizen + PlayStation + Roku UAs, the real STS **20702** from `tv-player-ias.js`, all 10 `/tv` session cookies, and 3 visitor-id sources (scraped, InnerTube `/guide`-issued, WEB-issued). |
| **Signing in unlocks TVHTML5** | **No.** With a real refreshed account token as `Authorization: Bearer`, TV still answers "The page needs to be reloaded", 0 formats. |
| **SABR/UMP lifts the cap** | **No.** Implemented and working (§7) — and capped at the same exact 60.000 s. The cap is not transport-specific. |
| A PoToken lifts it *on SABR* | No — identical with and without, in both the SABR body and `serviceIntegrityDimensions`. But this one is a *class mismatch*, not a dead end: our token is WEB-class and the client was IOS. See §7. |
| Waiting clears the SABR stall | No — 73 s of wall clock across six retries, zero further media. Not a rate limiter. |

**Every row above is about the IOS/WEB/TV clients and remains true of them. None of it
applies to VISIONOS (§3), which has no such limit.** The table's real lesson is that a
long list of correct negative results can still add up to a wrong conclusion if the search
space was wrong from the start.

**What actually gates TVHTML5:** Playlet sends `context.client.tvAppInfo.livingRoomPoTokenId`
— a living-room *device attestation* minted by its own backend
(`PLAYLET_SUPPORT_SERVER`, not in the public repo). The TV bundle references
`livingRoomPoToken`, `botguard` and `attestation`, but does **not** contain the web
BotGuard request key, so it uses a different, non-obvious one. This is the piece
upstream deliberately keeps server-side. Chasing it is not recommended.

Also true and load-bearing:

- **YouTube retired Trending.** Every `FEtrending` browse id answers HTTP 400.
  `FEwhat_to_watch` is genuinely empty signed-out (with or without a consent cookie);
  `FEexplore` and `FEtopics_music` 400. Home is therefore built from local subscriptions
  and history, with a first-run prompt.
- **The public Invidious network is not a fallback.** Of 28 well-known instances probed,
  one answered the API, and it refused every video with *"This instance doesn't support
  using Invidious like this currently"*. They are hitting this same wall.
- **googlevideo sends CORS headers only to `https://www.youtube.com`.** MSE segment
  fetches from the app origin are blocked, which is why the Rust media proxy exists.
- **Legacy is being retired.** The WEB client now returns *no* `url` and *no*
  `signatureCipher` — only `serverAbrStreamingUrl`.

## 6. Sign-in: what it is actually for

The TV device-code OAuth flow is fully implemented and works (`src-tauri/src/oauth.rs`,
`src/lib/stores/account.svelte.ts`, panel in Settings). It mints real tokens.

**It buys nothing for playback** and costs privacy - watching becomes attributable to the
Google account. What it *does* buy, as of 2026-09-09, is the thing it was always for on
Roku: your real subscriptions and saved playlists (below).

On playback specifically, confirmed against the Roku app, which plays full videos signed
in *or* signed out: an account is not the missing ingredient, and no amount of sign-in
work will lift the 60-second wall.

Sign-in's real value is what it is on Roku — quick access to your subscriptions and
playlists. That is now built (below).

Hard-won detail worth keeping: **the token must go ONLY to the TV client.** An
`Authorization` header on a WEB `/search` or IOS `/player` returns HTTP 401 "Request had
invalid authentication credentials". Sending it everywhere broke search and playback
once already. Encoded in `innertube.ts` as `client === 'tv' ? token : undefined`, and
upstream states the same rule as `useAccessToken = isTv and ...`.

**Authenticated feeds now work** (2026-09-09). They were stubbed to return `[]` because
TV browse uses living-room renderers the mapper had never been verified against - and
that was the right call at the time, but the fix was simply to capture a real signed-in
response and read it, which had never been done.

`FEsubscriptions` and `FEplaylist_aggregation` both answer HTTP 200 with real data on
the TV client with an account token. The shapes:

* **`tileRenderer`** is the living-room card. `contentType` is
  `TILE_CONTENT_TYPE_VIDEO` / `_PLAYLIST` / `_CHANNEL`, `contentId` is the id, the
  title sits in `metadata.tileMetadataRenderer.title`, and the metadata `lines[]` carry
  the author, view count and relative date as separate `lineItemRenderer` texts.
* **The subscribed channel list is NOT in the feed body.** It is the tab strip: one
  `tabRenderer` per subscribed channel, with the channel id encoded in the tab's
  base64 protobuf `params` (the strip also holds `All` / `A-Z` / `Shorts` navigation
  tabs and repeats every channel in an alphabetised group).
* **`FEplaylist_aggregation`** is the clean playlists surface - user playlists plus
  Watch Later (`WL`) and Liked Videos (`LL`), with counts in the thumbnail overlay.
  `FElibrary` has them too, mixed in with history and navigation tiles.

Mapped in `src/lib/api/innertube-tv-map.ts`, fixtures in
`tests/fixtures/subscriptions.tv.json` and `library.playlists.tv.json` (real structure,
sanitised ids and titles), 43 assertions in `tests/tv-map-fixtures.test.ts`.

Subscriptions are **merged** into the local library rather than replacing it
(`library.mergeSubscriptions`), so the existing Subscriptions page, Home feed and
channel "Subscribed" state all work unchanged, and a subscription added on this PC
while signed out is never silently deleted. Signing out keeps the local list.

**Opening a playlist needed a second fix.** Watch Later, Liked Videos and most
user-created playlists are *private*, and the WEB client carries no account token, so
it cannot see them at all - the list would show three playlists that all failed to
open. `InnertubeClient.playlist()` now tries WEB first (the verified path, and the
richer shape) and falls back to a TV browse when signed in, mapped by `mapTvPlaylist`.
That reuses the same `tileRenderer` parser the other two feeds are built on rather
than adding a third. The TV playlist *header* shape has not been captured against a
real account, so the title falls back to the one already known from the playlist list
rather than being guessed; `tests/live-account.test.ts` covers the whole path the
moment someone runs it signed in.

## 7. SABR/UMP: built, working, and not the answer

Built and measured 2026-09-08. Working scratch implementation in `tools/sabr/`:
`capture.mjs` (single request + part dump), `stream.mjs` (full streaming loop),
`seek-probe.mjs` (position sweep), `client-matrix.mjs` (client × attestation matrix).
Reference protos fetched from `LuanRT/googlevideo` are in `tools/sabr/protos/`.

**It works.** The first request built by hand was accepted — HTTP 200,
`content-type: application/vnd.yt-ump`, valid UMP framing, init and media segments for
both tracks, signed out and with no PoToken. The streaming loop pulls continuous media,
advancing `player_time_ms` and reporting `buffered_ranges`, up to 62.2 s video / 69.9 s
audio. Then it stops dead.

**And it hits the identical wall.** Not a caching or buffered-range artifact: a fresh,
stateless request at position 60 s returns zero media (§3). SABR is not a way around this.

### What the server actually tells us

`STREAM_PROTECTION_STATUS` (UMP part 58) carries a status the reference implementation
documents as 1 = ok, 2 = attestation pending, 3 = attestation required. Ours reads:

- **status 2** at positions 0–59 s — media flows
- **status 3** at position 60 s and beyond — zero media

So the 60-second boundary is not an unexplained cap. It is the server saying *you may have
one minute unattested; past that you must be attested.* That reframes the whole problem,
and it is the single most useful thing learned in this pass.

### Why the PoToken we have does not satisfy it

Tested and byte-for-byte identical with and without a genuine token, in **both** slots —
`StreamerContext.po_token` in the SABR body, and `serviceIntegrityDimensions.poToken` on
the `/player` call. The reason is a class mismatch: our minter's `REQUEST_KEY` is the
**web** BotGuard key, so it mints a WEB-class token, and we were pairing it with an **IOS**
client context. The server ignores it entirely.

The attestation has to match the client identity. That is the actual gate.

### Client matrix (2026-09-08, `client-matrix.mjs`)

| client | player response | SABR at 30 s | at 120 s |
|---|---|---|---|
| IOS | OK | 897 KiB (status 2) | empty (status 3) |
| WEB | OK *(with live identity)* | HTTP 403 | HTTP 403 |
| MWEB | OK *(with live identity)* | HTTP 403 | HTTP 403 |
| ANDROID | no `streamingData` | — | — |

Two corrections to earlier notes in this document:

- **WEB and MWEB are not unusable.** They returned "Video unavailable" only because the
  request carried a two-year-stale `clientVersion` and no signature timestamp. With the
  live values scraped from the homepage (`INNERTUBE_CLIENT_VERSION`, currently
  `2.20260907.06.00`, and STS `20702` from `base.js`) both return `OK` with a full
  `streamingData` and a `serverAbrStreamingUrl`.
- Their SABR URLs 403 with an **empty body**, and it is *not* the `n` parameter. An
  earlier revision of this document claimed it was; that was a guess and it is wrong.
  Tested directly: the 403 is byte-identical with `n` as issued, with `n` deleted, and
  with `n` replaced by garbage. Note `n` is not listed in `sparams`, so it is not
  signature-protected either. Adding `pot=` as a query parameter changes nothing (`pot`
  is likewise absent from `sparams`). No `nsig` work is warranted on this evidence.

### Full client sweep — no identity is uncapped

Every client that might plausibly be less restricted, probed at 30 s (control) and 120 s
(past the wall), each with and without a PoToken (`tools/sabr/client-sweep.mjs`):

| client | `/player` | SABR 30 s | SABR 120 s |
|---|---|---|---|
| IOS | OK | 897 KiB (status 2) | empty (status 3) |
| MWEB | OK | HTTP 403 | HTTP 403 |
| WEB | OK | HTTP 403 | HTTP 403 |
| ANDROID_VR | LOGIN_REQUIRED — *"Sign in to confirm you're not a bot"* | — | — |
| WEB_EMBEDDED_PLAYER | ERROR — *"This video is unavailable"* | — | — |
| TVHTML5_SIMPLY_EMBEDDED_PLAYER | ERROR — *"YouTube is no longer supported in this app"* | — | — |
| WEB_CREATOR | LOGIN_REQUIRED — *"Please sign in"* | — | — |

**IOS is the only client that serves media at all, and it is capped at 60 s.** Adding a
PoToken changed nothing anywhere in this table.

### Superseded — but keep it

Everything in this section is still *true*, and it is all still wrong about what mattered.
The conclusion drawn here — "no reachable client identity avoids the gate" — was false. It
was drawn from testing IOS, WEB, MWEB, TV, the embedded clients and ANDROID_VR, and it did
not occur to me to ask what yt-dlp was doing. VISIONOS was never tried (§3).

The lesson is worth more than the finding: **hours of protocol-level probing lost to one
unchecked assumption about the search space.** Checking what an existing working tool does
should have come first, not last.

What is still worth keeping from this work:

- **SABR is implemented and correct**, in `tools/sabr/`. If VISIONOS is closed, this is the
  fallback that does not need to be rediscovered. The `xtags`, UMP-varint and `time_range`
  gotchas above are all real and cost a day between them.
- **`tools/sabr/` stays runnable** — the cheapest way to re-test whether a boundary has
  moved, and this is policy, so boundaries move.
- **In-process attestation works** if it is ever needed: bgutils-js v4 mints a real
  12-hour PoToken in ~350 ms under jsdom, and youtubei.js will decipher signature/`n`
  given a `node:vm` evaluator. Neither is currently on the critical path.

One correction to §5 while it is in view: `livingRoomPoTokenId` is **not** minted by
Playlet's backend. It is scraped by regex from `https://www.youtube.com/tv` alongside
`visitorData` and cached 14 days. See `PLAYLET-ROKU-MAP.md` §5.1.

### What SABR is

Instead of ranged GETs against a per-format URL, the client POSTs a protobuf
(`VideoPlaybackAbrRequest`) to `serverAbrStreamingUrl` describing which formats it wants
and its current playback position and buffer state. The server replies with a **UMP**
(Universal Media Playlist) framed stream: a sequence of length-prefixed parts carrying
media segments plus control messages telling the client what it just received and what to
ask for next.

### Protocol details worth keeping

These were all learned the hard way against the live server. None of them are guessable.

- **`FormatId` must carry `xtags`.** Every audio itag appears *twice* in `adaptiveFormats`:
  once plain, once as a DRC variant with `xtags: "CggKA2RyYxIBMQ"` and a *different*
  `lastModified`. Taking one variant's `lmt` without its `xtags` names a format that does
  not exist, and the server answers `sabr.no_audio_selected` (code 2). Prefer the plain
  variant, and always pass `xtags` through.
- **UMP part framing does not use protobuf varints.** It uses its own length-prefixed
  integer where the *first byte* encodes the width (`<128` → 1 byte, `<192` → 2, `<224` →
  3, `<240` → 4, else 5). See `UmpReader.readVarInt` in `LuanRT/googlevideo`.
- **`MEDIA_HEADER` carries no `start_ms`/`duration_ms`** (fields 11/12) in practice. Timing
  arrives as `time_range` (field 15) in ticks against its own `timescale` — e.g. 66560
  ticks at timescale 15360 = 4333 ms. Reading only 11/12 leaves every duration at zero,
  the player time never advances, and the server re-sends the same segments forever.
- **The first response is a `RELOAD_PLAYER_RESPONSE`** (part 46) carrying a token. Feed it
  back through `/player` as `playbackContext.reloadPlaybackContext.reloadPlaybackParams
  .token` and re-issue; the second attempt gets media.
- **Pass the playback cookie back verbatim.** `NEXT_REQUEST_POLICY` field 7 can be copied
  as raw bytes straight into `StreamerContext.playback_cookie` without decoding it.
- The request is a plain `POST` with `content-type: application/x-protobuf`,
  `accept: application/vnd.yt-ump`, `accept-encoding: identity`, and an incrementing `rn`
  query parameter.

### What is left if the WEB path pans out

1. **UMP parser** → `src/lib/api/ump.ts`, ported from `tools/sabr/stream.mjs`.
2. **ABR request builder** → `src/lib/api/sabr-request.ts`. The protobuf writer in
   `tools/sabr/` is the one to bring over — it handles varint, length-delimited,
   float and nested messages. `innertube-params.ts` only has varint and nested.
3. **Fixtures.** Captured responses are in `tools/sabr/captures/*.bin`; move them under
   `tests/fixtures/` and build the parser tests against them, fixture-first, as every
   other mapper in this repo was.
4. **PoToken.** `src/lib/api/potoken.ts` (store, expiry, per-identity cache) and
   `src-tauri/src/attestation.rs` already exist. The minter at
   `...\scratchpad\potoken\potoken.ts` **has now been read line by line.** It is the
   standard public BotGuard/WAA flow — the `REQUEST_KEY` and `GOOG_API_KEY` are the
   well-known public web keys, not anything scraped from the user's account, and it
   touches no credentials or cookies; the only identifier it binds is `visitorData`.
   **The real hazard is inherent and permanent: step 2 is `(0, eval)()` on obfuscated
   JavaScript fetched from Google.** That is unavoidable for attestation, so the thing to
   control is *where it runs*. It must never execute in the main WebView realm, which has
   `window.__TAURI__` on it. Give it an isolated realm with IPC disabled — a sandboxed
   iframe or a separate WebView — and route its network I/O through the Rust allowlist via
   the injectable `fetchImpl`. It mints real 12-hour tokens in ~330 ms.
5. **Rust transport.** `api_fetch` cannot carry this — it decodes bodies as UTF-8 and would
   corrupt them. Extend the `playletmedia` custom protocol in `src-tauri/src/media.rs`,
   which already streams binary with CORS headers.
6. **Feed shaka.** A scheme plugin or custom `IManifestParser` so segments arrive from the
   SABR reader. `src/lib/player/` already accepts a caller-supplied `LoadOptions
   .manifestUri`, added for the generated MPD.

### Verify it the same way everything else here was verified

The bar that caught every real bug in this project: **play past 60 seconds.** A live test
harness exists — extend `tests/live-dash.test.ts`. Assert continuous media well beyond the
cap (aim for 5+ minutes), not just that a request succeeded.

### Cheap mitigation worth doing first

The cap is ~60 s of *media*, but you only get ~5 s of playback because shaka buffers
ahead and treats the 403 as fatal. Lowering shaka's `bufferingGoal` would let the full
minute actually play. Roughly ten minutes of work, a 12× improvement on a broken thing,
and it makes SABR development less painful. Not a fix.

## 8. Map of the code

```
src/lib/api/
  backend.ts            the contract both backends satisfy
  innertube.ts          direct YouTube client, client ladder, manifest attach
  innertube-map.ts      InnerTube JSON -> Invidious shapes (242 assertions)
  innertube-tv-map.ts   TVHTML5 living-room renderers -> the same shapes; the
                        signed-in subscriptions/playlists feeds (43 assertions)
  innertube-dash.ts     adaptiveFormats -> MPD (92 assertions)
  innertube-params.ts   protobuf writer for search filters (reuse for SABR)
  media-proxy.ts        URL rewriting to the playletmedia scheme
  potoken.ts            token store, expiry, per-identity cache
  invidious.ts          the other backend, driven by playlet-lib's endpoint config
  instances.ts          instance discovery, health probing, failover
src/lib/player/         shaka wrapper, source ladder, SponsorBlock controller
src/lib/stores/         settings (from playlet-lib's preferences.json), library, session, account
src-tauri/src/
  net.rs                api_fetch: runtime host allowlist, SSRF guards, text only
  innertube.rs          InnerTube transport, client profiles, scraped identity
  media.rs              playletmedia:// proxy, closed-range normalisation
  oauth.rs              TV device-code sign-in
  attestation.rs        narrow path to the two BotGuard RPCs
```

Three seams keep the app shell-agnostic: `api/http.ts` (transport), `stores/storage.ts`
(persistence), `shell.ts` (window/power). Nothing under `src/` except `lib/desktop.ts`
imports Tauri.

## 9. Traps that already cost time

- **`api_fetch` decodes bodies as UTF-8.** Never route binary through it.
- **shaka registers no `blob:` scheme.** A blob manifest URL fails before a byte moves;
  use a `data:` URI (chunk the base64 — spreading a large array overflows the stack).
- **googlevideo 403s any request without a *closed* `bytes=start-end` range.** Both a
  missing Range and an open-ended `bytes=0-` are refused. `media.rs::closed_range`
  normalises this; there are unit tests.
- **Svelte 5 reactivity:** `$state` read synchronously inside an `$effect` becomes a
  dependency. A paging variable written after an await re-triggers the effect forever.
  This silently broke search. Keep non-rendered logic state as plain `let`, and use
  `untrack`.
- **Rust:** the re-exported `reqwest` has no `json` feature — serialize and parse by hand.
- **`TaskStop` does not kill grandchild processes.** A stopped `cargo build` leaves
  `rustc` holding the target lock; kill by start time.
- **Don't delete `%APPDATA%\app.playlet.desktop\settings.json`.** It holds the user's real
  subscriptions and watch positions, not test residue. Back it up before any test run that
  launches the app.
