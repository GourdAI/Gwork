//! remote/secrets.rs —— SSH 凭据记忆（远程工作区 P4）。
//!
//! keyring 3.6.3（MSRV 1.75，满足本仓 1.77.2）：Windows Credential Manager /
//! macOS Keychain / Linux Secret Service（需 libdbus，桌面环境默认有；无则
//! 优雅降级为「不记忆」，连接向导每次手输——绝不因凭据库缺失而失败）。
//!
//! 设计取舍：
//! - **只记「可选」凭据**：记住了 = 下次连接免输入；不记/库不可用 = 行为与 P1
//!   完全一致（每次手输）。向导里「记住密码」默认不勾选（敏感默认拒绝）。
//! - **条目键**：`gwork-remote-ssh <host:port:user>`（不含密码本体）；
//!   私钥口令同键不另存——同一身份一个条目，改口令即覆盖。
//! - **绝不记 Basic Auth**（每次连接随机生成，落盘无意义）。
//! - keyring 全同步 API：异步上下文调用用 `tauri::async_runtime::spawn_blocking`
//!   包裹，避免阻塞 tokio worker。
//!
//! 测试纪律（【P1 修正】）：keyring **3.6.3 的 features 列表里根本没有 `mock`**
//! （旧注释写的「mock feature 下永远可用」是错的），而 cargo 对 dev/normal 依赖的
//! features 取并集，所以测试用的是**用户真实的平台凭据库**（Windows 凭据管理器）。
//! 因此测试必须：① 用进程唯一 key，不碰固定共享条目（避免并行用例互干）；
//! ② 无论成败都清理（不得在用户凭据库里留下垃圾条目）；③ 库不可用时明确跳过
//! 而不是假成功。不用全局 mock builder：`MockCredentialBuilder::build` 每次返回
//! 全新空 mock，store/load 各自 new Entry 将拿到不同对象，回环必失败。

use anyhow::Result;

/// keyring 服务名（凭据库里的命名空间，与其它应用隔离）。
pub const SERVICE: &str = "gwork-remote-ssh";

/// 凭据条目键（host:port:user；WSL 用 wsl:distro:user 形态由调用方拼好传入）。
pub fn entry_key(host: &str, port: u16, user: &str) -> String {
    format!("{}:{}:{}", host, port, user)
}

/// 存凭据（密码或私钥口令，同一身份一个条目）。
///
/// 失败时返回 Err 但调用方只把「记住」动作降级为「没记住」（连接流程不中断）。
pub fn store(key: &str, secret: &str) -> Result<()> {
    let entry = keyring::Entry::new(SERVICE, key)?;
    entry.set_password(secret)?;
    Ok(())
}

/// 取凭据。None = 未记录或凭据库不可读。
pub fn load(key: &str) -> Option<String> {
    let entry = keyring::Entry::new(SERVICE, key).ok()?;
    entry.get_password().ok()
}

/// 删除凭据（「忘记密码」动作；不存在视为成功）。
pub fn delete(key: &str) -> Result<()> {
    let entry = keyring::Entry::new(SERVICE, key)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // 未记录的条目删除报 NoEntry/Platform 不算失败（幂等）
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(anyhow::anyhow!("删除凭据失败: {}", e)),
    }
}

/// 凭据库是否可用（向导据此显示「记住密码」勾选框；不可用时隐藏）。
pub fn available() -> bool {
    // 探针名必须**每次唯一**（仅 PID 不够：同一次 cargo test 里多个用例并行调
    // available() 时，共享探针会互相删掉对方向正在观察的条目 → 假失败/假成功）。
    probe_write_delete(&format!("__probe__{}_{}", std::process::id(), next_probe_seq()))
}

/// 写一条探针再删掉：真实平台库任何一步失败都视为不可用。
/// 拆出来是为了可测：调用方传自己的 key，就能断言「探测完库里不留下条目」。
fn probe_write_delete(key: &str) -> bool {
    let ok = store(key, "x").is_ok();
    let _ = delete(key);
    ok
}

/// 探针序列号（同一进程内递增，配合 PID 保证并行用例互不干扰）。
fn next_probe_seq() -> u64 {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试专用唯一 key：进程 PID + 用例名。不用固定共享条目——同一次
    /// `cargo test` 里多个用例并行写同一个 target，在真实凭据库上会互相干扰
    /// （实测：全量并行跑时 store_load_roundtrip 随机失败，单跑六次全绿）。
    fn test_key(tag: &str) -> String {
        format!("__test__{}:{}", std::process::id(), tag)
    }

    /// 真库写入不一定可用（无凭据服务/CI 容器）：探测不通则跳过，而不是
    /// 「断言成功」（那会把环境问题伪装成产品缺陷）。
    macro_rules! skip_if_unavailable {
        () => {
            if !available() {
                eprintln!("[skip] 本机凭据库不可用，跳过 secrets 真实读写用例");
                return;
            }
        };
    }

    /// 退出时自清守卫：断言 panic 也要删掉条目（写在函数末尾的 `delete` 在
    /// panic 路径上根本执行不到，那等于承诺「无论成败都清理」却呓实现）。
    struct CleanupGuard(String);
    impl Drop for CleanupGuard {
        fn drop(&mut self) {
            let _ = delete(&self.0);
        }
    }

    #[test]
    fn store_load_roundtrip() {
        skip_if_unavailable!();
        let key = test_key("roundtrip");
        let _guard = CleanupGuard(key.clone());
        assert!(store(&key, "s3cret").is_ok());
        assert_eq!(load(&key), Some("s3cret".to_string()));
        // 覆盖更新（改密码）
        assert!(store(&key, "new-pass").is_ok());
        assert_eq!(load(&key), Some("new-pass".to_string()));
        assert!(delete(&key).is_ok());
        assert_eq!(load(&key), None::<String>, "删除后不可再读");
    }

    #[test]
    fn delete_missing_is_idempotent() {
        let key = test_key("ghost");
        let _ = delete(&key); // 先清可能残留的同名条目（PID 唯一，正常为空）
        assert!(delete(&key).is_ok(), "删除不存在的条目必须幂等成功");
    }

    #[test]
    fn load_missing_returns_none() {
        skip_if_unavailable!();
        let key = test_key("absent");
        let _ = delete(&key);
        assert_eq!(load(&key), None::<String>);
    }

    #[test]
    fn entry_key_shape() {
        assert_eq!(entry_key("h", 22, "u"), "h:22:u");
        // WSL 形态（调用方拼好传入，本模块不关心语义）
        assert_eq!(entry_key("wsl:Ubuntu-22.04", 0, "luzw"), "wsl:Ubuntu-22.04:0:luzw");
    }

    #[test]
    fn probe_available_does_not_leave_entries() {
        // 探测会写一条探针再删：本用例用**自己的** key 跑同一段逻辑，验证探完库里
        // 不留下它（残留 = 用户凭据管理器里多出可见垃圾条目）。
        // 同时纠正旧断言的错误前提（旧名声称走 mock，而 mock feature 在本版本
        // 不存在，实际写的是真实凭据库）。
        let key = test_key("probe");
        if !probe_write_delete(&key) {
            eprintln!("[skip] 本机凭据库不可用，跳过探测自清用例");
            return;
        }
        assert_eq!(
            load(&key),
            None::<String>,
            "available() 探测完必须自清，否则用户凭据库里会多出垃圾条目"
        );
        assert!(available());
    }

    /// 源码契约：真实读写类用例必须用**进程唯一 key** + **自清守卫**。
    ///
    /// 【本断言自身的坑（第三次踩）】上一版在这里禁止「不得声称走 mock」，而
    /// 模块头注释里正好在叙述这个错误前提——include_str 把注释也算进去，于是
    /// 自己命中自己。改为只锁行为特征（key 来源与守卫类型），不锁措词。
    #[test]
    fn tests_use_isolated_keys_and_self_cleanup() {
        let src = include_str!("secrets.rs");
        // 旧形态：entry_key 传固定主机名字面量，直接入真库（锚点拼接构造）
        let fixed = ["entry_key(\"", "h.example"].concat();
        assert!(
            !src.contains(&fixed),
            "读写类用例不得再用固定共享条目（并行互干 + 在用户凭据库留残）"
        );
        // 真实读写的用例必须有自清守卫（Drop 里 delete）
        let rt_seg = src
            .split("fn store_load_roundtrip()")
            .nth(1)
            .and_then(|s| s.split("#[test]").next())
            .expect("roundtrip 用例必须存在");
        let guard_ty = ["Cleanup", "Guard"].concat();
        assert!(
            rt_seg.contains(&guard_ty),
            "写入真库的用例必须有 Drop 自清（末尾手写 delete 在 panic 路径上不执行）"
        );
        // key 必须来自进程唯一构造函数，不能是字面量
        let key_fn = ["test_", "key("].concat();
        assert!(rt_seg.contains(&key_fn), "必须用进程唯一 key");
    }
}
