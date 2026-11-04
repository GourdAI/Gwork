package com.gourdai.core.portal.web.model;

import java.io.InterruptedIOException;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.UnknownHostException;
import java.util.concurrent.TimeoutException;

import org.noear.solon.net.http.HttpResponse;
import org.noear.solon.net.http.HttpUtils;

import javax.net.ssl.SSLException;

/**
 * 模型列表拉取的 HTTP 公共工具：URL 前置校验与传输层异常分类。
 *
 * <p>三个 adapter 共用，保证 OpenAI/Anthropic/Ollama 对同一类故障给出同一个
 * {@link ModelsFetchReason}，前端只需维护一份文案映射。</p>
 */
public final class ModelsHttp {

    /** 沿 cause 链向下探查的最大层数，防御自引用或超深包装导致的死循环 */
    private static final int MAX_CAUSE_DEPTH = 8;

    private ModelsHttp() {
    }

    /**
     * 校验并返回一个可用于发起请求的 http(s) URL。
     *
     * <p>用户从聊天窗口/文档里复制 API 地址时，极易带入首尾空格或中文输入法产生的
     * 全角冒号、全角斜杠、全角空格。这类字符会让底层客户端抛出五花八门的异常，
     * 甚至被静默拼成一个能解析但指向错误主机的地址，所以在发请求之前先明确拒绝。</p>
     *
     * @param url 待校验的完整 URL
     * @param tag 日志标签（如 OpenAI/Anthropic/Ollama），仅用于异常消息定位
     * @return 原样返回的 URL
     * @throws ModelsFetchException reason = {@link ModelsFetchReason#INVALID_URL}，status = 0
     */
    public static String requireHttpUrl(String url, String tag) {
        String label = (tag == null || tag.isEmpty()) ? "models" : tag;

        if (url == null || url.trim().isEmpty()) {
            throw invalidUrl(label, "url is empty");
        }

        for (int i = 0; i < url.length(); i++) {
            char c = url.charAt(i);
            // ASCII 空白（空格/制表/换行）与常见全角字符：请求发出去必然是错的
            if (c <= ' ') {
                throw invalidUrl(label, "url contains whitespace");
            }
            if (c == '\u3000') {
                throw invalidUrl(label, "url contains full-width space");
            }
            if (c == '\uFF1A') {
                throw invalidUrl(label, "url contains full-width colon");
            }
            if (c == '\uFF0F') {
                throw invalidUrl(label, "url contains full-width slash");
            }
        }

        URI uri;
        try {
            uri = new URI(url);
        } catch (URISyntaxException e) {
            throw invalidUrl(label, "url is not parsable");
        }

        String scheme = uri.getScheme();
        if (scheme == null
                || !("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))) {
            throw invalidUrl(label, "url scheme must be http or https");
        }

        String host = uri.getHost();
        if (host == null || host.isEmpty()) {
            throw invalidUrl(label, "url host is empty");
        }

        if (uri.getFragment() != null || uri.getQuery() != null) {
            throw invalidUrl(label, "url must not contain query or fragment");
        }

        return url;
    }

    /**
     * 将传输层异常归类为 {@link ModelsFetchReason}。
     *
     * <p>HTTP 客户端普遍会把底层 socket 异常包进 RuntimeException/IOException，
     * 因此沿 cause 链最多下探 {@value #MAX_CAUSE_DEPTH} 层，命中第一个可识别类型即返回。
     * 全程不读取异常消息以外的信息，且对 null message 保持安全。</p>
     *
     * @param t 捕获到的异常，可为 null
     * @return 归类结果；识别不出具体类型时返回 {@link ModelsFetchReason#NETWORK_ERROR}
     */
    public static ModelsFetchReason classifyTransport(Throwable t) {
        Throwable cur = t;

        for (int depth = 0; cur != null && depth < MAX_CAUSE_DEPTH; depth++) {
            if (cur instanceof UnknownHostException) {
                return ModelsFetchReason.DNS_FAILED;
            }
            if (cur instanceof SSLException) {
                return ModelsFetchReason.TLS_ERROR;
            }
            // SocketTimeoutException 继承自 InterruptedIOException，必须先于后者判断
            if (cur instanceof SocketTimeoutException) {
                return mentionsConnect(cur)
                        ? ModelsFetchReason.CONNECT_TIMEOUT
                        : ModelsFetchReason.READ_TIMEOUT;
            }
            if (cur instanceof ConnectException) {
                // "Connection timed out" 与 "Connection refused" 是同一异常类型下的两种处置
                return mentionsTimeout(cur)
                        ? ModelsFetchReason.CONNECT_TIMEOUT
                        : ModelsFetchReason.CONNECT_REFUSED;
            }
            if (cur instanceof NoRouteToHostException) {
                return ModelsFetchReason.NETWORK_ERROR;
            }
            if (cur instanceof InterruptedIOException || cur instanceof TimeoutException) {
                return mentionsConnect(cur)
                        ? ModelsFetchReason.CONNECT_TIMEOUT
                        : ModelsFetchReason.READ_TIMEOUT;
            }

            Throwable next = cur.getCause();
            if (next == cur) {
                break;
            }
            cur = next;
        }

        return ModelsFetchReason.NETWORK_ERROR;
    }

    /**
     * 执行 GET，并统一检查 HTTP 状态与响应正文。
     */
    public static String getBody(HttpUtils http, String tag) {
        try (HttpResponse response = http.exec("GET")) {
            int status = response.code();
            requireOkStatus(status, tag);
            String body = response.bodyAsString();
            if (body == null || body.trim().isEmpty()) {
                throw new ModelsFetchException(ModelsFetchReason.INVALID_RESPONSE, status,
                        "[" + tag + "] empty models response");
            }
            return body;
        } catch (ModelsFetchException e) {
            throw e;
        } catch (Throwable e) {
            ModelsFetchReason reason = classifyTransport(e);
            throw new ModelsFetchException(reason, 0,
                    "[" + tag + "] models transport failed: " + reason, e);
        }
    }

    /**
     * 按 HTTP 状态码抛出结构化异常；2xx 时直接返回。
     *
     * @param status HTTP 状态码
     * @param tag    日志标签
     */
    public static void requireOkStatus(int status, String tag) {
        ModelsFetchReason reason = ModelsFetchReason.ofStatus(status);
        if (reason == null) {
            return;
        }
        throw new ModelsFetchException(reason, status,
                "[" + tag + "] models request failed with HTTP " + status);
    }

    private static boolean mentionsConnect(Throwable t) {
        String msg = lowerMessage(t);
        return msg != null && msg.contains("connect");
    }

    private static boolean mentionsTimeout(Throwable t) {
        String msg = lowerMessage(t);
        return msg != null && (msg.contains("timed out") || msg.contains("timeout"));
    }

    private static String lowerMessage(Throwable t) {
        String msg = t.getMessage();
        return (msg == null) ? null : msg.toLowerCase();
    }

    private static ModelsFetchException invalidUrl(String tag, String detail) {
        return new ModelsFetchException(ModelsFetchReason.INVALID_URL, 0,
                "[" + tag + "] " + detail);
    }
}
