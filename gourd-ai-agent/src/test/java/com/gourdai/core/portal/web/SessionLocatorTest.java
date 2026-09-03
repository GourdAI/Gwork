package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * SessionLocator 统一会话模型测试 —— 验证 work- 前缀、所属根登记/解析、
 * 全局回退与路径越界防护。
 *
 * @author oisin
 */
public class SessionLocatorTest {

    private SessionLocator newLocator(Path workspace) {
        return new SessionLocator(workspace.toString(), ".gwork/sessions");
    }

    @Test
    public void testWorkspaceAndGlobalBaseAreDistinct() throws Exception {
        Path workspace = Files.createTempDirectory("locator-workspace");
        Path globalBase = Files.createTempDirectory("locator-global-base");
        Path project = Files.createTempDirectory("locator-project-distinct");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), globalBase.toString(), ".gwork/sessions");
            String sid = "work-distinct";
            locator.bindSessionRoot(sid, project.toString());
            Assertions.assertEquals(globalBase.resolve(".gwork/sessions").resolve("work-global")
                    .toAbsolutePath().normalize().toString(), locator.resolveDir("work-global").getAbsolutePath());
            Assertions.assertEquals(project.resolve(".gwork/sessions").resolve(sid)
                    .toAbsolutePath().normalize().toString(), locator.resolveDir(sid).getAbsolutePath());
            Assertions.assertEquals(globalBase.resolve(".gwork/sessions").toAbsolutePath().normalize().toString(),
                    locator.globalSessionsRoot().getAbsolutePath());
            locator.bindSessionRoot("work-index", project.toString());
            Assertions.assertTrue(Files.isRegularFile(globalBase.resolve(".gwork/session-roots.json")));
            Assertions.assertFalse(Files.exists(workspace.resolve(".gwork/session-roots.json")));
        } finally {
            deleteRecursively(workspace.toFile());
            deleteRecursively(globalBase.toFile());
            deleteRecursively(project.toFile());
        }
    }

    @Test
    public void testUnifiedPrefix() {
        Assertions.assertEquals("work-", SessionLocator.PREFIX_WORK, "会话 ID 统一 work- 前缀");
    }

    @Test
    public void testGlobalFallbackWithoutBinding() throws Exception {
        Path ws = Files.createTempDirectory("locator-global");
        try {
            SessionLocator locator = newLocator(ws);
            // 未登记所属根：全局会话，回退安装目录
            File dir = locator.resolveDir("work-abc123");
            Assertions.assertEquals(
                    ws.resolve(".gwork/sessions/work-abc123").toAbsolutePath().normalize().toString(),
                    dir.getAbsolutePath(), "无所属根的会话应落安装目录全局区");
        } finally {
            deleteRecursively(ws.toFile());
        }
    }

    @Test
    public void testBindAndResolveProjectSession() throws Exception {
        Path ws = Files.createTempDirectory("locator-ws");
        Path project = Files.createTempDirectory("locator-project");
        try {
            SessionLocator locator = newLocator(ws);
            locator.bindSessionRoot("work-prj1", project.toString());

            // 登记后 resolveDir(sid) 无需提示即可解析到项目根
            Assertions.assertEquals(
                    project.resolve(".gwork/sessions/work-prj1").toAbsolutePath().normalize().toString(),
                    locator.resolveDir("work-prj1").getAbsolutePath(),
                    "已登记根的会话应落所属项目目录");

            // 根提示优先于登记表
            Path other = Files.createTempDirectory("locator-other");
            Assertions.assertTrue(locator.resolveDir("work-prj1", other.toString())
                            .getAbsolutePath().startsWith(other.toAbsolutePath().normalize().toString()),
                    "显式根提示应优先于登记表");

            Assertions.assertEquals(project.toString(), locator.boundRoot("work-prj1"), "boundRoot 应返回登记根");
            Assertions.assertTrue(locator.registeredRoots().contains(project.toString()),
                    "registeredRoots 应包含已登记根");

            // 解绑后回退全局区
            locator.unbind("work-prj1");
            Assertions.assertNull(locator.boundRoot("work-prj1"), "解绑后不应再能查到根");
            Assertions.assertTrue(locator.resolveDir("work-prj1").getAbsolutePath()
                            .startsWith(ws.toAbsolutePath().normalize().toString()),
                    "解绑后会话回退安装目录");
        } finally {
            deleteRecursively(ws.toFile());
            deleteRecursively(project.toFile());
        }
    }

    @Test
    public void testIllegalSessionIdRejected() throws Exception {
        Path ws = Files.createTempDirectory("locator-guard");
        try {
            SessionLocator locator = newLocator(ws);
            Assertions.assertThrows(IllegalArgumentException.class,
                    () -> locator.resolveDir("work-.."));
            Assertions.assertThrows(IllegalArgumentException.class,
                    () -> locator.resolveDir("work-a/b"));
            Assertions.assertThrows(IllegalArgumentException.class,
                    () -> locator.resolveDir("work-a\\b"));
            Assertions.assertThrows(IllegalArgumentException.class,
                    () -> locator.resolveDir(null));
        } finally {
            deleteRecursively(ws.toFile());
        }
    }

    @Test
    public void testGlobalSessionsRoot() throws Exception {
        Path ws = Files.createTempDirectory("locator-root");
        try {
            SessionLocator locator = newLocator(ws);
            Assertions.assertEquals(
                    ws.resolve(".gwork/sessions").toAbsolutePath().normalize().toString(),
                    locator.globalSessionsRoot().getAbsolutePath(),
                    "全局会话扫描根应为安装目录 sessions 区");
        } finally {
            deleteRecursively(ws.toFile());
        }
    }

    private static void deleteRecursively(File f) {
        if (f == null || !f.exists()) return;
        File[] children = f.listFiles();
        if (children != null) {
            for (File c : children) deleteRecursively(c);
        }
        // 删除失败不阻断测试（临时目录由系统清理）
        f.delete();
    }
}
