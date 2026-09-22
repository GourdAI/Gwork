package com.gourdai.ai.chat;

import org.junit.jupiter.api.Test;
import reactor.core.Disposable;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 孤儿响应必关——<b>取消与完成交错</b>时的窗口闭合验证（2026-09-21 code review 补）。
 *
 * <p>{@link OrphanResponseClosureTest} 从上游视角验证了「响应迟到时连接确实被掐断」。
 * 本类补的是它没覆盖的并发维度：<b>下游取消与 HTTP 回调几乎同时发生</b>时，响应是否仍必然被关闭。</p>
 *
 * <p><b>为何值得单独锁定：</b>实测 reactor-core 3.8.5 字节码，
 * {@code MonoCompletionStageSubscription.cancel()} 先置 {@code cancelled=true}、之后才调
 * {@code future.cancel()}；而其完成回调 {@code apply(value, err)} 一旦看到 {@code cancelled} 为真，
 * 就把值交给 {@code Operators.onDiscard} 静默丢弃，<b>{@code flatMapMany} 的 mapper 根本不会执行</b>。
 * 也就是说，生产代码里「flatMapMany 入口复检」这道防线在该交错下<b>是失效的</b>。</p>
 *
 * <p><b>真正闭合窗口的是另外两点</b>（本测试锁定的就是它们）：
 * <ol>
 *   <li>{@code doOnCancel} 位于链路<b>末端</b>，取消信号必先经过它、再上传到 {@code Mono}，
 *       故 {@code abandoned} 的置位<b>严格早于</b> Reactor 自己的 {@code cancelled}；</li>
 *   <li>{@code whenComplete} 挂在<b>原始</b> future 上（而非被取消的 guardedFuture），
 *       无论下游是否还在都必定触发，此时 {@code abandoned} 必然已是 true → 关闭响应。</li>
 * </ol>
 * 顺带说明一个<b>被实测否决</b>的方案：{@code doOnDiscard(HttpResponse.class, ...)} 收不到这个值
 * （{@code onDiscard} 取的是 {@code actual.currentContext()}），放在 {@code flatMapMany} 前后都无效。</p>
 */
class DiscardedResponseClosureTest {

    /** 重复轮次：窗口是纳秒级的，单轮容易偶然避开，必须反复压 */
    private static final int ROUNDS = 500;

    /** 站位资源：语义等同于一个必须被 close 的 HttpResponse */
    private static final class FakeResource {
        final AtomicBoolean closed = new AtomicBoolean(false);

        void close() {
            closed.set(true);
        }
    }

    /**
     * 复现生产管线的防护结构，返回该轮响应是否被关闭。
     *
     * <p>结构与 {@code doStream} 逐点同构：guardedFuture 隔离 + whenComplete 双判
     * + flatMapMany 入口复检 + 末端 doOnCancel 打标。</p>
     */
    private static boolean runOneRound(boolean mapperRanOut[]) throws Exception {
        final FakeResource resource = new FakeResource();
        final CompletableFuture<FakeResource> rawFuture = new CompletableFuture<>();
        final AtomicBoolean abandoned = new AtomicBoolean(false);
        final CountDownLatch subscribed = new CountDownLatch(1);

        //【隔离】下游拿到的是派生 future；原始 future 上只挂我们的 whenComplete
        final CompletableFuture<FakeResource> guardedFuture = new CompletableFuture<>();
        rawFuture.whenComplete((res, err) -> {
            if (err != null) {
                guardedFuture.completeExceptionally(err);
                return;
            }
            //已放弃，或下游已不再接收 → 必须由我们关闭
            if (abandoned.get() || guardedFuture.complete(res) == false) {
                res.close();
            }
        });

        Flux<String> pipeline = Mono.fromFuture(guardedFuture)
                .doOnSubscribe(s -> subscribed.countDown())
                .flatMapMany(res -> {
                    if (abandoned.get()) {
                        res.close();
                        return Flux.empty();
                    }
                    mapperRanOut[0] = true;
                    return Flux.just("consumed");
                })
                .doOnCancel(() -> abandoned.set(true));

        Disposable disposable = pipeline.subscribe(v -> {
        }, e -> {
        });

        assertTrue(subscribed.await(5, TimeUnit.SECONDS), "管线应已订阅");

        //取消与完成紧贴着发生，尽可能压中交错窗口
        disposable.dispose();
        rawFuture.complete(resource);

        long deadline = System.currentTimeMillis() + 3_000L;
        while (resource.closed.get() == false && System.currentTimeMillis() < deadline) {
            Thread.sleep(1L);
        }
        return resource.closed.get();
    }

    @Test
    void responseMustBeClosedEvenWhenCancellationAndCompletionInterleave() throws Exception {
        boolean[] mapperRan = {false};
        int closed = 0;

        for (int i = 0; i < ROUNDS; i++) {
            if (runOneRound(mapperRan)) {
                closed++;
            }
        }

        assertEquals(ROUNDS, closed,
                "每一轮被放弃的响应都必须关闭：漏掉任意一轮，就意味着一条连接挂住、"
                        + "上游把整个回答生成完并计费（实测漏关 " + (ROUNDS - closed) + " 轮）");
        assertFalse(mapperRan[0],
                "下游已取消时 mapper 不应执行——这正是 flatMapMany 入口复检在该交错下会落空的原因，"
                        + "故关闭动作必须由 whenComplete 承担");
    }

    /**
     * 反向护栏：正常消费路径<b>绝不能</b>关闭响应。
     *
     * <p>否则会把正在被正常读取的响应流关掉，那是比原缺陷更严重的回归。</p>
     */
    @Test
    void normalConsumptionMustNotCloseTheResponse() {
        final FakeResource resource = new FakeResource();
        final CompletableFuture<FakeResource> rawFuture = new CompletableFuture<>();
        final AtomicBoolean abandoned = new AtomicBoolean(false);

        final CompletableFuture<FakeResource> guardedFuture = new CompletableFuture<>();
        rawFuture.whenComplete((res, err) -> {
            if (abandoned.get() || guardedFuture.complete(res) == false) {
                res.close();
            }
        });
        rawFuture.complete(resource);

        String result = Mono.fromFuture(guardedFuture)
                .flatMapMany(res -> {
                    if (abandoned.get()) {
                        res.close();
                        return Flux.<String>empty();
                    }
                    return Flux.just("consumed");
                })
                .doOnCancel(() -> abandoned.set(true))
                .blockLast(java.time.Duration.ofSeconds(5));

        assertEquals("consumed", result, "正常路径应正常产出");
        assertFalse(resource.closed.get(),
                "正常消费路径不得关闭响应，否则会掐掉正在读取的响应流");
    }
}
