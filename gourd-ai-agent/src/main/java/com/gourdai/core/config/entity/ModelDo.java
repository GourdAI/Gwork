package com.gourdai.core.config.entity;

import org.noear.solon.ai.chat.ChatConfig;
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
