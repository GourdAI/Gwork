//! remote/channel.rs —— 远程连接的数据面通道抽象（P2/P3）。
//!
//! P1 只有一条通道（SSH direct-tcpip 隧道）；P2 引入 WSL 直连（localhostForwarding，
//! 无需隧道）后，`RemoteConnection` 持有的「数据面」必须抽象化：
//!
//! ```text
//! enum DataPlane {
//!     Tunnel(Arc<Tunnel>),        // SSH：本地回环随机端口 → direct-tcpip → 远端回环
//!     Direct { port: u16 },       // WSL：localhostForwarding，Windows 直连同端口
//! }
//! ```
//!
//! 前端只关心一个数：`localPort`（请求往 `127.0.0.1:localPort` 发）。
//! 隧道形态 = 隧道本地端口；直连形态 = 远端后端端口本身。
//!
//! P3（CLI 预装）复用 SSH 通道（CliHost = 探测跳过部署的 SshHost），无新通道形态。

use std::sync::Arc;

use super::tunnel::Tunnel;

/// 一条连接的数据面。
#[derive(Clone)]
pub enum DataPlane {
    /// SSH 隧道：前端 → 127.0.0.1:tunnel.local_port → direct-tcpip → 远端回环
    Tunnel(Arc<Tunnel>),
    /// 直连（WSL localhostForwarding）：前端 → 127.0.0.1:port（= WSL 内同端口）
    Direct { port: u16 },
}

impl DataPlane {
    /// 前端请求应指向的本地端口。
    pub fn local_port(&self) -> u16 {
        match self {
            DataPlane::Tunnel(t) => t.local_port,
            DataPlane::Direct { port } => *port,
        }
    }

    /// 停止数据面（WSL 直连无资源可停）。
    pub fn stop(&self) {
        if let DataPlane::Tunnel(t) = self {
            t.stop();
        }
    }

    /// 通道形态描述（日志/诊断用）。
    pub fn kind(&self) -> &'static str {
        match self {
            DataPlane::Tunnel(_) => "ssh-tunnel",
            DataPlane::Direct { .. } => "wsl-direct",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DataPlane::Direct 的端口语义（WSL 直连：local = remote 同端口）。
    /// 隧道形态由 P1 既有测试 + mod.rs 接线覆盖，这里只锁直连形态。
    #[test]
    fn direct_port_is_backend_port() {
        let d = DataPlane::Direct { port: 37201 };
        assert_eq!(d.local_port(), 37201);
        assert_eq!(d.kind(), "wsl-direct");
        d.stop(); // no-op，不 panic
    }
}
