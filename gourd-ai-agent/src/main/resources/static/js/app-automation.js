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
 *     且 toggle handler 内 stopPropagation，避免被 app-history.js 的全局 open 收起器清掉。
 */
(function () {
    'use strict';

    var CONTAINER = 'automationInner';
    var editId = null;
    var initialized = false;

    /** 表单态：不进 DOM 的选择值（工作空间 / 模型 / 思考档位 / layui select 值） */
    var formState = {
        workspace: '',      // '' = 不选 = 全局（与聊天页语义一致）
        modelName: '',      // '' = 未显式选模，运行时跟随默认模型
        thinking: 'auto',
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

    /** 未选 = 全局：按钮仅提示“选择项目”，不展示默认/全局信息（同聊天页 displayName） */
    function workspaceLabel() {
        if (!formState.workspace) return t('code.select_project');
        for (var i = 0; i < formState.projects.length; i++) {
            if (formState.projects[i].path === formState.workspace) {
                return formState.projects[i].name || baseName(formState.workspace);
            }
        }
        return baseName(formState.workspace);
    }

    function standardOfModel(name) {
        for (var i = 0; i < formState.models.length; i++) {
            if (formState.models[i].name === name) return formState.models[i].standard || '';
        }
        return '';
    }

    /** 历史档位值归一（与后端 ThinkingDepth.normalize 同口径）：'off' 是 'auto' 的旧名，不再有 minimal 档 */
    function normThinking(depth) {
        var d = String(depth == null ? '' : depth).toLowerCase();
        if (!d || d === 'off') return 'auto';
        if (d === 'minimal') return 'low';
        return d;
    }

    /**
     * 思考档位选项：唯一真源为聊天页 app-history.js 的 thinkingOptionsForModel()，
     * 它按后端下发的「该模型真正可区分的档位」构建（策略 S2），故入参是模型名而非接口类型。
     * 本页不再自行维护档位表。若加载顺序异常导致真源缺失，回退到最小内置集合以保证 UI 不崩。
     */
    function thinkingOptions(modelName) {
        if (typeof window.thinkingOptionsForModel === 'function') {
            var opts = window.thinkingOptionsForModel(modelName);
            if (opts && opts.length) return opts;
        }
        var vals = ['auto', 'low', 'medium', 'high'];
        var fallback = [];
        for (var i = 0; i < vals.length; i++) {
            fallback.push({ value: vals[i], label: t('history.thinking.' + vals[i] + '.label') });
        }
        return fallback;
    }

    /* 展示用的生效模型：任务未显式选模（modelName 为空）时回落后端解析的默认模型。
     * 存储语义不变：保存时仍写空串，以后换全局默认模型，存量任务照样跟随。 */
    function effectiveModel() {
        return formState.modelName || formState.defaultModel || '';
    }

    function modelLabel() {
        return effectiveModel();
    }

    function thinkingTagLabel() {
        if (!formState.thinking || formState.thinking === 'auto') return '';
        var opts = thinkingOptions(effectiveModel());
        for (var i = 0; i < opts.length; i++) {
            if (opts[i].value === formState.thinking) return opts[i].label;
        }
        return '';
    }

    // ===================== 列表视图 =====================

    function showList() {
        editId = null;
        api('list', null, function (res) {
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
        if (x.workspace) tags.push('<span class="auto-task-tag">' + escapeHtml(baseName(x.workspace)) + '</span>');
        if (x.modelName) tags.push('<span class="auto-task-tag">' + escapeHtml(x.modelName) + '</span>');
        if (x.thinkingDepth && normThinking(x.thinkingDepth) !== 'auto') tags.push('<span class="auto-task-tag">' + escapeHtml(x.thinkingDepth) + '</span>');
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
        // 仅新建时重置：编辑态下真实值要等 api('get') 异步回来，
        // 若先清空会让首屏闪现“不推送 / 分钟”等错值
        if (!editId) {
            formState.workspace = '';
            formState.modelName = '';
            formState.thinking = 'auto';
            formState.channel = '';
            formState.intervalUnit = 'm';
        }

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

        // ===== 指令区（composer 形态） =====
        html += '<div class="auto-form-group"><label>' + escapeHtml(t('automation.instruction')) + ' <span class="auto-required">*</span></label>';
        html += '<div class="auto-composer" id="autoComposer">';
        html += '<div class="auto-composer-input-wrap">';
        // 不写 rows：rows=4 算出的初始高度（≈104px）大于 CSS min-height(92px)，
        // 用户删空文本后 autoGrowPrompt 会钳到 92px 造成不可逆的高度塌陷。高度全交 CSS + JS
        html += '<textarea id="autoPrompt" class="auto-composer-textarea" placeholder="'
            + escapeHtml(t('settings.loop.task_prompt_placeholder')) + '"></textarea>';
        html += '</div>';
        html += '<div class="auto-composer-toolbar">';
        html += '<div class="auto-composer-toolbar-left">';
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
        // 模型 + 思考（沿用 .model-selector 视觉类，id 唯一）
        html += '<div class="model-selector auto-model-selector" id="autoModelSelector">';
        html += '<div class="model-selector-current" id="autoModelCurrent">';
        html += '<span class="model-name" id="autoModelName"></span>';
        html += '<span class="model-thinking-tag" id="autoModelThinkingTag" style="display:none"></span>';
        html += '<svg class="model-arrow" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
        html += '</div>';
        // 骨架重建（进表单页）：搜索框回到空白，关键词必须同步重置，
        // 否则列表会按上次关键词过滤但输入框看上去是空的
        modelFilterText = '';
        modelFirstMatch = null;
        html += '<div class="model-dropdown has-search" id="autoModelDropdown">';
        html += GourdModelDropdown.searchHtml(t('history.model_search_placeholder'));
        html += '<div class="model-dropdown-list" id="autoModelList"></div>';
        html += '</div>';
        html += '</div>';
        html += '</div></div>';   // toolbar-left / toolbar
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
        html += '</div></div>';

        html += '<div class="auto-form-actions">';
        html += '<button class="auto-btn-secondary" id="autoTriggerBtn" style="display:' + (editId ? 'inline-flex' : 'none') + '">'
            + escapeHtml(t('settings.loop.test_run')) + '</button>';
        html += '<button class="auto-btn-primary" id="autoSaveBtn">' + escapeHtml(t('settings.loop.save')) + '</button>';
        html += '</div>';
        html += '</div>';

        $c().html(html);

        // 时间选择器（laydate 只对存在的元素渲染；DOM 每次重建，无残留实例问题）
        if (typeof layui !== 'undefined' && layui.laydate) {
            layui.laydate.render({ elem: '#autoDailyTime', type: 'time', format: 'HH:mm', theme: '#6366f1' });
        }

        renderSelects();
        renderWorkspaceUI();
        renderModelUI();
        loadProjects(function () { renderWorkspaceUI(); });
        loadModels(function () { renderModelUI(); });

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

    /**
     * layui select 渲染 + 回写 formState。
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
        $('#autoWsName').text(workspaceLabel()).attr('title', formState.workspace || '');
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

    function thinkingChipsHtml() {
        var opts = thinkingOptions(effectiveModel());
        var valid = 'auto';
        for (var k = 0; k < opts.length; k++) {
            if (opts[k].value === formState.thinking) { valid = formState.thinking; break; }
        }
        var h = '<div class="model-thinking-opts"><span class="model-thinking-label">' + escapeHtml(t('app.thinking_label')) + '</span>';
        for (var i = 0; i < opts.length; i++) {
            h += '<span class="model-thinking-chip' + (opts[i].value === valid ? ' active' : '') + '" data-thinking="'
                + escapeHtml(opts[i].value) + '"'
                + (opts[i].desc ? ' title="' + escapeHtml(opts[i].desc) + '"' : '')
                + '>' + escapeHtml(opts[i].label) + '</span>';
        }
        h += '</div>';
        return h;
    }

    // 模型下拉搜索关键词（每次打开下拉时清空）与当前过滤首项
    var modelFilterText = '';
    var modelFirstMatch = null;

    function providerOfModel(name) {
        for (var i = 0; i < formState.models.length; i++) {
            if (formState.models[i].name === name) return formState.models[i].provider || '';
        }
        return '';
    }

    function renderModelUI() {
        var $sel = $('#autoModelSelector');
        if (!$sel.length) return;
        $('#autoModelName').text(modelLabel());
        var tag = thinkingTagLabel();
        $('#autoModelThinkingTag').text(tag).toggle(!!tag);

        // 严格保持接口顺序；仅当 provider 与紧邻上一模型不同时插入标题
        var entries = ModelListOrder.buildEntries(formState.models);
        var current = effectiveModel();
        var result = GourdModelDropdown.render({
            segments: GourdModelDropdown.toSegments(entries),
            query: modelFilterText,
            currentModel: current,
            currentProvider: providerOfModel(current),
            otherLabel: t('history.model_group_other'),
            emptyText: t('history.model_search_empty'),
            toggleTitle: t('history.model_group_toggle'),
            itemHtml: function (m, active) {
                return '<div class="model-dropdown-item' + (active ? ' active' : '') + '" data-model="' + escapeHtml(m.name) + '">'
                    + '<span class="model-item-name">' + escapeHtml(m.name) + '</span>'
                    + (active ? thinkingChipsHtml() : '')
                    + '</div>';
            }
        });
        // 只重绘列表层，不动搜索框（否则丢焦点与已输入内容）
        $('#autoModelList').html(result.html);
        modelFirstMatch = result.firstModel;
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
        formState.channel = x.channelNotify || '';
        renderSelects();
        renderWorkspaceUI();
        renderModelUI();

        applySchedule(x);

        if (x.worktreeEnabled || x.maxIterations > 0) {
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
            thinkingDepth: formState.thinking || 'auto'
        };

        function restore() { $saveBtn.prop('disabled', false).text(t('settings.loop.save')); }

        if (editId) {
            params.taskId = editId;
            api('update', params, function (r) {
                if (r && r.code === 200) {
                    toast(t('settings.loop.updated'), 'success');
                    showList();
                } else {
                    restore();
                    toast((r && r.description) || t('settings.loop.update_failed'), 'error');
                }
            });
        } else {
            api('add', params, function (r) {
                if (r && r.code === 200) {
                    toast(t('settings.loop.created'), 'success');
                    showList();
                } else {
                    restore();
                    toast((r && r.description) || t('settings.loop.create_failed'), 'error');
                }
            });
        }
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
                if (typeof window.layConfirm === 'function') window.layConfirm(t('settings.loop.confirm_delete'), run);
                else if (window.confirm(t('settings.loop.confirm_delete'))) run();
            } else if (action === 'edit') {
                editId = id;
                showForm();
            } else if (action === 'session') {
                var sessId = $(this).attr('data-sid');
                var sessRoot = $(this).attr('data-root') || '';
                var sessLabel = $(this).closest('.auto-task-item').find('.auto-task-name').text();
                if (sessId && typeof window.openSessionById === 'function') window.openSessionById(sessId, sessLabel, sessRoot);
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

        // ---- 指令输入框：自适应高度（代替原生 resize 手柄） ----
        $view.on('input', '#autoPrompt', autoGrowPrompt);

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
            $('#autoModelSelector').removeClass('open');
            $('#autoWsSelector').toggleClass('open');
        });
        $view.on('click', '#autoWsDropdown .auto-ws-item', function (e) {
            e.stopPropagation();
            formState.workspace = $(this).attr('data-path') || '';
            $('#autoWsSelector').removeClass('open');
            renderWorkspaceUI();
        });

        // ---- 模型 / 思考选择器 ----
        $view.on('click', '#autoModelCurrent', function (e) {
            e.stopPropagation();
            $('#autoWsSelector').removeClass('open');
            var willOpen = !$('#autoModelSelector').hasClass('open');
            $('#autoModelSelector').toggleClass('open');
            // 每次打开从完整列表开始：清空关键词并聚焦搜索框
            if (willOpen) {
                if (modelFilterText) { modelFilterText = ''; renderModelUI(); }
                $('#autoModelDropdown').find('.model-search-input').val('');
                $('#autoModelDropdown').find('.model-search-clear').hide();
                setTimeout(function () { try { $('#autoModelDropdown').find('.model-search-input').focus(); } catch (err) {} }, 0);
            }
        });

        // 搜索：输入即过滤（只重绘列表层，焦点不丢）
        $view.on('input', '#autoModelDropdown .model-search-input', function () {
            modelFilterText = $(this).val() || '';
            $('#autoModelDropdown').find('.model-search-clear').toggle(!!modelFilterText);
            renderModelUI();
            $('#autoModelList').scrollTop(0);
        });
        $view.on('keydown', '#autoModelDropdown .model-search-input', function (e) {
            if (e.key === 'Escape' || e.keyCode === 27) {
                e.stopPropagation();
                if (modelFilterText) {
                    modelFilterText = '';
                    $(this).val('');
                    $('#autoModelDropdown').find('.model-search-clear').hide();
                    renderModelUI();
                } else {
                    $('#autoModelSelector').removeClass('open');
                }
                return;
            }
            if (e.key === 'Enter' || e.keyCode === 13) {
                e.preventDefault();
                e.stopPropagation();
                // 回车选中过滤结果首项；与当前生效模型相同时视为确认收起
                if (modelFirstMatch != null && modelFirstMatch !== effectiveModel()) {
                    applyModelSelection(modelFirstMatch);
                } else {
                    $('#autoModelSelector').removeClass('open');
                }
            }
        });

        $view.on('click', '#autoModelDropdown', function (e) {
            // 下拉内部点击不冒泡：否则会被全局文档收起器与视图空白收起器关闭（搜索框将无法输入）
            e.stopPropagation();

            // 清空按钮
            if ($(e.target).closest('.model-search-clear').length) {
                modelFilterText = '';
                $('#autoModelDropdown').find('.model-search-input').val('').focus();
                $('#autoModelDropdown').find('.model-search-clear').hide();
                renderModelUI();
                return;
            }

            // 服务商组头：折叠/展开
            var $group = $(e.target).closest('.model-dropdown-group');
            if ($group.length) {
                var $wrap = $group.closest('.model-dropdown-group-wrap');
                GourdModelDropdown.setCollapsed($group.attr('data-provider') || '', !$wrap.hasClass('collapsed'));
                renderModelUI();
                return;
            }

            var $chip = $(e.target).closest('.model-thinking-chip');
            if ($chip.length) {
                // 思考档位：仅设值，保持下拉打开
                var depth = $chip.attr('data-thinking');
                if (depth != null) { formState.thinking = depth; renderModelUI(); }
                return;
            }
            var $item = $(e.target).closest('.model-dropdown-item');
            if (!$item.length) return;
            var name = $item.attr('data-model');
            if (name == null) return;
            // 点当前生效模型：视为确认收起。此时若 modelName 为空（未显式选择）保持不写入，继续跟随默认
            if (name === effectiveModel()) { $('#autoModelSelector').removeClass('open'); return; }
            applyModelSelection(name);
        });

        // 切模型：思考档位集可能变化，当前档位不在新集合内则回落 off
        function applyModelSelection(name) {
            formState.modelName = name;
            var opts = thinkingOptions(name);
            var ok = false;
            for (var i = 0; i < opts.length; i++) { if (opts[i].value === formState.thinking) { ok = true; break; } }
            if (!ok) formState.thinking = 'auto';
            renderModelUI();
        }

        // 视图内空白处点击：收起下拉（不影响视图外元素）
        $view.on('click', function (e) {
            if (!$(e.target).closest('#autoModelSelector').length) $('#autoModelSelector').removeClass('open');
            if (!$(e.target).closest('#autoWsSelector').length) $('#autoWsSelector').removeClass('open');
        });

        // 语言切换后重绘当前页
        document.addEventListener('i18n:localeChanged', function () {
            if ($('#automationView').hasClass('active')) {
                if (editId) { renderWorkspaceUI(); renderModelUI(); }
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
        $('#automationView').removeClass('active');
        $('#automationNavBtn').removeClass('active');
    }

    window.openAutomation = openAutomation;
    window.closeAutomation = closeAutomation;
    window.isAutomationOpen = function () { return $('#automationView').hasClass('active'); };
})();
