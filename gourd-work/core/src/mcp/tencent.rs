//! `mcp::tencent` — 腾讯云开发者 MCP 广场适配器（连接器目录源之二）。
//!
//! 来源：SolonCode v2026.11.16/17 新增的连接器市场默认源（`TencentMcpMarket.java`），
//! 本模块按同一份上游契约用 Rust 实现，输出与 `mcp::market`（魔搭）**同形状**的
//! 列表/详情 JSON，让 `server::mcp_market_api` 的归一化/安装链路零分叉复用。
//!
//! 上游契约（实测，匿名，需浏览器 UA + Referer/Origin）：
//! * `POST https://cloud.tencent.com/developer/api/mcp/list-by-search`
//!   body `{keyword?, categoryId?(数字), page?(从1起)}` → `{list:[条目], total:n}`。
//!   **单页固定 30 条**（服务端强制，limit/size 均被忽略）。
//! * `POST .../detail` body `{mcpId:数字}` → 条目对象（含 readme/mcpParams/tools）。
//!   参数错误返回 `{"msg":"参数错误","code":400}`（无 mcpId 字段）。
//! * 分类：内置快照（2026-11-17 `/categories` 实测），不运行期调用。
//!
//! 关键坑（与 SolonCode 同源结论）：
//! * 广场**没有结构化启动命令字段**，stdio/http 配置只能从 `readme` 的代码块解析
//!   （优先 `mcpServers` JSON 片段、需剥 `//` 注释；退化识别 npx/uvx/... 命令行）。
//!   解析不出时 detail 仍成功返回（readme 可看），但 `server_config` 为空数组，
//!   install 会明确报「请按项目文档手动添加」——**绝不猜配置**。
//! * `mcpParams[].isHeader=true` 的参数属于请求头；http 型条目的单个必填头参数
//!   转成 `auth:{authType:"token",tokenHeader,tokenPrefix}` 声明，凭据走
//!   CredentialVault（settings.json 不落密钥）；stdio 型一律当 env。
//! * `https://tcb-api.cloud.tencent.com/mcp/v1` 不是目录接口（云开发托管网关），
//!   不得用来拉目录。

use serde_json::{json, Value};

use super::market::ServerQuery;
use super::market_http;

pub const BASE_URL: &str = "https://cloud.tencent.com/developer/api/mcp";
pub const DETAIL_PAGE_URL: &str = "https://cloud.tencent.com/developer/mcp/server/";
/// 腾讯 BFF 按站点公开接口对待浏览器请求，桌面 UA 会被拒。
pub const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// 上游单页固定 30 条（服务端强制）。我们的对外 pageSize 统一按 30 对齐：
/// 请求 pageSize != 30 时按 offset 换算跨页拼接，避免前端「本页不满」误判。
pub const UPSTREAM_PAGE_SIZE: i64 = 30;

/// 通用到没有辨识度的服务名（广场确实存在这类 mcpName），落盘名兜底时跳过。
const GENERIC_NAMES: &[&str] = &["mcp", "mcps", "sdk", "server", "servers", "mcp-server", "mcp server", "server-mcp"];
/// 命令行兜底解析认可的可执行前缀。
const SHELL_COMMANDS: &[&str] = &["npx", "uvx", "docker", "python", "python3", "node", "java", "uv"];

/// 分类快照（2026-11-17，按源站 weight 倒序）。名称是源站中文原文，
/// 与 SolonCode 同口径原样展示不翻译（name 与 nameZh 同值）。
pub fn categories() -> Value {
    let rows = [
        ("", "全部", "All"),
        ("100", "腾讯产品MCP", "腾讯产品MCP"),
        ("106", "搜索与信息检索", "搜索与信息检索"),
        ("105", "数据库与文件", "数据库与文件"),
        ("107", "支付与交易", "支付与交易"),
        ("108", "位置服务", "位置服务"),
        ("109", "社交媒体", "社交媒体"),
        ("110", "设计与创意", "设计与创意"),
        ("111", "文档工具", "文档工具"),
        ("104", "浏览器自动化", "浏览器自动化"),
        ("112", "内容抓取", "内容抓取"),
        ("101", "开发者工具", "开发者工具"),
        ("113", "其他", "其他"),
    ];
    Value::Array(
        rows.iter()
            .map(|(k, zh, en)| json!({"key": k, "nameZh": zh, "name": en}))
            .collect(),
    )
}

/// 传输抽象：只有 POST 一个动词（腾讯 BFF 全部端点 POST+JSON）。mock 单测不触网。
#[async_trait::async_trait]
pub trait TencentHttp: Send + Sync {
    async fn post_json(&self, url: &str, body: &Value) -> Result<(u16, Value), String>;
}

pub struct ReqwestTencentHttp;

#[async_trait::async_trait]
impl TencentHttp for ReqwestTencentHttp {
    async fn post_json(&self, url: &str, body: &Value) -> Result<(u16, Value), String> {
        market_http::post_json(
            url,
            body,
            BROWSER_UA,
            &[
                ("Referer", "https://cloud.tencent.com/developer/mcp"),
                ("Origin", "https://cloud.tencent.com"),
            ],
            "腾讯云 MCP 广场",
        )
        .await
    }
}

pub struct TencentMcpMarket<H: TencentHttp> {
    http: H,
}

/// 请求体构造（纯函数，单测钉住）：空 keyword/categoryId 整键省略，page=1 省略。
pub fn search_body(q: &ServerQuery, upstream_page: i64) -> Value {
    let mut body = serde_json::Map::new();
    let kw = q.search.trim();
    if !kw.is_empty() {
        body.insert("keyword".into(), json!(kw));
    }
    let cat = q.category.trim();
    if !cat.is_empty() {
        // 上游收数字；非数字原样传（防御未来改成字符串 id）。
        match cat.parse::<i64>() {
            Ok(n) => body.insert("categoryId".into(), json!(n)),
            Err(_) => body.insert("categoryId".into(), json!(cat)),
        };
    }
    if upstream_page > 1 {
        body.insert("page".into(), json!(upstream_page));
    }
    Value::Object(body)
}

/// 列表条目 → 魔搭同形状（id 带 `tencent:` 前缀防跨源撞号；name=title 优先）。
pub fn to_item(node: &Value) -> Option<Value> {
    let raw_id = match node.get("mcpId") {
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
        _ => return None,
    };
    let mcp_name = str_of(node, "mcpName");
    let title = str_of(node, "title");
    let display = if !title.is_empty() { title } else { mcp_name.clone() };
    Some(json!({
        "id": format!("tencent:{}", raw_id),
        "name": if display.is_empty() { raw_id.clone() } else { display.clone() },
        "chinese_name": display,
        "description": str_of(node, "abstract"),
        "logo_url": str_of(node, "iconUrl"),
        "view_count": node.get("readNum").cloned().unwrap_or(json!(0)),
        "is_verified": node.get("isVerified").and_then(Value::as_bool).unwrap_or(false),
        "publisher": str_of(node, "srcAuthor"),
        "homepage": str_of(node, "srcUrl"),
        "categories": [],
        "auth_kind": "",
    }))
}

fn str_of(node: &Value, key: &str) -> String {
    node.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string()
}

/// 解析出的启动方式（readme 代码块 → 结构化配置）。
#[derive(Debug, Default, Clone)]
pub struct Startup {
    pub key: String,
    pub kind: String, // 原始 type 拼写（可能为空）
    pub url: String,
    pub command: String,
    pub args: Vec<String>,
    /// stdio 的 env / http 的 headers（readme 片段里写死的值）。
    pub env: std::collections::BTreeMap<String, String>,
}

impl<H: TencentHttp> TencentMcpMarket<H> {
    pub fn new(http: H) -> Self {
        Self { http }
    }

    fn unpack(status: u16, body: Value) -> Result<Value, String> {
        if !(200..300).contains(&status) {
            return Err(format!("腾讯云 MCP 广场返回 HTTP {}", status));
        }
        // 参数错误信封 {"msg":"参数错误","code":400}：HTTP 200 但业务失败。
        if body.get("code").and_then(Value::as_i64).map(|c| c != 0 && c != 200).unwrap_or(false) {
            let msg = body.get("msg").and_then(Value::as_str).unwrap_or("腾讯云 MCP 广场返回失败");
            return Err(msg.to_string());
        }
        Ok(body)
    }

    /// 列表/搜索/分类 → 魔搭同形状 `{total_count, mcp_server_list, page_number, page_size}`。
    ///
    /// 上游单页固定 30：对外 pageSize 钳到 1..60，offset=(page-1)*pageSize，
    /// 跨上游页拼接切片。total 缺失时退化为「按本页是否满页判断」（total=-1 语义
    /// 由前端 items.length 判定兜底，这里回传已拿到的条数）。
    pub async fn servers(&self, q: &ServerQuery) -> Result<Value, String> {
        let page = q.page.max(1);
        let size = q.page_size.clamp(1, 60);
        let offset = (page - 1) * size;
        let first_up = offset / UPSTREAM_PAGE_SIZE + 1;
        let skip = (offset % UPSTREAM_PAGE_SIZE) as usize;
        let need = (skip + size as usize + UPSTREAM_PAGE_SIZE as usize - 1) / UPSTREAM_PAGE_SIZE as usize;

        let mut collected: Vec<Value> = Vec::new();
        let mut total: i64 = -1;
        for i in 0..need as i64 {
            let up_page = first_up + i;
            let body = search_body(q, up_page);
            let (status, raw) = self.http.post_json(&format!("{}/list-by-search", BASE_URL), &body).await?;
            let data = Self::unpack(status, raw)?;
            if let Some(t) = data.get("total").and_then(Value::as_i64) {
                if t > 0 {
                    total = t;
                }
            }
            let list = data.get("list").and_then(Value::as_array).cloned().unwrap_or_default();
            let full = list.len() as i64 == UPSTREAM_PAGE_SIZE;
            for node in &list {
                if let Some(item) = to_item(node) {
                    collected.push(item);
                }
            }
            if !full {
                break; // 上游已到最后一页
            }
        }
        let items: Vec<Value> = collected.into_iter().skip(skip).take(size as usize).collect();
        if total < 0 {
            // 无 total：用「offset+本页条数（满页再+1 暗示还有）」近似，前端
            // hasMore 判据 items.length >= page*pageSize 仍然成立。
            total = offset + items.len() as i64 + if items.len() as i64 == size { 1 } else { 0 };
        }
        Ok(json!({
            "total_count": total,
            "mcp_server_list": items,
            "page_number": page,
            "page_size": size,
        }))
    }

    /// 详情 → 魔搭同形状（server_config / env_schema / readme / logo_url …）。
    ///
    /// readme 解析不出启动配置时 `server_config: []`（详情可看、install 明确报错），
    /// 不猜配置 —— 与 SolonCode 的「请按项目文档手动添加」同一红线。
    pub async fn detail(&self, id: &str) -> Result<Value, String> {
        let raw_id = id.trim().trim_start_matches("tencent:");
        if raw_id.is_empty() {
            return Err("id is required".into());
        }
        let mcp_id: Value = match raw_id.parse::<i64>() {
            Ok(n) => json!(n),
            Err(_) => json!(raw_id),
        };
        let (status, raw) = self
            .http
            .post_json(&format!("{}/detail", BASE_URL), &json!({"mcpId": mcp_id}))
            .await?;
        let node = Self::unpack(status, raw)?;
        if node.get("mcpId").map(|v| v.is_null()).unwrap_or(true) {
            return Err(format!("连接器不存在: {}", id));
        }
        let mut item = to_item(&node).ok_or_else(|| format!("连接器不存在: {}", id))?;
        // readme：中文正文在 readme，英文原文在 rawReadme。塞进 locales 让前端
        // pickReadme 按界面语言选取（与魔搭 locales 同机制，前端零分叉）。
        let readme = str_of(&node, "readme");
        let raw_readme = str_of(&node, "rawReadme");
        item["readme"] = json!(if !readme.is_empty() { readme.clone() } else { raw_readme.clone() });
        item["locales"] = json!({"zh": {"readme": readme}, "en": {"readme": raw_readme}});
        item["homepage"] = json!(str_of(&node, "srcUrl"));
        item["detail_page"] = json!(format!("{}{}", DETAIL_PAGE_URL, raw_id));

        let startup = parse_startup(&item["readme"].as_str().unwrap_or("").to_string());
        match startup {
            Some(s) => {
                let (cfg, schema, auth_kind) = build_config(&node, &s, &item);
                let key = server_key(&s, &item);
                item["server_config"] = json!([{"mcpServers": {key: cfg}}]);
                item["env_schema"] = schema;
                item["auth_kind"] = json!(auth_kind);
            }
            None => {
                item["server_config"] = json!([]);
                item["env_schema"] = Value::Null;
            }
        }
        Ok(item)
    }

    pub fn categories(&self) -> Value {
        categories()
    }
}

/// 落盘服务名：readme 片段 key 优先（通常是包名）→ mcpName → 标题；
/// 通用词（mcp/server/sdk…）跳过，最后兜底 `tencent-<id>`。合法化 [a-z0-9_-]≤48。
fn server_key(s: &Startup, item: &Value) -> String {
    let raw_id = item["id"].as_str().unwrap_or("").trim_start_matches("tencent:").to_string();
    for cand in [
        s.key.clone(),
        item.get("publisher").and_then(Value::as_str).unwrap_or("").to_string(),
        item["name"].as_str().unwrap_or("").to_string(),
    ] {
        let c = cand.trim();
        if c.is_empty() || GENERIC_NAMES.contains(&c.to_ascii_lowercase().as_str()) {
            continue;
        }
        let clean = sanitize_name(c);
        if !clean.is_empty() {
            return clean;
        }
    }
    format!("tencent-{}", raw_id)
}

pub fn sanitize_name(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else if c == ' ' || c == '.' || c == '/' {
            out.push('-');
        }
        if out.len() >= 48 {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

/// readme 片段 + mcpParams → (server 配置, env_schema, auth_kind)。
///
/// * stdio：mcpParams 全部当 env（isHeader 在 stdio 无意义）；
/// * http：isHeader 参数进 headers。单个必填头参数 → token 认证声明
///   （tokenHeader=fieldName，tokenPrefix 从 placeholder 的 "Bearer xxx" 提取），
///   凭据由 CredentialVault 注入，settings.json 不落密钥。多个头参数无法用
///   单 token 声明表达 → 保持明文 headers 占位（用户经「手动添加 MCP」补），
///   并把它们放进 env_schema 之外的提示（readme 已含指引）。
fn build_config(node: &Value, s: &Startup, item: &Value) -> (Value, Value, &'static str) {
    let is_http = !s.url.is_empty();
    let params: Vec<&Value> = node
        .get("mcpParams")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|p| {
                    !str_of(p, "fieldName").is_empty()
                        && p.get("userVisible").and_then(Value::as_bool) != Some(false)
                })
                .collect()
        })
        .unwrap_or_default();

    if !is_http {
        // stdio：env 承载全部参数。
        let mut env = s.env.clone();
        let mut props = serde_json::Map::new();
        let mut required: Vec<String> = Vec::new();
        for p in &params {
            let name = str_of(p, "fieldName");
            let default = str_of(p, "defaultValue");
            let placeholder = is_placeholder(&default);
            let mut spec = serde_json::Map::new();
            let hint = str_of(p, "placeholder");
            if !hint.is_empty() {
                spec.insert("description".into(), json!(hint));
            }
            if !placeholder {
                spec.insert("default".into(), json!(default.clone()));
                env.entry(name.clone()).or_insert(default);
            } else {
                env.entry(name.clone()).or_insert_with(String::new);
            }
            if p.get("required").and_then(Value::as_bool) == Some(true) && placeholder {
                required.push(name.clone());
            }
            props.insert(name, Value::Object(spec));
        }
        // readme 片段里写死的 env 值不向用户索要（已在 s.env）。
        let schema = if props.is_empty() {
            Value::Null
        } else {
            json!({"properties": props, "required": required})
        };
        let cfg = json!({
            "type": "stdio",
            "command": s.command,
            "args": s.args,
            "env": env,
        });
        return (cfg, schema, "");
    }

    // http 型
    let kind = crate::mcp::standardize(&s.kind).unwrap_or_default();
    let kind = if crate::mcp::is_http_type(&kind) { kind } else { crate::mcp::TYPE_STREAMABLE.to_string() };
    let mut headers = s.env.clone();
    let header_params: Vec<&Value> = params
        .iter()
        .copied()
        .filter(|p| p.get("isHeader").and_then(Value::as_bool) == Some(true))
        .collect();
    let pending_headers: Vec<&&Value> = header_params
        .iter()
        .filter(|p| {
            let d = str_of(p, "defaultValue");
            d.is_empty() || is_placeholder(&d)
        })
        .collect();

    // 单个待填头参数 → token 认证声明（凭据走 vault，不落 settings.json）。
    if pending_headers.len() == 1 {
        let p = pending_headers[0];
        let name = str_of(p, "fieldName");
        let hint = str_of(p, "placeholder");
        let prefix = scheme_prefix(&hint);
        let mut auth = serde_json::Map::new();
        auth.insert("authType".into(), json!("token"));
        auth.insert("tokenHeader".into(), json!(name.clone()));
        auth.insert("tokenPrefix".into(), json!(if prefix.is_empty() { "none".to_string() } else { prefix.trim().to_string() }));
        if !hint.is_empty() {
            auth.insert("tokenLabel".into(), json!(hint.clone()));
        }
        let home = item.get("homepage").and_then(Value::as_str).unwrap_or("");
        let detail_page = item.get("detail_page").and_then(Value::as_str).unwrap_or("");
        let help = if !home.is_empty() { home } else { detail_page };
        if !help.is_empty() {
            auth.insert("tokenHelpUrl".into(), json!(help));
        }
        // 其余已有默认值的头参数照写（非密钥）。
        for p in &header_params {
            let d = str_of(p, "defaultValue");
            if !d.is_empty() && !is_placeholder(&d) {
                headers.entry(str_of(p, "fieldName")).or_insert(d);
            }
        }
        let cfg = json!({
            "type": kind,
            "url": s.url,
            "headers": headers,
            "auth": Value::Object(auth),
        });
        return (cfg, Value::Null, "token");
    }

    // 0 个或多个待填头参数：明文 headers（占位值置空，用户手动补）。
    for p in &header_params {
        let d = str_of(p, "defaultValue");
        headers
            .entry(str_of(p, "fieldName"))
            .or_insert(if is_placeholder(&d) { String::new() } else { d });
    }
    let cfg = json!({"type": kind, "url": s.url, "headers": headers});
    (cfg, Value::Null, "")
}

/// 占位值判定（SolonCode 同口径）：<...>、YOUR_xxx、your-、替换/必填 等。
pub fn is_placeholder(v: &str) -> bool {
    let v = v.trim();
    if v.is_empty() {
        return true;
    }
    if v.starts_with('<') && v.ends_with('>') {
        return true;
    }
    let lower = v.to_ascii_lowercase();
    lower.starts_with("your_")
        || lower.starts_with("your-")
        || lower.contains("your_api")
        || v.contains("替换")
        || v.contains("必填")
        || lower == "xxx"
        || lower.contains("your key")
        || lower.contains("your-key")
}

/// 从 placeholder 提取鉴权前缀（"Bearer xxx" → "Bearer "；无前缀 → ""）。
pub fn scheme_prefix(placeholder: &str) -> String {
    let t = placeholder.trim();
    for scheme in ["Bearer ", "Basic ", "Token "] {
        // get(..len) 而非直接切片：placeholder 多为中文，字节索引可能落在
        // 多字节字符中间（直接切片会 panic）。
        if let Some(head) = t.get(..scheme.len()) {
            if t.len() > scheme.len() && head.eq_ignore_ascii_case(scheme) {
                return scheme.to_string();
            }
        }
    }
    String::new()
}

// ─── readme 启动片段解析（SolonCode parseStartup 的 Rust 移植） ────────────────

/// 按 ``` 切分代码块（奇数位为块内容），剥掉紧跟的 language 标记。
pub fn split_code_blocks(text: &str) -> Vec<String> {
    let parts: Vec<&str> = text.split("```").collect();
    let mut blocks = Vec::new();
    let mut i = 1;
    while i < parts.len() {
        let mut body = parts[i].to_string();
        if let Some(line_end) = body.find('\n') {
            let head = body[..line_end].trim();
            let is_lang = head.is_empty()
                || (head.len() <= 16
                    && head.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '+' || c == '-'));
            if is_lang {
                body = body[line_end + 1..].to_string();
            }
        }
        blocks.push(body);
        i += 2;
    }
    blocks
}

/// 剥离 JSON 里的 // 与 /* */ 注释（字符串内的不动）。
pub fn strip_json_comments(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut in_line = false;
    let mut in_block = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = if i + 1 < chars.len() { chars[i + 1] } else { '\0' };
        if in_line {
            if c == '\n' {
                in_line = false;
                out.push(c);
            }
            i += 1;
            continue;
        }
        if in_block {
            if c == '*' && next == '/' {
                in_block = false;
                i += 1;
            }
            i += 1;
            continue;
        }
        if in_string {
            out.push(c);
            if c == '\\' && next != '\0' {
                out.push(next);
                i += 1;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_string = true;
            out.push(c);
        } else if c == '/' && next == '/' {
            in_line = true;
            i += 1;
        } else if c == '/' && next == '*' {
            in_block = true;
            i += 1;
        } else {
            out.push(c);
        }
        i += 1;
    }
    out
}

/// 极简分词：支持单双引号包裹的参数。
pub fn tokenize(line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut buf = String::new();
    let mut quote = '\0';
    for c in line.chars() {
        if quote != '\0' {
            if c == quote {
                quote = '\0';
            } else {
                buf.push(c);
            }
        } else if c == '"' || c == '\'' {
            quote = c;
        } else if c.is_whitespace() {
            if !buf.is_empty() {
                tokens.push(std::mem::take(&mut buf));
            }
        } else {
            buf.push(c);
        }
    }
    if !buf.is_empty() {
        tokens.push(buf);
    }
    tokens
}

/// readme → 启动方式：mcpServers JSON 片段优先，命令行兜底；解析不出返回 None。
pub fn parse_startup(readme: &str) -> Option<Startup> {
    if readme.trim().is_empty() {
        return None;
    }
    let blocks = split_code_blocks(readme);
    for block in &blocks {
        if block.contains("mcpServers") {
            if let Some(s) = parse_mcp_servers_json(block) {
                return Some(s);
            }
        }
    }
    for block in &blocks {
        if let Some(s) = parse_command_line(block) {
            return Some(s);
        }
    }
    None
}

fn parse_mcp_servers_json(block: &str) -> Option<Startup> {
    let json_text = strip_json_comments(block);
    let json_text = json_text.trim();
    let start = json_text.find('{')?;
    let end = json_text.rfind('}')?;
    if end <= start {
        return None;
    }
    let root: Value = serde_json::from_str(&json_text[start..=end]).ok()?;
    let servers = root.get("mcpServers")?.as_object()?;
    let (key, picked) = servers.iter().find(|(_, v)| v.is_object())?;
    let mut s = Startup {
        key: key.clone(),
        kind: str_of(picked, "type"),
        ..Default::default()
    };
    let url = str_of(picked, "url");
    let command = str_of(picked, "command");
    if !url.is_empty() {
        s.url = url;
        if let Some(h) = picked.get("headers").and_then(Value::as_object) {
            for (k, v) in h {
                s.env.insert(k.clone(), value_to_string(v));
            }
        }
    } else if !command.is_empty() {
        s.command = command;
        if let Some(a) = picked.get("args").and_then(Value::as_array) {
            s.args = a.iter().map(value_to_string).collect();
        }
        if let Some(e) = picked.get("env").and_then(Value::as_object) {
            for (k, v) in e {
                s.env.insert(k.clone(), value_to_string(v));
            }
        }
    } else {
        return None;
    }
    Some(s)
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn parse_command_line(block: &str) -> Option<Startup> {
    for raw in block.split('\n') {
        let mut line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
            continue;
        }
        if let Some(rest) = line.strip_prefix("$ ") {
            line = rest.trim_start();
        } else if let Some(rest) = line.strip_prefix("> ") {
            line = rest.trim_start();
        }
        if let Some(rest) = line.strip_prefix("sudo ") {
            line = rest.trim_start();
        }
        let tokens = tokenize(line);
        if tokens.len() < 2 {
            continue;
        }
        if !SHELL_COMMANDS.contains(&tokens[0].as_str()) {
            continue;
        }
        return Some(Startup {
            command: tokens[0].clone(),
            args: tokens[1..].to_vec(),
            kind: "stdio".into(),
            ..Default::default()
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct MockHttp {
        responses: Mutex<Vec<(u16, Value)>>,
        calls: Mutex<Vec<(String, Value)>>,
    }
    impl MockHttp {
        fn new(responses: Vec<(u16, Value)>) -> Self {
            Self { responses: Mutex::new(responses), calls: Mutex::new(Vec::new()) }
        }
    }
    #[async_trait::async_trait]
    impl TencentHttp for MockHttp {
        async fn post_json(&self, url: &str, body: &Value) -> Result<(u16, Value), String> {
            self.calls.lock().unwrap().push((url.to_string(), body.clone()));
            let mut r = self.responses.lock().unwrap();
            if r.is_empty() {
                return Err("mock exhausted".into());
            }
            Ok(r.remove(0))
        }
    }

    fn q(search: &str, page: i64, size: i64, cat: &str) -> ServerQuery {
        ServerQuery { search: search.into(), page, page_size: size, category: cat.into(), hosted: false }
    }

    #[test]
    fn search_body_omits_empty_keys_and_first_page() {
        let b = search_body(&q("", 1, 20, ""), 1);
        assert_eq!(b, json!({}));
        let b = search_body(&q("地图", 1, 20, "108"), 2);
        assert_eq!(b, json!({"keyword": "地图", "categoryId": 108, "page": 2}));
    }

    #[test]
    fn item_shape_matches_modelscope_and_prefixes_id() {
        let node = json!({"mcpId": 10011, "mcpName": "xhs", "title": "小红书MCP", "abstract": "d",
            "iconUrl": "https://i/x.png", "readNum": 42, "isVerified": true, "srcAuthor": "a", "srcUrl": "https://h"});
        let item = to_item(&node).unwrap();
        assert_eq!(item["id"], json!("tencent:10011"));
        assert_eq!(item["name"], json!("小红书MCP"));
        assert_eq!(item["chinese_name"], json!("小红书MCP"));
        assert_eq!(item["logo_url"], json!("https://i/x.png"));
        assert_eq!(item["view_count"], json!(42));
        assert!(to_item(&json!({"mcpName": "no-id"})).is_none());
    }

    #[tokio::test]
    async fn servers_spans_upstream_pages_by_offset() {
        // 对外 pageSize=20，page=2 → offset 20：上游第 1 页(30条)取后 10 + 第 2 页前 10。
        let page1: Vec<Value> = (1..=30).map(|i| json!({"mcpId": i, "title": format!("s{}", i)})).collect();
        let page2: Vec<Value> = (31..=60).map(|i| json!({"mcpId": i, "title": format!("s{}", i)})).collect();
        let mock = MockHttp::new(vec![
            (200, json!({"list": page1, "total": 1060})),
            (200, json!({"list": page2, "total": 1060})),
        ]);
        let m = TencentMcpMarket::new(mock);
        let data = m.servers(&q("", 2, 20, "")).await.unwrap();
        assert_eq!(data["total_count"], json!(1060));
        let list = data["mcp_server_list"].as_array().unwrap();
        assert_eq!(list.len(), 20);
        assert_eq!(list[0]["id"], json!("tencent:21"));
        assert_eq!(list[19]["id"], json!("tencent:40"));
        let calls = m.http.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].1, json!({}));
        assert_eq!(calls[1].1, json!({"page": 2}));
    }

    #[tokio::test]
    async fn servers_reports_business_error_envelope() {
        let mock = MockHttp::new(vec![(200, json!({"msg": "参数错误", "code": 400}))]);
        let m = TencentMcpMarket::new(mock);
        let err = m.servers(&q("", 1, 20, "")).await.unwrap_err();
        assert!(err.contains("参数错误"), "{}", err);
    }

    #[test]
    fn strip_comments_keeps_urls_inside_strings() {
        let src = r#"{"mcpServers":{"a":{"url":"https://x/mcp", // note
            "env":{"K":"v" /* block */}}}}"#;
        let cleaned = strip_json_comments(src);
        let v: Value = serde_json::from_str(&cleaned).unwrap();
        assert_eq!(v["mcpServers"]["a"]["url"], json!("https://x/mcp"));
    }

    #[test]
    fn parse_startup_prefers_mcp_servers_json() {
        let readme = "intro\n```json\n{\"mcpServers\":{\"amap\":{\"url\":\"https://mcp.amap.com/sse\",\"type\":\"sse\"}}}\n```\ntail";
        let s = parse_startup(readme).unwrap();
        assert_eq!(s.key, "amap");
        assert_eq!(s.url, "https://mcp.amap.com/sse");
        assert_eq!(s.kind, "sse");
    }

    #[test]
    fn parse_startup_falls_back_to_command_line() {
        let readme = "# install\n```bash\n$ npx -y @some/mcp-server --port 3000\n```";
        let s = parse_startup(readme).unwrap();
        assert_eq!(s.command, "npx");
        assert_eq!(s.args, vec!["-y", "@some/mcp-server", "--port", "3000"]);
    }

    #[test]
    fn parse_startup_returns_none_when_nothing_parseable() {
        assert!(parse_startup("just text, no code").is_none());
        assert!(parse_startup("```bash\npip install xhs-mcp-server\n```").is_none(),
            "pip 不在认可前缀里，不得猜配置");
    }

    #[tokio::test]
    async fn detail_http_single_header_param_becomes_token_auth_decl() {
        let node = json!({
            "mcpId": 10039, "mcpName": "maps", "title": "地图MCP", "abstract": "d",
            "readme": "```json\n{\"mcpServers\":{\"maps\":{\"type\":\"streamable_http\",\"url\":\"https://m.example/mcp\"}}}\n```",
            "rawReadme": "en readme",
            "mcpParams": [{"fieldName": "Authorization", "placeholder": "Bearer 你的密钥", "required": true, "isHeader": true, "userVisible": true}],
            "srcUrl": "https://home",
        });
        let mock = MockHttp::new(vec![(200, node)]);
        let m = TencentMcpMarket::new(mock);
        let d = m.detail("tencent:10039").await.unwrap();
        assert_eq!(d["id"], json!("tencent:10039"));
        assert_eq!(d["auth_kind"], json!("token"));
        let cfg = &d["server_config"][0]["mcpServers"]["maps"];
        // standardize 把上游别名 streamable_http 归一成标准 kind：streamable。
        assert_eq!(cfg["type"], json!("streamable"));
        assert_eq!(cfg["auth"]["authType"], json!("token"));
        assert_eq!(cfg["auth"]["tokenHeader"], json!("Authorization"));
        assert_eq!(cfg["auth"]["tokenPrefix"], json!("Bearer"));
        assert_eq!(cfg["auth"]["tokenHelpUrl"], json!("https://home"));
        // env_schema 为空：http 型不向用户索要 env（护栏同源）。
        assert!(d["env_schema"].is_null());
        // 请求体 mcpId 必须是数字。
        let calls = m.http.calls.lock().unwrap();
        assert_eq!(calls[0].1, json!({"mcpId": 10039}));
    }

    #[tokio::test]
    async fn detail_stdio_params_become_env_schema() {
        let node = json!({
            "mcpId": 7, "mcpName": "srv", "title": "服务",
            "readme": "```json\n{\"mcpServers\":{\"srv\":{\"command\":\"npx\",\"args\":[\"-y\",\"some-mcp\"],\"env\":{\"BASE\":\"https://api\"}}}}\n```",
            "mcpParams": [
                {"fieldName": "API_KEY", "placeholder": "请输入密钥", "required": true, "isHeader": false},
                {"fieldName": "REGION", "defaultValue": "cn", "required": false}
            ],
        });
        let mock = MockHttp::new(vec![(200, node)]);
        let m = TencentMcpMarket::new(mock);
        let d = m.detail("7").await.unwrap();
        let cfg = &d["server_config"][0]["mcpServers"]["srv"];
        assert_eq!(cfg["type"], json!("stdio"));
        assert_eq!(cfg["env"]["BASE"], json!("https://api"));
        assert_eq!(cfg["env"]["REGION"], json!("cn"));
        assert_eq!(d["env_schema"]["required"], json!(["API_KEY"]));
        assert!(d["env_schema"]["properties"]["API_KEY"].is_object());
        assert_eq!(d["env_schema"]["properties"]["REGION"]["default"], json!("cn"));
    }

    #[tokio::test]
    async fn detail_without_parseable_config_keeps_empty_server_config() {
        let node = json!({"mcpId": 9, "title": "只有文档", "readme": "no code blocks here"});
        let mock = MockHttp::new(vec![(200, node)]);
        let m = TencentMcpMarket::new(mock);
        let d = m.detail("9").await.unwrap();
        assert_eq!(d["server_config"], json!([]), "解析不出配置绝不猜，install 侧明确报错");
    }

    #[tokio::test]
    async fn detail_missing_mcp_id_is_an_error_not_fake_success() {
        let mock = MockHttp::new(vec![(200, json!({"msg": "参数错误", "code": 400}))]);
        let m = TencentMcpMarket::new(mock);
        assert!(m.detail("999").await.is_err());
    }

    #[test]
    fn placeholder_and_prefix_helpers() {
        assert!(is_placeholder("<your-key>"));
        assert!(is_placeholder("YOUR_API_KEY"));
        assert!(is_placeholder("请替换为真实值"));
        assert!(!is_placeholder("cn-hangzhou"));
        assert_eq!(scheme_prefix("Bearer xxx"), "Bearer ");
        assert_eq!(scheme_prefix("请输入腾讯云 SecretId"), "");
    }

    #[test]
    fn categories_snapshot_has_all_plus_12() {
        let cats = categories();
        let arr = cats.as_array().unwrap();
        assert_eq!(arr.len(), 13);
        assert_eq!(arr[0]["key"], json!(""));
        assert_eq!(arr[1]["key"], json!("100"));
    }

    #[test]
    fn server_key_skips_generic_names() {
        let s = Startup { key: "mcp".into(), ..Default::default() };
        // 中文名合法化后为空 → 兜底 tencent-<id>，绝不落一个空名。
        let item = json!({"id": "tencent:42", "name": "地图服务", "publisher": ""});
        assert_eq!(server_key(&s, &item), "tencent-42");
        let s2 = Startup { key: "amap-maps".into(), ..Default::default() };
        assert_eq!(server_key(&s2, &item), "amap-maps");
    }
}