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
import org.noear.solon.core.util.Assert;
import org.noear.solon.lang.Nullable;
import org.noear.solon.lang.Preview;

import java.util.Collections;
import java.util.List;

/**
 * 推理结束事件：一轮推理完成后的聚合结果
 *
 * <p>替代旧的 {@code ThoughtChunk}。旧类型的致命缺陷是：类名叫「Thought」，
 * 但同时装着思考（{@code thoughtContent}）与正文（{@code assistantMessage}），
 * 且思考字段全仓无人调用——消费方 {@code WebStreamBuilder} 绕过它去取正文，
 * 导致子代理的思考内容永远不显示。</p>
 *
 * <p>本事件用 {@link #getThinking()} 与 {@link #getText()} 两个<b>独立 getter</b>
 * 物理隔离二者，消费方不可能再取错。</p>
 *
 * @author oisin
 * @since 4.1.0
 */
@Preview("4.1.0")
public class ReasonEndEvent extends AbsAgentEvent {
    private final transient ReActTrace trace;
    private final transient @Nullable ChatResponse response;
    private final transient AssistantMessage assistantMessage;
    /** 本轮的思考内容（原生 thinking 通道，或按 ReAct 协议从正文解析所得） */
    private final transient String thinking;
    /** 本轮的正文内容（已剥离思考标记） */
    private final transient String text;

    public ReasonEndEvent(ReActTrace trace, @Nullable ChatResponse response, AssistantMessage message,
                          String thinking, String text) {
        super(trace.getRunId(), trace.getAgentName(), trace.getSession(), message);
        this.trace = trace;
        this.response = response;
        this.assistantMessage = message;
        this.thinking = thinking;
        this.text = text;
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
     * 获取本轮思考内容（与正文物理分离，不含正文）
     */
    public String getThinking() {
        return thinking == null ? "" : thinking;
    }

    /**
     * 是否有思考内容
     */
    public boolean hasThinking() {
        return thinking != null && thinking.isEmpty() == false;
    }

    /**
     * 获取本轮正文内容（与思考物理分离，不含思考）
     */
    public String getText() {
        return text == null ? "" : text;
    }

    /**
     * 是否有正文内容
     */
    public boolean hasText() {
        return text != null && text.isEmpty() == false;
    }

    public boolean isToolCalls() {
        return assistantMessage != null && Assert.isNotEmpty(assistantMessage.getToolCalls());
    }

    public List<ToolCall> getToolCalls() {
        return assistantMessage == null ? Collections.emptyList() : assistantMessage.getToolCalls();
    }
}
