//! paths.rs —— 全局路径解析（单一来源）
//!
//! 供 main.rs / backend.rs / cli_provision.rs / migration.rs / server.rs 共用。
//! 解析顺序与 Electron 版 runtime-paths.js 完全一致，避免在同时存在
//! USERPROFILE 与 HOME 的环境（Git Bash、WSL 互通、CI）中出现
//! 「启动器写到 A、后端却读 B」的分叉。
//!
//! ## resources_dir 为什么必须集中在这里（血泪教训）
//!
//! 历史上 backend.rs 与 cli_provision.rs 各自持有一份 `resources_dir()`，
//! 且**候选优先级相反**：backend.rs 先探 `<exe>/resources/extraResources`，
//! cli_provision.rs 先探 `<exe>/extraResources`。两份实现都以「目录是否存在」
//! 为命中判据。
//!
//! 后果：NSIS 覆盖安装**不会删除旧版本遗留的目录**。当安装目录下同时存在
//! 历史布局 `resources/extraResources`（只有 jar、没有 jre）与当前布局
//! `extraResources`（jar + jre 齐全）时，backend.rs 会命中前者 →
//! `find_java()` 找不到内置 JRE → 后端进程根本没被 spawn → 全部 /web/** 接口
//! 503，而 UI 外壳照常显示，故障表现极具误导性。
//!
//! 因此这里确立两条铁律：
//! 1. **全仓库只允许存在这一份实现**，其他模块一律转发调用，不得自行拼接路径。
//! 2. 命中判据是「**内置 JRE 的 java 可执行文件实存**」，而不是「目录存在」。
//!    目录存在但缺 jre 的候选一律降级，绝不允许它抢在完整候选之前。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tracing::info;

/// OS 用户主目录。Windows 与 Unix 的变量优先级固定且全局唯一：
/// - Windows: USERPROFILE || dirs::home_dir()
/// - Unix:    HOME        || dirs::home_dir()
pub fn user_home() -> PathBuf {
    crate::cli_provision::resolve_user_home()
}

/// 运行时数据基目录，即 Java 侧 -Dgwork.home 的取值语义。
/// **不含** `.gwork` 子目录；一律是 OS 用户主目录。
pub fn runtime_home_dir() -> PathBuf {
    crate::cli_provision::runtime_home_dir()
}

/// 全局配置区目录：~/.gwork
pub fn gwork_home() -> PathBuf {
    runtime_home_dir().join(".gwork")
}

// ─── extraResources 解析 ─────────────────────────────────────────────────────

/// 各平台 JRE 里 java 可执行文件的候选名。
/// Windows 打包的是 `javaw.exe`（无控制台）+ `java.exe`（CLI 需要 stdin/stdout），
/// Unix 只有 `java`。三者任一存在即视为「该候选目录带可用 JRE」。
fn java_exe_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["javaw.exe", "java.exe"]
    } else {
        &["java"]
    }
}

/// 候选目录是否带**可用的内置 JRE**（一级判据，最强）。
fn has_bundled_jre(dir: &Path) -> bool {
    let bin = dir.join("jre").join("bin");
    java_exe_names().iter().any(|n| bin.join(n).exists())
}

/// 候选目录是否带 gourd-ai-agent.jar（二级判据）。
fn has_bundled_jar(dir: &Path) -> bool {
    dir.join("gourd-ai-agent.jar").exists()
}

/// 可执行文件所在目录（拿不到时退化为 "."，由上层候选判据兜住）。
fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 列出全部 extraResources 候选目录，**按优先级排序**。
///
/// 顺序依据（实测 + 各 bundler 行为）：
/// - macOS：`*.app/Contents/Resources/extraResources`
/// - Windows NSIS / Linux deb：Tauri 2.x 把 `bundle.resources` 的 target 直接
///   落在**可执行文件同级**（`<install>/extraResources`），实测 2.11.5 如此。
/// - 部分 bundler / 旧版本会多一层 `resources/`（`<install>/resources/extraResources`），
///   保留为次级候选以兼容，但**绝不允许它抢占带完整 JRE 的同级候选**。
/// - Linux AppImage：`<mount>/usr/lib/extraResources`
/// - 开发态：从 target/debug 向上回溯仓库根，先取本模块的 `gourd-ai-tauri/build/extraResources`，
///   再回落到 `gourd-ai-desktop/build/extraResources`
pub fn resources_dir_candidates() -> Vec<PathBuf> {
    let exe = exe_dir();
    let mut out: Vec<PathBuf> = Vec::new();

    if cfg!(debug_assertions) {
        // 开发版：优先本模块自己的构建产物（2026-09-06 起 jar/jre 由 cmd/sync-backend.js
        // 直接从 gourd-ai-agent/target 同步到此，不再借道 Electron 模块）。
        // 仍保留 Electron 的目录作为次级候选：老工作区可能只跑过 build.ps1，
        // 此时那份产物仍然可用，没必要逼开发者重跑一遍同步。
        let mut dir: Option<&Path> = Some(exe.as_path());
        while let Some(d) = dir {
            out.push(d.join("gourd-ai-tauri").join("build").join("extraResources"));
            out.push(
                d.join("gourd-ai-desktop")
                    .join("build")
                    .join("extraResources"),
            );
            dir = d.parent();
        }
        out.push(exe.join("extraResources"));
        return out;
    }

    // 发布态候选：顺序规则拆到 release_candidates_from（纯函数，便于跨 profile 断言）
    release_candidates_from(&exe)
}

/// 纯函数版**发布态**候选枚举：给定 exe 目录，返回按优先级排序的候选。
///
/// 为何要从 `resources_dir_candidates()` 拆出来：前者在 `cfg!(debug_assertions)` 下
/// 会改走开发态分支，而 `cargo test` 恒为 debug —— 针对发布布局的顺序断言若直接写在
/// 前者上会永远命中「早退」，测试形同虚设却显示通过（本次 review 实际发现并修正）。
pub(crate) fn release_candidates_from(exe: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    // macOS：exe 在 *.app/Contents/MacOS，资源在 *.app/Contents/Resources
    #[cfg(target_os = "macos")]
    {
        if let Some(contents) = exe.parent().and_then(|p| p.parent()) {
            out.push(contents.join("Resources").join("extraResources"));
            // 部分打包路径会再嵌一层 resources/
            out.push(
                contents
                    .join("Resources")
                    .join("resources")
                    .join("extraResources"),
            );
        }
    }

    // 当前布局：可执行文件同级（Tauri 2.x NSIS/deb 实测落点）
    out.push(exe.join("extraResources"));
    // 兼容布局：多一层 resources/（旧版本或其它 bundler）
    out.push(exe.join("resources").join("extraResources"));
    // Linux AppImage / 部分发行版布局
    out.push(exe.join("..").join("lib").join("extraResources"));

    out
}

/// 按判据强度从候选中挑出实际使用的 extraResources 目录。
///
/// 三级降级，保证「有完整 JRE 的目录」永远优先于「只有 jar 的历史残留」：
/// 1. 带可用 JRE 的候选（后端启动的硬需求）
/// 2. 带 jar 的候选（JRE 缺失时至少能让错误信息指向真实存在的资源）
/// 3. 目录存在的候选
/// 4. 都不满足时返回首个候选，让上层报错时能打印一个有意义的预期路径
pub(crate) fn pick_resources_dir(candidates: &[PathBuf]) -> PathBuf {
    if let Some(d) = candidates.iter().find(|d| has_bundled_jre(d)) {
        return d.clone();
    }
    if let Some(d) = candidates.iter().find(|d| has_bundled_jar(d)) {
        return d.clone();
    }
    if let Some(d) = candidates.iter().find(|d| d.is_dir()) {
        return d.clone();
    }
    candidates
        .first()
        .cloned()
        .unwrap_or_else(|| PathBuf::from("extraResources"))
}

/// 内置资源目录（extraResources）—— **全仓库唯一权威实现**。
///
/// 结果按进程缓存：安装目录在运行期不会变，而该函数会被 find_java / find_jar /
/// bundled_java_major 等多处反复调用，每次都做十余次文件系统探测没有必要。
///
/// 测试请直接使用 [`pick_resources_dir`] / [`resources_dir_candidates`]，
/// 避免受缓存影响。
pub fn resources_dir() -> PathBuf {
    static CACHED: OnceLock<PathBuf> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            let picked = pick_resources_dir(&resources_dir_candidates());
            info!("[paths] extraResources 命中: {}", picked.display());
            picked
        })
        .clone()
}

/// 诊断报告：逐条列出候选目录及其探测结果。
///
/// 仅在 `find_java()` / `find_jar()` 失败时调用（正常启动路径不产生开销）。
/// 存在的意义：2026-09-04 那次故障，错误信息只打印了**一个**路径，而那个路径
/// 恰好是「目录存在但缺 jre」的历史残留，导致排查方向被误导了近一小时。
/// 把全部候选和各自的缺失项一次性摊开，同类问题可当场自证。
pub fn resources_dir_diagnostics() -> String {
    let picked = resources_dir();
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("已选用: {}", picked.display()));
    for c in resources_dir_candidates() {
        let jre = has_bundled_jre(&c);
        let jar = has_bundled_jar(&c);
        let exists = c.is_dir();
        lines.push(format!(
            "  - {} [目录存在={}, jre={}, jar={}]",
            c.display(),
            exists,
            jre,
            jar
        ));
    }
    lines.push(format!(
        "  环境变量: JAVA_EXEC={:?}, JAVA_HOME={:?}",
        std::env::var("JAVA_EXEC").ok(),
        std::env::var("JAVA_HOME").ok()
    ));
    lines.join("\n")
}

// ─── 旧布局残留清理 ──────────────────────────────────────────────────────────

/// 是否形如「旧布局」路径：`<...>/resources/extraResources`。
///
/// 只认这个确切形状，不递归、不拿 `resources/` 整目录开刀——那里在别的
/// 版本/平台上可能存放正经资源（如旧的 `resources/ui`），误删后果比不删严重。
fn is_legacy_nested_layout(dir: &Path) -> bool {
    dir.file_name().and_then(|n| n.to_str()) == Some("extraResources")
        && dir
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            == Some("resources")
}

/// 清理决策（纯函数，便于单测）。
///
/// `Some(理由)` = 可删；`None` = 保留。四个条件缺一即不删：
/// 1. 目录实际存在；
/// 2. 路径形状确实是旧布局（`.../resources/extraResources`）；
/// 3. 它**不是**当前选用的那个目录（绝不能删自己），且它**不带**可用 JRE
///    ——带 JRE 说明它可能才是真正可用的那份，只能降级保留，不能当垃圾删；
/// 4. 当前选用的目录 jar + jre 齐全（否则删旧的会把唯一可用资源弄丢）。
fn legacy_removal_plan(
    legacy: &Path,
    picked: &Path,
    legacy_exists: bool,
    legacy_has_jre: bool,
    picked_complete: bool,
) -> Option<&'static str> {
    if !legacy_exists {
        return None;
    }
    if !is_legacy_nested_layout(legacy) {
        return None; // 形状不对，一律不碰
    }
    if same_path(legacy, picked) {
        return None; // 它就是当前生效目录，绝对不能碰
    }
    if legacy_has_jre {
        return None; // 带 JRE 的旧目录不能当垃圾删
    }
    if !picked_complete {
        return None; // 当前目录不完整，删旧的会把唯一可用资源弄丢
    }
    Some("旧布局残留、自身缺 jre、且当前选用目录 jar+jre 齐全")
}

/// 路径全等判定。先拿 canonicalize 去掉 `..`/符号链接后比对，
/// 失败时退回字符串比较（目录不存在时 canonicalize 会 Err）。
fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a.to_string_lossy().replace('\\', "/") == b.to_string_lossy().replace('\\', "/"),
    }
}


/// 启动期自清：删除旧布局遗留的 `<exe>/resources/extraResources`。
///
/// 为何要删而不只是躲开它：NSIS **覆盖安装不删旧目录**，残留会一直赖在安装
/// 目录里。paths.rs 的判据已保证它不会再抢占（见本文件顶部），但留着它仍有两个
/// 实际危害：一是白占 50MB+ 磁盘，二是它的 jar 会被其它工具（或人）误认为生效版本，
/// 下次排障又绕回坑里。本函数只在**确认当前目录完整**时才动手，属于可证明安全的清理。
///
/// 开发态（debug）直接跳过：那时路径指向仓库构建产物，不存在“安装目录”概念。
pub fn cleanup_legacy_resources() {
    if cfg!(debug_assertions) {
        return;
    }
    for legacy in legacy_layout_paths() {
        let exists = legacy.is_dir();
        let plan = legacy_removal_plan(
            &legacy,
            &resources_dir(),
            exists,
            has_bundled_jre(&legacy),
            resources_complete(),
        );
        match plan {
            Some(reason) => {
                match std::fs::remove_dir_all(&legacy) {
                    Ok(()) => {
                        info!("[paths] 已清理旧布局残留: {} ({})", legacy.display(), reason);
                        prune_if_empty(legacy.parent());
                    }
                    Err(e) => {
                        // 删失败不影响启动（已被判据降级），只留痕迹；常见于文件被占用
                        info!("[paths] 旧布局残留清理失败（忽略）: {} - {}", legacy.display(), e);
                    }
                }
            }
            None => {
                // 存在但不满足判据：必须留下日志，否则排障时无法区分「已删」与「主动保留」
                if exists {
                    info!("[paths] 旧布局目录保留（不满足清理判据）: {}", legacy.display());
                }
            }
        }
    }
}

/// 当前选用目录是否 jar + jre 齐全。
pub fn resources_complete() -> bool {
    let d = resources_dir();
    has_bundled_jre(&d) && has_bundled_jar(&d)
}

/// 枚举各平台上「旧布局」的确切候选路径（均锁定在 exe 目录体系内）。
fn legacy_layout_paths() -> Vec<PathBuf> {
    let exe = exe_dir();
    // 非 macOS 平台只有单一候选，mut 在那些 target 上不会被用到
    #[allow(unused_mut)]
    let mut out = vec![exe.join("resources").join("extraResources")];
    #[cfg(target_os = "macos")]
    if let Some(contents) = exe.parent().and_then(|p| p.parent()) {
        out.push(
            contents
                .join("Resources")
                .join("resources")
                .join("extraResources"),
        );
    }
    out
}

/// 目录空了就顺手删掉（只往下走一层，不递归）。
fn prune_if_empty(parent: Option<&Path>) {
    if let Some(p) = parent {
        if p.is_dir() && p.read_dir().map(|mut r| r.next().is_none()).unwrap_or(false) {
            let _ = std::fs::remove_dir(p);
        }
    }
}

/// 内置 JRE 的 java 可执行文件（按平台名择优：Windows 优先 javaw.exe）。
/// 返回 None 表示当前选用的 extraResources 里没有可用 JRE。
pub fn bundled_java_exe(prefer_windowless: bool) -> Option<PathBuf> {
    let bin = resources_dir().join("jre").join("bin");
    let names = java_exe_names();
    // prefer_windowless=true（后端 GUI 进程）按 javaw 优先；
    // false（CLI 启动器，需要 stdin/stdout）按 java 优先。
    let order: Vec<&str> = if prefer_windowless {
        names.to_vec()
    } else {
        let mut v: Vec<&str> = names.to_vec();
        v.reverse();
        v
    };
    order.into_iter().map(|n| bin.join(n)).find(|p| p.exists())
}

/// 初始化路径相关状态（记录基准路径 + 清理旧布局残留）。
pub fn init() -> Result<(), anyhow::Error> {
    info!(
        "[paths] user_home={}, gwork_home={}, resources_dir={}",
        user_home().display(),
        gwork_home().display(),
        resources_dir().display()
    );
    cleanup_legacy_resources();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个「只有 jar、没有 jre」的历史残留候选，与一个「jar + jre 齐全」的
    /// 当前候选，验证残留目录**不会**抢占完整目录。
    ///
    /// 这是 2026-09-04 安装版后端不启动故障的直接回归护栏：当时
    /// `<install>/resources/extraResources` 只有 jar，却因为排在候选首位且
    /// 判据仅为「目录存在」而被命中，导致 find_java 全链路落空。
    #[test]
    fn stale_jar_only_candidate_loses_to_complete_one() {
        let root = std::env::temp_dir().join(format!("gwork-paths-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        // 残留布局：目录存在 + 有 jar，但缺 jre
        let stale = root.join("resources").join("extraResources");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(stale.join("gourd-ai-agent.jar"), b"stale").unwrap();

        // 当前布局：jar + jre/bin/java(w) 齐全
        let good = root.join("extraResources");
        let jre_bin = good.join("jre").join("bin");
        std::fs::create_dir_all(&jre_bin).unwrap();
        std::fs::write(good.join("gourd-ai-agent.jar"), b"good").unwrap();
        let java_name = if cfg!(windows) { "javaw.exe" } else { "java" };
        std::fs::write(jre_bin.join(java_name), b"fake-java").unwrap();

        // 故意把残留目录排在前面，模拟旧实现的错误优先级
        let picked = pick_resources_dir(&[stale.clone(), good.clone()]);
        assert_eq!(
            picked, good,
            "带完整 JRE 的候选必须胜出，即使历史残留排在前面"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 全部候选都缺 JRE 时，降级到「有 jar 的候选」，保证错误信息指向真实资源。
    #[test]
    fn falls_back_to_jar_candidate_when_no_jre_anywhere() {
        let root = std::env::temp_dir().join(format!("gwork-paths-jar-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        let empty = root.join("a");
        std::fs::create_dir_all(&empty).unwrap();

        let with_jar = root.join("b");
        std::fs::create_dir_all(&with_jar).unwrap();
        std::fs::write(with_jar.join("gourd-ai-agent.jar"), b"x").unwrap();

        let picked = pick_resources_dir(&[empty.clone(), with_jar.clone()]);
        assert_eq!(picked, with_jar);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 候选全都不存在时，返回首个候选而非 panic —— 上层据此打印「预期路径」。
    #[test]
    fn returns_first_candidate_when_nothing_exists() {
        let root = std::env::temp_dir().join("gwork-paths-nonexistent-xyz");
        let first = root.join("first");
        let second = root.join("second");
        assert_eq!(pick_resources_dir(&[first.clone(), second]), first);
    }

    /// 候选列表绝不能为空（pick 会对空列表返回兜底值，但语义上应有明确预期路径）。
    #[test]
    fn candidate_list_is_never_empty() {
        assert!(!resources_dir_candidates().is_empty());
    }

    /// 当前布局（exe 同级 extraResources）必须排在兼容布局（多一层 resources/）之前。
    /// 顺序写反就会重现 9/04 的故障，故钉死。
    ///
    /// 注意：必须喂假 exe 给纯函数 `release_candidates_from`，不能走
    /// `resources_dir_candidates()` —— 后者在 debug（即 `cargo test` 默认 profile）
    /// 下走开发态分支，会让本断言静默不执行。
    #[test]
    fn flat_layout_precedes_nested_layout() {
        let fake_exe_dir = if cfg!(windows) {
            PathBuf::from(r"C:\Apps\GWork")
        } else {
            PathBuf::from("/opt/GWork")
        };
        let cands = release_candidates_from(&fake_exe_dir);

        // 归类：叶子名是 extraResources 的候选，返回其父目录是否为 resources/
        let nested_under_resources = |p: &PathBuf| -> Option<bool> {
            if p.file_name().and_then(|n| n.to_str()) != Some("extraResources") {
                return None;
            }
            Some(
                p.parent()
                    .and_then(|d| d.file_name())
                    .and_then(|n| n.to_str())
                    == Some("resources"),
            )
        };
        let flat = cands.iter().position(|p| nested_under_resources(p) == Some(false));
        let nested = cands.iter().position(|p| nested_under_resources(p) == Some(true));

        // 两种形状都必须真被列举出来；否则「找不到就当通过」会让断言失去意义
        let (f, n) = match (flat, nested) {
            (Some(f), Some(n)) => (f, n),
            got => panic!(
                "发布态候选应同时包含同级与嵌套两种布局（实际 {:?} ← {:?}）",
                got, cands
            ),
        };
        assert!(f < n, "同级布局必须优先于 resources/ 嵌套布局: {:?}", cands);

        // 优先级在真正选目录时也成立：两者都只有 jar（都缺 jre）时取同级的第一个
        let flat_dir = fake_exe_dir.join("extraResources");
        let nested_dir = fake_exe_dir.join("resources").join("extraResources");
        assert_eq!(
            pick_resources_dir(&[flat_dir.clone(), nested_dir.clone()]),
            flat_dir,
            "两个候选都缺 jre 时，不得选中嵌套残留"
        );
    }

    /// 诊断报告必须把每个候选的 jre/jar 状态都摊开，否则失去自证能力。
    #[test]
    fn diagnostics_lists_every_candidate() {
        let report = resources_dir_diagnostics();
        assert!(report.contains("已选用:"));
        assert!(report.contains("jre="));
        assert!(report.contains("jar="));
        assert!(report.contains("JAVA_HOME="));
        // 候选数量与报告行数一致（每个候选一行）
        let listed = report.matches("  - ").count();
        assert_eq!(listed, resources_dir_candidates().len());
    }

    // ─── 旧布局残留清理 ───

    /// 形状判定必须只认 `<...>/resources/extraResources`，别的一律不碰。
    #[test]
    fn legacy_shape_detection_is_exact() {
        let root = Path::new("/tmp/legacy-shape");
        assert!(is_legacy_nested_layout(&root.join("resources").join("extraResources")));
        // 当前布局（同级）不能被误判为旧布局
        assert!(!is_legacy_nested_layout(&root.join("extraResources")));
        // 旧布局的子目录也不能被误判（避免递归误删）
        assert!(!is_legacy_nested_layout(
            &root.join("resources").join("extraResources").join("jre")
        ));
        // 父目录叫 resources 但叶子名不对
        assert!(!is_legacy_nested_layout(&root.join("resources").join("ui")));
    }

    /// 完整复现 9/04 场景：旧目录缺 jre + 当前目录齐全 ⇒ 判定可删。
    #[test]
    fn stale_legacy_dir_is_planned_for_removal() {
        let legacy = Path::new("/tmp/gwork-cleanup/install/resources/extraResources");
        let picked = Path::new("/tmp/gwork-cleanup/install/extraResources");
        assert_eq!(
            legacy_removal_plan(legacy, picked, true, false, true),
            Some("旧布局残留、自身缺 jre、且当前选用目录 jar+jre 齐全"),
            "典型残留（缺 jre）在当前目录完整时应被清理"
        );
    }

    /// 四道保险丝：任一条件不满就绝对不能删。
    #[test]
    fn legacy_removal_is_refused_unless_all_guards_pass() {
        let legacy = Path::new("/tmp/gwork-cleanup/install/resources/extraResources");
        let picked = Path::new("/tmp/gwork-cleanup/install/extraResources");
        // 1. 目录根本不存在
        assert_eq!(legacy_removal_plan(legacy, picked, false, false, true), None);
        // 2. 形状不是旧布局
        assert_eq!(
            legacy_removal_plan(picked, legacy, true, false, true),
            None,
            "同级（当前）布局不得被当成旧布局删除"
        );
        // 3a. 它就是当前选用目录
        assert_eq!(legacy_removal_plan(legacy, legacy, true, false, true), None);
        // 3b. 旧目录自带可用 JRE
        assert_eq!(legacy_removal_plan(legacy, picked, true, true, true), None);
        // 4. 当前目录不完整（只剩旧目录可用）
        assert_eq!(legacy_removal_plan(legacy, picked, true, false, false), None);
    }

    /// 清理入口列举的路径必须全部符合旧布局形状，否则等于拿着任意路径去删。
    #[test]
    fn legacy_layout_paths_are_all_legacy_shaped() {
        for p in legacy_layout_paths() {
            assert!(
                is_legacy_nested_layout(&p),
                "清理候选路径形状不合法: {}",
                p.display()
            );
        }
        // 非空：否则“自清”会对任何残留都无动于衷
        assert!(!legacy_layout_paths().is_empty());
    }

    /// 把 9/04 故障完整重演一遍（真实临时目录，而非纯函数入参）：
    /// 同级目录 jar+jre 齐全，嵌套旧目录只有 jar ⇒ 必须选同级，且旧目录判定为可清理。
    /// 这条同构于现实安装目录布局，是本次修复的主护栏。
    #[test]
    fn incident_scenario_picks_flat_and_clears_nested() {
        let root = std::env::temp_dir().join(format!("gwork-incident-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        let flat = root.join("extraResources");
        std::fs::create_dir_all(flat.join("jre").join("bin")).unwrap();
        std::fs::write(flat.join("gourd-ai-agent.jar"), b"new").unwrap();
        let java_name = if cfg!(windows) { "javaw.exe" } else { "java" };
        std::fs::write(flat.join("jre").join("bin").join(java_name), b"fake").unwrap();

        let nested = root.join("resources").join("extraResources");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("gourd-ai-agent.jar"), b"stale").unwrap();

        // 候选顺序与发布态一致（同级在前），但旧目录存在性不能影响结果
        let picked = pick_resources_dir(&[flat.clone(), nested.clone()]);
        assert_eq!(picked, flat, "必须选中带完整 JRE 的同级目录");
        assert!(has_bundled_jre(&picked) && has_bundled_jar(&picked), "选用目录应 jar+jre 齐全");

        assert!(
            legacy_removal_plan(&nested, &picked, nested.is_dir(), has_bundled_jre(&nested), true)
                .is_some(),
            "该残留应被判定为可清理"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// prune_if_empty 只能删空目录，非空目录必须原封不动。
    #[test]
    fn prune_only_removes_empty_dirs() {
        let root = std::env::temp_dir().join(format!("gwork-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        prune_if_empty(Some(&empty));
        assert!(!empty.exists(), "空目录应被顺手删掉");

        let full = root.join("full");
        std::fs::create_dir_all(&full).unwrap();
        std::fs::write(full.join("keep.me"), b"x").unwrap();
        prune_if_empty(Some(&full));
        assert!(full.exists(), "非空目录绝不能被删");

        prune_if_empty(None); // 无父目录时不得 panic
        let _ = std::fs::remove_dir_all(&root);
    }
}
