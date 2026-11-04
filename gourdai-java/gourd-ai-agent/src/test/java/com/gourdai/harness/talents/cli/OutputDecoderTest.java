/*
 * OutputDecoder 契约测试：UTF-8 优先 + Windows 遗留代码页兜底 + 流式跨块不截断。
 *
 * 背景（用户实测定罪的真缺陷，本测试锁死回归）：Web 终端首帧 banner 由裸 cmd 采集，
 * 中文 Windows 上按系统 ANSI 代码页（GBK）输出；硬编码 UTF-8 解码会把「版本/版权所有」
 * 解成替换符乱码。解码统一走本类，故其判定与流式残字节行为必须有测试兜底。
 */
package com.gourdai.harness.talents.cli;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

class OutputDecoderTest {

    private static final boolean IS_WIN =
            System.getProperty("os.name", "").toLowerCase().contains("win");
    private static final Charset GBK = Charset.forName("GBK");

    // ---------- decodeAll：一次性路径 ----------

    @Test
    void decodeAllKeepsValidUtf8() {
        String text = "Microsoft Windows [版本 10.0.26300.9711]\n版权所有。\n";
        assertEquals(text, OutputDecoder.decodeAll(text.getBytes(StandardCharsets.UTF_8), StandardCharsets.UTF_8));
    }

    @Test
    void decodeAllPureAscii() {
        String text = "C:\\work\\workspace>dir\r\n";
        assertEquals(text, OutputDecoder.decodeAll(text.getBytes(StandardCharsets.US_ASCII), StandardCharsets.UTF_8));
    }

    @Test
    void decodeAllFallsBackToLegacyCodePageOnWindows() {
        Assumptions.assumeTrue(IS_WIN, "遗留代码页兜底仅 Windows 有意义");
        String text = "Microsoft Windows [版本 10.0.26300.9711]\n(c) Microsoft Corporation。保留所有权利。\n";
        byte[] gbk = text.getBytes(GBK);
        // 前提守卫：GBK 字节对本用例必须不是合法 UTF-8，否则测不到兜底分支
        Assumptions.assumeFalse(isStrictUtf8(gbk));
        assertEquals(text, OutputDecoder.decodeAll(gbk, StandardCharsets.UTF_8),
                "GBK 字节不得被硬解成 UTF-8 替换符乱码");
    }

    // ---------- 流式路径：跨块截断与字符集锁定 ----------

    @Test
    void streamingUtf8SurvivesChunkBoundaryCut() {
        String text = "你好，世界；终端输出跨块不截断。";
        byte[] all = text.getBytes(StandardCharsets.UTF_8);
        OutputDecoder decoder = new OutputDecoder(StandardCharsets.UTF_8);
        // 切口选在多字节字符中间（第 4 字节：「好」的第 1 字节处）
        int cut = 4;
        String out = decoder.decode(all, cut)
                + decoder.decode(slice(all, cut, all.length), all.length - cut)
                + decoder.flush();
        assertEquals(text, out, "跨 4096 式读取边界切断的多字节字符不得产生替换符");
        assertFalse(out.indexOf('\uFFFD') >= 0);
    }

    @Test
    void streamingPureAsciiStaysUnlocked() {
        OutputDecoder decoder = new OutputDecoder(StandardCharsets.UTF_8);
        assertEquals("hello\r\n", decoder.decode("hello\r\n".getBytes(StandardCharsets.US_ASCII), 7));
        assertNull(decoder.selectedCharset(), "纯 ASCII 不应提前锁定字符集");
        assertEquals("", decoder.flush());
    }

    @Test
    void streamingGbkLocksToLegacyOnWindows() {
        Assumptions.assumeTrue(IS_WIN, "遗留代码页兜底仅 Windows 有意义");
        String text = "版权所有。\r\n";
        byte[] gbk = text.getBytes(GBK);
        Assumptions.assumeFalse(isStrictUtf8(gbk));
        OutputDecoder decoder = new OutputDecoder(StandardCharsets.UTF_8);
        String out = decoder.decode(gbk, gbk.length) + decoder.flush();
        assertEquals(text, out, "流式 GBK 输出应锁定遗留代码页正确解码");
        assertEquals(GBK, decoder.selectedCharset());
    }

    // ---------- 工具 ----------

    private static byte[] slice(byte[] src, int from, int to) {
        byte[] rest = new byte[to - from];
        System.arraycopy(src, from, rest, 0, rest.length);
        return rest;
    }

    private static boolean isStrictUtf8(byte[] bytes) {
        return OutputDecoder.select(bytes, 0, bytes.length, StandardCharsets.UTF_8, GBK)
                == StandardCharsets.UTF_8;
    }
}
