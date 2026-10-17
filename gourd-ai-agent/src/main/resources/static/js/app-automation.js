/* app-automation.js — 自动化（定时任务）独立主视图
 *
 * 由 settings 浮层的「定时任务」tab 迁移而来（原 app-settings-loop.js）：
 *  - 列表页 + 表单页两态，容器 #automationInner
 *  - 指令区改为 composer 形态：textarea + 底部工具条（工作空间 / 模型 / 思考深度）
 *
 * 事件绑定原则（避坑）：
 *  1) 全部委托到本视图容器 #automationInner / #automationView 上，不用 document 级委托，
 *     避免与聊天页 app-workspace.js、app-streaming.js、app-history.js 的全局委托互相劫持；
 *  2) 工作空间选择器不复用 .workspace-selector* / .workspace-dropdown / .project-dropdown-item
 *     等 class（它们被 app-workspace.js 的 document 委托接管，点击会改全局工作空间并跳欢迎页），
 *     改用 .auto-ws-* 自有命名，只写页面局部状态；
 *  3) 指令区容器不用 .input-box / .welcome-input-box（被 app-streaming.js 抢焦点到聊天输入框）；
 *  4) 模型选择器沿用 .model-selector 视觉类但 id 唯一（#autoModelSelector），
 *     开合/搜索/分组折叠/思考档位/上下文 chips 全部由公共组件 GourdModelSelector 驱动
 *     （model-selector.js，行为基准为对话页），本页只提供状态存取与静态骨架。
 */
(function () {
    'use strict';

    var CONTAINER = 'automationInner';
    var editId = null;
    var formMode = false; // 新建表单也没有 editId，视图模式需独立维护
    var initialized = false;

    /** 表单态：不进 DOM 的选择值（工作空间 / 模型 / 思考档位 / layui select 值） */
    var formState = {
        workspace: '',      // '' = 不选 = 全局（与聊天页语义一致）
        modelName: '',      // '' = 未显式选模，运行时跟随默认模型
        thinking: 'auto',
        contextLength: '',  // '' = 未显式设置，运行时跟随默认（256K）/绑定会话
        accessMode: '',     // '' = 未设置（跟随会话已存档位）；'default' / 'full'
        channel: '',        // 推送通道（layui select 托管，值存这里避免读隐藏原生 select）
        intervalUnit: 'm',  // 间隔单位（同上）
        projects: [],       // [{name, path}]
        models: [],         // [{name, provider, standard}]
        defaultModel: '',   // 后端解析后的实际生效模型名（/web/chat/models 的 selected）
        projectsLoaded: false,
        modelsLoaded: false
    };

    /** layui form.on 只能绑一次（form 每次重建 DOM，重复绑定会导致回调叠加） */
    var layuiFormBound = false;
    var SELECT_FILTER = 'autoSelectForm';

    function escapeHtml(s) {
        if (window._settingsCore && window._settingsCore.escapeHtml) {
            return window._settingsCore.escapeHtml(s);
        }
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function t(key, params) {
        return (window.GourdI18n && GourdI18n.t) ? GourdI18n.t(key, params) : key;
    }

    function toast(msg, type) {
        if (typeof window.showToast === 'function') {
            window.showToast(msg, type === 'error' ? 'error' : 'success');
        } else if (typeof layer !== 'undefined') {
            layer.msg(msg, { icon: type === 'error' ? 2 : 1, time: 2500 });
        }
    }

    /** 当前会话 ID：定时任务是全局的，sessionId 仅用于后端校验，取不到时回退 SESSION_ID */
    function sid() {
        return window.activeSessionId || window.SESSION_ID || '';
    }

    function api(action, params, cb) {
        // list / get 在后端是 @Get 映射，用 POST 打会 405（方法白名单），必须走 GET
        var isGet = (action === 'list' || action === 'get');
        var sessionId = sid();
        if (!sessionId) {
            if (cb) cb(null);
            return;
        }
        $.ajax({
            url: '/web/chat/loop/' + action,
            method: isGet ? 'GET' : 'POST',
            data: $.extend({ sessionId: sessionId }, params || {}),
            dataType: 'json',
            success: function (r) { if (cb) cb(r); },
            error: function () {
                toast(t('settings.loop.operation_failed'), 'error');
                if (cb) cb(null);
            }
        });
    }

    function $c() { return $('#' + CONTAINER); }


    function formatAgo(isoStr) {
        if (!isoStr) return '';
        try {
            var d = Math.floor((new Date() - new Date(isoStr)) / 1000);
            if (d < 60) return t('settings.loop.seconds_ago', [d]);
            if (d < 3600) return t('settings.loop.minutes_ago', [Math.floor(d / 60)]);
            if (d < 86400) return t('settings.loop.hours_ago', [Math.floor(d / 3600)]);
            return t('settings.loop.days_ago', [Math.floor(d / 86400)]);
        } catch (e) { return isoStr; }
    }

    // ===================== 定时任务模板 =====================
    // cron 采用 Quartz 星期号（1=SUN..7=SAT），与 fillForm 的反解析口径一致：
    //   形式 "0 m H ? * DAYS" 会被识别为 daily 模式并回填时间/星期。

    var TEMPLATES = [
        {
            key: 'standup',
            cron: '0 0 9 ? * 2,3,4,5,6',
            icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>'
        },
        {
            key: 'risk',
            cron: '0 0 10 ? * *',
            icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>'
        },
        {
            key: 'release',
            cron: '0 0 17 ? * 6',
            icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
        },
        {
            key: 'docsync',
            // Quartz 星期号 1=SUN..7=SAT：5=THU（周四）。切勿写 4（=周三），
            // 否则与 locale 里 automation.tpl.docsync.sched（每周四）矛盾且实际在周三执行
            cron: '0 0 15 ? * 5',
            icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>'
        }
    ];

    function templateByKey(key) {
        for (var i = 0; i < TEMPLATES.length; i++) {
            if (TEMPLATES[i].key === key) return TEMPLATES[i];
        }
        return null;
    }

    function templatesHtml() {
        var h = '<div class="automation-tpl-head">' + escapeHtml(t('automation.templates')) + '</div>';
        h += '<div class="automation-tpl-grid">';
        for (var i = 0; i < TEMPLATES.length; i++) {
            var tp = TEMPLATES[i];
            var base = 'automation.tpl.' + tp.key + '.';
            h += '<div class="auto-tpl-card" data-tpl="' + escapeHtml(tp.key) + '">';
            h += '<div class="auto-tpl-title">' + tp.icon + '<span>' + escapeHtml(t(base + 'name')) + '</span></div>';
            h += '<div class="auto-tpl-desc">' + escapeHtml(t(base + 'desc')) + '</div>';
            h += '<div class="auto-tpl-sched">' + escapeHtml(t(base + 'sched')) + '</div>';
            h += '</div>';
        }
        h += '</div>';
        return h;
    }

    // ===================== cron 组装 / 反解析 =====================
    // 注意：界面星期为 1=MON..7=SUN，Quartz 为 1=SUN..7=SAT，双向转换逻辑与旧实现保持完全一致，
    // 否则历史任务的星期显示会错位。

    function buildCron(activeTab) {
        if (activeTab === 'cron') {
            return $('#autoCron').val().trim();
        }
        if (activeTab === 'daily') {
            var time = $('#autoDailyTime').val() || '09:00';
            var parts = time.split(':');
            var h = parseInt(parts[0]) || 0;
            var m = parseInt(parts[1]) || 0;
            var selectedDays = [];
            $('#autoWeekdays .loop-weekday-btn.active').each(function () {
                var d = parseInt($(this).data('day'));
                if (d >= 1 && d <= 7) {
                    var quartzDay = d === 7 ? 1 : (d + 1);
                    selectedDays.push(quartzDay);
                }
            });
            selectedDays.sort(function (a, b) { return a - b; });
            var daysStr = (selectedDays.length === 7 || selectedDays.length === 0) ? '*' : selectedDays.join(',');
            return '0 ' + m + ' ' + h + ' ? * ' + daysStr;
        }
        // interval
        var num = parseInt($('#autoInterval').val()) || 5;
        var mins = formState.intervalUnit === 'h' ? num * 60 : num;
        var days = [];
        $('#autoIntervalWeekdays .loop-weekday-btn.active').each(function () {
            var d = parseInt($(this).data('day'));
            if (d >= 1 && d <= 7) {
                var qd = d === 7 ? 1 : (d + 1);
                days.push(qd);
            }
        });
        days.sort(function (a, b) { return a - b; });
        var dStr = (days.length === 7 || days.length === 0) ? '*' : days.join(',');
        return '0 */' + mins + ' * ? * ' + dStr;
    }

    function switchSchedTab(tab) {
        var $root = $c();
        $root.find('.loop-schedule-tab').removeClass('active');
        $root.find('.loop-schedule-tab[data-sched="' + tab + '"]').addClass('active');
        $('#autoSchedDaily, #autoSchedInterval, #autoSchedCron').hide();
        if (tab === 'daily') $('#autoSchedDaily').show();
        else if (tab === 'interval') $('#autoSchedInterval').show();
        else $('#autoSchedCron').show();
    }

    // ===================== 数据加载：工作空间 / 模型 =====================

    function loadProjects(cb) {
        if (formState.projectsLoaded) { if (cb) cb(); return; }
        $.get('/web/chat/projects', function (resp) {
            formState.projects = (resp && resp.data) ? resp.data : [];
            formState.projectsLoaded = true;
            if (cb) cb();
        }).fail(function () {
            formState.projects = [];
            formState.projectsLoaded = true;
            if (cb) cb();
        });
    }

    function loadModels(cb) {
        if (formState.modelsLoaded) { if (cb) cb(); return; }
        $.get('/web/chat/models', function (resp) {
            var d = (resp && resp.data) ? resp.data : {};
            formState.models = d.list || [];
            // selected 为后端解析后的实际生效模型名，供任务未显式选模时作展示回落（同会话页）
            formState.defaultModel = d.selected || '';
            formState.modelsLoaded = true;
            if (cb) cb();
        }).fail(function () {
            formState.models = [];
            formState.defaultModel = '';
            formState.modelsLoaded = true;
            if (cb) cb();
        });
    }

    function defaultWorkspacePath() {
        return (window.__appMeta && window.__appMeta.workspace) ? window.__appMeta.workspace : '';
    }

    function baseName(p) {
        if (!p) return '';
        var s = String(p).replace(/[\\/]+$/, '');
        var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
        return i >= 0 ? s.substring(i + 1) : s;
    }

    /** 路径归一：去尾部分隔符。与 app-workspace.js trimTrail 同口径 */
    function trimTrail(p) {
        return String(p == null ? '' : p).replace(/[\\/]+$/, '');
    }

    /**
     * 选择值归一：空 / 等于默认工作区的路径 → ''（= 不选 = 全局）。
     * 与聊天页 app-workspace.js:26 toSelection() 保持一致，
     * 否则“默认工作区本体也在项目列表里”时会出现两个等价但取值不同的选项。
     */
    function toSelection(path) {
        var p = trimTrail(String(path == null ? '' : path).trim());
        if (!p) return '';
        var def = trimTrail(defaultWorkspacePath());
        if (def && p.toLowerCase() === def.toLowerCase()) return '';
        return p;
    }

    /** 登记名优先，未登记（或列表未就绪）回退目录名。
     *  重命名只改 projects.json 的展示名、不动磁盘目录，故只靠 baseName(path) 永远读不到新名字，
     *  会出现「侧栏/欢迎页显新名、任务卡标签显旧目录名」的不一致。 */
    function projectNameOf(path) {
        if (!path) return '';
        for (var i = 0; i < formState.projects.length; i++) {
            if (formState.projects[i].path === path) {
                return formState.projects[i].name || baseName(path);
            }
        }
        return baseName(path);
    }

    /** 未选 = 全局：按钮仅提示“选择项目”，不展示默认/全局信息（同聊天页 displayName） */
    function workspaceLabel() {
        if (!formState.workspace) return t('code.select_project');
        return projectNameOf(formState.workspace);
    }

    /** 历史档位值归一（与后端 ThinkingDepth.normalize 同口径）：'off' 是 'auto' 的旧名，不再有 minimal 档 */
    function normThinking(depth) {
        var d = String(depth == null ? '' : depth).toLowerCase();
        if (!d || d === 'off') return 'auto';
        if (d === 'minimal') return 'low';
        return d;
    }

    /* 展示用的生效模型：任务未显式选模（modelName 为空）时回落后端解析的默认模型；
     * 已保存模型被删除/禁用时同样回落——与运行时 getModelOrMain 的兜底保持一致，
     * 避免「界面高亮失效模型、实际执行已回落默认」的不一致。
     * 存储语义不变：保存时仍写原值（空串 = 跟随默认），换全局默认模型后存量任务照样跟随。 */
    function effectiveModel() {
        var m = formState.modelName;
        if (!m) return formState.defaultModel || '';
        if (formState.modelsLoaded && formState.models.length) {
            for (var i = 0; i < formState.models.length; i++) {
                if (formState.models[i].name === m) return m;
            }
            return formState.defaultModel || m;
        }
        return m;
    }

    // ===================== 列表视图 =====================

    /* 先备齐登记项目列表再渲染：任务卡的工作空间标签需要登记名（projectNameOf），
       否则首次打开时列表未就绪，标签会回退成目录名（重命名后与侧栏不一致）。 */
    function showList() {
        formMode = false;
        editId = null;
        if (autoSelector) { autoSelector.destroy(); autoSelector = null; }
        loadProjects(function () {
            if (formMode) return; // 项目加载期间可能已打开表单
            api('list', null, function (res) {
                if (formMode) return; // 迟到的列表响应不得覆盖当前草稿
                var items = (res && res.data) ? res.data : [];
                var html = '<div class="automation-header">';
                html += '<div class="automation-title">' + escapeHtml(t('automation.title')) + '</div>';
                html += '<div class="automation-desc">' + escapeHtml(t('automation.desc')) + '</div>';
                html += '</div>';

                html += '<div class="automation-section">';
                html += '<div class="automation-section-head">';
                html += '<span class="automation-section-title">' + escapeHtml(t('automation.created_tasks')) + '</span>';
                html += '<button class="automation-add-btn" id="autoAddBtn">+ ' + escapeHtml(t('settings.loop.add_task')) + '</button>';
                html += '</div>';

                if (items.length === 0) {
                    html += '<div class="automation-empty">' + escapeHtml(t('settings.loop.empty')) + '</div>';
                } else {
                    html += '<div class="automation-task-list">';
                    for (var i = 0; i < items.length; i++) {
                        html += taskCardHtml(items[i]);
                    }
                    html += '</div>';
                }
                html += '</div>';

                // 模板区（点卡片 = 带预填值进新建表单）
                html += '<div class="automation-tpl-wrap">' + templatesHtml() + '</div>';

                $c().html(html);
            });
        });
    }

    function taskCardHtml(x) {
        var statusText = x.cancelled ? t('settings.loop.status_cancelled')
            : (!x.enabled ? t('settings.loop.status_disabled')
                : (x.running ? t('settings.loop.status_running') : t('settings.loop.status_ready')));
        var statusClass = x.cancelled ? 'cancelled' : (!x.enabled ? 'disabled' : (x.running ? 'running' : 'ready'));
        var scheduleText = x.cron
            ? t('settings.loop.cron_format', [x.cron])
            : t('settings.loop.interval_format', [x.intervalMinutes]);
        var toggleIcon = x.enabled
            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>';

        var h = '<div class="auto-task-item" data-id="' + escapeHtml(x.id) + '">';
        h += '<div class="auto-task-row">';
        h += '<span class="auto-task-dot ' + statusClass + '"></span>';
        h += '<span class="auto-task-name">' + escapeHtml(x.name || ('#' + x.id)) + '</span>';
        h += '<span class="auto-task-schedule">' + escapeHtml(scheduleText) + '</span>';
        h += '<span class="auto-task-status ' + statusClass + '">' + escapeHtml(statusText) + '</span>';
        h += '<div class="auto-task-actions">';
        if (x.runtimeSessionId) {
            // data-sid = 执行对话的会话 ID（跳转必须用它，任务 id 不是会话 id）；data-root = 归属工作空间（拉历史消息的根）
            h += '<button class="auto-task-btn auto-act" data-action="session" data-id="' + escapeHtml(x.id)
                + '" data-sid="' + escapeHtml(x.runtimeSessionId) + '" data-root="' + escapeHtml(toSelection(x.workspace)) + '" title="'
                + escapeHtml(t('settings.loop.view_session')) + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button>';
        }
        if (!x.cancelled) {
            h += '<button class="auto-task-btn auto-act" data-action="toggle" data-id="' + escapeHtml(x.id) + '" title="'
                + escapeHtml(x.enabled ? t('settings.loop.disable') : t('settings.loop.enable')) + '">' + toggleIcon + '</button>';
            h += '<button class="auto-task-btn auto-act" data-action="trigger" data-id="' + escapeHtml(x.id) + '" title="'
                + escapeHtml(t('settings.loop.trigger')) + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>';
            h += '<button class="auto-task-btn auto-act" data-action="edit" data-id="' + escapeHtml(x.id) + '" title="'
                + escapeHtml(t('settings.loop.edit')) + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>';
        }
        h += '<button class="auto-task-btn auto-act danger" data-action="remove" data-id="' + escapeHtml(x.id) + '" title="'
            + escapeHtml(t('settings.loop.delete')) + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>';
        h += '</div></div>';

        h += '<div class="auto-task-prompt">' + escapeHtml(x.prompt) + '</div>';

        var tags = [];
        if (x.workspace) tags.push('<span class="auto-task-tag">' + escapeHtml(projectNameOf(x.workspace)) + '</span>');
        if (x.modelName) tags.push('<span class="auto-task-tag">' + escapeHtml(x.modelName) + '</span>');
        if (x.thinkingDepth && normThinking(x.thinkingDepth) !== 'auto') tags.push('<span class="auto-task-tag">' + escapeHtml(x.thinkingDepth) + '</span>');
        if (x.contextLength) tags.push('<span class="auto-task-tag">' + escapeHtml(GourdModelSelector.contextLengthLabel(x.contextLength)) + '</span>');
        // 附件数：无专用 i18n key（不新增），直接用回形针 + 数字，与列表其它 tag 同款轻量形态
        if (x.attachmentPaths && x.attachmentPaths.length > 0) {
            tags.push('<span class="auto-task-tag">\ud83d\udcce' + x.attachmentPaths.length + '</span>');
        }
        if (x.accessMode) tags.push('<span class="auto-task-tag">' + escapeHtml(t(x.accessMode === 'full' ? 'settings.loop.access_full' : 'settings.loop.access_default')) + '</span>');
        if (x.goalCondition) tags.push('<span class="auto-task-tag">goal</span>');
        if (x.worktreeEnabled) tags.push('<span class="auto-task-tag">wt</span>');
        if (x.channelNotify) tags.push('<span class="auto-task-tag accent">' + escapeHtml(x.channelNotify) + '</span>');

        var info = '';
        if (x.lastExecutedAt) info += '<span class="auto-task-meta">' + escapeHtml(t('settings.loop.last_exec', [formatAgo(x.lastExecutedAt)])) + '</span>';
        if (x.currentIteration > 0) info += '<span class="auto-task-meta">' + escapeHtml(t('settings.loop.iteration', [x.currentIteration])) + '</span>';
        var tagsHtml = tags.length ? '<span class="auto-task-tags">' + tags.join('') + '</span>' : '';
        if (info || tagsHtml) h += '<div class="auto-task-info">' + info + tagsHtml + '</div>';

        if (x.lastResult) {
            var rs = x.lastResult.length > 80 ? x.lastResult.substring(0, 80) + '...' : x.lastResult;
            var rc = x.lastResult.indexOf('[GOAL_ACHIEVED]') >= 0 ? 'achieved' : (x.lastResult.indexOf('error') >= 0 ? 'error' : '');
            h += '<div class="auto-task-result ' + rc + '">' + escapeHtml(rs) + '</div>';
        }
        h += '</div>';
        return h;
    }

    // ===================== 表单视图 =====================

    /** @param tplKey 可选：模板 key，仅新建（editId 为空）时生效 */
    function showForm(tplKey) {
        formMode = true;
        // 仅新建时重置：编辑态下真实值要等 api('get') 异步回来，
        // 若先清空会让首屏闪现“不推送 / 分钟”等错值
        if (!editId) {
            formState.workspace = '';
            formState.modelName = '';
            formState.thinking = 'auto';
            formState.contextLength = '';
            formState.accessMode = '';
            formState.channel = '';
            formState.intervalUnit = 'm';
        }
        // 附件一律先清空（不分新建/编辑）：它是本页局部态，不进 formState。
        // 编辑态看似应「等 api('get') 回来再填」，但残留的是【上一个任务】的 chips，
        // 闪一下错附件比闪一下空附件条糟糕得多；空行本身就是正确的加载态，
        // 真值由 fillForm → restoreAutoAttachments(x) 按服务端响应重建。
        // 版本号递增：让上一份附件的 FileReader 回调作废，不得写进新表单。
        autoAttachVersion++;
        autoAttachments.length = 0;

        var days = [];
        for (var i = 1; i <= 7; i++) days.push(t('settings.loop.weekday_' + i));
        var wHtml = '';
        for (var d = 0; d < 7; d++) {
            wHtml += '<button type="button" class="loop-weekday-btn active" data-day="' + (d + 1) + '">' + escapeHtml(days[d]) + '</button>';
        }

        var html = '<div class="automation-header">';
        html += '<div class="automation-title">' + escapeHtml(t('automation.title')) + '</div>';
        html += '<button class="automation-back-btn" id="autoBackBtn">';
        html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>';
        html += '<span>' + escapeHtml(editId ? t('settings.loop.edit_task') : t('settings.loop.new_task')) + '</span>';
        html += '</button></div>';

        html += '<div class="automation-section">';

        // 任务标题 + 推送通道
        html += '<div class="auto-form-row">';
        html += '<div class="auto-form-group"><label>' + escapeHtml(t('settings.loop.task_name')) + ' <span class="auto-required">*</span></label>';
        html += '<input type="text" id="autoName" class="auto-input" placeholder="' + escapeHtml(t('settings.loop.task_name_placeholder')) + '"/></div>';
        html += '<div class="auto-form-group"><label>' + escapeHtml(t('settings.loop.push_channel')) + '</label>';
        // layui select 统一范式：.layui-form 包层 + lay-filter + form.render('select')
        // （原生 <option> 展开面板由系统绘制，暗色下会出现蓝色高亮，与全站不统一）
        html += '<div class="layui-form auto-select-wrap" lay-filter="' + SELECT_FILTER + '">';
        html += '<select id="autoChannel" lay-filter="autoChannel">';
        html += '<option value="">' + escapeHtml(t('settings.loop.no_push')) + '</option>';
        html += '<option value="wechat">' + escapeHtml(t('settings.loop.wechat')) + '</option>';
        html += '<option value="feishu">' + escapeHtml(t('settings.loop.feishu')) + '</option>';
        html += '<option value="dingtalk">' + escapeHtml(t('settings.loop.dingtalk')) + '</option>';
        html += '</select></div></div>';
        html += '</div>';

        // 调度
        html += '<div class="auto-form-group"><label>' + escapeHtml(t('settings.loop.exec_time')) + ' <span class="auto-required">*</span></label>';
        html += '<div class="loop-schedule-tabs">';
        html += '<button type="button" class="loop-schedule-tab active" data-sched="daily">' + escapeHtml(t('settings.loop.daily')) + '</button>';
        html += '<button type="button" class="loop-schedule-tab" data-sched="interval">' + escapeHtml(t('settings.loop.interval')) + '</button>';
        html += '<button type="button" class="loop-schedule-tab" data-sched="cron">' + escapeHtml(t('settings.loop.loop_cron')) + '</button>';
        html += '</div>';

        html += '<div id="autoSchedDaily" class="auto-sched-pane">';
        html += '<input type="text" id="autoDailyTime" class="auto-input auto-input-sm" value="09:00" placeholder="' + escapeHtml(t('settings.loop.daily_time_placeholder')) + '"/>';
        html += '<div class="loop-weekdays" id="autoWeekdays">' + wHtml + '</div>';
        html += '</div>';

        html += '<div id="autoSchedInterval" class="auto-sched-pane" style="display:none">';
        html += '<div class="auto-interval-row">';
        html += '<span>' + escapeHtml(t('settings.loop.every')) + '</span>';
        html += '<input type="number" id="autoInterval" class="auto-input auto-input-xs" value="5" min="1" max="1440"/>';
        html += '<div class="layui-form auto-select-wrap auto-select-wrap-xs" lay-filter="' + SELECT_FILTER + 'Unit">';
        html += '<select id="autoIntervalUnit" lay-filter="autoIntervalUnit">';
        html += '<option value="m">' + escapeHtml(t('settings.loop.minute')) + '</option>';
        html += '<option value="h">' + escapeHtml(t('settings.loop.hour')) + '</option>';
        html += '</select></div>';
        html += '</div>';
        html += '<div class="loop-weekdays" id="autoIntervalWeekdays">' + wHtml + '</div>';
        html += '</div>';

        html += '<div id="autoSchedCron" class="auto-sched-pane" style="display:none">';
        html += '<input type="text" id="autoCron" class="auto-input" placeholder="0 */5 * * * ?"/>';
        html += '</div>';
        html += '</div>';

        // ===== 指令区（完全对齐首页 composer：附件条 + 命令补全 + 工具条 + 托盘） =====
        // 注意：外层容器绝不用 .input-box / .welcome-input-box —— app-streaming.js 在这两个
        // class 上绑了「点击容器即聚焦聊天输入框」，套上会把焦点抢走（见文件头注释第 3 条）。
        // 视觉靠 css/automation.css 的 .auto-composer 抄 .input-box 的边框/圆角/底色实现。
        html += '<div class="auto-form-group"><label>' + escapeHtml(t('automation.instruction')) + ' <span class="auto-required">*</span></label>';
        html += '<div class="auto-composer" id="autoComposer">';
        // 已选附件（结构与首页 .attachments-wrap 同构，chip 类名直接复用全局样式）
        html += '<div class="attachments-wrap" id="autoAttachmentsWrap"></div>';
        html += '<div style="position:relative">';
        // 命令补全面板（/ 命令、@ 子代理、$ 技能）：由 app-history.js 导出的 GourdCmdComplete 驱动
        html += '<div class="cmd-complete" id="autoCmdComplete"></div>';
        // 不写 rows：rows=4 算出的初始高度（≈104px）大于 CSS min-height(92px)，
        // 用户删空文本后 autoGrowPrompt 会钳到 92px 造成不可逆的高度塌陷。高度全交 CSS + JS
        html += '<textarea id="autoPrompt" class="auto-composer-textarea" placeholder="'
            + escapeHtml(t('settings.loop.task_prompt_placeholder')) + '"></textarea>';
        html += '</div>';
        html += '<div class="input-toolbar auto-composer-toolbar">';
        html += '<div class="toolbar-left">';
        // + 聚合菜单（与首页同构；开关由本页自绑——app-ui.js 的绑定是初始化时的 DOM 快照）
        html += '<div class="plus-menu-wrap" id="autoPlusWrap">';
        html += '<button type="button" class="plus-btn" id="autoPlusBtn" title="' + escapeHtml(t('app.plus_more')) + '">';
        html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
        html += '</button>';
        html += '<div class="plus-menu">';
        html += '<button type="button" class="plus-menu-item" id="autoAttachBtn">';
        html += '<svg viewBox="0 0 24 24"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
        html += '<span>' + escapeHtml(t('app.attach_file')) + '</span></button>';
        html += '<button type="button" class="plus-menu-item" id="autoImageBtn">';
        html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
        html += '<span>' + escapeHtml(t('app.attach_image')) + '</span></button>';
        html += '<div class="plus-menu-sep"></div>';
        html += '<button type="button" class="plus-menu-item" id="autoCmdBtn">';
        html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20L16 4"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/></svg>';
        html += '<span>' + escapeHtml(t('app.cmd_commands')) + '</span></button>';
        html += '<button type="button" class="plus-menu-item" id="autoSkillBtn">';
        html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><text x="4" y="18" font-size="18" font-weight="bold" font-family="monospace" fill="currentColor" stroke="none">$</text></svg>';
        html += '<span>' + escapeHtml(t('app.skills')) + '</span></button>';
        html += '<button type="button" class="plus-menu-item" id="autoAgentBtn">';
        html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><line x1="19" y1="2" x2="19" y2="6"/><line x1="17" y1="4" x2="21" y2="4"/></svg>';
        html += '<span>' + escapeHtml(t('app.subagent')) + '</span></button>';
        html += '<div class="plus-menu-sep"></div>';
        // 历史消息：任务指令无会话上下文可取，与欢迎页同款置灰
        html += '<button type="button" class="plus-menu-item" id="autoHistoryBtn" disabled>';
        html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
        html += '<span>' + escapeHtml(t('app.history_msg')) + '</span></button>';
        html += '</div></div>';
        // 工作空间（自有 class，避免被 app-workspace.js 全局委托接管）
        // 结构与聊天页对齐：文件夹图标 + 清除按钮（hover 互换）+ 名称 + 箭头
        html += '<div class="auto-ws-selector" id="autoWsSelector">';
        html += '<div class="auto-ws-current" id="autoWsCurrent" title="' + escapeHtml(t('app.chat_workspace.switch')) + '">';
        html += '<svg class="auto-ws-folder-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
        html += '<button type="button" class="auto-ws-clear" id="autoWsClear" title="' + escapeHtml(t('app.chat_workspace.clear')) + '">';
        html += '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        html += '</button>';
        html += '<span class="auto-ws-name" id="autoWsName"></span>';
        html += '<svg class="auto-ws-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
        html += '</div>';
        html += '<div class="auto-ws-dropdown" id="autoWsDropdown"></div>';
        html += '</div>';
        html += '<input type="file" class="attach-input" id="autoAttachInput" multiple accept="*/*"/>';
        html += '<input type="file" class="attach-input" id="autoImageInput" multiple accept="image/*"/>';
        html += '</div>';   // toolbar-left
        html += '<div class="toolbar-right">';
        // 模型 + 思考（沿用 .model-selector 视觉类，id 唯一）
        html += '<div class="model-selector auto-model-selector" id="autoModelSelector">';
        html += '<div class="model-selector-current" id="autoModelCurrent">';
        html += '<span class="model-name" id="autoModelName"></span>';
        html += '<span class="model-thinking-tag" id="autoModelThinkingTag" style="display:none"></span>';
        html += '<span class="model-context-tag" id="autoModelContextTag" style="display:none"></span>';
        html += '<svg class="model-arrow" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
        html += '</div>';
        // 骨架重建（进表单页）：搜索框与关键词状态由公共组件在每次打开时重置
        html += '<div class="model-dropdown has-search" id="autoModelDropdown">';
        html += GourdModelDropdown.searchHtml(t('history.model_search_placeholder'));
        html += '<div class="model-dropdown-list" id="autoModelList"></div>';
        html += '</div>';
        html += '</div>';
        html += '</div>';   // toolbar-right
        html += '</div>';   // input-toolbar
        // 托盘条：权限档位从「高级设置」移到这里，与首页 composer-tray 同构（第三档「跟随会话」保留）
        html += '<div class="composer-tray auto-composer-tray">';
        html += '<div class="access-selector auto-access-selector" id="autoAccessSelector">';
        html += '<div class="access-selector-current" id="autoAccessCurrent" title="' + escapeHtml(t('app.access_title')) + '">';
        html += '<svg class="access-icon access-icon-shield" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
        html += '<svg class="access-icon access-icon-alert" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
        html += '<span class="access-label" id="autoAccessLabel"></span>';
        html += '<svg class="model-arrow" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
        html += '</div>';
        html += '<div class="access-dropdown" id="autoAccessDropdown"></div>';
        html += '</div></div>';
        html += '</div></div>';   // composer / form-group

        // 高级
        html += '<div class="auto-advanced-toggle collapsed" id="autoAdvancedToggle">';
        html += '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 6 8 10 12 6"/></svg>';
        html += '<span>' + escapeHtml(t('settings.loop.advanced')) + '</span></div>';
        html += '<div class="auto-advanced" id="autoAdvanced" style="display:none">';
        html += '<div class="auto-form-row">';
        html += '<div class="auto-form-group"><label>' + escapeHtml(t('settings.loop.max_iter')) + '</label>';
        html += '<input type="number" id="autoMaxIter" class="auto-input" value="" min="1" placeholder="' + escapeHtml(t('settings.loop.max_iter_unlimited')) + '"/></div>';
        html += '<div class="auto-form-group auto-form-group-check">';
        html += '<label><input type="checkbox" id="autoWorktree"/> ' + escapeHtml(t('settings.loop.worktree_isolation')) + '</label></div>';
        html += '</div>';
        // 权限档位已迁至指令区下方的 composer-tray（与首页托盘同构），高级区不再重复渲染
        html += '</div>';

        html += '<div class="auto-form-actions">';
        html += '<button class="auto-btn-secondary" id="autoTriggerBtn" style="display:' + (editId ? 'inline-flex' : 'none') + '">'
            + escapeHtml(t('settings.loop.test_run')) + '</button>';
        html += '<button class="auto-btn-primary" id="autoSaveBtn">' + escapeHtml(t('settings.loop.save')) + '</button>';
        html += '</div>';
        html += '</div>';

        $c().html(html);

        // 时间选择器（laydate 只对存在的元素渲染；DOM 每次重建，无残留实例问题）
        if (typeof layui !== 'undefined' && layui.laydate) {
            layui.laydate.render({ elem: '#autoDailyTime', type: 'time', format: 'HH:mm', theme: (getComputedStyle(document.body).getPropertyValue('--accent') || '#18181b').trim() });
        }

        renderSelects();
        renderWorkspaceUI();
        setupAutoSelector();
        bindAccessEvents();
        renderAccessUI();
        renderAutoAttachments();
        bindComposerEvents();
        loadProjects(function () { renderWorkspaceUI(); });
        loadModels(function () { refreshAutoSelector(); });

        // 模板预填（仅新建；editId 存在时由 fillForm 接管，不得被模板覆盖）
        if (!editId && tplKey) applyTemplate(tplKey);

        if (editId) {
            var $saveBtn = $('#autoSaveBtn');
            $saveBtn.prop('disabled', true).text(t('settings.loop.loading'));
            api('get', { taskId: editId }, function (r) {
                if (r && r.code === 200 && r.data) {
                    fillForm(r.data);
                    $saveBtn.prop('disabled', false).text(t('settings.loop.save'));
                } else {
                    // 任务已被删除 / 请求失败：退回列表，避免用户在空白表单上误建或误更新
                    toast((r && r.description) || t('settings.loop.operation_failed'), 'error');
                    showList();
                }
            });
        }
    }

    // ===================== 工具条渲染 =====================

    /**
     * 指令框自适应高度（resize:none 后的替代方案）。
     * 先置 auto 才能拿到真实 scrollHeight（否则只会单向变高、删文本不回缩）；
     * 上限与 CSS max-height 保持一致（320px），超出后交给内部滚动。
     */
    function autoGrowPrompt() {
        var el = document.getElementById('autoPrompt');
        if (!el) return;
        el.style.height = 'auto';
        var h = Math.min(el.scrollHeight, 320);
        el.style.height = h + 'px';
        el.style.overflowY = el.scrollHeight > 320 ? 'auto' : 'hidden';
    }

    // ===================== 指令区附件（与首页 composer 同构） =====================

    /* 本页局部附件数组（不复用首页的 pendingFiles：那是会话草稿态，
       被 app-base/app-ui/app-streaming 的发送链路共享，混用会把任务附件误发到当前会话）。
       元素形态：
         新选：{ name, size, type:'image'|'file', file:File, dataUrl?:string }
         回填（已保存的旧附件，无本地字节）：{ name, size, type, keptPath:string }
       keptPath 存在 = 旧附件，保存时走 attachmentKeepPaths 而非重新上传。 */
    var autoAttachments = [];
    var AUTO_MAX_ATTACHMENTS = 8;
    // 图片 FileReader 回调的版本号：清空/重建表单后递增，让过期回调作废
    var autoAttachVersion = 0;

    function autoAttachIconSvg() {
        // fileIconSvg 是 app-base.js 的全局（线性图标，📎 emoji 在深色主题下渲染为黑框）；
        // typeof 守卫：契约测试的 vm 沙箱不注入该全局
        if (typeof fileIconSvg === 'function') return fileIconSvg(18);
        return '';
    }

    function autoAttachSize(bytes) {
        if (!bytes) return '';
        if (typeof formatFileSize === 'function') return formatFileSize(bytes);
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }

    /** 渲染附件 chips（类名与 DOM 结构与首页 renderAttachmentsWrap 一致，样式直接复用全局规则）。
     *  用 html() 整体重建而非逐个 append：表单 DOM 每次重建，残留节点无处可去；
     *  且删除按钮走视图级委托（data-idx），不需要逐元素绑事件。 */
    function renderAutoAttachments() {
        var $wrap = $('#autoAttachmentsWrap');
        if (!$wrap.length) return;
        if (autoAttachments.length === 0) {
            $wrap.removeClass('has-items').html('');
            return;
        }
        var html = '';
        for (var i = 0; i < autoAttachments.length; i++) {
            var item = autoAttachments[i];
            var label = escapeHtml(item.name);
            var sizeStr = autoAttachSize(item.size);
            var title = escapeHtml(sizeStr ? (item.name + ' · ' + sizeStr) : item.name);
            html += '<div class="attachment-item">';
            if (item.type === 'image' && item.dataUrl) {
                html += '<img src="' + item.dataUrl + '" title="' + title + '"/>';
            } else {
                // 非图片（以及尚未存缩略图的旧图片附件）一律走方形文件瓦片
                html += '<div class="attachment-item-file" title="' + title + '">'
                    + '<span class="file-icon">' + autoAttachIconSvg() + '</span>'
                    + '<span class="file-name">' + label + '</span>'
                    + '</div>';
            }
            html += '<button type="button" class="attachment-item-remove" data-idx="' + i + '">&times;</button>';
            html += '</div>';
        }
        $wrap.addClass('has-items').html(html);
    }

    /** 受理一批文件（kind = 'image' | 'file'）。
     *  名额用本地计数器累加，不能只看 autoAttachments.length：图片分支的 push 在
     *  FileReader.onload 里，循环同步执行期间 length 纹丝不动（与首页 processSelectedFiles 同一类缺陷）。 */
    function acceptAutoAttachments(fileList, kind) {
        if (!fileList || !fileList.length) return;
        var room = AUTO_MAX_ATTACHMENTS - autoAttachments.length;
        if (room <= 0) {
            toast(t('ui.attachment_limit', [AUTO_MAX_ATTACHMENTS]), 'error');
            return;
        }
        var taken = 0;
        var version = autoAttachVersion;
        for (var i = 0; i < fileList.length; i++) {
            if (taken >= room) {
                toast(t('ui.attachment_partial_limit', [AUTO_MAX_ATTACHMENTS]), 'error');
                break;
            }
            var file = fileList[i];
            if (!file) continue;
            taken++;
            // 类型以受理入口为准（与首页一致：「附加文件」选中的图片仍作 file 上传，但展示缩略图）
            var isImageKind = (kind === 'image');
            var hasImageBytes = String(file.type || '').indexOf('image/') === 0;
            if (isImageKind || hasImageBytes) {
                var entry = { name: file.name, size: file.size, type: 'image', file: file, dataUrl: '' };
                autoAttachments.push(entry);
                if (typeof FileReader === 'function') {
                    (function (ent) {
                        var reader = new FileReader();
                        reader.onload = function (evt) {
                            if (autoAttachVersion !== version) return; // 过期回调，丢弃
                            ent.dataUrl = evt.target.result;
                            renderAutoAttachments();
                        };
                        reader.readAsDataURL(ent.file);
                    })(entry);
                }
            } else {
                autoAttachments.push({ name: file.name, size: file.size, type: 'file', file: file });
            }
        }
        renderAutoAttachments();
    }

    function removeAutoAttachment(idx) {
        if (isNaN(idx) || idx < 0 || idx >= autoAttachments.length) return;
        autoAttachments.splice(idx, 1);
        renderAutoAttachments();
    }

    /** 清空附件（进新建表单 / 保存成功后调用） */
    function clearAutoAttachments() {
        autoAttachVersion++;
        autoAttachments.length = 0;
        renderAutoAttachments();
    }

    /** 编辑回填：后端只给路径/类型/大小，没有本地字节，因此渲染为无缩略图的文件瓦片 */
    function restoreAutoAttachments(x) {
        autoAttachVersion++;
        autoAttachments.length = 0;
        var paths = x.attachmentPaths || [];
        var types = x.attachmentTypes || [];
        var sizes = x.attachmentSizes || [];
        for (var i = 0; i < paths.length; i++) {
            var p = paths[i];
            if (!p) continue;
            autoAttachments.push({
                name: baseName(p),
                size: (typeof sizes[i] === 'number') ? sizes[i] : 0,
                // 旧图片附件也按 file 渲染（无 dataUrl 可预览），但类型仍如实上报，
                // 保存时 attachmentKeepPaths 不携带类型，故类型仅供展示/提交新附件使用
                type: (types[i] === 'image') ? 'image' : 'file',
                keptPath: p
            });
        }
        renderAutoAttachments();
    }

    /** layui select 渲染 + 回写 formState。
     * layui 会隐藏原生 <select>（.layui-form select{display:none}）并另建面板，
     * 故值以 formState 为准；事件回调只能绑一次（DOM 每次重建，重复 bind 会叠加）。
     */
    function renderSelects() {
        if (typeof layui === 'undefined' || !layui.form) return;
        $('#autoChannel').val(formState.channel || '');
        $('#autoIntervalUnit').val(formState.intervalUnit || 'm');
        layui.form.render('select');
        if (!layuiFormBound) {
            layuiFormBound = true;
            layui.form.on('select(autoChannel)', function (data) {
                formState.channel = data.value || '';
            });
            layui.form.on('select(autoIntervalUnit)', function (data) {
                formState.intervalUnit = data.value || 'm';
            });
        }
    }

    function renderWorkspaceUI() {
        var $sel = $('#autoWsSelector');
        if (!$sel.length) return;
        // 未选时 title 置空（不展示默认工作区路径），与聊天页 renderSelectors 一致
        $('#autoWsName').text(workspaceLabel());
        // 已选时才开启 hover 清除按钮（CSS 门控）
        $sel.toggleClass('ws-has-selection', !!formState.workspace);

        // 全局（默认工作区）不是可选项：不选即全局，列表不再展示该项
        var defKey = trimTrail(defaultWorkspacePath()).toLowerCase();
        var html = '';
        for (var i = 0; i < formState.projects.length; i++) {
            var p = formState.projects[i];
            if (!p || !p.path) continue;
            if (defKey && trimTrail(p.path).toLowerCase() === defKey) continue;
            html += '<div class="auto-ws-item' + (p.path === formState.workspace ? ' active' : '') + '" data-path="' + escapeHtml(p.path) + '">';
            html += '<div class="auto-ws-item-name">' + escapeHtml(p.name || baseName(p.path)) + '</div>';
            html += '<div class="auto-ws-item-path">' + escapeHtml(p.path) + '</div>';
            html += '</div>';
        }
        // 项目全被过滤（仅有默认工作区）或尚未加载时，避免弹出空白面板
        if (!html) {
            html = '<div class="auto-ws-empty">' + escapeHtml(t('code.no_projects')) + '</div>';
        }
        $('#autoWsDropdown').html(html);
    }

    /** 模板预填：写入名称/指令，并把 cron 交给 fillForm 同一套反解析，避免两套调度回填逻辑 */
    function applyTemplate(key) {
        var tp = templateByKey(key);
        if (!tp) return;
        var base = 'automation.tpl.' + tp.key + '.';
        $('#autoName').val(t(base + 'name'));
        $('#autoPrompt').val(t(base + 'prompt'));
        autoGrowPrompt();
        applySchedule({ cron: tp.cron });
    }

    // ===================== 模型选择器（公共组件驱动） =====================

    var autoSelector = null;

    /** 创建/重建选择器实例（表单骨架重建后调用）。先销毁旧实例：document 级收起监听必须显式解绑，
     * 否则每次进表单都会泄漏一份；同时避免旧实例指向已脱离文档的旧骨架。 */
    function setupAutoSelector() {
        if (autoSelector) { autoSelector.destroy(); autoSelector = null; }
        if (!$('#autoModelSelector').length) return;
        autoSelector = GourdModelSelector.create({
            root: '#autoModelSelector',
            models: function () { return formState.models; },
            currentModel: effectiveModel,
            onSelect: applyModelSelection,
            // 开模型下拉时收起本页其余浮层（浮层互斥；组件已在按钮点击上 stopPropagation，
            // 页面级委托收不到该事件，只能靠这个回调）
            onOpen: function () { closeAutoPanels('model'); },
            thinking: {
                value: function () { return formState.thinking; },
                onChange: function (v) { formState.thinking = v; }
            },
            context: {
                value: function () { return formState.contextLength; },
                onChange: function (v) { formState.contextLength = v; }
            }
        });
        autoSelector.update();
    }

    function refreshAutoSelector() {
        if (autoSelector) autoSelector.update();
    }

    // ===================== 权限档位选择器（与前台 access-selector 同构） =====================

    /** 任务级权限档位渲染：'' = 跟随会话；default / full 见后端 AccessMode。
     *  下拉每次全量重建；选 full 需风险确认（与聊天页 openFullConfirm 同范式，此处简化为 layConfirm）。
     *  optionHtml 结构抄 app-access-mode.js（含 access-option-check svg）；
     *  「跟随会话」无 desc 行时不渲染 desc span（避免空行）。 */
    function accessOptionHtml(mode) {
        var nameKey = mode === 'full' ? 'settings.loop.access_full'
            : (mode === 'default' ? 'settings.loop.access_default' : 'settings.loop.access_mode_default');
        // desc 仅 default/full 两档有（复用 app.access_default_desc / app.access_full_desc）；跟随会话无 desc
        var descKey = mode === 'full' ? 'app.access_full_desc'
            : (mode === 'default' ? 'app.access_default_desc' : '');
        var active = formState.accessMode === mode;
        var h = '<button type="button" class="access-option' + (active ? ' active' : '')
            + (mode === 'full' ? ' is-full' : '') + '" data-mode="' + mode + '"'
            + (active ? ' aria-current="true"' : '') + '>'
            + '<div class="access-option-body">'
            + '<span class="access-option-name">' + escapeHtml(t(nameKey)) + '</span>';
        if (descKey) {
            h += '<span class="access-option-desc">' + escapeHtml(t(descKey)) + '</span>';
        }
        h += '</div>'
            + '<svg class="access-option-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>'
            + '</button>';
        return h;
    }

    function renderAccessUI() {
        var $sel = $('#autoAccessSelector');
        if (!$sel.length) return;
        var isFull = formState.accessMode === 'full';
        var hasChoice = !!formState.accessMode;
        var labelKey = !hasChoice ? 'settings.loop.access_mode_default'
            : (isFull ? 'settings.loop.access_full' : 'settings.loop.access_default');
        $sel.toggleClass('is-full', isFull);
        $('#autoAccessLabel').attr('data-i18n', labelKey).text(t(labelKey));
        $('#autoAccessDropdown').html(
            accessOptionHtml('') + accessOptionHtml('default') + accessOptionHtml('full'));
    }

    /** 收起本页所有浮层（+菜单 / 工作空间 / 模型 / 权限 / 命令补全），except 除外。
     *  浮层互斥统一走这里：权限下拉在托盘条、+菜单在工作条，彼此不能同时展开。 */
    function closeAutoPanels(except) {
        if (except !== 'plus') $('#autoPlusWrap').removeClass('open');
        if (except !== 'ws') $('#autoWsSelector').removeClass('open');
        if (except !== 'model') $('#autoModelSelector').removeClass('open');
        if (except !== 'access') $('#autoAccessSelector').removeClass('open');
        if (except !== 'cmd') {
            // 传真实面板元素：hide(null) 会退化成全局 hideCmdComplete()，误伤聊天页面板
            var completeEl = document.getElementById('autoCmdComplete');
            if (completeEl && window.GourdCmdComplete) window.GourdCmdComplete.hide(completeEl);
        }
    }

    /** 绑定权限选择器事件（委托到 #automationView，表单骨架重建后依然有效；只绑一次）。
     *
     *  为何不能委托到 document（重要，勿改回）：app-access-mode.js 在 document 上以
     *  bubble 委托接管了 `.access-option`（会话级权限），且它在 app-bootstrap.js 里
     *  先于本文件加载 —— 同一元素上的 handler 按绑定顺序执行，本页的 stopPropagation()
     *  根本挡不住它：点任务档位会被误当成切会话权限（甚至弹会话级完全访问确认框）。
     *  委托到 #automationView（document 的后代）后，本页 handler 在 bubble 上行到该节点
     *  时先执行，再 stopPropagation() 就能真正断流。这也是文件头设计原则第 1 条。 */
    var accessEventsBound = false;
    function bindAccessEvents() {
        if (accessEventsBound) return;
        accessEventsBound = true;
        var $view = $('#automationView');
        $view.on('click', '#autoAccessCurrent', function (e) {
            e.stopPropagation();
            var opening = !$('#autoAccessSelector').hasClass('open');
            closeAutoPanels(opening ? 'access' : null);
            if (opening) renderAccessUI();
            $('#autoAccessSelector').toggleClass('open', opening);
        });
        $view.on('click', '#autoAccessDropdown .access-option', function (e) {
            e.stopPropagation();
            var mode = $(this).attr('data-mode') || '';
            $('#autoAccessSelector').removeClass('open');
            if (mode === formState.accessMode) return; // 选当前档：只收起，不弹确认
            if (mode === 'full' && typeof window.layConfirm === 'function') {
                // 与聊天页同款风险确认：完全访问需用户显式确认
                window.layConfirm(t('app.access_confirm_title') + '\n' + t('app.access_ack'), function () {
                    formState.accessMode = 'full';
                    renderAccessUI();
                }, function () { /* 取消：保持原选择 */ });
                return;
            }
            formState.accessMode = mode;
            renderAccessUI();
        });
        // 点击外部 / Esc 收起（与其它浮层同款；document 级只读不写全局状态，不会与首页互扰）
        $(document).on('mousedown', function (e) {
            if (!$(e.target).closest('#autoAccessSelector')[0]) $('#autoAccessSelector').removeClass('open');
        });
        $(document).on('keydown', function (e) {
            if (e.key === 'Escape') $('#autoAccessSelector').removeClass('open');
        });
    }

    // 切模型：思考档位集可能变化，当前档位不在新集合内则回落「默认」（auto）
    function applyModelSelection(name) {
        formState.modelName = name;
        var opts = GourdModelSelector.thinkingOptionsFor(formState.models, name);
        var ok = false;
        for (var i = 0; i < opts.length; i++) { if (opts[i].value === formState.thinking) { ok = true; break; } }
        if (!ok) formState.thinking = 'auto';
    }

    // ===================== 编辑回填 =====================

    function fillForm(x) {
        $('#autoName').val(x.name || '');
        $('#autoPrompt').val(x.prompt || '');
        autoGrowPrompt();
        if (x.worktreeEnabled) $('#autoWorktree').prop('checked', true);
        if (x.maxIterations > 0) $('#autoMaxIter').val(x.maxIterations);

        // 工作空间归一：旧任务可能存了“默认工作区绝对路径”，归一为 '' 以匹配新语义
        formState.workspace = toSelection(x.workspace);
        formState.modelName = x.modelName || '';
        // 旧任务 thinkingDepth 为 null 或历史值 "off" 时一律展示为「默认」（auto = 不传参、跟随模型默认）
        formState.thinking = normThinking(x.thinkingDepth);
        // 任务级上下文窗口：缺省（null）表示跟随默认，表单存 '' 保持「未显式设置」语义
        formState.contextLength = x.contextLength || '';
        // 权限档位：缺省（null）表示跟随会话已存档位，表单存 '' 保持同语义
        formState.accessMode = x.accessMode || '';
        formState.channel = x.channelNotify || '';
        renderSelects();
        renderWorkspaceUI();
        renderAccessUI();
        // 旧附件回填（无本地字节：chip 显示图标 + 名称 + 大小，删除 = 从保留清单移除）
        restoreAutoAttachments(x);
        refreshAutoSelector();

        applySchedule(x);

        if (x.worktreeEnabled || x.maxIterations > 0 || x.accessMode) {
            $('#autoAdvanced').show();
            $('#autoAdvancedToggle').removeClass('collapsed');
        }
    }

    /** 调度回填（编辑与模板共用）：{intervalMinutes, cron} */
    function applySchedule(x) {
        if (x.intervalMinutes && !x.cron) {
            switchSchedTab('interval');
            applyIntervalMinutes(x.intervalMinutes);
            return;
        }
        if (!x.cron) return;
        var parts = x.cron.split(' ');
        // interval 格式: "0 */M * ? * DAYS"（新）或 "0 */M * * DAYS ?"（旧）
        var isIntervalLike = parts.length === 6 && parts[0] === '0' && parts[1].indexOf('*/') === 0
            && (parts[3] === '?' || parts[5] === '?');
        if (isIntervalLike) {
            switchSchedTab('interval');
            applyIntervalMinutes(parseInt(parts[1].substring(2)) || 5);
            var daysPart = parts[3] === '?' ? parts[5] : parts[4];
            applyWeekdays('#autoIntervalWeekdays', daysPart);
            return;
        }
        var isDailyLike = parts.length === 6 && parts[0] === '0' && parts[3] === '?';
        if (isDailyLike) {
            switchSchedTab('daily');
            $('#autoDailyTime').val(('0' + parts[2]).slice(-2) + ':' + ('0' + parts[1]).slice(-2));
            applyWeekdays('#autoWeekdays', parts[5]);
        } else {
            switchSchedTab('cron');
            $('#autoCron').val(x.cron);
        }
    }

    function applyIntervalMinutes(mins) {
        if (mins >= 60 && mins % 60 === 0) {
            $('#autoInterval').val(mins / 60);
            formState.intervalUnit = 'h';
        } else {
            $('#autoInterval').val(mins);
            formState.intervalUnit = 'm';
        }
        renderSelects();
    }

    /** Quartz(1=SUN..7=SAT) → 界面(1=MON..7=SUN) */
    function applyWeekdays(containerSel, daysPart) {
        if (!daysPart || daysPart === '*') return;
        var $btns = $(containerSel + ' .loop-weekday-btn');
        $btns.removeClass('active');
        var arr = daysPart.split(',');
        for (var i = 0; i < arr.length; i++) {
            var qd = parseInt(arr[i]);
            if (!isNaN(qd)) {
                var uiDay = qd === 1 ? 7 : (qd - 1);
                $(containerSel + ' .loop-weekday-btn[data-day="' + uiDay + '"]').addClass('active');
            }
        }
    }

    // ===================== 保存 =====================

    /**
     * multipart 提交（loop/add 与 loop/update）。
     *
     * 带附件时必须走 FormData（File 无法进普通表单编码）；为保持「无附件也走同一条路径」
     * （后端只认一种 Content-Type 口径，两条分支会造成字段序列化差异），有 FormData 就一律用。
     * 同名键多次 append = 数组：attachments / attachmentTypes / attachmentKeepPaths 三者按序一一对应。
     *
     * 无 FormData 环境（如契约测试的 vm 沙箱）降级为 api() 普通表单提交：
     * 此时附件不可能存在（受理入口同样依赖浏览器 File API），字段语义完全等价。
     */
    function apiPostForm(action, params, cb) {
        var sessionId = sid();
        if (!sessionId) { if (cb) cb(null); return; }
        if (typeof FormData !== 'function') { api(action, params, cb); return; }

        var fd = new FormData();
        fd.append('sessionId', sessionId);
        for (var k in params) {
            if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
            var v = params[k];
            // null（如 intervalMinutes 缺省）不 append：后端 @Param 缺参即 null，
            // 而 append('k', null) 会传字面量 "null" 字符串
            if (v === null || v === undefined) continue;
            fd.append(k, v);
        }
        var keepSent = false;
        for (var i = 0; i < autoAttachments.length; i++) {
            var item = autoAttachments[i];
            if (item.keptPath) {
                // 编辑态保留的旧附件：不重传字节，只告知后端「这个路径留着」
                fd.append('attachmentKeepPaths', item.keptPath);
                keepSent = true;
                continue;
            }
            if (!item.file) continue;
            fd.append('attachments', item.file, item.name);
            fd.append('attachmentTypes', item.type === 'image' ? 'image' : 'file');
        }
        // 编辑态 keep 清单必须显式发送：后端「未声明(null)=全部保留」，缺省会把
        // 「清空全部旧附件」的意图静默吞掉。无保留项时发哨兵 '.'——
        // 后端 normalizeNames 会把它判为非法名丢弃，得到空清单=显式清空。
        if (action === 'update' && !keepSent) fd.append('attachmentKeepPaths', '.');

        $.ajax({
            url: '/web/chat/loop/' + action,
            method: 'POST',
            data: fd,
            processData: false,
            contentType: false,
            dataType: 'json',
            success: function (r) { if (cb) cb(r); },
            error: function () {
                toast(t('settings.loop.operation_failed'), 'error');
                if (cb) cb(null);
            }
        });
    }

    function doSave() {
        var $saveBtn = $('#autoSaveBtn');
        if ($saveBtn.prop('disabled')) return;

        var name = $('#autoName').val().trim();
        if (!name) { toast(t('settings.loop.please_input_name'), 'error'); return; }
        var prompt = $('#autoPrompt').val().trim();
        if (!prompt) { toast(t('settings.loop.please_input_prompt'), 'error'); return; }
        var activeTab = $c().find('.loop-schedule-tab.active').data('sched');
        var cronVal = buildCron(activeTab);
        if (!cronVal) { toast(t('settings.loop.please_fill_time'), 'error'); return; }

        var intervalVal = null;
        if (activeTab === 'interval') {
            var num = parseInt($('#autoInterval').val()) || 5;
            intervalVal = formState.intervalUnit === 'h' ? num * 60 : num;
        }

        $saveBtn.prop('disabled', true).text(t('settings.loop.saving'));

        // 空串在后端 LoopTask 会归一为 null（= 跟随默认），故更新时也能清除已有选择
        var params = {
            name: name,
            prompt: prompt,
            intervalMinutes: intervalVal,
            cron: cronVal,
            worktreeEnabled: $('#autoWorktree').is(':checked'),
            // 留空 = 不限制轮次：显式传 0，确保更新时也能解除既有限制（后端 null 会沿用旧值）
            maxIterations: parseInt($('#autoMaxIter').val()) || 0,
            channelNotify: formState.channel || '',
            taskWorkspace: formState.workspace || '',
            modelName: formState.modelName || '',
            thinkingDepth: formState.thinking || 'auto',
            // 空串 = 清除任务级上下文（跟随默认）；后端空串归一为 null
            contextLength: formState.contextLength || '',
            // 空串 = 清除任务级权限（跟随会话已存档位）；后端空串归一为 null
            accessMode: formState.accessMode || ''
        };

        function restore() { $saveBtn.prop('disabled', false).text(t('settings.loop.save')); }

        if (editId) {
            params.taskId = editId;
            apiPostForm('update', params, function (r) {
                if (r && r.code === 200) {
                    toast(t('settings.loop.updated'), 'success');
                    clearAutoAttachments();
                    showList();
                } else {
                    restore();
                    toast((r && r.description) || t('settings.loop.update_failed'), 'error');
                }
            });
        } else {
            apiPostForm('add', params, function (r) {
                if (r && r.code === 200) {
                    toast(t('settings.loop.created'), 'success');
                    clearAutoAttachments();
                    showList();
                } else {
                    restore();
                    toast((r && r.description) || t('settings.loop.create_failed'), 'error');
                }
            });
        }
    }

    // ===================== 指令区事件（+菜单 / 命令补全 / 附件受理） =====================

    /**
     * 命令补全（/ 命令、@ 子代理、$ 技能）：完整复用 app-history.js 导出的 GourdCmdComplete，
     * 本页只提供宿主元素与事件接线（候选集过滤/键盘导航/插入语义不在这里重写一份，避免两份漂移）。
     */
    function autoPromptEl() { return document.getElementById('autoPrompt'); }
    function autoCmdEl() { return document.getElementById('autoCmdComplete'); }

    function triggerAutoCmd(prefix) {
        var inputEl = autoPromptEl();
        var completeEl = autoCmdEl();
        if (!inputEl || !completeEl || !window.GourdCmdComplete) return;
        closeAutoPanels();
        window.GourdCmdComplete.trigger(inputEl, completeEl, prefix);
        // trigger 内部改了 value 但不触发 input，高度需自己跟上
        autoGrowPrompt();
    }

    /** textarea input：除自适应高度外，接命令补全（口径同 app-history.js handleInputForCommands）。
     *  仅在「以 / @ $ 开头且光标前无空格」时展示面板，其余情况收起本页面板（不动聊天页面板）。 */
    function autoCmdCompleteOnInput() {
        var inputEl = autoPromptEl();
        var completeEl = autoCmdEl();
        if (!inputEl || !completeEl || !window.GourdCmdComplete) return;
        var val = inputEl.value;
        if (val.indexOf('/') === 0 || val.indexOf('@') === 0 || val.indexOf('$') === 0) {
            var textBeforeCursor = val.substring(0, inputEl.selectionStart);
            if (textBeforeCursor.indexOf(' ') === -1) {
                window.GourdCmdComplete.show(inputEl, completeEl, textBeforeCursor);
                return;
            }
        }
        window.GourdCmdComplete.hide(completeEl);
    }

    /** 指令区事件绑定。
     *
     *  一律委托到 #automationView（而非 document）：表单 DOM 每次重建，委托才能免重绑；
     *  更关键的是 #automationView 是 document 的后代，本页 handler 在 bubble 上行时先于
     *  app-history.js / app-ui.js 的 document 级委托执行，stopPropagation() 才真能断流
     *  （否则 app-history 的 document click 会 hideCmdComplete() 清掉刚弹出的候选集）。
     *  只绑一次（composerEventsBound），不持有已脱离文档的旧节点。 */
    var composerEventsBound = false;
    function bindComposerEvents() {
        if (composerEventsBound) return;
        // 沙箱/骨架未就绪时不绑（契约测试的 vm 沙箱只驱动保存与渲染路径）
        if (!$('#autoComposer').length) return;
        composerEventsBound = true;
        var $view = $('#automationView');

        // ---- + 菜单开合 ----
        // app-ui.js 的 closePlusMenus 是初始化时对 $('.plus-menu-wrap') 的快照绑定，
        // 自动化页 DOM 后建（且每次重建），不在那份快照里，必须本页自绑。
        $view.on('click', '#autoPlusBtn', function (e) {
            e.stopPropagation();
            var opening = !$('#autoPlusWrap').hasClass('open');
            closeAutoPanels(opening ? 'plus' : null);
            $('#autoPlusWrap').toggleClass('open', opening);
        });
        // 菜单项点击后统一收起（setTimeout 保证晚于同一元素上的动作处理器）
        $view.on('click', '#autoPlusWrap .plus-menu-item', function () {
            setTimeout(function () { $('#autoPlusWrap').removeClass('open'); }, 0);
        });

        // ---- 附件：+菜单项 → 隐藏 file input → change 受理 ----
        $view.on('click', '#autoAttachBtn', function (e) {
            e.stopPropagation();
            var el = document.getElementById('autoAttachInput');
            if (el) el.click();
        });
        $view.on('click', '#autoImageBtn', function (e) {
            e.stopPropagation();
            var el = document.getElementById('autoImageInput');
            if (el) el.click();
        });
        $view.on('change', '#autoAttachInput', function (e) {
            if (e.target.files && e.target.files.length > 0) acceptAutoAttachments(e.target.files, 'file');
            e.target.value = '';
        });
        $view.on('change', '#autoImageInput', function (e) {
            if (e.target.files && e.target.files.length > 0) acceptAutoAttachments(e.target.files, 'image');
            e.target.value = '';
        });
        // 附件删除（委托回本页数组；data-idx 为渲染时的下标）
        $view.on('click', '#autoAttachmentsWrap .attachment-item-remove', function (e) {
            e.stopPropagation();
            removeAutoAttachment(parseInt($(this).attr('data-idx'), 10));
        });

        // ---- 命令 / 技能 / 子代理：插入前缀并开面板 ----
        // stopPropagation 必须保留：否则事件继续上到 document，app-history.js 的外部收起器
        // 会 hideCmdComplete() 把刚 show 出来的候选集清空（面板还在、导航已死）。
        $view.on('click', '#autoCmdBtn', function (e) { e.stopPropagation(); triggerAutoCmd('/'); });
        $view.on('click', '#autoSkillBtn', function (e) { e.stopPropagation(); triggerAutoCmd('$'); });
        $view.on('click', '#autoAgentBtn', function (e) { e.stopPropagation(); triggerAutoCmd('@'); });
        // #autoHistoryBtn 置灰，无动作

        // ---- textarea：命令补全接线 ----
        // 刻意不在这里另绑一个 input：initEvents 已在 #automationView 上绑了同选择器的
        // input 委托（autoGrowPrompt），同一宿主同一选择器重复绑会让两个处理器争高度/面板。
        // 高度与补全统一由那一处串行调用（见 initEvents）。
        $view.on('keydown', '#autoPrompt', function (e) {
            if (!window.GourdCmdComplete) return;
            // 补全面板导航优先；刻意不加 Enter 发送语义（保存走底部按钮）
            window.GourdCmdComplete.navigate(e, autoPromptEl(), autoCmdEl());
        });

        // ---- 补全面板候选项点击（同 app-history.js 的面板点击范式） ----
        $view.on('click', '#autoCmdComplete .cmd-complete-item', function (e) {
            e.stopPropagation();
            if (!window.GourdCmdComplete) return;
            window.GourdCmdComplete.setIndex(parseInt($(this).attr('data-index'), 10));
            window.GourdCmdComplete.apply(autoPromptEl(), autoCmdEl());
            // apply 内部调 autoResize（只改 height，不管 overflowY），高度语义收回本页
            autoGrowPrompt();
            var el = autoPromptEl();
            if (el && el.focus) el.focus();
        });

        // ---- 点击外部 / Esc 收起（+菜单与补全面板；权限气泡由 bindAccessEvents 自管） ----
        // 这三个留在 document：它们是「点哪儿都要收」的全局语义，且只读不写共享状态
        $(document).on('mousedown.autoComposer', function (e) {
            if (!$(e.target).closest('#autoPlusWrap').length) $('#autoPlusWrap').removeClass('open');
        });
        $(document).on('keydown.autoComposer', function (e) {
            if (e.key !== 'Escape') return;
            $('#autoPlusWrap').removeClass('open');
            // 仅在自动化表单真的挂着时才收面板：表单未挂载时 autoCmdEl() 为 null，
            // 而 hide(null) 会退化成全局 hideCmdComplete() —— 那会把聊天页正在用的
            // 命令补全面板一并关掉（跨视图误伤）。
            var completeEl = autoCmdEl();
            if (completeEl && window.GourdCmdComplete) window.GourdCmdComplete.hide(completeEl);
        });
        $(document).on('click.autoComposer', function (e) {
            var completeEl = autoCmdEl();
            // 同上：表单未挂载时完全不介入，把聊天页面板的收起权留给 app-history.js
            // （它的外部收起器排除了所有 textarea，而本处只认 #autoPrompt）。
            if (!completeEl || !window.GourdCmdComplete) return;
            var $target = $(e.target);
            if ($target.closest('#autoCmdComplete').length || $target.closest('#autoPrompt').length) return;
            window.GourdCmdComplete.hide(completeEl);
        });
    }

    // ===================== 事件（仅绑定在本视图容器内） =====================

    function initEvents() {
        if (initialized) return;
        initialized = true;

        var $view = $('#automationView');

        // ---- 列表操作 ----
        $view.on('click', '#autoAddBtn', function () { editId = null; showForm(); });

        // ---- 模板卡片：带预填值进新建表单 ----
        $view.on('click', '.auto-tpl-card', function () {
            editId = null;
            showForm($(this).attr('data-tpl'));
        });

        $view.on('click', '.auto-act', function (e) {
            e.stopPropagation();
            var action = $(this).data('action');
            var id = $(this).data('id');
            if (action === 'toggle') {
                api('toggle', { taskId: id }, function (r) {
                    if (r && r.code === 200) {
                        toast(t('settings.loop.operation_success'), 'success');
                        showList();
                    }
                });
            } else if (action === 'trigger') {
                api('trigger', { taskId: id }, function (r) {
                    if (r && r.code === 200) toast(t('settings.loop.triggered'), 'success');
                });
            } else if (action === 'remove') {
                var run = function () {
                    api('remove', { taskId: id }, function (r) {
                        if (r && r.code === 200) {
                            toast(t('settings.loop.deleted'), 'success');
                            showList();
                        }
                    });
                };
                // layConfirm 内置无 layer 兜底（app-base.js），不再回落原生 confirm
                if (typeof window.layConfirm === 'function') window.layConfirm(t('settings.loop.confirm_delete'), run);
            } else if (action === 'edit') {
                editId = id;
                showForm();
            } else if (action === 'session') {
                var sessId = $(this).attr('data-sid');
                var sessRoot = $(this).attr('data-root') || '';
                var sessLabel = $(this).closest('.auto-task-item').find('.auto-task-name').text();
                if (!sessId || typeof window.openSessionById !== 'function') return;
                // 提示条不再由这里注入任务定义参数：任务可能被删除/编辑，定义值 ≠ 本轮实际生效值。
                // 恢复改由 app-history.js refreshSessionModel → /web/chat/loop-run 取证端点统一负责
                // （刷新后/任意入口打开执行会话都能恢复，数据源是会话快照里的本轮生效值）。
                window.openSessionById(sessId, sessLabel, sessRoot);
            }
        });

        // ---- 表单：返回 / 调度 tab / 星期 / 高级 / 试跑 / 保存 ----
        $view.on('click', '#autoBackBtn', function () { showList(); });
        $view.on('click', '.loop-schedule-tab', function () { switchSchedTab($(this).data('sched')); });
        $view.on('click', '.loop-weekday-btn', function () { $(this).toggleClass('active'); });
        $view.on('click', '#autoAdvancedToggle', function () {
            var $a = $('#autoAdvanced');
            $a.toggle();
            $(this).toggleClass('collapsed', !$a.is(':visible'));
        });
        $view.on('click', '#autoTriggerBtn', function () {
            if (editId) api('trigger', { taskId: editId }, function () { toast(t('settings.loop.triggered'), 'success'); });
        });
        $view.on('click', '#autoSaveBtn', doSave);

        // ---- 指令输入框：自适应高度（代替原生 resize 手柄）+ 命令补全 ----
        // 两者必须串在同一处理器里：同一宿主同一选择器重复绑 input 会互相覆盖/竞争
        $view.on('input', '#autoPrompt', function () {
            autoGrowPrompt();
            autoCmdCompleteOnInput();
        });

        // ---- 工作空间选择器（局部委托 + stopPropagation） ----
        // 清除按钮必须先于 #autoWsCurrent 处理：它是 current 的子元素，
        // 不阻止冒泡会在清除后紧接着把下拉弹开
        $view.on('click', '#autoWsClear', function (e) {
            e.stopPropagation();
            formState.workspace = '';
            $('#autoWsSelector').removeClass('open');
            renderWorkspaceUI();
        });
        $view.on('click', '#autoWsCurrent', function (e) {
            e.stopPropagation();
            var opening = !$('#autoWsSelector').hasClass('open');
            closeAutoPanels(opening ? 'ws' : null);
            $('#autoWsSelector').toggleClass('open', opening);
        });
        $view.on('click', '#autoWsDropdown .auto-ws-item', function (e) {
            e.stopPropagation();
            formState.workspace = $(this).attr('data-path') || '';
            $('#autoWsSelector').removeClass('open');
            renderWorkspaceUI();
        });

        // ---- 模型选择器：开合/搜索/分组/档位/上下文 chips 全部由公共组件接管 ----
        // （「点开模型下拉时收起工作空间下拉」的互斥由组件 onOpen 回调处理，
        //   组件在按钮点击上 stopPropagation 防被全局收起器关掉，故页面级委托收不到该事件）

        // 视图内空白处点击：收起工作空间下拉（模型选择器由公共组件的 document 级监听收起）
        $view.on('click', function (e) {
            if (!$(e.target).closest('#autoWsSelector').length) $('#autoWsSelector').removeClass('open');
        });

        // 语言切换后重绘当前页
        document.addEventListener('i18n:localeChanged', function () {
            if ($('#automationView').hasClass('active')) {
                // 模型选择器文案由公共组件自行重绘，这里只补工作空间与列表
                if (editId) { renderWorkspaceUI(); }
                else showList();
            }
        });
    }

    // ===================== 视图入口 =====================

    /** 打开自动化视图（由左侧栏「自动化」导航或任务行点击触发） */
    function openAutomation(taskId) {
        initEvents();

        // 与聊天/欢迎视图互斥：隐藏它们，显示本视图
        if (typeof window.exitCodeMode === 'function' && window.appMode === 'code') {
            window.exitCodeMode();
        }
        if (typeof window.closeSkills === 'function') window.closeSkills();
        if (typeof window.closeChannel === 'function') window.closeChannel();
        if (typeof window.closeModelSettings === 'function') window.closeModelSettings();
        if (typeof window.closeMemoryView === 'function') window.closeMemoryView();
        if (typeof window.closeUsage === 'function') window.closeUsage();
        $('#welcomeView').hide();
        $('#chatView').removeClass('active');
        $('#automationView').addClass('active');
        $('.main-nav-item').removeClass('active');
        $('#automationNavBtn').addClass('active');

        // 关键：自动化视图既不属于 chat 也不属于 welcome，必须让出 inChatMode。
        // 否则 app-history.selectSession 的 `if (idx===cur && inChatMode) return`
        // 与各处 `if (!inChatMode) switchToChatMode()` 会被短路，
        // 导致从本视图切回聊天时 #chatView 拿不回 .active（主区停留在自动化页 = 白屏）。
        window.inChatMode = false;

        // 关掉可能打开的设置浮层（浮层为高 z-index 遮罩，会盖住本视图）
        if (typeof window.closeSettings === 'function') window.closeSettings();
        else if ($('#settingsOverlay').is(':visible')) $('#settingsCloseBtn').trigger('click');

        if (taskId) { editId = taskId; showForm(); }
        else showList();
    }

    /** 离开自动化视图（切回聊天/欢迎/Code 时由对应切换函数调用） */
    function closeAutomation() {
        if (autoSelector) { autoSelector.destroy(); autoSelector = null; }
        $('#automationView').removeClass('active');
        $('#automationNavBtn').removeClass('active');
    }

    /* 项目登记表变更（侧栏重命名 / 新增 / 移除）：作废缓存并重拉，
       已打开的自动化页（任务卡标签 / 表单工作空间按钮）即时跟上新显示名。 */
    document.addEventListener('projects:changed', function () {
        formState.projectsLoaded = false;
        loadProjects(function () {
            if (!$('#automationView').hasClass('active')) return;
            if (formMode) renderWorkspaceUI();
            else showList();
        });
    });

    window.openAutomation = openAutomation;
    window.closeAutomation = closeAutomation;
    window.isAutomationOpen = function () { return $('#automationView').hasClass('active'); };
})();
