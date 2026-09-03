package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;

import java.io.File;
import java.nio.file.Files;
import java.util.Collections;

import static org.junit.jupiter.api.Assertions.*;

class SteerProtocolTest {
    @Test void webChunkCarriesStructuredItems() {
        SteerEnvelope item = new SteerEnvelope("s1", "补充要求", "r1", 123L);
        WebChunk chunk = WebChunk.ofSteerApplied("r1", Collections.singletonList(item));
        ONode json = ONode.ofJson(ONode.serialize(chunk));
        assertEquals("steer_applied", json.get("type").getString());
        assertEquals("s1", json.get("args").get("items").get(0).get("steerId").getString());
        assertEquals("补充要求", json.get("args").get("items").get(0).get("text").getString());
    }

    @Test void droppedQueueIsIdempotentBySteerId() throws Exception {
        File dir = Files.createTempDirectory("steer-queue-").toFile();
        QueueFileHelper helper = new QueueFileHelper();
        helper.add(dir, "same", Collections.emptyList(), Collections.emptyList(), "s1");
        helper.add(dir, "same", Collections.emptyList(), Collections.emptyList(), "s1");
        helper.add(dir, "same", Collections.emptyList(), Collections.emptyList(), "s2");
        assertEquals(2, helper.read(dir).size());
    }
}
