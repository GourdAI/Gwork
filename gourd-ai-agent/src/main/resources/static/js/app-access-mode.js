/* ===== app-access-mode.js =====
   访问控制档位（会话级）：默认权限 default / 完全访问 full。
   - 默认权限 = 项目空间隔离 + 危险命令需审批；
   - 完全访问 = 空间放行 + 命令放行（须在确认弹窗中勾选风险确认后才会生效）。

   会话语义（关键，勿改）：
   - 档位随会话走，不随全局设置；「新建会话」一律回到默认权限。
     full 不通过 inheritSelectionToSession 继承给新会话——该函数是「新会话继承上一会话
     选择」语义（见 app-history.js 注释），继承 full 会让新建对话默认裸奔。
   - 同一会话重新打开保持原档位：优先本端缓存（sessionAccessMap，切走再切回命中）；
     缓存缺失（如刷新页面后重开）由后端 /web/chat/models?sessionId= 的 accessMode 回显。

   对接接口（由后端任务实现，本模块只消费）：
   - POST /web/chat/access/select  表单 { sessionId, accessMode } → { code:200 } 持久化；
   - GET  /web/chat/models         data.accessMode（与 selected/thinkingDepth/contextLength 同级）初始化回显；
   - POST /web/chat/input（SSE_ENDPOINT）由 app-streaming.js 的 postChatInput 统一携带
     accessMode 字段（取值经本模块 modeForSession(sessionId) 提供）。

   弹窗复用：完全访问确认框复用项目既有 layer 体系（app-base.js layConfirm / app-code.js
   layer.open + skin:'kd-layer' 同一范式），内容自带 DOM（图标行风险清单 + 勾选），样式见
   app.css 的 .access-confirm 区块；不引第三方组件。文案静态元素带 data-i18n，translateDOM
   在语言切换时会一并刷新（弹窗 DOM 挂于 body，同样在扫描范围内），动态部分由本模块重绘。 */
(function () {
    'use strict';

    var MODE_DEFAULT = 'default';
    var MODE_FULL = 'full';
    var ACCESS_SELECT_URL = '/web/chat/access/select';
    var MODELS_URL = '/web/chat/models';

    // 当前会话生效档位（内存真源）
    var currentMode = MODE_DEFAULT;
    // 档位所属会话 id（切会话时按此判定）
    var currentSession = '';
    // 会话级档位缓存 { sessionId: mode }：用于「同一会话重新打开保持」
    var sessionAccessMap = {};

    function t(key) {
        if (window.GourdI18n && typeof window.GourdI18n.t === 'function') return window.GourdI18n.t(key);
        return key;
    }

    function esc(s) {
        if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
        return String(s);
    }

    function normalizeMode(v) {
        return (v === MODE_FULL) ? MODE_FULL : MODE_DEFAULT;
    }

    // 当前会话 id：优先 SESSION_ID（app-base 与各模块统一维护），退回 activeSessionId
    function currentSessionId() {
        if (typeof window.SESSION_ID === 'string' && window.SESSION_ID) return window.SESSION_ID;
        if (typeof window.activeSessionId === 'string' && window.activeSessionId) return window.activeSessionId;
        return '';
    }

    // 某会话的生效档位（供发送路径读取；只读缓存，不发请求）
    function modeForSession(sessionId) {
        if (!sessionId) return currentMode;
        if (sessionId === currentSession) return currentMode;
        return normalizeMode(sessionAccessMap[sessionId]);
    }

    /* ===== 渲染 ===== */

    function optionHtml(mode) {
        var isFull = (mode === MODE_FULL);
        var active = (currentMode === mode);
        var nameKey = isFull ? 'app.access_full' : 'app.access_default';
        var descKey = isFull ? 'app.access_full_desc' : 'app.access_default_desc';
        return '<button type="button" class="access-option' + (active ? ' active' : '')
            + (isFull ? ' is-full' : '') + '" data-mode="' + mode + '"'
            + (active ? ' aria-current="true"' : '') + '>'
            + '<div class="access-option-body">'
            + '<span class="access-option-name" data-i18n="' + nameKey + '">' + esc(t(nameKey)) + '</span>'
            + '<span class="access-option-desc" data-i18n="' + descKey + '">' + esc(t(descKey)) + '</span>'
            + '</div>'
            + '<svg class="access-option-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>'
            + '</button>';
    }

    function render() {
        var isFull = (currentMode === MODE_FULL);
        var labelKey = isFull ? 'app.access_full' : 'app.access_default';
        $('.access-selector').each(function () {
            var $sel = $(this);
            $sel.toggleClass('is-full', isFull);
            // data-i18n 同步改写：否则语言切换时 translateDOM 会把 label 翻回另一个档位文案
            $sel.find('.access-label').attr('data-i18n', labelKey).text(t(labelKey));
        });
        // 下拉每次全量重建（两个宿主同构），选中态/高亮态随 currentMode
        $('#welcomeAccessDropdown, #chatAccessDropdown').html(optionHtml(MODE_DEFAULT) + optionHtml(MODE_FULL));
    }

    /* ===== 档位切换 ===== */

    function showModeToast(mode) {
        if (typeof window.showToast !== 'function') return;
        window.showToast(t(mode === MODE_FULL ? 'app.access_toast_full' : 'app.access_toast_default'), 'success');
    }

    // 真正切换档位：更新内存/缓存 → 重绘 → toast → POST 持久化（失败回滚并报错）
    function applyMode(mode, opts) {
        opts = opts || {};
        var prev = currentMode;
        var next = normalizeMode(mode);
        if (next === prev && !opts.force) {
            render();
            if (!opts.silent) showModeToast(next);
            return;
        }
        currentMode = next;
        currentSession = currentSessionId();
        if (currentSession) sessionAccessMap[currentSession] = next;
        render();
        if (!opts.silent) showModeToast(next);

        var session = currentSession;
        if (!session) return;
        var target = next;
        $.post(ACCESS_SELECT_URL, { sessionId: session, accessMode: target })
            .done(function (resp) {
                if (resp && resp.code === 200) return;
                rollback();
            })
            .fail(function (err) {
                console.error('[access] select failed:', err && err.status);
                rollback();
            });

        function rollback() {
            // 仅在「用户没有继续改动」时回滚，避免覆盖更新的选择
            if (currentMode === target && currentSession === session) {
                currentMode = prev;
                if (session) sessionAccessMap[session] = prev;
                render();
            }
            if (typeof window.showToast === 'function') window.showToast(t('app.access_failed'), 'error');
        }
    }

    /* ===== 完全访问确认弹窗（复用 layer + kd-layer skin，与 layConfirm 同范式） ===== */

    function getLayer() {
        if (window.layer) return window.layer;
        if (window.layui && window.layui.layer) return window.layui.layer;
        return null;
    }

    // 风险清单行图标（参照稿「图标行」形态）：文件 / 终端 / 地球，16px 描边风格。
    var RISK_ICONS = {
        file: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
        cmd: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
        net: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>'
    };

    function riskItemHtml(kind) {
        var nameKey = 'app.access_risk_' + kind;
        var descKey = nameKey + '_desc';
        return '<div class="access-risk-item">'
            + '<span class="access-risk-icon">' + (RISK_ICONS[kind] || '') + '</span>'
            + '<div class="access-risk-body">'
            + '<div class="access-risk-name" data-i18n="' + nameKey + '">' + esc(t(nameKey)) + '</div>'
            + '<div class="access-risk-desc" data-i18n="' + descKey + '">' + esc(t(descKey)) + '</div>'
            + '</div></div>';
    }

    function openFullConfirm() {
        // 弹窗打开前先收起下拉气泡，避免浮层叠加
        $('.access-selector').removeClass('open');

        var layer = getLayer();
        if (!layer) {
            // 极端兜底（layer 未就绪）：用原生 confirm 保证功能不丢
            if (window.confirm(t('app.access_confirm_title') + '\n' + t('app.access_ack'))) applyMode(MODE_FULL);
            return;
        }

        var html = '<div class="access-confirm">'
            + '<div class="access-confirm-title" data-i18n="app.access_confirm_title">' + esc(t('app.access_confirm_title')) + '</div>'
            + '<div class="access-confirm-desc" data-i18n="app.access_confirm_desc">' + esc(t('app.access_confirm_desc')) + '</div>'
            + '<div class="access-risk-list">'
            + riskItemHtml('file')
            + riskItemHtml('cmd')
            + riskItemHtml('net')
            + '</div>'
            + '<label class="access-ack">'
            + '<input type="checkbox" class="access-ack-checkbox"/>'
            + '<span class="access-ack-text" data-i18n="app.access_ack">' + esc(t('app.access_ack')) + '</span>'
            + '</label>'
            + '<div class="access-confirm-btns">'
            + '<button class="kd-btn access-cancel-btn" data-i18n="app.access_cancel">' + esc(t('app.access_cancel')) + '</button>'
            // 确认按钮走危险色（参照稿「红字确认」的警示语义），按钮内嵌警示图标；文案由内层 span 承载（data-i18n 挂在 span 上，避免图标 svg 被 translateDOM 文本替换冲掉）
            + '<button class="kd-btn access-allow-btn" disabled>'
            + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
            + '<span data-i18n="app.access_allow">' + esc(t('app.access_allow')) + '</span></button>'
            + '</div>'
            + '</div>';

        var idx = layer.open({
            type: 1,
            content: html,
            title: false,
            closeBtn: 0,
            shade: 0.3,
            shadeClose: false,
            skin: 'kd-layer',
            area: 'auto',
            success: function (layero) {
                var $ack = layero.find('.access-ack-checkbox');
                var $allow = layero.find('.access-allow-btn');
                // 未勾选风险确认时，「允许完全访问」置灰禁用；勾选后才可点
                $ack.on('change', function () {
                    $allow.prop('disabled', !this.checked);
                });
                $allow.on('click', function () {
                    if ($ack.length && !$ack.prop('checked')) return;
                    layer.close(idx);
                    applyMode(MODE_FULL);
                });
                layero.find('.access-cancel-btn').on('click', function () { layer.close(idx); });
            }
        });
    }

    /* ===== 会话联动 ===== */

    // 后端回填入口：由 app-history.js 的 refreshSessionModel 在同一响应里调用，
    // 避免为拿 accessMode 再单独发一次 /web/chat/models。
    // 已有本端认知（sessionAccessMap）时不覆盖：本地选择可能刚发生而持久化尚在途中。
    function applyServerMode(sessionId, mode) {
        if (!sessionId) return;
        if (mode !== MODE_FULL && mode !== MODE_DEFAULT) return;
        if (sessionAccessMap[sessionId]) return;
        sessionAccessMap[sessionId] = mode;
        if (sessionId === currentSessionId() && currentSession === sessionId) {
            currentMode = mode;
            render();
        }
    }

    // 初始化回显（兜底路径）：仅当本端完全没有该会话认知时才发独立请求。
    // 延迟一小段以让 refreshSessionModel（会话切换路径上必然发起）先回填，
    // 届时候缓存已命中则跳过，从而实现「正常路径零额外请求」。
    function fetchSessionMode(sessionId) {
        if (!sessionId) return;
        setTimeout(function () {
            if (!sessionId || sessionAccessMap[sessionId]) return; // 已被回填
            if (sessionId !== currentSessionId()) return;          // 用户已切走
            var doFetch = function () {
                $.get(MODELS_URL + '?sessionId=' + encodeURIComponent(sessionId), function (resp) {
                    if (!resp || resp.code !== 200 || !resp.data) return;
                    applyServerMode(sessionId, resp.data.accessMode);
                }).fail(function () { /* 回显失败保持默认权限，不打扰用户 */ });
            };
            if (typeof window.__whenBackendReady === 'function') window.__whenBackendReady(doFetch);
            else doFetch();
        }, 120);
    }

    // 会话切换（由 setActiveSession 包装链触发；也供外部显式调用）
    function onSessionSwitch(sessionId) {
        sessionId = sessionId || currentSessionId();
        currentSession = sessionId;
        if (sessionId && sessionAccessMap[sessionId]) {
            // 本端已有该会话档位（切走再切回 / 同会话重复激活）：保持
            currentMode = sessionAccessMap[sessionId];
        } else {
            // 新会话（或本端未缓存的会话）：默认权限起步；已持久化过的会话由后端回显恢复。
            // 这里刻意不继承上一会话的 full —— 满足「新会话默认回到默认权限」。
            currentMode = MODE_DEFAULT;
            fetchSessionMode(sessionId);
        }
        render();
    }

    function hookSetActiveSession() {
        var orig = window.setActiveSession;
        if (typeof orig !== 'function') return;
        window.setActiveSession = function (sid) {
            var ret = orig.apply(this, arguments);
            try { onSessionSwitch(sid); } catch (e) { console.error('[access] session switch hook failed:', e); }
            return ret;
        };
    }

    /* ===== DOM 绑定 ===== */

    function bindUI() {
        // 两处宿主（欢迎页 / 对话页）各自绑定：点击开合气泡，并与其他浮层互斥
        $('.access-selector').each(function () {
            var el = this;
            var $sel = $(el);
            $sel.find('.access-selector-current').on('click', function (e) {
                e.stopPropagation();
                var opening = !$sel.hasClass('open');
                $('.access-selector').not(el).removeClass('open');
                $('.plus-menu-wrap').removeClass('open'); // 收起「+」菜单（浮层互斥）
                if (opening && typeof window.closeAllToolbarPanels === 'function') window.closeAllToolbarPanels();
                if (opening) render();
                $sel.toggleClass('open', opening);
            });
        });

        // 档位选项（委托，重建后依然有效）
        $(document).on('click', '.access-option', function (e) {
            e.stopPropagation();
            var mode = normalizeMode($(this).attr('data-mode'));
            if (mode === currentMode) {
                $('.access-selector').removeClass('open');
                return;
            }
            if (mode === MODE_FULL) { openFullConfirm(); return; }
            applyMode(MODE_DEFAULT); // 切回默认权限无需二次确认
            $('.access-selector').removeClass('open');
        });

        // 点击外部关闭（mousedown：与「+」菜单同款，比 click 更即时）
        $(document).on('mousedown', function (e) {
            var inside = $(e.target).closest('.access-selector')[0];
            $('.access-selector').each(function () {
                if (this !== inside) $(this).removeClass('open');
            });
        });

        // Esc 关闭
        $(document).on('keydown', function (e) {
            if (e.key === 'Escape') $('.access-selector').removeClass('open');
        });
    }

    /* ===== 引导 ===== */

    function init() {
        currentSession = currentSessionId();
        render();
        // 初始化回显（若本端缓存已有当前会话则无需请求）
        if (!currentSession || !sessionAccessMap[currentSession]) fetchSessionMode(currentSession);
    }

    bindUI();
    hookSetActiveSession();

    // 语言切换：重绘档位文案（label + 下拉选项）
    document.addEventListener('i18n:localeChanged', function () {
        try { render(); } catch (err) { console.error('[i18n] access mode render failed:', err); }
    });

    // 启动即回显（等后端就绪再发请求，避免桌面端冷启动被代理挂起）
    // 同时必须等语言包就绪：否则 t() 返回 key 字面量，会把静态 HTML 里的正确文案反而覆盖掉
    // （此后 translateDOM 虽能救回，但首帧会闪一下 key）。
    (function boot() {
        function start() { init(); }
        function whenI18nReady(fn) {
            if (window.GourdI18n && typeof window.GourdI18n.whenReady === 'function') {
                window.GourdI18n.whenReady(fn);
            } else fn();
        }
        whenI18nReady(function () {
            if (typeof window.__whenBackendReady === 'function') window.__whenBackendReady(start);
            else start();
        });
    })();

    window.GourdAccessMode = {
        init: init,
        getMode: function () { return currentMode; },
        // 程序化切换（含持久化 + toast；不弹风险确认——确认仅拦截用户从 UI 切到 full）
        setMode: function (mode) { applyMode(mode); },
        currentSessionId: currentSessionId,
        modeForSession: modeForSession,
        applyServerMode: applyServerMode,
        onSessionSwitch: onSessionSwitch
    };
})();
