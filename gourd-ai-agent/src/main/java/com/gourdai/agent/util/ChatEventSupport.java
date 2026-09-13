package com.gourdai.agent.util;

import com.gourdai.agent.event.AgentEvent;

import org.noear.solon.ai.chat.event.ChatEvent;
import org.noear.solon.ai.chat.event.ChatEventType;
import org.noear.solon.ai.chat.message.AssistantMessage;
import org.noear.solon.ai.chat.tool.ToolCall;
import org.noear.solon.lang.Nullable;

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

    /**
     * 工具调用分片的稳定聚合键。
     *
     * <p>口径必须与上游 {@code ChatRequestDescDefault#emitItemEvents} 保持一致：
     * <b>index 优先、id 兜底</b>。原因是分片式工具调用协议（OpenAI 系）只在首片携带 id，
     * 后续分片的 id 会退化为 null，只有 {@code index} 全程稳定；并行工具调用若按 id 归并
     * 会串号。</p>
     *
     * @return 聚合键；无工具调用负载时返回 null
     */
    public static @Nullable String toolCallKey(ChatEvent event) {
        ToolCall call = toolCall(event);
        if (call == null) {
            return null;
        }

        return call.getIndex() == null ? call.getId() : call.getIndex();
    }

    /**
     * 取工具调用负载。
     *
     * @return ToolCall；非工具调用事件返回 null
     */
    public static @Nullable ToolCall toolCall(ChatEvent event) {
        return event == null ? null : event.getToolCall();
    }

    /**
     * 本帧参数增量的字符长度。
     *
     * <p>{@code TOOL_CALL_ARGS_DELTA} 的 text 是<b>当帧增量片段</b>（非累计值），
     * 故可直接累加。调用方据此维护累计字节数。</p>
     */
    public static int argsDeltaLength(ChatEvent event) {
        if (event == null) {
            return 0;
        }

        String text = event.getText();
        return text == null ? 0 : text.length();
    }
}
