package com.gourdai.core.portal.web;

import com.gourdai.core.config.AgentSettings;
import com.gourdai.harness.HarnessEngine;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.core.handle.Result;

import java.nio.file.Path;

/**
 * access_select / context_select 端点的 sessionId 守卫测试。
 *
 * <p>背景：sessionId 会流入 {@code engine.getSession()} 与 {@code FileAgentSession}
 * 的落盘路径。同文件的 interrupt / steer 端点早已有「空值 + {@code ..}/{@code /}{@code \}
 * 一律拒绝」校验，而这两个（较新的）端点在补丁前缺失同类校验，存在目录穿越面。
 * 本测试锁定：非法 sessionId 在进入会话解析之前即被拒绝。</p>
 */
class WebControllerSessionGuardTest {
    @TempDir
    Path workspace;

    private WebController newController() {
        HarnessEngine engine = HarnessEngine.of(workspace.toString(), ".gwork").build();
        // webGate/loopScheduler/sessionLocator 传 null：构造器对它们只存字段（或判空跳过），
        // 守卫分支在 engine.getSession 之前返回，不会触达这些协作者
        return new WebController(engine, null, null, null, new AgentSettings());
    }

    @Test
    void accessSelectRejectsMissingSessionId() throws Exception {
        Result result = newController().access_select(null, "full");

        Assertions.assertNotEquals(200, result.getCode(),
                "空 sessionId 不得进入会话解析: " + result);
    }

    @Test
    void accessSelectRejectsTraversalSessionId() throws Exception {
        Result result = newController().access_select("..\\..\\etc", "full");

        Assertions.assertNotEquals(200, result.getCode(),
                "含路径穿越形态的 sessionId 不得进入会话解析: " + result);
    }

    @Test
    void contextSelectRejectsMissingAndTraversalSessionId() throws Exception {
        WebController controller = newController();

        Assertions.assertNotEquals(200, controller.context_select(null, "20").getCode(),
                "空 sessionId 不得进入会话解析");
        Assertions.assertNotEquals(200, controller.context_select("../x", "20").getCode(),
                "含 ../ 的 sessionId 不得进入会话解析");
    }

    @Test
    void accessSelectRejectsUnsupportedAccessMode() throws Exception {
        // 码值大小写不敏感（equalsIgnoreCase），但拼错的档位必须 400 可感知，
        // 而不是静默写入一个前端永远渲染不出的档位
        Result result = newController().access_select("work-probe", "super-admin");

        Assertions.assertEquals(400, result.getCode(),
                "非法 accessMode 必须 400 fail-fast: " + result);
    }
}
