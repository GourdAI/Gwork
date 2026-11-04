/*
 * Copyright 2017-2025 noear.org and authors
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
package com.gourdai.agent.react.intercept;

import com.gourdai.agent.Agent;
import com.gourdai.agent.react.AbsReActInterceptor;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.task.ToolExchanger;
import com.gourdai.ai.chat.message.ChatMessage;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.permission.AccessMode;
import com.gourdai.harness.permission.AccessPolicy;
import org.noear.solon.core.util.Assert;
import org.noear.solon.lang.Nullable;
import org.noear.solon.lang.Preview;

import java.util.*;

/**
 * 人工介入拦截器 (Human-in-the-Loop Interceptor)
 *
 * <p>该拦截器通过 ReAct 协议的生命周期钩子实现流程管控：</p>
 * <ul>
 * <li><b>onAction 阶段</b>：判定拦截逻辑。若无决策则抛出中断异常挂起任务；若已有决策则执行修正、跳过或拒绝。</li>
 * <li><b>onObservation 阶段</b>：增强反馈逻辑。在工具执行成功后，将人工备注（Comment）注入观测结果，修正 AI 的下一轮认知。</li>
 * </ul>
 *
 * @author oisin
 * @since 3.9.1
 */
@Preview("3.9.1")
public class HITLInterceptor extends AbsReActInterceptor {

    private final Map<String, InterventionStrategy> strategyMap = new HashMap<>();

    /**
     * 注册工具介入策略
     */
    public HITLInterceptor onTool(String toolName, InterventionStrategy strategy) {
        strategyMap.put(toolName, strategy);
        return this;
    }

    /**
     * 读取本轮生效的访问控制档位。
     *
     * <h4>取值规则</h4>
     *
     * <ol>
     *   <li>投影 {@link AccessMode#ATTR_KEY} 存在且<b>无</b> {@link AccessMode#ATTR_INHERITED_KEY}
     *       标记 → 是<b>显式覆盖</b>（Loop 任务级档位、取证还原的恢复轮），直接用它。</li>
     *   <li>投影缺失，或带继承标记 → 改读会话上下文（<b>实时值</b>）。</li>
     * </ol>
     *
     * <p><b>“继承标记”为什么必须存在</b>（2026-10-21 实机取证）：投影在<b>每轮开始时</b>写一次，
     * 而用户轮内切档位（{@code /web/chat/access/select}）只改会话上下文。若无条件信任投影，
     * 正在跑的这一轮里后续每条 bash 仍按旧档判定——用户刚点完「完全访问」，下一条命令照样弹审批，
     * 卡片还写着「当前为默认权限」。实测样本 {@code work-mvhqk622}：快照 {@code _access_mode=full}，
     * 却残留 {@code _pending_reason_=「当前为默认权限…』}。带标记时改读实时值，切换立即生效。</p>
     *
     * <p><b>显式覆盖必须保留优先级</b>：Loop 任务级档位刻意不写入会话上下文（避免污染用户
     * 前台选择）。若这里无条件改读会话，任务级的 full 会被会话的 default 降档——那是
     * {@code AccessModePerTurnOverrideTest} 锁死的契约。故两类投影靠标记区分，而不是靠优先级猜。</p>
     *
     * <p>两路读到的都是框架注入值：工具参数里的同形键由 ToolRequest 统一剥离，模型无法伪造。
     * 读不到档位时 {@code normalize} 会 fail-safe 到最严的一档。子代理会话由 {@code TaskTalent}
     * 在创建时写入同一键，故子代理与父会话同档——空间与审批两路消费点不会在子代理里各说各话。</p>
     */
    static AccessMode accessModeOf(ReActTrace trace) {
        Map<String, Object> toolContext = (trace.getOptions() == null)
                ? null
                : trace.getOptions().getToolContext();

        if (toolContext != null) {
            Object perTurn = toolContext.get(AccessMode.ATTR_KEY);
            boolean inherited = isInheritedProjection(toolContext.get(AccessMode.ATTR_INHERITED_KEY));

            if (perTurn != null && !inherited) {
                String text = String.valueOf(perTurn).trim();
                if (!text.isEmpty()) {
                    // 显式覆盖：Loop 任务级 / 恢复轮。原优先语义不变。
                    return AccessMode.normalize(text);
                }
            }
        }

        // 无投影，或是继承型投影（轮内可能已被用户切过档）：一律读会话实时值。
        if (trace.getContext() == null) {
            return AccessMode.DEFAULT;
        }

        return AccessMode.normalize(trace.getContext().get(HarnessEngine.CTX_ACCESS_MODE));
    }

    /** 继承标记：{@code true}（布尔）或非空非 {@code "false"} 的字符串均视为继承型。 */
    private static boolean isInheritedProjection(Object raw) {
        if (raw instanceof Boolean) {
            return (Boolean) raw;
        }
        if (raw == null) {
            return false;
        }

        String text = String.valueOf(raw).trim();
        return !text.isEmpty() && !"false".equalsIgnoreCase(text);
    }

    @Override
    public void onAction(ReActTrace trace, ToolExchanger toolExchanger) {
        InterventionStrategy strategy = strategyMap.get(toolExchanger.getToolName());
        if (strategy == null) {
            return;
        }

        // 完全访问档：用户已在前端明确确认过风险并承担后果，不再逐条弹审批。
        // 注意这里放行的只是「审批」；杀宿主进程、exit、根目录删除仍由
        // TerminalSupport.validateCommandNoKill 硬拦，那是不可关闭的自保护，不受档位影响。
        if (!AccessPolicy.isCommandApprovalRequired(accessModeOf(trace))) {
            return;
        }

        // 评估当前环境与参数是否触发拦截（返回 null 表示放行，返回文案表示拦截理由）
        String comment = strategy.evaluate(trace, toolExchanger.getArgs());
        if (comment == null) {
            return;
        }

        // 获取会话上下文中的决策实体
        HITLDecision decision = trace.getContext().getAs(HITL.DECISION_PREFIX + toolExchanger.getToolName());

        // 1. 阶段：暂无决策 —— 挂起任务
        if (decision == null) {
            // 带上 actionId：前端据此把审批卡与参数生成期的骨架卡精确配对（并发同名工具不串卡）
            trace.getContext().put(HITL.LAST_INTERVENED, new HITLTask(toolExchanger.getToolName(),
                    new LinkedHashMap<>(toolExchanger.getArgs()), comment, toolExchanger.getActionId()));
            trace.getSession().pending(true, comment);
            trace.setFinalAnswer(comment);

            return;
        }

        // 2. 阶段：已有决策 —— 执行决策指令

        // 既然已经到了这一步，说明已经有决策了，立即清理“挂起”标识，防止下一轮推理误判
        trace.getContext().remove(HITL.LAST_INTERVENED); //挂起可以删了
        //trace.getContext().remove(HITL.DECISION_PREFIX + toolName); //决策还不能删，要留到 onObservation

        if (decision.isApproved()) {
            // 情况：批准执行 —— 处理参数修正
            if (decision.getModifiedArgs() != null) {
                toolExchanger.getArgs().putAll(decision.getModifiedArgs());
            }
        } else if (decision.isSkipped()) {
            String msg = decision.getCommentOrDefault("操作跳过：请继续下一步。");
            toolExchanger.setResult(msg);
        } else {
            // 拒绝：直接结束或给 Observation
            String msg = decision.getCommentOrDefault("操作拒绝：人工审批未通过。");

            // 方案：设为 FinalAnswer 并结束，不执行工具
            trace.setFinalAnswer(msg);
            trace.setRoute(Agent.ID_END);
        }
    }

    @Override
    public void onObservation(ReActTrace trace, ToolExchanger toolExchanger,
                              @Nullable ChatMessage observation,
                              @Nullable Throwable error, long durationMs) {
        HITLDecision decision = trace.getContext().getAs(HITL.DECISION_PREFIX + toolExchanger.getToolName());

        // 成功时：注入人工备注
        if (error == null && decision != null && decision.isApproved()) {
            if (Assert.isNotEmpty(decision.getComment())) {
                toolExchanger.setResult(toolExchanger.getResult() + " (Note: " + decision.getComment() + ")");
            }
        }

        // 100% 闭环：现场清理，确保 Session 状态幂等
        trace.getContext().remove(HITL.LAST_INTERVENED);
        trace.getContext().remove(HITL.DECISION_PREFIX + toolExchanger.getToolName());
    }

    /**
     * 介入判定策略接口
     */
    @FunctionalInterface
    public interface InterventionStrategy {
        /**
         * 评估是否需要干预
         *
         * @return 拦截理由文案（触发拦截）；null（不拦截，直接执行）
         */
        String evaluate(ReActTrace trace, Map<String, Object> args);
    }
}
