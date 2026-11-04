package com.gourdai;

import com.gourdai.core.portal.web.ThinkingDepth;
import com.gourdai.core.portal.web.thinking.ModelProfiles;
import com.gourdai.core.portal.web.thinking.ReasoningCapabilities;
import com.gourdai.core.portal.web.thinking.ReasoningCapability;
import com.gourdai.core.portal.web.thinking.ThinkingLevel;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 国产模型思考档位——对齐厂商<b>官方文档</b>的回归测试。
 *
 * <p>本类的断言依据一律是厂商官方文档原文，而非第三方聚合数据。
 * 起因是一次真实误判：第三方数据把 {@code deepseek-v4-pro} 标为 {@code [high,max]}，
 * 规则表照抄后丢了 {@code low} 档；而 DeepSeek 官方文档明确
 * 「映射表对 deepseek-v4-flash 与 deepseek-v4-pro 完全相同」，即同为 {@code [low,high,max]}。
 * 故此后国产模型的值域改以官方文档为准。</p>
 *
 * <p>官方出处：</p>
 * <ul>
 *   <li>DeepSeek：api-docs.deepseek.com/zh-cn/api/create-chat-completion —— {@code reasoning_effort}
 *       可选值 {@code [low, high, max]}，默认 high，{@code medium}/{@code xhigh} 映射为 high。</li>
 *   <li>智谱：docs.bigmodel.cn/cn/guide/capabilities/thinking —— {@code reasoning_effort} 仅
 *       GLM-5.2 及以上支持；GLM-5.3 <b>仅接受 max/high/low，其余输入将报错</b>；
 *       GLM-5.2 接受 7 值但 low/medium→high、xhigh→max，故<b>有效档位</b>只有 high 与 max。</li>
 *   <li>月之暗面：platform.kimi.com/docs/guide/use-reasoning-effort —— K3 顶层
 *       {@code reasoning_effort} 支持 {@code low/high/max}（默认 max）且始终思考；
 *       k2.7-code / k2.6 / k2.5 均<b>不支持</b>该字段。</li>
 *   <li>阿里云百炼：help.aliyun.com/zh/model-studio/deep-thinking —— Qwen3.8 系
 *       {@code reasoning_effort} 为 xhigh / medium / low <b>三档</b>（跳过 high）；
 *       Qwen3.7 及更早用 {@code enable_thinking} 开关 + {@code thinking_budget}。</li>
 * </ul>
 *
 * @author oisin
 */
public class ThinkingDomesticLadderTest {

    @AfterEach
    public void tearDown() {
        ModelProfiles.reset();
    }

    /** 取该模型的官方值域（已按强度排序），便于与文档原文逐字比对。 */
    private static List<String> pool(String modelName) {
        ReasoningCapability cap = ReasoningCapabilities.resolve("openai", modelName);
        List<String> out = new ArrayList<>();
        for (String s : Arrays.asList("minimal", "low", "medium", "high", "xhigh", "max")) {
            if (cap.effectiveEfforts().contains(s)) {
                out.add(s);
            }
        }
        return out;
    }

    private static String effort(String modelName, ThinkingLevel level) {
        return ReasoningCapabilities.resolve("openai", modelName).resolveEffort(level);
    }

    private static boolean isToggle(String modelName) {
        return ReasoningCapabilities.resolve("openai", modelName).shape() == ReasoningCapability.Shape.TOGGLE;
    }

    // ==================================================================
    // DeepSeek
    // ==================================================================

    @Test
    @DisplayName("DeepSeek：v4-pro 与 v4-flash 官方档位完全相同，pro 不得少 low（本轮修复的误判）")
    public void deepseek_pro_and_flash_share_the_same_ladder() {
        List<String> expect = Arrays.asList("low", "high", "max");
        for (String m : Arrays.asList("deepseek-v4-pro", "deepseek-v4-flash",
                "deepseek-v4-flash-vision-exp", "deepseek-flash",
                "deepseek-v4-pro-0813", "deepseek-v4-flash-0731")) {
            assertEquals(expect, pool(m), "DeepSeek 官方三档 low/high/max: " + m);
        }
        // 曾经的缺陷形态：pro 被单列成 [high,max]，最低档拿不到 low
        assertEquals("low", effort("deepseek-v4-pro", ThinkingLevel.LOW));
        assertEquals("max", effort("deepseek-v4-pro", ThinkingLevel.MAX));
    }

    @Test
    @DisplayName("DeepSeek：v3.x 及更早只有 thinking 开关，不得注入 effort")
    public void deepseek_v3_is_toggle_only() {
        for (String m : Arrays.asList("deepseek-v3.1", "deepseek-v3.2", "deepseek-v3.2-exp")) {
            assertTrue(isToggle(m), "v3.x 官方无 effort: " + m);
            assertTrue(ThinkingDepth.selectableCodes("openai", m, null).isEmpty(),
                    "TOGGLE 型必须隐藏档位选择器: " + m);
        }
    }

    // ==================================================================
    // GLM（智谱）
    // ==================================================================

    @Test
    @DisplayName("GLM-5.3 官方仅接受 max/high/low，其余输入报错 —— 值域必须精确，不可多报")
    public void glm_53_pool_must_be_exact() {
        for (String m : Arrays.asList("glm-5.3", "glm-5.3-flash")) {
            assertEquals(Arrays.asList("low", "high", "max"), pool(m), m);
            // 官方文档原文：「其余输入将报错」——多报 minimal/medium/xhigh 会直接 400
            assertFalse(pool(m).contains("medium"), "medium 会报错: " + m);
            assertFalse(pool(m).contains("xhigh"), "xhigh 会报错: " + m);
        }
    }

    @Test
    @DisplayName("GLM-5.2 有效档位只有 high/max（官方接受 7 值但 low/medium→high、xhigh→max）")
    public void glm_52_effective_ladder_is_two_steps() {
        assertEquals(Arrays.asList("high", "max"), pool("glm-5.2"));
        // 登记 7 值会造出 5 个「选了没效果」的假档位，故刻意只登记有效档位
        assertEquals(2, pool("glm-5.2").size());
    }

    @Test
    @DisplayName("GLM：4.5~5.1 官方无 reasoning_effort，只有 thinking 开关")
    public void glm_before_52_is_toggle_only() {
        for (String m : Arrays.asList("glm-4.5", "glm-4.6", "glm-4.7", "glm-4.7-flash",
                "glm-5", "glm-5.1", "glm-5v-turbo")) {
            assertTrue(isToggle(m), "官方 reasoning_effort 仅 5.2 及以上支持: " + m);
        }
    }

    // ==================================================================
    // Kimi（月之暗面）
    // ==================================================================

    @Test
    @DisplayName("Kimi K3 官方三档 low/high/max；K2.x 一律不支持 reasoning_effort")
    public void kimi_k3_has_effort_but_k2_does_not() {
        assertEquals(Arrays.asList("low", "high", "max"), pool("kimi-k3"));
        assertEquals("max", effort("kimi-k3", ThinkingLevel.MAX));

        assertTrue(isToggle("kimi-k2.6"), "k2.6 官方只有 thinking 开关");
        assertTrue(isToggle("kimi-k2.5"), "k2.5 官方只有 thinking 开关");
        // k2.7-code 始终思考且不可调，属「可推理但不可控」
        assertTrue(ThinkingDepth.selectableCodes("openai", "kimi-k2.7-code", null).isEmpty());
        assertTrue(ThinkingDepth.selectableCodes("openai", "kimi-k2.7-code-highspeed", null).isEmpty());
    }

    // ==================================================================
    // Qwen（阿里云百炼）
    // ==================================================================

    @Test
    @DisplayName("Qwen3.8 官方三档 low/medium/xhigh —— 刻意跳过 high，不可自作主张补全")
    public void qwen_38_skips_high() {
        for (String m : Arrays.asList("qwen3.8-max", "qwen3.8-flash", "qwen3.8-max-0902")) {
            assertEquals(Arrays.asList("low", "medium", "xhigh"), pool(m), m);
            assertFalse(pool(m).contains("high"), "官方值域不含 high: " + m);
            // 顶档必须落到 xhigh，而不是降级成 high
            assertEquals("xhigh", effort(m, ThinkingLevel.MAX), m);
            assertEquals("xhigh", effort(m, ThinkingLevel.XHIGH), m);
        }
    }

    @Test
    @DisplayName("Qwen：3.7 及更早无 effort；参数量后缀 8b 不得被误读成版本号 3.8")
    public void qwen_before_38_has_no_effort() {
        for (String m : Arrays.asList("qwen3-32b", "qwen3.5-plus", "qwen3.6-flash",
                "qwen3.7-max", "qwen3.7-plus", "qwen-plus", "qwen-turbo")) {
            assertTrue(isToggle(m), "3.7 及更早官方无 reasoning_effort: " + m);
        }
        // 经典陷阱：qwen3-8b 的 "8b" 是参数量，若被当成次版本会错给 effort 档位
        assertTrue(isToggle("qwen3-8b"), "qwen3-8b 是 80 亿参数版，不是 qwen3.8");
        assertTrue(isToggle("qwen3-235b-a22b"));
    }

    // ==================================================================
    // MiniMax / 豆包
    // ==================================================================

    @Test
    @DisplayName("MiniMax：M2 系可推理但不可控，M3 只有开关 —— 均不得出现档位选择器")
    public void minimax_has_no_selectable_levels() {
        for (String m : Arrays.asList("MiniMax-M2", "MiniMax-M2.1", "MiniMax-M2.5",
                "MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M3")) {
            assertTrue(ThinkingDepth.selectableCodes("openai", m, null).isEmpty(),
                    "官方未公布可调档位: " + m);
        }
    }

    @Test
    @DisplayName("豆包：seed-1.6 四档、1.8 起六档、character 跳过 medium")
    public void doubao_ladders() {
        assertEquals(Arrays.asList("minimal", "low", "medium", "high"),
                pool("doubao-seed-1-6-251015"));
        assertEquals(Arrays.asList("minimal", "low", "medium", "high", "xhigh", "max"),
                pool("doubao-seed-1-8-251228"));
        assertEquals(Arrays.asList("minimal", "low", "medium", "high", "xhigh", "max"),
                pool("doubao-seed-2-1-pro-260628"));
        // 官方值域跳过 medium，多报会 400
        assertEquals(Arrays.asList("minimal", "low", "high"), pool("doubao-seed-character-260628"));
    }

    // ==================================================================
    // 跨厂商共性：未来版本必须继承家族最新能力
    // ==================================================================

    @Test
    @DisplayName("未来型号继承：glm-6 / kimi-k4 / deepseek-v5 / qwen4 不得退化回兜底三档")
    public void future_domestic_models_inherit_latest_ladder() {
        assertEquals(Arrays.asList("low", "high", "max"), pool("glm-6"));
        assertEquals(Arrays.asList("low", "high", "max"), pool("kimi-k4"));
        assertEquals(Arrays.asList("low", "high", "max"), pool("deepseek-v5-pro"));
        assertEquals(Arrays.asList("low", "medium", "xhigh"), pool("qwen4-max"));
    }
}
