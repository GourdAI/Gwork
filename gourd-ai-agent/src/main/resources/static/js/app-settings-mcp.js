/**
 * app-settings-mcp.js — 设置面板子模块
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
        $('#mcpConfigRemote').toggle(type === 'sse' || type === 'streamable' || type === 'streamable_stateless');
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
        var tWorkspace = GourdI18n.t('settings.mounts.scope_workspace');
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
                    + '<div class="mcp-server-name">' + escapeHtml(name) + ' <span class="settings-inline-tag">[' + escapeHtml(type) + ']</span>' + (item.scope === 'workspace' ? ' <span class="mounts-scope-badge scope-workspace">' + tWorkspace + '</span>' : '') + '</div>'
                    + (detail ? '<div class="mcp-server-detail">' + escapeHtml(detail) + '</div>' : '')
                    + '</div><div class="mcp-server-actions">'
                    + '<button class="mcp-action-btn edit mcp-edit-btn" data-name="' + escapeAttr(name) + '" title="' + tEdit + '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>'
                    + '<button class="mcp-action-btn delete mcp-delete-btn" data-name="' + escapeAttr(name) + '" title="' + tDelete + '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>'
                    + '<label class="toggle-switch" title="' + ((item.enabled !== false) ? tDisable : tEnable) + '">'
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
                + '<label class="mcp-tool-checkbox" title="' + (isEnabled ? tDisable : tEnable) + '">'
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
        setScopeValue('mcpScope', 'user');
        setScopeReadonly('mcpScope', false);
        setMcpType('stdio');
    }

    function fillMcpForm(server) {
        var type = server.type || 'stdio';
        setMcpType(type);
        setScopeValue('mcpScope', server.scope || 'user');

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

        $mcpSaveBtn.prop('disabled', true);
        $.ajax({ url: url, method: 'POST', data: JSON.stringify(bodyObj), contentType: 'application/json', dataType: 'json' })
            .done(function (resp) {
                if (resp.code === 200) { showToast(actionText + GourdI18n.t('settings.loop.operation_success')); loadMcpList(); showMcpListView(); resetMcpForm(); }
                else showToast(actionText + GourdI18n.t('settings.loop.operation_failed') + ': ' + (resp.message || GourdI18n.t('common.unknown_error')), 'error');
            })
            .fail(function () { showToast(GourdI18n.t('settings.network_error'), 'error'); })
            .always(function () { $mcpSaveBtn.prop('disabled', false); });
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
                ? '<span class="import-preview-badge badge-exists" title="' + tExists + '，' + GourdI18n.t('settings.mcp.import') + GourdI18n.t('settings.mcp.import_skipped') + '">' + tExists + '</span>'
                : '<span class="import-preview-badge badge-new">' + tNew + '</span>';
            var disabled = exists ? ' disabled' : '';
            
            var errorBadge = srv.error
                ? '<span class="import-preview-badge badge-error" title="' + escapeAttr(srv.error) + '">' + tFormatError + '</span>'
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