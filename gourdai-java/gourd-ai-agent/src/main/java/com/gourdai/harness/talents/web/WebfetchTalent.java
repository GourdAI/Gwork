/*
 * Copyright 2017-2025 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.harness.talents.web;

import com.vladsch.flexmark.html2md.converter.FlexmarkHtmlConverter;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import com.gourdai.ai.annotation.ToolMapping;
import com.gourdai.ai.chat.talent.AbsTalent;
import com.gourdai.ai.util.RetryTask;
import org.noear.solon.annotation.Param;
import org.noear.solon.core.util.Assert;
import org.noear.solon.net.http.HttpResponse;
import org.noear.solon.net.http.HttpTimeout;
import org.noear.solon.net.http.HttpUtils;

import java.nio.charset.Charset;
import java.nio.charset.IllegalCharsetNameException;
import java.nio.charset.StandardCharsets;
import java.nio.charset.UnsupportedCharsetException;
import java.time.Duration;
import java.util.Base64;

/**
 * Web 抓取工具 (类似 curl)
 *
 * @author oisin
 * @since 3.9.6
 * */
public class WebfetchTalent extends AbsTalent {
    private static final int DEFAULT_TIMEOUT_MS = 30000;
    private static final int MAX_TIMEOUT_MS = 120000;
    private static final long MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB 硬限制

    private int maxRetries = 3;
    private String userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

    public WebfetchTalent retryConfig(int maxRetries, long retryDelayMs) {
        this.maxRetries = Math.max(1, maxRetries);
        return this;
    }

    public WebfetchTalent retryConfig(int maxRetries) {
        this.maxRetries = Math.max(1, maxRetries);
        return this;
    }

    public WebfetchTalent userAgent(String userAgent) {
        if (Assert.isNotEmpty(userAgent)) {
            this.userAgent = userAgent;
        }
        return this;
    }

    @ToolMapping(name = "webfetch", description = "从 URL 获取网页内容。返回 Markdown，正文前包含 YAML Front Matter 元数据。")
    public String webfetch(
            @Param(name = "url", description = "目标网页的完整 URL（必须包含 http:// 或 https://）") String url,
            @Param(name = "format", required = false, defaultValue = "markdown", description = "返回格式：'markdown', 'text', 'html'") String format,
            @Param(name = "timeoutMs", required = false, description = "超时时间（毫秒），最大 120_000 毫秒") Integer timeoutMs
    ) throws Exception {

        // 1. URL 校验
        if (url == null || (!url.startsWith("http://") && !url.startsWith("https://"))) {
            throw new IllegalArgumentException("URL must start with http:// or https://");
        }

        // 2. 超时计算
        int finalTimeoutMs = (timeoutMs == null) ? DEFAULT_TIMEOUT_MS : timeoutMs;
        if(finalTimeoutMs > 0){
            finalTimeoutMs = Math.min(finalTimeoutMs, MAX_TIMEOUT_MS);
        } else {
            finalTimeoutMs = DEFAULT_TIMEOUT_MS;
        }

        Duration timeout = Duration.ofMillis(finalTimeoutMs);

        String finalFormat = (format == null) ? "markdown" : format.toLowerCase();

        // 3. 构建请求 headers
        HttpUtils http = HttpUtils.http(url)
                .header("User-Agent", userAgent)
                .header("Accept", getAcceptHeader(finalFormat))
                .header("Accept-Language", "en-US,en;q=0.9")
                .timeout(HttpTimeout.of(timeout));

        // 4. 执行请求（带总时长预算 deadline）
        // 问题：maxRetries=3，且命中 Cloudflare 分支时每次尝试会额外再发一次请求，
        // 最坏 6 × 单次超时（默认 30s → 180s；参数上限 120s → 720s），弱网下用户等待不可接受。
        // 预算取值 = 单次 timeout × 2，并封顶 MAX_TIMEOUT_MS(120s)：
        //   1) ×2 而非 ×1：保证「首次尝试 + 至少一次完整重试」的机会，弱网瞬时抖动一次重试即可自愈，
        //      若取 ×1 则第二次尝试几乎必然被预算拒绝，等于变相废掉重试；
        //   2) 封顶 120s：与本类 MAX_TIMEOUT_MS 同口径，是交互式工具调用可接受的等待上限。
        // 语义说明：预算只在「准备发起下一次尝试前」裁决，不打断已在进行中的请求，
        // 故实际最坏等待 ≈ 预算 + 一次单次超时；也不改动 maxRetries 本身的重试次数语义。
        // 正常（快速）请求：首次尝试即成功，永不触发该判定。
        final long totalBudgetMs = Math.min((long) finalTimeoutMs * 2L, MAX_TIMEOUT_MS);
        final long startNanos = System.nanoTime();
        final Throwable[] lastError = new Throwable[1];

        HttpResponse response = new RetryTask()
                .maxRetries(maxRetries)
                // 预算耗尽属终态失败：返回 false 令 RetryTask 立即抛出原始异常，不再退避等待与后续重试
                .retryIf(e -> (e instanceof TotalBudgetExceededException) == false)
                .callWithRetry(() -> {
                    // lastError 非空即代表本次为「重试」尝试，首次尝试恒不受预算约束
                    long elapsedMs = (System.nanoTime() - startNanos) / 1_000_000L;
                    if (lastError[0] != null && elapsedMs >= totalBudgetMs) {
                        throw new TotalBudgetExceededException(
                                "Request aborted: total time budget exhausted (" + elapsedMs
                                        + "ms elapsed, budget " + totalBudgetMs + "ms). Last error: "
                                        + lastError[0].getMessage(), lastError[0]);
                    }

                    try {
                        HttpResponse resp = http.exec("GET");
                        if (resp.code() == 403 && "challenge".equals(resp.header("cf-mitigated"))) {
                            // Cloudflare 穿透逻辑：这是一次额外的物理请求，同样纳入总预算；
                            // 预算已耗尽时不再追加发送，直接把 403 交给后续状态码校验收尾。
                            if ((System.nanoTime() - startNanos) / 1_000_000L < totalBudgetMs) {
                                resp = http.header("User-Agent", "opencode")
                                        .exec("GET");
                            }
                        }

                        return resp;
                    } catch (Throwable e) {
                        // 记录已有的错误信息：预算耗尽时作为错误文案与 cause 一并带出
                        lastError[0] = e;
                        throw e;
                    }
                });

        if (response.code() >= 400) {
            throw new RuntimeException("Request failed with status code: " + response.code());
        }

        // 5. 5MB 限制校验
        long contentLength = response.contentLength();
        if (contentLength > MAX_RESPONSE_SIZE) {
            throw new RuntimeException("Response too large (exceeds 5MB limit)");
        }

        byte[] bodyBytes = response.bodyAsBytes();
        if (bodyBytes == null || bodyBytes.length > MAX_RESPONSE_SIZE) {
            throw new RuntimeException("Response too large (exceeds 5MB limit)");
        }

        String contentType = response.header("Content-Type");
        if (contentType == null) contentType = "";
        String mime = contentType.split(";")[0].trim().toLowerCase();

        // 6. 图片处理
        boolean isImage = mime.startsWith("image/") && !mime.contains("svg") && !mime.contains("vnd.fastbidsheet");
        if (isImage) {
            String base64 = Base64.getEncoder().encodeToString(bodyBytes);
            return "data:" + mime + ";base64," + base64;
        }

        // 7. 内容转换核心逻辑
        String rawContent = new String(bodyBytes, resolveCharset(contentType));
        String output;

        // 仅在 Content-Type 为 HTML 时进行转换，否则直接输出
        boolean isHtml = "text/html".equals(mime);

        if ("markdown".equals(finalFormat) && isHtml) {
            output = convertHtmlToMarkdown(rawContent);
        } else if ("text".equals(finalFormat) && isHtml) {
            output = extractTextFromHtml(rawContent);
        } else {
            output = rawContent;
        }

        return output;
    }


    private String extractTextFromHtml(String html) {
        Document doc = Jsoup.parse(html);
        // 移除不可见内容标签
        doc.select("script, style, noscript, iframe, object, embed").remove();
        return doc.text().trim();
    }

    private String convertHtmlToMarkdown(String html) {
        // 使用 Flexmark 进行转换，配置尽量简约
        return FlexmarkHtmlConverter.builder().build().convert(html);
    }

    private String getAcceptHeader(String format) {
        if ("markdown".equals(format)) {
            return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
        } else if ("text".equals(format)) {
            return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
        } else if ("html".equals(format)) {
            return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
        } else {
            return "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
        }
    }

    private Charset resolveCharset(String contentType) {
        if (contentType != null) {
            for (String part : contentType.split(";")) {
                String item = part.trim();
                if (item.regionMatches(true, 0, "charset=", 0, 8)) {
                    String charsetName = item.substring(8).trim();
                    if (charsetName.length() > 1 && charsetName.startsWith("\"") && charsetName.endsWith("\"")) {
                        charsetName = charsetName.substring(1, charsetName.length() - 1);
                    }

                    try {
                        return Charset.forName(charsetName);
                    } catch (IllegalCharsetNameException | UnsupportedCharsetException ignored) {
                        break;
                    }
                }
            }
        }

        return StandardCharsets.UTF_8;
    }

    /**
     * 总时长预算耗尽（终态异常，不可重试）。
     *
     * <p>与本类既有失败风格一致（RuntimeException + 英文消息），并携带最后一次真实失败原因作为 cause。</p>
     */
    private static class TotalBudgetExceededException extends RuntimeException {
        TotalBudgetExceededException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
