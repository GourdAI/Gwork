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
package com.gourdai.ai.llm.dialect.openai;

import org.noear.solon.Utils;
import com.gourdai.ai.chat.message.AssistantMessage;
import com.gourdai.ai.chat.message.MessageProtocolState;
import com.gourdai.ai.chat.tool.ToolCall;
import com.gourdai.ai.chat.tool.ToolCallJsonSanitizer;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * OpenAI Responses assistant 消息协议状态的集中兼容入口。
 *
 * <p>新消息使用 protocolStates；旧消息仍可能把同样的数据放在 metadata 中。
 * 这里统一处理新旧读取优先级，避免请求构建器直接依赖无命名空间的 metadata。</p>
 *
 * <p><b>4.1.1 内容权威归属（单一权威原则）</b>：协议状态只存<b>不可从语义字段重建的东西</b>
 * ——reasoning 凭证（id / encrypted_content）、function_call 骨架身份（call_id / name）、
 * 输出项顺序（output_index）、phase 分段，以及无语义投影的 server-tool 原始载荷。
 * 思考明文与正文<b>不再存副本</b>，读时一律从 {@code thinking} / {@code text} / {@code blocks}
 * / {@code toolCalls} 补水。因此 {@link #VERSION} 2 的快照是「骨架 + 凭证」，
 * 而 {@link #LEGACY_VERSION} 1 是含逐字明文的历史快照（读侧对其明文一律忽略，
 * 存量会话无需迁移即可获得同等的上行缩减）。</p>
 *
 * @since 4.1
 */
final class OpenaiResponsesMessageStateSupport {
    static final String PROTOCOL_ID = "openai.responses";
    /** 骨架 + 凭证形态；内容读时从语义字段补水。 */
    static final int VERSION = 2;
    /** 历史逐字快照形态（含思考 / 正文明文副本）；仍可读，但明文不再被采信。 */
    static final int LEGACY_VERSION = 1;

    static final String OUTPUT_ITEMS = "responses_output_items";
    static final String MESSAGE_ITEMS = "response_message_items";
    static final String REASONING_ITEMS = "reasoning_items";
    static final String REASONING_ITEM_ID = "reasoning_item_id";
    static final String REASONING_ENCRYPTED_CONTENT = "reasoning_encrypted_content";
    static final String PHASE = "phase";
    /**
     * message 项的<b>长度锚点</b>（取代 4.1 的 {@code text} 正文副本）。
     * <p>读时按各项累计长度从语义 {@code text} 切片，即可还原 phase 分段而不存第二份正文。</p>
     *
     * @since 4.1.1
     */
    static final String MESSAGE_ITEM_LEN = "len";

    // 解析期工作区键必须与应用 metadata 隔离；提升到 state.data 时再映射成上面的稳定协议键。
    static final String AGGREGATION_OUTPUT_ITEMS = "__openai_responses.output_items";
    static final String AGGREGATION_MESSAGE_ITEMS = "__openai_responses.message_items";
    static final String AGGREGATION_REASONING_ITEMS = "__openai_responses.reasoning_items";
    static final String AGGREGATION_REASONING_ITEM_ID = "__openai_responses.reasoning_item_id";
    static final String AGGREGATION_REASONING_ENCRYPTED_CONTENT = "__openai_responses.reasoning_encrypted_content";
    static final String AGGREGATION_PHASE = "__openai_responses.phase";

    private OpenaiResponsesMessageStateSupport() {
    }

    /**
     * 从流式聚合的旧暂存 metadata 创建新的协议状态。
     * <p>只复制 Responses 自己的键，不能把应用 metadata 误纳入协议状态。</p>
     */
    static MessageProtocolState fromAggregation(Map<String, Object> aggregationMetadata) {
        if (aggregationMetadata == null || aggregationMetadata.isEmpty()) {
            return null;
        }
        Map<String, Object> data = new LinkedHashMap<>();
        copyIfPresent(aggregationMetadata, data, AGGREGATION_OUTPUT_ITEMS, OUTPUT_ITEMS);
        copyIfPresent(aggregationMetadata, data, AGGREGATION_MESSAGE_ITEMS, MESSAGE_ITEMS);
        copyIfPresent(aggregationMetadata, data, AGGREGATION_REASONING_ITEMS, REASONING_ITEMS);
        copyIfPresent(aggregationMetadata, data, AGGREGATION_REASONING_ITEM_ID, REASONING_ITEM_ID);
        copyIfPresent(aggregationMetadata, data, AGGREGATION_REASONING_ENCRYPTED_CONTENT, REASONING_ENCRYPTED_CONTENT);
        copyIfPresent(aggregationMetadata, data, AGGREGATION_PHASE, PHASE);
        return data.isEmpty() ? null : new MessageProtocolState(VERSION, data);
    }

    /**
     * 读取可用于当前 Responses 请求的协议数据。
     *
     * <p>4.1.1 起摘要口径按版本分域：{@link #VERSION} 用身份锚点摘要（不含明文，
     * 对思考 / 正文归一化免疫），{@link #LEGACY_VERSION} 用其落盘时的全文摘要。</p>
     *
     * <p><b>不再整包判废</b>：摘要不匹配时降级为「凭证视图」（保留 reasoning 凭证与 phase，
     * 丢弃依赖逐字快照的 output_items / message_items）。理由：锚点覆盖的 toolCall 身份一旦漂移，
     * 受影响的只是 function_call 骨架（读侧本就按 call_id 匹配、无匹配即跳过），
     * 而 reasoning 的 id / encrypted_content 指向<b>服务端</b>的推理对象，与本地文本归一化无关，
     * 丢弃它反而会逼出思考明文兜底回放（实测占单轮上行 token 的 71.74%）。
     * 旧行为返回空 Map 会连带丢掉全部凭证与 server-tool 载荷，是 400 与重试风暴的诱因之一。</p>
     *
     * <p>版本无法识别时仍 fail-closed（格式未知，不得猜测），且不回退可能陈旧的 legacy metadata。</p>
     */
    static Map<String, Object> resolveData(AssistantMessage message) {
        if (message == null) {
            return null;
        }
        MessageProtocolState state = message.getProtocolState(PROTOCOL_ID);
        if (state != null) {
            int version = state.getVersion();
            if (version == VERSION) {
                return com.gourdai.ai.chat.message.MessageSemanticHasher
                        .matchesFor(PROTOCOL_ID, message, state)
                        ? orEmpty(state.getData()) : credentialsOnly(state.getData());
            }
            if (version == LEGACY_VERSION) {
                // 存量 v1 快照落盘时绑的是全文摘要，故优先按全文口径校验；
                // 但也接受锚点口径——边界情形（v1 形态的数据在 4.1.1 后新建 / 迁移）
                // 会由快照边界绑上锚点摘要。两者均不匹配时降级为凭证视图。
                // 这一宽容是安全的：读侧已不再采信快照里的任何内容明文（一律从语义字段补水），
                // function_call 也按 call_id 与语义 toolCalls 逐项匹配、无匹配即跳过。
                return (com.gourdai.ai.chat.message.MessageSemanticHasher.matches(message, state)
                        || com.gourdai.ai.chat.message.MessageSemanticHasher
                                .matchesFor(PROTOCOL_ID, message, state))
                        ? orEmpty(state.getData()) : credentialsOnly(state.getData());
            }
            return Collections.emptyMap();
        }

        // 兼容已有持久化消息和旧的公开 metadata 用法；只在不存在新状态时使用。
        if (!message.hasMetadata()) {
            return null;
        }
        Map<String, Object> metadata = message.getMetadata();
        if (!containsProtocolKey(metadata)) {
            return null;
        }
        if (hasLegacyOutputConflict(message, metadata.get(OUTPUT_ITEMS))) {
            // output_items 是旧格式的精确快照；一旦能确认其正文或函数调用已与当前消息分叉，
            // 就只禁用依赖该快照的 message 回放。独立的 reasoning id/encrypted_content
            // 仍可安全用于无状态续接，保持已有持久化数据兼容。
            Map<String, Object> compatible = new LinkedHashMap<>(metadata);
            compatible.remove(OUTPUT_ITEMS);
            compatible.remove(MESSAGE_ITEMS);
            return compatible;
        }
        return metadata;
    }

    private static Map<String, Object> orEmpty(Map<String, Object> data) {
        return data == null ? Collections.<String, Object>emptyMap() : data;
    }

    /**
     * 摘要漂移时的降级视图：只保留与本地明文无关的凭证。
     * <p>reasoning 的 id / encrypted_content 指向服务端推理对象，本地思考被归一化不影响其有效性；
     * output_items / message_items 是逐字快照的载体，锚点既已漂移就不再采信，
     * 内容改由读侧从语义字段重建（与无协议状态时的路径一致）。</p>
     */
    private static Map<String, Object> credentialsOnly(Map<String, Object> data) {
        if (Utils.isEmpty(data)) {
            return Collections.emptyMap();
        }
        Map<String, Object> credentials = new LinkedHashMap<>();
        copyIfPresent(data, credentials, REASONING_ITEMS, REASONING_ITEMS);
        copyIfPresent(data, credentials, REASONING_ITEM_ID, REASONING_ITEM_ID);
        copyIfPresent(data, credentials, REASONING_ENCRYPTED_CONTENT, REASONING_ENCRYPTED_CONTENT);
        copyIfPresent(data, credentials, PHASE, PHASE);
        return credentials;
    }

    @SuppressWarnings("unchecked")
    private static boolean hasLegacyOutputConflict(AssistantMessage message, Object value) {
        if (!(value instanceof Collection)) {
            return false;
        }

        StringBuilder replayText = new StringBuilder();
        boolean textComparable = false;
        boolean toolCallsComparable = true;
        List<ReplayToolCall> replayToolCalls = new ArrayList<>();
        for (Object wrapperObj : (Collection<?>) value) {
            if (!(wrapperObj instanceof Map)) {
                continue;
            }
            Object itemObj = ((Map<?, ?>) wrapperObj).get("item");
            if (!(itemObj instanceof Map)) {
                continue;
            }
            Map<String, Object> item = (Map<String, Object>) itemObj;
            String type = stringValue(item.get("type"));
            if ("message".equals(type)) {
                String itemText = comparableMessageText(item.get("content"));
                if (itemText != null) {
                    replayText.append(itemText);
                    textComparable = true;
                }
            } else if ("function_call".equals(type)) {
                String callId = stringValue(item.get("call_id"));
                String name = stringValue(item.get("name"));
                if (Utils.isEmpty(callId) || Utils.isEmpty(name)) {
                    toolCallsComparable = false;
                    continue;
                }
                replayToolCalls.add(new ReplayToolCall(callId, name,
                        ToolCallJsonSanitizer.sanitizeArguments(stringValue(item.get("arguments")), name)));
            }
        }

        String currentText = message.getText() == null ? "" : message.getText();
        if (textComparable && !Objects.equals(replayText.toString(), currentText)) {
            return true;
        }

        if (toolCallsComparable && !replayToolCalls.isEmpty()) {
            List<ToolCall> currentToolCalls = ToolCallJsonSanitizer.resolveToolCalls(
                    message.getToolCalls(), message.getToolCallsRaw());
            // 旧持久化数据可能只保存 output_items 而没有投影 toolCalls；两边都有调用时才可明确比较。
            if (currentToolCalls == null || currentToolCalls.isEmpty()) {
                return false;
            }
            if (currentToolCalls.size() != replayToolCalls.size()) {
                return true;
            }
            for (int i = 0; i < replayToolCalls.size(); i++) {
                ReplayToolCall replay = replayToolCalls.get(i);
                ToolCall current = currentToolCalls.get(i);
                if (current == null
                        || !Objects.equals(replay.callId, current.getId())
                        || !Objects.equals(replay.name, current.getName())
                        || !Objects.equals(replay.arguments,
                        ToolCallJsonSanitizer.sanitizeArguments(current))) {
                    return true;
                }
            }
        }
        return false;
    }

    @SuppressWarnings("unchecked")
    private static String comparableMessageText(Object contentObj) {
        if (!(contentObj instanceof Collection)) {
            return null;
        }
        StringBuilder text = new StringBuilder();
        for (Object partObj : (Collection<?>) contentObj) {
            if (!(partObj instanceof Map)) {
                return null;
            }
            Map<String, Object> part = (Map<String, Object>) partObj;
            String type = stringValue(part.get("type"));
            if ("output_text".equals(type) || "text".equals(type)) {
                appendIfPresent(text, part.get("text"));
            } else if ("refusal".equals(type)) {
                Object value = part.get("refusal");
                appendIfPresent(text, value == null ? part.get("text") : value);
            } else if ("output_audio".equals(type)) {
                appendIfPresent(text, part.get("transcript"));
            } else if (!("output_image".equals(type) || "image".equals(type)
                    || part.containsKey("image_url"))) {
                // 未知内容项未来可能有文本投影；不能据此判定旧快照已冲突。
                return null;
            }
        }
        return text.toString();
    }

    private static void appendIfPresent(StringBuilder target, Object value) {
        if (value != null) {
            target.append(String.valueOf(value));
        }
    }

    private static String stringValue(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    private static final class ReplayToolCall {
        final String callId;
        final String name;
        final String arguments;

        ReplayToolCall(String callId, String name, String arguments) {
            this.callId = callId;
            this.name = name;
            this.arguments = arguments;
        }
    }

    static Object get(AssistantMessage message, String key) {
        Map<String, Object> data = resolveData(message);
        return data == null ? null : data.get(key);
    }

    static boolean hasReplayData(AssistantMessage message) {
        Map<String, Object> data = resolveData(message);
        return data != null && !data.isEmpty();
    }

    /** 删除已提升到协议状态的内部键，保留应用自定义 metadata。 */
    static void removeProtocolKeys(Map<String, Object> metadata) {
        if (metadata == null) {
            return;
        }
        metadata.remove(AGGREGATION_OUTPUT_ITEMS);
        metadata.remove(AGGREGATION_MESSAGE_ITEMS);
        metadata.remove(AGGREGATION_REASONING_ITEMS);
        metadata.remove(AGGREGATION_REASONING_ITEM_ID);
        metadata.remove(AGGREGATION_REASONING_ENCRYPTED_CONTENT);
        metadata.remove(AGGREGATION_PHASE);
    }

    private static boolean containsProtocolKey(Map<String, Object> data) {
        return data != null && (data.containsKey(OUTPUT_ITEMS)
                || data.containsKey(MESSAGE_ITEMS)
                || data.containsKey(REASONING_ITEMS)
                || data.containsKey(REASONING_ITEM_ID)
                || data.containsKey(REASONING_ENCRYPTED_CONTENT));
    }

    private static void copyIfPresent(Map<String, Object> source, Map<String, Object> target,
                                      String sourceKey, String targetKey) {
        if (source.containsKey(sourceKey) && source.get(sourceKey) != null) {
            target.put(targetKey, source.get(sourceKey));
        }
    }
}
