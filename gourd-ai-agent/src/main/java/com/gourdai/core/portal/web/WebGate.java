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


    /**
     * 构造网关实例。
     *
     * @param engine     AI 引擎，提供会话、模型、Agent、命令等核心服务
     */
    public WebGate(HarnessEngine engine) {
        this.engine = engine;
        this.streamBuilder = new WebStreamBuilder(engine);
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
        } else {
            jsonChunk.setSessionId(sessionId);
        }

        // 旁路持久化：把本块记入 <sessionId>.stream.ndjson，供历史加载时回放。
            // projectRoot 传 null——会话所属根已由 bindSessionRoot 登记在 locator 注册表，
        // 由 resolveDir 自行解析；不影响正常出站推送。
        if (streamStore != null) {
            streamStore.record(sessionId, null, jsonChunk);
        }

        // 确保消息中包含 sessionId
        String enriched = ONode.serialize(jsonChunk);

        if (LOG.isDebugEnabled()) {
            LOG.debug("emit: " + enriched);
        }

        // 广播给所有连接（每条消息都带 sessionId，前端自行路由）
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
        AgentSession session = null;
        try {
            session = engine.getSession(sessionId);
            // 记录本轮输入来源：出站回推 IM 时据此判断——网页手动输入(source=null)不回推 IM，
            // 避免把网页发起的任务误推到恰好为活跃指针的 IM 通道。每轮覆盖，防止残留上一轮来源。
            // 注意：attrs() 底层为 ConcurrentHashMap，不允许 null 值；source 为空时改为移除旧键（语义等价：读取仍为 null）。
            if (source != null) {
                session.attrs().put("_input_source", source);
            } else {
                session.attrs().remove("_input_source");
            }

            // 并发防护：同一会话已有任务在执行时，跳过重复触发（如客户端超时重试/双发），
            // 避免两个并行 ReAct 循环的 chunk 流交错推送到同一会话，导致前端思考块与正文错位。
            // 与 safeChatInput 的 busy-skip 语义一致；HITL 审批/拒绝不受限（其前置流已结束）。
            if (Assert.isEmpty(hitlAction) && isSessionBusy(session)) {
                LOG.warn("[WebGate] chat input skipped for session {}: task in progress", sessionId);
                return false;
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

        Disposable disposable = streamBuilder.buildStreamFlux(session, agent, chatModel, sessionCwd, prompt)
                .subscribeOn(Schedulers.boundedElastic())
                .doOnNext(line -> {
                    if ("done".equals(line.getType())) {
                        doneSent.set(true);
                    }
                    emitToClient(sessionId, line);
                })
                .doOnError(e -> {
                    LOG.error("Task fail: {}", e.getMessage(), e);
                    removeDisposableIfSame(session, self[0]);

                    emitToClient(sessionId, WebChunk.ofError(e));
                    if (doneSent.compareAndSet(false, true)) {
                        emitToClient(sessionId, WebChunk.ofDone());
                    }
                })
                .doFinally(s -> {
                    removeDisposableIfSame(session, self[0]);  // 正常完成时清理
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
                            emitToClient(sessionId, WebChunk.ofDone());
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
    private String performAgentTaskSync(AgentSession session, String sessionCwd, Prompt prompt, String selectedModel, String agentName) {
        return performAgentTaskSync(session, sessionCwd, prompt, selectedModel, agentName, false, null);
    }

    /**
     * 执行 Agent 流式任务（同步等待，可指定不持久化选择）。
     *
     * @param transientSelection    true 时本轮指定的模型不写入会话上下文（仅本轮生效）。
     *                              用于 Loop 定时任务：选择属于任务定义，不应污染运行时会话的用户选择。
     * @param thinkingDepthOverride 本轮思考深度档位（null 时回退会话选择），同样不写入会话上下文。
     */
    private String performAgentTaskSync(AgentSession session, String sessionCwd, Prompt prompt, String selectedModel, String agentName,
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

        Disposable disposable = streamBuilder.buildStreamFlux(session, agent, chatModel, sessionCwd, prompt, thinkingDepthOverride)
                .subscribeOn(Schedulers.boundedElastic())
                .doOnNext(line -> {
                    if ("done".equals(line.getType())) {
                        doneSent.set(true);
                    }
                    emitToClient(sessionId, line);

                    if ("trace".equals(line.getType())) {
                        finalAnswerRef.set(line.getFinalAnswer());
                    }
                })
                .doOnError(e -> {
                    LOG.error("Task fail: {}", e.getMessage(), e);
                    removeDisposableIfSame(session, self[0]);

                    emitToClient(sessionId, WebChunk.ofError(e));
                    if (doneSent.compareAndSet(false, true)) {
                        emitToClient(sessionId, WebChunk.ofDone());
                    }
                })
                .doFinally(s -> {
                    removeDisposableIfSame(session, self[0]);
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
        RunUtil.runAndTry(countDownLatch::await);
        return finalAnswerRef.get();
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
        // 在解析会话（getSession 会触发 AgentSessionProvider）之前先登记所属工作空间根
        if (sessionLocator != null && Assert.isNotEmpty(projectRoot)) {
            sessionLocator.bindSessionRoot(sessionId, projectRoot);
        }

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

        // 向 Web 端推送用户消息（来自 IM 通道的消息在 Web 页面上也需要显示）
        emitToClient(sessionId, WebChunk.ofUser(input, source));

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
        // 仅持久化任务的工作空间根，worktree 为本轮瞬态目录，绝不入注册表
        if (sessionLocator != null && Assert.isNotEmpty(projectRoot)) {
            sessionLocator.bindSessionRoot(sessionId, projectRoot);
        }
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
        if(Assert.isNotEmpty(messageList)) {
            //如果最新的消息里有 GOAL_ACHIEVED，说明任务完成了
            ChatMessage message = messageList.get(messageList.size() - 1);
            if (message instanceof AssistantMessage) {
                if (message.getContent().contains(LoopExecutionResult.GOAL_ACHIEVED)) {
                    return message.getContent();
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

        // 工作目录：worktree 优先（隔离执行），否则用任务工作空间根
        String effectiveCwd = Assert.isNotEmpty(worktreeRoot) ? worktreeRoot : projectRoot;

        // 任务级选择仅本轮生效（transientSelection=true），不污染会话上下文
        return performAgentTaskSync(session, effectiveCwd, Prompt.of(currentInput), modelName, agentName,
                true, thinkingDepth);
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
    public void interruptSession(String sessionId) {
        try {
            AgentSession session = engine.getSession(sessionId);
            Disposable disposable = (Disposable) session.attrs().remove("disposable");
            if (disposable != null) {
                disposable.dispose();
            }
            session.addMessage(ChatMessage.ofAssistant("用户已取消任务."));
            emitToClient(sessionId, WebChunk.ofDone());
            LOG.info("[WebGate] Session {} interrupted", sessionId);
        } catch (Exception e) {
            LOG.error("[WebGate] Interrupt failed for session {}: {}", sessionId, e.getMessage());
        }
    }
}