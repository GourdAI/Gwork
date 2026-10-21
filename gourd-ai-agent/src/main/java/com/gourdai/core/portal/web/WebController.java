/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.core.portal.web;

import org.noear.snack4.ONode;
import org.noear.solon.Solon;
import com.gourdai.agent.AgentSession;
import com.gourdai.agent.ContextLengthPolicy;
import com.gourdai.agent.react.intercept.HITL;
import com.gourdai.agent.react.intercept.HITLTask;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.permission.AccessMode;
import com.gourdai.harness.change.FileChangeService;
import com.gourdai.harness.talents.cli.TodoTalent;
import com.gourdai.harness.talents.memory.MemorySearchResult;
import com.gourdai.harness.talents.memory.MemorySearcher;
import com.gourdai.harness.talents.memory.MemoryStorer;
import com.gourdai.harness.talents.memory.MemorySolution;
import com.gourdai.harness.talents.memory.MemorySolutionProvider;
import com.gourdai.harness.agent.AgentDefinition;
import com.gourdai.harness.command.Command;
import com.gourdai.ai.talents.registry.SkillDir;
import org.noear.solon.annotation.*;
import com.gourdai.core.config.AgentFlags;
import com.gourdai.core.config.AgentSettings;
import com.gourdai.core.config.BuildInfo;
import com.gourdai.core.config.entity.ModelDo;
import com.gourdai.core.portal.WorkspaceWatcher;
import com.gourdai.core.command.builtin.LoopAttachments;
import com.gourdai.core.command.builtin.LoopScheduler;
import com.gourdai.core.command.builtin.LoopStateManager;
import com.gourdai.core.command.builtin.LoopTask;
import org.noear.solon.core.handle.Context;
import org.noear.solon.core.handle.Result;
import org.noear.solon.core.handle.UploadedFile;
import org.noear.solon.core.util.Assert;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;

/**
 * Web 门户控制器 —— GWork Web UI 的核心 HTTP 入口。
 *
 * <p>职责：接收前端浏览器的 HTTP 请求，将聊天输入、会话管理、Git 操作、文件树浏览等
 * 业务委派给 {@link WebGate}（WebSocket 推送）和 {@link HarnessEngine}（AI 引擎）处理。</p>
 *
 * <h3>主要功能分组</h3>
 * <ul>
 *   <li><b>页面入口与元信息</b>：首页重定向、应用标题/版本/工作区路径查询</li>
 *   <li><b>聊天会话管理</b>：会话列表加载、删除、重命名、消息历史、回退、中断</li>
 *   <li><b>模型管理</b>：可用模型列表查询、当前会话模型切换</li>
 *   <li><b>聊天输入</b>：接收用户消息与附件，路由到 WebGate 进行 AI 处理</li>
 *   <li><b>Git 集成</b>：仓库状态检测、初始化、Diff 查看、文件内容获取、提交（委派给 {@link GitService}）</li>
 *   <li><b>文件浏览</b>：工作区目录结构浏览、文件搜索、文件内容读取（委派给 {@link FileService}）</li>
 * </ul>
 *
 * <h3>架构位置</h3>
 * <p>位于 {@code portal.web} 层，是 MVC 的 Controller。
 * 向上对接浏览器前端，向下通过 {@link WebGate}（WebSocket 推送通道）和
 * {@link HarnessEngine}（AI Agent 引擎）完成实际业务处理。</p>
 *
 * @author oisin
 * @see WebGate    WebSocket 推送网关
 * @see GitService  Git 业务逻辑服务
 * @see FileService 文件浏览业务逻辑服务
 * @see HarnessEngine AI Agent 执行引擎
 */
public class WebController {
    /** 日志记录器 */
    private static final Logger LOG = LoggerFactory.getLogger(WebController.class);

    /** 会话「最后活动」数据文件后缀：引擎消息 / 引擎快照 / Web 流式回放 / 工具用量账本；
     * 取各者 mtime 最大值判定活动时间。账本必须入列：它是工具调用的逐次追写，
     * 漏掉会让「只跑工具不产文本」的轮次（如纯 todowrite/记忆写入）不刷新会话时间 */
    private static final String[] ACTIVITY_FILE_SUFFIXES = {
            ".messages.ndjson", ".snapshot.json", SessionStreamStore.STREAM_SUFFIX,
            SessionStreamStore.USAGE_SUFFIX};

    /**
     * {@code /web/chat/attachment/meta} 单次请求的路径条数上限。
     *
     * <p>该端点逐条读盘并对图片做 base64 内联，条数无上限时一次请求即可放大成大量磁盘 IO
     * 与巨型响应体。前端按 {@code ATTACH_META_BATCH_SIZE}(12) 分批请求，32 已留出裕量。</p>
     */
    private static final int ATTACHMENT_META_MAX_PATHS = 32;

    /** AI Agent 执行引擎，提供会话管理、模型配置、命令注册等核心能力 */
    private final HarnessEngine engine;

    /** WebSocket 推送网关，负责将 AI 处理结果实时推送到前端浏览器 */
    private final WebGate webGate;

    /** 循环调度器，用于恢复和管理 Web 端的定时/循环 AI 任务 */
    private final LoopScheduler loopScheduler;

    /** Git 业务逻辑服务，封装工作区 Git 操作 */
    private final GitService gitService;

    /** 文件业务逻辑服务，封装工作区文件浏览、搜索、读取操作 */
    private final FileService fileService;

    /** 会话目录定位器：解析全局基准目录下的全局会话与项目根下的项目会话 */
    private final SessionLocator sessionLocator;

    /** 用量归档账本：把各会话的 token 消耗增量固化到全局基准目录，历史不随项目删除而丢失 */
    private final UsageArchiveService usageArchiveService;

    /** 用量统计服务：聚合全局 + 所有已登记项目会话的 token 消耗、活跃度与模型分布 */
    private final UsageStatsService usageStatsService;

    /** 项目登记服务：Code 模式的本地项目目录列表 */
    private final ProjectService projectService = new ProjectService();

    /** 统一模型配置（保序 Map，模型列表按配置顺序输出） */
    private final AgentSettings settings;

    /** 工作区文件变化监听器：可为 null（Code 模式项目根动态登记监听） */
    private final WorkspaceWatcher workspaceWatcher;

    /**
     * 构造函数：初始化核心依赖并注册 Web 端 Loop 任务执行器。
     *
     * @param engine        AI Agent 执行引擎
     * @param webGate       WebSocket 推送网关
     * @param loopScheduler 循环任务调度器，可为 null（无循环任务场景）
     * @param sessionLocator 会话目录定位器
     */
    public WebController(HarnessEngine engine, WebGate webGate, LoopScheduler loopScheduler, SessionLocator sessionLocator, AgentSettings settings) {
        this(engine, webGate, loopScheduler, sessionLocator, settings, null);
    }

    /**
     * 构造函数（含文件变化监听器）。
     *
     * @param settings          统一模型配置（模型列表按配置顺序输出）
     * @param workspaceWatcher 工作区文件变化监听器，可为 null
     */
    public WebController(HarnessEngine engine, WebGate webGate, LoopScheduler loopScheduler, SessionLocator sessionLocator, AgentSettings settings, WorkspaceWatcher workspaceWatcher) {
        this.engine = engine;
        this.webGate = webGate;
        this.loopScheduler = loopScheduler;
        this.sessionLocator = sessionLocator;
        this.settings = settings;
        this.usageArchiveService = new UsageArchiveService(sessionLocator, AgentFlags.getHarnessBase());
        this.usageStatsService = new UsageStatsService(usageArchiveService);
        this.workspaceWatcher = workspaceWatcher;
        this.gitService = new GitService(engine.getWorkspace(), engine);
        this.fileService = new FileService(engine.getWorkspace());

        // 注入 Web 端 Loop 任务执行器：同步等待本轮 AI 响应结束，捕获文本结果用于 goal 检测。
        if (loopScheduler != null) {
            // 会话繁忙守卫：session 正在执行任务时，loop 定时触发跳过本次执行
            loopScheduler.addBusyChecker(sessionId -> {
                if (sessionId == null || !sessionId.startsWith(SessionLocator.PREFIX_WORK)) {
                    return false;
                }
                return webGate.isSessionBusy(sessionId);
            });

            loopScheduler.addTaskExecutor((sessionId, prompt, agentName, task) -> {
                if (sessionId.startsWith(SessionLocator.PREFIX_WORK) == false) {
                    return null;
                }

                // 如果指定了 agentName，将 prompt 拼接为 @agentName prompt 格式
                // WebGate.onChatInput 内部通过 input.startsWith("@") 识别并路由到对应 agent
                String effectiveInput = prompt;
                if (agentName != null && !agentName.isEmpty()) {
                    effectiveInput = "@" + agentName + " " + prompt;
                }

                // 工作空间：任务显式指定优先（自动化页面选择的执行目录），否则回退会话注册表中的所属根。
                // 注意：任务绑定了前台会话时，该会话的所属根由用户决定，不得用任务 workspace 反向改绑——
                // safeChatInputAndCaptureLoop 会 bindSessionRoot（持久化），否则会静默改变用户会话的落盘与屒属目录。
                String projectRoot = (task != null && task.getBoundSessionId() == null && task.getWorkspace() != null)
                        ? task.getWorkspace()
                        : sessionLocator.boundRoot(sessionId);

                // Worktree 隔离：开启且本轮创建成功时，AI 应在工作树内作业。
                // 该目录仅本轮有效（执行完即被删除），故作为瞬态根单独传入，不得写入会话注册表。
                String worktreeRoot = task != null ? task.getActiveWorktreePath() : null;

                // 任务级附件：每轮都把附件注入本轮 Prompt（图片→多模态，文件→[附件: 绝对路径] 前缀）。
                // 目录口径与任务状态目录一致（engine.getWorkspace() 下的 loops/<taskId>/attachments），
                // 不受 task.workspace（执行目录）影响：工作区整体搬迁后仍可由当前 workspace 重新解析。
                List<String> attachmentPaths = task != null ? task.getAttachmentPaths() : null;
                List<String> attachmentTypes = task != null ? task.getAttachmentTypes() : null;
                java.nio.file.Path attachmentsDir = (attachmentPaths != null && !attachmentPaths.isEmpty())
                        ? LoopAttachments.dir(engine.getWorkspace(), task.getId())
                        : null;

                // Loop 任务可能长时间执行（数小时），使用 Loop 专用无限等待版本；
                // 透传工作空间根保证 __cwd 与落盘目录正确，并按任务定义应用模型、思考档位与上下文窗口
                return webGate.safeChatInputAndCaptureLoop(sessionId, projectRoot, worktreeRoot, effectiveInput, "Loop",
                        task != null ? task.getModelName() : null,
                        task != null ? task.getThinkingDepth() : null,
                        task != null ? task.getContextLength() : null,
                        task != null ? task.getAccessMode() : null,
                        attachmentsDir, attachmentPaths, attachmentTypes,
                        task != null ? task.getName() : null);
            });
        }
    }

    /**
     * 首页入口：将根路径请求转发到静态页面 index.html。
     *
     * <p>index.html 为轻量外壳，运行时装配 chat.html / code.html / settings.html 三个界面片段。</p>
     *
     * @param ctx 请求上下文
     * @throws Throwable 转发异常
     */
    @Get
    @Mapping("/")
    public void index(Context ctx) throws Throwable {
        ctx.forward("/index.html");
    }

    /**
     * 页面元信息接口：供前端启动时一次性获取应用标题、版本号、工作区路径等基础信息。
     *
     * <p>除原有字段外额外并列输出构建指纹 {@code buildId} / {@code buildTime}（来自 jar 内
     * {@code /build-info.properties}，由构建期生成）：桌面端覆盖安装若旧 jar 被占用而未真正替换，
     * 前端可据此自证「后端与桌面壳不是同一次构建」。{@code appVersion} 的语义与取值保持不变，
     * 不拼入任何构建信息。</p>
     *
     * @return 包含 appTitle、appVersion、workspace、workname、homeDir、buildId、buildTime 的结果对象
     * @throws Exception 读取配置异常
     */
    @Get
    @Mapping("/web/chat/meta")
    public Result<Map> meta() {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("appTitle", Solon.cfg().appTitle());
        data.put("appVersion", AgentFlags.getVersion());
        data.put("workspace", engine.getWorkspace());
        data.put("workname", getLastSegment(engine.getWorkspace()));
        data.put("homeDir", AgentFlags.getUserHome());
        data.put("buildId", BuildInfo.getBuildId());
        data.put("buildTime", BuildInfo.getBuildTime());
        // 远端部署模式标记：桌面端 SSH 部署链注入 -Dgwork.remote=true（远程工作区 P1）。
        // 前端据此渲染远程徽标；本地后端永远为 false，不影响既有行为。
        data.put("remote", AgentFlags.isRemoteDeployed());
        return Result.succeed(data);
    }

    /**
     * 从文件路径中提取最后一段（即文件名或目录名）。
     *
     * @param pathStr 完整文件路径字符串
     * @return 路径最后一段，若路径为空则返回空字符串
     */
    private static String getLastSegment(String pathStr) {
        Path path = Paths.get(pathStr);
        Path fileName = path.getFileName();
        return fileName == null ? "" : fileName.toString();
    }

    // ==================== 会话管理 ====================

    /**
     * 加载会话列表（统一 work- 会话，按所属根划分全局 / 项目两类）。
      * <p><b>root</b> 指定要查看的项目工作空间根；为空时扫描全局基准目录下的全局会话，
     * 否则返回该根下的<b>项目会话</b>并回填 projectRoot，供前端切换会话时恢复工作空间上下文
     * （X-Session-Cwd）。</p>
     * <p>扫描目录为全局区（root 为空或恰等于安装目录）时，物理目录可能混入另一类会话
     * （如同一会话因发送时工作空间状态不同而在全局区与项目区各写一份）：此时按登记表
     * {@link SessionLocator#boundRoot(String)} 切分——全局视图仅留未登记，项目视图仅留已登记。</p>
     *
     * @param root 要扫描的工作空间根目录绝对路径（为空时扫全局区）
     * @return 会话列表，每项包含 sessionId、label、time、projectRoot（仅项目会话回填）；
     * time 为最后活动时间（数据文件 mtime 最大值，见 {@link #lastActivityOf(File, String)}）
     * @throws Exception 文件读取异常
     */
    @Get
    @Mapping("/web/chat/sessions")
    public Result<List<Map>> sessions(@Param(value = "root", required = false) String root) throws Exception {
        List<Map> data = new ArrayList<>();

        // root 为空必须扫描全局基准目录；显式 root 始终扫描对应项目根
        boolean isGlobal = Assert.isEmpty(root);
        String effectiveRoot = isGlobal ? null : root;
        collectSessions(isGlobal ? sessionLocator.globalSessionsRoot() : sessionLocator.sessionsRoot(effectiveRoot),
                isGlobal ? null : effectiveRoot, data);

        // 仅全局视图按登记表切分：全局目录中可能残留已绑定项目会话的空壳/副本。
        if (isGlobal) {
            data.removeIf(item -> sessionLocator.boundRoot((String) item.get("sessionId")) != null);
        }

        // 标记定时任务占用的会话（运行时会话/绑定会话）：前端侧栏据此在条目名前渲染时钟小图标
        if (loopScheduler != null) {
            Set<String> loopSids = loopScheduler.loopSessionIds();
            if (!loopSids.isEmpty()) {
                for (Map item : data) {
                    if (loopSids.contains(item.get("sessionId"))) item.put("loop", true);
                }
            }
        }

        // 按时间倒序
        data.sort((a, b) -> Long.compare(
                ((Number) b.getOrDefault("time", 0L)).longValue(),
                ((Number) a.getOrDefault("time", 0L)).longValue()));

        return Result.succeed(data);
    }

    /**
     * 使用统计：聚合<b>全局对话区</b>所有会话的 token 消耗、活跃度与模型分布，
     * 供设置面板「使用统计」页展示。数据源为各会话 {@code stream.ndjson} 中的 {@code trace} 事件，
     * 无需额外埋点（见 {@link UsageStatsService}）。
     *
     * @param days 统计天数：0 = 累计至今（全部历史），7 = 最近 7 天（兼容旧页面），其它值收敛到 30（默认 30）
     * @return 结构化统计结果（概览指标 + 趋势序列 + 模型分布；趋势粒度随跨度自适应，见 {@code granularity}）
     */
    @Get
    @Mapping("/web/chat/usage/stats")
    public Result<Map> usageStats(@Param(value = "days", required = false, defaultValue = "30") int days) {
        return Result.succeed(usageStatsService.compute(days));
    }

    /** 规范化项目工作空间根，用于兼容调用方的路径比较。 */
    private static String normalizeRoot(String r) {
        if (r == null) return "";
        try {
            return java.nio.file.Paths.get(r.trim()).toAbsolutePath().normalize().toString();
        } catch (Exception e) {
            return r.trim();
        }
    }

    /**
     * 扫描指定目录下统一前缀（work-）的会话文件夹，追加到结果列表。
     *
     * @param sessionsDir 会话根目录
     * @param root        本次扫描所用的工作空间根（用于回填 projectRoot；null = 全局会话不回填）
     * @param data        结果收集列表
     */
    private void collectSessions(File sessionsDir, String root, List<Map> data) {
        if (sessionsDir == null || !sessionsDir.exists() || !sessionsDir.isDirectory()) {
            return;
        }
        File[] dirs = sessionsDir.listFiles(f -> f.isDirectory() && f.getName().startsWith(SessionLocator.PREFIX_WORK));
        if (dirs == null) {
            return;
        }
        // 排序与列表时间同源：取「最后活动时间」（数据文件 mtime 最大值），而非目录 mtime
        Arrays.sort(dirs, Comparator.comparingLong((File d) -> lastActivityOf(d, d.getName())).reversed());

        for (File dir : dirs) {
            String sid = dir.getName();

            // 优先使用自定义标签
            String label = null;
            File labelFile = new File(dir, "label.txt");
            if (labelFile.exists()) {
                try (BufferedReader lblReader = new BufferedReader(
                        new InputStreamReader(new FileInputStream(labelFile), "UTF-8"))) {
                    label = lblReader.readLine();
                } catch (Exception ignored) {
                }
            }

            if (Assert.isEmpty(label)) {
                File msgFile = new File(dir, sid + ".messages.ndjson");
                if (!msgFile.exists()) continue;

                label = extractFirstUserMessage(msgFile);
            }

            if (Assert.isEmpty(label)) {
                continue;
            }

            Map<String, Object> item = new LinkedHashMap<>();
            item.put("sessionId", sid);
            item.put("label", label.length() > 30 ? label.substring(0, 30) + "..." : label);
            item.put("time", lastActivityOf(dir, sid));
            // 回填会话所属工作空间根：前端切换到历史会话时据此恢复工作空间上下文，
            // 保证发送时 X-Session-Cwd 指向正确目录（否则回退安装目录 → 会话定位错乱）。
            // 此处 root 即本次扫描所用工作空间根（null = 全局会话，不回填）。
            if (Assert.isNotEmpty(root)) {
                item.put("projectRoot", root);
            }
            data.add(item);

            //恢复定时任务（仅统一前缀 web 会话，扫描安装目录）
            if (loopScheduler != null && sid.startsWith(SessionLocator.PREFIX_WORK)) {
                loopScheduler.restore(sid, engine.getWorkspace(), engine.getHarnessSessions());
            }
        }
    }

    /**
     * 会话「最后活动时间」：取会话数据文件（messages/snapshot/stream）最后修改时间的最大值，
     * 均不存在时回退目录自身 mtime。
     *
     * <p>不能用目录自身的 mtime：向已有文件追加内容（正常聊天、跑任务落盘）不会刷新目录 mtime，
     * 会让活跃会话显得越来越旧；而目录内新增/删除条目（传附件、建账本、改名）反而会刷新它，
     * 让无关动作把会话伪装成「刚刚更新」。数据文件 mtime 与真实活动同源。</p>
     *
     * @param dir 会话目录
     * @param sid 会话 ID
     * @return 最新数据文件 mtime；无数据文件时回退目录 mtime
     */
    static long lastActivityOf(File dir, String sid) {
        long latest = 0L;
        for (String suffix : ACTIVITY_FILE_SUFFIXES) {
            File f = new File(dir, sid + suffix);
            if (f.isFile()) {
                latest = Math.max(latest, f.lastModified());
            }
        }
        return latest > 0L ? latest : dir.lastModified();
    }

    /**
     * 删除指定会话及其所有消息记录。
     * <p>执行路径安全检查后，递归删除会话目录下的所有文件。</p>
     *
     * @param sessionId 待删除的会话 ID（统一 work- 前缀）
     * @return 操作结果
     * @throws Exception 文件删除异常
     */
    @Post
    @Mapping("/web/chat/sessions/delete")
    public Result deleteSession(@Param("sessionId") String sessionId,
                                @Param(value = "root", required = false) String root) throws Exception {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure();
        }

        // 清理 IM 通道绑定：如果此会话绑定了 IM 通道，需要解绑
        webGate.getStreamBuilder().cleanupSession(sessionId);

        // 中断在途流（若正在运行）：dispose 底层订阅，避免删除后在途 run 继续把 stream 文件“复活”。
        // 必须先于 engine.removeSession（interruptSession 需要从引擎取会话拿 disposable）；
        // 内部自带完整异常处理，非运行态返回 not_running，不会阻断删除流程。
        webGate.interruptSession(sessionId);

        // 驱逐内存中的会话缓存：必须先于删目录，否则残留的
        // FileAgentSession 会在在途轮次/循环任务等场景下重建 messages/snapshot
        // 文件，导致目录非空删不掉、累计空垃圾文件夹
        engine.removeSession(sessionId);
        webGate.cleanupSession(sessionId);

        // 清理流式账本（长驻 Writer 句柄、待写缓冲、seq 缓存与 stream 文件本身）：必须先于删目录。
        // ① Windows 下长驻句柄未关闭时 deleteDirectory 必失败（500「会话目录删除失败」）；
        // ② 待写缓冲若不丢弃，清扫线程最迟 ~400ms 后会在已删目录里重建文件（writerFor 会 mkdirs）。
        // 覆盖口径与下方 allKnownSessionDirs 一致：全局区 + 显式根 + 全部已登记项目根。
        SessionStreamStore streamStore = webGate.getStreamStore();
        if (streamStore != null) {
            streamStore.delete(sessionId, null);
            if (Assert.isNotEmpty(root)) {
                streamStore.delete(sessionId, root);
            }
            for (String registeredRoot : sessionLocator.registeredRoots()) {
                streamStore.delete(sessionId, registeredRoot);
            }
        }

        // 在解绑之前枚举全部已知落点：root 为空的项目会话仍需依赖登记表定位项目真身；
        // 若先 unbind，会错误回退到全局目录，只删掉空壳而遗留项目数据。
        // 历史版本曾把同一会话的数据拆到全局区与项目区两份（分居），因此按
        // 全局区 + 显式根 + 全部已登记根逐一清理，避免「删除后仍有残留副本」。
        java.util.List<File> sessionDirs = sessionLocator.allKnownSessionDirs(sessionId, root);
        // 同一口径解析会话所属根：供过渡期清理旧版全局账本目录（<root>/.gwork/file-changes）
        String sessionRoot = sessionLocator.effectiveRoot(sessionId, root);

        // 清除所属根登记，避免注册表残留
        sessionLocator.unbind(sessionId);

        // 过渡期清理：新布局账本在会话目录内（随下方递归删除一并清掉）；
        // 旧版账本目录独立于会话之外，必须显式按会话清理，否则会留下「会话已删、账本残留」。
        FileChangeService.getInstance().removeSession(sessionId, sessionRoot);

        for (File sessionDir : sessionDirs) {
            if (sessionDir.exists() && sessionDir.isDirectory()) {
                if (!deleteDirectory(sessionDir)) {
                    LOG.warn("Delete session dir failed (may be occupied): {}", sessionDir.getAbsolutePath());
                    return Result.failure(500, "会话目录删除失败，可能被占用：" + sessionDir.getAbsolutePath());
                }
            }
        }

        return Result.succeed();
    }

    /**
     * 重命名会话标签。
     * <p>在会话目录下写入 label.txt 文件保存自定义标签，标签最大长度 50 字符。</p>
     *
     * @param sessionId 待重命名的会话 ID
     * @param label     新的会话标签文本
     * @return 操作结果
     * @throws Exception 文件写入异常
     */
    @Post
    @Mapping("/web/chat/sessions/rename")
    public Result renameSession(@Param("sessionId") String sessionId, @Param("label") String label,
                                @Param(value = "root", required = false) String root) throws Exception {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure();
        }
        if (label == null || label.trim().isEmpty()) {
            return Result.failure(400, "Label is required");
        }
        // 限制标签长度
        if (label.length() > 50) {
            label = label.substring(0, 50);
        }

        File sessionDir = sessionLocator.resolveDir(sessionId, root);
        File labelFile = new File(sessionDir, "label.txt");

        if (!sessionDir.exists() || !sessionDir.isDirectory()) {
            return Result.failure(404, "Session not found");
        }

        java.nio.file.Files.write(labelFile.toPath(), label.trim().getBytes("UTF-8"));

        return Result.succeed();
    }

    /**
     * 查询可用 AI 模型列表及当前选中模型。
     * <p>从引擎配置中获取所有可用模型，若指定了 sessionId 则返回该会话当前选中的模型，
     * 否则返回引擎默认主模型。</p>
     *
     * @param sessionId 可选的会话 ID，用于获取该会话当前选中的模型
     * @return 包含 list（模型列表）和 selected（当前选中模型名）的结果对象
     * @throws Exception 会话查询异常
     */
    @Get
    @Mapping("/web/chat/models")
    public Result<Map> models(@Param(value = "sessionId", required = false) String sessionId) throws Exception {
        Map<String, Object> data = new LinkedHashMap<>();
        List<Map> list = new ArrayList<>();

        // 模型列表按 settings 中的配置顺序输出（LinkedHashMap 保序），不再按名称排序：
        // 对话页 / 专注模式右栏 / 自动化任务的模型选择器均以此顺序分组展示。
        // 运行时 engine 的模型集为无序 Map，故此处以配置为唯一顺序来源。
        for (ModelDo config : settings.getModels().values()) {
            if (config.isEnabled()) {
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("model", config.getModel());
                item.put("name", config.getNameOrModel());
                item.put("description", config.getDescriptionOrModel());
                item.put("standard", config.getStandardOrProvider());
                // 所属供应商：前端据此对模型下拉做分组展示
                item.put("provider", config.getProvider());
                // 该模型真正可区分的思考档位（策略 S2）。
                // 档位本身是全局统一的 5 档，但各模型能区分几档各不相同：
                // 若模型只支持单一 effort 值，渲染 5 档会让用户误以为选了有效果，
                // 实际全部发同一个值。空列表 = 无可调档位，前端应隐藏整个选择器。
                item.put("thinkingLevels", ThinkingDepth.selectableCodes(
                        config.getStandardOrProvider(), config.getModel(), config.getCapabilities()));
                list.add(item);
            }
        }

        data.put("list", list);

        // 当前会话的思考深度档位（无会话时给默认 auto），供前端初始化切换器
        String thinkingDepth = ThinkingDepth.AUTO;
        // 当前会话的上下文窗口：与思考档位同为会话级用户选择，无会话时给固定默认
        long contextLength = ContextLengthPolicy.DEFAULT_CONTEXT_LENGTH;
        // 当前会话的访问控制档位（无会话时给默认 default），供前端初始化档位切换器
        String accessMode = AccessMode.DEFAULT.code();

        if (Assert.isNotEmpty(list)) {
            if (Assert.isNotEmpty(sessionId)) {
                AgentSession session = engine.getSession(sessionId);
                String selected = session.getContext().getAs(HarnessEngine.CTX_MODEL_SELECTED);

                if (selected != null) {
                    selected = engine.getModelOrDef(selected).getNameOrModel();
                } else {
                    selected = engine.getModelOrDef(null).getNameOrModel();
                }

                data.put("selected", selected);

                thinkingDepth = ThinkingDepth.normalize(session.getContext().getAs(HarnessEngine.CTX_THINKING_DEPTH));
                contextLength = ContextLengthPolicy.resolve(session);
                accessMode = AccessMode.normalize(session.getContext().getAs(AccessMode.CTX_KEY)).code();
            } else {
                data.put("selected", engine.getModelOrDef(null).getNameOrModel());
            }
        } else {
            data.put("selected", "");
        }

        data.put("thinkingDepth", thinkingDepth);
        // 上下文窗口不再按模型下发：全局固定选项 + 当前会话选择 + 默认值
        data.put("contextLength", contextLength);
        data.put("contextLengthDefault", ContextLengthPolicy.DEFAULT_CONTEXT_LENGTH);
        data.put("contextOptions", ContextLengthPolicy.options());
        // 会话级访问控制档位（default / full），供前端初始化档位切换器
        data.put("accessMode", accessMode);

        return Result.succeed(data);
    }

    /**
     * 读取会话最近一次 Loop 定时任务执行的取证参数（供执行视图「任务运行参数」提示条恢复）。
     *
     * <p>背景：Loop 任务的模型/思考/上下文/权限是 per-turn transient 的，刻意不写入会话上下文
     * （避免污染用户前台选择），执行会话 composer 回显的永远是会话自己的旧值，用户会误判
     * 「参数没生效/与自动化表单对不上」。Loop 轮首把本轮实际生效值写入会话取证键
     * （{@link HarnessEngine#CTX_LOOP_RUN}，随快照持久化），本端点负责读回。</p>
     *
     * <p><b>单一数据源（2026-10-17 review 修订）：</b>{@link HarnessEngine#getSession} 永不返回
     * null（LRU 未命中即从磁盘快照加载，见 Configurator 的 sessionProvider），故内存会话就是
     * 唯一权威现态——快照加载时取证键随 FlowContext 一并还原（反序列化经 toBean(Map.class)，
     * 值必为 Map）。旧实现另有的「快照文件兜底 / 旧快照派生」两条路径在该前提下永不可达
     * （死代码），且任意 sessionId（含空串）的 GET 都会物化一个幽灵会话（构造时全量加载
     * messages+snapshot），故一并删除；空 sessionId 在此显式拒绝。</p>
     *
     * <p>无取证（该会话从未跑过 Loop 或最近一轮是前台对话）返回 null，前端隐藏提示条。</p>
     */
    @Get
    @Mapping("/web/chat/loop-run")
    public Result loop_run(@Param("sessionId") String sessionId,
                           @Param(value = "root", required = false) String root) {
        if (sessionId == null || sessionId.isEmpty() || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure(400, "Invalid sessionId");
        }

        // 内存会话为权威现态：前台轮已清除取证时，快照里的旧取证不得再冒出来误导提示条
        AgentSession session = engine.getSession(sessionId);
        Object raw = session.getContext().get(HarnessEngine.CTX_LOOP_RUN);
        Map<String, Object> evidence = null;
        if (raw instanceof Map) {
            evidence = loopRunEvidenceFromContext(raw);
        } else if (raw instanceof ONode && !((ONode) raw).isNull()) {
            // 防御分支：当前反序列化链路（FlowContextDefault.fromJson → toBean(Map.class)）
            // 恒产出 Map；保留此分支以防 snack4 行为变化时取证被静默丢弃。
            evidence = loopRunEvidenceFromContext(((ONode) raw).toBean(Map.class));
        }
        return Result.succeed(evidence);
    }

    /** 把上下文/快照中的取证原始值规整为端点输出形态；缺失或形态不符返回 null。 */
    private static Map<String, Object> loopRunEvidenceFromContext(Object raw) {
        if (!(raw instanceof Map)) {
            return null;
        }
        // 先拷成 Map<String,Object>：Map<?,?> 的 getOrDefault 第二参受 capture 泛型约束，String 字面量不兼容
        Map<String, Object> src = new LinkedHashMap<>();
        for (Map.Entry<?, ?> e : ((Map<?, ?>) raw).entrySet()) {
            src.put(String.valueOf(e.getKey()), e.getValue());
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("name", String.valueOf(src.getOrDefault("name", "")));
        out.put("model", String.valueOf(src.getOrDefault("model", "")));
        out.put("thinkingDepth", String.valueOf(src.getOrDefault("thinkingDepth", "")));
        out.put("contextLength", ContextLengthPolicy.normalize(src.get("contextLength")));
        out.put("accessMode", AccessMode.normalize(src.get("accessMode")).code());
        Object at = src.get("at");
        out.put("at", at instanceof Number ? ((Number) at).longValue() : 0L);
        return out;
    }

    /**
     * 切换指定会话的 AI 模型。
     * <p>将目标模型名称写入会话上下文并更新快照，后续该会话的 AI 交互将使用新模型。</p>
     *
     * @param sessionId 会话 ID
     * @param modelName 目标模型名称
     * @return 操作结果
     * @throws Exception 会话操作异常
     */
    @Post
    @Mapping("/web/chat/models/select")
    public Result models_select(@Param("sessionId") String sessionId, @Param("modelName") String modelName) throws Exception {
        AgentSession session = engine.getSession(sessionId);

        session.getContext().put(HarnessEngine.CTX_MODEL_SELECTED, modelName);

        session.updateSnapshot();

        return Result.succeed();
    }

    /**
     * 切换指定会话的思考深度（推理力度）。
     * <p>写入会话上下文；后续该会话的 AI 交互会按当前模型的接口类型把档位翻译成对应参数
     * （见 {@link ThinkingDepth}）。档位取值随接口不同（openai/gemini 为 minimal/low/medium/high，
     * anthropic 为 low/medium/high 等），本端点只存规范化后的编码，接口适配在注入时进行。
     * 与模型选择同理走独立端点，确保不经 /web/chat/input 的命令（如 /git、循环任务）也能感知到变更。</p>
     *
     * @param sessionId 会话 ID
     * @param depth     档位编码（off / minimal / low / medium / high 等，按接口而定）
     * @return 操作结果（回显规范化后的档位）
     * @throws Exception 会话操作异常
     */
    @Post
    @Mapping("/web/chat/thinking/select")
    public Result thinking_select(@Param("sessionId") String sessionId, @Param("depth") String depth) throws Exception {
        AgentSession session = engine.getSession(sessionId);

        String normalized = ThinkingDepth.normalize(depth);
        session.getContext().put(HarnessEngine.CTX_THINKING_DEPTH, normalized);

        session.updateSnapshot();

        return Result.succeed(normalized);
    }

    /**
     * 切换指定会话的上下文窗口。
     *
     * <p>上下文窗口已从「每个模型逐个配置」改为「会话级用户选择」：模型多时无需逐个维护，
     * 同一模型在不同会话也可用不同窗口。写入后压缩预算、单条消息截断与上下文用量指示器
     * 共享同一个值，不存在「压缩按 A、界面显示 B」的双源不一致。</p>
     *
     * <p>与模型选择同理走独立端点，确保不经 {@code /web/chat/input} 的命令
     * （如 /git、循环任务）也能感知变更。</p>
     *
     * @param sessionId     会话 ID
     * @param contextLength 目标上下文窗口（必须是固定选项之一）
     * @return 操作结果（回显生效的窗口值）
     * @throws Exception 会话操作异常
     */
    @Post
    @Mapping("/web/chat/context/select")
    public Result context_select(@Param("sessionId") String sessionId,
                                 @Param("contextLength") String contextLength) throws Exception {
        // sessionId 安全校验：空/含路径分隔符或 .. 的直接拒绝，不进入会话解析
        if (Assert.isEmpty(sessionId)
                || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure("invalid_session");
        }

        Long parsed = ContextLengthPolicy.parse(contextLength);
        if (parsed == null || !ContextLengthPolicy.isAllowed(parsed.longValue())) {
            // 非法值一律拒绝，而不是静默写入：否则会话会停在一个前端永远渲染不出的档位上
            return Result.failure(400, "Unsupported contextLength: " + contextLength);
        }

        AgentSession session = engine.getSession(sessionId);
        ContextLengthPolicy.set(session, parsed.longValue());
        session.updateSnapshot();

        return Result.succeed(parsed);
    }

    /**
     * 切换指定会话的访问控制档位。
     *
     * <p>与模型/思考档位/上下文窗口同理走独立端点，确保不经 {@code /web/chat/input} 的命令
     * （如 /git、循环任务）也能感知变更；档位写入会话上下文并随快照持久化。</p>
     *
     * @param sessionId  会话 ID
     * @param accessMode 目标档位（default / full，必须为合法码值）
     * @return 操作结果（回显规范化后的档位）
     * @throws Exception 会话操作异常
     */
    @Post
    @Mapping("/web/chat/access/select")
    public Result access_select(@Param("sessionId") String sessionId,
                                @Param("accessMode") String accessMode) throws Exception {
        // sessionId 安全校验：与 context_select 同款，不进入会话解析
        if (Assert.isEmpty(sessionId)
                || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure("invalid_session");
        }

        if (!AccessMode.isAllowed(accessMode)) {
            // 非法值一律拒绝，而不是静默写入：否则会话会停在一个前端永远渲染不出的档位上。
            // 【口径钉死】本端点是「主动切换」语义，拼错必须可感知；
            // 而 /web/chat/input 携带的 accessMode 不校验（非法即回落默认档），
            // 与「未声明者一律默认档」同语义——两处取向相反是刻意的，勿对齐。
            return Result.failure(400, "Unsupported accessMode: " + accessMode);
        }

        AgentSession session = engine.getSession(sessionId);
        session.getContext().put(AccessMode.CTX_KEY, AccessMode.normalize(accessMode).code());

        // 切到完全访问时，必须把「仍在等审批的那张卡」一并解除。
        //
        // 旧实现只写档位 + 更新快照：那张挂起卡会永远停在会话里（快照带 _last_intervened_ /
        // _pending_reason_，刷新或重开会话还会被回放出来），而它代表的命令在新档位下本就不需要审批。
        // 实测样本 work-mvhqk622：_access_mode=full 却残留 _pending_reason_=「当前为默认权限…」。
        //
        // 只清挂起态、不自动跑命令：清掉后模型可重新发起调用，届时按新档位放行，
        // 用户无需面对一张永远点不下去的旧卡（其 decision 已不会被消费）。
        if (AccessMode.normalize(accessMode).isFull()) {
            HITLTask released = HITL.clearPending(session);
            // 补发释放帧：已落盘的 hitl 帧在重开会话时会被回放重新渲染成可点的死卡
            // （后端已无挂起任务，点批准只会 ACTION_MISMATCH → 前端回退 pending → 死循环）。
            // 本帧经 WebGate 出站即落盘 + 广播：实时页面立即收卡，回放时按序把旧卡收掉。
            if (released != null) {
                webGate.emitToClient(sessionId, WebChunk.ofHitlReleased(released.getActionId()));
            }
        }

        session.updateSnapshot();

        return Result.succeed(AccessMode.normalize(accessMode).code());
    }

    /**
     * 获取指定会话的消息历史记录。
     * <p>从 ndjson 消息文件中逐行读取，解析每条消息的 role、content、createdAt 字段。</p>
     *
     * @param sessionId 会话 ID
     * @return 消息列表，每项包含 role、content、createdAt
     * @throws Exception 文件读取异常
     */
    @Get
    @Mapping("/web/chat/messages")
    public Result<List<Map>> messages(@Param("sessionId") String sessionId,
                                      @Param(value = "root", required = false) String root) throws Exception {
        List<Map> data = new ArrayList<>();
        File sessionDir = sessionLocator.resolveDir(sessionId, root);
        File msgFile = new File(sessionDir, sessionId + ".messages.ndjson");

        if (msgFile.exists()) {
            try (BufferedReader br = new BufferedReader(
                    new InputStreamReader(new FileInputStream(msgFile), "UTF-8"))) {
                String line;
                while ((line = br.readLine()) != null) {
                    line = line.trim();
                    if (line.isEmpty()) continue;
                    ONode node = ONode.ofJson(line);
                    String role = node.get("role").getString();
                    String content = node.get("content").getString();

                    if (role != null && content != null) {
                        Map<String, Object> item = new LinkedHashMap<>();
                        item.put("role", role);
                        item.put("content", content);
                        item.put("createdAt", node.get("createdAt").getString());
                        data.add(item);
                    }
                }
            }
        }

        return Result.succeed(data);
    }

    /**
     * 获取指定会话的完整流式过程事件（供历史回放）。
     * <p>与 {@link #messages} 不同：{@code messages} 只返回每轮的最终 assistant 文本；
     * 本端点返回流经 {@code emitToClient} 的全部事件（推理、工具卡片、正文、trace 等），
     * 前端据此将历史会话的工具调用、过程叙述原样回放。无流式文件时返回空列表（
     * 前端回退到 {@code /web/chat/messages} 的纯文本加载）。</p>
     * <p>分页以<b>对话轮</b>为单位（{@code rounds} + {@code beforeSeq} 游标）：一次返回若干完整轮次，
     * 并附带 {@code remainingRounds}（还剩多少条用户消息）供前端展示与判断是否还能继续加载。
     * 不能按 ndjson 行分页——text/reason 是 token 级增量，占全部行的九成以上，
     * 「一页 N 行」实际连半轮对话都不到。{@code tail} 为兼容旧前端保留。</p>
     *
     * @param sessionId 会话 ID
     * @param root      可选项目根提示（code 模式）
     * @param tail      可选，只返回最后 tail 条事件（旧版行分页，保留兼容）
     * @param beforeSeq 可选，向上翻页游标：只返回 eventSeq 小于它的更早事件
     * @param rounds    可选，本页期望的对话轮数（配合 beforeSeq 使用）
     * @return 包含 events、totalRounds、remainingRounds、hasMore 的分页结果
     */
    @Get
    @Mapping("/web/chat/replay")
    public Result<Map> replay(@Param("sessionId") String sessionId,
                                      @Param(value = "root", required = false) String root,
                                      @Param(value = "tail", required = false) Integer tail,
                                      @Param(value = "afterSeq", required = false) Long afterSeq,
                                      @Param(value = "limit", required = false) Integer limit,
                                      @Param(value = "beforeSeq", required = false) Long beforeSeq,
                                      @Param(value = "rounds", required = false) Integer rounds) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure(400, "Invalid sessionId");
        }
        SessionStreamStore store = webGate.getStreamStore();
        if (store == null) {
            Map empty = new HashMap<>();
            empty.put("events", new ArrayList<>());
            empty.put("totalCount", 0);
            empty.put("totalRounds", 0);
            empty.put("remainingRounds", 0);
            empty.put("hasMore", false);
            return Result.succeed(empty);
        }
        String sessionRoot = resolveSessionRoot(sessionId, root);
        if (sessionRoot == null && Assert.isNotEmpty(root)) {
            return Result.failure(400, "Workspace root does not match the session binding");
        }
        SessionStreamStore.LoadResult lr;
        if (afterSeq != null) {
            lr = store.loadAfter(sessionId, sessionRoot, Math.max(0L, afterSeq), limit);
        } else if (rounds != null || beforeSeq != null) {
            lr = store.loadRounds(sessionId, sessionRoot, beforeSeq, rounds);
        } else {
            // 无参全量分支是历史遗留的裸露后门：老前端不传任何分页参数时，会把整个 stream 文件
            // 读进内存并一次性回传，而线上已存在 132MB 的单会话文件。此处给 tail==null 一个默认上限，
            // 与 smart-socket 的响应体栈溢出防线（SessionStreamStore 内的字节预算）形成双保险：
            // 前者限事件条数、避免 OOM 与长 GC，后者限响应字节、避免 StackOverflowError。
            // 显式传 tail 的调用方行为不变。
            lr = store.loadWithMeta(sessionId, sessionRoot,
                    tail != null ? tail : SessionStreamStore.DEFAULT_FULL_TAIL);
        }
        Map result = new HashMap<>();
        result.put("events", lr.events);
        result.put("totalCount", lr.totalCount);
        result.put("totalRounds", lr.totalRounds);
        result.put("remainingRounds", lr.remainingRounds);
        result.put("hasMore", lr.hasMore);
        result.put("firstSeq", lr.firstSeq);
        result.put("lastSeq", lr.lastSeq);
        result.put("latestSeq", lr.latestSeq);
        result.put("running", webGate.isSessionBusy(sessionId));
        // 当前活跃 run 的 runId（无运行中 run 时为 null）。前端据此校准可能被历史回放写成陈旧值的
        // activeRunId：否则中断请求会因 runId 不匹配被后端判为 turn_changed，重试也依旧空转。
        result.put("runId", webGate.getCurrentRunId(sessionId));
        return Result.succeed(result);
    }

    /**
     * 按行号 {@code seq} 回取单个超长工具结果块的<b>完整全文</b>（供前端对 {@code /web/chat/replay}
     * 返回的被预览截断（{@code truncated=true}）的块“点击展开”时按需拉取）。{@code seq} 即 replay
     * 回传的同名字段，与磁盘物理行一一对应。</p>
     *
     * @param sessionId 会话 ID
     * @param seq       目标块的行号（replay 返回的 {@code seq}）
     * @param root      可选项目根提示（code 模式）
     * @return 该块完整 text；不存在时返回空串
     */
    @Get
    @Mapping("/web/chat/replay/full")
    public Result<String> replayFull(@Param("sessionId") String sessionId,
                                     @Param("seq") int seq,
                                     @Param(value = "root", required = false) String root) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure(400, "Invalid sessionId");
        }
        SessionStreamStore store = webGate.getStreamStore();
        if (store == null) {
            return Result.succeed("");
        }
        String sessionRoot = resolveSessionRoot(sessionId, root);
        if (sessionRoot == null && Assert.isNotEmpty(root)) {
            return Result.failure(400, "Workspace root does not match the session binding");
        }
        String full = store.loadFull(sessionId, sessionRoot, seq);
        return Result.succeed(full != null ? full : "");
    }

    /*
     * <p>执行 sessionId 安全校验后，委派给 WebGate 中断该会话正在进行的 AI 任务。</p>
     *
     * @param sessionId 待中断的会话 ID
     * @return 操作结果
     */
    @Post
    @Mapping("/web/chat/interrupt")
    public Result<Map<String, Object>> interruptSession(@Param("sessionId") String sessionId,
                                                        @Param("runId") String runId) {
        if (Assert.isEmpty(sessionId)
                || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure("invalid_session");
        }
        String status = webGate.interruptSession(sessionId, runId);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("status", status);
        return "cancelled".equals(status) ? Result.succeed(data) : Result.failure(status, data);
    }

    /**
     * 接收一条即时插话请求。
     *
     * <p>HTTP 200 + accepted 仅表示已进入邮箱，实际生效须等待 steer_applied 或 steer_dropped 事件。</p>
     *
     * <p>附件以【会话内相对路径】传递，须先经 {@code /web/chat/attachment/upload} 落盘：
     * 插话协议是纯文本表单，承载不了 File 对象，而邮箱可能滞留多条插话，也不适合缓存 base64。</p>
     */
    @Post
    @Mapping("/web/chat/steer")
    public Result<Map<String, Object>> steer(Context ctx,
            @Param String sessionId,
            @Param String runId,
            @Param String steerId,
            @Param String text) {
        // sessionId 安全校验（复用现有逻辑）
        if (Assert.isEmpty(sessionId)) sessionId = ctx.header("X-Session-Id");
        if (Assert.isEmpty(sessionId)) sessionId = "web";
        if (sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure("INVALID_SESSION");
        }
        // 附件路径是重复表单键，用 paramValues 显式取全量（@Param 数组绑定不保证同口径）
        String[] imagePaths = ctx.paramValues("imagePaths");
        String[] filePaths = ctx.paramValues("filePaths");
        boolean hasAttachments = (imagePaths != null && imagePaths.length > 0)
                || (filePaths != null && filePaths.length > 0);
        // 参数校验：纯附件插话（只贴图不打字）同样合法，与发送主链路的空输入兜底一致
        if ((Assert.isEmpty(text) || text.trim().isEmpty()) && !hasAttachments) {
            return Result.failure("EMPTY_TEXT");
        }
        if (text != null && text.codePointCount(0, text.length()) > SteerInterceptor.MAX_TEXT_LENGTH) {
            return Result.failure("TEXT_TOO_LONG");
        }
        if (Assert.isEmpty(steerId)) {
            return Result.failure("MISSING_STEER_ID");
        }
        String result = webGate.steer(sessionId, runId, steerId, text,
                Arrays.asList(imagePaths == null ? new String[0] : imagePaths),
                Arrays.asList(filePaths == null ? new String[0] : filePaths));
        Map<String, Object> resp = new java.util.LinkedHashMap<>();
        resp.put("status", result);
        if ("accepted".equals(result) || "duplicate".equals(result)) {
            return Result.succeed(resp);
        } else {
            // not_running / turn_changed / box_full 返回语义失败，让前端降级
            return Result.failure(result, resp);
        }
    }

    /**
     * 回退会话消息：删除指定会话最近 N 条消息记录。
     * <p>仅操作 ndjson 持久化文件（内存中的 AgentSession 会在重新生成时通过新的 prompt 重建上下文）。
     * 默认回退 2 条（即一对用户消息 + 助手回复）。</p>
     *
     * @param sessionId 会话 ID
     * @param count     回退条数，默认为 2
     * @return 操作结果
     * @throws Exception 文件读写异常
     */
    @Post
    @Mapping("/web/chat/rewind")
    public Result rewindSession(@Param("sessionId") String sessionId, @Param(value = "count", required = false) Integer count,
                                @Param(value = "root", required = false) String root) throws Exception {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure();
        }
        if (count == null || count <= 0) {
            count = 2; // 默认回退2条（用户+助手）
        }

        try {
            String sessionRoot = resolveSessionRoot(sessionId, root);
            if (sessionRoot == null && Assert.isNotEmpty(root)) {
                return Result.failure(400, "Workspace root does not match the session binding");
            }
            // 只操作 ndjson 文件（内存中的 AgentSession 在重新生成时会通过新的 prompt 重建上下文）
            File sessionDir = sessionLocator.resolveDir(sessionId, sessionRoot);
            File msgFile = new File(sessionDir, sessionId + ".messages.ndjson");
            List<String> retained = new ArrayList<>();
            if (msgFile.exists()) {
                try (BufferedReader br = new BufferedReader(
                        new InputStreamReader(new FileInputStream(msgFile), java.nio.charset.StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = br.readLine()) != null) {
                        line = line.trim();
                        if (!line.isEmpty()) retained.add(line);
                    }
                }
                int keep = Math.max(0, retained.size() - Math.min(count, retained.size()));
                retained = new ArrayList<>(retained.subList(0, keep));
                atomicWriteLines(msgFile.toPath(), retained);
            }

            // 依据裁剪后 messages 的真实角色状态裁剪 stream。奇数 count 可能留下末尾 user，
            // 此时只保留该 user 边界，不保留其后已经被撤销的未完成 AI 过程。
            int retainedUsers = 0;
            boolean trailingUserOnly = false;
            for (String line : retained) {
                String role = ONode.ofJson(line).get("role").getString();
                if ("user".equals(role)) retainedUsers++;
                trailingUserOnly = "user".equals(role);
            }
            SessionStreamStore store = webGate.getStreamStore();
            if (store != null) {
                store.rewindToMessageState(sessionId, sessionRoot, retainedUsers, trailingUserOnly);
            }

            return Result.succeed();
        } catch (Exception e) {
            LOG.error("Rewind failed for session {}: {}", sessionId, e.getMessage());
            return Result.failure(500, e.getMessage());
        }
    }

    private String resolveSessionRoot(String sessionId, String requestedRoot) {
        try {
            String bound = sessionLocator == null ? null : sessionLocator.boundRoot(sessionId);
            if (Assert.isNotEmpty(bound)) {
                Path expected = realDirectory(bound);
                Path supplied = realDirectory(requestedRoot);
                requireSameRoot(supplied, expected);
                return expected.toString();
            }
            if (Assert.isEmpty(requestedRoot)) return null; // 未绑定即全局会话
            Path requested = realDirectory(requestedRoot);
            Path registered = realDirectory(projectService.resolveRegisteredDirectory(requested.toString()));
            if (!requested.equals(registered)) throw new IllegalArgumentException("Workspace root is not registered");
            return registered.toString();
        } catch (Throwable e) {
            LOG.warn("[Session] rejected workspace root for session {}: {}", sessionId, e.getMessage());
            return null;
        }
    }

    private static void atomicWriteLines(Path target, List<String> lines) throws Exception {
        Files.createDirectories(target.getParent());
        Path temp = Files.createTempFile(target.getParent(), target.getFileName() + ".", ".rewind.tmp");
        boolean moved = false;
        try {
            Files.write(temp, lines, java.nio.charset.StandardCharsets.UTF_8);
            try {
                Files.move(temp, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                        java.nio.file.StandardCopyOption.ATOMIC_MOVE);
            } catch (java.nio.file.AtomicMoveNotSupportedException e) {
                Files.move(temp, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
            moved = true;
        } finally {
            if (!moved) Files.deleteIfExists(temp);
        }
    }

    /**
     * 获取可用的命令和子代理列表。
     * <p>从引擎的命令注册表中获取所有非 CLI-Only 的命令，
     * 以及所有已注册的子代理（Agent），合并返回给前端用于命令补全和展示。</p>
     *
     * @return 命令/子代理列表，每项包含 name、description、type（command 或 subagent）
     */
    @Get
    @Mapping("/web/chat/hints")
    public Result<List<Map>> hints() {
        List<Map> data = new ArrayList<>();
        for (Command cmd : engine.getCommandRegistry().all()) {
            if (cmd.cliOnly()) {
                continue;
            }
            Map<String, String> item = new LinkedHashMap<>();
            item.put("name", cmd.name());
            item.put("description", cmd.description());
            item.put("type", "command");
            data.add(item);
        }

        for (AgentDefinition definition : engine.getAgentManager().getAgents()) {
            Map<String, String> item = new LinkedHashMap<>();
            item.put("name", definition.getName());
            item.put("description", definition.getDescription());
            item.put("type", "subagent");
            data.add(item);
        }

        Set<String> added = new HashSet<>();
        for (SkillDir skill : engine.getSkills()) {
            if (added.contains(skill.getName())) {
                continue;
            } else {
                added.add(skill.getName());
            }

            String desc = skill.getDescription();
            if (desc != null) {
                // 取第一行，并限制最大长度
                int newlineIdx = desc.indexOf('\n');
                if (newlineIdx > 0) {
                    desc = desc.substring(0, newlineIdx);
                }
                if (desc.length() > 30) {
                    desc = desc.substring(0, 30) + "...";
                }
            }

            Map<String, String> item = new LinkedHashMap<>();
            item.put("name", skill.getName());
            item.put("description", desc);
            item.put("type", "skill");
            data.add(item);
        }

        return Result.succeed(data);
    }

    /**
     * 聊天输入入口：解析请求参数后路由到 WebGate 处理。
     * <p>接收用户输入的文本消息、附件文件、模型选择和会话标识，
     * 经安全校验后委派给 {@link WebGate#onChatInput} 进行异步 AI 处理。
     * AI 处理结果通过 WebSocket 实时推送到前端，本接口仅返回简单成功响应。</p>
     *
     * @param ctx             请求上下文，用于读取请求头
     * @param input           用户输入的文本消息
     * @param attachments     上传的附件文件数组，可为 null
     * @param attachmentTypes 附件类型数组，与 attachments 一一对应
     * @param model           指定的 AI 模型名称，可为 null（使用默认模型）
     * @param sessionId       会话 ID，若为空则从请求头 X-Session-Id 获取
     * @param attachmentPaths 已落盘附件的会话内相对路径（{@code uploads/xxx}），可为 null；
     *                        供队列出队与插话降级重发使用——这两条通道手里只有路径没有 File
     * @param attachmentPathTypes 与 attachmentPaths 一一对应的类型声明（{@code image} / {@code file}）
     * @return 操作结果（AI 结果通过 WebSocket 推送）
     */
    @Mapping("/web/chat/input")
    public Result chat_input(Context ctx, String input, UploadedFile[] attachments, String attachmentTypes[], String model, String sessionId,
                             String[] attachmentPaths, String[] attachmentPathTypes) {
        try {
            if (sessionId == null || sessionId.isEmpty()) {
                sessionId = ctx.headerOrDefault("X-Session-Id", "web");
            }
            String sessionCwd = SessionCwdCodec.decode(ctx.header("X-Session-Cwd"));
            String clientMessageId = ctx.param("clientMessageId");

            if (sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
                ctx.status(400);
                ctx.output("Invalid Session ID");
                return null;
            }

            if (Assert.isNotEmpty(sessionCwd)) {
                if (sessionCwd.contains("..")) {
                    ctx.status(400);
                    ctx.output("Invalid Session Cwd");
                    return null;
                }
            }

            String hitlAction = ctx.param("hitlAction");
            String questionAnswer = ctx.param("questionAnswer");
            // 挂起任务身份标识：前端提交问答/审批时声明「正在回应哪一次调用」。
            // 不传时（旧前端）降级为旧行为，由 WebGate 记警告日志，见 WebGate#onChatInput 注释。
            String actionId = ctx.param("actionId");
            String accessMode = ctx.param("accessMode");

            // busy 请求不允许改变活动任务的会话根；真正的原子 busy 判定在 WebGate 输入锁内完成。
            // questionAnswer 与 hitlAction 一样属于“恢复已挂起任务”的输入，不按 busy 拒绝。
            if (Assert.isEmpty(hitlAction) && Assert.isEmpty(questionAnswer) && webGate.isSessionBusy(sessionId)) {
                return Result.succeed("busy");
            }

            // 根登记与最终受理都在 WebGate 中按同一会话串行处理；这里不提前改绑，
            // 避免预检通过后被并发任务抢先启动时污染活动会话根。

            // 路由到 WebGate 处理（AI 结果通过 WebSocket 推送到前端）
            // 网页端手动输入：source=null，出站不回推 IM（仅当活跃会话由 IM/Loop 触发时才回推）
            WebGate.InputResult accepted = webGate.onChatInput(sessionId, sessionCwd, input, model, attachments, attachmentTypes,
                    hitlAction, null, clientMessageId, questionAnswer, actionId, accessMode,
                    Arrays.asList(attachmentPaths == null ? new String[0] : attachmentPaths),
                    Arrays.asList(attachmentPathTypes == null ? new String[0] : attachmentPathTypes));
            if (accepted == WebGate.InputResult.BUSY) {
                return Result.succeed("busy");
            }
            if (accepted == WebGate.InputResult.ACTION_MISMATCH) {
                // 提交指向的不是当前挂起的那一次调用（旧页面/旧卡的迟到提交）。
                // 必须以明确错误拒绝，绝不能静默应用到别的任务上：HITL 误批准不可逆。
                // 用 409 而非 400：请求格式合法，是服务端状态已经变化导致的冲突。
                return Result.failure(409, "Action mismatch: the pending task has changed");
            }

            // 返回简单 JSON，前端通过 WebSocket 接收 AI 结果
            return Result.succeed();
        } catch (Throwable e) {
            LOG.error("[Web] chat_input error: {}", e.getMessage());
            return Result.failure(500, e.getMessage());
        }
    }

    /**
     * 附件预上传：把浏览器内存里的 File 落盘到会话 uploads 目录，返回可延后引用的相对路径。
     *
     * <p>存在的理由：插话协议是纯文本表单、队列协议存的是相对路径，两者都表达不了 File 对象。
     * 任务执行中用户带着附件按 Enter/Tab 时，先把附件落盘、再用路径走原有通道，
     * 附件才不会在「排队/插话」这一跳被静默丢掉。落盘不发起模型调用，运行中调用是安全的。</p>
     *
     * <p>与发送主链路共用 {@link WebGate#saveAttachments}，目录、命名与安全校验完全一致，
     * 因此「立即发送」与「延后发送」读到的是同一份文件。</p>
     *
     * @param attachments     待落盘的附件
     * @param attachmentTypes 与 attachments 一一对应的类型声明（{@code image} / {@code file}）
     * @return {@code items: [{path, type, name, size}]}，顺序与上传顺序一致
     */
    @Post
    @Mapping("/web/chat/attachment/upload")
    public Result<Map<String, Object>> attachmentUpload(Context ctx, UploadedFile[] attachments,
                                                        String[] attachmentTypes, String sessionId) {
        try {
            sessionId = getSessionId(ctx, sessionId);
            Assert.notNull(sessionId, "sessionId is required");
            validateSessionId(sessionId);

            if (attachments == null || attachments.length == 0) {
                return Result.failure("EMPTY_ATTACHMENT");
            }

            List<Map<String, Object>> items = webGate.saveAttachments(sessionId,
                    SessionCwdCodec.decode(ctx.header("X-Session-Cwd")), attachments, attachmentTypes);
            if (items.isEmpty()) {
                // 文件名全部非法：必须明确失败，让前端保留输入与附件，不能静默当成上传成功
                return Result.failure("INVALID_ATTACHMENT_NAME");
            }

            Map<String, Object> resp = new LinkedHashMap<>();
            resp.put("items", items);
            return Result.succeed(resp);
        } catch (Throwable e) {
            LOG.error("[Web] attachment upload error: {}", e.getMessage(), e);
            return Result.failure(500, e.getMessage());
        }
    }

    /**
     * 会话附件元信息：按相对路径返回 dataUrl / 名称 / 大小，供前端把附件数量徽标升级为真实缩略图。
     *
     * <p>队列出队与历史回放手里只有 {@code uploads/xxx} 相对路径，拿不到浏览器内存里的 File；
     * 本端点是它们回显附件内容的唯一通道。只接受 {@code uploads/<简单文件名>} 形态（复用
     * {@code sanitizeAttachmentPath} 的越界校验），图片返回 base64 dataUrl，非图片只回名称与大小。</p>
     *
     * @param sessionId 会话 ID
     * @param root      可选项目根提示（code 模式）
     * @return items 数组，顺序与入参一致；读盘失败的条目带 error 字段，前端自行降级。
     *         paths 是重复表单键（前端 jQuery traditional 传参），故用 {@code paramValues}
     *         显式取全量——@Param 单值绑定只会拿到其中一个，多图时会静默丢附件。
     */
    @Get
    @Mapping("/web/chat/attachment/meta")
    public Result<Map<String, Object>> attachmentMeta(Context ctx,
                                                      @Param("sessionId") String sessionId,
                                                      @Param(value = "root", required = false) String root) {
        try {
            sessionId = getSessionId(ctx, sessionId);
            Assert.notNull(sessionId, "sessionId is required");
            validateSessionId(sessionId);

            String[] pathParams = ctx.paramValues("paths");
            List<String> wanted = new ArrayList<>();
            if (pathParams != null) {
                for (String p : pathParams) {
                    if (p == null) continue;
                    String t = p.trim();
                    if (!t.isEmpty()) wanted.add(t);
                }
            }
            if (wanted.isEmpty()) {
                Map<String, Object> empty = new LinkedHashMap<>();
                empty.put("items", Collections.emptyList());
                return Result.succeed(empty);
            }
            // 批量上限：本端点按条读盘并对图片做 base64 内联，无上限时一次超大请求即可放大成
            // 长时间磁盘 IO 与巨型响应体。前端本就按 ATTACH_META_BATCH_SIZE(12) 分批，
            // 32 已留出裕量；超限直接 400，让调用方看到明确契约而不是被静默截断。
            if (wanted.size() > ATTACHMENT_META_MAX_PATHS) {
                return Result.failure(400, "TOO_MANY_PATHS");
            }

            // 与 /web/chat/replay 同口径解析工作空间根：resolveSessionRoot 会校验请求根与
            // 会话登记根一致，不一致（返回 null 且调用方确实传了 root）必须明确拒绝，
            // 否则会退化成「拿别人工作空间下的会话目录」去读附件。
            String sessionRoot = resolveSessionRoot(sessionId, root);
            if (sessionRoot == null && Assert.isNotEmpty(root)) {
                return Result.failure(400, "Workspace root does not match the session binding");
            }
            // 读取专用解析（带历史落点兜底），使数据落在 legacy workspace 目录的分叉会话也能读到附件。
            // 注意 resolveDirForRead 的 probe 走 isFile() 判定，而 uploads 是目录、probe 恒不命中，
            // 故此处按目录级自行回探：primary 无 uploads 目录时，在全部已知落点中找第一个有的，
            // 都无则回 primary（保持与写入侧同目录，missing 语义不变）。
            File sessionDir = sessionLocator.resolveDir(sessionId, sessionRoot);
            if (!new File(sessionDir, "uploads").isDirectory()) {
                for (File candidate : sessionLocator.allKnownSessionDirs(sessionId, sessionRoot)) {
                    if (new File(candidate, "uploads").isDirectory()) {
                        sessionDir = candidate;
                        break;
                    }
                }
            }
            List<Map<String, Object>> items = webGate.attachmentMeta(sessionDir, wanted);

            Map<String, Object> resp = new LinkedHashMap<>();
            resp.put("items", items);
            return Result.succeed(resp);
        } catch (Throwable e) {
            LOG.error("[Web] attachment meta error: {}", e.getMessage(), e);
            return Result.failure(500, e.getMessage());
        }
    }

    /**
     * 会话附件清单（只读）：列出 uploads 目录下的全部附件及其大小/时间，供任务监控面板展示。
     *
     * <p><b>WHY 不复用 {@code /web/chat/attachment/meta}</b>：meta 是「按已知路径回显内容」，
     * 会对图片做 base64 内联（单张最大 8MB、整批预算 24MB），且必须由调用方先提供 paths。
     * 面板需要的是「这个会话到底传过哪些附件」的目录级清单：若沿用 meta 会把整个 uploads
     * 目录编码成数十 MB 响应体。故本端点只回元信息（name/size/image/updatedAt），
     * <b>绝不内联 base64/dataUrl</b>；前端要缩略图时再拿 name 去调 meta。</p>
     *
     * <p>目录解析与 meta 完全同口径（含 L1285-1293 的历史落点回探）：数据落在 legacy
     * workspace 目录的分叉会话同样能列出来。</p>
     *
     * @param sessionId 会话 ID
     * @param root      可选项目根提示（code 模式）
     * @return {@code {items:[{name,size,image,updatedAt}], total}}；目录不存在时回 {@code {items:[],total:0}}
     */
    @Get
    @Mapping("/web/chat/attachment/list")
    public Result<Map<String, Object>> attachmentList(Context ctx,
                                                      @Param(value = "sessionId", required = false) String sessionId,
                                                      @Param(value = "root", required = false) String root) {
        try {
            sessionId = getSessionId(ctx, sessionId);
            Assert.notNull(sessionId, "sessionId is required");
            validateSessionId(sessionId);

            Map<String, Object> resp = new LinkedHashMap<>();
            resp.put("sessionId", sessionId);
            resp.put("items", Collections.emptyList());
            resp.put("total", 0);

            // 与 attachmentMeta 同口径的根校验：不一致（返回 null 且确实传了 root）必须明确拒绝，
            // 否则会退化成「拿别人工作空间下的会话目录」去枚举附件名。
            String sessionRoot = resolveSessionRoot(sessionId, root);
            if (sessionRoot == null && Assert.isNotEmpty(root)) {
                return Result.failure(400, "Workspace root does not match the session binding");
            }
            File sessionDir = resolveAttachmentSessionDir(sessionId, sessionRoot);
            File uploadsDir = new File(sessionDir, WebGate.UPLOADS_DIR);
            if (!uploadsDir.isDirectory()) {
                // 空态而非 404：新会话尚未上传过附件是常态，面板据此显示「暂无附件」
                return Result.succeed(resp);
            }

            List<Map<String, Object>> items = new ArrayList<>();
            try (java.util.stream.Stream<Path> stream = Files.list(uploadsDir.toPath())) {
                stream.filter(Files::isRegularFile).forEach(file -> {
                    try {
                        String name = file.getFileName().toString();
                        Map<String, Object> item = new LinkedHashMap<>();
                        item.put("name", name);
                        // 与 meta 同口径的相对路径：前端可直接把它喂回 /attachment/meta 取缩略图
                        item.put("path", WebGate.UPLOADS_DIR + "/" + name);
                        item.put("size", Files.size(file));
                        // isImageAttachment 的语义是「声明为 image 且扩展名在图片白名单内」；
                        // 清单场景没有浏览器声明的类型，传 "image" 使其退化为纯扩展名判定，
                        // 保证与 meta/发送链路的图片口径一致（传 null 会恒判 false）。
                        item.put("image", WebGate.isImageAttachment(WebGate.extOfName(name), "image"));
                        item.put("updatedAt", Files.getLastModifiedTime(file).toMillis());
                        items.add(item);
                    } catch (Exception e) {
                        // 单条读取失败（文件正被写入/权限）不得波及整批：跳过即可，目录枚举仍返回其余项
                        LOG.warn("[Web] attachment list skipped {}: {}", file, e.getMessage());
                    }
                });
            }
            // 按修改时间倒序：面板关心「最近传的」，倒序让最新附件直接落在首屏
            items.sort(java.util.Comparator.comparingLong(
                    (Map<String, Object> m) -> ((Number) m.getOrDefault("updatedAt", 0L)).longValue()).reversed());

            resp.put("items", items);
            resp.put("total", items.size());
            return Result.succeed(resp);
        } catch (Throwable e) {
            LOG.error("[Web] attachment list error: {}", e.getMessage(), e);
            return Result.failure(500, e.getMessage());
        }
    }

    /**
     * 解析「附件所在」的会话目录：primary 无 uploads 目录时，在全部已知落点里回探第一个有的。
     *
     * <p>与 {@link #attachmentMeta} 内联的回探逻辑同口径，抽成方法供两个端点复用：
     * {@code resolveDirForRead} 的 probe 走 {@code isFile()} 判定，而 uploads 是目录、probe 恒不命中，
     * 因此必须按目录级自行回探；都无则回 primary（保持与写入侧同目录，missing 语义不变）。</p>
     */
    private File resolveAttachmentSessionDir(String sessionId, String sessionRoot) {
        File sessionDir = sessionLocator.resolveDir(sessionId, sessionRoot);
        if (!new File(sessionDir, WebGate.UPLOADS_DIR).isDirectory()) {
            for (File candidate : sessionLocator.allKnownSessionDirs(sessionId, sessionRoot)) {
                if (new File(candidate, WebGate.UPLOADS_DIR).isDirectory()) {
                    return candidate;
                }
            }
        }
        return sessionDir;
    }


    // ==================== Agent 文件变更（非 Git） ====================

    @Get
    @Mapping("/web/chat/changes/run")
    public Result<Map<String, Object>> changesRun(Context ctx,
                                                   @Param("sessionId") String sessionId,
                                                   @Param("runId") String runId,
                                                   @Param(value = "root", required = false) String root) {
        return changeQueryResult(FileChangeService.getInstance()
                .getRun(sessionId, runId, resolveChangeRoot(ctx, sessionId, root)));
    }

    @Get
    @Mapping("/web/chat/changes/diff")
    public Result<Map<String, Object>> changesDiff(Context ctx,
                                                    @Param("sessionId") String sessionId,
                                                    @Param("runId") String runId,
                                                    @Param(value = "root", required = false) String root,
                                                    @Param("path") String path) {
        return changeQueryResult(FileChangeService.getInstance()
                .diff(sessionId, runId, resolveChangeRoot(ctx, sessionId, root), path));
    }

    /**
     * 会话级文件变更清单（只读）：跨该会话全部 run 合并出「至今改过哪些文件」，供任务监控面板展示。
     *
     * <p><b>WHY</b>：{@code /changes/run} 只能按 runId 查单轮，而面板的入口是会话——
     * 用户想知道「这次任务一共动了哪些文件」，不该被迫先枚举 runId 再逐轮请求。
     * 合并口径与降级语义都在 {@link FileChangeService#listSession} 里，控制器只做根解析。</p>
     *
     * <p>root 走 {@link #resolveChangeRoot(Context, String, String)}：与 changesRun/changesDiff
     * 完全同源，客户端参数只作一致性断言，不能选择任意目录。</p>
     *
     * @param sessionId 会话 ID
     * @param root      可选项目根提示（code 模式）
     * @return {@code {sessionId,files[],fileCount,additions,deletions,runs[],updatedAt,...}}；
     *         账本目录不存在时回结构化空态而非 404
     */
    @Get
    @Mapping("/web/chat/changes/session")
    public Result<Map<String, Object>> changesSession(Context ctx,
                                                      @Param("sessionId") String sessionId,
                                                      @Param(value = "root", required = false) String root) {
        return changeQueryResult(FileChangeService.getInstance()
                .listSession(sessionId, resolveChangeRoot(ctx, sessionId, root)));
    }

    @Post
    @Mapping("/web/chat/changes/undo/file")
    public Result<Map<String, Object>> changesUndoFile(Context ctx, @Body String body) {
        String sessionId = parseJsonField(body, "sessionId");
        // operationId：前端重试用的幂等键，同键重复提交直接返回首次结果，不重复改写文件。
        String operationId = parseJsonField(body, "operationId");
        return changeWriteResult(ctx, FileChangeService.getInstance().undoFile(
                sessionId, parseJsonField(body, "runId"),
                resolveChangeRoot(ctx, sessionId, parseJsonField(body, "root")),
                parseJsonField(body, "path"), operationId), operationId);
    }

    @Post
    @Mapping("/web/chat/changes/undo/run")
    public Result<Map<String, Object>> changesUndoRun(Context ctx, @Body String body) {
        String sessionId = parseJsonField(body, "sessionId");
        String operationId = parseJsonField(body, "operationId");
        return changeWriteResult(ctx, FileChangeService.getInstance().undoRun(
                sessionId, parseJsonField(body, "runId"),
                resolveChangeRoot(ctx, sessionId, parseJsonField(body, "root")), operationId), operationId);
    }

    @Post
    @Mapping("/web/chat/changes/reapply/run")
    public Result<Map<String, Object>> changesReapplyRun(Context ctx, @Body String body) {
        String sessionId = parseJsonField(body, "sessionId");
        String operationId = parseJsonField(body, "operationId");
        return changeWriteResult(ctx, FileChangeService.getInstance().reapplyRun(
                sessionId, parseJsonField(body, "runId"),
                resolveChangeRoot(ctx, sessionId, parseJsonField(body, "root")), operationId), operationId);
    }

    /**
     * 解析变更账本根。客户端参数只作一致性断言，不能选择任意目录：
     * 已绑定会话强制使用 SessionLocator 根；未绑定会话只允许安装工作区或已登记项目根。
     * 所有比较均使用 real path，避免符号链接、大小写或 {@code ..} 形式绕过。
     */
    private String resolveChangeRoot(Context ctx, String sessionId, String root) {
        String headerCwd = SessionCwdCodec.decode(ctx == null ? null : ctx.header("X-Session-Cwd"));
        try {
            return resolveChangeRoot(sessionLocator == null ? null : sessionLocator.boundRoot(sessionId), root, headerCwd,
                    engine.getWorkspace(), projectService::resolveRegisteredDirectory);
        } catch (Throwable e) {
            LOG.warn("[Changes] rejected workspace root for session {}: {}", sessionId, e.getMessage());
            return null;
        }
    }

    /** 包可见纯逻辑 seam，便于在不启动 Web 容器的情况下验证根目录安全边界。 */
    static String resolveChangeRoot(String boundRoot, String root, String headerCwd, String workspace,
                                    java.util.function.Function<String, String> registeredResolver) throws Exception {
        Path bound = realDirectory(boundRoot);
        Path explicitRoot = realDirectory(root);
        Path explicitHeader = realDirectory(headerCwd);
        if (bound != null) {
            requireSameRoot(explicitRoot, bound);
            requireSameRoot(explicitHeader, bound);
            return bound.toString();
        }

        Path safeWorkspace = realDirectory(workspace);
        Path requested = explicitRoot != null ? explicitRoot : explicitHeader;
        if (explicitRoot != null && explicitHeader != null && !explicitRoot.equals(explicitHeader)) {
            throw new IllegalArgumentException("Conflicting workspace roots");
        }
        if (requested == null || requested.equals(safeWorkspace)) return safeWorkspace.toString();

        Path registered = realDirectory(registeredResolver.apply(requested.toString()));
        if (!requested.equals(registered)) throw new IllegalArgumentException("Workspace root is not registered");
        return registered.toString();
    }

    private static Path realDirectory(String value) throws Exception {
        if (Assert.isEmpty(value)) return null;
        if (value.indexOf('\0') >= 0) throw new IllegalArgumentException("Invalid workspace root");
        Path path = Paths.get(value.trim()).toAbsolutePath().normalize();
        if (!Files.isDirectory(path)) throw new IllegalArgumentException("Workspace root does not exist");
        return path.toRealPath();
    }

    private static void requireSameRoot(Path supplied, Path expected) {
        if (supplied != null && !supplied.equals(expected)) {
            throw new IllegalArgumentException("Workspace root does not match the session binding");
        }
    }

    /** 只读查询：仅参数/缺失/异常类状态算失败，CONFLICT、INCOMPLETE 等历史遗留状态照常回传数据。 */
    private Result<Map<String, Object>> changeQueryResult(Map<String, Object> data) {
        String status = data == null ? "ERROR" : String.valueOf(data.get("status"));
        if ("INVALID_REQUEST".equals(status) || "NOT_FOUND".equals(status) || status.startsWith("ERROR")) {
            return Result.failure(status, data);
        }
        return Result.succeed(data);
    }

    /** 写操作：严格状态映射，并回写真实 HTTP 状态码（前端按 409 判定冲突）。 */
    private Result<Map<String, Object>> changeWriteResult(Context ctx, Map<String, Object> data, String operationId) {
        String status = data == null ? "ERROR" : String.valueOf(data.get("status"));
        if (data != null && Assert.isNotEmpty(operationId)) {
            data.put("operationId", operationId);
        }
        if ("OK".equals(status) || "CAPTURED".equals(status) || "READY".equals(status)
                || "UNDONE".equals(status) || "REAPPLIED".equals(status) || "INCOMPLETE".equals(status)) {
            return Result.succeed(data);
        }
        if (ctx != null) {
            ctx.status(changeHttpStatus(status));
        }
        return Result.failure(status, data);
    }

    private static int changeHttpStatus(String status) {
        if ("CONFLICT".equals(status) || "BUSY".equals(status)) {
            return 409;
        }
        if ("INVALID_REQUEST".equals(status)) {
            return 400;
        }
        if ("NOT_FOUND".equals(status)) {
            return 404;
        }
        return 500;
    }


    // ==================== Git 集成（委派给 GitService） ====================

    /**
     * Git 状态检测：返回 Git 可用性、仓库初始化状态、当前分支名及变更文件列表。
     * <p>依次执行以下检测：
     * <ol>
     *   <li>git --version 检测 Git 是否安装且可用</li>
     *   <li>git rev-parse 检测工作区是否已初始化为 Git 仓库</li>
     *   <li>git branch --show-current 获取当前分支名</li>
     *   <li>git status --porcelain=v1 解析变更文件（分为 changed、staged、untracked 三类）</li>
     * </ol></p>
     *
     * @return 包含 gitAvailable、initialized、branch、changed、staged、untracked 的结果对象
     * @throws Exception Git 命令执行异常
     */
    @Get
    @Mapping("/web/chat/git/status")
    public Result<Map> gitStatus(@Param(value = "root", required = false) String root) throws Exception {
        return gitService.inRoot(root, gitService::status);
    }

    /**
     * Git 远端与上游同步状态（只读，供任务监控面板展示）。
     *
     * <p><b>WHY</b>：{@code /git/status} 只覆盖本地工作区变更，面板还需要知道「有没有远端、
     * 落后/领先多少提交」。本端点只读本地已有的远端配置与 ref 计数，不发起 fetch/pull，
     * 因此离线环境同样安全；拿不到信息时回结构化降级字段而不是 500（见
     * {@link GitService#remoteInfo()}）。</p>
     *
     * <p>root 解析与 {@link #gitStatus} 完全同构：同一个 {@code inRoot} ThreadLocal 覆盖机制，
     * 支持 Code 模式按所选项目重定向。</p>
     *
     * @param root 可选项目根
     * @return {@code {gitAvailable, hasRemote, remoteUrl, upstream, ahead, behind, degraded}}
     * @throws Exception Git 命令执行异常
     */
    @Get
    @Mapping("/web/chat/git/remote")
    public Result<Map> gitRemote(@Param(value = "root", required = false) String root) throws Exception {
        return Result.succeed(gitService.inRoot(root, gitService::remoteInfo));
    }

    /**
     * 初始化 Git 仓库。
     * <p>在工作区执行 git init，自动生成 .gitignore 文件（仅当文件不存在时），
     * 可选执行初始提交（initialCommit=true 时）。</p>
     *
     * @param initialCommit 是否执行初始提交，默认为 false
     * @return 包含 initialized、branch 的结果对象
     * @throws Exception Git 命令执行异常
     */
    @Post
    @Mapping("/web/chat/git/init")
    public Result<Map> gitInit(@Param(value = "initialCommit", required = false) Boolean initialCommit,
                               @Param(value = "root", required = false) String root) throws Exception {
        final Boolean ic = initialCommit;
        return gitService.inRoot(root, () -> gitService.init(ic));
    }

    @Get
    @Mapping("/web/chat/git/diff")
    public Result<Map> gitDiff(@Param(value = "path", required = false) String path,
                               @Param(value = "root", required = false) String root) throws Exception {
        final String p = path;
        return gitService.inRoot(root, () -> gitService.diff(p));
    }

    @Post
    @Mapping("/web/chat/git/stage")
    public Result<Map> gitStage(@Body String body) throws Exception {
        String path = parseJsonPath(body);
        String root = parseJsonField(body, "root");
        return gitService.inRoot(root, () -> gitService.stage(path));
    }

    @Post
    @Mapping("/web/chat/git/unstage")
    public Result<Map> gitUnstage(@Body String body) throws Exception {
        String path = parseJsonPath(body);
        String root = parseJsonField(body, "root");
        return gitService.inRoot(root, () -> gitService.unstage(path));
    }

    @Get
    @Mapping("/web/chat/git/file-content")
    public Result<Map> gitFileContent(@Param("path") String path,
                                      @Param(value = "ref", required = false) String ref,
                                      @Param(value = "root", required = false) String root) throws Exception {
        final String p = path;
        final String r = ref;
        return gitService.inRoot(root, () -> gitService.fileContent(p, r));
    }

    @Post
    @Mapping("/web/chat/git/commit")
    public Result<Map> gitCommit(@Body String body) throws Exception {
        String message = null;
        List<String> files = null;
        String root = null;
        if (body != null && !body.trim().isEmpty()) {
            try {
                ONode json = ONode.ofJson(body);
                if (json != null && json.isObject()) {
                    ONode msgNode = json.get("message");
                    if (msgNode != null && msgNode.isString()) {
                        message = msgNode.getString();
                    }
                    ONode rootNode = json.get("root");
                    if (rootNode != null && rootNode.isString()) {
                        root = rootNode.getString();
                    }
                    ONode filesNode = json.get("files");
                    if (filesNode != null && filesNode.isArray()) {
                        files = new ArrayList<>();
                        for (ONode f : filesNode.getArray()) {
                            files.add(f.getString());
                        }
                    }
                }
            } catch (Exception ignored) {
            }
        }
        final String msg = message;
        final List<String> fs = files;
        return gitService.inRoot(root, () -> gitService.commit(msg, fs));
    }

    @Post
    @Mapping("/web/chat/git/summary")
    public Result<Map> gitSummary(@Param("sessionId") String sessionId,
                                  @Param("paths") String paths,
                                  @Param(value = "root", required = false) String root) {
        if (sessionId == null || sessionId.isEmpty()) {
            return Result.failure(400, "sessionId is required");
        }
        if (sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure(400, "Invalid sessionId");
        }

        // 解析文件路径列表
        List<String> files = new ArrayList<>();
        if (paths != null && !paths.trim().isEmpty()) {
            try {
                ONode json = ONode.ofJson(paths);
                if (json != null && json.isArray()) {
                    for (ONode f : json.getArray()) {
                        String p = f.getString();
                        if (p != null && !p.isEmpty()) {
                            files.add(p);
                        }
                    }
                }
            } catch (Exception e) {
                return Result.failure(400, "Invalid paths format, expected JSON array");
            }
        }

        try {
            final String sid = sessionId;
            final List<String> fs = files;
            return gitService.inRoot(root, () -> gitService.summary(sid, fs));
        } catch (Exception e) {
            return Result.failure(500, e.getMessage());
        }
    }

    /**
     * 从 JSON 请求体中解析 path 字段。
     *
     * @param body JSON 字符串，如 { "path": "src/App.java" }
     * @return path 值，解析失败返回 null
     */
    private String parseJsonPath(String body) {
        if (body != null && !body.trim().isEmpty()) {
            try {
                ONode json = ONode.ofJson(body);
                if (json != null && json.isObject()) {
                    ONode pathNode = json.get("path");
                    if (pathNode != null && pathNode.isString()) {
                        return pathNode.getString();
                    }
                }
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    /** 从 JSON body 中读取一个字符串字段（不存在返回 null）。 */
    private String parseJsonField(String body, String field) {
        if (body != null && !body.trim().isEmpty()) {
            try {
                ONode json = ONode.ofJson(body);
                if (json != null && json.isObject()) {
                    ONode n = json.get(field);
                    if (n != null && n.isString()) {
                        return n.getString();
                    }
                }
            } catch (Exception ignored) {
            }
        }
        return null;
    }


    // ==================== 循环任务管理 ====================

    /**
     * 获取当前会话的循环任务列表（含已停用的）。
     */
    @Get
    @Mapping("/web/chat/loop/list")
    public Result<List<Map>> loopList(@Param("sessionId") String sessionId) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure(400, "Invalid sessionId");
        }

        List<LoopTask> tasks = loopScheduler.listAll(sessionId, engine.getWorkspace(), engine.getHarnessSessions());
        List<Map> data = new ArrayList<>();
        for (LoopTask t : tasks) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", t.getId());
            if (t.getName() != null) item.put("name", t.getName());
            item.put("prompt", t.getPrompt());
            item.put("intervalMinutes", t.getIntervalMinutes());
            if (t.getCron() != null) item.put("cron", t.getCron());
            item.put("enabled", t.isEnabled());
            item.put("cancelled", t.isCancelled());
            item.put("running", t.isRunning());
            item.put("currentIteration", t.getCurrentIteration());
            if (t.getLastResult() != null) item.put("lastResult", t.getLastResult());
            if (t.getLastExecutedAt() != null) item.put("lastExecutedAt", t.getLastExecutedAt().toString());
            if (t.getGoalCondition() != null) item.put("goalCondition", t.getGoalCondition());
            item.put("worktreeEnabled", t.isWorktreeEnabled());
            item.put("maxIterations", t.getMaxIterations());
            item.put("runNow", t.isRunNow());
            // 执行上下文（自动化页面的工作空间 / 模型 / 思考档位 / 上下文窗口）：未设置时不输出，前端视为“跟随默认”
            if (t.getWorkspace() != null) item.put("workspace", t.getWorkspace());
            if (t.getModelName() != null) item.put("modelName", t.getModelName());
            if (t.getThinkingDepth() != null) item.put("thinkingDepth", t.getThinkingDepth());
            if (t.getContextLength() != null) item.put("contextLength", t.getContextLength());
            if (t.getAccessMode() != null) item.put("accessMode", t.getAccessMode());
            if (t.getChannelNotify() != null) item.put("channelNotify", t.getChannelNotify());
            if (t.getBoundSessionId() != null) item.put("boundSessionId", t.getBoundSessionId());
            // 任务级附件：无附件时不输出（保持无附件任务的响应体与旧版一致）
            appendAttachmentMeta(item, t);
            // 运行时会话（执行对话）：前端据此在点击任务行时打开该任务的执行记录
            if (t.getRuntimeSessionId() != null) item.put("runtimeSessionId", t.getRuntimeSessionId());
            data.add(item);
        }
        return Result.succeed(data);
    }

    /**
     * 获取单个循环任务详情（用于编辑回填）。
     */
    @Get
    @Mapping("/web/chat/loop/get")
    public Result<Map> loopGet(@Param("sessionId") String sessionId,
                               @Param("taskId") String taskId) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure(400, "Invalid sessionId");
        }
        if (taskId == null || taskId.trim().isEmpty()) {
            return Result.failure(400, "taskId is required");
        }

        List<LoopTask> tasks = loopScheduler.listAll(sessionId, engine.getWorkspace(), engine.getHarnessSessions());
        for (LoopTask t : tasks) {
            if (t.getId().equals(taskId)) {
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("id", t.getId());
                if (t.getName() != null) item.put("name", t.getName());
                item.put("prompt", t.getPrompt());
                item.put("intervalMinutes", t.getIntervalMinutes());
                if (t.getCron() != null) item.put("cron", t.getCron());
                item.put("enabled", t.isEnabled());
                item.put("cancelled", t.isCancelled());
                item.put("running", t.isRunning());
                item.put("currentIteration", t.getCurrentIteration());
                if (t.getLastResult() != null) item.put("lastResult", t.getLastResult());
                if (t.getLastExecutedAt() != null) item.put("lastExecutedAt", t.getLastExecutedAt().toString());
                if (t.getGoalCondition() != null) item.put("goalCondition", t.getGoalCondition());
                item.put("worktreeEnabled", t.isWorktreeEnabled());
                item.put("maxIterations", t.getMaxIterations());
                item.put("runNow", t.isRunNow());
                // 执行上下文：供编辑页回填
                if (t.getWorkspace() != null) item.put("workspace", t.getWorkspace());
                if (t.getModelName() != null) item.put("modelName", t.getModelName());
                if (t.getThinkingDepth() != null) item.put("thinkingDepth", t.getThinkingDepth());
                if (t.getContextLength() != null) item.put("contextLength", t.getContextLength());
                if (t.getAccessMode() != null) item.put("accessMode", t.getAccessMode());
                if (t.getChannelNotify() != null) item.put("channelNotify", t.getChannelNotify());
                if (t.getBoundSessionId() != null) item.put("boundSessionId", t.getBoundSessionId());
                // 任务级附件：供编辑页回显已上传的附件清单
                appendAttachmentMeta(item, t);
                if (t.getRuntimeSessionId() != null) item.put("runtimeSessionId", t.getRuntimeSessionId());
                return Result.succeed(item);
            }
        }
        return Result.failure(404, "Task not found");
    }

    /**
     * 新增循环任务（支持任务级附件）。
     *
     * <p>附件以 multipart 提交（{@code attachments} 文件域 + 同序的 {@code attachmentTypes}），
     * 落盘到 {@code <workspace>/<loops>/<taskId>/attachments/}，任务定义里只记简单文件名。
     * 每次定时执行都会把它们重新注入本轮 Prompt（图片→多模态，文件→{@code [附件: 路径]} 前缀）。</p>
     *
     * <p>附件参数沿用 {@code /web/chat/input} 的 solon 参数注入写法（不带 {@code @Param}）；
     * 若注入为空但请求确实带了文件域，再用 {@code ctx.fileValues} 兜底读取（见
     * {@link #resolveUploadedFiles}），保证两种绑定路径都能拿到字节。</p>
     */
    @Post
    @Mapping("/web/chat/loop/add")
    public Result loopAdd(Context ctx,
                          @Param("sessionId") String sessionId,
                          @Param("prompt") String prompt,
                          @Param(value = "name", required = false) String name,
                          @Param(value = "intervalMinutes", required = false) Integer intervalMinutes,
                          @Param(value = "cron", required = false) String cron,
                          @Param(value = "goalCondition", required = false) String goalCondition,
                          @Param(value = "worktreeEnabled", required = false) Boolean worktreeEnabled,
                          @Param(value = "maxIterations", required = false) Integer maxIterations,
                          @Param(value = "runNow", required = false) Boolean runNow,
                          @Param(value = "taskWorkspace", required = false) String taskWorkspace,
                          @Param(value = "modelName", required = false) String modelName,
                          @Param(value = "thinkingDepth", required = false) String thinkingDepth,
                          @Param(value = "channelNotify", required = false) String channelNotify,
                          @Param(value = "boundSessionId", required = false) String boundSessionId,
                          @Param(value = "contextLength", required = false) String contextLength,
                          @Param(value = "accessMode", required = false) String accessMode,
                          UploadedFile[] attachments,
                          String[] attachmentTypes) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure(400, "Invalid sessionId");
        }
        if (prompt == null || prompt.trim().isEmpty()) {
            return Result.failure(400, "prompt is required");
        }

        // 上下文窗口（可选）：空串视为未设置（跟随全局默认）；非空必须是固定选项之一
        Long parsedContextLength = null;
        if (contextLength != null && !contextLength.trim().isEmpty()) {
            parsedContextLength = ContextLengthPolicy.parse(contextLength);
            if (parsedContextLength == null || !ContextLengthPolicy.isAllowed(parsedContextLength.longValue())) {
                return Result.failure(400, "Unsupported contextLength: " + contextLength);
            }
        }

        // 权限档位（可选）：空串视为未设置（回退会话已存档位）；非空必须是合法码值
        String effectiveAccessMode = null;
        if (accessMode != null && !accessMode.trim().isEmpty()) {
            if (!AccessMode.isAllowed(accessMode)) {
                return Result.failure(400, "Unsupported accessMode: " + accessMode);
            }
            effectiveAccessMode = AccessMode.normalize(accessMode).code();
        }

        String workspace = engine.getWorkspace();
        String harnessSessions = engine.getHarnessSessions();

        // 初始化状态目录
        int interval = intervalMinutes != null ? intervalMinutes : 5;
        LoopTask task = new LoopTask(
                prompt, interval, cron,
                goalCondition,
                worktreeEnabled != null ? worktreeEnabled : false,
                maxIterations,
                runNow != null && runNow,
                taskWorkspace, modelName, thinkingDepth,
                parsedContextLength,
                effectiveAccessMode,
                channelNotify, boundSessionId
        );

        task.setName(name);

        // 任务级附件：必须在任务注册之前落盘。落盘失败时任务不得创建，
        // 否则会留下一个「前端以为带了附件、实际一个字节也没落盘」的任务，
        // 而定时执行每轮都只会静默地跑成纯文本——这种分叉事后无法从任务定义上看出来。
        UploadedFile[] files = resolveUploadedFiles(ctx, attachments, "attachments");
        String[] types = resolveStringArray(ctx, attachmentTypes, "attachmentTypes");

        try {
            LoopStateManager.init(workspace, task.getId(), prompt);

            if (files != null && files.length > 0) {
                LoopAttachments.Saved saved;
                try {
                    saved = LoopAttachments.save(workspace, task.getId(), files, types);
                } catch (java.io.IOException | RuntimeException e) {
                    LOG.error("[Web] loop attachment dir unavailable for task {}: {}", task.getId(), e.toString());
                    LoopStateManager.cleanup(workspace, task.getId());
                    return Result.failure(500, "ATTACHMENT_DIR_UNAVAILABLE");
                }
                if (saved.isEmpty()) {
                    LoopStateManager.cleanup(workspace, task.getId());
                    if (saved.getRejected() > 0) {
                        // 文件名全部非法：明确失败，让前端保留输入与附件
                        return Result.failure(400, "INVALID_ATTACHMENT_NAME");
                    }
                    return Result.failure(500, "ATTACHMENT_SAVE_FAILED");
                }
                if (saved.getRejected() > 0 || saved.getFailed() > 0) {
                    LOG.warn("[Web] loop task {} attachments partially saved: ok={}, rejected={}, failed={}",
                            task.getId(), saved.getNames().size(), saved.getRejected(), saved.getFailed());
                }
                // 附件名在任务构造后才可知（id 随机生成），故用 copyWithUpdate 补写附件清单：
                // 它保留 id / createdAt / expireAt / enabled，仅叠加附件字段。
                task = task.copyWithUpdate(
                        prompt, interval, cron, goalCondition,
                        worktreeEnabled != null ? worktreeEnabled : false,
                        maxIterations,
                        runNow != null && runNow,
                        taskWorkspace, modelName, thinkingDepth,
                        parsedContextLength,
                        effectiveAccessMode,
                        channelNotify, boundSessionId,
                        saved.getNames(), saved.getTypes()
                );
                task.setName(name);
            }

            loopScheduler.schedule(sessionId, workspace, harnessSessions, task);
        } catch (IllegalStateException e) {
            // 注册失败（如达到任务上限）：任务从未生效，连带清掉刚建的状态目录与附件字节
            LoopStateManager.cleanup(workspace, task.getId());
            return Result.failure(400, e.getMessage());
        }

        return Result.succeed(task.getId());
    }

    /**
     * 更新循环任务定义（支持任务级附件的保留 / 追加 / 删除）。
     *
     * <p>附件语义与其它执行上下文字段一致：{@code attachmentKeepPaths} 未传（null）表示「未声明，
     * 沿用现有附件」；传了（含空数组）表示「以它为准」，不在其中的附件会被从磁盘上删除。
     * 新上传的附件追加到保留清单之后；同名不覆盖，而是拿计数后缀（{@code a.png} → {@code a-1.png}）。</p>
     *
     * @param attachmentKeepPaths 需要保留的现有附件名（可为 null = 全部保留）
     */
    @Post
    @Mapping("/web/chat/loop/update")
    public Result loopUpdate(Context ctx,
                             @Param("sessionId") String sessionId,
                             @Param("taskId") String taskId,
                             @Param(value = "prompt", required = false) String prompt,
                             @Param(value = "name", required = false) String name,
                             @Param(value = "intervalMinutes", required = false) Integer intervalMinutes,
                             @Param(value = "cron", required = false) String cron,
                             @Param(value = "goalCondition", required = false) String goalCondition,
                             @Param(value = "worktreeEnabled", required = false) Boolean worktreeEnabled,
                             @Param(value = "channelNotify", required = false) String channelNotify,
                             @Param(value = "maxIterations", required = false) Integer maxIterations,
                             @Param(value = "runNow", required = false) Boolean runNow,
                             @Param(value = "taskWorkspace", required = false) String taskWorkspace,
                             @Param(value = "modelName", required = false) String modelName,
                             @Param(value = "thinkingDepth", required = false) String thinkingDepth,
                              @Param(value = "boundSessionId", required = false) String boundSessionId,
                              @Param(value = "contextLength", required = false) String contextLength,
                              @Param(value = "accessMode", required = false) String accessMode,
                              UploadedFile[] attachments,
                              String[] attachmentTypes,
                              @Param(value = "attachmentKeepPaths", required = false) String[] attachmentKeepPaths) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure(400, "Invalid sessionId");
        }
        if (taskId == null || taskId.isEmpty()) {
            return Result.failure(400, "taskId is required");
        }

        String workspace = engine.getWorkspace();
        String harnessSessions = engine.getHarnessSessions();

        LoopTask existing = loopScheduler.getTaskById(sessionId, taskId);
        if (existing == null) {
            return Result.failure(404, "Task not found");
        }

        // 基于现有任务构建新任务（保留 id、createdAt、expireAt 等）
        int interval = intervalMinutes != null ? intervalMinutes : existing.getIntervalMinutes();
        String effectiveCron = cron != null ? cron : existing.getCron();
        String effectivePrompt = (prompt != null && !prompt.trim().isEmpty()) ? prompt.trim() : existing.getPrompt();

        // 执行上下文：前端未传则沿用原值；传空串表示“清除选择（跟随默认）”，LoopTask 会归一为 null
        String effectiveWorkspace = taskWorkspace != null ? taskWorkspace : existing.getWorkspace();
        String effectiveModelName = modelName != null ? modelName : existing.getModelName();
        String effectiveThinking = thinkingDepth != null ? thinkingDepth : existing.getThinkingDepth();
        String effectiveChannel = channelNotify != null ? channelNotify : existing.getChannelNotify();
        String effectiveBoundSession = boundSessionId != null ? boundSessionId : existing.getBoundSessionId();

        // 权限档位：未传（null）沿用旧值；空串清除（回退会话已存档位）；非空必须是合法码值
        String effectiveAccessMode = existing.getAccessMode();
        if (accessMode != null) {
            if (accessMode.trim().isEmpty()) {
                effectiveAccessMode = null;
            } else {
                if (!AccessMode.isAllowed(accessMode)) {
                    return Result.failure(400, "Unsupported accessMode: " + accessMode);
                }
                effectiveAccessMode = AccessMode.normalize(accessMode).code();
            }
        }

        // 上下文窗口：未传（null）沿用旧值；空串清除；非空必须是固定选项之一
        Long effectiveContextLength = existing.getContextLength();
        if (contextLength != null) {
            if (contextLength.trim().isEmpty()) {
                effectiveContextLength = null;
            } else {
                Long parsedContext = ContextLengthPolicy.parse(contextLength);
                if (parsedContext == null || !ContextLengthPolicy.isAllowed(parsedContext.longValue())) {
                    return Result.failure(400, "Unsupported contextLength: " + contextLength);
                }
                effectiveContextLength = parsedContext;
            }
        }

        // 任务级附件：未传 attachmentKeepPaths（null）= 沿用现有附件；传了（含「一个空值」）= 以它为准。
        // 新上传的附件追加到保留清单之后；磁盘清理（prune）必须在任务定义更新成功之后执行，
        // 否则一旦 update 抛异常，字节已删而定义还指着它们——下一轮执行会注入一批不存在的附件。
        UploadedFile[] files = resolveUploadedFiles(ctx, attachments, "attachments");
        String[] types = resolveStringArray(ctx, attachmentTypes, "attachmentTypes");
        String[] keepPaths = resolveKeepPaths(ctx, attachmentKeepPaths);
        List<String> effectiveAttachmentPaths = null;
        List<String> effectiveAttachmentTypes = null;
        if (keepPaths != null || (files != null && files.length > 0)) {
            List<String> keptNames;
            List<String> keptTypes;
            if (keepPaths != null) {
                List<String> keepNames = LoopAttachments.normalizeNames(Arrays.asList(keepPaths));
                keptNames = new ArrayList<>();
                keptTypes = new ArrayList<>();
                // 只保留任务定义里确实存在的附件，并按原清单的类型声明回填（前端可能只回传路径）
                List<String> oldNames = existing.getAttachmentPaths();
                List<String> oldTypes = existing.getAttachmentTypes();
                for (String keep : keepNames) {
                    int idx = indexOfName(oldNames, keep);
                    if (idx < 0) {
                        LOG.warn("[Web] loop task {} attachmentKeepPaths refers to unknown attachment: {}", taskId, keep);
                        continue;
                    }
                    keptNames.add(oldNames.get(idx));
                    keptTypes.add(idx < oldTypes.size() ? oldTypes.get(idx) : "file");
                }
                if (keptNames.isEmpty() && !oldNames.isEmpty()) {
                    // 显式清空（keep 清单为空而原有附件）：删字节不可逆，留一条可观测痕迹
                    LOG.info("[Web] loop task {} clears all {} attachment(s)", taskId, oldNames.size());
                }
            } else {
                keptNames = new ArrayList<>(existing.getAttachmentPaths());
                keptTypes = new ArrayList<>(existing.getAttachmentTypes());
            }

            List<String> addedNames = Collections.emptyList();
            List<String> addedTypes = Collections.emptyList();
            if (files != null && files.length > 0) {
                LoopAttachments.Saved saved;
                try {
                    saved = LoopAttachments.save(workspace, taskId, files, types);
                } catch (java.io.IOException | RuntimeException e) {
                    LOG.error("[Web] loop attachment dir unavailable for task {}: {}", taskId, e.toString());
                    return Result.failure(500, "ATTACHMENT_DIR_UNAVAILABLE");
                }
                if (saved.isEmpty() && saved.getRejected() + saved.getFailed() > 0) {
                    // 用户上传了附件但一条也没存下：必须明确失败，让前端保留输入
                    return Result.failure(saved.getRejected() > 0 ? 400 : 500,
                            saved.getRejected() > 0 ? "INVALID_ATTACHMENT_NAME" : "ATTACHMENT_SAVE_FAILED");
                }
                if (saved.getRejected() > 0 || saved.getFailed() > 0) {
                    LOG.warn("[Web] loop task {} attachments partially saved on update: ok={}, rejected={}, failed={}",
                            taskId, saved.getNames().size(), saved.getRejected(), saved.getFailed());
                }
                addedNames = saved.getNames();
                addedTypes = saved.getTypes();
            }

            effectiveAttachmentPaths = new ArrayList<>(keptNames);
            effectiveAttachmentPaths.addAll(addedNames);
            effectiveAttachmentTypes = new ArrayList<>(keptTypes);
            effectiveAttachmentTypes.addAll(addedTypes);
        }

        LoopTask newTask = existing.copyWithUpdate(
                effectivePrompt, interval, effectiveCron,
                goalCondition != null ? goalCondition : existing.getGoalCondition(),
                worktreeEnabled != null ? worktreeEnabled : existing.isWorktreeEnabled(),
                maxIterations != null ? maxIterations : existing.getMaxIterations(),
                runNow != null ? runNow : existing.isRunNow(),
                effectiveWorkspace, effectiveModelName, effectiveThinking, effectiveContextLength,
                effectiveAccessMode,
                effectiveChannel, effectiveBoundSession,
                effectiveAttachmentPaths, effectiveAttachmentTypes
        );

        // 保留 enabled 和 name
        newTask.setEnabled(existing.isEnabled());
        newTask.setName(name != null ? name : existing.getName());

        // 运行时会话：工作空间未变时复用（保留任务历史上下文）；已变则不继承，
        // 避免新工作空间下的任务继续写入/读取旧目录的会话历史（下次触发会重建）。
        if (java.util.Objects.equals(existing.getWorkspace(), newTask.getWorkspace())) {
            newTask.setRuntimeSessionId(existing.getRuntimeSessionId());
        } else if (existing.getRuntimeSessionId() != null && sessionLocator != null) {
            // 工作空间已变：旧运行时会话不再使用，同步注销其所属根登记，避免注册表持续残留
            sessionLocator.unbind(existing.getRuntimeSessionId());
        }

        loopScheduler.update(sessionId, workspace, harnessSessions, taskId, newTask);

        // 任务定义已换成新清单，此时才清理磁盘上不再被引用的字节；
        // 清理失败只留痕（prune 内部已兜底），不影响更新结果。
        if (effectiveAttachmentPaths != null) {
            LoopAttachments.prune(workspace, taskId, effectiveAttachmentPaths);
        }
        return Result.succeed();
    }

    /**
     * 在既有附件名清单中定位一个名字（忽略大小写，Windows/远端部署下大小写不可靠）。
     *
     * @return 下标；不存在时返回 -1
     */
    private static int indexOfName(List<String> names, String target) {
        if (names == null || target == null) {
            return -1;
        }
        for (int i = 0; i < names.size(); i++) {
            if (target.equalsIgnoreCase(names.get(i))) {
                return i;
            }
        }
        return -1;
    }

    /**
     * 解析本次请求携带的上传文件。
     *
     * <p>优先用 solon 的参数注入结果（与 {@code /web/chat/input} 同写法）；注入为空时用
     * {@code ctx.fileValues(name)} 兜底——不同 solon 版本/序列化器对「multipart 文件数组参数」
     * 的绑定支持程度不一，而任务附件一旦静默丢失，用户只会看到「定时任务不带附件跑」，
     * 故宁可多一次读取也不能漏。</p>
     */
    private static UploadedFile[] resolveUploadedFiles(Context ctx, UploadedFile[] injected, String name) {
        if (injected != null && injected.length > 0) {
            return injected;
        }
        if (ctx == null) {
            return injected;
        }
        try {
            UploadedFile[] fromCtx = ctx.fileValues(name);
            return fromCtx != null && fromCtx.length > 0 ? fromCtx : injected;
        } catch (RuntimeException e) {
            LOG.warn("[Web] failed to read uploaded files '{}' from context: {}", name, e.toString());
            return injected;
        }
    }

    /**
     * 解析重复表单键（如 {@code attachmentTypes=image&attachmentTypes=file}）为字符串数组。
     *
     * <p>与 {@code /web/chat/attachment/meta} 对 {@code paths} 的处理同口径：
     * {@code @Param} 单值绑定在重复键下只会拿到其中一个，故优先取 {@code ctx.paramValues} 的全量值。</p>
     */
    private static String[] resolveStringArray(Context ctx, String[] injected, String name) {
        String[] fromCtx = longestParamValues(ctx, name, name + "[]");
        // 类型清单与文件数组必须同序对齐：取条目更多的那一份，截断的类型清单会让
        // 靠后的图片被当成普通文件（丢失多模态），故不以注入值作为唯一依据。
        if (fromCtx != null && (injected == null || fromCtx.length >= injected.length)) {
            return fromCtx;
        }
        return injected;
    }

    /**
     * 解析「需要保留的现有附件名」声明。
     *
     * <p>返回 {@code null} 表示前端<b>未声明</b>（沿用现有附件）；返回非 null（哪怕只有一个空字符串）
     * 表示「以这份清单为准」，不在其中的附件会被从磁盘删除。</p>
     *
     * <p>为何不直接用 {@code @Param} 的注入值：该参数是重复表单键，而 jQuery 在非 traditional
     * 模式下会把它序列化为 {@code attachmentKeepPaths[]}，按精确名绑定时会得到 null——
     * 而 null 在本接口里恰好是「全部保留」的语义，删除意图会被静默吞掉（用户看到
     * 「已保存」但附件一个也没删）。故这里兼容两种键名。</p>
     *
     * <p>方向性 fail-safe：只在「确实读到了键」时才返回非 null。拿不准时一律当未声明（沿用），
     * 因为误删字节不可逆，而「没删掉」用户重试一次就能修正。</p>
     */
    private static String[] resolveKeepPaths(Context ctx, String[] injected) {
        String[] fromCtx = longestParamValues(ctx, "attachmentKeepPaths", "attachmentKeepPaths[]");
        if (fromCtx != null && fromCtx.length > 0) {
            return fromCtx;
        }
        // ctx 读不到时才看参数注入结果；必须剔除 null 条目：solon 在「键未出现」时
        // 不同版本可能给 null、也可能给 [null]，后者若直接当成「声明了空清单」
        // 会把用户全部附件静默删光（而 null 本应是「沿用」）。空字符串则要保留：
        // 那是「显式清空」的唯一可区分信号（空数组在表单序列化后不会产生任何条目）。
        if (injected == null || injected.length == 0) {
            return null;
        }
        List<String> kept = new ArrayList<>(injected.length);
        for (String item : injected) {
            if (item != null) {
                kept.add(item);
            }
        }
        return kept.isEmpty() ? null : kept.toArray(new String[0]);
    }

    /**
     * 从上下文取重复表单键的全量值，多个候选键名中取条目最多的一份。
     *
     * <p>不用 {@code @Param} 的注入值作为优先源：它对重复表单键可能只绑到第一个值
     * （同 {@code /web/chat/attachment/meta} 对 {@code paths} 的处理理由），
     * 截断的 keepPaths 会让本应保留的附件被当成「未声明保留」而删除。</p>
     */
    private static String[] longestParamValues(Context ctx, String... names) {
        if (ctx == null) {
            return null;
        }
        String[] best = null;
        for (String name : names) {
            try {
                String[] values = ctx.paramValues(name);
                if (values != null && (best == null || values.length > best.length)) {
                    best = values;
                }
            } catch (RuntimeException e) {
                LOG.warn("[Web] failed to read param values '{}' from context: {}", name, e.toString());
            }
        }
        return best;
    }

    /**
     * 向 list/get 的输出条目追加任务级附件信息：{@code attachmentPaths} / {@code attachmentTypes} /
     * {@code attachmentSizes}（与 paths 同序，读不到大小的条目填 -1，保证前端不会错位）。
     *
     * <p>无附件时三个键都不输出，保持无附件任务的响应体与旧版完全一致。</p>
     */
    private void appendAttachmentMeta(Map<String, Object> item, LoopTask task) {
        List<String> paths = task.getAttachmentPaths();
        if (paths == null || paths.isEmpty()) {
            return;
        }
        item.put("attachmentPaths", paths);
        item.put("attachmentTypes", task.getAttachmentTypes());
        Map<String, Long> meta;
        try {
            meta = LoopAttachments.listMeta(engine.getWorkspace(), task.getId());
        } catch (RuntimeException e) {
            LOG.warn("[Web] failed to read loop attachment meta for task {}: {}", task.getId(), e.toString());
            meta = Collections.emptyMap();
        }
        item.put("attachmentSizes", LoopAttachments.sizesOf(meta, paths));
    }

    /**
     * 删除循环任务。
     */
    @Post
    @Mapping("/web/chat/loop/remove")
    public Result loopRemove(@Param("sessionId") String sessionId, @Param("taskId") String taskId) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure(400, "Invalid sessionId");
        }
        if (taskId == null || taskId.isEmpty()) {
            return Result.failure(400, "taskId is required");
        }

        LoopTask task = loopScheduler.getTaskById(sessionId, taskId);
        if (task == null) {
            return Result.failure(400, "the task does not exist.");
        }

        loopScheduler.remove(sessionId, engine.getWorkspace(), engine.getHarnessSessions(), taskId);
        // 任务定义已从调度器与任务文件里摘除，同步清理其附件字节，避免状态目录里留下无主文件；
        // 删不掉只留痕（deleteAll 内部已兜底），不让「附件目录被占用」把用户的删除操作变成失败。
        LoopAttachments.deleteAll(engine.getWorkspace(), taskId);
        return Result.succeed();
    }

    /**
     * 启用/停用循环任务（toggle）。
     */
    @Post
    @Mapping("/web/chat/loop/toggle")
    public Result loopToggle(@Param("sessionId") String sessionId, @Param("taskId") String taskId) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure(400, "Invalid sessionId");
        }
        if (taskId == null || taskId.isEmpty()) {
            return Result.failure(400, "taskId is required");
        }

        loopScheduler.toggle(sessionId, engine.getWorkspace(), engine.getHarnessSessions(), taskId);
        return Result.succeed();
    }

    /**
     * 手动触发一次循环任务执行。
     */
    @Post
    @Mapping("/web/chat/loop/trigger")
    public Result loopTrigger(@Param("sessionId") String sessionId, @Param("taskId") String taskId) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure(400, "Invalid sessionId");
        }
        if (taskId == null || taskId.isEmpty()) {
            return Result.failure(400, "taskId is required");
        }

        loopScheduler.trigger(sessionId, engine.getWorkspace(), engine.getHarnessSessions(), taskId);
        return Result.succeed();
    }



    // ==================== 工具方法 ====================

    private String resolveMemoryCwd(Context ctx, boolean global) {
        if (global) {
            return Paths.get(AgentFlags.getHarnessBase()).toAbsolutePath().normalize().toString();
        }
        String sessionCwd = SessionCwdCodec.decode(ctx.header(AgentFlags.X_SESSION_CWD));
        if (Assert.isEmpty(sessionCwd)) {
            return Paths.get(engine.getWorkspace()).toAbsolutePath().normalize().toString();
        }
        return projectService.resolveRegisteredDirectory(sessionCwd);
    }

    private boolean isMemoryIsolationEnabled() {
        return settings.getGeneral().getMemoryIsolation() == null
                || settings.getGeneral().getMemoryIsolation();
    }

    /**
     * 递归删除目录及其所有子文件和子目录。
     *
     * @param dir 待删除的目录
     * @return 全部删除成功返回 true；任一文件/目录删除失败返回 false
     */
    private boolean deleteDirectory(File dir) {
        boolean ok = true;
        File[] files = dir.listFiles();
        if (files != null) {
            for (File f : files) {
                if (f.isDirectory()) {
                    ok &= deleteDirectory(f);
                } else {
                    if (!f.delete()) {
                        ok = false;
                        LOG.warn("Delete file failed (may be occupied): {}", f.getAbsolutePath());
                    }
                }
            }
        }
        // 子项全部删除成功后才删自身；若子项残留，dir.delete() 必然失败
        if (!dir.delete()) {
            ok = false;
            LOG.warn("Delete dir failed (not empty or occupied): {}", dir.getAbsolutePath());
        }
        return ok;
    }

    /**
     * 从 ndjson 消息文件中提取第一条用户（USER 角色）消息的内容。
     * <p>逐行读取消息文件，找到第一条 role 为 USER 的记录并返回其 content 字段。</p>
     *
     * @param msgFile ndjson 格式的消息文件
     * @return 第一条用户消息内容，若未找到则返回 null
     */
    private String extractFirstUserMessage(File msgFile) {
        try (BufferedReader br = new BufferedReader(
                new InputStreamReader(new FileInputStream(msgFile), "UTF-8"))) {
            String line;
            while ((line = br.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty()) continue;
                ONode node = ONode.ofJson(line);
                String role = node.get("role").getString();
                if ("USER".equals(role)) {
                    return node.get("content").getString();
                }
            }
        } catch (Exception e) {
            // ignore
        }
        return null;
    }

    /**
     * 获取指定会话的 TODO 列表。
     * <p>从会话对应的 TODO.md 文件中解析 checkbox 任务项，返回结构化的任务列表及统计信息。</p>
     *
     * @param sessionId 会话 ID
     * @return 包含 exists、raw、items、stats 的结果对象
     */
    @Get
    @Mapping("/web/chat/todos")
    public Result<Map> todos(Context ctx, @Param("sessionId") String sessionId) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure(400, "Invalid sessionId");
        }

        // 与 chat_input 同一套逻辑：chat / code 会话均读其所属工作空间根
        // （X-Session-Cwd 透传 + 注册表兜底）。此前 chat 会话固定读 engine.getWorkspace()，
        // 导致带工作空间的 chat 会话的任务清单（落在工作空间目录下）永远查不到 → 任务面板恒为空。
        String sessionCwd = SessionCwdCodec.decode(ctx.header("X-Session-Cwd"));
        if (sessionCwd != null && sessionCwd.contains("..")) {
            return Result.failure(400, "Invalid Session Cwd");
        }
        if (Assert.isNotEmpty(sessionCwd)) {
            sessionLocator.bindSessionRoot(sessionId, sessionCwd);
        }

        // 用带历史兜底的读取解析：旧版本在无所属根会话上把 TODO.md 写进了 workspace
        // （user.dir），而标准读取位置是 globalBase（user.home）。不回探历史位置的话，
        // 这批存量会话的任务清单升级后会直接「消失」。
        Path todoPath = sessionLocator
                .resolveDirForRead(sessionId, sessionCwd, TodoTalent.TODO_FILE_NAME)
                .toPath()
                .resolve(TodoTalent.TODO_FILE_NAME);

        Map<String, Object> data = new LinkedHashMap<>();

        if (!Files.exists(todoPath)) {
            data.put("exists", false);
            data.put("items", new ArrayList<>());
            Map<String, Integer> stats = new LinkedHashMap<>();
            stats.put("total", 0);
            stats.put("pending", 0);
            stats.put("inProgress", 0);
            stats.put("done", 0);
            data.put("stats", stats);
            return Result.succeed(data);
        }

        try {
            String raw = new String(Files.readAllBytes(todoPath), "UTF-8");
            data.put("exists", true);
            data.put("raw", raw);

            List<Map> items = new ArrayList<>();
            String currentGroup = "";
            int total = 0, pending = 0, inProgress = 0, done = 0;

            String[] lines = raw.split("\n");
            for (int i = 0; i < lines.length; i++) {
                String line = lines[i];

                // 匹配 ## 标题行作为 group
                if (line.matches("^\\s*##\\s+.+$")) {
                    currentGroup = line.replaceFirst("^\\s*##\\s+", "").trim();
                    continue;
                }

                // 匹配 checkbox 行: - [ ] / - [/] / - [x] / - [X]
                if (line.matches("^\\s*-\\s*\\[( |x|X|/)\\]\\s+.+$")) {
                    total++;

                    char statusChar = line.replaceAll("^\\s*-\\s*\\[([ xX/])]\\s+.+$", "$1").charAt(0);
                    String status;
                    if (statusChar == ' ') {
                        status = "pending";
                        pending++;
                    } else if (statusChar == '/') {
                        status = "in_progress";
                        inProgress++;
                    } else {
                        status = "done";
                        done++;
                    }

                    String text = line.replaceFirst("^\\s*-\\s*\\[[ xX/]]\\s+", "").trim();

                    Map<String, Object> item = new LinkedHashMap<>();
                    item.put("line", i + 1);
                    item.put("status", status);
                    item.put("text", text);
                    item.put("raw", line.trim());
                    item.put("group", currentGroup);
                    items.add(item);
                }
            }

            data.put("items", items);

            Map<String, Integer> stats = new LinkedHashMap<>();
            stats.put("total", total);
            stats.put("pending", pending);
            stats.put("inProgress", inProgress);
            stats.put("done", done);
            data.put("stats", stats);

            return Result.succeed(data);
        } catch (Exception e) {
            LOG.error("Failed to read TODO for session {}: {}", sessionId, e.getMessage());
            return Result.failure(500, e.getMessage());
        }
    }

    // ==================== 会话工具用量（任务监控面板） ====================

    /**
     * 会话工具用量统计（只读）：从会话消息文件里统计记忆与技能的调用情况。
     *
     * <p><b>WHY</b>：任务监控面板需要回答「这一轮 AI 有没有真的用上记忆/技能」。
     * 这份事实的权威源是 {@code <sid>.usage.ndjson} 用量账本（写侧在可见性过滤前逐次追写）；
     * 老会话无账本时回退 stream 的 action_start 帧，再回退 messages 的 toolCalls
     * （详见 {@link SessionToolUsageService} 的数据源优先级）。
     * 统计逻辑全部在 {@link SessionToolUsageService}（无状态纯函数，可独立单测），
     * 本端点只负责会话目录解析与安全校验。</p>
     *
     * <p>目录解析用 {@code resolveDirForRead} + 以消息文件名为 probe：与 {@link #todos}
     * 同一套历史落点回探口径。旧版本在无所属根会话上把消息写进了 workspace（user.dir），
     * 而标准读取位置是 globalBase（user.home）；不回探的话这批存量会话的统计会直接「消失」。</p>
     *
     * @param sessionId 会话 ID（参数缺失时回退 X-Session-Id 头）
     * @param root      可选项目根提示（code 模式）
     * @return {@code {sessionId, exists, memory{updated,extractCount,totalCount,names},
     *         skills[{name,toolName,count}], skillCount, toolCallCount, degradedLines}}；
     *         消息文件不存在时回结构化空态（exists=false）而非 404
     */
    @Get
    @Mapping("/web/chat/session/tool-usage")
    public Result<Map<String, Object>> sessionToolUsage(Context ctx,
                                                        @Param(value = "sessionId", required = false) String sessionId,
                                                        @Param(value = "root", required = false) String root) {
        try {
            sessionId = getSessionId(ctx, sessionId);
            Assert.notNull(sessionId, "sessionId is required");
            validateSessionId(sessionId);

            // 与 attachmentMeta/replay 同口径的根校验：不一致（返回 null 且确实传了 root）
            // 必须明确拒绝，否则会退化成「拿别人工作空间下的会话目录」去读消息文件。
            String sessionRoot = resolveSessionRoot(sessionId, root);
            if (sessionRoot == null && Assert.isNotEmpty(root)) {
                return Result.failure(400, "Workspace root does not match the session binding");
            }

            // 候选目录：标准落点优先，历史落点（旧版无根会话写进 workspace 的那批）兜底。
            // 三类数据源文件各自在候选目录里取第一个命中，只读其一不混读（见 Service）。
            File primaryDir = sessionLocator.resolveDir(sessionId, sessionRoot);
            File legacyDir = sessionLocator.resolveDirForRead(sessionId, sessionRoot,
                    sessionId + ".messages.ndjson");
            List<File> candidateDirs = primaryDir.equals(legacyDir)
                    ? List.of(primaryDir)
                    : List.of(primaryDir, legacyDir);
            return Result.succeed(SessionToolUsageService.usage(candidateDirs, sessionId));
        } catch (Throwable e) {
            // 只读统计端点不得抛 500：解析失败一律回空态，面板降级为「暂无统计」
            LOG.warn("[Web] session tool usage failed: {}", e.getMessage());
            Map<String, Object> empty = new LinkedHashMap<>();
            empty.put("sessionId", sessionId);
            empty.put("exists", false);
            empty.put("memory", Collections.emptyMap());
            empty.put("skills", Collections.emptyList());
            empty.put("skillCount", 0);
            empty.put("toolCallCount", 0);
            empty.put("degradedLines", 0);
            return Result.succeed(empty);
        }
    }

    // ==================== 心智记忆查看 ====================

    /**
     * 列出心智记忆条目（只读，供前端记忆面板展示）。
     *
     * <p>数据源与 {@code MemoryTalent} 共用同一个 {@link MemorySolutionProvider}，
     * 保证页面看到的记忆与 LLM 实际读写的记忆完全一致（含 TTL 过期过滤）。
     * 记忆条目统一存于 "shared" 用户域（HarnessEngine 中 MemoryTalent 以 sessionIsolation(false) 构建）。</p>
     *
     * <p>scope 语义：
     * <ul>
     *   <li>workspace：当前工作区记忆。code 会话取 X-Session-Cwd 项目根，chat 会话取全局工作区；</li>
     *   <li>global：全局共享区记忆（{@link AgentFlags#getHarnessBase()}）。</li>
     * </ul>
     * 注意：当“记忆隔离”设置关闭时，{@code MemoryProvider} 会把所有工作区统一重定向到全局区，
     * 此时两个 Tab 返回同一份数据（符合实际存储语义）。</p>
     *
     * @param ctx   请求上下文（workspace 域需携带 X-Session-Cwd 头）
     * @param scope 记忆域：workspace / global
     * @return 记忆条目列表（key/content/importance/time）与总数
     */
    @Get
    @Mapping("/web/chat/memory/list")
    public Result<Map> memoryList(Context ctx,
                                  @Param(value = "scope", required = false, defaultValue = "workspace") String scope) {
        MemorySolutionProvider memoryProvider = engine.getMemoryProvider();
        if (memoryProvider == null) {
            return Result.failure(500, "Memory provider not configured");
        }

        if (!"workspace".equals(scope) && !"global".equals(scope)) {
            return Result.failure(400, "scope must be workspace or global");
        }
        boolean global = "global".equals(scope);

        Map<String, Object> data = new LinkedHashMap<>();
        try {
            String cwd = resolveMemoryCwd(ctx, global);
            MemorySolution solution = memoryProvider.get(cwd);
            MemorySearcher searcher = solution == null ? null : solution.getSearcher();

            List<Map<String, Object>> items = new ArrayList<>();
            if (searcher != null) {
                for (MemorySearchResult r : searcher.listAll("shared", 200)) {
                    Map<String, Object> item = new LinkedHashMap<>();
                    item.put("key", r.getKey());
                    item.put("title", r.getTitle());
                    item.put("content", r.getContent());
                    item.put("importance", r.getImportance());
                    item.put("time", r.getTime());
                    item.put("ttl", r.getTtl());
                    item.put("ttlKnown", r.isTtlKnown());
                    item.put("expiresAtEpochMs", r.getExpiresAtEpochMs());
                    items.add(item);
                }
            }

            data.put("scope", global ? "global" : "workspace");
            data.put("effectiveScope", !global && !isMemoryIsolationEnabled() ? "global" : (global ? "global" : "workspace"));
            data.put("aliased", !global && !isMemoryIsolationEnabled());
            int total = searcher == null ? 0 : searcher.count("shared");
            data.put("items", items);
            data.put("total", total);
            data.put("hasMore", total > items.size());
            return Result.succeed(data);
        } catch (IllegalArgumentException e) {
            return Result.failure(400, e.getMessage());
        } catch (Exception e) {
            LOG.error("Failed to list memories, scope={}: {}", scope, e.getMessage());
            return Result.failure(500, e.getMessage());
        }
    }

    /**
     * 记忆删除接口（记忆主视图手动清理入口）。
     *
     * <p>与 {@code MemoryTalent.prune} 同款组合：storer.remove + searcher.removeIndex，
     * userId 固定 "shared"（与 list 端点一致）。cwd 解析逻辑与 {@link #memoryList} 完全对齐。</p>
     *
     * @param ctx  请求上下文（workspace 域需携带 X-Session-Cwd 头）
     * @param json 请求体：{"scope":"workspace|global","key":"..."}
     */
    @Post
    @Mapping("/web/chat/memory/delete")
    public Result memoryDelete(Context ctx, @Body String json) {
        ONode tmp = ONode.ofJson(json);
        String key = tmp.get("key").getString();
        if (key == null || key.trim().isEmpty()) {
            return Result.failure(400, "key is required");
        }
        String scope = tmp.get("scope").getString();

        MemorySolutionProvider memoryProvider = engine.getMemoryProvider();
        if (memoryProvider == null) {
            return Result.failure(500, "Memory provider not configured");
        }

        if (!"workspace".equals(scope) && !"global".equals(scope)) {
            return Result.failure(400, "scope must be workspace or global");
        }
        boolean global = "global".equals(scope);

        try {
            String cwd = resolveMemoryCwd(ctx, global);
            MemorySolution solution = memoryProvider.get(cwd);
            if (solution == null) {
                return Result.failure(500, "Memory solution not available");
            }
            solution.getStorer().remove("shared", key);
            MemorySearcher searcher = solution.getSearcher();
            if (searcher != null) {
                searcher.removeIndex("shared", key);
            }
            return Result.succeed();
        } catch (IllegalArgumentException e) {
            return Result.failure(400, e.getMessage());
        } catch (Exception e) {
            LOG.error("Failed to delete memory, scope={}, key={}: {}", scope, key, e.getMessage());
            return Result.failure(500, e.getMessage());
        }
    }

    /**
     * 清空当前指定记忆域。请求必须显式携带 workspace/global，避免默认值导致跨域误删。
     */
    @Post
    @Mapping("/web/chat/memory/clear")
    public Result<Map> memoryClear(Context ctx, @Body String json) {
        ONode tmp = ONode.ofJson(json);
        String scope = tmp.get("scope").getString();
        if (!"workspace".equals(scope) && !"global".equals(scope)) {
            return Result.failure(400, "scope must be workspace or global");
        }

        MemorySolutionProvider memoryProvider = engine.getMemoryProvider();
        if (memoryProvider == null) {
            return Result.failure(500, "Memory provider not configured");
        }

        if ("workspace".equals(scope) && !isMemoryIsolationEnabled()) {
            return Result.failure(409, "WORKSPACE_MEMORY_ALIASED_TO_GLOBAL: select global scope to confirm clearing shared memory");
        }

        try {
            String cwd = resolveMemoryCwd(ctx, "global".equals(scope));
            MemorySolution solution = memoryProvider.get(cwd);
            if (solution == null || solution.getSearcher() == null) {
                return Result.failure(500, "Memory solution not available");
            }
            MemoryStorer.ClearResult clearResult = solution.getStorer().clear("shared");
            int deleted = 0;
            List<String> failed = new ArrayList<>();
            if (clearResult != null) {
                deleted = clearResult.getDeleted();
                failed.addAll(clearResult.getFailed());
            } else {
                // 非 MD 实现使用稳定全量快照；即使前 200 项全部失败，后续条目仍会被尝试。
                List<MemorySearchResult> snapshot = solution.getSearcher().listAll("shared", Integer.MAX_VALUE);
                for (MemorySearchResult item : snapshot) {
                    try {
                        solution.getStorer().remove("shared", item.getKey());
                        solution.getSearcher().removeIndex("shared", item.getKey());
                        deleted++;
                    } catch (Exception e) {
                        failed.add(item.getKey());
                        LOG.error("Failed to clear memory, scope={}, key={}", scope, item.getKey(), e);
                    }
                }
            }
            int remaining = solution.getSearcher().count("shared");
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("scope", scope);
            data.put("effectiveScope", scope);
            data.put("deleted", deleted);
            data.put("failed", failed);
            data.put("remaining", remaining);
            if (remaining > 0 || !failed.isEmpty()) {
                return Result.failure("MEMORY_CLEAR_PARTIAL", data);
            }
            return Result.succeed(data);
        } catch (IllegalArgumentException e) {
            return Result.failure(400, e.getMessage());
        } catch (Exception e) {
            LOG.error("Failed to clear memories, scope={}", scope, e);
            return Result.failure(500, e.getMessage());
        }
    }

    // ==================== 文件浏览（委派给 FileService） ====================

    /**
     * 工作区文件树浏览接口。
     *
     * @see FileService#tree(String, Integer)
     */
    @Get
    @Mapping("/web/chat/filer/tree")
    public Result<List<Map>> fileTree(@Param(value = "path", required = false) String path,
                                      @Param(value = "depth", required = false) Integer depth,
                                      @Param(value = "root", required = false) String root) throws Exception {
        return fileService.tree(path, depth, root);
    }

    /**
     * 工作区文件搜索接口。
     *
     * @see FileService#search(String, String)
     */
    @Get
    @Mapping("/web/chat/filer/search")
    public Result<List<Map>> fileSearch(@Param("keyword") String keyword,
                                        @Param(value = "root", required = false) String root) throws Exception {
        return fileService.search(keyword, root);
    }

    /**
     * 读取工作区文件内容接口。
     *
     * @see FileService#read(String, String)
     */
    @Get
    @Mapping("/web/chat/filer/read")
    public Result<Map> fileRead(@Param("path") String path,
                                @Param(value = "root", required = false) String root) throws Exception {
        return fileService.read(path, root);
    }

    /**
     * 工作区文件原始字节流接口 —— Code 模式预览图片/PDF/音视频等二进制文件。
     * <p>沿用 filer/read 同一套路径安全校验（拒绝 {@code ..}、必须位于项目根内），
     * 校验通过后按文件扩展名设置 Content-Type 直接输出原始字节（最大 50MB）。</p>
     *
     * @see FileService#resolveForRaw(String, String)
     */
    @Get
    @Mapping("/web/chat/filer/raw")
    public void fileRaw(Context ctx, @Param("path") String path,
                        @Param(value = "root", required = false) String root) throws Exception {
        Result<File> resolved = fileService.resolveForRaw(path, root);
        if (resolved.getCode() != 200 || resolved.getData() == null) {
            ctx.status(resolved.getCode() > 0 ? resolved.getCode() : 500);
            ctx.output(resolved.getDescription() != null ? resolved.getDescription() : "Error");
            return;
        }

        File file = resolved.getData();
        ctx.status(200);
        ctx.headerSet("Cache-Control", "no-store");
        ctx.contentType(FileService.contentTypeOf(file.getName()));
        ctx.contentLength(file.length());
        ctx.output(Files.readAllBytes(file.toPath()));
    }

    /**
     * 登记文件变化监听根接口 —— Code 模式切换项目时调用，
     * 使 {@link WorkspaceWatcher} 覆盖所选项目目录，外部修改即可实时推送 filer_change。
     */
    @Post
    @Mapping("/web/chat/filer/watch")
    public Result<Boolean> filerWatch(@Body String body) {
        String root = null;
        if (body != null && !body.trim().isEmpty()) {
            root = ONode.ofJson(body).get("root").getString();
        }
        if (root == null || root.trim().isEmpty() || workspaceWatcher == null) {
            return Result.succeed(false);
        }
        workspaceWatcher.addRoot(Paths.get(root.trim()));
        return Result.succeed(true);
    }

    /**
     * 写入（保存）文件内容接口 —— Code 模式编辑器保存。
     *
     * @see FileService#write(String, String, String)
     */
    @Post
    @Mapping("/web/chat/filer/write")
    public Result<Map> fileWrite(@Body String body) throws Exception {
        String path = null;
        String content = null;
        String root = null;
        if (body != null && !body.trim().isEmpty()) {
            ONode json = ONode.ofJson(body);
            path = json.get("path").getString();
            content = json.get("content").getString();
            root = json.get("root").getString();
        }
        return fileService.write(path, content, root);
    }

    // ==================== Code 模式项目管理（委派给 ProjectService） ====================

    /**
     * 列出 Code 模式已登记的本地项目。
     */
    @Get
    @Mapping("/web/chat/projects")
    public Result<List<Map>> projectList() {
        return projectService.list();
    }

    /**
     * 浏览服务端目录（供前端「目录选择器」逐级浏览、选定项目根）。
     */
    @Get
    @Mapping("/web/chat/projects/browse")
    public Result<Map> projectBrowse(@Param(value = "path", required = false) String path) {
        return projectService.browse(path);
    }

    /**
     * 新增（或置顶）一个本地项目目录。
     */
    @Post
    @Mapping("/web/chat/projects/add")
    public Result<List<Map>> projectAdd(@Body String body) {
        String path = null;
        String name = null;
        if (body != null && !body.trim().isEmpty()) {
            ONode json = ONode.ofJson(body);
            path = json.get("path").getString();
            name = json.get("name").getString();
        }
        return projectService.add(path, name);
    }

    /**
     * 新建项目：在指定父目录下创建新目录并登记为项目。
     */
    @Post
    @Mapping("/web/chat/projects/create")
    public Result<List<Map>> projectCreate(@Body String body) {
        String parent = null;
        String name = null;
        if (body != null && !body.trim().isEmpty()) {
            ONode json = ONode.ofJson(body);
            parent = json.get("parent").getString();
            name = json.get("name").getString();
        }
        return projectService.create(parent, name);
    }

    /**
     * 新建目录（<b>不登记为项目</b>）：供目录浏览器「新建文件夹」使用。
     *
     * <p>为何不复用 {@code /projects/create}：create 末尾会调 add 把新目录登记进项目列表，
     * 而目录浏览器的新建是<b>导航途中</b>动作（建中间层目录再往里进），沿用 create 会每建一层
     * 就往工作区下拉塞一条垃圾项目条目。远端场景下该登记还会写进远端 projects.json，
     * 本地列表扇出后出现一堆无意义远端项目。</p>
     *
     * <p>走 {@code __scope} 分流（Rust 侧 route_for 按 query 参数选上游），因此带上
     * {@code __scope=id:<rid>} 即在远端 mkdir；不声明则落激活兜底，语义与其它 projects 端点一致。</p>
     */
    @Post
    @Mapping("/web/chat/projects/mkdir")
    public Result<Map> projectMkdir(@Body String body) {
        String parent = null;
        String name = null;
        if (body != null && !body.trim().isEmpty()) {
            ONode json = ONode.ofJson(body);
            parent = json.get("parent").getString();
            name = json.get("name").getString();
        }
        return projectService.mkdir(parent, name);
    }

    /** 消息队列文件操作工具 */
    private final QueueFileHelper queueHelper = new QueueFileHelper();

    /**
     * 移除一个本地项目登记（不删除磁盘目录）。
     */
    @Post
    @Mapping("/web/chat/projects/remove")
    public Result<List<Map>> projectRemove(@Body String body) {
        String path = null;
        if (body != null && !body.trim().isEmpty()) {
            ONode json = ONode.ofJson(body);
            path = json.get("path").getString();
        }
        return projectService.remove(path);
    }

    /**
     * 重命名一个已登记项目的显示名（仅修改展示名，不改动磁盘目录与路径，列表顺序保持不变）。
     */
    @Post
    @Mapping("/web/chat/projects/rename")
    public Result<List<Map>> projectRename(@Body String body) {
        String path = null;
        String name = null;
        if (body != null && !body.trim().isEmpty()) {
            ONode json = ONode.ofJson(body);
            path = json.get("path").getString();
            name = json.get("name").getString();
        }
        return projectService.rename(path, name);
    }

    /**
     * 同机目录定位：浏览器原生文件夹对话框（webkitdirectory / IPC）只给目录名与含文件的子目录名，
     * 由后端先比对已登记项目表（免扫描），未命中再在本机受限扫描内把「名称+子目录指纹」解析回绝对路径候选。
     */
    @Post
    @Mapping("/web/chat/projects/locate")
    public Result<Map> projectLocate(@Body String body) {
        String name = null;
        List<String> children = new ArrayList<>();
        if (body != null && !body.trim().isEmpty()) {
            ONode json = ONode.ofJson(body);
            name = json.get("name").getString();
            ONode arr = json.get("children");
            if (arr != null && arr.isArray()) {
                for (ONode c : arr.getArrayUnsafe()) children.add(c.getString());
            }
        }
        return projectService.locate(name, children);
    }

    // ==================== 消息队列管理 ====================

    /**
     * 获取指定会话的消息队列。
     */
    @Get
    @Mapping("/web/chat/queue")
    public Result<Map> queueGet(Context ctx, String sessionId) {
        sessionId = getSessionId(ctx, sessionId);
        Assert.notNull(sessionId, "sessionId is required");
        validateSessionId(sessionId);

        Path sessionDir = sessionLocator.resolveDir(sessionId, SessionCwdCodec.decode(ctx.header("X-Session-Cwd"))).toPath();
        List<ONode> items = queueHelper.read(sessionDir.toFile());

        // 将 ONode 列表转换为标准 Map 列表，确保正确序列化
        List<Map<String, Object>> itemMaps = new ArrayList<>();
        for (ONode item : items) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("content", item.get("content").getString());
            m.put("imagePaths", toList(item.get("imagePaths")));
            m.put("filePaths", toList(item.get("filePaths")));
            m.put("timestamp", item.get("timestamp").getLong());
            itemMaps.add(m);
        }

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("items", itemMaps);
        resp.put("size", items.size());
        return Result.succeed(resp);
    }

    /**
     * 添加消息到队列。
     */
    @Post
    @Mapping("/web/chat/queue/add")
    public Result<Map> queueAdd(Context ctx, @Body String body) {
        ONode json = ONode.ofJson(body);
        String sessionId = getSessionId(ctx, json.get("sessionId").getString());
        Assert.notNull(sessionId, "sessionId is required");
        validateSessionId(sessionId);

        String content = json.get("content").getString();
        ONode imagePathsNode = json.get("imagePaths");
        ONode filePathsNode = json.get("filePaths");

        List<String> imagePaths = new ArrayList<>();
        if (imagePathsNode != null && imagePathsNode.isArray()) {
            for (ONode n : imagePathsNode.getArray()) imagePaths.add(n.getString());
        }
        List<String> filePaths = new ArrayList<>();
        if (filePathsNode != null && filePathsNode.isArray()) {
            for (ONode n : filePathsNode.getArray()) filePaths.add(n.getString());
        }

        Path sessionDir = sessionLocator.resolveDir(sessionId, SessionCwdCodec.decode(ctx.header("X-Session-Cwd"))).toPath();
        int size = queueHelper.add(sessionDir.toFile(), content, imagePaths, filePaths);

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("size", size);
        return Result.succeed(resp);
    }

    /**
     * 获取并移除队列首条消息。
     */
    @Post
    @Mapping("/web/chat/queue/shift")
    public Result<Map> queueShift(Context ctx, String sessionId) {
        sessionId = getSessionId(ctx, sessionId);
        Assert.notNull(sessionId, "sessionId is required");
        validateSessionId(sessionId);

        Path sessionDir = sessionLocator.resolveDir(sessionId, SessionCwdCodec.decode(ctx.header("X-Session-Cwd"))).toPath();
        ONode item = queueHelper.shift(sessionDir.toFile());

        Map<String, Object> resp = new LinkedHashMap<>();
        if (item == null) {
            resp.put("item", null);
        } else {
            Map<String, Object> itemMap = new LinkedHashMap<>();
            itemMap.put("content", item.get("content").getString());
            itemMap.put("imagePaths", toList(item.get("imagePaths")));
            itemMap.put("filePaths", toList(item.get("filePaths")));
            itemMap.put("timestamp", item.get("timestamp").getLong());
            resp.put("item", itemMap);
        }
        return Result.succeed(resp);
    }

    /**
     * 清空队列。
     */
    @Post
    @Mapping("/web/chat/queue/clear")
    public Result<Map> queueClear(Context ctx, String sessionId) {
        sessionId = getSessionId(ctx, sessionId);
        Assert.notNull(sessionId, "sessionId is required");
        validateSessionId(sessionId);

        Path sessionDir = sessionLocator.resolveDir(sessionId, SessionCwdCodec.decode(ctx.header("X-Session-Cwd"))).toPath();
        queueHelper.clear(sessionDir.toFile());

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("cleared", true);
        return Result.succeed(resp);
    }

    /**
     * 将 ONode 数组节点转换为标准 List<String>。
     */
    private List<String> toList(ONode node) {
        if (node == null || !node.isArray()) {
            return Collections.emptyList();
        }
        List<String> list = new ArrayList<>();
        for (ONode n : node.getArray()) {
            list.add(n.getString());
        }
        return list;
    }

    /**
     * 统一 sessionId 解析：优先参数，其次请求头。
     */
    private String getSessionId(Context ctx, String param) {
        if (param != null && !param.trim().isEmpty()) {
            return param.trim();
        }
        return ctx.header("X-Session-Id");
    }

    /**
     * 校验 sessionId 安全性，防止路径穿越。
     */
    private void validateSessionId(String sessionId) {
        if (sessionId == null || sessionId.isEmpty()) {
            throw new IllegalArgumentException("sessionId is required");
        }
        if (sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            throw new IllegalArgumentException("invalid sessionId");
        }
    }
}
