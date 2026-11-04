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
package com.gourdai.agent.react;

import com.gourdai.agent.AgentTrace;
import com.gourdai.agent.react.intercept.AskUser;
import com.gourdai.ai.chat.message.AssistantMessage;
import com.gourdai.ai.chat.message.ChatMessage;
import com.gourdai.ai.chat.tool.ToolCall;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;

/**
 * 挂起通知过滤器契约。
 *
 * <p>背景（真实事故）：ask_user 问答卡提交答案、任务恢复后，出站 messages 以一条纯文本
 * assistant「等待用户回答」结尾，中转网关拒绝整次请求：
 * {@code 400 messages.63: This model does not support assistant message prefill;
 * the conversation must end with a user message}。根因是挂起控制信号被当作模型的正常回答
 * 写进了工作记忆（{@code ReActAgent} 收尾段），而所有方言的请求组装都只做逐条翻译、
 * 不做末尾角色规整。</p>
 *
 * <p>本测试锁定两个方向相反的行为，任一侧误改都会在此暴露：</p>
 * <ul>
 * <li><b>必须剔除</b>：带挂起标记的消息、以及标记引入前落盘的历史挂起文案。</li>
 * <li><b>必须保留</b>：模型的真实回答、带 toolCalls 的调用声明、
 * 以及 HITL「拒绝」这类终止性真实答复（它不走挂起路径，是用户决策的真实语义）。</li>
 * </ul>
 */
class PendingNoticeFilterTest {

    private static AssistantMessage pendingNotice(String text) {
        AssistantMessage message = ChatMessage.ofAssistant(text);
        message.addMetadata(AgentTrace.META_PENDING_NOTICE, 1);
        return message;
    }

    private static AssistantMessage withToolCall(String text, String callId) {
        // 构造口径与 ToolCallPairRepairTest 一致（index 与 id 同值、空参数表）
        ToolCall call = new ToolCall(callId, callId, "ask_user", "{}", new LinkedHashMap<>());

        List<ToolCall> calls = new ArrayList<>();
        calls.add(call);

        return new AssistantMessage(text, null, calls, null);
    }

    // ==================== 1. 必须剔除 ====================

    @Test
    void markedPendingNoticeIsRemoved() {
        List<ChatMessage> messages = List.of(
                ChatMessage.ofUser("帮我排查这个问题"),
                pendingNotice(AskUser.PENDING_REASON));

        List<ChatMessage> kept = PendingNoticeFilter.filter(messages);

        Assertions.assertEquals(1, kept.size(), "带挂起标记的消息必须被剔除");
        Assertions.assertFalse(kept.get(kept.size() - 1) instanceof AssistantMessage,
                "剔除后末条不得再是 assistant —— 这正是网关 400 的触发条件");
    }

    @Test
    void legacyPendingTextIsRemovedWithoutMetadata() {
        // 标记引入前落盘的历史数据没有 metadata，只能按文案兜底识别。
        // 实测 19 个会话沉积了 39 条这样的消息，不兜底则历史会话仍会复发 400。
        List<ChatMessage> messages = List.of(
                ChatMessage.ofUser("继续"),
                ChatMessage.ofAssistant(AskUser.PENDING_REASON));

        List<ChatMessage> kept = PendingNoticeFilter.filter(messages);

        Assertions.assertEquals(1, kept.size(), "无标记的历史挂起文案必须由兜底路径剔除");
    }

    @Test
    void legacyHitlPendingTextIsRemoved() {
        List<ChatMessage> messages = List.of(
                ChatMessage.ofUser("删掉临时目录"),
                ChatMessage.ofAssistant("敏感操作，需要人工介入确认"));

        Assertions.assertEquals(1, PendingNoticeFilter.filter(messages).size(),
                "HITL 挂起等待审批的文案同属控制信号，与 ask_user 同口径处理");
    }

    @Test
    void surroundingWhitespaceStillMatchesLegacyText() {
        List<ChatMessage> messages = List.of(
                ChatMessage.ofAssistant("  " + AskUser.PENDING_REASON + "\n"));

        Assertions.assertTrue(PendingNoticeFilter.filter(messages).isEmpty(),
                "首尾空白不应让兜底匹配失效");
    }

    // ==================== 2. 必须保留（方向相反的对照） ====================

    @Test
    void realAnswerIsKept() {
        AssistantMessage real = ChatMessage.ofAssistant("排查完成，根因是消息组装时末尾角色非法。");
        List<ChatMessage> messages = List.of(ChatMessage.ofUser("排查下"), real);

        List<ChatMessage> kept = PendingNoticeFilter.filter(messages);

        Assertions.assertEquals(2, kept.size(), "模型的真实回答不得被剔除");
        Assertions.assertSame(messages, kept, "无命中时必须返回入参本身，保证健康流程零拷贝开销");
    }

    @Test
    void quotingPendingTextInLongerAnswerIsKept() {
        // 兜底只认「正文恰好等于挂起文案」。模型正文里引用这句话（例如排查报告里复述）必须放行，
        // 否则会凭空吞掉模型的真实回答。
        AssistantMessage quoting = ChatMessage.ofAssistant(
                "我发现工作记忆里混进了一条「" + AskUser.PENDING_REASON + "」，这就是 400 的来源。");

        List<ChatMessage> kept = PendingNoticeFilter.filter(List.of(quoting));

        Assertions.assertEquals(1, kept.size(), "包含挂起文案的长正文是真实回答，不得按包含匹配误杀");
    }

    @Test
    void toolCallDeclarationIsNeverRemoved() {
        // 带 toolCalls 的消息即便被误打标记也必须保留：剔除它会破坏「调用 ↔ 结果」配对，
        // 触发供应商的另一种 400（No tool output found for tool call）。
        AssistantMessage declaration = withToolCall(AskUser.PENDING_REASON, "call-1");
        declaration.addMetadata(AgentTrace.META_PENDING_NOTICE, 1);

        List<ChatMessage> kept = PendingNoticeFilter.filter(List.of(declaration));

        Assertions.assertEquals(1, kept.size(),
                "工具调用声明是配对的一半，任何情况下都不得剔除");
        Assertions.assertFalse(PendingNoticeFilter.isPendingNotice(declaration),
                "带 toolCalls 的消息不得被判定为挂起通知");
    }

    @Test
    void hitlRejectionAnswerIsKept() {
        // HITL 拒绝走的是 setRoute(ID_END) 而非 session.pending(...)，
        // 故它不经过挂起路径、不会被打标记，且文案与兜底清单不同 —— 必须原样保留。
        List<ChatMessage> messages = List.of(
                ChatMessage.ofUser("执行删除"),
                ChatMessage.ofAssistant("操作拒绝：人工审批未通过。"));

        Assertions.assertEquals(2, PendingNoticeFilter.filter(messages).size(),
                "用户拒绝是真实决策语义，是任务终态答复，必须保留给下一轮上下文");
    }

    // ==================== 3. 边界 ====================

    @Test
    void emptyInputIsPassedThrough() {
        Assertions.assertNull(PendingNoticeFilter.filter(null));
        Assertions.assertTrue(PendingNoticeFilter.filter(new ArrayList<>()).isEmpty());
    }

    @Test
    void multiplePendingNoticesAreAllRemovedPreservingOrder() {
        ChatMessage u1 = ChatMessage.ofUser("第一问");
        ChatMessage u2 = ChatMessage.ofUser("第二问");
        AssistantMessage real = ChatMessage.ofAssistant("这是真实回答");

        List<ChatMessage> messages = List.of(
                u1, pendingNotice(AskUser.PENDING_REASON),
                u2, ChatMessage.ofAssistant(AskUser.PENDING_REASON), real);

        List<ChatMessage> kept = PendingNoticeFilter.filter(messages);

        Assertions.assertEquals(List.of(u1, u2, real), kept,
                "多条挂起通知应全部剔除，其余消息保持原有相对顺序");
    }
}
