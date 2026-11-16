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

import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.task.ToolExchanger;
import com.gourdai.agent.util.AskUserTool;
import com.gourdai.agent.util.CompleteTaskTool;
import com.gourdai.ai.chat.message.AssistantMessage;
import com.gourdai.ai.chat.tool.ToolCall;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * complete_task 拦截器行为测试（契约 §4.2）。
 *
 * <p>覆盖：execute=ok(summary) 短路语义、同批含 ask_user 的互斥拒绝
 * （与调用次序无关）、summary 缺失的可自愈参数错误、非 complete_task 放行。</p>
 */
class CompleteTaskInterceptorTest {

    private static ToolCall call(String name) {
        return new ToolCall("0", "call-" + name, name, "{}", Map.of());
    }

    private static ReActTrace traceWithCalls(ToolCall... calls) {
        ReActTrace trace = new ReActTrace();
        trace.setLastReasonMessage(new AssistantMessage("", "", List.of(calls), null));
        return trace;
    }

    private static ToolExchanger completeExchanger(String summary) {
        return new ToolExchanger(CompleteTaskTool.TOOL_NAME,
                summary == null ? Map.of() : Map.of("summary", summary), "call-complete");
    }

    @Test
    @DisplayName("execute 语义：ok(summary)——summary 原样回填为工具结果，不置失败")
    void okSummaryBecomesResult() {
        ReActTrace trace = traceWithCalls(call(CompleteTaskTool.TOOL_NAME));
        ToolExchanger exchanger = completeExchanger("改造完成，验证通过。");

        new CompleteTaskInterceptor().onAction(trace, exchanger);

        assertEquals("改造完成，验证通过。", exchanger.getResult(),
                "summary 必须原样回填（ActionTask 据此 setFinalAnswer 直通 END）");
        assertFalse(exchanger.isFailed(), "正常提交不得置失败");
    }

    @Test
    @DisplayName("同批互斥：含 ask_user 时返回契约错误文案并置失败，不结束")
    void batchWithAskUserIsRejected() {
        // complete_task 在前、ask_user 在后：判定看完整调用清单，与次序无关
        ReActTrace trace = traceWithCalls(call(CompleteTaskTool.TOOL_NAME), call(AskUserTool.TOOL_NAME));
        ToolExchanger exchanger = completeExchanger("已完成。");

        new CompleteTaskInterceptor().onAction(trace, exchanger);

        assertEquals("complete_task 未结束任务：本批含待用户回应的挂起操作（提问或审批），不能同时提交完成。请先等待用户回应，再决定是否收尾。",
                exchanger.getResult(),
                "互斥错误文案必须逐字采用契约 §4.2（双内核一致版）");
        assertTrue(exchanger.isFailed(), "互斥拒绝必须是结构化失败（模型据此改走先等回答路径）");
    }

    @Test
    @DisplayName("同批互斥与次序无关：ask_user 在前同样拒绝")
    void batchOrderDoesNotMatter() {
        ReActTrace trace = traceWithCalls(call(AskUserTool.TOOL_NAME), call(CompleteTaskTool.TOOL_NAME));
        ToolExchanger exchanger = completeExchanger("已完成。");

        new CompleteTaskInterceptor().onAction(trace, exchanger);

        assertTrue(exchanger.isFailed());
        assertEquals(CompleteTaskInterceptor.CONFLICT_RESULT, exchanger.getResult());
    }

    @Test
    @DisplayName("summary 缺失/空白：可自愈参数错误，不结束")
    void missingSummaryIsRecoverableError() {
        ReActTrace trace = traceWithCalls(call(CompleteTaskTool.TOOL_NAME));

        ToolExchanger missing = completeExchanger(null);
        new CompleteTaskInterceptor().onAction(trace, missing);
        assertTrue(missing.isFailed(), "缺 summary 必须失败（不得以空回答结束任务）");
        assertTrue(missing.getResult().contains("Invalid arguments"), "必须是可自愈的参数错误口径");

        ToolExchanger blank = completeExchanger("   ");
        new CompleteTaskInterceptor().onAction(trace, blank);
        assertTrue(blank.isFailed(), "空白 summary 同样不得结束");
    }

    @Test
    @DisplayName("非 complete_task 工具一律放行（不改写结果）")
    void otherToolsPassThrough() {
        ReActTrace trace = traceWithCalls(call("read"));
        ToolExchanger exchanger = new ToolExchanger("read", Map.of(), "call-read");

        new CompleteTaskInterceptor().onAction(trace, exchanger);

        assertNull(exchanger.getResult(), "非 complete_task 不得被短路");
        assertFalse(exchanger.isFailed());
    }

    @Test
    @DisplayName("无推理消息（异常现场）：不误判互斥，按 summary 正常处理")
    void noReasonMessageDoesNotFalseConflict() {
        ReActTrace trace = new ReActTrace();
        ToolExchanger exchanger = completeExchanger("完成。");

        new CompleteTaskInterceptor().onAction(trace, exchanger);

        assertFalse(exchanger.isFailed());
        assertEquals("完成。", exchanger.getResult());
    }

    @Test
    @DisplayName("工具函数体兜底：未挂拦截器时原样返回 summary")
    void toolBodyFallbackReturnsSummary() throws Throwable {
        Object result = CompleteTaskTool.getTool().handle(Map.of("summary", "兜底回答"));
        assertEquals("兜底回答", result, "兜底路径必须原样返回 summary（防御异常调用路径）");
    }
}