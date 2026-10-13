//! remote/wsl.rs —— WSL 通道（远程工作区 P2，仅 Windows 宿主）。
//!
//! 对应方案《远程工作区方案.md》v1.2 §四「WSL 变体」：不走 SSH——Tauri 直接
//! `wsl.exe -d <distro> -u <user> -e <shell> -ls` 执行远端命令（-e 直 exec，
//! 绕开发行版默认 shell 预解析，见 WslSession::exec），数据面靠
//! WSL2 localhostForwarding 直连（远端后端听 WSL 内 127.0.0.1，Windows 侧同口
//! 可达），无需隧道。上传三级回退抄 ZCode wsl-backend：UNC 直拷 → `cat >`
//! 流式（复用 bash 通道）→ 报错。
//!
//! ## 与 SSH 通道的关键差异（逐条对应 ZCode 教训）
//!
//! 1. **UTF-16 输出**：`wsl.exe -l -v` 等部分子命令输出 UTF-16LE（无 BOM），
//!    buffer 含 `\0` 即判 utf16le 再转码（ZCode 同款判别法）。
//! 2. **dispose 纪律**：只 kill 自己 spawn 的 wsl.exe（本模块 spawn 时记录
//!    child id），**绝不 `wsl --terminate <distro>`**——那会杀掉用户整个
//!    发行版里跑着的所有进程。
//! 3. **WSL1 回退**：localhostForwarding 是 WSL2 特性；detect 阶段探测
//!    WSL 版本，WSL1 直接报「暂不支持」（方案 P2 验收项）。
//! 4. **`-e` 直 exec + 登录 shell**：命令经 `-e /bin/bash -ls`（登录 shell 拿 PATH，
//!    java 可能装在 ~/.profile 追加的路径）。**绝不走默认 shell 预解析**：不带 -e 时
//!    wsl.exe 把整行拼接后交给发行版默认 shell——ash 系发行版（docker-desktop/
//!    Alpine）下 PIPESTATUS 数组下标等 bashism 报 bad substitution 全通道灭、
//!    bash 系发行版下包装器退出码被 cat 屏蔽（详见 WslSession::exec）。bash 缺失
//!    （Alpine 系）回退 `/bin/sh -ls`，命令体一律 POSIX（无 bashism）。
//!
//! ## host 身份
//!
//! WSL 的「host」= `<distro>:<user>`（无网络端口概念，端口直通由内核完成），
//! host_key 形如 `wsl:Ubuntu-22.04:luzw`。

#![cfg(target_os = "windows")]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use tokio::process::{Child, Command};

use super::deploy::RemoteEnv;
use super::ssh::ExecResult;

/// WSL 通道实现部署链的 ExecChannel（detect/probe/启动/停止 同一份脚本）。
#[async_trait::async_trait]
impl super::deploy::ExecChannel for WslSession {
    async fn exec(&self, command: &str) -> Result<ExecResult> {
        WslSession::exec(self, command).await
    }

    fn uploader(&self) -> Box<dyn super::deploy::DeployUploader> {
        Box::new(WslUploader {
            session: WslSession::new(&self.distro, &self.user),
        })
    }
}

/// WSL 上传器（UNC 直拷 + cat 回退；独立 session 与控制面无共享状态——
/// wsl.exe 每命令独立进程，本就无长连接可共享）。
pub struct WslUploader {
    session: WslSession,
}

#[async_trait::async_trait]
impl super::deploy::DeployUploader for WslUploader {
    async fn upload(
        &self,
        path: String,
        data: Vec<u8>,
        progress: &mut (dyn FnMut(u64, u64) + Send),
    ) -> Result<()> {
        WslSession::upload(&self.session, &path, data, progress).await
    }
}

/// wsl.exe 的绝对路径（System32 固定位；PATH 里的同名 exe 不可信）。
fn wsl_exe() -> PathBuf {
    let sys = std::env::var_os("SYSTEMROOT").unwrap_or_else(|| "C:\\Windows".into());
    Path::new(&sys).join("System32").join("wsl.exe")
}

/// 一条 WSL 通道会话（对应方案 §五 RemoteHost 的 WslHost 实现）。
///
/// dispose 纪律（ZCode 教训）：wsl.exe 是每命令独立短命进程，命令结束即退出，
/// 不存在需追踪的长命子进程——绝不 `wsl --terminate <distro>`（会杀用户发行版
/// 里的所有进程）。远端后端进程的生命周期由 mod.rs 的 kill-by-PID 管理。
pub struct WslSession {
    pub distro: String,
    pub user: String,
    /// distro 里的 HOME（detect 后回填；上传 UNC 路径要用）
    pub home: String,
    _spawned: Mutex<Vec<u32>>,
}

/// wsl.exe -l -v 输出的一个发行版行。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslDistro {
    pub name: String,
    pub state: String,
    pub version: u8,
    /// 是否默认发行版（wsl -l 第一行带 * 的那个）
    pub default: bool,
    /// P4：注册表探测到的默认用户名（root 特判；其余 None = 手填）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_user: Option<String>,
}

impl WslSession {
    pub fn new(distro: &str, user: &str) -> Self {
        Self {
            distro: distro.to_string(),
            user: user.to_string(),
            home: String::new(),
            _spawned: Mutex::new(Vec::new()),
        }
    }

    /// 执行命令（登录 shell 语义，与 SSH exec 同形）。
    ///
    /// 实现要点（对应 ZCode wsl-backend 的坑）：
    /// - `-u <user>`：以指定用户跑（root 会造成文件归属 root 的坑，向导默认
    ///   填 distro 默认用户）
    /// - 登录 shell（`-ls`）：加载 ~/.profile，java/PATH 才可见
    /// - 输出走管道收集；退出码透传
    ///
    /// **必须 `-e/--exec`（wsl.exe 最大坑，真机实证）**：不带 -e 时 wsl.exe 把
    /// `--` 后全部参数**拼成一条命令行交发行版默认 shell 预解析**（官方
    /// release-notes："all arguments become the ad-hoc script"）。旧包装器
    /// `bash -lc "cat | bash -s; exit …PIPESTATUS 下标…"` 因此先被默认 shell 解析：
    /// docker-desktop（Alpine 系，默认 shell = busybox ash）下该数组下标是
    /// bashism → `/bin/sh: syntax error: bad substitution`、exit=2 全通道灭；
    /// Ubuntu（默认 bash）下被词切分恰好"跑对"，但退出码永远是 cat 的 0——
    /// **整通道退出码被屏蔽**，ok_or_error 报错失效。-e 直接 execvp 参数表
    /// （默认 shell 不参与），退出码即 shell 自身退出码。
    ///
    /// **bash 缺失回退**：Alpine/docker-desktop 等发行版无 bash，-e /bin/bash
    /// 返回 126/127 → 重试 /bin/sh -ls。命令体一律 POSIX 书写（deploy/detect/
    /// 启动脚本无 bashism），ash 下安全；代价仅是这些发行版丢登录 shell PATH
    /// （内置 JRE 链不依赖系统 PATH，无影响）。
    pub async fn exec(&self, command: &str) -> Result<ExecResult> {
        let res = self.exec_with_shell("/bin/bash", command).await?;
        if res.exit_code == 126 || res.exit_code == 127 {
            tracing::debug!(
                "[wsl] distro {} 无 bash（exit={}），回退 /bin/sh",
                self.distro,
                res.exit_code
            );
            return self.exec_with_shell("/bin/sh", command).await;
        }
        Ok(res)
    }

    /// 经单一 shell 实例喂命令体（stdin），退出码原样透传。
    async fn exec_with_shell(&self, shell: &str, command: &str) -> Result<ExecResult> {
        // 命令经 stdin 喂入而非拼进参数表：命令体里的引号/换行不再被 Windows
        // 命令行转义规则二次解释（wsl.exe 对参数有它自己的一套拼接语义，
        // 历史上是转义坑重灾区——ZCode 用 base64 包一层，我们用 stdin 更直接）。
        let mut child = self
            .spawn(&["--cd", "~", "-u", &self.user, "-e", shell, "-ls"])
            .await?;

        // 写命令体到 stdin（管道关闭触发 shell 读取结束）
        use tokio::io::AsyncWriteExt;
        if let Some(stdin) = child.stdin.as_mut() {
            stdin.write_all(command.as_bytes()).await?;
            stdin.shutdown().await?;
        }

        let output = child.wait_with_output().await?;
        let exit_code = output.status.code().unwrap_or(-1);
        Ok(ExecResult {
            exit_code,
            stdout: decode_output(&output.stdout),
            stderr: decode_output(&output.stderr),
        })
    }

    /// spawn wsl.exe（登记 child 到 dispose 名单）。
    ///
    /// **必须 CREATE_NO_WINDOW**（真机缺陷，用户报「连接后一直闪弹框」）：
    /// wsl.exe 是**控制台子系统**程序，父进程（GUI 子系统 tauri exe）无控制台，
    /// Windows 会为每次 spawn 新建一个控制台窗口（屏幕顶部闪一下黑条即消）。
    /// exec/upload 路径高频调用本函数（部署链每条命令、健康探活每 10s 一次），
    /// 用户看到的就是「黑窗一直闪」。重定向 stdio 不能抑制控制台窗口，
    /// 与 cli_provision.rs 的 powershell.exe 同一纪律。
    async fn spawn(&self, args: &[&str]) -> Result<Child> {
        let mut cmd = Command::new(wsl_exe());
        cmd.arg("-d")
            .arg(&self.distro)
            .args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let child = cmd
            .spawn()
            .with_context(|| format!("启动 wsl.exe 失败（distro={}）", self.distro))?;
        Ok(child)
    }

    /// 探测 WSL 侧环境（与 deploy::detect 同一份脚本与解析，复用 parse_detect）。
    pub async fn detect(&self) -> Result<RemoteEnv> {
        // detect 脚本与 SSH 通道同一份（deploy::detect_script），保证两通道
        // 对 RemoteEnv 的语义完全一致；差别只在传输层。
        let res = self.exec(&super::deploy::detect_script()).await?;
        let res = res.ok_or_error("wsl detect (uname/java/libc/runtime/home/fingerprint)")?;
        let env = super::deploy::parse_detect(&res.stdout)?;
        if env.platform != "Linux" {
            return Err(anyhow!(
                "WSL 发行版 platform={} 非 Linux（不支持非 Linux 发行版）",
                env.platform
            ));
        }
        Ok(env)
    }

    /// UNC 路径（Windows 视角的 WSL 文件）：`\\wsl.localhost\<distro>\home\...`
    /// 注意：WSL1 是 `\\wsl$`；WSL2 两个名字都通。统一用 wsl.localhost（Win10
    /// 1903+ 才有，但 WSL2 本身就要求 1903+，所以安全）。
    fn unc_of(&self, wsl_path: &str) -> PathBuf {
        let p = wsl_path.trim_start_matches('/');
        PathBuf::from(format!("\\\\wsl.localhost\\{}\\{}", self.distro, p.replace('/', "\\")))
    }

    /// 上传部署 tar.gz 到 WSL 路径。三级回退（ZCode 同款）：
    /// 1. UNC 直拷（快，走 9P 文件系统——WSL2 9P 慢但 jar 部署低频，可接受；
    ///    失败场景：distro 刚启动未挂好、路径不存在）
    /// 2. `cat > path` 流式（复用 exec 通道，保底）
    /// 3. 都失败 → 报错
    pub async fn upload(
        &self,
        wsl_path: &str,
        data: Vec<u8>,
        progress: &mut (dyn FnMut(u64, u64) + Send),
    ) -> Result<()> {
        let total = data.len() as u64;
        // 1. UNC 直拷
        let unc = self.unc_of(wsl_path);
        if let Some(parent) = unc.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        // **分块写 + 逐块进度**（真机缺陷，用户报「上传进度一直 0」）：旧实现
        // tokio::fs::write 整块一次写——23MB jar 经 9P 写数秒期间 progress 一次
        // 都不回调，向导日志全程停 0%（末尾才补一帧 100%）。分块粒度与 cat
        // 回退路径一致（64KB），两路径进度语义统一；任一块失败 → 整体判失败
        // 回退 cat 流式（残留半截文件会被 cat 截断覆盖，无脏状态）。
        const UNC_CHUNK: usize = 64 * 1024;
        let unc_write = async {
            use tokio::io::AsyncWriteExt;
            let mut f = tokio::fs::File::create(&unc).await?;
            let mut done = 0u64;
            progress(0, total);
            for chunk in data.chunks(UNC_CHUNK) {
                f.write_all(chunk).await?;
                done += chunk.len() as u64;
                progress(done, total);
            }
            f.flush().await?;
            Ok::<(), std::io::Error>(())
        };
        match unc_write.await {
            Ok(()) => return Ok(()),
            Err(e) => tracing::warn!("[wsl] UNC 直拷失败，回退 cat 流式: {}", e),
        }
        // 2. cat 流式（保底）。与 exec 同走 -e 直 exec（绕默认 shell 预解析）；
        //    cat 重定向是 POSIX 语义，ash 回退路径同样安全。
        let mut child = self
            .spawn(&[
                "-u",
                &self.user,
                "-e",
                "/bin/sh",
                "-c",
                &format!("cat > {}", super::ssh::shell_quote(wsl_path)),
            ])
            .await?;
        use tokio::io::AsyncWriteExt;
        let mut done = 0u64;
        progress(0, total);
        if let Some(stdin) = child.stdin.as_mut() {
            const CHUNK: usize = 64 * 1024;
            for chunk in data.chunks(CHUNK) {
                stdin.write_all(chunk).await?;
                done += chunk.len() as u64;
                progress(done, total);
            }
            stdin.shutdown().await?;
        }
        let output = child.wait_with_output().await?;
        if output.status.code().unwrap_or(-1) != 0 {
            return Err(anyhow!(
                "WSL cat 写入失败（exit={}）: {} | UNC={}",
                output.status.code().unwrap_or(-1),
                wsl_path,
                unc.display()
            ));
        }
        Ok(())
    }
    /// host 身份键（连接注册表用）：`wsl:<distro>:<user>`。
    pub fn host_key(&self) -> String {
        format!("wsl:{}:{}", self.distro, self.user)
    }

    /// WSL2 idle-stop 保活 ping（2026-10-11 WSL 连接 180s 不就绪根因）。
    ///
    /// WSL2 的 idle-stop 判据是 **Windows 侧有无活跃 wsl.exe 客户端**，不看
    /// Linux 实例内部有没有进程在跑（`instanceIdleTimeout` 默认 15000ms）。
    /// 连接链的探测（就绪/健康/镜像推送）全是 Windows 侧 HTTP——启动后端那条
    /// wsl.exe 一退出，整个发行版 ~15s 内被 vmcompute 关掉，java 陪葬，
    /// 真机表现即「180s connection refused + 远端无进程无监听无日志」。
    ///
    /// 修法（社区/UniHarness 同款根治）：周期性 spawn 一个轻量 wsl.exe 客户端
    /// 连入，刷新 idle 计时器。`--exec true` 秒退、无 shell 语义、零副作用。
    /// 【陷阱】不要先查 `wsl -l --running` 再决定是否 ping——等状态变 Stopped
    /// 就晚了（停止不可逆于本窗口），无脑 ping 即可：warm 时 ~2s 无成本，
    /// stopped 时这一 ping 顺便把发行版叫醒，正是保活语义。
    ///
    /// 忽略结果：ping 失败（发行版被用户手动 terminate 等）只说明保活暂时
    /// 不可用，由调用方的健康探活负责判定连接存亡。
    pub async fn keepalive_ping(&self) {
        let mut cmd = tokio::process::Command::new(wsl_exe());
        cmd.arg("-d").arg(&self.distro).arg("--exec").arg("true");
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        // 不重定向 stdio 也能秒退；为防万一异常发行版挂住输出，整体限时 30s
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            cmd.output(),
        )
        .await;
    }
}

/// 解码 wsl.exe 输出：UTF-16LE 判别（buffer 含 \0 → utf16le，ZCode 同款）。
pub fn decode_output(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    // UTF-16LE 判据：含 NUL 字节（UTF-8 输出不可能含 NUL）
    let has_nul = bytes.contains(&0u8);
    if has_nul && bytes.len() % 2 == 0 {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        // 去 BOM（U+FEFF 是 3 字节，不能字节切片——用 strip_prefix 按字符处理）
        let s = String::from_utf16_lossy(&units);
        let s = s.strip_prefix('\u{feff}').unwrap_or(&s);
        // 去 CR（wsl.exe 的 UTF-16 输出常带 \r\n）
        s.replace('\r', "")
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// 解析 `wsl.exe -l -v` 输出为发行版列表。
///
/// 输出形态（UTF-16LE 或 UTF-8，取决于 Windows 版本）：
/// ```text
///   NAME            STATE           VERSION
/// * Ubuntu-22.04    Running         2
///   Debian          Stopped         1
/// ```
pub fn parse_distro_list(raw: &str) -> Vec<WslDistro> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // 表头行
        if line.to_ascii_lowercase().starts_with("name") {
            continue;
        }
        let (default, rest) = match line.strip_prefix('*') {
            Some(r) => (true, r.trim_start()),
            None => (false, line),
        };
        let mut fields = rest.split_whitespace();
        let (Some(name), Some(state), Some(version)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let version: u8 = match version.parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        out.push(WslDistro {
            name: name.to_string(),
            state: state.to_string(),
            version,
            default,
            default_user: None,
        });
    }
    out
}

/// 列出本机 WSL 发行版（wsl.exe -l -v）。无 WSL 时返回 Err（前端隐藏 WSL 通道）。
pub async fn list_distros() -> Result<Vec<WslDistro>> {
    // CREATE_NO_WINDOW 与 spawn 同纪律：下拉填充/连接前置查询同样 spawn
    // wsl.exe（控制台子系统），不加该 flag 每次查询闪一次黑窗。
    let mut cmd = tokio::process::Command::new(wsl_exe());
    cmd.args(["-l", "-v"]);
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .await
        .context("执行 wsl.exe -l -v 失败（宿主可能未启用 WSL）")?;
    if !output.status.success() {
        // 无发行版安装时 wsl -l -v 退出码非 0
        return Err(anyhow!(
            "wsl.exe -l -v 退出码 {}（可能未安装发行版）",
            output.status.code().unwrap_or(-1)
        ));
    }
    let text = decode_output(&output.stdout);
    let mut list = parse_distro_list(&text);
    // P4：默认用户名探测（注册表 HKCU\...\Lxss\{guid}\DistributionName → DefaultUid）。
    // DefaultUid 是 Linux uid（0=root，1000=普通用户）——映射不到名字时留空由用户手填。
    for d in list.iter_mut() {
        if let Some(name) = default_user_name(&d.name) {
            d.default_user = Some(name);
        }
    }
    if list.is_empty() {
        return Err(anyhow!("未发现任何 WSL 发行版"));
    }
    Ok(list)
}

/// 从注册表探测发行版默认用户名（Lxss\{guid}\DefaultUid → /etc/passwd 名）。
///
/// 两步：① 读 HKCU Lxss 找 DistributionName == distro 的子键拿 DefaultUid；
/// ② uid → 用户名需查发行版内 /etc/passwd——但那要起 wsl.exe（成本高且当前连接
/// 用户未定时会慢）。这里只返回 uid 推断的名字：0=root；1000=Ubuntu 首个普通用户
/// 命名规律不可靠，故仅 root 特判，其余返回 None（前端 placeholder 提示手填）。
fn default_user_name(distro: &str) -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let lxss = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Lxss")
        .ok()?;
    for key_name in lxss.enum_keys().flatten() {
        let sub = lxss.open_subkey(&key_name).ok()?;
        let dn: String = sub.get_value("DistributionName").ok()?;
        if dn.eq_ignore_ascii_case(distro) {
            let uid: u32 = sub.get_value("DefaultUid").unwrap_or(1000);
            return if uid == 0 {
                Some("root".to_string())
            } else {
                None // 非根用户名字无规律：手填（向导 placeholder 引导）
            };
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_utf16_with_bom_and_crlf() {
        // "hi\r\n" 的 UTF-16LE + BOM
        let mut b: Vec<u8> = vec![0xFF, 0xFE];
        for u in "hi\r\n".encode_utf16() {
            b.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(decode_output(&b), "hi\n");
    }

    #[test]
    fn decode_utf8_passthrough() {
        assert_eq!(decode_output(b"hello"), "hello");
        // UTF-8 中文正常
        assert_eq!(decode_output("中文".as_bytes()), "中文");
        // 空输入
        assert_eq!(decode_output(&[]), "");
    }

    /// 二进制 tar.gz 输出含 NUL 不应被误判 UTF-16 —— 但 exec 通道收集的
    /// stdout 不该出现 tar 二进制（upload 走 stdin 不走 stdout）。此处锁
    /// 定行为：奇数长度含 NUL（不可能的 UTF-16）按 UTF-8 lossy 处理。
    #[test]
    fn decode_odd_nul_falls_back_utf8() {
        let b = b"a\0b".to_vec(); // 奇数长度，非 UTF-16
        assert_eq!(decode_output(&b), "a\0b");
    }

    #[test]
    fn parse_distro_list_mixed() {
        let raw = "  NAME            STATE           VERSION\n\
                   * Ubuntu-22.04    Running         2\n\
                     Debian          Stopped         1\n";
        let list = parse_distro_list(raw);
        assert_eq!(list.len(), 2);
        assert!(list[0].default);
        assert_eq!(list[0].name, "Ubuntu-22.04");
        assert_eq!(list[0].state, "Running");
        assert_eq!(list[0].version, 2);
        assert!(!list[1].default);
        assert_eq!(list[1].name, "Debian");
        assert_eq!(list[1].version, 1);
    }

    #[test]
    fn parse_distro_list_utf16_decoded_text() {
        // 先造 UTF-16 输出再整体走 decode + parse（真实链路）
        let raw = "  NAME            STATE           VERSION\r\n* Ubuntu-22.04    Running         2\r\n";
        let mut b: Vec<u8> = Vec::new();
        for u in raw.encode_utf16() {
            b.extend_from_slice(&u.to_le_bytes());
        }
        let text = decode_output(&b);
        let list = parse_distro_list(&text);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Ubuntu-22.04");
        assert!(list[0].default);
    }

    #[test]
    fn parse_distro_list_skips_garbage_lines() {
        let raw = "NAME STATE VERSION\n\nnothing here\n* Ubuntu Running 2 extra\n";
        let list = parse_distro_list(raw);
        // "nothing here" 只有 2 字段被跳过；"Ubuntu Running 2 extra" 是合法行
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Ubuntu");
    }

    #[test]
    fn unc_path_mapping() {
        let s = WslSession::new("Ubuntu-22.04", "luzw");
        assert_eq!(
            s.unc_of("/home/luzw/.gwork/remote/x.tar.gz").to_string_lossy(),
            "\\\\wsl.localhost\\Ubuntu-22.04\\home\\luzw\\.gwork\\remote\\x.tar.gz"
        );
    }

    #[test]
    fn host_key_shape() {
        let s = WslSession::new("Ubuntu-22.04", "luzw");
        assert_eq!(s.host_key(), "wsl:Ubuntu-22.04:luzw");
    }

    #[test]
    fn wsl_session_exec_bypasses_default_shell_via_exec_flag() {
        // 契约测试（源码扫描，不真起进程）。锚点全部拼接构造——include_str 会把
        // 本测试源码自身含进去，字面量锚点会自匹配造成假绿/假红。
        let src = include_str!("wsl.rs");
        // ① exec 必须经 -e 直 execvp（默认 shell 不预解析命令体）
        let anchor_e = String::from("\"-e\", shel") + "l, \"-ls\"";
        assert!(src.contains(&anchor_e), "exec 必须 -e 直 exec（默认 shell 预解析坑）");
        // ② 命令体走 stdin（参数表零命令内容，wsl.exe 转义坑）
        let anchor_stdin = String::from("stdin.write_all(command.as_by") + "tes())";
        assert!(src.contains(&anchor_stdin), "命令体必须经 stdin 喂入");
        // ③ bash 缺失（126/127）回退 /bin/sh（Alpine 系无 bash 发行版）
        let anchor_126 = String::from("res.exit_code == 126 || res.exit_code == 12") + "7";
        let anchor_sh = String::from("exec_with_shell(\"/bin/sh\", comma") + "nd)";
        assert!(
            src.contains(&anchor_126) && src.contains(&anchor_sh),
            "bash 缺失（126/127）必须回退 /bin/sh"
        );
        // ④ 旧包装器的 bashism（PIPESTATUS 数组下标）不得回归——ash 系发行版下
        //    它报 bad substitution 全通道灭、bash 系下屏蔽退出码
        let bad_ps = format!("${{PIPESTATUS[0]}}");
        assert!(!src.contains(&bad_ps), "不得回归经默认 shell 预解析的旧包装器");
    }

    /// CREATE_NO_WINDOW 契约（源码扫描，不真起进程）：wsl.exe 是控制台子系统
    /// 程序，缺该 flag 时 Windows 为每次 spawn 新建黑控制台窗口（用户真机报
    /// 「连接后一直闪弹框」——exec/upload/健康探活全走 spawn）。三处 spawn 点
    /// （session spawn + list_distros + keepalive_ping）都必须声明并应用；
    /// 锚点拼接防 include_str 自匹配。
    #[test]
    fn wsl_spawn_suppresses_console_window() {
        let src = include_str!("wsl.rs");
        let flag = String::from("const CREATE_NO_WINDOW: u32 = 0x0800_00") + "00;";
        let apply = String::from("cmd.creation_flags(CREATE_NO_WIN") + "DOW);";
        assert_eq!(
            src.matches(&flag).count(),
            3,
            "wsl.exe 三处 spawn 点（spawn + list_distros + keepalive_ping）必须声明 CREATE_NO_WINDOW"
        );
        assert_eq!(
            src.matches(&apply).count(),
            3,
            "wsl.exe 三处 spawn 点必须应用 creation_flags"
        );
    }

    /// UNC 直拷进度契约（用户真机报「上传进度一直 0」）：整块 fs::write 在 9P
    /// 写数秒期间无进度回调。必须分块写且逐块回调进度；整块写 API 不得回归。
    #[test]
    fn wsl_unc_upload_reports_chunked_progress() {
        let src = include_str!("wsl.rs");
        let whole = String::from("tokio::fs::write(&unc, &da") + "ta)";
        assert!(
            !src.contains(&whole),
            "UNC 直拷不得整块 fs::write（进度恒 0 根因）"
        );
        // 两条上传路径（UNC 分块 + cat 回退）都必须逐块回调进度
        let chunk_prog = String::from("progress(done, tot") + "al);";
        assert_eq!(
            src.matches(&chunk_prog).count(),
            2,
            "UNC 与 cat 两路径必须逐块 progress(done, total)"
        );
        let unc_loop = String::from("for chunk in data.chunks(UNC_CHU") + "NK)";
        assert!(src.contains(&unc_loop), "UNC 直拷必须分块写");
    }
}
