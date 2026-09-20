/*
 * Copyright 2017-2025 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.harness;

import com.gourdai.agent.AgentSessionProvider;
import com.gourdai.agent.react.intercept.AskUserInterceptor;
import com.gourdai.agent.react.intercept.HITLInterceptor;
import com.gourdai.agent.react.intercept.ContextCompressionInterceptor;
import com.gourdai.agent.react.intercept.StopLoopInterceptor;
import com.gourdai.ai.chat.CacheControl;
import com.gourdai.ai.chat.ChatConfig;
import com.gourdai.harness.permission.ToolPermission;
import com.gourdai.ai.mcp.client.McpServerParameters;
import com.gourdai.harness.talents.cli.SkillProvider;
import com.gourdai.harness.talents.lsp.LspServerParameters;
import com.gourdai.harness.talents.memory.MemorySolutionProvider;
import com.gourdai.ai.talents.mount.MountManager;
import com.gourdai.harness.talents.gateway.openapi.ApiSource;
import org.noear.solon.core.util.Assert;
import org.noear.solon.lang.Preview;

import java.io.Serializable;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CopyOnWriteArraySet;

/**
 * 马具运行时配置（内部使用）
 *
 * @author oisin
 * @since 4.0.0
 */
@Preview("4.0")
class HarnessOptions implements Serializable {

    // ========== 基础路径 ==========
    private final String harnessHome;
    private volatile String workspace = "work";

    // ========== 提示词 ==========
    private volatile String systemPrompt;
    private volatile String userAgent;

    // ========== 主代理工具权限 ==========
    private Set<String> tools = new CopyOnWriteArraySet<>();

    // 禁用工具（全局）
    private Set<String> disallowedTools = new CopyOnWriteArraySet<>();

    // ========== 执行控制 ==========
    private volatile int maxTurns = 20;
    private volatile boolean autoRethink = true;

    // ========== 会话与压缩 ==========
    // 历史窗口大小：与上下文窗口无关，压缩时始终保护最后 N 条消息完整不压缩。
    private volatile int sessionWindowSize = 8;
    private volatile int compressionMaxMessages = 30;
    // 压缩触发比例（1~100）：作为「提前触发」的上限钳制器，与绝对阈值取 min。
    // 100 = 不额外提前，完全由「窗口 − 输出预留 − 回合缓冲」决定。
    private volatile int compressionRatio = 100;
    // 压缩后的目标水位比例（决定「压到多深」）
    private volatile int compressionTargetRatio = 45;
    // 为模型单轮输出预留的 token（绝对量）
    private volatile int compressionReservedOutputTokens = 20_000;
    // 会话意图链（防多轮对话意图漂移）
    private volatile boolean intentChainEnabled = true;
    private volatile int intentChainMaxTokens = 2_000;
    private volatile String compressionModel; //压缩大模型

    // ========== 记忆 ==========
    private volatile boolean memoryEnabled = true;

    // ========== 安全与模式 ==========
    private volatile boolean sandboxEnabled = true;
    private volatile boolean sandboxAllowUserHome = true;
    private volatile boolean sandboxSystemRestrict = true;

    private volatile boolean hitlEnabled = false;
    private volatile boolean subagentEnabled = true;

    // ========== 重试配置 ==========
    private volatile int apiRetries = 3;
    private volatile int mcpRetries = 3;
    private volatile int modelRetries = 3;

    // ========== 缓存控制 ==========
    private volatile CacheControl cacheControl;

    // ========== 集合类配置 ==========
    private final MountManager mountManager;
    private volatile String defaultModel;
    private final Map<String, ChatConfig> models = new ConcurrentHashMap<>();
    private final Map<String, McpServerParameters> mcpServers = new ConcurrentHashMap<>();
    private final Map<String, ApiSource> apiServers = new ConcurrentHashMap<>();
    private final Map<String, LspServerParameters> lspServers = new ConcurrentHashMap<>();
    private final List<HarnessExtension> extensions = new CopyOnWriteArrayList<>();

    // ========== 服务注入 ==========
    private AgentSessionProvider sessionProvider;
    private ContextCompressionInterceptor compressionInterceptor;
    private StopLoopInterceptor stopLoopInterceptor;
    private HITLInterceptor hitlInterceptor;
    private AskUserInterceptor askUserInterceptor;
    private MemorySolutionProvider memoryProvider;
    private SkillProvider skillProvider;

    HarnessOptions(String workspace, String harnessHome) {
        if (Assert.isEmpty(harnessHome)) {
            harnessHome = ".solon/";
        } else if (!harnessHome.endsWith("/")) {
            harnessHome = harnessHome + "/";
        }

        this.workspace = workspace;
        this.harnessHome = harnessHome;
        this.mountManager = new MountManager(workspace);
    }

    // ========== 派生路径属性 ==========

    String getHarnessHome() {
        return harnessHome;
    }

    String getHarnessSessions() {
        return harnessHome + "sessions/";
    }

    String getHarnessSkills() {
        return harnessHome + "skills/";
    }

    String getHarnessAgents() {
        return harnessHome + "agents/";
    }

    String getHarnessCommands() {
        return harnessHome + "commands/";
    }

    String getHarnessMemory() {
        return harnessHome + "memory/";
    }

    String getHarnessDownload() {
        return harnessHome + "download/";
    }

    String getHarnessChannels() {
        return harnessHome + "channels/";
    }

    // ========== getter / setter ==========

    String getWorkspace() {
        return workspace;
    }

    String getSystemPrompt() {
        return systemPrompt;
    }

    void setSystemPrompt(String systemPrompt) {
        this.systemPrompt = systemPrompt;
    }

    String getUserAgent() {
        return userAgent;
    }

    void setUserAgent(String userAgent) {
        this.userAgent = userAgent;
    }

    Set<String> getTools() {
        return tools;
    }

    Set<String> getDisallowedTools() {
        return disallowedTools;
    }

    int getMaxTurns() {
        return maxTurns;
    }

    void setMaxTurns(Integer maxTurns) {
        if (maxTurns != null) {
            this.maxTurns = maxTurns;
        }
    }

    boolean isAutoRethink() {
        return autoRethink;
    }

    void setAutoRethink(Boolean autoRethink) {
        if (autoRethink != null) {
            this.autoRethink = autoRethink;
        }
    }

    int getSessionWindowSize() {
        return sessionWindowSize;
    }

    void setSessionWindowSize(Integer sessionWindowSize) {
        if (sessionWindowSize != null) {
            this.sessionWindowSize = sessionWindowSize;
        }
    }

    int getCompressionMaxMessages() {
        return compressionMaxMessages;
    }

    void setCompressionMaxMessages(Integer compressionMaxMessages) {
        if (compressionMaxMessages != null) {
            this.compressionMaxMessages = compressionMaxMessages;
        }
    }

    int getCompressionRatio() {
        return compressionRatio;
    }

    int getCompressionTargetRatio() {
        return compressionTargetRatio;
    }

    void setCompressionTargetRatio(Integer value) {
        if (value != null) {
            this.compressionTargetRatio = Math.min(95, Math.max(10, value));
        }
    }

    int getCompressionReservedOutputTokens() {
        return compressionReservedOutputTokens;
    }

    void setCompressionReservedOutputTokens(Integer value) {
        if (value != null) {
            this.compressionReservedOutputTokens = Math.max(1_000, value);
        }
    }

    boolean isIntentChainEnabled() {
        return intentChainEnabled;
    }

    void setIntentChainEnabled(Boolean value) {
        if (value != null) {
            this.intentChainEnabled = value;
        }
    }

    int getIntentChainMaxTokens() {
        return intentChainMaxTokens;
    }

    void setIntentChainMaxTokens(Integer value) {
        if (value != null) {
            this.intentChainMaxTokens = Math.max(200, value);
        }
    }

    /**
     * 设置压缩触发比例（1~100），超出范围将被钳制到 [1, 100]。
     * <p>注意：范围钳制与 {@link ContextCompressionInterceptor#setCompressionRatio(int)} 保持一致。</p>
     */
    void setCompressionRatio(Integer compressionRatio) {
        if (compressionRatio != null) {
            this.compressionRatio = Math.min(100, Math.max(1, compressionRatio));
        }
    }

    String getCompressionModel() {
        return compressionModel;
    }

    void setCompressionModel(String compressionModel) {
        this.compressionModel = compressionModel;
    }

    boolean isMemoryEnabled() {
        return memoryEnabled;
    }

    void setMemoryEnabled(Boolean memoryEnabled) {
        if (memoryEnabled != null) {
            this.memoryEnabled = memoryEnabled;
        }
    }

    boolean isSandboxEnabled() {
        return sandboxEnabled;
    }

    void setSandboxEnabled(Boolean sandboxEnabled) {
        if (sandboxEnabled != null) {
            this.sandboxEnabled = sandboxEnabled;
        }
    }

    boolean isSandboxAllowUserHome() {
        return sandboxAllowUserHome;
    }

    void setSandboxAllowUserHome(Boolean sandboxAllowUserHome) {
        if (sandboxAllowUserHome != null) {
            this.sandboxAllowUserHome = sandboxAllowUserHome;
        }
    }

    boolean isSandboxSystemRestrict() {
        return sandboxSystemRestrict;
    }

    void setSandboxSystemRestrict(Boolean sandboxSystemRestrict) {
        if (sandboxSystemRestrict != null) {
            this.sandboxSystemRestrict = sandboxSystemRestrict;
        }
    }

    boolean isHitlEnabled() {
        return hitlEnabled;
    }

    void setHitlEnabled(Boolean hitlEnabled) {
        if (hitlEnabled != null) {
            this.hitlEnabled = hitlEnabled;
        }
    }

    boolean isSubagentEnabled() {
        return subagentEnabled;
    }

    void setSubagentEnabled(Boolean subagentEnabled) {
        if (subagentEnabled != null) {
            this.subagentEnabled = subagentEnabled;
        }
    }

    int getApiRetries() {
        return apiRetries;
    }

    void setApiRetries(Integer apiRetries) {
        if (apiRetries != null) {
            this.apiRetries = apiRetries;
        }
    }

    int getMcpRetries() {
        return mcpRetries;
    }

    void setMcpRetries(Integer mcpRetries) {
        if (mcpRetries != null) {
            this.mcpRetries = mcpRetries;
        }
    }

    int getModelRetries() {
        return modelRetries;
    }

    void setModelRetries(Integer modelRetries) {
        if (modelRetries != null) {
            this.modelRetries = modelRetries;
        }
    }

    // ========== 缓存控制 ==========

    CacheControl getCacheControl() {
        return cacheControl;
    }

    void setCacheControl(CacheControl cacheControl) {
        this.cacheControl = cacheControl;
    }

    List<HarnessExtension> getExtensions() {
        return extensions;
    }

    Map<String, ChatConfig> getModels() {
        return models;
    }

    String getDefaultModel() {
        return defaultModel;
    }

    void setDefaultModel(String defaultModel) {
        this.defaultModel = defaultModel;
    }

    public MountManager getMountManager() {
        return mountManager;
    }

    Map<String, McpServerParameters> getMcpServers() {
        return mcpServers;
    }

    Map<String, ApiSource> getApiServers() {
        return apiServers;
    }

    Map<String, LspServerParameters> getLspServers() {
        return lspServers;
    }

    // ========== 集合操作方法 ==========

    void addTools(ToolPermission... toolPermissions) {
        for (ToolPermission p1 : toolPermissions) {
            tools.add(p1.getName());
        }
    }

    void addDisallowedTools(ToolPermission... toolPermissions) {
        for (ToolPermission p1 : toolPermissions) {
            disallowedTools.add(p1.getName());
        }
    }

    void addModel(ChatConfig chatConfig) {
        if (Assert.isEmpty(chatConfig.getUserAgent())) {
            chatConfig.setUserAgent(this.userAgent);
        }

        models.put(chatConfig.getNameOrModel(), chatConfig);
    }

    void removeModel(String modelName) {
        models.remove(modelName);
    }

    boolean hasModel(String modelName) {
        return models.containsKey(modelName);
    }

    /**
     * 判断给定模型名是否会触发「静默回退到默认模型」。
     *
     * <p>{@link #getModelOrDef(String)} 把「传空求默认」与「指定了模型却未命中/已被禁用」
     * 合并到同一条返回路径，返回值本身不携带任何信号，调用方无从区分两者——
     * 用户因此可能在毫不知情的情况下被换到 defaultModel（曾导致「明明选了 A 却跑了 B」
     * 且全程无日志可查）。此方法把后一种情况单独暴露出来，供入口层告警，
     * 而不改变 {@code getModelOrDef} 自身行为与全部既有调用点。</p>
     *
     * @param modelName 显式指定的模型名；空值表示「本就要默认模型」，不算回退
     * @return true 表示指定了模型但它不存在或已被禁用，实际会回退到默认模型
     */
    boolean isModelFallback(String modelName) {
        if (models.isEmpty() || Assert.isEmpty(modelName)) {
            return false;
        }

        ChatConfig c = models.get(modelName);
        return c == null || c.isEnabled() == false;
    }

    ChatConfig getModelOrNil(String modelName) {
        if (models.isEmpty()) {
            return null;
        }

        if (Assert.isEmpty(modelName)) {
            return getDefaultModelConfig();
        }

        ChatConfig c = models.get(modelName);
        if (c != null && c.isEnabled()) {
            return c;
        }

        return null;
    }

    ChatConfig getModelOrDef(String modelName) {
        if (models.isEmpty()) {
            return null;
        }

        if (Assert.isEmpty(modelName)) {
            return getDefaultModelConfig();
        }

        ChatConfig c = models.get(modelName);
        if (c != null && c.isEnabled()) {
            return c;
        }

        return getDefaultModelConfig();
    }

    /**
     * 获取默认模型配置：优先 defaultModel 指定的，否则取 Map 中的第一个值
     */
    private ChatConfig getDefaultModelConfig() {
        if (Assert.isNotEmpty(defaultModel)) {
            ChatConfig c = models.get(defaultModel);
            if (c != null) {
                return c;
            }
        }

        // fallback 到第一个
        return models.values().iterator().next();
    }

    // ========== 服务注入 getter / setter ==========

    AgentSessionProvider getSessionProvider() {
        return sessionProvider;
    }

    void setSessionProvider(AgentSessionProvider sessionProvider) {
        this.sessionProvider = sessionProvider;
    }

    ContextCompressionInterceptor getCompressionInterceptor() {
        return compressionInterceptor;
    }

    void setCompressionInterceptor(ContextCompressionInterceptor compressionInterceptor) {
        this.compressionInterceptor = compressionInterceptor;
    }

    StopLoopInterceptor getStopLoopInterceptor() {
        return stopLoopInterceptor;
    }

    void setStopLoopInterceptor(StopLoopInterceptor stopLoopInterceptor) {
        this.stopLoopInterceptor = stopLoopInterceptor;
    }

    HITLInterceptor getHitlInterceptor() {
        return hitlInterceptor;
    }

    void setHitlInterceptor(HITLInterceptor hitlInterceptor) {
        this.hitlInterceptor = hitlInterceptor;
    }

    AskUserInterceptor getAskUserInterceptor() {
        return askUserInterceptor;
    }

    void setAskUserInterceptor(AskUserInterceptor askUserInterceptor) {
        this.askUserInterceptor = askUserInterceptor;
    }

    MemorySolutionProvider getMemoryProvider() {
        return memoryProvider;
    }

    void setMemoryProvider(MemorySolutionProvider memoryProvider) {
        this.memoryProvider = memoryProvider;
    }

    SkillProvider getSkillProvider() {
        return skillProvider;
    }

    void setSkillProvider(SkillProvider skillProvider) {
        this.skillProvider = skillProvider;
    }
}