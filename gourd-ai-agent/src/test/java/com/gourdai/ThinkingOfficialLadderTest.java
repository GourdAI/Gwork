package com.gourdai;

import com.gourdai.core.portal.web.ThinkingDepth;
import com.gourdai.core.portal.web.thinking.ModelProfiles;
import com.gourdai.core.portal.web.thinking.ReasoningCapabilities;
import com.gourdai.core.portal.web.thinking.ReasoningCapability;
import com.gourdai.core.portal.web.thinking.ThinkingLevel;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.noear.solon.ai.chat.ChatModel;

import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 官方思考档位对齐 + 用户覆写通路（死代码修复）回归测试。
 *
 * <p>本类锁定两件事：</p>
 * <ol>
 *   <li><b>官方值域对齐</b>——各厂商公布的 effort 值域是<b>按模型</b>而非按接口的，
 *       规则表必须逐族对齐，且「具体规则先于宽泛规则」的顺序不可被破坏。</li>
 *   <li><b>覆写真的到达请求路径</b>——历史实现用 {@code instanceof ModelDo} 探测
 *       {@code ChatConfigReadonly}，运行时恒 false，是死代码：UI 显示覆写生效、
 *       实际请求仍发兜底值。现改由 {@link ModelProfiles} 供给，本类做端到端锁定。</li>
 * </ol>
 *
 * @author oisin
 */
public class ThinkingOfficialLadderTest {

    @AfterEach
    public void tearDown() {
        // 静态注册表跨用例可见，必须复位，否则污染其它测试
        ModelProfiles.reset();
    }

    private static ChatModel modelOf(String standard, String modelName) {
        return ChatModel.of("http://127.0.0.1:9/v1")
                .apiKey("test-key")
                .standard(standard)
                .model(modelName)
                .build();
    }

    private static List<String> codes(String standard, String modelName) {
        return ThinkingDepth.selectableCodes(standard, modelName, null);
    }

    private static String effort(String standard, String modelName, ThinkingLevel level) {
        return ReasoningCapabilities.resolve(standard, modelName).resolveEffort(level);
    }

    // ==================================================================
    // 一、OpenAI 系官方值域
    // ==================================================================

    @Test
    @DisplayName("gpt-5.6 系与 gpt-6 系必须拿到 xhigh / max（本轮修复的能力低估）")
    public void openai_56_series_reaches_xhigh_and_max() {
        for (String m : Arrays.asList("gpt-5.6", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-6-astra")) {
            assertEquals(Arrays.asList("low", "medium", "high", "xhigh", "max"), codes("openai", m),
                    "5.6/6 系官方值域含 xhigh/max: " + m);
            assertEquals("xhigh", effort("openai", m, ThinkingLevel.XHIGH), m);
            assertEquals("max", effort("openai", m, ThinkingLevel.MAX), m);
        }
    }

    @Test
    @DisplayName("顺序陷阱：gpt-5.6 不得被宽泛的 gpt-5 规则吃掉（子串匹配必错的经典场景）")
    public void openai_specific_rule_precedes_generic() {
        // gpt-5 官方有 minimal 无 xhigh/max；gpt-5.6 恰好相反。
        // 若 "gpt-5" 规则排在前面，gpt-5.6 会被误判成 gpt-5 的值域。
        assertNotEquals(codes("openai", "gpt-5"), codes("openai", "gpt-5.6"));
        assertTrue(codes("openai", "gpt-5.6").contains("max"));
        assertFalse(codes("openai", "gpt-5").contains("max"));
    }

    @Test
    @DisplayName("gpt-5.4 / 5.3 / 5.5 官方到 xhigh 为止，MAX 档必须就近降到 xhigh 而非发出 max")
    public void openai_54_series_stops_at_xhigh() {
        for (String m : Arrays.asList("gpt-5.4", "gpt-5.3-codex", "gpt-5.5")) {
            assertEquals(Arrays.asList("low", "medium", "high", "xhigh"), codes("openai", m), m);
            assertEquals("xhigh", effort("openai", m, ThinkingLevel.MAX), "MAX 须降级为 xhigh: " + m);
        }
    }

    @Test
    @DisplayName("单值 / 窄值域模型：gpt-5-pro 只有 high，gpt-5.2-chat 只有 medium，Pro 系无低档")
    public void openai_narrow_pools() {
        assertEquals(Arrays.asList("low"), codes("openai", "gpt-5-pro"),
                "只有一个原生值时仅呈现 1 档（编码为最低档，实际发 high）");
        assertEquals("high", effort("openai", "gpt-5-pro", ThinkingLevel.LOW));
        assertEquals("high", effort("openai", "gpt-5-pro", ThinkingLevel.MAX));

        assertEquals("medium", effort("openai", "gpt-5.2-chat-latest", ThinkingLevel.LOW));
        assertEquals("medium", effort("openai", "gpt-5.2-chat-latest", ThinkingLevel.MAX));

        // Pro 系官方 [medium,high,xhigh]：最低档也只能发 medium
        assertEquals("medium", effort("openai", "gpt-5.4-pro", ThinkingLevel.LOW));
        assertEquals("xhigh", effort("openai", "gpt-5.4-pro", ThinkingLevel.MAX));
    }

    @Test
    @DisplayName("o 系用前缀匹配：o1/o3/o4 三档，o1-mini/o1-preview 不可控")
    public void openai_o_series() {
        for (String m : Arrays.asList("o1", "o1-pro", "o3-mini", "o4-mini")) {
            assertEquals(Arrays.asList("low", "medium", "high"), codes("openai", m), m);
        }
        assertTrue(ReasoningCapabilities.resolve("openai", "o1-mini").isNone());
        assertTrue(ReasoningCapabilities.resolve("openai", "o1-preview").isNone());
    }

    // ==================================================================
    // 二、Anthropic / Gemini 官方值域
    // ==================================================================

    @Test
    @DisplayName("Anthropic 官方值域按代际递进：4-5 走预算、4-5(opus) 三档、4-6 含 max、5 系五档")
    public void anthropic_pools_by_generation() {
        // 经典：预算形态
        assertEquals(ReasoningCapability.Shape.ANTHROPIC_BUDGET,
                ReasoningCapabilities.resolve("anthropic", "claude-sonnet-4-5-20250929").shape());
        // opus-4-5：官方仅 low/medium/high
        assertEquals(Arrays.asList("low", "medium", "high"), codes("anthropic", "claude-opus-4-5"));
        // 4-6：官方 low/medium/high/max（无 xhigh）
        assertEquals(Arrays.asList("low", "medium", "high", "xhigh"), codes("anthropic", "claude-sonnet-4-6"),
                "4 个原生值 → 4 档，第 4 档由 XHIGH 承载并实发 max");
        assertEquals("max", effort("anthropic", "claude-opus-4-6", ThinkingLevel.XHIGH),
                "无 xhigh 时应就近取较强的 max");
        // 5 系与未来型号：默认五档
        assertEquals(Arrays.asList("low", "medium", "high", "xhigh", "max"),
                codes("anthropic", "claude-opus-5"));
        assertEquals(Arrays.asList("low", "medium", "high", "xhigh", "max"),
                codes("anthropic", "claude-future-9"));
    }

    @Test
    @DisplayName("Gemini：3.x Pro 无 minimal 三档、2.5 走预算且区间按官方分型")
    public void gemini_pools() {
        assertEquals(Arrays.asList("low", "medium", "high"), codes("gemini", "gemini-3-pro-preview"));
        assertEquals(Arrays.asList("low", "medium", "high"), codes("gemini", "gemini-3.1-pro-preview"));

        ReasoningCapability pro25 = ReasoningCapabilities.resolve("gemini", "gemini-2.5-pro");
        assertEquals(ReasoningCapability.Shape.GEMINI_BUDGET, pro25.shape());
        assertEquals(Integer.valueOf(32768), pro25.budgetMax(), "2.5-pro 官方上限 32768");

        ReasoningCapability flash25 = ReasoningCapabilities.resolve("gemini", "gemini-2.5-flash-lite");
        assertEquals(Integer.valueOf(24576), flash25.budgetMax(), "2.5-flash 系官方上限 24576");
    }

    // ==================================================================
    // 三、国产厂商官方值域
    // ==================================================================

    @Test
    @DisplayName("GLM：5.3 三值、5.2 两值、5/4.x 仅开关——顺序不得让 glm-5 吃掉 5.2/5.3")
    public void glm_pools() {
        assertEquals(Arrays.asList("low", "medium", "xhigh"), codes("openai", "glm-5.3"));
        assertEquals(Arrays.asList("low", "xhigh"), codes("openai", "glm-5.2"),
                "官方仅 [high,max]：只有 2 个可区分档位");
        assertEquals(ReasoningCapability.Shape.TOGGLE,
                ReasoningCapabilities.resolve("openai", "glm-5").shape());
        assertEquals(ReasoningCapability.Shape.TOGGLE,
                ReasoningCapabilities.resolve("openai", "glm-4.6").shape());
    }

    @Test
    @DisplayName("Kimi / DeepSeek / Qwen / 豆包 官方值域")
    public void cn_vendor_pools() {
        assertEquals(Arrays.asList("low", "medium", "xhigh"), codes("openai", "kimi-k3"));
        assertEquals(ReasoningCapability.Shape.TOGGLE,
                ReasoningCapabilities.resolve("openai", "kimi-k2-0905-preview").shape());
        assertTrue(ReasoningCapabilities.resolve("openai", "kimi-k2.7-code").isNone(),
                "k2.7-code 无 reasoning 选项，且不得被 kimi-k2 的 toggle 规则吃掉");

        assertEquals(Arrays.asList("low", "medium", "xhigh"), codes("openai", "deepseek-v4-flash"));
        // 官方明确「映射表对 v4-flash 与 v4-pro 完全相同」，故 pro 与 flash 同为三档。
        // 此处原断言为 [low, xhigh]（即 pool=[high,max]），是照抄第三方数据造成的误判，
        // 等于用测试把「pro 拿不到 low 档」这个缺陷焊死，已按官方文档更正。
        assertEquals(Arrays.asList("low", "medium", "xhigh"), codes("openai", "deepseek-v4-pro"));

        assertEquals(Arrays.asList("low", "medium", "high"), codes("openai", "qwen3.8-max"),
                "官方 [low,medium,xhigh]：跳过 high，第三档实发 xhigh");
        assertEquals("xhigh", effort("openai", "qwen3.8-max", ThinkingLevel.MAX));
        assertEquals(ReasoningCapability.Shape.TOGGLE,
                ReasoningCapabilities.resolve("openai", "qwen3-14b").shape());

        assertEquals(Arrays.asList("low", "medium", "high", "xhigh", "max"),
                codes("openai", "doubao-seed-2-1-pro-260628"));
        assertEquals(Arrays.asList("low", "medium", "high"),
                codes("openai", "doubao-seed-1-6-251015"));
    }

    // ==================================================================
    // 四、形态与值域正交
    // ==================================================================

    @Test
    @DisplayName("同一模型经不同接口：值域相同、wire 形态不同（规则表只管值域）")
    public void shape_and_pool_are_orthogonal() {
        List<String> viaChat = codes("openai", "gpt-5.6-sol");
        List<String> viaResponses = codes("openai-responses", "gpt-5.6-sol");
        assertEquals(viaChat, viaResponses, "值域由模型决定，不随接口变化");

        assertEquals(ReasoningCapability.Shape.OPENAI_EFFORT,
                ReasoningCapabilities.resolve("openai", "gpt-5.6-sol").shape());
        assertEquals(ReasoningCapability.Shape.RESPONSES_EFFORT,
                ReasoningCapabilities.resolve("openai-responses", "gpt-5.6-sol").shape());
    }

    // ==================================================================
    // 五、死代码修复：用户覆写必须到达请求路径
    // ==================================================================

    @Test
    @DisplayName("未绑定注册表时按规则表解析——不绑定不得引入回归")
    public void unbound_falls_back_to_rules() {
        assertFalse(ModelProfiles.isBound());
        ChatModel m = modelOf("openai", "gpt-5.6-sol");
        assertEquals(Arrays.asList("low", "medium", "high", "xhigh", "max"),
                ThinkingDepth.selectableCodes(m));
    }

    @Test
    @DisplayName("【死代码回归锚点】绑定后覆写必须真正生效于 ChatModel 路径")
    public void override_reaches_chatmodel_path() {
        // 构造一个「规则表判为窄值域」的模型：gpt-5.4 官方无 max
        ChatModel m = modelOf("openai", "gpt-5.4");
        assertFalse(ThinkingDepth.selectableCodes(m).contains("max"));

        // 用户覆写声明它其实支持 max
        Map<String, Object> spec = new LinkedHashMap<>();
        spec.put("shape", "openai_effort");
        spec.put("efforts", Arrays.asList("low", "medium", "high", "xhigh", "max"));
        Map<String, Object> caps = new HashMap<>();
        caps.put("reasoning", spec);

        ModelProfiles.bind(name -> "gpt-5.4".equals(name) ? caps : null);

        assertTrue(ThinkingDepth.selectableCodes(m).contains("max"),
                "覆写必须经 ModelProfiles 到达 ChatModel 解析路径（历史实现此处恒失效）");
        assertTrue(ThinkingDepth.isValidFor(m, "max"));
    }

    @Test
    @DisplayName("覆写可将可控模型直接判为不可控，前端据此隐藏选择器")
    public void override_can_disable() {
        ChatModel m = modelOf("openai", "gpt-5.6-sol");
        Map<String, Object> caps = new HashMap<>();
        caps.put("reasoning", Boolean.FALSE);
        ModelProfiles.bind(name -> caps);

        assertTrue(ThinkingDepth.selectableCodes(m).isEmpty());
        assertFalse(ThinkingDepth.isValidFor(m, "high"));
    }

    @Test
    @DisplayName("reset 后必须回到规则表，避免静态注册表跨用例/跨场景污染")
    public void reset_restores_rules() {
        ChatModel m = modelOf("openai", "gpt-5.6-sol");
        Map<String, Object> caps = new HashMap<>();
        caps.put("reasoning", Boolean.FALSE);
        ModelProfiles.bind(name -> caps);
        assertTrue(ThinkingDepth.selectableCodes(m).isEmpty());

        ModelProfiles.reset();
        assertFalse(ModelProfiles.isBound());
        assertEquals(5, ThinkingDepth.selectableCodes(m).size());
    }

    @Test
    @DisplayName("数据源抛异常时必须吞掉并降级——档位是增强特性，不能拖垮整轮对话")
    public void source_failure_is_swallowed() {
        ModelProfiles.bind(name -> {
            throw new IllegalStateException("boom");
        });
        assertNull(ModelProfiles.capabilitiesOf("gpt-5.6-sol"));
        assertNull(ModelProfiles.maxOutputOf("gpt-5.6-sol"));

        ChatModel m = modelOf("openai", "gpt-5.6-sol");
        assertEquals(5, ThinkingDepth.selectableCodes(m).size(), "异常后应落回规则表");
    }

    // ==================================================================
    // 六、预算基数打通（maxOutput 覆写）
    // ==================================================================

    @Test
    @DisplayName("maxOutput 覆写必须成为预算换算基数；未配置时沿用 32000 兜底（零回归）")
    public void max_output_override_drives_budget_base() {
        Map<String, Object> caps = new HashMap<>();
        caps.put("maxOutput", 128000);
        ModelProfiles.bind(name -> caps);
        assertEquals(Integer.valueOf(128000), ModelProfiles.maxOutputOf("any-model"));

        ReasoningCapability budget = ReasoningCapability.ofBudget(
                ReasoningCapability.Shape.ANTHROPIC_BUDGET, 1024, null);
        // 12.5% × 128000
        assertEquals(Integer.valueOf(16000), budget.resolveBudget(ThinkingLevel.LOW, 128000));
        // 未配置基数时沿用 32000 兜底，逐值等于历史硬编码
        assertEquals(Integer.valueOf(4000), budget.resolveBudget(ThinkingLevel.LOW, null));

        // 字符串形式与非法值
        Map<String, Object> asText = new HashMap<>();
        asText.put("maxOutput", "65536");
        ModelProfiles.bind(name -> asText);
        assertEquals(Integer.valueOf(65536), ModelProfiles.maxOutputOf("any"));

        Map<String, Object> bad = new HashMap<>();
        bad.put("maxOutput", "not-a-number");
        ModelProfiles.bind(name -> bad);
        assertNull(ModelProfiles.maxOutputOf("any"));
    }

    // ==================================================================
    // 模型名分隔符方言（实测发现的真缺陷）
    // ==================================================================

    /**
     * GitHub Copilot 用点号写小版本号（{@code claude-haiku-4.5}），
     * 而 Anthropic 官方用连字符（{@code claude-haiku-4-5}）。
     *
     * <p>不归一就会错过 budget_tokens 形态规则，被当成现代 Claude 发出 effort，
     * 而这批模型官方<b>只接受 budget_tokens</b> → 必 400。</p>
     */
    @Test
    @DisplayName("点号与连字符写法必须等价（经典 Claude 不得退化为 effort）")
    public void dotted_version_must_match_hyphenated_rule() {
        for (String name : new String[]{"claude-haiku-4.5", "claude-sonnet-4.5", "claude-opus-4.1"}) {
            ReasoningCapability cap = ReasoningCapabilities.resolve("anthropic", name);
            assertEquals(ReasoningCapability.Shape.ANTHROPIC_BUDGET, cap.shape(),
                    name + " 官方只认 budget_tokens，不得发 effort");
        }
        // 两种写法必须得到同一结果
        assertEquals(ReasoningCapabilities.resolve("anthropic", "claude-haiku-4-5").shape(),
                ReasoningCapabilities.resolve("anthropic", "claude-haiku-4.5").shape());
    }

    /** claude-sonnet-4.6 官方 [low,medium,high,max]，无 xhigh——点号写法不得多报 xhigh。 */
    @Test
    @DisplayName("claude-sonnet-4.6（点号）不得多报 xhigh")
    public void dotted_sonnet_4_6_must_not_over_report_xhigh() {
        ReasoningCapability cap = ReasoningCapabilities.resolve("anthropic", "claude-sonnet-4.6");
        assertFalse(cap.effectiveEfforts().contains("xhigh"),
                "官方未公布 xhigh，发出会 400");
        assertTrue(cap.effectiveEfforts().contains("max"));
    }

    /**
     * Vertex AI 用 {@code @} 接版本日期，且这两个型号<b>没有小版本号</b>
     * （{@code claude-sonnet-4@20250514}，不是 {@code claude-sonnet-4-0}），
     * 归一后才能命中已有的 {@code claude-sonnet-4-20} 片段。
     */
    @Test
    @DisplayName("Vertex 的 @日期 写法仍需识别为经典 Claude")
    public void vertex_at_suffix_must_resolve_to_budget() {
        for (String name : new String[]{"claude-sonnet-4@20250514", "claude-opus-4@20250514"}) {
            assertEquals(ReasoningCapability.Shape.ANTHROPIC_BUDGET,
                    ReasoningCapabilities.resolve("anthropic", name).shape(), name);
        }
        // 带日期的现代型号不受影响，仍走 effort
        assertEquals(ReasoningCapability.Shape.ANTHROPIC_EFFORT,
                ReasoningCapabilities.resolve("anthropic", "claude-opus-5@default").shape());
    }

    // ==================================================================
    // 官方值域纠错
    // ==================================================================

    /** gpt-5.2 官方 [none,low,medium,high,xhigh]，早期规则误归为三档，导致 xhigh 用不到。 */
    @Test
    @DisplayName("gpt-5.2 官方含 xhigh，不得少报")
    public void gpt_5_2_has_xhigh() {
        ReasoningCapability cap = ReasoningCapabilities.resolve("openai", "gpt-5.2");
        assertTrue(cap.effectiveEfforts().contains("xhigh"));
        assertFalse(cap.effectiveEfforts().contains("max"), "官方无 max");
        // 同族的窄口变体仍由更具体的规则优先命中
        assertEquals(Arrays.asList("medium"),
                new java.util.ArrayList<>(ReasoningCapabilities
                        .resolve("openai", "gpt-5.2-chat-latest").effectiveEfforts()));
        assertFalse(ReasoningCapabilities.resolve("openai", "gpt-5.2-pro")
                .effectiveEfforts().contains("low"), "Pro 系官方无低档");
    }

    /** 豆包 seed-1-8 / evolving 官方已含 xhigh+max； character 官方跳过 medium。 */
    @Test
    @DisplayName("doubao-seed 各变体值域逐族对齐")
    public void doubao_seed_variants_aligned() {
        for (String name : new String[]{"doubao-seed-1-8-251228", "doubao-seed-evolving"}) {
            ReasoningCapability cap = ReasoningCapabilities.resolve("openai", name);
            assertTrue(cap.effectiveEfforts().contains("max"), name + " 官方含 max");
        }
        ReasoningCapability ch = ReasoningCapabilities.resolve("openai", "doubao-seed-character-260628");
        assertFalse(ch.effectiveEfforts().contains("medium"), "官方跳过 medium，发出会 400");
        // 较老的 seed-1-6 仍走四档，不被新规则注入 max
        assertFalse(ReasoningCapabilities.resolve("openai", "doubao-seed-1-6-250615")
                .effectiveEfforts().contains("max"));
    }

    /**
     * 未来新增型号的兼容契约：规则未命中时<b>不得报错、不得空档</b>，
     * 必须落到接口兼容的保守值域。
     */
    @Test
    @DisplayName("未知新型号必须安全降级而非失效")
    public void unknown_future_models_degrade_safely() {
        for (String name : new String[]{"gpt-9", "claude-opus-9", "gemini-9-pro", "brand-new-model"}) {
            ReasoningCapability cap = ReasoningCapabilities.resolve("openai", name);
            assertFalse(cap.isNone(), name + " 不得被当成不可推理");
            assertFalse(cap.effectiveEfforts().isEmpty(), name + " 必须有保守值域");
            assertFalse(cap.selectableLevels().isEmpty(), name + " UI 不得无档可选");
            assertNotNull(cap.resolveEffort(ThinkingLevel.MAX), name + " 最高档必须映到合法值");
        }
        // 新 Claude 走 anthropic 口时应拿到官方现代五档（「列举老的、放行新的」）
        assertEquals(5, ReasoningCapabilities.resolve("anthropic", "claude-opus-9")
                .effectiveEfforts().size());
    }
}
