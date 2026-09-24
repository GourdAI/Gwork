/* app-welcome-activity.js — 欢迎页「活跃热力图」卡片
 *
 * 在主工作区（欢迎页）hero 与输入框之间展示一块紧凑态活跃热力图（与「使用统计」同口径）：
 * 固定 53 周窗口（≈一年，由 year:true 在前端补齐，不受后端 jar 新旧影响）、按日 Token 着色、
 * 悬停显示「日期：Token 数 · 轮次」；
 * 紧凑态三件套：无标题/无图例（legend:false）、底部月份时间轴（months:true）、
 * 窗口补齐一年（year:true）；网格 1fr 拉伸铺满卡片（与输入框同宽），视觉重心仍让给输入框。
 *
 * 数据来源与使用统计页完全一致：GET /web/chat/usage/stats（全局聚合，无额外埋点）。
 * 刷新时机：① 后端就绪且语言包就绪后首次加载；② 每次回到欢迎页
 * （switchToWelcomeMode 调用 window.refreshWelcomeActivity）。
 * 失败静默：首屏失败整卡隐藏；已有上次成功内容时保留旧图不擦除——欢迎页是发消息的
 * 地方，一个辅助可视化不应打断主流程。
 *
 * 渲染复用 app-heatmap.js 的 window.GourdHeatmap.renderGrid（同一份实现，
 * 避免「复制两份、日后只改一处」的分叉）。
 */
(function () {
    'use strict';

    var CARD_ID = 'welcomeActivityCard';
    var BODY_ID = 'welcomeActivityBody';
    var loadSerial = 0;
    var pendingRequest = null;
    var lastSuccess = false;   // 曾成功渲染过网格（含全零隐藏态），用于失败时决定「保留旧图」还是「整卡隐藏」

    function cardEl() { return document.getElementById(CARD_ID); }
    function bodyEl() { return document.getElementById(BODY_ID); }

    function setVisible(visible) {
        var el = cardEl();
        if (el) el.style.display = visible ? '' : 'none';
    }

    function renderError() {
        if (lastSuccess) return;   // 已有成功内容：保留旧图（本次失败静默）
        setVisible(false);
    }

    function renderData(data) {
        var body = bodyEl();
        if (!body) return;
        var heatmap = (data && data.heatmap) || [];
        if (!heatmap.length || !window.GourdHeatmap || typeof window.GourdHeatmap.renderGrid !== 'function') {
            setVisible(false);
            return;
        }
        // 窗口内全零（全新用户）：整卡隐藏，避免空网格占位
        var hasAny = false;
        for (var i = 0; i < heatmap.length; i++) {
            if (!heatmap[i].future && heatmap[i].tokens > 0) { hasAny = true; break; }
        }
        lastSuccess = true;
        if (!hasAny) {
            setVisible(false);
            return;
        }
        // legend:false：欢迎页不展示「少→多」图例（明细由悬停提示承载）；
        // months:true：底部月份时间轴（用户点名要）；网格 1fr 拉伸铺满卡片——
        // 卡片与输入框同宽（max-width 680px），两边缘对齐才协调，格宽也随宽度自然放大。
        // year:true：把后端窗口补齐到一年（53 周）——运行中的桌面 jar 可能仍是旧构建
        // （26 周），不补齐月份轴就只有 7 个标签；补齐后稳定 12+ 个月，后端重建为 53 周后幂等。
        body.innerHTML = window.GourdHeatmap.renderGrid(heatmap, { legend: false, months: true, year: true });
        setVisible(true);
    }

    function load() {
        var body = bodyEl();
        if (!body) return;
        var requestSerial = ++loadSerial;
        if (pendingRequest && typeof pendingRequest.abort === 'function') {
            pendingRequest.abort();
        }
        // 首屏期间卡片保持 HTML 初始的 display:none，成功拿到有数据的结果后再显示，
        // 避免“加载中 → 内容”的闪烁；已有内容时同样保留旧图直到新数据到达。
        pendingRequest = $.ajax({
            url: '/web/chat/usage/stats?days=30',
            method: 'GET',
            dataType: 'json'
        }).done(function (resp) {
            if (requestSerial !== loadSerial) return;
            if (resp && resp.code === 200 && resp.data) {
                renderData(resp.data);
            } else {
                renderError();
            }
        }).fail(function (jqXHR, textStatus) {
            if (requestSerial !== loadSerial || textStatus === 'abort') return;
            renderError();
        }).always(function () {
            if (requestSerial === loadSerial) pendingRequest = null;
        });
    }

    /* 回到欢迎页时刷新（会话数据可能刚变过）；首次由下方就绪回调触发。 */
    window.refreshWelcomeActivity = function () {
        if (!cardEl()) return;   // 片段未就位（异常装配）时静默
        load();
    };

    /* 首次加载：等「后端就绪」（桌面端冷启动期 /web/** 会被代理挂起）+「语言包就绪」
     * （悬停提示与图例文案需要 t()）双条件。语言包先于后端就绪时，后到的条件触发。 */
    function initialLoad() {
        if (window.GourdI18n && typeof window.GourdI18n.whenReady === 'function') {
            window.GourdI18n.whenReady(function () { load(); });
        } else {
            load();
        }
    }
    var boot = window.__whenBackendReady;
    if (typeof boot === 'function') boot(initialLoad);
    else initialLoad();

    // 语言切换后重渲染（图例文案与悬停提示跟随 i18n；仅当卡片当前可见时才值得重拉）
    document.addEventListener('i18n:localeChanged', function () {
        if (cardEl() && cardEl().style.display !== 'none') load();
    });
})();
