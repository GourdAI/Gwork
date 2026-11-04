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

import com.gourdai.agent.react.BackgroundNoticeCenter;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.session.InMemoryAgentSession;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 后台门禁（Background Task Gate）的行为与接线守护。
 *
 * <p>背景（用户实测 2026-10-15）：模型启动后台长任务（bash run_in_background / task background=true）
 * 后输出「构建完成后我会自动收到通知并校验产物」即结束回合——但回合结束即无执行体，
 * 完成通知（拉取式：仅在下一轮推理开头注入）落入无人消费的队列，用户视角是
 * 「任务目标未完成但整个任务结束了」。门禁在三个 END 判定点拦截「仍有运行中后台任务时的
 * 纯文本收尾」，注入收尾校验续跑（上限后尊重模型回复），逼模型当场核实或如实交代。</p>
 *
 * <p>本类测试分两层：探针注册表 / 门禁判定 / trace 计数是纯行为测试；ReasonTask 三个 END 分支
 * 与两个工具类的登记/注销接线依赖运行实例，按 {@code ReasonTaskConvergeGateTest} 的既定口径
 * 做源码接线守护。</p>
 *
 * <p>CRLF 纪律：仓库 git 为 i/lf w/crlf，Windows 工作树源码全是 CRLF；源码扫描切片前必须
 * lf() 归一，否则含字面换行的定位恒失配（假红）或切不开退化成整文件（假绿）。</p>
 *
 * @author oisin
 */
class ReasonTaskBackgroundGateTest {

    private static final Path REASON_SOURCE = Paths.get(
            "src/main/java/com/gourdai/agent/react/task/ReasonTask.java");
    private static final Path TERMINAL_SOURCE = Paths.get(
            "src/main/java/com/gourdai/harness/talents/cli/TerminalTalent.java");
    private static final Path TASK_SOURCE = Paths.get(
            "src/main/java/com/gourdai/harness/agent/TaskTalent.java");

    /** 本类用例登记过的探针键：探针注册表是全局静态，用例间必须互相清理，否则 hasRunning 串台。 */
    private static final String[] PROBE_KEYS = {"cmd_a", "cmd_b", "tok_a", "tok_b"};

    @AfterEach
    void cleanupProbes() {
        for (String key : PROBE_KEYS) {
            BackgroundNoticeCenter.unregisterRunning(key);
        }
    }

    /**
     * 带 session 的 trace：prepare 是 protected 且本类在 task 包（需调 ReasonTask 包级门禁方法），
     * 跨包不可直接调；按 protected 访问规则用子类在构造器内经 this 绑定。
     */
    private static final class GateTrace extends ReActTrace {
        GateTrace() {
            prepare(null, null, new InMemoryAgentSession("bg-gate-sess"), null, "bg-gate-test");
        }
    }

    private static ReActTrace newTrace() {
        return new GateTrace();
    }

    /** 带一个运行中后台任务（cmd_a）的 trace：门禁应处于武装态。 */
    private static ReActTrace armedTrace() {
        ReActTrace trace = newTrace();
        String owner = BackgroundNoticeCenter.resolveOwner(trace.getContext());
        BackgroundNoticeCenter.registerRunning(owner, "cmd_a");
        return trace;
    }

    // ── 行为层：运行中探针注册表 ──────────────────────────

    @Test
    @DisplayName("探针生命周期：登记→hasRunning/runningCount→注销→释放")
    void probeLifecycle() {
        ReActTrace trace = newTrace();
        String owner = BackgroundNoticeCenter.resolveOwner(trace.getContext());

        assertFalse(BackgroundNoticeCenter.hasRunning(owner), "新会话不得有运行中后台任务");
        assertEquals(0, BackgroundNoticeCenter.runningCount(owner));

        BackgroundNoticeCenter.registerRunning(owner, "cmd_a");
        BackgroundNoticeCenter.registerRunning(owner, "tok_a");
        assertTrue(BackgroundNoticeCenter.hasRunning(owner));
        assertEquals(2, BackgroundNoticeCenter.runningCount(owner), "两个后台任务在跑");

        BackgroundNoticeCenter.unregisterRunning("cmd_a");
        assertEquals(1, BackgroundNoticeCenter.runningCount(owner));
        BackgroundNoticeCenter.unregisterRunning("tok_a");
        assertFalse(BackgroundNoticeCenter.hasRunning(owner), "全部注销后门禁必须释放");
    }

    @Test
    @DisplayName("探针按 owner 隔离：A 会话在跑不得武装 B 会话的门禁")
    void probesAreIsolatedBetweenOwners() {
        ReActTrace a = newTrace();
        ReActTrace b = newTrace();
        String ownerA = BackgroundNoticeCenter.resolveOwner(a.getContext());
        String ownerB = BackgroundNoticeCenter.resolveOwner(b.getContext());

        BackgroundNoticeCenter.registerRunning(ownerA, "cmd_a");

        assertTrue(BackgroundNoticeCenter.hasRunning(ownerA));
        assertFalse(BackgroundNoticeCenter.hasRunning(ownerB), "归属隔离：B 不得看到 A 的后台任务");
        assertFalse(ReasonTask.bgGateArmed(b), "B 的门禁不得被 A 的后台任务武装");
        assertTrue(ReasonTask.bgGateArmed(a));
    }

    @Test
    @DisplayName("重复注销不得把登记打穿：幂等配对错位也不残留负状态")
    void duplicateUnregisterIsIdempotent() {
        ReActTrace trace = newTrace();
        String owner = BackgroundNoticeCenter.resolveOwner(trace.getContext());
        BackgroundNoticeCenter.registerRunning(owner, "cmd_a");

        BackgroundNoticeCenter.unregisterRunning("cmd_a");
        BackgroundNoticeCenter.unregisterRunning("cmd_a"); // 重复注销（配对错位的退化形态）
        BackgroundNoticeCenter.unregisterRunning("never-registered");

        assertFalse(BackgroundNoticeCenter.hasRunning(owner));
        assertEquals(0, BackgroundNoticeCenter.runningCount(owner));
    }

    // ── 行为层：门禁判定 ──────────────────────────

    @Test
    @DisplayName("用户实测场景复现：后台任务在跑 + 纯文本收尾承诺 → 必须改判继续")
    void gateDefersWhenBackgroundTaskRunning() {
        ReActTrace trace = armedTrace();
        // 2026-10-15 review 后三处 END 判定统一为 bgGateArmed（不豁免 finishMarker）：
        // 旧带豁免的 bgGateArmed 已被移除，隐式分支同口径拦截。
        assertTrue(ReasonTask.bgGateArmed(trace),
                "后台任务在跑时的纯文本收尾是虚假承诺，门禁必须改判继续");
    }

    @Test
    @DisplayName("无运行中后台任务：门禁不得改变任何现有结束行为")
    void gateReleasesWhenNoRunningTask() {
        ReActTrace trace = newTrace();
        assertFalse(ReasonTask.bgGateArmed(trace),
                "健康流程（无后台任务）门禁必须恒不命中");
    }

    @Test
    @DisplayName("三处 END 判定统一不豁免 finishMarker：含完成标识的收尾同样被拦")
    void gateDoesNotExemptFinishMarker() {
        ReActTrace trace = armedTrace();
        assertTrue(ReasonTask.bgGateArmed(trace),
                "含 finishMarker 不得豁免：三处 END 判定统一用 bgGateArmed（2026-10-15 review 口径）");
    }

    @Test
    @DisplayName("显式 Finish 分支必须可拦截：bgGateArmed 不受 finishMarker 豁免影响")
    void armedIgnoresFinishMarkerForExplicitFinishBranch() {
        ReActTrace trace = armedTrace();
        // 显式 Finish 分支的 clearContent 必然含 finishMarker；若复用带豁免的判定，门禁在该分支恒不命中
        assertTrue(ReasonTask.bgGateArmed(trace),
                "bgGateArmed 不得豁免 finishMarker：Finish 只表达主观完成，表达不了后台任务还在跑");
    }

    @Test
    @DisplayName("上限防真死循环：改判达 MAX 后尊重模型回复")
    void ceilingReleasesGate() {
        ReActTrace trace = armedTrace();
        assertTrue(ReasonTask.bgGateArmed(trace));

        assertEquals(1, trace.incrementBgGateDeferrals());
        assertTrue(ReasonTask.bgGateArmed(trace), "第 1 次改判后仍武装");

        assertEquals(2, trace.incrementBgGateDeferrals());
        assertFalse(ReasonTask.bgGateArmed(trace), "达上限后必须放行，防「永远结束不了」的新死循环");
    }

    @Test
    @DisplayName("后台任务注销后门禁立即释放：完成回调注销先于通知可见")
    void unregisterReleasesGate() {
        ReActTrace trace = armedTrace();
        assertTrue(ReasonTask.bgGateArmed(trace));

        BackgroundNoticeCenter.unregisterRunning("cmd_a");
        assertFalse(ReasonTask.bgGateArmed(trace), "任务结束注销后门禁必须放行");
    }

    // ── 行为层：trace 计数与文案 ──────────────────────────

    @Test
    @DisplayName("bg gate 计数生命周期：0→increment→extras 以可序列化 Integer 存放")
    void bgGateCountLifecycle() {
        ReActTrace trace = newTrace();
        assertEquals(0, trace.getBgGateDeferredCount(), "新 trace 不得带后台门禁计数");

        assertEquals(1, trace.incrementBgGateDeferrals());
        assertEquals(2, trace.incrementBgGateDeferrals());
        assertEquals(2, trace.getBgGateDeferredCount());

        Object count = trace.getExtras().get(ReActTrace.EXTRA_BG_GATE_DEFERRED_COUNT);
        assertTrue(count instanceof Integer, "计数必须以可序列化的 Integer 存于 extras（随快照落盘）");
    }

    @Test
    @DisplayName("门禁文案语义：两条出路 + 运行数量 + 次数，不得绝对化禁止结束")
    void promptSemantics() {
        String prompt = ReasonTask.backgroundGatePromptFor(1, 2);
        assertTrue(prompt.contains("当场核实"), "必须给出「当场核实」出路");
        assertTrue(prompt.contains("如实交代"), "必须给出「如实交代后结束」出路");
        assertTrue(prompt.contains("2 个运行中的后台任务"), "必须如实告知运行中任务数量");
        assertTrue(prompt.contains("1/2"), "必须告知校验次数与上限");
        assertFalse(prompt.contains("禁止结束"), "不得绝对化禁止结束：模型可能确实已无事可做");
    }

    // ── 接线层：ReasonTask 三个 END 分支 ──────────────────────────

    @Test
    @DisplayName("接线守护：三个 END 判定点全部接入后台门禁（隐式/显式 Finish/兜底）")
    void threeEndBranchesWiredToGate() throws IOException {
        String src = lf(new String(Files.readAllBytes(REASON_SOURCE), StandardCharsets.UTF_8));

        assertEquals(2, countOccurrences(src, "if (bgGateArmed(trace))"),
                "隐式分支与兜底分支必须各调一次 if (bgGateArmed(trace))；显式 Finish 分支用 == false 判定，由下一断言守护");
        assertEquals(1, countOccurrences(src, "bgGateArmed(trace) == false"),
                "显式 Finish 分支必须用不排除 finishMarker 的 bgGateArmed");
        assertEquals(3, countOccurrences(src, "trace.incrementBgGateDeferrals()"),
                "三个分支改判时必须各累加一次计数");
        assertEquals(3, countOccurrences(src, "backgroundGatePromptFor(deferred, running)"),
                "三个分支改判时必须各注入一次收尾校验提示");

        // 区域守卫：显式 Finish 分支区域内必须真有门禁调用（防止计数命中别的函数造成假绿）
        int finishStart = src.indexOf("1. 优先判断任务是否结束（Finish）");
        int finishEnd = src.indexOf("2. 其次判断文本形式的工具执行意图");
        assertTrue(finishStart > 0 && finishEnd > finishStart, "必须真切出显式 Finish 分支区域");
        String finishRegion = src.substring(finishStart, finishEnd);
        assertTrue(finishRegion.length() < src.length(), "切片不得退化成整文件");
        assertTrue(finishRegion.contains("bgGateArmed(trace)"),
                "显式 Finish 分支必须接入后台门禁\n" + finishRegion);
    }

    // ── 接线层：两个工具类的探针登记/注销 ──────────────────────────

    @Test
    @DisplayName("接线守护：bash 后台启动登记探针、完成回调先注销再投递通知")
    void terminalTalentWiresProbes() throws IOException {
        String src = lf(new String(Files.readAllBytes(TERMINAL_SOURCE), StandardCharsets.UTF_8));
        assertTrue(src.contains("BackgroundNoticeCenter.registerRunning(owner, snapshot.sessionId())"),
                "bash 后台启动后必须登记运行探针（门禁的判定依据）");
        assertTrue(src.contains("BackgroundNoticeCenter.unregisterRunning(done.sessionId())"),
                "完成回调必须注销探针");
        // 注销必须先于 publish：门禁看「还有什么在跑」，顺序反了会把已完成任务仍算在跑
        int unregisterIdx = src.indexOf("BackgroundNoticeCenter.unregisterRunning(done.sessionId())");
        int publishIdx = src.indexOf("BackgroundNoticeCenter.publish(owner,", unregisterIdx);
        assertTrue(unregisterIdx > 0 && publishIdx > unregisterIdx,
                "完成回调内注销必须先于通知投递");
    }

    @Test
    @DisplayName("接线守护：后台子代理提交登记探针、正常/异常完成均注销")
    void taskTalentWiresProbes() throws IOException {
        String src = lf(new String(Files.readAllBytes(TASK_SOURCE), StandardCharsets.UTF_8));
        assertTrue(src.contains("BackgroundNoticeCenter.registerRunning(owner, token)"),
                "后台子代理提交后必须登记运行探针");
        assertEquals(2, countOccurrences(src, "BackgroundNoticeCenter.unregisterRunning(token)"),
                "thenAccept 与 exceptionally 两条完成路径都必须注销探针");
    }

    // ── 接线层：文案必须如实声明通知消费时机 ──────────────────────────

    @Test
    @DisplayName("文案守护：启动响应/提交回执/系统提示均声明「通知在下一轮注入、不得等通知收尾」")
    void wordingStatesInjectionTimingAndNoWaitToFinish() throws IOException {
        String terminal = lf(new String(Files.readAllBytes(TERMINAL_SOURCE), StandardCharsets.UTF_8));
        assertTrue(terminal.contains("在下一轮推理开始时注入"),
                "bash 启动响应必须如实声明通知的消费时机（旧文案「会自动收到」是半真话）");
        assertTrue(terminal.contains("不要以「等通知」为由结束回合"),
                "bash 启动响应必须禁止模型以等通知为由收尾");

        String task = lf(new String(Files.readAllBytes(TASK_SOURCE), StandardCharsets.UTF_8));
        assertTrue(task.contains("后台收尾纪律"),
                "系统提示的任务分配策略必须含后台收尾纪律条目");
        assertTrue(task.contains("不得以「等通知」为由结束回合"),
                "子代理提交回执必须禁止模型以等通知为由收尾");
    }

    // ==================== 工具方法 ====================

    /** CRLF 归一：Windows 工作树源码全是 CRLF，含字面换行的定位必须先归一（否则假红/假绿）。 */
    private static String lf(String s) {
        return s.replace("\r\n", "\n");
    }

    private static int countOccurrences(String haystack, String needle) {
        int count = 0;
        int idx = 0;
        while ((idx = haystack.indexOf(needle, idx)) >= 0) {
            count++;
            idx += needle.length();
        }
        return count;
    }
}
