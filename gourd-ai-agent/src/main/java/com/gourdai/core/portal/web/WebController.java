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
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.talents.cli.TodoTalent;
import com.gourdai.harness.talents.memory.MemorySearchResult;
import com.gourdai.harness.talents.memory.MemorySearcher;
import com.gourdai.harness.talents.memory.MemorySolution;
import com.gourdai.harness.talents.memory.MemorySolutionProvider;
import com.gourdai.harness.agent.AgentDefinition;
import com.gourdai.harness.command.Command;
import org.noear.solon.ai.talents.mount.SkillDir;
import org.noear.solon.annotation.*;
import com.gourdai.core.config.AgentFlags;
import com.gourdai.core.config.AgentSettings;
import com.gourdai.core.config.BuildInfo;
import com.gourdai.core.config.entity.ModelDo;
import com.gourdai.core.portal.WorkspaceWatcher;
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
 * <p>位于 {@code portal.web} 层，是 Solon MVC 的 Controller。
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

                // Loop 任务可能长时间执行（数小时），使用 Loop 专用无限等待版本；
                // 透传工作空间根保证 __cwd 与落盘目录正确，并按任务定义应用模型与思考档位
                return webGate.safeChatInputAndCaptureLoop(sessionId, projectRoot, worktreeRoot, effectiveInput, "Loop",
                        task != null ? task.getModelName() : null,
                        task != null ? task.getThinkingDepth() : null);
            });
        }
    }

    /**
     * 首页入口：将根路径请求转发到静态页面 index.html。
     *
     * <p>index.html 为轻量外壳，运行时装配 chat.html / code.html / settings.html 三个界面片段。</p>
     *
     * @param ctx Solon 请求上下文
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
     * @return 会话列表，每项包含 sessionId、label、time、projectRoot（仅项目会话回填）
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
        Set<String> loopSids = loopScheduler.loopSessionIds();
        if (!loopSids.isEmpty()) {
            for (Map item : data) {
                if (loopSids.contains(item.get("sessionId"))) item.put("loop", true);
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
        Arrays.sort(dirs, Comparator.comparingLong(File::lastModified).reversed());

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
            item.put("time", dir.lastModified());
            // 回填会话所属工作空间根：前端切换到历史会话时据此恢复工作空间上下文，
            // 保证发送时 X-Session-Cwd 指向正确目录（否则回退安装目录 → 会话定位错乱）。
            // 此处 root 即本次扫描所用工作空间根（null = 全局会话，不回填）。
            if (Assert.isNotEmpty(root)) {
                item.put("projectRoot", root);
            }
            data.add(item);

            //恢复定时任务（仅统一前缀 web 会话，扫描安装目录）
            if (sid.startsWith(SessionLocator.PREFIX_WORK)) {
                loopScheduler.restore(sid, engine.getWorkspace(), engine.getHarnessSessions());
            }
        }
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
        if (sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure();
        }

        // 清理 IM 通道绑定：如果此会话绑定了 IM 通道，需要解绑
        webGate.getStreamBuilder().cleanupSession(sessionId);

        // 驱逐内存中的会话缓存：必须先于删目录，否则残留的
        // FileAgentSession 会在在途轮次/循环任务等场景下重建 messages/snapshot
        // 文件，导致目录非空删不掉、累计空垃圾文件夹
        engine.removeSession(sessionId);

        // 在解绑之前解析物理目录：root 为空的项目会话仍需依赖登记表定位项目真身；
        // 若先 unbind，会错误回退到全局目录，只删掉空壳而遗留项目数据。
        File sessionDir = sessionLocator.resolveDir(sessionId, root);

        // 清除所属根登记，避免注册表残留
        sessionLocator.unbind(sessionId);

        if (sessionDir.exists() && sessionDir.isDirectory()) {
            if (!deleteDirectory(sessionDir)) {
                LOG.warn("Delete session dir failed (may be occupied): {}", sessionDir.getAbsolutePath());
                return Result.failure(500, "会话目录删除失败，可能被占用：" + sessionDir.getAbsolutePath());
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
        if (sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
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
                item.put("contextLength", config.getContextLength());
                // 接口类型：前端据此可展示每个模型对应的思考深度参数形态（档位本身是统一的）
                item.put("standard", config.getStandardOrProvider());
                // 所属供应商：前端据此对模型下拉做分组展示
                item.put("provider", config.getProvider());
                list.add(item);
            }
        }

        data.put("list", list);

        // 当前会话的思考深度档位（无会话时给默认 off），供前端初始化切换器
        String thinkingDepth = ThinkingDepth.OFF;

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
            } else {
                data.put("selected", engine.getModelOrDef(null).getNameOrModel());
            }
        } else {
            data.put("selected", "");
        }

        data.put("thinkingDepth", thinkingDepth);

        return Result.succeed(data);
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
     * <p>支持 {@code tail} 参数实现尾部加载（分页）：只返回最后 N 条事件，
     * 并附带 {@code totalCount} 和 {@code hasMore} 供前端判断是否需要加载更多。</p>
     *
     * @param sessionId 会话 ID
     * @param root      可选项目根提示（code 模式）
     * @param tail      可选，只返回最后 tail 条事件（用于尾部加载优化）
     * @return 包含 events、totalCount、hasMore 的分页结果
     */
    @Get
    @Mapping("/web/chat/replay")
    public Result<Map> replay(@Param("sessionId") String sessionId,
                                      @Param(value = "root", required = false) String root,
                                      @Param(value = "tail", required = false) Integer tail,
                                      @Param(value = "afterSeq", required = false) Long afterSeq,
                                      @Param(value = "limit", required = false) Integer limit) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure(400, "Invalid sessionId");
        }
        SessionStreamStore store = webGate.getStreamStore();
        if (store == null) {
            Map empty = new HashMap<>();
            empty.put("events", new ArrayList<>());
            empty.put("totalCount", 0);
            empty.put("hasMore", false);
            return Result.succeed(empty);
        }
        SessionStreamStore.LoadResult lr = afterSeq != null
                ? store.loadAfter(sessionId, root, Math.max(0L, afterSeq), limit)
                : store.loadWithMeta(sessionId, root, tail);
        Map result = new HashMap<>();
        result.put("events", lr.events);
        result.put("totalCount", lr.totalCount);
        result.put("hasMore", lr.hasMore);
        result.put("firstSeq", lr.firstSeq);
        result.put("lastSeq", lr.lastSeq);
        result.put("latestSeq", lr.latestSeq);
        result.put("running", webGate.isSessionBusy(sessionId));
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
        String full = store.loadFull(sessionId, root, seq);
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
        // 参数校验
        if (Assert.isEmpty(text) || text.trim().isEmpty()) {
            return Result.failure("EMPTY_TEXT");
        }
        if (text.codePointCount(0, text.length()) > SteerInterceptor.MAX_TEXT_LENGTH) {
            return Result.failure("TEXT_TOO_LONG");
        }
        if (Assert.isEmpty(steerId)) {
            return Result.failure("MISSING_STEER_ID");
        }
        String result = webGate.steer(sessionId, runId, steerId, text);
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
        if (sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure();
        }
        if (count == null || count <= 0) {
            count = 2; // 默认回退2条（用户+助手）
        }

        try {
            // 只操作 ndjson 文件（内存中的 AgentSession 在重新生成时会通过新的 prompt 重建上下文）
            File sessionDir = sessionLocator.resolveDir(sessionId, root);
            File msgFile = new File(sessionDir, sessionId + ".messages.ndjson");
            if (msgFile.exists()) {
                // 读取现有消息
                java.util.List<String> lines = new ArrayList<>();
                try (BufferedReader br = new BufferedReader(
                        new InputStreamReader(new FileInputStream(msgFile), "UTF-8"))) {
                    String line;
                    while ((line = br.readLine()) != null) {
                        line = line.trim();
                        if (!line.isEmpty()) lines.add(line);
                    }
                }
                // 移除最后 count 条
                int removeCount = Math.min(count, lines.size());
                for (int i = 0; i < removeCount; i++) {
                    lines.remove(lines.size() - 1);
                }
                // 重写文件
                StringBuilder sb = new StringBuilder();
                for (String l : lines) {
                    sb.append(l).append("\n");
                }
                java.nio.file.Files.write(msgFile.toPath(), sb.toString().getBytes("UTF-8"));
            }

            // 流式事件文件按用户轮次边界裁剪，与 messages.ndjson 的回退对齐——保留未回退
            // 轮次的完整富回放（工具卡片/过程叙述），避免一次 rewind 就把整段历史降级为纯文本。
            // count 以消息条计（一轮 = user + assistant = 2 条），换算为要剔除的用户轮次数。
            SessionStreamStore store = webGate.getStreamStore();
            if (store != null) {
                int turns = Math.max(1, count / 2);
                store.rewindTurns(sessionId, root, turns);
            }

            return Result.succeed();
        } catch (Exception e) {
            LOG.error("Rewind failed for session {}: {}", sessionId, e.getMessage());
            return Result.failure(500, e.getMessage());
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
            item.put("mountAlias", skill.getMountAlias());
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
     * @param ctx             Solon 请求上下文，用于读取请求头
     * @param input           用户输入的文本消息
     * @param attachments     上传的附件文件数组，可为 null
     * @param attachmentTypes 附件类型数组，与 attachments 一一对应
     * @param model           指定的 AI 模型名称，可为 null（使用默认模型）
     * @param sessionId       会话 ID，若为空则从请求头 X-Session-Id 获取
     * @return 操作结果（AI 结果通过 WebSocket 推送）
     */
    @Mapping("/web/chat/input")
    public Result chat_input(Context ctx, String input, UploadedFile[] attachments, String attachmentTypes[], String model, String sessionId) {
        try {
            if (sessionId == null || sessionId.isEmpty()) {
                sessionId = ctx.headerOrDefault("X-Session-Id", "web");
            }
            String sessionCwd = ctx.header("X-Session-Cwd");
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

            // busy 请求不允许改变活动任务的会话根；真正的原子 busy 判定在 WebGate 输入锁内完成。
            if (Assert.isEmpty(hitlAction) && webGate.isSessionBusy(sessionId)) {
                return Result.succeed("busy");
            }

            // 根登记与最终受理都在 WebGate 中按同一会话串行处理；这里不提前改绑，
            // 避免预检通过后被并发任务抢先启动时污染活动会话根。

            // 路由到 WebGate 处理（AI 结果通过 WebSocket 推送到前端）
            // 网页端手动输入：source=null，出站不回推 IM（仅当活跃会话由 IM/Loop 触发时才回推）
            boolean accepted = webGate.onChatInput(sessionId, sessionCwd, input, model, attachments, attachmentTypes,
                    hitlAction, null, clientMessageId);
            if (!accepted) {
                return Result.succeed("busy");
            }

            // 返回简单 JSON，前端通过 WebSocket 接收 AI 结果
            return Result.succeed();
        } catch (Throwable e) {
            LOG.error("[Web] chat_input error: {}", e.getMessage());
            return Result.failure(500, e.getMessage());
        }
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
            // 执行上下文（自动化页面的工作空间 / 模型 / 思考档位）：未设置时不输出，前端视为“跟随默认”
            if (t.getWorkspace() != null) item.put("workspace", t.getWorkspace());
            if (t.getModelName() != null) item.put("modelName", t.getModelName());
            if (t.getThinkingDepth() != null) item.put("thinkingDepth", t.getThinkingDepth());
            if (t.getChannelNotify() != null) item.put("channelNotify", t.getChannelNotify());
            if (t.getBoundSessionId() != null) item.put("boundSessionId", t.getBoundSessionId());
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
                if (t.getChannelNotify() != null) item.put("channelNotify", t.getChannelNotify());
                if (t.getBoundSessionId() != null) item.put("boundSessionId", t.getBoundSessionId());
                if (t.getRuntimeSessionId() != null) item.put("runtimeSessionId", t.getRuntimeSessionId());
                return Result.succeed(item);
            }
        }
        return Result.failure(404, "Task not found");
    }

    /**
     * 新增循环任务。
     */
    @Post
    @Mapping("/web/chat/loop/add")
    public Result loopAdd(@Param("sessionId") String sessionId,
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
                          @Param(value = "boundSessionId", required = false) String boundSessionId) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure(400, "Invalid sessionId");
        }
        if (prompt == null || prompt.trim().isEmpty()) {
            return Result.failure(400, "prompt is required");
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
                channelNotify, boundSessionId
        );

        task.setName(name);

        try {
            LoopStateManager.init(workspace, task.getId(), prompt);
            loopScheduler.schedule(sessionId, workspace, harnessSessions, task);
        } catch (IllegalStateException e) {
            return Result.failure(400, e.getMessage());
        }

        return Result.succeed(task.getId());
    }

    /**
     * 更新循环任务定义。
     */
    @Post
    @Mapping("/web/chat/loop/update")
    public Result loopUpdate(@Param("sessionId") String sessionId,
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
                             @Param(value = "boundSessionId", required = false) String boundSessionId) {
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

        LoopTask newTask = existing.copyWithUpdate(
                effectivePrompt, interval, effectiveCron,
                goalCondition != null ? goalCondition : existing.getGoalCondition(),
                worktreeEnabled != null ? worktreeEnabled : existing.isWorktreeEnabled(),
                maxIterations != null ? maxIterations : existing.getMaxIterations(),
                runNow != null ? runNow : existing.isRunNow(),
                effectiveWorkspace, effectiveModelName, effectiveThinking,
                effectiveChannel, effectiveBoundSession
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
        return Result.succeed();
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
        String sessionCwd = ctx.header("X-Session-Cwd");
        if (sessionCwd != null && sessionCwd.contains("..")) {
            return Result.failure(400, "Invalid Session Cwd");
        }
        if (Assert.isNotEmpty(sessionCwd)) {
            sessionLocator.bindSessionRoot(sessionId, sessionCwd);
        }

        Path todoPath = sessionLocator.resolveDir(sessionId, sessionCwd).toPath()
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

        boolean global = "global".equals(scope);
        String cwd;
        if (global) {
            cwd = AgentFlags.getHarnessBase();
        } else {
            // 与 todos() 同一套工作区解析逻辑：code 会话记忆落在所选项目目录下
            String sessionCwd = ctx.header("X-Session-Cwd");
            if (sessionCwd != null && sessionCwd.contains("..")) {
                return Result.failure(400, "Invalid Session Cwd");
            }
            cwd = Assert.isNotEmpty(sessionCwd) ? sessionCwd : engine.getWorkspace();
        }

        Map<String, Object> data = new LinkedHashMap<>();
        try {
            MemorySolution solution = memoryProvider.get(cwd);
            MemorySearcher searcher = solution == null ? null : solution.getSearcher();

            List<Map<String, Object>> items = new ArrayList<>();
            if (searcher != null) {
                for (MemorySearchResult r : searcher.listAll("shared", 200)) {
                    Map<String, Object> item = new LinkedHashMap<>();
                    item.put("key", r.getKey());
                    item.put("content", r.getContent());
                    item.put("importance", r.getImportance());
                    item.put("time", r.getTime());
                    items.add(item);
                }
            }

            data.put("scope", global ? "global" : "workspace");
            data.put("items", items);
            data.put("total", items.size());
            return Result.succeed(data);
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

        boolean global = "global".equals(scope);
        String cwd;
        if (global) {
            cwd = AgentFlags.getHarnessBase();
        } else {
            // 与 memoryList 同一套工作区解析逻辑
            String sessionCwd = ctx.header("X-Session-Cwd");
            if (sessionCwd != null && sessionCwd.contains("..")) {
                return Result.failure(400, "Invalid Session Cwd");
            }
            cwd = Assert.isNotEmpty(sessionCwd) ? sessionCwd : engine.getWorkspace();
        }

        try {
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
        } catch (Exception e) {
            LOG.error("Failed to delete memory, scope={}, key={}: {}", scope, key, e.getMessage());
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

        Path sessionDir = sessionLocator.resolveDir(sessionId, ctx.header("X-Session-Cwd")).toPath();
        List<ONode> items = queueHelper.read(sessionDir.toFile());

        // 将 ONode 列表转换为标准 Map 列表，确保 Solon 正确序列化
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

        Path sessionDir = sessionLocator.resolveDir(sessionId, ctx.header("X-Session-Cwd")).toPath();
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

        Path sessionDir = sessionLocator.resolveDir(sessionId, ctx.header("X-Session-Cwd")).toPath();
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

        Path sessionDir = sessionLocator.resolveDir(sessionId, ctx.header("X-Session-Cwd")).toPath();
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
