package com.gourdai.core.config.entity;

import com.gourdai.ai.mcp.client.McpServerParameters;
import com.gourdai.core.config.AgentFlags;

/**
 *
 * @author oisin
 *
 */
public class McpServerDo extends McpServerParameters {
    //作用域（全局或本地）
    private String scope = AgentFlags.SCOPE_USER;

    public void setScope(String scope) {
        this.scope = scope;
    }

    public String getScope() {
        return scope;
    }
}
