package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

class SessionStreamStoreTest {
    @Test
    void assignsMonotonicSequencesAndLoadsExclusiveRange() throws Exception {
        Path workspace = Files.createTempDirectory("stream-store-test");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-seq-test";
            store.recordUser(sid, null, "hello", 1L);
            store.record(sid, null, WebChunk.ofText("a"));
            store.record(sid, null, WebChunk.ofDone());

            SessionStreamStore.LoadResult all = store.loadAfter(sid, null, 0L, 20);
            Assertions.assertEquals(3, all.events.size());
            Assertions.assertEquals(1L, ((Number) all.events.get(0).get("eventSeq")).longValue());
            Assertions.assertEquals(3L, ((Number) all.events.get(2).get("eventSeq")).longValue());
            Assertions.assertEquals(3L, all.latestSeq);

            SessionStreamStore.LoadResult afterOne = store.loadAfter(sid, null, 1L, 20);
            Assertions.assertEquals(2, afterOne.events.size());
            Assertions.assertEquals(2L, ((Number) afterOne.events.get(0).get("eventSeq")).longValue());
            Assertions.assertEquals(3L, afterOne.lastSeq);

            SessionStreamStore.LoadResult paged = store.loadAfter(sid, null, 0L, 1);
            Assertions.assertEquals(1, paged.events.size());
            Assertions.assertTrue(paged.hasMore);
            Assertions.assertEquals(3, paged.totalCount);

            store.rewindTurns(sid, null, 1);
            store.record(sid, null, WebChunk.ofText("new"));
            SessionStreamStore.LoadResult afterRewind = store.loadAfter(sid, null, 3L, 20);
            Assertions.assertEquals(1, afterRewind.events.size());
            Assertions.assertEquals(4L, ((Number) afterRewind.events.get(0).get("eventSeq")).longValue());
        } finally {
            delete(workspace);
        }
    }

    @Test
    void isolatesSameSessionIdAcrossWorkspacesAndPersistsClientMessageId() throws Exception {
        Path workspace = Files.createTempDirectory("stream-store-roots");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            Path rootA = Files.createDirectories(workspace.resolve("a"));
            Path rootB = Files.createDirectories(workspace.resolve("b"));
            String sid = "work-same-id";

            store.recordUser(sid, rootA.toString(), "a", 1L, "client-a");
            store.recordUser(sid, rootB.toString(), "b", 2L, "client-b");

            SessionStreamStore.LoadResult a = store.loadAfter(sid, rootA.toString(), 0L, 20);
            SessionStreamStore.LoadResult b = store.loadAfter(sid, rootB.toString(), 0L, 20);
            Assertions.assertEquals("a", a.events.get(0).get("text"));
            Assertions.assertEquals("client-a", a.events.get(0).get("clientMessageId"));
            Assertions.assertEquals(1L, ((Number) a.events.get(0).get("eventSeq")).longValue());
            Assertions.assertEquals("b", b.events.get(0).get("text"));
            Assertions.assertEquals(1L, ((Number) b.events.get(0).get("eventSeq")).longValue());
        } finally {
            delete(workspace);
        }
    }

    @Test
    void persistsAndReplaysActionBatchMetadata() throws Exception {
        Path workspace = Files.createTempDirectory("stream-store-batch");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-batch-test";

            WebChunk start = WebChunk.ofActionStart("read", "read", Map.of("file_path", "a.txt"));
            start.setActionId("call-1");
            start.setBatchId("batch-1");
            start.setBatchIndex(0);
            start.setBatchSize(2);
            store.record(sid, null, start);

            WebChunk end = WebChunk.ofActionEnd("ok");
            end.setActionId("call-1");
            end.setBatchId("batch-1");
            end.setBatchIndex(0);
            end.setBatchSize(2);
            store.record(sid, null, end);

            SessionStreamStore.LoadResult loaded = store.loadAfter(sid, null, 0L, 20);
            Assertions.assertEquals(2, loaded.events.size());
            for (Map event : loaded.events) {
                Assertions.assertEquals("call-1", event.get("actionId"));
                Assertions.assertEquals("batch-1", event.get("batchId"));
                Assertions.assertEquals(0, ((Number) event.get("batchIndex")).intValue());
                Assertions.assertEquals(2, ((Number) event.get("batchSize")).intValue());
            }
        } finally {
            delete(workspace);
        }
    }

    @Test
    void dedupesFileChangesByRunOnRead() throws Exception {
        Path workspace = Files.createTempDirectory("stream-store-file-changes");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-file-changes";

            WebChunk first = WebChunk.ofFileChanges("run-1", Map.of("revision", 1, "fileCount", 1));
            WebChunk second = WebChunk.ofFileChanges("run-1", Map.of("revision", 2, "fileCount", 2));
            store.record(sid, null, first);
            store.record(sid, null, second);

            // 写入侧恒为纯追加（O(1)，不重写整个 ndjson）：磁盘上应存在两帧
            Path streamFile = locator.resolveDir(sid, null).toPath()
                    .resolve(sid + SessionStreamStore.STREAM_SUFFIX);
            Assertions.assertEquals(2, Files.readAllLines(streamFile).stream()
                    .filter(l -> !l.trim().isEmpty()).count());

            // 读取侧按 runId 去重，只得到 eventSeq 最大的终态摘要
            SessionStreamStore.LoadResult loaded = store.loadAfter(sid, null, 0L, 20);
            Assertions.assertEquals(1, loaded.events.size());
            Assertions.assertEquals("file_changes", loaded.events.get(0).get("type"));
            Assertions.assertEquals(2, ((Number) ((Map) loaded.events.get(0).get("args")).get("revision")).intValue());
            Assertions.assertEquals(2L, ((Number) loaded.events.get(0).get("eventSeq")).longValue());

            SessionStreamStore.LoadResult full = store.loadWithMeta(sid, null, null);
            Assertions.assertEquals(1, full.events.size());
            Assertions.assertEquals(2, ((Number) ((Map) full.events.get(0).get("args")).get("revision")).intValue());
        } finally {
            delete(workspace);
        }
    }

    @Test
    void loadsLegacyEventsWithoutBatchFields() throws Exception {
        Path workspace = Files.createTempDirectory("stream-store-legacy-batch");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-legacy-batch";
            Path sessionDir = locator.resolveDir(sid, null).toPath();
            Files.createDirectories(sessionDir);
            Files.writeString(sessionDir.resolve(sid + SessionStreamStore.STREAM_SUFFIX),
                    "{\"type\":\"action_start\",\"actionId\":\"legacy-call\",\"eventSeq\":1}\n");

            SessionStreamStore.LoadResult loaded = store.loadAfter(sid, null, 0L, 20);
            Assertions.assertEquals(1, loaded.events.size());
            Assertions.assertEquals("legacy-call", loaded.events.get(0).get("actionId"));
            Assertions.assertFalse(loaded.events.get(0).containsKey("batchId"));
            Assertions.assertFalse(loaded.events.get(0).containsKey("batchIndex"));
            Assertions.assertFalse(loaded.events.get(0).containsKey("batchSize"));
        } finally {
            delete(workspace);
        }
    }

    @Test
    void rewindMatchesOddAndEvenMessageCounts() throws Exception {
        for (int count = 1; count <= 4; count++) {
            Path workspace = Files.createTempDirectory("stream-store-rewind-" + count);
            try {
                SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
                SessionStreamStore store = new SessionStreamStore(locator);
                String sid = "work-rewind-" + count;
                store.recordUser(sid, null, "u1", 1L);
                store.record(sid, null, WebChunk.ofText("a1"));
                store.recordUser(sid, null, "u2", 2L);
                store.record(sid, null, WebChunk.ofText("a2"));

                int retainedMessages = 4 - count;
                int retainedUsers = retainedMessages == 0 ? 0 : (retainedMessages + 1) / 2;
                boolean trailingUserOnly = retainedMessages % 2 == 1;
                store.rewindToMessageState(sid, null, retainedUsers, trailingUserOnly);

                SessionStreamStore.LoadResult loaded = store.loadAfter(sid, null, 0L, 20);
                Assertions.assertEquals(retainedMessages, loaded.events.size(), "count=" + count);
                if (retainedMessages > 0) {
                    Assertions.assertEquals("user", loaded.events.get(0).get("type"));
                }
                if (trailingUserOnly) {
                    Assertions.assertEquals("user", loaded.events.get(loaded.events.size() - 1).get("type"));
                }
            } finally {
                delete(workspace);
            }
        }
    }

    @Test
    void concurrentAppendAndReadNeverExposePartialLines() throws Exception {
        Path workspace = Files.createTempDirectory("stream-store-concurrent");
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-concurrent";
            CountDownLatch start = new CountDownLatch(1);
            Future<?> writer = pool.submit(() -> {
                await(start);
                for (int i = 0; i < 200; i++) store.record(sid, null, WebChunk.ofText("v" + i));
            });
            Future<?> reader = pool.submit(() -> {
                await(start);
                while (!writer.isDone()) {
                    SessionStreamStore.LoadResult loaded = store.loadAfter(sid, null, 0L, 1000);
                    for (Map event : loaded.events) {
                        Assertions.assertNotNull(event.get("type"));
                        Assertions.assertNotNull(event.get("eventSeq"));
                    }
                }
            });
            start.countDown();
            writer.get(20, TimeUnit.SECONDS);
            reader.get(20, TimeUnit.SECONDS);

            SessionStreamStore.LoadResult loaded = store.loadAfter(sid, null, 0L, 1000);
            Assertions.assertEquals(200, loaded.events.size());
            Set<Long> sequences = new HashSet<>();
            for (Map event : loaded.events) sequences.add(((Number) event.get("eventSeq")).longValue());
            Assertions.assertEquals(200, sequences.size());
            Assertions.assertEquals(200L, loaded.latestSeq);
        } finally {
            pool.shutdownNow();
            delete(workspace);
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RuntimeException(e);
        }
    }

    private static void delete(Path path) throws Exception {
        if (Files.exists(path)) {
            Files.walk(path).sorted((a, b) -> b.compareTo(a)).forEach(p -> {
                try { Files.deleteIfExists(p); } catch (Exception ignored) { }
            });
        }
    }
}
