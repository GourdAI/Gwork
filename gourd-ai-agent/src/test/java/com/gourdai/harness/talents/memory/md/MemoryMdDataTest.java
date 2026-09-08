package com.gourdai.harness.talents.memory.md;

import com.gourdai.harness.talents.memory.MemorySearchResult;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.snack4.ONode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

class MemoryMdDataTest {
    @TempDir
    Path tempDir;

    @Test
    void persistsTitleAndExpirationMetadata() {
        MemoryMdData data = new MemoryMdData(tempDir);
        String value = ONode.serialize(Map.of(
                "title", "用户偏好 Solon 框架",
                "content", "用户偏好使用 Solon 框架开发后端。",
                "time", "2026-01-01 10:00:00",
                "importance", 7));

        data.put("shared", "user_pref_framework", value, 2592000);
        data.updateIndex("shared", "user_pref_framework", "用户偏好 Solon 框架",
                "用户偏好使用 Solon 框架开发后端。", 7, "2026-01-01 10:00:00");

        List<MemorySearchResult> items = data.listAll("shared", 10);
        assertEquals(1, items.size());
        assertEquals("用户偏好 Solon 框架", items.get(0).getTitle());
        assertEquals(2592000, items.get(0).getTtl());
        assertNotNull(items.get(0).getStoredTime());
        assertTrue(data.get("shared", "user_pref_framework").contains("\"title\""));
    }

    @Test
    void oldFileFallsBackToFirstSentenceInsteadOfKey() throws Exception {
        Files.writeString(tempDir.resolve("shared__snake_case_key.md"), "---\n"
                + "name: \"shared__snake_case_key\"\n"
                + "time: \"2026-01-01 10:00:00\"\n"
                + "importance: 4\n"
                + "ttl: -1\n"
                + "stored_at: \"2026-01-01 10:00:00\"\n"
                + "---\n\n"
                + "用户喜欢简洁直接的回答。后续不要展开无关背景。\n");

        MemoryMdData data = new MemoryMdData(tempDir);
        MemorySearchResult item = data.listAll("shared", 10).get(0);
        assertEquals("用户喜欢简洁直接的回答。", item.getTitle());
        assertNotEquals(item.getKey(), item.getTitle());
    }

    @Test
    void deleteFailureKeepsMemoryVisibleAndThrows() throws Exception {
        MemoryMdData data = new MemoryMdData(tempDir);
        String value = ONode.serialize(Map.of("title", "可靠删除", "content", "删除失败不能假成功。",
                "time", "2026-01-01 10:00:00", "importance", 8));
        data.put("shared", "delete_reliability", value, -1);
        data.updateIndex("shared", "delete_reliability", "可靠删除", "删除失败不能假成功。", 8,
                "2026-01-01 10:00:00");

        Path file = tempDir.resolve("shared__delete_reliability.md");
        Files.delete(file);
        Files.createDirectory(file);
        Files.writeString(file.resolve("lock"), "locked");

        assertThrows(IllegalStateException.class, () -> data.remove("shared", "delete_reliability"));
        assertEquals(1, data.listAll("shared", 10).size());
        assertNotNull(data.get("shared", "delete_reliability"));
    }

    @Test
    void rejectsPathEscapingKeysAndUserIds() {
        MemoryMdData data = new MemoryMdData(tempDir);
        String value = ONode.serialize(Map.of("content", "safe", "time", "2026-01-01 10:00:00", "importance", 5));

        for (String key : List.of("../escape", "..", "a/b", "a\\b", "/absolute", "C:\\absolute")) {
            assertThrows(IllegalArgumentException.class, () -> data.put("shared", key, value, -1), key);
            assertThrows(IllegalArgumentException.class, () -> data.get("shared", key), key);
            assertThrows(IllegalArgumentException.class, () -> data.remove("shared", key), key);
        }
        assertThrows(IllegalArgumentException.class, () -> data.put("../shared", "safe_key", value, -1));
        assertFalse(Files.exists(tempDir.getParent().resolve("escape.md")));
    }

    @Test
    void ignoresFrontMatterNameThatDoesNotMatchItsFile() throws Exception {
        Files.writeString(tempDir.resolve("shared__safe.md"), "---\n"
                + "name: \"shared__../escaped\"\n"
                + "time: \"2026-01-01 10:00:00\"\n"
                + "importance: 9\n"
                + "ttl: -1\n"
                + "---\n\nmalicious\n");

        MemoryMdData data = new MemoryMdData(tempDir);
        assertTrue(data.listAll("shared", 10).isEmpty());
        assertNull(data.get("shared", "safe"));
    }

    @Test
    void realtimeQueriesFilterExpiredEntries() throws Exception {
        MemoryMdData data = new MemoryMdData(tempDir);
        String value = ONode.serialize(Map.of("title", "短期记忆", "content", "很快过期的内容",
                "time", "2026-01-01 10:00:00", "importance", 8));
        data.put("shared", "short_lived", value, 1);
        data.updateIndex("shared", "short_lived", "短期记忆", "很快过期的内容", 8,
                "2026-01-01 10:00:00");

        Thread.sleep(1200L);
        assertTrue(data.search("shared", "过期", 10).isEmpty());
        assertTrue(data.getHotMemories("shared", 10).isEmpty());
        assertTrue(data.listAll("shared", 10).isEmpty());
        assertNull(data.get("shared", "short_lived"));
    }

    @Test
    void oldTtlFallsBackToFactTimeThenFileMtime() throws Exception {
        Path factTimeFile = tempDir.resolve("shared__fact_time.md");
        Files.writeString(factTimeFile, legacyTtlFile("shared__fact_time", "2000-01-01 00:00:00"));

        Path mtimeFile = tempDir.resolve("shared__mtime.md");
        Files.writeString(mtimeFile, legacyTtlFile("shared__mtime", "invalid"));
        Files.setLastModifiedTime(mtimeFile, FileTime.from(Instant.parse("2000-01-01T00:00:00Z")));

        MemoryMdData data = new MemoryMdData(tempDir);
        assertTrue(data.listAll("shared", 10).isEmpty());
        assertFalse(Files.exists(factTimeFile));
        assertFalse(Files.exists(mtimeFile));
    }

    @Test
    void rejectsSymlinkStorageRootAndTargetFile() throws Exception {
        Path realRoot = tempDir.resolve("real");
        Files.createDirectory(realRoot);
        Path linkedRoot = tempDir.resolve("linked");
        try {
            Files.createSymbolicLink(linkedRoot, realRoot);
        } catch (UnsupportedOperationException | java.nio.file.FileSystemException | SecurityException e) {
            Assumptions.assumeTrue(false, "Symbolic links are not supported or permitted: " + e.getMessage());
        }
        assertThrows(IllegalArgumentException.class, () -> new MemoryMdData(linkedRoot));

        MemoryMdData data = new MemoryMdData(realRoot);
        Path outside = tempDir.resolve("outside.md");
        Files.writeString(outside, "outside");
        Files.createSymbolicLink(realRoot.resolve("shared__linked.md"), outside);
        String value = ONode.serialize(Map.of("content", "must not escape", "time", "2026-01-01 10:00:00", "importance", 5));
        assertThrows(IllegalStateException.class, () -> data.put("shared", "linked", value, -1));
        assertEquals("outside", Files.readString(outside));
    }

    @Test
    void clearSerializesWithConcurrentPutAndLeavesConsistentState() throws Exception {
        MemoryMdData data = new MemoryMdData(tempDir);
        String value = ONode.serialize(Map.of("content", "concurrent", "time", "2026-01-01 10:00:00", "importance", 5));
        for (int i = 0; i < 20; i++) data.put("shared", "old_" + i, value, -1);

        CountDownLatch start = new CountDownLatch(1);
        Thread writer = new Thread(() -> {
            try {
                start.await();
                data.put("shared", "new_entry", value, -1);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        writer.start();
        start.countDown();
        data.clear("shared");
        writer.join(TimeUnit.SECONDS.toMillis(5));
        assertFalse(writer.isAlive());

        MemoryMdData reloaded = new MemoryMdData(tempDir);
        assertEquals(data.count("shared"), reloaded.count("shared"));
        assertEquals(data.listAll("shared", Integer.MAX_VALUE).stream().map(MemorySearchResult::getKey).sorted().toList(),
                reloaded.listAll("shared", Integer.MAX_VALUE).stream().map(MemorySearchResult::getKey).sorted().toList());
    }

    private String legacyTtlFile(String name, String time) {
        return "---\nname: \"" + name + "\"\ntime: \"" + time + "\"\nimportance: 8\nttl: 1\n---\n\nlegacy ttl\n";
    }
}
