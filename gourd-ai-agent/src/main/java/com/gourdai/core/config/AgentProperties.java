package com.gourdai.core.config;

import lombok.Getter;

import com.gourdai.harness.HarnessExtension;
import com.gourdai.core.config.entity.ApiSourceDo;
import com.gourdai.core.config.entity.LspServerDo;
import com.gourdai.core.config.entity.McpServerDo;
import com.gourdai.core.config.entity.ModelDo;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 代理属性（相关配置从 config.yml, AgentProperties - 慢慢过度到 settings.json, AgentSettings）
 *
 * @author oisin
 * @since 3.9.1
 */
@Getter
public class AgentProperties implements Serializable {
    /**
     * @deprecated 2026.4.10 {@link #getModels()}
     *
     */
    @Deprecated
    private ModelDo chatModel;

    //主代理工具权限
    private List<String> tools = new ArrayList<>();

    // 禁用工具（全局）
    private List<String> disallowedTools = new ArrayList<>();

    //最大步数
    @Deprecated
    private Integer maxSteps;
    private Integer maxTurns;

    //自我反思
    private boolean autoRethink = true;

    private int historyWindowSize = 30;

    //压缩触发比例：作为「提前触发」的上限钳制器，100 = 完全由绝对阈值决定
    private int compressionRatio = 100;
    //压缩后的目标水位比例（决定「压到多深」，过高会导致压缩抖动）
    private int compressionTargetRatio = 45;
    //为模型单轮输出预留的 token（绝对量）
    private int compressionReservedOutputTokens = 20000;
    //启用会话意图链（防多轮对话意图漂移）
    private boolean intentChainEnabled = true;
    //意图链 token 上限
    private int intentChainMaxTokens = 2000;
    private String summaryModel; //摘要大模型

    private boolean memoryIsolation = true;
    private boolean memoryEnabled = true;

    private boolean sandboxMode = true;
    private boolean sandboxAllowUserHome = true;
    private boolean sandboxSystemRestrict = false;

    private boolean hitlEnabled = false;
    private boolean subagentEnabled = true;

    private boolean mcpEnabled = true;
    private boolean openApiEnabled = true;
    private boolean lspEnabled = true;

    private String userAgent = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GWork/1.0 like claude-code; +https://www.gourd-ai.cn/)";
    //defaultModel
    private String defaultModel;

    //api 重试次数
    private int apiRetries = 3;
    //Mcp 重试次数
    private int mcpRetries = 3;
    //模型重试次数
    private int modelRetries = 3;

    //扩展
    private List<HarnessExtension> extensions = new ArrayList<>();

    //大模型
    private List<ModelDo> models = new ArrayList<>();
    /**
     * @deprecated 4.0.0
     */
    @Deprecated
    private Map<String, String> skillPools = new LinkedHashMap<>();
    /**
     * @deprecated 4.0.0
     */
    @Deprecated
    private List<String> agentPools = new ArrayList<>();
    //mcp集
    private Map<String, McpServerDo> mcpServers = new LinkedHashMap<>();
    //api集
    private Map<String, ApiSourceDo> apiServers = new LinkedHashMap<>();
    //lsp集
    private Map<String, LspServerDo> lspServers = new LinkedHashMap<>();

    private boolean thinkPrinted = false;
    private boolean cliPrintSimplified = true;


    //---------------

    /**
     * @deprecated 4.0.0
     *
     */
    @Deprecated
    public Map<String, String> getSkillPools() {
        return skillPools;
    }


    public List<ModelDo> getModels() {
        return models;
    }


    public boolean isAutoRethink() {
        return autoRethink;
    }

    public Integer getMaxTurns() {
        if (maxTurns == null) {
            return maxSteps;
        } else {
            return maxTurns;
        }
    }
}