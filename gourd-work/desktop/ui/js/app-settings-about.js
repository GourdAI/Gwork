/* app-settings-about.js — 「关于」设置页
 *
 * 桌面端（Electron）：展示桌面端版本 + 自动更新面板
 *   （检查更新 / 下载进度 / 安装并重启；mac 等 notify 平台引导浏览器下载）。
 * 浏览器端（WebGate 直连）：提示桌面端专属能力。
 *
 * 更新状态由外壳经 IPC 桥推送（window.__GOURD_IPC__.onUpdaterState），
 * 状态机与旧 Tauri 壳 updater.rs 保持一致：
 *   idle | checking | available | not-available | downloading | downloaded | error
 *
 * 【桌面壳无 updater 能力时的降级（保留给旧壳 / 浏览器）】
 * Rust 原生壳（gourd-work/desktop）现已接入 tauri-plugin-updater：src/updater.rs 读取
 * admin 后台上传的、免登录公开的 latest.json，桥接层暴露 updaterGetState / updaterCheck
 * 等 5 个方法，hasUpdaterBridge() 为真，下面这套完整状态机正常运行。
 * 该降级分支仍保留给浏览器端与未带更新能力的旧构建：isDesktop 为真但快照永远不到达时，
 * lastState 恒 null，applyState 会一直停在「快照尚未到达」的瞬态占位（一个省略号），
 * 卡片里连按钮都没有。故直说「此版本不支持应用内更新」并给出官网下载入口，
 * 而不是假装正在检查。
 *
 * 【外链为什么能工作：壳层的 on_new_window，不是 _blank 本身】
 * `target="_blank"` 只是向壳层发出「请求新窗口」。wry 0.53 起 Windows 默认禁用新窗口
 * 创建，未注册处理器时 WebView2 直接 SetHandled(true) —— 点击静默无反应，无报错无日志。
 * 真正把外链交给系统浏览器的是壳层的 on_new_window / on_navigation 拦截
 * （gourd-work/desktop/src-tauri/src/external_link.rs），它校验来源后调 shell().open()。
 * 曾经这里的注释写成「靠 _blank 交给 tauri-plugin-shell」，是错的：插件只提供一个可调用的
 * 命令，不会自动接管锚点点击；当时新壳没接拦截器，这个下载入口其实是个死链。
 */
(function () {
    'use strict';

    var CONTAINER = 'settingsTabAbout';
    var core = window._settingsCore || {};
    var escapeHtml = core.escapeHtml || function (s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };

    var ipc = window.__GOURD_IPC__ || null;
    var isDesktop = !!(ipc && ipc.isDesktop);

    // 会话内状态缓存：事件推送与主动拉取共用同一份渲染入口
    var lastState = null;
    var desktopVersion = '';
    var rendered = false;

    function t(key, args) { return window.GourdI18n ? GourdI18n.t(key, args) : key; }

    // 官网首页：既是版本卡片里的「官方网站」行，也是无 updater 能力时的下载入口。
    // 单一出处，避免两处各写一遍后漂移。
    var HOMEPAGE_URL = 'https://www.gourdwork.com/';

    /* 外壳是否真的具备自动更新能力。
       两个方法都要在：updaterGetState 负责首次拉快照，updaterCheck 负责手动检查按钮 ——
       少任何一个，卡片都无法完成一次完整的「检查 → 看到结果」闭环，应当直接降级，
       而不是渲染出一个点下去没反应的按钮。 */
    function hasUpdaterBridge() {
        return !!(ipc && typeof ipc.updaterGetState === 'function'
            && typeof ipc.updaterCheck === 'function');
    }

    function $c() { return $('#' + CONTAINER); }

    /* ── 静态骨架 ─────────────────────────────────────────────── */

    function card(title, desc, body) {
        var h = '<div class="general-card"><div class="general-card-header"><div class="general-card-text">';
        h += '<div class="general-card-title">' + escapeHtml(title) + '</div>';
        if (desc) h += '<div class="general-card-desc">' + escapeHtml(desc) + '</div>';
        h += '</div></div><div class="general-card-body">' + body + '</div></div>';
        return h;
    }

    function renderSkeleton() {
        var html = '';

        // 页头
        html += '<div class="settings-section-header settings-section-header-flat"><div>';
        html += '<span class="settings-section-title">' + escapeHtml(t('settings.about.title')) + '</span>';
        html += '<div class="settings-section-desc">' + escapeHtml(t('settings.about.desc')) + '</div>';
        html += '</div></div>';

        html += '<div class="general-card-group">';

        // 卡片一：版本信息
        var versionRows = '';
        versionRows += '<div class="about-version-row"><span class="about-version-label">' +
            escapeHtml(t('settings.about.desktop_version')) + '</span>' +
            '<span class="about-version-value" id="aboutDesktopVersion">-</span></div>';
        versionRows += '<div class="about-version-row"><span class="about-version-label">' +
            escapeHtml(t('settings.about.homepage')) + '</span>' +
            '<span class="about-version-value"><a href="' + HOMEPAGE_URL +
            '" target="_blank" rel="noopener">www.gourdwork.com</a></span></div>';
        html += card(t('settings.about.version_card'), '', versionRows);

        // 卡片二：检查更新（内容由 applyState 动态填充）。
        // 骨架里的首屏文案要与 applyState 的首个落点一致：无 updater 能力时写
        // 「正在检查更新…」会先闪一帧假进行中态，然后才被降级文案替换。
        var seedText = hasUpdaterBridge() ? t('settings.about.checking') : t('settings.about.no_updater');
        html += card(t('settings.about.update_card'), '', '<div id="aboutUpdateArea"><div class="settings-section-desc">' +
            escapeHtml(seedText) + '</div></div>');

        html += '</div>'; // /.general-card-group

        $c().html(html);
        rendered = true;
        fillVersions();
        applyState(lastState); // 已有缓存状态时立即回填
    }

    /* ── 版本信息 ─────────────────────────────────────────────── */

    function fillVersions() {
        if (isDesktop && typeof ipc.getAppVersion === 'function') {
            Promise.resolve(ipc.getAppVersion()).then(function (v) {
                desktopVersion = String(v || '');
                var el = document.getElementById('aboutDesktopVersion');
                if (el) el.textContent = desktopVersion ? ('v' + desktopVersion) : '-';
            }).catch(function () { /* ignore */ });
        } else {
            var eld = document.getElementById('aboutDesktopVersion');
            if (eld) eld.textContent = t('settings.about.web_na');
        }
    }

    /* ── 更新状态渲染 ─────────────────────────────────────────── */

    function progressHtml(st) {
        var p = st.progress || {};
        var percent = isFinite(p.percent) ? p.percent : 0;
        var text = percent.toFixed(1) + '%';
        if (p.total > 0) text += '  (' + fmtBytes(p.transferred) + ' / ' + fmtBytes(p.total) + ')';
        return '<div class="about-progress-track"><div class="about-progress-fill" style="width:' +
            Math.max(0, Math.min(100, percent)) + '%"></div></div>' +
            '<div class="about-progress-text">' + escapeHtml(text) + '</div>';
    }

    function fmtBytes(n) {
        n = Number(n) || 0;
        if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
        if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
        return n + ' B';
    }

    function notesHtml(st) {
        if (!st.releaseNotes) return '';
        return '<div class="about-notes-label">' + escapeHtml(t('settings.about.release_notes')) + '</div>' +
            '<pre class="about-notes">' + escapeHtml(st.releaseNotes) + '</pre>';
    }

    /** 按状态机渲染卡片二内容。非桌面端渲染占位说明。 */
    function applyState(st) {
        lastState = st || lastState;
        if (!rendered) return; // 骨架未建好，建好后会用 lastState 回填
        var $area = $('#aboutUpdateArea');
        if (!$area.length) return;

        if (!isDesktop) {
            $area.html('<div class="settings-section-desc">' + escapeHtml(t('settings.about.web_mode')) + '</div>');
            return;
        }
        // 桌面壳但无 updater 能力：必须在 !lastState 之前判，否则会落进那个
        // 为「快照在途」设计的瞬态占位分支并永久停在那里。
        if (!hasUpdaterBridge()) {
            $area.html('<div class="settings-section-desc">' +
                escapeHtml(t('settings.about.no_updater')) + '</div>' +
                '<div class="about-actions"><a class="btn-primary" href="' + HOMEPAGE_URL +
                '" target="_blank" rel="noopener">' +
                escapeHtml(t('settings.about.open_download_page')) + '</a></div>');
            return;
        }
        if (!lastState) {
            // 快照尚未到达（首次打开 tab 的瞬间），中性占位，避免误报 dev_mode
            $area.html('<div class="about-status-line about-status-sub">…</div>');
            return;
        }
        if (lastState.mode === 'none') {
            $area.html('<div class="settings-section-desc">' + escapeHtml(t('settings.about.dev_mode')) + '</div>');
            return;
        }

        var html = '';
        var status = lastState.status;
        var notify = lastState.mode === 'notify';

        if (status === 'checking') {
            html += '<div class="about-status-line">' + escapeHtml(t('settings.about.checking')) + '</div>';
            html += '<div class="about-actions"><button class="btn-primary" disabled>' +
                escapeHtml(t('settings.about.check_update')) + '</button></div>';
        } else if (status === 'available' || status === 'downloading') {
            html += '<div class="about-status-line about-status-accent">' +
                escapeHtml(t('settings.about.new_version', [lastState.version || ''])) + '</div>';
            if (status === 'downloading') {
                html += progressHtml(lastState);
                html += '<div class="about-status-sub">' + escapeHtml(t('settings.about.downloading')) + '</div>';
                html += '<div class="about-actions"><button class="btn-primary" disabled>' +
                    escapeHtml(t('settings.about.downloading')) + '</button></div>';
            } else if (notify) {
                html += '<div class="about-status-sub">' + escapeHtml(t('settings.about.notify_hint')) + '</div>';
                html += notesHtml(lastState);
                html += '<div class="about-actions">' +
                    '<button class="btn-primary" id="aboutDownloadBtn">' + escapeHtml(t('settings.about.download_update')) + '</button>' +
                    '<button class="btn-secondary" id="aboutCheckBtn">' + escapeHtml(t('settings.about.check_update')) + '</button>' +
                    '</div>';
            } else {
                // auto 模式：autoDownload=true，主进程已自动开始下载
                html += '<div class="about-status-sub">' + escapeHtml(t('settings.about.auto_downloading')) + '</div>';
                html += notesHtml(lastState);
                html += '<div class="about-actions"><button class="btn-primary" disabled>' +
                    escapeHtml(t('settings.about.auto_downloading')) + '</button></div>';
            }
        } else if (status === 'downloaded') {
            html += '<div class="about-status-line about-status-accent">' +
                escapeHtml(t('settings.about.downloaded', [lastState.version || ''])) + '</div>';
            html += '<div class="about-status-sub">' + escapeHtml(t('settings.about.install_hint')) + '</div>';
            html += notesHtml(lastState);
            html += '<div class="about-actions">' +
                '<button class="btn-primary" id="aboutInstallBtn">' + escapeHtml(t('settings.about.install_restart')) + '</button>' +
                '</div>';
        } else if (status === 'error') {
            html += '<div class="about-status-line about-status-error">' + escapeHtml(t('settings.about.check_failed')) + '</div>';
            if (lastState.error) {
                html += '<div class="about-status-sub about-status-sub-mono">' + escapeHtml(lastState.error) + '</div>';
            }
            html += '<div class="about-actions">' +
                '<button class="btn-primary" id="aboutCheckBtn">' + escapeHtml(t('settings.about.retry')) + '</button>' +
                '</div>';
        } else {
            // idle / not-available
            if (status === 'not-available') {
                html += '<div class="about-status-line">' + escapeHtml(t('settings.about.up_to_date')) + '</div>';
            } else {
                html += '<div class="about-status-line about-status-sub">' + escapeHtml(t('settings.about.idle_hint')) + '</div>';
            }
            html += '<div class="about-actions">' +
                '<button class="btn-primary" id="aboutCheckBtn">' + escapeHtml(t('settings.about.check_update')) + '</button>' +
                '</div>';
        }

        $area.html(html);
    }

    /* ── 事件（document 级委托，重渲染后仍有效）────────────────── */

    $(document).on('click', '#aboutCheckBtn', function () {
        if (!ipc || typeof ipc.updaterCheck !== 'function') return;
        $(this).prop('disabled', true);
        Promise.resolve(ipc.updaterCheck()).then(applyState).catch(function () {
            applyState(null);
        });
    });

    $(document).on('click', '#aboutDownloadBtn', function () {
        if (!ipc || typeof ipc.updaterDownload !== 'function') return;
        Promise.resolve(ipc.updaterDownload()).then(applyState).catch(function () { /* ignore */ });
    });

    $(document).on('click', '#aboutInstallBtn', function () {
        if (!ipc || typeof ipc.updaterInstall !== 'function') return;
        $(this).prop('disabled', true);
        Promise.resolve(ipc.updaterInstall()).then(applyState).catch(function () {
            applyState(null);
        });
    });

    // 订阅主进程推送（模块加载时注册一次，早于任何渲染）。
    // 全局新版提示：不依赖用户打开本页——后台检测到新版本即 toast 一次；
    // 按版本号去重（同版本每次应用生命周期只提示一次，6h 复检不重复打扰）。
    var toastedVersion = '';
    if (isDesktop && typeof ipc.onUpdaterState === 'function') {
        ipc.onUpdaterState(function (st) {
            if (st && st.status === 'available') {
                var v = String(st.version || '');
                if (v && toastedVersion !== v) {
                    toastedVersion = v;
                    if (typeof window.showToast === 'function') {
                        window.showToast(t('settings.about.new_version', [v]), 'success');
                    }
                }
            }
            applyState(st);
        });
    }

    /* ── 入口 ─────────────────────────────────────────────────── */

    function load() {
        if (!rendered) renderSkeleton();
        else {
            fillVersions();
            applyState(lastState);
        }
        // 主动拉一次快照，覆盖"事件早于页面打开"的竞态
        if (isDesktop && typeof ipc.updaterGetState === 'function') {
            Promise.resolve(ipc.updaterGetState()).then(applyState).catch(function () { /* ignore */ });
        }
    }

    window._settingsAbout = { load: load };
})();
