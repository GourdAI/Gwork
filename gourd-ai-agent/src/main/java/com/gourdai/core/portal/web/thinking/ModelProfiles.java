package com.gourdai.core.portal.web.thinking;

import java.util.Map;

/**
 * 模型档位相关配置的查找入口——让「请求路径」与「UI 下发路径」读同一份数据。
 *
 * <h3>为什么需要这一层</h3>
 * <p>推理能力的最高优先级来源是用户在模型配置里写的 {@code capabilities}，它存放在
 * {@code AgentSettings.models}（{@code ModelDo}）里。UI 端点（{@code /web/chat/models}）
 * 直接持有 {@code AgentSettings}，取覆写毫无障碍；但真正发请求的注入点只拿到
 * {@code ChatModel}，而 {@code ChatModel.getConfig()} 返回的是 solon-ai 的
 * {@code ChatConfigReadonly} <b>包装器</b>——它与 {@code ModelDo} 并非同一继承体系
 * （{@code ChatConfigReadonly → Object}，而 {@code ModelDo → ChatConfig → AiConfig → Object}），
 * 无论怎样强转或 {@code instanceof} 探测都取不到覆写。</p>
 *
 * <p>历史实现曾用 {@code Object} 中转绕过编译错误：</p>
 * <pre>
 * Object raw = config;
 * if (raw instanceof ModelDo) { ... }   // 运行时恒为 false —— 死代码
 * </pre>
 * <p>这只骗过了编译器，运行时分支永不进入：用户配了覆写，UI 会如实显示扩展后的档位，
 * 实际请求却仍发兜底值——<b>看起来生效，实际没有</b>，比完全不支持更具误导性。</p>
 *
 * <p>本类把「按模型名查配置」抽成一个可注入的端口：应用启动时由持有
 * {@code AgentSettings} 的一方绑定实现（见 {@code App#initAgentSettings}），
 * 于是两条路径共用同一数据源，不再可能各读一套。</p>
 *
 * <h3>设计约束</h3>
 * <ul>
 *   <li><b>不反向依赖</b>：本类只认 {@code Map}/{@code Integer} 等基础类型，
 *       thinking 包不引入 {@code ModelDo} 或配置层类型，保持可单测。</li>
 *   <li><b>未绑定即降级</b>：未绑定时全部返回 null，解析自然落到内置规则 / 接口兜底，
 *       与绑定前行为一致（CLI、单测等不经过 App 启动的场景不受影响）。</li>
 *   <li><b>容错</b>：实现方抛异常时吞掉并返回 null——档位是增强特性，
 *       绝不能因为查配置失败而让整轮对话失败。</li>
 * </ul>
 *
 * @author oisin
 */
public final class ModelProfiles {

    private ModelProfiles() {
    }

    /**
     * 模型配置查找端口。由应用启动时绑定。
     */
    public interface Source {
        /**
         * 查某模型的能力覆写（即 {@code ModelDo.capabilities}）。
         *
         * @param modelName 模型名；可能是配置键（name）也可能是实际模型 id（model），实现方应两者都能命中
         * @return 覆写映射；无则 null
         */
        Map<String, Object> capabilitiesOf(String modelName);
    }

    /** 当前绑定的数据源；volatile 保证启动线程写入对请求线程立即可见。 */
    private static volatile Source source;

    /**
     * 绑定数据源（应用启动时调用一次）。
     *
     * @param src 数据源；传 null 等价于解绑
     */
    public static void bind(Source src) {
        source = src;
    }

    /**
     * 解绑（供单测隔离使用，避免用例间相互污染）。
     */
    public static void reset() {
        source = null;
    }

    /** 是否已绑定数据源。 */
    public static boolean isBound() {
        return source != null;
    }

    /**
     * 查模型的能力覆写。
     *
     * @param modelName 模型名
     * @return 覆写映射；未绑定 / 查不到 / 查询异常时返回 null
     */
    public static Map<String, Object> capabilitiesOf(String modelName) {
        Source src = source;
        if (src == null || modelName == null || modelName.trim().isEmpty()) {
            return null;
        }
        try {
            return src.capabilitiesOf(modelName);
        } catch (Throwable ignore) {
            // 档位是增强特性：查配置失败只降级，不向上冒泡影响本轮对话
            return null;
        }
    }

    /**
     * 取模型的最大输出长度——预算换算（{@code budget_tokens} / {@code thinkingBudget}）的基数。
     *
     * <p>本地模型配置没有独立的 output limit 字段，故约定写在能力覆写里：</p>
     * <pre>
     * "capabilities": { "maxOutput": 128000, "reasoning": { ... } }
     * </pre>
     *
     * <p>未配置时返回 null，由 {@link ReasoningCapability#resolveBudget} 落到兜底基数
     * （与历史实现一致，保证零回归）。</p>
     *
     * @param modelName 模型名
     * @return 最大输出长度；未配置或非正数时返回 null
     */
    public static Integer maxOutputOf(String modelName) {
        Map<String, Object> caps = capabilitiesOf(modelName);
        if (caps == null) {
            return null;
        }
        Object v = caps.get("maxOutput");
        if (v == null) {
            v = caps.get("max_output");
        }
        Integer out = toPositiveInt(v);
        return out;
    }

    private static Integer toPositiveInt(Object v) {
        if (v instanceof Number) {
            int n = ((Number) v).intValue();
            return n > 0 ? n : null;
        }
        if (v instanceof CharSequence) {
            try {
                int n = Integer.parseInt(v.toString().trim());
                return n > 0 ? n : null;
            } catch (NumberFormatException ignore) {
                return null;
            }
        }
        return null;
    }
}
