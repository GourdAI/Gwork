/* app-settings-usage.js — 「使用统计」主页面
 *
 * 聚合全局对话区所有会话的 token 消耗、活跃度与模型分布，可视化展示：
 *   - 概览卡片：tokens 用量 / 会话数 / 消息数 / 活跃天数 / 连续天数 / 最常用模型
 *   - 活跃热力图（GitHub 贡献图风格，按天着色）
 *   - 按天 Token 趋势（SVG 堆叠柱，按模型分色）
 *   - 模型用量（SVG 环形图 + 明细列表）
 *
 * 数据来源：后端 /web/chat/usage/stats（解析各会话 stream.ndjson 的 trace 事件，无额外埋点）。
 * 所有配色均取自 theme.css 主题变量，明暗自适应；无第三方图表库依赖，纯 SVG/CSS 渲染。
 */
(function () {
    'use strict';

    var CONTAINER = 'settingsTabUsage';
    var core = window._settingsCore || {};
    var escapeHtml = core.escapeHtml || function (s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };

    // 模型分色调色板：全部引用主题变量，保证明暗主题一致
    var PALETTE = ['--accent', '--color-success', '--color-warning', '--color-feishu',
        '--color-dingtalk', '--color-danger', '--color-wechat'];

    var currentDays = 30;
    var loadSerial = 0;
    var pendingRequest = null;

    function t(key, args) { return window.GourdI18n ? GourdI18n.t(key, args) : key; }

    function $c() { return $('#' + CONTAINER); }

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
    function fmtPercent(p) {
        p = Number(p) || 0;
        // 极小非零占比不显示为 0，至少 0.1
        if (p > 0 && p < 0.1) return '0.1';
        return trimZero(p);
    }
    function fmtDateMd(dateStr) {
        // dateStr: yyyy-MM-dd
        var parts = String(dateStr).split('-');
        if (parts.length < 3) return dateStr;
        return t('settings.usage.date_md', [String(Number(parts[1])), String(Number(parts[2]))]);
    }

    /* 为模型分配主题色变量（按 models 顺序，即 token 降序）。 */
    function buildColorMap(models) {
        var map = {};
        (models || []).forEach(function (m, i) {
            map[m.model] = 'var(' + PALETTE[i % PALETTE.length] + ')';
        });
        return map;
    }

    /* ── 加载 ─────────────────────────────────────────────── */
    /* 首次进入 / 切换时间范围：构建外壳并在数据区显示 loading。 */
    function load() {
        ensureShell();
        var requestDays = currentDays;
        var requestSerial = ++loadSerial;
        if (pendingRequest && typeof pendingRequest.abort === 'function') {
            pendingRequest.abort();
        }
        if (!hasBody()) {
            renderBodyLoading();
        }
        pendingRequest = $.ajax({
            url: '/web/chat/usage/stats?days=' + requestDays,
            method: 'GET',
            dataType: 'json'
        }).done(function (resp) {
            // 时间范围切换或重复打开页面后，旧请求不得覆盖当前范围的数据。
            if (requestSerial !== loadSerial) return;
            if (resp && resp.code === 200 && resp.data) {
                renderBody(resp.data);
            } else {
                renderBodyError();
            }
        }).fail(function (jqXHR, textStatus) {
            // abort 是主动取消旧请求，不应把当前页面改成错误状态。
            if (requestSerial !== loadSerial || textStatus === 'abort') return;
            renderBodyError();
        }).always(function () {
            if (requestSerial === loadSerial) pendingRequest = null;
        });
    }

    function $body() { return $c().find('#usageBody'); }
    function hasBody() { return $body().children().length > 0 && !$body().hasClass('is-loading'); }

    function renderBodyLoading() {
        $body().addClass('is-loading').html('<div class="usage-state">' + escapeHtml(t('settings.usage.loading')) + '</div>');
    }
    function renderBodyError() {
        $body().removeClass('is-loading').html('<div class="usage-state usage-state-error">' + escapeHtml(t('settings.usage.load_failed')) + '</div>');
    }

    /* ── 外壳（标题，持久不重建） ─────────── */
    function ensureShell() {
        if ($c().find('#usageBody').length) {
            return;
        }
        var html = '';
        html += '<div class="settings-section-header settings-section-header-flat"><div class="usage-title-row">';
        html += '<span class="settings-section-title">' + escapeHtml(t('settings.usage.title')) + '</span>';
        html += '</div></div>';
        html += renderRangeBar();
        html += '<div class="usage-body" id="usageBody"></div>';
        $c().html(html);
    }

    function renderRangeBar() {
        var html = '<div class="usage-range-bar">';
        html += '<span class="usage-range-label">' + escapeHtml(t('settings.usage.range_label')) + '</span>';
        html += '<div class="usage-range-toggle">';
        html += '<button type="button" class="usage-range-btn' + (currentDays === 7 ? ' active' : '') + '" data-days="7">' + escapeHtml(t('settings.usage.range_7')) + '</button>';
        html += '<button type="button" class="usage-range-btn' + (currentDays === 30 ? ' active' : '') + '" data-days="30">' + escapeHtml(t('settings.usage.range_30')) + '</button>';
        html += '</div></div>';
        return html;
    }

    function updateRangeBar() {
        var $bar = $c().find('.usage-range-bar');
        $bar.find('.usage-range-btn').removeClass('active');
        $bar.find('.usage-range-btn[data-days="' + currentDays + '"]').addClass('active');
    }

    /* ── 数据区渲染（所有图表，可反复重建；不含页头和时间范围） ── */
    function renderBody(data) {
        var models = data.models || [];
        var colorMap = buildColorMap(models);

        var html = '';

        // 概览卡片
        html += renderStatCards(data);

        // 空数据提示
        var hasData = (Number(data.totalTokens) || 0) > 0;
        if (!hasData) {
            html += '<div class="usage-state usage-state-empty">' + escapeHtml(t('settings.usage.empty')) + '</div>';
            $body().removeClass('is-loading').html(html);
            return;
        }

        // 活跃热力图（固定 26 周窗口，铺满整卡宽度）
        html += renderHeatmapCard(data.heatmap || []);
        // 按天 Token 趋势
        html += renderTrendCard(data.daily || [], models, colorMap);
        // 模型用量
        html += renderModelsCard(data, models, colorMap);
        // 缓存命中率排行
        html += renderCacheCard(data.cacheRanking || [], colorMap);

        $body().removeClass('is-loading').html(html);
    }

    /* ── 概览卡片 ─────────────────────────────────────────── */
    function statCard(icon, label, valueHtml, subHtml) {
        var h = '<div class="usage-stat-card">';
        h += '<div class="usage-stat-head">' + icon + '<span class="usage-stat-label">' + escapeHtml(label) + '</span></div>';
        h += '<div class="usage-stat-value">' + valueHtml + '</div>';
        if (subHtml) h += '<div class="usage-stat-sub">' + subHtml + '</div>';
        h += '</div>';
        return h;
    }

    function renderStatCards(data) {
        var ic = {
            tokens: svg('<path d="M12 2a5 5 0 0 0-5 5c0 2 1 3 1 5H9a3 3 0 1 0 6 0h1c0-2 1-3 1-5a5 5 0 0 0-5-5z"/><path d="M12 17v4"/>'),
            sessions: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
            messages: svg('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/>'),
            days: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
            streak: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="m9 16 2 2 4-4"/>'),
            model: svg('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>')
        };

        var h = '<div class="usage-stat-grid">';
        h += statCard(ic.tokens, t('settings.usage.stat_tokens'), fmtNum(data.totalTokens));
        h += statCard(ic.sessions, t('settings.usage.stat_sessions'), String(data.sessionCount || 0));
        h += statCard(ic.messages, t('settings.usage.stat_messages'), String(data.messageCount || 0));
        h += statCard(ic.days, t('settings.usage.stat_active_days'), String(data.activeDays || 0));
        h += statCard(ic.streak, t('settings.usage.stat_streak'), String(data.currentStreak || 0));
        var topVal = data.topModel
            ? '<span class="usage-stat-model">' + escapeHtml(data.topModel) + '</span>'
            : '<span class="usage-stat-model usage-muted">-</span>';
        var topSub = data.topModel
            ? t('settings.usage.percent_of', [fmtPercent(data.topModelPercent)])
            : '';
        h += statCard(ic.model, t('settings.usage.stat_top_model'), topVal, topSub ? escapeHtml(topSub) : '');
        h += '</div>';
        return h;
    }

    function svg(inner) {
        return '<svg class="usage-stat-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
    }

    /* ── 活跃热力图 ───────────────────────────────────────── */
    /* heatmap: 后端返回的按周对齐固定窗口（周日为列首），每项 {date, tokens, rounds, future}。
     * 采用 CSS Grid（列主序，7 行、列数自适应 1fr），方块 aspect-ratio:1，铺满整卡宽度，
     * 无前导空位错位问题；未来日（future=true）渲染为透明空格。 */
    function renderHeatmapCard(heatmap) {
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

        var legend = '<div class="usage-heat-legend"><span>' + escapeHtml(t('settings.usage.heat_less')) + '</span>';
        for (var l = 0; l <= 4; l++) {
            legend += '<span class="usage-heat-cell usage-heat-legend-cell" data-level="' + l + '"></span>';
        }
        legend += '<span>' + escapeHtml(t('settings.usage.heat_more')) + '</span></div>';

        return card(t('settings.usage.heatmap_title'), '<div class="usage-heat-wrap">' + grid + legend + '</div>');
    }

    /* ── 按天 Token 趋势（SVG 堆叠柱） ─────────────────────── */
    function renderTrendCard(daily, models, colorMap) {
        var n = daily.length;
        var maxTotal = 0;
        daily.forEach(function (d) { if (d.tokens > maxTotal) maxTotal = d.tokens; });
        if (maxTotal <= 0) maxTotal = 1;

        var W = 720, H = 240, padL = 8, padR = 8, padT = 12, padB = 28;
        var plotW = W - padL - padR;
        var plotH = H - padT - padB;
        var slot = plotW / Math.max(1, n);
        var barW = Math.min(28, slot * 0.55);

        var svg = '<svg class="usage-trend-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">';

        // 背景网格线（4 条虚线）
        for (var g = 0; g <= 4; g++) {
            var gy = padT + plotH * g / 4;
            svg += '<line class="usage-grid-line" x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '"/>';
        }

        // 堆叠柱
        daily.forEach(function (d, i) {
            var cx = padL + slot * i + slot / 2;
            var x = cx - barW / 2;
            var accY = padT + plotH; // 从底部往上堆
            var bm = d.byModel || {};
            models.forEach(function (m) {
                var v = Number(bm[m.model]) || 0;
                if (v <= 0) return;
                var hh = plotH * v / maxTotal;
                accY -= hh;
                svg += '<rect x="' + fx(x) + '" y="' + fx(accY) + '" width="' + fx(barW) + '" height="' + fx(hh) + '" rx="1.5" style="fill:' + colorMap[m.model] + '"/>';
            });
        });

        // X 轴日期标签：均匀分布且强制包含首尾（index 0 与 n-1），
        // 保证最后一个刻度始终贴到今天/右边缘，避免右侧柱子落在无标签区。
        var ticks = Math.min(6, n);
        var seen = {};
        for (var s = 0; s < ticks; s++) {
            var k = (ticks <= 1) ? (n - 1) : Math.round(s * (n - 1) / (ticks - 1));
            if (seen[k]) continue;
            seen[k] = 1;
            var lx = padL + slot * k + slot / 2;
            // 首尾刻度贴边对齐，避免文本溢出画布
            var anchor = (k === 0) ? 'start' : (k === n - 1 ? 'end' : 'middle');
            svg += '<text class="usage-axis-label" x="' + fx(lx) + '" y="' + (H - 8) + '" text-anchor="' + anchor + '">' + escapeHtml(fmtDateMd(daily[k].date)) + '</text>';
        }

        svg += '</svg>';

        return card(t('settings.usage.trend_title'),
            '<div class="usage-trend-wrap">' + svg + '</div>' + renderLegend(models, colorMap));
    }

    function fx(v) { return Math.round(v * 100) / 100; }

    function renderLegend(models, colorMap) {
        if (!models.length) return '';
        var h = '<div class="usage-legend">';
        models.forEach(function (m) {
            h += '<span class="usage-legend-item"><span class="usage-legend-dot" style="background:' + colorMap[m.model] + '"></span>' + escapeHtml(m.model) + '</span>';
        });
        h += '</div>';
        return h;
    }

    /* ── 模型用量（环形图 + 列表） ────────────────────────── */
    function renderModelsCard(data, models, colorMap) {
        var total = Number(data.totalTokens) || 0;
        var R = 70, C = 90, sw = 22;          // 半径 / 画布中心 / 环宽
        var circ = 2 * Math.PI * R;
        var svg = '<svg class="usage-donut-svg" viewBox="0 0 180 180">';
        // 底环
        svg += '<circle cx="' + C + '" cy="' + C + '" r="' + R + '" fill="none" stroke="var(--bg-hover)" stroke-width="' + sw + '"/>';

        var offset = 0;
        models.forEach(function (m) {
            var frac = total > 0 ? (Number(m.tokens) || 0) / total : 0;
            if (frac <= 0) return;
            var len = circ * frac;
            // 留 1px 间隙区分相邻段
            var dash = Math.max(0, len - 1.2) + ' ' + (circ - Math.max(0, len - 1.2));
            svg += '<circle cx="' + C + '" cy="' + C + '" r="' + R + '" fill="none" style="stroke:' + colorMap[m.model] + '" stroke-width="' + sw + '"'
                + ' stroke-dasharray="' + dash + '" stroke-dashoffset="' + fx(-offset) + '" transform="rotate(-90 ' + C + ' ' + C + ')"/>';
            offset += len;
        });

        // 中心总量
        svg += '<text class="usage-donut-total" x="' + C + '" y="' + (C - 4) + '" text-anchor="middle">' + escapeHtml(fmtNum(total)) + '</text>';
        svg += '<text class="usage-donut-unit" x="' + C + '" y="' + (C + 18) + '" text-anchor="middle">' + escapeHtml(t('settings.usage.tokens_unit')) + '</text>';
        svg += '</svg>';

        var list = '<div class="usage-model-list">';
        models.forEach(function (m) {
            list += '<div class="usage-model-row">'
                + '<span class="usage-model-name"><span class="usage-legend-dot" style="background:' + colorMap[m.model] + '"></span>' + escapeHtml(m.model) + '</span>'
                + '<span class="usage-model-pct">' + escapeHtml(fmtPercent(m.percent)) + '%</span>'
                + '<span class="usage-model-tok">' + escapeHtml(fmtNum(m.tokens)) + ' ' + escapeHtml(t('settings.usage.tokens_unit')) + '</span>'
                + '</div>';
        });
        list += '</div>';

        return card(t('settings.usage.models_title'),
            '<div class="usage-donut-wrap"><div class="usage-donut-chart">' + svg + '</div>' + list + '</div>');
    }

    /* ── 缓存命中率排行 ───────────────────────────────────── */
    /* cacheRanking: 后端按缓存命中率降序排序的模型列表，每项 {model, cacheRate, cacheReadTokens, inputTokens}。
     * 以横向进度条 + 百分比 + 命中 token 绝对量展示，配色沿用模型分色（colorMap）。 */
    function renderCacheCard(ranking, colorMap) {
        if (!ranking || !ranking.length) {
            return card(t('settings.usage.cache_title'),
                '<div class="usage-state usage-state-empty">' + escapeHtml(t('settings.usage.cache_empty')) + '</div>');
        }
        var body = '<div class="usage-cache-list">';
        ranking.forEach(function (m, i) {
            var rate = Number(m.cacheRate) || 0;
            var color = colorMap[m.model] || 'var(--accent)';
            body += '<div class="usage-cache-row">'
                + '<span class="usage-cache-rank">' + (i + 1) + '</span>'
                + '<span class="usage-cache-name"><span class="usage-legend-dot" style="background:' + color + '"></span>' + escapeHtml(m.model) + '</span>'
                + '<span class="usage-cache-bar"><span class="usage-cache-bar-fill" style="width:' + Math.max(0, Math.min(100, rate)) + '%;background:' + color + '"></span></span>'
                + '<span class="usage-cache-rate">' + escapeHtml(fmtPercent(rate)) + '%</span>'
                + '<span class="usage-cache-hit">' + escapeHtml(t('settings.usage.cache_hit', [fmtNum(m.cacheReadTokens)])) + '</span>'
                + '</div>';
        });
        body += '</div>';
        return card(t('settings.usage.cache_title'), body);
    }

    /* ── 公共卡片外壳 ─────────────────────────────────────── */
    function card(title, bodyHtml) {
        return '<div class="usage-card"><div class="usage-card-title">' + escapeHtml(title) + '</div>'
            + '<div class="usage-card-body">' + bodyHtml + '</div></div>';
    }

    /* ── 事件绑定（时间范围切换，事件委托） ─────────── */
    $(document).on('click', '#' + CONTAINER + ' .usage-range-btn', function () {
        var days = parseInt($(this).attr('data-days'), 10);
        if (days === currentDays) return;
        currentDays = (days === 7) ? 7 : 30;
        updateRangeBar();
        load();
    });

    function openUsage() {
        if (typeof window.exitCodeMode === 'function' && window.appMode === 'code') window.exitCodeMode();
        if (typeof window.closeAutomation === 'function') window.closeAutomation();
        if (typeof window.closeSkills === 'function') window.closeSkills();
        if (typeof window.closeChannel === 'function') window.closeChannel();
        if (typeof window.closeModelSettings === 'function') window.closeModelSettings();
        if (typeof window.closeMemoryView === 'function') window.closeMemoryView();
        $('#welcomeView').hide();
        $('#chatView').removeClass('active');
        $('#usageView').addClass('active');
        $('.main-nav-item').removeClass('active');
        $('#usageNavBtn').addClass('active');
        window.inChatMode = false;
        if (typeof window.closeSettings === 'function') window.closeSettings();
        $('.sidebar').removeClass('mobile-open');
        $('#mobileOverlay').removeClass('show');
        load();
    }
    function closeUsage() {
        $('#usageView').removeClass('active');
        $('#usageNavBtn').removeClass('active');
    }
    window.openUsage = openUsage;
    window.closeUsage = closeUsage;
    window.isUsageOpen = function () { return $('#usageView').hasClass('active'); };

    window._settingsUsage = { load: load };
})();
