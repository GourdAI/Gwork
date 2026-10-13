package com.gourdai.core.portal.web;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;

/**
 * {@code X-Session-Cwd} 请求头的解码收敛点（中文路径修复，2026-10）。
 *
 * <p><b>背景</b>：HTTP 头值按规范只允许 ISO-8859-1 字符，浏览器（Chromium 实测）对
 * 含中文/emoji 等非 ASCII 的头值在 {@code setRequestHeader} / {@code Headers} 构造时
 * 直接抛异常（"String contains non ISO-8859-1 code point"），请求根本发不出去——
 * 用户表现为「工作空间路径含中文时消息发送失败」。因此前端已统一改为经
 * {@code encodeURIComponent}（app-base.js 的 {@code encodeSessionCwdHeader}）编码后再
 * 携带该头，本类负责读侧同步还原。</p>
 *
 * <p><b>语义对齐（关键）</b>：前端用的是 {@code encodeURIComponent}（component 语义，
 * {@code +} 原样保留），而不是 {@code application/x-www-form-urlencoded} 语义
 * （空格 ⇌ {@code +}）。所以这里不能直接用 {@link URLDecoder}（它会把 {@code +}
 * 解成空格，路径 {@code D:\C++项目} 会被破坏成 {@code D:\C  项目}）：先把 {@code +}
 * 转义成 {@code %2B} 再交给 {@link URLDecoder}，得到与
 * {@code encodeURIComponent} 严格互逆的解码。Rust 侧代理（server.rs 的
 * {@code percent_decode_component}）与 JS 侧 {@code encodeSessionCwdHeader} 三方同口径。</p>
 *
 * <p><b>兼容性</b>：</p>
 * <ul>
 *   <li>纯 ASCII 路径（无 {@code %} 无 {@code +}）：快速路径原样返回，行为与改造前
 *       完全一致——绝大多数现有用户零影响；</li>
 *   <li>未升级的旧客户端（curl / 旧桌面端）：若头里直接是原始中文（未经编码），同样
 *       命中快速路径原样返回，不会二次破坏；</li>
 *   <li>残缺/非法的百分号序列：解码异常时回退返回原串，交由上层既有安全校验
 *       （如 {@code contains("..")} 拒绝）处理，本类不做额外拦截。</li>
 * </ul>
 *
 * <p><b>幂等性</b>：目录名本身含 {@code %3A} 等字样时（如 {@code a%3Ab}），前端编码为
 * {@code a%253Ab}，本类解码还原为 {@code a%3Ab}——与原路径一致，不会发生二次解码。</p>
 */
public final class SessionCwdCodec {

    private SessionCwdCodec() {
    }

    /**
     * 解码前端经 {@code encodeURIComponent} 编码的 X-Session-Cwd 头值。
     *
     * @param raw 头原始值（可能为 null / 空串 / 纯 ASCII / 百分号编码）
     * @return 还原后的工作区路径；null 与空串原样返回；非法序列回退原串
     */
    public static String decode(String raw) {
        if (raw == null || raw.isEmpty()) {
            return raw;
        }
        // 快速路径：纯 ASCII 路径不含 '%' 与 '+'，无需解码（与改造前行为逐字节一致）
        if (raw.indexOf('%') < 0 && raw.indexOf('+') < 0) {
            return raw;
        }
        try {
            // encodeURIComponent 语义：'+' 是字面量而非空格。先转义成 %2B 再走
            // URLDecoder（其实现是 form 语义），保证与前端编码严格互逆。
            return URLDecoder.decode(raw.replace("+", "%2B"), StandardCharsets.UTF_8);
        } catch (Exception e) {
            // 残缺百分号序列等：原样返回，交由上层安全校验处理
            return raw;
        }
    }
}
