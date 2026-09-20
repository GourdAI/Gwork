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
package com.gourdai.ai.chat;

import org.noear.snack4.ONode;
import org.noear.solon.Utils;
import com.gourdai.ai.AiUsage;
import com.gourdai.ai.chat.content.ContentBlock;
import com.gourdai.ai.chat.content.TextBlock;
import com.gourdai.ai.chat.dialect.ChatDialect;
import com.gourdai.ai.chat.event.*;
import com.gourdai.ai.chat.interceptor.*;
import com.gourdai.ai.chat.message.AssistantMessage;
import com.gourdai.ai.chat.message.ChatMessage;
import com.gourdai.ai.chat.message.SystemMessage;
import com.gourdai.ai.chat.message.ToolMessage;
import com.gourdai.ai.chat.prompt.Prompt;
import com.gourdai.ai.chat.session.InMemoryChatSession;
import com.gourdai.ai.chat.talent.TalentUtil;
import com.gourdai.ai.chat.tool.*;
import org.noear.solon.core.util.Assert;
import org.noear.solon.core.util.MimeType;
import org.noear.solon.core.util.RankEntity;
import org.noear.solon.net.http.HttpResponse;
import org.noear.solon.net.http.HttpUtils;
import org.noear.solon.net.http.textstream.ServerSentEvent;
import org.noear.solon.net.http.textstream.TextStreamUtil;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.Disposable;
import reactor.core.Disposables;
import reactor.core.publisher.Flux;
import reactor.core.publisher.FluxSink;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.io.IOException;
import java.io.InterruptedIOException;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiConsumer;
import java.util.function.Consumer;

/**
 * 聊天请求描述实现
 *
 * @author noear
 * @since 3.1
 */
public class ChatRequestDescDefault implements ChatRequestDesc {
    private static final Logger log = LoggerFactory.getLogger(ChatRequestDescDefault.class);

    /** 流式帧间空闲上限：断流发现速度的直接决定者（弱网优化，2026-09-18） */
    private static final Duration STREAM_IDLE_CAP = Duration.ofSeconds(60);

    /** 流式帧间空闲下限：防极端短配置误杀合法慢流 */
    private static final Duration STREAM_IDLE_FLOOR = Duration.ofSeconds(15);

    /** 非流式总时长兜底基准：config.timeout 未配置时按此值推导（与 AiConfig.timeout 默认值一致） */
    private static final Duration CALL_TIMEOUT_DEFAULT = Duration.ofSeconds(120);

    /** 非流式总时长（wall-clock）下限：防极端短配置误杀正常的推理型模型请求（弱网优化，2026-09-18） */
    private static final Duration CALL_TOTAL_FLOOR = Duration.ofSeconds(60);

    /** 非流式总时长（wall-clock）绝对上限：非流式期间用户零反馈，可容忍的沉默时长远小于流式 */
    private static final Duration CALL_TOTAL_CAP = Duration.ofMinutes(10);

    private final ChatConfig config;
    private final ChatDialect dialect;
    private final Prompt originalPrompt;

    private ChatSession session;
    private ChatOptions options;
    private ChatEventFilter eventFilter = ChatEventFilter.DEFAULT;

    public ChatRequestDescDefault(ChatConfig config, ChatDialect dialect, ChatSession session, Prompt prompt) {
        this.config = config;
        this.dialect = dialect;
        this.session = session;
        this.originalPrompt = prompt;

        this.options = config.getModelOptions().copy();
    }

    public ChatRequestDesc session(ChatSession session) {
        this.session = session;
        return this;
    }

    /**
     * 角色
     *
     * @since 4.0.4
     */
    @Override
    public ChatRequestDesc role(String role) {
        if (options != null) {
            options.role(role);
        }

        return this;
    }

    /**
     * 指令
     *
     * @since 4.0.4
     */
    @Override
    public ChatRequestDesc instruction(String instruction) {
        if (options != null) {
            options.instruction(instruction);
        }

        return this;
    }

    /**
     * 系统提示词
     *
     * @since 4.0.4
     */
    @Override
    public ChatRequestDesc systemPrompt(String systemPrompt) {
        if (options != null) {
            options.systemPrompt(systemPrompt);
        }

        return this;
    }

    /**
     * 选项设置
     *
     * @param options 选项
     * @deprecated 4.0.4
     */
    @Deprecated
    @Override
    public ChatRequestDesc options(ChatOptions options) {
        if (options != null) {
            //重置
            this.options = options;
        }

        return this;
    }

    /**
     * 选项配置
     *
     * @param optionsBuilder 选项构建器
     */
    @Override
    public ChatRequestDesc options(Consumer<ChatOptions> optionsBuilder) {
        //可多次调用
        optionsBuilder.accept(options);
        return this;
    }


    /**
     * 准备
     */
    private void prepare() {
        if (prepared.compareAndSet(false, true)) {
            if (session == null) {
                session = InMemoryChatSession.builder().build();
            }

            if (originalPrompt != null) {
                // 先补 sessionId 再入会话：判空写反过会让 else 分支解引用 null（当前调用方保证非空故未触发）
                originalPrompt.attrs().computeIfAbsent(ChatSession.ATTR_SESSIONID,
                        k -> session.getSessionId());
                session.addMessage(originalPrompt);
            }

            // 如果没有 sessionId 则推入
            options.toolContext().computeIfAbsent(ChatSession.ATTR_SESSIONID,
                    k -> session.getSessionId());

            //---

            StringBuilder instructionBuilder = new StringBuilder();

            if (Assert.isNotEmpty(options.systemPrompt())) {
                //如果有系统提示词（优先用）
                instructionBuilder.append(options.systemPrompt()).append("\n\n");
            } else {
                //如果没有尝试结构化构建
                if (Assert.isNotEmpty(options.role())) {
                    instructionBuilder.append("## 你的角色\n").append(options.role()).append("\n\n");
                }

                if (Assert.isNotEmpty(options.instruction())) {
                    instructionBuilder.append("## 执行指令\n").append(options.instruction()).append("\n");
                }
            }

            if(Assert.isNotEmpty(options.outputSchema())) {
                dialect.prepareOutputSchemaInstruction(options.outputSchema(), instructionBuilder);
                dialect.prepareOutputFormatOptions(options);
            }

            if (originalPrompt != null && Assert.isNotEmpty(options.toolContext())) {
                originalPrompt.attrs().putAll(options.toolContext());
            }

            for (RankEntity<ChatInterceptor> item : options.interceptors()) {
                if (item.target.isEnabled()) {
                    item.target.onPrepare(session, options, originalPrompt, instructionBuilder);
                }
            }

            StringBuilder talentsInstruction = TalentUtil.activeTalents(options, originalPrompt, new StringBuilder());
            if (talentsInstruction.length() > 0) {
                instructionBuilder.append("\n");
                instructionBuilder.append(talentsInstruction);
            }

            if (instructionBuilder.length() > 0) {
                systemMessage = ChatMessage.ofSystem(instructionBuilder.toString());
            }
        }
    }

    private AtomicBoolean prepared = new AtomicBoolean(false);
    private SystemMessage systemMessage;

    /**
     * 事件投递过滤器
     *
     * @since 4.1
     */
    @Override
    public ChatRequestDesc eventFilter(ChatEventFilter filter) {
        if (filter != null) {
            this.eventFilter = filter;
        }

        return this;
    }

    /**
     * 调用
     */
    @Override
    public ChatResponse call() throws IOException {
        prepare();

        return internalCall();
    }

    protected ChatResponse internalCall() throws IOException {
        //构建请求数据（每次请求重新构建 finalPrompt）
        ChatRequest req = new ChatRequest(config, dialect, options, session, systemMessage, originalPrompt, false);

        CallChain chain = new CallChain(options.interceptors(), this::doCall);

        return chain.doIntercept(req);
    }

    /**
     * 调用
     */
    private ChatResponse doCall(ChatRequest req) throws IOException {
        HttpUtils httpUtils = dialect.createHttpUtils(config, req.isStream());
        if(req.getOptions().httpCustomize() != null){
            req.getOptions().httpCustomize().accept(httpUtils);
        }

        String reqJson = req.toRequestData();

        if (log.isDebugEnabled()) {
            log.debug("llm-request[{}]: {}", req.getAgentAndModel(), reqJson);
        }

        // 弱网优化（2026-09-18）：非流式路径此前只有 socket read timeout——供应商「持续慢吐字节
        // 但不闭合响应」时，每收到一个字节就重置读超时，等待可被无限延长。改为把「发请求 + 读完整
        // 响应体」整体置于 wall-clock 总时长上限之下，详见 execWithTotalCap / resolveCallTotalTimeout。
        String respJson = execWithTotalCap(httpUtils.bodyOfJson(reqJson));

        if (log.isDebugEnabled()) {
            log.debug("llm-response[{}]: {}", req.getAgentAndModel(), respJson);
        }

        //与流式对称：响应体不是 JSON 时给出指向配置的错误，而不是抛一个裸 JSON 解析异常
        if (Assert.isEmpty(respJson)) {
            throw new ChatException("LLM response is empty. Check the upstream service and apiUrl config.");
        }
        if (isModelFrameShape(respJson) == false) {
            throw new ChatException("LLM response is unrecognizable: not a json body."
                    + " Check the apiUrl and standard/provider config. body: " + abbreviate(respJson));
        }

        ChatAccumulator acc = new ChatAccumulator(req, false);
        acc.setFrameRaw(respJson);
        //非流式也要接 emitter：方言在非流式分支同样会解析出引用 / 服务端工具结果 /
        //思考签名 / 拒答等语义，丢了就是净损失（且无异常无日志）。收集到结果上供 ChatResponse#getEvents 取用。
        dialect.parseResponseJson(newContext(req, acc, null, 0, acc::addEvent), respJson);

        if (acc.getError() != null) {
            throw acc.getError();
        }

        AssistantMessage itemMessage = acc.snapshotTerminal().getMessage();
        if (itemMessage != null) {
            session.addMessage(itemMessage); //添加到记忆

            if (options.isAutoToolCall() && Assert.isNotEmpty(itemMessage.getToolCalls())) {
                List<ToolMessage> returnDirectMessages = buildToolMessage(acc, itemMessage);

                if (Assert.isEmpty(returnDirectMessages)) {
                    //没有直接返回的消息
                    return internalCall();
                } else {
                    //要求直接返回（转为新的响应消息）
                    itemMessage = dialect.buildAssistantMessageByToolMessages(itemMessage, returnDirectMessages);
                    acc.reset();
                    acc.lastFinishReason = "tool";
                    acc.replaceTerminalMessage(itemMessage);
                    session.addMessage(itemMessage); //添加到记忆
                }
            }
        }

        return acc.snapshotTerminal();
    }

    /**
     * 事件流响应
     *
     * <p>内部只有一条事件流，不存在并行的第二条管道，因此不会出现双源真相漂移。</p>
     *
     * <p><b>终止事件互斥</b>：正常完成发 {@code RESPONSE_END}，失败发 {@code ERROR}，
     * 二者共用同一个门閃——全流恰好一个终止事件。不在失败路径上补 {@code RESPONSE_END}：
     * 那会让「收到 RESPONSE_END 即视为成功」的订阅方静默误判。</p>
     */
    @Override
    public Flux<ChatEvent> stream() {
        // 所有运行时状态都必须在订阅时创建：同一个请求描述返回的 Flux 可以被重复订阅，
        // 不能让上一次订阅的生命周期、归一化状态或终态响应污染下一次订阅。
        final ChatEventFilter filter = ChatEventFilter.guarded(this.eventFilter);

        return Flux.defer(() -> {
            prepare();

            final ChatStreamSession streamSession = new ChatStreamSession();
            final ChatEventNormalizer normalizer = new ChatEventNormalizer();
            final AtomicReference<ChatResponse> lastRespRef = new AtomicReference<>();
            final AtomicReference<ChatAccumulator> currentAccRef = new AtomicReference<>();
            // 方言错误事件先暂存，统一在内容/工具/步骤边界收口后作为最后一个事件发出。
            final AtomicReference<ChatEvent> errorEventRef = new AtomicReference<>();

            Flux<ChatEvent> head = Flux.defer(() -> {
                if (streamSession.markResponseStarted()) {
                    return Flux.just((ChatEvent) ChatEventDefault.of(ChatEventType.RESPONSE_START)
                            .responseId(streamSession.getResponseId())
                            .build());
                }
                return Flux.empty();
            });

            Flux<ChatEvent> body = head.concatWith(internalStream(streamSession, lastRespRef, currentAccRef))
                    .concatMap(event -> {
                        // ERROR 是终态，必须转成 Reactor 错误信号；tail 会先补齐内容/工具/步骤边界，
                        // 再把保留原始协议字段的 ERROR 作为最后一个 ChatEvent 发出。
                        if (event.getType() == ChatEventType.ERROR) {
                            errorEventRef.compareAndSet(null, event);
                            ChatException error = event.getError() == null
                                    ? new ChatException("LLM stream emitted an ERROR event without an error payload")
                                    : event.getError();
                            return Flux.error(error);
                        }

                        List<ChatEvent> buf = new ArrayList<>(2);
                        normalizer.apply(event, buf::add);
                        return Flux.fromIterable(buf);
                    });

            //异常终止时也要跑收尾：Flux.concat 在 onError 时不会订阅第二个 publisher，
            //单靠 concatWith(tail) 会让失败路径上的块补齐、STEP 配平与终止事件全部丢失。
            return body.onErrorResume(err ->
                            tail(streamSession, normalizer, lastRespRef, currentAccRef, errorEventRef, err)
                                    .concatWith(Flux.error(err)))
                    .concatWith(tail(streamSession, normalizer, lastRespRef, currentAccRef, errorEventRef, null))
                    .filter(filter::test);
        });
    }

    /**
     * 流收尾（正常完成与异常终止共用）
     *
     * @param err 终止异常；为 null 表示正常完成
     */
    private Flux<ChatEvent> tail(ChatStreamSession streamSession, ChatEventNormalizer normalizer,
                                 AtomicReference<ChatResponse> lastRespRef,
                                 AtomicReference<ChatAccumulator> currentAccRef,
                                 AtomicReference<ChatEvent> errorEventRef, Throwable err) {
        return Flux.defer(() -> {
            List<ChatEvent> buf = new ArrayList<>(6);

            if (err != null) {
                // 失败步骤也必须带可打捞的部分聚合，并在 ERROR 之前配平 STEP。
                ChatAccumulator currentAcc = currentAccRef.get();
                if (currentAcc != null) {
                    ChatResponse partial = currentAcc.snapshotTerminal();
                    lastRespRef.set(partial);
                    streamSession.accumulateUsage(currentAcc.getUsage());
                    normalizer.apply(ChatEventDefault.of(ChatEventType.STEP_END)
                            .responseId(streamSession.getResponseId())
                            .step(streamSession.getStep())
                            .response(partial)
                            .usage(currentAcc.getUsage())
                            .build(), buf::add);
                }
            }

            //归一化收尾：补齐没有业务步骤载荷可构造的残余边界
            normalizer.complete(buf::add);

            //终止事件全流恰好一个：正常为 RESPONSE_END，失败为 ERROR
            if (streamSession.markResponseEnded()) {
                AiUsage totalUsage = streamSession.getTotalUsage();
                if (err == null) {
                    ChatAccumulator currentAcc = currentAccRef.get();
                    ChatResponse response = currentAcc == null
                            ? (lastRespRef.get() == null ? null
                            : new ChatResponseDefault(lastRespRef.get(), totalUsage))
                            : currentAcc.snapshotTerminal(totalUsage);
                    buf.add(ChatEventDefault.of(ChatEventType.RESPONSE_END)
                            .responseId(streamSession.getResponseId())
                            .step(streamSession.getStep())
                            .response(response)
                            .usage(totalUsage)
                            .build());
                } else {
                    ChatEvent source = errorEventRef.get();
                    ChatEventDefault.Builder errorBuilder = ChatEventDefault.of(ChatEventType.ERROR)
                            .responseId(streamSession.getResponseId())
                            .step(streamSession.getStep())
                            .error(err instanceof ChatException
                                    ? (ChatException) err : new ChatException(err))
                            .response(lastRespRef.get())
                            .usage(totalUsage);
                    if (source != null) {
                        errorBuilder.rawType(source.getRawType())
                                .subType(source.getSubType())
                                .providerResponseId(source.getProviderResponseId())
                                .itemId(source.getItemId())
                                .toolCallId(source.getToolCallId())
                                .index(source.getIndex())
                                .text(source.getText())
                                .toolCall(source.getToolCall())
                                .block(source.getBlock())
                                .raw(source.getRaw())
                                .attrs(source.getAttrs());
                    }
                    buf.add(errorBuilder.build());
                }
            }

            return Flux.fromIterable(buf);
        });
    }

    /**
     * 校验流响应的内容类型
     *
     * <p>不做白名单（各网关会给出各种合法变体），只拦「绝不可能是模型流」的几种：
     * HTML/XML 页面。这类响应几乎必定是 apiUrl 指错后命中了网关首页或错误页，
     * 而部分网关对未知路径返回的是 200，不能靠状态码发现。</p>
     *
     * @return 错误描述；为 null 表示通过
     */
    private static String checkStreamMimeType(String contentType) {
        if (Assert.isEmpty(contentType)) {
            return null;
        }

        String mime = contentType.toLowerCase().trim();
        if (mime.startsWith("text/html") || mime.startsWith("text/xml")
                || mime.startsWith("application/xml") || mime.startsWith("application/xhtml")) {
            return "LLM stream response content-type is unexpected: " + contentType
                    + " (expect event-stream or json). Check the apiUrl config.";
        }

        return null;
    }

    /**
     * 是否形似模型帧
     *
     * <p>纯语法形状判定，不涉及方言语义：模型流的数据帧要么是 JSON，要么是
     * {@code [DONE]} 这类终止标记。SSE 的 {@code event:}/{@code id:}/注释行合法但不计入——
     * 只要整个响应体里至少有一帧形似模型帧，就不会误判。</p>
     */
    private static boolean isModelFrameShape(String data) {
        String s = data.trim();

        if (s.startsWith("data:")) {
            s = s.substring(5).trim();
        }

        if (s.isEmpty()) {
            return false;
        }

        return s.charAt(0) == '{' || s.charAt(0) == '[';
    }

    /**
     * 截断过长文本（用于错误消息，避免把整个 HTML 页面带进异常）
     */
    private static String abbreviate(String text) {
        if (text == null) {
            return null;
        }

        String s = text.trim();
        return s.length() > 200 ? s.substring(0, 200) + "..." : s;
    }

    /**
     * 非流式请求的总时长（wall-clock）守卫：发请求 + 读完整响应体作为一个整体受限。
     *
     * <p>为什么需要：socket read timeout 只约束「相邻两次字节到达的间隔」，供应商持续慢吐
     * 字节却不闭合响应时，每个字节都会重置该计时器，非流式调用可被无限延长；而非流式期间
     * 用户侧零反馈（没有增量帧可渲染），体感比流式断流更差。</p>
     *
     * <p>实现取舍：{@code exec} + {@code bodyAsString()} 是同步阻塞调用，无法从外部中断，
     * 故把这一整个阻塞单元投递到项目已有的 {@code Schedulers.boundedElastic()}（不新建线程池），
     * 调用线程只做一次带超时的 {@code Future#get}。整个单元在同一 worker 线程内完成，响应流不跨线程；
     * 该单元只依赖入参与静态工具方法，不读取任何 ThreadLocal 上下文，因此线程切换不改变原有语义。
     * 超时后 worker 上的阻塞读仍会由底座的 read timeout 自行收尾（最多一段 read 超时），
     * 但调用方已被释放，不再被无限拖住。</p>
     *
     * <p>正常（快速）请求只多一次线程投递与 future 唤醒，不受任何等待影响。</p>
     */
    private String execWithTotalCap(HttpUtils httpUtils) throws IOException {
        final Duration totalCap = resolveCallTotalTimeout(config.getTimeout());

        final CompletableFuture<String> future = new CompletableFuture<>();
        final Disposable worker = Schedulers.boundedElastic().schedule(() -> {
            try {
                future.complete(execAndReadBody(httpUtils));
            } catch (Throwable e) {
                future.completeExceptionally(e);
            }
        });

        try {
            return future.get(totalCap.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            worker.dispose();
            future.cancel(true);

            log.error("LLM call request timeout! total cap: {}s", totalCap.getSeconds());

            // 异常语义与既有超时口径一致：以 TimeoutException 作为 cause 抛出 ChatException，
            // 既能被 RetryTask 正常重试（其默认谓词放行一切非 NPE/InterruptedException 的异常），
            // 也能被 ReasonTask#handleLastException 的 `getCause() instanceof TimeoutException`
            // 分支识别为「模型服务响应超时」。
            throw new ChatException("LLM call timeout: exceeded total time cap "
                    + totalCap.getSeconds() + "s (slow-drip response). Check the upstream service.", e);
        } catch (InterruptedException e) {
            worker.dispose();
            future.cancel(true);
            Thread.currentThread().interrupt();

            // 用户取消/线程中断：保持中断语义（RetryTask 见到 InterruptedException 型 cause 即终止重试）
            InterruptedIOException ioe = new InterruptedIOException("LLM call interrupted");
            ioe.initCause(e);
            throw ioe;
        } catch (ExecutionException e) {
            // 原样还原业务异常，不改变既有失败语义（4xx/5xx、IO 异常等一律按原类型上抛）
            Throwable cause = (e.getCause() == null) ? e : e.getCause();

            if (cause instanceof IOException) {
                throw (IOException) cause;
            }
            if (cause instanceof RuntimeException) {
                throw (RuntimeException) cause;
            }
            if (cause instanceof Error) {
                throw (Error) cause;
            }

            throw new ChatException(cause);
        }
    }

    /**
     * 发起非流式请求并读完整响应体（阻塞单元，运行于 boundedElastic worker）
     */
    private static String execAndReadBody(HttpUtils httpUtils) throws IOException {
        try (HttpResponse resp = httpUtils.exec("POST")) {
            if (resp.code() >= 400) {
                // 与流式同口径：4xx/5xx 直接以「状态码 + 返回体错误消息」失败，
                // 而非把错误体当正文交给 JSON 形状守卫（那会把真实原因包装成误导性的「响应不可识别」）。
                throw LlmErrorMessages.httpErrorOf(resp);
            }
            return resp.bodyAsString();
        }
    }

    /**
     * 解析非流式总时长上限（wall-clock：从发起请求到拿到完整响应体）。
     *
     * <p>推导：{@code max(config.timeout × 3, 60s)}，再封顶 10 分钟。
     * <ul>
     *     <li><b>×3 而非 ×1</b>：config.timeout 的既有语义是「单段 socket 超时」，总时长必须
     *     宽于单段，否则推理型模型（首 token 慢 + 长答案）会被误杀；×3 给足正常请求余量。</li>
     *     <li><b>60s 下限</b>：与流式 15s 帧间下限同理，防极端短配置（如 5s）把正常请求打死。</li>
     *     <li><b>10 分钟封顶</b>：非流式期间用户看不到任何增量，可容忍的沉默时长远小于流式
     *     （流式 {@code STREAM_TOTAL_CAP} 为 30 分钟）；超过 10 分钟基本可断定链路异常。</li>
     *     <li>默认配置 120s → 360s，处于上限之内，正常请求完全不受影响。</li>
     * </ul>
     * 触发时以 {@link TimeoutException} 为 cause，交由上层按原有超时逻辑重试。
     */
    static Duration resolveCallTotalTimeout(Duration configured) {
        Duration base = (configured == null || configured.isZero() || configured.isNegative())
                ? CALL_TIMEOUT_DEFAULT : configured;

        Duration derived = base.multipliedBy(3);
        if (CALL_TOTAL_FLOOR.compareTo(derived) > 0) {
            derived = CALL_TOTAL_FLOOR;
        }

        return CALL_TOTAL_CAP.compareTo(derived) < 0 ? CALL_TOTAL_CAP : derived;
    }

    private Flux<ChatEvent> internalStream(ChatStreamSession streamSession,
                                           AtomicReference<ChatResponse> lastRespRef,
                                           AtomicReference<ChatAccumulator> currentAccRef) {
        //构建请求数据（每次请求重新构建 finalPrompt）
        ChatRequest req = new ChatRequest(config, dialect, options, session, systemMessage, originalPrompt, true);

        StreamChain chain = new StreamChain(options.interceptors(),
                r -> doStream(r, streamSession, lastRespRef, currentAccRef));

        // 弱网优化（2026-09-18）：首帧与帧间空闲拆分为两个独立预算。
        // 旧行为：两段共用 config.timeout（默认 120s）——供应商断流后前端要干等 2 分钟才有反应。
        // 拆分后：TTFT 仍用配置值（排队 + 慢网 + 推理模型首 token 慢，不宜收紧）；
        // 帧间空闲收紧到 [15s, 60s]（活跃流 chunk 间隔通常 <1s，超窗口无帧即判定断流），
        // 断流发现时间从 120s 压到 1 分钟内，交由上层 RetryTask 按原逻辑重试自愈。
        Duration ttftTimeout = config.getTimeout();
        Duration idleTimeout = resolveStreamIdleTimeout(config.getTimeout());

        return chain.doIntercept(req)
                .timeout(Mono.delay(ttftTimeout), item -> Mono.delay(idleTimeout))
                .doOnError(e -> {
                    if (e instanceof TimeoutException) {
                        log.error("LLM stream request timeout!");
                    }
                });
    }

    /**
     * 解析流式帧间空闲超时（首帧之外，相邻两帧之间的无活动上限）。
     *
     * <p>取「用户配置超时」与 60s 上限中的较小值，并设 15s 下限保护：
     * <ul>
     *     <li>默认 120s 配置 → 收紧到 60s（断流快速发现，弱网体验主要收益项）；</li>
     *     <li>用户显式配置了更短超时（如 30s）→ 尊重用户，不做放松；</li>
     *     <li>极端短配置（如 5s）→ 抬到 15s 下限，避免对合法慢流误杀。</li>
     * </ul>
     * 合法模型流极少出现 60s 无帧（SSE 心跳 / 思考增量帧会持续到达）；
     * 超过该窗口仍无帧，按断流处理并抛 {@link TimeoutException} 交由上层重试。
     */
    static Duration resolveStreamIdleTimeout(Duration configured) {
        Duration capped = STREAM_IDLE_CAP.compareTo(configured) < 0 ? STREAM_IDLE_CAP : configured;
        return STREAM_IDLE_FLOOR.compareTo(capped) > 0 ? STREAM_IDLE_FLOOR : capped;
    }

    /**
     * 创建方言解析上下文
     */
    private ChatStreamContext newContext(ChatRequest req, ChatAccumulator acc,
                                         ChatStreamSession streamSession, int step, ChatEventEmitter emitter) {
        return new ChatStreamContextDefault(config, req, acc, streamSession, step, emitter);
    }

    /**
     * 流响应
     */
    private Flux<ChatEvent> doStream(ChatRequest req, ChatStreamSession streamSession,
                                     AtomicReference<ChatResponse> lastRespRef,
                                     AtomicReference<ChatAccumulator> currentAccRef) {
        HttpUtils httpUtils = dialect.createHttpUtils(config, req.isStream());
        if(req.getOptions().httpCustomize() != null){
            req.getOptions().httpCustomize().accept(httpUtils);
        }

        String reqJson = req.toRequestData();

        if (log.isDebugEnabled()) {
            log.debug("llm-request[{}]: {}", req.getAgentAndModel(), reqJson);
        }

        return Mono.fromFuture(httpUtils.bodyOfJson(reqJson).execAsync("POST"))
                .flatMapMany(resp -> {
                    try {
                        if (resp.code() < 400) {
                            return parseResp(req, resp, streamSession, lastRespRef, currentAccRef);
                        } else {
                            // 供应商返回 4xx/5xx：从响应体提取真实错误消息。
                            // 不再用 resp.createError()——它只带状态码与 URL，返回体内容被吞掉，
                            // 用户侧只能看到"暂时无法使用模型服务"而无法定位真实原因。
                            return Flux.error(LlmErrorMessages.httpErrorOf(resp));
                        }
                    } catch (Throwable e) {
                        return Flux.error(e);
                    }
                });

    }

    private Flux<ChatEvent> parseResp(ChatRequest req, HttpResponse httpResp, ChatStreamSession streamSession,
                                      AtomicReference<ChatResponse> lastRespRef,
                                      AtomicReference<ChatAccumulator> currentAccRef) throws IOException {
        ChatAccumulator acc = new ChatAccumulator(req, true);
        String contentType = httpResp.header("Content-Type");

        //守卫一（HTTP 边界）：内容类型根本不可能是模型流，立即失败
        //典型场景：apiUrl 指错，命中网关首页/错误页，而网关以 200 + text/html 返回
        String mimeErr = checkStreamMimeType(contentType);
        if (mimeErr != null) {
            return Flux.error(new ChatException(mimeErr));
        }

        currentAccRef.set(acc);
        return Flux.<ChatEvent>create(sink -> {
            final int step = streamSession.nextStep();

            // 方言 SPI 契约（4.1 Event-first）：所有语义事件统一经 ctx.emit，先归并到累积器再投递。
            final ChatStreamContext ctx = newContext(req, acc, streamSession, step, sink::next);

            //本步收到的非空帧数，以及其中「形似模型帧」的帧数（守卫二用，见 onComplete）
            final AtomicInteger frameCount = new AtomicInteger();
            final AtomicInteger modelFrameCount = new AtomicInteger();

            sink.next(ChatEventDefault.of(ChatEventType.STEP_START)
                    .responseId(streamSession.getResponseId())
                    .step(step)
                    .build());

            Flux<?> source = (contentType != null && contentType.startsWith(MimeType.TEXT_EVENT_STREAM_VALUE))
                    ? TextStreamUtil.parseSseStream(httpResp)
                    : TextStreamUtil.parseLineStream(httpResp);

            // 用 CompositeDisposable 统一管理本轮 SSE 订阅与 tool 递归流订阅。
            // FluxSink.onDispose 只能注册一次；第二次会立刻 dispose 新订阅，
            // 导致第二次 internalStream 的 Mono.fromFuture 在 future.complete 后因 cancelled 丢弃回调。
            final Disposable.Composite resources = Disposables.composite();
            final AtomicReference<Disposable> sourceRef = new AtomicReference<>();

            Disposable sourceDisposable = source.subscribe(
                    data -> {
                        // [对接点]：检查 sink 状态，如果已经完成或取消，不再处理
                        if (sink.isCancelled() == false) {
                            try {
                                ServerSentEvent sse = (data instanceof ServerSentEvent)
                                        ? (ServerSentEvent) data : new ServerSentEvent(null, (String) data);

                                // [对接点]：利用 onEventStream 的返回值
                                if (!onEventStream(ctx, sse, sink, frameCount, modelFrameCount)) {
                                    // 返回 false 说明内部要求终止（如报错或逻辑中断）
                                    Disposable d = sourceRef.get();
                                    if (d != null) {
                                        d.dispose();
                                    }
                                }
                            } catch (Throwable e) {
                                sink.error(e);
                            }
                        }
                    },
                    sink::error,
                    () -> {
                        // 只有在没有被手动 dispose 的情况下才执行 End 逻辑
                        if (sink.isCancelled() == false) {
                            try {
                                //守卫二（响应体边界）：收到了内容，但没有一帧形似模型帧
                                //→ 响应体不是模型流，不能当成「正常的空流」静默完成
                                if (frameCount.get() == 0) {
                                    sink.error(new ChatException("LLM stream response is empty. Check the upstream service and apiUrl config."));
                                    return;
                                }
                                if (modelFrameCount.get() == 0) {
                                    sink.error(new ChatException("LLM stream response is unrecognizable:"
                                            + " no model frame in " + frameCount.get() + " frame(s)."
                                            + " Check the apiUrl and standard/provider config. last frame: "
                                            + abbreviate(acc.getFrameRaw())));
                                    return;
                                }
                                if (acc.isFinished() == false) {
                                    sink.error(new ChatException("LLM stream response ended before a completion signal."
                                            + " The response may be truncated. last frame: "
                                            + abbreviate(acc.getFrameRaw())));
                                    return;
                                }

                                onEventEnd(ctx, sink, resources, streamSession, lastRespRef, currentAccRef);
                            } catch (Throwable e) {
                                sink.error(e);
                            }
                        }
                    }
            );

            sourceRef.set(sourceDisposable);
            resources.add(sourceDisposable);
            // dispose 异步化（2026-09-18 断流死锁事故）：cancel 路径上
            // CloseTrackableBufferedReader.close() 会同步等待正卡在 socket read 的读线程
            // 释放 BufferedReader 内部锁——Flux.timeout 触发后 cancel 若同步执行 close，
            // 会死锁在锁上，TimeoutException 的 onError 永远无法传播，run 永久挂死。
            // 把资源释放挪到独立线程执行：清理本身仍保证执行（连接断开后自然完成），
            // 但锁等待不再发生在超时触发线程上，错误传播始终畅通。
            sink.onDispose(() -> Schedulers.boundedElastic().schedule(resources::dispose));
        }, FluxSink.OverflowStrategy.BUFFER);
    }

    private void onEventEnd(ChatStreamContext ctx, FluxSink<ChatEvent> sink, Disposable.Composite resources,
                            ChatStreamSession streamSession, AtomicReference<ChatResponse> lastRespRef,
                            AtomicReference<ChatAccumulator> currentAccRef) {
        ChatAccumulator acc = ctx.getAccumulator();

        // 流结束时思考仍未闭合（模型整轮只吐 reasoning，既无正文也无 tool_calls）：
        // 事件归一化器会在 STEP_END 前补 THINKING_END；这里只关闭解析状态，不再制造空分片消息。
        if (acc.in_thinking) {
            acc.in_thinking = false;
        }

        boolean memoryWritten = false;

        if (acc.getToolCallBuilders().size() > 0) {
            ToolCallOutcome outcome = buildStreamToolCallMessage(ctx, sink, resources, streamSession,
                    lastRespRef, currentAccRef);

            if (outcome == ToolCallOutcome.RECURSED) {
                return; // 进入了内部递归流处理，不执行 complete
            }

            memoryWritten = (outcome == ToolCallOutcome.COMPLETE_MEMORY_WRITTEN);
        }

        //添加到记忆（最后的聚合消息）
        if (memoryWritten == false) {
            AssistantMessage aggregationMessage = acc.snapshotTerminal().getMessage();
            if (aggregationMessage != null) {
                session.addMessage(aggregationMessage);
            }
        }

        emitStepEnd(ctx, sink, streamSession, lastRespRef);
        currentAccRef.compareAndSet(acc, null);

        sink.complete();
    }

    /**
     * 发射本步结束事件（携带本步的不可变分步聚合）
     *
     * <p>用终态形态：{@code STEP_END} 与 {@code RESPONSE_END} 的 {@code getResponse().getMessage()}
     * 直接就是完整聚合，与非流式 {@code call()} 一致。</p>
     */
    private void emitStepEnd(ChatStreamContext ctx, FluxSink<ChatEvent> sink,
                             ChatStreamSession streamSession,
                             AtomicReference<ChatResponse> lastRespRef) {
        ChatAccumulator acc = ctx.getAccumulator();
        ChatResponse stepSnapshot = acc.snapshotTerminal();

        lastRespRef.set(stepSnapshot);
        streamSession.accumulateUsage(acc.getUsage());

        sink.next(ctx.event(ChatEventType.STEP_END)
                .response(stepSnapshot)
                .usage(acc.getUsage())
                .build());
    }

    /**
     * @return 是否结束流
     */
    private boolean onEventStream(ChatStreamContext ctx, ServerSentEvent event, FluxSink<ChatEvent> sink,
                                  AtomicInteger frameCount,
                                  AtomicInteger modelFrameCount) {
        ChatAccumulator acc = ctx.getAccumulator();

        if (log.isDebugEnabled()) {
            log.debug("llm-response[{}]: {}", acc.getRequest().getAgentAndModel(), event.getData());
        }

        acc.setFrameRaw(event.getData());

        if (Assert.isEmpty(event.getData())) {
            return true;
        }

        frameCount.incrementAndGet();
        if (isModelFrameShape(event.getData())) {
            modelFrameCount.incrementAndGet();
        }

        acc.reset();

        long usageVersion = acc.getUsageVersion();
        dialect.parseResponseJson(ctx, event.getData());

        if (acc.getError() != null) {
            sink.error(acc.getError());
            return false;
        }

        // MEDIA_DONE 由方言在发现媒体时直接发射并归并；usage 与内容/媒体是正交事件。
        // 只能在方言于当前帧提交了新快照时发射，不能把跨帧累计状态当成每帧新事件。
        if (acc.getUsage() != null && acc.getUsageVersion() != usageVersion) {
            ctx.emit(ctx.event(ChatEventType.USAGE)
                    .usage(acc.getUsage())
                    .response(acc.snapshotFrame())
                    .build());
        }

        return true;
    }

    /** 将 returnDirect 合成消息中的媒体逐块发射为事件。 */
    private void emitMediaDone(ChatStreamContext ctx, List<ContentBlock> blocks) {
        if (Utils.isEmpty(blocks)) {
            return;
        }

        for (ContentBlock block : blocks) {
            if (block == null || block instanceof TextBlock) {
                continue;
            }

            ctx.emit(ctx.event(ChatEventType.MEDIA_DONE)
                    .block(block)
                    .build());
        }
    }

    /**
     * 工具调用组装的处理结果
     *
     * <p>取代原来的 {@code boolean}：它只能表达「是否继续外层收尾」，无法表达「本方法已经
     * 把工具调用消息写进记忆了」，于是关闭自动工具调用时同一条 assistant 会被写两次：
     * 下一轮带两条 {@code tool_calls} 且无对应 tool 消息，OpenAI 端点直接 400。</p>
     */
    private enum ToolCallOutcome {
        /**
         * 本方法未写入记忆的终态消息：外层正常收尾（含写入聚合消息）
         */
        COMPLETE,
        /**
         * 已进入递归流：外层不收尾
         */
        RECURSED,
        /**
         * 终态消息已由本方法写入记忆：外层收尾但不要重复写
         */
        COMPLETE_MEMORY_WRITTEN
    }

    private ToolCallOutcome buildStreamToolCallMessage(ChatStreamContext ctx, FluxSink<ChatEvent> sink,
                                                       Disposable.Composite resources, ChatStreamSession streamSession,
                                                       AtomicReference<ChatResponse> lastRespRef,
                                                       AtomicReference<ChatAccumulator> currentAccRef) {
        ChatAccumulator acc = ctx.getAccumulator();

        try {
            ONode oNode = dialect.buildAssistantToolCallMessageNode(acc, acc.getToolCallBuilders());
            List<AssistantMessage> assistantMessages = dialect.parseAssistantMessage(acc, oNode);

            // 如果没有消息，说明工具调用解析失败或没有工具需要处理，直接完成
            if (assistantMessages.isEmpty()) {
                log.debug("The tool call resolution result is empty, ending the streaming response");
                return ToolCallOutcome.COMPLETE; //触发外层的完成事件
            }

            session.addMessage(assistantMessages);

            // 一帧只产出一条聚合消息（思考+正文+工具调用同属该消息）。
            // 这里不再做“从多条里挑带工具调用的那条”的位置猜测：分词产生多条消息本身就是缺陷，
            // 会让终态聚合与工具调用载体变成两个对象。
            AssistantMessage toolCallMessage = assistantMessages.get(0);
            if (Assert.isEmpty(toolCallMessage.getToolCalls())) {
                log.debug("The tool call resolution produced no tool call message, ending the streaming response");
                return ToolCallOutcome.COMPLETE;
            }

            //参数拼接已完成：每个真实工具调用发一个完成信号（在执行之前）
            emitToolCallEnd(ctx, toolCallMessage);

            if (options.isAutoToolCall()) {
                AssistantMessage itemMessage = toolCallMessage;
                //工具执行结果对流可见。
                //注意：递归分支与 returnDirect 分支都要发，且必须在 STEP_END 之前（工具结果属于本步）
                List<ToolMessage> returnDirectMessages = buildToolMessage(acc, itemMessage,
                        (call, tm) -> ctx.emit(ctx.event(ChatEventType.TOOL_RESULT)
                                .toolCallId(tm.getToolCallId())
                                .toolCall(call)
                                .text(tm.getContent())
                                .build()));

                if (Assert.isEmpty(returnDirectMessages)) {
                    //本步结束（必须在递归产生新的 STEP_START 之前发，以保 STEP 配平）。
                    //先把组装好的完整工具调用写入终态载体，供 STEP_END 聚合消息与历史回放使用。
                    acc.reset();
                    acc.lastFinishReason = "tool";
                    acc.mergeTerminalMessage(itemMessage);

                    emitStepEnd(ctx, sink, streamSession, lastRespRef);
                    currentAccRef.compareAndSet(acc, null);

                    // 加入同一个 CompositeDisposable，避免再次 sink.onDispose 导致立即 dispose
                    Disposable disposable = internalStream(streamSession, lastRespRef, currentAccRef).subscribe(
                            sink::next,
                            sink::error,
                            sink::complete
                    );
                    resources.add(disposable);

                    return ToolCallOutcome.RECURSED; //不触发外层的完成事件
                } else {
                    //要求直接返回（转为新的响应消息）
                    AssistantMessage message = dialect.buildAssistantMessageByToolMessages(itemMessage, returnDirectMessages);

                    acc.reset();
                    acc.lastFinishReason = "tool";
                    acc.replaceTerminalMessage(message);
                    emitSyntheticMessage(ctx, message);
                    //这条 returnDirect 合成消息尚未入记忆，交由外层收尾写入
                    return ToolCallOutcome.COMPLETE;
                }
            } else {
                acc.reset();
                acc.lastFinishReason = "tool";
                acc.mergeTerminalMessage(toolCallMessage);

                // 关闭自动工具调用时，工具调用交回调用方：此处只更新聚合状态，不重复发射
                // TOOL_CALL_START / ARGS_DELTA。完成信号已由 emitToolCallEnd 发过；
                // 工具调用本身通过 STEP_END / RESPONSE_END 交付。
                //
                // 记忆已在上方 session.addMessage(assistantMessages) 写过：外层不能再写，
                // 否则历史里会出现两条同批 tool_calls 的 assistant 消息。
                return ToolCallOutcome.COMPLETE_MEMORY_WRITTEN;
            }

        } finally {
            //用完清掉
            acc.getToolCallBuilders().clear();
        }
    }

    /** 将 returnDirect 合成的最终消息投影为事件。 */
    private void emitSyntheticMessage(ChatStreamContext ctx, AssistantMessage acm) {
        emitSyntheticMessageEvents(ctx, acm);
    }

    /** 发射合成消息中的正文、思考、媒体及工具事件。 */
    private void emitSyntheticMessageEvents(ChatStreamContext ctx, AssistantMessage acm) {
        if (acm != null && Assert.isNotEmpty(acm.getToolCalls())) {
            Set<String> started = startedToolCalls(ctx);

            for (ToolCall call : acm.getToolCalls()) {
                String key = (call.getIndex() == null ? call.getId() : call.getIndex());

                if (key == null || started.add(key)) {
                    //该工具调用的首个分片：开始信号（不带快照，不进旧帧投影）
                    ctx.emit(ctx.event(ChatEventType.TOOL_CALL_START)
                            .toolCall(call)
                            .toolCallId(call.getId())
                            .build());
                }

                if (Utils.isNotEmpty(call.getArgumentsStr())) {
                    ctx.emit(ctx.event(ChatEventType.TOOL_CALL_ARGS_DELTA)
                            .toolCall(call)
                            .toolCallId(call.getId())
                            .text(call.getArgumentsStr())
                            .build());
                }
            }
        }

        // 媒体
        if (acm != null) {
            emitMediaDone(ctx, acm.getBlocks());
        }

        if (acm != null && Assert.isNotEmpty(acm.getThinkingRaw())) {
            ctx.emit(ctx.event(ChatEventType.THINKING_DELTA)
                    .text(acm.getThinkingRaw())
                    .build());
        }
        if (acm != null && Assert.isNotEmpty(acm.getTextRaw())) {
            ctx.emit(ctx.event(ChatEventType.TEXT_DELTA)
                    .text(acm.getTextRaw())
                    .build());
        }
    }

    @SuppressWarnings("unchecked")
    private Set<String> startedToolCalls(ChatStreamContext ctx) {
        return (Set<String>) ctx.attrIfAbsent("__startedToolCalls", k -> new LinkedHashSet<String>());
    }

    /**
     * 参数拼接完成：每个真实工具调用发一个完成事件
     *
     * <p>不携带快照：完成信号是事件模型新增的表达，不对应旧帧。</p>
     */
    private void emitToolCallEnd(ChatStreamContext ctx, AssistantMessage acm) {
        if (acm == null || Assert.isEmpty(acm.getToolCalls())) {
            return;
        }

        for (ToolCall call : acm.getToolCalls()) {
            ctx.emit(ctx.event(ChatEventType.TOOL_CALL_END)
                    .toolCall(call)
                    .toolCallId(call.getId())
                    .text(call.getArgumentsStr())
                    .build());
        }
    }

    /**
     * @return returnDirect
     */
    private List<ToolMessage> buildToolMessage(ChatAccumulator acc, AssistantMessage acm) throws ChatException {
        return buildToolMessage(acc, acm, null);
    }

    /**
     * 执行工具调用并构建工具消息
     *
     * @param observer 每个工具执行完成后的观察者（流式路径用于发射 TOOL_RESULT 事件；非流式传 null）
     * @return returnDirect
     */
    private List<ToolMessage> buildToolMessage(ChatAccumulator acc, AssistantMessage acm,
                                               BiConsumer<ToolCall, ToolMessage> observer) throws ChatException {
        if (Assert.isEmpty(acm.getToolCalls())) {
            return null;
        }

        List<ToolMessage> toolMessages = new ArrayList<>();
        for (ToolCall call : acm.getToolCalls()) {
            FunctionTool tool = options.tool(call.getName());

            if (tool != null) {
                try {
                    ToolResult toolResult = doToolCall(acc, tool, call.getArguments());
                    ToolMessage toolMessage = ChatMessage.ofTool(toolResult, call.getName(), call.getId(), tool.returnDirect());
                    toolMessage.addMetadata(tool.meta());
                    toolMessage.addMetadata("__tool", tool.name());

                    session.addMessage(toolMessage);
                    toolMessages.add(toolMessage);

                    if (observer != null) {
                        observer.accept(call, toolMessage);
                    }
                } catch (Throwable ex) {
                    throw new ToolCallException("The tool call failed, name: '" + tool + "'", ex);
                }
            } else {
                throw new ToolCallException("Tool call not found: '" + call.getName() + "'");
            }
        }

        if (toolMessages.size() > 0 && toolMessages.stream().filter(m -> m.isReturnDirect() == false).count() == 0) {
            //说明全部要求直接返回
            return toolMessages;
        } else {
            return null;
        }
    }

    /**
     * 执行工具调用（支持拦截器）
     */
    private ToolResult doToolCall(ChatAccumulator acc, FunctionTool func, Map<String, Object> args) throws Throwable {
        //收集拦截器
        ToolRequest req = new ToolRequest(acc.getRequest(), options.toolContext(), args);

        //构建请求数据
        ToolChain chain = new ToolChain(options.interceptors(), func);

        return chain.doIntercept(req);
    }
}
