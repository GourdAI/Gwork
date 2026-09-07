package com.gourdai.agent.react;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.noear.solon.flow.FlowContext;
import org.noear.solon.flow.FlowContextDefault;

/**
 * 后台任务完成通知中心测试。
 *
 * <p>覆盖「系统主动告知」替代「模型轮询」的核心契约：投递-消费、归属隔离、容量兜底、
 * 线程归属绑定。归属隔离是重点——TerminalTalent 为全局单例，若通知不分桶，A 会话会
 * 收到 B 会话的后台任务完成消息。</p>
 */
public class BackgroundNoticeCenterTest {

    @BeforeEach
    public void setUp() {
        BackgroundNoticeCenter.resetForTest();
    }

    @AfterEach
    public void tearDown() {
        BackgroundNoticeCenter.resetForTest();
    }

    private static BackgroundNoticeCenter.Notice notice(String sessionId) {
        return new BackgroundNoticeCenter.Notice(sessionId, "echo hi", Integer.valueOf(0),
                false, false, 1234L, "hi");
    }

    @Test
    public void publishThenDrainReturnsNoticeOnce() {
        BackgroundNoticeCenter.publish("owner-1", notice("cmd_a"));

        List<BackgroundNoticeCenter.Notice> first = BackgroundNoticeCenter.drain("owner-1");
        assertEquals(1, first.size());
        assertEquals("cmd_a", first.get(0).sessionId());

        // 消费后即清空：同一条通知不会被重复注入历史（否则每轮都重复告知一次）
        assertTrue(BackgroundNoticeCenter.drain("owner-1").isEmpty());
    }

    @Test
    public void noticesAreIsolatedBetweenOwners() {
        BackgroundNoticeCenter.publish("owner-A", notice("cmd_a"));
        BackgroundNoticeCenter.publish("owner-B", notice("cmd_b"));

        List<BackgroundNoticeCenter.Notice> a = BackgroundNoticeCenter.drain("owner-A");
        assertEquals(1, a.size());
        assertEquals("cmd_a", a.get(0).sessionId());

        List<BackgroundNoticeCenter.Notice> b = BackgroundNoticeCenter.drain("owner-B");
        assertEquals(1, b.size());
        assertEquals("cmd_b", b.get(0).sessionId());
    }

    @Test
    public void drainOnUnknownOwnerReturnsEmptyNotNull() {
        assertTrue(BackgroundNoticeCenter.drain("never-used").isEmpty());
        assertTrue(BackgroundNoticeCenter.drain(null).isEmpty());
        assertTrue(BackgroundNoticeCenter.drain("").isEmpty());
    }

    @Test
    public void publishWithoutOwnerIsDropped() {
        BackgroundNoticeCenter.publish(null, notice("cmd_x"));
        BackgroundNoticeCenter.publish("", notice("cmd_x"));
        assertEquals(0, BackgroundNoticeCenter.pendingCountForTest(""));
    }

    @Test
    public void queueIsCappedKeepingMostRecent() {
        // 会话被遗弃（用户关页）时通知不能无限堆积；超量应丢最旧、留最新
        for (int i = 0; i < 100; i++) {
            BackgroundNoticeCenter.publish("owner-cap", notice("cmd_" + i));
        }
        assertEquals(32, BackgroundNoticeCenter.pendingCountForTest("owner-cap"));

        List<BackgroundNoticeCenter.Notice> drained = BackgroundNoticeCenter.drain("owner-cap");
        assertEquals(32, drained.size());
        assertEquals("cmd_99", drained.get(drained.size() - 1).sessionId());
        assertEquals("cmd_68", drained.get(0).sessionId());
    }

    @Test
    public void discardClearsPendingNotices() {
        BackgroundNoticeCenter.publish("owner-d", notice("cmd_a"));
        BackgroundNoticeCenter.discard("owner-d");
        assertTrue(BackgroundNoticeCenter.drain("owner-d").isEmpty());
    }

    /**
     * P1 回归：drain 不得摘走归属桶。
     *
     * <p>旧实现用 NOTICES.remove(owner) 整体摘桶，若投递线程已持有旧队列引用，
     * 其后续 offer 会写进一个已脏的队列，通知永久丢失。此处用“drain 后同归属再投递”
     * 模拟该时序：只要桶实例没被换掉，新通知就必须能被下一次 drain 取到。</p>
     */
    @Test
    public void drainKeepsBucketSoConcurrentPublishIsNotLost() {
        BackgroundNoticeCenter.publish("owner-race", notice("cmd_1"));
        assertEquals(1, BackgroundNoticeCenter.drain("owner-race").size());

        // drain 后桶仍应存在（只是空的），而不是被整个移除
        assertEquals(1, BackgroundNoticeCenter.ownerCountForTest());

        BackgroundNoticeCenter.publish("owner-race", notice("cmd_2"));
        List<BackgroundNoticeCenter.Notice> second = BackgroundNoticeCenter.drain("owner-race");
        assertEquals(1, second.size());
        assertEquals("cmd_2", second.get(0).sessionId());
    }

    /**
     * P2 回归：遗弃桶必须可被时间兜底回收。
     *
     * <p>owner 存于 FlowContext（内存态），LRU 淘汰后会话从磁盘重载会丢掉 owner，
     * 这类桶永远等不到 discard，只能靠 TTL 清理。</p>
     */
    @Test
    public void staleOwnerBucketIsReclaimed() {
        BackgroundNoticeCenter.publish("owner-stale", notice("cmd_a"));
        assertEquals(1, BackgroundNoticeCenter.ownerCountForTest());

        // 未超时且非空：不得回收，否则会误删活跃会话的待消费通知
        BackgroundNoticeCenter.evictForTest();
        assertEquals(1, BackgroundNoticeCenter.ownerCountForTest());
        assertEquals(1, BackgroundNoticeCenter.pendingCountForTest("owner-stale"));

        // 超过 TTL（6 小时）后应被回收
        BackgroundNoticeCenter.agingForTest("owner-stale", 7L * 60 * 60 * 1000);
        BackgroundNoticeCenter.evictForTest();
        assertEquals(0, BackgroundNoticeCenter.ownerCountForTest());
    }

    /**
     * 空桶（已消费完）可直接回收，不需等 TTL。
     */
    @Test
    public void emptyBucketIsReclaimedImmediately() {
        BackgroundNoticeCenter.publish("owner-empty", notice("cmd_a"));
        BackgroundNoticeCenter.drain("owner-empty");

        BackgroundNoticeCenter.evictForTest();
        assertEquals(0, BackgroundNoticeCenter.ownerCountForTest());
    }

    /**
     * discardByContext：会话删除时从 context 取 owner 并回收桶。
     */
    @Test
    public void discardByContextReclaimsBucket() {
        FlowContext context = new FlowContextDefault();
        String owner = BackgroundNoticeCenter.resolveOwner(context);
        BackgroundNoticeCenter.publish(owner, notice("cmd_a"));
        assertEquals(1, BackgroundNoticeCenter.ownerCountForTest());

        BackgroundNoticeCenter.discardByContext(context);
        assertEquals(0, BackgroundNoticeCenter.ownerCountForTest());

        // 从未启动过后台任务的会话（无 owner）不应报错
        BackgroundNoticeCenter.discardByContext(new FlowContextDefault());
        BackgroundNoticeCenter.discardByContext(null);
    }

    @Test
    public void currentOwnerBindAndUnbind() {
        assertNull(BackgroundNoticeCenter.currentOwner());

        BackgroundNoticeCenter.bindCurrentOwner("owner-t");
        assertEquals("owner-t", BackgroundNoticeCenter.currentOwner());

        // 解绑必须彻底：线程复用下残留归属会把通知投递到错误的会话
        BackgroundNoticeCenter.unbindCurrentOwner();
        assertNull(BackgroundNoticeCenter.currentOwner());
    }

    @Test
    public void bindNullClearsOwner() {
        BackgroundNoticeCenter.bindCurrentOwner("owner-t");
        BackgroundNoticeCenter.bindCurrentOwner(null);
        assertNull(BackgroundNoticeCenter.currentOwner());
    }

    @Test
    public void resolveOwnerCreatesOnceAndCaches() {
        FlowContext context = new FlowContextDefault();

        // 消费端只 peek，不应凭空创建归属键（从未跑过后台任务的会话不该有开销）
        assertNull(BackgroundNoticeCenter.peekOwner(context));

        String owner = BackgroundNoticeCenter.resolveOwner(context);
        assertNotNull(owner);
        assertTrue(owner.startsWith("bg_"));

        // 同一 context 反复解析必须稳定，否则通知会投到一个没人消费的桶里
        assertEquals(owner, BackgroundNoticeCenter.resolveOwner(context));
        assertEquals(owner, BackgroundNoticeCenter.peekOwner(context));
    }

    @Test
    public void resolveOwnerDiffersAcrossContexts() {
        String a = BackgroundNoticeCenter.resolveOwner(new FlowContextDefault());
        String b = BackgroundNoticeCenter.resolveOwner(new FlowContextDefault());
        assertNotNull(a);
        assertNotNull(b);
        assertTrue(a.equals(b) == false, "不同会话（含子代理）必须拿到不同归属键");
    }

    @Test
    public void resolveOwnerOnNullContextReturnsNull() {
        assertNull(BackgroundNoticeCenter.resolveOwner(null));
        assertNull(BackgroundNoticeCenter.peekOwner(null));
    }

    @Test
    public void renderContainsSessionExitCodeAndTail() {
        BackgroundNoticeCenter.Notice n = new BackgroundNoticeCenter.Notice(
                "cmd_abc", "mvn test", Integer.valueOf(1), false, false, 9876L, "BUILD FAILURE");
        String text = n.render();

        assertTrue(text.contains("[后台任务完成]"), text);
        assertTrue(text.contains("cmd_abc"), text);
        assertTrue(text.contains("exit_code=1"), text);
        assertTrue(text.contains("status=finished"), text);
        assertTrue(text.contains("mvn test"), text);
        assertTrue(text.contains("BUILD FAILURE"), text);
    }

    @Test
    public void renderMarksTimeoutAndTerminated() {
        String timedOut = new BackgroundNoticeCenter.Notice(
                "cmd_t", "sleep 999", null, true, false, 1L, "").render();
        assertTrue(timedOut.contains("status=timeout"), timedOut);
        assertTrue(timedOut.contains("exit_code=unknown"), timedOut);

        String killed = new BackgroundNoticeCenter.Notice(
                "cmd_k", "sleep 999", null, false, true, 1L, "").render();
        assertTrue(killed.contains("status=terminated"), killed);
    }

    @Test
    public void noticeAccessorsRoundTrip() {
        BackgroundNoticeCenter.Notice n = notice("cmd_r");
        assertEquals("cmd_r", n.sessionId());
        assertEquals("echo hi", n.command());
        assertEquals(Integer.valueOf(0), n.exitCode());
        assertEquals(1234L, n.wallTimeMs());
        assertEquals("hi", n.tailOutput());
        assertFalse(n.timedOut());
        assertFalse(n.terminated());
    }
}
