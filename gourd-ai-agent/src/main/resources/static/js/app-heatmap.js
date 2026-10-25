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

    /* ── 本地化格式化 ───────────────────────────────────────
     * 全部走原生 Intl（按当前 locale 决定分隔符、月份缩写、紧凑单位），
     * 不为 12 个语言包各维护一份月份表/单位表；locale 取 GourdI18n.getLocale()。
     *
     * 历史教训：旧实现把「万 / 亿」写死在代码里（tokens >= 1e4 → '万'），
     * 界面切到 English/日本語 后提示里仍然是「1.2万 Tokens」——单位是硬编码中文，
     * 语言包再全也救不回来。紧凑单位只有 Intl 能按 locale 正确表达
     * （en → 1.2K / 12.3K，zh → 1.2万，ja → 1.2万，ru → 1,2 тыс.）。
     * 取不到 Intl 时回退纯数字，绝不回退到某个语言的单位。 */
    function localeOf() {
        var locale = null;
        try {
            if (window.GourdI18n && typeof window.GourdI18n.getLocale === 'function') locale = window.GourdI18n.getLocale();
        } catch (e) { locale = null; }
        return locale || undefined;
    }

    /* formatter 构造有成本（单次约 0.02ms），按 locale 缓存复用。
     * 371 格的提示是悬停时才构建的，缓存只为「快速划过一片格子」的场景。 */
    var compactCache = {};
    var plainCache = {};
    function compactFormatter() {
        var loc = localeOf() || '';
        if (!Object.prototype.hasOwnProperty.call(compactCache, loc)) {
            var f = null;
            try {
                if (typeof Intl !== 'undefined' && Intl.NumberFormat) {
                    f = new Intl.NumberFormat(loc || undefined, { notation: 'compact', maximumFractionDigits: 1 });
                }
            } catch (e) { f = null; }
            compactCache[loc] = f;
        }
        return compactCache[loc];
    }
    function plainFormatter() {
        var loc = localeOf() || '';
        if (!Object.prototype.hasOwnProperty.call(plainCache, loc)) {
            var f = null;
            try {
                if (typeof Intl !== 'undefined' && Intl.NumberFormat) {
                    f = new Intl.NumberFormat(loc || undefined);
                }
            } catch (e) { f = null; }
            plainCache[loc] = f;
        }
        return plainCache[loc];
    }

    /** Token 用量：紧凑记法（1.2K / 1.2万），单位由 locale 决定。 */
    function fmtTokens(n) {
        n = Number(n) || 0;
        var f = compactFormatter();
        if (f) {
            try { return f.format(n); } catch (e) { /* 落到下面的纯数字 */ }
        }
        return String(Math.round(n));
    }

    /** 任务个数：普通计数（不做紧凑化，个位数才是常态，紧凑记法反而更费解）。 */
    function fmtCount(n) {
        n = Number(n) || 0;
        var f = plainFormatter();
        if (f) {
            try { return f.format(n); } catch (e) { /* 落到下面的纯数字 */ }
        }
        return String(Math.round(n));
    }

    /* Intl.DateTimeFormat 构造极贵：new 一次约 0.05ms，371 格逐格 new 合计 ~11.7ms
     * （renderGrid 总耗时 15.5ms 的 75% 都花在这上面）。toLocaleDateString/toLocaleString
     * 内部每次都新建 formatter，所以必须自己缓存实例按 locale 复用：实测 371 次
     * 从 20.8ms 降到 0.2ms（104x）。输出与 toLocaleDateString 逐字节一致（12 语言实测 0 差异）。
     *
     * key = locale + '|' + 选项标签：同一 locale 下月份短名与完整日期的选项不同，不能共用实例。 */
    var dtfCache = {};
    function dateFormatter(loc, optKey, opts) {
        var key = (loc || '') + '|' + optKey;
        if (!Object.prototype.hasOwnProperty.call(dtfCache, key)) {
            var f = null;
            try {
                if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
                    f = new Intl.DateTimeFormat(loc || undefined, opts);
                }
            } catch (e) { f = null; }
            dtfCache[key] = f;
        }
        return dtfCache[key];
    }

    /* 月份名走原生 Intl（按当前 locale 出「10月 / Oct / Okt」）。 */
    function monthLabel(m) {
        try {
            var f = dateFormatter(localeOf(), 'month', { month: 'short' });
            if (f) return f.format(new Date(2026, m - 1, 1));
            return new Date(2026, m - 1, 1).toLocaleString(localeOf(), { month: 'short' });
        } catch (e2) {
            return String(m);
        }
    }

    /* 完整日期（悬停浮层首行）：周几 + 年 + 月 + 日，整体交给 Intl 排版，
     * 各语言的语序、标点、星期缩写都由 locale 数据决定（en: Tue, Sep 22, 2026 /
     * zh: 2026年9月22日周二 / ja: 2026年9月22日(火)）。
     * 用本地时区构造 Date（不是 UTC）—— 日期串本来就是本地日期，
     * 走 UTC 构造会在西半球时区整体前移一天。 */
    function fmtDateFull(dateStr) {
        var p = String(dateStr == null ? '' : dateStr).split('-');
        if (p.length < 3) return String(dateStr == null ? '' : dateStr);
        var y = Number(p[0]), m = Number(p[1]), d = Number(p[2]);
        if (!y || !m || !d) return String(dateStr);
        var opts = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' };
        try {
            var f = dateFormatter(localeOf(), 'full', opts);
            if (f) return f.format(new Date(y, m - 1, d));
            return new Date(y, m - 1, d).toLocaleDateString(localeOf(), opts);
        } catch (e) {
            return String(dateStr);
        }
    }

    /* ── 悬停浮层内容 ───────────────────────────────────────
     * 三要素：时间 / 任务个数 / 消耗的总 Tokens。
     * 拆成独立纯函数（不碰 DOM），node 契约测试可直接喂数据断言结构。
     * meta.tasks 允许为 null/undefined（旧后端不返回 sessions 字段）：
     * 此时整行省略，而不是显示一个假的「0 个任务」—— 把「不知道」画成「没有」
     * 比少一行更糟。 */
    function tipRow(label, value) {
        return '<div class="usage-heat-tip-row"><span class="usage-heat-tip-k">' + escapeHtml(label)
            + '</span><span class="usage-heat-tip-v">' + escapeHtml(value) + '</span></div>';
    }
    function buildTip(meta) {
        meta = meta || {};
        var rows = '';
        if (meta.tasks !== null && meta.tasks !== undefined && isFinite(Number(meta.tasks))) {
            rows += tipRow(t('settings.usage.tip_tasks'), fmtCount(meta.tasks));
        }
        rows += tipRow(t('settings.usage.tip_tokens'), fmtTokens(meta.tokens));
        return '<div class="usage-heat-tip-date">' + escapeHtml(fmtDateFull(meta.date)) + '</div>'
            + '<div class="usage-heat-tip-rows">' + rows + '</div>';
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

    /* 提示纯文本（无障碍用）：与浮层同内容，拼成一条可朗读的句子。
     * 不能直接把 HTML 塞进 aria-label（会被读成标签），故单独拼一份。 */
    function tipText(meta) {
        meta = meta || {};
        var parts = [fmtDateFull(meta.date)];
        if (meta.tasks !== null && meta.tasks !== undefined && isFinite(Number(meta.tasks))) {
            parts.push(t('settings.usage.tip_tasks') + ' ' + fmtCount(meta.tasks));
        }
        parts.push(t('settings.usage.tip_tokens') + ' ' + fmtTokens(meta.tokens));
        return parts.join(' · ');
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
                // 未来日没有信息可报，但对读屏器不能是“无名字的图形”：显式 aria-hidden。
                grid += '<div class="usage-heat-cell usage-heat-empty" aria-hidden="true"></div>';
                return;
            }
            var lv = 0;
            if (d.tokens > 0 && maxTok > 0) {
                lv = Math.min(4, Math.max(1, Math.ceil(d.tokens / maxTok * 4)));
            }
            // 悬停信息不再写进 title（原生提示框不可样式化，且延迟/字体/暗色主题都不受控）：
            // 只把三要素入 data-* 属性，由 mountTip 的委派监听在悬停时现场拼装浮层。
            // aria-label 仍带完整文案：去掉 title 不能让读屏用户失去信息。
            // role="img" 不可省：裸 div 的 aria-label 虽然能进 AX 树（Chrome 实测 role=generic），
            // 但 generic 容器在多数读屏器里不会被当“有名字的对象”报读；role=img 是
            // “这个盒子本身就是个有名字的图形”的标准语义，且不需要 tabindex（不会给 371 格刷
            // 进 Tab 序列，那会让键盘导航彻底瘫痪）。
            var meta = { date: d.date, tokens: d.tokens, tasks: d.sessions };
            grid += '<div class="usage-heat-cell" role="img" data-level="' + lv
                + '" data-date="' + escapeHtml(d.date)
                + '" data-tokens="' + (Number(d.tokens) || 0)
                + '" data-tasks="' + ((d.sessions === null || d.sessions === undefined) ? '' : (Number(d.sessions) || 0))
                + '" aria-label="' + escapeHtml(tipText(meta))
                + '"></div>';
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

    /* ── 悬停浮层（挂载 / 定位 / 卸载） ────────────────────
     * 为什么不用原生 title：title 的样式、延迟、字体全不受控，也无法承载
     * 「日期一行 + 两列指标」这种结构；暗色主题下白底黑字直接刺眼。
     *
     * 实现要点：
     *  1) 单例 DOM：全局只一个 .usage-heat-tip，挂在 body 下（position:fixed），
     *     避免被卡片 overflow / 层叠上下文裁剪；切格只改内容与坐标，不重建节点。
     *  2) 事件委派：不逐个格绑 listener（371 个格子×2 种事件会造 742 条闭包），
     *     只在挂载根本听 mouseover/focusin，靠 closest 命中格子。
     *  3) mouseover 会随子元素冒泡反复触发：命中同一格时直接 return，不重复排版。
     *  4) 边缘翻转：默认上方，空间不足翻到下方；水平居中后夹在视口内（留 8px 边）。
     *     热力图在卡片顶部时上方只有几十像素，不翻转会被裁掉半个浮层。
     *  5) pointer-events:none（在 CSS 里）—— 浮层悬在鼠标下会触发 mouseout，
     *     一旦进入「弹出→移出→消失→再弹出」的死循环就根本点不到格子。
     *
     * 幂等：同一根重复调用不会重复绑定（dataset 标记）。 */
    var TIP_CLASS = 'usage-heat-tip';
    var TIP_ID = 'usageHeatTip';

    function tipEl(create) {
        var el = document.getElementById(TIP_ID);
        if (!el && create) {
            el = document.createElement('div');
            el.id = TIP_ID;
            el.className = TIP_CLASS;
            el.setAttribute('role', 'tooltip');
            document.body.appendChild(el);
        }
        return el;
    }

    /** 根据格子矩形摆放浮层：上方→下方翻转，水平夹紧在视口内。 */
    function placeTip(el, rect) {
        var GAP = 8;
        var EDGE = 8;
        var vw = window.innerWidth || document.documentElement.clientWidth || 0;
        var vh = window.innerHeight || document.documentElement.clientHeight || 0;
        // 先清掉旧坐标再量：带旧 top/left 的测量会得到上一格的位置（错位闪现）
        el.style.left = '0px';
        el.style.top = '0px';
        var w = el.offsetWidth || 0;
        var h = el.offsetHeight || 0;
        var top = rect.top - h - GAP;
        var flipped = top < EDGE;
        if (flipped) top = rect.top + rect.height + GAP;
        if (top + h > vh - EDGE) top = Math.max(EDGE, vh - h - EDGE);   // 上下都放不下时夹进视口
        var left = rect.left + rect.width / 2 - w / 2;
        if (left < EDGE) left = EDGE;
        if (vw > 0 && left + w > vw - EDGE) left = Math.max(EDGE, vw - w - EDGE);
        el.style.left = Math.round(left) + 'px';
        el.style.top = Math.round(top) + 'px';
        // 小三角指向格子：翻转后三角换到顶部。用 CSS 变量传偏移，避免再算一个元素。
        el.setAttribute('data-placement', flipped ? 'bottom' : 'top');
        var arrowX = rect.left + rect.width / 2 - left;
        arrowX = Math.max(10, Math.min(w - 10, arrowX));
        el.style.setProperty('--tip-arrow-x', Math.round(arrowX) + 'px');
    }

    function showTip(cell) {
        if (!cell || !cell.getAttribute) return;
        var date = cell.getAttribute('data-date');
        if (!date) return;
        var tasksRaw = cell.getAttribute('data-tasks');

        var meta = {
            date: date,
            tokens: Number(cell.getAttribute('data-tokens')) || 0,
            // 空串 = 后端未提供该字段（旧 jar）→ 整行省略，不伪造 0
            tasks: (tasksRaw === null || tasksRaw === '') ? null : (Number(tasksRaw) || 0)
        };
        var el = tipEl(true);
        if (!el) return;
        var html = buildTip(meta);
        if (el._tipFor !== cell || el.innerHTML !== html) {
            el.innerHTML = html;
            el._tipFor = cell;
        }
        el.classList.add('is-visible');
        placeTip(el, cell.getBoundingClientRect());
    }

    /* 从格子的 data-* 重建 aria-label（单独抽出：切语言后需要就地刷新已存在的节点，
     * 不能只靠下一次 renderGrid —— 那会让读屏用户听到旧语言的标签）。 */
    function labelOf(cell) {
        if (!cell || !cell.getAttribute) return '';
        var date = cell.getAttribute('data-date');
        if (!date) return '';
        var tasksRaw = cell.getAttribute('data-tasks');
        return tipText({
            date: date,
            tokens: Number(cell.getAttribute('data-tokens')) || 0,
            tasks: (tasksRaw === null || tasksRaw === '') ? null : (Number(tasksRaw) || 0)
        });
    }

    function hideTip() {
        var el = tipEl(false);
        if (!el) return;
        el.classList.remove('is-visible');
        el._tipFor = null;
    }

    /* 把浮层行为挂到某容器（欢迎卡 / 统计页各自在插入 HTML 后调一次）。
     * 必须传容器而不是全文档：统计页与欢迎页可能同时存在于 DOM（只显一个），
     * 限定在各自根内可避免关掉一个页面后浮层仍然响应隐藏容器的悬停。
     *
     * 为何需要 IntersectionObserver（实测缺陷，非预防性措施）：
     * 开关视图走的是 .usage-view{display:none}（app-settings-usage.js closeUsage），
     * 而 display:none 会让指针下的元素直接消失 —— **mouseleave 永远不会触发**，
     * 于是浮层就带着旧格子的内容停在屏幕上，后续切到聊天/技能页时它依旧漂在那里。
     * mouseleave 只能覆盖“鼠标自己离开”这一种路径，视图隐藏/重渲染都绕过了它。
     * IntersectionObserver 对 display:none 会回调 isIntersecting=false（已实测），
     * 且不会给 371 个格子逐个绑事件（只观察根节点一个）。 */
    function mountTip(root) {
        if (!root || !root.addEventListener || root.dataset.heatTip === '1') return;
        root.dataset.heatTip = '1';
        var cellOf = function (e) {
            var t = e.target;
            if (!t || !t.closest) return null;
            var c = t.closest('.usage-heat-cell[data-date]');
            return (c && root.contains(c)) ? c : null;
        };
        root.addEventListener('mouseover', function (e) { var c = cellOf(e); if (c) showTip(c); });
        root.addEventListener('mouseleave', hideTip);
        // 鼠标在 root 内从格子移到非格子区域（月份轴/图例/空隙）也要收起：
        // 只靠 mouseleave 的话，浮层会挂着一个已经不再悬停的格子的数据（实测缺陷）。
        // mouseover 在非格子处回调时 closest 返回 null → 这里直接收起，比监听 mouseout 便宜。
        root.addEventListener('mouseover', function (e) { if (!cellOf(e)) hideTip(); });
        root.addEventListener('focusin', function (e) { var c = cellOf(e); if (c) showTip(c); });
        root.addEventListener('focusout', hideTip);
        // 滚动/改尺寸时旧坐标就废了：直接收起，比跟随重算便宜且不会错位
        window.addEventListener('scroll', hideTip, true);
        window.addEventListener('resize', hideTip);
        observeVisibility(root);
    }

    /* 根节点不可见（切页/父级 display:none）时立即收起浮层。 */
    function observeVisibility(root) {
        if (typeof IntersectionObserver === 'undefined') return;
        try {
            var io = new IntersectionObserver(function (entries) {
                for (var i = 0; i < entries.length; i++) {
                    if (!entries[i].isIntersecting) hideTip();
                }
            });
            io.observe(root);
            root._heatTipIO = io;
        } catch (e) { /* 观察失败不影响悬停主流程 */ }
    }

    /* 就地重刷已渲染格子的 aria-label（切语言后调用，不重建 DOM）。
     * 为什么不靠下一次 renderGrid：统计页不监听 i18n:localeChanged，
     * 用户切语言后不重新拉数据时，DOM 里还是旧语言的 aria-label；
     * 读屏器读的是 attribute 而不是 innerHTML，只看浮层修不到它。 */
    function refreshLabels(root) {
        if (!root || !root.querySelectorAll) return 0;
        var cells = root.querySelectorAll('.usage-heat-cell[data-date]');
        for (var i = 0; i < cells.length; i++) {
            var label = labelOf(cells[i]);
            if (label) cells[i].setAttribute('aria-label', label);
        }
        return cells.length;
    }

    /* 切语言后调用：正在悬停的浮层文本要立即跟随（否则用户要移开再移回才看到新语言）。
     * 注意不能只调 hideTip：那样浮层直接消失，比显示旧文案更费解。 */
    function refreshVisibleTip() {
        var el = tipEl(false);
        if (!el || !el._tipFor) return;
        var cell = el._tipFor;
        var html = buildTip({
            date: cell.getAttribute('data-date'),
            tokens: Number(cell.getAttribute('data-tokens')) || 0,
            tasks: (function (v) { return (v === null || v === '') ? null : (Number(v) || 0); })(cell.getAttribute('data-tasks'))
        });
        el.innerHTML = html;
        placeTip(el, cell.getBoundingClientRect());
    }

    window.GourdHeatmap = {
        renderGrid: renderGrid,
        mountTip: mountTip,
        hideTip: hideTip,
        refreshLabels: refreshLabels,
        refreshVisibleTip: refreshVisibleTip,
        // 以下仅供契约测试白盒断言（生产不依赖）：
        _buildTip: buildTip,
        _fmtTokens: fmtTokens,
        _fmtCount: fmtCount,
        _fmtDateFull: fmtDateFull
    };
})();
