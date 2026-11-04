/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.harness.agent;

import com.gourdai.agent.session.InMemoryAgentSession;
import com.gourdai.core.portal.web.WebChunk;
import com.gourdai.harness.HarnessEngine;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A+：background 子代理的前端可视化推送 + 用户 Stop 必须能停掉后台任务的契约测试。
 *
 * <p><b>本轮解决的问题</b>：{@code background=true} 的子代理走 detached 同步分支，
 * 而 {@code AgentStartEvent}/{@code AgentEndEvent} 只在流式分支经父 sink 下发
 * （父 sink 在 {@code agent.call()} 返回时就已 complete，往里 next 是静默 no-op）。
 * 于是后台子代理在前端<b>完全隐形</b>——连卡片都不出现，用户无从得知有任务在跑。
 * 同时 detached 分支跑的是独立同步流，没有流式分支那条 {@code takeUntil(sink.isCancelled())}
 * 的取消链，{@code WebGate.interruptSession} 只 dispose 主会话 disposable，触及不到它，
 * 结果是用户点 Stop 后主对话停了、后台任务仍把模型调完（白烧 token，且用户以为已经停了）。</p>
 *
 * <p><b>为何大量用源码扫描</b>：项目无 mockito，而本用例要守的多是「接线有没有接上」这类
 * 结构约束（listener 有没有注册、interruptSession 有没有接取消、有没有打 background 标记）。
 * 凡能走真行为的部分（listener 回调载荷、截断口径、取消语义与幂等）一律真调，不用源码扫描冒充。</p>
 *
 * <p><b>源码扫描的两条纪律</b>（都是本轮实测踩到的坑，见 {@link #stripJavaComments} 与
 * {@link #extractJavaMethod} 的方法注释）：① 必须先剥注释再断言；② 定位方法必须按
 * 「行首修饰符」判定定义行，不能简单找 {@code " name("}——那会先命中调用点。</p>
 *
 * @author oisin
 */
public class TaskTalentBackgroundVisibilityTest {

    private static final String TASK_SOURCE_PATH =
            "gourd-ai-agent/src/main/java/com/gourdai/harness/agent/TaskTalent.java";

    private static final String GATE_SOURCE_PATH =
            "gourd-ai-agent/src/main/java/com/gourdai/core/portal/web/WebGate.java";

    @TempDir
    Path temp;

    // ══════════════════════════════════════════════════════════════
    //  1. 帧契约：WebChunk 工厂的 background 标记与进度帧形态
    // ══════════════════════════════════════════════════════════════

    /**
     * 后台帧必须带 {@code args.background=true}，前台帧必须不带。
     *
     * <p>这是前端「要不要收敛主代理的思考块/正文指针」的唯一判据。漏打标记 → 前端把后台帧
     * 当前台帧处理 → 主代理正在输出的思考块被反复切断、正文被撕裂成两段；错打标记 →
     * 前台子代理收卡后不再重建正文指针，后续主代理正文跑进智能体容器。</p>
     */
    @Test
    public void backgroundFlagMustDistinguishPushedFromStreamedFrames() {
        WebChunk bgStart = WebChunk.ofAgentStart("explore", "查用法", "inv-1", true);
        Assertions.assertEquals("agent_start", bgStart.getType());
        Assertions.assertEquals(Boolean.TRUE, bgStart.getArgs().get("background"),
                "后台 agent_start 必须打标，否则前端会收敛主代理正在输出的思考块");
        Assertions.assertEquals("inv-1", bgStart.getArgs().get("invocationId"),
                "invocationId 必须透传，否则前端 resolveAgentState 定位不到卡片、内容漏进主对话");
        Assertions.assertEquals("explore", bgStart.getArgs().get("agentName"));
        Assertions.assertEquals("查用法", bgStart.getArgs().get("description"));

        WebChunk fgStart = WebChunk.ofAgentStart("explore", "查用法", "inv-2");
        Assertions.assertNull(fgStart.getArgs().get("background"),
                "前台帧刻意不带 background 键（而非 false）：旧历史帧没有该字段，两者必须同义");

        WebChunk bgEnd = WebChunk.ofAgentEnd("explore", "查用法", true, "结论", "inv-3", true);
        Assertions.assertEquals("agent_end", bgEnd.getType());
        Assertions.assertEquals(Boolean.TRUE, bgEnd.getArgs().get("background"));
        Assertions.assertEquals(Boolean.TRUE, bgEnd.getArgs().get("success"));
        Assertions.assertEquals("结论", bgEnd.getArgs().get("resultSummary"));
        Assertions.assertEquals("inv-3", bgEnd.getArgs().get("invocationId"));

        Assertions.assertNull(WebChunk.ofAgentEnd("a", "d", true, "r", "inv-4").getArgs().get("background"),
                "前台 agent_end 同样不得打标");
    }

    /**
     * 进度心跳帧：type 必须是 {@code agent_progress}，且刻意<b>不设 phase</b>。
     *
     * <p>不设 phase 的理由：后台帧可能落在本轮 done 之后、下一轮开始之前的空闲窗口，
     * 带 phase 会改写主会话的 {@code sess.phase}，污染主对话指示器文案。
     * 前端的 {@code inferPhaseFromType} 对未知 type 返回 null 同样不改相位，两层都不改才安全。</p>
     */
    @Test
    public void progressFrameMustCarryToolNameAndNoPhase() {
        WebChunk p = WebChunk.ofAgentProgress("explore", "查用法", "inv-9", "grep");
        Assertions.assertEquals("agent_progress", p.getType());
        Assertions.assertNull(p.getPhase(), "进度帧不得携带 phase，否则会改写主会话相位状态机");
        Assertions.assertEquals("grep", p.getArgs().get("toolName"), "工具名是心跳的唯一载荷");
        Assertions.assertEquals("inv-9", p.getArgs().get("invocationId"));
        Assertions.assertEquals(Boolean.TRUE, p.getArgs().get("background"),
                "进度帧只可能来自后台子代理，恒为 true");
        Assertions.assertEquals("查用法", p.getArgs().get("description"),
                "description 必须与 agent_start 同值，否则前端按 name:desc 回退配对时归属失配");
    }

    /**
     * 进度帧必须是瞬态帧（不落盘），而卡片帧必须落盘。
     *
     * <p>一次后台任务可能调用上百次工具，落盘会让历史文件按工具调用次数线性膨胀，
     * 而回放时这些中间态毫无价值（终态由 agent_end 完整承载）。反过来 agent_start/end
     * 若被误列进瞬态名单，刷新后回放里就看不到这张卡了。</p>
     */
    @Test
    public void progressFrameMustBeEphemeralButCardFramesMustPersist() throws Exception {
        Class<?> store = Class.forName("com.gourdai.core.portal.web.SessionStreamStore");
        Method m = store.getDeclaredMethod("isEphemeralType", String.class);
        m.setAccessible(true);

        Assertions.assertTrue((Boolean) m.invoke(null, "agent_progress"),
                "agent_progress 必须在瞬态帧白名单，否则历史文件按工具调用次数膨胀");
        for (String t : Arrays.asList("action_draft", "action_args", "action_batch")) {
            Assertions.assertTrue((Boolean) m.invoke(null, t), t + " 必须仍是瞬态帧（既有契约不得回归）");
        }
        for (String t : Arrays.asList("agent_start", "agent_end", "text", "reason", "action_start")) {
            Assertions.assertFalse((Boolean) m.invoke(null, t),
                    t + " 必须落盘，否则刷新后回放里看不到后台子代理");
        }
    }

    /**
     * 卡片摘要必须与 {@link AgentEndEvent#getResultSummary()} 逐字同口径（200 字符 + 省略号）。
     *
     * <p>detached 分支绕过了事件类、直接调 listener，若不在此处补一刀，子代理的完整结果
     * （动辄数万字符）会被 {@code emitToClient} 永久写进 stream.ndjson，此后每次回放都重读一遍。</p>
     */
    @Test
    public void cardSummaryMustBeTruncatedLikeAgentEndEvent() throws Exception {
        Method m = TaskTalent.class.getDeclaredMethod("truncateCardSummary", String.class);
        m.setAccessible(true);

        Assertions.assertEquals("", m.invoke(null, (Object) null), "null 必须归一为空串");
        Assertions.assertEquals("短结果", m.invoke(null, "短结果"), "未超限必须原样返回");

        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 5000; i++) {
            sb.append('x');
        }
        String truncated = (String) m.invoke(null, sb.toString());
        Assertions.assertEquals(203, truncated.length(), "必须截到 200 + 省略号");
        Assertions.assertTrue(truncated.endsWith("..."));

        String eventSummary = new AgentEndEvent("a", "d", true, sb.toString(), "s").getResultSummary();
        Assertions.assertEquals(eventSummary, truncated,
                "两条分支（流式经事件类 / detached 经 listener）的卡片摘要必须逐字一致，"
                        + "否则同一任务在实时与回放里显示不同长度的摘要");
    }

    // ══════════════════════════════════════════════════════════════
    //  2. 推送 seam：listener 回调行为 + 如实降级
    // ══════════════════════════════════════════════════════════════

    /**
     * 三个 emit 方法必须真的回调 listener，且载荷与任务一致。
     *
     * <p>用真行为而非源码扫描：listener 未接线是整个功能静默失效的唯一形态
     * （编译通过、其他测试全绿、生产上卡片永不出现），源码字符串断言抓不到它。</p>
     */
    @Test
    public void emitMethodsMustDeliverPayloadToListener() throws Exception {
        TaskTalent talent = newTaskTalent();
        RecordingListener rec = new RecordingListener();
        talent.setBackgroundAgentListener(rec);

        Assertions.assertTrue(talent.backgroundAgentVisible(), "注册后必须报告可见");

        TaskTalent.MultiTaskOp op = op(3, "扫描全部用法");
        invokeEmit(talent, "emitBackgroundStart", op, "inv-A");
        invokeEmit(talent, "emitBackgroundProgress", op, "inv-A", "grep");
        invokeEmit(talent, "emitBackgroundEnd", op, "inv-A", true, "最终结论");

        Assertions.assertEquals(1, rec.starts.size(), "start 必须恰好投递一次，重复会让前端建出两张卡");
        Assertions.assertEquals("sess-test", rec.starts.get(0)[0], "sessionId 决定前端路由到哪个会话面板");
        Assertions.assertEquals(AGENT_NAME, rec.starts.get(0)[1],
                "agentName 必须是提交时的原值：它进卡片标题，也是无 invocationId 时前端回退配对的键之一");
        Assertions.assertEquals("扫描全部用法", rec.starts.get(0)[2]);
        Assertions.assertEquals("inv-A", rec.starts.get(0)[3], "start 的 invocationId 决定卡片归属键");

        Assertions.assertEquals(1, rec.progress.size());
        Assertions.assertEquals("grep", rec.progress.get(0)[4], "进度帧必须带上当前工具名");
        Assertions.assertEquals("inv-A", rec.progress.get(0)[3],
                "进度帧必须复用同一 invocationId 才能定位到卡片，否则心跳写不进任何卡");

        Assertions.assertEquals(1, rec.ends.size());
        Assertions.assertEquals(Boolean.TRUE, rec.ends.get(0)[3], "成败位必须透传，否则失败卡显示成成功");
        Assertions.assertEquals("最终结论", rec.ends.get(0)[4]);
        Assertions.assertEquals("inv-A", rec.ends.get(0)[5], "end 必须与 start 同 invocationId 才能配对收卡");
    }

    /**
     * end 帧的超长结果必须在投递给 listener 前就截断。
     *
     * <p>守的是「截断发生在 emit 内」而不是「指望 WebGate 或前端去截」：listener 的实现方
     * 直接把 resultSummary 交给 {@code emitToClient} 落盘，中间没有任何二次截断的机会。</p>
     */
    @Test
    public void endFrameMustTruncateBeforeDelivery() throws Exception {
        TaskTalent talent = newTaskTalent();
        RecordingListener rec = new RecordingListener();
        talent.setBackgroundAgentListener(rec);

        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 8000; i++) {
            sb.append('y');
        }
        invokeEmit(talent, "emitBackgroundEnd", op(1, "长结果任务"), "inv-L", true, sb.toString());

        Assertions.assertEquals(1, rec.ends.size());
        String delivered = (String) rec.ends.get(0)[4];
        Assertions.assertEquals(203, delivered.length(),
                "投递给 listener 的摘要必须已截断，否则完整结果会被永久写进 stream.ndjson");
        Assertions.assertTrue(delivered.endsWith("..."));
    }

    /**
     * listener 抛异常不得让子代理任务失败。
     *
     * <p>推送纯属展示增强。若异常外逸，一次「前端没连上 / 序列化失败」会被 taskDo 的兜底 catch
     * 误报成「任务执行失败」回灌给模型，模型据此重派一个本来跑得好好的任务。</p>
     */
    @Test
    public void listenerFailureMustNotBreakTask() throws Exception {
        TaskTalent talent = newTaskTalent();
        talent.setBackgroundAgentListener(new TaskTalent.BackgroundAgentListener() {
            @Override
            public void onStart(String sessionId, String agentName, String description, String invocationId) {
                throw new IllegalStateException("BOOM: WebSocket 已断开");
            }

            @Override
            public void onProgress(String sessionId, String agentName, String description,
                                   String invocationId, String toolName) {
                throw new IllegalStateException("BOOM");
            }

            @Override
            public void onEnd(String sessionId, String agentName, String description,
                              boolean success, String resultSummary, String invocationId) {
                throw new IllegalStateException("BOOM");
            }
        });

        TaskTalent.MultiTaskOp op = op(1, "任务");
        // 三者都不得抛：任何一个外逸都会让后台子代理任务本身失败
        Assertions.assertDoesNotThrow(() -> invokeEmit(talent, "emitBackgroundStart", op, "inv-B"),
                "start 推送失败必须降级为 WARN");
        Assertions.assertDoesNotThrow(() -> invokeEmit(talent, "emitBackgroundProgress", op, "inv-B", "read"),
                "progress 推送失败必须降级为 WARN");
        Assertions.assertDoesNotThrow(() -> invokeEmit(talent, "emitBackgroundEnd", op, "inv-B", true, "r"),
                "end 推送失败必须降级为 WARN，否则卡片永远停在 loading 且任务被误报失败");
    }

    /**
     * listener 未注册时必须静默 no-op，且如实报告「不可见」。
     *
     * <p>CLI/ACP 通道与单测里没有 WebGate，listener 恒为 null。此时提交回执若仍宣称
     * 「界面上会显示卡片」，就是给用户一个永远不兑现的承诺。</p>
     */
    @Test
    public void missingListenerMustDegradeHonestly() throws Exception {
        TaskTalent talent = newTaskTalent();
        Assertions.assertFalse(talent.backgroundAgentVisible(), "未注册 listener 时必须报告不可见");

        TaskTalent.MultiTaskOp op = op(1, "任务");
        Assertions.assertDoesNotThrow(() -> invokeEmit(talent, "emitBackgroundStart", op, "inv-C"),
                "未注册 listener 时 emit 必须静默 no-op");
        Assertions.assertDoesNotThrow(() -> invokeEmit(talent, "emitBackgroundProgress", op, "inv-C", "ls"));
        Assertions.assertDoesNotThrow(() -> invokeEmit(talent, "emitBackgroundEnd", op, "inv-C", false, "e"));

        // 文案必须按可见性分叉：不可见时说「不会推送到前端」，可见时说「会显示卡片」
        Method hint = TaskTalent.class.getDeclaredMethod("backgroundProgressHint");
        hint.setAccessible(true);
        String invisible = (String) hint.invoke(talent);
        Assertions.assertTrue(invisible.contains("不会推送到前端"),
                "通道未接通时必须如实降级，不得承诺卡片: " + invisible);

        talent.setBackgroundAgentListener(new RecordingListener());
        String visible = (String) hint.invoke(talent);
        Assertions.assertTrue(visible.contains("智能体卡片"), "通道接通时必须告知用户能看到卡片: " + visible);
        Assertions.assertFalse(visible.contains("不会推送到前端"), visible);
    }

    /**
     * detached 分支必须真的发帧：源码结构约束。
     *
     * <p>这条守的是「接线在不在 detached 分支里」——本轮 bug 的原始形态恰恰是
     * detached 走同步分支而该分支零 sink.next，编译与既有测试全绿，功能却完全不存在。</p>
     */
    @Test
    public void detachedBranchMustEmitFrames() throws Exception {
        String src = stripJavaComments(readSource(TASK_SOURCE_PATH));
        String taskDo = extractJavaMethod(src, "taskDo");

        Assertions.assertTrue(taskDo.contains("if (detached) {"),
                "detached 必须是独立分支：与「无可用父 sink 的同步回退」合并会让回退路径也发帧，"
                        + "而那条路径没有旁路通道可走");
        Assertions.assertTrue(taskDo.contains("emitBackgroundStart(__sessionId, task, invocationId)"),
                "detached 分支必须发 agent_start，否则卡片根本不出现: " + brief(taskDo));
        /* 成功路径的收卡帧：成败位必须是 isHealthyRunEnd 判定出的 resultOk（模型故障时
           RunEnd 携道歉文案 abnormal=true，写死 true 会把失败伪装成成功——work-munh72qj
           实测三个子代理全部失败但信封全 success=true）。见 TaskTalentHealthyRunEndTest。 */
        Assertions.assertTrue(taskDo.contains("emitBackgroundEnd(__sessionId, task, invocationId, resultOk, result)"),
                "成功路径必须发 agent_end 收卡（成败位取 resultOk，不得写死 true），否则状态点永远闪");
        // 取消文案分叉落地后 catch 的收卡参数改为 endMessage 变量（取消→中性文案 / 真异常→ERROR），
        // 故锁变量形态 + 变量必须被赋值；「异常路径必须收卡」的意图不变。
        Assertions.assertTrue(taskDo.contains("emitBackgroundEnd(__sessionId, task, invocationId, false, endMessage)"),
                "异常路径必须补发 agent_end：卡片已建（start 无条件先发），不收卡就永久 loading");
        Assertions.assertTrue(taskDo.replaceAll("\\s+", " ").contains("String endMessage = cancelFlag.get()"),
                "收卡文案变量必须按取消位分叉赋值：无条件 ERROR 会让被取消的任务被模型原样重派");

        // 进度心跳必须挂在工具边界，且只认 ToolCallStartEvent
        Assertions.assertTrue(taskDo.contains("if (ev instanceof ToolCallStartEvent)"),
                "心跳必须只在工具边界发：转发 delta 会让帧量与历史体积失控");
        Assertions.assertTrue(taskDo.contains("emitBackgroundProgress(__sessionId, task, invocationId,"),
                "detached 分支必须发进度心跳");
        Assertions.assertFalse(taskDo.contains("emitBackgroundProgress(__sessionId, task, invocationId, ev)"),
                "心跳不得把整个事件对象当工具名传下去");

        // 前台流式分支不得被本次改动波及（它有自己的 sink.next 通道）
        Assertions.assertTrue(taskDo.contains("sink.next(new AgentStartEvent("),
                "前台流式分支的 agent_start 通道必须保持原样");
        Assertions.assertTrue(taskDo.contains("sink.next(new AgentEndEvent("),
                "前台流式分支的 agent_end 通道必须保持原样");

        // metrics 归属：后台任务跨轮次完成，累加回父 trace 会把上一轮 token 记到下一轮账上
        Assertions.assertFalse(taskDo.contains("if (__parentTrace != null && detached == false)"),
                "旧的 detached==false 判据应已随独立分支消失");
    }

    /**
     * 接线必须在 WebGate 构造器里完成，且走 {@code emitToClient} 而非 {@code broadcastRaw}。
     *
     * <p>{@code broadcastRaw} 不落盘，用它发帧会造成「实时能看到、刷新就消失」；
     * {@code emitToClient} 一次调用同时获得广播 + 落盘 + eventSeq，回放零成本自动生效。</p>
     */
    @Test
    public void webGateMustWireListenerThroughEmitToClient() throws Exception {
        String src = stripJavaComments(readSource(GATE_SOURCE_PATH));
        String ctor = extractJavaMethod(src, "WebGate");

        Assertions.assertTrue(ctor.contains("setBackgroundAgentListener("),
                "构造器必须反向注册 listener：WebGate 未进 Solon bean 容器，TaskTalent 拿不到它的引用");
        Assertions.assertTrue(ctor.contains("WebChunk.ofAgentStart(agentName, description, invocationId, true)"),
                "注册时必须打 background 标记: " + brief(ctor));
        Assertions.assertTrue(ctor.contains("WebChunk.ofAgentEnd(agentName, description, success, resultSummary, invocationId, true)"),
                "结束帧同样必须打 background 标记");
        Assertions.assertTrue(ctor.contains("WebChunk.ofAgentProgress("), "必须接进度心跳");

        // 三种帧都必须走 emitToClient（落盘）
        Assertions.assertEquals(3, countOccurrences(ctor, "emitToClient(sessionId, WebChunk.ofAgent"),
                "三种帧都必须经 emitToClient，否则刷新后回放里看不到");
        Assertions.assertFalse(ctor.contains("broadcastRaw("),
                "不得用 broadcastRaw：它不落盘，会造成「实时能看到、刷新就消失」");
    }

    // ══════════════════════════════════════════════════════════════
    //  3. 用户 Stop 必须能停掉后台子代理
    // ══════════════════════════════════════════════════════════════

    /**
     * 取消必须按会话隔离，且可重复调用（幂等）。
     *
     * <p>TaskTalent 是 HarnessEngine 级单实例而 engine 按工作区长期存活，不分会话会让
     * 用户在 A 会话点 Stop 却把 B 会话的后台任务一起停掉。</p>
     */
    @Test
    public void cancelMustBeSessionScopedAndIdempotent() throws Exception {
        TaskTalent talent = newTaskTalent();

        Assertions.assertEquals(0, talent.cancelBackgroundTasks("no-such-session"), "无任务时必须返回 0");
        Assertions.assertEquals(0, talent.cancelBackgroundTasks(null), "null 会话必须安全返回 0");
        Assertions.assertEquals(0, talent.cancelBackgroundTasks(""), "空会话必须安全返回 0");
        Assertions.assertDoesNotThrow(() -> talent.discardBackgroundTasks(null), "discard(null) 必须安全");

        AtomicBoolean flagA = new AtomicBoolean(false);
        AtomicBoolean flagB = new AtomicBoolean(false);
        AtomicBoolean flagOther = new AtomicBoolean(false);
        register(talent, "sess-A", "inv-1", flagA);
        register(talent, "sess-A", "inv-2", flagB);
        register(talent, "sess-B", "inv-3", flagOther);

        Assertions.assertEquals(2, talent.cancelBackgroundTasks("sess-A"), "必须置位该会话的全部后台任务");
        Assertions.assertTrue(flagA.get(), "inv-1 必须被取消");
        Assertions.assertTrue(flagB.get(), "inv-2 必须被取消");
        Assertions.assertFalse(flagOther.get(), "其他会话的任务绝不能被误停");

        Assertions.assertEquals(0, talent.cancelBackgroundTasks("sess-A"),
                "重复取消必须返回 0：已置位的不得重复计数（返回值用于日志，虚高会误导排障）");

        /* 注销后不再被取消。必须用全新的 flag 与 invocationId：
           上一版复用已被 cancel 置 true 的 flagB，compareAndSet(false,true) 自然返回 false，
           于是「注销一条后还剩一条可取消」的期望恒为 0——断言写错而非实现有错。 */
        AtomicBoolean flagC = new AtomicBoolean(false);
        AtomicBoolean flagD = new AtomicBoolean(false);
        register(talent, "sess-D", "inv-4", flagC);
        register(talent, "sess-D", "inv-5", flagD);
        unregister(talent, "sess-D", "inv-4");
        Assertions.assertEquals(1, talent.cancelBackgroundTasks("sess-D"), "注销一条后只剩一条可取消");
        Assertions.assertFalse(flagC.get(), "已注销的任务不得再被置位（注销即摘除登记）");
        Assertions.assertTrue(flagD.get(), "未注销的任务必须被置位");
        Assertions.assertEquals(0, talent.cancelBackgroundTasks("sess-D"), "全部取消后必须返回 0");

        // 会话删除时整桶摘掉，否则 backgroundCancelFlags 随历史会话无限增长
        register(talent, "sess-C", "inv-9", new AtomicBoolean(false));
        talent.discardBackgroundTasks("sess-C");
        Assertions.assertEquals(0, talent.cancelBackgroundTasks("sess-C"), "discard 后该会话桶必须已摘除");

        // 空桶必须自行摘除，否则每个跑完后台任务的会话都留一个空 Map
        register(talent, "sess-E", "inv-10", new AtomicBoolean(false));
        unregister(talent, "sess-E", "inv-10");
        Assertions.assertEquals(0, talent.cancelBackgroundTasks("sess-E"), "最后一条注销后桶应已空");
    }

    /**
     * 取消必须走协作式 {@code takeUntil}，而非 {@code future.cancel(true)} 中断线程。
     *
     * <p>子代理可能正在执行 write/edit 等落盘操作，外部中断会留下写一半的文件状态——
     * 比白烧完这一轮更糟（口径同 {@code registerBackgroundTask} 关于 TTL 不 interrupt 的说明）。</p>
     */
    @Test
    public void cancelMustBeCooperativeNotThreadInterrupt() throws Exception {
        String src = stripJavaComments(readSource(TASK_SOURCE_PATH));
        String taskDo = extractJavaMethod(src, "taskDo");

        Assertions.assertTrue(taskDo.contains(".takeUntil(ev -> cancelFlag.get())"),
                "detached 分支必须挂协作式取消：不挂则用户点 Stop 后后台任务仍把模型调完");
        Assertions.assertFalse(taskDo.contains("future.cancel(true)"),
                "不得用 cancel(true) 中断线程，会留下写一半的文件");
        Assertions.assertTrue(taskDo.contains("registerCancellable(__sessionId, invocationId, cancelFlag)"),
                "取消位必须在流启动前登记，否则 Stop 落在登记之前就会漏掉这个任务");

        // 取消后必须报中性文案而非 ERROR：带 ERROR 前缀会让模型把它当可重试失败并反复重派。
        // 墙钟止损落地后取消文案分叉为 cancelMessage 变量（用户终止=CANCELLED_MESSAGE /
        // 墙钟=WALL_CLOCK_MESSAGE，两者都以 CANCELLED 开头），故断言收卡/回包用变量名，
        // 并另断言分叉表达式本身——锁死「两种取消都不得退化成 ERROR」这一意图。
        Assertions.assertTrue(taskDo.contains("if (cancelFlag.get())"),
                "必须区分「被取消」与「流未产出 RunEndEvent」两种 blockLast()==null 的成因");
        Assertions.assertTrue(taskDo.contains("emitBackgroundEnd(__sessionId, task, invocationId, false, cancelMessage)"),
                "取消时也必须收卡，否则卡片永久 loading");
        Assertions.assertTrue(taskDo.contains("return formatTaskResp(task, false, cancelMessage, isMultitask)"),
                "取消回包必须走中性文案变量，不得报 ERROR");
        Assertions.assertTrue(taskDo.replaceAll("\\s+", " ").contains(
                        "wallClockFired.get() ? WALL_CLOCK_MESSAGE : CANCELLED_MESSAGE"),
                "取消文案分叉必须存在：用户终止与墙钟止损的文案都不得带 ERROR 前缀");

        Assertions.assertTrue(taskDo.contains("unregisterCancellable(__sessionId, invocationId);"),
                "必须在 finally 里注销取消登记，否则异常路径泄漏取消位");
        /* 必须用正则而非子串计数："registerCancellable(" 是 "unregisterCancellable(" 的子串，
           纯字符串 indexOf 会把两者算成同一个，实测得到 2 而非 1（本轮踩到的陷阱）。 */
        int reg = countRegex(taskDo, "(?<!un)registerCancellable\\(");
        int unreg = countRegex(taskDo, "unregisterCancellable\\(");
        Assertions.assertEquals(1, reg, "登记必须恰好一次");
        Assertions.assertEquals(1, unreg, "注销必须恰好一次且在 finally 里");
        Assertions.assertTrue(taskDo.lastIndexOf("finally {") < taskDo.lastIndexOf("unregisterCancellable("),
                "注销调用必须落在 finally 块内");
    }

    /**
     * interruptSession 的三条返回路径都必须接上后台取消。
     *
     * <p>漏任何一条都会留下「用户点了 Stop 但后台还在烧 token」的窗口：
     * 主路径（有 run state）、disposable 兜底路径（run state 已摘但订阅还活着）、
     * 以及 state==null 且无 disposable 的路径（主 run 已结束但后台任务仍在跑，
     * 这正是 background 模式的常态）。</p>
     */
    @Test
    public void interruptSessionMustCancelBackgroundOnAllPaths() throws Exception {
        String src = stripJavaComments(readSource(GATE_SOURCE_PATH));
        String body = extractJavaMethod(src, "interruptSession");

        Assertions.assertEquals(3, countOccurrences(body, "cancelBackgroundTasksQuietly(sessionId)"),
                "三条返回路径都必须接后台取消（主路径 / disposable 兜底 / 仅后台任务在跑）: " + brief(body));

        Assertions.assertTrue(body.contains("if (cancelBackgroundTasksQuietly(sessionId) > 0)"),
                "state==null 且无 disposable 时必须先查后台任务：否则用户点 Stop 得到 not_running，"
                        + "而后台任务仍在烧 token");

        String quiet = extractJavaMethod(src, "cancelBackgroundTasksQuietly");
        Assertions.assertTrue(quiet.contains("catch (Throwable e)"),
                "取消失败必须只记日志：外逸会让 interruptSession 回 not_running，"
                        + "主 run 的 dispose 与补发 done 一并丢失，前端永久停在思考态");
        Assertions.assertTrue(quiet.contains("return 0;"), "失败必须降级为 0");
        Assertions.assertTrue(quiet.contains("engine.getTaskTalent().cancelBackgroundTasks(sessionId)"),
                "必须真的委派到 TaskTalent，不能只是个空壳");

        // cleanupSession 只摘登记、不取消任务
        String cleanup = extractJavaMethod(src, "cleanupSession");
        Assertions.assertTrue(cleanup.contains("discardBackgroundTasks(sessionId)"),
                "会话删除时必须摘掉取消登记桶，否则随历史会话无限增长");
        Assertions.assertFalse(cleanup.contains("cancelBackgroundTasks("),
                "会话删除不等于用户要停止任务：置取消位会让在途的 write/edit 停在半路留下损坏文件");
    }

    // ══════════════════════════════════════════════════════════════
    //  4. 文案不得再是谎言
    // ══════════════════════════════════════════════════════════════

    /**
     * getInstruction 与两个 static final REMINDER 常量不得再无条件宣称「进度不推送到前端」。
     *
     * <p>本轮之前这四处文案都是硬编码的谎言，模型会据此劝用户别用 background。
     * 它们都是静态文本、无法运行时分叉，故必须彻底移除该断言；提交回执则改为走
     * {@code backgroundProgressHint()} 按 listener 是否接通如实分叉。</p>
     */
    @Test
    public void noHardcodedLieAboutInvisibleProgress() throws Exception {
        String src = stripJavaComments(readSource(TASK_SOURCE_PATH));

        String instruction = extractJavaMethod(src, "getInstruction");
        Assertions.assertFalse(instruction.contains("不推送到前端"),
                "getInstruction 是静态文本，不得写死「不推送」（listener 接通时这就是谎言）: "
                        + brief(instruction));
        Assertions.assertTrue(instruction.contains("background=true"), "仍须说明后台模式的用法");

        for (String field : Arrays.asList("BACKGROUND_SUBMITTED_REMINDER =",
                "BACKGROUND_SUBMITTED_REMINDER_WITH_NOTICE =")) {
            int i = src.indexOf(field);
            Assertions.assertTrue(i >= 0, "应能找到常量声明: " + field);
            String decl = src.substring(i, src.indexOf(';', i));
            Assertions.assertFalse(decl.contains("不推送"),
                    field + " 是 static final 无法运行时分叉，不得写死「不推送」: " + decl);
        }

        Assertions.assertTrue(extractJavaMethod(src, "task").contains("backgroundProgressHint()"),
                "task 的提交回执必须走运行时判断");
        Assertions.assertTrue(extractJavaMethod(src, "formatBackgroundSubmission").contains("backgroundProgressHint()"),
                "multitask 的提交回执必须走运行时判断");

        // 端到端：未接 listener 时回执如实降级，且 token 通道照常可用
        TaskTalent talent = newTaskTalent();
        String resp = talent.multitask(
                Arrays.asList(op(1, "后台任务一", true)), temp.toString(), "vis-session", null, null, null);
        Assertions.assertTrue(resp.contains("不会推送到前端"),
                "未接 listener 时回执必须如实说明看不到卡片: " + resp);
        Assertions.assertTrue(resp.contains("<token>"), "token 通道照常可用: " + resp);
        Assertions.assertTrue(resp.contains("不要在提交后立刻 await"), "仍须劝阻提交后立刻 await: " + resp);
    }

    // ══════════════════════════════════════════════════════════════
    //  辅助
    // ══════════════════════════════════════════════════════════════

    /** 记录全部回调载荷的 listener：只覆盖本用例关心的断言面。 */
    private static final class RecordingListener implements TaskTalent.BackgroundAgentListener {
        final List<Object[]> starts = new ArrayList<>();
        final List<Object[]> progress = new ArrayList<>();
        final List<Object[]> ends = new ArrayList<>();

        @Override
        public void onStart(String sessionId, String agentName, String description, String invocationId) {
            starts.add(new Object[]{sessionId, agentName, description, invocationId});
        }

        @Override
        public void onProgress(String sessionId, String agentName, String description,
                               String invocationId, String toolName) {
            progress.add(new Object[]{sessionId, agentName, description, invocationId, toolName});
        }

        @Override
        public void onEnd(String sessionId, String agentName, String description,
                          boolean success, String resultSummary, String invocationId) {
            ends.add(new Object[]{sessionId, agentName, description, success, resultSummary, invocationId});
        }
    }

    private HarnessEngine newEngine() {
        // sessionProvider 必须注入：HarnessEngine.getSession 直接委派给它，不注入则 multitask 一进门就 NPE。
        // InMemoryAgentSession 的 context 里没有 trace → ReActTrace.getCurrent 返回 null，正好不需要真调模型。
        return HarnessEngine.of(temp.toString(), temp.resolve("home").toString())
                .sessionProvider(InMemoryAgentSession::of)
                .build();
    }

    private TaskTalent newTaskTalent() {
        return new TaskTalent(newEngine());
    }

    /** 故意用一个不存在的代理名：真调 multitask 时 taskDo 会快速降级为 unknownAgentMessage，不真调模型。 */
    private static final String AGENT_NAME = "__no_such_agent_for_visibility_test__";

    private static TaskTalent.MultiTaskOp op(int index, String description, boolean background) {
        TaskTalent.MultiTaskOp op = new TaskTalent.MultiTaskOp();
        op.index = index;
        op.agent_name = AGENT_NAME;
        op.description = description;
        op.prompt = "测试提示词：" + description;
        op.background = background;
        return op;
    }

    /** 2 参重载：默认 background=true（本用例只关心后台路径）。 */
    private static TaskTalent.MultiTaskOp op(int index, String description) {
        return op(index, description, true);
    }

    /** 反射调私有 emit 方法：按实参类型逐个映射形参，boolean 必须还原成原生类型否则找不到方法。 */
    private static void invokeEmit(TaskTalent talent, String method, TaskTalent.MultiTaskOp op, Object... rest) {
        try {
            Class<?>[] types = new Class<?>[rest.length + 2];
            types[0] = String.class;                 // sessionId
            types[1] = TaskTalent.MultiTaskOp.class; // task
            Object[] args = new Object[rest.length + 2];
            args[0] = "sess-test";
            args[1] = op;
            for (int i = 0; i < rest.length; i++) {
                types[i + 2] = (rest[i] instanceof Boolean) ? boolean.class : rest[i].getClass();
                args[i + 2] = rest[i];
            }
            Method m = TaskTalent.class.getDeclaredMethod(method, types);
            m.setAccessible(true);
            m.invoke(talent, args);
        } catch (ReflectiveOperationException e) {
            throw new AssertionError("反射调用 " + method + " 失败: " + e, e);
        }
    }

    private static void register(TaskTalent talent, String sessionId, String invocationId, AtomicBoolean flag) {
        try {
            Method m = TaskTalent.class.getDeclaredMethod("registerCancellable",
                    String.class, String.class, AtomicBoolean.class);
            m.setAccessible(true);
            m.invoke(talent, sessionId, invocationId, flag);
        } catch (ReflectiveOperationException e) {
            throw new AssertionError("反射 registerCancellable 失败: " + e, e);
        }
    }

    private static void unregister(TaskTalent talent, String sessionId, String invocationId) {
        try {
            Method m = TaskTalent.class.getDeclaredMethod("unregisterCancellable", String.class, String.class);
            m.setAccessible(true);
            m.invoke(talent, sessionId, invocationId);
        } catch (ReflectiveOperationException e) {
            throw new AssertionError("反射 unregisterCancellable 失败: " + e, e);
        }
    }

    /**
     * 提取 Java 方法体：先定位「定义行」，再从其后第一个 {@code '{'} 起按花括号配平截取。
     *
     * <p><b>为何不能简单找 {@code " name("}</b>：那会先命中<b>调用点</b>。实测 {@code taskDo}
     * 的首个出现处是 {@code runForegroundTasks} 里的 {@code () -> taskDo(...), RunUtil.io())}，
     * 据此提取到的 788 字符片段里根本没有 detached 分支，所有断言因「提取错了对象」而集体误报
     * （本轮实际踩过：5 个失败里 2 个源于此）。调用点行以表达式开头、定义行以修饰符开头，
     * 故按行首修饰符判定。</p>
     *
     * <p>支持多行签名（形参换行，如 taskDo）：定义行未必以 {@code '{'} 结尾，故从其后再找。</p>
     */
    private static String extractJavaMethod(String src, String name) {
        Matcher m = Pattern.compile("(?m)^[ \\t]*(?:public|private|protected)[^\\n]*\\b"
                + Pattern.quote(name) + "\\s*\\(").matcher(src);
        Assertions.assertTrue(m.find(), "未找到方法定义: " + name);

        int brace = src.indexOf('{', m.end());
        Assertions.assertTrue(brace >= 0, "方法定义后未找到 '{': " + name);

        int depth = 0;
        for (int i = brace; i < src.length(); i++) {
            char ch = src.charAt(i);
            if (ch == '{') {
                depth++;
            } else if (ch == '}') {
                depth--;
                if (depth == 0) {
                    return src.substring(m.start(), i + 1);
                }
            }
        }
        throw new AssertionError("方法体未配平: " + name);
    }

    /**
     * 去掉 Java 注释后返回正文，供所有源码断言使用。
     *
     * <p><b>为何必须去注释</b>：不去的话断言两头都会错——</p>
     * <ol>
     *   <li><b>反向断言误报</b>：WebGate 构造器里我自己写的注释「这里用 emitToClient 而非
     *       broadcastRaw」就含 broadcastRaw 字样，让 {@code assertFalse(contains("broadcastRaw"))}
     *       在实现完全正确时变红（本轮实际踩过）。</li>
     *   <li><b>正向断言假绿</b>：若某段调用只存在于注释里（例如实现被删只剩一句说明），
     *       {@code assertTrue(contains(...))} 仍会绿——测的是空气。</li>
     * </ol>
     *
     * <p>状态机同时处理文本块（{@code """}）、字符串、字符字面量与两种注释：
     * 不识别字面量会把字符串里的 {@code "//"} 当行注释，从此处起把整个文件正文吃掉。</p>
     */
    private static String stripJavaComments(String src) {
        StringBuilder out = new StringBuilder(src.length());
        int i = 0;
        int n = src.length();
        while (i < n) {
            char c = src.charAt(i);
            if (c == '"' && src.startsWith("\"\"\"", i)) {
                // 文本块：整体原样保留（其中的 // 与 /* 不是注释）
                int end = src.indexOf("\"\"\"", i + 3);
                end = (end < 0) ? n : end + 3;
                out.append(src, i, end);
                i = end;
            } else if (c == '"' || c == '\'') {
                char quote = c;
                out.append(c);
                i++;
                while (i < n) {
                    char d = src.charAt(i);
                    out.append(d);
                    if (d == '\\' && i + 1 < n) {
                        out.append(src.charAt(i + 1));
                        i += 2;
                        continue;
                    }
                    i++;
                    if (d == quote) {
                        break;
                    }
                }
            } else if (c == '/' && i + 1 < n && src.charAt(i + 1) == '/') {
                // 行注释：吃到行尾但保留 '\n'，使后续 (?m)^ 行首锚点仍然有效
                while (i < n && src.charAt(i) != '\n') {
                    i++;
                }
            } else if (c == '/' && i + 1 < n && src.charAt(i + 1) == '*') {
                int end = src.indexOf("*/", i + 2);
                i = (end < 0) ? n : end + 2;
                out.append(' ');   // 用空格替代，防止把注释两侧的标识符粘成一个新标识符
            } else {
                out.append(c);
                i++;
            }
        }
        return out.toString();
    }

    private static int countOccurrences(String haystack, String needle) {
        int n = 0;
        int from = 0;
        while (true) {
            int i = haystack.indexOf(needle, from);
            if (i < 0) {
                return n;
            }
            n++;
            from = i + needle.length();
        }
    }

    /**
     * 正则计数。
     *
     * <p>存在理由：纯字符串 {@code indexOf} 无法表达「前面不能是 un」，而本文件确实需要
     * 区分 {@code registerCancellable} 与 {@code unregisterCancellable}。</p>
     */
    private static int countRegex(String haystack, String regex) {
        Matcher m = Pattern.compile(regex).matcher(haystack);
        int n = 0;
        while (m.find()) {
            n++;
        }
        return n;
    }

    private static String readSource(String relativePath) throws Exception {
        // surefire 的工作目录可能是仓库根也可能是模块目录，两种口径都要能解析
        Path p = Paths.get(relativePath);
        if (!Files.exists(p)) {
            p = Paths.get("..").resolve(relativePath).normalize();
        }
        Assertions.assertTrue(Files.exists(p), "源文件不存在: " + p.toAbsolutePath());
        return new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
    }

    /** 断言失败时只打片段：整份源文件有 8 万字符，全量打印会淹没真正的错误信息。 */
    private static String brief(String s) {
        String oneLine = s.replaceAll("\\s+", " ");
        return oneLine.length() <= 400 ? oneLine : oneLine.substring(0, 400) + "…";
    }
}
