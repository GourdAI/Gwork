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
///
/// ## 为何没有 JRE 相关字段
///
/// 本壳部署的内核是 **musl 静态二进制**（CI 的 `x86_64-unknown-linux-musl` /
/// `aarch64-unknown-linux-musl` 目标），不依赖任何远端运行时。旧版这里的
/// `preset_runtime_java` / `preset_java_major` / `runtime_fingerprint` 服务于
/// 「远端无 Java 就上传 jlink JRE」那条链，已随该链整体删除（见模块注释）。
///
/// `java` / `java_major` / `libc` 保留，但**不再是部署前提**：
/// - `java`/`java_major`：只服务「CLI 预装且预装的是 Java wrapper」这一种存量
///   场景——那个 `gwork` 本体是 `exec java -jar …`，确实需要可用 JVM
///   （见 [`KernelFlavor`]）；
/// - `libc`：仅供诊断与日志（例如 e2e 里识别 Alpine 系发行版），不参与任何门禁。
#[derive(Debug, Clone, Serialize)]
pub struct RemoteEnv {
    pub platform: String,
    pub arch: String,
    /// 远端 java 可执行文件（$JAVA_HOME/bin/java 或 PATH 命中；无则 None）
    pub java: Option<String>,
    /// 远端 java 主版本（`java -version` 首行解析；无 java 或解析失败为 None）。
    /// **可用性判据是 java_major ≥ MIN_JAVA_MAJOR，不是 java.is_some()**——
    /// CentOS 等发行版自带 Java 8，判「有 java」就会假成功，而 jar 的 class 版本
    /// 是 61，启动即 UnsupportedClassVersionError。
    pub java_major: Option<u32>,
    /// 远端 C 库：glibc 版本串（如 "2.17"）/ "musl" / None（探测不到）。
    /// **仅诊断用**：静态 musl 内核不依赖远端 libc，故不再有任何门禁读它
    /// （旧版拿它拦「musl/过老 glibc」，那是给 glibc 构建的 JRE 资产用的）。
    pub libc: Option<String>,
    /// 已部署的内核 current 版本指纹（无部署则 None；与本地资产指纹相同即跳过上传）
    pub current_fingerprint: Option<String>,
    /// 家目录（~）
    pub home: String,
}

/// 远端 Java 最低主版本（与 gourd-ai-agent/pom.xml 的 java.version=17 对齐；
/// 生产代码用了 Stream.toList()/Files.readString 等 11~16+ API，class 版本 61）。
///
/// **唯一消费者是「CLI 预装 + Java wrapper」的门禁**（[`KernelFlavor::Java`]）。
/// 本壳部署的 Rust 内核是静态二进制，不需要 JVM，内核部署路径完全不读这个阈值。
pub const MIN_JAVA_MAJOR: u32 = 17;

/// 部署到远端的内核二进制名（tar 内条目名 = 远端 `current/` 下的文件名）。
///
/// 与 CI 产物名一致（`cargo build --release -p gourd-work-cli` → `target/release/gwork`），
/// 也与远端预装探测的 `command -v gwork` 一致——三处同一个名字，部署链与预装链
/// 才能共享引用计数与停止命令。
pub const KERNEL_BIN: &str = "gwork";

/// 远端内核可执行文件路径（版本化安装根的 current 软链下）。
pub fn remote_kernel_bin(root: &str) -> String {
    format!("{}/current/{}", trim_trailing_slash(root), KERNEL_BIN)
}

/// detect 脚本体（SSH 与 WSL 两通道共用同一份，保证 RemoteEnv 语义一致）。
///
/// **7 字段** \x1f 分隔：platform / arch / java 路径 / java -version 首行 / libc /
/// HOME / 内核 current 指纹。
///
/// 旧版是 10 字段，多出的三个（预置运行时 java 路径 / 预置运行时版本首行 /
/// runtime current 指纹）全是 JRE 部署链的输入，随该链删除。字段数变少必须与
/// [`parse_detect`] 的下标、以及它的 `parts.len()` 下限**同步改**：两边不一致的后果是
/// 错位解析——例如把 HOME 当成指纹，而它是静默的（不报错，只是路径全错）。
///
/// 版本首行原样回传、由 Rust 侧 [`parse_java_version_line`] 解析（单一解析器，
/// 可单测；不在远端 shell 里 sed——每种 JVM 的输出格式差异收在一处）。
pub fn detect_script() -> String {
    const SEP: &str = "\u{1f}";
    format!(
        "jv=''; if command -v java >/dev/null 2>&1; then jv=$(java -version 2>&1 | grep -v '^Picked up' | head -1); fi; \
         lc=$(set -- $(getconf GNU_LIBC_VERSION 2>/dev/null); printf '%s' \"$2\"); \
         if [ -z \"$lc\" ]; then if ldd --version 2>&1 | head -1 | grep -qi musl; then lc=musl; fi; fi; \
         printf '%s' \"$(uname -s)\" '{S}' \"$(uname -m)\" '{S}' \"$(command -v java || true)\" '{S}' \"$jv\" '{S}' \"$lc\" '{S}' \"$HOME\" '{S}' \"$(cat ~/.gwork/remote/current/fingerprint 2>/dev/null || true)\" | head -c 8192",
        S = SEP
    )
}

/// 解析 detect 输出（纯函数，单测覆盖；通道层只负责把 stdout 拿回来）。
pub fn parse_detect(stdout: &str) -> Result<RemoteEnv> {
    const SEP: &str = "\u{1f}";
    const FIELDS: usize = 7;
    let parts: Vec<&str> = stdout.split(SEP).collect();
    if parts.len() < FIELDS {
        // 【codereview 2026-10-09 P1】错误信息里的输出预览必须按字符取尾：
        // 字节切片 [..min(200)] 会在多字节字符（中文/GBK 解码产物）中间劈开
        // → panic（slice index not at char boundary），把「格式异常」升级成
        // 桌面进程崩溃。与 mod.rs tail_chars 同口径。
        return Err(anyhow!(
            "detect 输出格式异常（{} 段，期望 {}）: {}",
            parts.len(),
            FIELDS,
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
        home: parts[5].trim().to_string(),
        current_fingerprint: opt(parts[6]),
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

/// 远端系统 java 是否可直接用。
///
/// **唯一消费者是 Java-flavor 预装门禁**（[`KernelFlavor::Java`]：那个 `gwork`
/// wrapper 本体是 `exec java -jar …`，确实需要可用 JVM）。内核部署路径不读它。
pub fn java_usable(env: &RemoteEnv) -> bool {
    env.java.is_some() && env.java_major.map(|m| m >= MIN_JAVA_MAJOR).unwrap_or(false)
}

// ─── 【已删除】JRE 运行时解析链与 libc 门禁 ───────────────────────────────
//
// 这里曾经有五级 JRE 解析链（L0 系统 java → L3a 预置运行时 → L3b 用户离线包
// → L1 安装包内置 jlink 资产 → L4 Adoptium 自装）以及两个 glibc 门禁
// （`libc_gate` / `kernel_libc_gate`）。全部删除，理由如下——**别把它们加回来**：
//
// 1. 本壳部署的内核是 **musl 静态二进制**（CI 目标
//    `x86_64-unknown-linux-musl` / `aarch64-unknown-linux-musl`），不链接任何
//    远端 libc，也不需要 JVM。远端**零先决条件**：有 POSIX shell + tar 即可。
// 2. 旧门禁不仅无用，还会**主动弄坏连接**：musl 门禁会拒绝 Alpine 远端，而静态
//    musl 二进制在 Alpine 上恰恰跑得最好；glibc 门禁的下限（2.17）是按 gnu 产物
//    估的，实际取决于构建机 glibc 版本，写在代码里就是**与真实产物不符的声明**。
// 3. L1 资产（`extraResources/runtimes/runtime-linux-<arch>.tar.gz`）在本壳里
//    从不存在（build.rs 明写「no JRE, no jar」），所以远端无 Java 时必然走到 L4
//    去下载一个没人用的 JRE，无网远端直接报「远端无 Java 且平台不支持自动安装」。
//
// 真机实测得到的知识没有丢：WSL2 的 IPv4/IPv6 四组对照表保留在
// [`preinstalled_start_command`] 的 Java 分支（那里仍设 preferIPv4Stack）。

/// 探测远端环境。任何一步 shell 失败都返回带 cmd_hint 的错误。
/// P2/P3 起通道泛化：SSH 与 WSL 同一探测脚本（RemoteEnv 语义两通道一致）。
pub async fn detect(session: &dyn ExecChannel) -> Result<RemoteEnv> {
    let res = session.exec(&detect_script()).await?;
    let res = res.ok_or_error("detect (uname/java/libc/home/fingerprint)")?;
    parse_detect(&res.stdout)
}

/// 部署物本地指纹：字节 SHA-256 前 16 hex（目录名 + 比对用）。
pub fn fingerprint_of(kernel_bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(kernel_bytes);
    let out = h.finalize();
    hex::encode(&out[..8]) // 16 hex 字符
}

/// 远端安装根（家目录下）：`~/.gwork/remote`
pub fn remote_install_root(env: &RemoteEnv) -> String {
    format!("{}/.gwork/remote", trim_trailing_slash(&env.home))
}

/// 部署一次：上传 tar.gz → 解包到版本目录 → 原子切换 current。
///
/// `tar_bytes` 由调用方打包（含 gwork 内核二进制）。
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
    )
    .await
}

/// 版本化目录部署：上传 tar.gz → 解包 → 验收 → 写指纹 → 原子切 current。
///
/// 部署物只有内核二进制一种，故不再需要「布局归一」：旧版那段
/// `find */bin/java` 上移两级的逻辑是为 jlink/Temurin 的**多层目录**运行时包
/// 服务的，而内核包是单文件 tar（[`super::build_deploy_tar`]），顶层就是那个文件。
///
/// 【为何不再按种类分叉】旧版这里有个 `DeployKind{Kernel,Runtime}` 参数，因为
/// 两种包的验收判据不同（codereview P0-1：内核包用 `bin/java` 门禁验收会 100%
/// 报 NO_JAVA_IN_TAR）。JRE 部署链删除后只剩一种部署物，枚举退化成单变体——
/// 留着它只会让下一个读者以为还有第二种包。验收脚本见 [`deploy_script`]。
async fn deploy_archive(
    exec_ch: &dyn ExecChannel,
    base: &str,
    fingerprint: &str,
    tar_bytes: Vec<u8>,
    uploader: &dyn DeployUploader,
    progress: &mut (dyn FnMut(u64, u64) + Send),
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
    let deploy_res = deploy_archive_locked(exec_ch, base, fingerprint, tar_bytes, uploader, progress, &version_dir, &staging, &realroot, &lock_dir).await;
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

    // 3. 解包 + 验收 + 写指纹 + 原子切换 current（单条 shell 保证原子性）
    //    - rm -rf staging 后 mkdir：残留清理
    //    - tar 解包（gzip）
    //    - 验收：内核二进制存在且补可执行位（见 deploy_script）
    //    - 写 fingerprint 文件（detect 经 current/fingerprint 读回做跳过比对）
    //    - mv 版本目录就位 + current 切换（可移植链，见 switch_current 注释）
    //    - 清理 tar 包与锁目录
    let switch_res = {
        let switch_cmd = deploy_script(staging, realroot, &tar_remote, version_dir, fingerprint);
        exec_ch.exec(&switch_cmd).await
    };
    let switch_res = switch_res?;
    if switch_res.exit_code != 0 && switch_res.stdout.contains("NO_KERNEL_IN_TAR") {
        return Err(anyhow!(
            "部署包内未找到 {} 内核二进制——部署物损坏或打包链异常",
            KERNEL_BIN
        ));
    }
    switch_res.ok_or_error("deploy (tar/extract/verify/mv)")?;

    switch_current(exec_ch, base, version_dir, lock_dir).await?;
    let _ = exec_ch.exec(&format!("rm -f {}", sh(&tar_remote))).await;

    Ok(())
}

/// 解包+验收+写指纹的远端脚本（纯函数，单测覆盖）。
///
/// 验收分**早判**与**尾判**两道，顺序不可颠倒：
/// - 早判 `[ -f staging/gwork ]`：坏包必须在 `mv staging → version_dir` **之前**
///   拦下。若先 mv 再报错，就会留下一个垃圾版本目录（变异验证 M7 只删早判、
///   尾判仍抓得住——存在性断言区分不了，**顺序**才能区分）。
/// - `chmod +x`：tar 跨平台常丢可执行位。丢了就是「部署成功但启动 permission
///   denied」，而那个失败的表现是 180s 探活超时，根因完全不可见。
/// - 尾判 `[ -x version_dir/gwork ]`：chmod 带 `|| true`，失败时靠这道拦下。
///
/// 旧版这里按 `DeployKind` 分叉（Runtime 验收 `bin/java` + 多层目录归一）。
/// JRE 链删除后只剩内核一种部署物，分叉已无意义——但**别把 Runtime 分支加回来**：
/// 内核包里没有 `bin/java`，用那个门禁验收会 100% 报 NO_JAVA_IN_TAR（这正是
/// codereview P0-1 当年抓到的事故，而全量测试当时全绿，因为 Mock 不模拟 shell 语义）。
fn deploy_script(
    staging: &str,
    realroot: &str,
    tar_remote: &str,
    version_dir: &str,
    fingerprint: &str,
) -> String {
    let accept = format!(
        "[ -f {staging}/{bin} ] || {{ echo NO_KERNEL_IN_TAR; exit 8; }}; \
         rm -rf {version_dir}; mv {staging} {version_dir}; rm -f {realroot}; \
         chmod +x {version_dir}/{bin} 2>/dev/null || true; \
         [ -x {version_dir}/{bin} ] || {{ echo NO_KERNEL_IN_TAR; exit 8; }};",
        staging = sh(staging),
        version_dir = sh(version_dir),
        realroot = sh(realroot),
        bin = KERNEL_BIN,
    );
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
/// ## 与 Java 内核启动命令的差异（每一条都有具体原因）
///
/// - **没有 JVM 参数**：Rust 内核是单个静态二进制，无堆/元空间/代码缓存可调，
///   也不需要 `-Djava.net.preferIPv4Stack=true`——内核自己就绑
///   `SocketAddr::from(([127,0,0,1], port))`（cli/src/main.rs 的 serve 分支），
///   从不走 IPv6 通配 bind。WSL2 localhostForwarding 的那个 P0（四组对照实测
///   见下方历史注释）在 Rust 内核上**结构上不存在**。
/// - **`--home $HOME/.gwork-remote`** 而非 `-Dgwork.home=…`：Rust 侧的语义是
///   「harness base」，全局区 = `<base>/.gwork`（`Settings::gwork_home()`）。所以
///   这里传的是父目录，实际全局区落在 `$HOME/.gwork-remote/.gwork`——与
///   `attach_remote_diagnostics` 里读的日志路径逐字一致。远端全局区独立于
///   预装 CLI 自己的 `~/.gwork`，会话/凭证互不污染。
/// - **`GWORK_REMOTE_DEPLOYED=1`** 而非 `-Dgwork.remote=true`：开启 overlay 写入
///   与「镜像拒绝落盘」。没有它，远端内核会拒绝桌面端的模型镜像 → 镜像屏障
///   fail-closed → 连接直接失败（这是设计意图：宁可连不上，也不要「连上了但
///   远端在用空模型表跑」）。
/// - **凭据仍经 `GWORK_WEB_AUTH` 环境变量**（P1-3 修复沿用）：命令行参数在远端
///   `ps -ef` 下对同机所有用户可见；环境变量仅 `/proc/PID/environ`（属主可读）。
///   Rust 侧 `guard::BasicAuth::from_env` 消费同一个变量名。
/// - **`RUST_LOG`**：远端日志默认只到 info；启动失败时 `server.log` 里需要有
///   内核自己的错误行，否则只剩 shell 的重定向空文件。
pub fn backend_start_command(
    env: &RemoteEnv,
    root: &str,
    port: u16,
    auth_user: &str,
    auth_pass: &str,
) -> Result<String> {
    let bin = remote_kernel_bin(root);
    let home_remote = format!("{}/.gwork-remote", trim_trailing_slash(&env.home));

    Ok(format!(
        "mkdir -p {home_remote}; \
         GWORK_WEB_AUTH={auth} GWORK_REMOTE_DEPLOYED=1 RUST_LOG={log} \
             nohup {bin} web {port} --home {home_remote} --remote-deployed \
             > {log_file} 2>&1 & \
         sleep 1; echo $!",
        auth = sh(&format!("{}:{}", auth_user, auth_pass)),
        bin = sh(&bin),
        home_remote = sh(&home_remote),
        port = port,
        log = sh("gourd_work_core=info"),
        log_file = sh(&format!("{}/server.log", home_remote)),
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

/// 远端预装 `gwork` 的内核种类。
///
/// ## 为何必须区分
///
/// 两个内核的安装器都把可执行文件命名为 `gwork`：
/// - **Rust**：CI 产出的单个二进制（`cargo build -p gourd-work-cli`）；
/// - **Java**：`gourd-ai-agent/release/install.sh` 写的 shell wrapper，本体是
///   `exec java "${JAVA_OPTS[@]}" -jar "$SCRIPT_DIR/gourd-ai-agent.jar" "$@"`。
///
/// 两者的启动参数**互不相容**：Rust 认 `--home DIR` / `--remote-deployed`，
/// Java 认 `-Dgwork.home=` / `-Dgwork.remote=true`（经 JAVA_TOOL_OPTIONS 注入）。
/// 把 Rust 的参数传给 Java wrapper，`$@` 会原样落到 JVM 主类上：Java 侧不认
/// `--home`，于是远端内核**静默地**用错全局区、且不开远端模式（overlay 被拒
/// → 镜像屏障 fail-closed → 连接失败，而错误消息指向镜像而不是参数）。
///
/// 这不是理论风险：在本壳（Rust 内核进程内嵌、安装包不带 jar）里，预装模式
/// 曾是**唯一能跑通的远端路径**——SSH 部署链要读 `resources/gourd-ai-agent.jar`，
/// 而本壳根本没有那个文件。所以「远端装的是 Java gwork」是真实存量场景。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KernelFlavor {
    /// Rust 原生内核（本壳部署的形态）。
    Rust,
    /// Java 内核的 `gwork` wrapper（install.sh 产物）。
    Java,
}

/// 从 `gwork --version` 的输出判定内核种类（纯函数，单测锁口径）。
///
/// 判据是**输出形态**而不是「有没有 java」：
/// - Rust `version_text()` → `gwork 0.3.0`（小写程序名 + 裸 semver，无 `v` 前缀）；
/// - Java `Configurator` → `Solon.cfg().appTitle() + " " + AgentFlags.getVersion()`
///   → `GWork v0.2.3`（大写品牌名 + `v` 前缀）。
///
/// 两个差异都是各自代码里写死的，不是巧合：Rust 侧有
/// `version_text_reports_the_workspace_version_with_no_suffix` 钉住「无后缀裸 semver」，
/// Java 侧 `getVersion()` 返回带 `v` 的字面量。
///
/// 判不出形态时返回 **Java**：那是保守侧。误判成 Rust 会把不认的参数传进 JVM
/// （静默错全局区）；误判成 Java 则注入 `-D` 系统属性，Rust 内核忽略未知环境变量
/// 与参数，最坏是「远端模式没开」→ overlay 被拒 → 连接失败并给出明确原因。
/// 失败得响亮比错得安静好。
pub fn parse_kernel_flavor(version_output: &str) -> KernelFlavor {
    let line = version_output.trim();
    // Rust：`gwork <major>.<minor>.<patch>`，程序名小写、版本号无 v 前缀。
    if let Some(rest) = line.strip_prefix("gwork ") {
        let token = rest.trim();
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() == 3
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        {
            return KernelFlavor::Rust;
        }
    }
    KernelFlavor::Java
}

/// 探测远端预装 gwork CLI：返回 (gwork 路径, 版本串, 内核种类)。无则 None。
///
/// 版本取 `gwork --version` 的输出（Rust CLI 的 `version_text()` → "gwork 0.3.0"）。
///
/// **必须是 `--version` 而不是 `version`**：Rust CLI 只把 `--help`/`-h`/`--version`/`-V`
/// 当作早退标志（`early_exit`），裸词 `version` 会落进「一次性任务」分支——于是探测
/// 命令会去连模型跑一个名为 "version" 的任务：没配模型时打印 "No model configured"
/// 并 exit 1（探测误判为「未预装」，白走一遍完整部署链），配了模型时更糟——真的
/// 发起一次 LLM 调用，探测要等几十秒还可能产生费用。Java 内核的 `version` 子命令
/// 形态在这里不适用。
pub async fn detect_preinstalled(
    session: &dyn ExecChannel,
) -> Result<Option<(String, String, KernelFlavor)>> {
    let res = session
        .exec("g=$(command -v gwork 2>/dev/null || true); if [ -n \"$g\" ]; then echo \"$g\"; $g --version 2>/dev/null | tail -1; else echo ''; echo ''; fi")
        .await?;
    if res.exit_code != 0 {
        return Ok(None);
    }
    let mut lines = res.stdout.lines().filter(|l| !l.trim().is_empty());
    let (Some(path), Some(version)) = (lines.next(), lines.next()) else {
        return Ok(None);
    };
    let version = version.trim().to_string();
    let flavor = parse_kernel_flavor(&version);
    Ok(Some((path.trim().to_string(), version, flavor)))
}

/// 预装版与桌面端版本是否一致（纯函数，单测锁口径）。
///
/// `gwork --version` 输出形如 `gwork 0.3.0`（`version_text()`），但远端可能是
/// 旧 Java 内核的 wrapper（输出 `GWork v0.2.3`）或用户自己包的脚本，所以不能
/// 假设格式：取串里第一个 `major.minor.patch` 形态的 token 与本地比。提不到
/// 版本号时返回 false（宁可提示「可能不一致」也不要谎报一致）。
pub fn preinstalled_version_matches(remote_version: &str, local_version: &str) -> bool {
    fn semver_token(s: &str) -> Option<String> {
        s.split(|c: char| !c.is_ascii_digit() && c != '.')
            .find(|t| {
                let parts: Vec<&str> = t.split('.').collect();
                parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
            })
            .map(|t| t.to_string())
    }
    match (semver_token(remote_version), semver_token(local_version)) {
        (Some(r), Some(l)) => r == l,
        _ => false,
    }
}

/// CLI 预装模式的启动命令：复用远端已装的 gwork（install.sh 产物或用户自行放置）。
///
/// 凭据走 **GWORK_WEB_AUTH 环境变量**（两个内核同一个变量名），不走命令行参数：
/// 命令行参数在远端 `ps -ef` 下对同机所有用户可见，环境变量仅 `/proc/PID/environ`
/// （属主可读）。Rust 侧 `guard::BasicAuth::from_env` 与 Java 侧 `AgentFlags` 都按
/// env 优先消费。
///
/// 远端标记与全局区则**按内核种类分叉**（见 [`KernelFlavor`]）：Rust 用
/// `GWORK_REMOTE_DEPLOYED=1` + `--home`/`--remote-deployed`，Java 用
/// `JAVA_TOOL_OPTIONS` 注入 `-Dgwork.home=`/`-Dgwork.remote=true`。传错一侧的后果是
/// 静默的（远端用错全局区、overlay 被拒），故种类判定必须有直接测试。
///
/// 与部署模式（[`backend_start_command`]）的语义必须齐：远端全局区独立
/// （`$HOME/.gwork-remote`，预装 CLI 自己的 `~/.gwork` 不动）、`web <port>`、
/// 日志落远端全局区。两模式命令不齐正是历史上「部署模式漏 mkdir -p → 首连必死」
/// 的成因。
///
/// PID 回传沿用旧版的 pidfile 两段式（`echo $! > f; sleep 1; cat f`）。它**不是**
/// 必需的：`nohup` 与 `env` 都是 exec 语义，`$!` 拿到的就是 gwork 本身的 PID，
/// 且 stdout/stderr 已重定向到日志，不会污染 exec 通道。保留它的唯一理由是
/// `sleep 1`：WSL 通道下 wsl.exe 会话退出时后台子进程存在被清理的竞态（社区
/// 验证 sleep 1 后稳定，见 [`backend_start_command`] 同一条锁定），而部署模式
/// 靠同一句 `sleep 1; echo $!` 达成。两模式在「缓冲一拍再回 PID」上必须一致。
pub fn preinstalled_start_command(
    env: &RemoteEnv,
    port: u16,
    auth_user: &str,
    auth_pass: &str,
    flavor: KernelFlavor,
) -> String {
    let home = trim_trailing_slash(&env.home);
    let home_remote = format!("{}/.gwork-remote", home);
    let auth = sh(&format!("{}:{}", auth_user, auth_pass));
    let log_file = sh(&format!("{}/server.log", home_remote));
    let pidfile = sh(&format!("{}/server.pid", home_remote));

    match flavor {
        KernelFlavor::Rust => format!(
            "mkdir -p {home_r}; \
             nohup env GWORK_WEB_AUTH={auth} GWORK_REMOTE_DEPLOYED=1 RUST_LOG={log} \
                 gwork web {port} --home {home_r} --remote-deployed \
                 > {log_file} 2>&1 & \
             echo $! > {pidfile}; sleep 1; cat {pidfile}",
            home_r = sh(&home_remote),
            auth = auth,
            log = sh("gourd_work_core=info"),
            port = port,
            log_file = log_file,
            pidfile = pidfile,
        ),
        // Java wrapper：参数必须是 `-D` 系统属性，经 JAVA_TOOL_OPTIONS 注入
        // （wrapper 本体是 `exec java "${JAVA_OPTS[@]}" -jar … "$@"`，环境变量对
        // exec 语义透明）。凭据**不在**这里：它走 GWORK_WEB_AUTH，与 Rust 分支同一个
        // 变量名（Java 侧 AgentFlags 也按 env 优先消费），所以 JAVA_TOOL_OPTIONS 里
        // 只有非敏感标志——"Picked up JAVA_TOOL_OPTIONS: …" 那行日志不会带凭据。
        //
        // ## `-Djava.net.preferIPv4Stack=true` 为何必须保留（WSL 数据面 P0）
        //
        // 2026-10-14 真机四组对照定案。不加此参数时 WSL 通道 100% 连不上——
        // 后端进程活着、日志正常，向导却卡满 180s 报「远端后端未就绪」。
        // 根因是**两件事叠加**，缺一不可：
        //
        // ① JVM 在 Linux 上的通配 bind（`new InetSocketAddress(port)`）走 AF_INET6：
        //    `net.ipv6.bindv6only=0` 下实际监听 IPv6 通配 `*:port`，`ss -4 -lntp`
        //    查无 IPv4 监听，只有 `ss -6` 看得到。**与 /etc/hosts 无关**——实测 WSL
        //    生成的 hosts 里 `localhost` 映射的是 `127.0.0.1`，`::1` 那行映射的是
        //    `ip6-localhost ip6-loopback`；JVM 里 `getAllByName("localhost")` 返回的
        //    也是 `127.0.0.1`。（早期注释误写成「hosts 把 localhost 解析成 ::1
        //    导致绑 IPv6」，方向错了：绑 IPv6 是 socket 族选择，不是名字解析结果。）
        //
        // ② WSL2 的 localhostForwarding **按地址族分别建立转发**，且只为「与监听族
        //    匹配」的回环地址建 relay。四组对照实测（Windows 侧 netstat + HTTP 探测）：
        //
        //    | JVM bind 形态                        | Windows relay    | 127.0.0.1 | [::1] |
        //    |--------------------------------------|------------------|-----------|-------|
        //    | A 通配，默认双栈 `[::]:p`            | 仅 `[::1]:p`     | REFUSED   | 200   |
        //    | B 通配，preferIPv4Stack `0.0.0.0:p`  | 仅 `127.0.0.1:p` | **200**   | REFUSED |
        //    | C bind `localhost` + preferIPv4Stack | 仅 `127.0.0.1:p` | 200       | REFUSED |
        //    | D bind `localhost`，默认双栈         | **无**           | REFUSED   | REFUSED |
        //
        //    即：JVM 用 IPv6 socket 监听 → Windows 侧只有 `[::1]` 通；而本项目数据面
        //    （就绪探活 / 健康探活 / 镜像推送 / 本地反代）**全部硬编码 `127.0.0.1`**。
        //
        // D 组是「为何不能改用显式 bind localhost 绕过」的答案：双栈下 JVM 仍用
        // AF_INET6 socket，`localhost` 被绑成 IPv4-mapped IPv6 地址
        // `[::ffff:127.0.0.1]:p`——localhostForwarding 对这种形态**两个族都不建
        // relay**，比 A 组更糟（A 至少 `[::1]` 可达）。所以「只改 bind 地址」无效，
        // 必须从 socket 族下手（即本参数）。加此参数后 JVM 只绑 IPv4 `0.0.0.0:port`，
        // Windows 侧 `127.0.0.1:port` 即可达（B 组实测 HTTP 200）。SSH 通道同命令体
        // 一并受益、无副作用：远端后端本就只服务回环；且 SSH 数据面走
        // direct-tcpip（远端视角），不依赖 localhostForwarding，原本就不受影响。
        //
        // **Rust 分支不需要这个参数**：内核自己绑 `SocketAddr::from(([127,0,0,1],
        // port))`（cli/src/main.rs 的 serve 分支），从不走 IPv6 通配 bind，所以
        // 这个 P0 在 Rust 内核上结构上不存在。别把本行「补齐」到 Rust 分支。
        KernelFlavor::Java => format!(
            "mkdir -p {home_r}; \
             nohup env GWORK_WEB_AUTH={auth} JAVA_TOOL_OPTIONS={tool_opts} \
                 gwork web {port} \
                 > {log_file} 2>&1 & \
             echo $! > {pidfile}; sleep 1; cat {pidfile}",
            home_r = sh(&home_remote),
            auth = auth,
            tool_opts = sh(&format!(
                "-Dgwork.home={} -Dgwork.remote=true -Djava.net.preferIPv4Stack=true",
                home_remote
            )),
            port = port,
            log_file = log_file,
            pidfile = pidfile,
        ),
    }
    }

/// 预装模式的停止命令：与部署模式同构（PID 由启动命令回传）。
pub fn preinstalled_stop_command(pid: u32) -> String {
    backend_stop_command(pid)
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
            current_fingerprint: None,
            home: "/home/dev".into(),
        };
        assert_eq!(remote_install_root(&env), "/home/dev/.gwork/remote");
        // 家目录带尾斜杠也收敛
        let env2 = RemoteEnv { home: "/home/dev/".into(), ..env };
        assert_eq!(remote_install_root(&env2), "/home/dev/.gwork/remote");
    }

    #[test]
    fn start_command_carries_required_flags() {
        let env = env_for_test();
        let cmd = backend_start_command(&env, "/home/dev/.gwork/remote", 18080, "u", "p").unwrap();
        // 远端独立全局区。Rust 侧 `--home` 的语义是 harness base（全局区 =
        // `<base>/.gwork`），所以传的是父目录，实际落在 .gwork-remote/.gwork。
        // 路径不带引号是 `shell_quote` 对安全字符集的正常输出（保留远端日志可读性），
        // 故断言不带引号的形态；凭据含 `:` 不在安全集里，仍必须被引号包裹。
        assert!(
            cmd.contains("--home /home/dev/.gwork-remote"),
            "必须经 --home 指定远端独立全局区: {}",
            cmd
        );
        // 【e2e 真机 P0 回归（2026-10-09）】启动命令必须自建全局区目录：日志重定向
        // 目标 ~/.gwork-remote/server.log 依赖目录存在，首连必缺 → shell 重定向
        // 立即失败后端瞬死（echo $! 仍回 PID 假成功 → 60s 探活超时）。
        // preinstalled 模式有 mkdir -p 而部署模式曾漏（两模式命令不齐）。
        assert!(
            cmd.contains("mkdir -p /home/dev/.gwork-remote"),
            "启动命令必须先建全局区（日志重定向依赖）: {}",
            cmd
        );
        // 远端模式标记：没有它，远端内核会拒绝 overlay → 镜像屏障 fail-closed →
        // 连接直接失败。环境变量与命令行标志双写（env 供 serve_with_static 读，
        // 标志供 CLI 读），两者任一生效即可，但必须都在——少一个就有一条启动
        // 路径（例如用户手敲命令）静默退化成非远端模式。
        assert!(cmd.contains("GWORK_REMOTE_DEPLOYED=1"), "{}", cmd);
        assert!(cmd.contains("--remote-deployed"), "{}", cmd);
        // 凭据经 GWORK_WEB_AUTH 环境变量（P1-3 修复：不进命令行，ps -ef 不可见）
        assert!(cmd.contains("GWORK_WEB_AUTH='u:p'"), "凭据必须经环境变量注入: {}", cmd);
        assert!(!cmd.contains("-Dgwork.web.auth="), "凭据不得出现在命令行参数里（ps 泄漏面）");
        // web 子命令 + 端口（Rust CLI 的 serve_mode 解析形态）
        assert!(cmd.contains("web 18080"), "{}", cmd);
        // 内核二进制走 current 软链（版本化安装根）
        assert!(
            cmd.contains("current/gwork"),
            "必须启动版本化安装根下的内核二进制: {}",
            cmd
        );
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
        assert!(cmd.contains("server.log"), "日志必须落远端全局区: {}", cmd);
    }

    /// 内核启动命令**不得**依赖 JVM。
    ///
    /// 这条是「Rust 内核不需要运行时」的结构护栏：旧实现第一行就
    /// `env.java.ok_or_else(...)?`，于是远端没装 Java 时连接直接失败——而本壳部署的
    /// 是静态二进制，那个失败毫无道理。把它钉成测试，防止运行时解析链被重新接回
    /// 内核启动路径（那会让「远端无 Java」重新变成连不上的原因）。
    #[test]
    fn start_command_needs_no_jvm() {
        let env = RemoteEnv {
            java: None,
            java_major: None,
            ..env_for_test()
        };
        let cmd = backend_start_command(&env, "/r", 1, "u", "p")
            .expect("内核是静态二进制，无 Java 也必须能组装启动命令");
        for banned in ["java", "-jar", "-Xmx", "preferIPv4Stack", "JAVA_TOOL_OPTIONS"] {
            assert!(
                !cmd.contains(banned),
                "内核启动命令不得含 JVM 痕迹 `{}`: {}",
                banned,
                cmd
            );
        }
    }

    /// 两个启动模式必须在关键语义上齐（历史上「部署模式漏 mkdir -p」就是分叉造成的）。
    #[test]
    fn both_start_modes_agree_on_the_load_bearing_parts() {
        let env = env_for_test();
        let deployed = backend_start_command(&env, "/home/dev/.gwork/remote", 18080, "u", "p").unwrap();
        let preinstalled = preinstalled_start_command(&env, 18080, "u", "p", KernelFlavor::Rust);
        for needle in [
            "mkdir -p",
            ".gwork-remote",
            "GWORK_WEB_AUTH='u:p'",
            "GWORK_REMOTE_DEPLOYED=1",
            "--remote-deployed",
            "web 18080",
            "server.log",
            "2>&1",
        ] {
            assert!(deployed.contains(needle), "部署模式缺 `{}`: {}", needle, deployed);
            assert!(preinstalled.contains(needle), "预装模式缺 `{}`: {}", needle, preinstalled);
        }
        // 预装模式跑的是 PATH 上的 gwork，不是版本化安装根里的那份
        assert!(preinstalled.contains("gwork web"), "{}", preinstalled);
        assert!(!preinstalled.contains("current/gwork"), "{}", preinstalled);
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
            current_fingerprint: None,
            home: "/home/dev".into(),
        }
    }

    #[test]
    fn preinstalled_start_injects_via_environment_only() {
        let cmd = preinstalled_start_command(&env_for_test(), 18081, "u", "p", KernelFlavor::Rust);
        // 凭据经 GWORK_WEB_AUTH 环境变量（P1-3 修复：命令行参数在 ps -ef 下对同机
        // 所有用户可见）
        assert!(cmd.contains("GWORK_WEB_AUTH='u:p'"), "凭据必须走环境变量: {}", cmd);
        assert!(!cmd.contains("-Dgwork.web.auth="), "凭据不得出现在命令行参数（ps 泄漏面）");
        // 远端标记：环境变量 + 命令行标志双写（与部署模式同口径）
        assert!(cmd.contains("GWORK_REMOTE_DEPLOYED=1"), "{}", cmd);
        assert!(cmd.contains("--remote-deployed"), "{}", cmd);
        // 独立全局区经 --home（Rust 侧语义是 harness base）
        assert!(cmd.contains("--home /home/dev/.gwork-remote"), "{}", cmd);
        // gwork 本体 + web 子命令 + 端口
        assert!(cmd.contains("gwork web 18081"), "{}", cmd);
        // PID 回传两段式 + sleep 1 缓冲（WSL 会话清理竞态，与部署模式齐）
        assert!(cmd.contains("echo $! >"), "{}", cmd);
        assert!(cmd.contains("cat "), "{}", cmd);
        assert!(cmd.contains("sleep 1"), "{}", cmd);
        // 日志落远端全局区（诊断启动失败）
        assert!(cmd.contains("server.log"), "{}", cmd);
    }

    /// Rust 预装不得注入 JVM 专属变量。
    ///
    /// `JAVA_TOOL_OPTIONS` 对 Rust 内核不只是无用：JVM 会把它的内容以
    /// "Picked up …" 整行写进 nohup 日志。旧实现把凭据放在里面，于是凭据明文
    /// 永久残留在远端磁盘的 server.log——这是 P1-3 修过的泄漏面，不得随
    /// 「反正 Rust 不读它」而复活。
    #[test]
    fn rust_preinstalled_start_carries_no_jvm_injection() {
        let cmd = preinstalled_start_command(&env_for_test(), 1, "u", "p", KernelFlavor::Rust);
        for banned in ["JAVA_TOOL_OPTIONS", "-Dgwork.", "preferIPv4Stack", "-jar"] {
            assert!(!cmd.contains(banned), "不得含 JVM 注入痕迹 `{}`: {}", banned, cmd);
        }
    }

    /// Java 预装**必须**注入 `-D` 系统属性，且凭据不得混进去。
    ///
    /// 这是两个内核共存的关键分叉：Java wrapper 是 `exec java … "$@"`，它不认
    /// `--home`/`--remote-deployed`。若把 Rust 的参数传给它，远端会**静默地**用错
    /// 全局区且不开远端模式（overlay 被拒 → 镜像屏障 fail-closed → 连接失败，
    /// 而错误消息指向镜像而不是参数）。在本壳里预装模式曾是唯一能跑通的远端
    /// 路径，所以这条分叉必须有直接断言。
    #[test]
    fn java_preinstalled_start_injects_system_properties() {
        let cmd = preinstalled_start_command(&env_for_test(), 18082, "u", "p", KernelFlavor::Java);
        assert!(cmd.contains("JAVA_TOOL_OPTIONS="), "{}", cmd);
        assert!(cmd.contains("-Dgwork.home=/home/dev/.gwork-remote"), "{}", cmd);
        assert!(cmd.contains("-Dgwork.remote=true"), "{}", cmd);
        // WSL2 双栈 P0：JVM 通配 bind 走 AF_INET6 → Windows 侧 127.0.0.1 不可达。
        // Rust 分支不需要（内核自己绑 127.0.0.1），Java 分支必须保留。
        assert!(cmd.contains("-Djava.net.preferIPv4Stack=true"), "{}", cmd);
        assert!(cmd.contains("gwork web 18082"), "{}", cmd);
        // 凭据仍走 GWORK_WEB_AUTH，绝不进 JAVA_TOOL_OPTIONS（否则 "Picked up …"
        // 那行日志会把凭据明文永久写进远端 server.log）。
        assert!(cmd.contains("GWORK_WEB_AUTH='u:p'"), "{}", cmd);
        assert!(!cmd.contains("-Dgwork.web.auth="), "凭据不得进系统属性: {}", cmd);
        let tool_opts = cmd
            .split("JAVA_TOOL_OPTIONS=")
            .nth(1)
            .unwrap_or("")
            .split(" gwork web")
            .next()
            .unwrap_or("");
        assert!(!tool_opts.contains("u:p"), "JAVA_TOOL_OPTIONS 不得含凭据: {}", tool_opts);
        // Rust 专属标志不得出现在 Java 分支（传了也会被当成 JVM 主类参数）
        assert!(!cmd.contains("--remote-deployed"), "{}", cmd);
        assert!(!cmd.contains("GWORK_REMOTE_DEPLOYED"), "{}", cmd);
    }

    /// 两个分支必须在「与内核种类无关」的部分保持一致。
    #[test]
    fn both_preinstalled_flavors_share_the_common_parts() {
        let env = env_for_test();
        let rust = preinstalled_start_command(&env, 18083, "u", "p", KernelFlavor::Rust);
        let java = preinstalled_start_command(&env, 18083, "u", "p", KernelFlavor::Java);
        for needle in [
            "mkdir -p /home/dev/.gwork-remote",
            "GWORK_WEB_AUTH='u:p'",
            "gwork web 18083",
            "server.log",
            "server.pid",
            "2>&1",
            "sleep 1",
        ] {
            assert!(rust.contains(needle), "Rust 分支缺 `{}`: {}", needle, rust);
            assert!(java.contains(needle), "Java 分支缺 `{}`: {}", needle, java);
        }
    }

    /// 种类判定：两个内核的 `--version` 输出形态不同，且都是各自代码里写死的。
    ///
    /// 判错的后果不对称：误判成 Rust 会把不认的参数传进 JVM（静默错全局区）；
    /// 误判成 Java 则 Rust 内核忽略未知变量，最坏是连接失败并给出明确原因。
    /// 故未知形态必须归 Java（保守侧）。
    #[test]
    fn kernel_flavor_is_parsed_from_the_version_line() {
        // Rust：version_text() → "gwork <semver>"（小写、无 v 前缀）
        assert_eq!(parse_kernel_flavor("gwork 0.3.0"), KernelFlavor::Rust);
        assert_eq!(parse_kernel_flavor("gwork 1.2.3\n"), KernelFlavor::Rust);
        // Java：appTitle + " " + getVersion() → "GWork v0.2.3"
        assert_eq!(parse_kernel_flavor("GWork v0.2.3"), KernelFlavor::Java);
        assert_eq!(parse_kernel_flavor("Solon Code v0.2.3"), KernelFlavor::Java);
        // 保守侧：未知/空/畸形一律归 Java
        for unknown in ["", "   ", "gwork", "gwork 0.3", "gwork v0.3.0", "gwork 0.3.0-rc1", "command not found"] {
            assert_eq!(
                parse_kernel_flavor(unknown),
                KernelFlavor::Java,
                "未知形态 {:?} 必须归保守侧（Java）",
                unknown
            );
        }
    }

    /// 版本比对只对 Rust 预装有意义：Java 的 `v0.2.3` 与本壳的 `0.3.0` 是两套
    /// 独立编号，比了只会永远报「不一致」（噪声，不是信息）。
    #[test]
    fn version_comparison_ignores_the_v_prefix_and_junk() {
        assert!(preinstalled_version_matches("gwork 0.3.0", "0.3.0"));
        assert!(!preinstalled_version_matches("gwork 0.2.9", "0.3.0"));
        // 提不到版本号 → false（宁可提示「可能不一致」也不要谎报一致）
        assert!(!preinstalled_version_matches("", "0.3.0"));
        assert!(!preinstalled_version_matches("gwork", "0.3.0"));
    }

    #[test]
    fn preinstalled_start_quotes_credentials() {
        // 凭据含空格/特殊字符时必须被 shell_quote 包裹（随机密码含任意字母数字
        // 不会命中，但畸形注入要防）。两个分支都要验：Java 分支的凭据同样进 env。
        for flavor in [KernelFlavor::Rust, KernelFlavor::Java] {
            let cmd = preinstalled_start_command(&env_for_test(), 1, "us er", "p;rm", flavor);
            assert!(cmd.contains("'us er:p;rm'"), "凭据必须整体被单引号包裹: {}", cmd);
        }
    }

    #[test]
    fn preinstalled_stop_reuses_kill_escalation() {
        let cmd = preinstalled_stop_command(999);
        assert!(cmd.contains("kill 999"));
        assert!(cmd.contains("kill -9 999"));
    }

    #[test]
    fn detect_preinstalled_script_shape() {
        // 源码扫描：探测命令必须同时拿路径与版本（command -v + gwork --version），
        // 且失败分支静默（echo ''）不报错——探测不到 gwork 是正常态不是错误
        let src = include_str!("deploy.rs");
        assert!(src.contains("command -v gwork"), "探测必须用 command -v");
        assert!(src.contains("$g --version"), "版本必须取 gwork --version 输出");
    }

    /// 探测必须用 `--version`，不得用裸词 `version`。
    ///
    /// 这不是风格问题：Rust CLI 只把 `--version`/`-V` 当早退标志，裸词 `version`
    /// 会落进「一次性任务」分支——探测于是变成一次真的 LLM 调用（没配模型时
    /// exit 1 被误判为「未预装」，白走一遍完整部署链；配了模型时要等几十秒还
    /// 可能产生费用）。锁住字面形态，防它被「简化」回去。
    #[test]
    fn detect_preinstalled_never_invokes_a_bare_version_subcommand() {
        let src = include_str!("deploy.rs");
        let body = src
            .split("pub async fn detect_preinstalled")
            .nth(1)
            .expect("detect_preinstalled 必须存在")
            .split("\n}\n")
            .next()
            .unwrap_or("");
        assert!(body.contains("--version"), "探测必须用 --version: {}", body);
        assert!(
            !body.contains("$g version"),
            "裸词 version 会被 Rust CLI 当成一次性任务（发起真 LLM 调用）: {}",
            body
        );
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
    fn detect_script_probes_version_and_libc() {
        let s = detect_script();
        // 版本：java -version 首行原样回传（Rust 侧单一解析器）；
        // Picked up 行先滤（JAVA_TOOL_OPTIONS 噪声，codereview P1-1）
        assert!(s.contains("java -version 2>&1 | grep -v '^Picked up' | head -1"), "{}", s);
        // libc：getconf 主路 + ldd musl 兜底。仍探测但**不参与任何门禁**
        // （静态 musl 内核零依赖），只用于诊断与日志。
        assert!(s.contains("getconf GNU_LIBC_VERSION"), "{}", s);
        assert!(s.contains("musl"), "{}", s);
        // 内核部署指纹（跳过上传的判据）
        assert!(s.contains(".gwork/remote/current/fingerprint"), "{}", s);
        // 7 字段 → 分隔符 6 个。**必须与 parse_detect 的 FIELDS 同步**：
        // 两边不一致不会报错，只会错位解析（例如把 HOME 当成指纹）——静默的。
        assert_eq!(s.matches('\u{1f}').count(), 6, "{}", s);
        // 已删除的 JRE 探测不得残留：预置运行时扫描会让无 Java 的远端多跑
        // 三次 `[ -x ]`，而它服务的解析链已不存在。
        assert!(!s.contains("runtime/current/bin/java"), "JRE 探测残留: {}", s);
        assert!(!s.contains("/jre/"), "JRE 探测残留: {}", s);
    }

    #[test]
    fn parse_detect_seven_fields_roundtrip() {
        let sep = '\u{1f}';
        // 字段顺序必须与 detect_script 的 printf 逐字对应
        let stdout = format!(
            "Linux{0}x86_64{0}/usr/bin/java{0}openjdk version \"1.8.0_392\"{0}2.17{0}/home/dev{0}abc123",
            sep
        );
        let env = parse_detect(&stdout).unwrap();
        assert_eq!(env.platform, "Linux");
        assert_eq!(env.arch, "x86_64");
        assert_eq!(env.java.as_deref(), Some("/usr/bin/java"));
        assert_eq!(env.java_major, Some(8), "系统 java 是 8 → Java flavor 预装不可用");
        assert_eq!(env.libc.as_deref(), Some("2.17"));
        assert_eq!(env.home, "/home/dev");
        assert_eq!(env.current_fingerprint.as_deref(), Some("abc123"));
        // 尾部多一个分隔符（空字段）仍须解析成功：远端 shell 可能多输出一个空值，
        // 严格判等会让正常输出被拒。
        assert!(parse_detect(&format!("{}{}", stdout, sep)).is_ok());
        // 字段不足必须报错（不允许静默降级成空值，那会让 home 变空而部署路径全错）
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
        let anchor = "deploy_archive_locked(exec_ch, base, fingerprint, tar_bytes, uploader, progress, &version_dir".to_string();
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
        // 只剩 jv 一处：pjv（预置运行时版本）随 JRE 解析链一起删除了。
        // 计数而非存在性断言：两处都滤是本用例的原意，降成 1 后若又出现第二处
        // 版本探测而漏滤，存在性断言是抱不住的。
        assert_eq!(
            s.matches(&anchor).count(),
            1,
            "唯一的版本探测（jv）必须滤 Picked up: {}",
            s
        );
    }

    /// 内核二进制名是三处共用的契约（tar 条目名 / 远端验收 / 启动路径），
    /// 也必须与 CI 产物名、预装探测的 `command -v gwork` 一致。写错一个字符
    /// 的后果是「部署成功、启动 permission denied / not found」，表现为探活超时。
    #[test]
    fn kernel_binary_name_is_consistent_across_the_chain() {
        assert_eq!(KERNEL_BIN, "gwork");
        assert_eq!(remote_kernel_bin("/home/dev/.gwork/remote"), "/home/dev/.gwork/remote/current/gwork");
        // 尾斜杠收敛（与 remote_install_root 同口径）
        assert_eq!(remote_kernel_bin("/r/"), "/r/current/gwork");
        let cmd = backend_start_command(&env_for_test(), "/r", 1, "u", "p").unwrap();
        assert!(cmd.contains(&remote_kernel_bin("/r")), "{}", cmd);
    }

}
