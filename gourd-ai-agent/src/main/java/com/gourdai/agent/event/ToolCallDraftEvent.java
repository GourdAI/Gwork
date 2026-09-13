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

/**
 * 工具调用草稿事件：模型刚确定要调用的工具名，参数仍在流式生成中。
 *
 * <p><b>为什么需要这个事件：</b>原生工具调用的参数由模型逐分片吐出
 * （{@code TOOL_CALL_ARGS_DELTA}），一个大参数调用（如 write 一整篇文档）
 * 可持续数十秒。在此期间 {@link ToolCallStartEvent} 尚未产生（它由
 * {@code ActionTask} 在工具真正执行前才推送），订阅方处于完全无反馈的盲区。
 * 本事件在「模型刚说出函数名」的时刻下发，让订阅方提前渲染骨架卡。</p>
 *
 * <p><b>与 {@link ToolCallStartEvent} 的关系：</b>两者的 {@code actionId} 同源
 * （均为原生 {@code ToolCall.getId()}），故订阅方可按 actionId 幂等接管同一张卡片，
 * 不会重复建卡。本事件不携带 args（此刻参数尚不完整），batch 三元组亦为 null
 * （批次要等去重后才能确定），这些都由随后的 ToolCallStartEvent 回填。</p>
 *
 * <p><b>降级：</b>端点未提供 ToolCall.id 时不产生本事件，行为完全退回原有链路。</p>
 *
 * @author oisin
 * @since 4.1.0
 */
@Preview("4.1.0")
public class ToolCallDraftEvent extends AbsToolCallEvent {
    public ToolCallDraftEvent(ReActTrace trace, String toolName, String actionId) {
        super(trace, toolName, null, ChatMessage.ofAssistant(""), actionId);
    }
}
