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
package com.gourdai.harness.agent;

import org.noear.snack4.ONode;
import com.gourdai.agent.event.AgentEvent;
import com.gourdai.agent.AgentSession;
import com.gourdai.agent.react.ReActAgent;
import com.gourdai.agent.event.RunEndEvent;
import com.gourdai.agent.react.ReActOptionsAmend;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.event.ToolCallStartEvent;
import com.gourdai.agent.event.ToolCallDraftEvent;
import com.gourdai.agent.event.ToolCallArgsDeltaEvent;
import com.gourdai.agent.event.ToolCallEndEvent;
import com.gourdai.agent.event.ReasonDeltaEvent;
import com.gourdai.agent.event.ReasonEndEvent;
import com.gourdai.agent.session.InMemoryAgentSession;
import com.gourdai.core.portal.web.ThinkingDepth;
import org.noear.solon.ai.annotation.ToolMapping;
import org.noear.solon.ai.chat.ChatModel;
import org.noear.solon.ai.chat.ChatSession;
import org.noear.solon.ai.chat.prompt.Prompt;
import org.noear.solon.ai.chat.talent.AbsTalent;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.change.FileChangeService;
import org.noear.solon.annotation.Body;
import org.noear.solon.annotation.Param;
import org.noear.solon.core.util.Assert;
import org.noear.solon.core.util.RunUtil;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.publisher.FluxSink;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.UUID;

/**
 * 子代理才能
 *
 * 将子代理能力暴露为可调用的工具（Claude Code Subagent 类似实现）
 *
 * @author oisin
 * @since 3.9.5
 */
public class TaskTalent extends AbsTalent {
    private static final Logger LOG = LoggerFactory.getLogger(TaskTalent.class);

    public static final String TOOL_TASK = "task";
    public static final String TOOL_MULTITASK = "multitask";

    /**
     * 事件元数据键：标记「这条 ReasonEndEvent 是子代理的聚合载荷」。
     *
     * <p>各端（Web/ACP/CLI/WS）据此把它路由进智能体卡片或以缩进块打印，而不是当作主代理正文。
     * 旧实现复用 {@link #TOOL_MULTITASK} 作这个标记，语义上是错的：单 task 路径从不打该标记，
     * 导致单 task 子代理遇到不吐 delta 的模型时卡片内正文恒空。故拆出独立键，
     * task 与 multitask 一律打。</p>
     */
    public static final String META_SUBAGENT = "__subagentReason";
    /** 每次 task/multitask 调用的唯一关联标识；前端和 ACP 用它配对并行同名任务。 */
    public static final String META_INVOCATION_ID = "__invocationId";

    private final HarnessEngine engine;

    public TaskTalent(HarnessEngine engine) {
        this.engine = engine;
    }

    @Override
    public String description() {
        return "多任务调度专家：将复杂任务拆解并委派给专项子代理（如 explore, plan, bash 等），支持并行处理以提高效率。";
    }

    @Override
    public String getInstruction(Prompt prompt) {
        StringBuilder sb = new StringBuilder();

        sb.append("## 当前可用的子代理\n");
        sb.append("<available_agents>\n");
        for (AgentDefinition agentDefinition : engine.getAgentManager().getAgents()) {
            sb.append(String.format("  - \"%s\": %s\n", agentDefinition.getName(), agentDefinition.getDescription()));
        }
        sb.append("</available_agents>\n\n");

        sb.append("## 任务分配策略：\n");
        sb.append("0. **先方案后动手（改造门禁）**: 对现有代码/配置/架构的复杂改造（多文件修改、跨模块重构、破坏性变更、多种可行路径），**必须先产出方案并经用户确认，再委派执行类子代理**。可先委派 `plan` 子代理（或自行调研）产出 ≥2 个可行方案（含改动范围、优缺点对比与推荐项），呈现给用户选择；用户拍板后，才允许把方案拆解为执行子任务委派下去。用户已明确指定实现方式的除外。\n");
        sb.append("1. **主动拆分优先**: 遇到复杂任务时，**优先**拆解为独立子任务委派给子代理执行，而不是由主智能体串行完成。子代理是独立运行的智能体，能并行处理、减少主上下文消耗。\n");
        sb.append("2. **委派触发条件** — 遇到以下场景**必须**使用 `task` 或 `multitask` 委派:\n");
        sb.append("   - 需要同时分析/修改多个独立的文件或模块\n");
        sb.append("   - 需要多步验证（如：先探索代码结构，再修改，最后编译验证）\n");
        sb.append("   - 需要深度搜索或跨仓库查找（如：搜索特定模式、查找 API 用法）\n");
        sb.append("   - 需要执行独立的构建/测试/部署步骤\n");
        sb.append("   - 任务涉及不同的技术领域或知识领域\n");
        sb.append("3. **并行执行**: 当子任务互不依赖时，**必须**使用 `multitask` 并行执行以节省时间。\n");
        sb.append("4. **原子性**: 每个子任务应具备明确的输入和输出边界。\n");
        sb.append("5. **上下文传递**: 由于子代理无状态（上下文隔离），必须在 prompt 中提供任务所需的全部背景信息、具体要求及预期输出格式。不要假设子代理知道主会话的上下文。\n");
        sb.append("6. **主智能体职责**: 主智能体专注于**任务规划、进度跟踪、结果整合与最终回答**。具体执行工作应委派给子代理。\n");

        return sb.toString();
    }

    @ToolMapping(name = TOOL_TASK, description =
            "委派单一任务给专项子代理。适用于需要深度思考、多步操作或特定领域知识（如文件操作、代码分析）的场景。不支持并行调用（并行请用 multitask）。")
    public String task(@Body SingleTaskOp taskSpec, String __cwd, String __sessionId,
                       String __changeSessionId, String __changeRunId, String __thinkingDepth) {
        if (Assert.isEmpty(__sessionId)) {
            throw new IllegalStateException("__sessionId is required");
        }

        AgentSession __parentSession = engine.getSession(__sessionId);
        ReActTrace __parentTrace = ReActTrace.getCurrent(__parentSession.getContext());

        MultiTaskOp taskOp = new MultiTaskOp();
        taskOp.agent_name = taskSpec.agent_name;
        taskOp.description = taskSpec.description;
        taskOp.prompt = taskSpec.prompt;

        return taskDo(__parentTrace, __cwd, __sessionId, __parentSession, taskOp, 1, false,
                __changeSessionId, __changeRunId, __thinkingDepth)
                + TODO_UPDATE_REMINDER;
    }

    @ToolMapping(name = TOOL_MULTITASK, description =
            "并行执行多个互不依赖的子任务。要求任务之间必须没有资源竞争（例如：不同的模块开发、多路搜索）。")
    public String multitask(@Param(name = "tasks", description = "任务列表") List<MultiTaskOp> tasks, String __cwd, String __sessionId,
                            String __changeSessionId, String __changeRunId, String __thinkingDepth) {
        if (Assert.isEmpty(tasks)) {
            return "WARNING: 任务列表为空";
        }

        if (Assert.isEmpty(__sessionId)) {
            throw new IllegalStateException("__sessionId is required");
        }


        AgentSession __parentSession = engine.getSession(__sessionId);
        ReActTrace __parentTrace = ReActTrace.getCurrent(__parentSession.getContext());

        if (__parentTrace == null) {
            if (LOG.isWarnEnabled()) {
                LOG.warn("任务接收[{}, __parentTrace=null]：{}", __sessionId, ONode.serialize(tasks));
            }
        } else {
            if (LOG.isDebugEnabled()) {
                LOG.debug("任务接收[{}]：{}", __sessionId, ONode.serialize(tasks));
            }
        }


        List<CompletableFuture<String>> futures = new ArrayList<>();

        for (MultiTaskOp task : tasks) {
            CompletableFuture<String> future;
            try {
                future = CompletableFuture.supplyAsync(() ->
                                taskDo(__parentTrace, __cwd, __sessionId, __parentSession, task, tasks.size(), true,
                                        __changeSessionId, __changeRunId, __thinkingDepth), RunUtil.io())
                        //兜住 taskDo 自身 try 之外的漏网异常，使其就地降级为一条失败结果；
                        //否则 allOf 整体失败会连带丢弃已经成功的兄弟任务
                        .exceptionally(ex -> {
                            Throwable cause = (ex instanceof CompletionException && ex.getCause() != null)
                                    ? ex.getCause() : ex;
                            LOG.error("任务异常[{}/{} - {}]: {}", task.index, tasks.size(), task.agent_name, describe(cause), cause);
                            return formatTaskResp(task, false, "ERROR: 任务执行失败: " + describe(cause), true);
                        });
            } catch (Throwable e) {
                //线程池拒绝是 supplyAsync 同步抛出的，此刻派生 future 尚未生成，exceptionally 拦不到
                LOG.error("任务提交失败[{}/{} - {}]: {}", task.index, tasks.size(), task.agent_name, describe(e), e);
                future = CompletableFuture.completedFuture(
                        formatTaskResp(task, false, "ERROR: 任务提交失败: " + describe(e), true));
            }

            futures.add(future);
        }

        String result = CompletableFuture.allOf(futures.toArray(new CompletableFuture[0]))
                .thenApply(v -> {
                    StringBuilder compositeResult = new StringBuilder();
                    compositeResult.append("<multitask_results>\n");
                    for (CompletableFuture<String> f : futures) {
                        compositeResult.append(f.join()).append("\n");
                    }
                    compositeResult.append("</multitask_results>");
                    compositeResult.append(TODO_UPDATE_REMINDER);
                    return compositeResult.toString();
                })
                .exceptionally(ex -> "ERROR: Multitask aggregate failed: " + ex.getMessage())
                .join();

        if (LOG.isDebugEnabled()) {
            LOG.debug("任务完成[{}]：{} 个全部完成", __sessionId, tasks.size());
        }

        return result;
    }

    /**
     * 解析文件变更的归属 run（sessionId/runId 二元组，任一为空则返回 null）。
     * <p>嵌套子代理（子代理再调 task）时，子代理的 __sessionId 已是子会话名，而
     * InMemoryAgentSession 未注册进 SessionProvider，engine.getSession() 会拿到另一个新建空会话
     * 且 trace 为 null，父链就在此断裂。故根归属必须由工具参数 __changeSessionId/__changeRunId
     * 逐层透传（下划线参数由框框注入且不进入 JSON schema，与 __cwd/__sessionId 同机制）。
     */
    private static String[] resolveChangeOwner(ReActTrace __parentTrace, String __sessionId,
                                               String __changeSessionId, String __changeRunId) {
        // 1) 优先用上层透传下来的根归属（支持任意嵌套深度）
        if (Assert.isNotEmpty(__changeSessionId) && Assert.isNotEmpty(__changeRunId)) {
            return new String[]{__changeSessionId.trim(), __changeRunId.trim()};
        }

        // 2) 顶层调用：用主会话 id + 主 trace 的 runId
        if (__parentTrace == null) {
            // 拿不到主 runId，无法组成完整归属；下游回退到子代理自身 trace。
            return null;
        }

        String ownerRunId = __parentTrace.getRunId();
        if (Assert.isEmpty(__sessionId) || Assert.isEmpty(ownerRunId)) {
            return null;
        }

        return new String[]{__sessionId.trim(), ownerRunId};
    }

    /** 把变更归属写入子代理 toolContext；归属不完整时不写，让下游回退到子代理自身 trace。 */
    private static void applyChangeOwner(ReActOptionsAmend o, String[] changeOwner) {
        if (changeOwner != null) {
            o.toolContextPut(FileChangeService.ATTR_CHANGE_SESSIONID, changeOwner[0]);
            o.toolContextPut(FileChangeService.ATTR_CHANGE_RUNID, changeOwner[1]);
        }
    }

    /**
     * 解析本轮生效的思考档位。
     *
     * <p>优先用 toolContext 透传的 per-turn override（{@link HarnessEngine#ATTR_THINKING_DEPTH}），
     * 其次回退会话上下文里用户在前台的选择。</p>
     *
     * <p><b>为什么必须有 override 这一路：</b>WebStreamBuilder / AcpLink 支持「按任务而非按会话」
     * 指定档位（Loop 定时任务），且该 override 刻意<b>不写入</b>会话上下文以免污染用户选择。
     * 旧实现只读会话上下文，于是主代理用 override（如 high）、子代理读到旧值（甚至 null→OFF）
     * 而<b>静默降档</b>——这正是「子代理必须与外部使用一致的模型和思考级别」要求被破坏的地方。</p>
     */
    private static String resolveThinkingDepth(AgentSession parentSession, String overrideDepth) {
        if (Assert.isNotEmpty(overrideDepth)) {
            return ThinkingDepth.normalize(overrideDepth);
        }
        if (parentSession == null) {
            return ThinkingDepth.AUTO;
        }
        return ThinkingDepth.normalize(parentSession.getContext().getAs(HarnessEngine.CTX_THINKING_DEPTH));
    }

    /**
     * 把已解析出的思考档位应用到子代理的请求选项上。
     *
     * <p>模型本身已经继承（CTX_MODEL_SELECTED 传给 agentDefinition.builder），但思考档位原先只在
     * WebStreamBuilder / AcpLink 注入，子代理构建路径整个缺失——对 OpenAI o 系、Gemini 3.x、
     * Anthropic adaptive thinking 这类<b>需显式开启思考</b>的模型，子代理请求不带思考参数，
     * 上游就不会回 THINKING_DELTA，卡片内的思考块恒为空。</p>
     *
     * <p>模型能力必须取<b>子代理自己的</b> ChatModel：子代理可在 AgentDefinition 里指定别家模型，
     * 若沿用主模型的能力会把参数包成错的形状（如给 Gemini 发 reasoning_effort）。
     * ThinkingDepth.applyTo 内部对不支持的档位只清理不注入，故跨厂商不匹配时自然降级。</p>
     */
    private static void applyThinkingDepth(ReActOptionsAmend o, ReActAgent agent, String depth) {
        if (ThinkingDepth.AUTO.equals(depth)) {
            return;
        }

        ChatModel subModel = (agent == null) ? null : agent.getModel();
        if (subModel == null) {
            return;
        }

        ThinkingDepth.applyTo(o, subModel, depth);
    }

    /**
     * 给事件打上父代理归属标记，供下游把内容路由进对应智能体卡片。
     *
     * <p>包一层 try/catch 是纵深防御：{@link AgentEvent#getMeta()} 的接口契约并未强制「可变」，
     * 若将来某个事件实现返回不可变 Map，这里会让整条子代理流炸掉，并被 taskDo 的兜底 catch
     * 误报成「任务执行失败」。丢归属标记（内容漏进主对话）远比炸掉整个子任务轻，故降级为 WARN。</p>
     */
    private static void stampParentAgent(AgentEvent event, String agentName, String description, String invocationId) {
        try {
            // 嵌套子代理事件已经带有内层归属，不能被外层 doOnNext 覆盖；普通事件则写入当前调用。
            event.getMeta().putIfAbsent("__parentAgentName", agentName);
            event.getMeta().putIfAbsent("__parentAgentDesc", description);
            if (invocationId != null) {
                event.getMeta().putIfAbsent(META_INVOCATION_ID, invocationId);
            }
        } catch (UnsupportedOperationException e) {
            LOG.warn("事件 {} 的 meta 不可变，跳过父代理归属标记（该内容将无法路由进智能体卡片）",
                    event.getClass().getSimpleName());
        }
    }

    /** 给子代理的聚合载荷打 {@link #META_SUBAGENT} 标记，各端据此识别「这是子代理内容」。 */
    private static void stampSubagentReason(AgentEvent event) {
        try {
            event.getMeta().put(META_SUBAGENT, 1);
        } catch (UnsupportedOperationException e) {
            LOG.warn("事件 {} 的 meta 不可变，无法标记子代理归属，该内容将不会路由进智能体卡片",
                    event.getClass().getSimpleName());
        }
    }

    private String taskDo(ReActTrace __parentTrace, String __cwd, String __sessionId, AgentSession __parentSession, MultiTaskOp task, int count, boolean isMultitask,
                          String __changeSessionId, String __changeRunId, String __thinkingDepth) {
        //注意：getAgent 找不到时抛 IllegalArgumentException，而该异常会被 ActionTask.executeTool
        //归类为“参数 schema 错误”，从而误导模型反复纠正参数格式。这里必须先判存在性，
        //把“代理名不存在”转成可读结果并附上可选列表，让模型能自行改名重试。
        final String invocationId = UUID.randomUUID().toString();

        AgentDefinition agentDefinition;
        try {
            if (engine.getAgentManager().hasAgent(task.agent_name) == false) {
                return formatTaskResp(task, false, unknownAgentMessage(task.agent_name), isMultitask);
            }

            agentDefinition = engine.getAgentManager().getAgent(task.agent_name);
        } catch (Throwable e) {
            LOG.error("解析子代理失败[{}]: {}", task.agent_name, e.getMessage(), e);
            return formatTaskResp(task, false, unknownAgentMessage(task.agent_name), isMultitask);
        }

        final ReActAgent agent;
        final AgentSession session;
        final Prompt originalPrompt;
        try {
            if (LOG.isDebugEnabled()) {
                LOG.debug("任务开始[{}/{} - {}]: {}", task.index, count, task.agent_name, ONode.serialize(task));
            }

            String modelSelected = __parentSession.getContext().getAs(HarnessEngine.CTX_MODEL_SELECTED);

            //模型未配置时 getModelOrMain 返回 null，AgentFactory 随后 ReActAgent.of(null)。
            //异常若从这里逸出，会丢掉 <task_result> 信封与 index，多任务下无法与请求对应
            agent = agentDefinition.builder(engine, modelSelected).build();
            session = InMemoryAgentSession.of(agent.name());

            originalPrompt = Prompt.of(task.prompt);
            originalPrompt.attrs().computeIfAbsent(ChatSession.ATTR_SESSIONID,
                    k -> session.getSessionId());
        } catch (Throwable e) {
            LOG.error("子代理构建失败[{}/{} - {}]: {}", task.index, count, task.agent_name, describe(e), e);
            return formatTaskResp(task, false, "ERROR: 子代理构建失败: " + describe(e), isMultitask);
        }

        String result = null;
        final String[] changeOwner = resolveChangeOwner(__parentTrace, __sessionId, __changeSessionId, __changeRunId);
        // 本轮生效的思考档位；同时写回子代理 toolContext，使嵌套委派（子代理再调 task）逐层继承
        final String thinkingDepth = resolveThinkingDepth(__parentSession, __thinkingDepth);

        try {
            AtomicReference<Throwable> errRef = new AtomicReference<>();

            if (__parentTrace == null || __parentTrace.getOptions() == null || __parentTrace.getOptions().getStreamSink() == null) {
                // 同步模式
                RunEndEvent runEnd = agent.prompt(originalPrompt)
                        .session(session)
                        .options(o -> {
                            o.toolContextPut(HarnessEngine.ATTR_CWD, __cwd);
                            o.toolContextPut(ChatSession.ATTR_SESSIONID, __sessionId);
                            o.toolContextPut(HarnessEngine.ATTR_THINKING_DEPTH, thinkingDepth);
                            applyChangeOwner(o, changeOwner);
                            applyThinkingDepth(o, agent, thinkingDepth);
                        })
                        .stream()
                        .doOnError(errRef::set)
                        // 用 ofType 过滤而非直接强转 blockLast()：流末尾并不保证恰好是 RunEndEvent
                        // （异常收尾、上游提前 complete 时最后一个元素可能是别的事件），强转会抛
                        // ClassCastException，被下方兜底 catch 报成「任务执行失败: java.lang.
                        // ClassCastException...」这种对模型零信息量、也无法自纠的 observation。
                        .ofType(RunEndEvent.class)
                        .blockLast();

                if (errRef.get() != null) {
                    throw errRef.get();
                }

                if (runEnd == null) {
                    throw new IllegalStateException("子代理流已结束但未产出 RunEndEvent，无最终结果可取");
                }

                if (__parentTrace != null) {
                    __parentTrace.getMetrics().addMetrics(runEnd.getMetrics());
                }

                result = runEnd.getContent();
            } else {
                // 流式模式
                final FluxSink<AgentEvent> sink = __parentTrace.getOptions().getStreamSink();

                // 推送子代理启动信号
                sink.next(new AgentStartEvent(task.agent_name, task.description, __sessionId, invocationId));

                // 本轮是否已流式下发过「正文增量」/「思考增量」：决定 ReasonEndEvent 的聚合载荷要不要
                // 兜底补发（避免与增量重复）。两者必须<b>各自独立</b>计数——思考与正文由不同的 delta
                // 承载，只记正文会让思考被下发两次（详见下方 ReasonEndEvent 分支注释）。
                final AtomicBoolean bodyStreamed = new AtomicBoolean(false);
                final AtomicBoolean thinkingStreamed = new AtomicBoolean(false);

                RunEndEvent response = agent.prompt(originalPrompt)
                        .session(session)
                        .options(o -> {
                            o.toolContextPut(HarnessEngine.ATTR_CWD, __cwd);
                            o.toolContextPut(ChatSession.ATTR_SESSIONID, __sessionId);
                            o.toolContextPut(HarnessEngine.ATTR_THINKING_DEPTH, thinkingDepth);
                            applyChangeOwner(o, changeOwner);
                            applyThinkingDepth(o, agent, thinkingDepth);
                        })
                        .stream()
                        .takeUntil(r -> sink.isCancelled())
                        .doOnNext(chunk -> {
                            // 统一标记 chunk 的父智能体归属（__parentAgentName/__parentAgentDesc），
                            // 下游流构建器据此把 agentName/agentDesc 透传给前端，使子代理的思考/正文/工具
                            // 内容能路由到对应智能体卡片内部渲染，而不是漏进主对话。
                            stampParentAgent(chunk, task.agent_name, task.description, invocationId);

                            if (chunk instanceof ContextUsageEvent) {
                                sink.next(chunk);
                            } else if (chunk instanceof ToolCallStartEvent) {
                                sink.next(chunk);
                            } else if (chunk instanceof ToolCallDraftEvent || chunk instanceof ToolCallArgsDeltaEvent) {
                                // 参数生成期的进度帧与 ToolCallStartEvent 同等对待：子代理内部同样会发生
                                // 大参数工具调用（如 write 整篇文档），若只透传 start，智能体卡片会静默数十秒，
                                // 表现得与「子代理卡死」无法区分。
                                //
                                // 归属 meta 已由上方 stampParentAgent 统一打好（__parentAgentName/__parentAgentDesc/
                                // META_INVOCATION_ID），与 ToolCallStartEvent 走同一条标记路径，故下游会把骨架卡
                                // 路由进同一张智能体卡片；这里切不可另行补盖 meta，否则嵌套子代理的内层归属会被覆盖。
                                sink.next(chunk);
                            } else if (chunk instanceof ToolCallEndEvent) {
                                sink.next(chunk);
                            } else if (chunk instanceof ReasonDeltaEvent) {
                                // 思考与正文增量一律放行（task 与 multitask 一致）。
                                // 二者都带 __parentAgentName，下游 onReasonDeltaEvent 会按 isThinking() 分流成
                                // reason/text 两类 WebChunk，前端再由 resolveAgentState 路由进对应智能体卡片
                                // （思考进 thinking-block，正文进 md-content），不会漏进主对话。
                                ReasonDeltaEvent rc = (ReasonDeltaEvent) chunk;
                                if (rc.isToolCalls() == false && rc.hasContent()) {
                                    if (rc.isThinking()) {
                                        thinkingStreamed.set(true);
                                    } else {
                                        bodyStreamed.set(true);
                                    }
                                }
                                sink.next(chunk);
                            } else if (chunk instanceof ReasonEndEvent) {
                                // 4.1 事件体系：ReasonEndEvent 的 getThinking() 与 getText() 物理分离，
                                // 思考与正文是<b>两份独立载荷</b>，必须各自判断「本轮是否已由 delta 送达」：
                                //
                                //   · 只记正文、思考无条件放行（旧实现）→ 思考被下发两次：一次由
                                //     ReasonDeltaEvent 增量逐字送达，一次由这里补发聚合全文；且
                                //     ReasonEndEvent 每轮都发，N 轮就重复 N 次（前端 appendReasonChunkCore
                                //     是纯追加，没有去重）。
                                //   · 两者都记 → 各自独立兜底，既不重复也不丢失。
                                //
                                // getAndSet(false)：判定后立即重置，使「本轮是否已流式产出」按 ReAct 轮次
                                // 独立判断——ReasonEndEvent 每轮都发，而第 1 轮有增量不代表第 N 轮也有
                                // （有些模型/中转会直接给完整消息而不吐 delta），不重置会使那一轮内容
                                // 被误抑制、直接丢失。
                                //
                                // 不再用 isMultitask 作门禁：单 task 子代理同样需要兜底，否则遇到不吐
                                // delta 的模型时卡片内正文恒空。归属一律用 META_SUBAGENT 标记，
                                // 各端（Web/ACP/CLI/WS）按同一个键识别，不再区分 task 与 multitask。
                                ReasonEndEvent re = (ReasonEndEvent) chunk;
                                boolean needThinking = thinkingStreamed.getAndSet(false) == false && re.hasThinking();
                                boolean needBody = bodyStreamed.getAndSet(false) == false && re.hasText();

                                if (needThinking || needBody) {
                                    stampSubagentReason(chunk);
                                    sink.next(chunk);
                                }
                            }
                        })
                        .doOnError(errRef::set)
                        .ofType(RunEndEvent.class)
                        .blockLast();

                if (errRef.get() != null) {
                    // 推送失败信号
                    sink.next(new AgentEndEvent(task.agent_name, task.description, false, errRef.get().getMessage(), __sessionId, invocationId));
                    throw errRef.get();
                }

                if (response == null) {
                    // takeUntil 在「用户 Stop / 客户端断连」时会截断流，此刻最后一个元素多半不是
                    // RunEndEvent，ofType 过滤后为空 → blockLast() 返回 null。这是<b>正常取消</b>，不是
                    // 子代理失败：旧实现直接强转会抛 ClassCastException（或对 null 取 getMetrics() 抛
                    // NPE），两者都被下方兜底 catch 报成「ERROR: 任务执行失败」，把一次用户主动停止
                    // 误报成子代理出错并回灌给模型，模型会据此重试一个本该终止的任务。
                    LOG.warn("任务被取消[{}/{} - {}]：上游流已取消或未产出 RunEndEvent",
                            task.index, count, task.agent_name);

                    // 补一个结束帧收口卡片（sink 已取消时 next 是 no-op，无副作用）
                    sink.next(new AgentEndEvent(task.agent_name, task.description, false, CANCELLED_MESSAGE, __sessionId, invocationId));

                    return formatTaskResp(task, false, CANCELLED_MESSAGE, isMultitask);
                }

                __parentTrace.getMetrics().addMetrics(response.getMetrics());
                result = response.getContent();

                // 推送子代理结束信号
                sink.next(new AgentEndEvent(task.agent_name, task.description, true, result, __sessionId, invocationId));
            }


            if (LOG.isDebugEnabled()) {
                LOG.debug("任务成功[{}/{} - {}]: {}", task.index, count, task.agent_name, task.description);
            }

            return formatTaskResp(task, true, result, isMultitask);
        } catch (Throwable e) {
            LOG.error("任务失败[{}/{} - {}]: {}", task.index, count, task.agent_name, e.getMessage(), e);

            result = String.format("ERROR: 任务执行失败: %s", describe(e));

            return formatTaskResp(task, false, result, isMultitask);
        }
    }

    /**
     * 取异常的可读描述：NPE 等异常 getMessage() 恒为 null，
     * 直接回灌给模型会得到 “任务执行失败: null” 这种零信息量的 observation
     */
    private static String describe(Throwable e) {
        String msg = e.getMessage();
        return (msg != null && msg.isEmpty() == false) ? msg : e.toString();
    }

    /**
     * 构造“未知子代理”的可读提示（附当前可选列表，便于模型自行纠正）
     */
    private String unknownAgentMessage(String agentName) {
        StringBuilder buf = new StringBuilder();
        buf.append("ERROR: 未知的子代理类型 '").append(agentName).append("'。");

        //本方法会在 catch 块里被调用，自身绝不能再抛：getAgents() 会触发 MountManager 解析，
        //挂载定义被删除/无权限时 loadFromAgentMd 会抛 RuntimeException，届时异常将逃出 taskDo
        StringBuilder names = new StringBuilder();
        try {
            for (AgentDefinition definition : engine.getAgentManager().getAgents()) {
                if (names.length() > 0) {
                    names.append(", ");
                }
                names.append(definition.getName());
            }
        } catch (Throwable e) {
            LOG.error("枚举可用子代理失败: {}", e.getMessage(), e);
            buf.append("当前无法枚举可用子代理（子代理定义加载异常），请勿再调用本工具，改由自己直接完成任务。");
            return buf.toString();
        }

        if (names.length() == 0) {
            //子代理清单为空属于部署异常（内置定义资源缺失），需明确暴露而不是让模型反复重试
            buf.append("当前没有任何可用的子代理，请勿再调用本工具，改由自己直接完成任务。");
        } else {
            buf.append("可用的子代理：").append(names).append("。");
        }

        return buf.toString();
    }

    /**
     * 提醒主代理在拿到委派结果后立即更新 TODO 清单，避免状态滞后（模型惯于“干完再统一补记”，
     * 一旦此时异常中断，落盘清单会停留在旧状态，续跑时易重复执行已完成的步骤）。
     */
    private static final String TODO_UPDATE_REMINDER =
            "\n[提醒] 子任务结果已返回：若存在 TODO 清单，请立即调用 todowrite 更新对应项状态（成功则置 [x]），再继续后续动作，禁止延后补记。";

    /**
     * 子代理被上游取消（用户 Stop / 客户端断连）时的中性结果文案。
     *
     * <p>刻意不用 "ERROR:" 前缀：这不是子代理出错，而是一次正常的用户主动终止。带 ERROR 前缀会让
     * 模型把它当作可重试的失败并反复重派同一个任务。</p>
     */
    private static final String CANCELLED_MESSAGE =
            "CANCELLED: 任务已被用户停止或连接中断，未产出结果。这是正常的主动终止，不是子代理出错，请勿重试同一任务。";

    private String formatTaskResp(MultiTaskOp task, boolean successful, String result, boolean isMultitask) {
        StringBuilder buf = new StringBuilder();

        buf.append("<task_result>");
        if (isMultitask) {
            buf.append("<index>").append(task.index).append("</index>");
        }
        buf.append("<description>").append(task.description).append("</description>");
        buf.append("<agent_name>").append(task.agent_name).append("</agent_name>");
        buf.append("<result_status>").append(successful ? "success" : "failure").append("</result_status>");
        buf.append("<result_content><![CDATA[").append(result != null ? result : "").append("]]></result_content>");
        buf.append("</task_result>");

        return buf.toString();
    }

    public static class SingleTaskOp {
        @Param(name = "agent_name", description = "子代理名称")
        public String agent_name;
        @Param(name = "prompt", description = "发给子代理的详细指令。由于子代理是无状态的（上下文隔离），必须在此提供任务所需的所有背景信息、具体要求及预期输出格式。")
        public String prompt;
        @Param(name = "description", description = "任务内容的极简摘要（如：'重构用户认证逻辑'）。该描述将作为标签出现在执行日志和结果摘要中，用于快速识别任务意图。")
        public String description;

        @Override
        public String toString() {
            return "SingleTaskOp{" +
                    "agent_name='" + agent_name + '\'' +
                    ", description='" + description + '\'' +
                    '}';
        }
    }

    /**
     * 任务定义
     */
    public static class MultiTaskOp extends SingleTaskOp {
        @Param(name = "index",
                description = "任务唯一序号，每个任务分配唯一的递增整数（从1开始），以便匹配返回结果",
                defaultValue = "1")
        public int index = 1;

        @Override
        public String toString() {
            return "MultiTaskOp{" +
                    "index='" + index + '\'' +
                    "agent_name='" + agent_name + '\'' +
                    ", description='" + description + '\'' +
                    '}';
        }
    }
}