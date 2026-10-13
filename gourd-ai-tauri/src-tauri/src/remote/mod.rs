//! remote/mod.rs —— 远程工作区会话管理（P1 SSH 骨架 + P2 WSL + P3 CLI 预装的编排层）。
//!
//! 对应方案《远程工作区方案.md》v1.2 §五 `RemoteHostSession` 统一抽象。
//! 三通道（P1 起 SSH，P2 起 WSL，P3 起 CLI 预装）共用同一状态机/引用计数/命令面：
//!
//! - `RemoteConnection`：一次成功连接的完整产物（控制面会话 + 远端环境 + 数据面
//!   通道 + 远端后端 PID + Basic Auth 凭据）。host 级复用：同一 host 二次
//!   connect 时引用计数 +1，共享后端进程（方案 v1.2 §四「远端进程生命周期」）。
//! - `ControlPlane` 枚举：控制面会话（SSH = russh SshSession；WSL = WslSession；
//!   CLI 预装 = 复用 SSH 通道）。数据面由 `channel::DataPlane` 承载（SSH = 隧道；
//!   WSL = localhostForwarding 直连）。
//! - 全局注册表 `CONNECTIONS`：connectionId → RemoteConnection。断开减计数，
//!   归零销毁（kill 远端进程 + 关数据面 + 断控制面）。
//!
//! 凭据安全：SSH 密码/私钥口令仅存连接对象内存（不落盘，加密持久化 P4）；
//! Basic Auth 凭据随机生成、随连接销毁即失效。

pub mod channel;
pub mod deploy;
pub mod known_hosts;
pub mod mirror;
pub mod secrets;
pub mod ssh;
pub mod tunnel;
#[cfg(target_os = "windows")]
pub mod wsl;

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use lazy_static::lazy_static;
use rand::Rng;
use serde::Serialize;
use tokio::sync::Mutex;

use channel::DataPlane;
use ssh::{AuthMethod, SshSession, SshTarget};
use tunnel::Tunnel;

#[cfg(target_os = "windows")]
use wsl::WslSession;

/// 远端运行时获取解析链（离线/内网改造，一期）：L0 → L3a → L3b → L1 → L4。
///
/// - L0 远端系统 java 且主版本 ≥ 17（detect 解析 `java -version`）；
/// - L3a 远端预置运行时（气隙环境人工投放 `runtime/current` 或 `jre/<os>-<arch>`，
///   同样校验版本 ≥ 17——投放 Java 8 是另一种假成功）；
/// - L3b 用户在向导指定的本地离线包 tar.gz（`ConnectParams.runtime_pkg_path`）；
/// - L1 桌面安装包内置 jlink 运行时资产（`extraResources/runtime-linux-<arch>.tar.gz`，
///   内网/断网开箱即用；glibc 门禁拦截 musl 与 glibc<2.17）；
/// - L4 远端自装（Adoptium 下载，保留为有网远端的省流量路径；同为 glibc 构建，过门禁）。
///
/// 旧实现只有 L4 一条路（`ensure_remote_jre`），内网/无 curl 的远端第一步就卡死。
async fn ensure_remote_runtime(
    exec_ch: &dyn deploy::ExecChannel,
    env: &mut deploy::RemoteEnv,
    user_pkg_path: Option<&str>,
    progress: &mut (dyn FnMut(String) + Send),
) -> Result<()> {
    // L0：系统 java 可用
    if deploy::java_usable(env) {
        progress(format!(
            "[remote] 远端系统 Java 可用（主版本 {}）",
            env.java_major.unwrap_or(0)
        ));
        return Ok(());
    }
    if env.java.is_some() {
        progress(format!(
            "[remote] 远端 java 主版本 {} 低于 {}（jar 为 Java 17 编译），改走运行时解析链",
            env.java_major.unwrap_or(0),
            deploy::MIN_JAVA_MAJOR
        ));
    }

    // L3a：远端预置运行时（用户为该机器自备，不做 glibc 门禁）
    if deploy::preset_runtime_usable(env) {
        progress("[remote] 命中远端预置运行时（离线投放）".to_string());
        env.java = env.preset_runtime_java.clone();
        return Ok(());
    }
    if env.preset_runtime_java.is_some() {
        progress(format!(
            "[remote] 预置运行时主版本 {} 低于 {}，忽略",
            env.preset_java_major.unwrap_or(0),
            deploy::MIN_JAVA_MAJOR
        ));
    }

    // L3b：用户指定离线包（用户自选资产，不做 glibc 门禁；布局校验在部署链内）
    if let Some(pkg) = user_pkg_path.filter(|s| !s.trim().is_empty()) {
        let bytes = tokio::fs::read(pkg)
            .await
            .with_context(|| format!("读取离线运行时包失败: {}", pkg))?;
        let fp = deploy::fingerprint_of(&bytes);
        // 指纹比对防御（与 jar 链 deploy_and_switch 同构）：detect 已读回远端
        // runtime/current 指纹，同包重连不重传。主防御在调用方（包未变不应读文件），
        // 此处兼作「调用方漏比对」时的兜底（codereview P2-1）。
        if env.runtime_fingerprint.as_deref() == Some(fp.as_str()) {
            progress(format!("[remote] 用户离线包 {} 已部署（跳过上传）", fp));
            env.java = Some(deploy::remote_runtime_java(env));
            return Ok(());
        }
        progress(format!(
            "[remote] 上传用户离线运行时包（{} KB，指纹 {}）…",
            bytes.len() / 1024,
            fp
        ));
        let uploader = exec_ch.uploader();
        deploy::deploy_runtime(
            exec_ch,
            env,
            &fp,
            bytes,
            uploader.as_ref(),
            &mut upload_progress_printer(progress),
        )
        .await?;
        env.java = Some(deploy::remote_runtime_java(env));
        env.runtime_fingerprint = Some(fp);
        progress("[remote] 离线运行时部署完成".to_string());
        return Ok(());
    }

    // glibc 门禁：L1/L4 资产均为 glibc 构建，musl/过老 glibc 上传了也跑不起来，
    // 在传输前明确报错（而不是死在启动后的 60s 探活）。
    if let Err(reason) = deploy::libc_gate(env.libc.as_deref()) {
        return Err(anyhow!("{}", reason));
    }

    // L1：安装包内置运行时资产（仅 Linux 远端；macOS 远端不产资产，见 bundled_runtime_asset）
    if let Some((asset_path, tag)) = bundled_runtime_asset(crate::paths::resources_dir(), &env.platform, &env.arch)
    {
        let bytes = tokio::fs::read(&asset_path)
            .await
            .with_context(|| format!("读取内置运行时资产失败: {}", asset_path.display()))?;
        let fp = deploy::fingerprint_of(&bytes);
        // 指纹比对防御（同 L3b）：同资产重连零上传；L0/L3a 已覆盖「远端有可用
        // java」的常规重连，此处只防「远端 runtime 已就位但 detect 未判可用」的边角。
        if env.runtime_fingerprint.as_deref() == Some(fp.as_str()) {
            progress(format!("[remote] 内置运行时 {} 已部署（跳过上传）", fp));
            env.java = Some(deploy::remote_runtime_java(env));
            env.runtime_fingerprint = Some(fp);
            return Ok(());
        }
        progress(format!(
            "[remote] 远端无可用 Java，上传内置运行时（{}，{} MB，离线可用）…",
            tag,
            bytes.len() / 1024 / 1024
        ));
        let uploader = exec_ch.uploader();
        deploy::deploy_runtime(
            exec_ch,
            env,
            &fp,
            bytes,
            uploader.as_ref(),
            &mut upload_progress_printer(progress),
        )
        .await?;
        env.java = Some(deploy::remote_runtime_java(env));
        env.runtime_fingerprint = Some(fp);
        progress("[remote] 内置运行时部署完成，current-runtime 已切换".to_string());
        return Ok(());
    }

    // L4：远端自装（有网远端省流量；保留旧链）
    remote_self_install_jre(exec_ch, env, progress).await
}

/// 上传字节进度 → 向导日志（节流：仅 0% / 5% 整数倍 / 完成 才打一行，避免刷屏）。
fn upload_progress_printer<'a>(
    progress: &'a mut (dyn FnMut(String) + Send),
) -> impl FnMut(u64, u64) + Send + 'a {
    let mut last_pct = u32::MAX;
    move |done: u64, total: u64| {
        let pct = if total == 0 { 100 } else { (done * 100 / total) as u32 };
        let finished = total == 0 || done >= total;
        if !finished && pct != 0 && pct % 5 != 0 {
            return;
        }
        if pct == last_pct && !finished {
            return;
        }
        last_pct = pct;
        progress(format!(
            "[remote] 上传进度 {}%（{}/{} KB）",
            pct,
            done / 1024,
            total / 1024
        ));
    }
}

/// 安装包内置运行时资产（L1）：`<resources>/runtimes/runtime-linux-<arch>.tar.gz`。
///
/// 纯函数（base 注入，单测覆盖）——codereview 修两处：
/// - **P0-2 路径**：tauri.conf 把 `build/extraResources/runtimes/` 映射到安装包的
///   `extraResources/runtimes/` 子目录（make-runtime-linux.js 也产出到 runtimes/），
///   旧实现拼在 resources 根 → 发布版上 exists() 恒 false，L1 静默失效、内网远端
///   被推去 L4 自装（无网必死，正是本主题要解决的场景）；
/// - **P1-2 平台门禁**：旧实现只判 arch 不判 platform——macOS 远端（uname -m 同为
///   x86_64/aarch64）会命中 linux 资产并上传，部署后启动必崩。资产名自带 linux
///   前缀，platform 非 Linux 直接 None（走 L4 的 mac 分支或报错）。
///
/// 资产缺失（旧安装包/开发态未生成）返回 None → 解析链继续走 L4。
fn bundled_runtime_asset(
    base: std::path::PathBuf,
    platform: &str,
    arch: &str,
) -> Option<(std::path::PathBuf, String)> {
    if platform != "Linux" {
        return None;
    }
    let tag = match arch {
        "x86_64" | "amd64" => "linux-x64",
        "aarch64" | "arm64" => "linux-aarch64",
        _ => return None,
    };
    let p = base.join("runtimes").join(format!("runtime-{}.tar.gz", tag));
    if p.exists() {
        Some((p, tag.to_string()))
    } else {
        None
    }
}

/// L4：远端自装 JRE（Adoptium/Temurin 17，带 sha256 校验；保留旧实现）。
/// 失败（无下载器/平台不支持）返回 Err（消息带手装指引）；成功返回 ()，
/// env.java 由本函数用 remote_jre_java 回填。
async fn remote_self_install_jre(
    exec_ch: &dyn deploy::ExecChannel,
    env: &mut deploy::RemoteEnv,
    progress: &mut (dyn FnMut(String) + Send),
) -> Result<()> {
    let Some((os, arch)) = deploy::adoptium_target(&env.platform, &env.arch) else {
        return Err(anyhow!(
            "远端无 Java 且平台 {} {} 暂不支持自动安装（Adoptium 无对应 JRE）；请手动安装 JDK 17+ 后重连",
            env.platform,
            env.arch
        ));
    };
    progress(format!(
        "[remote] 远端无 Java，自动安装 Temurin JRE 17（{} {}，Adoptium 下载带 sha256 校验）…",
        os, arch
    ));
    let cmd = deploy::install_jre_command(env, &os, &arch);
    let res = exec_ch.exec(&cmd).await?;
    if res.exit_code == 0 && (res.stdout.trim() == "SKIP" || res.stdout.trim() == "INSTALLED") {
        env.java = Some(deploy::remote_jre_java(env, &os, &arch));
        progress(format!(
            "[remote] JRE 就绪（{}）",
            if res.stdout.trim() == "SKIP" { "已存在，跳过下载" } else { "下载安装完成" }
        ));
        return Ok(());
    }
    // 失败原因映射（脚本内 echo 的标记）
    let hint = match res.stdout.trim() {
        s if s.ends_with("NO_DOWNLOADER") => "远端无 curl/wget（离线服务器）——请手动安装 JDK 17+ 或配置网络后重试".to_string(),
        s if s.ends_with("NO_CHECKSUM") => "Adoptium 元数据获取失败（网络受限？）".to_string(),
        s if s.ends_with("CHECKSUM_MISMATCH") => "下载校验失败（网络劫持或磁盘故障）".to_string(),
        s if s.ends_with("NO_JAVA") => "解压后未找到 java 可执行文件".to_string(),
        _ => {
            // 尾部片段：取「尾部 200 字符」（UTF-8 边界安全）与 ExecResult::ok_or_error
            // 同口径；stdout/stderr 为空时直接空串，不 panic（原 [min(200)..] 切片在空串时
            // 会切出 ""，非空不足 200 时正确，但语义不明确——统一走边界安全实现）
            format!(
                "exit={} stdout_tail={} stderr_tail={}",
                res.exit_code,
                ssh::sanitize_output_tail(&tail_chars(&res.stdout, 200)),
                ssh::sanitize_output_tail(&tail_chars(&res.stderr, 200))
            )
        }
    };
    Err(anyhow!("远端 JRE 自动安装失败：{}（可手动安装 JDK 17+ 后重连）", hint))
}

/// 尾部 n 字符（UTF-8 边界安全；空串返回空串）。与 ExecResult::ok_or_error 的
/// 尾部截取同语义，但按字符而非字节切，多字节字符不会被劈出 U+FFFD。
fn tail_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    s.chars().skip(s.chars().count() - n).collect()
}

/// 连接方式（向导三通道）。内部枚举不序列化（前端传字符串，channel_kind 解析）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelKind {
    /// SSH（P1）：russh 进程内客户端，数据面 direct-tcpip 隧道
    Ssh,
    /// WSL（P2，仅 Windows 宿主）：wsl.exe + localhostForwarding 直连
    #[cfg(target_os = "windows")]
    Wsl,
    /// CLI 预装（P3）：复用 SSH 通道，探测到 gwork 则跳过部署
    Preinstalled,
}

/// 前端连接请求参数（tauri command 入参）。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ConnectParams {
    /// 通道形态（"ssh" | "wsl" | "preinstalled"，缺省 ssh 兼容 P1 前端）
    #[serde(default)]
    pub channel: Option<String>,
    pub host: String,
    pub port: Option<u16>,
    pub user: String,
    pub auth_type: String, // "password" | "key"
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub passphrase: Option<String>,
    /// P4 ProxyJump：跳板机（可选）。字段存在且 host 非空时走 connect_via_jump。
    #[serde(default)]
    pub jump_host: Option<String>,
    #[serde(default)]
    pub jump_port: Option<u16>,
    #[serde(default)]
    pub jump_user: Option<String>,
    #[serde(default)]
    pub jump_password: Option<String>,
    #[serde(default)]
    pub jump_key_path: Option<String>,
    #[serde(default)]
    pub jump_passphrase: Option<String>,
    /// 离线运行时包（可选，本地路径）：内网/气隙远端无 Java 时优先上传该包
    /// （解析链 L3b）。tar.gz，顶层 flat 或单层顶目录均可（部署链布局归一）。
    #[serde(default)]
    pub runtime_pkg_path: Option<String>,
}

impl ConnectParams {
    /// 通道形态解析（未知值报错，缺省 ssh —— P1 老前端不带 channel 字段仍走 SSH）。
    fn channel_kind(&self) -> Result<ChannelKind> {
        match self.channel.as_deref() {
            None | Some("ssh") => Ok(ChannelKind::Ssh),
            #[cfg(target_os = "windows")]
            Some("wsl") => Ok(ChannelKind::Wsl),
            #[cfg(not(target_os = "windows"))]
            Some("wsl") => Err(anyhow!("WSL 通道仅 Windows 宿主可用")),
            Some("preinstalled") => Ok(ChannelKind::Preinstalled),
            Some(other) => Err(anyhow!("未知通道形态: {}", other)),
        }
    }

    /// 凭据库键（与 secrets::entry_key 同构；WSL 形态 port 恒 0 占位）。
    /// 只对「身份」维度建键，与存储内容（密码或私钥口令）无关。
    fn secrets_key(&self) -> String {
        match self.channel_kind() {
            #[cfg(target_os = "windows")]
            Ok(ChannelKind::Wsl) => secrets::entry_key(&format!("wsl:{}", self.host), 0, &self.user),
            _ => secrets::entry_key(&self.host, self.port.unwrap_or(22), &self.user),
        }
    }

    /// 凭据回填（P4 记住密码）：密码/口令字段为空时从 OS 凭据库读取。
    /// 未记住 → 字段保持空，走「认证失败」正常报错链（不额外造错误）。
    /// 注意空串也算「未填」（前端 key 模式传空字符串而非 null，is_none() 漏判）。
    fn autofill_secret(&mut self) {
        if self.channel_kind().is_err() {
            return; // 未知通道在 connect 主体报错，这里不抢先
        }
        let need_password = self.auth_type == "password"
            && self.password.as_deref().map(str::trim).unwrap_or("").is_empty();
        let need_passphrase = self.auth_type == "key"
            && self.passphrase.as_deref().map(str::trim).unwrap_or("").is_empty();
        if !need_password && !need_passphrase {
            return;
        }
        if let Some(secret) = secrets::load(&self.secrets_key()) {
            if need_password {
                self.password = Some(secret);
            } else {
                self.passphrase = Some(secret);
            }
            tracing::info!("[remote] 已从凭据库回填认证凭据（{}）", self.secrets_key());
        }
    }

    fn auth(&self) -> Result<AuthMethod> {
        match self.auth_type.as_str() {
            "password" => Ok(AuthMethod::Password {
                password: self
                    .password
                    .clone()
                    .ok_or_else(|| anyhow!("password 认证缺少 password 字段"))?,
            }),
            "key" => Ok(AuthMethod::PrivateKey {
                key_path: self
                    .key_path
                    .clone()
                    .ok_or_else(|| anyhow!("key 认证缺少 keyPath 字段"))?,
                passphrase: self.passphrase.clone(),
            }),
            other => Err(anyhow!("未知认证方式: {}", other)),
        }
    }

    fn target(&self) -> SshTarget {
        SshTarget {
            host: self.host.clone(),
            port: self.port.unwrap_or(22),
            user: self.user.clone(),
        }
    }

    /// host 身份键（三通道口径的唯一来源）：SSH / CLI 预装 = `host:port:user`；
    /// WSL = `wsl:distro:user`（该通道无端口概念，distro 名复用 host 字段）。
    /// 预装与 SSH 同键：同一台机走哪条部署链对后端透明，必须共享引用计数。
    ///
    /// 抽成方法的动机（方案B）：进度事件要在连接**建立之前**就给每帧打上
    /// connectionId（前端并发连两台时靠它把日志分进正确的向导），于是同一份键推导
    /// 会同时被 connect 与事件打标签两处用到——写两遍必然漂移，而漂移的表现是
    /// 「日志串到另一台机器的向导里」，只在并发场景偶发，极难复现。
    fn host_key(&self, kind: ChannelKind) -> String {
        match kind {
            ChannelKind::Ssh | ChannelKind::Preinstalled => host_key_of(&self.target()),
            #[cfg(target_os = "windows")]
            ChannelKind::Wsl => format!("wsl:{}:{}", self.host, self.user),
        }
    }

    /// P4 ProxyJump：跳板机配置（无跳板机字段/ host 为空 → None）。
    ///
    /// 跳板机认证回退链（P2 修复）：jump_password 专用密码 → 主连接同款私钥
    /// （key 认证时）。原实现只认 jump_password，key 认证 + 未填跳板机密码时
    /// 直接报「跳板机密码缺失」——但向导的跳板机折叠盒没有私钥输入位，用户
    /// 在主连接选 key 认证时永远填不出跳板机凭据（死路）。补上私钥回退后，
    /// 「主/跳板机同一把 key」的最常见拓扑（ssh -J 默认行为）开箱即用。
    fn jump(&self) -> Result<Option<ssh::JumpHost>> {
        let Some(host) = self.jump_host.as_deref().map(str::trim).filter(|h| !h.is_empty()) else {
            return Ok(None);
        };
        let user = self
            .jump_user
            .clone()
            .ok_or_else(|| anyhow!("跳板机缺少用户名（jump_user）"))?;
        let auth = match self.auth_type.as_str() {
            "password" => {
                let pass = self
                    .jump_password
                    .clone()
                    .filter(|p| !p.trim().is_empty())
                    .or_else(|| self.password.clone().filter(|p| !p.trim().is_empty()))
                    .ok_or_else(|| anyhow!("跳板机密码缺失（勾选记住后可免填）"))?;
                ssh::AuthMethod::Password { password: pass }
            }
            "key" => ssh::AuthMethod::PrivateKey {
                key_path: self
                    .jump_key_path
                    .clone()
                    .filter(|p| !p.trim().is_empty())
                    .or_else(|| self.key_path.clone())
                    .ok_or_else(|| anyhow!("跳板机缺少私钥路径（默认复用主连接私钥）"))?,
                passphrase: self.jump_passphrase.clone().or_else(|| self.passphrase.clone()),
            },
            other => return Err(anyhow!("跳板机不支持认证方式: {}", other)),
        };
        Ok(Some(ssh::JumpHost {
            host: host.to_string(),
            port: self.jump_port.unwrap_or(22),
            user,
            auth,
        }))
    }
}

/// 连接状态机（前端徽标 + 断线提示用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnState {
    /// 已连接且远端后端就绪
    Connected,
    /// 连接中断（SSH 断开或远端进程死亡）
    Disconnected,
}

/// 控制面会话（三通道统一持有形态）。
///
/// - SSH / CLI 预装（P3 复用 SSH）：`Ssh(Arc<SshSession>)`
/// - WSL（P2）：`Wsl(Arc<WslSession>)` —— 生命周期由连接管理，dispose 只杀
///   自己 spawn 的 wsl.exe（见 wsl.rs 模块注释，绝不 terminate distro）
#[derive(Clone)]
pub enum ControlPlane {
    Ssh(Arc<SshSession>),
    #[cfg(target_os = "windows")]
    Wsl(Arc<WslSession>),
}

impl ControlPlane {
    /// 控制面 exec（统一出口，供探活/停止等生命周期操作）。
    pub async fn exec(&self, command: &str) -> Result<ssh::ExecResult> {
        match self {
            ControlPlane::Ssh(s) => s.exec(command).await,
            #[cfg(target_os = "windows")]
            ControlPlane::Wsl(s) => s.exec(command).await,
        }
    }

    /// 断开控制面（幂等）。
    pub async fn shutdown(&self) {
        match self {
            ControlPlane::Ssh(s) => s.disconnect().await,
            #[cfg(target_os = "windows")]
            ControlPlane::Wsl(_) => {
                // WSL 无长连接可断：wsl.exe 每次命令独立进程，已随命令结束退出。
                // 后端进程的停止由 disconnect() 的 kill 流程处理。
            }
        }
    }

    /// host 展示名（徽标/日志用）。
    fn display_host(&self) -> String {
        match self {
            ControlPlane::Ssh(s) => s.target.host.clone(),
            #[cfg(target_os = "windows")]
            ControlPlane::Wsl(s) => format!("wsl:{}", s.distro),
        }
    }

    /// user 展示名。
    fn display_user(&self) -> String {
        match self {
            ControlPlane::Ssh(s) => s.target.user.clone(),
            #[cfg(target_os = "windows")]
            ControlPlane::Wsl(s) => s.user.clone(),
        }
    }
}

/// 一条活跃的远程连接（host 级复用单位）。
pub struct RemoteConnection {
    /// host 身份键（ssh: host:port:user / wsl: distro:user / preinstalled 同 ssh）——引用计数挂点
    pub host_key: String,
    pub control: ControlPlane,
    pub env: deploy::RemoteEnv,
    /// 远端后端进程 PID（0 = 未知/未启动）
    pub remote_pid: u32,
    /// 远端后端监听端口（远端回环）
    pub remote_port: u16,
    /// 数据面（SSH = 隧道；WSL = 直连同端口）。None 仅在构造瞬态。
    pub data: Option<DataPlane>,
    /// Basic Auth（桌面端→远端 jar 的访问凭据，随连接生成）
    pub auth_user: String,
    pub auth_pass: String,
    /// 引用计数：同 host 每多一个 workspace 引用 +1；归零销毁（方案 v1.2）
    pub refs: std::sync::atomic::AtomicUsize,
    /// 断连时间戳（Disconnected 徽标 + 重连提示用）
    pub state: std::sync::atomic::AtomicU8,
    /// 探活代际：每次 register_connection（含重连重建）+1。
    /// 旧探活循环凭 connectionId 查表，重连后同 id 的新连接会被旧循环误判
    /// （旧控制面已死 → 探活失败 → 把刚建好的新连接置 Disconnected 并摘路由）。
    /// 循环持代际快照，查到的连接代际不符即自退（新循环已接管）。
    pub health_generation: std::sync::atomic::AtomicU64,
}

impl RemoteConnection {
    /// 前端分流要用的 Authorization 头值。
    pub fn basic_auth_header(&self) -> String {
        basic_auth_value(&self.auth_user, &self.auth_pass)
    }

    fn conn_state(&self) -> ConnState {
        match self.state.load(std::sync::atomic::Ordering::SeqCst) {
            0 => ConnState::Connected,
            _ => ConnState::Disconnected,
        }
    }

    fn local_port(&self) -> u16 {
        self.data.as_ref().map(|d| d.local_port()).unwrap_or(0)
    }
}

lazy_static! {
    /// 全局连接注册表：connectionId → 连接。
    static ref CONNECTIONS: Mutex<HashMap<String, Arc<RemoteConnection>>> = Mutex::new(HashMap::new());
    /// 各连接最近一次连接尝试的参数（P4 断线重连用：remote_reconnect 复刻同一目标），
    /// key = connectionId。只存参数不存凭据明文以外的状态；凭据若来自 keyring 回填，
    /// 重连时重新回填。
    ///
    /// 【方案B：为何从单值 Option 改成分账】多连接并发时单值会被「后连的那台」覆盖：
    /// 先连 A 再连 B，A 掉线后自动重连取到的却是 B 的参数——重连到错误的机器比不
    /// 重连更糟（A 上的活永远回不来，而 B 被无端重启一次远端后端）。
    static ref LAST_PARAMS: Mutex<HashMap<String, ConnectParams>> = Mutex::new(HashMap::new());
    /// 最近一次写入 LAST_PARAMS 的键：`remote_reconnect(None)` 的回落目标
    /// （= 旧版单值语义「重连最后一台」，老前端不传 id 时行为不变）。
    /// HashMap 不保插入序，故另记一个键；不为此引入 IndexMap（crate 无此依赖，
    /// 为一个回落语义加依赖不划算）。
    static ref LAST_PARAMS_KEY: Mutex<Option<String>> = Mutex::new(None);
}

/// 退出清理的单条连接限时（秒）。见 [`shutdown_all`] 的阻塞理由说明。
const SHUTDOWN_PER_CONN_TIMEOUT_SECS: u64 = 4;

/// 生成 Basic Auth 随机凭据（每次连接独立；24 hex 字符密码）。
fn random_credentials() -> (String, String) {
    let user = "gwork".to_string();
    let pass: String = (0..24)
        .map(|_| {
            const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
            let idx = rand::thread_rng().gen_range(0..ALPHABET.len());
            ALPHABET[idx] as char
        })
        .collect();
    (user, pass)
}

/// Basic Auth 头值（自由函数便于单测，不依赖整连接对象）。
fn basic_auth_value(user: &str, pass: &str) -> String {
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", user, pass))
    )
}

/// host 身份键。
fn host_key_of(target: &SshTarget) -> String {
    format!("{}:{}:{}", target.host, target.port, target.user)
}

/// 注册表 / 路由表用的连接 ID（= rc- + host_key）。
///
/// 【P0 修复：为何必须抽函数】旧版 connect 的复用检查用裸 host_key 查
/// CONNECTIONS，而写入键是 rc- 前缀版——两键形状不一致，复用分支永不命中。
/// 后果不是「少一次复用」，而是：同一远端每连一次都先走 register 里的
/// 「旧连接回收」把上一个远端后端 kill 掉再重开——正在那个后端上跑的
/// 任务被无端打断，引用计数永远是 1（多工作区共享后端的语义完全落空）。
/// 名字收敛到一处，调用点不可能再自己拼出第二个形状。
fn connection_id_of(host_key: &str) -> String {
    format!("rc-{}", host_key)
}

/// 记录一次连接尝试的参数快照（key = connectionId）+ 更新「最近一台」回落键。
///
/// 两把锁必须在同一段内连续持有（先 map 后 key）：分开加锁的话，并发连两台时
/// A 写完参数、B 插进来写完并把回落键指到自己，A 再写回落键就把「最近」指回一台
/// 其实更旧的连接——`remote_reconnect(None)` 于是重连错目标。
async fn remember_params(host_key: &str, params: &ConnectParams) {
    let id = connection_id_of(host_key);
    let mut map = LAST_PARAMS.lock().await;
    map.insert(id.clone(), params.clone());
    *LAST_PARAMS_KEY.lock().await = Some(id);
}

/// 由连接参数推导 connectionId（进度事件打标签用）。
///
/// 发射点位于连接建立**之前**（注册表里还没有这条），只能由参数推导；推导必须与
/// connect 的键同源（都过 `ConnectParams::host_key`），否则前端按 id 过滤日志时会把
/// 帧全丢掉（比混流更糟：向导日志一片空白）。通道形态非法时返回 None——该次连接
/// 注定失败，错误由 connect 主体报出，这里不抢先造第二个错误。
fn connection_id_of_params(params: &ConnectParams) -> Option<String> {
    params
        .channel_kind()
        .ok()
        .map(|kind| connection_id_of(&params.host_key(kind)))
}

/// 连接结果（返回给前端的连接描述）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectOutcome {
    pub connection_id: String,
    pub local_port: u16,
    pub remote_port: u16,
    pub host: String,
    pub user: String,
    pub platform: String,
    pub arch: String,
    pub java: Option<String>,
    pub deployed_fingerprint: String,
    pub auth_header: String,
    pub remote: bool,
}

/// 执行一次完整连接（connect → detect → 部署(按需) → 启动后端 → 数据面）。
///
/// 三通道分流（P1 SSH / P2 WSL / P3 CLI 预装）：
/// - SSH：russh 连接认证 → detect → 版本化部署 → 启动 → direct-tcpip 隧道
/// - WSL：wsl.exe -e 直 exec（绕默认 shell 预解析）→ detect → 版本化部署（UNC 上传）→ 启动 → localhost 直连
/// - CLI 预装：SSH 通道 → detect + gwork 探测 → 命中则跳过部署（JAVA_TOOL_OPTIONS
///   注入启动）；未命中回退标准部署链（方案 §四「CLI 预装连接」）
///
/// host 复用：同 host_key 已有活跃连接 → 引用计数 +1 直接返回既有数据面/凭据，
/// 不重启远端后端（多 workspace 共享后端进程，方案 v1.2 引用计数语义）。
///
/// 进度回调：行级文本日志（前端连接向导实时展示）。
pub async fn connect(
    app: tauri::AppHandle,
    params: ConnectParams,
    progress: &mut (dyn FnMut(String) + Send),
) -> Result<ConnectOutcome> {
    let kind = params.channel_kind()?;
    let target = params.target();
    // host 身份键：SSH 形态 host:port:user；WSL 形态 wsl:distro:user（无端口概念）。
    // 预装模式与 SSH 同键（同一台机走哪条部署链对后端透明，共享引用计数）。
    let host_key = params.host_key(kind);
    // P4 断线重连记忆：按 connectionId 分账记录参数快照，供 remote_reconnect 复刻。
    // 必须排在 host_key 之后（键是它的派生物，同源才不会分叉）。
    remember_params(&host_key, &params).await;

    // ── host 复用检查 ──────────────────────────────────────────────
    // 查表键必须用 connection_id_of（= 注册时的键）；用裸 host_key 会永不命中，
    // 于是「复用」变「重建 + 杀掉上一个还在跑任务的远端后端」（P0）。
    {
        let reuse_key = connection_id_of(&host_key);
        let conns = CONNECTIONS.lock().await;
        if let Some(existing) = conns.get(&reuse_key) {
            if existing.conn_state() == ConnState::Connected {
                existing.refs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                progress(format!("[remote] 复用已有连接 {}", reuse_key));
                return Ok(existing_outcome(existing));
            }
        }
    }

    match kind {
        ChannelKind::Ssh => connect_ssh(app, params, target, host_key, progress).await,
        #[cfg(target_os = "windows")]
        ChannelKind::Wsl => connect_wsl(app, params, host_key, progress).await,
        ChannelKind::Preinstalled => {
            connect_preinstalled(app, params, target, host_key, progress).await
        }
    }
}

/// SSH 通道（P1 原链路，抽公共段后的主体）。
async fn connect_ssh(
    app: tauri::AppHandle,
    params: ConnectParams,
    target: SshTarget,
    host_key: String,
    progress: &mut (dyn FnMut(String) + Send),
) -> Result<ConnectOutcome> {
    progress(format!("[remote] 连接 {}:{} …", target.host, target.port));

    // ── SSH 连接 + 认证（P4：有跳板机配置时经 direct-tcpip 串联） ──────
    let auth = params.auth()?;
    let session = if let Some(jump) = params.jump()? {
        progress(format!(
            "[remote] 经跳板机 {}:{} 连接 {}:{} …",
            jump.host, jump.port, target.host, target.port
        ));
        let s = SshSession::connect_via_jump(target.clone(), &auth, &jump).await?;
        s
    } else {
        SshSession::connect(target.clone(), &auth).await?
    };
    progress(format!("[remote] SSH 已连接（用户 {}），探测环境…", target.user));

    // ── detect ─────────────────────────────────────────────────────────
    let mut env = deploy::detect(&session).await?;
    progress(format!(
        "[remote] 远端 {} {}，java={}（主版本 {}）",
        env.platform,
        env.arch,
        env.java.as_deref().unwrap_or("<无>"),
        env.java_major.map(|m| m.to_string()).unwrap_or_else(|| "?".into())
    ));
    ensure_remote_runtime(&session, &mut env, params.runtime_pkg_path.as_deref(), progress).await?;

    // ── 部署（指纹比对跳过） ───────────────────────────────────────
    let root = deploy_and_switch(&session, &env, progress).await?;

    // ── 启动远端后端 ───────────────────────────────────────────────
    let (auth_user, auth_pass) = random_credentials();
    let remote_port = allocate_remote_port(&session).await?;
    let start_cmd =
        deploy::backend_start_command(&env, &root, remote_port, &auth_user, &auth_pass)?;
    progress(format!("[remote] 启动远端后端（端口 {}）…", remote_port));
    let start_res = session.exec(&start_cmd).await?;
    let pid = parse_pid(&start_res, "start backend")?;
    progress(format!("[remote] 远端后端 PID={}", pid));

    // 【2026-10-10 154 事故修复】启动后任何失败都必须回收已 spawn 的远端后端：
    // 旧实现直接 `?` 返回，孤儿 java（Xmx1024m 常驻）无人 kill，多次失败累积
    // 吃内存形成「越失败越连不上」自增强循环；且超时错误不帶现场诊断。
    // 【2026-10-10 154 事故修复】隧道先建、就绪探活改走数据面 HTTP（旧顺序
    // 是远端 shell 探端口先于隧道——探针原语不可靠且探不到隧道健康）。
    // direct-tcpip 的目标地址是「远端视角」——远端后端只听远端回环，恒传 127.0.0.1
    let tunnel = match Tunnel::start(session.handle(), remote_port, "127.0.0.1".to_string()).await
    {
        Ok(t) => t,
        Err(e) => {
            kill_started_backend_best_effort(&session, pid, progress).await;
            return Err(e);
        }
    };
    progress(format!(
        "[remote] 隧道就绪 127.0.0.1:{} → {}:{}",
        tunnel.local_port, target.host, remote_port
    ));

    if let Err(e) = wait_backend_ready(tunnel.local_port, &auth_user, &auth_pass, progress).await {
        kill_started_backend_best_effort(&session, pid, progress).await;
        return Err(attach_remote_diagnostics(&session, e).await);
    }

    let conn = Arc::new(RemoteConnection {
        host_key: host_key.clone(),
        control: ControlPlane::Ssh(Arc::new(session)),
        env,
        remote_pid: pid,
        remote_port,
        data: Some(DataPlane::Tunnel(Arc::new(tunnel))),
        auth_user,
        auth_pass,
        refs: std::sync::atomic::AtomicUsize::new(1),
        state: std::sync::atomic::AtomicU8::new(0),
        health_generation: std::sync::atomic::AtomicU64::new(0),
    });

    Ok(register_connection(app, host_key, conn).await)
}

/// WSL 通道（P2）：wsl.exe 控制面 + localhostForwarding 数据面（无隧道）。
#[cfg(target_os = "windows")]
async fn connect_wsl(
    app: tauri::AppHandle,
    params: ConnectParams,
    host_key: String,
    progress: &mut (dyn FnMut(String) + Send),
) -> Result<ConnectOutcome> {
    // distro 名存放在 params.host（向导的 distro 下拉写入 host 字段——该通道
    // 无主机地址概念，复用字段避免前端参数结构分叉）
    let session = Arc::new(WslSession::new(&params.host, &params.user));
    progress(format!(
        "[remote] 连接 WSL 发行版 {}（用户 {}）…",
        params.host, params.user
    ));

    // ── detect（含发行版平台校验：非 Linux 拒绝） ──────────────────
    let mut env = session.detect().await?;
    progress(format!(
        "[remote] WSL 环境 {} {}，java={}（主版本 {}）",
        env.platform,
        env.arch,
        env.java.as_deref().unwrap_or("<无>"),
        env.java_major.map(|m| m.to_string()).unwrap_or_else(|| "?".into())
    ));
    // 解析链内部自带「系统 java 可用即跳过」判据（含版本门禁），无需外层 if
    ensure_remote_runtime(&*session, &mut env, params.runtime_pkg_path.as_deref(), progress).await?;

    // ── 部署（指纹比对跳过；上传 UNC 直拷 + cat 回退） ─────────────
    deploy_and_switch(&*session, &env, progress).await?;

    // ── 启动远端后端 ───────────────────────────────────────────────
    let (auth_user, auth_pass) = random_credentials();
    let remote_port = allocate_remote_port(&*session).await?;
    let start_cmd = deploy::backend_start_command(
        &env,
        &deploy::remote_install_root(&env),
        remote_port,
        &auth_user,
        &auth_pass,
    )?;
    progress(format!("[remote] 启动 WSL 后端（端口 {}）…", remote_port));
    let start_res = session.exec(&start_cmd).await?;
    let pid = parse_pid(&start_res, "start backend (wsl)")?;
    progress(format!("[remote] WSL 后端 PID={}", pid));

    // ── WSL2 idle-stop 保活（根因修复，2026-10-11）─────────────────
    // WSL2 在最后一个 wsl.exe 客户端退出后 ~15s（instanceIdleTimeout 默认
    // 15000ms）整体关闭发行版，判据是 Windows 侧客户端而非 Linux 内部进程。
    // 就绪探活是 Windows 侧 HTTP，若不保活，后端启动命令退出后发行版会被关掉，
    // java 陪葬 → 180s connection refused（真机现场：无监听、无进程、零日志）。
    // 此处先起临时保活，保证探活窗口内发行版活着；连接注册后由常驻保活接力
    // （代际守卫，随连接销毁自退）。为防 connect 后续步骤异常遇漏交接，300s
    // 兜底自退（常驻保活启动即接管语义，与探活代际同构）。
    progress("[remote] 启动 WSL 发行版保活…".to_string());
    {
        let ka = session.clone();
        tauri::async_runtime::spawn(async move {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
            while std::time::Instant::now() < deadline {
                ka.keepalive_ping().await;
                tokio::time::sleep(std::time::Duration::from_secs(8)).await;
            }
        });
    }

    if let Err(e) = wait_backend_ready(remote_port, &auth_user, &auth_pass, progress).await {
        kill_started_backend_best_effort(&*session, pid, progress).await;
        return Err(attach_remote_diagnostics(&*session, e).await);
    }

    // ── 数据面：localhostForwarding 直连（无隧道） ─────────────────
    // WSL2 内听 127.0.0.1:port 的服务，Windows 侧同地址同端口可达。
    // WSL1 无此特性（distro 列表已带 version 字段，前端仅对 version=2 开放）。
    progress(format!(
        "[remote] 数据面直连 127.0.0.1:{}（WSL2 localhostForwarding）",
        remote_port
    ));

    let conn = Arc::new(RemoteConnection {
        host_key: host_key.clone(),
        control: ControlPlane::Wsl(session.clone()),
        env,
        remote_pid: pid,
        remote_port,
        data: Some(DataPlane::Direct { port: remote_port }),
        auth_user,
        auth_pass,
        refs: std::sync::atomic::AtomicUsize::new(1),
        state: std::sync::atomic::AtomicU8::new(0),
        health_generation: std::sync::atomic::AtomicU64::new(0),
    });

    Ok(register_connection(app, host_key, conn).await)
}

/// CLI 预装通道（P3）：复用 SSH 传输，探测 gwork 命中则跳过部署。
async fn connect_preinstalled(
    app: tauri::AppHandle,
    params: ConnectParams,
    target: SshTarget,
    host_key: String,
    progress: &mut (dyn FnMut(String) + Send),
) -> Result<ConnectOutcome> {
    progress(format!(
        "[remote] 连接 {}:{}（CLI 预装模式）…",
        target.host, target.port
    ));

    let auth = params.auth()?;
    let session = SshSession::connect(target.clone(), &auth).await?;
    progress(format!(
        "[remote] SSH 已连接（用户 {}），探测环境与 gwork CLI…",
        target.user
    ));

    let env = deploy::detect(&session).await?;
    if !deploy::java_usable(&env) {
        return Err(anyhow!(
            "远端 Java 不可用或主版本低于 {}（CLI 预装模式要求远端 gwork 可运行）：java={:?} 主版本={:?}",
            deploy::MIN_JAVA_MAJOR,
            env.java,
            env.java_major
        ));
    }

    // 探测预装 gwork：命中跳过部署（快路径）；未命中回退标准部署链
    let pre = deploy::detect_preinstalled(&session).await?;
    let (auth_user, auth_pass) = random_credentials();
    let remote_port = allocate_remote_port(&session).await?;

    let (pid, fingerprint) = if let Some((gwork_path, version)) = pre {
        progress(format!(
            "[remote] 检测到预装 gwork（{}，版本 {}），跳过部署",
            gwork_path, version
        ));
        // P4：版本不匹配提示（不阻断——预装模式与桌面端版本解耦，用户自行决定是否升级）。
        // 桌面端 jar 无内嵌版本号可比对 gwork 语义版本，此处只提示预装版本供用户对照。
        progress("[remote] 提示：预装版与桌面端可能存在版本差异；如遇行为异常可在服务器上重新安装 gwork".to_string());
        let start_cmd =
            deploy::preinstalled_start_command(&env, remote_port, &auth_user, &auth_pass);
        progress(format!(
            "[remote] 经预装 gwork 启动后端（端口 {}）…",
            remote_port
        ));
        let start_res = session.exec(&start_cmd).await?;
        let pid = parse_pid(&start_res, "start backend (preinstalled)")?;
        (pid, format!("preinstalled:{}", version))
    } else {
        progress("[remote] 未检测到预装 gwork，回退标准部署链…".to_string());
        deploy_and_switch(&session, &env, progress).await?;
        let start_cmd = deploy::backend_start_command(
            &env,
            &deploy::remote_install_root(&env),
            remote_port,
            &auth_user,
            &auth_pass,
        )?;
        progress(format!("[remote] 启动远端后端（端口 {}）…", remote_port));
        let start_res = session.exec(&start_cmd).await?;
        let pid = parse_pid(&start_res, "start backend")?;
        (pid, env.current_fingerprint.clone().unwrap_or_default())
    };
    progress(format!("[remote] 远端后端 PID={}", pid));

    let tunnel = match Tunnel::start(session.handle(), remote_port, "127.0.0.1".to_string()).await
    {
        Ok(t) => t,
        Err(e) => {
            kill_started_backend_best_effort(&session, pid, progress).await;
            return Err(e);
        }
    };
    progress(format!(
        "[remote] 隧道就绪 127.0.0.1:{} → {}:{}",
        tunnel.local_port, target.host, remote_port
    ));

    if let Err(e) = wait_backend_ready(tunnel.local_port, &auth_user, &auth_pass, progress).await {
        kill_started_backend_best_effort(&session, pid, progress).await;
        return Err(attach_remote_diagnostics(&session, e).await);
    }

    let conn = Arc::new(RemoteConnection {
        host_key: host_key.clone(),
        control: ControlPlane::Ssh(Arc::new(session)),
        env: deploy::RemoteEnv {
            current_fingerprint: Some(fingerprint),
            ..env
        },
        remote_pid: pid,
        remote_port,
        data: Some(DataPlane::Tunnel(Arc::new(tunnel))),
        auth_user,
        auth_pass,
        refs: std::sync::atomic::AtomicUsize::new(1),
        state: std::sync::atomic::AtomicU8::new(0),
        health_generation: std::sync::atomic::AtomicU64::new(0),
    });

    Ok(register_connection(app, host_key, conn).await)
}

/// 部署链公共段：指纹比对 → 上传/解包/切换（上传由通道实现决定：SSH cat 流式 /
/// WSL UNC 直拷 + cat 回退）。
async fn deploy_and_switch(
    exec_ch: &dyn deploy::ExecChannel,
    env: &deploy::RemoteEnv,
    progress: &mut (dyn FnMut(String) + Send),
) -> Result<String> {
    let jar_path = crate::paths::resources_dir().join("gourd-ai-agent.jar");
    let jar_bytes = tokio::fs::read(&jar_path)
        .await
        .with_context(|| format!("读取本地 jar 失败: {}", jar_path.display()))?;
    let fingerprint = deploy::fingerprint_of(&jar_bytes);

    let root = deploy::remote_install_root(env);
    if env.current_fingerprint.as_deref() == Some(fingerprint.as_str()) {
        progress(format!("[remote] 版本 {} 已部署（跳过上传）", fingerprint));
        return Ok(root);
    }
    if env.current_fingerprint.is_some() {
        progress(format!(
            "[remote] 远端版本 {} ≠ 本地 {}，部署新版（旧进程若有任务不受影响）",
            env.current_fingerprint.as_deref().unwrap_or("-"),
            fingerprint
        ));
    } else {
        progress(format!("[remote] 首次部署 {}（上传 jar …）", fingerprint));
    }

    let tar_bytes = build_deploy_tar(&jar_bytes)?;
    let uploader = exec_ch.uploader();
    deploy::deploy(
        exec_ch,
        env,
        &fingerprint,
        tar_bytes,
        uploader.as_ref(),
        &mut upload_progress_printer(progress),
    )
    .await?;
    progress("[remote] 部署完成，current 已切换".to_string());
    Ok(root)
}

/// 启动命令 PID 解析（取输出最后一个非空行——JAVA_TOOL_OPTIONS 会打 Picked up
/// 前缀行，末行才是 PID；WSL 通道同理）。
fn parse_pid(res: &ssh::ExecResult, hint: &str) -> Result<u32> {
    let checked = res.clone().ok_or_error(hint)?;
    let line = checked
        .stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .last()
        .unwrap_or("");
    // 字符级取尾（字节切片会在多字节字符中间劈出 U+FFFD）+ 控制字符 sanitization
    let tail = ssh::sanitize_output_tail(&tail_chars(&checked.stdout, 200));
    line.trim()
        .parse()
        .with_context(|| format!("远端启动命令未返回 PID（输出尾部: {}）", tail))
}

/// 就绪探活循环：经**数据面本地端口**发 HTTP 请求（最多 180s，JVM 冷启动要时间）。
///
/// 【2026-10-10 154 事故根因修复】旧实现经 SSH exec 在远端跑
/// `timeout N bash -c '</dev/tcp/...>'` 探端口。真机取证证明该原语在
/// 部分远端（154：CentOS7/bash4.2）**间歇性不可靠**：同一命令同通道
/// 整窗全败（含语法错形态）而端口确在听、OpenSSH 通道同命令却恒 OK；
/// 三重试/换 timeout 值均不能消除。继续修 shell 探针是在不可复现的
/// 内核/库行为上赌运气。改为**直接测将来真正要用的数据链路**：
/// 隧道（或 WSL 直连）本地口 → HTTP GET 带 Basic Auth → 任何 HTTP 响应
/// （含 401/302）即就绪；连接被拒/超时才继续等。一举三得：①不依赖
/// 远端 shell/timeout//dev/tcp；②顺带验证隧道与认证链（旧探活过了
/// 隧道仍可能坏）；③与 mirror/健康探活同口径。
///
/// 【2026-10-09 真机 e2e 实测】窗口 60s 在慢机不够（53MB fat jar 冷启动
/// 100s+），放宽到 180s；等待期间每 10s 打一行进度（旧实现零进度行，
/// 用户视角=卡死）。
async fn wait_backend_ready(
    local_port: u16,
    auth_user: &str,
    auth_pass: &str,
    progress: &mut (dyn FnMut(String) + Send),
) -> Result<()> {
    wait_backend_ready_with_cap(local_port, auth_user, auth_pass, progress, 180).await
}

/// 就绪探活循环（窗口可注入：e2e 验收用更大窗口，生产用 180s）。
async fn wait_backend_ready_with_cap(
    local_port: u16,
    auth_user: &str,
    auth_pass: &str,
    progress: &mut (dyn FnMut(String) + Send),
    wait_cap_secs: u64,
) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .context("构建探活 HTTP client 失败")?;
    let url = format!("http://127.0.0.1:{}/web/gate", local_port);
    let auth = basic_auth_value(auth_user, auth_pass);
    let start = std::time::Instant::now();
    let mut last_log_secs = 0u64;
    loop {
        let elapsed = start.elapsed().as_secs();
        if elapsed >= wait_cap_secs {
            return Err(anyhow!(
                "远端后端 {}s 未就绪（数据面端口 {}）。应用日志: ~/.gwork-remote/.gwork/logs/gwork.log（stdout: server.log）",
                wait_cap_secs,
                local_port
            ));
        }
        match client.get(&url).header("Authorization", auth.clone()).send().await {
            Ok(resp) => {
                progress(format!(
                    "[remote] 远端后端已就绪（{}s，HTTP {}）",
                    elapsed,
                    resp.status().as_u16()
                ));
                return Ok(());
            }
            Err(e) => {
                if elapsed >= last_log_secs + 10 {
                    last_log_secs = elapsed;
                    progress(format!(
                        "[remote] 等待远端后端 HTTP 响应…（{}s/{}s；{}；日志: ~/.gwork-remote/.gwork/logs/gwork.log）",
                        elapsed,
                        wait_cap_secs,
                        e
                    ));
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    }
}

/// 【2026-10-10 154 事故修复】启动后失败路径的孤儿回收。
///
/// 旧实现探活/隧道失败直接 `?` 返回：已 spawn 的远端 java（Xmx1024m 常驻）
/// 无人 kill，多次失败累积吃内存 → 新 JVM 更难起来 → 「越失败越连不上」
/// 自增强循环（154 真机抓到现场：失败连接的孤儿进程存活 50+ 分钟）。
/// best-effort：kill 失败只降级为日志，不覆盖原始错误。
async fn kill_started_backend_best_effort(
    exec_ch: &dyn deploy::ExecChannel,
    pid: u32,
    progress: &mut (dyn FnMut(String) + Send),
) {
    progress(format!("[remote] 连接失败，回收已启动的远端后端 PID={} …", pid));
    match exec_ch.exec(&deploy::backend_stop_command(pid)).await {
        Ok(_) => progress(format!("[remote] 已回收远端后端 PID={}", pid)),
        Err(e) => progress(format!(
            "[remote] 回收远端后端 PID={} 失败（{}）；该进程可能残留，重连时会被引用计数/探活链清理",
            pid, e
        )),
    }
}

/// 【2026-10-10 154 事故修复】探活超时错误自带远端现场诊断。
///
/// 旧错误只说「看 server.log」——但应用日志实际在 gwork.log（server.log 仅
/// stdout，启动期零输出），用户无从下手。现在自动抓：听口状态、进程、内存、
/// gwork.log 尾、OOM 记录，拼进错误消息（向导日志区直接可见）。
/// 诊断抓取本身失败不废原始错误（只附注抓取失败）。
async fn attach_remote_diagnostics(
    exec_ch: &dyn deploy::ExecChannel,
    err: anyhow::Error,
) -> anyhow::Error {
    let script = "echo '--- listen ---'; ss -lntp 2>/dev/null | head -8; \
         echo '--- gwork procs ---'; ps -ef 2>/dev/null | grep -E 'gourd-ai-agent|gwork web' | grep -v grep | head -5; \
         echo '--- mem ---'; free -m 2>/dev/null | head -3; \
         echo '--- server.log tail ---'; tail -n 30 ~/.gwork-remote/server.log 2>/dev/null | tail -n 20; \
         echo '--- gwork.log tail ---'; tail -n 30 ~/.gwork-remote/.gwork/logs/gwork.log 2>/dev/null | tail -n 20; \
         echo '--- oom ---'; dmesg 2>/dev/null | grep -iE 'oom|killed process' | tail -5";
    let diag = match exec_ch.exec(script).await {
        Ok(r) => ssh::sanitize_output_tail(&tail_chars(&r.stdout, 3000)),
        Err(e) => format!("（诊断抓取失败: {}）", e),
    };
    anyhow!("{}\n── 远端现场诊断 ──\n{}", err, diag)
}

/// 注册连接 + 起探活 + 组装返回值（三通道公共尾段）。
///
/// 【2026-10-10 闪退根因】本函数在 async 上下文（三通道 connect_* 尾段）调用，
/// 旧实现在此对 CONNECTIONS 采取 tokio Mutex 的 blocking_lock 形式 —— 其内部
/// 是 block_on，**在 async 执行上下文调用直接 panic**（tokio 文档 Panics 节
/// 白纸黑字；本地 vendored 源码 tokio-1.53.1/src/sync/mutex.rs:535）。而
/// release profile `panic="abort"` 会让任何线程的 panic 直接杀死整个进程
/// → 「SSH 连接成功瞬间桌面闪退」。之前从未暴露是因为旧探活壳层失败挡在
/// 前面，连接从未走到注册这一步；2026-10-10 探活修复后流程首次走通即踩雷。
/// 修复：函数改 async，用 `lock().await`（不再阻塞 runtime 线程）。
/// 原注释担心的「登记时不可能有其它持锁者」是死锁视角，非 panic 视角，
/// 一并作废。
///
/// 远端镜像（P4 方案 A）：连接发布后立即推送本机模型配置到远端内存。
/// 放在登记之后：远端后端已就绪（wait_backend_ready 已过），失败只降级
/// （远端退回自身配置）不废连接——用户在向导日志能看到措辞。
async fn register_connection(
    app: tauri::AppHandle,
    host_key: String,
    conn: Arc<RemoteConnection>,
) -> ConnectOutcome {
    let connection_id = connection_id_of(&host_key);
    let outcome = existing_outcome(&conn);
    let probe_id = connection_id.clone();
    // 探活代际：重建（重连/复用失败后新建）时 +1 并快照给新探活循环；
    // 旧循环下一轮查表发现代际不符即自退，不会拿已死的旧控制面探活
    // 误判新连接（codereview 2026-10-09 P1）。
    let probe_gen = conn
        .health_generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    // 镜像终态帧要带 connectionId，而 connection_id 本体在下面会被移进注册表
    let mirror_conn_id = connection_id.clone();
    {
        let mut conns = CONNECTIONS.lock().await;
        // P0-4 修复：断线重连/异常残留的旧连接（探活失败后仅置 Disconnected 未从注册表
        // 摘除）会导致孤儿远端进程——同 host_key 重建时旧 PID 无人 kill，远端后端进程
        // 永久泄漏直到服务器重启。此处重建前先停掉旧连接的远端进程再覆盖。
        if let Some(old) = conns.get(&connection_id) {
            let old_pid = old.remote_pid;
            if old_pid > 0 {
                let stop = deploy::backend_stop_command(old_pid);
                let old_control = old.control.clone();
                tracing::info!(
                    "[remote] 重建连接 {}：先停止旧远端进程 PID={}",
                    connection_id,
                    old_pid
                );
                // kill 命令自带 2s sleep，放 spawn 异步等结果即可，不阻塞连接发布
                tauri::async_runtime::spawn(async move {
                    let _ = old_control.exec(&stop).await;
                });
            }
            if let Some(d) = old.data.as_ref() {
                d.stop();
            }
        }
        // connection_id 此处 clone 后入表：本体要留给下面的路由登记（直接 move
        // 进去会触发 E0382，而镜像帧用的 mirror_conn_id 是另一份 clone）
        conns.insert(connection_id.clone(), conn.clone());
    }
    // P0-1/P0-2 修复 + 按工作区分流（用户 2026-10-06 拍板）：本地 UI 服务器反代登记
    // 本连接为可用上游并置为激活 scope（HTTP + WS 同源转发，Authorization 由代理注入——
    // 前端跨源改写必死 CORS 预检，浏览器 WS 无法带自定义头，详见 server.rs REMOTE_ROUTE
    // 注释）。后续前端选中工作区时经 remote_bind_scope 把具体目录绑到本 connectionId，
    // 于是本地工作区与远程工作区可并存（不再「一连远端就整机切过去」）。
    crate::server::register_remote_connection(
        &connection_id,
        conn.local_port(),
        conn.basic_auth_header(),
    );
    // 断线重连记忆（P4）：参数快照由 connect 入口统一写入（按 connectionId 分账，
    // 见 remember_params），此处不重复写。同 host 复用路径也会刷新本 id 的参数：
    // 那是用户在向导里刚改过的目标（换端口/换跳板机/换认证方式），重连理应
    // 复刻最近一次意图而不是首次意图——键相同，覆盖只会把同一连接的参数推到最新，
    // 不可能波及其它连接（旧版单值正是做不到这一点）。
    // 模型镜像推送（async；用 spawn 让 register 保持同步签名——三通道调用点零改动）
    {
        let mirror_conn = conn.clone();
        // 镜像进度必须推到前端（P1-B 修复）。原先 sink 只写 tracing::info：
        // 「远端退回自身配置」这条降级在 UI 上完全不可见，用户只会觉得
        // 「远端模型跟我本机配的不一样」却无从排查——典型哑故障。事件名独立于
        // remote-connect-progress：后者只在向导开着时被 logLine 消费（DOM 不在即
        // 丢弃），而镜像推送发生在向导已关闭之后，两条通道语义也不同。
        let mirror_app = app.clone();
        let mirror_id = mirror_conn_id.clone();
        tauri::async_runtime::spawn(async move {
            let mut sink = |line: String| {
                tracing::info!("{}", line);
                crate::ipc_bridge::emit(
                    &mirror_app,
                    "remote-mirror-state",
                    &serde_json::json!({
                        "connectionId": mirror_id,
                        "line": line,
                    }),
                );
            };
            let synced = mirror::push_with_progress(
                mirror_conn.local_port(),
                &mirror_conn.auth_user,
                &mirror_conn.auth_pass,
                &mut sink,
            )
            .await;
            // 终态单独一帧：前端据此决定是否 toast（成功静默、失败必须打扰）
            crate::ipc_bridge::emit(
                &mirror_app,
                "remote-mirror-state",
                &serde_json::json!({
                    "connectionId": mirror_id,
                    "done": true,
                    "synced": synced,
                }),
            );
        });
    }
    // 断连探测：探活循环，SSH 死/远端进程死 → 置 Disconnected 并推事件
    spawn_health_probe(app, probe_id.clone(), probe_gen);
    // WSL 通道：连接存续期间常驻保活（idle-stop 根因修复，见 connect_wsl 注释）。
    // 代际守卫与探活同构：重连重建后旧循环自退；连接销毁/摘表后返回。
    // 间隔 8s < instanceIdleTimeout 15s，每次 ping 都是一个活跃 wsl.exe 客户端。
    #[cfg(target_os = "windows")]
    if let ControlPlane::Wsl(s) = &conn.control {
        let ka_session = s.clone();
        let ka_id = probe_id.clone();
        let ka_gen = probe_gen;
        tauri::async_runtime::spawn(async move {
            loop {
                ka_session.keepalive_ping().await;
                tokio::time::sleep(std::time::Duration::from_secs(8)).await;
                let conns = CONNECTIONS.lock().await;
                let Some(c) = conns.get(&ka_id) else { return }; // 连接已销毁
                if c.health_generation.load(std::sync::atomic::Ordering::SeqCst) != ka_gen {
                    return; // 被新代连接取代，新循环已接管
                }
            }
        });
    }
    outcome
}

/// 复用已有连接时组装返回值（不重启后端）。
fn existing_outcome(conn: &RemoteConnection) -> ConnectOutcome {
    ConnectOutcome {
        connection_id: connection_id_of(&conn.host_key),
        local_port: conn.local_port(),
        remote_port: conn.remote_port,
        host: conn.control.display_host(),
        user: conn.control.display_user(),
        platform: conn.env.platform.clone(),
        arch: conn.env.arch.clone(),
        java: conn.env.java.clone(),
        deployed_fingerprint: conn
            .env
            .current_fingerprint
            .clone()
            .unwrap_or_default(),
        auth_header: conn.basic_auth_header(),
        remote: true,
    }
}

/// 销毁一条连接的远端资源：停远端后端 → 关数据面 → 断控制面。
///
/// 幂等且对失败宽容：PID 为 0（未启动/未知）直接跳过 kill；kill/关面报错只记日志
/// ——调用方要么用户主动断开（无从补救），要么应用退出（更不能因为远端不可达而卡住）。
/// 绝不 pkill java：那会杀掉远端别人的进程。WSL 通道同走远端 kill（PID 是发行版内的
/// Linux 进程号）。
async fn destroy_connection(conn: &RemoteConnection) {
    if conn.remote_pid > 0 {
        let stop = deploy::backend_stop_command(conn.remote_pid);
        let _ = conn.control.exec(&stop).await;
    }
    if let Some(d) = conn.data.as_ref() {
        d.stop();
    }
    conn.control.shutdown().await;
}

/// 断开连接（引用计数 -1；归零销毁远端进程与数据面/控制面）。
///
/// `release_all = true`：一次性释放本连接**全部**引用并销毁——前端「断开」按钮
/// 的语义就是「断开这台主机」（而不是「退订其中一个工作区」）。
///
/// 【P1 修复：为何必须支持一次清零】旧版无论用户点几次「断开」都只减 1，而
/// 同一台机多开工作区后 refs 会 >1：于是断开一次什么也不发生（远端后端继续跑，
/// 白占服务器内存），徽标却因前端先置 null 而消失——用户无从得知也没入口重试，
/// 只能重启应用才能收尾远端进程。引用计数不能由 UI 传错值兼平（前端不跟踪 refs，
/// 传值与实际不一致会提前杀掉其它工作区还在用的后端），故用显式布尔量。
///
/// 只保留这一个入口（曾有 `disconnect` 与 `disconnect_with` 两个名字，前者
/// 零调用）：断开语义写两处就会出现「UI 路径干净、工作区退订路径残留」这类
/// 只在收尾才暴露的差异。
pub async fn disconnect(connection_id: &str, release_all: bool) -> Result<()> {
    let mut conns = CONNECTIONS.lock().await;
    let conn = conns
        .get(connection_id)
        .ok_or_else(|| anyhow!("连接不存在: {}", connection_id))?
        .clone();
    // 一次性清零用 fetch_update（而非先读后写：中间窗口里可能有人 +1）
    let remaining = if release_all {
        let _ = conn.refs.fetch_update(
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
            |_| Some(0),
        );
        0usize
    } else {
        let prev = conn.refs.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        prev.saturating_sub(1)
    };
    if remaining == 0 {
        // 归零：销毁
        conns.remove(connection_id);
        drop(conns); // 早释放锁，销毁流程慢操作不阻塞查询

        tracing::info!("[remote] 引用归零，销毁连接 {}", connection_id);
        // 0. 从路由表摘除本连接（含其工作区绑定；无归属请求回落本地后端）。
        //    不能只 clear 激活值：多连接并存时其它连接的 by_id/by_cwd 必须存活。
        crate::server::unregister_remote_connection(connection_id);
        // 销毁体与退出清理共用 destroy_connection（两条路径的 kill 语义必须一致，
        // 分写两遍就会出现「正常断开干净、退出残留」这类只在收尾暴露的差异）
        destroy_connection(&conn).await;
    } else {
        tracing::info!(
            "[remote] 断开一个引用，剩余 {} 个（远端后端保持运行）",
            remaining
        );
    }
    Ok(())
}

/// 应用退出清理：销毁**全部**远程连接（kill 远端后端 + 关数据面 + 断控制面）。
///
/// 为什么必须由 main.rs 的 `RunEvent::Exit` 调用：前端 disconnect 只在用户点
/// 「断开」时发生，而关窗口进托盘、退出应用都不会触发它 —— 远端那个 java 进程会
/// 一直常驻直到服务器重启（方案 §四「随连接销毁」语义的真正落地点）。
///
/// 每条连接独立限时（`SHUTDOWN_PER_CONN_TIMEOUT_SECS`）：SSH 半开时 `exec(kill)`
/// 会一路阻塞到 TCP 超时（数十秒），把「退出应用」卡成「未响应」。超时就放弃这一条
/// 继续下一条——宁可漏杀一个远端孤儿进程（下次同 host_key 重建时
/// register_connection 的旧 PID 回收链仍会补杀），也不能让用户关不掉应用。
pub async fn shutdown_all() {
    let conns: Vec<(String, Arc<RemoteConnection>)> = {
        let mut guard = CONNECTIONS.lock().await;
        guard.drain().collect()
    };
    if conns.is_empty() {
        return;
    }
    // 路由表整体重置（反代立即回落本地）：否则退出过程中前端残留请求会打到
    // 即将关闭的隧道，且 by_id/by_cwd 会跨进程生命周期遗留（本进程马上就退了）。
    crate::server::reset_remote_route();
    for (id, conn) in conns {
        let fut = destroy_connection(&conn);
        match tokio::time::timeout(
            std::time::Duration::from_secs(SHUTDOWN_PER_CONN_TIMEOUT_SECS),
            fut,
        )
        .await
        {
            Ok(()) => tracing::info!("[remote] 退出清理连接 {} 完成", id),
            Err(_) => tracing::warn!(
                "[remote] 退出清理连接 {} 超时（{}s）跳过：远端 PID={} 可能残留",
                id,
                SHUTDOWN_PER_CONN_TIMEOUT_SECS,
                conn.remote_pid
            ),
        }
    }
}

/// 查询连接状态（前端徽标）。
///
/// host/user 必须回传（P2-C 修复）：页面重载后的启动恢复链只能靠本命令拿回连接
/// 身份，原先前端用「已保存主机列表的第一项」猜显示名——连过 B 台机器再重载页面，
/// 徽标会把当前连接显示成另一台主机（用户据此判断「我的活跑在哪台机器」，显示错
/// 就是误导）。control 面本来就持有真实展示名，加两个字段即可。
pub async fn state_of(connection_id: &str) -> Result<serde_json::Value> {
    let conns = CONNECTIONS.lock().await;
    Ok(state_value_with(conns.get(connection_id), connection_id, true))
}

/// 枚举全部注册中的连接（方案B）：元素形状与 `state_of` 一致，**但剔除 authHeader**。
///
/// 枚举面必须脱敏（契约 §1.1）：authHeader 是远端后端的 Basic Auth 凭据，只有
/// 单连接查询面（`state_of`）才需要它。列表面给前端的是「有哪些连接在线」，一旦带上
/// 凭据就等于把它散给所有读列表的调用点（徽标/分组树/扇出拉取都会缓存进内存、
/// 甚至进日志）；而代理层已经自行注入 Authorization（见 server.rs REMOTE_ROUTE 注释），
/// 前端根本不需要它。
///
/// 排序键 = connectionId：HashMap 迭代序不稳定，而前端把本列表当分组树/扇出拉取的
/// 顺序基准（契约 §2.2 list()、§5.1 组序）——同一批连接两次调用顺序不同会让树反复跳动。
pub async fn list_all() -> Vec<serde_json::Value> {
    let conns = CONNECTIONS.lock().await;
    let mut ids: Vec<&str> = conns.keys().map(String::as_str).collect();
    ids.sort();
    ids.iter()
        .map(|id| state_value_with(conns.get(*id), id, false))
        .collect()
}

/// 连接状态体的唯一拼装点（`state_of` 与 `list_all` 共用）。
///
/// `with_auth=false` 时省略 authHeader 字段（枚举面脱敏，见 list_all 注释）——用
/// 「不写该键」而非「写空串」：空串对前端是个合法但无效的值，可能被直接写进请求头
/// 变成静默 401；缺键则让读方必然走「没有凭据」分支。
/// conn 为 None（已注销/从未连接）返回 disconnected 占位体，与旧行为一致。
fn state_value_with(
    conn: Option<&Arc<RemoteConnection>>,
    connection_id: &str,
    with_auth: bool,
) -> serde_json::Value {
    let Some(conn) = conn else {
        return serde_json::json!({
            "connectionId": connection_id,
            "state": "disconnected",
            "refs": 0,
        });
    };
    let mut v = serde_json::json!({
        "connectionId": connection_id,
        "state": conn.conn_state(),
        "refs": conn.refs.load(std::sync::atomic::Ordering::SeqCst),
        "localPort": conn.local_port(),
        "remotePort": conn.remote_port,
        "host": conn.control.display_host(),
        "user": conn.control.display_user(),
        "channel": conn.data.as_ref().map(|d| d.kind()),
    });
    if with_auth {
        v["authHeader"] = serde_json::Value::String(conn.basic_auth_header());
    }
    v
}

/// 断线重连的参数取用（契约 §1.2）：
/// - `Some(id)` → 该连接的参数；缺失报 `unknown connection: <id>`（前端按 id 分账
///   重连，重错目标比报错更糟，故必须显式失败而不是静默回落「最后一台」）；
/// - `None` → 最近一次写入的键（= 旧版单值语义，不传 id 的老调用点行为不变）；
///   回落键指向的条目已不在表里（理论上不会发生：两表只在本模块写且同锁保护）
///   或从未连过 → 报「没有可重连的连接」。
///
/// 锁序固定：先 params 表、后回落键（与 remember_params 一致）——两把锁逆序取会死锁。
async fn reconnect_params(connection_id: Option<String>) -> Result<ConnectParams, String> {
    let params = LAST_PARAMS.lock().await;
    let key = match &connection_id {
        Some(id) => Some(id.clone()),
        None => LAST_PARAMS_KEY.lock().await.clone(),
    };
    match key {
        Some(id) => params
            .get(&id)
            .cloned()
            .ok_or_else(|| match &connection_id {
                // 显式指定了不存在的 id：报 id（前端据此判定该连接已死、从注册表摘除）
                Some(_) => format!("unknown connection: {}", id),
                None => "没有可重连的连接（本会话尚未连接过）".to_string(),
            }),
        None => Err("没有可重连的连接（本会话尚未连接过）".to_string()),
    }
}

/// 远端随机端口分配：让远端自己挑（避免「本地可用但远端被占」）。
/// 手法：远端 python/perl 不可依赖，用 bash /dev/tcp 试探区间内随机口。
/// 注意：$RANDOM 与 /dev/tcp 都是 bash 特性，必须显式 bash -c（SSH exec 的默认
/// shell 在 Debian 系是 dash，裸用会语法错误 exit 2 且无可用提示）；
/// 远端无 bash 时回退 python 端口探测，两者都无则报可读错误。
async fn allocate_remote_port(exec_ch: &dyn deploy::ExecChannel) -> Result<u16> {
    let script = r#"bash -c 'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do p=$((20000 + RANDOM % 20000)); if ! (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null; then exec 3>&-; echo $p; exit 0; fi; exec 3>&- 2>/dev/null; done; echo 0' || python3 -c 'import socket
s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()' || echo 0"#;
    let res = exec_ch.exec(script).await?;
    let res = res.ok_or_error("allocate remote port")?;
    // bash 缺失时其报错只进 stderr（丢弃）；取最后一个非空数字行（兼容 python 输出前的噪声）
    let port: u16 = res
        .stdout
        .trim()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .last()
        .unwrap_or("")
        .trim()
        .parse()
        .with_context(|| format!("远端端口分配返回异常: {}", res.stdout.trim()))?;
    if port == 0 {
        return Err(anyhow!(
            "远端 20000-40000 区间竟无可用端口（或远端无 bash/python3 可用于探测）"
        ));
    }
    Ok(port)
}

/// 打包部署 tar.gz：单 jar。**运行时资产不走本函数**——离线/内网改造起运行时
/// 独立成树（`runtime/<fp>/` + current，指纹分离），经 deploy::deploy_runtime 上传
/// 用户/内置 tar.gz 原包（不重打包）。
/// 不落盘临时文件——内存打包（jar 100MB 级别可接受，部署是低频重操作）。
fn build_deploy_tar(jar_bytes: &[u8]) -> Result<Vec<u8>> {
    // 手写 gzip + 最小 ustar tar（仅一个常规文件条目）。不引入 tar crate：
    // 部署物结构固定（gourd-ai-agent.jar 单文件），tar 头手工构造 512 字节对齐。
    let mut tar = Vec::with_capacity(512 + ((jar_bytes.len() + 511) / 512) * 512 + 1024);

    // ustar header（POSIX tar，GNU tar / busybox tar 均可解）
    let name = b"gourd-ai-agent.jar";
    let mut header = [0u8; 512];
    header[0..name.len()].copy_from_slice(name);
    // mode 0644（八进制字符串，字段 8 字节 = 7 位 + NUL）
    header[100..108].copy_from_slice(b"0000644\0");
    // uid/gid 0，size 八进制（字段 12 字节 = 11 位 + NUL）
    let size_field = format!("{:011o}\0", jar_bytes.len());
    debug_assert_eq!(size_field.len(), 12);
    header[124..136].copy_from_slice(size_field.as_bytes());
    // mtime 0（内容寻址部署物，时间戳无意义且保证同指纹 tar 字节级一致；
    // 字段 12 字节 = 11 位 + NUL）
    header[136..148].copy_from_slice(b"00000000000\0");
    header[148..156].copy_from_slice(b"        "); // checksum 占位（空格）
    header[156] = b'0'; // typeflag: 常规文件
    header[257..263].copy_from_slice(b"ustar ");
    header[263..265].copy_from_slice(b" \0");
    // checksum：头 512 字节按无符号字节和（checksum 字段本身按空格算）。
    // POSIX 规定 checksum 字段为「6 位八进制 + NUL + 空格」共 8 字节；
    // GNU tar 的实际实现是「6 位 + NUL + 空格」或「7 位 + 空格」两种都接受，
    // 我们按标准 6 位 + NUL + 空格写（sum > 0o777777 时理论溢出，1MB 级文件头
    // 校验和不可能超过 —— 字段上限 0o777777 = 262143 远大于 512 字节可能的最大和）
    let sum: u32 = header.iter().map(|&b| b as u32).sum();
    let chk_field = format!("{:06o}\0 ", sum);
    debug_assert_eq!(chk_field.len(), 8, "checksum 字段必须为 8 字节（6+1+1）");
    header[148..156].copy_from_slice(chk_field.as_bytes());

    tar.extend_from_slice(&header);
    tar.extend_from_slice(jar_bytes);
    // 补齐 512 对齐
    let pad = (512 - jar_bytes.len() % 512) % 512;
    tar.extend(std::iter::repeat(0u8).take(pad));
    // 结束：两条全零块
    tar.extend(std::iter::repeat(0u8).take(1024));

    // gzip（-9 与 tar -czf 的对齐无关紧要，解压端只认格式）
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    enc.write_all(&tar).context("gzip 压缩失败")?;
    enc.finish().context("gzip 收尾失败").map_err(Into::into)
}

/// 健康探测循环：SSH 挂了/远端进程死了 → 置 Disconnected + 推事件。
/// 10s 一次 /dev/tcp 探测（够快感知半开，又不过度消耗 channel）。
fn spawn_health_probe(app: tauri::AppHandle, connection_id: String, generation: u64) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            let conn = {
                let conns = CONNECTIONS.lock().await;
                conns.get(&connection_id).cloned()
            };
            let Some(conn) = conn else { return }; // 已销毁（正常退出路径）
            // 代际守卫：同 connectionId 的连接被重建（重连）后，旧循环自退——
            // 否则旧循环拿已死的旧控制面探活必失败，会把刚建好的新连接
            // 误置 Disconnected 并摘除其路由（新循环已接管，codereview P1）。
            if conn
                .health_generation
                .load(std::sync::atomic::Ordering::SeqCst)
                != generation
            {
                tracing::debug!(
                    "[remote] 探活 {} 代际 {} 已被新连接取代，自退",
                    connection_id,
                    generation
                );
                return;
            }

            // 【2026-10-10 154 事故修复】健康探活与就绪探活同口径改走数据面
            // HTTP（旧 /dev/tcp shell 探针间歇性不可靠 → 误断连）。
            // 任何 HTTP 响应（含 401）= 后端活着且数据面通。
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(3))
                .build();
            let probe_fut = async {
                match client {
                    Ok(c) => c
                        .get(format!("http://127.0.0.1:{}/web/gate", conn.local_port()))
                        .header(
                            "Authorization",
                            basic_auth_value(&conn.auth_user, &conn.auth_pass),
                        )
                        .send()
                        .await
                        .map(|_| ()),
                    Err(e) => Err(e.into()),
                }
            };
            let alive = tokio::time::timeout(std::time::Duration::from_secs(8), probe_fut).await;
            let ok = matches!(alive, Ok(Ok(())));
            if !ok {
                tracing::warn!("[remote] 连接 {} 探活失败 → Disconnected", connection_id);
                conn.state.store(1, std::sync::atomic::Ordering::SeqCst);
                // 探活失败必须整条摘除路由（含该连接的工作区绑定）。
                // 只清激活值会得到最坏的半死形态：列表类请求回本地了，而绑在
                // by_cwd 上的远端工作区仍把请求灌进已死的隧道 → 全 502 且无提示。
                // 重连成功后 register_remote_connection 会重新登记（绑定需用户
                // 重选一次，applyConnection 本就会清选择并重拉列表，语义一致）。
                crate::server::unregister_remote_connection(&connection_id);
                crate::ipc_bridge::emit(
                    &app,
                    "remote-connection-state",
                    &serde_json::json!({
                        "connectionId": connection_id,
                        "state": "disconnected",
                    }),
                );
                return;
            }
        }
    });
}

// ─── Tauri Commands（前端经 __GOURD_IPC__ 调用） ───────────────────────

/// 连接远程主机。进度日志经事件 `remote-connect-progress` 推给前端（行级文本）。
///
/// 不直接把 progress 回调返回给前端（Tauri command 单次往返），连接过程可能
/// 数十秒（首次部署上传 100MB jar），必须边跑边推事件才符合「连接日志」需求。
#[tauri::command]
pub async fn remote_connect(
    app: tauri::AppHandle,
    channel: Option<String>,
    host: String,
    port: Option<u16>,
    user: String,
    auth_type: String,
    password: Option<String>,
    key_path: Option<String>,
    passphrase: Option<String>,
    remember_secret: Option<bool>,
    jump_host: Option<String>,
    jump_port: Option<u16>,
    jump_user: Option<String>,
    jump_password: Option<String>,
    jump_key_path: Option<String>,
    jump_passphrase: Option<String>,
    // 离线运行时包本地路径（可选，解析链 L3b；tauri command 参数不允许 doc 注释）
    runtime_pkg_path: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = ConnectParams {
        channel,
        host,
        port,
        user,
        auth_type,
        password,
        key_path,
        passphrase,
        jump_host,
        jump_port,
        jump_user,
        jump_password,
        jump_key_path,
        jump_passphrase,
        runtime_pkg_path,
    };
    // P4 记住密码：空凭据从 OS 凭据库回填（keyring；未记住则保持空走正常失败链）
    let secrets_key = params.secrets_key();
    params.autofill_secret();
    let params_cloned = params.clone();
    let mut progress_lines: Vec<String> = Vec::new();
    let handle = app.clone();
    // 进度帧带 connectionId（契约 §1.3）：并发连两台时前端靠它把日志分进各自向导。
    // 发射点早于连接建立（注册表里还没这条），故由参数推导，与 connect 同源。
    let progress_id = connection_id_of_params(&params);

    let res = {
        let mut push = |line: String| {
            progress_lines.push(line.clone());
            crate::ipc_bridge::emit(
                &handle,
                "remote-connect-progress",
                &serde_json::json!({ "line": line, "connectionId": progress_id }),
            );
        };
        connect(app, params_cloned, &mut push).await
    };

    // 连接成功且勾选记住 → 凭据入 OS 凭据库（keyring 同步 API，spawn_blocking）
    if res.is_ok() && remember_secret.unwrap_or(false) {
        let secret = match params.auth_type.as_str() {
            "password" => params.password.clone(),
            "key" => params.passphrase.clone(),
            _ => None,
        };
        if let Some(secret) = secret {
            let key = secrets_key.clone();
            let store_res =
                tauri::async_runtime::spawn_blocking(move || secrets::store(&key, &secret))
                    .await;
            match store_res {
                Ok(Ok(())) => tracing::info!("[remote] 凭据已存入 OS 凭据库（{}）", secrets_key),
                Ok(Err(e)) => tracing::warn!("[remote] 凭据入库失败（连接不受影响）: {}", e),
                Err(e) => tracing::warn!("[remote] 凭据入库任务异常（连接不受影响）: {}", e),
            }
        }
    }

    match res {
        Ok(outcome) => serde_json::to_value(outcome)
            .map_err(|e| format!("序列化连接结果失败: {}", e)),
        Err(e) => Err(format!("{:#}", e)),
    }
}

/// 断开（引用计数语义，见 disconnect）。`release_all=true` = 整条连接销毁（UI
/// 「断开」按钮口径），false = 只退一个引用（工作区级退订，供将来多开用）。
#[tauri::command]
pub async fn remote_disconnect(
    connection_id: String,
    release_all: Option<bool>,
) -> Result<(), String> {
    disconnect(&connection_id, release_all.unwrap_or(true))
        .await
        .map_err(|e| format!("{:#}", e))
}

/// 断线重连（P4）：从 LAST_PARAMS 按 connectionId 取参数复刻该连接（含 keyring 凭据回填）。
/// 前端在 remote-connection-state 事件（disconnected）后调用；指数退避由前端控制
/// （Rust 不自动循环重试——避免无人值守时无限重试刷爆服务器）。返回新 ConnectOutcome。
///
/// `connection_id`（方案B）：Some(id) = 重连指定连接（缺失报 unknown connection）；
/// None = 重连最近一次（旧壳不传参时的行为不变，见 reconnect_params）。
#[tauri::command]
pub async fn remote_reconnect(
    app: tauri::AppHandle,
    connection_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut params = reconnect_params(connection_id).await?;
    // 凭据可能已从内存清掉（连接销毁时）；重新从 keyring 回填
    params.autofill_secret();
    let handle = app.clone();
    // 进度帧带 connectionId（契约 §1.3）：并发连两台时前端靠它把日志分进正确的向导
    let progress_id = connection_id_of_params(&params);
    let res = {
        let mut push = |line: String| {
            crate::ipc_bridge::emit(
                &handle,
                "remote-connect-progress",
                &serde_json::json!({ "line": line, "connectionId": progress_id }),
            );
        };
        connect(app, params, &mut push).await
    };
    match res {
        Ok(outcome) => serde_json::to_value(outcome)
            .map_err(|e| format!("序列化连接结果失败: {}", e)),
        Err(e) => Err(format!("{:#}", e)),
    }
}

/// 查询连接状态。
#[tauri::command]
pub async fn remote_state(connection_id: String) -> Result<serde_json::Value, String> {
    state_of(&connection_id).await.map_err(|e| format!("{:#}", e))
}

/// 枚举当前注册表里的全部连接（方案B / 契约 §1.1）。
///
/// 前端启动恢复链靠它交叉本地持久化的 id 列表：桌面进程重启后远端后端已销毁，
/// 而 localStorage 里还留着上次的 id——没有枚举面就只能逐个猜 id 发 remote_state，
/// 既拿不到「Rust 有但前端没记住」的连接（徽标/分组树丢条目），也无法判定哪些 id
/// 该丢弃。元素形状 = state_of 减去 authHeader（枚举面脱敏，见 list_all）。
#[tauri::command]
pub async fn remote_list() -> Result<Vec<serde_json::Value>, String> {
    Ok(list_all().await)
}

/// 「忘记该主机」：清除该 host:port 的全部指纹记录（各算法 + 旧两段式线）。
/// 服务器确认换钥（如重装）后由前端在指纹拒绝错误下提供入口；清除后重连
/// 回到首连自动信任流程。返回 { removed } 删除条数（0 = 本无记录，幂等）。
#[tauri::command]
pub async fn remote_forget_host(host: String, port: Option<u16>) -> Result<serde_json::Value, String> {
    let port = port.unwrap_or(22);
    let host_for_log = host.clone();
    let removed = tokio::task::spawn_blocking(move || {
        known_hosts::remove(&known_hosts::default_path(), &host, port)
    })
    .await
    .map_err(|e| format!("任务异常: {}", e))?
    .map_err(|e| format!("{:#}", e))?;
    tracing::info!(
        "[remote] 已忘记主机 {}:{} 的指纹记录（{} 条）",
        host_for_log, port, removed
    );
    Ok(serde_json::json!({ "removed": removed }))
}

/// 手动重推模型镜像（远程工作区 P4 方案 A）：本地改完配置后无需重连。
/// 返回推送结果描述（成功/失败原因），前端 toast 展示。
#[tauri::command]
pub async fn remote_mirror_sync(app: tauri::AppHandle, connection_id: String) -> Result<serde_json::Value, String> {
    let conn = {
        let conns = CONNECTIONS.lock().await;
        conns.get(&connection_id).cloned()
    };
    let Some(conn) = conn else {
        return Err(format!("连接不存在: {}", connection_id));
    };
    let mut lines: Vec<String> = Vec::new();
    let ok = {
        let handle = app.clone();
        // 进度帧带 connectionId（契约 §1.3）：多连接并存时镜像推送的日志不能混进
        // 另一台机的向导（形态对齐下方 remote-mirror-state 推送，那边本来就带 id）
        let progress_id = connection_id.clone();
        let mut push = |line: String| {
            lines.push(line.clone());
            crate::ipc_bridge::emit(
                &handle,
                "remote-connect-progress",
                &serde_json::json!({ "line": line, "connectionId": progress_id }),
            );
        };
        mirror::push_with_progress(conn.local_port(), &conn.auth_user, &conn.auth_pass, &mut push).await
    };
    Ok(serde_json::json!({
        "connectionId": connection_id,
        "synced": ok,
        "lines": lines,
    }))
}
/// 列出本机 WSL 发行版（P2，仅 Windows 宿主）。无 WSL 时返回空列表而非错误
/// ——前端据此隐藏 WSL 通道（方案 §五：非 Windows 宿主不出现此通道）。
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn remote_wsl_list() -> Result<serde_json::Value, String> {
    match wsl::list_distros().await {
        Ok(list) => serde_json::to_value(list).map_err(|e| e.to_string()),
        Err(_) => Ok(serde_json::json!([])),
    }
}

/// 把当前选中的工作区目录绑到指定环境（按工作区分流，用户 2026-10-06 拍板）。
///
/// 为什么必须由前端在**选中工作区时**显式声明（而不是代理猜、也不是“一律给激活环境”）：
/// · 连上远端后用户选了一个远端目录（路径来自浏览远端），它带 `X-Session-Cwd` 进来
///   却没绑定 → route_for 第 4 级「带 cwd 未命中 = 本地」会把它打到本地后端，而本地
///   没有那个路径，创建/发消息直接失败。
/// · 反过来，连着远端时选**本地**目录：若按“给激活环境”处理就会绑到远端，等于
///   本地项目被跳机读写——比上一个更危险。
/// 所以上下文（这个列表从哪个后端拉的）只能由前端告知，归属才是确定的。
///
/// `connection_id` 为 None/空/"local" → 解绑（明确回本地）；为某连接 id → 绑到该连接
/// （id 未登记则返回 false，前端据此提示而不是默默路由错）。
#[tauri::command]
pub async fn remote_bind_scope(cwd: String, connection_id: Option<String>) -> Result<bool, String> {
    Ok(crate::server::bind_scope(&cwd, connection_id.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_key_format() {
        let t = SshTarget { host: "h".into(), port: 22, user: "u".into() };
        assert_eq!(host_key_of(&t), "h:22:u");
    }

    /// 连接 ID 必须带前缀（与裸 host_key 形状不同）：这个差异正是 P0 的成因
    /// （旧版复用检查拿裸键查表，永不命中）。前缀存在就逼住两个键不能等价。
    #[test]
    fn connection_id_is_prefixed_host_key() {
        assert_eq!(connection_id_of("h:22:u"), "rc-h:22:u");
        assert_ne!(
            connection_id_of("h:22:u"),
            "h:22:u",
            "连接 ID 与 host_key 必须不同形（否则下面的源码契约失去意义）"
        );
    }

    /// 【P0 回归】连接 ID 拼装必须只有一处，且 host 复用检查必须用同一个键。
    ///
    /// 上一轮的缺陷形态：注册写 `rc-` 前缀键，复用却拿裸 host_key 查——字面上
    /// 两边都像 `host_key` 变量，编译不报错、测试不拦截（当时无任何复用路径的
    /// 覆盖），于是「多工作区共享后端」从未生效，反而每次连接都先 kill 上一个
    /// 正在跑任务的远端后端。行为测试需要真 SSH 会话才能跑，故这里锁结构：
    /// ID 拼装单一来源 + 复用检查必须过 connection_id_of。
    #[test]
    fn connection_id_has_single_source_and_reuse_uses_it() {
        let src = include_str!("mod.rs");
        // ① ID 字面量全文件只能出现 1 次（在 connection_id_of 函数体内）。
        // 锚点拼接构造：include_str 会把本测试自己的断言字面量也计入（踩过两次）。
        let id_literal = ["\"rc-", "{}\""].concat();
        assert_eq!(
            src.matches(&id_literal).count(),
            1,
            "连接 ID 必须只有一个拼装点；多处拼装就是两个键形状分叉的开始"
        );
        // ② 复用检查必须用 connection_id_of 产出的键查 CONNECTIONS
        //  锚点取生产代码的分节注释（拼接构造，避开本断言字面量自匹配）
        let reuse_anchor = ["// \u{2500}\u{2500} host ", "\u{590d}\u{7528}\u{68c0}\u{67e5}"].concat();
        let reuse_seg = src
            .split(reuse_anchor.as_str())
            .nth(1)
            .and_then(|s| s.split("match kind {").next())
            .expect("host 复用段必须存在");
        assert!(
            reuse_seg.contains("connection_id_of("),
            "复用检查必须用 connection_id_of 构键，不能用裸 host_key"
        );
        assert!(
            !reuse_seg.contains("conns.get(&host_key)"),
            "不得拿裸 host_key 查注册表（P0 根因）"
        );
    }

    /// 【闪退根因回归】remote 模块内禁止 blocking_lock/block_on（async 上下文 = panic
    /// → panic=abort 杀全进程）。tokio::sync::Mutex 的 blocking_lock 内部是 block_on，
    /// 文档明写「panics if called within an asynchronous execution context」。
    /// 2026-10-10 闪退现场：register_connection（三通道 connect_* 尾段，async 上下文）
    /// 用 blocking_lock 登记注册表 → 连接成功瞬间闪退（c0000409 FAST_FAIL_FATAL_APP_EXIT）。
    /// 全仓搜一遍 remote 目录，这类 API 一处都不许出现。
    #[test]
    fn remote_never_blocks_async_runtime() {
        let src = include_str!("mod.rs");
        // 拼接构造：字面量拆并构造，避开 include_str 自匹配（踩过两次的老坑）
        let ban = ["blocking", "_lock"].concat();
        let call = [".", &ban, "()"].concat();
        assert!(
            !src.contains(&call),
            "不得存在 blocking_lock() 调用（tokio Mutex 在 async 上下文 panic→abort，连接成功瞬间闪退）"
        );
        // register_connection 必须 async（同步签名天然诱导 blocking_lock 复活）
        let sig = ["async fn register", "_connection("].concat();
        assert!(
            src.contains(&sig),
            "register_connection 必须保持 async 签名，防 blocking_lock 复活"
        );
    }

    /// 【P1 回归】断开的一次清零必须是原子写零。
    ///
    /// 旧写法在 refs 大于 1（同一台远端开了多个工作区）时只减一个：用户点「断开」
    /// 后远端后端仍常驻（白占内存），而徽标已消失（前端先置 null），既不提示也无
    /// 重试入口——只能重启应用才能收尾。行为测试需真会话（ControlPlane/exec）无法在
    /// 单测里跑，故锁结构：release_all 分支必须直接写零，不得混进递减一个引用。
    #[test]
    fn disconnect_release_all_clears_refs_atomically() {
        let src = include_str!("mod.rs");
        // 锚点拼接构造：include_str 会把本测试自己的字面量计入（踩过两次）
        let anchor = ["let remaining = if release_", "all {"].concat();
        let seg = src
            .split(anchor.as_str())
            .nth(1)
            .and_then(|s| s.split("} else {").next())
            .expect("release_all 分支必须存在");
        let update = ["fetch_", "update"].concat();
        assert!(seg.contains(&update), "一次清零必须用 fetch_update（先 load 再 store 会丢并发加一）");
        // 行为本质：该分支必须把计数直接写成 0。递减（无论减多少）都不等于清零：
        // refs>1 时只减一个 → 远端后端常驻（白占内存）而徽标已消失，用户无从重试。
        let sub = ["fetch_", "sub"].concat();
        assert!(!seg.contains(&sub), "release_all 分支不得递减引用（多工作区时断开静默失效）");
        let zero = ["Some(0),"].concat();
        assert!(seg.contains(&zero), "release_all 必须原子写零（fetch_update 的目标值就是 0）");
    }

    #[test]
    fn connect_params_auth_dispatch() {
        let p = ConnectParams {
            channel: None,
            host: "h".into(),
            port: None,
            user: "u".into(),
            auth_type: "password".into(),
            password: Some("x".into()),
            key_path: None,
            passphrase: None,
                    jump_host: None,
            jump_port: None,
            jump_user: None,
            jump_password: None,
            jump_key_path: None,
            jump_passphrase: None,
            runtime_pkg_path: None,
        };
        assert!(matches!(p.auth().unwrap(), AuthMethod::Password { .. }));
        // password 缺失要报错
        let bad = ConnectParams { password: None, ..p.clone() };
        assert!(bad.auth().is_err());

        let key = ConnectParams {
            auth_type: "key".into(),
            key_path: Some("/k".into()),
            passphrase: None,
            ..p
        };
        assert!(matches!(key.auth().unwrap(), AuthMethod::PrivateKey { .. }));
        // 未知类型报错
        let unknown = ConnectParams {
            auth_type: "token".into(),
            key_path: Some("/k".into()),
            ..key
        };
        assert!(unknown.auth().is_err());
    }

    #[test]
    fn connect_params_default_port_22() {
        let p = ConnectParams {
            channel: None,
            host: "h".into(),
            port: None,
            user: "u".into(),
            auth_type: "password".into(),
            password: Some("x".into()),
            key_path: None,
            passphrase: None,
                    jump_host: None,
            jump_port: None,
            jump_user: None,
            jump_password: None,
            jump_key_path: None,
            jump_passphrase: None,
            runtime_pkg_path: None,
        };
        assert_eq!(p.target().port, 22);
    }

    /// 通道形态解析：缺省 = ssh（P1 老前端兼容）；三通道各自合法；未知报错。
    #[test]
    fn connect_params_channel_dispatch() {
        let base = || ConnectParams {
            channel: None,
            host: "h".into(),
            port: None,
            user: "u".into(),
            auth_type: "password".into(),
            password: Some("x".into()),
            key_path: None,
            passphrase: None,
                    jump_host: None,
            jump_port: None,
            jump_user: None,
            jump_password: None,
            jump_key_path: None,
            jump_passphrase: None,
            runtime_pkg_path: None,
        };
        // 缺省 → Ssh（老前端不带 channel 字段）
        assert_eq!(base().channel_kind().unwrap(), ChannelKind::Ssh);
        let mut p = base();
        p.channel = Some("ssh".into());
        assert_eq!(p.channel_kind().unwrap(), ChannelKind::Ssh);
        let mut p = base();
        p.channel = Some("preinstalled".into());
        assert_eq!(p.channel_kind().unwrap(), ChannelKind::Preinstalled);
        #[cfg(target_os = "windows")]
        {
            let mut p = base();
            p.channel = Some("wsl".into());
            assert_eq!(p.channel_kind().unwrap(), ChannelKind::Wsl);
        }
        // 未知通道报错
        let mut p = base();
        p.channel = Some("carrier-pigeon".into());
        assert!(p.channel_kind().is_err());
    }

    /// PID 解析：JAVA_TOOL_OPTIONS 的 Picked up 前缀行不得干扰末行 PID。
    #[test]
    fn parse_pid_takes_last_nonempty_line() {
        let r = ssh::ExecResult {
            exit_code: 0,
            stdout: "Picked up JAVA_TOOL_OPTIONS: -Dgwork.remote=true\n12345\n".into(),
            stderr: String::new(),
        };
        assert_eq!(parse_pid(&r, "t").unwrap(), 12345);
        // 纯 PID（SSH 部署链形态）
        let r2 = ssh::ExecResult { stdout: "678".into(), stderr: String::new(), exit_code: 0 };
        assert_eq!(parse_pid(&r2, "t").unwrap(), 678);
        // 无 PID → 报错（带输出尾部）
        let r3 = ssh::ExecResult { stdout: "no pid here".into(), stderr: String::new(), exit_code: 0 };
        assert!(parse_pid(&r3, "t").is_err());
        // 非 0 退出码 → 报错
        let r4 = ssh::ExecResult { stdout: "123".into(), stderr: String::new(), exit_code: 1 };
        assert!(parse_pid(&r4, "t").is_err());
    }

    /// 部署 tar 必须是合法 tar.gz（本地解包验证，不依赖远端）。
    /// 覆盖 tar 头构造 + gzip 流：抽回原始字节比对。
    #[test]
    fn deploy_tar_round_trip() {
        let payload: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        let gz = build_deploy_tar(&payload).unwrap();

        use flate2::read::GzDecoder;
        use std::io::Read;
        let mut tar = Vec::new();
        GzDecoder::new(&gz[..]).read_to_end(&mut tar).unwrap();

        // tar 结构：512 头 + 数据 + padding + 1024 结束
        assert!(tar.len() > 512 + payload.len());
        // 名字在头部
        assert_eq!(&tar[0..18], b"gourd-ai-agent.jar");
        // size 字段（八进制）与数据长度一致
        let size_field = String::from_utf8_lossy(&tar[124..136]).to_string();
        let size = u64::from_str_radix(size_field.trim_end_matches('\0').trim(), 8).unwrap();
        assert_eq!(size as usize, payload.len());
        // 数据区
        assert_eq!(&tar[512..512 + payload.len()], &payload[..]);
        // checksum：按 header 规则重算（checksum 字段按空格）
        let mut hdr = [0u8; 512];
        hdr.copy_from_slice(&tar[..512]);
        // 校验时 checksum 字段需按空格算——把现值替换回空格再求和
        for b in hdr.iter_mut().take(156).skip(148) {
            *b = b' ';
        }
        let sum: u32 = hdr.iter().map(|&b| b as u32).sum();
        // 存储字段：148..154 是 6 位八进制（154=NUL，155=空格）
        let stored = String::from_utf8_lossy(&tar[148..154]).to_string();
        let stored_val = u32::from_str_radix(stored.trim(), 8).unwrap();
        assert_eq!(sum, stored_val, "tar checksum 必须自洽（远端 GNU tar 会校验）");
        // NUL + 空格填充（154/155），保证 GNU/busybox tar 均识别
        assert_eq!(tar[154], 0, "checksum 第 7 字节必须是 NUL");
        assert_eq!(tar[155], b' ', "checksum 第 8 字节必须是空格");
    }

    /// 远端 Basic Auth 凭据：随机且格式合法。
    #[test]
    fn random_credentials_shape() {
        let (u, p) = random_credentials();
        assert_eq!(u, "gwork");
        assert_eq!(p.len(), 24);
        assert!(p.chars().all(|c| c.is_ascii_alphanumeric()));
        // 两次生成不重
        let (_, p2) = random_credentials();
        assert_ne!(p, p2);
    }

    /// 凭据库键构造：ssh 形态 host:port:user；wsl 形态 wsl:distro:0:user。
    #[test]
    fn secrets_key_shapes() {
        let p = ConnectParams {
            channel: Some("ssh".into()),
            host: "h".into(),
            port: Some(2222),
            user: "u".into(),
            auth_type: "password".into(),
            password: None,
            key_path: None,
            passphrase: None,
                    jump_host: None,
            jump_port: None,
            jump_user: None,
            jump_password: None,
            jump_key_path: None,
            jump_passphrase: None,
            runtime_pkg_path: None,
        };
        assert_eq!(p.secrets_key(), "h:2222:u");
        let mut w = p.clone();
        w.channel = Some("preinstalled".into());
        assert_eq!(w.secrets_key(), "h:2222:u", "预装通道与 SSH 同键（同一身份）");
        #[cfg(target_os = "windows")]
        {
            let mut wsl = p.clone();
            wsl.channel = Some("wsl".into());
            wsl.host = "Ubuntu-22.04".into();
            assert_eq!(wsl.secrets_key(), "wsl:Ubuntu-22.04:0:u");
        }
    }

    /// autofill_secret：凭据库有记录时回填空密码；无记录时保持空（走正常失败链）。
    /// 【2026-10-11 测试卫生修复】旧名宣称 mock keyring 实际裸写真凭据库，且键固定
    /// `autofill.example:22:u`——测试中途 panic（或进程被杀）时 delete 不执行，残条目
    /// 让本用例在此后**每次运行必红**（本机凭据库实抓到该残留）。与 secrets.rs
    /// test_key 同范式：PID 唯一键 + 首尾双向清理 + 首断言前防御性 delete。
    #[test]
    fn autofill_secret_roundtrip_with_real_keyring() {
        let key = format!("__test__{}:autofill", std::process::id());
        let mut p = ConnectParams {
            channel: None,
            host: key.clone().into(),
            port: Some(22),
            user: "u".into(),
            auth_type: "password".into(),
            password: None,
            key_path: None,
            passphrase: None,
                    jump_host: None,
            jump_port: None,
            jump_user: None,
            jump_password: None,
            jump_key_path: None,
            jump_passphrase: None,
            runtime_pkg_path: None,
        };
        // 防御性清理：上次异常退出可能残留同名条目（旧版本固定键时代的遗产，
        // 凭据库里已抓到过）——先删再断言“未记录”。
        let _ = secrets::delete(&p.secrets_key());
        // 未记录：回填后仍空
        p.autofill_secret();
        assert!(p.password.is_none() || p.password.as_deref().unwrap_or("").is_empty());
        // 记录后：回填命中
        secrets::store(&p.secrets_key(), "stored-pass").unwrap();
        p.autofill_secret();
        assert_eq!(p.password.as_deref(), Some("stored-pass"));
        // 已填的密码不被覆盖（用户手输优先于库存）
        p.password = Some("manual".into());
        p.autofill_secret();
        assert_eq!(p.password.as_deref(), Some("manual"));
        let _ = secrets::delete(&p.secrets_key());
    }

    /// basic_auth_value 格式（前端直接塞 Authorization 头）。测自由函数，
    /// 不构造 RemoteConnection（那需要真 SSH 会话——测试性优先选可测画法）。
    #[test]
    fn basic_auth_value_format() {
        let h = basic_auth_value("gwork", "secret");
        assert!(h.starts_with("Basic "));
        let b64 = h.strip_prefix("Basic ").unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();
        assert_eq!(decoded, b"gwork:secret");
        // 密码含冒号/中文等字符：base64 展平，无解析歧义
        let h2 = basic_auth_value("u", "p:ass");
        let d2 = base64::engine::general_purpose::STANDARD
            .decode(h2.strip_prefix("Basic ").unwrap())
            .unwrap();
        assert_eq!(d2, b"u:p:ass");
    }

    // ─── 方案B（多远端并发）：参数分账 / 枚举面脱敏 / 事件带 id ───

    /// 碰全局表（CONNECTIONS / LAST_PARAMS / LAST_PARAMS_KEY）的用例共用这把锁：
    /// cargo test 默认多线程，两个用例交错写同一张全局表会得到随机失败
    /// （与 server.rs 的 route_test_guard 同理）。panic 打毒后取内部值继续。
    fn registry_guard() -> std::sync::MutexGuard<'static, ()> {
        static GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());
        match GUARD.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// 造一组测试参数（host/port/channel 三维可配，其余字段无关于本组用例）。
    fn params_of(channel: Option<&str>, host: &str, port: Option<u16>) -> ConnectParams {
        ConnectParams {
            channel: channel.map(str::to_string),
            host: host.to_string(),
            port,
            user: "u".to_string(),
            auth_type: "password".to_string(),
            password: Some("x".to_string()),
            key_path: None,
            passphrase: None,
            jump_host: None,
            jump_port: None,
            jump_user: None,
            jump_password: None,
            jump_key_path: None,
            jump_passphrase: None,
            runtime_pkg_path: None,
        }
    }

    /// 【契约 §1.2】重连参数必须按 connectionId 分账。
    ///
    /// 旧版单值 LAST_PARAMS 在多连接下的失效形态：先连 A 再连 B，A 掉线后自动重连
    /// 取到的是 B 的参数 —— 重连到错误的机器（A 上的活永远回不来，B 还被无端重启
    /// 一次远端后端）。本用例逐条钉死：分账命中、后写不覆盖先写、None 回落最近、
    /// 未知 id 显式失败（不得静默回落，否则「重错目标」这条更糟的路径又活了）。
    #[tokio::test]
    async fn reconnect_params_are_accounted_per_connection() {
        let _g = registry_guard();
        // 清场：其它用例（或上一次失败的断言）可能留有条目
        LAST_PARAMS.lock().await.clear();
        *LAST_PARAMS_KEY.lock().await = None;

        let pa = params_of(None, "a.example", Some(22));
        let pb = params_of(None, "b.example", Some(2222));
        remember_params("a.example:22:u", &pa).await;
        let id_a = connection_id_of("a.example:22:u");
        // 单条时 None 回落 = 该条（旧版语义）
        assert_eq!(reconnect_params(None).await.unwrap().host, "a.example");

        remember_params("b.example:2222:u", &pb).await;
        let id_b = connection_id_of("b.example:2222:u");
        // 核心：后连的 B 不得覆盖 A 的参数
        assert_eq!(reconnect_params(Some(id_a.clone())).await.unwrap().host, "a.example");
        assert_eq!(
            reconnect_params(Some(id_a.clone())).await.unwrap().port,
            Some(22)
        );
        assert_eq!(reconnect_params(Some(id_b.clone())).await.unwrap().host, "b.example");
        // None = 最近写入（此处是 B）
        assert_eq!(reconnect_params(None).await.unwrap().host, "b.example");
        // 未知 id：必须报错且消息带上该 id（前端据此把死连接从注册表摘除）
        let err = reconnect_params(Some("rc-nope".to_string())).await.unwrap_err();
        assert_eq!(err, "unknown connection: rc-nope");

        LAST_PARAMS.lock().await.clear();
        *LAST_PARAMS_KEY.lock().await = None;
        // 从未连过（表空 + 回落键空）：旧文案保留，前端靠它区分「没连过」与「连接已死」
        assert!(reconnect_params(None).await.is_err());
    }

    /// 进度事件的 connectionId 必须由参数推导得出，且与 connect 的注册键同源。
    ///
    /// 为何必须同源：事件发射点早于连接建立（注册表里还没这条），若另写一套键推导，
    /// 两者一旦漂移，前端按 id 过滤日志时会把整次连接的帧全丢掉 —— 表现为「向导日志
    /// 一片空白」，比改造前的混流更难查。
    #[test]
    fn progress_connection_id_derives_from_connect_key() {
        let ssh = params_of(None, "h", Some(22));
        assert_eq!(
            connection_id_of_params(&ssh).as_deref(),
            Some("rc-h:22:u"),
            "缺省通道（ssh）推导必须与 host_key_of 同形"
        );
        // 预装与 SSH 同键（同一台机共享引用计数，故也必须共享重连参数与日志归属）
        let pre = params_of(Some("preinstalled"), "h", Some(22));
        assert_eq!(connection_id_of_params(&pre), connection_id_of_params(&ssh));
        // 端口缺省 22 与显式 22 同键（target() 的 unwrap_or 口径）
        let no_port = params_of(None, "h", None);
        assert_eq!(connection_id_of_params(&no_port), connection_id_of_params(&ssh));
        // 未知通道：None（连接注定失败，错误由 connect 主体报，不抢先造第二个）
        let bad = params_of(Some("carrier-pigeon"), "h", Some(22));
        assert_eq!(connection_id_of_params(&bad), None);
        #[cfg(target_os = "windows")]
        {
            // WSL 形态：host 字段装的是 distro 名，键为 wsl:distro:user（无端口概念）
            let wsl = params_of(Some("wsl"), "Ubuntu-22.04", None);
            assert_eq!(
                connection_id_of_params(&wsl).as_deref(),
                Some("rc-wsl:Ubuntu-22.04:u")
            );
        }
    }

    /// 【契约 §1.1】枚举面必须脱敏：list_all 逐条产出 state_of 同款形状但**无 authHeader**，
    /// 单连接查询面仍带（前端代理注入之外，恢复链单条查询需要它）。
    ///
    /// 构造真连接需要控制面会话，只有 WSL 形态能在测试里零副作用构造
    /// （`WslSession::new` 不 spawn 任何进程；SSH 形态要真 TCP+认证），故本用例仅 Windows。
    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn list_all_omits_auth_header_and_state_of_keeps_it() {
        let _g = registry_guard();
        CONNECTIONS.lock().await.clear();
        // 两条 WSL Direct 形态连接（端口相同 = localhostForwarding 的真实碰撞场景）。
        // 插入顺序故意与 id 排序相反：list_all 必须按 connectionId 稳定排序，
        // 否则前端分组树/扇出拉取的顺序基准会随 HashMap 迭代序跳动。
        {
            let mut conns = CONNECTIONS.lock().await;
            conns.insert(
                "rc-wsl:z-distro:u".to_string(),
                Arc::new(RemoteConnection {
                    host_key: "wsl:z-distro:u".to_string(),
                    control: ControlPlane::Wsl(Arc::new(WslSession::new("z-distro", "u"))),
                    env: env_no_java(),
                    remote_pid: 0,
                    remote_port: 37201,
                    data: Some(DataPlane::Direct { port: 37201 }),
                    auth_user: "gwork".to_string(),
                    auth_pass: "zz".to_string(),
                    refs: std::sync::atomic::AtomicUsize::new(2),
                    state: std::sync::atomic::AtomicU8::new(0),
                    health_generation: std::sync::atomic::AtomicU64::new(0),
                }),
            );
            conns.insert(
                "rc-wsl:a-distro:u".to_string(),
                Arc::new(RemoteConnection {
                    host_key: "wsl:a-distro:u".to_string(),
                    control: ControlPlane::Wsl(Arc::new(WslSession::new("a-distro", "u"))),
                    env: env_no_java(),
                    remote_pid: 0,
                    remote_port: 37201,
                    data: Some(DataPlane::Direct { port: 37201 }),
                    auth_user: "gwork".to_string(),
                    auth_pass: "aa".to_string(),
                    refs: std::sync::atomic::AtomicUsize::new(1),
                    state: std::sync::atomic::AtomicU8::new(0),
                    health_generation: std::sync::atomic::AtomicU64::new(0),
                }),
            );
        }

        let list = list_all().await;
        assert_eq!(list.len(), 2, "注册表两条必须全部枚举出来");
        assert_eq!(
            list.iter().map(|v| v["connectionId"].as_str().unwrap_or("")).collect::<Vec<_>>(),
            vec!["rc-wsl:a-distro:u", "rc-wsl:z-distro:u"],
            "枚举顺序必须按 connectionId 稳定（前端分组树/扇出以它为序）"
        );
        for item in &list {
            // 脱敏：缺键而非空串（空串是「合法但无效」的值，可能被直接写进请求头 → 静默 401）
            assert!(
                item.get("authHeader").is_none(),
                "枚举面不得泄露凭据: {}",
                item
            );
            // 形状与 state_of 对齐（前端恢复链拿它当 state 的替代品填注册表）
            assert_eq!(item["state"], serde_json::json!("connected"));
            assert!(item["localPort"].as_u64().is_some());
            assert!(item["remotePort"].as_u64().is_some());
            assert!(item["host"].as_str().unwrap_or("").starts_with("wsl:"));
            assert_eq!(item["user"], serde_json::json!("u"));
            assert_eq!(item["channel"], serde_json::json!("wsl-direct"));
            assert!(item["refs"].as_u64().is_some());
        }
        assert_eq!(list[0]["refs"], serde_json::json!(1));
        assert_eq!(list[1]["refs"], serde_json::json!(2));

        // 对照：单连接查询面仍带 authHeader（既有前端依赖，不得被脱敏波及）
        let single = state_of("rc-wsl:a-distro:u").await.unwrap();
        assert_eq!(
            single["authHeader"].as_str().unwrap_or(""),
            basic_auth_value("gwork", "aa")
        );
        // 未知 id：disconnected 占位体（旧行为不变，前端据此丢弃 LS 里的残留 id）
        let gone = state_of("rc-nope").await.unwrap();
        assert_eq!(gone["state"], serde_json::json!("disconnected"));
        assert_eq!(gone["refs"], serde_json::json!(0));
        assert!(gone.get("authHeader").is_none());

        CONNECTIONS.lock().await.clear();
    }

    /// 无连接时枚举为空数组（不是 null、不是错误）：前端启动恢复链直接
    /// `list.filter(...)`，返回 null 会抛 TypeError 打断整个恢复流程。
    #[tokio::test]
    async fn list_all_is_empty_array_when_no_connections() {
        let _g = registry_guard();
        CONNECTIONS.lock().await.clear();
        assert_eq!(list_all().await.len(), 0);
    }

    /// 源码契约：`remote-connect-progress` 的**每一个**发射点都必须带 connectionId。
    ///
    /// 为何锁源码而不锁行为：发射需要真 AppHandle（webview.eval），单测里造不出来；
    /// 而漏掉一处 id 的后果是「并发连两台时该阶段日志混流」—— 只在并发场景偶发，
    /// 人工回归极易漏。锚点拼接构造：include_str 会把本测试自己的字面量计入子串计数
    /// （mod.rs 里踩过两次的老坑）。
    #[test]
    fn every_progress_emission_carries_connection_id() {
        let src = include_str!("mod.rs");
        let event = ["\"remote-connect-", "progress\""].concat();
        let id_field = ["\"connection", "Id\": progress_id"].concat();
        let mut at = 0usize;
        let mut hits = 0usize;
        while let Some(rel) = src[at..].find(&event) {
            let start = at + rel;
            // 取事件名之后的一段做判据：用 chars 截断（字节切片会把多字节中文劈成非法 UTF-8）
            let seg: String = src[start..].chars().take(260).collect();
            assert!(
                seg.contains(&id_field),
                "progress 发射点必须带 connectionId（并发连多台时前端靠它分账日志）"
            );
            at = start + event.len();
            hits += 1;
        }
        // 三个发射点：remote_connect / remote_reconnect / remote_mirror_sync
        assert_eq!(hits, 3, "progress 发射点数量变化时必须同步检查 id 标签");
    }

    /// 源码契约：新命令必须三处同时登记（handler / ACL 清单 / JS 桥）。
    ///
    /// 漏任一处都是**静默失败**：漏 handler = invoke 报 command not found；漏 build.rs
    /// 的 COMMANDS = 远程源（http://localhost:*）下被 ACL 直接拒绝；漏 JS 桥 = 前端
    /// `typeof ipc.remoteList !== 'function'` 走回退链，多连接恢复永不生效。
    /// 三者都不报错到日志里，只能靠护栏钉死。
    #[test]
    fn remote_list_is_registered_everywhere() {
        let main_src = include_str!("../main.rs");
        let build_src = include_str!("../../build.rs");
        let bridge_src = include_str!("../ipc_bridge.rs");

        let handler_anchor = ["remote::remote_", "list"].concat();
        assert!(
            main_src.contains(&handler_anchor),
            "remote_list 必须注册进 generate_handler!（否则 invoke 报 command not found）"
        );
        let acl_anchor = ["\"remote_", "list\""]
            .concat();
        assert!(
            build_src.contains(&acl_anchor),
            "remote_list 必须登记进 build.rs 的 COMMANDS（否则远程源下被 ACL 静默拒绝）"
        );
        let js_anchor = ["remote", "List: function"].concat();
        assert!(
            bridge_src.contains(&js_anchor),
            "BRIDGE_JS 必须暴露 remoteList()（前端启动恢复链靠它交叉在线连接）"
        );
        // 命令实现本体存在（防「登记了但没实现」的反向漂移）
        let cmd_anchor = ["pub async fn remote_", "list("].concat();
        assert!(include_str!("mod.rs").contains(&cmd_anchor));

        // remoteReconnect 必须透传可选 id（契约 §1.2）：不传时 Rust 侧回落「最近一台」，
        // 传了就必须原样送进命令（前端按 id 分账重连）
        let reconnect_js_anchor = ["remote", "Reconnect: function (connectionId)"].concat();
        assert!(
            bridge_src.contains(&reconnect_js_anchor),
            "JS 桥的 remoteReconnect 必须接受可选 connectionId"
        );
        let reconnect_cmd_anchor = ["pub async fn remote_", "reconnect(\n    app: tauri::AppHandle,\n    connection_id: Option<String>,"].concat();
        assert!(
            include_str!("mod.rs").contains(&reconnect_cmd_anchor),
            "remote_reconnect 必须接受 Option<String> 入参（None = 旧行为）"
        );
    }

    // ─── 离线/内网改造（一期）：解析链行为级测试 ───

    /// Mock 控制面通道：记录 exec 命令序列（解析链测试只断言 exec 序列与
    /// env 回填；上传字节级进度由 upload_progress_printer 单测覆盖）。
    struct MockChannel {
        execs: std::sync::Mutex<Vec<String>>,
    }
    impl MockChannel {
        fn new() -> Self {
            Self { execs: std::sync::Mutex::new(Vec::new()) }
        }
    }
    struct MockUploader;
    #[async_trait::async_trait]
    impl deploy::DeployUploader for MockUploader {
        async fn upload(
            &self,
            _path: String,
            _data: Vec<u8>,
            progress: &mut (dyn FnMut(u64, u64) + Send),
        ) -> Result<()> {
            progress(0, 1);
            progress(1, 1);
            Ok(())
        }
    }
    #[async_trait::async_trait]
    impl deploy::ExecChannel for MockChannel {
        async fn exec(&self, command: &str) -> Result<ssh::ExecResult> {
            self.execs.lock().unwrap().push(command.to_string());
            // L4 自装脚本以 echo INSTALLED 收尾：Mock 对 Adoptium 命令回该标记，
            // 使解析链能走完（否则 stdout 空会被当安装失败）
            let stdout = if command.contains("adoptium") { "INSTALLED".into() } else { String::new() };
            Ok(ssh::ExecResult { exit_code: 0, stdout, stderr: String::new() })
        }
        fn uploader(&self) -> Box<dyn deploy::DeployUploader> {
            Box::new(MockUploader)
        }
    }

    fn env_no_java() -> deploy::RemoteEnv {
        deploy::RemoteEnv {
            platform: "Linux".into(),
            arch: "x86_64".into(),
            java: None,
            java_major: None,
            libc: Some("2.17".into()),
            preset_runtime_java: None,
            preset_java_major: None,
            current_fingerprint: None,
            runtime_fingerprint: None,
            home: "/home/dev".into(),
        }
    }

    /// L0：系统 java 17 直接可用，解析链零动作（不 exec、不上传）。
    #[tokio::test]
    async fn resolve_chain_l0_system_java_17_noop() {
        let ch = MockChannel::new();
        let mut env = env_no_java();
        env.java = Some("/usr/bin/java".into());
        env.java_major = Some(17);
        let mut logs = Vec::new();
        ensure_remote_runtime(&ch, &mut env, None, &mut |s| logs.push(s))
            .await
            .unwrap();
        assert_eq!(env.java.as_deref(), Some("/usr/bin/java"), "L0 不改 java 路径");
        assert!(ch.execs.lock().unwrap().is_empty(), "L0 不应下发任何命令");
        assert!(logs.iter().any(|l| l.contains("系统 Java 可用")), "{:?}", logs);
    }

    /// L0 门禁：系统 java 8 不得被当可用（CentOS 假成功场景）——必须进入解析链
    /// 而非直接返回。后续落 L1（有内置资产）或 L4（无资产，Mock 回 INSTALLED）
    /// 均证明「没停在 L0」；断言不耦合内置资产存在与否。
    #[tokio::test]
    async fn resolve_chain_rejects_system_java_8() {
        let ch = MockChannel::new();
        let mut env = env_no_java();
        env.java = Some("/usr/bin/java".into());
        env.java_major = Some(8);
        let mut logs = Vec::new();
        ensure_remote_runtime(&ch, &mut env, None, &mut |s| logs.push(s))
            .await
            .unwrap();
        let execs = ch.execs.lock().unwrap().clone();
        assert!(!execs.is_empty(), "java 8 必须进入解析链（有 exec 动作）");
        assert!(env.java.is_some(), "解析链必须回填可用 java");
        assert_ne!(
            env.java.as_deref(),
            Some("/usr/bin/java"),
            "不得继续用系统 java 8"
        );
        assert!(logs.iter().any(|l| l.contains("低于")), "必须提示版本过低: {:?}", logs);
    }

    /// L3a：预置运行时 17 命中 → 直接回填，不 exec 不上传。
    #[tokio::test]
    async fn resolve_chain_l3a_preset_runtime() {
        let ch = MockChannel::new();
        let mut env = env_no_java();
        env.preset_runtime_java = Some("/home/dev/.gwork/remote/runtime/current/bin/java".into());
        env.preset_java_major = Some(17);
        let mut logs = Vec::new();
        ensure_remote_runtime(&ch, &mut env, None, &mut |s| logs.push(s))
            .await
            .unwrap();
        assert_eq!(
            env.java.as_deref(),
            Some("/home/dev/.gwork/remote/runtime/current/bin/java")
        );
        assert!(ch.execs.lock().unwrap().is_empty());
    }

    /// glibc 门禁：musl 远端在无预置/无用户包时必须报错且**零上传**（exec 无解包命令）。
    #[tokio::test]
    async fn resolve_chain_libc_gate_blocks_before_upload() {
        let ch = MockChannel::new();
        let mut env = env_no_java();
        env.libc = Some("musl".into());
        let mut logs = Vec::new();
        let err = ensure_remote_runtime(&ch, &mut env, None, &mut |s| logs.push(s))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("musl"), "{}", err);
        let execs = ch.execs.lock().unwrap().clone();
        assert!(
            execs.iter().all(|c| !c.contains("tar -xzf")),
            "门禁拦截后不得下发解包: {:?}",
            execs
        );
    }

    /// glibc 2.12（CentOS 6）同样拦截且报错带门槛值。
    #[tokio::test]
    async fn resolve_chain_libc_gate_old_glibc() {
        let ch = MockChannel::new();
        let mut env = env_no_java();
        env.libc = Some("2.12".into());
        let err = ensure_remote_runtime(&ch, &mut env, None, &mut |_| ())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("2.17"), "{}", err);
    }

    /// L3b：用户离线包优先于内置资产与 L4（Mock 无内置资产，若走 L4 会 exec Adoptium）。
    #[tokio::test]
    async fn resolve_chain_l3b_user_pkg_wins() {
        // 造一个临时 tar.gz 当用户包（内容任意，部署链 Mock 不解包）
        let dir = std::env::temp_dir().join(format!("gwork_rt_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pkg = dir.join("user-runtime.tar.gz");
        std::fs::write(&pkg, b"fake-runtime-bytes").unwrap();

        let ch = MockChannel::new();
        let mut env = env_no_java();
        let mut logs = Vec::new();
        let path_str = pkg.to_string_lossy().to_string();
        ensure_remote_runtime(&ch, &mut env, Some(&path_str), &mut |s| logs.push(s))
            .await
            .unwrap();
        // 回填为部署后的 runtime current 路径
        assert_eq!(
            env.java.as_deref(),
            Some("/home/dev/.gwork/remote/runtime/current/bin/java")
        );
        assert!(env.runtime_fingerprint.is_some(), "运行时指纹必须回填");
        // 未走 L4（无 Adoptium 命令）
        let execs = ch.execs.lock().unwrap().clone();
        assert!(execs.iter().all(|c| !c.contains("api.adoptium.net")), "{:?}", execs);
        // 日志含用户包提示
        assert!(logs.iter().any(|l| l.contains("离线运行时包")), "{:?}", logs);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 上传进度打印器节流：pct 0..100 步长 1 的 1001 次回调只产出 21 行。
    #[test]
    fn upload_progress_printer_throttles() {
        let mut lines: Vec<String> = Vec::new();
        {
            let mut sink = |s| lines.push(s);
            let mut p = upload_progress_printer(&mut sink);
            let total = 1000u64;
            for done in 0..=1000u64 {
                p(done, total); // pct = done/10 → 0..100 步长 1
            }
        }
        // pct=0,5,10,…,95 各一行 + 完成行（100%）= 21 行
        assert_eq!(lines.len(), 21, "{:?}", lines);
        assert!(lines[0].contains("0%"), "{}", lines[0]);
        assert!(lines.last().unwrap().contains("100%"), "{}", lines.last().unwrap());
        // 空包：total=0 直接完成一行
        let mut lines2: Vec<String> = Vec::new();
        {
            let mut sink2 = |s| lines2.push(s);
            let mut p = upload_progress_printer(&mut sink2);
            p(0, 0);
        }
        assert_eq!(lines2.len(), 1, "{:?}", lines2);
    }

    /// 内置运行时资产定位矩阵（codereview P0-2/P1-2 回归守护）：
    /// - 路径必须落在 runtimes/ 子目录（tauri.conf 映射与 make-runtime-linux.js
    ///   产出同口径；旧实现拼在 resources 根 → 发布版 L1 静默失效）；
    /// - platform 非 Linux 不得命中（macOS 远端 uname -m 同为 x86_64/aarch64，
    ///   旧实现只判 arch 会把 linux 资产上传到 mac 远端）。
    #[test]
    fn bundled_runtime_asset_path_and_platform_matrix() {
        let dir = std::env::temp_dir().join(format!("gwork_rt_asset_{}", std::process::id()));
        let rt = dir.join("runtimes");
        std::fs::create_dir_all(&rt).unwrap();
        std::fs::write(rt.join("runtime-linux-x64.tar.gz"), b"x").unwrap();
        std::fs::write(rt.join("runtime-linux-aarch64.tar.gz"), b"a").unwrap();
        // 根目录同名文件不得被命中（旧实现的错误落点）
        std::fs::write(dir.join("runtime-linux-x64.tar.gz"), b"root").unwrap();

        let hit = bundled_runtime_asset(dir.clone(), "Linux", "x86_64").unwrap();
        assert_eq!(hit.0, rt.join("runtime-linux-x64.tar.gz"), "必须落在 runtimes/ 子目录");
        assert_eq!(hit.1, "linux-x64");
        let hit2 = bundled_runtime_asset(dir.clone(), "Linux", "aarch64").unwrap();
        assert_eq!(hit2.0, rt.join("runtime-linux-aarch64.tar.gz"));
        // platform 门禁：macOS/其他 → None（走 L4 mac 分支或报错）
        assert!(bundled_runtime_asset(dir.clone(), "Darwin", "x86_64").is_none());
        assert!(bundled_runtime_asset(dir.clone(), "Darwin", "aarch64").is_none());
        assert!(bundled_runtime_asset(dir.clone(), "Linux", "riscv64").is_none());
        // 资产缺失 → None（回退 L4）
        let empty = dir.join("empty-base");
        std::fs::create_dir_all(empty.join("runtimes")).unwrap();
        assert!(bundled_runtime_asset(empty, "Linux", "x86_64").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// L3b 指纹跳过：远端 runtime 指纹与用户包相同时零上传零解包（重连不重传）。
    /// 旧实现 L3b 无条件读包+上传（注释声称「相同即跳过」而代码无比对）。
    #[tokio::test]
    async fn resolve_chain_l3b_skips_when_fingerprint_matches() {
        let dir = std::env::temp_dir().join(format!("gwork_rt_skip_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pkg = dir.join("user-runtime.tar.gz");
        std::fs::write(&pkg, b"fake-runtime-bytes").unwrap();
        let fp = deploy::fingerprint_of(b"fake-runtime-bytes");

        let ch = MockChannel::new();
        let mut env = env_no_java();
        env.runtime_fingerprint = Some(fp.clone()); // detect 已读回同指纹
        let mut logs = Vec::new();
        let path_str = pkg.to_string_lossy().to_string();
        ensure_remote_runtime(&ch, &mut env, Some(&path_str), &mut |s| logs.push(s))
            .await
            .unwrap();
        assert_eq!(
            env.java.as_deref(),
            Some("/home/dev/.gwork/remote/runtime/current/bin/java")
        );
        let execs = ch.execs.lock().unwrap().clone();
        assert!(
            execs.iter().all(|c| !c.contains("tar -xzf")),
            "同指纹不得下发解包: {:?}",
            execs
        );
        assert!(logs.iter().any(|l| l.contains("跳过上传")), "{:?}", logs);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ─── 真机端到端验收（2026-10-09 用户拍板：全流程自己走一遍） ───

    /// e2e 等待窗口（环境变量可覆盖）：152 类慢机冷启动实测 100s~数分钟不等，
    /// 生产窗口 180s 是产品体验边界，验收窗口默认 420s 给足环境 variability。
    fn e2e_wait_cap_secs() -> u64 {
        std::env::var("GWORK_E2E_WAIT_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(420)
    }
    //
    // 【为何是环境变量门控的集成测试而不是手工脚本】connect → detect → 运行时
    // 解析 → jar 上传部署 → 启动 → 隧道 → HTTP 全链不依赖 AppHandle（register
    // 尾段的镜像/探活才要 app），可在测试里直接编排；而手工拼脚本会绕过
    // 生产代码路径（测的不是用户走的那条链）。门控：GWORK_E2E_SSH_HOST 未设
    // 即跳过（CI/日常 cargo test 零影响）；设了就跑真机全链并在尾段清理
    // 远端产物（kill 后端 + 删测试工作区目录）。
    #[tokio::test]
    async fn e2e_ssh_connect_deploy_workspace_roundtrip() {
        let host = match std::env::var("GWORK_E2E_SSH_HOST") {
            Ok(h) if !h.trim().is_empty() => h,
            _ => {
                eprintln!("[e2e] GWORK_E2E_SSH_HOST 未设置，跳过真机验收");
                return;
            }
        };
        let user = std::env::var("GWORK_E2E_SSH_USER").unwrap_or_else(|_| "root".into());
        let pass = std::env::var("GWORK_E2E_SSH_PASS").expect("GWORK_E2E_SSH_PASS 必须设置");
        let port: u16 = std::env::var("GWORK_E2E_SSH_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(22);

        let mut logs: Vec<String> = Vec::new();
        let mut sink = |line: String| {
            eprintln!("[e2e] {}", line);
            logs.push(line);
        };

        // 1. SSH 连接 + 认证
        let target = SshTarget { host: host.clone(), port, user: user.clone() };
        let session = SshSession::connect(
            target.clone(),
            &AuthMethod::Password { password: pass.clone() },
        )
        .await
        .expect("SSH 连接必须成功");
        sink(format!("[e2e] SSH 已连接 {}@{}:{}", user, host, port));

        // 2. detect（真实远端环境）
        let mut env = deploy::detect(&session).await.expect("detect 必须成功");
        sink(format!(
            "[e2e] 远端 {} {} java={:?} major={:?} libc={:?} home={}",
            env.platform, env.arch, env.java, env.java_major, env.libc, env.home
        ));
        assert_eq!(env.platform, "Linux", "测试目标机必须是 Linux");

        // 1b. 残留清理：上一次被中断的 e2e 可能在远端留下 .deploying 锁与
        // 半截 tar.gz（进程被杀时无人破锁）——不清则本次在锁等待空转 2 分钟。
        let root_pre = deploy::remote_install_root(&env);
        let _ = session
            .exec(&format!(
                "pkill -f 'gourd-ai-agent[.]jar web' 2>/dev/null; sleep 1; \
                 rm -rf {r}/.deploying {r}/runtime/.deploying {r}/*.tar.gz {r}/runtime/*.tar.gz 2>/dev/null || true",
                r = ssh::shell_quote(&root_pre)
            ))
            .await;
        sink(format!("[e2e] 远端残留已清理（{}）", root_pre));

        // 2b. 上传探针（GWORK_E2E_PROBE_ONLY=1 时只跑探针即返回）：
        // 2026-10-09 真机 e2e 抓出 23MB 运行时上传在 ~50% 处停滞 14 分钟无进展。
        // 用递增尺寸（256KB/2MB/8MB）计时定位是「尺寸阈值型死锁」还是「吞吐型慢」：
        // 前者小包快大包挂（channel 窗口/未排空队列），后者全程匀速慢（链路/磁盘）。
        if std::env::var("GWORK_E2E_PROBE_ONLY").is_ok() {
            // 单命令探针（GWORK_E2E_EXEC）：远端磁盘/残留状态取证
            if let Ok(cmd) = std::env::var("GWORK_E2E_EXEC") {
                let r = session.exec(&cmd).await.expect("探针命令必须可执行");
                sink(format!(
                    "[e2e] exec exit={} stdout:\n{}\nstderr:\n{}",
                    r.exit_code, r.stdout, r.stderr
                ));
                session.disconnect().await;
                return;
            }
            let handle = super::ssh::SshSessionHandle::from(&session);
            for size_kb in [256usize, 2048, 8192] {
                let buf = vec![0x41u8; size_kb * 1024];
                let path = format!("/tmp/gwork-e2e-probe-{}.bin", size_kb);
                let t0 = std::time::Instant::now();
                let res = handle
                    .upload(&path, buf, &mut |_, _| {})
                    .await;
                let ms = t0.elapsed().as_millis();
                sink(format!(
                    "[e2e] 探针 {}KB → {}（{}ms，{:.1} KB/s）",
                    size_kb,
                    if res.is_ok() { "OK" } else { "ERR" },
                    ms,
                    if ms > 0 { (size_kb as f64) / (ms as f64) * 1000.0 } else { 0.0 }
                ));
                let _ = session
                    .exec(&format!("rm -f {}", ssh::shell_quote(&path)))
                    .await;
            }
            session.disconnect().await;
            return;
        }

        // 3. 运行时解析链（L0/L3a/L3b/L1/L4 按远端实况走）
        ensure_remote_runtime(&session, &mut env, None, &mut sink)
            .await
            .expect("运行时解析链必须成功");
        assert!(env.java.is_some(), "解析链必须回填 java");

        // 4. jar 部署（指纹比对跳过；首次则真上传 ~50MB）
        let root = deploy_and_switch(&session, &env, &mut sink)
            .await
            .expect("部署链必须成功");
        sink(format!("[e2e] 部署根 {}", root));

        // 5. 启动远端后端 + 探活
        let (auth_user, auth_pass) = random_credentials();
        let remote_port = allocate_remote_port(&session).await.expect("端口分配必须成功");
        let start_cmd = deploy::backend_start_command(&env, &root, remote_port, &auth_user, &auth_pass)
            .expect("启动命令必须可构造");
        let start_res = session.exec(&start_cmd).await.expect("启动命令必须可执行");
        let pid = parse_pid(&start_res, "e2e start backend").expect("必须拿到 PID");
        sink(format!("[e2e] 远端后端 PID={} port={}", pid, remote_port));

        // 5b. 隧道先建（与生产同序），就绪探活走数据面 HTTP
        let tunnel = Tunnel::start(session.handle(), remote_port, "127.0.0.1".to_string())
            .await
            .expect("隧道必须可建立");
        wait_backend_ready_with_cap(
            tunnel.local_port,
            &auth_user,
            &auth_pass,
            &mut sink,
            e2e_wait_cap_secs(),
        )
        .await
        .expect("远端后端必须在窗口内就绪");

        // 6. 数据面 HTTP（Basic Auth 注入，与代理同口径）
        let auth_header = basic_auth_value(&auth_user, &auth_pass);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap();
        let base = format!("http://127.0.0.1:{}", tunnel.local_port);

        // 6a. 项目列表（读）
        let list = client
            .get(format!("{}/web/chat/projects", base))
            .header("Authorization", auth_header.clone())
            .send()
            .await
            .expect("项目列表必须可达");
        assert_eq!(list.status(), 200, "项目列表必须 200");
        let list_body = list.text().await.unwrap_or_default();
        sink(format!("[e2e] 项目列表: {}", &list_body[..list_body.len().min(200)]));

        // 6b. 创建工作空间（写）：父目录用远端 home 下的 e2e 专用目录
        let ws_parent = format!("{}/.gwork-e2e-ws", env.home.trim_end_matches('/'));
        session
            .exec(&format!("mkdir -p {}", ssh::shell_quote(&ws_parent)))
            .await
            .expect("测试工作区父目录必须可建");
        let create = client
            .post(format!("{}/web/chat/projects/create", base))
            .header("Authorization", auth_header.clone())
            .json(&serde_json::json!({ "parent": ws_parent, "name": "e2e-ws" }))
            .send()
            .await
            .expect("创建工作空间必须可达");
        let create_status = create.status();
        let create_body = create.text().await.unwrap_or_default();
        sink(format!("[e2e] create 状态 {} body: {}", create_status, &create_body[..create_body.len().min(300)]));
        assert_eq!(create_status, 200, "create 必须 200");
        let created: serde_json::Value = serde_json::from_str(&create_body).unwrap_or(serde_json::json!({}));
        assert_eq!(
            created.get("code").and_then(|c| c.as_i64()),
            Some(200),
            "create 业务码必须 200: {}",
            create_body
        );
        let ws_path = format!("{}/e2e-ws", ws_parent);

        // 6c. 列表里必须能看到新工作区
        let list2 = client
            .get(format!("{}/web/chat/projects", base))
            .header("Authorization", auth_header.clone())
            .send()
            .await
            .expect("列表重拉必须可达");
        let list2_body = list2.text().await.unwrap_or_default();
        assert!(
            list2_body.contains("e2e-ws"),
            "新工作区必须出现在列表: {}",
            &list2_body[..list2_body.len().min(400)]
        );
        sink(format!("[e2e] 工作空间已创建并入列: {}", ws_path));

        // 7. 清理：注销工作区登记（不删磁盘目录的 remove 语义）+ kill 后端
        let rm = client
            .post(format!("{}/web/chat/projects/remove", base))
            .header("Authorization", auth_header.clone())
            .json(&serde_json::json!({ "path": ws_path }))
            .send()
            .await;
        if let Ok(r) = rm {
            sink(format!("[e2e] 工作区注销状态 {}", r.status()));
        }
        let _ = session
            .exec(&format!("rm -rf {}", ssh::shell_quote(&ws_parent)))
            .await;
        let stop = deploy::backend_stop_command(pid);
        let _ = session.exec(&stop).await;
        tunnel.stop();
        session.disconnect().await;
        sink(format!("[e2e] 清理完成（PID {} 已停，测试目录已删）", pid));
    }
}
