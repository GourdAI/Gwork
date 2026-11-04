package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

/**
 * SessionCwdCodec 契约测试 —— X-Session-Cwd 头的中文路径修复（2026-10）。
 *
 * <p>背景：HTTP 头值只允许 ISO-8859-1，浏览器对含中文的头值在 setRequestHeader /
 * Headers 构造时直接抛异常（Chromium 实测 "String contains non ISO-8859-1 code
 * point"），请求根本发不出去。前端已统一经 encodeURIComponent 编码
 * （app-base.js 的 encodeSessionCwdHeader），本测试锁死读侧还原语义：</p>
 * <ul>
 *   <li>component 语义（'+' 是字面量而非空格）——与 URLDecoder 的表单语义区分；</li>
 *   <li>纯 ASCII 快速路径零行为变化（旧客户端兼容）；</li>
 *   <li>残缺百分号序列回退原串（交由上层既有安全校验处理）。</li>
 * </ul>
 *
 * <p>共享测试向量 {@code D%3A%5C%E5%B7%A5%E4%BD%9C%5C%E9%A1%B9%E7%9B%AEA}
 * （= encodeURIComponent("D:\工作\项目A")）在 JS 侧 cjk-session-cwd-header.test.js
 * 与 Rust 侧 server.rs 的 percent_decode_component 测试中同字面量出现，三方互为
 * 对照——任何一端的编码/解码语义漂移都会在对端测试里暴露。</p>
 */
public class SessionCwdCodecTest {

    /** 三端共享向量：见类注释。 */
    private static final String CJK_PATH = "D:\\工作\\项目A";
    private static final String CJK_ENCODED = "D%3A%5C%E5%B7%A5%E4%BD%9C%5C%E9%A1%B9%E7%9B%AEA";

    @Test
    public void testNullAndEmptyPassthrough() {
        Assertions.assertNull(SessionCwdCodec.decode(null));
        Assertions.assertEquals("", SessionCwdCodec.decode(""));
    }

    @Test
    public void testPureAsciiFastPathIsIdentity() {
        // 不含 '%' 与 '+' 的头值原样返回：旧客户端（curl / 旧桌面端直接放原始 ASCII
        // 路径）与改造前行为逐字节一致，零回归面。
        Assertions.assertEquals("D:\\work\\proj", SessionCwdCodec.decode("D:\\work\\proj"));
        Assertions.assertEquals("/home/u/proj", SessionCwdCodec.decode("/home/u/proj"));
    }

    @Test
    public void testDecodesPercentEncodedChinesePath() {
        Assertions.assertEquals(CJK_PATH, SessionCwdCodec.decode(CJK_ENCODED));
    }

    @Test
    public void testPlusIsLiteralNotSpace() {
        // encodeURIComponent 的 '+' 是字面量：先转义 %2B 再走 URLDecoder 的实现细节
        // 若被改回直接 URLDecoder.decode，这里会得到 "D:\C  proj"（空格）而失败。
        Assertions.assertEquals("D:\\C++proj", SessionCwdCodec.decode("D%3A%5CC%2B%2Bproj"));
        // 未编码的 '+'（旧客户端 / 纯 ASCII 路径）：原样返回，不能变成空格
        Assertions.assertEquals("D:\\C++proj", SessionCwdCodec.decode("D:\\C++proj"));
        // 负对照：decodeURI 系的表单语义不得出现
        Assertions.assertNotEquals("a b", SessionCwdCodec.decode("a+b"));
    }

    @Test
    public void testSpaceRoundTrip() {
        // encodeURIComponent 把空格编成 %20（不是 '+'）
        Assertions.assertEquals("a b", SessionCwdCodec.decode("a%20b"));
    }

    @Test
    public void testMalformedSequencesFallBackToRaw() {
        // 非法十六进制 / 残缺百分号：原样返回（上层 contains("..") 等安全校验继续生效）
        Assertions.assertEquals("D:%zz", SessionCwdCodec.decode("D:%zz"));
        Assertions.assertEquals("a%", SessionCwdCodec.decode("a%"));
    }

    @Test
    public void testSingleDecodeIsIdempotentForLiteralPercent() {
        // 目录名本身含 "%3A" 字样：前端编码 a%3Ab → a%253Ab，解码一次还原为 a%3Ab；
        // 不会发生二次解码（把字面 %3A 再解成 ':'）
        Assertions.assertEquals("a%3Ab", SessionCwdCodec.decode("a%253Ab"));
    }
}
