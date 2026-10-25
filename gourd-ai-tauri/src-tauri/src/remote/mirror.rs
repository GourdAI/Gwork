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
//! 1. 连接建立后（mod.rs register_connection 尾段，**屏障语义**：推送失败即连接失败）
//! 2. 用户重连时（同 1）
//! 3. 前端「同步模型配置」按钮（remote_mirror_sync 命令，本地改配置后手动重推）
//! 4. 复用既有连接前的世代校验（mod.rs connect 复用分支）
//! 5. 心跳探活发现远端世代回退（远端进程复活）时的自愈重推（spawn_health_probe）
//!
//! 世代号（generation）：远端每次成功 apply 镜像自增，进程重启归零。桌面端记录
//! 「我推成的那一代」，与远端当前世代比对即可判定镜像是否仍在远端内存里——
//! 这是 4/5 两个触发点的判据来源（见 [`fetch_generation`]）。

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

/// 推送 + 进度日志（降级语义调用面：复用重推 / 心跳自愈 / 手动同步按钮）。
///
/// 返回是否成功（供调用方决定日志措辞与 outcome 字段）。失败原因由
/// [`push_with_reason`] 给出——本函数只关心「成不成」，用于那些**不应因镜像
/// 缺席而废掉连接**的路径（连接已存在、镜像只是补推）。
pub async fn push_with_progress(
    local_port: u16,
    auth_user: &str,
    auth_pass: &str,
    progress: &mut (dyn FnMut(String) + Send),
) -> bool {
    push_with_reason(local_port, auth_user, auth_pass, progress).await.is_ok()
}

/// 推送 + 进度日志，**并回报失败原因**（连接屏障专用）。
///
/// WHY 单独一个变体：fail-closed 把「镜像没推上去」升级成「连接失败」，而失败
/// 消息是用户唯一的排查入口（向导日志区 + 错误 toast）。旧口径只回 bool，调用方
/// 拿不到原因，只能写「同步失败」四个字——用户无法区分「本机根本没配模型」
/// （合法场景，该去配）与「远端拒绝/隧道不通」（该重连或看远端日志）。
///
/// 进度行措辞保持中性（不再写「连接继续」）：同一份文案要同时服务屏障路径
/// （连接会被废掉）与降级路径（连接保留），由调用方决定后果。
pub async fn push_with_reason(
    local_port: u16,
    auth_user: &str,
    auth_pass: &str,
    progress: &mut (dyn FnMut(String) + Send),
) -> Result<(), String> {
    let payload = match build_payload() {
        Ok(p) => p,
        Err(e) => {
            // 本机没配置过模型（settings.json 不存在/不可读）：远端无从镜像
            let reason = format!("本机模型配置不可用（{}）", e);
            progress(format!("[remote] {}", reason));
            return Err(reason);
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
            Ok(())
        }
        Err(e) => {
            let reason = format!("远端未接受镜像（{}）", e);
            progress(format!("[remote] 模型镜像推送失败: {}", reason));
            Err(reason)
        }
    }
}

/// 查询远端当前镜像世代号（`GET /web/settings/mirror-state`）。
///
/// WHY（屏障语义对标 ZCode provisioning）：镜像是**远端进程内存**里的状态，
/// 桌面端无法从「连接还活着」推出「镜像还在」。远端后端被 OOM killer 收走又由
/// 别的链路拉起、或用户在服务器上手动重启，都会让镜像静默消失（世代归零），
/// 而数据面 HTTP 探活照样通过——于是出现最难查的一类故障：连接显示正常，
/// 远端却在用它自己的（通常是空的）模型配置。世代号把这件事变成可判定的。
///
/// 兼容性：任何失败（端点不存在 = 旧远端、非 2xx、body 非 JSON、缺字段、超时）
/// 一律返回 `None`，由调用方按「未知世代」处理（记 0 → 下次比对必然要求重推，
/// 重推是幂等的，多推一次无害；反之把未知当「已同步」会漏掉真丢镜像的场景）。
/// 日志只 warn 一次：本函数会被心跳每 10s 调一次，旧远端上逐轮刷 warn 会把
/// 真正有价值的日志冲走。
pub async fn fetch_generation(local_port: u16, auth_user: &str, auth_pass: &str) -> Option<u64> {
    let url = format!("http://127.0.0.1:{}/web/settings/mirror-state", local_port);
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            warn_generation_once(format!("构造镜像世代查询客户端失败: {}", e));
            return None;
        }
    };
    let resp = match client.get(&url).basic_auth(auth_user, Some(auth_pass)).send().await {
        Ok(r) => r,
        Err(e) => {
            warn_generation_once(format!("镜像世代查询请求失败（{}）: {}", url, e));
            return None;
        }
    };
    if !resp.status().is_success() {
        // 404 = 远端版本没有该端点（旧 jar）；401/403 = 凭据已失效（连接本身也快死了）
        warn_generation_once(format!(
            "远端未提供镜像世代端点（HTTP {}）: {}",
            resp.status().as_u16(),
            url
        ));
        return None;
    }
    let text = resp.text().await.unwrap_or_default();
    match parse_generation_body(&text) {
        Some(gen) => Some(gen),
        None => {
            warn_generation_once(format!(
                "镜像世代响应非预期格式（{}）: {}",
                url,
                truncate(&text, 200)
            ));
            None
        }
    }
}

/// 解析世代响应体（纯函数，便于单测锁口径）。
///
/// 契约：Solon `Result.succeed(data)` 形态 `{code:200, data:{generation:N}}`。
/// 只认 `data.generation`；负数与非法类型均视为「未知」（None）——世代是单调
/// 递增计数，负值只可能是协议漂移，采信它会让比对逻辑得出错误结论。
pub fn parse_generation_body(body: &str) -> Option<u64> {
    let root: serde_json::Value = serde_json::from_str(body).ok()?;
    let raw = root.get("data")?.get("generation")?;
    // 数字优先；字符串形态（部分序列化器把 long 写成字符串）也接受，负数拒绝
    if let Some(n) = raw.as_u64() {
        return Some(n);
    }
    if let Some(n) = raw.as_i64() {
        return u64::try_from(n).ok();
    }
    raw.as_str().and_then(|s| s.trim().parse::<u64>().ok())
}

/// 世代查询失败的日志节流：全局只 warn 一次，之后降为 debug。
///
/// WHY 不用每连接一个标志：心跳每 10s 一轮、多连接并存时仍是同一类信息
/// （「这台远端不支持世代端点」），逐轮或逐连接刷都会淹没日志；用户排查时
/// 需要的是「发生过」而不是「发生了几千次」。
fn warn_generation_once(reason: String) {
    static WARNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if WARNED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        tracing::debug!("[remote] 镜像世代查询失败（已抑制重复告警）: {}", reason);
    } else {
        tracing::warn!(
            "[remote] 镜像世代查询失败（后续同类告警降级为 debug）: {}。\
             远端可能是不支持 /web/settings/mirror-state 的旧版本，\
             此时桌面端按「世代未知」处理：每次复用/心跳都会重推镜像（幂等，无害）",
            reason
        );
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

    /// 世代响应体解析三例：正常 / 非 JSON / 缺字段。
    ///
    /// 为何锁纯函数而不锁 fetch_generation：后者要真远端 + 真凭据，单测里造不出来；
    /// 而解析口径一旦漂移（例如误认顶层 generation），后果是「世代恒未知 → 每轮
    /// 心跳都重推镜像」或「世代恒相等 → 远端丢镜像永不发现」，两个方向都是哑故障。
    #[test]
    fn parse_generation_body_matrix() {
        // ① 正常：Solon Result.succeed(data) 形态
        assert_eq!(
            parse_generation_body(r#"{"code":200,"data":{"generation":7},"description":"ok"}"#),
            Some(7)
        );
        // 世代 0 是合法值（远端进程刚起、尚未 apply 过镜像），不得与「解析失败」混淆
        assert_eq!(
            parse_generation_body(r#"{"code":200,"data":{"generation":0}}"#),
            Some(0)
        );
        // 字符串形态的 long（部分序列化器）同样接受
        assert_eq!(
            parse_generation_body(r#"{"code":200,"data":{"generation":"12"}}"#),
            Some(12)
        );
        // ② 非 JSON（网关/代理返回 HTML 错误页）：None，不得 panic
        assert_eq!(parse_generation_body("<html>502 Bad Gateway</html>"), None);
        assert_eq!(parse_generation_body(""), None);
        // ③ 缺字段：data 缺失 / generation 缺失 / 负数（协议漂移，拒绝采信）
        assert_eq!(parse_generation_body(r#"{"code":200}"#), None);
        assert_eq!(parse_generation_body(r#"{"code":200,"data":{}}"#), None);
        assert_eq!(parse_generation_body(r#"{"code":200,"data":{"generation":-1}}"#), None);
        // 顶层 generation 不算（契约是 data.generation；认顶层会让两种协议形态混用）
        assert_eq!(parse_generation_body(r#"{"code":200,"generation":5}"#), None);
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
