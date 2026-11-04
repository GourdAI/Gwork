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

import com.gourdai.agent.AgentSession;
import org.noear.solon.lang.Preview;

/**
 * HITL (Human-in-the-Loop) 交互助手
 *
 * <p>提供面向业务层（如 Controller 或 Service）的便捷 API。主要用于：</p>
 * <ul>
 * <li><b>任务探知</b>：通过 {@link #getPendingTask} 获取当前会话中被拦截的挂起任务。</li>
 * <li><b>决策回填</b>：通过 {@code approve/reject/skip} 提交人工干预指令，驱动 Agent 恢复执行。</li>
 * </ul>
 *
 * @author oisin
 * @since 3.9.1
 */
@Preview("3.9.1")
public class HITL {
    /**
     * 决策状态存储前缀
     */
    public static final String DECISION_PREFIX = "_hitl_decision_";
    /**
     * 最近一次被拦截的任务存储 Key
     */
    public static final String LAST_INTERVENED = "_last_intervened_";

    /**
     * 提交人工决策
     *
     * @param session  Agent 会话
     * @param toolName 工具名称
     * @param decision 决策实体（包含同意、拒绝理由或修正参数）
     */
    public static void submit(AgentSession session, String toolName, HITLDecision decision) {
        session.getContext().put(DECISION_PREFIX + toolName, decision);
    }

    /**
     * 快捷批准工具执行
     */
    public static void approve(AgentSession session, String toolName) {
        submit(session, toolName, HITLDecision.approve());
    }

    /**
     * 快捷批准工具执行
     */
    public static void approve(AgentSession session, String toolName, String comment) {
        submit(session, toolName, HITLDecision.approve().comment(comment));
    }

    /**
     * 快捷拒绝工具执行（使用默认拒绝意见）
     */
    public static void reject(AgentSession session, String toolName) {
        submit(session, toolName, HITLDecision.reject(null));
    }

    /**
     * 快捷拒绝工具执行（带具体意见）
     */
    public static void reject(AgentSession session, String toolName, String comment) {
        submit(session, toolName, HITLDecision.reject(comment));
    }

    /**
     * 快捷跳过工具执行（使用默认拒绝意见）
     */
    public static void skip(AgentSession session, String toolName) {
        submit(session, toolName, HITLDecision.skip(null));
    }

    /**
     * 快捷跳过工具执行（带具体意见）
     */
    public static void skip(AgentSession session, String toolName, String comment) {
        submit(session, toolName, HITLDecision.skip(comment));
    }

    public static boolean isHitl(AgentSession session) {
        return getPendingTask(session) != null;
    }

    /**
     * 获取会话中当前挂起的任务信息
     *
     * @return 挂起的任务实体，若无挂起则返回 null
     */
    public static HITLTask getPendingTask(AgentSession session) {
        return session.getContext().getAs(LAST_INTERVENED);
    }

    /**
     * 解除当前挂起的审批（不执行、不记决策）。
     *
     * <p>用途：会话档位切到「完全访问」时，那张基于旧档位产生的审批卡已失去意义——
     * 它代表的命令在新档位下本就不需审批。若只改档位而不管它，卡会永久挂在那里，
     * 且因 {@code _last_intervened_}/{@code _pending_reason_} 随快照持久化，刷新/重开会话
     * 还会被回放出来（实测样本 {@code work-mvhqk622}：{@code _access_mode=full} 却残留
     * {@code _pending_reason_=「当前为默认权限…」}）。</p>
     *
     * <p><b>只清挂起态，不自动执行被拦的命令</b>：自动跑等于绕过用户的知情同意；
     * 清掉后模型可自行重试，届时按新档位放行。同时清掉同名工具的残留决策，
     * 避免下一张卡一建出来就带着旧决策（会被当成「已批准」直接放行）。</p>
     *
     * @return 被解除的挂起任务；无挂起时返回 null
     */
    public static HITLTask clearPending(AgentSession session) {
        if (session == null || session.getContext() == null) {
            return null;
        }

        HITLTask task = getPendingTask(session);
        if (task == null) {
            return null;
        }

        session.getContext().remove(LAST_INTERVENED);
        if (task.getToolName() != null) {
            session.getContext().remove(DECISION_PREFIX + task.getToolName());
        }

        // 挂起标志也必须清：否则会话永远停在 isPending=true，前端一直显示等待态，
        // 后续输入会被当成「恢复已挂起任务」而不是普通新消息。
        session.pending(false, null);

        return task;
    }

    public static HITLDecision getDecision(AgentSession session, HITLTask task) {
        return session.getContext().getAs(DECISION_PREFIX + task.getToolName());
    }

    public static HITLDecision getDecision(AgentSession session, String toolName) {
        return session.getContext().getAs(DECISION_PREFIX + toolName);
    }
}