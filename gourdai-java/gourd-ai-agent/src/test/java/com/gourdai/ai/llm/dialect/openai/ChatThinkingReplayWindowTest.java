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

import com.gourdai.ai.chat.ChatConfig;
import com.gourdai.ai.chat.ChatOptions;
import com.gourdai.ai.chat.message.AssistantMessage;
import com.gourdai.ai.chat.message.ChatMessage;
import com.gourdai.ai.chat.tool.ToolCall;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * openai-chat 协议的思考回放窗口行为测试（上下文膨胀治理）。
 *
 * <p>该协议不读 protocolStates，因此不受「存两份」判废链影响，但它
 * <b>每轮遍历全量历史重建请求体</b>：DeepSeek 端点写 {@code reasoning_content}、
 * OpenRouter 写 {@code reasoning}，历史各轮思考明文因此逐轮累加上行
 * ——与 Responses 的膨胀同源，换协议并不能规避。</p>
 *
 * <p><b>剥离不能一刀切</b>：DeepSeek thinking 模式下带 {@code tool_calls} 的 assistant
 * 若缺 {@code reasoning_content}，服务端直接 400 且每次重试精确复现（会话死锁）。
 * 故历史轮采用<b>空串占位</b>——既不上行明文，又满足字段必填。</p>
 *
 * @author gourdai
 * @since 4.1.1
 */
public class ChatThinkingReplayWindowTest {

    private static final String LONG_THINKING = "让我先读取任务清单，确认当前进度。";

    private static ChatConfig deepseekConfig() {
        ChatConfig config = new ChatConfig();
        config.setModel("deepseek-chat");
        return config;
    }

    private static List<ToolCall> toolCalls() {
        List<ToolCall> calls = new ArrayList<>();
        calls.add(new ToolCall("0", "call_1", "read", "{}", new LinkedHashMap<>()));
        return calls;
    }

    private static AssistantMessage assistant(String text, String thinking, List<ToolCall> calls) {
        return AssistantMessage.snapshot(text, thinking, calls, null, null, null, null);
    }

    private static ONode messagesOf(ChatConfig config, List<ChatMessage> messages) {
        return OpenaiChatDialect.getInstance()
                .buildRequestJson(config, ChatOptions.of(), messages, false)
                .get("messages");
    }

    // ---------------------------------------------------------------- 历史轮剥离

    @Test
    @DisplayName("DeepSeek：跨 user 轮的历史思考明文不再上行（膨胀根治）")
    void historicalThinkingIsStrippedForDeepseek() {
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                ChatMessage.ofUser("u0"),
                assistant("a1", LONG_THINKING, null),
                ChatMessage.ofUser("u2")));

        ONode out = messagesOf(deepseekConfig(), messages);
        ONode historical = out.get(1);

        assertEquals("assistant", historical.get("role").getString());
        assertFalse(historical.hasKey("reasoning_content"),
                "历史轮思考明文必须剥离：逐轮累加即上下文膨胀");
        assertEquals("a1", historical.get("content").getString(), "剥离思考不得波及正文");
    }

    @Test
    @DisplayName("DeepSeek：带 tool_calls 的历史轮降为空串占位（避 400 死锁，非直接删字段）")
    void historicalToolCallMessageKeepsEmptyPlaceholder() {
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                ChatMessage.ofUser("u0"),
                assistant("a1", LONG_THINKING, toolCalls()),
                ChatMessage.ofUser("u2")));

        ONode historical = messagesOf(deepseekConfig(), messages).get(1);

        assertTrue(historical.hasKey("reasoning_content"),
                "DeepSeek thinking 模式要求带 tool_calls 的 assistant 必须有该字段，删掉会 400 且重试永不自愈");
        assertEquals("", historical.get("reasoning_content").getString(),
                "字段保留但降为空串：满足必填的同时不上行明文");
        assertEquals(1, historical.get("tool_calls").size(), "剥离思考不得波及 tool_calls 配对");
    }

    // ---------------------------------------------------------------- 当轮保留

    @Test
    @DisplayName("DeepSeek：当轮（最后 user 之后）思考必须原样保留")
    void currentTurnThinkingIsPreserved() {
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                ChatMessage.ofUser("u0"),
                assistant("a1", "历史轮思考", null),
                ChatMessage.ofUser("u2"),
                assistant("a3", LONG_THINKING, toolCalls())));

        ONode out = messagesOf(deepseekConfig(), messages);

        assertFalse(out.get(1).hasKey("reasoning_content"), "历史轮剥离");
        assertEquals(LONG_THINKING, out.get(3).get("reasoning_content").getString(),
                "当轮工具循环的思考是 DeepSeek 的硬要求，必须原样回放");
    }

    // ---------------------------------------------------------------- 非思考端点不受影响

    @Test
    @DisplayName("普通 OpenAI 端点：本就不写思考字段，窗口不得引入任何新字段")
    void plainOpenaiEndpointUnaffected() {
        ChatConfig config = new ChatConfig();
        config.setModel("gpt-4o");

        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                ChatMessage.ofUser("u0"),
                assistant("a1", LONG_THINKING, toolCalls()),
                ChatMessage.ofUser("u2")));

        ONode historical = messagesOf(config, messages).get(1);

        assertFalse(historical.hasKey("reasoning_content"));
        assertFalse(historical.hasKey("reasoning"),
                "非思考端点不得被窗口逻辑意外写入占位字段");
        assertEquals("a1", historical.get("content").getString());
    }

    // ---------------------------------------------------------------- 与压缩器的口径相容

    @Test
    @DisplayName("压缩口径相容：getContent() 不含 thinking，故窗口只会让实际字节向估算收敛")
    void compressionEstimateScopeExcludesThinking() {
        AssistantMessage m = assistant("正文", LONG_THINKING + LONG_THINKING, null);

        // ContextCompressionInterceptor.estimateTokens 经由 ChatMessage.getContent() 估算。
        // 若 getContent() 含 thinking，窗口剥离后实际出站远小于估算，压缩判据将系统性失真。
        assertEquals("正文", m.getContent(),
                "AssistantMessage.getContent() 必须等于 getText()：压缩估算口径里本就没有思考明文");
        assertFalse(m.getContent().contains(LONG_THINKING),
                "思考明文不得进入压缩估算口径");
        assertEquals(LONG_THINKING + LONG_THINKING, m.getThinking(),
                "语义字段本身不受窗口影响：窗口只作用于出站序列化，不改 WorkingMemory");
    }

    @Test
    @DisplayName("窗口不改写消息对象本身（不使压缩器 per-message 缓存失效）")
    void windowDoesNotMutateMessageObjects() {
        AssistantMessage history = assistant("a1", LONG_THINKING, toolCalls());
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                ChatMessage.ofUser("u0"), history, ChatMessage.ofUser("u2")));

        messagesOf(deepseekConfig(), messages);

        assertEquals(LONG_THINKING, history.getThinking(),
                "出站剥离后原消息对象的 thinking 必须原封不动，否则会话历史被就地破坏");
        assertEquals(1, history.getToolCalls().size());
        // 二次构建必须得到同样结果（无累积副作用）
        ONode again = messagesOf(deepseekConfig(), messages).get(1);
        assertEquals("", again.get("reasoning_content").getString());
    }

    // ---------------------------------------------------------------- 膨胀量化

    @Test
    @DisplayName("量化：多轮历史下出站字节随轮数不再线性累加思考明文")
    void outboundBytesDoNotAccumulateThinking() {
        String bigThinking = repeat(LONG_THINKING, 50);

        List<ChatMessage> shortHistory = new ArrayList<>(Arrays.asList(
                ChatMessage.ofUser("u0"),
                assistant("a1", bigThinking, null),
                ChatMessage.ofUser("u2"),
                assistant("a3", bigThinking, null)));

        List<ChatMessage> longHistory = new ArrayList<>(Arrays.asList(
                ChatMessage.ofUser("u0"),
                assistant("a1", bigThinking, null),
                ChatMessage.ofUser("u2"),
                assistant("a3", bigThinking, null),
                ChatMessage.ofUser("u4"),
                assistant("a5", bigThinking, null),
                ChatMessage.ofUser("u6"),
                assistant("a7", bigThinking, null)));

        int shortLen = messagesOf(deepseekConfig(), shortHistory).toJson().length();
        int longLen = messagesOf(deepseekConfig(), longHistory).toJson().length();

        // 两者都只保留「末条」一份思考；增量只应来自新增的正文与结构，远小于一份思考明文。
        int delta = longLen - shortLen;
        assertTrue(delta < bigThinking.length(),
                "历史增加 2 轮带思考的 assistant，增量(" + delta + ") 必须远小于单份思考("
                        + bigThinking.length() + ")；否则说明思考仍在逐轮累加");
    }

    private static String repeat(String s, int times) {
        StringBuilder buf = new StringBuilder(s.length() * times);
        for (int i = 0; i < times; i++) {
            buf.append(s);
        }
        return buf.toString();
    }

    @Test
    @DisplayName("纯思考消息在 DeepSeek 端点仍被保留（可重建为合法字段，不得误跳过）")
    void thinkingOnlyMessageStillWrittenWhenFieldRebuildable() {
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                ChatMessage.ofUser("u0"),
                assistant("", LONG_THINKING, null)));

        ONode out = messagesOf(deepseekConfig(), messages);

        assertEquals(2, out.size(), "末条在窗口内，思考可重建为 reasoning_content，不应被跳过");
        assertEquals(LONG_THINKING, out.get(1).get("reasoning_content").getString());
    }

    @Test
    @DisplayName("无 user 消息时保守保留（无轮边界，误剥会触发 DeepSeek 400）")
    void noUserMessageKeepsThinking() {
        List<ChatMessage> messages = new ArrayList<>(
                Collections.singletonList(assistant("a", LONG_THINKING, toolCalls())));

        ONode out = messagesOf(deepseekConfig(), messages);

        assertEquals(LONG_THINKING, out.get(0).get("reasoning_content").getString());
    }
}
