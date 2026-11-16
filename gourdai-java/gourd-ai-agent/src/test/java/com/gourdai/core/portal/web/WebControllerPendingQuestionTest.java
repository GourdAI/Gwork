/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.core.portal.web;

import com.gourdai.agent.react.intercept.AskUser;
import com.gourdai.agent.react.intercept.AskUserTask;
import com.gourdai.agent.session.InMemoryAgentSession;
import com.gourdai.agent.util.AskUserTool;
import com.gourdai.core.config.AgentSettings;
import com.gourdai.harness.HarnessEngine;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.core.handle.Result;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * GET /web/chat/pendingQuestion 端点行为测试（契约 §3.4，契约冻结）。
 *
 * <p>契约：有挂起 ask_user 提问 → {@code {"code":200,"data":{"actionId","questions"}}}；
 * 无挂起 / HITL 挂起（无 ask_user 实体）/ 过期僵尸挂起（实体在但会话已不挂起）
 * → {@code {"code":200,"data":null}}。非法 sessionId 400 拒绝（与 todos 端点同守卫）。</p>
 */
class WebControllerPendingQuestionTest {
    @TempDir
    Path workspace;

    private final Map<String, InMemoryAgentSession> sessions = new ConcurrentHashMap<>();

    private WebController newController() {
        HarnessEngine engine = HarnessEngine.of(workspace.toString(), ".gwork")
                .sessionProvider(sessionId -> sessions.computeIfAbsent(sessionId, InMemoryAgentSession::of))
                .build();
        // webGate/loopScheduler/sessionLocator 传 null：本端点只触达 engine.getSession
        return new WebController(engine, null, null, null, new AgentSettings());
    }

    private InMemoryAgentSession session(String id) {
        return sessions.computeIfAbsent(id, InMemoryAgentSession::of);
    }

    private static AskUserTask task(String actionId) {
        return new AskUserTask(AskUserTool.TOOL_NAME,
                List.of(Map.of("header", "选哪个方案", "options", List.of(Map.of("label", "A"), Map.of("label", "B")))),
                actionId);
    }

    @Test
    @DisplayName("有挂起提问：返回 actionId 与 questions（含 multiSelect 透传）")
    void pendingQuestionReturnsTask() {
        InMemoryAgentSession session = session("work-pending");
        AskUserTask pending = new AskUserTask(AskUserTool.TOOL_NAME,
                List.of(Map.of("header", "选哪些能力", "multiSelect", true)), "call-42");
        session.getContext().put(AskUser.TASK_KEY, pending);
        session.pending(true, "ask_user");

        Result<Map<String, Object>> result = newController().pendingQuestion("work-pending");

        Assertions.assertEquals(200, result.getCode());
        Map<String, Object> data = result.getData();
        Assertions.assertNotNull(data, "有挂起提问必须返回数据");
        Assertions.assertEquals("call-42", data.get("actionId"));
        List<?> questions = (List<?>) data.get("questions");
        Assertions.assertEquals(1, questions.size());
        Assertions.assertEquals(Boolean.TRUE, ((Map<?, ?>) questions.get(0)).get("multiSelect"),
                "questions 快照必须原样透传（multiSelect 由前端消费）");
    }

    @Test
    @DisplayName("无挂起：data=null（code=200）")
    void noPendingReturnsNull() {
        session("work-idle");

        Result<Map<String, Object>> result = newController().pendingQuestion("work-idle");

        Assertions.assertEquals(200, result.getCode());
        Assertions.assertNull(result.getData(), "无挂起必须 data=null 而非错误");
    }

    @Test
    @DisplayName("HITL 挂起（会话挂起但无 ask_user 实体）：data=null")
    void hitlPendingReturnsNull() {
        InMemoryAgentSession session = session("work-hitl");
        session.pending(true, "hitl");

        Result<Map<String, Object>> result = newController().pendingQuestion("work-hitl");

        Assertions.assertEquals(200, result.getCode());
        Assertions.assertNull(result.getData(), "HITL 挂起不是 ask_user 提问，不得返回数据");
    }

    @Test
    @DisplayName("过期僵尸挂起（实体残留但会话已不挂起）：data=null")
    void stalePendingReturnsNull() {
        InMemoryAgentSession session = session("work-stale");
        session.getContext().put(AskUser.TASK_KEY, task("call-old"));
        // 会话已恢复运行（stopped=false），实体是上次提问的残留

        Result<Map<String, Object>> result = newController().pendingQuestion("work-stale");

        Assertions.assertEquals(200, result.getCode());
        Assertions.assertNull(result.getData(), "过期挂起不得让前端重新弹卡");
    }

    @Test
    @DisplayName("非法 sessionId：400 拒绝（与 todos 端点同守卫）")
    void invalidSessionIdRejected() {
        WebController controller = newController();

        Assertions.assertNotEquals(200, controller.pendingQuestion(null).getCode());
        Assertions.assertNotEquals(200, controller.pendingQuestion("../x").getCode());
        Assertions.assertNotEquals(200, controller.pendingQuestion("..\\x").getCode());
        Assertions.assertNotEquals(200, controller.pendingQuestion("a/b").getCode());
    }

    @Test
    @DisplayName("会话不存在（provider 抛异常）：按无挂起处理，不打断前端加载")
    void missingSessionDegradesToNull() {
        HarnessEngine engine = HarnessEngine.of(workspace.toString(), ".gwork")
                .sessionProvider(sessionId -> {
                    throw new IllegalStateException("session not found");
                })
                .build();
        WebController controller = new WebController(engine, null, null, null, new AgentSettings());

        Result<Map<String, Object>> result = controller.pendingQuestion("work-missing");

        Assertions.assertEquals(200, result.getCode());
        Assertions.assertNull(result.getData(), "兜底端点异常时按无挂起处理");
    }
}