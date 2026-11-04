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
package com.gourdai.ai.chat.message;

import com.gourdai.agent.util.AgentUtil;
import com.gourdai.ai.chat.tool.ToolCall;
import com.gourdai.ai.llm.dialect.gemini.GeminiMessageStateSupport;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 语义摘要「按协议分域」契约测试。
 *
 * <p><b>为何要分域</b>：4.1 对所有协议统一用全文摘要（覆盖 text / thinking / blocks / toolCalls），
 * 于是上层任何一次明文归一化都会使协议状态陈旧 → {@code resolveData} fail-closed →
 * <b>整包判废</b>。对只存凭证的协议这是纯粹的误伤（凭证指向服务端对象，与本地明文无关）；
 * 但对 Anthropic 是<b>必要的保护</b>（{@code signature} 只对逐字相同的 thinking 有效）。</p>
 *
 * <p>4.1.1 因此分域：凭证型协议（openai.responses / google.*）用<b>身份锚点摘要</b>，
 * 只覆盖 toolCalls 的 index / id / name；存有逐字内容副本的协议（anthropic.messages）保留全文摘要。</p>
 *
 * @author gourdai
 * @since 4.1.1
 */
public class MessageSemanticHasherScopeTest {

    private static final String ANCHOR = "让我先读取任务清单，确认当前进度。";

    private static List<ToolCall> toolCalls(String id, String name) {
        List<ToolCall> calls = new ArrayList<>();
        calls.add(new ToolCall("0", id, name, "{}", new LinkedHashMap<>()));
        return calls;
    }

    // ---------------------------------------------------------------- 摘要口径本身

    @Test
    @DisplayName("锚点摘要对 text / thinking 归一化免疫")
    void anchorHashImmuneToTextAndThinkingNormalization() {
        AssistantMessage a = AssistantMessage.snapshot("正文A", ANCHOR + ANCHOR,
                toolCalls("call_1", "read"), null, null, null, null);
        AssistantMessage b = AssistantMessage.snapshot("正文B", ANCHOR,
                toolCalls("call_1", "read"), null, null, null, null);

        assertEquals(MessageSemanticHasher.anchorHash(a), MessageSemanticHasher.anchorHash(b),
                "锚点只覆盖 toolCall 身份，明文改写不得使其变化");
    }

    @Test
    @DisplayName("锚点摘要对 toolCall 身份变化敏感（守住 function_call 配对约束）")
    void anchorHashSensitiveToToolCallIdentity() {
        AssistantMessage a = AssistantMessage.snapshot("正文", ANCHOR,
                toolCalls("call_1", "read"), null, null, null, null);
        AssistantMessage changedId = AssistantMessage.snapshot("正文", ANCHOR,
                toolCalls("call_2", "read"), null, null, null, null);
        AssistantMessage changedName = AssistantMessage.snapshot("正文", ANCHOR,
                toolCalls("call_1", "write"), null, null, null, null);

        assertNotEquals(MessageSemanticHasher.anchorHash(a),
                MessageSemanticHasher.anchorHash(changedId), "call_id 变化必须被锚点捕获");
        assertNotEquals(MessageSemanticHasher.anchorHash(a),
                MessageSemanticHasher.anchorHash(changedName), "工具名变化必须被锚点捕获");
    }

    @Test
    @DisplayName("锚点摘要不含 arguments：工具入参改写不应使凭证失效")
    void anchorHashIgnoresArguments() {
        List<ToolCall> a = new ArrayList<>();
        a.add(new ToolCall("0", "call_1", "bash", "{\"command\":\"ls\"}", new LinkedHashMap<>()));
        List<ToolCall> b = new ArrayList<>();
        b.add(new ToolCall("0", "call_1", "bash", "{\"command\":\"pwd\"}", new LinkedHashMap<>()));

        AssistantMessage ma = AssistantMessage.snapshot("正文", "", a, null, null, null, null);
        AssistantMessage mb = AssistantMessage.snapshot("正文", "", b, null, null, null, null);

        assertEquals(MessageSemanticHasher.anchorHash(ma), MessageSemanticHasher.anchorHash(mb),
                "arguments 从语义字段补水，其改写不影响骨架身份，故不得参与锚点");
    }

    @Test
    @DisplayName("全文摘要仍对 thinking 敏感（Anthropic 保护性判废的依据）")
    void fullHashStillSensitiveToThinking() {
        AssistantMessage a = AssistantMessage.snapshot("正文", ANCHOR + ANCHOR,
                toolCalls("call_1", "read"), null, null, null, null);
        AssistantMessage b = AssistantMessage.snapshot("正文", ANCHOR,
                toolCalls("call_1", "read"), null, null, null, null);

        assertNotEquals(MessageSemanticHasher.hash(a), MessageSemanticHasher.hash(b),
                "全文摘要必须继续覆盖 thinking，否则 Anthropic 会下发无效签名");
    }

    @Test
    @DisplayName("两种摘要值域不重叠：不得把全文摘要当锚点校验通过")
    void hashDomainsDoNotOverlap() {
        AssistantMessage m = AssistantMessage.snapshot("正文", ANCHOR,
                toolCalls("call_1", "read"), null, null, null, null);

        assertNotEquals(MessageSemanticHasher.hash(m), MessageSemanticHasher.anchorHash(m),
                "同一消息的两种摘要必须不同，避免口径混用被误判为匹配");
    }

    @Test
    @DisplayName("按协议选取口径：Responses 走纯身份锚点，Gemini 锚点含 args，anthropic 走全文")
    void hashForDispatchesByProtocol() {
        AssistantMessage m = AssistantMessage.snapshot("正文", ANCHOR,
                toolCalls("call_1", "read"), null, null, null, null);

        assertEquals(MessageSemanticHasher.anchorHash(m),
                MessageSemanticHasher.hashFor("openai.responses", m));
        // Gemini 的 thoughtSignature 签的是整个 part（含 args），故锚点必须多一个维度；
        // 与 Responses 不同质，不可一刀切。
        assertEquals(MessageSemanticHasher.anchorHash(m, true),
                MessageSemanticHasher.hashFor(GeminiMessageStateSupport.GENERATE_CONTENT_PROTOCOL_ID, m));
        assertEquals(MessageSemanticHasher.anchorHash(m, true),
                MessageSemanticHasher.hashFor(GeminiMessageStateSupport.INTERACTIONS_PROTOCOL_ID, m));
        assertNotEquals(MessageSemanticHasher.hashFor("openai.responses", m),
                MessageSemanticHasher.hashFor(GeminiMessageStateSupport.GENERATE_CONTENT_PROTOCOL_ID, m),
                "两类锚点口径不得碰撞，否则 args 改写会在 Gemini 侧被漏判");
        assertEquals(MessageSemanticHasher.hash(m),
                MessageSemanticHasher.hashFor("anthropic.messages", m));
        assertEquals(MessageSemanticHasher.hash(m),
                MessageSemanticHasher.hashFor("unknown.protocol", m),
                "未登记的协议保守走全文口径");
        assertEquals(MessageSemanticHasher.hash(m),
                MessageSemanticHasher.hashFor(null, m));
    }

    @Test
    @DisplayName("协议 id 常量守护：分域靠字符串匹配，改名会静默退化为全文口径")
    void protocolIdConstantsStayInSyncWithAnchorScope() {
        // 分域表用的是字面量（message 包在底层，反向 import 方言会造成包级循环），
        // 常量若被改名，分域会静默失效且所有既有用例仍绿——故在此逐字锁定。
        assertEquals("google.generate-content",
                GeminiMessageStateSupport.GENERATE_CONTENT_PROTOCOL_ID);
        assertEquals("google.interactions",
                GeminiMessageStateSupport.INTERACTIONS_PROTOCOL_ID);

        AssistantMessage m = AssistantMessage.snapshot("正文", ANCHOR,
                toolCalls("call_1", "read"), null, null, null, null);
        // 常量值必须真的命中锚点分域（而非退化到全文）
        assertNotEquals(MessageSemanticHasher.hash(m),
                MessageSemanticHasher.hashFor(GeminiMessageStateSupport.GENERATE_CONTENT_PROTOCOL_ID, m));
        assertNotEquals(MessageSemanticHasher.hash(m),
                MessageSemanticHasher.hashFor(GeminiMessageStateSupport.INTERACTIONS_PROTOCOL_ID, m));
    }

    // ---------------------------------------------------------------- 端到端：归一化后的存活对照

    @Test
    @DisplayName("Gemini：思考归一化后 thoughtSignature 必须存活（此前会被误判废）")
    void geminiSignatureSurvivesThinkingNormalization() {
        ToolCall call = new ToolCall("0", "call_1", "read", "{}", new LinkedHashMap<>());
        String protocol = GeminiMessageStateSupport.GENERATE_CONTENT_PROTOCOL_ID;
        MessageProtocolState state =
                GeminiMessageStateSupport.createSignatureState(call, 0, "Ct0BCkQ-signature");
        assertNotNull(state, "前提：签名状态已创建");

        AssistantMessage before = AssistantMessage.snapshot("正文", ANCHOR + ANCHOR,
                new ArrayList<>(Collections.singletonList(call)), null, null, null,
                Collections.singletonMap(protocol, state));
        assertEquals("Ct0BCkQ-signature",
                GeminiMessageStateSupport.resolveSignature(before, protocol, call, 0),
                "前提：归一化前签名可解析");

        AssistantMessage deduped = AgentUtil.dedupeAggregatedThinking(before, ANCHOR);
        assertEquals(ANCHOR, deduped.getThinking(), "前提：思考确已被折叠");

        assertEquals("Ct0BCkQ-signature",
                GeminiMessageStateSupport.resolveSignature(deduped, protocol, call, 0),
                "思考归一化不得使 thoughtSignature 失效：签名只绑定 toolCall 身份");
    }

    @Test
    @DisplayName("Gemini：toolCall 身份变化时签名必须失效（锚点仍在守真正的约束）")
    void geminiSignatureVoidedWhenToolCallIdentityChanges() {
        ToolCall call = new ToolCall("0", "call_1", "read", "{}", new LinkedHashMap<>());
        String protocol = GeminiMessageStateSupport.GENERATE_CONTENT_PROTOCOL_ID;
        MessageProtocolState state =
                GeminiMessageStateSupport.createSignatureState(call, 0, "Ct0BCkQ-signature");

        AssistantMessage bound = AssistantMessage.snapshot("正文", "",
                new ArrayList<>(Collections.singletonList(call)), null, null, null,
                Collections.singletonMap(protocol, state));

        ToolCall other = new ToolCall("0", "call_OTHER", "read", "{}", new LinkedHashMap<>());
        AssistantMessage drifted = AssistantMessage.snapshot("正文", "",
                new ArrayList<>(Collections.singletonList(other)), null, null, null,
                Collections.singletonMap(protocol, bound.getProtocolState(protocol)));

        assertNull(GeminiMessageStateSupport.resolveSignature(drifted, protocol, other, 0),
                "call_id 漂移后签名不得被套用");
    }

    @Test
    @DisplayName("快照边界按协议绑定正确口径")
    void snapshotBindsProtocolScopedHash() {
        ToolCall call = new ToolCall("0", "call_1", "read", "{}", new LinkedHashMap<>());
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("thoughtSignatures", Collections.singletonMap("id:call_1", "sig"));

        AssistantMessage m = AssistantMessage.snapshot("正文", ANCHOR,
                new ArrayList<>(Collections.singletonList(call)), null, null, null,
                Collections.singletonMap(GeminiMessageStateSupport.GENERATE_CONTENT_PROTOCOL_ID,
                        new MessageProtocolState(GeminiMessageStateSupport.VERSION, data)));

        MessageProtocolState bound =
                m.getProtocolState(GeminiMessageStateSupport.GENERATE_CONTENT_PROTOCOL_ID);
        assertNotNull(bound);
        assertEquals(MessageSemanticHasher.anchorHash(m, true), bound.getSemanticHash(),
                "Gemini 在快照边界必须绑定「含 args 的锚点摘要」");
        assertTrue(MessageSemanticHasher.matchesFor(
                        GeminiMessageStateSupport.GENERATE_CONTENT_PROTOCOL_ID, m, bound),
                "绑定后必须能自校验通过");
    }
}
