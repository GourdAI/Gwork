package com.gourdai.ai.chat;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 孤儿响应必关（2026-09-21）：放弃一次流式调用时，<b>上游连接必须被真正掐断</b>。
 *
 * <p><b>病灶：</b>{@code bodyOfJson(...).execAsync("POST")} 内部是
 * {@code newCall(req).enqueue(callback)}，{@code okhttp3.Call} 引用当场丢弃。于是：
 * 取消那个 {@code CompletableFuture} 只能把它置为 CANCELLED，<b>传递不到 HTTP 层</b>；
 * 而取消后 {@code flatMapMany} 永不订阅，迟到的 {@code HttpResponse} <b>没有任何人 close</b>，
 * body 流与连接一直挂着，直到上游把整个回答生成完毕并<b>完成计费</b>。
 * 泄漏窗口恰好是「响应头还没回来」那一段——正是 TTFT 超时最常命中的窗口，
 * 于是形成「界面空转重试、后台每一次都真实生成并扣费」。</p>
 *
 * <p><b>本类的验证手法：</b>不去断言内部状态，而是<b>从上游视角</b>观测——让 mock 服务端
 * 在客户端放弃之后才开始写响应体。若连接确实被关闭，服务端的写入必然失败（broken pipe / RST）；
 * 若连接还挂着，服务端就能一路把几 MB 数据写完，那正是「后台继续生成、继续计费」的形态。</p>
 */
class OrphanResponseClosureTest {

    /** 单帧载荷放大，确保总写入量远超内核 socket 缓冲区，连接已断时必然写失败 */
    private static final int FRAME_PAYLOAD_CHARS = 4096;

    /** 服务端尝试写入的帧数 */
    private static final int FRAMES_TO_WRITE = 200;

    /**
     * 帧间间隔：必须模拟真实的 token 流速度。
     *
     * <p>不加间隔时，mock 会在不到半秒内把几 MB 写完，全被客户端与内核缓冲区吸掉，
     * close 来不及在中途掐断——那只是测试建模失真，不是真实场景。真实上游会持续
     * 生成数十秒，止损的价值正在于在那期间把连接掐断。</p>
     */
    private static final long FRAME_INTERVAL_MS = 20L;

    private static byte[] utf8(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    private static String bigDelta() {
        StringBuilder sb = new StringBuilder(FRAME_PAYLOAD_CHARS);
        for (int i = 0; i < FRAME_PAYLOAD_CHARS; i++) {
            sb.append('a');
        }
        return "data: {\"choices\":[{\"delta\":{\"content\":\"" + sb + "\"}}]}\n\n";
    }

    @Test
    void lateResponseAfterTtftTimeoutMustBeClosedSoTheUpstreamStopsGenerating() throws Exception {
        final AtomicBoolean upstreamWriteFailed = new AtomicBoolean(false);
        final AtomicBoolean upstreamWroteEverything = new AtomicBoolean(false);
        final CountDownLatch upstreamFinished = new CountDownLatch(1);

        try (StreamStallRecoveryTest.SseMock mock = new StreamStallRecoveryTest.SseMock((ex, hit) -> {
            //刻意让响应头迟到：客户端在 TTFT(300ms) 处放弃，此时请求早已被上游受理并开始生成
            Thread.sleep(900);

            ex.getResponseHeaders().set("Content-Type", "text/event-stream");
            ex.sendResponseHeaders(200, 0);

            try (OutputStream os = ex.getResponseBody()) {
                byte[] frame = utf8(bigDelta());
                for (int i = 0; i < FRAMES_TO_WRITE; i++) {
                    os.write(frame);
                    os.flush();
                    Thread.sleep(FRAME_INTERVAL_MS); //按真实 token 流速度吞吐
                }
                //一路写完 = 连接还挂着 = 上游会把整个回答生成完并计费（正是要修的缺陷）
                upstreamWroteEverything.set(true);
            } catch (IOException e) {
                //写失败 = 连接已被客户端关闭 = 上游生成被掐断 = 止损成功
                upstreamWriteFailed.set(true);
            } finally {
                upstreamFinished.countDown();
            }
        })) {
            ChatModel model = mock.model(300);

            AtomicReference<Throwable> error = new AtomicReference<>();
            CountDownLatch clientDone = new CountDownLatch(1);

            model.prompt("hi").stream().subscribe(
                    e -> {
                    },
                    err -> {
                        error.set(err);
                        clientDone.countDown();
                    },
                    clientDone::countDown);

            assertTrue(clientDone.await(10, TimeUnit.SECONDS),
                    "客户端必须在 TTFT 预算处放弃，而不是无限等待");
            assertNotNull(error.get(), "放弃必须表现为失败信号，而非静默完成");

            assertTrue(upstreamFinished.await(20, TimeUnit.SECONDS),
                    "服务端写入应在连接断开后很快结束");

            assertTrue(upstreamWriteFailed.get(),
                    "被放弃的响应必须被关闭：服务端写入应因连接断开而失败。"
                            + " 若服务端能一路写完（wroteEverything=" + upstreamWroteEverything.get()
                            + "），说明孤儿连接仍挂着，上游会把整个回答生成完并计费。");
        }
    }
}
