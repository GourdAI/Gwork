//! Tauri build script.
//!
//! Must exist: `Cargo.toml` declares `[build-dependencies] tauri-build`, and
//! without this file `tauri_build::build()` never runs, so neither the context
//! (`generate_context!`) nor the ACL manifest is generated and compilation fails.
//!
//! ## Why the commands must be declared explicitly
//!
//! Tauri v2 only auto-generates `allow-<cmd>` / `deny-<cmd>` permissions for
//! commands registered through `AppManifest::commands(...)`. A bare
//! `tauri_build::build()` registers none, so `capabilities/default.json`
//! referencing `allow-get-kernel-port` fails the build with
//! "Permission allow-get-kernel-port not found".
//!
//! **When adding a `#[tauri::command]`, also add its snake_case name below** —
//! otherwise the command is silently rejected by the ACL at runtime (the invoke
//! promise rejects, and because every frontend call site is guarded it looks like
//! the feature simply does nothing).
//!
//! ## bundle.resources
//!
//! There is one entry: `../build/extraResources/kernels/` → `extraResources/kernels/`,
//! carrying the Linux kernel binaries the remote-workspace deploy chain ships
//! (see `.github/workflows/build-gourd-work.yml`'s `kernel-assets` job and
//! `paths.rs::remote_kernel_candidates`). It is deliberately small — a couple of
//! static ELF binaries — not the ~150 MB JRE+jar tree the Java-backed shell
//! bundled, so the read-only-file unlocking workaround that shell needed still
//! does not apply here.
//!
//! `tauri_build` validates that source path at **compile** time, so it must exist
//! for even `cargo check`/`cargo test` to run. `main()` below creates it (empty)
//! before `try_build`; CI fills it via `download-artifact` before bundling, and a
//! plain local build still succeeds with nothing bundled (remote deploy then reports
//! "kernel asset not found" at connect time rather than the build breaking).
//! `desktop/build/` is git-ignored: only CI ever puts files in it.

/// Every custom command exposed to the frontend, in snake_case, matching the
/// `tauri::generate_handler!` list in `src/lib.rs` one-for-one.
const COMMANDS: &[&str] = &[
    // kernel addressing (the page is served from tauri.localhost, so the
    // frontend needs the in-process kernel's absolute origin)
    "get_kernel_port",
    "get_kernel_origin",
    "get_workspace",
    "get_app_version",
    // boot gate
    "get_backend_state",
    "get_backend_detail",
    // window / titlebar
    "set_window_title",
    // custom-drawn window controls (Windows/Linux run with decorations off, so
    // minimize/maximize/close are driven from the frontend through these)
    "window_minimize",
    "window_toggle_maximize",
    "window_close",
    "window_get_chrome",
    // native pickers
    "pick_directory",
    "pick_file",
    // ─── 远控通道（remote/ 子系统）───────────────────────────────────
    // 与 src/remote/mod.rs 的 #[tauri::command] 一一对应，共 9 个。
    //
    // 【移植修正】旧壳（gourd-ai-tauri）的 build.rs COMMANDS 与
    // capabilities/default.json 都漏登了 remote_forget_host，而前端
    // app-remote.js:422 确实调用它 —— 指纹拒绝后的「忘记该主机」入口在旧壳
    // 下被 ACL 静默拒绝（invoke reject，前端 catch 后无提示）。此处补齐。
    "remote_connect",
    "remote_disconnect",
    "remote_reconnect",
    "remote_state",
    "remote_list",
    "remote_forget_host",
    "remote_mirror_sync",
    "remote_bind_scope",
    "remote_wsl_list",
    // ─── 账号登录态（auth.rs）────────────────────────────────────────
    // 与 src/lib.rs 的 generate_handler! 一一对应；漏登会被 ACL 静默拒绝。
    "auth_status",
    "auth_login",
    "auth_register",
    "auth_logout",
    "auth_refresh",
    "auth_self",
];

fn main() {
    // `tauri_build` validates every `bundle.resources` source path at **compile**
    // time — not just when bundling — so `cargo check/test/build -p gourd-work-desktop`
    // panics with "resource path `..\build\extraResources\kernels` doesn't exist"
    // unless that directory is present. The remote kernel assets land there via CI's
    // `download-artifact`, but a plain local build (and every `cargo test`, which never
    // downloads them) must still compile.
    //
    // Creating it here — before `try_build` — is the fix, because build.rs is the one
    // choke point every build path goes through. Doing it in `tauri.conf.json`'s
    // `beforeBuildCommand` instead would only cover `tauri build` invoked via the CLI
    // and leave `cargo test`/`cargo check` broken (a "CI green, local red" trap that
    // was hit once already). The dir is created empty; CI fills it before bundling.
    //
    // `create_dir_all` is idempotent and never clobbers CI's downloaded files. A
    // failure here is left to surface as `try_build`'s own "resource path missing"
    // panic rather than being swallowed with a vaguer error.
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string());
    let kernels_dir = std::path::Path::new(&manifest_dir)
        .join("..")
        .join("build")
        .join("extraResources")
        .join("kernels");
    let _ = std::fs::create_dir_all(&kernels_dir);

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
