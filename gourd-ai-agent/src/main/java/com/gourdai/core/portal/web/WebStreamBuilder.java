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

import com.gourdai.agent.event.AgentEvent;

import com.gourdai.agent.AgentSession;
import com.gourdai.harness.agent.*;
import com.gourdai.agent.react.ReActAgent;
import com.gourdai.agent.event.RunEndEvent;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.intercept.HITL;
import com.gourdai.agent.react.intercept.HITLTask;
import com.gourdai.agent.react.intercept.ContextCompressionInterceptor;
import com.gourdai.agent.event.ToolCallStartEvent;
import com.gourdai.agent.event.ToolCallEndEvent;
import com.gourdai.agent.event.ToolCallDraftEvent;
import com.gourdai.agent.event.ToolCallArgsDeltaEvent;
import com.gourdai.agent.event.ReasonDeltaEvent;
import com.gourdai.agent.react.task.ReasonTask;
import com.gourdai.agent.event.ReasonEndEvent;
import com.gourdai.agent.trace.UsageNormalizer;
import com.gourdai.agent.util.AgentUtil;
import org.noear.solon.ai.chat.ChatModel;
import org.noear.solon.ai.chat.prompt.Prompt;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.talents.cli.TerminalTalent;
import com.gourdai.harness.talents.cli.TodoTalent;
import com.gourdai.harness.agent.WebToolVisibilityPolicy;
import com.gourdai.core.channel.Channel;
import com.gourdai.core.channel.wechat.WeChatLink;
import org.noear.solon.core.util.Assert;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.time.Duration;
import java.util.*;

/**
 * Web 流式响应构建器
 *
 * <p><b>职责说明：</b>将 ReAct Agent 的流式输出（chunk）逐条映射为 {@link WebChunk}，
 * 构建可在 Web 端消费的响应式数据流（{@link reactor.core.publisher.Flux}）。</p>
 *
 * <p><b>核心机制：</b>
 * <ul>
 *   <li>基于 ReAct 流式事件类型分发：ReasonDeltaEvent → 思维链/文本输出；
 *       ReasonEndEvent → 思考轮次输出 + IM 通道同步转发；
 *       ToolCallEndEvent → 工具调用结果；
 *       RunEndEvent → 最终汇总（含异常）。</li>
 *   <li>IM 通道同步转发：在处理 ReasonEndEvent 和 RunEndEvent 时，将内容同步推送到
 *       所有已绑定的 IM 通道（微信、飞书、钉钉等），实现 Web 端与 IM 端双路输出。</li>
 *   <li>HITL（人机交互循环）支持：流结束后自动检测挂起的人工审批任务，
 *       如有则生成对应的 HITL WebChunk 以暂停流等待人工确认。</li>
 *   <li>相位状态机：为每个下发帧标注 {@code phase}（见 {@link WebChunk} 的 {@code PHASE_*} 常量），
 *       使前端能按引擎真实生命周期显示等待指示器，而不必靠「静默超时」猜测。</li>
 * </ul></p>
 *
 * <p><b>架构位置：</b>位于 portal/web 层，是 Agent 后端与 Web 前端之间的流式适配器；
 * 上游对接 {@link ReActAgent} 的 stream 输出，
 * 下游输出面向 Web SSE / WebSocket 的 {@link WebChunk} 序列。</p>
 *
 * @author oisin
 */
public class WebStreamBuilder {
    private static final Logger LOG = LoggerFactory.getLogger(WebStreamBuilder.class);

    /**
     * 任务执行引擎，用于判断当前引擎名称与 chunk 中代理名称的归属关系
     */
    private final HarnessEngine engine;

    /**
     * WebSocket 网关引用，供 SteerInterceptor 拉取/消费插话邮箱
     */
    private final WebGate webGate;

    /**
     * IM 通道路由表：所有注册的 IM 通道（微信、飞书、钉钉等）
     */
    private final List<Channel> imLinks = new ArrayList<>();

    /**
     * 注册 IM 通道（向后兼容：支持 WeChatLink 直接注册）
     */
    public WebStreamBuilder bind(WeChatLink weChatLink) {
        this.imLinks.add(weChatLink);
        return this;
    }

    /**
     * 注册 IM 通道（通用接口）
     */
    public WebStreamBuilder bind(Channel link) {
        this.imLinks.add(link);
        return this;
    }

    /**
     * 获取微信通道（向后兼容）
     */
    public WeChatLink getWeChatLink() {
        for (Channel link : imLinks) {
            if (link instanceof WeChatLink) {
                return (WeChatLink) link;
            }
        }
        return null;
    }

    /**
     * 清理所有通道中指定会话的绑定（会话删除时调用）
     */
    public void cleanupSession(String sessionId) {
        for (Channel link : imLinks) {
            if (link.getBoundSessionIds().contains(sessionId)) {
                link.unbindSession(sessionId);
            }
        }
    }

    /**
     * 构造函数（向后兼容，不含插话支持）
     *
     * @param engine 任务执行引擎实例
     */
    public WebStreamBuilder(HarnessEngine engine) {
        this.engine = engine;
        this.webGate = null;
    }

    /**
     * 构造函数（含插话支持）
     *
     * @param engine   任务执行引擎实例
     * @param webGate  WebSocket 网关，供 SteerInterceptor 消费插话邮箱
     */
    public WebStreamBuilder(HarnessEngine engine, WebGate webGate) {
        this.engine = engine;
        this.webGate = webGate;
    }

    /**
     * 构建流式响应管线
     *
     * <p>核心流程：
     * <ol>
     *   <li>处理 prompt（null兜底、/resume重置）并记录当前选择的 Agent</li>
     *   <li>调用 {@link ReActAgent # stream()} 获取 ReAct 流式输出</li>
     *   <li>按事件类型分发到对应的处理方法（onReasonDeltaEvent / onReasonEndEvent / onToolCallEndEvent / onRunEndEvent）</li>
     *   <li>过滤空 chunk、捕获异常并生成错误 WebChunk</li>
     *   <li>流结束后检测 HITL 状态，如有挂起的人工审批任务则追加 HITL WebChunk</li>
     * </ol></p>
     *
     * @param session    Agent 会话，承载会话状态、属性及 HITL 上下文
     * @param agent      ReAct Agent 实例，提供流式推理能力
     * @param chatModel  聊天模型，用于配置 Agent 的底层模型调用
     * @param sessionCwd 当前会话的工作目录，作为工具上下文注入
     * @param prompt     用户提示词；为 null 时使用空提示，为 "/resume" 时重置为空提示
     * @return 映射后的 {@link WebChunk} 响应式流
     */
    public Flux<WebChunk> buildStreamFlux(AgentSession session, ReActAgent agent, ChatModel chatModel, String sessionCwd, Prompt prompt) {
        return buildStreamFlux(session, agent, chatModel, sessionCwd, prompt, null);
    }

    /**
     * 构建流式响应管线（带思考深度覆盖）。
     *
     * @param thinkingDepthOverride 本轮任务专用的思考深度档位；为 null 时回退会话上下文中的选择。
     *                              用于 Loop 定时任务等「按任务而非按会话」指定档位的场景，
     *                              不写入会话上下文，避免污染用户在前台的选择。
     */
    public Flux<WebChunk> buildStreamFlux(AgentSession session, ReActAgent agent, ChatModel chatModel, String sessionCwd, Prompt prompt,
                                          String thinkingDepthOverride) {
        if (prompt == null) {
            prompt = Prompt.of();
        }

        if ("/resume".equals(prompt.getUserContent())) {
            prompt = Prompt.of();
        }

        //记录最新的选择
        session.attrs().put("_agent_selected_tmp", agent.name());

        // 本轮任务的起始时刻。不能用 trace.getBeginTimeMs()：trace 在会话内跨轮复用，
        // 「继续/恢复」时不会重置，其 beginTimeMs 停留在最初任务起点，导致耗时累计成整段对话时长。
        // 每次 buildStreamFlux 恰对应一轮任务，用 Flux.defer 在订阅时刻取时，才是「单轮耗时」。
        final Prompt promptFinal = prompt;
        return Flux.defer(() ->
                buildTurnFlux(session, agent, chatModel, sessionCwd, promptFinal, System.currentTimeMillis(), thinkingDepthOverride));
    }

    private Flux<WebChunk> buildTurnFlux(AgentSession session, ReActAgent agent, ChatModel chatModel, String sessionCwd, Prompt prompt, long turnStartMs,
                                         String thinkingDepthOverride) {
        // 思考深度：优先用本轮显式指定的档位（如 Loop 任务），否则回退会话选择的档位；
        // 再结合当前模型的推理能力（按模型而非按接口）翻译成各家 API 各自的参数
        String thinkingDepth = thinkingDepthOverride != null
                ? ThinkingDepth.normalize(thinkingDepthOverride)
                : ThinkingDepth.normalize(session.getContext().getAs(HarnessEngine.CTX_THINKING_DEPTH));

        // 本轮（turn）相位状态机。per-turn 局部持有：buildTurnFlux 每次订阅（Flux.defer）都会重建，
        // 因此「继续/恢复」的新一轮不会继承上一轮的相位。
        // 用单元素数组做可变持有者，因为 lambda 内无法改写外部局部变量。
        final String[] phase = {WebChunk.PHASE_WAITING};
        // 每个 buildTurnFlux 对应一轮用户请求，但一个 ReAct run 可包含多次「思考→工具」循环。
        // 用轮次级标记判断 ReasonEnd 是否需要补发聚合思考，避免「没有 thinking delta 时思考
        // 消失」与「已有 delta 时聚合全文重复」二者择一。

        final boolean[] thinkingDeltaSinceEnd = {false};

        return agent.prompt(prompt)
                .session(session)
                .options(o -> {
                    o.chatModel(chatModel);

                    // 每次请求读取实时配置，使通用设置的修改即时生效（无需重启/重建 Agent）
                    o.retryConfig(engine.getModelRetries());
                    o.maxTurns(engine.getMaxTurns());
                    o.sessionWindowSize(engine.getSessionWindowSize());

                    // 思考深度按模型推理能力注入（AUTO/切换档位/模型不支持时会清理旧键，保证幂等）
                    ThinkingDepth.applyTo(o, chatModel, thinkingDepth);

                    // 把本轮生效的档位经 toolContext 透传给工具链。Loop 定时任务的 thinkingDepthOverride
                    // 刻意不写入会话上下文（避免污染用户前台选择），若不透传，TaskTalent 只能读到会话级
                    // 旧值，于是主代理用 override（如 high）、子代理读到 null→OFF 而静默降档。
                    o.toolContextPut(HarnessEngine.ATTR_THINKING_DEPTH, thinkingDepth);

                    // TerminalTalent 在 cwd 为空时本就回退 engine workspace；显式注入可让文件变更账本
                    // 与工具使用完全相同的规范根，并覆盖 Web 主 Agent 的全局会话。
                    //
                    // 注：Web 路径下 WebGate 传进来的 sessionCwd 已经是它自己 resolveChangeRoot() 的结果
                    // （sessionCwd > 会话已登记所属根 > workspace），与它随后调 FileChangeService.finish()
                    // 用的根是同一个值。ActionTask 写账本用的正是这里注入的 ATTR_CWD，于是
                    // 「写账本的根 == 收口的根 == 前端读取的根」三方强制一致。
                    // 下面的 workspace 兜底仍保留：其它调用方（不经过 WebGate 的路径）可能传空 cwd。
                    String effectiveCwd = Assert.isNotEmpty(sessionCwd) ? sessionCwd : engine.getWorkspace();
                    o.toolContextPut(HarnessEngine.ATTR_CWD, effectiveCwd);
                    if (webGate != null) {
                        o.interceptorAdd(new SteerInterceptor(webGate));
                    }
                })
                .stream()
                // 用 concatMapIterable 而非 map：一个引擎事件可能对应<b>多帧</b> WebChunk。
                // WebChunk 是「一帧一载荷」，而 ReasonEndEvent 的 getThinking() 与 getText() 是两份
                // 独立载荷——子代理那一轮既需补发思考又需兜底正文时，必须下发两帧。旧的 map 只能
                // 二选一，先 return 思考帧就把正文帧（以及紧随其后的 IM 转发副作用）整个吞掉。
                .concatMapIterable(chunk -> {
                    // 先算出「若本帧真的下发，引擎将处于什么相位」；只有非 EMPTY 帧才提交推进，
                    // 否则被过滤掉的内部工具帧（task/multitask/memory/todowrite-start）会把相位
                    // 误推进成 tool，让前端在根本没有工具卡的时刻显示「执行中」。
                    String candidatePhase = nextPhase(chunk, phase[0]);

                    List<WebChunk> out = new ArrayList<>(2);
                    for (WebChunk webChunk : mapEvent(session, chatModel, chunk, turnStartMs, thinkingDeltaSinceEnd[0])) {
                        if (webChunk == null || webChunk == WebChunk.EMPTY) {
                            continue;
                        }
                        webChunk.setRunId(chunk.getRunId());
                        // 同一事件拆出的多帧共享同一相位，重复赋值幂等
                        phase[0] = candidatePhase;
                        webChunk.setPhase(candidatePhase);
                        out.add(webChunk);
                    }
                    if (chunk instanceof ReasonDeltaEvent) {
                        ReasonDeltaEvent delta = (ReasonDeltaEvent) chunk;
                        if (delta.isThinking() && !delta.isToolCalls() && delta.hasContent()) {
                            thinkingDeltaSinceEnd[0] = true;
                        }
                    } else if (chunk instanceof ReasonEndEvent) {
                        // ReasonEndEvent 已完成当前轮次；下一轮重新等待 thinking delta。
                        thinkingDeltaSinceEnd[0] = false;
                    }
                    return out;
                })
                .filter(WebChunk::isNotEmpty)
                .onErrorResume(e -> {
                    LOG.error("Task fail: {}", e.getMessage(), e);

                    // 异常即本轮终止：相位推到 done，让前端停止一切等待指示器
                    WebChunk errChunk = WebChunk.ofError(e);
                    errChunk.setPhase(WebChunk.PHASE_DONE);
                    return Mono.just(errChunk);
                })
                .concatWith(Flux.defer(() -> {
                    // Check HITL state after stream completes
                    if (HITL.isHitl(session)) {
                        HITLTask task = HITL.getPendingTask(session);
                        if (task != null) {
                            String command = "bash".equals(task.getToolName())
                                    ? String.valueOf(task.getArgs().get("command"))
                                    : null;

                            WebChunk hitlChunk = WebChunk.ofHitl(task.getToolName(), command, task.getActionId());
                            hitlChunk.setPhase(WebChunk.PHASE_HITL);

                            WebChunk doneChunk = WebChunk.ofDone();
                            doneChunk.setPhase(WebChunk.PHASE_DONE);

                            return Flux.just(hitlChunk, doneChunk);
                        }
                    }

                    WebChunk doneChunk = WebChunk.ofDone();
                    doneChunk.setPhase(WebChunk.PHASE_DONE);
                    return Flux.just(doneChunk);
                }));
    }

    /**
     * 引擎事件 → WebChunk 帧的分发。
     *
     * <p>返回 0..N 帧（空列表 = 本事件不上送前端）。之所以不是 1:1，是因为
     * {@link ReasonEndEvent} 的 {@code getThinking()} 与 {@code getText()} 是两份独立载荷，
     * 子代理兜底时可能两份都要下发，而一个 WebChunk 只能承载一份。</p>
     *
     * <p>链尾的 debug 日志是刷意的：未映射的事件类型若直接静默丢弃，会让「有意不上送」与
     * 「新增事件忘了处理」在现象上完全一样（都是前端什么都不变），排查时无法区分。</p>
     *
     * @param session     Agent 会话
     * @param chatModel   当前模型（供上下文指示器取窗口大小）
     * @param chunk       引擎事件
     * @param turnStartMs 本轮任务订阅时刻（毫秒）
     * @return 待下发的帧列表，可能为空
     */
    private List<WebChunk> mapEvent(AgentSession session, ChatModel chatModel, AgentEvent chunk, long turnStartMs,
                                    boolean thinkingDeltaSinceEnd) {
        if (chunk instanceof ContextUsageEvent) {
            // 子代理的用量不刷全局上下文指示器：其 token 来自子代理模型，而指示器分母
            // 用的是主模型 contextLength（两者窗口可不同），且会覆盖主代理指标并随会话快照长期留存。
            if (chunk.getMeta().containsKey("__parentAgentName")) {
                return Collections.emptyList();
            }
            return oneFrame(onContextUsageEvent(chatModel, (ContextUsageEvent) chunk));
        }
        if (chunk instanceof ReasonDeltaEvent) {
            return oneFrame(onReasonDeltaEvent((ReasonDeltaEvent) chunk));
        }
        if (chunk instanceof ReasonEndEvent) {
            return onReasonEndEvent(session, (ReasonEndEvent) chunk, thinkingDeltaSinceEnd);
        }
        if (chunk instanceof ToolCallStartEvent) {
            return oneFrame(onToolCallStartEvent((ToolCallStartEvent) chunk));
        }
        if (chunk instanceof ToolCallDraftEvent) {
            return oneFrame(onToolCallDraftEvent((ToolCallDraftEvent) chunk));
        }
        if (chunk instanceof ToolCallArgsDeltaEvent) {
            return oneFrame(onToolCallArgsDeltaEvent((ToolCallArgsDeltaEvent) chunk));
        }
        if (chunk instanceof ToolCallEndEvent) {
            return oneFrame(onToolCallEndEvent((ToolCallEndEvent) chunk));
        }
        if (chunk instanceof RetryEvent) {
            return oneFrame(WebChunk.ofRetry(((RetryEvent) chunk).getAttempt(), ((RetryEvent) chunk).getMaxRetries()));
        }
        if (chunk instanceof AgentStartEvent) {
            return oneFrame(onAgentStartEvent((AgentStartEvent) chunk));
        }
        if (chunk instanceof AgentEndEvent) {
            return oneFrame(onAgentEndEvent((AgentEndEvent) chunk));
        }
        if (chunk instanceof RunEndEvent) {
            return oneFrame(onRunEndEvent(session, (RunEndEvent) chunk, turnStartMs));
        }

        // 以下事件<b>有意</b>不映射、不上送前端：
        //   · ContextSizeEvent：推理前 jtokkit 本地估算，仅供框架内部做压缩决策；
        //     上下文指示器只认推理后真实用量的 ContextUsageEvent。
        //   · PlanEvent / NodeEvent / SupervisorDeltaEvent / TeamEndEvent：团队代理体系事件，
        //     Web 端当前未渲染对应 UI（PlanEvent 的 CREATE/PROGRESS/REVISE 三种语义也未下发）。
        //   · SimpleDeltaEvent / SimpleEndEvent：Simple（非 ReAct）代理事件，同上。
        if (LOG.isDebugEnabled()) {
            LOG.debug("事件未映射为 WebChunk，已丢弃: {}", chunk.getClass().getSimpleName());
        }
        return Collections.emptyList();
    }

    /** 包一帧；空帧归一为空列表，使调用方不必再判 EMPTY。 */
    private static List<WebChunk> oneFrame(WebChunk chunk) {
        return (chunk == null || chunk == WebChunk.EMPTY)
                ? Collections.<WebChunk>emptyList()
                : Collections.singletonList(chunk);
    }

    /**
     * 相位状态机：根据事件类型推导「该事件对应的帧下发后，引擎处于什么相位」。
     *
     * <p>返回值仅在调用方确认该帧非 {@link WebChunk#EMPTY}（即真的会下发）时才被提交，
     * 因此被过滤的内部工具帧不会污染相位。</p>
     *
     * <p>不改变相位的事件（返回 {@code current}）：
     * {@code ContextUsageEvent}（元数据）、{@code AgentStartEvent}/{@code AgentEndEvent}
     * （子代理活动，主气泡指示器此时本就被 agentStates 守卫抑制）、{@code ContextSizeEvent}（内部估算）。</p>
     *
     * @param event   引擎事件
     * @param current 当前相位
     * @return 推进后的相位；无变化时原样返回 {@code current}
     */
    private static String nextPhase(AgentEvent event, String current) {
        if (event instanceof ReasonDeltaEvent) {
            ReasonDeltaEvent delta = (ReasonDeltaEvent) event;
            // 与 onReasonDeltaEvent 的下发条件严格一致：只有真正产出内容的增量才代表相位
            if (!delta.isToolCalls() && delta.hasContent()) {
                return (delta.getMessage() != null && delta.getMessage().isThinking())
                        ? WebChunk.PHASE_THINKING
                        : WebChunk.PHASE_TEXT;
            }
            return current;
        }
        if (event instanceof ReasonEndEvent) {
            // 思考轮次结束：接下来要么派发工具、要么进入最终汇总，此刻引擎在「等模型继续」
            return WebChunk.PHASE_WAITING;
        }
        if (event instanceof ToolCallStartEvent) {
            return WebChunk.PHASE_TOOL;
        }
        // 参数生成期已经在「弄工具」了：相位推到 tool，底部指示器随之让位（前端对 PHASE_TOOL 短路），
        // 指示语义改由骨架卡承担。修复了旧行为：工具参数吐到一半时相位却停在 PHASE_TEXT，
        // 底部持续显示「输出中」而屏幕零增长。
        if (event instanceof ToolCallDraftEvent || event instanceof ToolCallArgsDeltaEvent) {
            return WebChunk.PHASE_TOOL;
        }
        if (event instanceof ToolCallEndEvent) {
            // 工具结束（含失败）：回到等待模型继续
            return WebChunk.PHASE_WAITING;
        }
        if (event instanceof RetryEvent) {
            return WebChunk.PHASE_RETRY;
        }
        if (event instanceof RunEndEvent) {
            return WebChunk.PHASE_DONE;
        }
        return current;
    }

    /**
     * 工具显示名：本引擎工具用裸名，子代理工具加 {@code agentName/} 前缀。
     * <p>start / end / failure 三条路径共用，避免口径漂移导致前端配不上卡片。</p>
     */
    private String resolveToolTitle(String agentName, String toolName) {
        return engine.getName().equals(agentName) ? toolName : agentName + "/" + toolName;
    }

    /**
     * 工具执行失败时构造带 {@code failed} 标记的 action_end。
     *
     * <p><b>为什么必须有这一帧：</b>旧实现在 {@code getError() != null} 时直接返回
     * {@link WebChunk#EMPTY}，把失败帧整个吞掉。而 {@code action_start} 已经建出了 loading
     * 卡片，它永远等不到配对的结束帧 —— 卡片上的状态点<b>永久闪烁</b>、计时器永久累加，
     * 直到整流结束才被 finishStream 兜底标黄（批量卡甚至会被误判）。</p>
     *
     * <p>todowrite 例外：它的开始帧本就不建卡（走专用面板通道），失败时若下发 action_end，
     * 前端 todo 面板会把错误文案当作 todos 解析，故维持不下发（与旧行为一致，无回归）。</p>
     */
    private WebChunk onToolFailure(ToolCallEndEvent chunk) {
        if (!WebToolVisibilityPolicy.isFailedEndVisible(chunk.getToolName())) {
            return WebChunk.EMPTY;
        }
        Throwable error = chunk.getError();
        String errText = error.getMessage();
        if (Assert.isEmpty(errText)) {
            errText = error.getClass().getSimpleName();
        }

        WebChunk webChunk = WebChunk.ofActionEnd(errText, chunk.getDurationMs());
        webChunk.setFailed(true);
        projectToolCommon(chunk, webChunk);
        return webChunk;
    }


    /**
     * 处理上下文用量块（推理后依据模型真实 usage 生成，含缓存创建/读取明细）。
     * <p>据此刷新「上下文长度」指示器，展示真实输入/输出/缓存。
     * 注：推理前 jtokkit 估算的 {@code ContextSizeEvent} 不在此处理，仅供框架内部做压缩决策。
     */
    public WebChunk onContextUsageEvent(ChatModel chatModel, ContextUsageEvent event){
        long inputTokens = event.getInputTokens();
        long outputTokens = event.getOutputTokens();

        WebChunk wc = new WebChunk();
        wc.setType("context_size");
        wc.setSessionId(event.getSession().getSessionId());
        // 当前上下文占用 ≈ 本轮输入(含缓存) + 本轮输出（输出会并入下一轮历史）
        wc.setTotalTokens(inputTokens + outputTokens);
        wc.setInputTokens(inputTokens);
        wc.setOutputTokens(outputTokens);
        wc.setCacheCreationTokens(event.getCacheCreationTokens());
        wc.setCacheReadTokens(event.getCacheReadTokens());
        wc.setCacheRate(event.getCacheRate());
        wc.setText(String.valueOf(event.getMessageCount()));

        long contextLength = chatModel != null && chatModel.getConfig() != null
                ? chatModel.getConfig().getContextLength() : 0;
        if(contextLength == 0){
            contextLength = engine.getEffectiveCompressionDefaultContextLength(); // 与实际压缩回退值一致
        }

        Map<String, Object> args = new HashMap<>();
        args.put("contextLength", contextLength);
        wc.setArgs(args);
        wc.setCreatedAt(java.time.Instant.now().toEpochMilli());
        return wc;
    }

    /**
     * 处理推理阶段的 chunk
     *
     * <p>在非工具调用且存在内容时，根据消息是否处于 thinking 状态分别映射为：
     * <ul>
     *   <li>thinking 状态 → {@link WebChunk#ofReason(String)} 思维链输出（供前端折叠展示推理过程）</li>
     *   <li>非 thinking → {@link WebChunk#ofText(String)} 常规文本输出</li>
     * </ul>
     * 否则返回空 chunk。</p>
     *
     * @param event 推理阶段的增量事件
     * @return 映射后的 WebChunk，或 {@link WebChunk#EMPTY}
     */
    private WebChunk onReasonDeltaEvent(ReasonDeltaEvent event) {
        if (!event.isToolCalls() && event.hasContent()) {
            WebChunk webChunk = event.getMessage().isThinking()
                    ? WebChunk.ofReason(event.getContent())
                    : WebChunk.ofText(event.getContent());

            // 子代理产生的思考/正文：透传父智能体归属信息，供前端路由到对应智能体卡片内渲染
            if (event.hasMeta("__parentAgentName")) {
                Map<String, Object> args = new LinkedHashMap<>();
                args.put("agentName", event.getMeta().get("__parentAgentName"));
                args.put("agentDesc", event.getMeta().get("__parentAgentDesc"));
                copyInvocationId(event, args);
                webChunk.setArgs(args);
            }

            return webChunk;
        }

        return WebChunk.EMPTY;
    }


    /**
     * 处理工具调用开始阶段的 chunk（来源引擎 ToolCallStartEvent）
     *
     * <p>在工具实际执行前发送 action_start，让前端提前渲染 loading 状态的工具卡片骨架，
     * 待后续 {@link #onToolCallEndEvent} 的结果到达时复用同一卡片填充并转完成态。
     * 过滤规则与 {@link #onToolCallEndEvent} 保持一致，避免建卡后无对应结果填充。</p>
     *
     * @param event 工具调用开始事件
     * @return 映射后的 WebChunk（含工具名与参数），或 {@link WebChunk#EMPTY}（内部工具或无名称时）
     */
    private WebChunk onToolCallStartEvent(ToolCallStartEvent event) {
        if (!WebToolVisibilityPolicy.isStartVisible(event.getToolName())) {
            return WebChunk.EMPTY;
        }

        // 公共方法负责唯一一次参数复制；edit 转换直接作用于最终写入 chunk 的参数。
        WebChunk startChunk = WebChunk.ofActionStart(event.getToolName(),
                resolveToolTitle(event.getAgentName(), event.getToolName()), null);
        projectToolCommon(event, startChunk);
        fillEditDiff(startChunk.getArgs());
        return startChunk;
    }


    /**
     * 处理工具调用草稿事件（模型刚确定函数名、参数尚在生成）。
     *
     * <p>过滤规则必须与 {@link #onToolCallStartEvent} 严格一致（同用
     * {@code isStartVisible}）：否则会给内部工具建出骨架卡，而它永远等不到
     * 配对的 action_start / action_end。</p>
     */
    private WebChunk onToolCallDraftEvent(ToolCallDraftEvent event) {
        if (!WebToolVisibilityPolicy.isStartVisible(event.getToolName())) {
            return WebChunk.EMPTY;
        }

        WebChunk draftChunk = WebChunk.ofActionDraft();
        projectToolCommon(event, draftChunk);
        return draftChunk;
    }

    /**
     * 处理工具参数生成进度事件。过滤规则同 {@link #onToolCallDraftEvent}。
     */
    private WebChunk onToolCallArgsDeltaEvent(ToolCallArgsDeltaEvent event) {
        if (!WebToolVisibilityPolicy.isStartVisible(event.getToolName())) {
            return WebChunk.EMPTY;
        }

        WebChunk argsChunk = WebChunk.ofActionArgs(event.getArgsBytes());
        projectToolCommon(event, argsChunk);
        return argsChunk;
    }


    /**
     * 处理工具调用结束事件（ToolCallEndEvent）
     *
     * <p>过滤掉内部工具（多任务调度 task/multitask、记忆工具）后，
     * 将工具调用结果包装为 {@link WebChunk}，并附带工具名称、参数与真实耗时：
     * <ul>
     *   <li>工具名称：若属于当前引擎则使用短名，否则使用 {@code agentName/toolName} 全路径</li>
     *   <li>特殊处理 {@code todowrite} 工具：将 todos 参数内容设为文本</li>
     *   <li>失败时（{@code getError() != null}）走 {@link #onToolFailure}，不再吞帧</li>
     * </ul></p>
     *
     * @param chunk 工具调用结束事件
     * @return 映射后的 WebChunk（含工具信息），或 {@link WebChunk#EMPTY}（内部工具或无名称时）
     */
    private WebChunk onToolCallEndEvent(ToolCallEndEvent chunk) {
        // R1 修复：工具执行失败不再吞帧。旧实现直接 return EMPTY，而 action_start 已建出
        // loading 卡片，它永远等不到配对的结束帧 —— 卡片状态点永久闪烁、计时器永久累加。
        if (chunk.getError() != null) {
            return onToolFailure(chunk);
        }

        // todowrite 完成时，前端通过 action_end 的 toolName='todowrite' 自动刷新任务面板

        if (WebToolVisibilityPolicy.isBaseVisible(chunk.getToolName())) {
            // durationMs 取自引擎真实耗时，使前端工具卡能展示实际执行时长而非自增计时
            WebChunk webChunk = WebChunk.ofActionEnd(chunk.getContent(), chunk.getDurationMs());
            projectToolCommon(chunk, webChunk);

            if (Assert.isNotEmpty(chunk.getToolName())) {
                if (TodoTalent.TOOL_TODOWRITE.equals(chunk.getToolName())) {
                    String todos = AgentUtil.asStringArg(chunk.getArgs(), TodoTalent.PARAM_TODOS);

                    if (Assert.isNotEmpty(todos)) {
                        webChunk.setText(todos);
                        webChunk.getArgs().remove(TodoTalent.PARAM_TODOS);
                    }
                }

                if (TerminalTalent.TOOL_WRITE.equals(chunk.getToolName())) {
                    String content = AgentUtil.asStringArg(chunk.getArgs(), TerminalTalent.PARAM_CONTENT);

                    if (Assert.isNotEmpty(content)) {
                        webChunk.setText(content);
                        webChunk.getArgs().remove(TerminalTalent.PARAM_CONTENT);
                    }
                }

                // edit：入参为结构化 edits 列表（无 diff 字段），在此由结构化参数重建 git diff 文本写入 args.diff，
                // text 保留工具真实返回（成功提示/错误信息）作为「输出」，由前端 edit 渲染器两段式展示。
                fillEditDiff(webChunk.getArgs());
            }

            return webChunk;
        }

        return WebChunk.EMPTY;
    }

    /**
     * 统一投影工具帧的公共字段。调用方先创建带有帧特有 type/text/duration 的 chunk，
     * 本方法再覆盖工具标识、复制参数、批次元数据及子代理路由字段。
     */
    void projectToolCommon(com.gourdai.agent.event.AbsToolCallEvent source, WebChunk target) {
        projectToolCommon(source, target, engine.getName(), source.getAgentName());
    }

    static void projectToolCommon(com.gourdai.agent.event.AbsToolCallEvent source, WebChunk target,
                                  String mainAgentName, String toolAgentName) {
        target.setToolName(source.getToolName());
        target.setToolTitle(Objects.equals(mainAgentName, toolAgentName)
                ? source.getToolName() : toolAgentName + "/" + source.getToolName());
        target.setArgs(source.getArgs() == null
                ? new LinkedHashMap<>() : new LinkedHashMap<>(source.getArgs()));
        copyActionMetadata(source, target);
        if (source.hasMeta("__parentAgentName")) {
            target.getArgs().put("agentName", source.getMeta().get("__parentAgentName"));
            target.getArgs().put("agentDesc", source.getMeta().get("__parentAgentDesc"));
            copyInvocationId(source, target.getArgs());
        }
    }

    static void copyActionMetadata(com.gourdai.agent.event.AbsToolCallEvent source, WebChunk target) {
        target.setActionId(source.getActionId());
        target.setBatchId(source.getBatchId());
        target.setBatchIndex(source.getBatchIndex());
        target.setBatchSize(source.getBatchSize());
    }

    /**
     * 将 edit 工具的结构化 edits 列表转换为标准 git diff 文本，写入 {@code args.diff}，供前端 edit 渲染器着色展示。
     *
     * <p>edit 工具入参为 edits 列表（每项含 old_str / old_StrStartLine / new_str / replace_all），本身不含 diff 文本。
     * 前端渲染器依赖 {@code args.diff} 渲染，故在此由结构化参数重建 git diff：每个编辑操作生成一个 hunk，
     * old_str 各行打 {@code -}、new_str 各行打 {@code +}，old_StrStartLine 提供 {@code @@} 行号锚点（缺失时退化为 0）。
     * 转换后移除原始 edits，避免工具卡头部回显冗余结构。</p>
     *
     * @param args 工具参数（可为 null）
     */
    @SuppressWarnings("unchecked")
    private void fillEditDiff(Map<String, Object> args) {
        if (args == null || !(args.get(TerminalTalent.PARAM_EDITS) instanceof List)) {
            return;
        }

        List<?> edits = (List<?>) args.get(TerminalTalent.PARAM_EDITS);
        if (edits.isEmpty()) {
            return;
        }

        StringBuilder diff = new StringBuilder();
        for (Object item : edits) {
            if (!(item instanceof Map)) {
                continue;
            }
            Map<String, Object> edit = (Map<String, Object>) item;

            int startLine = asInt(edit.get("old_StrStartLine"), 0);
            List<String> oldLines = splitLines(asString(edit.get("old_str")));
            List<String> newLines = splitLines(asString(edit.get("new_str")));

            diff.append("@@ -").append(startLine).append(',').append(oldLines.size())
                    .append(" +").append(startLine).append(',').append(newLines.size())
                    .append(" @@\n");

            for (String line : oldLines) {
                diff.append('-').append(line).append('\n');
            }
            for (String line : newLines) {
                diff.append('+').append(line).append('\n');
            }
        }

        if (diff.length() > 0) {
            args.put("diff", diff.toString());
            args.remove(TerminalTalent.PARAM_EDITS);
        }
    }

    private static String asString(Object o) {
        return o == null ? "" : o.toString();
    }

    private static int asInt(Object o, int def) {
        if (o instanceof Number) {
            return ((Number) o).intValue();
        }
        if (o instanceof String) {
            try {
                return Integer.parseInt(((String) o).trim());
            } catch (NumberFormatException ignored) {
            }
        }
        return def;
    }

    private static List<String> splitLines(String s) {
        if (s == null || s.isEmpty()) {
            return Collections.emptyList();
        }
        // 统一换行符并去掉末尾换行，避免 split 产生多余空元素
        String normalized = s.replace("\r\n", "\n").replace('\r', '\n');
        while (normalized.endsWith("\n")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        if (normalized.isEmpty()) {
            return Collections.emptyList();
        }
        return Arrays.asList(normalized.split("\n", -1));
    }

    /**
     * 处理推理结束（ReasonEnd）阶段的事件。
     *
     * <p>两条<b>互斥</b>路径：</p>
     * <ol>
     *   <li><b>子代理载荷</b>（带 {@link TaskTalent#META_SUBAGENT}）：只负责把内容渲染进智能体卡片，
     *       <b>不做 IM 转发</b>。思考与正文是两份独立载荷，各出一帧。</li>
     *   <li><b>主代理载荷</b>：正文增量不补发；若模型只在聚合事件中提供思考且本轮没有
     *       thinking delta，则向 Web 补发一帧思考。同时按工具调用/最终结果语义转发 IM。</li>
     * </ol>
     *
     * <p><b>为什么子代理一律不转发 IM：</b>IM 通道绑定的是会话，用户要的是主代理的最终答案
     * （由 {@link #onRunEndEvent} 以 isFinal=true 推送）。把子代理的中间产物推过去既是噪声，
     * 又会与最终答案重复。旧实现是否转发取决于「这一轮模型有没有吐思考」——吐了就早退跳过
     * 转发、没吐就转发，同一个功能的行为随模型方言漂移，属于非确定性缺陷。</p>
     *
     * <p><b>为什么必须返回多帧：</b>旧实现先 {@code return} 思考帧，使得同一事件里的正文帧
     * 永不可达——当模型「吐了思考增量但不吐正文增量」时（部分中转/方言确实如此，
     * TaskTalent 的放行条件是 hasThinking() || needBody 的 OR），子代理正文会静默丢失。</p>
     *
     * @param session Agent 会话，用于获取会话ID和已选择的代理名称
     * @param event 思考轮次结束事件，包含助手消息和追踪信息
     * @return 0..2 帧 WebChunk（思考帧 + 正文帧），或空列表
     */
    private List<WebChunk> onReasonEndEvent(AgentSession session, ReasonEndEvent event, boolean thinkingDeltaSinceEnd) {
        String sessionId = session.getSessionId();
        // 4.1 事件体系：正文由 getText() 直接给出（与 getThinking() 物理分离），
        // 不再绕道 AgentUtil.getAggregatedResultContent() 反推——旧写法是
        // 「类名叫 Thought、下发的却是正文」错位的根源。
        String resultContent = event.getText();

        // === 子代理载荷：只渲染进卡片，不碰 IM 通道 ===
        if (event.hasMeta(TaskTalent.META_SUBAGENT)) {
            List<WebChunk> frames = new ArrayList<>(2);

            // 思考帧：reason 通道。旧体系此处完全丢弃，导致前端智能体卡片内永远看不到思考。
            // 能不能走到这里由 TaskTalent 的 thinkingStreamed 去重门禁决定：已逐字下发过增量就不再补发。
            if (event.hasThinking()) {
                WebChunk thinkingChunk = WebChunk.ofReason(event.getThinking());
                applyParentAgentArgs(event, thinkingChunk);
                frames.add(thinkingChunk);
            }

            // 正文帧：text 通道。仅在「本轮未流式产出正文增量」时才会被 TaskTalent 放行到这里，
            // 故不会与 ReasonDeltaEvent 的增量重复。前置换行是多子代理并行时的帧间分隔。
            if (Assert.isNotEmpty(resultContent)) {
                WebChunk bodyChunk = WebChunk.ofText("\n" + resultContent);
                applyParentAgentArgs(event, bodyChunk);
                frames.add(bodyChunk);
            }

            return frames;
        }

        // 主代理同样可能只在聚合 ReasonEndEvent 中携带 thinking（部分模型/中转不发
        // THINKING_DELTA）。此时补发一帧；若本轮已有思考增量，则由增量负责展示，避免全文重复。
        List<WebChunk> fallbackFrames = new ArrayList<>(1);
        if (!thinkingDeltaSinceEnd && displayableThinking(event)) {
            fallbackFrames.add(WebChunk.ofReason(event.getThinking()));
        }

        // === 主代理载荷：IM 转发 ===
        if (Assert.isNotEmpty(resultContent)) {
            if (event.isToolCalls()) {
                replyToBoundChannel(sessionId, resultContent, false);
            } else {
                String agentSelectedTmp = (String) session.attrs().get("_agent_selected_tmp");

                if (event.getTrace().getAgentName().equals(agentSelectedTmp)) {
                    // 最终结果：推送到已绑定的 IM 通道
                    replyToBoundChannel(sessionId, resultContent, true);

                    // 定时任务：若配置了推送通道，直接调 sendNotify（不依赖 sessionId 匹配）
                    String loopChannelNotify = (String) session.attrs().get("_loop_channelNotify");
                    if (loopChannelNotify != null && !loopChannelNotify.isEmpty()) {
                        for (Channel link : imLinks) {
                            if (link.getChannelName().equalsIgnoreCase(loopChannelNotify)) {
                                link.sendNotify(resultContent);
                                break;
                            }
                        }
                        session.attrs().remove("_loop_channelNotify");
                    }
                } else {
                    replyToBoundChannel(sessionId, resultContent, false);
                }
            }
        }

        return fallbackFrames;
    }

    /**
     * 只有真实 thinking 通道或文本 ReAct 的 Thought 段才可作为思考展示。
     * Native tool 的普通正文回退值不能重复渲染成思考。
     */
    private static boolean displayableThinking(ReasonEndEvent event) {
        if (event == null || !event.hasThinking() || event.getAssistantMessage() == null) {
            return false;
        }
        if (event.getAssistantMessage().isThinking()) {
            return true;
        }
        String content = event.getAssistantMessage().getContent();
        return content != null && content.contains("Thought:");
    }

    /**
     * 透传父智能体归属信息，供前端 resolveAgentState 路由到对应智能体卡片内渲染。
     */
    private static void applyParentAgentArgs(AgentEvent event, WebChunk target) {
        if (event.hasMeta("__parentAgentName")) {
            Map<String, Object> args = new LinkedHashMap<>();
            args.put("agentName", event.getMeta().get("__parentAgentName"));
            args.put("agentDesc", event.getMeta().get("__parentAgentDesc"));
            copyInvocationId(event, args);
            target.setArgs(args);
        }
    }

    private static void copyInvocationId(AgentEvent event, Map<String, Object> args) {
        Object invocationId = event.getMeta().get(TaskTalent.META_INVOCATION_ID);
        if (invocationId != null) args.put("invocationId", invocationId);
    }

    /**
     * 处理子代理启动事件
     */
    private WebChunk onAgentStartEvent(AgentStartEvent event) {
        String invocationId = event instanceof AgentStartEvent ? ((AgentStartEvent) event).getInvocationId() : null;
        return WebChunk.ofAgentStart(event.getAgentName(), event.getDescription(), invocationId);
    }

    /**
     * 处理子代理结束事件
     */
    private WebChunk onAgentEndEvent(AgentEndEvent event) {
        String invocationId = event instanceof AgentEndEvent ? ((AgentEndEvent) event).getInvocationId() : null;
        return WebChunk.ofAgentEnd(event.getAgentName(), event.getDescription(), event.isSuccess(), event.getResultSummary(), invocationId);
    }

    /**
     * 处理 ReAct 流的最终汇总 chunk
     *
     * <p>当 Agent 流结束时触发。若检测到异常终止，将异常内容连同追踪信息
     * 同步转发到所有已绑定的 IM 通道。无论是否异常，都将追踪信息
     * （模型名称、token 数、耗时）以结构化 trace 类型输出到 Web 端。</p>
     *
     * @param session     Agent 会话，用于获取会话ID以进行 IM 通道转发
     * @param chunk       ReAct 最终汇总 chunk，包含追踪信息和可能的异常内容
     * @param turnStartMs 本轮任务订阅时刻（毫秒），用于计算单轮耗时
     * @return 包含追踪信息的 trace 类型 WebChunk
     */
    private WebChunk onRunEndEvent(AgentSession session, RunEndEvent chunk, long turnStartMs) {
        ReActTrace trace = chunk.getTrace();

        if (chunk.isAbnormal()) {
            // 通知 IM 任务完成了
            replyToBoundChannel(session.getSessionId(), chunk.getContent(), true);
        }

        // 结构化 trace 数据，供前端独立渲染
        String model = trace.getOptions().getChatModel().getNameOrModel();

        Long inputTokens = null;
        Long outputTokens = null;
        Long cacheCreationTokens = null;
        Long cacheReadTokens = null;
        Double cacheRate = null;
        if (trace.getMetrics() != null) {
            long promptTokens = trace.getMetrics().getPromptTokens();
            long cacheCreation = trace.getMetrics().getCacheCreationInputTokens();
            long cacheRead = trace.getMetrics().getCacheReadInputTokens();
            // Metrics.addUsage 已在采集端逐条归一（跨厂商子代理求和也正确），此处再调一次仅作
            // 幂等防御层：已归一时 promptTokens >= 缓存之和恒成立，不会二次叠加。
            inputTokens = UsageNormalizer.normalizeInputTokens(promptTokens, cacheCreation, cacheRead);
            outputTokens = trace.getMetrics().getCompletionTokens();
            cacheCreationTokens = cacheCreation;
            cacheReadTokens = cacheRead;
            cacheRate = UsageNormalizer.cacheHitRate(inputTokens, cacheRead);
        }
        // 单轮耗时：从本轮订阅起算，而非 trace.getBeginTimeMs()（跨轮复用会累计成整段对话时长）。
        Long elapsedSeconds = turnStartMs > 0 ? Duration.ofMillis(System.currentTimeMillis() - turnStartMs).getSeconds() : null;

        // 最终答案全量文本（去除 think 标签，与正文输出保持一致），供前端复制使用
        String finalAnswer = chunk.getContent();
        if (finalAnswer != null) {
            finalAnswer = finalAnswer.replaceAll("(?s)<\\s*/?think\\s*>", "");
        }

        return WebChunk.ofTrace(model, inputTokens, outputTokens,
                cacheCreationTokens, cacheReadTokens, cacheRate, elapsedSeconds, finalAnswer);
    }

    /**
     * 向已绑定的 IM 通道发送回复。
     *
     * <p>门禁两层：
     * <ol>
     *   <li>{@link Channel#isBound(String)}：该会话须为通道当前活跃会话（保留“绑定一次、切换操作多会话”能力）；</li>
     *   <li>触发来源匹配：仅当本轮输入由 IM/Loop 触发时才回推。网页端手动输入（source=null）不回推 IM，
     *       避免网页发起的任务因恰好命中活跃指针而误推到 IM。</li>
     * </ol></p>
     */
    private void replyToBoundChannel(String sessionId, String text, boolean isFinal) {
        // 网页手动输入(source=null)不回推 IM；IM/Loop 触发(source 非空)维持按活跃指针回推
        Object source = null;
        try {
            source = engine.getSession(sessionId).attrs().get("_input_source");
        } catch (Exception ignored) {
        }
        if (source == null) {
            return;
        }

        for (Channel link : imLinks) {
            if (link.isBound(sessionId)) {
                link.sendReply(sessionId, text, isFinal);
            }
        }
    }
}