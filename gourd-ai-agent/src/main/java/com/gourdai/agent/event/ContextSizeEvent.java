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
import org.noear.solon.lang.Preview;

/**
 * 上下文大小事件：向用户侧推送当前上下文的大小信息
 *
 * <p>替代旧的 {@code ContextSizeChunk}。在每次推理回合开始前生成，
 * 让用户侧能感知当前上下文规模以及是否发生了压缩。</p>
 *
 * <p>与 {@link ContextUsageEvent} 的区别：本事件是推理<b>前</b>用 jtokkit 本地<b>估算</b>，
 * 仅供框架内部做压缩决策；后者是推理<b>后</b>的<b>真实</b>用量，用于对用户展示。</p>
 *
 * @author oisin
 * @since 4.1.0
 */
@Preview("4.1.0")
public class ContextSizeEvent extends AbsAgentEvent {
    private final ReActTrace trace;
    private final int messageCount;
    private final int tokenCount;
    private final boolean compressed;
    private final int beforeMessageCount;
    private final int afterMessageCount;
    private final int beforeTokenCount;
    private final int afterTokenCount;

    public ContextSizeEvent(ReActTrace trace, int messageCount, int tokenCount,
                            boolean compressed,
                            int beforeMessageCount, int afterMessageCount,
                            int beforeTokenCount, int afterTokenCount) {
        super(trace.getRunId(), trace.getAgentName(), trace.getSession(), null);

        this.trace = trace;
        this.messageCount = messageCount;
        this.tokenCount = tokenCount;
        this.compressed = compressed;
        this.beforeMessageCount = beforeMessageCount;
        this.afterMessageCount = afterMessageCount;
        this.beforeTokenCount = beforeTokenCount;
        this.afterTokenCount = afterTokenCount;
    }

    public ReActTrace getTrace() {
        return trace;
    }

    public int getMessageCount() {
        return messageCount;
    }

    public int getTokenCount() {
        return tokenCount;
    }

    public boolean isCompressed() {
        return compressed;
    }

    public int getBeforeMessageCount() {
        return beforeMessageCount;
    }

    public int getAfterMessageCount() {
        return afterMessageCount;
    }

    public int getBeforeTokenCount() {
        return beforeTokenCount;
    }

    public int getAfterTokenCount() {
        return afterTokenCount;
    }
}
