package com.gourdai.core.portal.web.thinking;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 单个模型的推理（思考）控制能力描述。
 *
 * <p>这是「统一 5 档」到「厂商原生参数」之间的翻译依据。它刻意与接口类型（standard）解耦：
 * 推理能力天然是 <b>按模型</b> 而非按接口的——同一个 anthropic 接口下，
 * {@code claude-sonnet-4-5} 只认 budget_tokens，而 {@code claude-sonnet-5} 只认 output_config.effort，
 * 按接口一刀切必然有一方 400。</p>
 *
 * <h3>三态语义（务必区分）</h3>
 * <ul>
 *   <li>{@code shape == NONE}：该模型<b>不支持</b>推理控制 → 前端应隐藏档位选择器。</li>
 *   <li>{@code efforts == null}：数据<b>没有说</b>它支持哪些 effort 值（未知），不等于不支持 →
 *       按形态默认值域处理，允许注入。</li>
 *   <li>{@code efforts.isEmpty()}：明确声明<b>可推理但不可调档</b> → 只能 AUTO。</li>
 * </ul>
 *
 * @author oisin
 */
public final class ReasoningCapability {

    /**
     * 请求参数形态——决定档位最终被拼成什么样的 wire 结构。
     */
    public enum Shape {
        /** 不支持推理控制：只能 AUTO（不注入）。 */
        NONE,
        /** OpenAI Chat Completions：顶层 {@code reasoning_effort}。 */
        OPENAI_EFFORT,
        /** OpenAI Responses：{@code reasoning.effort}。 */
        RESPONSES_EFFORT,
        /** 现代 Claude：{@code thinking:{type:"adaptive"}} + {@code output_config.effort}。 */
        ANTHROPIC_EFFORT,
        /** 经典 Claude：{@code thinking:{type:"enabled", budget_tokens:N}}。 */
        ANTHROPIC_BUDGET,
        /** Gemini 3.x：{@code generationConfig.thinkingConfig.thinkingLevel}（值大写）。 */
        GEMINI_LEVEL,
        /** Gemini 2.5：{@code generationConfig.thinkingConfig.thinkingBudget}（数值）。 */
        GEMINI_BUDGET,
        /** 仅开关：{@code thinking:{type:"enabled"}}，无法调档。 */
        TOGGLE;

        /** 是否为按 token 预算控制的形态。 */
        public boolean isBudget() {
            return this == ANTHROPIC_BUDGET || this == GEMINI_BUDGET;
        }

        /** 是否为按字符串档位控制的形态。 */
        public boolean isEffort() {
            return this == OPENAI_EFFORT || this == RESPONSES_EFFORT
                    || this == ANTHROPIC_EFFORT || this == GEMINI_LEVEL;
        }
    }

    /**
     * 厂商原生 effort 取值的强弱次序。
     *
     * <p>注意：{@code "none"} 不在表内且<b>刻意排除</b>——它表示「关闭思考」，
     * 若参与就近映射，用户选 LOW 可能被映射成 none 而意外关掉思考，
     * 与「本系统不提供关闭思考」的设计相悖。</p>
     */
    private static final Map<String, Integer> EFFORT_RANK;

    static {
        Map<String, Integer> m = new LinkedHashMap<>();
        m.put("minimal", 0);
        m.put("low", 1);
        m.put("medium", 2);
        m.put("high", 3);
        m.put("xhigh", 4);
        m.put("max", 5);
        EFFORT_RANK = Collections.unmodifiableMap(m);
    }

    /** effort 系形态在「数据未声明值域」时采用的保守默认值域。 */
    private static final Set<String> DEFAULT_EFFORTS =
            Collections.unmodifiableSet(new LinkedHashSet<>(Arrays.asList("low", "medium", "high")));

    /** 现代 Claude 的默认 effort 值域（官方 output_config.effort 五档）。 */
    private static final Set<String> ANTHROPIC_DEFAULT_EFFORTS =
            Collections.unmodifiableSet(new LinkedHashSet<>(Arrays.asList("low", "medium", "high", "xhigh", "max")));

    /** Gemini 3.x thinkingLevel 的默认值域。 */
    private static final Set<String> GEMINI_DEFAULT_LEVELS =
            Collections.unmodifiableSet(new LinkedHashSet<>(Arrays.asList("minimal", "low", "medium", "high")));

    /** 不支持推理控制的单例。 */
    public static final ReasoningCapability NONE = new ReasoningCapability(Shape.NONE, null, null, null);

    private final Shape shape;
    /** 该模型支持的原生 effort 值；null = 未知（按形态默认值域处理）。 */
    private final Set<String> efforts;
    /** 预算下限（budget 形态有效）；null = 无下限约束。 */
    private final Integer budgetMin;
    /** 预算上限（budget 形态有效）；null = 不约束，实际以模型最大输出长度推算。 */
    private final Integer budgetMax;

    private ReasoningCapability(Shape shape, Set<String> efforts, Integer budgetMin, Integer budgetMax) {
        this.shape = shape == null ? Shape.NONE : shape;
        this.efforts = efforts == null ? null
                : Collections.unmodifiableSet(new LinkedHashSet<>(efforts));
        this.budgetMin = budgetMin;
        this.budgetMax = budgetMax;
    }

    /** 构造 effort 形态能力；{@code efforts} 传 null 表示值域未知。 */
    public static ReasoningCapability ofEffort(Shape shape, Set<String> efforts) {
        return new ReasoningCapability(shape, efforts, null, null);
    }

    /** 构造 budget 形态能力。 */
    public static ReasoningCapability ofBudget(Shape shape, Integer budgetMin, Integer budgetMax) {
        return new ReasoningCapability(shape, null, budgetMin, budgetMax);
    }

    /** 构造仅开关形态能力。 */
    public static ReasoningCapability ofToggle() {
        return new ReasoningCapability(Shape.TOGGLE, null, null, null);
    }

    public Shape shape() {
        return shape;
    }

    public Integer budgetMin() {
        return budgetMin;
    }

    public Integer budgetMax() {
        return budgetMax;
    }

    /** 是否完全不支持推理控制。 */
    public boolean isNone() {
        return shape == Shape.NONE;
    }

    /**
     * 该模型可用的原生 effort 值域。
     *
     * <p>值域未知时按形态给保守默认；明确声明为空集时返回空集（可推理但不可调档）。</p>
     */
    public Set<String> effectiveEfforts() {
        if (efforts != null) {
            return efforts;
        }
        switch (shape) {
            case ANTHROPIC_EFFORT:
                return ANTHROPIC_DEFAULT_EFFORTS;
            case GEMINI_LEVEL:
                return GEMINI_DEFAULT_LEVELS;
            case OPENAI_EFFORT:
            case RESPONSES_EFFORT:
                return DEFAULT_EFFORTS;
            default:
                return Collections.emptySet();
        }
    }

    /**
     * 把统一档位就近映射为该模型真实支持的原生 effort 值。
     *
     * <p>映射规则：按 {@link #EFFORT_RANK} 次序取距离最近者；距离相同时取<b>较强</b>的一侧
     * （用户选高档的意图是「多想」，平局时不应向下取）。</p>
     *
     * @param level 统一档位（AUTO 返回 null）
     * @return 原生 effort 值；无可用值域时返回 null（调用方应按不注入处理）
     */
    public String resolveEffort(ThinkingLevel level) {
        if (level == null || level.isAuto()) {
            return null;
        }
        Set<String> pool = effectiveEfforts();
        if (pool.isEmpty()) {
            return null;
        }
        String best = null;
        int bestDist = Integer.MAX_VALUE;
        int bestRank = -1;
        for (String candidate : pool) {
            Integer r = EFFORT_RANK.get(candidate);
            if (r == null) {
                // 未知取值（含刻意排除的 "none"）不参与映射
                continue;
            }
            int dist = Math.abs(r - level.rank());
            if (dist < bestDist || (dist == bestDist && r > bestRank)) {
                best = candidate;
                bestDist = dist;
                bestRank = r;
            }
        }
        return best;
    }

    /**
     * 把统一档位换算成 token 预算。
     *
     * <p>基数取模型最大输出长度；再用厂商声明的 budget 上下限做 clamp。</p>
     *
     * @param level     统一档位（AUTO 返回 null）
     * @param maxOutput 模型最大输出长度；非正数时用兜底基数 32000（与历史实现一致）
     * @return token 预算；不适用时返回 null
     */
    public Integer resolveBudget(ThinkingLevel level, Integer maxOutput) {
        if (level == null || level.isAuto() || !shape.isBudget()) {
            return null;
        }
        int base = (maxOutput == null || maxOutput <= 0) ? 32000 : maxOutput;
        int budget = (int) Math.round(base * level.ratio());

        if (budgetMax != null && budget > budgetMax) {
            budget = budgetMax;
        }
        if (budgetMin != null && budget < budgetMin) {
            budget = budgetMin;
        }
        // 思考预算必须严格小于最大输出长度，否则厂商会拒绝请求
        if (budget >= base) {
            budget = base - 1;
        }
        // 上一步的 clamp 可能把预算压到厂商下限之下（base 过小时，如 Anthropic 要求 ≥1024
        // 而 base=1024 时只能给到 1023）。此时该模型的输出上限根本容不下合法的思考预算，
        // 发出去必 400 —— 只能不注入，退回厂商默认行为。
        if (budgetMin != null && budget < budgetMin) {
            return null;
        }
        return budget > 0 ? budget : null;
    }

    /**
     * 该模型<b>真正可区分</b>的档位列表——前端据此收缩选择器（策略 S2）。
     *
     * <p>动机：若模型只支持 {@code ["high"]}，渲染 5 个档位会让用户以为选了有效果，
     * 实际全部发同一个值。只渲染可区分档位，用户就永远选不到无效项。</p>
     *
     * @return 可选档位（不含 AUTO，AUTO 由前端固定置顶）；空列表表示应隐藏选择器
     */
    public List<ThinkingLevel> selectableLevels() {
        List<ThinkingLevel> result = new ArrayList<>();
        if (shape == Shape.NONE || shape == Shape.TOGGLE) {
            // NONE：不可控；TOGGLE：只有开/关两态，5 档会全部塌陷成「开」，无档可选
            return result;
        }
        if (shape.isBudget()) {
            // 连续预算：按默认基数逐档换算，只保留能产生不同数值的档位。
            // （厂商预算上限较低时，高档会被 clamp 到同一值，此时不应重复展示）
            Set<Integer> seenBudget = new LinkedHashSet<>();
            for (ThinkingLevel level : ThinkingLevel.ladder()) {
                Integer budget = resolveBudget(level, null);
                if (budget != null && seenBudget.add(budget)) {
                    result.add(level);
                }
            }
            return result;
        }
        // effort 系：逐档映射，只保留能产生「新」原生值的档位
        Set<String> seen = new LinkedHashSet<>();
        for (ThinkingLevel level : ThinkingLevel.ladder()) {
            String native0 = resolveEffort(level);
            if (native0 != null && seen.add(native0)) {
                result.add(level);
            }
        }
        return result;
    }

    @Override
    public String toString() {
        return "ReasoningCapability{shape=" + shape
                + ", efforts=" + efforts
                + ", budgetMin=" + budgetMin
                + ", budgetMax=" + budgetMax + '}';
    }
}
