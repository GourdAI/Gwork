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

import com.gourdai.agent.react.BackgroundNoticeCenter;
import com.gourdai.agent.session.InMemoryAgentSession;
import com.gourdai.harness.HarnessEngine;
import org.junit.jupiter.api.AfterEach;
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
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * O-H：background 子代理接入 BackgroundNoticeCenter（推送模式）的契约测试。
 *
 * <p><b>本轮解决的问题</b>：原先 background 子代理只有 token + {@code await_tasks} 的<b>拉取</b>通道，
 * 模型无从得知任务何时结束，只能反复 await 轮询——每次轮询都是一轮完整 LLM 往返，且轮询结果永久留在
 * 工作记忆里被后续每轮重发。项目已为 bash 后台命令建好推送链路（TerminalTalent publish →
 * ReasonTask 每轮 drain 注入），但 TaskTalent 完全没接上它。本轮把子代理通知接进同一套基础设施。</p>
 *
 * <p><b>为何这里不能用 mock</b>：项目无 mockito 依赖，且 {@code BackgroundNoticeCenter} 全是静态方法。
 * 改为直接用其 public API（{@code bindCurrentOwner}/{@code drain}）在测试线程上模拟
 * 「ActionTask 绑定归属键 → 工具提交 → 推理轮消费」的真实时序。</p>
 *
 * <p><b>注意包可见性</b>：{@code resetForTest}/{@code pendingCountForTest} 是 {@code com.gourdai.agent.react}
 * 包级私有，本测试在 {@code com.gourdai.harness.agent} 包下拿不到，故每个用例使用唯一 owner 键
 * 并在 {@code @AfterEach} 里 drain 干净，避免用例间互相污染。</p>
 *
 * <p><b>通知到达必须轮询等待而非直接断言</b>：{@code registerBackgroundTask} 登记的是<b>原始</b> future，
 * 而 {@code thenAccept} 挂的是派生阶段。原始 future 完成时会释放阻塞在 {@code get()} 上的线程，
 * 但派生动作是在 {@code postComplete()} 里跑的——「get() 已返回」并不蕴含「通知已投递」。
 * 直接断言会形成偶发红的时序竞态。</p>
 *
 * @author oisin
 */
public class TaskTalentBackgroundNoticeTest {

    private static final String TASK_SOURCE_PATH =
            "gourd-ai-agent/src/main/java/com/gourdai/harness/agent/TaskTalent.java";

    private static final String TERMINAL_SOURCE_PATH =
            "gourd-ai-agent/src/main/java/com/gourdai/harness/talents/cli/TerminalTalent.java";

    /** 故意用一个不存在的代理名：taskDo 会快速降级为 unknownAgentMessage 失败结果，不真调模型。 */
    private static final String UNKNOWN_AGENT = "__no_such_agent_for_notice_test__";

    /** 轮询通知的上限：UNKNOWN_AGENT 走快速失败路径，正常几十毫秒内就该到。 */
    private static final long NOTICE_WAIT_TIMEOUT_MS = 15_000L;

    @TempDir
    Path temp;

    @AfterEach
    public void unbindOwner() {
        // 归属键是 ThreadLocal：不解绑会随线程复用泄漏给同线程后续用例（surefire 复用线程）
        BackgroundNoticeCenter.unbindCurrentOwner();
    }

    // ── 行为契约：通知真的被投递 ──────────────────────────────

    /**
     * 绑定归属键后提交后台任务，完成时必须投递一条子代理通知，载荷与提交时一致。
     *
     * <p>这是「拉取改推送」的核心断言：若 {@code thenAccept} 没挂上、或 owner 取成了 null，
     * drain 会拿到空列表。</p>
     */
    @Test
    public void subagentNoticeMustBePublishedWhenOwnerBound() {
        String owner = newOwner();
        BackgroundNoticeCenter.bindCurrentOwner(owner);

        TaskTalent talent = new TaskTalent(newEngine());
        CompletableFuture<String> future =
                CompletableFuture.completedFuture("<task_result><result_status>success</result_status>结论A</task_result>");

        String token = talent.registerBackgroundTaskWithNotice("sess-1", future, op(7, "查三处用法"), 7);

        List<BackgroundNoticeCenter.Notice> notices = awaitNotices(owner, 1);
        Assertions.assertEquals(1, notices.size(), "完成时必须投递恰好一条通知");

        BackgroundNoticeCenter.Notice n = notices.get(0);
        Assertions.assertEquals(BackgroundNoticeCenter.Notice.KIND_SUBAGENT, n.kind(),
                "必须是子代理通知，不能沿用 bash 种类");
        Assertions.assertEquals(token, n.token(), "通知里的 token 必须与提交回执一致，否则模型无法 await");
        Assertions.assertEquals(Integer.valueOf(7), n.index());
        Assertions.assertEquals(UNKNOWN_AGENT, n.agentName());
        Assertions.assertEquals("查三处用法", n.description());
        Assertions.assertTrue(n.success(), "正常完成的结果应标记 success");

        // 消费端只调 render()，故渲染文本就是模型真正看到的东西
        String text = n.render();
        Assertions.assertTrue(text.contains("[后台子代理完成]"), text);
        Assertions.assertTrue(text.contains("结论A"), "摘要必须带上结果要点，模型据此判断要不要 await: " + text);
        Assertions.assertTrue(text.contains("await_tasks"), text);
        Assertions.assertFalse(text.contains("bash_output"),
                "子代理通知不得指引模型去调 bash_output（对 token 无效）: " + text);
    }

    /**
     * 业务失败的结果必须标记 success=false：{@code taskDo} 把失败也包成 {@code <task_result>} 正常返回，
     * future 是「正常完成」的，若不解析摘要就会把失败任务报成 finished，模型据此当成功处理。
     */
    @Test
    public void failureResultMustBeMarkedFailedInNotice() {
        String owner = newOwner();
        BackgroundNoticeCenter.bindCurrentOwner(owner);

        TaskTalent talent = new TaskTalent(newEngine());
        CompletableFuture<String> future = CompletableFuture.completedFuture(
                "<task_result><result_status>failure</result_status>ERROR: 子代理未找到</task_result>");

        talent.registerBackgroundTaskWithNotice("sess-2", future, op(1, "失败任务"), 1);

        List<BackgroundNoticeCenter.Notice> notices = awaitNotices(owner, 1);
        Assertions.assertEquals(1, notices.size());
        Assertions.assertFalse(notices.get(0).success(), "result_status=failure 必须映射成 success=false");
        Assertions.assertTrue(notices.get(0).render().contains("status=failed"), notices.get(0).render());
    }

    /**
     * future 异常完成（{@code task} 单任务 background 路径没挂 exceptionally）时，
     * 仍必须补发一条失败通知。
     *
     * <p><b>为何不能只写日志</b>：异常若不外显，模型会一直以为任务还在跑——本轮不收就等下轮，
     * 下轮没通知继续等，直到 TTL 驱逐 token 才回「token 不存在」。一条明确的失败通知能立刻止损。</p>
     */
    @Test
    public void exceptionalFutureMustStillPublishFailureNotice() {
        String owner = newOwner();
        BackgroundNoticeCenter.bindCurrentOwner(owner);

        TaskTalent talent = new TaskTalent(newEngine());
        CompletableFuture<String> future = new CompletableFuture<>();
        future.completeExceptionally(new IllegalStateException("子代理线程池炸了"));

        String token = talent.registerBackgroundTaskWithNotice("sess-3", future, op(2, "异常任务"), 2);

        List<BackgroundNoticeCenter.Notice> notices = awaitNotices(owner, 1);
        Assertions.assertEquals(1, notices.size(), "异常完成也必须投递通知，否则模型死等");

        BackgroundNoticeCenter.Notice n = notices.get(0);
        Assertions.assertFalse(n.success());
        Assertions.assertEquals(token, n.token());
        String text = n.render();
        Assertions.assertTrue(text.contains("status=failed"), text);
        Assertions.assertTrue(text.contains("子代理线程池炸了"), "失败原因必须可见: " + text);
    }

    /**
     * 通知摘要必须截断。
     *
     * <p><b>本机制的头号风险</b>：通知注入 workingMemory 后会随历史被后续<b>每一轮</b>全量重发；
     * 子代理结果动辄数千至数万字符。不截断就把「省掉一次轮询往返」变成「每轮多付一份完整结果」，
     * token 不降反升——恰好击穿 BackgroundNoticeCenter 存在的意义。</p>
     */
    @Test
    public void noticeSummaryMustBeTruncated() {
        String owner = newOwner();
        BackgroundNoticeCenter.bindCurrentOwner(owner);

        TaskTalent talent = new TaskTalent(newEngine());
        StringBuilder huge = new StringBuilder();
        for (int i = 0; i < 5000; i++) {
            huge.append('x');
        }
        CompletableFuture<String> future = CompletableFuture.completedFuture(huge.toString());

        talent.registerBackgroundTaskWithNotice("sess-4", future, op(1, "超长结果"), 1);

        List<BackgroundNoticeCenter.Notice> notices = awaitNotices(owner, 1);
        Assertions.assertEquals(1, notices.size());

        String summary = notices.get(0).resultSummary();
        Assertions.assertNotNull(summary);
        Assertions.assertTrue(summary.contains("结果已截断"),
                "超长结果必须带截断标记，让模型知道还有内容可用 await_tasks 取: " + summary.length());
        Assertions.assertTrue(summary.length() < 2000,
                "摘要必须远短于原文（原 5000 字符），否则每轮重发会放大 token: 实际 " + summary.length());
        Assertions.assertTrue(summary.length() < huge.length(), "必须真的截断了");
    }

    /**
     * 归属隔离：A 会话提交的通知不得落到 B 会话的桶里。
     *
     * <p>TaskTalent 是 HarnessEngine 级单实例、多会话共用，隔离全靠 ownerKey 分桶。</p>
     */
    @Test
    public void noticesMustIsolateByOwner() {
        String ownerA = newOwner();
        String ownerB = newOwner();

        TaskTalent talent = new TaskTalent(newEngine());

        BackgroundNoticeCenter.bindCurrentOwner(ownerA);
        talent.registerBackgroundTaskWithNotice("sess-A",
                CompletableFuture.completedFuture("结果甲"), op(1, "任务甲"), 1);

        // 换归属键提交第二个：模拟另一个会话在同一线程上提交
        BackgroundNoticeCenter.bindCurrentOwner(ownerB);
        talent.registerBackgroundTaskWithNotice("sess-B",
                CompletableFuture.completedFuture("结果乙"), op(1, "任务乙"), 1);

        List<BackgroundNoticeCenter.Notice> a = awaitNotices(ownerA, 1);
        List<BackgroundNoticeCenter.Notice> b = awaitNotices(ownerB, 1);

        Assertions.assertEquals(1, a.size(), "A 只应收到自己的通知: " + a);
        Assertions.assertEquals(1, b.size(), "B 只应收到自己的通知: " + b);
        Assertions.assertTrue(a.get(0).render().contains("结果甲"), a.get(0).render());
        Assertions.assertTrue(b.get(0).render().contains("结果乙"), b.get(0).render());
        Assertions.assertFalse(a.get(0).render().contains("结果乙"), "A 不得看到 B 的子代理产出");
    }

    /**
     * 归属键缺失时必须<b>如实降级</b>：不投递通知，且回执绝不能承诺「会自动收到」。
     *
     * <p>照抄 TerminalTalent#formatBackgroundStart 的既有教训：承诺一个不会到来的通知，
     * 会让模型停止查询、死等一条永不到来的消息——比没有通知机制更糟。</p>
     */
    @Test
    public void missingOwnerMustDegradeHonestly() {
        BackgroundNoticeCenter.unbindCurrentOwner();
        Assertions.assertFalse(TaskTalent.noticeAvailable(), "未绑定归属键时 noticeAvailable 必须为 false");

        TaskTalent talent = new TaskTalent(newEngine());
        String resp = talent.multitask(
                Arrays.asList(op(1, "后台任务一", true), op(2, "后台任务二", true)),
                temp.toString(), "no-owner-session", null, null, null);

        Assertions.assertTrue(resp.contains("<multitask_background>"), resp);
        Assertions.assertFalse(resp.contains("你会自动收到"),
                "无归属键时绝不能承诺推送，否则模型会死等: " + resp);
        Assertions.assertTrue(resp.contains("未启用完成通知"),
                "必须如实告知需自行 await 收取: " + resp);
        // await 通道必须照常可用：降级只是少了推送，不能连结果都取不回
        List<String> tokens = extractTokens(resp);
        Assertions.assertEquals(2, tokens.size(), resp);
        String awaited = talent.awaitTasks(tokens, 0, 30, "no-owner-session");
        Assertions.assertTrue(awaited.contains("<task_result>"), "降级路径仍须能 await 出结果: " + awaited);
    }

    /**
     * 端到端：绑定归属键后经 {@code multitask} 提交后台批次，回执必须宣告推送，
     * 且每个任务完成后都真有通知送达（含各自 index 与 token）。
     *
     * <p>这条覆盖了「工具方法内取 owner」的时序正确性：归属键靠 ThreadLocal 从 ActionTask 透传，
     * 若在 whenComplete 回调里才取（回调跑在 IO 线程池上），读到的恒是 null，
     * 整个功能会静默退化成 no-op。</p>
     */
    @Test
    public void boundOwnerSubmissionMustAdvertisePushAndDeliverNotices() {
        String owner = newOwner();
        BackgroundNoticeCenter.bindCurrentOwner(owner);

        TaskTalent talent = new TaskTalent(newEngine());
        String session = "push-session";

        String resp = talent.multitask(
                Arrays.asList(op(1, "后台任务一", true), op(2, "后台任务二", true)),
                temp.toString(), session, null, null, null);

        Assertions.assertTrue(resp.contains("你会自动收到一条 [后台子代理完成]"),
                "已启用通知时必须宣告推送，模型才知道无需轮询: " + resp);
        Assertions.assertFalse(resp.contains("未启用完成通知"), "已绑定归属键却报降级，说明 owner 没取到: " + resp);
        // 仍须劝阻「提交后立刻 await」，否则后台模式退化成阻塞
        Assertions.assertTrue(resp.contains("不要在提交后立刻 await"), resp);

        List<String> tokens = extractTokens(resp);
        Assertions.assertEquals(2, tokens.size(), resp);

        List<BackgroundNoticeCenter.Notice> notices = awaitNotices(owner, 2);
        Assertions.assertEquals(2, notices.size(), "两个后台任务应各投递一条通知: " + notices);

        for (BackgroundNoticeCenter.Notice n : notices) {
            Assertions.assertEquals(BackgroundNoticeCenter.Notice.KIND_SUBAGENT, n.kind());
            Assertions.assertTrue(tokens.contains(n.token()),
                    "通知里的 token 必须能对回提交回执: " + n.token() + " not in " + tokens);
            Assertions.assertNotNull(n.index(), "批量提交的通知必须带 index，否则无法与请求对应");
        }
        List<Integer> indexes = new ArrayList<>();
        for (BackgroundNoticeCenter.Notice n : notices) {
            indexes.add(n.index());
        }
        Collections.sort(indexes);
        Assertions.assertEquals(Arrays.asList(1, 2), indexes, "index 必须原样透传: " + indexes);

        // 消费端（ReasonTask）只调 render()，故这里验证渲染文本可直接注入工作记忆
        for (BackgroundNoticeCenter.Notice n : notices) {
            Assertions.assertTrue(n.render().contains("await_tasks"), n.render());
        }
    }

    /**
     * 单任务 {@code task(background=true)} 提交回执同样要按通知可用性分叉。
     *
     * <p>用源码扫描而非真调 {@code task()}：后者需要注册进 SessionProvider 的真实会话与 trace，
     * 而本用例要守的是「回执文案有没有按 noticeEnabled 分叉」这一结构约束。</p>
     */
    @Test
    public void singleTaskBranchMustForkOnNoticeAvailability() throws Exception {
        String src = readSource(TASK_SOURCE_PATH);
        String body = extractMethodBody(src, "task");

        Assertions.assertTrue(body.contains("BACKGROUND_TASK_SUBMITTED"), "应定位到 background 分支");
        Assertions.assertTrue(body.contains("registerBackgroundTaskWithNotice("),
                "单任务 background 分支必须走带通知的登记方法: " + body);
        Assertions.assertTrue(body.contains("noticeAvailable()"),
                "回执文案必须按通知可用性分叉，不能无条件承诺推送");
        Assertions.assertTrue(body.contains("你会自动收到一条 [后台子代理完成]"),
                "启用通知时的文案必须在场");
        Assertions.assertTrue(body.contains("BACKGROUND_NO_NOTICE_HINT"),
                "降级文案必须在场，否则 owner 缺失时会承诺不存在的通知");
        // 单任务不属于批量：通知里带 index=1 会让模型误以为还有兄弟任务
        Assertions.assertTrue(body.contains("taskOp, null)"),
                "单任务提交必须把 index 传 null: " + body);
    }

    /**
     * 批量提交路径不得退回「只登记不通知」。
     *
     * <p>{@code registerBackgroundTaskWithNotice} 内部<b>会</b>调用 {@code registerBackgroundTask}，
     * 故这里带括号精确匹配裸调用形式，避免把内部委派误判成退回。</p>
     */
    @Test
    public void batchSubmissionMustRegisterWithNotice() throws Exception {
        String src = readSource(TASK_SOURCE_PATH);
        String body = extractMethodBody(src, "formatBackgroundSubmission");

        Assertions.assertTrue(body.contains("registerBackgroundTaskWithNotice("),
                "批量后台提交必须走带通知的登记方法: " + body);
        Assertions.assertFalse(body.contains("registerBackgroundTask("),
                "不得退回裸登记（那会静默丢掉推送，只留轮询）: " + body);
        Assertions.assertTrue(body.contains("task.index"),
                "批量提交必须把任务序号带进通知，否则模型无法对应请求");
        Assertions.assertTrue(body.contains("noticeAvailable()"),
                "提交清单的提醒文案必须按通知可用性二选一");
    }

    /**
     * 模型侧文档必须宣告推送通道，且 {@code await_tasks} 要说明「摘要够用就不必调」。
     *
     * <p>后半句很关键：不写的话模型会「收到通知 → 仍然 await 一次」，白付一次工具往返，
     * 推送省下的开销又被吃回去。</p>
     */
    @Test
    public void instructionAndSchemaMustAdvertisePushChannel() throws Exception {
        String src = readSource(TASK_SOURCE_PATH);

        Assertions.assertTrue(src.contains("自动收到一条 [后台子代理完成]"),
                "getInstruction/回执必须宣告推送: 模型靠它决定不用轮询");
        Assertions.assertTrue(src.contains("无需轮询"), "必须明确点出无需轮询");

        Matcher await = Pattern.compile(
                "@ToolMapping\\(name = TOOL_AWAIT_TASKS(?s).*?public String awaitTasks").matcher(src);
        Assertions.assertTrue(await.find(), "应能找到 await_tasks 的 @ToolMapping 声明");
        Assertions.assertTrue(await.group().contains("自动推送"),
                "await_tasks 描述必须说明已有推送，摘要够用则不必调用: " + await.group());

        // background 字段的 schema 描述也要提推送：模型靠它决定要不要设 background=true
        Matcher bg = Pattern.compile(
                "@Param\\(name = \"background\"(?s).*?\\)\\s*\\n\\s*public boolean background").matcher(src);
        Assertions.assertTrue(bg.find(), "应能找到 background 字段的 @Param 声明");
        Assertions.assertTrue(bg.group().contains("自动收到"),
                "background 的 schema 描述必须宣告推送: " + bg.group());
        Assertions.assertTrue(bg.group().contains("required = false"),
                "background 必须仍是可选参数: " + bg.group());
    }

    /**
     * 通知载荷不得原样塞进 bash 专属字段，也不得改动 bash 侧既有链路。
     *
     * <p>TerminalTalent 用的是 7 参构造器、且 {@code formatBackgroundStart} 按 noticeEnabled 分叉——
     * 这两处若被本轮改动波及，bash 后台通知会回归。</p>
     */
    @Test
    public void bashNoticePathMustStayIntact() throws Exception {
        String src = readSource(TERMINAL_SOURCE_PATH);

        Assertions.assertTrue(src.contains("BackgroundNoticeCenter.currentOwner()"),
                "bash 侧仍须在提交线程取归属键");
        Assertions.assertTrue(src.contains("BackgroundNoticeCenter.publish(owner,"),
                "bash 侧仍须投递通知");
        Assertions.assertTrue(src.contains("formatBackgroundStart(snapshot, owner != null)"),
                "bash 侧仍须按归属键可用性如实分叉");
        Assertions.assertTrue(src.contains("new BackgroundNoticeCenter.Notice("),
                "bash 侧沿用 7 参构造器（本轮保留了该签名以免波及既有调用与测试）");
    }

    // ── 辅助 ──────────────────────────────────────────────

    /** 每个用例一个唯一归属键：跨包拿不到 resetForTest，只能靠唯一键隔离。 */
    private static String newOwner() {
        return "owner_" + UUID.randomUUID().toString().replace("-", "").substring(0, 16);
    }

    private HarnessEngine newEngine() {
        // sessionProvider 必须注入：HarnessEngine.getSession 直接委派给它，不注入则 multitask 一进门就 NPE。
        // InMemoryAgentSession 的 context 里没有 trace → ReActTrace.getCurrent 返回 null →
        // taskDo 走同步分支（与 detached 语义一致），正好不需要真调模型。
        return HarnessEngine.of(temp.toString(), temp.resolve("home").toString())
                .sessionProvider(InMemoryAgentSession::of)
                .build();
    }

    /**
     * 轮询 drain 直到收满期望条数或超时。
     *
     * <p>drain 是消费型的，故把每次取到的都累积进本地列表；不能用「一次性 drain 后断言数量」，
     * 那会在通知稍晚到达时偶发红。</p>
     */
    private static List<BackgroundNoticeCenter.Notice> awaitNotices(String owner, int expected) {
        List<BackgroundNoticeCenter.Notice> acc = new ArrayList<>();
        long deadline = System.currentTimeMillis() + NOTICE_WAIT_TIMEOUT_MS;
        while (acc.size() < expected && System.currentTimeMillis() < deadline) {
            acc.addAll(BackgroundNoticeCenter.drain(owner));
            if (acc.size() < expected) {
                try {
                    Thread.sleep(30L);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }
        // 收尾：把可能迟到的通知也清掉，避免污染同 owner 的后续断言
        acc.addAll(BackgroundNoticeCenter.drain(owner));
        return acc;
    }

    private static TaskTalent.MultiTaskOp op(int index, String description) {
        return op(index, description, true);
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

    private static String readSource(String relativePath) throws Exception {
        // surefire 的工作目录可能是仓库根也可能是模块目录，两种口径都要能解析
        Path p = Paths.get(relativePath);
        if (Files.exists(p) == false) {
            p = Paths.get("..").resolve(relativePath).normalize();
        }
        Assertions.assertTrue(Files.exists(p), "源码文件应存在: " + p.toAbsolutePath());
        return new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
    }

    /**
     * 抽取指定方法的完整方法体（含大括号配对）。
     *
     * <p>不能只切到「第一个 }」：方法体内有 for/if/try 嵌套，按大括号深度计数取配对收尾。</p>
     *
     * <p>正则用 {@code task\s*\(} 而非裸 {@code task}：{@code taskDo(} 里 "task" 后跟的是 'D'，
     * 不会被误命中；签名前缀不限定修饰符，因为 {@code task} 是 public 工具方法、
     * {@code formatBackgroundSubmission} 是 private。</p>
     */
    private static String extractMethodBody(String src, String methodName) {
        Matcher sig = Pattern.compile(
                "(?:public|private|protected)\\s+String\\s+" + Pattern.quote(methodName) + "\\s*\\(")
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
}
