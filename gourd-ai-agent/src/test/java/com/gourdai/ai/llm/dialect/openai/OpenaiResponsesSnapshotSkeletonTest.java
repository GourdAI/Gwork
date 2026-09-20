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

import com.gourdai.ai.chat.ChatAccumulator;
import com.gourdai.ai.chat.message.MessageProtocolState;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import org.noear.snack4.Options;
import org.noear.snack4.json.JsonReader;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * openai-responses <b>写侧</b>契约测试：协议快照只存凭证与骨架，不存内容明文。
 *
 * <p>与 {@code OpenaiResponsesSingleContentAuthorityTest}（读侧）互补，共同锁定
 * 「单一内容权威」这条契约的两端。写侧此前<b>完全没有测试覆盖</b>——全仓无任何测试触及
 * {@code OpenaiResponsesResponseParser}，故本类是该改造的唯一写侧实证。</p>
 *
 * <p><b>为何要剥明文</b>：4.1 把服务端 output item 逐字存进 {@code responses_output_items}，
 * 使思考与正文各多出一份拷贝（实测逐字节相同、比值 1.000000）。后果有三：
 * 落盘 2 倍；reasoning 的 {@code summary} 被逐字回放导致每轮全量上行思考明文
 * （实测占单轮上行 token 的 71.74%）；message 的 {@code content[].output_text} 是 output 形态，
 * 回放进 {@code input} 会被严格网关拒绝（{@code 400 MissingParameter input.type}）。</p>
 *
 * <p>4.1.1 改用<b>保留键白名单</b>骨架化（而非删除键黑名单）：只有身份与顺序信息能进快照，
 * 厂商未来新增任何载荷字段都不会漏存。无语义投影的 server-tool 项（web_search_call 等）
 * 仍逐字保留——快照是它们的唯一记录。</p>
 *
 * @author gourdai
 * @since 4.1.1
 */
public class OpenaiResponsesSnapshotSkeletonTest {

    /** 与真实网关同构的一段 Responses output（含四类 item，覆盖剥/留两种处置）。 */
    private static final String OUTPUT_JSON = "["
            + "{\"type\":\"reasoning\",\"id\":\"rs_1\",\"status\":\"completed\","
            + "\"summary\":[{\"type\":\"summary_text\",\"text\":\"这是不该被存下来的思考明文\"}]},"
            + "{\"type\":\"message\",\"id\":\"msg_1\",\"status\":\"completed\",\"role\":\"assistant\","
            + "\"phase\":\"final_answer\","
            + "\"content\":[{\"type\":\"output_text\",\"text\":\"正文内容\",\"annotations\":[]}]},"
            + "{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_1\",\"name\":\"bash\","
            + "\"status\":\"completed\",\"arguments\":\"{\\\"command\\\":\\\"ls\\\"}\"},"
            + "{\"type\":\"web_search_call\",\"id\":\"ws_1\",\"status\":\"completed\","
            + "\"action\":{\"type\":\"search\",\"query\":\"gourdai\"}}"
            + "]";

    @SuppressWarnings("unchecked")
    private static Map<String, Object> capture() throws Exception {
        // ChatAccumulator 的构造器仅存字段、不解引用 req，而 captureReplayMetadata 只用
        // getAggregationMetadata()，故无需构造真实 ChatRequest（其构造器会解引用 session）。
        ChatAccumulator acc = new ChatAccumulator(null, false);
        ONode output = new JsonReader(OUTPUT_JSON, Options.of()).readLast();

        Method m = OpenaiResponsesResponseParser.class.getDeclaredMethod(
                "captureReplayMetadata", ChatAccumulator.class, ONode.class, int.class);
        m.setAccessible(true);
        m.invoke(new OpenaiResponsesResponseParser(), acc, output, 0);

        MessageProtocolState state =
                OpenaiResponsesMessageStateSupport.fromAggregation(acc.getAggregationMetadata());
        assertNotNull(state, "前提：应产出协议状态");
        assertEquals(OpenaiResponsesMessageStateSupport.VERSION, state.getVersion(),
                "新数据必须落 v2 骨架形态");
        return state.getData();
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> outputItems(Map<String, Object> data) {
        List<Map<String, Object>> raw =
                (List<Map<String, Object>>) data.get(OpenaiResponsesMessageStateSupport.OUTPUT_ITEMS);
        assertNotNull(raw, "output_items 必须存在（承载顺序与身份）");
        List<Map<String, Object>> items = new ArrayList<>();
        for (Map<String, Object> w : raw) {
            items.add((Map<String, Object>) w.get("item"));
        }
        return items;
    }

    private static Map<String, Object> findByType(List<Map<String, Object>> items, String type) {
        for (Map<String, Object> i : items) {
            if (type.equals(i.get("type"))) {
                return i;
            }
        }
        return null;
    }

    @Test
    @DisplayName("reasoning 骨架：只留凭证，剥掉 summary 思考明文")
    void reasoningSkeletonKeepsCredentialsOnly() throws Exception {
        Map<String, Object> reasoning = findByType(outputItems(capture()), "reasoning");

        assertNotNull(reasoning);
        assertEquals("rs_1", reasoning.get("id"), "凭证 id 必须保留");
        assertEquals("completed", reasoning.get("status"));
        assertFalse(reasoning.containsKey("summary"),
                "summary 是思考明文的第二份拷贝，绝不得入快照（实测占单轮上行 token 71.74%）");
    }

    @Test
    @DisplayName("message 骨架：剥掉 content 明文，改存长度锚点")
    void messageSkeletonStoresLengthAnchorNotText() throws Exception {
        Map<String, Object> msg = findByType(outputItems(capture()), "message");

        assertNotNull(msg);
        assertEquals("msg_1", msg.get("id"));
        assertEquals("assistant", msg.get("role"));
        assertEquals("final_answer", msg.get("phase"), "phase 分段能力必须保留");
        assertFalse(msg.containsKey("content"),
                "output_text 是正文的第二份拷贝，且属 output 形态，绝不得入快照");
        assertEquals(4, msg.get(OpenaiResponsesMessageStateSupport.MESSAGE_ITEM_LEN),
                "长度锚点必须等于正文字符数，读侧据此从语义 text 切片");
    }

    @Test
    @DisplayName("function_call 骨架：剥掉 arguments，只留配对身份")
    void functionCallSkeletonKeepsIdentityOnly() throws Exception {
        Map<String, Object> call = findByType(outputItems(capture()), "function_call");

        assertNotNull(call);
        assertEquals("call_1", call.get("call_id"), "call_id 是与工具输出配对的依据，必须保留");
        assertEquals("bash", call.get("name"));
        assertEquals("fc_1", call.get("id"));
        assertFalse(call.containsKey("arguments"),
                "arguments 已由语义 toolCalls 承载，不得存第二份（含整份文件写入体，实测占 5.51%）");
    }

    @Test
    @DisplayName("server-tool 项无语义投影：必须逐字保留（快照是其唯一记录）")
    void serverToolItemKeptVerbatim() throws Exception {
        Map<String, Object> ws = findByType(outputItems(capture()), "web_search_call");

        assertNotNull(ws, "web_search_call 在白名单内，必须被采集");
        assertEquals("ws_1", ws.get("id"));
        assertNotNull(ws.get("action"), "server-tool 载荷不得被骨架化剥除");
        @SuppressWarnings("unchecked")
        Map<String, Object> action = (Map<String, Object>) ws.get("action");
        assertEquals("gourdai", action.get("query"), "载荷必须逐字可用，否则无法多轮回放");
    }

    @Test
    @DisplayName("message_items：以长度锚点取代正文副本")
    void messageItemsUseLengthAnchor() throws Exception {
        Map<String, Object> data = capture();

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> messageItems = (List<Map<String, Object>>)
                data.get(OpenaiResponsesMessageStateSupport.MESSAGE_ITEMS);
        assertNotNull(messageItems);
        assertEquals(1, messageItems.size());

        Map<String, Object> item = messageItems.get(0);
        assertEquals("msg_1", item.get("id"));
        assertEquals("final_answer", item.get("phase"));
        assertFalse(item.containsKey("text"), "正文副本必须被长度锚点取代");
        assertEquals(4, item.get(OpenaiResponsesMessageStateSupport.MESSAGE_ITEM_LEN));
    }

    @Test
    @DisplayName("reasoning_items：仍是纯凭证（改造前即合规，此处锁死不得回退）")
    void reasoningItemsRemainCredentialOnly() throws Exception {
        Map<String, Object> data = capture();

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> reasoningItems = (List<Map<String, Object>>)
                data.get(OpenaiResponsesMessageStateSupport.REASONING_ITEMS);
        assertNotNull(reasoningItems);
        assertEquals(1, reasoningItems.size());
        assertEquals("rs_1", reasoningItems.get(0).get("id"));
        assertFalse(reasoningItems.get(0).containsKey("summary"));
    }

    @Test
    @DisplayName("output_index 顺序必须保留（读侧据此还原 reasoning → message → function_call 次序）")
    void outputIndexOrderPreserved() throws Exception {
        Map<String, Object> data = capture();

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> raw = (List<Map<String, Object>>)
                data.get(OpenaiResponsesMessageStateSupport.OUTPUT_ITEMS);
        assertEquals(4, raw.size(), "四类 item 都应被采集");
        for (int i = 0; i < raw.size(); i++) {
            assertEquals(i, raw.get(i).get("output_index"), "output_index 必须与原始次序一致");
        }
    }

    @Test
    @DisplayName("整份快照不得含任何内容明文（思考 / 正文 / 工具入参）")
    void snapshotContainsNoContentPlaintext() throws Exception {
        String json = ONode.ofBean(capture()).toJson();

        assertFalse(json.contains("这是不该被存下来的思考明文"), "快照不得含思考明文");
        assertFalse(json.contains("正文内容"), "快照不得含正文明文");
        assertFalse(json.contains("command"), "快照不得含工具入参明文");
        assertTrue(json.contains("rs_1") && json.contains("call_1") && json.contains("gourdai"),
                "凭证、配对身份与 server-tool 载荷必须在场");
    }
}
