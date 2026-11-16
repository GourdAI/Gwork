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
package com.gourdai.agent.react.task;

import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.session.InMemoryAgentSession;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.talents.cli.TodoTalent;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 收敛门禁放行判据（契约 §2.1）的行为测试。
 *
 * <p>背景：旧门禁把「注入过收敛指令后的任何纯文本回复」一律改判继续，
 * 但两类回复其实是完整回答而非意图声明：① 已成规模的长回答（去空白 ≥400 字符）；
 * ② 会话 TODO 清单已全部完成（没有未完成事项可校验）。误改判会让模型
 * 被迫再输出一份总结——正是「N 份雷同总结」的根因之一。</p>
 *
 * <p>保守性：TODO 读取失败/文件不存在/解析不出任务行时不放行（宁可多校验一次，
 * 不能在证据缺失时放行潜在的意图声明误判）；finishMarker 直通语义保持不变。</p>
 */
class ReasonTaskGateReleaseTest {
    @TempDir
    Path temp;

    /** 400 个非空白字符的成规模回答（契约阈值：去空白 ≥400）。 */
    private static String substantialAnswer() {
        return "答".repeat(400);
    }

    private ReActTrace traceWithTodoDir(String sessionId) {
        com.gourdai.agent.AgentSession session = InMemoryAgentSession.of(sessionId);
        // 会话属性 cwd 是 isTodoAllDone 的取值路径之一（toolContext 未注入时的回退）
        session.attrs().put(HarnessEngine.ATTR_CWD, temp.toString());
        // getSession/getOptions 都必须覆写：裸 trace 的 options 为 null，
        // isTodoAllDone 会在 null 守卫处保守返回 false，判据二永远测不到。
        ReActTrace trace = new ReActTrace() {
            @Override
            public com.gourdai.agent.AgentSession getSession() {
                return session;
            }

            @Override
            public com.gourdai.agent.react.ReActOptions getOptions() {
                return new com.gourdai.agent.react.ReActOptions(null);
            }
        };
        return trace;
    }

    private void writeTodo(String sessionId, String content) throws Exception {
        // 必须与 isTodoAllDone 的读取口径同源（AgentFlags.getHarnessSessions 相对目录）：
        // new TodoTalent(null) 会把清单写到 cwd/<sessionId>/TODO.md，而实现读的是
        // cwd/.gwork/sessions/<sessionId>/TODO.md，路径不同源会造成假失败。
        TodoTalent talent = new TodoTalent(com.gourdai.core.config.AgentFlags.getHarnessSessions());
        Path todoFile = talent.getTodoPath(temp.toString(), sessionId);
        Files.createDirectories(todoFile.getParent());
        Files.write(todoFile, content.getBytes(StandardCharsets.UTF_8));
    }

    // ── 判据一：回答规模 ──────────────────────────────────────

    @Test
    @DisplayName("放行判据一：去空白 ≥400 字符的成规模回答不 defer（完整回答而非意图声明）")
    void substantialAnswerReleasesGate() {
        ReActTrace trace = new ReActTrace();
        trace.markConvergePending();

        assertTrue(ReasonTask.shouldDeferImplicitEnd(trace, "取证够了，直接修两个 P0。", "Final Answer"),
                "短意图声明仍须改判（前置条件校验）");
        assertFalse(ReasonTask.shouldDeferImplicitEnd(trace, substantialAnswer(), "Final Answer"),
                "≥400 非空白字符的完整回答必须放行，不得再逼模型重出总结");
    }

    @Test
    @DisplayName("规模判据按去空白计数：399 字符不放行、空白填充不凑数")
    void sizeThresholdCountsNonWhitespaceOnly() {
        ReActTrace trace = new ReActTrace();
        trace.markConvergePending();

        assertTrue(ReasonTask.shouldDeferImplicitEnd(trace, "答".repeat(399), "Final Answer"),
                "399 个非空白字符未达阈值，仍须校验");
        // 大量空白 + 少量实字：去空白后不足 400，不得靠排版凑规模
        assertTrue(ReasonTask.shouldDeferImplicitEnd(trace,
                "答".repeat(100) + " ".repeat(600), "Final Answer"),
                "空白填充不得计入规模（否则一句意图声明加换行就能绕过门禁）");
        assertFalse(ReasonTask.shouldDeferImplicitEnd(trace,
                "答".repeat(400) + " ".repeat(50), "Final Answer"),
                "实字达 400 即放行，尾部空白不影响判定");
    }

    @Test
    @DisplayName("isSubstantialAnswer 边界：null / 空串 / 恰好 400")
    void substantialAnswerBoundaries() {
        assertFalse(ReasonTask.isSubstantialAnswer(null));
        assertFalse(ReasonTask.isSubstantialAnswer(""));
        assertFalse(ReasonTask.isSubstantialAnswer(" \n\t "));
        assertFalse(ReasonTask.isSubstantialAnswer("答".repeat(399)));
        assertTrue(ReasonTask.isSubstantialAnswer("答".repeat(400)));
    }

    @Test
    @DisplayName("J3：NBSP/U+2007/U+202F 按空白计（与 Rust char::is_whitespace 同口径）")
    void unicodeWhitespaceDoesNotCountTowardThreshold() {
        // 399 实字 + 大量 NBSP 排版：不得凑够 400 放行
        assertFalse(ReasonTask.isSubstantialAnswer(
                "答".repeat(399) + "\u00A0".repeat(50)),
                "NBSP 是 Unicode 空白，不得计入实字符（Character.isWhitespace 不含它）");
        assertFalse(ReasonTask.isSubstantialAnswer("\u2007\u202F\u00A0"));
        assertTrue(ReasonTask.isSubstantialAnswer("答".repeat(400) + "\u00A0".repeat(10)));
        assertTrue(ReasonTask.isUnicodeWhitespace('\u00A0'));
        assertTrue(ReasonTask.isUnicodeWhitespace('\u2007'));
        assertTrue(ReasonTask.isUnicodeWhitespace('\u202F'));
        assertFalse(ReasonTask.isUnicodeWhitespace('答'));
    }

    // ── 判据二：TODO 清单全完成 ────────────────────────────────

    @Test
    @DisplayName("放行判据二：会话 TODO 清单全部完成 → 不 defer")
    void allDoneTodoReleasesGate() throws Exception {
        ReActTrace trace = traceWithTodoDir("gate-release-done");
        trace.markConvergePending();
        writeTodo("gate-release-done", "# 任务清单\n- [x] 改造 A\n- [x] 验证 B\n");

        assertFalse(ReasonTask.shouldDeferImplicitEnd(trace, "已完成，结论如下。", "Final Answer"),
                "清单全完成时没有未完成事项可校验，短回答也应放行");
    }

    @Test
    @DisplayName("清单存在未完成项 → 仍须 defer（判据二不命中）")
    void unfinishedTodoKeepsGate() throws Exception {
        ReActTrace trace = traceWithTodoDir("gate-release-pending");
        trace.markConvergePending();
        writeTodo("gate-release-pending", "# 任务清单\n- [x] 改造 A\n- [ ] 验证 B\n");

        assertTrue(ReasonTask.shouldDeferImplicitEnd(trace, "取证够了。", "Final Answer"),
                "清单还有未完成项，意图声明必须被改判继续");
    }

    @Test
    @DisplayName("保守性：TODO 文件不存在 / 无任务行 / 无会话 → 不放行")
    void unreadableTodoKeepsGateConservatively() throws Exception {
        // 文件不存在
        ReActTrace missing = traceWithTodoDir("gate-release-missing");
        missing.markConvergePending();
        assertTrue(ReasonTask.shouldDeferImplicitEnd(missing, "取证够了。", "Final Answer"),
                "读不到清单时保守不放行（证据缺失不得放行潜在意图声明）");

        // 文件存在但解析不出任务行（旧 JSON 外壳等坏形态）
        ReActTrace noLines = traceWithTodoDir("gate-release-nolines");
        noLines.markConvergePending();
        writeTodo("gate-release-nolines", "{\"todos\":\"broken\"}");
        assertTrue(ReasonTask.shouldDeferImplicitEnd(noLines, "取证够了。", "Final Answer"),
                "解析不出任务行等同读取失败，保守不放行");

        // 无会话（trace 未 prepare）：不得抛异常，保守不放行
        ReActTrace bare = new ReActTrace();
        bare.markConvergePending();
        assertTrue(ReasonTask.shouldDeferImplicitEnd(bare, "取证够了。", "Final Answer"),
                "无会话时保守不放行且不得抛异常");
    }

    @Test
    @DisplayName("放行判据不改变既有直通语义：无收敛标记 / finishMarker / 次数上限")
    void releaseCriteriaDoNotAlterExistingBypass() throws Exception {
        // 无收敛标记：健康流程直通（与放行判据无关）
        ReActTrace healthy = new ReActTrace();
        assertFalse(ReasonTask.shouldDeferImplicitEnd(healthy, "任何正常回答", "Final Answer"));

        // finishMarker 直通保持：即便清单未完成、回答很短
        ReActTrace marked = traceWithTodoDir("gate-release-marker");
        marked.markConvergePending();
        writeTodo("gate-release-marker", "- [ ] 未完成\n");
        assertFalse(ReasonTask.shouldDeferImplicitEnd(marked, "Final Answer: 完成", "Final Answer"),
                "finishMarker 是显式完成语义，直通不受放行判据影响");
    }
}