//! remote/mirror.rs —— 桌面端模型配置镜像（远程工作区 P4，方案 A 内存镜像）。
//!
//! 用户拍板（2026-10）：远端模型配置 = 本机配置的**内存镜像**——连接建立时桌面端把
//! 本机 `~/.gwork/settings.json` 的 providers/models/defaultModel 经数据面（SSH 隧道 /
//! WSL localhost 直连，均加密或本机回环）推送到远端 `/web/settings/overlay`；远端载入
//! 进程内存并同步运行时引擎，**不落盘**（Java 侧 mirrored 标记拒绝回写），断连即焚，
//! 远端磁盘上 apiKey 零残留。
//!
//! 同步范围（拍板：全量镜像）：本机全局区全部 providers + models + defaultModel。
//! 只镜像这三类；general/permission/mcp/api/lsp 属于远端机器自己的环境配置不参与。
//!
//! 推送语义：幂等（远端替换语义，重复推送最后生效）。触发点：
//! 1. 连接建立后（mod.rs register_connection 尾段）
//! 2. 用户重连时（同 1）
//! 3. 前端「同步模型配置」按钮（remote_mirror_sync 命令，本地改配置后手动重推）

use anyhow::{anyhow, Context, Result};
use serde::Serialize;

/// 本机全局区 settings.json 的三段镜像载荷（与 Java 侧 applyRemoteMirror 的输入契约对齐）。
#[derive(Debug, Clone, Serialize)]
pub struct MirrorPayload {
    #[serde(rename = "defaultModel")]
    pub default_model: String,
    pub providers: serde_json::Value,
    pub models: serde_json::Value,
}

/// 从本机全局区 settings.json 构造镜像载荷。
///
/// 只取 providers/models/defaultModel 三段（全量，含 apiKey 明文——载荷只在桌面端
/// 内存与加密数据面上存活，绝不经手远端磁盘）。workspace 作用域的模型/供应商本就
/// 不在全局区文件里（getGlobalJson 按 scope 拆分落盘），无需再过滤。
pub fn build_payload() -> Result<MirrorPayload> {
    let settings_path = crate::paths::gwork_home().join("settings.json");
    let raw = std::fs::read_to_string(&settings_path)
        .with_context(|| format!("读取本机配置失败（远程镜像需要）: {}", settings_path.display()))?;
    let root: serde_json::Value = serde_json::from_str(&raw)
        .with_context(|| format!("本机 settings.json 解析失败: {}", settings_path.display()))?;

    Ok(MirrorPayload {
        default_model: root
            .get("defaultModel")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        providers: root.get("providers").cloned().unwrap_or(serde_json::json!({})),
        models: root.get("models").cloned().unwrap_or(serde_json::json!({})),
    })
}

/// 把镜像推送到远端 overlay 端点。
///
/// `local_port` 是连接的数据面本地端口（隧道端口或 WSL 直连端口）；Basic Auth 用
/// 连接随机生成的凭据（与前端请求分流同一套，远端 WebAuthFilter 校验）。
///
/// 成功判定（P2 修复）：远端是 Solon 框架，`Result.failure` 的 HTTP 状态码仍是
/// 200、错误码在响应体 JSON 的 `code` 字段（solon Result 语义：SUCCEED=200/
/// FAILURE=400，但序列化为 HTTP 200 + body）。原实现只看 HTTP 状态码，非远端
/// 模式/空载荷等业务拒绝会被误判为「镜像成功」。必须解析 body 的 code==200。
pub async fn push(
    local_port: u16,
    auth_user: &str,
    auth_pass: &str,
    payload: &MirrorPayload,
) -> Result<()> {
    let url = format!("http://127.0.0.1:{}/web/settings/overlay", local_port);
    let body = serde_json::to_string(payload).context("镜像载荷序列化失败")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .context("构造镜像推送 HTTP 客户端失败")?;
    let resp = client
        .post(&url)
        .basic_auth(auth_user, Some(auth_pass))
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .with_context(|| format!("镜像推送请求失败: {}", url))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("远端拒绝镜像（HTTP {}）: {}", status.as_u16(), truncate(&text, 300)));
    }
    // Solon Result：HTTP 200 + body {code:200|400, description}
    let code = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("code").and_then(|c| c.as_i64()));
    match code {
        Some(200) => Ok(()),
        Some(other) => {
            let desc = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| {
                    v.get("description")
                        .and_then(|d| d.as_str())
                        .map(|s| s.to_string())
                })
                .unwrap_or_default();
            Err(anyhow!("远端拒绝镜像（code={}）: {}", other, desc))
        }
        // body 不是 JSON（网关/代理篡改）：不确认成功，报原文
        None => Err(anyhow!("镜像响应非预期格式: {}", truncate(&text, 300))),
    }
}

/// 推送 + 进度日志（连接链尾段调用；失败只降级不阻断——模型镜像缺席不应废掉整个连接）。
///
/// 返回是否成功（供调用方决定日志措辞与 outcome 字段）。
pub async fn push_with_progress(
    local_port: u16,
    auth_user: &str,
    auth_pass: &str,
    progress: &mut (dyn FnMut(String) + Send),
) -> bool {
    let payload = match build_payload() {
        Ok(p) => p,
        Err(e) => {
            // 本机没配置过模型（settings.json 不存在）是合法场景：远端保持自己的配置
            progress(format!("[remote] 本机模型配置不可用，跳过镜像（{}）", e));
            return false;
        }
    };
    let model_count = payload.models.as_object().map(|m| m.len()).unwrap_or(0);
    let provider_count = payload.providers.as_object().map(|m| m.len()).unwrap_or(0);
    progress(format!(
        "[remote] 同步模型配置到远端（{} 个供应商 / {} 个模型，内存镜像不落盘）…",
        provider_count, model_count
    ));
    match push(local_port, auth_user, auth_pass, &payload).await {
        Ok(()) => {
            progress("[remote] 模型配置已镜像（远端进程内存，断连即失效）".to_string());
            true
        }
        Err(e) => {
            progress(format!("[remote] 模型镜像推送失败（连接继续，远端用自身配置）: {}", e));
            false
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let mut end = max;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &s[..end])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 镜像载荷必须只含三段：绝不能把 general/permission（含 webAuth 凭据等本机敏感段）
    /// 或 mcp/api/lsp（远端机器环境差异大）一并推走。字段白名单即最小暴露面。
    #[test]
    fn payload_contains_only_three_segments() {
        let p = MirrorPayload {
            default_model: "M".into(),
            providers: serde_json::json!({"P": {}}),
            models: serde_json::json!({"M": {}}),
        };
        let v = serde_json::to_value(&p).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable(); // serde_json 默认 BTreeMap 键序按字母排，不锁插入序
        assert_eq!(keys, vec!["defaultModel", "models", "providers"],
            "镜像载荷必须是三段白名单（多一个字段就多一分泄漏面）");
    }

    /// build_payload 读不到本机配置时的降级（连接不因镜像失败而废掉）。
    #[test]
    fn build_payload_missing_file_is_error_not_panic() {
        // gwork_home 由 paths 解析；测试环境该文件不存在时必须是 Err 而非 panic。
        // 若恰好存在（开发机），也允许成功——两种结果都合法，只锁「不 panic」。
        let _ = build_payload();
    }

    #[test]
    fn truncate_respects_char_boundary() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("hello world", 5), "hello…");
        // 多字节字符（中文）不被劈开：截断点落在 UTF-8 序列中间时回退到上一个完整字符
        let s = "中文内容";
        let t = truncate(s, 3);
        assert!(s.starts_with(t.trim_end_matches('…')) || t == "…", "截断结果必须是原串的前缀：{}", t);
    }
}
