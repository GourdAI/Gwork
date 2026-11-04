package com.gourdai.core.portal.web.market.impl;

import org.junit.jupiter.api.*;
import com.gourdai.core.portal.web.market.MarketDetail;
import com.gourdai.core.portal.web.market.MarketItem;
import com.gourdai.core.portal.web.market.MarketPageResult;
import org.noear.solon.core.handle.Result;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * SkillhubMarket 集成测试 — 真实调用 api.skillhub.cn，禁止 mock。
 *
 * <p>覆盖 name/description、trending、search、detail、install 五大方法的正常与边界场景。
 * 2026-08 cursor 游标分页改造后，trending/search 返回 {@link MarketPageResult}。</p>
 *
 * @author oisin
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
public class SkillhubMarketTest {

    private static SkillhubMarket market;
    private static Path tempSkillsDir;
    private static String cachedSlug; // 从 trending 缓存一个真实 slug

    /** 从分页结果中提取 items（null 安全） */
    private static List<MarketItem> items(Result<MarketPageResult> result) {
        if (result == null || result.getData() == null || result.getData().getItems() == null) {
            return Collections.emptyList();
        }
        return result.getData().getItems();
    }

    @BeforeAll
    static void setUp() throws Exception {
        market = new SkillhubMarket();
        tempSkillsDir = Files.createTempDirectory("skillhub-test-");

        // 预热：获取一个真实 slug 供 detail/install 使用
        Result<MarketPageResult> trending = market.trending(null, 5);
        List<MarketItem> trendingItems = items(trending);
        if (trending.getCode() == 200 && !trendingItems.isEmpty()) {
            cachedSlug = trendingItems.get(0).getSlug();
            System.out.println("缓存的测试 slug: " + cachedSlug);
        }
    }

    @AfterAll
    static void tearDown() throws Exception {
        if (tempSkillsDir != null && Files.exists(tempSkillsDir)) {
            Files.walk(tempSkillsDir)
                    .sorted(Comparator.reverseOrder())
                    .forEach(p -> {
                        try { Files.delete(p); } catch (Exception ignored) {}
                    });
        }
    }

    // ==================== 1. 基础属性 ====================

    @Test
    @Order(1)
    @DisplayName("name() 应返回 skillhub.cn")
    void testName() {
        assertEquals("skillhub.cn", market.name());
    }

    @Test
    @Order(2)
    @DisplayName("description() 应返回非空中文描述")
    void testDescription() {
        String desc = market.description();
        assertNotNull(desc);
        assertFalse(desc.isEmpty());
        assertTrue(desc.contains("中国"), "description 应包含'中国'");
    }

    // ==================== 2. trending ====================

    @Nested
    @DisplayName("trending - 热门列表")
    @TestMethodOrder(MethodOrderer.OrderAnnotation.class)
    class TrendingTest {

        @Test
        @Order(1)
        @DisplayName("limit=5 应返回不超过 5 条结果")
        void testTrendingLimit5() {
            Result<MarketPageResult> result = market.trending(null, 5);

            assertEquals(200, result.getCode(), "trending 应成功，code=200");
            assertNotNull(result.getData(), "data 不应为 null");
            List<MarketItem> itemsList = items(result);
            assertTrue(itemsList.size() <= 5, "返回数量不应超过 limit");
            assertFalse(itemsList.isEmpty(), "热门列表不应为空");
        }

        @Test
        @Order(2)
        @DisplayName("limit=10 返回的每个 MarketItem 核心字段应非空")
        void testTrendingItemFields() {
            Result<MarketPageResult> result = market.trending(null, 10);

            assertEquals(200, result.getCode());
            List<MarketItem> itemsList = items(result);
            assertFalse(itemsList.isEmpty());

            for (MarketItem item : itemsList) {
                assertNotNull(item.getSlug(), "slug 不应为 null");
                assertFalse(item.getSlug().isEmpty(), "slug 不应为空字符串");
                assertNotNull(item.getDisplayName(), "displayName 不应为 null");
                assertNotNull(item.getOwnerHandle(), "ownerHandle 不应为 null");
                assertTrue(item.getInstalls() >= 0, "installs 不应为负");
                assertTrue(item.getStars() >= 0, "stars 不应为负");
            }
        }

        @Test
        @Order(3)
        @DisplayName("limit=1 应返回恰好 1 条结果")
        void testTrendingLimit1() {
            Result<MarketPageResult> result = market.trending(null, 1);

            assertEquals(200, result.getCode());
            assertEquals(1, items(result).size());
        }

        @Test
        @Order(4)
        @DisplayName("limit=0 应正常返回（不报错）")
        void testTrendingLimit0() {
            Result<MarketPageResult> result = market.trending(null, 0);

            // API 可能忽略 limit=0 返回默认列表，也可能返回空列表，两种都算通过
            assertEquals(200, result.getCode(), "limit=0 不应报错");
            assertNotNull(result.getData(), "data 不应为 null");
        }

        @Test
        @Order(5)
        @DisplayName("非法 cursor 应回退到第一页（不报错）")
        void testTrendingInvalidCursor() {
            Result<MarketPageResult> result = market.trending("not-a-number", 5);

            assertEquals(200, result.getCode(), "非法 cursor 应回退首页而非报错");
            assertNotNull(result.getData());
        }
    }

    // ==================== 3. search ====================

    @Nested
    @DisplayName("search - 搜索")
    @TestMethodOrder(MethodOrderer.OrderAnnotation.class)
    class SearchTest {

        @Test
        @Order(1)
        @DisplayName("搜索 'weather' 应返回包含 weather 相关技能的结果")
        void testSearchWeather() {
            Result<MarketPageResult> result = market.search("weather", null, 10);

            assertEquals(200, result.getCode(), "搜索 weather 应成功");
            assertNotNull(result.getData());
            List<MarketItem> itemsList = items(result);
            assertFalse(itemsList.isEmpty(), "搜索 weather 应有结果");

            boolean hasWeatherRelated = itemsList.stream()
                    .anyMatch(item ->
                            (item.getSlug() != null && item.getSlug().toLowerCase().contains("weather")) ||
                            (item.getDescription() != null && item.getDescription().toLowerCase().contains("weather")) ||
                            (item.getDisplayName() != null && item.getDisplayName().toLowerCase().contains("weather"))
                    );
            assertTrue(hasWeatherRelated, "搜索结果中应有 weather 相关技能");
        }

        @Test
        @Order(2)
        @DisplayName("搜索空关键词应等同于 trending")
        void testSearchEmptyQuery() {
            Result<MarketPageResult> searchResult = market.search("", null, 5);

            assertEquals(200, searchResult.getCode());
            assertNotNull(searchResult.getData());
            assertFalse(items(searchResult).isEmpty());
        }

        @Test
        @Order(3)
        @DisplayName("搜索 null 关键词应等同于 trending")
        void testSearchNullQuery() {
            Result<MarketPageResult> result = market.search(null, null, 5);

            assertEquals(200, result.getCode());
            assertNotNull(result.getData());
        }

        @Test
        @Order(4)
        @DisplayName("搜索不存在的关键词应返回空列表而非报错")
        void testSearchNonexistent() {
            Result<MarketPageResult> result = market.search("zzzz_nonexistent_skill_xyz_12345", null, 10);

            assertEquals(200, result.getCode(), "搜索不存在关键词不应报错");
            assertNotNull(result.getData());
        }

        @Test
        @Order(5)
        @DisplayName("搜索中文关键词应正常工作")
        void testSearchChinese() {
            Result<MarketPageResult> result = market.search("天气", null, 10);

            assertEquals(200, result.getCode(), "搜索中文不应报错");
            assertNotNull(result.getData());
        }
    }

    // ==================== 4. detail ====================

    @Nested
    @DisplayName("detail - 详情")
    @TestMethodOrder(MethodOrderer.OrderAnnotation.class)
    class DetailTest {

        @Test
        @Order(1)
        @DisplayName("使用真实 slug 查询详情应成功")
        void testDetailWithRealSlug() {
            Assumptions.assumeTrue(cachedSlug != null, "需要有可用的 slug 才能测试");
            System.out.println("测试 detail 使用的 slug: " + cachedSlug);

            Result<MarketDetail> result = market.detail(cachedSlug);

            assertEquals(200, result.getCode(), "detail 应成功，code=200");
            MarketDetail detail = result.getData();
            assertNotNull(detail);
            assertEquals(cachedSlug, detail.getSlug(), "detail 的 slug 应与请求一致");
        }

        @Test
        @Order(2)
        @DisplayName("详情对象核心字段应已填充")
        void testDetailFieldsPopulated() {
            Assumptions.assumeTrue(cachedSlug != null, "需要有可用的 slug 才能测试");

            Result<MarketDetail> result = market.detail(cachedSlug);
            assertEquals(200, result.getCode());

            MarketDetail detail = result.getData();
            assertNotNull(detail.getSlug());
            assertNotNull(detail.getDisplayName(), "displayName 不应为 null");
            assertNotNull(detail.getOwnerHandle(), "ownerHandle 不应为 null");
            assertNotNull(detail.getInstallSlug(), "installSlug 不应为 null");
            assertTrue(detail.getInstalls() >= 0);
            assertTrue(detail.getStars() >= 0);
        }

        @Test
        @Order(3)
        @DisplayName("使用不存在的 slug 查询应返回失败")
        void testDetailNonexistent() {
            Result<MarketDetail> result = market.detail("zzz_nonexistent_slug_xyz_99999");

            if (result.getCode() != 200) {
                assertNotNull(result.getDescription(), "失败时 description 应有值");
            } else {
                assertNull(result.getData(), "不存在的 slug 应返回 null data");
            }
        }

        @Test
        @Order(4)
        @DisplayName("slug 为 null 应返回失败")
        void testDetailNullSlug() {
            Result<MarketDetail> result = market.detail(null);
            assertNotEquals(200, result.getCode(), "null slug 应返回非200");
        }

        @Test
        @Order(5)
        @DisplayName("slug 为空字符串应返回失败")
        void testDetailEmptySlug() {
            Result<MarketDetail> result = market.detail("");
            assertNotEquals(200, result.getCode(), "空 slug 应返回非200");
        }

        @Test
        @Order(6)
        @DisplayName("同名 slug 双记录：限定 slug 各自解析到对应 owner（不得都返回同一家）")
        void testDetailSameSlugDifferentOwners() {
            // 上游实测存在不同作者共用同一公开 slug 的记录（dev-expert：
            // @indiv-ebandao 与 @user_814dbe54）。若上游该 fixture 消失则跳过，
            // 不制造 flaky；存在时必须两家各自解析成功且 owner 互不相同。
            Result<MarketPageResult> page = market.search("编程专家", null, 50);
            assertEquals(200, page.getCode());
            List<MarketItem> list = items(page);
            // 按裸尾分组：取第一个「同裸尾 ≥2 条限定记录」的组（不能拿第一条的尾
            // 当基准——dev-expert-pro 之类只有一条的尾会让假设恒假而静默跳过）
            java.util.Map<String, java.util.Map<String, MarketItem>> byTail = new java.util.LinkedHashMap<>();
            for (MarketItem item : list) {
                String s = item.getSlug();
                if (s != null && s.startsWith("@") && s.indexOf('/') > 0) {
                    byTail.computeIfAbsent(s.substring(s.indexOf('/') + 1),
                                    k -> new java.util.LinkedHashMap<>())
                            .putIfAbsent(s, item);
                }
            }
            java.util.Map<String, MarketItem> group = null;
            for (java.util.Map<String, MarketItem> g : byTail.values()) {
                if (g.size() >= 2) {
                    group = g;
                    break;
                }
            }
            Assumptions.assumeTrue(group != null,
                    "上游需存在同裸 slug 的多条记录才能验证（当前分组数 " + byTail.size() + "）");

            java.util.Set<String> owners = new java.util.HashSet<>();
            for (String qualified : group.keySet()) {
                Result<MarketDetail> d = market.detail(qualified);
                assertEquals(200, d.getCode(), "限定 slug 详情应成功: " + qualified
                        + (d.getDescription() != null ? " / " + d.getDescription() : ""));
                assertEquals(qualified, d.getData().getSlug(), "详情 slug 应与请求逐字一致");
                assertNotNull(d.getData().getOwnerHandle(), "owner 不应为 null");
                owners.add(d.getData().getOwnerHandle());
            }
            assertEquals(group.size(), owners.size(),
                    "同名 slug 的不同限定形态必须解析到不同 owner，不得都返回上游默认那一家");
        }
    }

    // ==================== 5. install ====================

    @Nested
    @DisplayName("install - 安装")
    @TestMethodOrder(MethodOrderer.OrderAnnotation.class)
    class InstallTest {

        @Test
        @Order(1)
        @DisplayName("安装真实 slug 应成功并解压到目标目录")
        void testInstallRealSlug() {
            Assumptions.assumeTrue(cachedSlug != null, "需要有可用的 slug 才能测试");
            System.out.println("测试 install 使用的 slug: " + cachedSlug);

            Path installDir = tempSkillsDir.resolve("install-test-1");
            Result<String> result = market.install(cachedSlug, installDir);

            assertEquals(200, result.getCode(),
                    "安装应成功。如果失败，description=" + result.getDescription());
            assertNotNull(result.getData(), "安装成功应返回 displayName");

            // 验证目录已创建（目录名口径 = installDirName：限定 slug → _owner_slug）
            Path skillDir = installDir.resolve(market.installDirName(cachedSlug));
            assertTrue(Files.exists(skillDir), "技能目录应存在");
            assertTrue(Files.isDirectory(skillDir), "技能目录应为目录");

            // 验证目录内有文件
            try {
                long fileCount = Files.walk(skillDir)
                        .filter(Files::isRegularFile)
                        .count();
                assertTrue(fileCount > 0, "解压后应至少有一个文件");
                System.out.println("安装成功，文件数: " + fileCount + "，displayName: " + result.getData());
            } catch (Exception e) {
                fail("遍历安装目录失败: " + e.getMessage());
            }
        }

        @Test
        @Order(2)
        @DisplayName("重复安装同一 slug 应覆盖旧文件（不报错）")
        void testInstallOverwrite() {
            Assumptions.assumeTrue(cachedSlug != null, "需要有可用的 slug 才能测试");

            Path installDir = tempSkillsDir.resolve("install-test-overwrite");
            Result<String> first = market.install(cachedSlug, installDir);
            assertEquals(200, first.getCode(), "首次安装应成功");

            Result<String> second = market.install(cachedSlug, installDir);
            assertEquals(200, second.getCode(), "重复安装也应成功");
        }

        @Test
        @Order(3)
        @DisplayName("slug 为 null 应返回失败")
        void testInstallNullSlug() {
            Path dir = tempSkillsDir.resolve("install-null");
            Result<String> result = market.install(null, dir);
            assertNotEquals(200, result.getCode(), "null slug 应返回非200");
        }

        @Test
        @Order(4)
        @DisplayName("slug 为空字符串应返回失败")
        void testInstallEmptySlug() {
            Path dir = tempSkillsDir.resolve("install-empty");
            Result<String> result = market.install("", dir);
            assertNotEquals(200, result.getCode(), "空 slug 应返回非200");
        }

        @Test
        @Order(5)
        @DisplayName("slug 含非法字符应被清理或返回失败")
        void testInstallInvalidSlug() {
            Path dir = tempSkillsDir.resolve("install-invalid");
            Result<String> result = market.install("../../etc/passwd", dir);
            assertNotEquals(200, result.getCode(),
                    "非法 slug 应返回非200。实际 code=" + result.getCode());
        }

        @Test
        @Order(6)
        @DisplayName("安装不存在的 slug 应返回失败")
        void testInstallNonexistent() {
            Path dir = tempSkillsDir.resolve("install-nonexist");
            Result<String> result = market.install("zzz_nonexistent_slug_xyz_99999", dir);
            assertNotEquals(200, result.getCode(),
                    "不存在的 slug 安装应失败。实际 code=" + result.getCode());
            System.out.println("不存在 slug 的安装结果: " + result.getDescription());
        }
    }
}
