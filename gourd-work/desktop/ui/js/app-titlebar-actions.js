/* ===== app-titlebar-actions.js =====
   标题栏动作组（终端 / 任务监控两个按钮）：按钮 markup 在 index.html 的 body 级
   fixed 容器 #titlebarActions 内，本文件负责四件事：
   1) 按平台计算右偏移（避让原生/自绘窗口按钮）；
   2) 给 .titlebar-drag-region 算右侧让位（避让窗控【和这组按钮自己】）；
   3) 终端按钮 ↔ window.toggleCodeTerminal（app-terminal.js）；
   4) 监控按钮 ↔ window.toggleTaskMonitor（app-task-monitor.js）。

   按钮高亮态不靠点击事件自维护，而是观察 body 类（terminal-open /
   task-monitor-open）：面板还可能被面板内关闭钮、Esc、窄屏规则等路径关掉，
   以 body 类为唯一真源才能保证按钮态与面板态永不脱节。 */
(function () {
    'use strict';

    var actions = document.getElementById('titlebarActions');
    var termBtn = document.getElementById('titlebarTerminalBtn');
    var monitorBtn = document.getElementById('titlebarMonitorBtn');
    if (!actions) return; // index.html 骨架缺失时静默降级（与 app-terminal.js 同纪律）

    // ---------- 右偏移：避让窗口按钮 ----------
    /* 顶行右端被窗口控件占据，宽度按壳分流：
       - Tauri（Win/Linux）：自绘控件条总宽由注入脚本暴露为
         window.__GOURD_TITLEBAR_STRIP_W__（3×30 + 2×2 gap + 2×4 padding = 102），
         按钮与左侧动作组同款 chip（titlebar_ui.rs）；
       - Electron（Win/Linux）：原生 titleBarOverlay 不可覆盖、无横向预留，
         固定 3×46=138；注入变量不存在时同样退回 138 兜底；
       - mac：红绿灯在左上角，右侧无控件；
       - 浏览器直连：无窗口按钮。
       Tauri 与 Electron 复用同一 is-electron 类（ipc_bridge.rs 对齐），故只需再判 is-mac。
       +6px 为两组控件之间的视觉间距。 */
    function currentStripW() {
        try {
            var b = document.body;
            if (b.classList.contains('is-electron') && !b.classList.contains('is-mac')) {
                var strip = window.__GOURD_TITLEBAR_STRIP_W__;
                return (typeof strip === 'number' && strip > 0 ? strip : 138);
            }
        } catch (e) { /* classList 不可用：当无窗控处理 */ }
        return 0; // mac 红绿灯在左上角 / 浏览器直连：右侧无窗控
    }

    function applyRightOffset() {
        var stripW = currentStripW();
        actions.style.setProperty('--titlebar-actions-right', (stripW + 6) + 'px');
        applyDragRegionReserve(stripW);
    }

    /* ---------- 拖拽条右侧让位 ----------
       WHY 必须由 JS 算、CSS 写不死：标题（.titlebar-task）现在是 flex:1 铺满
       .titlebar-drag-region，铺到哪儿为止取决于「谁正压在拖拽条右端上方」，
       有两个来源且都会变：
       - 窗控（Tauri 自绘 102 / Electron 原生 overlay 138 / mac 0）；
       - 本动作组自己：body 级 fixed，宽 = 实测 offsetWidth（窄屏 @media 会把
         gap/padding 压缩，宽度随之变）。原先【没有任何人为它让位】——标题一旦
         铺满就会钻到终端/监控按钮底下，文字压在图标上——这是修 max-width 时
         必须同时补的缺口，否则等于把「太短」换成「重叠」。
       还要考虑任务监控右栏：它打开时 .main-area 内缩 --task-monitor-width，
       拖拽条右边界随之内缩，此时窗控与动作组都落在拖拽条【范围之外】（浮在抽屉
       上方），反而不需要让位——所以让位 = 拖拽条右边界 − min(动作组左边界,
       窗控左边界)，取不到正值就归零。
       用内联 style 写：优先级高于 titlebar_ui.rs 注入的
       body.__gourd_has_controls .titlebar-drag-region{padding-right:STRIP_W}，
       正好把那份「只算窗控」的静态值升级成「窗控 + 按钮」的动态值。 */
    var RESERVE_GAP = 8; // 标题省略号与右侧控件之间的呼吸间距
    function applyDragRegionReserve(stripW) {
        var region = document.querySelector('.titlebar-drag-region');
        if (!region) return;
        // 读布局必须在 --titlebar-actions-right 生效之后，否则量到旧位置
        var measure = function () {
            try {
                var rr = region.getBoundingClientRect();
                var ar = actions.getBoundingClientRect();
                var limit = Math.min(ar.left, window.innerWidth - stripW);
                var pad = rr.right > limit ? Math.ceil(rr.right - limit) + RESERVE_GAP : 0;
                var next = pad + 'px';
                if (region.style.paddingRight !== next) region.style.paddingRight = next;
            } catch (e) { /* 布局不可用时保持原值，不抛给调用方 */ }
        };
        if (window.requestAnimationFrame) window.requestAnimationFrame(measure);
        else measure();
    }

    // ---------- 按钮态同步（body 类为唯一真源）----------
    function syncButtons() {
        var b = document.body;
        var termOpen = b.classList.contains('terminal-open');
        var monOpen = b.classList.contains('task-monitor-open');
        if (termBtn) {
            termBtn.classList.toggle('active', termOpen);
            termBtn.setAttribute('aria-pressed', termOpen ? 'true' : 'false');
        }
        if (monitorBtn) {
            monitorBtn.classList.toggle('active', monOpen);
            monitorBtn.setAttribute('aria-expanded', monOpen ? 'true' : 'false');
        }
    }

    /* body 类变化会改变拖拽条右边界（task-monitor-open 让 .main-area 内缩
       --task-monitor-width），所以让位宽要跟着重算——与按钮态同步共用同一个
       观察器，不新增事件源。 */
    function syncAll() { syncButtons(); applyRightOffset(); }

    if (window.MutationObserver) {
        new MutationObserver(syncAll).observe(document.body, {
            attributes: true, attributeFilter: ['class']
        });
    } else {
        // 无 MutationObserver 的古老内核：退化为点击后同步（态可能滞后但不报错）
        document.addEventListener('click', syncAll);
    }

    // ---------- 点击 ----------
    if (termBtn) {
        termBtn.addEventListener('click', function () {
            if (typeof window.toggleCodeTerminal === 'function') window.toggleCodeTerminal();
            syncButtons();
        });
    }
    if (monitorBtn) {
        monitorBtn.addEventListener('click', function () {
            if (typeof window.toggleTaskMonitor === 'function') window.toggleTaskMonitor();
            syncButtons();
        });
    }

    applyRightOffset();
    syncButtons();
    // 桌面壳的平台类由 preload / init_script 注入，理论上早于本脚本；
    // 再在 load 时补算一次，兜住「类异步补打」的壳实现。
    window.addEventListener('load', applyRightOffset);
    // 窗口尺寸变化会同时改变拖拽条宽与（窄屏媒体查询下的）按钮组宽，必须重算让位
    window.addEventListener('resize', applyRightOffset);
})();
