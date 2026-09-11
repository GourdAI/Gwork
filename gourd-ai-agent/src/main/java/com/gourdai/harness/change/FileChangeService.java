/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
package com.gourdai.harness.change;

import org.noear.snack4.ONode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Agent 文件变更账本。只由 write/edit 工具调用驱动，不依赖 Git，也不观察编辑器或工作区。
 *
 * <p>每个 sessionId/runId 维护一份 manifest，同一路径只保留第一次修改前与最后一次修改后；
 * 内容按 SHA-256 存放为共享 blob。所有恢复操作先对整批文件做 hash 预检，预检失败时零写入。</p>
 */
public final class FileChangeService {
    private static final Logger LOG = LoggerFactory.getLogger(FileChangeService.class);
    private static final FileChangeService INSTANCE = new FileChangeService();
    private static final String STORE_DIR = ".gwork/file-changes";

    /**
     * 变更归属键：子代理运行在独立 AgentSession 上（sessionId = 代理名，runId = 新 uuid），
     * 若按各自 trace 落账，manifest 会写进前端永远查不到的孤儿目录，且不会标记 possiblyIncomplete，
     * 造成「卡片显示 3 个文件，实际改了 5 个」的静默假成功。故由 TaskTalent 显式透传主 run 归属。
     * 不能复用 ChatSession.ATTR_SESSIONID：它会被 ReActAgent 无条件覆盖为子会话 id，
     * 且被 TodoTalent/MemoryTalent 依赖为「当前 Agent 自己的会话」，改其语义爆炸半径过大。
     */
    public static final String ATTR_CHANGE_SESSIONID = "__changeSessionId";
    public static final String ATTR_CHANGE_RUNID = "__changeRunId";
    private static final String MANIFEST_VERSION = "1";
    /** 单文件内容留存上限；超限只算 hash，不保存内容。 */
    private static final long MAX_CONTENT_BYTES = 8L * 1024 * 1024;
    /** 行级差异的规模上限，超限降级为粗略统计，避免 O(n^2) 爆炸。 */
    private static final int MAX_DIFF_LINES = 20000;
    private static final long MAX_DIFF_CELLS = 4_000_000L;
    /** operationId 幂等缓存上限。 */
    private static final int MAX_OPERATION_CACHE = 256;
    /** 仅这些状态已落盘新 revision，需要向前端推送。 */
    private static final Set<String> PUBLISHED_STATUSES =
            Set.of("OK", "CONFLICT", "ERROR_COMPENSATED", "ERROR_PARTIAL");

    /**
     * 只有「已对账本落盘、结果不会自行变化」的状态才允许进幂等缓存。
     *
     * <p>BUSY 必须排除：它是<b>瞬态</b>的（run 收口后重试就能成功），旧实现无条件缓存它，
     * 于是同一个 operationId 一旦撞上 BUSY 就永久返回 BUSY，且缓存无过期时间、重启也不清。
     * 当前只靠前端每次生成新随机 id 掩盖了这个缺陷。INVALID_REQUEST / NOT_FOUND / ERROR
     * 同理：它们是入参或环境问题的信号，重试（修正参数后）应该能变，不该被钉死。</p>
     */
    private static final Set<String> CACHEABLE_STATUSES =
            Set.of("OK", "CONFLICT", "CONTENT_UNAVAILABLE", "ERROR_COMPENSATED", "ERROR_PARTIAL");

    /**
     * incompleteReasons 的条数上限。
     *
     * <p>该列表按失败路径逐条累积、且会随每个变更帧广播给前端，而上限缺失时一次长 run 里
     * 几十次快照失败就能把它撑到几十条，前端 .file-changes-warning 又没有 max-height，直接撑破卡片。</p>
     */
    private static final int MAX_INCOMPLETE_REASONS = 20;

    /**
     * UTF-8 严格解码失败后按序尝试的遗留文本编码。
     *
     * <p>只收录<b>多字节</b>编码：它们对字节序列有真实的结构约束，解不开就会报错，可当判据用。
     * 刻意不收 windows-1252 / ISO-8859-1 这类单字节编码——它们几乎能「解通」任意字节串，
     * 一旦收录，所有二进制文件都会被当成文本渲染成乱码。</p>
     */
    private static final String[] FALLBACK_TEXT_CHARSETS = {"GBK", "Big5", "Shift_JIS", "EUC-KR"};

    /**
     * 账本与 blob 的保留期。超期的 manifest 连同其不再被引用的 blob 在启动补偿扫描时一并回收。
     *
     * <p>旧实现通读全类没有任何 delete/GC/expire/quota 逻辑，而 blob 跨 run 共享又无引用计数，
     * 长期使用可达 GB 级。回收必须跟着启动补偿扫描走：那时已经遍历了整个 manifests 目录，
     * 顺手做 mark-sweep 几乎零额外成本，且不会在 run 进行中误删。</p>
     */
    private static final long RETENTION_MS = 30L * 24 * 60 * 60 * 1000;
    /** 启动补偿失败后的最小重试间隔，避免每次 API 访问都立即重扫故障目录。 */
    private static final long MAINTENANCE_RETRY_MS = 5_000L;

    /**
     * 本进程启动时刻。updatedAt 早于它的未收口账本，必然来自已退出的上一个进程
     * ——这是「进程崩溃导致 run 永久停在 ready=false」的可靠判据，不会误伤本进程内正在跑的 run。
     */
    private static final long PROCESS_START_MS = System.currentTimeMillis();

    /**
     * 锁分片表：固定 {@value #LOCK_STRIPES} 把锁，按 lockKey 的 hash 取模选取。
     *
     * <p>为什么不用 {@code ConcurrentHashMap<String,Object>} 存锁对象：</p>
     * <ol>
     *   <li><b>无界增长</b>：唯一清理点在 finish() 里，而 finish 之后任何 getRun/diff/undo 都会
     *       computeIfAbsent 把条目重新塞回且再无清理；前端又会主动轮询（app-file-changes.js 的
     *       reconcile），于是每个被查看过的三元组都留下一条永久条目。</li>
     *   <li><b>互斥失效</b>：remove 与 computeIfAbsent 之间存在经典竞态——仍持有旧锁对象的在途线程
     *       与新拿到的新锁对象不再互斥，会并发 load→改→save 同一份 manifest，造成 revision 丢更新。</li>
     * </ol>
     *
     * <p>固定分片表两个问题都不存在：锁对象数量恒定、永不移除，同一 key 恒映射到同一把锁。
     * 代价是不同 run 可能共享一把锁（64 片，而实际并发 run 数远低于此，争用可忽略）。
     * 用 synchronized 而非 ReentrantLock：本类多处嵌套持锁（apply → applyLocked → load），
     * synchronized 可重入且不会忘记 unlock。</p>
     */
    private static final int LOCK_STRIPES = 64;
    private final Object[] lockStripes = new Object[LOCK_STRIPES];

    private final Map<String, Map<String, Object>> operationCache = Collections.synchronizedMap(new OperationCache());
    /** 已成功做过启动补偿扫描（解锁 + GC）的 root，保证每进程每 root 最多成功扫一次。 */
    private final Set<String> maintainedRoots = ConcurrentHashMap.newKeySet();
    /** 扫描失败 root 的下次允许重试时刻；成功后移除。 */
    private final Map<String, Long> maintenanceRetryAfter = new ConcurrentHashMap<>();
    /** 已写过 .git/info/exclude 的 root。 */
    private final Set<String> excludeWrittenRoots = ConcurrentHashMap.newKeySet();
    private volatile Listener listener;

    private FileChangeService() {
        for (int i = 0; i < LOCK_STRIPES; i++) {
            lockStripes[i] = new Object();
        }
    }

    public static FileChangeService getInstance() {
        return INSTANCE;
    }

    public void setListener(Listener listener) {
        this.listener = listener;
    }

    /** 工具执行前快照。失败只标记账本不完整，永不向工具调用方抛出。 */
    public Capture before(String sessionId, String runId, String root, String filePath) {
        Capture capture = new Capture(sessionId, runId, root, filePath);
        try {
            capture.root = validateRoot(root);
            ensureStoreExcluded(capture.root);
            capture.path = validateRelativePath(capture.root, filePath);
            capture.relativePath = normalizeRelative(capture.root.relativize(capture.path));
            capture.before = readState(capture.path);
        } catch (Throwable e) {
            capture.error = message(e);
            markIncompleteQuietly(sessionId, runId, root, "before snapshot failed for " + safePath(filePath) + ": " + capture.error);
            LOG.warn("[FileChanges] before snapshot failed, session={}, run={}, path={}: {}",
                    sessionId, runId, safePath(filePath), capture.error);
        }
        return capture;
    }

    /** 工具执行后聚合快照。before/after 相同会移除净零条目。 */
    public void after(Capture capture) {
        if (capture == null || capture.error != null || capture.path == null) {
            return;
        }
        Map<String, Object> snapshot;
        try {
            FileState after = readState(capture.path);
            synchronized (lockFor(capture.sessionId, capture.runId, capture.root)) {
                Manifest manifest = load(capture.sessionId, capture.runId, capture.root);
                Entry existing = manifest.entries.get(capture.relativePath);
                FileState before = existing == null ? capture.before : existing.before;
                Entry entry = new Entry(capture.relativePath, before, after);
                if (same(before, after)) {
                    manifest.entries.remove(capture.relativePath);
                } else {
                    persistBlob(capture.root, before);
                    persistBlob(capture.root, after);
                    manifest.entries.put(capture.relativePath, entry);
                }
                manifest.lastStatus = "CAPTURED";
                manifest.conflicts.clear();
                touchAndSave(manifest, capture.root);
                snapshot = summary(manifest);
            }
        } catch (Throwable e) {
            markIncompleteQuietly(capture.sessionId, capture.runId, capture.root == null ? capture.rootText : capture.root.toString(),
                    "after snapshot failed for " + safePath(capture.filePath) + ": " + message(e));
            LOG.warn("[FileChanges] after snapshot failed, session={}, run={}, path={}: {}",
                    capture.sessionId, capture.runId, safePath(capture.filePath), message(e));
            return;
        }
        publish(capture.sessionId, capture.runId, snapshot);
    }

    /** bash 不做工作区快照，只明确降低本轮完整性。 */
    public void markBash(String sessionId, String runId, String root) {
        markIncompleteQuietly(sessionId, runId, root, "bash was invoked and may have changed untracked files");
    }

    /** 正常 run 收口为 READY，并发布最终 revision；返回 false 表示落盘失败，可由调用方重试。 */
    public boolean finish(String sessionId, String runId, String root) {
        return finish(sessionId, runId, root, true);
    }

    /**
     * run 收口。
     *
     * <p><b>ready 必须无条件置位</b>：它是撤销/重放的第一道门禁（applyLocked 里 {@code !ready}
     * 直接回 BUSY）。旧实现只在「正常完成」路径调 finish，于是 run 一旦异常终止或被用户 Stop，
     * 账本就永远停在 ready=false —— 恰恰在「agent 跑挂了 / 被我停了、工作区被改乱、最需要回滚」
     * 的场景下撤销按钮永久返回 BUSY，且重启也不自愈（磁盘上读回的仍是 ready=false）。</p>
     *
     * <p>三条终止路径都必须调到本方法：① 流异常；② 用户 Stop / 新任务取代（done 帧不经过
     * doOnNext）；③ 进程崩溃（由 {@link #maintain} 的启动补偿兜底）。</p>
     *
     * @param clean true=正常收口（READY）；false=异常/取消收口。后者同样解锁撤销能力，
     *              但会标记 possiblyIncomplete 并写明原因，因为异常终止时最后一批 write/edit
     *              可能没来得及落账。状态沏用已有的 INCOMPLETE（而非新造一个值），
     *              避开前端未知状态的渲染风险。
     */
    public boolean finish(String sessionId, String runId, String root, boolean clean) {
        try {
            Path safeRoot = validateRoot(root);
            Map<String, Object> snapshot;
            synchronized (lockFor(sessionId, runId, safeRoot)) {
                Manifest manifest = load(sessionId, runId, safeRoot);
                // 多条终止回调可能并发到达。ready 是已经成功落盘的完成标志；命中后直接成功，
                // 既不重复增加 revision，也不把后续迟到的异常回调覆盖到已完成状态。
                if (manifest.ready) {
                    return true;
                }
                manifest.ready = true;
                manifest.lastStatus = clean ? "READY" : "INCOMPLETE";
                manifest.conflicts.clear();
                if (!clean) {
                    manifest.possiblyIncomplete = true;
                    addReason(manifest, "run terminated abnormally or was stopped; the last writes may not be tracked");
                }
                touchAndSave(manifest, safeRoot);
                snapshot = summary(manifest);
            }
            publish(sessionId, runId, snapshot);
            return true;
        } catch (Throwable e) {
            LOG.warn("[FileChanges] finish failed, session={}, run={}, clean={}: {}", sessionId, runId, clean, message(e));
            return false;
        }
    }

    /**
     * 进程启动后的一次性补偿扇描：① 解锁上一个进程遗留的未收口 run；② 回收超期账本与孤儿 blob。
     *
     * <p>为何不放启动钩子：账本按 root 分目录存放（{@code <root>/.gwork/file-changes}），而 root 是
     * 运行时才知道的（会话可绑定任意项目根），启动时无法枚举。故改为「首次访问某 root 时扫一次」，
     * 用 {@link #maintainedRoots} 保证每进程每 root 最多一次。</p>
     *
     * <p>解锁判据用 {@code updatedAt < PROCESS_START_MS}：早于本进程启动时刻的未收口账本，必然来自
     * 已经退出的上一个进程（内存里的流早已不存在），因此可以确定不会再有人来 finish。
     * 这个判据不会误伤本进程内正在跑的 run——后者的 updatedAt 必然晚于进程启动。</p>
     *
     * <p><b>必须在取任何 per-run 锁之前调用</b>：本方法内部会为别的 run 取锁，
     * 若已持有当前 run 的锁再进来，两个线程交叉时就可能死锁。</p>
     */
    private void maintain(Path root) {
        String rootKey = root.toString();
        if (maintainedRoots.contains(rootKey)) {
            return;
        }
        Long retryAfter = maintenanceRetryAfter.get(rootKey);
        if (retryAfter != null && System.currentTimeMillis() < retryAfter) {
            return;
        }

        // 同一 root 的首次访问可能并发；借用固定分片锁把检查与扫描串行化，失败不占用成功标志。
        synchronized (lockFor("__maintenance__", rootKey, root)) {
            if (maintainedRoots.contains(rootKey)) return;
            retryAfter = maintenanceRetryAfter.get(rootKey);
            if (retryAfter != null && System.currentTimeMillis() < retryAfter) return;
            if (maintainLocked(root)) {
                maintainedRoots.add(rootKey);
                maintenanceRetryAfter.remove(rootKey);
            } else {
                maintenanceRetryAfter.put(rootKey, System.currentTimeMillis() + MAINTENANCE_RETRY_MS);
            }
        }
    }

    /** @return true 仅表示整次扫描无读取/遍历失败，可以永久标记。包可见以便稳定验证失败后可重试。 */
    boolean maintainLocked(Path root) {
        Path dir = root.resolve(STORE_DIR).resolve("manifests");
        if (!Files.exists(dir)) return true;
        if (!Files.isDirectory(dir)) {
            LOG.warn("[FileChanges] startup maintenance path is not a directory: {}", dir);
            return false;
        }

        long expireBefore = System.currentTimeMillis() - RETENTION_MS;
        Set<String> liveBlobs = new HashSet<>();
        // 任何一个账本读取失败都意味着 liveBlobs 不完整，此时绝不能 sweep（会误删在用 blob）
        boolean walkClean = true;
        int unlocked = 0;
        int expired = 0;

        try (java.util.stream.Stream<Path> sessions = Files.list(dir)) {
            List<Path> sessionDirs = sessions.filter(Files::isDirectory)
                    .collect(java.util.stream.Collectors.toList());

            for (Path sessionDir : sessionDirs) {
                List<Path> files;
                try (java.util.stream.Stream<Path> runs = Files.list(sessionDir)) {
                    files = runs.filter(p -> p.getFileName().toString().endsWith(".json"))
                            .collect(java.util.stream.Collectors.toList());
                }

                for (Path file : files) {
                    try {
                        Map<String, Object> map = readManifestMap(file);
                        if (map == null) {
                            walkClean = false;
                            continue;
                        }

                        long updatedAt = longValue(map.get("updatedAt"));
                        if (updatedAt > 0 && updatedAt < expireBefore) {
                            // 超期：连账本一起回收，其 blob 不再进 liveBlobs，由下面的 mark-sweep 清掉
                            Files.deleteIfExists(file);
                            expired++;
                            continue;
                        }

                        collectBlobs(map, liveBlobs);

                        if (Boolean.TRUE.equals(map.get("ready"))) {
                            continue;
                        }
                        String sessionId = stringValue(map.get("sessionId"), null);
                        String runId = stringValue(map.get("runId"), null);
                        if (sessionId == null || runId == null || updatedAt >= PROCESS_START_MS) {
                            // 本进程内正在跑的 run，或账本缺关键字段：一律不动
                            continue;
                        }

                        // 上一个进程遗留的未收口 run：只有真实落盘成功才算扫描成功；失败需整 root 后续重试。
                        if (finish(sessionId, runId, root.toString(), false)) {
                            unlocked++;
                        } else {
                            walkClean = false;
                        }
                    } catch (Throwable e) {
                        walkClean = false;
                        LOG.warn("[FileChanges] startup maintenance skipped {}: {}", file.getFileName(), message(e));
                    }
                }

                // 会话目录空了就顺手删掉，避免长期堆积空目录
                try (java.util.stream.Stream<Path> rest = Files.list(sessionDir)) {
                    if (rest.findAny().isEmpty()) {
                        Files.deleteIfExists(sessionDir);
                    }
                } catch (Throwable ignored) {
                    // 空目录清不掉不影响正确性
                }
            }
        } catch (Throwable e) {
            LOG.warn("[FileChanges] startup maintenance failed for {}: {}", root, message(e));
            return false;
        }

        int swept = walkClean ? sweepBlobs(root, liveBlobs) : 0;
        if (unlocked > 0 || expired > 0 || swept > 0) {
            LOG.info("[FileChanges] startup maintenance for {}: unlocked={} expired={} orphanBlobsSwept={}",
                    root, unlocked, expired, swept);
        }
        if (!walkClean) {
            LOG.warn("[FileChanges] blob sweep skipped for {}: some manifests were unreadable, "
                    + "sweeping now could delete in-use blobs", root);
        }
        return walkClean;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> readManifestMap(Path file) {
        try {
            return ONode.ofJson(Files.readString(file, StandardCharsets.UTF_8)).toBean(Map.class);
        } catch (Throwable e) {
            return null;
        }
    }

    /** 收集一份账本引用的全部 blob hash（before/after 两侧）。 */
    @SuppressWarnings("unchecked")
    private static void collectBlobs(Map<String, Object> map, Set<String> out) {
        Object entries = map.get("entries");
        if (!(entries instanceof List)) {
            return;
        }
        for (Object value : (List<?>) entries) {
            if (!(value instanceof Map)) {
                continue;
            }
            Map<String, Object> row = (Map<String, Object>) value;
            addHash(out, row.get("before"));
            addHash(out, row.get("after"));
        }
    }

    @SuppressWarnings("unchecked")
    private static void addHash(Set<String> out, Object state) {
        if (!(state instanceof Map)) {
            return;
        }
        Object hash = ((Map<String, Object>) state).get("hash");
        if (hash != null) {
            out.add(String.valueOf(hash));
        }
    }

    /**
     * mark-sweep：删除不再被任何存活账本引用的 blob。
     *
     * <p>两个硬门禁，缺一不可：</p>
     * <ol>
     *   <li>调用方必须保证 liveBlobs 完整（扇描全程无失败），否则会误删在用 blob。</li>
     *   <li>只碰 lastModifiedTime 早于本进程启动的 blob。persistBlob 在 after() 里是先写 blob
     *       再 touchAndSave 账本，两者之间存在「 blob 已落盘、账本未保存」的窗口；
     *       并发 run 此刻新建的 blob 不在 liveBlobs 里，不看时间就会把它当孤儿删掉。</li>
     * </ol>
     */
    private int sweepBlobs(Path root, Set<String> liveBlobs) {
        Path blobs = root.resolve(STORE_DIR).resolve("blobs");
        if (!Files.isDirectory(blobs)) {
            return 0;
        }

        int swept = 0;
        try (java.util.stream.Stream<Path> files = Files.list(blobs)) {
            for (Path blob : files.collect(java.util.stream.Collectors.toList())) {
                String name = blob.getFileName().toString();
                // 只碰 64 位 hex 的正式 blob；临时文件（blob-*.tmp）与任何异常命名一律不动
                if (!name.matches("[0-9a-f]{64}") || liveBlobs.contains(name)) {
                    continue;
                }
                try {
                    if (Files.getLastModifiedTime(blob).toMillis() >= PROCESS_START_MS) {
                        continue;
                    }
                    if (Files.deleteIfExists(blob)) {
                        swept++;
                    }
                } catch (Throwable e) {
                    LOG.warn("[FileChanges] could not sweep orphan blob {}: {}", name, message(e));
                }
            }
        } catch (Throwable e) {
            LOG.warn("[FileChanges] blob sweep failed for {}: {}", root, message(e));
        }
        return swept;
    }

    /**
     * 追加一条不完整原因，带去重与硬上限。
     *
     * <p>上限是必须的：该列表按失败路径逐条累积、且随每个变更帧广播给前端，一次长 run 里
     * 几十次快照失败（每次带不同文件路径，去重挡不住）就能把它撑到几十条，而前端
     * .file-changes-warning 没有 max-height，会直接撑破卡片。触顶后把最后一条换成计数占位，
     * 完整原因落服务端日志，既不丢可诊断性也不撑爆 UI。</p>
     */
    private static void addReason(Manifest manifest, String reason) {
        if (manifest.incompleteReasons.contains(reason)) {
            return;
        }
        if (manifest.incompleteReasons.size() >= MAX_INCOMPLETE_REASONS) {
            LOG.warn("[FileChanges] incompleteReasons reached the cap ({}), dropping: {}",
                    MAX_INCOMPLETE_REASONS, reason);
            manifest.incompleteReasons.set(MAX_INCOMPLETE_REASONS - 1,
                    "further reasons suppressed (see server log)");
            return;
        }
        manifest.incompleteReasons.add(reason);
    }

    public Map<String, Object> getRun(String sessionId, String runId, String root) {
        try {
            Path safeRoot = validateRoot(root);
            // 必须在取锁前：上个进程遗留的未收口 run 要先解锁，否则前端永远只能读到 BUSY
            maintain(safeRoot);
            synchronized (lockFor(sessionId, runId, safeRoot)) {
                return summary(load(sessionId, runId, safeRoot));
            }
        } catch (Throwable e) {
            return errorResult("INVALID_REQUEST", message(e));
        }
    }

    public Map<String, Object> diff(String sessionId, String runId, String root, String filePath) {
        try {
            Path safeRoot = validateRoot(root);
            String relative = normalizeRelative(safeRoot.relativize(validateRelativePath(safeRoot, filePath)));
            synchronized (lockFor(sessionId, runId, safeRoot)) {
                Manifest manifest = load(sessionId, runId, safeRoot);
                Entry entry = manifest.entries.get(relative);
                if (entry == null) {
                    return errorResult("NOT_FOUND", "Change not found");
                }
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("status", "OK");
                out.put("path", entry.path);
                out.put("changeType", entry.changeType());
                out.put("binary", entry.before.binary || entry.after.binary);
                if (!(entry.before.binary || entry.after.binary)) {
                    out.put("before", entry.before.exists ? decodeBlob(safeRoot, entry.before) : null);
                    out.put("after", entry.after.exists ? decodeBlob(safeRoot, entry.after) : null);
                }
                // 单文件 diff 只回该文件的增删统计。此前这里回的是整个 run 的 summary()：
                // 它会遍历 run 内全部 entry 并对缺统计的条目回读 blob 重算 LCS —— 一个改了几十个
                // 文件的 run，点任意一个「审查」都要为其它文件买单，且 before/after 本身已是最大
                // 8MiB×2 的响应，再叠加全量 summary 会明显拖慢首屏。前端 upsert 的刷新由 WebSocket
                // file_changes 与 /changes/run 对账负责，不依赖 diff 顺带回传。
                ensureLineStats(safeRoot, entry);
                out.put("additions", entry.additions);
                out.put("deletions", entry.deletions);
                out.put("revision", manifest.revision);
                return out;
            }
        } catch (Throwable e) {
            return errorResult("INVALID_REQUEST", message(e));
        }
    }

    public Map<String, Object> undoFile(String sessionId, String runId, String root, String filePath) {
        return undoFile(sessionId, runId, root, filePath, null);
    }

    /** operationId 可为 null；非 null 时提供幂等重放。 */
    public Map<String, Object> undoFile(String sessionId, String runId, String root, String filePath, String operationId) {
        return applyOnce(sessionId, runId, root, filePath, Direction.UNDO, operationId);
    }

    public Map<String, Object> undoRun(String sessionId, String runId, String root) {
        return undoRun(sessionId, runId, root, null);
    }

    /** operationId 可为 null；非 null 时提供幂等重放。 */
    public Map<String, Object> undoRun(String sessionId, String runId, String root, String operationId) {
        return applyOnce(sessionId, runId, root, null, Direction.UNDO, operationId);
    }

    public Map<String, Object> reapplyRun(String sessionId, String runId, String root) {
        return reapplyRun(sessionId, runId, root, null);
    }

    /** operationId 可为 null；非 null 时提供幂等重放。 */
    public Map<String, Object> reapplyRun(String sessionId, String runId, String root, String operationId) {
        return applyOnce(sessionId, runId, root, null, Direction.REAPPLY, operationId);
    }

    /** operationId 幂等外壳：同一 operationId 重复提交直接返回首次结果。 */
    private Map<String, Object> applyOnce(String sessionId, String runId, String root, String filePath,
                                          Direction direction, String operationId) {
        if (operationId == null || operationId.trim().isEmpty()) {
            return apply(sessionId, runId, root, filePath, direction);
        }
        String key = root + "\u0001" + sessionId + "\u0001" + runId + "\u0001" + direction + "\u0001" + operationId.trim();
        Map<String, Object> cached = operationCache.get(key);
        if (cached != null) {
            // 必须回副本：调用方（WebController.changeWriteResult）会就地 put("operationId", ...)。
            // 把缓存里的同一个 Map 实例交出去，会让第二次请求看到上一次写入的 operationId，
            // 且并发下对 LinkedHashMap 的一读一写会 CME / 产出损坏 JSON。
            return new LinkedHashMap<>(cached);
        }
        Map<String, Object> result = apply(sessionId, runId, root, filePath, direction);
        // 只缓存已落盘的终态结果：BUSY 是瞬态的（run 收口后重试就能成功），旧实现无条件缓存它，
        // 于是同一 operationId 一旦撞上 BUSY 就永久返回 BUSY（缓存无过期、重启也不清）。
        if (CACHEABLE_STATUSES.contains(String.valueOf(result.get("status")))) {
            operationCache.put(key, new LinkedHashMap<>(result));
        }
        return result;
    }

    private Map<String, Object> apply(String sessionId, String runId, String root, String filePath, Direction direction) {
        Path safeRoot;
        try {
            safeRoot = validateRoot(root);
        } catch (Throwable e) {
            return errorResult("INVALID_REQUEST", safeMessage(e, null));
        }
        // 必须在取锁前：上个进程遗留的未收口 run 要先解锁，否则撤销永久 BUSY
        maintain(safeRoot);
        Map<String, Object> result;
        synchronized (lockFor(sessionId, runId, safeRoot)) {
            result = applyLocked(sessionId, runId, safeRoot, filePath, direction);
        }
        // publish 出锁执行，避免在 Agent 工具边界上持锁做 IO。
        Object snapshot = result.get("summary");
        if (snapshot instanceof Map && PUBLISHED_STATUSES.contains(String.valueOf(result.get("status")))) {
            @SuppressWarnings("unchecked")
            Map<String, Object> typed = (Map<String, Object>) snapshot;
            publish(sessionId, runId, typed);
        }
        return result;
    }

    private Map<String, Object> applyLocked(String sessionId, String runId, Path safeRoot, String filePath, Direction direction) {
        try {
            Manifest manifest = load(sessionId, runId, safeRoot);
            if (!manifest.ready) {
                // run 未收口时可能仍有 write/edit 在写盘，拒绝以避免竞态。
                return operationResult("BUSY", Collections.emptyList(), manifest, detail("Run is still in progress", null));
            }
            List<Entry> targets = new ArrayList<>();
            if (filePath != null) {
                String relative = normalizeRelative(safeRoot.relativize(validateRelativePath(safeRoot, filePath)));
                Entry entry = manifest.entries.get(relative);
                if (entry == null) return errorResult("NOT_FOUND", "Change not found");
                targets.add(entry);
            } else {
                targets.addAll(manifest.entries.values());
            }

            List<String> unavailable = unrecoverable(targets, direction);
            if (!unavailable.isEmpty()) {
                return operationResult("CONTENT_UNAVAILABLE", Collections.emptyList(), manifest,
                        detail("Content was not stored for oversized files", unavailable));
            }

            List<Entry> pending = new ArrayList<>();
            List<Map<String, Object>> conflicts = preflight(safeRoot, targets, direction, pending);
            if (!conflicts.isEmpty()) {
                manifest.lastStatus = "CONFLICT";
                manifest.conflicts = conflicts;
                touchAndSave(manifest, safeRoot);
                return operationResult("CONFLICT", conflicts, manifest, null);
            }

            List<Backup> completed = new ArrayList<>();
            try {
                for (Entry entry : pending) {
                    Path target = validateRelativePath(safeRoot, entry.path);
                    FileState backupState = readState(target);
                    // 补偿也必须使用已持久化内容，不能依赖随后可能被覆盖的目标文件。
                    persistBlob(safeRoot, backupState);
                    completed.add(new Backup(target, backupState));
                    writeState(safeRoot, target, direction == Direction.UNDO ? entry.before : entry.after);
                    entry.undone = direction == Direction.UNDO;
                }
            } catch (Throwable writeFailure) {
                boolean compensated = compensate(safeRoot, completed);
                manifest.possiblyIncomplete = true;
                addReason(manifest, "operation failed: " + safeMessage(writeFailure, safeRoot)
                        + (compensated ? "; changes compensated" : "; compensation incomplete"));
                manifest.lastStatus = compensated ? "ERROR_COMPENSATED" : "ERROR_PARTIAL";
                manifest.conflicts.clear();
                touchAndSave(manifest, safeRoot);
                Map<String, Object> detail = new LinkedHashMap<>();
                detail.put("message", safeMessage(writeFailure, safeRoot));
                detail.put("compensated", compensated);
                return operationResult(manifest.lastStatus, Collections.emptyList(), manifest, detail);
            }

            // 已达目标态的条目也要对齐账本自述状态。
            for (Entry entry : targets) entry.undone = direction == Direction.UNDO;
            manifest.lastStatus = direction == Direction.UNDO ? "UNDONE" : "REAPPLIED";
            manifest.conflicts.clear();
            touchAndSave(manifest, safeRoot);
            return operationResult("OK", Collections.emptyList(), manifest, null);
        } catch (Throwable e) {
            return errorResult("ERROR", message(e));
        }
    }

    /** 内容已跳过（超大文件）的目标态无法恢复，必须明确失败而不是静默成功。 */
    private List<String> unrecoverable(List<Entry> targets, Direction direction) {
        List<String> paths = new ArrayList<>();
        for (Entry entry : targets) {
            FileState goal = direction == Direction.UNDO ? entry.before : entry.after;
            FileState current = direction == Direction.UNDO ? entry.after : entry.before;
            if (goal.exists && goal.contentSkipped && !same(goal, current)) paths.add(entry.path);
        }
        return paths;
    }

    /**
     * 预检按“账本自述的当前应有状态”比对：entry.undone ? before : after。
     * 已达本次操作目标态的条目幂等跳过（不冲突、不写入）；其余不匹配才是真冲突。
     */
    private List<Map<String, Object>> preflight(Path root, List<Entry> targets, Direction direction,
                                                List<Entry> pending) throws IOException {
        List<Map<String, Object>> conflicts = new ArrayList<>();
        for (Entry entry : targets) {
            Path path = validateRelativePath(root, entry.path);
            FileState current = readState(path);
            FileState goal = direction == Direction.UNDO ? entry.before : entry.after;
            if (same(current, goal)) continue;
            FileState expected = entry.undone ? entry.before : entry.after;
            if (!same(current, expected)) {
                Map<String, Object> conflict = new LinkedHashMap<>();
                conflict.put("path", entry.path);
                conflict.put("reason", expected.exists ? "CONTENT_MISMATCH" : "EXPECTED_ABSENT");
                conflict.put("expectedExists", expected.exists);
                conflict.put("actualExists", current.exists);
                conflicts.add(conflict);
                continue;
            }
            pending.add(entry);
        }
        return conflicts;
    }

    private static Map<String, Object> detail(String message, List<String> paths) {
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("message", message);
        if (paths != null) detail.put("paths", paths);
        return detail;
    }

    private boolean compensate(Path root, List<Backup> completed) {
        boolean ok = true;
        for (int i = completed.size() - 1; i >= 0; i--) {
            Backup backup = completed.get(i);
            try {
                writeState(root, backup.path, backup.state);
            } catch (Throwable e) {
                ok = false;
                LOG.error("[FileChanges] compensation failed for {}: {}", backup.path, message(e));
            }
        }
        return ok;
    }

    private void writeState(Path root, Path target, FileState state) throws IOException {
        if (!target.normalize().startsWith(root)) throw new SecurityException("Path escapes root");
        if (!state.exists) {
            Files.deleteIfExists(target);
            return;
        }
        byte[] bytes = readBlob(root, state.hash);
        Path parent = target.getParent();
        if (parent != null) Files.createDirectories(parent);
        Path tmp = Files.createTempFile(parent, ".gwork-change-", ".tmp");
        try {
            Files.write(tmp, bytes);
            moveAtomic(tmp, target);
        } finally {
            Files.deleteIfExists(tmp);
        }
    }

    private void markIncompleteQuietly(String sessionId, String runId, String root, String reason) {
        try {
            Path safeRoot = validateRoot(root);
            Map<String, Object> snapshot;
            synchronized (lockFor(sessionId, runId, safeRoot)) {
                Manifest manifest = load(sessionId, runId, safeRoot);
                manifest.possiblyIncomplete = true;
                // 走 addReason 而不是就地 add：该列表随每个变更帧广播给前端，必须有去重与硬上限，
                // 否则一次长 run 里几十次快照失败就能把它撑到几十条并撑破卡片
                addReason(manifest, reason);
                manifest.lastStatus = "INCOMPLETE";
                touchAndSave(manifest, safeRoot);
                snapshot = summary(manifest);
            }
            publish(sessionId, runId, snapshot);
        } catch (Throwable e) {
            LOG.warn("[FileChanges] could not persist incomplete marker, session={}, run={}: {}",
                    sessionId, runId, message(e));
        }
    }

    @SuppressWarnings("unchecked")
    private Manifest load(String sessionId, String runId, Path root) throws IOException {
        validateId("sessionId", sessionId);
        validateId("runId", runId);
        Path file = manifestFile(root, sessionId, runId);
        if (!Files.exists(file)) return new Manifest(sessionId, runId, root.toString());
        try {
            Map<String, Object> map = ONode.ofJson(Files.readString(file, StandardCharsets.UTF_8)).toBean(Map.class);
            // 路径已按请求 session/run 定位；再核对内容，防止被替换/误搬的 manifest 冒充另一轮。
            if (!sessionId.equals(stringValue(map.get("sessionId"), null))
                    || !runId.equals(stringValue(map.get("runId"), null))) {
                throw new IOException("Manifest identity mismatch");
            }
            Manifest manifest = new Manifest(sessionId, runId, root.toString());
            manifest.revision = longValue(map.get("revision"));
            manifest.ready = Boolean.TRUE.equals(map.get("ready"));
            manifest.possiblyIncomplete = Boolean.TRUE.equals(map.get("possiblyIncomplete"));
            manifest.lastStatus = stringValue(map.get("lastStatus"), "CAPTURED");
            Object reasons = map.get("incompleteReasons");
            if (reasons instanceof List) for (Object v : (List<?>) reasons) manifest.incompleteReasons.add(String.valueOf(v));
            Object conflicts = map.get("conflicts");
            if (conflicts instanceof List) manifest.conflicts = new ArrayList<>((List<Map<String, Object>>) conflicts);
            Object entries = map.get("entries");
            if (entries instanceof List) {
                for (Object value : (List<?>) entries) {
                    if (!(value instanceof Map)) continue;
                    Map<String, Object> row = (Map<String, Object>) value;
                    Entry entry = new Entry(String.valueOf(row.get("path")),
                            stateFrom((Map<String, Object>) row.get("before")),
                            stateFrom((Map<String, Object>) row.get("after")));
                    entry.undone = Boolean.TRUE.equals(row.get("undone"));
                    entry.additions = intValue(row.get("additions"), -1);
                    entry.deletions = intValue(row.get("deletions"), -1);
                    manifest.entries.put(entry.path, entry);
                }
            }
            return manifest;
        } catch (Throwable e) {
            throw new IOException("Manifest is unreadable", e);
        }
    }

    private void touchAndSave(Manifest manifest, Path root) throws IOException {
        // 先把行数统计算完再落盘，避免将占位值 -1 归一为 0 后永不重算。
        for (Entry entry : manifest.entries.values()) ensureLineStats(root, entry);
        manifest.revision++;
        manifest.updatedAt = Instant.now().toEpochMilli();
        Path file = manifestFile(root, manifest.sessionId, manifest.runId);
        Files.createDirectories(file.getParent());
        Path tmp = Files.createTempFile(file.getParent(), manifest.runId + "-", ".tmp");
        try {
            Files.writeString(tmp, ONode.serialize(manifestMap(manifest)), StandardCharsets.UTF_8);
            moveAtomic(tmp, file);
        } finally {
            Files.deleteIfExists(tmp);
        }
    }

    private Map<String, Object> manifestMap(Manifest manifest) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("version", MANIFEST_VERSION);
        map.put("sessionId", manifest.sessionId);
        map.put("runId", manifest.runId);
        map.put("revision", manifest.revision);
        map.put("ready", manifest.ready);
        map.put("possiblyIncomplete", manifest.possiblyIncomplete);
        map.put("incompleteReasons", manifest.incompleteReasons);
        map.put("lastStatus", manifest.lastStatus);
        map.put("conflicts", manifest.conflicts);
        map.put("updatedAt", manifest.updatedAt);
        List<Map<String, Object>> entries = new ArrayList<>();
        for (Entry entry : manifest.entries.values()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("path", entry.path);
            row.put("before", stateMap(entry.before));
            row.put("after", stateMap(entry.after));
            row.put("undone", entry.undone);
            if (entry.additions >= 0) row.put("additions", entry.additions);
            if (entry.deletions >= 0) row.put("deletions", entry.deletions);
            entries.add(row);
        }
        map.put("entries", entries);
        return map;
    }

    /** API/流使用的轻量摘要：不包含绝对路径、内容或 blob hash。 */
    private Map<String, Object> summary(Manifest manifest) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("status", manifest.lastStatus);
        map.put("sessionId", manifest.sessionId);
        map.put("runId", manifest.runId);
        map.put("revision", manifest.revision);
        map.put("ready", manifest.ready);
        map.put("possiblyIncomplete", manifest.possiblyIncomplete);
        map.put("incompleteReasons", new ArrayList<>(manifest.incompleteReasons));
        map.put("conflicts", new ArrayList<>(manifest.conflicts));
        map.put("updatedAt", manifest.updatedAt);
        Path root = manifestRoot(manifest);
        List<Map<String, Object>> files = new ArrayList<>();
        long additions = 0;
        long deletions = 0;
        boolean anyApplied = false;
        boolean anyUndone = false;
        for (Entry entry : manifest.entries.values()) {
            ensureLineStats(root, entry);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("path", entry.path);
            row.put("changeType", entry.changeType());
            row.put("binary", entry.before.binary || entry.after.binary);
            row.put("state", entry.undone ? "UNDONE" : "APPLIED");
            row.put("additions", entry.additions);
            row.put("deletions", entry.deletions);
            additions += entry.additions;
            deletions += entry.deletions;
            if (entry.undone) anyUndone = true; else anyApplied = true;
            files.add(row);
        }
        map.put("files", files);
        map.put("fileCount", files.size());
        map.put("additions", additions);
        map.put("deletions", deletions);
        map.put("runApplyState", !anyUndone ? "FULLY_APPLIED" : (anyApplied ? "PARTIALLY_UNDONE" : "FULLY_UNDONE"));
        return map;
    }

    private Path manifestRoot(Manifest manifest) {
        try {
            return manifest.root == null ? null : Path.of(manifest.root);
        } catch (Throwable e) {
            return null;
        }
    }

    /** 惰性补齐行数统计；任何失败都记 0，绝不影响摘要发布。 */
    private void ensureLineStats(Path root, Entry entry) {
        if (entry.additions >= 0 && entry.deletions >= 0) return;
        entry.additions = 0;
        entry.deletions = 0;
        if (root == null) return;
        if (entry.before.binary || entry.after.binary) return;
        if (entry.before.contentSkipped || entry.after.contentSkipped) return;
        try {
            List<String> before = entry.before.exists ? splitLines(decodeBlob(root, entry.before)) : Collections.emptyList();
            List<String> after = entry.after.exists ? splitLines(decodeBlob(root, entry.after)) : Collections.emptyList();
            if (!entry.before.exists) {
                entry.additions = after.size();
                return;
            }
            if (!entry.after.exists) {
                entry.deletions = before.size();
                return;
            }
            int[] stats = lineDelta(before, after);
            entry.additions = stats[0];
            entry.deletions = stats[1];
        } catch (Throwable e) {
            entry.additions = 0;
            entry.deletions = 0;
            LOG.debug("[FileChanges] line stats unavailable for {}: {}", entry.path, message(e));
        }
    }

    /** MODIFIED 的增删行：规模可控时用 LCS，超限降级为按行多重集差异（O(n)）。 */
    private static int[] lineDelta(List<String> before, List<String> after) {
        int start = 0;
        int beforeEnd = before.size();
        int afterEnd = after.size();
        while (start < beforeEnd && start < afterEnd && before.get(start).equals(after.get(start))) start++;
        while (beforeEnd > start && afterEnd > start && before.get(beforeEnd - 1).equals(after.get(afterEnd - 1))) {
            beforeEnd--;
            afterEnd--;
        }
        List<String> a = before.subList(start, beforeEnd);
        List<String> b = after.subList(start, afterEnd);
        if (a.isEmpty()) return new int[]{b.size(), 0};
        if (b.isEmpty()) return new int[]{0, a.size()};
        if (a.size() > MAX_DIFF_LINES || b.size() > MAX_DIFF_LINES
                || (long) a.size() * (long) b.size() > MAX_DIFF_CELLS) {
            return multisetDelta(a, b);
        }
        int[] prev = new int[b.size() + 1];
        int[] cur = new int[b.size() + 1];
        for (int i = 1; i <= a.size(); i++) {
            String ai = a.get(i - 1);
            for (int j = 1; j <= b.size(); j++) {
                cur[j] = ai.equals(b.get(j - 1)) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
            }
            int[] swap = prev;
            prev = cur;
            cur = swap;
            cur[0] = 0;
        }
        int common = prev[b.size()];
        return new int[]{b.size() - common, a.size() - common};
    }

    private static int[] multisetDelta(List<String> a, List<String> b) {
        Map<String, Integer> counts = new java.util.HashMap<>();
        for (String line : a) counts.merge(line, 1, Integer::sum);
        int additions = 0;
        for (String line : b) {
            Integer left = counts.get(line);
            if (left == null || left == 0) additions++;
            else counts.put(line, left - 1);
        }
        int deletions = 0;
        for (Integer left : counts.values()) deletions += left;
        return new int[]{additions, deletions};
    }

    private static List<String> splitLines(String text) {
        if (text.isEmpty()) return Collections.emptyList();
        List<String> lines = new ArrayList<>();
        int from = 0;
        for (int i = 0; i < text.length(); i++) {
            if (text.charAt(i) == '\n') {
                String line = text.substring(from, i);
                if (!line.isEmpty() && line.charAt(line.length() - 1) == '\r') line = line.substring(0, line.length() - 1);
                lines.add(line);
                from = i + 1;
            }
        }
        if (from < text.length()) lines.add(text.substring(from));
        return lines;
    }

    private Map<String, Object> operationResult(String status, List<Map<String, Object>> conflicts,
                                                 Manifest manifest, Map<String, Object> detail) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("status", status);
        map.put("conflicts", conflicts);
        if (detail != null) map.put("error", detail);
        map.put("summary", summary(manifest));
        return map;
    }

    private Map<String, Object> errorResult(String status, String message) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("status", status);
        map.put("conflicts", Collections.emptyList());
        map.put("message", message);
        map.put("summary", null);
        return map;
    }

    /** 必须在锁外调用：只投递已算好的摘要快照。 */
    private void publish(String sessionId, String runId, Map<String, Object> snapshot) {
        Listener current = listener;
        if (current != null && snapshot != null) {
            try {
                current.onChanged(sessionId, runId, snapshot);
            } catch (Throwable e) {
                LOG.warn("[FileChanges] listener failed, session={}, run={}: {}", sessionId, runId, message(e));
            }
        }
    }

    private FileState readState(Path path) throws IOException {
        if (!Files.exists(path)) return FileState.absent();
        if (!Files.isRegularFile(path)) throw new IOException("Path is not a regular file");
        if (Files.size(path) > MAX_CONTENT_BYTES) {
            // 超大文件只算 hash，不留存内容，以免占满内存与磁盘。
            return new FileState(true, sha256Stream(path), true, null, true, null);
        }
        byte[] bytes = Files.readAllBytes(path);
        DecodedText decoded = decodeText(bytes);
        return new FileState(true, sha256(bytes), decoded == null, bytes, false,
                decoded == null ? null : decoded.charset.name());
    }

    private void persistBlob(Path root, FileState state) throws IOException {
        if (!state.exists || state.bytes == null || state.contentSkipped) return;
        Path blob = blobFile(root, state.hash);
        if (Files.exists(blob)) return;
        Files.createDirectories(blob.getParent());
        Path tmp = Files.createTempFile(blob.getParent(), "blob-", ".tmp");
        try {
            Files.write(tmp, state.bytes);
            if (!Files.exists(blob)) moveAtomic(tmp, blob);
        } finally {
            Files.deleteIfExists(tmp);
        }
    }

    private byte[] readBlob(Path root, String hash) throws IOException {
        if (hash == null || !hash.matches("[0-9a-f]{64}")) throw new IOException("Invalid blob reference");
        Path blobs = root.resolve(STORE_DIR).resolve("blobs").normalize();
        Path file = blobs.resolve(hash).normalize();
        if (!file.startsWith(blobs)) throw new SecurityException("Blob path escapes store");
        return Files.readAllBytes(file);
    }

    /**
     * 读回 blob 并按文本解码。
     *
     * <p>解码口径必须与写入时的文本识别完全一致：先严格 UTF-8，失败再按同一顺序试遗留编码。
     * 否则会出现「写入时判成文本、读取时却解不开」的自相矛盾——diff 接口对 GBK 文件直接报错。</p>
     */
    private String decodeBlob(Path root, FileState state) throws IOException {
        byte[] bytes = readBlob(root, state.hash);
        if (state.charset != null) {
            Charset charset = charsetOrNull(state.charset);
            if (charset != null) {
                try {
                    return decodeStrict(bytes, charset);
                } catch (CharacterCodingException e) {
                    throw new IOException("Blob is not decodable with its recorded charset", e);
                }
            }
        }
        // 旧 manifest 没有 charset 字段：按原候选顺序自动识别，保持向后兼容。
        DecodedText decoded = decodeText(bytes);
        if (decoded != null) return decoded.text;
        throw new IOException("Blob is not decodable text");
    }

    private static String decodeStrict(byte[] bytes, Charset cs) throws CharacterCodingException {
        return cs.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(java.nio.ByteBuffer.wrap(bytes)).toString();
    }

    private Path blobFile(Path root, String hash) {
        return root.resolve(STORE_DIR).resolve("blobs").resolve(hash).normalize();
    }

    private Path manifestFile(Path root, String sessionId, String runId) {
        return root.resolve(STORE_DIR).resolve("manifests")
                .resolve(safeSegment(sessionId)).resolve(safeSegment(runId) + ".json").normalize();
    }

    private Path validateRoot(String root) throws IOException {
        if (root == null || root.trim().isEmpty() || root.indexOf('\0') >= 0) {
            throw new IllegalArgumentException("A workspace root is required");
        }
        Path path = Path.of(root).toAbsolutePath().normalize();
        if (!Files.isDirectory(path)) throw new IllegalArgumentException("Workspace root does not exist");
        return path.toRealPath();
    }

    private Path validateRelativePath(Path root, String filePath) throws IOException {
        if (filePath == null || filePath.trim().isEmpty() || filePath.indexOf('\0') >= 0) {
            throw new IllegalArgumentException("A relative file path is required");
        }
        String trimmed = filePath.trim();
        // 逻辑挂载路径（@alias/...）与 ~ 路径不能按 root 相对路径解析，否则会得到不存在的假目标。
        if (trimmed.charAt(0) == '@' || trimmed.charAt(0) == '~') {
            throw new IllegalArgumentException("Logical or home-relative paths are not tracked: " + safePath(trimmed));
        }
        Path supplied = Path.of(trimmed);
        Path target;
        if (supplied.isAbsolute()) {
            // TerminalSupport 在非沙箱下允许给绝对路径。若它本就指向工作区内部，则本可追踪，
            // 直接拒绝会白丢一条可撑销记录（降级为 possiblyIncomplete）；只有真正越出 root 才拒绝。
            target = supplied.normalize();
            if (!target.startsWith(root)) {
                throw new IllegalArgumentException("Absolute paths outside the workspace root are not tracked: "
                        + safePath(trimmed));
            }
        } else {
            target = root.resolve(supplied).normalize();
        }
        if (!target.startsWith(root) || target.equals(root)) throw new SecurityException("File path escapes workspace root");
        Path existing = target;
        while (existing != null && !Files.exists(existing)) existing = existing.getParent();
        if (existing != null && !existing.toRealPath().startsWith(root)) throw new SecurityException("File path escapes workspace root through a link");
        return target;
    }

    private void validateId(String name, String value) {
        if (value == null || value.isEmpty()) throw new IllegalArgumentException("Invalid " + name);
    }

    /**
     * sessionId/runId 要做目录名，而 IM 等通道的 sessionId 可能带 ':' 等 Windows 非法字符
     * （如 wx:12345），旧黑名单校验放行后会在建目录时抛异常，导致整个 run 跟踪静默失效。
     * 改为白名单：安全字符原样保留（保持可读与向后兼容），否则整体 hash 兜底。
     */
    private static String safeSegment(String value) {
        boolean clean = true;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '.' || c == '_' || c == '-';
            if (!ok) {
                clean = false;
                break;
            }
        }
        // "." / ".." 本身字符合法但语义危险，一律走 hash
        if (clean && !".".equals(value) && !"..".equals(value)) {
            return value;
        }
        return "h_" + sha256(value.getBytes(StandardCharsets.UTF_8)).substring(0, 32);
    }

    /**
     * 把账本目录写进 {@code <root>/.git/info/exclude}（<b>不碰</b>用户的 .gitignore）。
     *
     * <p>账本落在用户工作区根的 {@code .gwork/file-changes} 下，里面是含文件全文的 blob。
     * 本仓库自己的 .gitignore 里有 {@code .gwork/}，但用户自己的任意项目不一定有这条规则
     * ——于是一次 {@code git add .} 就能把撤销快照提交进用户仓库。</p>
     *
     * <p>选 .git/info/exclude 而不是 .gitignore：效果等同于 ignore，但它是本地私有的、
     * 不会被提交、也不会污染用户版本管理中的文件。</p>
     *
     * <p>每 root 每进程只做一次。任何失败只 WARN：这只是防呆，绝不能反过来阱断账本功能。</p>
     */
    private void ensureStoreExcluded(Path root) {
        if (!excludeWrittenRoots.add(root.toString())) {
            return;
        }
        try {
            Path gitDir = root.resolve(".git");
            // worktree/submodule 形态下 .git 是个文件而不是目录，此时不猜它的 gitdir 指向，直接跳过
            if (!Files.isDirectory(gitDir)) {
                return;
            }
            Path info = gitDir.resolve("info");
            Files.createDirectories(info);
            Path exclude = info.resolve("exclude");

            String entry = STORE_DIR + "/";
            List<String> lines = Files.exists(exclude)
                    ? Files.readAllLines(exclude, StandardCharsets.UTF_8)
                    : new ArrayList<>();
            for (String line : lines) {
                String trimmed = line.trim();
                // 已被忽略就不再写：包括用户自己写的更宽规则（.gwork/ 或 .gwork）
                if (trimmed.equals(entry) || trimmed.equals(STORE_DIR) || trimmed.equals(".gwork/")) {
                    return;
                }
            }

            StringBuilder out = new StringBuilder();
            for (String line : lines) {
                out.append(line).append('\n');
            }
            if (out.length() > 0) {
                out.append('\n');
            }
            out.append("# GWork \u6587\u4ef6\u53d8\u66f4\u8d26\u672c\uff08\u64a4\u9500\u5feb\u7167\uff0c\u542b\u6587\u4ef6\u5168\u6587\uff09\uff0c\u4e0d\u5e94\u8fdb\u7248\u672c\u5e93\n");
            out.append(entry).append('\n');

            Files.writeString(exclude, out.toString(), StandardCharsets.UTF_8);
            LOG.info("[FileChanges] added {} to {} so undo snapshots are never committed", entry, exclude);
        } catch (Throwable e) {
            LOG.warn("[FileChanges] could not update .git/info/exclude under {}: {}", root, message(e));
        }
    }

    private Object lockFor(String sessionId, String runId, Path root) {
        // 固定分片，不做 computeIfAbsent：见 lockStripes 字段注释里的无界增长与互斥失效两条理由
        return lockStripes[Math.floorMod(lockKey(sessionId, runId, root).hashCode(), LOCK_STRIPES)];
    }

    private static String lockKey(String sessionId, String runId, Path root) {
        return root + "\u0001" + sessionId + "\u0001" + runId;
    }

    private static void moveAtomic(Path source, Path target) throws IOException {
        try {
            Files.move(source, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(source, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private static String sha256(byte[] bytes) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder out = new StringBuilder(64);
            for (byte b : digest) out.append(String.format("%02x", b & 0xff));
            return out.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String sha256Stream(Path path) throws IOException {
        try (java.io.InputStream in = Files.newInputStream(path)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[65536];
            int read;
            while ((read = in.read(buffer)) > 0) digest.update(buffer, 0, read);
            StringBuilder out = new StringBuilder(64);
            for (byte b : digest.digest()) out.append(String.format("%02x", b & 0xff));
            return out.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * NUL 字节为主判据；解码判据只抽样前 8KB，但允许末尾不完整的多字节序列，
     * 避免大于 8KB 的中文文本因边界截断被误判为二进制。
     *
     * <p><b>UTF-8 失败后还要再试遗留编码</b>：旧实现在此之上只做严格 UTF-8 校验，于是
     * GBK/ANSI 编码的中文文件（中文 Windows 上的遗留文本文件极常见）会被判成二进制——
     * 前端只显示「二进制文件无法预览」，diff 审查能力对这批用户完全失效。</p>
     */
    private static DecodedText decodeText(byte[] bytes) {
        for (byte value : bytes) if (value == 0) return null;
        Charset[] candidates = new Charset[FALLBACK_TEXT_CHARSETS.length + 1];
        candidates[0] = StandardCharsets.UTF_8;
        for (int i = 0; i < FALLBACK_TEXT_CHARSETS.length; i++) {
            candidates[i + 1] = charsetOrNull(FALLBACK_TEXT_CHARSETS[i]);
        }
        for (Charset charset : candidates) {
            if (charset == null) continue;
            try {
                String text = decodeStrict(bytes, charset);
                if (hasDisallowedControl(text)) continue;
                return new DecodedText(text, charset);
            } catch (CharacterCodingException ignored) {
                // 试下一个候选编码
            }
        }
        return null;
    }

    private static boolean hasDisallowedControl(String text) {
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c < 0x20 && c != '\t' && c != '\n' && c != '\r' && c != '\f') return true;
        }
        return false;
    }

    /** 精简 JRE 可能没装某个 charset，拿不到就跳过而不是让整个判定炸掉。 */
    private static Charset charsetOrNull(String name) {
        try {
            return Charset.forName(name);
        } catch (Throwable e) {
            return null;
        }
    }

    private static boolean same(FileState a, FileState b) {
        return a.exists == b.exists && (!a.exists || Objects.equals(a.hash, b.hash));
    }

    private static String normalizeRelative(Path path) {
        return path.toString().replace('\\', '/');
    }

    private static String safePath(String path) {
        return path == null ? "<null>" : path.replace('\n', ' ').replace('\r', ' ');
    }

    private static String message(Throwable e) {
        return e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
    }

    /**
     * 面向用户的异常文案：去掉其中的服务端绝对路径。
     *
     * <p>本类的失败文案会经 operationResult → HTTP 响应 → 前端 toast 直接展示给用户
     * （app-file-changes.js 把 error.message 原样贴出来）。而 Files.readAllBytes / Files.size /
     * touchAndSave 抛出的 IOException，其 message 里带着<b>服务端安装目录的完整绝对路径</b>
     * （形如「D:\\Apps\\GWork\\... (系统找不到指定的文件。)」），这既对用户无意义，
     * 也白送了部署拓扑信息。root 前缀统一换成 {@code <workspace>}，保留相对部分便于定位。</p>
     *
     * @param root 已校验的工作区根；为 null 时只做换行清洗
     */
    private static String safeMessage(Throwable e, Path root) {
        String msg = message(e);
        if (root != null) {
            msg = msg.replace(root.toString(), "<workspace>");
        }
        return msg.replace('\n', ' ').replace('\r', ' ');
    }

    private static long longValue(Object value) {
        if (value instanceof Number) return ((Number) value).longValue();
        try { return value == null ? 0 : Long.parseLong(String.valueOf(value)); }
        catch (NumberFormatException e) { return 0; }
    }

    private static String stringValue(Object value, String fallback) {
        return value == null ? fallback : String.valueOf(value);
    }

    private static int intValue(Object value, int fallback) {
        if (value instanceof Number) return ((Number) value).intValue();
        if (value == null) return fallback;
        try { return Integer.parseInt(String.valueOf(value)); }
        catch (NumberFormatException e) { return fallback; }
    }

    private static Map<String, Object> stateMap(FileState state) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("exists", state.exists);
        map.put("hash", state.hash);
        map.put("binary", state.binary);
        map.put("contentSkipped", state.contentSkipped);
        if (state.charset != null) map.put("charset", state.charset);
        return map;
    }

    private static FileState stateFrom(Map<String, Object> map) {
        if (map == null || !Boolean.TRUE.equals(map.get("exists"))) return FileState.absent();
        return new FileState(true, String.valueOf(map.get("hash")), Boolean.TRUE.equals(map.get("binary")), null,
                Boolean.TRUE.equals(map.get("contentSkipped")), stringValue(map.get("charset"), null));
    }

    /** 有界缓存：超过上限时淘汰最老条目（按插入序，非访问序——幂等重放不需要 LRU 语义）。 */
    private static final class OperationCache extends LinkedHashMap<String, Map<String, Object>> {
        private static final long serialVersionUID = 1L;

        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Map<String, Object>> eldest) {
            return size() > MAX_OPERATION_CACHE;
        }
    }

    public interface Listener {
        void onChanged(String sessionId, String runId, Map<String, Object> summary);
    }

    public static final class Capture {
        private final String sessionId;
        private final String runId;
        private final String rootText;
        private final String filePath;
        private Path root;
        private Path path;
        private String relativePath;
        private FileState before;
        private String error;

        private Capture(String sessionId, String runId, String root, String filePath) {
            this.sessionId = sessionId;
            this.runId = runId;
            this.rootText = root;
            this.filePath = filePath;
        }
    }

    private enum Direction { UNDO, REAPPLY }

    private static final class Manifest {
        private final String sessionId;
        private final String runId;
        private final String root;
        private long revision;
        private boolean ready;
        private boolean possiblyIncomplete;
        private List<String> incompleteReasons = new ArrayList<>();
        private String lastStatus = "CAPTURED";
        private List<Map<String, Object>> conflicts = new ArrayList<>();
        private long updatedAt;
        private final Map<String, Entry> entries = new LinkedHashMap<>();

        private Manifest(String sessionId, String runId, String root) {
            this.sessionId = sessionId;
            this.runId = runId;
            this.root = root;
        }
    }

    private static final class Entry {
        private final String path;
        private final FileState before;
        private final FileState after;
        private boolean undone;
        /** -1 表示尚未统计（惰性计算）。 */
        private int additions = -1;
        private int deletions = -1;

        private Entry(String path, FileState before, FileState after) {
            this.path = path;
            this.before = before;
            this.after = after;
        }

        private String changeType() {
            if (!before.exists) return "ADDED";
            if (!after.exists) return "DELETED";
            return "MODIFIED";
        }
    }

    private static final class FileState {
        private final boolean exists;
        private final String hash;
        private final boolean binary;
        private final transient byte[] bytes;
        /** 超大文件：只有 hash，内容未留存，不可恢复。 */
        private final boolean contentSkipped;
        /** 实际成功解码所用字符集；旧 manifest 缺失时读取侧自动识别。 */
        private final String charset;

        private FileState(boolean exists, String hash, boolean binary, byte[] bytes, boolean contentSkipped, String charset) {
            this.exists = exists;
            this.hash = hash;
            this.binary = binary;
            this.bytes = bytes;
            this.contentSkipped = contentSkipped;
            this.charset = charset;
        }

        private static FileState absent() {
            return new FileState(false, null, false, null, false, null);
        }
    }

    private static final class DecodedText {
        private final String text;
        private final Charset charset;

        private DecodedText(String text, Charset charset) {
            this.text = text;
            this.charset = charset;
        }
    }

    private static final class Backup {
        private final Path path;
        private final FileState state;

        private Backup(Path path, FileState state) {
            this.path = path;
            this.state = state;
        }
    }
}
