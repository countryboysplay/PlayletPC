//! Keep Windows awake during playback.
//!
//! LANDMINE: SetThreadExecutionState is PER-THREAD and the state is dropped when
//! the calling thread exits. Tauri commands run on a tokio worker thread that can
//! be parked/retired at any time, so calling it directly inside a #[tauri::command]
//! appears to work in a 30-second test and then silently stops preventing sleep in
//! the middle of a 2-hour video. So: one dedicated, long-lived thread owns the
//! state and everything else talks to it over a channel.

use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::thread;

use tauri::State;

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Wake {
    pub system: bool,
    pub display: bool,
}

pub struct KeepAwake {
    tx: Mutex<Sender<Wake>>,
}

impl KeepAwake {
    pub fn spawn() -> Self {
        let (tx, rx) = mpsc::channel::<Wake>();

        thread::Builder::new()
            .name("playlet-keepawake".into())
            .spawn(move || {
                let mut current = Wake {
                    system: false,
                    display: false,
                };
                while let Ok(next) = rx.recv() {
                    if next != current {
                        apply(next);
                        current = next;
                    }
                }
                // Channel closed => app is shutting down. Clear the blocker.
                apply(Wake {
                    system: false,
                    display: false,
                });
            })
            .expect("failed to spawn keepawake thread");

        Self { tx: Mutex::new(tx) }
    }

    /// `playing` keeps the machine awake; `video` additionally keeps the display on.
    pub fn set(&self, playing: bool, video: bool) {
        let _ = self.tx.lock().unwrap().send(Wake {
            system: playing,
            display: playing && video,
        });
    }
}

#[cfg(windows)]
fn apply(w: Wake) {
    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
    };

    let mut flags = ES_CONTINUOUS;
    if w.system {
        flags |= ES_SYSTEM_REQUIRED;
    }
    if w.display {
        flags |= ES_DISPLAY_REQUIRED;
    }
    // ES_CONTINUOUS alone == "reset to normal power policy".
    unsafe {
        SetThreadExecutionState(flags);
    }
}

#[cfg(not(windows))]
fn apply(_w: Wake) {}

/// Called from the player on play/pause/ended/audio-only toggle.
/// Call it with playing=false on `pause`, `ended`, AND on window close --
/// a leaked blocker means the user's laptop never sleeps again until reboot.
#[tauri::command]
pub async fn set_playback_state(
    state: State<'_, crate::AppState>,
    playing: bool,
    video: bool,
) -> Result<(), String> {
    state.awake.set(playing, video);
    Ok(())
}
