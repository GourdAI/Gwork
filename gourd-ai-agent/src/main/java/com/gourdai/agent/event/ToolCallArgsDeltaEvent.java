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
 * 工具调用参数生成进度事件：报告某个工具调用「参数已生成多少字节」。
 *
 * <p><b>只报字节数、不报内容。</b>订阅方需要的只是「还在动、进展到哪」这一进度语义；
 * 完整参数最终由 {@link ToolCallStartEvent#getArgs()} 提供。不传内容带来三个好处：
 * 帧体极小（可高频下发）、无需持久化、免去对未闭合 JSON 片段
 * （如 {@code '{"comm'}）的容错解析。</p>
 *
 * <p><b>下发节奏由生产方节流</b>（见 {@code ReasonTask}）：模型分片粒度极细，
 * 一篇文档可产生上千片，逐片下发会压垮传输与渲染。生产方按时间/字节双阈值合并，
 * 并在参数收尾时强制补发一帧，保证最终字节数准确。</p>
 *
 * @author oisin
 * @since 4.1.0
 */
@Preview("4.1.0")
public class ToolCallArgsDeltaEvent extends AbsToolCallEvent {
    /** 该工具调用累计已生成的参数字节数（非本帧增量，是累计值）。 */
    private final long argsBytes;

    public ToolCallArgsDeltaEvent(ReActTrace trace, String toolName, String actionId, long argsBytes) {
        super(trace, toolName, null, ChatMessage.ofAssistant(""), actionId);

        this.argsBytes = argsBytes;
    }

    /**
     * 累计已生成的参数字节数。
     */
    public long getArgsBytes() {
        return argsBytes;
    }
}
