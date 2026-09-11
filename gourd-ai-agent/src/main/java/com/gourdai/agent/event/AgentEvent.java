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

import com.gourdai.agent.AgentSession;
import org.noear.solon.ai.chat.message.ChatMessage;
import org.noear.solon.lang.NonSerializable;
import org.noear.solon.lang.Nullable;
import org.noear.solon.lang.Preview;

import java.util.Map;

/**
 * 智能体事件（流式输出的事件单元）
 *
 * <p>对齐 solon-ai 4.1 的事件体系：以「事件」而非「内容块」描述智能体运行过程中
 * 产生的一切可观测信号。相比旧的 {@code AgentChunk} 体系，事件体系具备两点关键改进：</p>
 *
 * <ul>
 *   <li><b>命名自明</b>：{@code ReasonDeltaEvent}（增量）与 {@code ReasonEndEvent}（聚合）
 *       从类型名即可区分粒度，不会像旧的 {@code ReasonChunk}/{@code ThoughtChunk} 那样
 *       两个类都叫「思考」却载荷不同。</li>
 *   <li><b>语义分离</b>：思考与正文由独立 getter 暴露（如 {@link ReasonEndEvent#getThinking()}
 *       与 {@link ReasonEndEvent#getText()}），消费方不可能再取错。</li>
 * </ul>
 *
 * @author oisin
 * @since 4.1.0
 */
@Preview("4.1.0")
public interface AgentEvent extends NonSerializable {
    /**
     * 获取运行 Id
     */
    String getRunId();

    /**
     * 获取当前产生事件的智能体名字
     */
    String getAgentName();

    /**
     * 获取所属会话
     */
    AgentSession getSession();

    /**
     * 获取当前事件的消息
     */
    @Nullable
    ChatMessage getMessage();

    /**
     * 获取当前事件的元数据
     */
    Map<String, Object> getMeta();

    /**
     * 是否当前事件有元数据
     */
    boolean hasMeta(String name);

    /**
     * 是否有当前事件内容
     */
    default boolean hasContent() {
        return getMessage() != null && getMessage().getContent() != null;
    }

    /**
     * 获取当前事件的消息内容
     */
    default String getContent() {
        if (hasContent()) {
            return getMessage().getContent();
        } else {
            return "";
        }
    }
}
