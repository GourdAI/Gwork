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
package com.gourdai.ai.llm.dialect.anthropic;

import com.gourdai.agent.util.AgentUtil;
import com.gourdai.ai.chat.message.AssistantMessage;
import com.gourdai.ai.chat.message.MessageProtocolState;
import com.gourdai.ai.chat.message.MessageSemanticHasher;
import com.gourdai.ai.chat.tool.ToolCall;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * Anthropic Messages「保护性判废」必须保留的对照测试。
 *
 * <p><b>为何 Anthropic 不能跟着改用锚点摘要</b>：Anthropic 的 {@code signature} 是对其
 * {@code thinking} 块<b>逐字内容</b>的密码学签名，二者是一个不可拆分的凭证束——协议状态里
 * 存有 thinking 的原始块，这不是「同一份内容存两份」的冗余，而是签名可验证的前提。</p>
 *
 * <p>一旦上层归一化改写了思考（实测存量数据漂移率 47.5%），签名必然验不过。此时正确行为是
 * <b>降级为不下发思考块</b>（实测出站体积仅为 OpenAI Responses 的 30.4%，且端点接受），
 * 而不是下发一个无效签名被端点拒绝。因此 {@code anthropic.messages} 刻意<b>不</b>登记进
 * {@link MessageSemanticHasher} 的锚点协议集合，继续走全文摘要。</p>
 *
 * <p>本测试与 {@code OpenaiResponsesSingleContentAuthorityTest#thinkingDedupeMustNotVoidProtocolState}
 * 构成一对<b>方向相反</b>的断言：同样的思考归一化，Responses 必须存活、Anthropic 必须判废。
 * 这正是「哈希按协议分域」的核心契约，任一侧被误改都会在此暴露。</p>
 *
 * @author gourdai
 * @since 4.1.1
 */
public class AnthropicThinkingSignatureGuardTest {

    private static final String ANCHOR = "让我先确认签名与思考块的绑定关系。";

    private static Map<String, Object> anthropicData() {
        Map<String, Object> thinkingBlock = new LinkedHashMap<>();
        thinkingBlock.put("type", "thinking");
        thinkingBlock.put("thinking", ANCHOR);
        thinkingBlock.put("signature", "WaUjzkypQ2mUEVM-signed");

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("thinkingSignature", "WaUjzkypQ2mUEVM-signed");
        data.put("contentBlocksRaw",
                new ArrayList<>(Collections.singletonList(thinkingBlock)));
        return data;
    }

    private static List<ToolCall> toolCalls() {
        List<ToolCall> calls = new ArrayList<>();
        calls.add(new ToolCall("0", "call_1", "read", "{}", new LinkedHashMap<>()));
        return calls;
    }

    private static AssistantMessage bound(String thinking) {
        MessageProtocolState state = AnthropicMessageStateSupport.createState(anthropicData());
        assertNotNull(state, "前提：Anthropic 协议状态已创建");
        return AssistantMessage.snapshot("正文", thinking, toolCalls(), null, null, null,
                Collections.singletonMap(AnthropicMessageStateSupport.PROTOCOL_ID, state), null);
    }

    @Test
    @DisplayName("未归一化时协议状态可用（签名与思考块逐字一致）")
    void replayDataAvailableWhenUnchanged() {
        AssistantMessage m = bound(ANCHOR);

        Map<String, Object> resolved = AnthropicMessageStateSupport.resolveData(m);
        assertNotNull(resolved, "签名与思考一致时必须可回放");
        assertEquals("WaUjzkypQ2mUEVM-signed", resolved.get("thinkingSignature"));
    }

    @Test
    @DisplayName("思考归一化后必须判废：宁可不下发思考块，也不下发无效签名")
    void thinkingNormalizationVoidsReplayData() {
        AssistantMessage before = bound(ANCHOR + ANCHOR);
        assertNotNull(AnthropicMessageStateSupport.resolveData(before),
                "前提：归一化前可回放");

        AssistantMessage deduped = AgentUtil.dedupeAggregatedThinking(before, ANCHOR);
        assertEquals(ANCHOR, deduped.getThinking(), "前提：思考确已被折叠为单份");

        assertNull(AnthropicMessageStateSupport.resolveData(deduped),
                "思考已改写 → signature 必然验不过 → 必须判废，改为不下发思考块。"
                        + "此处若返回数据，说明 Anthropic 被误改成了锚点口径");
    }

    @Test
    @DisplayName("Anthropic 在快照边界绑定的是全文摘要，不是锚点摘要")
    void bindsFullHashNotAnchor() {
        AssistantMessage m = bound(ANCHOR);

        MessageProtocolState state = m.getProtocolState(AnthropicMessageStateSupport.PROTOCOL_ID);
        assertNotNull(state);
        assertEquals(MessageSemanticHasher.hash(m), state.getSemanticHash(),
                "anthropic.messages 必须绑定全文摘要");
        assertEquals(MessageSemanticHasher.hashFor(AnthropicMessageStateSupport.PROTOCOL_ID, m),
                state.getSemanticHash(), "hashFor 对该协议必须解析为全文口径");
    }

    @Test
    @DisplayName("toolCall 身份变化同样判废（全文摘要覆盖范围包含 toolCalls）")
    void toolCallChangeAlsoVoids() {
        AssistantMessage original = bound(ANCHOR);

        List<ToolCall> changed = new ArrayList<>();
        changed.add(new ToolCall("0", "call_OTHER", "read", "{}", new LinkedHashMap<>()));
        AssistantMessage drifted = AssistantMessage.snapshot("正文", ANCHOR, changed,
                null, null, null, Collections.singletonMap(
                        AnthropicMessageStateSupport.PROTOCOL_ID,
                        original.getProtocolState(AnthropicMessageStateSupport.PROTOCOL_ID)),
                null);

        assertNull(AnthropicMessageStateSupport.resolveData(drifted));
    }
}
