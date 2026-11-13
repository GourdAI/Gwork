/* ===== app-account.js =====
    桌面端账号入口：侧栏底栏（原「设置按钮」区域）整体为用户卡片 +
    就地向上展开的账号弹层 + 【独立居中登录弹框】三件套。

    参照设计稿（用户 11-09 提供并二次确认）：
      - 底栏区域 = 用户卡片：未登录显示「登录」，已登录显示头像 + 昵称 + 套餐；
      - 点击卡片向上展开弹层，内容是【设置 + 用户相关】菜单：
          已登录 = 用户信息面板（头像/昵称/套餐/积分 + 设置、外观系统/浅/深、
                  记忆与进化、意见反馈、检查更新、退出登录）；
          未登录 = 登录入口行 + 设置菜单（设置、外观系统/浅/深、检查更新、意见反馈）；
    - 登录表单是【独立居中弹框】（.account-modal，半透明遮罩 + 居中），
        绝不塞进账号弹层里（用户明确否决过弹层内嵌表单的方案）。

    凭据与会话保活全部在 Rust 侧（auth.rs）：本页面只调用
    window.__GOURD_IPC__.auth*，绝不接触 access token / refresh cookie。

    【关键修复：点击没弹框 —— 两个叠加原因，别再只修一个】
    ① 主因（真实桌面壳命中的就是这条）：旧版 CSS
       `.account-overlay { display: none; ... }`，而旧版 show() 用
       `overlay.style.display = ''` 清空内联来「显示」。清空内联后元素回落到
       类规则 `display:none` —— 弹层永远不可见，点下去像没反应。注意
       __GOURD_IPC__ 由 src-tauri/lib.rs 的 initialization_script 注入，真实
       壳里必然存在，所以「无 IPC」并不是用户当时遇到的场景。
       现在 show()/showAuthModal() 显式写 `style.display = 'block'`：内联显式值
       优先于任何类默认值，即使日后有人把 `display:none` 加回 CSS 类也不会复现。
       account-entry-behavior.test.js / account-contract.test.js 双向锁死此契约。
    ② 次因（边缘场景）：旧版第 13 行
       `if (!ipc || typeof ipc.authStatus !== 'function') return;`
       让无 IPC 时连 onclick 都不绑定（浏览器直连、IPC 注入未就绪等命中）。
       现在 UI 层与后端能力解耦：入口恒绑定、弹层/弹框恒可开，只在真正发登录 /
       登出请求时检查能力，缺能力给明确文案，绝不静默失败。

    【布局纪律】用户卡片是 .sidebar-footer 的【首子项】（原设置按钮的位置），
    更新按钮是末子项。底栏 justify-content:space-between 下首子项恒贴左端、
    末子项恒贴右端，卡片位置不随「有无更新」跳变 —— 与原设置按钮同一纪律，
    由 account-contract.test.js 锁定。独立设置按钮已删除，设置入口在弹层里。

    ES5：与其余 app-*.js 保持一致。 */
(function () {
    'use strict';

    /* 意见反馈 / 官网入口：与 app-settings-about.js 的 HOMEPAGE_URL 同源。
       不臆造不存在的 /feedback 路由；外链靠壳层 external_link.rs 的
       on_new_window 拦截交给系统浏览器（target="_blank" 本身在 wry 下不够）。 */
    var HOMEPAGE_URL = 'https://www.gourdwork.com/';

    function t(key, fallback) {
        var msg = window.GourdI18n ? window.GourdI18n.t(key) : key;
        return (msg && msg !== key) ? msg : (fallback || key);
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function ipc() { return window.__GOURD_IPC__ || null; }
    function hasAuth() { var i = ipc(); return !!(i && typeof i.authStatus === 'function'); }

    var state = {
        signed_in: false, username: '', display_name: '',
        plan: '', points: '', avatar_url: ''
    };
    var selfLoaded = false;
    var entry = null;
    var backdrop = null;
    var popover = null;
    var modalBackdrop = null;
    var modal = null;
    var view = null;            // 'profile' | 'menu'，决定弹层当前渲染的骨架
    var authMode = 'login';     // 'login' | 'register'
    var busy = false;
    /* 后台能力探测结果（GET /api/status 的 email_verification）。null = 未探测/
       探测失败：注册表单按「邮箱可选」降级渲染，后台的真实拒绝会原样回显。 */
    var emailRequired = null;
    var codeSentOnce = false;   // 本次会话是否已发过验证码（按钮切「重新发送」）

    /* 提示容器 id：弹层与登录弹框【各持一个，绝不共用同 id】。
       【codereview P2 修复】此前两个视图都写 id="accountHint"：DOM 里同时存在
       两个同 id 节点时 getElementById 只返回先插入的那个（弹层先于弹框挂载），
       登录弹框打开期间 submit 失败提示会写进【已被隐藏的弹层节点】——弹框里
       看不到任何文案，正是「点了没反应」的同族静默失败。 */
    var HINT_POP = 'accountPopHint';
    var HINT_MODAL = 'accountModalHint';

    /* ---------- 通用 DOM 小工具 ---------- */

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = String(text);
        return n;
    }

    function avatarInitial(name) {
        var s = String(name || '').trim();
        return s ? s.charAt(0).toUpperCase() : 'G';
    }

    /* 有真实头像 URL 就渲染 <img>，加载失败退回昵称首字，绝不显示破图。 */
    function renderAvatar(node, url, name) {
        if (!node) return;
        node.innerHTML = '';
        if (url) {
            var img = document.createElement('img');
            img.src = url;
            img.alt = '';
            img.onerror = function () { node.textContent = avatarInitial(name); };
            node.appendChild(img);
        } else {
            node.textContent = avatarInitial(name);
        }
    }

    function isOpen() { return !!(popover && popover.style.display !== 'none'); }
    function isModalOpen() { return !!(modal && modal.style.display !== 'none'); }

    /* ---------- 触发卡片（侧栏底栏首子项） ---------- */

    function renderCard() {
        var name = document.getElementById('accountEntryName');
        var sub = document.getElementById('accountCardSub');
        var card = document.getElementById('accountEntryBtn');
        var display = state.display_name || state.username || '';

        if (name) {
            if (state.signed_in) {
                name.textContent = display || t('account.signed_in', '已登录');
                name.removeAttribute('data-i18n');
            } else {
                /* 入口行只说「登录」：注册在登录弹框内以 tab 形式提供，
                   卡片/弹层文案不再出现「注册」字样（用户 11-xx 要求）。 */
                name.textContent = t('account.entry', '登录');
                name.setAttribute('data-i18n', 'account.entry');
            }
        }
        if (sub) sub.textContent = state.signed_in ? (state.plan || '') : '';
        if (card) {
            if (state.signed_in) card.classList.add('is-signed-in');
            else card.classList.remove('is-signed-in');
        }
        renderAvatar(document.getElementById('accountCardAvatar'), state.avatar_url, display);
    }

    /* ---------- 事件委托（弹层与登录弹框共用） ----------
       图标是 <svg>/<path> 时向上找带 data-act / data-mode 的祖先。 */
    function delegate(root) {
        return function (e) {
            var node = e.target;
            while (node && node !== root) {
                if (node.getAttribute) {
                    var mode = node.getAttribute('data-mode');
                    if (mode) { onTheme(mode); return; }
                    var act = node.getAttribute('data-act');
                    if (act) { onAction(act); return; }
                }
                node = node.parentNode;
            }
        };
    }

    /* ---------- 账号弹层（设置 + 用户相关） ---------- */

    function ensurePopover() {
        if (popover) return;
        backdrop = el('div', 'account-backdrop');
        backdrop.style.display = 'none';
        backdrop.onclick = hide;

        popover = el('div', 'account-popover');
        popover.id = 'accountPopover';
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-label', t('account.entry', '登录'));
        popover.style.display = 'none';
        popover.onclick = delegate(popover);

        document.body.appendChild(backdrop);
        document.body.appendChild(popover);
    }

    /* 就地定位：优先贴卡片上方；上方空间不足时落到下方。
       【宽度纪律】弹层宽度与触发它的用户卡片【等宽】（左缘对齐卡片左缘），
       视觉上像从卡片长出来的，不再比卡片宽出一截（用户报障「弹层太宽」：
       旧版 +24px 且夹在 280–340，比 252px 的卡片明显更宽）。
       夹在 240–300px：窄侧栏不至于把弹层挤成一条，宽侧栏也不至于摊成大面板。 */
    function position() {
        if (!entry || !popover) return;
        var r = entry.getBoundingClientRect();
        var vw = window.innerWidth || 1024;
        var vh = window.innerHeight || 768;
        popover.style.width = Math.max(240, Math.min(300, Math.round(r.width))) + 'px';
        var w = popover.offsetWidth;
        var h = popover.offsetHeight;
        var left = Math.min(Math.max(8, r.left), Math.max(8, vw - w - 8));
        var top = r.top - h - 8;
        if (top < 8) top = Math.min(r.bottom + 8, vh - h - 8);
        popover.style.left = left + 'px';
        popover.style.top = Math.max(8, top) + 'px';
    }

    function icon(paths) {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
    }

    var ICON_GEAR = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l-.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.83 1.83 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>';
    var ICON_THEME = '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z"/>';
    var ICON_MEMORY = '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>';
    var ICON_FEEDBACK = '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4"/><path d="M12 17h.01"/>';
    var ICON_UPDATE = '<circle cx="12" cy="12" r="9"/><polyline points="12 16 12 8"/><polyline points="8 12 12 8 16 12"/>';
    var ICON_LOGOUT = '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>';
    var ICON_LOGIN = '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>';

    function menuItem(act, key, fallback, paths, danger) {
        return '<button class="account-pop-item' + (danger ? ' is-danger' : '') + '" type="button" data-act="' + act + '">'
            + icon(paths) + '<span class="account-pop-item-label">' + esc(t(key, fallback)) + '</span></button>';
    }

    /* 外观分段控件（系统 / 浅色 / 深色），与设置页共用 __themeApi；
       已登录信息面板与未登录设置菜单都带这一行。
       三档与设置页外观 tab 的 system|light|dark 完全同源（app-ui.js 主题引擎
       原生支持 system：跟随 OS 明暗），弹层不再只提供浅/深两档。 */
    function themeRow() {
        return '<div class="account-pop-item account-pop-item-theme">' + icon(ICON_THEME)
            + '<span class="account-pop-item-label">' + esc(t('settings.tabs.appearance', '外观')) + '</span>'
            + '<span class="account-theme-switch">'
            + '<button class="account-theme-btn" type="button" data-mode="system" id="accountThemeSystem">' + esc(t('settings.appearance.mode.system', '系统')) + '</button>'
            + '<button class="account-theme-btn" type="button" data-mode="light" id="accountThemeLight">' + esc(t('settings.appearance.mode.light', '浅色')) + '</button>'
            + '<button class="account-theme-btn" type="button" data-mode="dark" id="accountThemeDark">' + esc(t('settings.appearance.mode.dark', '深色')) + '</button>'
            + '</span></div>';
    }

    /* 视图 A：已登录用户信息面板（弹层） */
    function renderProfile() {
        var h = '';
        h += '<div class="account-pop-profile">'
            + '<div class="account-pop-avatar" id="accountPopAvatar"></div>'
            + '<div style="flex:1 1 auto;min-width:0">'
            + '<div class="account-pop-name" id="accountPopName"></div>'
            + '<div class="account-pop-desc" id="accountPopDesc"></div>'
            + '</div></div>';
        h += '<div class="account-pop-stats">'
            + '<div><div class="account-pop-stat-label">' + esc(t('account.plan', '套餐')) + '</div>'
            + '<div class="account-pop-stat-value" id="accountPopPlan">—</div></div>'
            + '<div><div class="account-pop-stat-label">' + esc(t('account.points', '积分余额')) + '</div>'
            + '<div class="account-pop-stat-value" id="accountPopPoints">—</div></div>'
            + '</div>';
        h += '<div class="account-pop-menu">';
        h += menuItem('settings', 'settings.title', '设置', ICON_GEAR);
        h += themeRow();
        h += menuItem('memory', 'account.memory', '记忆与进化', ICON_MEMORY);
        h += menuItem('feedback', 'account.feedback', '意见反馈', ICON_FEEDBACK);
        h += menuItem('update', 'settings.about.check_update', '检查更新', ICON_UPDATE);
        h += '<div class="account-pop-sep"></div>';
        h += menuItem('logout', 'account.sign_out', '退出登录', ICON_LOGOUT, true);
        h += '</div>';
        /* 【P1 静默失败修复】profile 视图必须带 hint 容器：登出失败或
           后端能力缺失时 setHint()/unavailable() 靠 getElementById 找它，
           少了这个节点错误会被完全吞掉（弹层还开着，用户以为按钮坏了，
           与「点击没反应」是同一类问题）。
           【P2】id 用 HINT_POP，与登录弹框的 HINT_MODAL 区分，杜绝同 id 双节点。 */
        h += '<div class="account-hint" id="' + HINT_POP + '"></div>';
        popover.innerHTML = h;
    }

    /* 视图 B：未登录设置菜单（弹层）—— 设置 + 用户相关（登录入口行）。
       登录表单不在这里，点「登录」行打开独立居中弹框。 */
    function renderMenu() {
        var h = '<div class="account-pop-menu">';
        h += menuItem('login', 'account.entry', '登录', ICON_LOGIN);
        h += '<div class="account-pop-sep"></div>';
        h += menuItem('settings', 'settings.title', '设置', ICON_GEAR);
        h += themeRow();
        h += menuItem('update', 'settings.about.check_update', '检查更新', ICON_UPDATE);
        h += menuItem('feedback', 'account.feedback', '意见反馈', ICON_FEEDBACK);
        h += '</div>';
        popover.innerHTML = h;
        refreshThemeBtns();
    }

    /* 只刷新动态文本，不动输入框 —— 60s 保活刷新不会清掉用户正在输入的内容。 */
    function refreshProfile() {
        var display = state.display_name || state.username || t('account.signed_in', '已登录');
        var n = document.getElementById('accountPopName');
        var d = document.getElementById('accountPopDesc');
        var plan = document.getElementById('accountPopPlan');
        var pts = document.getElementById('accountPopPoints');
        if (n) n.textContent = display;
        if (d) d.textContent = state.username && state.username !== display ? state.username : (state.plan || '');
        if (plan) plan.textContent = state.plan || '—';
        if (pts) pts.textContent = state.points || '—';
        renderAvatar(document.getElementById('accountPopAvatar'), state.avatar_url, display);
        refreshThemeBtns();
    }

    function refreshThemeBtns() {
        var api = window.__themeApi;
        var mode = api && typeof api.getThemeMode === 'function' ? api.getThemeMode() : null;
        if (!mode) mode = document.body && document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        /* 三档（system/light/dark）：active 只挂在【模式】上，不按解析后的明暗
           反推 —— 否则 system 模式下浅色/深色两档会同时「看起来选中」。 */
        var modes = ['system', 'light', 'dark'];
        for (var i = 0; i < modes.length; i++) {
            var b = document.getElementById('accountTheme' + modes[i].charAt(0).toUpperCase() + modes[i].slice(1));
            if (!b) continue;
            if (mode === modes[i]) b.classList.add('active');
            else b.classList.remove('active');
        }
    }

    function refreshView() {
        if (view === 'profile') refreshProfile();
    }

    /* ---------- 独立居中登录弹框 ---------- */

    function ensureModal() {
        if (modal) return;
        modalBackdrop = el('div', 'account-modal-backdrop');
        modalBackdrop.style.display = 'none';
        modalBackdrop.onclick = hideModal;

        modal = el('div', 'account-modal');
        modal.id = 'accountModal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-label', t('account.entry', '登录'));
        modal.style.display = 'none';
        modal.onclick = delegate(modal);

        document.body.appendChild(modalBackdrop);
        document.body.appendChild(modal);
    }

    /* 登录弹框视觉（参照 Qoder 官网登录页）：【左右分栏】——左品牌视觉区
       （手写体标语 + 漂浮图标插画 + 视觉署名），右表单区（品牌标 + 动态主标题
       + 分段式登录/注册切换 + 表单 + 单一主操作按钮）。窄屏（<680px）左栏由
       CSS 隐藏，回落为单列表单，功能不受影响。
       【关闭按钮挤占修复】旧版 .account-close 浮在右上角、tabs 行又用 margin-right
       硬给它让位，导致「登录/注册」分段被挤偏、视觉重心失衡。现改为：关闭按钮
       绝对定位在弹框右上角、不占据内容流；tabs 居中且不再预留右侧空间。
       品牌名 GWork 与侧栏 .sidebar-logo-text 同源（产品名，不随语言翻译）。
       插画全部为内联 SVG（无外链资源、离线可用、随主题变量换色）。 */
    function renderAuth() {
        var h = '<div class="account-auth">';
        h += '<button class="account-close" type="button" data-act="close-modal" aria-label="' + esc(t('account.close', '关闭')) + '">'
            + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">'
            + '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';
        /* 左：品牌视觉区。标语走 i18n（account.auth_slogan），插画纯装饰 aria-hidden。 */
        h += '<div class="account-auth-visual" aria-hidden="true">';
        h += '<div class="account-auth-slogan" id="accountAuthSlogan"></div>';
        h += '<div class="account-auth-art">' + AUTH_ART_SVG + '</div>';
        h += '<div class="account-auth-visual-mark">GWork</div>';
        h += '</div>';
        /* 右：表单区 */
        h += '<div class="account-auth-main">';
        h += '<div class="account-brand">'
            + '<img class="account-brand-logo" src="/img/favicon.png" alt="" aria-hidden="true">'
            + '<span class="account-brand-name">GWork</span></div>';
        h += '<h2 class="account-auth-title" id="accountAuthTitle"></h2>';
        h += '<div class="account-tabs" data-mode="' + authMode + '">'
            + '<button class="account-tab' + (authMode === 'login' ? ' active' : '') + '" type="button" data-act="tab-login">' + esc(t('account.sign_in', '登录')) + '</button>'
            + '<button class="account-tab' + (authMode === 'register' ? ' active' : '') + '" type="button" data-act="tab-register">' + esc(t('account.sign_up', '注册')) + '</button>'
            + '</div>';
        h += '<div id="accountForm"></div>';
        h += '<div class="account-hint" id="' + HINT_MODAL + '"></div>';
        h += '<button class="account-submit" id="accountSubmit" type="button" data-act="submit"></button>';
        h += '</div>';
        h += '</div>';
        modal.innerHTML = h;
        renderForm(authMode);
        refreshAuthLabels();
    }

    /* 品牌插画：漂浮的「能力图标」（终端 / 智能星 / 对话 / 代码括号）落进文件夹，
       呼应 Qoder 登录页左侧的图标雨 + 文件夹构图。全部走主题变量 / currentColor
       取色，明暗主题自动适配；不引外部图片，离线与打包均安全。 */
    var AUTH_ART_SVG = ''
        + '<svg class="account-art-svg" viewBox="0 0 260 240" fill="none" xmlns="http://www.w3.org/2000/svg">'
        /* 背景光晕圆 */
        + '<circle cx="130" cy="118" r="96" class="account-art-halo"/>'
        /* 漂浮图标 1：终端 */
        + '<g class="account-art-float account-art-f1"><rect x="34" y="52" width="52" height="52" rx="14" class="account-art-tile-dark"/>'
        + '<path d="M48 70l9 8-9 8" class="account-art-stroke-light"/><line x1="61" y1="86" x2="72" y2="86" class="account-art-stroke-light"/></g>'
        /* 漂浮图标 2：智能星 */
        + '<g class="account-art-float account-art-f2"><rect x="104" y="20" width="52" height="52" rx="14" class="account-art-tile-light"/>'
        + '<path d="M130 34c2.6 8.4 6.9 12.7 15.3 15.3-8.4 2.6-12.7 6.9-15.3 15.3-2.6-8.4-6.9-12.7-15.3-15.3 8.4-2.6 12.7-6.9 15.3-15.3z" class="account-art-accent-fill"/></g>'
        /* 漂浮图标 3：对话气泡 */
        + '<g class="account-art-float account-art-f3"><rect x="172" y="58" width="52" height="52" rx="14" class="account-art-tile-dark"/>'
        + '<path d="M186 76h24a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4h-12l-7 6v-6h-5a4 4 0 0 1-4-4V80a4 4 0 0 1 4-4z" class="account-art-stroke-light-fill"/></g>'
        /* 文件夹后片 */
        + '<path d="M52 128h44l12 12h100a10 10 0 0 1 10 10v62a10 10 0 0 1-10 10H52a10 10 0 0 1-10-10v-74a10 10 0 0 1 10-10z" class="account-art-folder-back"/>'
        /* 文件夹里探出的代码卡片 */
        + '<g class="account-art-float account-art-f4"><rect x="112" y="112" width="56" height="44" rx="9" transform="rotate(-8 140 134)" class="account-art-tile-accent"/>'
        + '<path d="M132 128l-7 8 7 8M150 128l7 8-7 8" class="account-art-stroke-contrast"/></g>'
        /* 文件夹前片 */
        + '<path d="M42 152h176v60a10 10 0 0 1-10 10H52a10 10 0 0 1-10-10v-60z" class="account-art-folder-front"/>'
        + '</svg>';

    function showAuthModal() {
        ensureModal();
        renderAuth();
        /* 【P0 根因护栏】必须显式写 'block'，绝不能写 '' —— 清空内联会让元素
           回落到类规则；一旦有人给这些类加上 display:none（旧版 .account-overlay
           就是这样），弹框会永远不可见，表现正是「点击没反应」。 */
        modalBackdrop.style.display = 'block';
        modal.style.display = 'block';
        probeRegisterConfig();
        var first = document.getElementById('accountUsername');
        if (first) { try { first.focus(); } catch (e) { /* ignore */ } }
    }

    /* 探测后台注册契约（email_verification 是否强制）。只更新邮箱标签文案，
       绝不重建表单 —— 重建会清掉用户已输入的内容。探测失败保持降级文案。 */
    function probeRegisterConfig() {
        var i = ipc();
        if (!i || typeof i.authConfig !== 'function') return;
        i.authConfig().then(function (c) {
            var req = !!(c && c.email_verification);
            if (req === emailRequired) return;
            emailRequired = req;
            var lbl = modal ? modal.querySelector('label[for="accountEmail"]') : null;
            if (lbl) {
                lbl.textContent = req
                    ? t('account.email_required', '电子邮件（验证必需）')
                    : t('account.email', '邮箱（可选）');
            }
        }, function () { /* 探测失败：保持降级文案，后台错误会原样回显 */ });
    }

    function hideModal() {
        if (modal) modal.style.display = 'none';
        if (modalBackdrop) modalBackdrop.style.display = 'none';
    }

    function renderForm(mode) {
        var form = document.getElementById('accountForm');
        if (!form) return;
        var h = '';
        function field(id, label, type) {
            h += '<div class="account-field"><label class="account-label" for="' + id + '">' + esc(label) + '</label>'
                + '<input class="account-input" id="' + id + '" type="' + type + '" autocomplete="off"></div>';
        }
        field('accountUsername', t('account.username', '用户名'), 'text');
        field('accountPassword', t('account.password', '密码'), 'password');
        if (mode === 'register') {
            field('accountPassword2', t('account.password_confirm', '确认密码'), 'password');
            /* 邮箱在后台开启邮箱验证时是【验证必需】（admin Register 强制
               email + verification_code），标签随探测结果切换；探测失败
               降级为「可选」文案，后台的真实拒绝会原样回显。 */
            field('accountEmail', emailRequired
                ? t('account.email_required', '电子邮件（验证必需）')
                : t('account.email', '邮箱（可选）'), 'email');
            /* 验证码行：输入框 + 发送按钮。data-act 只挂在按钮上——
               delegate() 会沿祖先向上找 data-act，挂外层 div 会把点击
               输入框也误触发发送。 */
            h += '<div class="account-field account-code-row">'
                + '<input class="account-input account-code-input" id="accountCode" type="text" autocomplete="one-time-code" placeholder="' + esc(t('account.code_placeholder', '验证码')) + '" aria-label="' + esc(t('account.code', '验证码')) + '">'
                + '<button class="account-code-btn" id="accountSendCode" type="button" data-act="send-code">' + esc(t('account.send_code', '发送验证码')) + '</button>'
                + '</div>';
        }
        form.innerHTML = h;
        /* 回车提交：重建表单后重新绑定 */
        ['accountUsername', 'accountPassword', 'accountPassword2', 'accountEmail', 'accountCode'].forEach(function (id) {
            var n = document.getElementById(id);
            if (n) n.onkeydown = function (e) { if (e.key === 'Enter' && !busy) onSubmit(); };
        });
        refreshCodeBtn();
    }

    /* 发送验证码按钮的三态：空闲 / 冷却倒计时 / 请求中。
       后台 EmailVerificationRateLimit 的真实规则是「同一 IP 在 30 秒窗口内
       最多 2 次」（middleware/email-verification-rate-limit.go：
       EmailVerificationMaxRequests=2 / EmailVerificationDuration=30），超限回
       HTTP 429「Please wait before requesting another verification code.」。
       它不是「每次发送间隔 N 秒」。客户端这里取 60s 冷却：比后台窗口更宽松，
       单个客户端最多 1 次/60s，正常操作不可能撞上限流；真撞上（例如同 IP 下
       另一台设备刚发过）后台文案会原样回显。 */
    var codeCooldown = 0;      // 剩余秒数
    var codeCooldownTimer = null;
    var codeSending = false;

    function refreshCodeBtn() {
        var btn = document.getElementById('accountSendCode');
        if (!btn) return;
        if (codeSending) {
            btn.disabled = true;
            btn.textContent = t('account.working', '请稍候…');
            return;
        }
        if (codeCooldown > 0) {
            btn.disabled = true;
            btn.textContent = t('account.code_retry', '重新发送') + ' (' + codeCooldown + 's)';
            return;
        }
        btn.disabled = false;
        btn.textContent = codeSentOnce
            ? t('account.code_retry', '重新发送')
            : t('account.send_code', '发送验证码');
    }

    function startCodeCooldown() {
        codeCooldown = 60;
        if (codeCooldownTimer) clearInterval(codeCooldownTimer);
        codeCooldownTimer = setInterval(function () {
            codeCooldown -= 1;
            if (codeCooldown <= 0) {
                clearInterval(codeCooldownTimer);
                codeCooldownTimer = null;
                codeCooldown = 0;
            }
            refreshCodeBtn();
        }, 1000);
        refreshCodeBtn();
    }

    function onSendCode() {
        if (busy || codeSending || codeCooldown > 0) return;
        var i = ipc();
        if (!i || typeof i.authSendCode !== 'function') {
            unavailable();
            return;
        }
        var email = val('accountEmail');
        if (!email) {
            setHint('modal', t('account.email_first', '请先填写邮箱地址'), 'error');
            return;
        }
        codeSending = true;
        refreshCodeBtn();
        setHint('modal', '', '');
        i.authSendCode(email).then(function (msg) {
            codeSending = false;
            codeSentOnce = true;
            startCodeCooldown();
            setHint('modal', msg || t('account.code_sent', '验证码已发送，请查收邮箱'), 'ok');
        }, function (e) {
            codeSending = false;
            refreshCodeBtn();
            setHint('modal', errText(e), 'error');
        });
    }

    /* 主标题与提交按钮文案同步切换（Qoder 式：标题说明当前在做什么）。
       标题用 <h2> + textContent 赋值，绝不走 innerHTML —— 它是用户可见文本，
       必须与翻译值一并转义安全。 */
    function refreshAuthLabels() {
        var title = document.getElementById('accountAuthTitle');
        if (title) {
            title.textContent = authMode === 'register'
                ? t('account.auth_title_register', '创建账号')
                : t('account.auth_title_login', '登录 GWork');
        }
        /* 左栏手写体标语：与主标题同源于 i18n，语言切换（60s 保活刷新路径）
           也会经 refreshAuthLabels 同步，无需额外钩子。 */
        var slogan = document.getElementById('accountAuthSlogan');
        if (slogan) {
            slogan.textContent = t('account.auth_slogan', '不止执行，更是创造。');
        }
        var submit = document.getElementById('accountSubmit');
        if (submit) {
            submit.textContent = busy ? t('account.working', '请稍候…')
                : (authMode === 'register' ? t('account.sign_up_submit', '注册并登录') : t('account.sign_in', '登录'));
            submit.disabled = busy;
        }
    }

    function switchTab(mode) {
        authMode = mode;
        var tabs = modal ? modal.querySelectorAll('.account-tab') : [];
        for (var i = 0; i < tabs.length; i++) {
            var want = (i === 0 && mode === 'login') || (i === 1 && mode === 'register');
            if (want) tabs[i].classList.add('active');
            else tabs[i].classList.remove('active');
        }
        /* 分段控件的滑块靠父容器 data-mode 定位：只改 class 无法驱动 ::after，
           必须同步属性，否则切到「注册」时高亮块仍停在左半。
           刻意用 querySelectorAll()[0] 而非 querySelector：与模块内既有取节点
           方式一致，且不依赖调用方具备 querySelector 能力。 */
        var bar = modal ? modal.querySelectorAll('.account-tabs') : [];
        if (bar.length) bar[0].setAttribute('data-mode', mode);
        renderForm(mode);
        if (mode === 'register') probeRegisterConfig();
        setHint('modal', '', '');
        refreshAuthLabels();
    }

    /* 提示只写进【指定容器】的 hint 节点：'pop' = 账号弹层，'modal' = 登录弹框。
       两容器各持唯一 id（HINT_POP / HINT_MODAL），避免同 id 双节点时
       getElementById 命中被隐藏的那一个、提示对用户不可见。 */
    function setHint(scope, text, kind) {
        var hint = document.getElementById(scope === 'pop' ? HINT_POP : HINT_MODAL);
        if (!hint) return;
        hint.textContent = text || '';
        hint.className = 'account-hint' + (kind ? ' account-hint-' + kind : '');
    }

    function setBusy(on) {
        busy = !!on;
        refreshAuthLabels();
    }

    /* ---------- 打开 / 关闭弹层 ---------- */

    function show() {
        ensurePopover();
        var want = state.signed_in ? 'profile' : 'menu';
        if (view !== want) {
            view = want;
            if (want === 'profile') renderProfile(); else renderMenu();
        }
        refreshView();
        /* 【P0 根因护栏】同 showAuthModal：显式 'block'，绝不清空内联。 */
        backdrop.style.display = 'block';
        popover.style.display = 'block';
        position();
        if (entry) entry.setAttribute('aria-expanded', 'true');
    }

    function hide() {
        if (popover) popover.style.display = 'none';
        if (backdrop) backdrop.style.display = 'none';
        if (entry) entry.setAttribute('aria-expanded', 'false');
    }

    /* ---------- 菜单动作 ---------- */

    function openExternal(url) {
        var a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    function onTheme(mode) {
        var api = window.__themeApi;
        if (api && typeof api.applyThemeMode === 'function') api.applyThemeMode(mode);
        refreshThemeBtns();
    }

    function onAction(act) {
        if (act === 'close') { hide(); return; }
        if (act === 'close-modal') { hideModal(); return; }
        if (act === 'tab-login') { switchTab('login'); return; }
        if (act === 'tab-register') { switchTab('register'); return; }
        if (act === 'send-code') { onSendCode(); return; }
        if (act === 'submit') { onSubmit(); return; }
        if (act === 'login') {
            /* 登录表单是独立弹框：收起弹层再开居中弹框 */
            hide();
            showAuthModal();
            return;
        }
        if (act === 'settings') {
            hide();
            if (typeof window.openSettings === 'function') window.openSettings();
            return;
        }
        if (act === 'memory') {
            hide();
            if (typeof window.openMemoryView === 'function') window.openMemoryView();
            return;
        }
        if (act === 'feedback') { hide(); openExternal(HOMEPAGE_URL); return; }
        if (act === 'update') {
            hide();
            /* 检查更新能力在「设置 → 关于」页；打开后直接切到该 tab。 */
            if (typeof window.openSettings === 'function') {
                window.openSettings();
                if (window.$) window.$('.settings-tab[data-tab="about"]').trigger('click');
            }
            return;
        }
        if (act === 'logout') { onLogout(); return; }
    }

    /* ---------- 状态与后端 ---------- */

    function applyStatus(s) {
        var prev = state.signed_in;
        state.signed_in = !!(s && s.signed_in);
        state.username = (s && s.username) || '';
        state.display_name = (s && s.display_name) || '';
        if (!state.signed_in) {
            state.plan = ''; state.points = ''; state.avatar_url = ''; selfLoaded = false;
        }
        renderCard();
        /* 登录态翻转时登录弹框没有存在意义了（已登录成功）：收起。 */
        if (isModalOpen() && state.signed_in) hideModal();
        if (isOpen()) {
            if (prev !== state.signed_in) show();  // 登录态翻转：重建弹层骨架
            else refreshView();                    // 同态刷新：只更文本，不动表单
        }
        if (state.signed_in) refreshSelf();
    }

    /* authSelf → invoke('auth_self') → authorized_get → parse_api_response
       已经把 {success,message,data} 信封解包成 data 本体，这里拿到的是
       buildSelfUserData 的字段：username / display_name / group（渠道分组，
       非套餐名）/ quota（剩余额度整数）等；后端【没有】avatar / avatar_url
       字段，所以真实头像 URL 通常拿不到，展示一律退回昵称首字渐变底。
       保留 raw.data 兼容分支只为防御后端改信封，尽力解析、失败静默降级「—」：
       绝不让补充信息阻塞主弹层。 */
    function refreshSelf() {
        var i = ipc();
        if (!i || typeof i.authSelf !== 'function' || selfLoaded) return;
        selfLoaded = true;
        i.authSelf().then(function (raw) {
            var d = (raw && raw.data) ? raw.data : raw;
            if (!d || typeof d !== 'object') return;
            state.plan = d.group || d.group_name || d.plan || state.plan;
            var q = (d.quota != null) ? d.quota : (d.credits != null ? d.credits : null);
            if (q != null) state.points = String(q);
            state.avatar_url = d.avatar_url || d.avatar || state.avatar_url;
            renderCard();
            if (isOpen()) refreshView();
        }, function () { selfLoaded = false; });
    }

    function refreshStatus() {
        if (!hasAuth()) {
            /* 无 IPC：不 return、不隐藏入口，只是把状态归位为未登录。
               入口依然可点，弹层/弹框依然能开 —— 这正是「点击没反应」的修复点。 */
            applyStatus({ signed_in: false, username: '', display_name: '' });
            return Promise.resolve();
        }
        return ipc().authStatus().then(applyStatus, function () {
            // 后台/模块暂不可用：保留上次状态，不把入口误显示成已登录。
        });
    }

    /* ---------- 表单动作 ---------- */

    function val(id) {
        var n = document.getElementById(id);
        return n ? String(n.value || '').trim() : '';
    }

    function unavailable() {
        /* 能力缺失只会发生在登录/登出请求路径上，两者此刻都在登录弹框或
           弹层里可见；submit 走弹框、logout 走弹层，故按调用点分域。 */
        setHint('modal', t('account.unavailable', '登录服务暂不可用，请在桌面客户端中操作'), 'error');
    }

    function onSubmit() {
        if (busy) return;
        var i = ipc();
        if (!i || typeof i.authLogin !== 'function' || typeof i.authRegister !== 'function') {
            unavailable();
            return;
        }
        var username = val('accountUsername');
        var password = val('accountPassword');
        if (!username || !password) {
            setHint('modal', t('account.required', '请填写用户名和密码'), 'error');
            return;
        }
        if (password.length < 8 || password.length > 128) {
            setHint('modal', t('account.password_policy', '密码长度需为 8–128 个字符'), 'error');
            return;
        }
        var email = '';
        var code = '';
        if (authMode === 'register') {
            var password2 = val('accountPassword2');
            if (password2 !== password) {
                setHint('modal', t('account.password_mismatch', '两次输入的密码不一致'), 'error');
                return;
            }
            email = val('accountEmail');
            code = val('accountCode');
            /* 后台开启邮箱验证时 email + verification_code 是注册接口的硬契约
               （admin controller/user.go::Register），前端先拦一道，避免用户
               空等一次往返；未探测到（null）时不拦，后台错误原样回显。 */
            if (emailRequired === true) {
                if (!email) {
                    setHint('modal', t('account.email_first', '请先填写邮箱地址'), 'error');
                    return;
                }
                if (!code) {
                    setHint('modal', t('account.code_required', '请输入邮箱验证码'), 'error');
                    return;
                }
            }
        }
        setBusy(true);
        setHint('modal', '', '');
        var call = authMode === 'register'
            ? i.authRegister(username, password, email, code)
            : i.authLogin(username, password);
        call.then(function (s) {
            setBusy(false);
            authMode = 'login';
            applyStatus(s);   // 内部会收起登录弹框
        }, function (e) {
            setBusy(false);
            setHint('modal', errText(e), 'error');
        });
    }

    function onLogout() {
        if (busy) return;
        var i = ipc();
        if (!i || typeof i.authLogout !== 'function') {
            /* 登出发生在弹层里：提示必须写弹层的 hint，写弹框的会被隐藏吞掉。 */
            setHint('pop', t('account.unavailable', '登录服务暂不可用，请在桌面客户端中操作'), 'error');
            return;
        }
        setBusy(true);
        i.authLogout().then(function (s) {
            setBusy(false);
            authMode = 'login';
            applyStatus(s);
            /* 退出后弹层重建为未登录设置菜单（参考图语义：退出即回未登录态） */
            if (isOpen()) show();
        }, function (e) {
            setBusy(false);
            setHint('pop', errText(e), 'error');
        });
    }

    function errText(e) {
        if (!e) return t('account.failed', '操作失败');
        if (typeof e === 'string') return e;
        return String(e.message || e);
    }

    /* ---------- 初始化 ----------
       不依赖 IPC 是否存在；DOM 未就绪时等 DOMContentLoaded（动态脚本
       可能被提前注入），保证 onclick 一定绑上。 */
    function init() {
        entry = document.getElementById('accountEntryBtn');
        if (!entry) return;
        entry.onclick = function () { isOpen() ? hide() : show(); };
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            /* 登录弹框优先：它盖在弹层之上 */
            if (isModalOpen()) hideModal();
            else if (isOpen()) hide();
        });
        window.addEventListener('resize', function () { if (isOpen()) position(); });
        document.addEventListener('i18n:localeChanged', function () {
            renderCard();
            /* 弹层/弹框内静态文案按新语言重建；正在打开时先收起，
               避免输入到一半被清空。 */
            if (isModalOpen()) hideModal();
            if (isOpen()) { hide(); view = null; }
        });
        refreshStatus();
        setInterval(refreshStatus, 60000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    // 暴露给控制台/测试，不含任何凭据。
    window.GourdAccount = {
        status: refreshStatus, show: show, hide: hide,
        showAuth: showAuthModal, hideAuth: hideModal,
        state: function () { return state; }
    };
})();
