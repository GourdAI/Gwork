package com.gourdai.agent.react.intercept;

import org.junit.jupiter.api.Test;
import org.noear.solon.ai.chat.message.AssistantMessage;
import org.noear.solon.ai.chat.message.ChatMessage;
import org.noear.solon.ai.chat.message.ToolMessage;
import org.noear.solon.ai.chat.tool.ToolCall;
import org.noear.solon.ai.chat.tool.ToolResult;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 免费清理层（工具结果置空）的安全性回归测试。
 *
 * <p>这一层直接改写发给模型的消息体，一旦出错就是 400 报错或工具白跑，
 * 故对「不变式」逐条加锁：配对完整性、轮边界、副作用工具、不可重现句柄。</p>
 */
class ToolResultSweepTest {

    @SuppressWarnings("unchecked")
    private static List<ChatMessage> sweep(ContextCompressionInterceptor it, List<ChatMessage> msgs) throws Exception {
        Method m = ContextCompressionInterceptor.class.getDeclaredMethod(
                "sweepStaleToolResults", List.class, int.class, int.class, String.class);
        m.setAccessible(true);
        return (List<ChatMessage>) m.invoke(it, msgs, 1, 0, null);
    }

    private static AssistantMessage callOf(String... ids) {
        List<ToolCall> calls = new ArrayList<>();
        for (String id : ids) {
            // ToolCall(uuid, index, name, argumentsStr, arguments)
            calls.add(new ToolCall(id, null, "read", "{}", new LinkedHashMap<>()));
        }
        // 4.1：AssistantMessage 改为 text/thinking 双通道，构造签名新增 thinking 位
        return new AssistantMessage("", "", false, null, null, calls, null);
    }

    private static ToolMessage resultOf(String id, String tool, String content) {
        return new ToolMessage(new ToolResult(content), tool, id, false);
    }

    private static String big(String prefix) {
        StringBuilder sb = new StringBuilder(prefix);
        while (sb.length() < 600) {
            sb.append("0123456789abcdef");
        }
        return sb.toString();
    }

    /** 构造一段足够长的历史，确保保护线之前有可清理的余量。 */
    private static List<ChatMessage> historyWith(List<ChatMessage> tail) {
        List<ChatMessage> msgs = new ArrayList<>();
        for (int i = 0; i < 40; i++) {
            msgs.add(callOf("old-" + i));
            msgs.add(resultOf("old-" + i, "read", big("old" + i)));
        }
        msgs.addAll(tail);
        return msgs;
    }

    @Test
    void clearedResultKeepsPairingIdentityAndIsNeverEmpty() throws Exception {
        ContextCompressionInterceptor it = new ContextCompressionInterceptor();
        List<ChatMessage> swept = sweep(it, historyWith(new ArrayList<>()));

        assertNotNull(swept, "应发生清理");
        assertEquals(80, swept.size(), "清理绝不能改变消息条数（否则破坏 tool_use/tool_result 配对）");

        boolean sawCleared = false;
        for (ChatMessage m : swept) {
            if (m instanceof ToolMessage) {
                ToolMessage tm = (ToolMessage) m;
                assertNotNull(tm.getToolCallId(), "toolCallId 必须保留，否则 API 报 unexpected tool_use_id");
                assertNotNull(tm.getContent());
                assertFalse(tm.getContent().trim().isEmpty(),
                        "内容不得为空/纯空白：多家供应商会拒绝空文本块");
                if (tm.hasMetadata(ContextCompressionInterceptor.META_SWEPT)) {
                    sawCleared = true;
                }
            }
        }
        assertTrue(sawCleared, "应至少清理一条");
    }

    @Test
    void placeholderDoesNotInviteRerun() throws Exception {
        ContextCompressionInterceptor it = new ContextCompressionInterceptor();
        List<ChatMessage> swept = sweep(it, historyWith(new ArrayList<>()));

        for (ChatMessage m : swept) {
            if (m instanceof ToolMessage && m.hasMetadata(ContextCompressionInterceptor.META_SWEPT)) {
                String c = m.getContent();
                assertFalse(c.contains("重新调用"),
                        "占位符不得怂恿重调：会形成「清理→重调→再清理」的烧钱死循环");
            }
        }
    }

    /**
     * ⭐ 最关键的一条：本轮刚落地、模型还没读过的工具结果不得被清空。
     *
     * <p>onReasonStart 在模型看到结果之前执行；若按消息条数划保护线，
     * 一次并行调用（如同时 8 个 read）的靠前几条会落在保护线外被清空，
     * 相当于工具白跑，模型只能重调 → 再被清 → 无限循环。</p>
     */
    @Test
    void currentTurnParallelResultsAreNeverCleared() throws Exception {
        ContextCompressionInterceptor it = new ContextCompressionInterceptor();

        String[] ids = {"cur-1", "cur-2", "cur-3", "cur-4", "cur-5", "cur-6", "cur-7", "cur-8"};
        List<ChatMessage> tail = new ArrayList<>();
        tail.add(callOf(ids));
        for (String id : ids) {
            tail.add(resultOf(id, "read", big("current-" + id)));
        }

        List<ChatMessage> swept = sweep(it, historyWith(tail));
        assertNotNull(swept);

        for (ChatMessage m : swept) {
            if (m instanceof ToolMessage) {
                ToolMessage tm = (ToolMessage) m;
                if (tm.getToolCallId() != null && tm.getToolCallId().startsWith("cur-")) {
                    assertFalse(tm.hasMetadata(ContextCompressionInterceptor.META_SWEPT),
                            "本轮工具结果 " + tm.getToolCallId() + " 在模型读取前被清空了");
                }
            }
        }
    }

    @Test
    void sideEffectToolsAreNotSweepable() throws Exception {
        ContextCompressionInterceptor it = new ContextCompressionInterceptor();
        Method m = ContextCompressionInterceptor.class.getDeclaredMethod("isSweepable", ToolMessage.class);
        m.setAccessible(true);

        // write/edit 重跑会二次覆盖文件或改错位置，且返回值本就很短，清理无收益
        assertFalse((Boolean) m.invoke(it, resultOf("a", "write", big("w"))));
        assertFalse((Boolean) m.invoke(it, resultOf("a", "edit", big("e"))));

        // 子代理返回、MCP 工具不可重现
        assertFalse((Boolean) m.invoke(it, resultOf("a", "task", big("t"))));

        // 只读且可重现的才可清
        assertTrue((Boolean) m.invoke(it, resultOf("a", "read", big("r"))));
        assertTrue((Boolean) m.invoke(it, resultOf("a", "grep", big("g"))));
    }

    @Test
    void backgroundTaskHandleIsPreserved() throws Exception {
        ContextCompressionInterceptor it = new ContextCompressionInterceptor();
        Method m = ContextCompressionInterceptor.class.getDeclaredMethod("isSweepable", ToolMessage.class);
        m.setAccessible(true);

        // 后台任务的 session_id 是一次性句柄：重调 bash 只会另起新进程，拿不回原来那个
        ToolMessage bg = resultOf("a", "bash",
                "Background task started\nsession_id: abc-123\nstatus: running\n" + big("x"));
        assertFalse((Boolean) m.invoke(it, bg), "后台任务句柄不可清理");

        // 普通 bash 输出仍可清理
        assertTrue((Boolean) m.invoke(it, resultOf("a", "bash", big("plain output"))));
    }

    /**
     * 直接锁定护栏本身：末尾工具调用组的起点必须落在源头 Assistant 上。
     *
     * <p>这是 {@link #currentTurnParallelResultsAreNeverCleared} 的白盒版：
     * 即使未来有人改动保护线的其它分支，这条也能直接指出边界计算错在哪里。</p>
     */
    @Test
    void lastToolCallGroupStartPointsAtSourceAssistant() throws Exception {
        ContextCompressionInterceptor it = new ContextCompressionInterceptor();
        Method m = ContextCompressionInterceptor.class.getDeclaredMethod(
                "lastToolCallGroupStart", List.class);
        m.setAccessible(true);

        // [User, Assistant(tc x3), Tool, Tool, Tool] → 起点应为 index 1（那个 Assistant）
        List<ChatMessage> msgs = new ArrayList<>();
        msgs.add(ChatMessage.ofUser("hi"));
        msgs.add(callOf("a", "b", "c"));
        msgs.add(resultOf("a", "read", big("a")));
        msgs.add(resultOf("b", "read", big("b")));
        msgs.add(resultOf("c", "read", big("c")));
        assertEquals(1, (Integer) m.invoke(it, msgs),
                "并行调用的整组结果都必须在保护边界内");

        // 末尾不是工具输出时不施加额外限制
        List<ChatMessage> plain = new ArrayList<>();
        plain.add(ChatMessage.ofUser("hi"));
        plain.add(ChatMessage.ofAssistant("done"));
        assertEquals(plain.size(), (Integer) m.invoke(it, plain));
    }

    @Test
    void smallResultsAndAlreadySweptAreSkipped() throws Exception {
        ContextCompressionInterceptor it = new ContextCompressionInterceptor();
        Method m = ContextCompressionInterceptor.class.getDeclaredMethod("isSweepable", ToolMessage.class);
        m.setAccessible(true);

        assertFalse((Boolean) m.invoke(it, resultOf("a", "read", "tiny")), "小结果清了不省空间");

        // 已清理过的不重复处理（幂等）
        List<ChatMessage> once = sweep(it, historyWith(new ArrayList<>()));
        List<ChatMessage> twice = sweep(it, once);
        assertNull(twice, "已全部清理过时应返回 null，不做无谓改写");
    }
}
