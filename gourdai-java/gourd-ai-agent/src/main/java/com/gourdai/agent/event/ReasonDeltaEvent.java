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
import com.gourdai.ai.chat.ChatResponse;
import com.gourdai.ai.chat.message.AssistantMessage;
import com.gourdai.ai.chat.tool.ToolCall;
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
     *
     * <p>4.1.1 起 {@code AssistantMessage.isThinking()} 已移除：分片的通道归属不再由
     * 布尔位承载，而是由「text 与 thinking 哪个通道有值」自然表达。增量分片天然是
     * 单通道的（思考片 text 为空、正文片 thinking 为空），因此 {@code isThinkingOnly()}
     * 在增量语境下恰好等价于旧的 {@code isThinking()}。</p>
     *
     * <p>注意不能简化为 {@code hasThinking()}：聚合/混合消息可能同时含 text 与 thinking，
     * 那种情况必须判为正文，否则正文会被整段渲染进思考区。</p>
     */
    public boolean isThinking() {
        return assistantMessage != null && assistantMessage.isThinkingOnly();
    }

    /**
     * 本增量是否含可下发内容（正文或思考任一通道非空）。
     *
     * <p><b>必须覆写</b>：基类的 {@code hasContent()} 委托到 {@code hasText()}，只看 text 通道。
     * 而思考分片的 text 恒为空、内容在 thinking 通道，若沿用基类实现，所有出口的
     * {@code hasContent()} 守卫都会把思考分片judged为空而静默丢弃 —— 思考区将全程无输出。</p>
     */
    @Override
    public boolean hasContent() {
        if (assistantMessage == null) {
            return false;
        }
        return assistantMessage.hasText() || assistantMessage.hasThinking();
    }

    /**
     * 获取本增量的文本内容：思考片返回思考文本，正文片返回正文。
     *
     * <p>同 {@link #hasContent()}，基类实现只返回 text 通道，对思考分片会返回空串。</p>
     */
    @Override
    public String getContent() {
        if (assistantMessage == null) {
            return null;
        }
        return isThinking() ? assistantMessage.getThinking() : assistantMessage.getText();
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
