package com.gourdai.agent.react;

import com.gourdai.agent.AgentSession;
import com.gourdai.agent.react.intercept.AskUser;
import com.gourdai.agent.react.intercept.AskUserTask;
import com.gourdai.agent.session.FileAgentSession;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import com.gourdai.ai.chat.message.AssistantMessage;
import com.gourdai.ai.chat.message.ChatMessage;
import com.gourdai.ai.chat.message.ToolMessage;
import com.gourdai.ai.chat.tool.ToolCall;
import com.gourdai.ai.chat.tool.ToolResult;

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
 * 原生工具调用配对自愈（ToolCallPairRepair）的运行时契约。
 *
 * <p>背景：工具调用挂起/中断（如 ask_user 等待回答）后，工作记忆可能残留「已声明但无结果」的
 * 工具调用；供应商接口会以 {@code 400 No tool output found for tool call ...} 拒绝整次请求
 * 且重试无法自愈。本测试锁定自愈器的四件事：补齐缺失结果、插入位置（配对连续）、
 * ask_user 答案回填与现场清理、幂等且健康流程恒为空操作。</p>
 */
class ToolCallPairRepairTest {

    // ==================== 基础设施 ====================

    private static AgentSession newSession() throws IOException {
        Path dir = Files.createTempDirectory("tool-pair-repair-test");
        return new FileAgentSession("tool-pair-sess", dir.toString());
    }

    private static ReActTrace newTrace(AgentSession session) {
        ReActTrace trace = new ReActTrace();
        trace.prepare(null, null, session, null, "tool-pair-repair-test");
        return trace;
    }

    // ToolCall(index, id, name, argumentsStr, arguments)
    private static ToolCall call(String id, String name) {
        return new ToolCall(id, id, name, "{}", new LinkedHashMap<>());
    }

    private static AssistantMessage callMessage(ToolCall... calls) {
        List<ToolCall> list = new ArrayList<>();
        for (ToolCall c : calls) {
            list.add(c);
        }
        // 4.1.1：raw 构造器已移除，工具调用消息改用 snapshot() 构造。
        return AssistantMessage.snapshot("", "", list, null, null, null, null);
    }

    private static ToolMessage resultMessage(String id, String name, String content) {
        return new ToolMessage(new ToolResult(content), name, id, false);
    }

    // ==================== 1. 健康流程为空操作 ====================

    @Test
    void healthyPairsAreUntouched() throws IOException {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        trace.getWorkingMemory().addMessage(callMessage(call("call-1", "read"), call("call-2", "read")));
        trace.getWorkingMemory().addMessage(resultMessage("call-1", "read", "A"));
        trace.getWorkingMemory().addMessage(resultMessage("call-2", "read", "B"));

        int repaired = ToolCallPairRepair.repair(trace);

        Assertions.assertEquals(0, repaired, "配对完整时不得改动");
        Assertions.assertEquals(3, trace.getWorkingMemory().getMessages().size(), "消息条数不得变化");
    }

    // ==================== 2. 核心场景：ask_user 挂起遗留 + 答案已提交 ====================

    @Test
    void suspendedAskUserWithAnswerIsBackfilledAdjacentAndKeysCleared() throws IOException {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        // 挂起现场：本批 [todowrite, ask_user]，todowrite 已完成并回灌，ask_user 无结果
        trace.getWorkingMemory().addMessage(callMessage(call("call-todo", "todowrite"), call("call-ask", "ask_user")));
        trace.getWorkingMemory().addMessage(resultMessage("call-todo", "todowrite", "TODO saved."));
        trace.getWorkingMemory().addMessage(ChatMessage.ofAssistant("等待用户回答"));

        // 用户已作答（挂起任务 + 答案键仍留在会话上下文）
        List<Map<String, Object>> questions = new ArrayList<>();
        Map<String, Object> q0 = new LinkedHashMap<>();
        q0.put("header", "采用哪个修复方式？");
        questions.add(q0);
        session.getContext().put(AskUser.TASK_KEY, new AskUserTask("ask_user", questions, "call-ask"));
        AskUser.submit(session, "{\"answers\":[{\"index\":0,\"text\":\"选方案A\",\"skipped\":false,\"custom\":false}]}");

        int repaired = ToolCallPairRepair.repair(trace);

        Assertions.assertEquals(1, repaired, "只补一条结果");
        List<ChatMessage> messages = trace.getWorkingMemory().getMessages();
        Assertions.assertEquals(4, messages.size());

        // 插入位置：紧跟在既有结果之后（配对连续），且不挪动尾随的「等待用户回答」
        Assertions.assertTrue(messages.get(2) instanceof ToolMessage, "结果须插入既有结果段之后");
        ToolMessage fixed = (ToolMessage) messages.get(2);
        Assertions.assertEquals("call-ask", fixed.getToolCallId());
        Assertions.assertEquals("ask_user", fixed.getName());
        Assertions.assertTrue(fixed.getContent().contains("采用哪个修复方式？"), "答案文本须带题面");
        Assertions.assertTrue(fixed.getContent().contains("选方案A"), "答案文本须含用户回答");
        Assertions.assertEquals("等待用户回答", messages.get(3).getContent(), "后续消息保持原相对顺序");

        // 现场清理：与拦截器 onObservation 同构（幂等，防止后续误判为“已恢复”）
        Assertions.assertNull(session.getContext().getAs(AskUser.TASK_KEY), "挂起任务必须清理");
        Assertions.assertNull(AskUser.getAnswer(session, "ask_user"), "答案键必须清理");
    }

    // ==================== 3. 无答案遗留：中断标记 + 插入在推理消息之后 ====================

    @Test
    void orphanWithoutAnswerGetsInterruptedMarkerRightAfterAssistant() throws IOException {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        trace.getWorkingMemory().addMessage(callMessage(call("call-bash", "bash")));
        trace.getWorkingMemory().addMessage(ChatMessage.ofAssistant("用户已取消任务."));

        int repaired = ToolCallPairRepair.repair(trace);

        Assertions.assertEquals(1, repaired);
        List<ChatMessage> messages = trace.getWorkingMemory().getMessages();
        Assertions.assertEquals(3, messages.size());
        Assertions.assertTrue(messages.get(1) instanceof ToolMessage, "无既有结果时插在推理消息之后");
        ToolMessage fixed = (ToolMessage) messages.get(1);
        Assertions.assertEquals("call-bash", fixed.getToolCallId());
        Assertions.assertTrue(fixed.getContent().contains("未执行完成"), "必须写明中断标记，避免模型把空结果当真实观测");
    }

    // ==================== 4. 幂等与多消息 ====================

    @Test
    void repairIsIdempotent() throws IOException {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);
        trace.getWorkingMemory().addMessage(callMessage(call("call-x", "read")));

        Assertions.assertEquals(1, ToolCallPairRepair.repair(trace));
        Assertions.assertEquals(0, ToolCallPairRepair.repair(trace), "二次执行必须为空操作");
        Assertions.assertEquals(2, trace.getWorkingMemory().getMessages().size());
    }

    @Test
    void repairsMultipleMessagesIndependently() throws IOException {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        trace.getWorkingMemory().addMessage(callMessage(call("call-a", "read")));
        trace.getWorkingMemory().addMessage(resultMessage("call-a", "read", "ok"));
        trace.getWorkingMemory().addMessage(ChatMessage.ofAssistant("继续"));
        trace.getWorkingMemory().addMessage(callMessage(call("call-b", "grep"), call("call-c", "glob")));

        Assertions.assertEquals(2, ToolCallPairRepair.repair(trace));

        List<ChatMessage> messages = trace.getWorkingMemory().getMessages();
        Assertions.assertEquals(6, messages.size());
        Assertions.assertTrue(messages.get(4) instanceof ToolMessage);
        Assertions.assertTrue(messages.get(5) instanceof ToolMessage);
        Assertions.assertEquals("call-b", ((ToolMessage) messages.get(4)).getToolCallId());
        Assertions.assertEquals("call-c", ((ToolMessage) messages.get(5)).getToolCallId());
    }

    @Test
    void nullTraceAndEmptyMemoryAreSafe() throws IOException {
        Assertions.assertEquals(0, ToolCallPairRepair.repair(null));
        ReActTrace trace = newTrace(newSession());
        Assertions.assertEquals(0, ToolCallPairRepair.repair(trace));
    }

    // ==================== 5. 答案归属：按 actionId 精确回填 ====================

    /**
     * 核心回归（缺陷 #5）：孤儿 A 排在前、被回答的 B 排在后（跨消息布局）。
     *
     * <p>旧实现按「遇到的第一个孤儿 ask_user 就填」，会把 B 的答案填给 A 并随即清掉答案键，
     * B 只能拿到「中断无输出」——用户白答一次，且模型拿到的是错位的语义。</p>
     */
    @Test
    void answerGoesToOwningCallNotTheFirstOrphanAcrossMessages() throws IOException {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        // 历史遗留的孤儿提问 A（上轮被中断，无结果）
        trace.getWorkingMemory().addMessage(callMessage(call("call-ask-OLD", "ask_user")));
        trace.getWorkingMemory().addMessage(ChatMessage.ofAssistant("上一轮被中断"));
        // 本轮真正发起并被回答的提问 B
        trace.getWorkingMemory().addMessage(callMessage(call("call-ask-NEW", "ask_user")));

        List<Map<String, Object>> questions = new ArrayList<>();
        Map<String, Object> q0 = new LinkedHashMap<>();
        q0.put("header", "采用哪个修复方式？");
        questions.add(q0);
        // 挂起任务明确归属于 B
        session.getContext().put(AskUser.TASK_KEY, new AskUserTask("ask_user", questions, "call-ask-NEW"));
        AskUser.submit(session, "{\"answers\":[{\"index\":0,\"text\":\"选方案A\",\"skipped\":false}]}");

        Assertions.assertEquals(2, ToolCallPairRepair.repair(trace), "两个孤儿调用都要补齐结果");

        ToolMessage forOld = findResult(trace, "call-ask-OLD");
        ToolMessage forNew = findResult(trace, "call-ask-NEW");
        Assertions.assertNotNull(forOld);
        Assertions.assertNotNull(forNew);

        Assertions.assertTrue(forNew.getContent().contains("选方案A"),
                "答案必须回填给产生它的调用 B");
        Assertions.assertEquals(ToolCallPairRepair.INTERRUPTED_MARKER, forOld.getContent(),
                "匹配不上的孤儿 A 只能拿中断标记，不得挪用别人的答案");
        Assertions.assertFalse(forOld.getContent().contains("选方案A"), "答案不得泄露给 A");

        // 现场清理仍由真正归属的那一次完成（幂等）
        Assertions.assertNull(session.getContext().getAs(AskUser.TASK_KEY), "挂起任务必须清理");
        Assertions.assertNull(AskUser.getAnswer(session, "ask_user"), "答案键必须清理");
    }

    /**
     * 同消息内布局：孤儿 A 与被回答的 B 在同一条 assistant 的 tool_calls 里，A 在前。
     */
    @Test
    void answerGoesToOwningCallNotTheFirstOrphanWithinOneMessage() throws IOException {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        trace.getWorkingMemory().addMessage(
                callMessage(call("call-ask-A", "ask_user"), call("call-ask-B", "ask_user")));

        List<Map<String, Object>> questions = new ArrayList<>();
        Map<String, Object> q0 = new LinkedHashMap<>();
        q0.put("header", "确认继续？");
        questions.add(q0);
        session.getContext().put(AskUser.TASK_KEY, new AskUserTask("ask_user", questions, "call-ask-B"));
        AskUser.submit(session, "{\"answers\":[{\"index\":0,\"text\":\"确认\",\"skipped\":false}]}");

        Assertions.assertEquals(2, ToolCallPairRepair.repair(trace));

        ToolMessage forA = findResult(trace, "call-ask-A");
        ToolMessage forB = findResult(trace, "call-ask-B");
        Assertions.assertEquals(ToolCallPairRepair.INTERRUPTED_MARKER, forA.getContent(),
                "同消息内的前置孤儿同样不得截胡答案");
        Assertions.assertTrue(forB.getContent().contains("确认"), "答案归 call-ask-B");
    }

    /**
     * 降级口 1：挂起任务无 actionId（字段新增前落盘的旧快照）时，保持修复前行为：
     * 交给首个孤儿 ask_user。否则用户的回答会凭空消失。
     */
    @Test
    void legacyTaskWithoutActionIdFallsBackToFirstOrphan() throws IOException {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        trace.getWorkingMemory().addMessage(callMessage(call("call-ask-1", "ask_user")));

        List<Map<String, Object>> questions = new ArrayList<>();
        Map<String, Object> q0 = new LinkedHashMap<>();
        q0.put("header", "旧快照提问");
        questions.add(q0);
        // actionId 传 null：模拟本字段新增前落盘的挂起任务
        session.getContext().put(AskUser.TASK_KEY, new AskUserTask("ask_user", questions, null));
        AskUser.submit(session, "{\"answers\":[{\"index\":0,\"text\":\"旧答案\",\"skipped\":false}]}");

        Assertions.assertEquals(1, ToolCallPairRepair.repair(trace));

        ToolMessage fixed = findResult(trace, "call-ask-1");
        Assertions.assertTrue(fixed.getContent().contains("旧答案"),
                "无归属信息可用时必须降级回填，不能让用户白答一次");
    }

    /**
     * 降级口 2：挂起任务完全丢失（只剩答案键）时同样降级回填。
     */
    @Test
    void missingTaskFallsBackToFirstOrphan() throws IOException {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        trace.getWorkingMemory().addMessage(callMessage(call("call-ask-x", "ask_user")));
        AskUser.submit(session, "{\"answers\":[{\"index\":0,\"text\":\"无题面答案\",\"skipped\":false}]}");

        Assertions.assertEquals(1, ToolCallPairRepair.repair(trace));

        ToolMessage fixed = findResult(trace, "call-ask-x");
        Assertions.assertTrue(fixed.getContent().contains("无题面答案"),
                "题面丢失时走裸列降级渲染，仍不得丢答案");
    }

    /**
     * 归属调用根本不在工作记忆里（已被压缩掉）：孤儿一律给中断标记，
     * 且答案键与挂起任务必须原封不动——留给后续真正属于它的调用。
     */
    @Test
    void unmatchedOrphanKeepsAnswerForItsRealOwner() throws IOException {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        trace.getWorkingMemory().addMessage(callMessage(call("call-ask-STALE", "ask_user")));

        List<Map<String, Object>> questions = new ArrayList<>();
        Map<String, Object> q0 = new LinkedHashMap<>();
        q0.put("header", "归属于另一次调用");
        questions.add(q0);
        session.getContext().put(AskUser.TASK_KEY, new AskUserTask("ask_user", questions, "call-ask-ELSEWHERE"));
        AskUser.submit(session, "{\"answers\":[{\"index\":0,\"text\":\"不得被挪用\",\"skipped\":false}]}");

        Assertions.assertEquals(1, ToolCallPairRepair.repair(trace));

        ToolMessage fixed = findResult(trace, "call-ask-STALE");
        Assertions.assertEquals(ToolCallPairRepair.INTERRUPTED_MARKER, fixed.getContent());
        Assertions.assertNotNull(session.getContext().getAs(AskUser.TASK_KEY),
                "未匹配时不得清掉挂起任务（要留给真正归属的调用）");
        Assertions.assertNotNull(AskUser.getAnswer(session, "ask_user"),
                "未匹配时不得清掉答案键，否则用户白答一次");
    }

    /** 非 ask_user 的孤儿调用永远只给中断标记，不受答案存在与否影响。 */
    @Test
    void nonAskUserOrphanNeverTakesAnswer() throws IOException {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        trace.getWorkingMemory().addMessage(callMessage(call("call-write", "write"), call("call-ask", "ask_user")));

        List<Map<String, Object>> questions = new ArrayList<>();
        Map<String, Object> q0 = new LinkedHashMap<>();
        q0.put("header", "确认写入？");
        questions.add(q0);
        session.getContext().put(AskUser.TASK_KEY, new AskUserTask("ask_user", questions, "call-ask"));
        AskUser.submit(session, "{\"answers\":[{\"index\":0,\"text\":\"确认写入\",\"skipped\":false}]}");

        Assertions.assertEquals(2, ToolCallPairRepair.repair(trace));

        Assertions.assertEquals(ToolCallPairRepair.INTERRUPTED_MARKER,
                findResult(trace, "call-write").getContent(), "write 不得拿到问答答案");
        Assertions.assertTrue(findResult(trace, "call-ask").getContent().contains("确认写入"));
    }

    /** 按 toolCallId 找回填结果；找不到返回 null。 */
    private static ToolMessage findResult(ReActTrace trace, String toolCallId) {
        for (ChatMessage message : trace.getWorkingMemory().getMessages()) {
            if (message instanceof ToolMessage
                    && toolCallId.equals(((ToolMessage) message).getToolCallId())) {
                return (ToolMessage) message;
            }
        }
        return null;
    }

    // ==================== 6. 接线护栏（源码形态断言） ====================

    @Test
    void sourceWiringGuards() throws IOException {
        String actionTask = readSource("gourd-ai-agent/src/main/java/com/gourdai/agent/react/task/ActionTask.java");
        Assertions.assertTrue(actionTask.contains("trace.setRoute(ReActAgent.ID_ACTION)"),
                "工具挂起必须把恢复入口改到动作节点（先回放补齐结果，再进入推理）");
        Assertions.assertTrue(actionTask.contains("collectCommittedToolIds"),
                "恢复回放必须跳过挂起前已完成调用（防止副作用重放与重复配对）");
        Assertions.assertTrue(actionTask.contains("appendResultsAfterCommitted"),
                "回放新结果必须就近补插，保持 tool_calls 与结果段连续");
        Assertions.assertTrue(actionTask.contains("PENDING_BATCH_ID_KEY"),
                "回放必须复用批次声明 id（避免重复建容器）");
        Assertions.assertTrue(actionTask.contains("PENDING_TEXT_ACTION_KEYS"),
                "文本模式挂起恢复同样必须跳过已执行动作（防写工具二次副作用）");
        Assertions.assertTrue(actionTask.contains("takeCommittedTextActionKeys"),
                "文本模式指纹必须「读取即清」，不得泄漏到后续回合");

        String askUserInterceptor = readSource(
                "gourd-ai-agent/src/main/java/com/gourdai/agent/react/intercept/AskUserInterceptor.java");
        Assertions.assertTrue(askUserInterceptor.contains("hasRenderableQuestion"),
                "空题面必须在挂起前被拦下（否则会话永久卡死）");
        Assertions.assertTrue(
                askUserInterceptor.indexOf("hasRenderableQuestion(questions)")
                        < askUserInterceptor.indexOf("pending(true"),
                "合法性判定必须早于 pending——一旦挂起就再无补救落点");

        String pairRepair = readSource(
                "gourd-ai-agent/src/main/java/com/gourdai/agent/react/ToolCallPairRepair.java");
        Assertions.assertTrue(pairRepair.contains("ownsAnswer"),
                "答案必须按 actionId 精确回填，不得按「首个孤儿」挪用");

        String reasonTask = readSource("gourd-ai-agent/src/main/java/com/gourdai/agent/react/task/ReasonTask.java");
        Assertions.assertTrue(reasonTask.contains("ToolCallPairRepair.repair(trace)"),
                "推理前必须执行配对自愈（发送前最后一道协议归一）");
    }

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
