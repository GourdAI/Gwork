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
import org.noear.solon.ai.chat.message.ChatMessage;
import org.noear.solon.lang.Preview;

import java.util.Map;

/**
 * 工具调用开始事件：智能体开始调用外部工具或执行特定指令
 *
 * <p>替代旧的 {@code ActionChunk}。</p>
 *
 * @author oisin
 * @since 4.1.0
 */
@Preview("4.1.0")
public class ToolCallStartEvent extends AbsToolCallEvent {
    public ToolCallStartEvent(ReActTrace trace, String toolName, Map<String, Object> args) {
        super(trace, toolName, args, ChatMessage.ofAssistant(""));
    }

    public ToolCallStartEvent(ReActTrace trace, String toolName, Map<String, Object> args, String actionId) {
        super(trace, toolName, args, ChatMessage.ofAssistant(""), actionId);
    }

    public ToolCallStartEvent(ReActTrace trace, String toolName, Map<String, Object> args, String actionId,
                              String batchId, Integer batchIndex, Integer batchSize) {
        super(trace, toolName, args, ChatMessage.ofAssistant(""), actionId, batchId, batchIndex, batchSize);
    }
}
