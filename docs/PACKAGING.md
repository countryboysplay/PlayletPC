# Packaging — Playlet Desktop (Tauri v2 → NSIS)

## Prerequisites on this machine

1. **Visual Studio Build Tools 2022** with the *Desktop development with C++*
   workload (this gives you `link.exe` and the Windows 10/11 SDK). The Rust MSVC
   toolchain cannot link without it.
2. **Rust (MSVC)**: `rustup default stable-x86_64-pc-windows-msvc`
   Verify: `rustc -Vv` must print `host: x86_64-pc-windows-msvc`.
   If it prints `-gnu`, Tauri will fail in confusing ways — switch it.
3. **WebView2 Runtime** — already present on Windows 11. The installer config
   uses `downloadBootstrapper`, so end users on older Windows get it pulled in
   silently at install time (adds ~0 MB to your installer).
4. `npm install` (Node 24 / npm 11 are fine).

Sanity check before anything else: `npx tauri info`. It prints the toolchain,
WebView2 version, and every plugin version mismatch in one screen.

## Build commands

```powershell
# one-time: icons from the Roku poster (must be a SQUARE png, >= 1024x1024)
npm run desktop:icons          # tauri icon ./assets/playlet-icon.png

# dev loop (vite HMR + rust hot restart)
npm run desktop:dev

# release installer
npm run desktop:build:nsis     # tauri build --target x86_64-pc-windows-msvc --bundles nsis
```

The first release build compiles the whole Rust dependency tree: **8–20 minutes**
on a laptop. Subsequent builds are ~40 s. Do not kill it because it "hung" at
`Compiling windows-sys`.

## Where the artifacts land

```
src-tauri/target/release/playlet-desktop.exe                                  <- raw binary, runs standalone
src-tauri/target/release/bundle/nsis/Playlet Desktop_0.1.0_x64-setup.exe      <- THE INSTALLER
src-tauri/target/release/bundle/nsis/Playlet Desktop_0.1.0_x64-setup.nsis.zip <- updater artifact (createUpdaterArtifacts)
src-tauri/target/release/bundle/nsis/*.nsis.zip.sig                           <- signature, only if TAURI_SIGNING_PRIVATE_KEY was set
```

With `--target x86_64-pc-windows-msvc` explicitly passed, the path gains a target
segment: `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`. Both are
normal; the `tauri build` output prints the exact path — read it, don't guess.

Installer size: expect **3–6 MB**. Installed footprint ~12 MB. (Electron
equivalent: ~85 MB installer, ~250 MB installed.)

## Installer behaviour (as configured)

- `installMode: "currentUser"` → per-user install to
  `%LOCALAPPDATA%\Playlet Desktop`, **no UAC prompt**. This matters a lot for an
  unsigned app: a per-machine install triggers both a UAC elevation prompt *and*
  the SmartScreen warning, which is two scary dialogs instead of one.
- Start Menu folder `Playlet`, desktop shortcut offered by the NSIS template.
- Uninstaller registered in Apps & Features.
- App data lives at `%APPDATA%\app.playlet.desktop\` (store `settings.json`,
  window state) — **survives uninstall**, which is what you want for
  subscriptions/history.

## SmartScreen, unsigned

Be precise about what the user will see, because this is the single biggest
first-impression problem:

1. Chromium/Edge marks the downloaded `.exe` with Mark-of-the-Web.
2. On first run: **"Windows protected your PC — Microsoft Defender SmartScreen
   prevented an unrecognized app from starting"**, with only a `Don't run`
   button visible. The user must click **More info → Run anyway**. Most people
   won't. Roughly 20–40 % of your would-be installs die here.
3. Defender may also flag the binary for a cloud scan on first launch (a few
   seconds' delay). False-positive detections on brand-new unsigned Rust binaries
   do happen — submit to Microsoft if it hits you.

Your options, honestly ranked:

| Option | Cost | Effect |
|---|---|---|
| Ship unsigned | $0 | SmartScreen warning forever; reputation never accrues for an unsigned binary |
| **OV code-signing cert** (Sectigo/DigiCert, via a cloud HSM — since Jun 2023 keys must be on FIPS hardware) | ~$200–400/yr | Warning disappears after the binary accrues download reputation (days to weeks, per signing identity, not per build) |
| **EV code-signing cert** | ~$400–700/yr | Immediate SmartScreen trust, no reputation-building period |
| Ship via **winget** / Microsoft Store | free-ish | Bypasses the download-and-run path entirely; winget still wants a signed installer for the manifest to be pleasant |

Mitigation while unsigned: publish the SHA-256 of the installer next to the
download, put a screenshot of the SmartScreen dialog with a "click More info →
Run anyway" caption on the download page, and *never* tell users to disable
Defender.

Signing later requires **no code change** — add to `bundle.windows`:
`"certificateThumbprint"`, `"digestAlgorithm": "sha256"`,
`"timestampUrl": "http://timestamp.digicert.com"`, or point
`"signCommand"` at `azuresigntool`/`signtool` for cloud-HSM keys.

## Wiring the updater (do this before v1.0, not after)

The updater is the one component that cannot fix itself, so set it up while the
user base is you.

```powershell
# 1. Generate the signing keypair. Guard the private key + password like a cert.
npm run updater:keygen              # writes .tauri/playlet-updater.key(.pub)

# 2. Put the PUBLIC key into tauri.conf.json -> plugins.updater.pubkey
#    (replace PASTE_OUTPUT_OF_...). Never commit the private key.

# 3. Build with the private key in the environment so .sig files are produced:
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content .tauri/playlet-updater.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<the password>"
npm run desktop:build:nsis
```

Then host a `latest.json` at the `endpoints` URL:

```json
{
  "version": "0.2.0",
  "notes": "SponsorBlock category settings, faster instance failover",
  "pub_date": "2026-09-08T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<contents of the .nsis.zip.sig file, inline>",
      "url": "https://github.com/YOU/playlet-desktop/releases/download/v0.2.0/Playlet.Desktop_0.2.0_x64-setup.nsis.zip"
    }
  }
}
```

Rules that keep the updater trustworthy:

- **Staged rollout**: the endpoint can be a tiny worker that serves the new
  `latest.json` to 1 % of requesting clients for 24 h, then 10 %, then 100 %.
  Rollback = re-publish the previous `latest.json`; clients that already updated
  stay put (`allowDowngrades: false`), which is why you stage *before* widening.
- `windows.installMode: "passive"` shows a progress bar but needs no clicks. The
  app must restart to apply — never do that mid-playback; prompt instead.
- Test the update path from a *real installed build*, not from `tauri dev`. The
  updater is a no-op in dev.
- The app checks ~8 s after first paint (`app_ready` → `check-for-updates`), not
  at launch, so it never competes with the first video for bandwidth.

## Footprint budget to enforce from week one

| Metric | Budget | How to check |
|---|---|---|
| Installer size | < 8 MB, no silent +5 % per release | compare the `.exe` byte size against the previous tag |
| Cold start to first paint | < 1.5 s | `app_ready` timestamp vs process start |
| Idle memory (all processes) | < 180 MB | Task Manager → Details, sum `playlet-desktop.exe` + `msedgewebview2.exe` children |
| Idle CPU with no video | ~0 % | it should be exactly 0 — if not, you left a timer running |
