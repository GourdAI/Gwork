package com.gourdai.ai.llm.dialect.ollama;

import com.gourdai.ai.chat.ChatModel;
import com.gourdai.ai.llm.dialect.openai.OpenaiChatDialect;
import com.gourdai.core.portal.web.ThinkingDepth;
import com.gourdai.core.portal.web.thinking.ReasoningCapabilities;
import com.gourdai.core.portal.web.thinking.ReasoningCapability;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/** Independent loopback requests through the real ThinkingDepth injection and chat dialect. */
class OllamaThinkingDepthHttpTest {
    private static final class Mock implements AutoCloseable {
        private final HttpServer server;
        private final LinkedBlockingQueue<ONode> bodies = new LinkedBlockingQueue<>();
        private final LinkedBlockingQueue<String> paths = new LinkedBlockingQueue<>();

        private Mock() throws Exception {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", exchange -> {
                String path = exchange.getRequestURI().getPath();
                paths.add(path);
                bodies.add(ONode.ofJson(new String(exchange.getRequestBody().readAllBytes(),
                        StandardCharsets.UTF_8)));
                String reply = path.startsWith("/v1/")
                        ? "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"answer\"},\"finish_reason\":\"stop\"}]}"
                        : "{\"message\":{\"role\":\"assistant\",\"content\":\"answer\"},\"done\":true}";
                byte[] bytes = reply.getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, bytes.length);
                exchange.getResponseBody().write(bytes);
                exchange.close();
            });
            server.start();
        }

        private ChatModel model(String name, String standard, String provider, String suffix) {
            return ChatModel.of("http://127.0.0.1:" + server.getAddress().getPort() + suffix)
                    .model(name).standard(standard).provider(provider)
                    .timeout(Duration.ofSeconds(5)).build();
        }

        private ChatModel nativeModel(String name) {
            return model(name, "ollama", null, "");
        }

        private ONode body(String path) throws Exception {
            assertEquals(path, paths.poll(5, TimeUnit.SECONDS));
            ONode body = bodies.poll(5, TimeUnit.SECONDS);
            assertNotNull(body);
            return body;
        }

        @Override
        public void close() {
            server.stop(0);
        }
    }

    private static void assertNoForeignReasoning(ONode body) {
        for (String key : List.of("thinking", "reasoning_effort", "reasoning", "output_config", "generationConfig")) {
            assertFalse(body.hasKey(key), key + " must not leak into native Ollama request");
        }
    }

    @Test
    void gptOssLevelsReachNativeThinkAndHigherLevelsClamp() throws Exception {
        try (Mock mock = new Mock()) {
            ChatModel model = mock.nativeModel("gpt-oss:20b");
            assertInstanceOf(OllamaChatDialect.class, model.getDialect());
            assertEquals(List.of("low", "medium", "high"), ThinkingDepth.selectableCodes(model));
            for (String depth : List.of("low", "medium", "high", "xhigh", "max")) {
                assertEquals("answer", model.prompt("hello").options(o -> {
                    ThinkingDepth.applyTo(o, model, depth);
                    o.optionSet("options", Map.of("temperature", 0.2));
                }).call().getMessage().getText());
                ONode body = mock.body("/api/chat");
                String expected = List.of("xhigh", "max").contains(depth) ? "high" : depth;
                assertEquals("\"" + expected + "\"", body.get("think").toJson());
                assertEquals(0.2, body.get("options").get("temperature").getDouble());
                assertNoForeignReasoning(body);
            }
        }
    }

    @Test
    void otherNativeModelsUseBooleanAccordingToCapability() throws Exception {
        try (Mock mock = new Mock()) {
            // R1 is controllable on native Ollama, unlike its cloud rule; unknown models use interface fallback.
            for (String name : List.of("qwen3:8b", "deepseek-r1:8b", "deepseek-v3.1", "glm-5.2", "local-custom")) {
                ChatModel model = mock.nativeModel(name);
                assertTrue(ThinkingDepth.selectableCodes(model).isEmpty(), name);
                for (String depth : List.of("low", "high")) {
                    model.prompt("hello").options(o -> ThinkingDepth.applyTo(o, model, depth)).call();
                    ONode body = mock.body("/api/chat");
                    assertEquals("true", body.get("think").toJson(), name);
                    assertNoForeignReasoning(body);
                }
            }
        }
    }

    @Test
    void autoLegacyOffAndNoneClearPreviousInjectionWithoutDisablingThinking() throws Exception {
        try (Mock mock = new Mock()) {
            for (String name : List.of("gpt-oss:20b", "qwen3:8b")) {
                ChatModel model = mock.nativeModel(name);
                for (String depth : List.of("auto", "off")) {
                    model.prompt("hello").options(o -> {
                        ThinkingDepth.applyTo(o, model, "high");
                        o.optionSet("reasoning_effort", "high");
                        o.optionSet("thinking", true);
                        ThinkingDepth.applyTo(o, model, depth);
                    }).call();
                    ONode body = mock.body("/api/chat");
                    assertFalse(body.hasKey("think"));
                    assertNoForeignReasoning(body);
                }
            }
            ChatModel none = mock.nativeModel("minimax-m2");
            none.prompt("hello").options(o -> {
                ThinkingDepth.applyTo(o, mock.nativeModel("gpt-oss:20b"), "high");
                ThinkingDepth.applyTo(o, none, "high");
            }).call();
            ONode body = mock.body("/api/chat");
            assertFalse(body.hasKey("think"));
            assertNoForeignReasoning(body);
            assertTrue(ReasoningCapabilities.resolve("ollama", "gpt-oss:20b",
                    Map.of("reasoning", false)).isNone());
        }
    }

    @Test
    void providerAndUrlFallbackUseNativeMapping() throws Exception {
        try (Mock mock = new Mock()) {
            for (ChatModel model : List.of(
                    mock.model("gpt-oss:20b", "OLLAMA", null, "/"),
                    mock.model("gpt-oss:20b", null, "ollama", ""),
                    mock.model("gpt-oss:20b", null, null, "/api/chat"))) {
                assertInstanceOf(OllamaChatDialect.class, model.getDialect());
                model.prompt("hello").options(o -> ThinkingDepth.applyTo(o, model, "low")).call();
                ONode body = mock.body("/api/chat");
                assertEquals("\"low\"", body.get("think").toJson());
                assertNoForeignReasoning(body);
            }
        }
    }

    @Test
    void explicitOpenaiStandardRemainsOpenaiEvenWithOllamaProvider() throws Exception {
        try (Mock mock = new Mock()) {
            ChatModel model = mock.model("gpt-oss:20b", "openai", "ollama", "/v1");
            assertInstanceOf(OpenaiChatDialect.class, model.getDialect());
            for (String depth : List.of("low", "medium", "high")) {
                model.prompt("hello").options(o -> ThinkingDepth.applyTo(o, model, depth)).call();
                ONode body = mock.body("/v1/chat/completions");
                assertEquals(depth, body.get("reasoning_effort").getString());
                assertFalse(body.hasKey("think"));
                assertFalse(body.hasKey("thinking"));
            }
            ChatModel qwen = mock.model("qwen3:8b", "openai", "ollama", "/v1");
            qwen.prompt("hello").options(o -> ThinkingDepth.applyTo(o, qwen, "high")).call();
            ONode body = mock.body("/v1/chat/completions");
            assertFalse(body.hasKey("think"));
            assertFalse(body.hasKey("thinking"));
            assertFalse(body.hasKey("reasoning_effort"));
            assertTrue(ReasoningCapabilities.resolve("openai", "deepseek-r1").isNone());
        }
    }

    @Test
    void explicitBooleanSwitchAndNativeThinkPrecedenceArePreserved() throws Exception {
        try (Mock mock = new Mock()) {
            ChatModel model = mock.nativeModel("qwen3:8b");
            for (boolean enabled : List.of(true, false)) {
                model.prompt("hello").options(o -> {
                    ThinkingDepth.applyTo(o, model, "auto");
                    o.optionSet("thinking", enabled);
                }).call();
                ONode body = mock.body("/api/chat");
                assertEquals(Boolean.toString(enabled), body.get("think").toJson());
                assertNoForeignReasoning(body);
            }
            model.prompt("hello").options(o -> {
                ThinkingDepth.applyTo(o, model, "high");
                o.optionSet("thinking", true);
                o.optionSet("think", false);
            }).call();
            ONode body = mock.body("/api/chat");
            assertEquals("false", body.get("think").toJson());
            assertNoForeignReasoning(body);
        }
    }

    @Test
    void standardOnlyEntryUsesBooleanRatherThanOpenaiEffort() throws Exception {
        assertEquals(ReasoningCapability.Shape.TOGGLE, ReasoningCapabilities.resolve("ollama", null).shape());
        try (Mock mock = new Mock()) {
            mock.nativeModel("qwen3:8b").prompt("hello")
                    .options(o -> ThinkingDepth.applyTo(o, "ollama", "high")).call();
            ONode body = mock.body("/api/chat");
            assertEquals("true", body.get("think").toJson());
            assertNoForeignReasoning(body);
        }
    }
}
