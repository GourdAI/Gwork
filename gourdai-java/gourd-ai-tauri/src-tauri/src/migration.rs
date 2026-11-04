//! migration.rs —— 全局数据迁移（Rust 移植版）
//!
//! 移植自 gourd-ai-desktop/main/migration.js。
//!
//! 把旧版数据（`.gourdai`、staging、macOS Application Support）合并到 `~/.gwork`。
//! 用 `.desktop-migration-state.json` 记录已消费的源（避免重复合并），
//! 跳过 `bin` 目录、处理嵌套 `.gourdai/.gourdai`，复制目录、处理符号链接（Windows junction）。
//!
//! 源优先级（从高到低）：
//!   1. ~/.gwork（含打包资源里的 .gwork）
//!   2. <resources>/.gwork
//!   3. staging/install-gwork
//!   4. ~/.gourdai/.gourdai
//!   5. <resources>/.gourdai/.gourdai
//!   6. staging/install-gourdai/.gourdai
//!   7. staging/install-gourdai
//!   8. ~/.gourdai
//!   9. <resources>/.gourdai
//!  10. legacyRoots（macOS Application Support）
//!
//! 目标目录自身永远不会被覆盖；所有复制都是真实复制（绝不跨根 rename）。

use anyhow::Context;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tracing::warn;

/// staging 根目录名（位于用户主目录下）。
pub const STAGING_DIR: &str = ".gwork-desktop-migration";
/// staging 内两类安装树的名字。
pub const STAGING_NAMES: [&str; 2] = ["install-gwork", "install-gourdai"];
/// 旧品牌目录名。
pub const LEGACY_HOME: &str = ".gourdai";
/// 记录哪些「不可删除源」已被合并，避免每次启动重复合并
/// （否则会复活用户已删除的文件）。
pub const STATE_FILE: &str = ".desktop-migration-state.json";

/// 目标全局区目录：~/.gwork
fn target_dir() -> PathBuf {
    crate::cli_provision::runtime_home_dir().join(".gwork")
}

fn exists(p: &Path) -> bool {
    // lstat：对符号链接本身取状态，不跟随； dangling link 也视为存在。
    p.symlink_metadata().is_ok()
}

/// 复制单个条目（文件 / 目录 / 符号链接）到目标。已存在的目标永远优先。
fn copy_entry(source: &Path, target: &Path) -> std::io::Result<()> {
    let source_stat = std::fs::symlink_metadata(source)?;
    if exists(target) {
        let target_stat = std::fs::symlink_metadata(target)?;
        if source_stat.is_dir() && target_stat.is_dir() {
            copy_directory(source, target, false)?;
        }
        // 已存在的目标数据永远优先，包括 文件/目录 冲突。
        return Ok(());
    }

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if source_stat.is_dir() {
        std::fs::create_dir_all(target)?;
        copy_directory(source, target, false)?;
    } else if source_stat.file_type().is_symlink() {
        copy_symlink(source, target)?;
    } else {
        std::fs::copy(source, target)?;
    }
    Ok(())
}

/// 符号链接重建在 Windows 上需要 SeCreateSymbolicLinkPrivilege，普通用户没有。
/// 绝不让单个链接中断整个迁移：失败时退化为复制解析后的文件，否则跳过悬空链接。
fn copy_symlink(source: &Path, target: &Path) -> std::io::Result<()> {
    let link_target = std::fs::read_link(source)?;
    let result = {
        #[cfg(windows)]
        {
            // Windows 优先用 junction（目录）/ 硬链概念由 std 自行处理；
            // std::os::windows::fs::symlink_dir/file 需要权限，失败走兜底。
            let is_dir = std::fs::metadata(source).map(|m| m.is_dir()).unwrap_or(false);
            if is_dir {
                std::os::windows::fs::symlink_dir(&link_target, target)
            } else {
                std::os::windows::fs::symlink_file(&link_target, target)
            }
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&link_target, target)
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = (&link_target, target);
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "symlink unsupported",
            ))
        }
    };

    match result {
        Ok(()) => Ok(()),
        Err(e) => {
            // EPERM / EACCES / ENOSYS → 退化为复制
            let raw = e.raw_os_error();
            let is_perm = matches!(raw, Some(1) | Some(13) | Some(38)) // EPERM/EACCES/ENOSYS (unix)
                || e.kind() == std::io::ErrorKind::PermissionDenied
                || e.kind() == std::io::ErrorKind::Unsupported;
            if !is_perm {
                return Err(e);
            }
            // 尝试复制解析后的真实文件
            if let Ok(meta) = std::fs::metadata(source) {
                if meta.is_file() {
                    std::fs::copy(source, target)?;
                    return Ok(());
                }
            }
            // 悬空或不可读链接：没有值得复制的内容
            warn!("[migration] 跳过无法重建的符号链接: {}", source.display());
            Ok(())
        }
    }
}

/// 递归复制目录。
///
/// `top_level`：`bin` 和嵌套的 legacy home 只在迁移源的根目录特殊处理。
/// 在每一层都跳过会静默丢失合法嵌套数据，例如 `skills/<name>/bin`。
fn copy_directory(source: &Path, target: &Path, top_level: bool) -> std::io::Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(source)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let child = entry.path();
        if top_level {
            // 启动器由 cli-provision 重建；绝不导入旧根 bin。
            if name_str == "bin" {
                continue;
            }
            // 历史 bug 写入了 `.gourdai/.gourdai`；把该负载折叠进根。
            if name_str == LEGACY_HOME && entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                copy_directory(&child, target, true)?;
                continue;
            }
        }
        copy_entry(&child, &target.join(&name))?;
    }
    Ok(())
}

/// 读取迁移状态。损坏 / 缺失时返回空状态。
fn read_state(target_dir: &Path) -> serde_json::Value {
    let state_path = target_dir.join(STATE_FILE);
    let text = match std::fs::read_to_string(&state_path) {
        Ok(t) => t,
        Err(_) => return serde_json::json!({ "consumed": {} }),
    };
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) if v.get("consumed").map(|c| c.is_object()).unwrap_or(false) => v,
        _ => serde_json::json!({ "consumed": {} }),
    }
}

/// 写入迁移状态。只读主目录绝不能破坏启动；最坏情况是之后再合并一次。
fn write_state(target_dir: &Path, state: &serde_json::Value) {
    let state_path = target_dir.join(STATE_FILE);
    match serde_json::to_string_pretty(state) {
        Ok(text) => {
            if let Err(e) = std::fs::write(&state_path, text) {
                warn!("[migration] 迁移状态写入失败（不影响启动）: {}", e);
            }
        }
        Err(e) => {
            warn!("[migration] 迁移状态序列化失败（不影响启动）: {}", e);
        }
    }
}

/// 廉价的变更令牌：重装会重写目录，从而 bump 其 mtime。
/// 用毫秒时间戳字符串表示；读取失败返回空串。
fn fingerprint(source: &Path) -> String {
    std::fs::symlink_metadata(source)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| format!("{}", d.as_millis()))
        .unwrap_or_default()
}

/// macOS 旧版全局区（Application Support）作为迁移源。
#[cfg(target_os = "macos")]
fn legacy_roots() -> Vec<PathBuf> {
    let home = crate::cli_provision::resolve_user_home();
    let mac_app_data = home.join("Library").join("Application Support");
    vec![
        mac_app_data.join("Gourd AI").join(".gwork"),
        mac_app_data.join("Gourd AI").join(".gourdai"),
    ]
}

#[cfg(not(target_os = "macos"))]
fn legacy_roots() -> Vec<PathBuf> {
    Vec::new()
}

/// 把一个桌面安装的数据合并到用户规范的 ~/.gwork。
/// 源按优先级从高到低排序。目标自身永远不会被覆盖，所有复制都是真实复制。
///
/// 一次性源（安装 staging 树）在每次复制成功后被删除。
/// 持久源（安装目录和 legacy home，可能没有删除权限）则记录在
/// `.desktop-migration-state.json` 中，确保每个版本只合并一次。
///
/// 与 main.rs 的调用约定一致：`migration::migrate_global_data()`（无参数）。
pub fn migrate_global_data() -> Result<(), anyhow::Error> {
    let home_dir = crate::cli_provision::runtime_home_dir();
    let resources_dir = crate::cli_provision::resources_dir();
    let target_dir = target_dir();
    let staging_root = home_dir.join(STAGING_DIR);

    // (source, disposable)
    let mut candidates: Vec<(PathBuf, bool)> = Vec::new();
    let mut add = |source: PathBuf, disposable: bool| {
        // 规范化比较，避免重复源
        let key = normalize(&source);
        if !candidates.iter().any(|(s, _)| normalize(s) == key) {
            candidates.push((source, disposable));
        }
    };

    // 优先级从高到低：规范 .gwork（含打包资源），然后嵌套 legacy，然后外层 legacy。
    add(home_dir.join(".gwork"), false);
    add(resources_dir.join(".gwork"), false);
    add(staging_root.join("install-gwork"), true);
    add(home_dir.join(LEGACY_HOME).join(LEGACY_HOME), false);
    add(resources_dir.join(LEGACY_HOME).join(LEGACY_HOME), false);
    add(staging_root.join("install-gourdai").join(LEGACY_HOME), true);
    add(staging_root.join("install-gourdai"), true);
    add(home_dir.join(LEGACY_HOME), false);
    add(resources_dir.join(LEGACY_HOME), false);

    // 显式 legacy roots（特别是 macOS Application Support）仅作迁移源。
    // 接受 legacy .gwork/.gourdai 目录或其所在安装根；正常源排序仍然优先。
    for root in legacy_roots() {
        add(root, false);
    }

    std::fs::create_dir_all(&target_dir)
        .with_context(|| format!("创建目标全局区失败: {}", target_dir.display()))?;
    let state = read_state(&target_dir);
    let mut consumed: BTreeMap<String, String> = BTreeMap::new();
    let target_key = normalize(&target_dir);

    // 不把目标复制到自身；其内容已有最高优先级。
    for (source, disposable) in &candidates {
        if !exists(source) || normalize(source) == target_key {
            continue;
        }
        let key = normalize(source);
        let token = if *disposable { String::new() } else { fingerprint(source) };
        if !disposable && state["consumed"].get(&key).and_then(|v| v.as_str()) == Some(token.as_str()) {
            continue;
        }
        copy_directory(source, &target_dir, true)
            .with_context(|| format!("合并迁移源失败: {}", source.display()))?;
        if !disposable {
            consumed.insert(key, token);
        }
    }

    // staging 只有在整个合并完成后才可丢弃。
    for name in STAGING_NAMES {
        let staging = staging_root.join(name);
        // 只读残留绝不能把已完成的合并变成失败 → 忽略删除错误。
        if exists(&staging) {
            let _ = remove_dir_all_force(&staging);
        }
    }

    if !consumed.is_empty() {
        // 合并旧状态 + 新消费的源
        let mut merged = state["consumed"].clone();
        if !merged.is_object() {
            merged = serde_json::json!({});
        }
        if let Some(map) = merged.as_object_mut() {
            for (k, v) in consumed {
                map.insert(k, serde_json::Value::String(v));
            }
        }
        write_state(&target_dir, &serde_json::json!({ "consumed": merged }));
    }

    Ok(())
}

/// 规范化路径用于比较（不解析符号链接，仅做绝对化 + 去尾部分隔符）。
fn normalize(p: &Path) -> String {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().map(|c| c.join(p)).unwrap_or_else(|_| p.to_path_buf())
    };
    let s = abs.to_string_lossy().to_string();
    let s = s.trim_end_matches(['/', '\\']).to_string();
    #[cfg(windows)]
    {
        s.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        s
    }
}

/// 递归强制删除目录（尽力而为；只读文件先去除只读属性再删）。
fn remove_dir_all_force(path: &Path) -> std::io::Result<()> {
    // 先尝试直接删
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Windows 只读文件会导致删除失败：遍历去除只读后重试
            for entry in walkdir::WalkDir::new(path).follow_links(false) {
                if let Ok(entry) = entry {
                    if let Ok(meta) = entry.metadata() {
                        let mut perms = meta.permissions();
                        if perms.readonly() {
                            #[allow(clippy::permissions_set_readonly_false)]
                            perms.set_readonly(false);
                            let _ = std::fs::set_permissions(entry.path(), perms);
                        }
                    }
                }
            }
            std::fs::remove_dir_all(path)
        }
    }
}
