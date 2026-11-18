//! Self-update from GitHub Releases (`plugins.updater` in tauri.conf.json).
//!
//! Checks 8 s after startup, so it never competes with the first screen for
//! bandwidth, then daily. A found update is downloaded in the background; the prompt
//! waits until no video is open, and installing (which restarts the app) only ever
//! happens when the user says so.

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

pub fn spawn(app: AppHandle) {
    // `tauri dev` would download a release and run its installer over the dev build.
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(8)).await;
        loop {
            if let Err(err) = check_once(&app).await {
                eprintln!("update check failed: {err}");
            }
            tokio::time::sleep(Duration::from_secs(24 * 60 * 60)).await;
        }
    });
}

async fn check_once(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let Some(update) = app.updater()?.check().await? else {
        return Ok(());
    };
    let bytes = update.download(|_, _| {}, || {}).await?;

    // Never interrupt a video: the player holds this flag while it is mounted.
    let state = app.state::<crate::AppState>();
    while state.video_open.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_secs(60)).await;
    }

    let dialog = app
        .dialog()
        .message(format!(
            "Playlet {} is ready to install. Playlet will close and reopen.",
            update.version
        ))
        .title("Update ready")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Restart now".into(),
            "Later".into(),
        ));
    // "Later" waits for tomorrow's check.
    if tauri::async_runtime::spawn_blocking(move || dialog.blocking_show()).await? {
        update.install(bytes)?; // exits the app; the installer reopens it
    }
    Ok(())
}

