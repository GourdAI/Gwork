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
import com.gourdai.agent.react.intercept.CompleteTaskInterceptor;
import com.gourdai.agent.react.intercept.ToolSanitizerInterceptor;
import com.gourdai.agent.util.AskUserTool;
import com.gourdai.agent.util.CompleteTaskTool;
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
    /**
     * 子代理 headless 禁问条款（契约 §1.3，双内核逐字一致）。
     *
     * <p>子代理运行在无用户交互的 headless 环境：question 帧被转发层丢弃（team/mod.rs:484-497），
     * 一旦挂起父代理只能死等。故子代理系统提示词末尾恒注入本条款，与工具集剔除 ask_user 双保险。</p>
     */
    public static final String SUBAGENT_NO_ASK_CLAUSE_CN = "你无法向用户提问：本次运行没有 ask_user 工具，也不要输出面向用户的提问文本。信息不足时做出合理假设并继续，或在结果中明确报告阻塞点，由父代理决定是否向用户提问。";

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

        // 契约 §1.3（自审修复 J2）：子代理禁问条款【无条件】注入——旧实现只在
        // systemPrompt 非空时追加，空 prompt 的子代理（AgentDefinition 无默认值、
        // markdown 空正文→空串，路径真实可达）完全收不到条款，仍可能以「请选择…」
        // 收尾让父代理死等。Rust team/mod.rs 对空 prompt 同样无条件拼装，同一口径。
        if (metadata.isPrimary()) {
            if (Assert.isNotEmpty(agentDefinition.getSystemPrompt())) {
                final String customPrompt = agentDefinition.getSystemPrompt();
                builder.systemPrompt(r -> customPrompt);
            }
        } else {
            // 子代理 headless 禁问条款：子代理的 question 帧会被转发层丢弃，
            // 挂起即父代理死等——在系统提示词层面明确「无法提问」，信息不足时合理假设或报告阻塞点。
            final String basePrompt = Assert.isNotEmpty(agentDefinition.getSystemPrompt())
                    ? agentDefinition.getSystemPrompt() + "\n\n" : "";
            builder.systemPrompt(r -> basePrompt + SUBAGENT_NO_ASK_CLAUSE_CN);
        }

        // 契约 §4：complete_task 仅注册到主代理（子代理最终文本回传父代理的机制不变）。
        // 不走 metadata.tools 名单：主会话恒可用；显式列名（含子代理）在 toolAddDo 内拒绝。
        if (metadata.isPrimary()) {
            builder.defaultToolAdd(CompleteTaskTool.getTool());
            builder.defaultInterceptorAdd(new CompleteTaskInterceptor());
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
                        // 契约 §1.5：子代理构建路径的 ** 展开剔除 ask_user（question 帧被转发层丢弃，
                        // 挂起即父代理死等）；主会话 ** 保留。分叉点即 metadata.isPrimary()。
                        if (metadata.isPrimary() == false && AskUserTool.TOOL_NAME.equals(t1)) {
                            continue;
                        }
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
                builder.defaultTalentAdd(engine.getTaskTalent());
                break;
            }
            case "generate": {
                builder.defaultTalentAdd(engine.getGenerateTalent());
                break;
            }

            //-------


            case "memory": {
                // memoryTalent 是条件装配（引擎未配置 MemorySolutionProvider 时为 null，
                // 见 HarnessEngine 构造器）：** 展开含 memory，裸引擎直接 talentAdd(null)
                // 会在装配期 NPE。与 hitl/ask_user 同为「能力未配置即静默跳过」语义。
                if (engine.getMemoryTalent() != null) {
                    builder.defaultTalentAdd(engine.getMemoryTalent());
                }
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
                // 契约 §1.5：子代理即使显式列名也不给 ask_user（headless 环境挂起即父代理死等）。
                if (metadata.isPrimary() == false) {
                    break;
                }
                builder.defaultToolAdd(AskUserTool.getTool());
                builder.defaultInterceptorAdd(engine.getAskUserInterceptor());
                break;
            }
            case "complete_task": {
                // 契约 §4：主代理在 create() 恒注册；此处仅防御显式列名时的重复注册，
                // 子代理显式列名一律拒绝（收尾语义由父代理承担）。
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