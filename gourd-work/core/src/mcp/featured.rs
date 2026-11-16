//! `mcp::featured` — 旧「自营精选目录」的**兼容别名层**。
//!
//! 2026-11 用户拍板：砍掉「精选」概念，数据真源整体迁入 `mcp::registry`
//! （GWork 官方连接器仓库，`official:` 前缀，仅编译期内置快照，随发版更新）。
//! 本模块只保留旧 API 形状，把调用转发到 registry，并把旧 `featured:` id
//! 别名到 `official:`——旧版安装记录 / 前端缓存里的精选 id 仍可点开详情。
//!
//! **新代码一律直接用 `mcp::registry`，不要再引用本模块。**

use serde_json::Value;

/// 旧精选前缀。分流判据见 `registry::is_official_id`（含本前缀别名）。
pub const ID_PREFIX: &str = "featured:";

/// 该 id 是否属于旧精选（等价于官方目录的旧别名）。
pub fn is_featured_id(id: &str) -> bool {
    id.trim().starts_with(ID_PREFIX)
}

/// 列表形态（转发 registry；source 标记保持旧值以兼容旧前端缓存）。
pub fn list_items() -> Vec<Value> {
    crate::mcp::registry::list_items()
        .into_iter()
        .map(|mut it| {
            if let Some(id) = it.get("id").and_then(Value::as_str) {
                if let Some(rest) = id.strip_prefix(crate::mcp::registry::ID_PREFIX) {
                    it["id"] = Value::String(format!("{ID_PREFIX}{rest}"));
                }
            }
            it["source"] = Value::String("featured".into());
            it["featured"] = Value::Bool(true);
            it
        })
        .collect()
}

/// 详情形态：旧 id 别名到官方条目后转发。
pub fn detail(id: &str) -> Option<Value> {
    crate::mcp::registry::detail(id)
}

/// 按搜索词 / 分类过滤（转发）。
pub fn search_items(search: &str, category: &str) -> Vec<Value> {
    let items = crate::mcp::registry::search_items(search, category);
    items
        .into_iter()
        .map(|mut it| {
            if let Some(id) = it.get("id").and_then(Value::as_str) {
                if let Some(rest) = id.strip_prefix(crate::mcp::registry::ID_PREFIX) {
                    it["id"] = Value::String(format!("{ID_PREFIX}{rest}"));
                }
            }
            it["source"] = Value::String("featured".into());
            it["featured"] = Value::Bool(true);
            it
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_api_aliases_to_official_registry() {
        let items = list_items();
        assert!(!items.is_empty());
        for it in &items {
            assert!(is_featured_id(it["id"].as_str().unwrap()));
            assert_eq!(it["source"], "featured");
        }
        let d = detail("featured:tencent-docs").expect("旧 id 必须命中");
        assert_eq!(d["id"], "official:tencent-docs");
        assert!(detail("featured:no-such-entry").is_none());
        let docs = search_items("腾讯文档", "");
        assert!(docs.iter().any(|i| i["id"] == "featured:tencent-docs"));
    }
}