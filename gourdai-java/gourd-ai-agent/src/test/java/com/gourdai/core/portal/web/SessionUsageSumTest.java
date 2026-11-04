package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 会话累计用量汇总（{@link SessionStreamStore#sumUsage}）的行为契约。
 *
 * <h3>双重防线的分工（变异验证 5/6 击杀的结论）</h3>
 * <p>水位缓存的失效有两条独立路径，各自有专属用例把守：
 * <ul>
 *   <li><b>主动失效</b>（rewindToMessageState / delete / 压缩重写后 {@code usageSums.remove}）：
 *       由 {@link #rewindThenRegrowPastOldOffsetWithoutIntermediateReadMustNotDrift} 把守。
 *       盲区是「回退后不在窗口内取值、直接增长超过旧水位」，此时长度守卫无法触发。</li>
 *   <li><b>{@code cached.offset > length} 守卫</b>：由 {@link #externalTruncationIsCaughtByOffsetGuard}
 *       把守（绕过本类 API 的外部截断）。</li>
 * </ul>
 * 两道防线在多数场景下互相掩盖（单独破坏任一条都可能仍结果正确），因此必须用
 * 「使另一道失效」的场景分别断言，不能只测一个常规 rewind 流程。</p>
 *
 * <p><b>未覆盖的等价变异</b>：「压缩重写后不失效水位」无法被杀死——懒压缩是把多行
 * text/reason 增量合并为一行，文件长度只会变小或不变，故 {@code offset > length}
 * 守卫必然触发并全量重扫（长度完全不变时偏移也未变，续扫仍正确）。
 * 压缩路径上的主动失效属于防御性双保险，保留（成本极低、语义更清晰）。</p>
 *
 * <p>覆盖的核心口径：<b>全部 trace 帧之和（已收口轮次）+ 最后一条 trace 之后的
 * context_size 帧（进行中 run）</b>，消息数 = user/user_input + trace 计数。
 * 这是上下文指示器「累计输入/累计输出/消息条数」行的数据源（WebGate.emitToClient 注入）。</p>
 */
class SessionUsageSumTest {
    @Test
    void sumsConfirmedTurnsAndPendingCallsWithoutDoubleCounting() throws Exception {
        Path workspace = Files.createTempDirectory("usage-sum-test");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-sum-1";

            // 轮次 1：user + 进行中的两次模型调用 + trace 收口
            store.recordUser(sid, null, "hello", 1L);
            store.record(sid, null, contextSize(1000, 200));
            store.record(sid, null, contextSize(3000, 400));   // 第二次调用：输入含前次输出
            store.record(sid, null, trace(3000, 600));
            // 轮次 2：user + 一次调用（尚未收口，模拟进行中的 run）
            store.recordUser(sid, null, "again", 2L);
            store.record(sid, null, contextSize(4500, 300));

            SessionStreamStore.UsageSum sum = store.sumUsage(sid, null);
            // 已收口：trace=3000/600；进行中：最后一条 trace 之后的 context_size=4500/300
            Assertions.assertEquals(3000 + 4500, sum.inputTokens(), "累计输入 = 已收口 + 进行中");
            Assertions.assertEquals(600 + 300, sum.outputTokens(), "累计输出 = 已收口 + 进行中");
            // 消息数 = 2 user + 1 trace = 3（进行中的轮还没有 trace，不计 AI 条数）
            Assertions.assertEquals(3, sum.messageCount(), "消息数 = user 轮 + 已收口 AI 轮");
        } finally {
            delete(workspace);
        }
    }

    @Test
    void pendingIsResetByNextTraceToAvoidDoubleCounting() throws Exception {
        Path workspace = Files.createTempDirectory("usage-sum-test");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-sum-2";

            // 轮次 1 的两次调用在轮次 2 的新 trace 到达后不得再次计入：
            // trace 收编了同一 run 的 context_size，随后新 run 的 context_size 从零重新累计
            store.recordUser(sid, null, "t1", 1L);
            store.record(sid, null, contextSize(1000, 100));
            store.record(sid, null, trace(1000, 100));
            store.recordUser(sid, null, "t2", 2L);
            store.record(sid, null, contextSize(2000, 200));
            store.record(sid, null, trace(2000, 200));

            SessionStreamStore.UsageSum sum = store.sumUsage(sid, null);
            // 关键回归：若 pending 不被 trace 清零，累计输入会是 1000+1000+2000+2000=6000（双计）
            Assertions.assertEquals(3000, sum.inputTokens(), "context_size 不得与同轮 trace 双重计入");
            Assertions.assertEquals(300, sum.outputTokens());
            Assertions.assertEquals(4, sum.messageCount(), "2 user + 2 trace");
        } finally {
            delete(workspace);
        }
    }

    @Test
    void incrementalRescanMatchesFullScanAndSurvivesTruncation() throws Exception {
        Path workspace = Files.createTempDirectory("usage-sum-test");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-sum-3";

            store.recordUser(sid, null, "a", 1L);
            store.record(sid, null, trace(1000, 100));
            SessionStreamStore.UsageSum first = store.sumUsage(sid, null);

            // 增量：只扫新行
            store.recordUser(sid, null, "b", 2L);
            store.record(sid, null, trace(2500, 250));
            SessionStreamStore.UsageSum second = store.sumUsage(sid, null);
            Assertions.assertEquals(3500, second.inputTokens(), "增量续扫应与全量扫描等价");
            Assertions.assertEquals(350, second.outputTokens());
            Assertions.assertEquals(4, second.messageCount());

            // 截断（模拟 regenerate / rewind 删掉最后一轮后重写）：缓存作废，全量重扫
            store.rewindTurns(sid, null, 1);
            store.recordUser(sid, null, "c", 3L);
            store.record(sid, null, trace(700, 70));
            SessionStreamStore.UsageSum third = store.sumUsage(sid, null);
            Assertions.assertEquals(1700, third.inputTokens(), "截断后不得残留被删轮次的用量");
            Assertions.assertEquals(170, third.outputTokens());
            Assertions.assertEquals(first.messageCount() + 2, third.messageCount());

            // 无文件会话：全零降级
            SessionStreamStore.UsageSum empty = store.sumUsage("work-never-exists", null);
            Assertions.assertEquals(0, empty.inputTokens());
            Assertions.assertEquals(0, empty.messageCount());
        } finally {
            delete(workspace);
        }
    }

    @Test
    void rewindInvalidatesCacheEvenAfterRegrowingPastCachedOffset() throws Exception {
        Path workspace = Files.createTempDirectory("usage-sum-test");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-sum-4";

            // 预热缓存：trace1 收口、context_size 被 trace2 收编 → 3000/300、4 条
            store.recordUser(sid, null, "a", 1L);
            store.record(sid, null, trace(1000, 100));
            store.record(sid, null, contextSize(1100, 120));
            store.recordUser(sid, null, "b", 2L);
            store.record(sid, null, trace(2000, 200));
            SessionStreamStore.UsageSum before = store.sumUsage(sid, null);
            Assertions.assertEquals(3000, before.inputTokens());
            Assertions.assertEquals(300, before.outputTokens());
            Assertions.assertEquals(4, before.messageCount());

            // 回退最后一轮后重新增长到超过原长度：缓存水位若不失效，续扫会从旧偏移落进
            // 新内容中部，累计值静默漂移（回归：rewind/重写后的水位缓存失效）。
            store.rewindTurns(sid, null, 1);

            // 【截断窗口断言】rewind 之后、新内容落盘之前就取值 —— 这是唯一能观测到「水位
            // 缓存是否失效」的窗口：此刻文件比旧水位短，若仍走增量续扫（从旧偏移起），
            // 读到的会是「已删轮次的残留累计」。真实场景就是用户点「重新生成」后
            // 指示器立即刷新，必须反映被删轮次已不计入。
            SessionStreamStore.UsageSum truncated = store.sumUsage(sid, null);
            // 期望值口径（实测订正）：rewind 保留 user a / trace1 / context_size 三行。
            // 那条 context_size 原本被 trace2 收编（pending 清零），trace2 被删后它重新
            // 成为「未被任何 trace 收编」的 pending，必须计入——那笔用量真实发生过。
            // 故 = trace1(1000) + context_size(1100) = 2100，而非仅 trace1 的 1000。
            Assertions.assertEquals(2100, truncated.inputTokens(),
                    "截断窗口内必须重算（旧缓存会沿用已删轮次的 3000）");
            Assertions.assertEquals(220, truncated.outputTokens());
            Assertions.assertEquals(2, truncated.messageCount(), "user a + trace1（context_size 不计条数）");

            store.recordUser(sid, null, "c".repeat(200), 3L);
            store.record(sid, null, trace(3000, 300));
            store.recordUser(sid, null, "d".repeat(200), 4L);
            store.record(sid, null, trace(4000, 400));

            SessionStreamStore.UsageSum after = store.sumUsage(sid, null);
            // 全量口径：trace1+trace3+trace4 = 8000/800；user×3 + trace×3 = 6 条
            Assertions.assertEquals(8000, after.inputTokens(), "回退再增长后必须与全量重扫等价");
            Assertions.assertEquals(800, after.outputTokens());
            Assertions.assertEquals(6, after.messageCount());
        } finally {
            delete(workspace);
        }
    }

    @Test
    void rewindThenRegrowPastOldOffsetWithoutIntermediateReadMustNotDrift() throws Exception {
        Path workspace = Files.createTempDirectory("usage-sum-test");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-sum-5";

            store.recordUser(sid, null, "a", 1L);
            store.record(sid, null, trace(1000, 100));
            store.recordUser(sid, null, "b", 2L);
            store.record(sid, null, trace(2000, 200));
            SessionStreamStore.UsageSum before = store.sumUsage(sid, null);
            Assertions.assertEquals(3000, before.inputTokens());

            // 【关键】回退后不在窗口内取值，直接增长到超过旧水位：
            // 此时「offset > length」守卫无法触发（文件已比旧水位长），只有 rewind
            // 主动失效缓存这一道防线能拦。若它被移除，续扫会从旧偏移落进新内容中部，
            // 累计值静默漂移（这正是代码注释里点名的盲区）。
            store.rewindTurns(sid, null, 1);
            store.recordUser(sid, null, "c".repeat(300), 3L);
            store.record(sid, null, trace(5000, 500));
            store.recordUser(sid, null, "d".repeat(300), 4L);
            store.record(sid, null, trace(6000, 600));

            SessionStreamStore.UsageSum after = store.sumUsage(sid, null);
            // 全量口径：trace1 + trace(5000) + trace(6000) = 12000 / 1200；user×3 + trace×3 = 6
            Assertions.assertEquals(12000, after.inputTokens(),
                    "回退后增长超过旧水位，不得从旧偏移续扫而漂移");
            Assertions.assertEquals(1200, after.outputTokens());
            Assertions.assertEquals(6, after.messageCount());
        } finally {
            delete(workspace);
        }
    }

    @Test
    void externalTruncationIsCaughtByOffsetGuard() throws Exception {
        Path workspace = Files.createTempDirectory("usage-sum-test");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-sum-6";

            store.recordUser(sid, null, "a", 1L);
            store.record(sid, null, trace(1000, 100));
            store.recordUser(sid, null, "b", 2L);
            store.record(sid, null, trace(2000, 200));
            SessionStreamStore.UsageSum before = store.sumUsage(sid, null);
            Assertions.assertEquals(3000, before.inputTokens());

            // 【外部截断】绕过 rewindToMessageState/rewindTurns/delete（它们都会主动失效缓存），
            // 直接把文件改短——模拟归档/外部工具清理。此时唯一的防线是
            // 「cached.offset > length」守卫；守卫被移除则沿用旧缓存 3000。
            java.io.File f = new java.io.File(locator.resolveDir(sid, null), sid + SessionStreamStore.STREAM_SUFFIX);
            long fullLen = f.length();
            try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(f, "rw")) {
                raf.setLength(Math.max(1, fullLen / 3));
            }

            SessionStreamStore.UsageSum after = store.sumUsage(sid, null);
            Assertions.assertTrue(after.inputTokens() < before.inputTokens(),
                    "外部截断后必须重算（不得沿用旧缓存 " + before.inputTokens() + "，实得 " + after.inputTokens() + "）");
            Assertions.assertTrue(after.messageCount() < before.messageCount(),
                    "截断后消息数也应下降");
        } finally {
            delete(workspace);
        }
    }

    /** 构造一条 trace 帧（run 收口，整轮累计 usage）。 */
    private static WebChunk trace(long input, long output) {
        WebChunk c = new WebChunk();
        c.setType("trace");
        c.setInputTokens(input);
        c.setOutputTokens(output);
        c.setTotalTokens(input + output);
        c.setCreatedAt(System.currentTimeMillis());
        return c;
    }

    /** 构造一条 context_size 帧（当次模型调用的真实用量）。 */
    private static WebChunk contextSize(long input, long output) {
        WebChunk c = new WebChunk();
        c.setType("context_size");
        c.setInputTokens(input);
        c.setOutputTokens(output);
        c.setTotalTokens(input + output);
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("contextLength", 256000);
        c.setArgs(args);
        c.setText("12");
        c.setCreatedAt(System.currentTimeMillis());
        return c;
    }

    private static void delete(Path dir) throws Exception {
        if (!Files.exists(dir)) return;
        try (var stream = Files.walk(dir)) {
            stream.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                try { Files.deleteIfExists(p); } catch (Exception ignore) { }
            });
        }
    }
}
