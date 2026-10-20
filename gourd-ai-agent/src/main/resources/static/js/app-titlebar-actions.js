/* ===== app-titlebar-actions.js =====
   标题栏动作组（终端 / 任务监控两个按钮）：按钮 markup 在 index.html 的 body 级
   fixed 容器 #titlebarActions 内，本文件只负责三件事：
   1) 按平台计算右偏移（避让原生/自绘窗口按钮）；
   2) 终端按钮 ↔ window.toggleCodeTerminal（app-terminal.js）；
   3) 监控按钮 ↔ window.toggleTaskMonitor（app-task-monitor.js）。

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
    function applyRightOffset() {
        var right = 6;
        try {
            var b = document.body;
            if (b.classList.contains('is-electron') && !b.classList.contains('is-mac')) {
                var strip = window.__GOURD_TITLEBAR_STRIP_W__;
                right = (typeof strip === 'number' && strip > 0 ? strip : 138) + 6;
            }
        } catch (e) { /* classList 不可用时退回 CSS 缺省值 */ }
        actions.style.setProperty('--titlebar-actions-right', right + 'px');
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

    if (window.MutationObserver) {
        new MutationObserver(syncButtons).observe(document.body, {
            attributes: true, attributeFilter: ['class']
        });
    } else {
        // 无 MutationObserver 的古老内核：退化为点击后同步（态可能滞后但不报错）
        document.addEventListener('click', syncButtons);
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
})();
