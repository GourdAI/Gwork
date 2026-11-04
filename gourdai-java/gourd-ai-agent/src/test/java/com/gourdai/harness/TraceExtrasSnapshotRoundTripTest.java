package com.gourdai.harness;

import com.gourdai.agent.react.ReActAgent;
import com.gourdai.agent.react.ReActTrace;
import org.junit.jupiter.api.Test;
import org.noear.solon.flow.FlowContext;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 快照往返探针：验证 trace 的 extras / route 能否随
 * FlowContext.toJson → fromJson 完整往返（进程重启后恢复链路的持久化前提）。
 *
 * <p>背景：「用户取消后继续」修复依赖 trace extras 中的中断标记
 * （{@link ReActTrace#EXTRA_USER_INTERRUPTED}）跨重启存活；
 * 本测试即锁死这一前提，若 extras 不能往返，该方案需要改为其他持久化载体。</p>
 */
class TraceExtrasSnapshotRoundTripTest {

    @Test
    void userInterruptMarkSurvivesSnapshotRoundTrip() {
        ReActTrace trace = new ReActTrace();
        trace.setRoute(ReActAgent.ID_END);
        trace.markUserInterrupted();
        trace.setExtra("_probe_text", "hello");

        FlowContext ctx = FlowContext.of("probe-session");
        ctx.put("__main", trace);
        String json = ctx.toJson();

        assertTrue(json.contains("_user_interrupted"),
                "序列化 JSON 应包含中断标记键: " + json.substring(0, Math.min(500, json.length())));

        FlowContext ctx2 = FlowContext.fromJson(json);
        ReActTrace trace2 = ctx2.getAs("__main");
        assertNotNull(trace2, "反序列化后应能取回 __main trace");
        assertEquals(ReActAgent.ID_END, trace2.getRoute(), "route 应往返");
        assertTrue(trace2.isUserInterrupted(), "用户中断标记应随快照往返（重启后仍可判定）");
        assertEquals("hello", trace2.getExtra("_probe_text"), "字符串 extras 应往返");
    }
}
