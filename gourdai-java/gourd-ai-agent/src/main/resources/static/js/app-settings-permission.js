/**
 * app-settings-permission.js — 工具权限设置模块（可视化工具列表）
 *
 * 依赖：layui.js（jQuery）
 */
(function () {
    'use strict';

    // 工具定义列表 - 按列分组
    var TOOLS_COLUMNS = [
        // 第一列：文件操作
        [
            { id: 'bash', name: 'bash', desc: GourdI18n.t('settings.permission.tool.bash_desc'), risk: 'low' },
            { id: 'read', name: 'read', desc: GourdI18n.t('settings.permission.tool.read_desc'), risk: 'low' },
            { id: 'write', name: 'write', desc: GourdI18n.t('settings.permission.tool.write_desc'), risk: 'low' },
            { id: 'edit', name: 'edit', desc: GourdI18n.t('settings.permission.tool.edit_desc'), risk: 'low' },
            { id: 'grep', name: 'grep', desc: GourdI18n.t('settings.permission.tool.grep_desc'), risk: 'low' },
            { id: 'glob', name: 'glob', desc: GourdI18n.t('settings.permission.tool.glob_desc'), risk: 'low' },
            { id: 'ls', name: 'ls', desc: GourdI18n.t('settings.permission.tool.ls_desc'), risk: 'low' }
        ],
        // 第二列：网络搜索
        [
            { id: 'codesearch', name: 'codesearch', desc: GourdI18n.t('settings.permission.tool.codesearch_desc'), risk: 'low' },
            { id: 'websearch', name: 'websearch', desc: GourdI18n.t('settings.permission.tool.websearch_desc'), risk: 'low' },
            { id: 'webfetch', name: 'webfetch', desc: GourdI18n.t('settings.permission.tool.webfetch_desc'), risk: 'low' }
        ],
        // 第三列：任务管理
        [
            { id: 'code', name: 'code', desc: GourdI18n.t('settings.permission.tool.code_desc'), risk: 'low' },
            { id: 'todo', name: 'todo', desc: GourdI18n.t('settings.permission.tool.todo_desc'), risk: 'low' },
            { id: 'skill', name: 'skill', desc: GourdI18n.t('settings.permission.tool.skill_desc'), risk: 'low' }
        ]
    ];

    // 分类显示名称
    var CATEGORY_NAMES = {
        'builtin': GourdI18n.t('settings.permission.title')
    };

    // 风险等级显示
    var RISK_LABELS = {
        'high': '<span class="permission-risk-high">' + GourdI18n.t('settings.permission.risk_high') + '</span>',
        'medium': '<span class="permission-risk-medium">' + GourdI18n.t('settings.permission.risk_medium') + '</span>',
        'low': ''
    };

    function showToast(msg, type) {
        if (typeof layer !== 'undefined' && layer.msg) {
            layer.msg(msg, { icon: type === 'error' ? 2 : 1, time: 2500, offset: '120px' });
        } else if (typeof window.layAlert === 'function') {
            window.layAlert(msg);   // 桌面端规约禁原生 alert
        }
    }

    // 数组 -> 多行文本
    function toLines(arr) {
        if (!arr || !arr.length) return '';
        return arr.join('\n');
    }

    // 多行文本 -> 去重去空的数组
    function toList(text) {
        var seen = {};
        var out = [];
        (text || '').split('\n').forEach(function (line) {
            var v = line.trim();
            if (v && !seen[v]) {
                seen[v] = true;
                out.push(v);
            }
        });
        return out;
    }

    // 渲染工具列表 - 网格布局
    function renderToolsList(disallowedTools) {
        var disallowedMap = {};
        disallowedTools.forEach(function (t) { disallowedMap[t] = true; });

        var $list = $('#permissionToolsList');
        
        var html = '<div class="permission-tools-grid">';
        
        // 渲染三列
        TOOLS_COLUMNS.forEach(function (column, colIndex) {
            html += '<div class="permission-tools-column">';
            
            column.forEach(function (tool) {
                var isEnabled = !disallowedMap[tool.id];
                html += '<div class="permission-tool-item">';
                html += '<label class="permission-tool-checkbox" title="' + (isEnabled ? GourdI18n.t('chat.deny') : GourdI18n.t('chat.approve')) + '">';
                html += '<input type="checkbox" ' + (isEnabled ? 'checked' : '') + ' data-tool="' + escapeAttr(tool.id) + '" class="permission-tool-toggle"/>';
                html += '<span class="permission-tool-checkmark"></span>';
                html += '</label>';
                html += '<div class="permission-tool-info">';
                html += '<div class="permission-tool-name">' + escapeHtml(tool.name) + RISK_LABELS[tool.risk] + '</div>';
                html += '<div class="permission-tool-desc">' + escapeHtml(tool.desc) + '</div>';
                html += '</div>';
                html += '</div>';
            });
            
            html += '</div>';
        });
        
        html += '</div>';

        if (html === '') {
            html = '<div class="permission-empty-state">' + GourdI18n.t('settings.permission.no_match') + '</div>';
        }

        $list.html(html);
        updatePermissionCount(disallowedTools);
    }

    // 更新计数（已移除计数显示）
    function updatePermissionCount(disallowedTools) {
        // 计数显示已移除，保留函数避免调用错误
    }

    // 加载权限设置
    function loadPermissionSettings() {
        $.get('/web/settings/permission', function (resp) {
            if (resp.code === 200 && resp.data) {
                var disallowedTools = resp.data.disallowedTools || [];
                renderToolsList(disallowedTools);
                // bash 读写豁免目录回显：后端 permissionGet 直接返回整个 PermissionGroupDo，
                // 故新字段随 data 一并到达，无需额外接口。
                $('#bashExemptDirs').val(toLines(resp.data.bashExemptDirs || []));
                // 已移除高级模式同步
            }
        }).fail(function () { console.error('[Settings] Failed to load permission settings'); });
    }

    // 获取当前禁用的工具列表
    function getDisallowedTools() {
        var disallowedTools = [];
        $('#permissionToolsList .permission-tool-toggle:not(:checked)').each(function () {
            disallowedTools.push($(this).attr('data-tool'));
        });
        return disallowedTools;
    }

    // 保存权限设置
    function savePermissionSettings() {
        // 从复选框获取禁用的工具列表
        var disallowedTools = getDisallowedTools();

        var $btn = $('#permissionSaveBtn');
        $btn.prop('disabled', true);
        
        // bash 读写豁免目录：多行文本 -> 去重去空数组。
        // 必须显式带上这个键，否则后端按「键不存在=不更新」的部分提交语义保留旧值，
        // 用户在此清空后将无法真正删除已配置的豁免目录。
        var bashExemptDirs = toList($('#bashExemptDirs').val());

        // 后端API需要tools字段，留空表示允许所有
        var bodyObj = {
            tools: ['**'],  // 允许所有工具
            disallowedTools: disallowedTools,
            bashExemptDirs: bashExemptDirs
        };

        $.ajax({ url: '/web/settings/permission/save', method: 'POST', data: JSON.stringify(bodyObj), contentType: 'application/json', dataType: 'json' })
            .done(function (resp) {
                if (resp.code === 200) {
                    showToast(GourdI18n.t('settings.saved'));
                    loadPermissionSettings();
                } else {
                    showToast(GourdI18n.t('settings.save_failed') + ': ' + (resp.message || GourdI18n.t('common.unknown_error')), 'error');
                }
            })
            .fail(function () { showToast(GourdI18n.t('settings.network_error'), 'error'); })
            .always(function () { $btn.prop('disabled', false); });
    }

    // 转义HTML
    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // 转义属性
    function escapeAttr(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // 初始化事件绑定
    function initEvents() {
        // 保存按钮
        $('#permissionSaveBtn').on('click', savePermissionSettings);

        // 移除搜索过滤功能

        // 工具开关变化
        $('#permissionToolsList').on('change', '.permission-tool-toggle', function () {
            var disallowedTools = getDisallowedTools();
            updatePermissionCount(disallowedTools);
        });

        // 高级模式已移除
    }

    // 初始化
    initEvents();

    window._settingsPermission = {
        load: loadPermissionSettings
    };
})();