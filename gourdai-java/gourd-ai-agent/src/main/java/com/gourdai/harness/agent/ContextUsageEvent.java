package com.gourdai.harness.agent;

import com.gourdai.agent.event.ContextSizeEvent;

import com.gourdai.agent.event.AbsAgentEvent;
import com.gourdai.agent.react.ReActTrace;

/**
 * 上下文用量事件：每轮推理结束后，依据模型返回的真实 usage 向用户侧推送当前上下文的真实 token 用量。
 *
 * <p>由 {@link ContextUsageInterceptor} 在 {@code onReasonEnd} 生成，携带本轮的真实输入/输出，
 * 以及 Prompt Caching 的缓存创建/读取明细，供前端展示「上下文长度」与每条回复的用量。</p>
 *
 * <p>与 {@code ContextSizeEvent} 的区别：后者是推理<b>前</b>用 jtokkit 本地<b>估算</b>、仅供框架内部
 * 做压缩决策；本事件是推理<b>后</b>的<b>真实</b>用量，用于对用户展示。</p>
 *
 * @author oisin
 */
public class ContextUsageEvent extends AbsAgentEvent {
    /** 输入 token（已按方言口径归一：含缓存部分） */
    private final long inputTokens;
    /** 输出 token */
    private final long outputTokens;
    /** 缓存创建输入 token（Prompt Caching：本次写入缓存的 token） */
    private final long cacheCreationTokens;
    /** 缓存读取输入 token（Prompt Caching：本次命中缓存、按折扣计费的 token） */
    private final long cacheReadTokens;
    /** 缓存命中率（百分比 0~100，= cacheReadTokens / inputTokens） */
    private final double cacheRate;
    /** 当前上下文的消息数（仅供展示） */
    private final int messageCount;

    public ContextUsageEvent(ReActTrace trace,
                             long inputTokens, long outputTokens,
                             long cacheCreationTokens, long cacheReadTokens,
                             double cacheRate,
                             int messageCount) {
        super(trace.getRunId(), trace.getAgentName(), trace.getSession(), null);

        this.inputTokens = inputTokens;
        this.outputTokens = outputTokens;
        this.cacheCreationTokens = cacheCreationTokens;
        this.cacheReadTokens = cacheReadTokens;
        this.cacheRate = cacheRate;
        this.messageCount = messageCount;
    }

    public long getInputTokens() {
        return inputTokens;
    }

    public long getOutputTokens() {
        return outputTokens;
    }

    public long getCacheCreationTokens() {
        return cacheCreationTokens;
    }

    public long getCacheReadTokens() {
        return cacheReadTokens;
    }

    public double getCacheRate() {
        return cacheRate;
    }

    public int getMessageCount() {
        return messageCount;
    }
}
