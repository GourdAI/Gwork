package com.gourdai.harness.talents.cli;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.FileTime;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

/**
 * bash 工具输出存储与后台启动语义的契约测试。
 *
 * <p>锁定四个刚修复、且极易在后续重构中被悄悄改回去的行为：</p>
 * <ul>
 *   <li><b>顺序补读</b>：单次读取超限时返回「未消费区间的头部」，游标只推进已返回部分——
 *       旧实现返回尾部却把游标一把推到末尾，中间增量被永久丢弃且模型毫不知情；</li>
 *   <li><b>溢出落盘</b>：超过阈值后正文继续完整保存在溢出文件里，逐段读取一个字符都不能少
 *       （这是「治理内存」与「截断丢数据」的分水岭）；</li>
 *   <li><b>后台启动状态如实</b>：让步窗口内就已失败的任务必须报 completed + exit_code，
 *       不能一律写死 running 让模型去等一条没有意义的完成通知；</li>
 *   <li><b>临时文件补扫的年龄阈值</b>：只清明显残留，绝不误删同机另一实例正在用的脚本。</li>
 * </ul>
 */
public class TerminalOutputStorageTest {

    /** 读取「未消费增量」时，超限提示语的固定前缀（与 CommandSession.snapshot 保持一致） */
    private static final String MORE_MARK = "\n... [还有 ";

    // ===================== 工具：不依赖真实子进程的会话 =====================

    /**
     * 最小可用的假进程：本测试只验证输出存储与快照逻辑，不需要真的 fork。
     *
     * <p>用真实命令产出 16M+ 字符既慢又受宿主 shell 影响，且无法稳定制造「跨溢出边界」的读取。</p>
     */
    private static final class FakeProcess extends Process {
        private final ByteArrayOutputStream stdin = new ByteArrayOutputStream();

        @Override
        public OutputStream getOutputStream() {
            return stdin;
        }

        @Override
        public InputStream getInputStream() {
            return new ByteArrayInputStream(new byte[0]);
        }

        @Override
        public InputStream getErrorStream() {
            return new ByteArrayInputStream(new byte[0]);
        }

        @Override
        public int waitFor() {
            return 0;
        }

        @Override
        public boolean waitFor(long timeout, TimeUnit unit) {
            return true;
        }

        @Override
        public int exitValue() {
            return 0;
        }

        @Override
        public void destroy() {
        }

        @Override
        public boolean isAlive() {
            return false;
        }
    }

    /** 直接构造会话对象（不调用 start()：不起线程、不登记全局存活表，测试自行喂数据） */
    private static TerminalSessionManager.CommandSession newSession() {
        return new TerminalSessionManager.CommandSession(
                "cmd_test_storage",
                "fake",
                Paths.get(".").toAbsolutePath().normalize(),
                new FakeProcess(),
                System.currentTimeMillis(),
                60_000,
                StandardCharsets.UTF_8,
                StandardCharsets.UTF_8,
                null,
                null);
    }

    private static void append(TerminalSessionManager.CommandSession session, String text)
            throws Exception {
        Method m = TerminalSessionManager.CommandSession.class
                .getDeclaredMethod("appendLocked", String.class);
        m.setAccessible(true);
        m.invoke(session, text);
    }

    /** 去掉「还有 N 字符未读取」提示，只留正文 */
    private static String body(String output) {
        int idx = output.indexOf(MORE_MARK);
        return idx < 0 ? output : output.substring(0, idx);
    }

    private static int intField(String name) throws Exception {
        Field f = TerminalSessionManager.class.getDeclaredField(name);
        f.setAccessible(true);
        return f.getInt(null);
    }

    // ===================== 顺序补读（纯内存） =====================

    @Test
    public void incrementalReadReturnsHeadAndNeverLosesMiddle() throws Exception {
        TerminalSessionManager.CommandSession session = newSession();
        try {
            append(session, "0123456789");

            TerminalSessionManager.CommandSnapshot first = session.snapshot(4);
            assertEquals("0123", body(first.output()),
                    "超限时必须返回未消费区间的【头部】，而不是整体尾部");
            assertTrue(first.outputTruncated(), "仍有未读内容时应标记 truncated");
            assertTrue(first.output().contains(MORE_MARK.trim()),
                    "必须告知模型剩余可继续读取，实际: [" + first.output() + "]");

            // 关键回归点：第二次读取必须接着上次的位置，中间那段不能被跳过
            assertEquals("4567", body(session.snapshot(4).output()));

            TerminalSessionManager.CommandSnapshot last = session.snapshot(4);
            assertEquals("89", last.output(), "收尾读取不应再附加提示语");
            assertFalse(last.outputTruncated());

            // 读空之后再读为空，且不重复返回历史内容
            assertEquals("", session.snapshot(4).output());
        } finally {
            session.discard();
        }
    }

    @Test
    public void tailSnapshotDoesNotConsumeCursor() throws Exception {
        TerminalSessionManager.CommandSession session = newSession();
        try {
            append(session, "abcdefghij");

            assertEquals("hij", session.snapshotTail(3).output(), "尾部快照应取末尾若干字符");
            // 完成通知用的是非消费性快照：游标不能被它推进，否则「收到通知后再查就没了」
            assertEquals("abcd", body(session.snapshot(4).output()));
        } finally {
            session.discard();
        }
    }

    // ===================== 溢出落盘 =====================

    @Test
    public void spilledOutputStaysFullyReadable() throws Exception {
        int threshold = intField("SPILL_THRESHOLD_CHARS");
        int window = intField("SPILL_WINDOW_CHARS");
        assertTrue(window < threshold, "内存窗口必须小于落盘阈值，否则落盘永远不会发生");

        int chunk = 1_000_000;
        int chunks = threshold / chunk + 1; // 必定越过阈值，触发落盘
        long expectedTotal = (long) chunk * chunks;

        TerminalSessionManager.CommandSession session = newSession();
        try {
            for (int i = 0; i < chunks; i++) {
                char c = (char) ('a' + (i % 26));
                StringBuilder sb = new StringBuilder(chunk);
                for (int k = 0; k < chunk; k++) {
                    sb.append(c);
                }
                append(session, sb.toString());
            }

            Field spillField =
                    TerminalSessionManager.CommandSession.class.getDeclaredField("spill");
            spillField.setAccessible(true);
            assertTrue(spillField.get(session) != null,
                    "累计输出已越过阈值，应转入溢出落盘模式（否则内存里会常驻整份输出）");

            // 逐段读回全部内容：一个字符都不能少，且顺序不能乱
            long read = 0;
            int guard = 0;
            while (read < expectedTotal) {
                String text = body(session.snapshot(2_000_000).output());
                assertFalse(text.isEmpty(), "尚未读完却返回空：溢出区间丢失了内容");
                for (int i = 0; i < text.length(); i++) {
                    long abs = read + i;
                    char expected = (char) ('a' + (int) (abs / chunk) % 26);
                    if (text.charAt(i) != expected) {
                        throw new AssertionError("偏移 " + abs + " 期望 " + expected
                                + " 实际 " + text.charAt(i) + "（溢出文件读回错位）");
                    }
                }
                read += text.length();
                if (++guard > 100) {
                    throw new AssertionError("读取未收敛，疑似游标没有推进");
                }
            }
            assertEquals(expectedTotal, read, "落盘模式下读回的总字符数必须与产生量一致");
            assertEquals("", session.snapshot(1_000).output(), "读完后应返回空");
        } finally {
            session.discard();
        }
    }

    // ===================== 后台启动响应 =====================

    private static TerminalSessionManager.CommandSnapshot snapshotOf(
            boolean running, Integer exitCode, String output) {
        return new TerminalSessionManager.CommandSnapshot(
                "cmd_abc", "notexistcmd", Paths.get(".").toAbsolutePath().normalize(),
                running, exitCode, false, false, null, 12L,
                output.length(), output.length(), false, output);
    }

    private static String formatStart(
            TerminalSessionManager.CommandSnapshot snapshot, boolean noticeEnabled)
            throws Exception {
        TerminalTalent talent = new TerminalTalent(null, ShellCommandFactory.detect());
        Method m = TerminalTalent.class.getDeclaredMethod(
                "formatBackgroundStart",
                TerminalSessionManager.CommandSnapshot.class,
                boolean.class);
        m.setAccessible(true);
        return (String) m.invoke(talent, snapshot, Boolean.valueOf(noticeEnabled));
    }

    @Test
    public void backgroundStartReportsImmediateFailureInsteadOfFakeRunning() throws Exception {
        String text = formatStart(
                snapshotOf(false, Integer.valueOf(1), "xxx : 无法识别"), true);

        assertTrue(text.contains("status: completed"),
                "启动即失败却报 running，模型会去等一条毫无价值的完成通知。实际: " + text);
        assertFalse(text.contains("status: running"));
        assertTrue(text.contains("exit_code: 1"), "已结束就必须给出退出码，实际: " + text);
        assertFalse(text.contains("任务完成时你会自动收到"),
                "任务已经结束，不得再承诺后续通知");
        assertTrue(text.contains("xxx : 无法识别"), "失败输出必须当场带回");
    }

    @Test
    public void backgroundStartKeepsRunningContractForLiveTask() throws Exception {
        String text = formatStart(snapshotOf(true, null, "booting"), true);

        assertTrue(text.contains("status: running"));
        assertFalse(text.contains("exit_code:"), "仍在运行时不应伪造退出码");
        assertTrue(text.contains("任务完成时你会自动收到"),
                "通知可用时必须告知模型无需轮询");

        // 通知不可用时绝不能承诺通知（否则模型停止查询、死等）
        String noNotice = formatStart(snapshotOf(true, null, ""), false);
        assertFalse(noNotice.contains("任务完成时你会自动收到"));
        assertTrue(noNotice.contains("bash_output"));
    }

    @Test
    public void backgroundStartYieldIsShortButNonZero() throws Exception {
        Field f = TerminalTalent.class.getDeclaredField("BACKGROUND_START_YIELD_MS");
        f.setAccessible(true);
        int yield = f.getInt(null);
        assertTrue(yield > 0, "让步窗口为 0 时，启动即失败的任务永远会被报成 running");
        assertTrue(yield <= 2_000, "后台模式的语义是不阻塞，让步窗口不能取大：" + yield);
    }

    // ===================== 临时文件补扫 =====================

    @Test
    public void tempSweepRemovesStaleButKeepsFresh() throws Exception {
        Path tmp = Paths.get(System.getProperty("java.io.tmpdir"));
        Path stale = Files.createTempFile(tmp, "gwork-script-", ".sweep-test");
        Path fresh = Files.createTempFile(tmp, "gwork-script-", ".sweep-test");
        try {
            // 把一个文件的修改时间推到 48 小时前：属于「明显残留」
            Files.setLastModifiedTime(stale,
                    FileTime.fromMillis(System.currentTimeMillis() - 48L * 60 * 60 * 1000));

            ProcessExecutor.sweepStaleTempFiles();

            assertFalse(Files.exists(stale), "超过年龄阈值的残留脚本应被清理");
            assertTrue(Files.exists(fresh),
                    "刚创建的脚本可能正被同机另一实例使用，绝不能误删");
        } finally {
            Files.deleteIfExists(stale);
            Files.deleteIfExists(fresh);
        }
    }
}
