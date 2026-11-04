/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.agent.react.intercept;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

/**
 * ToolSanitizerInterceptor 超长输出截断契约。
 *
 * <p><b>为什么这个测试是本轮补的：</b>截断逻辑原先内联在 interceptTool 里，依赖 ToolChain/ReActTrace，
 * 全仓零测试覆盖。改成「头尾保留」时如果切错比例或漏了 surrogate 内缩，全量测试照样 987/987 全绿。
 * 现已抽成 static {@link ToolSanitizerInterceptor#truncateKeepHeadTail(String, int)} 以便直接验证。</p>
 *
 * <p><b>被守护的真实缺陷（O-G）：</b>旧实现是 {@code substring(0, cap)} 只留头部，而本工程工具的
 * 关键结论几乎全在输出末尾——{@code [exit_code=N]}、{@code BUILD SUCCESS/FAILURE}、
 * {@code Tests run: x, Failures: y}。全截掉后模型看到「一堆日志 + 没有结果」，
 * 会把已成功的构建当未知状态重跑，或把失败当通过。</p>
 *
 * <p><b>写法纪律：</b>每条关键断言都配一个「内联复现旧实现」的负对照，先证明负对照确实丢信息，
 * 再证明生产版本不丢。否则断言可能恒真（绿色假象）——本仓已多次栽在这上面。</p>
 *
 * @author oisin
 */
public class ToolSanitizerTruncateContractTest {

    /** 😀 = U+1F600，UTF-16 下是 高代理 0xD83D + 低代理 0xDE00 两个 char。 */
    private static final String EMOJI = "\uD83D\uDE00";

    private static final String TAIL_MARKER = "BUILD SUCCESS\nTests run: 987, Failures: 0\n[exit_code=0]";

    /** 构造一个「关键结论全在末尾」的真实形态输出。 */
    private static String buildOutput(int fillerLen) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < fillerLen; i++) {
            sb.append((char) ('a' + (i % 26)));
        }
        return sb.append(TAIL_MARKER).toString();
    }

    /** 旧实现：只保留头部。作负对照用。 */
    private static String headOnly(String raw, int cap) {
        return raw.substring(0, cap) + "... [Content Truncated]";
    }

    /**
     * O-G 的核心：截断后必须仍能看到 BUILD SUCCESS / Tests run / exit_code。
     *
     * <p>负对照同时证明「只留头部」确实会丢掉这些——否则本断言可能恒真。</p>
     */
    @Test
    public void mustPreserveTailConclusions() {
        String raw = buildOutput(2000);
        int cap = 400;

        // 负对照自检：旧实现确实丢掉了全部结论
        String old = headOnly(raw, cap);
        Assertions.assertFalse(old.contains("BUILD SUCCESS"), "负对照应丢掉 BUILD SUCCESS，否则本用例无意义");
        Assertions.assertFalse(old.contains("[exit_code=0]"), "负对照应丢掉 exit_code，否则本用例无意义");

        String r = ToolSanitizerInterceptor.truncateKeepHeadTail(raw, cap);
        Assertions.assertTrue(r.contains("BUILD SUCCESS"), "必须保留构建结论: " + tail(r));
        Assertions.assertTrue(r.contains("Tests run: 987, Failures: 0"), "必须保留测试摘要: " + tail(r));
        Assertions.assertTrue(r.contains("[exit_code=0]"), "必须保留退出码: " + tail(r));
    }

    /** 头部上下文也要保留（否则模型不知道这堆日志属于哪个命令）。 */
    @Test
    public void mustPreserveHeadContext() {
        String raw = "HEAD_CONTEXT_LINE\n" + buildOutput(2000);
        int cap = 400;

        String r = ToolSanitizerInterceptor.truncateKeepHeadTail(raw, cap);
        Assertions.assertTrue(r.startsWith("HEAD_CONTEXT_LINE"), "必须保留头部起始内容");
    }

    /** 中间省略标记要说明被截了多少字符，并引导用分页取回。 */
    @Test
    public void mustAnnotateTruncatedMiddle() {
        String raw = buildOutput(2000);
        int cap = 400;

        String r = ToolSanitizerInterceptor.truncateKeepHeadTail(raw, cap);
        Assertions.assertTrue(r.contains("chars truncated"), "应有省略标记: " + mid(r));
        Assertions.assertTrue(r.contains("pagination/offset"), "应引导分页取回中间内容: " + mid(r));
        Assertions.assertTrue(r.contains("head and tail preserved"), "应说明保留了头尾: " + mid(r));
    }

    /**
     * 尾部权重必须大于头部：这是 O-G 的设计意图。
     *
     * <p>HEAD_RATIO=0.4，故尾部约 60%。若有人把比例改成 0.9（近似旧的「只留头部」），
     * 本用例会变红。</p>
     */
    @Test
    public void tailWindowMustBeLargerThanHead() {
        String raw = buildOutput(2000);
        int cap = 400;
        String r = ToolSanitizerInterceptor.truncateKeepHeadTail(raw, cap);

        int markerStart = r.indexOf("\n... [");
        int markerEnd = r.indexOf("] ...\n") + "] ...\n".length();
        Assertions.assertTrue(markerStart > 0 && markerEnd > markerStart, "应能找到省略标记边界");

        int headLen = markerStart;
        int tailLen = r.length() - markerEnd;
        Assertions.assertTrue(tailLen > headLen,
                "尾部窗口必须大于头部（结论在末尾）：head=" + headLen + " tail=" + tailLen);
    }

    /**
     * 截断后的总长不得显著突破 cap：省略标记是常数长度，超出量必须有界。
     *
     * <p>这是 cap 作为「上下文预算」语义的护栏。标记约 90 字符，对 CAP_STRICT=8000 是 1% 级别，
     * 可接受；但若有人把标记写成与 raw 等长，本用例会变红。</p>
     */
    @Test
    public void totalLengthOvershootMustBeBounded() {
        String raw = buildOutput(2000);
        for (int cap : new int[]{100, 400, 8000}) {
            String r = ToolSanitizerInterceptor.truncateKeepHeadTail(raw, cap);
            Assertions.assertTrue(r.length() <= cap + 200,
                    "cap=" + cap + " 时总长超出过多: " + r.length());
        }
    }

    /** 不超限原样返回（同一引用，不复制）。 */
    @Test
    public void shouldReturnSameInstanceWhenWithinLimit() {
        String s = "short output";
        Assertions.assertSame(s, ToolSanitizerInterceptor.truncateKeepHeadTail(s, 100));
        Assertions.assertSame(s, ToolSanitizerInterceptor.truncateKeepHeadTail(s, s.length()));
        Assertions.assertNull(ToolSanitizerInterceptor.truncateKeepHeadTail(null, 10));
        Assertions.assertSame(s, ToolSanitizerInterceptor.truncateKeepHeadTail(s, 0));
        Assertions.assertSame(s, ToolSanitizerInterceptor.truncateKeepHeadTail(s, -1));
    }

    /** 头部切点不得留下孤立高代理项。 */
    @Test
    public void mustNotLeaveLoneHighSurrogateAtHeadBoundary() {
        // cap=10 → head=(int)(10*0.4)=4 → charAt(head-1=3) 是高代理，命中内缩
        String s = "AAA" + EMOJI + "BBBBBBBBBBBB";
        int cap = 10;

        String naive = naiveHeadTail(s, cap);
        Assertions.assertTrue(hasLoneSurrogate(naive),
                "构造自检失败：负对照本应产生孤立代理项。naive=" + escape(naive));

        String prod = ToolSanitizerInterceptor.truncateKeepHeadTail(s, cap);
        assertWellFormedUtf16(prod, "头部边界 cap=" + cap);
    }

    /** 尾部切点不得留下孤立低代理项。 */
    @Test
    public void mustNotLeaveLoneLowSurrogateAtTailBoundary() {
        // cap=5 → head=2, tail=3；len=13 → tailStart=10
        String s = "AAAAAAAA" + EMOJI + "AAA"; // 下标 8=高代理, 9=低代理, 10-12=A
        int cap = 8; // head=3, tail=5 → tailStart=13-5=8=高代理位；扫多档更稳
        for (int c = 2; c < s.length(); c++) {
            String prod = ToolSanitizerInterceptor.truncateKeepHeadTail(s, c);
            assertWellFormedUtf16(prod, "尾部边界 cap=" + c);
        }
        Assertions.assertNotNull(cap);
    }

    /** 中文密集输出（工具结果常态）扫全部 cap 档位都必须良构。 */
    @Test
    public void mustStayWellFormedForCjkDenseOutput() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 40; i++) {
            sb.append("中文输出片段").append(i).append(EMOJI);
        }
        String s = sb.toString();
        for (int cap = 8; cap < 200; cap += 7) {
            assertWellFormedUtf16(
                    ToolSanitizerInterceptor.truncateKeepHeadTail(s, cap), "CJK cap=" + cap);
        }
    }

    /** 截断结果必须能通过 JSON 序列化且不含 U+FFFD（孤立代理项在真实链路的表现）。 */
    @Test
    public void truncatedResultMustSurviveJsonSerialization() {
        String s = "前缀说明" + EMOJI + buildOutput(800) + EMOJI + "END";
        for (int cap = 20; cap <= 200; cap += 20) {
            String r = ToolSanitizerInterceptor.truncateKeepHeadTail(s, cap);
            assertWellFormedUtf16(r, "json cap=" + cap);
            String json = org.noear.snack4.ONode.serialize(r);
            Assertions.assertNotNull(json);
            Assertions.assertFalse(json.contains("\uFFFD"),
                    "JSON 不应出现 U+FFFD（说明切断了代理项）: cap=" + cap);
        }
    }

    // ── 辅助 ──────────────────────────────────────────────

    /** 复现「未修正的硬切」：头 40% + 尾 60%，不做 surrogate 内缩。仅作负对照。 */
    private static String naiveHeadTail(String raw, int cap) {
        if (raw == null || cap <= 0 || raw.length() <= cap) {
            return raw;
        }
        int head = (int) (cap * 0.4d);
        int tail = cap - head;
        return raw.substring(0, head) + "\n... [naive] ...\n" + raw.substring(raw.length() - tail);
    }

    /** 是否含孤立代理项。 */
    private static boolean hasLoneSurrogate(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (i + 1 >= s.length() || !Character.isLowSurrogate(s.charAt(i + 1))) {
                    return true;
                }
                i++;
            } else if (Character.isLowSurrogate(c)) {
                return true;
            }
        }
        return false;
    }

    private static void assertWellFormedUtf16(String s, String ctx) {
        Assertions.assertFalse(hasLoneSurrogate(s),
                "[" + ctx + "] 含孤立代理项: " + escape(s));
    }

    private static String tail(String s) {
        return s.length() > 200 ? "..." + s.substring(s.length() - 200) : s;
    }

    private static String mid(String s) {
        int i = s.indexOf("\n... [");
        return i < 0 ? s : s.substring(i, Math.min(s.length(), i + 160));
    }

    private static String escape(String s) {
        StringBuilder b = new StringBuilder();
        for (char c : s.toCharArray()) {
            if (c < 32 || c > 126) {
                b.append(String.format("\\u%04x", (int) c));
            } else {
                b.append(c);
            }
        }
        return b.length() > 400 ? b.substring(0, 400) + "..." : b.toString();
    }
}
