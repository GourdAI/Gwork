/* ===== app-memory.js ===== */
/* 记忆主视图：开关卡片（心智记忆 / 记忆隔离）+ 已保存记忆列表（workspace/global 双域，支持手动删除）。
   入口：侧栏主导航 #memoryNavBtn；专注模式 #filerMemoryBtn（以弹层形式打开本视图，不退出专注模式）。
   视图互斥与 openAutomation 同构；开关走 /web/settings/general/save（后端 bindTo 为部分 merge，
   仅提交变更字段不会冲掉其它已保存值）。 */

(function () {
    'use strict';

    var $view = $('#memoryView');
    if (!$view.length) return; // 片段未注入时静默退出

    var SCOPE_WORKSPACE = 'workspace';
    var currentScope = SCOPE_WORKSPACE;

    function t(key) { return window.GourdI18n ? window.GourdI18n.t(key) : key; }
    function escHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function sessionHeaders() {
        var headers = {};
        var cwd = (typeof window.getSessionCwd === 'function') ? window.getSessionCwd() : '';
        if (cwd) headers['X-Session-Cwd'] = cwd;
        return headers;
    }

    var $list = $('#memoryViewList');
    var $meta = $('#memoryViewMeta');
    var $enabledSwitch = $('#memoryEnabledSwitch');
    var $isolationSwitch = $('#memoryIsolationSwitch');

    /* ===================== 视图入口（与 openAutomation 同构） ===================== */

    function openMemoryView(opts) {
        /* 专注模式：以弹层（遮罩+居中面板）形式打开，不退出 code 模式。
           旧行为先 exitCodeMode() 会经 startFreshSession→switchToWelcomeMode 闪现主页面，已废弃。
           弹层盖在专注模式界面之上，不切换底层视图、不动 inChatMode（右栏对话流式不受影响）。 */
        if (opts && opts.overlay && window.appMode === 'code') {
            $view.addClass('memory-overlay active');
            if (typeof window.closeSettings === 'function') window.closeSettings();
            else if ($('#settingsOverlay').is(':visible')) $('#settingsCloseBtn').trigger('click');
            loadSwitches();
            loadMemories();
            return;
        }
        $view.removeClass('memory-overlay');
        if (typeof window.exitCodeMode === 'function' && window.appMode === 'code') {
            window.exitCodeMode();
        }
        if (typeof window.closeAutomation === 'function') window.closeAutomation();
        if (typeof window.closeSkills === 'function') window.closeSkills();
        if (typeof window.closeChannel === 'function') window.closeChannel();
        if (typeof window.closeModelSettings === 'function') window.closeModelSettings();
        $('#welcomeView').hide();
        $('#chatView').removeClass('active');
        $view.addClass('active');
        $('.main-nav-item').removeClass('active');
        $('#memoryNavBtn').addClass('active');

        // 关键：本视图既不属于 chat 也不属于 welcome，必须让出 inChatMode（同 openAutomation 注释）
        window.inChatMode = false;

        if (typeof window.closeSettings === 'function') window.closeSettings();
        else if ($('#settingsOverlay').is(':visible')) $('#settingsCloseBtn').trigger('click');

        loadSwitches();
        loadMemories();
    }

    function closeMemoryView() {
        $view.removeClass('active memory-overlay');
        $('#memoryNavBtn').removeClass('active');
    }

    window.openMemoryView = openMemoryView;
    window.closeMemoryView = closeMemoryView;
    window.isMemoryViewOpen = function () { return $view.hasClass('active'); };

    /* ===================== 开关（即时保存，部分 merge 安全） ===================== */

    function loadSwitches() {
        $.get('/web/settings/general').done(function (res) {
            var d = (res && res.data) ? res.data : (res || {});
            $enabledSwitch.prop('checked', d.memoryEnabled !== false);
            $isolationSwitch.prop('checked', d.memoryIsolation !== false);
        });
    }

    function saveSwitch(field, value) {
        var body = {};
        body[field] = value;
        $.ajax({
            url: '/web/settings/general/save',
            method: 'POST',
            data: JSON.stringify(body),
            contentType: 'application/json',
            dataType: 'json'
        }).fail(function () {
            loadSwitches(); // 保存失败回滚开关态
        });
    }

    $enabledSwitch.on('change', function () { saveSwitch('memoryEnabled', this.checked); });
    $isolationSwitch.on('change', function () { saveSwitch('memoryIsolation', this.checked); });

    /* ===================== 记忆列表 ===================== */

    function loadMemories() {
        $list.html('<div class="memory-empty">' + escHtml(t('memory.loading')) + '</div>');
        $meta.text('');

        fetch('/web/chat/memory/list?scope=' + encodeURIComponent(currentScope), { headers: sessionHeaders() })
            .then(function (r) { return r.json(); })
            .then(function (res) {
                var data = (res && res.data) ? res.data : {};
                renderList(data.items || [], data.total || 0);
            })
            .catch(function () {
                $list.html('<div class="memory-empty memory-error">' + escHtml(t('memory.load_failed')) + '</div>');
            });
    }

    /* 重要度（importance 1-10）→ 易懂分级文案 */
    function impInfo(imp) {
        var v = Number(imp) || 0;
        if (v >= 10) return { cls: 'imp-critical', label: t('memory.imp_critical') };
        if (v >= 7) return { cls: 'imp-high', label: t('memory.imp_high') };
        if (v >= 4) return { cls: 'imp-mid', label: t('memory.imp_mid') };
        return { cls: 'imp-low', label: t('memory.imp_low') };
    }

    function renderList(items, total) {
        $meta.text(t('memory.count').replace('{n}', total));

        if (!items.length) {
            $list.html('<div class="memory-empty">' + escHtml(t('memory.empty')) + '</div>');
            return;
        }

        var html = '';
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var info = impInfo(it.importance);
            var tip = t('memory.imp_tip').replace('{n}', String(Math.round(Number(it.importance) || 0)));
            html += '<div class="memory-item">' +
                '<div class="memory-item-head">' +
                    '<span class="memory-item-key" title="' + escHtml(it.key) + '">' + escHtml(it.key) + '</span>' +
                    '<span class="memory-item-imp ' + info.cls + '" title="' + escHtml(tip) + '">' + escHtml(info.label) + '</span>' +
                    '<span class="memory-item-time">' + escHtml(it.time || '') + '</span>' +
                    '<button class="memory-item-delete" data-key="' + escHtml(it.key) + '" title="' + escHtml(t('memory.delete')) + '">' +
                        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
                    '</button>' +
                '</div>' +
                '<div class="memory-item-content">' + escHtml(it.content) + '</div>' +
            '</div>';
        }
        $list.html(html);
    }

    /* ===================== 手动删除 ===================== */

    $list.on('click', '.memory-item-delete', function () {
        var key = $(this).attr('data-key');
        if (!key) return;

        var doDelete = function () {
            var headers = sessionHeaders();
            headers['Content-Type'] = 'application/json';
            fetch('/web/chat/memory/delete', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ scope: currentScope, key: key })
            })
                .then(function (r) { return r.json(); })
                .then(function (res) {
                    if (res && res.code === 200) {
                        loadMemories();
                    } else {
                        window.layAlert(t('memory.delete_failed') + (res && res.description ? '：' + res.description : ''));
                    }
                })
                .catch(function () {
                    window.layAlert(t('memory.delete_failed'));
                });
        };
        /* 与对话删除一致：统一 layConfirm 弹框（自动跟随主题），layer 缺失时兜底原生 confirm */
        if (typeof window.layConfirm === 'function') window.layConfirm(t('memory.delete_confirm'), doDelete);
        else if (window.confirm(t('memory.delete_confirm'))) doDelete();
    });

    /* ===================== tab 切换 / 刷新 / 入口绑定 ===================== */

    $view.on('click', '.memory-view-tab', function () {
        var scope = $(this).attr('data-scope');
        if (!scope || scope === currentScope) return;
        currentScope = scope;
        $view.find('.memory-view-tab').removeClass('active');
        $(this).addClass('active');
        loadMemories();
    });

    $('#memoryViewRefreshBtn').on('click', function () { loadMemories(); });

    /* 侧栏主导航入口（委托绑定，兼容脚本加载时序） */
    $(document).on('click', '#memoryNavBtn', function () {
        openMemoryView();
    });

    /* 专注模式入口：以弹层形式打开记忆视图，不退出专注模式 */
    $(document).on('click', '#filerMemoryBtn', function () {
        if (window.appMode === 'code') openMemoryView({ overlay: true });
        else openMemoryView();
    });

    /* 弹层关闭（专注模式）：关闭按钮 / Esc / 点击遮罩空白处 */
    $(document).on('click', '#memoryViewCloseBtn', function () {
        if ($view.hasClass('memory-overlay')) closeMemoryView();
    });
    $view.on('click', function (e) {
        if ($view.hasClass('memory-overlay') && e.target === $view[0]) closeMemoryView();
    });
    $(document).on('keydown', function (e) {
        if (e.key === 'Escape' && $view.hasClass('memory-overlay') && $view.hasClass('active')) closeMemoryView();
    });
})();
