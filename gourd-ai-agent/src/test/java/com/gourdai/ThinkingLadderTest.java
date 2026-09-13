package com.gourdai;

import com.gourdai.core.portal.web.ThinkingDepth;
import com.gourdai.core.portal.web.thinking.ReasoningCapabilities;
import com.gourdai.core.portal.web.thinking.ReasoningCapability;
import com.gourdai.core.portal.web.thinking.ThinkingLevel;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 思考档位统一 5 档 + 能力表驱动适配的契约测试。
 *
 * <p>改造前 ThinkingDepth 零测试覆盖，而它决定每一次模型请求的思考参数形状——
 * 一旦形状错误即 400 或静默失效。本测试固化四条契约：
 * 档位迁移、能力判定、预算换算零回归、S2 档位收缩。</p>
 *
 * @author oisin
 */
public class ThinkingLadderTest {

    // ==================================================================
    // 一、档位枚举与历史值迁移
    // ==================================================================

    @Test
    @DisplayName("历史档位 off 必须迁移为 AUTO（语义等价：不注入、跟随厂商默认）")
    public void legacy_off_migrates_to_auto() {
        assertEquals(ThinkingLevel.AUTO, ThinkingLevel.from("off"));
        assertEquals("auto", ThinkingDepth.normalize("off"));
        assertEquals("auto", ThinkingDepth.AUTO);
    }

    @Test
    @DisplayName("历史档位 minimal 必须就近迁移为 LOW（统一 5 档不含 minimal）")
    public void legacy_minimal_migrates_to_low() {
        assertEquals(ThinkingLevel.LOW, ThinkingLevel.from("minimal"));
        assertEquals("low", ThinkingDepth.normalize("MINIMAL"));
    }

    @Test
    @DisplayName("空值 / 不识别值一律回落 AUTO，绝不误注入")
    public void unknown_falls_back_to_auto() {
        assertEquals(ThinkingLevel.AUTO, ThinkingLevel.from(null));
        assertEquals(ThinkingLevel.AUTO, ThinkingLevel.from(""));
        assertEquals(ThinkingLevel.AUTO, ThinkingLevel.from("   "));
        assertEquals(ThinkingLevel.AUTO, ThinkingLevel.from("wat"));
    }

    @Test
    @DisplayName("统一档位恰为 5 档 LOW/MEDIUM/HIGH/XHIGH/MAX，不含 minimal、不含关闭档")
    public void ladder_is_exactly_five_levels() {
        ThinkingLevel[] ladder = ThinkingLevel.ladder();
        assertEquals(5, ladder.length);
        assertArrayEqualsCodes(new String[]{"low", "medium", "high", "xhigh", "max"}, ladder);
        // 枚举总量 = AUTO + 5 档；不存在任何「关闭思考」档位
        assertEquals(6, ThinkingLevel.values().length);
        for (ThinkingLevel level : ThinkingLevel.values()) {
            assertFalse("none".equals(level.code()), "不应存在关闭思考档位: " + level);
            assertFalse("off".equals(level.code()), "off 应已更名为 auto: " + level);
        }
    }

    // ==================================================================
    // 二、能力解析三级回退
    // ==================================================================

    @Test
    @DisplayName("接口兜底必须与改造前旧逻辑一致（零回归）")
    public void standard_fallback_matches_legacy_behavior() {
        assertEquals(ReasoningCapability.Shape.ANTHROPIC_EFFORT,
                ReasoningCapabilities.resolve("anthropic", null).shape());
        assertEquals(ReasoningCapability.Shape.RESPONSES_EFFORT,
                ReasoningCapabilities.resolve("openai-responses", null).shape());
        assertEquals(ReasoningCapability.Shape.GEMINI_LEVEL,
                ReasoningCapabilities.resolve("gemini", null).shape());
        assertEquals(ReasoningCapability.Shape.OPENAI_EFFORT,
                ReasoningCapabilities.resolve("openai", null).shape());
        assertEquals(ReasoningCapability.Shape.OPENAI_EFFORT,
                ReasoningCapabilities.resolve("ollama", null).shape());
        assertEquals(ReasoningCapability.Shape.OPENAI_EFFORT,
                ReasoningCapabilities.resolve(null, null).shape());
    }

    @Test
    @DisplayName("缺陷1：经典 Claude 必须走 budget_tokens，不能发 output_config.effort（原实现必 400）")
    public void classic_claude_uses_budget_not_effort() {
        for (String model : Arrays.asList(
                "claude-sonnet-4-5-20250929", "claude-opus-4-1-20250805",
                "claude-3-7-sonnet-latest", "claude-haiku-4-5")) {
            assertEquals(ReasoningCapability.Shape.ANTHROPIC_BUDGET,
                    ReasoningCapabilities.resolve("anthropic", model).shape(),
                    "经典 Claude 应使用 budget_tokens: " + model);
        }
    }

    @Test
    @DisplayName("现代 Claude（含未来新版）放行到 effort 格式——规则表只列举已封闭的老模型集合")
    public void modern_claude_uses_effort() {
        for (String model : Arrays.asList(
                "claude-sonnet-5", "claude-opus-4-6", "claude-fable-5", "claude-future-9")) {
            assertEquals(ReasoningCapability.Shape.ANTHROPIC_EFFORT,
                    ReasoningCapabilities.resolve("anthropic", model).shape(),
                    "现代/未来 Claude 应使用 effort: " + model);
        }
    }

    @Test
    @DisplayName("缺陷2：Gemini 2.5 用数值预算，发 thinkingLevel 会静默失效")
    public void gemini_25_uses_budget() {
        assertEquals(ReasoningCapability.Shape.GEMINI_BUDGET,
                ReasoningCapabilities.resolve("gemini", "gemini-2.5-flash-lite").shape());
        assertEquals(ReasoningCapability.Shape.GEMINI_BUDGET,
                ReasoningCapabilities.resolve("gemini", "gemini-2.5-pro").shape());
        // Gemini 3.x 仍走 thinkingLevel
        assertEquals(ReasoningCapability.Shape.GEMINI_LEVEL,
                ReasoningCapabilities.resolve("gemini", "gemini-3-pro-preview").shape());
    }

    @Test
    @DisplayName("缺陷3：仅开关型模型归为 TOGGLE，不再向其发无效的 reasoning_effort")
    public void toggle_only_models_detected() {
        assertEquals(ReasoningCapability.Shape.TOGGLE,
                ReasoningCapabilities.resolve("openai", "glm-4.6").shape());
        assertEquals(ReasoningCapability.Shape.TOGGLE,
                ReasoningCapabilities.resolve("openai", "kimi-k2-0905-preview").shape());
    }

    @Test
    @DisplayName("缺陷4：不可控推理模型归为 NONE，前端应隐藏档位选择器")
    public void uncontrollable_models_detected() {
        assertTrue(ReasoningCapabilities.resolve("openai", "MiniMax-M2").isNone());
        assertTrue(ReasoningCapabilities.resolve("openai", "o1-mini").isNone());
        assertTrue(ReasoningCapabilities.resolve("openai", "minimax-m2").selectableLevels().isEmpty());
    }

    @Test
    @DisplayName("用户覆写优先级最高，可推翻内置规则与接口兜底")
    public void user_override_wins() {
        Map<String, Object> caps = new HashMap<>();
        caps.put("reasoning", "openai_effort");
        // 若无覆写该模型会被判为 ANTHROPIC_BUDGET
        assertEquals(ReasoningCapability.Shape.OPENAI_EFFORT,
                ReasoningCapabilities.resolve("anthropic", "claude-sonnet-4-5", caps).shape());

        Map<String, Object> disabled = new HashMap<>();
        disabled.put("reasoning", Boolean.FALSE);
        assertTrue(ReasoningCapabilities.resolve("openai", "gpt-5", disabled).isNone());

        Map<String, Object> detailed = new HashMap<>();
        Map<String, Object> spec = new HashMap<>();
        spec.put("shape", "openai_effort");
        spec.put("efforts", Arrays.asList("low", "high"));
        detailed.put("reasoning", spec);
        ReasoningCapability cap = ReasoningCapabilities.resolve("openai", "whatever", detailed);
        assertEquals(new LinkedHashSet<>(Arrays.asList("low", "high")), cap.effectiveEfforts());
    }

    // ==================================================================
    // 三、档位 → 原生值就近映射
    // ==================================================================

    @Test
    @DisplayName("值域完整时 5 档逐一精确命中")
    public void exact_match_when_full_range() {
        ReasoningCapability cap = ReasoningCapability.ofEffort(
                ReasoningCapability.Shape.ANTHROPIC_EFFORT,
                new LinkedHashSet<>(Arrays.asList("low", "medium", "high", "xhigh", "max")));
        assertEquals("low", cap.resolveEffort(ThinkingLevel.LOW));
        assertEquals("medium", cap.resolveEffort(ThinkingLevel.MEDIUM));
        assertEquals("high", cap.resolveEffort(ThinkingLevel.HIGH));
        assertEquals("xhigh", cap.resolveEffort(ThinkingLevel.XHIGH));
        assertEquals("max", cap.resolveEffort(ThinkingLevel.MAX));
    }

    @Test
    @DisplayName("值域残缺时就近降级，绝不发出模型不认识的值")
    public void nearest_match_when_partial_range() {
        // gpt-5-pro 实测只支持 high：任何档位都只能发 high
        ReasoningCapability onlyHigh = ReasoningCapability.ofEffort(
                ReasoningCapability.Shape.OPENAI_EFFORT,
                new LinkedHashSet<>(Arrays.asList("high")));
        for (ThinkingLevel level : ThinkingLevel.ladder()) {
            assertEquals("high", onlyHigh.resolveEffort(level));
        }
        // 只有 high/max 时，LOW/MEDIUM 就近取 high，XHIGH/MAX 取 max
        ReasoningCapability highMax = ReasoningCapability.ofEffort(
                ReasoningCapability.Shape.ANTHROPIC_EFFORT,
                new LinkedHashSet<>(Arrays.asList("high", "max")));
        assertEquals("high", highMax.resolveEffort(ThinkingLevel.LOW));
        assertEquals("high", highMax.resolveEffort(ThinkingLevel.HIGH));
        assertEquals("max", highMax.resolveEffort(ThinkingLevel.MAX));
    }

    @Test
    @DisplayName("原生 none 必须排除出映射——否则选 LOW 会被意外映射成「关闭思考」")
    public void native_none_is_never_selected() {
        ReasoningCapability cap = ReasoningCapability.ofEffort(
                ReasoningCapability.Shape.OPENAI_EFFORT,
                new LinkedHashSet<>(Arrays.asList("none", "high")));
        for (ThinkingLevel level : ThinkingLevel.ladder()) {
            assertEquals("high", cap.resolveEffort(level),
                    "任何档位都不得映射到 none: " + level);
        }
    }

    @Test
    @DisplayName("AUTO 永不产生原生值（即不注入任何参数）")
    public void auto_never_resolves() {
        ReasoningCapability cap = ReasoningCapabilities.resolve("openai", "gpt-5");
        assertNull(cap.resolveEffort(ThinkingLevel.AUTO));
        assertNull(cap.resolveBudget(ThinkingLevel.AUTO, 32000));
    }

    // ==================================================================
    // 四、预算换算（零回归铁证）
    // ==================================================================

    @Test
    @DisplayName("预算换算必须逐值等于旧实现的硬编码值（基数 32000：4000/12000/24000）")
    public void budget_matches_legacy_hardcoded_values() {
        ReasoningCapability cap = ReasoningCapability.ofBudget(
                ReasoningCapability.Shape.ANTHROPIC_BUDGET, 1024, null);
        assertEquals(Integer.valueOf(4000), cap.resolveBudget(ThinkingLevel.LOW, 32000));
        assertEquals(Integer.valueOf(12000), cap.resolveBudget(ThinkingLevel.MEDIUM, 32000));
        assertEquals(Integer.valueOf(24000), cap.resolveBudget(ThinkingLevel.HIGH, 32000));
        // 基数缺失时兜底同样是 32000，结果不变
        assertEquals(Integer.valueOf(4000), cap.resolveBudget(ThinkingLevel.LOW, null));
        assertEquals(Integer.valueOf(24000), cap.resolveBudget(ThinkingLevel.HIGH, 0));
    }

    @Test
    @DisplayName("预算必须严格小于最大输出长度，并受厂商上下限 clamp")
    public void budget_is_clamped() {
        ReasoningCapability gemini = ReasoningCapability.ofBudget(
                ReasoningCapability.Shape.GEMINI_BUDGET, 512, 24576);
        assertEquals(Integer.valueOf(24576), gemini.resolveBudget(ThinkingLevel.MAX, 32000));

        // 小上下文模型：预算不得 >= 基数，否则厂商拒绝请求
        ReasoningCapability anthropic = ReasoningCapability.ofBudget(
                ReasoningCapability.Shape.ANTHROPIC_BUDGET, 1024, null);
        Integer budget = anthropic.resolveBudget(ThinkingLevel.MAX, 4000);
        assertNotNull(budget);
        assertTrue(budget < 4000, "预算必须严格小于最大输出长度，实际=" + budget);
        assertTrue(budget >= 1024, "预算不得低于厂商下限，实际=" + budget);

        // 基数小到“装不下合法预算”时，只能不注入——
        // 旧实现会返回 999（同时违反官方下限 1024），发出去必 400。
        // base=1000 时“≥1024”与“<1000”不可能同时成立，唯一正确的结果是 null。
        assertNull(anthropic.resolveBudget(ThinkingLevel.MAX, 1000),
                "基数容不下厂商最小预算时应不注入");
    }

    // ==================================================================
    // 五、S2 降级：UI 档位收缩
    // ==================================================================

    @Test
    @DisplayName("只支持单一 effort 值的模型只呈现 1 档，用户不会选到无效档位")
    public void selectable_collapses_for_single_value_models() {
        ReasoningCapability onlyHigh = ReasoningCapability.ofEffort(
                ReasoningCapability.Shape.OPENAI_EFFORT,
                new LinkedHashSet<>(Arrays.asList("high")));
        assertEquals(1, onlyHigh.selectableLevels().size());
    }

    @Test
    @DisplayName("TOGGLE / NONE 模型无可调档位，前端应隐藏选择器")
    public void selectable_empty_for_toggle_and_none() {
        assertTrue(ReasoningCapability.ofToggle().selectableLevels().isEmpty());
        assertTrue(ReasoningCapability.NONE.selectableLevels().isEmpty());
    }

    @Test
    @DisplayName("现代 Claude 完整承接 5 档；Gemini 2.5 受预算上限 clamp 后自动收缩")
    public void selectable_reflects_real_capability() {
        List<ThinkingLevel> claude = ReasoningCapabilities
                .resolve("anthropic", "claude-sonnet-5").selectableLevels();
        assertEquals(5, claude.size());

        // budgetMax=24576：XHIGH(28000) 与 MAX(30400) 都被 clamp 成 24576，应去重
        List<ThinkingLevel> gemini = ReasoningCapabilities
                .resolve("gemini", "gemini-2.5-flash").selectableLevels();
        assertEquals(4, gemini.size(), "被 clamp 到同一预算的档位不应重复呈现");
    }

    @Test
    @DisplayName("ThinkingDepth.selectableCodes 下发给前端的编码可直接消费")
    public void selectable_codes_for_frontend() {
        List<String> codes = ThinkingDepth.selectableCodes("anthropic", "claude-sonnet-5", null);
        assertEquals(Arrays.asList("low", "medium", "high", "xhigh", "max"), codes);

        assertTrue(ThinkingDepth.selectableCodes("openai", "MiniMax-M2", null).isEmpty());
        assertTrue(ThinkingDepth.selectableCodes("openai", "glm-4.6", null).isEmpty());
    }

    // ------------------------------------------------------------------

    private static void assertArrayEqualsCodes(String[] expected, ThinkingLevel[] actual) {
        assertEquals(expected.length, actual.length);
        for (int i = 0; i < expected.length; i++) {
            assertEquals(expected[i], actual[i].code());
        }
    }
}
