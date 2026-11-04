package com.gourdai.core.portal.web.market.impl;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import com.gourdai.core.portal.web.market.MarketItem;
import org.noear.snack4.ONode;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.*;

/**
 * ModelscopeMarket 单元测试 — 覆盖列表解析、游标分页、GitHub 回退 URL 构造、
 * 顶层目录剥除及 zip-slip 防护。
 *
 * @author oisin
 */
public class ModelscopeMarketTest {

    private ModelscopeMarket market;

    @BeforeEach
    void setUp() {
        market = new ModelscopeMarket();
    }

    // ==================== 基础属性 ====================

    @Test
    @DisplayName("name()/description() 应返回魔搭标识")
    void testBasics() {
        assertEquals("modelscope.cn", market.name());
        assertEquals("魔搭社区技能广场", market.description());
    }

    // ==================== parseSkills 测试 ====================

    @Nested
    @DisplayName("parseSkills - 列表解析")
    class ParseSkillsTest {

        @Test
        @DisplayName("标准响应应正确解析，zh 描述优先")
        void testStandardParsing() {
            String json = "{\"success\":true,\"data\":{\"total\":2,\"page_number\":1,\"page_size\":20,\"skills\":["
                    + "{\"id\":\"@anthropics/pdf\",\"display_name\":\"PDF 处理\",\"description\":\"English desc\","
                    + "\"locales\":{\"zh\":{\"description\":\"中文描述\"}},\"developer\":\"anthropics\","
                    + "\"source_url\":\"https://github.com/anthropics/skills\",\"downloads\":12345,\"view_count\":999},"
                    + "{\"id\":\"no-locales/skill\",\"display_name\":\"No Locales\",\"description\":\"plain\"}"
                    + "]}}";

            List<MarketItem> items = market.parseSkills(ONode.ofJson(json).get("data"));

            assertEquals(2, items.size());

            MarketItem first = items.get(0);
            assertEquals("@anthropics/pdf", first.getSlug());
            assertEquals("PDF 处理", first.getDisplayName());
            assertEquals("中文描述", first.getSummary());       // zh 优先
            assertEquals("anthropics", first.getOwnerHandle());
            assertEquals(12345L, first.getInstalls());
            assertEquals(999L, first.getStars());
            assertEquals("https://github.com/anthropics/skills", first.getUrl());

            MarketItem second = items.get(1);
            assertEquals("plain", second.getSummary());         // 无 locales 回退
            assertEquals("https://www.modelscope.cn/skills/no-locales/skill", second.getUrl());
        }

        @Test
        @DisplayName("zh 描述为空时应回退英文描述")
        void testEmptyZhFallback() {
            String json = "{\"data\":{\"skills\":[{\"id\":\"a/b\",\"description\":\"en\","
                    + "\"locales\":{\"zh\":{\"description\":\"\"}}}]}}";

            List<MarketItem> items = market.parseSkills(ONode.ofJson(json).get("data"));
            assertEquals(1, items.size());
            assertEquals("en", items.get(0).getSummary());
        }

        @Test
        @DisplayName("id 缺失的条目应跳过")
        void testSkipMissingId() {
            String json = "{\"data\":{\"skills\":[{\"display_name\":\"no id\"},{\"id\":\"x/y\"}]}}";
            List<MarketItem> items = market.parseSkills(ONode.ofJson(json).get("data"));
            assertEquals(1, items.size());
            assertEquals("x/y", items.get(0).getSlug());
        }

        @Test
        @DisplayName("data 缺失或 skills 非数组应返回空列表")
        void testNullData() {
            assertTrue(market.parseSkills(null).isEmpty());
            assertTrue(market.parseSkills(ONode.ofJson("{}")).isEmpty());
        }
    }

    // ==================== parsePageFromCursor 测试 ====================

    @Nested
    @DisplayName("parsePageFromCursor - 游标解析")
    class CursorTest {

        @Test
        @DisplayName("空/null/非法游标应回退第 1 页")
        void testInvalidCursor() {
            assertEquals(1, market.parsePageFromCursor(null));
            assertEquals(1, market.parsePageFromCursor(""));
            assertEquals(1, market.parsePageFromCursor("  "));
            assertEquals(1, market.parsePageFromCursor("abc"));
            assertEquals(1, market.parsePageFromCursor("0"));
            assertEquals(1, market.parsePageFromCursor("-3"));
        }

        @Test
        @DisplayName("合法游标应解析为对应页码")
        void testValidCursor() {
            assertEquals(1, market.parsePageFromCursor("1"));
            assertEquals(2, market.parsePageFromCursor("2"));
            assertEquals(100, market.parsePageFromCursor(" 100 "));
        }
    }

    // ==================== buildGitHubFallbackUrl 测试 ====================

    @Nested
    @DisplayName("buildGitHubFallbackUrl - GitHub 回退 URL")
    class FallbackUrlTest {

        @Test
        @DisplayName("GitHub 仓库地址应构造 archive URL")
        void testPlainRepo() {
            assertEquals("https://github.com/anthropics/skills/archive/refs/heads/HEAD.zip",
                    market.buildGitHubFallbackUrl("https://github.com/anthropics/skills"));
        }

        @Test
        @DisplayName(".git 后缀应被移除")
        void testGitSuffix() {
            assertEquals("https://github.com/o/r/archive/refs/heads/HEAD.zip",
                    market.buildGitHubFallbackUrl("https://github.com/o/r.git"));
        }

        @Test
        @DisplayName("tree/branch 应使用指定分支")
        void testBranch() {
            assertEquals("https://github.com/o/r/archive/refs/heads/dev.zip",
                    market.buildGitHubFallbackUrl("https://github.com/o/r/tree/dev"));
        }

        @Test
        @DisplayName("www 前缀与非 GitHub 源应返回 null")
        void testNonGithub() {
            assertEquals("https://github.com/o/r/archive/refs/heads/HEAD.zip",
                    market.buildGitHubFallbackUrl("https://www.github.com/o/r"));
            assertNull(market.buildGitHubFallbackUrl(null));
            assertNull(market.buildGitHubFallbackUrl(""));
            assertNull(market.buildGitHubFallbackUrl("https://gitee.com/o/r"));
        }
    }

    // ==================== unzipStrippingRoot 测试 ====================

    @Nested
    @DisplayName("unzipStrippingRoot - 解压剥层")
    class UnzipTest {

        @TempDir
        Path tempDir;

        private Path createZip(String... entries) throws Exception {
            Path zip = tempDir.resolve("test.zip");
            try (ZipOutputStream zos = new ZipOutputStream(Files.newOutputStream(zip), StandardCharsets.UTF_8)) {
                for (String e : entries) {
                    zos.putNextEntry(new ZipEntry(e));
                    if (!e.endsWith("/")) {
                        zos.write(("content of " + e + "\n").getBytes(StandardCharsets.UTF_8));
                    }
                    zos.closeEntry();
                }
            }
            return zip;
        }

        @Test
        @DisplayName("GitHub archive 风格（唯一顶层目录）应剥除顶层")
        void testStripSingleRoot() throws Exception {
            Path zip = createZip(
                    "repo-master-abc123/",
                    "repo-master-abc123/SKILL.md",
                    "repo-master-abc123/scripts/run.sh",
                    "repo-master-abc123/docs/guide.md");

            Path target = tempDir.resolve("out1");
            market.unzipStrippingRoot(zip, target);

            assertTrue(Files.exists(target.resolve("SKILL.md")), "SKILL.md 应在根下");
            assertTrue(Files.exists(target.resolve("scripts/run.sh")));
            assertTrue(Files.exists(target.resolve("docs/guide.md")));
            assertFalse(Files.exists(target.resolve("repo-master-abc123")), "顶层目录应被剥除");
        }

        @Test
        @DisplayName("根级直接有文件时不剥层")
        void testNoStripWhenRootFile() throws Exception {
            Path zip = createZip(
                    "skill/",
                    "skill/SKILL.md",
                    "skill/README.md",
                    "LICENSE.txt");

            Path target = tempDir.resolve("out2");
            market.unzipStrippingRoot(zip, target);

            assertTrue(Files.exists(target.resolve("skill/SKILL.md")));
            assertTrue(Files.exists(target.resolve("LICENSE.txt")));
        }

        @Test
        @DisplayName("多个顶层目录时不剥层")
        void testNoStripWhenMultipleRoots() throws Exception {
            Path zip = createZip(
                    "a/SKILL.md",
                    "b/other.txt");

            Path target = tempDir.resolve("out3");
            market.unzipStrippingRoot(zip, target);

            assertTrue(Files.exists(target.resolve("a/SKILL.md")));
            assertTrue(Files.exists(target.resolve("b/other.txt")));
        }

        @Test
        @DisplayName("zip-slip 条目应被拒绝（不逃逸目标目录）")
        void testZipSlipProtection() throws Exception {
            Path zip = createZip(
                    "root/SKILL.md",
                    "root/../../evil.txt");

            Path target = tempDir.resolve("out4");
            market.unzipStrippingRoot(zip, target);

            assertTrue(Files.exists(target.resolve("SKILL.md")));
            assertFalse(Files.exists(tempDir.resolve("evil.txt")), "逃逸文件不应被写出");
        }

        @Test
        @DisplayName("__MACOSX 元数据条目应被忽略")
        void testMacosxIgnored() throws Exception {
            Path zip = createZip(
                    "root/",
                    "root/SKILL.md",
                    "__MACOSX/root/._SKILL.md");

            Path target = tempDir.resolve("out5");
            market.unzipStrippingRoot(zip, target);

            assertTrue(Files.exists(target.resolve("SKILL.md")));
            assertFalse(Files.exists(target.resolve("__MACOSX")));
        }
    }
}
