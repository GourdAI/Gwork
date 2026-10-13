//! remote/ssh.rs —— russh 进程内 SSH 客户端（远程工作区 P1）。
//!
//! 对应方案《远程工作区方案.md》v1.2 §四·方案 A：桌面端通过 SSH 隧道访问远端
//! GWork 后端。三平台（Windows/macOS/Linux）同一代码路径，不依赖外部 ssh.exe。
//!
//! 职责边界（本文件只管传输层）：
//! 1. 连接与认证：password / private key（含口令解密）
//! 2. exec：远端 POSIX 命令执行（带 stdout/stderr 收集与退出码）
//! 3. 流式上传：`cat > path` 通道写入（部署 jar/tar.gz 用，避免依赖 SFTP 子系统）
//! 4. direct-tcpip：隧道通道（由 tunnel.rs 使用本模块暴露的 channel 工厂）
//!
//! 主机密钥校验：TOFU（Trust On First Use）——首连按「主机 + 密钥算法」记录指纹到
//! 本应用自己的 known_hosts（绝不写用户 ~/.ssh/known_hosts，那是 OpenSSH 的地盘；
//! 服务器可同时挂多把不同算法的密钥，KEX 协商用哪把由协商决定，故必须按算法
//! 分行记录，否则首连记 ED25519、重连协商到 RSA 就误报密钥变化）。
//! 同算法指纹变化 → 拒绝连接，错误信息携带算法 + 新旧指纹供用户比对（前端凭
//! 固定短语「主机密钥校验失败」识别并给出「忘记该主机」按钮）；换钥后的清库
//! 重连由 remote_forget_host 命令承载。首连自动信任，等价于
//! ssh -o StrictHostKeyChecking=accept-new，发布前再评估收紧。

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use russh::client::{self, Handle};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::ChannelMsg;

use super::known_hosts;

/// SSH 认证方式（凭据由前端传入、桌面端不落盘；持久化加密属 P4）。
#[derive(Debug, Clone)]
pub enum AuthMethod {
    Password { password: String },
    PrivateKey { key_path: String, passphrase: Option<String> },
}

/// 连接参数。
#[derive(Debug, Clone)]
pub struct SshTarget {
    pub host: String,
    pub port: u16,
    pub user: String,
}

/// 跳板机（P4 ProxyJump）：目标机不可直达时的中转。
#[derive(Debug, Clone)]
pub struct JumpHost {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
}

impl JumpHost {
    fn target(&self) -> SshTarget {
        SshTarget {
            host: self.host.clone(),
            port: self.port,
            user: self.user.clone(),
        }
    }
}

/// 已认证的 SSH 会话句柄。
///
/// `Handle` 内部是多路复用的（一个 TCP 连接跑任意多 channel），克隆语义为
/// 「同一连接的另一个控制入口」。 russh 0.54 的 `Handle` 未实现 `Clone`，
/// 故这里包一层 `Arc` 共享。
pub struct SshSession {
    handle: Arc<Handle<HostKeyHandler>>,
    /// 连接目标（host/port/user；徽标与日志展示用）
    pub target: SshTarget,
    /// P4 ProxyJump：跳板机会话句柄。直连为 None；有跳板机时必须保活到本会话
    /// drop（跳板机 handle 的 direct-tcpip channel 承载着本会话的全部流量）。
    pub jumped_from: Option<Arc<SshSession>>,
}

/// 部署上传闭包用的轻量句柄（拿 SshSession 的 Arc<Handle> 克隆）。
/// upload/exec 只依赖 handle，无需 target。
#[derive(Clone)]
pub struct SshSessionHandle {
    handle: Arc<Handle<HostKeyHandler>>,
}

impl SshSessionHandle {
    pub(crate) fn from(s: &SshSession) -> Self {
        Self { handle: s.handle.clone() }
    }

    /// 流式上传（部署链唯一上传入口，SshUploader 经此承载）。
    /// `progress(done, total)` 每块回调一次（字节级进度，向导日志可见）。
    ///
    /// 【分块多通道（2026-10-09 真机 e2e 抓出的停滞缺陷）】旧实现单 channel 写完
    /// 全部字节：真机 23MB 运行时包在单通道累计 ~12MB 处 data() 永久挂起
    /// （远端 cat 停止消费、文件停涨；磁盘/内存/进程均正常；而 ≤8MB 的单通道
    /// 探针全绿 @3.4MB/s）→ 尺寸阈值型单通道停滞，机制在 russh 内部（窗口/
    /// 队列），不在本仓可控范围。工程解法：按 6MB 分块、每块独立 channel
    /// （首块 `cat >` 截断、后续 `cat >>` 追加），单通道累计量恒低于探针验证
    /// 的 8MB 安全线；每块带超时（180s）使未来任何停滞快速失败而非挂死 15 分钟。
    /// 语义等价性：cat 顺序追加 = 单文件字节级一致（部署链 sha 指纹可比对）。
    pub async fn upload(
        &self,
        remote_path: &str,
        data: Vec<u8>,
        progress: &mut (dyn FnMut(u64, u64) + Send),
    ) -> Result<()> {
        const CHUNK: usize = 6 * 1024 * 1024;
        const CHUNK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);
        let total = data.len() as u64;
        progress(0, total);
        if data.is_empty() {
            // 空载荷：单条 cat > 建空文件（与旧语义一致）
            let mut channel = self
                .handle
                .channel_open_session()
                .await
                .map_err(|e| anyhow!("打开上传 channel 失败: {}", e))?;
            channel
                .exec(true, format!("cat > {}", shell_quote(remote_path)))
                .await
                .map_err(|e| anyhow!("下发上传命令失败: {}", e))?;
            channel
                .eof()
                .await
                .map_err(|e| anyhow!("上传 eof 失败: {}", e))?;
            let code = collect_exit_code(&mut channel).await;
            if code != 0 {
                return Err(anyhow!("远端 cat 写入失败（exit={}）: {}", code, remote_path));
            }
            progress(0, 0);
            return Ok(());
        }
        let n_chunks = data.len().div_ceil(CHUNK);
        let mut done = 0u64;
        for (i, chunk) in data.chunks(CHUNK).enumerate() {
            let redirect = if i == 0 { ">" } else { ">>" };
            let cmd = format!("cat {} {}", redirect, shell_quote(remote_path));
            let fut = async {
                let mut channel = self
                    .handle
                    .channel_open_session()
                    .await
                    .map_err(|e| anyhow!("打开上传 channel 失败: {}", e))?;
                channel
                    .exec(true, cmd)
                    .await
                    .map_err(|e| anyhow!("下发上传命令失败: {}", e))?;
                channel
                    .data(chunk)
                    .await
                    .map_err(|e| anyhow!("上传写入失败: {}", e))?;
                channel
                    .eof()
                    .await
                    .map_err(|e| anyhow!("上传 eof 失败: {}", e))?;
                let code = collect_exit_code(&mut channel).await;
                if code != 0 {
                    return Err(anyhow!("远端 cat 写入失败（exit={}）: {}", code, remote_path));
                }
                Ok(())
            };
            tokio::time::timeout(CHUNK_TIMEOUT, fut)
                .await
                .map_err(|_| {
                    anyhow!(
                        "上传块 {}/{} 超时（{}s 无进展）: {}（单通道停滞防御触发）",
                        i + 1,
                        n_chunks,
                        CHUNK_TIMEOUT.as_secs(),
                        remote_path
                    )
                })??;
            done += chunk.len() as u64;
            progress(done, total);
        }
        Ok(())
    }
}

/// 指纹拒绝详情（check_server_key → connect 调用方）。
/// handler 本体会被 move 进 russh 会话任务（connect 返回后无法取回），
/// 拒绝详情只能经 Arc 共享状态传出会话线程。
#[derive(Debug, Clone)]
pub struct KeyRejection {
    pub host: String,
    pub port: u16,
    /// SSH 密钥算法名（ssh-ed25519 / ssh-rsa / ecdsa-sha2-nistp256…）
    pub algorithm: String,
    /// 本次服务器给出的指纹（新）
    pub fingerprint: String,
    /// 本地记录的指纹（旧）
    pub expected: String,
}

impl KeyRejection {
    /// 拒绝原因全文。开头固定短语「主机密钥校验失败」是前端识别特征
    /// （app-remote.js 据此显示「忘记该主机」按钮）——改动前先同步两边并更新
    /// remote-workspace-contract.test.js 的锚点，否则按钮会静默消失。
    pub fn message(&self) -> String {
        format!(
            "主机密钥校验失败（{}:{} 的 {}）：服务器密钥指纹与首次连接时记录的不一致。\n  服务器可能重装或更换过主机密钥，也存在中间人攻击风险，请比对：\n  已知指纹: {}\n  新指纹:   {}\n  若确认服务器合法（如刚重装），可忘记该主机指纹后重连。",
            self.host,
            self.port,
            self.algorithm,
            self.expected,
            self.fingerprint
        )
    }
}

/// 主机密钥处理器：TOFU 校验（见模块注释）。
pub struct HostKeyHandler {
    host: String,
    port: u16,
    known_hosts_path: PathBuf,
    /// 首连遇到未知指纹时的处置（测试可注入；生产恒 AcceptAndRecord）
    pub policy: TofuPolicy,
    /// 指纹拒绝详情暂存（Arc 共享给 connect 调用方；handler 会被 move 进
    /// russh 会话任务，握手失败后只能从这里读回拒绝原因）。
    pub rejection: Arc<std::sync::Mutex<Option<KeyRejection>>>,
}

/// TOFU 处置策略（生产 AcceptAndRecord；测试可注入 Reject/Deny）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TofuPolicy {
    /// 未知指纹 → 记录并接受；已知指纹匹配 → 接受；不匹配 → 拒绝
    AcceptAndRecord,
    /// 未知指纹 → 拒绝（测试用）
    RejectUnknown,
}

/// connect / connect_stream 失败的统一包装：指纹拒绝（russh::Error::UnknownKey，
/// 会话在 check_server_key 返回 false 时报出）优先输出共享状态里的拒绝详情
/// （算法 + 新旧指纹），其余错误带 host:port 上下文。
/// `via`：错误前缀（直连「SSH 连接失败」/ 跳板「经跳板机连接」）。
fn connect_error(
    e: russh::Error,
    via: &str,
    target: &SshTarget,
    rejection: &Arc<std::sync::Mutex<Option<KeyRejection>>>,
) -> anyhow::Error {
    if matches!(e, russh::Error::UnknownKey) {
        if let Some(rej) = rejection.lock().unwrap().take() {
            return anyhow!("{} — {}", via, rej.message());
        }
    }
    anyhow!("{} {}:{} — {}", via, target.host, target.port, e)
}

impl russh::client::Handler for HostKeyHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        // 算法名与指纹（均与 ssh-keygen -l 同口径；RSA 不带签名 hash 后缀，
        // 同一把密钥协商到不同签名 hash 时键名不变——见 known_hosts 模块注释）
        let algorithm = server_public_key.algorithm().as_str().to_string();
        let fingerprint = server_public_key.fingerprint(russh::keys::HashAlg::Sha256).to_string();

        match known_hosts::verify(&self.known_hosts_path, &self.host, self.port, &algorithm, &fingerprint) {
            Ok(known_hosts::Verdict::Match) => Ok(true),
            Ok(known_hosts::Verdict::Unknown) => match self.policy {
                TofuPolicy::AcceptAndRecord => {
                    if let Err(e) = known_hosts::record(
                        &self.known_hosts_path,
                        &self.host,
                        self.port,
                        &algorithm,
                        &fingerprint,
                    ) {
                        tracing::warn!("[remote] known_hosts 记录失败（不影响本次连接）: {}", e);
                    }
                    Ok(true)
                }
                TofuPolicy::RejectUnknown => Ok(false),
            },
            Ok(known_hosts::Verdict::Changed { expected }) => {
                tracing::error!(
                    "[remote] 主机密钥变化（可能中间人攻击）：{}:{} {} 旧={} 新={}",
                    self.host, self.port, algorithm, expected, fingerprint
                );
                *self.rejection.lock().unwrap() = Some(KeyRejection {
                    host: self.host.clone(),
                    port: self.port,
                    algorithm: algorithm.clone(),
                    fingerprint: fingerprint.clone(),
                    expected,
                });
                Ok(false)
            }
            Err(e) => {
                tracing::warn!("[remote] known_hosts 读取失败（按未知处理）: {}", e);
                match self.policy {
                    TofuPolicy::AcceptAndRecord => Ok(true),
                    TofuPolicy::RejectUnknown => Ok(false),
                }
            }
        }
    }
}

/// 单次 exec 的结果。
#[derive(Debug, Clone)]
pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl ExecResult {
    /// 非 0 退出码时返回 Err（附 stderr 尾部，沿用 ZCode 教训：远端失败的真实原因
    /// 常在被吞的输出里）。
    pub fn ok_or_error(self, cmd_hint: &str) -> Result<Self> {
        if self.exit_code == 0 {
            Ok(self)
        } else {
            let tail: String = if self.stderr.trim().is_empty() {
                self.stdout
            } else {
                self.stderr
            }
            .chars()
            .rev()
            .take(600)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
            Err(anyhow!(
                "远端命令失败（exit={}）: {}\n输出尾部: {}",
                self.exit_code,
                cmd_hint,
                sanitize_output_tail(tail.trim())
            ))
        }
    }
}

/// 远端输出字节解码：UTF-8 优先，失败回退 GBK。
///
/// 遗留中文系统（GBK 代码页）的远端 shell/JVM 输出非 UTF-8 字节时，
/// `from_utf8_lossy` 会把每个非法字节打成 U+FFFD，界面呈现一串替换方块
/// （2026-10-09 用户实机「乱码」回归）。GBK 超集 GB2312 覆盖简体中文遗留
/// 编码；繁体/其它代码页仍降级为替换符（可接受：错误信息主体是 Rust 侧中文模板）。
fn decode_remote_output(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::GBK.decode(bytes).0.into_owned(),
    }
}

/// 错误信息内嵌输出尾部的 sanitization：控制字符替换为可见占位符。
///
/// detect 脚本的字段分隔符 \x1f 等控制字符原样 dump 进错误文本时，前端日志区
/// 渲染为乱码方块（同上图回归）。保留 \n 维持可读性，其余控制字符换 <0xNN>。
pub(crate) fn sanitize_output_tail(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c == '\n' {
            out.push('\n');
        } else if c.is_control() {
            out.push_str(&format!("<0x{:02x}>", c as u32));
        } else {
            out.push(c);
        }
    }
    out
}

/// SSH channel 消息收集器：stdout/stderr/退出码的顺序无关收集。
///
/// **旧实现在 `Eof` 即 break，是 2026-10-09「exit=-1 但输出尾部完整」回归的根因**：
/// SSH 协议允许 exit-status 在 channel EOF **之后**到达（服务端先发 EOF 再发
/// exit-status），Eof 即 break 使后续 ExitStatus 帧永远读不到 → exit_code 停留
/// 初值 -1 → 成功的 detect 被误判失败。现改为：Eof 只置标记，Close / channel
/// 结束（wait() 返回 None）才是收口点；EOF 后缺 exit-status 时限时宽限等待，
/// 仍缺则按干净退出 0 + warn（与 ssh CLI 拿不到退出状态的语义一致）。
struct ChannelCollector {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    exit_code: Option<i32>,
    /// 远端命令被信号终止（服务端只发 exit-signal 不发 exit-status 的形态，
    /// 如 OOM killer / kill -9）。存信号名，收口时按 shell 惯例换算退出码。
    exit_signal: Option<String>,
    eof_seen: bool,
    eof_since: Option<std::time::Instant>,
}

/// EOF 后等待 exit-status 的宽限时长（超时视为服务端未发）。
const EXIT_STATUS_GRACE: std::time::Duration = std::time::Duration::from_millis(500);

/// russh `Sig` → 信号名（russh 的 `Sig::name()` 是私有方法，按变体自映射；
/// `Custom` 携带原名直通）。
fn sig_name(s: &russh::Sig) -> String {
    match s {
        russh::Sig::ABRT => "ABRT",
        russh::Sig::ALRM => "ALRM",
        russh::Sig::FPE => "FPE",
        russh::Sig::HUP => "HUP",
        russh::Sig::ILL => "ILL",
        russh::Sig::INT => "INT",
        russh::Sig::KILL => "KILL",
        russh::Sig::PIPE => "PIPE",
        russh::Sig::QUIT => "QUIT",
        russh::Sig::SEGV => "SEGV",
        russh::Sig::TERM => "TERM",
        russh::Sig::USR1 => "USR1",
        russh::Sig::Custom(c) => c,
    }
    .to_string()
}

/// 信号名 → shell 惯例退出码（128+信号号，与本地 shell `$?` 同口径：
/// SIGTERM→143 / SIGKILL→137）。未识别信号名（Custom 异种）→ 255
///（ssh 客户端对未知失败的退出码），绝不返回 0（被杀 ≠ 成功）。
fn signal_exit_code(name: &str) -> i32 {
    let n = match name {
        "HUP" => 1,
        "INT" => 2,
        "QUIT" => 3,
        "ILL" => 4,
        "ABRT" => 6,
        "FPE" => 8,
        "KILL" => 9,
        "USR1" => 10,
        "SEGV" => 11,
        "PIPE" => 13,
        "ALRM" => 14,
        "TERM" => 15,
        _ => return 255,
    };
    128 + n
}

impl ChannelCollector {
    fn new() -> Self {
        Self {
            stdout: Vec::new(),
            stderr: Vec::new(),
            exit_code: None,
            exit_signal: None,
            eof_seen: false,
            eof_since: None,
        }
    }

    /// 喂入一条消息；返回 true 表示收集应结束（Close）。
    fn feed(&mut self, msg: ChannelMsg, max_output: usize) -> bool {
        match msg {
            ChannelMsg::Data { ref data } => {
                if self.stdout.len() + data.len() <= max_output {
                    self.stdout.extend_from_slice(data);
                }
            }
            ChannelMsg::ExtendedData { ref data, .. } => {
                if self.stderr.len() + data.len() <= max_output {
                    self.stderr.extend_from_slice(data);
                }
            }
            ChannelMsg::ExitStatus { exit_status } => {
                self.exit_code = Some(exit_status as i32);
            }
            ChannelMsg::ExitSignal { ref signal_name, .. } => {
                // 【codereview 2026-10-09 P1】旧实现把 ExitSignal 落 `_ => {}` 忽略：
                // 被信号杀死的命令（OOM/kill）服务端只发 exit-signal 不发
                // exit-status → 收口拿不到退出码按 0 处理 = 把「被杀」报成「成功」。
                // 比 exit=-1 误报更隐蔽：-1 至少会报错，0 会让部署链带着死掉的
                // 远端状态继续往下走。
                self.exit_signal = Some(sig_name(signal_name));
            }
            ChannelMsg::Eof => {
                // 不 break：exit-status 可能在 EOF 之后才到
                if !self.eof_seen {
                    self.eof_seen = true;
                    self.eof_since = Some(std::time::Instant::now());
                }
            }
            ChannelMsg::Close => return true,
            _ => {}
        }
        false
    }

    /// 等待下一条消息：EOF 已见而 exit-status 未到时按剩余宽限限时，
    /// 超时返回 None（调用方收口），避免不规范服务端挂死收集。
    async fn next_msg(
        &self,
        channel: &mut russh::Channel<client::Msg>,
    ) -> Option<ChannelMsg> {
        match self.eof_since {
            Some(t) if self.exit_code.is_none() => {
                let left = EXIT_STATUS_GRACE.saturating_sub(t.elapsed());
                match tokio::time::timeout(left, channel.wait()).await {
                    Ok(m) => m,
                    Err(_) => None,
                }
            }
            _ => channel.wait().await,
        }
    }

    /// 收口产出结果（channel 结束 / Close / 宽限超时后调用）。
    fn finish(self) -> ExecResult {
        let exit_code = match self.exit_code {
            Some(c) => c,
            None => match self.exit_signal {
                // 被信号终止：按 shell/OpenSSH 惯例 128+信号号（SIGTERM→143）。
                Some(sig) => {
                    tracing::warn!(
                        "[remote] 远端命令被信号 {} 终止（服务端未发 exit-status）；按 128+信号号 记退出码",
                        sig
                    );
                    signal_exit_code(&sig)
                }
                None => {
                    if self.eof_seen {
                        tracing::warn!(
                            "[remote] channel 结束仍未收到 exit-status（按 0 处理）；stdout {} 字节",
                            self.stdout.len()
                        );
                    } else {
                        // 无 EOF/无 status/无信号即结束：连接中断形态。保持 0 是
                        // 保守选择（非标服务端可能不发 EOF 但命令确实成功），
                        // 传输失败会在下一个操作/探活循环暴露。
                        tracing::warn!(
                            "[remote] channel 无 EOF/exit-status/exit-signal 即结束（连接可能中断）；按 0 处理"
                        );
                    }
                    0
                }
            },
        };
        ExecResult {
            exit_code,
            stdout: decode_remote_output(&self.stdout),
            stderr: decode_remote_output(&self.stderr),
        }
    }
}

/// 收集退出码（upload 类 channel 专用：只关心 exit code，语义与 exec 同收集器）。
async fn collect_exit_code(channel: &mut russh::Channel<client::Msg>) -> i32 {
    let mut collector = ChannelCollector::new();
    loop {
        let Some(msg) = collector.next_msg(channel).await else {
            break;
        };
        if collector.feed(msg, 64 * 1024) {
            break;
        }
    }
    collector.finish().exit_code
}

impl SshSession {
    /// 建立连接并认证。成功返回共享句柄。
    pub async fn connect(target: SshTarget, auth: &AuthMethod) -> Result<Self> {
        let session = Self::connect_inner(target, auth).await?;
        // connect_inner 返回 Arc<Self>（供 jump 场景保活）；直连场景解包成 Self
        Ok(Arc::try_unwrap(session).unwrap_or_else(|arc| Self {
            handle: arc.handle.clone(),
            target: arc.target.clone(),
            jumped_from: None,
        }))
    }
            
    /// 经跳板机建立连接（P4 ProxyJump）：先连跳板机，再在其 direct-tcpip channel 上
    /// 跑第二层 SSH（目标机的 22 端口流量经跳板机转发）。
    ///
    /// russh 0.54 公开 API 链：`Handle::channel_open_direct_tcpip(target, 22)` →
    /// `Channel::into_stream()`（futures AsyncRead+AsyncWrite）→ `client::connect_stream`。
    /// 目标机主机密钥校验用同一份 TOFU 库（键为目标 host:port，与直连一致）。
    /// 隧道/后续 direct-tcpip 走第二层会话的 handle——经跳板机的流量自动再封装一层。
    pub async fn connect_via_jump(
        target: SshTarget,
        auth: &AuthMethod,
        jump: &JumpHost,
    ) -> Result<Self> {
        // 1. 跳板机会话（普通连接）；句柄保存在返回的 SshSession.jumped_from，
        //    目标会话存活期间绝不 drop（否则 direct-tcpip channel 关闭连带目标连接死）
        let jump_session = Self::connect_inner(jump.target(), &jump.auth).await?;
        // 2. 目标机 22 端口的 direct-tcpip channel（经跳板机）
        let channel = jump_session
            .handle
            .channel_open_direct_tcpip(&target.host, target.port as u32, "127.0.0.1", 0)
            .await
            .map_err(|e| anyhow!("跳板机转发失败 {}:{} — {}", target.host, target.port, e))?;
        // 3. 在该 channel 流上跑目标机 SSH 握手 + 认证
        let stream = channel.into_stream();
        let mut session = Self::connect_over_stream(stream, target.clone(), auth).await?;
        let session = Arc::try_unwrap(session).unwrap_or_else(|arc| Self {
            handle: arc.handle.clone(),
            target: arc.target.clone(),
            jumped_from: None,
        });
        // 跳板机句柄保活：Arc<SshSession> 挂进 jumped_from，本会话 drop 时一并释放
        Ok(Self {
            handle: session.handle,
            target: session.target,
            jumped_from: Some(jump_session),
        })
    }
            
    /// 内部：直连实现（connect 的原有主体抽出，供 connect_via_jump 复用跳板机侧调用）。
    async fn connect_inner(target: SshTarget, auth: &AuthMethod) -> Result<Arc<Self>> {
        let known_hosts_path = known_hosts::default_path();
        tokio::fs::create_dir_all(known_hosts_path.parent().unwrap()).await
            .context("创建 known_hosts 目录失败")?;
                    
        let config = Arc::new(client::Config {
            // keepalive：15s 无流量探测半开连接（ZCode 同款思路，russh 0.54
            // 由服务端 channel 保活；这里设 inactivity 超时兜死挂）
            inactivity_timeout: Some(std::time::Duration::from_secs(60)),
            ..<_>::default()
        });
                    
        let rejection = Arc::new(std::sync::Mutex::new(None));
        let handler = HostKeyHandler {
            host: target.host.clone(),
            port: target.port,
            known_hosts_path,
            policy: TofuPolicy::AcceptAndRecord,
            rejection: rejection.clone(),
        };

        let addr = (target.host.as_str(), target.port);
        let handle = match client::connect(config, addr, handler).await {
            Ok(h) => h,
            Err(e) => return Err(connect_error(e, "SSH 连接失败", &target, &rejection)),
        };

        Self::authenticate(handle, &target, auth).await
    }
    
    /// 在已建立的流（直连 TCP 或跳板机 channel）上完成握手 + 认证，组装会话。
    async fn connect_over_stream(
        stream: russh::ChannelStream<russh::client::Msg>,
        target: SshTarget,
        auth: &AuthMethod,
    ) -> Result<Arc<Self>> {
        let known_hosts_path = known_hosts::default_path();
        let config = Arc::new(client::Config {
            inactivity_timeout: Some(std::time::Duration::from_secs(60)),
            ..<_>::default()
        });
        let rejection = Arc::new(std::sync::Mutex::new(None));
        let handler = HostKeyHandler {
            host: target.host.clone(),
            port: target.port,
            known_hosts_path,
            policy: TofuPolicy::AcceptAndRecord,
            rejection: rejection.clone(),
        };
        let handle = match client::connect_stream(config, stream, handler).await {
            Ok(h) => h,
            Err(e) => return Err(connect_error(e, "经跳板机连接", &target, &rejection)),
        };

        Self::authenticate(handle, &target, auth).await // 认证 + 组装 Arc<Self>
    }
    
    /// 认证通用段（handle 复用自 connect_inner / connect_over_stream）。
    async fn authenticate(
        mut handle: Handle<HostKeyHandler>,
        target: &SshTarget,
        auth: &AuthMethod,
    ) -> Result<Arc<Self>> {
        // 认证：password 或 publickey（RSA 取服务端最优 hash）
        let auth_ok = match auth {
            AuthMethod::Password { password } => handle
                .authenticate_password(&target.user, password.clone())
                .await
                .map_err(|e| anyhow!("SSH 密码认证异常: {}", e))?
                .success(),
            AuthMethod::PrivateKey { key_path, passphrase } => {
                let key = load_secret_key(key_path, passphrase.as_deref())
                    .map_err(|e| anyhow!("私钥加载失败 {}: {}", key_path, e))?;
                let hash = handle
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|e| anyhow!("协商 RSA hash 失败: {}", e))?
                    .flatten();
                // russh 0.54：PrivateKeyWithHashAlg::new 直接返回结构体（非 Result）。
                // 若未来版本改回 Result，这里编译期即暴露。
                let key_with_hash = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
                handle
                    .authenticate_publickey(&target.user, key_with_hash)
                    .await
                    .map_err(|e| anyhow!("SSH 公钥认证异常: {}", e))?
                    .success()
            }
        };
        if !auth_ok {
            return Err(anyhow!("SSH 认证失败（用户 {}）", target.user));
        }

        Ok(Arc::new(Self {
            handle: Arc::new(handle),
            target: target.clone(),
            jumped_from: None,
        }))
    }

    /// 底层句柄（隧道开 channel 用）。
    pub fn handle(&self) -> Arc<Handle<HostKeyHandler>> {
        self.handle.clone()
    }

    /// 执行远端命令并收集 stdout/stderr/退出码。
    ///
    /// 输出上限 1MB（部署链命令输出均为短文本；无上限会被恶意/异常输出吃穿内存）。
    pub async fn exec(&self, command: &str) -> Result<ExecResult> {
        const MAX_OUTPUT: usize = 1024 * 1024;

        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| anyhow!("打开 SSH channel 失败: {}", e))?;
        channel
            .exec(true, command)
            .await
            .map_err(|e| anyhow!("下发 exec 失败: {}", e))?;

        let mut collector = ChannelCollector::new();
        loop {
            let Some(msg) = collector.next_msg(&mut channel).await else {
                break;
            };
            if collector.feed(msg, MAX_OUTPUT) {
                break;
            }
        }
        Ok(collector.finish())
    }

    /// 主动断开（幂等）。
    pub async fn disconnect(&self) {
        let _ = self
            .handle
            .disconnect(russh::Disconnect::ByApplication, "client closed", "en")
            .await;
    }
}

/// POSIX 单引号包裹（嵌入单引号用 '\'' 转义）。所有拼进 shell 命令的远端路径
/// 必须过这里——路径里的空格/引号/分号会直接破坏命令结构。
pub fn shell_quote(s: &str) -> String {
    if !s.is_empty()
        && s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '-' | '_' | '~'))
    {
        // 常规安全路径免引号（远端日志可读性）
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_plain_paths_stay_readable() {
        assert_eq!(shell_quote("/home/user/.gwork"), "/home/user/.gwork");
        assert_eq!(shell_quote("gourd-ai-agent.jar"), "gourd-ai-agent.jar");
    }

    #[test]
    fn shell_quote_escapes_dangerous_paths() {
        // 空格
        assert_eq!(shell_quote("/home/my dir/x"), "'/home/my dir/x'");
        // 单引号：'…'\''…'
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        // 分号/&& 注入
        assert_eq!(shell_quote("a;rm -rf /"), "'a;rm -rf /'");
        // 空串
        assert_eq!(shell_quote(""), "''");
    }

    #[test]
    fn exec_result_error_carries_stderr_tail() {
        let r = ExecResult {
            exit_code: 127,
            stdout: String::new(),
            stderr: "line1\nline2\nline3".to_string(),
        };
        let err = r.ok_or_error("test-cmd").unwrap_err().to_string();
        assert!(err.contains("exit=127"));
        assert!(err.contains("test-cmd"));
        assert!(err.contains("line1"), "stderr 尾部必须进错误信息");
    }

    /// 指纹拒绝详情必须完整：host、算法、新旧指纹都要进错误文案
    /// （用户换钥决策与「忘记该主机」入口都依赖它）。
    #[test]
    fn key_rejection_message_carries_host_algorithm_and_both_fingerprints() {
        let rej = KeyRejection {
            host: "203.0.113.7".into(),
            port: 2222,
            algorithm: "ssh-ed25519".into(),
            fingerprint: "SHA256:new".into(),
            expected: "SHA256:old".into(),
        };
        let msg = rej.message();
        assert!(msg.contains("203.0.113.7:2222"), "必须带 host:port");
        assert!(msg.contains("ssh-ed25519"), "必须带密钥算法");
        assert!(msg.contains("SHA256:old"), "必须带旧指纹");
        assert!(msg.contains("SHA256:new"), "必须带新指纹");
        // 前端识别锚点（app-remote.js 凭此显示「忘记该主机」按钮）
        let anchor = ["主机密钥", "校验失败"].concat();
        assert!(msg.starts_with(&anchor), "错误文案必须以固定短语开头（前端识别特征）");
    }

    /// 【2026-10-09 回归护栏】exit-status 晚于 EOF 到达必须仍被捕获
    /// （旧实现 Eof 即 break → exit_code 恒 -1 → 成功命令被误判失败）。
    #[test]
    fn collector_captures_exit_status_arriving_after_eof() {
        let mut c = ChannelCollector::new();
        assert!(!c.feed(ChannelMsg::Eof, 1024), "Eof 不得收口");
        assert!(!c.feed(ChannelMsg::ExitStatus { exit_status: 7 }, 1024));
        assert!(c.feed(ChannelMsg::Close, 1024), "Close 才收口");
        assert_eq!(c.finish().exit_code, 7);

        // 正常序（exit-status 先于 EOF）同样正确
        let mut c2 = ChannelCollector::new();
        c2.feed(ChannelMsg::ExitStatus { exit_status: 0 }, 1024);
        c2.feed(ChannelMsg::Eof, 1024);
        c2.feed(ChannelMsg::Close, 1024);
        assert_eq!(c2.finish().exit_code, 0);
    }

    /// EOF 后始终缺 exit-status（不规范服务端）：宽限收口按 0，不得挂死/不得 -1。
    #[test]
    fn collector_missing_exit_status_settles_zero_not_minus_one() {
        let mut c = ChannelCollector::new();
        c.feed(ChannelMsg::Eof, 1024);
        c.feed(ChannelMsg::Close, 1024);
        assert_eq!(c.finish().exit_code, 0);
    }

    /// 【codereview 2026-10-09 P1 回归】被信号杀死的命令不得报成功：
    /// 服务端只发 exit-signal 不发 exit-status 时，旧实现落 `_ => {}` 忽略 →
    /// 收口按 0 = 把「被杀」报成「成功」，部署链带死状态继续走。
    #[test]
    fn collector_exit_signal_maps_to_shell_exit_code() {
        // SIGTERM → 143（128+15，与本地 shell $? 同口径）
        let mut c = ChannelCollector::new();
        c.feed(ChannelMsg::ExitSignal { signal_name: russh::Sig::TERM, core_dumped: false, error_message: String::new(), lang_tag: String::new() }, 1024);
        c.feed(ChannelMsg::Eof, 1024);
        c.feed(ChannelMsg::Close, 1024);
        assert_eq!(c.finish().exit_code, 143);
        // SIGKILL → 137（OOM killer 典型形态）
        let mut c = ChannelCollector::new();
        c.feed(ChannelMsg::ExitSignal { signal_name: russh::Sig::KILL, core_dumped: true, error_message: String::new(), lang_tag: String::new() }, 1024);
        c.feed(ChannelMsg::Close, 1024);
        assert_eq!(c.finish().exit_code, 137);
        // 显式 exit-status 优先于 exit-signal（服务端两者都发时以 status 为准）
        let mut c = ChannelCollector::new();
        c.feed(ChannelMsg::ExitSignal { signal_name: russh::Sig::TERM, core_dumped: false, error_message: String::new(), lang_tag: String::new() }, 1024);
        c.feed(ChannelMsg::ExitStatus { exit_status: 3 }, 1024);
        c.feed(ChannelMsg::Close, 1024);
        assert_eq!(c.finish().exit_code, 3);
        // 未识别信号名（Custom 异种）→ 255，绝不 0
        assert_eq!(signal_exit_code("WEIRD"), 255);
        assert_eq!(signal_exit_code(&sig_name(&russh::Sig::Custom("SYS".into()))), 255);
        assert_eq!(signal_exit_code(&sig_name(&russh::Sig::SEGV)), 139);
    }

    /// 非 UTF-8 远端输出（GBK 遗留系统）必须解出原文，不得打成替换符方块串。
    #[test]
    fn decode_remote_output_falls_back_to_gbk() {
        let gbk = encoding_rs::GBK.encode("连接失败：权限不足").0;
        assert!(std::str::from_utf8(&gbk).is_err(), "样本必须非 UTF-8");
        let s = decode_remote_output(&gbk);
        assert_eq!(s, "连接失败：权限不足");
        assert!(!s.contains('\u{fffd}'), "不得出现替换符");
        // UTF-8 原样直通
        assert_eq!(decode_remote_output("ok 中文".as_bytes()), "ok 中文");
    }

    /// 错误信息内嵌尾部不得含裸控制字符（detect 的 \x1f 分隔符是乱码方块来源）。
    #[test]
    fn sanitize_output_tail_replaces_control_chars() {
        let s = sanitize_output_tail("a\u{1f}b\u{7}c\nd");
        assert_eq!(s, "a<0x1f>b<0x07>c\nd");
    }

    /// 【源码形态护栏】旧「Eof 即 break」模式必须不存在；收集器宽限常量在位。
    #[test]
    fn exec_loop_must_not_break_on_eof() {
        let src = include_str!("ssh.rs");
        let old_pattern = ["ChannelMsg::Close | ChannelMsg::Eof => ", "break"].concat();
        assert!(
            !src.contains(&old_pattern),
            "Eof 即 break 会丢 EOF 之后的 exit-status（2026-10-09 回归根因）"
        );
        let grace = ["EXIT_STATUS_", "GRACE"].concat();
        assert!(src.contains(&grace), "EOF 后缺 exit-status 必须限时宽限收口");
    }

    /// 【前端识别链路契约】拒绝路径必须真的把指纹详情带出去：
    /// check_server_key 拒绝时 russh 报 UnknownKey，connect 错误分支必须
    /// 映射到共享状态里的 KeyRejection，而不是把它当普通连接错误丢弃。
    /// 行为测试需真 SSH 会话，故锁结构（include_str 锚点拼接防自匹配）。
    #[test]
    fn connect_failure_branch_maps_unknown_key_to_rejection_details() {
        let src = include_str!("ssh.rs");
        let mapped = ["connect_error(e, ", "\"SSH 连接失败\""].concat();
        assert!(
            src.contains(&mapped),
            "直连失败分支必须经 connect_error 包装（指纹详情不丢）"
        );
        let mapped_jump = ["connect_error(e, ", "\"经跳板机连接\""].concat();
        assert!(
            src.contains(&mapped_jump),
            "跳板路径失败分支同样必须包装"
        );
        // 映射主体存在：UnknownKey → 共享 rejection
        assert!(
            src.contains("matches!(e, russh::Error::UnknownKey)"),
            "connect_error 必须先识别 UnknownKey 再取拒绝详情"
        );
        // 按算法校验的调用形状（防止有人改回不带算法的旧签名）
        let verify_call = ["known_hosts::verify(&self.known_hosts_path, &self.host, self.port, &algorithm, &fingerprint)"].concat();
        assert!(
            src.contains(&verify_call),
            "check_server_key 必须按「主机+算法」校验（2026-10-08 多算法误报缺陷的修复点）"
        );
    }
}
