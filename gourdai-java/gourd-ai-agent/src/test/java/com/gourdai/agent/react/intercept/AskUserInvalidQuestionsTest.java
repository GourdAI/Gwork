package com.gourdai.agent.react.intercept;

import com.gourdai.agent.AgentSession;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.task.ToolExchanger;
import com.gourdai.agent.session.FileAgentSession;
import com.gourdai.agent.util.AskUserTool;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * ask_user 非法参数「绝不挂起」的运行时契约。
 *
 * <p>背景（缺陷 #3）：题面为空时前端会隐藏问答卡，用户看不到也点不到回答入口；
 * 而拦截器旧实现仍然 {@code session.pending(true, ...)} 挂起任务等待回答 →
 * 后台无限死等 + 无人可答 = 会话永久卡死，只能重启会话解开。</p>
 *
 * <p>本测试锁定三件事：非法参数不挂起、返回对模型可读的错误结果、合法参数照常挂起（不误伤）。</p>
 */
class AskUserInvalidQuestionsTest {

    // ==================== 基础设施 ====================

    private static AgentSession newSession() throws IOException {
        Path dir = Files.createTempDirectory("ask-user-invalid-test");
        return new FileAgentSession("ask-user-invalid-sess", dir.toString());
    }

    private static ReActTrace newTrace(AgentSession session) throws Exception {
        ReActTrace trace = new ReActTrace();
        // prepare 为 protected：测试与 ToolCallPairRepairTest 同包不可行（跨包），故反射调用
        Method prepare = ReActTrace.class.getDeclaredMethod("prepare",
                com.gourdai.agent.react.ReActAgentConfig.class,
                com.gourdai.agent.react.ReActOptions.class,
                AgentSession.class,
                com.gourdai.agent.team.TeamProtocol.class,
                String.class);
        prepare.setAccessible(true);
        prepare.invoke(trace, null, null, session, null, "ask-user-invalid-test");
        return trace;
    }

    private static Map<String, Object> question(String header) {
        Map<String, Object> q = new LinkedHashMap<>();
        q.put("header", header);
        return q;
    }

    private static Map<String, Object> argsOf(Object questions) {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("questions", questions);
        return args;
    }

    /** 跑一次 onAction，返回交换器以便断言结果。 */
    private static ToolExchanger runAction(ReActTrace trace, Map<String, Object> args) {
        ToolExchanger exchanger = new ToolExchanger(AskUserTool.TOOL_NAME, args, "call-ask-1");
        new AskUserInterceptor().onAction(trace, exchanger);
        return exchanger;
    }

    /** 非法参数的统一断言：不挂起、无挂起任务残留、返回可读错误。 */
    private static void assertRejectedWithoutPending(ReActTrace trace, ToolExchanger exchanger, String scene) {
        Assertions.assertFalse(trace.getSession().isPending(),
                "参数非法必须不挂起，否则会话永久卡死（场景：" + scene + "）");
        Assertions.assertNull(AskUser.getPendingTask(trace.getSession()),
                "非法参数不得留下挂起任务实体（场景：" + scene + "）");
        Assertions.assertNotNull(exchanger.getResult(),
                "必须回交模型一个结果，否则模型收不到任何反馈（场景：" + scene + "）");
        Assertions.assertTrue(exchanger.getResult().startsWith("__ERROR__"),
                "错误结果须沿用 __ERROR__ 口径（与 ActionTask#executeTool 一致），场景：" + scene);
        Assertions.assertTrue(exchanger.getResult().contains("questions"),
                "错误文案须点明是 questions 参数的问题（场景：" + scene + "）");
    }

    // ==================== 1. 非法参数：绝不挂起 ====================

    @Test
    void emptyQuestionsArrayDoesNotPend() throws Exception {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        ToolExchanger exchanger = runAction(trace, argsOf(new ArrayList<>()));

        assertRejectedWithoutPending(trace, exchanger, "questions 为空数组");
    }

    @Test
    void missingQuestionsKeyDoesNotPend() throws Exception {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        ToolExchanger exchanger = runAction(trace, new LinkedHashMap<>());

        assertRejectedWithoutPending(trace, exchanger, "完全没传 questions");
    }

    @Test
    void nonListQuestionsDoesNotPend() throws Exception {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        // 模型偶发把 questions 写成字符串 / 对象，extractQuestions 会归一成 null
        ToolExchanger exchanger = runAction(trace, argsOf("请选择一个方案"));

        assertRejectedWithoutPending(trace, exchanger, "questions 不是数组");
    }

    @Test
    void allBlankHeadersDoesNotPend() throws Exception {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        // 题面全为空白：前端渲染不出来，等同于空卡
        ToolExchanger exchanger = runAction(trace,
                argsOf(Arrays.asList(question(""), question("   "), question(null))));

        assertRejectedWithoutPending(trace, exchanger, "所有 header 均为空白");
    }

    @Test
    void emptyQuestionObjectsDoNotPend() throws Exception {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        // 条目是对象但压根没有 header 键
        ToolExchanger exchanger = runAction(trace,
                argsOf(Collections.singletonList(new LinkedHashMap<String, Object>())));

        assertRejectedWithoutPending(trace, exchanger, "条目缺 header 键");
    }

    @Test
    void nonMapItemsDoNotPend() throws Exception {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        // 条目非对象：extractQuestions 会全部丢弃 → 归一后为空列表
        ToolExchanger exchanger = runAction(trace, argsOf(Arrays.asList("A", "B")));

        assertRejectedWithoutPending(trace, exchanger, "条目均非对象");
    }

    // ==================== 2. 合法参数：照常挂起（不得误伤） ====================

    @Test
    void validQuestionStillPends() throws Exception {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        ToolExchanger exchanger = runAction(trace,
                argsOf(Collections.singletonList(question("采用哪个修复方式？"))));

        Assertions.assertTrue(session.isPending(), "合法提问必须照常挂起，等待用户回答");
        Assertions.assertEquals(AskUser.PENDING_REASON, session.getPendingReason());
        Assertions.assertNull(exchanger.getResult(), "挂起路径不得回填工具结果");

        AskUserTask task = AskUser.getPendingTask(session);
        Assertions.assertNotNull(task, "挂起必须留下任务实体，否则前端收不到 question 帧");
        Assertions.assertEquals("call-ask-1", task.getActionId(), "挂起任务须记录归属 actionId");
        Assertions.assertEquals(1, task.getQuestions().size());
    }

    /**
     * 部分题面为空不算非法：只要有一条能渲染，用户就有回答入口。
     *
     * <p>口径是「宁可少拦，也不能把合法提问误判成非法」——误判会让本可挂起的提问直接失败。</p>
     */
    @Test
    void partiallyBlankHeadersStillPend() throws Exception {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        List<Map<String, Object>> questions = Arrays.asList(question("  "), question("真正的问题"));
        ToolExchanger exchanger = runAction(trace, argsOf(questions));

        Assertions.assertTrue(session.isPending(), "存在可渲染题面时必须照常挂起");
        Assertions.assertNull(exchanger.getResult());
        Assertions.assertNotNull(AskUser.getPendingTask(session));
    }

    // ==================== 3. 其它工具不受影响 ====================

    @Test
    void otherToolsAreUntouched() throws Exception {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        ToolExchanger exchanger = new ToolExchanger("bash", argsOf(new ArrayList<>()), "call-bash");
        new AskUserInterceptor().onAction(trace, exchanger);

        Assertions.assertFalse(session.isPending(), "非 ask_user 工具一律放行");
        Assertions.assertNull(exchanger.getResult(), "非 ask_user 工具不得被写入结果");
    }

    // ==================== 4. 已有答案时的恢复路径不受影响 ====================

    @Test
    void answerBackfillStillWorksWhenArgsAreEmpty() throws Exception {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        // 恢复场景：挂起任务里有题面，本次调用参数的 questions 不参与合法性判定
        session.getContext().put(AskUser.TASK_KEY,
                new AskUserTask(AskUserTool.TOOL_NAME,
                        Collections.singletonList(question("采用哪个修复方式？")), "call-ask-1"));
        AskUser.submit(session, "{\"answers\":[{\"index\":0,\"text\":\"选方案A\",\"skipped\":false}]}");

        ToolExchanger exchanger = runAction(trace, argsOf(new ArrayList<>()));

        Assertions.assertFalse(session.isPending(), "已有答案时不得再次挂起");
        Assertions.assertNotNull(exchanger.getResult());
        Assertions.assertFalse(exchanger.getResult().startsWith("__ERROR__"),
                "有答案的恢复路径必须走答案回填，不能被非法参数分支截胡");
        Assertions.assertTrue(exchanger.getResult().contains("选方案A"), "答案文本须含用户回答");
    }
}
