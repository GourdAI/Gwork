package com.gourdai.agent.react.task;

import com.gourdai.agent.AgentSession;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.session.FileAgentSession;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 文本工具模式（STRUCTURED_TEXT）挂起恢复「已执行就不重跑」的运行时契约。
 *
 * <p>背景（缺陷 #8）：原生工具模式此前已用 {@code collectCommittedToolIds} + {@code intersectsCommitted}
 * 做过回放跳过；文本模式当时有意没改（无原生 id、语义不同），结果挂起恢复仍会重跑已执行的工具
 * （写工具二次副作用）。</p>
 *
 * <p><b>文本模式与原生模式的机制差异</b>：原生模式能从工作记忆里反推「谁已完成」（已回灌的 ToolMessage
 * 带 toolCallId）；文本模式挂起时直接 {@code return}，而写工作记忆的语句在方法末尾，
 * 故已完成兄弟动作的结果<b>根本没落盘</b>，无从反推。因此改为在挂起那一刻主动记账。</p>
 *
 * <p><b>为何测私有静态助手而非端到端跑 ActionTask</b>：{@code doAction} 需要真实 ChatModel/工具注册表，
 * 端到端构造成本极高且引入网络依赖。幂等键的全部语义（键的构成、读取即清、命中即消费、
 * 仅挂起才记账）都集中在这三个纯函数里，直接锁住它们即可覆盖行为契约；
 * 接线是否真的调用了它们，由 {@code ToolCallPairRepairTest#sourceWiringGuards} 的源码形态断言护住。</p>
 */
class TextModeActionIdempotencyTest {

    // ==================== 基础设施 ====================

    private static AgentSession newSession() throws IOException {
        Path dir = Files.createTempDirectory("text-mode-idempotency-test");
        return new FileAgentSession("text-mode-sess", dir.toString());
    }

    private static ReActTrace newTrace(AgentSession session) throws Exception {
        ReActTrace trace = new ReActTrace();
        Method prepare = ReActTrace.class.getDeclaredMethod("prepare",
                com.gourdai.agent.react.ReActAgentConfig.class,
                com.gourdai.agent.react.ReActOptions.class,
                AgentSession.class,
                com.gourdai.agent.team.TeamProtocol.class,
                String.class);
        prepare.setAccessible(true);
        prepare.invoke(trace, null, null, session, null, "text-mode-idempotency-test");
        return trace;
    }

    @SuppressWarnings("unchecked")
    private static String textActionKey(String toolName, Map<String, Object> args) throws Exception {
        Method m = ActionTask.class.getDeclaredMethod("textActionKey", String.class, Map.class);
        m.setAccessible(true);
        return (String) m.invoke(null, toolName, args);
    }

    @SuppressWarnings("unchecked")
    private static Set<String> takeCommitted(ReActTrace trace) throws Exception {
        Method m = ActionTask.class.getDeclaredMethod("takeCommittedTextActionKeys", ReActTrace.class);
        m.setAccessible(true);
        return (Set<String>) m.invoke(null, trace);
    }

    private static void remember(ReActTrace trace, List<String> keys) throws Exception {
        Method m = ActionTask.class.getDeclaredMethod("rememberCommittedTextActionKeys",
                ReActTrace.class, List.class);
        m.setAccessible(true);
        m.invoke(null, trace, keys);
    }

    private static Map<String, Object> args(String key, Object value) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put(key, value);
        return map;
    }

    // ==================== 1. 幂等键的构成：工具名 + 参数 ====================

    @Test
    void keyIsStableForSameToolAndArgs() throws Exception {
        String a = textActionKey("write", args("file_path", "a.txt"));
        String b = textActionKey("write", args("file_path", "a.txt"));

        Assertions.assertNotNull(a);
        Assertions.assertEquals(a, b, "同名同参必须产出同一指纹，否则跳过永远不会命中");
    }

    @Test
    void keyDiffersByToolName() throws Exception {
        Assertions.assertNotEquals(
                textActionKey("write", args("file_path", "a.txt")),
                textActionKey("edit", args("file_path", "a.txt")),
                "不同工具必须是不同指纹，否则会误跳过本该执行的工具");
    }

    @Test
    void keyDiffersByArgs() throws Exception {
        Assertions.assertNotEquals(
                textActionKey("write", args("file_path", "a.txt")),
                textActionKey("write", args("file_path", "b.txt")),
                "参数不同即是不同副作用，必须各自执行");
    }

    @Test
    void nullOrBlankToolNameYieldsNoKey() throws Exception {
        Assertions.assertNull(textActionKey(null, args("x", "y")), "工具名缺失时放弃指纹，退化为修复前行为");
        Assertions.assertNull(textActionKey("", args("x", "y")));
    }

    @Test
    void nullArgsAreTreatedAsEmpty() throws Exception {
        Assertions.assertEquals(
                textActionKey("ls", null),
                textActionKey("ls", new LinkedHashMap<>()),
                "无参与空参是同一次调用");
    }

    // ==================== 2. 记账：只在真正挂起时写入 ====================

    @Test
    void keysAreRememberedOnlyWhenPending() throws Exception {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        List<String> keys = new ArrayList<>(Arrays.asList(
                textActionKey("write", args("file_path", "a.txt"))));

        // 未挂起（如 END 路由 / feedback 终止）：不得记账，否则会泄漏成后续回合的脏数据
        remember(trace, keys);
        Assertions.assertTrue(takeCommitted(trace).isEmpty(), "未挂起时不得留下指纹");

        // 真正挂起：必须记账
        session.pending(true, "等待用户回答");
        remember(trace, keys);
        Assertions.assertEquals(1, takeCommitted(trace).size(), "挂起时必须记下已执行动作");
    }

    @Test
    void emptyExecutedListClearsInsteadOfWritingBlank() throws Exception {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);
        session.pending(true, "等待用户回答");

        // 第一个动作就挂起（前面没有已执行的兄弟）：不应留下空账
        remember(trace, new ArrayList<>());
        Assertions.assertTrue(takeCommitted(trace).isEmpty(), "无已执行动作时不得留下空指纹集");
    }

    @Test
    void nullKeysAreFilteredOut() throws Exception {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);
        session.pending(true, "等待用户回答");

        List<String> keys = new ArrayList<>();
        keys.add(null); // 指纹构建失败的动作
        keys.add(textActionKey("write", args("file_path", "a.txt")));

        remember(trace, keys);
        Set<String> committed = takeCommitted(trace);
        Assertions.assertEquals(1, committed.size(), "null 指纹必须被滤掉，不得污染跳过判定");
        Assertions.assertFalse(committed.contains(null));
    }

    // ==================== 3. 读取即清：只保护紧接着的那一次回放 ====================

    @Test
    void committedKeysAreConsumedOnceAndDoNotLeakToLaterTurns() throws Exception {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);
        session.pending(true, "等待用户回答");

        String key = textActionKey("bash", args("command", "npm run build"));
        remember(trace, new ArrayList<>(Arrays.asList(key)));

        // 第一次回放：拿得到 → 跳过重跑
        Set<String> firstReplay = takeCommitted(trace);
        Assertions.assertTrue(firstReplay.contains(key), "紧接着的回放必须能跳过已执行动作");

        // 第二次（后续回合）：必须为空 —— 否则模型日后真心想再跑同一条命令会被永久屏蔽
        Assertions.assertTrue(takeCommitted(trace).isEmpty(),
                "指纹必须读取即清，绝不能泄漏到后续回合造成误跳过");
    }

    /**
     * 同一轮里出现两个同名同参动作时，指纹只能抵消一个，第二个仍照常执行。
     *
     * <p>这正是「宁可漏跳过一次重跑，也不能误跳过本该执行的工具」的具体体现：
     * 用 {@code Set#remove} 的返回值做消费判定，而非只读的 {@code contains}。</p>
     */
    @Test
    void oneKeyCancelsOnlyOneOccurrence() throws Exception {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);
        session.pending(true, "等待用户回答");

        String key = textActionKey("write", args("file_path", "a.txt"));
        remember(trace, new ArrayList<>(Arrays.asList(key)));

        Set<String> committed = takeCommitted(trace);
        Assertions.assertTrue(committed.remove(key), "第一次出现：命中并消费 → 跳过");
        Assertions.assertFalse(committed.remove(key), "第二次出现：指纹已被消费 → 必须照常执行");
    }

    @Test
    void unrelatedActionIsNeverSkipped() throws Exception {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);
        session.pending(true, "等待用户回答");

        remember(trace, new ArrayList<>(Arrays.asList(
                textActionKey("write", args("file_path", "a.txt")))));

        Set<String> committed = takeCommitted(trace);
        Assertions.assertFalse(
                committed.remove(textActionKey("write", args("file_path", "OTHER.txt"))),
                "参数不同的动作绝不能被误跳过");
        Assertions.assertFalse(
                committed.remove(textActionKey("bash", args("file_path", "a.txt"))),
                "工具不同的动作绝不能被误跳过");
    }

    @Test
    void emptyStateIsSafe() throws Exception {
        AgentSession session = newSession();
        ReActTrace trace = newTrace(session);

        // 健康流程（从未挂起过）：恒为空集，行为与修复前完全等价
        Assertions.assertNotNull(takeCommitted(trace));
        Assertions.assertTrue(takeCommitted(trace).isEmpty());
    }

    // ==================== 4. 接线护栏（源码形态断言） ====================

    /**
     * 跳过时必须补一条 Observation 交代，否则模型看不到任何反馈会换个写法再试一遍，
     * 副作用照样发生（指纹却因参数变了而失效），防护归零。
     */
    @Test
    void skipPathMustReportBackToModel() throws IOException {
        String source = readSource(
                "gourd-ai-agent/src/main/java/com/gourdai/agent/react/task/ActionTask.java");

        Assertions.assertTrue(source.contains("TEXT_ACTION_ALREADY_EXECUTED"),
                "跳过路径必须有明确的交代文案");
        Assertions.assertTrue(source.contains("Observation: \" + TEXT_ACTION_ALREADY_EXECUTED"),
                "交代必须以 Observation 形式回灌（文本模式的观测载体是 user 消息）");
        Assertions.assertTrue(source.contains("committedActionKeys.remove(actionKey)"),
                "必须用 remove 的返回值做消费判定（同一轮重复动作只抵消一次）");
        Assertions.assertTrue(source.contains("rememberCommittedTextActionKeys(trace, executedActionKeys)"),
                "挂起返回前必须记账，否则下次回放无从跳过");
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
