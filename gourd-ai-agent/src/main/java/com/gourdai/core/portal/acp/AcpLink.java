package com.gourdai.core.portal.acp;

import com.agentclientprotocol.sdk.agent.AcpAgent;
import com.agentclientprotocol.sdk.agent.AcpAsyncAgent;
import com.agentclientprotocol.sdk.agent.PromptContext;
import com.agentclientprotocol.sdk.spec.AcpAgentTransport;
import com.agentclientprotocol.sdk.spec.AcpSchema;
import com.gourdai.agent.AgentSession;
import com.gourdai.agent.event.RunEndEvent;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.event.ToolCallStartEvent;
import com.gourdai.agent.event.ToolCallEndEvent;
import com.gourdai.agent.event.PlanEvent;
import com.gourdai.agent.event.ReasonDeltaEvent;
import com.gourdai.agent.event.ReasonEndEvent;
import com.gourdai.harness.agent.AgentEndEvent;
import com.gourdai.harness.agent.AgentStartEvent;
import com.gourdai.harness.agent.RetryEvent;
import com.gourdai.core.portal.web.ThinkingDepth;
import com.gourdai.core.portal.web.SessionLocator;
import org.noear.solon.ai.chat.ChatModel;
import org.noear.solon.ai.chat.content.Contents;
import org.noear.solon.ai.chat.content.ImageBlock;
import org.noear.solon.ai.chat.content.TextBlock;
import org.noear.solon.ai.chat.message.ChatMessage;
import org.noear.solon.ai.chat.prompt.Prompt;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.agent.TaskTalent;
import com.gourdai.core.config.AgentSettings;
import com.gourdai.core.config.entity.ModelDo;
import org.noear.solon.core.util.Assert;
import reactor.core.publisher.Mono;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

public class AcpLink implements Runnable {
    private final HarnessEngine agentRuntime;
    private final AcpAgentTransport agentTransport;
    private final AgentSettings agentSettings;

    public AcpLink(HarnessEngine agentRuntime, AcpAgentTransport agentTransport, AgentSettings agentSettings) {
        this.agentRuntime = agentRuntime;
        this.agentTransport = agentTransport;
        this.agentSettings = agentSettings;
    }

    private final Map<String, AcpSessionContext> sessionStates = new ConcurrentHashMap<>();

    /** ToolCallStartEvent.actionId -> ACP toolCallId：保证工具「开始/结束」两张卡同 id，编辑器可原位更新 */
    private final Map<String, String> actionToolCallIds = new ConcurrentHashMap<>();

    /** 子代理标识(agentName:description) -> ACP toolCallId：保证子代理「启动/结束」同 id 更新 */
    private final Map<String, String> agentToolCallIds = new ConcurrentHashMap<>();

    public void run() {
        AcpAsyncAgent acpAgent = createAgent(agentTransport);
        Mono<Void> startMono = acpAgent.start();

        // 阻塞等待 ACP 启动完成，启动失败则退出进程
        try {
            startMono.block();
        } catch (Throwable e) {
            System.err.println("ACP agent start failed: " + e.getMessage());
            e.printStackTrace(System.err);
            System.exit(1);
        }

        // ACP 采用 Stdio JSON-RPC 长连接，进程必须持续存活以维持通信
        // StdioAcpAgentTransport 内部有自己的 I/O 线程处理 stdin/stdout
        // 这里用 CountDownLatch 阻塞主线程，保持 JVM 存活
        java.util.concurrent.CountDownLatch keepAlive = new java.util.concurrent.CountDownLatch(1);
        Runtime.getRuntime().addShutdownHook(new Thread(keepAlive::countDown));
        try {
            keepAlive.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    public AcpAsyncAgent createAgent(AcpAgentTransport transport) {
        return AcpAgent.async(transport)
                .requestTimeout(Duration.ofSeconds(60))
                .initializeHandler(req -> {
                    try {
                        return Mono.just(new AcpSchema.InitializeResponse(
                                1,
                                new AcpSchema.AgentCapabilities(true,
                                        new AcpSchema.McpCapabilities(true, true),
                                        new AcpSchema.PromptCapabilities(true, true, true)),
                                Arrays.asList()
                        ));
                    } catch (Throwable e) {
                        System.err.println("ACP initialize error: " + e.getMessage());
                        return Mono.error(e);
                    }
                })
                .newSessionHandler(req -> {
                    // 统一 work- 前缀；ACP 会话不登记所属根（跨进程写 session-roots.json
                    // 有丢更新风险），落全局会话区，Web 端可在「全局会话」中查看
                    String sessionId = SessionLocator.PREFIX_WORK + UUID.randomUUID().toString().substring(0, 8);
                    String cwd = req.cwd();

                    sessionStates.put(sessionId, new AcpSessionContext(cwd, req.mcpServers()));

                    return Mono.just(new AcpSchema.NewSessionResponse(sessionId, null, null));
                })
                .loadSessionHandler(req -> {
                    String sessionId = req.sessionId();
                    String cwd = req.cwd();

                    sessionStates.put(sessionId, new AcpSessionContext(cwd, req.mcpServers()));

                    return Mono.just(new AcpSchema.LoadSessionResponse(null, null));
                })
                .cancelHandler(req -> {
                    String sessionId = req.sessionId();
                    AcpSessionContext context = sessionStates.get(sessionId);
                    if (context != null) {
                        context.setCancelled(true);
                    }
                    return Mono.empty();
                })
                .promptHandler((request, acpContext) -> {
                    String sessionId = acpContext.getSessionId();
                    AcpSessionContext context = sessionStates.get(sessionId);

                    // 如果 session 尚未创建，返回错误而不是 NPE
                    if (context == null) {
                        return acpContext.sendMessage("Session not found: " + sessionId)
                                .thenReturn(new AcpSchema.PromptResponse(AcpSchema.StopReason.END_TURN));
                    }

                    // ACP 会话是长连接、跨多轮 prompt 复用的；每轮开始前清掉上一轮遗留的取消标记，
                    // 否则一旦某轮被 cancel，takeWhile 会让之后所有 prompt 立即空转。
                    context.setCancelled(false);

                    Prompt userInput = toPrompt(request);
                    AgentSession session = agentRuntime.getSession(sessionId);

                    // ACP 子进程是常驻进程，启动时加载的 settings 可能已过时：用户在 ACP 进程启动后
                    // 才在 Web/桌面端修改 acpModel、思考深度或新增模型时，若继续沿用启动时的旧配置，
                    // 会静默回退到 defaultModel（表现为"模型能正常调用、唯独 ACP 报 406/模型不对"），
                    // 或找不到新模型。故每轮 prompt 重新加载最新配置，并即时补注册缺失的模型。
                    final AgentSettings latestSettings = AgentSettings.loadFromFile();

                    // ACP 走独立子进程，没有前端会话态可选模型，改由「编码设置」里配置的 acpModel 决定；
                    // 留空则回退到 defaultModel。若一个模型都没配，返回 null，需在此
                    // 拦截并给出可读提示，而不是让 null 一路传到 ReActAgent.of(null) 抛 chatModel is required。
                    ChatModel chatModel = resolveChatModel(agentRuntime, latestSettings);

                    if (chatModel == null) {
                        return acpContext.sendMessage("未配置可用模型：请在 GWork「设置 - 编码工具接入」中选择 ACP 使用的模型，或先在「设置 - 模型」中添加并启用一个模型。")
                                .thenReturn(new AcpSchema.PromptResponse(AcpSchema.StopReason.END_TURN));
                    }

                    // 供 lambda 引用（保持显式 final，强调跨线程读取的安全性）
                    final ChatModel finalChatModel = chatModel;

                    // 读取思考深度配置（确保 effectively final，供 lambda 引用）
                    final String acpThinkingDepth = latestSettings.getGeneral().getAcpThinkingDepth() != null
                            ? latestSettings.getGeneral().getAcpThinkingDepth() : "off";

                    final long startTime = System.currentTimeMillis();
                    final AtomicInteger toolCallCounter = new AtomicInteger(0);
                    // 每轮 prompt 的 id 前缀，避免跨轮次 toolCallId 重复（编辑器按 sessionId 归并历史卡片）
                    final String idPrefix = "t" + UUID.randomUUID().toString().substring(0, 8);

                    return agentRuntime.prompt(userInput)
                            .session(session)
                            .options(o -> {
                                o.chatModel(finalChatModel);
                                if (Assert.isNotEmpty(context.getCwd())) {
                                    o.toolContextPut(HarnessEngine.ATTR_CWD, context.getCwd());
                                }
                                // 应用思考深度配置
                                final String modelStandard = finalChatModel.getStandardOrProvider();
                                ThinkingDepth.applyTo(o, modelStandard, acpThinkingDepth);
                                // 同时透传给工具链：TaskTalent 据此让子代理与本轮使用同一档位，
                                // 否则子代理只能读到会话级旧值（甚至 null→OFF）而静默降档。
                                o.toolContextPut(HarnessEngine.ATTR_THINKING_DEPTH,
                                        ThinkingDepth.normalize(acpThinkingDepth));
                            })
                            .stream()
                            .takeWhile(chunk -> !context.isCancelled())
                            .concatMap(chunk -> {
                                // === 规划阶段：映射到 ACP Plan 结构化输出（完整步骤列表 + 按进度标记状态） ===
                                if (chunk instanceof PlanEvent) {
                                    PlanEvent planEvent = (PlanEvent) chunk;
                                    List<String> plans = planEvent.getPlans();
                                    int currIdx = planEvent.getPlanIndex();

                                    List<AcpSchema.PlanEntry> entries = new ArrayList<>();
                                    if (plans != null) {
                                        for (int i = 0; i < plans.size(); i++) {
                                            AcpSchema.PlanEntryStatus status = i < currIdx
                                                    ? AcpSchema.PlanEntryStatus.COMPLETED
                                                    : (i == currIdx ? AcpSchema.PlanEntryStatus.IN_PROGRESS : AcpSchema.PlanEntryStatus.PENDING);
                                            entries.add(new AcpSchema.PlanEntry(
                                                    plans.get(i), AcpSchema.PlanEntryPriority.MEDIUM, status));
                                        }
                                    }
                                    if (entries.isEmpty()) {
                                        entries.add(new AcpSchema.PlanEntry("Planning...",
                                                AcpSchema.PlanEntryPriority.HIGH, AcpSchema.PlanEntryStatus.IN_PROGRESS));
                                    }
                                    return acpContext.sendUpdate(sessionId, new AcpSchema.Plan("plan", entries))
                                            .thenReturn(chunk);
                                }
                                // === 推理阶段：思考流 → thought；正文增量 → message ===
                                // ACP 是结构化协议，思考/正文的折叠展示由编辑器决定，
                                // 不复用 CLI 终端的 cliThinkPrinted 开关（该开关仅约束 CLI 打印）。
                                else if (chunk instanceof ReasonDeltaEvent) {
                                    ReasonDeltaEvent reasonDelta = (ReasonDeltaEvent) chunk;
                                    if (chunk.hasContent() && !reasonDelta.isToolCalls()) {
                                        // 剥离 think 标签噪声；剥离后为空的 chunk 直接过滤（避免客户端空泡/标签残片）
                                        String text = stripThinkTags(chunk.getContent());
                                        if (text == null || text.trim().isEmpty()) {
                                            return Mono.just(chunk);
                                        }
                                        if (reasonDelta.isThinking()) {
                                            // 实测：部分 ACP 客户端不渲染 agent_thought_chunk 块，
                                            // 思考内容需双发到正文才能保证可见（与 RetryEvent 同策略）
                                            return acpContext.sendThought(text)
                                                    .then(acpContext.sendMessage(text))
                                                    .thenReturn(chunk);
                                        }
                                        return acpContext.sendMessage(text)
                                                .thenReturn(chunk);
                                    }
                                }
                                // === ReasonEndEvent（子代理聚合载荷） ===
                                else if (chunk instanceof ReasonEndEvent) {
                                    ReasonEndEvent reasonEnd = (ReasonEndEvent) chunk;
                                    if (reasonEnd.hasMeta(TaskTalent.META_SUBAGENT)) {
                                        // 思考与正文都走 thought 通道：对 ACP 客户端而言两者都是「子代理
                                        // 内部产出」，需与主代理的最终答案（agent_message_chunk）区分开，
                                        // 否则子代理中间产物会被当成最终回复展示。
                                        Mono<Void> send = Mono.empty();

                                        // 思考：旧实现完全不下发，子代理思考在 ACP 端永远不可见
                                        if (reasonEnd.hasThinking()) {
                                            send = send.then(acpContext.sendThought(reasonEnd.getThinking()));
                                        }

                                        // 正文必须用 getText()：getAssistantMessage().getResultContent() 内部是
                                        // stripThinkTags，对「inline-think 方言」（Qwen 等把思考直接写在正文里、
                                        // 用 <think> 标签包裹）会把标签前的真实正文一并吃掉，只剩标签后的残段
                                        // ——AgentUtilTest 里已有针对该缺陷的护栏用例。
                                        String content = reasonEnd.getText();
                                        if (Assert.isNotEmpty(content)) {
                                            send = send.then(acpContext.sendThought(content));
                                        }

                                        return send.thenReturn(chunk);
                                    }
                                }
                                // === 工具开始：先下发 IN_PROGRESS 卡片，编辑器可渲染 loading 骨架 ===
                                else if (chunk instanceof ToolCallStartEvent) {
                                    ToolCallStartEvent toolStart = (ToolCallStartEvent) chunk;
                                    String toolName = toolStart.getToolName();

                                    // 跳过内部任务分发工具（不向客户端展示）
                                    if (Assert.isEmpty(toolName)
                                            || TaskTalent.TOOL_MULTITASK.equals(toolName)
                                            || TaskTalent.TOOL_TASK.equals(toolName)) {
                                        return Mono.just(chunk);
                                    }

                                    String toolCallId = idPrefix + "-" + toolCallCounter.incrementAndGet();
                                    if (toolStart.getActionId() != null) {
                                        actionToolCallIds.put(mapKey(sessionId, toolStart.getActionId()), toolCallId);
                                    }

                                    AcpSchema.ToolCall toolCall = new AcpSchema.ToolCall(
                                            "tool_call",
                                            toolCallId,
                                            buildStartTitle(toolName, toolStart.getArgs()),
                                            mapToolKind(toolName),
                                            AcpSchema.ToolCallStatus.IN_PROGRESS,
                                            Collections.emptyList(),
                                            buildLocations(toolName, toolStart.getArgs()),
                                            toolStart.getArgs(),   // rawInput
                                            null,                    // rawOutput
                                            null                     // meta
                                    );
                                    return acpContext.sendUpdate(sessionId, toolCall)
                                            .thenReturn(chunk);
                                }
                                // === 工具完成：同 id 更新为 COMPLETED/FAILED（含错误信息，不再静默丢弃） ===
                                else if (chunk instanceof ToolCallEndEvent) {
                                    ToolCallEndEvent toolEnd = (ToolCallEndEvent) chunk;
                                    String toolName = toolEnd.getToolName();

                                    // 跳过内部任务分发工具（不向客户端展示）
                                    if (TaskTalent.TOOL_MULTITASK.equals(toolName) || TaskTalent.TOOL_TASK.equals(toolName)) {
                                        return Mono.just(chunk);
                                    }

                                    // actionId 可能为 null（旧构造/未提供），ConcurrentHashMap.remove(null) 会 NPE
                                    String actionId = toolEnd.getActionId();
                                    String toolCallId = actionId != null
                                            ? actionToolCallIds.remove(mapKey(sessionId, actionId))
                                            : null;
                                    if (toolCallId == null) {
                                        toolCallId = idPrefix + "-" + toolCallCounter.incrementAndGet();
                                    }
                                    String content = chunk.getContent();

                                    Throwable error = toolEnd.getError();
                                    AcpSchema.ToolCallStatus status = error != null
                                            ? AcpSchema.ToolCallStatus.FAILED
                                            : AcpSchema.ToolCallStatus.COMPLETED;
                                    String rawOutput = error != null
                                            ? "错误: " + safeMessage(error) + (Assert.isNotEmpty(content) ? "\n" + content : "")
                                            : content;

                                    // 使用 ACP ToolCall 构建结构化工具调用通知
                                    AcpSchema.ToolCall toolCall = new AcpSchema.ToolCall(
                                            "tool_call",
                                            toolCallId,
                                            buildToolTitle(toolName, toolEnd.getArgs(), content),
                                            mapToolKind(toolName),
                                            status,
                                            buildToolContent(rawOutput),
                                            buildLocations(toolName, toolEnd.getArgs()),
                                            toolEnd.getArgs(),   // rawInput
                                            rawOutput,                 // rawOutput
                                            null                     // meta
                                    );
                                    return acpContext.sendUpdate(sessionId, toolCall)
                                            .thenReturn(chunk);
                                }
                                // === 子代理启动：映射为 IN_PROGRESS 的 ToolCall 卡片 ===
                                else if (chunk instanceof AgentStartEvent) {
                                    AgentStartEvent startChunk = (AgentStartEvent) chunk;
                                    String agentKey = agentKey(startChunk.getAgentName(), startChunk.getDescription(), startChunk.getInvocationId());
                                    String toolCallId = idPrefix + "-agent-" + toolCallCounter.incrementAndGet();
                                    agentToolCallIds.put(mapKey(sessionId, agentKey), toolCallId);

                                    AcpSchema.ToolCall toolCall = new AcpSchema.ToolCall(
                                            "tool_call",
                                            toolCallId,
                                            agentTitle(startChunk.getAgentName(), startChunk.getDescription()),
                                            AcpSchema.ToolKind.OTHER,
                                            AcpSchema.ToolCallStatus.IN_PROGRESS,
                                            Collections.emptyList(),
                                            Collections.emptyList(),
                                            null, null, null
                                    );
                                    return acpContext.sendUpdate(sessionId, toolCall)
                                            .thenReturn(chunk);
                                }
                                // === 子代理结束：同 id 更新为 COMPLETED/FAILED，附结果摘要 ===
                                else if (chunk instanceof AgentEndEvent) {
                                    AgentEndEvent endChunk = (AgentEndEvent) chunk;
                                    String agentKey = agentKey(endChunk.getAgentName(), endChunk.getDescription(), endChunk.getInvocationId());
                                    String toolCallId = agentToolCallIds.remove(mapKey(sessionId, agentKey));
                                    if (toolCallId == null && endChunk.getInvocationId() != null) {
                                        toolCallId = agentToolCallIds.remove(mapKey(sessionId,
                                                agentKey(endChunk.getAgentName(), endChunk.getDescription(), null)));
                                    }
                                    if (toolCallId == null) {
                                        toolCallId = idPrefix + "-agent-" + toolCallCounter.incrementAndGet();
                                    }

                                    AcpSchema.ToolCall toolCall = new AcpSchema.ToolCall(
                                            "tool_call",
                                            toolCallId,
                                            agentTitle(endChunk.getAgentName(), endChunk.getDescription()),
                                            AcpSchema.ToolKind.OTHER,
                                            endChunk.isSuccess()
                                                    ? AcpSchema.ToolCallStatus.COMPLETED
                                                    : AcpSchema.ToolCallStatus.FAILED,
                                            buildToolContent(endChunk.getResultSummary()),
                                            Collections.emptyList(),
                                            null,
                                            endChunk.getResultSummary(), // rawOutput
                                            null
                                    );
                                    return acpContext.sendUpdate(sessionId, toolCall)
                                            .thenReturn(chunk);
                                }
                                // === 重试通知：映射到 thought，避免静默等待 ===
                                else if (chunk instanceof RetryEvent) {
                                    // thought 进入可折叠的思考区；另推一条可见正文消息，
                                    // 保证默认折叠 thought 的编辑器也能看到「正在重试」提示
                                    String retryText = ((RetryEvent) chunk).toText();
                                    return acpContext.sendThought(retryText)
                                            .then(acpContext.sendMessage(retryText))
                                            .thenReturn(chunk);
                                }
                                // === 最终回复阶段 ===
                                else if (chunk instanceof RunEndEvent) {
                                    RunEndEvent runEnd = (RunEndEvent) chunk;
                                    String traceInfo = buildTraceInfo(runEnd.getTrace(), startTime);

                                    // 正文增量已由 ReasonDeltaEvent 流式下发，正常结束只补发 trace 统计（走 thought），
                                    // 避免编辑器把全文再拼接一遍造成重复；异常结束时正文可能未流完，补发全文保证错误可见。
                                    if (runEnd.isAbnormal()) {
                                        return acpContext.sendMessage(chunk.getContent() + traceInfo)
                                                .thenReturn(chunk);
                                    }
                                    return acpContext.sendThought(traceInfo)
                                            .thenReturn(chunk);
                                }

                                return Mono.just(chunk);
                            })
                            .then(Mono.<AcpSchema.PromptResponse>just(new AcpSchema.PromptResponse(AcpSchema.StopReason.END_TURN)))
                            .onErrorResume(e -> {
                                // 异常不再静默吞掉：先把错误信息推给编辑器，再正常收尾
                                System.err.println("ACP prompt error: " + e.getMessage());
                                return acpContext.sendMessage("任务执行异常: " + safeMessage(e))
                                        .onErrorResume(ignored -> Mono.empty())
                                        .thenReturn(new AcpSchema.PromptResponse(AcpSchema.StopReason.END_TURN));
                            })
                            .doFinally(signal -> drainUnclosedToolCalls(acpContext, sessionId));
                })
                .build();
    }

    /**
     * 按「编码设置」解析 ACP 应使用的模型（acpModel 优先，留空回退 defaultModel）。
     *
     * <p>ACP 子进程常驻，启动时加载的模型集可能滞后于 settings.json：用户在 ACP 进程启动后
     * 才新增/修改的模型，运行时并未注册。若仅按运行时已注册模型查找，
     * 会静默回退到 defaultModel，表现为「模型明明配置且能正常调用，唯独 ACP 报 406/模型不对」。
     * 故每轮 prompt 以最新配置为准：acpModel 对应的模型存在且启用时，先注册（幂等覆盖）再取。</p>
     *
     * @param runtime  运行时引擎（承载已注册模型）
     * @param settings 最新加载的配置（每轮 prompt 重新 loadFromFile）
     * @return 对应 ChatModel；未配置可用模型时返回 null
     */
    public static ChatModel resolveChatModel(HarnessEngine runtime, AgentSettings settings) {
        Map<String, ModelDo> latestModels = settings.getModels();

        // 常驻 ACP 进程中的模型注册表必须跟随最新 settings：先摘除已删除/禁用的旧实例。
        for (org.noear.solon.ai.chat.ChatConfig registered : new ArrayList<>(runtime.getModels())) {
            String name = registered.getNameOrModel();
            ModelDo latest = latestModels.get(name);
            if (latest == null || !latest.isEnabled()) {
                runtime.removeModel(name);
            }
        }

        // 明确 fallback 顺序：ACP 指定模型 -> defaultModel -> 最新配置中首个启用模型。
        List<String> candidates = new ArrayList<>();
        String configured = settings.getGeneral().getAcpModel();
        if (configured != null) configured = configured.trim();
        if (Assert.isNotEmpty(configured)) candidates.add(configured);
        if (Assert.isNotEmpty(settings.getDefaultModel()) && !candidates.contains(settings.getDefaultModel())) {
            candidates.add(settings.getDefaultModel());
        }
        for (Map.Entry<String, ModelDo> entry : latestModels.entrySet()) {
            if (entry.getValue() != null && entry.getValue().isEnabled() && !candidates.contains(entry.getKey())) {
                candidates.add(entry.getKey());
            }
        }

        for (String candidate : candidates) {
            ModelDo modelDo = latestModels.get(candidate);
            if (modelDo == null || !modelDo.isEnabled()) {
                runtime.removeModel(candidate);
                continue;
            }
            runtime.removeModel(candidate);
            runtime.addModel(modelDo);
            org.noear.solon.ai.chat.ChatConfig exact = runtime.getModelOrNil(candidate);
            return exact == null ? null : exact.toChatModel();
        }
        return null;
    }

    /**
     * 解析 ACP 应使用的模型名：acpModel 优先，留空回退 defaultModel；都没有则返回 null。
     */
    public static String resolveModelName(AgentSettings settings) {
        String acpModel = settings.getGeneral().getAcpModel();
        if (acpModel != null) {
            acpModel = acpModel.trim(); //历史配置可能残留空白值，避免按名查找失配
        }

        if (Assert.isEmpty(acpModel)) {
            acpModel = settings.getDefaultModel();
        }

        return acpModel;
    }

    /**
     * 构建工具「开始」卡片的显示标题（简化模式显示运行中，全量模式显示参数）
     */
    private String buildStartTitle(String toolName, Map<String, Object> args) {
        if (Assert.isEmpty(toolName)) {
            return "tool";
        }

        if (agentSettings.getGeneral().getCliPrintSimplified()) {
            return toolName + " 执行中...";
        }

        String argsStr = buildArgsStr(args);
        if (argsStr.length() > 100) {
            argsStr = argsStr.substring(0, 97) + "...";
        }
        return toolName + "(" + argsStr + ")";
    }

    /**
     * 构建子代理卡片的显示标题
     */
    private String agentTitle(String agentName, String description) {
        if (Assert.isEmpty(agentName)) {
            agentName = "agent";
        }
        if (Assert.isEmpty(description)) {
            return agentName;
        }
        String desc = description.length() > 60 ? description.substring(0, 57) + "..." : description;
        return agentName + ": " + desc;
    }

    /**
     * 工具名 → ACP ToolKind 语义映射，便于编辑器按类型渲染图标
     */
    private AcpSchema.ToolKind mapToolKind(String toolName) {
        // 实测：部分 ACP 客户端把 READ/SEARCH 等语义 kind 渲染成紧凑单行小条（无卡片、无法展开详情），
        // 仅 EXECUTE/OTHER 渲染为可展开卡片（旧版统一 EXECUTE 时一切工具均为卡片）。
        // 故统一 EXECUTE，保证所有工具都能以卡片形式展示并查看输出详情。
        return AcpSchema.ToolKind.EXECUTE;
    }

    /**
     * 构建工具卡的 content 详情（ACP ToolCallContent）。
     * 编辑器的「查看详情」面板读取的是 content 字段；仅填 rawOutput 时详情面板为空，
     * 表现为卡片无法展开查看输出内容。
     */
    private List<AcpSchema.ToolCallContent> buildToolContent(String text) {
        if (Assert.isEmpty(text)) {
            return Collections.emptyList();
        }
        // content 仅供编辑器详情面板展示，超长截断（rawOutput 保留全量），避免大输出双倍放大 JSON 体积
        if (text.length() > MAX_CONTENT_CHARS) {
            text = text.substring(0, MAX_CONTENT_CHARS) + "\n…(输出过长，已截断)";
        }
        return Collections.singletonList(
                new AcpSchema.ToolCallContentBlock("content", new AcpSchema.TextContent(text)));
    }

    /** 详情面板文本上限（字符） */
    private static final int MAX_CONTENT_CHARS = 20000;

    private static String mapKey(String sessionId, String value) {
        return sessionId + "\u0000" + value;
    }

    private static String agentKey(String name, String description, String invocationId) {
        if (invocationId != null && !invocationId.isEmpty()) {
            return invocationId;
        }
        return name + ":" + description;
    }

    /**
     * 流结束时收尾未闭合的工具/子代理卡片（ToolCallStartEvent 已发但 Observation 未到达、
     * 或用户取消导致流提前终止），避免编辑器里卡片永远停在 loading 态。
     * fire-and-forget：收尾失败不影响主流程。
     */
    private void drainUnclosedToolCalls(PromptContext acpContext, String sessionId) {
        try {
            String sessionPrefix = sessionId + "\u0000";
            for (Map.Entry<String, String> e : new HashMap<>(actionToolCallIds).entrySet()) {
                if (!e.getKey().startsWith(sessionPrefix)) {
                    continue;
                }
                actionToolCallIds.remove(e.getKey());
                AcpSchema.ToolCall toolCall = new AcpSchema.ToolCall(
                        "tool_call", e.getValue(), "已中断",
                        AcpSchema.ToolKind.OTHER, AcpSchema.ToolCallStatus.FAILED,
                        buildToolContent("已中断：未收到工具结果（任务被取消或流提前结束）"),
                        Collections.emptyList(), null,
                        "已中断：未收到工具结果", null);
                acpContext.sendUpdate(sessionId, toolCall).subscribe();
            }
            for (Map.Entry<String, String> e : new HashMap<>(agentToolCallIds).entrySet()) {
                if (!e.getKey().startsWith(sessionPrefix)) {
                    continue;
                }
                agentToolCallIds.remove(e.getKey());
                AcpSchema.ToolCall toolCall = new AcpSchema.ToolCall(
                        "tool_call", e.getValue(), "已中断",
                        AcpSchema.ToolKind.OTHER, AcpSchema.ToolCallStatus.FAILED,
                        buildToolContent("已中断：子代理未返回结束信号（任务被取消或流提前结束）"),
                        Collections.emptyList(), null,
                        "已中断：子代理未返回结束信号", null);
                acpContext.sendUpdate(sessionId, toolCall).subscribe();
            }
        } catch (Throwable ignored) {
            // 收尾失败不影响主流程
        }
    }

    /** 剥离模型输出中内嵌的 think 标签（与 CliShell 清洗逻辑一致），避免客户端正文出现标签噪声 */
    private String stripThinkTags(String text) {
        if (text == null) {
            return null;
        }
        return text.replaceAll("(?s)<\\s*/?think\\s*>", "");
    }

    private String safeMessage(Throwable e) {
        if (e == null) {
            return "unknown";
        }
        if (e.getMessage() != null) {
            return e.getMessage();
        }
        if (e.getCause() != null && e.getCause().getMessage() != null) {
            return e.getCause().getMessage();
        }
        return e.getClass().getSimpleName();
    }

    /**
     * 从工具参数提取文件位置（ACP ToolCallLocation），
     * 供编辑器做「跟随智能体」高亮与受影响文件展示。
     */
    private List<AcpSchema.ToolCallLocation> buildLocations(String toolName, Map<String, Object> args) {
        if (args == null) {
            return Collections.emptyList();
        }
        Object pathArg = null;
        if (toolName != null) {
            switch (toolName) {
                case "read":
                case "write":
                case "edit":
                    pathArg = args.get("file_path");
                    break;
                case "glob":
                case "ls":
                case "grep":
                    pathArg = args.get("path");
                    break;
                default:
                    break;
            }
        }
        if (pathArg == null || Assert.isEmpty(String.valueOf(pathArg))) {
            return Collections.emptyList();
        }
        return Collections.singletonList(new AcpSchema.ToolCallLocation(String.valueOf(pathArg), null));
    }

    /**
     * 构建工具调用的显示标题
     */
    private String buildToolTitle(String toolName, Map<String, Object> args, String content) {
        if (Assert.isEmpty(toolName)) {
            return content;
        }

        String argsStr = buildArgsStr(args);

        if (agentSettings.getGeneral().getCliPrintSimplified()) {
            // 简化模式：只显示工具名 + 结果摘要
            String summary;
            if (Assert.isEmpty(content)) {
                summary = "completed";
            } else {
                String[] lines = content.split("\n");
                if (lines.length > 1) {
                    summary = "returned " + lines.length + " lines";
                } else {
                    summary = content.length() > 40 ? content.substring(0, 37) + "..." : content;
                }
            }
            return toolName + ": " + summary;
        } else {
            // 全量模式：显示工具名 + 参数
            if (argsStr.length() > 100) {
                return toolName + "(" + argsStr.substring(0, 97) + "...)";
            }
            return toolName + "(" + argsStr + ")";
        }
    }

    /**
     * 构建 trace 统计信息（参考 WebStreamBuilder.getTraceInfo）
     */
    private String buildTraceInfo(ReActTrace trace, long startTime) {
        StringBuilder buf = new StringBuilder();
        buf.append("(");

        if (trace != null && trace.getMetrics() != null) {
            long inputTokens = trace.getMetrics().getPromptTokens();
            long outputTokens = trace.getMetrics().getCompletionTokens();

            buf.append("输入: ").append(formatTokens(inputTokens)).append(" tokens");
            buf.append(", 输出: ").append(formatTokens(outputTokens)).append(" tokens");
        }

        long seconds = Duration.ofMillis(System.currentTimeMillis() - startTime).getSeconds();
        if (buf.length() > 1) buf.append(", ");
        buf.append("耗时: ").append(formatTime(seconds));

        buf.append(")");
        return buf.toString();
    }

    private String formatTokens(long n) {
        if (n >= 1_000_000) {
            return String.format("%.1fM", n / 1_000_000.0).replaceAll("\\.0", "");
        } else if (n >= 1_000) {
            return String.format("%.1fK", n / 1_000.0).replaceAll("\\.0", "");
        }
        return String.valueOf(n);
    }

    private String formatTime(long seconds) {
        if (seconds >= 60) {
            long mins = seconds / 60;
            long secs = seconds % 60;
            return secs > 0 ? mins + "min " + secs + "s" : mins + "min";
        }
        return seconds + "s";
    }

    private String buildArgsStr(Map<String, Object> args) {
        if (args == null || args.isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        args.forEach((k, v) -> {
            if (sb.length() > 0) sb.append(" ");
            sb.append(k).append("=").append(v);
        });
        return sb.toString().replace("\n", " ");
    }

    public Prompt toPrompt(AcpSchema.PromptRequest promptRequest) {
        Prompt prompt = Prompt.of();

        Contents contents = new Contents();

        for (AcpSchema.ContentBlock cp : promptRequest.prompt()) {
            if (cp instanceof AcpSchema.TextContent) {
                AcpSchema.TextContent text = (AcpSchema.TextContent) cp;
                contents.addBlock(TextBlock.of(text.text()));
            } else if (cp instanceof AcpSchema.ImageContent) {
                AcpSchema.ImageContent image = (AcpSchema.ImageContent) cp;
                if (Assert.isEmpty(image.uri())) {
                    contents.addBlock(ImageBlock.ofBase64(image.data(), image.mimeType()));
                } else {
                    contents.addBlock(ImageBlock.ofUrl(image.uri(), image.mimeType()));
                }
            }
        }

        return prompt.addMessage(ChatMessage.ofUser(contents));
    }

    public static class AcpSessionContext {
        private final String cwd;
        private final List<AcpSchema.McpServer> mcpServers;
        private volatile boolean cancelled;

        public AcpSessionContext(String cwd, List<AcpSchema.McpServer> mcpServers) {
            this.cwd = cwd;
            this.mcpServers = mcpServers;
        }

        public String getCwd() {
            return cwd;
        }

        public List<AcpSchema.McpServer> getMcpServers() {
            return mcpServers;
        }

        public boolean isCancelled() {
            return cancelled;
        }

        public void setCancelled(boolean cancelled) {
            this.cancelled = cancelled;
        }
    }
}
