package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.TreeMap;

/**
 * 跨月归档回归：钉死「月份翻页时不得重复累加历史」。
 *
 * <p>背景：{@code archiveOne} 的水位只登记在写入当时的「当前月」账本里。每逢自然月翻页，
 * 新月账本必然查不到旧会话的水位；若不回落上月继承，{@code sinceTs} 就会退化为
 * {@code Long.MIN_VALUE}，整个流文件被从头重扫，事件按各自日期落回<b>上月账本</b>并在
 * 已有历史上再加一遍——存活会话的历史会逐月翻倍。</p>
 *
 * <p><b>为何旧用例盖不住</b>：{@code UsageArchiveServiceTest} 全部用
 * {@code System.currentTimeMillis()} / {@code LocalDate.now()} 造数据，事件永远落在当月，
 * 水位与事件同处一个账本，跨月分支从不被执行。本用例故意人工构造「上月账本已含
 * 数据+水位、当月账本尚不存在」这一翻页瞬间的磁盘状态。</p>
 *
 * <p>修复前实测为 2000（翻倍），修复后为 1000。若日后有人删掉 archiveOne 里的回落
 * 分支，本用例会立即变红。</p>
 *
 * <p><b>二次加固</b>：{@link #twoMonthGapMustNotRecountHistory()} 补上「只回落一个月」盖不住的
 * 断链场景（休眠/关机跨两个自然月），并同时钉死「继承到的水位必须回写当月账本」
 * 这一自愈行为。</p>
 */
public class UsageArchiveRolloverTest {

    private static final String SESSIONS = ".gwork/sessions";

    @Test
    public void monthRolloverMustNotRecountHistory() throws Exception {
        Path workspace = Files.createTempDirectory("usage-roll-ws");
        Path globalBase = Files.createTempDirectory("usage-roll-gb");
        Path project = Files.createTempDirectory("usage-roll-prj");

        ZoneId zone = ZoneId.systemDefault();
        LocalDate today = LocalDate.now(zone);
        LocalDate lastMonthDay = today.minusMonths(1).withDayOfMonth(15);
        long ts = lastMonthDay.atTime(12, 0).atZone(zone).toInstant().toEpochMilli();

        String sid = "work-roll001";
        String streamContent = "{\"type\":\"trace\",\"createdAt\":" + ts
                + ",\"model\":\"rm\",\"inputTokens\":500,\"outputTokens\":500,\"totalTokens\":1000}\n";

        Path dir = project.resolve(SESSIONS).resolve(sid);
        Files.createDirectories(dir);
        Path streamFile = dir.resolve(sid + SessionStreamStore.STREAM_SUFFIX);
        Files.write(streamFile, streamContent.getBytes(StandardCharsets.UTF_8));
        long size = Files.size(streamFile);

        SessionLocator locator = new SessionLocator(workspace.toString(), globalBase.toString(), SESSIONS);
        locator.bindSessionRoot(sid, project.toString());

        // 人工构造「上个月已归档完毕」的账本：含当日数据 + 该 sid 的水位。
        // 当月账本刻意不存在 —— 这正是每月 1 日第一次归档时的状态。
        String lastMonth = lastMonthDay.toString().substring(0, 7);
        Path usageDir = globalBase.resolve(".gwork/usage");
        Files.createDirectories(usageDir);
        String ledgerJson = "{\"month\":\"" + lastMonth + "\",\"days\":{\""
                + lastMonthDay + "\":{\"messages\":0,\"sessions\":[\"" + sid + "\"],"
                + "\"models\":{\"rm\":{\"tokens\":1000,\"input\":500,\"output\":500,"
                + "\"cacheRead\":0,\"cacheCreation\":0,\"rounds\":1}}}},"
                + "\"watermarks\":{\"" + sid + "\":{\"ts\":" + ts + ",\"size\":" + size + "}}}";
        Files.write(usageDir.resolve("usage-" + lastMonth + ".json"),
                ledgerJson.getBytes(StandardCharsets.UTF_8));

        // 月初第一次归档
        new UsageArchiveService(locator, globalBase.toString()).archiveIncremental();

        TreeMap<LocalDate, UsageArchiveService.DayStat> after =
                new UsageArchiveService(locator, globalBase.toString()).load(lastMonthDay, lastMonthDay);
        long tokens = after.containsKey(lastMonthDay) ? after.get(lastMonthDay).tokens() : 0L;

        System.out.println("[PROBE] lastMonth=" + lastMonth + " day=" + lastMonthDay
                + " tokensAfterRollover=" + tokens + " (1000=正确, 2000=重复累加)");

        Assertions.assertEquals(1000L, tokens,
                "跨月首次归档不得把上月历史重复累加一遍");
    }

    /**
     * 跨<b>两个</b>自然月的断链：水位必须从更早的历史分片继承，不得退化为全量重扫。
     *
     * <p>构造「两个月前的账本已归档完毕（含当日数据 + 水位）、上月与当月账本都不存在」。
     * 这正是两条真实事故路径的磁盘状态：① 会话休眠时字节数不变，归档在上个月命中提前
     * return，水位没被登记进上月账本；② 连续两个月没跑过归档（关机 / 没打开统计页）。
     * 旧实现只回落一个月，在此必然查不到水位 → {@code sinceTs = Long.MIN_VALUE} → 流文件
     * 从头重扫 → 二个月前的历史被再加一遍（2000）。</p>
     */
    @Test
    public void twoMonthGapMustNotRecountHistory() throws Exception {
        Path workspace = Files.createTempDirectory("usage-gap-ws");
        Path globalBase = Files.createTempDirectory("usage-gap-gb");
        Path project = Files.createTempDirectory("usage-gap-prj");

        ZoneId zone = ZoneId.systemDefault();
        LocalDate today = LocalDate.now(zone);
        LocalDate oldDay = today.minusMonths(2).withDayOfMonth(15);
        long ts = oldDay.atTime(12, 0).atZone(zone).toInstant().toEpochMilli();

        String sid = "work-gap001";
        String streamContent = "{\"type\":\"trace\",\"createdAt\":" + ts
                + ",\"model\":\"rm\",\"inputTokens\":500,\"outputTokens\":500,\"totalTokens\":1000}\n";

        Path dir = project.resolve(SESSIONS).resolve(sid);
        Files.createDirectories(dir);
        Path streamFile = dir.resolve(sid + SessionStreamStore.STREAM_SUFFIX);
        Files.write(streamFile, streamContent.getBytes(StandardCharsets.UTF_8));
        long size = Files.size(streamFile);

        SessionLocator locator = new SessionLocator(workspace.toString(), globalBase.toString(), SESSIONS);
        locator.bindSessionRoot(sid, project.toString());

        // 只有「两个月前」这一个分片：上月分片与当月分片都刻意缺失
        String oldMonth = oldDay.toString().substring(0, 7);
        Path usageDir = globalBase.resolve(".gwork/usage");
        Files.createDirectories(usageDir);
        String ledgerJson = "{\"month\":\"" + oldMonth + "\",\"days\":{\""
                + oldDay + "\":{\"messages\":0,\"sessions\":[\"" + sid + "\"],"
                + "\"models\":{\"rm\":{\"tokens\":1000,\"input\":500,\"output\":500,"
                + "\"cacheRead\":0,\"cacheCreation\":0,\"rounds\":1}}}},"
                + "\"watermarks\":{\"" + sid + "\":{\"ts\":" + ts + ",\"size\":" + size + "}}}";
        Files.write(usageDir.resolve("usage-" + oldMonth + ".json"),
                ledgerJson.getBytes(StandardCharsets.UTF_8));

        // 断链后的第一次归档
        new UsageArchiveService(locator, globalBase.toString()).archiveIncremental();

        TreeMap<LocalDate, UsageArchiveService.DayStat> after =
                new UsageArchiveService(locator, globalBase.toString()).load(oldDay, oldDay);
        long tokens = after.containsKey(oldDay) ? after.get(oldDay).tokens() : 0L;

        System.out.println("[PROBE] oldMonth=" + oldMonth + " day=" + oldDay
                + " tokensAfterTwoMonthGap=" + tokens + " (1000=正确, 2000=重复累加)");

        Assertions.assertEquals(1000L, tokens,
                "跨两个自然月的首次归档不得把历史重复累加一遍");

        // 断链自愈：继承到的水位必须回写当月账本，否则下个月又会断链重扫
        Path currentLedger = usageDir.resolve("usage-" + today.toString().substring(0, 7) + ".json");
        Assertions.assertTrue(Files.isRegularFile(currentLedger),
                "继承到水位后应把当月账本落盘（承载水位），实际缺失: " + currentLedger);
        String currentJson = new String(Files.readAllBytes(currentLedger), StandardCharsets.UTF_8);
        Assertions.assertTrue(currentJson.contains(sid),
                "当月账本必须登记该会话的水位，否则下个自然月会再次断链: " + currentJson);
    }
}
