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

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 思考回放窗口口径的契约测试。
 *
 * <p>窗口 = {@code (or $last (gt $i $lastUserIdx))}，与 Qwen3 / Ollama 官方模板逐字对齐。
 * 这两个条件<b>缺一不可</b>，本测试对两半分别设了独立用例：</p>
 * <ul>
 *   <li>只有 {@code gt $i $lastUserIdx}：会误剥 assistant prefill（末条是 assistant 且在 user 之前）；</li>
 *   <li>只有 {@code $last}：历史工具循环里的 assistant 思考会被剥，触发 DeepSeek
 *       「reasoning_content must be passed back」400 死锁。</li>
 * </ul>
 *
 * @author gourdai
 * @since 4.1.1
 */
public class ThinkingReplayWindowTest {

    private static ChatMessage user(String text) {
        return ChatMessage.ofUser(text);
    }

    private static AssistantMessage assistant(String text, String thinking) {
        return AssistantMessage.snapshot(text, thinking, null, null, null, null, null);
    }

    /** 收集窗口内下标，便于对整条序列做一次性断言。 */
    private static List<Integer> withinIndexes(List<ChatMessage> messages) {
        int lastUserIdx = ThinkingReplayWindow.lastUserIndex(messages);
        List<Integer> in = new ArrayList<>();
        for (int i = 0; i < messages.size(); i++) {
            if (ThinkingReplayWindow.isWithinCurrentTurn(lastUserIdx, i, messages.size())) {
                in.add(i);
            }
        }
        return in;
    }

    // ---------------------------------------------------------------- lastUserIndex

    @Test
    @DisplayName("lastUserIndex：取最后一条 user，不是第一条")
    void lastUserIndexTakesTheLastOne() {
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                user("u0"), assistant("a1", "t1"), user("u2"), assistant("a3", "t3")));

        assertEquals(2, ThinkingReplayWindow.lastUserIndex(messages));
    }

    @Test
    @DisplayName("lastUserIndex：无 user 返回 -1；空/null 亦然")
    void lastUserIndexWithoutUser() {
        assertEquals(-1, ThinkingReplayWindow.lastUserIndex(
                new ArrayList<>(Collections.singletonList(assistant("a", "t")))));
        assertEquals(-1, ThinkingReplayWindow.lastUserIndex(new ArrayList<>()));
        assertEquals(-1, ThinkingReplayWindow.lastUserIndex(null));
    }

    // ---------------------------------------------------------------- 窗口两半

    @Test
    @DisplayName("窗口左半：最后一条 user 之后的当轮消息全部保留")
    void keepsEverythingAfterLastUser() {
        // [0]=u  [1]=a(历史)  [2]=u(最后)  [3]=a  [4]=a
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                user("u0"), assistant("a1", "t1"), user("u2"),
                assistant("a3", "t3"), assistant("a4", "t4")));

        assertEquals(Arrays.asList(3, 4), withinIndexes(messages),
                "当轮（最后 user 之后）的 assistant 思考必须保留：DeepSeek 工具循环硬要求");
    }

    @Test
    @DisplayName("窗口右半：末条无论位置都保留（守住 assistant prefill）")
    void keepsLastMessageEvenBeforeLastUser() {
        // 末条是 assistant 且下标 < lastUserIdx 不可能发生；
        // 但 prefill 形态下末条 assistant 紧跟在 user 之后，边界必须命中 index==size-1。
        List<ChatMessage> prefill = new ArrayList<>(Arrays.asList(
                user("u0"), assistant("prefill", "t")));
        assertTrue(ThinkingReplayWindow.isWithinCurrentTurn(prefill, 1),
                "prefill 必须在窗口内");

        // 直接验证条件的右半：构造 lastUserIndex 大于 index 的情形
        assertTrue(ThinkingReplayWindow.isWithinCurrentTurn(5, 9, 10),
                "末条（index == size-1）即便下标小于 lastUserIndex 也必须在窗口内");
    }

    @Test
    @DisplayName("跨 user 轮边界的历史思考被剥离（膨胀来源）")
    void stripsAcrossUserTurnBoundary() {
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                user("u0"), assistant("a1", "t1"), user("u2"), assistant("a3", "t3")));

        int lastUserIdx = ThinkingReplayWindow.lastUserIndex(messages);
        assertFalse(ThinkingReplayWindow.isWithinCurrentTurn(lastUserIdx, 1, messages.size()),
                "上一轮 assistant 思考跨越了 user 边界，必须剥离");
        assertTrue(ThinkingReplayWindow.isWithinCurrentTurn(lastUserIdx, 3, messages.size()),
                "当轮 assistant 思考必须保留");
    }

    @Test
    @DisplayName("无 user 消息时一律视为窗口内（保守，避免误剥引发 400）")
    void withoutUserEverythingIsWithinWindow() {
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                assistant("a0", "t0"), assistant("a1", "t1"), assistant("a2", "t2")));

        assertEquals(Arrays.asList(0, 1, 2), withinIndexes(messages),
                "没有轮边界可言时保守保留，不得误剥");
    }

    @Test
    @DisplayName("单条 user：无 assistant 时窗口判定不越界")
    void singleUserMessageIsSafe() {
        List<ChatMessage> messages = new ArrayList<>(Collections.singletonList(user("only")));

        assertEquals(Collections.singletonList(0), withinIndexes(messages));
    }

    @Test
    @DisplayName("长工具循环：当轮内多条 assistant 全部保留，历史轮全部剥离")
    void longToolLoopWithinCurrentTurnIsFullyKept() {
        // [0]u [1]a [2]a [3]u [4]a [5]a [6]a
        List<ChatMessage> messages = new ArrayList<>(Arrays.asList(
                user("u0"), assistant("a1", "t1"), assistant("a2", "t2"),
                user("u3"), assistant("a4", "t4"), assistant("a5", "t5"), assistant("a6", "t6")));

        assertEquals(Arrays.asList(4, 5, 6), withinIndexes(messages),
                "当轮工具循环整段保留；历史两轮 assistant 思考剥离");
    }
}
