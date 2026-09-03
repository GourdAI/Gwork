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
 * 同一会话 ID 只算一次。时间范围支持最近 7 / 30 天。</p>
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
     * @param days 统计天数（仅接受 7 / 30，其它值收敛到 30；含今天在内向前 N 天）
     * @return 结构化统计结果（见类文档字段说明）
     */
    public Map<String, Object> compute(int days) {
        int rangeDays = (days == 7) ? 7 : 30;

        ZoneId zone = ZoneId.systemDefault();
        LocalDate today = LocalDate.now(zone);

        // 卡片/趋势窗口：含今天在内向前 rangeDays 天
        LocalDate rangeStart = today.minusDays(rangeDays - 1);
        // 热力图窗口：按周对齐（周日为列首）的固定 26 周，与范围选择器解耦
        int offsetToSunday = today.getDayOfWeek() == DayOfWeek.SUNDAY ? 0 : today.getDayOfWeek().getValue();
        LocalDate currentSunday = today.minusDays(offsetToSunday);
        LocalDate heatmapStart = currentSunday.minusWeeks(HEATMAP_WEEKS - 1L);
        LocalDate heatmapEnd = currentSunday.plusDays(6); // 本周周六（可能含未来日）

        // ① 先增量归档：把全局区 + 各项目根下会话的新事件并入月度账本
        archiveService.archiveIncremental();

        // ② 再读账本：读取下界取两窗口中更早者（热力图窗口通常更早）
        LocalDate loadStart = heatmapStart.isBefore(rangeStart) ? heatmapStart : rangeStart;
        TreeMap<LocalDate, UsageArchiveService.DayStat> buckets =
                archiveService.load(loadStart, today);

        return buildResult(rangeDays, today, rangeStart, heatmapStart, heatmapEnd, buckets);
    }

    private Map<String, Object> buildResult(int rangeDays,
                                            LocalDate today, LocalDate rangeStart,
                                            LocalDate heatmapStart, LocalDate heatmapEnd,
                                            TreeMap<LocalDate, UsageArchiveService.DayStat> buckets) {
        Map<String, Object> result = new LinkedHashMap<>();

        // ── 卡片/趋势口径：仅统计 rangeStart..today（含今天向前 rangeDays 天） ──
        Map<String, Long> modelTotals = new LinkedHashMap<>();
        Map<String, Long> modelInputTotals = new LinkedHashMap<>();
        Map<String, Long> modelCacheReadTotals = new LinkedHashMap<>();
        Set<String> activeSessions = new HashSet<>();
        long totalTokens = 0L;
        int messageCount = 0;

        // 逐日序列（补零，oldest → newest），供趋势图使用
        List<Map<String, Object>> daily = new ArrayList<>(rangeDays);
        int activeDays = 0;
        for (int i = 0; i < rangeDays; i++) {
            LocalDate d = rangeStart.plusDays(i);
            UsageArchiveService.DayStat b = buckets.get(d);

            Map<String, Object> item = new LinkedHashMap<>();
            item.put("date", d.format(DATE_FMT));

            if (b == null) {
                item.put("tokens", 0L);
                item.put("rounds", 0);
                item.put("byModel", new LinkedHashMap<String, Long>());
                daily.add(item);
                continue;
            }

            long dayTokens = b.tokens();
            int dayRounds = b.rounds();

            // 当日按模型 token（趋势图堆叠用）
            Map<String, Long> byModel = new LinkedHashMap<>();
            for (Map.Entry<String, UsageArchiveService.ModelStat> e : b.models.entrySet()) {
                UsageArchiveService.ModelStat ms = e.getValue();
                if (ms.tokens > 0) {
                    byModel.put(e.getKey(), ms.tokens);
                }
                modelTotals.merge(e.getKey(), ms.tokens, Long::sum);
                modelInputTotals.merge(e.getKey(), Math.max(0L, ms.input), Long::sum);
                modelCacheReadTotals.merge(e.getKey(), Math.max(0L, ms.cacheRead), Long::sum);
            }

            item.put("tokens", dayTokens);
            item.put("rounds", dayRounds);
            item.put("byModel", byModel);
            daily.add(item);

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

        // 当前连续活跃天数：从今天向前数，遇首个无 token 消耗的日期即止（口径同 activeDays）
        int streak = 0;
        for (int i = rangeDays - 1; i >= 0; i--) {
            Object tokens = daily.get(i).get("tokens");
            if (((Number) tokens).longValue() > 0) {
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

        result.put("rangeDays", rangeDays);
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

    private static double round1(double v) {
        return Math.round(v * 10.0) / 10.0;
    }
}
