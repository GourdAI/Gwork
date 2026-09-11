package com.gourdai.harness.agent;

import com.gourdai.agent.event.AbsAgentEvent;

/**
 * 子代理结束事件
 * <p>
 * 用于在流式模式下，向父代理的 FluxSink 推送「子代理已结束」信号。
 * 下游流构建器（如 WebStreamBuilder）据此生成 agent_end 类型的 WebChunk，
 * 供前端将"智能体"徽章卡片转为完成态。
 * </p>
 *
 * <p>继承 {@link AbsAgentEvent} 的理由与 {@link AgentStartEvent} 相同：TaskTalent 会对流过的
 * 每个事件无条件写 {@code getMeta().put("__parentAgentName", ...)}，返回不可变空 Map 会在
 * 嵌套委派时抛 {@code UnsupportedOperationException}。</p>
 *
 * @author oisin
 */
public class AgentEndEvent extends AbsAgentEvent {
    private final String description;
    private final boolean success;
    private final String resultSummary;
    private final String sessionId;
    private final String invocationId;

    public AgentEndEvent(String agentName, String description, boolean success, String resultSummary, String sessionId) {
        this(agentName, description, success, resultSummary, sessionId, null);
    }

    public AgentEndEvent(String agentName, String description, boolean success, String resultSummary,
                         String sessionId, String invocationId) {
        // runId 对结束事件无消费方（下游只读 agentName/description/success/resultSummary），传 null
        super(null, agentName, null, null);

        this.description = description;
        this.success = success;
        this.resultSummary = resultSummary;
        this.sessionId = sessionId;
        this.invocationId = invocationId;
    }

    public String getDescription() {
        return description;
    }

    public boolean isSuccess() {
        return success;
    }

    public String getSessionId() {
        return sessionId;
    }

    public String getInvocationId() {
        return invocationId;
    }

    public String getResultSummary() {
        if (resultSummary == null) {
            return "";
        }
        if (resultSummary.length() > 200) {
            return resultSummary.substring(0, 200) + "...";
        }
        return resultSummary;
    }
}
