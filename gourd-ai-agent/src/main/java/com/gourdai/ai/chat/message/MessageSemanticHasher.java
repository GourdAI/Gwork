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
package com.gourdai.ai.chat.message;

import org.noear.snack4.ONode;
import org.noear.snack4.Options;
import org.noear.snack4.json.JsonReader;
import org.noear.solon.Utils;
import com.gourdai.ai.chat.tool.ToolCall;
import com.gourdai.ai.chat.tool.ToolCallJsonSanitizer;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * AssistantMessage 通用语义摘要工具。
 * <p>摘要不包含 metadata、协议状态与创建时间，用于阻止消息语义被修改后继续精确回放陈旧协议快照。</p>
 *
 * <p>4.1.1 起提供两种口径，由各方言按其协议状态的<b>内容权威归属</b>自行选用：</p>
 * <ul>
 *   <li>{@link #hash(AssistantMessage)}（全文摘要）：覆盖 text / thinking / blocks / toolCalls。
 *       适用于协议状态里存有<b>逐字内容副本</b>、且该副本必须与语义字段严格一致的方言
 *       （Anthropic Messages：{@code signature} 只对逐字相同的 thinking 文本有效，
 *       思考被归一化改写后签名必然验不过，此时判废是<b>保护性</b>的——宁可不下发思考块，
 *       也不能下发无效签名）。</li>
 *   <li>{@link #anchorHash(AssistantMessage)}（锚点摘要）：只覆盖<b>不可变身份标识</b>
 *       （toolCalls 的 index / id / name 有序列表），不含任何可被上层归一化改写的明文。
 *       适用于协议状态里<b>只存凭证、内容一律读时从语义字段补水</b>的方言
 *       （OpenAI Responses：reasoning 只存 id / encrypted_content，正文与思考都不存副本；
 *       Gemini：只存 thoughtSignatures）。</li>
 * </ul>
 *
 * <p><b>为何必须分域</b>：锚点口径下，{@code AgentUtil.dedupeAggregatedThinking} 之类
 * 对 thinking 的归一化（剥离流式聚合产生的重复副本）不再使协议状态失效。此前统一用全文摘要，
 * 导致归一化后摘要陈旧 → {@code resolveData} fail-closed 返回空 → <b>整包判废</b>，
 * 连带 reasoning 的 id 与 function_call 骨架一起丢弃：Responses 退化为回放思考明文
 * （实测占单轮上行 token 的 71.74%），Gemini 丢失 thoughtSignature，
 * 并因工具配对缺失诱发 400 与重试风暴。而身份标识（call_id / name）不会被归一化触碰，
 * 用它做锚点既能守住「function_call 骨架必须与 toolCalls 配对」这条真正的约束，
 * 又不会对明文改写过度敏感。</p>
 *
 * @author noear
 * @since 4.1
 */
public final class MessageSemanticHasher {
    private MessageSemanticHasher() {
    }

    public static String hash(AssistantMessage message) {
        if (message == null) {
            return null;
        }

        Map<String, Object> semantic = new LinkedHashMap<>();
        semantic.put("text", message.getText());
        semantic.put("thinking", message.getThinking());
        semantic.put("blocks", message.getBlocks());
        java.util.List<com.gourdai.ai.chat.source.SearchResult> searchResults = message.resolveSearchResults();
        if (Utils.isNotEmpty(searchResults)) {
            semantic.put("searchResults", searchResults);
        }
        if (Utils.isNotEmpty(message.getCitations())) {
            semantic.put("citations", message.getCitations());
        }

        List<ToolCall> toolCalls = ToolCallJsonSanitizer.resolveToolCalls(
                message.getToolCalls(), message.getToolCallsRaw());
        if (Utils.isNotEmpty(toolCalls)) {
            List<Map<String, Object>> calls = new ArrayList<>();
            for (ToolCall call : toolCalls) {
                if (call == null) {
                    continue;
                }
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("index", call.getIndex());
                item.put("id", call.getId());
                item.put("name", call.getName());
                if (Utils.isNotEmpty(call.getArgumentsStr())) {
                    // argumentsStr 是线协议权威语义；严格合法的 object 规范化后参与摘要，
                    // 截断/非法字符串按原文参与，避免不同坏串都退化为空 Map 后产生相同摘要。
                    try {
                        ONode parsed = new JsonReader(call.getArgumentsStr(), Options.of()).readLast();
                        if (parsed != null && parsed.isObject()) {
                            item.put("arguments", parsed.toBean());
                        } else {
                            item.put("argumentsRaw", call.getArgumentsStr());
                        }
                    } catch (Throwable e) {
                        item.put("argumentsRaw", call.getArgumentsStr());
                    }
                } else if (call.getArguments() != null) {
                    item.put("arguments", call.getArguments());
                } else {
                    item.put("arguments", Collections.emptyMap());
                }
                calls.add(item);
            }
            semantic.put("toolCalls", calls);
        }

        return sha256Hex(canonicalJson(ONode.ofBean(semantic)));
    }

    public static boolean matches(AssistantMessage message, MessageProtocolState state) {
        return message != null && state != null
                && Utils.isNotEmpty(state.getSemanticHash())
                && state.getSemanticHash().equals(hash(message));
    }

    /**
     * 身份锚点摘要：只覆盖 toolCalls 的 index / id / name 有序列表。
     * <p>不含 text / thinking / blocks / arguments —— 这些要么已由语义字段单独承载
     * （读时补水，不存在陈旧副本），要么不参与身份配对（arguments 的内容变化不影响
     * call_id 与工具输出的对应关系）。因此上层对思考或正文的归一化不会使锚点失效。</p>
     *
     * <p>与 {@link #hash(AssistantMessage)} 使用不同的 canonical 根键（{@code toolCallIdentities}
     * 对 {@code text/thinking/blocks/toolCalls}），保证两种摘要值域不重叠，
     * 避免误把全文摘要当锚点校验通过。</p>
     *
     * @since 4.1.1
     */
    public static String anchorHash(AssistantMessage message) {
        return anchorHash(message, false);
    }

    /**
     * 锁定到参数的锚点摘要（{@code includeArguments=true}）。
     *
     * <p>供「凭证签名覆盖范围包含参数」的协议使用。Gemini 的 {@code thoughtSignature}
     * 签的是<b>整个 part</b>（{@code functionCall} 的 name 与 args 同在其中），
     * 不像 Responses 的 {@code encrypted_content} 挂在独立的 reasoning item 上。
     * 而出站前 {@code ToolCallJsonSanitizer.sanitizeArguments} 会改写非法/截断的 args，
     * 若锚点不覆盖 arguments，改写后签名仍被判为有效并照发，
     * Gemini 3 会返回 {@code Thought signature is not valid}。</p>
     *
     * @since 4.1.1
     */
    public static String anchorHash(AssistantMessage message, boolean includeArguments) {
        if (message == null) {
            return null;
        }

        Map<String, Object> anchor = new LinkedHashMap<>();
        List<ToolCall> toolCalls = ToolCallJsonSanitizer.resolveToolCalls(
                message.getToolCalls(), message.getToolCallsRaw());
        List<Map<String, Object>> calls = new ArrayList<>();
        if (Utils.isNotEmpty(toolCalls)) {
            for (ToolCall call : toolCalls) {
                if (call == null) {
                    continue;
                }
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("index", call.getIndex());
                item.put("id", call.getId());
                item.put("name", call.getName());
                if (includeArguments) {
                    // 与出站实际字节同源：签名验证的是被净化后真正发送的 args。
                    item.put("arguments", ToolCallJsonSanitizer.sanitizeArguments(call));
                }
                calls.add(item);
            }
        }

        if (calls.isEmpty() && includeArguments) {
            // fail-closed，但<b>仅限凭证与参数绑定的协议</b>（Gemini）。
            // 其 thoughtSignature 只在有 functionCall 时才建状态，空锚点意味着摘要丧失绑定力
            // （任意两条无工具调用的消息摘要相同），返回 null 使绑定与校验均不成立。
            //
            // <b>不能对 Responses 同样处理</b>：它的 reasoning 凭证挂在独立 item 上，
            // 与有无工具调用无关——纯回答轮（无 toolCalls）同样需要回放凭证。
            // 若此处返回 null，这类消息会被整包判废，退化回本次改造所治的膨胀。
            return null;
        }
        anchor.put("toolCallIdentities", calls);

        return sha256Hex(canonicalJson(ONode.ofBean(anchor)));
    }

    /**
     * 锚点口径的匹配判定。
     *
     * @since 4.1.1
     */
    public static boolean matchesAnchor(AssistantMessage message, MessageProtocolState state) {
        return matchesAnchor(message, state, false);
    }

    /**
     * 锚点口径的匹配判定（可选将 arguments 纳入锚点）。
     *
     * @since 4.1.1
     */
    public static boolean matchesAnchor(AssistantMessage message, MessageProtocolState state,
                                        boolean includeArguments) {
        if (message == null || state == null || Utils.isEmpty(state.getSemanticHash())) {
            return false;
        }
        String expected = anchorHash(message, includeArguments);
        return expected != null && expected.equals(state.getSemanticHash());
    }

    /**
     * 协议状态只存凭证、内容一律读时从语义字段补水的方言，其摘要只需锚定身份标识。
     * <p>这些协议状态里<b>没有</b>思考或正文的逐字副本，因此对明文归一化天然免疫；
     * 真正需要守住的只有「function_call 骨架必须与 toolCalls 配对」这条约束，
     * 而它完全由 call_id / name 决定。</p>
     *
     * <p>这里以协议 id 字符串做数据级分域，不引入方言层类型依赖（message 包位于底层，
     * 反向 import 方言会造成包级循环）。新增只存凭证的协议时在此登记即可。</p>
     *
     * @since 4.1.1
     */
    private static final java.util.Set<String> ANCHOR_SCOPED_PROTOCOLS =
            Collections.unmodifiableSet(new java.util.HashSet<>(java.util.Arrays.asList(
                    "openai.responses",
                    "google.generate-content",
                    "google.interactions")));

    /**
     * 锚点需要覆盖 arguments 的协议（凭证签名范围含参数）。
     *
     * <p>两个 Gemini 协议的 {@code thoughtSignature} 签的是整个 part（含 args）；
     * 而 Responses 的 {@code encrypted_content} 挂在独立 reasoning item 上、与 args 无关，
     * 其 arguments 读时从语义字段补水，故<b>不得</b>纳入——否则净化改写会让它的
     * reasoning 凭证被误判废，退化回本次改造所治的膨胀。三个协议在此不同质，不可一刀切。</p>
     *
     * @since 4.1.1
     */
    private static final java.util.Set<String> ARGUMENTS_ANCHORED_PROTOCOLS =
            Collections.unmodifiableSet(new java.util.HashSet<>(java.util.Arrays.asList(
                    "google.generate-content",
                    "google.interactions")));

    /**
     * 按协议选取摘要口径，供消息快照边界绑定使用。
     * <p>凭证型协议用 {@link #anchorHash(AssistantMessage)}（不含明文，归一化免疫）；
     * 其余（如 Anthropic Messages，其 {@code signature} 与 thinking 文本逐字绑定）
     * 用 {@link #hash(AssistantMessage)} 保持保护性判废。</p>
     *
     * @since 4.1.1
     */
    public static String hashFor(String protocolId, AssistantMessage message) {
        if (protocolId != null && ANCHOR_SCOPED_PROTOCOLS.contains(protocolId)) {
            return anchorHash(message, ARGUMENTS_ANCHORED_PROTOCOLS.contains(protocolId));
        }
        return hash(message);
    }

    /**
     * 按协议口径校验已绑定的摘要。
     *
     * @since 4.1.1
     */
    public static boolean matchesFor(String protocolId, AssistantMessage message, MessageProtocolState state) {
        if (protocolId != null && ANCHOR_SCOPED_PROTOCOLS.contains(protocolId)) {
            return matchesAnchor(message, state, ARGUMENTS_ANCHORED_PROTOCOLS.contains(protocolId));
        }
        return matches(message, state);
    }

    private static String sha256Hex(String canonical) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(canonical.getBytes(StandardCharsets.UTF_8));
            StringBuilder buf = new StringBuilder(bytes.length * 2);
            for (byte b : bytes) {
                buf.append(Character.forDigit((b >>> 4) & 0x0f, 16));
                buf.append(Character.forDigit(b & 0x0f, 16));
            }
            return buf.toString();
        } catch (Exception e) {
            throw new IllegalStateException("Unable to calculate message semantic hash", e);
        }
    }

    private static String canonicalJson(ONode node) {
        if (node == null || node.isNull()) {
            return "null";
        }
        if (node.isArray()) {
            StringBuilder buf = new StringBuilder("[");
            for (int i = 0; i < node.size(); i++) {
                if (i > 0) buf.append(',');
                buf.append(canonicalJson(node.get(i)));
            }
            return buf.append(']').toString();
        }
        if (node.isObject()) {
            List<String> keys = new ArrayList<>(node.getObject().keySet());
            Collections.sort(keys);
            StringBuilder buf = new StringBuilder("{");
            for (int i = 0; i < keys.size(); i++) {
                if (i > 0) buf.append(',');
                String key = keys.get(i);
                buf.append(ONode.ofBean(key).toJson()).append(':').append(canonicalJson(node.get(key)));
            }
            return buf.append('}').toString();
        }
        return node.toJson();
    }
}
