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

import com.gourdai.agent.event.AbsToolCallEvent;
import com.gourdai.agent.event.AgentEvent;

import org.noear.snack4.ONode;
import com.gourdai.agent.AgentSession;
import com.gourdai.agent.react.ReActAgent;
import com.gourdai.agent.event.RunEndEvent;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.event.ToolCallStartEvent;
import com.gourdai.agent.event.ToolCallDraftEvent;
import com.gourdai.agent.event.ToolCallArgsDeltaEvent;
import com.gourdai.agent.event.ToolCallEndEvent;
import com.gourdai.agent.event.ReasonDeltaEvent;
import com.gourdai.agent.event.ReasonEndEvent;
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
import com.gourdai.harness.agent.AgentEndEvent;
import com.gourdai.harness.agent.AgentStartEvent;
import com.gourdai.harness.agent.RetryEvent;
import com.gourdai.harness.agent.TaskTalent;
import com.gourdai.harness.command.Command;
import com.gourdai.harness.talents.memory.MemoryTalent;
import org.noear.solon.ai.util.CmdUtil;
import com.gourdai.core.command.WebCommandContext;
import com.gourdai.core.portal.web.ThinkingDepth;
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
import java.util.Collections;
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
                        applyThinkingDepth(o, chatModel, session);
                    })
                    .stream()
                    .doFinally(signal -> {
                        session.attrs().remove("disposable");
                    })
                    .doOnNext(chunk -> projectAndSend(chunk, finalSessionId, socket, turnStartMs))
                    .doOnError(err -> {
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

    /**
     * 单一事件投影入口：把引擎事件投影为 /ws 通道的 JSON 文本并下发。
     *
     * <p><b>为什么存在：</b>onMessage / handleHitlAction / handleFallbackPrompt 三处此前
     * 各自复制了一份完全相同的 instanceof 分发链（仅判定顺序不同），共 24 处分支，
     * 改一处必漏两处。现统一收敛到本方法（各事件类型互斥，判定顺序不影响语义）。</p>
     *
     * <p><b>重要：本通道的线格式与 Web 通道（/web/gate 的 WebChunk）刻意不同，不得合并。</b>
     * 思考帧用 {@code think}、正文用 {@code reason}、结束用 {@code done}+modelName/elapsedMs，
     * 且不落盘、无 eventSeq；消费方是外部 CLI 客户端而非浏览器前端
     * （前端只连 /web/gate，见 app-streaming.js 的 connectWebGate）。
     * 因此这里只做内部去重，严禁改产出 WebChunk，否则会破坏 /ws 的既有契约。</p>
     *
     * @param chunk       引擎事件
     * @param sessionId   会话标识
     * @param socket      目标 WebSocket
     * @param turnStartMs 本轮订阅时刻，用于 RunEndEvent 计算单轮耗时
     */
    private void projectAndSend(AgentEvent chunk, String sessionId, WebSocket socket, long turnStartMs) {
        // RunEndEvent 需要优先处理 metrics 收集（无论 hasContent 状态）
        if (chunk instanceof RunEndEvent) {
            onRunEndEvent((RunEndEvent) chunk, sessionId, socket, turnStartMs);
            return;
        }

        String msg = null;
        if (chunk instanceof ReasonDeltaEvent) {
            msg = onReasonDeltaEvent((ReasonDeltaEvent) chunk, sessionId);
        } else if (chunk instanceof ToolCallStartEvent) {
            msg = onToolCallStartEvent((ToolCallStartEvent) chunk, sessionId);
        } else if (chunk instanceof ToolCallDraftEvent) {
            // 与 ToolCallStartEvent 是兄弟类（同继承 AbsToolCallEvent），判定先后不影响语义；
            // 紧挨着放是为了让「同一张卡片的三个生命周期阶段」在代码里保持相邻可读。
            msg = onToolCallDraftEvent((ToolCallDraftEvent) chunk, sessionId);
        } else if (chunk instanceof ToolCallArgsDeltaEvent) {
            msg = onToolCallArgsDeltaEvent((ToolCallArgsDeltaEvent) chunk, sessionId);
        } else if (chunk instanceof ToolCallEndEvent) {
            msg = onToolCallEndEvent((ToolCallEndEvent) chunk, sessionId);
        } else if (chunk instanceof ReasonEndEvent) {
            // 子代理聚合载荷可能同时带思考与正文，需下发两帧（一个 ONode 只能装一份 text）
            for (String frame : onReasonEndEvent((ReasonEndEvent) chunk, sessionId)) {
                if (Assert.isNotEmpty(frame)) {
                    socket.send(frame);
                }
            }
            return;
        } else if (chunk instanceof RetryEvent) {
            msg = onRetryEvent((RetryEvent) chunk, sessionId);
        } else if (chunk instanceof AgentStartEvent) {
            msg = onAgentStartEvent((AgentStartEvent) chunk, sessionId);
        } else if (chunk instanceof AgentEndEvent) {
            msg = onAgentEndEvent((AgentEndEvent) chunk, sessionId);
        }

        if (Assert.isNotEmpty(msg)) {
            socket.send(msg);
        }
    }

    private void onRunEndEvent(RunEndEvent chunk, String finalSessionId, WebSocket socket, long turnStartMs) {
        ReActTrace trace = chunk.getTrace();
        // 单轮耗时：从本轮订阅起算，而非 originalPrompt 里的 start_time（跨轮复用会累计成整段对话时长）。
        long elapsed = turnStartMs > 0 ? System.currentTimeMillis() - turnStartMs : 0;
        long inputTokens = trace.getMetrics() != null ? trace.getMetrics().getPromptTokens() : 0;
        long outputTokens = trace.getMetrics() != null ? trace.getMetrics().getCompletionTokens() : 0;

        String msg2 = new ONode().set("type", "done")
                .set("sessionId", finalSessionId)
                .set("runId", trace.getRunId())
                .set("modelName", trace.getOptions().getChatModel().getNameOrModel())
                .set("inputTokens", inputTokens)
                .set("outputTokens", outputTokens)
                .set("elapsedMs", elapsed).toJson();

        socket.send(msg2);
    }

    private String onReasonDeltaEvent(ReasonDeltaEvent chunk, String finalSessionId) {
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
     * 处理 RetryEvent（模型调用失败自动重试时发送）：推送 retry 提示，
     * 让前端展示「正在重试 N/M」的中间状态。
     */
    private String onRetryEvent(RetryEvent chunk, String finalSessionId) {
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
     * 处理 ToolCallStartEvent（工具调用前发送）：在工具实际执行前推送 action_start，
     * 让前端提前渲染 loading 状态的工具卡片骨架，提升流式实时感。
     * 过滤规则与 onToolCallEndEvent 保持一致，避免卡片创建后却无对应结果填充。
     */
    private String onToolCallStartEvent(ToolCallStartEvent chunk, String finalSessionId) {
        if (Assert.isEmpty(chunk.getToolName())) {
            return null;
        }

        if (TaskTalent.TOOL_MULTITASK.equals(chunk.getToolName()) ||
                TaskTalent.TOOL_TASK.equals(chunk.getToolName()) ||
                MemoryTalent.isMemoryTool(chunk.getToolName())) {
            return null;
        }

        // todowrite 的展示走专用通道，由 ToolCallEndEvent 携带完整 todos 渲染，开始阶段不提前建卡
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

    /**
     * 处理 ToolCallDraftEvent（模型刚说出函数名、参数仍在流式生成）：提前下发 action_draft。
     *
     * <p><b>为什么必须有这一帧：</b>{@code action_start} 要等参数<b>完整</b>、工具即将执行时才发出，
     * 而一次大参数调用（如 write 一整篇文档）的参数生成可持续数十秒。这段空窗期本通道一帧不发，
     * 消费方无从区分「模型还在写」与「连接已死」，只能干等。本帧把卡片骨架提前立起来补上该盲区。</p>
     *
     * <p>本帧与随后的 action_start 共享同一个 actionId（同源于原生 ToolCall.getId()），
     * 消费方据此幂等接管同一张卡片而不是重复建卡；此刻参数尚不完整故不带 args，由 action_start 回填。</p>
     */
    private String onToolCallDraftEvent(ToolCallDraftEvent chunk, String finalSessionId) {
        if (!isStartPhaseVisible(chunk.getToolName())) {
            return null;
        }

        ONode node = new ONode().set("type", "action_draft")
                .set("sessionId", finalSessionId);

        if (engine.getName().equals(chunk.getAgentName())) {
            node.set("toolName", chunk.getToolName());
        } else {
            node.set("toolName", chunk.getAgentName() + "/" + chunk.getToolName());
        }

        copyActionMetadata(node, chunk);

        return node.toJson();
    }

    /**
     * 处理 ToolCallArgsDeltaEvent（参数生成进度）：下发 action_args 报告累计字节数。
     *
     * <p><b>只报字节数不报内容：</b>参数生成期消费方需要的只是「还在动、进展到哪」，完整参数最终由
     * action_start 给出；不传内容同时免去了对未闭合 JSON 片段（如 {@code '{"comm'}）的容错解析。</p>
     *
     * <p>下发频率由生产方（ReasonTask）按时间/字节双阈值节流，故此处不再二次限流；
     * 本帧是瞬态进度帧，/ws 通道本就不落盘，断线重连后由 action_start/action_end 重建卡片。</p>
     */
    private String onToolCallArgsDeltaEvent(ToolCallArgsDeltaEvent chunk, String finalSessionId) {
        if (!isStartPhaseVisible(chunk.getToolName())) {
            return null;
        }

        ONode node = new ONode().set("type", "action_args")
                .set("sessionId", finalSessionId)
                .set("argsBytes", chunk.getArgsBytes());

        if (engine.getName().equals(chunk.getAgentName())) {
            node.set("toolName", chunk.getToolName());
        } else {
            node.set("toolName", chunk.getAgentName() + "/" + chunk.getToolName());
        }

        copyActionMetadata(node, chunk);

        return node.toJson();
    }

    private String onToolCallEndEvent(ToolCallEndEvent chunk, String finalSessionId) {
        if (chunk.getError() != null) {
            if (!isVisibleTool(chunk.getToolName())) return null;
            ONode node = new ONode().set("type", "action_end")
                    .set("sessionId", finalSessionId)
                    .set("text", "__ERROR__" + safeError(chunk.getError()));
            if (engine.getName().equals(chunk.getAgentName())) {
                node.set("toolName", chunk.getToolName());
            } else {
                node.set("toolName", chunk.getAgentName() + "/" + chunk.getToolName());
            }
            if (chunk.getArgs() != null) node.set("args", chunk.getArgs());
            copyActionMetadata(node, chunk);
            return node.toJson();
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

    private void copyActionMetadata(ONode node, com.gourdai.agent.event.AbsToolCallEvent chunk) {
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
                        applyThinkingDepth(o, chatModel, session);
                    })
                    .stream()
                    .doFinally(signal -> session.attrs().remove("disposable"))
                    .doOnNext(chunk -> projectAndSend(chunk, sessionId, socket, turnStartMs))
                    .doOnError(err -> socket.send(new ONode().set("type", "error")
                            .set("sessionId", sessionId).set("text", err.getMessage()).toJson()))
                    .subscribe();

            session.attrs().put("disposable", disposable);
        } catch (Exception e) {
            LOG.error("[WS] HITL action failed", e);
            socket.send(new ONode().set("type", "error").set("text", e.getMessage()).toJson());
        }
    }

    /**
     * 处理子代理的聚合载荷（ReasonEndEvent）。
     *
     * <p>正文必须用 {@code getText()} 而不是 {@code getAssistantMessage().getResultContent()}：
     * 后者内部是 stripThinkTags，对「inline-think 方言」（Qwen 等把思考直接写在正文里、用
     * &lt;think&gt; 标签包裹）会把标签前的真实正文一并吃掉，只剩标签后的残段——
     * AgentUtilTest 里已有针对该缺陷的护栏用例。</p>
     *
     * <p><b>通道命名与 Web 端相反，切勿写反：</b>/ws 协议里 {@code think}=思考、{@code reason}=正文
     * （见 {@link #onReasonDeltaEvent}）；而 Web 端 WebChunk 里 {@code reason}=思考、{@code text}=正文。</p>
     *
     * <p>返回多帧而非单帧：一个 ONode 只能承载一份 text，而思考与正文是两份独立载荷；
     * 旧实现只发正文，子代理思考在桌面端永远不可见。</p>
     *
     * @return 0..2 帧 JSON（思考帧 + 正文帧）
     */
    private List<String> onReasonEndEvent(ReasonEndEvent chunk, String finalSessionId) {
        if (!chunk.hasMeta(TaskTalent.META_SUBAGENT)) {
            return Collections.emptyList();
        }

        List<String> frames = new ArrayList<>(2);
        String agentName = chunk.getTrace().getAgentName();

        if (chunk.hasThinking()) {
            frames.add(reasonFrame("think", chunk.getThinking(), finalSessionId, agentName));
        }

        String content = chunk.getText();
        if (Assert.isNotEmpty(content)) {
            // 前置换行是多子代理并行时的帧间分隔（与旧行为一致）
            frames.add(reasonFrame("reason", "\n" + content, finalSessionId, agentName));
        }

        return frames;
    }

    /** 组一帧 think/reason 载荷；非主引擎代理附带 agentName 供客户端分组。 */
    private String reasonFrame(String type, String text, String sessionId, String agentName) {
        ONode node = new ONode().set("type", type)
                .set("sessionId", sessionId)
                .set("text", text);

        if (!engine.getName().equals(agentName)) {
            node.set("agentName", agentName);
        }

        return node.toJson();
    }

    /**
     * 处理 AgentStartEvent（子代理启动）
     */
    private String onAgentStartEvent(AgentStartEvent chunk, String sessionId) {
        String agentName = chunk.getAgentName();
        String description = chunk.getDescription();
        ONode args = new ONode().set("agentName", agentName).set("description", description);
        if (chunk.getInvocationId() != null) args.set("invocationId", chunk.getInvocationId());
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
     * 处理 AgentEndEvent（子代理结束）
     */
    private String onAgentEndEvent(AgentEndEvent chunk, String sessionId) {
        String agentName = chunk.getAgentName();
        String description = chunk.getDescription();
        ONode args = new ONode()
                .set("agentName", agentName)
                .set("description", description)
                .set("invocationId", chunk.getInvocationId())
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
                    applyThinkingDepth(o, chatModel, session);
                })
                .stream()
                .doFinally(signal -> session.attrs().remove("disposable"))
                .doOnNext(chunk -> projectAndSend(chunk, finalSessionId, socket, turnStartMs))
                .doOnError(err -> socket.send(new ONode().set("type", "error")
                        .set("sessionId", finalSessionId)
                        .set("text", err.getMessage()).toJson()))
                .subscribe();

        Disposable old = (Disposable) session.attrs().put("disposable", disposable);
        if (old != null && !old.isDisposed()) {
            old.dispose();
        }
    }

    private void applyThinkingDepth(com.gourdai.agent.react.ReActOptionsAmend o, ChatModel model, AgentSession session) {
        String depth = ThinkingDepth.normalize(session.getContext().getAs(HarnessEngine.CTX_THINKING_DEPTH));
        ThinkingDepth.applyTo(o, model, depth);
        o.toolContextPut(HarnessEngine.ATTR_THINKING_DEPTH, depth);
    }

    private static boolean isVisibleTool(String toolName) {
        return Assert.isNotEmpty(toolName) && !TaskTalent.TOOL_TASK.equals(toolName)
                && !TaskTalent.TOOL_MULTITASK.equals(toolName) && !MemoryTalent.isMemoryTool(toolName);
    }

    /**
     * 参数生成期帧（action_draft / action_args）的可见性判定。
     *
     * <p>口径必须与 {@link #onToolCallStartEvent} 逐条一致：一旦漂移，被过滤的内部工具会被提前建出
     * 骨架卡，而它永远等不到配对的 action_start / action_end，卡片将永久停在 loading 态。</p>
     */
    private static boolean isStartPhaseVisible(String toolName) {
        // todowrite 的展示走专用面板（由 action_end 携带完整 todos 渲染），开始阶段一律不建卡
        return isVisibleTool(toolName) && !"todowrite".equals(toolName);
    }

    private static String safeError(Throwable error) {
        if (error == null) return "unknown";
        return Assert.isNotEmpty(error.getMessage()) ? error.getMessage() : error.getClass().getSimpleName();
    }
}