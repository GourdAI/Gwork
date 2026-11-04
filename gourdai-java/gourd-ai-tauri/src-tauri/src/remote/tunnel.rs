//! remote/tunnel.rs —— russh direct-tcpip 隧道（本地回环 → 远端后端端口）。

use std::sync::Arc;

use anyhow::{anyhow, Result};
use russh::client::Handle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream}; 

use super::ssh::HostKeyHandler;

/// 一条运行中的隧道（本地回环端口 → 远端回环端口）。
///
/// 对应方案 v1.2 §四：数据面走 russh 内建 direct-tcpip forwarding（等价 `ssh -L`），
/// 不 spawn 外部 ssh 进程。实现形态：本地 TcpListener 127.0.0.1:<port>，
/// 每接受一条连接就开一个 direct-tcpip channel 双向透传（与 OpenSSH -L 的
/// 每连接一 channel 语义一致）。
pub struct Tunnel {
    /// 本地监听端口（前端请求指向这里）
    pub local_port: u16,
    /// 远端目标端口（远端后端 jar 监听口）
    pub remote_port: u16,
    /// 取消令牌：drop 即停止接受新连接（既有连接自然结束）
    cancel: tokio_util::sync::CancellationToken,
}

impl Tunnel {
    /// 起隧道：绑定本地回环随机端口，接受循环异步跑。
    ///
    /// 端口由系统分配（端口 0），返回时已确定 local_port。调用方持 Tunnel 保活；
    /// drop 后 accept 循环退出（新连接拒收，存量连接由对端关闭结束）。
    pub async fn start(
        ssh: Arc<Handle<HostKeyHandler>>,
        remote_port: u16,
        remote_host: String,
    ) -> Result<Self> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0u16))
            .await
            .map_err(|e| anyhow!("隧道绑定本地回环端口失败: {}", e))?;
        let local_port = listener.local_addr()?.port();

        let cancel = tokio_util::sync::CancellationToken::new();
        let cancel_loop = cancel.clone();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = cancel_loop.cancelled() => break,
                    accepted = listener.accept() => {
                        let (client, _addr) = match accepted {
                            Ok(v) => v,
                            Err(e) => {
                                tracing::warn!("[tunnel] accept 失败: {}", e);
                                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                                continue;
                            }
                        };
                        let ssh = ssh.clone();
                        let remote_host = remote_host.clone();
                        tokio::spawn(async move {
                            if let Err(e) = pump(ssh, client, &remote_host, remote_port).await {
                                tracing::debug!("[tunnel] 连接结束: {}", e);
                            }
                        });
                    }
                }
            }
        });

        Ok(Self {
            local_port,
            remote_port,
            cancel,
        })
    }

    /// 停止接受新连接（幂等）。
    pub fn stop(&self) {
        self.cancel.cancel();
    }
}

/// 单条连接的透传：本地 socket ⇄ direct-tcpip channel。
async fn pump(
    ssh: Arc<Handle<HostKeyHandler>>,
    mut client: TcpStream,
    remote_host: &str,
    remote_port: u16,
) -> Result<()> {
    let mut channel = ssh
        .channel_open_direct_tcpip(remote_host, remote_port as u32, "127.0.0.1", 0)
        .await
        .map_err(|e| anyhow!("打开 direct-tcpip 失败: {}", e))?;

    let _ = client.set_nodelay(true);

    // russh Channel 的消息驱动接口是 wait()：客户端读走 socket 字节后用 data() 写上行；
    // 下行从 ChannelMsg::Data 取出写给客户端。任一方 EOF 即关闭另一方。
    let mut client_buf = [0u8; 16 * 1024];

    loop {
        tokio::select! {
            r = client.read(&mut client_buf) => {
                match r {
                    Ok(0) => { let _ = channel.eof().await; break; }
                    Ok(n) => channel.data(&client_buf[..n]).await
                        .map_err(|e| anyhow!("隧道上行失败: {}", e))?,
                    Err(e) => return Err(anyhow!("隧道读客户端失败: {}", e)),
                }
            }
            r = channel.wait() => {
                let msg = match r {
                    Some(m) => m,
                    None => break,
                };
                match msg {
                    russh::ChannelMsg::Data { ref data } => {
                        client.write_all(data).await
                            .map_err(|e| anyhow!("隧道下行失败: {}", e))?;
                    }
                    russh::ChannelMsg::Eof | russh::ChannelMsg::Close => {
                        let _ = client.shutdown().await;
                        break;
                    }
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // tunnel 的真实行为（direct-tcpip 透传）需要真 SSH 连接，由 P1 集成验收覆盖
    // （Windows→Linux 跑通目录选择→会话）。pump/Tunnel::start 的签名由调用点
    // mod.rs::connect 钉住（编译期契约），不另设伪测试—— unreachable! 桩会被
    // 执行（构造 Arc 的路径本身就是函数体），写了就是红色假象。
}
