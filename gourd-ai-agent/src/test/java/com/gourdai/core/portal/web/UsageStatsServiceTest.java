package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * 使用统计「最近 30 天 / 累计至今」回归测试。
 *
 * <p>覆盖三条容易做错的地方：</p>
 * <ol>
 *   <li><b>降维不能篡改数字</b>：趋势序列按周/按月聚合后，各桶 token 之和必须仍等于卡片总量；</li>
 *   <li><b>连续天数不能被时间桶骗过去</b>：桶内总量 &gt; 0 不代表桶的最后一天有用量，
 *       若拿桶去数连续天数，会把已经断掉的 streak 误判为仍在继续
 *       （拦住这条的是 {@code testStreakCountsBackUntilFirstGap}，已用变异测试验证）；</li>
 *   <li><b>全量读取不能逐月空扫</b>：{@code loadAll()} 必须按目录列举真实分片，
 *       并且不能把写盘中途的 {@code .json.tmp} 当成账本读进来。</li>
 * </ol>
 *
 * @author oisin
 */
public class UsageStatsServiceTest {

    /** 直接手写账本，绕开归档扫描：统计只依赖 {@code ~/.gwork/usage/*.json}。 */
    private UsageStatsService newStatsService(Path globalBase) {
        SessionLocator locator = new SessionLocator(globalBase.toString(), globalBase.toString(), ".gwork/sessions");
        UsageArchiveService archive = new UsageArchiveService(locator, globalBase.toString());
        return new UsageStatsService(archive);
    }

    /**
     * 把「日期 → token」按月份落成月度分片账本。
     * 同月的多天必须写进同一个文件（分片就是按月切的）。
     */
    private void writeLedgers(Path globalBase, TreeMap<LocalDate, Long> dayTokens) throws Exception {
        Path dir = globalBase.resolve(".gwork/usage");
        Files.createDirectories(dir);

        Map<String, List<LocalDate>> byMonth = new java.util.LinkedHashMap<>();
        for (LocalDate d : dayTokens.keySet()) {
            byMonth.computeIfAbsent(d.toString().substring(0, 7), k -> new ArrayList<>()).add(d);
        }

        for (Map.Entry<String, List<LocalDate>> e : byMonth.entrySet()) {
            StringBuilder days = new StringBuilder();
            for (LocalDate d : e.getValue()) {
                if (days.length() > 0) {
                    days.append(',');
                }
                long tokens = dayTokens.get(d);
                days.append('"').append(d).append("\":{")
                        .append("\"messages\":2,")
                        .append("\"sessions\":[\"work-").append(d.getDayOfMonth()).append("\"],")
                        .append("\"models\":{\"m1\":{\"tokens\":").append(tokens)
                        .append(",\"input\":").append(tokens / 2)
                        .append(",\"output\":").append(tokens - tokens / 2)
                        .append(",\"cacheRead\":0,\"cacheCreation\":0,\"rounds\":1}}")
                        .append('}');
            }
            String json = "{\"month\":\"" + e.getKey() + "\",\"days\":{" + days + "},\"watermarks\":{}}";
            Files.write(dir.resolve("usage-" + e.getKey() + ".json"), json.getBytes(StandardCharsets.UTF_8));
        }
    }

    /** 单天账本 JSON（只给聚合量，字段形状与 UsageArchiveService.writeLedger 一致）。 */
    private static byte[] ledgerJson(String month, LocalDate date, long tokens) {
        String json = "{\"month\":\"" + month + "\",\"days\":{\"" + date + "\":{"
                + "\"messages\":1,\"sessions\":[\"work-pollute\"],"
                + "\"models\":{\"m1\":{\"tokens\":" + tokens + ",\"input\":1,\"output\":1,"
                + "\"cacheRead\":0,\"cacheCreation\":0,\"rounds\":1}}}},\"watermarks\":{}}";
        return json.getBytes(StandardCharsets.UTF_8);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> list(Map<String, Object> result, String key) {
        Object v = result.get(key);
        Assertions.assertTrue(v instanceof List, key + " 应为数组，实际=" + v);
        return (List<Map<String, Object>>) v;
    }

    private static long num(Map<String, Object> map, String key) {
        Object v = map.get(key);
        Assertions.assertTrue(v instanceof Number, key + " 应为数值，实际=" + v);
        return ((Number) v).longValue();
    }

    private static long sumSeriesTokens(List<Map<String, Object>> series) {
        long sum = 0L;
        for (Map<String, Object> item : series) {
            sum += num(item, "tokens");
        }
        return sum;
    }

    // ─────────────────────── 账本全量读取 ───────────────────────

    /** loadAll 必须跨月读全部分片，且忽略写盘中途的 .tmp 与非法文件名。 */
    @Test
    public void testLoadAllReadsEveryShardAndIgnoresTmp() throws Exception {
        Path base = Files.createTempDirectory("usage-loadall");
        try {
            LocalDate today = LocalDate.now();
            LocalDate older = today.minusDays(400);
            TreeMap<LocalDate, Long> data = new TreeMap<>();
            data.put(older, 100L);
            data.put(today, 200L);
            writeLedgers(base, data);

            // 写盘中途的临时文件 + 名字像账本但月份长度不对的文件：都必须被跳过。
            // 注意这里故意写入<b>合法</b>账本内容（带一个多余的日期）：若过滤失效被当成账本读了，
            // 分片数与 token 总量会立即变化，测试才能真接住。之前填「{ broken」是假断言 ——
            // 损坏文件会被 readLedger 降级成空账本，无论过不过滤都绿。
            Path dir = base.resolve(".gwork/usage");
            Files.write(dir.resolve("usage-" + older.toString().substring(0, 7) + ".json.tmp"),
                    ledgerJson(older.toString().substring(0, 7), older.minusDays(1), 99999L));
            Files.write(dir.resolve("usage-bad.json"),
                    ledgerJson(older.toString().substring(0, 7), older.minusDays(2), 88888L));

            UsageArchiveService archive = new UsageArchiveService(
                    new SessionLocator(base.toString(), base.toString(), ".gwork/sessions"), base.toString());
            TreeMap<LocalDate, UsageArchiveService.DayStat> all = archive.loadAll();

            Assertions.assertEquals(2, all.size(), "应恰好读到两个手写日期，tmp/坏文件名不得混入");
            Assertions.assertEquals(100L, all.get(older).tokens());
            Assertions.assertEquals(200L, all.get(today).tokens());
            Assertions.assertNull(all.get(older.minusDays(1)), ".tmp 残留文件不得被当成账本读入");
            Assertions.assertNull(all.get(older.minusDays(2)), "月份字段非法的文件不得被当成账本读入");
            Assertions.assertEquals(older, all.firstKey(), "firstKey 即「累计至今」的区间起点");
        } finally {
            deleteRecursively(base.toFile());
        }
    }

    // ─────────────────────── 区间与粒度 ───────────────────────

    /** 默认视图：最近 30 天，逐日出柱，行为与改造前一致。 */
    @Test
    public void testLastThirtyDaysStaysDaily() throws Exception {
        Path base = Files.createTempDirectory("usage-30d");
        try {
            LocalDate today = LocalDate.now();
            TreeMap<LocalDate, Long> data = new TreeMap<>();
            data.put(today, 500L);
            data.put(today.minusDays(3), 300L);
            // 区间外的历史：30 天视图绝不能看见，累计视图才该看见
            data.put(today.minusDays(80), 9999L);
            writeLedgers(base, data);

            Map<String, Object> r = newStatsService(base).compute(30);

            Assertions.assertEquals(Boolean.FALSE, r.get("allTime"));
            Assertions.assertEquals(30, ((Number) r.get("rangeDays")).intValue());
            Assertions.assertEquals("day", r.get("granularity"));
            Assertions.assertEquals(today.minusDays(29).toString(), r.get("rangeStart"));
            Assertions.assertEquals(today.toString(), r.get("rangeEnd"));
            List<Map<String, Object>> daily = list(r, "daily");
            Assertions.assertEquals(30, daily.size(), "按天粒度下桶数必须等于区间天数");
            Assertions.assertEquals(800L, num(r, "totalTokens"), "区间外的 9999 不得计入 30 天总量");
            Assertions.assertEquals(800L, sumSeriesTokens(daily));
        } finally {
            deleteRecursively(base.toFile());
        }
    }

    /** 累计至今：区间起点=最早有数据的那天，跨度落在「按周」档。 */
    @Test
    public void testAllTimeSpansFromEarliestDayAndUsesWeeklyBuckets() throws Exception {
        Path base = Files.createTempDirectory("usage-alltime");
        try {
            LocalDate today = LocalDate.now();
            LocalDate earliest = today.minusDays(100);
            TreeMap<LocalDate, Long> data = new TreeMap<>();
            data.put(earliest, 100L);
            data.put(today, 200L);
            writeLedgers(base, data);

            Map<String, Object> r = newStatsService(base).compute(UsageStatsService.RANGE_ALL);

            Assertions.assertEquals(Boolean.TRUE, r.get("allTime"));
            Assertions.assertEquals(101, ((Number) r.get("rangeDays")).intValue(), "含今天在内共 101 天");
            Assertions.assertEquals(earliest.toString(), r.get("rangeStart"));
            Assertions.assertEquals(today.toString(), r.get("rangeEnd"));
            Assertions.assertEquals("week", r.get("granularity"), "101 天应降到按周");
            Assertions.assertEquals(300L, num(r, "totalTokens"));

            List<Map<String, Object>> daily = list(r, "daily");
            Assertions.assertEquals(earliest.toString(), daily.get(0).get("date"),
                    "首桶标签必须夹到真实区间起点，不能显示区间外的周日");
            Assertions.assertTrue(daily.size() < 101, "按周聚合后桶数必须显著少于天数，否则降维没生效");
            Assertions.assertEquals(300L, sumSeriesTokens(daily), "降维不得篡改总量");
            for (Map<String, Object> item : daily) {
                LocalDate bd = LocalDate.parse((String) item.get("date"));
                Assertions.assertFalse(bd.isAfter(today), "时间桶不能跑到未来");
                Assertions.assertFalse(bd.isBefore(earliest), "时间桶不能早于区间起点");
            }
        } finally {
            deleteRecursively(base.toFile());
        }
    }

    /** 超长历史（>400 天）降到按月，且除首桶外每个桶都落在月初。 */
    @Test
    public void testVeryLongHistoryUsesMonthlyBuckets() throws Exception {
        Path base = Files.createTempDirectory("usage-monthly");
        try {
            LocalDate today = LocalDate.now();
            LocalDate earliest = today.minusDays(500);
            TreeMap<LocalDate, Long> data = new TreeMap<>();
            data.put(earliest, 100L);
            data.put(today, 200L);
            writeLedgers(base, data);

            Map<String, Object> r = newStatsService(base).compute(UsageStatsService.RANGE_ALL);

            Assertions.assertEquals("month", r.get("granularity"), "501 天应降到按月");
            Assertions.assertEquals(501, ((Number) r.get("rangeDays")).intValue());
            List<Map<String, Object>> daily = list(r, "daily");
            Assertions.assertEquals(earliest.toString(), daily.get(0).get("date"));
            for (int i = 1; i < daily.size(); i++) {
                LocalDate bd = LocalDate.parse((String) daily.get(i).get("date"));
                Assertions.assertEquals(1, bd.getDayOfMonth(), "非首桶必须落在月初，实际=" + bd);
            }
            Assertions.assertEquals(300L, sumSeriesTokens(daily), "按月聚合同样不得篡改总量");
        } finally {
            deleteRecursively(base.toFile());
        }
    }

    // ─────────────────────── 连续天数口径 ───────────────────────

    /**
     * 今天没有用量 → 连续天数必须是 0。
     *
     * <p>本例守住的是「streak 必须以今天为锚点」这条语义：若有人改成从昨天起数、
     * 或把空今天当成仍活跃，这里会直接红。</p>
     *
     * <p><b>但它不能单独拦住「streak 改用时间桶来数」的变异</b>：按周聚合时，
     * 若今天恰好是周日（列首），今天的桶只含今天自己，tokens=0，桶算法与逐日算法结果相同。
     * 那条防线由 {@link #testStreakCountsBackUntilFirstGap()} 承担（已用变异实测：
     * 把 streak 改成逆序数桶后，该用例在任意星期都会报 expected 3 but was 2）。</p>
     */
    @Test
    public void testStreakMustNotBeInflatedByBuckets() throws Exception {
        Path base = Files.createTempDirectory("usage-streak");
        try {
            LocalDate today = LocalDate.now();
            TreeMap<LocalDate, Long> data = new TreeMap<>();
            for (int back = 1; back <= 6; back++) {
                data.put(today.minusDays(back), 100L);
            }
            data.put(today.minusDays(100), 50L); // 拉长区间，确保落到按周粒度
            writeLedgers(base, data);

            Map<String, Object> r = newStatsService(base).compute(UsageStatsService.RANGE_ALL);

            Assertions.assertEquals("week", r.get("granularity"));
            Assertions.assertEquals(0, ((Number) r.get("currentStreak")).intValue(),
                    "今天零用量时连续天数必须归零，不能被同桶内昨天的用量顶上去");
            Assertions.assertEquals(7, ((Number) r.get("activeDays")).intValue());
            Assertions.assertEquals(650L, num(r, "totalTokens"));
        } finally {
            deleteRecursively(base.toFile());
        }
    }

    /**
     * 今天有用量时，连续天数从今天往前逐日累加，遇断点即止。
     *
     * <p>本例同时是「streak 必须基于逐日原始数据、而非时间桶」的主防线：
     * 逐日算法得 3；若改成逆序数桶，today-4 会被归进上一个桶而多活一格，
     * 得 2 —— 已实测过（周日/周一/周三/周六四种对齐都不同）。故不得调整本例的日期布局。</p>
     */
    @Test
    public void testStreakCountsBackUntilFirstGap() throws Exception {
        Path base = Files.createTempDirectory("usage-streak2");
        try {
            LocalDate today = LocalDate.now();
            TreeMap<LocalDate, Long> data = new TreeMap<>();
            data.put(today, 10L);
            data.put(today.minusDays(1), 10L);
            data.put(today.minusDays(2), 10L);
            // today-3 留空 → 断点
            data.put(today.minusDays(4), 10L);
            data.put(today.minusDays(120), 10L);
            writeLedgers(base, data);

            Map<String, Object> r = newStatsService(base).compute(UsageStatsService.RANGE_ALL);

            Assertions.assertEquals(3, ((Number) r.get("currentStreak")).intValue(),
                    "今天+昨前共 3 天连续，第 4 天空档即止");
            Assertions.assertEquals(5, ((Number) r.get("activeDays")).intValue());
        } finally {
            deleteRecursively(base.toFile());
        }
    }

    /** days 非法值收敛到 30；7 仍可用（兼容旧前端缓存页）。 */
    @Test
    public void testDaysFallbackAndLegacySeven() throws Exception {
        Path base = Files.createTempDirectory("usage-days");
        try {
            LocalDate today = LocalDate.now();
            TreeMap<LocalDate, Long> data = new TreeMap<>();
            data.put(today, 10L);
            writeLedgers(base, data);

            UsageStatsService svc = newStatsService(base);
            Assertions.assertEquals(30, ((Number) svc.compute(999).get("rangeDays")).intValue());
            Assertions.assertEquals(30, ((Number) svc.compute(-5).get("rangeDays")).intValue());
            Assertions.assertEquals(7, ((Number) svc.compute(7).get("rangeDays")).intValue());
            Assertions.assertEquals("day", svc.compute(7).get("granularity"));
        } finally {
            deleteRecursively(base.toFile());
        }
    }

    /** 空账本：累计至今不应崩，区间退化为今天，前端据此走空状态。 */
    @Test
    public void testAllTimeOnEmptyLedgerDegradesGracefully() throws Exception {
        Path base = Files.createTempDirectory("usage-empty");
        try {
            Map<String, Object> r = newStatsService(base).compute(UsageStatsService.RANGE_ALL);

            Assertions.assertEquals(Boolean.TRUE, r.get("allTime"));
            Assertions.assertEquals(1, ((Number) r.get("rangeDays")).intValue());
            Assertions.assertEquals(0L, num(r, "totalTokens"));
            Assertions.assertEquals("day", r.get("granularity"));
            Assertions.assertNull(r.get("topModel"));
            Assertions.assertEquals(0, ((Number) r.get("currentStreak")).intValue());
            Assertions.assertFalse(list(r, "heatmap").isEmpty(), "热力图窗口与范围解耦，空数据时仍应铺满");
        } finally {
            deleteRecursively(base.toFile());
        }
    }

    private void deleteRecursively(File f) {
        if (f == null || !f.exists()) {
            return;
        }
        File[] children = f.listFiles();
        if (children != null) {
            for (File c : children) {
                deleteRecursively(c);
            }
        }
        f.delete();
    }
}
