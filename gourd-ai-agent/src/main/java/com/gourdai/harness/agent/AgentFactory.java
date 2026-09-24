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
package com.gourdai.harness.agent;

import com.gourdai.agent.react.ReActAgent;
import com.gourdai.agent.react.intercept.ToolSanitizerInterceptor;
import com.gourdai.agent.util.AskUserTool;
import com.gourdai.harness.HarnessExtension;
import com.gourdai.ai.chat.ChatModel;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.talents.cli.TerminalTalentProxy;
import org.noear.solon.core.util.Assert;
import org.noear.solon.lang.Nullable;

/**
 * 代理工厂
 *
 * @author oisin
 */
public class AgentFactory {
    //**
    private static String[] TOOL_ALL_FULL = {"read", "write", "edit", "glob", "grep", "ls", "bash", "bash_output", "skill", "todo", "code", "codesearch", "websearch", "webfetch", "task", "generate", "mcp", "openapi", "hitl", "ask_user", "lsp", "memory"};
    //*
    private static String[] TOOL_ALL_PUBLIC = {"read", "write", "edit", "glob", "grep", "ls", "bash", "bash_output", "skill", "todo", "code", "codesearch", "websearch", "webfetch", "task", "lsp"};
    //pi
    private static String[] TOOL_PI = {"read", "write", "edit", "bash", "bash_output"};


    /**
     * 根据定义生成代理
     */
    public static ReActAgent.Builder create(HarnessEngine engine, AgentDefinition agentDefinition) {
        return create(engine, agentDefinition, null);
    }

    /**
     * 根据定义生成代理
     */
    public static ReActAgent.Builder create(HarnessEngine engine, AgentDefinition agentDefinition, @Nullable String sessionModel) {
        final String selectedModel;

        if (Assert.isEmpty(agentDefinition.getModel())) {
            //如果没有配置指定，则用会话选中的
            selectedModel = sessionModel;
        } else {
            selectedModel = agentDefinition.getModel();
        }

        ChatModel chatModel = engine.getModelOrMain(selectedModel);
        AgentDefinition.Metadata metadata = agentDefinition.getMetadata();

        ReActAgent.Builder builder = ReActAgent.of(chatModel);

        builder.name(agentDefinition.getName());
        builder.retryConfig(engine.getModelRetries(), 1000L);
        builder.maxTurns(engine.getMaxTurns());
        builder.autoRethink(engine.isAutoRethink());
        builder.sessionWindowSize(engine.getSessionWindowSize());
        builder.defaultInterceptorAdd(engine.getCompressionInterceptor());
        builder.defaultInterceptorAdd(9, engine.getStopLoopInterceptor());
        builder.defaultInterceptorAdd(new RetryNotifyInterceptor());
        builder.defaultInterceptorAdd(new ContextUsageInterceptor());

        // ⭐ 工具输出预算统一入口：按上下文压力动态调档（<60% 宽松 / 60-75% 中等 / ≥75% 严格）。
        //    从源头控制进入上下文的量，是唯一零信息损失的省法——工具可分页重调，
        //    而摘要一旦丢弃就找不回来了。
        ToolSanitizerInterceptor sanitizer = new ToolSanitizerInterceptor();
        sanitizer.setPressureSupplier(engine.getCompressionInterceptor()::getContextPressure);
        builder.defaultInterceptorAdd(sanitizer);

        if (Assert.isNotEmpty(agentDefinition.getSystemPrompt())) {
            builder.systemPrompt(r -> agentDefinition.getSystemPrompt());
        }

        if (Assert.isNotEmpty(engine.getWorkspace())) {
            builder.defaultToolContextPut(HarnessEngine.ATTR_CWD, engine.getWorkspace());
        }

        if (Assert.isNotEmpty(metadata.getTools())) {
            //目前参考了： https://opencode.ai/docs/zh-cn/permissions/
            TerminalTalentProxy terminalTalentProxy = new TerminalTalentProxy(engine.getTerminalTalent());

            for (String toolName : metadata.getTools()) {
                if ("**".equals(toolName)) {
                    for (String t1 : TOOL_ALL_FULL) {
                        toolAddDo(engine, builder, terminalTalentProxy, metadata, t1);
                    }
                } else if ("*".equals(toolName)) {
                    for (String t1 : TOOL_ALL_PUBLIC) {
                        toolAddDo(engine, builder, terminalTalentProxy, metadata, t1);
                    }
                } else if ("pi".equals(toolName)) {
                    for (String t1 : TOOL_PI) {
                        toolAddDo(engine, builder, terminalTalentProxy, metadata, t1);
                    }
                } else {
                    toolAddDo(engine, builder, terminalTalentProxy, metadata, toolName);
                }
            }

            if (terminalTalentProxy.isEmpty() == false) {
                builder.defaultTalentAdd(terminalTalentProxy);
            }

            builder.defaultTalentAdd(engine.getClockTalent());
        }

        for (HarnessExtension extension : engine.getExtensions()) {
            extension.configure(agentDefinition.getName(), builder);
        }

        builder.modelOptions(o -> {
            if (engine.getCacheControl() != null) {
                o.cacheControl(engine.getCacheControl());
            }
        });

        return builder;
    }

    private static void toolAddDo(HarnessEngine engine, ReActAgent.Builder builder, TerminalTalentProxy terminalTalentProxy, AgentDefinition.Metadata metadata, String toolName) {
        //当前禁止
        if (metadata.getDisallowedTools().contains(toolName)) {
            return;
        }

        //全局禁止
        if (engine.getDisallowedTools().contains(toolName)) {
            return;
        }

        switch (toolName) {
            case "read": {
                terminalTalentProxy.addTools("read");
                break;
            }
            case "write": {
                terminalTalentProxy.addTools("write");
                break;
            }
            case "edit": {
                terminalTalentProxy.addTools("edit");

                toolAddDo(engine, builder, terminalTalentProxy, metadata, "read");
                toolAddDo(engine, builder, terminalTalentProxy, metadata, "write");
                break;
            }
            case "glob": {
                terminalTalentProxy.addTools("glob");
                break;
            }
            case "grep": {
                terminalTalentProxy.addTools("grep");
                break;
            }
            case "ls":
            case "list": {
                terminalTalentProxy.addTools("ls");
                break;
            }
            case "bash": {
                terminalTalentProxy.addTools("bash");
                break;
            }
            case "bash_output": {
                terminalTalentProxy.addTools("bash_output");
                break;
            }
            case "todoread":
            case "todowrite":
            case "todo": {
                todoToolAddDo(metadata, builder, engine);
                break;
            }
            case "webfetch": {
                builder.defaultTalentAdd(engine.getWebfetchTalent());
                break;
            }
            case "websearch": {
                builder.defaultTalentAdd(engine.getWebsearchTalent());
                break;
            }
            case "codesearch": {
                builder.defaultTalentAdd(engine.getCodeSearchTalent());
                break;
            }
            case "skill": {
                builder.defaultTalentAdd(engine.getSkillTalent());
                break;
            }
            case "subagent":
            case "task": {
                engine.getTaskTalent().setEnabled(engine.isSubagentEnabled());

                builder.defaultTalentAdd(engine.getTaskTalent());
                break;
            }
            case "generate": {
                engine.getGenerateTalent().setEnabled(engine.isSubagentEnabled());

                builder.defaultTalentAdd(engine.getGenerateTalent());
                break;
            }

            //-------


            case "memory": {
                builder.defaultTalentAdd(engine.getMemoryTalent());
                break;
            }
            case "code": {
                builder.defaultTalentAdd(engine.getCodeTalent());
                break;
            }
            case "mcp": {
                builder.defaultTalentAdd(engine.getMcpGatewayTalent());
                break;
            }
            case "openapi": {
                builder.defaultTalentAdd(engine.getOpenApiGatewayTalent());
                break;
            }
            case "lsp": {
                builder.defaultTalentAdd(engine.getLspTalent());
                break;
            }
            case "hitl": {
                // 拦截器恒启用，是否真的弹审批由会话档位在 onAction 里决定（见 HITLInterceptor）。
                // 不允许任何引擎级全局开关在装配期把拦截器置为 disabled：档位是每个会话一个值，
                // 装配期关掉，默认档会话的审批就永远不会触发。
                engine.getHitlInterceptor().setEnabled(true);

                builder.defaultInterceptorAdd(engine.getHitlInterceptor());
                break;
            }
            case "ask_user": {
                // 结构化问答：工具用于引导模型产出 questions 结构化参数；
                // 真正的挂起/恢复由 AskUserInterceptor 在 onAction 阶段接管（默认启用，不加开关）。
                builder.defaultToolAdd(AskUserTool.getTool());
                builder.defaultInterceptorAdd(engine.getAskUserInterceptor());
                break;
            }
        }
    }

    private static void todoToolAddDo(AgentDefinition.Metadata metadata, ReActAgent.Builder builder, HarnessEngine engine) {
        if (metadata.isPrimary()) {
            //主代理，用文件模式
            builder.defaultTalentAdd(engine.getTodoTalent());
        } else {
            //次代理，用内存模式
            builder.planningMode(true);
        }
    }
}