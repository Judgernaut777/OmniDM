//! OmniDM desktop shell.
//!
//! This is a deliberately thin native wrapper: the entire OmniDM UI and the
//! in-WebView AI Dungeon Master engine live in `../web` (the same client the
//! Node web adapter serves), pointed at by `tauri.conf.json`'s `frontendDist`.
//! There is NO Node sidecar and NO custom Rust command surface — the app is a
//! WebView around static, same-origin assets, so the attack surface stays as
//! small as the browser build's. Keep it that way unless a feature genuinely
//! needs the OS (then add a narrowly-scoped `#[tauri::command]` and grant it in
//! `capabilities/`).

/// Build and run the Tauri application.
///
/// `mobile_entry_point` lets a future `tauri android`/`tauri ios` target reuse
/// this exact composition root; on desktop it is a no-op attribute.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the OmniDM desktop application");
}
