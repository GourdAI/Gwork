package com.gourdai.core.portal.web;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.noear.solon.core.handle.Result;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * ProjectService.rename 重命名语义测试。
 *
 * <p>覆盖：原地改名不置顶（保持「最近使用」排序）、同名不同目录可分别改名、
 * 空名恢复目录名、未登记路径 404、非法路径 400、超长名截断（与会话标签一致 50）。</p>
 *
 * @author oisin
 */
public class ProjectServiceRenameTest {
    private Path root;
    private String originalGwork;

    @BeforeEach
    void setUp() throws Exception {
        originalGwork = System.getProperty("gwork.home");
        root = Files.createTempDirectory("project-rename-test");
        System.setProperty("gwork.home", root.toString());
    }

    @AfterEach
    void tearDown() throws Exception {
        if (originalGwork != null) {
            System.setProperty("gwork.home", originalGwork);
        } else {
            System.clearProperty("gwork.home");
        }
        deleteRecursively(root);
    }

    /**
     * 原地改名：保持列表顺序（不因改名置顶），目标改名其余不动，且落盘持久化。
     */
    @Test
    void renameIsInPlaceAndKeepsOrder() throws Exception {
        ProjectService service = new ProjectService();
        Path dirA = createProjectDir("alpha");
        Path dirB = createProjectDir("beta");
        Path dirC = createProjectDir("gamma");

        service.add(dirA.toString(), null);
        service.add(dirB.toString(), null);
        service.add(dirC.toString(), null); // 最后添加的在最前：[gamma, beta, alpha]

        Result<List<Map>> rst = service.rename(dirB.toString(), "别名 B");
        Assertions.assertEquals(200, rst.getCode());

        List<Map> projects = rst.getData();
        Assertions.assertEquals(3, projects.size());
        // 顺序不变（未置顶）
        Assertions.assertEquals(dirC.toString(), String.valueOf(projects.get(0).get("path")));
        Assertions.assertEquals(dirB.toString(), String.valueOf(projects.get(1).get("path")));
        Assertions.assertEquals(dirA.toString(), String.valueOf(projects.get(2).get("path")));
        // 目标改名，其余不动
        Assertions.assertEquals("别名 B", String.valueOf(projects.get(1).get("name")));
        Assertions.assertEquals("alpha", String.valueOf(projects.get(2).get("name")));

        // 落盘持久化：重新读取后仍生效
        Result<List<Map>> after = service.list();
        Assertions.assertEquals("别名 B", String.valueOf(after.getData().get(1).get("name")));
    }

    /**
     * 用户原始场景：同名不同目录的两个项目，改名其中一个不影响另一个。
     */
    @Test
    void renameOnlyAffectsTargetAmongSameNamedProjects() throws Exception {
        ProjectService service = new ProjectService();
        Path dirA = createProjectDir("same-name-a");
        Path dirB = createProjectDir("same-name-b");
        service.add(dirA.toString(), "wx-project");
        service.add(dirB.toString(), "wx-project");

        Result<List<Map>> rst = service.rename(dirB.toString(), "wx-project (new)");
        Assertions.assertEquals(200, rst.getCode());

        List<Map> projects = rst.getData();
        // 列表：[B, A]
        Assertions.assertEquals("wx-project (new)", String.valueOf(projects.get(0).get("name")));
        Assertions.assertEquals(dirB.toString(), String.valueOf(projects.get(0).get("path")));
        Assertions.assertEquals("wx-project", String.valueOf(projects.get(1).get("name")));
        Assertions.assertEquals(dirA.toString(), String.valueOf(projects.get(1).get("path")));
    }

    /**
     * 空名（含纯空白）恢复为目录名。
     */
    @Test
    void renameEmptyNameFallsBackToDirectoryName() throws Exception {
        ProjectService service = new ProjectService();
        Path dir = createProjectDir("fallback-name");
        service.add(dir.toString(), "自定义名");

        Result<List<Map>> rst = service.rename(dir.toString(), "   ");
        Assertions.assertEquals(200, rst.getCode());
        Assertions.assertEquals("fallback-name", String.valueOf(rst.getData().get(0).get("name")));
    }

    /**
     * 未登记的路径返回 404。
     */
    @Test
    void renameUnknownPathReturns404() throws Exception {
        ProjectService service = new ProjectService();
        Path dir = createProjectDir("unregistered");
        Result<List<Map>> rst = service.rename(dir.toString(), "x");
        Assertions.assertEquals(404, rst.getCode());
    }

    /**
     * 非法路径参数返回 400（空、纯空白、含 ..）。
     */
    @Test
    void renameRejectsInvalidPath() {
        ProjectService service = new ProjectService();
        Assertions.assertEquals(400, service.rename(null, "x").getCode());
        Assertions.assertEquals(400, service.rename("  ", "x").getCode());
        Assertions.assertEquals(400, service.rename("C:/tmp/../etc", "x").getCode());
    }

    /**
     * 超长名截断为 50（与会话标签长度限制一致）。
     */
    @Test
    void renameTruncatesLongNameTo50() throws Exception {
        ProjectService service = new ProjectService();
        Path dir = createProjectDir("longname");
        service.add(dir.toString(), null);

        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 80; i++) {
            sb.append('x');
        }
        Result<List<Map>> rst = service.rename(dir.toString(), sb.toString());
        Assertions.assertEquals(200, rst.getCode());
        Assertions.assertEquals(50, String.valueOf(rst.getData().get(0).get("name")).length());
    }

    // ==================== 辅助 ====================

    private Path createProjectDir(String name) throws Exception {
        Path dir = root.resolve("ws").resolve(name);
        Files.createDirectories(dir);
        return dir.toAbsolutePath().normalize();
    }

    private static void deleteRecursively(Path path) throws Exception {
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
        }
    }
}
