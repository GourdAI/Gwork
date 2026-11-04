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
import com.gourdai.ai.chat.message.ChatMessage;
import org.noear.solon.lang.Preview;

/**
 * 推理开始事件：模型已开启思考块，但尚未产出任何可见思考内容。
 *
 * <p><b>为什么需要这个事件：</b>部分模型（如 Claude 系）会屏蔽思维链明文——思考确实在进行、
 * 计费与耗时照常发生，但 {@code THINKING_DELTA} 的文本通道全程为空。而链路上每一层都以
 * 「有内容」为下发前提（{@code ReasonDeltaEvent.hasContent()} 守卫、方言的
 * {@code Utils.isNotEmpty} 守卫），于是整段思考期零事件：Web 相位停在
 * {@code PHASE_WAITING}，前端持续显示「等待响应」并从头累加计时，直到正文首字才跳变——
 * 可实际上后端早已开始响应。本事件把「思考已开始」这一事实独立于「思考有无内容」表达出来，
 * 使订阅方在空思考链下同样能推进相位。</p>
 *
 * <p><b>与 {@link ReasonDeltaEvent} 的关系：</b>本事件<b>不携带内容</b>（message 为空助手消息），
 * 只表达相位语义。思考若随后真的产出文本，仍由 {@code ReasonDeltaEvent} 逐片下发，两者不重复、
 * 不互斥。订阅方应按「幂等开启思考展示」处理本事件——同一轮思考可能因签名/脱敏块等多个信号源
 * 触发，{@code ReasonTask} 已做轮内去重，但订阅方自身的渲染入口仍须幂等。</p>
 *
 * <p><b>降级：</b>方言未给出任何思考开启信号时不产生本事件，行为完全退回原有链路。</p>
 *
 * @author oisin
 * @since 4.1.0
 */
@Preview("4.1.0")
public class ReasonStartEvent extends AbsAgentEvent {
    private final transient ReActTrace trace;

    public ReasonStartEvent(ReActTrace trace) {
        super(trace.getRunId(), trace.getAgentName(), trace.getSession(), ChatMessage.ofAssistant(""));
        this.trace = trace;
    }

    public ReActTrace getTrace() {
        return trace;
    }

    /**
     * 恒为 {@code false}：本事件只表达相位，不承载任何可渲染内容。
     *
     * <p><b>必须覆写</b>：基类实现判的是 {@code getMessage().getContent() != null}，而本事件的
     * 载体是空助手消息（{@code getContent()} 返回空串而非 null），沿用基类会得到 {@code true}。
     * 各 portal 出口普遍以 {@code hasContent()} 作为下发守卫，届时本事件会被当成「有内容的空串帧」
     * 渲染出空泡。明确返回 false 后，portal 侧只能按事件类型显式处理它，不会被通用内容通道裹挟。</p>
     */
    @Override
    public boolean hasContent() {
        return false;
    }
}
