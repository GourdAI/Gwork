/* ===== app-update-badge.js =====
   桌面端侧边栏底部「更新」按钮：把自动更新状态机（updater.rs / Electron 版
   main/updater.js）的最新快照，映射成底栏上一个常驻、可直接操作的建议。

   ── 为什么需要它 ────────────────────────────────────────────────────────────
   改造前，发现新版只在「设置 → 关于」页面里有入口；启动时那条 toast 一闪而过，
   错过就得自己摸进设置页。应用常驻托盘、一开就是几小时，新版提示等于没提示。
   本模块把同一份状态搬到侧边栏底部：有新版就一直挂着，点一下就地完成
   下载 → 安装 → 重启，不必再进设置页。

   ── 只在需要的条件下显示 ────────────────────────────────────────────────────
   浏览器端（无 __GOURD_IPC__）、开发态（mode='none'）、以及无新版时一律不占位：
   按钮默认 display:none，只有 shouldShow() 判定为真才补 .is-visible。因此这三类
   场景下底栏观感与改造前完全一致（见 app.css .sidebar-update-btn）。

   ── 点击行为复用后端平台分流（不在前端重复判定平台）────────────────────────
   auto（Windows NSIS / Linux AppImage）：available → updater_download 起下载，
   下完（downloaded）再 updater_install 装并重启。notify（macOS / Linux deb）：
   两个命令在后端都会退回「打开官方下载页」。前端只按状态决定调哪个命令。
   notify 模式后端不自动下载，故 available 态点「下载」走下载页，与设置页语义一致。

   ── 纯函数与 DOM 解耦 ───────────────────────────────────────────────────────
   viewFor / shouldShow / downloadLabel 是纯函数，不碰 DOM，可被契约测试
   （src/test/js/sidebar-update-badge.test.js）直接驱动；渲染与事件是它们薄壳。
*/
(function () {
    'use strict';

    var ipc = window.__GOURD_IPC__ || null;
    var isDesktop = !!(ipc && ipc.isDesktop);

    function t(key, args) { return window.GourdI18n ? GourdI18n.t(key, args) : key; }

    /* ── 纯函数：状态 → 视图描述 ─────────────────────────────────────────────
       返回 null 表示「不显示」。status 语义见 updater.rs 顶部状态机注释：
       idle | checking | available | not-available | downloading | downloaded | error
       mode 缺失/未知一律 fail-closed（不显一个动作语义未知的按钮）。 */
    function viewFor(st) {
        if (!st || !st.mode || st.mode === 'none') return null;
        var v = String(st.version || '');
        switch (st.status) {
            case 'available':
                return { state: 'available', label: availableLabel(st), showDot: true, percent: null,
                    tipKey: 'app.sidebar.update_tooltip', tipArgs: [v] };
            case 'downloading':
                return {
                    state: 'downloading',
                    label: downloadLabel(st),
                    showDot: true,
                    // 后端 total=0 时 percent 恒 0（无 Content-Length），不显示具体百分比
                    percent: st.progress && st.progress.total > 0
                        ? clampPercent(st.progress.percent)
                        : null,
                    tipKey: 'app.sidebar.update_tooltip_downloading', tipArgs: [v]
                };
            case 'downloaded':
                return { state: 'downloaded', label: t('app.sidebar.update_install'), showDot: false, percent: null,
                    tipKey: 'app.sidebar.update_tooltip_downloaded', tipArgs: [v] };
            default:
                // idle / checking / not-available / error：不打扰，设置页里仍可手动检查
                return null;
        }
    }

    /* available 文案：auto 模式下载即将/正在后台开始，用「立即更新」引导点击；
       notify 模式点击是打开下载页，动词用「下载更新」更准确。 */
    function availableLabel(st) {
        return st.mode === 'notify'
            ? t('app.sidebar.update_download')
            : t('app.sidebar.update_now');
    }

    /* 下载中文案：有总大小就只给百分比——数字语言中立，可避开德语/俄语这类
       「Wird heruntergeladen… 42.5%」在 280px 侧栏里撞破底栏的截断；完整说明
       放到 title。无总大小（后端无 Content-Length，percent 恒 0）才退回短词，
       此时给数字会画成「0.0%」的假静止。 */
    function downloadLabel(st) {
        var p = st && st.progress;
        if (p && p.total > 0) {
            return clampPercent(p.percent).toFixed(1) + '%';
        }
        return t('app.sidebar.update_downloading');
    }

    function clampPercent(n) {
        n = Number(n);
        if (!isFinite(n)) return 0;
        return Math.max(0, Math.min(100, n));
    }

    /* 仅桌面端且后端插件可用时才可能显示（浏览器端整块逻辑其实不会挂载，
       这里再兜一层，供测试与误加载场景使用）。 */
    function shouldShow(st) {
        return isDesktop && viewFor(st) !== null;
    }

    /* ── 渲染薄壳 ───────────────────────────────────────────────────────────
       只更新按钮自身（文案/状态类/角标显隐），底栏其它元素零改动。
       最近一次快照保存在闭包变量 lastState（经 getLastState 读回），供
       「拿不到新快照」的重渲染场景（如语言切换）复用。 */
    function mount() {
        var btn = document.getElementById('sidebarUpdateBtn');
        if (!btn) return null;
        var labelEl = btn.querySelector('.sidebar-update-btn-label');
        var current = null;
        var lastState = null;

        function render(st) {
            if (st) lastState = st;
            var view = viewFor(lastState);
            current = view;
            if (!view) {
                btn.classList.remove('is-visible');
                btn.removeAttribute('data-state');
                if (labelEl) labelEl.textContent = '';
                btn.style.removeProperty('--gwork-update-pct');
                return;
            }
            btn.classList.add('is-visible');
            btn.setAttribute('data-state', view.state);
            btn.setAttribute('title', t(view.tipKey, view.tipArgs));
            if (labelEl) labelEl.textContent = view.label;
            if (view.percent !== null) {
                btn.style.setProperty('--gwork-update-pct', view.percent + '%');
            } else {
                btn.style.removeProperty('--gwork-update-pct');
            }
        }

        btn.addEventListener('click', function () {
            if (!ipc || !current) return;
            if (current.state === 'downloaded') {
                if (typeof ipc.updaterInstall !== 'function') return;
                Promise.resolve(ipc.updaterInstall()).then(render)['catch'](function () { /* 保留当前视图 */ });
                return;
            }
            // available / downloading → 交给下载动作（auto 起下载，notify 打开下载页）
            if (typeof ipc.updaterDownload !== 'function') return;
            Promise.resolve(ipc.updaterDownload()).then(render)['catch'](function () { /* ignore */ });
        });

        return { render: render, getLastState: function () { return lastState; } };
    }

    /* ── 入口 ───────────────────────────────────────────────────────────────
       onUpdaterState 支持多监听器且会重放最近一次快照（见 ipc_bridge.js 的
       REPLAY 表），因此无论「事件早于加载」还是「加载早于事件」都能拿到状态；
       updaterGetState 作为兜底主动拉一次。开发态/浏览器端不注册，零副作用。 */
    var ui = null;

    function init() {
        if (!isDesktop) return;
        ui = mount();
        if (!ui) return;
        if (typeof ipc.onUpdaterState === 'function') {
            ipc.onUpdaterState(ui.render);
        }
        if (typeof ipc.updaterGetState === 'function') {
            Promise.resolve(ipc.updaterGetState()).then(ui.render)['catch'](function () { /* ignore */ });
        }
    }

    // 语言切换后按上一次快照重渲染，使按钮文案随 locale 更新
    // （文案是 textContent 直赋、不走 data-i18n，translateDOM 无法自动刷新）。
    document.addEventListener('i18n:localeChanged', function () {
        if (ui && ui.getLastState()) ui.render(null);
    });

    // 暴露纯函数与最近快照供契约测试与调试使用（不影响运行期行为）
    window.__gworkUpdateBadgeApi = {
        viewFor: viewFor,
        shouldShow: shouldShow,
        availableLabel: availableLabel,
        downloadLabel: downloadLabel,
        clampPercent: clampPercent,
        _ui: function () { return ui; }
    };

    // DOM 就绪即初始化：本脚本在 app-bootstrap 的 APP_SCRIPTS 阶段执行，
    // 外壳（含按钮）此时已在文档流中（片段注入只动 .main-area / body 级挂载点）。
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
