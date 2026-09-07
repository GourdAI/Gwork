//! Tauri 构建脚本。
//!
//! 必须存在：`Cargo.toml` 已声明 `[build-dependencies] tauri-build`，
//! 若无本文件则 `tauri_build::build()` 永不执行，
//! 上下文（`generate_context!`）与 ACL 清单均不会生成，编译必然失败。
//!
//! ## 为什么需要显式声明 `app_manifest().commands(...)`
//!
//! 本应用的前端并非由 Tauri 的 `tauri://` 协议提供，而是由内置的本地 HTTP
//! 服务器（见 `src/server.rs`）以 `http://localhost:{随机端口}` 提供
//! —— 这样做是为了继承 Electron 版的两个硬性要求：
//!   1. 界面外壳「秒开」，不等 JVM + Solon 启动；
//!   2. `http://localhost` 属于浏览器「可信来源」，`getUserMedia`、
//!      SpeechRecognition、剪贴板等能力才不会被禁用。
//!
//! 但从 Tauri 的视角，`http://localhost:*` 属于 **远程源（remote origin）**。
//! Tauri v2 对远程源强制执行 ACL：若不在 `build.rs` 中配置 AppManifest，
//! 自定义命令会被直接拒绝（详见 tauri-apps/tauri#15266）。
//!
//! 因此这里必须把所有 `#[tauri::command]` 显式登记，Tauri 会为每个命令
//! 自动生成 `allow-$command` / `deny-$command` 权限，再由
//! `capabilities/default.json` 授予 `http://localhost:*` 远程源。
//!
//! **新增 `#[tauri::command]` 时，必须同步更新下面的 COMMANDS 数组，
//! 否则该命令在运行期会被 ACL 静默拒绝。**

/// 把后端 jar 的构建指纹以编译期常量形式注入壳内（`GWORK_JAR_BUILD_ID`）。
///
/// 为何不用 `bundle.resources` 带一个 build-manifest.json 进包：那会让 tauri-build
/// 在**编译期**就要求该文件存在，而 `cargo test` / `cargo check` 不跑 beforeBuildCommand，
/// 任何一次单测都会直接挂在 build script 上（实测：`resource path ... doesn't exist`）。
/// 编译期注入还更贴语义：写进二进制的是「编译这个壳时所用 jar 的指纹」。
///
/// 数据源与 Electron 侧同一份：`gourd-ai-agent/target/classes/build-info.properties`
/// （Maven filtering 产物，与 jar 内 BOOT-INF/classes/ 的那一份同次构建）。
/// 读不到时写 `unknown`，运行期比对会降级为「不可比对」而非误报。
fn emit_jar_build_id() {
    let props = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../gourd-ai-agent/target/classes/build-info.properties");
    println!("cargo:rerun-if-changed={}", props.display());

    let mut build_id = String::from("unknown");
    if let Ok(text) = std::fs::read_to_string(&props) {
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('#') || line.is_empty() {
                continue;
            }
            if let Some(v) = line.strip_prefix("build.id=") {
                build_id = v.trim().to_string();
                break;
            }
        }
    }
    println!("cargo:rustc-env=GWORK_JAR_BUILD_ID={}", build_id);
}

/// 全部对前端暴露的自定义命令（snake_case，与 `main.rs` 的
/// `tauri::generate_handler!` 列表逐一对应）。
const COMMANDS: &[&str] = &[
    // 后端 JAR 进程
    "get_backend_state",
    "get_backend_detail",
    "restart_backend",
    // 窗口 / 标题栏
    "set_window_title",
    "set_window_theme",
    "set_window_scrim",
    // 自绘标题栏的窗口控件（Windows/Linux 关掉系统装饰后，
    // 最小化/最大化/关闭全部由前端按钮经这里驱动）
    "window_minimize",
    "window_toggle_maximize",
    "window_close",
    "window_get_chrome",
    // 自动更新
    "updater_get_version",
    "updater_get_state",
    "updater_check",
    "updater_download",
    "updater_install",
];

fn main() {
    emit_jar_build_id();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
