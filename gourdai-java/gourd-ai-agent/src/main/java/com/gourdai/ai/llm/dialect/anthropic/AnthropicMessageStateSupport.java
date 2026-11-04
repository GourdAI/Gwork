/*
 * Copyright 2017-2025 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.ai.llm.dialect.anthropic;

import org.noear.solon.Utils;
import com.gourdai.ai.chat.message.AssistantMessage;
import com.gourdai.ai.chat.message.MessageProtocolState;
import com.gourdai.ai.chat.message.MessageSemanticHasher;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Anthropic Messages 历史回放状态支持。
 * <p>集中处理新协议状态、版本/语义校验与旧 {@code contentRaw} 兼容，避免请求构建器散落兼容分支。</p>
 *
 * @since 4.1
 */
final class AnthropicMessageStateSupport {
    static final String PROTOCOL_ID = "anthropic.messages";
    static final int VERSION = 1;

    private AnthropicMessageStateSupport() {
    }

    static MessageProtocolState createState(Map<String, Object> data) {
        if (Utils.isEmpty(data)) {
            return null;
        }
        return new MessageProtocolState(VERSION, new LinkedHashMap<>(data));
    }

    /**
     * 解析可回放数据。新状态存在但版本或语义无效时直接降级，不再回退可能同样陈旧的旧 raw。
     */
    @SuppressWarnings("unchecked")
    static Map<String, Object> resolveData(AssistantMessage message) {
        if (message == null) {
            return null;
        }

        MessageProtocolState state = message.getProtocolState(PROTOCOL_ID);
        if (state != null) {
            // 4.1.1：显式走全文摘要口径（matchesFor 对 anthropic.messages 解析为全文摘要）。
            // 这是<b>刻意保留</b>的保护性判废：Anthropic 的 signature 只对<b>逐字相同</b>的 thinking
            // 文本有效，一旦上层归一化改写了思考（实测漂移率 47.5%），签名必然验不过；
            // 此时宁可降级为不下发思考块（实测体积仅为 Responses 的 30.4%），
            // 也不能下发无效签名被端点拒绕。因此本协议不得改用锚点摘要。
            if (state.getVersion() != VERSION
                    || !MessageSemanticHasher.matchesFor(PROTOCOL_ID, message, state)) {
                return null;
            }
            return Utils.isEmpty(state.getData()) ? null : state.getData();
        }

        // 旧持久化数据兼容：只由 Anthropic 方言解释，不在 core 反序列化阶段猜测供应商。
        Object legacy = message.getContentRaw();
        if (legacy instanceof Map && isLegacyAnthropicData((Map<?, ?>) legacy)) {
            return (Map<String, Object>) legacy;
        }
        return null;
    }

    private static boolean isLegacyAnthropicData(Map<?, ?> data) {
        return data.containsKey("thinkingSignature")
                || data.containsKey("redactedThinkingBlocks")
                || data.containsKey("redactedThinkingData")
                || data.containsKey(AnthropicResponseParser.CONTENT_BLOCKS_RAW_KEY)
                || data.containsKey(AnthropicResponseParser.SERVER_BLOCKS_RAW_KEY)
                || data.containsKey(AnthropicResponseParser.CONTAINER_RAW_KEY);
    }

    static boolean hasReplayableState(AssistantMessage message) {
        return Utils.isNotEmpty(resolveData(message));
    }
}
