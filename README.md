# Playlet for Windows

An ad-free, tracking-free YouTube client for Windows 11. This is a desktop port of
[Playlet for Roku](https://github.com/iBicha/playlet) by iBicha.

The original is written in BrightScript and runs only on Roku hardware. This port keeps
its behaviour — the same API contract, the same preference schema, the same SponsorBlock
defaults — but runs natively on Windows as a Tauri app with a Svelte front end.

## What works

- **Home** — Continue watching and your subscriptions; on the Invidious backend, the
  shelf layout from Playlet's own `default_home_layout.json`
- **Search** — with sort, type and duration filters, plus infinite scroll
- **Channels** — videos, shorts and live tabs, with local subscriptions
- **Playlists** — browse and play through
- **Watch** — adaptive DASH playback with quality selection, captions, and keyboard
  control. **Currently limited to roughly the first minute of a video** by a YouTube-side
  cap; see `docs/STATE-AND-NEXT.md`
- **SponsorBlock** — per-category skip / ask / mark-only, using the privacy-preserving
  hash-prefix API so the server never learns which video you are watching
- **History** — resume where you left off, stored locally
- **Two backends** — YouTube directly (default, no third-party server) or an Invidious
  instance, with health probing and automatic failover

Subscriptions, watch history and settings are stored only on this PC, in
`%APPDATA%\app.playlet.desktop\settings.json`. Nothing is sent anywhere except to
YouTube (or the Invidious instance you choose) and to SponsorBlock — and SponsorBlock is
queried by a hash prefix, so it never learns which video you are watching.

## Build

Requires Node 20+, Rust (MSVC toolchain), and the Visual Studio C++ Build Tools.

```
npm install
npm run desktop          # run in development
npm run desktop:build:nsis   # produce the installer
```

The installer lands in
`src-tauri/target/release/bundle/nsis/Playlet_<version>_x64-setup.exe`.

It installs per-user, so it needs no administrator rights. It is **unsigned**, so
SmartScreen will show "Windows protected your PC" on first run — choose *More info* →
*Run anyway*. Signing requires a code-signing certificate; see `docs/PACKAGING.md`.

## Start here

**`docs/STATE-AND-NEXT.md`** is the handoff document: current state, the one thing that is
broken, every hypothesis already disproved (so they are not retried), and the plan for the
committed next step — building the SABR/UMP playback path.

`docs/INNERTUBE.md` holds the measurements behind the backend's design decisions.

## Tests

```
npm test          # 334 assertions against captured YouTube responses (offline)
npm run test:live # 18 assertions against YouTube right now (needs network)
npm run check     # typecheck the app
```

`tests/fixtures/` holds real InnerTube responses captured 2026-09-08. The live suite runs
the actual production path — player request, response mapping, DASH generation — and
asserts the manifest reaches 2160p with every segment URL routed through the media proxy.

## Architecture

```
src/lib/api/        Backends: InnerTube (direct YouTube) and Invidious, behind one contract
src/lib/player/     Playback: shaka-player, source selection, SponsorBlock controller
src/lib/stores/     Settings, subscriptions, history, session
src/lib/data/       Config files lifted verbatim from playlet-lib
src-tauri/          Rust shell: window, network allowlist, InnerTube transport, persistence
```

Three seams keep the app shell-agnostic: `api/http.ts` (transport), `stores/storage.ts`
(persistence) and `shell.ts` (window and power). Nothing under `src/` outside
`lib/desktop.ts` imports Tauri, so the app also runs in a plain browser with `npm run dev`.

### Why network requests go through Rust

Public Invidious instances set CORS headers inconsistently, and the user picks the
instance at runtime — so browser `fetch` would work on some instances and fail on others
with an error indistinguishable from the host being down. All JSON therefore goes through
a Rust command that sends no `Origin` and does no preflight.

That command enforces a **runtime** host allowlist (fixed infrastructure hosts plus
instances the user has actually configured) rather than a compile-time `https://*` scope.
It also blocks private and loopback addresses unless the user explicitly added them,
refuses cloud metadata endpoints, restricts methods and request headers, and caps
response bodies. Media is deliberately excluded: `<video>` and `<img>` load their URLs
directly, because routing binary segments through that command would corrupt them.

## Backends

Playlet has two, switchable in Settings:

**YouTube, directly (default).** Talks to YouTube's own InnerTube API and maps the
responses onto Invidious shapes, so no UI code knows the difference. No third-party
server, nothing to go down. This mirrors what the upstream Roku app does by default.

Client selection was measured against the live API, not assumed — see
`docs/INNERTUBE.md` for the full table. The short version: the **IOS** client returns
direct, *unciphered* stream URLs with no `n` parameter and no PoToken requirement, which
is why this app ships no JavaScript engine, no BotGuard machinery, and no external
decipher service, and still fits in one ~4 MB installer. Playback walks a client ladder
(`ios → android_vr → tv → web_embedded`) so a future lockdown of any single client
degrades rather than breaks it.

**Through Invidious.** A public or self-hosted instance, with health probing and
automatic failover. Kept because a self-hosted instance is a legitimate setup, but be
aware the public network is in poor shape: of 28 well-known instances probed, one
answered the API, and that one refused every video with *"This instance doesn't support
using Invidious like this currently"*.

## Known limitations

- **No account linking.** Subscriptions, history and resume points are stored locally
  and are not synced to a YouTube or Invidious account. The Invidious auth endpoints are
  implemented in the client but not wired to a login flow.
- **No comments view.** The direct backend returns an empty comment list rather than
  pretending to fail; the UI has no comments surface yet.
- **No editorial home feed on the direct backend.** YouTube retired Trending (every
  `FEtrending` browse id answers HTTP 400) and the signed-out Recommended feed
  (`FEwhat_to_watch`) comes back genuinely empty, with or without a consent cookie;
  `FEexplore` and `FEtopics_music` 400. So Home is built from what you actually have —
  Continue watching and your subscriptions — with a first-run prompt to search before
  either exists. The Invidious backend still uses the shipped Roku row layout.
- **Stream URLs decay.** googlevideo URLs are IP-bound and expire within hours, so
  playback can fail mid-video. Player responses are cached for 20 minutes at most, and
  the player can reload and resume at the current position.
- **Unsigned installer**, so SmartScreen warns on first run.
- **No casting or DIAL support.**

## Licence

AGPL-3.0-or-later, inherited from upstream Playlet. This port includes configuration files
copied verbatim from `playlet-lib` and reimplements its behaviour, so it is a derivative
work and carries the same licence. See `LICENSE`.

Playlet is © iBicha and contributors. This port is not affiliated with or endorsed by
YouTube or Roku.
