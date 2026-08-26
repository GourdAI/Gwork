/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.core.command.builtin;

import org.noear.snack4.Feature;
import org.noear.snack4.ONode;
import org.noear.snack4.Options;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.core.channel.Channel;
import com.gourdai.core.channel.ChannelRoutingTable;
import com.gourdai.core.portal.web.SessionLocator;
import org.noear.solon.scheduling.ScheduledAnno;
import org.noear.solon.scheduling.scheduled.manager.IJobManager;
import org.noear.solon.scheduling.simple.JobManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 定时循环任务调度管理器
 *
 * <p>职责：
 * <ol>
 *   <li>管理任务元数据的 JSON 持久化（load / save）</li>
 *   <li>通过 IJobManager 动态注册/移除调度</li>
 *   <li>支持进程重启后恢复未过期任务</li>
 * </ol>
 *
 * @author oisin
 * @since 3.9.1
 */
public class LoopScheduler {
    private static final Logger LOG = LoggerFactory.getLogger(LoopScheduler.class);
    private static final int MAX_TASKS_GLOBAL = 100; // 全局最大任务数
    private static final String TASKS_FILE = "loop-tasks.json";
    private static final String GLOBAL_TASKS_FILE = "global-loop-tasks.json"; // 全局任务文件

    private final HarnessEngine engine;

    // Solon 原生调度管理器
    private final IJobManager jobManager;

    // 全局任务列表：所有任务存储在这里
    private final List<LoopTask> globalTasks = Collections.synchronizedList(new ArrayList<>());

    // 会话级任务列表（已废弃，保留用于向后兼容迁移）
    @Deprecated
    private final ConcurrentHashMap<String, List<LoopTask>> sessionTasks = new ConcurrentHashMap<>();

    // CLI 端任务执行回调：sessionId, prompt, agentName -> void（同步阻塞）
    private volatile List<TaskExecutor> taskExecutors = new ArrayList<>();

    // 会话繁忙检查器：用于在定时触发时判断会话是否正在执行任务（由各端口注入）。
    // 用列表而非单值：Web 与 CLI 两端口会各自注入一个，单值会被后注入者覆盖，
    // 导致先注入端口的繁忙守卫失效。各 checker 已按 sessionId 前缀自过滤，OR 合并即可。
    private volatile List<BusyChecker> busyCheckers = new ArrayList<>();

    // Worktree 管理器（lazy init）
    private volatile WorktreeManager worktreeManager;

    // Worktree 目录名
    private final String worktreeDir;

    // IM 通道列表（用于通知推送）
    private volatile List<Channel> channels = new ArrayList<>();

    // 通道路由表（用于获取活跃会话）
    private volatile ChannelRoutingTable routingTable;

    // 工作空间路径（用于保存任务状态）
    private volatile String workspace;
    private volatile String harnessSessions;

    // restore 幂等标记：成功恢复过且全局任务文件未变化时，后续调用直接短路。
    // 会话列表接口会按扫描到的每个会话目录触发 restore，若无短路与加锁，
    // 并发 restore 的 clear/addAll 交错会把同一任务重复加入列表并持久化（任务列表出现重复项）。
    private final AtomicBoolean restored = new AtomicBoolean(false);

    // 全局任务文件最近一次加载/保存的 mtime 快照（供 restore 短路比较）
    private volatile long loadedFileMtime = -1L;

    /**
     * CLI 端任务执行器（同步阻塞）
     *
     * <p>支持指定 agent 名称。
     * 若 agentName 为 null，则使用默认主 agent。
     *
     * <p>返回 AI 的响应文本摘要，用于 goal 条件检查。
     * 若无法获取响应（如会话不匹配），返回 null。
     */
    @FunctionalInterface
    public interface TaskExecutor {
        /**
         * @param sessionId 会话 ID
         * @param prompt    提示词（已注入 goal 等上下文的有效提示词）
         * @param agentName 代理名称（可为 null，表示主 agent）
         * @param task      任务定义，携带执行上下文（工作空间 / 模型 / 思考档位 / 推送通道）
         * @return AI 响应文本摘要，无法获取时返回 null
         */
        String execute(String sessionId, String prompt, String agentName, LoopTask task);
    }

    /**
     * 会话繁忙检查器
     *
     * <p>用于在 loop 定时触发时判断目标会话是否有任务正在执行。
     * 若会话繁忙，则跳过本次触发，避免与前台任务并发冲突、向前端推送多余消息。
     */
    @FunctionalInterface
    public interface BusyChecker {
        /**
         * @param sessionId 会话 ID
         * @return true 表示会话正在执行任务
         */
        boolean isBusy(String sessionId);
    }


    /**
     * @param worktreeDir worktree 目录名（如 ".gwork/loop-worktrees"），null 时使用默认值
     */
    public LoopScheduler(HarnessEngine engine, String worktreeDir) {
        this.engine = engine;
        this.jobManager = JobManager.getInstance();
        this.worktreeDir = worktreeDir;
    }

    public void addTaskExecutor(TaskExecutor executor) {
        this.taskExecutors.add(executor);
    }

    /**
     * 注册会话繁忙检查器（由 WebController / CliShell 各自注入）。
     *
     * <p>采用追加语义而非覆盖：多个端口的 checker 共存，任一报告繁忙即视为繁忙。</p>
     */
    public void addBusyChecker(BusyChecker busyChecker) {
        if (busyChecker != null) {
            this.busyCheckers.add(busyChecker);
        }
    }

    /**
     * 注入 IM 通道列表（用于任务结果通知推送）
     */
    public void setChannels(List<Channel> channels) {
        this.channels = channels != null ? channels : new ArrayList<>();
    }

    /**
     * 注入通道路由表（用于获取通道的活跃会话）
     */
    public void setRoutingTable(ChannelRoutingTable routingTable) {
        this.routingTable = routingTable;
    }

    /**
     * 获取或创建 WorktreeManager（lazy init）
     */
    private WorktreeManager getWorktreeManager() {
        if (worktreeManager == null) {
            synchronized (this) {
                if (worktreeManager == null) {
                    worktreeManager = worktreeDir != null
                            ? new WorktreeManager(worktreeDir)
                            : new WorktreeManager();
                }
            }
        }
        return worktreeManager;
    }

    // ==================== 任务注册 ====================

    /**
     * 注册循环任务
     *
     * <p>流程：创建 LoopTask -> 注册到 IJobManager（cron / fixedDelay）-> 加入内存列表 -> 持久化到 JSON
     *
     * @param sessionId      会话 ID
     * @param task           待注册的任务
     * @return 已注册的任务
     */
    public LoopTask schedule(String sessionId, String workspace, String harnessSessions, LoopTask task) {
        synchronized (globalTasks) {
            // 1. 检查最大任务数（全局限制）
            if (globalTasks.size() >= MAX_TASKS_GLOBAL) {
                throw new IllegalStateException("Max global tasks reached: " + MAX_TASKS_GLOBAL);
            }

            // 2. 清理过期任务
            cleanExpiredGlobal(workspace, harnessSessions);

            // 3. 注册到 IJobManager（cron 模式用 cron 表达式，否则 fixedDelay 串行）
            //    firstRegistration=true，使 runNow 生效
            registerJob(sessionId, task, true);

            // 4. 加入全局列表
            globalTasks.add(task);

            // 5. 持久化到全局 JSON
            saveGlobalToFile(workspace, harnessSessions);

            return task;
        }
    }

    // ==================== 任务移除 ====================

    /**
     * 停止指定任务
     */
    public void remove(String sessionId, String workspace, String harnessSessions, String taskId) {
        synchronized (globalTasks) {
            globalTasks.removeIf(t -> {
                if (t.getId().equals(taskId)) {
                    t.cancel();
                    String jobName = t.getJobName();
                    if (jobManager.jobExists(jobName)) {
                        jobManager.jobRemove(jobName);
                    }
                    return true;
                }
                return false;
            });

            saveGlobalToFile(workspace, harnessSessions);
        }
    }

    /**
     * 启用/停用任务（toggle enabled 字段）
     */
    public void toggle(String sessionId, String workspace, String harnessSessions, String taskId) {
        synchronized (globalTasks) {
            for (LoopTask t : globalTasks) {
                if (t.getId().equals(taskId)) {
                    boolean newEnabled = !t.isEnabled();
                    t.setEnabled(newEnabled);

                    if (newEnabled) {
                        // 恢复：重新注册 Job（即时模式会被 registerJob 内部跳过）
                        registerJob(sessionId, t);
                    } else {
                        // 暂停：移除 Job，但不 cancel
                        String jobName = t.getJobName();
                        if (jobManager.jobExists(jobName)) {
                            jobManager.jobRemove(jobName);
                        }
                    }

                    saveGlobalToFile(workspace, harnessSessions);
                    return;
                }
            }
        }
    }

    /**
     * 更新任务定义（重建 Job）
     */
    public void update(String sessionId, String workspace, String harnessSessions, String taskId, LoopTask newTask) {
        synchronized (globalTasks) {
            for (int i = 0; i < globalTasks.size(); i++) {
                LoopTask t = globalTasks.get(i);
                if (t.getId().equals(taskId)) {
                    // 移除旧 Job
                    String jobName = t.getJobName();
                    if (jobManager.jobExists(jobName)) {
                        jobManager.jobRemove(jobName);
                    }

                    // 替换任务
                    globalTasks.set(i, newTask);

                    // 如果 enabled 且未取消，注册新 Job
                    if (newTask.isEnabled() && !newTask.isCancelled()) {
                        registerJob(sessionId, newTask);
                    }

                    saveGlobalToFile(workspace, harnessSessions);
                    return;
                }
            }
        }
    }

    /**
     * 手动触发一次执行（不走定时）
     */
    public void trigger(String sessionId, String workspace, String harnessSessions, String taskId) {
        LOG.info("trigger called: sessionId={}, taskId={}", sessionId, taskId);

        synchronized (globalTasks) {
            for (LoopTask t : globalTasks) {
                if (t.getId().equals(taskId)) {
                    LOG.info("Task found, starting trigger thread for taskId={}", taskId);
                    // 异步执行，避免阻塞 HTTP 请求
                    Thread thread = new Thread(() -> onTrigger(sessionId, t), "loop-trigger-" + taskId);
                    thread.setDaemon(true);
                    thread.start();
                    return;
                }
            }
        }
        LOG.warn("Task not found: taskId={}", taskId);
    }

    /**
     * 根据 ID 获取任务
     */
    public LoopTask getTaskById(String sessionId, String taskId) {
        synchronized (globalTasks) {
            for (LoopTask t : globalTasks) {
                if (t.getId().equals(taskId)) return t;
            }
        }
        return null;
    }

    // ==================== 任务列表 ====================

    /**
     * 列出活跃任务（自动清理过期）
     */
    public List<LoopTask> listActive(String sessionId, String workspace, String harnessSessions) {
        synchronized (globalTasks) {
            // 清理过期任务
            cleanExpiredGlobal(workspace, harnessSessions);

            return new ArrayList<>(globalTasks);
        }
    }

    /**
     * 列出所有任务（含已停用的），自动清理过期
     */
    public List<LoopTask> listAll(String sessionId, String workspace, String harnessSessions) {
        synchronized (globalTasks) {
            // 清理过期任务
            cleanExpiredGlobal(workspace, harnessSessions);

            return new ArrayList<>(globalTasks);
        }
    }

    /**
     * 当前所有定时任务占用的会话 ID 集合（运行时会话 + 绑定会话）。
     * <p>会话列表接口据此标记 loop=true，前端侧栏在对应条目前渲染时钟小图标。</p>
     */
    public Set<String> loopSessionIds() {
        synchronized (globalTasks) {
            Set<String> ids = new HashSet<>();
            for (LoopTask t : globalTasks) {
                if (t.getRuntimeSessionId() != null) ids.add(t.getRuntimeSessionId());
                if (t.getBoundSessionId() != null) ids.add(t.getBoundSessionId());
            }
            return ids;
        }
    }

    // ==================== 批量停止 ====================

    /**
     * 停止所有全局任务
     */
    public void stopAll(String sessionId, String workspace, String harnessSessions) {
        synchronized (globalTasks) {
            for (LoopTask t : globalTasks) {
                t.cancel();
                String jobName = t.getJobName();
                if (jobManager.jobExists(jobName)) {
                    jobManager.jobRemove(jobName);
                }
                // F6: 清理 worktree（工作空间回退口径必须与创建时一致，否则 workspace 为空的任务会漏清理）
                if (t.isWorktreeEnabled()) {
                    getWorktreeManager().cleanup(worktreeBaseOf(t));
                }
            }
            globalTasks.clear();
            // 删除全局 JSON 文件
            deleteGlobalFile(workspace, harnessSessions);
            loadedFileMtime = -1L;
            restored.set(true);
        }
    }

    // ==================== 会话恢复 ====================

    /**
     * 从 JSON 恢复全局任务 — 过滤过期任务，重新注册到 IJobManager
     *
     * <p>在应用启动时调用一次，加载全局任务列表
     */
    public void restore(String sessionId, String workspace, String harnessSessions) {
        synchronized (globalTasks) {
            // 保存路径供后续使用
            this.workspace = workspace;
            this.harnessSessions = harnessSessions;

            // 短路：已成功恢复且文件未变化 → 不重建不重写。
            // 会话列表接口按扫描到的每个会话目录各触发一次 restore，无短路时并发 restore
            // 的 clear/addAll 交错（clear→clear→addAll→addAll）会把任务重复加入并持久化。
            long mtime = fileMtimeOf(getGlobalFilePath(workspace, harnessSessions));
            if (restored.get() && mtime == loadedFileMtime) {
                return;
            }

            // 尝试加载全局任务文件
            List<LoopTask> tasks = loadGlobalFromFile(workspace, harnessSessions);

            // 如果全局文件不存在，尝试从旧的会话文件迁移
            if (tasks == null || tasks.isEmpty()) {
                tasks = migrateFromSessionFiles(workspace, harnessSessions);
            }

            if (tasks == null || tasks.isEmpty()) {
                // 磁盘无可恢复任务：保持内存现状，仅记录状态避免反复扫描
                loadedFileMtime = mtime;
                restored.set(true);
                return;
            }

            // 过滤过期/已取消 + 按 id 去重（自愈历史并发写入造成的重复项，保留首份）
            Map<String, LoopTask> byId = new LinkedHashMap<>();
            for (LoopTask t : tasks) {
                if (t.isExpired() || t.isCancelled()) {
                    continue;
                }
                byId.putIfAbsent(t.getId(), t);
            }
            List<LoopTask> alive = new ArrayList<>(byId.values());

            if (alive.isEmpty()) {
                globalTasks.clear();
                deleteGlobalFile(workspace, harnessSessions);
                loadedFileMtime = -1L;
                restored.set(true);
                return;
            }

            globalTasks.clear();
            globalTasks.addAll(alive);

            // 重新注册到 IJobManager（只注册启用的任务）
            for (LoopTask t : alive) {
                if (t.isEnabled()) {
                    registerJob(sessionId, t);
                }
            }

            // 回写（去掉过期任务/重复项）；saveGlobalToFile 内部记录最新 mtime
            saveGlobalToFile(workspace, harnessSessions);
            restored.set(true);
            LOG.info("Restored {} global loop tasks", alive.size());
        }
    }

    /** 文件 mtime（毫秒）；不存在或读取失败返回 -1。 */
    private static long fileMtimeOf(Path p) {
        try {
            return Files.exists(p) ? Files.getLastModifiedTime(p).toMillis() : -1L;
        } catch (Exception e) {
            return -1L;
        }
    }

    // ==================== IJobManager 注册 ====================

    /**
     * 注册任务到 IJobManager（cron 模式使用 cron 表达式，否则使用 fixedDelay 串行策略）
     */
    private void registerJob(String sessionId, LoopTask task) {
        registerJob(sessionId, task, false);
    }

    /**
     * 注册任务到 IJobManager
     *
     * @param firstRegistration 是否为首次注册（首次注册时，runNow 才生效）
     */
    private void registerJob(String sessionId, LoopTask task, boolean firstRegistration) {
        String jobName = task.getJobName();

        // 先移除已存在的同名 Job，避免重复注册
        if (jobManager.jobExists(jobName)) {
            jobManager.jobRemove(jobName);
        }

        ScheduledAnno scheduled;
        if (task.isCronMode()) {
            scheduled = new ScheduledAnno().cron(task.getCron());
        } else {
            long intervalMs = (long) task.getIntervalMinutes() * 60_000L;
            // isRunNow() 只对首次注册生效：重启恢复、切换启用、更新定义时均不应用
            long initialDelay = (firstRegistration && task.isRunNow()) ? 0 : intervalMs;
            scheduled = new ScheduledAnno()
                    .fixedDelay(intervalMs)
                    .initialDelay(initialDelay);
        }

        jobManager.jobAdd(jobName, scheduled, ctx -> {
            if(task.isEnabled() == false) {
                return;
            }

            onTrigger(sessionId, task);
        });
    }

    // ==================== 定时触发回调 ====================

    /**
     * 定时触发 — 执行任务
     */
    private void onTrigger(String sessionId, LoopTask task) {
        LOG.info("onTrigger called: sessionId={}, taskId={}, channelNotify={}", sessionId, task.getId(), task.getChannelNotify());

        // 决定执行会话：
        // 1. 如果绑定了会话，使用绑定的会话
        // 2. 如果没绑定会话，使用或创建 runtimeSessionId
        String boundSession = task.getBoundSessionId();
        String effectiveSessionId;

        if (boundSession != null && !boundSession.trim().isEmpty()) {
            // 有绑定会话，使用绑定的会话
            effectiveSessionId = boundSession;
            LOG.info("Using bound sessionId: {}", effectiveSessionId);
        } else if (task.getChannelNotify() != null && !task.getChannelNotify().isEmpty() && routingTable != null) {
            // 没有绑定会话，但有推送通道 → 使用该通道的活跃会话执行（这样 AI 回复自然会推送到该通道）
            String channelActiveSession = routingTable.getActiveSession(task.getChannelNotify());
            if (channelActiveSession != null && !channelActiveSession.isEmpty()) {
                effectiveSessionId = channelActiveSession;
                LOG.info("Using channel active sessionId: {} (channel: {})", effectiveSessionId, task.getChannelNotify());
            } else {
                // 通道没有活跃会话，使用或创建运行时会话
                effectiveSessionId = getOrCreateRuntimeSession(task);
            }
        } else {
            // 无绑定会话，无推送通道 → 使用或创建运行时会话
            effectiveSessionId = getOrCreateRuntimeSession(task);
        }

        // 过期或已取消则移除
        if (task.isExpired() || task.isCancelled()) {
            LOG.warn("Task is expired or cancelled: taskId={}", task.getId());
            String jobName = task.getJobName();
            if (jobManager.jobExists(jobName)) {
                jobManager.jobRemove(jobName);
            }
            return;
        }

        // 会话正在执行任务时跳过本次触发：不消耗迭代、不创建 worktree、不向前端推送消息。
        // 任一端口的 checker 报告繁忙即跳过（OR 合并）。
        for (BusyChecker checker : busyCheckers) {
            if (checker.isBusy(effectiveSessionId)) {
                LOG.info("Loop task '{}' skipped: session '{}' is busy", task.getId(), sessionId);
                return;
            }
        }

        // 达到最大迭代次数则自动移除
        if (task.isMaxIterationsReached()) {
            LOG.info("Loop task '{}' reached max iterations ({})", task.getId(), task.getMaxIterations());
            removeCurrentTask(effectiveSessionId, task);
            return;
        }

        // 防重入：上一个还没执行完则跳过
        if (!task.tryStart()) {
            LOG.warn("Task is already running, skip: taskId={}", task.getId());
            return;
        }

        LOG.info("Task execution started: taskId={}", task.getId());

        String executionResult = null; // 将变量提升到外层作用域

        try {
            // Phase 4: Worktree 隔离
            String worktreePath = null;
            if (task.isWorktreeEnabled()) {
                // 任务指定了工作空间时以其为仓库根创建 worktree，否则回退默认工作区
                String worktreeBase = worktreeBaseOf(task);
                worktreePath = getWorktreeManager().create(worktreeBase, task.getId());
                if (worktreePath != null) {
                    LOG.info("Loop task '{}' executing in worktree: {}", task.getId(), worktreePath);
                } else {
                    LOG.warn("Loop task '{}' worktree creation failed, falling back to main workspace", task.getId());
                }
                // 把本轮 worktree 路径交给执行侧，使 AI 真正在隔离工作树内作业
                task.setActiveWorktreePath(worktreePath);
            }

            try {
                // 构建完整 prompt（注入 skill + state 上下文）
                String effectivePrompt = buildEffectivePrompt(effectiveSessionId, task);

                executionResult = null;
                for (TaskExecutor taskExecutor : taskExecutors) {
                    String result = taskExecutor.execute(effectiveSessionId, effectivePrompt, null, task);
                    if (result != null) {
                        executionResult = result;
                    }
                }

                // 更新执行记录
                task.updateLastExecution(executionResult != null ? executionResult : "ok");

                // 仅在执行完成时递增迭代计数，避免 session busy 等场景下空转消耗迭代
                int iteration = task.incrementIteration();

                // 持久化执行状态（迭代数 / 上次结果），避免仅存内存重启丢失
                persistTasks();

                // Goal 条件检查 — 解析 AI 响应中的 [GOAL_ACHIEVED] 标记
                boolean goalMet = executionResult != null && executionResult.contains("[GOAL_ACHIEVED]");
                if (goalMet) {
                    LOG.info("Loop task '{}' goal achieved at iteration {}", task.getId(), iteration);
                    LoopStateManager.appendHistory(engine.getWorkspace(), task.getId(), executionResult, iteration, "GOAL_ACHIEVED");
                    removeCurrentTask(effectiveSessionId, task);
                    persistTasks();
                    return;
                }

                if (task.isMaxIterationsReached()) {
                    LOG.info("Loop task '{}' reached max iterations ({})", task.getId(), task.getMaxIterations());
                    LoopStateManager.appendHistory(engine.getWorkspace(), task.getId(), executionResult, iteration, "MAX_ITERATIONS_REACHED");
                    removeCurrentTask(effectiveSessionId, task);
                    persistTasks();
                    return;
                }

                // 写入执行历史
                LoopStateManager.appendHistory(engine.getWorkspace(), task.getId(), executionResult, iteration, "NONE");

            } finally {
                // Phase 4: 清理 worktree（执行完毕后）
                if (worktreePath != null) {
                    task.setActiveWorktreePath(null);
                    releaseWorktree(task, worktreePath);
                }
            }

        } catch (Exception e) {
            LOG.error("Loop task '{}' failed", task.getId(), e);
            task.updateLastExecution("error: " + e.getMessage());
            persistTasks();
        } finally {
            task.finish();
        }
    }

    /**
     * worktree 的仓库根：任务显式指定的工作空间优先，否则回退默认工作区。
     *
     * <p>创建（onTrigger）与清理（stopAll）必须共用此口径，不得各自判空。</p>
     */
    private String worktreeBaseOf(LoopTask task) {
        return task.getWorkspace() != null ? task.getWorkspace() : engine.getWorkspace();
    }

    /**
     * 释放本轮 worktree：先提交 AI 产出的改动，再删除工作树目录。
     *
     * <p>worktree 目录是单轮一次性的，但其上的 {@code loop/<taskId>} 分支是持久的：
     * 成果提交到分支后才能删目录，否则每轮都在销毁 AI 的工作。
     * 提交失败时保留目录，将丢失风险转为可排查的残留目录。</p>
     */
    private void releaseWorktree(LoopTask task, String worktreePath) {
        WorktreeManager.CommitOutcome outcome = getWorktreeManager()
                .commitAll(worktreePath, "loop(" + task.getId() + "): iteration " + task.getCurrentIteration());

        if (outcome == WorktreeManager.CommitOutcome.FAILED) {
            LOG.warn("Loop task '{}' worktree has uncommitted changes and commit failed, keep dir for manual recovery: {}",
                    task.getId(), worktreePath);
            return;
        }

        // 保留 loop/ 分支（可能已承载多轮成果），仅删除本轮工作树目录
        getWorktreeManager().remove(worktreePath, false);
        LOG.debug("Loop task '{}' worktree released ({})", task.getId(), outcome);
    }

    /**
     * 构建完整的有效 prompt（skill 解析 + goal 条件注入）
     */
    private String buildEffectivePrompt(String sessionId, LoopTask task) {
        String prompt = task.getPrompt();

        // Goal 条件注入（持久目标 + [GOAL_ACHIEVED] 终止标记）
        if (task.isGoalMode()) {
            StringBuilder goalPrompt = new StringBuilder();
            goalPrompt.append("\n\n--- 目标（持久目标） ---\n");

            // 定时模式 或 模板加载失败时的回退：简短提示
            goalPrompt.append("<objective>\n");
            goalPrompt.append(task.getGoalCondition()).append("\n");
            goalPrompt.append("</objective>\n\n");
            goalPrompt.append("进度：第 ").append(task.getCurrentIteration()).append("/").append(task.getMaxIterations()).append(" 次迭代\n");
            goalPrompt.append("\n如果目标已达成，请回复 [GOAL_ACHIEVED]。");

            prompt = prompt + goalPrompt;
        }

        return prompt;
    }

    /**
     * 获取或创建任务的运行时会话ID（用于没有绑定会话的任务）
     */
    private String getOrCreateRuntimeSession(LoopTask task) {
        String runtimeSession = task.getRuntimeSessionId();
        if (runtimeSession != null && !runtimeSession.trim().isEmpty()) {
            LOG.info("Reusing runtime sessionId: {}", runtimeSession);
            return runtimeSession;
        }
        // 第一次执行，创建新的会话ID（loop 运行时会话为全局会话，无所属根）
        String newSessionId = SessionLocator.PREFIX_WORK + java.util.UUID.randomUUID().toString().substring(0, 8);
        task.setRuntimeSessionId(newSessionId);
        LOG.info("Created new runtime sessionId: {}", newSessionId);
        if (workspace != null && harnessSessions != null) {
            saveGlobalToFile(workspace, harnessSessions);
        }
        return newSessionId;
    }

    /**
     * 移除当前任务（从 IJobManager 和内存列表中）
     */
    private void removeCurrentTask(String sessionId, LoopTask task) {
        String jobName = task.getJobName();
        if (jobManager.jobExists(jobName)) {
            jobManager.jobRemove(jobName);
        }
        task.cancel();
    }

    /**
     * 持久化任务列表快照（执行状态变化后调用：迭代数 / 上次结果 / 取消标记等），
     * 避免执行记录仅存内存、进程重启后丢失或状态回退。
     */
    private void persistTasks() {
        saveGlobalToFile(engine.getWorkspace(), engine.getHarnessSessions());
    }

    // ==================== 清理过期任务 ====================

    /**
     * 清理全局任务列表中的过期任务
     */
    private void cleanExpiredGlobal(String workspace, String harnessSessions) {
        synchronized (globalTasks) {
            boolean changed = globalTasks.removeIf(t -> {
                if (t.isExpired()) {
                    String jobName = t.getJobName();
                    if (jobManager.jobExists(jobName)) {
                        jobManager.jobRemove(jobName);
                    }
                    return true;
                }
                return false;
            });

            if (changed) {
                saveGlobalToFile(workspace, harnessSessions);
            }
        }
    }

    // ==================== JSON 持久化 ====================

    /**
     * 获取任务 JSON 文件路径
     * 位于会话目录下：&lt;workspace&gt;/&lt;harnessSessions&gt;/&lt;sessionId&gt;/loop_tasks.json
     */
    private Path getTasksFilePath(String sessionId) {
        return Paths.get(engine.getWorkspace(), engine.getHarnessSessions(), sessionId, TASKS_FILE);
    }

    /**
     * 从 JSON 文件加载任务列表
     */
    private List<LoopTask> loadFromFile(String sessionId) {
        try {
            Path filePath = getTasksFilePath(sessionId);
            if (!Files.exists(filePath)) return null;

            String json = new String(Files.readAllBytes(filePath), StandardCharsets.UTF_8);
            ONode root = ONode.ofJson(json);

            List<LoopTask> tasks = new ArrayList<>();
            for (ONode node : root.getArray()) {
                tasks.add(LoopTask.fromONode(node));
            }

            LOG.info("Succeeded load loop tasks[{}]: {}项", sessionId, tasks.size());

            return tasks;
        } catch (Exception e) {
            LOG.error("Failed to load loop tasks[{}]: {}", sessionId, e.getMessage());
            return null;
        }
    }

    /**
     * 删除 JSON 文件
     */
    private void deleteFile(String sessionId) {
        try {
            Path filePath = getTasksFilePath(sessionId);
            Files.deleteIfExists(filePath);
        } catch (Exception ignored) {
            // ignored
        }
    }

    // ==================== 全局任务文件操作 ====================

    /**
     * 获取全局任务文件路径
     */
    private Path getGlobalFilePath(String workspace, String harnessSessions) {
        return Paths.get(workspace, harnessSessions, GLOBAL_TASKS_FILE);
    }

    /**
     * 保存全局任务列表到 JSON 文件
     */
    private void saveGlobalToFile(String workspace, String harnessSessions) {
        synchronized (globalTasks) {
            try {
                Path filePath = getGlobalFilePath(workspace, harnessSessions);
                Files.createDirectories(filePath.getParent());

                ONode root = new ONode(Options.of(Feature.Write_PrettyFormat));
                for (LoopTask t : globalTasks) {
                    root.add(t.toONode());
                }
                String json = root.toJson();

                // 原子写入
                Path tempFile = filePath.resolveSibling(filePath.getFileName() + ".tmp");
                try (Writer w = new OutputStreamWriter(Files.newOutputStream(tempFile,
                        StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING),
                        StandardCharsets.UTF_8)) {
                    w.write(json);
                }
                Files.move(tempFile, filePath, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                // 记录最新 mtime，供 restore 在文件未变化时短路
                loadedFileMtime = fileMtimeOf(filePath);
                LOG.debug("Saved {} global loop tasks to {}", globalTasks.size(), filePath);
            } catch (Exception e) {
                LOG.error("Failed to save global loop tasks: {}", e.getMessage());
            }
        }
    }

    /**
     * 从全局 JSON 文件加载任务列表
     */
    private List<LoopTask> loadGlobalFromFile(String workspace, String harnessSessions) {
        try {
            Path filePath = getGlobalFilePath(workspace, harnessSessions);
            if (!Files.exists(filePath)) return null;

            String json = new String(Files.readAllBytes(filePath), StandardCharsets.UTF_8);
            ONode root = ONode.ofJson(json);

            List<LoopTask> tasks = new ArrayList<>();
            for (ONode node : root.getArray()) {
                tasks.add(LoopTask.fromONode(node));
            }

            LOG.info("Loaded {} global loop tasks from {}", tasks.size(), filePath);
            return tasks;
        } catch (Exception e) {
            LOG.error("Failed to load global loop tasks: {}", e.getMessage());
            return null;
        }
    }

    /**
     * 删除全局任务文件
     */
    private void deleteGlobalFile(String workspace, String harnessSessions) {
        try {
            Path filePath = getGlobalFilePath(workspace, harnessSessions);
            Files.deleteIfExists(filePath);
        } catch (Exception ignored) {
            // ignored
        }
    }

    /**
     * 从旧的会话文件迁移任务到全局列表（向后兼容）
     */
    private List<LoopTask> migrateFromSessionFiles(String workspace, String harnessSessions) {
        List<LoopTask> allTasks = new ArrayList<>();
        try {
            Path sessionsDir = Paths.get(workspace, harnessSessions);
            if (!Files.exists(sessionsDir)) return null;

            Files.list(sessionsDir)
                    .filter(Files::isDirectory)
                    .forEach(sessionDir -> {
                        String sessionId = sessionDir.getFileName().toString();
                        List<LoopTask> tasks = loadFromFile(sessionId);
                        if (tasks != null && !tasks.isEmpty()) {
                            allTasks.addAll(tasks);
                            LOG.info("Migrated {} tasks from session {}", tasks.size(), sessionId);
                        }
                    });

            if (!allTasks.isEmpty()) {
                LOG.info("Total migrated {} tasks from old session files", allTasks.size());
            }
        } catch (Exception e) {
            LOG.warn("Failed to migrate from session files: {}", e.getMessage());
        }
        return allTasks.isEmpty() ? null : allTasks;
    }
}
