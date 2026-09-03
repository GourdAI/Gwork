package com.gourdai.core.portal.web.model;

/**
 * 拉取模型列表失败时抛出的结构化异常。
 *
 * <p>携带机器可读的 {@link ModelsFetchReason} 与 HTTP 状态码，
 * 让上层无需解析异常文本即可区分「上游没有这个接口」「鉴权失败」「网络不通」。
 * 消息文本仅用于日志，不作为用户文案——用户文案由前端按 reason 查 i18n。</p>
 */
public class ModelsFetchException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final ModelsFetchReason reason;

    /** HTTP 状态码；0 表示请求未发出或未拿到响应（DNS/TLS/超时/非法 URL 等） */
    private final int status;

    public ModelsFetchException(ModelsFetchReason reason, int status, String message) {
        this(reason, status, message, null);
    }

    public ModelsFetchException(ModelsFetchReason reason, int status, String message, Throwable cause) {
        super(message, cause);
        this.reason = (reason == null) ? ModelsFetchReason.UNKNOWN : reason;
        this.status = status;
    }

    public ModelsFetchReason getReason() {
        return reason;
    }

    /**
     * @return HTTP 状态码，0 表示无 HTTP 响应
     */
    public int getStatus() {
        return status;
    }
}
