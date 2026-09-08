//! Media keys (Play/Pause, Next, Prev, Stop).
//!
//! These are SYSTEM-WIDE grabs: while registered, Playlet steals the media keys
//! from Spotify, YouTube in Edge, everything. That is why it is a user setting
//! (default on, one checkbox to turn off) and why we unregister when the user
//! disables it. Do NOT register additional plain-letter global shortcuts -- a
//! background app eating "Ctrl+K" system-wide is a support-ticket generator.
//!
//! Proper Windows integration (SMTC: the OS media flyout with artwork, and
//! per-app key routing instead of a global grab) needs
//! Windows.Media.SystemMediaTransportControls via the `windows` crate. That is a
//! v2 item -- it requires a real HWND and a fair bit of COM plumbing.

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
use serde::Serialize;

#[derive(Serialize, Clone)]
struct MediaKeyEvent {
    key: &'static str,
}

const KEYS: &[(Code, &str)] = &[
    (Code::MediaPlayPause, "playpause"),
    (Code::MediaTrackNext, "next"),
    (Code::MediaTrackPrevious, "prev"),
    (Code::MediaStop, "stop"),
];

pub fn register(app: &AppHandle) -> Result<(), String> {
    let gs = app.global_shortcut();
    for (code, name) in KEYS {
        let name = *name;
        let sc = Shortcut::new(None, *code);
        // NOTE: on some tauri-plugin-global-shortcut 2.x releases the handler is
        // `|app, shortcut|` (two args, no ShortcutEvent). If this does not
        // compile, drop the `event` parameter and the state check.
        gs.on_shortcut(sc, move |app, _shortcut, event| {
            // Without this you get two events per physical press (down + up).
            if event.state() == ShortcutState::Pressed {
                let _ = app.emit("media-key", MediaKeyEvent { key: name });
            }
        })
        .map_err(|e| format!("failed to register {name}: {e}"))?;
    }
    Ok(())
}

pub fn unregister(app: &AppHandle) -> Result<(), String> {
    let gs = app.global_shortcut();
    for (code, _) in KEYS {
        let _ = gs.unregister(Shortcut::new(None, *code));
    }
    Ok(())
}

#[tauri::command]
pub async fn set_media_keys_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let state = app.state::<crate::AppState>();
    if enabled == state.media_keys.load(Ordering::Relaxed) {
        return Ok(());
    }
    if enabled {
        register(&app)?;
    } else {
        unregister(&app)?;
    }
    state.media_keys.store(enabled, Ordering::Relaxed);
    Ok(())
}
