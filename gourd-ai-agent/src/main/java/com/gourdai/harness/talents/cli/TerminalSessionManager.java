package com.gourdai.harness.talents.cli;

import java.io.BufferedReader;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class TerminalSessionManager {

    public static final int DEFAULT_YIELD_TIME_MS = 1_000;
    public static final int DEFAULT_HARD_TIMEOUT_MS = 120_000;
    public static final int DEFAULT_MAX_OUTPUT_CHARS = 64_000;

    private static final Logger LOG = LoggerFactory.getLogger(TerminalSessionManager.class);
    private static final long DESTROY_GRACE_MS = 250L;
    /** 完成通知里携带的尾部输出上限：通知会随历史被每轮重发，必须克制 */
    private static final int NOTICE_TAIL_CHARS = 2_000;
    private static final long COMPLETED_SESSION_TTL_MS = Duration.ofMinutes(10).toMillis();

    /**
     * 内存窗口超过该字符数后转入「溢出落盘」模式（约 32MB：Java char 为 2 字节）。
     *
     * <p><b>为什么不是「截断」</b>：后台会话的输出是模型要逐段真正消费的正文（用 bash 打印大文件、
     * 长构建日志都是正当场景），任何丢弃型保护都会让 {@code bash_output} 读不全。因此这里只改变
     * 「存放位置」而不改变「能读到多少」——超阈值后文本继续完整追加到临时文件，内存仅保留末尾窗口。</p>
     */
    private static final int SPILL_THRESHOLD_CHARS = 16_000_000;

    /**
     * 落盘模式下内存保留的尾部窗口字符数（约 2MB）。窗口之外的内容全部从溢出文件按偏移读回，
     * 因此「能读到多少」不受窗口大小影响，窗口只决定常驻内存的多少。
     *
     * <p>必须明显大于 {@link #NOTICE_TAIL_CHARS}：完成通知取的尾部要能直接命中内存窗口。</p>
     */
    private static final int SPILL_WINDOW_CHARS = 1_000_000;

    /**
     * 纯内存模式下触发「回收已消费前缀」的最小字符数：低于它不动手，避免每读一个 4KB 分块就
     * 做一次 StringBuilder 数组搬移。
     */
    private static final int RECLAIM_MIN_CHARS = 64_000;

    /**
     * 同时存活的后台会话上限。没有闸门时模型可以无限起后台任务，每个都带读取/等待两条线程
     * 与一棵进程树，足以拖垮宿主。
     */
    private static final int MAX_LIVE_SESSIONS = 16;

    private static final ScheduledExecutorService TIMEOUT_EXECUTOR =
            Executors.newSingleThreadScheduledExecutor(
                    runnable -> {
                        Thread thread = new Thread(runnable, "gwork-command-timeout");
                        thread.setDaemon(true);
                        return thread;
                    });

    /**
     * 执行「杀进程树」的线程池。
     *
     * <p>{@link #destroyProcessTree(Process)} 会 fork {@code taskkill}/{@code kill} 并同步等待，
     * 最长阻塞约 2 秒。若直接跑在单线程的 {@link #TIMEOUT_EXECUTOR} 上，多个后台任务同时到点
     * 就会串行排队——后面的任务迟迟得不到终止。定时器只负责派发，真正的杀动作在这里并行执行。</p>
     */
    private static final ExecutorService KILL_EXECUTOR =
            Executors.newCachedThreadPool(
                    runnable -> {
                        Thread thread = new Thread(runnable, "gwork-command-kill");
                        thread.setDaemon(true);
                        return thread;
                    });

    /**
     * 全局存活会话登记（跨 manager 实例）：供 JVM 退出钩子整树清理。
     *
     * <p>读取/等待/定时三类线程全是 daemon，JVM 退出时它们直接消失，而<b>子进程树不会</b>——
     * 本类各处反复强调「只杀根会让 node/vite 孤儿化继续占端口」，却独独漏了「JVM 自己退出」
     * 这条路径：桌面端重启后端时，上一轮的后台任务会全部孤儿化残留。</p>
     */
    private static final ConcurrentMap<CommandSession, Boolean> LIVE_SESSIONS = new ConcurrentHashMap<>();

    static {
        try {
            Thread hook = new Thread(TerminalSessionManager::shutdownAllSessions, "gwork-command-shutdown");
            Runtime.getRuntime().addShutdownHook(hook);
        } catch (Throwable ignored) {
            // 已在关停中/安全策略禁止注册：退化为原行为（不做退出清理），绝不影响正常执行
        }
    }

    /**
     * JVM 退出时整树终止全部登记在册的后台任务，并删除其溢出文件。
     *
     * <p>钩子线程里不做任何长等待之外的额外动作，且逐个 try/catch：一个会话清理失败不得
     * 妨碍其余会话，否则会退化成「第一个卡住 → 其余全部孤儿化」。</p>
     */
    static void shutdownAllSessions() {
        for (CommandSession session : LIVE_SESSIONS.keySet()) {
            try {
                session.terminate("jvm_shutdown");
            } catch (Throwable ignored) {
            }
            try {
                session.discard();
            } catch (Throwable ignored) {
            }
        }
        LIVE_SESSIONS.clear();
    }

    /** 关闭资源并吞掉异常（清理路径上的失败不得影响命令生命周期）。 */
    private static void closeQuietly(Closeable closeable) {
        if (closeable == null) {
            return;
        }
        try {
            closeable.close();
        } catch (Throwable ignored) {
        }
    }

    private final ConcurrentMap<String, CommandSession> sessions = new ConcurrentHashMap<>();
    private final Charset outputCharset;
    private final Charset stdinCharset;
    private final ShellCommandFactory shellCommandFactory;

    public TerminalSessionManager() {
        this(ShellCommandFactory.detect(), StandardCharsets.UTF_8);
    }

    public TerminalSessionManager(ShellCommandFactory shellCommandFactory) {
        this(shellCommandFactory, StandardCharsets.UTF_8);
    }

    public TerminalSessionManager(Charset outputCharset) {
        this(ShellCommandFactory.detect(), outputCharset);
    }

    public TerminalSessionManager(ShellCommandFactory shellCommandFactory, Charset outputCharset) {
        this.shellCommandFactory =
                shellCommandFactory == null ? ShellCommandFactory.detect() : shellCommandFactory;
        this.outputCharset = outputCharset == null ? StandardCharsets.UTF_8 : outputCharset;
        this.stdinCharset = resolveStdinCharset(this.shellCommandFactory, this.outputCharset);
    }

    /**
     * 会话 stdin 的写入编码。
     *
     * <p>PowerShell 方案由 {@code ShellCommandFactory.POWERSHELL_PREAMBLE} 把
     * {@code [Console]::InputEncoding} 归一到 UTF-8，可以直接写 UTF-8 字节；而 <b>CMD 方言没有
     * 可靠的注入点</b>（{@code chcp} 改的是共享控制台代码页，会污染宿主输出），它按系统 ANSI
     * 代码页读 stdin。原先一律硬编码 UTF-8，在 CMD 下向交互命令写中文必然乱码。</p>
     */
    static Charset resolveStdinCharset(ShellCommandFactory factory, Charset fallback) {
        if (factory != null && factory.getShellMode() == ShellMode.CMD) {
            Charset ansi = OutputDecoder.ansiCharset(null);
            if (ansi != null) {
                return ansi;
            }
        }
        return fallback == null ? StandardCharsets.UTF_8 : fallback;
    }

    public CommandSnapshot exec(
            String command,
            Path workdir,
            Map<String, String> env,
            Integer yieldTimeMs,
            Integer maxOutputChars,
            Integer hardTimeoutMs)
            throws IOException {
        return exec(command, workdir, env, yieldTimeMs, maxOutputChars, hardTimeoutMs, null);
    }

    /**
     * 执行命令，并在会话结束时回调通知。
     *
     * @param onComplete 进程结束（正常退出 / 硬超时 / 被终止）后的回调；可为 null。
     *                   回调在命令等待线程上执行，实现方必须自行吞掉异常且不得阻塞。
     */
    public CommandSnapshot exec(
            String command,
            Path workdir,
            Map<String, String> env,
            Integer yieldTimeMs,
            Integer maxOutputChars,
            Integer hardTimeoutMs,
            Consumer<CommandSnapshot> onComplete)
            throws IOException {
        cleanupCompletedSessions();
        requireLiveSessionQuota();
        requireNonEmptyCommand(command);
        Path normalizedWorkdir = normalizeWorkdir(workdir);

        ShellCommandFactory.PreparedCommand prepared = null;
        try {
            // Windows：改用 ShellCommandFactory 的可靠启动方案（PowerShell 用 -EncodedCommand；
            // CMD 默认 /d /c 直连、仅多行/非 ANSI/超长命令才落 .bat），规避命令文本代码页转换问题；
            // 若产生临时脚本，由会话结束回调清理（异步会话下进程可能在本方法返回后仍在运行，不能提前删除）。
    // interactive=true：会话支持 stdin 写入，不能加 -NonInteractive，否则等待输入的命令会直接失败
            if (shellCommandFactory.isWindowsShell()) {
                prepared = shellCommandFactory.prepare(command, true);
            }
            List<String> argv = prepared != null ? prepared.argv() : shellCommandFactory.build(command);
            ProcessBuilder builder = new ProcessBuilder(argv);
            builder.directory(normalizedWorkdir.toFile());
            builder.redirectErrorStream(true);
            // 注入实时系统 PATH（Windows：修复 JVM 环境快照不刷新导致新装命令不可见）；
            // 显式 env（如 PYTHON/NODE）优先级更高
            EnvironmentResolver.applyTo(builder, env);

            Process process = builder.start();
            String sessionId = newSessionId();
            Runnable cleanup = prepared != null ? prepared::cleanup : null;
            CommandSession session =
                    new CommandSession(
                            sessionId,
                            command,
                            normalizedWorkdir,
                            process,
                            System.currentTimeMillis(),
                            normalizeHardTimeoutMs(hardTimeoutMs),
                            outputCharset,
                            stdinCharset,
                            cleanup,
                            onComplete);
            sessions.put(sessionId, session);
            session.start();
            return waitAndSnapshot(session, yieldTimeMs, maxOutputChars);
        } catch (IOException e) {
            if (prepared != null) {
                prepared.cleanup();
            }
            throw e;
        }
    }

    public CommandSnapshot writeStdin(
            String sessionId, String chars, Integer yieldTimeMs, Integer maxOutputChars)
            throws IOException {
        cleanupCompletedSessions();
        CommandSession session = requireSession(sessionId);
        session.write(chars);
        return waitAndSnapshot(session, yieldTimeMs, maxOutputChars);
    }

    public CommandSnapshot terminate(String sessionId, String reason, Integer maxOutputChars) {
        cleanupCompletedSessions();
        CommandSession session = requireSession(sessionId);
        session.terminate(reason);
        return waitAndSnapshot(session, 2_000, maxOutputChars);
    }

    CommandSession getSessionForTest(String sessionId) {
        return sessions.get(sessionId);
    }

    private CommandSnapshot waitAndSnapshot(
            CommandSession session, Integer yieldTimeMs, Integer maxOutputChars) {
        int waitMs = normalizeYieldTimeMs(yieldTimeMs);
        try {
            session.exitFuture().get(waitMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException ignored) {
        } catch (Exception e) {
            LOG.debug("Command session wait failed: {}", e.getMessage());
        }
        session.enforceHardTimeout();
        session.awaitReaderIfCompleted(200);
        return session.snapshot(normalizeMaxOutputChars(maxOutputChars));
    }

    private CommandSession requireSession(String sessionId) {
        if (sessionId == null || sessionId.trim().isEmpty()) {
            throw new IllegalArgumentException("session_id is required");
        }
        CommandSession session = sessions.get(sessionId.trim());
        if (session == null) {
            throw new IllegalArgumentException("Unknown command session: " + sessionId);
        }
        return session;
    }

    private void cleanupCompletedSessions() {
        long now = System.currentTimeMillis();
        Iterator<Map.Entry<String, CommandSession>> it = sessions.entrySet().iterator();
        while (it.hasNext()) {
            CommandSession session = it.next().getValue();
            if (session.completedAt() > 0 && now - session.completedAt() > COMPLETED_SESSION_TTL_MS) {
                it.remove();
                // 必须同步释放溢出文件：只从 map 里移除会把临时文件留到 JVM 退出
                session.discard();
            }
        }
    }

    /**
     * 存活会话闸门。
     *
     * <p>没有上限时模型可以无限起后台任务，每个都带着读取/等待两条线程与一棵进程树。
     * 抛 {@link IOException} 而非运行时异常：调用方（{@code TerminalTalent.bash}）已对它做了
     * 收口，模型会拿到一句可读的失败说明而不是裸异常。</p>
     */
    private void requireLiveSessionQuota() throws IOException {
        int live = 0;
        for (CommandSession session : sessions.values()) {
            if (session.isRunning()) {
                live++;
            }
        }
        if (live >= MAX_LIVE_SESSIONS) {
            throw new IOException(
                    "同时运行的后台任务已达上限 " + MAX_LIVE_SESSIONS
                            + "：请先用 bash_output(action=kill) 终止不再需要的任务，或等已有任务跑完。");
        }
    }

    private static void requireNonEmptyCommand(String command) {
        if (command == null || command.trim().isEmpty()) {
            throw new IllegalArgumentException("command is required");
        }
    }

    private static Path normalizeWorkdir(Path workdir) throws IOException {
        if (workdir == null) {
            throw new IllegalArgumentException("workdir is required");
        }
        Path normalized = workdir.toAbsolutePath().normalize();
        if (!Files.exists(normalized)) {
            throw new IOException("workdir does not exist: " + normalized);
        }
        if (!Files.isDirectory(normalized)) {
            throw new IOException("workdir is not a directory: " + normalized);
        }
        return normalized;
    }

    private static int normalizeYieldTimeMs(Integer yieldTimeMs) {
        if (yieldTimeMs == null) {
            return DEFAULT_YIELD_TIME_MS;
        }
        return Math.max(0, yieldTimeMs);
    }

    private static int normalizeHardTimeoutMs(Integer hardTimeoutMs) {
        if (hardTimeoutMs == null || hardTimeoutMs <= 0) {
            return DEFAULT_HARD_TIMEOUT_MS;
        }
        return hardTimeoutMs;
    }

    private static int normalizeMaxOutputChars(Integer maxOutputChars) {
        if (maxOutputChars == null || maxOutputChars <= 0) {
            return DEFAULT_MAX_OUTPUT_CHARS;
        }
        return maxOutputChars;
    }

    private static String newSessionId() {
        return "cmd_" + UUID.randomUUID().toString().replace("-", "").substring(0, 16);
    }

    static void destroyProcessTree(Process process) {
        if (process == null) {
            return;
        }
        Long pid = processPid(process);
        if (pid != null) {
            if (isWindows()) {
                // Windows：taskkill /T 依赖"活着的树根 PID"才能向下清理子树。
                // 必须在树根存活时先整树强杀，再销毁根进程；否则根进程先死，
                // 子进程将孤儿化残留（如 node/vite 继续监听端口），且无法再按根定位。
                destroyProcessTreeByPid(pid.longValue(), true);
                waitForProcess(process, DESTROY_GRACE_MS);
            } else {
                destroyProcessTreeByPid(pid.longValue(), false);
            }
        }
        process.destroy();
        waitForProcess(process, DESTROY_GRACE_MS);
        if (pid != null && isWindows() == false) {
            destroyProcessTreeByPid(pid.longValue(), true);
        }
        if (process.isAlive()) {
            process.destroyForcibly();
        }
        waitForProcess(process, DESTROY_GRACE_MS);
    }

    private static Long processPid(Process process) {
        try {
            Method pidMethod = Process.class.getMethod("pid");
            Object value = pidMethod.invoke(process);
            if (value instanceof Number) {
                return Long.valueOf(((Number) value).longValue());
            }
        } catch (Throwable ignored) {
        }
        try {
            Field pidField = process.getClass().getDeclaredField("pid");
            pidField.setAccessible(true);
            Object value = pidField.get(process);
            if (value instanceof Number) {
                return Long.valueOf(((Number) value).longValue());
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    private static void destroyProcessTreeByPid(long rootPid, boolean forcibly) {
        if (isWindows()) {
            destroyWindowsProcessTree(rootPid, forcibly);
            return;
        }
        List<Long> pids = collectUnixProcessTree(rootPid);
        Collections.reverse(pids);
        String signal = forcibly ? "-KILL" : "-TERM";
        for (Long pid : pids) {
            runQuietly(Arrays.asList("kill", signal, String.valueOf(pid)));
        }
    }

    private static void destroyWindowsProcessTree(long rootPid, boolean forcibly) {
        List<String> command = new ArrayList<>();
        command.add("taskkill");
        command.add("/T");
        if (forcibly) {
            command.add("/F");
        }
        command.add("/PID");
        command.add(String.valueOf(rootPid));
        runQuietly(command);
    }

    private static List<Long> collectUnixProcessTree(long rootPid) {
        List<Long> pids = new ArrayList<>();
        collectUnixProcessTree(rootPid, pids);
        return pids;
    }

    private static void collectUnixProcessTree(long pid, List<Long> pids) {
        pids.add(Long.valueOf(pid));
        for (Long childPid : listUnixChildPids(pid)) {
            collectUnixProcessTree(childPid.longValue(), pids);
        }
    }

    private static List<Long> listUnixChildPids(long pid) {
        List<Long> children = new ArrayList<>();
        Process process = null;
        try {
            process = new ProcessBuilder("pgrep", "-P", String.valueOf(pid)).start();
            try (BufferedReader reader =
                         new BufferedReader(
                                 new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    try {
                        children.add(Long.valueOf(Long.parseLong(line.trim())));
                    } catch (NumberFormatException ignored) {
                    }
                }
            }
            process.waitFor(1, TimeUnit.SECONDS);
        } catch (Throwable ignored) {
        } finally {
            if (process != null) {
                process.destroy();
            }
        }
        return children;
    }

    private static void waitForProcess(Process process, long timeoutMs) {
        try {
            process.waitFor(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static void runQuietly(List<String> command) {
        Process process = null;
        try {
            process = new ProcessBuilder(command).start();
            process.waitFor(1, TimeUnit.SECONDS);
        } catch (Throwable e) {
            LOG.debug("Command failed silently {}: {}", command, e.getMessage());
        } finally {
            if (process != null) {
                process.destroy();
            }
        }
    }

    private static boolean isWindows() {
        return EnvironmentResolver.isWindows();
    }

    public static final class CommandSnapshot {

        private final String sessionId;
        private final String command;
        private final Path workdir;
        private final boolean running;
        private final Integer exitCode;
        private final boolean timedOut;
        private final boolean terminated;
        private final String terminateReason;
        private final long wallTimeMs;
        private final int outputChars;
        private final int returnedChars;
        private final boolean outputTruncated;
        private final String output;

        CommandSnapshot(
                String sessionId,
                String command,
                Path workdir,
                boolean running,
                Integer exitCode,
                boolean timedOut,
                boolean terminated,
                String terminateReason,
                long wallTimeMs,
                int outputChars,
                int returnedChars,
                boolean outputTruncated,
                String output) {
            this.sessionId = sessionId;
            this.command = command;
            this.workdir = workdir;
            this.running = running;
            this.exitCode = exitCode;
            this.timedOut = timedOut;
            this.terminated = terminated;
            this.terminateReason = terminateReason;
            this.wallTimeMs = wallTimeMs;
            this.outputChars = outputChars;
            this.returnedChars = returnedChars;
            this.outputTruncated = outputTruncated;
            this.output = output;
        }

        public String sessionId() {
            return sessionId;
        }

        public String command() {
            return command;
        }

        public Path workdir() {
            return workdir;
        }

        public boolean running() {
            return running;
        }

        public Integer exitCode() {
            return exitCode;
        }

        public boolean timedOut() {
            return timedOut;
        }

        public boolean terminated() {
            return terminated;
        }

        public String terminateReason() {
            return terminateReason;
        }

        public long wallTimeMs() {
            return wallTimeMs;
        }

        public int outputChars() {
            return outputChars;
        }

        public int returnedChars() {
            return returnedChars;
        }

        public boolean outputTruncated() {
            return outputTruncated;
        }

        public String output() {
            return output;
        }
    }

    static final class CommandSession {

        private final String sessionId;
        private final String command;
        private final Path workdir;
        private final Process process;
        private final long startedAt;
        private final int hardTimeoutMs;
        private final Charset outputCharset;
        private final Charset stdinCharset;
        private final Runnable cleanup; // 会话结束后的临时脚本清理（Windows 脚本执行方案）
        private final Consumer<CommandSnapshot> onComplete; // 进程结束回调（后台任务完成通知），可为 null
        private final Object lock = new Object();
        private final AtomicBoolean discarded = new AtomicBoolean(false);
        private final CompletableFuture<Integer> exitFuture = new CompletableFuture<>();
        private final CompletableFuture<Void> readerFuture = new CompletableFuture<>();

        // ===== 输出存储：内存窗口 + 可选溢出文件 =====
        //
        // 【为什么不设上限截断】后台会话的输出是模型要逐段真正消费的正文（用 bash 打印大文件、
        // 看长构建日志都是正当场景），任何丢弃型保护都会让 bash_output 读不全。因此这里只改变
        // 「存放位置」，不改变「能读到多少」：
        //   · 纯内存模式：仅回收**已经返回给模型**的前缀（游标只进不退，那段永远不会再被返回，
        //     因此对外行为零变化）；
        //   · 累计输出超过 SPILL_THRESHOLD_CHARS 后转入落盘模式：全文继续完整追加到溢出文件，
        //     内存只保留末尾窗口，读取时按绝对字符偏移从「文件 + 窗口」拼接。
        //
        // 溢出文件用 UTF-16BE 而非 UTF-8：Java 的 char 是 UTF-16 码元，UTF-16BE 下
        // 「字节偏移 = 字符偏移 × 2」恒成立（代理对为 2 char / 4 字节，同样成立），可直接随机
        // 定位。若用变长的 UTF-8，就得额外维护一张 char→byte 索引表才能按偏移 seek。
        private final StringBuilder output = new StringBuilder();
        /** 累计产生的字符总数（绝对量，只增不减） */
        private long totalChars;
        /** {@code output[0]} 对应的绝对字符偏移（前缀被回收/落盘后会前移） */
        private long windowStart;
        /** 已消费（已返回给模型）的绝对字符偏移 */
        private long nextOutputOffset;
        private RandomAccessFile spill;
        private Path spillPath;
        /** 溢出文件第 0 个字符对应的绝对偏移 */
        private long spillBase;
        /** 溢出文件已写入的字节数（写入前据此 seek，避免与读取的 seek 互相打乱） */
        private long spillLen;
        /** 落盘一旦失败就不再重试：否则每次 append 都会重新尝试建文件 */
        private boolean spillFailed;
        private volatile long completedAt;
        private volatile boolean timedOut;
        private volatile boolean terminated;
        private volatile String terminateReason;

        CommandSession(
                String sessionId,
                String command,
                Path workdir,
                Process process,
                long startedAt,
                int hardTimeoutMs,
                Charset outputCharset,
                Charset stdinCharset,
                Runnable cleanup,
                Consumer<CommandSnapshot> onComplete) {
            this.sessionId = sessionId;
            this.command = command;
            this.workdir = workdir;
            this.process = process;
            this.startedAt = startedAt;
            this.hardTimeoutMs = hardTimeoutMs;
            this.outputCharset = outputCharset;
            this.stdinCharset = stdinCharset == null ? StandardCharsets.UTF_8 : stdinCharset;
            this.cleanup = cleanup;
            this.onComplete = onComplete;
        }

        void start() {
            // 登记到全局存活表：JVM 退出钩子据此整树终止子进程并删除溢出文件（daemon 线程会随
            // JVM 消失，但子进程树不会——不清理就会留下占着端口的孤儿 node/vite）
            LIVE_SESSIONS.put(this, Boolean.TRUE);
            Thread reader = new Thread(this::readOutput, "gwork-command-reader-" + sessionId);
            reader.setDaemon(true);
            reader.start();
            // 定时器只负责「派发」：真正的杀动作要 fork taskkill/kill 并同步等待（最长约 2 秒），
            // 跑在单线程的 TIMEOUT_EXECUTOR 上会让同时到点的多个任务串行排队
            TIMEOUT_EXECUTOR.schedule(
                    () -> KILL_EXECUTOR.execute(this::enforceHardTimeout),
                    hardTimeoutMs,
                    TimeUnit.MILLISECONDS);
            Thread waiter = new Thread(this::waitForExit, "gwork-command-waiter-" + sessionId);
            waiter.setDaemon(true);
            waiter.start();
        }

        private void waitForExit() {
            try {
                int exitCode = process.waitFor();
                completedAt = System.currentTimeMillis();
                exitFuture.complete(Integer.valueOf(exitCode));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                completedAt = System.currentTimeMillis();
                exitFuture.completeExceptionally(e);
            } catch (Throwable e) {
                completedAt = System.currentTimeMillis();
                exitFuture.completeExceptionally(e);
            } finally {
                runCleanup();
                fireCompletion();
            }
        }

        /**
         * 触发完成回调（后台任务通知）。
         *
         * <p>先等读取线程把管道残余输出排干，否则通知里的尾部输出会缺最后几行（失败原因常在最后一行）。
         * 取的是「非消费性」快照：不推进 nextOutputOffset，否则后续 bash_output 会漏掉这段增量。</p>
         */
        private void fireCompletion() {
            if (onComplete == null) {
                return;
            }
            try {
                awaitReaderIfCompleted(500);
                onComplete.accept(snapshotTail(NOTICE_TAIL_CHARS));
            } catch (Throwable e) {
                // 通知失败不得影响命令本身的生命周期
                LOG.debug("Command completion callback failed for {}: {}", sessionId, e.getMessage());
            }
        }

        private void runCleanup() {
            if (cleanup != null) {
                try {
                    cleanup.run();
                } catch (Throwable ignored) {
                    // 清理失败仅残留一个临时脚本文件，不影响会话结果
                }
            }
        }

        void write(String chars) throws IOException {
            if (chars == null || chars.isEmpty()) {
                return;
            }
            if (isRunning() == false) {
                throw new IOException("Process is not running: " + sessionId);
            }
            OutputStream stdin = process.getOutputStream();
            // 编码按 shell 方言选定（见 resolveStdinCharset）：CMD 方言按系统 ANSI 代码页读
            // stdin，硬编码 UTF-8 会让写入的中文变乱码
            stdin.write(chars.getBytes(stdinCharset));
            stdin.flush();
        }

        void terminate(String reason) {
            if (isRunning()) {
                terminated = true;
                terminateReason = reason == null || reason.trim().isEmpty() ? "requested" : reason;
                destroyProcessTree(process);
            }
        }

        void enforceHardTimeout() {
            if (isRunning() == false) {
                return;
            }
            if (System.currentTimeMillis() - startedAt >= hardTimeoutMs) {
                timedOut = true;
                terminateReason = "hard_timeout_ms=" + hardTimeoutMs;
                destroyProcessTree(process);
            }
        }

        void awaitReaderIfCompleted(long timeoutMs) {
            if (exitFuture.isDone() == false) {
                return;
            }
            try {
                readerFuture.get(timeoutMs, TimeUnit.MILLISECONDS);
            } catch (Exception ignored) {
            }
        }

        /**
         * 消费性增量快照：返回「未消费区间的<b>头部</b>」至多 {@code maxOutputChars} 字符，
         * 游标只推进实际返回的那一段。
         *
         * <p><b>相对旧实现的语义变更</b>：旧实现超限时返回「整个输出的尾部 N 字符」却把游标一把推到
         * 末尾，于是既可能重复返回已给过模型的内容，又会把中间增量<b>永久丢弃</b>，而提示语只写
         * {@code truncated to last N chars}，模型完全不知道中间那段再也取不回来。现在改为顺序补读：
         * 连续调用 {@code bash_output} 即可完整取回全部输出，一个字符都不会丢。</p>
         *
         * <p>游标的读-改-写必须与读取同处一个临界区，否则并发查询会重复返回或漏读一段。</p>
         */
        CommandSnapshot snapshot(int maxOutputChars) {
            String outputText;
            long total;
            boolean truncated = false;
            synchronized (lock) {
                total = totalChars;
                long start = Math.min(nextOutputOffset, total);
                long available = total - start;
                int take = (int) Math.min(available, maxOutputChars);
                outputText = readRangeLocked(start, take);
                nextOutputOffset = start + take;
                long remaining = available - take;
                if (remaining > 0) {
                    truncated = true;
                    outputText = outputText
                            + "\n... [还有 " + remaining
                            + " 字符未读取：再次调用 bash_output 会按顺序继续返回，内容不会丢失]";
                }
                reclaimLocked();
            }
            return buildSnapshot(total, outputText, truncated);
        }

        /**
         * 非消费性尾部快照：只取末尾若干字符，不推进「已消费字符偏移」。
         *
         * <p>专供完成通知使用：通知里展示过的内容，后续 bash_output 仍应能完整取到，
         * 两者互不干扰。</p>
         */
        CommandSnapshot snapshotTail(int maxOutputChars) {
            String outputText;
            long total;
            boolean truncated = false;
            synchronized (lock) {
                total = totalChars;
                long from = total - Math.min(total, maxOutputChars);
                // 已被回收的前缀（纯内存模式下那段已返回给模型）不可再读，下界收敛到可读起点
                long floor = spill == null ? windowStart : spillBase;
                if (from < floor) {
                    from = floor;
                }
                outputText = readRangeLocked(from, (int) (total - from));
                truncated = from > 0;
            }
            return buildSnapshot(total, outputText, truncated);
        }

        private CommandSnapshot buildSnapshot(long total, String outputText, boolean truncated) {
            Integer exitCode = null;
            if (exitFuture.isDone()) {
                try {
                    exitCode = exitFuture.getNow(null);
                } catch (Throwable ignored) {
                }
            }
            return new CommandSnapshot(
                    sessionId,
                    command,
                    workdir,
                    isRunning(),
                    exitCode,
                    timedOut,
                    terminated,
                    terminateReason,
                    System.currentTimeMillis() - startedAt,
                    (int) Math.min(total, Integer.MAX_VALUE),
                    outputText.length(),
                    truncated,
                    outputText);
        }

        // ===================== 输出存储（内存窗口 + 可选溢出文件） =====================

        /** 追加一段已解码文本。调用方必须持有 {@link #lock}。 */
        private void appendLocked(String text) {
            output.append(text);
            totalChars += text.length();

            if (output.length() < RECLAIM_MIN_CHARS) {
                return; // 小量追加不做搬移：每个 4KB 分块都 delete 前缀会退化成 O(n²)
            }
            if (spill == null && totalChars > SPILL_THRESHOLD_CHARS) {
                openSpillLocked();
            }
            if (spill != null) {
                // 落盘模式：窗口之外的内容整段写入文件（不丢弃），内存只留尾部窗口
                int overflow = output.length() - SPILL_WINDOW_CHARS;
                if (overflow > 0 && writeSpillLocked(output, overflow)) {
                    output.delete(0, overflow);
                    windowStart += overflow;
                }
                return;
            }
            // 纯内存模式：只回收「已经返回给模型」的前缀——那段永远不会再被返回，
            // 因此对外行为零变化（这是与「加上限截断」的本质区别）
            long consumed = nextOutputOffset - windowStart;
            if (consumed >= RECLAIM_MIN_CHARS) {
                output.delete(0, (int) consumed);
                windowStart += consumed;
            }
        }

        /** 快照读取后的顺手回收（纯内存模式下让已消费前缀尽快可回收）。 */
        private void reclaimLocked() {
            if (spill != null) {
                return;
            }
            long consumed = nextOutputOffset - windowStart;
            if (consumed >= RECLAIM_MIN_CHARS) {
                output.delete(0, (int) consumed);
                windowStart += consumed;
            }
        }

        /**
         * 读取绝对字符区间 {@code [from, from+len)}：窗口之前的部分从溢出文件取回，其余取自内存。
         * 调用方必须持有 {@link #lock}。
         */
        private String readRangeLocked(long from, int len) {
            if (len <= 0) {
                return "";
            }
            long end = from + len;
            StringBuilder sb = new StringBuilder(len);
            long pos = from;
            if (pos < windowStart) {
                long fileEnd = Math.min(end, windowStart);
                sb.append(readSpillLocked(pos, (int) (fileEnd - pos)));
                pos = fileEnd;
            }
            if (pos < end) {
                int s = (int) Math.max(0, pos - windowStart);
                int e = (int) Math.min(output.length(), end - windowStart);
                if (e > s) {
                    sb.append(output, s, e);
                }
            }
            return sb.toString();
        }

        /**
         * 打开溢出文件。失败只记一次并永久退回纯内存模式（继续重试只会在每次追加时再炸一遍）。
         */
        private void openSpillLocked() {
            if (spillFailed) {
                return;
            }
            try {
                spillPath = Files.createTempFile("gwork-bgout-", ".bin");
                spill = new RandomAccessFile(spillPath.toFile(), "rw");
                spillBase = windowStart;
                spillLen = 0L;
            } catch (Throwable e) {
                spillFailed = true;
                spill = null;
                spillPath = null;
                LOG.debug("Open spill file failed for {}: {}", sessionId, e.toString());
            }
        }

        /**
         * 把 {@code src} 的前 {@code len} 个字符写入溢出文件尾部。
         *
         * <p>用 UTF-16BE 存储：Java 的 char 即 UTF-16 码元，「字节偏移 = 字符偏移 × 2」恒成立，
         * 可直接随机定位；换成变长的 UTF-8 就得额外维护 char→byte 索引表。</p>
         *
         * @return 是否写入成功；失败时返回 {@code false}，调用方须保留内存中的这段内容（宁可多占
         *         内存，也不能丢用户要读的输出）
         */
        private boolean writeSpillLocked(StringBuilder src, int len) {
            try {
                byte[] bytes = src.substring(0, len).getBytes(StandardCharsets.UTF_16BE);
                spill.seek(spillLen);
                spill.write(bytes);
                spillLen += bytes.length;
                return true;
            } catch (Throwable e) {
                spillFailed = true;
                LOG.debug("Write spill file failed for {}: {}", sessionId, e.toString());
                return false;
            }
        }

        private String readSpillLocked(long from, int len) {
            if (spill == null || len <= 0) {
                return "";
            }
            try {
                byte[] bytes = new byte[len * 2];
                spill.seek((from - spillBase) * 2);
                spill.readFully(bytes);
                return new String(bytes, StandardCharsets.UTF_16BE);
            } catch (Throwable e) {
                LOG.debug("Read spill file failed for {}: {}", sessionId, e.toString());
                return "\n[溢出文件读取失败，该段输出暂不可用]\n";
            }
        }

        /**
         * 释放会话占用的外部资源（溢出文件）并从全局存活表注销。幂等。
         */
        void discard() {
            if (discarded.compareAndSet(false, true) == false) {
                return;
            }
            LIVE_SESSIONS.remove(this);
            synchronized (lock) {
                closeQuietly(spill);
                spill = null;
                if (spillPath != null) {
                    try {
                        Files.deleteIfExists(spillPath);
                    } catch (Throwable ignored) {
                        // 残留交由系统临时目录清理策略处理
                    }
                    spillPath = null;
                }
            }
        }

        CompletableFuture<Integer> exitFuture() {
            return exitFuture;
        }

        long completedAt() {
            return completedAt;
        }

        boolean isRunning() {
            return process.isAlive();
        }

        private void readOutput() {
            // 字节层读取 + 增量解码：解码器（仅本线程使用）内部保留不完整的多字节序列，
            // 因此 UTF-8 中文不会被 4096 分块边界切断；同时具备 ANSI 代码页兜底能力
            OutputDecoder decoder = new OutputDecoder(outputCharset);
            // PowerShell 会向 stderr 写 CLIXML 块（参见 CliXmlFilter）：必须在解码前剥离，
            // 否则一条流里混着两种编码，字符集锁定后必有一半变乱码
            CliXmlFilter cliXmlFilter = CliXmlFilter.isNeeded() ? new CliXmlFilter() : null;
            try (InputStream input = process.getInputStream()) {
                byte[] buffer = new byte[4096];
                int n;
                while ((n = input.read(buffer)) != -1) {
                    byte[] chunk = buffer;
                    int len = n;
                    if (cliXmlFilter != null) {
                        chunk = cliXmlFilter.accept(buffer, n);
                        len = chunk.length;
                        if (len == 0) {
                            continue;
                        }
                    }
                    String text = decoder.decode(chunk, len);
                    if (text.isEmpty() == false) {
                        synchronized (lock) {
                            appendLocked(text);
                        }
                    }
                }
            } catch (IOException e) {
                LOG.debug("Command output reader stopped for {}: {}", sessionId, e.getMessage());
                readerFuture.completeExceptionally(e);
            } finally {
                StringBuilder rest = new StringBuilder();
                if (cliXmlFilter != null) {
                    byte[] pending = cliXmlFilter.flush();
                    if (pending.length > 0) {
                        rest.append(decoder.decode(pending, pending.length));
                    }
                }
                rest.append(decoder.flush());
                // CLIXML 里的 error/warning 文本单独解码后补在末尾
                if (cliXmlFilter != null) {
                    rest.append(cliXmlFilter.drainMessages());
                }
                if (rest.length() > 0) {
                    synchronized (lock) {
                        appendLocked(rest.toString());
                    }
                }
                if (readerFuture.isDone() == false) {
                    readerFuture.complete(null);
                }
            }
        }
    }
}
