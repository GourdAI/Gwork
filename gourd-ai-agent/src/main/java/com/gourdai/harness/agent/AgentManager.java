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
package com.gourdai.harness.agent;

import com.gourdai.ai.talents.registry.AgentMd;
import com.gourdai.ai.talents.registry.TalentRegistry;
import com.gourdai.ai.talents.registry.TalentScope;
import org.noear.solon.core.util.ResourceUtil;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * 代理定义管理器
 *
 * @author oisin
 * @since 3.9.5
 */
public class AgentManager {
    private static final Logger LOG = LoggerFactory.getLogger(AgentManager.class);
    //产品自有命名空间：harness 已 fork 为 com.gourdai 源码，不再借用上游的资源路径，
    //避免未来重新引入上游 harness 依赖时出现同路径资源、由 classpath 顺序决定取哪份
    private static final String AGENT_MD_BASE = "META-INF/gourdai/agents/";

    private final TalentRegistry talentRegistry;
    private final Map<String, AgentDefinition> agentMap = new ConcurrentHashMap<>();


    /**
     * 完整构造（支持从 {@link TalentRegistry} 加载自定义代理）
     */
    public AgentManager(TalentRegistry talentRegistry) {
        this.talentRegistry = talentRegistry;
        loadBuiltinAgents();
    }

    private void loadBuiltinAgents() {
        loadAgentFile("bash", ResourceUtil.getResource(AGENT_MD_BASE + "bash.md"), null);
        loadAgentFile("explore", ResourceUtil.getResource(AGENT_MD_BASE + "explore.md"), null);
        loadAgentFile("plan", ResourceUtil.getResource(AGENT_MD_BASE + "plan.md"), null);
        loadAgentFile("general", ResourceUtil.getResource(AGENT_MD_BASE + "general.md"), null);
        loadAgentFile("git-summary", ResourceUtil.getResource(AGENT_MD_BASE + "git-summary.md"), null);
    }

    public void addAgentIfAbsent(AgentDefinition agentDefinition) {
        agentMap.putIfAbsent(agentDefinition.getName(), agentDefinition);
    }

    public void addAgent(AgentDefinition agentDefinition) {
        agentMap.put(agentDefinition.getName(), agentDefinition);
    }

    /**
     * 获取指定名称的代理（支持自定义代理）
     */
    public AgentDefinition getAgent(String agentName) {
        // 1. 优先从缓存取（含内置 + 注册表扫描解析的代理）
        AgentDefinition cached = agentMap.get(agentName);
        if (cached != null) {
            return cached;
        }

        // 2. 从 TalentRegistry 的 AgentMd 按需解析
        if (talentRegistry != null) {
            AgentMd agentMd = talentRegistry.getAgent(agentName);
            if (agentMd != null) {
                AgentDefinition definition = loadFromAgentMd(agentMd);
                agentMap.put(agentName, definition);
                return definition;
            }
        }

        throw new IllegalArgumentException("Agent not found: " + agentName);
    }

    /**
     * 检查代理是否已注册
     */
    public boolean hasAgent(String agentName) {
        if (agentMap.containsKey(agentName)) {
            return true;
        }
        if (talentRegistry != null) {
            return talentRegistry.getAgent(agentName) != null;
        }
        return false;
    }

    /**
     * 获取所有已注册的代理
     */
    public Collection<AgentDefinition> getAgents() {
        Map<String, AgentDefinition> all = new LinkedHashMap<>(agentMap);

        // 补充扫描到的自定义代理（未被缓存的）
        if (talentRegistry != null) {
            for (AgentMd agentMd : talentRegistry.getAgents()) {
                if (!all.containsKey(agentMd.getName())) {
                    AgentDefinition def = loadFromAgentMd(agentMd);
                    all.put(agentMd.getName(), def);
                    agentMap.put(agentMd.getName(), def); // 顺带缓存
                }
            }
        }

        return all.values().stream()
                .filter(a -> !a.getMetadata().isHidden())
                .collect(Collectors.toList());
    }

    /**
     * 清除所有代理
     */
    public void clear() {
        agentMap.clear();
    }

    /**
     * 仅清除自定义代理（保留内置代理）
     *
     * <p>内置代理的 scope 为 {@code null}（由 classpath 资源加载），扫描来的必有 scope，
     * 据此区分。原实现比较的是挂载别名字符串，语义等价。</p>
     */
    public void clearCustomAgents() {
        agentMap.entrySet().removeIf(e -> e.getValue().getScope() != null);
    }

    /**
     * 从 AgentMd 解析完整定义
     */
    private AgentDefinition loadFromAgentMd(AgentMd agentMd) {
        try {
            List<String> lines = Files.readAllLines(agentMd.getFilePath(), StandardCharsets.UTF_8);
            AgentDefinition definition = AgentDefinition.fromMarkdown(lines);

            String name = definition.getName();
            if (name == null || name.isEmpty()) {
                name = agentMd.getName();
            }

            definition.setScope(agentMd.getScope());
            return definition;
        } catch (IOException e) {
            LOG.error("Load agent failed from AgentMd: {}", agentMd.getFilePath(), e);
            throw new RuntimeException("Failed to load agent: " + agentMd.getName(), e);
        }
    }

    /**
     * 从 URL 加载代理定义（内置代理用）
     *
     * @param scope 归属作用域；内置代理传 {@code null}
     */
    public void loadAgentFile(String fileName, URL url, TalentScope scope) {
        if (url == null) {
            //资源缺失时必须告警：静默跳过会让子代理清单悄悄变空，主代理将无代理可委派
            LOG.warn("Load agent skipped, resource not found: {}{} (scope={})",
                    AGENT_MD_BASE, fileName.endsWith(".md") ? fileName : fileName + ".md", scope);
            return;
        }

        try {
            String[] fullContent = ResourceUtil.getResourceAsString(url).split("\n");

            loadAgentFile(fileName, Arrays.asList(fullContent), scope);
        } catch (IOException e) {
            LOG.error("Load agent failed, file: {}", url, e);
        }
    }

    public void loadAgentFile(String fileName, List<String> fullContent, TalentScope scope) {
        AgentDefinition definition = AgentDefinition.fromMarkdown(fullContent);

        String agentTypeName = definition.getName();

        if (agentTypeName == null || agentTypeName.isEmpty()) {
            //内置加载传入的是不带后缀的名字（如 "bash"），无条件截掉 3 个字符会得到 "b"
            agentTypeName = fileName.endsWith(".md")
                    ? fileName.substring(0, fileName.length() - 3)
                    : fileName;
        }

        if (scope != null) {
            definition.setScope(scope);
        }

        agentMap.put(agentTypeName, definition);
    }
}
