package com.gourdai.core.portal.web.market.impl;

import com.gourdai.core.config.McpTypeResolver;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 魔搭 MCP 广场适配器的纯函数契约测试（不联网）。
 *
 * <p>与 Rust 版 {@code core/src/mcp/market.rs} + {@code core/src/server/mcp_market_api.rs}
 * 的单测逐条对等 —— 两端行为必须一致，否则 Java 版与桌面版连接器页会出现同一操作
 * 不同结果。</p>
 *
 * <p>重点锁三类上游契约陷阱（都曾实测踩过）：</p>
 * <ol>
 *   <li><b>空串 category 必须整键省略</b>：上游 {@code {"filter":{"category":""}}} 会
 *       返回 {@code total_count = 0}，而 {@code {"filter":{}}} 返回 12799。发空串
 *       等于让「全部」分类永远空白。</li>
 *   <li><b>id 必须整体百分号编码为单个路径段</b>：{@code @amap/amap-maps} 里的
 *       {@code /} 若不编码会被当路径分隔符。</li>
 *   <li><b>分页必须钳制到 page*pageSize &lt;= 100</b>：越界上游直接报错。</li>
 * </ol>
 */
@DisplayName("魔搭 MCP 广场适配器契约")
class ModelscopeMcpMarketTest {

    // ==================== 分类表：死 key 护栏 ====================

    /**
     * <b>P0 回归护栏</b>：上游对<b>不认识的</b> {@code filter.category} 不报错，只静默
     * 返回 {@code total_count = 0}，于是那个分类 chip 变成「点进去永远空白」的死按钮。
     *
     * <p>单测测不出这种缺陷（mock 不知道上游真实词表），所以把 2026-11 的上游实测结论
     * 钉成常量黑名单 + 白名单双向校验。</p>
     */
    @Test
    @DisplayName("分类表不含上游实测为 0 的死 key，且真实分类齐全")
    void categoriesContainNoDeadKeys() {
        ModelscopeMcpMarket m = new ModelscopeMcpMarket();
        List<Map<String, String>> cats = m.categories();
        assertNotNull(cats, "categories 不得为 null");
        assertEquals(19, cats.size(), "19 = 全部 + 18 个上游实测非零的真实分类；"
                + "数量变化必须同步核对实测记录，否则可能引入了死 key 或漏了真实分类");

        // 首项固定是「全部」（key 为空串，走整键省略路径）
        assertEquals("", cats.get(0).get("key"), "首项必须是「全部」且 key 为空");

        List<String> seen = new ArrayList<>();
        for (int i = 1; i < cats.size(); i++) {
            Map<String, String> c = cats.get(i);
            String key = c.get("key");
            assertNotNull(key, "分类 key 不得为 null");
            assertFalse(key.isEmpty(), "非首项的 key 不得为空");
            assertTrue(seen.add(key), "分类 key 重复: " + key);
            assertFalse(ModelscopeMcpMarket.DEAD_CATEGORY_KEYS.contains(key),
                    "分类 " + key + " 已被上游实测为死 key（total_count=0 或个位数脏数据），"
                            + "会让 chip 点进去永远空白。正确 key 见 ModelscopeMcpMarket.CATEGORIES 注释"
                            + "（位置与地图是 location-services，不是 location-and-maps；"
                            + "数据分析是 research-and-data，不是 data-analytics）");
            // 每个分类都必须有中英文名，否则非中文界面会露出空 chip
            assertNotNull(c.get("name"), key + " 缺英文名");
            assertFalse(c.get("name").isEmpty(), key + " 缺英文名");
            assertNotNull(c.get("nameZh"), key + " 缺中文名");
            assertFalse(c.get("nameZh").isEmpty(), key + " 缺中文名");
        }

        // 上游实测存在的真实分类必须都在表里（缺一个就少一个可用筛选维度）
        String[] real = {
                "developer-tools", "search", "other", "browser-automation", "databases",
                "knowledge-and-memory", "research-and-data", "communication", "file-systems",
                "finance", "cloud-platforms", "os-automation", "entertainment-and-media",
                "image-and-video-processing", "note-taking", "version-control",
                "location-services", "art-and-culture"
        };
        for (String k : real) {
            assertTrue(seen.contains(k), "上游实测存在的分类 " + k + " 缺失于 categories()");
        }
        // 黑名单自身不得为空 —— 若被误删，上面的断言会静默失效（护栏形同虚设）
        assertFalse(ModelscopeMcpMarket.DEAD_CATEGORY_KEYS.isEmpty(), "死 key 黑名单不得为空");
        assertTrue(ModelscopeMcpMarket.DEAD_CATEGORY_KEYS.contains("location-and-maps"),
                "黑名单必须仍包含 location-and-maps（实测 total=0）");
        assertTrue(ModelscopeMcpMarket.DEAD_CATEGORY_KEYS.contains("data-analytics"),
                "黑名单必须仍包含 data-analytics（实测 total=0）");
        assertTrue(ModelscopeMcpMarket.DEAD_CATEGORY_KEYS.contains("ai-and-ml"),
                "黑名单必须仍包含 ai-and-ml（实测 total=0）");
    }

    // ==================== id 编码 ====================

    @Test
    @DisplayName("详情 URL 把 @scope/name 整体编码为单个路径段")
    void detailUrlEncodesScopeAndSlashAsOneSegment() {
        assertEquals(
                "https://www.modelscope.cn/openapi/v1/mcp/servers/%40amap%2Famap-maps",
                ModelscopeMcpMarket.detailUrl("@amap/amap-maps"));
        // 无 scope 的 id：斜杠同样要编码，不能被当路径分隔符
        assertEquals(
                "https://www.modelscope.cn/openapi/v1/mcp/servers/tyc%2Ftyc-mcp",
                ModelscopeMcpMarket.detailUrl("tyc/tyc-mcp"));
        // 前后空白要 trim（前端可能透传带空格的 id）
        assertEquals(
                "https://www.modelscope.cn/openapi/v1/mcp/servers/%40amap%2Famap-maps",
                ModelscopeMcpMarket.detailUrl("  @amap/amap-maps  "));
        // unreserved 字符不得被编码
        assertEquals("a-b_c.d~e", ModelscopeMcpMarket.encodePathSegment("a-b_c.d~e"));
        // 空格必须是 %20，不能是 +（form-urlencoded 规则用在路径段会解析错）
        assertEquals("a%20b", ModelscopeMcpMarket.encodePathSegment("a b"));
        // UTF-8 多字节要按字节逐个百分号编码
        assertEquals("%E9%AB%98", ModelscopeMcpMarket.encodePathSegment("高"));
    }

    // ==================== 分页钳制 ====================

    @Test
    @DisplayName("分页钳制到上游硬限制 page*pageSize<=100")
    void pagingIsClampedToUpstreamLimit() {
        // 正常窗口原样通过
        assertArray2(new int[]{1, 20}, ModelscopeMcpMarket.clampPaging(1, 20));
        // page_size 上限 100
        assertArray2(new int[]{1, 100}, ModelscopeMcpMarket.clampPaging(1, 500));
        // page=6,size=20 → 120 越界，钳到 page=5（5*20=100）
        assertArray2(new int[]{5, 20}, ModelscopeMcpMarket.clampPaging(6, 20));
        // size=100 时最多只能第 1 页
        assertArray2(new int[]{1, 100}, ModelscopeMcpMarket.clampPaging(9, 100));
        // 非法入参回落到默认值，不产生 0 或负数
        assertArray2(new int[]{1, 20}, ModelscopeMcpMarket.clampPaging(0, 0));
        assertArray2(new int[]{1, 20}, ModelscopeMcpMarket.clampPaging(-5, -1));
    }

    private static void assertArray2(int[] expected, int[] actual) {
        assertEquals(2, actual.length, "clampPaging 必须返回 [page,pageSize]");
        assertEquals(expected[0], actual[0], "page 不符");
        assertEquals(expected[1], actual[1], "pageSize 不符");
        assertTrue((long) actual[0] * actual[1] <= ModelscopeMcpMarket.MAX_SCAN,
                "钳制结果仍越界上游限制: page=" + actual[0] + " size=" + actual[1]);
    }

    // ==================== 请求体：空串 category 陷阱 ====================

    @Test
    @DisplayName("category 为空时整键省略（发空串会让上游返回 0 条）")
    void listBodyOmitsCategoryKeyWhenBlank() {
        // 未选分类：filter 里**不得**出现 category 键
        ONode all = ONode.ofJson(ModelscopeMcpMarket.listBody("", 1, 20, "", false));
        assertTrue(all.get("filter").hasKey("is_hosted"), "is_hosted 必须始终存在");
        assertFalse(all.get("filter").hasKey("category"),
                "空串 category 必须整键省略：上游 {\"filter\":{\"category\":\"\"}} 会返回 total_count=0");
        assertEquals("", all.get("search").getString());
        assertEquals(1, all.get("page_number").getInt());
        assertEquals(20, all.get("page_size").getInt());
        assertFalse(all.get("filter").get("is_hosted").getBoolean());

        // null category 同样省略
        ONode nullCat = ONode.ofJson(ModelscopeMcpMarket.listBody("", 1, 20, null, false));
        assertFalse(nullCat.get("filter").hasKey("category"), "null category 也必须省略该键");

        // 纯空白 category 也省略（前端可能透传 "  "）
        ONode blankCat = ONode.ofJson(ModelscopeMcpMarket.listBody("", 1, 20, "   ", false));
        assertFalse(blankCat.get("filter").hasKey("category"), "纯空白 category 也必须省略该键");

        // 选了分类：原值发送，且不被 trim 破坏语义
        ONode picked = ONode.ofJson(ModelscopeMcpMarket.listBody("", 1, 20, "location-services", false));
        assertEquals("location-services", picked.get("filter").get("category").getString());

        // hosted 开关靠它区分 7993 / 4806，必须始终存在
        ONode hosted = ONode.ofJson(ModelscopeMcpMarket.listBody("", 1, 20, "", true));
        assertTrue(hosted.get("filter").get("is_hosted").getBoolean());

        // 请求体里的分页必须是钳制后的值（与 clampPaging 一致，避免发越界请求）
        ONode clamped = ONode.ofJson(ModelscopeMcpMarket.listBody("", 9, 100, "", false));
        assertEquals(1, clamped.get("page_number").getInt(), "page 必须被钳制");
        assertEquals(100, clamped.get("page_size").getInt());
    }

    // ==================== 上游信封解析 ====================

    @Test
    @DisplayName("env_schema 为 JSON 字符串时就地解析为对象")
    void envSchemaStringIsParsedIntoObject() {
        // 上游 env_schema 可能是字符串形态，统一成对象，前端表单不必分叉。
        // 用编程方式构造，避免三层 JSON 转义（易错且难读）。
        String schemaJson = "{\"type\":\"object\",\"properties\":"
                + "{\"API_KEY\":{\"type\":\"string\"}},\"required\":[\"API_KEY\"]}";
        ONode data = new ONode().asObject();
        data.set("id", "x");
        data.set("env_schema", schemaJson); // 字符串形态
        assertTrue(data.get("env_schema").isString(), "前置条件：必须是字符串形态");
        ModelscopeMcpMarket.normalizeEnvSchema(data);
        assertTrue(data.get("env_schema").isObject(), "字符串 env_schema 必须被解析为对象");
        assertEquals("string", data.get("env_schema").get("properties").get("API_KEY").get("type").getString());

        // 已是对象：原样保留
        ONode already = ONode.ofJson("{\"env_schema\":{\"properties\":{\"A\":{\"type\":\"string\"}}}}");
        ModelscopeMcpMarket.normalizeEnvSchema(already);
        assertTrue(already.get("env_schema").isObject());
        assertTrue(already.get("env_schema").hasKey("properties"));

        // 缺失 / null：不得抛异常
        ONode none = ONode.ofJson("{\"id\":\"y\"}");
        ModelscopeMcpMarket.normalizeEnvSchema(none);
        ONode nul = ONode.ofJson("{\"id\":\"y\",\"env_schema\":null}");
        ModelscopeMcpMarket.normalizeEnvSchema(nul);

        // 非法 JSON 字符串：保留原值，由 resolveEnv 按「无 schema」处理，不得炸
        ONode bad = ONode.ofJson("{\"env_schema\":\"not-json\"}");
        ModelscopeMcpMarket.normalizeEnvSchema(bad);
        assertNotNull(bad.get("env_schema"));
    }

    // ==================== 归一化：stdio ====================

    @Test
    @DisplayName("stdio 配置归一化为与手动添加同形的提交体")
    void normalizeStdioConfig() {
        ONode data = ONode.ofJson(stdioDetailJson());
        List<Map.Entry<String, ONode>> out = McpMarketConfigNormalizer.normalize(data, null);
        assertEquals(1, out.size());
        assertEquals("mcp-server", out.get(0).getKey());
        ONode node = out.get(0).getValue();
        // 字段名必须与 /web/settings/mcp/servers/add 的提交体完全一致，否则复用落盘会静默丢字段
        assertEquals("mcp-server", node.get("name").getString());
        assertEquals("stdio", node.get("type").getString(), "上游 stdio 项通常不写 type，必须补齐");
        assertEquals("uvx", node.get("command").getString());
        assertEquals("mcp-server-fetch", node.get("args").getArray().get(0).getString());
        assertTrue(node.get("enabled").getBoolean());
        assertEquals("user", node.get("scope").getString());

        // 上游 env 的空占位保留，用户填写值覆盖非空项
        Map<String, String> supplied = new LinkedHashMap<>();
        supplied.put("API_KEY", "sk-abc");
        supplied.put("EMPTY_ONE", "   ");
        List<Map.Entry<String, ONode>> out2 = McpMarketConfigNormalizer.normalize(data, supplied);
        ONode env = out2.get(0).getValue().get("env");
        assertEquals("sk-abc", env.get("API_KEY").getString(), "用户填写值必须覆盖上游空占位");
        assertEquals("", env.get("EMPTY_ONE").getString(), "空白值不得覆盖");
        assertTrue(env.hasKey("PRESET"), "上游已有的 env 项不得丢失");
        assertEquals("v", env.get("PRESET").getString());
    }

    @Test
    @DisplayName("多条目 server_config 只取第一项，避免装入占位垃圾")
    void normalizeTakesOnlyFirstServerConfigEntry() {
        // 实测 slcatwujian/bing-cn-mcp-server 有 3 项，第 3 项是 {"command":"..."} 占位符。
        // 全装会往 settings.json 塞进无法运行的垃圾条目。
        ONode data = ONode.ofJson("{\"server_config\":["
                + "{\"mcpServers\":{\"good\":{\"command\":\"uvx\",\"args\":[\"a\"]}}},"
                + "{\"mcpServers\":{\"bad\":{\"command\":\"...\",\"args\":[\"...\"]}}}]}");
        List<Map.Entry<String, ONode>> out = McpMarketConfigNormalizer.normalize(data, null);
        assertEquals(1, out.size(), "只能取 server_config 第一项");
        assertEquals("good", out.get(0).getKey());
    }

    @Test
    @DisplayName("缺 server_config / mcpServers / command 时给出明确错误")
    void normalizeRejectsMalformedUpstreamData() {
        assertThrows(IllegalArgumentException.class,
                () -> McpMarketConfigNormalizer.normalize(ONode.ofJson("{}"), null));
        assertThrows(IllegalArgumentException.class,
                () -> McpMarketConfigNormalizer.normalize(ONode.ofJson("{\"server_config\":[]}"), null));
        assertThrows(IllegalArgumentException.class,
                () -> McpMarketConfigNormalizer.normalize(
                        ONode.ofJson("{\"server_config\":[{}]}"), null));
        assertThrows(IllegalArgumentException.class,
                () -> McpMarketConfigNormalizer.normalize(
                        ONode.ofJson("{\"server_config\":[{\"mcpServers\":{}}]}"), null));
        // 既没 command 又不是可识别的 http 类型
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> McpMarketConfigNormalizer.normalize(ONode.ofJson(
                        "{\"server_config\":[{\"mcpServers\":{\"x\":{\"type\":\"weird\"}}}]}"), null));
        assertTrue(e.getMessage().contains("x"), "错误要指名是哪个服务: " + e.getMessage());
    }

    // ==================== 归一化：http ====================

    @Test
    @DisplayName("http 型配置归一化为 url/headers 且类型经标准化")
    void normalizeHttpConfig() {
        ONode data = ONode.ofJson("{\"server_config\":[{\"mcpServers\":{\"remote\":{"
                + "\"type\":\"sse\",\"url\":\"https://mcp.example.com/sse\","
                + "\"headers\":{\"Authorization\":\"Bearer t\"}}}}]}");
        List<Map.Entry<String, ONode>> out = McpMarketConfigNormalizer.normalize(data, null);
        ONode node = out.get(0).getValue();
        assertEquals("sse", node.get("type").getString());
        assertEquals("https://mcp.example.com/sse", node.get("url").getString());
        assertEquals("Bearer t", node.get("headers").get("Authorization").getString());
        // http 家族**没有 env 字段**（build_entry 只写 url/headers）
        assertFalse(node.hasKey("env"), "http 型不得携带 env（存不下，会造成密钥静默丢失的错觉）");
        assertFalse(node.hasKey("command"), "http 型不得携带 command");
    }

    // ==================== http + env_schema 冲突护栏 ====================

    /**
     * <b>P1 护栏</b>：http 型配置存不下 env。若上游给 http 型配置又声明必填 env_schema，
     * 前端会向用户索要密钥、用户填完却被静默丢弃，还提示「安装成功」——那是伪造成功。
     */
    @Test
    @DisplayName("http 型 + env_schema 必须报错，不得静默丢弃密钥")
    void httpConfigWithEnvSchemaIsRejected() {
        String conflict = "{\"server_config\":[{\"mcpServers\":{\"remote\":{"
                + "\"type\":\"sse\",\"url\":\"https://mcp.example.com/sse\"}}}],"
                + "\"env_schema\":{\"type\":\"object\","
                + "\"properties\":{\"API_KEY\":{\"type\":\"string\"}},\"required\":[\"API_KEY\"]}}";

        // 纯函数：guard 必须抛异常（不是「返回 false」这种可被忽略的形态）
        IllegalArgumentException err = assertThrows(IllegalArgumentException.class,
                () -> McpMarketConfigNormalizer.assertHttpHasNoEnvSchema(ONode.ofJson(conflict)),
                "guard 必须拦住 http + env_schema");
        assertTrue(err.getMessage().contains("remote"), "报错要指名服务: " + err.getMessage());
        assertTrue(err.getMessage().contains("API_KEY"), "报错要说明存不下哪个变量: " + err.getMessage());
        assertTrue(err.getMessage().contains("headers"), "要给出可执行的替代方案: " + err.getMessage());

        // streamable_http 同样拦（注意：必须带 required 才算冲突）
        assertThrows(IllegalArgumentException.class,
                () -> McpMarketConfigNormalizer.assertHttpHasNoEnvSchema(ONode.ofJson(
                        "{\"server_config\":[{\"mcpServers\":{\"s\":{\"type\":\"streamable_http\","
                                + "\"url\":\"https://x/mcp\"}}}],"
                                + "\"env_schema\":{\"properties\":{\"T\":{\"type\":\"string\"}},"
                                + "\"required\":[\"T\"]}}")));

        // 【接线级断言】光测纯函数挡不住「guard 调用被删」：Rust 侧曾实测删掉接线后
        // 全部测试仍然全绿。所以必须断言归一化这条**必经之路**自身也抛异常。
        IllegalArgumentException normErr = assertThrows(IllegalArgumentException.class,
                () -> McpMarketConfigNormalizer.normalize(ONode.ofJson(conflict), null),
                "normalize 必须自己拦住 http+env_schema，不能只靠控制器的提前调用");
        assertTrue(normErr.getMessage().contains("remote") && normErr.getMessage().contains("API_KEY"),
                "拦截原因要指名服务与存不下的变量: " + normErr.getMessage());

        // http 型但**不需要**任何 env：正常放行，不得误报
        McpMarketConfigNormalizer.assertHttpHasNoEnvSchema(ONode.ofJson(
                "{\"server_config\":[{\"mcpServers\":{\"s\":{\"type\":\"sse\",\"url\":\"https://x/sse\"}}}],"
                        + "\"env_schema\":{\"properties\":{}}}"));
        McpMarketConfigNormalizer.assertHttpHasNoEnvSchema(ONode.ofJson(
                "{\"server_config\":[{\"mcpServers\":{\"s\":{\"type\":\"sse\",\"url\":\"https://x/sse\"}}}]}"));
        // 【误伤回归】http 型 + **只有可选/带 default 的 env 项、无 required**：必须放行。
        // 前端只在 required 非空时才索要密钥，这种服务用户根本不会被要求填任何东西，
        // install 会正常成功 —— 曾按 properties 判定，把它误拦了（真实缺陷，由本断言抓出）。
        List<Map.Entry<String, ONode>> ok = McpMarketConfigNormalizer.normalize(ONode.ofJson(
                "{\"server_config\":[{\"mcpServers\":{\"s\":{\"type\":\"sse\",\"url\":\"https://x/sse\"}}}],"
                        + "\"env_schema\":{\"properties\":{\"K\":{\"type\":\"string\",\"default\":\"d\"}}}}"), null);
        assertEquals("sse", ok.get(0).getValue().get("type").getString());
        // required 为空数组同样必须放行
        McpMarketConfigNormalizer.assertHttpHasNoEnvSchema(ONode.ofJson(
                "{\"server_config\":[{\"mcpServers\":{\"s\":{\"type\":\"sse\",\"url\":\"https://x/sse\"}}}],"
                        + "\"env_schema\":{\"properties\":{\"K\":{\"type\":\"string\"}},\"required\":[]}}"));
        // required 形态异常（非数组）不得抛异常，按无必填处理
        McpMarketConfigNormalizer.assertHttpHasNoEnvSchema(ONode.ofJson(
                "{\"server_config\":[{\"mcpServers\":{\"s\":{\"type\":\"sse\",\"url\":\"https://x/sse\"}}}],"
                        + "\"env_schema\":{\"properties\":{\"K\":{\"type\":\"string\"}},\"required\":\"oops\"}}"));

        // stdio + env_schema 是绝大多数真实服务的正常形态（实测 amap / tyc / alipay 全是），必须放行
        McpMarketConfigNormalizer.assertHttpHasNoEnvSchema(ONode.ofJson(stdioDetailJson()));

        // server_config 为空数组（实测 ths/thsfazhi-law 就是 0 条）：此处放行，
        // 由 normalize 给出更贴切的「缺少 server_config」报错
        McpMarketConfigNormalizer.assertHttpHasNoEnvSchema(ONode.ofJson("{\"server_config\":[]}"));
    }

    // ==================== resolveEnv ====================

    @Test
    @DisplayName("必填 env 缺失要报错，且只接受 schema 声明过的键")
    void resolveEnvValidatesRequiredAndWhitelistsKeys() {
        String detail = "{\"env_schema\":{\"type\":\"object\",\"properties\":{"
                + "\"AMAP_MAPS_API_KEY\":{\"type\":\"string\"},"
                + "\"REGION\":{\"type\":\"string\",\"default\":\"cn\"}},"
                + "\"required\":[\"AMAP_MAPS_API_KEY\"]}}";
        ONode data = ONode.ofJson(detail);

        // 缺必填 → 报错并列出缺失项
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> McpMarketConfigNormalizer.resolveEnv(data, null));
        assertTrue(e.getMessage().contains("AMAP_MAPS_API_KEY"),
                "报错要列出缺失的键: " + e.getMessage());

        // 填了必填 → 通过，且 default 生效
        Map<String, String> supplied = new LinkedHashMap<>();
        supplied.put("AMAP_MAPS_API_KEY", "k-123");
        supplied.put("NOT_IN_SCHEMA", "should-be-ignored");
        Map<String, String> env = McpMarketConfigNormalizer.resolveEnv(data, supplied);
        assertEquals("k-123", env.get("AMAP_MAPS_API_KEY"));
        assertEquals("cn", env.get("REGION"), "schema 的 default 必须作为缺省值");
        assertFalse(env.containsKey("NOT_IN_SCHEMA"),
                "只接受 schema 声明过的键，防止把任意字段塞进进程环境变量");

        // 纯空白值视同未填
        Map<String, String> blank = new LinkedHashMap<>();
        blank.put("AMAP_MAPS_API_KEY", "   ");
        assertThrows(IllegalArgumentException.class,
                () -> McpMarketConfigNormalizer.resolveEnv(data, blank));

        // 无 schema → 返回空 map，不报错
        assertTrue(McpMarketConfigNormalizer.resolveEnv(ONode.ofJson("{}"), null).isEmpty());
        // env_schema 为 null → 不报错
        assertTrue(McpMarketConfigNormalizer.resolveEnv(
                ONode.ofJson("{\"env_schema\":null}"), null).isEmpty());
    }

    // ==================== envSupported（渲染前判据） ====================

    /**
     * {@code env_supported} 是「详情弹窗要不要渲染 env 表单」的<b>唯一判据</b>，前端只读
     * 这个布尔、不自己判类型（JS 侧 ⑲ 只断言源码含该字段名，抓不到逻辑改动）。
     *
     * <p>没有本测试时，把它改成恒 {@code true} 会全绿：http 型服务照样摆输入框索要密钥
     * → {@code normalize} 的 http 分支无处落 env → 提示安装成功、密钥静默丢失、
     * 服务连不上且无从排查（2026-11 codereview 抓出的 P1 原路径）。</p>
     *
     * <p>与 Rust 版 {@code mcp_market_env_supported_is_false_only_for_http_types} 逐条对等。</p>
     */
    @Test
    @DisplayName("env_supported 只对 http 家族为 false（否则前端索要密钥后被静默丢弃）")
    void envSupportedIsFalseOnlyForHttpTypes() {
        // (a) http 家族一律 false —— 与安装侧 McpTypeResolver 同源，不另立别名表
        for (String spelling : new String[]{"sse", "sse_http", "ssehttp", "remote",
                "streamable_http", "http"}) {
            assertTrue(McpTypeResolver.isHttpType(spelling),
                    "前提失效：" + spelling + " 已不被 isHttpType 认定为 http");
            ONode d = ONode.ofJson("{\"server_config\":[{\"mcpServers\":{\"r\":{"
                    + "\"type\":\"" + spelling + "\",\"url\":\"https://x/mcp\"}}}]}");
            assertFalse(McpMarketConfigNormalizer.envSupported(d),
                    spelling + " 是 http 型、存不下 env，必须让前端不渲染表单（否则密钥被静默丢弃）");
        }

        // (b) P1 的原始触发形态：http 型 + **只有可选** env 项（required 为空）。
        //     install 侧 guard 因 required 空而放行，全靠这里在渲染前就掐掉表单。
        ONode onlyOptional = ONode.ofJson("{\"env_schema\":{\"properties\":{"
                + "\"API_TOKEN\":{\"description\":\"可选\"}},\"required\":[]},"
                + "\"server_config\":[{\"mcpServers\":{\"r\":{"
                + "\"type\":\"sse\",\"url\":\"https://x/mcp\"}}}]}");
        assertFalse(McpMarketConfigNormalizer.envSupported(onlyOptional),
                "http 型只有可选 env 项时也必须 false —— 这正是静默丢密钥的那条路径");
        // 同时确认 guard 不误拦：这种服务安装应成功（用户没被要求填任何东西）
        McpMarketConfigNormalizer.assertHttpHasNoEnvSchema(onlyOptional);

        // (c) stdio 存得下 env → true（否则所有服务都失去 env 表单，比旧形态更糟）
        assertTrue(McpMarketConfigNormalizer.envSupported(ONode.ofJson(stdioDetailJson())),
                "stdio 必须为 true，它才存得下 env");

        // (d) 上游数据残缺（无 server_config）→ true，是有意的宽松：让前端维持既有形态，
        //     最终仍由 resolveEnv 拦缺必填，不会伪造成功。
        assertTrue(McpMarketConfigNormalizer.envSupported(
                        ONode.ofJson("{\"env_schema\":{\"properties\":{\"K\":{}},\"required\":[\"K\"]}}")),
                "缺 server_config 时应宽松返回 true（resolveEnv 仍是防线）");
        // (e) type 缺失 → 不归为 http，返回 true
        assertTrue(McpMarketConfigNormalizer.envSupported(
                        ONode.ofJson("{\"server_config\":[{\"mcpServers\":{\"s\":{\"command\":\"uvx\"}}}]}")),
                "type 缺失不该被误判成 http");
    }

    /** 实测形态：stdio + env_schema（amap / tyc / alipay 都是这种）。 */
    private static String stdioDetailJson() {
        return "{\"id\":\"@amap/amap-maps\",\"is_hosted\":false,\"is_verified\":true,"
                + "\"server_config\":[{\"mcpServers\":{\"mcp-server\":{"
                + "\"command\":\"uvx\",\"args\":[\"mcp-server-fetch\"],"
                + "\"env\":{\"API_KEY\":\"\",\"PRESET\":\"v\",\"EMPTY_ONE\":\"\"}}}}],"
                + "\"env_schema\":{\"type\":\"object\",\"properties\":{"
                + "\"API_KEY\":{\"type\":\"string\"},\"PRESET\":{\"type\":\"string\"},"
                + "\"EMPTY_ONE\":{\"type\":\"string\"}}}}";
    }
}
