/*
 * Copyright 2017-2025 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.ai.chat.message;

import com.gourdai.ai.chat.ChatRole;

import java.util.List;

/**
 * 历史思考回放窗口：只有<b>最后一条 user 消息之后</b>的 assistant 思考需要回放。
 *
 * <p><b>为什么不是「全量回放」也不是「一律剥离」</b>——两端都会出事故：</p>
 * <ul>
 *   <li><b>全量回放</b>（本类引入前 ollama / openai-chat 的行为）：每轮把历史各轮思考
 *       重新上行。思考明文通常是可见正文的数十倍，逐轮累加即上下文膨胀
 *       （Responses 协议同源缺陷实测占单轮上行 token 的 71.74%）。</li>
 *   <li><b>一律剥离</b>：DeepSeek thinking 模式下，带 {@code tool_calls} 的 assistant 消息
 *       回放时若缺少 {@code reasoning_content}，服务端直接 400
 *       「The reasoning_content in the thinking mode must be passed back to the API」，
 *       且该消息已在历史里，每次重试都精确复现——会话就此死锁。
 *       交错思考型模型（MiniMax M2 / GLM / Kimi）丢弃当轮思考还会显著掉点。</li>
 * </ul>
 *
 * <p><b>窗口口径</b>：跨 user 轮边界剥离、轮内保留。这既满足 DeepSeek 的硬要求
 * （它只要求「本轮」工具循环里的 assistant 消息带思考），又与 Ollama / Qwen3 官方模板
 * 的既有行为一致（模板自身只向模型展示最近一条 user 之后的思考），
 * 因此对这些目标而言本窗口不改变模型可见输入，纯粹省掉白传的字节。</p>
 *
 * <h3>与上下文压缩的关系（重要）</h3>
 * <p>本窗口<b>只作用于出站序列化</b>，不修改 {@code WorkingMemory} 里的任何消息对象，
 * 也不触碰消息 metadata。这一点是刻意的：</p>
 * <ul>
 *   <li>{@code ContextCompressionInterceptor.estimateTokens} 经由
 *       {@code ChatMessage.getContent()} 估算，而 {@code AssistantMessage.getContent()}
 *       返回的是 {@code getText()}（<b>不含 thinking</b>）——即压缩器的估算口径里
 *       从来就没有思考明文。故本窗口使实际出站字节<b>向估算口径收敛</b>，
 *       压缩判据只会更准，不会失真。</li>
 *   <li>不写 {@code META_TOKEN_SIZE}、不重建消息对象，故不会使压缩器的
 *       per-message token 缓存失效，也不会与其 {@code lastToolCallGroupStart}
 *       轮边界保护、{@code META_SWEPT} 幂等标记产生任何交互。</li>
 *   <li>压缩器清理的是 {@code ToolMessage} 内容，与 assistant 思考正交；
 *       两者作用对象不重叠，不存在「压缩后窗口误判」或「窗口后压缩重算」的耦合。</li>
 * </ul>
 *
 * @author noear
 * @since 4.1.1
 */
public final class ThinkingReplayWindow {
    private ThinkingReplayWindow() {
    }

    /**
     * 求最后一条 user 消息的下标；不存在则返回 -1（此时整个会话都属当前轮）。
     */
    public static int lastUserIndex(List<ChatMessage> messages) {
        if (messages == null || messages.isEmpty()) {
            return -1;
        }
        for (int i = messages.size() - 1; i >= 0; i--) {
            ChatMessage message = messages.get(i);
            if (message != null && message.getRole() == ChatRole.USER) {
                return i;
            }
        }
        return -1;
    }

    /**
     * 判定下标 {@code index} 处的消息是否处于「思考保留窗口」。
     *
     * <p>没有任何 user 消息时一律视为窗口内：这类调用（如纯 system + assistant 预填）
     * 没有轮边界可言，保守保留思考，避免误剥引发 DeepSeek 400。</p>
     */
    public static boolean isWithinCurrentTurn(List<ChatMessage> messages, int index) {
        int size = messages == null ? 0 : messages.size();
        return isWithinCurrentTurn(lastUserIndex(messages), index, size);
    }

    /**
     * 给定已算好的最后 user 下标，判定是否在窗口内（循环内复用，避免 O(n²)）。
     *
     * <p><b>两个条件取并集</b>，与 Qwen3 / Ollama 官方模板的
     * {@code (or $last (gt $i $lastUserIdx))} 逐字对齐：</p>
     * <ul>
     *   <li>{@code index > lastUserIndex}：最后一条 user 之后的当轮消息；</li>
     *   <li>{@code index == size - 1}：<b>末条消息无论位置都保留</b>。
     *       遗漏这一半会误剥 assistant prefill（末条是 assistant 且在 user 之前的形态）。</li>
     * </ul>
     */
    public static boolean isWithinCurrentTurn(int lastUserIndex, int index, int size) {
        return index > lastUserIndex || index == size - 1;
    }
}
