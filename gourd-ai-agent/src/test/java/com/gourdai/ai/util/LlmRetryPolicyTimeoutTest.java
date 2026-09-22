package com.gourdai.ai.util;

import com.gourdai.ai.chat.ChatException;
import com.gourdai.ai.chat.LlmHttpStatusException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.noear.solon.util.CallableTx;

import java.io.IOException;
import java.io.InterruptedIOException;
import java.net.SocketTimeoutException;
import java.net.http.HttpTimeoutException;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link LlmRetryPolicy#isTimeoutLike(Throwable)} 的识别契约，以及它与 {@code retryIf} 组合后
 * 「超时类失败独立限次」的端到端行为。
 *
 * <p><b>要修复的真实事故（会话 {@code work-mua28gy6}）：</b>34 次重试烧穿 5 个阶梯、
 * 空转 <b>67.6 分钟</b>，界面全程无进展。根源是超时与 429/5xx 共用同一个重试预算，
 * 但二者<b>成本结构截然不同</b>：429/5xx 是上游<b>拒收</b>请求，重试几乎零 token 开销；
 * 超时则意味着请求<b>已被受理</b>——上游正在（或已经）完整生成并计费，只是结果没按时回来。
 * 每重试一次就把完整上下文重新上行、让上游重新生成一次，而大上下文恰恰更容易超时，
 * 于是形成「越超时越重试、越重试越贵」的正反馈。</p>
 *
 * @author oisin
 * @since 4.1
 */
class LlmRetryPolicyTimeoutTest {

    /** 与 {@code ReasonTask.TIMEOUT_FAILURE_LIMIT} 同值：超时类失败在单回合内的次数上限 */
    private static final int TIMEOUT_FAILURE_LIMIT = 2;

    @Test
    @DisplayName("直接的超时异常被识别")
    void recognisesDirectTimeoutTypes() {
        assertTrue(LlmRetryPolicy.isTimeoutLike(new TimeoutException("stream idle")));
        assertTrue(LlmRetryPolicy.isTimeoutLike(new SocketTimeoutException("Read timed out")));
        assertTrue(LlmRetryPolicy.isTimeoutLike(new HttpTimeoutException("request timed out")));
    }

    @Test
    @DisplayName("包装在因果链深处的超时同样被识别")
    void recognisesWrappedTimeout() {
        //非流式路径的真实形态：ChatException(cause=TimeoutException)
        assertTrue(LlmRetryPolicy.isTimeoutLike(
                new ChatException("LLM call timeout: exceeded total time cap 360s",
                        new TimeoutException("total cap"))));

        //多层包装
        assertTrue(LlmRetryPolicy.isTimeoutLike(
                new RuntimeException("outer", new IllegalStateException("mid",
                        new SocketTimeoutException("Read timed out")))));
    }

    @Test
    @DisplayName("非超时错误不得被误判（否则会提前放弃本该重试的瞬态故障）")
    void doesNotMisclassifyOtherErrors() {
        assertFalse(LlmRetryPolicy.isTimeoutLike(null));
        assertFalse(LlmRetryPolicy.isTimeoutLike(new IOException("connection reset")));
        assertFalse(LlmRetryPolicy.isTimeoutLike(new LlmHttpStatusException(429, "Too Many Requests")));
        assertFalse(LlmRetryPolicy.isTimeoutLike(new LlmHttpStatusException(503, "Service Unavailable")));

        //只认类型、不做消息匹配：「timeout」一词会出现在各种不相干的网关文案里
        assertFalse(LlmRetryPolicy.isTimeoutLike(
                        new ChatException("HTTP 400: unknown parameter 'request_timeout'")),
                "按消息文本匹配会把无关的 400 误判成超时并提前放弃重试");
    }

    @Test
    @DisplayName("用户取消（InterruptedIOException）不属于超时类")
    void interruptedIoIsNotTimeoutLike() {
        //本项目用 InterruptedIOException 表达「用户取消/线程中断」（见 execWithTotalCap），
        //与超时语义正交，且已由 RetryTask 的中断分支先行终止。
        assertFalse(LlmRetryPolicy.isTimeoutLike(new InterruptedIOException("LLM call interrupted")));
    }

    @Test
    @DisplayName("成环的因果链不会死循环")
    void cyclicCauseChainIsSafe() {
        //JDK 禁止自引用（initCause(this) 直接抛 IllegalArgumentException），
        //但两节点互指的环是可构造的，正是 MAX_CAUSE_DEPTH 要防的形态。
        RuntimeException a = new RuntimeException("a");
        RuntimeException b = new RuntimeException("b", a);
        a.initCause(b);

        assertFalse(LlmRetryPolicy.isTimeoutLike(a));
    }

    @Test
    @DisplayName("端到端：连续超时在第 2 次即终止，不再烧穿整个阶梯")
    void timeoutRetriesStopAtTheLimit() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        AtomicInteger notified = new AtomicInteger();
        TimeoutException firstError = new TimeoutException("stream idle timeout");

        CallableTx<String, Throwable> alwaysTimeout = () -> {
            attempts.incrementAndGet();
            throw firstError;
        };

        Throwable thrown = assertThrows(TimeoutException.class, () ->
                newTimeoutLimitedRetryTask(20)
                        .onRetry((attempt, e) -> notified.incrementAndGet())
                        .callWithRetry(alwaysTimeout));

        assertEquals(TIMEOUT_FAILURE_LIMIT, attempts.get(),
                "超时类失败必须在第 " + TIMEOUT_FAILURE_LIMIT + " 次即终止，不得烧穿 20 次阶梯");
        assertSame(firstError, thrown,
                "必须原样抛出真实异常：handleLastException 靠类型判定才能给出「响应超时」文案");
        assertEquals(TIMEOUT_FAILURE_LIMIT - 1, notified.get(),
                "只应通知实际发生的那一次重试（前端不再刷「正在重试 N/20」）");
    }

    @Test
    @DisplayName("端到端：429 等瞬态错误完全不受超时限次影响，既有自愈能力零回退")
    void nonTimeoutErrorsKeepFullRetryBudget() {
        AtomicInteger attempts = new AtomicInteger();

        CallableTx<String, Throwable> always429 = () -> {
            attempts.incrementAndGet();
            throw new LlmHttpStatusException(429, "HTTP 429: Too Many Requests");
        };

        assertThrows(LlmHttpStatusException.class, () ->
                newTimeoutLimitedRetryTask(5).callWithRetry(always429));

        assertEquals(5, attempts.get(), "429 必须用尽既有重试预算（用户明确要求：429 一定要重试）");
    }

    @Test
    @DisplayName("端到端：一次超时后成功——瞬时抖动的自愈能力必须保留")
    void singleTimeoutStillRecovers() throws Exception {
        AtomicInteger attempts = new AtomicInteger();

        CallableTx<String, Throwable> failOnceThenOk = () -> {
            if (attempts.incrementAndGet() == 1) {
                throw new TimeoutException("transient stall");
            }
            return "ok";
        };

        assertEquals("ok", newTimeoutLimitedRetryTask(20).callWithRetry(failOnceThenOk));
        assertEquals(2, attempts.get(), "第一次超时后仍应重试一次（瞬时抖动靠它自愈）");
    }

    @Test
    @DisplayName("端到端：超时与瞬态错误混合时，只有超时次数计入限额")
    void onlyTimeoutFailuresCountTowardsTheLimit() {
        AtomicInteger attempts = new AtomicInteger();

        CallableTx<String, Throwable> mixed = () -> {
            int n = attempts.incrementAndGet();
            //第 1、3 次是 429（不计数），第 2、4 次是超时（计数）
            if (n % 2 == 1) {
                throw new LlmHttpStatusException(429, "HTTP 429: Too Many Requests");
            }
            throw new TimeoutException("stall #" + n);
        };

        assertThrows(TimeoutException.class, () ->
                newTimeoutLimitedRetryTask(20).callWithRetry(mixed));

        assertEquals(4, attempts.get(),
                "429 不消耗超时限额：第 4 次（第 2 个超时）才达到上限而终止");
    }

    /**
     * 构造与 {@code ReasonTask#callWithRetry} <b>同构</b>的重试任务：同一个 retryIf 判定逻辑。
     *
     * <p>刻意复刻而非反射调用 ReasonTask：后者需要完整的 trace/options/ChatModel 装配，
     * 测试成本高且脆弱；这里锁定的是「判定逻辑 + RetryTask 组合」这一行为契约，
     * 接线本身另由 {@code ReasonTaskTimeoutLimitWiringTest} 守护。</p>
     */
    private static RetryTask newTimeoutLimitedRetryTask(int maxRetries) {
        final int[] timeoutFailures = {0};

        return new RetryTask()
                .maxRetries(maxRetries)
                .initialDelayMs(1L)
                .retryIf(e -> {
                    if (LlmRetryPolicy.isTimeoutLike(e) == false) {
                        return true;
                    }
                    timeoutFailures[0]++;
                    return timeoutFailures[0] < TIMEOUT_FAILURE_LIMIT;
                });
    }
}
