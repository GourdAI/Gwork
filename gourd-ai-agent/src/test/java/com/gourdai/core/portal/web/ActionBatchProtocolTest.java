package com.gourdai.core.portal.web;

import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.task.ActionChunk;
import com.gourdai.agent.react.task.ObservationChunk;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.message.ChatMessage;

import java.util.Map;

class ActionBatchProtocolTest {
    @Test
    void mapsIdenticalMetadataForActionStartAndEnd() {
        ReActTrace trace = new ReActTrace();
        ActionChunk start = new ActionChunk(trace, "read", Map.of("file_path", "a.txt"),
                "call-1", "batch-1", 0, 2);
        ObservationChunk end = new ObservationChunk(trace, "read", Map.of("file_path", "a.txt"),
                ChatMessage.ofAssistant("ok"), null, 12L,
                "call-1", "batch-1", 0, 2);

        WebChunk webStart = WebChunk.ofActionStart("read", "read", start.getArgs());
        WebChunk webEnd = WebChunk.ofActionEnd(end.getContent());
        WebStreamBuilder.copyActionMetadata(start, webStart);
        WebStreamBuilder.copyActionMetadata(end, webEnd);

        assertBatch(webStart);
        assertBatch(webEnd);
        Assertions.assertEquals(webStart.getActionId(), webEnd.getActionId());
        Assertions.assertEquals(webStart.getBatchId(), webEnd.getBatchId());
        Assertions.assertEquals(webStart.getBatchIndex(), webEnd.getBatchIndex());
        Assertions.assertEquals(webStart.getBatchSize(), webEnd.getBatchSize());

        ONode json = ONode.ofJson(ONode.serialize(webStart));
        Assertions.assertEquals("call-1", json.get("actionId").getString());
        Assertions.assertEquals("batch-1", json.get("batchId").getString());
        Assertions.assertEquals(0, json.get("batchIndex").getInt());
        Assertions.assertEquals(2, json.get("batchSize").getInt());
    }

    @Test
    void legacyConstructorsKeepBatchMetadataEmpty() {
        ReActTrace trace = new ReActTrace();
        ActionChunk legacyStart = new ActionChunk(trace, "read", Map.of(), "legacy-call");
        ObservationChunk legacyEnd = new ObservationChunk(trace, "read", Map.of(),
                ChatMessage.ofAssistant("ok"), null, 1L, "legacy-call");

        Assertions.assertEquals("legacy-call", legacyStart.getActionId());
        Assertions.assertNull(legacyStart.getBatchId());
        Assertions.assertNull(legacyStart.getBatchIndex());
        Assertions.assertNull(legacyStart.getBatchSize());
        Assertions.assertNull(legacyEnd.getBatchId());
        Assertions.assertNull(legacyEnd.getBatchIndex());
        Assertions.assertNull(legacyEnd.getBatchSize());

        WebChunk web = new WebChunk();
        WebStreamBuilder.copyActionMetadata(legacyStart, web);
        Assertions.assertEquals("legacy-call", web.getActionId());
        Assertions.assertNull(web.getBatchId());
        Assertions.assertNull(web.getBatchIndex());
        Assertions.assertNull(web.getBatchSize());
    }

    private static void assertBatch(WebChunk chunk) {
        Assertions.assertEquals("call-1", chunk.getActionId());
        Assertions.assertEquals("batch-1", chunk.getBatchId());
        Assertions.assertEquals(0, chunk.getBatchIndex());
        Assertions.assertEquals(2, chunk.getBatchSize());
    }
}
