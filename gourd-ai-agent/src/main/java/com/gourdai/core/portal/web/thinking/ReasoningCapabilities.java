package com.gourdai.core.portal.web.thinking;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 推理能力解析：把「模型」翻译成 {@link ReasoningCapability}。
 *
 * <h3>三级回退（顺序不可调换）</h3>
 * <ol>
 *   <li><b>用户覆写</b>——模型配置里的 {@code capabilities.reasoning}。
 *       最高优先级，用于兜住任何表错、厂商临时变更、私有中转。</li>
 *   <li><b>官方档位规则表</b>——按模型名匹配厂商官方公布的 effort 值域与参数形态。</li>
 *   <li><b>接口兜底</b>——只知道接口类型时的保守取值。</li>
 * </ol>
 *
 * <h3>核心设计一：形态（shape）与值域（pool）正交</h3>
 * <ul>
 *   <li><b>形态由接口决定</b>——同一个 {@code gpt-5.6} 走 Chat Completions 是顶层
 *       {@code reasoning_effort}，走 Responses 是 {@code reasoning.effort}，
 *       但它支持的档位值域完全一样。</li>
 *   <li><b>值域由模型决定</b>——同属 OpenAI 接口，{@code gpt-5.6} 有 xhigh/max，
 *       {@code gpt-5.4} 只到 xhigh，{@code gpt-5-pro} 更是只有 high 一个值。</li>
 * </ul>
 * <p>故规则表默认<b>只声明值域</b>，形态留给接口推断；只有当模型的 wire 格式确实与接口默认不同时
 * （经典 Claude 的 budget_tokens、Gemini 2.5 的 thinkingBudget）才显式指定形态。</p>
 *
 * <h3>核心设计二：按<b>版本区间</b>而非子串匹配</h3>
 * <p>这是本类的关键机制。厂商的档位能力随版本<b>单调扩张</b>（实测 OpenAI gpt 系最高档
 * high→xhigh→max 单调不降，Anthropic claude-opus 4.5→4.6→4.7 逐代扩张），
 * 而模型名里的版本号是有序的——用无序的子串匹配去表达有序的版本演进，必然出错：</p>
 * <pre>
 *   规则 "gpt-5" → [minimal,low,medium,high]
 *   模型 gpt-5.7 会被它子串命中 → 只剩四档
 *   但 gpt-5.6 早已支持 max —— 新版本反而比老版本档位少，能力倒退
 * </pre>
 * <p>故对有版本演进的家族一律用 {@link Match#VERSION_RANGE}：规则声明
 * 「家族 + 版本区间」，末档区间的上界为无穷。这样<b>未来版本自动继承该家族最新的已知能力</b>，
 * 新模型发布无需改代码：{@code gpt-7} 落 {@code [5.6, ∞)} 区间直接拿到完整五档。</p>
 *
 * <h3>为什么形态规则要「列举老的、放行新的」</h3>
 * <p>以 Anthropic 为例：废弃 {@code budget_tokens} 的现代模型是<b>持续新增</b>的开放集合，
 * 而仍用 budget_tokens 的老模型是<b>已封闭</b>的集合。故形态规则只列举老模型，
 * 未匹配者一律按现代格式处理——实测 {@code claude-opus-4-7/4-8/mythos-5} 等
 * 本表未登记的新型号均据此自动取得正确的五档。</p>
 *
 * <h3>已知的厂商数据冲突</h3>
 * <p>同一模型经不同渠道公布的能力可能不一致（例如 {@code glm-5.2} 在智谱自营口
 * 只标 {@code [high,max]}，在其它云的聚合口标了完整七值）。本表在冲突时取
 * <b>保守值</b>——少报档位只会让用户少一个选项，多报则会直接 400。
 * 需要完整能力的用户可用 {@code capabilities.reasoning} 覆写。</p>
 *
 * @author oisin
 */
public final class ReasoningCapabilities {

    private ReasoningCapabilities() {
    }

    /** 用户覆写中承载推理能力的键名。 */
    private static final String KEY_REASONING = "reasoning";

    /** 经典 Claude 的思考预算硬下限（官方要求 ≥1024）。 */
    private static final int ANTHROPIC_BUDGET_MIN = 1024;

    // ==================================================================
    // 版本编码
    // ==================================================================

    /**
     * 版本号编码为 {@code major * 1000 + minor}，便于用整数比较表达区间。
     *
     * <p>必须按「段」而非浮点比较：{@code grok-4.20} 比 {@code grok-4.6} 新，
     * 但浮点数 4.20 &lt; 4.6 会得出相反结论。编码后 4020 &gt; 4006，次序正确。</p>
     */
    private static long ver(int major, int minor) {
        return major * 1000L + minor;
    }

    /** 版本区间上界的无穷大——用于「该家族此后所有版本」。 */
    private static final long VER_MAX = Long.MAX_VALUE;

    /** 解析失败的哨兵值。 */
    private static final long VER_NONE = -1L;

    /**
     * 从模型名中定位家族片段，解析其后紧跟的版本号。
     *
     * <p>输入已经过 {@link #canon} 归一，故 {@code gpt-5.6} 与 {@code gpt-5-6} 形态一致。</p>
     *
     * <pre>
     *   verAfter("gpt-5-6-sol",              "gpt")         → 5006
     *   verAfter("gpt-5-mini",               "gpt")         → 5000   （次版本缺省为 0）
     *   verAfter("qwen3-8-max",              "qwen")        → 3008   （家族与版本间无分隔符）
     *   verAfter("grok-4-20-multi-agent",    "grok")        → 4020
     *   verAfter("claude-sonnet-4-20250514", "claude-sonnet")→ 4000  （日期后缀不计入次版本）
     *   verAfter("qwen3-8b",                 "qwen")        → 3000   （8b 是参数量不是次版本）
     *   verAfter("gpt-oss",                  "gpt")         → VER_NONE
     * </pre>
     */
    private static long verAfter(String model, String family) {
        int i = model.indexOf(family);
        while (i >= 0) {
            int p = i + family.length();
            if (p < model.length() && model.charAt(p) == '-') {
                p++;
            }
            if (p < model.length() && isDigit(model.charAt(p))) {
                int s = p;
                while (p < model.length() && isDigit(model.charAt(p))) {
                    p++;
                }
                int major = parseIntSafe(model.substring(s, p));
                int minor = 0;
                if (p + 1 < model.length() && model.charAt(p) == '-' && isDigit(model.charAt(p + 1))) {
                    int s2 = p + 1;
                    int q = s2;
                    while (q < model.length() && isDigit(model.charAt(q))) {
                        q++;
                    }
                    String seg = model.substring(s2, q);
                    // 排除两类「看起来像次版本」的数字段：
                    //   1) 长数字段是日期后缀（claude-sonnet-4-20250514 / glm-5-2-260617）
                    //   2) 紧跟字母的是参数量（qwen3-8b 的 8b、qwen3-235b 的 235b），
                    //      不加这条会把 qwen3-8b 误判成 qwen3.8 而错给 effort 档位
                    boolean isParamCount = q < model.length() && !isDigit(model.charAt(q))
                            && model.charAt(q) != '-';
                    if (seg.length() <= 3 && !isParamCount) {
                        minor = parseIntSafe(seg);
                    }
                }
                return ver(major, minor);
            }
            i = model.indexOf(family, i + 1);
        }
        return VER_NONE;
    }

    private static boolean isDigit(char c) {
        return c >= '0' && c <= '9';
    }

    private static int parseIntSafe(String s) {
        try {
            return Integer.parseInt(s);
        } catch (NumberFormatException ignore) {
            return 0;
        }
    }

    // ==================================================================
    // 官方档位规则表
    // ==================================================================

    /** 规则命中后要产出的能力种类。 */
    private enum Kind {
        /** 不支持推理控制（可推理但完全不可调）。 */
        NONE,
        /** 仅支持开关，无法调档。 */
        TOGGLE,
        /** 按 token 预算控制，形态需显式指定。 */
        BUDGET,
        /** 按 effort 值调档，形态由接口推断。 */
        POOL
    }

    /** 模型名匹配方式。 */
    private enum Match {
        /** 子串包含——用于无版本演进、或需覆盖日期后缀与区域前缀的具体型号。 */
        CONTAINS,
        /** 前缀匹配——用于 {@code o1} / {@code o3} 这类极短名，避免误伤其它模型名内的巧合子串。 */
        STARTS_WITH,
        /** 版本区间——用于有版本演进的家族，末档区间放行未来版本。 */
        VERSION_RANGE
    }

    private static final class Rule {
        final Match match;
        final List<String> fragments;
        /** VERSION_RANGE 专用：家族片段。 */
        final String family;
        final long minVer;
        final long maxVer;
        /** VERSION_RANGE 专用：附加的子串条件（用于区分 -pro / -chat 等变体），可为 null。 */
        final String requires;
        final Kind kind;
        final ReasoningCapability.Shape budgetShape;
        final Set<String> pool;
        final Integer budgetMin;
        final Integer budgetMax;

        Rule(Match match, List<String> fragments, String family, long minVer, long maxVer, String requires,
             Kind kind, ReasoningCapability.Shape budgetShape, Set<String> pool,
             Integer budgetMin, Integer budgetMax) {
            this.match = match;
            // 片段与待匹配的模型名统一走 canon()，故此处预先归一，避免每次匹配重复计算
            this.fragments = canonAll(fragments);
            this.family = canon(family);
            this.minVer = minVer;
            this.maxVer = maxVer;
            this.requires = requires == null ? null : canon(requires);
            this.kind = kind;
            this.budgetShape = budgetShape;
            this.pool = pool;
            this.budgetMin = budgetMin;
            this.budgetMax = budgetMax;
        }

        boolean hits(String model) {
            if (match == Match.VERSION_RANGE) {
                if (requires != null && !model.contains(requires)) {
                    return false;
                }
                long v = verAfter(model, family);
                return v != VER_NONE && v >= minVer && v <= maxVer;
            }
            for (String f : fragments) {
                if (match == Match.STARTS_WITH ? model.startsWith(f) : model.contains(f)) {
                    return true;
                }
            }
            return false;
        }

        /**
         * 产出能力。
         *
         * @param interfaceShape 由接口推断出的形态——{@link Kind#POOL} 规则采用它，
         *                       从而让同一份值域在 chat / responses / vertex 等接口上都成立
         */
        ReasoningCapability toCapability(ReasoningCapability.Shape interfaceShape) {
            switch (kind) {
                case NONE:
                    return ReasoningCapability.NONE;
                case TOGGLE:
                    return ReasoningCapability.ofToggle();
                case BUDGET:
                    return ReasoningCapability.ofBudget(budgetShape, budgetMin, budgetMax);
                default:
                    return ReasoningCapability.ofEffort(interfaceShape, pool);
            }
        }
    }

    private static final List<Rule> RULES = new ArrayList<>();

    private static void none(String... frags) {
        RULES.add(new Rule(Match.CONTAINS, Arrays.asList(frags), null, 0, 0, null,
                Kind.NONE, null, null, null, null));
    }

    private static void toggle(String... frags) {
        RULES.add(new Rule(Match.CONTAINS, Arrays.asList(frags), null, 0, 0, null,
                Kind.TOGGLE, null, null, null, null));
    }

    private static void budget(ReasoningCapability.Shape shape, Integer min, Integer max, String... frags) {
        RULES.add(new Rule(Match.CONTAINS, Arrays.asList(frags), null, 0, 0, null,
                Kind.BUDGET, shape, null, min, max));
    }

    /** 登记官方 effort 值域（形态留给接口推断）。 */
    private static void pool(String csv, String... frags) {
        RULES.add(new Rule(Match.CONTAINS, Arrays.asList(frags), null, 0, 0, null,
                Kind.POOL, null, csv(csv), null, null));
    }

    /** 同 {@link #pool}，但用前缀匹配。 */
    private static void poolStarts(String csv, String... frags) {
        RULES.add(new Rule(Match.STARTS_WITH, Arrays.asList(frags), null, 0, 0, null,
                Kind.POOL, null, csv(csv), null, null));
    }

    /** 登记某家族在某版本区间内的 effort 值域。 */
    private static void poolVer(String csv, String family, long minVer, long maxVer) {
        poolVer(csv, family, minVer, maxVer, null);
    }

    /** 同上，附加子串条件以区分同版本的不同变体（如 {@code -pro}）。 */
    private static void poolVer(String csv, String family, long minVer, long maxVer, String requires) {
        RULES.add(new Rule(Match.VERSION_RANGE, java.util.Collections.emptyList(), family, minVer, maxVer,
                requires, Kind.POOL, null, csv(csv), null, null));
    }

    /** 登记某家族在某版本区间内仅支持开关。 */
    private static void toggleVer(String family, long minVer, long maxVer) {
        RULES.add(new Rule(Match.VERSION_RANGE, java.util.Collections.emptyList(), family, minVer, maxVer,
                null, Kind.TOGGLE, null, null, null, null));
    }

    private static Set<String> csv(String csv) {
        Set<String> out = new LinkedHashSet<>();
        for (String s : csv.split(",")) {
            String v = s.trim().toLowerCase(Locale.ROOT);
            if (!v.isEmpty()) {
                out.add(v);
            }
        }
        return out;
    }

    /**
     * 模型名归一——把分隔符差异抹平，使一条规则能覆盖同一模型在各渠道的书写变体。
     *
     * <p>同一个模型经不同渠道暴露的 id 分隔符并不一致，实测存在三种方言：</p>
     * <ul>
     *   <li><b>连字符</b>（Anthropic / Bedrock 官方）：{@code claude-haiku-4-5}</li>
     *   <li><b>点号</b>（GitHub Copilot）：{@code claude-haiku-4.5}</li>
     *   <li><b>{@code @} 版本后缀</b>（Vertex AI）：{@code claude-sonnet-4@20250514}</li>
     * </ul>
     * <p>不归一的后果是真存在的缺陷：{@code claude-haiku-4.5} 会错过
     * budget_tokens 形态规则而被当成现代 Claude，发出 effort 参数直接 400。</p>
     *
     * <p>片段与模型名<b>两侧都走本方法</b>，故规则里既可写
     * {@code gpt-5.6} 也可写 {@code gpt-5-6}，二者等价。</p>
     */
    private static String canon(String raw) {
        if (raw == null) {
            return "";
        }
        String s = raw.trim().toLowerCase(Locale.ROOT);
        return s.replace('.', '-').replace('@', '-');
    }

    private static List<String> canonAll(List<String> raw) {
        List<String> out = new ArrayList<>(raw.size());
        for (String s : raw) {
            out.add(canon(s));
        }
        return out;
    }

    static {
        // --------------------------------------------------------------
        // 0. 可推理但完全不可调档 —— 必须最先判定
        //    （这些模型名常被后面的宽泛规则命中，如 kimi-k2.7-code 会落进 kimi 家族区间）
        // --------------------------------------------------------------
        none(
                "minimax-m2",        // MiniMax-M2 / M2.1 / M2.5 / M2.7：官方未公布任何 reasoning 选项
                "kimi-k2.7-code",    // k2.7 代码专用档：无 reasoning_options
                "kimi-k2-thinking",  // 各云托管的 k2-thinking：无 reasoning_options
                "magistral",         // Mistral 推理系：无档位
                "deepseek-r1",       // R1 系：思考不可控
                "qwq-plus", "qvq-max",
                "o1-mini", "o1-preview"
        );

        // --------------------------------------------------------------
        // 1. 形态例外：经典 Claude 仍用 thinking.budget_tokens
        //    现代 Claude（4-6 / 4-7 / 4-8 / 5 / fable-5 / mythos-5 ...）不在此列，自动走 effort
        // --------------------------------------------------------------
        budget(ReasoningCapability.Shape.ANTHROPIC_BUDGET, ANTHROPIC_BUDGET_MIN, null,
                "claude-3-7-sonnet", "claude-3-5-sonnet", "claude-3-5-haiku",
                "claude-3-opus", "claude-3-sonnet", "claude-3-haiku",
                "claude-sonnet-4-0", "claude-sonnet-4-20", "claude-sonnet-4-5",
                "claude-opus-4-0", "claude-opus-4-1", "claude-opus-4-20",
                "claude-haiku-4-5"
        );

        // --------------------------------------------------------------
        // 2. 形态例外：Gemini 2.5 用数值预算，没有 thinkingLevel
        //    官方区间：2.5-pro = 128..32768；2.5-flash(-lite) = 0..24576
        //    下限刻意抬到 512：官方允许 0，但 0 等于关闭思考，与本系统设计相悖
        // --------------------------------------------------------------
        budget(ReasoningCapability.Shape.GEMINI_BUDGET, 128, 32768, "gemini-2.5-pro");
        budget(ReasoningCapability.Shape.GEMINI_BUDGET, 512, 24576,
                "gemini-2.5-flash", "gemini-2.0-flash-thinking");

        // --------------------------------------------------------------
        // 3. OpenAI
        //    官方值域中的 "none" 一律不登记：它表示关闭思考，本系统不提供该能力
        // --------------------------------------------------------------
        // 3a. 具体型号特例（必须先于家族区间）
        pool("high", "gpt-5-pro");                       // 官方仅 [high]
        pool("low,medium,high", "gpt-chat-latest");       // 无版本号的 chat 端点：官方三档
        pool("minimal,low,medium,high,xhigh", "gpt-realtime");
        pool("low,medium,high,xhigh", "gpt-5.1-codex-max");
        pool("low,medium,high", "gpt-5-codex", "codex-mini", "gpt-oss");
        // 3b. 跨版本稳定的变体规律：Pro 系无低档、Chat 系极弱
        poolVer("medium,high,xhigh", "gpt", ver(5, 2), VER_MAX, "-pro");
        poolVer("medium", "gpt", ver(5, 0), VER_MAX, "-chat");
        // 3c. 家族版本区间。末档放行未来版本 —— gpt-5.7 / gpt-6.1 / gpt-7 自动取得完整五档。
        //     下界从 5.0 起：gpt-4o 等非推理模型不应被注入 effort
        poolVer("minimal,low,medium,high", "gpt", ver(5, 0), ver(5, 0));
        poolVer("low,medium,high", "gpt", ver(5, 1), ver(5, 1));
        poolVer("low,medium,high,xhigh", "gpt", ver(5, 2), ver(5, 5));
        poolVer("low,medium,high,xhigh,max", "gpt", ver(5, 6), VER_MAX);
        poolStarts("low,medium,high", "o1", "o3", "o4");

        // --------------------------------------------------------------
        // 4. Anthropic 官方值域（形态仍由接口给，故 bedrock / vertex 同样适用）
        //    未登记者走家族兜底五档 [low..max]
        // --------------------------------------------------------------
        pool("low,medium,high", "claude-opus-4-5");
        pool("low,medium,high,max", "claude-sonnet-4-6", "claude-opus-4-6");

        // --------------------------------------------------------------
        // 5. Gemini 3.x：Pro 与较新的 Flash 无 minimal
        // --------------------------------------------------------------
        pool("minimal,high", "gemini-3.1-flash-image", "gemini-3.1-flash-lite-image");
        pool("low,high", "gemini-3-pro-image");
        pool("low,medium,high", "gemini-3.7-flash", "gemini-3.8-flash");
        poolVer("low,medium,high", "gemini", ver(3, 0), VER_MAX, "-pro");
        poolVer("minimal,low,medium,high", "gemini", ver(3, 0), VER_MAX);

        // --------------------------------------------------------------
        // 6. 国产模型
        //    多数为 OpenAI 兼容口但只支持开关：收到 reasoning_effort 会静默忽略，
        //    归为 TOGGLE 后前端隐藏选择器，用户不会再选到无效档位
        // --------------------------------------------------------------
        // GLM：4.x 与 5.0/5.1 只有开关，5.2 起才有 effort
        // 智谱官方（docs.bigmodel.cn/cn/guide/capabilities/thinking）：
        //   GLM-5.2 接受 7 个值，但 low/medium→high、xhigh→max、minimal/none→放弃思考，
        //           故「有效档位」只有 high 与 max 两档，登记 7 值会造出 5 个假档位；
        //   GLM-5.3 明确「仅支持 max/high/low，其余输入将报错」——必须精确，不可多报。
        poolVer("high,max", "glm", ver(5, 2), ver(5, 2));
        poolVer("low,high,max", "glm", ver(5, 3), VER_MAX);
        toggleVer("glm", ver(0, 0), ver(5, 1));

        // DeepSeek：v3.x 及更早不可调档，v4 起有 effort
        // 官方（api-docs.deepseek.com）Chat Completions 明确 [low, high, max]，默认 high，
        // 且「映射表对 deepseek-v4-flash 与 deepseek-v4-pro 完全相同」——
        // pro 不得单列为 [high,max]（models.dev 的 pro 条目缺 low，已核实为错）。
        pool("low,high,max", "deepseek-flash");
        poolVer("low,high,max", "deepseek-v", ver(4, 0), VER_MAX);
        toggleVer("deepseek-v", ver(0, 0), ver(3, 999));

        // Kimi：k2.x 只有开关，k3 起有 effort
        // 官方（platform.kimi.com/docs/guide/use-reasoning-effort）：K3 顶层 reasoning_effort
        // 支持 low/high/max（默认 max）且始终思考；k2.7-code / k2.6 / k2.5 均不支持该字段。
        poolVer("low,high,max", "kimi-k", ver(3, 0), VER_MAX);
        toggleVer("kimi-k", ver(0, 0), ver(2, 999));
        toggle("kimi-latest", "moonshot-v1");

        // Qwen：3.7 及更早为开关/预算型，3.8 起有 effort（官方跳过 high，直接 xhigh）
        poolVer("low,medium,xhigh", "qwen", ver(3, 8), VER_MAX);
        toggleVer("qwen", ver(0, 0), ver(3, 7));
        toggle("qwen-plus", "qwen-max", "qwen-flash", "qwen-turbo");

        // 豆包：seed-1.6 四档，1.8 起六档；flash / vision 变体只有开关
        pool("minimal,low,high", "doubao-seed-character");           // 官方跳过 medium
        toggle("doubao-seed-1-6-flash", "doubao-seed-1-6-vision");
        pool("minimal,low,medium,high,xhigh,max", "doubao-seed-evolving");
        poolVer("minimal,low,medium,high,xhigh,max", "doubao-seed", ver(1, 7), VER_MAX);
        poolVer("minimal,low,medium,high", "doubao-seed", ver(0, 0), ver(1, 6));

        toggle("hunyuan", "ernie-x1", "minimax-m3", "command-a");

        // --------------------------------------------------------------
        // 7. 其它
        // --------------------------------------------------------------
        poolVer("low,medium,high,xhigh", "grok", ver(4, 6), VER_MAX);
        poolVer("low,medium,high", "grok", ver(0, 0), ver(4, 5));
        pool("high", "mistral-medium", "mistral-small");  // 官方 [none,high]，去掉 none 只剩 high
    }

    // ==================================================================
    // 家族兜底
    // ==================================================================

    /**
     * 家族兜底值域——规则表未命中时，假定未知型号<b>至少具备该家族最新已知型号的能力</b>。
     *
     * <p>只登记 Claude 一族，因为它是唯一「形态与值域会脱钩」的情形：Claude 经 OpenAI 兼容口
     * 访问时，形态由 standard 推断不出 {@code ANTHROPIC_EFFORT}，若无本兜底就会退到全局三档，
     * 而它实际支持到 max。</p>
     *
     * <p><b>刻意不为 gpt / grok / gemini 登记家族兜底</b>——这几族已由版本区间完整覆盖，
     * 再加兜底反而会把未命中的<b>非推理老模型</b>（如 {@code gpt-4o}）放大成五档。
     * 版本区间负责「已知家族的版本演进」，全局兜底负责「其余一切」，两者边界要清晰。</p>
     */
    private static final List<String[]> FAMILY_FALLBACK = java.util.Collections.singletonList(
            // {家族片段, 值域}
            new String[]{"claude", "low,medium,high,xhigh,max"}
    );

    private static Set<String> familyFallback(String model) {
        for (String[] pair : FAMILY_FALLBACK) {
            if (model.contains(canon(pair[0]))) {
                return csv(pair[1]);
            }
        }
        return null;
    }

    // ==================================================================
    // 解析入口
    // ==================================================================

    /**
     * 解析模型的推理能力。
     *
     * @param standard     接口类型（ChatModel#getStandardOrProvider），可为 null
     * @param modelName    模型名（如 claude-sonnet-4-5-20250929），可为 null
     * @param userOverride 模型配置里的 capabilities（可为 null）
     * @return 推理能力，永不为 null
     */
    public static ReasoningCapability resolve(String standard, String modelName,
                                              Map<String, Object> userOverride) {
        ReasoningCapability override = fromUserOverride(userOverride);
        if (override != null) {
            return override;
        }
        return fromOfficialRules(standard, modelName);
    }

    /** 无覆写数据时的简化入口。 */
    public static ReasoningCapability resolve(String standard, String modelName) {
        return resolve(standard, modelName, null);
    }

    // ------------------------------------------------------------------
    // 第 1 级：用户覆写
    // ------------------------------------------------------------------

    /**
     * 解析用户在模型配置里写的 {@code capabilities.reasoning}。
     *
     * <p>支持三种写法：</p>
     * <pre>
     * "reasoning": false                                  // 不支持推理控制
     * "reasoning": "anthropic_budget"                     // 只指定形态
     * "reasoning": { "shape": "openai_effort",
     *                "efforts": ["low","high"],
     *                "budgetMin": 1024, "budgetMax": 24576 }
     * </pre>
     *
     * @return 解析结果；无覆写或无法解析时返回 null（交由下一级处理）
     */
    @SuppressWarnings("unchecked")
    static ReasoningCapability fromUserOverride(Map<String, Object> capabilities) {
        if (capabilities == null || capabilities.isEmpty()) {
            return null;
        }
        Object node = capabilities.get(KEY_REASONING);
        if (node == null) {
            return null;
        }
        if (node instanceof Boolean) {
            return ((Boolean) node) ? null : ReasoningCapability.NONE;
        }
        if (node instanceof CharSequence) {
            ReasoningCapability.Shape shape = parseShape(node.toString());
            return shape == null ? null : buildByShape(shape, null, null, null);
        }
        if (!(node instanceof Map)) {
            return null;
        }
        Map<String, Object> m = (Map<String, Object>) node;
        ReasoningCapability.Shape shape = parseShape(asString(m.get("shape")));
        if (shape == null) {
            return null;
        }
        Set<String> efforts = asStringSet(m.get("efforts"));
        return buildByShape(shape, efforts, asInt(m.get("budgetMin")), asInt(m.get("budgetMax")));
    }

    private static ReasoningCapability buildByShape(ReasoningCapability.Shape shape, Set<String> efforts,
                                                    Integer budgetMin, Integer budgetMax) {
        if (shape == ReasoningCapability.Shape.NONE) {
            return ReasoningCapability.NONE;
        }
        if (shape == ReasoningCapability.Shape.TOGGLE) {
            return ReasoningCapability.ofToggle();
        }
        if (shape.isBudget()) {
            return ReasoningCapability.ofBudget(shape, budgetMin, budgetMax);
        }
        return ReasoningCapability.ofEffort(shape, efforts);
    }

    private static ReasoningCapability.Shape parseShape(String raw) {
        if (raw == null) {
            return null;
        }
        String s = raw.trim().toUpperCase(Locale.ROOT).replace('-', '_');
        for (ReasoningCapability.Shape shape : ReasoningCapability.Shape.values()) {
            if (shape.name().equals(s)) {
                return shape;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------
    // 第 2、3 级：官方规则表 + 家族兜底 + 接口兜底
    // ------------------------------------------------------------------

    /**
     * 按官方规则表解析；未命中时依次落到家族兜底、接口兜底。
     *
     * <p>形态先由接口推断，再交给规则决定是否推翻——{@link Kind#POOL} 规则只改值域不改形态，
     * 这正是「同一批模型经多种接口访问」无需重复登记的原因。</p>
     */
    static ReasoningCapability fromOfficialRules(String standard, String modelName) {
        ReasoningCapability.Shape interfaceShape = shapeOfStandard(standard);
        String model = canon(modelName);
        if (!model.isEmpty()) {
            for (Rule rule : RULES) {
                if (rule.hits(model)) {
                    return rule.toCapability(interfaceShape);
                }
            }
            Set<String> family = familyFallback(model);
            if (family != null) {
                return ReasoningCapability.ofEffort(interfaceShape, family);
            }
        }
        // 未命中：值域未知（null ≠ 空集），由形态给出保守默认
        return ReasoningCapability.ofEffort(interfaceShape, null);
    }

    /**
     * 仅凭接口类型推断<b>形态</b>。
     *
     * <p>分流与改造前一致：anthropic → 现代 effort 格式、responses → reasoning.effort、
     * gemini → thinkingLevel、其余 → 顶层 reasoning_effort。</p>
     */
    static ReasoningCapability.Shape shapeOfStandard(String standard) {
        String s = lower(standard);
        if (s.contains("anthropic") || s.contains("claude")) {
            return ReasoningCapability.Shape.ANTHROPIC_EFFORT;
        }
        if (s.contains("responses")) {
            return ReasoningCapability.Shape.RESPONSES_EFFORT;
        }
        if (s.contains("gemini") || s.contains("google")) {
            return ReasoningCapability.Shape.GEMINI_LEVEL;
        }
        return ReasoningCapability.Shape.OPENAI_EFFORT;
    }

    /** 仅凭接口类型给出能力（值域未知）。 */
    static ReasoningCapability fromStandard(String standard) {
        return ReasoningCapability.ofEffort(shapeOfStandard(standard), null);
    }

    // ------------------------------------------------------------------
    // 小工具
    // ------------------------------------------------------------------

    private static String lower(String v) {
        return v == null ? "" : v.trim().toLowerCase(Locale.ROOT);
    }

    private static String asString(Object v) {
        return v == null ? null : v.toString();
    }

    private static Integer asInt(Object v) {
        if (v instanceof Number) {
            return ((Number) v).intValue();
        }
        if (v instanceof CharSequence) {
            try {
                return Integer.parseInt(v.toString().trim());
            } catch (NumberFormatException ignore) {
                return null;
            }
        }
        return null;
    }

    private static Set<String> asStringSet(Object v) {
        if (!(v instanceof Collection)) {
            return null;
        }
        Set<String> out = new LinkedHashSet<>();
        for (Object o : (Collection<?>) v) {
            if (o != null) {
                String s = o.toString().trim().toLowerCase(Locale.ROOT);
                if (!s.isEmpty()) {
                    out.add(s);
                }
            }
        }
        return out;
    }

    /** 调试用：列出规则表覆盖的模型名片段（按匹配优先级）。 */
    static List<String> knownModelHints() {
        List<String> all = new ArrayList<>();
        for (Rule rule : RULES) {
            if (rule.match == Match.VERSION_RANGE) {
                all.add(rule.family);
            } else {
                all.addAll(rule.fragments);
            }
        }
        return all;
    }
}
