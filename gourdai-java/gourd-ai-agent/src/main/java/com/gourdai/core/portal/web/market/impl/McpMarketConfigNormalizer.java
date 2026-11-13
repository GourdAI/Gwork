package com.gourdai.core.portal.web.market.impl;

import com.gourdai.core.config.McpTypeResolver;
import org.noear.snack4.ONode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 魔搭 MCP 广场详情的 {@code server_config} → {@code /web/settings/mcp/servers/add}
 * 请求体的<b>纯函数</b>归一化。
 *
 * <p>与 Rust 版 {@code server/mcp_market_api.rs} 的
 * {@code normalize_server_config} / {@code resolve_env} /
 * {@code assert_http_has_no_env_schema} 行为对等。抽成独立静态类是为了可单测：
 * 这些函数不依赖 settings / engine，只吃上游 JSON。</p>
 *
 * <p>上游三种实测形态：</p>
 * <ul>
 *   <li>stdio：{@code {"command":"uvx","args":["mcp-server-fetch"],"env":{...}}}
 *       （上游 stdio 项通常<b>不写</b> {@code type}）</li>
 *   <li>sse / streamable_http：{@code {"type":"sse","url":"https://...","headers":{...}}}</li>
 * </ul>
 *
 * <p>归一化后的字段与手动添加 MCP 的提交体完全同形，因此可以直接交给
 * {@code WebSettingsController#addMcpServerNode}，不另造配置格式。</p>
 */
public final class McpMarketConfigNormalizer {

    private McpMarketConfigNormalizer() {
    }

    /**
     * http 家族（sse / streamable / streamable_stateless）与 env_schema 的冲突检查。
     *
     * <p>背景：{@code addMcpServerNode} 对 http 类型只写 {@code url} / {@code headers}，
     * <b>没有 env 字段</b>（env 是 stdio 专有）。若上游某个服务是 http 型配置、却又声明了
     * 需要填值的 {@code env_schema}，那么前端弹窗会向用户索要密钥，用户填完、我们却无处保存
     * —— 结果是「安装成功」提示 + 密钥被静默丢弃，服务连不上且无从排查。</p>
     *
     * <p>因此在归一化的<b>必经之路</b>上做这个检查（{@link #normalize} 内部调用），
     * 而不是只依赖控制器的提前调用：接线点可被误删，必经之路删不掉。</p>
     *
     * <p>2026-11 上游实测 hosted / 非 hosted 样本的 server_config 全为 stdio（http 0 例），
     * 当前走不到；这是上游改形态后的显式护栏，不是已发生的故障。</p>
     *
     * <p>判据必须是 {@code env_schema.required} 非空，<b>不是</b> {@code properties} 非空。</p>
     *
     * <p><b>⚠ 2026-11 codereview 更正：</b>本段旧注释曾断言「前端详情弹窗只在 required
     * 非空时才索要密钥」，并以此论证按 required 判定不会漏。<b>那个前提是错的</b>：
     * 它引用的是 {@code app-mcp-market.js} 里 {@code install()} 的直装转弹窗分支，
     * 而真正渲染表单的 {@code showDetail()} 用的是 {@code Object.keys(props).length > 0}。
     * 于是「http 型 + 只有可选 env 项」会形成一条静默丢密钥的路径：前端摆输入框索要值
     * → 本 guard 因 required 空而放行 → 用户填了 → {@link #normalize} 的 http 分支
     * 无处写 {@code suppliedEnv} → 提示安装成功、密钥丢失、连不上且无从排查。</p>
     *
     * <p>现由 {@link #envSupported(ONode)}（内核唯一真源，前端只读 {@code env_supported}
     * 标志）在<b>渲染表单之前</b>就消掉这条路：http 型根本不渲染 env 表单，用户无从填、
     * 也就不存在被丢弃的值。本 guard 仍保留，作为 install 入口的最后防线
     * （绕过前端直调 API 时依然拦得住）。</p>
     *
     * <p>为什么仍不按 properties 判定：那会把「有可选/带 default 的 env 项但无必填项」的
     * http 服务一并拦死。在 {@link #envSupported} 已让前端不再索要值之后，这种服务
     * install 会正常成功（用户没被要求填任何东西），拦它纯属误报。</p>
     *
     * <p>与 Rust 版 {@code assert_http_has_no_env_schema} 行为对等。</p>
     *
     * @throws IllegalArgumentException 冲突时抛出，message 含服务名、存不下的必填变量名与替代方案
     */
    public static void assertHttpHasNoEnvSchema(ONode data) {
        ONode first = firstServerConfig(data);
        if (first == null) {
            return;
        }
        ONode servers = first.get("mcpServers");
        if (servers == null || servers.isNull() || !servers.isObject()) {
            return;
        }
        List<String> required = requiredKeys(data);
        if (required.isEmpty()) {
            return;
        }
        for (Map.Entry<String, ONode> e : servers.getObject().entrySet()) {
            ONode cfg = e.getValue();
            String rawKind = cfg.hasKey("type") && !cfg.get("type").isNull()
                    ? str(cfg.get("type")).trim() : "";
            if (!rawKind.isEmpty() && McpTypeResolver.isHttpType(rawKind)) {
                throw new IllegalArgumentException(String.format(
                        "MCP 服务 %s 是 %s 类型，其配置只能携带 url/headers，无法保存环境变量 %s。"
                                + "请使用「手动添加 MCP」并把凭据填入请求头（headers）。",
                        e.getKey(), rawKind, String.join(", ", required)));
            }
        }
    }

    /**
     * 该服务的环境变量能否被持久化 —— 即「详情弹窗是否应该渲染 env 表单」。
     * 由详情接口注入为 {@code env_supported} 字段供前端读取。
     *
     * <p><b>为什么这个判据必须活在内核、而不是前端复刻：</b>http 家族
     * （sse / streamable / streamable_stateless）在提交体里只落 {@code url} /
     * {@code headers}，<b>没有 env 字段</b>；只有 stdio 存得下 env。若前端自己判类型，
     * 就必须复刻 {@link McpTypeResolver} 那 20 多条别名（remote / ssehttp /
     * streamablehttp / sse-http …）——<b>必然漏</b>。历史上正是这么漏的：归一化曾硬编码过
     * 一份别名字符串白名单，漏掉 remote / ssehttp 且大小写敏感，上游写 {@code "SSE"} 时
     * 两个判定源分叉（见 {@link #normalize} 的同源说明）。所以这里直接调
     * {@link McpTypeResolver#isHttpType}，与 {@link #assertHttpHasNoEnvSchema} /
     * {@link #normalize} <b>同一个真源</b>。</p>
     *
     * <p><b>语义：</b></p>
     * <ul>
     *   <li>任一 server 配置是 http 家族 → {@code false}（env 存不下，不该向用户索要）</li>
     *   <li>否则（全 stdio / 无 server_config / 无 type 字段）→ {@code true}</li>
     * </ul>
     *
     * <p>无 {@code server_config} 时返回 {@code true} 是有意的：那是上游数据残缺，此时让
     * 前端维持既有形态（按 env_schema 渲染）比一律禁掉表单更安全 —— install 侧的
     * {@code resolveEnv} 仍是最终防线，缺必填会明确报错，不会伪造成功。</p>
     *
     * <p>与 Rust 版 {@code server/mcp_market_api.rs::env_supported} 行为对等。</p>
     */
    public static boolean envSupported(ONode data) {
        ONode first = firstServerConfig(data);
        if (first == null) {
            return true;
        }
        ONode servers = first.get("mcpServers");
        if (servers == null || servers.isNull() || !servers.isObject()) {
            return true;
        }
        for (Map.Entry<String, ONode> e : servers.getObject().entrySet()) {
            ONode cfg = e.getValue();
            String rawKind = cfg.hasKey("type") && !cfg.get("type").isNull()
                    ? str(cfg.get("type")).trim() : "";
            if (!rawKind.isEmpty() && McpTypeResolver.isHttpType(rawKind)) {
                return false;
            }
        }
        return true;
    }

    /** 读 {@code env_schema.required}（字符串数组）；缺失或形态异常时返回空表。 */
    private static List<String> requiredKeys(ONode data) {
        List<String> out = new ArrayList<>();
        if (data == null) {
            return out;
        }
        ONode schema = data.get("env_schema");
        if (schema == null || schema.isNull() || !schema.isObject()) {
            return out;
        }
        ONode req = schema.get("required");
        if (req == null || req.isNull() || !req.isArray()) {
            return out;
        }
        for (ONode n : req.getArray()) {
            String s = str(n);
            if (!s.isEmpty()) {
                out.add(s);
            }
        }
        return out;
    }

    /**
     * 上游 {@code server_config[0].mcpServers} → 若干条可直接提交的配置节点。
     *
     * <p>只取 {@code server_config} 的<b>第一项</b>：实测该项是上游推荐的默认配置，
     * 后续项可能是平台/系统变体甚至占位垃圾（例如 {@code slcatwujian/bing-cn-mcp-server}
     * 有 3 项，第 3 项是 {@code {"command":"...","args":["..."]}} 占位符），全装会污染配置。</p>
     *
     * @param suppliedEnv 用户在详情弹窗按 {@code env_schema} 填写的环境变量（可空）
     * @return 每个元素是一条 {@code {name, configNode}}；configNode 与手动添加提交体同形
     * @throws IllegalArgumentException 缺 server_config / 缺 mcpServers / 无法识别类型 /
     *                                  http 型带 env_schema（见 {@link #assertHttpHasNoEnvSchema}）
     */
    public static List<Map.Entry<String, ONode>> normalize(ONode data, Map<String, String> suppliedEnv) {
        ONode first = firstServerConfig(data);
        if (first == null) {
            throw new IllegalArgumentException("魔搭 MCP 服务缺少 server_config，无法安装");
        }
        ONode servers = first.get("mcpServers");
        if (servers == null || servers.isNull() || !servers.isObject()) {
            throw new IllegalArgumentException("魔搭 MCP 服务缺少 mcpServers 配置");
        }
        if (servers.getObject().isEmpty()) {
            throw new IllegalArgumentException("魔搭 MCP 服务的 mcpServers 为空");
        }
        // 必经之路上的护栏：删掉控制器的提前调用也拦得住
        assertHttpHasNoEnvSchema(data);

        List<Map.Entry<String, ONode>> out = new ArrayList<>();
        for (Map.Entry<String, ONode> e : servers.getObject().entrySet()) {
            String name = e.getKey();
            ONode cfg = e.getValue();
            String rawKind = cfg.hasKey("type") && !cfg.get("type").isNull()
                    ? str(cfg.get("type")).trim() : "";

            ONode node = new ONode().asObject();
            node.set("name", name);
            node.set("enabled", true);
            node.set("scope", "user");

            if (!rawKind.isEmpty() && McpTypeResolver.isHttpType(rawKind)) {
                node.set("type", McpTypeResolver.standardize(rawKind));
                node.set("url", cfg.hasKey("url") ? str(cfg.get("url")) : "");
                if (cfg.hasKey("headers") && cfg.get("headers").isObject()) {
                    node.set("headers", copyStringMap(cfg.get("headers")));
                }
                // http 家族存不下 env；冲突已在 assertHttpHasNoEnvSchema 拦掉，
                // 此处不再用 suppliedEnv 判断 —— 它由 resolveEnv 产出、含 schema 的
                // default 值，用户一个字没填也会非空，会误报。
            } else {
                String command = cfg.hasKey("command") ? str(cfg.get("command")).trim() : "";
                if (command.isEmpty()) {
                    throw new IllegalArgumentException(
                            "MCP 服务 " + name + " 既没有 command 也不是可识别的 HTTP 类型");
                }
                node.set("type", rawKind.isEmpty()
                        ? McpTypeResolver.TYPE_STDIO
                        : McpTypeResolver.standardize(rawKind));
                node.set("command", cfg.hasKey("command") ? str(cfg.get("command")) : "");
                node.set("args", cfg.hasKey("args") ? copyStringArray(cfg.get("args")) : new ArrayList<String>());
                node.set("env", mergeEnv(cfg, suppliedEnv));
            }
            out.add(new java.util.AbstractMap.SimpleImmutableEntry<>(name, node));
        }
        return out;
    }

    /** 上游 env（可能带空占位）与用户填写值合并；空值不覆盖。 */
    private static Map<String, String> mergeEnv(ONode cfg, Map<String, String> suppliedEnv) {
        Map<String, String> env = new LinkedHashMap<>();
        if (cfg.hasKey("env") && cfg.get("env").isObject()) {
            for (Map.Entry<String, ONode> e : cfg.get("env").getObject().entrySet()) {
                env.put(e.getKey(), str(e.getValue()));
            }
        }
        if (suppliedEnv != null) {
            for (Map.Entry<String, String> e : suppliedEnv.entrySet()) {
                if (e.getValue() != null && !e.getValue().trim().isEmpty()) {
                    env.put(e.getKey(), e.getValue());
                }
            }
        }
        return env;
    }

    /**
     * 按 {@code env_schema} 解析用户填写的环境变量。
     *
     * <p>规则：</p>
     * <ol>
     *   <li>缺省值取 {@code properties.*.default}（若上游提供）</li>
     *   <li>用户填写值<b>只接受 schema 声明过的键</b> —— 防止把任意字段塞进进程环境变量</li>
     *   <li>{@code required} 里的键必须有非空值，否则报错并列出缺失项</li>
     * </ol>
     *
     * @throws IllegalArgumentException 必填项缺失时抛出，message 列出缺失的键
     */
    public static Map<String, String> resolveEnv(ONode data, Map<String, String> supplied) {
        ONode props = envProperties(data);
        Set<String> allowed = new LinkedHashSet<>();
        Map<String, String> env = new LinkedHashMap<>();
        if (props != null) {
            for (Map.Entry<String, ONode> e : props.getObject().entrySet()) {
                allowed.add(e.getKey());
                ONode spec = e.getValue();
                if (spec != null && spec.isObject() && spec.hasKey("default")
                        && !spec.get("default").isNull()) {
                    env.put(e.getKey(), str(spec.get("default")));
                }
            }
        }
        if (supplied != null) {
            for (Map.Entry<String, String> e : supplied.entrySet()) {
                String v = e.getValue();
                if (allowed.contains(e.getKey()) && v != null && !v.trim().isEmpty()) {
                    env.put(e.getKey(), v);
                }
            }
        }
        List<String> required = new ArrayList<>();
        ONode schema = data == null ? null : data.get("env_schema");
        if (schema != null && schema.isObject() && schema.hasKey("required")) {
            ONode req = schema.get("required");
            if (req != null && req.isArray()) {
                for (ONode n : req.getArray()) {
                    required.add(str(n));
                }
            }
        }
        List<String> missing = new ArrayList<>();
        for (String k : required) {
            String v = env.get(k);
            if (v == null || v.trim().isEmpty()) {
                missing.add(k);
            }
        }
        if (!missing.isEmpty()) {
            throw new IllegalArgumentException("请补充必填环境变量: " + String.join(", ", missing));
        }
        return env;
    }

    // ==================== 内部工具 ====================

    private static ONode firstServerConfig(ONode data) {
        if (data == null) {
            return null;
        }
        ONode sc = data.get("server_config");
        if (sc == null || sc.isNull() || !sc.isArray() || sc.getArray().isEmpty()) {
            return null;
        }
        ONode first = sc.getArray().get(0);
        return (first == null || first.isNull() || !first.isObject()) ? null : first;
    }

    private static ONode envProperties(ONode data) {
        if (data == null) {
            return null;
        }
        ONode schema = data.get("env_schema");
        if (schema == null || schema.isNull() || !schema.isObject()) {
            return null;
        }
        ONode props = schema.get("properties");
        if (props == null || props.isNull() || !props.isObject()) {
            return null;
        }
        return props;
    }

    private static ONode copyStringMap(ONode node) {
        ONode out = new ONode().asObject();
        for (Map.Entry<String, ONode> e : node.getObject().entrySet()) {
            out.set(e.getKey(), str(e.getValue()));
        }
        return out;
    }

    private static List<String> copyStringArray(ONode node) {
        List<String> out = new ArrayList<>();
        if (node != null && node.isArray()) {
            for (ONode n : node.getArray()) {
                out.add(str(n));
            }
        }
        return out;
    }

    private static String str(ONode n) {
        if (n == null || n.isNull()) {
            return "";
        }
        String s = n.getString();
        return s == null ? "" : s;
    }
}
