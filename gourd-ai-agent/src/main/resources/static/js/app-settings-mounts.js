/**
 * app-settings-mounts.js — 设置面板子模块
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

    var $mountsList = $('#mountsList');
    var $mountsListView = $('#mountsListView');
    var $mountsFormView = $('#mountsFormView');
    var $mountsSkillsView = $('#mountsSkillsView');
    var $mountsSkillsList = $('#mountsSkillsList');
    var $mountsFormTitle = $('#mountsFormTitle');
    var $mountsSkillsTitle = $('#mountsSkillsTitle');
    var $mountsSaveBtn = $('#mountsSaveBtn');
    var mountsCachedList = [];
    var mountsCurrentAlias = null;
    var mountsCurrentType = null;
    var mountsCurrentRealPath = null;
    var mountsEditAlias = null;
    var $mountsTypeBtns = $('#mountsTypeToggle .mcp-type-btn');

    function showMountsListView() { $mountsFormView.hide(); $mountsSkillsView.hide(); $mountsListView.addClass('slide-back').show(); setTimeout(function(){ $mountsListView.removeClass('slide-back'); }, 260); }
    function showMountsFormView(title) { $mountsFormTitle.text(title || GourdI18n.t('settings.mounts.add')); $mountsListView.hide(); $mountsSkillsView.hide(); $mountsFormView.show(); }
    function showMountsSkillsView() { $mountsListView.hide(); $mountsFormView.hide(); $mountsSkillsView.show(); }
    function setMountsType(type) {
        $mountsTypeBtns.removeClass('active');
        $mountsTypeBtns.filter('[data-type="' + type + '"]').addClass('active');
    }
    function getMountsType() {
        return $mountsTypeBtns.filter('.active').attr('data-type') || 'SKILLS';
    }

    // ==================== 挂载管理 ====================

    function loadMountsList() {
        $.get('/web/settings/mounts', function (resp) {
            if (resp.code === 200 && resp.data) {
                mountsCachedList = resp.data;
                renderMountsList(resp.data);
            }
        });
    }

    function renderMountsList(list) {
        var html = '';
        var tAdd = GourdI18n.t('settings.mounts.add');
        var tSystem = GourdI18n.t('settings.mounts.system');
        var tWorkspace = GourdI18n.t('settings.mounts.scope_workspace');
        var tWriteable = GourdI18n.t('settings.mounts.writeable');
        var tEdit = GourdI18n.t('common.edit');
        var tEnable = GourdI18n.t('settings.loop.enable');
        var tDisable = GourdI18n.t('settings.loop.disable');
        if (!list || list.length === 0) {
            html = '<div class="mcp-empty-state">'
                + '<div class="mcp-empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="1.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg></div>'
                + '<div class="mcp-empty-title">' + GourdI18n.t('common.no_data') + GourdI18n.t('settings.mounts.title') + '</div>'
                + '<div class="mcp-empty-desc">' + GourdI18n.t('settings.mounts.desc') + '</div></div>';
        } else {
            // 系统挂载排前面
            var sorted = list.slice().sort(function (a, b) {
                var as = a.system === true ? 0 : 1;
                var bs = b.system === true ? 0 : 1;
                return as - bs;
            });
            sorted.forEach(function (item) {
                var alias = item.alias || '';
                var path = item.path || '';
                var isSystem = item.system === true;
                var typeMap = { SKILLS: 'S', FILES: 'F', AGENTS: 'A' };
                var iconText = typeMap[item.type] || (item.type ? item.type.charAt(0).toUpperCase() : 'M');
                html += '<div class="mcp-server-item mounts-pool-item' + (isSystem ? ' mounts-system' : '') + (item.enabled === false ? ' disabled' : '') + '" data-alias="' + escapeAttr(alias) + '">'
                    + '<div class="mcp-server-icon">' + escapeHtml(iconText) + '</div>'
                    + '<div class="mcp-server-info">'
                    + '<div class="mcp-server-name">' + escapeHtml(alias)
                    + (isSystem ? ' <span class="mounts-system-badge">' + tSystem + '</span>' : '')
                    + (item.scope === 'workspace' ? ' <span class="mounts-scope-badge scope-workspace">' + tWorkspace + '</span>' : '')
                    + (item.writeable ? ' <span class="mounts-writeable-badge">' + tWriteable + '</span>' : '')
                    + '</div>'
                    + (item.description ? '<div class="mcp-server-detail settings-muted-text">' + escapeHtml(item.description) + '</div>' : '')
                    + (path ? '<div class="mcp-server-detail">' + escapeHtml(path) + '</div>' : '')
                    + '</div><div class="mcp-server-actions">'
                    + '<button class="mcp-action-btn edit mounts-edit-btn" data-alias="' + escapeAttr(alias) + '" title="' + tEdit + '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>'
                    + '<label class="toggle-switch" title="' + ((item.enabled !== false) ? tDisable : tEnable) + '">'
                    + '<input type="checkbox" ' + (item.enabled !== false ? 'checked' : '') + ' data-alias="' + escapeAttr(alias) + '" class="mounts-toggle"/> '
                    + '<span class="toggle-slider"></span>'
                    + '</label>'
                    + '</div></div>';
            });
        }
        $mountsList.html(html);
    }

    // 从缓存查找挂载类型
    function getMountType(alias) {
        var item = mountsCachedList.find(function (m) { return m.alias === alias; });
        return item ? (item.type || 'SKILLS') : 'SKILLS';
    }

    // 编辑挂载（只允许编辑描述和可写）
    function mountsEditPool(alias) {
        var item = mountsCachedList.find(function (m) { return m.alias === alias; });
        if (!item) return;
        mountsEditAlias = alias;
        var isSystem = item.system === true;

        // 填充表单（别名和路径只读）
        $('#mountsAlias').val(item.alias || '').prop('readOnly', true);
        $('#mountsPath').val(item.path || '').prop('readOnly', true);
        var isSystemScope = isSystem;
        setMountsType(item.type || 'SKILLS');
        $mountsTypeBtns.prop('disabled', true).addClass('disabled');
        setScopeValue('mountsScope', item.scope || 'user');
        setScopeReadonly('mountsScope', isSystemScope);
        $('#mountsWriteable').prop('checked', !!item.writeable).prop('disabled', isSystem);
        $('#mountsDescription').val(item.description || '').prop('readOnly', isSystem);

        // 编辑模式：隐藏保存按钮（系统挂载）、预设区；非系统：显示删除按钮
        $mountsSaveBtn.toggle(!isSystem);
        $('#mountsFormActions').toggle(!isSystem);
        $('#mountsPresetsDivider, .mounts-presets').hide(); // 编辑时始终隐藏预设区

        // 只读输入控件浅灰底色
        $('#mountsAlias, #mountsPath').addClass('readonly-gray');
        if (isSystem) { $('#mountsDescription').addClass('readonly-gray'); }
        else { $('#mountsDescription').removeClass('readonly-gray'); }

        $mountsSaveBtn.text(GourdI18n.t('settings.loop.updated'));
        showMountsFormView(GourdI18n.t('settings.mounts.edit_title'));
    }

    // 池列表事件委托
    $mountsList
        .on('click', '.mcp-action-btn.edit.mounts-edit-btn', function (e) {
            e.stopPropagation();
            var alias = $(this).attr('data-alias');
            mountsEditPool(alias);
        })
        .on('click', '.mounts-pool-item', function (e) {
            if ($(e.target).closest('.toggle-switch').length) return;
            if ($(e.target).closest('.mcp-action-btn').length) return;
            var alias = $(this).attr('data-alias');
            loadMountsContent(alias, getMountType(alias));
        })
        .on('change', '.mounts-toggle', function () {
            var alias = $(this).attr('data-alias');
            var enabled = this.checked;
            $.ajax({
                url: '/web/settings/mounts/toggle',
                method: 'POST',
                contentType: 'application/json',
                data: JSON.stringify({ alias: alias, enabled: enabled }),
                success: function (resp) {
                    if (resp.code === 200) {
                        showToast(enabled ? GourdI18n.t('settings.loop.enable') : GourdI18n.t('settings.loop.disable'), 'success');
                    } else {
                        showToast(resp.message || GourdI18n.t('settings.loop.operation_failed'), 'error');
                    }
                },
                error: function () {
                    showToast(GourdI18n.t('settings.loop.operation_failed') + '，' + GourdI18n.t('settings.network_error'), 'error');
                },
                // 无论成败都刷新列表，确保开关状态与服务端一致
                complete: function () { loadMountsList(); }
            });
        });

    // 池内容加载与渲染（按类型分发）
    function loadMountsContent(alias, type) {
        mountsCurrentAlias = alias;
        mountsCurrentType = type || 'SKILLS';

        // 从缓存列表中查找 realPath
        var mountItem = mountsCachedList.find(function (m) { return m.alias === alias; });
        mountsCurrentRealPath = mountItem ? (mountItem.realPath || '') : '';

        var tSkillsList = GourdI18n.t('settings.mounts.skills_list_title');
        var tAgentsList = GourdI18n.t('settings.mounts.agents_list_title');
        var tFilesList = GourdI18n.t('settings.mounts.files_list_title');
        var titleMap = { SKILLS: tSkillsList, AGENTS: tAgentsList, FILES: tFilesList };
        $mountsSkillsTitle.text(alias + ' - ' + (titleMap[mountsCurrentType] || GourdI18n.t('settings.mounts.content_list')));
        showMountsSkillsView();
        $mountsSkillsList.html('<div class="mcp-empty-state"><div class="skills-loading" style="display:block"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg><span>' + GourdI18n.t('common.loading') + '</span></div></div>');

        $.get('/web/settings/mounts/content', { alias: alias, type: mountsCurrentType }, function (resp) {
            if (resp.code === 200 && resp.data) renderMountsContent(resp.data, mountsCurrentType);
            else {
                $mountsSkillsList.html('<div class="mcp-empty-state"><div class="mcp-empty-title">' + escapeHtml(resp.message || GourdI18n.t('settings.network_error')) + '</div></div>');
                showToast(resp.message || GourdI18n.t('settings.network_error'), 'error');
            }
        }).fail(function () {
            $mountsSkillsList.html('<div class="mcp-empty-state"><div class="mcp-empty-title">' + GourdI18n.t('settings.network_error') + '</div></div>');
            showToast(GourdI18n.t('settings.network_error'), 'error');
        });
    }

    function renderMountsContent(list, type) {
        if (type === 'AGENTS') { renderAgentsList(list); return; }
        if (type === 'FILES') {
            $mountsSkillsList.html('<div class="mcp-empty-state">'
                + '<div class="mcp-empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="1.5"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg></div>'
                + '<div class="mcp-empty-title">' + GourdI18n.t('common.no_data') + GourdI18n.t('settings.mounts.type_files') + '</div>'
                + '<div class="mcp-empty-desc">' + GourdI18n.t('settings.mounts.type_files') + GourdI18n.t('chat.loading_dots') + '</div></div>');
            return;
        }
        renderSkillsList(list);
    }

    function renderSkillsList(list) {
        var html = '';
        var tSkillPkg = GourdI18n.t('settings.mounts.skills_list_title');
        var tDelete = GourdI18n.t('common.delete');
        if (!list || list.length === 0) {
            html = '<div class="mcp-empty-state">'
                + '<div class="mcp-empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="1.5"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></div>'
                + '<div class="mcp-empty-title">' + GourdI18n.t('common.no_data') + tSkillPkg + '</div>'
                + '<div class="mcp-empty-desc">' + GourdI18n.t('settings.skills.install') + GourdI18n.t('settings.skills.title') + '</div></div>';
        } else {
            html += '<div class="mounts-skills-count">' + list.length + ' ' + GourdI18n.t('settings.mounts.skill_pkg') + '</div>';
            list.forEach(function (skill) {
                html += '<div class="mcp-server-item mounts-skill-item" data-real-path="' + escapeAttr(skill.realPath || '') + '">'
                    + '<div class="mcp-server-info">'
                    + '<div class="mcp-server-name">' + escapeHtml(skill.name) + '</div>'
                    + (skill.realPath ? '<div class="mcp-server-detail">' + escapeHtml(skill.realPath) + '</div>' : '')
                    + (skill.description ? '<div class="mcp-server-detail">' + escapeHtml(skill.description) + '</div>' : '')
                    + '</div><div class="mcp-server-actions">'
                    + '<button class="mcp-action-btn delete" data-skill="' + escapeAttr(skill.name) + '" title="' + tDelete + GourdI18n.t('settings.mounts.skill_pkg') + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>'
                    + '</div></div>';
            });
        }
        $mountsSkillsList.html(html);
    }

    function renderAgentsList(list) {
        var html = '';
        var tAgents = GourdI18n.t('app.subagent');
        if (!list || list.length === 0) {
            html = '<div class="mcp-empty-state">'
                + '<div class="mcp-empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>'
                + '<div class="mcp-empty-title">' + GourdI18n.t('common.no_data') + tAgents + '</div>'
                + '<div class="mcp-empty-desc">' + tAgents + GourdI18n.t('settings.mounts.desc') + '</div></div>';
        } else {
            html += '<div class="mounts-skills-count">' + list.length + ' ' + tAgents + '</div>';
            list.forEach(function (agent) {
                var name = agent.name || '';
                var filePath = agent.filePath || '';
                html += '<div class="mcp-server-item mounts-skill-item" data-real-path="' + escapeAttr(filePath) + '">'
                    + '<div class="mcp-server-info">'
                    + '<div class="mcp-server-name">' + escapeHtml(name) + '</div>'
                    + (filePath ? '<div class="mcp-server-detail">' + escapeHtml(filePath) + '</div>' : '')
                    + '</div></div>';
            });
        }
        $mountsSkillsList.html(html);
    }

    // 技能包删除事件
    $mountsSkillsList.on('click', '.mcp-action-btn.delete', function (e) {
        e.stopPropagation();
        var skillName = $(this).attr('data-skill');
        layConfirm(GourdI18n.t('settings.confirm_delete') + ' "' + skillName + '"？' + GourdI18n.t('settings.loop.confirm_delete'), function() {
            postJson('/web/settings/mounts/skills/remove', { alias: mountsCurrentAlias, skillName: skillName }, function (resp) {
                if (resp.code === 200) { showToast(GourdI18n.t('settings.loop.deleted')); loadMountsContent(mountsCurrentAlias, mountsCurrentType); }
                else showToast(GourdI18n.t('settings.loop.delete_failed') + ': ' + (resp.message || ''), 'error');
            });
        });
    });

    // 点击技能/子代理条目 → 打开其所在目录
    $mountsSkillsList.on('click', '.mounts-skill-item', function (e) {
        if ($(e.target).closest('.mcp-action-btn').length) return;
        var realPath = $(this).data('real-path') || '';
        if (realPath) {
            $.get('/web/settings/mounts/open', { path: realPath }, function (resp) {
                if (resp && resp.code !== 200) {
                    showToast(resp.message || GourdI18n.t('settings.mounts.open_dir') + GourdI18n.t('settings.loop.operation_failed'), 'error');
                }
            }).fail(function () {
                showToast(GourdI18n.t('settings.mounts.open_dir') + GourdI18n.t('settings.loop.operation_failed'), 'error');
            });
        }
    });

    // 打开挂载根目录按钮
    $('#mountsOpenDirBtn').on('click', function () {
        if (mountsCurrentRealPath) {
            $.get('/web/settings/mounts/open', { path: mountsCurrentRealPath }, function (resp) {
                if (resp && resp.code !== 200) {
                    showToast(resp.message || GourdI18n.t('settings.mounts.open_dir') + GourdI18n.t('settings.loop.operation_failed'), 'error');
                }
            }).fail(function () {
                showToast(GourdI18n.t('settings.mounts.open_dir') + GourdI18n.t('settings.loop.operation_failed'), 'error');
            });
        }
    });

    // 刷新挂载内容按钮
    $('#mountsRefreshBtn').on('click', function () {
        if (mountsCurrentAlias) {
            var alias = mountsCurrentAlias;
            var type = mountsCurrentType;
            mountsCurrentAlias = null; // 强制重新加载
            loadMountsContent(alias, type);
        }
    });

    // 删除按钮（在二次编辑页）
    $('#mountsFormDeleteBtn').on('click', function () {
        var alias = mountsEditAlias;
        if (!alias) return;
        layConfirm(GourdI18n.t('settings.confirm_delete') + ' "' + alias + '"？（' + GourdI18n.t('settings.code.remove_no_delete') + '）', function() {
            $.post('/web/settings/mounts/remove', { alias: alias }, function (resp) {
                if (resp && resp.code === 200) { showToast(GourdI18n.t('settings.loop.deleted')); mountsEditAlias = null; showMountsListView(); loadMountsList(); }
                else showToast(GourdI18n.t('settings.loop.delete_failed') + ': ' + ((resp && resp.message) || GourdI18n.t('common.unknown_error')), 'error');
            }, 'json').fail(function () { showToast(GourdI18n.t('settings.network_error'), 'error'); });
        });
    });

    // 添加/返回/保存按钮
    $('#mountsAddBtn').on('click', function () {
        mountsEditAlias = null;
        $('#mountsAlias').val('').prop('readOnly', false).removeClass('readonly-gray');
        $('#mountsPath').val('').prop('readOnly', false).removeClass('readonly-gray');
        setMountsType('SKILLS');
        $mountsTypeBtns.prop('disabled', false).removeClass('disabled');
        $('#mountsWriteable').prop('checked', false).prop('disabled', false);
        $('#mountsDescription').val('').prop('readOnly', false).removeClass('readonly-gray');
        setScopeValue('mountsScope', 'user');
        setScopeReadonly('mountsScope', false);
        $('#mountsFormActions').hide();
        $('#mountsPresetsDivider, .mounts-presets').show();
        $mountsSaveBtn.text(GourdI18n.t('common.save')).show();
        showMountsFormView(GourdI18n.t('settings.mounts.add_title'));
    });
    $('#mountsBackBtn').on('click', function () { mountsEditAlias = null; showMountsListView(); });
    $('#mountsSkillsBackBtn').on('click', function () { showMountsListView(); loadMountsList(); });

    $mountsSaveBtn.on('click', function () {
        var alias = $('#mountsAlias').val().trim();
        var path = $('#mountsPath').val().trim();
        if (!alias) { showToast(GourdI18n.t('settings.mounts.alias') + GourdI18n.t('common.required'), 'error'); return; }
        if (!/^@/.test(alias)) { showToast(GourdI18n.t('settings.mounts.alias') + ' @ ' + GourdI18n.t('common.required'), 'error'); return; }
        if (!path) { showToast(GourdI18n.t('settings.mounts.path') + GourdI18n.t('common.required'), 'error'); return; }

        var type = getMountsType();
        var writeable = $('#mountsWriteable').is(':checked');
        var description = $('#mountsDescription').val().trim();

        var isEdit = !!mountsEditAlias;
        var url = isEdit ? '/web/settings/mounts/update' : '/web/settings/mounts/add';
        var actionText = isEdit ? GourdI18n.t('settings.loop.updated') : GourdI18n.t('common.add');

        var bodyObj = { alias: alias, path: path, type: type, writeable: writeable, description: description, scope: $('#mountsScope').val() || 'user' };

        $mountsSaveBtn.prop('disabled', true);
        $.ajax({ url: url, method: 'POST', data: JSON.stringify(bodyObj), contentType: 'application/json', dataType: 'json' })
            .done(function (resp) {
                if (resp.code === 200) { showToast(actionText + GourdI18n.t('settings.loop.operation_success')); mountsEditAlias = null; loadMountsList(); showMountsListView(); }
                else showToast(actionText + GourdI18n.t('settings.loop.operation_failed') + ': ' + (resp.message || ''), 'error');
            })
            .fail(function () { showToast(GourdI18n.t('settings.network_error'), 'error'); })
            .always(function () { $mountsSaveBtn.prop('disabled', false); });
    });

    // 常见挂载预设按钮 - 仅在添加模式下可用，编辑模式下禁止点击
    $(document).on('click', '.mounts-preset-btn', function (e) {
        if (mountsEditAlias) { e.preventDefault(); return; }
        var alias = $(this).data('alias');
        var path = $(this).data('path');
        $('#mountsAlias').val(alias);
        $('#mountsPath').val(path);
        setMountsType('SKILLS');
        $('#mountsWriteable').prop('checked', false);
        $('#mountsDescription').val('');
    });

    // 类型联动
    $('#mountsTypeToggle').on('click', '.mcp-type-btn', function () {
        if ($(this).prop('disabled')) return;
        $mountsTypeBtns.removeClass('active');
        $(this).addClass('active');
    });


    window._settingsMounts = { load: loadMountsList, reset: function(){ mountsEditAlias = null; }, showList: showMountsListView };
})();