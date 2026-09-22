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
import org.noear.solon.core.util.Assert;

import java.util.ArrayList;
import java.util.List;

/**
 * 挂起通知过滤器
 *
 * <p>任务挂起（等待用户回答 {@code ask_user} / 等待人工审批 HITL）时，{@code ReActAgent} 会把挂起
 * 文案当作本轮「最终答案」落盘，用于前端气泡展示与会话历史回放。但它是<b>控制信号</b>，不是模型说过的话：
 * 把它随工作记忆发给供应商会造成三重损害。</p>
 *
 * <ul>
 * <li><b>协议非法</b>：它是一条纯文本 assistant 消息，若恰好落在工作记忆末尾，出站 messages 就以
 * assistant 结尾。Anthropic 原生允许这种 prefill 续写，但部分中转网关不支持，直接拒绝整次请求
 * （{@code 400 This model does not support assistant message prefill; the conversation must end
 * with a user message}）且重试无法自愈。</li>
 * <li><b>语义污染</b>：模型会把「等待用户回答」读成自己上一轮的回答，从而误判对话进展。</li>
 * <li><b>成本</b>：每次挂起沉淀一条，往后每轮全量重发。</li>
 * </ul>
 *
 * <p><b>为什么是「读时过滤」而不是「不落盘」</b>：这条消息是前端历史气泡的唯一数据源
 * （实测落在会话的 {@code <sid>.messages.ndjson} 中）。删掉它，用户回看历史时会看到问答卡凭空出现、
 * 前后文断裂。故保留落盘、只在组装出站消息时剔除——展示与协议两个关切各自得到满足。</p>
 *
 * <p><b>双重判定</b>：新数据带 {@link AgentTrace#META_PENDING_NOTICE} 标记，精确且不误伤；
 * 标记引入前落盘的历史数据没有标记，退化为按文案匹配兜底（见 {@link #isLegacyPendingText}）。
 * 文案兜底只认「整条消息正文恰好等于挂起文案」，不做包含匹配——模型正文里引用这句话的场景必须放行。</p>
 *
 * @author oisin
 * @since 3.9.1
 */
public class PendingNoticeFilter {

    /**
     * 历史兜底文案：标记引入前落盘的挂起消息没有 metadata，只能按正文识别。
     *
     * <p>{@code ask_user} 用固定常量，故可精确枚举；HITL 的文案由审批策略动态产出
     * （{@code HITLSensitiveStrategy} 的默认值只是其中之一），无法穷举——这是兜底路径的已知边界：
     * 自定义策略文案的历史数据仍会漏网，但新数据一律带标记，不受影响。</p>
     */
    private static final String[] LEGACY_PENDING_TEXTS = {
            AskUser.PENDING_REASON,
            "敏感操作，需要人工介入确认"
    };

    /**
     * 剔除工作记忆中的挂起通知消息。
     *
     * <p>无命中时返回入参本身（不复制），保证健康流程零开销。</p>
     *
     * @param messages 待组装的消息列表
     * @return 过滤后的列表；无命中时为入参原对象
     */
    public static List<ChatMessage> filter(List<ChatMessage> messages) {
        if (Assert.isEmpty(messages)) {
            return messages;
        }

        int hit = 0;
        for (ChatMessage message : messages) {
            if (isPendingNotice(message)) {
                hit++;
            }
        }

        if (hit == 0) {
            return messages;
        }

        List<ChatMessage> kept = new ArrayList<>(messages.size() - hit);
        for (ChatMessage message : messages) {
            if (!isPendingNotice(message)) {
                kept.add(message);
            }
        }
        return kept;
    }

    /**
     * 判定是否为挂起通知消息。
     *
     * <p>只认「纯文本 assistant」：带 {@code toolCalls} 的消息是真实的工具调用声明，剔除它会破坏
     * 「调用 ↔ 结果」配对并触发供应商的另一种 400，任何情况下都不得命中。</p>
     */
    public static boolean isPendingNotice(ChatMessage message) {
        if (message instanceof AssistantMessage == false) {
            return false;
        }

        AssistantMessage assistant = (AssistantMessage) message;
        if (Assert.isNotEmpty(assistant.getToolCalls())) {
            return false;
        }

        if (assistant.hasMetadata(AgentTrace.META_PENDING_NOTICE)) {
            return true;
        }

        return isLegacyPendingText(assistant.getText());
    }

    /**
     * 历史数据兜底：正文恰好等于某条已知挂起文案（去除首尾空白后全等，不做包含匹配）。
     */
    private static boolean isLegacyPendingText(String text) {
        if (Assert.isEmpty(text)) {
            return false;
        }

        String trimmed = text.trim();
        for (String legacy : LEGACY_PENDING_TEXTS) {
            if (legacy.equals(trimmed)) {
                return true;
            }
        }
        return false;
    }
}
