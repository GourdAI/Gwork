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
package com.gourdai.agent.react.task;

import com.gourdai.agent.event.ToolCallEndEvent;
import com.gourdai.agent.event.ToolCallStartEvent;

import org.noear.snack4.ONode;
import org.noear.snack4.json.JsonReader;
import com.gourdai.agent.Agent;
import com.gourdai.agent.team.TeamTrace;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.change.FileChangeService;
import com.gourdai.harness.talents.cli.TerminalTalent;
import com.gourdai.agent.util.FeedbackTool;
import com.gourdai.agent.react.BackgroundNoticeCenter;
import com.gourdai.agent.react.ReActAgent;
import com.gourdai.agent.react.ReActAgentConfig;
import com.gourdai.agent.react.ReActInterceptor;
import com.gourdai.agent.react.ReActTrace;
import org.noear.solon.ai.chat.interceptor.ToolChain;
import org.noear.solon.ai.chat.interceptor.ToolRequest;
import org.noear.solon.ai.chat.message.AssistantMessage;
import org.noear.solon.ai.chat.message.ChatMessage;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.ai.chat.tool.ToolCall;
import org.noear.solon.ai.chat.tool.ToolResult;
import org.noear.solon.core.exception.StatusException;
import org.noear.solon.core.util.Assert;
import org.noear.solon.core.util.RankEntity;
import org.noear.solon.core.util.RunUtil;
import org.noear.solon.flow.FlowContext;
import org.noear.solon.lang.Preview;
import com.gourdai.agent.util.AgentUtil;
import com.gourdai.harness.agent.TaskTalent;
import com.gourdai.harness.agent.WebToolVisibilityPolicy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.StringReader;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeUnit;

/**
 * ReAct 动作执行任务 (Action/Acting)
 * <p>核心职责：解析 Reason 阶段的指令，调用业务工具，并将 Observation（观测结果）回填至上下文。</p>
 *
 * @author oisin
 * @since 3.8.1
 */
@Preview("3.8.1")
public class ActionTask {
    private static final Logger LOG = LoggerFactory.getLogger(ActionTask.class);

    /**
     * 并行只读工具段单工具超时（秒）：与 bash 默认超时对齐。
     * 触发后以 TimeoutException 完成 future，由上层按异常收口，防止单工具卡死拖死整轮流。
     */
    private static final long PARALLEL_TOOL_TIMEOUT_SECONDS = 180;

    /**
     * 只读工具名单：这些工具不修改文件系统、不触发 HITL、不改变路由，
     * 故可安全并行执行（read/grep/glob/ls）。写工具（write/edit/bash）不在此列，保持串行。
     */
    private static final Set<String> READONLY_TOOLS = new HashSet<>(Arrays.asList(
            "read", "grep", "glob", "ls"));

    /**
     * 文本模式无原生 ToolCall id 时的兜底序号源（并发安全）。
     */
    private final java.util.concurrent.atomic.AtomicInteger actionIdSeq = new java.util.concurrent.atomic.AtomicInteger(0);

    private final ReActAgentConfig config;

    public ActionTask(ReActAgentConfig config) {
        this.config = config;
    }

    public String name() {
        return ReActAgent.ID_ACTION;
    }

    public void run(ReActTrace trace, FlowContext context) throws Throwable {
        //重置默认路由
        trace.setRoute(ReActAgent.ID_REASON);

        if (LOG.isDebugEnabled()) {
            if (trace.getOptions().isPlanningMode()) {
                LOG.debug("ReActAgent [{}] action starting... Step: {}, Plan: {}",
                        config.getName(), trace.getStepCount(), trace.getPlanIndex() + 1);
            } else {
                LOG.debug("ReActAgent [{}] action starting (Step: {})...", config.getName(), trace.getStepCount());
            }
        }

        final TeamTrace parentTeamTrace = TeamTrace.getCurrent(context);
        AssistantMessage lastReason = trace.getLastReasonMessage();
        if (lastReason == null) {
            return;
        }

        try {
            if (Assert.isNotEmpty(lastReason.getToolCalls())) {
                // 1. 优先处理原生工具调用（Native Tool Calls）
                processNativeToolCall(lastReason, trace, parentTeamTrace);
            } else {
                // 2. 文本模式：解析模型输出中的 Action 块
                processTextModeAction(lastReason, trace, parentTeamTrace);
            }
        } finally {
            //刷新快照
            trace.getSession().updateSnapshot();
        }
    }

    private ToolResult doAction(ReActTrace trace, String toolName, Map<String, Object> args, List<ChatMessage> toolResults,
                                ToolCall call, List<String> aliasIds, BatchMetadata batch) {
        if (LOG.isDebugEnabled()) {
            LOG.debug("Action for agent [{}], toolName:{}, args:{}", config.getName(), toolName, args);
        }

        // 工具调用标识：原生调用用 ToolCall.id；文本模式无 id 时按 toolName+全局递增序号生成，保证并发下 action/observation 可配对
        final String actionId = (call != null && call.getId() != null)
                ? call.getId()
                : (toolName + "#" + actionIdSeq.incrementAndGet());

        ToolExchanger toolExchanger = new ToolExchanger(toolName, args);

        // 1. 触发前置生命周期
        for (RankEntity<ReActInterceptor> item : trace.getOptions().getInterceptors()) {
            if (item.target.isEnabled()) {
                item.target.onAction(trace, toolExchanger);
            }
        }

        // 2. 如果前置拦截器直接挂起或截断了路由，立刻退出（交给 finally 闭环）
        if (trace.getSession().isPending() || Agent.ID_END.equals(trace.getRoute())) {
            return null;
        }

        // 3. 推送流式动作片
        if (trace.getOptions().getStreamSink() != null) {
            trace.getOptions().getStreamSink().next(new ToolCallStartEvent(trace, toolName, args, actionId,
                    batch.batchId, batch.batchIndex, batch.batchSize));
        }

        long startMs = System.currentTimeMillis();
        ToolResult result = null;
        Throwable thrownError = null;

        FileChangeService.Capture fileCapture = null;
        try {
            // 4. 执行工具调用。write/edit 只在 Agent 工具边界做前后快照；bash 不扫描工作区，
            // 仅把该 run 标为 possiblyIncomplete。
            String changeRoot = toolContextText(trace, HarnessEngine.ATTR_CWD);
            // 变更归属：子代理跑在独立 session/runId 上，若按各自 trace 落账，manifest 会写进前端查不到的
            // 孤儿目录（见 FileChangeService.ATTR_CHANGE_*）。TaskTalent 会透传主 run 归属，这里优先采用。
            // 必须成对生效，否则会出现「主 sessionId 配子 runId」的混合归属，产生新的孤儿账本。
            String changeSessionId = trace.getSession().getSessionId();
            String changeRunId = trace.getRunId();
            String ownerSessionId = toolContextText(trace, FileChangeService.ATTR_CHANGE_SESSIONID);
            String ownerRunId = toolContextText(trace, FileChangeService.ATTR_CHANGE_RUNID);
            if (Assert.isNotEmpty(ownerSessionId) && Assert.isNotEmpty(ownerRunId)) {
                changeSessionId = ownerSessionId;
                changeRunId = ownerRunId;
            }
            if (TerminalTalent.TOOL_WRITE.equals(toolName) || TerminalTalent.TOOL_EDIT.equals(toolName)) {
                fileCapture = FileChangeService.getInstance().before(
                        changeSessionId, changeRunId, changeRoot,
                        AgentUtil.asStringArg(args, "file_path"));
            } else if ("bash".equals(toolName)) {
                FileChangeService.getInstance().markBash(changeSessionId, changeRunId, changeRoot);
            }

            if (Assert.isEmpty(toolExchanger.getResult())) {
                result = executeTool(trace, toolName, args);
            } else {
                result = ToolResult.success(toolExchanger.getResult());
            }

            if (result != null && !trace.getSession().isPending() && !Agent.ID_END.equals(trace.getRoute())) {
                toolExchanger.setResult(result.getContent());
            }

            // 最终返回当前轮次处理后的最新观测值
            return toolExchanger.getResult() != null ? ToolResult.success(toolExchanger.getResult()) : null;

        } catch (Throwable e) {
            thrownError = e;
            throw e;
        } finally {
            if (fileCapture != null) {
                FileChangeService.getInstance().after(fileCapture);
            }
            // ================== 【100% 强物理闭环】 ==================
            long durationMs = System.currentTimeMillis() - startMs;
            ChatMessage observationMessage = null;

            if (thrownError != null) {
                if (call == null) {
                    observationMessage = ChatMessage.ofUser("Observation: Execution critical error: " + thrownError.getMessage());
                } else {
                    observationMessage = ChatMessage.ofTool(
                            ToolResult.error("Execution critical error: " + thrownError.getMessage()),
                            call.getName(),
                            call.getId(),
                            false
                    );
                }
            } else if (toolExchanger.getResult() != null) {
                if (call == null) {
                    observationMessage = ChatMessage.ofUser("Observation: " + toolExchanger.getResult());
                } else {
                    observationMessage = ChatMessage.ofTool(ToolResult.success(toolExchanger.getResult()), call.getName(), call.getId(), false);
                }
            }

            // 无论正常结束、挂起退出、还是中途抛出 critical error，100% 走统一清理与下发逻辑
            handleSingleObservation(trace, toolExchanger, observationMessage, durationMs, thrownError, toolResults,
                    actionId, batch);

            // 同轮完全相同调用去重的回填：重复 id 不执行、不推流式卡（前端只渲染一张），
            // 但工作记忆需按 id 各补一条 tool 结果，保证 tool_calls ↔ observation 协议配对完整
            if (aliasIds != null && toolResults != null && observationMessage != null && call != null) {
                for (String aliasId : aliasIds) {
                    if (thrownError != null) {
                        toolResults.add(ChatMessage.ofTool(
                                ToolResult.error("Execution critical error: " + thrownError.getMessage()),
                                call.getName(), aliasId, false));
                    } else if (toolExchanger.getResult() != null) {
                        toolResults.add(ChatMessage.ofTool(ToolResult.success(toolExchanger.getResult()), call.getName(), aliasId, false));
                    }
                }
            }
        }
    }

    /**
     * 处理标准 ToolCall 协议调用
     *
     * <p>执行策略：将本轮工具调用按出现顺序切成若干「段」——连续的只读工具（read/grep/glob/ls）
     * 归为一个可并行段，其余工具各自成段串行执行。只读段内 ≥2 个工具时用共享 IO 线程池并行执行，
     * 结果按原始顺序回填，保证与串行执行的可观测行为一致（工作记忆消息成套且不错位）。
     * 单个工具、或并行开关关闭时，退化为纯串行，与改造前完全等价。</p>
     */
    private void processNativeToolCall(AssistantMessage lastReason, ReActTrace trace, TeamTrace parentTeamTrace) throws Throwable {
        List<ChatMessage> toolResults = new ArrayList<>();

        // 同轮完全相同调用去重（模型偶发输出重复的并行 tool_calls，如同名同参两次 todowrite）：
        // 仅首个真正执行并推一张卡，重复 id 记录别名、执行后按 id 回填结果，避免双执行与双卡片
        Map<String, List<String>> aliasIdsByPrimaryId = new HashMap<>();
        List<ToolCall> calls = dedupeIdenticalCalls(lastReason.getToolCalls(), aliasIdsByPrimaryId);
        Map<ToolCall, BatchMetadata> batchByCall = createVisibleBatch(calls);

        // 是否存在可并行的只读段（≥2 个连续只读工具）；否则直接走串行快路径。
        // 并行行为恒开启：只读段（read/grep/glob/ls）并行，写工具（write/edit/bash）始终串行。
        if (!hasParallelReadonlyRun(calls)) {
            runCallsSerial(calls, trace, toolResults, aliasIdsByPrimaryId, batchByCall);
            flushToolResults(lastReason, trace, toolResults);
            return; // 串行路径：中止与否都已在 toolResults 落地，直接返回
        }

        // 混合路径：按顺序切段，只读段并行、其余串行；任一段触发中止（返回 null）即停止后续段。
        int i = 0;
        boolean aborted = false;
        while (i < calls.size() && !aborted) {
            ToolCall first = calls.get(i);
            if (isReadonlyCall(first)) {
                // 收集连续的只读段
                int j = i;
                while (j < calls.size() && isReadonlyCall(calls.get(j))) {
                    j++;
                }
                List<ToolCall> segment = calls.subList(i, j);
                if (segment.size() == 1) {
                    aborted = !doActionInto(segment.get(0), trace, toolResults, aliasIdsByPrimaryId, batchByCall);
                } else {
                    aborted = runReadonlySegmentParallel(segment, trace, toolResults, aliasIdsByPrimaryId, batchByCall);
                }
                i = j;
            } else {
                aborted = !doActionInto(first, trace, toolResults, aliasIdsByPrimaryId, batchByCall);
                i++;
            }
        }

        flushToolResults(lastReason, trace, toolResults);
    }

    /**
     * 串行执行一批工具，结果依序追加到 toolResults。
     *
     * @return 是否中止（某工具返回 null：挂起/END/被拦截）
     */
    private boolean runCallsSerial(List<ToolCall> calls, ReActTrace trace, List<ChatMessage> toolResults,
                                   Map<String, List<String>> aliasIdsByPrimaryId,
                                   Map<ToolCall, BatchMetadata> batchByCall) {
        for (ToolCall call : calls) {
            if (!doActionInto(call, trace, toolResults, aliasIdsByPrimaryId, batchByCall)) {
                return true;
            }
        }
        return false;
    }

    /**
     * 并行执行一个「只读段」（≥2 个只读工具）。每个工具在独立线程执行并写入各自的临时结果列表，
     * 全部完成后按原始顺序合并回 toolResults，保证顺序稳定。
     *
     * <p>只读工具不会 setRoute(END)、不会 pending、不触发 HITL，故并行段内不存在提前中止；
     * 但仍在合并后由调用方在下一段前检查 isPending/route。streamSink 为 reactor 串行化 sink，
     * 并发 next() 安全（仅到达顺序不保证，前端靠工具标识关联）。</p>
     *
     * @return 是否中止（并行只读段恒为 false；保留返回值以统一调用形态）
     */
    private boolean runReadonlySegmentParallel(List<ToolCall> segment, ReActTrace trace, List<ChatMessage> toolResults,
                                               Map<String, List<String>> aliasIdsByPrimaryId,
                                               Map<ToolCall, BatchMetadata> batchByCall) throws Throwable {
        int n = segment.size();
        List<List<ChatMessage>> slots = new ArrayList<>(n);
        for (int k = 0; k < n; k++) {
            slots.add(new ArrayList<>());
        }

        List<CompletableFuture<Void>> futures = new ArrayList<>(n);
        for (int k = 0; k < n; k++) {
            final ToolCall call = segment.get(k);
            final List<ChatMessage> slot = slots.get(k);
            futures.add(CompletableFuture.runAsync(
                    () -> doActionInto(call, trace, slot, aliasIdsByPrimaryId, batchByCall), RunUtil.io())
                    // 防挂死兑底：任务卡死/被队列饿死时以 TimeoutException 完成，
                    // 避免 allOf().join() 无限阻塞进而拖死整轮 ReAct 流（done 永不发射）。
                    // 超时后上层按异常收口，前端仍能收到 error+done 收敛。
                    .orTimeout(PARALLEL_TOOL_TIMEOUT_SECONDS, TimeUnit.SECONDS));
        }

        try {
            CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();
        } catch (CompletionException ce) {
            // 单个工具执行异常已在 doAction 的 finally 内转成 Observation（executeTool 不抛业务异常），
            // 这里兜底处理线程层面的意外，抛出让上层按异常收口。
            Throwable cause = ce.getCause();
            throw (cause != null) ? cause : ce;
        } catch (java.util.concurrent.CancellationException ignored) {
            // 流被取消（用户中断）：传播中断，取消未完成的子任务
            for (CompletableFuture<Void> f : futures) {
                f.cancel(true);
            }
            Thread.currentThread().interrupt();
        }

        // 若外层线程被中断（stream onCancel → interrupt），取消剩余并传播
        if (Thread.currentThread().isInterrupted()) {
            for (CompletableFuture<Void> f : futures) {
                f.cancel(true);
            }
        }

        // 按原始顺序合并结果
        for (List<ChatMessage> slot : slots) {
            toolResults.addAll(slot);
        }

        return false;
    }

    /**
     * 执行单个工具并把观测结果写入指定结果列表。
     *
     * @return true=正常产出（可继续）；false=中止（doAction 返回 null：挂起/END/拦截）
     */
    private boolean doActionInto(ToolCall call, ReActTrace trace, List<ChatMessage> resultsSink,
                                 Map<String, List<String>> aliasIdsByPrimaryId,
                                 Map<ToolCall, BatchMetadata> batchByCall) {
        Map<String, Object> args = (call.getArguments() == null) ? new HashMap<>() : call.getArguments();
        List<String> aliasIds = (call.getId() != null && aliasIdsByPrimaryId != null) ? aliasIdsByPrimaryId.get(call.getId()) : null;
        ToolResult result = doAction(trace, call.getName(), args, resultsSink, call, aliasIds,
                batchByCall.getOrDefault(call, BatchMetadata.NONE));
        return result != null;
    }

    /**
     * 同轮完全相同调用去重：模型偶发在同一轮输出内容完全一致的并行 tool_calls
     * （同名 + 同参，如两个一模一样的 todowrite/grep）。若不去重，每个调用都会真实执行
     * 并各推一条 ToolCallStartEvent，前端据此渲染出两张完全相同的工具卡片（如「任务清单」展示两次），
     * 写工具/命令还会产生重复副作用。此处按「工具名 + 参数序列化」分组，仅保留首个调用进入执行管线，
     * 其余重复调用的 id 记入 {@code aliasIdsByPrimaryId}，由 doAction 在执行后按 id 回填结果
     * （不推额外流式块），保证协议配对完整且 UI 只出一张卡。
     */
    private List<ToolCall> dedupeIdenticalCalls(List<ToolCall> calls, Map<String, List<String>> aliasIdsByPrimaryId) {
        if (calls == null || calls.size() <= 1) {
            return calls;
        }
        Map<String, ToolCall> firstByKey = new LinkedHashMap<>();
        List<ToolCall> result = new ArrayList<>(calls.size());
        for (ToolCall call : calls) {
            if (call == null || call.getId() == null) {
                // 无 id 的调用无法做别名回填，保持原样独立执行（不可丢弃）
                result.add(call);
                continue;
            }
            Map<String, Object> args = (call.getArguments() == null) ? new HashMap<>() : call.getArguments();
            String key = call.getName() + "\u0000" + ONode.serialize(args);
            ToolCall primary = firstByKey.get(key);
            if (primary == null) {
                firstByKey.put(key, call);
                result.add(call);
            } else {
                aliasIdsByPrimaryId.computeIfAbsent(primary.getId(), k -> new ArrayList<>()).add(call.getId());
            }
        }
        if (aliasIdsByPrimaryId.isEmpty()) {
            return calls;
        }
        if (LOG.isWarnEnabled()) {
            LOG.warn("Agent [{}] deduped {} identical tool call(s) in one turn, aliasIdsByPrimaryId: {}",
                    config.getName(), calls.size() - result.size(), aliasIdsByPrimaryId);
        }
        return result;
    }

    private Map<ToolCall, BatchMetadata> createVisibleBatch(List<ToolCall> calls) {
        Map<ToolCall, BatchMetadata> result = new IdentityHashMap<>();
        List<ToolCall> visibleCalls = new ArrayList<>();
        for (ToolCall call : calls) {
            if (isWebVisibleCall(call)) {
                visibleCalls.add(call);
            }
        }

        if (visibleCalls.size() <= 1) {
            return result;
        }

        String batchId = UUID.randomUUID().toString();
        int batchSize = visibleCalls.size();
        for (int i = 0; i < batchSize; i++) {
            result.put(visibleCalls.get(i), new BatchMetadata(batchId, i, batchSize));
        }
        return result;
    }

    /**
     * 与 WebStreamBuilder/WsGate 的内部工具过滤口径保持一致，使展示批次只统计真正可见的卡。
     * todowrite 虽不发送 start，但会以专用 action_end 卡展示，仍计入可见批次。
     */
    static boolean isWebVisibleCall(ToolCall call) {
        return call != null && WebToolVisibilityPolicy.isBaseVisible(call.getName());
    }

    private static final class BatchMetadata {
        private static final BatchMetadata NONE = new BatchMetadata(null, null, null);
        private final String batchId;
        private final Integer batchIndex;
        private final Integer batchSize;

        private BatchMetadata(String batchId, Integer batchIndex, Integer batchSize) {
            this.batchId = batchId;
            this.batchIndex = batchIndex;
            this.batchSize = batchSize;
        }
    }

    /**
     * 落地工具结果：把本轮推理消息与全部观测结果「成套」写入工作记忆（顺序已保证）。
     */
    private void flushToolResults(AssistantMessage lastReason, ReActTrace trace, List<ChatMessage> toolResults) {
        if (toolResults.size() > 0) {
            //确保"成套"出现，避免错位
            trace.getWorkingMemory().addMessage(lastReason);
            trace.getWorkingMemory().addMessage(toolResults);
        }
    }

    private boolean isReadonlyCall(ToolCall call) {
        return call != null && READONLY_TOOLS.contains(call.getName());
    }

    /**
     * 是否存在「≥2 个连续只读工具」的可并行段。
     */
    private boolean hasParallelReadonlyRun(List<ToolCall> calls) {
        int run = 0;
        for (ToolCall call : calls) {
            if (isReadonlyCall(call)) {
                run++;
                if (run >= 2) {
                    return true;
                }
            } else {
                run = 0;
            }
        }
        return false;
    }

    /**
     * 解析并执行文本模式下的 Action 指令
     * 核心逻辑优化：从“全执行后拼接”改为“逐个执行并即时回填与反馈”
     */
    private void processTextModeAction(AssistantMessage lastReason, ReActTrace trace, TeamTrace parentTeamTrace) throws Throwable {
        String lastContent = lastReason.getResultContent();
        if (Assert.isEmpty(lastContent)) {
            return;
        }

        if (LOG.isDebugEnabled()) {
            LOG.debug("Processing text mode action for agent [{}].", config.getName());
        }

        List<ChatMessage> toolResults = new ArrayList<>();
        int actionLabelIndex = lastContent.indexOf("Action:");
        boolean foundAny = false;

        if (actionLabelIndex >= 0) {
            // 尝试寻找 JSON 起始位置
            int jsonStart = lastContent.indexOf('{', actionLabelIndex + 7);

            if (jsonStart >= 0) {
                // 情况 A：JSON 模式流式解析
                StringReader sr = new StringReader(lastContent.substring(jsonStart));
                JsonReader jsonReader = new JsonReader(sr);

                while (true) {
                    try {
                        ONode actionNode = jsonReader.readNext();
                        if (actionNode == null || !actionNode.isObject()) {
                            break;
                        }

                        foundAny = true;
                        String toolName = actionNode.get("name").getString();
                        ONode argsNode = actionNode.get("arguments");
                        Map<String, Object> args = argsNode.isObject() ? argsNode.toBean(Map.class) : new HashMap<>();

                        ToolResult result = doAction(trace, toolName, args, toolResults, null, null, BatchMetadata.NONE);
                        if (result == null) {
                            return;
                        }
                    } catch (Throwable e) {
                        // 解析异常回传 (优化点 2)
                        ChatMessage observationMessage = ChatMessage.ofUser("Observation: Error parsing Action JSON: " + e.getMessage());
                        toolResults.add(observationMessage);
                        foundAny = true;
                        break;
                    }
                }
            } else {
                // 情况 B：纯文本模式 Action: toolName
                String toolName = lastContent.substring(actionLabelIndex + 7).trim();
                if (trace.getOptions().getTool(toolName) != null || FeedbackTool.TOOL_NAME.equals(toolName)) {
                    foundAny = true;
                    Map<String, Object> args = new HashMap<>();

                    ToolResult result = doAction(trace, toolName, args, toolResults, null, null, BatchMetadata.NONE);
                    if (result == null) {
                        return;
                    }
                }
            }
        }

        // 容错处理：如果声明了 Action 但没解析成功，或模型说话不规整 (优化点 3)
        if (!foundAny && actionLabelIndex >= 0) {
            ChatMessage chatMessage = ChatMessage.ofUser("Observation: No valid Action format detected. Use JSON: {\"name\": \"...\", \"arguments\": {}}");
            toolResults.add(chatMessage);
        }

        if (toolResults.size() > 0) {
            //确保“成套”出现，避免错位
            trace.getWorkingMemory().addMessage(lastReason);
            trace.getWorkingMemory().addMessage(toolResults);
        }
    }

    /**
     * 优化点 4：统一 Observation 落地逻辑。
     * 改变了原有 StringBuilder 拼接逻辑，直接进行 WorkingMemory 入库并触发流
     */
    private void handleSingleObservation(ReActTrace trace, ToolExchanger toolExchanger,
                                         ChatMessage observationMessage, long durationMs,
                                         Throwable error, List<ChatMessage> toolResults, String actionId,
                                         BatchMetadata batch) {

        if (observationMessage == null) {
            if (error == null) {
                error = new RuntimeException("The tool task has been interrupted or pending.");
            }
            observationMessage = ChatMessage.ofAssistant("");
        } else if (toolResults != null) {
            toolResults.add(observationMessage);
        }

        // 1. 流式客户端通知闭环
        if (trace.getOptions().getStreamSink() != null) {
            try {
                trace.getOptions().getStreamSink().next(
                        new ToolCallEndEvent(trace, toolExchanger.getToolName(), toolExchanger.getArgs(), observationMessage,
                                error, durationMs, actionId, batch.batchId, batch.batchIndex, batch.batchSize));
            } catch (Throwable e) {
                LOG.error("Push ToolCallEndEvent failed", e);
            }
        }

        // 2. 拦截器现场清理闭环
        for (RankEntity<ReActInterceptor> entity : trace.getOptions().getInterceptors()) {
            if (entity.target.isEnabled()) {
                try {
                    entity.target.onObservation(trace, toolExchanger, observationMessage, error, durationMs);
                } catch (Throwable e) {
                    LOG.error("Interceptor onObservation execution failed", e);
                }
            }
        }
    }

    /** 从 toolContext 读取字符串值；缺失或空白返回 null。 */
    private static String toolContextText(ReActTrace trace, String key) {
        if (trace.getOptions() == null || trace.getOptions().getToolContext() == null) {
            return null;
        }
        Object value = trace.getOptions().getToolContext().get(key);
        if (value == null) {
            return null;
        }
        String text = String.valueOf(value).trim();
        return text.isEmpty() ? null : text;
    }

    /**
     * 查找并执行工具
     *
     * @return 工具输出的字符串结果
     */
    private ToolResult executeTool(ReActTrace trace, String name, Map<String, Object> args) {
        if (FeedbackTool.TOOL_NAME.equals(name)) {
            String reason = AgentUtil.asStringArg(args, "reason");
            trace.setRoute(Agent.ID_END);
            trace.setFinalAnswer(reason);
            trace.getContext().interrupt();
            return ToolResult.success(reason);
        }

        FunctionTool tool = trace.getOptions().getTool(name);
        if (tool == null) {
            tool = trace.getProtocolTool(name);
        }

        if (tool != null) {
            // 绑定后台任务归属：bash(run_in_background=true) 据此把完成通知投递回本会话。
            // bash 属写工具，恒在 ActionTask 当前线程串行执行（不会落到并行只读段的线程池），
            // 故 ThreadLocal 传递可靠；但必须在 finally 里解绑，否则线程复用会把 A 会话的通知投给 B。
            BackgroundNoticeCenter.bindCurrentOwner(BackgroundNoticeCenter.resolveOwner(trace.getContext()));
            try {
                if (LOG.isDebugEnabled()) {
                    LOG.debug("Agent [{}] invoking tool start [{}], args: {}", config.getName(), name, args);
                }

                //合并工具上个文和参数，形成请求
                final ToolRequest toolReq = new ToolRequest(null, trace.getOptions().getToolContext(), args);
                final ToolResult result;
                if (trace.getOptions().getInterceptors().isEmpty()) {
                    result = tool.call(toolReq.getArgs());
                } else {
                    result = new ToolChain(trace.getOptions().getInterceptors(), tool).doIntercept(toolReq);
                }
                trace.incrementToolCallCount();

                if (LOG.isDebugEnabled()) {
                    LOG.debug("Agent [{}] invoking tool end [{}], args: {}", config.getName(), name, args);
                }

                return result;
            } catch (IllegalArgumentException | StatusException e) {
                // 引导模型自愈：返回 Schema 错误提示
                return ToolResult.success("__ERROR__ Invalid arguments for [" + name + "]. Expected Schema: " + tool.inputSchema() + ". Error: " + e.getMessage());
            } catch (Throwable e) {
                LOG.error("Agent [" + config.getName() + "] tool [" + name + "] execution failed", e);
                return ToolResult.success("__ERROR__ Execution error in tool [" + name + "]: " + e.getMessage());
            } finally {
                BackgroundNoticeCenter.unbindCurrentOwner();
            }
        }

        if (LOG.isWarnEnabled()) {
            LOG.warn("Agent [{}] tool [{}] not found", config.getName(), name);
        }

        return ToolResult.success("__ERROR__ Tool [" + name + "] not found.");
    }
}