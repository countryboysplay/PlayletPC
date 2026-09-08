// Playlet Desktop -- privileged process.
// Hide the console window in release builds (otherwise every launch flashes a cmd window).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod attestation;
mod innertube;
mod media;
mod oauth;
mod net;
mod power;
mod shortcuts;
mod tray;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_store::StoreExt;

pub const SETTINGS_STORE: &str = "settings.json";

/// Everything the privileged side owns. The webview can only reach this through
/// the commands listed in `invoke_handler` below -- that list IS the API surface.
pub struct AppState {
    pub http: net::HttpClient,
    pub allow: net::HostAllowlist,
    pub innertube: innertube::InnertubeState,
    pub stream_urls: media::StreamUrlCache,
    pub awake: power::KeepAwake,
    pub close_to_tray: AtomicBool,
    pub media_keys: AtomicBool,
}

fn main() {
    let http = net::build_client();

    let mut builder = tauri::Builder::default();

    // single-instance MUST be registered first, before any plugin that touches
    // windows. Registering it later means the second process can create a window
    // before the handler fires.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            // argv[1..] carries `playlet://` deep links and file args from the
            // second launch. Frontend listens: listen('second-instance', ...)
            let _ = app.emit("second-instance", argv);
        }));
    }

    builder = builder
        // window-state must come AFTER single-instance and BEFORE the window is
        // shown; it restores bounds on window creation.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init());

    #[cfg(desktop)]
    {
        // No updater yet: shipping one needs a signing key and a release endpoint,
        // neither of which exists for this build. See docs/PACKAGING.md to add it.
        builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    builder
        // Media is streamed through this process rather than fetched by the webview:
        // googlevideo sends no ACAO for our origin, so MSE segment fetches would fail.
        .register_asynchronous_uri_scheme_protocol(media::SCHEME, media::handle)
        .manage(AppState {
            http,
            allow: net::HostAllowlist::new(),
            innertube: innertube::InnertubeState::new(),
            stream_urls: media::StreamUrlCache::new(),
            awake: power::KeepAwake::spawn(),
            close_to_tray: AtomicBool::new(false),
            media_keys: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            net::api_fetch,
            net::api_probe,
            net::set_allowed_hosts,
            net::allowed_hosts,
            attestation::yt_attestation,
            oauth::yt_oauth_start,
            oauth::yt_oauth_poll,
            oauth::yt_oauth_refresh,
            innertube::yt_innertube,
            innertube::yt_refresh_identity,
            power::set_playback_state,
            shortcuts::set_media_keys_enabled,
            tray::set_close_to_tray,
            app_ready,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Seed the network allowlist from persisted settings BEFORE the
            // webview can issue its first api_fetch.
            if let Ok(store) = app.store(SETTINGS_STORE) {
                let state = handle.state::<AppState>();

                if let Some(v) = store.get("instances") {
                    state.allow.replace_from_json(&v);
                }
                if let Some(v) = store.get("closeToTray") {
                    state
                        .close_to_tray
                        .store(v.as_bool().unwrap_or(false), Ordering::Relaxed);
                }
                if let Some(v) = store.get("mediaKeys") {
                    if v.as_bool().unwrap_or(true) {
                        let _ = shortcuts::register(&handle);
                        state.media_keys.store(true, Ordering::Relaxed);
                    }
                }
            }

            #[cfg(desktop)]
            tray::build(&handle)?;

            // Window is created hidden (visible:false) so the user never sees it
            // jump from the default position to the restored one.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.app_handle().state::<AppState>();
                if state.close_to_tray.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    // Release the sleep blocker on the way out; a leaked
                    // ES_CONTINUOUS outlives nothing here (thread dies) but be explicit.
                    state.awake.set(false, false);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Playlet Desktop");
}

/// Frontend calls this once it has painted, so cold start can be measured.
#[tauri::command]
async fn app_ready(_app: tauri::AppHandle) -> Result<(), String> {
    Ok(())
}
