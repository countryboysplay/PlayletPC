# The direct YouTube (InnerTube) backend

This is the app's default backend. It talks to YouTube's own private API and maps the
responses onto Invidious shapes, so no component knows which backend is in use.

Everything below was **measured against the live API** on 2026-09-08, not taken from
documentation or memory. Re-run the probes in `docs/INNERTUBE.md` § Re-testing before
changing any client choice — YouTube moves.

## Why this exists

The public Invidious network has largely stopped serving video. Of 28 well-known public
instances probed, one answered the API at all, and that one returned HTTP 500
*"This instance doesn't support using Invidious like this currently"* for every video.
Browsing worked; playback did not.

## Client selection

`/youtubei/v1/player` for `aqz-KE-bpKQ`, from a residential desktop connection:

| Client | Status | Formats | Ciphered | Notes |
|---|---|---|---|---|
| **IOS** | **OK** | **32** | **0** | direct URLs, no `n` param, streamed 2160p60 at 5.6 MB/s |
| TVHTML5 | LOGIN_REQUIRED | 0 | — | "Sign in to confirm you're not a bot" |
| TVHTML5_SIMPLY_EMBEDDED | ERROR | 0 | — | "no longer supported in this application" |
| ANDROID_VR | LOGIN_REQUIRED | 0 | — | same bot check |
| WEB | UNPLAYABLE | 0 | — | needs a PoToken |
| WEB_EMBEDDED_PLAYER | ERROR | 0 | — | "video is unavailable" |

**IOS is the only client that returns playable URLs without attestation**, and it returns
them *unciphered* and without an `n` parameter — so no signature deciphering is needed
anywhere in this app.

It is, however, subject to the streaming cap documented below, which is why PoToken
minting exists here after all. Deciphering and attestation are separate problems: we
avoid the first entirely and solve the second locally.

### What upstream Playlet does, and why we differ

The Roku app uses **TVHTML5** for playback and offloads signature timestamp and
deciphering to a hosted service (`playlet-v8556.ondigitalocean.app`, not in the public
repo). That works from real Roku hardware, which presents genuine device credentials.

From a Windows PC, TVHTML5 returns the bot check regardless of user-agent (tested with
both PlayStation and Roku UA strings) and regardless of signature timestamp. Matching
upstream exactly therefore means either depending on someone else's server or
implementing BotGuard locally. Only the second is compatible with one self-contained
installer, so that is the route taken — see the streaming cap section below.

`tv` remains in the ladder and is preferred whenever a valid PoToken is available.

### The ladder

`src/lib/api/innertube.ts` walks `['ios', 'android_vr', 'tv', 'web_embedded']` and takes
the first client returning a response with usable stream URLs. A client that refuses the
video, or returns only ciphered formats, is skipped. This means a future lockdown of any
single client degrades the app rather than breaking it.

## The 20MB streaming cap

This is the single most important constraint in the app, and it is why playback of a
long or high-bitrate video stops.

**googlevideo serves roughly the first 20MB of each format, then answers 403 forever.**
Measured 2026-09-08, video `FPsDC1cclVI`, sequential 2MB ranges:

| chunk size | delivered before 403 |
|---|---|
| 256KB x 40 | 10MB, no failure (never reached the cap) |
| 2MB x 16 | **20MB**, blocked at request 11 |
| 8MB x 8 | **16MB**, blocked at request 3 (the next read would exceed 20MB) |

What the cap is **not**:

- **Not a rate limit.** Waiting 5, 15, 30 and 60 seconds and retrying the same range all
  returned 403.
- **Not per-URL.** A brand new URL from a fresh `/player` call is *also* 403 at the same
  high offset - while that same new URL happily serves `bytes=0-2097151`. So refreshing
  the URL does not help, and the proxy no longer wastes a player request trying when the
  read is already past the cap.
- **Not about the request shape.** Identical results for the `Range` header, a `&range=`
  query parameter, `&rn=`/`&rbuf=`, and appending `&cpn=`.
- **Not about client identity.** Upstream Playlet's request was emulated byte-for-byte -
  iOS 21.16.2, its exact `CreateContextClientIOS` context, `cpn`, the full
  `contentPlaybackContext`, `attestationRequest`, and its Firefox `VIDEO_PLAYER_USER_AGENT`
  for media - and the cap was unchanged.

It **is** per format: after exhausting itag 248, itag 137 still served 12MB.

Consequences, since 20MB buys a different amount of time at each bitrate:

| quality | approx. playable before the cap |
|---|---|
| 2160p (~26 Mbps) | ~5 seconds |
| 1080p (~2.5 Mbps) | ~60 seconds |
| 720p (~1 Mbps) | ~2-3 minutes |
| 360p (~0.5 Mbps) | ~5 minutes |

### Why the Roku app is unaffected

`PlayerEndpoint.bs` sends `attestationRequest: { omitBotguardData: true }` together with
`context.client.tvAppInfo.livingRoomPoTokenId`, and `PoTokens.bs` stores tokens keyed by
identity (`visitorData`). The TVHTML5 client is not capped **when it presents a valid
PoToken**. Playlet obtains that token outside the app - from its own backend, or minted
by its companion web app and POSTed to the device at `/api/innertube/potoken`.

Without a token, TVHTML5 answers `LOGIN_REQUIRED` / "Sign in to confirm you're not a
bot" - confirmed with Playlet's exact TV context and both of its client versions
(`7.20260611.00.00` and the downgraded `5.20260114`).

So lifting the cap requires minting a PoToken, which is why this app does it locally.

## Endpoint / client split

| Purpose | Endpoint | Client | Why |
|---|---|---|---|
| Playback | `player` | ladder (IOS first) | only source of direct URLs |
| Search | `search` | WEB | IOS returns opaque `elementRenderer` blobs (1.8 MB vs 270 KB) |
| Channels, playlists | `browse` | WEB | IOS browse returns nothing usable |
| Recommendations | `next` | WEB | IOS `/next` is ~9 MB with no parseable renderers |

## YouTube retired Trending

Every `FEtrending` browse id now answers **HTTP 400**, with any client, any client
version, with or without `visitorData`. The shipped Roku home layout has three rows that
depend on it (Trending-Live, Trending-Gaming, Popular).

`FEwhat_to_watch` (Recommended) is also empty for a signed-out client, with or without a
consent cookie, and `FEexplore` / `FEtopics_music` answer 400. So on the direct backend
there is no editorial feed at all: Home is built from the user's own subscriptions and
watch history, with a first-run prompt to search.

## Client identity is scraped, not hardcoded

`innertube.rs` scrapes `INNERTUBE_CLIENT_VERSION` and `visitorData` from the YouTube home
page and caches them for 6 hours. This is not cosmetic: a stale web client version makes
`browse` calls start answering HTTP 400. The TypeScript client retries once through
`yt_refresh_identity` when it sees a 400, so version drift self-heals.

## Security boundary

`yt_innertube` is a separate Rust command from the generic `api_fetch` because InnerTube
needs per-client `User-Agent` and `X-YouTube-Client-*` headers, which `api_fetch`
deliberately refuses to let the renderer set. The command:

- accepts only the endpoints `player`, `search`, `browse`, `next`, `resolve_url`
- always targets `https://www.youtube.com/youtubei/v1/`, never a caller-supplied host
- builds the client context itself; the renderer supplies only the payload fields
- caps responses at 32 MB (channel browse responses reach ~8 MB)

## Re-testing

The probe scripts used to produce the table above are throwaway but worth recreating if
a client stops working. The shape:

1. POST `https://www.youtube.com/youtubei/v1/player` with
   `{ context: { client: {...} }, videoId, contentCheckOk: true, racyCheckOk: true }`
2. Set `User-Agent`, `X-YouTube-Client-Name`, `X-YouTube-Client-Version` to match the client
3. Check `playabilityStatus.status`, then count `streamingData.adaptiveFormats` entries
   having `url` vs `signatureCipher`
4. Range-request a returned URL to confirm it actually delivers bytes — a URL that exists
   is not the same as a URL that streams
