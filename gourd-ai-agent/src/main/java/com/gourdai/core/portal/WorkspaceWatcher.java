package com.gourdai.core.portal;

import org.noear.snack4.ONode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;

import static java.nio.file.StandardWatchEventKinds.*;

/**
 * 工作区文件变化监听器
 *
 * <p>基于 JDK {@link WatchService} 监控工作区目录树的新增、删除、修改事件，
 * 经去重防抖后，通过注册的广播处理器将 {@code filer_change} 事件推送到前端，
 * 实现文件树的实时同步。</p>
 *
 * <h3>核心流程</h3>
 * <pre>
 *   磁盘文件变化 → WatchService 捕获 → changedPaths 汇聚
 *       → flushChanges() 去重防抖 → ONode 构建 JSON → 广播处理器分发
 * </pre>
 *
 * <h3>注意事项</h3>
 * <ul>
 *   <li>自动排除 .git、node_modules、target 等无关目录（点前缀文件正常监听）</li>
 *   <li>新增目录时自动注册监听，覆盖子树</li>
 *   <li>使用守护线程，随主进程退出</li>
 *   <li>事件轮询线程与注册调度线程相互独立，动态 addRoot 的注册任务不会被事件轮询阻塞</li>
 *   <li>OVERFLOW 事件（context 为 null）直接跳过，不会杀死轮询线程</li>
 * </ul>
 */
public class WorkspaceWatcher {
    private static final Logger LOG = LoggerFactory.getLogger(WorkspaceWatcher.class);

    /** 需要排除的目录名（不监听、不同步）；与 FileService 的排除清单保持一致 */
    private static final Set<String> EXCLUDED_DIRS = new HashSet<>(Arrays.asList(
            // 项目元数据 & IDE
                ".gwork", ".gwork-remote", ".gourdai", ".claude", ".opencode",
            ".idea", ".vscode", ".settings",
            // 版本控制 & 构建工具
            ".git", ".gradle", ".mvn",
            // 运行时缓存
            ".pytest_cache", "__pycache__",
            ".DS_Store",
            // 依赖目录
            "node_modules", "venv", "vendor",
            // 构建输出
            "target", "build"
    ));

    /** 监听根路径集合（启动工作区 + 动态登记的 Code 项目根） */
    private final Set<Path> roots = ConcurrentHashMap.newKeySet();
    /** 已真正注册进 WatchService 的根目录树（防重复注册；注册失败会回退移除以允许重试） */
    private final Set<Path> registered = ConcurrentHashMap.newKeySet();
    /** start() 是否已完成初始化（WatchService/线程就绪；之后 addRoot 即时提交注册任务） */
    private volatile boolean started = false;
    /** start() 初始化是否失败（WatchService 不可用时 addRoot 仅登记不提交任务） */
    private volatile boolean initFailed = false;
    /** 广播处理器列表：接收 JSON 字符串并分发到前端 */
    private final List<Consumer<String>> broadcastHandlers = new ArrayList<>();
    private WatchService watchService;
    private ScheduledExecutorService scheduler;

    /** 待推送的变更路径集合（去重、线程安全） */
    private final Set<String> changedPaths = ConcurrentHashMap.newKeySet();

    /**
     * @param workspace 工作区根目录
     */
    public WorkspaceWatcher(Path workspace) {
        if (workspace != null) {
            this.roots.add(workspace.toAbsolutePath().normalize());
        }
    }

    /**
     * 动态添加监听根（如 Code 模式当前选择的项目目录）。
     *
     * <p>可在 {@link #start()} 前后任意时刻调用：启动前仅登记到 roots，
     * 由 {@link #start()} 补注册；启动后立即提交目录树注册任务。
     * 对已注册的根重复调用自动忽略（幂等）。</p>
     *
     * @param root 新的监听根目录，null 忽略
     */
    public void addRoot(Path root) {
        if (root == null) return;
        Path normalized = root.toAbsolutePath().normalize();
        roots.add(normalized);
        // 已注册，或 WatchService 尚未就绪（未启动/初始化失败）：跳过。
        // 注意：不能因 roots.add 返回 false 就直接 return——启动前登记过的根
        // 可能从未真正注册进 WatchService，必须允许再次走到注册逻辑。
        if (registered.contains(normalized) || scheduler == null || !started || initFailed) return;
        submitRegister(normalized);
    }

    /**
     * 提交目录树注册任务：在独立的注册调度线程上串行执行。
     * 通过 registered 集合防重；注册失败时回退标记，允许下次 addRoot 重试。
     */
    private void submitRegister(Path root) {
        try {
            scheduler.submit(() -> {
                if (!registered.add(root)) return;
                try {
                    registerTree(root);
                    LOG.info("[WorkspaceWatcher] added root: {}", root);
                } catch (Exception e) {
                    registered.remove(root);
                    LOG.error("[WorkspaceWatcher] add root failed: {}", e.getMessage(), e);
                }
            });
        } catch (RejectedExecutionException e) {
            LOG.warn("[WorkspaceWatcher] watcher stopped, skip registering root: {}", root);
        }
    }

    /**
     * 注册广播处理器，用于将变更事件推送到前端
     *
     * @param handler 接收 JSON 字符串的消费者
     */
    public WorkspaceWatcher addBroadcastHandler(Consumer<String> handler) {
        this.broadcastHandlers.add(handler);
        return this;
    }

    /**
     * 启动文件监听：初始化 WatchService、开启独立轮询线程、异步注册目录树
     *
     * <p>线程模型：事件轮询（{@link #pollEvents}，永久阻塞循环）运行在独立守护线程上，
     * scheduler 专职执行目录树注册任务。严禁把 pollEvents 提交进 scheduler——
     * 否则会永久独占单线程调度器，addRoot 的注册任务被饿死，新增根永远无法被真正监听。</p>
     *
     * <p>目录树注册（{@link #registerTree}）可能在大工作区下耗时较长，
     * 全部在注册调度线程上异步串行执行，不阻塞主线程。</p>
     */
    public void start() {
        try {
            watchService = FileSystems.getDefault().newWatchService();
            scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "workspace-watcher-register");
                t.setDaemon(true);
                return t;
            });

            // 独立轮询线程：pollEvents 内含 watchService.take() 永久阻塞循环，必须独占线程
            Thread pollThread = new Thread(this::pollEvents, "workspace-watcher-poll");
            pollThread.setDaemon(true);
            pollThread.start();

            started = true;
            // 初始根全部进注册队列串行注册；启动过程中经 addRoot 动态登记的根
            // （当时 started 尚为 false 未能自行提交）也在此被统一补注册，消除启动竞态
            for (Path root : roots) {
                submitRegister(root);
            }
            LOG.info("[WorkspaceWatcher] started for: {}", roots);
        } catch (Exception e) {
            initFailed = true;
            LOG.error("[WorkspaceWatcher] start failed: {}", e.getMessage(), e);
        }
    }

    /**
     * 停止监听：关闭调度器和 WatchService
     */
    public void stop() {
        try {
            if (scheduler != null) scheduler.shutdownNow();
            if (watchService != null) watchService.close();
        } catch (Exception e) {
            LOG.warn("[WorkspaceWatcher] stop error: {}", e.getMessage());
        }
    }

    /**
     * 递归注册目录树到 WatchService（排除无关目录）
     */
    private void registerTree(Path dir) throws Exception {
        Files.walkFileTree(dir, new SimpleFileVisitor<Path>() {
            @Override
            public FileVisitResult preVisitDirectory(Path d, BasicFileAttributes attrs) {
                String name = d.getFileName() != null ? d.getFileName().toString() : "";
                // 仅按排除清单跳过（不再一刀切忽略点前缀目录，保证 .github 等可见目录可被监听）
                if (EXCLUDED_DIRS.contains(name)) {
                    return FileVisitResult.SKIP_SUBTREE;
                }
                try {
                    d.register(watchService, ENTRY_CREATE, ENTRY_DELETE, ENTRY_MODIFY);
                } catch (Exception ignored) {
                }
                return FileVisitResult.CONTINUE;
            }
        });
    }

    /**
     * 轮询 WatchService 事件，捕获文件变更并触发防抖推送
     *
     * <p>运行在独立轮询线程上：OVERFLOW 事件（{@code context()==null}）直接跳过，
     * 单个事件处理异常仅告警，不会中断整个轮询循环；
     * stop() 关闭 WatchService 时经 {@link ClosedWatchServiceException} 正常退出。</p>
     */
    private void pollEvents() {
        while (!Thread.currentThread().isInterrupted()) {
            WatchKey key;
            try {
                key = watchService.take();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            } catch (ClosedWatchServiceException e) {
                return; // watchService 已被 stop() 关闭，正常退出
            }

            try {
                Path dir = (Path) key.watchable();
                for (WatchEvent<?> event : key.pollEvents()) {
                    // OVERFLOW 事件的 context() 为 null，直接跳过，避免 NPE 杀死轮询线程
                    if (event.kind() == OVERFLOW) continue;
                    Object context = event.context();
                    if (!(context instanceof Path)) continue;
                    try {
                        Path fullPath = dir.resolve((Path) context);

                        if (shouldIgnore(fullPath)) continue;

                        String relativePath = relativizeAny(fullPath).toString().replace('\\', '/');
                        changedPaths.add(relativePath);

                        if (event.kind() == ENTRY_CREATE && fullPath.toFile().isDirectory()) {
                            try {
                                fullPath.register(watchService, ENTRY_CREATE, ENTRY_DELETE, ENTRY_MODIFY);
                            } catch (Exception ignored) {
                            }
                        }
                    } catch (Exception e) {
                        LOG.warn("[WorkspaceWatcher] event handling error: {}", e.getMessage());
                    }
                }
            } finally {
                try {
                    key.reset();
                } catch (Exception ignored) {
                }
            }
            flushChanges();
        }
    }

    /**
     * 判断路径是否应忽略（排除目录下的文件；点前缀文件不忽略，与文件树展示规则一致）
     */
    private boolean shouldIgnore(Path path) {
        for (Path segment : relativizeAny(path)) {
            String name = segment.toString();
            if (EXCLUDED_DIRS.contains(name)) return true;
        }
        return false;
    }

    /** 计算路径相对其所属监听根的相对路径（变更事件可能来自任意根；根嵌套时取最长前缀，保证相对路径最短且无歧义） */
    private Path relativizeAny(Path path) {
        Path best = null;
        for (Path root : roots) {
            if (path.startsWith(root) && (best == null || root.getNameCount() > best.getNameCount())) {
                best = root;
            }
        }
        if (best != null) return best.relativize(path);
        return path.getFileName() != null ? path.getFileName() : path;
    }


    /**
     * 将累积的变更路径构建为 JSON 并广播到所有处理器
     *
     * <p>JSON 格式：
     * <pre>{
     *   "type": "filer_change",
     *   "changes": ["src/Foo.java", "lib/README.md"],
     *   "createdAt": 1716153600000
     * }</pre></p>
     */
    private void flushChanges() {
        if (changedPaths.isEmpty()) return;

        Set<String> batch = new LinkedHashSet<>(changedPaths);
        changedPaths.clear();

        ONode changes = new ONode().asArray();
        for (String p : batch) {
            changes.add(p);
        }

        String json = new ONode()
                .set("type", "filer_change")
                .set("changes", changes)
                .set("createdAt", System.currentTimeMillis())
                .toJson();

        for (Consumer<String> handler : broadcastHandlers) {
            handler.accept(json);
        }

        if (LOG.isDebugEnabled()) {
            LOG.debug("[WorkspaceWatcher] pushed {} changes", batch.size());
        }
    }
}