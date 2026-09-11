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
package com.gourdai.agent.util;

import org.noear.snack4.ONode;
import com.gourdai.agent.Agent;
import com.gourdai.agent.AgentProfile;
import org.noear.solon.ai.chat.message.AssistantMessage;
import org.noear.solon.core.util.Assert;
import org.noear.solon.flow.FlowContext;

import java.util.Map;

/**
 * 智能体辅助工具类
 *
 * @author oisin
 * @since 3.9.0
 */
public class AgentUtil {
    public static ONode toMetadataNode(Agent<?, ?> agent, FlowContext context) {
        ONode node = new ONode().asObject();

        node.set("name", agent.name());

        if (Assert.isNotEmpty(agent.role())) {
            node.set("role", agent.roleFor(context));
        }

        AgentProfile profile = agent.profile();

        if (profile != null) {
            if (Assert.isNotEmpty(profile.getCapabilities())) {
                node.getOrNew("capabilities").addAll(profile.getCapabilities());
            }

            if (Assert.isNotEmpty(profile.getInputModes())) {
                node.getOrNew("inputModes").addAll(profile.getInputModes());
            }
        }

        return node;
    }

    /**
     * 从工具参数表安全取字符串参数。
     *
     * <p>模型输出的参数不保证为字符串（可能是数组/对象等任意 JSON 结构），
     * 渲染层不得直接强转；非字符串值退化为 {@link String#valueOf(Object)}，确保不抛异常。</p>
     *
     * @param args 参数表（可为 null）
     * @param key  参数名
     * @return 字符串值；缺失时为 null
     */
    public static String asStringArg(Map<String, Object> args, String key) {
        if (args == null) {
            return null;
        }

        Object val = args.get(key);

        if (val == null) {
            return null;
        }

        return (val instanceof String) ? (String) val : String.valueOf(val);
    }

    /**
     * 获取剥离「混入正文的推理文本」后的纯净正文。
     *
     * <p>部分方言（如 openai-responses）流式聚合时，thinking 帧的 delta 同时进入
     * content 聚合器，导致 content 里出现「推理 + 正文」拼接；而推理本身已由
     * thinking 通道单独展示，下游（最终答案、历史消息、IM 转发）若再渲染该串
     * 即出现重复文本。</p>
     *
     * @param message 助手消息（可为 null）
     * @return 纯净正文；message 为 null 或无内容时为空串
     */
    public static String getResultContentWithoutReasoning(AssistantMessage message) {
        return getResultContentWithoutReasoning(message, null);
    }

    /**
     * 获取剥离「混入正文的推理文本」后的纯净正文（带流式思考前缀的精确剥离）。
     *
     * <p><b>背景</b>：各方言（anthropic / chat / responses / gemini）把思考以
     * {@code <think>推理</think>} 标签投影进聚合 content。若推理文本内部引用了
     * {@code </think>} 字面量（如讨论思考标签机制本身），仅凭标签 indexOf 无法
     * 区分「推理内的字面量」与「真正的闭标签」，首个匹配切错位置会导致推理中段
     * 泄漏进正文（2026-08-19 线上事故：主消息渲染大段英文思考）。</p>
     *
     * <p><b>精确剥离</b>：流式阶段逐帧累积 thinking 帧的 content（含方言的
     * {@code <think>}/{@code </think>} 标签帧），其拼接结果必然是聚合 content 的
     * 前缀（聚合器按帧序拼接）。以前缀做整串匹配即可无歧义定位正文起点。</p>
     *
     * <p>前缀不可用（非流式、上游行为变化、累积不完整）时退回启发式：仅当 content
     * 以真实投影开标签 {@code <think>} 开头才剥首个 {@code </think>} 之后的内容。</p>
     *
     * @param message 助手消息（可为 null）
     * @param streamedReasoningPrefix 流式累积的思考前缀（含标签帧拼接，可为 null/空）
     * @return 纯净正文；message 为 null 或无内容时为空串
     */
    public static String getResultContentWithoutReasoning(AssistantMessage message, String streamedReasoningPrefix) {
        if (message == null || !message.hasContent()) {
            return "";
        }

        String content = message.getContent();

        // 1) 精确前缀剥离：前缀由流式帧序拼接而来，与聚合 content 前缀严格相等时无标签歧义
        if (Assert.isNotEmpty(streamedReasoningPrefix)
                && content.startsWith(streamedReasoningPrefix)) {
            // 前缀与 content 完全相等：纯思考无正文（思考后被截断/仅思考即调工具）
            return content.substring(streamedReasoningPrefix.length());
        }

        // 2) 降级启发式（无流式前缀可用时）：仅认真实投影开标签，绝不误切正文
        if (content.startsWith("<think>")) {
            int end = content.indexOf("</think>");
            if (end > -1) {
                return content.substring(end + "</think>".length());
            }
            // 开标签未闭合：纯思考（或被截断的流），无正文可取
            return "";
        }

        return content;
    }

    /**
     * 获取聚合响应的纯净正文（Solon AI 4.1 双通道优先）。
     *
     * <p><b>4.1 变更</b>：{@code AssistantMessage} 拆成 {@code text} / {@code thinking}
     * 两个独立通道，方言侧已在 {@code AbstractChatDialect} 的状态机里剥掉
     * {@code <think>} 标签并分流，聚合消息不再出现「推理 + 正文」拼接。因此只要
     * 本条消息确实带思考通道，正文就应直接取 {@code text}，无需任何标签启发式。</p>
     *
     * <p><b>为何不能沿用 getContent()</b>：4.1 的 {@code getContent()} 在
     * {@code text} 为空、{@code thinking} 非空时会<strong>返回思考文本</strong>
     * （纯推理轮：思考完直接调工具）。若继续按 content 取正文，这一轮的思考会被
     * 当成最终答案外发，造成思考泄漏。</p>
     *
     * <p>不具备双通道信息（旧持久化消息、非流式方言只给 content）时退回
     * {@link #getResultContentWithoutReasoning(AssistantMessage, String)} 的标签启发式。</p>
     *
     * @param message 助手消息（可为 null）
     * @param streamedReasoningPrefix 流式累积的思考前缀（仅退化路径使用，可为 null/空）
     * @return 纯净正文；无正文时为空串
     */
    public static String getAggregatedResultContent(AssistantMessage message, String streamedReasoningPrefix) {
        if (message == null) {
            return "";
        }

        // 4.1 双通道：thinking 非空即证明方言已分流，text 就是纯正文（可能为空串＝纯推理轮）
        String textRaw = message.getTextRaw();
        if (textRaw != null && Assert.isNotEmpty(message.getThinkingRaw())) {
            return textRaw;
        }

        return getResultContentWithoutReasoning(message, streamedReasoningPrefix);
    }

    /**
     * 规范化流式累积的思考前缀：截掉「最后一个思考帧」内首个 {@code </think>} 之后的内容。
     *
     * <p><b>背景</b>：chat 方言的 inline-think 路径（无独立推理字段，模型在 content 里内联
     * {@code <think>...</think>}，如 Qwen）在闭标签帧 {@code new AssistantMessage(content, true)}
     * 中<strong>同时携带正文开头</strong>（content = {@code "</think>" + 正文头}）且 thinking=true。
     * 若不截断，正文头会被并入前缀，剥离时正文头部丢失。</p>
     *
     * <p>其余方言（anthropic / chat-reasoning_field / openai-responses / gemini）的末思考帧
     * 均为纯 {@code </think>} 标签帧，本截断对它们是 no-op。</p>
     *
     * <p>只处理最后一个思考帧：更早思考帧中的 {@code </think>} 可能是思考文本内部引用的
     * 字面量（如讨论思考标签机制本身），截断会破坏前缀与聚合 content 的严格相等性。</p>
     *
     * @param rawPrefix 流式累积的思考前缀（可为 null/空）
     * @param lastThinkingFrameStart 最后一个思考帧内容在前缀中的起始偏移（未知传 -1）
     * @return 规范化后的前缀；无帧信息或无需截断时原样返回
     */
    public static String normalizeStreamedReasoningPrefix(String rawPrefix, int lastThinkingFrameStart) {
        if (Assert.isEmpty(rawPrefix) || lastThinkingFrameStart < 0 || lastThinkingFrameStart >= rawPrefix.length()) {
            return rawPrefix;
        }

        String lastFrame = rawPrefix.substring(lastThinkingFrameStart);
        int cut = lastFrame.indexOf("</think>");
        if (cut < 0) {
            return rawPrefix;
        }

        return rawPrefix.substring(0, lastThinkingFrameStart + cut + "</think>".length());
    }
}
