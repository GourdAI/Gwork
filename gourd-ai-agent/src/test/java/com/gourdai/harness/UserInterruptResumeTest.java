package com.gourdai.harness;

import com.gourdai.agent.Agent;
import com.gourdai.agent.AgentSession;
import com.gourdai.agent.react.ReActAgent;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.session.InMemoryAgentSession;
import com.gourdai.ai.chat.message.ChatMessage;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 「用户取消后继续」续跑语义测试。
 *
 * <p>背景：用户点停止（interrupt）时执行流不经过库的异常兜底（abnormal 不置位），
 * 最终停在 route=END 但 abnormal=false——修复前，用户随后发「继续」会被判为新任务、
 * 断点工作记忆（推理 + 工具结果）被整体重置，重复消耗 token。修复后：取消时为
 * 未完成的任务打 {@link ReActTrace#EXTRA_USER_INTERRUPTED} 标记并立即落盘，
 * 「继续」与「异常中断续跑」行为完全对齐。</p>
 *
 * <p>本测试锁定三件事：canResume 判定扩展、取消打标入口（含源码护栏）、
 * 续跑消费（prepareResume 保留工作记忆并清除标记）。</p>
 */
class UserInterruptResumeTest {

    @TempDir
    Path temp;

    private HarnessEngine engine() {
        return HarnessEngine.of(temp.toString(), temp.resolve("home").toString()).build();
    }

    private static ReActTrace traceWithRoute(String route) {
        ReActTrace trace = new ReActTrace();
        trace.setRoute(route);
        return trace;
    }

    // ==================== 1. canResume 判定扩展 ====================

    @Test
    void canResumeWhenEndAndUserInterrupted() {
        HarnessEngine engine = engine();
        ReActTrace trace = traceWithRoute(Agent.ID_END);
        trace.markUserInterrupted();

        Assertions.assertTrue(engine.canResume(trace), "route=END + 用户中断标记应可续跑");
    }

    @Test
    void cannotResumeWhenEndWithoutAnyMark() {
        HarnessEngine engine = engine();

        Assertions.assertFalse(engine.canResume(traceWithRoute(Agent.ID_END)),
                "正常完成（无 abnormal / 无中断标记）不应自动续跑");
    }

    @Test
    void cannotResumeWhenRunningEvenIfMarked() {
        HarnessEngine engine = engine();
        ReActTrace trace = traceWithRoute(ReActAgent.ID_REASON);
        trace.markUserInterrupted();

        Assertions.assertFalse(engine.canResume(trace),
                "任务未停在 END 时不可续跑（执行流尚未收尾，避免与收尾流程竞争）");
    }

    @Test
    void canResumeWhenEndAndAbnormalStillWorks() {
        HarnessEngine engine = engine();
        ReActTrace trace = traceWithRoute(Agent.ID_END);
        // 单参重载 → abnormal=true（模型调用失败/超时等异常兜底）
        trace.setFinalAnswer("抱歉，模型服务调用失败：...。请稍后重试。");

        Assertions.assertTrue(engine.canResume(trace), "异常中断（abnormal）行为不得回归");
    }

    // ==================== 2. 取消打标入口 ====================

    @Test
    void markHelperMarksRunningTrace() {
        HarnessEngine engine = engine();
        AgentSession session = InMemoryAgentSession.of("interrupt-mark-1");
        ReActTrace trace = traceWithRoute(ReActAgent.ID_REASON);
        session.getContext().put("__main", trace);

        engine.markUserInterruptedForResume(session, null);

        Assertions.assertTrue(trace.isUserInterrupted(), "运行中的任务被取消后应打上可续跑标记");
    }

    @Test
    void markHelperSkipsEndedTrace() {
        HarnessEngine engine = engine();
        AgentSession session = InMemoryAgentSession.of("interrupt-mark-2");
        ReActTrace trace = traceWithRoute(Agent.ID_END);
        session.getContext().put("__main", trace);

        engine.markUserInterruptedForResume(session, null);

        Assertions.assertFalse(trace.isUserInterrupted(),
                "已结束的任务不应打标（正常完成后的新消息维持新任务语义）");
    }

    @Test
    void markHelperToleratesMissingTrace() {
        HarnessEngine engine = engine();
        AgentSession session = InMemoryAgentSession.of("interrupt-mark-3");

        Assertions.assertDoesNotThrow(() -> engine.markUserInterruptedForResume(session, null),
                "无 trace 时必须静默容错，不得影响停止主流程");
    }

    // ==================== 3. 续跑消费（端到端语义） ====================

    @Test
    void interruptedThenContinueKeepsWorkingMemory() {
        HarnessEngine engine = engine();
        AgentSession session = InMemoryAgentSession.of("interrupt-e2e");
        ReActTrace trace = traceWithRoute(ReActAgent.ID_REASON);
        session.getContext().put("__main", trace);

        // 断点工作记忆：含工具调用历史（模拟取消前的实际工作现场）
        trace.getWorkingMemory().addMessage(ChatMessage.ofUser("第一问"));
        trace.getWorkingMemory().addMessage(ChatMessage.ofTool("文件内容...", "read", "call-1"));
        session.addMessage(ChatMessage.ofUser("第一问"));

        // 1) 用户点停止（打标入口）
        engine.markUserInterruptedForResume(session, null);
        Assertions.assertTrue(trace.isUserInterrupted());

        // 2) 执行流收尾（取消后引擎自会停在 END；此处模拟收尾完成态）
        trace.setRoute(Agent.ID_END);
        session.addMessage(ChatMessage.ofAssistant("用户已取消任务."));

        // 3) 用户发「继续」→ 续跑判定必须通过（修复前此处为 false，工作记忆被重置）
        Assertions.assertTrue(engine.canResume(trace), "取消后「继续」应可续跑（旧行为：被判为新任务）");

        // 4) 续跑准备：保留断点工作记忆 + 追加新输入 + 消费标记 + 移除取消占位消息
        engine.prepareResume(trace, session, "继续", true);

        Assertions.assertFalse(trace.isUserInterrupted(), "续跑后标记应被消费清除");
        Assertions.assertEquals(ReActAgent.ID_REASON, trace.getRoute(), "续跑应回到思考节点");
        Assertions.assertEquals(3, trace.getWorkingMemory().getMessages().size(),
                "断点工作记忆（含工具历史）必须保留并追加新输入");
        Assertions.assertEquals("第一问", trace.getWorkingMemory().getMessages().get(0).getContent());
        Assertions.assertEquals("继续", trace.getWorkingMemory().getLastMessage().getContent());
        Assertions.assertEquals(2, session.getMessages().size(), "会话中「用户已取消任务.」占位应被移除");
        Assertions.assertEquals("继续", session.getMessages().get(1).getContent());
    }

    // ==================== 4. 源码护栏（三端接线） ====================

    @Test
    void portalsWireUserInterruptMarking() throws IOException {
        String webGate = readSource("gourd-ai-agent/src/main/java/com/gourdai/core/portal/web/WebGate.java");
        String wsGate = readSource("gourd-ai-agent/src/main/java/com/gourdai/core/portal/desktop/WsGate.java");
        String cliShell = readSource("gourd-ai-agent/src/main/java/com/gourdai/core/portal/cli/CliShell.java");
        String continueCmd = readSource("gourd-ai-agent/src/main/java/com/gourdai/core/command/builtin/ContinueCommand.java");

        // WebGate：主路径 + 兜底路径都要打标（两处）
        int webHits = webGate.split("markUserInterruptedForResume", -1).length - 1;
        Assertions.assertTrue(webHits >= 2,
                "WebGate 取消主路径与兜底路径都必须打「可续跑」标记，实际命中 " + webHits + " 处");
        Assertions.assertTrue(wsGate.contains("markUserInterruptedForResume"),
                "WsGate（桌面端）取消路径必须打「可续跑」标记");
        Assertions.assertTrue(cliShell.contains("markUserInterruptedForResume"),
                "CliShell 取消路径必须打「可续跑」标记");
        Assertions.assertTrue(continueCmd.contains("isUserInterrupted"),
                "/continue 必须把用户中断视为需移除兜底消息的续跑场景");
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
