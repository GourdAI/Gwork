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

import com.gourdai.agent.team.TeamTrace;
import org.noear.solon.ai.chat.ChatResponse;
import org.noear.solon.ai.chat.message.AssistantMessage;
import org.noear.solon.flow.Node;
import org.noear.solon.lang.Preview;

/**
 * 团队指导者（Supervisor）决策增量事件
 *
 * <p>替代旧的 {@code SupervisorChunk}。用于在团队协作中，
 * 实时传递指导者的决策思考、任务分配及调度逻辑的流式内容。</p>
 *
 * @author oisin
 * @since 4.1.0
 */
@Preview("4.1.0")
public class SupervisorDeltaEvent extends AbsAgentEvent {
    private final transient Node node;
    private final transient TeamTrace trace;
    private final transient ChatResponse response;

    /**
     * @param response 聚合响应（终态帧才有；增量事件传 null）
     * @param message  本次要下发的消息分片
     */
    public SupervisorDeltaEvent(Node node, TeamTrace trace, ChatResponse response, AssistantMessage message) {
        super(trace.getRunId(), trace.getAgentName(), trace.getSession(), message);

        this.node = node;
        this.trace = trace;
        this.response = response;
    }

    public Node getNode() {
        return node;
    }

    public TeamTrace getTrace() {
        return trace;
    }

    public ChatResponse getResponse() {
        return response;
    }
}
