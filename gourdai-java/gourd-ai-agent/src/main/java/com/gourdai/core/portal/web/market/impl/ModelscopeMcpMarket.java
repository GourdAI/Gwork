package com.gourdai.core.portal.web.market.impl;

import org.noear.snack4.ONode;
import org.noear.solon.net.http.HttpResponse;
import org.noear.solon.net.http.HttpUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * ModelScope 魔搭 <b>MCP 广场</b>适配器 — 「连接器」页的唯一内置目录源。
 *
 * <p>与 {@link ModelscopeMarket}（技能广场，{@code /openapi/v1/skills}）是两套不同的
 * 上游接口与分类体系，不要混用。本类对接 MCP 广场：</p>
 * <ul>
 *   <li>列表/搜索：{@code PUT https://www.modelscope.cn/openapi/v1/mcp/servers}，
 *       body {@code {"search":"","page_number":1,"page_size":20,"filter":{...}}}，
 *       硬限制 {@code page_number * page_size <= 100}。</li>
 *   <li>详情：{@code GET .../openapi/v1/mcp/servers/{id}}，{@code {id}} 含 {@code @} 与
 *       {@code /}，必须把整个 id 当作<b>单个路径段</b>做百分号编码
 *       （{@code @amap/amap-maps} → {@code %40amap%2Famap-maps}）。</li>
 * </ul>
 *
 * <p>匿名可用，无需 Token。明确不做：官方 Registry、自定义源、多源、Hosted 专属连接 URL
 * （后者需要 Bearer Token，属 deploy / operational 范畴）。</p>
 *
 * <p>本类只负责「上游 HTTP + 纯数据变换」；落盘由
 * {@code WebSettingsController#mcpMarketInstall} 复用
 * {@code WebSettingsController#addMcpServerNode}，与手动添加 MCP 共用同一份
 * 校验 / 去重 / 持久化 / 引擎热插拔逻辑。</p>
 *
 * <p>与 Rust 版 {@code gourd-work/core/src/mcp/market.rs} 保持行为对等
 * （分页钳制、id 编码、空串 category 省略、分类表、失败信封）。</p>
 *
 * @author oisin
 */
public class ModelscopeMcpMarket {

    private static final Logger LOG = LoggerFactory.getLogger(ModelscopeMcpMarket.class);

    /** MCP 广场列表/详情共用前缀（详情是列表 URL + 编码后的 id） */
    public static final String LIST_URL = "https://www.modelscope.cn/openapi/v1/mcp/servers";

    private static final String USER_AGENT = "GWork/1.0 (+MCP Market)";

    /** 上游硬限制：{@code page_number * page_size} 不得超过该值，越界直接报错 */
    static final int MAX_SCAN = 100;

    /**
     * 内置静态分类表 — key 必须是<b>上游真实存在的 category 取值</b>，不能凭直觉命名。
     *
     * <p>⚠ 上游对不认识的 {@code filter.category} <b>不报错，只静默返回
     * {@code total_count = 0}</b>，于是该 chip 变成「点进去永远空白」的死按钮 ——
     * 这类缺陷在单测里完全测不出来（mock 不知道上游真实词表），必须逐个实测。</p>
     *
     * <p>下表 18 个 key 全部经 2026-11 上游实测（{@code is_hosted=false}）逐个确认非零，
     * 并按结果数降序排列；括号内为实测 total_count，仅作维护参考：</p>
     * <pre>
     *   developer-tools(2644) search(1089) other(542) browser-automation(531)
     *   databases(469) knowledge-and-memory(460) research-and-data(424)
     *   communication(423) file-systems(359) finance(307) cloud-platforms(289)
     *   os-automation(258) entertainment-and-media(229) image-and-video-processing(212)
     *   note-taking(206) version-control(191) location-services(163) art-and-culture(90)
     * </pre>
     *
     * <p>曾出现过、现已剔除的死 key（见 {@link #DEAD_CATEGORY_KEYS}）：
     * {@code data-analytics}(0)、{@code location-and-maps}(0)、{@code ai-and-ml}(0)、
     * {@code productivity}(1)、{@code security}(2)。注意「位置与地图」的正确 key 是
     * {@code location-services}，不是想当然的 {@code location-and-maps}；
     * 「数据分析」是 {@code research-and-data}，不是 {@code data-analytics}。</p>
     */
    static final List<Map<String, String>> CATEGORIES = buildCategories();

    /**
     * 已实测为 0（或个位数脏数据）的分类 key。<b>禁止</b>再出现在 {@link #CATEGORIES} 里，
     * 否则对应 chip 点进去永远空白。由 {@code McpMarketCategoryTest} 守护。
     */
    public static final List<String> DEAD_CATEGORY_KEYS = Arrays.asList(
            "data-analytics",
            "location-and-maps",
            "ai-and-ml",
            "productivity",
            "security",
            "AIGC",
            "Knowledge&Memory");

    private static List<Map<String, String>> buildCategories() {
        List<Map<String, String>> list = new ArrayList<>();
        // 首项固定为「全部」：key 为空串，走「整键省略」路径（见 #listBody）
        list.add(category("", "All", "全部"));
        list.add(category("developer-tools", "Developer Tools", "开发者工具"));
        list.add(category("search", "Search", "搜索工具"));
        list.add(category("other", "Other", "其他"));
        list.add(category("browser-automation", "Browser Automation", "浏览器自动化"));
        list.add(category("databases", "Databases", "数据库"));
        list.add(category("knowledge-and-memory", "Knowledge & Memory", "知识管理与记忆"));
        list.add(category("research-and-data", "Research & Data", "研究与数据"));
        list.add(category("communication", "Communication", "交流协作工具"));
        list.add(category("file-systems", "File Systems", "文件系统"));
        list.add(category("finance", "Finance", "金融"));
        list.add(category("cloud-platforms", "Cloud Platforms", "云平台"));
        list.add(category("os-automation", "OS Automation", "系统自动化"));
        list.add(category("entertainment-and-media", "Entertainment & Media", "娱乐与多媒体"));
        list.add(category("image-and-video-processing", "Image & Video", "图像与视频处理"));
        list.add(category("note-taking", "Note Taking", "笔记"));
        list.add(category("version-control", "Version Control", "版本控制"));
        list.add(category("location-services", "Location Services", "位置与地图"));
        list.add(category("art-and-culture", "Art & Culture", "艺术与文化"));
        return list;
    }

    /**
     * 分类项。字段名与 Rust 版 {@code categories()} 逐字一致：
     * {@code key} / {@code nameZh} / {@code name} —— 前端
     * {@code app-mcp-market.js} 按这三个名字读取，改名即静默失效。
     */
    private static Map<String, String> category(String key, String name, String nameZh) {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("key", key);
        m.put("nameZh", nameZh);
        m.put("name", name);
        return m;
    }

    // ==================== 纯函数：URL / 分页 / 请求体 ====================

    /**
     * 详情 URL。id 整体编码为一个路径段，避免 {@code @scope/name} 里的 {@code /}
     * 被当成路径分隔符（否则上游 404 或命中错误的资源）。
     */
    public static String detailUrl(String id) {
        return LIST_URL + "/" + encodePathSegment(id == null ? "" : id.trim());
    }

    /**
     * RFC 3986 路径段编码：只保留 unreserved 字符（字母数字与 {@code - _ . ~}），
     * 其余（含 {@code @} 与 {@code /}）全部 {@code %XX}。
     *
     * <p>不能用 {@code URLEncoder.encode}：它按 {@code application/x-www-form-urlencoded}
     * 规则编码，会把空格变成 {@code +}（而非 {@code %20}），且不编码 {@code *} 等字符，
     * 用在路径段上会让上游解析出错误的 id。</p>
     */
    public static String encodePathSegment(String raw) {
        if (raw == null || raw.isEmpty()) {
            return "";
        }
        StringBuilder out = new StringBuilder(raw.length() * 2);
        for (byte b : raw.getBytes(java.nio.charset.StandardCharsets.UTF_8)) {
            int c = b & 0xFF;
            boolean unreserved = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '-' || c == '_' || c == '.' || c == '~';
            if (unreserved) {
                out.append((char) c);
            } else {
                out.append('%').append(String.format("%02X", c));
            }
        }
        return out.toString();
    }

    /**
     * 分页钳制：{@code 1 <= page_size <= 100} 且 {@code page * page_size <= 100}。
     *
     * <p>上游对越界请求直接报错，因此在发请求前就把窗口收进允许范围，
     * 而不是把 500 透传给用户。</p>
     *
     * @return {@code [page, pageSize]}
     */
    public static int[] clampPaging(long page, long pageSize) {
        int size = (pageSize < 1) ? 20 : (int) Math.min(pageSize, MAX_SCAN);
        int maxPage = (int) Math.max(1, MAX_SCAN / size);
        int p = (page < 1) ? 1 : (int) Math.min(page, maxPage);
        return new int[]{p, size};
    }

    /**
     * 列表请求体 JSON 字符串。
     *
     * <p>⚠ 上游契约（2026-11 实测，与直觉相反，务必保留）：{@code filter} 里出现
     * <b>空串 {@code category} 键</b>会让上游直接返回 {@code total_count = 0}
     * （{@code {"filter":{}}} → 12799；{@code {"filter":{"category":""}}} → 0；
     * {@code {"filter":{"category":"search"}}} → 1089）。
     * 因此 category 为空时<b>必须整键省略</b>，绝不能发空串，否则「全部」分类永远空白。</p>
     *
     * <p>{@code is_hosted} 语义正常（false → 7993，true → 4806，相加 = 12799），始终发送。</p>
     */
    public static String listBody(String search, long page, long pageSize, String category, boolean hosted) {
        int[] clamped = clampPaging(page, pageSize);
        ONode root = new ONode().asObject();
        root.set("search", search == null ? "" : search);
        root.set("page_number", clamped[0]);
        root.set("page_size", clamped[1]);
        ONode filter = root.getOrNew("filter").asObject();
        String cat = category == null ? "" : category.trim();
        if (!cat.isEmpty()) {
            // 只在有值时插入该键；空串会让上游返回 0 条（见方法注释）
            filter.set("category", cat);
        }
        filter.set("is_hosted", hosted);
        return root.toJson();
    }

    // ==================== 上游传输 ====================

    /**
     * 解析上游信封。{@code success != true}、缺 {@code data} 都是失败，
     * <b>绝不降级成空成功</b>（否则前端显示「未找到 MCP 服务」，用户以为是搜索无结果）。
     *
     * @return {@code data} 节点
     * @throws McpMarketException 上游返回失败信封、非 2xx 或响应无法解析
     */
    static ONode unpack(HttpResponse resp) throws McpMarketException {
        int status = resp.code();
        String text;
        try {
            text = resp.bodyAsString();
        } catch (Exception e) {
            throw new McpMarketException("读取魔搭 MCP 广场响应失败: " + e.getMessage());
        }
        if (status < 200 || status >= 300) {
            throw new McpMarketException("魔搭 MCP 广场返回 HTTP " + status);
        }
        ONode root;
        try {
            root = ONode.ofJson(text);
        } catch (Exception e) {
            throw new McpMarketException("解析魔搭 MCP 广场响应失败: " + e.getMessage());
        }
        if (root == null || root.isNull()) {
            throw new McpMarketException("魔搭 MCP 广场响应为空");
        }
        ONode success = root.get("success");
        // 用 getBoolean(false)：上游若把 success 发成非布尔值，裸 getBoolean() 会返回
        // null，自动拆箱即 NPE —— 那会把「上游返回奇怪结构」变成 500 而不是可读的 400。
        if (success == null || success.isNull() || !success.getBoolean(false)) {
            ONode msg = root.get("message");
            String text0 = (msg == null || msg.isNull()) ? "魔搭 MCP 广场返回 success=false" : msg.getString();
            throw new McpMarketException(text0);
        }
        ONode data = root.get("data");
        if (data == null || data.isNull()) {
            throw new McpMarketException("魔搭 MCP 广场响应缺少 data");
        }
        return data;
    }

    /**
     * 列表 / 搜索。
     *
     * @return {@code {total_count, mcp_server_list, page_number, page_size}}
     */
    public Map<String, Object> servers(String search, long page, long pageSize, String category, boolean hosted)
            throws McpMarketException {
        String body = listBody(search, page, pageSize, category, hosted);
        int[] clamped = clampPaging(page, pageSize);
        ONode data;
        try (HttpResponse resp = HttpUtils.http(LIST_URL)
                .header("User-Agent", USER_AGENT)
                // 单位：秒（connect/write/read）
                .timeout(10, 10, 15)
                .bodyOfJson(body)
                .exec("PUT")) {
            data = unpack(resp);
        } catch (McpMarketException e) {
            throw e;
        } catch (Exception e) {
            throw new McpMarketException("请求魔搭 MCP 广场失败: " + e.getMessage());
        }

        Map<String, Object> out = new LinkedHashMap<>();
        ONode total = data.get("total_count");
        out.put("total_count", (total == null || total.isNull()) ? 0L : total.getLong());
        ONode list = data.get("mcp_server_list");
        // 列表接口实测字段：id, publisher, name, chinese_name, description, tags,
        // logo_url, view_count, locales, categories（数组）。**不含** is_hosted /
        // is_verified —— 那两个只在详情接口里。
        out.put("mcp_server_list", (list == null || list.isNull())
                ? new ArrayList<>()
                : list.toBean(List.class));
        out.put("page_number", clamped[0]);
        out.put("page_size", clamped[1]);
        return out;
    }

    /**
     * 详情。{@code env_schema} 上游可能是 JSON <b>字符串</b>，统一解析成对象，
     * 前端表单不必分叉。
     *
     * <p>同时注入 {@code env_supported}：告知前端「这个服务填的环境变量能不能被存下来」，
     * http 家族存不下 env，前端据此<b>不渲染</b> env 表单，从源头消掉「索要密钥 →
     * 静默丢弃 → 却提示安装成功」的路径。判据由
     * {@link McpMarketConfigNormalizer#envSupported(ONode)} 给出（与安装侧归一化
     * 共用 {@link com.gourdai.core.config.McpTypeResolver} 这一个 http 判定真源），
     * 前端只读标志、不自己判类型。</p>
     */
    public Map<String, Object> detail(String id) throws McpMarketException {
        if (id == null || id.trim().isEmpty()) {
            throw new McpMarketException("id is required");
        }
        ONode data;
        try (HttpResponse resp = HttpUtils.http(detailUrl(id))
                .header("User-Agent", USER_AGENT)
                .timeout(10, 10, 15)
                .exec("GET")) {
            data = unpack(resp);
        } catch (McpMarketException e) {
            throw e;
        } catch (Exception e) {
            throw new McpMarketException("请求魔搭 MCP 服务详情失败: " + e.getMessage());
        }
        normalizeEnvSchema(data);
        data.set("env_supported", McpMarketConfigNormalizer.envSupported(data));
        return data.toBean(Map.class);
    }

    /**
     * 详情数据（保留 ONode 形态，供安装路径做归一化，避免 Map↔ONode 往返丢结构）。
     */
    public ONode detailNode(String id) throws McpMarketException {
        if (id == null || id.trim().isEmpty()) {
            throw new McpMarketException("id is required");
        }
        ONode data;
        try (HttpResponse resp = HttpUtils.http(detailUrl(id))
                .header("User-Agent", USER_AGENT)
                .timeout(10, 10, 15)
                .exec("GET")) {
            data = unpack(resp);
        } catch (McpMarketException e) {
            throw e;
        } catch (Exception e) {
            throw new McpMarketException("请求魔搭 MCP 服务详情失败: " + e.getMessage());
        }
        normalizeEnvSchema(data);
        return data;
    }

    /**
     * {@code env_schema} 若为 JSON 字符串则就地解析为对象；解析失败保留原值，
     * 由后续 {@code resolveEnv} 按「无 schema」处理。
     */
    static void normalizeEnvSchema(ONode data) {
        ONode schema = data.get("env_schema");
        if (schema == null || schema.isNull()) {
            return;
        }
        try {
            if (schema.isString()) {
                String s = schema.getString();
                if (s != null && !s.trim().isEmpty()) {
                    data.set("env_schema", ONode.ofJson(s));
                }
            }
        } catch (Exception e) {
            LOG.debug("[McpMarket] env_schema 解析失败，按原值保留: {}", e.getMessage());
        }
    }

    public List<Map<String, String>> categories() {
        return CATEGORIES;
    }

    /** 魔搭 MCP 广场调用失败（上游错误 / 网络 / 解析）。统一转 400 信封返回前端。 */
    public static class McpMarketException extends Exception {
        public McpMarketException(String message) {
            super(message);
        }
    }
}
