/* app-heatmap.js — 活跃热力图共享组件（window.GourdHeatmap）
 *
 * 从「使用统计」页抽取出来的单一实现，供两处复用：
 *   1) 使用统计主视图（app-settings-usage.js → renderHeatmapCard）
 *   2) 欢迎页「活跃热力图」卡片（app-welcome-activity.js）
 *
 * 输入契约（与 /web/chat/usage/stats 返回的 data.heatmap 对齐）：
 *   [{ date: 'yyyy-MM-dd', tokens: long, rounds: int, future: boolean }]
 *   - 数组按日连续、以周日起头（由后端按周对齐保证）；CSS Grid 以
 *     「行=星期、列=周」铺排，长度非 7 倍数时由 future 项补齐末列；
 *   - 分档为窗口内相对口径：lv = ceil(tokens / maxTok * 4) 截断到 1..4，
 *     tokens = 0 或窗口全零时为 0 档。
 *
 * 输出：.usage-heat-wrap（网格 + 图例）HTML 片段，不含卡片外壳；
 * 样式依赖 css/usage-stats.css 的 .usage-heat-*（已解除 #usageView 作用域）。
 * 纯字符串拼接、无 DOM 依赖；node 契约测试直接读取源码断言。 */
(function () {
    'use strict';

    function t(key, args) { return window.GourdI18n ? GourdI18n.t(key, args) : key; }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /* ── 数值格式化（万 / 亿） ─────────────────────────────── */
    function fmtNum(n) {
        n = Number(n) || 0;
        if (n >= 1e8) return trimZero(n / 1e8) + '亿';
        if (n >= 1e4) return trimZero(n / 1e4) + '万';
        return String(Math.round(n));
    }
    function trimZero(v) {
        var s = v.toFixed(1);
        return s.replace(/\.0$/, '');
    }
    /* 月份名走原生 Intl（按当前 locale 出「10月 / Oct / Okt」），不为 12 个语言包
     * 各加一份月份表；locale 取 GourdI18n.getLocale()，缺失/异常时回退纯数字。 */
    function monthLabel(m) {
        var locale = null;
        try { if (window.GourdI18n && typeof window.GourdI18n.getLocale === 'function') locale = window.GourdI18n.getLocale(); } catch (e) { locale = null; }
        try {
            return new Date(2026, m - 1, 1).toLocaleString(locale || undefined, { month: 'short' });
        } catch (e2) {
            return String(m);
        }
    }

    function fmtDateMd(dateStr) {
        // dateStr: yyyy-MM-dd
        var parts = String(dateStr).split('-');
        if (parts.length < 3) return dateStr;
        return t('settings.usage.date_md', [String(Number(parts[1])), String(Number(parts[2]))]);
    }

    /* ── 窗口补齐（欢迎页 year:true 专用） ──────────────────
     * 后端 heatmap 窗口长度由 HEATMAP_WEEKS 决定，但运行中的桌面 jar 可能仍是旧构建
     * （26 周 ≈ 半年），导致月份时间轴只有 7 个标签。补齐在【前端】把窗口扩到一年：
     * 以现有首日为锚，向前补足缺失的整周（tokens=0、future=false）。
     * - 幂等：窗口已 ≥ 目标周数时原样返回（后端重建为 53 周后此分支即生效）；
     * - 真实：账本里更早的日期本就无活跃，补零格如实反映「那段时间没用过」；
     * - 只影响欢迎页（仅它传 year:true），使用统计页保持后端原始窗口不变。
     * 日期运算走 UTC 毫秒，规避夏令时导致的跨日错位。 */
    var YEAR_WEEKS = 53;
    function parseIsoUtc(s) {
        var p = String(s).split('-');
        return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    }
    function isoFromUtc(ms) { return new Date(ms).toISOString().slice(0, 10); }
    function padToWeeks(heatmap, targetWeeks) {
        heatmap = heatmap || [];
        var targetDays = targetWeeks * 7;
        if (!heatmap.length || heatmap.length >= targetDays) return heatmap;
        var firstUtc = parseIsoUtc(heatmap[0].date);
        if (!isFinite(firstUtc)) return heatmap;
        var miss = targetDays - heatmap.length;
        var pad = [];
        for (var i = miss; i > 0; i--) {
            pad.push({ date: isoFromUtc(firstUtc - i * 86400000), tokens: 0, rounds: 0, future: false });
        }
        return pad.concat(heatmap);
    }

    /* ── 网格渲染 ─────────────────────────────────────────── */
    /* heatmap: 后端返回的按周对齐固定窗口（周日为列首），每项 {date, tokens, rounds, future}。
     * 采用 CSS Grid（列主序，7 行、列数自适应 1fr），方块 aspect-ratio:1，铺满整包宽度，
     * 无前导空位错位问题；未来日（future=true）渲染为与零活跃同色的空格。
     * opts.legend=false 时不输出「少→多」图例（欢迎页紧凑态：图例信息已由悬停提示承载）。
     * opts.months=true 时输出底部月份时间轴（见 renderMonths）。
     * 列宽始终 1fr 拉伸：欢迎页卡片与输入框同宽（max-width 680px），网格铺满即与之对齐；
     * 月份轴与图例互不排斥，但欢迎页只开 months，使用统计页保持默认形态。 */
    function renderGrid(heatmap, opts) {
        heatmap = heatmap || [];
        // year:true（欢迎页）：把后端窗口补齐到一年，月份轴稳定铺满 12+ 个月，
        // 不受运行中 jar 是 26 周还是 53 周影响（见 padToWeeks）。
        if (opts && opts.year) heatmap = padToWeeks(heatmap, YEAR_WEEKS);
        var maxTok = 0;
        heatmap.forEach(function (d) { if (!d.future && d.tokens > maxTok) maxTok = d.tokens; });

        var weeks = Math.max(1, Math.ceil(heatmap.length / 7));
        var grid = '<div class="usage-heat-grid" style="grid-template-columns:repeat(' + weeks + ',1fr)">';
        heatmap.forEach(function (d) {
            if (d.future) {
                grid += '<div class="usage-heat-cell usage-heat-empty"></div>';
                return;
            }
            var lv = 0;
            if (d.tokens > 0 && maxTok > 0) {
                lv = Math.min(4, Math.max(1, Math.ceil(d.tokens / maxTok * 4)));
            }
            var tip = t('settings.usage.tooltip', [fmtDateMd(d.date), fmtNum(d.tokens), String(d.rounds)]);
            grid += '<div class="usage-heat-cell" data-level="' + lv + '" title="' + escapeHtml(tip) + '"></div>';
        });
        grid += '</div>';

        var compact = opts && opts.legend === false;
        var months = (opts && opts.months) ? renderMonths(heatmap, weeks) : '';

        if (compact) {
            return '<div class="usage-heat-wrap usage-heat-compact">' + grid + months + '</div>';
        }

        var legend = '<div class="usage-heat-legend"><span>' + escapeHtml(t('settings.usage.heat_less')) + '</span>';
        for (var l = 0; l <= 4; l++) {
            legend += '<span class="usage-heat-cell usage-heat-legend-cell" data-level="' + l + '"></span>';
        }
        legend += '<span>' + escapeHtml(t('settings.usage.heat_more')) + '</span></div>';

        return '<div class="usage-heat-wrap">' + grid + months + legend + '</div>';
    }

    /* ── 月份时间轴 ─────────────────────────────────────────
     * 标签锚点 = 「该月首个周日」所在列（列首日落在该月，与 GitHub 贡献图同构）：
     * 月份 ≥28 天，相邻锚点天然 ≥4 列，整轴间距自然均匀——旧锚点取「1 号所在列」，
     * 窗口月中开局时首月与次月仅隔 1 列，「让位」会把前段标签压成 MIN_GAP 密簇（分布不均）。
     * 某月列首日全为 future（月初、首个周日未到）时退到该月首个非 future 日所在列，当月不丢标签。
     * 前导残月不出标签：窗口月中开局时首月常只占 1~2 列，放不下一个标签还会把整轴推挤右移，
     * 与次月锚点间距 < MIN_GAP 即舍去首标签（残月格子照常渲染，仅省标签）；轴中完整月份一个不丢。
     * 让位/回拉保留为兜底：正常日历间距下不触发，仅末标签回拉等极端窗口生效。
     * LABEL_W/MIN_GAP 以「列」为单位：欢迎页拉伸态列宽 ≈ 680/53 ≈ 12.8px，11px 字号的
     * 「10月/Oct」约 33px ≈ 2.6 列，故 LABEL_W=2.6、MIN_GAP=3.0。这两个常量与
     * usage-stats.css 的月份字号互为契约，改任一须同步。 */
    function renderMonths(heatmap, weeks) {
        var LABEL_W = 2.6;
        var MIN_GAP = 3.0;
        var items = [];
        var lastMonth = -1;
        for (var i = 0; i < heatmap.length; i++) {
            var d = heatmap[i];
            if (d.future) continue;
            var m = Number(String(d.date).split('-')[1]);
            if (!m || m === lastMonth) continue;   // 顺序比较：跨年同月名（9月→9月）仍是新标签
            // 锚点首选该月首个非 future 列首日（周日）；换月日在周中时看下一列首：
            // 非 future 且同月 → 用它；已是 future（月初）→ 退到换月日所在列，当月不丢标签。
            var anchor = Math.floor(i / 7);
            if (i % 7 !== 0) {
                var ns = (anchor + 1) * 7;
                if (ns < heatmap.length && !heatmap[ns].future
                    && Number(String(heatmap[ns].date).split('-')[1]) === m) {
                    anchor = anchor + 1;
                }
            }
            items.push({ month: m, start: anchor });
            lastMonth = m;
        }
        if (items.length > 1 && items[1].start - items[0].start < MIN_GAP) items.shift();   // 前导残月（见注释）
        if (!items.length) return '';
        for (var k = 1; k < items.length; k++) {
            if (items[k].start < items[k - 1].start + MIN_GAP) {
                items[k].start = items[k - 1].start + MIN_GAP;   // 右移让位，不丢月份
            }
        }
        var cap = weeks - LABEL_W;
        for (var b = items.length - 1; b >= 0; b--) {
            if (items[b].start > cap) items[b].start = cap;      // 末标签右缘收进容器
            cap = items[b].start - MIN_GAP;                      // 连锁保障与前标签的间距
        }
        var out = '<div class="usage-heat-months">';
        items.forEach(function (it) {
            var left = (it.start / weeks * 100).toFixed(2);
            out += '<span style="left:' + left + '%">' + escapeHtml(monthLabel(it.month)) + '</span>';
        });
        return out + '</div>';
    }

    window.GourdHeatmap = { renderGrid: renderGrid };
})();
