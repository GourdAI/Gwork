package com.gourdai.harness.agent;

import com.gourdai.agent.event.AbsAgentEvent;
import com.gourdai.agent.react.ReActTrace;

/**
 * 重试状态事件：模型调用失败后、即将再次尝试时，向用户侧推送一次重试提示。
 *
 * <p>由 {@link RetryNotifyInterceptor} 在每次失败尝试后生成，让前端能感知到
 * "正在重试第 N/M 次"的中间状态。</p>
 *
 * @author oisin
 */
public class RetryEvent extends AbsAgentEvent {
    /** 当前是第几次尝试（从 1 开始） */
    private final int attempt;
    /** 最大尝试次数（即用户配置的模型重试次数） */
    private final int maxRetries;

    public RetryEvent(ReActTrace trace, int attempt, int maxRetries) {
        super(trace.getRunId(), trace.getAgentName(), trace.getSession(), null);

        this.attempt = attempt;
        this.maxRetries = maxRetries;
    }

    public int getAttempt() {
        return attempt;
    }

    public int getMaxRetries() {
        return maxRetries;
    }

    /**
     * 组装用户可见的重试提示文案（各端统一真源，避免多处硬编码同一句话）。
     */
    public static String formatText(int attempt, int maxRetries) {
        return "模型调用失败，正在重试 " + attempt + "/" + maxRetries + " ...";
    }

    /**
     * 组装本事件的重试提示文案。
     */
    public String toText() {
        return formatText(attempt, maxRetries);
    }
}
