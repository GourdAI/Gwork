package com.gourdai.core.config.entity;

import com.gourdai.harness.talents.lsp.LspServerParameters;
import com.gourdai.core.config.AgentFlags;

/**
 * LSP 服务器配置实体
 *
 * @author oisin
 */
public class LspServerDo extends LspServerParameters {
    //作用域（全局或本地）
    private String scope = AgentFlags.SCOPE_USER;

    public void setScope(String scope) {
        this.scope = scope;
    }

    public String getScope() {
        return scope;
    }


}
