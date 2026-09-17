package com.gourdai.agent.react;

import com.gourdai.agent.AgentSession;
import com.gourdai.agent.react.intercept.AskUser;
import com.gourdai.agent.react.intercept.AskUserTask;
import com.gourdai.agent.session.FileAgentSession;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.solon.ai.chat.message.AssistantMessage;
import org.noear.solon.ai.chat.message.ChatMessage;
import org.noear.solon.ai.chat.message.ToolMessage;
import org.noear.solon.ai.chat.tool.ToolCall;
import org.noear.solon.ai.chat.tool.ToolResult;

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
        return new AssistantMessage("", "", false, null, null, list, null);
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

    // ==================== 5. 接线护栏（源码形态断言） ====================

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
