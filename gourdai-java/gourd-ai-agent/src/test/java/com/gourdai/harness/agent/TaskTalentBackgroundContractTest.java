/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, 2.0 (the "License");
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
import com.gourdai.harness.HarnessEngine;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * multitask 后台化（按任务粒度）的契约测试。
 *
 * <p>本轮把 background 能力从 {@code task} 扩展到 {@code multitask}：一批任务里可混合
 * 前台（阻塞到全部完成）与后台（detached 提交、立即返 token）两种，由 await_tasks 统一收取。
 * 这样主代理不再被批量委派整体阻塞在 ACTION 段，能回到 REASON 轮继续推进并及时消费用户插话。</p>
 *
 * <p><b>为什么用真实 HarnessEngine 而非 mock：</b>本项目无 mockito 依赖，且
 * {@code HarnessEngine} 构造器是 private（只能经 {@code of(...).build()}），无法子类化。
 * 真实 engine 配合「不存在的 agent_name」可让 taskDo 走 unknownAgentMessage 快速失败路径，
 * 既能跑通完整的分流→提交→聚合→await 链路，又不需要真的调模型。</p>
 *
 * <p><b>非阻塞性用源码扫描守护而非计时：</b>「后台分支不阻塞」若用 sleep + 计时断言，
 * 在慢 CI 上会偶发红、在快机器上又杀不死变异（任务本身就快速失败）。改为断言
 * {@code formatBackgroundSubmission} 方法体内不含任何等待原语（join/get/allOf），
 * 这是「不阻塞」的结构充要条件，且变异验证可稳定杀死。</p>
 *
 * @author oisin
 */
public class TaskTalentBackgroundContractTest {

    private static final String SOURCE_PATH =
            "gourd-ai-agent/src/main/java/com/gourdai/harness/agent/TaskTalent.java";

    /** 故意用一个不存在的代理名：taskDo 会快速降级为 unknownAgentMessage 失败结果，不真调模型。 */
    private static final String UNKNOWN_AGENT = "__no_such_agent_for_test__";

    @TempDir
    Path temp;

    // ── 行为契约 ──────────────────────────────────────────

    /**
     * 纯后台批次：必须返回 token 且能被 await_tasks 收取，结果信封完整。
     *
     * <p>信封完整性是 P1 级要求：后台路径挂了 exceptionally，异常/失败会被包成
     * {@code <task_result>}（含 index 与 result_status），否则批量场景下无法与请求对应。</p>
     */
    @Test
    public void backgroundOnlyBatchMustReturnAwaitableTokens() {
        HarnessEngine engine = newEngine();
        TaskTalent talent = new TaskTalent(engine);
        String session = "bg-session";

        String resp = talent.multitask(
                Arrays.asList(op(1, "后台任务一", true), op(2, "后台任务二", true)),
                temp.toString(), session, null, null, null);

        Assertions.assertTrue(resp.contains("<multitask_background>"), "纯后台批次应产出提交清单: " + resp);
        Assertions.assertTrue(resp.contains("</multitask_background>"), "提交清单必须闭合: " + resp);

        List<String> tokens = extractTokens(resp);
        Assertions.assertEquals(2, tokens.size(), "两个后台任务应各得一个 token: " + resp);

        // 刻意不产出 <multitask_results> 空壳：空信封会让模型误读成「全部已完成且结果为空」
        Assertions.assertFalse(resp.contains("<multitask_results>"),
                "纯后台批次不得产出结果信封（会让模型跳过 await 直接编造结论）: " + resp);

        // token 必须真能 await 出结果，且带 <task_result> 信封与 result_status
        String awaited = talent.awaitTasks(tokens, 0, 30, session);
        Assertions.assertTrue(awaited.contains("<await_results>"), "await 应产出结果段: " + awaited);
        Assertions.assertTrue(awaited.contains("<task_result>"),
                "后台结果必须保留 <task_result> 信封（否则批量场景无法与请求对应）: " + awaited);
        Assertions.assertTrue(awaited.contains("<result_status>"),
                "后台结果必须带 result_status: " + awaited);
        Assertions.assertTrue(awaited.contains(UNKNOWN_AGENT) || awaited.contains("未知的子代理"),
                "应能取到子代理的真实执行结论: " + awaited);

        // 用法提醒必须在场：模型最常见的误区是提交后立刻 await，那等于退化成阻塞模式
        Assertions.assertTrue(resp.contains("不要在提交后立刻 await"),
                "必须提示先做别的事、最后统一 await: " + resp);
    }

    /**
     * 混合批次：前台组进 {@code <multitask_results>}，后台组进 {@code <multitask_background>}，
     * 两组归属不得串台。
     *
     * <p><b>顺序契约（P1 修复）</b>：后台段必须在返回值中<b>位于前台段之前</b>——它同时映射
     * 执行顺序（后台先提交、前台后阻塞）：若前台先执行，后台任务要干等前台组全部跑完才开跑，
     * 混合批次下 background 化的并行收益完全丧失。用「两段首现位置」作确定性判据，不依赖计时。</p>
     */
    @Test
    public void mixedBatchMustKeepForegroundAndBackgroundApart() {
        HarnessEngine engine = newEngine();
        TaskTalent talent = new TaskTalent(engine);
        String session = "mixed-session";

        String resp = talent.multitask(
                Arrays.asList(op(1, "前台任务甲", false), op(2, "后台任务乙", true),
                        op(3, "前台任务丙", false)),
                temp.toString(), session, null, null, null);

        int bgStart = resp.indexOf("<multitask_background>");
        int bgEnd = resp.indexOf("</multitask_background>");
        Assertions.assertTrue(bgStart >= 0 && bgEnd > bgStart, "混合批次应含后台段: " + resp);

        // 修复后顺序：bg 段在前、fg 段在后（后台先提交、前台后阻塞）。
        // fgPart 从 bg 段闭合标签之后切，而非从 bgStart 切：后者会把 bg 段自身带进 fg 段。
        String bgPart = resp.substring(bgStart, bgEnd + "</multitask_background>".length());
        String fgPart = resp.substring(bgEnd + "</multitask_background>".length());

        // 前台段：含全部前台任务的结果，且不含任何 token
        Assertions.assertTrue(fgPart.contains("<multitask_results>"), "前台段应有结果信封: " + fgPart);
        Assertions.assertTrue(fgPart.contains("<index>1</index>"), "前台段应含 index=1: " + fgPart);
        Assertions.assertTrue(fgPart.contains("<index>3</index>"), "前台段应含 index=3: " + fgPart);
        Assertions.assertTrue(extractTokens(fgPart).isEmpty(), "前台段不得出现 token: " + fgPart);

        // 后台段：只含后台任务，token 数量与之匹配
        List<String> tokens = extractTokens(bgPart);
        Assertions.assertEquals(1, tokens.size(), "后台段应只有 1 个 token: " + bgPart);
        Assertions.assertTrue(bgPart.contains("后台任务乙"), "后台段应含对应 description: " + bgPart);
        Assertions.assertFalse(bgPart.contains("<index>1</index>"),
                "后台段不得混入前台任务: " + bgPart);

        // 前台段的结果是同步等到的，必须已含真实执行结论（非空壳）
        Assertions.assertTrue(fgPart.contains("<result_status>"), "前台段应含 result_status: " + fgPart);
    }

    /**
     * P1 回归：后台组必须先于前台组提交。
     *
     * <p>仅靠 mixedBatch 的段序断言不够——它只验「返回值形状」，而旧实现（前台先执行）
     * 在纯后台批次为 0 时也产出同形状。本用例直接断言 multitask 方法体内
     * {@code formatBackgroundSubmission} 的调用点出现在 {@code runForegroundTasks} 之前：</p>
     * <p>结构上的先后即执行上的先后（两段都是同步代码，无并发窗口），
     * 这是「后台不等前台」的充要判据，且变异验证可稳定杀死。</p>
     */
    @Test
    public void backgroundGroupMustBeSubmittedBeforeForegroundBlocks() throws Exception {
        String body = extractMethodBody(readSource(), "multitask");
        int bgCall = body.indexOf("formatBackgroundSubmission(");
        int fgCall = body.indexOf("runForegroundTasks(");
        Assertions.assertTrue(bgCall >= 0, "multitask 应调用 formatBackgroundSubmission: " + body);
        Assertions.assertTrue(fgCall >= 0, "multitask 应调用 runForegroundTasks: " + body);
        Assertions.assertTrue(bgCall < fgCall,
                "后台组必须先提交（bg 先于 fg）：否则混合批次下后台任务干等前台组跑完才开跑，"
                        + "background 化的并行收益丧失");
    }

    /**
     * 纯前台批次零回归：返回值结构与引入 background 之前一致——
     * 以 {@code <multitask_results>} 起头、带 TODO 提醒、不含任何后台包裹与 token。
     */
    @Test
    public void foregroundOnlyBatchMustStayByteIdenticalInShape() {
        HarnessEngine engine = newEngine();
        TaskTalent talent = new TaskTalent(engine);

        String resp = talent.multitask(
                Arrays.asList(op(1, "前台一", false), op(2, "前台二", false)),
                temp.toString(), "fg-session", null, null, null);

        Assertions.assertTrue(resp.startsWith("<multitask_results>"),
                "纯前台批次必须原样以结果信封起头（不得被任何后台包裹污染）: "
                        + resp.substring(0, Math.min(80, resp.length())));
        Assertions.assertTrue(resp.contains("</multitask_results>"), "结果信封必须闭合: " + resp);
        Assertions.assertTrue(resp.contains("todowrite"), "应保留 TODO 更新提醒: " + resp);
        Assertions.assertFalse(resp.contains("<multitask_background>"),
                "纯前台批次不得出现后台段: " + resp);
        Assertions.assertTrue(extractTokens(resp).isEmpty(), "纯前台批次不得产生 token: " + resp);
        Assertions.assertEquals(2, countOccurrences(resp, "<task_result>"),
                "两个前台任务应各有一条结果: " + resp);
    }

    /** 后台 token 的会话隔离对 multitask 同样生效（TaskTalent 是 engine 级单实例）。 */
    @Test
    public void multitaskBackgroundTokensMustIsolateBySession() {
        HarnessEngine engine = newEngine();
        TaskTalent talent = new TaskTalent(engine);

        String resp = talent.multitask(Collections.singletonList(op(1, "隔离验证", true)),
                temp.toString(), "session-A", null, null, null);
        List<String> tokens = extractTokens(resp);
        Assertions.assertEquals(1, tokens.size(), "应得到 1 个 token: " + resp);

        String own = talent.awaitTasks(tokens, 0, 30, "session-A");
        Assertions.assertTrue(own.contains("<task_result>"), "归属会话应能取到结果: " + own);

        String foreign = talent.awaitTasks(tokens, 0, 30, "session-B");
        Assertions.assertFalse(foreign.contains("<task_result>"),
                "跨会话不得读到他人子代理产出: " + foreign);
        Assertions.assertTrue(foreign.contains("不属于当前会话") || foreign.contains("ERROR"),
                "跨会话应返回统一不可见文案: " + foreign);
    }

    /** 空批次与缺 sessionId 的既有护栏不因分流改造而失效。 */
    @Test
    public void existingGuardsMustSurviveRefactor() {
        HarnessEngine engine = newEngine();
        TaskTalent talent = new TaskTalent(engine);

        Assertions.assertTrue(talent.multitask(null, temp.toString(), "s", null, null, null).contains("为空"));
        Assertions.assertTrue(talent.multitask(Collections.emptyList(), temp.toString(), "s", null, null, null)
                .contains("为空"));

        Assertions.assertThrows(IllegalStateException.class,
                () -> talent.multitask(Collections.singletonList(op(1, "x", true)),
                        temp.toString(), null, null, null, null),
                "缺 __sessionId 必须抛错（token 归属校验依赖它）");
    }

    // ── 结构契约（源码扫描）──────────────────────────────

    /**
     * 后台提交路径不得含任何等待原语——这是「非阻塞」的结构充要条件。
     *
     * <p>同时守住两处 P1 级细节：detached 必须传 true（否则父 sink 完成时子代理流被
     * takeUntil 立刻截断、误报 CANCELLED，即上轮 P0③ 的同源缺陷）；必须挂 exceptionally
     * （否则异常留到 await 才以 ExecutionException 抛出，丢掉 {@code <task_result>} 信封与 index）。</p>
     */
    @Test
    public void backgroundSubmissionMustNotBlockAndMustDetach() throws Exception {
        String body = extractMethodBody(readSource(), "formatBackgroundSubmission");

        Assertions.assertFalse(body.contains("allOf"),
                "后台提交不得聚合等待（allOf）：那等于退化成阻塞模式\n" + body);
        Assertions.assertFalse(body.contains(".join()"),
                "后台提交不得 join：非阻塞是本次改造的全部意义\n" + body);
        Assertions.assertFalse(body.contains(".get("),
                "后台提交不得 future.get：非阻塞是本次改造的全部意义\n" + body);

        Assertions.assertTrue(body.contains("__thinkingDepth, true), RunUtil.io()"),
                "后台任务必须以 detached=true 提交（taskDo 末参）：否则父 sink 完成即被 takeUntil "
                        + "截断子代理流、误报 CANCELLED，即上轮 P0③ 的同源缺陷\n" + body);
        Assertions.assertTrue(body.contains("exceptionally"),
                "后台任务必须挂 exceptionally，否则失败结果丢掉 <task_result> 信封与 index\n" + body);
        Assertions.assertTrue(body.contains("registerBackgroundTask"),
                "后台任务必须登记 token，否则 await_tasks 无从收取\n" + body);

        // 同步提交失败（线程池拒绝）时必须就地返回失败结果、不登记 token：
        // 登记一个永不完成的 future 会让 await 白等到超时。故 continue 必须在 register 之后不可达处，
        // 即 catch 块内只 append 失败结果并 continue，不调 registerBackgroundTask。
        int catchIdx = body.indexOf("catch (Throwable");
        Assertions.assertTrue(catchIdx > 0, "应保留提交失败的兜底 catch\n" + body);
        String catchBlock = body.substring(catchIdx);
        int continueIdx = catchBlock.indexOf("continue");
        int registerInCatch = catchBlock.indexOf("registerBackgroundTask");
        Assertions.assertTrue(continueIdx > 0, "提交失败应跳过该任务继续下一个\n" + catchBlock);
        Assertions.assertTrue(registerInCatch < 0 || registerInCatch > catchBlock.indexOf("}"),
                "提交失败的 catch 内不得登记 token（会让 await 白等到超时）\n" + catchBlock);
    }

    /** 前台路径必须保留 allOf().join() 的整体等待语义（改造只分流，不改前台行为）。 */
    @Test
    public void foregroundPathMustStillBlockUntilAllDone() throws Exception {
        String body = extractMethodBody(readSource(), "runForegroundTasks");
        Assertions.assertTrue(body.contains("allOf"), "前台组必须等全部完成: " + body);
        Assertions.assertTrue(body.contains(".join()"), "前台组必须阻塞等待: " + body);
        Assertions.assertTrue(body.contains("<multitask_results>"), "前台组必须产出结果信封: " + body);
        Assertions.assertTrue(body.contains("exceptionally"),
                "前台组必须保留 exceptionally 降级（否则一个失败会连带丢弃成功的兄弟任务）: " + body);
    }

    /**
     * P2 修复回归：task() 单任务 background 分支必须同样挂 exceptionally。
     *
     * <p>与 formatBackgroundSubmission 的对称性要求：taskDo 自身 try 之外的漏网异常若不就地降级，
     * await_tasks 的 future.get 会抛 ExecutionException，只剩裸 ERROR 文案——丢掉 <task_result>
     * 信封，模型无法对应哪个任务失败。即使通知侧有 notifyFailure 兜底（模型看得到失败），
     * await 通道拿到的仍是无信封裸文案，两条通道不对齐。</p>
     */
    @Test
    public void singleTaskBackgroundMustAlsoDegradeViaExceptionally() throws Exception {
        String body = extractMethodBody(readSource(), "task");
        int bgIdx = body.indexOf("if (taskSpec.background)");
        Assertions.assertTrue(bgIdx > 0, "task 应有 background 分支: " + body);
        String bgBranch = body.substring(bgIdx, body.indexOf("return taskDo", bgIdx) > 0
                ? body.indexOf("return taskDo", bgIdx) : body.length());
        Assertions.assertTrue(bgBranch.contains("exceptionally"),
                "task() 的 background 分支必须挂 exceptionally（与 formatBackgroundSubmission 对称），"
                        + "否则异常结果丢 <task_result> 信封: " + bgBranch);
        Assertions.assertTrue(bgBranch.contains("formatTaskResp"),
                "降级必须包成失败信封（含 description），而非裸文案: " + bgBranch);
    }

    /**
     * 分流必须按任务粒度读 background 字段，且分母传整批 size。
     *
     * <p>分母若误传 foreground.size()，混合批次里子代理日志的 index/total 对应关系就乱了
     * （如 3 个任务中 1 个后台，前台会打成 1/2 而非 1/3）。</p>
     */
    @Test
    public void dispatchMustBePerTaskAndKeepBatchTotalAsDenominator() throws Exception {
        String body = extractMethodBody(readSource(), "multitask");

        Assertions.assertTrue(body.contains("task.background"),
                "必须按任务粒度读 background 字段（用户已拍板此方案）: " + body);
        Assertions.assertFalse(body.contains("ERROR: multitask 不支持 background"),
                "旧的显式拒绝必须已移除: " + body);

        // 两个分支的分母都必须是整批 tasks.size()
        Assertions.assertTrue(body.contains("tasks.size()"),
                "子代理日志分母必须是整批 tasks.size(): " + body);
        Assertions.assertFalse(body.contains("foreground.size()"),
                "分母不得用 foreground.size()（会打乱 index/total 对应关系）: " + body);

        // 前台结果不得被后台包裹污染：纯前台时 result 只 append runForegroundTasks 的返回值
        Assertions.assertTrue(body.contains("foreground.isEmpty() == false"),
                "前台组为空时不得调用 runForegroundTasks（否则会产出空信封）: " + body);
        Assertions.assertTrue(body.contains("background.isEmpty() == false"),
                "后台组为空时不得调用 formatBackgroundSubmission: " + body);
    }

    /** 工具 schema 与指令必须同步声明 multitask 已支持 background（否则模型不会用）。 */
    @Test
    public void instructionAndSchemaMustAdvertiseMultitaskBackground() throws Exception {
        String src = readSource();

        Assertions.assertFalse(src.contains("仅 `task` 支持，multitask 不支持"),
                "getInstruction 里「multitask 不支持」的旧表述必须已更新");
        Assertions.assertTrue(src.contains("`task` 与 `multitask` 均支持"),
                "getInstruction 必须声明 multitask 也支持后台模式");

        // background 字段的 schema 描述同样要提 multitask，模型靠它决定能不能在 tasks[] 里写
        Matcher m = Pattern.compile("@Param\\(name = \"background\"(?s).*?\\)\\s*\\n\\s*public boolean background")
                .matcher(src);
        Assertions.assertTrue(m.find(), "应能找到 background 字段的 @Param 声明");
        Assertions.assertTrue(m.group().contains("multitask"),
                "background 的 schema 描述必须说明 multitask 也支持: " + m.group());

        // 必须是可选参数：上轮 codereview 已确认「带默认值的开关不该进 required」
        Assertions.assertTrue(m.group().contains("required = false"),
                "background 必须是可选参数，否则每次调用强制模型多吐字段: " + m.group());
    }

    /**
     * 后台任务的 TTL 清理必须走 {@code RunUtil.timer()} 的延时调度，
     * 不得用 {@code RunUtil.io().execute + Thread.sleep}。
     *
     * <p><b>为何这是 P1 级守护（本轮排查新发现的真实缺陷）：</b>{@code io()} 在 JDK 21+ 才是
     * 无界虚拟线程池；本项目跑 JDK 17，{@code SolonProps} 要求 {@code JAVA_MAJOR_VERSION>=21}
     * 才启用虚拟线程，故 {@code io()} 退化为 {@code newFixedThreadPool(max(CPU×4, 16))}（本机 64 线程）。
     * 若在此池里 {@code execute(() -> Thread.sleep(60min))}，每登记一个后台任务就<b>额外占死一个
     * 平台线程空睡 60 分钟</b>（平台线程 sleep 不会像虚拟线程那样卸载），叠加子代理 blockLast()
     * 本身占用的线程，长会话派几十个后台任务就能把固定池耗尽 → 后续 supplyAsync 排队 →
     * background 退化成伪异步。timer() 是 {@code ScheduledThreadPoolExecutor}，schedule() 靠延时
     * 队列到期唤醒，延时期间不占任何线程。</p>
     */
    @Test
    public void ttlCleanupMustUseTimerNotBlockingSleep() throws Exception {
        String body = extractPackageMethodBody(readSource(), "registerBackgroundTask");

        Assertions.assertTrue(body.contains("RunUtil.timer()"),
                "TTL 清理必须走调度池 timer()，不得占用 io() 并行工作线程: " + body);
        Assertions.assertTrue(body.contains(".schedule("),
                "必须用 schedule() 延时触发（延时队列到期唤醒，不占线程）: " + body);
        Assertions.assertFalse(body.contains("Thread.sleep"),
                "TTL 清理不得用 Thread.sleep 占死平台线程（JDK17 下 io() 是有界池，会耗尽）: " + body);
        Assertions.assertFalse(body.contains("RunUtil.io()"),
                "TTL 清理不得用 io() 并行池（子代理本体才用 io()，TTL 只是延时删除）: " + body);
        Assertions.assertTrue(body.contains("BACKGROUND_TTL_MINUTES"),
                "TTL 时长必须引用统一常量: " + body);
        // 驱逐仍须是 compare-and-remove（只删自己登记的那一条），避免误删同 token 的新登记
        Assertions.assertTrue(body.contains("taskRegistry.remove(token, entry)"),
                "TTL 到期必须用 compare-and-remove，不得误删他人登记: " + body);
    }

    /** getInstruction 必须引导模型优先用 background（否则默认阻塞，O-E 的非阻塞收益落不到实处）。 */
    @Test
    public void instructionMustAdviseBackgroundAsDefault() throws Exception {
        String src = readSource();

        Assertions.assertTrue(src.contains("**后台模式（默认优先）**"),
                "getInstruction 必须把 background 提为默认优先项，否则模型倾向默认阻塞");
        // 旧描述里的「后台任务不向前端实时推送子代理进度」是 A+ 轮之前的过时谎言：
        // emitBackgroundStart/Progress/End + BackgroundAgentListener 已实现卡片与当前工具名推送，
        // 由 backgroundProgressHint() 运行时如实分叉。这句谎言会勝退模型用 background，必须已删除。
        Assertions.assertFalse(src.contains("后台任务不向前端实时推送子代理进度"),
                "background 参数描述里「不向前端推送进度」的过时谎言必须已删除（与 A+ 轮实现矛盾）");
    }

    // ── 辅助 ──────────────────────────────────────────────

    private HarnessEngine newEngine() {
        // 绝对路径 harnessHome 已由 HarnessOptions 构造器拆解处理（见其 Windows 双盘符修复注释）。
        // sessionProvider 必须注入：HarnessEngine.getSession 直接委派给它（L970-972），不注入则
        // multitask 一进门就 NPE。AgentSessionProvider 是 @FunctionalInterface，用 lambda 给
        // 内存态会话即可——本测试不需要落盘，且 InMemoryAgentSession 的 context 里没有 trace，
        // ReActTrace.getCurrent 返回 null 正好让 taskDo 走同步分支（与 detached 语义一致）。
        return HarnessEngine.of(temp.toString(), temp.resolve("home").toString())
                .sessionProvider(InMemoryAgentSession::of)
                .build();
    }

    private static TaskTalent.MultiTaskOp op(int index, String description, boolean background) {
        TaskTalent.MultiTaskOp op = new TaskTalent.MultiTaskOp();
        op.index = index;
        op.agent_name = UNKNOWN_AGENT;
        op.description = description;
        op.prompt = "测试用提示词：" + description;
        op.background = background;
        return op;
    }

    /** 从提交清单里抽出全部 token（{@code <token>xxx</token>}）。 */
    private static List<String> extractTokens(String text) {
        List<String> tokens = new ArrayList<>();
        Matcher m = Pattern.compile("<token>([^<]+)</token>").matcher(text);
        while (m.find()) {
            tokens.add(m.group(1));
        }
        return tokens;
    }

    private static int countOccurrences(String text, String needle) {
        int count = 0;
        int from = 0;
        while ((from = text.indexOf(needle, from)) >= 0) {
            count++;
            from += needle.length();
        }
        return count;
    }

    private static String readSource() throws Exception {
        // surefire 的工作目录可能是仓库根也可能是模块目录，两种口径都要能解析
        // （口径与 AskUserProtocolTest#readSource 保持一致）
        Path p = Paths.get(SOURCE_PATH);
        if (Files.exists(p) == false) {
            p = Paths.get("..").resolve(SOURCE_PATH).normalize();
        }
        Assertions.assertTrue(Files.exists(p), "源码文件应存在: " + p.toAbsolutePath());
        return new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
    }

    /**
     * 抽取指定方法的完整方法体（含大括号配对）。
     *
     * <p>不能只切到「第一个 }」：方法体内有 for/if/try 嵌套。按大括号计数取配对收尾。</p>
     *
     * <p>签名前缀不限定 public/private：{@code multitask} 是 public 工具方法，
     * 两个拆出的辅助方法是 private。按「修饰符 + 返回类型 + 方法名(」的正则定位，
     * 写死 private 会让 public 方法恒找不到、断言直接 fail。</p>
     */
    private static String extractMethodBody(String src, String methodName) {
        Matcher sig = Pattern.compile("(?:public|private|protected)\\s+String\\s+" + Pattern.quote(methodName) + "\\s*\\(")
                .matcher(src);
        Assertions.assertTrue(sig.find(), "应能找到方法 " + methodName);
        int open = src.indexOf('{', src.indexOf(')', sig.end()));
        Assertions.assertTrue(open >= 0, "应能找到 " + methodName + " 的方法体起点");

        int depth = 0;
        for (int i = open; i < src.length(); i++) {
            char c = src.charAt(i);
            if (c == '{') {
                depth++;
            } else if (c == '}') {
                depth--;
                if (depth == 0) {
                    return src.substring(open, i + 1);
                }
            }
        }
        Assertions.fail("方法体大括号未配平: " + methodName);
        return "";
    }

    /**
     * 抽取<b>包级可见</b>（无 public/private/protected 修饰符）方法的方法体。
     *
     * <p>与 {@link #extractMethodBody} 的区别：后者正则写死了修饰符前缀，抓不到
     * 包级可见方法（如 {@code registerBackgroundTask}）。此处以 {@code String\s+方法名\s*(}
     * 定位定义行：{@code registerBackgroundTaskWithNotice} 后跟 {@code WithNotice(} 不匹配，
     * 调用点 {@code String token = registerBackgroundTask(...)} 因 {@code String} 与方法名之间
     * 隔着 {@code token =} 也不匹配，故能唯一定位定义处。</p>
     */
    private static String extractPackageMethodBody(String src, String methodName) {
        Matcher sig = Pattern.compile("String\\s+" + Pattern.quote(methodName) + "\\s*\\(").matcher(src);
        Assertions.assertTrue(sig.find(), "应能找到包级方法 " + methodName);
        int open = src.indexOf('{', src.indexOf(')', sig.end()));
        Assertions.assertTrue(open >= 0, "应能找到 " + methodName + " 的方法体起点");
        int depth = 0;
        for (int i = open; i < src.length(); i++) {
            char c = src.charAt(i);
            if (c == '{') {
                depth++;
            } else if (c == '}') {
                depth--;
                if (depth == 0) {
                    return src.substring(open, i + 1);
                }
            }
        }
        Assertions.fail("方法体大括号未配平: " + methodName);
        return "";
    }
}
