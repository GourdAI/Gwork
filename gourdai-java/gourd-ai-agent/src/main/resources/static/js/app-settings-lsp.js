/**
 * app-settings-lsp.js — 设置面板子模块
 */
(function () {
    'use strict';

    var core = window._settingsCore;
    var escapeHtml = core.escapeHtml;
    var escapeAttr = core.escapeAttr;
    var parseKvLines = core.parseKvLines;
    var postJson = core.postJson;
    var showToast = core.showToast;
    var setScopeValue = core.setScopeValue;
    var setScopeReadonly = core.setScopeReadonly;

    var $lspServerList = $('#lspServerList');
    var $lspSaveBtn = $('#lspSaveBtn');
    var $lspFormTitle = $('#lspFormTitle');
    var $lspListView = $('#lspListView');
    var $lspFormView = $('#lspFormView');
    var lspEditName = null;
    var lspCachedList = [];

    function showLspListView() { $lspFormView.hide(); $lspListView.addClass('slide-back').show(); setTimeout(function(){ $lspListView.removeClass('slide-back'); }, 260); }
    function showLspFormView(title, isEdit) { $lspFormTitle.text(title || GourdI18n.t('settings.lsp.add')); $lspListView.hide(); $lspFormView.show(); $('#lspFormActions').toggle(!!isEdit); }

    // ==================== LSP 服务器管理 ====================

    function loadLspList() {
        $.get('/web/settings/lsp/servers', function (resp) {
            if (resp.code === 200 && resp.data) {
                lspCachedList = resp.data;
                renderLspList(resp.data);
            }
        }).fail(function () { console.error('[Settings] Failed to load LSP servers'); });
    }

    function renderLspList(list) {
        var html = '';
        var tWorkspace = GourdI18n.t('settings.general.scope_workspace');
        var tInstalled = GourdI18n.t('settings.skills.installed');
        var tEdit = GourdI18n.t('common.edit');
        var tEnable = GourdI18n.t('settings.loop.enable');
        var tDisable = GourdI18n.t('settings.loop.disable');
        if (!list || list.length === 0) {
            html = '<div class="mcp-empty-state">'
                + '<div class="mcp-empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="1.5"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></div>'
                + '<div class="mcp-empty-title">' + GourdI18n.t('common.no_data') + GourdI18n.t('settings.lsp.title') + '</div>'
                + '<div class="mcp-empty-desc">' + GourdI18n.t('settings.lsp.desc') + '</div>'
                + '</div>';
        } else {
            list.forEach(function (item) {
                var name = item.name || '';
                var command = (item.command && item.command.length > 0) ? item.command.join(' ') : '';
                var extensions = (item.extensions && item.extensions.length > 0) ? item.extensions.join(', ') : '';
                var enabled = item.enabled !== false;
                var installed = item.installed !== false;
                var badges = '<span class="settings-inline-tag">[lsp]</span>';
                if (item.scope === 'workspace') badges += ' <span class="settings-scope-badge">' + tWorkspace + '</span>';
                if (installed) badges += ' <span class="skill-installed-badge">' + tInstalled + '</span>';
                html += '<div class="mcp-server-item' + (item.enabled === false ? ' disabled' : '') + '" data-name="' + escapeAttr(name) + '">'
                    + '<div class="mcp-server-icon">L</div>'
                    + '<div class="mcp-server-info">'
                    + '<div class="mcp-server-name">' + escapeHtml(name) + ' ' + badges + '</div>'
                    + (command ? '<div class="mcp-server-detail">' + escapeHtml(command) + '</div>' : '')
                    + (extensions ? '<div class="mcp-server-detail settings-accent-text">' + escapeHtml(extensions) + '</div>' : '')
                    + '</div><div class="mcp-server-actions">'
                    + '<button class="mcp-action-btn edit" data-name="' + escapeAttr(name) + '" title="' + tEdit + '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>'
                    + '<label class="toggle-switch" title="' + (enabled ? tDisable : tEnable) + '">'
                    + '<input type="checkbox" ' + (enabled ? 'checked' : '') + ' data-name="' + escapeAttr(name) + '" class="lsp-toggle"/>'
                    + '<span class="toggle-slider"></span>'
                    + '</label>'
                    + '</div></div>';
            });
        }
        $lspServerList.html(html);
    }

    // LSP 列表事件委托
    $lspServerList
        .on('click', '.mcp-action-btn.edit', function (e) {
            e.stopPropagation();
            var name = $(this).attr('data-name');
            if (name) lspEditServer(name);
        })
        .on('change', '.lsp-toggle', function () {
            lspToggleServer($(this).attr('data-name'), this.checked);
        });

    // ==================== LSP 表单 ====================

    function resetLspForm() {
        lspEditName = null;
        $lspSaveBtn.text(GourdI18n.t('common.save'));
        $('#lspName').val('').prop('readOnly', false).removeClass('readonly-gray');
        $('#lspCommand, #lspExtensions, #lspEnv').val('');
        setScopeValue('lspScope', 'user');
        setScopeReadonly('lspScope', false);
        $('#lspFormDeleteBtn').hide();
    }

    function fillLspForm(server) {
        setScopeValue('lspScope', server.scope || 'user');
        var command = (server.command && server.command.length > 0) ? server.command.join(' ') : '';
        $('#lspCommand').val(command);
        var extensions = (server.extensions && server.extensions.length > 0) ? server.extensions.join(', ') : '';
        $('#lspExtensions').val(extensions);
        var envLines = [];
        if (server.env) Object.keys(server.env).forEach(function (k) { envLines.push(k + '=' + server.env[k]); });
        $('#lspEnv').val(envLines.join('\n'));
    }

    function buildLspBodyObj() {
        var name = $('#lspName').val().trim();
        var command = $('#lspCommand').val().trim();
        var extensions = $('#lspExtensions').val().trim();
        var envText = $('#lspEnv').val().trim();
        var tName = GourdI18n.t('common.name');
        var tCommand = GourdI18n.t('settings.lsp.command');
        if (!name) { showToast(tName + GourdI18n.t('common.required'), 'error'); return null; }
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) { showToast(tName + GourdI18n.t('settings.lsp.name_placeholder'), 'error'); return null; }
        if (!command) { showToast(tCommand + GourdI18n.t('common.required'), 'error'); return null; }
        var bodyObj = { name: name, enabled: true, scope: $('#lspScope').val() || 'user' };
        // command as string (backend handles split)
        bodyObj.command = command;
        // extensions as array
        if (extensions) {
            bodyObj.extensions = extensions.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
        }
        var env = parseKvLines(envText);
        if (Object.keys(env).length > 0) bodyObj.env = env;
        return bodyObj;
    }

    function lspEditServer(name) {
        var server = lspCachedList.find(function (s) { return s.name === name; });
        if (!server) return;
        lspEditName = name;
        showLspFormView(GourdI18n.t('settings.lsp.edit_title'), true);
        $lspSaveBtn.text(GourdI18n.t('settings.loop.updated'));
        $('#lspName').val(server.name).prop('readOnly', true).addClass('readonly-gray');
        setScopeValue('lspScope', server.scope || 'user');
        $('#lspFormDeleteBtn').show();
        fillLspForm(server);
    }

    function lspToggleServer(name, enabled) {
        postJson('/web/settings/lsp/servers/toggle', { name: name, enabled: enabled }, function (resp) {
            if (resp.code !== 200) { showToast(GourdI18n.t('settings.loop.operation_failed') + ': ' + (resp.message || GourdI18n.t('common.unknown_error')), 'error'); }
            // 无论成败都刷新列表，确保开关状态与服务端一致
            loadLspList();
        });
    }

    // LSP 按钮事件
    $('#lspAddBtn').on('click', function () { resetLspForm(); showLspFormView(GourdI18n.t('settings.lsp.add_title'), false); });
    $('#lspBackBtn').on('click', function () { showLspListView(); resetLspForm(); });

    // LSP 表单 - 删除按钮
    $('#lspFormDeleteBtn').on('click', function () {
        var name = lspEditName;
        if (!name) return;
        layConfirm(GourdI18n.t('settings.confirm_delete') + ' LSP ' + GourdI18n.t('settings.lsp.title') + ' "' + name + '"？', function() {
            postJson('/web/settings/lsp/servers/remove', { name: name }, function (resp) {
                if (resp.code === 200) { showLspListView(); loadLspList(); }
                else showToast(GourdI18n.t('settings.loop.delete_failed') + ': ' + (resp.message || GourdI18n.t('common.unknown_error')), 'error');
            });
        });
    });

    $lspSaveBtn.on('click', function () {
        var bodyObj = buildLspBodyObj();
        if (!bodyObj) return;
        var isEdit = !!lspEditName;
        var url = isEdit ? '/web/settings/lsp/servers/update' : '/web/settings/lsp/servers/add';
        var actionText = isEdit ? GourdI18n.t('settings.loop.updated') : GourdI18n.t('common.add');
        if (isEdit) bodyObj.originalName = lspEditName;

        $lspSaveBtn.prop('disabled', true);
        $.ajax({ url: url, method: 'POST', data: JSON.stringify(bodyObj), contentType: 'application/json', dataType: 'json' })
            .done(function (resp) {
                if (resp.code === 200) { showToast(actionText + GourdI18n.t('settings.loop.operation_success')); loadLspList(); showLspListView(); resetLspForm(); }
                else showToast(actionText + GourdI18n.t('settings.loop.operation_failed') + ': ' + (resp.message || GourdI18n.t('common.unknown_error')), 'error');
            })
            .fail(function () { showToast(GourdI18n.t('settings.network_error'), 'error'); })
            .always(function () { $lspSaveBtn.prop('disabled', false); });
    });



    window._settingsLsp = { load: loadLspList, reset: resetLspForm, showList: showLspListView };
})();