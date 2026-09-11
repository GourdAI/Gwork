package com.gourdai.agent.util;

import com.gourdai.agent.event.AgentEvent;

import org.noear.solon.ai.chat.event.ChatEvent;
import org.noear.solon.ai.chat.event.ChatEventType;
import org.noear.solon.ai.chat.message.AssistantMessage;

/**
 * Solon AI 4.1 ChatEvent 适配工具。
 *
 * <p>底层模型流从 4.1 起以 ChatEvent 为唯一订阅面；项目内部 AgentEvent
 * 仍然保持原有 AssistantMessage 契约，因此事件到内部块的投影集中在这里，
 * 避免 Web、CLI、ACP、Desktop 各自解释事件而产生分歧。</p>
 */
public final class ChatEventSupport {
    private ChatEventSupport() {
    }

    /**
     * 将可见增量事件投影为现有 AgentEvent 使用的助手消息。
     *
     * <p>只认正文与思考增量：终态帧（RESPONSE_END）由调用方单独取聚合响应，
     * 工具调用帧由 Agent 自身的 Action/Observation 生命周期表达。</p>
     *
     * <p>必须以 {@code event.getText()} 构造「当前分片」消息，不能使用
     * {@code event.getMessage()}：后者在终态帧上是<strong>累计聚合</strong>，
     * 直接下发会让 Web/CLI/Desktop 把全文重复追加一遍。</p>
     *
     * @return 增量消息；非可见增量事件返回 null
     */
    public static AssistantMessage message(ChatEvent event) {
        if (event == null) {
            return null;
        }

        if (event.is(ChatEventType.THINKING_DELTA)) {
            return new AssistantMessage("", event.getTextOrEmpty(), true);
        }

        if (event.is(ChatEventType.TEXT_DELTA)) {
            return new AssistantMessage(event.getTextOrEmpty(), "", false);
        }

        return null;
    }
}
