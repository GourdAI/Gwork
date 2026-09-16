package com.gourdai.agent.react.intercept;

import com.gourdai.agent.Agent;
import com.gourdai.agent.AgentSession;
import com.gourdai.agent.react.ReActAgent;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.task.ToolExchanger;
import com.gourdai.agent.session.FileAgentSession;
import com.gourdai.agent.util.AskUserTool;
import com.gourdai.core.portal.web.WebChunk;
import com.gourdai.harness.agent.WebToolVisibilityPolicy;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.tool.FunctionTool;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * ask_user 结构化问答「挂起-恢复」协议运行时契约。
 *
 * <p>背景：Agent 需要用户提供关键信息时调用 ask_user 工具，任务挂起；
 * 用户在 Web 界面回答后，答案作为工具结果回填并自动恢复执行。
 * 本测试锁定三件事：拦截器的挂起/恢复语义、答案格式化的容错行为、
 * 以及 Web 帧与注册链路的接线形态（源码护栏）。</p>
 *
 * <p>与 {@code HitlActionIdPairingTest} 互补：那边锁 HITL（bash 审批）骨架，
 * 这边锁 ask_user 镜像骨架——两者共用 ToolExchanger/actionId/挂起恢复机制，
 * 任何一侧回归都会在对应测试中当场暴露。</p>
 */
class AskUserProtocolTest {

    // ==================== 基础设施 ====================

    /** 每个用例独立一个临时目录会话，避免用例间状态串味。 */
    private static AgentSession newSession() throws IOException {
        Path dir = Files.createTempDirectory("ask-user-test");
        return new FileAgentSession("ask-user-sess", dir.toString());
    }

    /**
     * ReActTrace 没有公开的 session 绑定入口（prepare 为 protected），
     * 用测试子类暴露，模拟库内真实的 prepare 生命周期（顺带清一次挂起状态）。
     */
    private static class TestTrace extends ReActTrace {
        void bind(AgentSession session) {
            prepare(null, null, session, null, "ask-user-test");
        }
    }

    private static Map<String, Object> questionMap(String header, String detail) {
        Map<String, Object> question = new LinkedHashMap<>();
        question.put("header", header);
        if (detail != null) {
            question.put("detail", detail);
        }
        return question;
    }

    private static String answersJson(int index, String text, boolean skipped, boolean custom) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("index", index);
        item.put("text", text);
        item.put("skipped", skipped);
        item.put("custom", custom);

        Map<String, Object> root = new LinkedHashMap<>();
        root.put("answers", List.of(item));
        return ONode.serialize(root);
    }

    // ==================== 1. 工具定义契约 ====================

    @Test
    void toolDefinitionMatchesFrozenContract() throws Throwable {
        FunctionTool tool = AskUserTool.getTool();

        Assertions.assertEquals("ask_user", tool.name());
        Assertions.assertEquals(AskUserTool.TOOL_NAME, tool.name());

        // 描述逐字冻结：前端契约、使用纪律都写在这段文案里，改一个字都要有意识
        Assertions.assertEquals(
                "当任务需要用户提供关键信息、做出选择或确认时，向用户发起结构化提问并等待回答。支持提供候选项（可标记推荐）；用户可点击选项、自由输入或跳过。任务将挂起，直到用户回答后自动恢复。使用纪律：1) 仅在确实需要用户输入才能继续时使用（能自行查询/推断的信息不要问）；2) 多个问题必须在一次调用中成组提出；3) 若有明确最佳实践，请对相应选项标记 recommended=true。",
                tool.description());

        // questions 参数必须产出嵌套 JSON Schema（header 必填 / detail/options 可选 / label 必填 / recommended 可选）
        ONode schema = ONode.ofJson(tool.inputSchema());
        Assertions.assertEquals("object", schema.get("type").getString());
        Assertions.assertTrue(schema.get("required").getArray().stream()
                .anyMatch(n -> "questions".equals(n.getString())), "questions 必须为必填参数");

        ONode questionItem = schema.get("properties").get("questions").get("items");
        ONode itemProps = questionItem.get("properties");
        Assertions.assertEquals("string", itemProps.get("header").get("type").getString());
        Assertions.assertEquals("string", itemProps.get("detail").get("type").getString());
        Assertions.assertTrue(questionItem.get("required").getArray().stream()
                .anyMatch(n -> "header".equals(n.getString())), "header 必须为必填字段");
        Assertions.assertFalse(questionItem.get("required").getArray().stream()
                .anyMatch(n -> "detail".equals(n.getString())), "detail 必须为可选字段");

        ONode optionItem = itemProps.get("options").get("items");
        Assertions.assertEquals("string", optionItem.get("properties").get("label").get("type").getString());
        Assertions.assertEquals("boolean", optionItem.get("properties").get("recommended").get("type").getString());
        Assertions.assertTrue(optionItem.get("required").getArray().stream()
                .anyMatch(n -> "label".equals(n.getString())), "label 必须为必填字段");

        // 工具函数体：正常情况下被拦截器在 onAction 短路，永不执行；兜底返回值按 FeedbackTool 挂起语义
        Object suspended = tool.handle(new LinkedHashMap<>());
        Assertions.assertTrue(String.valueOf(suspended).contains("\"status\":\"suspended\""));
    }

    // ==================== 2. 挂起 ====================

    @Test
    void onActionWithoutAnswerSuspendsTask() throws IOException {
        AgentSession session = newSession();
        TestTrace trace = new TestTrace();
        trace.bind(session);

        Map<String, Object> args = new LinkedHashMap<>();
        args.put("questions", List.of(questionMap("部署到哪个环境？", "可选 dev/staging/prod")));

        new AskUserInterceptor().onAction(trace, new ToolExchanger("ask_user", args, "call-1"));

        Assertions.assertTrue(session.isPending(), "无答案时必须挂起会话");
        Assertions.assertEquals(AskUser.PENDING_REASON, session.getPendingReason(), "挂起原因必须为等待用户回答");
        Assertions.assertEquals(AskUser.PENDING_REASON, trace.getFinalAnswer(), "挂起时 finalAnswer 必须为等待文案");

        AskUserTask pending = AskUser.getPendingTask(session);
        Assertions.assertNotNull(pending, "挂起任务必须写入 TASK_KEY");
        Assertions.assertSame(pending, session.getContext().getAs(AskUser.TASK_KEY), "挂起任务必须落在 TASK_KEY 上");
        Assertions.assertEquals("ask_user", pending.getToolName());
        Assertions.assertEquals("call-1", pending.getActionId(), "actionId 必须透传，供前端与骨架卡配对");
        Assertions.assertEquals(1, pending.getQuestions().size());
        Assertions.assertEquals("部署到哪个环境？", pending.getQuestions().get(0).get("header"));

        // 不得越界触碰 HITL 的地盘
        Assertions.assertNull(session.getContext().getAs(HITL.LAST_INTERVENED));
    }

    // ==================== 3. 恢复 ====================

    @Test
    void onActionWithAnswerFillsResultWithoutExecution() throws IOException {
        AgentSession session = newSession();
        TestTrace trace = new TestTrace();
        trace.bind(session);

        Map<String, Object> args = new LinkedHashMap<>();
        args.put("questions", List.of(questionMap("部署到哪个环境？", null)));

        AskUserInterceptor interceptor = new AskUserInterceptor();

        // 第一次调用：挂起
        interceptor.onAction(trace, new ToolExchanger("ask_user", args, "call-1"));
        Assertions.assertTrue(session.isPending());

        // 用户在 Web 界面提交答案（WebGate 侧的动作放大到最小等价形态）
        AskUser.submit(session, answersJson(0, "staging", false, true));

        // 第二次调用：模拟任务恢复后重新执行到同一次工具调用
        ToolExchanger resume = new ToolExchanger("ask_user", args, "call-1");
        interceptor.onAction(trace, resume);

        String result = resume.getResult();
        Assertions.assertNotNull(result, "恢复时必须回填答案文本作为工具结果（不执行真实工具）");
        Assertions.assertTrue(result.contains("部署到哪个环境？"), "结果必须包含问题文本");
        Assertions.assertTrue(result.contains("staging"), "结果必须包含用户答案");

        Assertions.assertNull(session.getContext().getAs(AskUser.TASK_KEY), "恢复时 TASK_KEY 必须移除");

        // 恢复分支不得把路由压成 END（否则模型拿不到 Observation 就直接结束了）
        Assertions.assertNotEquals(Agent.ID_END, trace.getRoute());
        Assertions.assertEquals(ReActAgent.ID_REASON, trace.getRoute());
    }

    @Test
    void resumeFallsBackToCallArgsWhenTaskMissing() throws IOException {
        AgentSession session = newSession();
        TestTrace trace = new TestTrace();
        trace.bind(session);

        Map<String, Object> args = new LinkedHashMap<>();
        args.put("questions", List.of(questionMap("回退问题", null)));

        // 旧快照恢复：TASK_KEY 缺失但答案已提交 —— 必须从本次调用参数回退取 questions
        session.getContext().put(AskUser.ANSWER_PREFIX + "ask_user", answersJson(0, "答案X", false, false));

        ToolExchanger exchanger = new ToolExchanger("ask_user", args, "call-2");
        new AskUserInterceptor().onAction(trace, exchanger);

        Assertions.assertNotNull(exchanger.getResult());
        Assertions.assertTrue(exchanger.getResult().contains("回退问题"), "缺挂起任务时必须回退到调用参数的 questions");
        Assertions.assertTrue(exchanger.getResult().contains("答案X"));
    }

    /**
     * 题面彻底丢失（旧快照 + 本次调用参数也没带 questions）时，绝不能把用户的回答吞掉——
     * 那等于模型拿到一个空观察后继续盲跑，用户白答一次。
     */
    @Test
    void formatAnswerTextKeepsAnswersWhenQuestionsMissing() {
        Map<String, Object> first = new LinkedHashMap<>();
        first.put("index", 0);
        first.put("text", "staging");
        first.put("skipped", false);
        first.put("custom", true);

        Map<String, Object> second = new LinkedHashMap<>();
        second.put("index", 1);
        second.put("text", "");
        second.put("skipped", true);
        second.put("custom", false);

        Map<String, Object> root = new LinkedHashMap<>();
        root.put("answers", List.of(first, second));
        String answersJson = ONode.serialize(root);

        // null 题面：按 answers 自身顺序裸列
        String nullText = AskUser.formatAnswerText(null, answersJson);
        Assertions.assertEquals("用户对提问的回答如下：\n1. staging\n2. （用户跳过）\n", nullText);

        // 空列表题面：同上（而非只回一行头部说明）
        String emptyText = AskUser.formatAnswerText(new ArrayList<>(), answersJson);
        Assertions.assertEquals(nullText, emptyText);
        Assertions.assertTrue(emptyText.contains("staging"), "题面缺失时仍必须保留用户答案");
    }

    /**
     * onObservation 只得清理 ask_user 自己的现场：TASK_KEY 是全局单键，若对任意工具都清，
     * 同轮并行的邻居工具会把刚写入的挂起任务抹掉（挂起还在、任务实体没了→前端永远收不到 question 帧）。
     */
    @Test
    void onObservationOfOtherToolMustNotWipePendingTask() throws IOException {
        AgentSession session = newSession();
        TestTrace trace = new TestTrace();
        trace.bind(session);

        Map<String, Object> args = new LinkedHashMap<>();
        args.put("questions", List.of(questionMap("Q", null)));

        AskUserInterceptor interceptor = new AskUserInterceptor();
        interceptor.onAction(trace, new ToolExchanger("ask_user", args, "call-1"));
        Assertions.assertNotNull(AskUser.getPendingTask(session), "前置：挂起任务已写入");

        // 邻居工具的观察回调（并行只读段/同轮多调用）
        interceptor.onObservation(trace, new ToolExchanger("read", Map.of("file_path", "a.txt"), "call-2"),
                null, null, 1L);

        Assertions.assertNotNull(AskUser.getPendingTask(session), "其它工具的 onObservation 不得清掉 ask_user 挂起任务");
        Assertions.assertTrue(session.isPending(), "挂起状态应保持");
    }

    // ==================== 4. 闭环清理 ====================

    @Test
    void onObservationCleansBothKeysIdempotently() throws IOException {
        AgentSession session = newSession();
        TestTrace trace = new TestTrace();
        trace.bind(session);

        Map<String, Object> args = new LinkedHashMap<>();
        args.put("questions", List.of(questionMap("Q", null)));

        AskUserInterceptor interceptor = new AskUserInterceptor();
        interceptor.onAction(trace, new ToolExchanger("ask_user", args, "call-1"));
        AskUser.submit(session, answersJson(0, "A", false, false));

        interceptor.onObservation(trace, new ToolExchanger("ask_user", args, "call-1"), null, null, 1L);

        Assertions.assertNull(session.getContext().getAs(AskUser.TASK_KEY), "观察后 TASK_KEY 必须清理");
        Assertions.assertNull(AskUser.getAnswer(session, "ask_user"), "观察后答案键必须清理");

        // 重复调用必须幂等（不抛异常、状态不变）
        interceptor.onObservation(trace, new ToolExchanger("ask_user", args, "call-1"), null, null, 1L);
        Assertions.assertNull(session.getContext().getAs(AskUser.TASK_KEY));
        Assertions.assertNull(AskUser.getAnswer(session, "ask_user"));
    }

    // ==================== 5. JSON 往返 ====================

    @Test
    void askUserTaskSurvivesJsonRoundTripAndToleratesLegacySnapshot() {
        Map<String, Object> option = new LinkedHashMap<>();
        option.put("label", "dev");
        option.put("recommended", true);

        Map<String, Object> question = new LinkedHashMap<>();
        question.put("header", "Q1");
        question.put("options", List.of(option));

        List<Map<String, Object>> questions = new ArrayList<>();
        questions.add(question);

        AskUserTask origin = new AskUserTask("ask_user", questions, "call-9", 123L);

        String json = ONode.serialize(origin);
        Assertions.assertTrue(json.contains("call-9"), "序列化结果应含 actionId，否则快照恢复后配对信息丢失");

        AskUserTask back = ONode.ofJson(json).toBean(AskUserTask.class);
        Assertions.assertEquals("ask_user", back.getToolName());
        Assertions.assertEquals("call-9", back.getActionId());
        Assertions.assertEquals(123L, back.getCreatedAt());
        Assertions.assertEquals(1, back.getQuestions().size());
        Assertions.assertEquals("Q1", back.getQuestions().get(0).get("header"));

        // 旧快照：JSON 里根本没有 questions/actionId/createdAt 这些键 —— 不得炸
        AskUserTask legacy = ONode.ofJson("{\"toolName\":\"ask_user\"}").toBean(AskUserTask.class);
        Assertions.assertEquals("ask_user", legacy.getToolName());
        Assertions.assertNull(legacy.getQuestions(), "旧快照缺字段应为 null，消费方走回退路径");
        Assertions.assertNull(legacy.getActionId());
        Assertions.assertEquals(0L, legacy.getCreatedAt());
    }

    // ==================== 6. 答案格式化 ====================

    @Test
    void formatAnswerTextRendersQuestionsSkippedAndCustom() {
        List<Map<String, Object>> questions = new ArrayList<>();
        questions.add(questionMap("部署到哪个环境？", "可选 dev/staging/prod"));
        questions.add(questionMap("是否启用灰度？", null));

        Map<String, Object> first = new LinkedHashMap<>();
        first.put("index", 0);
        first.put("text", "staging");
        first.put("skipped", false);
        first.put("custom", true); // 用户自由输入而非点选选项：文本照常呈现

        Map<String, Object> second = new LinkedHashMap<>();
        second.put("index", 1);
        second.put("text", "");
        second.put("skipped", true);
        second.put("custom", false);

        Map<String, Object> root = new LinkedHashMap<>();
        root.put("answers", List.of(first, second));

        String text = AskUser.formatAnswerText(questions, ONode.serialize(root));

        Assertions.assertEquals(
                "用户对提问的回答如下：\n"
                        + "1. 部署到哪个环境？（可选 dev/staging/prod）\n"
                        + "   → staging\n"
                        + "2. 是否启用灰度？\n"
                        + "   → （用户跳过）\n",
                text);
    }

    @Test
    void formatAnswerTextIgnoresOutOfRangeAndToleratesBadJson() {
        List<Map<String, Object>> questions = List.of(questionMap("唯一问题", null));

        // index 越界（5）忽略；该题没有有效回答 → 按跳过呈现
        String text = AskUser.formatAnswerText(questions, "{\"answers\":[{\"index\":5,\"text\":\"越界\"}]}");
        Assertions.assertEquals("用户对提问的回答如下：\n1. 唯一问题\n   → （用户跳过）\n", text);

        // 坏 JSON → 原文透传
        String broken = "{oops";
        Assertions.assertEquals(broken, AskUser.formatAnswerText(questions, broken));
        Assertions.assertEquals("plain text", AskUser.formatAnswerText(questions, "plain text"));

        // 结构不符（根非对象 / 缺 answers）→ 原文透传
        Assertions.assertEquals("[1,2,3]", AskUser.formatAnswerText(questions, "[1,2,3]"));
        Assertions.assertEquals("{\"foo\":1}", AskUser.formatAnswerText(questions, "{\"foo\":1}"));
    }

    @Test
    void parseAnswersToleratesBadJson() {
        List<Map<String, Object>> ok = AskUser.parseAnswers("{\"answers\":[{\"index\":0,\"text\":\"x\"}]}");
        Assertions.assertEquals(1, ok.size());
        Assertions.assertEquals("x", ok.get(0).get("text"));

        Assertions.assertTrue(AskUser.parseAnswers("{broken").isEmpty());
        Assertions.assertTrue(AskUser.parseAnswers(null).isEmpty());
        Assertions.assertTrue(AskUser.parseAnswers("{\"foo\":1}").isEmpty());
    }

    // ==================== 7. 帧线格式 ====================

    @Test
    void questionFramesSerializeToFrozenWireFormat() {
        Map<String, Object> option = new LinkedHashMap<>();
        option.put("label", "dev");
        option.put("recommended", true);

        Map<String, Object> question = new LinkedHashMap<>();
        question.put("header", "部署到哪个环境？");
        question.put("options", List.of(option));

        List<Map<String, Object>> questions = List.of(question);
        WebChunk chunk = WebChunk.ofQuestion("ask_user", questions, "call-7");

        Assertions.assertEquals("question", chunk.getType());
        Assertions.assertEquals("question", WebChunk.PHASE_QUESTION);
        Assertions.assertEquals("ask_user", chunk.getToolName());
        Assertions.assertEquals("call-7", chunk.getActionId());
        Assertions.assertEquals(questions, chunk.getArgs().get("questions"));

        ONode json = ONode.ofJson(ONode.serialize(chunk));
        Assertions.assertEquals("question", json.get("type").getString());
        Assertions.assertEquals("ask_user", json.get("toolName").getString());
        Assertions.assertEquals("call-7", json.get("actionId").getString());
        Assertions.assertTrue(json.get("args").get("questions").isArray());
        Assertions.assertEquals("部署到哪个环境？",
                json.get("args").get("questions").getArray().get(0).get("header").getString());

        WebChunk answered = WebChunk.ofQuestionAnswered("ask_user", AskUser.parseAnswers(
                "{\"answers\":[{\"index\":0,\"text\":\"staging\",\"skipped\":false,\"custom\":true}]}"));

        Assertions.assertEquals("question_answered", answered.getType());
        Assertions.assertEquals("ask_user", answered.getToolName());

        ONode answeredJson = ONode.ofJson(ONode.serialize(answered));
        Assertions.assertEquals("question_answered", answeredJson.get("type").getString());
        Assertions.assertEquals("ask_user", answeredJson.get("toolName").getString());
        Assertions.assertTrue(answeredJson.get("args").get("answers").isArray());
        Assertions.assertEquals("staging",
                answeredJson.get("args").get("answers").getArray().get(0).get("text").getString());
    }

    // ==================== 8. 可见性 ====================

    @Test
    void visibilityPolicyExcludesAskUser() {
        // ask_user 走专用 question 帧交互，生命周期帧（start/draft/args/end）一律不建工具卡
        Assertions.assertFalse(WebToolVisibilityPolicy.isBaseVisible("ask_user"));
        Assertions.assertFalse(WebToolVisibilityPolicy.isStartVisible("ask_user"));
        Assertions.assertFalse(WebToolVisibilityPolicy.isFailedEndVisible("ask_user"));

        // 不得误伤邻居
        Assertions.assertTrue(WebToolVisibilityPolicy.isBaseVisible("read"));
        Assertions.assertTrue(WebToolVisibilityPolicy.isBaseVisible("bash"));
        Assertions.assertTrue(WebToolVisibilityPolicy.isBaseVisible("hitl"));
    }

    // ==================== 9. 接线护栏（源码形态断言） ====================

    @Test
    void sourceWiringGuards() throws IOException {
        String streamBuilder = readSource("gourd-ai-agent/src/main/java/com/gourdai/core/portal/web/WebStreamBuilder.java");
        Assertions.assertTrue(streamBuilder.contains("AskUser.getPendingTask(session)"), "流尾必须检测 ask_user 挂起任务");
        Assertions.assertTrue(streamBuilder.contains("WebChunk.ofQuestion("), "流尾必须下发 question 帧");
        Assertions.assertTrue(streamBuilder.contains("WebChunk.PHASE_QUESTION"), "question 帧必须携带 PHASE_QUESTION 相位");
        Assertions.assertTrue(streamBuilder.contains("HITL.isHitl(session)"), "HITL 检查必须保持在前（互斥且优先）");

        String webGate = readSource("gourd-ai-agent/src/main/java/com/gourdai/core/portal/web/WebGate.java");
        Assertions.assertTrue(webGate.contains("String questionAnswer"), "WebGate 签名链必须包含 questionAnswer");
        Assertions.assertTrue(webGate.contains("AskUser.submit(session, questionAnswer)"), "WebGate 必须提交答案");
        Assertions.assertTrue(webGate.contains("WebChunk.ofQuestionAnswered("), "WebGate 必须下发 question_answered 帧");
        Assertions.assertTrue(webGate.contains("Assert.isEmpty(questionAnswer) && isSessionBusy(session)"),
                "busy 检查必须放行 questionAnswer 恢复请求");
        // 无挂起任务时也必须回帧 + 补 done：否则前端卡片永久停在“已提交”态、等待指示器不停
        int answeredIdx = webGate.indexOf("WebChunk.ofQuestionAnswered(");
        int taskNullIdx = webGate.indexOf("if (task == null) {", answeredIdx);
        Assertions.assertTrue(answeredIdx > 0 && taskNullIdx > answeredIdx,
                "answered 帧必须无条件下发（早于 task==null 分支），避免卡片永久滞留");
        Assertions.assertTrue(webGate.indexOf("WebChunk.ofDone()", taskNullIdx) > taskNullIdx,
                "无挂起任务时必须补 done 帧收口，不得空走一次 run");

        String webController = readSource("gourd-ai-agent/src/main/java/com/gourdai/core/portal/web/WebController.java");
        Assertions.assertTrue(webController.contains("ctx.param(\"questionAnswer\")"), "控制器必须读取 questionAnswer 参数");

        String factory = readSource("gourd-ai-agent/src/main/java/com/gourdai/harness/agent/AgentFactory.java");
        Assertions.assertTrue(factory.contains("\"ask_user\""), "TOOL_ALL_FULL 必须包含 ask_user");
        Assertions.assertTrue(factory.contains("case \"ask_user\""), "switch 必须包含 ask_user 分支");
        Assertions.assertTrue(factory.contains("engine.getAskUserInterceptor()"), "必须装配 askUserInterceptor");

        String engine = readSource("gourd-ai-agent/src/main/java/com/gourdai/harness/HarnessEngine.java");
        Assertions.assertTrue(engine.contains("new AskUserInterceptor()"), "引擎必须默认创建 askUserInterceptor");
        Assertions.assertTrue(engine.contains("getAskUserInterceptor()"), "引擎必须暴露 getter");

        String options = readSource("gourd-ai-agent/src/main/java/com/gourdai/harness/HarnessOptions.java");
        Assertions.assertTrue(options.contains("askUserInterceptor"), "HarnessOptions 必须持有 askUserInterceptor");

        String policy = readSource("gourd-ai-agent/src/main/java/com/gourdai/harness/agent/WebToolVisibilityPolicy.java");
        Assertions.assertTrue(policy.contains("AskUserTool.TOOL_NAME"), "可见性策略必须排除 ask_user");
    }

    // ==================== 10. 会话上下文存取 ====================

    @Test
    void answerRoundTripInSessionContext() throws IOException {
        AgentSession session = newSession();

        // 预置挂起任务（模拟挂起发生后）
        session.getContext().put(AskUser.TASK_KEY, new AskUserTask("ask_user", List.of(), "call-10"));
        AskUser.submit(session, "{\"answers\":[]}");

        Assertions.assertEquals("{\"answers\":[]}", AskUser.getAnswer(session, "ask_user"));
        Assertions.assertEquals("{\"answers\":[]}", session.getContext().getAs(AskUser.ANSWER_PREFIX + "ask_user"));

        AskUser.clear(session, "ask_user");
        Assertions.assertNull(AskUser.getAnswer(session, "ask_user"));

        // clear 幂等
        AskUser.clear(session, "ask_user");
        Assertions.assertNull(AskUser.getAnswer(session, "ask_user"));

        // 无挂起任务时 submit 按工具名常量兜底（旧快照/异常场景）
        session.getContext().remove(AskUser.TASK_KEY);
        AskUser.submit(session, answersJson(0, "兜底", false, false));
        Assertions.assertTrue(AskUser.getAnswer(session, "ask_user").contains("兜底"));
    }

    // ==================== 附加：拦截器不越界 ====================

    @Test
    void interceptorIgnoresOtherTools() throws IOException {
        AgentSession session = newSession();
        TestTrace trace = new TestTrace();
        trace.bind(session);

        ToolExchanger exchanger = new ToolExchanger("bash", Map.of("command", "ls"), "call-x");
        new AskUserInterceptor().onAction(trace, exchanger);

        Assertions.assertFalse(session.isPending(), "非 ask_user 工具不得触发挂起");
        Assertions.assertNull(exchanger.getResult(), "非 ask_user 工具不得被回填结果");
        Assertions.assertNull(AskUser.getPendingTask(session));
    }

    // ==================== 工具方法 ====================

    private static String readSource(String relativePath) throws IOException {
        Path path = Paths.get(relativePath);
        if (!Files.exists(path)) {
            // 兼容以模块目录为工作目录运行的场景
            path = Paths.get("..").resolve(relativePath).normalize();
        }
        Assertions.assertTrue(Files.exists(path), "源码文件必须存在: " + relativePath);
        return new String(Files.readAllBytes(path), StandardCharsets.UTF_8);
    }
}
