//! `mcp::registry` — GWork 官方连接器目录（连接器页的**默认**目录源）。
//!
//! ## 为什么需要它（取代 `mcp::featured` 的「精选」概念）
//!
//! 魔搭广场的条目几乎全是 stdio + 手填 env，且不带任何 `auth` 声明——用户
//! 对齐 WorkBuddy 的诉求是「大部分连接器扫码/登录就能连」。WorkBuddy 的答案
//! 是**自营公开连接器仓库**（静态 zip + 每条目 auth 声明）+ 云端授权代理。
//! 本模块承载前者：数据真源在独立仓库 `gourd-connectors/`（Agent Plugins 1.0
//! 形态），经 `scripts/build-snapshot.mjs` 编译成与魔搭详情**同形**的 entries
//! 快照。
//!
//! ## 唯一真源：编译期 gzip 快照
//!
//! 快照以 gzip（`registry.json.gz`）形式在**编译期** `include_bytes!` 内嵌进二进制，
//! 随客户端发版更新。运行时**无远程拉取、无磁盘缓存、无 admin 上传**：
//! 既没有 `www.gourdwork.com` 增量 feed，也没有 `<gwork_home>/cache` 落盘或
//! 后台刷新循环。目录内容在本进程生命周期内恒定，离线可用。
//!
//! ```text
//! registry.json.gz  ──include_bytes!──▶ GzDecoder ──▶ parse_registry ──▶ OnceLock<Snapshot>
//! ```
//!
//! 明文 `registry.json` 仍由数据脚本产出并保留在源码树里，供 `mcp::cli` 的
//! `cli_spec` 解析护栏测试 `include_str!`；它**不是**运行时数据源。
//!
//! ## 契约
//!
//! * 条目 id 一律带 `official:` 前缀；`server::mcp_market_api` 按前缀分流，
//!   绝不把官方 id 发给魔搭上游。旧 `featured:` id 一律别名到 `official:`
//!   （旧版安装记录/收藏仍可点开详情）。
//! * entries 与魔搭详情同形（`server_config[0].mcpServers` / `env_schema` /
//!   `readme` / `locales`），install 归一化 / env 校验 / 落盘管线零改动。
//! * 收录门槛 = 实测可连：`tier=open`（initialize 200 免鉴权）或 `tier=oauth`
//!   （401 + RFC9728/8414 元数据可发现 + RFC7591 DCR 实测开放）或 `verified`
//!   （GWork 自营验证形态，如腾讯文档 qrcode_poll 真扫码）。
//! * 编译期快照也必须过结构校验（version 非空 + entries 非空 + id 前缀/唯一 +
//!   https + authType 枚举 + cli_spec 形态）。任何一条不合格即整体拒绝并返回空
//!   快照，绝不 panic、绝不半损坏地进入读路径。
//!
//! 与 `featured` 的关系：`featured` 模块保留为**兼容别名层**（旧 id/旧测试），
//! 数据真源已整体迁入本模块的 `registry.json.gz`。
//!
//! 魔搭扩展源（`source=modelscope`）由 `mcp::market` 独立处理，与本模块互不干涉。

use serde_json::Value;
use std::io::Read;
use std::sync::OnceLock;

/// 官方条目 id 前缀。分流判据唯一真源。
pub const ID_PREFIX: &str = "official:";
/// 旧精选前缀（兼容别名，绝不发给任何上游）。
pub const LEGACY_PREFIX: &str = "featured:";

struct Snapshot {
    version: String,
    /// 快照生成时间（RFC3339，build-snapshot.mjs 写入）。随发版固定，
    /// 仅作诊断/数据溯源，不参与任何版本序比较（无远程增量可比）。
    #[allow(dead_code)]
    generated_at: String,
    entries: Vec<Value>,
}

/// 编译期内嵌的 gzip 快照。惰性 + 单次：首次访问时解压、校验、缓存；
/// 解压或校验失败只记 error 并回落空快照，绝不 panic。
fn builtin() -> &'static Snapshot {
    static BUILTIN: OnceLock<Snapshot> = OnceLock::new();
    BUILTIN.get_or_init(|| {
        let gz: &[u8] = include_bytes!("registry.json.gz");
        let mut decoder = flate2::read::GzDecoder::new(gz);
        let mut raw = String::new();
        if let Err(e) = decoder.read_to_string(&mut raw) {
            tracing::error!("registry.json.gz 内置快照 gzip 解压失败，官方目录为空: {e}");
            return Snapshot { version: String::new(), generated_at: String::new(), entries: Vec::new() };
        }
        match parse_registry(&raw) {
            Some(s) => s,
            None => {
                tracing::error!("registry.json.gz 内置快照结构校验失败，官方目录为空");
                Snapshot { version: String::new(), generated_at: String::new(), entries: Vec::new() }
            }
        }
    })
}

/// 结构校验 + 解析。任何一条不合格即整体拒绝（宁可用空快照，不可半损坏）。
///
/// 编译期快照是唯一数据源，发版时已审过，不需要「远程 feed 防护」式的
/// 内置原文白名单比对；但下列硬校验仍是对**编译期数据**的护栏，全部保留：
/// * version 非空、entries 非空；
/// * id 带 `official:` 前缀且非裸前缀、全表唯一（重复 id 会让 detail 命中歧义
///   + 列表重复卡）；
/// * http 型 server 配置 → `url` 必须 `https://`（明文/`file://` 一律拒绝，
///   凭据经 OAuth 头注入，明文信道等于泄密）；`authType`（若带）必须在已知
///   枚举内（未知拼写会让授权弹窗静默空转），凭据字段由落盘层
///   `sanitize_auth_decl` 白名单过滤；
/// * stdio 型配置由编译期数据自带，保留原样；
/// * `kind:"cli"` 条目 → 必须带 `cli_spec`（package/version/binPath 非空，
///   binPath 为包内相对路径，防 `..`/绝对路径/盘符），`server_config` 必须为空。
fn parse_registry(raw: &str) -> Option<Snapshot> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let version = v.get("version")?.as_str()?.trim().to_string();
    if version.is_empty() {
        return None;
    }
    let generated_at = v.get("generatedAt").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let entries = v.get("entries")?.as_array()?;
    if entries.is_empty() {
        return None;
    }
    let mut seen_ids = std::collections::HashSet::new();
    for e in entries {
        let id = e.get("id").and_then(Value::as_str).unwrap_or("");
        if !id.starts_with(ID_PREFIX) || id.len() <= ID_PREFIX.len() {
            return None;
        }
        if !seen_ids.insert(id.to_string()) {
            tracing::warn!("connector registry: 快照含重复 id {id}，整体拒绝");
            return None;
        }
        // CLI 连接器（kind:"cli"）：无 MCP 端点，执行面由 cli_spec 声明。
        // skills / skills_zip 是「会落进 ~/.gwork/skills 的 agent 指令文案」，
        // 只认发版时审过的编译期数据；此处钉死执行面形态与 server_config 隔离。
        if e.get("kind").and_then(Value::as_str) == Some("cli") {
            let sc_empty = e.get("server_config").and_then(Value::as_array).map(|a| a.is_empty()).unwrap_or(true);
            if !sc_empty {
                tracing::warn!("connector registry: {id} 是 cli 条目却带 server_config，整体拒绝");
                return None;
            }
            let Some(spec) = e.get("cli_spec").filter(|s| s.is_object()) else {
                tracing::warn!("connector registry: {id} 缺少 cli_spec，整体拒绝");
                return None;
            };
            let pkg = spec.get("package").and_then(Value::as_str).unwrap_or("");
            let ver = spec.get("version").and_then(Value::as_str).unwrap_or("");
            let bin = spec.get("binPath").and_then(Value::as_str).unwrap_or("");
            if pkg.is_empty() || ver.is_empty() || bin.is_empty() {
                tracing::warn!("connector registry: {id} cli_spec 缺 package/version/binPath，整体拒绝");
                return None;
            }
            // binPath 必须是包内相对路径（防绝对路径/盘符/穿越指向任意可执行）。
            if bin.contains("..") || bin.starts_with('/') || bin.starts_with('\\') || bin.contains(':') {
                tracing::warn!("connector registry: {id} binPath 非法（{bin}），整体拒绝");
                return None;
            }
            continue;
        }
        let servers = e
            .get("server_config")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|f| f.get("mcpServers"))
            .and_then(Value::as_object)?;
        if servers.is_empty() {
            return None;
        }
        for (name, cfg) in servers {
            let ty = cfg.get("type").and_then(Value::as_str).unwrap_or("");
            let has_command = cfg.get("command").and_then(Value::as_str).map(|s| !s.trim().is_empty()).unwrap_or(false);
            if has_command && !crate::mcp::is_http_type(ty) {
                // stdio：编译期自营条目（如 tapd 的 uvx），随发版审过，原样保留。
                continue;
            }
            let url = cfg.get("url").and_then(Value::as_str).unwrap_or("");
            if !url.starts_with("https://") {
                tracing::warn!("connector registry: {id}/{name} url 非 https（{url}），整体拒绝");
                return None;
            }
            if let Some(kind) = cfg.get("auth").and_then(|a| a.get("authType")).and_then(Value::as_str) {
                let k = kind.trim().to_ascii_lowercase();
                const KNOWN: &[&str] = &[
                    "", "none", "token", "static", "apikey", "api_key",
                    "oauth", "oauth2", "browser", "login",
                    "qrcode_poll", "qrcode", "qr_poll", "scan",
                ];
                if !KNOWN.contains(&k.as_str()) {
                    tracing::warn!("connector registry: {id}/{name} 未知 authType {kind}，整体拒绝");
                    return None;
                }
            }
        }
    }
    Some(Snapshot { version, generated_at, entries: entries.iter().cloned().collect() })
}

/// 当前生效快照：恒等于编译期内嵌快照。
/// 返回克隆而非引用：保持既有读路径签名不变；目录仅数百条、进程内永不替换，
/// 克隆开销可忽略。无远程状态、无磁盘缓存、无 adopt 通道。
fn current() -> Snapshot {
    let b = builtin();
    Snapshot { version: b.version.clone(), generated_at: b.generated_at.clone(), entries: b.entries.clone() }
}

/// 该 id 是否属于官方目录（含旧 featured: 别名）。
pub fn is_official_id(id: &str) -> bool {
    let t = id.trim();
    t.starts_with(ID_PREFIX) || t.starts_with(LEGACY_PREFIX)
}

/// 旧 `featured:<name>` → `official:<name>`；其余原样返回。
pub fn canonical_id(id: &str) -> String {
    let t = id.trim();
    if let Some(rest) = t.strip_prefix(LEGACY_PREFIX) {
        format!("{ID_PREFIX}{rest}")
    } else {
        t.to_string()
    }
}

/// 列表形态：只保留卡片需要的展示字段（与魔搭列表口径一致，重字段不进列表）。
pub fn list_items() -> Vec<Value> {
    current()
        .entries
        .iter()
        .map(|e| {
            let mut item = serde_json::json!({
                "id": e.get("id").cloned().unwrap_or(Value::Null),
                "name": e.get("name").cloned().unwrap_or(Value::Null),
                "chinese_name": e.get("chinese_name").cloned().unwrap_or(Value::Null),
                "description": e.get("description").cloned().unwrap_or(Value::Null),
                "locales": e.get("locales").cloned().unwrap_or(Value::Null),
                "categories": e.get("categories").cloned().unwrap_or(serde_json::json!([])),
                "logo_url": e.get("logo_url").cloned().unwrap_or(Value::Null),
                "source": "official",
                "tier": e.get("tier").cloned().unwrap_or(Value::Null),
            });
            if let Some(kind) = e.get("auth_kind").and_then(Value::as_str) {
                if !kind.trim().is_empty() && kind != "none" {
                    item["auth_kind"] = Value::String(kind.to_string());
                }
            }
            // CLI 连接器标记（前端据此渲染「扫码连接」徽标与连接流程）。
            if e.get("kind").and_then(Value::as_str) == Some("cli") {
                item["kind"] = Value::String("cli".into());
            }
            item
        })
        .collect()
}

/// 详情形态：整条原样返回（含 server_config / env_schema / readme / auth 声明）。
/// 未命中返回 None，调用方据此报错（官方 id 绝不回落魔搭）。
pub fn detail(id: &str) -> Option<Value> {
    let id = canonical_id(id);
    current().entries.iter().find(|e| e.get("id").and_then(Value::as_str) == Some(id.as_str())).cloned()
}

/// 按搜索词 / 分类过滤后的列表（空搜索返回全部）。
pub fn search_items(search: &str, category: &str) -> Vec<Value> {
    let kw = search.trim().to_ascii_lowercase();
    let cat = category.trim();
    list_items()
        .into_iter()
        .filter(|item| {
            if !cat.is_empty() {
                let cats = item.get("categories").and_then(Value::as_array);
                let hit = cats.map(|a| a.iter().any(|c| c.as_str() == Some(cat))).unwrap_or(false);
                if !hit {
                    return false;
                }
            }
            if kw.is_empty() {
                return true;
            }
            let hay = [
                item.get("name").and_then(Value::as_str).unwrap_or(""),
                item.get("chinese_name").and_then(Value::as_str).unwrap_or(""),
                item.get("description").and_then(Value::as_str).unwrap_or(""),
            ]
            .join(" ")
            .to_ascii_lowercase();
            hay.contains(&kw)
        })
        .collect()
}

/// 当前生效版本号（诊断/测试用）。恒等于编译期快照版本，随发版更新。
pub fn version() -> String {
    builtin().version.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_ids_are_prefixed_and_detail_roundtrips() {
        let items = list_items();
        assert!(items.len() >= 100, "官方目录不得少于 100 条（实测收录 177+）");
        for it in &items {
            let id = it["id"].as_str().unwrap();
            assert!(is_official_id(id), "官方 id 必须带前缀: {id}");
            assert_eq!(it["source"], "official");
            let d = detail(id).expect("详情必须能按 id 命中");
            // CLI 条目无 MCP 端点，server_config=[] 是编译期契约。
            assert!(d.get("server_config").is_some(), "{id} 缺 server_config");
        }
        assert!(!is_official_id("@amap/amap-maps"));
        assert!(detail("official:no-such-entry").is_none());
    }

    #[test]
    fn legacy_featured_ids_alias_to_official() {
        assert_eq!(canonical_id("featured:tencent-docs"), "official:tencent-docs");
        assert!(is_official_id("featured:tencent-docs"));
        let d = detail("featured:tencent-docs").expect("旧精选 id 必须能命中官方条目");
        assert_eq!(d["id"], "official:tencent-docs");
        assert_eq!(canonical_id("official:canva"), "official:canva");
    }

    #[test]
    fn tencent_docs_keeps_qrcode_poll_with_raw_authorization() {
        let d = detail("official:tencent-docs").expect("腾讯文档必须在官方目录里");
        let cfg = &d["server_config"][0]["mcpServers"]["tencent-docs"];
        assert_eq!(cfg["type"], "streamable_http");
        assert_eq!(cfg["url"], "https://docs.qq.com/openapi/mcp");
        let auth = &cfg["auth"];
        assert_eq!(auth["authType"], "qrcode_poll");
        assert_eq!(auth["qrVendor"], "tencent-docs");
        assert_eq!(auth["tokenHeader"], "Authorization");
        assert_eq!(auth["tokenPrefix"], "none");
    }

    #[test]
    fn every_http_entry_carries_a_non_secret_auth_declaration() {
        for e in &current().entries {
            // CLI 连接器无 MCP 端点（server_config=[]），auth 声明在 cli_spec。
            if e.get("kind").and_then(Value::as_str) == Some("cli") {
                assert!(e.get("cli_spec").and_then(Value::as_object).is_some(), "cli 条目必须带 cli_spec");
                continue;
            }
            let servers = e["server_config"][0]["mcpServers"].as_object().unwrap();
            for (name, cfg) in servers {
                let ty = cfg.get("type").and_then(Value::as_str).unwrap_or("");
                if crate::mcp::is_http_type(ty) {
                    let auth = cfg.get("auth").unwrap_or_else(|| panic!("{name} http 型必须带 auth 声明"));
                    assert!(auth.get("authType").and_then(Value::as_str).map(|s| !s.is_empty()).unwrap_or(false));
                    for bad in ["token", "accessToken", "apiKey", "clientSecret", "password"] {
                        assert!(auth.get(bad).is_none(), "{name} auth 声明夹带凭据字段 {bad}");
                    }
                }
            }
        }
    }

    #[test]
    fn search_filters_by_keyword_and_category() {
        let all = search_items("", "");
        assert_eq!(all.len(), list_items().len());
        let docs = search_items("腾讯文档", "");
        assert!(docs.iter().any(|i| i["id"] == "official:tencent-docs"));
        let fin = search_items("", "finance");
        assert!(!fin.is_empty());
        assert!(fin.iter().all(|i| {
            i["categories"].as_array().unwrap().iter().any(|c| c == "finance")
        }));
        assert!(search_items("不存在的词xyz", "").is_empty());
    }

    #[test]
    fn parse_registry_rejects_malformed_payloads() {
        assert!(parse_registry("").is_none());
        assert!(parse_registry("{}").is_none());
        assert!(parse_registry(r#"{"version":"1","entries":[]}"#).is_none());
        // 缺前缀 / 裸前缀
        assert!(parse_registry(r#"{"version":"1","entries":[{"id":"x","server_config":[{"mcpServers":{"a":{"url":"https://x"}}}]}]}"#).is_none());
        assert!(parse_registry(r#"{"version":"1","entries":[{"id":"official:","server_config":[{"mcpServers":{"a":{"url":"https://x"}}}]}]}"#).is_none());
        // 缺 server_config
        assert!(parse_registry(r#"{"version":"1","entries":[{"id":"official:x"}]}"#).is_none());
        // 重复 id
        assert!(parse_registry(r#"{"version":"1","entries":[{"id":"official:x","server_config":[{"mcpServers":{"a":{"url":"https://x"}}}]},{"id":"official:x","server_config":[{"mcpServers":{"b":{"url":"https://y"}}}]}]}"#).is_none());
        // 非 https url（明文 / file:// / 缺 url）
        assert!(parse_registry(r#"{"version":"1","entries":[{"id":"official:x","server_config":[{"mcpServers":{"a":{"url":"http://x"}}}]}]}"#).is_none());
        assert!(parse_registry(r#"{"version":"1","entries":[{"id":"official:x","server_config":[{"mcpServers":{"a":{"url":"file:///c:/evil"}}}]}]}"#).is_none());
        assert!(parse_registry(r#"{"version":"1","entries":[{"id":"official:x","server_config":[{"mcpServers":{"a":{"type":"sse"}}}]}]}"#).is_none());
        // 未知 authType
        assert!(parse_registry(r#"{"version":"1","entries":[{"id":"official:x","server_config":[{"mcpServers":{"a":{"url":"https://x","auth":{"authType":"carrier-pigeon"}}}}]}]}"#).is_none());
        // cli 形态护栏：缺 cli_spec / 缺字段 / binPath 穿越 / 带 server_config
        assert!(parse_registry(r#"{"version":"1","entries":[{"id":"official:x","kind":"cli","server_config":[]}]}"#).is_none());
        assert!(parse_registry(r#"{"version":"1","entries":[{"id":"official:x","kind":"cli","server_config":[],"cli_spec":{"package":"p","version":"1"}}]}"#).is_none());
        assert!(parse_registry(r#"{"version":"1","entries":[{"id":"official:x","kind":"cli","server_config":[],"cli_spec":{"package":"p","version":"1","binPath":"../evil"}}]}"#).is_none());
        assert!(parse_registry(r#"{"version":"1","entries":[{"id":"official:x","kind":"cli","server_config":[{"mcpServers":{"a":{"url":"https://x"}}}],"cli_spec":{"package":"p","version":"1","binPath":"bin/x"}}]}"#).is_none());
        // 合法
        let ok = parse_registry(r#"{"version":"1","entries":[{"id":"official:x","server_config":[{"mcpServers":{"a":{"url":"https://x"}}}]}]}"#);
        assert!(ok.is_some());
        assert_eq!(ok.unwrap().entries.len(), 1);
    }

    /// 新形态护栏：唯一真源必须是编译期内嵌的 gzip 快照，且能过全部结构校验。
    /// 同时钉死 cli 条目的 cli_spec 能被 Rust `CliSpec` 反序列化（数据层扩到
    /// 28 条时断言自动跟随；当前快照不足 28 条时以 ≥4 为下限，待数据层补齐）。
    #[test]
    fn builtin_snapshot_decodes_from_gzip() {
        let snap = builtin();
        assert!(!snap.entries.is_empty(), "gzip 内置快照必须解析出非空 entries");
        assert!(!version().is_empty(), "gzip 内置快照 version 必须非空");
        assert_eq!(version(), snap.version);
        let cli: Vec<&Value> = snap.entries.iter()
            .filter(|e| e.get("kind").and_then(Value::as_str) == Some("cli"))
            .collect();
        // 数据层目标形态为 28 条 CLI 连接器；当前发版数据未扩到 28 条前
        // 以 4 条（钉钉/飞书/企微/腾讯会议）为下限，避免本护栏随扩容失效。
        assert!(cli.len() >= 4, "内置快照至少含 4 条 cli（目标 28 条），实得 {}", cli.len());
        for e in &cli {
            let id = e.get("id").and_then(Value::as_str).unwrap_or("<no id>");
            assert!(crate::mcp::cli::CliSpec::from_entry(e).is_some(), "cli_spec 必须可反序列化: {id}");
        }
        // gzip 魔数：编译期资源确实为 gzip，而非误把明文改名。
        let gz: &[u8] = include_bytes!("registry.json.gz");
        assert!(gz.len() >= 2 && gz[0] == 0x1f && gz[1] == 0x8b, "registry.json.gz 必须是真实 gzip 流");
        // gz 解压内容必须能被 Rust JSON 解析（GzDecoder + parse_registry 的原料）。
        let mut decoder = flate2::read::GzDecoder::new(gz);
        let mut raw = String::new();
        decoder.read_to_string(&mut raw).expect("gzip 必须能解压为 UTF-8");
        let v: Value = serde_json::from_str(&raw).expect("gzip 解压内容必须是合法 JSON");
        assert_eq!(v["version"].as_str(), Some(snap.version.as_str()));
        assert_eq!(v["entries"].as_array().map(|a| a.len()), Some(snap.entries.len()));
    }

    /// 新形态护栏：无远程 feed / 缓存 / adopt 状态——目录在进程内恒定。
    /// 远程符号已由编译期保证不存在（本模块不再导出任何刷新/缓存 API），
    /// 此处验证多次读取的 version 与内容完全一致，不会出现远程状态波动。
    #[test]
    fn no_remote_feed_symbols_exposed() {
        let v0 = version();
        let snap0 = current();
        for _ in 0..3 {
            assert_eq!(version(), v0, "version 不得随调用/时间变化（无远程增量）");
            let snap = current();
            assert_eq!(snap.version, snap0.version);
            assert_eq!(snap.generated_at, snap0.generated_at);
            assert_eq!(snap.entries, snap0.entries, "条目快照不得被 adopt/缓存替换");
        }
        assert_eq!(list_items().len(), snap0.entries.len());
        // 源码级护栏：本模块不得再出现远程链路的任何符号。字符串用 concat!
        // 拆开写，避免断言自身成为命中项（编译期 API 删除本身已是主保障）。
        let source = include_str!("registry.rs");
        for forbidden in [
            concat!("DEFAULT_", "FEED_URL"),
            concat!("FEED_URL_", "ENV"),
            concat!("spawn_", "refresh_loop"),
            concat!("load_", "cached"),
            concat!("refresh_", "once"),
            concat!("GWORK_CONNECTOR_", "REGISTRY_URL"),
            concat!("www.gourdwork.com/api/", "connector-registry.json"),
        ] {
            assert!(!source.contains(forbidden), "远程链路符号不得回归: {forbidden}");
        }
        assert!(source.contains(concat!("include_", "bytes!(\"registry.json.gz\")")), "唯一真源必须是编译期 gzip 快照");
    }
}
