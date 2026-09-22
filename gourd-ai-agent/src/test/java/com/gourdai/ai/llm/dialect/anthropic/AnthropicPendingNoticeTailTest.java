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

import com.gourdai.agent.react.PendingNoticeFilter;
import com.gourdai.agent.react.intercept.AskUser;
import com.gourdai.ai.chat.message.ChatMessage;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

/**
 * 挂起通知在 Anthropic 出站形态上的端到端护栏。
 *
 * <p>事故复现口径：会话 {@code work-mu9niqie} 在 ask_user 提交答案后恢复，出站 messages 的最后一条
 * 是纯文本 assistant「等待用户回答」，网关拒绝：
 * {@code 400 messages.63: This model does not support assistant message prefill;
 * the conversation must end with a user message}。</p>
 *
 * <p>上游 {@code PendingNoticeFilterTest} 验的是过滤判定本身；这里验的是<b>最终出站形态</b>——
 * 即「过滤之后，messages 不再以 assistant 结尾」。两者缺一不可：判定对但没接到组装链路上，
 * 线上依然会 400。</p>
 *
 * <p>与 {@link AnthropicThinkingSignatureGuardTest} 同属 Anthropic 出站契约，关切互不重叠：
 * 那边锁思考签名的判废，这边锁末尾角色。</p>
 */
class AnthropicPendingNoticeTailTest {

    /** 复刻事故会话的尾部形态：…user → tool 段 → assistant(挂起文案) 收尾。 */
    private static List<ChatMessage> victimShapedMemory() {
        List<ChatMessage> messages = new ArrayList<>();
        messages.add(ChatMessage.ofUser("交互问答框还有个问题，帮我看下"));
        messages.add(ChatMessage.ofAssistant("我先确认下你的口径。"));
        messages.add(ChatMessage.ofUser("好"));
        messages.add(ChatMessage.ofAssistant(AskUser.PENDING_REASON));
        return messages;
    }

    @Test
    void pendingNoticeTailIsRemovedSoConversationEndsWithUser() {
        List<ChatMessage> raw = victimShapedMemory();

        Assertions.assertTrue(raw.get(raw.size() - 1) instanceof com.gourdai.ai.chat.message.AssistantMessage,
                "前置条件：未过滤前必须确实以 assistant 结尾，否则本用例不具备复现意义");

        List<ChatMessage> sent = PendingNoticeFilter.filter(raw);

        Assertions.assertFalse(sent.get(sent.size() - 1) instanceof com.gourdai.ai.chat.message.AssistantMessage,
                "过滤后出站 messages 不得以 assistant 结尾（网关 400 的直接触发条件）");
        Assertions.assertEquals("好", sent.get(sent.size() - 1).getContent(),
                "剔除挂起通知后应回落到用户的真实发言");
    }

    @Test
    void realTrailingAnswerStillEndsWithAssistant() {
        // 方向相反的对照：任务正常结束时以 assistant 收尾是合法的（Anthropic 原生 prefill 语义），
        // 过滤器不得越界把它也砍掉 —— 否则会吞掉模型的最终回答。
        List<ChatMessage> raw = new ArrayList<>();
        raw.add(ChatMessage.ofUser("排查下"));
        raw.add(ChatMessage.ofAssistant("排查完成，根因已定位。"));

        List<ChatMessage> sent = PendingNoticeFilter.filter(raw);

        Assertions.assertSame(raw, sent, "无挂起通知时必须原样返回");
        Assertions.assertEquals("排查完成，根因已定位。", sent.get(sent.size() - 1).getContent());
    }
}
