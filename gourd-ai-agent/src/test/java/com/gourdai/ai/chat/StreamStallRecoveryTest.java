package com.gourdai.ai.chat;

import com.gourdai.ai.chat.event.ChatEvent;
import com.gourdai.ai.chat.event.ChatEventType;
import com.gourdai.ai.util.RetryTask;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * SSE 流中途断流的终止契约测试。
 *
 * <p>背景（2026-09-18 桌面版「长时间等待响应」事故）：供应商流式响应出过 token 后中途断流
 * （连接不关、不再发帧），部分场景下超时错误信号在传播链上被挂起，run 永不终结、
 * 前端永远停在等待态。本测试钉死三条契约：</p>
 *
 * <ol>
 *   <li>断流必须以超时异常 <b>终结</b>（可被 RetryTask 捕获重试），且流内必须出现
 *       {@code ERROR} 终态事件供订阅方观测失败——绝不允许永久挂起或静默完成；
 *       （2026-09-18 弱网拆分后：零产出停滞由 TTFT 预算终结；出帧后断流由流层帧间
 *       空闲预算终结，其下限 15s 防误杀——慢验证由消费侧外层叠加快速覆盖，见 3b）</li>
 *   <li>帧间隔小于超时的<b>慢而活跃</b>流不得被误杀（超时为相邻事件间隔语义，非总时长）；
 *       帧间隔超过配置超时但在帧间下限内的慢流同样不得被误杀（拆分后帧间独立预算，见 4）</li>
 *   <li>消费侧叠加外层 idle-timeout 兜底（ReasonTask 修复引入的层级）不得破坏活跃流，
 *       且在内层超时失效时能独立终结断流。</li>
 * </ol>
 */
class StreamStallRecoveryTest {
    /** OpenAI 方言的标准 SSE 终止帧 */
    private static final String DONE_FRAME = "data: [DONE]\n\n";

    /** OpenAI 方言的正文增量帧 */
    private static String delta(String text) {
        return "data: {\"choices\":[{\"delta\":{\"content\":\"" + text + "\"}}]}\n\n";
    }

    private static byte[] utf8(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    /** 以 chunked SSE 方式开始响应 */
    private static OutputStream sseStart(HttpExchange ex) throws IOException {
        ex.getResponseHeaders().set("Content-Type", "text/event-stream");
        ex.sendResponseHeaders(200, 0);
        return ex.getResponseBody();
    }

    /** 沿 cause 链查找 TimeoutException */
    private static boolean hasTimeoutInChain(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof java.util.concurrent.TimeoutException) {
                return true;
            }
        }
        return false;
    }

    @FunctionalInterface
    interface StallHandler {
        void handle(HttpExchange ex, int hit) throws Exception;
    }

    /** 回环 SSE mock 服务器；handler 行为由用例注入，daemon 线程池保证不阻塞性 JVM 退出 */
    static class SseMock implements AutoCloseable {
        final HttpServer server;
        final ExecutorService pool;
        final AtomicInteger hits = new AtomicInteger();

        SseMock(StallHandler handler) throws Exception {
            pool = Executors.newCachedThreadPool(r -> {
                Thread t = new Thread(r, "sse-mock");
                t.setDaemon(true);
                return t;
            });
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.setExecutor(pool);
            server.createContext("/", ex -> {
                int hit = hits.incrementAndGet();
                try {
                    ex.getRequestBody().readAllBytes();
                    handler.handle(ex, hit);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                } catch (Throwable ignore) {
                    // 客户端断开等连接生命周期异常不属于测试断言范畴
                }
            });
            server.start();
        }

        String url() {
            return "http://127.0.0.1:" + server.getAddress().getPort();
        }

        ChatModel model(long timeoutMs) {
            return ChatModel.of(url()).standard("openai").model("gpt-test")
                    .apiKey("test").timeout(Duration.ofMillis(timeoutMs)).build();
        }

        @Override
        public void close() {
            server.stop(0);
            pool.shutdownNow();
        }
    }

    /** 契约 1a：断流必须以超时异常终结，且 ERROR 终态事件可见——不允许永久挂起。
     *  用例形态：TTFT 停滞（连接后响应头都不返回，历史 16 次超时的主流形态）。
     *  此阶段 Mono.fromFuture 挂起、无任何事件经过 timeout 操作符，由 firstTimeout
     *  （TTFT=配置值）终结。响应头已回但零数据帧的半死流由流层帧间预算终结
     *  （下限 15s 防误杀，快速验证见 3b 外层叠加）。 */
    @Test
    void stalledStreamMustTerminateWithTimeoutAndErrorEvent() throws Exception {
        try (SseMock mock = new SseMock((ex, hit) -> {
            // 读掉请求体后不发响应头：客户端 Mono.fromFuture 挂起（TTFT 停滞）
            Thread.sleep(30_000);
        })) {
            ChatModel model = mock.model(300);

            List<ChatEvent> events = new CopyOnWriteArrayList<>();
            AtomicReference<Throwable> error = new AtomicReference<>();
            CountDownLatch done = new CountDownLatch(1);

            model.prompt("hi").stream()
                    .subscribe(events::add,
                            err -> {
                                error.set(err);
                                done.countDown();
                            },
                            done::countDown);

            assertTrue(done.await(5, TimeUnit.SECONDS),
                    "stalled stream must terminate instead of hanging forever");
            assertNotNull(error.get(), "stalled stream must fail loudly, not complete silently");
            assertTrue(hasTimeoutInChain(error.get()),
                    "failure should be (or wrap) a TimeoutException but was: " + error.get());
            assertTrue(events.stream().anyMatch(e -> e.getType() == ChatEventType.ERROR),
                    "stalled stream must emit an ERROR terminal event so subscribers can observe the failure");
        }
    }

    /** 契约 2a：帧间隔小于超时的慢流不得被误杀 */
    @Test
    void slowButActiveStreamMustNotBeKilledByIdleTimeout() throws Exception {
        try (SseMock mock = new SseMock((ex, hit) -> {
            OutputStream os = sseStart(ex);
            for (int i = 0; i < 5; i++) {
                os.write(utf8(delta("a")));
                os.flush();
                Thread.sleep(80); // 间隔 80ms，远小于模型超时 500ms
            }
            os.write(utf8(DONE_FRAME));
            os.flush();
            ex.close();
        })) {
            ChatModel model = mock.model(500);

            List<ChatEvent> events = model.prompt("hi").stream()
                    .collectList().block(Duration.ofSeconds(5));

            assertNotNull(events, "active stream must complete normally");
            assertFalse(events.stream().anyMatch(e -> e.getType() == ChatEventType.ERROR),
                    "active stream must not fail");
            assertTrue(events.stream().anyMatch(e -> e.getType() == ChatEventType.RESPONSE_END),
                    "active stream must end with RESPONSE_END");
            assertEquals("aaaaa", events.stream()
                            .filter(e -> e.getType() == ChatEventType.TEXT_DELTA)
                            .map(ChatEvent::getText)
                            .reduce("", String::concat),
                    "all delta frames must be delivered");
        }
    }

    /** 契约 3a：消费侧叠加外层 idle-timeout（ReasonTask 兜底层）不得误杀活跃流 */
    @Test
    void outerIdleTimeoutLayerMustNotBreakActiveStream() throws Exception {
        try (SseMock mock = new SseMock((ex, hit) -> {
            OutputStream os = sseStart(ex);
            for (int i = 0; i < 5; i++) {
                os.write(utf8(delta("a")));
                os.flush();
                Thread.sleep(80);
            }
            os.write(utf8(DONE_FRAME));
            os.flush();
            ex.close();
        })) {
            ChatModel model = mock.model(500);

            List<ChatEvent> events = model.prompt("hi").stream()
                    .timeout(Duration.ofMillis(600)) // 模拟 ReasonTask 新增的外层兜底（间隔语义）
                    .collectList().block(Duration.ofSeconds(5));

            assertNotNull(events, "outer timeout layer must not break an active stream");
            assertFalse(events.stream().anyMatch(e -> e.getType() == ChatEventType.ERROR));
            assertTrue(events.stream().anyMatch(e -> e.getType() == ChatEventType.RESPONSE_END));
        }
    }

    /** 契约 3b：内层超时失效（超长配置）时，外层 idle-timeout 必须独立终结断流 */
    @Test
    void outerIdleTimeoutMustTerminateStalledStreamWhenInnerTimeoutIsLong() throws Exception {
        try (SseMock mock = new SseMock((ex, hit) -> {
            OutputStream os = sseStart(ex);
            os.write(utf8(delta("he")));
            os.flush();
            Thread.sleep(30_000); // 断流
        })) {
            ChatModel model = mock.model(60_000); // 内层超时 60s，本用例时间内不会触发

            AtomicReference<Throwable> error = new AtomicReference<>();
            CountDownLatch done = new CountDownLatch(1);

            model.prompt("hi").stream()
                    .timeout(Duration.ofMillis(300)) // 外层兜底独立触发
                    .subscribe(e -> {
                    }, err -> {
                        error.set(err);
                        done.countDown();
                    }, done::countDown);

            assertTrue(done.await(5, TimeUnit.SECONDS),
                    "outer timeout layer must terminate a stalled stream even if inner timeout never fires");
            assertNotNull(error.get());
            assertTrue(hasTimeoutInChain(error.get()),
                    "outer failure should be (or wrap) a TimeoutException but was: " + error.get());
        }
    }

    /** 契约 1b：断流 → RetryTask 重试 → 恢复（ReasonTask 的真实消费模式：blockLast 带硬兜底）。
     *  用例形态：首次尝试 TTFT 停滞（响应头不回，firstTimeout 预算终结），重试后正常完成。 */
    @Test
    void stalledStreamThenRetryRecovers() throws Exception {
        try (SseMock mock = new SseMock((ex, hit) -> {
            if (hit == 1) {
                // 首次尝试：读掉请求体后不发响应头（TTFT 300ms 预算终结本次尝试）
                Thread.sleep(30_000);
            }
            OutputStream os = sseStart(ex);
            os.write(utf8(delta("ok")));
            os.flush();
            os.write(utf8(delta("more")));
            os.flush();
            os.write(utf8(DONE_FRAME));
            os.flush();
            ex.close();
        })) {
            ChatModel model = mock.model(300);

            AtomicInteger retryCount = new AtomicInteger();
            String result = new RetryTask()
                    .maxRetries(3)
                    .initialDelayMs(50L)
                    .onRetry((attempt, e) -> retryCount.set(attempt))
                    .callWithRetry(() -> {
                        // 与 ReasonTask 相同的消费模式：blockLast 带总时长硬兜底
                        model.prompt("hi").stream().blockLast(Duration.ofSeconds(5));
                        return "ok";
                    });

            assertEquals("ok", result, "retry must recover from the stalled first attempt");
            assertTrue(retryCount.get() >= 1, "first attempt must have failed and triggered a retry");
            assertTrue(mock.hits.get() >= 2, "recovery requires a second HTTP attempt");
        }
    }

    /** 契约 4（2026-09-18 弱网拆分）：帧间空闲独立预算——帧间隔超过配置超时、
     *  但在帧间下限（15s）内的慢流不再被误杀。旧实现 TTFT 与帧间共用配置值，
     *  帧间隔 400ms > 配置 300ms 必杀；拆分后 TTFT=配置值、帧间=clamp(15s,60s)，
     *  慢流放行交由上层按真实完成处理。 */
    @Test
    void interFrameGapBeyondConfiguredTimeoutMustNotBeKilled() throws Exception {
        try (SseMock mock = new SseMock((ex, hit) -> {
            OutputStream os = sseStart(ex);
            os.write(utf8(delta("h"))); // 首帧立即到达（TTFT 预算内）
            os.flush();
            for (int i = 0; i < 4; i++) {
                Thread.sleep(400); // 帧间 400ms > 配置 300ms（旧实现必杀）
                os.write(utf8(delta("a")));
                os.flush();
            }
            os.write(utf8(DONE_FRAME));
            os.flush();
            ex.close();
        })) {
            ChatModel model = mock.model(300); // 配置 300ms：TTFT=300ms，帧间=15s 下限

            List<ChatEvent> events = model.prompt("hi").stream()
                    .collectList().block(Duration.ofSeconds(10));

            assertNotNull(events, "slow-gap stream must complete normally after the split");
            assertFalse(events.stream().anyMatch(e -> e.getType() == ChatEventType.ERROR),
                    "slow-gap stream must not fail");
            assertTrue(events.stream().anyMatch(e -> e.getType() == ChatEventType.RESPONSE_END),
                    "slow-gap stream must end with RESPONSE_END");
            assertEquals("haaaa", events.stream()
                            .filter(e -> e.getType() == ChatEventType.TEXT_DELTA)
                            .map(ChatEvent::getText)
                            .reduce("", String::concat),
                    "all delta frames must be delivered");
        }
    }
}
