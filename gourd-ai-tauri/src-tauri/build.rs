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

/// `tauri.conf.json` 的 `bundle.resources` 里每个条目的**目标目录名**（映射的值）。
/// tauri-build 把资源复制到 `<target_dir>/<目标名>`，这里只需覆盖这几棵子树，
/// 不去动 `target/` 下的其它编译产物。
///
/// 新增/改名 `bundle.resources` 的目标目录时，必须同步更新本数组。
const RESOURCE_DEST_DIRS: &[&str] = &["ui", "extraResources"];

/// 把上一轮复制到 `target/` 里的资源副本恢复为「属主可写」。
///
/// ## 症状
/// Linux / macOS 上**第二次及以后**的构建，build script 直接 panic：
/// ```text
/// thread 'main' panicked at build.rs:89:6:
/// failed to run tauri-build: Permission denied (os error 13)
/// ```
/// 且日志最后一行 `cargo:rerun-if-changed=.../jre/legal/<模块>/LICENSE` 就是
/// 失败的那个文件 —— tauri-build 是「先 println 再 copy」，所以最后打印的路径
/// 即出错路径，不需要猜。
///
/// ## 成因（三个独立事实叠加，缺一不可）
/// 1. `jlink` 生成 JRE 时会把 `legal/**` 全部设为只读（0444）。这段逻辑在 JDK 的
///    `DefaultImageBuilder.storeFiles()` 里被
///    `Files.getFileStore(root).supportsFileAttributeView(PosixFileAttributeView.class)`
///    包着 —— **只在 POSIX 文件系统生效**。Windows 上一个只读文件都没有，
///    这就是本机永远复现不了、只有 CI 的 Linux/macOS 腿翻车的原因。
/// 2. `std::fs::copy` 在 Unix 上会把**源文件的权限位一并复制**给目标，
///    于是 `target/release/extraResources/jre/legal/**` 也成了 0444。
/// 3. tauri-build 的 `copy_resources` → `copy_file` 直接 `fs::copy(from, to)`，
///    **不像同文件的 `copy_binaries` 那样先 `remove_file(dest)`**。第二次构建时
///    `fs::copy` 以 `O_TRUNC` 打开已存在的只读目标 → `EACCES(13)`。
///
/// ## 为什么本仓库必然反复踩到
/// Linux 腿是 `build:linux:deb` + `build:linux:appimage` **两次** `tauri build`，
/// 共用同一个 `target/release/`：第一次把只读位种进去，第二次必炸（deb 已落盘，
/// 所以表现为「AppImage 那步挂」）。而且跨 workflow 运行还有 `swatinem/rust-cache`
/// 把整个 `target/` 恢复回来，于是「重跑一次」也救不回来 —— 这正是该问题反复
/// 出现、且每次都像新问题的原因。macOS 同属 POSIX，只因两个架构落在不同的
/// `target/<triple>/` 才尚未暴露，属同一枚地雷。
///
/// ## 边界
/// 只改 `target/` 下的构建产物，**不碰源码树**（遵守 build script 不应修改
/// `OUT_DIR` 之外源文件的约定）。源头侧另有 jlink 之后的 `chmod -R u+w` 兜底
/// （见 workflow 与 `cmd/sync-backend.js`），两层各自独立生效：
/// 源头那层防「产生新的只读副本」，这一层清「缓存里已有的只读副本」。
fn unlock_copied_resources() {
    let Some(out_dir) = std::env::var_os("OUT_DIR") else {
        return;
    };
    // 与 tauri-build 同一套推导：OUT_DIR/../../.. == target/<profile>
    // （OUT_DIR = target/<profile>/build/<pkg>-<hash>/out）
    let out_dir = std::path::PathBuf::from(out_dir);
    let Some(target_dir) = out_dir
        .parent()
        .and_then(std::path::Path::parent)
        .and_then(std::path::Path::parent)
    else {
        return;
    };

    for name in RESOURCE_DEST_DIRS {
        let dir = target_dir.join(name);
        if dir.exists() {
            unlock_tree(&dir);
        }
    }
}

/// 递归授予属主写权限。遇到任何错误都静默跳过：本函数是「排雷」而非功能，
/// 真正的失败留给后面的 `tauri_build::try_build` 报出带路径的错误。
///
/// 不跟随符号链接（macOS 的 Framework 结构里有大量 symlink，跟随会绕出目标树）。
fn unlock_tree(path: &std::path::Path) {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if meta.file_type().is_symlink() {
        return;
    }

    grant_owner_write(path, &meta);

    if meta.is_dir() {
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                unlock_tree(&entry.path());
            }
        }
    }
}

#[cfg(unix)]
fn grant_owner_write(path: &std::path::Path, meta: &std::fs::Metadata) {
    use std::os::unix::fs::PermissionsExt;

    let mode = meta.permissions().mode();
    // 目录还需要 u+x：只给 u+w 仍然进不去，也就无法改写其中的文件
    let want = if meta.is_dir() { 0o300 } else { 0o200 };
    if mode & want != want {
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode | want));
    }
}

#[cfg(not(unix))]
fn grant_owner_write(path: &std::path::Path, meta: &std::fs::Metadata) {
    // Windows 上 jlink 不会设只读位（见 `unlock_copied_resources` 的成因分析），
    // 正常路径下这里恒为 no-op。仍保留实现，一是让整段逻辑在 Windows 上也能被
    // 真实执行和测试（避免「平台专属代码在开发机零覆盖」），二是覆盖从 POSIX
    // 机器拷贝/解包过来的目录树带只读属性的情况。
    let mut perms = meta.permissions();
    if perms.readonly() {
        perms.set_readonly(false);
        let _ = std::fs::set_permissions(path, perms);
    }
}

fn main() {
    // 必须在 try_build 之前：它内部的 copy_resources 一旦撞上只读目标就直接返回
    // Err，而这里的 expect 会把它变成 panic，日志里只剩一句没有路径的
    // "Permission denied (os error 13)"。
    unlock_copied_resources();
    emit_jar_build_id();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
