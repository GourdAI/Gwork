package com.gourdai.core.portal.web;

/**
 * 插话信封：一条结构化的即时插话请求。
 *
 * <p>按 {@link #steerId} 幂等，由 {@link WebGate#steer} 在 session inputLock 内原子加入邮箱。</p>
 */
public class SteerEnvelope {

    /** 客户端生成的幂等 ID（UUID 或 nanoid）*/
    private final String steerId;
    /** 插话文本（已校验非空且不超过 {@link SteerInterceptor#MAX_TEXT_LENGTH}） */
    private final String text;
    /** 发起时的活跃 runId，用于延迟到达时检查是否仍属同一 run */
    private final String runId;
    /** 客户端发起时间（epoch ms） */
    private final long createdAt;

    public SteerEnvelope(String steerId, String text, String runId, long createdAt) {
        this.steerId   = steerId;
        this.text      = text;
        this.runId     = runId;
        this.createdAt = createdAt;
    }

    public String getSteerId()  { return steerId; }
    public String getText()     { return text; }
    public String getRunId()    { return runId; }
    public long   getCreatedAt(){ return createdAt; }

    @Override
    public String toString() {
        return "SteerEnvelope{steerId='" + steerId + "', runId='" + runId + "'}";
    }
}
