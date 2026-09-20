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
import com.gourdai.agent.event.ReasonEndEvent;
import com.gourdai.ai.chat.message.AssistantMessage;
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
        if (message == null) {
            return "";
        }

        // 4.1.1：hasContent()/getContent() 只看 text 通道。而思考帧的 text 恒为空、
        // 内容在 thinking 通道，若沿用 hasContent() 守卫会把思考帧当成空消息直接
        // 返回空串，下游的思考展示与去重全部失效。故这里按「哪个通道有值」取文本：
        // 纯思考消息取 thinking，其余（含混合态）取 text。
        String content = message.isThinkingOnly() ? message.getThinking() : message.getText();
        if (Assert.isEmpty(content)) {
            return "";
        }

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
     * 获取聚合响应的纯净正文（双通道优先，对齐上游 4.1）。
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

    /** 思考重放判定的最小帧长：低于此长度一律按真实增量放行，不干扰 token 级流式体验。 */
    private static final int THINKING_REPLAY_MIN_LEN = 16;

    /** 「中段重放」判定所需的更严帧长门限（该分支误杀风险高于后缀分支，故门限加倍再翻倍）。 */
    private static final int THINKING_REPLAY_CONTAINS_MIN_LEN = 64;

    /**
     * 判定「思考终态重放帧」：本帧文本是否只是已累积思考的重复投影。
     *
     * <p><b>背景</b>：部分方言在流末尾会做「补齐未交付内容」的兜底。以 {@code openai-responses}
     * 为例，{@code response.completed} 用最终快照与「已交付 delta」做差集补发，其幂等键是
     * {@code item_id + content_index/summary_index}；经中转（网关/代理）后，若 delta 事件的
     * item_id 或索引与终态 output item 对不上，差集判定查不到任何已交付记录，于是把
     * <strong>整段思考</strong>当成「未交付」再发一次。该补发走 {@code acc.addContentItem(...)}，
     * 由上层自动派生成一枚与真实增量完全同形的 {@code THINKING_DELTA} 事件（<b>不携带任何终态
     * 标记</b>），故只能靠文本比对识别。</p>
     *
     * <p>不加防御的后果：所有订阅方（Web / CLI / ACP / Desktop）都会把同一段思考输出两遍；
     * Web 端因工具草稿帧已收敛思考块，表现为屏幕上出现第二个「思考完成」卡片。</p>
     *
     * <p><b>判定分级</b>（原则：宁漏杀不误杀，短帧一律放行）：
     * <ol>
     *   <li>帧长 &lt; {@value #THINKING_REPLAY_MIN_LEN} 视为真实增量（逐 token 分片、方言的
     *       {@code </think>} 标签帧都落在这里）；</li>
     *   <li>本帧是已累积思考的<b>完整后缀</b>（偏移为 0 时即「与全文严格相等」，也就是整段
     *       重放这一最典型形态）→ 判为重放；</li>
     *   <li>帧长 &ge; {@value #THINKING_REPLAY_CONTAINS_MIN_LEN} 且整体出现在已累积思考的
     *       <b>中间</b>→ 判为重放（多 reasoning item 逐个补发时，先补发的那段不在尾部）。</li>
     * </ol>
     * 已知固有代价：模型真的连续吐出两段完全相同的长文本时会被判为重放。</p>
     *
     * @param accumulated 本次响应内已累积（即已下发）的思考投影，可为 null
     * @param text        本帧思考文本，可为 null
     * @return true 表示应跳过下发与累积
     */
    public static boolean isThinkingReplay(StringBuilder accumulated, String text) {
        if (accumulated == null || text == null) {
            return false;
        }

        int len = text.length();
        int accLen = accumulated.length();
        if (len < THINKING_REPLAY_MIN_LEN || accLen < len) {
            return false;
        }

        if (regionMatches(accumulated, accLen - len, text)) {
            return true;
        }

        return len >= THINKING_REPLAY_CONTAINS_MIN_LEN && accumulated.indexOf(text) >= 0;
    }

    /**
     * 比对 buf 从 offset 起是否与 text 逐字相等。
     *
     * <p>不走 {@code buf.toString().endsWith(text)}：思考全文可达数十 KB，而本方法在
     * <b>每一个思考帧</b>上都会被调用，整串拷贝会带来与帧数成正比的无谓分配。</p>
     */
    private static boolean regionMatches(StringBuilder buf, int offset, String text) {
        for (int i = 0; i < text.length(); i++) {
            if (buf.charAt(offset + i) != text.charAt(i)) {
                return false;
            }
        }

        return true;
    }

    /**
     * 只有真实 thinking 通道或文本 ReAct 的 Thought 段才可作为思考展示。
     *
     * <p>Native tool 的普通正文回退值不能重复渲染成思考：{@code ReasonTask.extractThought}
     * 在原生工具模式下会把整段正文当作思考回退值返回，此时 {@code ReasonEndEvent.getThinking()}
     * 与 {@code getText()} 装着同一份正文。消费端若无此护栏，会把同一段正文同时灌进思考通道与
     * 正文通道（同文三帧/重复记录），故补发门禁与各端补发逻辑都必须先过这道判定。</p>
     *
     * <p>单点收敛到本方法：Web 流构建器（主代理补发）与 TaskTalent 子代理门禁共用同一判定，
     * 防止两处语义漂移。</p>
     *
     * @since 4.1
     */
    public static boolean isDisplayableThinking(ReasonEndEvent event) {
        if (event == null || !event.hasThinking() || event.getAssistantMessage() == null) {
            return false;
        }
        if (event.getAssistantMessage().isThinkingOnly()) {
            return true;
        }
        String content = event.getAssistantMessage().getContent();
        return content != null && content.contains("Thought:");
    }

    /**
     * 折叠聚合思考里的「终态重放」副本，返回思考与真实增量同形的助手消息。
     *
     * <p><b>为何流式抑制还不够</b>：{@link #isThinkingReplay} 只拦住了下发通道，而方言
     * 补发走的是 {@code acc.addContentItem(...)}，该路径同时把整段思考灌进
     * {@code ChatAccumulator.thinkingBuilder}。于是屏幕上不重复了，聚合消息的
     * {@code thinking} 却仍是重复的。</p>
     *
     * <p><b>重复份数取决于命中哪条补发路径</b>（二者都要覆盖）：
     * <ul>
     *   <li>{@code appendStreamFinalText}（分部 {@code *.done} 事件）只调
     *       {@code addContentItem}，叠加上层 {@code publishItem} 的聚合 → 锚 + 1 份；</li>
     *   <li>{@code appendFinalOutput}（{@code response.completed}）自己先
     *       {@code appendThinking} 再 {@code addContentItem} → 锚 + 2 份。</li>
     * </ul>
     * 故折叠必须能处理 N 份（N ≥ 1）：单次比对在 N ≥ 2 时会因「尾巴比锚长」判定为含新
     * 内容而<b>静默失效</b>，须先迭代剥离整份副本。</p>
     *
     * <p><b>不治的后果</b>：该聚合消息被<b>原对象</b>写进工作记忆，下一轮全量重发。
     * <ul>
     *   <li><b>上下文压缩预算失真</b>（最普遍）：压缩器估算体积走 {@code getContent()}，
     *       而工具调用轮聚合正文为空使 {@code isThinking} 为 true，该方法转而返回思考
     *       文本 —— 重复份额全额计入，令压缩比预期更早触发；</li>
     *   <li><b>落盘放大</b>：重复思考被写进会话历史 NDJSON；</li>
     *   <li><b>出站浪费（仅边缘情形）</b>：{@code OpenaiResponsesRequestBuilder} 优先回放
     *       {@code responses_output_items} 里的原始 output item（含 reasoning，且为 API
     *       快照的单份），此时 {@code getThinking()} 根本不参与出站；只有当该 metadata 与
     *       {@code reasoning_item_id} / {@code encrypted_content} <b>同时</b>缺失、退化到
     *       {@code reasoning_text} 兜底分支时，重复份额才会真正上到 wire。</li>
     * </ul></p>
     *
     * <p><b>锚为何可靠</b>：上游 {@code ChatRequestDescDefault#publishItem} 中
     * {@code acc.appendThinking(acm.getThinkingRaw())} 与
     * {@code THINKING_DELTA.text(acm.getThinkingRaw())} 取的是<b>同一个字符串</b>，故
     * 「流式累积（已抑制重放）」与「聚合思考」逐字同源，二者之差恰好等于被抑制掉的帧。
     * 据此仅在下列条件<b>全部</b>成立时才动手，任一不满足即原样返回（宁可不治，绝不误删）：
     * <ol>
     *   <li>锚非空——即确有流式思考；非流式路径无锚，不适用；</li>
     *   <li>聚合思考严格以锚为前缀且比锚更长——证明同源，且中间没混入别的内容；</li>
     *   <li>尾部整份副本（与锚逐字相等）被迭代剥离，剥离只删除与已保留前缀完全重复的
     *       字节，不会丢失任何独有内容；</li>
     *   <li>剥完后的残尾再经 {@link #isThinkingReplay} 判定为重放才整体折叠——与抑制侧
     *       同一把尺，零新增判定面。残尾比锚更长时该判定必然为 false，故「补发含从未
     *       下发过的思考」不会被误删。</li>
     * </ol></p>
     *
     * <p><b>重建而非原地改</b>：{@code thinking} 字段无 setter。重建须逐字段搬运原对象，
     * 其中 {@code metadata} 必须保真——{@code reasoning_item_id} 一旦丢失，出站会从
     * 「只回引用」退化为「回传整段思考」，反而更烧 token。</p>
     *
     * <p>已知取舍：重建对象的 {@code createdAt} 刷新为当前时刻（基类无 setter），与原值
     * 相差毫秒级，不影响消息序。</p>
     *
     * @param message             聚合响应消息，可为 null
     * @param streamedThinkingRaw 流式累积的原始思考（未经前缀规范化），可为 null/空
     * @return 归一后的新消息；不满足归一条件时原样返回入参
     */
    public static AssistantMessage dedupeAggregatedThinking(AssistantMessage message, String streamedThinkingRaw) {
        if (message == null || Assert.isEmpty(streamedThinkingRaw)) {
            return message;
        }

        String aggregated = message.getThinkingRaw();

        // getTextRaw() 为 null 表示旧形态消息（思考内嵌在废弃的 content 字段里），
        // 该字段无法经构造器还原，重建必丢正文，故一律不动。
        if (aggregated == null || message.getTextRaw() == null) {
            return message;
        }

        int anchorLen = streamedThinkingRaw.length();
        if (aggregated.length() <= anchorLen || !aggregated.startsWith(streamedThinkingRaw)) {
            return message;
        }

        // 先迭代剥离尾部的「整份副本」：命中 appendFinalOutput 路径时聚合值是锚 × 3，
        // 此时尾巴比锚长，isThinkingReplay 必判 false，不先剥离就会静默失效。
        String folded = foldTrailingAnchorCopies(aggregated, streamedThinkingRaw);

        // 残尾再过一次抑制侧的同款尺子，覆盖「非整份的后缀 / 中段重放」
        if (folded.length() > anchorLen
                && isThinkingReplay(new StringBuilder(streamedThinkingRaw), folded.substring(anchorLen))) {
            folded = streamedThinkingRaw;
        }

        if (folded.length() == aggregated.length()) {
            return message;
        }

        return rebuildWithThinking(message, folded);
    }

    /**
     * 迭代剥掉尾部「与锚逐字相等」的整份副本，返回折叠后的前缀。
     *
     * <p><b>为何必须保底留一份锚长</b>：自相似文本（极端如整段同一字符）下，
     * 末尾 anchorLen 个字符可能恰好与锚相等但并非真副本；若无条件回退，会把锚
     * 本身也削掉，反而造成数据丢失。要求剥离后至少还留下一整份锚，即可保证：
     * 剥掉的字节在已保留前缀里完全存在。</p>
     *
     * <p>用 {@code startsWith(anchor, offset)} 而非 {@code substring().equals()}：
     * 思考全文可达数十 KB，逐次截串会带来与副本数成正比的无谓分配。</p>
     */
    private static String foldTrailingAnchorCopies(String aggregated, String anchor) {
        int anchorLen = anchor.length();
        int end = aggregated.length();

        while (end - anchorLen >= anchorLen && aggregated.startsWith(anchor, end - anchorLen)) {
            end -= anchorLen;
        }

        return end == aggregated.length() ? aggregated : aggregated.substring(0, end);
    }

    /**
     * 以新的思考文本重建助手消息，其余字段逐一搬运。
     *
     * <p>4.1.1 起改用 {@code snapshot()} 工厂：原来的多参 raw 构造器（含 isThinking
     * 布尔位与 contentRaw）已移除。snapshot 能完整搬运 searchResults / citations /
     * protocolStates / metadata，比旧构造器覆盖面更广——protocolStates 承载着
     * Responses 协议的 reasoning 回放数据，丢失会直接导致多轮思考回传失败。</p>
     *
     * <p>{@code reasoningFieldName} 在 4.1.1 已无 setter（仅存 @Deprecated getter），
     * 该语义现由方言层自行决定，故不再搬运。</p>
     */
    private static AssistantMessage rebuildWithThinking(AssistantMessage source, String thinking) {
        AssistantMessage rebuilt = AssistantMessage.snapshot(
                source.getTextRaw(),
                thinking,
                source.getToolCalls(),
                source.getBlocks(),
                source.getSearchResults(),
                source.getCitations(),
                source.getProtocolStates());

        rebuilt.addMetadata(source.getMetadata());

        return rebuilt;
    }
}
