package com.gourdai;

import com.agentclientprotocol.sdk.agent.transport.StdioAcpAgentTransport;
import com.agentclientprotocol.sdk.spec.AcpAgentTransport;
import com.gourdai.core.command.builtin.*;
import com.gourdai.core.portal.WorkspaceWatcher;
import com.gourdai.core.portal.web.*;
import org.noear.solon.Solon;
import com.gourdai.agent.AgentSession;
import com.gourdai.agent.AgentSessionProvider;
import com.gourdai.agent.react.BackgroundNoticeCenter;
import com.gourdai.agent.session.FileAgentSession;
import com.gourdai.agent.session.LruSessionCache;
import org.noear.solon.ai.chat.CacheControl;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.HarnessExtension;
import org.noear.solon.ai.talents.mount.MountDir;
import org.noear.solon.ai.talents.mount.MountType;
import org.noear.solon.annotation.Bean;
import org.noear.solon.annotation.Configuration;
import org.noear.solon.annotation.Init;
import org.noear.solon.annotation.Inject;
import com.gourdai.core.config.AgentFlags;
import com.gourdai.core.channel.Channel;
import com.gourdai.core.config.AgentSettings;
import com.gourdai.core.config.ManagerExtension;
import com.gourdai.core.config.entity.ApiSourceDo;
import com.gourdai.core.config.entity.McpServerDo;
import com.gourdai.core.config.entity.ModelDo;
import com.gourdai.core.config.entity.LspServerDo;
import com.gourdai.core.config.entity.MountDo;
import com.gourdai.core.memory.MemoryProvider;
import com.gourdai.core.portal.acp.AcpLink;
import com.gourdai.core.portal.cli.CliShell;
import com.gourdai.core.portal.desktop.WsController;
import com.gourdai.core.portal.desktop.WsGate;
import com.gourdai.core.portal.desktop.provider.ModelProviderFactory;
import org.noear.solon.core.AppContext;
import org.noear.solon.core.BeanWrap;
import org.noear.solon.core.util.Assert;
import org.noear.solon.core.util.JavaUtil;
import org.noear.solon.core.util.RunUtil;
import org.noear.solon.net.http.HttpConfiguration;
import org.noear.solon.net.http.HttpExtension;
import org.noear.solon.net.http.HttpUtils;
import org.noear.solon.net.websocket.WebSocketRouter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 *
 * @author oisin
 *
 */
@Configuration
public class Configurator {
    private static final Logger LOG = LoggerFactory.getLogger(Configurator.class);

    @Inject
    AppContext appContext;

    @Inject
    HarnessEngine agentRuntime;

    @Inject
    AgentSettings agentSettings;

    @Inject
    ModelProviderFactory modelProviderFactory;

    private LoopScheduler loopScheduler;

    /** 会话目录定位器：统一解析 chat（全局）/ code（项目）会话的落盘位置 */
    private SessionLocator sessionLocator;

    /** 工作区文件变化监听器：Code 模式切换项目时动态追加监听根 */
    private WorkspaceWatcher workspaceWatcher;

    @Bean
    public HarnessEngine agentRuntime(AgentSettings settings) throws Exception {
        // 全局 HTTP 出站 UA 兜底（对齐 soloncode v2026.8.7 同源修复）：
        // 所有 HttpUtils 实例（含 MCP 客户端、市场下载等库代码内部创建的）在构造期
        // 自动带上设置里的 userAgent，避免默认 UA（如 Java/17）被 CDN/WAF 拦截导致
        // websearch 等出站请求失败。onInit 先于业务代码执行，显式设置的 UA 仍可覆盖。
        // 每次实时读取 settings，用户在设置页改 UA 后即时生效，无需重启。
        HttpConfiguration.addExtension(new HttpExtension() {
            @Override
            public void onInit(HttpUtils http, String url) {
                String ua = settings.getGeneral().getUserAgent();
                if (Assert.isNotEmpty(ua)) {
                    http.userAgent(ua);
                }
            }
        });

        String workspace = AgentFlags.getUserDir();
        String globalBase = AgentFlags.getHarnessBase();
        // LRU 会话缓存：容量上限 100，超限按最近访问时间淘汰最老的非活跃会话；
        // 淘汰仅摘除内存引用（磁盘文件保留），下次访问自动从磁盘重载，
        // 对话历史与压缩摘要不受影响；在途（busy）或挂起（HITL）会话不淘汰
        LruSessionCache sessionCache = new LruSessionCache();

        // 会话目录定位器：项目会话写项目根，全局会话写明确的全局基准目录。
        this.sessionLocator = new SessionLocator(workspace, globalBase, AgentFlags.getHarnessSessions());
        final SessionLocator locator = this.sessionLocator;

        // 按会话所属根解析落盘目录（未登记根的全局会话回退全局基准目录）
        AgentSessionProvider sessionProvider = new AgentSessionProvider() {
            @Override
            public AgentSession getSession(String sessionId) {
                return sessionCache.getOrLoad(sessionId, key ->
                        new FileAgentSession(key, locator.resolveDir(key).toString()));
            }

            @Override
            public void removeSession(String sessionId) {
                AgentSession removed = sessionCache.remove(sessionId);
                if (removed != null) {
                    // 会话被删除后不会再有下一轮推理去消费后台任务完成通知，立即回收其归属桶，
                    // 否则要等到 TTL 到期才释放（TTL 只是兜底，覆盖 LRU 淘汰等拿不到时机的路径）
                    BackgroundNoticeCenter.discardByContext(removed.getContext());
                }
                if (removed instanceof FileAgentSession) {
                    // 清理内存缓存（并删除已落盘的 messages/snapshot 文件），
                    // 切断后续持久化重建目录的可能
                    ((FileAgentSession) removed).clear();
                }
            }
        };

        HarnessEngine engine = HarnessEngine.of(workspace, AgentFlags.getHarnessHome())
                .userAgent(settings.getGeneral().getUserAgent())
                .systemPrompt(AgentFlags.getAgentsMd())
                .maxTurns(settings.getGeneral().getMaxTurns())
                .autoRethink(settings.getGeneral().getAutoRethink())
                .sessionProvider(sessionProvider)
                // 历史窗口大小用于保留窗口兜底（minReservedMessages = maxMessages / 3）
                .compressionThreshold(settings.getGeneral().getHistoryWindowSize())
                .compressionRatio(settings.getGeneral().getCompressionRatio())
                .compressionTargetRatio(settings.getGeneral().getCompressionTargetRatio())
                .compressionReservedOutputTokens(settings.getGeneral().getCompressionReservedOutputTokens())
                .intentChainEnabled(settings.getGeneral().getIntentChainEnabled())
                .intentChainMaxTokens(settings.getGeneral().getIntentChainMaxTokens())
                .compressionModel(settings.getGeneral().getSummaryModel())
                .memoryEnabled(settings.getGeneral().getMemoryEnabled())
                .memoryProvider(new MemoryProvider(agentSettings))
                .sandboxEnabled(settings.getGeneral().getSandboxMode())
                .sandboxAllowUserHome(settings.getGeneral().getSandboxAllowUserHome())
                .sandboxSystemRestrict(settings.getGeneral().getSandboxSystemRestrict())
                .subagentEnabled(settings.getGeneral().getSubagentEnabled())
                .hitlEnabled(settings.getGeneral().getHitlEnabled())
                .apiRetries(settings.getGeneral().getApiRetries())
                .modelRetries(settings.getGeneral().getModelRetries())
                .mcpRetries(settings.getGeneral().getModelRetries())
                .toolsAdd(settings.getPermission().getTools())
                .disallowedToolsAdd(settings.getPermission().getDisallowedTools())
                .cacheControl(CacheControl.ofEphemeral())
                .build();


        // Gemini 思考深度补丁：以更高优先级注册，修复上游 generateContent 丢弃 thinkingConfig 的问题
        org.noear.solon.ai.chat.dialect.ChatDialectManager.register(
                new GeminiThinkingChatDialect(), -1);

        engine.setDefaultModel(settings.getDefaultModel());
        for (ModelDo model : agentSettings.getModels().values()) {
            engine.addModel(model);
        }

        for (Map.Entry<String, MountDo> entry : agentSettings.getMountPools().entrySet()) {
            MountDo mount = entry.getValue();
            engine.addMount(MountDir.builder()
                    .alias(entry.getKey())
                    .description(mount.getDescription())
                    .type(mount.getType())
                    .path(mount.getPath())
                    .primary(mount.isPrimary())
                    .enabled(mount.isEnabled())
                    .writeable(mount.isWriteable())
                    .build());
        }

        // 全局区技能/子代理：统一落全局基准目录。
        // 保留 @global-* 别名（UI/提示词/测试均按别名引用）。
        engine.addMount(MountDir.builder().alias("@global-skills").type(MountType.SKILLS).path(Paths.get(globalBase, engine.getHarnessSkills()).toString()).primary(true).build());
        engine.addMount(MountDir.builder().alias("@workspace-skills").type(MountType.SKILLS).path("./" + engine.getHarnessSkills()).primary(true).build());

        engine.addMount(MountDir.builder().alias("@global-agents").type(MountType.AGENTS).path(Paths.get(globalBase, engine.getHarnessAgents()).toString()).primary(true).build());
        engine.addMount(MountDir.builder().alias("@workspace-agents").type(MountType.AGENTS).path("./" + engine.getHarnessAgents()).primary(true).build());


        engine.getCommandRegistry().load(Paths.get(AgentFlags.getHarnessBase(), engine.getHarnessCommands()));
        engine.getCommandRegistry().load(Paths.get(workspace, engine.getHarnessCommands()));

        engine.getCommandRegistry().register(new ExitCommand());
        engine.getCommandRegistry().register(new ClearCommand());
        engine.getCommandRegistry().register(new ContinueCommand());
        engine.getCommandRegistry().register(new RerunCommand());
        engine.getCommandRegistry().register(new RewindCommand());
        engine.getCommandRegistry().register(new ModelCommand());
        engine.getCommandRegistry().register(new CompactCommand());

        engine.getLspTalent().setEnabled(settings.getGeneral().getLspEnabled());

        // ACP 模式下不加载 MCP/OpenAPI/LSP 服务器，避免子进程 Stdio 竞争
        if (!isAcpMode()) {
            RunUtil.async(() -> addServers(engine));
        }

        // loop scheduler
        this.loopScheduler = new LoopScheduler(engine, AgentFlags.getHarnessLoopWorktrees());
        engine.getCommandRegistry().register(new LoopCommand(loopScheduler));


        engine.addExtension(new ManagerExtension(engine, agentSettings));

        return engine;
    }

    private void addServers(HarnessEngine engine){
        for (Map.Entry<String, McpServerDo> entry : agentSettings.getMcpServers().entrySet()) {
            engine.addMcpServer(entry.getKey(), entry.getValue());
        }

        for (Map.Entry<String, ApiSourceDo> entry : agentSettings.getApiServers().entrySet()) {
            engine.addApiServer(entry.getValue());
        }

        for (Map.Entry<String, LspServerDo> entry : agentSettings.getLspServers().entrySet()) {
            engine.addLspServer(entry.getKey(), entry.getValue());
        }

        //系统级 LSP 服务器（参考 OpenCode / Claude Code 内置列表，仅注册常见语言）
        addSystemLspServer(engine, agentSettings, "java", Arrays.asList("jdtls"), Arrays.asList(".java"));
        addSystemLspServer(engine, agentSettings, "typescript", Arrays.asList("typescript-language-server", "--stdio"), Arrays.asList(".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"));
        addSystemLspServer(engine, agentSettings, "go", Arrays.asList("gopls"), Arrays.asList(".go"));
        addSystemLspServer(engine, agentSettings, "python", Arrays.asList("pyright-langserver", "--stdio"), Arrays.asList(".py", ".pyi"));
        addSystemLspServer(engine, agentSettings, "rust", Arrays.asList("rust-analyzer"), Arrays.asList(".rs"));
        addSystemLspServer(engine, agentSettings, "c-cpp", Arrays.asList("clangd", "--background-index", "--clang-tidy"), Arrays.asList(".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hxx", ".c++", ".h++", ".hh"));
        addSystemLspServer(engine, agentSettings, "csharp", Arrays.asList("roslyn-language-server", "--stdio", "--autoLoadProjects"), Arrays.asList(".cs", ".csx"));
        addSystemLspServer(engine, agentSettings, "ruby", Arrays.asList("solargraph", "stdio"), Arrays.asList(".rb", ".rake", ".gemspec", ".ru"));
        addSystemLspServer(engine, agentSettings, "php", Arrays.asList("intelephense", "--stdio"), Arrays.asList(".php"));
        addSystemLspServer(engine, agentSettings, "bash", Arrays.asList("bash-language-server", "start"), Arrays.asList(".sh", ".bash", ".zsh", ".ksh"));
        addSystemLspServer(engine, agentSettings, "lua", Arrays.asList("lua-language-server"), Arrays.asList(".lua"));
        addSystemLspServer(engine, agentSettings, "dart", Arrays.asList("dart", "language-server", "--lsp"), Arrays.asList(".dart"));
        addSystemLspServer(engine, agentSettings, "swift", Arrays.asList("sourcekit-lsp"), Arrays.asList(".swift", ".objc", ".objcpp"));
        addSystemLspServer(engine, agentSettings, "kotlin", Arrays.asList("kotlin-language-server"), Arrays.asList(".kt", ".kts"));
        addSystemLspServer(engine, agentSettings, "yaml", Arrays.asList("yaml-language-server", "--stdio"), Arrays.asList(".yaml", ".yml"));

    }

    @Init
    public void init() {
        //订阅容器扩展
        appContext.subBeansOfType(HarnessExtension.class, extension -> {
            agentRuntime.addExtension(extension);
        });


        String flag = Solon.cfg().argx().flagAt(0);

        // 按 flag 惰性构造 CliShell —— 此前只有 ACP 模式跳过，导致桌面端（web）也在启动主线程上
        // 付了 JLine 终端的初始化成本：TerminalBuilder 要反复 fork 子进程探测标准流是否接在真实
        // 终端上（Windows 实测 0.5~1.9s；PATH 里存在 msys sh.exe 时更慢），而这段完全发生在
        // Solon 启动主线程、HTTP 端口绑定之前，直接表现为冷启动变慢。
        //
        // 各分支的真实用法：run 自己另建一个；web / acp 全程不使用；serve 只用到 printWelcome；
        // 只有 cli（交互式命令行）真正需要它。故除这三者外一律不构造。
        CliShell cliShell = needsInteractiveShell(flag)
                ? new CliShell(agentRuntime, agentSettings, loopScheduler)
                : null;

        if (AgentFlags.FLAG_VERSION.equals(flag)) {
            System.out.println(Solon.cfg().appTitle() + " " + AgentFlags.getVersion());
            return;
        }

        // ACP 模式通过 Stdio JSON-RPC 与编辑器通信，System.out 必须保持纯净，
        // 任何非 JSON 输出都会破坏协议流导致握手失败。
        if (!AgentFlags.FLAG_ACP.equals(flag)) {
            checkUpdate();
        }

        //flag
        if (Solon.cfg().argx().flags().size() > 0) {
            if (AgentFlags.FLAG_RUN.equals(flag)) { // java -jar gourdai.jar run '你好' // gourdai run '你好'
                //单次任务态
                String prompt = Solon.cfg().argx().flagAt(1);
                new CliShell(agentRuntime, agentSettings, null).call(prompt);
                Solon.stop();
                return;
            }

            if (AgentFlags.FLAG_SERVE.equals(flag)) { // java -jar gourdai.jar server // gourdai server
                runServe(agentRuntime, agentSettings, cliShell);
                return;
            }

            if (AgentFlags.FLAG_WEB.equals(flag)) { // java -jar gourdai.jar web // gourdai web
                runWeb(agentRuntime, agentSettings, cliShell);
                return;
            }

            if (AgentFlags.FLAG_ACP.equals(flag)) { // java -jar gourdai.jar acp // gourdai acp
                runAcp(agentRuntime, agentSettings, cliShell);
                return;
            }

            //未来可以支持更多控制标记
        }

        if (AgentFlags.FLAG_SERVE.equals(flag)) { // java -jar gourdai.jar server // gourdai server
            runServe(agentRuntime, agentSettings, cliShell);
            return;
        }

        if (AgentFlags.FLAG_ACP.equals(flag)) { // java -jar gourdai.jar acp // gourdai acp
            runAcp(agentRuntime, agentSettings, cliShell);
            return;
        }

        if (AgentFlags.FLAG_CLI.equals(flag)) { // java -jar gourdai.jar cli // gourdai cli
            new Thread(cliShell, "CLI-Interactive-Thread").start();
            return;
        }

        //web - default
        runWeb(agentRuntime, agentSettings, cliShell);
    }

    private void checkUpdate() {
        // 更新检测要请求 www.gourd-ai.cn（失败/慢时约 1~2s），放到后台守护线程执行，
        // 不阻塞应用启动（尤其桌面端冷启动直接影响 UI 首屏可用时间）。
        // 仅打印一条“发现新版本”的提示，晚一点出现无妨。
        Thread t = new Thread(() -> {
            try {
                if (AgentFlags.checkUpdate()) {
                    // 使用颜色代码让提示更醒目
                    System.out.println("\033[33mDiscover the new version: " + AgentFlags.getLastVersion() + "\033[0m");

                    if (JavaUtil.IS_WINDOWS) {
                        System.out.println("Update: \033[36mirm https://www.gourd-ai.cn/setup.ps1 | iex\033[0m");
                    } else {
                        System.out.println("Update: \033[36mcurl -fsSL https://www.gourd-ai.cn/setup.sh | bash\033[0m");
                    }
                    System.out.println();
                }
            } catch (Throwable e) {
                // 忽略：更新检测不影响主流程
            }
        }, "update-check");
        t.setDaemon(true);
        t.start();
    }

    private void runServe(HarnessEngine agentRuntime, AgentSettings settings, CliShell cliShell) {
        //serve ws gate
        WebSocketRouter.getInstance().of("/ws", new WsGate(agentRuntime, settings));

        //serve web controller
        BeanWrap webBean = Solon.context().wrapAndPut(WsController.class, new WsController(agentRuntime, modelProviderFactory));
        Solon.app().router().add(webBean);

        //注册第三方渠道（HTTP 端点 + 后台线程）
        WebGate webGate = new WebGate(agentRuntime);
        webGate.setSessionLocator(sessionLocator);
        webGate.setStreamStore(new SessionStreamStore(sessionLocator));
        WebStreamBuilder streamBuilder = new WebStreamBuilder(agentRuntime);
        WebChannel webChannel = new WebChannel(agentRuntime, webGate, sessionLocator, new ProjectService());
        // 将渠道绑定到 streamBuilder，使 IM 回复能同步
        for (Channel ch : Collections.singletonList(webChannel.getWeChatLink())) {
            streamBuilder.bind(ch);
        }
        streamBuilder.bind(webChannel.getFeishuLink());
        streamBuilder.bind(webChannel.getDingTalkLink());
        BeanWrap channelBean = Solon.context().wrapAndPut(WebChannel.class, webChannel);
        Solon.app().router().add(channelBean);
        RunUtil.async(webChannel);

        // 将远控通道注入定时任务调度器，支持自动推送
        loopScheduler.setChannels(Arrays.asList(
                webChannel.getWeChatLink(),
                webChannel.getFeishuLink(),
                webChannel.getDingTalkLink()));
        loopScheduler.setRoutingTable(webChannel.getRoutingTable());

        // 恢复全局定时任务
        loopScheduler.restore(null, agentRuntime.getWorkspace(), agentRuntime.getHarnessSessions());

        //settings controller
        WebSettingsController settingsController = new WebSettingsController(agentRuntime, settings);
        BeanWrap webSettingsController = Solon.context().wrapAndPut(WebSettingsController.class, settingsController);
        Solon.app().router().add(webSettingsController);

        cliShell.printWelcome("Server port: " + Solon.cfg().serverPort());
    }


    private void runWeb(HarnessEngine agentRuntime, AgentSettings settings, CliShell cliShell) {
        //web ws gate
        WebGate webGate = new WebGate(agentRuntime);
        webGate.setSessionLocator(sessionLocator);
        SessionStreamStore streamStore = new SessionStreamStore(sessionLocator);
        webGate.setStreamStore(streamStore);
        WebSocketRouter.getInstance().of("/web/gate", webGate);

        //code 模式本地终端网关
        WebSocketRouter.getInstance().of("/web/terminal", new TerminalGate(agentRuntime.getWorkspace()));

        // 启动工作区文件变化监听（先于 WebController 创建，供其登记 Code 项目监听根）
        try {
            Path workspacePath = Paths.get(agentRuntime.getWorkspace()).toAbsolutePath().normalize();
            this.workspaceWatcher = new WorkspaceWatcher(workspacePath);
            workspaceWatcher.addBroadcastHandler(webGate::broadcastRaw);
            workspaceWatcher.start();
        } catch (Exception e) {
            // watcher 启动失败不影响主流程
        }

        //web
        BeanWrap webController = Solon.context().wrapAndPut(WebController.class, new WebController(agentRuntime, webGate, loopScheduler, sessionLocator, settings, workspaceWatcher));
        Solon.app().router().add(webController);

        WebSettingsController settingsController = new WebSettingsController(agentRuntime, settings);
        BeanWrap webSettingsController = Solon.context().wrapAndPut(WebSettingsController.class, settingsController);
        Solon.app().router().add(webSettingsController);

        WebChannel webChannelInst = new WebChannel(agentRuntime, webGate, sessionLocator, new ProjectService());
        BeanWrap webChannel = Solon.context().wrapAndPut(WebChannel.class, webChannelInst);
        Solon.app().router().add(webChannel);

        // 将远控通道注入定时任务调度器，支持自动推送
        loopScheduler.setChannels(Arrays.asList(
                webChannelInst.getWeChatLink(),
                webChannelInst.getFeishuLink(),
                webChannelInst.getDingTalkLink()));
        loopScheduler.setRoutingTable(webChannelInst.getRoutingTable());

        // 恢复全局定时任务
        loopScheduler.restore(null, agentRuntime.getWorkspace(), agentRuntime.getHarnessSessions());

        // 启动微信通道
        RunUtil.async((Runnable) webChannel.get());

        // 启动后静默增量归档用量：把各会话新产生的 token 消耗并入月度账本，
        // 使历史用量不随项目删除/移走而丢失（统计页打开时还会再做一次，幂等）。
        // 延迟让位给启动主流程；守护线程 + 异常静默，不影响启动。
        // 启动桌面 Web 生命周期内的小时用量同步；无 endpoint 时仅生成本地 outbox。
        try {
            UsageSubmissionService.shared().startHourlySync();
        } catch (Throwable e) {
            LOG.warn("Unable to start usage telemetry (application startup continues): {}", e.getMessage());
        }
        startUsageArchiveWarmup(agentRuntime);

        if (cliShell == null) {
            return;
        }

//        String url = "http://localhost:" + Solon.cfg().serverPort() + "/";
//        cliShell.printWelcome("Web interface: " + url);
    }


    /**
     * 启动时静默增量归档用量账本。
     *
     * <p>扫描全局区与所有已登记项目根下的会话流文件，把水位之后的新事件
     * 聚合进 {@code <globalBase>/.gwork/usage/usage-YYYY-MM.json}。首次运行会回填存量历史，
     * 之后每次只处理增量，耗时极短。</p>
     */
    private void startUsageArchiveWarmup(HarnessEngine agentRuntime) {
        if (sessionLocator == null) {
            return;
        }
        Thread t = new Thread(() -> {
            try {
                Thread.sleep(3000L);
                new UsageArchiveService(sessionLocator, AgentFlags.getHarnessBase()).archiveIncremental();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } catch (Throwable e) {
                // 忽略：归档失败不影响主流程（下次启动或打开统计页时重试）
            }
        }, "usage-archive-warmup");
        t.setDaemon(true);
        t.start();
    }


    private void runAcp(HarnessEngine agentRuntime, AgentSettings settings, CliShell cliShell) {
        AcpAgentTransport agentTransport = new StdioAcpAgentTransport();

        new AcpLink(agentRuntime, agentTransport, settings).run();

//        if (cliShell == null) {
//            return;
//        }

        //不能有打印
        //cliShell.printWelcome("Acp interface: stdio");
    }

    /**
     * 添加系统级 LSP 服务器（如果用户未自定义同名配置，则注册）
     */
    private void addSystemLspServer(HarnessEngine engine, AgentSettings settings, String name, List<String> command, List<String> extensions) {
        // 如果用户已自定义同名配置，跳过系统级注册
        if (settings.getLspServers().containsKey(name)) {
            return;
        }

        LspServerDo lspServer = new LspServerDo();
        lspServer.setCommand(command);
        lspServer.setExtensions(extensions);
        lspServer.setEnabled(false); // 默认禁用，用户按需启用
        lspServer.setScope(AgentFlags.SCOPE_LOCAL);

        // 注册到引擎（不启用不会真正加载，仅作为可选项）
        engine.addLspServer(name, lspServer);

        // 同步到 settings 以便前端展示
        settings.getLspServers().put(name, lspServer);
    }

    /** 检测当前是否为 ACP Stdio 模式 */
    private boolean isAcpMode() {
        String flag = Solon.cfg().argx().flagAt(0);
        return AgentFlags.FLAG_ACP.equals(flag);
    }

    /**
     * 是否需要预先构造交互式 {@link CliShell}。
     *
     * <p>只有 {@code cli}（交互式命令行）与 {@code serve}（启动后打印欢迎语）会真正用到它：
     * {@code run} 在分支内自行构造，{@code web} / {@code acp} 全程不使用。</p>
     *
     * <p><b>维护约束</b>：本判定必须与 {@link #init()} 里各分支的实际用法同步。新增对
     * {@code cliShell} 的使用点时，务必回到这里放行对应的 flag，否则会在运行期退化为 NPE。</p>
     *
     * <p>包可见而非私有：这是「启动路径上少 init 一个 JLine 终端」与「NPE」之间唯一的开关，
     * 必须有回归护栏钉死各 flag 的取值（见 {@code ConfiguratorCliShellTest}）。</p>
     */
    static boolean needsInteractiveShell(String flag) {
        return AgentFlags.FLAG_CLI.equals(flag) || AgentFlags.FLAG_SERVE.equals(flag);
    }
}