/* ===== app-account.js =====
   桌面端账号入口：登录 / 注册 / 登出。

   凭据与会话保活全部在 Rust 侧（auth.rs）：本页面只调用
   window.__GOURD_IPC__.auth*，绝不接触 access token / refresh cookie。
   浏览器模式下没有 IPC，整个模块静默隐藏入口（不影响既有功能）。

   ES5：与其余 app-*.js 保持一致。 */
(function () {
    'use strict';

    var ipc = window.__GOURD_IPC__;
    if (!ipc || typeof ipc.authStatus !== 'function') return;

    function t(key, fallback) {
        var msg = window.GourdI18n ? window.GourdI18n.t(key) : key;
        return (msg && msg !== key) ? msg : (fallback || key);
    }

    var state = { signed_in: false, username: '', display_name: '' };
    var overlay = null;
    var busy = false;

    /* ---------- DOM ---------- */

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = String(text);
        return n;
    }

    function buildOverlay() {
        if (overlay) return overlay;
        overlay = el('div', 'account-overlay');
        overlay.id = 'accountOverlay';
        overlay.style.display = 'none';

        var panel = el('div', 'account-panel');
        var close = el('button', 'account-close', '×');
        close.type = 'button';
        close.setAttribute('aria-label', t('account.close', '关闭'));
        close.onclick = hide;
        panel.appendChild(close);

        var tabs = el('div', 'account-tabs');
        var loginTab = el('button', 'account-tab active', t('account.sign_in', '登录'));
        var regTab = el('button', 'account-tab', t('account.sign_up', '注册'));
        loginTab.type = 'button';
        regTab.type = 'button';
        loginTab.onclick = function () { switchTab('login'); };
        regTab.onclick = function () { switchTab('register'); };
        tabs.appendChild(loginTab);
        tabs.appendChild(regTab);
        panel.appendChild(tabs);

        var form = el('div', 'account-form');
        form.id = 'accountForm';
        panel.appendChild(form);

        var hint = el('div', 'account-hint');
        hint.id = 'accountHint';
        panel.appendChild(hint);

        var submit = el('button', 'account-submit', t('account.sign_in', '登录'));
        submit.id = 'accountSubmit';
        submit.type = 'button';
        submit.onclick = onSubmit;
        panel.appendChild(submit);

        var signedIn = el('div', 'account-signed-in');
        signedIn.id = 'accountSignedIn';
        signedIn.style.display = 'none';
        var who = el('div', 'account-who');
        who.id = 'accountWho';
        signedIn.appendChild(who);
        var logout = el('button', 'account-logout', t('account.sign_out', '退出登录'));
        logout.type = 'button';
        logout.onclick = onLogout;
        signedIn.appendChild(logout);
        panel.appendChild(signedIn);

        overlay.appendChild(panel);
        overlay.onclick = function (e) { if (e.target === overlay) hide(); };
        document.body.appendChild(overlay);
        switchTab('login');
        return overlay;
    }

    function renderForm(mode) {
        var form = document.getElementById('accountForm');
        if (!form) return;
        form.innerHTML = '';
        function field(id, label, type, placeholder) {
            var wrap = el('div', 'account-field');
            wrap.appendChild(el('label', 'account-label', label));
            var input = document.createElement('input');
            input.type = type;
            input.className = 'account-input';
            input.id = id;
            if (placeholder) input.placeholder = placeholder;
            input.onkeydown = function (e) {
                if (e.key === 'Enter' && !busy) onSubmit();
            };
            wrap.appendChild(input);
            form.appendChild(wrap);
        }
        field('accountUsername', t('account.username', '用户名'), 'text', '');
        if (mode === 'register') {
            field('accountEmail', t('account.email', '邮箱（可选）'), 'email', '');
        }
        field('accountPassword', t('account.password', '密码'), 'password', '');
    }

    function switchTab(mode) {
        buildOverlay();
        var tabs = overlay.querySelectorAll('.account-tab');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].className = 'account-tab' + ((i === 0 && mode === 'login') || (i === 1 && mode === 'register') ? ' active' : '');
        }
        overlay.setAttribute('data-mode', mode);
        var submit = document.getElementById('accountSubmit');
        if (submit) submit.textContent = mode === 'login' ? t('account.sign_in', '登录') : t('account.sign_up_submit', '注册并登录');
        renderForm(mode);
        setHint('', '');
    }

    function setHint(text, kind) {
        var hint = document.getElementById('accountHint');
        if (!hint) return;
        hint.textContent = text || '';
        hint.className = 'account-hint' + (kind ? ' account-hint-' + kind : '');
    }

    function setBusy(on) {
        busy = !!on;
        var submit = document.getElementById('accountSubmit');
        if (submit) {
            submit.disabled = busy;
            submit.textContent = busy
                ? t('account.working', '请稍候…')
                : (overlay && overlay.getAttribute('data-mode') === 'register'
                    ? t('account.sign_up_submit', '注册并登录') : t('account.sign_in', '登录'));
        }
    }

    function show() {
        buildOverlay();
        var entry = document.getElementById('accountEntryBtn');
        var signedIn = document.getElementById('accountSignedIn');
        var form = document.getElementById('accountForm');
        var tabs = overlay.querySelector('.account-tabs');
        var submit = document.getElementById('accountSubmit');
        if (state.signed_in) {
            if (signedIn) signedIn.style.display = '';
            if (form) form.style.display = 'none';
            if (tabs) tabs.style.display = 'none';
            if (submit) submit.style.display = 'none';
            var who = document.getElementById('accountWho');
            if (who) who.textContent = (state.display_name || state.username || '') +
                (state.username ? '  (' + state.username + ')' : '');
        } else {
            if (signedIn) signedIn.style.display = 'none';
            if (form) form.style.display = '';
            if (tabs) tabs.style.display = '';
            if (submit) submit.style.display = '';
            switchTab(overlay.getAttribute('data-mode') || 'login');
        }
        overlay.style.display = '';
        setHint('', '');
        var first = document.getElementById('accountUsername');
        if (first && !state.signed_in) { try { first.focus(); } catch (e) { /* ignore */ } }
        if (entry) entry.setAttribute('aria-expanded', 'true');
    }

    function hide() {
        if (overlay) overlay.style.display = 'none';
        var entry = document.getElementById('accountEntryBtn');
        if (entry) entry.setAttribute('aria-expanded', 'false');
    }

    /* ---------- 状态 ---------- */

    function applyStatus(s) {
        state = s || state;
        var name = document.getElementById('accountEntryName');
        var entry = document.getElementById('accountEntryBtn');
        if (!name || !entry) return;
        if (state.signed_in) {
            name.textContent = state.display_name || state.username || t('account.signed_in', '已登录');
            name.removeAttribute('data-i18n');
            entry.classList.add('is-signed-in');
        } else {
            name.textContent = t('account.entry', '登录 / 注册');
            entry.classList.remove('is-signed-in');
        }
        if (overlay && overlay.style.display !== 'none') show();
    }

    function refreshStatus() {
        return ipc.authStatus().then(applyStatus, function () {
            // 后台/模块暂不可用：保留上次状态，不把入口误显示成已登录。
        });
    }

    /* ---------- 动作 ---------- */

    function val(id) {
        var n = document.getElementById(id);
        return n ? String(n.value || '').trim() : '';
    }

    function onSubmit() {
        if (busy) return;
        var username = val('accountUsername');
        var password = val('accountPassword');
        if (!username || !password) {
            setHint(t('account.required', '请填写用户名和密码'), 'error');
            return;
        }
        if (password.length < 8 || password.length > 128) {
            setHint(t('account.password_policy', '密码长度需为 8–128 个字符'), 'error');
            return;
        }
        var mode = overlay ? overlay.getAttribute('data-mode') : 'login';
        setBusy(true);
        setHint('', '');
        var call = mode === 'register'
            ? ipc.authRegister(username, password, val('accountEmail'))
            : ipc.authLogin(username, password);
        call.then(function (s) {
            setBusy(false);
            applyStatus(s);
            hide();
        }, function (e) {
            setBusy(false);
            setHint(errText(e), 'error');
        });
    }

    function onLogout() {
        if (busy) return;
        setBusy(true);
        ipc.authLogout().then(function (s) {
            setBusy(false);
            applyStatus(s);
            switchTab('login');
            show();
        }, function (e) {
            setBusy(false);
            setHint(errText(e), 'error');
        });
    }

    function errText(e) {
        if (!e) return t('account.failed', '操作失败');
        if (typeof e === 'string') return e;
        return String(e.message || e);
    }

    /* ---------- 初始化 ---------- */

    var entry = document.getElementById('accountEntryBtn');
    if (!entry) return;
    entry.onclick = show;
    refreshStatus();
    // 语言切换后重刷动态文案（静态 data-i18n 由 GourdI18n 自己处理）。
    document.addEventListener('i18n:localeChanged', function () {
        applyStatus(state);
        if (overlay && overlay.getAttribute('data-mode')) switchTab(overlay.getAttribute('data-mode'));
    });
    // 定时对齐 Rust 侧保活结果（refresh 成功后状态在 Rust 内存里，前端只展示）。
    setInterval(refreshStatus, 60000);

    // 暴露给控制台/测试，不含任何凭据。
    window.GourdAccount = { status: refreshStatus, show: show, hide: hide };
})();
