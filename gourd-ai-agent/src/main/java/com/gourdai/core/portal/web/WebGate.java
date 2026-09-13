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

import org.noear.snack4.ONode;
import com.gourdai.agent.AgentSession;
import com.gourdai.agent.react.ReActAgent;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.intercept.HITL;
import com.gourdai.agent.react.intercept.HITLTask;
import org.noear.solon.ai.chat.ChatModel;
import org.noear.solon.ai.chat.content.Contents;
import org.noear.solon.ai.chat.content.ImageBlock;
import org.noear.solon.ai.chat.content.TextBlock;
import org.noear.solon.ai.chat.message.AssistantMessage;
import org.noear.solon.ai.chat.message.ChatMessage;
import org.noear.solon.ai.chat.message.UserMessage;
import org.noear.solon.ai.chat.prompt.Prompt;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.change.FileChangeService;
import com.gourdai.harness.command.Command;
import org.noear.solon.ai.util.CmdUtil;
import com.gourdai.core.command.WebCommandContext;
import com.gourdai.core.command.builtin.LoopExecutionResult;
import org.noear.solon.core.handle.UploadedFile;
import org.noear.solon.core.util.Assert;
import org.noear.solon.core.util.RunUtil;
import org.noear.solon.net.websocket.WebSocket;
import org.noear.solon.net.websocket.listener.SimpleWebSocketListener;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.Disposable;
import reactor.core.publisher.SignalType;
import reactor.core.scheduler.Schedulers;

import java.io.File;
import java.io.IOException;
import java.nio.file.Paths;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * WebGate - 前端统一 WebSocket 网关
 *
 * <p>作为后端的统一输出调度 + 统一输入入口，消除双通道问题。
 * 前端整个生命周期只维护一个 WebSocket 连接，不跟任何特定 sessionId 绑定。
 * 后端推送的所有消息包都携带 sessionId 字段，前端根据此字段分发到对应会话进行渲染。</p>
 *
 * @author oisin
 */
public class WebGate extends SimpleWebSocketListener {
    private static final Logger LOG = LoggerFactory.getLogger(WebGate.class);

    /** AI 引擎实例，提供会话管理、模型获取、命令注册等核心能力 */
    private final HarnessEngine engine;

    /** 流式响应构建器，负责组装 ReAct Agent 的流式输出并通过本网关推送 */
    private final WebStreamBuilder streamBuilder;

    /**
     * 会话目录定位器（可选）。
     *
     * <p>IM 通道流入 code 会话时，请求不带 {@code X-Session-Cwd} 头，
 * 需在处理输入前调用 {@link SessionLocator#bindSessionRoot} 登记所属工作空间根，
     * 才能让 {@code AgentSessionProvider} 正确解析 code 会话的落盘目录。</p>
     */
    private SessionLocator sessionLocator;

    /**
     * 流式事件存储（可选）。把流经 {@link #emitToClient} 的工具卡片、过程叙述、思考、trace 等
     * 落盘到 {@code <sessionId>.stream.ndjson}，供历史加载时原样回放。为 null 时不持久化。
     */
    private SessionStreamStore streamStore;

    /**
     * WebSocket 连接池。
     *
     * <p>每个浏览器 Tab 建立一个独立的 WebSocket 连接并注册到此列表中。
     * 所有出站消息（AI 响应、命令输出、系统事件）均通过遍历此列表广播，
     * 每条消息携带 sessionId 由前端自行路由到对应会话面板。</p>
     *
     * <p>使用 {@link CopyOnWriteArrayList} 保证并发读写安全。</p>
     */
    private final List<WebSocket> connections = new CopyOnWriteArrayList<>();

    /** 原子串行化同一会话的输入受理，收拢 busy 检查、user 落盘与任务登记之间的竞态窗口。 */
    private final Map<String, Object> inputLocks = new ConcurrentHashMap<>();

    /** 会话流事件固定所属根。活动任务期间不再依赖可变的 SessionLocator 绑定，避免 busy 请求改绑后写错目录。 */
    private final Map<String, String> streamRoots = new ConcurrentHashMap<>();

    /** 统一序列化同一会话的持久化与广播，避免并发事件乱序。 */
    private final Map<String, Object> publishLocks = new ConcurrentHashMap<>();


    /**
     * 构造网关实例。
     *
     * @param engine     AI 引擎，提供会话、模型、Agent、命令等核心服务
     */
    public WebGate(HarnessEngine engine) {
        this.engine = engine;
        this.streamBuilder = new WebStreamBuilder(engine, this);
        FileChangeService.getInstance().setListener((sessionId, runId, summary) ->
                emitToClient(sessionId, WebChunk.ofFileChanges(runId, summary)));
    }

    /**
     * 注入会话目录定位器（供 IM 通道流入 code 会话时登记项目根）。
     *
     * @param sessionLocator 会话目录定位器
     */
    public void setSessionLocator(SessionLocator sessionLocator) {
        this.sessionLocator = sessionLocator;
    }

    /**
     * 解析本轮任务的文件变更账本所属根（写账本 / 收口 / 前端读取 三方共用的唯一口径）。
     *
     * <p>优先级：显式 sessionCwd &gt; 会话已登记的所属根 &gt; 安装工作区。与上方 streamRoot
     * 的取法保持一致（只多一个 workspace 兜底，因为账本必须有一个确定的根）。</p>
     *
     * <p><b>为何必须抽成方法：</b>旧实现把这段表达式在异步/同步两条路径里各拄了一份，
     * 而 WebStreamBuilder 注入 ATTR_CWD（ActionTask 据此写账本）时用的却是
     * {@code sessionCwd ?: engine.getWorkspace()}——<b>少了 boundRoot 这一级</b>。于是当
     * sessionCwd 为空且 boundRoot 与 workspace 不同时（IM 通道流入 code 会话正是此形态），
     * 账本被写进 workspace 那份，而 finish() 去标记 boundRoot 那份 → 真实 manifest 永远
     * 不 ready，叠加“ready 是撤销第一道门禁”就是卡片显示 0 个文件、而磁盘实际改了 N 个。
     * 现在本方法的返回值会被直接传给 buildStreamFlux 作为工具 cwd，三方口径强制一致。</p>
     */
    private String resolveChangeRoot(String sessionId, String sessionCwd) {
        // 统一走 SessionLocator 的写入根口径（sessionCwd > boundRoot > globalBase），
        // 使「工具写入根 == 会话落盘根 == 前端读取根」三方一致。
        //
        // 旧实现末级兜底用 engine.getWorkspace()（user.dir），而 SessionLocator 读取侧兜底
        // 用 globalBase（user.home）：两者在桌面端/裸 CLI 下并不相等。于是无所属根的会话中
        // todowrite 把 TODO.md 写进 user.dir、查询接口却去 user.home 找，任务面板恒为空。
        if (sessionLocator != null) {
            String resolved = sessionLocator.resolveWriteRoot(sessionId, sessionCwd);
            if (Assert.isNotEmpty(resolved)) {
                return resolved;
            }
        }
        if (Assert.isNotEmpty(sessionCwd)) {
            return sessionCwd;
        }
        return engine.getWorkspace();
    }

    /**
     * run 收口：把文件变更账本从「进行中」切到可撤销状态，全程只允许生效一次。
     *
     * <p><b>为何必须在每一条终止路径上都调：</b>{@code FileChangeService.finish} 里的
     * {@code ready=true} 是撤销/重放的第一道门禁（{@code applyLocked} 里 {@code !ready} 直接回
     * BUSY）。旧实现只在 doOnNext 收到 done 帧且 {@code !streamFailed} 时才 finish，于是三条
     * 终止路径全部漏掉：① 流异常（error 帧置了 streamFailed，done 帧被跳过）；② 用户 Stop /
     * 新任务取代（cancel 时 done 帧根本不经过 doOnNext）；③ 进程崩溃。而“agent 跑挂了、
     * 工作区被改乱”恰恰是最需要回滚的时刻，撤销按钮却永久返回 BUSY。</p>
     *
     * <p>③ 由 {@code FileChangeService} 的进程启动补偿兜底（按 {@code updatedAt < 进程启动时刻}
     * 识别遗留账本）；①② 由本方法的三个调用点覆盖。</p>
     *
     * @param clean true = 正常收口（READY）；false = 异常/取消收口。后者<b>同样解锁撤销能力</b>，
     *              只是额外标记 possiblyIncomplete：异常终止时最后几个 write/edit 可能没来得及落账。
     * @param once  幂等守卫；三条路径共享同一个，成功后保持完成，失败则释放供后续回调重试
     */
    private void finishFileChanges(String sessionId, String runId, String changeRoot, boolean clean, AtomicBoolean once) {
        if (runId == null || changeRoot == null) {
            // runId 从未出现说明这一轮没有任何事件带 runId，账本也就根本没被建出来，没有需要解锁的东西。
            // 刻意不消耗 once 标志：后续帧仍可能带上 runId。
            return;
        }
        finishOnce(once, () -> FileChangeService.getInstance().finish(sessionId, runId, changeRoot, clean));
    }

    /**
     * 可测试的收口幂等 seam：同一时刻最多一个调用；只有真实成功才永久关闭，失败允许 doFinally 再试。
     */
    static boolean finishOnce(AtomicBoolean once, java.util.function.BooleanSupplier action) {
        if (!once.compareAndSet(false, true)) {
            return false;
        }
        boolean succeeded = false;
        try {
            succeeded = action.getAsBoolean();
            return succeeded;
        } finally {
            if (!succeeded) {
                once.set(false);
            }
        }
    }

    /**
     * 注入流式事件存储（供历史回放持久化）。
     *
     * @param streamStore 流式事件存储
     */
    public void setStreamStore(SessionStreamStore streamStore) {
        this.streamStore = streamStore;
    }

    /**
     * 获取流式事件存储（可为 null）。
     *
     * @return 当前网关关联的 {@link SessionStreamStore} 实例
     */
    public SessionStreamStore getStreamStore() {
        return streamStore;
    }

    /**
     * 获取流式响应构建器。
     *
     * <p>供 WeChatLink 等外部组件引用，用于构建与 WebSocket 网关共享的流式输出管道。</p>
     *
     * @return 当前网关关联的 {@link WebStreamBuilder} 实例
     */
    public WebStreamBuilder getStreamBuilder() {
        return streamBuilder;
    }

    // ═══════════════════════════════════════════════════════════════
    //  WebSocket 生命周期管理
    // ═══════════════════════════════════════════════════════════════

    /**
     * WebSocket 连接建立时回调。
     *
     * <p>将新连接加入 {@link #connections} 连接池，后续出站消息将自动广播至此连接。</p>
     *
     * @param socket 新建立的 WebSocket 连接
     */
    @Override
    public void onOpen(WebSocket socket) {
        connections.add(socket);
        LOG.info("[WebGate] WebSocket opened: {}", socket.id());
    }

    /**
     * WebSocket 连接关闭时回调。
     *
     * <p>从 {@link #connections} 连接池中移除已断开的连接，停止向其推送消息。</p>
     *
     * @param socket 已关闭的 WebSocket 连接
     */
    @Override
    public void onClose(WebSocket socket) {
        connections.remove(socket);
        LOG.info("[WebGate] WebSocket closed: {}", socket.id());
    }

    /**
     * WebSocket 文本消息接收回调。
     *
     * <p>当前仅处理心跳检测（ping/pong），业务消息通过 HTTP 接口入口进入。</p>
     *
     * @param socket 来源 WebSocket 连接
     * @param text   接收到的文本消息
     */
    @Override
    public void onMessage(WebSocket socket, String text) throws IOException {
        // 心跳处理
        if ("ping".equals(text)) {
            socket.send("pong");
        }
    }


    // ═══════════════════════════════════════════════════════════════
    //  输出端口 —— 向前端推送消息
    // ═══════════════════════════════════════════════════════════════

    /**
     * 统一输出：将消息块通过 WebSocket 推送至前端。
     *
     * <p>将 sessionId 注入到消息块中，然后序列化为 JSON 广播给所有已连接的前端。
     * 前端根据消息中的 sessionId 字段路由到对应的会话面板进行渲染。</p>
     *
     * @param sessionId 会话标识，用于前端路由消息到正确的会话面板
     * @param jsonChunk 待推送的消息块（可为文本流、错误、完成信号等多种类型）
     */
    public void emitToClient(String sessionId, WebChunk jsonChunk) {
        if (jsonChunk == null) {
            return;
        }
        jsonChunk.setSessionId(sessionId);
        synchronized (publishLocks.computeIfAbsent(sessionId, k -> new Object())) {
            if (streamStore != null) {
                streamStore.record(sessionId, streamRoots.get(sessionId), jsonChunk);
            }
            String enriched = ONode.serialize(jsonChunk);

            if (LOG.isDebugEnabled()) {
                LOG.debug("emit: " + enriched);
            }

            for (WebSocket socket : connections) {
                if (socket != null) {
                    try {
                        socket.send(enriched);
                    } catch (Throwable e) {
                        LOG.warn("[WebGate] Failed to send to socket {}: {}", socket.id(), e.getMessage());
                    }
                }
            }
        }
    }

    /**
     * 广播原始 JSON 字符串到所有 WebSocket 连接。
     *
     * <p>与 {@link #emitToClient} 不同，此方法不注入 sessionId，
     * 适用于系统级事件（如文件变化通知）等需要全局广播的场景。</p>
     *
     * @param json 待广播的原始 JSON 字符串
     */
    public void broadcastRaw(String json) {
        for (WebSocket socket : connections) {
            if (socket != null) {
                try {
                    socket.send(json);
                } catch (Throwable e) {
                    LOG.warn("[WebGate] broadcastRaw failed for {}: {}", socket.id(), e.getMessage());
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  输入端口 —— 接收并处理用户请求
    // ═══════════════════════════════════════════════════════════════

    /**
     * 用户聊天输入入口（由 WebController HTTP 接口调用）。
     *
     * <p>核心处理流程：</p>
     * <ol>
     *   <li>解析 Agent 指定前缀（如 "@agentName 消息内容"）</li>
     *   <li>处理 HITL（Human-in-the-Loop）审批/拒绝操作</li>
     *   <li>处理文件附件上传（图片走 Base64 编码，其他走文件路径引用）</li>
     *   <li>判断是否为斜杠命令（/command），若是则走命令分发</li>
     *   <li>构建 Prompt 并启动 Agent 流式任务</li>
     * </ol>
     *
     * @param sessionId       会话标识
     * @param sessionCwd      会话当前工作目录，用于 Agent 执行文件操作的基准路径
     * @param input           用户输入的文本内容
     * @param selectedModel   用户选择的 AI 模型标识（可为 null，表示使用默认模型）
     * @param attachments     上传的文件附件数组（可为 null）
     * @param attachmentTypes 附件类型数组，与 attachments 一一对应（如 "image"）
     * @param hitlAction      HITL 操作类型，取值 "approve" 或 "reject"（可为 null）
     * @param source          本轮输入来源："WeChat"/"Feishu"/"DingTalk"/"Loop" 等；网页手动输入传 null
     * @return true 表示输入已被受理执行；false 表示会话繁忙（有任务在执行）被跳过，
     *         调用方应据此向前端返回 busy 状态，由前端暂存消息待当前任务完成后补发
     */
    public boolean onChatInput(String sessionId,
                               String sessionCwd,
                               String input, String selectedModel,
                               UploadedFile[] attachments, String[] attachmentTypes,
                               String hitlAction, String source) {
        return onChatInput(sessionId, sessionCwd, input, selectedModel, attachments, attachmentTypes,
                hitlAction, source, null);
    }

    public boolean onChatInput(String sessionId,
                               String sessionCwd,
                               String input, String selectedModel,
                               UploadedFile[] attachments, String[] attachmentTypes,
                               String hitlAction, String source, String clientMessageId) {
        synchronized (inputLocks.computeIfAbsent(sessionId, k -> new Object())) {
            return doOnChatInput(sessionId, sessionCwd, input, selectedModel, attachments, attachmentTypes,
                    hitlAction, source, clientMessageId);
        }
    }

    private boolean doOnChatInput(String sessionId,
                                  String sessionCwd,
                                  String input, String selectedModel,
                                  UploadedFile[] attachments, String[] attachmentTypes,
                                  String hitlAction, String source, String clientMessageId) {
        AgentSession session = null;
        try {
            session = engine.getSession(sessionId);

            // busy 请求不能覆盖正在运行任务的来源；来源只在确认本次输入可受理后更新。
            if (Assert.isEmpty(hitlAction) && isSessionBusy(session)) {
                LOG.warn("[WebGate] chat input skipped for session {}: task in progress", sessionId);
                return false;
            }
            if (source != null) {
                session.attrs().put("_input_source", source);
            } else {
                session.attrs().remove("_input_source");
            }

            // 通过受理锁内的 busy 检查后才允许登记所属根，确保首次解析及后续旁路落盘一致；
            // busy 请求不会改绑活动会话。
            if (sessionLocator != null && Assert.isNotEmpty(sessionCwd)) {
                sessionLocator.bindSessionRoot(sessionId, sessionCwd);
            }

            // 本会话流事件固定写入本轮所属根。后续即使另一个 busy 请求误带不同 cwd，
            // emitToClient 也不会跟随可变注册表跳到其它项目目录。
            String streamRoot = Assert.isNotEmpty(sessionCwd)
                    ? sessionCwd
                    : (sessionLocator == null ? null : sessionLocator.boundRoot(sessionId));
            if (Assert.isNotEmpty(streamRoot)) {
                streamRoots.put(sessionId, streamRoot);
            } else {
                streamRoots.remove(sessionId);
            }

            // 网页手动输入只有在本次受理锁内通过 busy 检查后才落盘；这样既保证 user 在首个
            // AI chunk 之前，又避免竞态失败请求留下幽灵 user。IM/Loop 自己通过 emitToClient 记录用户事件。
            if (clientMessageId != null && Assert.isEmpty(hitlAction) && Assert.isNotEmpty(input)
                    && !input.startsWith("/") && streamStore != null) {
                streamStore.recordUser(sessionId, streamRoot, input, System.currentTimeMillis(), clientMessageId);
            }
            if (source != null && Assert.isEmpty(hitlAction)) {
                emitToClient(sessionId, WebChunk.ofUser(input, source));
            }

            String agentName = null;
            String currentInput = input;

            if (currentInput != null && currentInput.startsWith("@")) {
                int agentNameIdx = currentInput.indexOf(" ");
                if (agentNameIdx > 0) {
                    agentName = currentInput.substring(1, agentNameIdx);

                    if (engine.getAgentManager().hasAgent(agentName)) {
                        currentInput = currentInput.substring(agentNameIdx + 1);
                    }
                }
            }


            // HITL approve/reject handling
            if (Assert.isNotEmpty(hitlAction)) {
                HITLTask task = HITL.getPendingTask(session);
                if (task != null) {
                    if ("approve".equals(hitlAction)) {
                        HITL.approve(session, task.getToolName());
                    } else {
                        HITL.reject(session, task.getToolName());
                    }
                }
                // Resume streaming after HITL decision
                performAgentTaskAsync(session, sessionCwd, null, selectedModel, agentName);
                return true;
            }

            // Handle file upload - save to session directory
            List<ImageBlock> imageBlocks = new ArrayList<>();
            List<String> fileAttachments = new ArrayList<>();

            if (attachments != null) {
                // 解析会话目录，作为附件存储根路径
                java.nio.file.Path sessionDir;
                if (sessionLocator != null) {
                    sessionDir = sessionLocator.resolveDir(sessionId, sessionCwd).toPath();
                } else {
                    // 降级：回退到工作区（兼容旧版本）
                    sessionDir = java.nio.file.Paths.get(engine.getWorkspace());
                }
                
                // 在会话目录下创建 uploads 子目录用于存放上传的文件
                java.nio.file.Path uploadsDir = sessionDir.resolve("uploads");
                try {
                    java.nio.file.Files.createDirectories(uploadsDir);
                } catch (java.io.IOException e) {
                    LOG.warn("Failed to create uploads directory: {}", uploadsDir, e);
                    // 创建失败则回退到会话目录本身
                    uploadsDir = sessionDir;
                }
                
                for (int i = 0; i < attachments.length; i++) {
                    UploadedFile attachment = attachments[i];
                    String fileName = attachment.getName();
                    if (fileName != null && !fileName.contains("..") && !fileName.contains("/") && !fileName.contains("\\")) {
                        String ext = "." + attachment.getExtension();
                        // 保存到会话空间内的 uploads 目录，实现 session 间隔离
                        java.nio.file.Path savePath = uploadsDir.resolve(fileName).toAbsolutePath().normalize();

                        // 安全校验：确保保存路径仍在 uploads 目录内
                        if (savePath.startsWith(uploadsDir.toAbsolutePath().normalize())) {
                            java.nio.file.Files.copy(attachment.getContent(), savePath, java.nio.file.StandardCopyOption.REPLACE_EXISTING);

                            if (isImageAttachment(ext, attachmentTypes != null && i < attachmentTypes.length ? attachmentTypes[i] : null)) {
                                byte[] bytes = java.nio.file.Files.readAllBytes(savePath);
                                String base64 = Base64.getEncoder().encodeToString(bytes);
                                String mime = extensionToMime(ext);
                                imageBlocks.add(ImageBlock.ofBase64(base64, mime));
                            } else {
                                // 对于非图片文件，传递相对路径便于在会话内引用
                                fileAttachments.add("uploads/" + fileName);
                            }
                        }
                    }
                }
            }

            // Build input text with file attachment prefix
            if (!fileAttachments.isEmpty()) {
                String filePrefix = fileAttachments.stream()
                        .map(f -> "[附件: " + f + "]")
                        .collect(java.util.stream.Collectors.joining("\n"));
                if (currentInput == null || currentInput.isEmpty()) {
                    currentInput = filePrefix + "\n请帮我处理这些附件";
                } else {
                    currentInput = filePrefix + "\n" + currentInput;
                }
            }

            if (Assert.isNotEmpty(currentInput) || !imageBlocks.isEmpty()) {
                if (currentInput == null || currentInput.isEmpty()) {
                    currentInput = imageBlocks.size() > 1 ? "请描述这些图片" : "请描述这张图片";
                }

                // 命令分发
                if (currentInput.startsWith("/") && imageBlocks.isEmpty()) {
                    if (isCommand(session, sessionCwd, currentInput, selectedModel, agentName)) {
                        return true;
                    }
                }

                // 中断续跑：上次任务异常中断（如模型调用失败）时，用户再发消息不从头重跑，
                // 而是保留断点工作记忆（推理 + 工具结果），把新消息追加进去接着执行，避免浪费 token。
                // 仅纯文本场景启用（含图片的复合消息维持新任务语义）。
                if (imageBlocks.isEmpty()) {
                    ReActTrace resumeTrace = engine.resolveTrace(session, agentName);
                    if (engine.canResume(resumeTrace)) {
                        // 自动续跑仅在异常中断时触发，最后一条是失败兜底消息，需移除重生成；
                        // 传入 sessionCwd 供恢复校准定位 TODO.md
                        engine.prepareResume(resumeTrace, session, currentInput, true, sessionCwd);
                        // 空 Prompt 触发库的恢复分支，复用已有工作记忆
                        performAgentTaskAsync(session, sessionCwd, Prompt.of(), selectedModel, agentName);
                        return true;
                    }
                }

                Prompt prompt;
                if (!imageBlocks.isEmpty()) {
                    Contents contents = new Contents();
                    contents.addBlock(TextBlock.of(currentInput));
                    for (ImageBlock block : imageBlocks) {
                        contents.addBlock(block);
                    }
                    prompt = Prompt.of(new UserMessage(contents));
                } else {
                    prompt = Prompt.of(currentInput);
                }

                // 流式处理：输出通过 WebSocket 推送
                performAgentTaskAsync(session, sessionCwd, prompt, selectedModel, agentName);
            }
        } catch (Exception e) {
            LOG.error("Task fail: {}", e.getMessage(), e);
            emitToClient(sessionId, WebChunk.ofError(e));
            emitToClient(sessionId, WebChunk.ofDone());
        } finally {
            if (session != null) {
                if (session.isEmpty() && Assert.isNotEmpty(input)) {
                    //如果是空，可能发的是 command（还没有对话记录）
                    try {
                        // code 会话落在所选项目目录，用 locator 解析正确落盘目录；chat 会话回退安装目录
                        File sessionDir = (sessionLocator != null)
                                ? sessionLocator.resolveDir(sessionId, sessionCwd)
                                : Paths.get(engine.getWorkspace(), engine.getHarnessSessions(), sessionId)
                                    .toAbsolutePath().normalize().toFile();
                        File labelFile = new File(sessionDir, "label.txt");
                        if (labelFile.exists() == false) {
                            // 从用户输入生成 label（空会话场景，如纯命令输入）
                            String label = input.trim();
                            if (label.length() > 50) {
                                label = label.substring(0, 50);
                            }
                            java.nio.file.Files.write(labelFile.toPath(), label.getBytes("UTF-8"));
                        }
                } catch (Throwable e) {
                        LOG.warn("[WebGate] Failed to generate label for session {}: {}", sessionId, e.getMessage());
                    }
                }
            }
        }
        return true;
    }

    /**
     * 执行 Agent 流式任务。
     *
     * <p>通过 {@link WebStreamBuilder} 构建 ReAct Agent 的响应流，
     * 订阅流数据并通过 {@link #emitToClient} 逐条推送至前端。
     * 同时将 RxJava {@link Disposable} 保存到会话属性中，以支持 {@link #interruptSession} 中断。</p>
     *
     * @param session      Agent 会话实例
     * @param sessionCwd   会话当前工作目录
     * @param prompt       用户输入的 Prompt（为 null 时表示 HITL 恢复等无需新 Prompt 的场景）
     * @param selectedModel 用户选择的 AI 模型标识
     * @param agentName    指定 Agent 名称（可为 null，表示使用默认 Agent）
     */
    private void performAgentTaskAsync(AgentSession session, String sessionCwd, Prompt prompt, String selectedModel, String agentName) {
        String sessionId = session.getSessionId();

        if (selectedModel != null) {
            session.getContext().put(HarnessEngine.CTX_MODEL_SELECTED, selectedModel);
        } else {
            selectedModel = session.getContext().getAs(HarnessEngine.CTX_MODEL_SELECTED);
        }

        ChatModel chatModel = engine.getModelOrMain(selectedModel);
        ReActAgent agent = engine.getAgentOrMain(agentName);

        // 自引用持有：供 doOnError/doFinally 做同实例判定（终止回调可能早于/晚于新订阅登记）
        final Disposable[] self = new Disposable[1];
        // done 兜底守卫：流的任何终止路径（complete/error/cancel）都必须让前端收到恰好一个 done。
        // 实测存在 cancel/竞态下 concatWith(done) 不再发射的路径（如新任务取代旧任务 dispose、
        // 并行工具段异常完成方式不完整），前端将永远停留在加载态，故在 doFinally 兜底补发（幂等）。
        final AtomicBoolean doneSent = new AtomicBoolean(false);
        final AtomicBoolean streamFailed = new AtomicBoolean(false);
        // 账本收口的幂等守卫：三条终止路径（done 帧 / error / finally）都会调，只允许生效一次
        final AtomicBoolean changeFinished = new AtomicBoolean(false);
        final java.util.concurrent.atomic.AtomicReference<String> runIdSeen = new java.util.concurrent.atomic.AtomicReference<>();

        final String changeRoot = resolveChangeRoot(sessionId, sessionCwd);
        // 传 changeRoot 而不是 sessionCwd：ActionTask 用 ATTR_CWD（由 buildStreamFlux 根据本参注入）
        // 作为写账本的根，必须与下面 finishFileChanges 用的根完全一致，否则账本写一份、收口另一份。
        Disposable disposable = streamBuilder.buildStreamFlux(session, agent, chatModel, changeRoot, prompt)
                .subscribeOn(Schedulers.boundedElastic())
                .doOnNext(line -> {
                    if (line.getRunId() != null) runIdSeen.compareAndSet(null, line.getRunId());
                    if ("error".equals(line.getType())) streamFailed.set(true);
                    if ("done".equals(line.getType())) {
                        if (line.getRunId() == null) line.setRunId(runIdSeen.get());
                        String completedRunId = line.getRunId();
                        // 旧写法是 `if (!streamFailed.get()) finish(...)`：一旦本轮出现过 error 帧就整个跳过，
                        // 账本永远停在 ready=false，而 ready 正是撤销的第一道门禁 → 撤销按钮永久 BUSY。
                        // 现在异常路径也要收口，只是以 clean=false 标记账本可能不完整。
                        finishFileChanges(sessionId, completedRunId, changeRoot, !streamFailed.get(), changeFinished);
                        doneSent.set(true);
                    }
                    emitToClient(sessionId, line);
                })
                .doOnError(e -> {
                    streamFailed.set(true);
                    LOG.error("Task fail: {}", e.getMessage(), e);
                    removeDisposableIfSame(session, self[0]);

                    // 流异常时 done 帧不会再经过 doOnNext（onErrorResume 只补一个 error 帧），
                    // 必须在这里收口，否则这个 run 的撤销能力永久锁死
                    finishFileChanges(sessionId, runIdSeen.get(), changeRoot, false, changeFinished);

                    emitToClient(sessionId, WebChunk.ofError(e));
                    if (doneSent.compareAndSet(false, true)) {
                        WebChunk done = WebChunk.ofDone();
                        done.setRunId(runIdSeen.get());
                        emitToClient(sessionId, done);
                    }
                })
                .doFinally(s -> {
                    removeDisposableIfSame(session, self[0]);  // 正常完成时清理
                    // 兜底收口：用户 Stop / 新任务取代旧订阅时是 cancel 信号，done 帧根本不会下发，
                    // 上面两个回调都进不来。而“被改乱的工作区需要回滚”恰恰最常发生在这种场景。
                    // 正常完成时 once 已被 doOnNext 消耗，这里是 no-op。
                    finishFileChanges(sessionId, runIdSeen.get(), changeRoot, false, changeFinished);
                    // cancel/异常竞态兜底：done 仍未发出则补发，保证前端等待态必然收敛。
                    // 但 cancel 需甄别来源：被新任务取代（attrs 已登记新订阅，由新任务发 done）或被
                    // interruptSession 接管（attrs 已移除，由其推送 done）时，此处补发会误杀前端
                    // 新一轮任务的等待态（前端 finishStream 不区分轮次），故跳过；其余取消来源
                    // （如流内部操作符自行 cancel）保守补发。
                    if (doneSent.compareAndSet(false, true)) {
                        if (s == SignalType.CANCEL && session.attrs().get("disposable") != self[0]) {
                            LOG.info("[WebGate] stream cancelled by replacement/interrupt for session {}, skip fallback done", sessionId);
                        } else {
                            LOG.warn("[WebGate] done missing on signal {} for session {}, emitting fallback done", s, sessionId);
                            WebChunk done = WebChunk.ofDone();
                            done.setRunId(runIdSeen.get());
                            emitToClient(sessionId, done);
                        }
                    }
                })
                .subscribe();

        self[0] = disposable;

        // 新任务取代旧任务：若旧订阅仍未结束则取消，防止同一会话两个并行循环的 chunk 流交错（与 WsGate 一致）
        Disposable old = (Disposable) session.attrs().put("disposable", disposable);
        if (old != null && old != disposable && !old.isDisposed()) {
            old.dispose();
        }

        // 收敛注册微竞态：若该订阅在登记前就已终止（doFinally 运行时 self 尚未赋值，无法按同实例移除），
        // 此处依据 isDisposed（终止态，探针已验证语义与可见性）补移除；若期间已有新任务登记，同实例判定不会误删。
        if (disposable.isDisposed()) {
            removeDisposableIfSame(session, disposable);
        }
    }

    /**
     * 同步 run 的等待句柄。
     *
     * <p>订阅与 disposable 登记已在调用线程内同步完成（非阻塞），等待必须在
     * 「会话输入锁之外」执行：{@link #startSyncRun} 所属的调用链若在锁内 await，
     * 而流线程又会回调 {@link #registerSteerRun}（同样要抢该会话锁），必然互锁。</p>
     */
    private static final class SyncRunHandle {
        private final CountDownLatch latch;
        private final AtomicReference<String> finalAnswerRef;

        SyncRunHandle(CountDownLatch latch, AtomicReference<String> finalAnswerRef) {
            this.latch = latch;
            this.finalAnswerRef = finalAnswerRef;
        }

        /** 阻塞直到本轮 run 终止，返回捕获到的最终文本。必须在会话输入锁之外调用。 */
        String await() {
            RunUtil.runAndTry(latch::await);
            return finalAnswerRef.get();
        }
    }

    /**
     * 订阅并登记一轮同步 run，立即返回等待句柄（不阻塞）。
     *
     * <p>调用方必须在「会话输入锁之外」执行 {@link SyncRunHandle#await()}：本方法只做订阅与
     * disposable 登记（与异步路径一致），等待期间流线程会回调 {@link #registerSteerRun}、
     * Stop 会调用 {@link #interruptSession}，两者都要抢同一把会话锁，持锁等待必然死锁。</p>
     */
    private SyncRunHandle startSyncRun(AgentSession session, String sessionCwd, Prompt prompt, String selectedModel, String agentName,
                                       boolean transientSelection, String thinkingDepthOverride) {
        String sessionId = session.getSessionId();

        if (selectedModel != null) {
            if (!transientSelection) {
                session.getContext().put(HarnessEngine.CTX_MODEL_SELECTED, selectedModel);
            }
        } else {
            selectedModel = session.getContext().getAs(HarnessEngine.CTX_MODEL_SELECTED);
        }

        ChatModel chatModel = engine.getModelOrMain(selectedModel);
        ReActAgent agent = engine.getAgentOrMain(agentName);
        CountDownLatch countDownLatch = new CountDownLatch(1);
        AtomicReference<String> finalAnswerRef = new AtomicReference<>("");

        final Disposable[] self = new Disposable[1];
        // done 兜底守卫（与异步路径同因）：任何终止信号下保证前端恰好收到一个 done
        final AtomicBoolean doneSent = new AtomicBoolean(false);
        final AtomicBoolean streamFailed = new AtomicBoolean(false);
        // 账本收口的幂等守卫（与异步路径同因）
        final AtomicBoolean changeFinished = new AtomicBoolean(false);

        final java.util.concurrent.atomic.AtomicReference<String> runIdSeen = new java.util.concurrent.atomic.AtomicReference<>();
        final String changeRoot = resolveChangeRoot(sessionId, sessionCwd);
        // 同异步路径：传 changeRoot 以保证「写账本的根 == 收口的根 == 前端读取的根」
        Disposable disposable = streamBuilder.buildStreamFlux(session, agent, chatModel, changeRoot, prompt, thinkingDepthOverride)
                .subscribeOn(Schedulers.boundedElastic())
                .doOnNext(line -> {
                    if (line.getRunId() != null) runIdSeen.compareAndSet(null, line.getRunId());
                    if ("error".equals(line.getType())) streamFailed.set(true);
                    if ("done".equals(line.getType())) {
                        if (line.getRunId() == null) line.setRunId(runIdSeen.get());
                        finishFileChanges(sessionId, line.getRunId(), changeRoot, !streamFailed.get(), changeFinished);
                        doneSent.set(true);
                    }
                    emitToClient(sessionId, line);

                    if ("trace".equals(line.getType())) {
                        finalAnswerRef.set(line.getFinalAnswer());
                    }
                })
                .doOnError(e -> {
                    streamFailed.set(true);
                    LOG.error("Task fail: {}", e.getMessage(), e);
                    removeDisposableIfSame(session, self[0]);

                    finishFileChanges(sessionId, runIdSeen.get(), changeRoot, false, changeFinished);

                    emitToClient(sessionId, WebChunk.ofError(e));
                    if (doneSent.compareAndSet(false, true)) {
                        emitToClient(sessionId, WebChunk.ofDone());
                    }
                })
                .doFinally(s -> {
                    removeDisposableIfSame(session, self[0]);
                    // 兜底收口：cancel（用户 Stop / 新任务取代）时 done 帧不会下发，上面两个回调都进不来
                    finishFileChanges(sessionId, runIdSeen.get(), changeRoot, false, changeFinished);
                    // 与异步路径同策略：cancel 且已被取代/interrupt 接管时跳过补发，防误杀新一轮等待态
                    if (doneSent.compareAndSet(false, true)) {
                        if (s == SignalType.CANCEL && session.attrs().get("disposable") != self[0]) {
                            LOG.info("[WebGate] stream cancelled by replacement/interrupt for session {}, skip fallback done", sessionId);
                        } else {
                            LOG.warn("[WebGate] done missing on signal {} for session {}, emitting fallback done", s, sessionId);
                            emitToClient(sessionId, WebChunk.ofDone());
                        }
                    }
                    countDownLatch.countDown();
                })
                .subscribe();

        self[0] = disposable;

        Disposable old = (Disposable) session.attrs().put("disposable", disposable);
        if (old != null && old != disposable && !old.isDisposed()) {
            old.dispose();
        }

        // 收敛注册微竞态（同异步路径注释）
        if (disposable.isDisposed()) {
            removeDisposableIfSame(session, disposable);
        }
        // 不在本方法内 await：等待交给调用方在会话输入锁之外执行，避免与流线程的
        // registerSteerRun / interruptSession 争用同一把会话锁造成死锁。
        return new SyncRunHandle(countDownLatch, finalAnswerRef);
    }

    /**
     * 尝试将用户输入解析为斜杠命令并执行。
     *
     * <p>解析输入字符串中的命令名和参数，查找已注册的 {@link Command} 并执行。
     * 若命令执行后产生非 Agent 任务结果，会通过 WebSocket 推送命令输出；
     * 若为 rewind 命令，会发送特殊的回退事件通知前端删除历史 DOM。</p>
     *
     * @param session      Agent 会话实例
     * @param sessionCwd   会话当前工作目录
     * @param input        用户输入的完整文本（以 "/" 开头）
     * @param selectedModel 用户选择的 AI 模型标识
     * @param agentName    指定 Agent 名称
     * @return true 表示输入已被识别为命令并执行，false 表示非命令输入
     * @throws Exception 命令执行过程中可能抛出的异常
     */
    private boolean isCommand(AgentSession session, String sessionCwd, String input, String selectedModel, String agentName) throws Exception {
        if (!input.startsWith("/")) {
            return false;
        }

        // 解析命令名和参数
        List<String> parts = CmdUtil.parseArguments(input.trim().substring(1));
        String cmdName = parts.get(0).toLowerCase();
        List<String> args = parts.size() > 1
                ? parts.subList(1, parts.size())
                : Collections.emptyList();

        // 查找命令
        Command command = engine.getCommandRegistry().find(cmdName);
        if (command == null) {
            return false;
        }

        // 构建 context（注入 agentTaskRunner 回调）
        WebCommandContext ctx = new WebCommandContext(session, engine, input, cmdName, args,
                (prompt, model) -> {
                    try {
                        if (model == null) {
                            model = selectedModel;
                        }

                        performAgentTaskAsync(session, sessionCwd, Prompt.of(prompt), model, agentName);
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                });

        // 执行命令
        command.execute(ctx);


        if (ctx.isAgentTask() == false) {
            // rewind 命令走特殊通道：发送 rewind 事件让前端同步删除 DOM
            if ("rewind".equals(cmdName)) {
                int rewindCount = 1;
                if (!args.isEmpty()) {
                    try {
                        rewindCount = Integer.parseInt(args.get(0));
                    } catch (NumberFormatException ignored) {
                    }
                }

                //加一条删掉自己发出的一条
                emitToClient(session.getSessionId(), WebChunk.ofRewind(rewindCount + 1));
            } else {
                final String text;
                if (ctx.getOutputBuffer().length() > 0) {
                    text = ctx.getOutputBuffer().toString();
                } else {
                    text = "命令执行完成";
                }

                if (streamBuilder.getWeChatLink() != null) {
                    // 命令执行后也通知给微信：仅当本轮由 IM/Loop 触发时（source 非空），
                    // 网页手动执行命令(source=null)不回推，与 AI 回复的回推规则一致
                    Object src = session.attrs().get("_input_source");
                    if (src != null && streamBuilder.getWeChatLink().isBound(session.getSessionId())) {
                        streamBuilder.getWeChatLink().sendReply(session.getSessionId(), text, true);
                    }
                }

                emitToClient(session.getSessionId(), WebChunk.ofCommand(text));
            }

            emitToClient(session.getSessionId(), WebChunk.ofDone());
        }

        return true;
    }


    /**
     * 判断指定会话是否有 AI 任务正在执行。
     *
     * <p>通过检查会话属性中保存的 {@link Disposable} 对象是否仍处于活跃状态来判断。</p>
     *
     * @param session Agent 会话实例
     * @return true 表示会话有正在执行的 AI 任务
     */
    private boolean isSessionBusy(AgentSession session) {
        Disposable disposable = (Disposable) session.attrs().get("disposable");
        // 已终止的流其 Disposable 处于 disposed 状态，视为非繁忙（防止残留引用误判）
        return disposable != null && !disposable.isDisposed();
    }

    /**
     * 仅当会话属性中的 disposable 仍为 expected 实例时移除，
     * 避免旧任务的 doOnError/doFinally 收尾时误删新任务的 disposable。
     */
    private void removeDisposableIfSame(AgentSession session, Disposable expected) {
        if (expected == null) {
            return;
        }
        session.attrs().compute("disposable", (k, v) -> v == expected ? null : v);
    }

    /**
     * 判断指定会话是否有 AI 任务正在执行（按 sessionId 查询）。
     *
     * <p>供 LoopScheduler 等外部组件在定时触发前判断会话是否繁忙，繁忙则跳过本次执行。
     * 会话不存在或查询异常时按非繁忙处理。</p>
     *
     * @param sessionId 会话标识
     * @return true 表示会话有正在执行的 AI 任务
     */
    public boolean isSessionBusy(String sessionId) {
        try {
            return isSessionBusy(engine.getSession(sessionId));
        } catch (Exception e) {
            LOG.warn("[WebGate] busy check failed for session {}: {}", sessionId, e.getMessage());
            return false;
        }
    }

    /**
     * 当前活跃 run 的 runId（无运行中 run 时返回 null）。
     *
     * <p>由 {@code /web/chat/replay} 一并回传，作为前端“本轮到底在跑哪个 run”的权威真值。
     * 前端 {@code activeRunId} 可能被历史回放写成陈旧值，导致中断请求因 runId 不匹配被后端
     * 判为 {@code turn_changed}；前端据此校准后重试中断才能命中真正的当前 run。</p>
     *
     * @param sessionId 会话标识
     * @return 活跃 run 的 runId；无运行中 run 或查询异常时返回 null
     */
    public String getCurrentRunId(String sessionId) {
        try {
            AgentSession session = engine.getSession(sessionId);
            Object runId = session.attrs().get(SteerInterceptor.ATTR_ACTIVE_RUN_ID);
            return runId == null ? null : String.valueOf(runId);
        } catch (Exception e) {
            LOG.warn("[WebGate] current runId lookup failed for session {}: {}", sessionId, e.getMessage());
            return null;
        }
    }

    /**
     * 安全聊天输入入口（chat 会话或不关心项目根时使用）。
     *
     * @param sessionId 会话标识
     * @param input     用户输入文本
     * @param source    调用来源标识（用于日志记录，如 "WeChat"）
     */
    public void safeChatInput(String sessionId, String input, String source) {
        safeChatInput(sessionId, null, input, source);
    }

    /**
     * 安全聊天输入入口。
     *
     * <p>在调用 {@link #onChatInput} 之前先检查会话是否繁忙（有 AI 任务正在执行），
     * 若繁忙则跳过本次输入并记录警告日志。用于 IM 通道回调等需要避免并发冲突的场景。</p>
     *
     * <p>{@code projectRoot} 非空时（chat / code 通用），先登记会话所属工作空间根，
     * 再作为 {@code sessionCwd} 透传，保证落盘目录与 AI 工具工作根都指向正确工作空间。</p>
     *
     * @param sessionId   会话标识
     * @param projectRoot 所属工作空间根绝对路径（未选择时传 null）
     * @param input       用户输入文本
     * @param source      调用来源标识（用于日志记录，如 "WeChat"）
     */
    public void safeChatInput(String sessionId, String projectRoot, String input, String source) {
        synchronized (inputLocks.computeIfAbsent(sessionId, k -> new Object())) {
            doSafeChatInput(sessionId, projectRoot, input, source);
        }
    }

    private void doSafeChatInput(String sessionId, String projectRoot, String input, String source) {
        // 活动会话的所属根不可被一个最终会 busy-skip 的异步输入改写。
        try {
            AgentSession session = engine.getSession(sessionId);
            if (isSessionBusy(session)) {
                LOG.warn("[WebGate] {} event skipped for session {}: task in progress", source, sessionId);
                return;
            }
        } catch (Exception e) {
            LOG.warn("[WebGate] {} event check failed for session {}: {}", source, sessionId, e.getMessage());
            return;
        }
        if (sessionLocator != null && Assert.isNotEmpty(projectRoot)) {
            sessionLocator.bindSessionRoot(sessionId, projectRoot);
        }

        // onChatInput 在同一会话受理锁内再次确认 busy，并在真正受理后推送用户气泡。
        onChatInput(sessionId, projectRoot, input, null, null, null, null, source);
    }


    /**
     * Loop 专用：安全聊天输入入口，无限等待捕获本轮响应文本。
     *
     * <p>
     * 适用于可能长时间执行的 Loop goal 任务。
     * 该方法仍会向前端推送完整流式消息，同时等待响应流结束。
     *
     * @param sessionId  会话标识
     * @param input      用户输入文本
     * @param source     调用来源标识
     * @return 捕获到的 AI 文本；会话繁忙或无文本时返回 null
     */
    public String safeChatInputAndCaptureLoop(String sessionId, String input, String source) {
        return safeChatInputAndCaptureLoop(sessionId, null, input, source);
    }

    /**
     * Loop 专用：带所属工作空间根的安全聊天输入入口。
     *
     * @param projectRoot 会话所属工作空间根绝对路径（可为 null，回退默认工作区）
     */
    public String safeChatInputAndCaptureLoop(String sessionId, String projectRoot, String input, String source) {
        return safeChatInputAndCaptureLoop(sessionId, projectRoot, null, input, source, null, null);
    }

    /**
     * Loop 专用：带完整执行上下文（工作空间 / 模型 / 思考档位）的安全聊天输入入口。
     *
     * <p>模型与思考档位按「任务定义」生效且<b>不写入会话上下文</b>：定时任务可能复用
     * 用户绑定的前台会话，若写入上下文会静默改掉用户在界面上的模型/思考选择。</p>
     *
     * @param projectRoot   会话所属工作空间根绝对路径（可为 null，回退默认工作区）
     * @param worktreeRoot  本轮 worktree 绝对路径（可为 null）。非空时作为本轮 AI 工作目录，
     *                      但<b>不写入会话注册表</b>：它在本轮执行结束后即被删除，
     *                      若持久化会留下指向不存在目录的所属根。
     * @param modelName     任务指定的模型名（可为 null，回退会话/默认模型）
     * @param thinkingDepth 任务指定的思考档位（可为 null，回退会话选择）
     */
    public String safeChatInputAndCaptureLoop(String sessionId, String projectRoot, String worktreeRoot, String input, String source,
                                              String modelName, String thinkingDepth) {
        LoopRunPlan plan;
        SyncRunHandle handle;
        // 会话输入锁只在「受理准备 + 订阅登记」这一短临界区内持有。
        // 绝不能在锁内等待本轮 run 终止：本方法会阻塞到流结束，而流线程上的
        // onAgentStart→registerSteerRun 与 Stop 的 interruptSession 都要抢同一把会话锁，
        // 持锁等待会造成永久死锁（现象：点暂停无反应、一直显示“思考中”且计时器不停）。
        synchronized (inputLocks.computeIfAbsent(sessionId, k -> new Object())) {
            plan = doSafeChatInputAndCaptureLoopPrepare(sessionId, projectRoot, worktreeRoot, input, source);
            if (plan == null) return null;
            if (plan.earlyResult != null) return plan.earlyResult;
            handle = startSyncRun(plan.session, plan.cwd, Prompt.of(plan.input), modelName, plan.agentName, true, thinkingDepth);
        }
        // 锁外等待：此时锁已释放，流线程可正常完成 run 注册与插话，Stop 也可即时受理。
        return handle.await();
    }

    /** Loop 受理准备结果：earlyResult 非空表示可直接返回（如目标已达成），否则按 session/cwd/input/agentName 发起本轮 run。 */
    private static final class LoopRunPlan {
        String earlyResult;
        AgentSession session;
        String cwd;
        String input;
        String agentName;
    }

    /**
     * 在会话输入锁内执行的 Loop 受理准备：busy 检查、所属根绑定、目标达成短路、用户气泡推送。
     *
     * <p>准备阶段不阻塞，故可安全地在锁内执行；真正的流式执行（会阻塞至本轮结束）由调用方在锁外发起。</p>
     */
    private LoopRunPlan doSafeChatInputAndCaptureLoopPrepare(String sessionId, String projectRoot, String worktreeRoot,
                                                             String input, String source) {
        try {
            AgentSession existing = engine.getSession(sessionId);
            if (isSessionBusy(existing)) {
                LOG.warn("[WebGate] {} event skipped for session {}: task in progress", source, sessionId);
                return null;
            }
            if (source != null) existing.attrs().put("_input_source", source);
            else existing.attrs().remove("_input_source");
        } catch (Throwable e) {
            LOG.warn("[WebGate] {} event check failed for session {}: {}", source, sessionId, e.getMessage());
            return null;
        }
        // 只有确认空闲后才允许更新持久化根/本轮固定流根。
        if (sessionLocator != null && Assert.isNotEmpty(projectRoot)) {
            sessionLocator.bindSessionRoot(sessionId, projectRoot);
        }
        if (Assert.isNotEmpty(projectRoot)) streamRoots.put(sessionId, projectRoot);
        else streamRoots.remove(sessionId);
        AgentSession session;
        try {
            session = engine.getSession(sessionId);
            if (isSessionBusy(session)) {
                LOG.warn("[WebGate] {} event skipped for session {}: task in progress", source, sessionId);
                return null;
            }
        } catch (Throwable e) {
            LOG.warn("[WebGate] {} event check failed for session {}: {}", source, sessionId, e.getMessage());
            return null;
        }

        List<ChatMessage> messageList = session.getMessages();
        if (Assert.isNotEmpty(messageList)) {
            //如果最新的消息里有 GOAL_ACHIEVED，说明任务完成了
            ChatMessage message = messageList.get(messageList.size() - 1);
            if (message instanceof AssistantMessage) {
                if (message.getContent().contains(LoopExecutionResult.GOAL_ACHIEVED)) {
                    LoopRunPlan finished = new LoopRunPlan();
                    finished.earlyResult = message.getContent();
                    return finished;
                }
            }
        }

        emitToClient(sessionId, WebChunk.ofUserInput(input, source, projectRoot));

        String agentName = null;
        String currentInput = input;
        if (currentInput != null && currentInput.startsWith("@")) {
            int agentNameIdx = currentInput.indexOf(" ");
            if (agentNameIdx > 0) {
                agentName = currentInput.substring(1, agentNameIdx);
                if (engine.getAgentManager().hasAgent(agentName)) {
                    currentInput = currentInput.substring(agentNameIdx + 1);
                }
            }
        }

        LoopRunPlan plan = new LoopRunPlan();
        plan.session = session;
        // 工作目录：worktree 优先（隔离执行），否则用任务工作空间根
        plan.cwd = Assert.isNotEmpty(worktreeRoot) ? worktreeRoot : projectRoot;
        plan.input = currentInput;
        plan.agentName = agentName;
        return plan;
    }


    // ═══════════════════════════════════════════════════════════════
    //  工具方法 —— 附件类型判断与 MIME 映射
    // ═══════════════════════════════════════════════════════════════

    /** 支持的图片扩展名集合 */
    private static final Set<String> IMAGE_EXTENSIONS = org.noear.solon.Utils.asSet(".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg");

    /**
     * 判断附件是否为图片类型。
     *
     * @param ext             文件扩展名（含点号，如 ".png"）
     * @param attachmentsType 前端传递的附件类型标识（如 "image"）
     * @return true 表示该附件应作为图片处理
     */
    private static boolean isImageAttachment(String ext, String attachmentsType) {
        return "image".equals(attachmentsType) && IMAGE_EXTENSIONS.contains(ext);
    }

    /**
     * 将文件扩展名映射为 MIME 类型。
     *
     * @param ext 文件扩展名（含点号，如 ".jpg"）
     * @return 对应的 MIME 类型字符串，未匹配时默认返回 "image/png"
     */
    private static String extensionToMime(String ext) {
        switch (ext) {
            case ".jpg":
            case ".jpeg":
                return "image/jpeg";
            case ".png":
                return "image/png";
            case ".gif":
                return "image/gif";
            case ".webp":
                return "image/webp";
            case ".bmp":
                return "image/bmp";
            case ".svg":
                return "image/svg+xml";
            default:
                return "image/png";
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  会话中断支持
    // ═══════════════════════════════════════════════════════════════

    /**
     * 中断指定会话的当前 AI 任务。
     *
     * <p>从会话属性中取出并销毁 RxJava {@link Disposable} 以终止流式订阅，
     * 同时向会话历史追加一条取消记录，并向前端推送完成信号。</p>
     *
     * @param sessionId 待中断的会话标识
     */
    public String interruptSession(String sessionId, String expectedRunId) {
        synchronized (inputLocks.computeIfAbsent(sessionId, k -> new Object())) {
            try {
                AgentSession session = engine.getSession(sessionId);
                SteerRunState state = (SteerRunState) session.attrs().get(SteerInterceptor.ATTR_RUN_STATE);
                if (state == null) {
                    // 兜底：run 状态已摘除但底层订阅仍活着（如 onAgentStart 之前的窗口、或异常路径漏删），
                    // 只要还有活跃 disposable 就必须真停并补发 done，否则前端会永久停在思考态。
                    // 用带同实例判定的 remove(key, value) 原子摘取：即便存在未持锁登记 disposable 的路径，
                    // 也绝不会误摘后一个 run 的订阅。dispose 与补 done 仍在锁内完成，与“摘取 + 登记”同锁互斥，
                    // 从而不会出现「已摘旧订阅但新 run 已登记」的窗口去误杀新一轮等待态。
                    Disposable orphan = (Disposable) session.attrs().get("disposable");
                    if (orphan != null && !orphan.isDisposed() && session.attrs().remove("disposable", orphan)) {
                        orphan.dispose();
                        session.addMessage(ChatMessage.ofAssistant("用户已取消任务."));
                        emitToClient(sessionId, WebChunk.ofDone());
                        LOG.info("[WebGate] Session {} interrupted via disposable fallback (no run state)", sessionId);
                        return "cancelled";
                    }
                    return "not_running";
                }
                if (state.lifecycle != SteerRunState.Lifecycle.RUNNING) {
                    return "not_running";
                }
                if (expectedRunId != null && !expectedRunId.isEmpty() && !expectedRunId.equals(state.runId)) {
                    return "turn_changed";
                }

                state.lifecycle = SteerRunState.Lifecycle.CANCELLED;
                java.util.List<SteerEnvelope> cancelled = state.drain();
                session.attrs().remove(SteerInterceptor.ATTR_RUN_STATE, state);
                session.attrs().remove(SteerInterceptor.ATTR_ACTIVE_RUN_ID, state.runId);
                Disposable disposable = (Disposable) session.attrs().remove("disposable");
                if (disposable != null) disposable.dispose();

                if (!cancelled.isEmpty()) {
                    emitToClient(sessionId, WebChunk.ofSteerCancelled(state.runId, cancelled));
                }
                session.addMessage(ChatMessage.ofAssistant("用户已取消任务."));
                WebChunk done = WebChunk.ofDone();
                done.setRunId(state.runId);
                emitToClient(sessionId, done);
                LOG.info("[WebGate] Session {} run {} interrupted", sessionId, state.runId);
                return "cancelled";
            } catch (Exception e) {
                LOG.error("[WebGate] Interrupt failed for session {}: {}", sessionId, e.getMessage(), e);
                return "not_running";
            }
        }
    }

    /** 兼容非 Web 调用方；仅取消当前活跃 run。 */
    public void interruptSession(String sessionId) {
        interruptSession(sessionId, null);
    }

    /**
     * 受理一条即时插话请求。
     *
     * <p>必须在 {@link #inputLocks} 下调用，保证 busy 检查与 offer 原子。</p>
     *
     * @param sessionId 会话 ID
     * @param expectedRunId 前端期望的当前 runId（防迟到插话进入下一 run）
     * @param steerId 客户端幂等 ID
     * @param text 插话文本（已校验非空且长度不超限）
     * @return 语义结果："accepted" / "not_running" / "turn_changed" / "box_full" / "duplicate"
     */
    public String steer(String sessionId, String expectedRunId, String steerId, String text) {
        synchronized (inputLocks.computeIfAbsent(sessionId, k -> new Object())) {
            try {
                AgentSession session = engine.getSession(sessionId);
                SteerRunState state = (SteerRunState) session.attrs().get(SteerInterceptor.ATTR_RUN_STATE);
                if (state == null || state.lifecycle != SteerRunState.Lifecycle.RUNNING) {
                    return "not_running";
                }
                String activeRunId = state.runId;
                if (expectedRunId != null && !expectedRunId.isEmpty()
                        && !expectedRunId.equals(activeRunId)) {
                    return "turn_changed";
                }
                if (state.pending.containsKey(steerId)) return "duplicate";
                if (state.pending.size() >= SteerInterceptor.MAX_BOX_SIZE) return "box_full";
                state.pending.put(steerId, new SteerEnvelope(steerId, text, activeRunId, System.currentTimeMillis()));
                return "accepted";
            } catch (Exception e) {
                LOG.error("[WebGate] steer failed for session {}: {}", sessionId, e.getMessage());
                return "not_running";
            }
        }
    }

    /** 注册新 run；旧 run 残留被明确 cancelled，且旧回调之后无法清理新 run。 */
    void registerSteerRun(AgentSession session, String runId) {
        java.util.List<SteerEnvelope> cancelled = java.util.Collections.emptyList();
        String oldRunId = null;
        synchronized (inputLocks.computeIfAbsent(session.getSessionId(), k -> new Object())) {
            SteerRunState old = (SteerRunState) session.attrs().get(SteerInterceptor.ATTR_RUN_STATE);
            if (old != null && !old.runId.equals(runId)) {
                old.lifecycle = SteerRunState.Lifecycle.CANCELLED;
                oldRunId = old.runId;
                cancelled = old.drain();
            }
            SteerRunState state = new SteerRunState(runId);
            session.attrs().put(SteerInterceptor.ATTR_RUN_STATE, state);
            session.attrs().put(SteerInterceptor.ATTR_ACTIVE_RUN_ID, runId);
        }
        if (!cancelled.isEmpty()) emitToClient(session.getSessionId(), WebChunk.ofSteerCancelled(oldRunId, cancelled));
    }

    /** 在与 Stop/结束相同的 session 锁内完成摘取、注入和 applied 发布。 */
    void applySteers(AgentSession session, String runId,
                     java.util.function.Consumer<java.util.List<SteerEnvelope>> injector) {
        synchronized (inputLocks.computeIfAbsent(session.getSessionId(), k -> new Object())) {
            SteerRunState state = (SteerRunState) session.attrs().get(SteerInterceptor.ATTR_RUN_STATE);
            if (state == null || !state.runId.equals(runId)
                    || state.lifecycle != SteerRunState.Lifecycle.RUNNING || state.pending.isEmpty()) return;
            java.util.List<SteerEnvelope> items = state.drain();
            injector.accept(items);
            emitToClient(session.getSessionId(), WebChunk.ofSteerApplied(runId, items));
        }
    }

    /** 正常结束当前 owner run；旧 run 的迟到回调不会触碰新 run。 */
    void finishSteerRun(AgentSession session, String runId) {
        java.util.List<SteerEnvelope> dropped;
        synchronized (inputLocks.computeIfAbsent(session.getSessionId(), k -> new Object())) {
            SteerRunState state = (SteerRunState) session.attrs().get(SteerInterceptor.ATTR_RUN_STATE);
            if (state == null || !state.runId.equals(runId)
                    || state.lifecycle != SteerRunState.Lifecycle.RUNNING) return;
            state.lifecycle = SteerRunState.Lifecycle.ENDED;
            dropped = state.drain();
            session.attrs().remove(SteerInterceptor.ATTR_RUN_STATE, state);
            session.attrs().remove(SteerInterceptor.ATTR_ACTIVE_RUN_ID, runId);
        }
        if (!dropped.isEmpty()) {
            persistDroppedSteers(session.getSessionId(), dropped);
            emitToClient(session.getSessionId(), WebChunk.ofSteerDropped(runId, dropped));
        }
    }

    /**
     * 把未生效的插话原子、幂等地降级为持久化队列消息。
     */
    void persistDroppedSteers(String sessionId, java.util.List<SteerEnvelope> items) {
        if (items == null || items.isEmpty()) return;
        try {
            java.io.File sessionDir;
            String root = streamRoots.get(sessionId);
            if (sessionLocator != null) {
                sessionDir = sessionLocator.resolveDir(sessionId, root);
            } else {
                sessionDir = java.nio.file.Paths.get(engine.getWorkspace(), engine.getHarnessSessions(), sessionId)
                        .toAbsolutePath().normalize().toFile();
            }
            QueueFileHelper helper = new QueueFileHelper();
            for (SteerEnvelope item : items) {
                helper.add(sessionDir, item.getText(), java.util.Collections.emptyList(),
                        java.util.Collections.emptyList(), item.getSteerId());
            }
        } catch (Throwable e) {
            LOG.error("[WebGate] persist dropped steer failed for session {}: {}", sessionId, e.getMessage(), e);
        }
    }
}