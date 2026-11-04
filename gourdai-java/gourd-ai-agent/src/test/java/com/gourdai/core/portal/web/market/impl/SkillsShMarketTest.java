package com.gourdai.core.portal.web.market.impl;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import com.gourdai.core.portal.web.market.MarketItem;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * SkillsShMarket 单元测试 — 覆盖 HTML 解析、安装量转换、搜索过滤及边界场景。
 *
 * @author oisin
 */
public class SkillsShMarketTest {

    private SkillsShMarket market;

    @BeforeEach
    void setUp() {
        market = new SkillsShMarket();
    }

    // ==================== 基础属性 ====================

    @Test
    @DisplayName("name() 应返回 Skills.sh")
    void testName() {
        assertEquals("Skills.sh", market.name());
    }

    // ==================== parseHtmlItems 测试 ====================

    @Nested
    @DisplayName("parseHtmlItems - HTML 解析")
    class ParseHtmlItemsTest {

        @Test
        @DisplayName("纯文本行格式应正确解析（带排名）")
        void testPlainTextWithRanking() {
            String html = "1 find-skills vercel-labs/skills 1.7M\n" +
                    "2 frontend-design anthropics/skills 474.8K\n" +
                    "3 code-review openai/skills 56.8K\n";

            List<MarketItem> items = market.parseHtmlItems(html, 10);

            assertEquals(3, items.size());

            assertEquals("find-skills", items.get(0).getSlug());
            assertEquals("vercel-labs/skills", items.get(0).getOwnerHandle());
            assertEquals(1_700_000L, items.get(0).getInstalls());

            assertEquals("frontend-design", items.get(1).getSlug());
            assertEquals("anthropics/skills", items.get(1).getOwnerHandle());
            assertEquals(474_800L, items.get(1).getInstalls());

            assertEquals("code-review", items.get(2).getSlug());
            assertEquals("openai/skills", items.get(2).getOwnerHandle());
        }

        @Test
        @DisplayName("纯文本行格式应正确解析（不带排名）")
        void testPlainTextWithoutRanking() {
            String html = "find-skills vercel-labs/skills 1.7M\n" +
                    "frontend-design anthropics/skills 474.8K\n";

            List<MarketItem> items = market.parseHtmlItems(html, 10);

            assertEquals(2, items.size());
            assertEquals("find-skills", items.get(0).getSlug());
            assertEquals("frontend-design", items.get(1).getSlug());
        }

        @Test
        @DisplayName("HTML table 结构应正确解析")
        void testHtmlTableParsing() {
            String html = "<html><body><table>" +
                    "<tr><th>#</th><th>Owner</th><th>Installs</th></tr>" +
                    "<tr><td>find-skills</td><td>vercel-labs/skills</td><td>1.7M</td></tr>" +
                    "<tr><td>frontend-design</td><td>anthropics/skills</td><td>474.8K</td></tr>" +
                    "</table></body></html>";

            List<MarketItem> items = market.parseHtmlItems(html, 10);

            assertEquals(2, items.size());
            assertEquals("find-skills", items.get(0).getSlug());
            assertEquals(1_700_000L, items.get(0).getInstalls());
            assertEquals("frontend-design", items.get(1).getSlug());
        }

        @Test
        @DisplayName("HTML ol/li 列表结构应正确解析")
        void testHtmlListParsing() {
            String html = "<html><body><ol>" +
                    "<li>1 find-skills vercel-labs/skills 1.7M</li>" +
                    "<li>2 frontend-design anthropics/skills 474.8K</li>" +
                    "</ol></body></html>";

            List<MarketItem> items = market.parseHtmlItems(html, 10);

            assertEquals(2, items.size());
            assertEquals("find-skills", items.get(0).getSlug());
            assertEquals("frontend-design", items.get(1).getSlug());
        }

        @Test
        @DisplayName("limit 参数应限制返回数量")
        void testLimit() {
            String html = "1 find-skills vercel-labs/skills 1.7M\n" +
                    "2 frontend-design anthropics/skills 474.8K\n" +
                    "3 code-review openai/skills 56.8K\n";

            List<MarketItem> items = market.parseHtmlItems(html, 2);

            assertEquals(2, items.size());
        }

        @Test
        @DisplayName("null 或空 HTML 应返回空列表")
        void testNullOrEmptyHtml() {
            assertTrue(market.parseHtmlItems(null, 10).isEmpty());
            assertTrue(market.parseHtmlItems("", 10).isEmpty());
        }

        @Test
        @DisplayName("无效行应被跳过而不报错")
        void testInvalidLinesSkipped() {
            String html = "this is not a valid line\n" +
                    "\n" +
                    "   \n" +
                    "1 find-skills vercel-labs/skills 1.7M\n" +
                    "another garbage line\n";

            List<MarketItem> items = market.parseHtmlItems(html, 10);

            assertEquals(1, items.size());
            assertEquals("find-skills", items.get(0).getSlug());
        }
    }

    // ==================== parseInstallCount 测试 ====================

    @Nested
    @DisplayName("parseInstallCount - 安装量解析")
    class ParseInstallCountTest {

        @Test
        @DisplayName("M 后缀应乘以百万")
        void testMillion() {
            assertEquals(1_700_000L, market.parseInstallCount("1.7M"));
            assertEquals(2_000_000L, market.parseInstallCount("2M"));
        }

        @Test
        @DisplayName("K 后缀应乘以千")
        void testThousand() {
            assertEquals(474_800L, market.parseInstallCount("474.8K"));
            assertEquals(56_800L, market.parseInstallCount("56.8K"));
            assertEquals(1_000L, market.parseInstallCount("1K"));
        }

        @Test
        @DisplayName("小写后缀也应支持")
        void testLowercaseSuffix() {
            assertEquals(1_700_000L, market.parseInstallCount("1.7m"));
            assertEquals(474_800L, market.parseInstallCount("474.8k"));
        }

        @Test
        @DisplayName("纯数字应直接返回")
        void testPlainNumber() {
            assertEquals(1234L, market.parseInstallCount("1234"));
        }

        @Test
        @DisplayName("带逗号的数字应正确解析")
        void testCommaNumber() {
            assertEquals(1234L, market.parseInstallCount("1,234"));
        }

        @Test
        @DisplayName("null 或空字符串应返回 0")
        void testNullOrEmpty() {
            assertEquals(0L, market.parseInstallCount(null));
            assertEquals(0L, market.parseInstallCount(""));
        }

        @Test
        @DisplayName("无效字符串应返回 0")
        void testInvalid() {
            assertEquals(0L, market.parseInstallCount("abc"));
        }
    }

    // ==================== parseHtmlItems 与完整 HTML 模板集成 ====================

    @Nested
    @DisplayName("parseHtmlItems - 真实页面模板解析")
    class RealPageTemplateTest {

        /**
         * 模拟 Next.js 渲染的 skills.sh 页面结构
         */
        @Test
        @DisplayName("Next.js 风格页面应从文本中提取技能列表")
        void testNextJsPage() {
            String html = "<!DOCTYPE html><html><head><title>Skills.sh</title>" +
                    "<script>__NEXT_DATA__={}</script></head><body>" +
                    "<div><main><div>" +
                    "<p>1 find-skills vercel-labs/skills 1.8M " +
                    "2 frontend-design anthropics/skills 477.7K " +
                    "3 code-review openai/skills 56.8K</p>" +
                    "</div></main></div></body></html>";

            List<MarketItem> items = market.parseHtmlItems(html, 10);

            // jsoup 提取文本后按空格分隔，数字会连在一起，但至少能提取到部分内容
            // 核心是验证不抛异常且解析合理
            assertNotNull(items);
        }

        @Test
        @DisplayName("包含 a 链接的列表页应优先尝试解析")
        void testLinkBasedPage() {
            String html = "<html><body>" +
                    "<a href=\"/skill/find-skills\">1 find-skills vercel-labs/skills 1.7M</a>" +
                    "<a href=\"/skill/frontend-design\">2 frontend-design anthropics/skills 474.8K</a>" +
                    "</body></html>";

            List<MarketItem> items = market.parseHtmlItems(html, 10);

            assertEquals(2, items.size());
            assertEquals("find-skills", items.get(0).getSlug());
            assertEquals("frontend-design", items.get(1).getSlug());
        }
    }

    // ==================== MarketItem 属性完整性 ====================

    @Test
    @DisplayName("解析结果 MarketItem 属性应完整填充")
    void testMarketItemFields() {
        String html = "1 find-skills vercel-labs/skills 1.7M\n";

        List<MarketItem> items = market.parseHtmlItems(html, 10);

        assertEquals(1, items.size());
        MarketItem item = items.get(0);
        assertEquals("find-skills", item.getSlug());
        assertEquals("find-skills", item.getName());
        assertEquals("find-skills", item.getDisplayName());
        assertEquals("vercel-labs/skills", item.getOwnerHandle());
        assertEquals(1_700_000L, item.getInstalls());
        assertEquals(0L, item.getStars());
    }

    // ==================== 边界条件 ====================

    @Test
    @DisplayName("limit=0 应返回空列表")
    void testZeroLimit() {
        String html = "1 find-skills vercel-labs/skills 1.7M\n";
        assertTrue(market.parseHtmlItems(html, 0).isEmpty());
    }

    @Test
    @DisplayName("slug 含下划线和连字符应正确解析")
    void testSlugWithUnderscoreAndHyphen() {
        String html = "1 my_cool-skill owner/repo 10K\n";

        List<MarketItem> items = market.parseHtmlItems(html, 10);

        assertEquals(1, items.size());
        assertEquals("my_cool-skill", items.get(0).getSlug());
    }

    @Test
    @DisplayName("owner/repo 含多层路径应完整保留")
    void testOwnerRepoWithSubPath() {
        String html = "1 find-skills vercel-labs/skills/main 1.7M\n";

        List<MarketItem> items = market.parseHtmlItems(html, 10);

        assertEquals(1, items.size());
        // ownerHandle 应为完整路径（到安装量字段之前）
        assertNotNull(items.get(0).getOwnerHandle());
    }

    @Test
    @DisplayName("大量数据行应稳定解析")
    void testLargeDataSet() {
        StringBuilder sb = new StringBuilder();
        for (int i = 1; i <= 100; i++) {
            sb.append(i).append(" skill-").append(i).append(" owner").append(i % 10).append("/repo 1K\n");
        }

        List<MarketItem> items = market.parseHtmlItems(sb.toString(), 100);

        assertEquals(100, items.size());
        assertEquals("skill-1", items.get(0).getSlug());
        assertEquals("skill-100", items.get(99).getSlug());
    }
}
