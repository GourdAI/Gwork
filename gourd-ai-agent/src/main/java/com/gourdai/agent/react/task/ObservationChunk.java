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

import com.gourdai.agent.react.ReActTrace;
import org.noear.solon.ai.chat.message.ChatMessage;
import org.noear.solon.lang.Nullable;
import org.noear.solon.lang.Preview;

import java.util.Map;

/**
 * ReAct 观察块（Observation）：标识智能体调用外部工具后的观察结果（含成功和异常）
 *
 * @author oisin
 * @since 3.9.1
 */
@Preview("3.9.1")
public class ObservationChunk extends AbsActionChunk {
    private final Throwable error;
    private final long durationMs;

    public ObservationChunk(ReActTrace trace, String toolName, Map<String, Object> args, @Nullable ChatMessage observation, @Nullable Throwable error, long durationMs) {
        super(trace, toolName, args, observation);

        this.error = error;
        this.durationMs = durationMs;
    }

    public ObservationChunk(ReActTrace trace, String toolName, Map<String, Object> args, @Nullable ChatMessage observation, @Nullable Throwable error, long durationMs, String actionId) {
        this(trace, toolName, args, observation, error, durationMs, actionId, null, null, null);
    }

    public ObservationChunk(ReActTrace trace, String toolName, Map<String, Object> args, @Nullable ChatMessage observation,
                            @Nullable Throwable error, long durationMs, String actionId,
                            String batchId, Integer batchIndex, Integer batchSize) {
        super(trace, toolName, args, observation, actionId, batchId, batchIndex, batchSize);

        this.error = error;
        this.durationMs = durationMs;
    }

    /**
     * 获取观察结果（成功时为工具输出，失败时为错误描述）
     */
    public @Nullable ChatMessage getObservation() {
        return getMessage();
    }

    public @Nullable Throwable getError() {
        return error;
    }

    public long getDurationMs() {
        return durationMs;
    }
}