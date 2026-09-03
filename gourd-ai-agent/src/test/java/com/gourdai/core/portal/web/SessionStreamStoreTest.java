package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

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

    private static void delete(Path path) throws Exception {
        if (Files.exists(path)) {
            Files.walk(path).sorted((a, b) -> b.compareTo(a)).forEach(p -> {
                try { Files.deleteIfExists(p); } catch (Exception ignored) { }
            });
        }
    }
}
