package com.gourdai.harness.hitl;

import com.gourdai.agent.AgentSession;
import com.gourdai.agent.react.ReActOptions;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.intercept.HITL;
import com.gourdai.agent.react.intercept.HITLInterceptor;
import com.gourdai.agent.react.intercept.HITLTask;
import com.gourdai.agent.react.task.ToolExchanger;
import com.gourdai.ai.chat.message.ChatMessage;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.permission.AccessMode;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.noear.solon.flow.FlowContext;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Base64;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * bash 路径边界的<b>接线</b>契约：越界写必须真的走到审批挂起，而不是只存在于
 * {@link BashPathGuard} 里。
 *
 * <p>为什么必须有这一层测试（本仓的历史教训）：把 {@code HITLInterceptor.onAction} 的档位
 * 早退删掉、或把 {@code AgentFactory} 的装配退回全局开关，既有测试<b>无一变红</b>——
 * 因为策略层测试全部直调 {@code HitlStrategy.evaluate(null, args)}，绕开了真实链路。
 * 「逻辑写对了」与「逻辑被接上了」是两件事，只有驱动 onAction 才能证明后者。</p>
 *
 * <p>本测试同时锁三件事：</p>
 * <ol>
 *   <li>默认档下越界写 → 会话挂起（pending）+ 审批理由落到上下文；</li>
 *   <li>越界<b>读</b> → 挂起且文案报「读取」（用户拍板口径）；工作区内读写、构建缓存
 *       → 不挂起（否则默认档寸步难行）；</li>
 *   <li>完全访问档下同一条越界写 → 不挂起（用户已确认风险，路径轴随之解除）。</li>
 * </ol>
 *
 * <h3>工作区为什么不用 {@code @TempDir}</h3>
 *
 * <p>{@code java.io.tmpdir} 在内置豁免清单里（构建工具必须能写临时目录）。若把工作区建在
 * 临时目录下，「工作区外」的目标往往仍落在临时目录<b>内</b>而被豁免放行——测试恒绿但护栏无效。
 * 故建在模块 {@code target/} 下。</p>
 */
class BashPathBoundaryWiringTest {

    private static Path holder;
    private static Path workspace;
    private static Path outside;

    @BeforeAll
    static void createDirs() throws IOException {
        holder = Paths.get("").toAbsolutePath().resolve("target")
                .resolve("bpg-wiring-" + System.nanoTime());
        workspace = holder.resolve("ws");
        outside = holder.resolve("outside");
        Files.createDirectories(workspace);
        Files.createDirectories(outside);
    }

    @AfterAll
    static void removeDirs() {
        deleteQuietly(holder);
    }

    private static void deleteQuietly(Path p) {
        if (p == null) {
            return;
        }
        try {
            if (Files.isDirectory(p)) {
                try (var stream = Files.list(p)) {
                    for (Path child : stream.toList()) {
                        deleteQuietly(child);
                    }
                }
            }
            Files.deleteIfExists(p);
        } catch (IOException ignored) {
            // 清理失败不影响判定
        }
    }

    // ==========================================================================
    // 桩：最小可运行链路（真实 HITLInterceptor + 真实 HitlStrategy）
    // ==========================================================================

    private static AgentSession sessionOf(FlowContext ctx) {
        return new AgentSession() {
            @Override
            public void updateSnapshot() {
            }

            @Override
            public FlowContext getContext() {
                return ctx;
            }

            @Override
            public String getSessionId() {
                return "sess-path-boundary";
            }

            @Override
            public List<ChatMessage> getMessages() {
                return List.of();
            }

            @Override
            public List<ChatMessage> getLatestMessages(int windowSize) {
                return List.of();
            }

            @Override
            public void removeLatestMessage(int windowSize) {
            }

            @Override
            public void addMessage(Collection<? extends ChatMessage> messages) {
            }

            @Override
            public boolean isEmpty() {
                return true;
            }

            @Override
            public void clear() {
            }

            @Override
            public Map<String, Object> attrs() {
                return new LinkedHashMap<>();
            }
        };
    }

    /**
     * 带 {@code __cwd} 的 trace。
     *
     * <p>{@code __cwd} 必须走 toolContext 而不是 args：在 {@code onAction} 阶段 args 只含模型参数，
     * 框架私有键（{@code __} 前缀）是后续 {@code ToolRequest} 构造时才由 toolsContext 合并进去的。
     * 若实现从 args 取 cwd，生产环境会恒为 null → 路径轴静默失效，本桩就是为了钉住这一点。</p>
     */
    private static ReActTrace traceOf(FlowContext ctx, AgentSession session) {
        Map<String, Object> toolContext = new LinkedHashMap<>();
        toolContext.put(HarnessEngine.ATTR_CWD, workspace.toString());

        ReActOptions options = new ReActOptions(null) {
            @Override
            public Map<String, Object> getToolContext() {
                return toolContext;
            }
        };

        return new ReActTrace() {
            @Override
            public FlowContext getContext() {
                return ctx;
            }

            @Override
            public AgentSession getSession() {
                return session;
            }

            @Override
            public ReActOptions getOptions() {
                return options;
            }
        };
    }

    /** 驱动真实链路：HITLInterceptor（档位闸门）→ HitlStrategy（形态轴 + 路径轴）。 */
    private FlowContext run(AccessMode mode, String command) {
        FlowContext ctx = FlowContext.of();
        if (mode != null) {
            ctx.put(AccessMode.CTX_KEY, mode.code());
        }
        AgentSession session = sessionOf(ctx);

        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", command);

        HITLInterceptor interceptor = new HITLInterceptor().onTool("bash", new HitlStrategy());
        interceptor.onAction(traceOf(ctx, session), new ToolExchanger("bash", args, "call-pb-1"));

        Assertions.assertEquals(session.isPending(), ctx.getAs(HITL.LAST_INTERVENED) != null,
                "pending 标记与 LAST_INTERVENED 必须同时置位，否则前端渲染不出审批卡");
        return ctx;
    }

    private void assertSuspended(AccessMode mode, String command, String why) {
        HITLTask task = run(mode, command).getAs(HITL.LAST_INTERVENED);
        Assertions.assertNotNull(task, why + " —— 命令：" + command);
        // 只锁「审批文案说清了是越界写」这一接线职责；具体目标路径与触发形态的
        // 可读性由 BashPathGuardTest#reportsFirstViolationWithReadableDetail 负责，
        // 此处不重复断言以免与具体命令的目标形态耦合。
        Assertions.assertNotNull(task.getComment(), "审批文案不得为空，否则审批卡无从展示理由");
        Assertions.assertTrue(task.getComment().contains("工作区之外"),
                "审批文案必须说清这是越界写，而不是让用户猜：" + task.getComment());
        Assertions.assertEquals("bash", task.getToolName(), "挂起的必须是 bash 调用");
        Assertions.assertEquals("call-pb-1", task.getActionId(),
                "actionId 必须带上，否则并发同名工具时审批卡会串到错误的参数生成骨架卡上");
    }

    private void assertReleased(AccessMode mode, String command, String why) {
        Assertions.assertNull(run(mode, command).getAs(HITL.LAST_INTERVENED),
                why + " —— 命令：" + command);
    }

    private String out(String rel) {
        return outside.resolve(rel).toString();
    }

    // ==========================================================================
    // 1. 默认档：越界写必须挂起
    // ==========================================================================

    @Test
    void defaultModeSuspendsWritesOutsideWorkspace() {
        assertSuspended(AccessMode.DEFAULT, "Set-Content -Path " + out("x.txt") + " -Value hello",
                "PowerShell 写工作区外文件必须弹审批（这是用户报告的原始场景）");
        assertSuspended(AccessMode.DEFAULT, "echo hacked > " + out("x.txt"),
                "重定向写工作区外必须弹审批");
        assertSuspended(AccessMode.DEFAULT, "cp a.txt " + out("a.txt"),
                "复制到工作区外必须弹审批");
        assertSuspended(AccessMode.DEFAULT, "mkdir " + out("d"),
                "在工作区外建目录必须弹审批");
        assertSuspended(AccessMode.DEFAULT, "Set-Content ~/Documents/notes.txt x",
                "写家目录下的用户数据必须弹审批");
    }

    @Test
    void defaultModeSuspendsWrappedAndEncodedWrites() {
        assertSuspended(AccessMode.DEFAULT,
                "powershell -Command \"Set-Content " + out("y.txt").replace("\\", "/") + " x\"",
                "藏进 -Command 字符串的越界写必须弹审批");

        String inner = "Set-Content -Path " + out("enc.txt") + " -Value pwned";
        String b64 = Base64.getEncoder().encodeToString(inner.getBytes(java.nio.charset.StandardCharsets.UTF_16LE));
        assertSuspended(AccessMode.DEFAULT, "powershell -EncodedCommand " + b64,
                "Base64 编码的越界写必须弹审批（肉眼审不出内容，是最隐蔽的绕过形态）");

        assertSuspended(AccessMode.DEFAULT, "cd " + out("") + "; Set-Content f.txt x",
                "先 cd 出去再写相对路径必须弹审批");
    }

    /**
     * 递归删除越界目录会同时命中形态轴与路径轴。此处锁「至少挂起」而不锁具体文案：
     * 两条轴都成立是好事（任一条被绕过时另一条仍在），文案取哪条属实现细节。
     */
    @Test
    void defaultModeSuspendsRecursiveDeleteOutside() {
        FlowContext ctx = run(AccessMode.DEFAULT, "rm -rf " + out("tree"));
        Assertions.assertNotNull(ctx.getAs(HITL.LAST_INTERVENED),
                "递归删除工作区外目录必须弹审批");
    }

    // ==========================================================================
    // 2. 默认档：越界读要拦、界内读写与构建缓存必须放行
    // ==========================================================================

    /**
     * 越界<b>读</b>现在也弹审批（用户拍板口径，原为「读放行」）。
     *
     * <p>本组走的是<b>真实拦截链路</b>（HITLInterceptor.onAction → HitlStrategy → BashPathGuard），
     * 故验的不只是「判定为越界」，而是「越界读真的挂起了会话、审批文案区分了读/写」。
     * 写侧的挂起已由 {@code defaultModeSuspendsWritesOutsideWorkspace} 覆盖，这里只管读。</p>
     */
    @Test
    void defaultModeSuspendsReadsOutsideWorkspace() {
        assertSuspendedRead(AccessMode.DEFAULT, "Get-Content " + out("secret.txt"),
                "越界读必须弹审批（用户拍板：默认档读写工作区外均需批准）");
        assertSuspendedRead(AccessMode.DEFAULT, "cat /etc/os-release", "环境探测越界读也要拦");
        assertSuspendedRead(AccessMode.DEFAULT, "grep -r foo " + out(""), "检索工作区外要拦");
        assertSuspendedRead(AccessMode.DEFAULT, "ls " + out(""), "列工作区外目录要拦");
        assertSuspendedRead(AccessMode.DEFAULT,
                "[System.IO.File]::ReadAllText(\"" + out("z.txt").replace("\\", "/") + "\")",
                ".NET 静态读调用要拦");
    }

    /**
     * 断言越界读被挂起，且审批文案报为「读取」而非「写入」。
     *
     * <p>必须区分读写：把可撤销的读报成不可逆的写会让用户高估风险、无脑拒绝，
     * 反而错过真正该看的排查文件。故锁文案里出现「读取」。</p>
     */
    private void assertSuspendedRead(AccessMode mode, String command, String why) {
        HITLTask task = run(mode, command).getAs(HITL.LAST_INTERVENED);
        Assertions.assertNotNull(task, why + " —— 命令：" + command);
        Assertions.assertNotNull(task.getComment());
        Assertions.assertTrue(task.getComment().contains("读取工作区之外"),
                "越界读的审批文案必须明确报为「读取」，不得与写混淆：" + task.getComment());
    }


    /**
     * 读家目录下的启动文件 / 凭据面会被拦下（带 cwd 的真实链路）。
     *
     * <p><b>由哪条轴拦下不是本用例的契约</b>：启动文件的读只可能命中路径轴
     * （形态轴的后门面名单只管写形态），而凭据文件（{@code C:/Users/LUZW/.ssh/id_rsa}）会先被
     * 形态轴的 {@code CREDENTIAL_ACCESS} 名单命中。两者重叠正是设计意图
     * （任一条被绕过时另一条仍在），故对凭据面只断言「至少挂起」。</p>
     *
     * <p>这条契约必须落在有 cwd 的接线测试里，而不是 {@code HitlSensitiveFileWriteTest}：
     * 后者传 null trace，路径轴被刻意跳过，在那里 {@code cat ~/.bashrc} 返回 null。
     * 「读也拦」口径生效前，那份 null 被当成「读放行」的证据写进了注释，构成假绿。</p>
     *
     * <p>家目录不在内置豁免清单里（清单只含构建缓存与临时目录），故读它算越界读。
     * 这与 {@code HitlStrategy} 的凭据 / 启动文件名单形成重叠防御：
     * 名单管「写向后门面」形态，路径轴管「目标在工作区外」，任一条被绕过另一条仍在。</p>
     */
    @Test
    void homeStartupFileReadsAreBlockedByPathAxis() {
        // 启动文件：形态轴的「写向后门面」名单只管写形态，故读它只可能被路径轴拦下 ——
        // 这里锁文案报「读取」是安全的（不会与形态轴抢答）。
        assertSuspendedRead(AccessMode.DEFAULT, "cat ~/.bashrc",
                "读家目录启动文件属越界读，必须弹审批（旧口径曾声称放行）");
        assertSuspendedRead(AccessMode.DEFAULT, "Get-Content ~/.zshrc", "同上（PowerShell 形态）");

        // 凭据面：形态轴的 CREDENTIAL_ACCESS 名单先命中，文案是「检测到访问私钥或凭据文件」
        // 而非路径轴文案。两轴重叠是预期（任一条被绕过时另一条仍在），
        // 故此处只锁「至少挂起」，不锁由哪条轴拦 —— 与 defaultModeSuspendsRecursiveDeleteOutside 同口径。
        FlowContext credentialRead = run(AccessMode.DEFAULT, "cat ~/.ssh/id_rsa");
        HITLTask credentialTask = credentialRead.getAs(HITL.LAST_INTERVENED);
        Assertions.assertNotNull(credentialTask, "读 SSH 私钥必须弹审批（形态轴或路径轴任一命中即可）");
        Assertions.assertNotNull(credentialTask.getComment(), "审批文案不得为空");

        // 反向：界内同名文件必须放行，证明拦的是「越界」而不是「.bashrc 这个词」
        assertReleased(AccessMode.DEFAULT, "cat .bashrc", "界内同名文件不得误拦");
        assertReleased(AccessMode.DEFAULT, "cat docs/bashrc-notes.md", "界内文档不得误拦");
    }

    @Test
    void defaultModeReleasesWritesInsideWorkspace() {
        assertReleased(AccessMode.DEFAULT, "Set-Content -Path ./x.txt -Value hello", "工作区内写必须放行");
        assertReleased(AccessMode.DEFAULT, "Set-Content target/x.txt v", "写构建产物目录必须放行");
        assertReleased(AccessMode.DEFAULT, "Remove-Item target/x.txt", "删除单个构建产物必须放行");
        assertReleased(AccessMode.DEFAULT, "echo ok > build/out.txt", "界内重定向必须放行");
        assertReleased(AccessMode.DEFAULT, "git add -A ; git commit -m \"fix\"", "常规 git 必须放行");
        assertReleased(AccessMode.DEFAULT, "mvn install", "构建必须放行");
    }

    /**
     * 构建 / 包管理缓存必须豁免（只验路径轴，故用写而非递归删除）。
     */
    @Test
    void defaultModeReleasesBuildCachesOutsideWorkspace() {
        assertReleased(AccessMode.DEFAULT, "mkdir ~/.m2/repository/org/x", "Maven 缓存必须豁免");
        assertReleased(AccessMode.DEFAULT, "Set-Content ~/.m2/settings-probe.xml x", "Maven 缓存必须豁免");
        assertReleased(AccessMode.DEFAULT, "mkdir ~/.gradle/caches/tmp", "Gradle 缓存必须豁免");
        assertReleased(AccessMode.DEFAULT, "Remove-Item ~/.npm/_logs/x.txt", "npm 缓存必须豁免");
        assertReleased(AccessMode.DEFAULT,
                "echo x > " + System.getProperty("java.io.tmpdir").replace("\\", "/") + "/p.txt",
                "临时目录必须豁免");
    }

    /**
     * CMD 短选项不得被当成路径。
     *
     * <p>{@code Paths.get("/s")} 在 Windows 上不是绝对路径（缺盘符），会被解析成当前盘符根的
     * {@code \s}，于是无害命令会误报「越界写 D:\s」——这是误拦中最隐蔽的一类，
     * 因为命令本身完全无害。</p>
     *
     * <p>注意不能拿 {@code rd /s /q} 来验：它会被形态轴的 {@code (rd|rmdir)\s+/s} 先拦下，
     * 测不到路径轴。故用不命中形态轴的 {@code del /f}、{@code copy /y} 与 {@code xcopy /e}。</p>
     */
    @Test
    void defaultModeReleasesCmdShortOptions() {
        assertReleased(AccessMode.DEFAULT, "del /f /q build\\out\\x.tmp", "CMD 短选项不是路径");
        assertReleased(AccessMode.DEFAULT, "copy /y a.txt b.txt", "CMD 短选项不是路径");
        assertReleased(AccessMode.DEFAULT, "xcopy /e /i src build\\out", "CMD 短选项不是路径");
        assertReleased(AccessMode.DEFAULT, "robocopy src dst /E /NFL /NDL /NJH /NJS", "robocopy 短选项不是路径");
        assertReleased(AccessMode.DEFAULT, "findstr /s /i foo *.java", "findstr 短选项不是路径");
    }

    /**
     * 两条轴独立生效、取更严者——本契约必须锁住，否则会被误读成缺陷。
     *
     * <p>{@code rm -rf ~/.m2/repository} 里的目录在豁免清单内（路径轴不拦），
     * 但递归删除不可逆（形态轴拦）——<b>最终仍应弹审批</b>。
     * 豁免清单的语义是「不因为<b>越界</b>而弹审批」，不是「不因为<b>危险形态</b>而弹审批」。</p>
     *
     * <p>不锁住这一条，未来有人看到清缓存也弹审批，很可能误判为「豁免没生效」
     * 而去把形态轴的递归删除也按目录豁免——那会把真正不可逆的删除一并放行。</p>
     */
    @Test
    void shapeAxisAndPathAxisAreIndependent() {
        FlowContext exemptDirRecursiveDelete = run(AccessMode.DEFAULT, "rm -rf ~/.m2/repository/org/x");
        HITLTask task = exemptDirRecursiveDelete.getAs(HITL.LAST_INTERVENED);
        Assertions.assertNotNull(task,
                "豁免目录里的递归删除仍须弹审批：两条轴取更严者，豁免只免「越界」不免「不可逆」");
        Assertions.assertTrue(task.getComment().contains("递归"),
                "拦截理由应来自形态轴（递归删除）而非路径轴：" + task.getComment());

        // 对照组：同一目录上的非递归写确实不弹（证明路径轴对该目录是豁免的，不是两轴都拦）
        assertReleased(AccessMode.DEFAULT, "mkdir ~/.m2/repository/org/x", "非递归写应被豁免放行");

        // 对照组：界内的递归删除仍弹（证明形态轴与路径无关）
        FlowContext insideRecursive = run(AccessMode.DEFAULT, "rm -rf node_modules");
        Assertions.assertNotNull(insideRecursive.getAs(HITL.LAST_INTERVENED),
                "工作区内的递归删除仍须弹审批：形态轴不看路径");
    }

    // ==========================================================================
    // 3. 完全访问档：路径轴随之解除
    // ==========================================================================

    @Test
    void fullModeReleasesTheSameOutsideWrites() {
        String cmd = "Set-Content -Path " + out("x.txt") + " -Value hello";

        assertSuspended(AccessMode.DEFAULT, cmd, "先证明默认档确实会拦（否则本用例无意义）");
        assertReleased(AccessMode.FULL, cmd,
                "完全访问档下不得再弹审批：用户要的就是能碰工作区外的东西");
    }

    /**
     * 脏值 / 缺省档位必须 fail-safe 到「拦」。
     *
     * <p>这条与 {@code AccessMode.normalize} 的既有契约一致：解析不出档位时退回最严的一档。
     * 若路径轴在这里放行，前端拼错字段就会静默失去空间边界。</p>
     */
    @Test
    void dirtyOrMissingModeFailsSafeToSuspend() {
        String cmd = "Set-Content -Path " + out("x.txt") + " -Value hello";
        assertSuspended(null, cmd, "缺省档位必须按默认档处理（拦）");

        FlowContext ctx = FlowContext.of();
        ctx.put(AccessMode.CTX_KEY, "bypassPermissions");
        AgentSession session = sessionOf(ctx);
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", cmd);
        new HITLInterceptor().onTool("bash", new HitlStrategy())
                .onAction(traceOf(ctx, session), new ToolExchanger("bash", args, "call-pb-2"));
        Assertions.assertNotNull(ctx.getAs(HITL.LAST_INTERVENED), "脏档位值必须回落默认档（拦）");
    }

    // ==========================================================================
    // 4. 模型不得自行抬高边界
    // ==========================================================================

    /**
     * 模型在 args 里塞 {@code __cwd} 不得改变判定基准。
     *
     * <p>{@code ToolRequest.stripPrivateArgs} 会剔除模型传来的 {@code __} 前缀键，
     * 但拦截器跑在 {@code onAction} 阶段——此时 args 还没经过那层过滤。
     * 因此本层必须自己只信 toolContext，否则模型可以把 cwd 伪造成 {@code D:\}
     * 从而让一切写入都「界内」。</p>
     */
    @Test
    void modelSuppliedCwdCannotWidenBoundary() {
        FlowContext ctx = FlowContext.of();
        ctx.put(AccessMode.CTX_KEY, AccessMode.DEFAULT.code());
        AgentSession session = sessionOf(ctx);

        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", "Set-Content -Path " + out("x.txt") + " -Value hello");
        // 模型试图把边界伪造成盘符根
        args.put(HarnessEngine.ATTR_CWD, workspace.getRoot().toString());
        args.put(HarnessEngine.ATTR_ACCESS_MODE, AccessMode.FULL.code());

        new HITLInterceptor().onTool("bash", new HitlStrategy())
                .onAction(traceOf(ctx, session), new ToolExchanger("bash", args, "call-pb-3"));

        Assertions.assertNotNull(ctx.getAs(HITL.LAST_INTERVENED),
                "模型在 args 里伪造 __cwd / __accessMode 不得抬升边界，判定基准只能来自框架注入的 toolContext");
    }

    /**
     * toolContext 里没有 cwd 时跳过路径判定（不凭空造边界），但形态轴仍须生效。
     *
     * <p>猜一个基准（比如进程 {@code user.dir}）会把用户无关目录判成越界，制造无法解释的审批卡。
     * 生产路径上 cwd 恒存在（{@code AgentFactory} 用 {@code engine.getWorkspace()} 做了默认注入），
     * 取不到只可能出现在直调场景。此时不得退化成「形态轴也一起失效」。</p>
     */
    @Test
    void missingCwdSkipsPathAxisButKeepsShapeAxis() {
        FlowContext ctx = FlowContext.of();
        ctx.put(AccessMode.CTX_KEY, AccessMode.DEFAULT.code());
        AgentSession session = sessionOf(ctx);

        Map<String, Object> noCwd = new LinkedHashMap<>();
        noCwd.put("command", "Set-Content -Path " + out("x.txt") + " -Value hello");
        ReActTrace traceWithoutCwd = new ReActTrace() {
            @Override
            public FlowContext getContext() {
                return ctx;
            }

            @Override
            public AgentSession getSession() {
                return session;
            }

            @Override
            public ReActOptions getOptions() {
                return new ReActOptions(null) {
                    @Override
                    public Map<String, Object> getToolContext() {
                        return new LinkedHashMap<>();
                    }
                };
            }
        };

        HITLInterceptor interceptor = new HITLInterceptor().onTool("bash", new HitlStrategy());

        interceptor.onAction(traceWithoutCwd, new ToolExchanger("bash", noCwd, "call-pb-4"));
        Assertions.assertNull(ctx.getAs(HITL.LAST_INTERVENED),
                "无 cwd 时不得凭空造边界（否则会报出用户看不懂的越界审批）");

        // 同一 trace 形态下，形态轴（递归删除）仍须生效
        FlowContext ctx2 = FlowContext.of();
        ctx2.put(AccessMode.CTX_KEY, AccessMode.DEFAULT.code());
        AgentSession session2 = sessionOf(ctx2);
        Map<String, Object> shape = new LinkedHashMap<>();
        shape.put("command", "rm -rf node_modules");
        ReActTrace trace2 = new ReActTrace() {
            @Override
            public FlowContext getContext() {
                return ctx2;
            }

            @Override
            public AgentSession getSession() {
                return session2;
            }

            @Override
            public ReActOptions getOptions() {
                return new ReActOptions(null) {
                    @Override
                    public Map<String, Object> getToolContext() {
                        return new LinkedHashMap<>();
                    }
                };
            }
        };
        interceptor.onAction(trace2, new ToolExchanger("bash", shape, "call-pb-5"));
        Assertions.assertNotNull(ctx2.getAs(HITL.LAST_INTERVENED),
                "无 cwd 只解除路径轴，形态轴（递归删除需审批）必须照常生效");
    }
}
