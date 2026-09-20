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

import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * 工具批量声明事件：同一轮模型响应中存在多个 Web 可见工具调用时，
 * 由 {@code ActionTask} 在整批工具执行前一次性声明批次结构（batchId / batchSize / 有序成员清单）。
 *
 * <p><b>为什么需要这个事件：</b>旧链路的批次元数据（batchId/index/size）只随每个工具的
 * {@link ToolCallStartEvent} 逐一到达，而写工具是串行执行——第二张卡要等第一个工具执行完
 * 才收到自己的 start 帧。期间订阅端呈现「单卡先出 → 容器后到 → 逐张搬入」的中间态跳变。
 * 本事件让订阅端在整批执行前就拿到全量批次结构（成员按 batchIndex 排序），
 * 建容器时可一次性收编全部已存在的骨架卡；尚未建卡的成员由后续 start/end 帧照常填充，
 * 两条路径按同样的槽位规则幂等共存。</p>
 *
 * <p><b>瞬态帧：</b>与 {@link ToolCallDraftEvent} 同类，不落盘。历史回放由当时的
 * action_start / action_end 帧（各自携带批次元数据）完整重建卡片与分组。</p>
 *
 * @author oisin
 * @since 4.1.0
 */
@Preview("4.1.0")
public class ToolCallBatchEvent extends AbsToolCallEvent {
    /**
     * 批次成员清单（按 batchIndex 升序）。每项含 {@code actionId} / {@code index} / {@code toolName}；
     * 无原生 ToolCall.id 的成员 actionId 为 null（其卡片由 start 帧常规路径入组，不参与一次性收编）。
     */
    private final transient List<Map<String, Object>> members;

    public ToolCallBatchEvent(ReActTrace trace, String batchId, Integer batchSize, List<Map<String, Object>> members) {
        super(trace, null, null, ChatMessage.ofAssistant(""), null, batchId, null, batchSize);
        this.members = (members == null) ? Collections.emptyList() : Collections.unmodifiableList(members);
    }

    public List<Map<String, Object>> getMembers() {
        return members;
    }
}
