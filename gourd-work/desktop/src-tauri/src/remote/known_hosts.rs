//! remote/known_hosts.rs —— 应用自管的 SSH known_hosts（TOFU，按算法分行）。
//!
//! 绝不读写用户 `~/.ssh/known_hosts`（那是 OpenSSH 的地盘，桌面应用不应改写）；
//! 本文件落在 `<runtime_home>/.gwork/remote/known_hosts`。
//!
//! 行格式（三段）：`<hostkey> <algorithm> <fingerprint>`。
//! 与 OpenSSH known_hosts 同构：服务器可同时挂多把不同算法的主机密钥
//! （RSA / ECDSA / ED25519…），本次握手用哪把由 KEX 协商决定——必须按
//! 「主机 + 算法」分条记录，同一主机的多把密钥才能各自 TOFU。
//!
//! 【2026-10-08 真机缺陷（本格式的由来）】旧版只记指纹不记算法：首连协商到
//! ED25519 记了它的指纹，重连协商到 ECDSA/RSA → 指纹必然对不上 → 首连过的
//! 老主机被误判「主机密钥已更改」拒连（用户视角：从没动过的服务器突然报
//! 中间人警告）。
//!
//! 旧两段式行（`<hostkey> <fingerprint>`，算法不明）兼容读取：
//! - 指纹一致 → Match（旧记录命中的软匹配，不区分算法）；
//! - 指纹不一致 → Unknown（旧记录算法不明，不能武断判 Changed——那正是
//!   本缺陷本身；新指纹按 TOFU 重新记录三段行，旧两段线随 remove 清理）。
//!
//! 同算法指纹变化 → Changed 携带旧指纹，供错误信息展示与「忘记该主机」决策。

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::paths;

/// known_hosts 文件路径（随 runtime_home 走，与后端日志同区）。
pub fn default_path() -> PathBuf {
    paths::runtime_home_dir()
        .join(".gwork")
        .join("remote")
        .join("known_hosts")
}

/// 校验结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// 指纹匹配已知记录
    Match,
    /// 该主机该算法从未记录过
    Unknown,
    /// 该主机该算法有记录但指纹不同（携带旧指纹）
    Changed { expected: String },
}

/// 查询某主机（含端口）**某算法**的指纹是否与记录匹配。
///
/// `algorithm`：SSH 公钥算法名（`ssh-ed25519` / `ecdsa-sha2-nistp256` / `ssh-rsa`…）。
pub fn verify(
    path: &Path,
    host: &str,
    port: u16,
    algorithm: &str,
    fingerprint: &str,
) -> Result<Verdict> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Verdict::Unknown),
        Err(e) => return Err(anyhow::anyhow!("读取 known_hosts 失败: {}", e)),
    };

    let key = host_key(host, port);
    // 旧两段式行命中同指纹时的软匹配结论（见模块注释：算法不明只软匹配不判变）
    let mut legacy_match: Option<Verdict> = None;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut it = line.split_whitespace();
        let k = match it.next() {
            Some(v) => v,
            None => continue,
        };
        let (second, third, fourth) = (it.next(), it.next(), it.next());
        match (second, third, fourth) {
            // 新三段：<hostkey> <algorithm> <fingerprint>
            (Some(alg), Some(fp), None) => {
                if k != key || alg != algorithm {
                    continue;
                }
                return Ok(if fp == fingerprint {
                    Verdict::Match
                } else {
                    Verdict::Changed { expected: fp.to_string() }
                });
            }
            // 旧两段：<hostkey> <fingerprint>（算法不明）
            (Some(fp), None, None) => {
                if k != key {
                    continue;
                }
                if fp == fingerprint {
                    legacy_match = Some(Verdict::Match);
                }
                // 指纹不同：算法不明的旧线，不据此判 Changed（多算法误判正是本缺陷）
            }
            // 超段/残缺行：忽略
            _ => {}
        }
    }
    Ok(legacy_match.unwrap_or(Verdict::Unknown))
}

/// 追加一条指纹记录（TOFU 首连调用；三段行，见模块注释）。
pub fn record(
    path: &Path,
    host: &str,
    port: u16,
    algorithm: &str,
    fingerprint: &str,
) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).context("创建 known_hosts 目录失败")?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("打开 known_hosts 失败: {}", path.display()))?;
    writeln!(f, "{} {} {}", host_key(host, port), algorithm, fingerprint)?;
    Ok(())
}

/// 删除某主机（含端口）的**全部**指纹记录（各算法 + 旧两段线）。
/// 「忘记该主机」入口用：服务器确认换钥后清库重连，回到首连信任流程。
/// 返回删除的行数（0 = 本就没有记录/文件不存在）。
pub fn remove(path: &Path, host: &str, port: u16) -> Result<usize> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(anyhow::anyhow!("读取 known_hosts 失败: {}", e)),
    };

    let key = host_key(host, port);
    let mut removed = 0usize;
    let mut kept: Vec<&str> = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        let is_target = !trimmed.is_empty()
            && !trimmed.starts_with('#')
            && trimmed.split_whitespace().next() == Some(key.as_str());
        if is_target {
            removed += 1;
        } else {
            kept.push(line);
        }
    }
    if removed == 0 {
        return Ok(0);
    }
    // 原子替换：先写临时文件再 rename（读到写的窗口内崩溃不至于清空全库）
    let tmp = path.with_extension("tmp");
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).context("创建 known_hosts 目录失败")?;
    }
    let mut f = std::fs::File::create(&tmp)
        .with_context(|| format!("创建临时文件失败: {}", tmp.display()))?;
    for line in &kept {
        writeln!(f, "{}", line)?;
    }
    drop(f);
    std::fs::rename(&tmp, path)
        .with_context(|| format!("替换 known_hosts 失败: {}", path.display()))?;
    Ok(removed)
}

/// 主机键：非 22 端口用 `[host]:port`（OpenSSH 同款约定），22 端口裸 host。
pub fn host_key(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{}]:{}", host, port)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gwork-kh-test-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("known_hosts")
    }

    #[test]
    fn missing_file_is_unknown() {
        let p = tmp_file("missing");
        assert_eq!(
            verify(&p, "example.com", 22, "ssh-ed25519", "sha256-abc").unwrap(),
            Verdict::Unknown
        );
    }

    #[test]
    fn tofu_record_then_match_then_changed() {
        let p = tmp_file("tofu");
        // 首连：Unknown → record
        assert_eq!(
            verify(&p, "example.com", 2222, "ssh-ed25519", "sha256-AAA").unwrap(),
            Verdict::Unknown
        );
        record(&p, "example.com", 2222, "ssh-ed25519", "sha256-AAA").unwrap();
        // 重连：Match
        assert_eq!(
            verify(&p, "example.com", 2222, "ssh-ed25519", "sha256-AAA").unwrap(),
            Verdict::Match
        );
        // 同算法指纹变化：Changed 携带旧指纹
        match verify(&p, "example.com", 2222, "ssh-ed25519", "sha256-BBB").unwrap() {
            Verdict::Changed { expected } => assert_eq!(expected, "sha256-AAA"),
            other => panic!("应为 Changed，实得 {:?}", other),
        }
        // 同 host 不同端口是另一条记录
        assert_eq!(
            verify(&p, "example.com", 22, "ssh-ed25519", "sha256-BBB").unwrap(),
            Verdict::Unknown
        );
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    /// 【2026-10-08 缺陷回归】同一主机多算法各自 TOFU：首连记了 ED25519，
    /// 重连协商到 RSA/ECDSA 必须是 Unknown（首连信任），而不是误判 Changed。
    #[test]
    fn different_algorithm_is_unknown_not_changed() {
        let p = tmp_file("multi-alg");
        record(&p, "example.com", 22, "ssh-ed25519", "sha256-ED").unwrap();
        assert_eq!(
            verify(&p, "example.com", 22, "ssh-rsa", "sha256-RSA1").unwrap(),
            Verdict::Unknown,
            "另一把算法的密钥应按首连处理（正是旧版误报中间人的缺陷形态）"
        );
        // 各算法独立记录、独立匹配
        record(&p, "example.com", 22, "ssh-rsa", "sha256-RSA1").unwrap();
        assert_eq!(
            verify(&p, "example.com", 22, "ssh-ed25519", "sha256-ED").unwrap(),
            Verdict::Match
        );
        assert_eq!(
            verify(&p, "example.com", 22, "ssh-rsa", "sha256-RSA1").unwrap(),
            Verdict::Match
        );
        // 同算法指纹变化仍然拦截（MITM 防御不因多算法而放松）
        match verify(&p, "example.com", 22, "ssh-rsa", "sha256-RSA2").unwrap() {
            Verdict::Changed { expected } => assert_eq!(expected, "sha256-RSA1"),
            other => panic!("同算法指纹变化应为 Changed，实得 {:?}", other),
        }
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    /// 旧两段式行（无算法）兼容：同指纹 → Match；不同指纹 → Unknown（不判变）。
    #[test]
    fn legacy_two_segment_line_is_soft_matched() {
        let p = tmp_file("legacy");
        std::fs::write(&p, "example.com sha256-OLD\n").unwrap();
        // 同指纹：算法不明的软匹配
        assert_eq!(
            verify(&p, "example.com", 22, "ssh-ed25519", "sha256-OLD").unwrap(),
            Verdict::Match
        );
        // 不同指纹（即使碰巧是记录时的原算法）：不据此判 Changed——
        // 旧线算法不明，判变正是多算法误报的温床；走 Unknown → TOFU 重记
        assert_eq!(
            verify(&p, "example.com", 22, "ssh-ed25519", "sha256-NEW").unwrap(),
            Verdict::Unknown
        );
        // 新记录入三段行后，同算法判断回归精确
        record(&p, "example.com", 22, "ssh-ed25519", "sha256-NEW").unwrap();
        match verify(&p, "example.com", 22, "ssh-ed25519", "sha256-XXX").unwrap() {
            Verdict::Changed { expected } => assert_eq!(expected, "sha256-NEW"),
            other => panic!("三段行生效后应精确判变，实得 {:?}", other),
        }
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    /// remove：清掉该 host:port 全部算法的记录，保留其他主机与注释行。
    #[test]
    fn remove_clears_all_algorithms_for_host_only() {
        let p = tmp_file("remove");
        std::fs::write(
            &p,
            "# comment\n\
             example.com ssh-ed25519 sha256-ED\n\
             example.com ssh-rsa sha256-RSA\n\
             example.com sha256-LEGACY\n\
             [example.com]:2222 ssh-ed25519 sha256-OTHER-PORT\n\
             other.com ssh-ed25519 sha256-KEEP\n",
        )
        .unwrap();
        let removed = remove(&p, "example.com", 22).unwrap();
        assert_eq!(removed, 3, "22 端口的三条（两算法 + 旧两段）全清");
        let left = std::fs::read_to_string(&p).unwrap();
        assert!(left.contains("# comment"), "注释保留");
        assert!(left.contains("other.com ssh-ed25519 sha256-KEEP"), "其他主机保留");
        assert!(left.contains("[example.com]:2222"), "同主机不同端口是另一条记录，不动");
        assert!(!left.contains("sha256-LEGACY"));
        assert_eq!(remove(&p, "example.com", 22).unwrap(), 0, "再删返回 0");
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }

    #[test]
    fn remove_missing_file_returns_zero() {
        let p = tmp_file("remove-missing");
        assert_eq!(remove(&p, "example.com", 22).unwrap(), 0);
    }

    #[test]
    fn host_key_port_convention() {
        assert_eq!(host_key("h.com", 22), "h.com");
        assert_eq!(host_key("h.com", 2222), "[h.com]:2222");
    }

    #[test]
    fn comments_and_blank_lines_skipped() {
        let p = tmp_file("comments");
        std::fs::write(&p, "# comment\n\nexample.com ssh-ed25519 sha256-X\n").unwrap();
        assert_eq!(
            verify(&p, "example.com", 22, "ssh-ed25519", "sha256-X").unwrap(),
            Verdict::Match
        );
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
    }
}
