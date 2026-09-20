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
package com.gourdai.agent.react;

import org.noear.solon.Utils;
import com.gourdai.agent.Agent;
import com.gourdai.agent.AgentSession;
import com.gourdai.agent.AgentTrace;
import com.gourdai.agent.team.TeamProtocol;
import com.gourdai.agent.trace.Metrics;
import com.gourdai.ai.chat.message.AssistantMessage;
import com.gourdai.ai.chat.message.ChatMessage;
import com.gourdai.ai.chat.message.ToolMessage;
import com.gourdai.ai.chat.message.UserMessage;
import com.gourdai.ai.chat.prompt.Prompt;
import com.gourdai.ai.chat.prompt.PromptImpl;
import com.gourdai.ai.chat.talent.TalentUtil;
import com.gourdai.ai.chat.tool.FunctionTool;
import com.gourdai.ai.chat.tool.ToolCall;
import org.noear.solon.core.util.Assert;
import org.noear.solon.flow.FlowContext;
import org.noear.solon.lang.Preview;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * ReAct 运行轨迹记录器 (状态机上下文)
 * <p>负责维护智能体推理过程中的短期记忆、执行路由、消息序列及上下文压缩。</p>
 *
 * @author oisin
 * @since 3.8.1
 */
@Preview("3.8.1")
public class ReActTrace implements AgentTrace {
    private static final Logger LOG = LoggerFactory.getLogger(ReActTrace.class);

    /**
     * 运行配置
     */
    private transient ReActAgentConfig config;
    /**
     * 运行选项
     */
    private transient ReActOptions options;
    /**
     * Agent 会话上下文
     */
    private transient AgentSession session;
    /**
     * 协作协议 (如 Team 模式)
     */
    private transient TeamProtocol protocol;
    /**
     * 协议注入的专用工具映射表
     */
    private transient final Map<String, FunctionTool> protocolToolMap = new LinkedHashMap<>();

    /**
     * 智能体名字
     */
    private String agentName;

    /**
     * 运行ID
     */
    private String runId;

    /**
     * 度量指标
     */
    private final Metrics metrics = new Metrics();

    /**
     * 任务开始时间
     */
    private long beginTimeMs;
    /**
     * 任务提示词
     */
    private Prompt originalPrompt;
    /**
     * 工作记忆
     */
    private final Prompt workingMemory = new PromptImpl();

    /**
     * 迭代回合计数器
     */
    private AtomicInteger turnCounter = new AtomicInteger(0);
    /**
     * 工具调用计数器
     */
    private AtomicInteger toolCounter = new AtomicInteger(0);

    /**
     * 连续思考计数器
     */
    private transient AtomicInteger emptyRetryCounter = new AtomicInteger(0);

    /**
     * 逻辑路由标识 (REASON, ACTION, END)
     */
    private volatile String route;
    /**
     * 最终回答内容 (Final Answer)
     */
    private volatile String finalAnswer;
    /**
     * 是否异常（结束的）
     */
    private volatile boolean abnormal;
    /**
     * 模型最近一次原始思考内容
     */
    private AssistantMessage lastReasonMessage;

    /**
     * 计划
     */
    private final List<String> plans = new CopyOnWriteArrayList<>();
    private int planIndex;

    /**
     * extras 键：本回合注入过「用户实时补充（插话）」时记录的回合号（Integer）。
     *
     * <p>插话以普通 user 消息注入工作记忆，模型极易把它当成一次对话提问：只回一句
     * 「收到」而不带任何工具调用，于是被 ReasonTask 的隐式结束分支判为「任务已完成」，
     * 整个 run 直接 END——表现就是「插一句话，任务自己停了」。</p>
     *
     * <p>该键只在「注入插话的那一个回合」有效，且在结束判定处读取即消费（限一次），
     * 用于把这一次隐式 END 改判为「继续执行原任务」。健康流程（无插话）恒不存在此键。</p>
     */
    public static final String EXTRA_STEER_CONTINUE_TURN = "_steer_continue_turn";

    /**
     * extras 键：用户主动停止（interrupt）且任务未完成时置位（Boolean.TRUE）。
     *
     * <p>用户取消不经过库的异常兜底（abnormal 不会置位），执行流最终停在 route=END
     * 但 abnormal=false——若不单独打标，随后发来的「继续」会被判为新任务、断点工作记忆
     * （推理 + 工具结果）被整体重置，此前消耗的上下文无法复用。置位后由
     * {@code HarnessEngine.canResume} 与 abnormal 一并作为可续跑依据；续跑消费
     * （prepareResume）或新任务重置（reset 清空 extras）时清除。该键随快照落盘，
     * 进程重启后仍可判定。</p>
     */
    public static final String EXTRA_USER_INTERRUPTED = "_user_interrupted";

    private final Map<String, Object> extras = new ConcurrentHashMap<>();

    public Map<String, Object> getExtras() {
        return extras;
    }

    public Object getExtra(String key) {
        return extras.get(key);
    }

    public <T> T getExtraAs(String key) {
        return (T) extras.get(key);
    }

    public void setExtra(String key, Object val) {
        if (val == null) {
            extras.remove(key);
        } else {
            extras.put(key, val);
        }
    }

    public void removeExtra(String key) {
        extras.remove(key);
    }

    /** 是否被用户主动停止且可续跑（见 {@link #EXTRA_USER_INTERRUPTED}）。 */
    public boolean isUserInterrupted() {
        return Boolean.TRUE.equals(extras.get(EXTRA_USER_INTERRUPTED));
    }

    /** 置位「用户主动停止」续跑标记（由 HarnessEngine.markUserInterruptedForResume 统一调用）。 */
    public void markUserInterrupted() {
        extras.put(EXTRA_USER_INTERRUPTED, Boolean.TRUE);
    }

    /** 清除「用户主动停止」续跑标记（续跑已消费或新任务重置）。 */
    public void clearUserInterrupted() {
        extras.remove(EXTRA_USER_INTERRUPTED);
    }

    public ReActTrace() {
        //反序列化用
        this.route = ReActAgent.ID_REASON;
    }

    public static ReActTrace getCurrent(FlowContext context) {
        String traceKey = context.getAs(Agent.KEY_CURRENT_UNIT_TRACE_KEY);
        if (traceKey != null) {
            return context.getAs(traceKey);
        } else {
            return null;
        }
    }

    // --- 生命周期与状态管理 ---

    /**
     * 准备执行环境
     */
    protected void prepare(ReActAgentConfig config, ReActOptions options, AgentSession session, TeamProtocol protocol, String agentName) {
        this.config = config;
        this.agentName = agentName;
        this.options = options;
        this.session = session;
        this.protocol = protocol;
        this.finalAnswer = null;
        this.abnormal = false;

        //每次执行重置中断状态
        session.pending(false, null);
    }

    protected void activeTalents() {
        if (originalPrompt != null && Assert.isNotEmpty(getOptions().getToolContext())) {
            originalPrompt.attrs().putAll(getOptions().getToolContext());
        }

        //设置指令
        StringBuilder talentsInstruction = TalentUtil.activeTalents(options.getModelOptions(), originalPrompt, new StringBuilder());
        if (talentsInstruction.length() > 0) {
            options.setTalentInstruction(talentsInstruction.toString());
        }
    }

    protected void reset(Prompt originalPrompt) {
        Objects.requireNonNull(originalPrompt, "OriginalPrompt cannot be null");

        // 1. 基础计数器重置
        turnCounter.set(0);
        toolCounter.set(0);
        emptyRetryCounter.set(0);

        // 2. 核心状态重置（非常重要，防止直接跳过推理进入上一次的 END 状态）
        this.route = ReActAgent.ID_REASON;
        this.finalAnswer = null;
        this.lastReasonMessage = null;

        // 3. 结构化数据重置
        plans.clear();
        planIndex = 0;
        workingMemory.clear();
        extras.clear();

        // 4. 指标重置（确保单次 Prompt 的 Token 消耗和时长统计准确）
        metrics.reset();

        // 5. 更新原始提示词
        this.originalPrompt = originalPrompt;
        this.beginTimeMs = System.currentTimeMillis();
        this.runId = Utils.uuid();

        if (LOG.isDebugEnabled()) {
            LOG.debug("Agent [{}] trace reset for a new task.", getAgentName());
        }
    }

    @Override
    public String getRunId() {
        if (runId == null) {
            runId = Utils.uuid();
        }

        return runId;
    }

    @Override
    public String getAgentName() {
        return agentName;
    }

    @Override
    public Metrics getMetrics() {
        return metrics;
    }

    @Override
    public long getBeginTimeMs() {
        return beginTimeMs;
    }


    public ReActAgentConfig getConfig() {
        return config;
    }

    public ReActOptions getOptions() {
        return options;
    }

    public AgentSession getSession() {
        return session;
    }

    /**
     * 获取流程快照快照
     */
    public FlowContext getContext() {
        if (session != null) {
            return session.getContext();
        } else {
            return null;
        }
    }

    public TeamProtocol getProtocol() {
        return protocol;
    }

    /**
     * 注册协议内置工具
     */
    public void addProtocolTool(FunctionTool tool) {
        protocolToolMap.put(tool.name(), tool);
    }

    public FunctionTool getProtocolTool(String name) {
        return protocolToolMap.get(name);
    }

    public Collection<FunctionTool> getProtocolTools() {
        return protocolToolMap.values();
    }

    @Override
    public Prompt getOriginalPrompt() {
        return originalPrompt;
    }

    @Override
    public Prompt getWorkingMemory() {
        return workingMemory;
    }

    public int getTurnCount() {
        return turnCounter.get();
    }

    /**
     * 递增回合数
     */
    public int nextTurn() {
        int turn = turnCounter.incrementAndGet();
        if (LOG.isDebugEnabled()) {
            LOG.debug("Agent [{}] proceed to turn: {}", getAgentName(), turn);
        }
        return turn;
    }

    /**
     * @deprecated 4.0 Use {@link #getTurnCount()} instead.
     */
    @Deprecated
    public int getStepCount() {
        return getTurnCount();
    }

    /**
     * @deprecated 4.0 Use {@link #nextTurn()} instead.
     */
    @Deprecated
    public int nextStep() {
        return nextTurn();
    }

    public String getRoute() {
        return route;
    }

    /**
     * 更新路由状态
     */
    public void setRoute(String route) {
        if (LOG.isDebugEnabled()) {
            LOG.debug("Agent [{}] route changed: {} -> {}", getAgentName(), this.route, route);
        }
        this.route = route;
    }


    /**
     * 是否异常结束的
     */
    public boolean isAbnormal() {
        return abnormal;
    }

    public String getFinalAnswer() {
        return finalAnswer;
    }


    public void setFinalAnswer(String finalAnswer) {
        this.finalAnswer = finalAnswer;
        this.abnormal = true;
    }

    public void setFinalAnswer(String finalAnswer, boolean abnormal) {
        this.finalAnswer = finalAnswer;
        this.abnormal = abnormal;
    }

    public AssistantMessage getLastReasonMessage() {
        return lastReasonMessage;
    }

    public void setLastReasonMessage(AssistantMessage lastReasonMessage) {
        this.lastReasonMessage = lastReasonMessage;
    }

    /**
     * 获取人性化历史记录格式
     */
    public String getFormattedHistory() {
        StringBuilder sb = new StringBuilder();
        for (ChatMessage msg : workingMemory.getMessages()) {
            if (msg instanceof UserMessage) {
                sb.append("[User] ").append(msg.getContent()).append("\n");
            } else if (msg instanceof AssistantMessage) {
                AssistantMessage am = (AssistantMessage) msg;
                if (Assert.isNotEmpty(am.getContent())) {
                    sb.append("[Assistant] ").append(am.getContent()).append("\n");
                }
                if (Assert.isNotEmpty(am.getToolCalls())) {
                    for (ToolCall call : am.getToolCalls()) {
                        sb.append("[Action] ").append(call.getName()).append(": ").append(call.getArguments()).append("\n");
                    }
                }
            } else if (msg instanceof ToolMessage) {
                sb.append("[Observation] ").append(msg.getContent()).append("\n");
            }
        }
        return sb.toString();
    }

    /**
     * 增加工具调用计数
     */
    public void incrementToolCallCount() {
        toolCounter.incrementAndGet();
    }

    /**
     * 获取已触发的工具调用总数
     */
    public int getToolCallCount() {
        return toolCounter.get();
    }

    public AtomicInteger getEmptyRetryCounter() {
        return emptyRetryCounter;
    }

    //------------------

    /**
     * 判断是否存在计划
     */
    public boolean hasPlans() {
        return !plans.isEmpty();
    }

    /**
     * 获取当前执行计划
     */
    public List<String> getPlans() {
        return Collections.unmodifiableList(plans);
    }

    /**
     * 设置或重置计划
     *
     * @param newPlans 计划列表
     */
    public void setPlans(Collection<String> newPlans) {
        this.plans.clear();

        if (options.isPlanningMode()) {
            if (Assert.isNotEmpty(newPlans)) {
                // 过滤空行并修剪
                newPlans.stream()
                        .filter(Objects::nonNull)
                        .map(String::trim)
                        .filter(s -> !s.isEmpty())
                        .forEach(this.plans::add);
            }

            if (LOG.isDebugEnabled()) {
                LOG.debug("Agent [{}] plans updated, total plans: {}", getAgentName(), plans.size());
            }
        }
    }

    /**
     * 添加单条计划步骤
     */
    public void addPlan(String step) {
        if (Assert.isNotEmpty(step)) {
            plans.add(step.trim());
        }
    }

    public int getPlanIndex() {
        return planIndex;
    }

    public void setPlanIndex(int planIndex) {
        this.planIndex = planIndex;
    }

    /**
     * 获取格式化的计划文本 (用于注入 System Prompt)
     */
    public String getFormattedPlans() {
        if (plans.isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < plans.size(); i++) {
            sb.append(i + 1).append(". ").append(plans.get(i)).append("\n");
        }
        return sb.toString();
    }

    /**
     * 获取当前的执行进度描述
     */
    public String getPlanProgress() {
        if (plans.isEmpty()) {
            return "";
        }
        // 基于当前已执行的回合数推测进度（仅作为模型参考）
        return String.format("Total Plans: %d, Current Turn: %d", plans.size(), getTurnCount());
    }
}