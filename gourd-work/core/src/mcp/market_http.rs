//! `mcp::market_http` — 连接器目录源的共享 HTTP 传输层。
//!
//! 三个内置目录源（魔搭 ModelScope / 腾讯云 MCP 广场 / Smithery）共用同一份
//! 传输加固：进程级单例 reqwest client、响应体 16MiB 上限（防上游异常/劫持
//! 镜像返回超大 JSON 打爆内存）、统一 `(status, json)` 返回形状。
//!
//! 历史：这些原语曾内联在 `mcp::market`（魔搭单源时代）。2026-11 集成
//! SolonCode 同源的两个新目录源时提取到这里，避免三份拷贝漂移。
//! `McpMarketHttp` trait 仍只有魔搭需要的 PUT/GET 两个动词；腾讯（POST）与
//! Smithery（GET）直接调本模块的自由函数。

use serde_json::Value;

/// 桌面应用 UA（魔搭 / Smithery 用）。腾讯 BFF 需要浏览器 UA，见 `tencent::BROWSER_UA`。
pub const USER_AGENT: &str = "GourdWorkDesktop/0.3 (+MCP Market)";

/// 上游 JSON 响应体上限，与 `skills::market::MAX_API_BODY_BYTES` 同级加固。
///
/// 详情接口的 `readme` 实测近 5 万字符，正常远不到这个量级；但上游异常或被劫持
/// 镜像返回超大 JSON 时，`resp.json::<Value>()` 会无上限全量解析直至 OOM。
/// 超限一律**报错**，绝不返回截断体：半个 JSON 无法解析，会把一个 DoS 防护
/// 伪装成业务失败。
pub const MAX_API_BODY_BYTES: usize = 16 * 1024 * 1024;

/// 进程级单例 client：连接池复用（翻页/搜索防抖下不再每次 TLS 握手），
/// `expect` 只在 Lazy 首次解引用时执行一次。与 `skills::market` 的做法一致。
pub fn client() -> reqwest::Client {
    static CLIENT: once_cell::sync::Lazy<reqwest::Client> = once_cell::sync::Lazy::new(|| {
        reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("reqwest mcp market client")
    });
    CLIENT.clone()
}

/// 流式读取响应体，拒绝缓冲超过 `cap` 的字节。
///
/// `Ok(None)` 表示超限。与 `skills::market::read_capped` 同构（而非直接复用），
/// 因为那个函数是私有的；两处逻辑必须保持一致，改一处要同步另一处。
async fn read_capped(resp: reqwest::Response, cap: usize) -> reqwest::Result<Option<Vec<u8>>> {
    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if buf.len() + chunk.len() > cap {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(Some(buf))
}

/// 读取带体积上限的 JSON 响应体。
///
/// `what` 只用于拼装错误文案里的上游名称（如「魔搭 MCP 广场」）。
pub async fn capped_json(resp: reqwest::Response, cap: usize, what: &str) -> Result<(u16, Value), String> {
    let status = resp.status().as_u16();
    let Some(bytes) = read_capped(resp, cap).await.map_err(|e| format!("解析{what}响应失败: {e}"))?
    else {
        return Err(format!(
            "解析{what}响应失败: 响应体超过 {} 字节上限，已拒绝（疑似上游异常）",
            cap
        ));
    };
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("解析{what}响应失败: {e}"))?;
    Ok((status, value))
}

/// GET JSON（带体积上限）。`ua` 允许各源覆盖默认 UA（腾讯 BFF 要浏览器串）。
pub async fn get_json(url: &str, ua: &str, what: &str) -> Result<(u16, Value), String> {
    let resp = client()
        .get(url)
        .header("User-Agent", ua)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("请求{what}失败: {}", e))?;
    capped_json(resp, MAX_API_BODY_BYTES, what).await
}

/// POST JSON（带体积上限）。腾讯 BFF 全部端点都是 POST + JSON body。
pub async fn post_json(
    url: &str,
    body: &Value,
    ua: &str,
    extra_headers: &[(&str, &str)],
    what: &str,
) -> Result<(u16, Value), String> {
    let mut req = client()
        .post(url)
        .header("User-Agent", ua)
        .header("Accept", "application/json");
    for (k, v) in extra_headers {
        req = req.header(*k, *v);
    }
    let resp = req
        .json(body)
        .send()
        .await
        .map_err(|e| format!("请求{what}失败: {}", e))?;
    capped_json(resp, MAX_API_BODY_BYTES, what).await
}