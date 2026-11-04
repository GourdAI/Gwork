package com.gourdai.core.portal.web.thinking;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 思考深度档位——<b>全局统一的一套枚举</b>，不再按接口类型各分一套。
 *
 * <p>本枚举是用户侧的抽象档位，与任何厂商的原生取值解耦。档位到具体请求参数的翻译
 * 由 {@link ReasoningCapability}（能力）+ {@link ThinkingDepth}（注入）完成：</p>
 * <ol>
 *   <li><b>effort 系</b>模型：档位就近映射到该模型真实支持的原生 effort 值；</li>
 *   <li><b>budget 系</b>模型：档位按 {@link #ratio()} 乘以模型最大输出长度换算成 token 预算；</li>
 *   <li><b>toggle 系</b>模型：任一非 AUTO 档位都只能表达「开启思考」。</li>
 * </ol>
 *
 * <h3>为什么是这 5 档</h3>
 * <p>取值锚定 20 家原厂/一方云共 278 个带 effort 值域的模型实测分布：
 * high 98.2% / low 89.2% / medium 83.8% / max 50.0% / xhigh 43.5%，
 * 而 minimal 仅 14.7%。故取 low/medium/high/xhigh/max 作为锚点而不收录 minimal——
 * 档位数与兼容性负相关，多一档低频锚点反而拉低整体命中率。</p>
 *
 * <h3>AUTO 的语义</h3>
 * <p>{@link #AUTO} = <b>不注入任何思考参数</b>，完全跟随厂商默认行为（等同 "auto"）。
 * 它<b>不是</b>「关闭思考」：多数国产模型（GLM / DeepSeek / Kimi / 混元 / Qwen3）默认即开启思考，
 * AUTO 下它们仍会思考。本系统不提供显式关闭思考的能力，这是既定设计取舍。</p>
 *
 * <h3>兼容性</h3>
 * <p>历史落盘值 {@code "off"} 与 {@code "minimal"} 由 {@link #from(String)} 静默迁移，
 * 分别归一到 {@link #AUTO} 与 {@link #LOW}，存量会话零感知。</p>
 *
 * @author oisin
 */
public enum ThinkingLevel {
    /** 默认：不注入任何思考参数，跟随模型自身默认行为。 */
    AUTO("auto", 0, 0d),
    /** 低：较少推理，偏速度。 */
    LOW("low", 1, 0.125d),
    /** 中：平衡推理与速度。 */
    MEDIUM("medium", 2, 0.375d),
    /** 高：深度推理。 */
    HIGH("high", 3, 0.75d),
    /** 超高：编码 / 智能体场景最佳。 */
    XHIGH("xhigh", 4, 0.875d),
    /** 极限：最强推理，不计成本。 */
    MAX("max", 5, 0.95d);

    /** 落盘 / 传输用的小写编码。 */
    private final String code;
    /** 档位次序（AUTO=0，其余 1..5），用于与原生值就近映射。 */
    private final int rank;
    /**
     * 预算占比——以模型「最大输出长度」为基数换算 thinking budget。
     *
     * <p>比例由现状 Anthropic 老格式反解锚定，保证零回归：原实现固定
     * low=4000 / medium=12000 / high=24000，相对 dialect 默认 max_tokens=32000
     * 恰好是 12.5% / 37.5% / 75%，XHIGH、MAX 为自然外推。</p>
     *
     * <p>基数必须取「最大输出长度」而非厂商声明的 budget 上限：实测 20 家原厂中
     * budget 上限字段缺失率高达 91.4%，而最大输出长度 100% 可得。</p>
     */
    private final double ratio;

    /** 编码 → 枚举（含历史别名）。 */
    private static final Map<String, ThinkingLevel> BY_CODE;

    static {
        Map<String, ThinkingLevel> m = new LinkedHashMap<>();
        for (ThinkingLevel v : values()) {
            m.put(v.code, v);
        }
        // ---- 历史落盘值迁移（存量会话 / 自动化任务 / ACP 设置里可能残留）----
        // "off" 旧义即「不注入、跟随模型默认」，与 AUTO 完全同义，仅命名有歧义故改名。
        m.put("off", AUTO);
        // 统一档位不再收录 minimal（原厂支持率仅 14.7%），存量值就近归入 LOW。
        m.put("minimal", LOW);
        // 少数前端/接口曾用的同义写法。
        m.put("none", AUTO);
        m.put("default", AUTO);
        m.put("xhard", XHIGH);
        BY_CODE = Collections.unmodifiableMap(m);
    }

    ThinkingLevel(String code, int rank, double ratio) {
        this.code = code;
        this.rank = rank;
        this.ratio = ratio;
    }

    /** 落盘 / 传输编码（小写）。 */
    public String code() {
        return code;
    }

    /** 档位次序：AUTO=0，LOW..MAX=1..5。 */
    public int rank() {
        return rank;
    }

    /** 预算占比（以模型最大输出长度为基数）；AUTO 为 0。 */
    public double ratio() {
        return ratio;
    }

    /** 是否为「不注入」档。 */
    public boolean isAuto() {
        return this == AUTO;
    }

    /**
     * 解析档位编码，不识别的值一律归为 {@link #AUTO}（宁可跟随默认，也不误注入）。
     *
     * <p>同时承担历史值迁移：{@code "off"} → AUTO、{@code "minimal"} → LOW。</p>
     *
     * @param code 档位编码，允许 null / 空 / 任意大小写
     * @return 归一化档位，永不为 null
     */
    public static ThinkingLevel from(String code) {
        if (code == null) {
            return AUTO;
        }
        // 必须固定 Locale.ROOT：土耳其语等 Locale 下 "HIGH".toLowerCase() 会得到 "hıgh"
        // （无点小写 i），查表失配后被静默归为 AUTO —— 用户选的档位凭空消失且无任何报错。
        String c = code.trim().toLowerCase(Locale.ROOT);
        if (c.isEmpty()) {
            return AUTO;
        }
        ThinkingLevel v = BY_CODE.get(c);
        return v == null ? AUTO : v;
    }

    /** 规范化档位编码：等价于 {@code from(code).code()}。 */
    public static String normalize(String code) {
        return from(code).code();
    }

    /** 除 AUTO 外的全部档位，按由低到高排列。 */
    public static ThinkingLevel[] ladder() {
        return new ThinkingLevel[]{LOW, MEDIUM, HIGH, XHIGH, MAX};
    }
}
