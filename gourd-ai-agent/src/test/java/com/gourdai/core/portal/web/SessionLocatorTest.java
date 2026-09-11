package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

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

    /**
     * 回归：无所属根会话的「写入根」必须与「读取根」同源。
     *
     * <p>旧实现中写入侧兜底 workspace（user.dir）、读取侧兜底 globalBase（user.home），
     * 两者不等时 todowrite 写的 TODO.md 永远查不到 → 任务面板恒显「暂无任务清单」。</p>
     */
    @Test
    public void testWriteRootMatchesReadRootForUnboundSession() throws Exception {
        Path workspace = Files.createTempDirectory("locator-w-ws");
        Path globalBase = Files.createTempDirectory("locator-w-global");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), globalBase.toString(), ".gwork/sessions");
            String sid = "work-unbound";

            String writeRoot = locator.resolveWriteRoot(sid, null);
            Assertions.assertEquals(globalBase.toString(), writeRoot,
                    "无所属根会话的写入根应兜底到全局基准目录，而非 workspace");

            Path written = Paths.get(writeRoot, ".gwork/sessions", sid).toAbsolutePath().normalize();
            Assertions.assertEquals(written.toString(), locator.resolveDir(sid).getAbsolutePath(),
                    "写入根拼出的会话目录必须等于读取解析的会话目录");
        } finally {
            deleteRecursively(workspace.toFile());
            deleteRecursively(globalBase.toFile());
        }
    }

    /** 显式 cwd 与已登记根的优先级：cwd &gt; boundRoot &gt; globalBase。 */
    @Test
    public void testWriteRootPriority() throws Exception {
        Path workspace = Files.createTempDirectory("locator-wp-ws");
        Path globalBase = Files.createTempDirectory("locator-wp-global");
        Path project = Files.createTempDirectory("locator-wp-proj");
        Path explicit = Files.createTempDirectory("locator-wp-explicit");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), globalBase.toString(), ".gwork/sessions");
            String sid = "work-prio";

            Assertions.assertEquals(globalBase.toString(), locator.resolveWriteRoot(sid, null));
            locator.bindSessionRoot(sid, project.toString());
            Assertions.assertEquals(project.toString(), locator.resolveWriteRoot(sid, null),
                    "已登记所属根应优先于全局基准目录");
            Assertions.assertEquals(explicit.toString(), locator.resolveWriteRoot(sid, explicit.toString()),
                    "显式 cwd 优先级最高");
        } finally {
            deleteRecursively(workspace.toFile());
            deleteRecursively(globalBase.toFile());
            deleteRecursively(project.toFile());
            deleteRecursively(explicit.toFile());
        }
    }

    /** 历史落点兼容：标准位置没有 TODO.md 时，应回探 workspace 下的旧目录。 */
    @Test
    public void testResolveDirForReadFallsBackToLegacyWorkspace() throws Exception {
        Path workspace = Files.createTempDirectory("locator-lg-ws");
        Path globalBase = Files.createTempDirectory("locator-lg-global");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), globalBase.toString(), ".gwork/sessions");
            String sid = "work-legacy";

            // 模拟旧版本：TODO.md 被写进了 workspace（user.dir）
            Path legacyDir = workspace.resolve(".gwork/sessions").resolve(sid);
            Files.createDirectories(legacyDir);
            Files.write(legacyDir.resolve("TODO.md"), "- [ ] legacy".getBytes("UTF-8"));

            Assertions.assertEquals(legacyDir.toAbsolutePath().normalize().toString(),
                    locator.resolveDirForRead(sid, null, "TODO.md").getAbsolutePath(),
                    "标准位置无清单时应命中历史 workspace 落点");
        } finally {
            deleteRecursively(workspace.toFile());
            deleteRecursively(globalBase.toFile());
        }
    }

    /** 标准位置已有清单时，不得被历史目录的同名文件抢走。 */
    @Test
    public void testResolveDirForReadPrefersPrimary() throws Exception {
        Path workspace = Files.createTempDirectory("locator-pp-ws");
        Path globalBase = Files.createTempDirectory("locator-pp-global");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), globalBase.toString(), ".gwork/sessions");
            String sid = "work-primary";

            Path primaryDir = globalBase.resolve(".gwork/sessions").resolve(sid);
            Files.createDirectories(primaryDir);
            Files.write(primaryDir.resolve("TODO.md"), "- [x] primary".getBytes("UTF-8"));

            Path legacyDir = workspace.resolve(".gwork/sessions").resolve(sid);
            Files.createDirectories(legacyDir);
            Files.write(legacyDir.resolve("TODO.md"), "- [ ] legacy".getBytes("UTF-8"));

            Assertions.assertEquals(primaryDir.toAbsolutePath().normalize().toString(),
                    locator.resolveDirForRead(sid, null, "TODO.md").getAbsolutePath(),
                    "标准位置有清单时必须优先返回标准目录");
        } finally {
            deleteRecursively(workspace.toFile());
            deleteRecursively(globalBase.toFile());
        }
    }

    /** 两边都没有时，应返回标准目录（保证后续写入落在统一根）。 */
    @Test
    public void testResolveDirForReadDefaultsToPrimaryWhenAbsent() throws Exception {
        Path workspace = Files.createTempDirectory("locator-ab-ws");
        Path globalBase = Files.createTempDirectory("locator-ab-global");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), globalBase.toString(), ".gwork/sessions");
            String sid = "work-absent";
            Assertions.assertEquals(locator.resolveDir(sid).getAbsolutePath(),
                    locator.resolveDirForRead(sid, null, "TODO.md").getAbsolutePath());
        } finally {
            deleteRecursively(workspace.toFile());
            deleteRecursively(globalBase.toFile());
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
