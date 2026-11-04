package com.gourdai.ai.util;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.noear.solon.util.CallableTx;

import java.time.Duration;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link RetryTask#totalDeadline(Duration)}（重试总时长预算）的行为契约。
 *
 * <p>三条不可回退的语义：</p>
 * <ol>
 *     <li><b>未配置即零行为变化</b>：不调用、或传 null / 零 / 负值，重试次数与历史版本逐字一致；</li>
 *     <li><b>首次尝试永不受约束</b>：预算再小也至少发一次请求，不构成功能性倒退；</li>
 *     <li><b>预算耗尽抛「最后一次的真实异常」</b>：不包装、不换类型。上层
 *     {@code ReasonTask#handleLastException} 按 {@code lastException} 及其 cause 的类型分流用户文案
 *     （{@code TimeoutException} → 「响应超时」），一旦换成新异常类型，用户侧文案立即退化为通用报错。</li>
 * </ol>
 *
 * <p>全类均用 10ms 级退避，整体耗时在百毫秒量级。</p>
 */
class RetryTaskDeadlineTest {

    /** 业务异常替身：用于验证「原始异常类型原样上抛」。 */
    private static final class BoomException extends RuntimeException {
        private BoomException(String message) {
            super(message);
        }
    }

    /** 统一装配：3 次上限 + 10ms 起始退避 + 20ms 退避上限，保证测试快。 */
    private static RetryTask fastTask() {
        return new RetryTask()
                .maxRetries(RetryTask.DEFAULT_MAX_RETRIES)
                .initialDelayMs(10L)
                .maxDelayMs(20L);
    }

    /**
     * 固定泛型实参调用 {@code callWithRetry}：该方法签名为
     * {@code <T, X extends Throwable> T callWithRetry(CallableTx<T, Throwable>) throws X, InterruptedException}，
     * 显式给定实参可避免推断出的 {@code X} 影响调用点的异常声明。
     */
    private static void run(RetryTask task, CallableTx<String, Throwable> callable) throws Throwable {
        task.<String, Throwable>callWithRetry(callable);
    }

    @Test
    @DisplayName("未配置预算：3 次尝试全部发生，抛出原始异常类型")
    void withoutDeadline_keepsLegacyAttemptCount() {
        AtomicInteger calls = new AtomicInteger();
        RetryTask task = fastTask();

        BoomException thrown = assertThrows(BoomException.class,
                () -> run(task, () -> {
                    calls.incrementAndGet();
                    throw new BoomException("boom");
                }));

        assertEquals(RetryTask.DEFAULT_MAX_RETRIES, calls.get(), "未配置预算时必须用尽重试次数");
        assertEquals("boom", thrown.getMessage(), "必须是业务原始异常实例，不得被包装");
        assertNull(thrown.getCause(), "不得额外套一层 cause");
    }

    @Test
    @DisplayName("null / 零 / 负值预算等价于未配置：仍然用尽 3 次重试")
    void nullZeroOrNegativeDeadline_treatedAsUnconfigured() {
        Duration[] noops = {null, Duration.ZERO, Duration.ofMillis(-1), Duration.ofSeconds(-30)};

        for (Duration noop : noops) {
            AtomicInteger calls = new AtomicInteger();
            RetryTask task = fastTask().totalDeadline(noop);

            assertThrows(BoomException.class,
                    () -> run(task, () -> {
                        calls.incrementAndGet();
                        throw new BoomException("boom");
                    }));

            assertEquals(RetryTask.DEFAULT_MAX_RETRIES, calls.get(), "预算=" + noop + " 应视为未配置");
        }
    }

    @Test
    @DisplayName("极小预算：首次尝试仍然发生，且抛出最后一次的真实异常（TimeoutException 不被换型）")
    void tinyDeadline_stillRunsFirstAttempt_andPreservesRealExceptionType() {
        AtomicInteger calls = new AtomicInteger();
        RetryTask task = fastTask().totalDeadline(Duration.ofMillis(1));

        // 单次尝试耗时（20ms）远大于预算（1ms）：预算在「进入退避等待前」的裁决点必然命中，
        // 因此尝试次数恒为 1，无时序抖动。
        TimeoutException thrown = assertThrows(TimeoutException.class,
                () -> run(task, () -> {
                    calls.incrementAndGet();
                    Thread.sleep(20L);
                    throw new TimeoutException("upstream idle");
                }));

        assertEquals(1, calls.get(), "预算再小也必须发出首次尝试，且不应再重试");
        assertEquals("upstream idle", thrown.getMessage(),
                "必须原样上抛 TimeoutException：上层按其类型给出「响应超时」文案");
    }

    @Test
    @DisplayName("极小预算：非超时类异常同样原样上抛，不引入新异常类型")
    void tinyDeadline_preservesBusinessExceptionType() {
        AtomicInteger calls = new AtomicInteger();
        RetryTask task = fastTask().totalDeadline(Duration.ofMillis(1));

        BoomException thrown = assertThrows(BoomException.class,
                () -> run(task, () -> {
                    calls.incrementAndGet();
                    Thread.sleep(20L);
                    throw new BoomException("boom");
                }));

        assertEquals(1, calls.get());
        assertEquals("boom", thrown.getMessage());
        assertNull(thrown.getCause(), "预算耗尽不得包装异常");
    }

    @Test
    @DisplayName("宽裕预算（30s）：重试次数与未配置时完全一致，不误杀")
    void generousDeadline_doesNotReduceAttempts() {
        AtomicInteger calls = new AtomicInteger();
        RetryTask task = fastTask().totalDeadline(Duration.ofSeconds(30));

        BoomException thrown = assertThrows(BoomException.class,
                () -> run(task, () -> {
                    calls.incrementAndGet();
                    throw new BoomException("boom");
                }));

        assertEquals(RetryTask.DEFAULT_MAX_RETRIES, calls.get(), "宽裕预算不得减少尝试次数");
        assertEquals("boom", thrown.getMessage());
    }

    @Test
    @DisplayName("宽裕预算下重试监听仍按 maxRetries-1 次通知")
    void generousDeadline_keepsRetryListenerNotifications() {
        AtomicInteger calls = new AtomicInteger();
        AtomicInteger notices = new AtomicInteger();
        RetryTask task = fastTask()
                .totalDeadline(Duration.ofSeconds(30))
                .onRetry((attempt, e) -> notices.incrementAndGet());

        assertThrows(BoomException.class,
                () -> run(task, () -> {
                    calls.incrementAndGet();
                    throw new BoomException("boom");
                }));

        assertEquals(RetryTask.DEFAULT_MAX_RETRIES, calls.get());
        assertEquals(RetryTask.DEFAULT_MAX_RETRIES - 1, notices.get(), "最后一次失败后不再通知重试");
    }

    @Test
    @DisplayName("与 retryIf 共存：retryIf 先命中时立即抛原异常，与是否配置预算无关")
    void retryIfShortCircuit_isIndependentOfDeadline() {
        // 配置了极小预算
        AtomicInteger withDeadlineCalls = new AtomicInteger();
        RetryTask withDeadline = fastTask()
                .retryIf(e -> (e instanceof IllegalStateException) == false)
                .totalDeadline(Duration.ofMillis(1));

        IllegalStateException thrown = assertThrows(IllegalStateException.class,
                () -> run(withDeadline, () -> {
                    withDeadlineCalls.incrementAndGet();
                    throw new IllegalStateException("fatal");
                }));

        assertEquals(1, withDeadlineCalls.get(), "retryIf 拒绝重试时只发生一次尝试");
        assertEquals("fatal", thrown.getMessage(), "必须是 retryIf 命中的原始异常");

        // 对照组：未配置预算，行为必须逐字一致
        AtomicInteger plainCalls = new AtomicInteger();
        RetryTask plain = fastTask().retryIf(e -> (e instanceof IllegalStateException) == false);

        assertThrows(IllegalStateException.class,
                () -> run(plain, () -> {
                    plainCalls.incrementAndGet();
                    throw new IllegalStateException("fatal");
                }));

        assertEquals(plainCalls.get(), withDeadlineCalls.get(), "预算不得改变 retryIf 的短路语义");
    }

    @Test
    @DisplayName("与 retryIf 共存：retryIf 放行的异常在宽裕预算下照常重试")
    void retryIfPassThrough_stillRetriesUnderGenerousDeadline() {
        AtomicInteger calls = new AtomicInteger();
        RetryTask task = fastTask()
                .retryIf(e -> (e instanceof IllegalStateException) == false)
                .totalDeadline(Duration.ofSeconds(30));

        assertThrows(BoomException.class,
                () -> run(task, () -> {
                    calls.incrementAndGet();
                    throw new BoomException("boom");
                }));

        assertEquals(RetryTask.DEFAULT_MAX_RETRIES, calls.get(),
                "retryIf 放行 + 预算宽裕 → 两个终止条件都不成立，必须用尽重试");
    }

    @Test
    @DisplayName("成功路径：配置预算后首次成功即返回，不受预算影响")
    void deadlineDoesNotAffectSuccessPath() throws Throwable {
        AtomicInteger calls = new AtomicInteger();
        RetryTask task = fastTask().totalDeadline(Duration.ofMillis(1));

        String result = task.<String, Throwable>callWithRetry(() -> {
            calls.incrementAndGet();
            return "ok";
        });

        assertEquals("ok", result);
        assertEquals(1, calls.get());
    }

    @Test
    @DisplayName("超大预算（纳秒溢出）按未配置处理，不抛配置异常")
    void hugeDeadline_isTreatedAsUnconfigured() {
        AtomicInteger calls = new AtomicInteger();
        RetryTask task = fastTask().totalDeadline(Duration.ofDays(365L * 1000L));

        assertThrows(BoomException.class,
                () -> run(task, () -> {
                    calls.incrementAndGet();
                    throw new BoomException("boom");
                }));

        assertTrue(calls.get() == RetryTask.DEFAULT_MAX_RETRIES,
                "纳秒溢出的预算等价于无上限，应用尽重试次数，实际=" + calls.get());
    }
}
