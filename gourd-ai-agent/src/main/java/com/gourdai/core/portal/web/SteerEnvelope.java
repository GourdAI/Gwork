package com.gourdai.core.portal.web;

import java.util.Collections;
import java.util.List;

/**
 * 插话信封：一条结构化的即时插话请求。
 *
 * <p>按 {@link #steerId} 幂等，由 {@link WebGate#steer} 在 session inputLock 内原子加入邮箱。</p>
 *
 * <p>附件只存【会话内相对路径】而不存字节：邮箱最多滞留 {@link SteerInterceptor#MAX_BOX_SIZE} 条，
 * 缓存 base64 图片会有内存风险。真正读盘发生在 {@link SteerInterceptor} 注入工作记忆的那一刻；
 * 插话未生效被降级为队列消息时，同一批路径原样写进 queue.json，附件不会丢。</p>
 */
public class SteerEnvelope {

    /** 客户端生成的幂等 ID（UUID 或 nanoid）*/
    private final String steerId;
    /** 插话文本（长度不超过 {@link SteerInterceptor#MAX_TEXT_LENGTH}；纯附件插话时为空串） */
    private final String text;
    /** 发起时的活跃 runId，用于延迟到达时检查是否仍属同一 run */
    private final String runId;
    /** 客户端发起时间（epoch ms） */
    private final long createdAt;
    /** 作为多模态图片注入的附件路径（{@code uploads/xxx}），不可变、非 null */
    private final List<String> imagePaths;
    /** 作为路径引用的附件路径（{@code uploads/xxx}），不可变、非 null */
    private final List<String> filePaths;

    public SteerEnvelope(String steerId, String text, String runId, long createdAt) {
        this(steerId, text, runId, createdAt, Collections.emptyList(), Collections.emptyList());
    }

    public SteerEnvelope(String steerId, String text, String runId, long createdAt,
                         List<String> imagePaths, List<String> filePaths) {
        this.steerId   = steerId;
        this.text      = text;
        this.runId     = runId;
        this.createdAt = createdAt;
        this.imagePaths = imagePaths == null ? Collections.emptyList() : Collections.unmodifiableList(imagePaths);
        this.filePaths  = filePaths  == null ? Collections.emptyList() : Collections.unmodifiableList(filePaths);
    }

    public String getSteerId()  { return steerId; }
    public String getText()     { return text; }
    public String getRunId()    { return runId; }
    public long   getCreatedAt(){ return createdAt; }
    public List<String> getImagePaths() { return imagePaths; }
    public List<String> getFilePaths()  { return filePaths; }

    /** 是否携带任何附件。 */
    public boolean hasAttachments() {
        return !imagePaths.isEmpty() || !filePaths.isEmpty();
    }

    @Override
    public String toString() {
        return "SteerEnvelope{steerId='" + steerId + "', runId='" + runId
                + "', images=" + imagePaths.size() + ", files=" + filePaths.size() + "}";
    }
}
