package com.gourdai.ai.chat;

import com.gourdai.core.portal.web.WebChunk;
import com.gourdai.harness.agent.RetryEvent;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.solon.net.http.HttpResponse;
import org.noear.solon.net.http.HttpResponseException;

import java.io.InputStream;
import java.lang.reflect.Type;
import java.net.URL;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * 模型错误信息提取器测试。
 *
 * <p>覆盖：各供应商返回体形态解析（OpenAI / Anthropic / Gemini / 网关简化形态 / 非 JSON）、
 * 异常链描述（包装层剥离 / HTTP 异常体展开 / 无消息退化）、httpErrorOf 真源构建、
 * 以及 retry / error 帧文案的端到端组装。</p>
 *
 * @author oisin
 */
public class LlmErrorMessagesTest {

    // ---------------- extractBodyMessage：各形态返回体 ----------------

    /** OpenAI 形态：{"error":{"message","type","code"}}。 */
    @Test
    public void testOpenAiBodyShape() {
        String body = "{\"error\":{\"message\":\"No tool output found for tool call call_01_x\","
                + "\"type\":\"invalid_request_error\",\"param\":null,\"code\":null}}";
        Assertions.assertEquals("[invalid_request_error] No tool output found for tool call call_01_x",
                LlmErrorMessages.extractBodyMessage(body));
    }

    /** Anthropic 形态：{"type":"error","error":{"type","message"}}。 */
    @Test
    public void testAnthropicBodyShape() {
        String body = "{\"type\":\"error\",\"error\":{\"type\":\"authentication_error\","
                + "\"message\":\"invalid x-api-key\"}}";
        Assertions.assertEquals("[authentication_error] invalid x-api-key",
                LlmErrorMessages.extractBodyMessage(body));
    }

    /** Gemini 形态：{"error":{"code","message","status"}}（code 为数字）。 */
    @Test
    public void testGeminiBodyShape() {
        String body = "{\"error\":{\"code\":429,\"message\":\"Resource has been exhausted\","
                + "\"status\":\"RESOURCE_EXHAUSTED\"}}";
        Assertions.assertEquals("[RESOURCE_EXHAUSTED] Resource has been exhausted",
                LlmErrorMessages.extractBodyMessage(body));
    }

    /** 网关简化形态：顶层 message。 */
    @Test
    public void testTopLevelMessageShape() {
        Assertions.assertEquals("Internal upstream error",
                LlmErrorMessages.extractBodyMessage("{\"message\":\"Internal upstream error\"}"));
    }

    /** error 为字符串的简化形态。 */
    @Test
    public void testErrorAsStringShape() {
        Assertions.assertEquals("quota exceeded",
                LlmErrorMessages.extractBodyMessage("{\"error\":\"quota exceeded\"}"));
    }

    /** error 对象缺 message 时退化为原文，而不是 NPE / 误报。 */
    @Test
    public void testErrorObjectWithoutMessageFallsBackToRaw() {
        String body = "{\"error\":{\"detail\":\"something\"}}";
        Assertions.assertEquals(body, LlmErrorMessages.extractBodyMessage(body));
    }

    /** 非 JSON（HTML 错误页）原样截断返回。 */
    @Test
    public void testHtmlBodyKeptAsIs() {
        Assertions.assertEquals("<html>502 Bad Gateway</html>",
                LlmErrorMessages.extractBodyMessage("<html>502 Bad Gateway</html>"));
    }

    /** 形似 JSON 但解析失败：原样返回。 */
    @Test
    public void testMalformedJsonFallsBackToRaw() {
        Assertions.assertEquals("{not json", LlmErrorMessages.extractBodyMessage("{not json"));
    }

    /** 空输入返回 null。 */
    @Test
    public void testEmptyBodyReturnsNull() {
        Assertions.assertNull(LlmErrorMessages.extractBodyMessage(null));
        Assertions.assertNull(LlmErrorMessages.extractBodyMessage(""));
        Assertions.assertNull(LlmErrorMessages.extractBodyMessage("   "));
    }

    /** 超长消息截断到 400 字符并以省略号结尾。 */
    @Test
    public void testLongMessageTruncated() {
        StringBuilder sb = new StringBuilder("{\"error\":{\"message\":\"");
        for (int i = 0; i < 100; i++) {
            sb.append("0123456789");
        }
        sb.append("\"}}");
        String result = LlmErrorMessages.extractBodyMessage(sb.toString());
        Assertions.assertEquals(401, result.length());
        Assertions.assertTrue(result.endsWith("…"));
    }

    // ---------------- httpErrorOf / httpErrorText ----------------

    /** httpErrorOf：从 HTTP 响应构建携带「状态码 + 返回体消息」的异常。 */
    @Test
    public void testHttpErrorOfBuildsBodyMessage() {
        ChatException e = LlmErrorMessages.httpErrorOf(fakeResponse(400, "Bad Request",
                "{\"error\":{\"message\":\"No tool output found\",\"type\":\"invalid_request_error\"}}"));
        Assertions.assertEquals("HTTP 400 Bad Request: [invalid_request_error] No tool output found",
                e.getMessage());
    }

    /** httpErrorOf：无返回体时退化为仅状态码描述。 */
    @Test
    public void testHttpErrorOfWithoutBody() {
        ChatException e = LlmErrorMessages.httpErrorOf(fakeResponse(502, "Bad Gateway", null));
        Assertions.assertEquals("HTTP 502 Bad Gateway", e.getMessage());
    }

    /** httpErrorText：空状态行不产生多余空格。 */
    @Test
    public void testHttpErrorTextWithEmptyStatusMessage() {
        Assertions.assertEquals("HTTP 500: boom",
                LlmErrorMessages.httpErrorText(500, "", "{\"message\":\"boom\"}"));
        Assertions.assertEquals("HTTP 500",
                LlmErrorMessages.httpErrorText(500, null, null));
    }

    // ---------------- describe：异常链 ----------------

    /** describe：null 安全。 */
    @Test
    public void testDescribeNull() {
        Assertions.assertEquals("Unknown error", LlmErrorMessages.describe(null));
    }

    /** describe：普通异常直接取自身消息。 */
    @Test
    public void testDescribePlainException() {
        Assertions.assertEquals("HTTP 400: boom",
                LlmErrorMessages.describe(new ChatException("HTTP 400: boom")));
    }

    /** describe：包装链取最深层（根因）消息，滤掉外层泛化描述。 */
    @Test
    public void testDescribeUnwrapsWrapperChain() {
        RuntimeException e = new RuntimeException("任务执行失败",
                new ChatException("HTTP 400: No tool output found"));
        Assertions.assertEquals("HTTP 400: No tool output found", LlmErrorMessages.describe(e));
    }

    /** describe：包装链含 HTTP 响应异常时展开其携带的返回体。 */
    @Test
    public void testDescribeExpandsHttpResponseException() {
        HttpResponseException hre = new HttpResponseException(
                fakeResponse(400, "Bad Request",
                        "{\"error\":{\"message\":\"No tool output found\",\"type\":\"invalid_request_error\"}}"),
                "POST", url("https://llm.example.com/v1/chat/completions"));
        RuntimeException e = new RuntimeException("task failed", hre);
        Assertions.assertEquals(
                "HTTP 400 Bad Request: [invalid_request_error] No tool output found",
                LlmErrorMessages.describe(e));
    }

    /** describe：无任何消息时退化为异常简单类名（不输出 null）。 */
    @Test
    public void testDescribeFallsBackToClassName() {
        Assertions.assertEquals("NullPointerException",
                LlmErrorMessages.describe(new NullPointerException()));
    }

    // ---------------- 帧文案端到端 ----------------

    /** retry 帧携带失败原因。 */
    @Test
    public void testRetryFrameCarriesReason() {
        WebChunk chunk = WebChunk.ofRetry(2, 20, "HTTP 400: No tool output found for tool call call_01_x");
        Assertions.assertEquals("retry", chunk.getType());
        Assertions.assertEquals("模型调用失败，正在重试 2/20：HTTP 400: No tool output found for tool call call_01_x",
                chunk.getText());
    }

    /** retry 帧无原因时保持旧文案（向后兼容）。 */
    @Test
    public void testRetryFrameWithoutReasonKeepsLegacyText() {
        Assertions.assertEquals("模型调用失败，正在重试 1/3 ...",
                RetryEvent.formatText(1, 3));
        Assertions.assertEquals("模型调用失败，正在重试 1/3 ...",
                WebChunk.ofRetry(1, 3).getText());
    }

    /** error 帧从异常链提取根因，不再输出裸 getMessage()。 */
    @Test
    public void testErrorFrameDescribesCause() {
        WebChunk chunk = WebChunk.ofError(
                new RuntimeException("wrapper", new ChatException("HTTP 500: upstream boom")));
        Assertions.assertEquals("error", chunk.getType());
        Assertions.assertEquals("HTTP 500: upstream boom", chunk.getText());
    }

    // ---------------- 测试辅助 ----------------

    /** 最小可用的 HttpResponse 桩：只实现 httpErrorOf / HttpResponseException 需要的读取。 */
    private static HttpResponse fakeResponse(int code, String message, String body) {
        byte[] bytes = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
        return new HttpResponse() {
            @Override public Collection<String> headerNames() { return Collections.emptyList(); }
            @Override public String header(String name) { return null; }
            @Override public List<String> headers(String name) { return Collections.emptyList(); }
            @Override public Collection<String> cookieNames() { return Collections.emptyList(); }
            @Override public String cookie(String name) { return null; }
            @Override public List<String> cookies(String name) { return Collections.emptyList(); }
            @Override public List<String> cookies() { return Collections.emptyList(); }
            @Override public Long contentLength() { return (long) bytes.length; }
            @Override public String contentType() { return "application/json"; }
            @Override public Charset contentCharset() { return StandardCharsets.UTF_8; }
            @Override public int code() { return code; }
            @Override public String message() { return message; }
            @Override public InputStream body() {
                return body == null ? null : new java.io.ByteArrayInputStream(bytes);
            }
            @Override public byte[] bodyAsBytes() { return bytes; }
            @Override public String bodyAsString() { return body; }
            @Override public <T> T bodyAsBean(Type type) { return null; }
            @Override public Map<String, List<String>> headerMap() { return Collections.emptyMap(); }
            @Override public void close() { }
            @Override public HttpResponseException createError() {
                return new HttpResponseException(this, "POST",
                        url("https://llm.example.com/v1/chat/completions"));
            }
        };
    }

    private static URL url(String spec) {
        try {
            return new URL(spec);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
