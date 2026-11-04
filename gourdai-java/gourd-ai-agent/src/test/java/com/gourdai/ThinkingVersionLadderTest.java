package com.gourdai;

import com.gourdai.core.portal.web.thinking.ReasoningCapabilities;
import com.gourdai.core.portal.web.thinking.ReasoningCapability;
import com.gourdai.core.portal.web.thinking.ThinkingLevel;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 版本区间匹配回归测试 —— 锁定「未来模型自动继承家族最新能力」。
 *
 * <p>改造动机是一个真实的能力倒退缺陷：规则表原先用「子串 + 顺序」匹配，
 * 而模型名里的版本号是有序的，用无序手段表达有序演进必然出错——
 * {@code gpt-5.7} 会被宽泛规则 {@code "gpt-5"} 子串命中而只剩四档，
 * 但同族更早的 {@code gpt-5.6} 早已支持 max，<b>新版本反而比老版本档位少</b>。
 * 同类问题在 glm / kimi / qwen / doubao / grok 各族均已实测复现。</p>
 *
 * <p>现改为版本区间匹配：规则声明「家族 + 版本区间」，末档区间上界为无穷，
 * 未来版本自动落入末档而继承该家族最新的已知能力。</p>
 *
 * @author oisin
 */
public class ThinkingVersionLadderTest {

    private static Set<String> pool(String standard, String model) {
        return ReasoningCapabilities.resolve(standard, model).effectiveEfforts();
    }

    private static String top(String standard, String model) {
        return ReasoningCapabilities.resolve(standard, model).resolveEffort(ThinkingLevel.MAX);
    }

    private static List<String> codes(String standard, String model) {
        ReasoningCapability cap = ReasoningCapabilities.resolve(standard, model);
        List<String> out = new ArrayList<>();
        for (ThinkingLevel level : cap.selectableLevels()) {
            out.add(level.code());
        }
        return out;
    }

    private static Set<String> five() {
        return ReasoningCapabilities.resolve("openai", "gpt-5.6").effectiveEfforts();
    }

    // ==================================================================
    // 一、能力倒退缺陷：老规则吃掉同族新版本
    // ==================================================================

    @Test
    @DisplayName("gpt-5.7/5.8/5.9 不得被 gpt-5 规则吃掉，应继承 5.6 的完整五档")
    void futureMinorVersionMustNotFallBackToOlderRule() {
        for (String model : Arrays.asList("gpt-5.7", "gpt-5.8", "gpt-5.9")) {
            assertEquals(five(), pool("openai", model), model + " 应继承 gpt-5.6 的值域");
            assertEquals("max", top("openai", model), model + " 最高档必须能到 max");
        }
        // 而 gpt-5 自身仍是官方的四档（含 minimal），不受影响
        assertEquals(Arrays.asList("minimal", "low", "medium", "high"),
                new ArrayList<>(pool("openai", "gpt-5")));
    }

    @Test
    @DisplayName("未来主版本 gpt-6.1 / gpt-7 / gpt-8 自动取得完整五档")
    void futureMajorVersionInheritsLatestKnownPool() {
        for (String model : Arrays.asList("gpt-6.1", "gpt-6.5", "gpt-7", "gpt-8")) {
            assertEquals("max", top("openai", model), model + " 最高档必须能到 max");
            assertTrue(pool("openai", model).contains("xhigh"), model + " 应含 xhigh");
        }
    }

    @Test
    @DisplayName("版本区间边界：5.1 三档、5.2~5.5 四档、5.6 起五档")
    void versionRangeBoundaries() {
        assertFalse(pool("openai", "gpt-5.1").contains("xhigh"), "gpt-5.1 无 xhigh");
        for (String model : Arrays.asList("gpt-5.2", "gpt-5.3", "gpt-5.4", "gpt-5.5")) {
            assertTrue(pool("openai", model).contains("xhigh"), model + " 应有 xhigh");
            assertFalse(pool("openai", model).contains("max"), model + " 不应有 max");
        }
        assertTrue(pool("openai", "gpt-5.6").contains("max"));
    }

    @Test
    @DisplayName("glm / kimi / qwen / doubao / grok 的未来版本同样不被老规则吃掉")
    void futureVersionsOfOtherFamilies() {
        // glm：5.0/5.1 仅开关，5.2 起有 effort —— 未来的 5.4 应继承 5.3 而非退回开关
        assertEquals("max", top("openai", "glm-5.4"));
        assertEquals("max", top("openai", "glm-6"));
        // 但 4.x 与 5.0/5.1 必须仍判为开关（隐藏选择器）
        assertTrue(codes("openai", "glm-4.7").isEmpty(), "glm-4.7 官方仅开关");
        assertTrue(codes("openai", "glm-5.1").isEmpty(), "glm-5.1 官方仅开关");

        // kimi：k2.x 仅开关，k3 起有 effort
        assertTrue(codes("openai", "kimi-k2.6").isEmpty(), "kimi-k2.6 官方仅开关");
        assertEquals("max", top("openai", "kimi-k4"));

        // qwen：3.7 及更早为开关/预算型，3.8 起有 effort（官方跳过 high）
        assertTrue(codes("openai", "qwen3.7").isEmpty());
        assertEquals("xhigh", top("openai", "qwen3.9"));

        // doubao：1.6 四档，1.8 起六档 —— 未来的 seed-3 应继承六档
        assertFalse(pool("openai", "doubao-seed-1-6").contains("max"));
        assertEquals("max", top("openai", "doubao-seed-3"));

        // grok：4.6 起有 xhigh
        assertEquals("xhigh", top("openai", "grok-4.7"));
        assertEquals("xhigh", top("openai", "grok-5"));
    }

    // ==================================================================
    // 二、版本号解析的三个陷阱
    // ==================================================================

    @Test
    @DisplayName("版本必须按段比较：grok-4.20 比 grok-4.6 新（浮点比较会得出相反结论）")
    void versionComparedBySegmentNotFloat() {
        // 4.20 若按浮点是 4.2 < 4.6，会错落进旧区间而丢掉 xhigh
        assertTrue(pool("openai", "grok-4-20-multi-agent").contains("xhigh"),
                "grok-4.20 应落进 [4.6, ∞) 区间");
        assertFalse(pool("openai", "grok-4-5").contains("xhigh"), "grok-4.5 仍是三档");
    }

    @Test
    @DisplayName("参数量不是次版本：qwen3-8b 不得被当成 qwen3.8")
    void parameterCountIsNotMinorVersion() {
        // qwen3-8b 的 8b 是参数量（80 亿），官方为预算型；qwen3.8 才是有 effort 的版本
        assertTrue(codes("openai", "qwen3-8b").isEmpty(), "qwen3-8b 不应被当作 qwen3.8");
        assertTrue(codes("openai", "qwen3-235b-a22b").isEmpty());
        assertTrue(codes("openai", "qwen3-32b").isEmpty());
        // 对照：真正的 qwen3.8 有 effort
        assertEquals("xhigh", top("openai", "qwen3.8-max"));
    }

    @Test
    @DisplayName("日期后缀不是次版本：claude-sonnet-4@20250514 仍走 budget 形态")
    void dateSuffixIsNotMinorVersion() {
        assertEquals(ReasoningCapability.Shape.ANTHROPIC_BUDGET,
                ReasoningCapabilities.resolve("anthropic", "claude-sonnet-4@20250514").shape());
        assertEquals(ReasoningCapability.Shape.ANTHROPIC_BUDGET,
                ReasoningCapabilities.resolve("anthropic", "claude-sonnet-4-5-20250929").shape());
        // doubao 的日期后缀同理，不得把 251015 读成次版本
        assertFalse(pool("openai", "doubao-seed-1-6-251015").contains("max"));
    }

    // ==================================================================
    // 三、家族兜底
    // ==================================================================

    @Test
    @DisplayName("Claude 经 OpenAI 兼容口访问时也应拿到五档（形态由接口定，值域由模型定）")
    void claudeViaOpenAiCompatibleWireKeepsFullPool() {
        // 形态推断不出 ANTHROPIC_EFFORT，但值域不应因此缩水
        assertEquals(ReasoningCapability.Shape.OPENAI_EFFORT,
                ReasoningCapabilities.resolve("openai", "claude-opus-6").shape());
        assertEquals("max", top("openai", "claude-opus-6"));
        assertEquals("max", top("openai", "claude-opus-5"));
        // 经官方 anthropic 口自然也是五档
        assertEquals("max", top("anthropic", "claude-opus-6"));
    }

    @Test
    @DisplayName("规则表未登记的新 Claude 型号自动取得五档（列举老的、放行新的）")
    void unlistedModernClaudeAutoWorks() {
        for (String model : Arrays.asList("claude-opus-4-7", "claude-opus-4-8",
                "claude-mythos-5", "claude-fable-5-1")) {
            assertEquals("max", top("anthropic", model), model + " 应自动取得五档");
        }
    }

    @Test
    @DisplayName("Gemini 家族不得外推出 xhigh/max —— 官方全族止于 high")
    void geminiFamilyMustNotExtrapolateBeyondHigh() {
        for (String model : Arrays.asList("gemini-3-pro", "gemini-4-pro", "gemini-5-pro",
                "gemini-4-flash")) {
            assertEquals("high", top("gemini", model), model + " 最高只能到 high");
        }
        // Pro 系无 minimal，Flash 系有
        assertFalse(pool("gemini", "gemini-4-pro").contains("minimal"));
        assertTrue(pool("gemini", "gemini-4-flash").contains("minimal"));
    }

    // ==================================================================
    // 四、变体与特例
    // ==================================================================

    @Test
    @DisplayName("Pro / Chat 变体跨版本降级：未来的 gpt-7-pro 不得多报 low 与 max")
    void proAndChatVariantsDegradeAcrossVersions() {
        Set<String> pro = pool("openai", "gpt-7-pro");
        assertFalse(pro.contains("low"), "Pro 系官方无低档");
        assertFalse(pro.contains("max"), "Pro 系官方无 max");
        assertEquals("xhigh", top("openai", "gpt-7-pro"));
        // 已知的 5.x-pro 同样成立
        assertEquals("xhigh", top("openai", "gpt-5.4-pro"));
        // gpt-5-pro 是更严的特例：官方只有 high
        assertEquals("high", top("openai", "gpt-5-pro"));
        // Chat 系极弱
        assertEquals("medium", top("openai", "gpt-7-chat"));
    }

    @Test
    @DisplayName("无版本号的 OpenAI 端点不得被家族兜底放大（gpt-chat-latest / gpt-realtime）")
    void versionlessOpenAiEndpointsMustNotBeInflated() {
        assertFalse(pool("openai", "gpt-chat-latest").contains("max"),
                "gpt-chat-latest 官方仅三档");
        assertFalse(pool("openai", "gpt-realtime-2.1").contains("max"),
                "gpt-realtime 官方止于 xhigh");
    }

    @Test
    @DisplayName("非推理的 gpt-4 系不得落进 gpt 家族区间（区间下界为 5.0）")
    void legacyGpt4MustNotEnterReasoningRange() {
        // gpt-4o 不是推理模型，不应拿到 minimal/xhigh/max 这类推理档位
        Set<String> p = pool("openai", "gpt-4o");
        assertFalse(p.contains("minimal"));
        assertFalse(p.contains("xhigh"));
        assertFalse(p.contains("max"));
    }

    @Test
    @DisplayName("点号与连字符方言等价：gpt-5-7 与 gpt-5.7 必须同解")
    void dialectsAreEquivalentUnderVersionMatching() {
        assertEquals(pool("openai", "gpt-5.7"), pool("openai", "gpt-5-7"));
        assertEquals(pool("openai", "glm-5.4"), pool("openai", "glm-5-4"));
        assertEquals(pool("openai", "grok-4.7"), pool("openai", "grok-4-7"));
    }

    @Test
    @DisplayName("完全未知的厂商仍安全降级，且 MAX 档必有可用映射")
    void unknownVendorStillDegradesSafely() {
        for (String model : Arrays.asList("some-unknown-model-v9", "acme-reasoner-1")) {
            Set<String> p = pool("openai", model);
            assertFalse(p.isEmpty(), model + " 不应产生空档位");
            assertEquals("high", top("openai", model), model + " 应落保守兜底");
        }
    }
}
