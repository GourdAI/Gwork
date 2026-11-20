/* ===== app-connector-picker.js =====
   对话内连接器选择器（WorkBuddy 式，2026-11 用户拍板「默认不启用」）。

   语义（关键，勿改）：
   - 选择随会话走：勾选哪些连接器，本会话的模型才能看到/调用它们的工具。
     不选 = 本会话没有任何连接器工具（新会话默认干净起步）。
   - 内核门控在 ToolGate::mcp_servers（可见 + 执行双端），本模块只负责
     选择 UI 与持久化；CLI/ACP/循环任务不经此选择器，保持全部已启用连接器。
   - 列表只列「已启用」的连接器（设置里关掉的不出现在这里）。

   对接接口：
   - GET  /web/settings/mcp/servers        → 已安装连接器（name/displayName/iconUrl/enabled）
   - POST /web/chat/mcp/select             表单 { sessionId, servers: JSON数组 } → 持久化
   - GET  /web/chat/models?sessionId=      data.mcpServers 回显（null=从未选过=无）

   会话语义与 app-access-mode.js 同构：本端缓存 sessionPickMap 优先，
   刷新后由 refreshSessionModel 的同一响应回填（applyServerSelection）；
   新建会话在 inheritSelectionToSession 里继承当前选择（含空选择）。

   浮层互斥：开合走 closeAllToolbarPanels 同款协议；点击外部/Esc 关闭。 */
(function () {
    'use strict';

    var SERVERS_URL = '/web/settings/mcp/servers';
    var SELECT_URL = '/web/chat/mcp/select';

    // 当前会话生效选择（内存真源；null = 从未选过，语义同空数组）
    var currentPicked = [];
    var currentSession = '';
    // 会话级缓存 { sessionId: [names] }
    var sessionPickMap = {};
    // 已启用连接器清单缓存（打开下拉时刷新；安装/开关后下次打开自然更新）
    var serverList = null;

    function t(key) {
        if (window.GourdI18n && typeof window.GourdI18n.t === 'function') return window.GourdI18n.t(key);
        return key;
    }

    function esc(s) {
        if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function escAttr(s) {
        return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function currentSessionId() {
        if (typeof window.SESSION_ID === 'string' && window.SESSION_ID) return window.SESSION_ID;
        if (typeof window.activeSessionId === 'string' && window.activeSessionId) return window.activeSessionId;
        return '';
    }

    function apiUrl(path) {
        return (typeof window.__gworkApiUrl === 'function') ? window.__gworkApiUrl(path) : path;
    }

    function normalizePicked(v) {
        if (!Array.isArray(v)) return [];
        var out = [];
        for (var i = 0; i < v.length; i++) {
            var s = String(v[i] || '').trim();
            if (s && out.indexOf(s) < 0) out.push(s);
        }
        return out;
    }

    function isPicked(name) {
        return currentPicked.indexOf(name) >= 0;
    }

    /* ===== 渲染 ===== */

    // 图标：与技能/连接器已安装卡同款——名字前两字母底 + 代理 img 叠上层，
    // 加载失败自毁露字母底。小尺寸（18px）由 .conn-pick-icon 控制。
    function iconHtml(item) {
        var displayName = item.displayName || item.name || 'M';
        var letter = displayName.substring(0, 2).toUpperCase();
        var img = item.iconUrl
            ? '<img src="' + escAttr(apiUrl('/web/settings/skills/icon?url=' + encodeURIComponent(item.iconUrl))) + '" alt="" onerror="this.remove()">'
            : '';
        return '<span class="conn-pick-icon"><span>' + esc(letter) + '</span>' + img + '</span>';
    }

    function optionHtml(item) {
        var name = item.name || '';
        var displayName = item.displayName || name;
        var picked = isPicked(name);
        return '<button type="button" class="conn-pick-option' + (picked ? ' picked' : '') + '" data-name="' + escAttr(name) + '">'
            + iconHtml(item)
            + '<span class="conn-pick-name" title="' + escAttr(displayName) + '">' + esc(displayName) + '</span>'
            + '<svg class="conn-pick-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>'
            + '</button>';
    }

    function renderDropdown() {
        var html = '';
        var list = (serverList || []).filter(function (it) { return it && it.enabled !== false; });
        if (!list.length) {
            html = '<div class="conn-pick-empty">' + esc(t('app.conn_pick_empty')) + '</div>';
        } else {
            for (var i = 0; i < list.length; i++) html += optionHtml(list[i]);
        }
        // 管理入口：跳技能页·连接器 tab（安装/开关都在那里）
        html += '<div class="conn-pick-sep"></div>'
            + '<button type="button" class="conn-pick-manage">'
            + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
            + '<span>' + esc(t('app.conn_pick_manage')) + '</span></button>';
        $('#welcomeConnDropdown, #chatConnDropdown').html(html);
    }

    function renderLabel() {
        var n = currentPicked.length;
        $('.conn-selector').each(function () {
            var $sel = $(this);
            $sel.toggleClass('has-picked', n > 0);
            var $label = $sel.find('.conn-label');
            if (n > 0) {
                // 有选择：显示「连接器 · N」（数字动态，无静态 i18n 键）
                $label.removeAttr('data-i18n').text(t('app.conn_pick_label') + ' · ' + n);
            } else {
                $label.attr('data-i18n', 'app.conn_pick_label').text(t('app.conn_pick_label'));
            }
        });
    }

    function render() {
        renderLabel();
        renderDropdown();
    }

    /* ===== 选择与持久化 ===== */

    function persist(session, picked) {
        if (!session) return;
        $.ajax({
            url: SELECT_URL,
            type: 'POST',
            // 与模型/档位选择器同一归属口径：缺头会写出第二份 context.json
            headers: (typeof window.sessionCwdHeaders === 'function') ? window.sessionCwdHeaders(session) : {},
            data: { sessionId: session, servers: JSON.stringify(picked) }
        }).fail(function (err) {
            console.error('[conn-picker] select failed:', err && err.status);
            if (typeof window.showToast === 'function') window.showToast(t('app.conn_pick_failed'), 'error');
        });
    }

    function toggle(name) {
        if (!name) return;
        var idx = currentPicked.indexOf(name);
        if (idx >= 0) currentPicked.splice(idx, 1);
        else currentPicked.push(name);
        currentSession = currentSessionId();
        if (currentSession) sessionPickMap[currentSession] = currentPicked.slice();
        render();
        persist(currentSession, currentPicked.slice());
    }

    /* ===== 会话联动（与 app-access-mode.js 同构） ===== */

    // 后端回填：refreshSessionModel 同一响应调用；本端已有认知时不覆盖。
    function applyServerSelection(sessionId, picked) {
        if (!sessionId) return;
        if (sessionPickMap[sessionId]) return;
        sessionPickMap[sessionId] = normalizePicked(picked); // null → []
        if (sessionId === currentSessionId() && currentSession === sessionId) {
            currentPicked = sessionPickMap[sessionId].slice();
            render();
        }
    }

    // 新建会话继承（inheritSelectionToSession 调用）：写缓存 + 异步落盘。
    // 空选择也继承并落盘：新会话必须明确「无连接器」，不能回落到未定义态。
    function inheritToSession(newSessionId) {
        if (!newSessionId) return;
        var picked = currentPicked.slice();
        sessionPickMap[newSessionId] = picked;
        persist(newSessionId, picked);
    }

    function onSessionSwitch(sessionId) {
        sessionId = sessionId || currentSessionId();
        currentSession = sessionId;
        currentPicked = (sessionId && sessionPickMap[sessionId]) ? sessionPickMap[sessionId].slice() : [];
        render();
        // 无缓存时由 refreshSessionModel → applyServerSelection 回填；
        // 这里不单独发请求（正常路径零额外请求，与档位选择器同口径）。
    }

    function hookSetActiveSession() {
        var orig = window.setActiveSession;
        if (typeof orig !== 'function') return;
        window.setActiveSession = function (sid) {
            var ret = orig.apply(this, arguments);
            try { onSessionSwitch(sid); } catch (e) { console.error('[conn-picker] session switch hook failed:', e); }
            return ret;
        };
    }

    /* ===== 列表加载 ===== */

    function loadServers(cb) {
        $.get(apiUrl(SERVERS_URL), function (resp) {
            serverList = (resp && resp.code === 200 && Array.isArray(resp.data)) ? resp.data : [];
            // 选择项与清单对齐：连接器被删除/停用后，label 的「· N」不得虚计，
            // 否则用户以为它还生效（实际内核已无此服务器）。仅修剪显示与内存，
            // 持久化留给下一次用户操作——打开下拉这种读动作不产生写副作用。
            // 清单为空（未装任何连接器/请求竞态）时不修剪，避免误清空。
            if (serverList.length) {
                var enabled = {};
                for (var i = 0; i < serverList.length; i++) {
                    var it = serverList[i];
                    if (it && it.name && it.enabled !== false) enabled[it.name] = true;
                }
                var pruned = currentPicked.filter(function (n) { return enabled[n]; });
                if (pruned.length !== currentPicked.length) {
                    currentPicked = pruned;
                    if (currentSession) sessionPickMap[currentSession] = currentPicked.slice();
                }
            }
            render();
            if (cb) cb();
        }).fail(function () {
            serverList = [];
            render();
            if (cb) cb();
        });
    }

    /* ===== DOM 绑定 ===== */

    function bindUI() {
        $('.conn-selector').each(function () {
            var el = this;
            var $sel = $(el);
            $sel.find('.conn-selector-current').on('click', function (e) {
                e.stopPropagation();
                var opening = !$sel.hasClass('open');
                $('.conn-selector').not(el).removeClass('open');
                $('.access-selector').removeClass('open');
                $('.plus-menu-wrap').removeClass('open');
                if (opening && typeof window.closeAllToolbarPanels === 'function') window.closeAllToolbarPanels();
                if (opening) {
                    render();
                    loadServers(); // 每次打开刷新清单（安装/开关后无需重启页面）
                }
                $sel.toggleClass('open', opening);
            });
        });

        // 选项勾选（委托，重建后依然有效）；下拉保持打开支持连续多选
        $(document).on('click', '.conn-pick-option', function (e) {
            e.stopPropagation();
            toggle($(this).attr('data-name'));
        });

        // 管理入口：跳技能页·连接器（已安装视图）
        $(document).on('click', '.conn-pick-manage', function (e) {
            e.stopPropagation();
            $('.conn-selector').removeClass('open');
            if (typeof window.openSkills === 'function') window.openSkills();
            if (typeof window.switchSkillsView === 'function') window.switchSkillsView('connectors');
        });

        $(document).on('mousedown', function (e) {
            var inside = $(e.target).closest('.conn-selector')[0];
            $('.conn-selector').each(function () {
                if (this !== inside) $(this).removeClass('open');
            });
        });

        $(document).on('keydown', function (e) {
            if (e.key === 'Escape') $('.conn-selector').removeClass('open');
        });
    }

    /* ===== 引导 ===== */

    function init() {
        currentSession = currentSessionId();
        if (currentSession && sessionPickMap[currentSession]) {
            currentPicked = sessionPickMap[currentSession].slice();
        }
        render();
    }

    bindUI();
    hookSetActiveSession();

    document.addEventListener('i18n:localeChanged', function () {
        try { render(); } catch (err) { console.error('[i18n] conn picker render failed:', err); }
    });

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

    window.GourdConnPicker = {
        init: init,
        // 发送路径不需要携带字段（内核从会话 context 读），保留只读口径供取证/测试
        pickedForSession: function (sessionId) {
            if (!sessionId || sessionId === currentSession) return currentPicked.slice();
            return (sessionPickMap[sessionId] || []).slice();
        },
        applyServerSelection: applyServerSelection,
        inheritToSession: inheritToSession,
        onSessionSwitch: onSessionSwitch
    };
})();