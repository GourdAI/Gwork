package com.gourdai.core.config.entity;

import com.gourdai.harness.talents.gateway.openapi.ApiSource;
import com.gourdai.core.config.AgentFlags;

/**
 *
 * @author oisin
 *
 */
public class ApiSourceDo extends ApiSource {
    //作用域（全局或本地）
    private String scope = AgentFlags.SCOPE_USER;

    public String getScope() {
        return scope;
    }

    public void setScope(String scope) {
        this.scope = scope;
    }
}
