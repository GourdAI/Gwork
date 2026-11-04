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

import com.gourdai.agent.simple.SimpleResponse;
import org.noear.solon.lang.Preview;

/**
 * 简单智能体运行结束事件（流式结束事件）
 *
 * <p>替代旧的 {@code SimpleChunk}。通常作为流式输出的最后一个元素，
 * 提供完整的响应结果、会话状态及最终的指标统计。</p>
 *
 * @author oisin
 * @since 4.1.0
 */
@Preview("4.1.0")
public class SimpleEndEvent extends AbsAgentEvent {
    private final transient SimpleResponse response;

    public SimpleEndEvent(SimpleResponse resp) {
        super(resp.getTrace().getRunId(), resp.getTrace().getAgentName(), resp.getSession(), resp.getMessage());
        this.response = resp;
    }

    public SimpleResponse getResponse() {
        return response;
    }
}
