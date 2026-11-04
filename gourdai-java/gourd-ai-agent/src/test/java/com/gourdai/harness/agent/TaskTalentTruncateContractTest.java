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
package com.gourdai.harness.agent;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.util.concurrent.CompletableFuture;

/**
 * TaskTalent.truncateTaskResult / await_tasks 的契约测试。
 *
 * <p>守护本轮修复的两处真实缺陷：</p>
 * <ol>
 *   <li><b>截断按固定下标硬切会切断 surrogate pair。</b>中文/emoji 在 UTF-16 下占两个 char，
 *       旧的 {@code substring(0, half)} + {@code substring(len - half)} 可能把一对代理项从中间劈开，
 *       产生孤立代理项，序列化成 JSON 发给模型时变成 U+FFFD 或被判非法字符。</li>
 *   <li><b>await_tasks 的 token 跨会话可见。</b>TaskTalent 是 HarnessEngine 级单实例、
 *       进程内长期存活，若注册表不分会话，A 会话的 token 在 B 会话也能 await 出结果。</li>
 * </ol>
 *
 * <p><b>surrogate 用例的写法纪律（血的教训）：</b>第一版用「整个结果串是否以孤立代理项结尾」
 * 之类间接断言，结果变异验证 M3/M3b（把 headEnd--/tailStart++ 改成 no-op）全部 SURVIVED——
 * 因为截断结果是以「尾部」结尾的，头部边界的孤立代理项根本测不到，测试是绿色假象。
 * 现在改为：内联复现「未修正硬切」作负对照，先断言负对照【必然】产生孤立代理项
 * （证明构造确实踩中了边界），再断言生产版本【良构】。两者一夹，变异无所遁形。</p>
 *
 * @author oisin
 */
public class TaskTalentTruncateContractTest {

    /** 😀 = U+1F600，在 UTF-16 下是 高代理 0xD83D + 低代理 0xDE00 两个 char。 */
    private static final String EMOJI = "\uD83D\uDE00";

    /** 不超限时原样返回（同一引用，不复制）。 */
    @Test
    public void shouldReturnSameInstanceWhenWithinLimit() {
        String s = "short";
        Assertions.assertSame(s, TaskTalent.truncateTaskResult(s, 100));
        Assertions.assertSame(s, TaskTalent.truncateTaskResult(s, 5));
        Assertions.assertNull(TaskTalent.truncateTaskResult(null, 10));
        // maxChars<=0 视为不限制
        Assertions.assertSame(s, TaskTalent.truncateTaskResult(s, 0));
        Assertions.assertSame(s, TaskTalent.truncateTaskResult(s, -1));
    }

    /** ASCII 超限时头尾各保留、中间插省略标记。 */
    @Test
    public void shouldKeepHeadAndTailForAscii() {
        String s = "0123456789"; // len 10
        String r = TaskTalent.truncateTaskResult(s, 4); // half=2 → head "01" + tail "89"
        Assertions.assertTrue(r.startsWith("01"), "应保留头部: " + r);
        Assertions.assertTrue(r.endsWith("89"), "应保留尾部: " + r);
        Assertions.assertTrue(r.contains("省略"), "应含省略标记: " + r);
    }

    /**
     * 头部边界命中：half 恰好落在 emoji 的高代理项之后，硬切会把高代理项孤立在头部末尾。
     *
     * <p>构造 {@code "AAAA" + 😀 + "BBBBBBBBB"}（下标 0-3=A，4=高代理，5=低代理，6-14=B，len=15），
     * maxChars=10 → half=5 → 未修正时 substring(0,5) 以孤立高代理项结尾。</p>
     */
    @Test
    public void mustNotLeaveLoneHighSurrogateAtHeadBoundary() {
        String s = "AAAA" + EMOJI + "BBBBBBBBB";
        int maxChars = 10; // half=5，charAt(4)=高代理，命中 headEnd-- 修正

        // 负对照自检：证明这个构造确实踩中了头部边界——未修正的硬切必产生孤立代理项
        String naive = naiveHeadTail(s, maxChars);
        Assertions.assertTrue(hasLoneSurrogate(naive),
                "构造自检失败：负对照本应产生孤立代理项，否则本用例测不到任何边界。naive=" + escape(naive));

        // 生产版本必须良构
        String prod = TaskTalent.truncateTaskResult(s, maxChars);
        Assertions.assertFalse(hasLoneSurrogate(prod),
                "生产截断结果不得含孤立代理项: " + escape(prod));
        assertWellFormedUtf16(prod, "头部边界");
    }

    /**
     * 尾部边界命中：len-half 恰好落在 emoji 的低代理项上，硬切会把低代理项孤立在尾部开头。
     *
     * <p>构造 {@code "AAAAAAAA" + 😀 + "AAA"}（下标 0-7=A，8=高代理，9=低代理，10-12=A，len=13），
     * maxChars=8 → half=4 → tailStart=13-4=9=低代理 → 未修正时 substring(9) 以孤立低代理项开头。</p>
     */
    @Test
    public void mustNotLeaveLoneLowSurrogateAtTailBoundary() {
        String s = "AAAAAAAA" + EMOJI + "AAA";
        int maxChars = 8; // half=4，charAt(len-4=9)=低代理，命中 tailStart++ 修正

        String naive = naiveHeadTail(s, maxChars);
        Assertions.assertTrue(hasLoneSurrogate(naive),
                "构造自检失败：负对照本应产生孤立代理项。naive=" + escape(naive));

        String prod = TaskTalent.truncateTaskResult(s, maxChars);
        Assertions.assertFalse(hasLoneSurrogate(prod),
                "生产截断结果不得含孤立代理项: " + escape(prod));
        assertWellFormedUtf16(prod, "尾部边界");
    }

    /** 头尾同时踩中代理项时也要良构。 */
    @Test
    public void mustStayWellFormedWhenBothBoundariesHitSurrogates() {
        String s = "AAA" + EMOJI + "MMMM" + EMOJI + "ZZZ";
        // 扫一批 maxChars，任何一档都不得产生孤立代理项
        for (int maxChars = 2; maxChars < s.length(); maxChars++) {
            String prod = TaskTalent.truncateTaskResult(s, maxChars);
            assertWellFormedUtf16(prod, "maxChars=" + maxChars);
        }
    }

    /**
     * maxChars 极小时的边界行为：head/tail 窗口收缩到 0，但不得抛异常且仍带省略标记。
     *
     * <p><b>此用例曾被命名为「窗口重叠时优雅退化」，那是错的。</b>变异验证发现
     * truncateTaskResult 里的「tailStart &lt;= headEnd 则只留头部」退化分支<b>不可达</b>：
     * 进入该方法的前提是 result.length() &gt; maxChars，而 tailStart - headEnd &gt;= len - 2*half &gt;= 1，
     * 恒不重叠（surrogate 内缩只会让差距更大）。该死分支与对应断言已删除，本用例改为
     * 如实验证极小 maxChars 的真实行为，而不是去测一个永不成立的前提。</p>
     */
    @Test
    public void mustNotThrowForExtremelySmallLimit() {
        String s = "0123456789ABCDEF";
        for (int maxChars = 1; maxChars <= 3; maxChars++) {
            String r = TaskTalent.truncateTaskResult(s, maxChars);
            Assertions.assertNotNull(r);
            Assertions.assertTrue(r.contains("省略"), "极小窗口仍应带省略标记: " + r);
            // maxChars=1 时 half=0，头尾窗口皆为空，但不得抛 StringIndexOutOfBounds
            assertWellFormedUtf16(r, "maxChars=" + maxChars);
        }
    }

    /** 结果整体必须能通过 JSON 字符串化（孤立代理项会在真实链路里炸或变 U+FFFD）。 */
    @Test
    public void truncatedResultMustSurviveJsonSerialization() {
        String s = "结果说明" + EMOJI + "中间填充AAAAAAAA" + EMOJI + "END";
        for (int maxChars = 6; maxChars <= 16; maxChars += 2) {
            String r = TaskTalent.truncateTaskResult(s, maxChars);
            assertWellFormedUtf16(r, "maxChars=" + maxChars);
            String json = org.noear.snack4.ONode.serialize(r);
            Assertions.assertNotNull(json);
            Assertions.assertFalse(json.contains("\uFFFD"),
                    "JSON 不应出现替换字符 U+FFFD（说明切断了代理项）: maxChars=" + maxChars);
        }
    }

    /**
     * await_tasks 的会话隔离：token 只在归属会话内可见。
     *
     * <p>用反射访问私有的 registerBackgroundTask，验证跨会话 await 返回「不属于当前会话」
     * 而非真实结果。这是防越权读取他人子代理产出的护栏。</p>
     */
    @Test
    public void awaitTasksMustIsolateTokensBySession() throws Exception {
        TaskTalent talent = new TaskTalent(null);

        java.lang.reflect.Method register = TaskTalent.class.getDeclaredMethod(
                "registerBackgroundTask", String.class, CompletableFuture.class);
        register.setAccessible(true);

        CompletableFuture<String> done = CompletableFuture.completedFuture("SECRET_RESULT");
        String token = (String) register.invoke(talent, "session-A", done);
        Assertions.assertNotNull(token);

        // 归属会话内可见
        String sameSession = talent.awaitTasks(java.util.Collections.singletonList(token), 0, 5, "session-A");
        Assertions.assertTrue(sameSession.contains("SECRET_RESULT"),
                "归属会话应能取到结果: " + sameSession);

        // 跨会话不可见
        String otherSession = talent.awaitTasks(java.util.Collections.singletonList(token), 0, 5, "session-B");
        Assertions.assertFalse(otherSession.contains("SECRET_RESULT"),
                "跨会话不得读到他人结果: " + otherSession);
        Assertions.assertTrue(otherSession.contains("不属于当前会话") || otherSession.contains("ERROR"),
                "跨会话应返回统一的不可见文案: " + otherSession);
    }

    /** 空 token 列表直接返回警告，不进 await 循环。 */
    @Test
    public void awaitTasksShouldWarnOnEmptyTokens() {
        TaskTalent talent = new TaskTalent(null);
        Assertions.assertTrue(talent.awaitTasks(null, 0, 5, "s").contains("为空"));
        Assertions.assertTrue(talent.awaitTasks(java.util.Collections.emptyList(), 0, 5, "s").contains("为空"));
    }

    /** 不存在的 token 返回明确错误，而非 NPE 或挂起。 */
    @Test
    public void awaitTasksShouldReportUnknownToken() {
        TaskTalent talent = new TaskTalent(null);
        String r = talent.awaitTasks(java.util.Collections.singletonList("no-such-token"), 0, 5, "s");
        Assertions.assertTrue(r.contains("ERROR"), "未知 token 应返回 ERROR: " + r);
    }

    /** 超时 token 提示「仍在后台执行」，引导模型稍后重试而非重派任务。 */
    @Test
    public void awaitTasksShouldHintRetryOnTimeout() throws Exception {
        TaskTalent talent = new TaskTalent(null);
        CompletableFuture<String> never = new CompletableFuture<>();
        java.lang.reflect.Method register = TaskTalent.class.getDeclaredMethod(
                "registerBackgroundTask", String.class, CompletableFuture.class);
        register.setAccessible(true);
        String token = (String) register.invoke(talent, "s", never);

        String r = talent.awaitTasks(java.util.Collections.singletonList(token), 0, 1, "s");
        Assertions.assertTrue(r.contains("超时"), "应提示超时: " + r);
        Assertions.assertTrue(r.contains("仍在后台") || r.contains("重新 await"),
                "超时应引导重试而非重派: " + r);
    }

    /**
     * D-1 回归：多 token 必须共享单一整体 deadline，不得逐个累加超时。
     *
     * <p>旧实现逐个 {@code future.get(effectiveTimeout)}，传 N 个未完成 token 最坏等
     * N×timeout（3 token×300s = 900s）。改为整体 deadline 后，第一个 token 耗尽预算，
     * 后续 token 立即走「整体已用尽」分支——该文案是 deadline 语义独有的，可作
     * <b>确定性判据</b>（不依赖计时，慢 CI 不会偶发红）；计时仅作辅助佐证。</p>
     */
    @Test
    public void awaitTasksMustShareSingleDeadlineAcrossTokens() throws Exception {
        TaskTalent talent = new TaskTalent(null);
        CompletableFuture<String> never1 = new CompletableFuture<>();
        CompletableFuture<String> never2 = new CompletableFuture<>();
        java.lang.reflect.Method register = TaskTalent.class.getDeclaredMethod(
                "registerBackgroundTask", String.class, CompletableFuture.class);
        register.setAccessible(true);
        String t1 = (String) register.invoke(talent, "s", never1);
        String t2 = (String) register.invoke(talent, "s", never2);

        long start = System.nanoTime();
        String r = talent.awaitTasks(java.util.Arrays.asList(t1, t2), 0, 1, "s");
        long elapsedMs = java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);

        // 确定性判据：第二个 token 必须走「整体已用尽」分支（旧累加实现根本没有这个分支）
        Assertions.assertTrue(r.contains("预算已用尽"),
                "多 token 必须共享单一整体 deadline，第二个应报「整体已用尽」: " + r);
        Assertions.assertTrue(r.contains(t1) && r.contains(t2),
                "两个 token 都应有结果（不是只返回一个）: " + r);
        // 计时佐证：整体只等约 1s，而非累加成 2s（上限 1800ms 给 CI 留余量）
        Assertions.assertTrue(elapsedMs < 1800,
                "整体等待应约 1s 而非 2×1s 累加，实测 " + elapsedMs + "ms");
    }

    // ── 辅助 ──────────────────────────────────────────────

    /**
     * 复现「未修正的硬切」：头 half + 尾 half，不做 surrogate 边界内缩。
     * 仅作负对照自检用，证明测试构造确实踩中了边界。
     */
    private static String naiveHeadTail(String result, int maxChars) {
        if (result == null || maxChars <= 0 || result.length() <= maxChars) {
            return result;
        }
        int half = maxChars / 2;
        return result.substring(0, half)
                + "\n...[naive]...\n"
                + result.substring(result.length() - half);
    }

    /** 是否含孤立代理项：高代理后面不跟低代理，或低代理前面不是高代理。 */
    private static boolean hasLoneSurrogate(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (i + 1 >= s.length() || !Character.isLowSurrogate(s.charAt(i + 1))) {
                    return true;
                }
                i++; // 跳过配对的低代理项
            } else if (Character.isLowSurrogate(c)) {
                return true; // 前面没有配对的高代理项（否则已被上一个分支 i++ 跳过）
            }
        }
        return false;
    }

    private static void assertWellFormedUtf16(String s, String ctx) {
        Assertions.assertFalse(hasLoneSurrogate(s),
                "[" + ctx + "] 含孤立代理项，会导致 JSON 非法或 U+FFFD: " + escape(s));
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
        return b.toString();
    }
}
