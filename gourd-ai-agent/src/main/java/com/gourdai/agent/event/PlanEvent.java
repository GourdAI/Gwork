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
package com.gourdai.agent.event;

import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.task.PlanEventType;
import org.noear.solon.ai.chat.message.AssistantMessage;
import org.noear.solon.lang.Preview;

import java.util.List;

/**
 * 计划事件：包含智能体生成的任务拆解或步骤规划
 *
 * <p>替代旧的 {@code PlanChunk}。N2 决策：原同名枚举已改名为
 * {@link PlanEventType}，本类占用 {@code PlanEvent} 以对齐 4.1 命名规范。</p>
 *
 * @author oisin
 * @since 4.1.0
 */
@Preview("4.1.0")
public class PlanEvent extends AbsAgentEvent {
    private final transient ReActTrace trace;
    private final transient PlanEventType eventType;

    public PlanEvent(ReActTrace trace, PlanEventType eventType, AssistantMessage message) {
        super(trace.getRunId(), trace.getAgentName(), trace.getSession(), message);

        this.trace = trace;
        this.eventType = eventType;
    }

    public ReActTrace getTrace() {
        return trace;
    }

    /**
     * 获取计划事件类型（CREATE / PROGRESS / REVISE）
     */
    public PlanEventType getEventType() {
        return eventType;
    }

    public List<String> getPlans() {
        return trace.getPlans();
    }

    public int getPlanIndex() {
        return trace.getPlanIndex();
    }
}
