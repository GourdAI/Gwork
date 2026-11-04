package com.gourdai.harness.agent;

import com.gourdai.agent.event.AbsAgentEvent;
import com.gourdai.agent.react.ReActTrace;

/**
 * 重试状态事件：模型调用失败后、即将再次尝试时，向用户侧推送一次重试提示。
 *
 * <p>由 {@link RetryNotifyInterceptor} 在每次失败尝试后生成，让前端能感知到
 * "正在重试第 N/M 次"的中间状态，并携带上一次尝试的真实失败原因
 * （如供应商返回体中的 error.message），避免用户只看到干巴巴的「模型调用失败」。</p>
 *
 * @author oisin
 */
public class RetryEvent extends AbsAgentEvent {
    /** 当前是第几次尝试（从 1 开始） */
    private final int attempt;
    /** 最大尝试次数（即用户配置的模型重试次数） */
    private final int maxRetries;
    /** 上一次尝试失败的原因摘要（供应商返回的真实错误，可为 null 表示未知） */
    private final String reason;

    public RetryEvent(ReActTrace trace, int attempt, int maxRetries) {
        this(trace, attempt, maxRetries, null);
    }

    public RetryEvent(ReActTrace trace, int attempt, int maxRetries, String reason) {
        super(trace.getRunId(), trace.getAgentName(), trace.getSession(), null);

        this.attempt = attempt;
        this.maxRetries = maxRetries;
        this.reason = reason;
    }

    public int getAttempt() {
        return attempt;
    }

    public int getMaxRetries() {
        return maxRetries;
    }

    /**
     * @return 上一次尝试失败的原因摘要（如「HTTP 400: No tool output found for tool call ...」）；未知时为 null
     */
    public String getReason() {
        return reason;
    }

    /**
     * 组装用户可见的重试提示文案（各端统一真源，避免多处硬编码同一句话）。
     */
    public static String formatText(int attempt, int maxRetries) {
        return formatText(attempt, maxRetries, null);
    }

    /**
     * 组装带失败原因的重试提示文案：原因非空时以「：」接续展示。
     */
    public static String formatText(int attempt, int maxRetries, String reason) {
        String base = "模型调用失败，正在重试 " + attempt + "/" + maxRetries;
        if (reason == null || reason.isEmpty()) {
            return base + " ...";
        }
        return base + "：" + reason;
    }

    /**
     * 组装本事件的重试提示文案。
     */
    public String toText() {
        return formatText(attempt, maxRetries, reason);
    }
}
