package com.gourdai.core.portal.desktop;

import com.gourdai.ai.chat.ChatConfig;
import com.gourdai.ai.llm.dialect.ollama.OllamaChatDialect;
import com.gourdai.ai.llm.dialect.openai.OpenaiChatDialect;
import com.gourdai.core.portal.desktop.provider.ModelProviderFactory;
import com.gourdai.core.portal.desktop.provider.OllamaModelProvider;
import com.gourdai.core.portal.web.model.ModelInfo;
import com.gourdai.harness.HarnessEngine;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.snack4.ONode;
import org.noear.solon.core.handle.ContextEmpty;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** Desktop legacy endpoints, using only loopback HTTP and temporary engine directories. */
class WsControllerOllamaModelsTest {
    @TempDir Path temp;

    private HarnessEngine engine() {
        return HarnessEngine.of(temp.toString(), temp.resolve("home").toString()).build();
    }

    private WsController controller(HarnessEngine engine) {
        ModelProviderFactory factory = new ModelProviderFactory();
        factory.init();
        return new WsController(engine, factory);
    }

    private ContextEmpty body(Map<String, String> values) {
        String json = ONode.ofBean(values).toJson();
        return new ContextEmpty() {
            @Override public String body() { return json; }
        };
    }

    private static class Mock implements AutoCloseable {
        final HttpServer server;
        final List<String> paths = Collections.synchronizedList(new ArrayList<>());
        final List<ONode> bodies = Collections.synchronizedList(new ArrayList<>());

        Mock(String models) throws Exception {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", ex -> {
                String path = ex.getRequestURI().getPath();
                paths.add(path);
                String request = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                bodies.add(request.isEmpty() ? new ONode() : ONode.ofJson(request));
                String response;
                if (path.equals("/api/tags") || path.equals("/v1/models")) {
                    response = models;
                } else if (path.equals("/api/chat")) {
                    response = "{\"model\":\"qwen3\",\"message\":{\"role\":\"assistant\",\"content\":\"native\"},\"done\":true}";
                } else if (path.equals("/v1/chat/completions")) {
                    response = "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"compatible\"},\"finish_reason\":\"stop\"}]}";
                } else {
                    response = "{}";
                }
                byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
                ex.getResponseHeaders().set("Content-Type", "application/json");
                ex.sendResponseHeaders(200, bytes.length);
                ex.getResponseBody().write(bytes);
                ex.close();
            });
            server.start();
        }
        String url() { return "http://127.0.0.1:" + server.getAddress().getPort(); }
        @Override public void close() { server.stop(0); }
    }

    @Test void tagsKeepValidMissingAndInvalidDatesAndNativeStandard() throws Exception {
        String date = "2024-02-03T04:05:06.123456Z";
        String models = "{\"models\":[{\"name\":\"valid\",\"modified_at\":\"" + date
                + "\"},{\"name\":\"missing\"},{\"name\":\"invalid\",\"modified_at\":\"not-a-date\"},"
                + "{\"name\":\"after-invalid\",\"modified_at\":\"" + date + "\"}]}";
        try (Mock mock = new Mock(models)) {
            long before = Instant.now().getEpochSecond();
            List<ModelInfo> result = new OllamaModelProvider().fetchModels(mock.url(), Map.of(), "");
            long after = Instant.now().getEpochSecond();
            assertEquals(List.of("/api/tags"), mock.paths);
            assertEquals(List.of("valid", "missing", "invalid", "after-invalid"),
                    result.stream().map(ModelInfo::getId).toList());
            assertEquals(Instant.parse(date).getEpochSecond(), result.get(0).getCreated());
            assertEquals(Instant.parse(date).getEpochSecond(), result.get(3).getCreated());
            for (int i : List.of(1, 2)) {
                assertTrue(result.get(i).getCreated() >= before && result.get(i).getCreated() <= after);
            }
            for (ModelInfo info : result) {
                assertEquals("model", info.getObject());
                assertEquals("ollama", info.getOwnedBy());
                assertEquals("ollama", info.getStandard());
            }
        }
    }

    @Test void nativeFetchDerivesRootAndFullChatUrlsAndRegistersDistinctIds() throws Exception {
        try (Mock mock = new Mock("{\"models\":[{\"name\":\"qwen3\"},{\"name\":\"llama3\"}]}")) {
            HarnessEngine engine = engine();
            WsController controller = controller(engine);
            ChatConfig sentinel = new ChatConfig();
            sentinel.setName("model");
            sentinel.setModel("unrelated");
            sentinel.setApiUrl(mock.url());
            engine.addModel(sentinel);
            for (String suffix : List.of("", "/", "/api/chat", "/api/chat/")) {
                String url = mock.url() + suffix;
                assertEquals(mock.url(), new OllamaModelProvider().deriveBaseUrl(url));
                var result = controller.fetchModels(url, "local-key", "ollama");
                assertEquals(200, result.getCode());
                assertEquals(2, result.getData().size());
                assertEquals("qwen3", result.getData().get(0).get("id"));
                for (String id : List.of("qwen3", "llama3")) {
                    ChatConfig config = engine.getModelOrNil(id);
                    assertNotNull(config, "must register the model id, not object=model");
                    assertEquals(id, config.getName());
                    assertEquals(id, config.getModel());
                    assertEquals(url, config.getApiUrl());
                    assertEquals("local-key", config.getApiKey());
                    assertEquals("ollama", config.getStandardOrProvider());
                    assertInstanceOf(OllamaChatDialect.class, config.toChatModel().getDialect());
                }
                assertSame(sentinel, engine.getModelOrNil("model"));
                assertEquals(3, engine.getModels().size());
            }
            assertEquals(Collections.nCopies(4, "/api/tags"), mock.paths);
            controller.fetchModels(mock.url(), "", "ollama");
            assertEquals("native", engine.getModelOrNil("qwen3").toChatModel().prompt("hello").call().getMessage().getText());
            assertEquals("/api/chat", mock.paths.get(5));
            assertEquals("qwen3", mock.bodies.get(5).get("model").getString());
        }
    }

    @Test void manualAddPreservesNativeProtocolAndCustomName() throws Exception {
        try (Mock mock = new Mock("{}")) {
            HarnessEngine engine = engine();
            assertEquals(200, controller(engine).modelsAdd(body(Map.of(
                    "apiUrl", mock.url(), "apiKey", "local-key", "model", "qwen3",
                    "name", "Local Qwen", "provider", "ollama", "timeout", "PT5S"))).getCode());
            ChatConfig config = engine.getModelOrNil("Local Qwen");
            assertNotNull(config);
            assertEquals("qwen3", config.getModel());
            assertEquals("Local Qwen", config.getName());
            assertEquals("ollama", config.getStandardOrProvider());
            assertEquals(mock.url(), config.getApiUrl());
            assertEquals("local-key", config.getApiKey());
            assertInstanceOf(OllamaChatDialect.class, config.toChatModel().getDialect());
            assertEquals("native", config.toChatModel().prompt("hello").call().getMessage().getText());
            assertEquals(List.of("/api/chat"), mock.paths);
            assertEquals("qwen3", mock.bodies.get(0).get("model").getString());
        }
    }

    @Test void openaiCompatibleFetchIsNotSwitchedByOllamaOwnerOrModelName() throws Exception {
        try (Mock mock = new Mock("{\"data\":[{\"id\":\"qwen3\",\"object\":\"model\",\"owned_by\":\"ollama\"}]}")) {
            HarnessEngine engine = engine();
            WsController controller = controller(engine);
            for (String suffix : List.of("/v1", "/v1/chat/completions")) {
                for (String provider : new String[]{"openai", null}) {
                    int start = mock.paths.size();
                    assertEquals(200, controller.fetchModels(mock.url() + suffix, "", provider).getCode());
                    ChatConfig config = engine.getModelOrNil("qwen3");
                    assertNotNull(config);
                    assertEquals("qwen3", config.getName());
                    assertEquals("qwen3", config.getModel());
                    if (provider != null) assertEquals("openai", config.getStandardOrProvider());
                    assertInstanceOf(OpenaiChatDialect.class, config.toChatModel().getDialect());
                    assertEquals("compatible", config.toChatModel().prompt("hello").call().getMessage().getText());
                    assertEquals(List.of("/v1/models", "/v1/chat/completions"), mock.paths.subList(start, start + 2));
                    assertEquals("qwen3", mock.bodies.get(start + 1).get("model").getString());
                }
            }
        }
    }

    @Test void manualOpenaiAndDefaultProtocolRemainCompatible() throws Exception {
        try (Mock mock = new Mock("{}")) {
            HarnessEngine engine = engine();
            WsController controller = controller(engine);
            for (String provider : List.of("openai", "")) {
                assertEquals(200, controller.modelsAdd(body(Map.of("apiUrl", mock.url() + "/v1",
                        "model", "qwen3", "provider", provider))).getCode());
                ChatConfig config = engine.getModelOrNil("qwen3");
                assertNotNull(config);
                if (!provider.isEmpty()) assertEquals("openai", config.getStandardOrProvider());
                assertInstanceOf(OpenaiChatDialect.class, config.toChatModel().getDialect());
                assertEquals("compatible", config.toChatModel().prompt("hello").call().getMessage().getText());
            }
            assertEquals(Collections.nCopies(2, "/v1/chat/completions"), mock.paths);
        }
    }
}
