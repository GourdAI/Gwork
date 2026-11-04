package com.gourdai.ai.chat;

import org.noear.snack4.ONode;
import org.noear.solon.Utils;
import org.noear.solon.net.http.HttpResponse;
import org.noear.solon.net.http.HttpResponseException;

import java.nio.charset.StandardCharsets;

/**
 * 模型服务错误信息提取器：把异常链（尤其是 HTTP 错误响应）转成用户可直接读懂的失败原因。
 *
 * <p><b>背景：</b>底层 HTTP 客户端抛出的 {@link HttpResponseException}，其 message 只包含
 * 「状态码 + 请求方法 + URL」（如 {@code 500 from POST https://...}），而供应商真正想说的
 * 错误内容在响应体里（如 {@code {"error":{"message":"No tool output found ..."}}}），
 * 被藏在 {@code bodyBytes} 字段中从不展示——用户只看到"暂时无法使用模型服务"，无法定位问题。</p>
 *
 * <p>本类统一做三件事：</p>
 * <ol>
 *   <li>{@link #httpErrorOf(HttpResponse)}：HTTP 4xx/5xx 时，读取响应体并构建携带真实错误消息
 *       <b>与类型化状态码</b>的 {@link LlmHttpStatusException}（流式与非流式请求路径共用）；</li>
 *   <li>{@link #describe(Throwable)}：从任意异常（含包装链）提取最贴近根因的可读描述，
 *       供最终失败答复、错误帧等展示位使用；</li>
 *   <li>{@link #extractBodyMessage(String)}：解析响应体 JSON，兼容 OpenAI
 *       {@code {"error":{"message","type","code"}}}、Anthropic {@code {"type":"error","error":{...}}}、
 *       Gemini {@code {"error":{"code","message","status"}}} 及顶层 {@code {"message"}} 等形态；
 *       非响应体形态的常用字段同名即可命中，无则原样截断返回。</li>
 * </ol>
 *
 * @author oisin
 */
public final class LlmErrorMessages {
    /** 用户可见的错误详情上限：兼顾可读性与帧体积（回放预算单帧上限内） */
    private static final int MAX_CHARS = 400;
    /** 因果链最大下钻深度：防御性上限，防自引用循环 */
    private static final int MAX_CAUSE_DEPTH = 6;

    private LlmErrorMessages() {
    }

    /**
     * 从 HTTP 响应构建模型调用异常：状态码 + 响应体中的真实错误消息。
     *
     * <p>响应体只能读取一次，故此处读出后即完成消息组装，不再依赖
     * {@link HttpResponse#createError()}（其返回的异常不带返回体消息）。</p>
     *
     * <p><b>返回类型化状态码</b>（{@link LlmHttpStatusException}）：状态码此前只以
     * {@code "HTTP 400: ..."} 的文本前缀存在，导致「确定性错误不重试」判定只能靠字符串匹配。
     * 本类是流式（{@code doStream}）与非流式（{@code execAndReadBody}）两条路径的<b>唯一</b>
     * HTTP 失败出口，故在此处一次性把状态码提升为字段，判定即可基于真实取到的值。</p>
     *
     * @param resp 非成功状态（>=400）的 HTTP 响应
     * @return 携带「HTTP 400: xxx」形态消息与状态码字段的异常
     */
    public static LlmHttpStatusException httpErrorOf(HttpResponse resp) {
        String body = null;
        try {
            body = resp.bodyAsString();
        } catch (Throwable ignore) {
            // 读取失败（连接已断等）时退化为仅状态码描述
        }
        return httpErrorOf(resp.code(), resp.message(), body);
    }

    /**
     * 由「状态码 + 状态行描述 + 响应体原文」构建携带类型化状态码的异常。
     *
     * <p>消息文本仍由 {@link #httpErrorText} 组装，与历史版本逐字一致，
     * 故 {@link #describe} 及一切展示位的行为不变。</p>
     *
     * @param code          HTTP 状态码
     * @param statusMessage 状态行描述（可为空）
     * @param body          响应体原文（可为空）
     * @since 4.1
     */
    public static LlmHttpStatusException httpErrorOf(int code, String statusMessage, String body) {
        return new LlmHttpStatusException(code, httpErrorText(code, statusMessage, body));
    }

    /**
     * 组装「HTTP 状态码 + 返回体错误消息」文本。
     *
     * @param code          HTTP 状态码
     * @param statusMessage 状态行描述（可为空）
     * @param body          响应体原文（可为空）
     * @return 如 {@code HTTP 400 Bad Request: No tool output found for tool call ...}
     */
    public static String httpErrorText(int code, String statusMessage, String body) {
        String head = "HTTP " + code;
        if (Utils.isNotEmpty(statusMessage)) {
            head = head + " " + statusMessage.trim();
        }

        String detail = extractBodyMessage(body);
        if (Utils.isEmpty(detail)) {
            return head;
        }
        return head + ": " + detail;
    }

    /**
     * 从任意异常中提取用户可读的失败原因。
     *
     * <p>规则：</p>
     * <ol>
     *   <li>因果链上存在 {@link HttpResponseException} 时，优先以「状态码 + 响应体消息」描述
     *       （兼容未经过 {@link #httpErrorOf} 改造的调用路径）；</li>
     *   <li>否则取因果链<b>最深层</b>的非空消息（贴近根因，滤掉外层包装的泛化描述）；</li>
     *   <li>都取不到时退化为异常简单类名。</li>
     * </ol>
     *
     * @param e 待描述异常，可为 null
     * @return 永不为空的错误描述（已截断）
     */
    public static String describe(Throwable e) {
        if (e == null) {
            return "Unknown error";
        }

        // 1) 因果链上的 HTTP 响应异常：携带原始返回体，优先展开
        Throwable cur = e;
        for (int depth = 0; cur != null && depth < MAX_CAUSE_DEPTH; depth++) {
            if (cur instanceof HttpResponseException) {
                HttpResponseException hre = (HttpResponseException) cur;
                String body = null;
                if (hre.bodyBytes() != null && hre.bodyBytes().length > 0) {
                    body = new String(hre.bodyBytes(), StandardCharsets.UTF_8);
                }
                return truncate(httpErrorText(hre.code(), hre.message(), body));
            }
            cur = cur.getCause();
        }

        // 2) 其余异常：取最深层非空消息
        String deepest = null;
        cur = e;
        for (int depth = 0; cur != null && depth < MAX_CAUSE_DEPTH; depth++) {
            if (Utils.isNotEmpty(cur.getMessage())) {
                deepest = cur.getMessage();
            }
            cur = cur.getCause();
        }
        if (Utils.isEmpty(deepest)) {
            return e.getClass().getSimpleName();
        }
        return truncate(deepest);
    }

    /**
     * 从响应体原文中提取真实错误消息。
     *
     * <p>兼容形态（按序尝试）：</p>
     * <ul>
     *   <li>{@code error} 为对象：取 {@code message}，有 {@code type}/{@code code} 则前缀
     *       {@code [type] }（OpenAI / Anthropic / Gemini 同构）</li>
     *   <li>{@code error} 为字符串：直接使用</li>
     *   <li>顶层 {@code message}：直接使用</li>
     *   <li>其余（含解析失败、HTML 错误页）：原样截断返回</li>
     * </ul>
     *
     * @param body 响应体原文，可为空
     * @return 提取出的错误消息；响应体为空时返回 null
     */
    public static String extractBodyMessage(String body) {
        if (Utils.isEmpty(body)) {
            return null;
        }
        String trimmed = body.trim();
        if (trimmed.isEmpty()) {
            return null;
        }

        // 非 JSON 对象形态（纯文本 / HTML 错误页）直接截断返回
        if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
            return truncate(trimmed);
        }

        try {
            ONode root = ONode.ofJson(trimmed);

            ONode errorNode = root.get("error");
            if (errorNode != null && !errorNode.isNull()) {
                if (errorNode.isObject()) {
                    String message = strOf(errorNode, "message");
                    if (Utils.isNotEmpty(message)) {
                        String type = strOf(errorNode, "type");
                        if (Utils.isEmpty(type)) {
                            type = strOf(errorNode, "status");
                        }
                        if (Utils.isEmpty(type)) {
                            type = strOf(errorNode, "code");
                        }
                        if (Utils.isNotEmpty(type)) {
                            return truncate("[" + type + "] " + message);
                        }
                        return truncate(message);
                    }
                } else {
                    // error 为字符串等标量形态
                    String message = errorNode.getString();
                    if (Utils.isNotEmpty(message)) {
                        return truncate(message);
                    }
                }
            }

            // 顶层 message（部分网关 / 代理的简化错误形态）
            String message = strOf(root, "message");
            if (Utils.isNotEmpty(message)) {
                return truncate(message);
            }

            return truncate(trimmed);
        } catch (Throwable ignore) {
            // JSON 解析失败：原样截断返回
            return truncate(trimmed);
        }
    }

    /** 取子节点字符串值（缺失或节点为 null 时返回 null，与 snack4 两种 get 语义均兼容）。 */
    private static String strOf(ONode node, String key) {
        ONode child = node.get(key);
        return child == null ? null : child.getString();
    }

    /** 去除首尾空白并截断到展示上限（超长以省略号结尾）。null 安全。 */
    private static String truncate(String text) {
        if (text == null) {
            return null;
        }
        String t = text.trim();
        if (t.length() <= MAX_CHARS) {
            return t;
        }
        return t.substring(0, MAX_CHARS) + "…";
    }
}
