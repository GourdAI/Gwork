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

import com.gourdai.agent.util.AgentUtil;
import com.gourdai.ai.chat.ChatConfig;
import com.gourdai.ai.chat.ChatOptions;
import com.gourdai.ai.chat.message.AssistantMessage;
import com.gourdai.ai.chat.message.ChatMessage;
import com.gourdai.ai.chat.message.MessageProtocolState;
import com.gourdai.ai.chat.message.MessageSemanticHasher;
import com.gourdai.ai.chat.tool.ToolCall;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * openai-responses「单一内容权威」契约测试。
 *
 * <p><b>问题背景</b>：4.1 把思考与正文同时存在语义字段（{@code text} / {@code thinking}）
 * 和厂商原始副本（{@code protocolStates}）两处，实测二者逐字节相同（比值 1.000000）。
 * 由此产生三个独立缺陷：</p>
 * <ol>
 *   <li><b>非法形态出站</b>：副本里的 message 项是 output 形态（{@code content[].type=output_text}），
 *       逐字回放进 {@code input} 会被严格网关拒绝：
 *       {@code 400 MissingParameter input.type}，且重试不可能修复；</li>
 *   <li><b>token 加速消耗</b>：副本里的 reasoning {@code summary} 是思考明文的第二份拷贝，
 *       逐字回放使它每轮全量上行——实测占单轮上行 token 的 <b>71.74%</b>
 *       （1,029,258 字符明文 对 47 个 id 的 4,559 字符，<b>226 倍</b>）；</li>
 *   <li><b>整包判废</b>：语义摘要覆盖 text/thinking，上层 {@code dedupeAggregatedThinking}
 *       归一化思考后摘要陈旧 → {@code resolveData} 返回空 → 连 reasoning 凭证与
 *       function_call 骨架一起丢，进而诱发工具配对缺失与重试风暴。</li>
 * </ol>
 *
 * <p><b>修复契约</b>：协议状态只存<b>不可从语义字段重建的东西</b>（reasoning 的
 * id / encrypted_content、function_call 的身份 call_id / name、output_index 顺序、phase 与
 * 长度锚点、无语义投影的 server-tool 载荷）；内容一律读时从语义字段补水。
 * 摘要改按协议分域为<b>身份锚点</b>（toolCall 的 index/id/name），对明文归一化免疫。</p>
 *
 * <p><b>实测依据</b>（真实网关，非推断）：gpt-5.6-sol / qwen3.8-max / deepseek-V4.1-Flash
 * 三端点对 id-only 形态 {@code {type:"reasoning", id, summary:[]}} 均返回 200；
 * DeepSeek 从不下发 {@code encrypted_content}，故 id-only 是其唯一可行的凭证回放形态。</p>
 *
 * @author gourdai
 * @since 4.1.1
 */
public class OpenaiResponsesSingleContentAuthorityTest {

    private static final String PROTOCOL_ID = "openai.responses";
    private static final String OUTPUT_ITEMS = "responses_output_items";
    private static final String MESSAGE_ITEMS = "response_message_items";
    private static final String REASONING_ITEMS = "reasoning_items";
    private static final String LEN = "len";

    // ---------------------------------------------------------------- 构造工具

    private static Map<String, Object> item(String type, Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", type);
        for (int i = 0; i + 1 < kv.length; i += 2) {
            m.put(String.valueOf(kv[i]), kv[i + 1]);
        }
        return m;
    }

    private static Map<String, Object> wrapper(int outputIndex, Map<String, Object> item) {
        Map<String, Object> w = new LinkedHashMap<>();
        w.put("output_index", outputIndex);
        w.put("item", item);
        return w;
    }

    /** v2 骨架形态：只有身份与顺序，无任何内容明文。 */
    private static MessageProtocolState skeletonState(Map<String, Object>... items) {
        List<Map<String, Object>> outputItems = new ArrayList<>();
        for (int i = 0; i < items.length; i++) {
            outputItems.add(wrapper(i, items[i]));
        }
        Map<String, Object> data = new LinkedHashMap<>();
        data.put(OUTPUT_ITEMS, outputItems);
        return new MessageProtocolState(OpenaiResponsesMessageStateSupport.VERSION, data);
    }

    private static AssistantMessage message(String text, String thinking, List<ToolCall> toolCalls,
                                            MessageProtocolState state) {
        return AssistantMessage.snapshot(text, thinking, toolCalls, null, null, null,
                state == null ? null : Collections.singletonMap(PROTOCOL_ID, state), null);
    }

    private static ONode buildInput(List<ChatMessage> messages, ChatOptions options) {
        ChatConfig config = new ChatConfig();
        config.setModel("deepseek-V4.1-Flash");
        return new OpenaiResponsesRequestBuilder()
                .build(config, options, messages, false)
                .get("input");
    }

    private static ONode buildInput(AssistantMessage assistant) {
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                ChatMessage.ofUser("say ok"), assistant, ChatMessage.ofUser("again")));
        return buildInput(messages, ChatOptions.of());
    }

    private static List<ONode> itemsOfType(ONode input, String type) {
        List<ONode> found = new ArrayList<>();
        for (ONode n : input.getArray()) {
            if (type.equals(n.get("type").getString())) {
                found.add(n);
            }
        }
        return found;
    }

    private static List<ONode> assistantItems(ONode input) {
        List<ONode> found = new ArrayList<>();
        for (ONode n : input.getArray()) {
            if ("assistant".equals(n.get("role").getString())) {
                found.add(n);
            }
        }
        return found;
    }

    // ---------------------------------------------------------------- 缺陷 1：非法形态出站

    @Test
    @DisplayName("出站报文任何位置都不得出现 output_text（400 input.type 根因）")
    void outboundMustNeverContainOutputText() {
        // 存量 v1 逐字快照：output 形态的 message 项，content[].type=output_text
        Map<String, Object> contentPart = new LinkedHashMap<>();
        contentPart.put("type", "output_text");
        contentPart.put("text", "ok");
        contentPart.put("annotations", new ArrayList<>());
        Map<String, Object> legacy = item("message",
                "id", "msg_legacy", "status", "completed", "role", "assistant",
                "content", new ArrayList<>(Collections.singletonList(contentPart)));

        Map<String, Object> data = new LinkedHashMap<>();
        data.put(OUTPUT_ITEMS, new ArrayList<>(Collections.singletonList(wrapper(0, legacy))));
        AssistantMessage m = message("ok", "", null,
                new MessageProtocolState(OpenaiResponsesMessageStateSupport.LEGACY_VERSION, data));

        ONode input = buildInput(m);
        assertFalse(input.toJson().contains("\"output_text\""),
                "出站 input 中不得出现 output_text 内容部件，否则严格网关报 400 MissingParameter input.type");
    }

    @Test
    @DisplayName("v2 骨架的 message 项：正文从语义 text 补水，以 EasyInputMessage 字符串形态出站")
    void messageContentRehydratedFromSemanticText() {
        Map<String, Object> skeleton = item("message",
                "id", "msg_1", "status", "completed", "role", "assistant", "len", 5);
        AssistantMessage m = message("hello", "", null, skeletonState(skeleton));

        List<ONode> assistants = assistantItems(buildInput(m));
        assertEquals(1, assistants.size(), "应只出站一个 assistant 项");
        assertFalse(assistants.get(0).get("content").isArray(),
                "content 必须是字符串而非部件数组");
        assertEquals("hello", assistants.get(0).get("content").getString(),
                "正文必须来自语义字段（唯一内容权威）");
    }

    // ---------------------------------------------------------------- 缺陷 2：token 加速消耗

    @Test
    @DisplayName("reasoning 只回放凭证：出站含 id，且绝不携带 summary 思考明文")
    void reasoningReplaysCredentialsOnly() {
        String thinking = "这是一段很长的思考明文，绝不应该被重新上行。";
        Map<String, Object> reasoning = item("reasoning", "id", "rs_abc", "status", "completed");
        AssistantMessage m = message("答案", thinking, null, skeletonState(reasoning));

        ONode input = buildInput(m);
        List<ONode> reasoningItems = itemsOfType(input, "reasoning");
        assertEquals(1, reasoningItems.size(), "reasoning 项必须照常回放（凭证形态）");
        assertEquals("rs_abc", reasoningItems.get(0).get("id").getString());
        assertTrue(reasoningItems.get(0).get("summary").isArray(),
                "官方要求 summary 必填（可为空数组），缺失会被端点 400");
        assertEquals(0, reasoningItems.get(0).get("summary").size(), "summary 必须为空数组");

        String json = input.toJson();
        assertFalse(json.contains("绝不应该被重新上行"), "思考明文不得以任何形式出站");
        assertFalse(json.contains("summary_text"), "不得出现 summary_text 部件");
    }

    @Test
    @DisplayName("携带 encrypted_content 时凭证一并回放（官方无状态续接形态）")
    void reasoningReplaysEncryptedContentWhenPresent() {
        Map<String, Object> reasoning = item("reasoning",
                "id", "rs_enc", "encrypted_content", "gAAAAAB-fake-credential");
        AssistantMessage m = message("答案", "思考", null, skeletonState(reasoning));

        List<ONode> reasoningItems = itemsOfType(buildInput(m), "reasoning");
        assertEquals(1, reasoningItems.size());
        assertEquals("rs_enc", reasoningItems.get(0).get("id").getString());
        assertEquals("gAAAAAB-fake-credential",
                reasoningItems.get(0).get("encrypted_content").getString());
    }

    @Test
    @DisplayName("无任何凭证时默认不回放思考明文（reasoning_text 兜底默认关闭）")
    void reasoningTextFallbackDisabledByDefault() {
        // 既无 protocolState，也无 id / encrypted_content：旧行为会把 thinking 塞进 reasoning_text
        AssistantMessage m = message("答案", "一大段思考明文", null, null);

        ONode input = buildInput(m);
        assertEquals(0, itemsOfType(input, "reasoning").size(),
                "默认不得回放思考明文：实测该兜底占单轮上行 token 的 71.74%");
        assertFalse(input.toJson().contains("reasoning_text"), "不得出现 reasoning_text 部件");
        assertFalse(input.toJson().contains("一大段思考明文"), "思考明文不得出站");
    }

    @Test
    @DisplayName("显式开启开关后才回放 reasoning_text（供不下发任何凭证的网关使用）")
    void reasoningTextFallbackOptIn() {
        AssistantMessage m = message("答案", "一段思考", null, null);
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                ChatMessage.ofUser("go"), m, ChatMessage.ofUser("again")));

        ChatOptions options = ChatOptions.of();
        options.optionSet("responses_reasoning_text_replay_enabled", true);
        ONode input = buildInput(messages, options);

        List<ONode> reasoningItems = itemsOfType(input, "reasoning");
        assertEquals(1, reasoningItems.size(), "开启后应回放 reasoning_text");
        assertTrue(input.toJson().contains("一段思考"));
    }

    @Test
    @DisplayName("内部开关不得透传出站（否则会被当作非法参数）")
    void internalSwitchMustNotLeakToRequestBody() {
        AssistantMessage m = message("答案", "思考", null, null);
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                ChatMessage.ofUser("go"), m, ChatMessage.ofUser("again")));

        ChatOptions options = ChatOptions.of();
        options.optionSet("responses_reasoning_text_replay_enabled", true);
        ChatConfig config = new ChatConfig();
        config.setModel("deepseek-V4.1-Flash");
        ONode root = new OpenaiResponsesRequestBuilder()
                .build(config, options, messages, false);

        assertFalse(root.hasKey("responses_reasoning_text_replay_enabled"),
                "仅控制方言本地行为的开关不得出现在请求顶层");
    }

    // ---------------------------------------------------------------- 缺陷 3：整包判废

    @Test
    @DisplayName("思考归一化后协议状态不得失效（原探针断言的是缺陷行为，此处反转）")
    void thinkingDedupeMustNotVoidProtocolState() {
        String anchor = "让我先读取任务清单和记忆，了解当前进度。";

        Map<String, Object> reasoning = item("reasoning", "id", "rs_1", "status", "completed");
        Map<String, Object> call = item("function_call",
                "id", "fc_1", "call_id", "call_1", "name", "read", "status", "completed");
        MessageProtocolState state = skeletonState(reasoning, call);

        List<ToolCall> toolCalls = new ArrayList<>();
        toolCalls.add(new ToolCall("0", "call_1", "read", "{}", new LinkedHashMap<>()));

        // 聚合态思考为「全文 × 3」，随后被上层归一化为单份
        AssistantMessage before = message("正文", anchor + anchor + anchor, toolCalls, state);
        assertFalse(OpenaiResponsesMessageStateSupport.resolveData(before).isEmpty(),
                "前提：归一化前协议状态可用");

        AssistantMessage deduped = AgentUtil.dedupeAggregatedThinking(before, anchor);
        assertEquals(anchor, deduped.getThinking(), "前提：思考确已被折叠为单份");

        Map<String, Object> after = OpenaiResponsesMessageStateSupport.resolveData(deduped);
        assertFalse(after.isEmpty(),
                "思考归一化不得使协议状态整包判废：锚点只覆盖 toolCall 身份，与明文无关");
        assertNotNull(after.get(OUTPUT_ITEMS), "output_items 骨架必须存活");

        // 端到端：归一化后仍能凭证回放，不退化为思考明文
        List<ToolCall> keptCalls = new ArrayList<>();
        keptCalls.add(new ToolCall("0", "call_1", "read", "{}", new LinkedHashMap<>()));
        AssistantMessage withCalls = message(deduped.getText(), deduped.getThinking(), keptCalls,
                deduped.getProtocolState(PROTOCOL_ID));
        ONode input = buildInput(withCalls);
        List<ONode> reasoningItems = itemsOfType(input, "reasoning");
        assertEquals(1, reasoningItems.size(), "归一化后 reasoning 凭证必须仍可回放");
        assertEquals("rs_1", reasoningItems.get(0).get("id").getString());
        assertFalse(input.toJson().contains("reasoning_text"),
                "不得因判废退化到思考明文兜底（那正是 71.74% token 的来源）");
    }

    @Test
    @DisplayName("锚点漂移时降级为凭证视图，而非整包判废（reasoning 凭证必须存活）")
    void anchorMismatchDegradesToCredentialsNotFullVoid() {
        Map<String, Object> reasoning = item("reasoning", "id", "rs_keep", "status", "completed");
        Map<String, Object> call = item("function_call",
                "id", "fc_1", "call_id", "call_gone", "name", "read", "status", "completed");

        List<Map<String, Object>> outputItems = new ArrayList<>();
        outputItems.add(wrapper(0, reasoning));
        outputItems.add(wrapper(1, call));
        Map<String, Object> data = new LinkedHashMap<>();
        data.put(OUTPUT_ITEMS, outputItems);
        data.put(REASONING_ITEMS, new ArrayList<>(Collections.singletonList(
                item("reasoning", "id", "rs_keep"))));
        MessageProtocolState state =
                new MessageProtocolState(OpenaiResponsesMessageStateSupport.VERSION, data);

        List<ToolCall> original = new ArrayList<>();
        original.add(new ToolCall("0", "call_gone", "read", "{}", new LinkedHashMap<>()));
        AssistantMessage bound = message("正文", "思考", original, state);

        // 用不同的 toolCalls 重建：锚点（call_id 集合）随之漂移
        List<ToolCall> changed = new ArrayList<>();
        changed.add(new ToolCall("0", "call_other", "write", "{}", new LinkedHashMap<>()));
        AssistantMessage drifted = message("正文", "思考", changed,
                bound.getProtocolState(PROTOCOL_ID));

        Map<String, Object> resolved = OpenaiResponsesMessageStateSupport.resolveData(drifted);
        assertFalse(resolved.isEmpty(),
                "锚点漂移不得整包判废：那会连带丢掉 reasoning 凭证并逼出思考明文兜底");
        assertNotNull(resolved.get(REASONING_ITEMS), "reasoning 凭证必须存活");
        assertFalse(resolved.containsKey(OUTPUT_ITEMS),
                "依赖 toolCall 身份的 output_items 骨架应被丢弃");
    }

    // ---------------------------------------------------------------- 内容补水正确性

    @Test
    @DisplayName("function_call 的 arguments 从语义 toolCalls 按 call_id 补水")
    void functionCallArgumentsRehydratedFromSemanticToolCalls() {
        Map<String, Object> call = item("function_call",
                "id", "fc_1", "call_id", "call_1", "name", "bash", "status", "completed");
        List<ToolCall> toolCalls = new ArrayList<>();
        toolCalls.add(new ToolCall("0", "call_1", "bash", "{\"command\":\"ls\"}", new LinkedHashMap<>()));

        AssistantMessage m = message("", "", toolCalls, skeletonState(call));
        ONode input = buildInput(m);

        List<ONode> calls = itemsOfType(input, "function_call");
        assertEquals(1, calls.size(), "function_call 必须回放且只回放一次");
        assertEquals("call_1", calls.get(0).get("call_id").getString());
        assertEquals("bash", calls.get(0).get("name").getString());
        assertTrue(calls.get(0).get("arguments").getString().contains("ls"),
                "arguments 必须来自语义 toolCalls（唯一内容权威）");
    }

    @Test
    @DisplayName("骨架的 call_id 在语义 toolCalls 中不存在时优雅跳过，不得整包判废")
    void unmatchedFunctionCallSkeletonIsSkipped() {
        Map<String, Object> reasoning = item("reasoning", "id", "rs_x", "status", "completed");
        Map<String, Object> call = item("function_call",
                "id", "fc_1", "call_id", "call_missing", "name", "read", "status", "completed");

        List<ToolCall> toolCalls = new ArrayList<>();
        toolCalls.add(new ToolCall("0", "call_present", "write", "{}", new LinkedHashMap<>()));

        AssistantMessage m = message("正文", "", toolCalls, skeletonState(reasoning, call));
        ONode input = buildInput(m);

        assertEquals(0, itemsOfType(input, "function_call").size(),
                "无匹配 call_id 的 v2 骨架没有 arguments 可补水，必须跳过而非伪造");
        assertEquals(1, itemsOfType(input, "reasoning").size(),
                "跳过一项不得影响同消息内其它项的回放");
    }

    @Test
    @DisplayName("多 phase 正文按长度锚点切片，既不丢内容也不重复出站")
    void multiPhaseSegmentedByLengthAnchors() {
        String commentary = "让我想想";
        String finalAnswer = "答案是42";
        String semanticText = commentary + finalAnswer;

        Map<String, Object> m1 = item("message",
                "id", "msg_1", "status", "completed", "role", "assistant",
                "phase", "commentary", "len", commentary.length());
        Map<String, Object> m2 = item("message",
                "id", "msg_2", "status", "completed", "role", "assistant",
                "phase", "final_answer", "len", finalAnswer.length());

        AssistantMessage m = message(semanticText, "", null, skeletonState(m1, m2));
        ONode input = buildInput(m);

        List<ONode> assistants = assistantItems(input);
        assertEquals(2, assistants.size(), "两个 phase 段应各自出站");
        assertEquals(commentary, assistants.get(0).get("content").getString());
        assertEquals("commentary", assistants.get(0).get("phase").getString());
        assertEquals(finalAnswer, assistants.get(1).get("content").getString());
        assertEquals("final_answer", assistants.get(1).get("phase").getString());

        String json = input.toJson();
        assertEquals(1, json.split("让我想想", -1).length - 1, "同一份正文不得重复出站");
    }

    @Test
    @DisplayName("长度锚点与语义正文不符（正文已归一化）时退化为单段，不丢内容不重复")
    void lengthAnchorMismatchDegradesToSingleSegment() {
        Map<String, Object> m1 = item("message",
                "id", "msg_1", "status", "completed", "role", "assistant",
                "phase", "commentary", "len", 999);
        Map<String, Object> m2 = item("message",
                "id", "msg_2", "status", "completed", "role", "assistant",
                "phase", "final_answer", "len", 888);

        AssistantMessage m = message("真实正文", "", null, skeletonState(m1, m2));
        ONode input = buildInput(m);

        List<ONode> assistants = assistantItems(input);
        assertEquals(1, assistants.size(), "锚点不可用时只出站一段");
        assertEquals("真实正文", assistants.get(0).get("content").getString(), "正文不得丢失");
    }

    @Test
    @DisplayName("无语义投影的 server-tool 项必须逐字保留（快照是其唯一记录）")
    void serverToolResidualReplayedVerbatim() {
        // 注意：不能用 item(...) 助手构造嵌套 action——它的首参是 type 键的值，不是键名。
        Map<String, Object> action = new LinkedHashMap<>();
        action.put("type", "search");
        action.put("query", "gourdai");
        Map<String, Object> webSearch = item("web_search_call",
                "id", "ws_1", "status", "completed", "action", action);
        AssistantMessage m = message("", "", null, skeletonState(webSearch));

        ONode input = buildInput(m);
        List<ONode> found = itemsOfType(input, "web_search_call");
        assertEquals(1, found.size(), "server-tool 项必须回放");
        assertEquals("search", found.get(0).get("action").get("type").getString());
        assertEquals("gourdai", found.get(0).get("action").get("query").getString(),
                "server-tool 载荷无语义投影，必须逐字保留");
    }

    @Test
    @DisplayName("无工具调用的纯回答轮：reasoning 凭证必须存活（空锚点不得 fail-closed）")
    void emptyAnchorMustNotVoidResponsesCredentials() {
        // 【回归护栏】空锚点 fail-closed 曾被误用于全部锚点型协议，导致 Responses
        // 无 toolCalls 的纯回答轮整包判废 → 凭证丢失 → 退化回本次改造所治的膨胀。
        // 本用例专守这一点：ScopeTest 的用例全部带 toolCalls，捕不到该回归。
        String hash = MessageSemanticHasher.hashFor(PROTOCOL_ID,
                message("纯文本回答", "思考", null, null));
        assertNotNull(hash, "Responses 的凭证挂在独立 reasoning item 上，与有无工具调用无关："
                + "空锚点返回 null 会使纯回答轮整包判废");

        // 端到端：无 toolCalls 时凭证仍须真的出站
        Map<String, Object> reasoning = item("reasoning", "id", "rs_no_tools", "status", "completed");
        AssistantMessage m = message("纯文本回答", "思考", null, skeletonState(reasoning));
        List<ONode> found = itemsOfType(buildInput(m), "reasoning");
        assertEquals(1, found.size(), "纯回答轮的 reasoning 凭证必须存活");
        assertEquals("rs_no_tools", found.get(0).get("id").getString());
    }

    @Test
    @DisplayName("协议 id 常量守护：分域靠字符串匹配，改名会静默退化为全文口径")
    void responsesProtocolIdStaysInSyncWithAnchorScope() {
        // MessageSemanticHasher 的分域表用的是字面量（message 包在底层，反向 import 方言会
        // 造成包级循环）。PROTOCOL_ID 是包私有，只有本包内的测试能引用到真常量——
        // Gemini 两个常量已在 MessageSemanticHasherScopeTest 里有守护，唯独它没有。
        assertEquals("openai.responses", OpenaiResponsesMessageStateSupport.PROTOCOL_ID,
                "常量若被改名，分域会静默失效且所有既有用例仍绿");

        List<ToolCall> calls = new ArrayList<>();
        calls.add(new ToolCall("0", "call_1", "read", "{}", new LinkedHashMap<>()));
        AssistantMessage m = message("正文", "思考", calls, null);
        assertEquals(MessageSemanticHasher.anchorHash(m),
                MessageSemanticHasher.hashFor(OpenaiResponsesMessageStateSupport.PROTOCOL_ID, m),
                "常量值必须真的命中「纯身份锚点」分域（而非退化到全文、也非含 args 的 Gemini 口径）");
    }

    @Test
    @DisplayName("快照无 message 项但语义正文非空时，正文不得因提前 return 而丢失")
    void semanticTextNotLostWhenSnapshotHasNoMessageItem() {
        Map<String, Object> reasoning = item("reasoning", "id", "rs_only", "status", "completed");
        AssistantMessage m = message("这是正文", "", null, skeletonState(reasoning));

        ONode input = buildInput(m);
        assertEquals(1, itemsOfType(input, "reasoning").size());
        assertTrue(input.toJson().contains("这是正文"), "正文必须由兜底路径补回");
    }

    // ---------------------------------------------------------------- 存量数据兼容

    @Test
    @DisplayName("存量 v1 快照：思考明文副本被忽略，只取凭证（老会话零迁移即获缩减）")
    void legacyV1PlaintextIgnoredCredentialsKept() {
        String storedThinking = "存量快照里的思考明文副本";
        Map<String, Object> summaryPart = new LinkedHashMap<>();
        summaryPart.put("type", "summary_text");
        summaryPart.put("text", storedThinking);
        Map<String, Object> reasoning = item("reasoning",
                "id", "rs_legacy", "status", "completed",
                "summary", new ArrayList<>(Collections.singletonList(summaryPart)));

        Map<String, Object> data = new LinkedHashMap<>();
        data.put(OUTPUT_ITEMS, new ArrayList<>(Collections.singletonList(wrapper(0, reasoning))));
        MessageProtocolState state =
                new MessageProtocolState(OpenaiResponsesMessageStateSupport.LEGACY_VERSION, data);

        AssistantMessage m = message("答案", storedThinking, null, state);
        ONode input = buildInput(m);

        List<ONode> reasoningItems = itemsOfType(input, "reasoning");
        assertEquals(1, reasoningItems.size(), "v1 存量数据的凭证仍须可用");
        assertEquals("rs_legacy", reasoningItems.get(0).get("id").getString());
        assertFalse(input.toJson().contains("summary_text"),
                "v1 存量快照里的思考明文副本必须被忽略，不得上行");
    }

    @Test
    @DisplayName("未知版本 fail-closed：不得猜测格式")
    void unknownVersionFailsClosed() {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put(REASONING_ITEMS, new ArrayList<>(Collections.singletonList(
                item("reasoning", "id", "rs_unknown"))));
        MessageProtocolState state = new MessageProtocolState(99, data);

        AssistantMessage m = message("答案", "", null, state);
        assertTrue(OpenaiResponsesMessageStateSupport.resolveData(m).isEmpty(),
                "版本无法识别时必须 fail-closed");
    }
}
