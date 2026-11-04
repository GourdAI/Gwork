package com.gourdai.harness.agent;

import com.gourdai.agent.event.AbsAgentEvent;

/**
 * 子代理启动事件
 * <p>
 * 用于在流式模式下，向父代理的 FluxSink 推送「子代理已启动」信号。
 * 下游流构建器（如 WebStreamBuilder）据此生成 agent_start 类型的 WebChunk，
 * 供前端渲染"智能体"徽章卡片。
 * </p>
 *
 * <p><b>为什么必须继承 {@link AbsAgentEvent} 而不是直接 implements AgentEvent：</b>
 * {@link com.gourdai.harness.agent.TaskTalent} 在 instanceof 分发<b>之前</b>，会对流过的
 * 每一个事件无条件执行 {@code event.getMeta().put("__parentAgentName", ...)}，以便下游把
 * 子代理内容路由进对应的智能体卡片。若此处自行返回 {@code Collections.emptyMap()}，
 * 嵌套委派（子代理再调 task）时内层推上来的本事件会在外层的 doOnNext 里抛
 * {@code UnsupportedOperationException}，并被兜底 catch 成「任务执行失败」——
 * 一个<b>已经成功完成</b>的外层任务会被误报为失败。基类的 getMeta() 是懒建可变 HashMap，
 * 与 {@link RetryEvent}、{@link ContextUsageEvent} 保持同一套可变性契约。</p>
 *
 * <p>runId 恒为 null：本事件由 TaskTalent 在子代理<b>启动前</b>构造，此刻子代理的 run 尚未开始，
 * 拿不到 runId；下游 WebStreamBuilder 只是把它写进 WebChunk.runId（可为 null），不依赖其非空。</p>
 *
 * @author oisin
 */
public class AgentStartEvent extends AbsAgentEvent {
    private final String description;
    private final String sessionId;
    private final String invocationId;

    public AgentStartEvent(String agentName, String description, String sessionId) {
        this(agentName, description, sessionId, null);
    }

    public AgentStartEvent(String agentName, String description, String sessionId, String invocationId) {
        // runId 此刻未知（子代理尚未启动），session/message 对本事件无意义，均传 null
        super(null, agentName, null, null);

        this.description = description;
        this.sessionId = sessionId;
        this.invocationId = invocationId;
    }

    public String getDescription() {
        return description;
    }

    public String getSessionId() {
        return sessionId;
    }

    public String getInvocationId() {
        return invocationId;
    }
}
