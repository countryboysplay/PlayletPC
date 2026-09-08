# Where this project stands, and what to do next

Last updated: 2026-09-08 (second revision). Written as a handoff — read this before
touching playback.

**SABR/UMP is now built and measured. It does not lift the 60-second wall.** The wall is
not a property of the legacy `videoplayback` transport, as this document previously
assumed — it is an *attestation boundary* that applies identically to SABR, and the server
says so out loud. Section 6 has the evidence and the revised plan.

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
npm run test:live            # 18 assertions against live YouTube
npm run check                # svelte-check, 165 files
cd src-tauri && cargo test --bin playlet-desktop   # 9 Rust tests
```

## 2. What works today

- **Browsing is complete and solid.** Search (with protobuf-encoded filters), channels
  (videos/shorts/live tabs, continuations), playlists, recommendations, watch history,
  local subscriptions, resume positions, settings — all verified against live YouTube.
- **SponsorBlock** — hash-prefix API, per-category skip/ask/mark, 24 passing controller
  tests covering seek-back, overlaps, `poi_highlight`, `full`, mute.
- **The whole InnerTube pipeline** — Rust transport with scraped client identity, the
  response mapper (242 fixture assertions), the DASH manifest generator (92 assertions),
  and the media proxy.
- **Playback starts and renders**, at up to 2160p, with a locally generated manifest.

## 3. The one thing that is broken

**YouTube serves only the first ~60 seconds of media, on every transport tested.**
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

## 4. Hypotheses already disproved — do not repeat these

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
| **SABR/UMP lifts the cap** | **No.** Implemented and working (§6) — and capped at the same exact 60.000 s. The cap is not transport-specific. |
| A PoToken lifts it *on SABR* | No — identical with and without, in both the SABR body and `serviceIntegrityDimensions`. But this one is a *class mismatch*, not a dead end: our token is WEB-class and the client was IOS. See §6. |
| Waiting clears the SABR stall | No — 73 s of wall clock across six retries, zero further media. Not a rate limiter. |

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

## 5. Sign-in: currently pointless

The TV device-code OAuth flow is fully implemented and works (`src-tauri/src/oauth.rs`,
`src/lib/stores/account.svelte.ts`, panel in Settings). It mints real tokens.

**It buys nothing for playback** and costs privacy — watching becomes attributable to the
Google account. Confirmed against the Roku app, which plays full videos signed in *or*
signed out: an account is not the missing ingredient, and no amount of sign-in work will
lift the 60-second wall.

Sign-in's real value is what it is on Roku — a convenience that gives quick access to your
subscriptions and playlists. Worth finishing for that reason once playback works, not
before. Note the authenticated feeds are still stubbed (below).

Hard-won detail worth keeping: **the token must go ONLY to the TV client.** An
`Authorization` header on a WEB `/search` or IOS `/player` returns HTTP 401 "Request had
invalid authentication credentials". Sending it everywhere broke search and playback
once already. Encoded in `innertube.ts` as `client === 'tv' ? token : undefined`, and
upstream states the same rule as `useAccessToken = isTv and ...`.

Authenticated feeds (`FEsubscriptions`, `FElibrary`, `FEhistory`) are **deliberately
stubbed to return `[]`**. They need the TV client (the only one the token works for), and
TV browse uses living-room renderers this app's mapper has never been verified against. A
guessed mapper would return an empty list indistinguishable from "you have none".

## 6. SABR/UMP: built, working, and not the answer

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

### Where that leaves the next step

The honest summary: **transport is solved, attestation is not, and no reachable client
identity avoids the gate.** This is the ceiling for a public, unattested desktop app.

1. **Do not ship 60-second playback.** Stating it plainly so nobody mistakes the current
   state for progress. Browsing is genuinely good; playback is not usable.
2. **The gate is a client-matched device attestation.** Playlet on Roku clears it because
   it holds one — `livingRoomPoTokenId`, minted by its own backend
   (`PLAYLET_SUPPORT_SERVER`, not in the public repo, §4). That is the difference, and it
   is not something this app can mint. Worth confirming with upstream rather than
   re-deriving it: an honest question to iBicha about what a third-party client is
   expected to do here would likely save more time than any further probing.
3. **Exhausted, do not repeat:** every transport, every client identity, both PoToken
   slots, sign-in, and waiting. §4 has the full list.

Two things that would still be worth doing regardless of how attestation resolves:

- Port the UMP parser and ABR request builder into `src/` anyway. They are correct, tested
  against real captures, and will be needed the moment the gate opens — SABR is what
  YouTube serves now, and the legacy path is being retired.
- Keep `tools/sabr/` runnable. It is the cheapest way to re-test whether the boundary has
  moved, which it may, since this is policy rather than protocol.

Note for whoever picks this up: Playlet on Roku plays full videos whether or not you are
signed in, so an account is definitively not the missing ingredient. Sign-in is a
convenience for subscriptions and playlists, nothing more (§5).

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

## 7. Map of the code

```
src/lib/api/
  backend.ts            the contract both backends satisfy
  innertube.ts          direct YouTube client, client ladder, manifest attach
  innertube-map.ts      InnerTube JSON -> Invidious shapes (242 assertions)
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

## 8. Traps that already cost time

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
