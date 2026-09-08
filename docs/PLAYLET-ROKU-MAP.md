# Map of the Playlet Roku app

How the original (`C:\Users\jonat\Downloads\playlet`) is put together and what drives what.
Built 2026-09-08 by reading the shipped bytes — the sideload channel and every relevant
file inside `lib/playlet-lib.zip`. Version `0.48.00003`, `git_commit_sha=a07d92e`.

Everything below was read from source. Where something is inferred rather than read, it
says so.

**The headline finding is §5:** Playlet does not decipher stream URLs on the device. It
POSTs them to its own backend, which returns URLs with a PoToken already attached. That is
why the Roku app plays full videos and the Windows port stops at 60 seconds.

---

## 1. Two packages, not one

| | sideload channel | `lib/playlet-lib.zip` |
|---|---|---|
| files | 22 | 490 |
| size | ~1 MB (888 KB of it the zip) | 3.2 MB unpacked |
| role | bootstrap only | the entire application |
| manifest title | `Playlet` | `PlayletLib` (`hidden=1`, `sg_component_libs_provided=PlayletLib`) |

The channel exists to locate and load the library. All product code lives in the library,
which is a Roku **ComponentLibrary** — a separately versioned bundle that can be swapped
without reinstalling the channel. This is the app's update mechanism.

## 2. Boot sequence

```
source/Main.brs  Main()
  ├─ roSGScreen + roMessagePort, m.global = screen.getGlobalNode()
  ├─ Logger_Init()
  ├─ Registry_ClearPlayletLibUrlsIfNeeded(args)   ← launch arg `clearPlayletLibUrls`
  ├─ Registry_ClearRegistryIfNeeded(args)         ← launch arg `clearRegistry`
  ├─ screen.CreateScene("BootstrapScene")
  ├─ AppManager_CaptureLastExitInfo(scene)        ← Roku OS 13+ only, guarded
  └─ event loop: roSystemLogEvent | roSGScreenEvent | roSGNodeEvent | roInputEvent
```

`Main` deliberately does *not* signal `AppLaunchComplete`; the library does, "to pass
certification". There is a dead `if false` block holding `args.contentId` / `args.mediaType`
references that exist only to satisfy Roku certification static analysis.

### The four-tier library resolution — `BootstrapScene.brs`

`GetPlayletLibUrls()` returns, in order:

1. **registry override** — `playlet_lib_urls` key in the `Playlet` section, JSON. If
   present it *replaces* the whole list and sets `shouldClearRegistryOnLoadFail`, so a bad
   override self-heals on failure. This is what the companion web app writes to switch
   library versions.
2. `github-squashfs` → `playlet_lib_squashfs_remote_url`
3. `github-zip` → `playlet_lib_zip_remote_url`
4. `embedded-zip` → `playlet_lib_zip_embedded_url` = `pkg:/lib/playlet-lib.zip`

Each is tried by creating a `ComponentLibrary` node and observing `loadStatus`. On
`"ready"` it removes the loader node and calls
`container.createChild("PlayletLib:MainScene")`. On `"failed"` it advances the index. If
all fail, it clears the override and shows an error dialog listing every URL tried.

The manifest also carries `playlet_lib_zip_debug_url` (`http://DEBUG_HOST_IP:8086/...`),
unused in this release build (`bs_const=DEBUG=false`).

## 3. The library's wiring diagram — `components/MainScene.xml`

This one file is the whole object graph. Everything is a declared child, so parentage *is*
the dependency structure:

```
MainScene
├─ Logger
├─ JobQueue
└─ AppController
   ├─ Group#Stack
   │  └─ AppRoot
   │     ├─ AppScreens          ← screen stack
   │     └─ NavBar              ← Profile, Search, Home, Bookmarks, Settings, Remote, Info
   ├─ Clock
   ├─ VideoContainer            ← the player
   ├─ Group#Notifications
   ├─ VideoQueue
   ├─ ApplicationInfo    ─┐
   ├─ Preferences         │
   ├─ BookmarksService    │
   ├─ SearchHistory       ├─ services, all singletons, all siblings
   ├─ ProfilesService     │
   ├─ Innertube           │
   ├─ Invidious           │
   ├─ PlayletWebServer  port="8888"
   ├─ DialServer          │
   ├─ LoungeService       │
   └─ Telemetry          ─┘
```

`MainScene.brs` `Init()` calls `InitializeBindings()` (generated into
`MainScene_bindings.brs`), then on container change runs `AutoBindSceneGraph()`,
`StartWebServer()`, `HideLoadingScreen()`, `InitEcpArgs()`, signals `AppLaunchComplete`.

`StartWebServer()` starts three servers: `LoungeService`, `PlayletWebServer`, `DialServer`.

**AutoBind** (`components/parts/AutoBind/`) is a codegen'd dependency-injection layer —
`*_bindings.brs` files are generated (`InitializeBindings() ' auto-generated!`), which is
why they are uniformly 175 bytes. Nodes declare bindings and get wired by node path at
runtime rather than by manual `findNode` chains.

## 4. Two interchangeable backends

`config/preferences.json5`, key `backend.selected`, type radio, **default `"playlet"`**,
alternative `"invidious"`.

- **`playlet`** — direct InnerTube, `components/Services/Innertube/` (23 files)
- **`invidious`** — `components/Services/Invidious/`, driven by
  `config/invidious_video_api.yaml`

Both normalise into the same shape. `InvidiousToContentNode.brs` (17 KB) and
`NodesParser.brs` (88 KB, the largest file in the app) are the two mappers. The desktop
port's `backend.ts` contract mirrors this split, and its `preferences.json5` is copied from
here verbatim.

## 5. The playback pipeline — why Roku plays and the port does not

Read from `InnertubeService.brs`, `PlayerEndpoint.brs`, `SessionData.brs`, `Context.brs`,
`PoTokens.brs`.

### 5.1 Session identity is scraped from YouTube, not minted

`Innertube_RequestTvClientData()` (`SessionData.brs`) fetches **`https://www.youtube.com/tv`**
with TV headers and extracts, by regex, two escaped JSON strings from the HTML:

- `visitorData`
- `LIVING_ROOM_PO_TOKEN_ID`

Three attempts with 1s/2s backoff. Cached in the registry under `innertube_session_data`,
**fresh for 14 days**. Both come from the *same page load* — they are a matched pair.

> This corrects `STATE-AND-NEXT.md` §4, which claimed `livingRoomPoTokenId` is "minted by
> its own backend (`PLAYLET_SUPPORT_SERVER`), not in the public repo". It is not minted at
> all. It is a public value scraped from `youtube.com/tv`, and any client can obtain it.

### 5.2 The client ladder

`InnertubeService.brs`, max **3** player requests per video:

```
client = "TV"                                    (TVHTML5, cver 7.20260611.00.00)
  │
  ├─ IsSabrLocked(response)? ──→ client = "TV_DOWNGRADED" (cver 5.20260114), retry
  │     purpose: escape SABR and recover legacy adaptive URLs
  ├─ errorCode STS_MISMATCH  ──→ delete tmp:/sts_cache.json, retry
  └─ errorCode RELOAD_PAGE   ──→ delete STS cache, retry once (triedReloadRefresh)
```

`TV_DOWNGRADED` failing to recover URLs is logged as an error but not retried further.

### 5.3 The player request — `Innertube_CreatePlayerRequest`

- headers from `Innertube_CreateHeaders("TV")`: **`x-youtube-client-name: 2`**,
  `x-youtube-client-version: 7.20260611.00.00`, Tizen/SamsungBrowser UA
  > Note: **2**, not 7. `STATE-AND-NEXT.md` §6 asserts "TVHTML5's `x-youtube-client-name`
  > is 7, not 2". Upstream ships **2**.
- `context.client.tvAppInfo.livingRoomPoTokenId` — set when non-empty
- `context.client.visitorData` — set unless an access token is in use
- header `x-goog-visitor-id: <visitorData>` — same condition
- `playbackContext.contentPlaybackContext`: `referer` =
  `https://www.youtube.com/tv#/watch?v=<id>`, `signatureTimestamp`, `html5Preference:
  HTML5_PREF_WANTS`, and for TV **`isLivingRoomDeeplink: true`**
- `attestationRequest: { omitBotguardData: true }`
- `cpn` — a generated client playback nonce
- `Authorization: Bearer <token>` **only** when client is TV/TV_DOWNGRADED — confirms the
  rule already recorded in `STATE-AND-NEXT.md` §5

`request.poTokenIdentity = livingRoomPoTokenId`, and the stored PoToken for *that identity*
is attached. **The PoToken is bound to `livingRoomPoTokenId`, not to `visitorData`**, on
this path.

### 5.4 The backend does the deciphering — this is the crux

`Innertube_DecipherUrls()` does no local crypto. It POSTs to:

```
POST https://playlet-v8556.ondigitalocean.app/v2/decipher
{ sts, formats[], adaptiveFormats[], identity, poToken }
```

and replaces every `url` with the deciphered one returned. Two other endpoints on the same
host: `GET /v1/sts` (signature timestamp, so the device never parses `base.js`) and
`POST /envelope` (Sentry telemetry, `components/Telemetry/Sentry.brs`).

Afterwards `Innertube_HasPotParam()` scans the returned URLs for `&pot=` and records:

- `potSource = "none"` — no `pot` on the URLs
- `potSource = "server"` — `pot` present but the client sent no token → **the backend
  attached its own**
- `potSource = "browser"` — client supplied one

So the Roku app's playback depends on a Playlet-operated service that performs signature/`n`
deciphering *and* can supply a PoToken. That service is the difference between the Roku app
and this port. Nothing in the device code lifts the 60-second limit; the backend does.

### 5.5 The PoToken loop

BrightScript cannot run BotGuard, so minting is delegated to a browser:

```
companion web app (www/, served on :8888)
   │  mints via jnn-pa.googleapis.com, REQUEST_KEY "O43z0dpjhgX20SCx4KAo"
   │  (the same public web BotGuard key the desktop port's minter uses)
   ▼
POST /api/innertube/potoken   {identity, poToken, expiresAt, mintedAt}
   ▼
Innertube_PoTokens_StorePoToken → registry key `innertube_potokens`
   schema { __version: 1, tokens: { identity: {token, expiresAt, mintedAt} } }
   ▼
PlayerEndpoint reads it for identity = livingRoomPoTokenId
```

Also `GET /api/innertube/potoken`, `DELETE /api/innertube/potoken/all`. The Settings entries
`dev.mint_potoken` and `dev.clear_potokens` drive it and are `visibility: "off"` — hidden
developer controls.

## 6. The companion web server

`PlayletWebServer` on **:8888** — a full HTTP/1.1 + WebSocket server written in
BrightScript (`components/Web/WebServer/`, 20 files: `HttpServer`, `HttpConnection`,
`HttpRequest/Response/Router`, `WebSocketServer/Connection/Frame`, CORS and ETag
middleware, static file router).

Routers layered on top (`components/Web/PlayletWebServer/Middleware/`, 19):
`Home`, `StateApi`, `Dash`, `Hls`, `Innertube`, `Invidious`, `Bookmarks`, `Preferences`,
`Profiles`, `Registry`, `SearchHistory`, `VideoQueue`, `HomeLayout`, `Cache`, `Dial`,
`PlayletLibUrls`, `PlayletInvidiousBackend`, `View`.

`www/` holds the built companion SPA, gzipped (`index.html.gz`, `assets/*.js.gz`) — the
"Remote" nav item. `DashRouter`/`HlsRouter` mean the device also *serves* manifests, and
`Services/Dash/DashManifest.brs` (37 KB) generates them locally — the same role as the
port's `innertube-dash.ts`.

`DialServer` implements DIAL discovery, and `LoungeService` (13 files, `LoungeApi.brs`
27 KB) implements YouTube's Lounge protocol — this is "cast from your phone". It carries
`credentialTransferTokens` with `scope: "VIDEO"` into the player context, a per-video
credential handoff from the casting device. The port has none of this.

## 7. Supporting systems

- **JobSystem** (`components/JobSystem/`, 34 files) — Roku has no threads other than
  `Task` nodes, so this is a job queue over them: `JobQueue`, `JobQueueTask`, `JobTask`,
  `BaseJob`, `JobRequest`, plus a `generated/` directory. Jobs seen: `LatestLibVersionJob`,
  `InnertubeSessionDataJob`, `ClearCacheJob`, `SponsorBlockSegmentsJob`,
  `SponsorBlockSegmentViewedJob`, `ProfilesVerifyTokensJob`,
  `ProfilesInvidiousUnregisterTokenJob`, `LoungeGenerateManualPairingCodeJob`.
- **`source/Protobuf/`** — `BinaryReader/Writer`, `Encoder/Decoder`. Used for InnerTube
  search filter params (`protos/params.proto.gen.brs`), the same job as the port's
  `innertube-params.ts`.
- **`source/QrCode/`** — full QR generator, for device pairing / the Remote screen.
- **`source/services/HttpClient.brs`** — the HTTP layer everything routes through;
  supports `Cancellation`, `Await`, `NoCache`, `ToCurlCommand`.
- **`source/utils/`** (25 files) — the shared standard library.
- **`config/`** — `preferences.json5` (the settings schema, both `tv` and `web` variants
  per key), `sponsorblock_config.json5`, `invidious_video_api.yaml`,
  `default_home_layout.yaml`, `http-codes.json5`, `mime-types.json5`,
  `ISO-639-1-to-ISO-639-2T.json5`. The port copies several of these verbatim.
- **`locale/`** (289 KB) — translations.
- **Telemetry** — Sentry, gated by `dev.diagnostics.enabled` (default **true**).

## 8. What this means for the Windows port

Nothing here has been changed. This is analysis only.

The port already mirrors the right structure: dual backend, InnerTube service, DASH
generation, protobuf params, SponsorBlock, the same `preferences.json5`. What it lacks is
the two things that actually make playback work:

1. **A decipher service.** Playlet's device code never deciphers a URL. If the port is to
   match, it needs either its own equivalent, or to do signature/`n` descrambling locally.
2. **A PoToken bound to `livingRoomPoTokenId`** — obtained by scraping `youtube.com/tv`,
   minted with the *same public BotGuard key the port's minter already uses*.

### The concrete untested path

Every ingredient below is reachable without any Playlet infrastructure:

1. `GET https://www.youtube.com/tv` with TV headers → regex out `visitorData` **and**
   `LIVING_ROOM_PO_TOKEN_ID` (matched pair, cache 14 days)
2. Mint a BotGuard PoToken bound to **`livingRoomPoTokenId`** (not `visitorData`)
3. `/player` as TVHTML5: `x-youtube-client-name: 2`, cver `7.20260611.00.00`,
   `tvAppInfo.livingRoomPoTokenId`, `isLivingRoomDeeplink: true`,
   `attestationRequest.omitBotguardData: true`, `x-goog-visitor-id`, real STS
4. If SABR-locked, downgrade to cver `5.20260114`
5. Attach `pot` to the resulting URLs

The earlier TVHTML5 attempts recorded in `STATE-AND-NEXT.md` §4 failed, but they were
missing pieces 1 and 2 — the doc believed `livingRoomPoTokenId` was unobtainable, and the
tested `visitorData` values came from other sources rather than the same `/tv` page load.
That makes this genuinely untested, not a repeat.

**Verify it the way everything else here is verified: play past 60 seconds.**

### Licence

AGPL-3.0, `Copyright (C) 2025 Brahim Hadriche`. The port is a derivative work and is
already AGPL-3.0. Note that `/v2/decipher` is someone else's infrastructure and cost —
using it from a third-party app is a question to put to upstream, not an assumption to
make.
