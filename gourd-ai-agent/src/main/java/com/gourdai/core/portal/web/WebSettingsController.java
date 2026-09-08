/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.core.portal.web;

import com.gourdai.core.channel.dingtalk.DingTalkAppRegistration;
import com.gourdai.core.channel.dingtalk.DingTalkQRBindManager;
import com.gourdai.core.channel.feishu.FeishuAppRegistration;
import com.gourdai.core.channel.feishu.FeishuQRBindManager;
import org.noear.snack4.ONode;
import org.noear.snack4.codec.TypeRef;
import org.noear.solon.core.handle.UploadedFile;

import java.nio.charset.StandardCharsets;
import org.noear.solon.ai.chat.ChatConfig;
import org.noear.solon.ai.chat.ChatModel;
import com.gourdai.harness.HarnessEngine;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.ai.mcp.McpChannel;
import org.noear.solon.ai.mcp.client.McpClientProvider;
import org.noear.solon.ai.mcp.client.McpClientProviders;
import org.noear.solon.ai.mcp.client.McpServerParameters;
import org.noear.solon.ai.talents.mount.MountDir;
import org.noear.solon.ai.talents.mount.MountType;
import org.noear.solon.ai.talents.mount.AgentMd;
import org.noear.solon.ai.talents.mount.SkillDir;
import com.gourdai.harness.talents.gateway.openapi.ApiSource;
import com.gourdai.harness.talents.gateway.openapi.ApiSourceClient;
import com.gourdai.harness.talents.gateway.openapi.ApiTool;
import org.noear.solon.ai.util.CmdUtil;
import org.noear.solon.annotation.*;
import com.gourdai.core.config.AgentFlags;
import com.gourdai.core.config.AgentProperties;
import com.gourdai.core.config.AgentSettings;
import com.gourdai.core.config.entity.GeneralGroupDo;
import com.gourdai.core.config.entity.PermissionGroupDo;
import com.gourdai.core.config.entity.ApiSourceDo;
import com.gourdai.harness.talents.lsp.LspServerParameters;
import com.gourdai.core.config.entity.LspServerDo;
import com.gourdai.core.config.entity.McpServerDo;
import com.gourdai.core.config.entity.ModelDo;
import com.gourdai.core.config.entity.MountDo;
import com.gourdai.core.config.entity.ProviderDo;
import com.gourdai.core.portal.web.model.ModelInfo;
import com.gourdai.core.portal.web.model.ModelsAdapter;
import com.gourdai.core.portal.web.model.ModelsAdapterManager;
import com.gourdai.core.portal.web.model.ModelsFetchException;
import com.gourdai.core.portal.web.model.ModelsFetchReason;
import com.gourdai.core.portal.web.market.Market;
import com.gourdai.core.portal.web.market.MarketManager;
import org.noear.solon.core.handle.Context;
import org.noear.solon.core.handle.Result;
import org.noear.solon.core.util.Assert;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.awt.*;
import java.io.File;
import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.*;
import java.util.List;

/**
 * Web 设置控制器 —— GWork Web UI 的设置管理 HTTP 入口。
 *
 * <p>职责：管理 LLM 模型配置（增删改查、导入导出）、MCP 服务器配置（增删改查、连接检测）和 OpenApi 服务器配置。</p>
 *
 * <h3>主要功能分组</h3>
 * <ul>
 *   <li><b>LLM 模型管理</b>：从远程拉取模型列表、动态添加/移除/更新模型、设置默认模型、导入导出</li>
 *   <li><b>MCP 服务器管理</b>：服务器列表查询、添加/移除/更新、启用停用、连接检测、批量导入</li>
 *   <li><b>OpenApi 服务器管理</b>：服务器列表查询、添加/移除/更新、启用停用、连接检测、批量导入</li>
 *   <li><b>技能市场</b>：通过 {@link Market} 接口代理技能浏览、搜索和安装（委派给具体适配器）</li>
 * </ul>
 *
 * <p>所有配置统一通过 {@link AgentSettings} 持久化到单一文件 {@code settings.json}。</p>
 *
 * @author oisin
 * @see WebController Web 主控制器
 * @see Market 技能市场接口
 * @see AgentSettings 统一配置管理
 */
public class WebSettingsController {
    /**
     * {@code maxTokens} 被当作上下文窗口采信的最小阈值。
     *
     * <p>多数供应商的 {@code maxTokens} 语义是「单次最大输出 token」（典型 4K~8K），
     * 而非上下文窗口。若直接写入 contextLength，会使压缩预算远小于真实窗口，
     * 导致该模型每一轮都触发压缩、反复烧摘要调用。仅当其大到不可能是纯输出
     * 上限时（≥ 32K）才视为供应商确实在用它表达窗口。</p>
     */
    private static final int MIN_TRUSTWORTHY_CONTEXT_LENGTH = 32_000;

    /**
     * 日志记录器
     */
    private static final Logger LOG = LoggerFactory.getLogger(WebSettingsController.class);

    /**
     * AI Agent 执行引擎，提供模型配置管理能力
     */
    private final HarnessEngine engine;

    /**
     * 技能市场适配器（通过构造函数注入，方便切换不同市场）
     */
    private final MarketManager marketManager;

    /**
     * 模型提供商工厂，用于拉取模型列表
     */
    private final ModelsAdapterManager modelProviderFactory;

    /**
     * 统一配置管理器，管理 LLM 模型、MCP 服务器、OpenApi 服务器的持久化数据
     */
    private final AgentSettings settings;

    /**
     * 钉钉扫码绑定管理器（单例）
     */
    private final DingTalkQRBindManager dingtalkQRManager;

    /**
     * 飞书扫码绑定管理器（单例）
     */
    private final FeishuQRBindManager feishuQRManager;

    /**
     * 构造函数：使用容器注入的 AgentSettings。
     *
     * @param engine   AI Agent 执行引擎
     * @param settings 统一配置管理器（由 App.initAgentSettings 创建并注册到容器）
     */
    public WebSettingsController(HarnessEngine engine, AgentSettings settings) {
        this(engine, settings, new MarketManager(), new ModelsAdapterManager());
    }

    /**
     * 构造函数：支持自定义 MarketManager（用于测试）。
     *
     * @param engine        AI Agent 执行引擎
     * @param settings      统一配置管理器
     * @param marketManager 技能市场管理器
     */
    public WebSettingsController(HarnessEngine engine, AgentSettings settings, MarketManager marketManager) {
        this(engine, settings, marketManager, new ModelsAdapterManager());
    }

    /**
     * 构造函数：支持自定义 MarketManager 和 ModelProviderFactory。
     *
     * @param engine              AI Agent 执行引擎
     * @param settings            统一配置管理器
     * @param marketManager       技能市场管理器
     * @param modelProviderFactory 模型提供商工厂
     */
    public WebSettingsController(HarnessEngine engine, AgentSettings settings, MarketManager marketManager, ModelsAdapterManager modelProviderFactory) {
        this.engine = engine;
        this.settings = settings;
        this.marketManager = marketManager;
        this.modelProviderFactory = modelProviderFactory;
        // 初始化扫码管理器（单例）
        this.dingtalkQRManager = new DingTalkQRBindManager();
        this.feishuQRManager = new FeishuQRBindManager();
    }

    // ==================== 配置持久化 ====================

    /**
     * 将当前配置保存到 settings.json
     */
    private void saveSettings() {
        settings.saveToFile();
    }

    // ==================== 设置：General 通用配置 ====================

    /**
     * 获取通用配置
     */
    @Get
    @Mapping("/web/settings/general")
    public Result<GeneralGroupDo> generalGet() {
        return Result.succeed(settings.getGeneral());
    }

    /**
     * 保存通用配置
     */
    @Post
    @Mapping("/web/settings/general/save")
    public Result generalSave(@Body String json) throws Exception {
        ONode tmp = ONode.ofJson(json);
        if (tmp.isObject()) {
            tmp.bindTo(settings.getGeneral());

            // 处理 webAuthUser/webAuthPass 清空：bindTo 遇到 null 值会跳过，需要手动处理。
            // 必须先 hasKey 判断，避免部分保存（如仅提交 {darkMode:true}）时误清空已有账号密码。
            if (tmp.hasKey("webAuthUser") && tmp.get("webAuthUser").isNull()) {
                settings.getGeneral().setWebAuthUser(null);
            }
            if (tmp.hasKey("webAuthPass") && tmp.get("webAuthPass").isNull()) {
                settings.getGeneral().setWebAuthPass(null);
            }

            // 对话策略两旋钮：用户清空输入框会显式提交 null，而 bindTo 跳过 null 会保留旧值。
            // 与上面账号密码同理手动处理——清空即回落到 AgentProperties 的默认值（单一真源）。
            AgentProperties defaults = new AgentProperties();
            if (tmp.hasKey("historyWindowSize") && tmp.get("historyWindowSize").isNull()) {
                settings.getGeneral().setHistoryWindowSize(defaults.getHistoryWindowSize());
            }
            if (tmp.hasKey("compressionRatio") && tmp.get("compressionRatio").isNull()) {
                settings.getGeneral().setCompressionRatio(defaults.getCompressionRatio());
            }
            if (tmp.hasKey("compressionTargetRatio") && tmp.get("compressionTargetRatio").isNull()) {
                settings.getGeneral().setCompressionTargetRatio(defaults.getCompressionTargetRatio());
            }
            if (tmp.hasKey("compressionReservedOutputTokens") && tmp.get("compressionReservedOutputTokens").isNull()) {
                settings.getGeneral().setCompressionReservedOutputTokens(defaults.getCompressionReservedOutputTokens());
            }
            if (tmp.hasKey("intentChainMaxTokens") && tmp.get("intentChainMaxTokens").isNull()) {
                settings.getGeneral().setIntentChainMaxTokens(defaults.getIntentChainMaxTokens());
            }

            engine.setCompressionThreshold(settings.getGeneral().getHistoryWindowSize());
            engine.setCompressionRatio(settings.getGeneral().getCompressionRatio());
            engine.setCompressionTargetRatio(settings.getGeneral().getCompressionTargetRatio());
            engine.setCompressionReservedOutputTokens(settings.getGeneral().getCompressionReservedOutputTokens());
            engine.setIntentChainEnabled(settings.getGeneral().getIntentChainEnabled());
            engine.setIntentChainMaxTokens(settings.getGeneral().getIntentChainMaxTokens());

            engine.setModelRetries(settings.getGeneral().getModelRetries());
            engine.setMcpRetries(settings.getGeneral().getMcpRetries());
            engine.setApiRetries(settings.getGeneral().getApiRetries());

            engine.setSandboxEnabled(settings.getGeneral().getSandboxMode());
            engine.setSandboxAllowUserHome(settings.getGeneral().getSandboxAllowUserHome());
            engine.setSandboxSystemRestrict(settings.getGeneral().getSandboxSystemRestrict());

            engine.setMemoryEnabled(settings.getGeneral().getMemoryEnabled());
            engine.setSubagentEnabled(settings.getGeneral().getSubagentEnabled());


            engine.getMcpGatewayTalent().setEnabled(settings.getGeneral().getMcpEnabled());
            engine.getOpenApiGatewayTalent().setEnabled(settings.getGeneral().getOpenApiEnabled());
            engine.getLspTalent().setEnabled(settings.getGeneral().getLspEnabled());
        }

        saveSettings();
        return Result.succeed();
    }

    // ==================== 设置：Permission 工具权限配置 ====================

    /**
     * 获取全局工具权限配置（白名单 tools / 黑名单 disallowedTools）
     */
    @Get
    @Mapping("/web/settings/permission")
    public Result<PermissionGroupDo> permissionGet() {
        return Result.succeed(settings.getPermission());
    }

    /**
     * 保存全局工具权限配置。
     * <p>tools 为允许白名单（支持通配，如 {@code **}、{@code mcp__*}），留空等价于放开全部；
     * disallowedTools 为禁用黑名单。保存后通过 engine.allowToolReset / disallowToolReset 热更新，
     * 引擎会重建主 Agent 即时生效，无需重启。</p>
     */
    @Post
    @Mapping("/web/settings/permission/save")
    public Result permissionSave(@Body String json) throws Exception {
        ONode root = ONode.ofJson(json);
        if (root.isObject() == false) {
            return Result.failure("invalid body");
        }

        List<String> disallowedTools = new ArrayList<>();
        if (root.hasKey("disallowedTools") && root.get("disallowedTools").isArray()) {
            for (ONode item : root.get("disallowedTools").getArray()) {
                String v = item.getString();
                if (Assert.isNotEmpty(v) && disallowedTools.contains(v) == false) {
                    disallowedTools.add(v.trim());
                }
            }
        }

        // 先清空再写入，避免 final List 叠加导致重复
        settings.getPermission().getDisallowedTools().clear();
        settings.getPermission().getDisallowedTools().addAll(disallowedTools);

        // 热更新到引擎（会重建主 Agent 即时生效）
        engine.disallowToolReset(settings.getPermission().getDisallowedTools());

        saveSettings();
        LOG.info("[Settings] Permission updated: disallowedTools={}", disallowedTools);
        return Result.succeed();
    }

    // ==================== 设置：LLM 模型管理 ====================

    /**
     * 获取所有模型配置列表（含启用状态，专供设置面板使用）。
     * <p>按 settings 中的配置顺序输出（与模型选择下拉一致）。</p>
     */
    @Get
    @Mapping("/web/settings/llm/models")
    public Result<Map<String, Object>> llmModelsList() {
        Map<String, Object> data = new LinkedHashMap<>();

        // 设置面板专用：返回全量模型（含被禁用的），前端据此渲染开关状态与"已同步"徽标
        List<Map> list = new ArrayList<>();
        for (ModelDo config : settings.getModels().values()) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("name", config.getNameOrModel());
            item.put("model", config.getModel());
            item.put("standard", config.getStandardOrProvider());
            item.put("apiUrl", config.getApiUrl());
            item.put("apiKey", config.getApiKey());
            item.put("contextLength", config.getContextLength());
            item.put("enabled", config.isEnabled());
            item.put("visibled", config.isVisibled());
            item.put("scope", config.getScope() != null ? config.getScope() : AgentFlags.SCOPE_USER);
            item.put("provider", config.getProvider());  // 所属供应商
            list.add(item);
        }

        // 不再按名称排序：模型顺序以 settings 配置顺序为准（与聊天/自动化模型选择器一致）

        data.put("list", list);
        data.put("default", settings.getDefaultModel());

        return Result.succeed(data);
    }

    /**
     * 获取单个模型配置详情（用于编辑/复制时填充表单）
     */
    @Get
    @Mapping("/web/settings/llm/models/get")
    public Result<Map> llmModelsGet(@Param("name") String name) throws Exception {
        if (Assert.isEmpty(name)) {
            return Result.failure("name is required");
        }

        ModelDo config = null;
        for (ModelDo c : settings.getModels().values()) {
            if (name.equals(c.getNameOrModel())) {
                config = c;
                break;
            }
        }

        if (config == null) {
            return Result.failure("Model not found: " + name);
        }

        Map<String, Object> item = new LinkedHashMap<>();
        item.put("apiUrl", config.getApiUrl());
        item.put("model", config.getModel());
        item.put("name", config.getNameOrModel());
        item.put("apiKey", config.getApiKey());
        item.put("standard", config.getStandardOrProvider());
        item.put("scope", config.getScope() != null ? config.getScope() : AgentFlags.SCOPE_USER);
        item.put("provider", config.getProvider());  // 所属供应商
        if (config.getTimeout() != null) {
            item.put("timeout", config.getTimeout().getSeconds() + "s");
        }
        if (config.getUserAgent() != null) {
            item.put("userAgent", config.getUserAgent());
        }
        if (config.getContextLength() > 0) {
            item.put("contextLength", String.valueOf(config.getContextLength()));
        }
        item.put("isDefault", settings.getDefaultModel() != null && settings.getDefaultModel().equals(config.getNameOrModel()));

        return Result.succeed(item);
    }

    /**
     * 测试模型连接 — 通过 ChatModel 发送 hello 提示语，验证连接可用性
     */
    @Post
    @Mapping("/web/settings/llm/models/fetch")
    public Result llmModelsFetch(String apiUrl, String apiKey, String standard, String model) {
        if (Assert.isEmpty(apiUrl)) {
            return Result.failure("apiUrl is required");
        }

        try {
            ChatModel chatModel = ChatModel.of(apiUrl)
                    .apiKey(apiKey)
                    .standard(standard)
                    .model(model)
                    .userAgent(settings.getGeneral().getUserAgent())
                    .build();

            chatModel.prompt("hi").call();

            return Result.succeed("连接成功：模型服务可用");
        } catch (Exception e) {
            LOG.warn("[Settings] LLM test connection failed: {}", e.getMessage());
            return Result.failure("连接失败: " + e.getMessage());
        }
    }

    /**
     * 动态添加模型配置
     */
    @Post
    @Mapping("/web/settings/llm/models/add")
    public Result llmModelsAdd(@Body ModelDo config, boolean isDefaultModel) throws Exception {
        if (Assert.isEmpty(config.getApiUrl()) || Assert.isEmpty(config.getModel())) {
            return Result.failure("apiUrl and model are required");
        }

        engine.addModel(config);

        if (isDefaultModel) {
            settings.setDefaultModel(config.getNameOrModel());
        }

        settings.getModels().put(config.getNameOrModel(), config);
        saveSettings();

        LOG.info("[Settings] Model added: {}", config.getNameOrModel());
        return Result.succeed(config.getNameOrModel());
    }

    /**
     * 动态移除模型配置
     */
    @Post
    @Mapping("/web/settings/llm/models/remove")
    public Result llmModelsRemove(@Param("name") String name) throws Exception {
        if (Assert.isEmpty(name)) {
            return Result.failure("name is required");
        }

        engine.removeModel(name);

        settings.getModels().remove(name);
        saveSettings();

        LOG.info("[Settings] Model removed: {}", name);
        return Result.succeed();
    }

    /**
     * 更新模型配置（先删后加）
     */
    @Post
    @Mapping("/web/settings/llm/models/update")
    public Result llmModelsUpdate(@Param("originalName") String originalName, @Body ModelDo config, boolean isDefaultModel) throws Exception {
        if (Assert.isEmpty(originalName)) {
            return Result.failure("originalName is required");
        }

        // 先移除旧配置
        engine.removeModel(originalName);
        engine.addModel(config);

        settings.getModels().remove(originalName);
        settings.getModels().put(config.getNameOrModel(), config);
        if (isDefaultModel) {
            settings.setDefaultModel(config.getNameOrModel());
            engine.setDefaultModel(config.getNameOrModel());
        }
        saveSettings();

        LOG.info("[Settings] Model updated: {} -> {}", originalName, config.getNameOrModel());
        return Result.succeed(config.getNameOrModel());
    }

    /**
     * 切换模型启用/禁用状态
     */
    @Post
    @Mapping("/web/settings/llm/models/toggle")
    public Result llmModelsToggle(@Param("name") String name, @Param("enabled") Boolean enabled) throws Exception {
        if (Assert.isEmpty(name) || enabled == null) {
            return Result.failure("name and enabled are required");
        }
        for (ChatConfig config : settings.getModels().values()) {
            if (name.equals(config.getNameOrModel())) {
                config.setEnabled(enabled);
                // 即时同步运行时引擎（isEnabled 已综合 visibled，禁用即从引擎移除）
                if (config.isEnabled()) {
                    engine.addModel(config);
                } else {
                    engine.removeModel(name);
                }
                saveSettings();
                LOG.info("[Settings] Model {} {}", name, enabled ? "enabled" : "disabled");
                return Result.succeed();
            }
        }
        return Result.failure("Model not found: " + name);
    }

    // ==================== 设置：MCP 服务器管理 ====================

    /**
     * 获取已配置的 MCP 服务器列表
     */
    @Get
    @Mapping("/web/settings/mcp/servers")
    public Result<List<Map>> mcpServers() throws Exception {
        List<Map> list = new ArrayList<>();
        for (Map.Entry<String, McpServerDo> entry : settings.getMcpServers().entrySet()) {
            String name = entry.getKey();
            McpServerDo params = entry.getValue();
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("name", name);
            item.put("type", params.getTypeOrTransport() != null ? params.getTypeOrTransport() : "stdio");
            item.put("enabled", params.isEnabled());
            item.put("scope", params.getScope() != null ? params.getScope() : AgentFlags.SCOPE_USER);
            if ("stdio".equals(params.getTypeOrTransport())) {
                item.put("command", params.getCommand());
                if (params.getArgs() != null) {
                    item.put("args", params.getArgs());
                }
                if (params.getEnv() != null) {
                    item.put("env", params.getEnv());
                }
            } else {
                item.put("url", params.getUrl());
                if (params.getHeaders() != null) {
                    item.put("headers", params.getHeaders());
                }
                if (params.getTimeout() != null) {
                    item.put("timeout", params.getTimeout().getSeconds() + "s");
                }
            }
            list.add(item);
        }


        sortByName(list, "name");

        return Result.succeed(list);
    }

    /**
     * 添加 MCP 服务器配置
     */
    @Post
    @Mapping("/web/settings/mcp/servers/add")
    public Result mcpServersAdd(@Body String json) throws Exception {
        ONode root = ONode.ofJson(json);
        String name = root.get("name").getString();
        String type = root.get("type").getString();

        if (Assert.isEmpty(name) || Assert.isEmpty(type)) {
            return Result.failure("name and type are required");
        }

        // 检查重名
        if (settings.getMcpServers().containsKey(name)) {
            return Result.failure("Server name already exists: " + name);
        }

        boolean enabled = root.get("enabled").getBoolean(true);
        String scope = root.hasKey("scope") ? root.get("scope").getString() : AgentFlags.SCOPE_USER;
        if (Assert.isEmpty(scope) || (!AgentFlags.SCOPE_LOCAL.equals(scope))) {
            scope = AgentFlags.SCOPE_USER;
        }

        McpServerDo params = new McpServerDo();
        params.setType(type);
        params.setScope(scope);

        if ("stdio".equals(type)) {
            params.setCommand(root.get("command").getString());
            if (root.hasKey("args")) {
                List<String> argsList = new ArrayList<>();
                for (ONode a : root.get("args").getArray()) {
                    argsList.add(a.getString());
                }
                params.setArgs(argsList);
            }
            if (root.hasKey("env")) {
                Map<String, String> envMap = new LinkedHashMap<>();
                for (Map.Entry<String, ONode> entry : root.get("env").getObject().entrySet()) {
                    envMap.put(entry.getKey(), entry.getValue().getString());
                }
                params.setEnv(envMap);
            }
        } else if ("sse".equals(type) || "streamable".equals(type)) {
            params.setUrl(root.get("url").getString());
            if (root.hasKey("headers")) {
                Map<String, String> headersMap = new LinkedHashMap<>();
                for (Map.Entry<String, ONode> entry : root.get("headers").getObject().entrySet()) {
                    headersMap.put(entry.getKey(), entry.getValue().getString());
                }
                params.setHeaders(headersMap);
            }
            if (root.hasKey("timeout")) {
                params.setTimeout(Duration.parse(root.get("timeout").getString()));
            }
        } else {
            return Result.failure("Unsupported type: " + type);
        }

        settings.getMcpServers().put(name, params);

        // 如果启用，同步到引擎
        if (enabled) {
            engine.addMcpServer(name, params);
        }

        saveSettings();
        LOG.info("[Settings] MCP server added: {}", name);
        return Result.succeed();
    }

    /**
     * 移除 MCP 服务器配置
     */
    @Post
    @Mapping("/web/settings/mcp/servers/remove")
    public Result mcpServersRemove(@Body String json) throws Exception {
        ONode root = ONode.ofJson(json);
        String name = root.get("name").getString();

        if (Assert.isEmpty(name)) {
            return Result.failure("name is required");
        }

        settings.getMcpServers().remove(name);
        saveSettings();
        engine.removeMcpServer(name);
        LOG.info("[Settings] MCP server removed: {}", name);
        return Result.succeed();
    }

    /**
     * 更新 MCP 服务器配置
     */
    @Post
    @Mapping("/web/settings/mcp/servers/update")
    public Result mcpServersUpdate(@Body String json) throws Exception {
        ONode root = ONode.ofJson(json);
        String name = root.get("name").getString();
        String originalName = root.get("originalName").getString();

        if (Assert.isEmpty(name)) {
            return Result.failure("name is required");
        }

        // 如果 name 变了，使用 originalName 查找旧记录
        String lookupName = (originalName != null && !originalName.isEmpty()) ? originalName : name;

        McpServerDo existing = settings.getMcpServers().get(lookupName);
        if (existing == null) {
            return Result.failure("Server not found: " + lookupName);
        }

        // 如果名称变更，先从引擎移除旧名称
        if (!lookupName.equals(name)) {
            settings.getMcpServers().remove(lookupName);
            engine.removeMcpServer(lookupName);
        } else {
            // 名称没变，仍然先从引擎移除（稍后重新添加）
            engine.removeMcpServer(name);
        }

        // 构建新参数
        String type = root.hasKey("type") ? root.get("type").getString() : existing.getTypeOrTransport();
        boolean enabled = root.hasKey("enabled") ? root.get("enabled").getBoolean(true) : true;
        String scope = root.hasKey("scope") ? root.get("scope").getString() : (existing.getScope() != null ? existing.getScope() : AgentFlags.SCOPE_USER);
        if (Assert.isEmpty(scope) || (!AgentFlags.SCOPE_LOCAL.equals(scope))) {
            scope = AgentFlags.SCOPE_USER;
        }

        McpServerDo params = new McpServerDo();
        params.setType(type);
        params.setScope(scope);

        if ("stdio".equals(type)) {
            params.setCommand(root.hasKey("command") ? root.get("command").getString() : existing.getCommand());
            if (root.hasKey("args")) {
                List<String> argsList = new ArrayList<>();
                for (ONode a : root.get("args").getArray()) {
                    argsList.add(a.getString());
                }
                params.setArgs(argsList);
            } else {
                params.setArgs(existing.getArgs());
            }
            if (root.hasKey("env")) {
                Map<String, String> envMap = new LinkedHashMap<>();
                for (Map.Entry<String, ONode> entry : root.get("env").getObject().entrySet()) {
                    envMap.put(entry.getKey(), entry.getValue().getString());
                }
                params.setEnv(envMap);
            } else {
                params.setEnv(existing.getEnv());
            }
        } else {
            params.setUrl(root.hasKey("url") ? root.get("url").getString() : existing.getUrl());
            if (root.hasKey("headers")) {
                Map<String, String> headersMap = new LinkedHashMap<>();
                for (Map.Entry<String, ONode> entry : root.get("headers").getObject().entrySet()) {
                    headersMap.put(entry.getKey(), entry.getValue().getString());
                }
                params.setHeaders(headersMap);
            } else {
                params.setHeaders(existing.getHeaders());
            }
            if (root.hasKey("timeout")) {
                params.setTimeout(Duration.parse(root.get("timeout").getString()));
            } else {
                params.setTimeout(existing.getTimeout());
            }
        }

        settings.getMcpServers().put(name, params);

        // 如果启用，同步到引擎
        if (enabled) {
            engine.addMcpServer(name, params);
        }

        saveSettings();
        LOG.info("[Settings] MCP server updated: {}", name);
        return Result.succeed();
    }

    /**
     * 切换 MCP 服务器启用/停用
     */
    @Post
    @Mapping("/web/settings/mcp/servers/toggle")
    public Result mcpServersToggle(@Param("name") String name, @Param("enabled") boolean enabled) throws Exception {
        if (Assert.isEmpty(name)) {
            return Result.failure("name is required");
        }

        McpServerParameters params = settings.getMcpServers().get(name);
        if (params == null) {
            return Result.failure("Server not found: " + name);
        } else {
            params.setEnabled(enabled);
        }

        if (enabled) {
            // 启用：添加到引擎
            engine.addMcpServer(name, params);
        } else {
            // 停用：从引擎移除
            engine.removeMcpServer(name);
        }

        saveSettings();
        LOG.info("[Settings] MCP server toggled: {} -> {}", name, enabled);
        return Result.succeed();
    }

    /**
     * 检测 MCP 服务器连接（不保存配置，仅测试）
     */
    @Post
    @Mapping("/web/settings/mcp/servers/check")
    public Result mcpServersCheck(Context ctx) {
        try {
            ONode root = ONode.ofJson(ctx.body());
            String type = root.get("type").getString();
            if (type == null || type.isEmpty()) type = "stdio";

            if ("stdio".equals(type)) {
                String command = root.get("command").getString();
                if (Assert.isEmpty(command)) {
                    return Result.failure("命令不能为空");
                }

                // 使用 McpClientProvider 进行真实的 MCP 初始化连接测试
                McpClientProvider.Builder builder = McpClientProvider.builder()
                        .channel(McpChannel.STDIO)
                        .command(command);

                // 设置参数
                List<String> argsList = root.get("args").toBean(TypeRef.listOf(String.class));
                if (Assert.isNotEmpty(argsList)) {
                    builder.args(argsList);
                }

                // 设置环境变量
                Map<String, String> envMap = root.get("env").toBean(TypeRef.mapOf(String.class, String.class));
                if (Assert.isNotEmpty(envMap)) {
                    builder.env(envMap);
                }

                McpClientProvider client = builder.build();
                try {
                    // 通过 getTools() 触发 MCP 初始化握手，验证连接有效性
                    client.getTools();
                    return Result.succeed("连接成功：MCP 初始化握手完成（stdio）");
                } finally {
                    client.close();
                }

            } else if ("sse".equals(type) || "streamable".equals(type)) {
                String url = root.get("url").getString();
                if (Assert.isEmpty(url)) {
                    return Result.failure("URL 不能为空");
                }

                // 使用 McpClientProvider 进行真实的 MCP 初始化连接测试
                String channel = "sse".equals(type)
                        ? McpChannel.SSE
                        : McpChannel.STREAMABLE;

                McpClientProvider.Builder builder = McpClientProvider.builder()
                        .channel(channel)
                        .url(url);

                // 设置自定义 headers
                Map<String, String> headersMap = root.get("headers").toBean(TypeRef.mapOf(String.class, String.class));
                if (Assert.isNotEmpty(headersMap)) {
                    builder.headers(headersMap);
                }

                McpClientProvider client = builder.build();
                try {
                    // 通过 getTools() 触发 MCP 初始化握手，验证连接有效性
                    client.getTools();
                    return Result.succeed("连接成功：MCP 初始化握手完成（" + type + "）");
                } finally {
                    client.close();
                }
            }

            return Result.failure("不支持检测的类型: " + type);
        } catch (java.net.ConnectException e) {
            return Result.failure("连接被拒绝，请检查地址和端口是否正确");
        } catch (java.net.SocketTimeoutException e) {
            return Result.failure("连接超时，请检查地址是否可达");
        } catch (java.io.IOException e) {
            return Result.failure("连接失败: " + e.getMessage());
        } catch (Exception e) {
            return Result.failure("检测失败: " + e.getMessage());
        }
    }

    // ==================== 设置：MCP 导入解析（后端解析） ====================

    /**
     * 解析 MCP 导入配置文件
     *
     * <p>接受上传的 JSON 文件，使用 ONode 解析后检测格式，返回结构化数据给前端预览。
     * 支持 OpenCode 格式（{@code $schema} 识别）和通用 {@code mcpServers} 格式。</p>
     *
     * @param ctx Solon 上下文，通过 {@code ctx.file("file")} 获取上传文件
     * @return 包含格式类型与服务器列表的结构化数据
     */
    @Post
    @Mapping("/web/settings/mcp/import/parse")
    public Result mcpImportParse(Context ctx) throws Exception {
        // 获取上传文件
        UploadedFile file = ctx.file("file");
        if (file == null) {
            return Result.failure("请上传文件");
        }

        // 读取文件内容（InputStream 转 byte[]）
        java.io.InputStream inStream = file.getContent();
        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = inStream.read(buf)) != -1) {
            buffer.write(buf, 0, n);
        }
        String content = new String(buffer.toByteArray(), StandardCharsets.UTF_8);

        // 使用 ONode 解析 JSON（ONode 原生支持标准 JSON 解析）
        ONode root;
        try {
            root = ONode.ofJson(content);
        } catch (Exception e) {
            return Result.failure("文件解析失败: " + e.getMessage());
        }

        if (root.isObject() == false) {
            return Result.failure("文件内容不是有效的 JSON 对象");
        }

        // 检测格式
        ONode mcpServersNode = null;
        String format = null;

        // 1. OpenCode 格式（$schema + mcp 字段）
        if (root.hasKey("$schema")
                && root.get("$schema").getString() != null
                && root.get("$schema").getString().contains("opencode.ai/config")
                && root.hasKey("mcp")
                && root.get("mcp").isObject()) {
            mcpServersNode = root.get("mcp");
            format = "OpenCode";
        }
        // 2. 通用 mcpServers 格式（Claude Desktop, Cursor 等）
        else if (root.hasKey("mcpServers") && root.get("mcpServers").isObject()) {
            mcpServersNode = root.get("mcpServers");
            format = "mcpServers";
        }
        // 3. 显式格式声明
        else if ("mcp".equals(root.get("format").getString())
                && root.hasKey("servers")
                && root.get("servers").isObject()) {
            mcpServersNode = root.get("servers");
            format = "explicit";
        }

        if (mcpServersNode == null) {
            return Result.failure("无法识别的配置文件格式: 期望 OpenCode 或 mcpServers 格式");
        }

        // 转换为统一结构返回
        List<Map<String, Object>> servers = new ArrayList<>();
        for (Map.Entry<String, ONode> entry : mcpServersNode.getObject().entrySet()) {
            String name = entry.getKey();
            ONode cfg = entry.getValue();

            if (!cfg.isObject()) {
                continue;
            }

            Map<String, Object> server = new LinkedHashMap<>();
            server.put("name", name);

            // 检测服务器类型
            String type = cfg.get("type").getString();
            String serverType;
            if (type == null || type.isEmpty()) {
                // 根据 command/url 推断
                if (cfg.hasKey("command")) {
                    serverType = "stdio";
                } else if (cfg.hasKey("url")) {
                    serverType = "sse";
                } else {
                    // 无法推断类型
                    server.put("error", "无法识别服务器类型，缺少 command 或 url");
                    servers.add(server);
                    continue;
                }
            } else if ("local".equals(type)) {
                serverType = "stdio";
            } else if ("remote".equals(type)) {
                serverType = "streamable";
            } else {
                serverType = type;
            }
            server.put("type", serverType);

            if ("stdio".equals(serverType)) {
                // 处理 command（可能为字符串或数组）
                ONode cmdNode = cfg.get("command");
                if (cmdNode.isArray()) {
                    List<String> cmdParts = new ArrayList<>();
                    for (ONode c : cmdNode.getArray()) {
                        cmdParts.add(c.getString());
                    }
                    if (!cmdParts.isEmpty()) {
                        server.put("command", cmdParts.get(0));
                        if (cmdParts.size() > 1) {
                            server.put("args", new ArrayList<>(cmdParts.subList(1, cmdParts.size())));
                        }
                    }
                    server.put("detail", String.join(" ", cmdParts));
                } else {
                    String cmdStr = cmdNode.getString();
                    server.put("command", cmdStr);
                    server.put("detail", cmdStr);
                }

                // args（显式声明）
                if (cfg.hasKey("args")) {
                    List<String> args = new ArrayList<>();
                    for (ONode a : cfg.get("args").getArray()) {
                        args.add(a.getString());
                    }
                    server.put("args", args);
                    // 更新 detail 包含完整 command + args
                    StringBuilder detail = new StringBuilder();
                    if (server.containsKey("command")) {
                        detail.append(server.get("command"));
                    }
                    for (String a : args) {
                        detail.append(" ").append(a);
                    }
                    server.put("detail", detail.toString());
                }

                // 环境变量：兼容多种命名
                Map<String, String> env = null;
                if (cfg.hasKey("env")) {
                    env = oNodeToStringMap(cfg.get("env"));
                } else if (cfg.hasKey("environment")) {
                    env = oNodeToStringMap(cfg.get("environment"));
                } else if (cfg.hasKey("envVars")) {
                    env = oNodeToStringMap(cfg.get("envVars"));
                } else if (cfg.hasKey("environmentVariables")) {
                    env = oNodeToStringMap(cfg.get("environmentVariables"));
                }
                if (env != null && !env.isEmpty()) {
                    server.put("env", env);
                }
            } else {
                // sse / streamable
                server.put("url", cfg.get("url").getString());
                server.put("detail", cfg.get("url").getString());

                if (cfg.hasKey("headers")) {
                    server.put("headers", oNodeToStringMap(cfg.get("headers")));
                }
                if (cfg.hasKey("timeout")) {
                    ONode timeoutNode = cfg.get("timeout");
                    if (timeoutNode.isNumber()) {
                        server.put("timeout", timeoutNode.getLong());
                    } else {
                        server.put("timeout", timeoutNode.getString());
                    }
                }
            }

            servers.add(server);
        }

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("format", format);
        data.put("servers", servers);

        return Result.succeed(data);
    }

    /**
     * 将 ONode 对象转为 Map<String, String>
     */
    private Map<String, String> oNodeToStringMap(ONode node) {
        if (node == null || !node.isObject()) {
            return null;
        }
        Map<String, String> map = new LinkedHashMap<>();
        for (Map.Entry<String, ONode> entry : node.getObject().entrySet()) {
            map.put(entry.getKey(), entry.getValue().getString());
        }
        return map;
    }

    // ==================== 设置：MCP 工具权限管理 ====================

    /**
     * 获取指定 MCP 服务器的工具列表及权限状态
     */
    @Get
    @Mapping("/web/settings/mcp/servers/tools")
    public Result mcpServerTools(String name) throws IOException {
        McpServerParameters serverParameters = settings.getMcpServers().get(name);
        if (serverParameters == null) {
            return Result.failure("Server not found: " + name);
        }

        final Collection<FunctionTool> allTools;
        McpClientProvider provider = engine.getMcpServer(name);
        if (provider == null) {
            provider = McpClientProviders.fromMcpServer(serverParameters);
            try {
                allTools = provider.getTools();
            } finally {
                provider.close();
            }
        } else {
            allTools = provider.getTools();
        }

        List<Map<String, Object>> toolList = new ArrayList<>();
        for (FunctionTool tool : allTools) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("name", tool.name());
            item.put("inputSchema", tool.inputSchema());
            item.put("description", tool.description());
            toolList.add(item);
        }

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("serverName", name);
        data.put("connected", true);
        data.put("disallowedTools", serverParameters.getDisallowedTools());
        data.put("tools", toolList);
        return Result.succeed(data);
    }

    /**
     * 更新指定 MCP 服务器的工具权限（disallowedTools）
     * <p>通过 engine.refreshMcpServer 影子交换策略热重载，无需重启。</p>
     */
    @Post
    @Mapping("/web/settings/mcp/servers/tools/save")
    public Result mcpServerToolsSave(@Param("serverName") String serverName, @Param("disallowedTools") String[] disallowedTools) throws IOException {
        McpServerDo serverParameters = settings.getMcpServers().get(serverName);
        if (serverParameters == null) {
            return Result.failure("Server not found: " + serverName);
        }

        serverParameters.setDisallowedTools(Arrays.asList(disallowedTools));

        // 同步到引擎 provider 并热重载
        McpClientProvider provider = engine.getMcpServer(serverName);
        if (provider != null) {
            provider.setDisallowedTools(serverParameters.getDisallowedTools());
            engine.refreshMcpServer(serverName);
        }

        saveSettings();
        LOG.info("[Settings] MCP server tools permissions updated: {}", serverName);
        return Result.succeed();
    }

    // ==================== 设置：OpenApi 服务器管理 ====================

    /**
     * 获取已配置的 OpenApi 服务器列表
     */
    @Get
    @Mapping("/web/settings/openapi/servers")
    public Result<List<Map>> openapiServers() throws Exception {
        List<Map> list = new ArrayList<>();
        for (Map.Entry<String, ApiSourceDo> entry : settings.getApiServers().entrySet()) {
            String name = entry.getKey();
            ApiSourceDo source = entry.getValue();
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("name", name);
            item.put("apiBaseUrl", source.getApiBaseUrl());
            item.put("docUrl", source.getDocUrl());
            item.put("enabled", source.isEnabled());
            item.put("scope", source.getScope() != null ? source.getScope() : AgentFlags.SCOPE_USER);
            if (source.getHeaders() != null) {
                item.put("headers", source.getHeaders());
            }
            list.add(item);
        }

        sortByName(list, "name");

        return Result.succeed(list);
    }

    /**
     * 添加 OpenApi 服务器配置
     */
    @Post
    @Mapping("/web/settings/openapi/servers/add")
    public Result openapiServersAdd(Context ctx) throws Exception {
        ONode root = ONode.ofJson(ctx.body());
        String name = root.get("name").getString();
        String apiBaseUrl = root.get("apiBaseUrl").getString();

        if (Assert.isEmpty(name) || Assert.isEmpty(apiBaseUrl)) {
            return Result.failure("name and apiBaseUrl are required");
        }

        // 检查重名
        if (settings.getApiServers().containsKey(name)) {
            return Result.failure("Server name already exists: " + name);
        }

        boolean enabled = root.get("enabled").getBoolean(true);
        String scope = root.hasKey("scope") ? root.get("scope").getString() : AgentFlags.SCOPE_USER;
        if (Assert.isEmpty(scope) || (!AgentFlags.SCOPE_LOCAL.equals(scope))) {
            scope = AgentFlags.SCOPE_USER;
        }

        ApiSourceDo source = new ApiSourceDo();
        source.setApiBaseUrl(apiBaseUrl);
        source.setDocUrl(root.get("docUrl").getString());
        source.setScope(scope);
        if (root.hasKey("headers")) {
            Map<String, String> headersMap = new LinkedHashMap<>();
            for (Map.Entry<String, ONode> entry : root.get("headers").getObject().entrySet()) {
                headersMap.put(entry.getKey(), entry.getValue().getString());
            }
            source.setHeaders(headersMap);
        }

        settings.getApiServers().put(name, source);

        // 如果启用，同步到引擎
        if (enabled) {
            engine.addApiServer(source);
        }

        saveSettings();
        LOG.info("[Settings] OpenApi server added: {}", name);
        return Result.succeed();
    }

    /**
     * 更新 OpenApi 服务器配置
     */
    @Post
    @Mapping("/web/settings/openapi/servers/update")
    public Result openapiServersUpdate(Context ctx) throws Exception {
        ONode root = ONode.ofJson(ctx.body());
        String name = root.get("name").getString();
        String originalName = root.get("originalName").getString();

        if (Assert.isEmpty(name)) {
            return Result.failure("name is required");
        }

        // 如果 name 变了，使用 originalName 查找旧记录
        String lookupName = (originalName != null && !originalName.isEmpty()) ? originalName : name;

        ApiSourceDo existing = settings.getApiServers().get(lookupName);
        if (existing == null) {
            return Result.failure("Server not found: " + lookupName);
        }

        // 从引擎移除旧的
        engine.removeApiServer(existing.getDocUrl());

        // 如果名称变更，移除旧 key
        if (!lookupName.equals(name)) {
            settings.getApiServers().remove(lookupName);
        }

        boolean enabled = root.hasKey("enabled") ? root.get("enabled").getBoolean(true) : true;

        // 构建新配置
        String scope = root.hasKey("scope") ? root.get("scope").getString() : (existing.getScope() != null ? existing.getScope() : AgentFlags.SCOPE_USER);
        if (Assert.isEmpty(scope) || (!AgentFlags.SCOPE_LOCAL.equals(scope))) {
            scope = AgentFlags.SCOPE_USER;
        }
        ApiSourceDo source = new ApiSourceDo();
        source.setApiBaseUrl(root.hasKey("apiBaseUrl") ? root.get("apiBaseUrl").getString() : existing.getApiBaseUrl());
        source.setDocUrl(root.hasKey("docUrl") ? root.get("docUrl").getString() : existing.getDocUrl());
        source.setScope(scope);
        if (root.hasKey("headers")) {
            Map<String, String> headersMap = new LinkedHashMap<>();
            for (Map.Entry<String, ONode> entry : root.get("headers").getObject().entrySet()) {
                headersMap.put(entry.getKey(), entry.getValue().getString());
            }
            source.setHeaders(headersMap);
        } else {
            source.setHeaders(existing.getHeaders());
        }

        settings.getApiServers().put(name, source);

        // 如果启用，同步到引擎
        if (enabled) {
            engine.addApiServer(source);
        }

        saveSettings();
        LOG.info("[Settings] OpenApi server updated: {}", name);
        return Result.succeed();
    }

    /**
     * 移除 OpenApi 服务器配置
     */
    @Post
    @Mapping("/web/settings/openapi/servers/remove")
    public Result openapiServersRemove(@Param("name") String name) throws Exception {
        if (Assert.isEmpty(name)) {
            return Result.failure("name is required");
        }

        ApiSourceDo source = settings.getApiServers().get(name);
        if (source != null) {
            // 从引擎移除
            engine.removeApiServer(source.getDocUrl());
        }

        settings.getApiServers().remove(name);
        saveSettings();
        LOG.info("[Settings] OpenApi server removed: {}", name);
        return Result.succeed();
    }

    /**
     * 切换 OpenApi 服务器启用/停用
     */
    @Post
    @Mapping("/web/settings/openapi/servers/toggle")
    public Result openapiServersToggle(@Param("name") String name, @Param("enabled") Boolean enabled) throws Exception {
        if (Assert.isEmpty(name)) {
            return Result.failure("name is required");
        }

        ApiSource source = settings.getApiServers().get(name);
        if (source == null) {
            return Result.failure("Server not found: " + name);
        } else {
            source.setEnabled(enabled);
        }

        if (enabled) {
            // 启用：添加到引擎
            engine.addApiServer(source);
        } else {
            // 停用：从引擎移除
            engine.removeApiServer(source.getDocUrl());
        }

        saveSettings();
        LOG.info("[Settings] OpenApi server toggled: {} -> {}", name, enabled);
        return Result.succeed();
    }

    /**
     * 检测 OpenApi 服务器连接（HTTP HEAD/GET 请求测试）
     */
    @Post
    @Mapping("/web/settings/openapi/servers/check")
    public Result openapiServersCheck(@Body ApiSourceDo sourceDo) {
        try {
            if (Assert.isEmpty(sourceDo.getApiBaseUrl())) {
                return Result.failure("API 基地址不能为空");
            }

            if (Assert.isEmpty(sourceDo.getDocUrl())) {
                return Result.failure("API 文档地址不能为空");
            }

            // 构建HTTP连接测试
            java.net.URL url = new java.net.URL(sourceDo.getDocUrl());
            java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);
            conn.setInstanceFollowRedirects(true);

            // 设置自定义 headers
            if (Assert.isNotEmpty(sourceDo.getHeaders())) {
                for (Map.Entry<String, String> entry : sourceDo.getHeaders().entrySet()) {
                    conn.setRequestProperty(entry.getKey(), entry.getValue());
                }
            }

            int responseCode = conn.getResponseCode();
            conn.disconnect();

            if (responseCode >= 200 && responseCode < 400) {
                return Result.succeed("连接成功：HTTP " + responseCode);
            } else {
                return Result.failure("连接失败：HTTP " + responseCode);
            }
        } catch (java.net.ConnectException e) {
            return Result.failure("连接被拒绝，请检查地址和端口是否正确");
        } catch (java.net.SocketTimeoutException e) {
            return Result.failure("连接超时，请检查地址是否可达");
        } catch (java.io.IOException e) {
            return Result.failure("连接失败: " + e.getMessage());
        } catch (Exception e) {
            return Result.failure("检测失败: " + e.getMessage());
        }
    }


    // ==================== 设置：OpenApi 工具权限管理 ====================

    /**
     * 获取指定 OpenApi 服务器的 API 列表及权限状态
     */
    @Get
    @Mapping("/web/settings/openapi/servers/apis")
    public Result openapiServerApis(@Param("name") String name) {
        ApiSource source = settings.getApiServers().get(name);
        if (source == null) {
            return Result.failure("Server not found: " + name);
        }

        ApiSourceClient client = engine.getApiServer(source.getDocUrl());
        if (client == null) {
            // 服务器未启用或未加载
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("serverName", name);
            data.put("connected", false);
            data.put("apis", Collections.emptyList());
            return Result.succeed(data);
        }

        Collection<ApiTool> allTools = client.getTools();
        List<Map<String, Object>> apiList = new ArrayList<>();
        for (ApiTool tool : allTools) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("name", tool.getName());
            item.put("method", tool.getMethod());
            item.put("path", tool.getPath());
            item.put("description", tool.getDescription());
            apiList.add(item);
        }

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("serverName", name);
        data.put("disallowedTools", source.getDisallowedTools());
        data.put("connected", true);
        data.put("apis", apiList);
        return Result.succeed(data);
    }

    /**
     * 更新指定 OpenApi 服务器的 API 权限（allowedTools）
     * <p>通过 engine.refreshApiServer 影子交换策略热重载，无需重启。</p>
     */
    @Post
    @Mapping("/web/settings/openapi/servers/apis/save")
    public Result openapiServerApisSave(@Param("serverName") String serverName, @Param("disallowedTools") String[] disallowedTools) {
        ApiSource source = settings.getApiServers().get(serverName);
        if (source == null) {
            return Result.failure("Server not found: " + serverName);
        }

        // disallowedTools
        source.setDisallowedTools(Arrays.asList(disallowedTools));

        // 同步到引擎 client 并热重载
        ApiSourceClient client = engine.getApiServer(source.getDocUrl());
        if (client != null) {
            client.setDisallowedTools(source.getDisallowedTools());
            engine.refreshApiServer(source.getDocUrl());
        }

        saveSettings();
        LOG.info("[Settings] OpenApi server apis permissions updated: {}", serverName);
        return Result.succeed();
    }


    // ==================== 设置：LSP 服务器管理 ====================

    /**
     * 获取已配置的 LSP 服务器列表
     */
    @Get
    @Mapping("/web/settings/lsp/servers")
    public Result<List<Map>> lspServers() throws Exception {
        List<Map> list = new ArrayList<>();
        for (Map.Entry<String, LspServerDo> entry : settings.getLspServers().entrySet()) {
            String name = entry.getKey();
            LspServerDo params = entry.getValue();
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("name", name);
            item.put("enabled", params.isEnabled());
            item.put("scope", params.getScope() != null ? params.getScope() : AgentFlags.SCOPE_LOCAL);
            item.put("command", params.getCommand());
            item.put("extensions", params.getExtensions());
            item.put("installed", isCommandInstalled(params.getCommand()));
            if (params.getEnv() != null && !params.getEnv().isEmpty()) {
                item.put("env", params.getEnv());
            }
            if (params.getInitialization() != null && !params.getInitialization().isEmpty()) {
                item.put("initialization", params.getInitialization());
            }
            list.add(item);
        }

        sortByName(list, "name");

        return Result.succeed(list);
    }

    /**
     * 检测 LSP 启动命令是否已安装（通过 which 检测可执行文件是否存在）
     */
    private boolean isCommandInstalled(List<String> command) {
        if (command == null || command.isEmpty()) return false;
        String cmd = command.get(0);
        if (cmd == null || cmd.isEmpty()) return false;
        try {
            ProcessBuilder pb = new ProcessBuilder("which", cmd);
            pb.redirectErrorStream(true);
            Process p = pb.start();
            int exitCode = p.waitFor();
            return exitCode == 0;
        } catch (Exception e) {
            LOG.warn("[LSP] Failed to check command: {}", cmd);
            return false;
        }
    }

    /**
     * 添加 LSP 服务器配置
     */
    @Post
    @Mapping("/web/settings/lsp/servers/add")
    public Result lspServersAdd(@Body String json) throws Exception {
        ONode root = ONode.ofJson(json);
        String name = root.get("name").getString();
        if (Assert.isEmpty(name)) {
            return Result.failure("name is required");
        }
        if (settings.getLspServers().containsKey(name)) {
            return Result.failure("Server name already exists: " + name);
        }

        boolean enabled = root.get("enabled").getBoolean(true);
        String scope = root.hasKey("scope") ? root.get("scope").getString() : AgentFlags.SCOPE_USER;
        if (Assert.isEmpty(scope) || (!AgentFlags.SCOPE_LOCAL.equals(scope))) {
            scope = AgentFlags.SCOPE_USER;
        }

        LspServerDo params = new LspServerDo();
        params.setScope(scope);

        // command
        if (root.hasKey("command")) {
            List<String> commandList = new ArrayList<>();
            if (root.get("command").isArray()) {
                for (ONode c : root.get("command").getArray()) {
                    commandList.add(c.getString());
                }
            } else {
                String cmd = root.get("command").getString();
                commandList.addAll(CmdUtil.parseArguments(cmd));
            }
            params.setCommand(commandList);
        }

        // extensions
        if (root.hasKey("extensions")) {
            List<String> extList = new ArrayList<>();
            for (ONode e : root.get("extensions").getArray()) {
                extList.add(e.getString());
            }
            params.setExtensions(extList);
        }

        // env
        if (root.hasKey("env")) {
            Map<String, String> envMap = new LinkedHashMap<>();
            for (Map.Entry<String, ONode> entry : root.get("env").getObject().entrySet()) {
                envMap.put(entry.getKey(), entry.getValue().getString());
            }
            params.setEnv(envMap);
        }

        settings.getLspServers().put(name, params);

        if (enabled) {
            engine.addLspServer(name, params);
        }

        saveSettings();
        LOG.info("[Settings] LSP server added: {}", name);
        return Result.succeed();
    }

    /**
     * 更新 LSP 服务器配置
     */
    @Post
    @Mapping("/web/settings/lsp/servers/update")
    public Result lspServersUpdate(@Body String json) throws Exception {
        ONode root = ONode.ofJson(json);
        String name = root.get("name").getString();
        String originalName = root.get("originalName").getString();
        if (Assert.isEmpty(name)) {
            return Result.failure("name is required");
        }

        String lookupName = (originalName != null && !originalName.isEmpty()) ? originalName : name;
        LspServerDo existing = settings.getLspServers().get(lookupName);
        if (existing == null) {
            return Result.failure("Server not found: " + lookupName);
        }

        if (!lookupName.equals(name)) {
            settings.getLspServers().remove(lookupName);
            engine.removeLspServer(lookupName);
        } else {
            engine.removeLspServer(name);
        }

        boolean enabled = root.hasKey("enabled") ? root.get("enabled").getBoolean(true) : true;
        String scope = root.hasKey("scope") ? root.get("scope").getString() : (existing.getScope() != null ? existing.getScope() : AgentFlags.SCOPE_USER);
        if (Assert.isEmpty(scope) || (!AgentFlags.SCOPE_LOCAL.equals(scope))) {
            scope = AgentFlags.SCOPE_USER;
        }

        LspServerDo params = new LspServerDo();
        params.setScope(scope);

        // command
        if (root.hasKey("command")) {
            List<String> commandList = new ArrayList<>();
            if (root.get("command").isArray()) {
                for (ONode c : root.get("command").getArray()) {
                    commandList.add(c.getString());
                }
            } else {
                String cmd = root.get("command").getString();
                commandList.addAll(CmdUtil.parseArguments(cmd));
            }
            params.setCommand(commandList);
        } else {
            params.setCommand(existing.getCommand());
        }

        // extensions
        if (root.hasKey("extensions")) {
            List<String> extList = new ArrayList<>();
            for (ONode e : root.get("extensions").getArray()) {
                extList.add(e.getString());
            }
            params.setExtensions(extList);
        } else {
            params.setExtensions(existing.getExtensions());
        }

        // env
        if (root.hasKey("env")) {
            Map<String, String> envMap = new LinkedHashMap<>();
            for (Map.Entry<String, ONode> entry : root.get("env").getObject().entrySet()) {
                envMap.put(entry.getKey(), entry.getValue().getString());
            }
            params.setEnv(envMap);
        } else {
            params.setEnv(existing.getEnv());
        }

        settings.getLspServers().put(name, params);

        if (enabled) {
            engine.addLspServer(name, params);
        }

        saveSettings();
        LOG.info("[Settings] LSP server updated: {}", name);
        return Result.succeed();
    }

    /**
     * 移除 LSP 服务器配置
     */
    @Post
    @Mapping("/web/settings/lsp/servers/remove")
    public Result lspServersRemove(@Body String json) throws Exception {
        ONode root = ONode.ofJson(json);
        String name = root.get("name").getString();
        if (Assert.isEmpty(name)) {
            return Result.failure("name is required");
        }
        LspServerDo params = settings.getLspServers().get(name);
        settings.getLspServers().remove(name);
        saveSettings();
        engine.removeLspServer(name);
        LOG.info("[Settings] LSP server removed: {}", name);
        return Result.succeed();
    }

    /**
     * 切换 LSP 服务器启用/停用
     */
    @Post
    @Mapping("/web/settings/lsp/servers/toggle")
    public Result lspServersToggle(@Param("name") String name, @Param("enabled") Boolean enabled) throws Exception {
        if (Assert.isEmpty(name)) {
            return Result.failure("name is required");
        }

        LspServerParameters params = settings.getLspServers().get(name);
        if (params == null) {
            return Result.failure("Server not found: " + name);
        } else {
            params.setEnabled(enabled);
        }

        if (enabled) {
            engine.addLspServer(name, params);
        } else {
            engine.removeLspServer(name);
        }

        saveSettings();
        LOG.info("[Settings] LSP server toggled: {} -> {}", name, enabled);
        return Result.succeed();
    }

    // ==================== 设置：供应商管理 ====================

    /**
     * 获取所有供应商列表
     */
    @Get
    @Mapping("/web/settings/providers")
    public Result<List<Map>> providersList() {
        List<Map> list = new ArrayList<>();
        for (Map.Entry<String, ProviderDo> entry : settings.getProviders().entrySet()) {
            String name = entry.getKey();
            ProviderDo provider = entry.getValue();
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("name", name);
            item.put("standard", provider.getStandard());
            item.put("apiUrl", provider.getApiUrl());
            item.put("apiKey", maskApiKey(provider.getApiKey()));
            if (provider.getTimeout() != null) {
                item.put("timeout", provider.getTimeout().getSeconds() + "s");
            }
            item.put("enabled", provider.isEnabled());
            item.put("scope", provider.getScope() != null ? provider.getScope() : AgentFlags.SCOPE_USER);
            item.put("builtin", provider.isBuiltin());
            item.put("models", provider.getModels());
            list.add(item);
        }

        sortByName(list, "name");
        return Result.succeed(list);
    }

    /**
     * 获取单个供应商详情
     */
    @Get
    @Mapping("/web/settings/providers/get")
    public Result<Map> providersGet(@Param("name") String name) {
        if (Assert.isEmpty(name)) {
            return Result.failure("name is required");
        }

        ProviderDo provider = settings.getProviders().get(name);
        if (provider == null) {
            return Result.failure("Provider not found: " + name);
        }

        Map<String, Object> item = new LinkedHashMap<>();
        item.put("name", name);
        item.put("standard", provider.getStandard());
        item.put("apiUrl", provider.getApiUrl());
        item.put("apiKey", provider.getApiKey());
        if (provider.getTimeout() != null) {
            item.put("timeout", provider.getTimeout().getSeconds() + "s");
        }
        item.put("enabled", provider.isEnabled());
        item.put("scope", provider.getScope() != null ? provider.getScope() : AgentFlags.SCOPE_USER);
        item.put("builtin", provider.isBuiltin());
        item.put("models", provider.getModels());
        return Result.succeed(item);
    }

    /**
     * 添加供应商
     */
    @Post
    @Mapping("/web/settings/providers/add")
    public Result providersAdd(@Body String json) throws Exception {
        ONode root = ONode.ofJson(json);
        String name = root.get("name").getString();

        if (Assert.isEmpty(name)) {
            return Result.failure("name is required");
        }

        // 检查重名
        if (settings.getProviders().containsKey(name)) {
            return Result.failure("Provider name already exists: " + name);
        }

        ProviderDo provider = new ProviderDo();
        provider.setName(name);
        provider.setStandard(root.get("standard").getString("openai"));
        provider.setApiUrl(root.get("apiUrl").getString());
        provider.setApiKey(root.get("apiKey").getString());
        provider.setEnabled(root.get("enabled").getBoolean(true));
        provider.setScope(root.hasKey("scope") ? root.get("scope").getString() : AgentFlags.SCOPE_USER);
        provider.setTimeout(parseTimeout(root, null));

        // 解析模型列表（直接存储 ModelInfo）
        if (root.hasKey("models") && root.get("models").isArray()) {
            provider.setModels(parseProviderModels(root.get("models")));
        }

        settings.getProviders().put(name, provider);
        saveSettings();
        LOG.info("[Settings] Provider added: {}", name);
        return Result.succeed();
    }

    /**
     * 更新供应商
     */
    @Post
    @Mapping("/web/settings/providers/update")
    public Result providersUpdate(@Body String json) throws Exception {
        ONode root = ONode.ofJson(json);
        String name = root.get("name").getString();
        String originalName = root.get("originalName").getString();

        if (Assert.isEmpty(name)) {
            return Result.failure("name is required");
        }

        String lookupName = (originalName != null && !originalName.isEmpty()) ? originalName : name;
        ProviderDo existing = settings.getProviders().get(lookupName);
        if (existing == null) {
            return Result.failure("Provider not found: " + lookupName);
        }

        // 内置连接：名称与 API 地址锁定，忽略前端传入的改名/改址，强制沿用原值
        if (existing.isBuiltin()) {
            name = existing.getName();
        }

        // 改名冲突校验：新名称不能与其他供应商重名
        if (!lookupName.equals(name) && settings.getProviders().containsKey(name)) {
            return Result.failure("Provider name already exists: " + name);
        }

        // 如果名称变更，移除旧 key
        if (!lookupName.equals(name)) {
            settings.getProviders().remove(lookupName);
        }

        ProviderDo provider = new ProviderDo();
        provider.setName(name);
        provider.setStandard(root.hasKey("standard") ? root.get("standard").getString() : existing.getStandard());
        provider.setApiUrl(existing.isBuiltin()
                ? existing.getApiUrl()
                : (root.hasKey("apiUrl") ? root.get("apiUrl").getString() : existing.getApiUrl()));
        // 密钥缺省（前端在详情未回填、真实密钥未知时不提交该字段）保留原值；显式传空串=用户主动清空
        provider.setApiKey(root.hasKey("apiKey") ? root.get("apiKey").getString() : existing.getApiKey());
        provider.setEnabled(root.hasKey("enabled") ? root.get("enabled").getBoolean(true) : existing.isEnabled());
        provider.setScope(root.hasKey("scope") ? root.get("scope").getString() : (existing.getScope() != null ? existing.getScope() : AgentFlags.SCOPE_USER));
        provider.setTimeout(parseTimeout(root, existing.getTimeout()));
        provider.setBuiltin(existing.isBuiltin());

        // 解析模型列表（直接存储 ModelInfo）
        if (root.hasKey("models") && root.get("models").isArray()) {
            List<ModelInfo> models = parseProviderModels(root.get("models"));
            provider.setModels(models);
        } else {
            provider.setModels(existing.getModels());
        }

        settings.getProviders().put(name, provider);

        // 改名：将该供应商下的 LLM 模型从旧名称前缀迁移到新前缀（map key/name/provider 同步更新），
        // 运行时引擎实例同步切换，否则旧前缀模型成为孤儿且无法再被更新/同步；
        // 先收集待迁移 key 再逐个处理，避免迭代中结构性修改
        if (!lookupName.equals(name)) {
            String oldPrefix = lookupName + "-";
            String newPrefix = name + "-";
            List<String> renameKeys = new ArrayList<>();
            for (Map.Entry<String, ModelDo> entry : settings.getModels().entrySet()) {
                if (lookupName.equals(entry.getValue().getProvider()) && entry.getKey().startsWith(oldPrefix)) {
                    renameKeys.add(entry.getKey());
                }
            }
            for (String oldKey : renameKeys) {
                ModelDo model = settings.getModels().get(oldKey);
                if (model == null) {
                    continue;
                }
                String newKey = newPrefix + oldKey.substring(oldPrefix.length());
                if (settings.getModels().containsKey(newKey)) {
                    continue; // 新 key 已存在则跳过，避免覆盖同名模型
                }
                settings.getModels().remove(oldKey);
                model.setName(newKey);
                model.setProvider(name);
                settings.getModels().put(newKey, model);
                engine.removeModel(oldKey);
                if (model.isEnabled()) {
                    engine.addModel(model);
                }
                LOG.info("[Settings] Model renamed on provider rename: {} -> {}", oldKey, newKey);
            }
            // 模型名引用悬空修复：defaultModel / general.acpModel 指向旧前缀模型时同步切到新前缀，
            // 否则改名后全局默认模型与 ACP 模型失效（按名查找拿不到旧 key，静默回退）
            String defaultModel = settings.getDefaultModel();
            String newDefault = renameModelRef(defaultModel, oldPrefix, newPrefix);
            if (newDefault != null && !newDefault.equals(defaultModel)) {
                settings.setDefaultModel(newDefault);
                LOG.info("[Settings] Default model renamed on provider rename: {} -> {}", defaultModel, newDefault);
            }
            String acpModel = settings.getGeneral().getAcpModel();
            String newAcp = renameModelRef(acpModel, oldPrefix, newPrefix);
            if (newAcp != null && !newAcp.equals(acpModel)) {
                settings.getGeneral().setAcpModel(newAcp);
                LOG.info("[Settings] ACP model renamed on provider rename: {} -> {}", acpModel, newAcp);
            }
        }

        saveSettings();
        LOG.info("[Settings] Provider updated: {}", name);
        return Result.succeed();
    }

    /**
     * 供应商改名后迁移模型名引用（旧前缀 -> 新前缀）：非该前缀引用或新名称不存在时原样返回。
     */
    private String renameModelRef(String ref, String oldPrefix, String newPrefix) {
        if (ref == null || !ref.startsWith(oldPrefix)) {
            return ref;
        }
        String renamed = newPrefix + ref.substring(oldPrefix.length());
        return settings.getModels().containsKey(renamed) ? renamed : ref;
    }

    /**
     * 删除供应商
     */
    @Post
    @Mapping("/web/settings/providers/remove")
    public Result providersRemove(@Param("name") String name) throws Exception {
        if (Assert.isEmpty(name)) {
            return Result.failure("name is required");
        }

        ProviderDo existing = settings.getProviders().get(name);
        if (existing != null && existing.isBuiltin()) {
            return Result.failure("内置连接不可删除");
        }

        settings.getProviders().remove(name);
        saveSettings();
        LOG.info("[Settings] Provider removed: {}", name);
        return Result.succeed();
    }

    /**
     * 切换供应商启用/禁用状态
     */
    @Post
    @Mapping("/web/settings/providers/toggle")
    public Result providersToggle(@Param("name") String name, @Param("enabled") Boolean enabled) throws Exception {
        if (Assert.isEmpty(name) || enabled == null) {
            return Result.failure("name and enabled are required");
        }

        ProviderDo provider = settings.getProviders().get(name);
        if (provider == null) {
            return Result.failure("Provider not found: " + name);
        }

        provider.setEnabled(enabled);

        // 同步关联模型的启用状态：连接开关 与 按模型启用态 取与，
        // 单独禁用过的模型在连接重新启用后仍保持禁用
        Map<String, Boolean> modelEnabled = new HashMap<>();
        if (provider.getModels() != null) {
            for (ModelInfo mi : provider.getModels()) {
                if (mi.getId() != null && mi.getEnabled() != null) {
                    modelEnabled.put(mi.getId(), mi.getEnabled());
                }
            }
        }
        String prefix = name + "-";
        for (ModelDo model : settings.getModels().values()) {
            if (name.equals(model.getProvider())) {
                Boolean me = (model.getName() != null && model.getName().startsWith(prefix))
                        ? modelEnabled.get(model.getName().substring(prefix.length()))
                        : null;
                model.setVisibled(enabled && (me == null || me));
                // 即时同步运行时引擎
                if (model.isEnabled()) {
                    engine.addModel(model);
                } else {
                    engine.removeModel(model.getNameOrModel());
                }
            }
        }

        saveSettings();
        LOG.info("[Settings] Provider {} {}", name, enabled ? "enabled" : "disabled");
        return Result.succeed();
    }

    /**
     * 拉取供应商模型列表
     */
    @Post
    @Mapping("/web/settings/providers/fetch")
    public Result providersFetch(@Param("apiUrl") String apiUrl, @Param("apiKey") String apiKey, @Param("standard") String standard) {
        if (Assert.isEmpty(apiUrl)) {
            Map<String, Object> failure = new LinkedHashMap<>();
            failure.put("reason", ModelsFetchReason.INVALID_URL.name());
            failure.put("status", 0);
            return Result.failure("fetch models failed", failure);
        }

        try {
            // 使用 ModelProviderFactory 获取对应的提供商
            ModelsAdapter provider = modelProviderFactory.getProvider(standard);

            // 鉴权头交给对应协议的 adapter 自行处理（OpenAI/Ollama 用 Authorization: Bearer，
            // Anthropic 用 x-api-key + anthropic-version），此处不再写死 Bearer，
            // 否则选 anthropic 协议时会同时带上多余的 Authorization 头。
            Map<String, String> headers = new HashMap<>();

            // 调用提供商获取模型列表
            List<ModelInfo> models = provider.fetchModels(apiUrl, headers, apiKey);
            
            // 转换为前端需要的格式
            List<Map<String, Object>> modelList = new ArrayList<>();
            for (ModelInfo model : models) {
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("id", model.getId());
                item.put("owned_by", model.getOwnedBy());
                // 由 supported_endpoint_types 推断出的对话接口协议（可能为 null，前端回退 openai）
                item.put("standard", model.getStandard());
                item.put("supported_endpoint_types", model.getSupportedEndpointTypes());
                modelList.add(item);
            }
            
            return Result.succeed(modelList);
        } catch (ModelsFetchException e) {
            Map<String, Object> failure = new LinkedHashMap<>();
            failure.put("reason", e.getReason().name());
            failure.put("status", e.getStatus());
            LOG.warn("[Settings] Failed to fetch models: reason={}, status={}", e.getReason(), e.getStatus());
            return Result.failure("fetch models failed", failure);
        } catch (Throwable e) {
            Map<String, Object> failure = new LinkedHashMap<>();
            failure.put("reason", ModelsFetchReason.UNKNOWN.name());
            failure.put("status", 0);
            LOG.warn("[Settings] Unexpected model fetch failure", e);
            return Result.failure("fetch models failed", failure);
        }
    }

    /**
     * 同步供应商模型到 LLM 模型配置
     */
    @Post
    @Mapping("/web/settings/providers/sync-models")
    public Result providersSyncModels(@Body String json) throws Exception {
        ONode root = ONode.ofJson(json);
        String providerName = root.get("providerName").getString();
        
        if (Assert.isEmpty(providerName)) {
            return Result.failure("providerName is required");
        }
        
        ProviderDo provider = settings.getProviders().get(providerName);
        if (provider == null) {
            return Result.failure("Provider not found: " + providerName);
        }
        
        // 获取供应商的模型列表（现在是 ModelInfo 类型）
        List<ModelInfo> providerModels = provider.getModels();
        if (providerModels == null) {
            providerModels = Collections.emptyList();
        }

        int syncCount = 0;      // 新增/更新的模型数（用于前端提示）
        int removedCount = 0;   // 清理掉的已删除模型数
        String prefix = providerName + "-";

        // 本次提交后该供应商下的合法模型名集合，用于清理用户已删除的模型
        Set<String> validNames = new HashSet<>();

        for (ModelInfo modelInfo : providerModels) {
            String modelId = modelInfo.getId();
            if (Assert.isEmpty(modelId)) {
                continue;
            }

            String modelName = prefix + modelId;
            validNames.add(modelName);
            
            // 如果模型不存在，创建新模型配置
            if (!settings.getModels().containsKey(modelName)) {
                ModelDo modelDo = new ModelDo();
                modelDo.setName(modelName);
                modelDo.setModel(modelId);
                modelDo.setStandard(resolveModelStandard(modelInfo, provider));
                modelDo.setApiUrl(provider.getApiUrl());
                modelDo.setApiKey(provider.getApiKey());
                modelDo.setScope(provider.getScope());
                modelDo.setProvider(providerName);
                // 连接开关 与 按模型启用态 取与：连接禁用时模型一律不可见
                modelDo.setVisibled(provider.isEnabled() && (modelInfo.getEnabled() == null || modelInfo.getEnabled()));
                if (provider.getTimeout() != null) {
                    modelDo.setTimeout(provider.getTimeout());
                }

                // 设置 contextLength：优先 maxInputTokens；
                // ⚠️ maxTokens 在多数供应商语义里是「最大输出 token」而非上下文窗口，
                // 直接当窗口用会把 contextLength 误设为 8192 之类的小值 → 该模型每轮都触发压缩。
                // 故仅在其大到不可能是纯输出上限时才采信；否则保持 0，回退到默认上下文长度。
                if (modelInfo.getMaxInputTokens() != null && modelInfo.getMaxInputTokens() > 0) {
                    modelDo.setContextLength(modelInfo.getMaxInputTokens());
                } else if (modelInfo.getMaxTokens() != null
                        && modelInfo.getMaxTokens() >= MIN_TRUSTWORTHY_CONTEXT_LENGTH) {
                    modelDo.setContextLength(modelInfo.getMaxTokens());
                }
                
                settings.getModels().put(modelName, modelDo);
                engine.addModel(modelDo);
                syncCount++;
            } else {
                // 模型已存在，检查是否需要同步状态
                ModelDo existingModel = (ModelDo) settings.getModels().get(modelName);
                if (providerName.equals(existingModel.getProvider())) {
                    // 连接开关 与 按模型启用态 取与，未单独设置时回退到供应商启用状态
                    boolean targetVisibled = provider.isEnabled() && (modelInfo.getEnabled() == null || modelInfo.getEnabled());
                    boolean visibledChanged = existingModel.isVisibled() != targetVisibled;
                    if (visibledChanged) {
                        existingModel.setVisibled(targetVisibled);
                        syncCount++;
                    }
                    // 同步连接参数（接口类型按模型、地址/密钥/超时按连接）
                    String newStandard = resolveModelStandard(modelInfo, provider);
                    if (newStandard != null && !newStandard.equals(existingModel.getStandard())) {
                        existingModel.setStandard(newStandard);
                        syncCount++;
                    }
                    if (provider.getApiUrl() != null && !provider.getApiUrl().equals(existingModel.getApiUrl())) {
                        existingModel.setApiUrl(provider.getApiUrl());
                        syncCount++;
                    }
                    if (provider.getApiKey() != null && !provider.getApiKey().equals(existingModel.getApiKey())) {
                        existingModel.setApiKey(provider.getApiKey());
                        syncCount++;
                    }
                    if (provider.getTimeout() != null && !provider.getTimeout().equals(existingModel.getTimeout())) {
                        existingModel.setTimeout(provider.getTimeout());
                        syncCount++;
                    }
                    // 更新 contextLength：优先 maxInputTokens，其次 maxTokens；
                    // 供应商不报 token 上限时保留用户已有值（newContextLength=0 不触发更新）
                    long newContextLength = 0;
                    if (modelInfo.getMaxInputTokens() != null && modelInfo.getMaxInputTokens() > 0) {
                        newContextLength = modelInfo.getMaxInputTokens();
                    } else if (modelInfo.getMaxTokens() != null
                            && modelInfo.getMaxTokens() >= MIN_TRUSTWORTHY_CONTEXT_LENGTH) {
                        // 同上：maxTokens 通常是输出上限，小值不可信，不能当上下文窗口
                        newContextLength = modelInfo.getMaxTokens();
                    }
                    if (newContextLength > 0 && existingModel.getContextLength() != newContextLength) {
                        existingModel.setContextLength(newContextLength);
                        syncCount++;
                    }
                    // visibled 变化时即时同步运行时引擎（字段类修改直接作用于引擎持有的同一实例，无需重加）
                    if (visibledChanged) {
                        if (targetVisibled) {
                            engine.addModel(existingModel);
                        } else {
                            engine.removeModel(modelName);
                        }
                    }
                }
            }
        }

        // 清理该供应商下、已被用户删除的模型（不在本次提交列表中的 ModelDo）
        Iterator<Map.Entry<String, ModelDo>> it = settings.getModels().entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, ModelDo> entry = it.next();
            ModelDo model = entry.getValue();
            if (providerName.equals(model.getProvider()) && !validNames.contains(entry.getKey())) {
                it.remove();
                engine.removeModel(entry.getKey());
                removedCount++;
                LOG.info("[Settings] Model removed on provider sync: {}", entry.getKey());
            }
        }

        if (syncCount > 0 || removedCount > 0) {
            saveSettings();
        }

        LOG.info("[Settings] Synced {} models (removed {}) from provider: {}", syncCount, removedCount, providerName);
        return Result.succeed(syncCount);
    }

    /**
     * 解析请求超时（形如 "120s"），无值时返回 fallback。
     */
    private Duration parseTimeout(ONode root, Duration fallback) {
        if (root.hasKey("timeout")) {
            String t = root.get("timeout").getString();
            if (t != null && !t.trim().isEmpty()) {
                t = t.trim();
                try {
                    if (t.endsWith("s") || t.endsWith("S")) {
                        return Duration.ofSeconds(Long.parseLong(t.substring(0, t.length() - 1).trim()));
                    }
                    if (t.startsWith("PT") || t.startsWith("pt")) {
                        return Duration.parse(t);
                    }
                    return Duration.ofSeconds(Long.parseLong(t));
                } catch (Exception e) {
                    LOG.warn("[Settings] Invalid provider timeout: {}", t);
                }
            } else {
                // 显式传空 -> 清除
                return null;
            }
        }
        return fallback;
    }

    /**
     * 解析供应商模型列表（ModelInfo），保留每个模型的接口类型 standard。
     *
     * <p>前端提交的列表即为权威来源（含手动与拉取模型的全量）。此处不再回补旧列表中缺失的模型，
     * 否则用户删除手动模型后会被重新补回、删除无法生效。</p>
     */
    private List<ModelInfo> parseProviderModels(ONode modelsNode) {
        List<ModelInfo> models = new ArrayList<>();
        for (ONode modelNode : modelsNode.getArray()) {
            ModelInfo modelInfo = new ModelInfo();
            modelInfo.setId(modelNode.get("id").getString());
            if (modelNode.hasKey("standard")) {
                String std = modelNode.get("standard").getString();
                if (std != null && !std.isEmpty()) {
                    modelInfo.setStandard(std);
                }
            }
            if (modelNode.hasKey("displayName")) {
                modelInfo.setDisplayName(modelNode.get("displayName").getString());
            }
            if (modelNode.hasKey("maxTokens")) {
                modelInfo.setMaxTokens(modelNode.get("maxTokens").getLong());
            }
            if (modelNode.hasKey("maxInputTokens")) {
                modelInfo.setMaxInputTokens(modelNode.get("maxInputTokens").getLong());
            }
            if (modelNode.hasKey("manual")) {
                modelInfo.setManual(modelNode.get("manual").getBoolean());
            }
            if (modelNode.hasKey("enabled")) {
                modelInfo.setEnabled(modelNode.get("enabled").getBoolean());
            }
            models.add(modelInfo);
        }
        return models;
    }

    /**
     * 确定同步到 ModelDo 的接口类型：优先模型自身 standard，回退到连接级 standard。
     */
    private String resolveModelStandard(ModelInfo modelInfo, ProviderDo provider) {
        if (modelInfo.getStandard() != null && !modelInfo.getStandard().isEmpty()) {
            return modelInfo.getStandard();
        }
        return provider.getStandard();
    }

    /**
     * API 密钥脱敏处理
     */
    private String maskApiKey(String apiKey) {
        if (apiKey == null || apiKey.isEmpty()) {
            return "";
        }
        if (apiKey.length() <= 8) {
            return "****";
        }
        return apiKey.substring(0, 4) + "****" + apiKey.substring(apiKey.length() - 4);
    }

    // ==================== 设置：Skills 市场（委派给 Market 接口） ====================

    /**
     * 获取所有可用市场列表
     */
    @Get
    @Mapping("/web/settings/skills/markets")
    public Result skillsMarkets(Context ctx) {
        return Result.succeed(marketManager.getMarketInfos());
    }

    /**
     * 技能市场代理接口 — 获取热门技能或搜索技能（cursor 游标分页）。
     * <p>所有外部 API 调用均由后端 Market 适配器完成，前端不直接访问外部服务。</p>
     * <p>返回数据为 {@code {items:[...], nextCursor:"..."}}，下次请求携带 nextCursor 加载下一页；
     * nextCursor 为空表示没有更多数据。</p>
     *
     * @param action     "trending" 获取热门 | "search" 搜索
     * @param query      搜索关键词（action=search 时使用）
     * @param cursor     上一页返回的游标（首次加载不传）
     * @param limit      每页返回数量限制（默认 20）
     * @param marketName 市场名字（可选，默认使用 Skillhub）
     */
    @Get
    @Mapping("/web/settings/skills/proxy")
    public Result skillsProxy(Context ctx, @Param(value = "action", defaultValue = "trending") String action,
                              @Param(value = "q", defaultValue = "") String query,
                              @Param(value = "cursor", defaultValue = "") String cursor,
                              @Param(value = "limit", defaultValue = "20") int limit,
                              @Param(value = "marketName", defaultValue = "") String marketName) {
        if (limit < 1) limit = 20;
        if (limit > 100) limit = 100;

        Market market = marketManager.getMarketByName(marketName);
        if ("search".equals(action) && query != null && !query.isEmpty()) {
            return market.search(query, cursor, limit);
        } else {
            return market.trending(cursor, limit);
        }
    }

    /**
     * 安装技能 — 委派给 Market 适配器完成下载、解压，然后刷新技能池。
     *
     * @param slug       技能 slug（必填）
     * @param marketName 市场名称（可选）
     * @param mountAlias 挂载点别名（可选，默认安装到 workspace/skills）
     */
    @Post
    @Mapping("/web/settings/skills/install")
    public Result skillsInstall(Context ctx, @Param("slug") String slug,
                                @Param(value = "marketName", defaultValue = "") String marketName,
                                @Param(value = "mountAlias", defaultValue = "") String mountAlias) {
        if (Assert.isEmpty(slug)) {
            return Result.failure("slug is required");
        }

        Market market = marketManager.getMarketByName(marketName);

        // 确定安装目标目录：若指定了挂载别名，则安装到对应池目录；否则默认 workspace/skills
        Path skillsDir;
        if (!Assert.isEmpty(mountAlias)) {
            MountDir poolDir = engine.getMount(mountAlias);
            if (poolDir == null) {
                return Result.failure("挂载池不存在: " + mountAlias);
            }

            skillsDir = poolDir.getRealPath();
        } else {
            skillsDir = Paths.get(engine.getWorkspace(), "skills");
        }

        Result<String> result = market.install(slug, skillsDir);

        // 安装成功后刷新技能池
        if (result.getCode() == 200) {
            engine.refreshMount(mountAlias);
        }

        return result;
    }

    /**
     * 获取已安装技能列表 — 汇总所有挂载池中的技能（按名称去重，保留首次出现）。
     * <p>供技能市场「已安装」视图展示，字段与 /web/chat/hints 中的技能项保持一致。</p>
     */
    @Get
    @Mapping("/web/settings/skills/installed")
    public Result skillsInstalled(Context ctx) {
        List<Map<String, String>> skills = new ArrayList<>();
        Set<String> added = new HashSet<>();

        for (SkillDir skill : engine.getSkills()) {
            if (!added.add(skill.getName())) {
                continue;
            }

            String desc = skill.getDescription();
            if (desc != null) {
                // 取第一行，并限制最大长度
                int newlineIdx = desc.indexOf('\n');
                if (newlineIdx > 0) {
                    desc = desc.substring(0, newlineIdx);
                }
                if (desc.length() > 120) {
                    desc = desc.substring(0, 120) + "...";
                }
            }

            Map<String, String> item = new LinkedHashMap<>();
            item.put("name", skill.getName());
            item.put("description", desc != null ? desc : "");
            item.put("mountAlias", skill.getMountAlias() != null ? skill.getMountAlias() : "");
            skills.add(item);
        }

        return Result.succeed(skills);
    }

    // ==================== 设置：挂载池管理 ====================

    /**
     * 获取所有挂载池列表（含系统池标记）
     */
    @Get
    @Mapping("/web/settings/mounts")
    public Result mountsList(Context ctx) {
        List<Map<String, Object>> list = new ArrayList<>();

        for (MountDir entry : engine.getMounts()) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("alias", entry.getAlias());
            item.put("type", entry.getType());
            item.put("path", entry.getPath());
            item.put("enabled", entry.isEnabled());
            item.put("system", entry.isPrimary());
            item.put("writeable", entry.isWriteable());
            item.put("realPath", entry.getRealPath() != null ? entry.getRealPath().toString() : "");
            item.put("description", entry.getDescription());


            MountDo mountDo = settings.getMountPools().get(entry.getAlias());
            if (mountDo == null) {
                item.put("scope", AgentFlags.SCOPE_USER);
            } else {
                item.put("scope", mountDo.getScope());
            }

            list.add(item);
        }

        sortByName(list, "alias");

        return Result.succeed(list);
    }

    /**
     * 添加挂载池
     */
    @Post
    @Mapping("/web/settings/mounts/add")
    public Result mountsAdd(Context ctx, @Param("description") String description, @Param("alias") String alias, @Param("path") String path, @Param("type") MountType type, @Param("writeable") boolean writeable, @Param("scope") String scope) {
        if (Assert.isEmpty(alias) || Assert.isEmpty(path)) return Result.failure("参数不完整");

        if (alias.startsWith("@") == false) {
            alias = "@" + alias;
        }

        if (engine.hasMount(alias)) return Result.failure("别名已存在");


        if (type == null) {
            type = MountType.SKILLS;
        }

        if (Assert.isEmpty(scope) || (!AgentFlags.SCOPE_LOCAL.equals(scope))) {
            scope = AgentFlags.SCOPE_USER;
        }

        MountDo mountDo = new MountDo(
                scope,
                description,
                type,
                path,
                false, true, writeable);
        settings.getMountPools().put(alias, mountDo);
        saveSettings();
        engine.addMount(MountDir.builder()
                .alias(alias)
                .type(type)
                .path(path)
                .writeable(writeable)
                .build());
        return Result.succeed("添加成功");
    }

    /**
     * 更新挂载池（只允许修改描述和可写属性）
     */
    @Post
    @Mapping("/web/settings/mounts/update")
    public Result mountsUpdate(Context ctx, @Param("alias") String alias, @Param("description") String description, @Param("writeable") boolean writeable) {
        if (Assert.isEmpty(alias)) return Result.failure("参数不完整");

        if (alias.startsWith("@") == false) {
            alias = "@" + alias;
        }

        if (!engine.hasMount(alias)) return Result.failure("挂载池不存在");

        // 更新配置中的数据
        MountDo mountDo = settings.getMountPools().get(alias);
        if (mountDo != null) {
            mountDo.setDescription(description);
            mountDo.setWriteable(writeable);
        }

        // 更新运行时挂载
        for (MountDir entry : engine.getMounts()) {
            if (alias.equals(entry.getAlias())) {
                entry.setDescription(description);
                entry.setWriteable(writeable);
                break;
            }
        }

        saveSettings();
        return Result.succeed("更新成功");
    }

    /**
     * 切换挂载池启用/停用
     */
    @Post
    @Mapping("/web/settings/mounts/toggle")
    public Result mountsToggle(@Param("alias") String alias, @Param("enabled") Boolean enabled) {
        if (Assert.isEmpty(alias)) {
            return Result.failure("alias is required");
        }

        MountDir mountDir = engine.getMount(alias);
        if (mountDir == null) {
            return Result.failure("挂载池不存在: " + alias);
        } else {
            mountDir.setEnabled(enabled);
        }

        // 更新配置
        MountDo mountDo = settings.getMountPools().get(alias);
        if (mountDo != null) {
            mountDo.setEnabled(enabled);
        }

        saveSettings();
        LOG.info("[Settings] Mount toggled: {} -> {}", alias, enabled);
        return Result.succeed();
    }

    /**
     * 移除挂载池
     */
    @Post
    @Mapping("/web/settings/mounts/remove")
    public Result mountsRemove(@Param("alias") String alias) {
        MountDir mountDir = engine.getMount(alias);
        if (mountDir == null) {
            return Result.failure("挂载池不存在");
        }

        if (mountDir.isPrimary()) {
            return Result.failure("系统挂载池不可移除");
        }

        settings.getMountPools().remove(alias);
        saveSettings();
        engine.removeMount(alias);
        return Result.succeed("移除成功");
    }

    /**
     * 获取某挂载池内的内容列表（根据类型分发）
     */
    @Get
    @Mapping("/web/settings/mounts/content")
    public Result mountsContent(@Param("alias") String alias, @Param("type") String type) {
        if (engine.hasMount(alias) == false) {
            return Result.failure("挂载池不存在: " + alias);
        }

        if ("AGENTS".equals(type)) {
            return loadAgentsContent(alias);
        } else if ("FILES".equals(type)) {
            return Result.succeed(Collections.emptyList());
        } else {
            return loadSkillsContent(alias);
        }
    }

    private Result loadSkillsContent(String alias) {
        Collection<SkillDir> skillDirList = engine.getSkillsByMount(alias);
        List<Map<String, String>> skills = new ArrayList<>();

        for (SkillDir subDir : skillDirList) {
            Map<String, String> skillItem = new LinkedHashMap<>();
            skillItem.put("name", subDir.getName());
            skillItem.put("description", subDir.getDescription());
            skillItem.put("realPath", subDir.getRealPath() != null ? subDir.getRealPath().toString() : "");
            skills.add(skillItem);
        }

        return Result.succeed(skills);
    }

    private Result loadAgentsContent(String alias) {
        Collection<AgentMd> agentList = engine.getAgentsByMount(alias);
        List<Map<String, String>> agents = new ArrayList<>();

        for (AgentMd agent : agentList) {
            Map<String, String> agentItem = new LinkedHashMap<>();
            agentItem.put("name", agent.getName());
            agentItem.put("filePath", agent.getFilePath() != null ? agent.getFilePath().toString() : "");
            agents.add(agentItem);
        }

        return Result.succeed(agents);
    }

    /**
     * 打开挂载池的真实目录
     */
    @Get
    @Mapping("/web/settings/mounts/open")
    public Result mountsOpen(@Param("path") String path) {
        if (Assert.isEmpty(path)) return Result.failure("路径为空");
        try {
            File dir = new File(path);
            if (!dir.exists()) return Result.failure("目录不存在: " + path);

            // 优先尝试 Desktop.open，失败时 fallback 到系统命令
            try {
                if (Desktop.isDesktopSupported()) {
                    Desktop.getDesktop().open(dir);
                    return Result.succeed("已打开");
                }
            } catch (Exception ignored) {
                // Desktop.open 失败，尝试 fallback
            }

            // Fallback: 使用系统命令打开目录
            String os = System.getProperty("os.name", "").toLowerCase();
            String[] cmd;
            if (os.contains("mac")) {
                cmd = new String[]{"open", dir.getAbsolutePath()};
            } else if (os.contains("win")) {
                cmd = new String[]{"explorer", dir.getAbsolutePath()};
            } else {
                cmd = new String[]{"xdg-open", dir.getAbsolutePath()};
            }
            new ProcessBuilder(cmd).start();
            return Result.succeed("已打开");
        } catch (Exception e) {
            return Result.failure("打开失败: " + e.getMessage());
        }
    }

    /**
     * 删除挂载池内的技能包
     */
    @Post
    @Mapping("/web/settings/mounts/skills/remove")
    public Result mountsSkillsRemove(@Param("alias") String alias, @Param("skillName") String skillName) {
        MountDir mountDir = engine.getMount(alias);
        if (mountDir == null) return Result.failure("挂载池不存在: " + alias);


        Path skillDir = mountDir.getRealPath().resolve(skillName);
        if (!Files.exists(skillDir)) return Result.failure("技能包不存在: " + skillName);

        // 安全校验：防止路径穿越
        if (!skillDir.normalize().startsWith(mountDir.getRealPath())) {
            return Result.failure("非法路径");
        }

        try {
            deleteRecursively(skillDir);
            engine.refreshMount(alias);
            return Result.succeed("删除成功");
        } catch (Exception e) {
            LOG.warn("[Settings] Failed to delete skill: {}", e.getMessage());
            return Result.failure("删除失败: " + e.getMessage());
        }
    }

    /**
     * 从供应商生成模型配置
     */
    @Post
    @Mapping("/web/settings/providers/generate")
    public Result providersGenerate(@Body String json) throws Exception {
        ONode root = ONode.ofJson(json);
        String providerName = root.get("providerName").getString();
        String standard = root.get("standard").getString("openai");
        String apiUrl = root.get("apiUrl").getString();
        String apiKey = root.get("apiKey").getString();
        String scope = root.get("scope").getString(AgentFlags.SCOPE_USER);
        
        // 解析模型列表
        ONode modelsNode = root.get("models");
        if (!modelsNode.isArray() || modelsNode.getArrayUnsafe().isEmpty()) {
            return Result.failure("请选择要生成的模型");
        }
        
        // 解析生成选项
        ONode optionsNode = root.get("options");
        String prefix = optionsNode.get("prefix").getString(providerName + "-");
        int timeout = optionsNode.get("timeout").getInt(120);
        boolean setDefault = optionsNode.get("setDefault").getBoolean(false);
        
        // 生成模型配置
        List<Map<String, Object>> generatedModels = new ArrayList<>();
        for (ONode modelNode : modelsNode.getArray()) {
            String modelId = modelNode.get("id").getString();
            if (Assert.isEmpty(modelId)) {
                continue;
            }
            
            // 生成模型名称
            String modelName = prefix + modelId;
            
            // 检查是否已存在同名模型
            if (settings.getModels().containsKey(modelName)) {
                LOG.warn("[Settings] Model already exists, skipping: {}", modelName);
                continue;
            }
            
            // 创建模型配置
            ModelDo modelDo = new ModelDo();
            modelDo.setName(modelName);
            modelDo.setModel(modelId);
            modelDo.setStandard(standard);
            modelDo.setApiUrl(apiUrl);
            modelDo.setApiKey(apiKey);
            modelDo.setScope(scope);
            modelDo.setProvider(providerName);  // 设置所属供应商
            
            // 设置超时时间
            if (timeout > 0) {
                modelDo.setTimeout(java.time.Duration.ofSeconds(timeout));
            }
            
            // 保存模型配置
            settings.getModels().put(modelName, modelDo);
            
            // 注入运行时引擎（即时生效，无需重启）
            engine.addModel(modelDo);
            
            // 记录生成的模型信息
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("name", modelName);
            item.put("model", modelId);
            item.put("standard", standard);
            item.put("scope", scope);
            generatedModels.add(item);
            
            LOG.info("[Settings] Model generated: {} (from provider: {})", modelName, providerName);
        }
        
        // 如果设置了默认模型，更新默认模型
        if (setDefault && !generatedModels.isEmpty()) {
            String firstModelName = (String) generatedModels.get(0).get("name");
            settings.setDefaultModel(firstModelName);
            LOG.info("[Settings] Default model set to: {}", firstModelName);
        }
        
        // 保存配置
        saveSettings();
        
        return Result.succeed(generatedModels);
    }

    /**
     * 按 Map 中指定 key 进行不区分大小写排序
     */
    private void sortByName(List<? extends Map> list, String key) {
        list.sort((a, b) -> {
            String nameA = (String) a.getOrDefault(key, "");
            String nameB = (String) b.getOrDefault(key, "");
            return nameA.compareToIgnoreCase(nameB);
        });
    }

    /**
     * 递归删除目录
     */
    private void deleteRecursively(Path path) throws Exception {
        if (Files.isDirectory(path)) {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(path)) {
                for (Path child : stream) deleteRecursively(child);
            }
        }
        Files.deleteIfExists(path);
    }

    // ==================== 设置：钉钉扫码绑定 ====================

    /**
     * 开始钉钉扫码绑定流程
     */
    @Post
    @Mapping("/web/settings/dingtalk/qr/start")
    public Result dingtalkQrStart(@Param("sessionId") String sessionId) {
        if (Assert.isEmpty(sessionId)) {
            return Result.failure("sessionId is required");
        }

        try {
            DingTalkQRBindManager.BindStartResult result =
                dingtalkQRManager.startQrBinding(sessionId);

            Map<String, Object> data = new LinkedHashMap<>();
            data.put("qrUrl", result.qrUrl);
            data.put("deviceCode", result.deviceCode);
            data.put("expiresIn", result.expiresIn);
            data.put("interval", result.interval);

            return Result.succeed(data);
        } catch (Exception e) {
            LOG.error("[Settings] DingTalk QR start failed: {}", e.getMessage(), e);
            return Result.failure("启动扫码失败: " + e.getMessage());
        }
    }

    /**
     * 轮询钉钉扫码绑定状态
     */
    @Post
    @Mapping("/web/settings/dingtalk/qr/poll")
    public Result dingtalkQrPoll(@Param("sessionId") String sessionId) {
        if (Assert.isEmpty(sessionId)) {
            return Result.failure("sessionId is required");
        }

        try {
            DingTalkAppRegistration.PollResult result =
                dingtalkQRManager.pollQrBinding(sessionId);

            Map<String, Object> data = new LinkedHashMap<>();
            data.put("status", result.status);
            data.put("message", result.message);

            if (result.isSuccess()) {
                data.put("clientId", result.clientId);
                data.put("clientSecret", result.clientSecret);
            }

            return Result.succeed(data);
        } catch (Exception e) {
            LOG.error("[Settings] DingTalk QR poll failed: {}", e.getMessage(), e);
            return Result.failure("轮询失败: " + e.getMessage());
        }
    }

    /**
     * 取消钉钉扫码绑定
     */
    @Post
    @Mapping("/web/settings/dingtalk/qr/cancel")
    public Result dingtalkQrCancel(@Param("sessionId") String sessionId) {
        if (Assert.isEmpty(sessionId)) {
            return Result.failure("sessionId is required");
        }

        try {
            dingtalkQRManager.cancelQrBinding(sessionId);
            return Result.succeed();
        } catch (Exception e) {
            LOG.error("[Settings] DingTalk QR cancel failed: {}", e.getMessage(), e);
            return Result.failure("取消失败: " + e.getMessage());
        }
    }

    // ==================== 设置：飞书扫码绑定 ====================

    /**
     * 开始飞书扫码绑定流程
     */
    @Post
    @Mapping("/web/settings/feishu/qr/start")
    public Result feishuQrStart(@Param("sessionId") String sessionId) {
        if (Assert.isEmpty(sessionId)) {
            return Result.failure("sessionId is required");
        }

        try {
            FeishuQRBindManager.BindStartResult result =
                feishuQRManager.startQrBinding(sessionId);

            Map<String, Object> data = new LinkedHashMap<>();
            data.put("qrUrl", result.qrUrl);
            data.put("deviceCode", result.deviceCode);
            data.put("expiresIn", result.expiresIn);
            data.put("interval", result.interval);

            return Result.succeed(data);
        } catch (Exception e) {
            LOG.error("[Settings] Feishu QR start failed: {}", e.getMessage(), e);
            return Result.failure("启动扫码失败: " + e.getMessage());
        }
    }

    /**
     * 轮询飞书扫码绑定状态
     */
    @Post
    @Mapping("/web/settings/feishu/qr/poll")
    public Result feishuQrPoll(@Param("sessionId") String sessionId) {
        if (Assert.isEmpty(sessionId)) {
            return Result.failure("sessionId is required");
        }

        try {
            FeishuAppRegistration.PollResult result =
                feishuQRManager.pollQrBinding(sessionId);

            Map<String, Object> data = new LinkedHashMap<>();
            data.put("status", result.status);
            data.put("message", result.message);

            if (result.isSuccess()) {
                data.put("clientId", result.clientId);
                data.put("clientSecret", result.clientSecret);
                data.put("openId", result.openId);
            }

            return Result.succeed(data);
        } catch (Exception e) {
            LOG.error("[Settings] Feishu QR poll failed: {}", e.getMessage(), e);
            return Result.failure("轮询失败: " + e.getMessage());
        }
    }

    /**
     * 取消飞书扫码绑定
     */
    @Post
    @Mapping("/web/settings/feishu/qr/cancel")
    public Result feishuQrCancel(@Param("sessionId") String sessionId) {
        if (Assert.isEmpty(sessionId)) {
            return Result.failure("sessionId is required");
        }

        try {
            feishuQRManager.cancelQrBinding(sessionId);
            return Result.succeed();
        } catch (Exception e) {
            LOG.error("[Settings] Feishu QR cancel failed: {}", e.getMessage(), e);
            return Result.failure("取消失败: " + e.getMessage());
        }
    }

    // ==================== 设置：Coding 编码工具接入（ACP） ====================

    /**
     * 获取编码工具接入（ACP）所需的环境信息。
     *
     * <p>ACP 采用官方标准的 stdio 传输：编辑器（Zed/VSCode/IDEA 等）作为客户端，
     * 自行将 {@code gwork acp} 作为子进程拉起并通过标准输入输出通信，无需监听端口。
     * 因此后端不需要、也无法“开启”一个常驻 ACP 服务，本接口仅为前端提供生成编辑器配置片段所
     * 需的事实：操作系统、用户主目录、{@code gwork} 启动器绝对路径及其就绪状态。</p>
     *
     * <p>启动器由桌面端 {@code cli-provision.js} 写入安装目录的 {@code .gwork/bin}：
     * Windows 为 {@code gwork.bat}，macOS/Linux 为无扩展名的 {@code gwork}。</p>
     */
    @Get
    @Mapping("/web/settings/acp/info")
    public Result<Map<String, Object>> codingInfo() {
        Map<String, Object> data = new LinkedHashMap<>();

        String osName = System.getProperty("os.name", "").toLowerCase();
        boolean isWindows = osName.contains("win");
        String os = isWindows ? "windows" : (osName.contains("mac") ? "mac" : "linux");

        String userHome = AgentFlags.getUserHome();
        String harnessBase = AgentFlags.getHarnessBase();
        // 启动器绝对路径：Windows 用 gwork.bat，其它平台用无扩展名 gwork（与 cli-provision.js 一致）
        // 与后端/桌面端统一：启动器落安装目录 <base>/.gwork/bin，不再读用户主目录
        String launcherName = isWindows ? "gwork.bat" : "gwork";
        Path launcherPath = Paths.get(harnessBase, AgentFlags.getHarnessHome(), "bin", launcherName);
        if (!Files.exists(launcherPath)) {
            // 过渡兼容：桌面端尚未升级（仍写 .gourdai/bin/gourdai）时回退旧启动器，确保 ACP 可用
            String legacyName = isWindows ? "gourdai.bat" : "gourdai";
            Path legacyPath = Paths.get(harnessBase, ".gourdai", "bin", legacyName);
            if (Files.exists(legacyPath)) {
                launcherPath = legacyPath;
            }
        }
        boolean ready = Files.exists(launcherPath);

        data.put("os", os);
        data.put("userHome", userHome);
        // Windows 下编辑器 ACP 客户端（Node.js spawn / Rust subprocess）无法直接执行 .bat 文件，
        // 需通过 cmd.exe /c 包装。macOS/Linux 直接返回启动器路径。
        if (isWindows) {
            data.put("command", "cmd");
            data.put("args", Arrays.asList("/c", launcherPath.toAbsolutePath().toString(), AgentFlags.FLAG_ACP));
        } else {
            data.put("command", launcherPath.toAbsolutePath().toString());
            data.put("args", Collections.singletonList(AgentFlags.FLAG_ACP));
        }
        data.put("ready", ready);

        // ACP 走独立子进程，无前端会话态可选模型，因此其使用的模型由本页预先选定（存入 general.acpModel）。
        // 回传当前选定值与可选模型列表（仅已启用的），供前端渲染下拉框。
        data.put("acpModel", settings.getGeneral().getAcpModel());
        // 与 /web/chat/models 的 selected 同口径：下发引擎解析后的实际生效模型名，而非 settings 原始值。
        // settings.getDefaultModel() 可能为空或指向已删除模型，此时引擎实际回落到模型表首项 ——
        // 若直接下发原始值，前端「未显式选模」时会找不到可高亮的项。
        data.put("defaultModel", resolveEffectiveModelName(null));
        // 思考深度
        data.put("acpThinkingDepth", settings.getGeneral().getAcpThinkingDepth());
        // acpModel 对应的接口类型，供前端确定思考档位选项集（置空时同样回落实际生效模型）
        data.put("acpModelStandard", getModelStandard(settings.getGeneral().getAcpModel()));

        // models 由纯字符串数组升级为 {name, provider} 对象数组，供前端按供应商分组展示下拉
        List<Map<String, Object>> modelItems = new ArrayList<>();
        for (ModelDo config : settings.getModels().values()) {
            if (config.isVisibled() && config.isEnabled()) {
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("name", config.getNameOrModel());
                item.put("provider", config.getProvider());
                // 接口类型随列表下发：切换模型后前端无需重拉页面即可更新关联的思考档位选项集
                item.put("standard", config.getStandardOrProvider());
                modelItems.add(item);
            }
        }
        data.put("models", modelItems);

        return Result.succeed(data);
    }

    /**
     * 保存 ACP（编码工具接入）使用的模型。
     *
     * <p>ACP 以独立子进程运行，不共享 Web/桌面端的会话选模状态，故其模型需在此预先
     * 指定并持久化到 {@code general.acpModel}。留空表示回退到 {@code defaultModel}。保存后
     * ACP 子进程下次启动（或下一次 prompt 重新读取 settings）即生效。</p>
     */
    @Post
    @Mapping("/web/settings/acp/model/save")
    public Result codingModelSave(@Param("acpModel") String acpModel) {
        // 允许置空（回退 defaultModel）；trim 后空串归一为 null
        String value = Assert.isEmpty(acpModel) ? null : acpModel.trim();
        if (Assert.isNotEmpty(value) && settings.getModels().containsKey(value) == false) {
            return Result.failure("Model not found: " + value);
        }

        settings.getGeneral().setAcpModel(value);
        saveSettings();
        LOG.info("[Settings] ACP model updated: {}", value);
        return Result.succeed();
    }

    /**
     * 保存 ACP（编码工具接入）使用的思考深度。
     *
     * <p>ACP 以独立子进程运行，不共享 Web/桌面端的会话选模状态，故其思考深度需在此预先
     * 指定并持久化到 {@code general.acpThinkingDepth}。留空或 "off" 表示关闭思考模式。
     * 保存后 ACP 子进程下次启动（或下一次 prompt 重新读取 settings）即生效。</p>
     */
    @Post
    @Mapping("/web/settings/acp/thinking/save")
    public Result codingThinkingSave(@Param("acpThinkingDepth") String acpThinkingDepth) {
        String value = Assert.isEmpty(acpThinkingDepth) ? null : acpThinkingDepth.trim();
        if (value == null) {
            value = "off";
        }

        settings.getGeneral().setAcpThinkingDepth(value);
        saveSettings();
        LOG.info("[Settings] ACP thinking depth updated: {}", value);
        return Result.succeed();
    }

    /**
     * 解析模型名实际生效的模型。
     *
     * <p>与 {@code /web/chat/models} 下发 {@code selected} 同口径（均走
     * {@link HarnessEngine#getModelOrDef(String)}）：传空或传入已失效的模型名时，回落到
     * {@code defaultModel}；{@code defaultModel} 也空或悬空时再回落模型表首项。
     * 前端据此能拿到一个总存在于下拉列表中的具体模型名，无需再给「跟随默认」单独建项。</p>
     *
     * @return 实际生效的模型名；一个模型都没配时返回空串
     */
    private String resolveEffectiveModelName(String modelName) {
        ChatConfig config = engine.getModelOrDef(modelName);
        return config == null ? "" : config.getNameOrModel();
    }

    /**
     * 获取模型的接口类型（standard）。
     * 如果模型不存在或为空，则返回默认模型的接口类型。
     */
    private String getModelStandard(String modelName) {
        // 与 defaultModel 同口径走引擎解析：空值、悬空或已禁用的模型名均回落到实际生效模型，
        // 否则 defaultModel 未配置时这里会返回空串，前端思考档位选项集会退化到通用集。
        String targetModel = resolveEffectiveModelName(modelName);
        if (Assert.isEmpty(targetModel)) {
            return "";
        }
        com.gourdai.core.config.entity.ModelDo modelConfig = settings.getModels().get(targetModel);
        if (modelConfig != null) {
            return modelConfig.getStandardOrProvider() != null ? modelConfig.getStandardOrProvider() : "";
        }
        return "";
    }
}
