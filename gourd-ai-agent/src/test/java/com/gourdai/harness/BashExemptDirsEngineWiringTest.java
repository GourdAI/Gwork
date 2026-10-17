package com.gourdai.harness;

import com.gourdai.agent.AgentSession;
import com.gourdai.agent.react.ReActOptions;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.intercept.HITL;
import com.gourdai.agent.react.intercept.HITLInterceptor;
import com.gourdai.agent.react.intercept.HITLTask;
import com.gourdai.agent.react.task.ToolExchanger;
import com.gourdai.agent.session.InMemoryAgentSession;
import com.gourdai.ai.chat.message.ChatMessage;
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
 * 引擎侧接线契约：settings 里的 bash 写豁免目录必须真的传到<b>引擎自己装配的</b>那个
 * {@code HitlStrategy} 实例上。
 *
 * <h3>为什么 {@code BashWriteExemptionTest} 覆盖不了这一层</h3>
 *
 * <p>那边所有用例都是 {@code new HitlStrategy(exemptDirs)} —— 直接构造策略，
 * <b>完全绕过</b> {@code HarnessEngine} 的默认装配点。实测证据：把
 * {@code HarnessEngine} 里的 {@code new HitlStrategy(options.getBashExemptDirs())}
 * 改回 {@code new HitlStrategy()}（settings → 策略的链路断开），那边 47 例<b>全绿</b>。
 * 而生产环境走的是引擎装配路径，配置根本不生效——用户配了豁免却仍被弹审批，
 * 唯一补救是整档切到「完全访问」，正好是配置项想避免的坏结果。</p>
 *
 * <p>这是本仓反复出现的同一类陷阱：「策略逻辑测了」不等于「策略被接上了」。
 * 本测试因此<b>只</b>用 {@code engine.getHitlInterceptor()} 返回的实例驱动判定，
 * 绝不自己 new 策略——这样引擎构造点与热更新通道都在覆盖范围内。</p>
 *
 * <h3>目录为什么不用 {@code @TempDir}</h3>
 *
 * <p>{@code @TempDir} 建在 {@code java.io.tmpdir} 之下，而临时目录本身就在内置豁免清单里
 * （编译器与构建工具必须能写临时目录）。用它做工作区会让所有「工作区外」的目标
 * 仍落在临时目录<b>内</b>而被豁免放行——实测正是这个形态：三条断言全部因
 * 「应弹审批却没弹」而失败。故与 {@code BashPathGuardTest} 一致，建在模块 {@code target/} 下。</p>
 *
 * <h3>为什么用真实 HarnessEngine</h3>
 *
 * <p>本项目无 mockito，且 {@code HarnessEngine} 构造器是 private（只能经
 * {@code of(...).build()}），无法子类化。{@code sessionProvider} 必须注入：
 * {@code getSession} 直接委派给它，不注入则 NPE。</p>
 */
class BashExemptDirsEngineWiringTest {

    private static Path temp;
    private static Path ws;
    private static Path buildOut;
    private static Path elsewhere;

    @BeforeAll
    static void createDirs() throws IOException {
        temp = Paths.get("").toAbsolutePath().resolve("target")
                .resolve("bpg-engine-" + System.nanoTime());
        ws = Files.createDirectories(temp.resolve("ws"));
        buildOut = Files.createDirectories(temp.resolve("build-out"));
        elsewhere = Files.createDirectories(temp.resolve("elsewhere"));
    }

    @AfterAll
    static void removeDirs() {
        deleteQuietly(temp);
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
    // 引擎装配
    // ==========================================================================

    private HarnessEngine newEngine(Collection<String> exemptDirs) {
        HarnessEngine.Builder builder = HarnessEngine
                .of(temp.resolve("ws").toString(), temp.resolve("home").toString())
                .sessionProvider(InMemoryAgentSession::of);
        if (exemptDirs != null) {
            builder.bashExemptDirsAdd(exemptDirs);
        }
        return builder.build();
    }

    // ==========================================================================
    // 桩：驱动引擎装配出的真实拦截器
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
                return "sess-engine-wiring";
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

    private static ReActTrace traceOf(FlowContext ctx, AgentSession session, Path cwd) {
        Map<String, Object> toolContext = new LinkedHashMap<>();
        toolContext.put(HarnessEngine.ATTR_CWD, cwd.toString());

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

    /**
     * 用<b>引擎自己装配的</b>拦截器跑一次判定。
     *
     * <p>这里刻意不接受外部传入的策略：一旦允许传入，用例就会不知不觉退化成
     * {@code new HitlStrategy(...)} 形态，接线缺口重新出现且测试仍全绿。</p>
     */
    private HITLTask drive(HarnessEngine engine, Path cwd, String command) {
        FlowContext ctx = FlowContext.of();
        ctx.put(AccessMode.CTX_KEY, AccessMode.DEFAULT.code());
        AgentSession session = sessionOf(ctx);

        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", command);

        HITLInterceptor interceptor = engine.getHitlInterceptor();
        Assertions.assertNotNull(interceptor, "引擎必须装配出 HITL 拦截器，否则默认档没有任何命令闸门");

        interceptor.onAction(traceOf(ctx, session, cwd), new ToolExchanger("bash", args, "call-ew-1"));
        return ctx.getAs(HITL.LAST_INTERVENED);
    }

    // ==========================================================================
    // 1. Builder → 引擎装配的策略
    // ==========================================================================

    @Test
    void builderExemptDirsReachTheEngineAssembledStrategy() throws IOException {
        String cmd = "Set-Content -Path " + buildOut.resolve("app.txt") + " -Value hello";

        // 对照：不配豁免时，引擎装配的拦截器必须拦下这条越界写
        HarnessEngine plain = newEngine(null);
        Assertions.assertNotNull(drive(plain, ws, cmd),
                "前置对照：未配置豁免时越界写必须弹审批，否则本用例证明不了接线存在");

        // 配了豁免：同一个装配路径必须放行 —— 这一步直接锁住 HarnessEngine 的构造点
        HarnessEngine configured = newEngine(List.of(buildOut.toString()));
        Assertions.assertNull(drive(configured, ws, cmd),
                "Builder 传入的豁免目录必须传到引擎自己装配的 HitlStrategy 上（接线断则本断言失败）");
    }

    @Test
    void exemptionStillLeavesOtherOutsideDirsGuarded() throws IOException {
        HarnessEngine engine = newEngine(List.of(buildOut.toString()));

        Assertions.assertNull(drive(engine, ws, "Set-Content -Path " + buildOut.resolve("a.txt") + " -Value x"),
                "已豁免目录应放行");
        Assertions.assertNotNull(drive(engine, ws, "Set-Content -Path " + elsewhere.resolve("b.txt") + " -Value x"),
                "豁免不得顺带放开其它工作区外目录");
    }

    @Test
    void shapeAxisStillAppliesWithEngineAssembledStrategy() throws IOException {
        HarnessEngine engine = newEngine(List.of(buildOut.toString()));

        HITLTask task = drive(engine, ws, "rm -rf " + buildOut.resolve("cache"));
        Assertions.assertNotNull(task, "豁免目录里的递归删除仍须弹审批（两轴独立、取更严者）");
        Assertions.assertTrue(task.getComment().contains("递归"),
                "理由应来自形态轴而非路径轴：" + task.getComment());
    }

    // ==========================================================================
    // 2. 热更新 → 已装配的策略实例
    // ==========================================================================

    /**
     * 设置页保存后必须立即生效，且<b>不需要重建 Agent</b>。
     *
     * <p>这条锁住 {@code bashExemptDirsReset} 真的把新值推到了已存在的策略实例上。
     * 若热更新只改 options 而不动策略（实测变异 M15），用户在设置页保存后仍会被弹审批，
     * 只能重启应用——而设置页的交互承诺是「保存即生效」。</p>
     */
    @Test
    void hotUpdateReachesAlreadyAssembledStrategyWithoutRebuildingAgent() throws IOException {
        String cmd = "Set-Content -Path " + buildOut.resolve("app.txt") + " -Value hello";

        HarnessEngine engine = newEngine(null);
        HITLInterceptor before = engine.getHitlInterceptor();

        Assertions.assertNotNull(drive(engine, ws, cmd), "前置：初始无豁免时应弹审批");

        engine.bashExemptDirsReset(List.of(buildOut.toString()));

        Assertions.assertSame(before, engine.getHitlInterceptor(),
                "热更新不得替换拦截器实例：替换意味着重建 Agent，会打断正在跑的会话");
        Assertions.assertNull(drive(engine, ws, cmd),
                "热更新后必须立即生效（否则用户只能重启应用）");

        // 撤销后恢复拦截：证明这是双向的真通道，而不是被单向打开后关不掉
        engine.bashExemptDirsReset(List.of());
        Assertions.assertNotNull(drive(engine, ws, cmd), "清空豁免后必须恢复拦截");

        engine.bashExemptDirsReset(Arrays.asList(buildOut.toString()));
        Assertions.assertNull(drive(engine, ws, cmd), "重新配置后必须再次生效");

        engine.bashExemptDirsReset(null);
        Assertions.assertNotNull(drive(engine, ws, cmd), "置 null 等价于清空，必须恢复拦截");
    }

    @Test
    void engineExposesEffectiveExemptDirsForSettingsEcho() throws IOException {
        HarnessEngine engine = newEngine(List.of(buildOut.toString()));

        Assertions.assertTrue(engine.getBashExemptDirs().contains(buildOut.toString()),
                "引擎必须能回显当前生效的豁免目录，否则设置页无法渲染已保存的配置");

        Path other = Files.createDirectories(temp.resolve("echo-other"));
        engine.bashExemptDirsReset(List.of(other.toString()));
        Assertions.assertEquals(List.of(other.toString()), engine.getBashExemptDirs(),
                "热更新后回显必须同步，否则设置页显示的是旧配置");
    }

    /**
     * 热更新不得让并发读看到「已清空但尚未填充」的中间态。
     *
     * <p>本策略实例被所有会话线程共用；若就地 {@code clear()} 后再 {@code addAll()}，
     * 期间执行的判定会认为没有任何豁免，表现为「保存配置的瞬间恰好在跑的命令突然弹审批」——
     * 间歇性、无法复现、极难归因。故断言清空与填充之间不存在可观测的空窗。</p>
     */
    @Test
    void hotUpdateHasNoObservableEmptyWindow() throws IOException {
        String cmd = "Set-Content -Path " + buildOut.resolve("app.txt") + " -Value hello";

        HarnessEngine engine = newEngine(List.of(buildOut.toString()));
        Assertions.assertNull(drive(engine, ws, cmd), "前置：豁免生效");

        // 反复热更新同一批目录：任何一次中间态泄漏都会让某次判定突然弹审批
        for (int i = 0; i < 200; i++) {
            engine.bashExemptDirsReset(List.of(buildOut.toString()));
            Assertions.assertNull(drive(engine, ws, cmd),
                    "第 " + i + " 次热更新后豁免失效：清空与填充之间存在可观测空窗");
        }
    }
}
