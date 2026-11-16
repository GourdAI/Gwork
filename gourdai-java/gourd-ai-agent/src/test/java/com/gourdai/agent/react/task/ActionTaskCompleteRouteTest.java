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

import com.gourdai.agent.Agent;
import com.gourdai.agent.event.AgentEvent;
import com.gourdai.agent.event.ReasonDeltaEvent;
import com.gourdai.agent.react.ReActAgent;
import com.gourdai.agent.react.ReActOptions;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.session.InMemoryAgentSession;
import com.gourdai.agent.util.AskUserTool;
import com.gourdai.agent.util.CompleteTaskTool;
import com.gourdai.ai.chat.tool.ToolCall;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.FluxSink;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * complete_task 直通路由与批尾重排的行为测试（契约 §4.2）。
 *
 * <p>覆盖：finishByCompleteTask 的「finalAnswer + END + 正常完成（abnormal=false）」
 * 语义与正文补帧（summary 在工具参数里而非模型正文流里，不补发前端只见工具卡）；
 * 幂等（同批多个 complete_task 不二次提交）；moveCompleteTaskToTail 的稳定重排。</p>
 */
class ActionTaskCompleteRouteTest {

    private static ToolCall call(String name) {
        return new ToolCall("0", "call-" + name, name, "{}", Map.of());
    }

    /** 带流式 sink 捕获的 trace：sink 是 protected 注入，用子类暴露（与生产注入同路径）。 */
    private static class SinkOptions extends ReActOptions {
        SinkOptions(FluxSink<AgentEvent> sink) {
            super(null);
            setStreamSink(sink);
        }
    }

    private static ReActTrace traceWithOptions(ReActOptions options) {
        return new ReActTrace() {
            @Override
            public ReActOptions getOptions() {
                return options;
            }

            @Override
            public com.gourdai.agent.AgentSession getSession() {
                return InMemoryAgentSession.of("complete-route");
            }
        };
    }

    // ── finishByCompleteTask：直通语义 ─────────────────────────

    @Test
    @DisplayName("直通：summary 即 finalAnswer（abnormal=false），路由 END，正文经 ReasonDeltaEvent 补发")
    void finishSetsAnswerRouteAndStreamsSummary() {
        List<AgentEvent> emitted = new ArrayList<>();
        FluxSink<AgentEvent> sink = new CapturingSink(emitted);
        ReActTrace trace = traceWithOptions(new SinkOptions(sink));
        trace.setRoute(ReActAgent.ID_ACTION);

        ActionTask.finishByCompleteTask(trace, "改造完成：A 已修复，测试全绿。");

        assertEquals(Agent.ID_END, trace.getRoute(), "必须直通 END（跳过收敛/后台门禁）");
        assertEquals("改造完成：A 已修复，测试全绿。", trace.getFinalAnswer(), "summary 即最终回答");
        assertFalse(trace.isAbnormal(), "complete_task 是显式正常完成，不得标异常（finishMarker 直通同语义）");

        assertEquals(1, emitted.size(), "summary 必须经既有文本通道补发一帧（前端要看到正文）");
        assertTrue(emitted.get(0) instanceof ReasonDeltaEvent);
        ReasonDeltaEvent delta = (ReasonDeltaEvent) emitted.get(0);
        assertFalse(delta.isThinking(), "补发的是正文而非思考");
        assertEquals("改造完成：A 已修复，测试全绿。", delta.getContent());
    }

    @Test
    @DisplayName("幂等：路由已 END 时不重复置答案、不重复补帧")
    void finishIsIdempotentWhenAlreadyEnd() {
        List<AgentEvent> emitted = new ArrayList<>();
        ReActTrace trace = traceWithOptions(new SinkOptions(new CapturingSink(emitted)));
        trace.setRoute(Agent.ID_END);
        trace.setFinalAnswer("第一份总结", false);

        ActionTask.finishByCompleteTask(trace, "第二份总结");

        assertEquals("第一份总结", trace.getFinalAnswer(), "已 END 不得二次提交覆盖答案");
        assertTrue(emitted.isEmpty(), "已 END 不得重复补帧");
    }

    @Test
    @DisplayName("无 sink（非流式通道）：仍正常置答案与路由，不抛异常")
    void finishWithoutSinkStillCompletes() {
        ReActTrace trace = traceWithOptions(new ReActOptions(null));
        trace.setRoute(ReActAgent.ID_ACTION);

        ActionTask.finishByCompleteTask(trace, "完成。");

        assertEquals(Agent.ID_END, trace.getRoute());
        assertEquals("完成。", trace.getFinalAnswer());
        assertFalse(trace.isAbnormal());
    }

    // ── 自审修复 J1：summary 与本轮已流式正文判重（契约 §4.2） ─────────────

    @Test
    @DisplayName("J1 判重：summary 与本轮已流式正文相同（trim 口径）→ 不整段补发第二份")
    void summaryIdenticalToStreamedTextIsNotResent() {
        List<AgentEvent> emitted = new ArrayList<>();
        ReActTrace trace = traceWithOptions(new SinkOptions(new CapturingSink(emitted)));
        trace.setRoute(ReActAgent.ID_ACTION);
        String summary = "## 完成\n改动已落地，测试全绿。";
        // 模型先把同一段总结作为正文流式输出（首尾空白差异按 trim 口径忽略）
        trace.setLastReasonMessage(new com.gourdai.ai.chat.message.AssistantMessage(
                "  " + summary + "\n"));

        ActionTask.finishByCompleteTask(trace, summary);

        assertEquals(Agent.ID_END, trace.getRoute());
        assertEquals(summary, trace.getFinalAnswer());
        assertTrue(emitted.isEmpty(),
                "正文已逐 token 交付，整段补发就是用户看到的第二份总结");
    }

    @Test
    @DisplayName("J1 对照：summary 扩写了已流式正文 → 仍整段补发（不丢模型钦定的最终交付）")
    void summaryExtendingStreamedTextIsStillEmitted() {
        List<AgentEvent> emitted = new ArrayList<>();
        ReActTrace trace = traceWithOptions(new SinkOptions(new CapturingSink(emitted)));
        trace.setRoute(ReActAgent.ID_ACTION);
        trace.setLastReasonMessage(new com.gourdai.ai.chat.message.AssistantMessage("改完了。"));
        String summary = "## 完成\n改动已落地，测试全绿，另有遗留事项见下。";

        ActionTask.finishByCompleteTask(trace, summary);

        assertEquals(1, emitted.size(), "扩写的 summary 必须交付");
        assertEquals(summary, ((ReasonDeltaEvent) emitted.get(0)).getContent());
    }

    @Test
    @DisplayName("J1 边界：无推理消息（summary 只在工具参数里）→ 照常补发")
    void summaryWithoutStreamedTextIsEmitted() {
        List<AgentEvent> emitted = new ArrayList<>();
        ReActTrace trace = traceWithOptions(new SinkOptions(new CapturingSink(emitted)));
        trace.setRoute(ReActAgent.ID_ACTION);
        // lastReasonMessage 保持 null

        ActionTask.finishByCompleteTask(trace, "完成。");

        assertEquals(1, emitted.size());
        assertEquals("完成。", ((ReasonDeltaEvent) emitted.get(0)).getContent());
    }

    // ── moveCompleteTaskToTail：批尾重排 ───────────────────────

    @Test
    @DisplayName("批尾重排：complete_task 移到最后，其余调用保持相对顺序")
    void completeTaskMovesToTail() {
        ToolCall read = call("read");
        ToolCall complete = call(CompleteTaskTool.TOOL_NAME);
        ToolCall bash = call("bash");

        List<ToolCall> reordered = ActionTask.moveCompleteTaskToTail(List.of(complete, read, bash));

        assertEquals(List.of(read, bash, complete), reordered,
                "complete_task 必须最后执行（同批其它工具先落地结果）");
    }

    @Test
    @DisplayName("无 complete_task 时原样返回（零开销快路径）；单元素/null 安全")
    void noCompleteTaskKeepsOrder() {
        List<ToolCall> calls = List.of(call("read"), call("bash"));
        assertSame(calls, ActionTask.moveCompleteTaskToTail(calls));
        assertNull(ActionTask.moveCompleteTaskToTail(null));

        List<ToolCall> single = List.of(call(CompleteTaskTool.TOOL_NAME));
        assertSame(single, ActionTask.moveCompleteTaskToTail(single));
    }

    @Test
    @DisplayName("多个 complete_task（模型异常输出）依序排在尾部")
    void multipleCompleteTasksGoToTailInOrder() {
        ToolCall c1 = call(CompleteTaskTool.TOOL_NAME);
        ToolCall c2 = new ToolCall("1", "call-2", CompleteTaskTool.TOOL_NAME, "{}", Map.of());
        ToolCall ask = call(AskUserTool.TOOL_NAME);

        List<ToolCall> reordered = ActionTask.moveCompleteTaskToTail(List.of(c1, ask, c2));

        assertEquals(List.of(ask, c1, c2), reordered);
    }

    /** 最小 FluxSink 捕获桩：只关心 next()，其余生命周期方法不参与本测试。 */
    private static class CapturingSink implements FluxSink<AgentEvent> {
        private final List<AgentEvent> emitted;

        CapturingSink(List<AgentEvent> emitted) {
            this.emitted = emitted;
        }

        @Override
        public FluxSink<AgentEvent> next(AgentEvent event) {
            emitted.add(event);
            return this;
        }

        @Override
        public void complete() {
        }

        @Override
        public void error(Throwable e) {
        }

        @Override
        public FluxSink<AgentEvent> onRequest(java.util.function.LongConsumer consumer) {
            return this;
        }

        @Override
        public FluxSink<AgentEvent> onCancel(reactor.core.Disposable disposable) {
            return this;
        }

        @Override
        public FluxSink<AgentEvent> onDispose(reactor.core.Disposable disposable) {
            return this;
        }

        @Override
        public long requestedFromDownstream() {
            return Long.MAX_VALUE;
        }

        @Override
        public boolean isCancelled() {
            return false;
        }

        @Override
        public reactor.util.context.Context currentContext() {
            return reactor.util.context.Context.empty();
        }
    }
}