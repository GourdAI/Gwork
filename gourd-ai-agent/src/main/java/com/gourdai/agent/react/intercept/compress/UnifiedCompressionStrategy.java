/*
 * Copyright 2017-2025 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.agent.react.intercept.compress;

import com.gourdai.agent.AgentTrace;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.intercept.CompressionStrategy;
import com.gourdai.agent.react.intercept.ContextCompressionInterceptor;
import org.noear.solon.ai.chat.ChatModel;
import org.noear.solon.ai.chat.ChatResponse;
import org.noear.solon.ai.chat.message.AssistantMessage;
import org.noear.solon.ai.chat.message.ChatMessage;
import org.noear.solon.ai.chat.message.ToolMessage;
import org.noear.solon.ai.chat.message.UserMessage;
import org.noear.solon.ai.util.RetryUtil;
import org.noear.solon.core.util.Assert;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

/**
 * 统一压缩策略（单次 LLM 调用完成「关键信息提取 + 滚动摘要」）。
 *
 * <p><b>为什么要合并</b>：此前默认装配是
 * {@code Composite(KeyInfoExtraction + Hierarchical)}，两个子策略各自把
 * <b>同一段过期历史</b>序列化后独立发给 LLM 一次 —— 输入 token 翻倍、调用次数翻倍，
 * 而它们的职责（提取事实 / 滚动摘要）完全可以在一个 prompt 里用两个 section 完成。
 * 合并后：摘要调用 2 → 1，摘要输入 token ≈ −50%。</p>
 *
 * <p><b>防意图漂移</b>：prompt 要求模型完整保留<b>全部</b>用户意图（而非只保留最初那个），
 * 并对最近的请求做逐字引用。这解决了长会话中「用户目标已经变了，但摘要还围着老目标转」的问题。</p>
 *
 * <p>沿用 {@link HierarchicalCompressionStrategy} 的滚动机制：上一次的摘要结果存放在
 * trace extra 中，本次将其与新过期历史合并，保证记忆链条不断裂。</p>
 *
 * @author oisin
 * @since 4.0.0
 */
public class UnifiedCompressionStrategy implements CompressionStrategy {
    private static final Logger log = LoggerFactory.getLogger(UnifiedCompressionStrategy.class);

    private static final String SUMMARY_PREFIX = "--- [上下文压缩摘要] ---";
    /** 与 Hierarchical 共用同一 key，便于两种策略互换时摘要链不断裂 */
    private static final String STRATEGY_LASTSUMMARY_KEY = "agent:summary:hierarchical";

    /** 单条工具结果参与摘要时的截断长度（字符） */
    private static final int TOOL_CONTENT_CAP = 2000;

    private String systemInstruction = "## 角色定义\n" +
            "你是一个精密的上下文压缩专家。你的任务是把 Agent 的执行历史压缩成结构化摘要，\n" +
            "使得后续推理即使看不到原始历史，也能准确无误地继续工作。\n\n" +
            "## 输出格式（严格按以下四段输出，段落标题必须保留）\n" +
            "### 全部用户意图\n" +
            "按时间顺序列出用户提出过的**所有**请求与目标，不要只保留最初那个。\n" +
            "用户的目标会随对话演进，请标注每项的状态（已完成 / 进行中 / 已放弃）。\n\n" +
            "### 已确认的关键信息\n" +
            "1. **业务参数**：特定 ID、路径、数值、时间、偏好或硬性约束。\n" +
            "2. **确定性事实**：通过工具调用已证实的真实状态或关键结果。\n" +
            "3. **负面路径**：已验证为无效的尝试（防止重复犯错）。\n\n" +
            "### 当前工作\n" +
            "描述正在进行的具体任务，**重点关注最近的消息**。\n\n" +
            "### 下一步\n" +
            "必须与用户**最近一次**明确请求直接对应。\n" +
            "如果最近的对话中有明确的任务指令，请**逐字引用原文**，确保任务理解不发生偏移。\n" +
            "若无明确下一步，写「（待用户指示）」。\n\n" +
            "## 核心要求\n" +
            "- 去重降噪：移除重复的思考过程、无意义的中间状态。\n" +
            "- 严禁包含推测、解释或「好的」「明白」等废话。\n" +
            "- 严禁编造历史中不存在的信息。";

    /** 压缩结果长度硬性保护（字符） */
    private int maxSummaryLength = 2000;

    public UnifiedCompressionStrategy systemInstruction(String systemInstruction) {
        this.systemInstruction = systemInstruction;
        return this;
    }

    public UnifiedCompressionStrategy maxSummaryLength(int maxSummaryLength) {
        this.maxSummaryLength = maxSummaryLength;
        return this;
    }

    @Override
    public ChatMessage compress(ChatModel chatModel, int maxRetries, ReActTrace trace, List<ChatMessage> messagesToCompress) {
        String lastSummary = trace.getExtraAs(STRATEGY_LASTSUMMARY_KEY);
        if (lastSummary == null) {
            lastSummary = "";
        }

        // 过滤初心（当前轮用户输入本就完整保留在窗口内），只压缩中间增量
        List<ChatMessage> pureExpired = (messagesToCompress == null) ? new ArrayList<>() :
                messagesToCompress.stream()
                        .filter(m -> !m.hasMetadata(AgentTrace.META_FIRST))
                        .collect(Collectors.toList());

        if (pureExpired.isEmpty()) {
            return buildMessage(lastSummary);
        }

        if (chatModel == null) {
            // 无可用模型：保持旧摘要不丢，由调用方决定是否回落到零成本裁剪
            return buildMessage(lastSummary);
        }

        try {
            String newHistoryText = renderHistory(pureExpired);
            if (Assert.isEmpty(newHistoryText)) {
                return buildMessage(lastSummary);
            }

            String userData = "### 已有摘要\n" +
                    (lastSummary.isEmpty() ? "（暂无，这是首次压缩）" : lastSummary) +
                    "\n\n" +
                    "### 新增的过期历史记录\n" +
                    newHistoryText +
                    "\n\n" +
                    focusSection(trace) +
                    "### 任务\n" +
                    "请将『已有摘要』与『新增的过期历史记录』合并，按系统指令的四段格式输出更新后的摘要：";

            String summary = RetryUtil.callWithRetry(maxRetries, () -> {
                ChatResponse resp = chatModel.prompt(userData)
                        .options(o -> {
                            o.agentName(UnifiedCompressionStrategy.class.getSimpleName());
                            o.systemPrompt(systemInstruction);
                        })
                        .call();

                if (resp.hasContent()) {
                    return resp.getContent();
                } else {
                    //触发重试
                    throw new IllegalStateException("The LLM did not return");
                }
            });

            if (Assert.isEmpty(summary)) {
                return buildMessage(lastSummary);
            }

            if (summary.length() > maxSummaryLength) {
                summary = summary.substring(0, maxSummaryLength) + "...[Truncated]";
            }

            trace.setExtra(STRATEGY_LASTSUMMARY_KEY, summary);
            return buildMessage(summary);
        } catch (Throwable e) {
            log.error("Unified compression failed", e);
            // 失败时保住上一版摘要，避免记忆链断裂
            return buildMessage(lastSummary);
        }
    }

    /**
     * 把消息渲染为紧凑的流水账文本。
     *
     * <p>用户消息完整保留（体积极小但语义权重最高，是防意图漂移的关键输入）；
     * 工具结果按 {@link #TOOL_CONTENT_CAP} 截断（体积大且细节通常可重新获取）。</p>
     */
    private String renderHistory(List<ChatMessage> messages) {
        return messages.stream()
                .map(m -> {
                    if (m instanceof AssistantMessage && Assert.isNotEmpty(((AssistantMessage) m).getToolCalls())) {
                        String names = ((AssistantMessage) m).getToolCalls().stream()
                                .map(tc -> tc.getName() == null ? "?" : tc.getName())
                                .collect(Collectors.joining(", "));
                        return "[Action]: 调用工具 " + names;
                    }
                    if (m instanceof ToolMessage) {
                        String content = m.getContent();
                        if (content != null && content.length() > TOOL_CONTENT_CAP) {
                            content = content.substring(0, TOOL_CONTENT_CAP) + "...[内容过长已截断]";
                        }
                        return "[Observation]: 得到结果 " + content;
                    }
                    if (m instanceof UserMessage) {
                        // ⭐ 用户消息全量保留：这是判断「意图是否变化」的唯一依据
                        return "[User]: " + m.getContent();
                    }
                    return m.getRole().name() + ": " + m.getContent();
                })
                .collect(Collectors.joining("\n"));
    }

    /**
     * 手动 {@code /compact <focus>} 的聚焦指令段。
     *
     * <p>用户往往比自动阈值更清楚「哪些东西该留」，把这个指令透传给摘要模型
     * 能显著提高压缩后的信息命中率。</p>
     */
    private String focusSection(ReActTrace trace) {
        try {
            Object focus = trace.getExtraAs(ContextCompressionInterceptor.COMPACT_FOCUS_KEY);
            if (focus instanceof String && !((String) focus).trim().isEmpty()) {
                return "### 用户指定的保留重点\n" +
                        ((String) focus).trim() +
                        "\n请在压缩时优先完整保留上述方向的内容。\n\n";
            }
        } catch (Exception ignore) {
            // focus 仅为增强，取不到不影响压缩
        }
        return "";
    }

    private ChatMessage buildMessage(String content) {
        if (content == null || content.isEmpty()) {
            return null;
        }
        return ChatMessage.ofUser(SUMMARY_PREFIX + "\n" + content)
                .addMetadata(ContextCompressionInterceptor.META_COMPRESSED, 1);
    }
}
