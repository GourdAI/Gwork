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
import org.noear.solon.ai.AiUsage;
import com.gourdai.agent.AgentChunk;
import com.gourdai.agent.react.AbsReActInterceptor;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.trace.UsageNormalizer;
import org.noear.solon.ai.chat.ChatResponse;
import org.noear.solon.ai.chat.message.AssistantMessage;
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
 * {@link AiUsage}（含缓存创建/读取），换算出「输入（含缓存）」并推送一个 {@link ContextUsageChunk}，
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

        pushUsageChunk(trace, inputTokens, outputTokens, cacheCreation, cacheRead, cacheRate, messageCount);
    }

    private void pushUsageChunk(ReActTrace trace,
                                long inputTokens, long outputTokens,
                                long cacheCreation, long cacheRead, double cacheRate,
                                int messageCount) {
        try {
            FluxSink<AgentChunk> sink = trace.getOptions().getStreamSink();
            if (sink != null && !sink.isCancelled()) {
                sink.next(new ContextUsageChunk(trace, inputTokens, outputTokens,
                        cacheCreation, cacheRead, cacheRate, messageCount));
            }
        } catch (Exception e) {
            if (LOG.isDebugEnabled()) {
                LOG.debug("Failed to push ContextUsageChunk: {}", e.getMessage());
            }
        }
    }
}
