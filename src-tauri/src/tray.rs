//! System tray.
//!
//! RECOMMENDATION for v1: build the tray icon, but keep "close to tray" OFF by
//! default. A media app that vanishes into the tray when the user clicks X --
//! and keeps holding the sleep blocker and the media keys -- reads as malware.
//! Windows 11 also hides new tray icons in the overflow chevron by default, so a
//! user who does not know the app is still running has no visible way to find it.
//!
//! Ship it as an opt-in checkbox ("Keep Playlet running in the notification area
//! when closed"). Then the tray earns its place: background audio playback keeps
//! working, and the icon is a real affordance rather than a disappearing act.

use std::sync::atomic::Ordering;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Playlet", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Playlet", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &PredefinedMenuItem::separator(app)?, &quit])?;

    TrayIconBuilder::with_id("playlet-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Playlet")
        .menu(&menu)
        // If this does not compile, your plugin version calls it
        // `menu_on_left_click` (renamed during 2.x).
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => reveal(app),
            "quit" => {
                // Clear the power blocker before exiting.
                app.state::<crate::AppState>().awake.set(false, false);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn reveal(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
pub async fn set_close_to_tray(app: AppHandle, enabled: bool) -> Result<(), String> {
    app.state::<crate::AppState>()
        .close_to_tray
        .store(enabled, Ordering::Relaxed);
    Ok(())
}
