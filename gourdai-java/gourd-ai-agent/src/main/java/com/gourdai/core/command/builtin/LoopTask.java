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

import com.gourdai.agent.ContextLengthPolicy;
import com.gourdai.harness.permission.AccessMode;
import lombok.Getter;
import org.noear.snack4.ONode;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 定时循环任务模型，用于 /loop 命令
 *
 * <p>支持 Loop Engineering 的 6 个基元：
 * <ul>
 *   <li>Automations — 定时/cron 触发（intervalMinutes / cron）</li>
 *   <li>Skills — AI 根据 prompt 自动匹配可用技能</li>
 *   <li>Worktrees — worktreeEnabled 在独立分支执行</li>
 *   <li>Connectors — channelNotify 结果通知</li>
 *   <li>State — stateDir 持久状态目录 (.gwork/loops/&lt;id&gt;/)</li>
 * </ul>
 *
 * @author oisin
 * @since 3.9.1
 */
@Getter
public class LoopTask {
    private static final int MIN_INTERVAL = 0; // 0 = 即时模式（goal 专用）
    private static final int MAX_INTERVAL = 1440; // 24h
    private static final int EXPIRE_DAYS = 7;
    private static final int DEFAULT_MAX_ITERATIONS = 0; // 0 = 默认不限制轮次（仅显式设置 >0 时才限制）

    // ---- 核心调度字段 ----
    private final String id;
    private volatile String name;
    private final String prompt;
    private final int intervalMinutes;
    private final String cron;
    private final Instant createdAt;
    private final Instant expireAt;
    private final boolean autoInterval;

    // ---- Loop Engineering 扩展字段 ----
    private final String goalCondition;      // 目标条件，如 "all tests pass"
    private final boolean worktreeEnabled;   // 是否在独立 worktree 中执行
    private final String worktreeBranch;     // worktree 分支名（运行时分配）
    private final String channelNotify;      // 通知通道，如 "feishu"
    private final String boundSessionId;     // 绑定的会话ID（可选，null 表示不绑定会话）
    private final String workspace;         // 工作空间路径（执行任务的工作根 + 动态拼接 stateDir）
    private final String modelName;          // 指定模型名（null 表示跟随默认模型）
    // 思考深度档位：null = 未设置（仅旧数据，执行时跟随运行时会话的选择）；"off" = 显式关闭思考
    private final String thinkingDepth;
    // 上下文窗口（token）：null = 未设置（执行时使用全局默认）；合法值为 ContextLengthPolicy 固定选项之一
    private final Long contextLength;
    // 访问控制档位：null = 未设置（执行时回退会话已存档位）；"default" / "full" 见 AccessMode
    private final String accessMode;
    // 任务级附件：附件目录（<stateDir>/attachments/）内的简单文件名清单，与 attachmentTypes 同序一一对应。
    // 每次定时执行都会把它们注入本轮 Prompt（image → 多模态图片块，file → "[附件: 绝对路径]" 文本前缀），
    // 语义与前台 /web/chat/input 的附件一致。始终为非 null 的不可变视图（无附件时为空 list）。
    private final List<String> attachmentPaths;
    private final List<String> attachmentTypes;
    private final int maxIterations;         // 最大迭代次数（0 = 不限制）
    private final boolean runNow;            // 注册后立即执行首次（initialDelay=0）

    // ---- 运行时状态 ----
    private volatile boolean running;
    private volatile boolean cancelled;
    private volatile String lastResult;
    private volatile Instant lastExecutedAt;
    private volatile int currentIteration;
    private volatile boolean enabled = true; // 启用/停用
    private volatile boolean wrapUpPending = false; // 即将收尾（最后一次 wrap-up turn）

    // re-trigger 并发保护：防止多个 re-trigger 线程同时启动
    private final AtomicBoolean continuationPending = new AtomicBoolean(false);
    private volatile String runtimeSessionId; // 运行时会话ID（第一次执行时创建，后续复用）

    // 本轮 worktree 绝对路径：worktreeEnabled 时由调度器在执行前赋值、执行后清空。
    // 瞬态字段，不参与序列化（worktree 生命周期仅限单轮执行，跨进程恢复后必然失效）。
    private volatile String activeWorktreePath;


    /**
     * 固定间隔构造
     */
    public LoopTask(String prompt, int intervalMinutes) {
        this(prompt, intervalMinutes, null, null, false, null);
    }

    /**
     * cron 表达式构造
     */
    public LoopTask(String prompt, String cron) {
        this(prompt, 0, cron, null, false, null);
    }


    /**
     * 全参数构造（由 Builder、copyWithUpdate 调用）
     */
    LoopTask(String id, String prompt, int intervalMinutes, String cron,
                     Instant createdAt, Instant expireAt, boolean autoInterval,
                     boolean enabled,
                     String goalCondition, boolean worktreeEnabled, String worktreeBranch,
                     String channelNotify, String boundSessionId, String workspace,
                     String modelName, String thinkingDepth, Long contextLength, String accessMode,
                     List<String> attachmentPaths, List<String> attachmentTypes,
                     int maxIterations, boolean runNow,
                     boolean cancelled, String lastResult, Instant lastExecutedAt, int currentIteration) {
        this.id = id;
        this.prompt = prompt;
        this.intervalMinutes = intervalMinutes;
        this.cron = cron;
        this.createdAt = createdAt;
        this.expireAt = expireAt;
        this.autoInterval = autoInterval;
        this.enabled = enabled;
        this.goalCondition = goalCondition;
        this.worktreeEnabled = worktreeEnabled;
        this.worktreeBranch = worktreeBranch;
        this.channelNotify = blankToNull(channelNotify);
        this.boundSessionId = blankToNull(boundSessionId);
        this.workspace = blankToNull(workspace);
        this.modelName = blankToNull(modelName);
        this.thinkingDepth = blankToNull(thinkingDepth);
        this.contextLength = normalizeContextLength(contextLength);
        this.accessMode = normalizeAccessMode(accessMode);
        this.attachmentPaths = immutableCopy(attachmentPaths);
        this.attachmentTypes = immutableCopy(attachmentTypes);
        this.maxIterations = maxIterations;
        this.runNow = runNow;
        this.cancelled = cancelled;
        this.lastResult = lastResult;
        this.lastExecutedAt = lastExecutedAt;
        this.currentIteration = currentIteration;
    }

    /**
     * 便捷构造（固定间隔 + 扩展参数）
     */
    public LoopTask(String prompt, int intervalMinutes, String cron,
                    String goalCondition, Boolean worktreeEnabled,
                    Integer maxIterations) {
        this(prompt, intervalMinutes, cron, goalCondition, worktreeEnabled, maxIterations, false);
    }

    /**
     * 便捷构造（固定间隔 + 扩展参数 + runNow）
     */
    public LoopTask(String prompt, int intervalMinutes, String cron,
                    String goalCondition, Boolean worktreeEnabled,
                    Integer maxIterations, boolean runNow) {
        this(prompt, intervalMinutes, cron, goalCondition, worktreeEnabled, maxIterations, runNow,
                null, null, null, null, null, null);
    }

    /**
     * 便捷构造（全执行上下文）：在固定间隔 / cron 基础上带上执行环境选择。
     *
     * @param workspace     执行任务的工作空间根绝对路径（null 表示默认工作区）
     * @param modelName     指定模型名（null 表示跟随默认模型）
     * @param thinkingDepth 思考深度档位（null = 未设置，跟随会话选择；"off" = 显式关闭）
     * @param contextLength 上下文窗口（null = 未设置，执行时使用全局默认；合法值为 ContextLengthPolicy 固定选项之一）
     * @param channelNotify 结果推送通道（null 表示不推送）
     * @param boundSessionId 绑定的会话 ID（null 表示使用任务自己的运行时会话）
     */
    public LoopTask(String prompt, int intervalMinutes, String cron,
                    String goalCondition, Boolean worktreeEnabled,
                    Integer maxIterations, boolean runNow,
                    String workspace, String modelName, String thinkingDepth, Long contextLength,
                    String channelNotify, String boundSessionId) {
        this(prompt, intervalMinutes, cron, goalCondition, worktreeEnabled, maxIterations, runNow,
                workspace, modelName, thinkingDepth, contextLength, null,
                channelNotify, boundSessionId);
    }

    /**
     * 便捷构造（全执行上下文 + 权限档位）。
     *
     * @param accessMode 访问控制档位（null = 回退会话已存档位；"default" / "full"）
     */
    public LoopTask(String prompt, int intervalMinutes, String cron,
                    String goalCondition, Boolean worktreeEnabled,
                    Integer maxIterations, boolean runNow,
                    String workspace, String modelName, String thinkingDepth, Long contextLength,
                    String accessMode,
                    String channelNotify, String boundSessionId) {
        this(prompt, intervalMinutes, cron, goalCondition, worktreeEnabled, maxIterations, runNow,
                workspace, modelName, thinkingDepth, contextLength, accessMode,
                channelNotify, boundSessionId, null, null);
    }

    /**
     * 便捷构造（全执行上下文 + 权限档位 + 任务级附件）。
     *
     * @param attachmentPaths 附件目录内的简单文件名清单（可为 null，视为无附件）
     * @param attachmentTypes 与 attachmentPaths 同序的类型声明（{@code image} / {@code file}；可为 null）
     */
    public LoopTask(String prompt, int intervalMinutes, String cron,
                    String goalCondition, Boolean worktreeEnabled,
                    Integer maxIterations, boolean runNow,
                    String workspace, String modelName, String thinkingDepth, Long contextLength,
                    String accessMode,
                    String channelNotify, String boundSessionId,
                    List<String> attachmentPaths, List<String> attachmentTypes) {
        this.id = UUID.randomUUID().toString().substring(0, 8);
        this.prompt = prompt;
        // 间隔钒在 [MIN_INTERVAL, MAX_INTERVAL]，不存在 0 间隔；goal 模式通过 fixedDelay 串行调度逐轮触发
        this.intervalMinutes = Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, intervalMinutes));
        this.cron = cron;
        this.createdAt = Instant.now();
        this.expireAt = createdAt.plus(EXPIRE_DAYS, ChronoUnit.DAYS);
        this.autoInterval = false;
        this.goalCondition = goalCondition;
        this.worktreeEnabled = worktreeEnabled != null ? worktreeEnabled : false;
        this.worktreeBranch = null; // 运行时分配
        this.channelNotify = blankToNull(channelNotify);
        this.boundSessionId = blankToNull(boundSessionId);
        this.workspace = blankToNull(workspace);
        this.modelName = blankToNull(modelName);
        this.thinkingDepth = blankToNull(thinkingDepth);
        this.contextLength = normalizeContextLength(contextLength);
        this.accessMode = normalizeAccessMode(accessMode);
        this.attachmentPaths = immutableCopy(attachmentPaths);
        this.attachmentTypes = immutableCopy(attachmentTypes);
        this.maxIterations = normalizeMaxIterations(maxIterations);
        this.runNow = runNow;
        this.currentIteration = 0;
        this.enabled = true;
    }

    /**
     * 空白字符串归一为 null：使 "未选择" 与 "空串" 在持久化与判空逻辑上等价。
     */
    private static String blankToNull(String s) {
        if (s == null) {
            return null;
        }
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }

    /**
     * 归一最大迭代次数：null → 默认（不限制），负值 → 0（不限制）。
     */
    private static int normalizeMaxIterations(Integer maxIterations) {
        int v = maxIterations != null ? maxIterations : DEFAULT_MAX_ITERATIONS;
        return Math.max(0, v);
    }

    /**
     * 归一上下文窗口：仅保留固定选项内的合法值，其余（含 null）一律视为未设置（跟随全局默认）。
     */
    private static Long normalizeContextLength(Long contextLength) {
        return contextLength != null && ContextLengthPolicy.isAllowed(contextLength) ? contextLength : null;
    }

    /**
     * 归一访问控制档位：空白归为 null（回退会话已存档位），脏值经 normalize 回落默认档。
     */
    private static String normalizeAccessMode(String accessMode) {
        String v = blankToNull(accessMode);
        return v != null ? AccessMode.normalize(v).code() : null;
    }

    /**
     * 归一附件清单：null → 空 list；逐条 trim 并丢弃空白项；返回不可变视图。
     *
     * <p>存储不可变副本 + 返回不可变视图，避免调用方持有的 list 被外部改写后
     * 与「已落盘的附件字节」失配（那种失配会让某轮执行注入一个不存在的附件）。</p>
     */
    private static List<String> immutableCopy(List<String> values) {
        if (values == null || values.isEmpty()) {
            return Collections.emptyList();
        }
        List<String> copy = new ArrayList<>(values.size());
        for (String v : values) {
            String t = blankToNull(v);
            if (t != null) {
                copy.add(t);
            }
        }
        return copy.isEmpty() ? Collections.emptyList() : Collections.unmodifiableList(copy);
    }

    /**
     * 基于当前任务复制出一份更新后的任务定义，保留任务身份和运行时状态。
     *
     * <p>执行上下文（workspace / modelName / thinkingDepth / contextLength / accessMode /
     * channelNotify / boundSessionId）沿用原值。</p>
     */
    public LoopTask copyWithUpdate(String prompt, int intervalMinutes, String cron,
                                    String goalCondition, Boolean worktreeEnabled,
                                    Integer maxIterations, Boolean runNow) {
        return copyWithUpdate(prompt, intervalMinutes, cron, goalCondition, worktreeEnabled,
                maxIterations, runNow,
                this.workspace, this.modelName, this.thinkingDepth, this.contextLength,
                this.accessMode, this.channelNotify, this.boundSessionId);
    }

    /**
     * 基于当前任务复制出一份更新后的任务定义（可改执行上下文），保留任务身份和运行时状态。
     *
     * <p>注意：运行时会话 ID 不在此处继承。工作空间发生变化时，调用方应重置 runtimeSessionId，
     * 避免新工作空间下的任务继续复用旧目录的会话历史（见 {@link #getRuntimeSessionId()}）。</p>
     */
    public LoopTask copyWithUpdate(String prompt, int intervalMinutes, String cron,
                                    String goalCondition, Boolean worktreeEnabled,
                                    Integer maxIterations, Boolean runNow,
                                    String workspace, String modelName, String thinkingDepth, Long contextLength,
                                    String accessMode,
                                    String channelNotify, String boundSessionId) {
        return copyWithUpdate(prompt, intervalMinutes, cron, goalCondition, worktreeEnabled,
                maxIterations, runNow,
                workspace, modelName, thinkingDepth, contextLength, accessMode,
                channelNotify, boundSessionId, null, null);
    }

    /**
     * 基于当前任务复制出一份更新后的任务定义（可改执行上下文与任务级附件），保留任务身份和运行时状态。
     *
     * <p>附件清单语义与其它执行上下文字段一致：传 null 表示「未声明，沿用原值」，
     * 传非 null（含空 list）表示「以新值为准」——空 list 即清空全部附件。</p>
     *
     * @param attachmentPaths 新的附件文件名清单（null = 沿用原值）
     * @param attachmentTypes 与 attachmentPaths 同序的类型声明（null = 沿用原值）
     */
    public LoopTask copyWithUpdate(String prompt, int intervalMinutes, String cron,
                                    String goalCondition, Boolean worktreeEnabled,
                                    Integer maxIterations, Boolean runNow,
                                    String workspace, String modelName, String thinkingDepth, Long contextLength,
                                    String accessMode,
                                    String channelNotify, String boundSessionId,
                                    List<String> attachmentPaths, List<String> attachmentTypes) {
        LoopTask task = new LoopTask(
                this.id,
                prompt,
                Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, intervalMinutes)),
                cron,
                this.createdAt,
                this.expireAt,
                this.autoInterval,
                this.enabled,
                goalCondition,
                worktreeEnabled != null ? worktreeEnabled : false,
                this.worktreeBranch,
                channelNotify,
                boundSessionId,
                workspace,
                modelName,
                thinkingDepth,
                contextLength,
                accessMode,
                attachmentPaths != null ? attachmentPaths : this.attachmentPaths,
                attachmentTypes != null ? attachmentTypes : this.attachmentTypes,
                normalizeMaxIterations(maxIterations),
                runNow != null ? runNow : this.runNow,
                this.cancelled,
                this.lastResult,
                this.lastExecutedAt,
                this.currentIteration
        );
        task.running = false;
        return task;
    }

    /**
     * 是否已过期
     */
    public boolean isExpired() {
        return Instant.now().isAfter(expireAt);
    }

    /**
     * 是否为 cron 模式
     */
    public boolean isCronMode() {
        return cron != null && !cron.isEmpty();
    }

    /**
     * 是否仍处于活跃状态（未取消且未过期）
     */
    public boolean isActive() {
        return !cancelled && !isExpired();
    }

    /**
     * 尝试标记为运行中（CAS 语义）
     *
     * @return true 表示成功获取执行权
     */
    public synchronized boolean tryStart() {
        if (running) {
            return false;
        }
        running = true;
        return true;
    }

    /**
     * 标记执行结束
     */
    public synchronized void finish() {
        running = false;
    }

    /**
     * 获取 IJobManager 注册用的任务名称
     */
    public String getJobName() {
        return "loop-" + id;
    }

    /**
     * 取消任务
     */
    public void cancel() {
        cancelled = true;
    }

    /**
     * 更新最近一次执行信息
     */
    public void updateLastExecution(String result) {
        this.lastResult = result;
        this.lastExecutedAt = Instant.now();
    }

    /**
     * 递增迭代计数
     *
     * @return 递增后的当前迭代次数
     */
    public int incrementIteration() {
        return ++currentIteration;
    }

    /**
     * 是否已达到最大迭代次数
     */
    public boolean isMaxIterationsReached() {
        return maxIterations > 0 && currentIteration >= maxIterations;
    }

    /**
     * 是否为 goal 模式（有目标条件定义）
     */
    public boolean isGoalMode() {
        return goalCondition != null && !goalCondition.isEmpty();
    }

    public void setEnabled(boolean enabled) { this.enabled = enabled; }

    public void setWrapUpPending(boolean wrapUpPending) { this.wrapUpPending = wrapUpPending; }

    public boolean isWrapUpPending() { return wrapUpPending; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public void setRuntimeSessionId(String runtimeSessionId) { this.runtimeSessionId = runtimeSessionId; }

    /**
     * 设置本轮 worktree 路径（由 LoopScheduler 在执行前后维护，null 表示未启用或已清理）
     */
    public void setActiveWorktreePath(String activeWorktreePath) { this.activeWorktreePath = activeWorktreePath; }

    /**
     * 序列化为 ONode
     */
    public ONode toONode() {
        ONode node = new ONode();
        // 核心调度字段
        node.set("id", id);
        if (name != null) node.set("name", name);
        node.set("prompt", prompt);
        node.set("intervalMinutes", intervalMinutes);
        if (cron != null) {
            node.set("cron", cron);
        }
        node.set("createdAt", createdAt.toString());
        node.set("expireAt", expireAt.toString());
        node.set("autoInterval", autoInterval);
        node.set("cancelled", cancelled);
        node.set("running", running);
        node.set("enabled", enabled);

        // 运行时状态
        if (lastResult != null) {
            node.set("lastResult", lastResult);
        }
        if (lastExecutedAt != null) {
            node.set("lastExecutedAt", lastExecutedAt.toString());
        }
        node.set("currentIteration", currentIteration);
        if (runtimeSessionId != null) {
            node.set("runtimeSessionId", runtimeSessionId);
        }

        // Loop Engineering 扩展字段
        if (goalCondition != null) node.set("goalCondition", goalCondition);
        if (worktreeEnabled) node.set("worktreeEnabled", worktreeEnabled);
        if (worktreeBranch != null) node.set("worktreeBranch", worktreeBranch);
        if (channelNotify != null) node.set("channelNotify", channelNotify);
        if (boundSessionId != null) node.set("boundSessionId", boundSessionId);
        if (workspace != null) node.set("workspace", workspace);
        if (modelName != null) node.set("modelName", modelName);
        if (thinkingDepth != null) node.set("thinkingDepth", thinkingDepth);
        if (contextLength != null) node.set("contextLength", contextLength);
        if (accessMode != null) node.set("accessMode", accessMode);
        // 任务级附件：空清单不写节点（与可选字段一律「未设置不落盘」的既有口径一致）
        if (!attachmentPaths.isEmpty()) node.set("attachmentPaths", toArrayNode(attachmentPaths));
        if (!attachmentTypes.isEmpty()) node.set("attachmentTypes", toArrayNode(attachmentTypes));
        if (maxIterations != DEFAULT_MAX_ITERATIONS) node.set("maxIterations", maxIterations);
        if (runNow) node.set("runNow", true);

        return node;
    }

    /**
     * 把字符串清单写成 ONode 数组节点（与 LoopScheduler 持久化任务列表同一构造口径）。
     */
    private static ONode toArrayNode(List<String> values) {
        ONode arr = new ONode();
        for (String v : values) {
            arr.add(v);
        }
        return arr;
    }

    /**
     * 从 ONode 读取字符串数组节点：缺失、非数组或单条损坏一律降级（整体缺失 → 空 list，
     * 单条损坏 → 跳过该条），确保旧版本任务文件与非预期写入都不会让任务恢复失败。
     */
    private static List<String> readStringArray(ONode node, String key) {
        ONode arr = node.getOrNull(key);
        if (arr == null) {
            return Collections.emptyList();
        }
        try {
            if (!arr.isArray()) {
                return Collections.emptyList();
            }
            List<String> out = new ArrayList<>();
            for (ONode item : arr.getArray()) {
                String v = blankToNull(item.getString());
                if (v != null) {
                    out.add(v);
                }
            }
            return out.isEmpty() ? Collections.emptyList() : Collections.unmodifiableList(out);
        } catch (RuntimeException e) {
            return Collections.emptyList();
        }
    }

    /**
     * 从 ONode 反序列化（向后兼容：缺失字段给默认值）
     */
    public static LoopTask fromONode(ONode node) {
        String lastResultVal = node.getOrNull("lastResult") != null
                ? node.get("lastResult").getString()
                : null;
        Instant lastExecutedAtVal = node.getOrNull("lastExecutedAt") != null
                ? Instant.parse(node.get("lastExecutedAt").getString())
                : null;
        String cronVal = node.getOrNull("cron") != null
                ? node.get("cron").getString()
                : null;

        // 向后兼容：缺失时给默认值
        boolean enabledVal = node.getOrNull("enabled") != null
                ? node.get("enabled").getBoolean() : true;

        String goalConditionVal = node.getOrNull("goalCondition") != null
                ? node.get("goalCondition").getString() : null;
        boolean worktreeEnabledVal = node.getOrNull("worktreeEnabled") != null
                && node.get("worktreeEnabled").getBoolean();
        String worktreeBranchVal = node.getOrNull("worktreeBranch") != null
                ? node.get("worktreeBranch").getString() : null;
        String channelNotifyVal = node.getOrNull("channelNotify") != null
                ? node.get("channelNotify").getString() : null;
        String boundSessionIdVal = node.getOrNull("boundSessionId") != null
                ? node.get("boundSessionId").getString() : null;
        String nameVal = node.getOrNull("name") != null
                ? node.get("name").getString() : null;
        String workspaceVal = node.getOrNull("workspace") != null
                ? node.get("workspace").getString() : null;
        String modelNameVal = node.getOrNull("modelName") != null
                ? node.get("modelName").getString() : null;
        String thinkingDepthVal = node.getOrNull("thinkingDepth") != null
                ? node.get("thinkingDepth").getString() : null;
        // 上下文窗口：缺失或非法（非固定选项）一律视为未设置（跟随全局默认）
        Long contextLengthVal = null;
        if (node.getOrNull("contextLength") != null) {
            try {
                long raw = node.get("contextLength").getLong();
                if (ContextLengthPolicy.isAllowed(raw)) {
                    contextLengthVal = raw;
                }
            } catch (RuntimeException ignored) {
                // 损坏值：忽略，保持未设置
            }
        }
        String accessModeVal = node.getOrNull("accessMode") != null
                ? node.get("accessMode").getString() : null;
        int maxIterationsVal = node.getOrNull("maxIterations") != null
                ? node.get("maxIterations").getInt() : DEFAULT_MAX_ITERATIONS;
        int currentIterationVal = node.getOrNull("currentIteration") != null
                ? node.get("currentIteration").getInt() : 0;

        boolean runNowVal = node.getOrNull("runNow") != null
                && node.get("runNow").getBoolean();

        LoopTask task = new LoopTask(
                node.get("id").getString(),
                node.get("prompt").getString(),
                node.get("intervalMinutes").getInt(),
                cronVal,
                Instant.parse(node.get("createdAt").getString()),
                Instant.parse(node.get("expireAt").getString()),
                node.get("autoInterval").getBoolean(),
                enabledVal,
                goalConditionVal,
                worktreeEnabledVal,
                worktreeBranchVal,
                channelNotifyVal,
                boundSessionIdVal,
                workspaceVal,
                modelNameVal,
                thinkingDepthVal,
                contextLengthVal,
                accessModeVal,
                readStringArray(node, "attachmentPaths"),
                readStringArray(node, "attachmentTypes"),
                maxIterationsVal,
                runNowVal,
                node.getOrNull("cancelled") != null
                        ? node.get("cancelled").getBoolean() : false,
                lastResultVal,
                lastExecutedAtVal,
                currentIterationVal
        );
        task.setName(nameVal);
        // 加载运行时会话ID
        if (node.getOrNull("runtimeSessionId") != null) {
            task.setRuntimeSessionId(node.get("runtimeSessionId").getString());
        }
        return task;
    }
}
