package com.gourdai.core.config;

import com.gourdai.core.config.entity.*;
import lombok.Getter;
import lombok.Setter;
import org.noear.solon.core.util.Assert;
import org.noear.snack4.Feature;
import org.noear.snack4.ONode;
import org.noear.snack4.Options;
import org.noear.solon.ai.talents.mount.MountType;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.Serializable;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 对应 <安装目录>/.gourdai/settings.json
 * <p>统一管理 LLM 模型、MCP 服务器、OpenApi 服务器的持久化配置。</p>
 *
 * @author oisin
 */
@Getter
@Setter
public class AgentSettings implements Serializable {
    private static final Logger LOG = LoggerFactory.getLogger(AgentSettings.class);

    //general 常规
    private final GeneralGroupDo general = new GeneralGroupDo();
    //permission 权限
    private final PermissionGroupDo permission = new PermissionGroupDo();

    //defaultModel
    private String defaultModel;
    //models
    private Map<String, ModelDo> models = new LinkedHashMap<>();
    //挂载
    private Map<String, MountDo> mountPools = new LinkedHashMap<>();

    //mcp集
    private Map<String, McpServerDo> mcpServers = new LinkedHashMap<>();
    //api集
    private Map<String, ApiSourceDo> apiServers = new LinkedHashMap<>();
    //lsp集
    private Map<String, LspServerDo> lspServers = new LinkedHashMap<>();
    //供应商集
    private Map<String, ProviderDo> providers = new LinkedHashMap<>();

    /** 内置连接：官方托管入口名称（锁定，不可改名/删除） */
    public static final String BUILTIN_PROVIDER_NAME = "GWork";
    /** 内置连接：品牌升级前的旧名称（仅用于存量配置迁移："Gourd AI" → "GWork"） */
    public static final String LEGACY_BUILTIN_PROVIDER_NAME = "Gourd AI";
    /** 内置连接：官方托管入口 API 地址（锁定，不可修改） */
    public static final String BUILTIN_PROVIDER_API_URL = "https://www.gourd-ai.cn";

    /**
     * 确保内置连接常驻：不存在则注入，存在则强制回写锁定字段（名称/地址/builtin 标记），
     * 同时保留用户可改字段（密钥、超时、作用域、启停、模型列表）。
     *
     * <p>密钥默认留空，由用户自行填写。每次启动加载后调用，实现"内置常驻、自动重建"。</p>
     */
    public void ensureBuiltinProviders() {
        // 品牌迁移：旧版配置中按旧名 "Gourd AI" 持久化的内置条目，原地改键为 GWork，
        // 保留用户已填密钥/模型列表，避免升级后出现新旧两个内置条目
        ProviderDo legacy = providers.get(LEGACY_BUILTIN_PROVIDER_NAME);
        if (legacy != null) {
            if (providers.containsKey(BUILTIN_PROVIDER_NAME) == false) {
                providers.remove(LEGACY_BUILTIN_PROVIDER_NAME);
                providers.put(BUILTIN_PROVIDER_NAME, legacy);
            } else {
                // 极罕见共存场景（手工新建过 GWork 条目）：旧条目降级为普通连接，
                // 数据不丢，但不再呈现为锁定的内置项
                legacy.setBuiltin(false);
            }
        }

        ProviderDo existing = providers.get(BUILTIN_PROVIDER_NAME);
        if (existing == null) {
            ProviderDo builtin = new ProviderDo();
            builtin.setName(BUILTIN_PROVIDER_NAME);
            builtin.setStandard("openai");
            builtin.setApiUrl(BUILTIN_PROVIDER_API_URL);
            builtin.setApiKey("");        // 密钥留空，由用户填写
            builtin.setEnabled(true);
            builtin.setScope(AgentFlags.SCOPE_USER);
            builtin.setBuiltin(true);
            providers.put(BUILTIN_PROVIDER_NAME, builtin);
        } else {
            // 已存在：强制回写锁定字段，防止历史数据或手工篡改导致名称/地址漂移
            existing.setName(BUILTIN_PROVIDER_NAME);
            existing.setApiUrl(BUILTIN_PROVIDER_API_URL);
            existing.setBuiltin(true);
            // 密钥/超时/作用域/启停/模型列表保持用户现有配置，不覆盖
        }
    }

    /**
     * 与 HarnessProperties（即 AgentProperties）双向合并。
     * <p>如果 settings 有数据，以 settings 为准同步到 props；
     * 如果 settings 为空，则从 props 补充到 settings。</p>
     */
    public void mergeFrom(AgentProperties props) {
        if (general.getHistoryWindowSize() == null) {
            general.setHistoryWindowSize(props.getHistoryWindowSize());
        }

        if (general.getCompressionRatio() == null) {
            general.setCompressionRatio(props.getCompressionRatio());
        }

        if (general.getCompressionTargetRatio() == null) {
            general.setCompressionTargetRatio(props.getCompressionTargetRatio());
        }

        if (general.getCompressionReservedOutputTokens() == null) {
            general.setCompressionReservedOutputTokens(props.getCompressionReservedOutputTokens());
        }

        if (general.getIntentChainEnabled() == null) {
            general.setIntentChainEnabled(props.isIntentChainEnabled());
        }

        if (general.getIntentChainMaxTokens() == null) {
            general.setIntentChainMaxTokens(props.getIntentChainMaxTokens());
        }

        if(general.getSummaryModel() == null){
            general.setSummaryModel(props.getSummaryModel());
        }

        if (general.getSandboxMode() == null) {
            general.setSandboxMode(props.isSandboxMode());
        }

        if (general.getSandboxAllowUserHome() == null) {
            general.setSandboxAllowUserHome(props.isSandboxAllowUserHome());
        }

        if (general.getSandboxSystemRestrict() == null) {
            general.setSandboxSystemRestrict(props.isSandboxSystemRestrict());
        }

        if (general.getApiRetries() == null) {
            general.setApiRetries(props.getApiRetries());
        }

        if (general.getMcpRetries() == null) {
            general.setMcpRetries(props.getMcpRetries());
        }

        if (general.getModelRetries() == null) {
            general.setModelRetries(props.getModelRetries());
        }

        if (general.getMemoryEnabled() == null) {
            general.setMemoryEnabled(props.isMemoryEnabled());
        }

        if (general.getMemoryIsolation() == null) {
            general.setMemoryIsolation(props.isMemoryIsolation());
        }

        if (general.getMcpEnabled() == null) {
            general.setMcpEnabled(props.isMcpEnabled());
        }

        if (general.getOpenApiEnabled() == null) {
            general.setOpenApiEnabled(props.isOpenApiEnabled());
        }

        if (general.getLspEnabled() == null) {
            general.setLspEnabled(props.isLspEnabled());
        }

        if(general.getUserAgent() == null){
            general.setUserAgent(props.getUserAgent());
        }

        if(general.getMaxTurns() == null) {
            general.setMaxTurns(props.getMaxTurns());

            if (general.getMaxTurns() == null) {
                general.setMaxTurns(20);
            }
        }

        if(general.getAutoRethink() == null){
            general.setAutoRethink(props.isAutoRethink());
        }

        if(general.getHitlEnabled() == null){
            general.setHitlEnabled(props.isHitlEnabled());
        }

        if(general.getSubagentEnabled() == null){
            general.setSubagentEnabled(props.isSubagentEnabled());
        }

        if(general.getCliPrintSimplified() == null){
            general.setCliPrintSimplified(props.isCliPrintSimplified());
        }

        if(general.getCliThinkPrinted() == null){
            general.setCliThinkPrinted(props.isThinkPrinted());
        }

        //-----------------------------------------------------

        if(permission.getTools().size() == 0) {
            permission.getTools().addAll(props.getTools());

            if (permission.getTools().size() == 0) {
                permission.getTools().add("**");
            }
        }

        if(permission.getDisallowedTools().size() == 0){
            permission.getDisallowedTools().addAll(props.getDisallowedTools());
        }

        //-----------------------------------------------------

        if (Assert.isEmpty(this.defaultModel)) {
            this.defaultModel = props.getDefaultModel();
        }

        if (this.models.size() == 0) {
            for (ModelDo modelDo : props.getModels()) {
                this.models.put(modelDo.getNameOrModel(), modelDo);
            }
        }

        // 合并完成后统一兜底：如果 defaultModel 未指定，取第一个模型
        if (Assert.isEmpty(this.defaultModel) && this.models.size() > 0) {
            this.defaultModel = this.models.values().iterator().next().getNameOrModel();
        }

        if (this.mcpServers.size() == 0) {
            this.mcpServers.putAll(props.getMcpServers());
        }

        if (this.apiServers.size() == 0) {
            this.apiServers.putAll(props.getApiServers());
        }

        if (this.mountPools.size() == 0) {
            for (Map.Entry<String, String> entry : props.getSkillPools().entrySet()) {
                this.mountPools.put(entry.getKey(), new MountDo(AgentFlags.SCOPE_USER, "", MountType.SKILLS, entry.getValue(), false, true, false));
            }
        }

        if (this.lspServers.size() == 0) {
            this.lspServers.putAll(props.getLspServers());
        }
    }

    /**
     * 从文件加载配置。
     *
     * <p>两级配置：<b>全局</b>（{@link AgentFlags#getHarnessBase()}，安装目录）与
     * <b>工作区</b>（{@link AgentFlags#getUserDir()}）。当二者不同一路径时，先加载全局，
     * 再让工作区<b>按存在的键覆盖标量/general/permission</b>；对集合类
     * （models/providers/mcpServers/apiServers/mountPools/lspServers）采用<b>叠加合并</b>：
     * 工作区同名键覆盖，其余保留全局条目。</p>
     *
     * <p>此举修复：ACP 子进程 cwd=工作区，若工作区 {@code settings.json} 的 {@code models} 为空
     * {@code {}}，早前的整体 bind 可能把全局模型清空，导致「未配置可用模型」。显式叠加后，
     * 空的工作区集合不再抹掉全局配置。</p>
     */
    public static AgentSettings loadFromFile() {
        try {
            Path globalFile = Paths.get(AgentFlags.getHarnessBase(), AgentFlags.getHarnessHome(), "settings.json").toAbsolutePath();
            Path localFile = Paths.get(AgentFlags.getUserDir(), AgentFlags.getHarnessHome(), "settings.json").toAbsolutePath();
            boolean isLocalAsGlobal = localFile.toString().equals(globalFile.toString());

            AgentSettings agentSettings = new AgentSettings();


            if (Files.exists(globalFile)) {
                //全局配置
                String json = new String(Files.readAllBytes(globalFile), "UTF-8");
                ONode oNode = ONode.ofJson(json);

                normalizeModelsNode(oNode);

                oNode.bindTo(agentSettings);
            }

            if (isLocalAsGlobal == false) {
                //如果本地文件，不同于全局文件
                if (Files.exists(localFile)) {
                    //工作区配置：先快照全局集合，bind 覆盖标量/general/permission 后再叠加合并集合，
                    //避免工作区空集合（如 "models": {}）抹掉全局条目
                    Map<String, ModelDo> gModels = new LinkedHashMap<>(agentSettings.models);
                    Map<String, MountDo> gMountPools = new LinkedHashMap<>(agentSettings.mountPools);
                    Map<String, McpServerDo> gMcpServers = new LinkedHashMap<>(agentSettings.mcpServers);
                    Map<String, ApiSourceDo> gApiServers = new LinkedHashMap<>(agentSettings.apiServers);
                    Map<String, LspServerDo> gLspServers = new LinkedHashMap<>(agentSettings.lspServers);
                    Map<String, ProviderDo> gProviders = new LinkedHashMap<>(agentSettings.providers);
                    String gDefaultModel = agentSettings.defaultModel;

                    String json = new String(Files.readAllBytes(localFile), "UTF-8");
                    ONode oNode = ONode.ofJson(json);

                    normalizeModelsNode(oNode);

                    oNode.bindTo(agentSettings);

                    //集合：以全局为底，工作区同名键覆盖、其余保留全局（叠加，不清空）
                    mergeMissing(agentSettings.models, gModels);
                    mergeMissing(agentSettings.mountPools, gMountPools);
                    mergeMissing(agentSettings.mcpServers, gMcpServers);
                    mergeMissing(agentSettings.apiServers, gApiServers);
                    mergeMissing(agentSettings.lspServers, gLspServers);
                    mergeMissing(agentSettings.providers, gProviders);

                    //defaultModel：工作区未显式指定则保留全局（bind 不会为缺失键赋 null，此处再兜底）
                    if (Assert.isEmpty(agentSettings.defaultModel)) {
                        agentSettings.defaultModel = gDefaultModel;
                    }
                }
            }

            agentSettings.ensureBuiltinProviders();

            return agentSettings;
        } catch (Exception e) {
            LOG.warn("[Settings] Failed to load settings from file: {}", e.getMessage());
            AgentSettings fallback = new AgentSettings();
            fallback.ensureBuiltinProviders();
            return fallback;
        }
    }

    /** 旧格式兼容：models 若为数组，转成 {name: item} 的对象形态。 */
    private static void normalizeModelsNode(ONode oNode) {
        ONode oModels = oNode.get("models");
        if (oModels.isArray()) {
            ONode map = new ONode().asObject();
            for (ONode item : oModels.getArrayUnsafe()) {
                map.set(item.get("name").getString(), item);
            }
            oNode.set("models", map);
        }
    }

    /**
     * 把 {@code base}（全局快照）中 {@code target} 尚未包含的键补回 target。
     * <p>target（工作区覆盖后的结果）同名键优先；base 仅填补缺失键，保证全局条目不被空集合抹掉。</p>
     */
    private static <T> void mergeMissing(Map<String, T> target, Map<String, T> base) {
        for (Map.Entry<String, T> entry : base.entrySet()) {
            if (target.containsKey(entry.getKey()) == false) {
                target.put(entry.getKey(), entry.getValue());
            }
        }
    }

    /**
     * 保存配置到文件
     */
    public void saveToFile() {
        try {
            Path globalFileOld = Paths.get(AgentFlags.getHarnessBase(), AgentFlags.getHarnessHome(), "config.yml").toAbsolutePath();
            Path localFileOld = Paths.get(AgentFlags.getUserDir(), AgentFlags.getHarnessHome(), "config.yml").toAbsolutePath();

            Path globalFile = Paths.get(AgentFlags.getHarnessBase(), AgentFlags.getHarnessHome(), "settings.json").toAbsolutePath();
            Path localFile = Paths.get(AgentFlags.getUserDir(), AgentFlags.getHarnessHome(), "settings.json").toAbsolutePath();
            boolean isLocalAsGlobal = localFile.toString().equals(globalFile.toString());

            Files.createDirectories(globalFile.getParent());
            Files.write(globalFile, getGlobalJson(isLocalAsGlobal).getBytes("UTF-8"));
            Files.deleteIfExists(globalFileOld); //有新配置后，去掉旧配置


            if (isLocalAsGlobal == false) {
                //如果本地文件，不同于全局文件
                Files.createDirectories(localFile.getParent());
                Files.write(localFile, getLocalJson().getBytes("UTF-8"));
                Files.deleteIfExists(localFileOld); //有新配置后，去掉旧配置
            }
        } catch (Exception e) {
            LOG.warn("[Settings] Failed to save settings to file: {}", e.getMessage());
        }
    }


    public String getGlobalJson(boolean isLocalAsGlobal) {
        ONode oNode = new ONode(Options.of(Feature.Write_PrettyFormat));
        oNode.getOrNew("general").fill(general);
        oNode.getOrNew("permission").fill(permission);

        oNode.set("defaultModel", this.defaultModel);

        oNode.getOrNew("models").asObject().then(map -> {
            for (Map.Entry<String, ModelDo> entry : models.entrySet()) {
                if (isLocalAsGlobal == false && AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope())) {
                    continue;
                }

                map.getOrNew(entry.getValue().getNameOrModel()).then(item -> {
                    item.fill(entry.getValue());
                    item.remove("userAgent");

                    if (entry.getValue().getTimeout() != null) {
                        item.set("timeout", entry.getValue().getTimeout().getSeconds() + "s");
                    }
                });
            }
        });

        oNode.getOrNew("mcpServers").asObject().then(map -> {
            for (Map.Entry<String, McpServerDo> entry : mcpServers.entrySet()) {
                if (isLocalAsGlobal == false && AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope())) {
                    continue;
                }

                map.getOrNew(entry.getKey()).then(item -> {
                    item.fill(entry.getValue());

                    if (entry.getValue().getTimeout() != null) {
                        item.set("timeout", entry.getValue().getTimeout().getSeconds() + "s");
                    }
                });
            }
        });

        oNode.getOrNew("apiServers").asObject().then(map -> {
            for (Map.Entry<String, ApiSourceDo> entry : apiServers.entrySet()) {
                if (isLocalAsGlobal == false && AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope())) {
                    continue;
                }

                map.getOrNew(entry.getKey()).then(item -> {
                    item.fill(entry.getValue());

                    if (entry.getValue().getTimeout() != null) {
                        item.set("timeout", entry.getValue().getTimeout().getSeconds() + "s");
                    }
                });
            }
        });

        oNode.getOrNew("mountPools").asObject().then(map -> {
            for (Map.Entry<String, MountDo> entry : mountPools.entrySet()) {
                if (isLocalAsGlobal == false && AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope())) {
                    continue;
                }

                map.getOrNew(entry.getKey()).fill(entry.getValue());
            }
        });

        oNode.getOrNew("lspServers").asObject().then(map -> {
            for (Map.Entry<String, LspServerDo> entry : lspServers.entrySet()) {
                if (isLocalAsGlobal == false && AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope())) {
                    continue;
                }

                map.getOrNew(entry.getKey()).fill(entry.getValue());
            }
        });

        oNode.getOrNew("providers").asObject().then(map -> {
            for (Map.Entry<String, ProviderDo> entry : providers.entrySet()) {
                if (isLocalAsGlobal == false && AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope())) {
                    continue;
                }

                map.getOrNew(entry.getKey()).then(item -> {
                    item.fill(entry.getValue());

                    if (entry.getValue().getTimeout() != null) {
                        item.set("timeout", entry.getValue().getTimeout().getSeconds() + "s");
                    }
                });
            }
        });

        return oNode.toJson();
    }

    public String getLocalJson() {
        ONode oNode = new ONode(Options.of(Feature.Write_PrettyFormat));

        oNode.getOrNew("models").asObject().then(map -> {
            for (Map.Entry<String, ModelDo> entry : models.entrySet()) {
                if (AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope()) == false) {
                    continue;
                }

                map.getOrNew(entry.getValue().getNameOrModel()).then(item -> {
                    item.fill(entry.getValue());
                    item.remove("userAgent");

                    if (entry.getValue().getTimeout() != null) {
                        item.set("timeout", entry.getValue().getTimeout().getSeconds() + "s");
                    }
                });
            }
        });

        oNode.getOrNew("mcpServers").asObject().then(map -> {
            for (Map.Entry<String, McpServerDo> entry : mcpServers.entrySet()) {
                if (AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope()) == false) {
                    continue;
                }

                map.getOrNew(entry.getKey()).then(item -> {
                    item.fill(entry.getValue());

                    if (entry.getValue().getTimeout() != null) {
                        item.set("timeout", entry.getValue().getTimeout().getSeconds() + "s");
                    }
                });
            }
        });

        oNode.getOrNew("apiServers").asObject().then(map -> {
            for (Map.Entry<String, ApiSourceDo> entry : apiServers.entrySet()) {
                if (AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope()) == false) {
                    continue;
                }

                map.getOrNew(entry.getKey()).then(item -> {
                    item.fill(entry.getValue());

                    if (entry.getValue().getTimeout() != null) {
                        item.set("timeout", entry.getValue().getTimeout().getSeconds() + "s");
                    }
                });
            }
        });

        oNode.getOrNew("mountPools").asObject().then(map -> {
            for (Map.Entry<String, MountDo> entry : mountPools.entrySet()) {
                if (AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope()) == false) {
                    continue;
                }

                map.getOrNew(entry.getKey()).fill(entry.getValue());
            }
        });

        oNode.getOrNew("lspServers").asObject().then(map -> {
            for (Map.Entry<String, LspServerDo> entry : lspServers.entrySet()) {
                if (AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope()) == false) {
                    continue;
                }

                map.getOrNew(entry.getKey()).fill(entry.getValue());
            }
        });

        oNode.getOrNew("providers").asObject().then(map -> {
            for (Map.Entry<String, ProviderDo> entry : providers.entrySet()) {
                if (AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope()) == false) {
                    continue;
                }

                map.getOrNew(entry.getKey()).then(item -> {
                    item.fill(entry.getValue());

                    if (entry.getValue().getTimeout() != null) {
                        item.set("timeout", entry.getValue().getTimeout().getSeconds() + "s");
                    }
                });
            }
        });

        return oNode.toJson();
    }
}