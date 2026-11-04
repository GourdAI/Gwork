package com.gourdai.core.portal.web.model;

/**
 * 拉取模型列表失败的原因分类。
 *
 * <p>此前三个 adapter 把 DNS/TLS/超时/401/404/429/5xx 一律吞成「成功但零模型」，
 * 前端因此把网络故障当成上游真的没有模型，在编辑模式下会持久化空列表、清掉用户已有远程模型。
 * 这里给出一组稳定的机器可读枚举，供后端分类、前端映射 i18n 文案。</p>
 */
public enum ModelsFetchReason {
    /** URL 为空、含全角字符或非 http(s) 协议，请求根本没有发出 */
    INVALID_URL,
    /** 上游没有实现该模型列表接口（404/405/501） */
    NOT_SUPPORTED,
    /** 鉴权失败：API Key 缺失、错误或无权限（401/403/407） */
    AUTH_FAILED,
    /** 触发上游限流（429） */
    RATE_LIMITED,
    /** 上游服务端错误（>=500，504 除外） */
    UPSTREAM_ERROR,
    /** 其他非 2xx 状态码 */
    BAD_STATUS,
    /** 建立连接阶段超时 */
    CONNECT_TIMEOUT,
    /** 连接已建立但读取响应超时 */
    READ_TIMEOUT,
    /** 上游以 408/504 明确报告超时 */
    TIMEOUT,
    /** 域名解析失败 */
    DNS_FAILED,
    /** 连接被拒绝（端口未监听等） */
    CONNECT_REFUSED,
    /** TLS/SSL 握手或证书校验失败 */
    TLS_ERROR,
    /** 其他网络层故障 */
    NETWORK_ERROR,
    /** HTTP 2xx，但正文为空、非 JSON 或缺少约定的数组节点 */
    INVALID_RESPONSE,
    /** 无法归类 */
    UNKNOWN;

    /**
     * 按 HTTP 状态码分类。
     *
     * <p>注意 504（Gateway Timeout）先命中 {@link #TIMEOUT}，不落入 {@code >=500} 的
     * {@link #UPSTREAM_ERROR}——对用户而言「上游超时」和「上游 500」是两种不同的处置建议。</p>
     *
     * @param status HTTP 状态码
     * @return 对应的失败原因；2xx 返回 {@code null}（表示不是失败）
     */
    public static ModelsFetchReason ofStatus(int status) {
        if (status >= 200 && status < 300) {
            return null;
        }

        switch (status) {
            case 401:
            case 403:
            case 407:
                return AUTH_FAILED;
            case 404:
            case 405:
            case 501:
                return NOT_SUPPORTED;
            case 408:
            case 504:
                return TIMEOUT;
            case 429:
                return RATE_LIMITED;
            default:
                break;
        }

        if (status >= 500) {
            return UPSTREAM_ERROR;
        }

        return BAD_STATUS;
    }
}
