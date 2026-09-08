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
package com.gourdai.agent.react.intercept;

import com.gourdai.agent.react.intercept.compress.KeyInfoExtractionStrategy;
import com.knuddels.jtokkit.Encodings;
import com.knuddels.jtokkit.api.Encoding;
import com.knuddels.jtokkit.api.EncodingRegistry;
import com.knuddels.jtokkit.api.ModelType;
import com.gourdai.agent.AgentChunk;
import com.gourdai.agent.AgentTrace;
import com.gourdai.agent.react.ReActInterceptor;
import com.gourdai.agent.react.ReActStyle;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.intercept.compress.CompositeCompressionStrategy;
import com.gourdai.agent.react.intercept.compress.HierarchicalCompressionStrategy;
import com.gourdai.agent.react.intercept.compress.LLMCompressionStrategy;
import com.gourdai.agent.react.intercept.compress.VectorStoreCompressionStrategy;
import org.noear.solon.ai.chat.CacheControl;
import org.noear.solon.ai.chat.ChatModel;
import org.noear.solon.ai.chat.message.*;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.ai.chat.tool.ToolCall;
import org.noear.solon.core.util.Assert;
import org.noear.solon.lang.Preview;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.publisher.FluxSink;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import java.util.stream.Collectors;

/**
 * 语义保护型上下文压缩拦截器
 *
 * <p>在 Agent 推理开始前（{@code onReasonStart}），当消息数量或 Token 数超过阈值时，
 * 自动对工作记忆区进行无损（或近无损）压缩。核心目标：
 * <ul>
 *   <li><b>初心链保护</b>：标记为 {@code META_FIRST} 的消息（如 system prompt、用户原始问题）永不压缩</li>
 *   <li><b>Tool-use 原子对保护</b>：{@code Assistant(with tool_calls)} ↔ {@code ToolMessage} 的调用-结果配对不会被拆散</li>
 *   <li><b>多轮追溯保留</b>：当最后一条是 ToolMessage 时，向前追溯至完整的源头 Assistant(with tool_calls)，
 *       确保工具调用链的完整性</li>
 *   <li><b>Token 预算控制</b>：通过 {@link #estimateTokens} 精确计算消息 Token 开销，
 *       预留摘要空间后按双维度（数量+Token）确定保留窗口</li>
 * </ul>
 *
 * <p>支持四种压缩策略（通过 {@link CompressionStrategy} 注入）：
 * <ul>
 *   <li>{@code null}（默认）—— 不调用 LLM，仅执行原子对齐的纯裁剪（fallback 零成本路径）</li>
 *   <li>{@link LLMCompressionStrategy} —— LLM 生成摘要</li>
 *   <li>{@link KeyInfoExtractionStrategy} —— 关键信息提取</li>
 *   <li>{@link HierarchicalCompressionStrategy} —— 分层摘要</li>
 *   <li>{@link VectorStoreCompressionStrategy} —— 向量存储检索</li>
 *   <li>{@link CompositeCompressionStrategy} —— 组合策略</li>
 * </ul>
 *
 * @author oisin
 * @since 3.9.4
 * @since 4.0.0
 */
@Preview("3.8.2")
public class ContextCompressionInterceptor implements ReActInterceptor {
    private static final Logger log = LoggerFactory.getLogger(ContextCompressionInterceptor.class);

    public final static String META_COMPRESSED = "_compressed";

    /** 已被免费清理层清空过内容的工具结果（避免重复清理与反复计算） */
    public final static String META_SWEPT = "_swept";

    /** 意图链消息标记（避免自己又被当成用户意图递归收集） */
    public final static String META_INTENT_CHAIN = "_intent_chain";

    /** 意图链中单条意图的摘要字符数 */
    private static final int INTENT_BRIEF_CHARS = 150;

    /**
     * 上一轮模型返回的真实输入 token（含缓存）。
     * 由 {@code ContextUsageInterceptor} 在 onReasonEnd 写入，用于校准本地估算。
     * 字符串常量与该类保持一致（不直接引用以避免 agent 层反向依赖 harness 层）。
     */
    private static final String CTX_LAST_REAL_INPUT_TOKENS = "ctx:last_real_input_tokens";
    private static final String CTX_LAST_REAL_MESSAGE_COUNT = "ctx:last_real_message_count";

    /** 手动压缩的 focus 指令存放 key（与 CompactCommand 保持一致） */
    public static final String COMPACT_FOCUS_KEY = "agent:compact:focus";

    /** 跨轮累计的压缩连续失败次数（熝断用） */
    private static final String CTX_COMPACT_FAILURES = "ctx:compact_consecutive_failures";
    /** 连续失败达此次数后停止本会话的自动摘要（避免持续烧废调用） */
    private static final int MAX_CONSECUTIVE_COMPACT_FAILURES = 3;

    /** 手动压缩请求标志（/compact）的 trace key，消费后自动复位 */
    private static final String CTX_COMPACT_REQUESTED = "ctx:compact_requested";
    /** 当前上下文压力探针的 trace key */
    private static final String CTX_PRESSURE = "ctx:pressure";

    /** 待透传的 focus 指令（同 pendingCompactRequest，命令执行时 trace 尚未创建） */
    private volatile String pendingCompactFocus;

    /** 设置下一次压缩的 focus 指令（透传给摘要模型）。 */
    public void setCompactFocus(String compactFocus) {
        this.pendingCompactFocus = compactFocus;
    }

    public String getCompactFocus() {
        return pendingCompactFocus;
    }

    /**
     * 待消费的手动压缩请求。
     *
     * <p><b>为何不存 trace</b>：{@code /compact} 在<b>两轮推理之间</b>执行，此时下一轮的
     * trace 尚未创建，无处可写。故只能暂存在拦截器上，在下一轮 {@code onReasonStart}
     * 时转移并消费。该字段只在用户显式敲命令后短暂存在，且下一轮即被清除。</p>
     */
    private volatile boolean pendingCompactRequest = false;

    /**
     * 请求在下一轮推理开始时强制压缩一次（无视阈值）。
     */
    public void requestCompact() {
        this.pendingCompactRequest = true;
    }

    /** 读取并复位手动压缩请求。 */
    private boolean consumeCompactRequest(ReActTrace trace) {
        if (pendingCompactRequest) {
            pendingCompactRequest = false;
            // focus 随请求一同转移到本会话的 trace，避免被其它会话误用
            String focus = pendingCompactFocus;
            pendingCompactFocus = null;
            try {
                trace.setExtra(COMPACT_FOCUS_KEY, (focus == null || focus.isEmpty()) ? null : focus);
            } catch (Exception ignore) {
                // focus 仅为优化提示，写不进不影响压缩
            }
            return true;
        }
        try {
            Object v = trace.getExtraAs(CTX_COMPACT_REQUESTED);
            if (Boolean.TRUE.equals(v)) {
                trace.setExtra(CTX_COMPACT_REQUESTED, Boolean.FALSE);
                return true;
            }
        } catch (Exception ignore) {
            // 读不到则视为未请求
        }
        return false;
    }

    private void setContextPressure(ReActTrace trace, double pressure) {
        try {
            trace.setExtra(CTX_PRESSURE, pressure);
        } catch (Exception ignore) {
            // 探针仅用于工具预算调档，记不上回落固定上限
        }
    }

    /**
     * 读取指定会话的上下文压力（0.0~1.0），供工具输出预算动态调档。
     *
     * <p><b>为何按 trace 取</b>：本拦截器可能跨会话共享，而压力是逐轮变化的会话级状态。
     * 存实例字段会让 A 会话的 0.9 压力把 B 会话的工具输出上限误压到 8000 字符。</p>
     */
    public double getContextPressure(ReActTrace trace) {
        if (trace == null) {
            return 0.0d;
        }
        try {
            Object v = trace.getExtraAs(CTX_PRESSURE);
            return (v instanceof Number) ? ((Number) v).doubleValue() : 0.0d;
        } catch (Exception e) {
            return 0.0d;
        }
    }

    /**
     * 模型未配置 contextLength（=0）时的回退上下文窗口长度。
     *
     * <p>作为全局唯一事实源对外暴露：Web 层展示上下文占用比例时（{@code WebStreamBuilder#onContextUsageChunk}）
     * 必须复用此常量，避免「展示用默认窗口」与「压缩决策用默认窗口」两处硬编码漂移。</p>
     */
    public static final long DEFAULT_CONTEXT_LENGTH = 128_000L;

    // 在类中预加载注册表
    private static final EncodingRegistry registry = Encodings.newDefaultEncodingRegistry();
    // 适配 GPT-4o (o200k_base)，对 DeepSeek 等使用 cl100k_base 的模型有微小偏差（通常 <5%）
    private static final Encoding encoding = registry.getEncodingForModel(ModelType.GPT_4O);
    private static final String META_TOKEN_SIZE = "token_size";

    // 保留窗口的最大消息数（= 历史窗口大小 N，压缩时保护最后 N 条）
    private int maxMessages;
    // 压缩触发比例（1~100）：作为「提前触发」的上限钳制器，与绝对阈值取 min。
    // 默认 100 表示不额外提前，完全由「窗口 − 输出预留 − 回合缓冲」的绝对阈值决定。
    // ⚠️ 非线程安全，需通过 copy()/copyWith() 获取独立副本后使用，不可跨线程共享
    private int compressionRatio = 100;
    // 压缩后的目标水位比例（1~100，相对 effectiveWindow）。
    // 与触发比例解耦：触发比例决定「何时压」，目标水位决定「压到多深」。
    private int compressionTargetRatio = 45;
    // 为模型单轮输出预留的 token（绝对量，不随窗口大小线性变化）
    private int reservedOutputTokens = 20_000;
    // 当前模型无 contextLength（=0）时的回退窗口长度（可配置，默认 DEFAULT_CONTEXT_LENGTH）
    private long defaultContextLength = DEFAULT_CONTEXT_LENGTH;
    // 保留窗口的最小消息数下限（默认 maxMessages / 3，最低 3）
    // 防止 Token 维度截断导致保留窗口被压缩到只剩 1~2 条消息
    private int minReservedMessages;
    // 是否启用「会话意图链」：把历史各轮用户意图压成一条极廉价的索引块
    private boolean intentChainEnabled = true;
    // 意图链的 token 上限
    private int intentChainMaxTokens = 2_000;
    // 重试次数
    private int maxRetries = 3;
    // 压缩策略
    private CompressionStrategy compressionStrategy;
    // llm 动态提供者
    private Supplier<ChatModel> chatModelSupplier;

    public void setMaxMessages(int maxMessages) {
        this.maxMessages = Math.max(10, maxMessages);
        //同步重算保底下限（构造器按 maxMessages/3 派生），否则运行时改大历史窗口后
        //minReservedMessages 仍停在旧值，token 维度截断的保底会偏小。
        this.minReservedMessages = Math.max(3, this.maxMessages / 3);
    }

    /**
     * 设置模型未配置 contextLength 时的回退窗口长度。
     *
     * <p>非正数为无意义配置（会让压缩预算恒为 0、每轮都触发压缩），故直接拒绝并保持原值。</p>
     */
    public void setDefaultContextLength(long defaultContextLength) {
        if (defaultContextLength <= 0L) {
            throw new IllegalArgumentException("defaultContextLength must be positive");
        }
        this.defaultContextLength = defaultContextLength;
    }

    public long getDefaultContextLength() {
        return defaultContextLength;
    }

    public void setCompressionRatio(int compressionRatio) {
        this.compressionRatio = Math.min(100, Math.max(1, compressionRatio));
    }

    /**
     * 设置压缩后的目标水位比例（1~100，相对 effectiveWindow）。
     *
     * <p>决定「压到多深」。取值过高会导致单次压缩腾出的空间太少，
     * 长会话进入「压完没几轮又触发」的抖动，反复烧掉摘要调用与 prompt cache。</p>
     */
    public void setCompressionTargetRatio(int compressionTargetRatio) {
        this.compressionTargetRatio = Math.min(95, Math.max(10, compressionTargetRatio));
    }

    public int getCompressionTargetRatio() {
        return compressionTargetRatio;
    }

    /** 设置为模型单轮输出预留的 token 数（绝对量）。 */
    public void setReservedOutputTokens(int reservedOutputTokens) {
        this.reservedOutputTokens = Math.max(1_000, reservedOutputTokens);
    }

    public int getReservedOutputTokens() {
        return reservedOutputTokens;
    }

    public void setIntentChainEnabled(boolean intentChainEnabled) {
        this.intentChainEnabled = intentChainEnabled;
    }

    public boolean isIntentChainEnabled() {
        return intentChainEnabled;
    }

    public void setIntentChainMaxTokens(int intentChainMaxTokens) {
        this.intentChainMaxTokens = Math.max(200, intentChainMaxTokens);
    }

    public int getIntentChainMaxTokens() {
        return intentChainMaxTokens;
    }

    public int getMinReservedMessages() {
        return minReservedMessages;
    }

    public void setMinReservedMessages(int minReservedMessages) {
        this.minReservedMessages = Math.max(3, minReservedMessages);
    }

    public void setMaxRetries(int maxRetries) {
        this.maxRetries = maxRetries;
    }

    /**
     * 构造（默认不额外提前触发，由绝对阈值决定；默认重试 3 次）。
     */
    public ContextCompressionInterceptor(int maxMessages, Supplier<ChatModel> chatModelSupplier,
                                         CompressionStrategy compressionStrategy) {
        init(this, maxMessages, 100, 3, chatModelSupplier, compressionStrategy);
    }

    /**
     * 兼容旧四参数 API。第二个参数原为 maxTokens，现已不参与压缩判据，仅保留源兼容；
     * 重试次数请通过 {@link #setMaxRetries(int)} 配置，避免同签名静默改变语义。
     */
    @Deprecated
    public ContextCompressionInterceptor(int maxMessages, int legacyMaxTokens,
                                         Supplier<ChatModel> chatModelSupplier,
                                         CompressionStrategy compressionStrategy) {
        init(this, maxMessages, 100, 3, chatModelSupplier, compressionStrategy);
    }

    private static void init(ContextCompressionInterceptor self, int maxMessages,
                             int compressionRatio, int maxRetries,
                             Supplier<ChatModel> chatModelSupplier,
                             CompressionStrategy compressionStrategy) {
        self.maxMessages = Math.max(10, maxMessages);
        self.minReservedMessages = Math.max(3, self.maxMessages / 3);
        self.compressionRatio = Math.min(100, Math.max(1, compressionRatio));
        self.maxRetries = maxRetries;
        self.chatModelSupplier = chatModelSupplier;
        self.compressionStrategy = compressionStrategy;
    }

    public ContextCompressionInterceptor() {
        this(15, null, null);
    }

    /** 复制实例，并使用新的消息限制。 */
    public ContextCompressionInterceptor copyWith(int maxMessages) {
        ContextCompressionInterceptor tmp = new ContextCompressionInterceptor();
        init(tmp, maxMessages, this.compressionRatio, this.maxRetries,
                this.chatModelSupplier, this.compressionStrategy);
        tmp.defaultContextLength = this.defaultContextLength;
        tmp.minReservedMessages = this.minReservedMessages;
        tmp.compressionTargetRatio = this.compressionTargetRatio;
        tmp.reservedOutputTokens = this.reservedOutputTokens;
        tmp.intentChainEnabled = this.intentChainEnabled;
        tmp.intentChainMaxTokens = this.intentChainMaxTokens;
        return tmp;
    }

    @Override
    public void onReasonStart(ReActTrace trace, StringBuilder systemPromptBuf) {
        List<ChatMessage> messages = trace.getWorkingMemory().getMessages();
        String systemPrompt = (systemPromptBuf == null ? null : systemPromptBuf.toString());

        // ⭐ 标记静态上下文边界（为 Dialect 层的 cache_control 提供依据）
        //    当配置了 CacheControl 时，确保系统提示词和工具定义作为一个完整的
        //    可缓存块被保留，不被压缩逻辑破坏其结构性完整性。
        markStaticContextBoundary(trace, systemPrompt);

        // ⭐ 触发预算 = 当前模型上下文窗口 × 压缩比例。
        //    拦截器是单例、跨会话/多模型共享，故每轮从 trace 动态取当前推理模型的
        //    contextLength 计算，绝不写回实例字段（避免会话间互相污染）。
        int budget = resolveBudget(trace);

        // 0. ⭐ 单条消息硬上限兜底（内容级截断）
        //    消息级压缩无法处理“单条消息自身就超过窗口”的情况（如工具读取了超大文件/二进制）。
        //    在任何裁剪逻辑之前，先把超限的单条消息内容截断，确保不变式：
        //    任何单条消息都不会独占超过窗口的份额，从根本上避免 context_length_exceeded。
        messages = enforcePerMessageCap(trace, messages, budget);

        // 收集 tools 元信息（仅 NATIVE_TOOL 模式下 LLM 会接收 tools 定义）
        int toolsTokens = 0;
        if (trace.getConfig().getStyle() == ReActStyle.NATIVE_TOOL) {
            List<FunctionTool> toolsDef = new ArrayList<>();
            toolsDef.addAll(trace.getOptions().getTools());
            toolsDef.addAll(trace.getProtocolTools());

            if (Assert.isNotEmpty(toolsDef)) {
                toolsTokens = estimateToolsTokens(toolsDef);
            }
        }

        int currentTokens = estimateTokens(messages, systemPrompt) + toolsTokens;

        // ⭐ 真实用量校准（P1-1）：本地 jtokkit 估算与模型实际计费口径存在偏差（tokenizer 不同、
        //    供应商额外开销等）。若上一轮拿到了真实 usage 且本轮消息数未变少（即没发生压缩/重置），
        //    就用「真实值 × 偏差系数」修正本地估算，使触发判据贴合真实计费。
        currentTokens = calibrateWithRealUsage(trace, messages, currentTokens, systemPrompt, toolsTokens);

        // ⭐ 预测式检查（P1-2）：不只问「现在超了吗」，还要问「下一轮还装得下吗」。
        //    一轮新增 = 模型输出 + 工具结果，两者都是绝对量。若等到实际超出才压，
        //    本轮请求已经发出去且可能直接被供应商拒绝（413）。
        int projectedTokens = currentTokens + estimateMaxTurnGrowth();

        // ⭐ 更新上下文压力探针（供工具输出预算动态调档）
        //    必须存入 trace：本拦截器是单例、跨会话共享，写实例字段会导致
        //    A 会话的压力污染 B 会话的工具输出上限。
        if (budget > 0) {
            setContextPressure(trace, Math.min(1.0d, (double) currentTokens / (double) budget));
        }

        // ⭐ 触发判据：当前已超、预计下一轮会超，或用户手动 /compact → 压缩
        boolean forced = consumeCompactRequest(trace);
        if (!forced && currentTokens <= budget && projectedTokens <= budget) {
            pushContextChunk(trace, messages.size(), currentTokens, false, 0, 0, 0, 0);
            return;
        }
        // 消费手动请求（无论本次压缩结果如何，都不重复触发）——已在 consumeCompactRequest 中复位

        // ⭐ 熝断（P1-6）已内置于 summarizeOrCapture：跨轮连续失败达上限后，
        //    不再调用摘要 LLM，仅保留零成本裁剪路径。

        // ⭐ 压缩目标水位（与触发阈值解耦）：决定「压到多深」。
        int targetBudget = resolveTargetBudget(resolveModel(trace), budget);

        // 0.5 ⭐ 免费清理层（先试便宜的）
        //    在调用任何 LLM 之前，先把保留窗口之外、白名单工具的旧结果替换为占位符，
        //    但保留 tool_use 骨架与 toolCallId（不改变消息条数与结构，对 cache 前缀破坏最小）。
        //    代码 Agent 的上下文中工具结果通常占 70%+，绝大多数压缩在这一步就能满足，
        //    从而完全避开摘要 LLM 调用。
        List<ChatMessage> swept = sweepStaleToolResults(messages, targetBudget, toolsTokens, systemPrompt);
        if (swept != null) {
            int sweptTokens = estimateTokens(swept, systemPrompt) + toolsTokens;
            if (sweptTokens <= targetBudget) {
                // 免费层已达标 → 直接回写，不调用任何 LLM
                trace.getWorkingMemory().replaceMessages(swept);
                if (log.isDebugEnabled()) {
                    log.debug("ReActAgent [{}] free-tier sweep hit: {} -> {} tokens (no LLM call)",
                            trace.getAgentName(), currentTokens, sweptTokens);
                }
                pushContextChunk(trace, swept.size(), sweptTokens, true,
                        messages.size(), swept.size(), currentTokens, sweptTokens);
                return;
            }
            // 未达标：保留清理成果，继续走摘要路径（两层互补）
            messages = swept;
            currentTokens = sweptTokens;
        }

        // 0.6 ⭐ 会话意图链（防意图漂移，本地组装不调 LLM）
        //    用户消息单条仅 50~200 token，30 轮也才 1.5~6K，比一条 bash 输出还便宜；
        //    而它是判断「用户目标是否已变」的唯一依据，性价比极高。
        ChatMessage intentChain = intentChainEnabled
                ? buildIntentChain(trace, messages)
                : null;

        // 1. 提取“初心链”
        List<ChatMessage> firstList = new ArrayList<>();
        int lastFirstIdx = -1;
        for (int i = 0; i < messages.size(); i++) {
            ChatMessage msg = messages.get(i);
            if (msg.hasMetadata(AgentTrace.META_FIRST)) {
                firstList.add(msg);
                lastFirstIdx = i;
            }
        }

        // 2. 计算固定开销（不可压缩部分：systemPrompt + 初心链 + tools定义） —— 【已引入完备兜底】
        int fixedTokens = 0;
        if (!Assert.isEmpty(systemPrompt)) {
            fixedTokens += encoding.countTokens(systemPrompt) + 4;
        }
        fixedTokens += toolsTokens;

        for (ChatMessage firstMsg : firstList) {
            Integer cachedSize = firstMsg.getMetadataAs(META_TOKEN_SIZE);
            if (cachedSize == null) {
                cachedSize = 0;
                if (firstMsg.getContent() != null) {
                    cachedSize += encoding.countTokens(firstMsg.getContent());
                }
                if (firstMsg instanceof AssistantMessage) {
                    AssistantMessage am = (AssistantMessage) firstMsg;
                    if (Assert.isNotEmpty(am.getToolCalls())) {
                        for (ToolCall tc : am.getToolCalls()) {
                            String name = tc.getName() != null ? tc.getName() : "";
                            String args = tc.getArgumentsStr() != null ? tc.getArgumentsStr() : "";
                            cachedSize += encoding.countTokens(name + args) + 10;
                        }
                    }
                }
                firstMsg.addMetadata(META_TOKEN_SIZE, cachedSize);
            }
            fixedTokens += cachedSize + 4;
        }

        // 极端场景防御
        if (fixedTokens >= budget) {
            if (log.isWarnEnabled()) {
                log.warn("ReActAgent [{}] first chain + systemPrompt ({} tokens) exceeds budget ({}), keep first chain only",
                        trace.getAgentName(), fixedTokens, budget);
            }
            if (firstList.size() < messages.size()) {
                trace.getWorkingMemory().replaceMessages(new ArrayList<>(firstList));
            }
            return;
        }

        // 3. 为压缩消息预留空间
        //    ⭐ 基于 targetBudget（而非触发阈值 budget）计算，确保单次压缩腾出足够空间，
        //    避免「压完没几轮又触发」的抖动。targetBudget 已保证 ≤ budget。
        int availableTokens = Math.max(1, targetBudget - fixedTokens);
        int summaryReserve = Math.max(200, (int) (availableTokens * 0.1));
        int intentChainTokens = (intentChain == null) ? 0 : (estimateSingle(intentChain) + 4);
        int windowBudget = Math.max(1, availableTokens - summaryReserve - intentChainTokens);

        // 4. 双维度确定截断点
        //    - targetByCount ：按消息数量维度的截断位置
        //    - targetByTokens：按 Token 预算维度的截断位置（从尾向前累加）
        //    - minReservedIdx：保留窗口的绝对下限，防止 Token 维度过度截断
        int targetByCount = Math.max(lastFirstIdx + 1, messages.size() - maxMessages);

        int targetByTokens = lastFirstIdx + 1;
        int runningTokens = 0;
        for (int i = messages.size() - 1; i > lastFirstIdx; i--) {
            ChatMessage msg = messages.get(i);
            Integer cachedSize = msg.getMetadataAs(META_TOKEN_SIZE);
            runningTokens += (cachedSize != null ? cachedSize : 0) + 4;
            if (runningTokens > windowBudget) {
                targetByTokens = Math.max(lastFirstIdx + 1, i);
                break;
            }
        }

        // ⭐ 保留窗口绝对下限保护
        //    无论 Token 预算多紧张，保留窗口至少保留 minReservedMessages 条消息。
        //    这样可以避免单条大消息（如文件读取结果）占满预算后，
        //    Agent 的历史上下文被压缩到只剩 1~2 条消息，导致之前的工作白费。
        int minReservedIdx = Math.max(lastFirstIdx + 1, messages.size() - minReservedMessages);

        int rawTargetByTokens = targetByTokens;  // 保存原始Token截断位置，供步骤6.1使用
        int targetIdx = Math.max(targetByCount, Math.min(targetByTokens, minReservedIdx));
        targetIdx = alignStartToToolCallGroup(messages, targetIdx, lastFirstIdx + 1);

        // 5. ⭐ 原子对对齐（防止 tool-use 原子对被截断为两段）
        //    若 targetIdx 落在 ToolMessage 或 Observation 上，向前回退至配套的 Assistant(with tool_calls)
        //    若落在 Assistant(with tool_calls) 上，保留（这是原子对的正确起点）
        //    若落在普通消息上（User / Assistant thought），保留（不存在配对问题）
        while (targetIdx > (lastFirstIdx + 1) && targetIdx < messages.size()) {
            ChatMessage msg = messages.get(targetIdx);
            if (msg instanceof ToolMessage || isObservation(msg)) {
                targetIdx--; // 向前追溯匹配的源头 Assistant(with tool_calls)
            } else if (msg instanceof AssistantMessage && Assert.isNotEmpty(((AssistantMessage) msg).getToolCalls())) {
                break; // 已定位到源头，停止回退
            } else {
                break; // 无关消息，无需处理
            }
        }

        // 6. 语义连贯补齐：若截断点前一条为空想的 Assistant thought，一并纳入保留区
        //    使 LLM 获得完整的推理上下文
        if (targetIdx > (lastFirstIdx + 1)) {
            ChatMessage prev = messages.get(targetIdx - 1);
            if (prev instanceof AssistantMessage && Assert.isEmpty(((AssistantMessage) prev).getToolCalls())) {
                targetIdx--;
            }
        }

        // 6.1 Token 预算补偿校验 + 保护段摘要标记
        //    语义补齐（步骤 5-6）或 minReserved 保护可能导致保留窗口超出 Token 预算。
        //    需要区分两种场景：
        //    - 保护起效了（rawTargetByTokens > minReservedIdx）
        //      对保护段 [targetIdx..rawTargetByTokens) 做摘要压缩，不调整 targetIdx
        //    - 保护没起效
        //      回归 Token 预算截断位置，跳过 ToolMessage 头部
        boolean protectedSummaryApplied = false;
        int actualWindowTokens = 0;
        for (int i = targetIdx; i < messages.size(); i++) {
            Integer cachedSize = messages.get(i).getMetadataAs(META_TOKEN_SIZE);
            actualWindowTokens += (cachedSize != null ? cachedSize : 0) + 4;
        }
        if (actualWindowTokens > windowBudget) {
            if (rawTargetByTokens > minReservedIdx) {
                // 保护起效但预算超了 → 标记后续对保护段做摘要压缩，不调整 targetIdx
                protectedSummaryApplied = true;
                rawTargetByTokens = alignStartToToolCallGroup(messages, rawTargetByTokens, targetIdx);
            } else {
                // 保护没起效 → 回退到预算截断点，并按 tool-use 原子组向前补齐
                targetIdx = alignStartToToolCallGroup(messages, Math.max(lastFirstIdx + 1, targetByTokens), lastFirstIdx + 1);
            }
        }

        // 7. 重构 WorkingMemory
        List<ChatMessage> compressed = new ArrayList<>();
        compressed.addAll(firstList);

        // ⭐ 意图链紧跟初心链之后：先告诉模型「用户先后要过什么、当前焦点是哪个」，
        //    再给出历史摘要与保留窗口，避免长会话中围着早已完成的旧目标打转。
        if (intentChain != null) {
            compressed.add(intentChain);
        }

        if (targetIdx > (lastFirstIdx + 1) && targetIdx <= messages.size()) {
            List<ChatMessage> expired = new ArrayList<>(messages.subList(lastFirstIdx + 1, targetIdx));
            List<ChatMessage> pureHistory = expired.stream()
                    .filter(m -> !m.hasMetadata(META_COMPRESSED))
                    .collect(Collectors.toList());

            if (!pureHistory.isEmpty()) {
                compressed.addAll(summarizeOrCapture(trace, pureHistory));
            }
        }

        // 7.1 ⭐ 保护段摘要压缩（minReserved 保护起效且预算超限时触发）
        //    当 minReserved 保护将本应被 Token 截断的消息保留下来，
        //    但保留窗口实际 Token 超预算时，需要对保护段 [targetIdx..rawTargetByTokens)
        //    做摘要压缩，而非简单丢弃。这样代码 Agent 之前读取的文件内容可以通过摘要保留关键信息。
        if (protectedSummaryApplied) {
            List<ChatMessage> protectedSegment = new ArrayList<>(messages.subList(targetIdx, rawTargetByTokens));
            List<ChatMessage> pureProtected = protectedSegment.stream()
                    .filter(m -> !m.hasMetadata(META_COMPRESSED))
                    .collect(Collectors.toList());

            if (!pureProtected.isEmpty()) {
                compressed.addAll(summarizeOrCapture(trace, pureProtected));
            }

            // 保留窗口尾部（rawTargetByTokens..end）
            compressed.addAll(messages.subList(rawTargetByTokens, messages.size()));
        } else {
            compressed.addAll(messages.subList(targetIdx, messages.size()));
        }

        // 8. 更新工作区
        int beforeSize = messages.size();
        compressed = removeDanglingToolOutputs(compressed);
        if (!compressed.equals(messages)) {
            trace.getWorkingMemory().replaceMessages(compressed);

            if (log.isDebugEnabled()) {
                log.debug("ReActAgent [{}] compressed: {} -> {} messages (FirstChain size: {})",
                        trace.getAgentName(), beforeSize, compressed.size(), firstList.size());
            }

            int afterTokens = estimateTokens(compressed, null) + toolsTokens;
            pushContextChunk(trace, compressed.size(), afterTokens, true,
                            beforeSize, compressed.size(),
                            currentTokens, afterTokens);
        } else {
            // 压缩条件触发但实际未变更（兜底），仍推送当前状态
            pushContextChunk(trace, messages.size(), currentTokens, false, 0, 0, 0, 0);
        }
    }

    /**
     * 对一段过期消息生成摘要；摘要不可用时回落到零成本的原子序列保留。
     *
     * <p><b>为什么必须有回落</b>：策略返回 null 是<b>设计内</b>的正常行为——
     * {@code KeyInfoExtractionStrategy} 判定「无关键增量」时返回 null，
     * {@code CompositeCompressionStrategy} 在全部子策略无输出时返回 null。
     * 若此时直接什么都不加，这段历史就会被<b>静默整段丢弃</b>且没有第二副本，
     * 反而比「未配置策略」的零成本裁剪路径更有损。故两条路径必须共享同一个兜底。</p>
     *
     * @return 需要追加到压缩结果中的消息（可能为空列表，但绝不静默丢弃全部历史）
     */
    private List<ChatMessage> summarizeOrCapture(ReActTrace trace, List<ChatMessage> segment) {
        if (compressionStrategy != null && chatModelSupplier != null && !isSummaryCircuitOpen(trace)) {
            ChatMessage summaryMsg = null;
            try {
                ChatModel chatModel = chatModelSupplier.get();
                if (chatModel != null) {
                    // 手动 /compact 的 focus 指令已由 CompactCommand 直接写入 trace（按会话隔离）
                    summaryMsg = compressionStrategy.compress(chatModel, maxRetries, trace, segment);
                }
            } catch (Throwable e) {
                // 摘要失败绝不能让整轮推理崩溃，落到零成本裁剪路径即可
                log.error("ReActAgent [{}] compression strategy failed, fallback to atomic capture",
                        trace.getAgentName(), e);
            }

            if (summaryMsg != null) {
                recordCompactResult(trace, true);
                return java.util.Collections.singletonList(summaryMsg);
            }

            recordCompactResult(trace, false);
            if (log.isDebugEnabled()) {
                log.debug("ReActAgent [{}] compression strategy returned null, fallback to atomic capture ({} messages)",
                        trace.getAgentName(), segment.size());
            }
        }

        return captureTailToolGroup(segment);
    }

    /** 摘要熝断是否已打开（跨轮连续失败达上限）。 */
    private boolean isSummaryCircuitOpen(ReActTrace trace) {
        boolean open = consecutiveFailures(trace) >= MAX_CONSECUTIVE_COMPACT_FAILURES;
        if (open && log.isWarnEnabled()) {
            log.warn("ReActAgent [{}] summary circuit open ({} consecutive failures), using zero-cost trimming only",
                    trace.getAgentName(), MAX_CONSECUTIVE_COMPACT_FAILURES);
        }
        return open;
    }

    private int consecutiveFailures(ReActTrace trace) {
        try {
            Object v = trace.getExtraAs(CTX_COMPACT_FAILURES);
            return (v instanceof Number) ? ((Number) v).intValue() : 0;
        } catch (Exception e) {
            return 0;
        }
    }

    private void recordCompactResult(ReActTrace trace, boolean success) {
        try {
            trace.setExtra(CTX_COMPACT_FAILURES, success ? 0 : consecutiveFailures(trace) + 1);
        } catch (Exception ignore) {
            // 熝断仅为保护，记不上不影响主流程
        }
    }

    /**
     * ⭐ fallback 原子序列追溯（零成本裁剪路径，不调用 LLM 生成摘要）
     *
     * <p>问题背景：过期区可能包含不完整的 tool-use 原子对。
     * 例如 {@code [Assistant(tc=[search]), Tool(res)]} 被整体移入过期区，
     * 若直接丢弃、仅保留保留窗口内的后续轮次，恢复后的上下文会变成：
     * {@code [摘要] → [Tool(res)] → [下一个 Assistant(tc=...)]}，
     * 此时 {@code Tool(res)} 找不到配对的 tool_calls → LLM 感知异常。</p>
     *
     * <p>追溯策略：从末尾向前查找最后一个完整的 tool-use 序列。
     * 一条 {@code Assistant(with tool_calls)} 可能触发多个 ToolMessage，
     * 甚至多轮交错调用如 {@code [Assistant(tc=A), Tool(A1), Assistant(tc=B), Tool(B)]}，
     * 需保留从最后一个源头 Assistant(with tc) 到末尾的全部消息。</p>
     */
    private List<ChatMessage> captureTailToolGroup(List<ChatMessage> segment) {
        if (segment.isEmpty()) {
            return java.util.Collections.emptyList();
        }

        int captureStart = segment.size() - 1;
        while (captureStart > 0) {
            ChatMessage msg = segment.get(captureStart);
            if (msg instanceof ToolMessage || isObservation(msg)) {
                captureStart--; // ToolMessage → 继续向前追溯源头
            } else if (msg instanceof AssistantMessage
                    && Assert.isNotEmpty(((AssistantMessage) msg).getToolCalls())) {
                break; // 找到源头 Assistant(with tc)，保留 [captureStart..末尾] 序列
            } else {
                // 遇到无关消息（User、普通 Assistant thought），
                // 回退一步，至少保留一个 ToolMessage（宁可保留畸形的，不送孤立 ToolMessage）
                if (captureStart < segment.size() - 1) {
                    captureStart++;
                }
                break;
            }
        }

        return new ArrayList<>(segment.subList(captureStart, segment.size()));
    }

    /**
     * 工具结果可被免费清理的白名单：<b>纯只读且可重现</b>——重新调用只花时间，不改变世界状态。
     *
     * <p><b>为何排除 write/edit</b>：它们是<b>副作用工具</b>。占位符会诱导模型
     * 「如需请重新调用」，重跑一次 write 会二次覆盖文件、重跑 edit 可能因锚点已变而失败或改错位置。
     * 且它们的返回通常只是一行成功提示，清理几乎不省 token，收益与风险完全不成比例。</p>
     *
     * <p><b>为何保留 bash</b>：bash 输出常是上下文最大头，收益显著；但 bash 同样可能有副作用，
     * 故仅清理<b>结果内容</b>并配合中性占位符（不主动怂恿重跑），且后台任务句柄另有护栏
     * （见 {@link #isSweepable}）。</p>
     */
    private static final java.util.Set<String> SWEEPABLE_TOOLS = new java.util.HashSet<>(java.util.Arrays.asList(
            "read", "bash", "grep", "glob", "list", "ls",
            "websearch", "webfetch", "codesearch"));

    /**
     * 判断一条工具结果是否可安全清理。
     *
     * <p><b>后台任务护栏</b>：{@code bash(run_in_background=true)} 的返回里含 {@code session_id}，
     * 这是<b>不可重现</b>的一次性句柄——重新调用 bash 只会再起一个新进程，拿不回原来那个。
     * 一旦清掉，模型将永远无法用 {@code bash_output} 查询该任务的进度与结果。</p>
     */
    private boolean isSweepable(ToolMessage tm) {
        String toolName = tm.getName();
        if (toolName == null || !SWEEPABLE_TOOLS.contains(toolName.toLowerCase())) {
            // 子代理返回、MCP 工具、todo、bash_output 等不可重现或高价值的结果不清
            return false;
        }

        String content = tm.getContent();
        if (content == null || content.length() < 200) {
            // 太小的结果清了也不省空间
            return false;
        }

        // 后台任务句柄不可重现，必须保留
        if (content.contains("session_id:")) {
            return false;
        }

        return true;
    }

    private ChatModel resolveModel(ReActTrace trace) {
        try {
            return trace.getOptions().getChatModel();
        } catch (Exception e) {
            return null;
        }
    }

    /** 估算单条消息的 token（不写缓存，用于临时构造的消息）。 */
    private int estimateSingle(ChatMessage msg) {
        Integer cached = msg.getMetadataAs(META_TOKEN_SIZE);
        if (cached != null) {
            return cached;
        }
        return msg.getContent() == null ? 0 : encoding.countTokens(msg.getContent());
    }

    /**
     * ⭐ 免费清理层：把保留窗口之外的旧工具结果替换为占位符，不调用 LLM。
     *
     * <p><b>与摘要层的关系</b>：互补而非替代。免费层处理高频小压（工具结果占代码 Agent
     * 上下文 70%+），摘要层处理低频深压。只有免费层腾不出足够空间时才花钱调 LLM。</p>
     *
     * <p><b>为何保留骨架</b>：只清空 ToolMessage 的内容，不删除消息本身，
     * 也不动对应的 Assistant(tool_calls)。消息条数与配对关系不变 →
     * 既不会产生悬空工具输出，对 prompt cache 前缀的破坏也远小于整段替换。
     * 与 Anthropic 官方 {@code clear_tool_uses_20250919}（保留 tool_use 记录、仅替换
     * tool_result 内容为占位符）是同一思路。</p>
     *
     * <p><b>⚠ 轮边界保护（关键不变式）</b>：本方法在 {@code onReasonStart} 执行，而
     * {@code ActionTask} 会把本轮全部并行工具结果「成套」写入工作记忆后才回到推理。
     * 若仅按「消息条数」划保护线，一次并行调用（如同时 8 个 read）会让较早的几条落在
     * 保护线之外 → <b>模型尚未读到就被清空</b>，相当于工具白跑，模型只能重调→再被清→无限循环。
     * 故必须以<b>最后一个完整工具调用组的起点</b>作为硬保护边界。</p>
     *
     * @return 发生清理时返回新列表；无可清理时返回 null
     */
    private List<ChatMessage> sweepStaleToolResults(List<ChatMessage> messages, int targetBudget,
                                                    int toolsTokens, String systemPrompt) {
        // 保护最近 N 条：当前任务正在依赖的观测不能清
        int protectFrom = Math.max(0, messages.size() - Math.max(minReservedMessages, maxMessages / 2));

        // ⭐ 轮边界硬保护：末尾那个工具调用组（Assistant(tool_calls) + 其全部 ToolMessage）
        //    可能是本轮刚落地、模型还没看过的结果，任何情况下都不得清理。
        protectFrom = Math.min(protectFrom, lastToolCallGroupStart(messages));

        List<ChatMessage> result = new ArrayList<>(messages.size());
        boolean changed = false;

        for (int i = 0; i < messages.size(); i++) {
            ChatMessage msg = messages.get(i);

            if (i >= protectFrom
                    || !(msg instanceof ToolMessage)
                    || msg.hasMetadata(AgentTrace.META_FIRST)
                    || msg.hasMetadata(META_SWEPT)) {
                result.add(msg);
                continue;
            }

            ToolMessage tm = (ToolMessage) msg;
            if (tm.isMultiModal() || !isSweepable(tm)) {
                result.add(msg);
                continue;
            }

            ToolMessage cleared = new ToolMessage(
                    new org.noear.solon.ai.chat.tool.ToolResult(clearedPlaceholder(tm.getName())),
                    tm.getName(), tm.getToolCallId(), tm.isReturnDirect());
            copyMetadataExceptTokenSize(msg, cleared);
            cleared.addMetadata(META_SWEPT, 1);

            result.add(cleared);
            changed = true;
        }

        return changed ? result : null;
    }

    /**
     * 已清理工具结果的占位文案。
     *
     * <p><b>措辞为何重要</b>：写「如需请重新调用」会主动诱导模型重跑工具，
     * 而重跑本身又会产生新的大结果、再次推高上下文，形成「清理→重调→再清理」的死循环，
     * 反而比不清理更贵。故采用<b>中性陈述</b>：只告知事实，把「要不要重调」的判断交给模型自己。
     * （对齐 Anthropic 官方占位符与 CC 的 {@code [Old tool result content cleared]} 口径）</p>
     */
    private String clearedPlaceholder(String toolName) {
        return "[早期工具结果已从上下文中清理 · tool="
                + (toolName == null ? "unknown" : toolName) + "]";
    }

    /**
     * 定位最后一个工具调用组的起点（即末尾连续工具输出所属的源头 Assistant 位置）。
     *
     * <p>用作免费清理层的硬保护边界：该位置及之后的所有消息都可能是本轮刚产生、
     * 模型尚未读取的观测。末尾不是工具输出时返回 {@code messages.size()}（不额外限制）。</p>
     */
    private int lastToolCallGroupStart(List<ChatMessage> messages) {
        int i = messages.size() - 1;
        if (i < 0 || !(messages.get(i) instanceof ToolMessage || isObservation(messages.get(i)))) {
            return messages.size();
        }

        while (i >= 0) {
            ChatMessage msg = messages.get(i);
            if (msg instanceof ToolMessage || isObservation(msg)) {
                i--;
                continue;
            }
            if (msg instanceof AssistantMessage && Assert.isNotEmpty(((AssistantMessage) msg).getToolCalls())) {
                return i;
            }
            break;
        }
        return Math.max(0, i + 1);
    }

    /**
     * ⭐ 构建「会话意图链」：按 {@code META_RUN_ID} 分组抽取历史用户消息，本地组装、不调 LLM。
     *
     * <p><b>解决的问题</b>：旧逻辑把「会话第一条消息」永久钉死为初心，但多轮对话中
     * 用户目标会变：3 天前那句「帮我做个 PPT」不应与当前任务抢注意力，
     * 而中间各轮的真实意图反而毫无保护、会被整段丢弃。</p>
     *
     * <p><b>为何便宜</b>：用户消息单条约 50~200 token，即使 30 轮也只有 1.5~6K，
     * 不到一条 bash 输出（⇨16~20K）的 1/3。保留全部意图的成本极低、语义收益极高。</p>
     *
     * @return 意图链消息；历史不足两轮时返回 null（无漂移风险，不必浪费 token）
     */
    private ChatMessage buildIntentChain(ReActTrace trace, List<ChatMessage> messages) {
        // 按 runId 分组：一个 run = 用户一次提问 + 其后所有 ReAct 循环，天然就是任务边界
        List<String> intents = new ArrayList<>();
        List<String> seenRunIds = new ArrayList<>();

        for (ChatMessage msg : messages) {
            if (!(msg instanceof UserMessage)) {
                continue;
            }
            String content = msg.getContent();
            if (content == null || content.isEmpty()) {
                continue;
            }
            // 排除压缩产物与工具观测伪装的 UserMessage
            if (msg.hasMetadata(META_COMPRESSED) || msg.hasMetadata(META_INTENT_CHAIN)
                    || content.startsWith("Observation:")) {
                continue;
            }

            Object runId = msg.getMetadataAs(AgentTrace.META_RUN_ID);
            String runKey = (runId == null) ? null : String.valueOf(runId);
            if (runKey != null) {
                if (seenRunIds.contains(runKey)) {
                    continue; // 同一 run 内只取首条（即用户本轮的原始提问）
                }
                seenRunIds.add(runKey);
            }

            String brief = content.replaceAll("\\s+", " ").trim();
            if (brief.length() > INTENT_BRIEF_CHARS) {
                brief = brief.substring(0, INTENT_BRIEF_CHARS) + "...";
            }
            intents.add(brief);
        }

        // 无任何意图时不必注入；单条也要注入——单轮长会话（只提问一次、却跑了几十轮工具）
        // 下，保留窗口可能已把原始诉求压掉，此时那唯一一条意图恰恰最重要。
        if (intents.isEmpty()) {
            return null;
        }

        StringBuilder buf = new StringBuilder(512);
        buf.append("--- [\u4f1a\u8bdd\u610f\u56fe\u94fe] ---\n")
           .append("\u7528\u6237\u5728\u672c\u4f1a\u8bdd\u4e2d\u5148\u540e\u63d0\u51fa\u8fc7\u4ee5\u4e0b\u8bf7\u6c42\uff08\u6309\u65f6\u95f4\u5e8f\uff0c\u6700\u540e\u4e00\u6761\u4e3a\u5f53\u524d\u7126\u70b9\uff09\uff1a\n");

        int startIdx = 0;
        // 从尾部往前取，优先保证最近的意图一定在内
        int approxTokens = encoding.countTokens(buf.toString());
        List<String> picked = new ArrayList<>();
        for (int i = intents.size() - 1; i >= 0; i--) {
            int t = encoding.countTokens(intents.get(i)) + 8;
            if (approxTokens + t > intentChainMaxTokens && !picked.isEmpty()) {
                startIdx = i + 1;
                break;
            }
            approxTokens += t;
            picked.add(0, intents.get(i));
        }

        if (startIdx > 0) {
            buf.append("（\u8f83\u65e9 ").append(startIdx).append(" \u6761\u610f\u56fe\u5df2\u7701\u7565）\n");
        }
        for (int i = 0; i < picked.size(); i++) {
            buf.append(i + 1 + startIdx).append(". ").append(picked.get(i));
            if (i == picked.size() - 1) {
                buf.append("   \u2190 \u5f53\u524d\u7126\u70b9");
            }
            buf.append('\n');
        }

        return ChatMessage.ofUser(buf.toString())
                .addMetadata(META_INTENT_CHAIN, 1)
                .addMetadata(META_COMPRESSED, 1);
    }

    /**
     * ⭐ 用上一轮的真实 usage 校准本地估算（P1-1）。
     *
     * <p>{@code ContextUsageInterceptor} 在每轮推理结束后会把模型返回的真实
     * {@code input_tokens}（已由 UsageNormalizer 归一、含缓存）写入 trace。
     * 本方法据此算出「真实/估算」偏差系数并修正本轮估算值。</p>
     *
     * <p>仅在消息数未减少时采信（减少说明中间发生过压缩/重置，旧锚点已失效），
     * 且系数钳制在 [0.5, 2.0] 防止异常值带偏决策。</p>
     */
    private int calibrateWithRealUsage(ReActTrace trace, List<ChatMessage> messages, int estimated,
                                       String systemPrompt, int toolsTokens) {
        try {
            Object realObj = trace.getExtraAs(CTX_LAST_REAL_INPUT_TOKENS);
            Object cntObj = trace.getExtraAs(CTX_LAST_REAL_MESSAGE_COUNT);
            if (!(realObj instanceof Number) || !(cntObj instanceof Number)) {
                return estimated;
            }

            long realTokens = ((Number) realObj).longValue();
            int realMsgCount = ((Number) cntObj).intValue();
            if (realTokens <= 0 || realMsgCount <= 0) {
                return estimated;
            }

            // 消息变少 → 中间发生过压缩，旧锚点不再具有参考价值
            if (messages.size() < realMsgCount) {
                return estimated;
            }

            // 估算当时那一轮的本地值作为分母。
            // ⭐ 口径必须与分子一致：真实 input_tokens 包含 systemPrompt 与 tools 定义，
            //    若分母只算消息，分母会系统性偏小（tools 定义动辄数千 token），
            //    导致 factor 恒偏大、被 2.0 上限钳住 → 估算值被凭空放大到 2 倍，
            //    压缩显著提前触发，与「减少压缩频率」的目标完全相反。
            int estimatedThen = estimateTokens(messages.subList(0, Math.min(realMsgCount, messages.size())),
                    systemPrompt) + toolsTokens;
            if (estimatedThen <= 0) {
                return estimated;
            }

            double factor = (double) realTokens / (double) estimatedThen;
            factor = Math.max(0.5d, Math.min(2.0d, factor));

            int calibrated = (int) Math.min(Integer.MAX_VALUE, (long) (estimated * factor));
            if (log.isDebugEnabled() && Math.abs(factor - 1.0d) > 0.1d) {
                log.debug("ReActAgent [{}] token calibration factor={} ({} -> {})",
                        trace.getAgentName(), String.format("%.2f", factor), estimated, calibrated);
            }
            return calibrated;
        } catch (Exception e) {
            return estimated;
        }
    }

    /**
     * ⭐ 估算下一轮最大新增量（P1-2 预测式检查）。
     *
     * <p>= 模型单轮输出上限 + 工具结果估计。两者都是绝对量，不随窗口线性变化。
     * 用于在发起请求<b>之前</b>判断「下一轮还装得下吗」，而非事后才发现溢出。</p>
     */
    private int estimateMaxTurnGrowth() {
        return reservedOutputTokens + TOOL_RESULT_GROWTH_ESTIMATE;
    }

    /** 工具结果单轮增长估计（与 TerminalTalent 等工具的输出上限同量级） */
    private static final int TOOL_RESULT_GROWTH_ESTIMATE = 16_000;

    private int alignStartToToolCallGroup(List<ChatMessage> messages, int startIdx, int minIdx) {
        if (startIdx <= minIdx || startIdx >= messages.size()) {
            return startIdx;
        }

        ChatMessage msg = messages.get(startIdx);
        if (msg instanceof ToolMessage) {
            String toolCallId = ((ToolMessage) msg).getToolCallId();
            for (int i = startIdx - 1; i >= minIdx; i--) {
                ChatMessage prev = messages.get(i);
                if (prev instanceof AssistantMessage && Assert.isNotEmpty(((AssistantMessage) prev).getToolCalls())) {
                    if (toolCallId == null || hasToolCallId((AssistantMessage) prev, toolCallId)) {
                        return i;
                    }
                }

                if (!(prev instanceof ToolMessage) && !isObservation(prev)) {
                    break;
                }
            }
        } else if (isObservation(msg)) {
            for (int i = startIdx - 1; i >= minIdx; i--) {
                ChatMessage prev = messages.get(i);
                if (prev instanceof AssistantMessage && Assert.isNotEmpty(((AssistantMessage) prev).getToolCalls())) {
                    return i;
                }

                if (!(prev instanceof ToolMessage) && !isObservation(prev)) {
                    break;
                }
            }
        }

        return startIdx;
    }

    private List<ChatMessage> removeDanglingToolOutputs(List<ChatMessage> messages) {
        List<ChatMessage> result = new ArrayList<>(messages.size());

        for (int i = 0; i < messages.size(); i++) {
            ChatMessage msg = messages.get(i);

            if (msg instanceof AssistantMessage && Assert.isNotEmpty(((AssistantMessage) msg).getToolCalls())) {
                AssistantMessage assistant = (AssistantMessage) msg;
                List<ChatMessage> toolOutputs = new ArrayList<>();
                List<String> requiredCallIds = new ArrayList<>();

                for (ToolCall tc : assistant.getToolCalls()) {
                    if (tc.getId() != null) {
                        requiredCallIds.add(tc.getId());
                    }
                }

                int j = i + 1;
                for (; j < messages.size(); j++) {
                    ChatMessage next = messages.get(j);
                    if (next instanceof ToolMessage || isObservation(next)) {
                        toolOutputs.add(next);
                    } else {
                        break;
                    }
                }

                boolean completed = false;
                if (Assert.isNotEmpty(requiredCallIds)) {
                    List<String> remainingCallIds = new ArrayList<>(requiredCallIds);
                    for (ChatMessage toolOutput : toolOutputs) {
                        if (toolOutput instanceof ToolMessage) {
                            String toolCallId = ((ToolMessage) toolOutput).getToolCallId();
                            if (toolCallId != null) {
                                remainingCallIds.remove(toolCallId);
                            }
                        }
                    }
                    completed = remainingCallIds.isEmpty();
                } else {
                    completed = Assert.isNotEmpty(toolOutputs);
                }

                if (completed) {
                    result.add(msg);
                    for (ChatMessage toolOutput : toolOutputs) {
                        if (toolOutput instanceof ToolMessage) {
                            String toolCallId = ((ToolMessage) toolOutput).getToolCallId();
                            if (toolCallId == null || requiredCallIds.isEmpty() || requiredCallIds.contains(toolCallId)) {
                                result.add(toolOutput);
                            }
                        } else {
                            result.add(toolOutput);
                        }
                    }
                }

                i = j - 1;
                continue;
            }

            if (msg instanceof ToolMessage || isObservation(msg)) {
                continue;
            }

            result.add(msg);
        }

        return result;
    }

    private boolean hasToolCallId(AssistantMessage assistantMessage, String toolCallId) {
        for (ToolCall tc : assistantMessage.getToolCalls()) {
            if (toolCallId.equals(tc.getId())) {
                return true;
            }
        }

        return false;
    }

    /**
     * 单条消息硬上限兜底：对内容 Token 数超过 {@code perMessageCap} 的单条消息做头尾截断。
     *
     * <p>消息级压缩（裁剪/摘要历史）无法解决“单条消息自身超过上下文窗口”的问题——
     * 例如工具读取了一个超大文件或二进制流，产生一条数十万 Token 的 ToolMessage。
     * 此时无论怎么删别的消息，这一条都会把请求顶爆。故在所有裁剪逻辑之前先做内容级截断。</p>
     *
     * <p>仅处理文本型消息；多模态消息（含图片块等）跳过，避免破坏 ContentBlock 结构。
     * 截断后清除该消息的 {@code META_TOKEN_SIZE} 缓存以触发重算。</p>
     *
     * @return 处理后的消息列表（若发生截断会写回 WorkingMemory）
     */
    private List<ChatMessage> enforcePerMessageCap(ReActTrace trace, List<ChatMessage> messages, int budget) {
        // 单条消息最多占用半个窗口预算（且不低于绝对下限），超出即视为异常的超大消息
        int perMessageCap = Math.max(2_000, budget / 2);

        boolean changed = false;
        List<ChatMessage> result = new ArrayList<>(messages.size());

        for (ChatMessage msg : messages) {
            // 初心链消息不截断（system prompt / 用户原始问题需完整保留）
            if (msg.hasMetadata(AgentTrace.META_FIRST)) {
                result.add(msg);
                continue;
            }

            String content = msg.getContent();
            if (content == null || content.isEmpty()) {
                result.add(msg);
                continue;
            }

            // 多模态消息跳过（避免破坏图片等非文本块）
            if ((msg instanceof ToolMessage && ((ToolMessage) msg).isMultiModal())
                    || (msg instanceof UserMessage && ((UserMessage) msg).isMultiModal())) {
                result.add(msg);
                continue;
            }

            // ⭐ 性能：优先用缓存初筛，避免每轮对全部消息做全量 BPE 编码。
            //    缓存值（含 toolCalls 开销）可能略大于纯 content token，作为“是否超限”的
            //    初筛是安全方向（宁可多检一条，不会漏检超限消息）。仅在缓存缺失或疑似
            //    超限时才精确 countTokens 确认。
            Integer cachedTokens = msg.getMetadataAs(META_TOKEN_SIZE);
            if (cachedTokens != null && cachedTokens <= perMessageCap) {
                result.add(msg);
                continue;
            }

            int contentTokens = encoding.countTokens(content);
            if (contentTokens <= perMessageCap) {
                result.add(msg);
                continue;
            }

            String truncated = truncateTextToTokens(content, perMessageCap);
            ChatMessage replacement = rebuildWithContent(msg, truncated);
            if (replacement == null) {
                // 无法安全重建（类型不支持）→ 保持原样，交由后续逻辑处理
                result.add(msg);
                continue;
            }

            result.add(replacement);
            changed = true;

            if (log.isWarnEnabled()) {
                log.warn("ReActAgent [{}] single message too large ({} tokens > cap {}), content truncated",
                        trace.getAgentName(), contentTokens, perMessageCap);
            }
        }

        if (changed) {
            trace.getWorkingMemory().replaceMessages(result);
            return result;
        }
        return messages;
    }

    /**
     * 重建一条带有新内容的消息，复制原 metadata（但清除 token_size 以触发重算）。
     * 支持的类型：
     * <ul>
     *   <li>{@link ToolMessage} —— 超大单条消息的主要来源（工具读取大文件）</li>
     *   <li>{@link UserMessage} —— 用户直接粘贴超长日志/文件（保留 Observation 前缀，因头部从索引 0 起截断）</li>
     *   <li>{@link AssistantMessage} —— 仅纯文本 thought（无 toolCalls）；含 toolCalls 的不重建，避免损坏推理链</li>
     * </ul>
     * 其它类型返回 null。
     */
    private ChatMessage rebuildWithContent(ChatMessage origin, String newContent) {
        if (origin instanceof ToolMessage) {
            ToolMessage tm = (ToolMessage) origin;
            ToolMessage rebuilt = new ToolMessage(
                    new org.noear.solon.ai.chat.tool.ToolResult(newContent),
                    tm.getName(),
                    tm.getToolCallId(),
                    tm.isReturnDirect());

            copyMetadataExceptTokenSize(origin, rebuilt);
            return rebuilt;
        }

        if (origin instanceof UserMessage) {
            // 用户粘贴的超长文本。多模态已在调用前跳过，这里按纯文本重建。
            UserMessage rebuilt = (UserMessage) ChatMessage.ofUser(newContent);
            copyMetadataExceptTokenSize(origin, rebuilt);
            return rebuilt;
        }

        if (origin instanceof AssistantMessage) {
            AssistantMessage am = (AssistantMessage) origin;
            // 含 toolCalls 的不截断 content（体积主要在 args，截断正文可能损坏推理链/原子对）
            if (Assert.isNotEmpty(am.getToolCalls())) {
                return null;
            }
            AssistantMessage rebuilt = new AssistantMessage(newContent, am.isThinking());
            copyMetadataExceptTokenSize(origin, rebuilt);
            return rebuilt;
        }

        return null;
    }

    /**
     * 复制原消息 metadata 到目标消息，跳过 {@link #META_TOKEN_SIZE}（让其按新内容重算）。
     */
    private void copyMetadataExceptTokenSize(ChatMessage origin, ChatMessage target) {
        Map<String, Object> meta = origin.getMetadata();
        if (meta != null) {
            for (Map.Entry<String, Object> e : meta.entrySet()) {
                if (META_TOKEN_SIZE.equals(e.getKey())) {
                    continue;
                }
                target.addMetadata(e.getKey(), e.getValue());
            }
        }
    }

    /**
     * 将文本按 Token 预算做头尾保留截断（中间插入显式占位）。
     * 以字符切分逼近，再用编码器精确收敛，确保结果不超过 maxTokens。
     */
    private String truncateTextToTokens(String text, int maxTokens) {
        if (text == null || encoding.countTokens(text) <= maxTokens) {
            return text;
        }

        String marker = "\n... [内容过大已截断：单条消息超过上下文预算，省略中间部分，仅保留首尾。"
                + "如需完整内容，请用分页方式重新获取] ...\n";
        int markerTokens = encoding.countTokens(marker);
        int budget = Math.max(0, maxTokens - markerTokens);
        int headTokens = budget / 2;
        int tailTokens = budget - headTokens;

        // 字符与 Token 的经验比例（保守取 3 字符/Token），逐步收敛避免超限
        int headChars = Math.min(text.length(), headTokens * 3);
        int tailChars = Math.min(text.length() - headChars, tailTokens * 3);

        String head = text.substring(0, headChars);
        while (encoding.countTokens(head) > headTokens && head.length() > 0) {
            int newLen = Math.min(head.length() - 1, head.length() * 9 / 10);
            head = head.substring(0, Math.max(0, newLen));
        }

        String tail = text.substring(text.length() - tailChars);
        while (encoding.countTokens(tail) > tailTokens && tail.length() > 0) {
            int cut = Math.max(1, tail.length() / 10);
            tail = tail.substring(cut);
        }

        return head + marker + tail;
    }

    private int estimateTokens(List<ChatMessage> messages, String systemPrompt) {
        int totalTokens = 0;
        for (ChatMessage m : messages) {
            // 尝试从元数据获取缓存值
            Integer cachedCount = m.getMetadataAs(META_TOKEN_SIZE);

            if (cachedCount == null) {
                cachedCount = 0;
                if (m.getContent() != null) {
                    cachedCount += encoding.countTokens(m.getContent());
                }

                // 补算 AssistantMessage 的 toolCalls 序列化开销
                if (m instanceof AssistantMessage) {
                    AssistantMessage am = (AssistantMessage) m;
                    if (Assert.isNotEmpty(am.getToolCalls())) {
                        for (ToolCall tc : am.getToolCalls()) {
                            String name = tc.getName() != null ? tc.getName() : "";
                            String args = tc.getArgumentsStr() != null ? tc.getArgumentsStr() : "";

                            cachedCount += encoding.countTokens(name + args);
                            cachedCount += 10; // id + JSON 结构开销
                        }
                    }
                }

                // 将计算结果回填到消息元数据中
                m.addMetadata(META_TOKEN_SIZE, cachedCount);
            }

            totalTokens += cachedCount + 4; // Overhead
        }

        // systemPrompt 的 token 开销
        if (systemPrompt != null && !systemPrompt.isEmpty()) {
            totalTokens += encoding.countTokens(systemPrompt) + 4;
        }

        return totalTokens + 3;
    }

    /**
     * 估算 tools 定义（FunctionTool 的 name + description + inputSchema）的 Token 开销。
     * 这些定义在每次 LLM 调用时都会作为请求的一部分发送，属于固定开销。
     */
    private int estimateToolsTokens(Collection<FunctionTool> tools) {
        int tokens = 0;
        for (FunctionTool tool : tools) {
            // name
            if (tool.name() != null) {
                tokens += encoding.countTokens(tool.name());
            }
            // description（含 meta 信息）
            if (tool.descriptionAndMeta() != null) {
                tokens += encoding.countTokens(tool.descriptionAndMeta());
            }
            // inputSchema（JSON Schema 定义）
            if (tool.inputSchema() != null) {
                tokens += encoding.countTokens(tool.inputSchema());
            }
            tokens += 15; // JSON 结构开销（type, function, parameters 等字段）
        }
        return tokens;
    }

    private boolean isObservation(ChatMessage msg) {
        return (msg instanceof ToolMessage) ||
                (msg instanceof UserMessage && msg.getContent() != null && msg.getContent().startsWith("Observation:"));
    }

    /**
     * 计算本轮压缩触发/预算 = 当前推理模型上下文窗口 × 压缩比例。
     *
     * <p>拦截器为单例、跨会话与多模型共享，故必须每轮从 trace 动态取"当前正在推理的
     * 这个 agent 的模型"的 contextLength（主/子代理可用不同模型），不能缓存到实例字段。
     * 模型未设置 contextLength（=0）时回退 {@link #DEFAULT_CONTEXT_LENGTH}。</p>
     */
    private int resolveBudget(ReActTrace trace) {
        ChatModel model = null;
        try {
            model = trace.getOptions().getChatModel();
        } catch (Exception e) {
            if (log.isDebugEnabled()) {
                log.debug("ReActAgent [{}] resolve contextLength failed, fallback {}: {}",
                        trace.getAgentName(), defaultContextLength, e.getMessage());
            }
        }
        return finalTokenThreshold(model);
    }

    /** 返回模型的完整 long 上下文窗口；未配置时回退可配置默认值。 */
    private long finalContextLength(ChatModel model) {
        if (model != null && model.getConfig() != null) {
            long configured = model.getConfig().getContextLength();
            if (configured > 0L) return configured;
        }
        return defaultContextLength;
    }

    /**
     * 计算本轮压缩触发阈值。
     *
     * <p><b>为什么不用纯百分比</b>：需要预留的空间取决于「一轮最多能新增多少」（模型输出 +
     * 工具结果，均为绝对量），而<b>不随上下文窗口线性增长</b>。按窗口比例预留必然在两头失准：
     * 1M 窗口按 80% 会白扔 200K 可用空间（且压缩次数翻倍）；
     * 32K 窗口按 80% 只剩 6.4K 余量，<b>装不下一轮输出就会溢出</b>。</p>
     *
     * <pre>
     * effectiveWindow = contextLength − reservedOutputTokens
     * turnBuffer      = effectiveWindow ≥ 800K ? 50K : ≥ 400K ? 30K : 13K
     * threshold       = effectiveWindow − turnBuffer
     * threshold       = min(threshold, contextLength × ratio%)   // 比例仅作为提前钳制
     * threshold       = max(threshold, contextLength / 2)         // 小窗口地板保护
     * </pre>
     *
     * <p>jtokkit {@code countTokens} 返回 int，故此处是刻意且唯一的收窄边界：
     * 先用 long 计算，再饱和钳制到 Integer.MAX_VALUE，绝不回绕为负数。</p>
     */
    private int finalTokenThreshold(ChatModel model) {
        long contextLength = finalContextLength(model);

        // 1. 扇出单轮输出预留（绝对量）。极小窗口下预留不得吞掉全部窗口。
        long reservedOutput = Math.min(reservedOutputTokens, Math.max(1L, contextLength / 4));
        long effectiveWindow = Math.max(1L, contextLength - reservedOutput);

        // 2. 回合缓冲（工具结果等本轮新增），同样是绝对量阶梯
        long turnBuffer;
        if (effectiveWindow >= 800_000L) {
            turnBuffer = 50_000L;
        } else if (effectiveWindow >= 400_000L) {
            turnBuffer = 30_000L;
        } else {
            turnBuffer = 13_000L;
        }
        // 小窗口下缓冲不得吞掉过半有效窗口
        turnBuffer = Math.min(turnBuffer, Math.max(1L, effectiveWindow / 2));

        long threshold = effectiveWindow - turnBuffer;

        // 3. 比例钳制：只能把触发点往前拉（更早压缩），永远不能往后推
        if (compressionRatio < 100) {
            long byRatio = contextLength > Long.MAX_VALUE / compressionRatio
                    ? Long.MAX_VALUE
                    : contextLength * compressionRatio / 100L;
            threshold = Math.min(threshold, byRatio);
        }

        // 4. 地板保护：再小的窗口也至少能用一半，避免退化为每轮都压
        threshold = Math.max(threshold, contextLength / 2L);

        return (int) Math.min(Integer.MAX_VALUE, Math.max(1L, threshold));
    }

    /**
     * 计算压缩后的目标水位（绝对 token 数）。
     *
     * <p><b>为什么要与触发阈值解耦</b>：若压缩后仅降到触发线略下方，单次只腾出很少空间，
     * 而一条大工具结果就能把压缩成果全部吃掉 → 长会话陷入「每 1~3 轮压一次」的抖动，
     * 每次都重写消息前缀导致整窗 prompt cache 失效。</p>
     */
    private int resolveTargetBudget(ChatModel model, int triggerBudget) {
        long contextLength = finalContextLength(model);
        long reservedOutput = Math.min(reservedOutputTokens, Math.max(1L, contextLength / 4));
        long effectiveWindow = Math.max(1L, contextLength - reservedOutput);

        long target = effectiveWindow * compressionTargetRatio / 100L;
        // 目标水位不得高于触发阈值（否则压了等于没压）
        target = Math.min(target, triggerBudget);
        return (int) Math.min(Integer.MAX_VALUE, Math.max(1L, target));
    }

    /**
     * ⭐ 标记静态上下文的边界，为 Dialect 层的 cache_control 提供依据。
     *
     * <p>静态上下文包含系统提示词（systemPrompt）和工具定义（tool definitions），
     * 这些内容在会话中不会频繁变化，最适合 LLM 提供商的原生 Prompt Caching。</p>
     *
     * <p>当用户在 ChatOptions 中配置了 cacheControl（Anthropic 风格）或
     * promptCacheKey（OpenAI 风格）时，此方法确保静态上下文在压缩过程中
     * 保持结构完整性，不会被摘要或裁剪破坏其内容边界。</p>
     *
     * <p>当前设计：
     * <ul>
     *   <li>系统提示词通过 systemPromptBuf 维护，不在消息列表中压缩</li>
     *   <li>工具定义由 Dialect 层（如 AnthropicRequestBuilder）在构建请求时添加 cache_control</li>
     *   <li>此方法仅在开启缓存时输出调试日志，帮助验证缓存策略是否正确生效</li>
     * </ul>
     * </p>
     *
     * @param trace        当前 ReAct 追踪
     * @param systemPrompt 系统提示词内容（可能为 null）
     */
    private void markStaticContextBoundary(ReActTrace trace, String systemPrompt) {
        // 通过 ChatModel -> ChatConfigReadonly -> ChatOptions 获取缓存配置
        // 链路上任一环节都可能为 null（子代理/测试场景下未必绑定模型），
        // 而本方法在 onReasonStart 首行调用，一旦 NPE 会直接打断整轮推理。
        CacheControl cacheControl = null;
        try {
            ChatModel model = trace.getOptions().getChatModel();
            if (model != null && model.getConfig() != null) {
                cacheControl = model.getConfig().getCacheControl();
            }
        } catch (Exception e) {
            if (log.isDebugEnabled()) {
                log.debug("ReActAgent [{}] resolve cacheControl failed: {}", trace.getAgentName(), e.getMessage());
            }
            return;
        }

        if (cacheControl != null && log.isDebugEnabled()) {
            // 静态上下文就绪：不修改消息内容，仅输出调试信息
            // Dialect 层在构建 HTTP 请求时会根据 ChatOptions 中的 cacheControl/promptCacheKey
            // 自动在系统提示词和工具定义上添加 cache_control 标记
            String cacheType = (cacheControl.getType() != null)
                    ? "Anthropic cache_control=" + cacheControl.getType()
                    : "OpenAI prompt_cache_key=" + cacheControl.getPromptCacheKey();
            log.debug("ReActAgent [{}] static context boundary marked for LLM prompt caching ({})",
                    trace.getAgentName(), cacheType);
        }
    }

    private void pushContextChunk(ReActTrace trace, int msgCount, int tokenCount,
                                  boolean compressed,
                                  int beforeMessageCount, int afterMessageCount,
                                  int beforeTokenCount, int afterTokenCount) {
        try {
            FluxSink<AgentChunk> sink = trace.getOptions().getStreamSink();
            if (sink != null && !sink.isCancelled()) {
                sink.next(new ContextSizeChunk(trace, msgCount, tokenCount, compressed,
                        beforeMessageCount, afterMessageCount,
                        beforeTokenCount, afterTokenCount));
            }
        } catch (Exception e) {
            if (log.isDebugEnabled()) {
                log.debug("ReActAgent [{}] failed to push ContextChunk: {}",
                        trace.getAgentName(), e.getMessage());
            }
        }
    }
}