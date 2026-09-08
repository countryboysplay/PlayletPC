# Windows integration — what ships in v1

Ranked by user-visible value per hour of work.

## 1. Single instance (must-have, 10 minutes)

`tauri_plugin_single_instance` — **must be the first plugin registered**, before
anything that creates windows. The second launch's `argv` is forwarded to the
running app and re-emitted as a `second-instance` event, which is also how a
`playlet://` link or a pasted URL reaches the already-running window.
Frontend: `initDesktop({ onDeepLink })` in `src/lib/desktop.ts`.

Without it: double-clicking the Start Menu tile a second time opens a second
Playlet with a second WebView2 process and a second copy of the store — and the
two will silently overwrite each other's `settings.json`.

## 2. Remembered window size/position (must-have, 10 minutes)

`tauri_plugin_window_state` with `POSITION | SIZE | MAXIMIZED`.

Non-obvious part: the main window is declared `"visible": false` in
`tauri.conf.json` and shown in `setup()` **after** the plugin has restored the
bounds. Without that, users see the window appear centred at 1360×820 and then
jump to its remembered position — a cheap-looking flash on every launch.

The plugin also handles the case where the remembered monitor is gone (docked
laptop, now undocked) by clamping onto a visible monitor. Do not hand-roll this.

## 3. Prevent sleep during playback (must-have, 30 minutes — has a real trap)

`src-tauri/src/power.rs`. The trap is worth restating:

> `SetThreadExecutionState` is **per-thread**, and the OS drops the state when
> that thread exits. Tauri commands run on a tokio worker thread that can be
> parked or retired at any moment. Calling the API directly inside a
> `#[tauri::command]` works in a 30-second test and then silently stops
> preventing sleep 40 minutes into a film.

So a dedicated named thread (`playlet-keepawake`) owns the state and receives
`Wake { system, display }` over a channel. Flags:

- video playing → `ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED`
- audio-only playing → `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` (let the screen sleep)
- paused/stopped/closed → `ES_CONTINUOUS` alone (resets to normal policy)

Frontend binding is `bindPlayer(videoEl)`, which hooks `play/playing/pause/ended/
emptied` **and** `beforeunload`, and clears the blocker in its disposer. A leaked
blocker means the machine never sleeps again until reboot — treat forgetting the
disposer as a P1 bug, and also clear it in the window `CloseRequested` handler
and the tray Quit item (both done in `main.rs` / `tray.rs`).

## 4. Media keys (nice-to-have, 30 minutes — user-visible cost)

`tauri_plugin_global_shortcut` registering `MediaPlayPause`, `MediaTrackNext`,
`MediaTrackPrevious`, `MediaStop`; Rust emits a `media-key` event.

Two things to get right:

- Filter on `ShortcutState::Pressed`, or every physical press fires twice
  (down + up) and play/pause toggles back to where it started.
- These are **system-wide grabs**. While registered, Playlet steals the media
  keys from Spotify and from YouTube in Edge, even when Playlet is in the
  background. Ship it as a setting (default on, one checkbox off) and actually
  call `unregister` when it's turned off — `set_media_keys_enabled` does this.

What this is *not*: the Windows media flyout with artwork, title, and proper
per-app key routing. That is SMTC
(`Windows.Media.SystemMediaTransportControls`), which needs the `windows` crate,
a real HWND, and COM plumbing. It is the right v2 upgrade — it removes the
global-grab rudeness entirely — but it is a day of work, not an hour.

## 5. System tray (recommended: build it, default it off)

`src-tauri/src/tray.rs` builds the icon + menu (Show / Quit), left-click reveals.

The judgement call is **close-to-tray**, and the answer for v1 is *off by
default*, exposed as "Keep Playlet running in the notification area when
closed":

- A media app that vanishes when you click X — while still holding the sleep
  blocker and the media keys — reads as malware.
- Windows 11 hides new tray icons behind the overflow chevron by default, so a
  user who didn't expect it has no visible way to find the app again.
- Once it's opt-in, the tray earns its place: background audio keeps playing and
  the icon is a real affordance.

The Quit menu item must clear the power blocker before `app.exit(0)` — it does.

## Deferred to v2 (deliberately)

- **`playlet://` protocol registration.** `second-instance` already delivers the
  argv, but *registering* the scheme with Windows needs
  `tauri-plugin-deep-link` plus an NSIS registry hook. Cheap, but it is not
  needed to watch a video.
- **Jump List** (recent videos on the taskbar right-click) and taskbar progress —
  both need the `windows` crate + COM.
- **Picture-in-picture**: WebView2 supports the Document PiP API; it's a frontend
  feature, no Rust involved. Cheapest "feels native" win available after v1.
- **Start with Windows**: `tauri-plugin-autostart`. Only worth it once
  close-to-tray exists and is being used.
