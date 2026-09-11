package com.gourdai.core.portal.web;

import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.event.ToolCallStartEvent;
import com.gourdai.agent.event.ToolCallEndEvent;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.message.ChatMessage;

import java.util.LinkedHashMap;
import java.util.Map;

import static com.gourdai.harness.agent.WebToolVisibilityPolicy.*;

class ActionBatchProtocolTest {
    @Test
    void mapsIdenticalMetadataForActionStartAndEnd() {
        ReActTrace trace = new ReActTrace();
        ToolCallStartEvent start = new ToolCallStartEvent(trace, "read", Map.of("file_path", "a.txt"),
                "call-1", "batch-1", 0, 2);
        ToolCallEndEvent end = new ToolCallEndEvent(trace, "read", Map.of("file_path", "a.txt"),
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
    void visibilityMatrixKeepsTodoAsymmetricAndHidesInternalTools() {
        Assertions.assertTrue(isBaseVisible("read"));
        Assertions.assertTrue(isStartVisible("read"));
        Assertions.assertTrue(isFailedEndVisible("read"));
        Assertions.assertTrue(isBaseVisible("todowrite"));
        Assertions.assertFalse(isStartVisible("todowrite"));
        Assertions.assertFalse(isFailedEndVisible("todowrite"));
        Assertions.assertFalse(isBaseVisible("task"));
        Assertions.assertFalse(isBaseVisible("multitask"));
        Assertions.assertFalse(isBaseVisible("memory_search"));
        Assertions.assertFalse(isBaseVisible(null));
    }

    @Test
    void commonProjectionCopiesArgsAndSubagentMetadataDefensively() {
        ReActTrace trace = new ReActTrace();
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("file_path", "a.txt");
        ToolCallStartEvent start = new ToolCallStartEvent(trace, "read", args, "call-2", "batch-2", 1, 2);
        start.getMeta().put("__parentAgentName", "explore");
        start.getMeta().put("__parentAgentDesc", "inspect");
        start.getMeta().put("__invocationId", "invoke-2");

        WebChunk projected = new WebChunk();
        WebStreamBuilder.projectToolCommon(start, projected, "main", "explore");

        Assertions.assertEquals("read", projected.getToolName());
        Assertions.assertEquals("explore/read", projected.getToolTitle());
        Assertions.assertEquals("a.txt", projected.getArgs().get("file_path"));
        Assertions.assertEquals("explore", projected.getArgs().get("agentName"));
        Assertions.assertEquals("inspect", projected.getArgs().get("agentDesc"));
        Assertions.assertEquals("invoke-2", projected.getArgs().get("invocationId"));
        Assertions.assertNotSame(args, projected.getArgs());
    }

    @Test
    void commonProjectionUsesMainTitleAndNormalizesNullArgs() {
        ReActTrace trace = new ReActTrace();
        ToolCallEndEvent end = new ToolCallEndEvent(trace, "read", null,
                ChatMessage.ofAssistant("failed"), new RuntimeException("failed"), 7L,
                "call-3", "batch-3", 0, 2);
        WebChunk projected = WebChunk.ofActionEnd("failed", 7L);

        WebStreamBuilder.projectToolCommon(end, projected, "main", "main");

        Assertions.assertEquals("read", projected.getToolName());
        Assertions.assertEquals("read", projected.getToolTitle());
        Assertions.assertNotNull(projected.getArgs());
        Assertions.assertTrue(projected.getArgs().isEmpty());
        assertCommonMetadata(projected, "call-3", "batch-3", 0, 2);
    }

    @Test
    void legacyConstructorsKeepBatchMetadataEmpty() {
        ReActTrace trace = new ReActTrace();
        ToolCallStartEvent legacyStart = new ToolCallStartEvent(trace, "read", Map.of(), "legacy-call");
        ToolCallEndEvent legacyEnd = new ToolCallEndEvent(trace, "read", Map.of(),
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
        assertCommonMetadata(chunk, "call-1", "batch-1", 0, 2);
    }

    private static void assertCommonMetadata(WebChunk chunk, String actionId, String batchId,
                                             Integer batchIndex, Integer batchSize) {
        Assertions.assertEquals(actionId, chunk.getActionId());
        Assertions.assertEquals(batchId, chunk.getBatchId());
        Assertions.assertEquals(batchIndex, chunk.getBatchIndex());
        Assertions.assertEquals(batchSize, chunk.getBatchSize());
    }
}
