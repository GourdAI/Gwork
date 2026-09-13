package com.gourdai.core.portal.web;

import com.gourdai.core.portal.web.thinking.ModelProfiles;
import com.gourdai.core.portal.web.thinking.ReasoningCapabilities;
import com.gourdai.core.portal.web.thinking.ReasoningCapability;
import com.gourdai.core.portal.web.thinking.ThinkingLevel;
import org.noear.solon.ai.chat.ChatConfigReadonly;
import org.noear.solon.ai.chat.ChatModel;
import org.noear.solon.ai.chat.ModelOptionsAmend;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 思考深度（推理力度）——<b>统一 5 档</b>，按模型能力翻译成各厂商的原生参数。
 *
 * <p>本类是「档位 → 请求参数」的注入门面，自身不再持有任何档位表。四层职责分工：</p>
 * <ol>
 *   <li>{@link ThinkingLevel}——统一档位枚举（AUTO + LOW/MEDIUM/HIGH/XHIGH/MAX）；</li>
 *   <li>{@link ReasoningCapability}——单模型的推理能力（形态 / 值域 / 预算区间）；</li>
 *   <li>{@link ReasoningCapabilities}——能力解析，三级回退：用户覆写 &gt; 内置规则 &gt; 接口兜底；</li>
 *   <li>本类——按能力形态拼装 wire 结构并保证幂等。</li>
 * </ol>
 *
 * <h3>与旧实现的关键差异</h3>
 * <p>旧实现按<b>接口类型</b>分流并把「Anthropic 用哪种格式」写成编译期常量，
 * 而推理能力实际是<b>按模型</b>而非按接口的——同属 anthropic 接口的
 * {@code claude-sonnet-4-5} 只认 budget_tokens、{@code claude-sonnet-5} 只认 output_config.effort，
 * 一刀切必然有一方 400。现改为按模型解析能力，接口类型仅作为最后兜底。</p>
 *
 * <h3>AUTO 语义</h3>
 * <p>{@code AUTO} = 不注入任何思考参数，跟随厂商默认。它<b>不是</b>「关闭思考」——
 * 本系统不提供关闭思考的能力（既定设计取舍）。</p>
 *
 * @author oisin
 */
public final class ThinkingDepth {
    private ThinkingDepth() {
    }

    /**
     * 默认档位编码：不注入任何思考参数，跟随模型自身默认行为。
     *
     * <p>历史上此常量名为 {@code OFF}、值为 {@code "off"}，但其真实行为一直是「不注入」而非
     * 「关闭思考」，导致命名与 i18n 文案（"默认 / 跟随模型默认行为"）长期矛盾。
     * 现更名为 AUTO 消除歧义；历史落盘的 {@code "off"} 由
     * {@link ThinkingLevel#from(String)} 静默迁移，存量数据零感知。</p>
     */
    public static final String AUTO = ThinkingLevel.AUTO.code();

    /** 本类管理的请求键，切换/降级时统一清理，保证幂等。 */
    private static final String[] MANAGED_KEYS = {"thinking", "reasoning", "reasoning_effort"};

    /**
     * 规范化档位编码：null / 空 / 不识别 → {@link #AUTO}；并迁移历史值。
     *
     * @param depth 原始档位编码
     * @return 规范化后的编码，永不为 null
     */
    public static String normalize(String depth) {
        return ThinkingLevel.normalize(depth);
    }

    /**
     * 校验档位对指定模型是否真正有效（能产生可区分的效果）。
     *
     * <p>供选择端点回显与前端收缩使用：切到不支持该档位的模型时应回落为 AUTO。</p>
     *
     * @param model 目标模型
     * @param depth 档位编码
     * @return 该档位在此模型上是否可用
     */
    public static boolean isValidFor(ChatModel model, String depth) {
        ThinkingLevel level = ThinkingLevel.from(depth);
        if (level.isAuto()) {
            return false;
        }
        return capabilityOf(model).selectableLevels().contains(level);
    }

    /**
     * 列出某模型真正可区分的档位编码——前端据此收缩档位选择器（策略 S2）。
     *
     * <p>返回空列表表示该模型无可调档位，前端应隐藏整个选择器（只保留"默认"）。</p>
     *
     * @param model 目标模型
     * @return 可选档位编码（不含 AUTO，AUTO 由前端固定置顶）
     */
    public static List<String> selectableCodes(ChatModel model) {
        List<String> codes = new ArrayList<>();
        for (ThinkingLevel level : capabilityOf(model).selectableLevels()) {
            codes.add(level.code());
        }
        return codes;
    }

    /**
     * 列出某模型配置真正可区分的档位编码（无需构造 ChatModel 实例）。
     *
     * @param config 模型配置
     * @return 可选档位编码
     */
    public static List<String> selectableCodes(String standard, String modelName,
                                               Map<String, Object> capabilities) {
        List<String> codes = new ArrayList<>();
        ReasoningCapability cap = ReasoningCapabilities.resolve(standard, modelName, capabilities);
        for (ThinkingLevel level : cap.selectableLevels()) {
            codes.add(level.code());
        }
        return codes;
    }

    /**
     * 按模型能力把档位注入到请求选项。
     *
     * <p>先清掉本类管理的所有键（幂等，切换/降级不残留上一轮参数），再按能力形态写对应键。
     * 档位为 AUTO、模型不支持推理控制、或不可调档时，只清理不注入。</p>
     *
     * @param options 本轮请求选项
     * @param model   目标模型（用于解析推理能力；为 null 时退化为接口兜底）
     * @param depth   档位编码
     */
    public static void applyTo(ModelOptionsAmend<?, ?> options, ChatModel model, String depth) {
        applyInternal(options, capabilityOf(model), ThinkingLevel.from(depth), maxOutputOf(model));
    }

    /**
     * 仅凭接口类型注入（兼容入口）。
     *
     * <p>无模型信息时只能按接口兜底，无法规避按模型而异的格式差异，
     * 调用方应尽量改用 {@link #applyTo(ModelOptionsAmend, ChatModel, String)}。</p>
     *
     * @param options  本轮请求选项
     * @param standard 接口类型
     * @param depth    档位编码
     */
    public static void applyTo(ModelOptionsAmend<?, ?> options, String standard, String depth) {
        applyInternal(options, ReasoningCapabilities.resolve(standard, null, null),
                ThinkingLevel.from(depth), null);
    }

    // ------------------------------------------------------------------
    // 内部实现
    // ------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private static void applyInternal(ModelOptionsAmend<?, ?> options, ReasoningCapability cap,
                                      ThinkingLevel level, Integer maxOutput) {
        if (options == null) {
            return;
        }

        clearManagedKeys(options);

        if (level.isAuto() || cap.isNone()) {
            return;
        }

        switch (cap.shape()) {
            case ANTHROPIC_EFFORT: {
                String effort = cap.resolveEffort(level);
                if (effort == null) {
                    return;
                }
                // 现代 Claude：adaptive thinking + output_config.effort
                Map<String, Object> thinking = new LinkedHashMap<>();
                thinking.put("type", "adaptive");
                options.optionSet("thinking", thinking);

                Map<String, Object> outputConfig = new LinkedHashMap<>();
                Object existing = options.option("output_config");
                if (existing instanceof Map) {
                    outputConfig.putAll((Map<String, Object>) existing);
                }
                outputConfig.put("effort", effort);
                options.optionSet("output_config", outputConfig);
                break;
            }
            case ANTHROPIC_BUDGET: {
                Integer budget = cap.resolveBudget(level, maxOutput);
                if (budget == null) {
                    return;
                }
                // 经典 Claude：thinking.budget_tokens（必须严格小于 max_tokens）
                Map<String, Object> thinking = new LinkedHashMap<>();
                thinking.put("type", "enabled");
                thinking.put("budget_tokens", budget);
                options.optionSet("thinking", thinking);
                break;
            }
            case RESPONSES_EFFORT: {
                String effort = cap.resolveEffort(level);
                if (effort == null) {
                    return;
                }
                Map<String, Object> reasoning = new LinkedHashMap<>();
                reasoning.put("effort", effort);
                options.optionSet("reasoning", reasoning);
                break;
            }
            case GEMINI_LEVEL: {
                String effort = cap.resolveEffort(level);
                if (effort == null) {
                    return;
                }
                Map<String, Object> thinkingConfig = new LinkedHashMap<>();
                // 必须固定 Locale.ROOT：土耳其语 Locale 下 "high".toUpperCase() 会得到 "HİGH"
                // （带点大写 I），发给 Gemini 是非法枚举值，直接 400。
                thinkingConfig.put("thinkingLevel", effort.toUpperCase(Locale.ROOT));
                putGenerationConfig(options, thinkingConfig);
                break;
            }
            case GEMINI_BUDGET: {
                Integer budget = cap.resolveBudget(level, maxOutput);
                if (budget == null) {
                    return;
                }
                Map<String, Object> thinkingConfig = new LinkedHashMap<>();
                thinkingConfig.put("thinkingBudget", budget);
                putGenerationConfig(options, thinkingConfig);
                break;
            }
            case TOGGLE:
                // 仅支持开关的模型：这类模型默认即开启思考，且本系统不提供关闭能力，
                // 故任何档位都等价于「跟随默认」——不注入，避免向 OpenAI 兼容口发出无效键。
                break;
            default:
                // OPENAI_EFFORT 及其它 effort 系：顶层透传
                String effort = cap.resolveEffort(level);
                if (effort != null) {
                    options.optionSet("reasoning_effort", effort);
                }
                break;
        }
    }

    /** 清理本类管理的全部键（含嵌套在 output_config / generationConfig 里的部分）。 */
    @SuppressWarnings("unchecked")
    private static void clearManagedKeys(ModelOptionsAmend<?, ?> options) {
        for (String key : MANAGED_KEYS) {
            options.optionRemove(key);
        }
        // 只摘掉自己写入的 effort，保留调用方可能设置的其它 output_config 字段
        Object oc = options.option("output_config");
        if (oc instanceof Map) {
            ((Map<String, Object>) oc).remove("effort");
            if (((Map<String, Object>) oc).isEmpty()) {
                options.optionRemove("output_config");
            }
        }
        Object gc = options.option("generationConfig");
        if (gc instanceof Map) {
            ((Map<String, Object>) gc).remove("thinkingConfig");
        }
    }

    /** 合并写入 generationConfig.thinkingConfig，保留已有的其它生成参数。 */
    @SuppressWarnings("unchecked")
    private static void putGenerationConfig(ModelOptionsAmend<?, ?> options, Map<String, Object> thinkingConfig) {
        Map<String, Object> generationConfig = new LinkedHashMap<>();
        Object existing = options.option("generationConfig");
        if (existing instanceof Map) {
            generationConfig.putAll((Map<String, Object>) existing);
        }
        generationConfig.put("thinkingConfig", thinkingConfig);
        options.optionSet("generationConfig", generationConfig);
    }

    /**
     * 解析模型的推理能力（模型为 null 时给出 openai 兜底）。
     *
     * <p><b>用户覆写必须经 {@link ModelProfiles} 查询，不能从 ChatModel 上探测。</b>
     * solon-ai 的 {@code ChatModel} 持有的是包装器 {@code ChatConfigReadonly}，
     * 它与本地 {@code ModelDo} 并非同一继承体系（{@code ChatConfigReadonly → Object}，
     * 而 {@code ModelDo → ChatConfig → AiConfig → Object}），
     * 任何 {@code instanceof} / 强转探测在运行时都恒为 false。
     * 历史实现曾用 {@code Object} 中转「绕过编译错误」，结果是覆写分支永不执行的死代码：
     * UI 端点直接从 {@code ModelDo} 取覆写、如实显示扩展后的档位，而这里取不到，
     * 于是前后端不一致——用户看着生效，实际仍发兜底值。</p>
     *
     * @see ModelProfiles
     */
    private static ReasoningCapability capabilityOf(ChatModel model) {
        if (model == null) {
            return ReasoningCapabilities.resolve(null, null, null);
        }
        String modelName = modelNameOf(model);
        return ReasoningCapabilities.resolve(model.getStandardOrProvider(), modelName,
                ModelProfiles.capabilitiesOf(modelName));
    }

    /**
     * 模型的最大输出长度——预算换算的基数。
     *
     * <p>本地模型配置没有独立的 output limit 字段，故取自能力覆写里的
     * {@code capabilities.maxOutput}；未配置时返回 null，由
     * {@link ReasoningCapability#resolveBudget} 落到兜底基数 32000。
     * 该兜底与旧实现的 Anthropic 预算基数完全一致（旧值
     * low=4000/medium=12000/high=24000 正是 32000 的 12.5%/37.5%/75%），
     * 故未配置时预算路径零回归。</p>
     */
    private static Integer maxOutputOf(ChatModel model) {
        return model == null ? null : ModelProfiles.maxOutputOf(modelNameOf(model));
    }

    /** 取模型名（配置缺失时返回 null）。 */
    private static String modelNameOf(ChatModel model) {
        ChatConfigReadonly config = model.getConfig();
        return (config == null) ? null : config.getModel();
    }
}
