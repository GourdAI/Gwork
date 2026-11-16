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
package com.gourdai.harness.talents.cli;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 规划指南精简、reminder 截断与 footer 条件行的行为测试（契约 §3.1 / §3.2 / §3.3）。
 *
 * <p>§3.1：指南重写为 5 条（&lt;1400 字符），第 3 条放宽为「随做随记」；
 * §3.2：恢复校准清单快照按 800 字符截断加 …[truncated]；
 * §3.3：「[提示] 存在 N 个 [/] 进行中项…恢复校准…」行仅恢复/异常中断后续跑注入，
 * 常规 footer 不带——正常执行中的 [/] 就是正在做的事，每次提示「可能是遗留项」
 * 反而诱导模型反复自查。</p>
 */
class TodoTalentGuideAndFooterTest {

    private static final String IN_PROGRESS_LIST = "# 任务清单\n- [x] 已完成 A\n- [/] 进行中 B\n- [ ] 待办 C\n";

    // ── §3.1 规划指南 ─────────────────────────────────────────

    @Test
    @DisplayName("§3.1：指南精简为 5 条且 <1400 字符，关键纪律保留")
    void planningGuideIsCompact() {
        String guide = TodoTalent.PLANNING_GUIDE_CN;

        assertTrue(guide.length() < 1400,
                "契约 §3.1 要求指南 <1400 字符（~450 tokens），实际 " + guide.length());
        assertTrue(guide.contains("随做随记"), "第 3 条必须放宽为随做随记（不再强制下一轮首个动作）");
        assertFalse(guide.contains("下一轮的首个动作必须是"),
                "旧的「下一轮首个动作必须 todowrite」强约束已被契约放宽，不得回退");
        assertTrue(guide.contains("至多一项 in_progress"), "状态纪律保留");
        assertTrue(guide.contains("收尾判据"), "收尾判据保留（改造门禁收敛进第 5 条）");
        assertTrue(guide.contains("等待用户拍板"), "等待用户拍板时停下合规的语义保留");
        assertTrue(guide.contains("恢复校准"), "恢复校准纪律保留");
    }

    // ── §3.2 reminder 截断 ────────────────────────────────────

    @Test
    @DisplayName("§3.2：清单快照超 800 字符截断并加 …[truncated]")
    void resumeCalibrationTruncatesSnapshotAt800() {
        StringBuilder longList = new StringBuilder("- [ ] 任务");
        for (int i = 0; i < 300; i++) {
            longList.append("\n- [ ] 任务条目 ").append(i).append(" 的较长描述文本");
        }
        String content = longList.toString();
        assertTrue(content.length() > TodoTalent.REMINDER_MAX_CHARS, "前置：构造超长清单");

        String calibration = TodoTalent.buildResumeCalibration(content);

        assertNotNull(calibration);
        assertTrue(calibration.contains("…[truncated]"), "截断必须带契约标记");
        // 快照主体 = 前 800 字符 + 标记；校准消息其余部分为固定文案
        int snapshotStart = calibration.indexOf("<todo_snapshot>\n") + "<todo_snapshot>\n".length();
        int snapshotEnd = calibration.indexOf("\n</todo_snapshot>");
        String snapshot = calibration.substring(snapshotStart, snapshotEnd);
        assertEquals(TodoTalent.REMINDER_MAX_CHARS + "…[truncated]".length(), snapshot.length(),
                "快照必须恰好截到 800 字符再加标记");
        assertEquals(content.trim().substring(0, TodoTalent.REMINDER_MAX_CHARS) + "…[truncated]", snapshot);
    }

    @Test
    @DisplayName("§3.2：短清单不截断（逐字保留）；无未完成项不校准")
    void shortSnapshotKeptVerbatim() {
        String calibration = TodoTalent.buildResumeCalibration(IN_PROGRESS_LIST);

        assertNotNull(calibration);
        assertFalse(calibration.contains("…[truncated]"), "短清单不得截断");
        assertTrue(calibration.contains(IN_PROGRESS_LIST.trim()), "短清单逐字保留");

        assertNull(TodoTalent.buildResumeCalibration("- [x] 全部完成\n"), "无未完成项无需校准");
    }

    // ── §3.3 footer 条件行 ────────────────────────────────────

    @Test
    @DisplayName("§3.3：常规 footer（false）不带 [提示] 恢复校准行")
    void regularFooterOmitsCalibrationHint() {
        String footer = TodoTalent.buildProgressFooter(IN_PROGRESS_LIST, false);

        assertFalse(footer.contains("[提示]"),
                "常规 run 的 [/] 就是正在做的事，不得每次提示「可能是遗留项」诱导反复自查");
        assertTrue(footer.contains("[进度]"), "进度统计保留");
        assertTrue(footer.contains("[继续]"), "未完成推力保留");
    }

    @Test
    @DisplayName("§3.3：恢复校准 footer（true）注入 [提示] 行")
    void resumeFooterCarriesCalibrationHint() {
        String footer = TodoTalent.buildProgressFooter(IN_PROGRESS_LIST, true);

        assertTrue(footer.contains("[提示] 存在 1 个 `[/]` 进行中项"),
                "恢复/异常中断后续跑必须注入校准提示行");
        assertTrue(footer.contains("不要盲目重做"), "校准行语义保留");
    }

    @Test
    @DisplayName("§3.3：无 [/] 项时两种模式都不注入 [提示] 行")
    void noInProgressNoHint() {
        String list = "- [x] 完成 A\n- [ ] 待办 B\n";

        assertFalse(TodoTalent.buildProgressFooter(list, false).contains("[提示]"));
        assertFalse(TodoTalent.buildProgressFooter(list, true).contains("[提示]"),
                "提示行只针对 [/] 遗留项，无 [/] 时恢复模式也不注入");
    }

    @Test
    @DisplayName("§3.3：全完成清单的 [完成] 推力不受条件行影响")
    void allDoneFooterUnchanged() {
        String list = "- [x] 完成 A\n- [x] 完成 B\n";

        String regular = TodoTalent.buildProgressFooter(list, false);
        String resume = TodoTalent.buildProgressFooter(list, true);

        assertTrue(regular.contains("[完成]"), "全完成推力保留");
        assertEquals(regular, resume, "全完成时两种模式输出一致（无 [/] 可提示）");
    }
}