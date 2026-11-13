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
                "title", "用户偏好 Spring 框架",
                "content", "用户偏好使用 Solon 框架开发后端。",
                "time", "2026-01-01 10:00:00",
                "importance", 7));

        data.put("shared", "user_pref_framework", value, 2592000);
        data.updateIndex("shared", "user_pref_framework", "用户偏好 Spring 框架",
                "用户偏好使用 Solon 框架开发后端。", 7, "2026-01-01 10:00:00");

        List<MemorySearchResult> items = data.listAll("shared", 10);
        assertEquals(1, items.size());
        assertEquals("用户偏好 Spring 框架", items.get(0).getTitle());
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

    // ==================== 检索命中回归（P0-3：三域索引） ====================
    //
    // 这些用例针对的是旧实现的真实漏检：索引 token 只来自 content，
    // 于是可识别信号写在 title/key 上的条目「存过却搜不到」。
    // 每条用例都在旧实现下失败、新实现下通过。

    private String fact(String title, String content, int importance) {
        return ONode.serialize(Map.of("title", title, "content", content,
                "time", "2026-01-01 10:00:00", "importance", importance));
    }

    /**
     * 只在标题里出现的词必须可检索。
     *
     * <p>这是「命中不准」的直接根因：旧索引只收 content 的分词，标题里的
     * 「滚动条统一方案」从未进入索引，query「滚动条统一」返回空列表，
     * 模型据此认为该记忆不存在并写入重复条目。
     */
    @Test
    void searchesTermsThatAppearOnlyInTheTitle() {
        MemoryMdData data = new MemoryMdData(tempDir);
        data.put("shared", "scrollbar_plan", fact("滚动条统一方案", "正文完全没有提到那个词。", 6), -1);
        data.updateIndex("shared", "scrollbar_plan", "滚动条统一方案", "正文完全没有提到那个词。", 6,
                "2026-01-01 10:00:00");

        List<MemorySearchResult> hits = data.search("shared", "滚动条统一", 10);
        assertEquals(1, hits.size(), "标题词必须可命中");
        assertEquals("scrollbar_plan", hits.get(0).getKey());
    }

    /**
     * 只在 key 里出现的标识符必须可检索。
     *
     * <p>记忆条目的 key 本身就是最强的识别信号（如 {@code credential_affinity_*}），
     * 旧索引完全不含 key，导致按 key 片段搜索必然落空。
     */
    @Test
    void searchesTermsThatAppearOnlyInTheKey() {
        MemoryMdData data = new MemoryMdData(tempDir);
        data.put("shared", "credential_affinity_retry", fact("无关标题", "无关正文。", 5), -1);
        data.updateIndex("shared", "credential_affinity_retry", "无关标题", "无关正文。", 5,
                "2026-01-01 10:00:00");

        assertFalse(data.search("shared", "credential", 10).isEmpty(), "key 标识符片段必须可命中");
        assertFalse(data.search("shared", "affinity", 10).isEmpty());
    }

    /**
     * 多词混合 query 必须命中，而不是被当作一整个子串。
     *
     * <p>对应截图里的失败：「凭证级亲和 retryCodes 429 529 同渠道重试 状态码」
     * 这类 query 在整句子串语义下数学上不可能命中任何条目。
     */
    @Test
    void multiWordQueryMatchesInsteadOfBeingOneSubstring() {
        MemoryMdData data = new MemoryMdData(tempDir);
        String content = "retryCodes 命中 429 与 529 时走同渠道重试。";
        data.put("shared", "credential_affinity", fact("凭证级亲和与重试", content, 8), -1);
        data.updateIndex("shared", "credential_affinity", "凭证级亲和与重试", content, 8,
                "2026-01-01 10:00:00");

        String query = "凭证级亲和 retryCodes 429 529 同渠道重试 状态码";
        // 证明整句确实不是任何字段的子串：旧行为是必然落空，而非排序偶然。
        assertFalse(content.toLowerCase().contains(query.toLowerCase()));

        List<MemorySearchResult> hits = data.search("shared", query, 10);
        assertEquals(1, hits.size(), "多词 query 必须命中");
        assertEquals("credential_affinity", hits.get(0).getKey());
    }

    /**
     * 命中更多 query 词的条目排在前面 —— 否则「搜到了」和「搜对了」无法区分。
     */
    @Test
    void entriesMatchingMoreQueryWordsRankHigher() {
        MemoryMdData data = new MemoryMdData(tempDir);
        data.put("shared", "one_word", fact("只提到构建", "构建相关。", 5), -1);
        data.put("shared", "two_words", fact("构建脚本与缓存", "构建时清理缓存。", 5), -1);
        data.updateIndex("shared", "one_word", "只提到构建", "构建相关。", 5, "2026-01-01 10:00:00");
        data.updateIndex("shared", "two_words", "构建脚本与缓存", "构建时清理缓存。", 5, "2026-01-01 10:00:00");

        List<MemorySearchResult> hits = data.search("shared", "构建 缓存", 10);
        assertEquals(2, hits.size());
        assertEquals("two_words", hits.get(0).getKey(), "同时命中两词的条目必须排第一");
    }

    /**
     * key 完全相等时置顶：标识符查询不会被同词的正文挤掉。
     */
    @Test
    void exactKeyMatchIsPinnedAboveProseHits() {
        MemoryMdData data = new MemoryMdData(tempDir);
        data.put("shared", "build_cache", fact("无关标题", "只有一行。", 1), -1);
        data.put("shared", "other", fact("构建缓存构建缓存构建缓存", "构建缓存反复出现。", 10), -1);
        data.updateIndex("shared", "build_cache", "无关标题", "只有一行。", 1, "2026-01-01 10:00:00");
        data.updateIndex("shared", "other", "构建缓存构建缓存构建缓存", "构建缓存反复出现。", 10,
                "2026-01-01 10:00:00");

        List<MemorySearchResult> hits = data.search("shared", "build_cache", 10);
        assertFalse(hits.isEmpty());
        assertEquals("build_cache", hits.get(0).getKey(), "精确 key 必须优先于高分正文命中");
    }

    /**
     * 同分结果的排序必须稳定。
     *
     * <p>否则会随 {@link java.util.concurrent.ConcurrentHashMap} 的遍历顺序漂移，
     * 在模型看来就是同一个 query 两次返回不同排序、记忆自己在动。
     */
    @Test
    void equalScoresAreOrderedDeterministically() {
        MemoryMdData data = new MemoryMdData(tempDir);
        for (String key : List.of("zzz", "aaa", "mmm")) {
            data.put("shared", key, fact("同样的标题", "同样的正文", 5), -1);
            data.updateIndex("shared", key, "同样的标题", "同样的正文", 5, "2026-01-01 10:00:00");
        }

        List<String> first = data.search("shared", "同样", 10).stream()
                .map(MemorySearchResult::getKey).toList();
        for (int i = 0; i < 3; i++) {
            List<String> again = data.search("shared", "同样", 10).stream()
                    .map(MemorySearchResult::getKey).toList();
            assertEquals(first, again, "同 query 的排序必须跨调用稳定");
        }
        assertEquals(List.of("aaa", "mmm", "zzz"), first, "同分按 key 升序兜底");
    }

    /**
     * 无可索引内容的 query（单个 ASCII 字母）退化为子串探测，而不是返回空。
     */
    @Test
    void singleCharacterQueryFallsBackToSubstringProbe() {
        MemoryMdData data = new MemoryMdData(tempDir);
        data.put("shared", "k", fact("abc", "body", 5), -1);
        data.updateIndex("shared", "k", "abc", "body", 5, "2026-01-01 10:00:00");

        assertEquals(1, data.search("shared", "b", 10).size());
    }

    /**
     * 稍有偏差的片段应降权而非丢弃。
     *
     * <p>「构建脚」是「构建脚本」的子串，却不是它的任何 bi-gram，
     * 精确 token 匹配看不见它 —— 子串兜底这一步保证了它仍然在结果里。
     */
    @Test
    void nearMissFragmentIsDemotedNotDropped() {
        MemoryMdData data = new MemoryMdData(tempDir);
        data.put("shared", "a", fact("构建脚本", "body", 5), -1);
        data.updateIndex("shared", "a", "构建脚本", "body", 5, "2026-01-01 10:00:00");

        assertFalse(data.search("shared", "构建脚", 10).isEmpty(), "近似片段仍应命中");
    }

    /**
     * 检索必须大小写不敏感（中英文混排场景下模型经常改换大小写）。
     */
    @Test
    void searchIsCaseInsensitive() {
        MemoryMdData data = new MemoryMdData(tempDir);
        data.put("shared", "Mixed_Case_Key", fact("Rust Kernel", "Tokio runtime notes.", 5), -1);
        data.updateIndex("shared", "Mixed_Case_Key", "Rust Kernel", "Tokio runtime notes.", 5,
                "2026-01-01 10:00:00");

        assertEquals(1, data.search("shared", "RUST KERNEL", 10).size());
        assertEquals(1, data.search("shared", "tokio", 10).size());
    }

    /**
     * 不相关 query 必须返回空，不能因为扩了三域就变成"什么都命中"。
     *
     * <p>这是扩展索引的反向护栏：召回率提升不能以精确率崩塌为代价。
     */
    @Test
    void unrelatedQueryStillReturnsNothing() {
        MemoryMdData data = new MemoryMdData(tempDir);
        data.put("shared", "build_plan", fact("构建脚本", "npm run build 的坑", 5), -1);
        data.updateIndex("shared", "build_plan", "构建脚本", "npm run build 的坑", 5,
                "2026-01-01 10:00:00");

        assertTrue(data.search("shared", "完全不相关的查询词", 10).isEmpty());
        assertTrue(data.search("shared", "kubernetes", 10).isEmpty());
    }
}
