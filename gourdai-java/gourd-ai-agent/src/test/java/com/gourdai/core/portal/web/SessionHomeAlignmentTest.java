package com.gourdai.core.portal.web;

import com.gourdai.agent.session.FileAgentSession;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import com.gourdai.ai.chat.message.ChatMessage;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/**
 * 会话家目录对齐测试：受理时把未落盘会话的存储目录对齐到绑定结果（boundRoot ?: 全局区），
 * 保证 messages/snapshot（引擎侧）与 stream/label（Web 侧）同目录落盘，不再分居。
 *
 * <p>背景：会话对象在构造时即固化存储目录，而首次受理输入（登记所属根）发生在其后；
 * 修复前表现为「先建对象（落全局区）→后绑定根」，导致同一会话数据被拆到两个目录。</p>
 *
 * @author oisin
 */
public class SessionHomeAlignmentTest {

    /** 首条消息场景：会话对象先落全局区，绑定项目根后应迁移到项目区，消息只落项目区。 */
    @Test
    public void testAlignPristineSessionFollowsBoundProjectRoot() throws Exception {
        Path base = Files.createTempDirectory("align-bind");
        try {
            Path ws = base.resolve("ws");
            Path globalBase = base.resolve("global");
            Path project = base.resolve("project");
            Files.createDirectories(ws);
            Files.createDirectories(globalBase);
            Files.createDirectories(project);

            SessionLocator locator = new SessionLocator(ws.toString(), globalBase.toString(), ".gwork/sessions");
            String sid = "work-align1";

            // 模拟"新建会话+首条消息"：会话对象构造时尚未登记 → 暂落全局区
            FileAgentSession session = new FileAgentSession(sid, locator.resolveDir(sid).toString());
            Assertions.assertEquals(
                    globalBase.resolve(".gwork/sessions").resolve(sid).toFile().getAbsoluteFile(),
                    session.getBaseDir(), "构造时应暂落全局区");

            // 受理：绑定项目根 + 对齐家目录
            locator.bindSessionRoot(sid, project.toString());
            WebGate.alignSessionHome(locator, session);

            Assertions.assertEquals(
                    project.resolve(".gwork/sessions").resolve(sid).toFile().getAbsoluteFile(),
                    session.getBaseDir(), "对齐后会话应迁移到项目区");

            // 首条消息落项目区，全局区不残留
            session.addMessage(List.of(ChatMessage.ofUser("hi")));
            Assertions.assertTrue(project.resolve(".gwork/sessions").resolve(sid)
                    .resolve(sid + ".messages.ndjson").toFile().isFile(), "消息应落项目区");
            Assertions.assertFalse(globalBase.resolve(".gwork/sessions").resolve(sid)
                    .resolve(sid + ".messages.ndjson").toFile().exists(), "全局区不应残留消息");
        } finally {
            deleteRecursively(base);
        }
    }

    /** 全局会话（未绑定）对齐后保持全局区。 */
    @Test
    public void testAlignKeepsGlobalForUnboundSession() throws Exception {
        Path base = Files.createTempDirectory("align-global");
        try {
            Path ws = base.resolve("ws");
            Path globalBase = base.resolve("global");
            Files.createDirectories(ws);
            Files.createDirectories(globalBase);

            SessionLocator locator = new SessionLocator(ws.toString(), globalBase.toString(), ".gwork/sessions");
            String sid = "work-align2";

            FileAgentSession session = new FileAgentSession(sid, locator.resolveDir(sid).toString());
            // 未绑定 → 家目录=全局区 → 对齐为空操作
            WebGate.alignSessionHome(locator, session);
            Assertions.assertEquals(
                    globalBase.resolve(".gwork/sessions").resolve(sid).toFile().getAbsoluteFile(),
                    session.getBaseDir(), "全局会话应保持全局区");

            session.addMessage(List.of(ChatMessage.ofUser("hi")));
            Assertions.assertTrue(globalBase.resolve(".gwork/sessions").resolve(sid)
                    .resolve(sid + ".messages.ndjson").toFile().isFile(), "全局会话消息应落全局区");
        } finally {
            deleteRecursively(base);
        }
    }

    /** 已落盘数据的会话不得迁移；且数据只在全局区时，绑定请求不改变全局归属。 */
    @Test
    public void testAlignDoesNotMoveSessionWithPersistedData() throws Exception {
        Path base = Files.createTempDirectory("align-data");
        try {
            Path ws = base.resolve("ws");
            Path globalBase = base.resolve("global");
            Path project = base.resolve("project");
            Files.createDirectories(ws);
            Files.createDirectories(globalBase);
            Files.createDirectories(project);

            SessionLocator locator = new SessionLocator(ws.toString(), globalBase.toString(), ".gwork/sessions");
            String sid = "work-align3";

            // 会话已在全局区落盘数据（历史分居形态）
            FileAgentSession session = new FileAgentSession(sid, locator.resolveDir(sid).toString());
            session.addMessage(List.of(ChatMessage.ofUser("first")));

            // 即便此时收到项目根绑定请求：已有数据的会话不会迁移；数据只在全局区 → 保持全局语义
            locator.bindSessionRoot(sid, project.toString());
            WebGate.alignSessionHome(locator, session);

            Assertions.assertEquals(
                    globalBase.resolve(".gwork/sessions").resolve(sid).toFile().getAbsoluteFile(),
                    session.getBaseDir(), "已落盘会话不得迁移");
            Assertions.assertNull(locator.boundRoot(sid), "数据只在全局区时不应登记项目归属");
        } finally {
            deleteRecursively(base);
        }
    }

    private static void deleteRecursively(Path path) {
        if (path == null || !Files.exists(path)) {
            return;
        }
        try (Stream<Path> walk = Files.walk(path)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (Exception ignored) {
                }
            });
        } catch (Exception ignored) {
        }
    }
}
