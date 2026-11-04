//! Tauri commands exposed to the frontend through `window.__GOURD_IPC__`.
//!
//! Only commands this kernel can genuinely honour are registered. The frontend
//! guards every call with `typeof ipc.X === 'function'`, so an absent command
//! degrades to the browser-mode path instead of failing at runtime — which is why
//! there is deliberately no `restart_backend` (the kernel is in-process) and no
//! `remote_*` / `updater_*` (not implemented in this kernel).

use tauri::State;

use crate::ipc_bridge::{MAIN_WINDOW_LABEL, MAIN_WINDOW_TITLE};
use crate::AppState;

/// Get the kernel server port (frontend uses this to connect WS/HTTP).
#[tauri::command]
pub fn get_kernel_port(state: State<AppState>) -> u16 {
    state.kernel_port
}

/// Get the kernel's absolute origin, e.g. `http://127.0.0.1:51234`.
///
/// The page itself is served from `tauri.localhost`, so relative API paths cannot
/// reach the kernel; `js/kernel-bridge.js` rewrites them using this value.
#[tauri::command]
pub fn get_kernel_origin(state: State<AppState>) -> String {
    state.kernel_origin.clone()
}

/// Get the current workspace path.
#[tauri::command]
pub fn get_workspace(state: State<AppState>) -> String {
    state.workspace.to_string_lossy().to_string()
}

/// Application version, for the About panel.
#[tauri::command]
pub fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Backend readiness for the boot gate.
///
/// Returns `'ready'` / `'starting'` / `'failed'`. The frontend releases its
/// startup request queue on `'ready'`; anything else makes it wait out a 65 s
/// fallback, so this must not stay `'starting'` once the kernel is answering.
#[tauri::command]
pub fn get_backend_state(state: State<AppState>) -> &'static str {
    use std::sync::atomic::Ordering;
    if state.kernel_ready.load(Ordering::SeqCst) {
        "ready"
    } else if state.kernel_error.lock().map(|e| e.is_some()).unwrap_or(false) {
        "failed"
    } else {
        "starting"
    }
}

/// Diagnostic detail shown in the boot error bar.
#[tauri::command]
pub fn get_backend_detail(state: State<AppState>) -> serde_json::Value {
    let last_error = state
        .kernel_error
        .lock()
        .ok()
        .and_then(|g| g.clone());
    serde_json::json!({
        "running": last_error.is_none(),
        "embedded": true,
        "port": state.kernel_port,
        "origin": state.kernel_origin,
        "workspace": state.workspace.to_string_lossy(),
        "lastError": last_error,
        "logPath": null,
    })
}

/// Set the window title (the frontend appends the active project name).
///
/// 空标题回退到 `MAIN_WINDOW_TITLE` 常量（与建窗、托盘 tooltip 同源），
/// 不再写死字面量 —— 三处各自硬编码时，改产品名会漏掉其中一两处。
#[tauri::command]
pub fn set_window_title(app: tauri::AppHandle, title: String) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = w.set_title(if title.is_empty() { MAIN_WINDOW_TITLE } else { &title });
    }
}

/// Open a native directory picker dialog.
#[tauri::command]
pub async fn pick_directory(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let result = app.dialog().file().blocking_pick_folder();
    result.and_then(|p| p.as_path().map(|path| path.to_string_lossy().to_string()))
}

/// Open a native file picker dialog.
///
/// Separate from `pick_directory` on purpose: a private key is a file, and the
/// folder picker cannot select one.
#[tauri::command]
pub async fn pick_file(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let result = app.dialog().file().blocking_pick_file();
    result.and_then(|p| p.as_path().map(|path| path.to_string_lossy().to_string()))
}
