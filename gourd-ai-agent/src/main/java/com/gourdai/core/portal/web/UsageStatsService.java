/*
 * Copyright 2017-2026 noear.org and authors
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
package com.gourdai.core.portal.web;

import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * 使用统计服务 —— 聚合<b>本机全部会话</b>（全局对话区 + 所有已登记项目）的
 * token 消耗、活跃度与模型分布，供设置面板「使用统计」页展示。
 *
 * <h3>数据来源</h3>
 * <p>每轮 AI 推理结束时，{@link WebGate#emitToClient} 会把一条 {@code trace} 事件旁路持久化到
 * {@code <sessionId>.stream.ndjson}（见 {@link SessionStreamStore}），其中携带 {@code model} 与
 * {@code inputTokens/outputTokens/totalTokens/cacheReadTokens} 及毫秒时间戳 {@code createdAt}。
 * 本服务无需额外埋点。</p>
 *
 * <h3>归档账本（历史不随项目删除而丢失）</h3>
 * <p>统计不再直接扫描会话流文件，而是<b>先增量归档、再读账本</b>：
 * {@link UsageArchiveService} 把「按天 × 按模型」的聚合固化到
 * {@code ~/.gwork/usage/usage-YYYY-MM.json}。这样即使项目被删除、移走或取消登记，
 * 已归档的历史用量仍然可查；同时避免每次打开页面全量重扫，越用越快。</p>
 *
 * <h3>统计范围</h3>
 * <p><b>全量聚合</b>：全局区（{@link SessionLocator#globalSessionsRoot()}）
 * 与所有已登记项目根（{@link SessionLocator#registeredRoots()}）下的会话<b>全部计入</b>，
 * 同一会话 ID 只算一次。时间范围见 {@link #compute(int)}：最近 30 天 / 累计至今。</p>
 *
 * <h3>趋势图粒度自适应</h3>
 * <p>「累计至今」的跨度可能长达数月乃至数年，逐日出柱会把图形压成一堵密墙。
 * 因此趋势序列按区间跨度自动降维（{@code ≤62天} 按天、{@code ≤400天} 按周、更长按月），
 * 并通过 {@code granularity} 字段告知前端如何格式化坐标标签。
 * <b>卡片指标与模型分布始终基于逐日原始数据</b>，不受降维影响。</p>
 *
 * <h3>token 口径</h3>
 * <p>{@code totalTokens = inputTokens + outputTokens}，其中 {@code inputTokens} 已由
 * {@code UsageNormalizer.normalizeInputTokens} 归一（<b>包含缓存读取与缓存创建 token</b>），
 * 因此展示的是完整总量，缓存部分不会漏计。</p>
 *
 * @author oisin
 * @see UsageArchiveService
 * @see SessionStreamStore
 * @see SessionLocator
 */
public class UsageStatsService {
    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd");

    /** 热力图固定窗口周数（GitHub 贡献图风格，与时间范围选择器解耦，始终铺满整卡宽度）。 */
    private static final int HEATMAP_WEEKS = 26;

    /** days 参数取值：0 = 累计至今（账本中全部历史，起点取最早有数据的那天）。 */
    public static final int RANGE_ALL = 0;

    /** 趋势粒度：区间跨度不超过此天数时按天出柱。 */
    private static final int GRANULARITY_DAY_MAX = 62;
    /** 趋势粒度：区间跨度不超过此天数时按周出柱，更长按月。 */
    private static final int GRANULARITY_WEEK_MAX = 400;

    private static final String GRAN_DAY = "day";
    private static final String GRAN_WEEK = "week";
    private static final String GRAN_MONTH = "month";

    private final UsageArchiveService archiveService;

    public UsageStatsService(UsageArchiveService archiveService) {
        this.archiveService = archiveService;
    }

    /**
     * 计算指定时间范围内的用量统计（全局 + 所有已登记项目）。
     *
     * <p>执行顺序：先做一次增量归档（把各会话新产生的事件并入账本），再从账本读取窗口数据。
     * 因此页面上既能看到刚刚产生的用量，也能看到已删除项目的历史用量。</p>
     *
     * @param days 统计天数：{@value #RANGE_ALL} = 累计至今（含全部历史，向前到最早有数据的那天）；
     *             7 = 最近 7 天（仅为兼容旧前端缓存页保留，界面上已无此入口）；
     *             其它值一律收敛到 30。均<b>含今天在内</b>向前 N 天。
     * @return 结构化统计结果（见类文档字段说明）
     */
    public Map<String, Object> compute(int days) {
        boolean allTime = (days == RANGE_ALL);
        // 固定窗口长度；累计至今的窗口长度要等读到账本才知道，故此处不预设
        int fixedRangeDays = allTime ? 0 : ((days == 7) ? 7 : 30);

        ZoneId zone = ZoneId.systemDefault();
        LocalDate today = LocalDate.now(zone);

        // 热力图窗口：按周对齐（周日为列首）的固定 26 周，与范围选择器解耦
        int offsetToSunday = today.getDayOfWeek() == DayOfWeek.SUNDAY ? 0 : today.getDayOfWeek().getValue();
        LocalDate currentSunday = today.minusDays(offsetToSunday);
        LocalDate heatmapStart = currentSunday.minusWeeks(HEATMAP_WEEKS - 1L);
        LocalDate heatmapEnd = currentSunday.plusDays(6); // 本周周六（可能含未来日）

        // ① 先增量归档：把全局区 + 各项目根下会话的新事件并入月度账本
        archiveService.archiveIncremental();

        // ② 再读账本
        TreeMap<LocalDate, UsageArchiveService.DayStat> buckets;
        LocalDate rangeStart;
        if (allTime) {
            // 全量：按目录列举分片，避免为了找「最早一天」而从远古月份逐月空扫
            buckets = archiveService.loadAll();
            if (buckets.isEmpty()) {
                rangeStart = today;
            } else {
                LocalDate earliest = buckets.firstKey();
                // 时钟回拨等异常可能让账本里出现「明天」，夹到今天以内，避免区间天数算成负数
                rangeStart = earliest.isAfter(today) ? today : earliest;
            }
        } else {
            LocalDate cardStart = today.minusDays(fixedRangeDays - 1);
            // 读取下界取两窗口中更早者（热力图窗口通常更早）
            LocalDate loadStart = heatmapStart.isBefore(cardStart) ? heatmapStart : cardStart;
            buckets = archiveService.load(loadStart, today);
            rangeStart = cardStart;
        }

        return buildResult(allTime, today, rangeStart, heatmapStart, heatmapEnd, buckets);
    }

    private Map<String, Object> buildResult(boolean allTime,
                                            LocalDate today, LocalDate rangeStart,
                                            LocalDate heatmapStart, LocalDate heatmapEnd,
                                            TreeMap<LocalDate, UsageArchiveService.DayStat> buckets) {
        Map<String, Object> result = new LinkedHashMap<>();

        // 卡片/趋势窗口：含今天在内向前 rangeDays 天（累计至今则由 rangeStart 反推）
        int rangeDays = (int) (ChronoUnit.DAYS.between(rangeStart, today) + 1);
        if (rangeDays < 1) {
            rangeDays = 1;
        }
        String granularity = pickGranularity(rangeDays);

        // ── 卡片/趋势口径：仅统计 rangeStart..today ──
        Map<String, Long> modelTotals = new LinkedHashMap<>();
        Map<String, Long> modelInputTotals = new LinkedHashMap<>();
        Map<String, Long> modelCacheReadTotals = new LinkedHashMap<>();
        Set<String> activeSessions = new HashSet<>();
        long totalTokens = 0L;
        int messageCount = 0;
        int activeDays = 0;

        // 趋势序列（补零，oldest → newest）：按 granularity 把逐日原始数据聚合成时间桶。
        // 无数据的日期同样会落进它所属的桶里（贡献 0），因此空档周/月依然占一个柱位，
        // 坐标轴不会因为「那阵子没用」而整体前移。
        List<Bucket> series = new ArrayList<>();
        Bucket cur = null;
        for (int i = 0; i < rangeDays; i++) {
            LocalDate d = rangeStart.plusDays(i);
            LocalDate bucketStart = bucketStart(d, granularity, rangeStart);
            if (cur == null || !cur.start.equals(bucketStart)) {
                cur = new Bucket(bucketStart);
                series.add(cur);
            }

            UsageArchiveService.DayStat b = buckets.get(d);
            if (b == null) {
                continue;
            }

            long dayTokens = b.tokens();
            cur.tokens += dayTokens;
            cur.rounds += b.rounds();

            // 桶内按模型 token（趋势图堆叠用）
            for (Map.Entry<String, UsageArchiveService.ModelStat> e : b.models.entrySet()) {
                UsageArchiveService.ModelStat ms = e.getValue();
                if (ms.tokens > 0) {
                    cur.byModel.merge(e.getKey(), ms.tokens, Long::sum);
                }
                modelTotals.merge(e.getKey(), ms.tokens, Long::sum);
                modelInputTotals.merge(e.getKey(), Math.max(0L, ms.input), Long::sum);
                modelCacheReadTotals.merge(e.getKey(), Math.max(0L, ms.cacheRead), Long::sum);
            }

            totalTokens += dayTokens;
            messageCount += b.messages;
            activeSessions.addAll(b.sessions);
            // 活跃判定以「有 token 消耗」为准，而非有轮次：
            // 标题生成等调用会产生 trace 但无 usage 指标（tokens=0），
            // 计入会让活跃天数/连续天数虚高，也与「用量为 0 不展示」的口径矛盾。
            if (dayTokens > 0) {
                activeDays++;
            }
        }

        // 当前连续活跃天数：从今天向前数，遇首个无 token 消耗的日期即止（口径同 activeDays）。
        // 必须基于<b>逐日原始数据</b>而不是上面的时间桶：桶内 tokens>0 只说明那一周/月总计有用量，
        // 并不代表桶的<b>最后一天</b>有用量，拿桶去数会把中断的连续天数误判为仍在继续。
        int streak = 0;
        for (LocalDate d = today; !d.isBefore(rangeStart); d = d.minusDays(1)) {
            UsageArchiveService.DayStat b = buckets.get(d);
            if (b != null && b.tokens() > 0) {
                streak++;
            } else {
                break;
            }
        }

        // 模型分布（按 token 降序；用量为 0 的模型不展示）
        List<Map.Entry<String, Long>> sorted = new ArrayList<>(modelTotals.entrySet());
        sorted.sort(Comparator.comparingLong((Map.Entry<String, Long> e) -> e.getValue()).reversed());
        List<Map<String, Object>> models = new ArrayList<>();
        for (Map.Entry<String, Long> e : sorted) {
            if (e.getValue() == null || e.getValue() <= 0L) {
                continue;
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("model", e.getKey());
            m.put("tokens", e.getValue());
            m.put("percent", totalTokens > 0 ? round1(e.getValue() * 100.0 / totalTokens) : 0.0);
            models.add(m);
        }

        // 缓存命中率排行：按模型聚合 cacheRead / 归一后输入，命中率降序（仅统计有输入的模型）
        List<Map<String, Object>> cacheRanking = new ArrayList<>();
        for (Map.Entry<String, Long> e : modelInputTotals.entrySet()) {
            long input = e.getValue() == null ? 0L : e.getValue();
            if (input <= 0L) {
                continue;
            }
            long cacheRead = modelCacheReadTotals.getOrDefault(e.getKey(), 0L);
            double rate = cacheRead > 0 ? Math.min(100.0, cacheRead * 100.0 / input) : 0.0;
            Map<String, Object> c = new LinkedHashMap<>();
            c.put("model", e.getKey());
            c.put("cacheReadTokens", cacheRead);
            c.put("inputTokens", input);
            c.put("cacheRate", round1(rate));
            cacheRanking.add(c);
        }
        cacheRanking.sort((a, b) -> {
            int byRate = Double.compare(
                    ((Number) b.get("cacheRate")).doubleValue(),
                    ((Number) a.get("cacheRate")).doubleValue());
            if (byRate != 0) {
                return byRate;
            }
            return Long.compare(
                    ((Number) b.get("cacheReadTokens")).longValue(),
                    ((Number) a.get("cacheReadTokens")).longValue());
        });

        String topModel = models.isEmpty() ? null : (String) models.get(0).get("model");
        double topPercent = models.isEmpty() ? 0.0 : ((Number) models.get(0).get("percent")).doubleValue();

        // ── 热力图口径：按周对齐的固定窗口（heatmapStart..heatmapEnd），与范围选择器解耦 ──
        // 逐日铺满整周，超出今天的未来日标记 future=true 供前端渲染为空格。
        List<Map<String, Object>> heatmap = new ArrayList<>();
        for (LocalDate d = heatmapStart; !d.isAfter(heatmapEnd); d = d.plusDays(1)) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("date", d.format(DATE_FMT));
            if (d.isAfter(today)) {
                item.put("future", true);
                item.put("tokens", 0L);
                item.put("rounds", 0);
            } else {
                UsageArchiveService.DayStat b = buckets.get(d);
                item.put("future", false);
                item.put("tokens", b != null ? b.tokens() : 0L);
                item.put("rounds", b != null ? b.rounds() : 0);
            }
            heatmap.add(item);
        }

        List<Map<String, Object>> daily = new ArrayList<>(series.size());
        for (Bucket bk : series) {
            daily.add(bk.toMap());
        }

        result.put("rangeDays", rangeDays);
        // 区间边界：前端据此渲染「统计区间 … · 共 N 天」提示，避免「累计至今」被误读成无限久
        result.put("rangeStart", rangeStart.format(DATE_FMT));
        result.put("rangeEnd", today.format(DATE_FMT));
        result.put("allTime", allTime);
        // 趋势序列的时间桶粒度（day/week/month），决定前端坐标标签怎么格式化
        result.put("granularity", granularity);
        result.put("totalTokens", totalTokens);
        result.put("sessionCount", activeSessions.size());
        result.put("messageCount", messageCount);
        result.put("activeDays", activeDays);
        result.put("currentStreak", streak);
        result.put("topModel", topModel);
        result.put("topModelPercent", topPercent);
        result.put("models", models);
        result.put("cacheRanking", cacheRanking);
        result.put("daily", daily);
        result.put("heatmap", heatmap);
        result.put("heatmapWeeks", HEATMAP_WEEKS);
        return result;
    }

    /** 按区间跨度挑选趋势粒度。 */
    private static String pickGranularity(int rangeDays) {
        if (rangeDays <= GRANULARITY_DAY_MAX) {
            return GRAN_DAY;
        }
        return rangeDays <= GRANULARITY_WEEK_MAX ? GRAN_WEEK : GRAN_MONTH;
    }

    /**
     * 求某日期所属时间桶的起点：按天即当天，按周取所在周的<b>周日</b>（与热力图列首口径一致），
     * 按月取当月 1 号。
     *
     * <p>结果会向前夹到 {@code rangeStart}：区间首日往往落在某个周/月的<b>中间</b>，
     * 若直接用桶的自然起点，坐标上会出现一个「区间外」的日期。夹到 rangeStart 后，
     * 首柱标签就是真实统计起点，与提示行里的统计区间完全对得上。</p>
     */
    private static LocalDate bucketStart(LocalDate d, String granularity, LocalDate rangeStart) {
        LocalDate start;
        if (GRAN_WEEK.equals(granularity)) {
            int sinceSunday = d.getDayOfWeek() == DayOfWeek.SUNDAY ? 0 : d.getDayOfWeek().getValue();
            start = d.minusDays(sinceSunday);
        } else if (GRAN_MONTH.equals(granularity)) {
            start = d.withDayOfMonth(1);
        } else {
            start = d;
        }
        return start.isBefore(rangeStart) ? rangeStart : start;
    }

    /** 趋势图的一个时间桶（日 / 周 / 月）。 */
    private static final class Bucket {
        final LocalDate start;
        long tokens;
        int rounds;
        final Map<String, Long> byModel = new LinkedHashMap<>();

        Bucket(LocalDate start) {
            this.start = start;
        }

        Map<String, Object> toMap() {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("date", start.format(DATE_FMT));
            item.put("tokens", tokens);
            item.put("rounds", rounds);
            item.put("byModel", byModel);
            return item;
        }
    }

    private static double round1(double v) {
        return Math.round(v * 10.0) / 10.0;
    }
}
