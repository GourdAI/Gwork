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
import java.util.Arrays;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 用户可配置的 bash 写豁免目录：从 settings 字面量到「真的不再弹审批」的全链路契约。
 *
 * <p>为什么必须有这一层测试：豁免配置的失效形态是<b>静默</b>的——展开口径漂移、
 * 集合被就地清空、热更新没传到策略实例，任何一种都表现为「配了但没生效」，
 * 而用户唯一的补救手段是整档切到完全访问（解除<b>全部</b>空间边界）。
 * 这正是配置项想避免的坏结果，所以「配置生效」本身必须被测试锁住。</p>
 *
 * <p>同时锁住反向：豁免<b>只</b>解除路径轴，形态轴（递归删除等）照旧生效。
 * 这条一旦被读反，后人会去给形态轴也加目录豁免，从而把真正不可逆的删除一并放行。</p>
 */
class BashWriteExemptionTest {

    private static Path holder;
    private static Path workspace;
    private static Path buildOut;
    private static Path otherOutside;

    @BeforeAll
    static void createDirs() throws IOException {
        // 不用 @TempDir：java.io.tmpdir 本身在内置豁免清单里，
        // 建在临时目录下会让「工作区外」的目标仍落在豁免区内，测试恒绿而护栏无效。
        holder = Paths.get("").toAbsolutePath().resolve("target")
                .resolve("bpg-exempt-" + System.nanoTime());
        workspace = holder.resolve("ws");
        buildOut = holder.resolve("build-out");
        otherOutside = holder.resolve("elsewhere");
        Files.createDirectories(workspace);
        Files.createDirectories(buildOut);
        Files.createDirectories(otherOutside);
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
    // 桩（与 BashPathBoundaryWiringTest 同构：驱动真实 HITLInterceptor + 真实 HitlStrategy）
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
                return "sess-exempt";
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

    /** 用给定豁免配置构造策略并驱动一次 bash 审批判定，返回挂起任务（null = 放行）。 */
    private HITLTask run(List<String> exemptDirs, String command) {
        FlowContext ctx = FlowContext.of();
        ctx.put(AccessMode.CTX_KEY, AccessMode.DEFAULT.code());
        AgentSession session = sessionOf(ctx);

        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", command);

        HitlStrategy strategy = new HitlStrategy(exemptDirs);
        new HITLInterceptor().onTool("bash", strategy)
                .onAction(traceOf(ctx, session), new ToolExchanger("bash", args, "call-ex-1"));

        return ctx.getAs(HITL.LAST_INTERVENED);
    }

    private String write(String rel) {
        return "Set-Content -Path " + rel + " -Value hello";
    }

    // ==========================================================================
    // 1. 豁免生效
    // ==========================================================================

    @Test
    void configuredDirectoryStopsApproval() {
        String cmd = write(buildOut.resolve("app.txt").toString());

        Assertions.assertNotNull(run(null, cmd),
                "前置：未配置豁免时该越界写必须弹审批（否则本用例证明不了任何事）");
        Assertions.assertNull(run(List.of(buildOut.toString()), cmd),
                "已配置的豁免目录内的写入不得再弹审批：用户配了就该生效");
    }

    @Test
    void exemptionCoversSubdirectoriesAndBothDialects() {
        List<String> exempt = List.of(buildOut.toString());

        Assertions.assertNull(run(exempt, write(buildOut.resolve("deep/nested/app.txt").toString())),
                "豁免必须覆盖子目录（用户配的是目录，不是单个文件）");
        Assertions.assertNull(run(exempt, "mkdir " + buildOut.resolve("d")), "Unix 风格动词同样受豁免");
        Assertions.assertNull(run(exempt, "cp a.txt " + buildOut.resolve("a.txt")), "cp 目标同样受豁免");
        Assertions.assertNull(run(exempt, "echo x > " + buildOut.resolve("r.txt")), "重定向同样受豁免");
        Assertions.assertNull(run(exempt,
                        "[System.IO.File]::WriteAllText(\"" + buildOut.resolve("n.txt").toString().replace("\\", "/") + "\", \"v\")"),
                ".NET 静态方法直调同样受豁免");
    }

    @Test
    void exemptionDoesNotLeakToOtherDirectories() {
        List<String> exempt = List.of(buildOut.toString());

        Assertions.assertNotNull(run(exempt, write(otherOutside.resolve("x.txt").toString())),
                "豁免必须精确到配置的目录，不得顺带放开其它工作区外位置");
        Assertions.assertNotNull(run(exempt, write(workspace.getParent().resolve("stray.txt").toString())),
                "豁免不得放开 holder 根目录（buildOut 的父目录）");
    }

    // ==========================================================================
    // 2. 字面量展开
    // ==========================================================================

    @Test
    void tildeInExemptionIsExpanded() {
        // ~ 展开必须与 BashPathGuard 内部的展开口径一致：两处各写一份必然漂移，
        // 而漂移的表现正是「配了 ~ 但没生效」
        String home = System.getProperty("user.home");
        Assertions.assertNotNull(home, "测试环境需要 user.home");

        Path target = Paths.get(home, "bpg-exempt-probe.txt");
        String cmd = "Set-Content -Path " + target + " -Value x";

        Assertions.assertNotNull(run(null, cmd),
                "前置：未配置豁免时写家目录必须弹审批（家目录不在内置缓存豁免清单内）");
        Assertions.assertNull(run(List.of("~/"), cmd), "豁免条目里的 ~ 必须被展开后生效");
    }

    @Test
    void environmentVariableInExemptionIsExpanded() {
        String varName = System.getenv("USERPROFILE") != null ? "USERPROFILE"
                : (System.getenv("HOME") != null ? "HOME" : null);
        Assertions.assertNotNull(varName, "测试环境需至少有 USERPROFILE 或 HOME");

        Path target = Paths.get(System.getenv(varName), "bpg-exempt-probe2.txt");
        String cmd = "Set-Content -Path " + target + " -Value x";

        Assertions.assertNotNull(run(null, cmd), "前置：未配置豁免时必须弹审批");

        String powershellForm = "$env:" + varName;
        Assertions.assertNull(run(List.of(powershellForm), cmd),
                "豁免条目里的 " + powershellForm + " 必须被展开后生效");

        String cmdForm = "%" + varName + "%";
        Assertions.assertNull(run(List.of(cmdForm), cmd),
                "豁免条目里的 " + cmdForm + " 必须被展开后生效");
    }

    @Test
    void unresolvableExemptionEntriesAreIgnoredNotFatal() {
        // 环境变量在本机不存在时展开不出确定路径：必须忽略该条目而不是让整个护栏失效
        List<String> exempt = Arrays.asList(
                "%DEFINITELY_UNSET_VAR_BPG%",
                "$env:DEFINITELY_UNSET_VAR_BPG",
                "",
                "   ",
                null);

        Assertions.assertNotNull(run(exempt, write(otherOutside.resolve("x.txt").toString())),
                "全部豁免条目都不可解析时，越界写必须照常弹审批（不得退化成放行一切）");

        // 有效条目与无效条目混排时，有效的那条仍须生效
        List<String> mixed = Arrays.asList("%DEFINITELY_UNSET_VAR_BPG%", buildOut.toString(), "");
        Assertions.assertNull(run(mixed, write(buildOut.resolve("app.txt").toString())),
                "混排时有效豁免仍须生效，不得因存在无效条目而整批作废");
    }

    // ==========================================================================
    // 3. 只解除路径轴，形态轴照旧
    // ==========================================================================

    /**
     * 豁免的语义是「不因为<b>越界</b>而弹审批」，不是「不因为<b>危险</b>而弹审批」。
     *
     * <p>这条最容易被读反：看到「配了豁免但清缓存还弹审批」，很可能误判为豁免没生效，
     * 进而去给形态轴也加目录豁免——那会把真正不可逆的递归删除一并放行。
     * 故此处同时断言正反两面。</p>
     */
    @Test
    void exemptionOnlyLiftsPathAxisNotShapeAxis() {
        List<String> exempt = List.of(buildOut.toString());

        HITLTask recursiveDelete = run(exempt, "rm -rf " + buildOut.resolve("cache"));
        Assertions.assertNotNull(recursiveDelete,
                "豁免目录里的递归删除仍须弹审批：两轴独立、取更严者");
        Assertions.assertTrue(recursiveDelete.getComment().contains("递归"),
                "拦截理由应来自形态轴而非路径轴，否则说明两轴被混为一谈：" + recursiveDelete.getComment());

        Assertions.assertNull(run(exempt, "Remove-Item " + buildOut.resolve("one.txt")),
                "对照组：同目录下的非递归删除应被放行（证明路径轴确实已解除）");

        Assertions.assertNotNull(run(exempt, "sudo tee " + buildOut.resolve("hosts")),
                "豁免目录里的提权操作仍须弹审批");
    }

    // ==========================================================================
    // 4. 热更新与防御性拷贝
    // ==========================================================================

    @Test
    void hotUpdateReachesTheAlreadyConstructedStrategy() {
        HitlStrategy strategy = new HitlStrategy();
        String cmd = write(buildOut.resolve("app.txt").toString());

        HITLInterceptor interceptor = new HITLInterceptor().onTool("bash", strategy);
        Assertions.assertNotNull(drive(interceptor, cmd), "前置：初始无豁免时应弹审批");

        // 模拟设置页保存：热更新必须让已构造的策略实例看到新配置，而不是只改 settings
        strategy.setBashExemptDirs(List.of(buildOut.toString()));
        Assertions.assertNull(drive(interceptor, cmd),
                "热更新后同一个策略实例必须立即生效（否则用户只能重启应用）");

        // 撤销配置后必须恢复拦截
        strategy.setBashExemptDirs(List.of());
        Assertions.assertNotNull(drive(interceptor, cmd), "清空豁免后必须恢复拦截");
        strategy.setBashExemptDirs(null);
        Assertions.assertNotNull(drive(interceptor, cmd), "置 null 等价于清空，必须恢复拦截");
    }

    private HITLTask drive(HITLInterceptor interceptor, String command) {
        FlowContext ctx = FlowContext.of();
        ctx.put(AccessMode.CTX_KEY, AccessMode.DEFAULT.code());
        AgentSession session = sessionOf(ctx);

        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", command);
        interceptor.onAction(traceOf(ctx, session), new ToolExchanger("bash", args, "call-ex-2"));
        return ctx.getAs(HITL.LAST_INTERVENED);
    }

    /**
     * 策略必须持有入参的<b>拷贝</b>而不是引用。
     *
     * <p>settings 里的 List 是可变对象，保存流程会 clear 再 addAll。若策略直接持有引用，
     * 并发读会撞上「已清空但尚未填充」的中间态——表现为保存配置的瞬间恰好在跑的命令
     * 突然弹审批（间歇性、无法复现、极难归因）。</p>
     */
    @Test
    void strategyCopiesInputListSoLaterMutationCannotBreakIt() {
        List<String> source = new java.util.ArrayList<>();
        source.add(buildOut.toString());

        HitlStrategy strategy = new HitlStrategy(source);
        String cmd = write(buildOut.resolve("app.txt").toString());
        Assertions.assertNull(driveWith(strategy, cmd), "前置：配置生效");

        // 模拟保存流程就地改动源集合
        source.clear();
        source.add(otherOutside.toString());

        Assertions.assertNull(driveWith(strategy, cmd),
                "策略持有源 List 引用时，源被 clear 会让豁免瞬间失效（并发下表现为间歇性误弹审批）");

        // 去重与去空白：设置页可能提交重复或带空格的条目
        HitlStrategy normalized = new HitlStrategy(Arrays.asList(
                "  " + buildOut.toString() + "  ", buildOut.toString(), "", null));
        Assertions.assertEquals(1, normalized.getBashExemptDirs().size(),
                "重复与空白条目应被归一，否则设置页回显会出现重复行");
        Assertions.assertEquals(buildOut.toString(), normalized.getBashExemptDirs().get(0),
                "条目应被 trim 后保存");
    }

    private HITLTask driveWith(HitlStrategy strategy, String command) {
        return drive(new HITLInterceptor().onTool("bash", strategy), command);
    }

    // ==========================================================================
    // 5. resolveExemptDirs 的公开口径
    // ==========================================================================

    @Test
    void resolveExemptDirsIsTolerantAndNeverReturnsNull() {
        Assertions.assertNotNull(BashPathGuard.resolveExemptDirs(null), "入参 null 必须返回空列表而非 null");
        Assertions.assertTrue(BashPathGuard.resolveExemptDirs(null).isEmpty());
        Assertions.assertTrue(BashPathGuard.resolveExemptDirs(List.of()).isEmpty());
        Assertions.assertTrue(BashPathGuard.resolveExemptDirs(Arrays.asList("", "   ", null)).isEmpty(),
                "空白与 null 条目必须被过滤，不得产生指向工作目录的空路径豁免");

        List<Path> resolved = BashPathGuard.resolveExemptDirs(List.of(buildOut.toString()));
        Assertions.assertEquals(1, resolved.size());
        Assertions.assertTrue(resolved.get(0).isAbsolute(), "豁免根必须是绝对路径，否则无法与目标比对");
    }
}
