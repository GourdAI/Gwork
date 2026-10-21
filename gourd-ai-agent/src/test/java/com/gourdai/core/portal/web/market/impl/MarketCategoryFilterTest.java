package com.gourdai.core.portal.web.market.impl;

import com.gourdai.core.portal.web.market.MarketItem;
import com.gourdai.core.portal.web.market.MarketPageResult;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;

import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 市场分类过滤与安装目录名/标签解析的单元测试。
 *
 * <p>背景：modelscope OpenAPI 实测忽略 category 参数（total 恒为全量），
 * 分类只能客户端过滤；SkillHub 服务端真过滤（filtered=true 时控制器不得二次过滤）。
 * 本测试锁住这两条契约与目录名口径。</p>
 *
 * @author oisin
 */
public class MarketCategoryFilterTest {

    private static MarketPageResult pageOf(String... categories) {
        List<MarketItem> items = Arrays.stream(categories)
                .map(c -> new MarketItem().slug("s-" + c).category(c))
                .collect(java.util.stream.Collectors.toList());
        return new MarketPageResult(items, "2");
    }

    @Test
    @DisplayName("filterByCategory：只保留匹配项并置 filtered=true")
    void filterKeepsMatches() {
        MarketPageResult page = pageOf("ai-media", "developer-tools", "ai-media");

        MarketPageResult out = ModelscopeMarket.filterByCategory(page, "ai-media");

        assertEquals(2, out.getItems().size(), "应只保留 ai-media 两项");
        assertTrue(out.isFiltered(), "客户端过滤后必须置 filtered，防止控制器二次过滤");
        assertEquals("2", out.getNextCursor(), "游标不得被过滤破坏");
    }

    @Test
    @DisplayName("filterByCategory：空分类/null 页原样返回且不置 filtered")
    void filterNoop() {
        MarketPageResult page = pageOf("ai-media");

        assertSame(page, ModelscopeMarket.filterByCategory(page, ""));
        assertSame(page, ModelscopeMarket.filterByCategory(page, null));
        assertNull(ModelscopeMarket.filterByCategory(null, "ai-media"), "null 页应原样返回 null");
        assertFalse(page.isFiltered());
    }

    @Test
    @DisplayName("Modelscope 安装目录名：@ 与 / 替换为下划线（与 install 口径逐字一致）")
    void modelscopeDirName() {
        ModelscopeMarket market = new ModelscopeMarket();
        assertEquals("_anthropics_pdf", market.installDirName("@anthropics/pdf"));
        assertEquals("plain-skill", market.installDirName("plain-skill"));
        assertEquals("", market.installDirName(null));
    }

    @Test
    @DisplayName("Skillhub 安装目录名：裸 slug 剥离非法字符；限定 slug 的 @ 与 / 换下划线")
    void skillhubDirName() {
        SkillhubMarket market = new SkillhubMarket();
        assertEquals("abc-123_x", market.installDirName("abc-123_x"));
        assertEquals("abcdef", market.installDirName("ab/cd@ef"));
        assertEquals("", market.installDirName(null));
        // namespace 限定 slug：同名技能必须能在磁盘并存，目录名保留 owner 维度
        // （上游实测 skillhub 存在不同作者共用同一公开 slug 的记录）
        assertEquals("_indiv-ebandao_dev-expert", market.installDirName("@indiv-ebandao/dev-expert"));
        assertEquals("_user_814dbe54_dev-expert", market.installDirName("@user_814dbe54/dev-expert"));
        // 退化形态不得进限定分支（owner 或尾段为空 → 回剥离口径）
        assertEquals("dev-expert", market.installDirName("@/dev-expert"));
        assertEquals("a", market.installDirName("@a/"));
    }

    @Test
    @DisplayName("Skillhub isQualifiedSlug：仅 @owner/slug 两侧非空为限定形态")
    void skillhubQualifiedSlugShapes() {
        assertTrue(SkillhubMarket.isQualifiedSlug("@owner/slug"));
        assertTrue(SkillhubMarket.isQualifiedSlug("@user_814dbe54/dev-expert"));
        assertFalse(SkillhubMarket.isQualifiedSlug("dev-expert"), "裸 slug 不是限定形态");
        assertFalse(SkillhubMarket.isQualifiedSlug("@owner"), "无分隔符不是限定形态");
        assertFalse(SkillhubMarket.isQualifiedSlug("@/slug"), "owner 为空不是限定形态");
        assertFalse(SkillhubMarket.isQualifiedSlug("@owner/"), "尾段为空不是限定形态");
        assertFalse(SkillhubMarket.isQualifiedSlug(null));
        assertFalse(SkillhubMarket.isQualifiedSlug("a@o/s"), "非 @ 起首不是限定形态");
    }

    @Test
    @DisplayName("Skillhub parseTags：对象/数组/空形态统一收敛为字符串列表")
    void parseTagsShapes() {
        List<String> fromObject = SkillhubMarket.parseTags(ONode.ofJson("{\"a\":\"x\",\"b\":\"y\"}"));
        assertEquals(Arrays.asList("x", "y"), fromObject);

        List<String> fromArray = SkillhubMarket.parseTags(ONode.ofJson("[\"x\",\"x\",\"y\"]"));
        assertEquals(Arrays.asList("x", "y"), fromArray, "数组形态应去重");

        assertTrue(SkillhubMarket.parseTags(ONode.ofJson("{}")).isEmpty(), "空对象应为空列表");
        assertTrue(SkillhubMarket.parseTags(null).isEmpty(), "null 应为空列表");
    }

    @Test
    @DisplayName("Modelscope categories：非空、key 唯一且与列表项 category 同域")
    void modelscopeCategoriesDeclared() {
        ModelscopeMarket market = new ModelscopeMarket();
        List<com.gourdai.core.portal.web.market.MarketCategory> cats = market.categories().getData();

        assertNotNull(cats);
        assertFalse(cats.isEmpty(), "ModelScope 有 category 字段，分类栏不得再隐藏");
        java.util.Set<String> keys = new java.util.HashSet<>();
        for (com.gourdai.core.portal.web.market.MarketCategory c : cats) {
            assertTrue(keys.add(c.getKey()), "分类 key 不得重复: " + c.getKey());
            assertNotNull(c.getName(), "分类必须有默认展示名");
            assertNotNull(c.getNameZh(), "分类必须有中文展示名");
        }
        // 实测全集抽样中的高频分类必须在列（防分类表与上游脱节）
        assertTrue(keys.contains("developer-tools"));
        assertTrue(keys.contains("ai-media"));
    }

    @Test
    @DisplayName("MarketItem 新增字段：iconUrl/category/version 链式赋值可读回")
    void itemNewFields() {
        MarketItem item = new MarketItem()
                .slug("x")
                .iconUrl("https://img/x.png")
                .category("dev-programming")
                .version("1.2.3");
        assertEquals("https://img/x.png", item.getIconUrl());
        assertEquals("dev-programming", item.getCategory());
        assertEquals("1.2.3", item.getVersion());
    }
}
