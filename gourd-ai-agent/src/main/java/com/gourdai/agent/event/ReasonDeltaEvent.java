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
import org.noear.solon.ai.chat.ChatResponse;
import org.noear.solon.ai.chat.message.AssistantMessage;
import org.noear.solon.ai.chat.tool.ToolCall;
import org.noear.solon.lang.Nullable;
import org.noear.solon.lang.Preview;

import java.util.Collections;
import java.util.List;

/**
 * 推理增量事件：模型流式输出的单个增量片段
 *
 * <p>替代旧的 {@code ReasonChunk}。名称中的 <b>Delta</b> 明确表达「增量」粒度，
 * 与聚合态的 {@link ReasonEndEvent} 从类型名即可区分。</p>
 *
 * <p>增量片段可能是思考也可能是正文，由 {@link #isThinking()} 判定——这与
 * {@link ReasonEndEvent} 不同：聚合态已知全貌故可拆成两个字段，增量态则需逐片判定。</p>
 *
 * @author oisin
 * @since 4.1.0
 */
@Preview("4.1.0")
public class ReasonDeltaEvent extends AbsAgentEvent {
    private final transient ReActTrace trace;
    private final transient @Nullable ChatResponse response;
    private final transient AssistantMessage assistantMessage;

    public ReasonDeltaEvent(ReActTrace trace, @Nullable ChatResponse response, AssistantMessage assistantMessage) {
        super(trace.getRunId(), trace.getAgentName(), trace.getSession(), assistantMessage);
        this.trace = trace;
        this.response = response;
        this.assistantMessage = assistantMessage;
    }

    public ReActTrace getTrace() {
        return trace;
    }

    public ChatResponse getResponse() {
        return response;
    }

    public AssistantMessage getAssistantMessage() {
        return assistantMessage;
    }

    /**
     * 本增量是否为思考内容（false 表示正文增量）
     */
    public boolean isThinking() {
        return assistantMessage != null && assistantMessage.isThinking();
    }

    /**
     * 本增量是否为工具调用
     */
    public boolean isToolCalls() {
        return assistantMessage != null && assistantMessage.isToolCalls();
    }

    /**
     * 获取工具调用
     */
    public List<ToolCall> getToolCalls() {
        return assistantMessage == null ? Collections.emptyList() : assistantMessage.getToolCalls();
    }
}
