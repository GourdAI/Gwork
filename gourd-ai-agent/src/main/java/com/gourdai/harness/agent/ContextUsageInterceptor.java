/*
 * Copyright 2017-2026 noear.org and authors
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
package com.gourdai.harness.agent;

import com.gourdai.core.portal.web.UsageSubmissionService;
import com.gourdai.ai.AiUsage;
import com.gourdai.agent.event.AgentEvent;
import com.gourdai.agent.react.AbsReActInterceptor;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.task.ReasonTask;
import com.gourdai.agent.trace.UsageNormalizer;
import com.gourdai.ai.chat.ChatResponse;
import com.gourdai.ai.chat.message.AssistantMessage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.publisher.FluxSink;

/**
 * 真实用量采集拦截器。
 *
 * <p><b>背景：</b>输入框上方的「上下文长度」指示器原先展示的是
 * {@code ContextCompressionInterceptor} 在推理<b>前</b>用 jtokkit <b>本地估算</b>的 token 数，
 * 与模型实际计费口径无关；而框架的 {@code Metrics} 又在累加时丢弃了缓存明细，
 * 导致每条回复的 trace 行只显示「未命中缓存的增量」（开启 Prompt Caching 后常是个位数）。
 *
 * <p><b>职责：</b>在每一轮推理<b>结束后</b>（{@link #onReasonEnd}）读取模型返回的真实
 * {@link AiUsage}（含缓存创建/读取），换算出「输入（含缓存）」并推送一个 {@link ContextUsageEvent}，
 * 让指示器改用真实用量刷新——不再显示估算值。
 *
 * <p><b>口径归一：</b>不同接口规范（及不同框架版本）对「输入 token 是否含缓存」的口径不同，
 * 统一交由 {@link UsageNormalizer#normalizeInputTokens} 按数值自洽性判定（不依赖方言、不依赖依赖版本），
 * 并据此计算缓存命中率，详见该类注释。
 *
 * <p><b>无状态约束：</b>拦截器按 class 注册为全局单例，故不使用任何实例可变字段；
 * 所有状态都通过 {@link ReActTrace}（每会话/每任务一份）承载。
 *
 * @author oisin
 */
public class ContextUsageInterceptor extends AbsReActInterceptor {
    private static final Logger LOG = LoggerFactory.getLogger(ContextUsageInterceptor.class);

    /** 上一轮模型返回的真实输入 token（含缓存），供压缩拦截器校准本地估算 */
    public static final String CTX_LAST_REAL_INPUT_TOKENS = "ctx:last_real_input_tokens";
    /** 上述真实用量对应的消息条数（用于判断校准值是否过期） */
    public static final String CTX_LAST_REAL_MESSAGE_COUNT = "ctx:last_real_message_count";

    @Override
    public void onReasonEnd(ReActTrace trace, ChatResponse resp, AssistantMessage message, long durationMs) {
        if (resp == null) {
            return;
        }

        AiUsage usage = resp.getUsage();
        if (usage == null) {
            return;
        }
        try {
            UsageSubmissionService.recordSafely(trace.getOptions().getChatModel().getModel(), usage, System.currentTimeMillis());
        } catch (Throwable e) {
            // Metrics and chat rendering must not depend on telemetry.
        }

        long cacheCreation = usage.cacheCreationInputTokens();
        long cacheRead = usage.cacheReadInputTokens();
        long inputTokens = UsageNormalizer.normalizeInputTokens(usage.promptTokens(), cacheCreation, cacheRead);
        long outputTokens = usage.completionTokens();
        double cacheRate = UsageNormalizer.cacheHitRate(inputTokens, cacheRead);

        int messageCount = 0;
        try {
            if (trace.getWorkingMemory() != null && trace.getWorkingMemory().getMessages() != null) {
                messageCount = trace.getWorkingMemory().getMessages().size();
            }
        } catch (Exception ignore) {
            // 消息数仅用于展示，取不到不影响用量推送
        }

        // ⭐ 回灌真实用量给压缩决策：
        //    压缩拦截器用 jtokkit 本地估算，与模型实际计费口径存在偏差（不同 tokenizer、
        //    供应商额外开销等）。这里把上一轮的真实 input_tokens 存入 trace，
        //    供下一轮 onReasonStart 作为校准锚点，使触发判据贴合真实计费。
        try {
            trace.setExtra(CTX_LAST_REAL_INPUT_TOKENS, inputTokens);
            trace.setExtra(CTX_LAST_REAL_MESSAGE_COUNT, messageCount);
        } catch (Exception ignore) {
            // 校准仅为优化，失败时回退到纯本地估算
        }

        pushContextUsageEvent(trace, inputTokens, outputTokens, cacheCreation, cacheRead, cacheRate, messageCount);

        // 重试开销旁注：紧跟在真实（计费）用量采集点之后打出，两个数字同处一眼可见
        logRetryOverhead(trace, inputTokens, outputTokens);
    }

    /**
     * 把本回合的「重试额外开销」打在真实用量旁边。
     *
     * <p><b>为何在这里打</b>：本拦截器是真实计费用量的采集点（上一行就是写
     * {@code events.jsonl} 的 {@code UsageSubmissionService#record}）。物理重试的失败尝试
     * 同样被上游计费，历史上却从不进入这条采集链，于是「账本只记成功那一次」。
     * 在同一位置把两个口径并排打出，偏差直接可对账。</p>
     *
     * <p><b>计量与未计量必须分开说</b>：上游在 429/5xx 时常仍返回 usage 块（可计量），
     * 但在 400/403 这类<b>直接拒收请求</b>的确定性错误上根本不返回 usage（不可计量）。
     * 后者不能当作「0 开销」读，否则隐形支出会被误读为免费，故额外打出
     * {@code unmeasuredAttempts} 与 {@code estimatedPromptTokens}（估算值，带
     * {@code estimated} 前缀，绝不与计量值混列）。</p>
     *
     * <p><b>不污染既有口径</b>：只读 {@link ReActTrace} extras 并打日志，<b>不</b>调
     * {@code UsageSubmissionService}（重试用量的上报已由 {@code ReasonTask#recordRetryUsage}
     * 在成功与终态失败两条路径上完成，此处再调会重复计入）、<b>不</b>改
     * {@link ContextUsageEvent}（它驱动的是输入框上方的「上下文长度」指示器，
     * 掺入重试 token 会直接扭曲展示值）、不动任何 {@code inputTokens}/{@code outputTokens} 的计算。</p>
     */
    private void logRetryOverhead(ReActTrace trace, long inputTokens, long outputTokens) {
        try {
            Number attempts = trace.getExtraAs(ReasonTask.ATTR_RETRY_ATTEMPTS);
            Number retryPrompt = trace.getExtraAs(ReasonTask.ATTR_RETRY_PROMPT_TOKENS);
            Number retryCompletion = trace.getExtraAs(ReasonTask.ATTR_RETRY_COMPLETION_TOKENS);
            Number unmeasured = trace.getExtraAs(ReasonTask.ATTR_RETRY_UNMEASURED_ATTEMPTS);
            Number estimatedPrompt = trace.getExtraAs(ReasonTask.ATTR_RETRY_ESTIMATED_PROMPT_TOKENS);
            Number logicalRetries = trace.getExtraAs(ReasonTask.ATTR_LOGICAL_RETRIES);

            boolean hasPhysical = attempts != null && attempts.intValue() > 0;
            boolean hasLogical = logicalRetries != null && logicalRetries.intValue() > 0;
            if (hasPhysical == false && hasLogical == false) {
                // 健康回合（绝大多数）恒为零日志、零开销
                return;
            }

            LOG.warn("Usage[{}] billed input={} output={}; retry overhead (already recorded to the usage ledger when measured):"
                            + " physicalRetries={} measuredRetryPromptTokens={} measuredRetryCompletionTokens={}"
                            + " unmeasuredAttempts={} estimatedRetryPromptTokens={} logicalRetries={}",
                    trace.getOptions().getChatModel().getModel(), inputTokens, outputTokens,
                    hasPhysical ? attempts.intValue() : 0,
                    retryPrompt == null ? 0L : retryPrompt.longValue(),
                    retryCompletion == null ? 0L : retryCompletion.longValue(),
                    unmeasured == null ? 0 : unmeasured.intValue(),
                    estimatedPrompt == null ? 0L : estimatedPrompt.longValue(),
                    hasLogical ? logicalRetries.intValue() : 0);
        } catch (Exception e) {
            if (LOG.isDebugEnabled()) {
                LOG.debug("Failed to log retry overhead: {}", e.getMessage());
            }
        }
    }

    private void pushContextUsageEvent(ReActTrace trace,
                                long inputTokens, long outputTokens,
                                long cacheCreation, long cacheRead, double cacheRate,
                                int messageCount) {
        try {
            FluxSink<AgentEvent> sink = trace.getOptions().getStreamSink();
            if (sink != null && !sink.isCancelled()) {
                sink.next(new ContextUsageEvent(trace, inputTokens, outputTokens,
                        cacheCreation, cacheRead, cacheRate, messageCount));
            }
        } catch (Exception e) {
            if (LOG.isDebugEnabled()) {
                LOG.debug("Failed to push ContextUsageEvent: {}", e.getMessage());
            }
        }
    }
}
