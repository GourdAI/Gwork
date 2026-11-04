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
 * 收敛门禁（Converge Gate）的行为与接线守护。
 *
 * <p>背景（用户实测 work-mupc5nd0，2026-10-02 定性）：循环检测/自我反思注入的收敛导向
 * 指令（旧文案含「直接输出 Final Answer 结束任务」）会让模型把一句<b>过渡性意图声明</b>
 * （「取证够了，直接修两个 P0」「反思后确认：继续读文件…然后一次性提交修改」）当最终
 * 回答输出；NATIVE_TOOL 模式下 ReasonTask 对「有正文 + 无工具调用」无条件判 END——
 * TODO 0/10 未完成 Loop 却「正常」结束（route=end、abnormal=false）。</p>
 *
 * <p>门禁契约：注入方（StopLoopInterceptor / ReasonTask auto-rethink）置位
 * {@code EXTRA_CONVERGE_PENDING}；隐式 END 分支消费它——无完成语义（finishMarker）的
 * 纯文本回复改判继续并注入完成校验提示，改判次数达 {@code MAX_CONVERGE_DEFERRALS}
 * 后尊重模型回复，防新死循环。</p>
 *
 * <p>本类测试分两层：{@link ReActTrace} 标记读写是纯行为测试；ReasonTask 的门禁分支
 * 依赖 ReActAgent 实例与真实模型响应，按 {@code ReasonTaskResumeHintWiringTest}
 * 的既定口径做源码接线守护。</p>
 *
 * @author oisin
 */
class ReasonTaskConvergeGateTest {

    private static final Path SOURCE = Paths.get(
            "src/main/java/com/gourdai/agent/react/task/ReasonTask.java");

    // ── 行为层：ReActTrace 标记读写 ──────────────────────────

    @Test
    @DisplayName("converge 标记生命周期：置位→消费（清零+计数）→再置位")
    void convergeMarkerLifecycle() {
        ReActTrace trace = new ReActTrace();
        assertFalse(trace.isConvergePending(), "新 trace 不得带收敛标记（健康流程零影响）");
        assertEquals(0, trace.getConvergeDeferredCount());

        trace.markConvergePending();
        assertTrue(trace.isConvergePending());

        // 消费：标记清零、计数 +1（此时 ReasonTask 应重新置位以约束下一次纯文本回复）
        int first = trace.consumeConvergePending();
        assertFalse(trace.isConvergePending(), "消费即清零");
        assertEquals(1, first, "首次消费返回 1");
        assertEquals(1, trace.getConvergeDeferredCount());

        trace.markConvergePending();
        int second = trace.consumeConvergePending();
        assertEquals(2, second, "第二次消费返回 2");
        assertEquals(2, trace.getConvergeDeferredCount());
    }

    @Test
    @DisplayName("extras 快照往返：converge 标记随快照落盘（进程重启后门禁仍生效）")
    void convergeMarkerSurvivesExtrasRoundTrip() {
        ReActTrace trace = new ReActTrace();
        trace.markConvergePending();
        trace.consumeConvergePending();
        trace.markConvergePending();

        // extras 是 ConcurrentHashMap 快照序列化的落盘载体；直接验证 map 内容可 JSON 化保存
        Object pending = trace.getExtras().get(ReActTrace.EXTRA_CONVERGE_PENDING);
        Object count = trace.getExtras().get(ReActTrace.EXTRA_CONVERGE_DEFERRED_COUNT);
        assertTrue(Boolean.TRUE.equals(pending), "标记必须以可序列化的 Boolean 存于 extras");
        assertTrue(count instanceof Integer, "计数必须以可序列化的 Integer 存于 extras（AtomicInteger 不可序列化）");
        assertEquals(1, count);
    }

    // ── 行为层：门禁判定函数 shouldDeferImplicitEnd ─────────────────

    @Test
    @DisplayName("用户实测场景复现：注入过收敛指令 + 意图声明 → 必须改判继续")
    void intentDeclarationMustBeDeferred() {
        ReActTrace trace = new ReActTrace();
        trace.markConvergePending();

        // work-mupc5nd0 两次提前终止的真实回复文本
        assertTrue(ReasonTask.shouldDeferImplicitEnd(trace, "取证够了，直接修两个 P0。", "Final Answer"),
                "注入过收敛指令后，意图声明（无工具调用纯文本）必须被改判继续而非判为最终答案");
        assertTrue(ReasonTask.shouldDeferImplicitEnd(trace,
                "反思后确认：继续读文件是有效收敛动作，现在批量抓取待改代码块，然后一次性提交修改。", "Final Answer"),
                "自我反思后的意图声明同样必须被改判（第二次提前终止的真实形态）");
    }

    @Test
    @DisplayName("健康流程：未注入过收敛指令 → 纯文本回复直通最终答案")
    void healthyFlowMustPassThrough() {
        ReActTrace trace = new ReActTrace();
        assertFalse(ReasonTask.shouldDeferImplicitEnd(trace, "任何正常的最终回答", "Final Answer"),
                "无收敛标记时门禁零影响——普通对话/问答场景不得被拦");
    }

    @Test
    @DisplayName("显式完成语义：含 finishMarker 的回复不受门禁拦截")
    void explicitFinishMarkerMustBypass() {
        ReActTrace trace = new ReActTrace();
        trace.markConvergePending();
        assertTrue(ReasonTask.shouldDeferImplicitEnd(trace, "任务完成", "Final Answer"),
                "不含 finishMarker 时应改判（前置条件校验）");
        assertFalse(ReasonTask.shouldDeferImplicitEnd(trace, "Final Answer: 任务全部完成，以下是总结。", "Final Answer"),
                "含 finishMarker 是显式完成声明，必须直通不得拦截");
    }

    @Test
    @DisplayName("次数上限：改判达到 MAX_CONVERGE_DEFERRALS 后尊重模型回复")
    void ceilingMustReleaseGate() {
        ReActTrace trace = new ReActTrace();
        trace.markConvergePending();

        trace.consumeConvergePending(); // 1
        trace.markConvergePending();
        assertTrue(ReasonTask.shouldDeferImplicitEnd(trace, "取证够了。", "Final Answer"),
                "第 1 次改判后仍应拦截（尚未到上限）");

        trace.consumeConvergePending(); // 2 = MAX
        trace.markConvergePending();
        assertFalse(ReasonTask.shouldDeferImplicitEnd(trace, "取证够了。", "Final Answer"),
                "达上限（2 次）后必须放行，防止「模型想结束却永远结束不了」的新死循环");
    }

    @Test
    @DisplayName("完成校验文案：双出路措辞且不含绝对化收敛指令")
    void completionCheckPromptSemantics() {
        String prompt = ReasonTask.completionCheckPromptFor(1);
        assertTrue(prompt.contains("请继续执行"), "必须引导未完成则继续\n" + prompt);
        assertTrue(prompt.contains("完整总结报告"), "必须引导已完成则输出完整总结\n" + prompt);
        assertFalse(prompt.contains("直接输出 Final Answer"),
                "不得使用绝对化收敛指令（会诱导意图声明当最终答案，work-mupc5nd0 实测）\n" + prompt);
    }

    // ── 接线层：ReasonTask 门禁分支（源码守护，口径同 ResumeHintWiringTest） ──

    @Test
    @DisplayName("隐式 END 分支必须先过收敛门禁再判最终答案")
    void implicitEndMustCheckConvergeGateBeforeFinalAnswer() throws IOException {
        String region = logicFiveRegion();

        int gateIdx = region.indexOf("shouldDeferImplicitEnd(trace, clearContent");
        int finalIdx = region.indexOf("trace.setFinalAnswer(clearContent");
        assertTrue(gateIdx >= 0, "逻辑5 必须调用收敛门禁判定（shouldDeferImplicitEnd）\n" + region);
        assertTrue(finalIdx > gateIdx,
                "门禁判定必须先于 setFinalAnswer——否则意图声明仍会被当最终答案\n" + region);

        assertTrue(region.contains("trace.consumeConvergePending()"),
                "门禁命中时必须消费标记（计数 +1）\n" + region);
        assertTrue(region.contains("trace.markConvergePending()"),
                "改判继续后必须重新置位（约束下一次纯文本回复），否则一次改判后门禁失效\n" + region);
        assertTrue(region.contains("ReActAgent.ID_REASON"),
                "改判继续必须回到 REASON 路由\n" + region);
        assertTrue(region.contains("completionCheckPromptFor"),
                "必须注入完成校验提示（文案语义由 completionCheckPromptSemantics 行为用例守护）\n" + region);
    }

    @Test
    @DisplayName("门禁必须有次数上限（防「模型想结束却永远结束不了」的新死循环）")
    void gateMustHaveDeferredCountCeiling() throws IOException {
        String src = source();

        // 行为层由 ceilingMustReleaseGate 直接驱动 shouldDeferImplicitEnd；本用例守护
        // 上限常量存在且为 2（一次提示足以纠正意图声明；两次仍坚持则尊重模型）。
        assertTrue(src.contains("private static final int MAX_CONVERGE_DEFERRALS = 2;"),
                "上限常量必须存在且为 2");
        int ceilingIdx = src.indexOf("getConvergeDeferredCount() < MAX_CONVERGE_DEFERRALS");
        assertTrue(ceilingIdx > 0, "shouldDeferImplicitEnd 判定必须含改判次数上限检查\n");
    }

    @Test
    @DisplayName("含 finishMarker 的回复不受门禁拦截（显式完成语义直通）")
    void gateMustNotBlockExplicitFinishMarker() throws IOException {
        // 行为层由 explicitFinishMarkerMustBypass 直接驱动；此处守护判定函数确实
        // 把 finishMarker 作为豁免条件（防止未来重构把豁免条件丢掉）。
        String fn = shouldDeferBody();
        assertTrue(fn.contains("!clearContent.contains(finishMarker)"),
                "shouldDeferImplicitEnd 必须豁免 finishMarker\n" + fn);
    }

    @Test
    @DisplayName("改判继续时意图声明必须写入工作记忆（否则校验提示悬空）")
    void deferredBranchMustAppendIntentDeclarationToMemory() throws IOException {
        String region = logicFiveRegion();

        // 顺序断言：addMessage(responseMessage) → addMessage(校验提示)，意图声明先入记忆
        int intentIdx = region.indexOf("trace.getWorkingMemory().addMessage(responseMessage)");
        int promptIdx = region.indexOf("trace.getWorkingMemory().addMessage(ChatMessage.ofUser(completionCheckPromptFor");
        assertTrue(intentIdx >= 0 && promptIdx > intentIdx,
                "意图声明必须先于校验提示写入工作记忆——模型需要看到自己刚说了什么\n" + region);
    }

    @Test
    @DisplayName("auto-rethink 注入自我反思指令时必须同步打门禁标记")
    void autoRethinkMustArmGate() throws IOException {
        String src = source();
        int rethinkIdx = src.indexOf("rethinkPrompt = String.format");
        assertTrue(rethinkIdx > 0, "应能定位 auto-rethink 注入点");
        String window = src.substring(rethinkIdx, Math.min(src.length(), rethinkIdx + 2000));

        int addIdx = window.indexOf("trace.getWorkingMemory().addMessage(ChatMessage.ofUser(rethinkPrompt))");
        int markIdx = window.indexOf("trace.markConvergePending()");
        assertTrue(addIdx > 0, "auto-rethink 必须注入反思提示\n" + window);
        assertTrue(markIdx > addIdx,
                "自我反思指令同样收敛导向，注入后必须打门禁标记（work-mupc5nd0 第二次提前终止"
                        + "正是「反思后确认：继续读文件…」被当最终答案）\n" + window);
    }

    // ── 辅助 ──────────────────────────────────────────────

    private static String source() throws IOException {
        assertTrue(Files.exists(SOURCE),
                "找不到 ReasonTask 源码（测试须在 gourd-ai-agent 模块目录下运行）: "
                        + SOURCE.toAbsolutePath());
        return new String(Files.readAllBytes(SOURCE), StandardCharsets.UTF_8);
    }

    /** 提取「逻辑5」到「逻辑6」之间的路由判断区域（隐式 END 所在处）。 */
    private static String logicFiveRegion() throws IOException {
        String src = source();
        int start = src.indexOf("[逻辑 5");
        int end = src.indexOf("[逻辑 6");
        assertTrue(start > 0 && end > start,
                "应能定位逻辑5（NATIVE_TOOL 隐式结束分支）与逻辑6 的边界");
        return src.substring(start, end);
    }

    /** 提取 shouldDeferImplicitEnd 方法体。 */
    private static String shouldDeferBody() throws IOException {
        String src = source();
        int start = src.indexOf("static boolean shouldDeferImplicitEnd");
        assertTrue(start > 0, "应能定位 shouldDeferImplicitEnd 方法");
        int open = src.indexOf('{', start);
        int depth = 0;
        for (int i = open; i < src.length(); i++) {
            char c = src.charAt(i);
            if (c == '{') depth++;
            else if (c == '}') {
                depth--;
                if (depth == 0) return src.substring(open, i + 1);
            }
        }
        throw new IllegalStateException("shouldDeferImplicitEnd 方法体大括号未配平");
    }
}
