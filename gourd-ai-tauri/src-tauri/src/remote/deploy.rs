//! remote/deploy.rs —— 远端部署链（版本化安装根 + 原子切换）。
//!
//! 对应方案 v1.2 §四「部署冲突解耦」四件套：
//! 1. **版本化安装根** `~/.gwork/remote/<fingerprint>/`：每次部署写独立目录，
//!    与运行中进程零交集（回答「jar 有任务在跑，上传覆盖会不会报错」——不会，
//!    新版本写新目录，旧进程继续用旧目录）。
//! 2. **原子切换**：部署成功后 `ln -sfn <dir> current`（GNU/BSD/busybox 三系
//!    可移植；早期 mv -T 方案在 BSD/macOS 会报 illegal option，已废弃）。
//!    已运行进程的 jar 路径不受影响（inode 语义）；新连接解析 current 拿新版本。
//! 3. **指纹比对跳过**：`<安装根>/fingerprint` 文件内容 == 本地部署物指纹 → 跳过上传。
//! 4. **并发互斥**：远端 `mkdir <tmp>` 天然原子（两个部署者只有一个 mkdir 成功），
//!    P1 用它做轻量锁（比 flock 简单且无需解锁清理——目录本身就是要部署的内容）。
//!
//! 部署物：jar 与运行时（jlink 精简 JRE）**各自独立** tar.gz 流式上传
//! （cat > 流式，见 ssh.rs）。远端只需要 POSIX shell + tar + find。
//!
//! **运行时资产说明（离线/内网改造，一期）**：远端无可用 Java 时按分层解析链获取
//! 运行时（`resolve_runtime_plan`）：
//! - L0 远端系统 java 且主版本 ≥ [`MIN_JAVA_MAJOR`]（detect 解析 `java -version`，
//!   旧实现只 `command -v java` 不判版本——CentOS 自带 Java 8 会「假成功」后在
//!   60s 探活超时才暴露，本轮修复）；
//! - L3a 远端预置运行时（`~/.gwork/remote/runtime/current` 或
//!   `~/.gwork/remote/jre/<os>-<arch>`，气隙环境人工投放的兜底地板）；
//! - L3b 用户在向导指定的本地离线包 tar.gz（ConnectParams.runtime_pkg_path）；
//! - L1 桌面安装包内置的 jlink 运行时资产（`extraResources/runtime-linux-<arch>.tar.gz`，
//!   **内网/断网开箱即用的关键**——旧实现 JRE 只能远端自下 Adoptium，内网第一步就卡死）；
//! - L4 远端自装（`install_jre_command`，Adoptium 下载带 sha256 校验，保留为有网远端的省流量路径）。
//!
//! 运行时与 jar **指纹分离**：`~/.gwork/remote/<jar-fp>/` 与
//! `~/.gwork/remote/runtime/<rt-fp>/` 两棵版本化目录 + 各自 `current` 软链。
//! jar 每次发版都变而运行时几乎不变，混在一个指纹里会导致每次发版重传 ~20MB。
//!
//! **glibc 门禁**（`libc_gate`）：内置运行时是 glibc 构建（jmods 来源 Temurin，
//! 下限 2.17 = CentOS 7）。musl（Alpine）或 glibc < 2.17（CentOS 6 等）在上传前
//! 明确报错引导，而不是让进程死在启动后、表现为 60s 探活超时。

use anyhow::{anyhow, Result};
use serde::Serialize;

use super::ssh::{ExecResult, SshSession};

/// 控制面通道（P2/P3 部署链解耦）：执行远端 POSIX 命令。SSH 与 WSL 同形实现，
/// 部署/探测/启动逻辑只写一份，通道各自适配。
#[async_trait::async_trait]
pub trait ExecChannel: Send + Sync {
    async fn exec(&self, command: &str) -> Result<ExecResult>;

    /// 部署上传器：通道各自的传输实现（SSH = cat 流式；WSL = UNC 直拷 + cat 回退）。
    /// 返回 trait 对象而非闭包——deploy() 接受 &dyn DeployUploader，避免裸 dyn Fn
    /// 的生命周期纠缠。
    fn uploader(&self) -> Box<dyn DeployUploader>;
}

/// 上传能力（部署链的通道适配面）。Sync 必须：deploy future 要跨 await 持有
/// uploader 且整体 future 需满足 Tauri command 的 Send 约束（内部可变状态
/// 由实现自己保证，当前两个实现均无共享可变态）。
#[async_trait::async_trait]
pub trait DeployUploader: Send + Sync {
    /// `progress(done, total)` 字节级进度（向导日志可见）。旧实现只有 0/total
    /// 两个点，~90MB 上传在向导里看起来像死机，本轮补齐。
    async fn upload(
        &self,
        path: String,
        data: Vec<u8>,
        progress: &mut (dyn FnMut(u64, u64) + Send),
    ) -> Result<()>;
}

/// SSH 上传器（cat 流式，持有 SshSession 的多路复用 handle）。
pub struct SshUploader {
    session: super::ssh::SshSessionHandle,
}

#[async_trait::async_trait]
impl DeployUploader for SshUploader {
    async fn upload(
        &self,
        path: String,
        data: Vec<u8>,
        progress: &mut (dyn FnMut(u64, u64) + Send),
    ) -> Result<()> {
        self.session.upload(&path, data, progress).await
    }
}

#[async_trait::async_trait]
impl ExecChannel for SshSession {
    async fn exec(&self, command: &str) -> Result<ExecResult> {
        SshSession::exec(self, command).await
    }

    fn uploader(&self) -> Box<dyn DeployUploader> {
        Box::new(SshUploader {
            session: super::ssh::SshSessionHandle::from(self),
        })
    }
}

/// 远端环境探测结果（detect 阶段产物）。
#[derive(Debug, Clone, Serialize)]
pub struct RemoteEnv {
    pub platform: String,
    pub arch: String,
    /// 远端 java 可执行文件（$JAVA_HOME/bin/java 或 PATH 命中；无则 None）
    pub java: Option<String>,
    /// 远端 java 主版本（`java -version` 首行解析；无 java 或解析失败为 None）。
    /// **可用性判据是 java_major ≥ MIN_JAVA_MAJOR，不是 java.is_some()**——
    /// CentOS 等发行版自带 Java 8，旧实现判「有 java」即跳过运行时部署，
    /// jar（class 文件版本 61）启动即 UnsupportedClassVersionError。
    pub java_major: Option<u32>,
    /// 远端 C 库：glibc 版本串（如 "2.17"）/ "musl" / None（探测不到）。
    /// 内置运行时是 glibc 构建，musl 与过老 glibc 在上传前门禁拦截（libc_gate）。
    pub libc: Option<String>,
    /// 远端预置运行时 java 路径（L3a：runtime/current 或 jre/<os>-<arch> 命中）。
    pub preset_runtime_java: Option<String>,
    /// 预置运行时的主版本（`<pr> -version` 首行解析）。**预置也要判版本**——
    /// 气隙环境人工投放的目录里可能是 Java 8，不判就是另一种假成功。
    pub preset_java_major: Option<u32>,
    /// 已部署的 jar current 版本指纹（无部署则 None）
    pub current_fingerprint: Option<String>,
    /// 已部署的运行时 current 指纹（无则 None；与本地资产指纹相同即跳过上传）
    pub runtime_fingerprint: Option<String>,
    /// 家目录（~）
    pub home: String,
}

/// 远端 Java 最低主版本（与 gourdai-parent/pom.xml 的 java.version=17 对齐；
/// 生产代码用了 Stream.toList()/Files.readString 等 11~16+ API，class 版本 61）。
pub const MIN_JAVA_MAJOR: u32 = 17;

/// detect 脚本体（SSH 与 WSL 两通道共用同一份，保证 RemoteEnv 语义一致）。
///
/// 9 字段 \x1f 分隔：platform / arch / java 路径 / java -version 首行 / libc /
/// 预置运行时 java 路径 / HOME / jar current 指纹 / runtime current 指纹。
/// 版本首行原样回传、由 Rust 侧 [`parse_java_version_line`] 解析（单一解析器，
/// 可单测；不在远端 shell 里 sed——每种 JVM 的输出格式差异收在一处）。
pub fn detect_script() -> String {
    const SEP: &str = "\u{1f}";
    format!(
        "jv=''; if command -v java >/dev/null 2>&1; then jv=$(java -version 2>&1 | grep -v '^Picked up' | head -1); fi; \
         lc=$(set -- $(getconf GNU_LIBC_VERSION 2>/dev/null); printf '%s' \"$2\"); \
         if [ -z \"$lc\" ]; then if ldd --version 2>&1 | head -1 | grep -qi musl; then lc=musl; fi; fi; \
         am=$(uname -m | sed 's/x86_64/x64/;s/amd64/x64/;s/arm64/aarch64/'); \
         pr=''; \
         for c in \"$HOME/.gwork/remote/runtime/current/bin/java\" \"$HOME/.gwork/remote/jre/linux-$am/bin/java\" \"$HOME/.gwork/remote/jre/mac-$am/bin/java\"; do \
           if [ -x \"$c\" ]; then pr=$c; break; fi; \
         done; \
         pjv=''; if [ -n \"$pr\" ]; then pjv=$(\"$pr\" -version 2>&1 | grep -v '^Picked up' | head -1); fi; \
         printf '%s' \"$(uname -s)\" '{S}' \"$(uname -m)\" '{S}' \"$(command -v java || true)\" '{S}' \"$jv\" '{S}' \"$lc\" '{S}' \"$pr\" '{S}' \"$HOME\" '{S}' \"$(cat ~/.gwork/remote/current/fingerprint 2>/dev/null || true)\" '{S}' \"$(cat ~/.gwork/remote/runtime/current/fingerprint 2>/dev/null || true)\" '{S}' \"$pjv\" | head -c 8192",
        S = SEP
    )
}

/// 解析 detect 输出（纯函数，单测覆盖；通道层只负责把 stdout 拿回来）。
pub fn parse_detect(stdout: &str) -> Result<RemoteEnv> {
    const SEP: &str = "\u{1f}";
    let parts: Vec<&str> = stdout.split(SEP).collect();
    if parts.len() < 10 {
        // 【codereview 2026-10-09 P1】错误信息里的输出预览必须按字符取尾：
        // 字节切片 [..min(200)] 会在多字节字符（中文/GBK 解码产物）中间劈开
        // → panic（slice index not at char boundary），把「格式异常」升级成
        // 桌面进程崩溃。与 mod.rs tail_chars 同口径。
        return Err(anyhow!(
            "detect 输出格式异常（{} 段，期望 10）: {}",
            parts.len(),
            super::ssh::sanitize_output_tail(&tail_chars_preview(stdout, 200))
        ));
    }
    let opt = |s: &str| {
        let t = s.trim();
        if t.is_empty() { None } else { Some(t.to_string()) }
    };
    let version_line = parts[3].trim();
    Ok(RemoteEnv {
        platform: parts[0].trim().to_string(),
        arch: parts[1].trim().to_string(),
        java: opt(parts[2]),
        java_major: parse_java_version_line(version_line),
        libc: opt(parts[4]),
        preset_runtime_java: opt(parts[5]),
        preset_java_major: parse_java_version_line(parts[9].trim()),
        current_fingerprint: opt(parts[7]),
        runtime_fingerprint: opt(parts[8]),
        home: parts[6].trim().to_string(),
    })
}

/// 解析 `java -version` 首行拿主版本（各 JVM 格式收口处）。
///
/// 覆盖形态：`openjdk version "17.0.17" 2026-…` / `java version "1.8.0_392"` /
/// `openjdk version "21-ea" …` / `java version "17"`。规则：取第一对双引号内
/// 串，按 '.' 分段取首段前导数字；首段为 1 时取第二段前导数字（1.8 → 8）。
/// 解析失败返回 None（调用方视同「无可用 Java」，宁可多传一次运行时也不假成功）。
pub fn parse_java_version_line(line: &str) -> Option<u32> {
    let q1 = line.find('"')?;
    let rest = &line[q1 + 1..];
    let q2 = rest.find('"')?;
    let ver = &rest[..q2];
    let lead_digits = |s: &str| s.chars().take_while(|c| c.is_ascii_digit()).collect::<String>();
    let segs: Vec<&str> = ver.split('.').collect();
    let first = lead_digits(segs.first()?);
    let major = if first == "1" {
        lead_digits(segs.get(1)?)
    } else {
        first
    };
    if major.is_empty() {
        return None;
    }
    major.parse().ok()
}

/// 远端系统 java 是否可直接用（L0 判据）。
pub fn java_usable(env: &RemoteEnv) -> bool {
    env.java.is_some() && env.java_major.map(|m| m >= MIN_JAVA_MAJOR).unwrap_or(false)
}

/// 远端预置运行时是否可直接用（L3a 判据：路径存在且版本 ≥ MIN）。
pub fn preset_runtime_usable(env: &RemoteEnv) -> bool {
    env.preset_runtime_java.is_some()
        && env.preset_java_major.map(|m| m >= MIN_JAVA_MAJOR).unwrap_or(false)
}

/// glibc 门禁：内置运行时是 glibc 构建（jmods 源 Temurin，下限 2.17）。
/// 返回 Err(用户可读原因) 时调用方应终止运行时获取链（上传了也跑不起来）。
/// libc=None（getconf/ldd 都探不到）放行——探测不到不等于不兼容，交给启动失败兜底。
pub fn libc_gate(libc: Option<&str>) -> Result<(), String> {
    let v = match libc {
        None => return Ok(()),
        Some(v) => v,
    };
    if v.eq_ignore_ascii_case("musl") {
        return Err(
            "远端为 musl libc（Alpine 等）：内置运行时是 glibc 构建无法运行。\
             请改用 glibc 发行版，或在远端手动安装 musl 版 JDK 17+ 后重连"
                .to_string(),
        );
    }
    let segs: Vec<&str> = v.split('.').collect();
    let major: u32 = match segs.first().and_then(|s| s.parse().ok()) {
        Some(m) => m,
        None => return Ok(()), // 非数字形态（厂商魔改串）不拦
    };
    let minor: u32 = segs.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    if major == 2 && minor < 17 {
        return Err(format!(
            "远端 glibc {} 过老（内置运行时需 glibc ≥ 2.17，即 CentOS 7 / Ubuntu 14.04 以上）。\
             请升级系统，或在远端手动安装与该系统匹配的厂商 JDK 17+ 后重连",
            v
        ));
    }
    Ok(())
}

/// 探测远端环境。任何一步 shell 失败都返回带 cmd_hint 的错误。
/// P2/P3 起通道泛化：SSH 与 WSL 同一探测脚本（RemoteEnv 语义两通道一致）。
pub async fn detect(session: &dyn ExecChannel) -> Result<RemoteEnv> {
    let res = session.exec(&detect_script()).await?;
    let res = res.ok_or_error("detect (uname/java/libc/runtime/home/fingerprint)")?;
    parse_detect(&res.stdout)
}

/// 部署物本地指纹：字节 SHA-256 前 16 hex（目录名 + 比对用）。
/// jar 与运行时**各自独立指纹**（见模块注释「指纹分离」）：jar 每次发版变、
/// 运行时几乎不变，混算会导致每次发版重传 ~20MB 运行时。
pub fn fingerprint_of(jar_bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(jar_bytes);
    let out = h.finalize();
    hex::encode(&out[..8]) // 16 hex 字符
}

/// 远端安装根（家目录下）：`~/.gwork/remote`
pub fn remote_install_root(env: &RemoteEnv) -> String {
    format!("{}/.gwork/remote", trim_trailing_slash(&env.home))
}

/// 运行时版本化安装根：`~/.gwork/remote/runtime`（其下 `<fp>/` + `current` 软链，
/// 与 jar 的 `<root>/<fp>/` + `<root>/current` 同构，detect 读 current/fingerprint）。
pub fn remote_runtime_root(env: &RemoteEnv) -> String {
    format!("{}/runtime", remote_install_root(env))
}

/// 运行时部署后 java 可执行文件路径（deploy_runtime 成功后回填 env.java 用）。
pub fn remote_runtime_java(env: &RemoteEnv) -> String {
    format!("{}/current/bin/java", remote_runtime_root(env))
}

/// 部署物种类：决定解包后的验收门禁（见 deploy_script 注释）。
///
/// **jar 包与运行时包的验收判据不同，混用必出事故**：jar 部署包是单文件
/// tar（build_deploy_tar 只装 gourd-ai-agent.jar），用运行时的 `bin/java`
/// 门禁验收会 100% 报 NO_JAVA_IN_TAR——jar 部署链全灭（codereview P0-1）。
pub enum DeployKind {
    /// jar 部署包：验收 `current/gourd-ai-agent.jar` 存在。
    Jar,
    /// 运行时部署包：验收 `bin/java` 可执行（flat 或单层顶目录归一后）。
    Runtime,
}

/// 部署一次：上传 tar.gz → 解包到版本目录 → 原子切换 current。
///
/// `tar_bytes` 由调用方打包（含 gourd-ai-agent.jar；JRE 资产 P4 接入后加入）。
/// 幂等：远端 `current/fingerprint` 与 `fingerprint` 相同时跳过（调用方先比对）。
///
/// P2 起上传与命令分由两个通道能力承载：`exec_ch` 走控制面命令，`upload`
/// 闭包由调用方注入（SSH = cat 流式；WSL = UNC 直拷 + cat 回退）——部署逻辑
/// 只写一份，通道差异收在闭包里。
pub async fn deploy(
    exec_ch: &dyn ExecChannel,
    env: &RemoteEnv,
    fingerprint: &str,
    tar_bytes: Vec<u8>,
    uploader: &dyn DeployUploader,
    progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<()> {
    deploy_archive(
        exec_ch,
        &remote_install_root(env),
        fingerprint,
        tar_bytes,
        uploader,
        progress,
        DeployKind::Jar,
    )
    .await
}

/// 运行时部署（与 jar 部署同构，base 换 `~/.gwork/remote/runtime`）。
pub async fn deploy_runtime(
    exec_ch: &dyn ExecChannel,
    env: &RemoteEnv,
    fingerprint: &str,
    tar_bytes: Vec<u8>,
    uploader: &dyn DeployUploader,
    progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<()> {
    deploy_archive(
        exec_ch,
        &remote_runtime_root(env),
        fingerprint,
        tar_bytes,
        uploader,
        progress,
        DeployKind::Runtime,
    )
    .await
}

/// 版本化目录部署通用体：上传 tar.gz → 解包 → 布局归一 → 写指纹 → 原子切 current。
///
/// `base`：jar 传安装根、运行时传 runtime 根；两棵树的 staging/锁/current 互不
/// 相交（并发部署 jar 与运行时不会互锁）。
///
/// **布局归一**（离线包兼容的关键）：tar 顶层允许两种形态——flat（bin/ lib/
/// release 直接在顶，jlink 产物与 CI 产物形态）或单层顶目录（Temurin 官方包
/// `jdk-17.x.y+z/`、用户自打包常见）。解包后若顶层无 `bin/java`，用 find 定位
/// 第一个 `*/bin/java` 取其上两级为真实根整体 mv；找不到则 NO_JAVA_IN_TAR
/// 明确失败（不把坏包切成 current 留下半死状态）。
async fn deploy_archive(
    exec_ch: &dyn ExecChannel,
    base: &str,
    fingerprint: &str,
    tar_bytes: Vec<u8>,
    uploader: &dyn DeployUploader,
    progress: &mut (dyn FnMut(u64, u64) + Send),
    kind: DeployKind,
) -> Result<()> {
    let version_dir = format!("{}/{}", base, fingerprint);

    // 1. 并发互斥（P2 修复）：真锁。原 mkdir -p 对已存在目录恒成功，两个并发部署
    //    者都能"拿到锁"（摆设）。改 mkdir（无 -p）：仅一个成功，失败方自旋等待
    //    指纹就位（另一部署者完成的产物）或超时（异常退出，破锁接管）。
    let staging = format!("{}.staging", version_dir);
    let realroot = format!("{}.realroot", staging);
    let lock_dir = format!("{}/.deploying", base);
    let total = tar_bytes.len() as u64;
    // 【e2e 真机抓出的 P0（2026-10-09）】锁目录的父目录（base）首次部署时不存在：
    // `mkdir <base>/.deploying` 无 -p 必失败 → 误入「锁被占」分支空转 2 分钟等
    // 一个永远不会出现的指纹 → 破锁重试 mkdir 仍失败（父目录仍缺）→ 报误导性
    // 「部署锁竞争超时」。首连部署链 100% 死在这里，而全量测试绿是因为 Mock
    // 不模拟文件系统语义。修法：拿锁前先 mkdir -p base（幂等；并发下两方都
    // 成功不碍锁语义——锁是 base 下的 .deploying 子目录，仍由无 -p 的 mkdir 独占）。
    let _ = exec_ch
        .exec(&format!("mkdir -p {} 2>/dev/null || true", sh(base)))
        .await;
    match exec_ch.exec(&format!("mkdir {} 2>/dev/null", sh(&lock_dir))).await {
        Ok(r) if r.exit_code == 0 => { /* 拿到锁，正常部署 */ }
        _ => {
            // 锁被占：另一部署者在跑。等待其完成（指纹文件出现）或超时接管。
            // 超时说明持有者异常死亡（SSH 断连/进程被杀），rmdir 破锁后重试一次。
            progress(0, total);
            let mut waited = 0u64;
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                let check = exec_ch
                    .exec(&format!(
                        "cat {} 2>/dev/null",
                        sh(&format!("{}/fingerprint", version_dir))
                    ))
                    .await;
                if let Ok(c) = check {
                    if c.exit_code == 0 && c.stdout.trim() == fingerprint {
                        // 另一部署者已完成同版本：直接走 current 切换
                        progress(total, total);
                        return switch_current(exec_ch, base, &version_dir, &lock_dir).await;
                    }
                }
                waited += 500;
                if waited >= 120_000 {
                    // 2 分钟无进展：持有者大概率已死，破锁接管（残留 staging 由
                    // 本轮 rm -rf 清理，锁目录由 switch 尾段 rmdir）
                    let _ = exec_ch
                        .exec(&format!(
                            "rm -rf {} {}",
                            sh(&lock_dir),
                            sh(&staging)
                        ))
                        .await;
                    let retry = exec_ch
                        .exec(&format!("mkdir {} 2>/dev/null", sh(&lock_dir)))
                        .await;
                    if let Ok(r) = retry {
                        if r.exit_code == 0 {
                            break; // 破锁成功，继续部署
                        }
                    }
                    return Err(anyhow!(
                        "部署锁竞争超时（另一部署进程可能仍在运行）"
                    ));
                }
            }
        }
    }

    // 2. 上传 tar.gz 到远端临时文件（通道各自的 upload 实现）
    //
    // 【codereview 2026-10-09 P1】锁持有期间的失败路径必须破锁：旧实现上传/
    // 解包任一步 `?` 早退，远端 `.deploying` 锁目录无人清理 → 下一次连接
    // （含断线自动重连）在锁等待循环里空转满 2 分钟才破锁接管，用户视角是
    // 「上次失败后重连卡死两分钟」。锁语义是「部署者活着」，部署者已退出
    // 就该立即释放，不该靠下一次连接的超时兜底。
    let deploy_res = deploy_archive_locked(exec_ch, base, fingerprint, tar_bytes, uploader, progress, kind, &version_dir, &staging, &realroot, &lock_dir).await;
    if deploy_res.is_err() {
        let _ = exec_ch
            .exec(&format!("rmdir {} 2>/dev/null || true", sh(&lock_dir)))
            .await;
    }
    deploy_res
}

/// 拿到部署锁之后的部署主体（上传 → 解包 → 验收 → 切 current）。
/// 抽出独立函数是为了让锁的「获取/释放」在 deploy_archive 里一眼可见。
async fn deploy_archive_locked(
    exec_ch: &dyn ExecChannel,
    base: &str,
    fingerprint: &str,
    tar_bytes: Vec<u8>,
    uploader: &dyn DeployUploader,
    progress: &mut (dyn FnMut(u64, u64) + Send),
    kind: DeployKind,
    version_dir: &str,
    staging: &str,
    realroot: &str,
    lock_dir: &str,
) -> Result<()> {
    let total = tar_bytes.len() as u64;

    // 2. 上传 tar.gz 到远端临时文件（通道各自的 upload 实现）
    let tar_remote = format!("{}/{}.tar.gz", base, fingerprint);
    progress(0, total);
    uploader.upload(tar_remote.clone(), tar_bytes, &mut *progress).await?;
    progress(total, total);

    // 3. 解包 + 布局归一 + 写指纹 + 原子切换 current（单条 shell 保证原子性）
    //    - rm -rf staging 后 mkdir：残留清理
    //    - tar 解包（gzip）
    //    - 布局归一：顶层无 bin/java 时 find 定位真实根（见 deploy_archive 注释）
    //    - chmod +x bin/*：用户自打包可能丢可执行位（跨平台 tar 常见）
    //    - 写 fingerprint 文件（detect 经 current/fingerprint 读回做跳过比对）
    //    - mv 版本目录就位 + current 切换（可移植链，见 switch_current 注释）
    //    - 清理 tar 包与锁目录
    let switch_res = {
        let switch_cmd = deploy_script(staging, realroot, &tar_remote, version_dir, fingerprint, &kind);
        exec_ch.exec(&switch_cmd).await
    };
    let switch_res = switch_res?;
    if switch_res.exit_code != 0 && switch_res.stdout.contains("NO_JAVA_IN_TAR") {
        return Err(anyhow!(
            "部署包内未找到 bin/java（布局既非 flat 也无单层顶目录）——请确认包是 jlink/JDK 运行时 tar.gz"
        ));
    }
    if switch_res.exit_code != 0 && switch_res.stdout.contains("NO_JAR_IN_TAR") {
        return Err(anyhow!("部署包内未找到 gourd-ai-agent.jar——部署物损坏或打包链异常"));
    }
    switch_res.ok_or_error("deploy (tar/extract/normalize/mv)")?;

    switch_current(exec_ch, base, version_dir, lock_dir).await?;
    let _ = exec_ch.exec(&format!("rm -f {}", sh(&tar_remote))).await;

    Ok(())
}

/// 解包+布局归一+验收+写指纹的远端脚本（纯函数，单测覆盖；kind 决定验收门禁）。
///
/// **验收门禁按部署物种类分叉（codereview P0-1 修复）**：
/// - Runtime：布局归一（顶层无 bin/java 时 find 定位单层顶目录整体上移）→
///   chmod +x bin/* → `[ -x bin/java ]`，不满足 NO_JAVA_IN_TAR exit 7；
/// - Jar：包内只有 gourd-ai-agent.jar 单文件（build_deploy_tar），**不存在 bin/java**，
///   验收只判 jar 文件存在（NO_JAR_IN_TAR exit 8）。旧实现两 kind 共用运行时门禁，
///   jar 部署 100% 死在 NO_JAVA_IN_TAR——全量测试绿是因为 Mock 不模拟 shell 语义。
fn deploy_script(
    staging: &str,
    realroot: &str,
    tar_remote: &str,
    version_dir: &str,
    fingerprint: &str,
    kind: &DeployKind,
) -> String {
    let accept = match kind {
        DeployKind::Runtime => format!(
            "if [ ! -x {staging}/bin/java ]; then \
               j=$(find {staging} -maxdepth 4 -name java -path '*/bin/java' 2>/dev/null | head -1); \
               [ -n \"$j\" ] || {{ echo NO_JAVA_IN_TAR; exit 7; }}; \
               printf '%s' \"$(dirname \"$(dirname \"$j\")\")\" > {realroot}; \
             fi; \
             if [ -f {realroot} ]; then r=$(cat {realroot}); rm -rf {version_dir}; mv \"$r\" {version_dir}; rm -rf {staging}; \
             else rm -rf {version_dir}; mv {staging} {version_dir}; fi; \
             rm -f {realroot}; \
             chmod +x {version_dir}/bin/* 2>/dev/null || true; \
             [ -x {version_dir}/bin/java ] || {{ echo NO_JAVA_IN_TAR; exit 7; }};",
            staging = sh(staging),
            realroot = sh(realroot),
            version_dir = sh(version_dir),
        ),
        DeployKind::Jar => format!(
            "[ -f {staging}/gourd-ai-agent.jar ] || {{ echo NO_JAR_IN_TAR; exit 8; }}; \
             rm -rf {version_dir}; mv {staging} {version_dir}; rm -f {realroot};",
            staging = sh(staging),
            version_dir = sh(version_dir),
            realroot = sh(realroot),
        ),
    };
    format!(
        "set -e; \
         rm -rf {staging} {realroot}; mkdir -p {staging}; \
         tar -xzf {tar} -C {staging}; \
         {accept} \
         printf '%s' {fp} > {version_dir}/fingerprint",
        staging = sh(staging),
        realroot = sh(realroot),
        tar = sh(tar_remote),
        accept = accept,
        fp = sh(fingerprint),
        version_dir = sh(version_dir),
    )
}

/// current 切换 + 锁清理（可移植实现，主路径与锁竞争复用路径共用）。
///
/// current 原子切换的可移植性（P1-1 修复）：`mv -T` 是 GNU coreutils 特有
/// （BSD/macOS mv 无 -T，会报 illegal option 且目录非空时退化成嵌入）。
/// 可移植做法：`ln -sfn` 生成/替换符号链接（GNU/BSD/busybox 三系 mv 均支持 -n：
/// 对指向目录的已存在链接按文件语义原子替换）；仅当 ln 失败时回退 rm+ln
/// （非原子窗口只发生在异常磁盘态，可接受）。
async fn switch_current(
    exec_ch: &dyn ExecChannel,
    base: &str,
    version_dir: &str,
    lock_dir: &str,
) -> Result<()> {
    let cur = format!("{}/current", base);
    let switch_cmd = format!(
        "ln -sfn {version_dir} {cur} 2>/dev/null || {{ rm -rf {cur}; ln -s {version_dir} {cur}; }}; \
         rmdir {lock} 2>/dev/null || true",
        version_dir = sh(version_dir),
        cur = sh(&cur),
        lock = sh(lock_dir),
    );
    let res: ExecResult = exec_ch.exec(&switch_cmd).await?;
    res.ok_or_error("deploy (switch current)")?;
    Ok(())
}

/// 组装远端后端启动命令（deploy 后由调用方 exec）。
///
/// 与本地 backend.rs 的 JVM 参数对齐（SerialGC + FreeRatio + 内存参数——远端
/// 服务器内存通常更充裕，但沿用同一套收缩策略避免常驻膨胀）。差异：
/// - `-Dgwork.home=$HOME/.gwork-remote`：远端全局区独立（与 CLI 全局区隔离，
///   方案 §四·连接流程第 4 步）
/// - `-Dgwork.remote=true` + 凭据经 **GWORK_WEB_AUTH 环境变量**（P1-3 修复）：
///   早期版本把 `user:pass` 写进 `-Dgwork.web.auth=` 命令行参数，同一远端的任何
///   本地用户 `ps -ef` 即可看到凭据明文；环境变量对 ps 隐藏（/proc/PID/environ
///   仅进程属主可读）。Java 侧 AgentFlags 按「环境变量 → 系统属性」顺序回退消费。
/// - java 取远端探测到的可执行文件（env.java）
/// - 端口由调用方分配（远端 127.0.0.1 随机端口，find_available_port 语义）
pub fn backend_start_command(
    env: &RemoteEnv,
    root: &str,
    port: u16,
    auth_user: &str,
    auth_pass: &str,
) -> Result<String> {
    let java = env
        .java
        .as_ref()
        .ok_or_else(|| anyhow!("远端未安装 java（P1 需远端自装 JDK 17+；内置 JRE 资产链 P4 落地）"))?;
    let jar = format!("{}/current/gourd-ai-agent.jar", root);

    Ok(format!(
        "mkdir -p {home_remote}; \
         GWORK_WEB_AUTH={auth} nohup {java} -Xms48m -Xmx1024m -Xss512k \
             -XX:+UseSerialGC -XX:MinHeapFreeRatio=10 -XX:MaxHeapFreeRatio=25 \
             -XX:MaxMetaspaceSize=192m -XX:CompressedClassSpaceSize=64m \
             -XX:ReservedCodeCacheSize=96m -XX:InitialCodeCacheSize=4m -XX:-UsePerfData \
             -Dfile.encoding=UTF-8 -Dsolon.boot.openBrowser=false \
             -Dgwork.home={home_remote} \
             -Dgwork.remote=true \
             -jar {jar} web {port} \
             > {log} 2>&1 & \
             sleep 1; echo $!",
        auth = sh(&format!("{}:{}", auth_user, auth_pass)),
        java = sh(java),
        home_remote = sh(&format!("{}/.gwork-remote", trim_trailing_slash(&env.home))),
        jar = sh(&jar),
        port = port,
        log = sh(&format!("{}/.gwork-remote/server.log", trim_trailing_slash(&env.home))),
    ))
}

/// 停止远端后端进程（PID 语义由 backend_start_command 返回的 $! 承载）。
pub fn backend_stop_command(pid: u32) -> String {
    // kill 后等 2s，仍在则 -9。远端进程是我们 spawn 的，PID 精确可控（无 WSL 的
    // 「只 kill 自己 spawn 的 wsl.exe」问题——SSH 通道没有这条歧义）。
    format!(
        "kill {pid} 2>/dev/null; sleep 2; kill -9 {pid} 2>/dev/null; true",
        pid = pid
    )
}

// ─── P3：CLI 预装连接（CliHost）────────────────────────────────────

/// 探测远端预装 gwork CLI：返回 (gwork 路径, 版本串)。无则 None。
///
/// 版本取 `gwork version` 的输出（Configurator:253 输出 "GWork v2026.6.21"），
/// 该分支在 checkUpdate 之前，不联网、秒退。
pub async fn detect_preinstalled(session: &dyn ExecChannel) -> Result<Option<(String, String)>> {
    let res = session
        .exec("g=$(command -v gwork 2>/dev/null || true); if [ -n \"$g\" ]; then echo \"$g\"; $g version 2>/dev/null | tail -1; else echo ''; echo ''; fi")
        .await?;
    if res.exit_code != 0 {
        return Ok(None);
    }
    let mut lines = res.stdout.lines().filter(|l| !l.trim().is_empty());
    let (Some(path), Some(version)) = (lines.next(), lines.next()) else {
        return Ok(None);
    };
    Ok(Some((path.trim().to_string(), version.trim().to_string())))
}

/// CLI 预装模式的启动命令：复用远端已装的 gwork wrapper（install.sh 产物）。
///
/// 凭据注入走 **GWORK_WEB_AUTH 环境变量**（P1-3 修复）：早期用 JAVA_TOOL_OPTIONS
/// 注入 `-Dgwork.web.auth=user:pass`，双重泄漏：① JVM 启动时把 JAVA_TOOL_OPTIONS
/// 的内容以 "Picked up JAVA_TOOL_OPTIONS: …" 整行写进 nohup 日志（凭据明文永久留在
/// 远端磁盘的 server.log）；② 同机用户 ps -ef 可见。环境变量两者皆避（environ
/// 仅属主可读）。gwork wrapper 是 `exec java ${JAVA_OPTS[@]} -jar …`，env 前缀
/// 对 exec 语义完全透明。Java 侧 AgentFlags 消费环境变量，不再需要命令行插 -D。
///
/// 与 SSH 部署模式的语义对齐：
/// - `-Dgwork.home=$HOME/.gwork-remote`：远端全局区独立（预装 CLI 自己的
///   `~/.gwork` 全局区不动，会话/凭证互不污染）
/// - `-Dgwork.remote=true` + GWORK_WEB_AUTH：同 SSH 模式（WebAuthFilter 同一消费链）
/// - 端口：同远端随机分配逻辑（调用方传参）
pub fn preinstalled_start_command(
    env: &RemoteEnv,
    port: u16,
    auth_user: &str,
    auth_pass: &str,
) -> String {
    let home = trim_trailing_slash(&env.home);
    format!(
        "mkdir -p {home_r}; \
         nohup env GWORK_WEB_AUTH={auth} JAVA_TOOL_OPTIONS={tool_opts} gwork web {port} \
         > {log} 2>&1 & \
         echo $! > {pidfile}; sleep 1; cat {pidfile}",
        home_r = sh(&format!("{}/.gwork-remote", home)),
        auth = sh(&format!("{}:{}", auth_user, auth_pass)),
        tool_opts = sh(&format!("-Dgwork.home={}/.gwork-remote -Dgwork.remote=true", home)),
        port = port,
        log = sh(&format!("{}/.gwork-remote/server.log", home)),
        pidfile = sh(&format!("{}/.gwork-remote/server.pid", home)),
    )
}

/// 预装模式的停止命令：与部署模式同构（PID 由启动命令回传）。
pub fn preinstalled_stop_command(pid: u32) -> String {
    backend_stop_command(pid)
}

// ─── P4：远端 JRE 自装链（Adoptium/Temurin 17） ──────────────────────────────

/// Adoptium 二进制下载 URL（307 重定向 → GitHub release；curl 需 -L 跟随）。
pub fn adoptium_jre_url(os: &str, arch: &str) -> String {
    format!(
        "https://api.adoptium.net/v3/binary/latest/17/ga/{os}/{arch}/jre/hotspot/normal/eclipse",
        os = os, arch = arch
    )
}

/// Adoptium 元数据 URL（拿 sha256；JSON 为 pretty 格式，冒号后带空格）。
pub fn adoptium_checksum_url(os: &str, arch: &str) -> String {
    format!(
        "https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture={arch}&image_type=jre&os={os}",
        os = os, arch = arch
    )
}

/// uname -s/-m → Adoptium 枚举映射（linux/mac/x64/aarch64；alpine 特例暂不支持，
/// 报错回退手装）。返回 None = 不支持的平台组合。
pub fn adoptium_target(platform: &str, arch: &str) -> Option<(String, String)> {
    let os = match platform {
        "Linux" => "linux",
        "Darwin" => "mac",
        _ => return None,
    };
    let a = match arch {
        "x86_64" | "amd64" => "x64",
        "aarch64" | "arm64" => "aarch64",
        _ => return None,
    };
    Some((os.to_string(), a.to_string()))
}

/// 远端 JRE 自装命令（单条 shell，POSIX；curl 或 wget 二选一）。
///
/// 流程：探测下载器 → 拿 checksum（元数据 JSON pretty 格式，grep 带空格模式）→
/// 下载 tar.gz（307 重定向，curl -L / wget 默认跟随）→ sha256sum 校验 → 解压到
/// `~/.gwork/remote/jre/<os>-<arch>/` → 写 done 标记。幂等：done 标记存在即跳过。
///
/// 注意：macOS 解压后顶层多一层 Contents/Home（tar --strip-components 处理不了双层），
/// 用 `find ... -name java -path '*/bin/java'` 定位后建 bin 软链兼容统一布局。
pub fn install_jre_command(env: &RemoteEnv, os: &str, arch: &str) -> String {
    let url = adoptium_jre_url(os, arch);
    let meta_url = adoptium_checksum_url(os, arch);
    let jre_dir = format!(
        "{}/.gwork/remote/jre/{}-{}",
        trim_trailing_slash(&env.home),
        os,
        arch
    );
    format!(
        r#"set -e
if [ -x '{jre_dir}/bin/java' ]; then echo SKIP; exit 0; fi
dl='' ; command -v curl >/dev/null 2>&1 && dl=curl ; command -v wget >/dev/null 2>&1 && dl=wget
[ -z "$dl" ] && {{ echo NO_DOWNLOADER; exit 3; }}
mkdir -p '{jre_dir}'
sum=$( {{ [ "$dl" = curl ] && curl -fsSL '{meta_url}' || wget -qO- '{meta_url}'; }} \
      | grep -o '"checksum"[[:space:]]*:[[:space:]]*"[0-9a-f]\{{64\}}"' \
      | grep -o '[0-9a-f]\{{64\}}' | head -1 )
[ -n "$sum" ] || {{ echo NO_CHECKSUM; exit 4; }}
tar_gz='{jre_dir}/jre.tar.gz'
if [ "$dl" = curl ]; then curl -fSL -o "$tar_gz" '{url}'; else wget -qO "$tar_gz" '{url}'; fi
echo "$sum  $tar_gz" | sha256sum -c - >/dev/null 2>&1 || {{ echo CHECKSUM_MISMATCH; exit 5; }}
tar -xzf "$tar_gz" -C '{jre_dir}' --strip-components=1
rm -f "$tar_gz"
# macOS 多层 Contents/Home：软链统一到 jre_dir/bin
if [ ! -x '{jre_dir}/bin/java' ]; then
  real=$(find '{jre_dir}' -type f -name java -path '*/bin/java' | head -1)
  [ -n "$real" ] && {{ mkdir -p '{jre_dir}/bin'; ln -sf "$real" '{jre_dir}/bin/java'; }}
fi
[ -x '{jre_dir}/bin/java' ] || {{ echo NO_JAVA; exit 6; }}
echo INSTALLED"#,
        jre_dir = sh(&jre_dir),
        meta_url = sh(&meta_url),
        url = sh(&url),
    )
}

/// JRE 自装后 java 可执行文件路径（detect 回填 env.java 用）。
pub fn remote_jre_java(env: &RemoteEnv, os: &str, arch: &str) -> String {
    format!(
        "{}/.gwork/remote/jre/{}-{}/bin/java",
        trim_trailing_slash(&env.home),
        os,
        arch
    )
}

fn sh(s: &str) -> String {
    super::ssh::shell_quote(s)
}

/// 错误信息预览用的头部 n 字符（UTF-8 边界安全；detect 输出异常时展示前缀
/// 比尾部更有信息量——字段顺序从头开始）。按字符而非字节切，多字节字符
/// 不会被劈出 panic/U+FFFD。
fn tail_chars_preview(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn trim_trailing_slash(s: &str) -> String {
    s.trim_end_matches('/').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_16_hex_and_stable() {
        let a = fingerprint_of(b"hello");
        let b = fingerprint_of(b"hello");
        let c = fingerprint_of(b"world");
        assert_eq!(a, b, "同字节同指纹");
        assert_ne!(a, c);
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    #[test]
    fn install_root_under_home() {
        let env = RemoteEnv {
            platform: "Linux".into(),
            arch: "x86_64".into(),
            java: Some("/usr/bin/java".into()),
            java_major: Some(17),
            libc: Some("2.28".into()),
            preset_runtime_java: None,
            preset_java_major: None,
            current_fingerprint: None,
            runtime_fingerprint: None,
            home: "/home/dev".into(),
        };
        assert_eq!(remote_install_root(&env), "/home/dev/.gwork/remote");
        // 家目录带尾斜杠也收敛
        let env2 = RemoteEnv { home: "/home/dev/".into(), ..env };
        assert_eq!(remote_install_root(&env2), "/home/dev/.gwork/remote");
    }

    #[test]
    fn start_command_carries_required_flags() {
        let env = RemoteEnv {
            platform: "Linux".into(),
            arch: "x86_64".into(),
            java: Some("/usr/bin/java".into()),
            java_major: Some(17),
            libc: Some("2.28".into()),
            preset_runtime_java: None,
            preset_java_major: None,
            current_fingerprint: None,
            runtime_fingerprint: None,
            home: "/home/dev".into(),
        };
        let cmd = backend_start_command(&env, "/home/dev/.gwork/remote", 18080, "u", "p").unwrap();
        // 远端独立全局区
        assert!(cmd.contains("-Dgwork.home=/home/dev/.gwork-remote"), "{}", cmd);
        // 【e2e 真机 P0 回归（2026-10-09）】启动命令必须自建全局区目录：日志重定向
        // 目标 ~/.gwork-remote/server.log 依赖目录存在，首连必缺 → shell 重定向
        // 立即失败后端瞬死（echo $! 仍回 PID 假成功 → 60s 探活超时）。
        // preinstalled 模式有 mkdir -p 而部署模式曾漏（两模式命令不齐）。
        assert!(
            cmd.contains("mkdir -p /home/dev/.gwork-remote"),
            "启动命令必须先建全局区（日志重定向依赖）: {}",
            cmd
        );
        // 远端模式标记
        assert!(cmd.contains("-Dgwork.remote=true"));
        // 凭据经 GWORK_WEB_AUTH 环境变量（P1-3 修复：不进命令行 -D，ps -ef 不可见）
        assert!(cmd.contains("GWORK_WEB_AUTH='u:p'"), "凭据必须经环境变量注入: {}", cmd);
        assert!(!cmd.contains("-Dgwork.web.auth="), "凭据不得出现在命令行参数里（ps 泄漏面）");
        // 现有 web 命令形态 + 端口
        assert!(cmd.contains("web 18080"));
        // jar 走 current 软链（版本化安装根）
        assert!(cmd.contains("current/gourd-ai-agent.jar"));
        // nohup + $!：拿远端 PID 供停止（Rust 多行字符串里就是字面 "& "）
        assert!(cmd.contains("nohup"));
        assert!(cmd.contains("& "));
        assert!(cmd.contains("echo $!"));
        // 【WSL #5143 回归锁定】nohup 后台化后必须 sleep 1 再回 PID：wsl.exe 会话
        // 退出时后台子进程存在被清理的竞态（社区验证 sleep 1 后稳定）；SSH 通道
        // 无此问题但同一命令体共用，1s 成本可忽略。
        assert!(
            cmd.contains("sleep 1; echo $!"),
            "后台启动后必须 sleep 1 缓冲再取 PID（WSL 会话清理竞态）: {}",
            cmd
        );
        // 日志重定向（诊断远端启动失败的关键，ZCode 教训）
        assert!(cmd.contains(">"));
        assert!(cmd.contains("2>&1"));
    }

    #[test]
    fn start_command_fails_without_java() {
        let env = RemoteEnv {
            platform: "Linux".into(),
            arch: "x86_64".into(),
            java: None,
            java_major: None,
            libc: None,
            preset_runtime_java: None,
            preset_java_major: None,
            current_fingerprint: None,
            runtime_fingerprint: None,
            home: "/home/dev".into(),
        };
        assert!(backend_start_command(&env, "/r", 1, "u", "p").is_err());
    }

    #[test]
    fn stop_command_escalates_to_kill9() {
        let cmd = backend_stop_command(4242);
        assert!(cmd.contains("kill 4242"));
        assert!(cmd.contains("kill -9 4242"));
        // 结尾 true：进程已死时整条命令仍退出 0（幂等）
        assert!(cmd.trim_end().ends_with("true"));
    }

    // 【2026-10-10 154 事故修复】远端 shell /dev/tcp 探针原语已整体废弃
    // （真机证明间歇性不可靠：同命令同通道整窗全败而端口在听）；就绪/
    // 健康探活改走数据面 HTTP（mod.rs wait_backend_ready / spawn_health_probe）。
    #[test]
    fn probe_primitive_removed_from_production_paths() {
        let src = include_str!("mod.rs");
        let wait_body = src
            .split("async fn wait_backend_ready_with_cap")
            .nth(1)
            .unwrap_or("");
        assert!(
            !wait_body.contains("probe_command"),
            "就绪探活不得再走远端 shell 探针"
        );
        let health = src
            .split("fn spawn_health_probe")
            .nth(1)
            .unwrap_or("");
        assert!(
            !health.contains("probe_command"),
            "健康探活不得再走远端 shell 探针"
        );
    }

    // ─── P3：CLI 预装命令构造 ───

    fn env_for_test() -> RemoteEnv {
        RemoteEnv {
            platform: "Linux".into(),
            arch: "x86_64".into(),
            java: Some("/usr/bin/java".into()),
            java_major: Some(17),
            libc: Some("2.28".into()),
            preset_runtime_java: None,
            preset_java_major: None,
            current_fingerprint: None,
            runtime_fingerprint: None,
            home: "/home/dev".into(),
        }
    }

    #[test]
    fn preinstalled_start_injects_via_java_tool_options() {
        let cmd = preinstalled_start_command(&env_for_test(), 18081, "u", "p");
        // 凭据经 GWORK_WEB_AUTH 环境变量（P1-3 修复：JAVA_TOOL_OPTIONS 会把 -D 值
        // 整行写进 "Picked up …" 日志，凭据永久残留远端 server.log）
        assert!(cmd.contains("GWORK_WEB_AUTH='u:p'"), "凭据必须走环境变量: {}", cmd);
        assert!(!cmd.contains("-Dgwork.web.auth="), "凭据不得出现在 JAVA_TOOL_OPTIONS（Picked up 日志泄漏）");
        // 注入内容：独立全局区 + 远端标记
        assert!(cmd.contains("JAVA_TOOL_OPTIONS="), "{}", cmd);
        assert!(cmd.contains("-Dgwork.home=/home/dev/.gwork-remote"), "{}", cmd);
        assert!(cmd.contains("-Dgwork.remote=true"), "{}", cmd);
        // gwork wrapper 本体 + web 子命令 + 端口
        assert!(cmd.contains("gwork web 18081"), "{}", cmd);
        // PID 回传两段式（避开 JAVA_TOOL_OPTIONS 的 Picked up 输出污染）
        assert!(cmd.contains("echo $! >"), "{}", cmd);
        assert!(cmd.contains("cat "), "{}", cmd);
        // 日志落远端全局区（诊断启动失败）
        assert!(cmd.contains("server.log"), "{}", cmd);
    }

    #[test]
    fn preinstalled_start_quotes_credentials() {
        // 凭据含空格/特殊字符时必须被 shell_quote 包裹（随机密码含任意字母数字
        // 不会命中，但畸形注入要防）
        let cmd = preinstalled_start_command(&env_for_test(), 1, "us er", "p;rm");
        assert!(cmd.contains("'us er:p;rm'"), "凭据必须整体被单引号包裹: {}", cmd);
    }

    #[test]
    fn preinstalled_stop_reuses_kill_escalation() {
        let cmd = preinstalled_stop_command(999);
        assert!(cmd.contains("kill 999"));
        assert!(cmd.contains("kill -9 999"));
    }

    #[test]
    fn detect_preinstalled_script_shape() {
        // 源码扫描：探测命令必须同时拿路径与版本（command -v + gwork version），
        // 且失败分支静默（echo ''）不报错——探测不到 gwork 是正常态不是错误
        let src = include_str!("deploy.rs");
        assert!(src.contains("command -v gwork"), "探测必须用 command -v");
        assert!(src.contains("$g version"), "版本必须取 gwork version 输出");
    }

    // ─── P4：远端 JRE 自装链 ───

    #[test]
    fn adoptium_target_maps_platform_arch() {
        assert_eq!(adoptium_target("Linux", "x86_64").unwrap(), ("linux".into(), "x64".into()));
        assert_eq!(adoptium_target("Linux", "aarch64").unwrap(), ("linux".into(), "aarch64".into()));
        assert_eq!(adoptium_target("Darwin", "arm64").unwrap(), ("mac".into(), "aarch64".into()));
        assert_eq!(adoptium_target("Darwin", "x86_64").unwrap(), ("mac".into(), "x64".into()));
        // 不支持组合返 None（调用方回退报错，不生成畸形 URL）
        assert!(adoptium_target("Windows", "x86_64").is_none());
        assert!(adoptium_target("Linux", "riscv64").is_none());
    }

    #[test]
    fn adoptium_urls_are_wellformed() {
        assert_eq!(
            adoptium_jre_url("linux", "x64"),
            "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jre/hotspot/normal/eclipse"
        );
        assert_eq!(
            adoptium_checksum_url("mac", "aarch64"),
            "https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=aarch64&image_type=jre&os=mac"
        );
    }

    #[test]
    fn install_jre_command_contract() {
        let cmd = install_jre_command(&env_for_test(), "linux", "x64");
        // 幂等：已装即跳过
        assert!(cmd.contains("echo SKIP"), "幂等跳过分支必须存在: {}", cmd);
        // 下载器二选一（curl/wget 均无 → 明确退出码而非含糊失败）
        assert!(cmd.contains("command -v curl") && cmd.contains("command -v wget"));
        assert!(cmd.contains("NO_DOWNLOADER"));
        // checksum 提取：pretty JSON 的 "checksum": "..." 模式（冒号后有空格）
        assert!(cmd.contains("grep -o '"), "checksum 提取用 grep（无 jq/python 依赖）");
        // 307 重定向：curl 必须带 -L
        assert!(cmd.contains("curl -fSL"), "curl 下载必须 -L 跟随 307 重定向: {}", cmd);
        // sha256sum -c 校验链
        assert!(cmd.contains("sha256sum -c"), "下载后必须校验 sha256: {}", cmd);
        // 路径引号（家目录带空格时 shell_quote 包裹）
        assert!(cmd.contains("'"), "远端路径必须 shell_quote");
        // macOS 兼容分支：Contents/Home 软链
        assert!(cmd.contains("find '"), "macOS 多层解压目录的软链兼容分支必须存在");
    }

    #[test]
    fn remote_jre_java_path() {
        let p = remote_jre_java(&env_for_test(), "linux", "x64");
        assert_eq!(p, "/home/dev/.gwork/remote/jre/linux-x64/bin/java");
    }

    // ─── 离线/内网改造（一期）：版本解析 / 门禁 / detect v2 ───

    #[test]
    fn java_version_line_matrix() {
        // 现代 OpenJDK
        assert_eq!(
            parse_java_version_line("openjdk version \"17.0.17\" 2026-01-20"),
            Some(17)
        );
        // 老式 1.x 前缀（CentOS 自带 Java 8 的典型形态——假成功的元凶）
        assert_eq!(
            parse_java_version_line("openjdk version \"1.8.0_392\" 2023-10-17 LTS"),
            Some(8)
        );
        assert_eq!(
            parse_java_version_line("java version \"1.8.0_311\""),
            Some(8)
        );
        // EA / 单段
        assert_eq!(parse_java_version_line("openjdk version \"21-ea\" 2026"), Some(21));
        assert_eq!(parse_java_version_line("openjdk version \"17\""), Some(17));
        // 畸形：无引号 / 空串 / 非数字首段 → None（宁可多传运行时也不假成功）
        assert_eq!(parse_java_version_line("no version here"), None);
        assert_eq!(parse_java_version_line(""), None);
        assert_eq!(parse_java_version_line("version \"abc\""), None);
    }

    #[test]
    fn java_usable_requires_major_17() {
        let mut env = env_for_test();
        env.java = Some("/usr/bin/java".into());
        env.java_major = Some(17);
        assert!(java_usable(&env), "17 可用");
        env.java_major = Some(21);
        assert!(java_usable(&env), "21 可用");
        env.java_major = Some(8);
        assert!(!java_usable(&env), "Java 8 必须判不可用（CentOS 假成功场景）");
        env.java_major = None;
        assert!(!java_usable(&env), "版本解析失败视同不可用");
        env.java = None;
        env.java_major = Some(17);
        assert!(!java_usable(&env), "无路径仅版本也不可用");
    }

    #[test]
    fn preset_runtime_requires_major_17() {
        let mut env = env_for_test();
        env.preset_runtime_java = Some("/home/dev/.gwork/remote/runtime/current/bin/java".into());
        env.preset_java_major = Some(17);
        assert!(preset_runtime_usable(&env));
        env.preset_java_major = Some(11);
        assert!(!preset_runtime_usable(&env), "预置 Java 11 也是假成功，必须拒");
        env.preset_runtime_java = None;
        env.preset_java_major = Some(17);
        assert!(!preset_runtime_usable(&env));
    }

    #[test]
    fn libc_gate_matrix() {
        // glibc ≥ 2.17 放行
        assert!(libc_gate(Some("2.17")).is_ok(), "CentOS 7 下限必须放行");
        assert!(libc_gate(Some("2.28")).is_ok());
        assert!(libc_gate(Some("2.39")).is_ok());
        // glibc < 2.17 拦截（CentOS 6）
        let e = libc_gate(Some("2.12")).unwrap_err();
        assert!(e.contains("2.17"), "报错必须带门槛值: {}", e);
        let e = libc_gate(Some("2.5")).unwrap_err();
        assert!(e.contains("glibc"), "{}", e);
        // musl 拦截（Alpine）
        let e = libc_gate(Some("musl")).unwrap_err();
        assert!(e.contains("musl"), "{}", e);
        // 探测不到 / 非数字形态：放行（交给启动失败兜底，不误伤）
        assert!(libc_gate(None).is_ok());
        assert!(libc_gate(Some("weird-vendor-libc")).is_ok());
        // 主版本 3（未来 glibc）放行
        assert!(libc_gate(Some("3.0")).is_ok());
    }

    #[test]
    fn detect_script_probes_version_libc_and_preset() {
        let s = detect_script();
        // 版本：java -version 首行原样回传（Rust 侧单一解析器）；
        // Picked up 行先滤（JAVA_TOOL_OPTIONS 噪声，codereview P1-1）
        assert!(s.contains("java -version 2>&1 | grep -v '^Picked up' | head -1"), "{}", s);
        // libc：getconf 主路 + ldd musl 兜底
        assert!(s.contains("getconf GNU_LIBC_VERSION"), "{}", s);
        assert!(s.contains("musl"), "{}", s);
        // 预置运行时：runtime/current 与 jre/<os>-<arch> 两候选 + 其版本也回传
        assert!(s.contains(".gwork/remote/runtime/current/bin/java"), "{}", s);
        assert!(s.contains(".gwork/remote/jre/linux-$am/bin/java"), "{}", s);
        assert!(s.contains("$pr\" -version"), "预置运行时版本必须探测: {}", s);
        // 10 字段分隔符计数 = 9 个
        assert_eq!(s.matches('\u{1f}').count(), 9, "{}", s);
    }

    #[test]
    fn parse_detect_ten_fields_roundtrip() {
        let sep = '\u{1f}';
        let stdout = format!(
            "Linux{0}x86_64{0}/usr/bin/java{0}openjdk version \"1.8.0_392\"{0}2.17{0}/home/dev/.gwork/remote/runtime/current/bin/java{0}/home/dev{0}abc123{0}def456{0}openjdk version \"17.0.2\"{0}",
            sep
        );
        let env = parse_detect(&stdout).unwrap();
        assert_eq!(env.platform, "Linux");
        assert_eq!(env.arch, "x86_64");
        assert_eq!(env.java.as_deref(), Some("/usr/bin/java"));
        assert_eq!(env.java_major, Some(8), "系统 java 是 8 → 不可用");
        assert_eq!(env.libc.as_deref(), Some("2.17"));
        assert_eq!(
            env.preset_runtime_java.as_deref(),
            Some("/home/dev/.gwork/remote/runtime/current/bin/java")
        );
        assert_eq!(env.home, "/home/dev");
        assert_eq!(env.current_fingerprint.as_deref(), Some("abc123"));
        assert_eq!(env.runtime_fingerprint.as_deref(), Some("def456"));
        assert_eq!(env.preset_java_major, Some(17), "预置运行时是 17 → 可用");
        // 旧 5 字段输出必须报错（不允许静默降级回旧语义）
        assert!(parse_detect("a\u{1f}b\u{1f}c\u{1f}d\u{1f}e").is_err());
    }

    /// 【codereview 2026-10-09 P1 回归】detect 输出异常且含多字节字符时，
    /// 错误信息预览不得 panic：旧实现字节切片 [..min(200)] 会在中文中间
    /// 劈开 → slice index not at char boundary 崩溃（把格式异常升级成进程崩溃）。
    #[test]
    fn parse_detect_error_preview_is_char_boundary_safe() {
        let sep = '\u{1f}';
        // 300 个中文（900 字节）且字段数 3（<10）→ 必进错误分支
        let stdout = format!("a{0}b{0}{1}", sep, "检".repeat(300));
        let err = parse_detect(&stdout).expect_err("字段数不足必须报错");
        let msg = err.to_string();
        assert!(msg.contains("detect 输出格式异常"), "{}", msg);
        assert!(msg.contains('检'), "预览必须保留原文字符: {}", msg);
        assert!(!msg.contains('\u{fffd}'), "预览不得含替换符: {}", msg);
    }

    /// 【codereview 2026-10-09 P1 回归】部署失败路径必须破锁：旧实现上传/解包
    /// 任一步 `?` 早退，远端 .deploying 锁目录残留 → 下一次连接（含断线自动
    /// 重连）在锁等待循环空转满 2 分钟才接管。
    #[test]
    fn deploy_archive_releases_lock_on_failure() {
        let src = include_str!("deploy.rs");
        // 锚点拼接构造（include_str 会把本测试字面量计入，取首个出现=生产调用点）
        let anchor = "deploy_archive_locked(exec_ch, base, fingerprint, tar_bytes, uploader, progress, kind".to_string();
        let seg = src
            .split(&anchor)
            .nth(1)
            .expect("deploy_archive 必须经 deploy_archive_locked 承载部署主体");
        assert!(
            seg.contains("deploy_res.is_err()"),
            "调用后必须判失败并破锁: {}",
            seg
        );
        let rmdir = ["rmdir {}", " 2>/dev/null || true"].concat();
        assert!(
            seg.contains(&rmdir),
            "失败必须 rmdir 破锁（否则下次连接空转 2 分钟）: {}",
            seg
        );
    }

    /// 【e2e 真机 P0 回归（2026-10-09）】拿锁前必须 mkdir -p base：首次部署时
    /// base（~/.gwork/remote 或 runtime 根）不存在，无 -p 的锁 mkdir 必失败 →
    /// 误入锁等待空转 2 分钟报误导性「锁竞争超时」。顺序是判据：mkdir -p base
    /// 必须在锁 mkdir 之前。
    #[test]
    fn deploy_lock_parent_dir_created_before_lock_mkdir() {
        let src = include_str!("deploy.rs");
        let mkdir_p = ["mkdir -p {}", " 2>/dev/null || true"].concat();
        let lock_mkdir = ["mkdir {}", " 2>/dev/null\""].concat();
        let i_parent = src.find(&mkdir_p).expect("拿锁前必须 mkdir -p base");
        let i_lock = src[i_parent..]
            .find(&lock_mkdir)
            .expect("mkdir -p base 之后才是锁 mkdir");
        // 锁 mkdir 必须仍在 deploy_archive 内（紧随其后，不被其它函数隔开）
        let seg = &src[i_parent..i_parent + i_lock + 400];
        assert!(
            seg.contains("lock_dir"),
            "mkdir -p 与锁 mkdir 必须同处部署锁段: {}",
            seg
        );
    }

    /// detect 脚本必须滤掉 JAVA_TOOL_OPTIONS 的 Picked up 行（jv 与 pjv 两处）。
    /// 不滤则版本首行字段被噪声占据 → java_major=None → 有 Java 17 的远端被误判
    /// 无 Java，内网环境白传 20MB 运行时（codereview P1-1）。
    #[test]
    fn detect_script_filters_java_tool_options_noise() {
        let s = detect_script();
        let anchor = ["grep -v ", "'^Picked up'"].concat();
        assert_eq!(
            s.matches(&anchor).count(),
            2,
            "jv 与 pjv 两处版本首行都必须滤 Picked up: {}",
            s
        );
    }

    /// 部署脚本验收门禁按 kind 分叉（codereview P0-1 回归守护）：
    /// jar 包（单文件 tar）用 bin/java 门禁验收必死 NO_JAVA_IN_TAR——
    /// 旧实现两 kind 共用运行时门禁，jar 部署链 100% 失败而全量测试绿
    /// （Mock 不模拟 shell 语义），故门禁分叉必须有直接断言。
    #[test]
    fn deploy_script_kind_gates_diverge() {
        let rt = deploy_script("/b/S.staging", "/b/S.realroot", "/b/f.tar.gz", "/b/f", "fp", &DeployKind::Runtime);
        let jar = deploy_script("/b/S.staging", "/b/S.realroot", "/b/f.tar.gz", "/b/f", "fp", &DeployKind::Jar);
        // Runtime：布局归一 + bin/java 验收 + 可执行位
        assert!(rt.contains("NO_JAVA_IN_TAR"), "{}", rt);
        assert!(rt.contains("bin/java"), "{}", rt);
        let anchor_chmod = ["chmod +x /b/f", "/bin/*"].concat();
        assert!(rt.contains(&anchor_chmod), "{}", rt);
        assert!(!rt.contains("NO_JAR_IN_TAR"), "运行时门禁不得混入 jar 标记: {}", rt);
        // Jar：只验收 jar 文件存在，**不得出现 bin/java 门禁**
        assert!(jar.contains("NO_JAR_IN_TAR"), "{}", jar);
        let anchor_jar = ["[ -f /b/S.staging", "/gourd-ai-agent.jar ]"].concat();
        assert!(jar.contains(&anchor_jar), "{}", jar);
        assert!(!jar.contains("bin/java"), "jar 包无 bin/java，门禁不得验收它: {}", jar);
        assert!(!jar.contains("NO_JAVA_IN_TAR"), "{}", jar);
        // 公共段：解包 + 写指纹
        for s in [&rt, &jar] {
            assert!(s.contains("tar -xzf"), "{}", s);
            assert!(s.contains("fingerprint"), "{}", s);
        }
    }

    /// 部署脚本形态契约：布局归一 + 可执行位 + NO_JAVA_IN_TAR 明确失败。
    #[test]
    fn deploy_script_normalizes_layout() {
        // 源码契约（锚点全部拼接构造，避免 include_str 自匹配；且锚点必须在
        // 生产代码中逐字连续出现——拼错锚点会当场红，不会假绿）
        let src = include_str!("deploy.rs");
        let anchor_find = ["-maxdepth 4 -name java -path ", "'*/bin/java'"].concat();
        assert!(src.contains(&anchor_find), "布局归一必须用 find 定位 bin/java");
        let anchor_norm = ["NO_JAVA_IN_TAR", "; exit 7"].concat();
        assert!(src.contains(&anchor_norm), "坏包必须明确失败 exit 7");
        // 顺序契约：坏包判定必须在版本目录就位（mv staging）之前——否则坏包先
        // mv 成版本目录再报错，留下垃圾目录（变异 M7 只删早判、尾判仍抓得住，
        // 存在性断言区分不了，顺序才能区分）。
        let first_guard = src.find(&anchor_norm).unwrap();
        let mv_staging = ["mv {staging} {version_dir}", "; fi"].concat();
        let mv_idx = src.find(&mv_staging).unwrap();
        assert!(first_guard < mv_idx, "坏包早判必须在 mv 版本目录之前（防垃圾目录残留）");
        let anchor_chmod = ["chmod +x {version_dir}", "/bin/*"].concat();
        assert!(src.contains(&anchor_chmod), "必须补可执行位（跨平台 tar 丢位）");
        // runtime 根与 jar 根分离（指纹分离的目录体现）
        let anchor_rt = ["{}", "/runtime"].concat();
        assert!(src.contains(&anchor_rt), "runtime 根必须是安装根下的 runtime 子目录");
    }
}
