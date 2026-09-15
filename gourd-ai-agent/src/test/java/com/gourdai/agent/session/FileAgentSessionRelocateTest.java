package com.gourdai.agent.session;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.solon.ai.chat.message.ChatMessage;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/**
 * FileAgentSession 家目录对齐（relocateIfPristine）测试。
 *
 * <p>覆盖：空会话迁移到目标目录、已落盘会话拒绝迁移、快照存在时拒绝迁移、
 * 迁移到已含历史数据的目录时重载历史、同目录迁移为空操作。</p>
 *
 * @author oisin
 */
public class FileAgentSessionRelocateTest {

    /** 空会话应允许迁移，且迁移后消息落目标目录（旧目录不再写入）。 */
    @Test
    public void testRelocateMovesPristineSession() throws Exception {
        Path base = Files.createTempDirectory("fas-relocate-a");
        try {
            Path dirA = base.resolve("dirA");
            Path dirB = base.resolve("dirB");
            Files.createDirectories(dirA);

            FileAgentSession session = new FileAgentSession("work-r1", dirA.toString());
            Assertions.assertTrue(session.relocateIfPristine(dirB.toFile()), "空会话应允许迁移");

            session.addMessage(List.of(ChatMessage.ofUser("hello")));
            Assertions.assertTrue(dirB.resolve("work-r1.messages.ndjson").toFile().isFile(),
                    "迁移后消息应写入目标目录");
            Assertions.assertFalse(dirA.resolve("work-r1.messages.ndjson").toFile().exists(),
                    "旧目录不应再写消息");
            Assertions.assertEquals(dirB.toFile().getAbsoluteFile(), session.getBaseDir());
        } finally {
            deleteRecursively(base);
        }
    }

    /** 已落盘消息的会话拒绝迁移。 */
    @Test
    public void testRelocateRefusedWhenDataPersisted() throws Exception {
        Path base = Files.createTempDirectory("fas-relocate-b");
        try {
            Path dirA = base.resolve("dirA");
            Path dirB = base.resolve("dirB");
            Files.createDirectories(dirA);

            FileAgentSession session = new FileAgentSession("work-r2", dirA.toString());
            session.addMessage(List.of(ChatMessage.ofUser("hi")));
            Assertions.assertFalse(session.relocateIfPristine(dirB.toFile()), "已落盘会话不得迁移");
            Assertions.assertTrue(dirA.resolve("work-r2.messages.ndjson").toFile().isFile());
            Assertions.assertFalse(dirB.resolve("work-r2.messages.ndjson").toFile().exists());
        } finally {
            deleteRecursively(base);
        }
    }

    /** 存在快照文件的会话拒绝迁移。 */
    @Test
    public void testRelocateRefusedWhenSnapshotExists() throws Exception {
        Path base = Files.createTempDirectory("fas-relocate-c");
        try {
            Path dirA = base.resolve("dirA");
            Path dirB = base.resolve("dirB");
            Files.createDirectories(dirA);
            Files.write(dirA.resolve("work-r3.snapshot.json"), "{}".getBytes(StandardCharsets.UTF_8));

            FileAgentSession session = new FileAgentSession("work-r3", dirA.toString());
            Assertions.assertFalse(session.relocateIfPristine(dirB.toFile()), "存在快照的会话不得迁移");
        } finally {
            deleteRecursively(base);
        }
    }

    /** 迁移到已含历史消息的目录后，应把目标历史重新加载进内存。 */
    @Test
    public void testRelocateReloadsTargetHistory() throws Exception {
        Path base = Files.createTempDirectory("fas-relocate-d");
        try {
            Path dirA = base.resolve("dirA");
            Path dirB = base.resolve("dirB");
            Files.createDirectories(dirA);
            Files.createDirectories(dirB);

            String line1 = ChatMessage.toJson(ChatMessage.ofUser("old-1"));
            String line2 = ChatMessage.toJson(ChatMessage.ofAssistant("old-2"));
            Files.write(dirB.resolve("work-r4.messages.ndjson"),
                    (line1 + "\n" + line2 + "\n").getBytes(StandardCharsets.UTF_8));

            FileAgentSession session = new FileAgentSession("work-r4", dirA.toString());
            Assertions.assertTrue(session.relocateIfPristine(dirB.toFile()));
            Assertions.assertEquals(2, session.getMessages().size(), "迁移到已有数据的目录后应重载历史消息");
        } finally {
            deleteRecursively(base);
        }
    }

    /** 同目录迁移为空操作。 */
    @Test
    public void testRelocateToSameDirIsNoop() throws Exception {
        Path base = Files.createTempDirectory("fas-relocate-e");
        try {
            Path dirA = base.resolve("dirA");
            Files.createDirectories(dirA);
            FileAgentSession session = new FileAgentSession("work-r5", dirA.toString());
            Assertions.assertFalse(session.relocateIfPristine(dirA.toFile()), "同目录迁移应为空操作");
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
