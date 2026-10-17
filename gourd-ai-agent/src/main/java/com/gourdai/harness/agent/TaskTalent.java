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
import com.gourdai.agent.ContextLengthPolicy;
import com.gourdai.agent.react.BackgroundNoticeCenter;
import com.gourdai.agent.react.ReActAgent;
import com.gourdai.agent.event.RunEndEvent;
import com.gourdai.agent.react.ReActOptionsAmend;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.event.ToolCallStartEvent;
import com.gourdai.agent.event.ToolCallDraftEvent;
import com.gourdai.agent.event.ToolCallArgsDeltaEvent;
import com.gourdai.agent.event.ToolCallBatchEvent;
import com.gourdai.agent.event.ToolCallEndEvent;
import com.gourdai.agent.event.ReasonDeltaEvent;
import com.gourdai.agent.event.ReasonEndEvent;
import com.gourdai.agent.session.InMemoryAgentSession;
import com.gourdai.agent.util.AgentUtil;
import com.gourdai.core.portal.web.ThinkingDepth;
import com.gourdai.ai.annotation.ToolMapping;
import com.gourdai.ai.chat.ChatModel;
import com.gourdai.ai.chat.ChatSession;
import com.gourdai.ai.chat.prompt.Prompt;
import com.gourdai.ai.chat.talent.AbsTalent;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.permission.AccessMode;
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
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
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
    public static final String TOOL_AWAIT_TASKS = "await_tasks";

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

    /** background=true 任务的注册表：token → 归属会话 + Future，靠 TTL 驱逐防内存泄漏 */
    private final Map<String, BackgroundTask> taskRegistry = new ConcurrentHashMap<>();

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
        sb.append("0. **改造门禁**：多文件修改、破坏性变更或多可行路径时，**必须先产出方案经用户确认**，再委派执行类子代理。\n");
        sb.append("1. **主动拆分 + 并行**：遇到可拆解的复杂任务，优先用 `multitask` 并行派发；互相依赖时才串行用 `task`。\n");
        sb.append("2. **上下文自足**：子代理无状态，`prompt` 必须包含任务所需的全部背景、要求与预期输出格式。\n");
        sb.append("3. **后台模式（默认优先）**：除非某子任务的结果是你**下一步立即必需**的输入，否则一律设 `background=true`（`task` 与 `multitask` 均支持，按任务粒度，可与前台任务混批）。后台提交会立即返回 token，让你**不必干等就能继续推进其他工作**；每个任务完成时你会自动收到一条 [后台子代理完成] 消息（含 token 与结果摘要），无需轮询；确需完整结果时再用 `await_tasks` 传入 token 收取（可一次传多个）。反之，阻塞模式（`background=false`）会把主流程**卡死到子代理跑完**——长耗时子任务用它会让你这段时间完全无法推进别的事，只有拿到结果才能继续时才用它。\n");
        sb.append("4. **后台收尾纪律**：完成通知只在你发起的回合开始时被注入消费。仍有后台任务在跑时，不得以「等通知/收到通知后继续」为由结束回合——回合结束即无执行体消费通知；要么本轮内继续其他工作或用 await_tasks 核实，要么在最终回答中如实告知用户哪些任务仍在运行、如何让你继续。\n");

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

        taskOp.background = taskSpec.background;

        if (taskSpec.background) {
            // detached=true：后台任务不得沿用父代理的 streamSink。
            //
            // 【为何必须脱离】ReActRequest.stream() 在 agent.call() 返回后立即 sink.complete()
            // （ReActRequest L147-148），而后台任务的生命周期恰恰是「主代理继续跑完本轮甚至下几轮」。
            // 若沿用父 sink，taskDo 流式分支的 takeUntil(r -> sink.isCancelled()) 会在 sink 完成那一刻
            // 立刻截断子代理流，blockLast() 返回 null，任务被误报成 CANCELLED——实测这是必现路径，
            // 不是竞态窗口。同时往已 complete 的 sink 里 next 是静默 no-op，前端也收不到任何帧。
            CompletableFuture<String> future = CompletableFuture.supplyAsync(
                    () -> taskDo(__parentTrace, __cwd, __sessionId, __parentSession, taskOp, 1, false,
                            __changeSessionId, __changeRunId, __thinkingDepth, true), RunUtil.io())
                    // 必须挂 exceptionally（与 formatBackgroundSubmission 对称）：taskDo 自身 try 之外的
                    // 漏网异常若不就地降级，await_tasks 的 future.get 会抛 ExecutionException，
                    // 结果只剩一条裸 ERROR 文案——丢掉 <task_result> 信封与 description，模型无法
                    // 对应到是哪个任务失败。此处包成失败信封，通知侧 isFailureResult 也能正确报 failed。
                    .exceptionally(ex -> {
                        Throwable cause = (ex instanceof CompletionException && ex.getCause() != null)
                                ? ex.getCause() : ex;
                        LOG.error("后台任务异常[{} - {}]: {}", taskOp.agent_name, describe(cause), cause);
                        return formatTaskResp(taskOp, false, "ERROR: 任务执行失败: " + describe(cause), false);
                    });
            // index 传 null：单任务提交不属于批量，通知里带 index=1 会让模型误以为还有兄弟任务
            String token = registerBackgroundTaskWithNotice(__sessionId, future, taskOp, null);
            boolean noticeEnabled = noticeAvailable();
            return "BACKGROUND_TASK_SUBMITTED: token=" + token
                    + "\n后台任务已提交" + backgroundProgressHint() + "."
                    + (noticeEnabled
                        ? "任务完成时你会自动收到一条 [后台子代理完成] 消息（在下一轮推理开始时注入），无需轮询；"
                          + "请先继续其他工作，确需完整结果时再用 await_tasks 传入该 token 收取。"
                          + "注意：不得以「等通知」为由结束回合——回合结束即无执行体消费通知。"
                        : "请先继续其他工作，再用 await_tasks 工具传入该 token 收取结果。"
                          + BACKGROUND_NO_NOTICE_HINT);
        }

        return taskDo(__parentTrace, __cwd, __sessionId, __parentSession, taskOp, 1, false,
                __changeSessionId, __changeRunId, __thinkingDepth, false)
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

        // 按任务粒度分流：前台组整体阻塞到全部完成（行为与引入 background 之前逐字一致），
        // 后台组 detached 提交后立即返回 token。
        //
        // 【这才是「子代理运行期间主进程也能继续执行」的真正落点】主代理不阻塞在 ACTION 段，
        // 就能回到 REASON 轮继续推进——而 SteerInterceptor.onReasonStart 有 hasOpenToolCall 守卫，
        // 只在 REASON 轮消费插话邮箱。阻塞式 multitask 跑 10 分钟，用户这 10 分钟里的插话
        // 只能在邮箱里干等；后台化后主代理每轮都有机会消费它。
        List<MultiTaskOp> foreground = new ArrayList<>();
        List<MultiTaskOp> background = new ArrayList<>();
        for (MultiTaskOp task : tasks) {
            if (task.background) {
                background.add(task);
            } else {
                foreground.add(task);
            }
        }

        StringBuilder result = new StringBuilder();

        // 【顺序契约：后台组必须先提交、前台组后阻塞】
        //
        // 交换前的旧序（前台先执行）会让后台任务干等前台组全部跑完才开跑：本该「后台的 5 分钟
        // 与前台的 10 分钟并行」变成串行 15 分钟，混合批次下 background 化的并行收益完全丧失。
        // 先提交后台组（detached 提交几乎零耗时、立即返回 token），前台组随后的阻塞等待期间
        // 后台任务已在跑——这才是「按任务粒度混批」该有的语义。
        //
        // 返回值顺序随之变为 <multitask_background> 在前、<multitask_results> 在后：模型先拿到
        // token 清单（即使前台组随后异常，token 也已返回），再读前台结果，语义自洽。
        //
        // 纯后台批次刻意不产出 <multitask_results> 空壳：空信封会让模型误读成
        // 「全部任务已完成且结果为空」，从而跳过 await_tasks 直接编造结论。
        if (background.isEmpty() == false) {
            result.append(formatBackgroundSubmission(background, tasks.size(), __parentTrace, __cwd, __sessionId,
                    __parentSession, __changeSessionId, __changeRunId, __thinkingDepth));
        }

        // 纯前台批次走这里：返回值与改造前完全一致（含 TODO 提醒与完成日志），故不加任何包裹。
        if (foreground.isEmpty() == false) {
            result.append(runForegroundTasks(foreground, tasks.size(), __parentTrace, __cwd, __sessionId,
                    __parentSession, __changeSessionId, __changeRunId, __thinkingDepth));
        }

        return result.toString();
    }

    /**
     * 前台（阻塞）批量执行：等全部子代理完成后聚合为 {@code <multitask_results>}。
     *
     * <p>逻辑与引入 background 之前的 multitask 主体逐字一致（含 exceptionally 降级、线程池拒绝
     * 兜底、TODO 提醒与完成日志），仅入参由「整批」变为「前台组」。传给子代理日志的分母仍是整批
     * {@code total}，使 {@code index/total} 的对应关系不因分流而改变。</p>
     */
    private String runForegroundTasks(List<MultiTaskOp> tasks, int total, ReActTrace __parentTrace, String __cwd,
                                      String __sessionId, AgentSession __parentSession, String __changeSessionId,
                                      String __changeRunId, String __thinkingDepth) {
        List<CompletableFuture<String>> futures = new ArrayList<>();

        for (MultiTaskOp task : tasks) {
            CompletableFuture<String> future;
            try {
                future = CompletableFuture.supplyAsync(() ->
                                taskDo(__parentTrace, __cwd, __sessionId, __parentSession, task, total, true,
                                        __changeSessionId, __changeRunId, __thinkingDepth, false), RunUtil.io())
                        //兜住 taskDo 自身 try 之外的漏网异常，使其就地降级为一条失败结果；
                        //否则 allOf 整体失败会连带丢弃已经成功的兄弟任务
                        .exceptionally(ex -> {
                            Throwable cause = (ex instanceof CompletionException && ex.getCause() != null)
                                    ? ex.getCause() : ex;
                            LOG.error("任务异常[{}/{} - {}]: {}", task.index, total, task.agent_name, describe(cause), cause);
                            return formatTaskResp(task, false, "ERROR: 任务执行失败: " + describe(cause), true);
                        });
            } catch (Throwable e) {
                //线程池拒绝是 supplyAsync 同步抛出的，此刻派生 future 尚未生成，exceptionally 拦不到
                LOG.error("任务提交失败[{}/{} - {}]: {}", task.index, total, task.agent_name, describe(e), e);
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
            LOG.debug("任务完成[{}]：{} 个前台任务全部完成", __sessionId, tasks.size());
        }

        return result;
    }

    /**
     * 后台批量提交：逐个 detached 提交并登记 token，立即返回登记清单（不等待执行结果）。
     *
     * <p>与前台组的三处刻意差异：</p>
     * <ul>
     *   <li>{@code detached=true}：父 sink 在 {@code agent.call()} 返回时即 complete，沿用会被
     *       {@code takeUntil} 立刻截断并误报 CANCELLED（与 {@code task(background=true)} 同因）。</li>
     *   <li>必须挂 {@code exceptionally}：{@code task} 的 background 路径没有这一层，异常会留到
     *       {@code await_tasks} 的 {@code future.get()} 才以 ExecutionException 抛出——虽能被
     *       describe 兜住，却会丢掉 {@code <task_result>} 信封与 index，批量场景下无法与请求对应。</li>
     *   <li>同步提交失败（线程池拒绝）时<b>不登记 token</b>，就地返回失败结果：登记一个永不完成的
     *       future 会让 await 白等到超时，模型还得再试一轮。</li>
     * </ul>
     */
    private String formatBackgroundSubmission(List<MultiTaskOp> tasks, int total, ReActTrace __parentTrace, String __cwd,
                                              String __sessionId, AgentSession __parentSession, String __changeSessionId,
                                              String __changeRunId, String __thinkingDepth) {
        StringBuilder buf = new StringBuilder();
        buf.append("<multitask_background>\n");

        for (MultiTaskOp task : tasks) {
            String token;
            try {
                CompletableFuture<String> future = CompletableFuture.supplyAsync(
                                () -> taskDo(__parentTrace, __cwd, __sessionId, __parentSession, task, total, true,
                                        __changeSessionId, __changeRunId, __thinkingDepth, true), RunUtil.io())
                        .exceptionally(ex -> {
                            Throwable cause = (ex instanceof CompletionException && ex.getCause() != null)
                                    ? ex.getCause() : ex;
                            LOG.error("后台任务异常[{}/{} - {}]: {}", task.index, total, task.agent_name,
                                    describe(cause), cause);
                            return formatTaskResp(task, false, "ERROR: 任务执行失败: " + describe(cause), true);
                        });
                token = registerBackgroundTaskWithNotice(__sessionId, future, task, task.index);
            } catch (Throwable e) {
                LOG.error("后台任务提交失败[{}/{} - {}]: {}", task.index, total, task.agent_name, describe(e), e);
                buf.append(formatTaskResp(task, false, "ERROR: 后台任务提交失败: " + describe(e), true)).append("\n");
                continue;
            }

            // 用元素体而非 XML 属性承载 description：它是模型自由文本，放进属性必须转义引号与
            // 尖括号，漏一处就破坏整段结构；元素体口径与 formatTaskResp 保持一致。
            buf.append("<submitted>\n")
               .append("  <index>").append(task.index).append("</index>\n")
               .append("  <agent_name>").append(task.agent_name).append("</agent_name>\n")
               .append("  <description>").append(task.description).append("</description>\n")
               .append("  <token>").append(token).append("</token>\n")
               .append("</submitted>\n");
        }

        buf.append("</multitask_background>");
        // 通知与卡片可见性都是会话级/实例级的（归属键要么有要么没有、listener 要么接了要么没接），
        // 整批统一判断即可
        buf.append(noticeAvailable() ? BACKGROUND_SUBMITTED_REMINDER_WITH_NOTICE
                                      : BACKGROUND_SUBMITTED_REMINDER + BACKGROUND_NO_NOTICE_HINT);
        buf.append(backgroundProgressHint());
        return buf.toString();
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
     * 解析本轮生效的模型（供子代理构建时使用）。
     *
     * <p>优先用 toolContext 透传的 per-turn override（{@link HarnessEngine#ATTR_MODEL_OVERRIDE}），
     * 其次回退会话上下文里用户在前台的选择。</p>
     *
     * <p><b>为什么必须有 override 这一路：</b>WebStreamBuilder 支持「按任务而非按会话」指定模型
     * （Loop 定时任务，startSyncRun 的 transientSelection=true），且该 override 刻意<b>不写入</b>
     * 会话上下文以免污染用户选择。旧实现只读会话上下文，于是主代理用任务模型（如 A）、
     * 子代理读到会话旧值（甚至默认模型）而<b>静默换模</b>——这正是「定时任务设定的模型未生效、
     * 跑成了别的模型」的根因。</p>
     *
     * <p>取值口在<b>父 trace 的 toolContext</b>而非工具形参：模型 override 不需要模型自行指定，
     * 从 trace 读取可避免 task/multitask/await_tasks 三处签名变更；父 trace 在同一 run 内稳定，
     * 且 ReasonTask 会把父 toolContext 整体继承给子代理 run，嵌套委派时该键随 toolContext
     * 写回（见 taskDo 内 o.toolContextPut）而逐层可靠。</p>
     *
     * @return 有效的模型名；无 override 且会话无选择时返回 null（回退默认模型）
     */
    private static String resolveModelOverride(ReActTrace parentTrace, AgentSession parentSession) {
        if (parentTrace != null && parentTrace.getOptions() != null && parentTrace.getOptions().getToolContext() != null) {
            Object value = parentTrace.getOptions().getToolContext().get(HarnessEngine.ATTR_MODEL_OVERRIDE);
            if (value != null) {
                String text = String.valueOf(value).trim();
                if (!text.isEmpty()) {
                    return text;
                }
            }
            // 空串是「前台路径的显式清理标记」：表示本轮无任务级 override，不得再从会话上下文
            // 之外寻找其它来源，直接落到会话级选择。
        }
        if (parentSession == null) {
            return null;
        }
        return parentSession.getContext().getAs(HarnessEngine.CTX_MODEL_SELECTED);
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
     * 解析本轮生效的访问控制档位。
     *
     * <p>与思考档位同构的缺口：档位只在主代理的 toolContext 与主会话上下文里，子代理是新会话、
     * 新 Prompt，读不到就会回落默认档。后果是用户开了完全访问、主代理放行的目录，子代理却仍受限，
     * 表现为子任务莫名报「路径越界」——而用户刚确认过可以访问。</p>
     *
     * <p>取值优先父代理 toolContext 的 per-turn override（{@link AccessMode#ATTR_KEY}）：
     * Loop 定时任务的任务级档位刻意不写入会话上下文（避免污染用户前台选择），只经 toolContext
     * 透传；若只读父会话上下文，子代理会静默回落到会话旧档——与「模型 override」同一根因
     * （见 {@link #resolveModelOverride}）。override 缺省/为空时回退父会话上下文的已存档位
     * （权威存储位，随快照持久化）。</p>
     *
     * <p>解析结果由调用方同时写入子会话上下文与子代理 toolContext，使拦截器与工具两路消费点
     * 同源同档；嵌套委派时本子会话成为下一层的父会话，逐档继承。</p>
     */
    private static String resolveAccessMode(ReActTrace parentTrace, AgentSession parentSession) {
        if (parentTrace != null && parentTrace.getOptions() != null && parentTrace.getOptions().getToolContext() != null) {
            Object value = parentTrace.getOptions().getToolContext().get(AccessMode.ATTR_KEY);
            if (value != null) {
                String text = String.valueOf(value).trim();
                if (!text.isEmpty()) {
                    return AccessMode.normalize(text).code();
                }
            }
        }
        if (parentSession == null) {
            return AccessMode.DEFAULT.code();
        }

        return AccessMode.normalize(parentSession.getContext().getAs(AccessMode.CTX_KEY)).code();
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

    /**
     * 执行单个子代理任务。
     *
     * @param detached 是否「脱离父流」执行（background=true 专用）。为 true 时强制走同步分支：
     *                 既不读也不写父 trace 的 streamSink（该 sink 在父本轮结束时就已 complete，
     *                 沿用会让 takeUntil 立刻截断子代理流），也不把 metrics 累加回父 trace
     *                 （后台任务跨轮次完成，此时父 trace 可能已 reset 进入下一轮，
     *                 累加会把上一轮的 token 记到下一轮账上）。
     */
    private String taskDo(ReActTrace __parentTrace, String __cwd, String __sessionId, AgentSession __parentSession, MultiTaskOp task, int count, boolean isMultitask,
                          String __changeSessionId, String __changeRunId, String __thinkingDepth, boolean detached) {
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
        // 方法级持有：三处 options 写回点（后台/同步/流式分支）都在上方 try 块的作用域之外，
        // 需要把解析出的模型 override 提升出来供 toolContextPut 嵌套继承。
        String modelSelected;
        try {
            if (LOG.isDebugEnabled()) {
                LOG.debug("任务开始[{}/{} - {}]: {}", task.index, count, task.agent_name, ONode.serialize(task));
            }

            // 旧实现只读会话上下文的 CTX_MODEL_SELECTED，但 Loop 定时任务的模型是 transient 选择
            // （不写入会话上下文，见 WebGate.startSyncRun），导致主代理用任务模型、子代理静默
            // 换回会话旧模型/默认模型——「定时任务设定的模型未生效」的根因。
            // 现优先从父 trace 的 toolContext 读 per-turn override（resolveModelOverride）。
            modelSelected = resolveModelOverride(__parentTrace, __parentSession);

            //模型未配置时 getModelOrMain 返回 null，AgentFactory 随后 ReActAgent.of(null)。
            //异常若从这里逸出，会丢掉 <task_result> 信封与 index，多任务下无法与请求对应
            agent = agentDefinition.builder(engine, modelSelected).build();
            session = InMemoryAgentSession.of(agent.name());
            // 子代理用的是全新的独立会话，不会自动继承父会话的上下文窗口选择；
            // 不显式复制，用户选了 1M 的会话里，子代理会静默回落到默认值而提前压缩。
            ContextLengthPolicy.copy(__parentSession, session);

            originalPrompt = Prompt.of(task.prompt);
            originalPrompt.attrs().computeIfAbsent(ChatSession.ATTR_SESSIONID,
                    k -> session.getSessionId());
        } catch (Throwable e) {
            LOG.error("子代理构建失败[{}/{} - {}]: {}", task.index, count, task.agent_name, describe(e), e);
            return formatTaskResp(task, false, "ERROR: 子代理构建失败: " + describe(e), isMultitask);
        }

        String result = null;
        // 本次结果是否为「健康完成」：abnormal 兼容文案（模型失败/最大回合数）不得报为 success，
        // 否则父代理把道歉文案当真实结论缩进后续汇总（work-munh72qj 场景的盲区：三个子代理
        // 全部失败却报 success=true）
        boolean resultOk = true;
        final String[] changeOwner = resolveChangeOwner(__parentTrace, __sessionId, __changeSessionId, __changeRunId);
        // 本轮生效的思考档位；同时写回子代理 toolContext，使嵌套委派（子代理再调 task）逐层继承
        final String thinkingDepth = resolveThinkingDepth(__parentSession, __thinkingDepth);
        // 本轮生效的访问档位（同模型/思考档位机制；同样写回以使嵌套委派逐层继承）
        final String accessMode = resolveAccessMode(__parentTrace, __parentSession);
        // 档位同时写入子会话上下文（权威存储位）：HITLInterceptor 读的是会话上下文而非
        // toolContext，只写 toolContext 会让子代理「空间已放行、审批仍弹」——正是
        // AccessPolicy 要消灭的漂移症状。嵌套委派时本子会话成为下一层的父会话，逐层继承。
        session.getContext().put(AccessMode.CTX_KEY, accessMode);

        try {
            AtomicReference<Throwable> errRef = new AtomicReference<>();

            if (detached) {
                // 后台模式（background=true）专属分支：既不读写父 trace 的 streamSink（它在本轮结束
                // 时就已 complete，往里 next 是静默 no-op），也不把 metrics 累加回父 trace（后台任务
                // 跨轮次完成，此时父 trace 可能已 reset 进入下一轮，累加会把上一轮的 token 记到下一轮账上）。
                //
                // 前端可视化改走 backgroundAgentListener 旁路直连 WebSocket 广播（见 BackgroundAgentListener
                // 的类注释），不依赖父 sink 是否存活，因此主代理本轮结束、界面空闲时卡片仍能更新。
                final AtomicBoolean cancelFlag = new AtomicBoolean(false);
                registerCancellable(__sessionId, invocationId, cancelFlag);
                try {
                    emitBackgroundStart(__sessionId, task, invocationId);

                    RunEndEvent runEnd = agent.prompt(originalPrompt)
                            .session(session)
                            .options(o -> {
                                o.toolContextPut(HarnessEngine.ATTR_CWD, __cwd);
                                o.toolContextPut(ChatSession.ATTR_SESSIONID, __sessionId);
                                o.toolContextPut(HarnessEngine.ATTR_THINKING_DEPTH, thinkingDepth);
                                o.toolContextPut(AccessMode.ATTR_KEY, accessMode);
                                // 模型 override 同步写回：嵌套委派（子代理再调 task）时本子 run 的
                                // toolContext 即下一层的父 trace，不写回则嵌套层 resolveModelOverride 落回会话级旧值。
                                if (Assert.isNotEmpty(modelSelected)) {
                                    o.toolContextPut(HarnessEngine.ATTR_MODEL_OVERRIDE, modelSelected);
                                }
                                applyChangeOwner(o, changeOwner);
                                applyThinkingDepth(o, agent, thinkingDepth);
                            })
                            .stream()
                            // 协作式取消：用户点 Stop 时 interruptSession 置位 cancelFlag，下一个事件
                            // 到达即停流并取消上游订阅（含在途的模型请求）。刻意不用 future.cancel(true)
                            // 中断线程：子代理可能正在 write/edit 落盘，外部中断会留下写一半的文件。
                            .takeUntil(ev -> cancelFlag.get())
                            .doOnNext(ev -> {
                                // 进度心跳只在工具边界发：不发正文/思考 delta（帧量爆炸）、不带 phase
                                // （避免污染主会话的相位状态机）。仅告知「当前在调哪个工具」。
                                if (ev instanceof ToolCallStartEvent) {
                                    emitBackgroundProgress(__sessionId, task, invocationId,
                                            ((ToolCallStartEvent) ev).getToolName());
                                }
                            })
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
                        // takeUntil 在取消位被置时截断流，此刻最后一个元素多半不是 RunEndEvent，
                        // ofType 过滤后为空 → blockLast() 返回 null。与流式分支的取消路径同口径：
                        // 这是<b>正常取消</b>不是子代理失败，绝不能报成 ERROR，否则模型会重派
                        // 一个用户刚刚亲手停掉的任务。
                        if (cancelFlag.get()) {
                            LOG.warn("后台任务被取消[{}/{} - {}]：用户已停止该会话", task.index, count, task.agent_name);
                            emitBackgroundEnd(__sessionId, task, invocationId, false, CANCELLED_MESSAGE);
                            return formatTaskResp(task, false, CANCELLED_MESSAGE, isMultitask);
                        }
                        throw new IllegalStateException("子代理流已结束但未产出 RunEndEvent，无最终结果可取");
                    }

                    result = runEnd.getContent();
                    resultOk = isHealthyRunEnd(runEnd, session);
                    result = resultOk ? result : SUBAGENT_FAILURE_PREFIX + result;
                    emitBackgroundEnd(__sessionId, task, invocationId, resultOk, result);
                } catch (Throwable e) {
                    // 卡片已建（start 无条件先发），必须补一个结束帧收卡：否则状态点永远闪，
                    // 用户看到的是一张永久 loading 的卡。emit 内部已 try/catch，不会再抛。
                    emitBackgroundEnd(__sessionId, task, invocationId, false, "ERROR: " + describe(e));
                    throw e;
                } finally {
                    unregisterCancellable(__sessionId, invocationId);
                }
            } else if (__parentTrace == null || __parentTrace.getOptions() == null || __parentTrace.getOptions().getStreamSink() == null) {
                // 同步模式（无可用父 sink 时的回退路径）
                RunEndEvent runEnd = agent.prompt(originalPrompt)
                        .session(session)
                        .options(o -> {
                            o.toolContextPut(HarnessEngine.ATTR_CWD, __cwd);
                            o.toolContextPut(ChatSession.ATTR_SESSIONID, __sessionId);
                            o.toolContextPut(HarnessEngine.ATTR_THINKING_DEPTH, thinkingDepth);
                            o.toolContextPut(AccessMode.ATTR_KEY, accessMode);
                            if (Assert.isNotEmpty(modelSelected)) {
                                o.toolContextPut(HarnessEngine.ATTR_MODEL_OVERRIDE, modelSelected);
                            }
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
                // abnormal 兼容文案不得报成功（同 detached 分支，见 isHealthyRunEnd 注释）
                resultOk = isHealthyRunEnd(runEnd, session);
                result = resultOk ? result : SUBAGENT_FAILURE_PREFIX + result;
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
                            o.toolContextPut(AccessMode.ATTR_KEY, accessMode);
                            if (Assert.isNotEmpty(modelSelected)) {
                                o.toolContextPut(HarnessEngine.ATTR_MODEL_OVERRIDE, modelSelected);
                            }
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
                            } else if (chunk instanceof ToolCallBatchEvent) {
                                // 批次声明帧与 ToolCallStartEvent 同等对待：子代理内部的批量工具卡组同样需要
                                // 「先声明、后逐张转正」，否则容器在各卡 action_start 逐一到达时才懒创建，
                                // 「单卡先出 → 逐张合并」的中间态跳变在智能体卡片内同样可见。
                                // 归属 meta 已由上方 stampParentAgent 统一打好（__parentAgentName/__parentAgentDesc/
                                // META_INVOCATION_ID），与 start/draft 走同一条标记路径。
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
                                // 思考载荷还须过「可显示思考」判定（AgentUtil#isDisplayableThinking）：NATIVE_TOOL
                                // 的正文回退值等不可展示形态不得触发补发，否则整个事件被放行后，下游会把正文
                                // 重复渲染进思考通道（与主代理补发同一判定，单点收敛防语义漂移）。
                                boolean needThinking = thinkingStreamed.getAndSet(false) == false
                                        && AgentUtil.isDisplayableThinking(re);
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
                // abnormal 兼容文案不得报成功（同 detached 分支，见 isHealthyRunEnd 注释）
                resultOk = isHealthyRunEnd(response, session);
                result = resultOk ? result : SUBAGENT_FAILURE_PREFIX + result;

                // 推送子代理结束信号
                sink.next(new AgentEndEvent(task.agent_name, task.description, resultOk, result, __sessionId, invocationId));
            }


            if (LOG.isDebugEnabled()) {
                LOG.debug("任务成功[{}/{} - {}]: {}", task.index, count, task.agent_name, task.description);
            }

            return formatTaskResp(task, resultOk, result, isMultitask);
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
     * 子代理失败时加在兜底文案前的标记前缀：一并纠正两处易误读点——①这不是任务结论；
     * ②子代理会话是内存态，失败后上下文即丢，不存在「断点续跑」，重试只能重新委派从头跑。
     * （主代理的兜底文案里「保留断点」对主代理成立，对子代理不成立，必须在此显式纠正。）
     */
    static final String SUBAGENT_FAILURE_PREFIX =
            "[子代理执行失败·以下为中止原因而非任务结论；子代理上下文已丢失，重试需重新委派从头执行] ";

    /**
     * 判定子代理的 RunEnd 是否为「健康完成」。
     *
     * <p>背景：模型调用失败/超时/最大回合数到达时，ReasonTask#handleLastException 会把
     * 道歉文案设为 finalAnswer，RunEnd 正常发射且内容非空——taskDo 旧实现只看「拿到 RunEnd」
     * 就报 success=true，把道歉文案当真实结论回灌给父代理（实测 work-munh72qj：三个子代理
     * 全部因模型服务故障失败，信封却全部 success=true，父代理据此编写调研汇总）。</p>
     *
     * <p>判定式：{@code runEnd.isAbnormal() && !session.isPending()}。</p>
     * <ul>
     *   <li>{@code isAbnormal()}：trace.setFinalAnswer 的单参重载置位，覆盖模型失败/超时/
     *       最大回合；正常完成与用户主动停止（Extra_USER_INTERRUPTED）均为 false，不受影响；</li>
     *   <li>{@code !isPending()}：ask_user/HITL 挂起时 finalAnswer 是挂起文案（等待作答/审批），
     *       虽也走单参重载置 abnormal=true，但它是正常流程控制而非失败，不得判为失败。
     *       （挂起的子代理由用户作答后恢复，本轮不会走到 RunEnd；但防御性排除仍有必要：
     *       若未来某路径在挂起态发射 RunEnd，这里能避免误报。）</li>
     * </ul>
     */
    static boolean isHealthyRunEnd(RunEndEvent runEnd, AgentSession session) {
        if (runEnd == null) {
            // null 表示流被取消/未产出结果，调用方已有专门的 CANCELLED 处理分支，
            // 这里不处理 null（返回 true 会把取消误报成失败，返回 false 会把没走到这里的
            // 取消路径语义搞乱；保持现状由上游分支处理）
            return true;
        }
        return !runEnd.isAbnormal() || (session != null && session.isPending());
    }

    /**
     * 构造“未知子代理”的可读提示（附当前可选列表，便于模型自行纠正）
     */
    private String unknownAgentMessage(String agentName) {
        StringBuilder buf = new StringBuilder();
        buf.append("ERROR: 未知的子代理类型 '").append(agentName).append("'。");

        //本方法会在 catch 块里被调用，自身绝不能再抛：getAgents() 会触发 TalentRegistry 扫描，
        //代理定义文件损坏/无权限时 loadFromAgentMd 会抛 RuntimeException，届时异常将逃出 taskDo
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
     * 后台任务提交后的用法提醒。
     *
     * <p>刻意点明「先做别的、最后统一 await」：模型的常见误区是提交后立刻 await_tasks，
     * 那等价于把后台模式退化成阻塞模式——白付一次工具往返，却拿不到「主代理继续推进、
     * 及时消费用户插话」的收益。</p>
     */
    private static final String BACKGROUND_SUBMITTED_REMINDER =
            "\n[提醒] 以上后台任务已提交并开始执行。"
            + "请先继续其他不依赖其结果的工作，确需结果时再用 await_tasks 一次性传入这些 token 收取；"
            + "不要在提交后立刻 await，那会退化为阻塞等待。";

    /**
     * 启用完成通知时的提交提醒：告知模型任务结束会自动收到推送，无需轮询。
     *
     * <p>与 {@link #BACKGROUND_SUBMITTED_REMINDER} 互斥使用（按 noticeEnabled 二选一）：
     * 通知未启用时写「你会自动收到」，会让模型停止查询、死等一条永不到来的消息——
     * 口径沿用 TerminalTalent#formatBackgroundStart 的既有教训。</p>
     */
    private static final String BACKGROUND_SUBMITTED_REMINDER_WITH_NOTICE =
            "\n[提醒] 以上后台任务已提交并开始执行。"
            + "每个任务完成时你会自动收到一条 [后台子代理完成] 消息（含 token 与结果摘要，在下一轮推理开始时注入），无需轮询；"
            + "请先继续其他不依赖其结果的工作，确需完整结果时再用 await_tasks 传入相应 token；"
            + "不要在提交后立刻 await，那会退化为阻塞等待；"
            + "也不得以「等通知」为由结束回合——回合结束即无执行体消费通知，"
            + "要么本轮内继续工作，要么如实告知用户任务仍在运行及后续如何继续。";

    /**
     * 如实告知用户能否看到后台子代理的过程。
     *
     * <p><b>为何必须运行时判断而不能写死</b>：卡片推送靠 {@link BackgroundAgentListener} 由
     * WebGate 反向注册，而单测直接调工具、或 CLI/ACP 等非 Web 通道下根本没有 WebGate，
     * listener 恒为 null。写死「会展示卡片」在这些通道下就是新的谎言（与
     * {@link #BACKGROUND_NO_NOTICE_HINT} 对通知的处理同构）。</p>
     */
    private String backgroundProgressHint() {
        return backgroundAgentVisible()
                ? "（用户界面上会显示该子代理的智能体卡片与当前进度）"
                : "（其子代理进度不会推送到前端）";
    }

    /**
     * 通知未启用时的降级提醒：如实说明需自行 await 收取。
     *
     * <p><b>为何必须区分</b>：单测直接调用工具、或上下文缺失归属键时，
     * {@link BackgroundNoticeCenter#currentOwner()} 返回 null，通知根本不会投递。
     * 此时承诺「会自动收到」就是骗模型死等。</p>
     */
    private static final String BACKGROUND_NO_NOTICE_HINT =
            "\n（当前上下文未启用完成通知：请用 await_tasks 传入上述 token 收取结果。）";

    /**
     * 后台子代理完成通知里结果摘要的字符上限。
     *
     * <p><b>为何必须截断（本机制的头号风险）</b>：通知被注入 workingMemory 后会作为普通消息
     * <b>随历史被后续每一轮全量重发</b>；子代理结果动辄数千至数万字符，远长于 bash 的尾部输出。
     * 不截断就会把「省掉轮询往返」变成「每轮多付一份完整结果」，token 不降反升——
     * 恰好击穿 {@link BackgroundNoticeCenter} 存在的意义。</p>
     *
     * <p>取值小于 await_tasks 常用的 max_result_chars：摘要只用于让模型判断「要不要现在去收」，
     * 完整内容一律走 await_tasks。</p>
     */
    private static final int NOTICE_SUMMARY_MAX_CHARS = 1200;

    /**
     * 当前上下文能否投递完成通知（即归属键是否已由 ActionTask 绑定到本线程）。
     *
     * <p>调用方必须在工具方法内（提交线程上）调它：归属键靠 ThreadLocal 透传，
     * 一旦回到 IO 线程或 ActionTask 的 finally 解绑后就恒为 null。</p>
     */
    static boolean noticeAvailable() {
        return BackgroundNoticeCenter.currentOwner() != null;
    }

    /**
     * 从子代理结果中提取「失败」标记，用于填充通知的业务成败位。
     *
     * <p>不解析业务成败会怎样：{@code taskDo} 把失败也包装成 {@code <task_result>} 正常返回，
     * future 正常完成 → 通知只能报 status=finished，模型会把一个失败任务当成功处理。</p>
     */
    private static boolean isFailureResult(String result) {
        return result != null && (result.startsWith("ERROR:") || result.contains("<result_status>failure"));
    }

    /**
     * 给后台任务 future 挂完成通知，并登记注册表，返回 token。
     *
     * <p>三处关键取舍：</p>
     * <ol>
     *   <li><b>owner 必须在提交线程（工具方法内）就取出</b>：归属键靠
     *       {@link BackgroundNoticeCenter} 的 ThreadLocal 从 ActionTask 透传，而 ActionTask 在
     *       finally 里 {@code unbindCurrentOwner()}。若在 whenComplete 回调里才取，回调跑在
     *       IO 线程池上，读到的恒是 null。task/multitask 不在 ActionTask 的 READONLY_TOOLS
     *       名单里，恒走串行段，故此处 ThreadLocal 可靠。</li>
     *   <li><b>用 thenAccept 而非 whenComplete</b>：上游已挂 exceptionally 时，本阶段拿到的必是
     *       正常值；不挂 exceptionally 的路径（task 单任务）异常会透传到本阶段，回调不执行，
     *       由 {@code notifyFailure} 统一补发。</li>
     *   <li><b>先登记再挂通知</b>：登记失败（极端情况）时通知也发不出去，模型至少能从提交回执
     *       里看到失败，不会拿到一个「说有通知却永远不来」的空承诺。</li>
     * </ol>
     *
     * @param index 批量提交时的任务序号；单任务提交传 null（通知里省略该字段）
     * @return token；owner 为 null 时仍返回 token（await 通道照常可用，只是没有推送）
     */
    String registerBackgroundTaskWithNotice(String sessionId, CompletableFuture<String> future,
                                            MultiTaskOp task, Integer index) {
        final String owner = BackgroundNoticeCenter.currentOwner();
        final String token = registerBackgroundTask(sessionId, future);

        if (owner == null) {
            // 无归属键：不投递任何通知。调用方据返回值在回执里如实降级，禁止承诺通知。
            return token;
        }

        // 登记运行中后台任务（结束门禁的判定依据）。先于挂完成回调：future 可能已近乎完成，
        // 回调先跑而登记后补会残留成永不注销的「在跑」。
        BackgroundNoticeCenter.registerRunning(owner, token);

        future.thenAccept(result -> {
                    // 先注销运行登记再投递通知：结束门禁看「还有什么在跑」，注销必须先于通知可见
                    BackgroundNoticeCenter.unregisterRunning(token);
                    BackgroundNoticeCenter.publish(owner,
                            BackgroundNoticeCenter.Notice.ofSubagent(token, index, task.agent_name, task.description,
                                    isFailureResult(result) == false,
                                    truncateTaskResult(result, NOTICE_SUMMARY_MAX_CHARS)));
                })
                .exceptionally(ex -> {
                    BackgroundNoticeCenter.unregisterRunning(token);
                    notifyFailure(owner, token, task, index, ex);
                    return null;
                });

        return token;
    }

    /**
     * 补发一条「异常完成」通知。
     *
     * <p><b>为何不能不发</b>：异常若只写日志，模型会一直以为任务还在跑——本轮不收就等下轮，
     * 下轮没有通知就继续等，直到 TTL 把 token 驱逐掉才回「token 不存在」。
     * 一条明确的失败通知能立刻止损，让模型改派或放弃。</p>
     */
    private void notifyFailure(String owner, String token, MultiTaskOp task, Integer index, Throwable ex) {
        Throwable cause = (ex instanceof CompletionException && ex.getCause() != null) ? ex.getCause() : ex;
        if (LOG.isErrorEnabled()) {
            LOG.error("后台任务通知投递失败[{} - {}]: {}", token, task.agent_name, describe(cause), cause);
        }
        BackgroundNoticeCenter.publish(owner, BackgroundNoticeCenter.Notice.ofSubagent(
                token, index, task.agent_name, task.description, false,
                "ERROR: 后台任务异常终止: " + describe(cause)));
    }

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

    // ─────────────────────────────────────────────────────────────────
    // 后台子代理的前端可视化推送
    // ─────────────────────────────────────────────────────────────────

    /**
     * 后台子代理的前端可视化回调。
     *
     * <p><b>为什么必须存在</b>：{@code background=true} 的子代理走 detached 同步分支
     * （见 {@link #taskDo} 的 {@code detached} 形参），该分支刻意不读写父 trace 的 streamSink
     * ——父 sink 在 {@code agent.call()} 返回时就已 complete，往里 {@code next} 是静默 no-op。
     * 代价是后台子代理在前端<b>完全隐形</b>：连卡片都不出现，用户无从得知有任务在跑。
     * 本接口即绕开父 sink、直连 WebSocket 广播通道的旁路。</p>
     *
     * <p><b>为什么用 listener 而非直接调 WebGate</b>：WebGate 未注册进 Solon bean 容器
     * （{@code Configurator} 只把它交给 {@code WebSocketRouter}），而 TaskTalent 由
     * HarnessEngine 构造，拿不到 WebGate 引用。这里照 {@code FileChangeService.setListener}
     * 的既有范式反向注册，使 TaskTalent 不依赖 WebChunk / WebGate 任何类型。</p>
     *
     * <p>三个方法的 {@code resultSummary} 均已是<b>截断后</b>的安全长度，实现方可直接落盘。
     * 全部为 default 空实现，便于测试只覆盖关心的事件。</p>
     */
    public interface BackgroundAgentListener {
        /** 后台子代理启动：前端据此建卡（loading 态）。 */
        default void onStart(String sessionId, String agentName, String description, String invocationId) {}

        /** 进度心跳：只携带当前工具名，供卡片显示「正在做什么」。 */
        default void onProgress(String sessionId, String agentName, String description,
                                String invocationId, String toolName) {}

        /** 后台子代理结束：前端据此收卡（成功/失败态 + 摘要）。 */
        default void onEnd(String sessionId, String agentName, String description,
                           boolean success, String resultSummary, String invocationId) {}
    }

    private volatile BackgroundAgentListener backgroundAgentListener;

    /** 由 WebGate 构造器反向注册（范式同 {@code FileChangeService.setListener}）。 */
    public void setBackgroundAgentListener(BackgroundAgentListener listener) {
        this.backgroundAgentListener = listener;
    }

    /**
     * 卡片可视化通道是否已接通。
     *
     * <p>提交回执必须据此如实降级：通道未接通时若仍宣称「卡片会展示」，等于给用户一个
     * 永远不兑现的承诺（与 {@link #noticeAvailable()} 对通知的处理同构）。</p>
     */
    boolean backgroundAgentVisible() {
        return backgroundAgentListener != null;
    }

    /**
     * 卡片摘要长度上限。
     *
     * <p>必须与 {@code AgentEndEvent.getResultSummary()} 的 200 字符截断对齐：该事件类在流式
     * 分支承担截断职责，而 detached 分支绕过了事件类、直接调 listener，若不在此处补一刀，
     * 子代理的完整结果（动辄数万字符）会被 {@code emitToClient} 永久写进 stream.ndjson，
     * 此后每次回放都重读一遍。</p>
     */
    private static final int CARD_SUMMARY_MAX_CHARS = 200;

    /** 与 AgentEndEvent 同口径的摘要截断（超长时补省略号），使两条分支的卡片摘要形态一致。 */
    private static String truncateCardSummary(String result) {
        if (result == null) {
            return "";
        }
        if (result.length() <= CARD_SUMMARY_MAX_CHARS) {
            return result;
        }
        return result.substring(0, CARD_SUMMARY_MAX_CHARS) + "...";
    }

    /**
     * 投递一次后台子代理可视化事件。
     *
     * <p>三个 emit 方法共用同一套降级纪律：整体包 try/catch 且只记 WARN。推送纯属展示增强，
     * WebSocket 断开、序列化失败、实现方抛异常都<b>不得</b>让子代理任务本身失败——否则会把
     * 一次「前端没连上」误报成「子代理执行失败」回灌给模型，模型据此重派一个本来跑得好好的任务。</p>
     */
    private void emitBackgroundStart(String sessionId, MultiTaskOp task, String invocationId) {
        BackgroundAgentListener l = backgroundAgentListener;
        if (l == null) {
            return;
        }
        try {
            l.onStart(sessionId, task.agent_name, task.description, invocationId);
        } catch (Throwable e) {
            LOG.warn("后台子代理启动帧推送失败[{} - {}]: {}", invocationId, task.agent_name, describe(e));
        }
    }

    private void emitBackgroundProgress(String sessionId, MultiTaskOp task, String invocationId, String toolName) {
        BackgroundAgentListener l = backgroundAgentListener;
        if (l == null) {
            return;
        }
        try {
            l.onProgress(sessionId, task.agent_name, task.description, invocationId, toolName);
        } catch (Throwable e) {
            LOG.warn("后台子代理进度帧推送失败[{} - {}]: {}", invocationId, toolName, describe(e));
        }
    }

    private void emitBackgroundEnd(String sessionId, MultiTaskOp task, String invocationId,
                                   boolean success, String resultSummary) {
        BackgroundAgentListener l = backgroundAgentListener;
        if (l == null) {
            return;
        }
        try {
            l.onEnd(sessionId, task.agent_name, task.description, success,
                    truncateCardSummary(resultSummary), invocationId);
        } catch (Throwable e) {
            LOG.warn("后台子代理结束帧推送失败[{} - {}]: {}", invocationId, task.agent_name, describe(e));
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // 后台任务的取消登记（用户 Stop 必须能停掉后台子代理）
    // ─────────────────────────────────────────────────────────────────

    /**
     * 活跃后台任务的取消标记表：归属会话 → (invocationId → 取消位)。
     *
     * <p><b>为什么需要它</b>：detached 分支跑的是同步 {@code blockLast()}，没有流式分支那条
     * {@code takeUntil(r -> sink.isCancelled())} 的取消链；而 {@code WebGate.interruptSession}
     * 只 dispose 主会话的 disposable，触及不到后台 future。结果是用户点 Stop 后主对话停了、
     * 后台子代理仍在把模型调完——白烧 token，且用户以为已经停了。</p>
     *
     * <p><b>为什么不靠 {@code future.cancel(true)} 中断线程</b>：子代理可能正在执行 write/edit
     * 等落盘操作，外部中断会留下写一半的文件状态（口径同 {@link #registerBackgroundTask}
     * 关于 TTL 不 interrupt 的说明）。这里只在流的 {@code takeUntil} 上做协作式取消：
     * 让当前这一步自然收敛，下一个事件到达时停流。</p>
     *
     * <p>按 sessionId 分桶，使 {@link #cancelBackgroundTasks} 能只停指定会话的后台任务，
     * 不误伤其他会话。</p>
     */
    private final Map<String, Map<String, AtomicBoolean>> backgroundCancelFlags = new ConcurrentHashMap<>();

    private void registerCancellable(String sessionId, String invocationId, AtomicBoolean flag) {
        if (Assert.isEmpty(sessionId) || invocationId == null) {
            return;
        }
        backgroundCancelFlags.computeIfAbsent(sessionId, k -> new ConcurrentHashMap<>())
                .put(invocationId, flag);
    }

    private void unregisterCancellable(String sessionId, String invocationId) {
        if (Assert.isEmpty(sessionId) || invocationId == null) {
            return;
        }
        Map<String, AtomicBoolean> bySession = backgroundCancelFlags.get(sessionId);
        if (bySession == null) {
            return;
        }
        bySession.remove(invocationId);
        // 会话桶空了就摘掉，否则 backgroundCancelFlags 会随历史会话无限增长
        if (bySession.isEmpty()) {
            backgroundCancelFlags.remove(sessionId, bySession);
        }
    }

    /**
     * 取消指定会话的全部后台子代理，返回实际置位的任务数。
     *
     * <p>由 {@code WebGate.interruptSession} 在用户点 Stop 时调用。返回值仅用于日志，
     * 不影响中断结果。</p>
     */
    public int cancelBackgroundTasks(String sessionId) {
        if (Assert.isEmpty(sessionId)) {
            return 0;
        }
        Map<String, AtomicBoolean> bySession = backgroundCancelFlags.get(sessionId);
        if (bySession == null || bySession.isEmpty()) {
            return 0;
        }
        int n = 0;
        for (AtomicBoolean flag : bySession.values()) {
            if (flag != null && flag.compareAndSet(false, true)) {
                n++;
            }
        }
        return n;
    }

    /** 清理已删除会话的取消标记桶（由 WebGate.cleanupSession 调用）。 */
    public void discardBackgroundTasks(String sessionId) {
        if (Assert.isEmpty(sessionId)) {
            return;
        }
        backgroundCancelFlags.remove(sessionId);
    }

    // ─────────────────────────────────────────────────────────────────
    // background 任务注册与 await
    // ─────────────────────────────────────────────────────────────────

    /**
     * 注册表驱逐 TTL。
     *
     * <p>必须大于流层的单次调用总上限（约 25 分钟）：TTL 若短于它，一个正常跑着的长任务会在
     * 出结果之前就被驱逐，随后 await_tasks 只能回「token 不存在」，而任务仍在后台白烧 token。</p>
     */
    private static final long BACKGROUND_TTL_MINUTES = 60;

    /** 一条后台任务登记项：结果 future + 归属会话（token 跨会话隔离用）。 */
    private static final class BackgroundTask {
        final String sessionId;
        final CompletableFuture<String> future;

        BackgroundTask(String sessionId, CompletableFuture<String> future) {
            this.sessionId = sessionId;
            this.future = future;
        }
    }

    /**
     * 注册后台任务，返回 token。
     *
     * <p><b>为何要带 sessionId：</b>TaskTalent 是 HarnessEngine 级单实例（HarnessEngine L890），
     * 而 engine 在 Configurator L137 按工作区创建并长期存活。注册表不分会话时，
     * A 会话拿到的 token 在 B 会话里也能 await 出结果——跨会话读取他人子代理产出。</p>
     *
     * <p><b>为何不用 orTimeout 做驱逐：</b>{@code orTimeout} 只让 future 异常完成，
     * <b>不会中断已在运行的 supplyAsync 任务</b>，子代理照常把模型调完（白烧 token）；
     * 更糟的是它使 future 立即异常完成 → whenComplete 立即驱逐，而模型往往在下一轮才 await，
     * 结果就是「任务还在跑，token 已经没了」。改为统一 TTL：完成与否都在
     * BACKGROUND_TTL_MINUTES 后移除，既防泄漏又不丢结果。</p>
     *
     * <p><b>为何不在超时后 interrupt 工作线程：</b>子代理可能正在执行 write/edit 等落盘操作，
     * 外部中断会留下写一半的文件状态，比白烧完这一轮更糟；燃烧本身已由流层单次调用总上限封顶。</p>
     *
     * <p><b>为何 TTL 清理必须走 {@link RunUtil#timer()} 而非 {@link RunUtil#io()}：</b>
     * io() 是并行工作池（JDK 21+ 为无界虚拟线程池；本项目跑 JDK 17，退化为
     * {@code newFixedThreadPool(max(CPU×4, 16))}，本机 16 核即 64 个平台线程）。若在此池里
     * {@code execute(() -> Thread.sleep(60min))}，每登记一个后台任务就<b>额外占死一个平台线程空睡
     * 60 分钟</b>——平台线程 sleep 不会像虚拟线程那样卸载。叠加子代理 blockLast() 本身占用的线程，
     * 长会话派几十个后台任务就能把固定池耗尽，后续 supplyAsync 排队 → background 退化成伪异步。
     * timer() 是 {@code ScheduledThreadPoolExecutor}，{@code schedule()} 靠延时队列在到期时才唤醒
     * 工作线程，延时期间<b>不占用任何线程</b>，一个池可挂成千上万个待触发的 TTL。子代理本体的
     * blockLast() 仍需一个可阻塞的工作线程，故留在 io() 不动。</p>
     */
    String registerBackgroundTask(String sessionId, CompletableFuture<String> future) {
        String token = UUID.randomUUID().toString();
        BackgroundTask entry = new BackgroundTask(sessionId, future);
        taskRegistry.put(token, entry);

        // schedule() 延时期间不占线程（延时队列唤醒），compare-and-remove 只移除自己登记的那一条。
        RunUtil.timer().schedule(
                () -> taskRegistry.remove(token, entry),
                BACKGROUND_TTL_MINUTES, TimeUnit.MINUTES);

        return token;
    }

    /**
     * 截断单条任务结果至 maxChars，保留头尾各半，中间插省略标记。
     * 结果不超限时原样返回（不复制字符串）。
     *
     * <p>切点必须避开 surrogate pair：中文/emoji 在 UTF-16 下占两个 char，按固定下标切会产生
     * 孤立代理项，序列化成 JSON 发给模型时报非法字符或变成 U+FFFD。</p>
     */
    static String truncateTaskResult(String result, int maxChars) {
        if (result == null || maxChars <= 0 || result.length() <= maxChars) {
            return result;
        }
        int half = maxChars / 2;
        int headEnd = half;
        if (headEnd > 0 && Character.isHighSurrogate(result.charAt(headEnd - 1))) {
            headEnd--; // 不把高代理项留在头部末尾
        }
        int tailStart = result.length() - half;
        if (tailStart < result.length() && Character.isLowSurrogate(result.charAt(tailStart))) {
            tailStart++; // 不把低代理项留在尾部开头
        }
        // 无需处理「头尾窗口重叠」：进入本方法的前提是 result.length() > maxChars，而
        // tailStart - headEnd >= len - 2*half >= 1（2*half <= maxChars），恒不重叠；
        // surrogate 内缩只会让 headEnd 变小、tailStart 变大，差距只增不减。
        // （曾为此写过一条退化分支 + 一条对应测试，变异验证发现该分支不可达、
        // 测试永远绿——属于典型的绿色假象，已删除。）
        int omitted = tailStart - headEnd;
        return result.substring(0, headEnd)
                + "\n...[结果已截断，省略 " + omitted + " 字符]...\n"
                + result.substring(tailStart);
    }

    @ToolMapping(name = TOOL_AWAIT_TASKS, description =
            "等待一或多个 background=true 提交的后台任务完成并返回结果。" +
            "传入 task() 返回的 token 列表；max_result_chars 控制单条结果最大字符数（头尾各半保留，默认 0 = 不限制）。" +
            "注：后台任务完成时已自动推送通知（含结果摘要，在下一轮推理开始时注入消费），若摘要已足够作答则无需调用本工具；仅在需要完整结果或摘要缺失时使用。")
    public String awaitTasks(
            @Param(name = "tokens", description = "要等待的后台任务 token 列表")
            List<String> tokens,
            @Param(name = "max_result_chars", required = false, description = "单条结果最大字符数，0=不限制", defaultValue = "0")
            int maxResultChars,
            @Param(name = "timeout_seconds", required = false, description = "本次调用整体最多等待的秒数（所有 token 共享这一预算，不是每个 token 各自计），默认 300", defaultValue = "300")
            int timeoutSeconds,
            String __sessionId) {

        if (tokens == null || tokens.isEmpty()) {
            return "WARNING: token 列表为空";
        }
        int effectiveTimeout = timeoutSeconds <= 0 ? 300 : timeoutSeconds;

        // 整体 deadline 语义（D-1 修复）：timeout_seconds 是「本次 await 调用整体最多等多久」，
        // 不是「每个 token 各自等多久」。后台任务本就是并行跑的，若逐个 future.get(effectiveTimeout)
        // 会把等待时间重复累加——传 3 个 token 最坏等 3×effectiveTimeout。改为循环外算一次
        // nanoTime 基准的 deadline，每个 token 只等「剩余预算」；前面的 token 把预算用光后，
        // 后续 token 立即走「整体已用尽」分支，不再叠加。用 nanoTime 而非 currentTimeMillis：
        // 后者受系统时钟回拨影响，deadline 可能算出负值或无限延长。
        final long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(effectiveTimeout);

        StringBuilder sb = new StringBuilder();
        sb.append("<await_results>\n");
        for (String token : tokens) {
            BackgroundTask entry = (token == null) ? null : taskRegistry.get(token);
            // 归属校验：不存在、已驱逐、或属于另一个会话，一律用同一句文案
            // （不向模型泄露他会话是否存在该 token，避免拿 token 当探针）
            if (entry == null || (Assert.isNotEmpty(__sessionId) && __sessionId.equals(entry.sessionId) == false)) {
                sb.append("<result token=\"").append(token).append("\">")
                  .append("ERROR: token 不存在、已超时驱逐，或不属于当前会话")
                  .append("</result>\n");
                continue;
            }
            String result;
            // 剩余预算 <=0：整体 deadline 已被前面的 token 用尽，直接报超时不再 get。
            // （刻意不靠 get(负数) 立即抛 TimeoutException 来兜：虽结果相同，但走一次异常路径
            // 且文案会误报成「本 token 等满 effectiveTimeout」，与「整体预算已尽」的真实语义不符。）
            long remain = deadline - System.nanoTime();
            if (remain <= 0) {
                result = "ERROR: 等待超时（整体 " + effectiveTimeout + "s 预算已用尽）；任务仍在后台执行，可稍后重新 await 同一 token";
            } else {
                try {
                    result = entry.future.get(remain, TimeUnit.NANOSECONDS);
                } catch (TimeoutException e) {
                    result = "ERROR: 等待超时（整体 " + effectiveTimeout + "s）；任务仍在后台执行，可稍后重新 await 同一 token";
                } catch (InterruptedException e) {
                    // 用户 Stop / 客户端断连：恢复中断位，不报错重试
                    Thread.currentThread().interrupt();
                    result = "ERROR: 等待被中断（用户停止或连接断开）";
                } catch (Exception e) {
                    Throwable cause = (e instanceof java.util.concurrent.ExecutionException && e.getCause() != null)
                            ? e.getCause() : e;
                    result = "ERROR: " + describe(cause);
                }
            }
            if (maxResultChars > 0) {
                result = truncateTaskResult(result, maxResultChars);
            }
            sb.append("<result token=\"").append(token).append("\">")
              .append(result)
              .append("</result>\n");
        }
        sb.append("</await_results>");
        sb.append(TODO_UPDATE_REMINDER);
        return sb.toString();
    }

    // ─────────────────────────────────────────────────────────────────
    // DTOs
    // ─────────────────────────────────────────────────────────────────

    public static class SingleTaskOp {
        @Param(name = "agent_name", description = "子代理名称")
        public String agent_name;
        @Param(name = "prompt", description = "发给子代理的详细指令。由于子代理是无状态的（上下文隔离），必须在此提供任务所需的所有背景信息、具体要求及预期输出格式。")
        public String prompt;
        @Param(name = "description", description = "任务内容的极简摘要（如：'重构用户认证逻辑'）。该描述将作为标签出现在执行日志和结果摘要中，用于快速识别任务意图。")
        public String description;
        @Param(name = "background", required = false, description = "是否后台提交：true=立即返回 token，主代理可继续执行、不必干等；任务完成时自动收到 [后台子代理完成] 通知（含结果摘要），无需轮询，确需完整结果时再用 await_tasks 收取。除非结果是下一步立即必需的输入，否则长耗时子任务应优先设 true；false=阻塞等待，会把主流程卡到子代理跑完。task 与 multitask 均支持（multitask 按任务粒度，可与前台任务混在同一批）。", defaultValue = "false")
        public boolean background = false;

        @Override
        public String toString() {
            return "SingleTaskOp{" +
                    "agent_name='" + agent_name + '\'' +
                    ", description='" + description + '\'' +
                    '}';
        }
    }

    /**
     * 多任务定义（multitask 使用）
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