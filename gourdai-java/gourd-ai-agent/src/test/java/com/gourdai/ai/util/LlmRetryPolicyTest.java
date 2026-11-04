package com.gourdai.ai.util;

import com.gourdai.ai.chat.ChatException;
import com.gourdai.ai.chat.LlmErrorMessages;
import com.gourdai.ai.chat.LlmHttpStatusException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.noear.solon.net.http.HttpResponse;
import org.noear.solon.net.http.HttpResponseException;

import java.io.InputStream;
import java.lang.reflect.Type;
import java.net.URL;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link LlmRetryPolicy} 的状态码解析与「不可重试」判定契约。
 *
 * <p>本类是「确定性错误不重试」修复的判据核心，故逐条钉死三类行为：</p>
 * <ol>
 *     <li><b>不可重试白名单</b>：400/401/403/404/405/413/414/422 必须判为不可重试；</li>
 *     <li><b>瞬态错误必须放行</b>：408/409/<b>429</b>/5xx、网络异常、首信号超时一律可重试
 *     ——429 尤其不能误杀，退避后重试是限流的唯一正确解；</li>
 *     <li><b>解析不出状态码时保守放行</b>：未知错误按可重试处理，避免把瞬态故障误判为致命。</li>
 * </ol>
 *
 * <p>状态码来源覆盖三条路径：类型化 {@link LlmHttpStatusException}、底座
 * {@link HttpResponseException}、以及消息正则<b>兜底</b>（含真实事故会话
 * {@code work-mu74mh9v} 中逐字取出的网关包装消息）。</p>
 *
 * @author oisin
 * @since 4.1
 */
class LlmRetryPolicyTest {

    /** 真实事故原文：会话 work-mu74mh9v 中被重试 57 次的那条 HTTP 400（网关双层包装 + SSE 错误体） */
    private static final String REAL_400_BODY =
            "event:error\ndata:{\"code\":400,\"message\":\"Model service provider exception: "
                    + "{Response code: 400, body: {\\\"error\\\":{\\\"code\\\":\\\"MissingParameter\\\","
                    + "\\\"message\\\":\\\"The request failed because it is missing `input.type` parameter."
                    + " Request id: 02178974657723620244bbcebb250bf80b1bc04ef464017f0f16d\\\","
                    + "\\\"param\\\":\\\"input.type\\\",\\\"type\\\":\\\"BadRequest\\\"}}}\"}";

    /** 真实事故原文：同一会话中被反复重试的 HTTP 403 余额不足（含全角美元符与小数） */
    private static final String REAL_403_MESSAGE =
            "HTTP 403: [new_api_error] 预扣费额度失败, 用户剩余额度: ＄0.122296, 需要预扣费额度: ＄0.126506";

    /** 真实事故原文：首信号超时（瞬态，必须仍可重试） */
    private static final String REAL_FIRST_SIGNAL_TIMEOUT =
            "Did not observe any item or terminal signal within first signal from a Publisher "
                    + "in 'flatMapMany' (and no fallback has been configured)";

    // ---------------- 类型化状态码（主路径） ----------------

    @Test
    @DisplayName("类型化状态码：不可重试白名单全部命中")
    void typedStatus_nonRetryableWhitelist() {
        for (int status : new int[]{400, 401, 403, 404, 405, 413, 414, 422}) {
            LlmHttpStatusException e = new LlmHttpStatusException(status, "HTTP " + status + ": boom");

            assertEquals(status, LlmRetryPolicy.resolveHttpStatus(e), "状态码必须原样解析");
            assertTrue(LlmRetryPolicy.isNonRetryable(e), status + " 属确定性错误，必须判为不可重试");
            assertFalse(LlmRetryPolicy.isRetryable(e), status + " 不得被放行重试");
        }
    }

    @Test
    @DisplayName("类型化状态码：408/409/429/5xx 一律仍可重试（429 限流绝不误杀）")
    void typedStatus_transientStaysRetryable() {
        for (int status : new int[]{408, 409, 429, 500, 501, 502, 503, 504, 508, 599}) {
            LlmHttpStatusException e = new LlmHttpStatusException(status, "HTTP " + status + ": transient");

            assertEquals(status, LlmRetryPolicy.resolveHttpStatus(e));
            assertFalse(LlmRetryPolicy.isNonRetryable(e), status + " 是瞬态错误，必须保留重试自愈能力");
            assertTrue(LlmRetryPolicy.isRetryable(e));
        }
    }

    @Test
    @DisplayName("类型化状态码：2xx/3xx 不在白名单内，同样放行")
    void typedStatus_successCodesStayRetryable() {
        for (int status : new int[]{200, 201, 301, 302, 307}) {
            assertFalse(LlmRetryPolicy.isNonRetryable(
                    new LlmHttpStatusException(status, "HTTP " + status)), status + " 不应被判为致命");
        }
    }

    @Test
    @DisplayName("状态码未知（0）时不参与判定，按可重试处理")
    void typedStatus_unknownIsConservativelyRetryable() {
        LlmHttpStatusException e = new LlmHttpStatusException(LlmHttpStatusException.UNKNOWN_STATUS, "no status line");

        assertFalse(e.hasHttpStatus());
        assertEquals(LlmRetryPolicy.UNKNOWN_STATUS, LlmRetryPolicy.resolveHttpStatus(e));
        assertFalse(LlmRetryPolicy.isNonRetryable(e), "状态码未知不得判为致命");
    }

    // ---------------- 包装链 ----------------

    @Test
    @DisplayName("因果链下钻：包装多层后仍能取到根因状态码")
    void causeChain_isUnwrapped() {
        Throwable e = new RuntimeException("模型调用失败",
                new IllegalStateException("reactor wrapped",
                        new LlmHttpStatusException(422, "HTTP 422: schema violation")));

        assertEquals(422, LlmRetryPolicy.resolveHttpStatus(e));
        assertTrue(LlmRetryPolicy.isNonRetryable(e));
    }

    @Test
    @DisplayName("因果链自引用不会死循环（深度上限兜底）")
    void cyclicCauseChain_doesNotHang() {
        // 构造一个 cause 指向自身的异常：Throwable#initCause 禁止自引用，故用两层互指模拟
        RuntimeException a = new RuntimeException("a");
        ChatException b = new ChatException("b", a);
        a.initCause(b);

        assertEquals(LlmRetryPolicy.UNKNOWN_STATUS, LlmRetryPolicy.resolveHttpStatus(a));
        assertFalse(LlmRetryPolicy.isNonRetryable(a));
    }

    @Test
    @DisplayName("null 异常安全：视为可重试")
    void nullThrowable_isSafe() {
        assertEquals(LlmRetryPolicy.UNKNOWN_STATUS, LlmRetryPolicy.resolveHttpStatus(null));
        assertFalse(LlmRetryPolicy.isNonRetryable(null));
        assertTrue(LlmRetryPolicy.isRetryable(null));
    }

    // ---------------- 底座 HttpResponseException ----------------

    @Test
    @DisplayName("底座 HttpResponseException：400 判为不可重试，429/503 仍可重试")
    void httpResponseException_usesTypedCode() {
        assertTrue(LlmRetryPolicy.isNonRetryable(
                new HttpResponseException(fakeResponse(400, "Bad Request", "{\"error\":\"x\"}"),
                        "POST", url("https://llm.example.com/v1/chat/completions"))));

        assertFalse(LlmRetryPolicy.isNonRetryable(
                new HttpResponseException(fakeResponse(429, "Too Many Requests", null),
                        "POST", url("https://llm.example.com/v1/chat/completions"))));

        assertFalse(LlmRetryPolicy.isNonRetryable(
                new HttpResponseException(fakeResponse(503, "Service Unavailable", null),
                        "POST", url("https://llm.example.com/v1/chat/completions"))));
    }

    @Test
    @DisplayName("httpErrorOf 产出的异常携带类型化状态码（流式与非流式的唯一 HTTP 失败出口）")
    void httpErrorOf_carriesTypedStatus() {
        LlmHttpStatusException e = LlmErrorMessages.httpErrorOf(
                fakeResponse(400, "Bad Request", "{\"error\":{\"message\":\"missing input.type\",\"type\":\"BadRequest\"}}"));

        assertEquals(400, e.httpStatus());
        assertTrue(e.hasHttpStatus());
        assertTrue(e instanceof ChatException, "必须仍是 ChatException，既有 catch/instanceof 分支不受影响");
        //消息文本与历史版本逐字一致，上层展示不丢信息
        assertEquals("HTTP 400 Bad Request: [BadRequest] missing input.type", e.getMessage());
        assertTrue(LlmRetryPolicy.isNonRetryable(e));
    }

    // ---------------- 消息正则兜底 ----------------

    @Test
    @DisplayName("兜底：真实事故消息（HTTP 400 + 网关双层包装）判为不可重试")
    void messageFallback_realWorld400() {
        //事故现场的实际形态：类型化状态码存在，但即便只剩消息也必须能判对
        ChatException untyped = new ChatException(LlmErrorMessages.httpErrorText(400, null, REAL_400_BODY));

        assertEquals(400, LlmRetryPolicy.resolveHttpStatus(untyped));
        assertTrue(LlmRetryPolicy.isNonRetryable(untyped), "确定性 400 必须立即失败，不得重试 57 次");
    }

    @Test
    @DisplayName("兜底：真实事故消息（HTTP 403 余额不足）判为不可重试")
    void messageFallback_realWorld403Quota() {
        ChatException untyped = new ChatException(REAL_403_MESSAGE);

        assertEquals(403, LlmRetryPolicy.resolveHttpStatus(untyped));
        assertTrue(LlmRetryPolicy.isNonRetryable(untyped), "余额不足不会在退避窗口内自行到账，重试纯属浪费");
    }

    @Test
    @DisplayName("兜底：多种状态码书写形态均可提取")
    void messageFallback_variousShapes() {
        assertTrue(LlmRetryPolicy.isNonRetryable(new RuntimeException("HTTP 404 Not Found")));
        assertTrue(LlmRetryPolicy.isNonRetryable(new RuntimeException("HTTP: 401")));
        assertTrue(LlmRetryPolicy.isNonRetryable(new RuntimeException("400 from POST https://llm.example.com/v1")));
        assertTrue(LlmRetryPolicy.isNonRetryable(new RuntimeException("{Response code: 403, body: {}}")));
        assertTrue(LlmRetryPolicy.isNonRetryable(new RuntimeException("{\"code\":422,\"message\":\"bad\"}")));
        assertTrue(LlmRetryPolicy.isNonRetryable(new RuntimeException("{\"statusCode\":413}")));
        assertTrue(LlmRetryPolicy.isNonRetryable(new RuntimeException("upstream status=405 method not allowed")));
        assertTrue(LlmRetryPolicy.isNonRetryable(new RuntimeException("http_status: 414")));
    }

    @Test
    @DisplayName("兜底：可重试状态码的多种形态同样识别（不会一律判死）")
    void messageFallback_retryableShapes() {
        assertFalse(LlmRetryPolicy.isNonRetryable(new RuntimeException("HTTP 429 Too Many Requests")));
        assertFalse(LlmRetryPolicy.isNonRetryable(new RuntimeException("HTTP 502 Bad Gateway")));
        assertFalse(LlmRetryPolicy.isNonRetryable(new RuntimeException("{Response code: 503, body: {}}")));
        assertFalse(LlmRetryPolicy.isNonRetryable(new RuntimeException("{\"code\":500}")));
        assertFalse(LlmRetryPolicy.isNonRetryable(new RuntimeException("408 from POST https://llm.example.com")));
    }

    @Test
    @DisplayName("兜底：最左匹配优先——外层真实状态码压过被引用的下游文本")
    void messageFallback_leftmostWins() {
        //本次响应是 502（可重试），消息里引用的下游 400 不应改变判定
        RuntimeException e = new RuntimeException("HTTP 502 Bad Gateway: upstream said: HTTP 400 bad request");

        assertEquals(502, LlmRetryPolicy.resolveHttpStatus(e));
        assertFalse(LlmRetryPolicy.isNonRetryable(e));
    }

    @Test
    @DisplayName("兜底：类型化状态码优先于消息文本（消息里的数字不得覆盖真实状态码）")
    void typedStatus_beatsMessageDigits() {
        //真实状态码 503（可重试），但消息正文里恰好含 "HTTP 400" 字样
        LlmHttpStatusException e = new LlmHttpStatusException(503, "upstream quoted: HTTP 400 in its body");

        assertEquals(503, LlmRetryPolicy.resolveHttpStatus(e));
        assertFalse(LlmRetryPolicy.isNonRetryable(e));
    }

    // ---------------- 保守放行（不得误杀） ----------------

    @Test
    @DisplayName("无状态码的异常一律可重试：网络异常、首信号超时、普通业务异常")
    void unparseable_staysRetryable() {
        assertFalse(LlmRetryPolicy.isNonRetryable(
                new java.io.IOException("Connection reset by peer")));
        assertFalse(LlmRetryPolicy.isNonRetryable(
                new java.net.SocketTimeoutException("Read timed out")));
        assertFalse(LlmRetryPolicy.isNonRetryable(
                new java.util.concurrent.TimeoutException(REAL_FIRST_SIGNAL_TIMEOUT)));
        assertFalse(LlmRetryPolicy.isNonRetryable(new RuntimeException("boom")));
        assertFalse(LlmRetryPolicy.isNonRetryable(new NullPointerException()));
        assertFalse(LlmRetryPolicy.isNonRetryable(new ChatException("The LLM did not return")));
    }

    @Test
    @DisplayName("无关数字不得被误认成状态码（token 数、耗时、请求 id、金额）")
    void unrelatedDigits_areNotStatuses() {
        //末轮上下文规模（真实事故中的 579,657 tokens）
        assertEquals(LlmRetryPolicy.UNKNOWN_STATUS,
                LlmRetryPolicy.resolveHttpStatus(new RuntimeException("prompt has 579657 tokens, retry later")));
        //耗时
        assertEquals(LlmRetryPolicy.UNKNOWN_STATUS,
                LlmRetryPolicy.resolveHttpStatus(new RuntimeException("elapsed 400 ms then connection reset")));
        //供应商请求 id（含长数字串）
        assertEquals(LlmRetryPolicy.UNKNOWN_STATUS,
                LlmRetryPolicy.resolveHttpStatus(new RuntimeException(
                        "Request id: 02178974657723620244bbcebb250bf80b1bc04ef464017f0f16d")));
        //金额与额度
        assertEquals(LlmRetryPolicy.UNKNOWN_STATUS,
                LlmRetryPolicy.resolveHttpStatus(new RuntimeException("quota 0.122296 exceeded, need 0.126506")));
    }

    @Test
    @DisplayName("非三位数或越界的数字不作为状态码")
    void implausibleNumbers_areRejected() {
        assertEquals(LlmRetryPolicy.UNKNOWN_STATUS,
                LlmRetryPolicy.resolveHttpStatus(new RuntimeException("HTTP 99 too short")));
        assertEquals(LlmRetryPolicy.UNKNOWN_STATUS,
                LlmRetryPolicy.resolveHttpStatus(new RuntimeException("HTTP 6000 out of range")));
        assertEquals(LlmRetryPolicy.UNKNOWN_STATUS,
                LlmRetryPolicy.resolveHttpStatus(new RuntimeException("HTTP 099 leading zero")));
    }

    @Test
    @DisplayName("白名单内容与规约逐字一致")
    void whitelist_matchesSpec() {
        assertEquals(java.util.Set.of(400, 401, 403, 404, 405, 413, 414, 422),
                LlmRetryPolicy.NON_RETRYABLE_STATUS);
    }

    // ---------------- 测试辅助 ----------------

    /** 最小可用的 HttpResponse 桩：只实现状态码与响应体读取（与 LlmErrorMessagesTest 同形） */
    private static HttpResponse fakeResponse(int code, String message, String body) {
        byte[] bytes = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
        return new HttpResponse() {
            @Override public Collection<String> headerNames() { return Collections.emptyList(); }
            @Override public String header(String name) { return null; }
            @Override public List<String> headers(String name) { return Collections.emptyList(); }
            @Override public Collection<String> cookieNames() { return Collections.emptyList(); }
            @Override public String cookie(String name) { return null; }
            @Override public List<String> cookies(String name) { return Collections.emptyList(); }
            @Override public List<String> cookies() { return Collections.emptyList(); }
            @Override public Long contentLength() { return (long) bytes.length; }
            @Override public String contentType() { return "application/json"; }
            @Override public Charset contentCharset() { return StandardCharsets.UTF_8; }
            @Override public int code() { return code; }
            @Override public String message() { return message; }
            @Override public InputStream body() {
                return body == null ? null : new java.io.ByteArrayInputStream(bytes);
            }
            @Override public byte[] bodyAsBytes() { return bytes; }
            @Override public String bodyAsString() { return body; }
            @Override public <T> T bodyAsBean(Type type) { return null; }
            @Override public Map<String, List<String>> headerMap() { return Collections.emptyMap(); }
            @Override public void close() { }
            @Override public HttpResponseException createError() {
                return new HttpResponseException(this, "POST",
                        url("https://llm.example.com/v1/chat/completions"));
            }
        };
    }

    private static URL url(String spec) {
        try {
            return new URL(spec);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
