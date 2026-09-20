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
package com.gourdai.agent.react.task;

import com.gourdai.agent.event.ReasonDeltaEvent;
import com.gourdai.agent.event.ReasonEndEvent;
import com.gourdai.agent.event.ToolCallArgsDeltaEvent;
import com.gourdai.agent.event.ToolCallDraftEvent;

import com.gourdai.agent.react.*;
import org.noear.solon.Utils;
import com.gourdai.agent.Agent;
import com.gourdai.agent.event.AgentEvent;
import com.gourdai.agent.exception.LlmNoReturnException;
import com.gourdai.agent.util.AgentUtil;
import com.gourdai.agent.util.ChatEventSupport;
import com.gourdai.ai.AiUsage;
import com.gourdai.ai.chat.ChatRequestDesc;
import com.gourdai.ai.chat.ChatResponse;
import com.gourdai.ai.chat.LlmErrorMessages;
import com.gourdai.ai.chat.event.ChatEventType;
import com.gourdai.ai.chat.message.AssistantMessage;
import com.gourdai.ai.chat.message.ChatMessage;
import com.gourdai.ai.chat.tool.ToolCall;
import com.gourdai.ai.util.RetryTask;
import com.gourdai.core.portal.web.UsageSubmissionService;
import org.noear.solon.core.util.Assert;
import org.noear.solon.core.util.RankEntity;
import org.noear.solon.flow.FlowContext;
import org.noear.solon.lang.Nullable;
import org.noear.solon.lang.Preview;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.publisher.FluxSink;

import java.time.Duration;
import java.util.*;
import java.util.concurrent.TimeoutException;

/**
 * ReAct 推理任务 (Reasoning)
 * <p>核心职责：组装上下文发起请求，解析模型意图（Action/Final Answer），并执行路由分发。</p>
 *
 * @author oisin
 * @since 3.8.1
 */
@Preview("3.8.1")
public class ReasonTask {
    private static final Logger LOG = LoggerFactory.getLogger(ReasonTask.class);

    /** 流式阶段累积的思考投影前缀（含方言标签帧），存于当前 trace，供剥离时精确匹配 */
    public static final String ATTR_STREAMED_REASONING = "gourd_streamed_reasoning_prefix";

    /**
     * 流式阶段累积的<b>原始</b>思考文本（未经 {@code </think>} 规范化截断），存于当前 trace。
     *
     * <p>与 {@link #ATTR_STREAMED_REASONING} 的区别：后者为正文剥离服务，已按末思考帧截掉
     * {@code </think>} 之后的正文头，不再与聚合思考逐字相等；而聚合思考去重需要
     * <b>严格同源</b>的锚，故单独保留一份未加工值。</p>
     */
    public static final String ATTR_STREAMED_THINKING_RAW = "gourd_streamed_thinking_raw";

    /**
     * 最近一次模型调用失败的根因摘要（{@code callWithRetry} 的重试监听器写入）。
     *
     * <p>供 {@code RetryNotifyInterceptor} 在推送「正在重试」提示时带出真实失败原因
     * （如供应商返回体中的 error.message），替代原先千篇一律的「模型调用失败」。
     * 成功返回或终态失败后即清除，不残留进会话快照。</p>
     */
    public static final String ATTR_LAST_MODEL_ERROR = "gourd_last_model_error";

    /**
     * 本回合物理重试中「失败尝试」的次数（{@code callWithRetry} 回合结束时写入）。
     *
     * <p>与成功回合的 usage 口径完全独立：失败尝试的响应本会被 {@code handleLastException}
     * 丢弃，既有三条账本（Metrics / 用量拦截器 / trace 行）只记成功那一次，
     * 于是上游照常计费的重试开销在本地不可见。此组注记只做可见性，不参与任何计费口径。</p>
     */
    public static final String ATTR_RETRY_ATTEMPTS = "gourd_retry_attempts";

    /** 本回合失败尝试累计的 prompt token（独立维度，严禁并入成功回合 usage） */
    public static final String ATTR_RETRY_PROMPT_TOKENS = "gourd_retry_prompt_tokens";

    /** 本回合失败尝试累计的 completion token（独立维度，严禁并入成功回合 usage） */
    public static final String ATTR_RETRY_COMPLETION_TOKENS = "gourd_retry_completion_tokens";

    /**
     * 本回合失败尝试中「上游<b>未返回 usage 块</b>」的次数。
     *
     * <p><b>为何必须单独注出：</b>HTTP 400/403 这类确定性错误是供应商<b>直接拒收请求</b>，
     * 响应体里根本没有 usage（实测：此时 {@code ChatStreamSession#getTotalUsage()} 为 null），
     * 因此 {@link #ATTR_RETRY_PROMPT_TOKENS} 会如实停在 0——但那<b>不等于</b>没有开销，
     * 请求体已完整上行、上游照常计费。只看到「重试 20 次 / token 0」会把隐形支出误读为
     * 「重试不花钱」，故用本字段明确标注「这 N 次无法测量」。<b>诚实优先于好看的数字。</b></p>
     *
     * @since 4.1
     */
    public static final String ATTR_RETRY_UNMEASURED_ATTEMPTS = "gourd_retry_unmeasured_attempts";

    /**
     * 未测量失败尝试的「上下文规模<b>估算</b>」累计（= 估算锚点 × 未测量次数）。
     *
     * <p><b>这是估算值，不是计量值</b>，故与 {@link #ATTR_RETRY_PROMPT_TOKENS} 严格分字段存放，
     * 绝不合并、也绝不上报进计费账本；仅用于回答「这 20 次白跑大致烧了多少上下文」。
     * 锚点取上一轮的真实 input token（详见 {@link #resolveContextScaleEstimate}）；
     * 首轮无锚点时本值为 0，此时仍可由 {@link #ATTR_RETRY_UNMEASURED_ATTEMPTS} 看出重试规模。</p>
     *
     * @since 4.1
     */
    public static final String ATTR_RETRY_ESTIMATED_PROMPT_TOKENS = "gourd_retry_estimated_prompt_tokens";

    /**
     * 上一轮真实输入 token（含缓存）的 trace 键，用作重试开销的估算锚点。
     *
     * <p><b>刻意不引用 {@code ContextUsageInterceptor#CTX_LAST_REAL_INPUT_TOKENS}</b>：
     * harness 依赖 agent 是既定方向，反向 import 会制造包级循环依赖，故此处同值副本；
     * 两处必须保持一致（改动任一处请同步另一处）。</p>
     */
    private static final String ATTR_LAST_REAL_INPUT_TOKENS = "ctx:last_real_input_tokens";

    /**
     * 本回合之前已发生的「逻辑重试」次数（模型返回空内容时追加提示重进 Reason）。
     *
     * <p>逻辑重试的每一轮都是成功请求、都会正常记账，但它会往 WorkingMemory 追加提示消息，
     * 使后续每轮 prompt 单调增长——成本被放大却无任何计数可查，故单独注出。
     * 与物理重试的字段刻意区分开，二者语义不同、不可相加。</p>
     */
    public static final String ATTR_LOGICAL_RETRIES = "gourd_logical_retries";

    /**
     * 工具参数进度下发的时间阈值（毫秒）。
     * <p>模型分片粒度极细（一篇文档可产生上千片），逐片下发会压垮传输与渲染，
     * 故按「时间或字节」双阈值合并，先到者触发。</p>
     */
    private static final long ARGS_PROGRESS_INTERVAL_MS = 200L;

    /** 工具参数进度下发的字节阈值。 */
    private static final int ARGS_PROGRESS_BYTES = 4096;

    /** 模型未配置网络超时的默认值（与 {@code AiConfig.timeout} 保持一致） */
    private static final Duration DEFAULT_STREAM_IDLE_TIMEOUT = Duration.ofSeconds(120);

    /**
     * 流式无活动兜底超时相对模型网络超时的宽限期（秒）。
     * <p>让上游 {@code internalStream} 的同语义超时先按正常路径传播，本层只在它失效时兜底。</p>
     */
    private static final long STREAM_IDLE_GRACE_SECONDS = 30;

    /**
     * 单次流式请求的总时长上限（{@code blockLast} 硬兜底）。
     * <p>正常长流（深度思考）也应在数十分钟内完成；超过此值基本可断定链路已挂死
     * （Reactor parallel 调度线程饥饿、传播链阻塞等 {@code Flux.timeout} 无法覆盖的场景）。
     * {@code blockLast(Duration)} 走纯 JDK latch 计时，不依赖任何 Reactor 调度器。
     * 误杀代价是重试一次；不兜底的代价是整会话永久僵尸——两害相权取其轻。</p>
     */
    private static final Duration STREAM_TOTAL_CAP = Duration.ofMinutes(30);

    /**
     * 一次 Reason 回合「含所有重试」的总时长预算（{@code RetryTask.totalDeadline}）。
     *
     * <p><b>为何需要：</b>{@link #STREAM_TOTAL_CAP} 只管<b>单次尝试</b>，重试框架只有
     * 「次数 × 单次上限」的隐式上界，默认 maxRetries=3 时理论最坏 ≈ 3 × 30min ≈ 90 分钟，
     * 用户侧表现为「任务像死了一样」。</p>
     *
     * <p><b>取值推导：</b>取 min(单次上限 × 重试次数, 绝对上限) = min(30min × 3, 45min) = 45min。
     * 下界必须<b>明显宽于</b>单次上限 30min（否则会把正常的长回答误杀），上界取 45min
     * 是“用户愿意等待”的工程上限。</p>
     *
     * <p><b>为何不误伤正常长任务：</b></p>
     * <ol>
     *   <li>预算<b>从不打断进行中的尝试</b>，只在「发起下一次尝试前」与「退避等待前」裁决；</li>
     *   <li>首次尝试永不受约束，而任何单次尝试本身已被 STREAM_TOTAL_CAP(30min) 封顶，
     *       45min &gt; 30min ⇒ 一个正常完成的长回答（含深度思考）永远不会碰到本预算；</li>
     *   <li>快速失败场景（如秒级报错）总耗时远小于 45min，3 次重试一次不少，行为完全不变；</li>
     *   <li>实际收益：尝试①最多 30min，尝试②开始时耗时 ≤ 30min+退避 &lt; 45min 故放行，
     *       结束时耗时已 &gt; 45min ⇒ 尝试③被否决。即最坏耗时从 ≈ 90min 收口到 ≈ 60min，
     *       且仍保留「两次完整长尝试」的自愈机会。</li>
     * </ol>
     */
    private static final Duration REASON_RETRY_TOTAL_DEADLINE = Duration.ofMinutes(45);

    /**
     * 单个工具调用的参数生成进度跟踪器（仅存活于一次流式请求内）。
     *
     * <p>分片协议只在首片携带 {@code id}/{@code name}，后续分片会退化，
     * 故在首片登记后，后续增量一律从这里取回稳定的 actionId 与 toolName。</p>
     */
    private static final class ArgsProgress {
        private String actionId;
        private String toolName;
        /** 累计已生成的参数字符数 */
        private long bytes;
        /** 上次下发时刻 */
        private long lastEmitAt;
        /** 上次下发时的累计字节数 */
        private long lastEmitBytes;
    }

    /**
     * 单个 Reason 回合内「物理重试额外开销」的累计器（纯观测，不参与任何控制流）。
     *
     * <p><b>与成功口径严格隔离</b>：成功尝试的用量由 {@code RESPONSE_END} 走既有账本，
     * 本累计器只收<b>失败尝试</b>，字段独立命名，绝不回灌进既有 usage 统计。</p>
     *
     * <p><b>计量 / 未计量双轨（@since 4.1）</b>：失败尝试分两种结局——上游返回了 usage 块
     * （429/5xx 常见）则计入 {@code promptTokens} 等<b>计量字段</b>并上报账本；上游直接拒收请求
     * （400/403，响应体无 usage）则计入 {@code unmeasuredAttempts} 与
     * {@code estimatedPromptTokens} 这两个<b>估算字段</b>，绝不把估算值混进计量字段。</p>
     *
     * <p><b>生命周期</b>：每次 {@code callWithRetry} 新建一个实例（方法局部 final 变量），
     * 随方法栈销毁，不跨回合；尝试级中间态 {@code pendingUsage} 在每次尝试开始时重置，
     * 不跨重试。写侧为流线程（{@code doOnNext}）与调用线程（{@code blockLast} 返回后），
     * 二者之间由 {@code blockLast} 建立 happens-before，无需额外同步。</p>
     * <p><b>可见性</b>：类与字段均为<b>包级</b>而非 private，唯一目的是让同包的
     * {@code RetryCostLedgerTest} 能直接断言累计结果（计量/未计量分轨是本修复的核心不变量，
     * 必须可测）；外部包仍不可见，不构成 API 扩张。</p>
     */
    static final class RetryCostLedger {
        /** 已确认失败的物理尝试次数（不含最终成功的那一次） */
        int attempts;
        //---- 计量字段：仅来自上游真实返回的 usage 块，可直接上报计费账本 ----
        long promptTokens;
        long completionTokens;
        long thinkTokens;
        long cacheCreationTokens;
        long cacheReadTokens;
        //---- 估算字段：上游未返回 usage 时的如实标注，严禁并入上方计量字段 ----
        /** 拿不到 usage 的失败尝试次数 */
        int unmeasuredAttempts;
        /** 上述尝试的上下文规模估算累计（锚点 × 次数） */
        long estimatedPromptTokens;
        /**
         * 单次请求的上下文规模估算锚点，由 {@code callWithRetry} 在回合开始时注入一次。
         * 取不到锚点时为 0——此时只记次数、不猜数字。
         */
        long contextTokensEstimate;

        /** 当前尝试观测到的最近一份用量快照：尝试成功则丢弃，失败才结算 */
        private AiUsage pendingUsage;
        /** 当前尝试是否仍未收口（既未判失败、也未判成功） */
        private boolean attemptOpen;

        /**
         * 新一次物理尝试开始。
         *
         * <p>上一次尝试若仍未收口，必然是失败的——成功会直接从 lambda 返回、不会再进来一次。
         * 这条兜底覆盖「失败但没有 ERROR 事件」的场景（外层 idle-timeout、blockLast 硬兜底、
         * 非流式 {@code req.call()} 直接抛异常）。</p>
         */
        void beginAttempt() {
            closeFailedAttempt();
            attemptOpen = true;
            pendingUsage = null;
        }

        /**
         * 观测一份用量快照（{@code USAGE} 帧）。
         *
         * <p>只暂存、不立即计入：是否计入完全由本次尝试的最终结局决定，
         * 因此与 {@code RESPONSE_END} 不存在重复计入。</p>
         */
        void observeUsage(AiUsage usage) {
            if (usage != null) {
                pendingUsage = usage;
            }
        }

        /** 当前尝试失败（{@code ERROR}，与 {@code RESPONSE_END} 互斥）：优先用事件自带 usage，缺失时回落到 USAGE 快照 */
        void failAttempt(AiUsage usage) {
            observeUsage(usage);
            closeFailedAttempt();
        }

        /** 当前尝试成功：用量归既有账本，此处只丢弃快照 */
        void succeedAttempt() {
            attemptOpen = false;
            pendingUsage = null;
        }

        /** 把仍未收口的尝试记为失败并结算（终态失败时由调用侧兜底调用） */
        void closeFailedAttempt() {
            if (!attemptOpen) {
                return;
            }

            attemptOpen = false;
            attempts++;

            AiUsage usage = pendingUsage;
            pendingUsage = null;

            //未计量分支：usage 缺失（400/403 被直接拒收，响应体无 usage 块）或全零（结构存在但无信息）。
            //此时绝不伪造 token 数——只如实记下「有一次无法测量的重试」及其上下文规模估算，
            //让隐形支出至少以「次数 + 规模」的形态可见，而不是伪装成 0 开销。
            if (isUnmeasured(usage)) {
                unmeasuredAttempts++;
                estimatedPromptTokens += Math.max(0L, contextTokensEstimate);
                return;
            }

            promptTokens += Math.max(0L, usage.promptTokens());
            completionTokens += Math.max(0L, usage.completionTokens());
            thinkTokens += Math.max(0L, usage.thinkTokens());
            //缓存明细必须一并累计：UsageSubmissionService#record 以
            //「prompt < cache 合计则相加」还原输入口径，漏掉这两项会低估重试的真实输入 token
            cacheCreationTokens += Math.max(0L, usage.cacheCreationInputTokens());
            cacheReadTokens += Math.max(0L, usage.cacheReadInputTokens());
        }

        /** 计量字段是否有任何非零值（用于决定本次重试用量是否值得上报账本） */
        boolean hasMeasuredTokens() {
            return promptTokens > 0 || completionTokens > 0 || thinkTokens > 0
                    || cacheCreationTokens > 0 || cacheReadTokens > 0;
        }
    }

    /**
     * 该 usage 是否「不含任何可计量信息」。
     *
     * <p>两种情形等价对待：①{@code null}——上游直接拒收请求（400/403），
     * 实测此时 {@code ChatStreamSession#getTotalUsage()} 为 null，ERROR 事件也就没有 usage；
     * ②结构存在但各计数全为 0——同样无从得知真实消耗。两者都<b>不得</b>被当成「消耗为 0」，
     * 而应记为「未测量」。</p>
     */
    private static boolean isUnmeasured(AiUsage usage) {
        if (usage == null) {
            return true;
        }
        return usage.promptTokens() <= 0
                && usage.completionTokens() <= 0
                && usage.thinkTokens() <= 0
                && usage.totalTokens() <= 0
                && usage.cacheCreationInputTokens() <= 0
                && usage.cacheReadInputTokens() <= 0;
    }

    private final ReActAgentConfig config;
    private final ReActAgent agent;

    public ReasonTask(ReActAgentConfig config, ReActAgent agent) {
        this.config = config;
        this.agent = agent;
    }

    public String name() {
        return ReActAgent.ID_REASON;
    }

    public void run(ReActTrace trace, FlowContext context) throws Throwable {
        if(Agent.ID_END.equals(trace.getRoute())){
            //有可能在 action 的拦截里，要求终止
            return;
        }

        if (LOG.isDebugEnabled()) {
            if (trace.getOptions().isPlanningMode()) {
                String planDesc = "";
                if (trace.hasPlans() && trace.getPlanIndex() < trace.getPlans().size()) {
                    planDesc = " | Plan[" + (trace.getPlanIndex() + 1) + "]: " + trace.getPlans().get(trace.getPlanIndex());
                }
                LOG.debug("ReActAgent [{}] reasoning... Turn: {}/{}{}",
                        config.getName(), trace.getTurnCount() + 1, trace.getOptions().getMaxTurns(), planDesc);
            } else {
                LOG.debug("ReActAgent [{}] reasoning... Turn: {}/{}",
                        config.getName(), trace.getTurnCount() + 1, trace.getOptions().getMaxTurns());
            }
        }

        // --- 优化点 1: 回合计数逻辑简化 ---
        int currentTurn = trace.nextTurn();
        int maxTurns = trace.getOptions().getMaxTurns();

        // --- 优化点 2: 统一流控逻辑，移除硬熔断 ---
        // 逻辑更加扁平化：要么进入 AutoRethink 机制，要么直接达到 maxTurns 熔断
        if (trace.getOptions().isAutoRethink()) {
            // [AutoRethink 模式]
            // 达到 80% 回合数时提前介入，留出 20% 的 buffer 让模型执行自审和策略调整
            int thresholdTurn = Math.max(maxTurns - 1, (int) (maxTurns * 0.8));

            if (currentTurn >= thresholdTurn) {
                // 自动扩展回合数上限（续航）
                int addTurns = Math.max(10, trace.getOptions().getInitialMaxTurns() / 2);
                trace.getOptions().addMaxTurns(addTurns);
                LOG.info("ReActAgent [{}] auto-rethink triggered. New maxTurns: {}", config.getName(), trace.getOptions().getMaxTurns());

                String rethinkPrompt = String.format(
                                "【系统指令：自我反思 (Self-Reflection)】\n" +
                                "当前任务已执行至第 %d 回合。为了确保任务准确高效完成，请立即启动自审程序：\n\n" +
                                "1. **核心目标检查**：重新审视用户最初提出的核心问题和当前要解决的任务，评估你当前的方向是否偏离了主线？\n" +
                                "2. **有效性评估**：检查历史 Observation。如果最近的尝试没有带来有效新线索，说明当前策略已失效，请必须更换思路或换个角度切入。\n" +
                                "3. **强制收敛**：若评估判定由于客观限制确实无法达成，请梳理已知线索，并在 Final Answer 中向用户复盘并申请协助。\n\n" +
                                "根据新策略决定下一步行动，或输出 Final Answer 结束任务",
                        currentTurn
                );

                trace.getWorkingMemory().addMessage(ChatMessage.ofUser(rethinkPrompt));
                LOG.info("ReActAgent [{}] auto-rethink triggered at turn {}", config.getName(), currentTurn);
            }
        } else {
            // [标准模式]
            // --- 优化点 3: 严格边界判定 ---
            if (currentTurn > maxTurns) {
                LOG.warn("ReActAgent [{}] reached max turns: {}", config.getName(), maxTurns);
                trace.setRoute(Agent.ID_END);
                trace.setFinalAnswer("Agent error: Maximum turns reached (" + maxTurns + ").");
                return;
            }
        }

        // [逻辑 2: 提示词工程] 融合系统角色、执行计划、输出格式约束及协议指令
        StringBuilder systemPromptBuf = new StringBuilder();
        String baseSp = config.getSystemPromptFor(trace, context);
        if (baseSp != null) {
            systemPromptBuf.append(baseSp);
        }

        if (trace.getOptions().isPlanningMode() && trace.hasPlans()) {
            systemPromptBuf.append("\n\n[执行计划进度看板]\n");

            List<String> plans = trace.getPlans();
            int currIdx = trace.getPlanIndex();
            int total = plans.size();

            for (int i = 0; i < total; i++) {
                String status = (i < currIdx) ? "[√] " : (i == currIdx ? "[●] " : "[ ] ");
                systemPromptBuf.append(i + 1).append(". ").append(status).append(plans.get(i)).append("\n");
            }

            systemPromptBuf.append("\n**计划进度同步协议 (Plan Sync Protocol)：**\n");
            if (currIdx < total) {
                int currentStepNum = currIdx + 1;
                int nextStepNum = currIdx + 2;

                systemPromptBuf.append("- **当前状态**: 你正在执行步骤 [").append(currentStepNum).append("]。\n");
                systemPromptBuf.append("- **正常推进**: 步骤完成后，若结果符合预期，必须调用 `update_plan_progress` 并将 `next_plan_index` 设为 `").append(nextStepNum).append("` ");

                if (currIdx == total - 1) {
                    systemPromptBuf.append("(标志所有计划已达成)。\n");
                } else {
                    systemPromptBuf.append("(切换至下一环节)。\n");
                }

                // 新增：修订引导，防止盲目推进
                systemPromptBuf.append("- **动态调整**: 若观察结果（Observation）显示原计划已不可行，必须优先调用 `revise_plan` 修正后续步骤，严禁强行进入错误环节。\n");
                systemPromptBuf.append("- **禁止跳步**: 在更新进度前，禁止直接提供最终回答。");
            } else {
                systemPromptBuf.append("- **目标达成**: 计划看板已全部标记为 [√]。请综合上述执行过程中的所有观察结果，直接给出最终的详细回答。");
            }
        }

        if (trace.getSession().isPending()) {
            // 如果是从挂起状态恢复（例如 HITL 后继续）
            systemPromptBuf.append("\n\n[Human-In-The-Loop Context]\n" +
                    "用户已对你的执行流程进行了审核并准许继续。请结合最新的 Observation 反馈调整你的下一步策略。");
        }

        if (Assert.isNotEmpty(trace.getOptions().getOutputSchema())) {
            trace.getOptions().getChatModel().getDialect().prepareOutputSchemaInstruction(
                    trace.getOptions().getOutputSchema(),
                    systemPromptBuf);
        }

        if (trace.getProtocol() != null) {
            trace.getProtocol().injectAgentInstruction(context, agent, config.getLocale(),
                    systemPromptBuf);
        }

        if (LOG.isDebugEnabled()) {
            LOG.debug("ReActAgent SystemPrompt rendered for trace [{}]: {}", trace.getAgentName(), systemPromptBuf);
        }


        // [逻辑 2.1: 工具配对自愈] 发送前的协议归一：工作记忆里若残留「已声明但无结果」的
        // 原生工具调用（挂起/中断的历史遗留、旧快照恢复等），供应商会直接拒绝整次请求
        // （如 400 No tool output found for tool call ...）且重试无法自愈。此处补齐合成结果；
        // 健康流程恒为空操作。ask_user 挂起且答案已提交时，按正常恢复语义回填答案并清理现场。
        // 必须先于 2.2 的拦截器（压缩器）执行：压缩器会把「已声明但无结果」的不完整配对整对丢弃，
        // 先自愈补齐，挂起答案才能以完整配对形态存活；否则答案既不回填，残留的答案键还会
        // 污染下一次 ask_user（AskUserInterceptor 先读答案后校验题面，旧答案会顶掉新问题）。
        ToolCallPairRepair.repair(trace);

        // [逻辑 2.2: 上下文预处理] 在消息组装前触发，允许拦截器压缩 WorkingMemory
        for (RankEntity<ReActInterceptor> entity : trace.getOptions().getInterceptors()) {
            if (entity.target.isEnabled()) {
                entity.target.onReasonStart(trace, systemPromptBuf);
            }
        }

        if (Agent.ID_END.equals(trace.getRoute())) {
            return;
        }

        String systemPromptStr = systemPromptBuf.toString();

        // [逻辑 2.3: 后台任务完成通知] 把已完成的后台命令以消息形式注入工作记忆。
        // 这是「系统主动告知」替代「模型轮询」的落点：模型不再需要反复调用 bash_output 询问
        // “跑完了没”，从而避免每次轮询都沉淀一条消息在历史里、再被后续每轮全量重发放大 token 成本。
        // 置于消息组装之前，保证本轮请求就能看到通知；也覆盖“上一回合已结束、任务在空闲期完成”的场景。
        injectBackgroundNotices(trace);

        List<ChatMessage> messages = new ArrayList<>();
        messages.add(ChatMessage.ofSystem(systemPromptStr));
        messages.addAll(trace.getWorkingMemory().getMessages());

        // [逻辑 3: 模型交互] 执行物理请求并触发模型响应相关的拦截器
        long startMs = System.currentTimeMillis();
        ChatResponse response = callWithRetry(trace, messages);
        if(response == null || trace.getSession().isPending()){
            trace.setRoute(Agent.ID_END);
            return;
        }

        AssistantMessage aggregatedMessage = response.getMessage();

        if(aggregatedMessage == null){
            trace.setRoute(Agent.ID_END);
            return;
        }

        // 聚合思考去重：方言的「补齐未交付思考」兜底经中转后幂等失效，补发走
        // acc.addContentItem(...) 同时灌进聚合器，使本条消息的 thinking 成为「全文 × N」
        // （N 取决于命中哪条补发路径）。流式侧的重放抑制只能管住屏幕，管不到聚合值；
        // 而本条消息会被原对象写入工作记忆并在下一轮全量重发，不治则重复份额全额计入
        // 上下文压缩预算（压缩提前触发）并随会话历史落盘（详见
        // AgentUtil#dedupeAggregatedThinking）。必须赶在拦截器/事件/历史写入之前归一，
        // 以保证全部下游只能看到单份思考。
        final AssistantMessage responseMessage = AgentUtil.dedupeAggregatedThinking(
                aggregatedMessage, trace.getExtraAs(ATTR_STREAMED_THINKING_RAW));

        // 部分接口（openai-responses）流式聚合时把推理文本混入 content，
        // 统一在此剥离，避免下游（最终答案/历史消息/IM）与思考通道重复渲染；
        // 优先用流式累积的思考前缀做精确剥离（思考内引用 </think> 字面量时启发式会切错位置）
        final String streamedReasoningPrefix = trace.getExtraAs(ATTR_STREAMED_REASONING);
        final String resultContent = AgentUtil.getAggregatedResultContent(responseMessage, streamedReasoningPrefix);

        if (response.getUsage() != null) {
            trace.getMetrics().addUsage(response.getUsage());
        }

        // 触发推理审计事件（传递原始消息对象）
        long durationMs = System.currentTimeMillis() - startMs;
        for (RankEntity<ReActInterceptor> item : trace.getOptions().getInterceptors()) {
            item.target.onReasonEnd(trace, response, responseMessage, durationMs);
        }

        if(trace.getSession().isPending()){
            return;
        }

        // 容错处理：模型响应内容及工具调用均为空时，引导其重新生成
        if (Assert.isEmpty(resultContent) && Assert.isEmpty(responseMessage.getToolCalls())) {
            if (trace.getEmptyRetryCounter().incrementAndGet() < 3) {
                //做3次重复
                // 逻辑重试成本可见性：本轮是成功请求、已正常记账，但下面会往 WorkingMemory
                // 追加提示消息，使后续每轮 prompt 单调增长。把「第几次逻辑重试 + 本轮 usage」
                // 打出来，让这部分被放大的成本不再隐形（触发条件与 3 次上限均未改动）。
                int logicalRetry = trace.getEmptyRetryCounter().get();
                String logicalRetryUsage = response.getUsage() == null
                        ? "n/a"
                        : ("prompt=" + response.getUsage().promptTokens()
                        + " / completion=" + response.getUsage().completionTokens());
                LOG.warn("ReActAgent[{}] responseMessage is empty (logicalRetry {}/3, this round usage {}): {}",
                        trace.getAgentName(), logicalRetry, logicalRetryUsage, responseMessage);

                if (Assert.isNotEmpty(responseMessage.getContent())) {
                    trace.getWorkingMemory().addMessage(responseMessage); //有些 llm 不能接受空消息
                    int retryCount = trace.getEmptyRetryCounter().get();
                    String formatFixPrompt = String.format(
                            "【系统指令：输出格式修正 (Format Correction)】\n" +
                            "您在第 %d 轮中输出了思考内容，但未包含有效的行动（Action）或最终答案（Final Answer）（第 %d 次尝试）。\n\n" +
                            "请检查您最近的 Observation 和之前的思考链，确保下一步操作或最终结论已明确给出。",
                            currentTurn, retryCount
                    );
                    trace.getWorkingMemory().addMessage(ChatMessage.ofUser(formatFixPrompt));
                } else {
                    // 反思机制：模型返回完全空响应（无内容、无工具调用）时， 通过自我反思提示引导模型回溯任务目标、审视历史轨迹并重新输出
                    int retryCount = trace.getEmptyRetryCounter().get();
                    String reflectPrompt = String.format(
                            "【系统指令：自我反思 (Self-Reflection)】\n" +
                            "您在第 %d 轮推理中返回了空响应（第 %d 次尝试），请立即启动自我反思：\n\n" +
                            "1. **回溯任务目标**：重新审视您最初被分配的任务核心目标，检查是否偏离了主线。\n" +
                            "2. **审视历史轨迹**：回顾最近的 Observation 和之前的思考链，定位导致空响应的原因。\n" +
                            "3. **策略修正**：若当前路径受阻，请果断切换思路或拆分为更小的子任务推进。\n",
                            currentTurn, retryCount
                    );
                    trace.getWorkingMemory().addMessage(ChatMessage.ofUser(reflectPrompt));
                }

                trace.setRoute(ReActAgent.ID_REASON);
            }

            return;
        } else {
            trace.getEmptyRetryCounter().set(0);
        }

        // [逻辑 3.5: 思考事件] 提取思考内容并触发 onThought 事件
        final String clearContent = resultContent;
        final String thoughtContent;

        if (trace.getConfig().getStyle() == ReActStyle.NATIVE_TOOL) {
            // 原生工具模式：思考只来自真实思考通道（4.1 起为 getThinking()）；通道为空即本轮无思考。
            // 不得回退把整段正文当思考——那会制造「伪思考」：ReasonEndEvent.getThinking() 与
            // getText() 装同一份正文，子代理补发路径会把正文重复渲染进思考通道（同文三帧的源头）。
            thoughtContent = Utils.isNotEmpty(responseMessage.getThinking())
                    ? responseMessage.getThinking()
                    : "";
        } else {
            // 文本结构模式：按 ReAct 协议 "Thought:" 解析
            thoughtContent = extractThought(clearContent);
        }

        // 触发思考事件（合并原 onReasonEnd + onThought）
        for (RankEntity<ReActInterceptor> item : trace.getOptions().getInterceptors()) {
            item.target.onThought(trace, thoughtContent, responseMessage);
        }

        if(trace.getSession().isPending()){
            return;
        }

        if(trace.getOptions().getStreamSink() != null){
            // 思考（thoughtContent）与正文（clearContent）分别传入，由 ReasonEndEvent 的
            // getThinking() / getText() 两个独立 getter 暴露，消费方不会再取错。
            trace.getOptions().getStreamSink().next(new ReasonEndEvent(trace, response, responseMessage, thoughtContent, clearContent));
        }

        trace.setLastReasonMessage(responseMessage);

        // [逻辑 4: 路由分发 - 基于原生工具调用协议]
        if (Assert.isNotEmpty(responseMessage.getToolCalls())) {
            trace.setRoute(ReActAgent.ID_ACTION);
            return;
        }

        // [逻辑 5: 路由判断 - 文本 ReAct 协议解析]
        if (trace.getConfig().getStyle() == ReActStyle.NATIVE_TOOL) {
            if (Assert.isNotEmpty(clearContent)) {
                trace.setRoute(Agent.ID_END);
                trace.setFinalAnswer(clearContent, false);
                return;
            }
        }

        // [逻辑 6: 决策流控]

        // 决策基准采用 clearContent，确保不受 <think> 标签内干扰词影响

        // 1. 优先判断任务是否结束（Finish）
        if (clearContent.contains(config.getFinishMarker())) {
            trace.setRoute(Agent.ID_END);
            trace.setFinalAnswer(extractFinalAnswer(clearContent), false);
            return;
        }

        // 2. 其次判断文本形式的工具执行意图（Action: { ... }）
        if (clearContent.contains("Action:")) {
            String actionPart = clearContent.substring(clearContent.indexOf("Action:"));
            if (actionPart.length() > 7) {
                trace.setRoute(ReActAgent.ID_ACTION);
                return;
            }
        }

        // 3. 兜底逻辑：既无明确工具调用也无完成标识，视为直接回复 Final Answer
        trace.setRoute(Agent.ID_END);
        trace.setFinalAnswer(extractFinalAnswer(clearContent), false);
    }

    /**
     * 把已完成的后台任务通知注入工作记忆。
     *
     * <p>只读取已存在的归属键（peekOwner）：从未启动过后台任务的会话直接短路返回，
     * 不产生任何开销，也不白白生成归属键。</p>
     *
     * <p>用 user 角色而非 system：部分模型供应商对历史中段出现 system 消息兼容性差，
     * user 消息在各方言下都能稳定插入。</p>
     */
    private void injectBackgroundNotices(ReActTrace trace) {
        String owner = BackgroundNoticeCenter.peekOwner(trace.getContext());
        if (Assert.isEmpty(owner)) {
            return;
        }

        List<BackgroundNoticeCenter.Notice> notices = BackgroundNoticeCenter.drain(owner);
        if (notices.isEmpty()) {
            return;
        }

        for (BackgroundNoticeCenter.Notice notice : notices) {
            trace.getWorkingMemory().addMessage(ChatMessage.ofUser(notice.render()));
        }

        if (LOG.isDebugEnabled()) {
            LOG.debug("ReActAgent [{}] injected {} background completion notice(s)",
                    config.getName(), notices.size());
        }
    }

    private @Nullable ChatResponse callWithRetry(ReActTrace trace, List<ChatMessage> messages) throws RuntimeException {
        ChatRequestDesc req = trace.getOptions().getChatModel()
                .prompt(messages)
                .options(o -> {
                    o.agentName(trace.getAgentName());

                    if (trace.getConfig().getStyle() == ReActStyle.NATIVE_TOOL) {
                        o.toolAdd(trace.getOptions().getTools());
                        o.toolAdd(trace.getProtocolTools());
                    }

                    o.autoToolCall(false); // 强制由 Agent 框架接管工具链路管理
                    o.toolContextPut(trace.getOptions().getToolContext());

                    for(RankEntity<ReActInterceptor> entity :  trace.getOptions().getInterceptors()) {
                        //内部已支持启用控制
                        o.interceptorAdd(entity.index, entity.target);
                    }

                    if (trace.getOptions().getOutputSchema() != null) {
                        trace.getOptions().getChatModel().getDialect().prepareOutputFormatOptions(o);
                    }

                    o.optionSet(trace.getOptions().getModelOptions().options());

                    // 缓存配置：Agent 级优先，ChatModel 级次之
                    if(trace.getOptions().getCacheControl() != null) {
                        o.cacheControl(trace.getOptions().getCacheControl());
                    }
                });

        int maxRetries = trace.getOptions().getMaxRetries();

        // 本回合（单次 callWithRetry）的物理重试开销累计器：随本方法栈生存，回合结束上报后
        // 随栈销毁，天然不跨回合；尝试级中间态由 beginAttempt 在每次物理尝试开始时重置，
        // 天然不跨重试（与 streamedReasoningBuf 的「lambda 内 final 局部变量」同源思路，
        // 只是生命周期需覆盖整个重试序列，故提升一层到方法局部）。
        final RetryCostLedger retryCost = new RetryCostLedger();
        //估算锚点每回合解析一次即可：同一回合内各次重试上行的上下文规模基本相同，
        //且锚点来自上一轮的真实计量值，本轮内不会变化。
        retryCost.contextTokensEstimate = resolveContextScaleEstimate(trace);

        // 先清上一回合的注记：累计量必须严格对应单个回合，不得残留
        clearRetryCostExtras(trace);

        try {
            ChatResponse result = new RetryTask()
                    .maxRetries(maxRetries)
                    .initialDelayMs(trace.getOptions().getRetryDelayMs())
                    .totalDeadline(REASON_RETRY_TOTAL_DEADLINE)
                    .onRetry((attempt,e)->{
                        LOG.warn("ReActAgent [{}] retry {}/{} due to: {}",
                                config.getName(), attempt, maxRetries, e.toString());
                        // 记录根因摘要：供下一次重试提示（RetryNotifyInterceptor）展示真实失败原因
                        trace.setExtra(ATTR_LAST_MODEL_ERROR, LlmErrorMessages.describe(e));
                    })
                    .callWithRetry(() -> {
                                // 每次物理尝试的起点：顺带把「上一次尝试未收口即失败」的情况结算掉
                                retryCost.beginAttempt();

                                final ChatResponse response;
                                if (trace.getOptions().getStreamSink() != null) {
                                    final FluxSink<AgentEvent> sink = trace.getOptions().getStreamSink();

                                    if (sink.isCancelled()) {
                                        return null;
                                    }

                                    // 逐帧累积思考投影（含方言的 <think>/</think> 标签帧）：
                                    // 聚合 content 由同一批帧按序拼接，此前缀可用于无歧义定位正文起点，
                                    // 修复思考文本内部引用 </think> 字面量时启发式剥离切错位置导致的思考泄漏
                                    final StringBuilder streamedReasoningBuf = new StringBuilder();
                                    final int[] lastThinkingFrameStart = {-1};
                                    final ChatResponse[] finalResponse = {null};
                                    // 工具参数生成进度：按「分片聚合键」跟踪。本 Map 随 lambda 每次物理重试重建，
                                    // 无需手动清理（与 streamedReasoningBuf 同理）。
                                    final Map<String, ArgsProgress> argsProgresses = new LinkedHashMap<>();
                                    // 每次物理重试都是独立响应，不能沿用上一尝试的思考前缀。
                                    trace.removeExtra(ATTR_STREAMED_REASONING);
                                    trace.removeExtra(ATTR_STREAMED_THINKING_RAW);

                                    // 双层超时兜底（2026-09-18 桌面版「长时间等待响应」事故）：
                                    // 上游 internalStream 的无活动超时确实会触发并打日志，但其错误信号必须
                                    // 穿过 ChatRequestDescDefault 内部的 concatMap 才能到达本处 blockLast，
                                    // 传播链上任一同步环节（如 SSE 网络线程上的 emitToClient：会话锁/写盘/
                                    // 套接字写）被长期阻塞时，错误会被无限挂起，run 永不终结、前端永远
                                    // 停在等待态。两层防御：
                                    // 1) 本层 timeout：相邻事件间隔语义（活跃流不误杀），其错误在 parallel
                                    //    调度线程上直达 blockLast 的 latch，不经任何 concatMap；
                                    // 2) blockLast 总时长上限：纯 JDK latch 计时，连调度器饥饿也能兜住。
                                    // 任一触发都以异常终结本次尝试，交由 RetryTask 重试或收尾。
                                    Duration modelTimeout = trace.getOptions().getChatModel().getConfig().getTimeout();
                                    if (modelTimeout == null || modelTimeout.isZero() || modelTimeout.isNegative()) {
                                        modelTimeout = DEFAULT_STREAM_IDLE_TIMEOUT;
                                    }
                                    final Duration streamIdleCap = modelTimeout.plusSeconds(STREAM_IDLE_GRACE_SECONDS);

                                    req.stream()
                                            .timeout(streamIdleCap)
                                            .takeUntil(event -> sink.isCancelled())
                                            .doOnNext(event -> {
                                                if (sink.isCancelled()) {
                                                    return;
                                                }

                                                if (event.is(ChatEventType.RESPONSE_END)) {
                                                    finalResponse[0] = event.getResponse();
                                                    return;
                                                }

                                                // [失败尝试用量捕获 —— 纯观测，刻意不 return]
                                                // 不短路后续分支，保证本分支之外的既有行为（含末尾的
                                                // ChatEventSupport.message 下发）逐字不变。
                                                //
                                                // USAGE：携带本次尝试的累计用量快照。只暂存，成功尝试的
                                                // 快照会在 succeedAttempt 处被丢弃 → 与 RESPONSE_END 不重复计入。
                                                if (event.is(ChatEventType.USAGE)) {
                                                    retryCost.observeUsage(event.getUsage());
                                                }

                                                // ERROR：失败尝试的终止事件（与 RESPONSE_END 互斥），其 usage 为
                                                // 上游 streamSession 的累计值，已含失败前打捞到的 partial usage。
                                                if (event.is(ChatEventType.ERROR)) {
                                                    retryCost.failAttempt(event.getUsage());
                                                }

                                                // 工具调用首片：模型刚说出函数名，参数尚在生成中。此刻提前下发草稿帧，
                                                // 让订阅方先把骨架卡建出来，消除「大参数生成期零反馈」的盲区。
                                                // 降级：端点未给 id 或 name 时不登记也不下发，行为完全退回原有链路。
                                                if (event.is(ChatEventType.TOOL_CALL_START)) {
                                                    ToolCall call = ChatEventSupport.toolCall(event);
                                                    String progressKey = ChatEventSupport.toolCallKey(event);
                                                    if (call != null && progressKey != null
                                                            && Assert.isNotEmpty(call.getId())
                                                            && Assert.isNotEmpty(call.getName())) {
                                                        ArgsProgress progress = new ArgsProgress();
                                                        progress.actionId = call.getId();
                                                        progress.toolName = call.getName();
                                                        progress.lastEmitAt = System.currentTimeMillis();
                                                        argsProgresses.put(progressKey, progress);

                                                        sink.next(new ToolCallDraftEvent(trace, progress.toolName, progress.actionId));
                                                    }
                                                    return;
                                                }

                                                // 参数增量：只累加字节数、不转发内容（完整参数由随后的
                                                // ToolCallStartEvent.getArgs() 提供）。双阈值节流，避免上千帧风暴。
                                                if (event.is(ChatEventType.TOOL_CALL_ARGS_DELTA)) {
                                                    String progressKey = ChatEventSupport.toolCallKey(event);
                                                    ArgsProgress progress = progressKey == null ? null : argsProgresses.get(progressKey);
                                                    if (progress != null) {
                                                        progress.bytes += ChatEventSupport.argsDeltaLength(event);

                                                        long now = System.currentTimeMillis();
                                                        if (now - progress.lastEmitAt >= ARGS_PROGRESS_INTERVAL_MS
                                                                || progress.bytes - progress.lastEmitBytes >= ARGS_PROGRESS_BYTES) {
                                                            progress.lastEmitAt = now;
                                                            progress.lastEmitBytes = progress.bytes;

                                                            sink.next(new ToolCallArgsDeltaEvent(trace, progress.toolName,
                                                                    progress.actionId, progress.bytes));
                                                        }
                                                    }
                                                    return;
                                                }

                                                // 参数拼接完成：节流可能吞掉最后一段，此处强制补发一帧以保证终值准确。
                                                if (event.is(ChatEventType.TOOL_CALL_END)) {
                                                    String progressKey = ChatEventSupport.toolCallKey(event);
                                                    ArgsProgress progress = progressKey == null ? null : argsProgresses.remove(progressKey);
                                                    if (progress != null && progress.bytes > progress.lastEmitBytes) {
                                                        sink.next(new ToolCallArgsDeltaEvent(trace, progress.toolName,
                                                                progress.actionId, progress.bytes));
                                                    }
                                                    return;
                                                }

                                                if (event.is(ChatEventType.THINKING_DELTA) && event.hasText()) {
                                                    String thinkingText = event.getText();

                                                    // 终态重放抑制：方言在流末尾「补齐未交付思考」的兜底经中转后幂等失效，
                                                    // 会把整段思考当成新增量再发一次（详见 AgentUtil#isThinkingReplay）。
                                                    // 抑制既不下发也不累积：前者根治所有 portal 的思考重复输出，后者保证
                                                    // 本前缀与真实思考严格同形（否则前缀变「全文×2」，正文剥离的定位失准）。
                                                    if (AgentUtil.isThinkingReplay(streamedReasoningBuf, thinkingText)) {
                                                        LOG.debug("ReActAgent [{}] thinking replay suppressed ({} chars)",
                                                                config.getName(), thinkingText.length());
                                                        return;
                                                    }

                                                    lastThinkingFrameStart[0] = streamedReasoningBuf.length();
                                                    streamedReasoningBuf.append(thinkingText);
                                                }

                                                AssistantMessage delta = ChatEventSupport.message(event);
                                                if (delta != null) {
                                                    sink.next(new ReasonDeltaEvent(trace, null, delta));
                                                }
                                            }).blockLast(STREAM_TOTAL_CAP);
                                    response = finalResponse[0];

                                    if (streamedReasoningBuf.length() > 0) {
                                        String streamedThinkingRaw = streamedReasoningBuf.toString();
                                        // 原始值：供聚合思考去重做锚，必须与上游 thinkingBuilder 逐字同源，不得截断
                                        trace.setExtra(ATTR_STREAMED_THINKING_RAW, streamedThinkingRaw);

                                        String streamedReasoningPrefix = AgentUtil.normalizeStreamedReasoningPrefix(
                                                streamedThinkingRaw, lastThinkingFrameStart[0]);
                                        trace.setExtra(ATTR_STREAMED_REASONING, streamedReasoningPrefix);
                                    } else {
                                        trace.removeExtra(ATTR_STREAMED_REASONING);
                                        trace.removeExtra(ATTR_STREAMED_THINKING_RAW);
                                    }
                                } else {
                                    response = req.call();
                                }

                                if (response == null || response.isEmpty()) {
                                    throw new LlmNoReturnException("The LLM did not return");
                                }

                                return response;
                            }
                    );

            // 最后一次尝试成功：它的用量归既有账本，不计入重试开销
            retryCost.succeedAttempt();

            // 成功即清：失败根因只服务于「正在重试」提示，不残留进会话快照
            trace.removeExtra(ATTR_LAST_MODEL_ERROR);

            reportRetryCost(trace, retryCost, true);
            return result;
        } catch (Throwable e) {
            // 终态失败：最后一次尝试可能没有 ERROR 事件（外层 idle-timeout / blockLast 兜底 /
            // 非流式直接抛异常），在此兜底收口，保证「重试耗尽」这条原本完全不可见的路径
            // 也能把开销上报出去——这正是本可见性改动的核心场景。
            retryCost.closeFailedAttempt();
            reportRetryCost(trace, retryCost, false);

            // 4. 异常后续处理
            return handleLastException(trace, e);
        }
    }

    /**
     * 回合结束时上报「重试开销」（成功与终态失败两条路径都会走到）。
     *
     * <p><b>计量口径（修正）：</b>失败尝试的响应会被丢弃，但上游<b>照常计费</b>，
     * 这笔钱必须进账本，否则本地统计恒低于真实支出（实测某会话重发 token 上界达账面支出的
     * 118.7%，即账本连实际消耗都覆盖不住）。按能否测得分两种情形如实处理：</p>
     * <ul>
     *   <li><b>测得用量</b>（部分网关在 429/5xx 仍返回 usage 块）：累加进
     *       {@code gourd_retry_prompt_tokens}/{@code gourd_retry_completion_tokens}，
     *       并经 {@link UsageSubmissionService#recordSafely} 走<b>既有上报链路</b>写入
     *       {@code events.jsonl}；</li>
     *   <li><b>未测得用量</b>（HTTP 400/403 等确定性错误：供应商直接拒收请求，响应体里没有
     *       usage 块）：<b>绝不伪造数字</b>，只如实记录「未测量次数 + 上下文规模估算」，
     *       计量字段保持为真实的 0，也不向账本上报任何估算值。</li>
     * </ul>
     *
     * <p><b>不会重复计入</b>：成功尝试的用量在 {@code succeedAttempt} 处已被本累计器丢弃，
     * 只经 {@code RESPONSE_END} 走既有账本；本方法上报的恒为<b>失败尝试</b>的独立一条事件。
     * 成功路径的既有记账行为逐字不变。</p>
     *
     * @param succeeded 本回合最终是否拿到了响应
     */
    private void reportRetryCost(ReActTrace trace, RetryCostLedger retryCost, boolean succeeded) {
        int logicalRetries = 0;
        try {
            logicalRetries = trace.getEmptyRetryCounter().get();
        } catch (Exception ignore) {
            // 计数仅用于展示，取不到不影响主链路
        }

        if (retryCost.attempts > 0) {
            LOG.warn("ReActAgent [{}] retry cost this turn: physicalRetries={}, measured extra tokens prompt={} / completion={} / thinking={},"
                            + " unmeasuredAttempts={} (upstream returned no usage block; estimated re-uploaded context={} tokens in total),"
                            + " logicalRetries={}, outcome={}.",
                    config.getName(), retryCost.attempts, retryCost.promptTokens,
                    retryCost.completionTokens, retryCost.thinkTokens,
                    retryCost.unmeasuredAttempts, retryCost.estimatedPromptTokens,
                    logicalRetries,
                    succeeded ? "succeeded-after-retry" : "failed-after-retries-exhausted");
        }

        try {
            if (retryCost.attempts > 0) {
                trace.setExtra(ATTR_RETRY_ATTEMPTS, retryCost.attempts);
                trace.setExtra(ATTR_RETRY_PROMPT_TOKENS, retryCost.promptTokens);
                trace.setExtra(ATTR_RETRY_COMPLETION_TOKENS, retryCost.completionTokens);
                //未计量部分单独存放：计量字段不得被估算值污染，反之也不得因「测不到」而隐藏重试规模
                trace.setExtra(ATTR_RETRY_UNMEASURED_ATTEMPTS, retryCost.unmeasuredAttempts);
                trace.setExtra(ATTR_RETRY_ESTIMATED_PROMPT_TOKENS, retryCost.estimatedPromptTokens);
            }

            if (logicalRetries > 0) {
                trace.setExtra(ATTR_LOGICAL_RETRIES, logicalRetries);
            }
        } catch (Exception ignore) {
            // 可见性附加项，写不进去也不影响主链路
        }

        recordRetryUsage(trace, retryCost);
    }

    /**
     * 把<b>真实测得</b>的重试用量写入既有计费上报链路（{@code events.jsonl}）。
     *
     * <p><b>为何在这里上报而不靠 {@code ContextUsageInterceptor}</b>：本方法在「成功」与
     * 「重试耗尽后终态失败」两条路径上都会执行，而 {@code onReasonEnd} 只在成功时触发——
     * 恰恰是重试烧穿的那个场景（本回合根本没有成功响应）会漏记。
     * 依赖方向有先例：{@code SimpleAgent} 与 {@code SupervisorTask} 已直接调用本服务。</p>
     *
     * <p><b>宁缺勿伪</b>：未测得任何真实用量时直接返回，只留 extras 与日志——
     * 把估算值伪装成计量值上报会直接污染计费口径，比留白危害更大。</p>
     */
    private void recordRetryUsage(ReActTrace trace, RetryCostLedger retryCost) {
        if (retryCost.hasMeasuredTokens() == false) {
            return;
        }

        try {
            //只携真实测得的字段；totalTokens 刻意不设——各供应商口径不一（是否含 think/cache），
            //而上报链路（{@code UsageSubmissionService#record}）本就自行由 prompt+cache 还原输入口径
            AiUsage retryUsage = AiUsage.builder()
                    .promptTokens(retryCost.promptTokens)
                    .thinkTokens(retryCost.thinkTokens)
                    .completionTokens(retryCost.completionTokens)
                    .cacheCreationInputTokens(retryCost.cacheCreationTokens)
                    .cacheReadInputTokens(retryCost.cacheReadTokens)
                    .build();

            UsageSubmissionService.recordSafely(
                    trace.getOptions().getChatModel().getModel(), retryUsage, System.currentTimeMillis());
        } catch (Throwable e) {
            // 记账失败绝不能影响主链路（与 ContextUsageInterceptor 的既有口径一致）
            LOG.debug("Unable to record retry usage: {}", e.getMessage());
        }
    }

    /**
     * 解析「本次请求上下文规模」的估算锚点，<b>仅</b>用于上游未返回 usage 的失败尝试。
     *
     * <p><b>为何用上一轮的真实 input token、而不当场重新估算：</b></p>
     * <ol>
     *   <li><b>准确性</b>：锚点是供应商真实计费过的数字（{@code ContextUsageInterceptor} 写入），
     *       而 jtokkit 本地估算与真实计费口径存在系统性偏差（不同 tokenizer + 供应商额外开销）；</li>
     *   <li><b>成本</b>：重跑本地估算意味着对每个失败尝试重新编码整个上下文——
     *       实测末轮上下文达 579,657 tokens，20 次重试就是 20 次全量编码，
     *       为了「估算一个估算值」再烧几十秒 CPU 是本末倒置；</li>
     *   <li><b>贴合度</b>：同一回合内各次重试上行的是<b>同一份</b>上下文，而上下文在会话内
     *       单调增长，故上一轮的真实值是本轮规模的可靠下界近似。</li>
     * </ol>
     *
     * <p>首轮无锚点（或取值失败）时返回 0：此时仍会如实记下未测量次数，<b>不猜数字</b>。</p>
     */
    private static long resolveContextScaleEstimate(ReActTrace trace) {
        try {
            Number lastRealInputTokens = trace.getExtraAs(ATTR_LAST_REAL_INPUT_TOKENS);
            if (lastRealInputTokens != null && lastRealInputTokens.longValue() > 0) {
                return lastRealInputTokens.longValue();
            }
        } catch (Exception ignore) {
            // 取不到锚点时估算值为 0：宁可留白，不把不可靠的猜测当估算上报
        }
        return 0L;
    }

    /** 清理上一回合的重试开销注记：累计量严格对应单个 Reason 回合，不得跨回合残留 */
    private void clearRetryCostExtras(ReActTrace trace) {
        trace.removeExtra(ATTR_RETRY_ATTEMPTS);
        trace.removeExtra(ATTR_RETRY_PROMPT_TOKENS);
        trace.removeExtra(ATTR_RETRY_COMPLETION_TOKENS);
        trace.removeExtra(ATTR_RETRY_UNMEASURED_ATTEMPTS);
        trace.removeExtra(ATTR_RETRY_ESTIMATED_PROMPT_TOKENS);
        trace.removeExtra(ATTR_LOGICAL_RETRIES);
    }

    private ChatResponse handleLastException(ReActTrace trace, Throwable lastException) {
        if(lastException.getMessage() == null && lastException.getCause() != null){
            lastException = lastException.getCause();
        }

        if (lastException instanceof InterruptedException || lastException.getCause() instanceof InterruptedException) {
            LOG.debug("InterruptedException");
            return null;
        } else {
            LOG.warn("ReActAgent [{}] call failed", config.getName(), lastException);
        }

        // 设置故障状态并终止路由
        trace.setRoute(Agent.ID_END);
        trace.removeExtra(ATTR_LAST_MODEL_ERROR);

        if (lastException instanceof LlmNoReturnException) {
            trace.setFinalAnswer("抱歉，模型服务没有内容返回。请稍后重试。");
        } else if (lastException instanceof TimeoutException ||
                lastException.getCause() instanceof TimeoutException) {
            trace.setFinalAnswer("抱歉，模型服务响应超时。请稍后重试。");
        } else {
            // 直接展示供应商返回的真实错误（状态码 + 返回体 error.message），
            // 替代原先携带异常类全名与 URL 的裸异常串
            trace.setFinalAnswer("抱歉，模型服务调用失败：" + LlmErrorMessages.describe(lastException) + "。请稍后重试。");
        }

        return null;
    }

    /**
     * 文本结构模式下按 ReAct 协议解析 "Thought:" 段，获取纯净思考主体。
     *
     * <p>原生工具模式（NATIVE_TOOL）的思考只来自真实思考通道，不适用本方法——旧实现曾把
     * 整段正文当作思考回退值返回，是「伪思考」与同文三帧重复记录的源头，已移除。</p>
     */
    private String extractThought(String clearContent) {
        if (Utils.isEmpty(clearContent)) {
            return "";
        }

        String result;
        int labelIndex = clearContent.indexOf(THOUGHT_LABEL);
        if(labelIndex < 0){
            return "";
        }

        result = clearContent.substring(labelIndex + THOUGHT_LABEL.length()).trim();

        labelIndex = result.indexOf("\nAction:");
        if (labelIndex > -1) {
            result = result.substring(0, labelIndex).trim();
        }

        return result;
    }

    /**
     * 清理推理过程，从思考片段中提取最终业务答案
     */
    private String extractFinalAnswer(String clearContent) {
        if (Utils.isEmpty(clearContent)) {
            return "";
        }

        String answer = clearContent;
        String marker = config.getFinishMarker();

        int markerIndex = answer.indexOf(marker);
        if (markerIndex < 0) {
            /**
             * 示例："\n\nThought: 用户想要转账500元给老张，但是缺少必需的收款人银行卡号信息，需要向用户询问。\nAction: 我需要向用户询问老张的银行卡号，因为这是执行转账操作的必需参数。"
             * */
            marker = "Action:";
            markerIndex = answer.indexOf(marker);
        }

        if (markerIndex < 0) {
            return "";
        }

        answer = answer.substring(markerIndex + marker.length()).trim();
        return answer;
    }

    private static final String THOUGHT_LABEL = "Thought:";
}