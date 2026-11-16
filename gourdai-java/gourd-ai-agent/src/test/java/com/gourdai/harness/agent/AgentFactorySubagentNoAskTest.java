/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.harness.agent;

import com.gourdai.agent.react.ReActAgent;
import com.gourdai.agent.util.AskUserTool;
import com.gourdai.agent.util.CompleteTaskTool;
import com.gourdai.ai.chat.ChatConfig;
import com.gourdai.ai.chat.ChatModel;
import com.gourdai.ai.chat.tool.FunctionTool;
import com.gourdai.harness.HarnessEngine;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Collection;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 子代理 headless 禁问与工具集分叉的行为测试（契约 §1.3 / §1.5 / §4）。
 *
 * <p>背景：子代理的 question 帧会被转发层丢弃（team/mod.rs:484-497），一旦挂起
 * 父代理只能死等。因此子代理构建路径必须：① `**` 展开剔除 ask_user；② 显式列名
 * ask_user 也不给；③ 系统提示词末尾注入「你无法向用户提问」条款；④ 不注册
 * complete_task（收尾语义由父代理承担）。主会话 `**` 保留 ask_user 并恒有
 * complete_task。</p>
 *
 * <p>走真实 AgentFactory.create 构建路径（而非源码扫描）：源码扫描只能验结构
 * 验不了执行，分叉点被改坏（如 isPrimary 取反）必须能被本测试抓住。</p>
 */
class AgentFactorySubagentNoAskTest {

    private static HarnessEngine engine() {
        ChatConfig config = new ChatConfig();
        config.setApiUrl("http://localhost:9/v1/chat/completions");
        config.setModel("stub-model");
        ChatModel model = new ChatModel(config);

        return HarnessEngine.of(null, null)
                .sessionProvider(sessionId -> new com.gourdai.agent.session.InMemoryAgentSession(sessionId))
                .modelAdd(config)
                .build();
    }

    private static AgentDefinition definition(boolean primary, String... tools) {
        AgentDefinition def = new AgentDefinition();
        def.setSystemPrompt("你是测试代理。");
        AgentDefinition.Metadata metadata = new AgentDefinition.Metadata();
        metadata.setName(primary ? "main" : "worker");
        metadata.setPrimary(primary);
        metadata.setTools(java.util.Arrays.asList(tools));
        def.setMetadata(metadata);
        return def;
    }

    private static boolean hasTool(ReActAgent agent, String name) {
        // 工具分两路挂载：defaultToolAdd 直接进 tools（ask_user/complete_task 走这路）；
        // talent 类工具（read/write/bash…）在请求组装期才由 TalentUtil 展开
        // talent.getTools(prompt) 合入 tools。构建期检查必须两路都查，
        // 否则会把「talent 尚未展开」误判成「工具被剔除」。
        Collection<FunctionTool> tools = agent.getConfig().getDefaultOptions().getTools();
        if (tools != null) {
            for (FunctionTool tool : tools) {
                if (tool != null && name.equals(tool.name())) {
                    return true;
                }
            }
        }
        for (org.noear.solon.core.util.RankEntity<com.gourdai.ai.chat.talent.Talent> item
                : agent.getConfig().getDefaultOptions().getModelOptions().talents()) {
            if (item == null || item.target == null) {
                continue;
            }
            Collection<FunctionTool> talentTools = item.target.getTools(null);
            if (talentTools == null) {
                continue;
            }
            for (FunctionTool tool : talentTools) {
                if (tool != null && name.equals(tool.name())) {
                    return true;
                }
            }
        }
        return false;
    }

    @Test
    @DisplayName("子代理 ** 展开剔除 ask_user，也不注册 complete_task")
    void subagentWildcardExcludesAskUserAndCompleteTask() {
        ReActAgent agent = AgentFactory.create(engine(), definition(false, "**")).build();

        assertFalse(hasTool(agent, AskUserTool.TOOL_NAME),
                "子代理 ** 展开不得含 ask_user（question 帧被转发层丢弃，挂起即父代理死等）");
        assertFalse(hasTool(agent, CompleteTaskTool.TOOL_NAME),
                "子代理不得注册 complete_task（收尾语义由父代理承担）");
        assertTrue(hasTool(agent, "read"), "** 展开的其余工具不受影响");
    }

    @Test
    @DisplayName("主会话 ** 保留 ask_user，且恒注册 complete_task")
    void primaryWildcardKeepsAskUserAndCompleteTask() {
        ReActAgent agent = AgentFactory.create(engine(), definition(true, "**")).build();

        assertTrue(hasTool(agent, AskUserTool.TOOL_NAME), "主会话 ** 必须保留 ask_user");
        assertTrue(hasTool(agent, CompleteTaskTool.TOOL_NAME), "主会话必须恒注册 complete_task");
    }

    @Test
    @DisplayName("子代理显式列名 ask_user / complete_task 同样被拒绝")
    void subagentExplicitNamesAreRejected() {
        ReActAgent agent = AgentFactory.create(engine(),
                definition(false, "read", "ask_user", "complete_task")).build();

        assertFalse(hasTool(agent, AskUserTool.TOOL_NAME), "显式列名也不得给子代理 ask_user");
        assertFalse(hasTool(agent, CompleteTaskTool.TOOL_NAME), "显式列名也不得给子代理 complete_task");
        assertTrue(hasTool(agent, "read"), "无关工具不受影响");
    }

    @Test
    @DisplayName("子代理系统提示词末尾注入 headless 禁问条款；主会话不注入")
    void subagentPromptCarriesNoAskClause() {
        ReActAgent subagent = AgentFactory.create(engine(), definition(false, "**")).build();
        ReActAgent primary = AgentFactory.create(engine(), definition(true, "**")).build();

        // getSystemPromptFor 会解引用 trace（talentInstruction），用最小桩；
        // 自定义提示词是常量 lambda，不依赖 trace 内容
        com.gourdai.agent.react.ReActTrace stubTrace = new com.gourdai.agent.react.ReActTrace() {
            @Override
            public com.gourdai.agent.react.ReActOptions getOptions() {
                return new com.gourdai.agent.react.ReActOptions(null);
            }
        };

        String subPrompt = subagent.getConfig().getSystemPromptFor(stubTrace, null);
        String primaryPrompt = primary.getConfig().getSystemPromptFor(stubTrace, null);

        assertTrue(subPrompt.contains("你无法向用户提问"), "子代理提示词必须含禁问条款（契约 §1.3）");
        assertTrue(subPrompt.endsWith(AgentFactory.SUBAGENT_NO_ASK_CLAUSE_CN),
                "条款必须在提示词末尾（覆盖前文可能的提问指引）");
        assertTrue(subPrompt.startsWith("你是测试代理。"), "自定义提示词主体不得被破坏");
        assertFalse(primaryPrompt.contains("你无法向用户提问"), "主会话不得注入禁问条款");
    }

    @Test
    @DisplayName("J2：空 systemPrompt 的子代理同样无条件注入禁问条款（旧实现漏注入）")
    void subagentWithEmptyPromptStillGetsNoAskClause() {
        AgentDefinition def = definition(false, "**");
        def.setSystemPrompt(""); // 真实可达：AgentDefinition 无默认值、markdown 空正文→空串

        ReActAgent subagent = AgentFactory.create(engine(), def).build();
        com.gourdai.agent.react.ReActTrace stubTrace = new com.gourdai.agent.react.ReActTrace() {
            @Override
            public com.gourdai.agent.react.ReActOptions getOptions() {
                return new com.gourdai.agent.react.ReActOptions(null);
            }
        };

        String prompt = subagent.getConfig().getSystemPromptFor(stubTrace, null);
        assertTrue(prompt != null && prompt.contains("你无法向用户提问"),
                "空 prompt 子代理必须收到禁问条款——旧实现只在非空时追加，此路径完全漏注入");
    }

    @Test
    @DisplayName("J2：null systemPrompt 的子代理同样注入禁问条款")
    void subagentWithNullPromptStillGetsNoAskClause() {
        AgentDefinition def = definition(false, "**");
        def.setSystemPrompt(null);

        ReActAgent subagent = AgentFactory.create(engine(), def).build();
        com.gourdai.agent.react.ReActTrace stubTrace = new com.gourdai.agent.react.ReActTrace() {
            @Override
            public com.gourdai.agent.react.ReActOptions getOptions() {
                return new com.gourdai.agent.react.ReActOptions(null);
            }
        };

        String prompt = subagent.getConfig().getSystemPromptFor(stubTrace, null);
        assertTrue(prompt != null && prompt.contains("你无法向用户提问"),
                "null prompt 子代理必须收到禁问条款");
    }
}