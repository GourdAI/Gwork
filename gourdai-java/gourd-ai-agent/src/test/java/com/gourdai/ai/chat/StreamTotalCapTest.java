package com.gourdai.ai.chat;

import org.junit.jupiter.api.Test;
import reactor.core.Exceptions;
import reactor.core.publisher.Flux;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 空转止损（2026-09-21）：流式<b>单次调用</b>的 wall-clock 总封顶。
 *
 * <p>背景：TTFT 与帧间预算都只约束「一段间隔」，对「持续有帧却永不收口」的半死流无效——
 * 每帧都会重置帧间计时器，单次调用因此无上界，上游一直在生成并计费。</p>
 *
 * <p><b>本类最关键的一条是 {@link #totalCapCancelsTheUpstreamSubscription()}</b>：
 * 止损的实质是<b>取消上游订阅</b>（→ {@code sink.onDispose} → 关连接 → 上游停止生成）。
 * 实测 {@code takeUntilOther} 只传播错误而<b>不取消主源</b>（源持续发射、仅被 onNextDropped 丢弃），
 * 用它做封顶只会得到「界面报超时、后台继续烧钱」的假止损；{@code FluxTimeout} 才会先 cancel。</p>
 */
class StreamTotalCapTest {

    /** 帧间预算给得足够大，确保测试中终止的唯一可能来源是总封顶 */
    private static final Duration HUGE_ITEM_TIMEOUT = Duration.ofSeconds(30);

    @Test
    void slowDripStreamIsTerminatedByTotalCap() {
        //持续有帧、永不完成：帧间预算（30s）永远不会触发，只有总封顶（300ms）能终止它
        Flux<Long> slowDrip = Flux.interval(Duration.ofMillis(20));

        long startAt = System.currentTimeMillis();
        RuntimeException thrown = assertThrows(RuntimeException.class, () ->
                ChatRequestDescDefault.withTimeoutBudgets(slowDrip, HUGE_ITEM_TIMEOUT,
                                HUGE_ITEM_TIMEOUT, Duration.ofMillis(300))
                        .blockLast(Duration.ofSeconds(10)));
        long elapsed = System.currentTimeMillis() - startAt;

        assertTrue(Exceptions.unwrap(thrown) instanceof TimeoutException,
                "总封顶必须以 TimeoutException 终止（上层按超时语义分流文案与重试），实际: "
                        + Exceptions.unwrap(thrown));
        assertTrue(elapsed < 5_000L,
                "必须在总封顶时刻终止，而非等到帧间预算，实际耗时 " + elapsed + "ms");
    }

    @Test
    void totalCapCancelsTheUpstreamSubscription() {
        AtomicBoolean cancelled = new AtomicBoolean(false);
        Flux<Long> slowDrip = Flux.interval(Duration.ofMillis(20)).doOnCancel(() -> cancelled.set(true));

        assertThrows(RuntimeException.class, () ->
                ChatRequestDescDefault.withTimeoutBudgets(slowDrip, HUGE_ITEM_TIMEOUT,
                                HUGE_ITEM_TIMEOUT, Duration.ofMillis(200))
                        .blockLast(Duration.ofSeconds(10)));

        assertTrue(cancelled.get(),
                "总封顶触发后必须取消上游订阅，否则连接不会被关闭、上游继续生成并计费");
    }

    @Test
    void normalStreamCompletesImmediatelyAndIsNotHeldUntilCap() {
        long startAt = System.currentTimeMillis();

        List<Integer> got = ChatRequestDescDefault
                .withTimeoutBudgets(Flux.just(1, 2, 3), Duration.ofSeconds(30),
                        HUGE_ITEM_TIMEOUT, Duration.ofSeconds(30))
                .collectList()
                .block(Duration.ofSeconds(10));

        long elapsed = System.currentTimeMillis() - startAt;

        assertEquals(List.of(1, 2, 3), got, "封顶不得改变正常流的元素与顺序");
        assertTrue(elapsed < 5_000L,
                "主流完成时必须立即收口（不被截止定时器拖到封顶时刻），实际耗时 " + elapsed + "ms");
    }

    @Test
    void sourceErrorIsPropagatedUnchanged() {
        IllegalStateException boom = new IllegalStateException("upstream boom");

        RuntimeException thrown = assertThrows(RuntimeException.class, () ->
                ChatRequestDescDefault.withTimeoutBudgets(Flux.<Integer>error(boom),
                                Duration.ofSeconds(30), HUGE_ITEM_TIMEOUT, Duration.ofSeconds(30))
                        .blockLast(Duration.ofSeconds(10)));

        assertSame(boom, Exceptions.unwrap(thrown), "封顶不得吞掉或改写上游的真实错误");
    }

    @Test
    void firstFrameTimeoutStillGovernsWhenBudgetIsAmple() {
        //零产出停滞型断流：TTFT 预算（200ms）必须照常生效，不被宽松的总封顶掩盖
        long startAt = System.currentTimeMillis();

        assertThrows(RuntimeException.class, () ->
                ChatRequestDescDefault.withTimeoutBudgets(Flux.never(), Duration.ofMillis(200),
                                HUGE_ITEM_TIMEOUT, Duration.ofSeconds(30))
                        .blockLast(Duration.ofSeconds(10)));

        long elapsed = System.currentTimeMillis() - startAt;
        assertTrue(elapsed < 5_000L, "TTFT 超时应在 200ms 量级触发，实际耗时 " + elapsed + "ms");
    }

    @Test
    void idleTimeoutStillGovernsWhenBudgetIsAmple() {
        //半途断流：先来一帧，之后无帧——必须由帧间预算（200ms）触发，而非等到总封顶
        Flux<Integer> stalled = Flux.concat(Flux.just(1), Flux.never());

        long startAt = System.currentTimeMillis();
        assertThrows(RuntimeException.class, () ->
                ChatRequestDescDefault.withTimeoutBudgets(stalled, Duration.ofSeconds(30),
                                Duration.ofMillis(200), Duration.ofSeconds(30))
                        .blockLast(Duration.ofSeconds(10)));
        long elapsed = System.currentTimeMillis() - startAt;

        assertTrue(elapsed < 5_000L, "帧间超时应在 200ms 量级触发，实际耗时 " + elapsed + "ms");
    }

    @Test
    void disabledCapKeepsTwoBudgetBehaviour() {
        //totalCap 未启用：退化为原有的两段式超时，正常流照常通过
        for (Duration disabled : new Duration[]{null, Duration.ZERO, Duration.ofSeconds(-1)}) {
            List<Integer> got = ChatRequestDescDefault
                    .withTimeoutBudgets(Flux.just(7), Duration.ofSeconds(30), HUGE_ITEM_TIMEOUT, disabled)
                    .collectList()
                    .block(Duration.ofSeconds(10));

            assertEquals(List.of(7), got, "未启用封顶时行为必须逐字不变（cap=" + disabled + "）");
        }
    }

    @Test
    void budgetIsRestartedOnEachSubscription() {
        //同一个 Flux 可被重复订阅（工具链路会递归发起新的 internalStream）：
        //总预算必须在订阅时起算，否则第二次订阅一上来就超时。
        Flux<Integer> capped = ChatRequestDescDefault.withTimeoutBudgets(
                Flux.just(1), Duration.ofSeconds(30), HUGE_ITEM_TIMEOUT, Duration.ofMillis(400));

        assertEquals(List.of(1), capped.collectList().block(Duration.ofSeconds(10)));

        try {
            Thread.sleep(500L); //刻意睡过封顶时长
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }

        assertEquals(List.of(1), capped.collectList().block(Duration.ofSeconds(10)),
                "第二次订阅必须重新起算总预算");
    }

    @Test
    void totalTimeoutIsTenTimesConfiguredValue() {
        assertEquals(Duration.ofMinutes(20),
                ChatRequestDescDefault.resolveStreamTotalTimeout(Duration.ofSeconds(120)));
        assertEquals(Duration.ofMinutes(20),
                ChatRequestDescDefault.resolveStreamTotalTimeout(null));
        assertEquals(Duration.ofMinutes(20),
                ChatRequestDescDefault.resolveStreamTotalTimeout(Duration.ZERO));
    }

    @Test
    void totalTimeoutHasFloorAndCap() {
        //短配置：×10 仍不足 10 分钟 → 抬到下限（正常长回答不被拦腰截断）
        assertEquals(Duration.ofMinutes(10),
                ChatRequestDescDefault.resolveStreamTotalTimeout(Duration.ofSeconds(30)));
        assertEquals(Duration.ofMinutes(10),
                ChatRequestDescDefault.resolveStreamTotalTimeout(Duration.ofSeconds(5)));

        //长配置：×10 超过封顶 → 封顶
        assertEquals(Duration.ofMinutes(25),
                ChatRequestDescDefault.resolveStreamTotalTimeout(Duration.ofSeconds(300)));
        assertEquals(Duration.ofMinutes(25),
                ChatRequestDescDefault.resolveStreamTotalTimeout(Duration.ofDays(400)));
    }

    @Test
    void streamTotalCapStaysBelowReasonTaskBlockLastGuard() {
        //分层不变量：流层必须先于 ReasonTask 的 blockLast(30min) 触发，
        //否则超时判定权落到只会解放调用线程的兜底层，连接不会被及时关闭。
        Duration reasonTaskBlockLastGuard = Duration.ofMinutes(30);

        for (Duration configured : List.of(Duration.ofSeconds(5), Duration.ofSeconds(120),
                Duration.ofSeconds(300), Duration.ofHours(10))) {
            Duration total = ChatRequestDescDefault.resolveStreamTotalTimeout(configured);
            assertTrue(total.compareTo(reasonTaskBlockLastGuard) < 0,
                    "配置 " + configured + " 推导出的总封顶 " + total + " 必须严格小于 30 分钟兜底");
        }
    }
}
