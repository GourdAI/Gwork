package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.FileTime;
import java.util.Comparator;
import java.util.stream.Stream;

/**
 * 会话列表时间测试：侧栏会话的 time 与排序必须取「最后活动时间」——
 * 会话数据文件（messages/snapshot/stream）mtime 的最大值，而不是会话目录自身的 mtime。
 *
 * <p>背景：目录 mtime 有两个反直觉行为——向已有文件追加内容不会刷新它（活跃会话越聊越旧），
 * 而目录内新增/删除条目（传附件、建账本、改名）反而会刷新它（无关动作让会话「假活跃」）。
 * 修复见 {@link WebController#lastActivityOf(java.io.File, String)}。</p>
 *
 * @author oisin
 */
public class SessionListTimeTest {

    private static final long DAY = 24L * 60 * 60 * 1000;

    /** 常规场景：取三个数据文件 mtime 的最大值；目录 mtime 更旧时不得参与。 */
    @Test
    public void testLastActivityPrefersNewestDataFile() throws Exception {
        Path base = Files.createTempDirectory("list-time-newest");
        try {
            Path dir = base.resolve("work-aaa");
            Files.createDirectories(dir);
            long now = System.currentTimeMillis();

            Path messages = dir.resolve("work-aaa.messages.ndjson");
            Path snapshot = dir.resolve("work-aaa.snapshot.json");
            Path stream = dir.resolve("work-aaa.stream.ndjson");
            Files.write(messages, "m".getBytes(StandardCharsets.UTF_8));
            Files.write(snapshot, "s".getBytes(StandardCharsets.UTF_8));
            Files.write(stream, "t".getBytes(StandardCharsets.UTF_8));

            setTime(messages, now - 3 * DAY);
            setTime(snapshot, now - 2 * DAY);
            setTime(stream, now - DAY);
            setTime(dir, now - 5 * DAY);

            Assertions.assertEquals(stream.toFile().lastModified(),
                    WebController.lastActivityOf(dir.toFile(), "work-aaa"),
                    "应取数据文件 mtime 的最大值（stream），不能回落到更旧的目录 mtime");
        } finally {
            deleteRecursively(base);
        }
    }

    /** 回归：目录内无关条目（如 uploads/账本）刷新了目录 mtime，不得被当成「刚刚更新」。 */
    @Test
    public void testLastActivityIgnoresNewerDirMtime() throws Exception {
        Path base = Files.createTempDirectory("list-time-dirtouch");
        try {
            Path dir = base.resolve("work-bbb");
            Files.createDirectories(dir);
            long now = System.currentTimeMillis();

            Path messages = dir.resolve("work-bbb.messages.ndjson");
            Path snapshot = dir.resolve("work-bbb.snapshot.json");
            Files.write(messages, "m".getBytes(StandardCharsets.UTF_8));
            Files.write(snapshot, "s".getBytes(StandardCharsets.UTF_8));
            setTime(messages, now - 3 * DAY);
            setTime(snapshot, now - 3 * DAY);

            // 模拟「传附件/建账本」：目录内新增条目把目录 mtime 顶到最新
            Files.createDirectories(dir.resolve("uploads"));
            setTime(dir, now);

            long actual = WebController.lastActivityOf(dir.toFile(), "work-bbb");
            Assertions.assertEquals(messages.toFile().lastModified(), actual,
                    "目录 mtime 被无关条目刷新时，列表时间仍应取数据文件");
            Assertions.assertNotEquals(dir.toFile().lastModified(), actual,
                    "目录 mtime 不得参与最后活动时间计算");
        } finally {
            deleteRecursively(base);
        }
    }

    /** 无任何数据文件（异常/空会话）时回退目录 mtime，与旧行为一致。 */
    @Test
    public void testLastActivityFallsBackToDirMtimeWithoutDataFiles() throws Exception {
        Path base = Files.createTempDirectory("list-time-fallback");
        try {
            Path dir = base.resolve("work-ccc");
            Files.createDirectories(dir);
            Files.write(dir.resolve("label.txt"), "x".getBytes(StandardCharsets.UTF_8));

            setTime(dir, System.currentTimeMillis() - 2 * DAY);
            Assertions.assertEquals(dir.toFile().lastModified(),
                    WebController.lastActivityOf(dir.toFile(), "work-ccc"),
                    "无数据文件时应回退目录 mtime");
        } finally {
            deleteRecursively(base);
        }
    }

    /** 只有部分数据文件（如仅 stream 的中途会话）时，取已存在文件的最大 mtime。 */
    @Test
    public void testLastActivityToleratesPartialDataFiles() throws Exception {
        Path base = Files.createTempDirectory("list-time-partial");
        try {
            Path dir = base.resolve("work-ddd");
            Files.createDirectories(dir);
            long now = System.currentTimeMillis();

            Path stream = dir.resolve("work-ddd.stream.ndjson");
            Files.write(stream, "t".getBytes(StandardCharsets.UTF_8));
            setTime(stream, now - DAY);

            Assertions.assertEquals(stream.toFile().lastModified(),
                    WebController.lastActivityOf(dir.toFile(), "work-ddd"),
                    "仅部分数据文件存在时，应取已存在文件的最大 mtime");
        } finally {
            deleteRecursively(base);
        }
    }

    /** 源码形态：列表 time 与排序必须同源走 lastActivityOf，且不得回改目录 mtime。 */
    @Test
    public void source_shape_guards() throws IOException {
        String src = readSource("gourd-ai-agent/src/main/java/com/gourdai/core/portal/web/WebController.java");

        Assertions.assertTrue(src.contains("item.put(\"time\", lastActivityOf(dir, sid))"),
                "time 字段必须取最后活动时间");
        Assertions.assertTrue(src.contains("lastActivityOf(d, d.getName())"),
                "排序必须与 time 同源（lastActivityOf）");
        Assertions.assertFalse(src.contains("item.put(\"time\", dir.lastModified())"),
                "不得回改目录 mtime 作为列表时间");
        Assertions.assertFalse(src.contains("Comparator.comparingLong(File::lastModified)"),
                "不得回改目录 mtime 排序");
    }

    private static void setTime(Path path, long millis) throws IOException {
        Files.setLastModifiedTime(path, FileTime.fromMillis(millis));
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
