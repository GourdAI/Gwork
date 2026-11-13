/**
 * app-settings-mcp.js — 设置面板子模块
 */
(function () {
    'use strict';

    /* MCP-AUTH-MODULE-START */
    /**
     * window.McpAuth — 连接器认证复用层（手动表单 + MCP 市场共用）。
     *
     * 固定后端契约：
     *   GET  /web/settings/mcp/auth/state?name=X  → {ok, name, authType, connected,
     *        needsAuth, hasCredential, label, helpUrl, helpText, phase, error}
     *   POST /web/settings/mcp/auth/start         → {ok, phase, authorizationUrl}
     *   POST /web/settings/mcp/auth/device/start  → {ok, userCode, verificationUri, expiresIn}
     *   GET  /web/settings/mcp/auth/status?name=X → {ok, phase, authorizationUrl?, userCode?, error?}
     *
     * 两种应用内授权形态（WorkBuddy 对齐）：
     *   authDeviceFlow — RFC 8628，弹窗显示 user_code + 二维码/验证链接，后端自行轮询；
     *   authQrModal    — 不开系统浏览器，改为内嵌 iframe 展示服务方二维码授权页。
     *   POST /web/settings/mcp/auth/cancel        → {ok}
     *   POST /web/settings/mcp/auth/token         → {ok}
     *   POST /web/settings/mcp/auth/clear         → {ok}
     *
     * 安全边界：用户输入的凭据只出现在 /auth/token 的一次请求体里，交给本机
     * 凭据库；这里不构造任何含凭据的服务器配置请求体，不回显、不缓存，
     * 弹窗关闭即清空输入框。authType == 'none'（或认证接口不可用）时所有
     * 入口立即放行，原有保存 / 安装流程一字不改。
     */
    (function () {
        'use strict';

        var API = {
            state: '/web/settings/mcp/auth/state',
            start: '/web/settings/mcp/auth/start',
            deviceStart: '/web/settings/mcp/auth/device/start',
            status: '/web/settings/mcp/auth/status',
            cancel: '/web/settings/mcp/auth/cancel',
            token: '/web/settings/mcp/auth/token',
            clear: '/web/settings/mcp/auth/clear'
        };
        var POLL_MS = 1500;                  // /auth/status 轮询间隔 1.5s
        var MAX_WAIT_MS = 5 * 60 * 1000;     // 授权整体超时上限 5 分钟
        var pollTimer = null;
        var generation = 0;                  // 新弹窗让旧轮询立即失效

        /** settings.mcp.* 取词；语言包未就绪 / 键缺失时回落短兜底文案。 */
        function authT(key, fallback) {
            var full = 'settings.mcp.' + key;
            try {
                var v = (window.GourdI18n && window.GourdI18n.t) ? GourdI18n.t(full) : null;
                if (v && v !== full) return v;
            } catch (e) { /* 语言包未就绪走兜底 */ }
            return fallback;
        }
        function esc(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }
        function toast(msg, kind) {
            if (window._settingsCore && window._settingsCore.showToast) window._settingsCore.showToast(msg, kind || 'error');
            else if (window.showToast) window.showToast(msg, kind || 'error');
        }
        /** 统一 ajax 包装：返回原生 Promise，两个调用方都能 .then 或 await。 */
        function request(url, method, body) {
            return new Promise(function (resolve, reject) {
                $.ajax({
                    url: url, method: method || 'GET',
                    data: body ? JSON.stringify(body) : undefined,
                    contentType: body ? 'application/json' : undefined,
                    dataType: 'json', timeout: 30000
                }).done(function (resp) { resolve(resp || {}); })
                  .fail(function () { reject(new Error(authT('network_error', 'Network error'))); });
            });
        }

        function state(name) { return request(API.state + '?name=' + encodeURIComponent(name), 'GET'); }
        function start(name) { return request(API.start, 'POST', { name: name }); }
        function deviceStart(name) { return request(API.deviceStart, 'POST', { name: name }); }
        function status(name) { return request(API.status + '?name=' + encodeURIComponent(name), 'GET'); }
        function cancel(name) { return request(API.cancel, 'POST', { name: name }); }
        function token(name, value) { return request(API.token, 'POST', { name: name, token: value }); }
        function clear(name) { return request(API.clear, 'POST', { name: name }); }

        /** 桌面壳 on_new_window 把 _blank 转交系统浏览器（external_link.rs）。 */
        function openBrowser(url) {
            window.open(url, '_blank', 'noopener,noreferrer');
        }

        function stopPolling() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }
        function closeDialog() { stopPolling(); $('#mcpAuthOverlay').remove(); }

        /** 弹窗骨架：视觉与 .import-overlay / .import-dialog 同源（样式在 mcp-auth.css 内复刻）。 */
        function dialog(title, inner, footer) {
            closeDialog();
            generation++;
            var html = '<div class="mcp-auth-overlay" id="mcpAuthOverlay">'
                + '<div class="mcp-auth-dialog" role="dialog" aria-modal="true">'
                + '<div class="mcp-auth-header"><span class="mcp-auth-title" id="mcpAuthTitle"></span>'
                + '<button type="button" class="mcp-auth-close" id="mcpAuthClose" aria-label="'
                + esc(authT('common_close', 'Close')) + '">&times;</button></div>'
                + '<div class="mcp-auth-body">' + inner + '</div>'
                + '<div class="mcp-auth-footer">' + footer + '</div>'
                + '</div></div>';
            $('body').append(html);
            $('#mcpAuthTitle').text(title);
            $('#mcpAuthClose').on('click', function () { closeDialog(); });
            $('#mcpAuthOverlay').on('click', function (e) {
                if (e && e.target && e.target.id === 'mcpAuthOverlay') closeDialog();
            });
            return generation;
        }

        function errBox() { return '<div class="mcp-auth-error" id="mcpAuthError" style="display:none"></div>'; }
        function showError(msg) { $('#mcpAuthError').text(msg).show(); }
        function btn(id, cls, text, hidden) {
            return '<button type="button" class="mcp-auth-btn ' + cls + '" id="' + id + '"'
                + (hidden ? ' style="display:none"' : '') + '>' + esc(text) + '</button>';
        }
        /** 外链只放行 http(s)，且一律 target=_blank rel=noopener noreferrer。 */
        function safeExternal(url, text) {
            if (!/^https?:\/\//i.test(url || '')) return '';
            return '<a class="mcp-auth-help-link" href="' + esc(url)
                + '" target="_blank" rel="noopener noreferrer">' + esc(text) + '</a>';
        }
        function statusRow(busy, text) {
            return '<div class="mcp-auth-status"><span class="mcp-auth-status-dot'
                + (busy ? ' mcp-auth-status-dot-busy' : '') + '"></span><span>'
                + esc(text) + '</span></div>';
        }

        /* ── A. 静态 token 弹窗（对齐「邓白氏查全球 MCP 对接配置」） ── */
        function openTokenDialog(name, st, onDone) {
            var label = st.label || authT('auth_token_label', 'Access Token');
            var helpText = st.helpText || authT('auth_local_only', 'Stored only on this machine');
            var inner = '<div class="mcp-auth-help-text">' + esc(helpText) + '</div>'
                + safeExternal(st.helpUrl, authT('auth_get_token', 'How to get an Access Token?'))
                + '<label class="mcp-auth-field"><span class="mcp-auth-field-label">'
                + esc(label) + ' <b class="mcp-auth-required">*</b></span>'
                + '<input type="password" id="mcpAuthTokenInput" class="mcp-auth-input"'
                + ' autocomplete="new-password" spellcheck="false" placeholder="'
                + esc(authT('auth_token_placeholder', 'Paste Access Token')) + '"></label>'
                + errBox();
            var footer = btn('mcpAuthCancelBtn', 'mcp-auth-btn-ghost', authT('common_cancel', 'Cancel'))
                + btn('mcpAuthSaveBtn', 'mcp-auth-btn-primary', authT('auth_save_and_connect', 'Save and connect'));
            dialog(label, inner, footer);
            $('#mcpAuthCancelBtn').on('click', function () { closeDialog(); });
            $('#mcpAuthTokenInput').on('keydown', function (e) {
                if (e && e.key === 'Enter') $('#mcpAuthSaveBtn').trigger('click');
            });
            $('#mcpAuthSaveBtn').on('click', function () {
                var value = String($('#mcpAuthTokenInput').val() || '').trim();
                if (!value) { showError(authT('auth_token_required', 'Token is required')); return; }
                var $save = $('#mcpAuthSaveBtn');
                $save.prop('disabled', true);
                token(name, value).then(function (resp) {
                    if (resp && resp.ok === false) {
                        showError(resp.error || authT('auth_failed', 'Authorization failed'));
                        $save.prop('disabled', false);
                        return;
                    }
                    $('#mcpAuthTokenInput').val('');   // 明文绝不留在 DOM 里
                    closeDialog();
                    if (onDone) onDone();              // 继续原有安装 / 保存流程
                }).catch(function (e) {
                    showError((e && e.message) || authT('network_error', 'Network error'));
                    $save.prop('disabled', false);
                });
            });
        }

        /* ── B. OAuth 浏览器授权 ── */
        function beginOAuth(name, onDone, qrModal) {
            return start(name).then(function (r) {
                if (!r || !r.ok || !r.authorizationUrl) {
                    toast((r && r.error) || authT('auth_failed', 'Authorization failed'));
                    return false;
                }
                if (qrModal) { showQrModal(name, r.authorizationUrl, onDone); return false; }
                showWaiting(name, r.authorizationUrl, onDone);
                return false;
            }).catch(function (e) {
                toast((e && e.message) || authT('auth_failed', 'Authorization failed'));
                return false;
            });
        }

        /* ── B2. RFC 8628 Device Flow：user_code + 二维码页 + 倒计时 ── */
        function showDeviceCode(name, r, onDone) {
            var uri = r.verificationUri || '';
            var code = r.userCode || '';
            var secs = Math.max(1, Math.min(3600, Number(r.expiresIn) || 300));
            // verificationUriComplete 常是二维码页；只放行 https，绝不把任意 URL 塞进 iframe。
            var inner = statusRow(true, authT('auth_device_waiting', 'Waiting for authorization…'))
                + '<div class="mcp-auth-device-code" id="mcpAuthDeviceCode">' + esc(code) + '</div>'
                + '<div class="mcp-auth-help-text">'
                + esc(authT('auth_device_hint', 'Scan the QR code or open the link, then confirm this code on your phone or in the browser.'))
                + '</div>'
                + '<div class="mcp-auth-countdown" id="mcpAuthCountdown"></div>'
                + safeExternal(uri, authT('auth_device_open', 'Open authorization page'))
                + errBox();
            var gen = dialog(authT('auth_device_title', 'Scan to authorize'), inner,
                btn('mcpAuthCancelBtn', 'mcp-auth-btn-ghost', authT('common_cancel', 'Cancel'))
                + btn('mcpAuthRetryBtn', 'mcp-auth-btn-primary', authT('market.retry', 'Retry'), true));

            var deadline = Date.now() + secs * 1000;
            var cdTimer = null;
            function tickCountdown() {
                if (gen !== generation) { if (cdTimer) clearInterval(cdTimer); return; }
                var left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
                var m = Math.floor(left / 60), s = left % 60;
                $('#mcpAuthCountdown').text(
                    authT('auth_device_expires', 'Expires in') + ' ' + m + ':' + (s < 10 ? '0' : '') + s);
                if (left === 0 && cdTimer) clearInterval(cdTimer);
            }
            tickCountdown();
            cdTimer = setInterval(tickCountdown, 1000);

            $('#mcpAuthCancelBtn').on('click', function () {
                generation++; stopPolling();
                cancel(name).catch(function () {});
                closeDialog();
            });
            $('#mcpAuthRetryBtn').on('click', function () {
                generation++; stopPolling(); closeDialog(); beginDeviceFlow(name, onDone);
            });
            pollStatus(name, gen, onDone);
        }

        function beginDeviceFlow(name, onDone) {
            return deviceStart(name).then(function (r) {
                if (!r || !r.ok || !r.userCode) {
                    toast((r && r.error) || authT('auth_failed', 'Authorization failed'));
                    return false;
                }
                showDeviceCode(name, r, onDone);
                return false;
            }).catch(function (e) {
                toast((e && e.message) || authT('auth_failed', 'Authorization failed'));
                return false;
            });
        }

        /**
         * Is `url` safe to load into an in-app iframe?
         *
         * Parses rather than prefix-matching `/^https:\/\//i`: this URL comes
         * from an authorization server discovered over the network, and a prefix
         * check can be satisfied by a string that a real browser will resolve
         * somewhere else entirely. `new URL(...)` is what the browser itself
         * will use for `iframe.src`, so testing the parsed `protocol` means the
         * check and the load cannot disagree.
         *
         * Returns false for anything unparseable, so a malformed or relative
         * URL fails closed instead of being handed to the iframe.
         */
        function isHttpsUrl(url) {
            try {
                return new URL(String(url == null ? '' : url)).protocol === 'https:';
            } catch (e) {
                return false;
            }
        }

        /* ── B3. authQrModal：应用内 iframe 展示服务方二维码授权页 ── */
        function showQrModal(name, url, onDone) {
            // iframe 只允许 https，且必须带 sandbox：服务方授权页无需访问父窗口。
            if (!isHttpsUrl(url)) {
                toast(authT('auth_qr_https_only', 'In-app QR authorization requires an https URL'));
                return false;
            }
            var inner = statusRow(true, authT('auth_waiting', 'Waiting for browser authorization…'))
                + '<div class="mcp-auth-help-text">'
                + esc(authT('auth_qr_hint', 'Scan the QR code in the panel below and confirm on your phone.')) + '</div>'
                // sandbox 说明：`allow-same-origin` 与 `allow-scripts` 同时出现时，
                // 页内脚本可以摘掉自己的 sandbox 属性。这里仍然保留二者，是因为
                // 不少服务方授权页需要读自身 cookie/localStorage 才能显示二维码
                // 并在手机确认后自动跳转；去掉 allow-same-origin 会让这些页面
                // 直接白屏。风险可接受的依据：src 强制 https（见上）、
                // referrerpolicy=no-referrer、且加载的是**跨源第三方页面**，
                // 它本就与父窗口同源隔离，摘掉 sandbox 后能拿到的仍只是它自己的
                // origin。不要在没有实测目标授权页的情况下改动这一行。
                + '<iframe class="mcp-auth-qr-frame" id="mcpAuthQrFrame" src="' + esc(url)
                + '" sandbox="allow-forms allow-scripts allow-same-origin allow-popups" '
                + 'referrerpolicy="no-referrer" title="authorization"></iframe>'
                + safeExternal(url, authT('auth_device_open', 'Open authorization page'))
                + errBox();
            var gen = dialog(authT('auth_qr_title', 'Scan the QR code to authorize'), inner,
                btn('mcpAuthCancelBtn', 'mcp-auth-btn-ghost', authT('common_cancel', 'Cancel'))
                + btn('mcpAuthRetryBtn', 'mcp-auth-btn-primary', authT('market.retry', 'Retry'), true));
            $('#mcpAuthCancelBtn').on('click', function () {
                generation++; stopPolling(); cancel(name).catch(function () {}); closeDialog();
            });
            $('#mcpAuthRetryBtn').on('click', function () {
                generation++; stopPolling(); closeDialog(); beginOAuth(name, onDone, true);
            });
            pollStatus(name, gen, onDone);
            return false;
        }

        function showWaiting(name, url, onDone) {
            var gen = dialog(authT('auth_connect_title', 'Connect & authorize'),
                statusRow(true, authT('auth_waiting', 'Waiting for browser authorization…'))
                + '<div class="mcp-auth-help-text">'
                + esc(authT('auth_browser_hint', 'Finish the authorization in the browser window.')) + '</div>'
                + safeExternal(url, authT('market.connect', 'Connect'))
                + errBox(),
                btn('mcpAuthCancelBtn', 'mcp-auth-btn-ghost', authT('common_cancel', 'Cancel'))
                + btn('mcpAuthRetryBtn', 'mcp-auth-btn-primary', authT('market.retry', 'Retry'), true));

            // 拿到 authorizationUrl 后立刻打开系统浏览器，绝不拖到轮询里。
            openBrowser(url);

            $('#mcpAuthCancelBtn').on('click', function () {
                generation++;
                stopPolling();
                cancel(name).catch(function () {});
                closeDialog();
            });
            $('#mcpAuthRetryBtn').on('click', function () {
                generation++;
                stopPolling();
                closeDialog();
                beginOAuth(name, onDone);
            });
            pollStatus(name, gen, onDone);
        }

        function pollStatus(name, gen, onDone) {
            var deadline = Date.now() + MAX_WAIT_MS;
            function tick() {
                if (gen !== generation) return;
                if (Date.now() > deadline) {
                    stopPolling();
                    showError(authT('auth_timeout', 'Authorization timed out, please retry'));
                    $('#mcpAuthRetryBtn').show();
                    return;
                }
                status(name).then(function (s) {
                    if (gen !== generation) return;
                    var phase = (s && s.phase) || 'idle';
                    if (phase === 'done') {
                        stopPolling(); closeDialog();
                        if (onDone) onDone();
                        return;
                    }
                    if (phase === 'failed' || phase === 'cancelled') {
                        stopPolling();
                        showError((s && s.error) || authT('auth_failed', 'Authorization failed'));
                        $('#mcpAuthRetryBtn').show();
                        return;
                    }
                    // preparing / waiting_for_browser / exchanging / idle 继续轮询
                    pollTimer = setTimeout(tick, POLL_MS);
                }).catch(function () {
                    if (gen !== generation) return;
                    pollTimer = setTimeout(tick, POLL_MS);
                });
            }
            pollTimer = setTimeout(tick, POLL_MS);
        }

        /* ── 已有凭据：已连接 / 重新连接 / 清除凭据 ── */
        function openManageDialog(name, st, onDone) {
            var label = st.label || name;
            var inner = statusRow(false, authT('auth_connected', 'Connected'))
                + '<div class="mcp-auth-help-text">'
                + esc(st.helpText || authT('auth_local_only', 'Stored only on this machine')) + '</div>'
                + safeExternal(st.helpUrl, authT('auth_get_token', 'How to get an Access Token?'))
                + errBox();
            var footer = btn('mcpAuthClearBtn', 'mcp-auth-btn-ghost', authT('auth_clear', 'Clear credential'))
                + btn('mcpAuthReconnectBtn', 'mcp-auth-btn-ghost', authT('auth_reconnect', 'Reconnect'))
                + btn('mcpAuthDoneBtn', 'mcp-auth-btn-primary', authT('market.connect', 'Connect'));
            dialog(label, inner, footer);
            $('#mcpAuthClearBtn').on('click', function () {
                clear(name).then(function (r) {
                    if (r && r.ok === false) {
                        showError(r.error || authT('auth_failed', 'Authorization failed'));
                        return;
                    }
                    closeDialog();
                    if (onDone) onDone();
                }).catch(function (e) {
                    showError((e && e.message) || authT('network_error', 'Network error'));
                });
            });
            $('#mcpAuthReconnectBtn').on('click', function () {
                closeDialog();
                clear(name).catch(function () {}).then(function () { return openDialog(name, onDone); });
            });
            $('#mcpAuthDoneBtn').on('click', function () { closeDialog(); if (onDone) onDone(); });
        }

        /**
         * 统一分流入口。返回 Promise<boolean>：
         *   true  = authType == 'none' / 接口不可用，调用方立即继续原流程；
         *   false = 弹窗已接管，认证成功后由 onDone 继续原流程。
         */
        function openDialog(name, onDone) {
            if (!name) return Promise.resolve(true);
            return state(name).then(function (st) {
                if (!st || st.ok === false) return true;
                var kind = st.authType || 'none';
                if (kind === 'none') return true;                 // 原行为不变
                if (st.connected && !st.needsAuth) {
                    // 已有凭据：显示「已连接 / 重新连接 / 清除凭据」，但不阻塞本次
                    // 保存或安装（编辑已连接的服务器仍必须能提交表单）。
                    openManageDialog(name, st, null);
                    return true;
                }
                if (st.needsAuth && kind === 'token') { openTokenDialog(name, st, onDone); return false; }
                if (st.needsAuth && kind === 'oauth') {
                    // Device Flow 优先：它不开系统浏览器，弹窗内显示 user_code / 二维码页。
                    if (st.authDeviceFlow) return beginDeviceFlow(name, onDone);
                    return beginOAuth(name, onDone, !!st.authQrModal);
                }
                return true;
            }).catch(function () { return true; });               // 认证异常不得阻断可用连接器
        }

        window.McpAuth = {
            state: state, start: start, status: status, cancel: cancel,
            token: token, clear: clear,
            openDialog: openDialog, openBrowser: openBrowser,
            deviceStart: deviceStart, beginDeviceFlow: beginDeviceFlow, showQrModal: showQrModal,
            // 语义别名与细分入口，供两个页面按需取用
            ensureConnected: openDialog,
            openTokenDialog: openTokenDialog, openManageDialog: openManageDialog,
            showWaiting: showWaiting, closeDialog: closeDialog, stopPolling: stopPolling,
            POLL_MS: POLL_MS, MAX_WAIT_MS: MAX_WAIT_MS
        };
    })();
    /* MCP-AUTH-MODULE-END */

    var core = window._settingsCore;
    var escapeHtml = core.escapeHtml;
    var escapeAttr = core.escapeAttr;
    var parseKvLines = core.parseKvLines;
    var postJson = core.postJson;
    var showToast = core.showToast;
    var setScopeValue = core.setScopeValue;
    var setScopeReadonly = core.setScopeReadonly;

    var $mcpServerList = $('#mcpServerList');
    var $mcpSaveBtn = $('#mcpSaveBtn');
    var $mcpFormTitle = $('#mcpFormTitle');
    var $mcpListView = $('#mcpListView');
    var $mcpFormView = $('#mcpFormView');
    var $mcpTypeBtns = $('#mcpAddForm .mcp-type-btn');
    var $mcpCheckResult = $('#mcpCheckResult');
    var $mcpToolsView = $('#mcpToolsView');
    var $mcpToolsList = $('#mcpToolsList');
    var $mcpToolsTitle = $('#mcpToolsTitle');
    var mcpEditName = null;
    // 当前编辑对象的原始类型（无匹配类型按钮时作为兜底，如 streamable_stateless）
    var mcpEditType = null;
    var mcpCachedList = [];

    function showMcpListView() { $mcpToolsView.hide(); $mcpFormView.hide(); $mcpListView.addClass('slide-back').show(); setTimeout(function(){ $mcpListView.removeClass('slide-back'); }, 260); }
    function showMcpFormView(title, isEdit) { $mcpToolsView.hide(); $mcpFormTitle.text(title || GourdI18n.t('settings.mcp.add')); $mcpListView.hide(); $mcpFormView.show(); $('#mcpFormActions').toggle(!!isEdit); }
    function setMcpType(type) {
        $mcpTypeBtns.removeClass('active');
        $mcpTypeBtns.filter('[data-type="' + type + '"]').addClass('active');
        $('#mcpConfigStdio').toggle(type === 'stdio');
        // streamable_stateless 为导入场景的合法类型，编辑时按远程配置区展示
        var isRemote = type === 'sse' || type === 'streamable' || type === 'streamable_stateless';
        $('#mcpConfigRemote').toggle(isRemote);
        // 认证凭据（token / OAuth）由 resolve_auth_headers 注入，仅 HTTP 传输有请求头；
        // stdio 只把 config.env 交给子进程，不消费 CredentialVault。若此处允许 stdio
        // 选择 token/oauth，会造出「用户存了凭据却永远不注入」的静默空转。
        $('#mcpAuthTypeGroup').toggle(isRemote);
        if (!isRemote) $('#mcpAuthType').val('none');
    }

    // ==================== MCP 管理 ====================

    function loadMcpList() {
        $mcpToolsView.hide();
        $mcpFormView.hide();
        $mcpListView.show();
        $.get('/web/settings/mcp/servers', function (resp) {
            if (resp.code === 200 && resp.data) {
                mcpCachedList = resp.data;
                renderMcpList(resp.data);
            }
        }).fail(function () { console.error('[Settings] Failed to load MCP servers'); });
    }

    function renderMcpList(list) {
        var html = '';
        var tWorkspace = GourdI18n.t('settings.general.scope_workspace');
        var tEdit = GourdI18n.t('common.edit');
        var tDelete = GourdI18n.t('common.delete');
        var tEnable = GourdI18n.t('settings.loop.enable');
        var tDisable = GourdI18n.t('settings.loop.disable');
        if (!list || list.length === 0) {
            html = '<div class="mcp-empty-state">'
                + '<div class="mcp-empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg></div>'
                + '<div class="mcp-empty-title">' + GourdI18n.t('settings.mcp.empty') + '</div>'
                + '<div class="mcp-empty-desc">' + GourdI18n.t('settings.mcp.empty_desc') + '</div>'
                + '</div>';
        } else {
            var iconMap = { stdio: 'S', sse: 'R', streamable: 'H' };
            list.forEach(function (item) {
                var name = item.name || '';
                var type = item.type || 'stdio';
                var detail = type === 'stdio' ? (item.command || '') : (item.url || '');
                var icon = iconMap[type] || 'M';
                html += '<div class="mcp-server-item' + (item.enabled === false ? ' disabled' : '') + '" data-name="' + escapeAttr(name) + '">'
                    + '<div class="mcp-server-icon">' + escapeHtml(icon) + '</div>'
                    + '<div class="mcp-server-info">'
                    + '<div class="mcp-server-name">' + escapeHtml(name) + ' <span class="settings-inline-tag">[' + escapeHtml(type) + ']</span>' + (item.scope === 'workspace' ? ' <span class="settings-scope-badge">' + tWorkspace + '</span>' : '') + '</div>'
                    + (detail ? '<div class="mcp-server-detail">' + escapeHtml(detail) + '</div>' : '')
                    + '</div><div class="mcp-server-actions">'
                    + '<button class="mcp-action-btn edit mcp-edit-btn" data-name="' + escapeAttr(name) + '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>'
                    + '<button class="mcp-action-btn delete mcp-delete-btn" data-name="' + escapeAttr(name) + '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>'
                    + '<label class="toggle-switch">'
                    + '<input type="checkbox" ' + (item.enabled !== false ? 'checked' : '') + ' data-name="' + escapeAttr(name) + '" class="mcp-toggle"/>'
                    + '<span class="toggle-slider"></span>'
                    + '</label>'
                    + '</div></div>';
            });
        }
        $mcpServerList.html(html);
    }

    // MCP 列表事件委托
    $mcpServerList
        .on('click', '.mcp-action-btn.edit.mcp-edit-btn', function (e) {
            e.stopPropagation();
            var name = $(this).attr('data-name');
            if (name) mcpEditServer(name);
        })
        .on('click', '.mcp-delete-btn', function (e) {
            e.stopPropagation();
            mcpConfirmRemoveServer($(this).attr('data-name'));
        })
        .on('click', '.mcp-server-item', function (e) {
            if ($(e.target).closest('.toggle-switch').length) return;
            if ($(e.target).closest('.mcp-action-btn').length) return;
            var name = $(this).attr('data-name');
            if (name) showMcpTools(name);
        })
        .on('change', '.mcp-toggle', function () {
            mcpToggleServer($(this).attr('data-name'), this.checked);
        });

    // MCP 工具列表查看
    function showMcpTools(name) {
        $mcpListView.hide();
        $mcpFormView.hide();
        $mcpToolsView.show();
        $mcpToolsTitle.text(name + ' - ' + GourdI18n.t('settings.mcp.tools_title'));
        $mcpToolsList.html('<div class="mcp-empty-state"><div class="skills-loading" style="display:block"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg><span>' + GourdI18n.t('common.loading') + '</span></div></div>');
        $.get('/web/settings/mcp/servers/tools?name=' + encodeURIComponent(name), function (resp) {
            if (resp.code === 200 && resp.data) {
                renderMcpTools(resp.data, name);
            } else {
                $mcpToolsList.html('<div class="mcp-empty-state"><div class="mcp-empty-title">' + escapeHtml(resp.message || GourdI18n.t('settings.network_error')) + '</div></div>');
            }
        }).fail(function () {
            $mcpToolsList.html('<div class="mcp-empty-state"><div class="mcp-empty-title">' + GourdI18n.t('settings.network_error') + '</div></div>');
        });
    }

    // 当前工具列表所在的 serverName
    var mcpToolsServerName = '';

    /** 更新工具栏计数和全选状态 */
    function updateMcpToolsToolbar() {
        var $toggles = $mcpToolsList.find('.mcp-tool-toggle');
        var total = $toggles.length;
        var checked = $toggles.filter(':checked').length;
        $('#mcpToolsCount').text(checked + ' / ' + total + ' ' + GourdI18n.t('settings.loop.enable'));
        $('#mcpToolsSelectAll').prop('checked', total > 0 && checked === total);
    }

    function renderMcpTools(data, name) {
        mcpToolsServerName = name;
        var connected = data.connected !== false;
        var $toolbar = $('#mcpToolsToolbar');
        var tEnable = GourdI18n.t('settings.loop.enable');
        var tDisable = GourdI18n.t('settings.loop.disable');

        if (!connected) {
            $toolbar.hide();
            $mcpToolsList.html('<div class="mcp-empty-state">'
                + '<div class="mcp-empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg></div>'
                + '<div class="mcp-empty-title">' + GourdI18n.t('settings.channel.channel_status_not_connected') + '</div>'
                + '<div class="mcp-empty-desc">' + GourdI18n.t('settings.mcp.desc') + '</div></div>');
            return;
        }
        var tools = data.tools || [];
        if (tools.length === 0) {
            $toolbar.hide();
            $mcpToolsList.html('<div class="mcp-empty-state">'
                + '<div class="mcp-empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="1.5"><rect x="2" y="2" width="20" height="20" rx="3"/><path d="M7 8h10M7 12h6M7 16h8"/></svg></div>'
                + '<div class="mcp-empty-title">' + GourdI18n.t('settings.mcp.no_tools') + '</div>'
                + '<div class="mcp-empty-desc">' + GourdI18n.t('settings.mcp.no_tools_desc') + '</div></div>');
            return;
        }

        // 获取已禁用的工具列表
        var disallowedTools = data.disallowedTools || [];
        var disallowedMap = {};
        disallowedTools.forEach(function (t) { disallowedMap[t] = true; });

        // 显示工具栏
        $toolbar.show();
        var checkedCount = tools.filter(function (t) { return !disallowedMap[t.name]; }).length;
        $('#mcpToolsCount').text(checkedCount + ' / ' + tools.length + ' ' + GourdI18n.t('settings.loop.enable'));
        $('#mcpToolsSelectAll').prop('checked', checkedCount === tools.length);

        var html = '';
        tools.forEach(function (tool) {
            var toolName = tool.name || '';
            var isEnabled = !disallowedMap[toolName];
            html += '<div class="mcp-server-item mcp-tool-item" data-tool="' + escapeAttr(toolName) + '">'
                + '<label class="mcp-tool-checkbox">'
                + '<input type="checkbox" ' + (isEnabled ? 'checked' : '') + ' data-tool="' + escapeAttr(toolName) + '" class="mcp-tool-toggle"/>'
                + '<span class="mcp-tool-checkmark"></span>'
                + '</label>'
                + '<div class="mcp-server-icon">T</div>'
                + '<div class="mcp-server-info">'
                + '<div class="mcp-server-name">' + escapeHtml(toolName) + '</div>'
                + (tool.description ? '<div class="mcp-server-detail">' + escapeHtml(tool.description) + '</div>' : '')
                + '</div></div>';
        });
        $mcpToolsList.html(html);
    }

    $('#mcpToolsBackBtn').on('click', function () {
        $mcpToolsView.hide();
        $('#mcpToolsToolbar').hide();
        $mcpListView.addClass('slide-back').show();
        setTimeout(function(){ $mcpListView.removeClass('slide-back'); }, 260);
    });

    // 工具开关变化 → 实时更新计数和全选状态
    $mcpToolsList.on('change', '.mcp-tool-toggle', function () {
        updateMcpToolsToolbar();
    });

    // 全选/取消全选
    $('#mcpToolsSelectAll').on('change', function () {
        var checked = this.checked;
        $mcpToolsList.find('.mcp-tool-toggle').prop('checked', checked);
        updateMcpToolsToolbar();
    });

    // 保存工具权限（提交未勾选的作为 disallowedTools）
    $('#mcpToolsSaveBtn').on('click', function () {
        if (!mcpToolsServerName) return;
        var disallowedTools = [];
        $mcpToolsList.find('.mcp-tool-toggle:not(:checked)').each(function () {
            disallowedTools.push($(this).attr('data-tool'));
        });
        var $btn = $(this);
        $btn.prop('disabled', true);
        postJson('/web/settings/mcp/servers/tools/save',
            { serverName: mcpToolsServerName, disallowedTools: disallowedTools },
            function (resp) {
                if (resp.code === 200) showToast(GourdI18n.t('settings.saved'));
                else showToast(GourdI18n.t('settings.save_failed') + ': ' + (resp.message || GourdI18n.t('common.unknown_error')), 'error');
            },
            function () { $btn.prop('disabled', false); }
        );
    });

    // ==================== MCP 表单 ====================

    function resetMcpForm() {
        mcpEditName = null;
        mcpEditType = null;
        $mcpSaveBtn.text(GourdI18n.t('common.save'));
        $('#mcpName').val('').prop('readOnly', false).removeClass('readonly-gray');
        $('#mcpCommand, #mcpArgs, #mcpEnv, #mcpRemoteUrl, #mcpHeaders, #mcpTimeout').val('');
        $('#mcpAuthType').val('none');
        setScopeValue('mcpScope', 'user');
        setScopeReadonly('mcpScope', false);
        setMcpType('stdio');
    }

    function fillMcpForm(server) {
        var type = server.type || 'stdio';
        setMcpType(type);
        setScopeValue('mcpScope', server.scope || 'user');
        // 回显认证声明（非密钥）：嵌套 auth 优先，兼容旧版扁平 authType。
        var authDecl = (server.auth && typeof server.auth === 'object') ? server.auth : {};
        $('#mcpAuthType').val(authDecl.authType || server.authType || 'none');

        if (type === 'stdio') {
            $('#mcpCommand').val(server.command || '');
            $('#mcpArgs').val((server.args || []).join('\n'));
            var envLines = [];
            if (server.env) Object.keys(server.env).forEach(function (k) { envLines.push(k + '=' + server.env[k]); });
            $('#mcpEnv').val(envLines.join('\n'));
        } else {
            $('#mcpRemoteUrl').val(server.url || '');
            var headerLines = [];
            if (server.headers) Object.keys(server.headers).forEach(function (k) { headerLines.push(k + '=' + server.headers[k]); });
            $('#mcpHeaders').val(headerLines.join('\n'));
            $('#mcpTimeout').val(server.timeout || '');
        }
    }

    function buildMcpBodyObj() {
        var name = $('#mcpName').val().trim();
        // 无匹配类型按钮时（如 streamable_stateless）回落到编辑对象的原始类型
        var type = $('#mcpAddForm .mcp-type-btn.active').attr('data-type') || mcpEditType || 'stdio';
        var tName = GourdI18n.t('common.name');
        var tCommand = GourdI18n.t('settings.mcp.command');
        var tUrl = GourdI18n.t('settings.mcp.url');
        if (!name) { showToast(tName + GourdI18n.t('common.required'), 'error'); return null; }
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) { showToast(tName + GourdI18n.t('settings.mcp.name_placeholder'), 'error'); return null; }

        var bodyObj = { name: name, type: type, enabled: true, scope: $('#mcpScope').val() || 'user' };

        if (type === 'stdio') {
            var command = $('#mcpCommand').val().trim();
            if (!command) { showToast(tCommand + GourdI18n.t('common.required'), 'error'); return null; }
            bodyObj.command = command;
            var argsText = $('#mcpArgs').val().trim();
            if (argsText) bodyObj.args = argsText.split('\n').filter(function (l) { return l.trim() !== ''; });
            var env = parseKvLines($('#mcpEnv').val().trim());
            if (Object.keys(env).length > 0) bodyObj.env = env;
        } else if (type === 'sse' || type === 'streamable' || type === 'streamable_stateless') {
            var url = $('#mcpRemoteUrl').val().trim();
            if (!url) { showToast(tUrl + GourdI18n.t('common.required'), 'error'); return null; }
            if (!/^https?:\/\/.+/.test(url)) { showToast(tUrl + GourdI18n.t('settings.mcp.url_placeholder'), 'error'); return null; }
            bodyObj.url = url;
            var headers = parseKvLines($('#mcpHeaders').val().trim());
            if (Object.keys(headers).length > 0) bodyObj.headers = headers;
            var timeout = $('#mcpTimeout').val().trim();
            if (timeout) bodyObj.timeout = parseTimeout(timeout) || timeout;
            // 认证声明（非密钥）：只有 authType 落 settings.json，真正的凭据由
            // /mcp/auth/token 或 OAuth /mcp/auth/start 写进本机 CredentialVault。
            // 不写这一段，/auth/state 恒返回 none，所有 token / OAuth 弹窗永不触发。
            // stdio 不消费 vault 凭据（见 setMcpType），因此这里只对 HTTP 家族声明。
            var authKind = $('#mcpAuthType').val() || 'none';
            bodyObj.auth = { authType: authKind === 'token' || authKind === 'oauth' ? authKind : 'none' };
        }
        return bodyObj;
    }

    function mcpEditServer(name) {
        var server = mcpCachedList.find(function (s) { return s.name === name; });
        if (!server) return;
        mcpEditName = name;
        mcpEditType = server.type || 'stdio';
        showMcpFormView(GourdI18n.t('settings.mcp.edit_title'), true);
        $mcpSaveBtn.text(GourdI18n.t('settings.loop.updated'));
        $('#mcpName').val(server.name).prop('readOnly', true).addClass('readonly-gray');
        fillMcpForm(server);
    }

    function mcpCopyServer(name) {
        var server = mcpCachedList.find(function (s) { return s.name === name; });
        if (!server) return;
        mcpEditName = null;
        mcpEditType = server.type || 'stdio';
        showMcpFormView(GourdI18n.t('settings.mcp.add_title'), false);
        $mcpSaveBtn.text(GourdI18n.t('common.save'));
        $('#mcpName').val(server.name + '-copy').prop('readOnly', false).removeClass('readonly-gray');
        fillMcpForm(server);
    }

    function mcpRemoveServer(name) {
        postJson('/web/settings/mcp/servers/remove', { name: name }, function (resp) {
            if (resp.code === 200) { showMcpListView(); loadMcpList(); }
            else showToast(GourdI18n.t('settings.loop.delete_failed') + ': ' + (resp.message || GourdI18n.t('common.unknown_error')), 'error');
        });
    }

    // 统一的删除确认（列表行删除按钮与表单页删除按钮共用）
    function mcpConfirmRemoveServer(name) {
        if (!name) return;
        layConfirm(GourdI18n.t('settings.confirm_delete') + ' MCP ' + GourdI18n.t('settings.mcp.title') + ' "' + name + '"？', function () {
            mcpRemoveServer(name);
        });
    }

    function mcpToggleServer(name, enabled) {
        postJson('/web/settings/mcp/servers/toggle', { name: name, enabled: enabled }, function (resp) {
            if (resp.code !== 200) { showToast(GourdI18n.t('settings.loop.operation_failed') + ': ' + (resp.message || GourdI18n.t('common.unknown_error')), 'error'); }
            else if (resp.connected === false) { showToast(resp.connectError || GourdI18n.t('settings.loop.operation_failed'), 'error'); }
            // 无论成败都刷新列表，确保开关状态与服务端一致
            loadMcpList();
        });
    }

    // MCP 按钮事件
    $('#mcpAddBtn').on('click', function () { resetMcpForm(); showMcpFormView(GourdI18n.t('settings.mcp.add_title'), false); });
    $('#mcpBackBtn').on('click', function () { showMcpListView(); resetMcpForm(); });

    $mcpTypeBtns.on('click', function () { setMcpType($(this).attr('data-type')); });

    $mcpSaveBtn.on('click', function () {
        var bodyObj = buildMcpBodyObj();
        if (!bodyObj) return;
        var isEdit = !!mcpEditName;
        var url = isEdit ? '/web/settings/mcp/servers/update' : '/web/settings/mcp/servers/add';
        var actionText = isEdit ? GourdI18n.t('settings.loop.updated') : GourdI18n.t('common.add');
        var auth = window.McpAuth || {};

        /** 原保存请求。保存成功后才查询认证状态（/auth/state 要求连接器已落盘）。 */
        function doSave() {
            $mcpSaveBtn.prop('disabled', true);
            $.ajax({ url: url, method: 'POST', data: JSON.stringify(bodyObj), contentType: 'application/json', dataType: 'json' })
                .done(function (resp) {
                    if (resp.code === 200) {
                        loadMcpList(); showMcpListView(); resetMcpForm();
                        if (resp.connected === false) {
                            // 配置已落盘但连接失败：如实提示后端给出的原因，不能显示
                            // 「操作成功」让用户以为服务器已可用（这正是曾经的假成功缺陷）。
                            showToast(resp.connectError || (actionText + GourdI18n.t('settings.loop.operation_failed')), 'error');
                        } else {
                            showToast(actionText + GourdI18n.t('settings.loop.operation_success'));
                        }
                        /* 配置落盘后按名称查询 /auth/state?name= 判断分支：
                         * authType == 'none'（或接口不可用）时 openDialog 立即放行且
                         * 什么都不弹，原保存流程完全不变；token/oauth 时弹出模态框，
                         * 认证成功后刷新列表（重新连接）。 */
                        if (typeof auth.openDialog === 'function') {
                            Promise.resolve(auth.openDialog(bodyObj.name, function () { loadMcpList(); }))
                                .catch(function () {});
                        }
                    }
                    else showToast(actionText + GourdI18n.t('settings.loop.operation_failed') + ': ' + (resp.message || GourdI18n.t('common.unknown_error')), 'error');
                })
                .fail(function () { showToast(GourdI18n.t('settings.network_error'), 'error'); })
                .always(function () { $mcpSaveBtn.prop('disabled', false); });
        }

        /* 编辑已存在的连接器：保存前先查 /auth/state，若已声明 token/oauth 且
         * needsAuth，点「保存并连接」不直接提交配置，先弹认证框；认证成功后
         * 再提交原有保存流程。新增态后端尚无该 name，必须先落盘再认证。 */
        var authName = isEdit ? mcpEditName : bodyObj.name;
        if (isEdit && typeof auth.openDialog === 'function') {
            Promise.resolve(auth.openDialog(authName, doSave)).then(function (proceed) {
                if (proceed) doSave();
            }).catch(function () { doSave(); });
        } else {
            doSave();
        }
    });

    // MCP 表单 - 复制按钮
    $('#mcpFormCopyBtn').on('click', function () {
        var name = mcpEditName;
        if (!name) return;
        mcpCopyServer(name);
    });
    // MCP 表单 - 删除按钮
    $('#mcpFormDeleteBtn').on('click', function () {
        mcpConfirmRemoveServer(mcpEditName);
    });


    // MCP 检测连接
    $('#mcpCheckBtn').on('click', function () {
        var bodyObj = buildMcpBodyObj();
        if (!bodyObj) return;
        var $btn = $(this);
        var btnOriginal = $btn.html();
        $btn.prop('disabled', true).html('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> ' + GourdI18n.t('settings.mcp.check_connection'));
        $mcpCheckResult.hide();

        $.ajax({ url: '/web/settings/mcp/servers/check', method: 'POST', data: JSON.stringify(bodyObj), contentType: 'application/json', dataType: 'json', timeout: 15000 })
            .done(function (resp) {
                var ok = resp.code === 200;
                var svg = ok
                    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> '
                    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> ';
                $mcpCheckResult.attr('class', 'mcp-check-result ' + (ok ? 'success' : 'error'))
                    .html(svg + escapeHtml(resp.message || (ok ? GourdI18n.t('settings.connect_success') : GourdI18n.t('settings.connect_failed'))))
                    .css('display', 'flex');
            })
            .fail(function (jqXHR, textStatus) {
                var msg = textStatus === 'timeout' ? GourdI18n.t('settings.mcp.check_timeout') : GourdI18n.t('settings.network_error');
                $mcpCheckResult.attr('class', 'mcp-check-result error').html(msg).css('display', 'flex');
            })
            .always(function () { $btn.prop('disabled', false).html(btnOriginal); });
    });

    // ==================== MCP 导入（增强版） ====================
    
    // 导入状态跟踪，用于回滚
    var lastImportSession = null;
    var importPreviewDialog = null;
    
    /**
     * 统一解析 timeout 值，兼容多种格式
     * 支持: 30, "30", "30s", "30S", "PT30S" (ISO-8601)
     * @param {*} val - timeout 原始值
     * @returns {string|null} ISO-8601 格式的 duration 字符串，如 "PT30S"
     */
    function parseTimeout(val) {
        if (val === undefined || val === null || val === '') return null;
        if (typeof val === 'number') {
            return 'PT' + val + 'S';
        }
        var str = String(val).trim().toUpperCase();
        // 已经是 ISO-8601 格式
        if (/^PT\d+(\.\d+)?[SMHD]$/.test(str)) {
            return str;
        }
        // 纯数字字符串
        if (/^\d+$/.test(str)) {
            return 'PT' + str + 'S';
        }
        // 数字 + s/m/h/d 后缀
        var match = str.match(/^(\d+(\.\d+)?)\s*([SMHD])?$/);
        if (match) {
            var num = match[1];
            var unit = match[3] || 'S';
            return 'PT' + num + unit;
        }
        // 无法识别，原样返回（后端可能会报错）
        return str;
    }
    
    /**
     * 创建导入预览对话框（适配后端返回的结构化数据）
     * @param {{format:string, servers:Array}} data - 后端返回的解析结果
     * @param {Function} onConfirm - 确认回调，接收选中的服务器名列表
     */
    function showImportPreview(data, onConfirm) {
        var servers = data.servers || [];
        if (servers.length === 0) {
            showToast(GourdI18n.t('settings.mcp.import') + GourdI18n.t('common.no_data'), 'error');
            return;
        }
        
        // 构建各服务器的预览信息
        var previewItems = '';
        var tExists = GourdI18n.t('settings.mcp.import_exists');
        var tNew = GourdI18n.t('settings.mcp.import_new');
        var tFormatError = GourdI18n.t('settings.mcp.import_format_error');
        servers.forEach(function(srv) {
            var name = srv.name || '';
            var typeLabel = srv.type || 'stdio';
            var detail = srv.detail || '';
            
            var exists = mcpCachedList.some(function(s) { return s.name === name; });
            var statusBadge = exists
                ? '<span class="import-preview-badge badge-exists">' + tExists + '</span>'
                : '<span class="import-preview-badge badge-new">' + tNew + '</span>';
            var disabled = exists ? ' disabled' : '';
            
            var errorBadge = srv.error
                ? '<span class="import-preview-badge badge-error">' + tFormatError + '</span>'
                : '';
            
            previewItems += '<div class="import-preview-item">'
                + '<label class="import-preview-checkbox' + disabled + '">'
                + '<input type="checkbox" class="import-server-checkbox" value="' + escapeAttr(name) + '"'
                + (exists || srv.error ? '' : ' checked') + disabled + '/>'
                + '<span class="mcp-tool-checkmark"></span>'
                + '</label>'
                + '<div class="import-preview-info">'
                + '<div class="import-preview-name">' + escapeHtml(name) + ' <span class="settings-inline-tag">[' + escapeHtml(typeLabel) + ']</span>' + statusBadge + errorBadge + '</div>'
                + '<div class="import-preview-detail">' + escapeHtml(detail || srv.error || '') + '</div>'
                + '</div></div>';
        });
        
        // 检测来源格式标签
        var formatLabel = data.format || GourdI18n.t('settings.mcp.import_auto_detect');
        var formatTag = '<span class="import-format-tag">' + escapeHtml(formatLabel) + '</span>';
        
        var tCancel = GourdI18n.t('common.cancel');
        var tImport = GourdI18n.t('settings.mcp.import');
        var dialogHtml = '<div class="import-overlay" id="importPreviewOverlay">'
            + '<div class="import-dialog">'
            + '<div class="import-dialog-header">'
            + '<span class="import-dialog-title">' + tImport + ' MCP ' + GourdI18n.t('settings.mcp.title') + GourdI18n.t('settings.mcp.import_beta') + '</span>'
            + '<button class="import-dialog-close" id="importPreviewClose">&times;</button>'
            + '</div>'
            + '<div class="import-dialog-body">'
            + '<div class="import-summary">'
            + GourdI18n.t('settings.mcp.import') + ' <strong>' + servers.length + '</strong> ' + GourdI18n.t('settings.mcp.title') + ' ' + tImport + ' ' + formatTag
            + '</div>'
            + '<div class="import-preview-list">' + previewItems + '</div>'
            + '</div>'
            + '<div class="import-dialog-footer">'
            + '<button class="btn-secondary" id="importPreviewCancel">' + tCancel + '</button>'
            + '<button class="btn-primary" id="importPreviewConfirm">' + tImport + ' (<span id="importSelectedCount">' + servers.filter(function(s){return !mcpCachedList.some(function(c){return c.name===s.name;}) && !s.error;}).length + '</span>)</button>'
            + '</div>'
            + '</div>'
            + '</div>';
        
        // 添加对话框到页面
        $('body').append(dialogHtml);
        
        var $overlay = $('#importPreviewOverlay');
        var $checks = $overlay.find('.import-server-checkbox');
        
        function updateCount() {
            var count = $checks.filter(':checked').length;
            $('#importSelectedCount').text(count);
        }
        
        $checks.on('change', updateCount);
        
        $('#importPreviewConfirm').on('click', function() {
            var selected = [];
            $checks.filter(':checked').each(function() {
                selected.push($(this).val());
            });
            $overlay.remove();
            if (selected.length > 0) {
                onConfirm(selected);
            } else {
                showToast(GourdI18n.t('common.no_data'), 'info');
            }
        });
        
        $('#importPreviewCancel, #importPreviewClose').on('click', function() {
            $overlay.remove();
        });
        
        // 点击遮罩层关闭
        $overlay.on('click', function(e) {
            if (e.target === this) $overlay.remove();
        });
    }
    
    /**
     * 创建导入进度对话框
     */
    function createProgressDialog() {
        var tImport = GourdI18n.t('settings.mcp.import');
        var tPreparing = GourdI18n.t('settings.mcp.import_preparing');
        var html = '<div class="import-overlay" id="importProgressOverlay">'
            + '<div class="import-dialog import-dialog-progress">'
            + '<div class="import-dialog-header">'
            + '<span class="import-dialog-title">' + tImport + '...</span>'
            + '</div>'
            + '<div class="import-dialog-body">'
            + '<div class="import-progress-bar-wrap">'
            + '<div class="import-progress-fill" id="importProgressFill" style="width:0%"></div>'
            + '</div>'
            + '<div class="import-progress-status" id="importProgressStatus">' + tPreparing + '</div>'
            + '<div class="import-progress-log" id="importProgressLog"></div>'
            + '</div>'
            + '</div>'
            + '</div>';
        $('body').append(html);
    }
    
    function updateProgress(current, total, statusText) {
        var pct = Math.round((current / total) * 100);
        $('#importProgressFill').css('width', pct + '%');
        $('#importProgressStatus').text(pct + '% - ' + statusText);
    }
    
    function appendProgressLog(text, isError) {
        var $log = $('#importProgressLog');
        var cls = isError ? ' class="import-log-error"' : '';
        $log.append('<div' + cls + '>' + escapeHtml(text) + '</div>');
        $log.scrollTop($log[0].scrollHeight);
    }
    
    /**
     * 导入完成后创建结果对话框（含回滚支持）
     */
    function showImportResult(result) {
        $('#importProgressOverlay').remove();
        
        var hasImported = result.imported.length > 0;
        var hasSkipped = result.skipped.length > 0;
        var hasErrors = result.errors.length > 0;
        var tImport = GourdI18n.t('settings.mcp.import');
        var tSuccess = '✓ ' + tImport + GourdI18n.t('settings.mcp.import_success_suffix');
        var tSkipped = '→ ' + GourdI18n.t('settings.mcp.import_skipped');
        var tFailed = '✗ ' + tImport + GourdI18n.t('settings.mcp.import_failed_suffix');
        var tUnknown = GourdI18n.t('common.unknown_error');
        
        var importedHtml = '';
        if (hasImported) {
            importedHtml = '<div class="import-result-section">'
                + '<div class="import-result-title success">' + tSuccess + ' (' + result.imported.length + ')</div>'
                + '<div class="import-result-items">';
            result.imported.forEach(function(name) {
                importedHtml += '<div class="import-result-item imported-item" data-name="' + escapeAttr(name) + '">'
                    + '<span class="import-result-name">' + escapeHtml(name) + '</span>'
                    + '</div>';
            });
            importedHtml += '</div></div>';
        }
        
        var skippedHtml = '';
        if (hasSkipped) {
            skippedHtml = '<div class="import-result-section">'
                + '<div class="import-result-title skipped">' + tSkipped + ' (' + result.skipped.length + ')</div>'
                + '<div class="import-result-items">';
            result.skipped.forEach(function(item) {
                skippedHtml += '<div class="import-result-item skipped-item">'
                    + '<span class="import-result-name">' + escapeHtml(item.name) + '</span>'
                    + '<span class="import-result-reason">' + escapeHtml(item.reason || GourdI18n.t('settings.mcp.import_exists')) + '</span>'
                    + '</div>';
            });
            skippedHtml += '</div></div>';
        }
        
        var errorsHtml = '';
        if (hasErrors) {
            errorsHtml = '<div class="import-result-section">'
                + '<div class="import-result-title error">' + tFailed + ' (' + result.errors.length + ')</div>'
                + '<div class="import-result-items">';
            result.errors.forEach(function(item) {
                errorsHtml += '<div class="import-result-item error-item">'
                    + '<span class="import-result-name">' + escapeHtml(item.name) + '</span>'
                    + '<span class="import-result-reason">' + escapeHtml(item.reason || tUnknown) + '</span>'
                    + '</div>';
            });
            errorsHtml += '</div></div>';
        }
        
        var tRollback = '↩ ' + GourdI18n.t('settings.mcp.import_rollback');
        var rollbackBtn = hasImported
            ? '<button class="btn-secondary" id="importRollbackBtn">' + tRollback + '</button>'
            : '';
        
        var tDone = GourdI18n.t('settings.mcp.import_done');
        var dialogHtml = '<div class="import-overlay" id="importResultOverlay">'
            + '<div class="import-dialog import-dialog-result">'
            + '<div class="import-dialog-header">'
            + '<span class="import-dialog-title">' + tImport + GourdI18n.t('settings.mcp.import_complete') + '</span>'
            + '<button class="import-dialog-close" id="importResultClose">&times;</button>'
            + '</div>'
            + '<div class="import-dialog-body">'
            + importedHtml + skippedHtml + errorsHtml
            + '<div class="import-result-summary">' + GourdI18n.t('settings.mcp.import_summary').replace('{0}', result.total).replace('{1}', result.imported.length).replace('{2}', result.skipped.length).replace('{3}', result.errors.length)
            + '</div>'
            + '</div>'
            + '<div class="import-dialog-footer">'
            + rollbackBtn
            + '<button class="btn-primary" id="importResultDone">' + tDone + '</button>'
            + '</div>'
            + '</div>'
            + '</div>';
        
        $('body').append(dialogHtml);
        
        var $overlay = $('#importResultOverlay');
        
        $('#importResultClose, #importResultDone').on('click', function() {
            $overlay.remove();
            loadMcpList();
        });
        
        // 回滚逻辑
        if (hasImported) {
            var tRollbackConfirm = GourdI18n.t('settings.mcp.import_rollback_confirm').replace('{0}', result.imported.length);
            var tRollbacking = GourdI18n.t('settings.mcp.import_rollbacking');
            $('#importRollbackBtn').on('click', function() {
                var $btn = $(this);
                layConfirm(tRollbackConfirm, function() {
                    $btn.prop('disabled', true).text(tRollbacking);
                    rollbackImport(result.imported, function(successCount) {
                        $overlay.remove();
                        loadMcpList();
                        showToast(GourdI18n.t('settings.mcp.import_rollback_done').replace('{0}', successCount), 'info');
                    });
                });
            });
        }
        
        $overlay.on('click', function(e) {
            if (e.target === this) {
                $overlay.remove();
                loadMcpList();
            }
        });
    }
    
    /**
     * 回滚导入：逐个删除刚导入的服务器
     */
    function rollbackImport(names, callback) {
        var completed = 0;
        var successCount = 0;
        
        function delNext(idx) {
            if (idx >= names.length) {
                callback(successCount);
                return;
            }
            $.ajax({
                url: '/web/settings/mcp/servers/remove',
                method: 'POST',
                data: JSON.stringify({ name: names[idx] }),
                contentType: 'application/json',
                dataType: 'json',
                success: function(resp) {
                    if (resp.code === 200) successCount++;
                },
                complete: function() {
                    delNext(idx + 1);
                }
            });
        }
        delNext(0);
    }
    
    // ==================== 入口事件绑定 ====================
    
    // 导入按钮 - 切换下拉菜单
    $('#mcpImportBtn').on('click', function (e) {
        e.stopPropagation();
        $('#mcpImportMenu').toggleClass('show');
    });

    // 点击页面其他区域关闭下拉菜单
    $(document).on('click', function () {
        $('#mcpImportMenu').removeClass('show');
    });

    // 下拉菜单项点击事件
    $('#mcpImportMenu').on('click', '.mcp-import-menu-item', function (e) {
        e.stopPropagation();
        $('#mcpImportMenu').removeClass('show');
        var action = $(this).attr('data-action');
        if (action === 'file') {
            $('#mcpImportFileInput').trigger('click');
        } else if (action === 'string') {
            showImportStringDialog();
        }
    });
    
    /**
     * 显示导入 JSON 字符串对话框
     */
    function showImportStringDialog() {
        var tTitle = GourdI18n.t('settings.mcp.json_dialog_title');
        var tHint = GourdI18n.t('settings.mcp.json_hint');
        var tFormatHint = GourdI18n.t('settings.mcp.json_format_hint');
        var tPlaceholder = GourdI18n.t('settings.mcp.json_placeholder');
        var tParseHint = GourdI18n.t('settings.mcp.json_parse_hint');
        var tCancel = GourdI18n.t('common.cancel');
        var tParseBtn = GourdI18n.t('settings.mcp.parse_btn');

        var dialogHtml = '<div class="import-overlay" id="importStringOverlay">'
            + '<div class="import-dialog">'
            + '<div class="import-dialog-header">'
            + '<span class="import-dialog-title">' + tTitle + '</span>'
            + '<button class="import-dialog-close" id="importStringClose">&times;</button>'
            + '</div>'
            + '<div class="import-dialog-body">'
            + '<div class="import-summary">' + tHint + '</div>'
            + '<div style="font-size:12px;color:var(--text-tertiary);margin-bottom:12px;line-height:1.8;">'
            + tFormatHint
            + '</div>'
            + '<textarea class="import-string-textarea" id="importStringInput" placeholder="' + escapeAttr(tPlaceholder) + '" spellcheck="false"></textarea>'
            + '<div class="import-string-hint">' + tParseHint + '</div>'
            + '</div>'
            + '<div class="import-dialog-footer">'
            + '<button class="btn-secondary" id="importStringCancel">' + tCancel + '</button>'
            + '<button class="btn-primary" id="importStringConfirm">' + tParseBtn + '</button>'
            + '</div>'
            + '</div>'
            + '</div>';

        $('body').append(dialogHtml);

        var $overlay = $('#importStringOverlay');

        // 关闭事件
        $('#importStringClose, #importStringCancel').on('click', function () {
            $overlay.remove();
        });

        // 确认 - 直接 POST JSON 字符串到后端解析接口
        $('#importStringConfirm').on('click', function () {
            var jsonStr = $('#importStringInput').val().trim();
            if (!jsonStr) {
                showToast(GourdI18n.t('settings.mcp.json_empty'), 'error');
                return;
            }

            // 基本验证
            try {
                JSON.parse(jsonStr);
            } catch (e) {
                showToast(GourdI18n.t('settings.mcp.json_invalid'), 'error');
                return;
            }

            // 关闭字符串对话框
            $overlay.remove();

            // 直接 POST JSON 字符串到后端解析接口（复用文件导入的同一套解析逻辑）
            var tParsing = GourdI18n.t('settings.mcp.import_parsing');
            var tImport = GourdI18n.t('settings.mcp.import');
            $('#mcpImportBtn').prop('disabled', true).html('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> ' + tParsing);

            $.ajax({
                url: '/web/settings/mcp/import/parse/string',
                method: 'POST',
                data: jsonStr,
                contentType: 'application/json',
                dataType: 'json',
                success: function(resp) {
                    if (resp.code === 200 && resp.data && resp.data.servers) {
                        showImportPreview(resp.data, function(selectedNames) {
                            executeImport(selectedNames, resp.data.servers);
                        });
                    } else {
                        showToast(GourdI18n.t('settings.loop.parse_failed') + ': ' + (resp.message || GourdI18n.t('common.unknown_error')), 'error');
                    }
                },
                error: function() {
                    showToast(GourdI18n.t('settings.mcp.parse_failed_retry'), 'error');
                },
                complete: function() {
                    $('#mcpImportBtn').prop('disabled', false).html('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> ' + tImport);
                }
            });
        });

        // 点击遮罩关闭
        $overlay.on('click', function (e) {
            if (e.target === this) $overlay.remove();
        });

        // 自动聚焦
        setTimeout(function () { $('#importStringInput').focus(); }, 100);
    }

    /**
     * 文件选择变化事件 — 将文件上传到后端解析
     * 后端使用 ONode 解析，检测格式后返回结构化数据
     */
    $('#mcpImportFileInput').on('change', function (e) {
        var file = e.target.files[0];
        if (!file) return;
        
        var formData = new FormData();
        formData.append('file', file);
        
        // 上传到后端解析
        var tParsing = GourdI18n.t('settings.mcp.import_parsing');
        var tImport = GourdI18n.t('settings.mcp.import');
        $('#mcpImportBtn').prop('disabled', true).html('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> ' + tParsing);
        
        $.ajax({
            url: '/web/settings/mcp/import/parse',
            method: 'POST',
            data: formData,
            contentType: false,
            processData: false,
            dataType: 'json',
            success: function(resp) {
                if (resp.code === 200 && resp.data && resp.data.servers) {
                    // 显示预览对话框，传入后端返回的结构化数据
                    showImportPreview(resp.data, function(selectedNames) {
                        executeImport(selectedNames, resp.data.servers);
                    });
                } else {
                    showToast(GourdI18n.t('settings.loop.parse_failed') + ': ' + (resp.message || GourdI18n.t('common.unknown_error')), 'error');
                }
            },
            error: function() {
                showToast(GourdI18n.t('settings.loop.upload_failed'), 'error');
            },
            complete: function() {
                $('#mcpImportBtn').prop('disabled', false).html('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> ' + tImport);
            }
        });
        
        // 重置文件输入，允许再次选择同一文件
        e.target.value = '';
    });
    
    
    /**
     * 执行导入（含进度反馈）
     * @param {string[]} names - 要导入的服务器名称列表
     * @param {Array} servers - 后端返回的结构化服务器数据数组
     */
    function executeImport(names, servers) {
        var result = {
            total: names.length,
            imported: [],
            skipped: [],
            errors: []
        };
        var tImport = GourdI18n.t('settings.mcp.import');
        var tSkipped = GourdI18n.t('settings.mcp.import_skipped_exists');
        
        // 构建名称 -> 服务器配置的快速查找表
        var serverMap = {};
        servers.forEach(function(s) {
            serverMap[s.name] = s;
        });
        
        createProgressDialog();
        appendProgressLog(GourdI18n.t('settings.mcp.import_progress').replace('{0}', names.length));
        
        function processNext(index) {
            if (index >= names.length) {
                // 完成
                appendProgressLog(tImport + GourdI18n.t('settings.mcp.import_complete') + '！');
                lastImportSession = result;
                showImportResult(result);
                return;
            }
            
            var name = names[index];
            var serverConfig = serverMap[name];
            
            updateProgress(index + 1, names.length, tImport + ' ' + (index + 1) + '/' + names.length + ': ' + name);
            
            // 检查是否已存在同名服务器
            var exists = mcpCachedList.some(function(s) { return s.name === name; });
            if (exists) {
                result.skipped.push({ name: name, reason: tSkipped });
                appendProgressLog('✖ ' + name + ': ' + tSkipped, false);
                processNext(index + 1);
                return;
            }
            
            // 检查是否有格式错误
            if (serverConfig.error) {
                result.errors.push({ name: name, reason: serverConfig.error });
                appendProgressLog('✗ ' + name + ': ' + serverConfig.error, true);
                processNext(index + 1);
                return;
            }
            
            // 用后端结构化数据构建请求体
            var mcpBody = buildAddBodyFromParsed(serverConfig);
            if (!mcpBody) {
                result.errors.push({ name: name, reason: GourdI18n.t('settings.mcp.import_incomplete_config') });
                appendProgressLog('✗ ' + name + ': ' + GourdI18n.t('settings.mcp.import_incomplete_config'), true);
                processNext(index + 1);
                return;
            }
            
            // 调用保存 API
            appendProgressLog('→ ' + name + ': ' + tImport + '...');
            $.ajax({
                url: '/web/settings/mcp/servers/add',
                method: 'POST',
                data: JSON.stringify(mcpBody),
                contentType: 'application/json',
                dataType: 'json',
                success: function(resp) {
                    if (resp.code === 200) {
                        result.imported.push(name);
                        appendProgressLog('✓ ' + name + ': ' + tImport + GourdI18n.t('settings.mcp.import_success_suffix'));
                    } else {
                        result.errors.push({ name: name, reason: resp.message || tImport + GourdI18n.t('settings.mcp.import_failed_suffix') });
                        appendProgressLog('✗ ' + name + ': ' + (resp.message || GourdI18n.t('settings.mcp.import_failed_suffix')), true);
                    }
                    processNext(index + 1);
                },
                error: function(jqXHR, textStatus) {
                    result.errors.push({ name: name, reason: GourdI18n.t('settings.network_error') + ': ' + textStatus });
                    appendProgressLog('✗ ' + name + ': ' + GourdI18n.t('settings.network_error'), true);
                    processNext(index + 1);
                }
            });
        }
        
        processNext(0);
    }
    
    /**
     * 将后端解析后的结构化数据构建为 /mcp/servers/add 的请求体
     * @param {Object} srv - 后端返回的单个服务器结构化数据
     * @returns {Object|null} 请求体对象
     */
    function buildAddBodyFromParsed(srv) {
        if (!srv || !srv.name || !srv.type) return null;
        
        var bodyObj = {
            name: srv.name,
            type: srv.type,
            enabled: true,
            scope: 'user'
        };
        
        if (srv.type === 'stdio') {
            if (!srv.command) return null;
            bodyObj.command = srv.command;
            if (srv.args && srv.args.length > 0) {
                bodyObj.args = srv.args;
            }
            if (srv.env && Object.keys(srv.env).length > 0) {
                bodyObj.env = srv.env;
            }
        } else if (srv.type === 'sse' || srv.type === 'streamable' || srv.type === 'streamable_stateless') {
            if (!srv.url) return null;
            bodyObj.url = srv.url;
            if (srv.headers && Object.keys(srv.headers).length > 0) {
                bodyObj.headers = srv.headers;
            }
            if (srv.timeout) {
                bodyObj.timeout = parseTimeout(srv.timeout);
            }
        } else {
            return null;
        }
        
        return bodyObj;
    }
    
    window._settingsMcp = { load: loadMcpList, reset: resetMcpForm, showList: showMcpListView };
})();