package com.gourdai.core.config.entity;

import com.gourdai.ai.chat.ChatConfig;
import com.gourdai.core.config.AgentFlags;

import java.util.Map;

/**
 *
 * @author oisin
 *
 */
public class ModelDo extends ChatConfig {
    private boolean visibled = true;

    //作用域（全局或本地）
    private String scope = AgentFlags.SCOPE_USER;

    /**
     * 模型稳定 uid（统计口径锚点）：{@code #uidOf(String, String)} 派生的确定性短哈希。
     *
     * 用途：使用统计按 uid 归组，与服务商改名/名称大小写彻底解耦——同一渠道改名前后
     * 在统计页上始终并成一条。不参与引擎注册、不参与配置查找，纯统计字段。
     *
     * 空值语义：旧配置首次加载时不存在，序列化/拷贝（ONode round-trip）自动携带；
     * 不在加载路径主动回填落盘（避免加载时写文件），trace 产生时经
     * {@code HarnessEngine#getModelOrNil} 取到的 ModelDo 实例会现算补上。
     */
    private String uid;

    /**
     * 派生模型稳定 uid：{@code SHA-256(provider|model)} 取前 16 个 hex 字符。
     *
     * 确定性派生（同名同值跨启动、跨机器结果一致）：settings.json 里不持久化也能重算出相同 uid。
     * provider/model 大小写不敏感——「MAD」与「mad」视为同一服务渠道，避免统计按大小写分裂；
     * 但 provider 与 model 之间的分隔符/空格差异保留区分（不同渠道同名模型不归并）。
     * 参数空安全：空值按空串处理。
     */
    public static String uidOf(String provider, String model) {
        String src = (provider == null ? "" : provider.trim().toLowerCase(java.util.Locale.ROOT))
                + "|" + (model == null ? "" : model.trim().toLowerCase(java.util.Locale.ROOT));
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(src.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(16);
            for (int i = 0; i < 8; i++) {
                sb.append(String.format("%02x", hash[i]));
            }
            return sb.toString();
        } catch (Throwable e) {
            // MessageDigest 不可用（FIPS 等极端环境）：退化为幂等哈希，仍保证确定性
            return Integer.toHexString(src.hashCode());
        }
    }

    /** 返回本实例的稳定 uid；uid 字段为空时现算并缓存（字段级惰性，幂等）。 */
    public String stableUid() {
        if (uid == null || uid.isEmpty()) {
            uid = uidOf(getProvider(), getModel());
        }
        return uid;
    }

    /**
     * 模型能力覆写。
     *
     * <p>目前承载推理（思考）能力，键为 {@code reasoning}，用于在内置规则表不准或厂商
     * 临时变更时由用户直接指定，优先级最高。支持三种写法：</p>
     * <pre>
     * "capabilities": { "reasoning": false }
     * "capabilities": { "reasoning": "anthropic_budget" }
     * "capabilities": { "reasoning": { "shape": "openai_effort",
     *                                  "efforts": ["low", "high"],
     *                                  "budgetMin": 1024, "budgetMax": 24576 } }
     * </pre>
     *
     * @see com.gourdai.core.portal.web.thinking.ReasoningCapabilities
     */
    private Map<String, Object> capabilities;

    public String getUid() {
        return uid;
    }

    public void setUid(String uid) {
        this.uid = uid;
    }

    public Map<String, Object> getCapabilities() {
        return capabilities;
    }

    public void setCapabilities(Map<String, Object> capabilities) {
        this.capabilities = capabilities;
    }

    public void setScope(String scope) {
        this.scope = scope;
    }

    public String getScope() {
        return scope;
    }

    public boolean isVisibled() {
        return visibled;
    }

    public void setVisibled(boolean visibled) {
        this.visibled = visibled;
    }

    @Override
    public boolean isEnabled() {
        return visibled && enabled;
    }
}
