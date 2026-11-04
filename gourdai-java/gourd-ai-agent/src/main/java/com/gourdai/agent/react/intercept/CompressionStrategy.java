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
package com.gourdai.agent.react.intercept;

import com.gourdai.agent.react.ReActTrace;
import com.gourdai.ai.chat.ChatModel;
import com.gourdai.ai.chat.message.ChatMessage;
import java.util.List;

/**
 * 语义压缩策略接口
 *
 * @author oisin
 * @since 3.9.4
 */
@FunctionalInterface
public interface CompressionStrategy {
    /**
     * 对即将移出滑动窗口的消息进行压缩
     *
     * @param messagesToCompress 判定为“过期”的消息段
     * @return 返回一条包含压缩结果的消息（通常是 UserMessage），若返回 null 则仅执行物理截断
     */
    ChatMessage compress(ChatModel chatModel, int maxRetries, ReActTrace trace, List<ChatMessage> messagesToCompress);
}