package com.gourdai.ai.llm.dialect.ollama;

import com.gourdai.ai.chat.*;
import com.gourdai.ai.chat.event.*;
import com.gourdai.ai.chat.message.*;
import com.gourdai.ai.llm.dialect.openai.OpenaiChatDialect;
import com.gourdai.core.portal.web.model.OllamaModelsAdapter;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.LinkedBlockingQueue;

import static org.junit.jupiter.api.Assertions.*;

/** Loopback HTTP tests: no installed Ollama or external model required. */
class OllamaChatDialectHttpTest {
    static class Mock implements AutoCloseable {
        final HttpServer server;
        final Queue<String> replies = new LinkedBlockingQueue<>();
        final List<ONode> bodies = Collections.synchronizedList(new ArrayList<>());
        final List<String> paths = Collections.synchronizedList(new ArrayList<>());
        Mock(String... responses) throws Exception {
            replies.addAll(Arrays.asList(responses));
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", ex -> {
                paths.add(ex.getRequestURI().getPath());
                String request = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                bodies.add(request.isEmpty() ? new ONode() : ONode.ofJson(request));
                String reply = replies.poll();
                byte[] bytes = (reply == null ? "{}" : reply).getBytes(StandardCharsets.UTF_8);
                ex.getResponseHeaders().set("Content-Type", "application/x-ndjson");
                ex.sendResponseHeaders(200, bytes.length);
                ex.getResponseBody().write(bytes);
                ex.close();
            });
            server.start();
        }
        String url() { return "http://127.0.0.1:" + server.getAddress().getPort(); }
        ChatModel model(String suffix, String standard) {
            return ChatModel.of(url() + suffix).standard(standard).model("qwen3")
                    .timeout(Duration.ofSeconds(5)).build();
        }
        public void close() { server.stop(0); }
    }
    static final String COMPLETE = "{\"model\":\"qwen3\",\"message\":{\"role\":\"assistant\",\"content\":\"answer\",\"thinking\":\"reason\"},\"done\":true,\"prompt_eval_count\":7,\"eval_count\":3}";

    @Test void nativeRequestAndThinkingRoundTrip() throws Exception {
        try (Mock mock = new Mock(COMPLETE, COMPLETE)) {
            ChatModel model = mock.model("", "ollama");
            assertInstanceOf(OllamaChatDialect.class, model.getDialect());
            ChatResponse response = model.prompt("hello").options(o -> {
                o.optionSet("thinking", true);
                o.optionSet("keep_alive", "5m");
                o.optionSet("options", Map.of("temperature", 0.2));
                o.optionSet("ollama_tool_arguments_mode", "snapshot");
            }).call();
            assertEquals("answer", response.getMessage().getText());
            assertEquals("reason", response.getMessage().getThinking());
            assertNotNull(response.getUsage());
            ONode body = mock.bodies.get(0);
            assertEquals("/api/chat", mock.paths.get(0));
            assertEquals("qwen3", body.get("model").getString());
            assertFalse(body.get("stream").getBoolean());
            assertTrue(body.get("think").getBoolean());
            assertFalse(body.hasKey("thinking"));
            assertFalse(body.hasKey("ollama_tool_arguments_mode"));
            assertEquals("5m", body.get("keep_alive").getString());
            assertEquals(0.2, body.get("options").get("temperature").getDouble());
            assertEquals("hello", body.get("messages").get(0).get("content").getString());
            model.prompt(response.getMessage(), ChatMessage.ofUser("next")).options(o -> {
                o.optionSet("thinking", true);
                o.optionSet("think", false);
            }).call();
            // 思考回放窗口：末条是 user 时，其之前的 assistant 思考按 Qwen3/Ollama 官方模板
            // `(or $last (gt $i $lastUserIdx))` 本就不会展示给模型，故不再上行（纯省字节）。
            ONode historical = mock.bodies.get(1).get("messages").get(0);
            assertFalse(historical.hasKey("thinking"),
                    "跨 user 轮边界的历史思考不得上行：逐轮累加即上下文膨胀，且模型侧模板根本不展示");
            assertEquals("answer", historical.get("content").getString(), "剥离思考不得波及正文");
            assertFalse(mock.bodies.get(1).get("think").getBoolean());
        }
    }

    @Test void ndjsonThinkingTextAndParallelToolCalls() throws Exception {
        String frames = "{\"message\":{\"thinking\":\"rea\"},\"done\":false}\n"
                + "{\"message\":{\"thinking\":\"son\",\"content\":\"answer\"},\"done\":false}\n"
                + "{\"message\":{\"tool_calls\":[{\"function\":{\"name\":\"weather\",\"arguments\":{\"city\":\"Paris\"}}},{\"function\":{\"name\":\"weather\",\"arguments\":{\"city\":\"Rome\"}}}]},\"done\":false}\n"
                + "{\"model\":\"qwen3\",\"done\":true,\"done_reason\":\"stop\",\"prompt_eval_count\":7,\"eval_count\":3}\n";
        try (Mock mock = new Mock(frames, COMPLETE)) {
            ChatModel model = mock.model("/api/chat", "ollama");
            List<ChatEvent> events = model.prompt("weather").options(o -> o.autoToolCall(false))
                    .stream().collectList().block(Duration.ofSeconds(10));
            assertNotNull(events);
            assertEquals("reason", events.stream().filter(e -> e.getType() == ChatEventType.THINKING_DELTA)
                    .map(ChatEvent::getText).reduce("", String::concat));
            assertEquals("answer", events.stream().filter(e -> e.getType() == ChatEventType.TEXT_DELTA)
                    .map(ChatEvent::getText).reduce("", String::concat));
            for (ChatEventType type : List.of(ChatEventType.TOOL_CALL_START, ChatEventType.TOOL_CALL_ARGS_DELTA, ChatEventType.TOOL_CALL_END)) {
                assertEquals(2, events.stream().filter(e -> e.getType() == type).count(), type.name());
            }
            ChatEvent end = events.get(events.size() - 1);
            assertEquals(ChatEventType.RESPONSE_END, end.getType());
            AssistantMessage message = end.getResponse().getMessage();
            assertEquals("reason", message.getThinking());
            assertEquals("answer", message.getText());
            assertEquals(2, message.getToolCalls().size());
            assertEquals("Paris", message.getToolCalls().get(0).getArguments().get("city"));
            assertEquals("Rome", message.getToolCalls().get(1).getArguments().get("city"));
            assertTrue(mock.bodies.get(0).get("stream").getBoolean());
            model.prompt(message, ChatMessage.ofUser("next")).call();
            ONode history = mock.bodies.get(1).get("messages").get(0);
            // 同上：跨轮剥离思考。重点回归——剥离只动 thinking 字段，
            // tool_calls 必须原样保留（否则下一轮工具配对缺失 → 400）。
            assertFalse(history.hasKey("thinking"), "跨 user 轮边界的历史思考不得上行");
            assertEquals("answer", history.get("content").getString(), "剥离思考不得波及正文");
            assertTrue(history.get("tool_calls").get(0).get("function").get("arguments").isObject());
            assertEquals(2, history.get("tool_calls").size(), "剥离思考不得波及 tool_calls 配对");
            assertEquals(List.of("/api/chat", "/api/chat"), mock.paths);
        }
    }

    @Test void urlSelectionAndOpenaiCompatibility() throws Exception {
        String openai = "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"compatible\"},\"finish_reason\":\"stop\"}]}";
        try (Mock mock = new Mock(COMPLETE, COMPLETE, openai)) {
            mock.model("/", "OLLAMA").prompt("hi").call();
            mock.model("/custom#", "ollama").prompt("hi").call();
            ChatModel compatible = mock.model("/v1", "openai");
            assertInstanceOf(OpenaiChatDialect.class, compatible.getDialect());
            assertEquals("compatible", compatible.prompt("hi").call().getMessage().getText());
            assertEquals(List.of("/api/chat", "/custom", "/v1/chat/completions"), mock.paths);
            assertInstanceOf(OllamaChatDialect.class, mock.model("/api/chat", null).getDialect());
        }
    }

    @Test void nativeErrorIsNotSuccessfulCompletion() throws Exception {
        try (Mock mock = new Mock("{\"error\":\"model missing\"}", "{\"error\":\"model missing\"}\n")) {
            assertThrows(ChatException.class, () -> mock.model("", "ollama").prompt("hi").call());
            List<ChatEvent> events = new ArrayList<>();
            assertThrows(RuntimeException.class, () -> mock.model("", "ollama").prompt("hi").stream()
                    .doOnNext(events::add).blockLast(Duration.ofSeconds(10)));
            assertTrue(events.stream().anyMatch(e -> e.getType() == ChatEventType.ERROR));
            assertFalse(events.stream().anyMatch(e -> e.getType() == ChatEventType.RESPONSE_END));
        }
    }

    @Test void fetchedNativeModelsAdvertiseChatStandard() throws Exception {
        try (Mock mock = new Mock("{\"models\":[{\"name\":\"qwen3\"}]}")) {
            assertEquals("ollama", new OllamaModelsAdapter().fetchModels(mock.url(), Map.of(), "").get(0).getStandard());
            assertEquals("/api/tags", mock.paths.get(0));
        }
    }
}
