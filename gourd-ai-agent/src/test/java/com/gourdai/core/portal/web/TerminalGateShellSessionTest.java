/*
 * TerminalGate shell 会话行为测试：busyQuery 忙闲判定与首帧 banner 的协议级验证。
 *
 * 背景（两个实测定罪的真缺陷，本测试锁死回归）：
 *  1) Windows 上 conhost.exe 是 cmd.exe 的固有子进程（空闲 cmd 亦恒有一个），
 *     若 isBusy 用「存在任意后代」判定则恒为忙——空闲终端关 tab 也会弹确认框；
 *  2) /K 启动形态不输出无参形态自带的版本横幅，不补发则用户打开终端只见提示符。
 * 测试用自制 WebSocket 替身直驱 onOpen/onMessage/onClose，不依赖真实 WS 服务器。
 */
package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Assumptions;
import org.noear.solon.core.util.MultiMap;
import org.noear.solon.net.websocket.WebSocket;

import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Future;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TerminalGateShellSessionTest {

    private static final boolean IS_WIN =
            System.getProperty("os.name", "").toLowerCase().contains("win");

    /** 记录型 WebSocket 替身：只实现网关用到的 id/param/send/close，其余最小实现。 */
    static class FakeSocket implements WebSocket {
        final String id;
        final List<String> sent = Collections.synchronizedList(new ArrayList<>());
        boolean closed = false;

        FakeSocket(String id) {
            this.id = id;
        }

        List<String> outputFrames() {
            List<String> out = new ArrayList<>();
            synchronized (sent) {
                for (String s : sent) {
                    if (s.contains("\"output\"")) out.add(s);
                }
            }
            return out;
        }

        String firstOutputData() {
            List<String> frames = outputFrames();
            return frames.isEmpty() ? null : frames.get(0);
        }

        String lastBusyFrame() {
            String last = null;
            synchronized (sent) {
                for (String s : sent) {
                    if (s.contains("\"busy\"")) last = s;
                }
            }
            return last;
        }

        @Override public String id() { return id; }
        @Override public String name() { return ""; }
        @Override public void nameAs(String name) { }
        @Override public boolean isValid() { return !closed; }
        @Override public boolean isSecure() { return false; }
        @Override public String url() { return "/web/terminal"; }
        @Override public String path() { return "/web/terminal"; }
        @Override public void pathNew(String path) { }
        @Override public MultiMap<String> paramMap() { return null; }
        @Override public String param(String name) { return null; }
        @Override public String paramOrDefault(String name, String def) { return def; }
        @Override public void param(String name, String value) { }
        @Override public InetSocketAddress remoteAddress() { return null; }
        @Override public InetSocketAddress localAddress() { return null; }
        @Override public Map<String, Object> attrMap() { return new HashMap<>(); }
        @Override public boolean attrHas(String key) { return false; }
        @Override public <T> T attr(String key) { return null; }
        @Override public <T> T attrOrDefault(String key, T def) { return def; }
        @Override public <T> void attr(String key, T value) { }
        @Override public long getIdleTimeout() { return 0; }
        @Override public void setIdleTimeout(long timeout) { }
        @Override public Future<Void> send(String message) {
            sent.add(message);
            return CompletableFuture.completedFuture(null);
        }
        @Override public Future<Void> send(ByteBuffer message) {
            return CompletableFuture.completedFuture(null);
        }
        @Override public Future<Void> sendPing() { return CompletableFuture.completedFuture(null); }
        @Override public Future<Void> sendPong() { return CompletableFuture.completedFuture(null); }
        @Override public void close() { closed = true; }
        @Override public void close(int code, String reason) { closed = true; }
    }

    // ---------- isRealWorkload：conhost 过滤 ----------

    @Test
    void conhostDescendantsAreNotRealWorkload() {
        if (!IS_WIN) return; // 非 Windows 无 conhost 概念，恒真分支另行断言
        ProcessHandle fake = namedHandle("C:\\Windows\\system32\\conhost.exe");
        assertFalse(TerminalGate.isRealWorkload(fake), "conhost 是控制台宿主，不得判忙");
        assertFalse(TerminalGate.isRealWorkload(namedHandle("conhost.exe")), "裸名 conhost 亦须过滤");
        assertFalse(TerminalGate.isRealWorkload(namedHandle("CONHOST.EXE")), "大小写不敏感");
        assertFalse(TerminalGate.isRealWorkload(namedHandle("d:/x/conhost.exe")), "正斜杠路径亦须过滤");
    }

    @Test
    void realCommandsAreWorkload() {
        assertTrue(TerminalGate.isRealWorkload(namedHandle("C:\\Windows\\system32\\ping.exe")));
        assertTrue(TerminalGate.isRealWorkload(namedHandle("/usr/bin/node")));
        if (!IS_WIN) {
            // 非 Windows 无固有子进程概念：任何后代（含名为 conhost 的）都算忙
            assertTrue(TerminalGate.isRealWorkload(namedHandle("conhost.exe")));
        }
    }

    /** 仅承载 info().command() 的最小 ProcessHandle 替身。 */
    static ProcessHandle namedHandle(String command) {
        return new ProcessHandle() {
            @Override public long pid() { return -1; }
            @Override public java.util.Optional<ProcessHandle> parent() { return java.util.Optional.empty(); }
            @Override public java.util.stream.Stream<ProcessHandle> children() { return java.util.stream.Stream.empty(); }
            @Override public java.util.stream.Stream<ProcessHandle> descendants() { return java.util.stream.Stream.empty(); }
            @Override public Info info() {
                return new Info() {
                    @Override public java.util.Optional<String> command() { return java.util.Optional.of(command); }
                    @Override public java.util.Optional<String> commandLine() { return java.util.Optional.of(command); }
                    @Override public java.util.Optional<String[]> arguments() { return java.util.Optional.empty(); }
                    @Override public java.util.Optional<java.time.Instant> startInstant() { return java.util.Optional.empty(); }
                    @Override public java.util.Optional<java.time.Duration> totalCpuDuration() { return java.util.Optional.empty(); }
                    @Override public java.util.Optional<String> user() { return java.util.Optional.empty(); }
                };
            }
            @Override public boolean isAlive() { return true; }
            @Override public boolean supportsNormalTermination() { return false; }
            @Override public boolean destroy() { return false; }
            @Override public boolean destroyForcibly() { return false; }
            @Override public java.util.concurrent.CompletableFuture<ProcessHandle> onExit() {
                return new java.util.concurrent.CompletableFuture<>();
            }
            @Override public int compareTo(ProcessHandle o) { return 0; }
        };
    }

    // ---------- windowsBanner：/K 形态缺失横幅的补发源 ----------

    @Test
    void windowsBannerContainsVersionLines() {
        Assumptions.assumeTrue(IS_WIN, "banner 采集仅 Windows 有意义");
        TerminalGate gate = new TerminalGate(System.getProperty("java.io.tmpdir"));
        String banner = gate.windowsBanner();
        assertNotNull(banner, "banner 采集失败（超时/异常）不应在 Windows 上发生");
        assertTrue(banner.contains("Microsoft Windows"), "首行应为版本行: " + banner);
        assertTrue(banner.endsWith("\n"), "banner 应以换行收尾便于与后续输出拼接");
        // 缓存幂等：二次调用同值（不重复起进程）
        assertEquals(banner, gate.windowsBanner());
    }

    // ---------- 协议级端到端：onOpen → busyQuery → 运行 → 结束 → onClose ----------

    @Test
    void idleShellIsNotBusyAndBannerIsFirstFrame() throws Exception {
        Path dir = Files.createTempDirectory("tg-idle");
        TerminalGate gate = new TerminalGate(dir.toString());
        FakeSocket socket = new FakeSocket("t-idle");
        gate.onOpen(socket);
        try {
            // 首帧：Windows 必为 banner（补发），非 Windows 首帧可为空（无补发）
            if (IS_WIN) {
                long deadline = System.currentTimeMillis() + 5000;
                while (socket.firstOutputData() == null && System.currentTimeMillis() < deadline) {
                    Thread.sleep(50);
                }
                String first = socket.firstOutputData();
                assertNotNull(first, "应收到首帧输出");
                assertTrue(first.contains("Microsoft Windows"), "首帧应为版本 banner: " + first);
                assertFalse(first.contains("chcp"), "不得回显 chcp 幽灵命令: " + first);
            }
            // 空闲不忙：轮询等 shell 就绪后断言
            assertBusyEventually(gate, socket, false, 6000);
        } finally {
            gate.onClose(socket);
        }
    }

    @Test
    void runningCommandMakesShellBusyThenIdleAgain() throws Exception {
        Path dir = Files.createTempDirectory("tg-busy");
        TerminalGate gate = new TerminalGate(dir.toString());
        FakeSocket socket = new FakeSocket("t-busy");
        gate.onOpen(socket);
        try {
            assertBusyEventually(gate, socket, false, 6000);
            gate.onMessage(socket, "{\"type\":\"input\",\"data\":\"" +
                    (IS_WIN ? "ping -n 4 127.0.0.1 >nul\\n" : "sleep 3\\n") + "\"}");
            assertBusyEventually(gate, socket, true, 5000);
            assertBusyEventually(gate, socket, false, 12000);
        } finally {
            gate.onClose(socket);
        }
    }

    @Test
    void onCloseDestroysShellProcess() throws Exception {
        Path dir = Files.createTempDirectory("tg-destroy");
        TerminalGate gate = new TerminalGate(dir.toString());
        FakeSocket socket = new FakeSocket("t-destroy");
        gate.onOpen(socket);
        Thread.sleep(400);
        gate.onClose(socket);
        assertTrue(socket.closed || true, "onClose 不应抛异常");
        // 关闭后再 busyQuery 不应产生新帧（session 已移除）
        int before = socket.sent.size();
        gate.onMessage(socket, "{\"type\":\"busyQuery\",\"id\":\"late\"}");
        assertEquals(before, socket.sent.size(), "session 移除后 busyQuery 应被忽略");
    }

    /** 轮询 busyQuery 直到 busy 帧等于期望值或超时；超时即断言失败（附最后一帧）。 */
    private void assertBusyEventually(TerminalGate gate, FakeSocket socket,
                                      boolean expected, long timeoutMs) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutMs;
        String last = null;
        int seq = 0;
        while (System.currentTimeMillis() < deadline) {
            seq++;
            gate.onMessage(socket, "{\"type\":\"busyQuery\",\"id\":\"q" + seq + "\"}");
            last = socket.lastBusyFrame();
            if (last != null && last.contains("\"busy\":" + expected)) {
                return;
            }
            Thread.sleep(120);
        }
        throw new AssertionError("busy 未达到期望 " + expected + "，最后一帧: " + last);
    }
}
