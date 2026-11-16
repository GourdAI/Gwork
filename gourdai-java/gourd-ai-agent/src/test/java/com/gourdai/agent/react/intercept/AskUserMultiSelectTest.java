/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.agent.react.intercept;

import com.gourdai.agent.session.InMemoryAgentSession;
import com.gourdai.agent.util.AskUserTool;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 多选答案回填与挂起查询的行为测试（契约 §5.1 / §3.4）。
 *
 * <p>多选协议：questions[] 增可选 multiSelect；answers[] 元素可含 texts 数组，
 * 回填为「Q{n}: label1、label2」。向后兼容：单选（text 字符串）与旧版答案
 * 行为逐字不变；text 为「label1、label2」的旧前端形态与单选不可区分，
 * 原样回填即天然兼容（顿号连接串已是契约要求的展示形态）。</p>
 */
class AskUserMultiSelectTest {

    private static List<Map<String, Object>> questions(String... headers) {
        java.util.List<Map<String, Object>> list = new java.util.ArrayList<>();
        for (String header : headers) {
            list.add(Map.of("header", header));
        }
        return list;
    }

    // ── formatAnswerText：多选回填 ─────────────────────────────

    @Test
    @DisplayName("多选：texts 数组按「Q{n}: label1、label2」回填（顿号连接）")
    void multiSelectTextsJoinWithIdeographicComma() {
        String answers = "{\"answers\":[{\"index\":0,\"texts\":[\"搜索\",\"记忆\"]}]}";

        String text = AskUser.formatAnswerText(questions("选哪些能力"), answers);

        assertTrue(text.contains("Q1: 搜索、记忆"), "多选必须按契约形态回填：\n" + text);
        assertFalse(text.contains("（用户自定义"), "勾选候选项不得加自定义标记");
    }

    @Test
    @DisplayName("多选与单选混排：各题按各自协议回填，题号连续")
    void mixedSingleAndMultiSelect() {
        String answers = "{\"answers\":["
                + "{\"index\":0,\"text\":\"先做最小版\"},"
                + "{\"index\":1,\"texts\":[\"搜索\",\"记忆\",\"导出\"]}]}";

        String text = AskUser.formatAnswerText(questions("目标", "选哪些能力"), answers);

        assertTrue(text.contains("1. 目标") && text.contains("先做最小版"), "单选题保持原格式：\n" + text);
        assertTrue(text.contains("2. 选哪些能力"), "多选题题面保持编号格式：\n" + text);
        assertTrue(text.contains("Q2: 搜索、记忆、导出"), "多选题答案按 Q{n} 形态回填：\n" + text);
    }

    @Test
    @DisplayName("向后兼容：单选 text 字符串行为逐字不变（含跳过/自定义标记）")
    void singleSelectBackwardCompatible() {
        String answers = "{\"answers\":["
                + "{\"index\":0,\"text\":\"方案A\"},"
                + "{\"index\":1,\"text\":\"手写答案\",\"custom\":true}]}";

        String text = AskUser.formatAnswerText(questions("目标", "取舍"), answers);

        assertTrue(text.contains("→ 方案A"), "单选答案原样回填：\n" + text);
        assertTrue(text.contains("（用户自定义回答）手写答案"), "自定义标记保持既有行为：\n" + text);
        assertFalse(text.contains("Q1:"), "单选不得走多选形态");
    }

    @Test
    @DisplayName("旧前端形态：text 为顿号连接串时原样回填（与单选不可区分，天然兼容）")
    void legacyJoinedTextPassesThrough() {
        String answers = "{\"answers\":[{\"index\":0,\"text\":\"搜索、记忆\"}]}";

        String text = AskUser.formatAnswerText(questions("选哪些能力"), answers);

        assertTrue(text.contains("→ 搜索、记忆"), "顿号连接串原样回填即契约展示形态：\n" + text);
    }

    @Test
    @DisplayName("texts 空白项跳过；全空白回退 text 通道；skipped 优先")
    void textsEdgeCases() {
        String answers = "{\"answers\":["
                + "{\"index\":0,\"texts\":[\"搜索\",\"\",\"  \",\"记忆\"]},"
                + "{\"index\":1,\"texts\":[\"  \"],\"text\":\"兜底文本\"},"
                + "{\"index\":2,\"texts\":[\"搜索\"],\"skipped\":true}]}";

        String text = AskUser.formatAnswerText(questions("A", "B", "C"), answers);

        assertTrue(text.contains("Q1: 搜索、记忆"), "空白项不得产生空段：\n" + text);
        assertTrue(text.contains("兜底文本"), "全空白 texts 回退 text 通道：\n" + text);
        assertTrue(text.contains("（用户跳过）"), "skipped 优先于 texts：\n" + text);
    }

    @Test
    @DisplayName("题面丢失（questions 为空）：多选答案仍按 Q{n} 裸列，不丢多选语义")
    void multiSelectWithoutQuestions() {
        String answers = "{\"answers\":["
                + "{\"texts\":[\"搜索\",\"记忆\"]},"
                + "{\"text\":\"补充说明\"}]}";

        String text = AskUser.formatAnswerText(null, answers);

        assertTrue(text.contains("Q1: 搜索、记忆"), "题面丢失时多选仍按契约形态：\n" + text);
        assertTrue(text.contains("补充说明"), "单选裸列保持既有行为：\n" + text);
    }

    // ── hasMeaningfulAnswer：texts 也是真实作答 ────────────────

    @Test
    @DisplayName("hasMeaningfulAnswer：仅 texts 作答（无 text）也视为已回答")
    void textsOnlyCountsAsAnswered() {
        String answers = "{\"answers\":[{\"texts\":[\"搜索\",\"记忆\"]}]}";

        assertTrue(AskUser.hasMeaningfulAnswer(answers),
                "多选作答不得被误判为「全部跳过」而丢弃");
    }

    @Test
    @DisplayName("hasMeaningfulAnswer：全部跳过仍视为未回答（既有语义不变）")
    void allSkippedStillUnanswered() {
        assertFalse(AskUser.hasMeaningfulAnswer("{\"answers\":[{\"skipped\":true}]}"));
        assertFalse(AskUser.hasMeaningfulAnswer("{\"answers\":[{\"texts\":[\"  \"]}]}"),
                "全空白 texts 不算有效作答");
    }

    // ── isResumable / getPendingTask：pendingQuestion 端点数据源 ──

    @Test
    @DisplayName("isResumable：任务实体 + 会话挂起同时成立才可恢复（僵尸组合拒绝）")
    void resumableRequiresBothTaskAndPending() {
        InMemoryAgentSession session = InMemoryAgentSession.of("resume-test");
        AskUserTask task = new AskUserTask(AskUserTool.TOOL_NAME, questions("目标"), "call-3");

        // 无实体无挂起：不可恢复
        assertFalse(AskUser.isResumable(session));

        // 仅挂起（HITL 形态，无 ask_user 实体）：不可恢复
        session.pending(true, "hitl");
        assertFalse(AskUser.isResumable(session));

        // 实体 + 挂起：可恢复
        session.getContext().put(AskUser.TASK_KEY, task);
        assertTrue(AskUser.isResumable(session));
        AskUserTask loaded = AskUser.getPendingTask(session);
        assertNotNull(loaded);
        assertEquals("call-3", loaded.getActionId());
        assertEquals(1, loaded.getQuestions().size());

        // 僵尸组合：实体残留但会话已不挂起（过期/已消费）：不可恢复
        session.pending(false, null);
        assertFalse(AskUser.isResumable(session), "过期挂起不得被 pendingQuestion 端点返回");
    }
}