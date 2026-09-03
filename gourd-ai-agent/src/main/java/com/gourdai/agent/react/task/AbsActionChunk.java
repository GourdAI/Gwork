/*
 * Copyright 2017-2025 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.agent.react.task;

import com.gourdai.agent.AbsAgentChunk;
import com.gourdai.agent.react.ReActTrace;
import org.noear.solon.ai.chat.message.ChatMessage;
import org.noear.solon.lang.Nullable;
import org.noear.solon.lang.Preview;

import java.util.Collections;
import java.util.Map;

/**
 * ReAct 动作块（Acting）：标识智能体正在调用外部工具或执行特定指令
 *
 * @author oisin
 * @since 3.9.6
 */
@Preview("3.9.6")
public abstract class AbsActionChunk extends AbsAgentChunk {
    private final transient ReActTrace trace;
    private final transient String toolName;
    private final transient Map<String, Object> args;
    /**
     * 工具调用标识：用于并发场景下将 action(开始) 与 observation(结束) 精确配对，
     * 以及 HITL 批量审批时按调用而非工具名寻址。原生 ToolCall 有 id 时用其 id；
     * 文本模式无原生 id 时由调用方生成稳定串。可能为 null（旧构造/未提供）。
     */
    private final transient String actionId;
    /** 同一模型响应内可见工具调用批次标识；旧历史或单卡调用为 null。 */
    private final transient String batchId;
    /** 去重后、按 Web 可见调用计算的 0-based 批次索引；旧历史或单卡调用为 null。 */
    private final transient Integer batchIndex;
    /** 去重后、Web 可见工具卡数量；旧历史或单卡调用为 null。 */
    private final transient Integer batchSize;

    public AbsActionChunk(ReActTrace trace, String toolName, Map<String, Object> args, ChatMessage message) {
        this(trace, toolName, args, message, null, null, null, null);
    }

    public AbsActionChunk(ReActTrace trace, String toolName, Map<String, Object> args, ChatMessage message, String actionId) {
        this(trace, toolName, args, message, actionId, null, null, null);
    }

    public AbsActionChunk(ReActTrace trace, String toolName, Map<String, Object> args, ChatMessage message,
                          String actionId, String batchId, Integer batchIndex, Integer batchSize) {
        super(trace.getRunId(), trace.getAgentName(), trace.getSession(), message);

        this.trace = trace;
        this.toolName = toolName;
        this.actionId = actionId;
        this.batchId = batchId;
        this.batchIndex = batchIndex;
        this.batchSize = batchSize;
        if (args == null) {
            this.args = Collections.EMPTY_MAP;
        } else {
            this.args = Collections.unmodifiableMap(args);
        }
    }

    public @Nullable String getActionId() {
        return actionId;
    }

    public @Nullable String getBatchId() {
        return batchId;
    }

    public @Nullable Integer getBatchIndex() {
        return batchIndex;
    }

    public @Nullable Integer getBatchSize() {
        return batchSize;
    }

    public @Nullable String getToolName() {
        return toolName;
    }

    public @Nullable Map<String, Object> getArgs() {
        return args;
    }

    public ReActTrace getTrace() {
        return trace;
    }
}