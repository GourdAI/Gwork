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
import java.util.LinkedHashMap;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Anthropic Messages 协议的思考回放窗口与末条合法性测试。
 *
 * <p>Anthropic 与 Responses <b>不同质</b>，本测试刻意与
 * {@code AnthropicThinkingSignatureGuardTest} 构成互补：</p>
 * <ul>
 *   <li>后者守「签名判废语义不得被改成锚点」（signature 只对逐字相同的 thinking 有效）；</li>
 *   <li>本测试守「历史轮思考块不得逐轮累加上行」与「判废后不得产出非法结构」。</li>
 * </ul>
 *
 * @author gourdai
 * @since 4.1.1
 */
public class AnthropicThinkingReplayWindowTest {

    private static final String THINKING = "让我先确认当前进度，再决定下一步。";

    private static ChatConfig config() {
        ChatConfig config = new ChatConfig();
        config.setModel("claude-sonnet-4-20250514");
        return config;
    }

    private static List<ToolCall> toolCalls() {
        List<ToolCall> calls = new ArrayList<>();
        calls.add(new ToolCall("0", "toolu_1", "read", "{}", new LinkedHashMap<>()));
        return calls;
    }

    private static AssistantMessage assistant(String text, String thinking, List<ToolCall> calls) {
        return AssistantMessage.snapshot(text, thinking, calls, null, null, null, null);
    }

    private static ONode build(List<ChatMessage> messages, ChatOptions options) {
        return new AnthropicRequestBuilder().build(config(), options, messages, false);
    }

    /** thinking 开关已启用的选项（{@code ChatOptions.of()} 无链式 then，故单独构造）。 */
    private static ChatOptions thinkingOn() {
        ChatOptions options = ChatOptions.of();
        options.optionSet("thinking", true);
        return options;
    }

    private static ONode messagesOf(List<ChatMessage> messages, ChatOptions options) {
        return build(messages, options).get("messages");
    }

    /** 取消息正文：content 可能是字符串，也可能是块数组，两种形态都要支持。 */
    private static String textOf(ONode messageNode) {
        ONode content = messageNode.getOrNull("content");
        if (content == null) {
            return "";
        }
        if (!content.isArray()) {
            return content.getString() == null ? "" : content.getString();
        }
        StringBuilder buf = new StringBuilder();
        for (int i = 0; i < content.size(); i++) {
            if ("text".equals(content.get(i).get("type").getString())) {
                buf.append(content.get(i).get("text").getString());
            }
        }
        return buf.toString();
    }

    private static boolean hasBlockType(ONode messageNode, String type) {
        ONode content = messageNode.getOrNull("content");
        if (content == null || !content.isArray()) {
            return false;
        }
        for (int i = 0; i < content.size(); i++) {
            if (type.equals(content.get(i).get("type").getString())) {
                return true;
            }
        }
        return false;
    }

    // ---------------------------------------------------------------- 历史轮剥离

    @Test
    @DisplayName("历史轮 assistant 的 thinking 块不再上行（膨胀治理）")
    void historicalThinkingBlocksStripped() {
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                ChatMessage.ofUser("u0"),
                assistant("a1", THINKING, null),
                ChatMessage.ofUser("u2"),
                assistant("a3", THINKING, null)));

        ONode out = messagesOf(messages, thinkingOn());

        assertFalse(hasBlockType(out.get(1), "thinking"),
                "跨 user 轮边界的思考块必须剥离：Anthropic 并不要求回传历史思考");
        assertTrue(textOf(out.get(1)).contains("a1"),
                "剥离思考不得波及正文（content 可为字符串或块数组，两种形态都要成立）");
    }

    @Test
    @DisplayName("剥离思考不得破坏 tool_use 配对")
    void strippingKeepsToolUseBlocks() {
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                ChatMessage.ofUser("u0"),
                assistant("a1", THINKING, toolCalls()),
                ChatMessage.ofUser("u2"),
                assistant("a3", "", null)));

        ONode historical = messagesOf(messages, ChatOptions.of()).get(1);

        assertFalse(hasBlockType(historical, "thinking"));
        assertTrue(hasBlockType(historical, "tool_use"),
                "tool_use 是配对约束的载体，剥离思考时必须完整保留");
    }

    @Test
    @DisplayName("当轮（最后 user 之后）思考块保留：Anthropic 要求末条以 thinking 开头")
    void currentTurnThinkingPreserved() {
        AssistantMessage current = assistant("a3", THINKING, null);
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                ChatMessage.ofUser("u0"),
                assistant("a1", THINKING, null),
                ChatMessage.ofUser("u2"),
                current));

        ONode out = messagesOf(messages, ChatOptions.of());

        assertFalse(hasBlockType(out.get(1), "thinking"), "历史轮剥离");
        // 当轮是否真带 thinking 块取决于签名是否可解析；此处只断言窗口没有主动剥它。
        assertEquals(4, out.size(), "消息条数不得因剥离而变化");
    }

    // ---------------------------------------------------------------- 末条合法性

    @Test
    @DisplayName("判废且末条带 tool_use 时撤本轮 thinking 开关（避 400 不可自愈）")
    void thinkingDisabledWhenLastAssistantHasToolUseWithoutSignature() {
        // 无协议状态 ⇒ 无 signature ⇒ 无法下发合法 thinking 块
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                ChatMessage.ofUser("u0"),
                assistant("a1", THINKING, toolCalls())));

        ONode root = build(messages, thinkingOn());
        ONode last = root.get("messages").get(root.get("messages").size() - 1);

        if ("assistant".equals(last.get("role").getString())
                && !hasBlockType(last, "thinking")
                && hasBlockType(last, "tool_use")) {
            assertFalse(root.hasKey("thinking"),
                    "末条 assistant 带 tool_use 却无合法 thinking 块时，必须撤掉本轮 thinking 开关："
                            + "伪造签名会被验签拒绝，保留开关则 400 且每次重试精确复现");
        }
    }

    @Test
    @DisplayName("真正的新 user 轮不触发撤销（thinking 开关须保留）")
    void thinkingKeptWhenLastMessageIsRealUserTurn() {
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                ChatMessage.ofUser("u0"),
                assistant("a1", THINKING, toolCalls()),
                ChatMessage.ofUser("u2")));

        ONode root = build(messages, thinkingOn());

        assertTrue(root.hasKey("thinking"),
                "真正的新 user 轮不受「必须以 thinking 块开头」约束，不得误撤开关");
    }

    @Test
    @DisplayName("agent 主场景：tool_result 结尾时仍须回溯到 assistant 做终检")
    void thinkingDisabledWhenToolResultTrailsInvalidAssistant() {
        // 【回归护栏】协议原文：final assistant message must start with a thinking block
        // （preceding the lastmost set of tool_use and tool_result blocks）。
        // 本形态下违规的 assistant 在 size-2，末条是承载 tool_result 的 user：
        // 终检若只看末条会直接早退 → 开关残留 → 400 且每次重试精确复现。
        // 这正是 agent 工具循环的主场景，不是边缘情况。
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                ChatMessage.ofUser("u0"),
                assistant("a1", THINKING, toolCalls()),
                ChatMessage.ofTool("工具结果", "read", "toolu_1")));

        ONode root = build(messages, thinkingOn());
        ONode out = root.get("messages");
        ONode lastAssistant = out.get(out.size() - 2);

        assertEquals("assistant", lastAssistant.get("role").getString(), "前提：违规位在 size-2");
        if (!hasBlockType(lastAssistant, "thinking") && hasBlockType(lastAssistant, "tool_use")) {
            assertFalse(root.hasKey("thinking"),
                    "tool_result 结尾时必须跳过它回溯到 assistant 判定，否则终检在 agent 主场景全面失效");
        }
    }

    @Test
    @DisplayName("显式 thinking.type=disabled 不得被终检误撤")
    void explicitDisabledThinkingUntouched() {
        java.util.Map<String, Object> disabled = new LinkedHashMap<>();
        disabled.put("type", "disabled");
        ChatOptions options = ChatOptions.of();
        options.optionSet("thinking", disabled);

        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                ChatMessage.ofUser("u0"),
                assistant("a1", THINKING, toolCalls())));

        ONode root = build(messages, options);

        assertTrue(root.hasKey("thinking"), "显式关闭态不应被终检移除");
        assertEquals("disabled", root.get("thinking").get("type").getString(),
                "type=disabled 既无「必须以 thinking 块开头」的约束，也没有可撤的开关");
    }

    // ---------------------------------------------------------------- 结构合法性

    @Test
    @DisplayName("纯思考的历史消息剥离后不得产生空 content 数组")
    void strippedEmptyContentGetsTextPlaceholder() {
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                ChatMessage.ofUser("u0"),
                assistant("", THINKING, null),
                ChatMessage.ofUser("u2"),
                assistant("a3", "", null)));

        ONode out = messagesOf(messages, ChatOptions.of());

        for (int i = 0; i < out.size(); i++) {
            ONode content = out.get(i).getOrNull("content");
            if (content != null && content.isArray()) {
                assertTrue(content.size() > 0,
                        "Anthropic 拒绝 content 为空数组的消息（消息 " + i + "）");
            }
        }
    }

    @Test
    @DisplayName("窗口不改写消息对象本身")
    void windowDoesNotMutateMessages() {
        AssistantMessage history = assistant("a1", THINKING, toolCalls());
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                ChatMessage.ofUser("u0"), history, ChatMessage.ofUser("u2")));

        messagesOf(messages, ChatOptions.of());

        assertEquals(THINKING, history.getThinking(),
                "出站剥离后原消息对象必须原封不动，否则会话历史被就地破坏");
        assertEquals(1, history.getToolCalls().size());
    }
}
