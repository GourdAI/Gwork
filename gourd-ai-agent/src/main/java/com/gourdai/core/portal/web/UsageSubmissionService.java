/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
package com.gourdai.core.portal.web;

import com.gourdai.agent.trace.UsageNormalizer;
import com.gourdai.core.config.AgentFlags;
import org.noear.snack4.ONode;
import org.noear.solon.ai.AiUsage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PublicKey;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

/** 本地用量事件、不可变小时批次及可靠提交 outbox。 */
public class UsageSubmissionService {
    private static final Logger LOG = LoggerFactory.getLogger(UsageSubmissionService.class);
    private static final String DIR = "usage-submission";
    private static final long HOURLY_SYNC_PERIOD_MINUTES = 60L;
    private static final long HOUR_GRACE_MINUTES = 2L;
    private static final int MAX_MODEL_LENGTH = 256;
    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(10);
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(30);

    /** Lazy holder 避免类加载时初始化遥测文件/密钥。 */
    private static class SharedHolder {
        private static final UsageSubmissionService INSTANCE = new UsageSubmissionService();
    }

    private final Path root;
    private final Path eventsFile;
    private final Path keyFile;
    private final Path outbox;
    private final HttpClient httpClient;
    private final PrivateKey privateKey;
    private final String publicKey;
    private final String deviceId;
    private ScheduledExecutorService hourlySyncExecutor;

    public static UsageSubmissionService shared() {
        return SharedHolder.INSTANCE;
    }

    public static void recordSafely(String model, AiUsage usage, long timestamp) {
        try {
            shared().record(model, usage, timestamp);
        } catch (Throwable e) {
            LOG.debug("Unable to record usage telemetry: {}", e.getMessage());
        }
    }

    public UsageSubmissionService() {
        this(Path.of(AgentFlags.getHarnessBase(), AgentFlags.getHarnessHome(), DIR));
    }

    public UsageSubmissionService(Path root) {
        this(root, HttpClient.newBuilder().connectTimeout(CONNECT_TIMEOUT).build());
    }

    UsageSubmissionService(Path root, HttpClient httpClient) {
        try {
            this.root = root.toAbsolutePath().normalize();
            this.eventsFile = this.root.resolve("events.jsonl");
            this.keyFile = this.root.resolve("device-key.json");
            this.outbox = this.root.resolve("outbox");
            Files.createDirectories(outbox);
            KeyPair pair = loadOrCreateKeyPair();
            privateKey = pair.getPrivate();
            publicKey = Base64.getEncoder().encodeToString(pair.getPublic().getEncoded());
            deviceId = deviceIdFor(pair.getPublic());
            this.httpClient = httpClient;
        } catch (Exception e) {
            throw new IllegalStateException("Unable to initialize usage submission store", e);
        }
    }

    public String getDeviceId() { return deviceId; }
    public String deviceId() { return deviceId; }
    public String getPublicKey() { return publicKey; }
    public Path getEventsFile() { return eventsFile; }
    public Path getOutboxDirectory() { return outbox; }

    public synchronized void record(String model, AiUsage usage, long timestamp) {
        if (usage == null || timestamp <= 0 || !validModel(model)) {
            return;
        }
        try {
            long rawCreation = usage.cacheCreationInputTokens();
            long rawRead = usage.cacheReadInputTokens();
            long rawPrompt = usage.promptTokens();
            long rawOutput = usage.completionTokens();
            if (rawCreation < 0 || rawRead < 0 || rawPrompt < 0 || rawOutput < 0) {
                return;
            }
            long creation = rawCreation;
            long read = rawRead;
            long prompt = rawPrompt;
            long cacheTotal = Math.addExact(creation, read);
            long input = prompt < cacheTotal ? Math.addExact(prompt, cacheTotal) : prompt;
            long output = rawOutput;
            String line = "{\"eventId\":\"" + esc(UUID.randomUUID().toString())
                    + "\",\"model\":\"" + esc(model.trim())
                    + "\",\"inputTokens\":" + input
                    + ",\"outputTokens\":" + output
                    + ",\"cacheCreationTokens\":" + creation
                    + ",\"cacheReadTokens\":" + read
                    + ",\"createdAt\":" + timestamp + "}";
            Files.writeString(eventsFile, line + "\n", StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (ArithmeticException e) {
            LOG.warn("Rejecting overflowing usage event: {}", e.getMessage());
        } catch (Exception e) {
            LOG.warn("Unable to record usage event: {}", e.getMessage());
        }
    }

    private static long nonNegative(long value) { return Math.max(0, value); }

    private static boolean validModel(String model) {
        if (model == null) return false;
        String value = model.trim();
        if (value.isEmpty() || value.length() > MAX_MODEL_LENGTH) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (Character.isISOControl(c)) return false;
        }
        if (value.matches("^[A-Za-z][A-Za-z0-9+.-]*:.*")) return false;
        return true;
    }

    public synchronized void startHourlySync() {
        if (hourlySyncExecutor != null && !hourlySyncExecutor.isShutdown()) return;
        ThreadFactory factory = r -> {
            Thread t = new Thread(r, "usage-hourly-sync");
            t.setDaemon(true);
            return t;
        };
        hourlySyncExecutor = Executors.newSingleThreadScheduledExecutor(factory);
        hourlySyncExecutor.execute(this::submitDueBatches);
        long now = System.currentTimeMillis();
        long next = Instant.ofEpochMilli(now).truncatedTo(ChronoUnit.HOURS)
                .plus(1, ChronoUnit.HOURS).plus(HOUR_GRACE_MINUTES, ChronoUnit.MINUTES)
                .toEpochMilli();
        hourlySyncExecutor.scheduleAtFixedRate(this::submitDueBatches,
                Math.max(0, next - now), HOURLY_SYNC_PERIOD_MINUTES, TimeUnit.MINUTES);
    }

    public synchronized void stopHourlySync() {
        if (hourlySyncExecutor != null) {
            hourlySyncExecutor.shutdownNow();
            hourlySyncExecutor = null;
        }
    }

    /** 先从事件日志物化，再独立扫描 outbox；恢复不依赖事件日志。 */
    public synchronized void submitDueBatches() {
        try {
            Set<String> represented = scanOutboxEventIds();
            Instant cutoff = Instant.now().minus(HOUR_GRACE_MINUTES, ChronoUnit.MINUTES);
            Map<String, List<ONode>> byHour = new LinkedHashMap<>();
            for (ONode event : readEvents()) {
                if (!validEvent(event)) continue;
                Instant hour = Instant.ofEpochMilli(event.get("createdAt").getLong())
                        .truncatedTo(ChronoUnit.HOURS);
                if (!hour.plus(1, ChronoUnit.HOURS).isAfter(cutoff)
                        && !represented.contains(event.get("eventId").getString())) {
                    byHour.computeIfAbsent(hour.toString(), k -> new ArrayList<>()).add(event);
                }
            }
            for (Map.Entry<String, List<ONode>> entry : byHour.entrySet()) {
                String id = batchId(entry.getKey(), entry.getValue());
                Path file = outbox.resolve(id + ".json");
                if (!Files.exists(file)) materialize(file, id, entry.getKey(), entry.getValue());
            }
            try (var stream = Files.list(outbox)) {
                for (Path file : stream.filter(p -> p.toString().endsWith(".json")).toList()) {
                    ONode batch = readNode(file);
                    String status = text(batch, "status", "pending");
                    if (validBatch(batch) && !"confirmed".equals(status)
                            && !"permanent_failed".equals(status)) {
                        submit(file, batch);
                    }
                }
            }
        } catch (Exception e) {
            LOG.warn("Unable to prepare usage batches: {}", e.getMessage());
        }
    }

    private void materialize(Path file, String batchId, String hour, List<ONode> events) throws Exception {
        String payload = buildPayload(batchId, hour, events);
        ONode batch = new ONode().set("batchId", batchId).set("hour", hour)
                .set("status", "pending").set("payload", ONode.ofJson(payload))
                .set("payloadText", payload).set("deviceId", deviceId)
                .set("publicKey", publicKey).set("signatureAlgorithm", "Ed25519")
                .set("signature", Base64.getEncoder().encodeToString(sign(payload.getBytes(StandardCharsets.UTF_8))))
                .set("attempt", 0);
        atomicWrite(file, batch.toJson());
    }

    public String status() {
        int pending = 0, failed = 0, confirmed = 0;
        try (var stream = Files.list(outbox)) {
            for (Path file : stream.filter(p -> p.toString().endsWith(".json")).toList()) {
                ONode node = readNode(file);
                if (node == null) continue;
                String status = text(node, "status", "pending");
                if ("confirmed".equals(status)) confirmed++;
                else if (status.contains("failed")) failed++;
                else pending++;
            }
        } catch (IOException ignore) { }
        return "pending=" + pending + ",failed=" + failed + ",confirmed=" + confirmed;
    }

    public String getStatus() { return status(); }

    private void submit(Path file, ONode batch) {
        String endpoint = setting("gwork.usage.endpoint", "GWORK_USAGE_ENDPOINT");
        String token = setting("gwork.usage.client-token", "GWORK_USAGE_CLIENT_TOKEN");
        if (endpoint.isBlank() || token.isBlank()) return;
        try {
            String payloadText = payloadText(batch);
            String batchId = text(batch, "batchId", "");
            String storedDevice = text(batch, "deviceId", "");
            String storedPublic = text(batch, "publicKey", "");
            String signature = text(batch, "signature", "");
            HttpRequest request = HttpRequest.newBuilder(URI.create(endpoint))
                    .timeout(REQUEST_TIMEOUT).header("Content-Type", "application/json")
                    .header("X-GWork-Client-Token", token)
                    .header("X-GWork-Device-Id", storedDevice)
                    .header("X-GWork-Batch-Id", batchId)
                    .header("X-GWork-Public-Key", storedPublic)
                    .header("X-GWork-Signature-Algorithm", "Ed25519")
                    .header("X-GWork-Signature", signature)
                    .POST(HttpRequest.BodyPublishers.ofString(payloadText, StandardCharsets.UTF_8))
                    .build();
            int code = httpClient.send(request, HttpResponse.BodyHandlers.discarding()).statusCode();
            int attempt = batch.getOrNull("attempt") == null ? 0 : batch.get("attempt").getInt();
            batch.set("attempt", Math.addExact(attempt, 1)).set("lastStatus", code);
            if (code >= 200 && code < 300) {
                batch.set("status", "confirmed").set("lastError", "");
            } else if (retryable(code)) {
                batch.set("status", "failed").set("lastError", "HTTP " + code);
            } else {
                batch.set("status", "permanent_failed").set("lastError", "HTTP " + code);
            }
            atomicWrite(file, batch.toJson());
        } catch (Exception e) {
            try {
                int attempt = batch.getOrNull("attempt") == null ? 0 : batch.get("attempt").getInt();
                batch.set("attempt", Math.addExact(attempt, 1)).set("status", "failed")
                        .set("lastError", String.valueOf(e.getMessage())).set("lastStatus", 0);
                atomicWrite(file, batch.toJson());
            } catch (Exception ignored) { }
        }
    }

    private static String setting(String property, String environment) {
        String value = System.getProperty(property);
        if (value == null || value.isBlank()) value = System.getenv(environment);
        return value == null ? "" : value.trim();
    }

    private static boolean retryable(int code) { return code == 408 || code == 425 || code == 429 || code >= 500; }

    private boolean validBatch(ONode node) {
        if (node == null || !"Ed25519".equals(text(node, "signatureAlgorithm", ""))) return false;
        String batchId = text(node, "batchId", "");
        String headerDevice = text(node, "deviceId", "");
        String publicText = text(node, "publicKey", "");
        String signatureText = text(node, "signature", "");
        if (batchId.isBlank() || headerDevice.isBlank() || publicText.isBlank() || signatureText.isBlank()) return false;
        try {
            String payload = payloadText(node);
            ONode body = ONode.ofJson(payload);
            if (!batchId.equals(text(body, "batchId", ""))
                    || !headerDevice.equals(text(body, "deviceId", ""))) return false;
            PublicKey key = KeyFactory.getInstance("Ed25519").generatePublic(
                    new X509EncodedKeySpec(Base64.getDecoder().decode(publicText)));
            if (!headerDevice.equals(deviceIdFor(key))) return false;
            Signature verifier = Signature.getInstance("Ed25519");
            verifier.initVerify(key);
            verifier.update(payload.getBytes(StandardCharsets.UTF_8));
            return verifier.verify(Base64.getDecoder().decode(signatureText));
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean validEvent(ONode node) {
        try {
            if (node == null || node.getOrNull("eventId") == null || text(node, "eventId", "").isBlank()
                    || !validModel(text(node, "model", "")) || node.getOrNull("createdAt") == null
                    || node.get("createdAt").getLong() <= 0) return false;
            for (String field : List.of("inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens")) {
                if (node.getOrNull(field) == null || node.get(field).getLong() < 0) return false;
            }
            return true;
        } catch (Exception e) { return false; }
    }

    private static String payloadText(ONode node) {
        return node.getOrNull("payloadText") != null
                ? node.get("payloadText").getString() : node.get("payload").toJson();
    }

    private String buildPayload(String batchId, String hour, List<ONode> events) {
        Map<String, long[]> sums = new LinkedHashMap<>();
        Map<String, List<String>> ids = new LinkedHashMap<>();
        for (ONode event : events) {
            String model = event.get("model").getString();
            long[] values = sums.computeIfAbsent(model, k -> new long[4]);
            try {
                values[0] = Math.addExact(values[0], event.get("inputTokens").getLong());
                values[1] = Math.addExact(values[1], event.get("outputTokens").getLong());
                values[2] = Math.addExact(values[2], event.get("cacheCreationTokens").getLong());
                values[3] = Math.addExact(values[3], event.get("cacheReadTokens").getLong());
            } catch (ArithmeticException e) { throw new IllegalArgumentException("usage batch token overflow", e); }
            ids.computeIfAbsent(model, k -> new ArrayList<>()).add(event.get("eventId").getString());
        }
        StringBuilder result = new StringBuilder("{\"deviceId\":\"").append(esc(deviceId))
                .append("\",\"batchId\":\"").append(esc(batchId)).append("\",\"hour\":\"")
                .append(esc(hour)).append("\",\"models\":[");
        boolean first = true;
        for (String model : sums.keySet()) {
            if (!first) result.append(',');
            first = false;
            long[] values = sums.get(model);
            result.append("{\"model\":\"").append(esc(model)).append("\",\"inputTokens\":")
                    .append(values[0]).append(",\"outputTokens\":").append(values[1])
                    .append(",\"cacheCreationTokens\":").append(values[2])
                    .append(",\"cacheReadTokens\":").append(values[3]).append(",\"eventIds\":[");
            List<String> eventIds = ids.get(model);
            for (int i = 0; i < eventIds.size(); i++) {
                if (i > 0) result.append(',');
                result.append('"').append(esc(eventIds.get(i))).append('"');
            }
            result.append("]}");
        }
        return result.append("]}").toString();
    }

    private String batchId(String hour, List<ONode> events) {
        List<String> ids = new ArrayList<>();
        for (ONode event : events) ids.add(event.get("eventId").getString());
        Collections.sort(ids);
        String suffix = hex(digest(String.join(",", ids).getBytes(StandardCharsets.UTF_8))).substring(0, 16);
        return hex(digest((deviceId + hour + suffix).getBytes(StandardCharsets.UTF_8))).substring(0, 32);
    }

    private Set<String> scanOutboxEventIds() {
        Set<String> ids = new HashSet<>();
        try (var stream = Files.list(outbox)) {
            for (Path path : stream.filter(p -> p.toString().endsWith(".json")).toList()) {
                ONode node = readNode(path);
                if (node == null || !validBatch(node)) continue;
                try {
                    String payload = payloadText(node);
                    ONode body = ONode.ofJson(payload);
                    ONode models = body.getOrNull("models");
                    if (models == null) continue;
                    for (int i = 0; i < models.size(); i++) {
                        ONode eventIds = models.get(i).getOrNull("eventIds");
                        if (eventIds == null) continue;
                        for (int j = 0; j < eventIds.size(); j++) ids.add(eventIds.get(j).getString());
                    }
                } catch (Exception ignore) { }
            }
        } catch (IOException ignore) { }
        return ids;
    }

    private KeyPair loadOrCreateKeyPair() throws Exception {
        if (Files.exists(keyFile)) {
            try {
                ONode node = ONode.ofJson(Files.readString(keyFile));
                KeyFactory factory = KeyFactory.getInstance("Ed25519");
                return new KeyPair(
                        factory.generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(node.get("publicKey").getString()))),
                        factory.generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(node.get("privateKey").getString()))));
            } catch (Exception e) {
                LOG.warn("Ignoring damaged usage device key: {}", e.getMessage());
            }
        }
        KeyPairGenerator generator = KeyPairGenerator.getInstance("Ed25519");
        KeyPair pair = generator.generateKeyPair();
        atomicWrite(keyFile, new ONode().set("publicKey", Base64.getEncoder().encodeToString(pair.getPublic().getEncoded()))
                .set("privateKey", Base64.getEncoder().encodeToString(pair.getPrivate().getEncoded())).toJson());
        return pair;
    }

    private List<ONode> readEvents() {
        List<ONode> result = new ArrayList<>();
        if (!Files.exists(eventsFile)) return result;
        try {
            for (String line : Files.readAllLines(eventsFile)) {
                try { if (!line.isBlank()) result.add(ONode.ofJson(line)); } catch (Exception ignore) { }
            }
        } catch (IOException ignore) { }
        return result;
    }

    private ONode readNode(Path path) {
        try { return Files.exists(path) ? ONode.ofJson(Files.readString(path)) : null; }
        catch (Exception e) { return null; }
    }

    private byte[] sign(byte[] data) throws Exception {
        Signature signature = Signature.getInstance("Ed25519");
        signature.initSign(privateKey);
        signature.update(data);
        return signature.sign();
    }

    private static String text(ONode node, String key, String fallback) {
        try { return node != null && node.getOrNull(key) != null ? node.get(key).getString() : fallback; }
        catch (Exception e) { return fallback; }
    }

    private static String deviceIdFor(PublicKey key) {
        return hex(digest(key.getEncoded())).substring(0, 32);
    }

    private static byte[] digest(byte[] data) {
        try { return java.security.MessageDigest.getInstance("SHA-256").digest(data); }
        catch (Exception e) { throw new IllegalStateException(e); }
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte value : bytes) result.append(String.format("%02x", value));
        return result.toString();
    }

    private static String esc(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r");
    }

    private static void atomicWrite(Path target, String content) throws IOException {
        Path temp = target.resolveSibling(target.getFileName() + ".tmp-" + UUID.randomUUID());
        Files.writeString(temp, content, StandardCharsets.UTF_8);
        try {
            Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }
}
