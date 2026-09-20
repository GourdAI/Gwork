package com.gourdai.ai.util;

import com.gourdai.ai.chat.ChatException;
import com.gourdai.ai.chat.LlmHttpStatusException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.noear.solon.net.http.HttpResponse;
import org.noear.solon.net.http.HttpResponseException;
import org.noear.solon.util.CallableTx;

import java.io.InputStream;
import java.lang.reflect.Type;
import java.net.URL;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link RetryTask} 「确定性错误不重试」的行为契约。
 *
 * <p><b>要修复的真实事故：</b>会话 {@code work-mu74mh9v} 中一个请求构造期的
 * {@code HTTP 400 MissingParameter} 被物理重试 <b>57 次</b>、烧穿 3 个 2→20 阶梯、耗时
 * <b>871 秒</b>，每次都把当时的完整上下文（末轮 579,657 tokens）重新上行，重发 token 上界达
 * 该会话账面支出的 <b>118.7%</b>；同期 8 次 {@code HTTP 403 insufficient_user_quota}
 * （余额不足）同样被反复重试。</p>
 *
 * <p><b>本类钉死的四条不变量：</b></p>
 * <ol>
 *     <li>确定性错误（400/401/403/404/405/413/414/422）<b>只尝试 1 次</b>，
 *     不消耗重试预算、不退避等待、不通知重试监听器（前端因此不会再刷「正在重试 N/20」）；</li>
 *     <li>抛出的是<b>原始异常实例本身</b>（{@code assertSame}）：状态码与网关原文完整保留，
 *     上层 {@code ReasonTask#handleLastException} 的按类型分流与用户可见文案不受影响；</li>
 *     <li>瞬态错误（408/409/<b>429</b>/5xx/网络异常/首信号超时/无状态码）<b>照旧用尽重试</b>，
 *     既有自愈能力零回退；</li>
 *     <li>重试次数上限、指数退避与抖动、总时长预算等既有语义<b>逐字不变</b>，
 *     且可用 {@link RetryTask#failFastOnDeterministicError(boolean)} 关闭本判定回到历史行为。</li>
 * </ol>
 *
 * @author oisin
 * @since 4.1
 */
class RetryTaskNonRetryableTest {

    /** 真实事故原文：被重试 57 次的那条 HTTP 400 */
    private static final String REAL_400_MESSAGE =
            "HTTP 400: event:error\ndata:{\"code\":400,\"message\":\"Model service provider exception: "
                    + "{Response code: 400, body: {\\\"error\\\":{\\\"code\\\":\\\"MissingParameter\\\","
                    + "\\\"message\\\":\\\"The request failed because it is missing `input.type` parameter.\\\","
                    + "\\\"param\\\":\\\"input.type\\\",\\\"type\\\":\\\"BadRequest\\\"}}}\"}";

    /** 真实事故原文：被反复重试的 HTTP 403 余额不足 */
    private static final String REAL_403_MESSAGE =
            "HTTP 403: [new_api_error] 预扣费额度失败, 用户剩余额度: ＄0.122296, 需要预扣费额度: ＄0.126506";

    /** 真实事故原文：首信号超时（瞬态，必须仍可重试） */
    private static final String REAL_FIRST_SIGNAL_TIMEOUT =
            "Did not observe any item or terminal signal within first signal from a Publisher "
                    + "in 'flatMapMany' (and no fallback has been configured)";

    /** 事故现场的重试上限：maxRetries=20（用于证明「烧穿阶梯」被彻底堵住） */
    private static final int INCIDENT_MAX_RETRIES = 20;

    /** 无状态码的业务异常替身：代表「解析不出状态码」的未知错误 */
    private static final class BoomException extends RuntimeException {
        private BoomException(String message) {
            super(message);
        }
    }

    /** 快速装配：退避压到毫秒级，保证测试在百毫秒量级完成 */
    private static RetryTask fastTask(int maxRetries) {
        return new RetryTask().maxRetries(maxRetries).initialDelayMs(5L).maxDelayMs(10L);
    }

    /** 固定泛型实参调用（与 RetryTaskDeadlineTest 同法，避免推断出的 X 影响调用点异常声明） */
    private static void run(RetryTask task, CallableTx<String, Throwable> callable) throws Throwable {
        task.<String, Throwable>callWithRetry(callable);
    }

    // ---------------- 不变量①②：确定性错误立即失败 ----------------

    @Test
    @DisplayName("真实事故的 HTTP 400：只尝试 1 次（而非 20 次），且不通知重试监听器")
    void realWorld400_failsOnFirstAttempt() {
        AtomicInteger calls = new AtomicInteger();
        AtomicInteger notices = new AtomicInteger();
        LlmHttpStatusException failure = new LlmHttpStatusException(400, REAL_400_MESSAGE);

        LlmHttpStatusException thrown = assertThrows(LlmHttpStatusException.class,
                () -> run(fastTask(INCIDENT_MAX_RETRIES).onRetry((attempt, e) -> notices.incrementAndGet()),
                        () -> {
                            calls.incrementAndGet();
                            throw failure;
                        }));

        assertEquals(1, calls.get(), "确定性 400 必须一次即止，不得烧穿 20 次重试阶梯");
        assertEquals(0, notices.get(), "不得通知重试监听器：前端不应再出现「正在重试 N/20」");
        assertSame(failure, thrown, "必须原样抛出同一异常实例，不得包装或换型");
        assertEquals(REAL_400_MESSAGE, thrown.getMessage(), "网关原文必须完整保留，供上层展示给用户");
        assertEquals(400, thrown.httpStatus(), "类型化状态码必须保留");
    }

    @Test
    @DisplayName("真实事故的 HTTP 403 余额不足：只尝试 1 次")
    void realWorld403Quota_failsOnFirstAttempt() {
        AtomicInteger calls = new AtomicInteger();
        ChatException failure = new LlmHttpStatusException(403, REAL_403_MESSAGE);

        ChatException thrown = assertThrows(ChatException.class,
                () -> run(fastTask(INCIDENT_MAX_RETRIES), () -> {
                    calls.incrementAndGet();
                    throw failure;
                }));

        assertEquals(1, calls.get(), "余额不足不会在退避窗口内到账，重试纯属浪费");
        assertSame(failure, thrown);
        assertTrue(thrown.getMessage().contains("insufficient") || thrown.getMessage().contains("预扣费额度失败"),
                "额度不足的原文必须保留，用户才知道要去充值");
    }

    @Test
    @DisplayName("不可重试白名单逐个验证：400/401/403/404/405/413/414/422 均一次即止")
    void everyNonRetryableStatus_failsOnFirstAttempt() {
        for (int status : new int[]{400, 401, 403, 404, 405, 413, 414, 422}) {
            AtomicInteger calls = new AtomicInteger();
            LlmHttpStatusException failure = new LlmHttpStatusException(status, "HTTP " + status + ": deterministic");

            assertThrows(LlmHttpStatusException.class,
                    () -> run(fastTask(INCIDENT_MAX_RETRIES), () -> {
                        calls.incrementAndGet();
                        throw failure;
                    }));

            assertEquals(1, calls.get(), "状态码 " + status + " 属确定性错误，必须立即失败");
        }
    }

    @Test
    @DisplayName("确定性失败不进入退避等待：20 次阶梯的等待被完全省掉")
    void deterministicFailure_doesNotBackoff() {
        AtomicInteger calls = new AtomicInteger();
        //退避设成秒级：若误入退避分支，本用例耗时会立刻飙到秒级以上
        RetryTask task = new RetryTask()
                .maxRetries(INCIDENT_MAX_RETRIES)
                .initialDelayMs(2000L)
                .maxDelayMs(20000L);

        long start = System.nanoTime();
        assertThrows(LlmHttpStatusException.class,
                () -> run(task, () -> {
                    calls.incrementAndGet();
                    throw new LlmHttpStatusException(400, REAL_400_MESSAGE);
                }));
        long elapsedMs = (System.nanoTime() - start) / 1_000_000L;

        assertEquals(1, calls.get());
        assertTrue(elapsedMs < 1000L,
                "快速失败不得等待退避（initialDelay=2000ms），实际耗时=" + elapsedMs + "ms");
    }

    @Test
    @DisplayName("异常被包装多层后仍立即失败，且抛出的是最外层原始实例")
    void wrappedDeterministicError_failsOnFirstAttempt() {
        AtomicInteger calls = new AtomicInteger();
        RuntimeException outer = new RuntimeException("模型调用失败",
                new ChatException("HTTP 400: missing input.type"));

        RuntimeException thrown = assertThrows(RuntimeException.class,
                () -> run(fastTask(INCIDENT_MAX_RETRIES), () -> {
                    calls.incrementAndGet();
                    throw outer;
                }));

        assertEquals(1, calls.get());
        assertSame(outer, thrown, "必须抛出被 catch 到的那个原始实例，保留完整因果链");
        assertEquals("模型调用失败", thrown.getMessage());
        assertEquals("HTTP 400: missing input.type", thrown.getCause().getMessage());
    }

    @Test
    @DisplayName("底座 HttpResponseException（未经 httpErrorOf 改造的路径）同样立即失败")
    void httpResponseException_failsOnFirstAttempt() {
        AtomicInteger calls = new AtomicInteger();
        HttpResponseException failure = new HttpResponseException(
                fakeResponse(404, "Not Found", "{\"error\":\"model not found\"}"),
                "POST", url("https://llm.example.com/v1/chat/completions"));

        assertThrows(HttpResponseException.class,
                () -> run(fastTask(INCIDENT_MAX_RETRIES), () -> {
                    calls.incrementAndGet();
                    throw failure;
                }));

        assertEquals(1, calls.get(), "端点/模型名不存在属配置错误，重试不可能自愈");
    }

    @Test
    @DisplayName("消息兜底：只有文本状态码（无类型化字段）时也能立即失败")
    void messageOnlyStatus_failsOnFirstAttempt() {
        //历史版本产出的 ChatException 只有 "HTTP 400: ..." 文本，兜底正则必须能接住
        AtomicInteger calls = new AtomicInteger();
        ChatException failure = new ChatException(REAL_400_MESSAGE);

        assertThrows(ChatException.class,
                () -> run(fastTask(INCIDENT_MAX_RETRIES), () -> {
                    calls.incrementAndGet();
                    throw failure;
                }));

        assertEquals(1, calls.get());
    }

    // ---------------- 不变量③：瞬态错误照旧重试 ----------------

    @Test
    @DisplayName("408/409/429/5xx 全部照旧用尽重试（429 限流绝不误杀）")
    void transientStatuses_stillRetryToExhaustion() {
        for (int status : new int[]{408, 409, 429, 500, 502, 503, 504}) {
            AtomicInteger calls = new AtomicInteger();
            AtomicInteger notices = new AtomicInteger();

            assertThrows(LlmHttpStatusException.class,
                    () -> run(fastTask(RetryTask.DEFAULT_MAX_RETRIES)
                                    .onRetry((attempt, e) -> notices.incrementAndGet()),
                            () -> {
                                calls.incrementAndGet();
                                throw new LlmHttpStatusException(status, "HTTP " + status + ": transient");
                            }));

            assertEquals(RetryTask.DEFAULT_MAX_RETRIES, calls.get(),
                    "状态码 " + status + " 是瞬态错误，必须用尽既有重试次数");
            assertEquals(RetryTask.DEFAULT_MAX_RETRIES - 1, notices.get(),
                    "重试监听器通知次数不得变化（最后一次失败后不再通知）");
        }
    }

    @Test
    @DisplayName("网络异常/读超时/首信号超时照旧重试")
    void networkErrors_stillRetry() {
        Throwable[] transientErrors = {
                new java.io.IOException("Connection reset by peer"),
                new java.net.SocketTimeoutException("Read timed out"),
                new TimeoutException(REAL_FIRST_SIGNAL_TIMEOUT),
                new ChatException("LLM stream response ended before a completion signal."),
        };

        for (Throwable error : transientErrors) {
            AtomicInteger calls = new AtomicInteger();

            assertThrows(Throwable.class,
                    () -> run(fastTask(RetryTask.DEFAULT_MAX_RETRIES), () -> {
                        calls.incrementAndGet();
                        throw error;
                    }));

            assertEquals(RetryTask.DEFAULT_MAX_RETRIES, calls.get(),
                    "弱网/断流是重试自愈的主战场，不得被误判为致命：" + error);
        }
    }

    @Test
    @DisplayName("解析不出状态码的未知异常保守放行：仍然用尽重试")
    void unknownErrors_stillRetry() {
        AtomicInteger calls = new AtomicInteger();

        assertThrows(BoomException.class,
                () -> run(fastTask(RetryTask.DEFAULT_MAX_RETRIES), () -> {
                    calls.incrementAndGet();
                    throw new BoomException("boom");
                }));

        assertEquals(RetryTask.DEFAULT_MAX_RETRIES, calls.get(),
                "未知错误按可重试处理：把瞬态故障误判为致命会让自愈能力直接失效");
    }

    @Test
    @DisplayName("429 失败后第二次成功：自愈能力完整保留")
    void recoversAfterTransientFailure() throws Throwable {
        AtomicInteger calls = new AtomicInteger();
        RetryTask task = fastTask(RetryTask.DEFAULT_MAX_RETRIES);

        String result = task.<String, Throwable>callWithRetry(() -> {
            if (calls.incrementAndGet() == 1) {
                throw new LlmHttpStatusException(429, "HTTP 429: rate limited");
            }
            return "ok";
        });

        assertEquals("ok", result);
        assertEquals(2, calls.get(), "限流后重试必须能拿到结果");
    }

    @Test
    @DisplayName("成功路径零影响：首次即成功时不做任何额外判定开销")
    void successPath_unaffected() throws Throwable {
        AtomicInteger calls = new AtomicInteger();

        String result = fastTask(RetryTask.DEFAULT_MAX_RETRIES).<String, Throwable>callWithRetry(() -> {
            calls.incrementAndGet();
            return "ok";
        });

        assertEquals("ok", result);
        assertEquals(1, calls.get());
    }

    // ---------------- 不变量④：可关闭 + 既有语义不变 ----------------

    @Test
    @DisplayName("关闭开关后回到历史行为：确定性 400 仍被重试到上限")
    void optOut_restoresLegacyBehavior() {
        AtomicInteger calls = new AtomicInteger();
        RetryTask task = fastTask(RetryTask.DEFAULT_MAX_RETRIES).failFastOnDeterministicError(false);

        assertThrows(LlmHttpStatusException.class,
                () -> run(task, () -> {
                    calls.incrementAndGet();
                    throw new LlmHttpStatusException(400, REAL_400_MESSAGE);
                }));

        assertEquals(RetryTask.DEFAULT_MAX_RETRIES, calls.get(),
                "显式关闭后必须逐字退回历史行为（一切异常均按重试处理）");
    }

    @Test
    @DisplayName("与 retryIf 相互独立：调用方显式放行也拦不住确定性错误")
    void deterministicGate_isIndependentOfRetryIf() {
        AtomicInteger calls = new AtomicInteger();
        //retryIf 恒为 true（等同历史上的默认谓词），闸门仍须生效
        RetryTask task = fastTask(INCIDENT_MAX_RETRIES).retryIf(e -> true);

        assertThrows(LlmHttpStatusException.class,
                () -> run(task, () -> {
                    calls.incrementAndGet();
                    throw new LlmHttpStatusException(400, REAL_400_MESSAGE);
                }));

        assertEquals(1, calls.get());
    }

    @Test
    @DisplayName("与 retryIf 协作：retryIf 拒绝重试的异常仍按原语义立即抛出")
    void retryIfShortCircuit_stillWins() {
        AtomicInteger calls = new AtomicInteger();
        RetryTask task = fastTask(INCIDENT_MAX_RETRIES)
                .retryIf(e -> (e instanceof IllegalStateException) == false);

        IllegalStateException thrown = assertThrows(IllegalStateException.class,
                () -> run(task, () -> {
                    calls.incrementAndGet();
                    throw new IllegalStateException("fatal");
                }));

        assertEquals(1, calls.get());
        assertEquals("fatal", thrown.getMessage());
    }

    @Test
    @DisplayName("NullPointerException 仍按既有语义直接抛出（不受闸门影响）")
    void npe_keepsLegacySemantics() {
        AtomicInteger calls = new AtomicInteger();

        assertThrows(NullPointerException.class,
                () -> run(fastTask(RetryTask.DEFAULT_MAX_RETRIES), () -> {
                    calls.incrementAndGet();
                    throw new NullPointerException("npe");
                }));

        assertEquals(1, calls.get());
    }

    // ---------------- 测试辅助 ----------------

    /** 最小可用的 HttpResponse 桩（与 LlmErrorMessagesTest 同形） */
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
