package com.gourdai.agent.react.intercept;

import com.gourdai.agent.AgentSession;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.task.ToolExchanger;
import com.gourdai.agent.session.FileAgentSession;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 问答卡「点击发送后无限闪烁」的回归护栏。
 *
 * <p><b>真实事故</b>：用户在 question 帧到达前（实测相差 524ms）抢先发了一条普通消息，
 * 该消息走正常输入路径。新一轮任务把会话挂起态重置并正常跑到 END，但<b>没有任何一处清理
 * 挂起任务实体</b>，于是留下「实体还在、会话却已不挂起」的僵尸组合。而每轮结束时只要看到
 * 实体就会重发 question 帧 → 一张题面早已过时的僵尸卡凭空冒出来；用户点它 → 恢复轮因路由
 * 停在 END 而空转（0 token、十几毫秒）→ 拦截器一次都不执行 → 现场永不清理 → 再次重发
 * question → 卡片收了又建，表现为无限闪烁且永不自愈（只能换会话）。</p>
 *
 * <p>本测试锁定三条独立不变量，对应三层缺陷：</p>
 * <ul>
 * <li><b>A</b> {@link AskUser#discardPending} 必须能把僵尸现场清干净并交出 actionId（供通知前端收卡）；</li>
 * <li><b>B</b> {@link AskUser#isResumable} 必须区分「真挂起」与「僵尸实体」——它是不重发提问的唯一判据；</li>
 * <li><b>C</b> 答案归属：残留答案绝不能被下一次真实提问当成本次回答（幽灵答案）。</li>
 * </ul>
 */
class AskUserStaleTaskLoopTest {

    private static AgentSession newSession() throws IOException {
        Path dir = Files.createTempDirectory("ask-user-stale-test");
        return new FileAgentSession("ask-user-stale-sess", dir.toString());
    }

    /** ReActTrace.prepare 是 protected，用测试子类暴露，模拟库内真实生命周期（含挂起态重置）。 */
    private static class TestTrace extends ReActTrace {
        void bind(AgentSession session) {
            prepare(null, null, session, null, "ask-user-stale-test");
        }
    }

    private static Map<String, Object> argsWith(String header) {
        Map<String, Object> question = new LinkedHashMap<>();
        question.put("header", header);

        Map<String, Object> args = new LinkedHashMap<>();
        args.put("questions", List.of(question));
        return args;
    }

    private static String answersJson(String text, boolean skipped) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("index", 0);
        item.put("text", text);
        item.put("skipped", skipped);
        item.put("custom", false);

        Map<String, Object> root = new LinkedHashMap<>();
        root.put("answers", List.of(item));
        return ONode.serialize(root);
    }

    // ==================== A. 僵尸挂起任务的清理 ====================

    /**
     * 复现事故的核心状态：挂起任务实体在，但会话已被新一轮任务重置为「不挂起」。
     * 这正是快照里 {@code stopped=false} 与 {@code _ask_user_task_} 并存的那一刻。
     */
    @Test
    void staleTaskIsNotResumableWhenSessionNoLongerPending() throws IOException {
        AgentSession session = newSession();
        TestTrace trace = new TestTrace();
        trace.bind(session);

        new AskUserInterceptor().onAction(trace, new ToolExchanger("ask_user", argsWith("选哪个方案？"), "call-A"));
        Assertions.assertTrue(session.isPending(), "首次调用必须挂起会话");
        Assertions.assertTrue(AskUser.isResumable(session), "真挂起状态下必须判定为可恢复");

        // 用户抢在 question 帧之前发了普通消息 → 新一轮任务 prepare 重置挂起态（实体仍残留）
        TestTrace nextRun = new TestTrace();
        nextRun.bind(session);

        Assertions.assertFalse(session.isPending(), "新一轮任务必须已重置会话挂起态");
        Assertions.assertNotNull(AskUser.getPendingTask(session), "缺陷前提：挂起任务实体确实残留（无人清理）");
        Assertions.assertFalse(AskUser.isResumable(session),
                "僵尸实体不得被判为可恢复——否则恢复轮空转，问答卡将无限闪烁");
    }

    @Test
    void discardPendingClearsSiteAndReturnsActionIdForCardDismissal() throws IOException {
        AgentSession session = newSession();
        TestTrace trace = new TestTrace();
        trace.bind(session);

        new AskUserInterceptor().onAction(trace, new ToolExchanger("ask_user", argsWith("补到什么范围？"), "call-STALE"));
        AskUser.submit(session, answersJson("只补专用入口", false));

        AskUserTask discarded = AskUser.discardPending(session);

        Assertions.assertNotNull(discarded, "必须交回被清理的任务实体");
        Assertions.assertEquals("call-STALE", discarded.getActionId(),
                "必须交出 actionId：前端据此只收那一道题的卡，不误清用户正在作答的另一张卡");
        Assertions.assertNull(AskUser.getPendingTask(session), "挂起任务实体必须清除");
        Assertions.assertNull(AskUser.getAnswer(session, "ask_user"), "答案必须一并清除，否则变成幽灵答案");
        Assertions.assertFalse(AskUser.isResumable(session), "清理后不得再被判为可恢复");
    }

    /** 幂等：重复清理不得抛异常，也不得凭空造出任务实体。 */
    @Test
    void discardPendingIsIdempotent() throws IOException {
        AgentSession session = newSession();

        Assertions.assertNull(AskUser.discardPending(session), "本无挂起任务时返回 null");
        Assertions.assertNull(AskUser.discardPending(session));
        Assertions.assertNull(AskUser.getPendingTask(session));
    }

    // ==================== B. 答案是否值得再跑一轮 ====================

    @Test
    void meaningfulAnswerDistinguishesRealReplyFromDismissal() {
        Assertions.assertTrue(AskUser.hasMeaningfulAnswer(answersJson("只补专用入口", false)),
                "用户确实作答 → 必须发起新一轮，回答不能白答");
        Assertions.assertFalse(AskUser.hasMeaningfulAnswer(answersJson("", true)),
                "用户跳过（关卡）→ 不应再烧一轮 token");
        Assertions.assertFalse(AskUser.hasMeaningfulAnswer(answersJson("", false)),
                "文本为空等同于未作答");
        Assertions.assertFalse(AskUser.hasMeaningfulAnswer("{不是合法JSON"), "坏 JSON 一律视为无内容");
        Assertions.assertFalse(AskUser.hasMeaningfulAnswer(null));
        Assertions.assertFalse(AskUser.hasMeaningfulAnswer("{\"answers\":[]}"));
    }

    // ==================== C. 幽灵答案（答案归属校验） ====================

    /**
     * 最隐蔽的一层：残留答案会让下一次<b>真实</b>提问直接走「已有答案」分支，
     * 把上一次的旧答案当成本次回答回填给模型，用户连卡片都看不到。
     */
    @Test
    void strayAnswerFromAnotherQuestionMustNotBeConsumed() throws IOException {
        AgentSession session = newSession();
        TestTrace trace = new TestTrace();
        trace.bind(session);

        // 上一道题（call-OLD）的答案残留在会话里，但它的挂起任务已经消失
        new AskUserInterceptor().onAction(trace, new ToolExchanger("ask_user", argsWith("旧问题"), "call-OLD"));
        AskUser.submit(session, answersJson("旧答案", false));
        session.getContext().remove(AskUser.TASK_KEY);

        // 模型真的发起了新一次提问（call-NEW）
        TestTrace newRun = new TestTrace();
        newRun.bind(session);
        ToolExchanger fresh = new ToolExchanger("ask_user", argsWith("全新问题"), "call-NEW");
        new AskUserInterceptor().onAction(newRun, fresh);

        Assertions.assertNull(fresh.getResult(),
                "旧答案不得被当成新问题的回答回填——否则用户根本看不到卡片就被替作了答");
        Assertions.assertTrue(session.isPending(), "新提问必须正常挂起，等待用户真正作答");

        AskUserTask pending = AskUser.getPendingTask(session);
        Assertions.assertNotNull(pending, "必须为新问题登记挂起任务");
        Assertions.assertEquals("call-NEW", pending.getActionId());
        Assertions.assertNull(AskUser.getAnswer(session, "ask_user"), "不归属的旧答案必须被丢弃，不得继续污染");
    }

    /** 归属相符时必须照常恢复——归属校验不能把正常链路一并拦死。 */
    @Test
    void answerIsConsumedWhenOwnershipMatches() throws IOException {
        AgentSession session = newSession();
        TestTrace trace = new TestTrace();
        trace.bind(session);

        Map<String, Object> args = argsWith("部署到哪个环境？");
        AskUserInterceptor interceptor = new AskUserInterceptor();

        interceptor.onAction(trace, new ToolExchanger("ask_user", args, "call-SAME"));
        AskUser.submit(session, answersJson("staging", false));

        ToolExchanger resume = new ToolExchanger("ask_user", args, "call-SAME");
        interceptor.onAction(trace, resume);

        Assertions.assertNotNull(resume.getResult(), "同一次调用的答案必须被正常消费");
        Assertions.assertTrue(resume.getResult().contains("staging"));
        Assertions.assertNull(AskUser.getPendingTask(session), "恢复后挂起任务必须清除");
    }

    /**
     * 向后兼容：旧快照/旧版本提交的答案没有归属标识，此时必须放行（宁可保守，也不让用户白答）。
     */
    @Test
    void legacyAnswerWithoutOwnerIsStillAccepted() throws IOException {
        AgentSession session = newSession();
        TestTrace trace = new TestTrace();
        trace.bind(session);

        // 只写答案键，不写归属键 —— 模拟字段新增前落盘的数据
        session.getContext().put(AskUser.ANSWER_PREFIX + "ask_user", answersJson("历史答案", false));

        ToolExchanger exchanger = new ToolExchanger("ask_user", argsWith("兼容问题"), "call-LEGACY");
        new AskUserInterceptor().onAction(trace, exchanger);

        Assertions.assertNotNull(exchanger.getResult(), "无归属标识的旧答案必须降级放行");
        Assertions.assertTrue(exchanger.getResult().contains("历史答案"));
    }

    /** onObservation 必须把答案与归属标识一起清掉：漏清归属会让下一份答案背上旧标识而被误判丢弃。 */
    @Test
    void observationClearsAnswerAndOwnerTogether() throws IOException {
        AgentSession session = newSession();
        TestTrace trace = new TestTrace();
        trace.bind(session);

        Map<String, Object> args = argsWith("问题");
        AskUserInterceptor interceptor = new AskUserInterceptor();
        interceptor.onAction(trace, new ToolExchanger("ask_user", args, "call-OBS"));
        AskUser.submit(session, answersJson("答案", false));

        ToolExchanger exchanger = new ToolExchanger("ask_user", args, "call-OBS");
        interceptor.onAction(trace, exchanger);
        interceptor.onObservation(trace, exchanger, null, null, 1L);

        Assertions.assertNull(session.getContext().getAs(AskUser.TASK_KEY));
        Assertions.assertNull(session.getContext().getAs(AskUser.ANSWER_PREFIX + "ask_user"));
        Assertions.assertNull(session.getContext().getAs(AskUser.ANSWER_OWNER_PREFIX + "ask_user"),
                "归属标识与答案同生同灭，不得残留");

        // 现场干净后，下一次全新提问必须能正常挂起（而非被残留状态短路）
        TestTrace nextRun = new TestTrace();
        nextRun.bind(session);
        ToolExchanger next = new ToolExchanger("ask_user", argsWith("下一个问题"), "call-NEXT");
        interceptor.onAction(nextRun, next);

        Assertions.assertNull(next.getResult(), "清理彻底时新提问不得被旧答案短路");
        Assertions.assertTrue(AskUser.isResumable(session), "新提问必须处于可恢复的真挂起状态");
    }

    /**
     * 配对修复通道（ToolCallPairRepair）回填答案后，必须连带清掉归属键。
     *
     * <p>它曾手写 {@code remove(ANSWER_PREFIX + toolName)} 而漏掉归属键，留下的孤儿归属会让
     * <b>下一份答案背上旧归属</b>：若那时挂起任务丢失（submit 取不到 actionId 不写新归属），
     * 旧归属便会被 {@link AskUser#ownsAnswer} 当成本次的凭据与真实调用 id 比对而判不归属，
     * 用户刚提交的答案被静默丢弃、提问被重新挂起。</p>
     */
    @Test
    void staleOwnerKeyMustNotSurviveAnswerCleanup() throws IOException {
        AgentSession session = newSession();

        // 模拟配对修复通道回填后的清理（与 ToolCallPairRepair 同口径）
        AskUser.submit(session, answersJson("旧答案", false), "call-OLD");
        Assertions.assertEquals("call-OLD",
                session.getContext().getAs(AskUser.ANSWER_OWNER_PREFIX + "ask_user"));

        session.getContext().remove(AskUser.TASK_KEY);
        AskUser.clear(session, "ask_user");

        Assertions.assertNull(session.getContext().getAs(AskUser.ANSWER_OWNER_PREFIX + "ask_user"),
                "回填后归属键必须随答案一同消失，否则成为孤儿归属");

        // 孤儿归属的危害面：挂起任务丢失时 submit 不写新归属，旧归属会被当成本次凭据
        AskUser.submit(session, answersJson("新答案", false));
        Assertions.assertTrue(AskUser.ownsAnswer(session, "ask_user", "call-NEW"),
                "归属键已清干净时，新答案应按兼容口径放行，不得被旧归属误判丢弃");
    }
}
