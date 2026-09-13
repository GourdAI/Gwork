package com.gourdai.agent.react.intercept;

import com.gourdai.agent.react.task.ToolExchanger;
import com.gourdai.core.portal.web.WebChunk;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * HITL 审批卡与「参数流骨架卡」按 actionId 精确配对的运行时契约。
 *
 * <p>背景：审批卡旧实现只能按工具名匹配骨架卡，并发调用同名工具（如同时两个 bash、
 * 其中一个触发审批）会接管错卡片。修复方式是让 actionId 沿
 * ActionTask → ToolExchanger → HITLTask → WebChunk 一路透传。</p>
 *
 * <p>与 {@code src/test/js/tool-args-streaming.test.js} 互补：那边是源码正则，锁「代码长这样」；
 * 这里是运行时断言，验「值真的流过去了、旧快照真的还能读」。</p>
 */
class HitlActionIdPairingTest {

    @Test
    void toolExchangerCarriesActionIdAndLegacyCtorStaysNull() {
        Map<String, Object> args = Map.of("command", "ls");

        ToolExchanger withId = new ToolExchanger("bash", args, "call-42");
        Assertions.assertEquals("call-42", withId.getActionId());
        Assertions.assertEquals("bash", withId.getToolName());

        // 旧两参构造必须仍可用，且 actionId 为 null（调用方须容忍并自行降级）
        ToolExchanger legacy = new ToolExchanger("bash", args);
        Assertions.assertNull(legacy.getActionId());
        Assertions.assertEquals("bash", legacy.getToolName());
    }

    @Test
    void hitlTaskCarriesActionIdAndLegacyCtorStaysNull() {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", "rm -rf /tmp/x");

        HITLTask withId = new HITLTask("bash", args, "敏感操作", "call-7");
        Assertions.assertEquals("call-7", withId.getActionId());

        HITLTask legacy = new HITLTask("bash", args, "敏感操作");
        Assertions.assertNull(legacy.getActionId());
        Assertions.assertEquals("敏感操作", legacy.getComment());
    }

    /**
     * 会话快照以 JSON 持久化（见 FileAgentSession#updateSnapshot 的 getContext().toJson()），
     * 而 HITLTask 就挂在 session context 的 _last_intervened_ 键下。
     *
     * <p>故两件事必须成立：新字段能往返；本字段新增【之前】落盘的快照恢复时降级为 null 而不是炸掉。</p>
     */
    @Test
    void hitlTaskSurvivesJsonRoundTripAndToleratesLegacySnapshot() {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", "ls -la");
        HITLTask origin = new HITLTask("bash", args, "敏感操作，需要人工介入确认", "call-9");

        String json = ONode.serialize(origin);
        Assertions.assertTrue(json.contains("call-9"), "序列化结果应含 actionId，否则快照恢复后配对信息丢失");

        HITLTask back = ONode.ofJson(json).toBean(HITLTask.class);
        Assertions.assertEquals("call-9", back.getActionId());
        Assertions.assertEquals("bash", back.getToolName());
        Assertions.assertEquals("敏感操作，需要人工介入确认", back.getComment());

        // 旧快照：JSON 里根本没有 actionId 这个键
        String legacyJson = "{\"toolName\":\"bash\",\"args\":{\"command\":\"ls\"},\"comment\":\"敏感操作\"}";
        HITLTask legacy = ONode.ofJson(legacyJson).toBean(HITLTask.class);
        Assertions.assertEquals("bash", legacy.getToolName());
        Assertions.assertNull(legacy.getActionId(), "旧快照缺字段应为 null，前端据此降级按 toolName 匹配");
    }

    /**
     * hitl 帧必须把 actionId 投影到线格式：Web 通道走 WebChunk 序列化，
     * 桌面通道走 WsGate 的 ONode 出口（{@code if (chunk.getActionId() != null) node.set("actionId", ...)}），
     * 两者都依赖这个字段被正确填充。
     */
    @Test
    void hitlChunkProjectsActionIdToWire() {
        WebChunk chunk = WebChunk.ofHitl("bash", "ls -la", "call-13");
        Assertions.assertEquals("call-13", chunk.getActionId());

        ONode json = ONode.ofJson(ONode.serialize(chunk));
        Assertions.assertEquals("hitl", json.get("type").getString());
        Assertions.assertEquals("call-13", json.get("actionId").getString());
        Assertions.assertEquals("bash", json.get("toolName").getString());
        Assertions.assertEquals("ls -la", json.get("command").getString());

        // 旧两参重载保持兼容
        WebChunk legacy = WebChunk.ofHitl("bash", "ls -la");
        Assertions.assertNull(legacy.getActionId());
    }

    /**
     * 全链路同源性：ActionTask 用同一个 actionId 局部变量同时喂 ToolExchanger 与 ToolCallStartEvent，
     * 而骨架卡的 id 来自 ToolCallDraftEvent（同源于原生 ToolCall.getId()），
     * 因此审批卡拿到的 id 与骨架卡的 id 必然相等 —— 这是前端能精确接管的前提。
     */
    @Test
    void actionIdFlowsFromExchangerToHitlChunkUnchanged() {
        String actionId = "call-native-001";
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", "git push");

        // 1) ActionTask#doAction 的构造
        ToolExchanger exchanger = new ToolExchanger("bash", args, actionId);
        // 2) HITLInterceptor#onAction 挂起分支的写入
        HITLTask task = new HITLTask(exchanger.getToolName(),
                new LinkedHashMap<>(exchanger.getArgs()), "敏感操作", exchanger.getActionId());
        // 3) WebStreamBuilder 的帧投影
        WebChunk chunk = WebChunk.ofHitl(task.getToolName(), "git push", task.getActionId());

        Assertions.assertEquals(actionId, chunk.getActionId(), "actionId 在三段传递中不得被改写或丢失");
    }

    /**
     * 并发同名工具的配对可分辨性：两次 bash 调用产生两个不同 actionId，
     * 其中一个被审批拦截时，hitl 帧带的必须是「被拦截那一次」的 id。
     */
    @Test
    void concurrentSameToolCallsRemainDistinguishable() {
        ToolExchanger first = new ToolExchanger("bash", Map.of("command", "ls"), "call-A");
        ToolExchanger second = new ToolExchanger("bash", Map.of("command", "rm -rf x"), "call-B");

        // 只有第二个触发审批
        HITLTask intervened = new HITLTask(second.getToolName(),
                new LinkedHashMap<>(second.getArgs()), "敏感操作", second.getActionId());
        WebChunk chunk = WebChunk.ofHitl(intervened.getToolName(), "rm -rf x", intervened.getActionId());

        Assertions.assertEquals("call-B", chunk.getActionId());
        Assertions.assertNotEquals(first.getActionId(), chunk.getActionId(),
                "两次同名调用的 actionId 必须可区分，否则前端仍会接管错卡片");
    }
}
