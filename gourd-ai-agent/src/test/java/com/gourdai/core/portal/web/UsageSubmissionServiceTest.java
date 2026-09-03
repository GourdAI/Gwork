package com.gourdai.core.portal.web;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import org.noear.solon.ai.AiUsage;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

class UsageSubmissionServiceTest {
    private static final String ENDPOINT = "gwork.usage.endpoint";
    private static final String TOKEN = "gwork.usage.client-token";

    @AfterEach
    void clearProperties() {
        System.clearProperty(ENDPOINT);
        System.clearProperty(TOKEN);
    }

    private static AiUsage usage() {
        return new AiUsage(5, 0, 30, 65, 20, 10, null);
    }

    @Test
    void recordsStableSignedBatch() throws Exception {
        Path root = Files.createTempDirectory("usage-submit");
        try {
            UsageSubmissionService service = new UsageSubmissionService(root);
            long at = Instant.now().minus(2, ChronoUnit.HOURS).toEpochMilli();
            service.record("model-a", usage(), at);
            service.record("model-a", usage(), at);
            service.submitDueBatches();
            Path batch = Files.list(service.getOutboxDirectory()).findFirst().orElseThrow();
            ONode outbox = ONode.ofJson(Files.readString(batch));
            ONode payload = ONode.ofJson(outbox.get("payloadText").getString());
            ONode model = payload.get("models").get(0);
            Assertions.assertEquals(70L, model.get("inputTokens").getLong());
            Assertions.assertEquals(60L, model.get("outputTokens").getLong());
            Assertions.assertEquals(40L, model.get("cacheCreationTokens").getLong());
            Assertions.assertEquals(20L, model.get("cacheReadTokens").getLong());
            Assertions.assertEquals(2, model.get("eventIds").size());
            Assertions.assertEquals("Ed25519", outbox.get("signatureAlgorithm").getString());
            verifySignature(outbox);
            Assertions.assertEquals(1, Files.list(service.getOutboxDirectory()).count());
        } finally { delete(root); }
    }

    @Test
    void submitsExactPayloadWithTokenAndRetriesExistingOutbox() throws Exception {
        Path root = Files.createTempDirectory("usage-submit-http");
        HttpServer server = HttpServer.create(new InetSocketAddress(0), 0);
        AtomicInteger requests = new AtomicInteger();
        AtomicReference<String> body = new AtomicReference<>();
        AtomicReference<String> token = new AtomicReference<>();
        AtomicReference<String> publicKey = new AtomicReference<>();
        AtomicReference<String> signature = new AtomicReference<>();
        server.createContext("/usage", exchange -> {
            requests.incrementAndGet();
            body.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            token.set(exchange.getRequestHeaders().getFirst("X-GWork-Client-Token"));
            publicKey.set(exchange.getRequestHeaders().getFirst("X-GWork-Public-Key"));
            signature.set(exchange.getRequestHeaders().getFirst("X-GWork-Signature"));
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        server.start();
        try {
            System.setProperty(ENDPOINT, "http://127.0.0.1:" + server.getAddress().getPort() + "/usage");
            System.setProperty(TOKEN, "test-token");
            UsageSubmissionService service = new UsageSubmissionService(root);
            service.record("model-a", usage(), Instant.now().minus(2, ChronoUnit.HOURS).toEpochMilli());
            service.submitDueBatches();
            Assertions.assertEquals(1, requests.get());
            Assertions.assertEquals("test-token", token.get());
            Assertions.assertNotNull(body.get());
            Assertions.assertTrue(body.get().contains("\"batchId\""));
            Assertions.assertTrue(body.get().contains("\"deviceId\""));
            verifySignature(body.get(), publicKey.get(), signature.get());
            Files.delete(service.getEventsFile());
            service.submitDueBatches();
            Assertions.assertEquals(1, requests.get());
            Assertions.assertEquals(1, Files.list(service.getOutboxDirectory()).count());
        } finally { server.stop(0); delete(root); }
    }

    @Test
    void invalidAndNegativeEventsAreNotRecorded() throws Exception {
        Path root = Files.createTempDirectory("usage-submit-invalid");
        try {
            UsageSubmissionService service = new UsageSubmissionService(root);
            service.record(" https://example.invalid ", usage(), 1);
            service.record("valid", usage(), 0);
            Assertions.assertFalse(Files.exists(service.getEventsFile()));
        } finally { delete(root); }
    }

    @Test
    void damagedKeyDoesNotMakeOldOutboxImpersonateNewDevice() throws Exception {
        Path root = Files.createTempDirectory("usage-submit-key");
        try {
            UsageSubmissionService first = new UsageSubmissionService(root);
            first.record("old", usage(), Instant.now().minus(2, ChronoUnit.HOURS).toEpochMilli());
            first.submitDueBatches();
            String oldDevice = first.getDeviceId();
            Files.writeString(root.resolve("device-key.json"), "damaged");
            UsageSubmissionService restarted = new UsageSubmissionService(root);
            Assertions.assertNotEquals(oldDevice, restarted.getDeviceId());
            System.setProperty(ENDPOINT, "http://127.0.0.1:1/");
            System.setProperty(TOKEN, "token");
            restarted.submitDueBatches();
            Assertions.assertEquals(oldDevice, org.noear.snack4.ONode.ofJson(
                    Files.readString(Files.list(restarted.getOutboxDirectory()).findFirst().orElseThrow()))
                    .get("deviceId").getString());
        } finally { delete(root); }
    }

    @Test
    void permanentFailureIsNotRetried() throws Exception {
        Path root = Files.createTempDirectory("usage-submit-4xx");
        HttpServer server = HttpServer.create(new InetSocketAddress(0), 0);
        AtomicInteger requests = new AtomicInteger();
        server.createContext("/usage", exchange -> {
            requests.incrementAndGet(); exchange.sendResponseHeaders(400, -1); exchange.close();
        });
        server.start();
        try {
            System.setProperty(ENDPOINT, "http://127.0.0.1:" + server.getAddress().getPort() + "/usage");
            System.setProperty(TOKEN, "token");
            UsageSubmissionService service = new UsageSubmissionService(root);
            service.record("model", usage(), Instant.now().minus(2, ChronoUnit.HOURS).toEpochMilli());
            service.submitDueBatches(); service.submitDueBatches();
            Assertions.assertEquals(1, requests.get());
        } finally { server.stop(0); delete(root); }
    }

    @Test
    void lateEventCreatesASecondImmutableBatch() throws Exception {
        Path root = Files.createTempDirectory("usage-submit-late");
        try {
            UsageSubmissionService service = new UsageSubmissionService(root);
            long completedHour = Instant.now().minus(2, ChronoUnit.HOURS).toEpochMilli();
            service.record("model", usage(), completedHour);
            service.submitDueBatches();
            Path first = Files.list(service.getOutboxDirectory()).findFirst().orElseThrow();
            String firstContent = Files.readString(first);

            service.record("model", usage(), completedHour + 1);
            service.submitDueBatches();

            Assertions.assertEquals(2, Files.list(service.getOutboxDirectory()).count());
            Assertions.assertEquals(firstContent, Files.readString(first));
        } finally { delete(root); }
    }

    private static void verifySignature(ONode outbox) throws Exception {
        verifySignature(outbox.get("payloadText").getString(), outbox.get("publicKey").getString(),
                outbox.get("signature").getString());
    }

    private static void verifySignature(String payload, String publicKey, String signature) throws Exception {
        Signature verifier = Signature.getInstance("Ed25519");
        verifier.initVerify(KeyFactory.getInstance("Ed25519").generatePublic(
                new X509EncodedKeySpec(Base64.getDecoder().decode(publicKey))));
        verifier.update(payload.getBytes(StandardCharsets.UTF_8));
        Assertions.assertTrue(verifier.verify(Base64.getDecoder().decode(signature)));
    }

    private static void delete(Path path) throws Exception {
        if (Files.exists(path)) try (var stream = Files.walk(path)) {
            stream.sorted((a, b) -> b.compareTo(a)).forEach(p -> {
                try { Files.deleteIfExists(p); } catch (Exception ignored) { }
            });
        }
    }
}
