package com.gourdai.core.portal.web.market;

/**
 * 市场分类实体 — 技能市场标签页下的二级分类筛选项。
 *
 * <p>分类 key 使用市场原生值（如 skillhub 的 {@code dev-programming}），
 * 由适配器在 {@link Market#categories()} 中声明；前端按当前语言在
 * {@code name} / {@code nameZh} 之间选择展示文案。</p>
 *
 * @author oisin
 */
public class MarketCategory {
    private String key;
    private String name;    // 英文/默认展示名
    private String nameZh;  // 中文展示名（zh-* 语言环境优先）

    public MarketCategory() {
    }

    public MarketCategory(String key, String name, String nameZh) {
        this.key = key;
        this.name = name;
        this.nameZh = nameZh;
    }

    public MarketCategory key(String key) { this.key = key; return this; }
    public MarketCategory name(String name) { this.name = name; return this; }
    public MarketCategory nameZh(String nameZh) { this.nameZh = nameZh; return this; }

    public String getKey() { return key; }
    public void setKey(String key) { this.key = key; }
    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public String getNameZh() { return nameZh; }
    public void setNameZh(String nameZh) { this.nameZh = nameZh; }
}
