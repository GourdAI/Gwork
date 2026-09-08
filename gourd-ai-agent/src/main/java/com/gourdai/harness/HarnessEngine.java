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

import com.gourdai.agent.Agent;
import com.gourdai.agent.AgentSession;
import com.gourdai.agent.AgentSessionProvider;
import com.gourdai.harness.agent.*;
import com.gourdai.agent.react.ReActAgent;
import com.gourdai.agent.react.ReActRequest;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.harness.talents.cli.*;
import org.noear.solon.ai.chat.message.AssistantMessage;
import org.noear.solon.ai.chat.message.ChatMessage;
import com.gourdai.agent.react.intercept.HITLInterceptor;
import com.gourdai.agent.react.intercept.ContextCompressionInterceptor;
import com.gourdai.agent.react.intercept.CompressionStrategy;
import com.gourdai.agent.react.intercept.StopLoopInterceptor;
import com.gourdai.agent.react.intercept.compress.UnifiedCompressionStrategy;
import org.noear.solon.ai.chat.CacheControl;
import org.noear.solon.ai.chat.ChatConfig;
import org.noear.solon.ai.chat.ChatModel;
import org.noear.solon.ai.chat.prompt.Prompt;
import com.gourdai.harness.command.CommandRegistry;
import com.gourdai.harness.hitl.HitlStrategy;
import org.noear.solon.ai.mcp.client.McpClientProvider;
import com.gourdai.harness.talents.memory.MemorySolutionProvider;
import org.noear.solon.ai.talents.mount.AgentMd;
import org.noear.solon.ai.talents.mount.MountDir;
import com.gourdai.harness.permission.ToolPermission;
import com.gourdai.harness.talents.code.CodeTalent;
import com.gourdai.harness.talents.lsp.LspManager;
import com.gourdai.harness.talents.lsp.LspServerParameters;
import com.gourdai.harness.talents.lsp.LspTalent;
import org.noear.solon.ai.mcp.client.McpServerParameters;
import com.gourdai.harness.talents.memory.MemoryTalent;
import org.noear.solon.ai.talents.mount.SkillDir;
import com.gourdai.harness.talents.gateway.openapi.ApiSource;
import com.gourdai.harness.talents.gateway.openapi.ApiSourceClient;
import com.gourdai.harness.talents.gateway.OpenApiGatewayTalent;
import com.gourdai.harness.talents.gateway.McpGatewayTalent;
import com.gourdai.harness.talents.web.CodeSearchTalent;
import com.gourdai.harness.talents.web.WebfetchTalent;
import com.gourdai.harness.talents.web.WebsearchTalent;
import org.noear.solon.core.util.Assert;
import org.noear.solon.lang.Nullable;
import org.noear.solon.lang.Preview;

import java.util.*;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 马具引擎
 *
 * @author oisin
 * @since 4.0
 */
@Preview("3.10")
public class HarnessEngine {
    public final static String ATTR_CWD = "__cwd";
    public final static String CTX_MODEL_SELECTED = "_model_selected";
    public final static String CTX_THINKING_DEPTH = "_thinking_depth";

    private final ReentrantLock agentLock = new ReentrantLock();

    private final HarnessOptions options;

    private final CodeTalent codeTalent;
    private final TodoTalent todoTalent;
    private final TaskTalent taskTalent;
    private final GenerateTalent generateTalent;

    private final ClockTalent clockTalent;

    private final WebfetchTalent webfetchTalent;
    private final WebsearchTalent websearchTalent;
    private final CodeSearchTalent codeSearchTalent;

    private final LspManager lspManager;
    private final LspTalent lspTalent;

    private final McpGatewayTalent mcpGatewayTalent;
    private final OpenApiGatewayTalent openApiGatewayTalent;

    private final MemoryTalent memoryTalent;

    private final TerminalTalent terminalTalent;
    private final SkillTalent skillTalent;

    private final CommandRegistry commandRegistry = new CommandRegistry();

    private final AgentManager agentManager;

    private volatile ReActAgent mainAgent; //允许运行时切换

    public String getName() {
        return getMainAgent().name();
    }

    public CommandRegistry getCommandRegistry() {
        return commandRegistry;
    }

    public AgentManager getAgentManager() {
        return agentManager;
    }

    public ContextCompressionInterceptor getCompressionInterceptor() {
        return options.getCompressionInterceptor();
    }

    public StopLoopInterceptor getStopLoopInterceptor() {
        return options.getStopLoopInterceptor();
    }

    public CacheControl getCacheControl() {
        return options.getCacheControl();
    }

    public HITLInterceptor getHitlInterceptor() {
        return options.getHitlInterceptor();
    }

    public TerminalTalent getTerminalTalent() {
        return terminalTalent;
    }

    public SkillTalent getSkillTalent() {
        return skillTalent;
    }

    public TodoTalent getTodoTalent() {
        return todoTalent;
    }

    public TaskTalent getTaskTalent() {
        return taskTalent;
    }

    public CodeTalent getCodeTalent() {
        return codeTalent;
    }

    public MemoryTalent getMemoryTalent() {
        return memoryTalent;
    }

    public GenerateTalent getGenerateTalent() {
        return generateTalent;
    }

    public CodeSearchTalent getCodeSearchTalent() {
        return codeSearchTalent;
    }

    public ClockTalent getClockTalent() {
        return clockTalent;
    }

    public WebsearchTalent getWebsearchTalent() {
        return websearchTalent;
    }

    public WebfetchTalent getWebfetchTalent() {
        return webfetchTalent;
    }

    public McpGatewayTalent getMcpGatewayTalent() {
        return mcpGatewayTalent;
    }

    public OpenApiGatewayTalent getOpenApiGatewayTalent() {
        return openApiGatewayTalent;
    }

    public LspTalent getLspTalent() {
        return lspTalent;
    }

    public AgentSessionProvider getSessionProvider() {
        return options.getSessionProvider();
    }

    public MemorySolutionProvider getMemoryProvider() {
        return options.getMemoryProvider();
    }

    public SkillProvider getSkillProvider() {
        return options.getSkillProvider();
    }

    // ========== 配置读取（代理到 options） ==========

    public String getHarnessHome() {
        return options.getHarnessHome();
    }

    public String getHarnessSessions() {
        return options.getHarnessSessions();
    }

    public String getHarnessSkills() {
        return options.getHarnessSkills();
    }

    public String getHarnessAgents() {
        return options.getHarnessAgents();
    }

    public String getHarnessCommands() {
        return options.getHarnessCommands();
    }

    public String getHarnessMemory() {
        return options.getHarnessMemory();
    }

    public String getHarnessDownload() {
        return options.getHarnessDownload();
    }

    public String getHarnessChannels() {
        return options.getHarnessChannels();
    }

    /**
     * 当前目录
     */
    public String getUserDir() {
        return System.getProperty("user.dir");
    }

    /**
     * 用户主目录
     */
    public String getUserHome() {
        return System.getProperty("user.home");
    }

    public String getUserAgent() {
        return options.getUserAgent();
    }

    public String getWorkspace() {
        return options.getWorkspace();
    }

    public String getSystemPrompt() {
        return options.getSystemPrompt();
    }

    public int getMaxTurns() {
        return options.getMaxTurns();
    }

    public boolean isAutoRethink() {
        return options.isAutoRethink();
    }

    public int getSessionWindowSize() {
        return options.getSessionWindowSize();
    }

    public int getCompressionMaxMessages() {
        return options.getCompressionMaxMessages();
    }

    public long getCompressionDefaultContextLength() {
        return options.getCompressionDefaultContextLength();
    }

    /** 当前实际使用的压缩回退上下文长度。 */
    public long getEffectiveCompressionDefaultContextLength() {
        ContextCompressionInterceptor interceptor = options.getCompressionInterceptor();
        return interceptor == null ? options.getCompressionDefaultContextLength() : interceptor.getDefaultContextLength();
    }

    public String getCompressionModel() {
        return options.getCompressionModel();
    }

    public boolean isMemoryEnabled() {
        return options.isMemoryEnabled();
    }

    public boolean isSandboxEnabled() {
        return options.isSandboxEnabled();
    }

    public boolean isHitlEnabled() {
        return options.isHitlEnabled();
    }

    public boolean isSubagentEnabled() {
        return options.isSubagentEnabled();
    }

    public int getApiRetries() {
        return options.getApiRetries();
    }

    public int getMcpRetries() {
        return options.getMcpRetries();
    }

    public int getModelRetries() {
        return options.getModelRetries();
    }

    public Collection<String> getTools() {
        return Collections.unmodifiableCollection(options.getTools());
    }

    public Collection<String> getDisallowedTools() {
        return Collections.unmodifiableCollection(options.getDisallowedTools());
    }

    public Collection<HarnessExtension> getExtensions() {
        return Collections.unmodifiableCollection(options.getExtensions());
    }

    public Collection<MountDir> getMounts() {
        return options.getMountManager().getMounts();
    }

    public MountDir getMount(String alias) {
        return options.getMountManager().getMount(alias);
    }

    public Collection<SkillDir> getSkills() {
        return options.getMountManager().getSkills();
    }

    public Collection<SkillDir> getSkillsByMount(String alias) {
        return options.getMountManager().getSkillsByMount(alias);
    }

    public Collection<AgentMd> getAgents() {
        return options.getMountManager().getAgents();
    }

    public Collection<AgentMd> getAgentsByMount(String alias) {
        return options.getMountManager().getAgentsByMount(alias);
    }

    public Map<String, McpServerParameters> getMcpServers() {
        return Collections.unmodifiableMap(options.getMcpServers());
    }

    public Map<String, ApiSource> getApiServers() {
        return Collections.unmodifiableMap(options.getApiServers());
    }

    public Map<String, LspServerParameters> getLspServers() {
        return Collections.unmodifiableMap(options.getLspServers());
    }

    public Collection<ChatConfig> getModels() {
        return Collections.unmodifiableCollection(options.getModels().values());
    }

    public ChatConfig getModelOrNil(String name) {
        return options.getModelOrNil(name);
    }

    public ChatConfig getModelOrDef(String name) {
        return options.getModelOrDef(name);
    }

    public String getDefaultModel() {
        return options.getDefaultModel();
    }

    // ========== 运行时动态修改 ==========

    public void setMaxTurns(Integer maxTurns) {
        if (maxTurns != null) {
            options.setMaxTurns(maxTurns);
        }
    }

    public void setModelRetries(Integer modelRetries) {
        if (modelRetries != null) {
            options.setModelRetries(modelRetries);
        }
    }

    public void setMcpRetries(Integer mcpRetries) {
        if (mcpRetries != null) {
            options.setMcpRetries(mcpRetries);
            mcpGatewayTalent.retryConfig(mcpRetries);
        }
    }

    public void setApiRetries(Integer apiRetries) {
        if (apiRetries != null) {
            options.setApiRetries(apiRetries);
            openApiGatewayTalent.retryConfig(apiRetries);
        }
    }

    public void setMemoryEnabled(Boolean memoryEnabled) {
        options.setMemoryEnabled(memoryEnabled);
        memoryTalent.setEnabled(memoryEnabled);
    }

    public void setSandboxEnabled(Boolean sandboxEnabled) {
        options.setSandboxEnabled(sandboxEnabled);
        terminalTalent.setSandboxEnabled(sandboxEnabled);
    }

    public void setSandboxAllowUserHome(Boolean sandboxAllowUserHome) {
        options.setSandboxAllowUserHome(sandboxAllowUserHome);
        terminalTalent.setSandboxAllowUserHome(sandboxAllowUserHome);
    }

    public boolean isSandboxSystemRestrict() {
        return options.isSandboxSystemRestrict();
    }

    public void setSandboxSystemRestrict(Boolean sandboxSystemRestrict) {
        options.setSandboxSystemRestrict(sandboxSystemRestrict);
        terminalTalent.setSandboxSystemRestrict(sandboxSystemRestrict);
    }

    public void setHitlEnabled(Boolean hitlEnabled) {
        options.setHitlEnabled(hitlEnabled);

        if (options.getHitlInterceptor() != null) {
            options.getHitlInterceptor().setEnabled(hitlEnabled);
        }
    }

    public void setSubagentEnabled(Boolean subagentEnabled) {
        options.setSubagentEnabled(subagentEnabled);

        generateTalent.setEnabled(options.isSubagentEnabled());
        taskTalent.setEnabled(options.isSubagentEnabled());
    }

    public void setSessionWindowSize(Integer sessionWindowSize) {
        options.setSessionWindowSize(sessionWindowSize);
    }

    public void setCompressionThreshold(Integer maxMessages) {
        if (maxMessages != null) {
            options.setCompressionMaxMessages(maxMessages);
            options.getCompressionInterceptor().setMaxMessages(maxMessages);
        }
    }

    public void setCompressionDefaultContextLength(Long defaultContextLength) {
        if (defaultContextLength != null && defaultContextLength > 0L) {
            options.setCompressionDefaultContextLength(defaultContextLength);
            options.getCompressionInterceptor().setDefaultContextLength(defaultContextLength);
        }
    }

    public void setCompressionRatio(Integer compressionRatio) {
        if (compressionRatio != null) {
            options.setCompressionRatio(compressionRatio);
            options.getCompressionInterceptor().setCompressionRatio(compressionRatio);
        }
    }

    /**
     * 设置压缩后的目标水位比例（10~95）。决定「压到多深」，与触发比例解耦。
     */
    public void setCompressionTargetRatio(Integer compressionTargetRatio) {
        if (compressionTargetRatio != null) {
            options.setCompressionTargetRatio(compressionTargetRatio);
            options.getCompressionInterceptor().setCompressionTargetRatio(options.getCompressionTargetRatio());
        }
    }

    public int getCompressionTargetRatio() {
        return options.getCompressionTargetRatio();
    }

    /** 设置为模型单轮输出预留的 token 数（绝对量）。 */
    public void setCompressionReservedOutputTokens(Integer value) {
        if (value != null) {
            options.setCompressionReservedOutputTokens(value);
            options.getCompressionInterceptor().setReservedOutputTokens(options.getCompressionReservedOutputTokens());
        }
    }

    public int getCompressionReservedOutputTokens() {
        return options.getCompressionReservedOutputTokens();
    }

    /** 启用/关闭会话意图链（防多轮对话意图漂移）。 */
    public void setIntentChainEnabled(Boolean value) {
        if (value != null) {
            options.setIntentChainEnabled(value);
            options.getCompressionInterceptor().setIntentChainEnabled(options.isIntentChainEnabled());
        }
    }

    public boolean isIntentChainEnabled() {
        return options.isIntentChainEnabled();
    }

    public void setIntentChainMaxTokens(Integer value) {
        if (value != null) {
            options.setIntentChainMaxTokens(value);
            options.getCompressionInterceptor().setIntentChainMaxTokens(options.getIntentChainMaxTokens());
        }
    }

    public int getIntentChainMaxTokens() {
        return options.getIntentChainMaxTokens();
    }

    // ========== 手动压缩（/compact） ==========

    /**
     * 请求在下一轮推理开始时强制执行一次压缩（无视阈值）。
     *
     * <p>自动压缩只在触达阈值时发生，但用户往往比阈值更早知道
     * 「前面那一大段探索已经没用了」。</p>
     */
    public void requestCompact() {
        options.getCompressionInterceptor().requestCompact();
    }

    /** 设置下一次压缩的 focus 指令（透传给摘要模型）。 */
    public void setCompactFocus(String focus) {
        options.getCompressionInterceptor().setCompactFocus(focus);
    }

    public void setSystemPrompt(String systemPrompt) {
        if (Assert.isNotEmpty(systemPrompt)) {
            options.setSystemPrompt(systemPrompt);
        }
    }

    public void setCacheControl(CacheControl cacheControl) {
        if (cacheControl != null) {
            options.setCacheControl(cacheControl);
        }
    }

    // ========== 动态模型管理 ==========

    public void setDefaultModel(String defaultModel) {
        String oldDefault = options.getDefaultModel();
        options.setDefaultModel(defaultModel);

        if (mainAgent != null
                && !defaultModel.equals(oldDefault)
                && (oldDefault == null || oldDefault.equals(mainAgent.getModel().getNameOrModel()))) {
            refreshMainAgent();
        }
    }

    public void addModel(ChatConfig config) {
        if (Assert.isEmpty(config.getUserAgent())) {
            config.setUserAgent(options.getUserAgent());
        }

        options.addModel(config);

        if (mainAgent != null && mainAgent.getModel().getNameOrModel().equals(config.getNameOrModel())) {
            refreshMainAgent();
        }
    }

    public void removeModel(String name) {
        options.removeModel(name);

        if (mainAgent != null && mainAgent.getModel().getNameOrModel().equals(name)) {
            refreshMainAgent();
        }
    }

    public boolean hasModel(String name) {
        return options.hasModel(name);
    }

    /**
     * 动态授权一个工具（允许使用）
     */
    public void allowTool(String toolName) {
        if (Assert.isEmpty(toolName)) {
            return;
        }

        options.getDisallowedTools().remove(toolName);
        options.getTools().add(toolName);

        // 权限变更需要重建 Agent 以重新生成工具集
        agentLock.lock();
        try {
            if (this.mainAgent != null) {
                this.mainAgent = createMainAgent();
            }
        } finally {
            agentLock.unlock();
        }
    }

    public void allowToolReset(Collection<String> tools) {
        options.getTools().clear();
        if (tools != null) {
            options.getTools().addAll(tools);
        }

        // 权限变更需要重建 Agent 以重新生成工具集
        agentLock.lock();
        try {
            if (this.mainAgent != null) {
                this.mainAgent = createMainAgent();
            }
        } finally {
            agentLock.unlock();
        }
    }

    /**
     * 动态撤销一个工具的权限（禁用）
     */
    public void disallowTool(String toolName) {
        if (Assert.isEmpty(toolName)) {
            return;
        }

        options.getTools().remove(toolName);
        options.getDisallowedTools().add(toolName);

        agentLock.lock();
        try {
            if (this.mainAgent != null) {
                this.mainAgent = createMainAgent();
            }
        } finally {
            agentLock.unlock();
        }
    }

    public void disallowToolReset(Collection<String> disallowedTools) {
        options.getDisallowedTools().clear();
        if (disallowedTools != null) {
            options.getDisallowedTools().addAll(disallowedTools);
        }

        // 权限变更需要重建 Agent 以重新生成工具集
        agentLock.lock();
        try {
            if (this.mainAgent != null) {
                this.mainAgent = createMainAgent();
            }
        } finally {
            agentLock.unlock();
        }
    }


    public void addMount(MountDir mount) {
        options.getMountManager().register(mount);
    }

    public void removeMount(String alias) {
        String key = alias.startsWith("@") ? alias : "@" + alias;
        agentManager.removeByMountAlias(key);
        options.getMountManager().remove(alias);
    }

    public boolean hasMount(String alias) {
        return options.getMountManager().hasMount(alias);
    }

    public void refreshMount(@Nullable String alias) {
        if (alias != null) {
            String key = alias.startsWith("@") ? alias : "@" + alias;
            agentManager.removeByMountAlias(key);
        } else {
            agentManager.clearCustomAgents();
        }
        options.getMountManager().refresh(alias);
    }


    /**
     * 动态添加 API 源
     */
    public void addApiServer(ApiSource apiSource) {
        openApiGatewayTalent.addApi(apiSource);
        options.getApiServers().put(apiSource.getDocUrl(), apiSource);
    }

    /**
     * 获取指定 docUrl 的 ApiSourceClient
     */
    public ApiSourceClient getApiServer(String docUrl) {
        return openApiGatewayTalent.getApiSource(docUrl);
    }

    /**
     * 刷新指定 API 源（权限变更后）
     */
    public void refreshApiServer(String docUrl) {
        openApiGatewayTalent.refreshApi(docUrl);
    }

    /**
     * 动态移除 API 源
     */
    public void removeApiServer(String docUrl) {
        openApiGatewayTalent.removeApi(docUrl);
        options.getApiServers().remove(docUrl);
    }

    /**
     * 动态添加 MCP 服务
     */
    public void addMcpServer(String name, McpServerParameters mcpServer) {
        mcpGatewayTalent.addMcpServer(name, mcpServer);
        options.getMcpServers().put(name, mcpServer);
    }

    public McpClientProvider getMcpServer(String name) {
        return mcpGatewayTalent.getMcpServer(name);
    }

    public void refreshMcpServer(String name) {
        mcpGatewayTalent.refreshMcpServer(name);
    }

    /**
     * 动态移除 MCP 服务（并关闭连接）
     */
    public void removeMcpServer(String name) {
        mcpGatewayTalent.removeMcpServer(name);
        options.getMcpServers().remove(name);
    }

    /**
     * 动态添加一个 LSP 服务器
     */
    public void addLspServer(String name, LspServerParameters lspServer) {
        if (lspServer == null) {
            return;
        }

        // 将配置同步到 options 中，以便后续快照使用
        options.getLspServers().put(name, lspServer);
        // 让 LspManager 运行时加载该服务器
        lspManager.registerServer(name, lspServer);

        // LSP 工具的增减会影响 Agent 的可用工具集，需重建 Agent
        agentLock.lock();
        try {
            if (this.mainAgent != null) {
                this.mainAgent = createMainAgent();
            }
        } finally {
            agentLock.unlock();
        }
    }

    /**
     * 动态移除一个 LSP 服务器
     */
    public void removeLspServer(String name) {
        if (name == null) {
            return;
        }

        options.getLspServers().remove(name);
        lspManager.unregisterServer(name);

        agentLock.lock();
        try {
            if (this.mainAgent != null) {
                this.mainAgent = createMainAgent();
            }
        } finally {
            agentLock.unlock();
        }
    }


    public void addExtension(HarnessExtension extension) {
        if (extension == null) {
            return;
        }
        options.getExtensions().add(extension);

        agentLock.lock();
        try {
            if (this.mainAgent != null) {
                this.mainAgent = createMainAgent();
            }
        } finally {
            agentLock.unlock();
        }
    }

    /**
     * 动态移除一个扩展
     */
    public void removeExtension(HarnessExtension extension) {
        if (extension == null) {
            return;
        }
        options.getExtensions().remove(extension);

        // 重建 mainAgent 以应用变更，使用 agentLock 保证线程安全
        agentLock.lock();
        try {
            if (this.mainAgent != null) {
                this.mainAgent = createMainAgent();
            }
        } finally {
            agentLock.unlock();
        }
    }


    private HarnessEngine(HarnessOptions options) {
        this.options = options;

        //上下文压缩拦截器默认处理
        if (options.getCompressionInterceptor() == null) {
            // 单次 LLM 调用完成「关键信息提取 + 滚动摘要 + 防意图漂移」。
            // 旧装配 Composite(KeyInfo + Hierarchical) 会把同一段历史独立发给 LLM 两次，
            // 输入 token 与调用次数均翻倍；两者职责可在一个 prompt 内用分段完成。
            CompressionStrategy strategy = new UnifiedCompressionStrategy();

            options.setCompressionInterceptor(new ContextCompressionInterceptor(
                    options.getCompressionMaxMessages(),
                    () -> getModelOrMain(options.getCompressionModel()),
                    strategy));
        }
        // 无论默认或自定义实例，HarnessOptions 都是运行时配置真源。
        options.getCompressionInterceptor().setMaxMessages(options.getCompressionMaxMessages());
        options.getCompressionInterceptor().setMaxRetries(options.getModelRetries());
        options.getCompressionInterceptor().setDefaultContextLength(options.getCompressionDefaultContextLength());
        options.getCompressionInterceptor().setCompressionRatio(options.getCompressionRatio());
        options.getCompressionInterceptor().setCompressionTargetRatio(options.getCompressionTargetRatio());
        options.getCompressionInterceptor().setReservedOutputTokens(options.getCompressionReservedOutputTokens());
        options.getCompressionInterceptor().setIntentChainEnabled(options.isIntentChainEnabled());
        options.getCompressionInterceptor().setIntentChainMaxTokens(options.getIntentChainMaxTokens());

        //停止循环拦截器默认处理
        if (options.getStopLoopInterceptor() == null) {
            options.setStopLoopInterceptor(new StopLoopInterceptor(3, 8));
        }

        //人工介入拉截器默认处理
        if (options.getHitlInterceptor() == null) {
            options.setHitlInterceptor(new HITLInterceptor().onTool("bash", new HitlStrategy()));
        }

        this.todoTalent = new TodoTalent(options.getHarnessSessions());
        this.codeTalent = new CodeTalent(options.getWorkspace(), options.getHarnessHome());
        this.taskTalent = new TaskTalent(this);
        this.generateTalent = new GenerateTalent(this);

        this.clockTalent = new ClockTalent();

        this.codeSearchTalent = new CodeSearchTalent().retryConfig(options.getMcpRetries());
        this.websearchTalent = new WebsearchTalent().retryConfig(options.getMcpRetries());
        this.webfetchTalent = new WebfetchTalent().retryConfig(options.getApiRetries());

        //lsp
        this.lspManager = new LspManager(options.getWorkspace());
        if (Assert.isNotEmpty(options.getLspServers())) {
            for (Map.Entry<String, LspServerParameters> entry : options.getLspServers().entrySet()) {
                lspManager.registerServer(entry.getKey(), entry.getValue());
            }
        }
        this.lspTalent = new LspTalent(lspManager, options.getWorkspace());
        this.lspManager.setDiagnosticsCallback(lspTalent::updateDiagnostics);

        if (options.getMemoryProvider() != null) {
            this.memoryTalent = new MemoryTalent(options.getMemoryProvider()).sessionIsolation(false);
            this.memoryTalent.setEnabled(options.isMemoryEnabled());
        } else {
            this.memoryTalent = null;
        }

        openApiGatewayTalent = new OpenApiGatewayTalent().retryConfig(options.getApiRetries());
        if (Assert.isNotEmpty(options.getApiServers())) {
            for (Map.Entry<String, ApiSource> entry : options.getApiServers().entrySet()) {
                openApiGatewayTalent.addApi(entry.getValue());
            }
        }

        mcpGatewayTalent = new McpGatewayTalent().retryConfig(options.getMcpRetries());

        if (Assert.isNotEmpty(options.getMcpServers())) {
            for (Map.Entry<String, McpServerParameters> entry : options.getMcpServers().entrySet()) {
                if (entry.getValue().isEnabled()) {
                    mcpGatewayTalent.addMcpServer(entry.getKey(), entry.getValue());
                }
            }
        }

        terminalTalent = new TerminalTalent(options.getMountManager());

        if (options.getSkillProvider() == null) {
            skillTalent = new SkillTalent(options.getMountManager());
        } else {
            skillTalent = new SkillTalent(options.getSkillProvider());
        }

        agentManager = new AgentManager(options.getMountManager());

        terminalTalent.setSandboxEnabled(options.isSandboxEnabled());
        terminalTalent.setSandboxAllowUserHome(options.isSandboxAllowUserHome());
        terminalTalent.setSandboxSystemRestrict(options.isSandboxSystemRestrict());

        //mainAgent = createMainAgent(); //改为懒加载
    }

    protected ReActAgent createMainAgent() {
        AgentDefinition agentDefinition = new AgentDefinition();

        // 系统提示词
        agentDefinition.setSystemPrompt(options.getSystemPrompt());
        // 名字
        agentDefinition.getMetadata().setName(AgentDefinition.AGENT_MAIN);
        // 主代理
        agentDefinition.getMetadata().setPrimary(true);
        // 工具权限
        agentDefinition.getMetadata().getTools().addAll(options.getTools()); //允许

        ReActAgent.Builder agentBuilder = AgentFactory.create(this, agentDefinition, null);

        return agentBuilder.build();
    }


    public AgentSession getSession(String instanceId) {
        return options.getSessionProvider().getSession(instanceId);
    }

    /**
     * 移除（驱逐）指定实例的会话缓存。
     *
     * <p>会话被删除时调用，切断内存中会话对落盘文件的重建源。</p>
     *
     * @param instanceId 会话实例标识
     */
    public void removeSession(String instanceId) {
        options.getSessionProvider().removeSession(instanceId);
    }

    public ReActAgent.Builder createSubagent(AgentDefinition definition) {
        return AgentFactory.create(this, definition, null);
    }

    public ChatModel getMainModel() {
        return getMainAgent().getModel();
    }

    public ReActAgent getMainAgent() {
        ReActAgent agent = this.mainAgent; // 引入局部变量，仅执行一次 volatile read
        if (agent == null) {
            agentLock.lock();
            try {
                if (this.mainAgent == null) {
                    this.mainAgent = createMainAgent();
                }
                agent = this.mainAgent;
            } finally {
                agentLock.unlock();
            }
        }

        return agent;
    }

    /**
     * 刷新主代理
     */
    public void refreshMainAgent() {
        agentLock.lock();
        try {
            this.mainAgent = null;
        } finally {
            agentLock.unlock();
        }
    }

    public ChatModel getModelOrMain(String modelName) {
        ChatConfig config = getModelOrDef(modelName);
        if (config == null) {
            return null;
        } else {
            return config.toChatModel();
        }
    }

    public ReActAgent getAgentOrMain(String agentName) {
        if (Assert.isEmpty(agentName)) {
            return getMainAgent();
        } else if (agentManager.hasAgent(agentName)) {
            AgentDefinition definition = agentManager.getAgent(agentName);
            return AgentFactory.create(this, definition, null).build();
        } else {
            return getMainAgent();
        }
    }

    // ========== 中断续跑（断点续传）==========

    /**
     * 解析指定会话中某个 agent 的执行痕迹（trace）。
     *
     * <p>trace 存放在会话的 FlowContext 里，key 为 {@code "__" + agentName}（见 ReActAgentConfig.getTraceKey，
     * 主 agent 名为 {@link AgentDefinition#AGENT_MAIN}）。这里直接推导 traceKey，避免为读一个字符串而全量构建子 agent；
     * 也避免了 getAgentOrMain 在 agent 不存在时静默回退主 agent、导致误取主 agent trace 的问题——
     * 名字不存在时得到的是该名字自己的 key，getAs 返回 null，不会错误命中主 agent 的中断任务。</p>
     *
     * @param session   会话
     * @param agentName 指定 agent 名（为空则主 agent）
     * @return 对应 trace；无则 null
     */
    public ReActTrace resolveTrace(AgentSession session, String agentName) {
        if (session == null) {
            return null;
        }
        String name = Assert.isEmpty(agentName) ? AgentDefinition.AGENT_MAIN : agentName;
        return session.getContext().getAs("__" + name);
    }

    /**
     * 判断某会话上一次任务是否「异常中断、可续跑」。
     *
     * <p>依据持久化且语义精确的信号：trace 路由停在 END 且被标记为 abnormal。
     * abnormal 由库在模型调用失败/超时/达到最大回合时置位（{@code setFinalAnswer(msg)} 单参重载），
     * 正常完成则为 false。该状态随快照落盘，进程重启后仍可判定。</p>
     */
    public boolean canResume(ReActTrace trace) {
        return trace != null
                && Agent.ID_END.equals(trace.getRoute())
                && trace.isAbnormal();
    }

    /**
     * 便捷重载：直接按会话 + agent 名判断是否可续跑。
     */
    public boolean canResume(AgentSession session, String agentName) {
        return canResume(resolveTrace(session, agentName));
    }

    /**
     * 判断某会话是否存在「已结束、可从结束点继续」的任务。
     *
     * <p>比 {@link #canResume(ReActTrace)} 宽松：只要求路由停在 END，不要求 abnormal。
     * 用于用户显式点击「继续运行」({@code /continue})——即便上次是正常完成，
     * 也允许让 agent 接着结论再推进一轮。自动续跑请用严格的 canResume。</p>
     */
    public boolean canContinue(ReActTrace trace) {
        return trace != null && Agent.ID_END.equals(trace.getRoute());
    }

    /**
     * 为「中断续跑」做准备：在保留已有工作记忆（推理 + 工具执行结果）的前提下，
     * 把用户的新输入追加进去，并让 agent 从中断点继续，而不是 reset 从头重跑。
     *
     * <p>是否移除工作记忆/历史里最后一条 Assistant 消息由 {@code removeLastAnswer} 决定：
     * 异常中断续跑传 true（那条是"抱歉，暂时无法使用模型服务…"失败兜底，需重新生成）；
     * 正常完成后的显式继续传 false（那条是真实的最终答复，必须保留，否则会丢结论/损坏历史）。</p>
     *
     * <p>调用方随后应以「空 Prompt」发起任务（{@code Prompt.of()}），触发库的恢复分支复用工作记忆。</p>
     *
     * @param trace           已确认可续跑的 trace（canResume/canContinue 为 true）
     * @param session         会话
     * @param newUserInput    用户新输入（可为空——纯"继续"语义；非空则作为新指令追加）
     * @param removeLastAnswer 是否移除最后一条 Assistant 消息（异常兜底=true，正常答复=false）
     */
    public void prepareResume(ReActTrace trace, AgentSession session, String newUserInput, boolean removeLastAnswer) {
        prepareResume(trace, session, newUserInput, removeLastAnswer, null);
    }

    /**
     * 同 {@link #prepareResume(ReActTrace, AgentSession, String, boolean)}，另接受工作目录参数。
     *
     * @param cwd 会话工作目录（用于定位 TODO.md）。传 null 时依次回退会话属性 ATTR_CWD、工作区根目录。
     */
    public void prepareResume(ReActTrace trace, AgentSession session, String newUserInput, boolean removeLastAnswer, String cwd) {
        // ① 回到思考节点，清掉最终答案标记并复位 abnormal
        trace.setRoute(ReActAgent.ID_REASON);
        trace.setFinalAnswer(null, false);

        // ② 仅在异常兜底场景移除最后一条 Assistant 消息（正常完成的真实答复要保留）
        if (removeLastAnswer) {
            ChatMessage lastWorking = trace.getWorkingMemory().getLastMessage();
            if (lastWorking instanceof AssistantMessage) {
                trace.getWorkingMemory().removeLastMessage();
            }

            List<ChatMessage> history = session.getMessages();
            if (Assert.isNotEmpty(history)
                    && history.get(history.size() - 1) instanceof AssistantMessage) {
                session.removeLatestMessage(1);
            }
        }

        // ③ 把用户新输入作为新指令追加（库的恢复分支不会自动带上新消息）
        if (Assert.isNotEmpty(newUserInput)) {
            ChatMessage userMsg = ChatMessage.ofUser(newUserInput);
            trace.getWorkingMemory().addMessage(userMsg);
            session.addMessage(userMsg);
        }

        // ③.5 恢复校准：注入 TODO.md 落盘真实状态。中断时刻模型可能未及时 todowrite，
        //     落盘状态会滞后于实际执行进度；若按记忆或陈旧清单盲目重跑，会重复执行已完成的
        //     步骤。此处物理注入清单快照并要求先核对历史 Observation 再行动（仅异常中断时）。
        if (removeLastAnswer) {
            injectTodoCalibration(session, trace, cwd);
        }

        // ④ 落盘
        session.updateSnapshot();
    }

    /**
     * 恢复续跑前，读取 TODO.md 落盘清单并注入校准消息，防止盲目重复执行已完成的步骤。
     *
     * <p>清单路径与 TodoTalent 落盘规则保持一致：{@code <cwd>/<harnessSessions>/<sessionId>/TODO.md}。
     * 工作目录优先取入参，其次会话属性 ATTR_CWD（与 WebGate/WsGate 取 cwd 的口径一致），
     * 均缺失时回退工作区根目录；异常只记日志，绝不影响恢复主流程。</p>
     */
    private void injectTodoCalibration(AgentSession session, ReActTrace trace, String cwd) {
        try {
            String sessionId = session.getSessionId();

            if (Assert.isEmpty(cwd)) {
                Object cwdAttr = session.attrs().get(ATTR_CWD);
                cwd = cwdAttr != null ? cwdAttr.toString() : null;
            }
            if (Assert.isEmpty(cwd)) {
                cwd = getWorkspace();
            }
            if (Assert.isEmpty(cwd)) {
                return;
            }

            String content = todoTalent.readTodoContentOrNil(cwd, sessionId);
            if (content == null) {
                return;
            }

            String calibration = TodoTalent.buildResumeCalibration(content);
            if (calibration == null) {
                return;
            }

            trace.getWorkingMemory().addMessage(ChatMessage.ofUser(calibration));
        } catch (Throwable e) {
            org.slf4j.LoggerFactory.getLogger(HarnessEngine.class)
                    .warn("TODO 恢复校准注入失败（已忽略）: {}", e.getMessage());
        }
    }

    private ReActRequest promptDo(Prompt prompt) {
        return getMainAgent()
                .prompt(prompt)
                .options(o -> {
                    o.retryConfig(options.getModelRetries());
                    o.maxTurns(options.getMaxTurns());
                    o.sessionWindowSize(options.getSessionWindowSize());
                });
    }

    public ReActRequest prompt(Prompt prompt) {
        return promptDo(prompt);
    }


    public ReActRequest prompt(String prompt) {
        return promptDo(Prompt.of(prompt));
    }


    public ReActRequest prompt() {
        return promptDo(null);
    }


    public static Builder of(String workspace, String harnessHome) {
        return new Builder(workspace, harnessHome);
    }

    public static class Builder {
        private final HarnessOptions options;

        public Builder(String workspace, String harnessHome) {
            this.options = new HarnessOptions(workspace, harnessHome);
        }

        // ========== 服务注入（代理到 options） ==========

        public Builder sessionProvider(AgentSessionProvider sessionProvider) {
            options.setSessionProvider(sessionProvider);
            return this;
        }

        /**
         * 人工介入拦截器
         */
        public Builder hitlInterceptor(HITLInterceptor hitlInterceptor) {
            options.setHitlInterceptor(hitlInterceptor);
            return this;
        }

        /**
         * 心智记忆存储方案
         */
        public Builder memoryProvider(MemorySolutionProvider memoryProvider) {
            options.setMemoryProvider(memoryProvider);
            return this;
        }

        /**
         * 技能提供者（如果需要对接数据库，通过此接口适配）
         */
        public Builder skillProvider(SkillProvider skillProvider) {
            options.setSkillProvider(skillProvider);
            return this;
        }

        // ========== 简单属性配置（代理到 options） ==========

        public Builder systemPrompt(String systemPrompt) {
            options.setSystemPrompt(systemPrompt);
            return this;
        }

        public Builder userAgent(String userAgent) {
            options.setUserAgent(userAgent);
            return this;
        }

        public Builder maxTurns(Integer maxTurns) {
            options.setMaxTurns(maxTurns);
            return this;
        }

        public Builder autoRethink(Boolean autoRethink) {
            options.setAutoRethink(autoRethink);
            return this;
        }

        public Builder sessionWindowSize(Integer sessionWindowSize) {
            options.setSessionWindowSize(sessionWindowSize);
            return this;
        }

        public Builder compressionThreshold(Integer maxMessages) {
            options.setCompressionMaxMessages(maxMessages);
            return this;
        }

        public Builder compressionDefaultContextLength(Long defaultContextLength) {
            options.setCompressionDefaultContextLength(defaultContextLength);
            return this;
        }

        public Builder compressionRatio(Integer compressionRatio) {
            options.setCompressionRatio(compressionRatio);
            return this;
        }

        public Builder compressionTargetRatio(Integer compressionTargetRatio) {
            options.setCompressionTargetRatio(compressionTargetRatio);
            return this;
        }

        public Builder compressionReservedOutputTokens(Integer value) {
            options.setCompressionReservedOutputTokens(value);
            return this;
        }

        public Builder intentChainEnabled(Boolean value) {
            options.setIntentChainEnabled(value);
            return this;
        }

        public Builder intentChainMaxTokens(Integer value) {
            options.setIntentChainMaxTokens(value);
            return this;
        }

        public Builder compressionModel(String compressionModel) {
            options.setCompressionModel(compressionModel);
            return this;
        }

        public Builder compressionInterceptor(ContextCompressionInterceptor compressionInterceptor) {
            options.setCompressionInterceptor(compressionInterceptor);
            return this;
        }

        public Builder stopLoopInterceptor(StopLoopInterceptor stopLoopInterceptor) {
            options.setStopLoopInterceptor(stopLoopInterceptor);
            return this;
        }

        public Builder cacheControl(CacheControl cacheControl) {
            options.setCacheControl(cacheControl);
            return this;
        }

        public Builder memoryEnabled(Boolean memoryEnabled) {
            options.setMemoryEnabled(memoryEnabled);
            return this;
        }

        public Builder sandboxEnabled(Boolean sandboxEnabled) {
            options.setSandboxEnabled(sandboxEnabled);
            return this;
        }

        public Builder sandboxAllowUserHome(Boolean sandboxAllowUserHome) {
            options.setSandboxAllowUserHome(sandboxAllowUserHome);
            return this;
        }

        public Builder sandboxSystemRestrict(Boolean sandboxSystemRestrict) {
            options.setSandboxSystemRestrict(sandboxSystemRestrict);
            return this;
        }

        public Builder hitlEnabled(Boolean hitlEnabled) {
            options.setHitlEnabled(hitlEnabled);
            return this;
        }

        public Builder subagentEnabled(Boolean subagentEnabled) {
            options.setSubagentEnabled(subagentEnabled);
            return this;
        }

        public Builder apiRetries(Integer apiRetries) {
            options.setApiRetries(apiRetries);
            return this;
        }

        public Builder mcpRetries(Integer mcpRetries) {
            options.setMcpRetries(mcpRetries);
            return this;
        }

        public Builder modelRetries(Integer modelRetries) {
            options.setModelRetries(modelRetries);
            return this;
        }

        // ========== 集合类配置（代理到 options） ==========

        public Builder toolsAdd(ToolPermission... val) {
            options.addTools(val);
            return this;
        }

        public Builder toolsAdd(Collection<String> tools) {
            options.getTools().addAll(tools);
            return this;
        }

        public Builder disallowedToolsAdd(ToolPermission... val) {
            options.addDisallowedTools(val);
            return this;
        }

        public Builder disallowedToolsAdd(Collection<String> tools) {
            options.getDisallowedTools().addAll(tools);
            return this;
        }

        public Builder extensionAdd(HarnessExtension val) {
            options.getExtensions().add(val);
            return this;
        }

        public Builder modelAdd(ChatConfig val) {
            options.addModel(val);
            return this;
        }

        public Builder modelAdd(Iterable<ChatConfig> models) {
            for (ChatConfig val : models) {
                options.getModels().put(val.getNameOrModel(), val); //build 时再加 ua
            }
            return this;
        }

        public Builder mountAdd(MountDir mount) {
            options.getMountManager().register(mount);
            return this;
        }

        public Builder mcpServerAdd(String name, McpServerParameters params) {
            options.getMcpServers().put(name, params);
            return this;
        }

        public Builder apiServerAdd(String name, ApiSource source) {
            options.getApiServers().put(name, source);
            return this;
        }

        public Builder lspServerAdd(String name, LspServerParameters lspServer) {
            options.getLspServers().put(name, lspServer);
            return this;
        }

        public Builder defaultModel(String defaultModel) {
            options.setDefaultModel(defaultModel);
            return this;
        }

        public HarnessEngine build() {
            Objects.nonNull(options.getSessionProvider());

            //缺省 userAgent 补尝
            if (Assert.isNotEmpty(options.getUserAgent())) {
                for (ChatConfig m1 : options.getModels().values()) {
                    if (Assert.isEmpty(m1.getUserAgent())) {
                        m1.setUserAgent(options.getUserAgent());
                    }
                }
            }

            return new HarnessEngine(options);
        }
    }
}