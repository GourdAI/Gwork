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
package com.gourdai.core.portal.desktop;

import org.noear.snack4.ONode;
import com.gourdai.agent.AgentSession;
import com.gourdai.agent.react.ReActAgent;
import com.gourdai.agent.react.ReActChunk;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.task.ActionChunk;
import com.gourdai.agent.react.task.ObservationChunk;
import com.gourdai.agent.react.task.ReasonChunk;
import com.gourdai.agent.react.task.ThoughtChunk;
import com.gourdai.agent.util.AgentUtil;
import org.noear.solon.ai.chat.ChatConfig;
import org.noear.solon.ai.chat.ChatModel;
import org.noear.solon.ai.chat.message.ChatMessage;
import org.noear.solon.ai.chat.message.UserMessage;
import org.noear.solon.ai.chat.content.Contents;
import org.noear.solon.ai.chat.content.ImageBlock;
import org.noear.solon.ai.chat.content.TextBlock;
import org.noear.solon.ai.chat.prompt.Prompt;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.agent.AgentEndChunk;
import com.gourdai.harness.agent.AgentStartChunk;
import com.gourdai.harness.agent.RetryChunk;
import com.gourdai.harness.agent.TaskTalent;
import com.gourdai.harness.command.Command;
import com.gourdai.harness.talents.memory.MemoryTalent;
import org.noear.solon.ai.util.CmdUtil;
import com.gourdai.core.command.WebCommandContext;
import com.gourdai.agent.react.intercept.HITL;
import com.gourdai.agent.react.intercept.HITLTask;
import com.gourdai.core.config.AgentFlags;
import com.gourdai.core.config.AgentSettings;
import org.noear.solon.core.util.Assert;
import org.noear.solon.net.websocket.WebSocket;
import org.noear.solon.net.websocket.listener.SimpleWebSocketListener;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.Disposable;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * Code CLI WebSocket 网关
 * <p>基于 WebSocket 的流式通信接口</p>
 *
 * @author oisin
 * @since 3.9.1
 */

public class WsGate extends SimpleWebSocketListener {
    private static final Logger LOG = LoggerFactory.getLogger(WsGate.class);
    private static final String SESSION_ID_DESKTOP = "desktop";

    private final HarnessEngine engine;
    private final AgentSettings agentSettings;

    public WsGate(HarnessEngine engine, AgentSettings agentSettings) {
        this.engine = engine;
        this.agentSettings = agentSettings;
    }

    @Override
    public void onOpen(WebSocket socket) {
        String sessionId = socket.paramOrDefault("sessionId", SESSION_ID_DESKTOP);
        String sessionCwd = socket.param(AgentFlags.X_SESSION_CWD);//工作区

        if (Assert.isNotEmpty(sessionId)) {
            if (sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
                socket.send("{\"type\":\"error\",\"text\":\"Invalid Session ID\"}");
                socket.close();
                return;
            }
        }

        if (Assert.isNotEmpty(sessionCwd)) {
            if (sessionCwd.contains("..")) {
                socket.send("{\"type\":\"error\",\"text\":\"Invalid Session Cwd\"}");
                socket.close();
                return;
            }

            AgentSession session = engine.getSession(sessionId);
            session.attrs().putIfAbsent(HarnessEngine.ATTR_CWD, sessionCwd);
        }
    }

    @Override
    public void onMessage(WebSocket socket, String text) throws IOException {
        try {
            // 先判断消息类型（config 消息结构不同于 chat 消息）
            ONode root = ONode.ofJson(text);
            String msgType = root.get("type") != null ? root.get("type").getString() : null;

            if ("config".equals(msgType)) {
                handleConfigMessage(socket, root);
                return;
            }

            if ("hitl_action".equals(msgType)) {
                handleHitlAction(socket, root);
                return;
            }

            // 解析请求
            WsMessage req = root.toBean(WsMessage.class);
            String sessionId = socket.paramOrDefault("sessionId", "");
            String input = req.getInput();
            String cwd = req.getCwd();

            if (Assert.isEmpty(sessionId)) {
                sessionId = "ws_" + System.currentTimeMillis();
                // 及时通知客户端自动生成的 sessionId
                socket.send(new ONode().set("type", "session")
                        .set("sessionId", sessionId)
                        .toJson());
            }

            AgentSession session = engine.getSession(sessionId);

            if ("[(sec)interrupt]".equals(req.getInput())) {
                Disposable disposable = (Disposable) session.attrs().remove("disposable");
                if (disposable != null) {
                    disposable.dispose();
                }
                session.addMessage(ChatMessage.ofAssistant("用户已取消任务."));
                LOG.info("用户已取消任务.");

                String interruptModelName = req.getModel();
                if (interruptModelName == null || interruptModelName.isEmpty()) {
                    interruptModelName = engine.getMainModel().getConfig().getNameOrModel();
                }

                socket.send(new ONode().set("type", "reason")
                        .set("sessionId", session.getSessionId())
                        .set("text", "[Task interrupted]")
                        .toJson());

                socket.send(new ONode().set("type", "done")
                        .set("sessionId", session.getSessionId())
                        .set("modelName", interruptModelName)
                        .set("totalTokens", 0)
                        .set("elapsedMs", 0).toJson());
                return;
            }


            if (Assert.isEmpty(req.getCwd())) {
                cwd = session.attrs().getOrDefault(HarnessEngine.ATTR_CWD, ".").toString();
            }


            // 验证 sessionId
            if (sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
                socket.send(new ONode().set("type", "error")
                        .set("text", "Invalid Session ID").toJson());
                return;
            }

            // 验证 cwd
            if (Assert.isNotEmpty(cwd)) {
                if (cwd.contains("..")) {
                    socket.send(new ONode().set("type", "error")
                            .set("text", "Invalid Session Cwd").toJson());
                    return;
                }
            }

            if (Assert.isEmpty(input)) {
                return;
            }

            String agentName = null;
            String currentInput = input;

            if (input.startsWith("@")) {
                int agentNameIdx = input.indexOf(" ");
                if (agentNameIdx > 0) {
                    agentName = input.substring(1, agentNameIdx);

                    if (engine.getAgentManager().hasAgent(agentName)) {
                        currentInput = currentInput.substring(agentNameIdx + 1);
                    }
                }
            }

            // 根据前端指定的 model 选择对应 ChatModel
            String modelName = req.getModel();
            ChatModel chatModel = engine.getModelOrMain(modelName);

            session.getContext().put(HarnessEngine.CTX_MODEL_SELECTED, modelName);

            // 模式处理：根据前端 mode 字段配置 session 行为
            String mode = req.getMode();
            if ("plan".equals(mode)) {
                // 规划模式：只读分析，不执行文件/命令操作
                session.attrs().put("_plan_mode", true);
                if (!currentInput.contains("不要执行") && !currentInput.contains("只分析")) {
                    currentInput = "[规划模式 - 仅分析不执行任何操作] " + currentInput;
                }
            } else if ("auto".equals(mode)) {
                // 自动编辑模式：文件编辑自动放行，shell 命令仍需审批
                session.attrs().put("_hitl_shell_only", true);
            }
            // default 模式：不做特殊处理，所有操作走正常 HITL 流程

            final ReActAgent agent = engine.getAgentOrMain(agentName);

            // 命令处理：以 / 开头的输入走命令分发
            if (currentInput.startsWith("/")) {
                handleCommand(socket, session, agent, chatModel, cwd, currentInput, sessionId);
                return;
            }

            // 流式处理
            final String finalSessionId = sessionId;

            // 处理附件：图片构建 ImageBlock，文件拼入文本前缀
            List<WsMessage.WsAttachment> attachments = req.getAttachments();
            List<ImageBlock> imageBlocks = new ArrayList<>();
            List<String> fileNames = new ArrayList<>();

            if (attachments != null && !attachments.isEmpty()) {
                for (WsMessage.WsAttachment att : attachments) {
                    if ("image".equals(att.getType()) && att.getData() != null) {
                        String base64 = att.getData();
                        // 如果包含 data URL 前缀，去掉它
                        int commaIdx = base64.indexOf(',');
                        if (commaIdx > 0) {
                            base64 = base64.substring(commaIdx + 1);
                        }
                        imageBlocks.add(ImageBlock.ofBase64(base64, att.getMimeType() != null ? att.getMimeType() : "image/png"));
                    } else if (att.getName() != null) {
                        fileNames.add(att.getName());
                    }
                }
            }

            // 文件附件拼入输入文本前缀
            if (!fileNames.isEmpty()) {
                String filePrefix = fileNames.stream()
                        .map(f -> "[附件: " + f + "]")
                        .collect(java.util.stream.Collectors.joining("\n"));
                currentInput = filePrefix + "\n" + currentInput;
            }

            // 构建 Prompt（含图片时用 Contents）
            Prompt prompt;
            // 中断续跑：上次异常中断时，用户再发消息保留断点工作记忆并追加新消息接着跑，而非从头重跑。
            // 注意：桌面流式路径下方恒用 engine.prompt()（主 agent 执行），故续跑判断也按主 agent 口径
            // （传 null），与实际执行的 agent 一致，避免修了子 agent 的 trace 却由主 agent 执行导致新消息错位。
            // 仅纯文本场景启用（含图片维持新任务语义）。
            ReActTrace resumeTrace = imageBlocks.isEmpty() ? engine.resolveTrace(session, null) : null;
            if (engine.canResume(resumeTrace)) {
                // 传入 cwd 供恢复校准定位 TODO.md
                engine.prepareResume(resumeTrace, session, currentInput, true, cwd);
                prompt = Prompt.of();
            } else if (!imageBlocks.isEmpty()) {
                Contents contents = new Contents();
                contents.addBlock(TextBlock.of(currentInput));
                for (ImageBlock block : imageBlocks) {
                    contents.addBlock(block);
                }
                prompt = Prompt.of(new UserMessage(contents));
            } else {
                prompt = Prompt.of(currentInput);
            }

            String finalCwd = cwd;
            // 本轮任务的起始时刻。不能依赖 trace.getOriginalPrompt() 里的 start_time：
            // 「继续/恢复」时库会用最初任务的 originalPrompt，其 start_time 停留在最初起点，
            // 导致耗时累计成整段对话时长。每次订阅前取时，才是「单轮耗时」。
            final long turnStartMs = System.currentTimeMillis();
            Disposable disposable = engine.prompt(prompt)
                    .session(session)
                    .options(o -> {
                        o.chatModel(chatModel);
                        o.toolContextPut(HarnessEngine.ATTR_CWD, finalCwd);
                    })
                    .stream()
                    .doFinally(signal -> {
                        session.attrs().remove("disposable");
                    })
                    .doOnNext(chunk -> {
                        // ReActChunk 需要优先处理 metrics 收集（无论 hasContent 状态）
                        String msg = null;
                        if (chunk instanceof ReActChunk) {
                            onReActChunk((ReActChunk) chunk, finalSessionId, socket, turnStartMs);
                            return;
                        } else if (chunk instanceof ReasonChunk) {
                            msg = onReasonChunk((ReasonChunk) chunk, finalSessionId);
                        } else if (chunk instanceof ActionChunk) {
                            msg = onActionStartChunk((ActionChunk) chunk, finalSessionId);
                        } else if (chunk instanceof ObservationChunk) {
                            msg = onObservationChunk((ObservationChunk) chunk, finalSessionId);
                        } else if (chunk instanceof ThoughtChunk) {
                            msg = onThoughtChunk((ThoughtChunk) chunk, finalSessionId);
                        } else if (chunk instanceof AgentStartChunk) {
                            msg = onAgentStartChunk((AgentStartChunk) chunk, finalSessionId);
                        } else if (chunk instanceof AgentEndChunk) {
                            msg = onAgentEndChunk((AgentEndChunk) chunk, finalSessionId);
                        } else if (chunk instanceof RetryChunk) {
                            msg = onRetryChunk((RetryChunk) chunk, finalSessionId);
                        }

                        if (Assert.isNotEmpty(msg)) {
                            socket.send(msg);
                        }
                    }).doOnError(err -> {
                        String msg = new ONode().set("type", "error")
                                .set("sessionId", finalSessionId)
                                .set("text", err.getMessage())
                                .toJson();

                        socket.send(msg);
                    }).subscribe();

            Disposable old = (Disposable) session.attrs().put("disposable", disposable);
            if (old != null && !old.isDisposed()) {
                old.dispose();
            }
        } catch (Exception e) {
            String errorMsg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
            socket.send(new ONode().set("type", "error")
                    .set("text", errorMsg).toJson());
        }
    }

    private void onReActChunk(ReActChunk chunk, String finalSessionId, WebSocket socket, long turnStartMs) {
        ReActTrace trace = chunk.getTrace();
        // 单轮耗时：从本轮订阅起算，而非 originalPrompt 里的 start_time（跨轮复用会累计成整段对话时长）。
        long elapsed = turnStartMs > 0 ? System.currentTimeMillis() - turnStartMs : 0;
        long inputTokens = trace.getMetrics() != null ? trace.getMetrics().getPromptTokens() : 0;
        long outputTokens = trace.getMetrics() != null ? trace.getMetrics().getCompletionTokens() : 0;

        String msg2 = new ONode().set("type", "done")
                .set("sessionId", finalSessionId)
                .set("modelName", trace.getOptions().getChatModel().getNameOrModel())
                .set("inputTokens", inputTokens)
                .set("outputTokens", outputTokens)
                .set("elapsedMs", elapsed).toJson();

        socket.send(msg2);
    }

    private String onReasonChunk(ReasonChunk chunk, String finalSessionId) {
        if (!chunk.isToolCalls() && chunk.getMessage() != null) {
            String content = chunk.getMessage().getContent();
            if (content != null && !content.isEmpty()) {
                boolean isThinking = chunk.getMessage().isThinking();
                String chunkTypeToSend = isThinking ? "think" : "reason";

                ONode node = new ONode().set("type", chunkTypeToSend)
                        .set("sessionId", finalSessionId)
                        .set("text", content);

                String agentName = chunk.getTrace().getAgentName();
                if (!engine.getName().equals(agentName)) {
                    node.set("agentName", agentName);
                }

                return node.toJson();
            }
        }
        return null;
    }

    /**
     * 处理 RetryChunk（模型调用失败自动重试时发送）：推送 retry 提示，
     * 让前端展示「正在重试 N/M」的中间状态。
     */
    private String onRetryChunk(RetryChunk chunk, String finalSessionId) {
        ONode node = new ONode().set("type", "retry")
                .set("sessionId", finalSessionId)
                .set("attempt", chunk.getAttempt())
                .set("maxRetries", chunk.getMaxRetries())
                .set("text", chunk.toText());

        String agentName = chunk.getAgentName();
        if (!engine.getName().equals(agentName)) {
            node.set("agentName", agentName);
        }

        return node.toJson();
    }

    /**
     * 处理 ActionChunk（工具调用前发送）：在工具实际执行前推送 action_start，
     * 让前端提前渲染 loading 状态的工具卡片骨架，提升流式实时感。
     * 过滤规则与 onObservationChunk 保持一致，避免卡片创建后却无对应结果填充。
     */
    private String onActionStartChunk(ActionChunk chunk, String finalSessionId) {
        if (Assert.isEmpty(chunk.getToolName())) {
            return null;
        }

        if (TaskTalent.TOOL_MULTITASK.equals(chunk.getToolName()) ||
                TaskTalent.TOOL_TASK.equals(chunk.getToolName()) ||
                MemoryTalent.isMemoryTool(chunk.getToolName())) {
            return null;
        }

        // todowrite 的展示走专用通道，由 ObservationChunk 携带完整 todos 渲染，开始阶段不提前建卡
        if ("todowrite".equals(chunk.getToolName())) {
            return null;
        }

        ONode node = new ONode().set("type", "action_start")
                .set("sessionId", finalSessionId);

        if (engine.getName().equals(chunk.getAgentName())) {
            node.set("toolName", chunk.getToolName());
        } else {
            node.set("toolName", chunk.getAgentName() + "/" + chunk.getToolName());
        }

        if (chunk.getArgs() != null) node.set("args", chunk.getArgs());
        copyActionMetadata(node, chunk);

        return node.toJson();
    }

    private String onObservationChunk(ObservationChunk chunk, String finalSessionId) {
        if (chunk.getError() != null) {
            return null;
        }

        if (Assert.isEmpty(chunk.getToolName())) {
            return null;
        }

        if (TaskTalent.TOOL_MULTITASK.equals(chunk.getToolName()) ||
                TaskTalent.TOOL_TASK.equals(chunk.getToolName()) ||
                MemoryTalent.isMemoryTool(chunk.getToolName())) {
            return null;
        }

        ONode node = new ONode().set("type", "action_end")
                .set("sessionId", finalSessionId);

        if (engine.getName().equals(chunk.getAgentName())) {
            node.set("toolName", chunk.getToolName());
        } else {
            node.set("toolName", chunk.getAgentName() + "/" + chunk.getToolName());
        }

        if (chunk.getObservation() != null && chunk.getObservation().getContent() != null) {
            node.set("text", chunk.getObservation().getContent());
        }
        if (chunk.getArgs() != null) node.set("args", chunk.getArgs());
        copyActionMetadata(node, chunk);

        if ("todowrite".equals(chunk.getToolName())) {
            String todos = AgentUtil.asStringArg(chunk.getArgs(), "todos");
            if (Assert.isNotEmpty(todos)) {
                node.set("text", todos);
            }
        }

        return node.toJson();
    }

    private void copyActionMetadata(ONode node, com.gourdai.agent.react.task.AbsActionChunk chunk) {
        if (chunk.getActionId() != null) node.set("actionId", chunk.getActionId());
        if (chunk.getBatchId() != null) node.set("batchId", chunk.getBatchId());
        if (chunk.getBatchIndex() != null) node.set("batchIndex", chunk.getBatchIndex());
        if (chunk.getBatchSize() != null) node.set("batchSize", chunk.getBatchSize());
    }

    /**
     * 处理 HITL 审批/拒绝操作
     * 消息格式: {"type":"hitl_action","action":"approve|reject","sessionId":"..."}
     */
    private void handleHitlAction(WebSocket socket, ONode root) {
        try {
            String sessionId = root.get("sessionId") != null ? root.get("sessionId").getString() : null;
            String action = root.get("action") != null ? root.get("action").getString() : null;

            if (sessionId == null || action == null) {
                socket.send(new ONode().set("type", "error").set("text", "sessionId and action required").toJson());
                return;
            }

            AgentSession session = engine.getSession(sessionId);
            HITLTask task = HITL.getPendingTask(session);
            if (task == null) {
                socket.send(new ONode().set("type", "error").set("text", "No pending HITL task").toJson());
                return;
            }

            if ("approve".equals(action)) {
                HITL.approve(session, task.getToolName());
            } else {
                HITL.reject(session, task.getToolName());
            }

            // 审批后恢复流执行
            String modelName = (String) session.getContext().get(HarnessEngine.CTX_MODEL_SELECTED);
            ChatModel chatModel = engine.getModelOrMain(modelName);
            String cwd = session.attrs().getOrDefault(HarnessEngine.ATTR_CWD, ".").toString();

            Prompt hitlPrompt = Prompt.of();

            final long turnStartMs = System.currentTimeMillis();
            Disposable disposable = engine.prompt(hitlPrompt)
                    .session(session)
                    .options(o -> {
                        o.chatModel(chatModel);
                        if (Assert.isNotEmpty(cwd)) {
                            o.toolContextPut(HarnessEngine.ATTR_CWD, cwd);
                        }
                    })
                    .stream()
                    .doFinally(signal -> session.attrs().remove("disposable"))
                    .doOnNext(chunk -> {
                        if (chunk instanceof ReActChunk) {
                            onReActChunk((ReActChunk) chunk, sessionId, socket, turnStartMs);
                            return;
                        }
                        String msg = null;
                        if (chunk instanceof ReasonChunk) {
                            msg = onReasonChunk((ReasonChunk) chunk, sessionId);
                        } else if (chunk instanceof ActionChunk) {
                            msg = onActionStartChunk((ActionChunk) chunk, sessionId);
                        } else if (chunk instanceof ObservationChunk) {
                            msg = onObservationChunk((ObservationChunk) chunk, sessionId);
                        } else if (chunk instanceof ThoughtChunk) {
                            msg = onThoughtChunk((ThoughtChunk) chunk, sessionId);
                        } else if (chunk instanceof RetryChunk) {
                            msg = onRetryChunk((RetryChunk) chunk, sessionId);
                        } else if (chunk instanceof AgentStartChunk) {
                            msg = onAgentStartChunk((AgentStartChunk) chunk, sessionId);
                        } else if (chunk instanceof AgentEndChunk) {
                            msg = onAgentEndChunk((AgentEndChunk) chunk, sessionId);
                        }
                        if (Assert.isNotEmpty(msg)) {
                            socket.send(msg);
                        }
                    })
                    .doOnError(err -> socket.send(new ONode().set("type", "error")
                            .set("sessionId", sessionId).set("text", err.getMessage()).toJson()))
                    .subscribe();

            session.attrs().put("disposable", disposable);
        } catch (Exception e) {
            LOG.error("[WS] HITL action failed", e);
            socket.send(new ONode().set("type", "error").set("text", e.getMessage()).toJson());
        }
    }

    private String onThoughtChunk(ThoughtChunk chunk, String finalSessionId) {
        if (chunk.hasMeta(TaskTalent.TOOL_MULTITASK)) {
            String content = chunk.getAssistantMessage().getResultContent();
            if (Assert.isNotEmpty(content)) {
                ONode node = new ONode().set("type", "reason")
                        .set("sessionId", finalSessionId)
                        .set("text", "\n" + content);

                String agentName = chunk.getTrace().getAgentName();
                if (!engine.getName().equals(agentName)) {
                    node.set("agentName", agentName);
                }

                return node.toJson();
            }
        }
        return null;
    }

    /**
     * 处理 AgentStartChunk（子代理启动）
     */
    private String onAgentStartChunk(AgentStartChunk chunk, String sessionId) {
        String agentName = chunk.getAgentName();
        String description = chunk.getDescription();
        ONode args = new ONode().set("agentName", agentName).set("description", description);
        ONode node = new ONode()
                .set("type", "agent_start")
                .set("sessionId", sessionId)
                .set("toolName", agentName)
                .set("toolTitle", agentName)
                .set("text", description)
                .set("args", args);
        return node.toJson();
    }

    /**
     * 处理 AgentEndChunk（子代理结束）
     */
    private String onAgentEndChunk(AgentEndChunk chunk, String sessionId) {
        String agentName = chunk.getAgentName();
        String description = chunk.getDescription();
        ONode args = new ONode()
                .set("agentName", agentName)
                .set("description", description)
                .set("success", chunk.isSuccess())
                .set("resultSummary", chunk.getResultSummary() != null ? chunk.getResultSummary() : "");
        ONode node = new ONode()
                .set("type", "agent_end")
                .set("sessionId", sessionId)
                .set("toolName", agentName)
                .set("toolTitle", agentName)
                .set("text", description)
                .set("args", args);
        return node.toJson();
    }

    /**
     * 处理前端推送的配置变更
     */
    private void handleConfigMessage(WebSocket socket, ONode root) {
        try {
            ONode chatModelNode = root.get("chatModel");
            if (chatModelNode != null && !chatModelNode.isNull()) {
                String apiUrl = chatModelNode.get("apiUrl") != null ? chatModelNode.get("apiUrl").getString() : null;
                String apiKey = chatModelNode.get("apiKey") != null ? chatModelNode.get("apiKey").getString() : null;
                String model = chatModelNode.get("model") != null ? chatModelNode.get("model").getString() : null;

                if (apiUrl != null || apiKey != null || model != null) {
                    // 更新 AgentProperties 的 chatModel 配置
                    ChatConfig chatConfig = new ChatConfig();
                    chatConfig.setApiUrl(apiUrl);
                    chatConfig.setApiKey(apiKey);
                    chatConfig.setModel(model);

                    // 重建 ChatModel 并注入 kernel
                    engine.removeModel(chatConfig.getNameOrModel());
                    engine.addModel(chatConfig);
                    engine.refreshMainAgent();

                    LOG.info("[WS] Config updated: model={}", model);

                    // 持久化到 YAML 文件
                    saveConfigToFile(apiUrl, apiKey, model);

                    socket.send(new ONode()
                            .set("type", "config")
                            .set("status", "ok")
                            .set("model", model)
                            .toJson());
                }
            }
        } catch (Exception e) {
            LOG.error("[WS] Config update failed", e);
            socket.send(new ONode()
                    .set("type", "config")
                    .set("status", "error")
                    .set("text", e.getMessage())
                    .toJson());
        }
    }

    /**
     * 将 chatModel 配置持久化到 YAML 文件（~/.gwork/chat-model.yml）
     */
    private void saveConfigToFile(String apiUrl, String apiKey, String model) {
        //todo: 这块要根据 AppSetttings 类重新进行设计。noear,2026.6
//        try {
//            String home = System.getProperty("user.home");
//            Path configDir = Paths.get(home, ".gwork");
//            Files.createDirectories(configDir);
//
//            Path configFile = configDir.resolve("chat-model.yml");
//
//            // 读取已有配置，保留未更新的字段
//            String existApiUrl = agentPros.getChatModel() != null ? agentPros.getChatModel().getApiUrl() : null;
//            String existApiKey = agentPros.getChatModel() != null ? agentPros.getChatModel().getApiKey() : null;
//            String existModel = agentPros.getChatModel() != null ? agentPros.getChatModel().getNameOrModel() : null;
//
//            String finalApiUrl = apiUrl != null ? apiUrl : existApiUrl;
//            String finalApiKey = apiKey != null ? apiKey : existApiKey;
//            String finalModel = model != null ? model : existModel;
//
//            StringBuilder yaml = new StringBuilder();
//            yaml.append("gourdai:\n");
//            yaml.append("  chatModel:\n");
//            if (finalApiUrl != null) yaml.append("    apiUrl: \"").append(escapeYaml(finalApiUrl)).append("\"\n");
//            if (finalApiKey != null) yaml.append("    apiKey: \"").append(escapeYaml(finalApiKey)).append("\"\n");
//            if (finalModel != null) yaml.append("    model: \"").append(escapeYaml(finalModel)).append("\"\n");
//
//            Files.write(configFile, yaml.toString().getBytes(StandardCharsets.UTF_8));
//            LOG.info("[WS] Config persisted to: {}", configFile);
//        } catch (Exception e) {
//            LOG.error("[WS] Failed to persist config to YAML", e);
//        }
    }

    private String escapeYaml(String value) {
        if (value == null) return "";
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    /**
     * 处理命令输入（/ 开头），通过 CommandRegistry 分发执行
     */
    private void handleCommand(WebSocket socket, AgentSession session, ReActAgent agent, ChatModel chatModel,
                               String sessionCwd, String input, String finalSessionId) {
        try {
            // 解析命令名和参数
            List<String> parts = CmdUtil.parseArguments(input.trim().substring(1));
            if (parts.isEmpty()) {
                return;
            }

            String cmdName = parts.get(0).toLowerCase();
            List<String> args = parts.size() > 1 ? parts.subList(1, parts.size()) : new ArrayList<>();

            // 查找命令
            Command command = engine.getCommandRegistry().find(cmdName);
            if (command == null) {
                // 不是有效命令，当作普通输入走流式处理
                handleFallbackPrompt(socket, session, chatModel, sessionCwd, input, finalSessionId);
                return;
            }

            // 构建 context（注入 agentTaskRunner 回调）
            WebCommandContext ctx = new WebCommandContext(session, engine, input, cmdName, args,
                    (prompt, model) -> {
                        ChatModel selectedModel = model != null ? engine.getModelOrMain(model) : chatModel;
                        handleFallbackPrompt(socket, session, selectedModel, sessionCwd, prompt, finalSessionId);
                    });

            // 执行命令
            command.execute(ctx);

            if (!ctx.isAgentTask()) {
                // rewind 命令特殊处理：发送 rewind 事件让前端同步删除 DOM
                if ("rewind".equals(cmdName)) {
                    int rewindCount = 1;
                    if (!args.isEmpty()) {
                        try {
                            rewindCount = Integer.parseInt(args.get(0));
                        } catch (NumberFormatException ignored) {
                        }
                    }
                    socket.send(new ONode().set("type", "rewind")
                            .set("sessionId", finalSessionId)
                            .set("count", rewindCount + 1)
                            .toJson());
                } else {
                    String text = ctx.getOutputBuffer().length() > 0
                            ? ctx.getOutputBuffer().toString()
                            : "命令执行完成";
                    socket.send(new ONode().set("type", "command")
                            .set("sessionId", finalSessionId)
                            .set("text", text)
                            .toJson());
                }

                socket.send(new ONode().set("type", "done")
                        .set("sessionId", finalSessionId)
                        .set("modelName", chatModel.getConfig().getNameOrModel())
                        .set("totalTokens", 0)
                        .set("elapsedMs", 0).toJson());
            }
        } catch (Exception e) {
            String errorMsg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
            socket.send(new ONode().set("type", "error")
                    .set("sessionId", finalSessionId)
                    .set("text", errorMsg).toJson());
        }
    }

    /**
     * 将输入作为普通 prompt 走流式处理
     */
    private void handleFallbackPrompt(WebSocket socket, AgentSession session, ChatModel chatModel,
                                      String sessionCwd, String input, String finalSessionId) {
        Prompt prompt = Prompt.of(input);
        final long turnStartMs = System.currentTimeMillis();
        Disposable disposable = engine.prompt(prompt)
                .session(session)
                .options(o -> {
                    o.chatModel(chatModel);
                    if (Assert.isNotEmpty(sessionCwd)) {
                        o.toolContextPut(HarnessEngine.ATTR_CWD, sessionCwd);
                    }
                })
                .stream()
                .doFinally(signal -> session.attrs().remove("disposable"))
                .doOnNext(chunk -> {
                    if (chunk instanceof ReActChunk) {
                        onReActChunk((ReActChunk) chunk, finalSessionId, socket, turnStartMs);
                        return;
                    }
                    String msg = null;
                    if (chunk instanceof ReasonChunk) {
                        msg = onReasonChunk((ReasonChunk) chunk, finalSessionId);
                    } else if (chunk instanceof ActionChunk) {
                        msg = onActionStartChunk((ActionChunk) chunk, finalSessionId);
                    } else if (chunk instanceof ObservationChunk) {
                        msg = onObservationChunk((ObservationChunk) chunk, finalSessionId);
                    } else if (chunk instanceof ThoughtChunk) {
                        msg = onThoughtChunk((ThoughtChunk) chunk, finalSessionId);
                    } else if (chunk instanceof RetryChunk) {
                        msg = onRetryChunk((RetryChunk) chunk, finalSessionId);
                    } else if (chunk instanceof AgentStartChunk) {
                        msg = onAgentStartChunk((AgentStartChunk) chunk, finalSessionId);
                    } else if (chunk instanceof AgentEndChunk) {
                        msg = onAgentEndChunk((AgentEndChunk) chunk, finalSessionId);
                    }
                    if (Assert.isNotEmpty(msg)) {
                        socket.send(msg);
                    }
                })
                .doOnError(err -> socket.send(new ONode().set("type", "error")
                        .set("sessionId", finalSessionId)
                        .set("text", err.getMessage()).toJson()))
                .subscribe();

        Disposable old = (Disposable) session.attrs().put("disposable", disposable);
        if (old != null && !old.isDisposed()) {
            old.dispose();
        }
    }
}