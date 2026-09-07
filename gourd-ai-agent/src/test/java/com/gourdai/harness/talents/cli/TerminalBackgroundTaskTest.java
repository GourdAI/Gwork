package com.gourdai.harness.talents.cli;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Method;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

/**
 * 后台任务（bash run_in_background=true）关键契约测试。
 *
 * <p>覆盖两个此前失效的核心点：</p>
 * <ul>
 *   <li>进程结束必须触发完成回调——这是「无需轮询即可得知跑完没有」的唯一依据；</li>
 *   <li>后台硬超时不得复用同步的 2 分钟——否则长构建仍被 kill，后台模式失去意义。</li>
 * </ul>
 */
public class TerminalBackgroundTaskTest {

    private static Path workdir() {
        return Paths.get(".").toAbsolutePath().normalize();
    }

    @Test
    public void completionCallbackFiresWithExitCodeAndOutput() throws Exception {
        TerminalSessionManager manager = new TerminalSessionManager();
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<TerminalSessionManager.CommandSnapshot> ref = new AtomicReference<>();

        // yieldTimeMs=0：立即返回 session_id，不等待完成（后台模式的行为）
        TerminalSessionManager.CommandSnapshot started = manager.exec(
                "echo hello-bg", workdir(), new HashMap<>(), 0, 64_000, 60_000,
                done -> {
                    ref.set(done);
                    latch.countDown();
                });

        assertNotNull(started.sessionId());
        assertTrue(started.sessionId().startsWith("cmd_"), started.sessionId());

        assertTrue(latch.await(60, TimeUnit.SECONDS),
                "进程已结束却未触发完成回调：模型将永远收不到通知、只能死等");

        TerminalSessionManager.CommandSnapshot done = ref.get();
        assertNotNull(done);
        assertEquals(started.sessionId(), done.sessionId());
        assertEquals(Integer.valueOf(0), done.exitCode());
        assertTrue(done.output().contains("hello-bg"),
                "完成通知必须带上尾部输出，实际: [" + done.output() + "]");
    }

    @Test
    public void noticeSnapshotDoesNotConsumeIncrementalOutput() throws Exception {
        TerminalSessionManager manager = new TerminalSessionManager();
        CountDownLatch latch = new CountDownLatch(1);

        TerminalSessionManager.CommandSnapshot started = manager.exec(
                "echo keep-me", workdir(), new HashMap<>(), 0, 64_000, 60_000,
                done -> latch.countDown());

        assertTrue(latch.await(60, TimeUnit.SECONDS), "完成回调未触发");

        // 通知用的是非消费性尾部快照：这里再查一次仍应拿得到输出。
        // 若通知误用了 snapshot()（推进 nextOutputOffset），此处会返回空——即
        // 「收到通知后再查详情就什么都没有了」。
        TerminalSessionManager.CommandSnapshot peek =
                manager.writeStdin(started.sessionId(), null, 0, 64_000);
        assertTrue(peek.output().contains("keep-me"),
                "完成通知不得吃掉增量输出，bash_output 仍应可取，实际: [" + peek.output() + "]");
    }

    @Test
    public void peekOnFinishedSessionReportsExitCode() throws Exception {
        TerminalSessionManager manager = new TerminalSessionManager();
        CountDownLatch latch = new CountDownLatch(1);

        TerminalSessionManager.CommandSnapshot started = manager.exec(
                "echo done-check", workdir(), new HashMap<>(), 0, 64_000, 60_000,
                done -> latch.countDown());

        assertTrue(latch.await(60, TimeUnit.SECONDS), "完成回调未触发");

        TerminalSessionManager.CommandSnapshot peek =
                manager.writeStdin(started.sessionId(), null, 0, 64_000);
        assertEquals(Integer.valueOf(0), peek.exitCode());
        assertFalse(peek.running());
    }

    @Test
    public void backgroundTimeoutDefaultsFarBeyondSyncTimeout() throws Exception {
        Method m = TerminalTalent.class.getDeclaredMethod("backgroundTimeoutMs", Integer.class);
        m.setAccessible(true);

        int def = ((Integer) m.invoke(null, new Object[]{null})).intValue();
        assertEquals(6 * 60 * 60 * 1000, def, "后台默认硬超时应为 6 小时");
        assertTrue(def > 120_000,
                "后台硬超时若仍是同步的 2 分钟，长构建会被 kill，run_in_background 形同虚设");

        // 调用方显式指定时必须被尊重
        assertEquals(5_000, ((Integer) m.invoke(null, Integer.valueOf(5_000))).intValue());
        // 非法值（0/负数）回落默认
        assertEquals(def, ((Integer) m.invoke(null, Integer.valueOf(0))).intValue());
        assertEquals(def, ((Integer) m.invoke(null, Integer.valueOf(-1))).intValue());
    }

    @Test
    public void syncTimeoutKeepsLegacyTwoMinutes() throws Exception {
        Method m = TerminalTalent.class.getDeclaredMethod("syncTimeoutMs", Integer.class);
        m.setAccessible(true);

        // 同步路径行为不得因本次改造发生变化
        assertEquals(120_000, ((Integer) m.invoke(null, new Object[]{null})).intValue());
        assertEquals(3_000, ((Integer) m.invoke(null, Integer.valueOf(3_000))).intValue());
        assertEquals(120_000, ((Integer) m.invoke(null, Integer.valueOf(0))).intValue());
    }

    @Test
    public void unknownSessionRaisesIllegalArgument() {
        TerminalSessionManager manager = new TerminalSessionManager();
        boolean thrown = false;
        try {
            manager.writeStdin("cmd_not_exists", null, 0, 1_000);
        } catch (IllegalArgumentException e) {
            thrown = true;
        } catch (Exception e) {
            throw new AssertionError("应抛 IllegalArgumentException，实际: " + e);
        }
        // bashOutput 必须捕获它（会话完成 10 分钟后会被回收），否则异常逃逸出工具方法
        assertTrue(thrown, "未知 session 应抛 IllegalArgumentException");
    }
}
