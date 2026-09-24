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
import com.gourdai.agent.session.FileAgentSession;
import com.gourdai.agent.react.ReActAgent;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.intercept.HITL;
import com.gourdai.agent.react.intercept.HITLTask;
import com.gourdai.agent.react.intercept.AskUser;
import com.gourdai.agent.react.intercept.AskUserTask;
import com.gourdai.ai.chat.ChatModel;
import com.gourdai.ai.chat.content.Contents;
import com.gourdai.ai.chat.content.ImageBlock;
import com.gourdai.ai.chat.content.TextBlock;
import com.gourdai.ai.chat.message.AssistantMessage;
import com.gourdai.ai.chat.message.ChatMessage;
import com.gourdai.ai.chat.message.UserMessage;
import com.gourdai.ai.chat.prompt.Prompt;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.permission.AccessMode;
import com.gourdai.harness.change.FileChangeService;
import com.gourdai.harness.command.Command;
import com.gourdai.ai.util.CmdUtil;
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
     * 受理时统一「绑定归属 + 对齐家目录」。
     *
     * <p><b>背景：</b>会话对象在构造时即固化了存储目录，而首次受理输入（登记所属根）发生在其后；
     * 若以构造时的解析为准，messages/snapshot（引擎侧）会落全局区、stream/label/TODO（Web 侧）
     * 落项目区——同一会话的数据被拆到两个目录（分居），且重启续写还会产生双段消息。</p>
     *
     * <p><b>绑定</b>由 {@link SessionLocator#bindSessionRoot} 统一裁决：归属冻结（一旦登记不再改写）、
     * 数据位置采纳（不让已落盘会话换根）。<b>对齐</b>：对尚未落盘任何数据的会话，
     * 把存储目录切换到本次生效的家目录（{@code boundRoot ?: 全局区}），保证此后
     * messages/snapshot/stream/label/TODO/uploads 全部落在同一个目录。</p>
     *
     * @return 会话家根；null 表示全局区（未登记项目根）
     */
    private String bindAndAlignHome(AgentSession session, String sessionId, String sessionCwd) {
        if (sessionLocator == null) {
            return sessionCwd;
        }
        if (Assert.isNotEmpty(sessionCwd)) {
            sessionLocator.bindSessionRoot(sessionId, sessionCwd);
        }
        String home = sessionLocator.boundRoot(sessionId);
        alignSessionHome(sessionLocator, session);
        return home;
    }

    /**
     * 可测试 seam：把未落盘会话的存储目录对齐到其家目录（{@code boundRoot ?: 全局区}）。
     * 已产生数据的会话不会被迁移（由 {@link FileAgentSession#relocateIfPristine} 保证）。
     */
    static void alignSessionHome(SessionLocator locator, AgentSession session) {
        if (locator == null || !(session instanceof FileAgentSession)) {
            return;
        }
        String sessionId = session.getSessionId();
        try {
            File homeDir = locator.resolveDir(sessionId);
            ((FileAgentSession) session).relocateIfPristine(homeDir);
        } catch (Throwable e) {
            LOG.warn("[WebGate] align session home failed for {}: {}", sessionId, e.getMessage());
        }
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
            // 写盘是旁路职责：失败（磁盘满/文件被占用等）只记日志，不得阻断在线推送，
            // 更不得把异常抛回同步执行此方法的模型流线程（SSE 网络线程会把整条流意外炸断）
            if (streamStore != null) {
                try {
                    streamStore.record(sessionId, streamRoots.get(sessionId), jsonChunk);
                } catch (Throwable e) {
                    LOG.warn("[WebGate] Failed to record stream chunk for session {}: {}",
                            sessionId, e.toString());
                }
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
    /**
     * 输入受理结果。
     *
     * <p>旧版本只用 boolean 表达「受理/繁忙」两态，actionId 校验失败属于第三种语义：
     * 请求本身合法、会话也不忙，但提交指向的不是当前挂起的那一次调用（旧页面/旧卡的迟到提交）。
     * 这种请求必须【拒绝】而不能静默应用到别的任务上：HITL 误批准不可逆。</p>
     */
    public enum InputResult {
        /** 已受理执行。 */
        ACCEPTED,
        /** 会话繁忙（有任务在执行），调用方应返回 busy。 */
        BUSY,
        /** actionId 与当前挂起任务不匹配，已拒绝（调用方应返回明确错误）。 */
        ACTION_MISMATCH
    }

    public boolean onChatInput(String sessionId,
                               String sessionCwd,
                               String input, String selectedModel,
                               UploadedFile[] attachments, String[] attachmentTypes,
                               String hitlAction, String source) {
        return onChatInput(sessionId, sessionCwd, input, selectedModel, attachments, attachmentTypes,
                hitlAction, source, null, null);
    }

    public boolean onChatInput(String sessionId,
                               String sessionCwd,
                               String input, String selectedModel,
                               UploadedFile[] attachments, String[] attachmentTypes,
                               String hitlAction, String source, String clientMessageId) {
        return onChatInput(sessionId, sessionCwd, input, selectedModel, attachments, attachmentTypes,
                hitlAction, source, clientMessageId, null);
    }

    /**
     * 受理聊天输入（含结构化问答答案）。
     *
     * @param hitlAction     HITL 操作类型（可为 null）
     * @param questionAnswer 结构化问答（ask_user）答案 JSON；非空时提交答案并恢复被挂起的任务（可为 null）
     */
    public boolean onChatInput(String sessionId,
                               String sessionCwd,
                               String input, String selectedModel,
                               UploadedFile[] attachments, String[] attachmentTypes,
                               String hitlAction, String source, String clientMessageId, String questionAnswer) {
        return onChatInput(sessionId, sessionCwd, input, selectedModel, attachments, attachmentTypes,
                hitlAction, source, clientMessageId, questionAnswer, null) == InputResult.ACCEPTED;
    }

    /**
     * 受理聊天输入（含挂起任务身份校验）。
     *
     * <p><b>actionId 语义</b>：标识客户端「正在回应哪一次调用」。后端原本只按 sessionId 取
     * 当前待处理任务，旧页面/旧卡的迟到提交会被静默应用到【另一次调用】上——
     * 问答场景表现为「答错题」，HITL 场景则可能误批准 {@code rm -rf} 这类不可逆操作。</p>
     *
     * <p><b>向后兼容策略</b>：传了就严格校，没传则警告日志 + 按旧逻辑放行。前后端同包发布，
     * 正常升级后不会出现旧前端；但【旧快照恢复的挂起任务】本身就可能没有 actionId
     * （该字段新增前落盘，见 HITLTask/AskUserTask 注释），若一律严校会让这些任务永远恢复不了。
     * 故只在【两边都有 id】时才比对。</p>
     *
     * @param actionId 客户端声明正在回应的调用标识（可为 null；为 null 时降级为旧行为）
     * @return 受理结果，见 {@link InputResult}
     */
    public InputResult onChatInput(String sessionId,
                                   String sessionCwd,
                                   String input, String selectedModel,
                                   UploadedFile[] attachments, String[] attachmentTypes,
                                   String hitlAction, String source, String clientMessageId,
                                   String questionAnswer, String actionId) {
        return onChatInput(sessionId, sessionCwd, input, selectedModel, attachments, attachmentTypes,
                hitlAction, source, clientMessageId, questionAnswer, actionId, null);
    }

    /**
     * 受理聊天输入（含访问控制档位声明）。
     *
     * <p>accessMode 的语义与 selectedModel 一致：非空则以本轮声明为准（写入会话上下文权威存储位），
     * 为空则回退会话已存档位。Web 前端每次输入可携带最新档位；Loop/IM 等不携带的调用方
     * 走 null 分支，两者最终收敛到同一存储位（{@link AccessMode#CTX_KEY}）。</p>
     *
     * @param accessMode 本轮输入声明的访问控制档位（default / full；可为 null，回退会话已存档位）
     * @return 受理结果，见 {@link InputResult}
     */
    public InputResult onChatInput(String sessionId,
                                   String sessionCwd,
                                   String input, String selectedModel,
                                   UploadedFile[] attachments, String[] attachmentTypes,
                                   String hitlAction, String source, String clientMessageId,
                                   String questionAnswer, String actionId, String accessMode) {
        return onChatInput(sessionId, sessionCwd, input, selectedModel, attachments, attachmentTypes,
                hitlAction, source, clientMessageId, questionAnswer, actionId, accessMode, null, null);
    }

    /**
     * 受理聊天输入（含已落盘附件引用）。
     *
     * <p>队列出队与插话降级重发这两条通道，手里只有会话内的相对路径而没有 File 对象——
     * 附件早在「决定排队/插话」的那一刻就已落盘到 {@code <sessionDir>/uploads/}。
     * 这里按路径把附件读回来，与 multipart 上传的附件汇入同一批 {@code imageBlocks} /
     * {@code fileAttachments}，后续构建 Prompt 的逻辑完全共用，不存在第二套附件语义。</p>
     *
     * @param attachmentPaths     会话内相对路径清单（{@code uploads/xxx}），可为 null
     * @param attachmentPathTypes 与路径一一对应的类型声明（{@code image} / {@code file}），可为 null
     * @return 受理结果，见 {@link InputResult}
     */
    public InputResult onChatInput(String sessionId,
                                   String sessionCwd,
                                   String input, String selectedModel,
                                   UploadedFile[] attachments, String[] attachmentTypes,
                                   String hitlAction, String source, String clientMessageId,
                                   String questionAnswer, String actionId, String accessMode,
                                   List<String> attachmentPaths, List<String> attachmentPathTypes) {
        synchronized (inputLocks.computeIfAbsent(sessionId, k -> new Object())) {
            return doOnChatInput(sessionId, sessionCwd, input, selectedModel, attachments, attachmentTypes,
                    hitlAction, source, clientMessageId, questionAnswer, actionId, accessMode,
                    attachmentPaths, attachmentPathTypes);
        }
    }

    private InputResult doOnChatInput(String sessionId,
                                      String sessionCwd,
                                      String input, String selectedModel,
                                      UploadedFile[] attachments, String[] attachmentTypes,
                                      String hitlAction, String source, String clientMessageId,
                                      String questionAnswer, String actionId, String accessMode,
                                      List<String> attachmentPaths, List<String> attachmentPathTypes) {
        AgentSession session = null;
        String streamRoot = null;
        try {
            session = engine.getSession(sessionId);

            // busy 请求不能覆盖正在运行任务的来源；来源只在确认本次输入可受理后更新。
            // hitlAction / questionAnswer 属于“恢复已挂起任务”的输入，不按 busy 拒绝。
            if (Assert.isEmpty(hitlAction) && Assert.isEmpty(questionAnswer) && isSessionBusy(session)) {
                LOG.warn("[WebGate] chat input skipped for session {}: task in progress", sessionId);
                return InputResult.BUSY;
            }

            // 通过受理锁内的 busy 检查后才允许登记所属根，确保首次解析及后续旁路落盘一致；
            // busy 请求不会改绑活动会话。绑定后立即对齐家目录（仅未落盘会话可迁移），
            // 使引擎侧 messages/snapshot 与 Web 侧 stream/label/TODO 落同一目录；
            // 对齐放在会话属性写入之前，避免（极少数采纳已有数据场景）缓存层重挂载时丢失属性。
            streamRoot = bindAndAlignHome(session, sessionId, sessionCwd);

            // busy 请求不能覆盖正在运行任务的来源；来源只在确认本次输入可受理后更新。
            if (source != null) {
                session.attrs().put("_input_source", source);
            } else {
                session.attrs().remove("_input_source");
            }

            // 本会话流事件固定写入会话家目录（已登记根为权威；未登记=全局区）。
            // 后续即使另一个 busy 请求误带不同 cwd，emitToClient 也不会跳到其它目录。
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
                // 【严格校验】工具审批误批准不可逆（rm -rf 之类），故比问答更严：
                // 客户端带了 actionId 时，必须真的存在挂起任务、且标识完全一致才放行；
                // 任务不存在或标识不同一律拒绝，绝不“次好地”把决策应用到另一个待审批调用上。
                if (Assert.isNotEmpty(actionId)) {
                    if (task == null) {
                        LOG.warn("[WebGate] hitl decision rejected for session {}: no pending task (actionId={})",
                                sessionId, actionId);
                        return InputResult.ACTION_MISMATCH;
                    }
                    if (!actionId.equals(task.getActionId())) {
                        LOG.warn("[WebGate] hitl decision rejected for session {}: actionId mismatch (got {}, pending {})",
                                sessionId, actionId, task.getActionId());
                        return InputResult.ACTION_MISMATCH;
                    }
                } else if (task != null) {
                    // 旧前端（或旧卡片）不传标识：降级按旧逻辑执行，但必须留痕——
                    // 这正是“可能批错任务”的唐突窗口，出事时要能从日志回溯。
                    LOG.warn("[WebGate] hitl decision without actionId for session {} (pending {}); applying legacy behavior",
                            sessionId, task.getActionId());
                }
                if (task != null) {
                    if ("approve".equals(hitlAction)) {
                        HITL.approve(session, task.getToolName());
                    } else {
                        HITL.reject(session, task.getToolName());
                    }
                }
                // Resume streaming after HITL decision
                performAgentTaskAsync(session, sessionCwd, null, selectedModel, agentName, accessMode);
                return InputResult.ACCEPTED;
            }

            // ask_user 结构化问答恢复处理：用户提交答案后回填并恢复被挂起的任务
            if (Assert.isNotEmpty(questionAnswer)) {
                AskUserTask task = AskUser.getPendingTask(session);

                /* 【可恢复性闸门】挂起任务实体还在，不等于它真的还能被恢复。用户在提问帧到达前
                   抢先发了一条普通消息时，新一轮任务会重置挂起态并把路由推到 END 正常结束，
                   留下「任务实体还在、会话却已不挂起」的僵尸组合。此时若仍走恢复，那一轮会因
                   路由停在 END 而空转（0 token/十几毫秒），拦截器一次都不执行、现场永不清理，
                   于是「重发提问帧 → 用户作答 → 空转 → 再重发」无限自激，表现为问答卡不停闪烁且
                   永不自愈（只能换会话）。这里将其降级为一次普通发言：清掉僵尸现场、回确认帧收卡，
                   再把用户的答案当作一条普通消息发起新一轮——用户的回答不白答，模型照样能看到。 */
                if (task != null && !session.isPending()) {
                    LOG.warn("[WebGate] stale ask_user pending task for session {} (actionId={}): "
                            + "session is not suspended, degrading to a normal turn", sessionId, task.getActionId());
                    return recoverFromStaleQuestion(session, sessionId, sessionCwd, selectedModel, agentName,
                            questionAnswer, task, accessMode);
                }
                // 【校验】问答的后果可逆（答错题而已），且「无挂起任务时仍须回确认帧」是卡片不死的前提，
                // 故不像 HITL 那样把 task==null 也当失败；仅在【两边都有 id 且不同】时拒绝，
                // 避免把 B 题的答案写到正在挂起的 A 题上。
                if (Assert.isNotEmpty(actionId) && task != null
                        && Assert.isNotEmpty(task.getActionId()) && !actionId.equals(task.getActionId())) {
                    LOG.warn("[WebGate] question answer rejected for session {}: actionId mismatch (got {}, pending {})",
                            sessionId, actionId, task.getActionId());
                    return InputResult.ACTION_MISMATCH;
                }
                if (Assert.isEmpty(actionId) && task != null && Assert.isNotEmpty(task.getActionId())) {
                    LOG.warn("[WebGate] question answer without actionId for session {} (pending {}); applying legacy behavior",
                            sessionId, task.getActionId());
                }
                if (task != null) {
                    AskUser.submit(session, questionAnswer);
                }

                // 无论是否找到挂起任务都要回帧：前端在点“提交”的瞬间就把卡片置成了已提交态，
                // 这里不回帧（重复提交、快照缺失、多端并发等）那张卡会永久停在已提交态且不消失。
                // 确认帧携带 actionId（优先取服务端任务的真值），前端据此只收【那一道题】的卡，
                // 否则历史回放与多端并发下会误清用户正在作答的另一张卡。
                String answeredActionId = (task != null && Assert.isNotEmpty(task.getActionId()))
                        ? task.getActionId()
                        : actionId;
                emitToClient(sessionId, WebChunk.ofQuestionAnswered(AskUser.toolNameOf(task),
                        AskUser.parseAnswers(questionAnswer), answeredActionId));

                if (task == null) {
                    // 没有可恢复的挂起任务：再拉起一次 run 只会空转，或与正在进行的恢复并发双跑。
                    // 直接补一个 done 收口，让前端停掉等待指示器。
                    emitToClient(sessionId, WebChunk.ofDone());
                    return InputResult.ACCEPTED;
                }

                // Resume streaming after user answers
                performAgentTaskAsync(session, sessionCwd, null, selectedModel, agentName, accessMode);
                return InputResult.ACCEPTED;
            }

            // Handle file upload - save to session directory
            List<ImageBlock> imageBlocks = new ArrayList<>();
            List<String> fileAttachments = new ArrayList<>();

            // 附件根目录只解析一次：multipart 上传与「按路径引用已落盘附件」两条通道必须指向同一目录，
            // 否则队列/插话延后发送时会读不到早先上传的那份文件。
            File attachSessionDir = (sessionLocator != null)
                    ? sessionLocator.resolveDir(sessionId, streamRoot)
                    : new File(engine.getWorkspace());

            if (attachments != null) {
                // 解析会话目录，作为附件存储根路径
                java.nio.file.Path sessionDir = attachSessionDir.toPath();

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

            // 已落盘附件（队列出队 / 插话降级重发）：只有会话内相对路径，读回后与上传附件汇入同一批，
            // 之后的 Prompt 构建、命令分发、空输入兜底全部共用，不存在第二套附件语义。
            if (attachmentPaths != null && !attachmentPaths.isEmpty()) {
                resolveAttachmentRefs(attachSessionDir, attachmentPaths, attachmentPathTypes,
                        imageBlocks, fileAttachments);
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
                    if (isCommand(session, sessionCwd, currentInput, selectedModel, agentName, accessMode)) {
                        return InputResult.ACCEPTED;
                    }
                }

                /* 【放弃作答 = 收卡】走到这里说明用户选择了发一条普通消息，而不是回答那张问答卡。
                   此刻必须就地清掉挂起的提问，否则它会变成僵尸：会话挂起态要等到新一轮任务开跑时
                   才被重置（ReActTrace#prepare，发生在本方法之后），而【没有任何一处会清理挂起任务
                   实体】——于是留下「实体还在、会话已不挂起」的组合，被 WebStreamBuilder 在轮末当成
                   待答提问重新下发，凭空冒出一张题面早已过时的卡；用户点它则触发「空转 → 重发」的
                   自激循环，表现为问答卡不停闪烁且永不自愈。

                   注意：这里不能加 !session.isPending() 之类的守卫。挂起态此刻通常仍为 true
                   （重置在本方法之后），加了等于让清理在最主要的场景里恒不执行。

                   位置讲究：放在命令分发之后，因为命令（/xxx）不发起新一轮，那张卡仍可正常作答，
                   不该被收掉；放在附件与空输入判定之内，确保确实要发言才收卡，空输入不白丢卡片。
                   带 actionId 下发确认帧：前端据此只收那一道题的卡；不下发则卡片永远停在待答态。 */
                AskUserTask abandonedTask = AskUser.discardPending(session);
                if (abandonedTask != null) {
                    LOG.warn("[WebGate] discarded pending ask_user task for session {} (actionId={}): "
                            + "user sent a normal message instead of answering", sessionId, abandonedTask.getActionId());
                    emitToClient(sessionId, WebChunk.ofQuestionAnswered(AskUser.toolNameOf(abandonedTask),
                            Collections.emptyList(), abandonedTask.getActionId()));
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
                        performAgentTaskAsync(session, sessionCwd, Prompt.of(), selectedModel, agentName, accessMode);
                        return InputResult.ACCEPTED;
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
                performAgentTaskAsync(session, sessionCwd, prompt, selectedModel, agentName, accessMode);
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
                        // 会话数据统一落家目录（streamRoot 即家根；busy 早退等未赋值场景传 null 走登记表/全局兜底）
                        File sessionDir = (sessionLocator != null)
                                ? sessionLocator.resolveDir(sessionId, streamRoot)
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
        return InputResult.ACCEPTED;
    }

    /**
     * 僵尸提问的降级恢复：把一次「已不可恢复的作答」转为一次普通发言。
     *
     * <p>三步：① 清掉僵尸现场（挂起任务 + 答案 + 归属标识），断开自激循环的根；
     * ② 回确认帧让前端收卡（不回帧那张卡会永远停在已提交态）；
     * ③ 把用户的答案文本当作一条普通消息发起新一轮——回答不白答，模型能看到它。</p>
     *
     * <p>用户若只是跳过/关卡（无实质内容），则只清现场并补 done 收口，不再发起模型调用：
     * 既尊重放弃作答的意图，也不白烧 token。</p>
     *
     * @param staleTask 已失效的挂起任务（非 null）
     * @param accessMode 本轮声明的访问控制档位（可为 null，回退会话已存档位）
     * @return 始终为 {@code ACCEPTED}：本次提交已被受理，只是语义从「恢复」降为「新一轮」
     */
    private InputResult recoverFromStaleQuestion(AgentSession session, String sessionId, String sessionCwd,
                                                 String selectedModel, String agentName,
                                                 String questionAnswer, AskUserTask staleTask, String accessMode) {
        List<Map<String, Object>> questions = staleTask.getQuestions();
        AskUser.discardPending(session);

        emitToClient(sessionId, WebChunk.ofQuestionAnswered(AskUser.toolNameOf(staleTask),
                AskUser.parseAnswers(questionAnswer), staleTask.getActionId()));

        if (!AskUser.hasMeaningfulAnswer(questionAnswer)) {
            // 用户只是想把卡关掉：收口即可，不必为空答案再跑一轮模型
            session.updateSnapshot();
            emitToClient(sessionId, WebChunk.ofDone());
            return InputResult.ACCEPTED;
        }

        // 用户确实作了答：连同题面一并渲染成文本，模型才知道这是在回答哪一道问题
        String answerText = AskUser.formatAnswerText(questions, questionAnswer);
        session.updateSnapshot();
        performAgentTaskAsync(session, sessionCwd, Prompt.of(answerText), selectedModel, agentName, accessMode);
        return InputResult.ACCEPTED;
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
     * @param accessMode   本轮声明的访问控制档位（可为 null，回退会话已存档位）
     */
    private void performAgentTaskAsync(AgentSession session, String sessionCwd, Prompt prompt, String selectedModel, String agentName, String accessMode) {
        String sessionId = session.getSessionId();

        if (selectedModel != null) {
            session.getContext().put(HarnessEngine.CTX_MODEL_SELECTED, selectedModel);
        } else {
            selectedModel = session.getContext().getAs(HarnessEngine.CTX_MODEL_SELECTED);
        }

        // 档位双通道（与上面 model 同逻辑）：传入非空则以本轮声明为准，写入权威存储位
        // （会话上下文，随快照持久化）；为空则从会话上下文回读。
        // 写入前统一 normalize：脏值 / 历史快照缺字段一律回落默认档（fail-safe）。
        // 必须落库而非仅本地持有：WebStreamBuilder 会从会话上下文读取后经 toolContext 透传给工具链。
        //
        // 【口径钉死】这里<b>不校验</b> accessMode 合法性：非法值会被 normalize 回落默认档，
        // 与「新会话/未声明者一律默认档」同语义，无需报错；显式拒绝只发生在
        // /web/chat/access/select（用户主动切换档位却拼错时必须可感知，见 WebController#access_select）。
        if (accessMode != null) {
            session.getContext().put(AccessMode.CTX_KEY, AccessMode.normalize(accessMode).code());
        } else {
            accessMode = session.getContext().getAs(AccessMode.CTX_KEY);
        }

        // 模型回退告警：指定了模型却未命中（被删除/改名/禁用）时，底层会静默换成
        // defaultModel 继续跑——不报错、不记日志，用户只会看到「我选的是 A，怎么跑的是 B」。
        // 这里不改变回退行为（保障可用性），只把它从静默变成可观测。
        if (engine.isModelFallback(selectedModel)) {
            LOG.warn("[WebGate] model '{}' not found or disabled for session {}, falling back to default model '{}'",
                    selectedModel, sessionId, engine.getDefaultModel());
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
                        // 【C1-c】挂起态 done：等待作答/审批时引擎流也会正常结束并补发 done，但本轮并未真正完成。
                        // 打上标记后前端只停等待指示器、不拆批次与工具卡索引，否则恢复后同一批会被拆成两组渲染。
                        if (session.isPending() && line.getSuspended() == null) {
                            line.setSuspended(true);
                        }
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
                                       boolean transientSelection, String thinkingDepthOverride, Long contextLengthOverride) {
        String sessionId = session.getSessionId();

        if (selectedModel != null) {
            if (!transientSelection) {
                session.getContext().put(HarnessEngine.CTX_MODEL_SELECTED, selectedModel);
            }
        } else {
            selectedModel = session.getContext().getAs(HarnessEngine.CTX_MODEL_SELECTED);
        }

        // 模型回退告警（同 performAgentTaskAsync，Loop 同步链路）：指定了模型却未命中时
        // 底层会静默回退到 defaultModel，此处把它变成可观测。
        if (engine.isModelFallback(selectedModel)) {
            LOG.warn("[WebGate] model '{}' not found or disabled for session {}, falling back to default model '{}'",
                    selectedModel, sessionId, engine.getDefaultModel());
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
        Disposable disposable = streamBuilder.buildStreamFlux(session, agent, chatModel, changeRoot, prompt, thinkingDepthOverride, contextLengthOverride)
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
     * @param accessMode   本轮声明的访问控制档位（透传给命令触发的 Agent 任务，可为 null）
     * @return true 表示输入已被识别为命令并执行，false 表示非命令输入
     * @throws Exception 命令执行过程中可能抛出的异常
     */
    private boolean isCommand(AgentSession session, String sessionCwd, String input, String selectedModel, String agentName, String accessMode) throws Exception {
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

                        performAgentTaskAsync(session, sessionCwd, Prompt.of(prompt), model, agentName, accessMode);
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
        AgentSession session;
        try {
            session = engine.getSession(sessionId);
            if (isSessionBusy(session)) {
                LOG.warn("[WebGate] {} event skipped for session {}: task in progress", source, sessionId);
                return;
            }
        } catch (Exception e) {
            LOG.warn("[WebGate] {} event check failed for session {}: {}", source, sessionId, e.getMessage());
            return;
        }
        // 确认空闲后登记归属并对齐家目录（仅未落盘会话可迁移）。
        bindAndAlignHome(session, sessionId, projectRoot);

        // onChatInput 在同一会话受理锁内再次确认 busy，并在真正受理后推送用户气泡。
        onChatInput(sessionId, projectRoot, input, null, null, null, null, source);
    }


    /**
     * Loop 专用：带完整执行上下文（工作空间 / 模型 / 思考档位 / 上下文窗口）的安全聊天输入入口。
     *
     * <p>模型与思考档位按「任务定义」生效且<b>不写入会话上下文</b>：定时任务可能复用
     * 用户绑定的前台会话，若写入上下文会静默改掉用户在界面上的模型/思考选择。
     * 上下文窗口同理按任务定义生效，但以「本轮」transient 键写入会话（压缩预算与用量指示器
     * 同源读取），本轮结束即清理，同样不触碰用户的持久选择。</p>
     *
     * @param projectRoot   会话所属工作空间根绝对路径（可为 null，回退默认工作区）
     * @param worktreeRoot  本轮 worktree 绝对路径（可为 null）。非空时作为本轮 AI 工作目录，
     *                      但<b>不写入会话注册表</b>：它在本轮执行结束后即被删除，
     *                      若持久化会留下指向不存在目录的所属根。
     * @param modelName     任务指定的模型名（可为 null，回退会话/默认模型）
     * @param thinkingDepth 任务指定的思考档位（可为 null，回退会话选择）
     * @param contextLengthOverride 任务指定的上下文窗口（可为 null，回退会话持久选择）
     */
    public String safeChatInputAndCaptureLoop(String sessionId, String projectRoot, String worktreeRoot, String input, String source,
                                              String modelName, String thinkingDepth, Long contextLengthOverride) {
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
            handle = startSyncRun(plan.session, plan.cwd, Prompt.of(plan.input), modelName, plan.agentName, true, thinkingDepth, contextLengthOverride);
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
        AgentSession existing;
        try {
            existing = engine.getSession(sessionId);
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
        // 只有确认空闲后才允许更新持久化根/本轮固定流根；绑定后对齐家目录（仅未落盘会话可迁移）。
        String streamRoot = bindAndAlignHome(existing, sessionId, projectRoot);
        if (Assert.isNotEmpty(streamRoot)) streamRoots.put(sessionId, streamRoot);
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

    /** 附件在会话目录内的存放子目录名，也是相对路径的唯一合法前缀。 */
    static final String UPLOADS_DIR = "uploads";

    /** 支持的图片扩展名集合 */
    private static final Set<String> IMAGE_EXTENSIONS = org.noear.solon.Utils.asSet(".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg");

    /**
     * 校验并规范化「会话内附件相对路径」。
     *
     * <p>只接受 {@code uploads/<简单文件名>} 这一种形态：文件名里出现任何目录分隔符或 {@code ..}
     * 都直接判非法，因此不存在穿出会话目录的可能，也无需再做 startsWith 兜底比对。
     * 队列（queue.json）与插话（steer）两条延后通道都要拿用户可控的字符串去读盘，统一走这里。</p>
     *
     * @param path 待校验的相对路径
     * @return 合法时原样返回，非法时返回 null
     */
    static String sanitizeAttachmentPath(String path) {
        if (path == null) return null;
        String p = path.trim();
        String prefix = UPLOADS_DIR + "/";
        if (!p.startsWith(prefix)) return null;
        String name = p.substring(prefix.length());
        if (name.isEmpty() || name.contains("/") || name.contains("\\") || name.contains("..")) return null;
        return p;
    }

    /**
     * 把上传的附件落盘到会话 uploads 目录，返回可供队列与插话引用的相对路径清单。
     *
     * <p>与发送主链路（{@link #doOnChatInput}）共用同一目录、同一命名与安全校验，
     * 因此「先落盘再延后发送」与「立即发送」最终读到的是同一个文件。落盘本身不发起模型调用，
     * 任务执行中也能安全调用。</p>
     *
     * @return 与入参顺序一致的清单，元素含 path / type / name / size；非法文件名的条目直接跳过
     */
    List<Map<String, Object>> saveAttachments(String sessionId, String sessionCwd,
                                              UploadedFile[] files, String[] types) throws java.io.IOException {
        List<Map<String, Object>> saved = new ArrayList<>();
        if (files == null || files.length == 0) return saved;

        java.nio.file.Path uploadsDir = resolveSessionDir(sessionId, sessionCwd).toPath().resolve(UPLOADS_DIR);
        try {
            java.nio.file.Files.createDirectories(uploadsDir);
        } catch (java.io.IOException e) {
            LOG.warn("[WebGate] failed to create uploads directory: {}", uploadsDir, e);
            uploadsDir = uploadsDir.getParent();
        }

        java.nio.file.Path uploadsRoot = uploadsDir.toAbsolutePath().normalize();
        for (int i = 0; i < files.length; i++) {
            UploadedFile file = files[i];
            if (file == null) continue;
            String fileName = file.getName();
            if (fileName == null || fileName.contains("..") || fileName.contains("/") || fileName.contains("\\")) {
                LOG.warn("[WebGate] rejected unsafe attachment name for session {}: {}", sessionId, fileName);
                continue;
            }
            String type = (types != null && i < types.length) ? types[i] : null;
            String ext = "." + file.getExtension();
            java.nio.file.Path savePath = uploadsRoot.resolve(fileName);
            if (!savePath.startsWith(uploadsRoot)) {
                LOG.warn("[WebGate] attachment escaped uploads dir for session {}: {}", sessionId, fileName);
                continue;
            }
            java.nio.file.Files.copy(file.getContent(), savePath, java.nio.file.StandardCopyOption.REPLACE_EXISTING);

            boolean image = isImageAttachment(ext, type);
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("path", UPLOADS_DIR + "/" + fileName);
            item.put("type", image ? "image" : "file");
            item.put("name", fileName);
            item.put("size", java.nio.file.Files.size(savePath));
            saved.add(item);
        }
        return saved;
    }

    /**
     * 解析「已落盘附件」引用：按声明类型分流为图片块与路径引用。
     *
     * <p>供三条延后通道复用（队列出队、插话注入、按路径重发）：它们手里只有相对路径，
     * 拿不到浏览器内存中的 File 对象。类型必须由调用方声明而不能按扩展名猜——
     * 前端允许把一张 png 当普通文件引用发送（{@code attachmentsType='file'}），
     * 按扩展名判定会把这种附件错误升级成多模态图片。</p>
     *
     * <p>读盘失败或文件已被清理时只跳过该附件并留痕，不整条失败：文本部分对用户仍然有效。</p>
     *
     * @param sessionDir  会话目录
     * @param paths       相对路径清单（{@code uploads/xxx}）
     * @param types       与 paths 一一对应的类型声明（{@code image} / {@code file}），可为 null（全按文件处理）
     * @param imageBlocks 输出参数：图片块按序追加
     * @param fileRefs    输出参数：按路径引用的附件相对路径按序追加
     */
    static void resolveAttachmentRefs(File sessionDir, List<String> paths, List<String> types,
                                      List<ImageBlock> imageBlocks, List<String> fileRefs) {
        if (paths == null || paths.isEmpty() || sessionDir == null) return;
        java.nio.file.Path uploadsRoot = sessionDir.toPath().resolve(UPLOADS_DIR).toAbsolutePath().normalize();

        for (int i = 0; i < paths.size(); i++) {
            String path = sanitizeAttachmentPath(paths.get(i));
            if (path == null) {
                LOG.warn("[WebGate] skipped malformed attachment path: {}", paths.get(i));
                continue;
            }
            java.nio.file.Path file = uploadsRoot.resolve(path.substring(UPLOADS_DIR.length() + 1));
            if (!file.startsWith(uploadsRoot) || !java.nio.file.Files.exists(file)) {
                LOG.warn("[WebGate] attachment missing under uploads dir, skipped: {}", path);
                continue;
            }
            String declared = (types != null && i < types.size()) ? types.get(i) : null;
            String name = file.getFileName().toString();
            String ext = name.contains(".") ? name.substring(name.lastIndexOf('.')).toLowerCase() : "";

            if (!isImageAttachment(ext, declared)) {
                fileRefs.add(path);
                continue;
            }
            try {
                byte[] bytes = java.nio.file.Files.readAllBytes(file);
                imageBlocks.add(ImageBlock.ofBase64(Base64.getEncoder().encodeToString(bytes), extensionToMime(ext)));
            } catch (java.io.IOException e) {
                LOG.warn("[WebGate] failed to read attachment {}, skipped: {}", path, e.getMessage());
            }
        }
    }

    /**
     * 判断附件是否为图片类型。
     *
     * <p>包内可见：独立上传端点与插话注入要与发送主链路用同一口径判定，
     * 否则同一张图在「立即发送」与「排队后发送」两条路径上会被分别当成图片和文件。</p>
     *
     * @param ext             文件扩展名（含点号，如 ".png"）
     * @param attachmentsType 前端传递的附件类型标识（如 "image"）
     * @return true 表示该附件应作为图片处理
     */
    static boolean isImageAttachment(String ext, String attachmentsType) {
        return "image".equals(attachmentsType) && IMAGE_EXTENSIONS.contains(ext);
    }

    /**
     * 将文件扩展名映射为 MIME 类型。
     *
     * @param ext 文件扩展名（含点号，如 ".jpg"）
     * @return 对应的 MIME 类型字符串，未匹配时默认返回 "image/png"
     */
    static String extensionToMime(String ext) {
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
                        // 同主路径：为用户主动停止打「可续跑」标记并落盘
                        engine.markUserInterruptedForResume(session, null);
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

                // 用户主动停止：为未完成的任务打「可续跑」标记并立即落盘（口径与异常中断对齐）。
                // 取消不经过库的异常兜底（abnormal 不置位），不打标则后续「继续」会被当成
                // 全新任务、断点工作记忆被整体重置（重复消耗 token）。
                engine.markUserInterruptedForResume(session, null);

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
     * 受理一条即时插话请求（纯文本）。
     *
     * @see #steer(String, String, String, String, java.util.List, java.util.List)
     */
    public String steer(String sessionId, String expectedRunId, String steerId, String text) {
        return steer(sessionId, expectedRunId, steerId, text, null, null);
    }

    /**
     * 受理一条即时插话请求（可带已落盘附件）。
     *
     * <p>必须在 {@link #inputLocks} 下调用，保证 busy 检查与 offer 原子。</p>
     *
     * <p>附件在这里只存【相对路径】而不读字节：插话邮箱最多滞留 {@code MAX_BOX_SIZE} 条，
     * 缓存 base64 图片会有内存风险；真正读盘发生在 {@link SteerInterceptor} 注入工作记忆的那一刻，
     * 读不到的附件由那里跳过并留痕。</p>
     *
     * @param sessionId 会话 ID
     * @param expectedRunId 前端期望的当前 runId（防迟到插话进入下一 run）
     * @param steerId 客户端幂等 ID
     * @param text 插话文本（可为空，此时必须带附件）
     * @param imagePaths 作为多模态图片注入的附件路径（{@code uploads/xxx}），可为 null
     * @param filePaths  作为路径引用的附件路径，可为 null
     * @return 语义结果："accepted" / "not_running" / "turn_changed" / "box_full" / "duplicate" / "empty"
     */
    public String steer(String sessionId, String expectedRunId, String steerId, String text,
                        java.util.List<String> imagePaths, java.util.List<String> filePaths) {
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

                java.util.List<String> images = sanitizePaths(sessionId, imagePaths);
                java.util.List<String> files = sanitizePaths(sessionId, filePaths);
                boolean hasText = text != null && !text.trim().isEmpty();
                if (!hasText && images.isEmpty() && files.isEmpty()) return "empty";

                state.pending.put(steerId, new SteerEnvelope(steerId, hasText ? text : "",
                        activeRunId, System.currentTimeMillis(), images, files));
                return "accepted";
            } catch (Exception e) {
                LOG.error("[WebGate] steer failed for session {}: {}", sessionId, e.getMessage(), e);
                return "not_running";
            }
        }
    }

    /**
     * 过滤并规范化插话携带的附件路径。
     *
     * <p>非法路径（非 {@code uploads/<简单文件名>} 形态）直接丢弃并留痕，不整条拒绝插话——
     * 文本部分对用户仍然有效，为一条坏路径吞掉整句插话得不偿失。</p>
     */
    private static java.util.List<String> sanitizePaths(String sessionId, java.util.List<String> paths) {
        if (paths == null || paths.isEmpty()) return java.util.Collections.emptyList();
        java.util.List<String> ok = new ArrayList<>(paths.size());
        for (String raw : paths) {
            String path = sanitizeAttachmentPath(raw);
            if (path == null) {
                LOG.warn("[WebGate] steer attachment path rejected for session {}: {}", sessionId, raw);
                continue;
            }
            ok.add(path);
        }
        return ok;
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
     * 解析会话存储目录（Web 侧旁路落盘的权威口径）。
     *
     * <p>优先用本轮已登记的流根 {@link #streamRoots}（run 进行中它就是附件与 queue.json 的落点），
     * 其次用调用方透传的工作空间根，最后交给 {@link SessionLocator} 的持久化登记表兜底。</p>
     */
    File resolveSessionDir(String sessionId, String sessionCwd) {
        String root = streamRoots.get(sessionId);
        if (Assert.isEmpty(root)) root = sessionCwd;
        if (sessionLocator != null) {
            return sessionLocator.resolveDir(sessionId, root);
        }
        return java.nio.file.Paths.get(engine.getWorkspace(), engine.getHarnessSessions(), sessionId)
                .toAbsolutePath().normalize().toFile();
    }

    /**
     * 把未生效的插话原子、幂等地降级为持久化队列消息。
     */
    void persistDroppedSteers(String sessionId, java.util.List<SteerEnvelope> items) {
        if (items == null || items.isEmpty()) return;
        try {
            java.io.File sessionDir = resolveSessionDir(sessionId, null);
            QueueFileHelper helper = new QueueFileHelper();
            for (SteerEnvelope item : items) {
                // 附件路径随插话一起降级：插话没赶上任务结束时，队列消费仍能带上原附件，
                // 否则用户上传的图片会在「插话 → 转队列」这一跳里静默消失。
                helper.add(sessionDir, item.getText(), item.getImagePaths(),
                        item.getFilePaths(), item.getSteerId());
            }
        } catch (Throwable e) {
            LOG.error("[WebGate] persist dropped steer failed for session {}: {}", sessionId, e.getMessage(), e);
        }
    }
}