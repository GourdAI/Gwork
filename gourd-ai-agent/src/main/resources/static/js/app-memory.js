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
    var listRequestSeq = 0;
    var projectsRequestSeq = 0;
    var currentAliased = false;
    var lastListData = null;
    var lastListSnapshot = null;
    var memoryProjects = [];
    var memoryProjectsLoaded = false;
    var memorySelectedCwd = '';
    var memorySelectionInitialized = false;

    function t(key) { return window.GourdI18n ? window.GourdI18n.t(key) : key; }
    function escHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function sessionHeaders(cwdSnapshot) {
        var headers = {};
        if (cwdSnapshot) headers['X-Session-Cwd'] = cwdSnapshot;
        return headers;
    }

    function scopeSnapshot() {
        return {
            scope: currentScope,
            // 全局域与项目无关；工作空间域只使用记忆页自己的选择，不读取或改写应用全局 workspace 状态。
            cwd: currentScope === SCOPE_WORKSPACE ? memorySelectedCwd : ''
        };
    }

    function isCurrentSnapshot(snapshot) {
        var current = scopeSnapshot();
        return snapshot.scope === current.scope && pathKey(snapshot.cwd) === pathKey(current.cwd);
    }

    function parseResult(response) {
        return response.json().catch(function () { return null; }).then(function (res) {
            if (!response.ok || !res || res.code !== 200) {
                var error = new Error((res && res.description) || ('HTTP ' + response.status));
                error.result = res;
                error.status = response.status;
                throw error;
            }
            return res;
        });
    }

    var $list = $('#memoryViewList');
    var $meta = $('#memoryViewMeta');
    var $enabledSwitch = $('#memoryEnabledSwitch');
    var $isolationSwitch = $('#memoryIsolationSwitch');
    var $clearBtn = $('#memoryViewClearBtn');
    var $projectSelector = $('#memoryProjectSelector');
    var $projectCurrent = $('#memoryProjectCurrent');
    var $projectDropdown = $('#memoryProjectDropdown');

    /* ===================== 视图入口（与 openAutomation 同构） ===================== */

    function openMemoryView(opts) {
        /* 仅首次打开时记录应用当前目录作为候选值；项目列表返回并确认已登记后才读取记忆。 */
        initializeMemoryWorkspace();
        renderProjectSelector();
        loadMemoryProjects();

        /* 专注模式：以弹层（遮罩+居中面板）形式打开，不退出 code 模式。
           旧行为先 exitCodeMode() 会经 startFreshSession→switchToWelcomeMode 闪现主页面，已废弃。
           弹层盖在专注模式界面之上，不切换底层视图、不动 inChatMode（右栏对话流式不受影响）。 */
        if (opts && opts.overlay && window.appMode === 'code') {
            $view.addClass('memory-overlay active');
            if (typeof window.closeSettings === 'function') window.closeSettings();
            else if ($('#settingsOverlay').is(':visible')) $('#settingsCloseBtn').trigger('click');
            loadSwitches();
            if (currentScope !== SCOPE_WORKSPACE) loadMemories();
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
        if (typeof window.closeUsage === 'function') window.closeUsage();
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
        if (currentScope !== SCOPE_WORKSPACE) loadMemories();
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

    /* ===================== 记忆空间项目选择器 ===================== */

    function pathKey(path) {
        var normalized = String(path || '').replace(/[\\/]+$/, '');
        var windowsPath = /^[a-zA-Z]:[\\/]/.test(normalized) || /^[\\/]{2}[^\\/]/.test(normalized);
        return windowsPath ? normalized.replace(/\//g, '\\').toLowerCase() : normalized;
    }

    function initializeMemoryWorkspace() {
        if (memorySelectionInitialized) return;
        memorySelectionInitialized = true;
        memorySelectedCwd = (typeof window.getSessionCwd === 'function') ? (window.getSessionCwd() || '') : '';
    }

    function registeredProject(path) {
        var selectedKey = pathKey(path);
        for (var i = 0; i < memoryProjects.length; i++) {
            if (pathKey(memoryProjects[i] && memoryProjects[i].path) === selectedKey) return memoryProjects[i];
        }
        return null;
    }

    function selectedProject() {
        return registeredProject(memorySelectedCwd);
    }

    function canOperateSnapshot(snapshot) {
        return snapshot.scope !== SCOPE_WORKSPACE
            || (memoryProjectsLoaded && !!snapshot.cwd && !!registeredProject(snapshot.cwd));
    }

    function renderProjectSelector() {
        if (!$projectSelector.length) return;
        var global = currentScope !== SCOPE_WORKSPACE;
        var current = selectedProject();
        var currentName = global
            ? text('memory.tab_global', '全局')
            : ((current && current.name) || (memoryProjectsLoaded ? t('code.select_project') : t('memory.loading')));
        var currentPath = global ? '' : ((current && current.path) || '');

        $('#memoryProjectName').text(currentName);
        $('#memoryProjectPath').text(currentPath).attr('title', currentPath);
        $projectCurrent.prop('disabled', global || !memoryProjectsLoaded || !memoryProjects.length)
            .attr('aria-expanded', $projectSelector.hasClass('open') ? 'true' : 'false');
        // 全局域与项目无关：整块项目选择器不展示（仅工作空间域才需要切换项目）
        $projectSelector.toggleClass('hidden', global)
            .toggleClass('disabled', global || !memoryProjectsLoaded || !memoryProjects.length);
        if (global || !memoryProjectsLoaded || !memoryProjects.length) $projectSelector.removeClass('open');

        var selectedKey = pathKey(memorySelectedCwd);
        var html = '';
        for (var i = 0; i < memoryProjects.length; i++) {
            var project = memoryProjects[i];
            if (!project || !project.path) continue;
            html += projectOptionHtml(project, pathKey(project.path) === selectedKey);
        }
        if (!html) html = '<div class="memory-project-empty">' + escHtml(t('code.no_projects')) + '</div>';
        $projectDropdown.html(html);
    }

    function projectOptionHtml(project, active) {
        return '<button class="memory-project-option' + (active ? ' active' : '') + '" type="button" role="option"'
            + ' aria-selected="' + (active ? 'true' : 'false') + '" data-path="' + escHtml(project.path || '') + '" title="' + escHtml(project.path || '') + '">'
            + '<span class="memory-project-option-name">' + escHtml(project.name || project.path || text('memory.tab_workspace', '工作空间')) + '</span>'
            + '<span class="memory-project-option-path">' + escHtml(project.path || '') + '</span>'
            + '</button>';
    }

    function loadMemoryProjects() {
        var requestSeq = ++projectsRequestSeq;
        memoryProjectsLoaded = false;
        renderProjectSelector();
        fetch('/web/chat/projects').then(parseResult).then(function (res) {
            if (requestSeq !== projectsRequestSeq) return;
            memoryProjects = (Array.isArray(res.data) ? res.data : []).filter(function (project) {
                return project && project.path;
            });
            memoryProjectsLoaded = true;
            if (!selectedProject()) memorySelectedCwd = memoryProjects.length ? memoryProjects[0].path : '';
            renderProjectSelector();
            if (currentScope === SCOPE_WORKSPACE) {
                if (memorySelectedCwd) loadMemories();
                else {
                    lastListData = null;
                    lastListSnapshot = null;
                    $meta.text('');
                    $list.html('<div class="memory-empty">' + escHtml(t('code.no_projects')) + '</div>');
                }
            }
        }).catch(function (error) {
            if (requestSeq !== projectsRequestSeq) return;
            memoryProjectsLoaded = true;
            renderProjectSelector();
            if (currentScope === SCOPE_WORKSPACE && !memoryProjects.length) {
                var detail = error && error.message ? '：' + error.message : '';
                $list.html('<div class="memory-empty memory-error">' + escHtml(t('memory.load_failed') + detail) + '</div>');
            }
        });
    }

    /* ===================== 记忆列表 ===================== */

    function loadWorkspaceMemoriesWhenReady() {
        if (!memoryProjectsLoaded) {
            $list.html('<div class="memory-empty">' + escHtml(t('memory.loading')) + '</div>');
            $meta.text('');
            return;
        }
        if (!memorySelectedCwd || !selectedProject()) {
            $list.html('<div class="memory-empty">' + escHtml(t('code.no_projects')) + '</div>');
            $meta.text('');
            return;
        }
        loadMemories();
    }

    function loadMemories() {
        var snapshot = scopeSnapshot();
        if (!canOperateSnapshot(snapshot)) return;
        var requestSeq = ++listRequestSeq;
        currentAliased = false;
        lastListData = null;
        lastListSnapshot = null;
        $list.html('<div class="memory-empty">' + escHtml(t('memory.loading')) + '</div>');
        $meta.text('');

        fetch('/web/chat/memory/list?scope=' + encodeURIComponent(snapshot.scope), {
            headers: sessionHeaders(snapshot.cwd)
        }).then(parseResult)
            .then(function (res) {
                if (requestSeq !== listRequestSeq || !isCurrentSnapshot(snapshot)) return;
                var data = res.data || {};
                currentAliased = data.aliased === true;
                lastListData = data;
                lastListSnapshot = snapshot;
                renderList(data.items || [], data.total || 0, data.hasMore === true);
            })
            .catch(function (error) {
                if (requestSeq !== listRequestSeq || !isCurrentSnapshot(snapshot)) return;
                currentAliased = false;
                var detail = error && error.message ? '：' + error.message : '';
                $list.html('<div class="memory-empty memory-error">'
                    + escHtml(t('memory.load_failed') + detail) + '</div>');
            });
    }

    function text(key, fallback) {
        var value = t(key);
        return value === key ? fallback : value;
    }

    function remainingTtl(item, nowMs) {
        if (item.ttlKnown !== true) return text('memory.ttl_unknown', '未知');
        var ttl = Number(item.ttl);
        if (ttl < 0) return text('memory.ttl_permanent', '永久');
        var expiresAt = Number(item.expiresAtEpochMs);
        if (!isFinite(expiresAt)) return text('memory.ttl_unknown', '未知');
        var seconds = Math.max(0, Math.ceil((expiresAt - nowMs) / 1000));
        if (seconds <= 0) return text('memory.ttl_expired', '已过期');
        var days = Math.floor(seconds / 86400);
        if (days > 0) return text('memory.ttl_days', '剩余 {n} 天').replace('{n}', days);
        var hours = Math.floor(seconds / 3600);
        if (hours > 0) return text('memory.ttl_hours', '剩余 {n} 小时').replace('{n}', hours);
        var minutes = Math.max(1, Math.ceil(seconds / 60));
        return text('memory.ttl_minutes', '剩余 {n} 分钟').replace('{n}', minutes);
    }

    /* 重要度（importance 1-10）→ 易懂分级文案 */
    function impInfo(imp) {
        var v = Number(imp) || 0;
        if (v >= 10) return { cls: 'imp-critical', label: t('memory.imp_critical') };
        if (v >= 7) return { cls: 'imp-high', label: t('memory.imp_high') };
        if (v >= 4) return { cls: 'imp-mid', label: t('memory.imp_mid') };
        return { cls: 'imp-low', label: t('memory.imp_low') };
    }

    function renderList(items, total, hasMore) {
        var metaText = t('memory.count').replace('{n}', total);
        if (hasMore) metaText += ' · ' + items.length + '/' + total;
        $meta.text(metaText);

        if (!items.length) {
            $list.html('<div class="memory-empty">' + escHtml(t('memory.empty')) + '</div>');
            return;
        }

        var html = '';
        var nowMs = Date.now();
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var info = impInfo(it.importance);
            var tip = t('memory.imp_tip').replace('{n}', String(Math.round(Number(it.importance) || 0)));
            html += '<div class="memory-item">' +
                '<div class="memory-item-head">' +
                    '<span class="memory-item-title">' + escHtml(it.title || text('memory.untitled', '未命名记忆')) + '</span>' +
                    '<span class="memory-item-imp ' + info.cls + '" title="' + escHtml(tip) + '">' + escHtml(info.label) + '</span>' +
                    '<span class="memory-item-ttl">' + escHtml(remainingTtl(it, nowMs)) + '</span>' +
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
        var snapshot = scopeSnapshot();

        var doDelete = function () {
            if (!isCurrentSnapshot(snapshot) || !canOperateSnapshot(snapshot)) return;
            var headers = sessionHeaders(snapshot.cwd);
            headers['Content-Type'] = 'application/json';
            fetch('/web/chat/memory/delete', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ scope: snapshot.scope, key: key })
            })
                .then(parseResult)
                .then(function () {
                    if (isCurrentSnapshot(snapshot)) loadMemories();
                })
                .catch(function (error) {
                    window.layAlert(t('memory.delete_failed')
                        + (error && error.message ? '：' + error.message : ''));
                });
        };
        /* 与对话删除一致：统一 layConfirm 弹框（自动跟随主题），layer 缺失时兜底原生 confirm */
        if (typeof window.layConfirm === 'function') window.layConfirm(t('memory.delete_confirm'), doDelete);
        else if (window.confirm(t('memory.delete_confirm'))) doDelete();
    });

    /* ===================== 当前作用域清空 ===================== */

    $clearBtn.on('click', function () {
        var snapshot = scopeSnapshot();
        var selected = snapshot.scope === SCOPE_WORKSPACE ? selectedProject() : null;
        if (snapshot.scope === SCOPE_WORKSPACE && (!snapshot.cwd || !selected)) return;
        var scopeLabel = snapshot.scope === SCOPE_WORKSPACE
            ? ((selected && selected.name ? selected.name + ' — ' : '') + snapshot.cwd)
            : text('memory.tab_global', '全局');
        if (snapshot.scope === SCOPE_WORKSPACE && currentAliased) {
            window.layAlert(text('memory.workspace_aliased', '记忆隔离已关闭：工作空间记忆实际为全局共享记忆。请切换到“全局”并明确确认清空。'));
            return;
        }
        var doClear = function () {
            if (!isCurrentSnapshot(snapshot) || !canOperateSnapshot(snapshot)) return;
            var headers = sessionHeaders(snapshot.cwd);
            headers['Content-Type'] = 'application/json';
            $clearBtn.prop('disabled', true);
            fetch('/web/chat/memory/clear', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ scope: snapshot.scope })
            }).then(parseResult)
                .then(function () {
                    if (isCurrentSnapshot(snapshot)) loadMemories();
                }).catch(function (error) {
                    var message = error && error.message ? error.message : '';
                    if (message.indexOf('WORKSPACE_MEMORY_ALIASED_TO_GLOBAL') >= 0) {
                        window.layAlert(text('memory.workspace_aliased', '记忆隔离已关闭：工作空间记忆实际为全局共享记忆。请切换到“全局”并明确确认清空。'));
                    } else {
                        window.layAlert(text('memory.clear_failed', '清空失败') + (message ? '：' + message : ''));
                    }
                }).finally(function () { $clearBtn.prop('disabled', false); });
        };
        var message = text('memory.clear_confirm', '确定清空“{scope}”中的全部记忆？此操作无法恢复。')
            .replace('{scope}', scopeLabel);
        if (typeof window.layConfirm === 'function') window.layConfirm(message, doClear);
        else if (window.confirm(message)) doClear();
    });

    /* ===================== tab / 项目切换 / 刷新 / 入口绑定 ===================== */

    $view.on('click', '.memory-view-tab', function () {
        var scope = $(this).attr('data-scope');
        if (!scope || scope === currentScope) return;
        currentScope = scope;
        $view.find('.memory-view-tab').removeClass('active');
        $(this).addClass('active');
        renderProjectSelector();
        if (currentScope === SCOPE_WORKSPACE) loadWorkspaceMemoriesWhenReady();
        else loadMemories();
    });

    $projectCurrent.on('click', function (event) {
        event.stopPropagation();
        if (currentScope !== SCOPE_WORKSPACE) return;
        $projectSelector.toggleClass('open');
        $projectCurrent.attr('aria-expanded', $projectSelector.hasClass('open') ? 'true' : 'false');
    });

    $projectDropdown.on('click', '.memory-project-option', function (event) {
        event.stopPropagation();
        var path = $(this).attr('data-path') || '';
        var allowed = false;
        for (var i = 0; !allowed && i < memoryProjects.length; i++) {
            allowed = pathKey(memoryProjects[i] && memoryProjects[i].path) === pathKey(path);
        }
        if (!allowed || pathKey(path) === pathKey(memorySelectedCwd)) {
            $projectSelector.removeClass('open');
            renderProjectSelector();
            return;
        }
        memorySelectedCwd = path;
        $projectSelector.removeClass('open');
        renderProjectSelector();
        loadMemories();
    });

    $(document).on('click', function () {
        if (!$projectSelector.hasClass('open')) return;
        $projectSelector.removeClass('open');
        $projectCurrent.attr('aria-expanded', 'false');
    });

    $('#memoryViewRefreshBtn').on('click', function () {
        loadMemoryProjects();
        if (currentScope !== SCOPE_WORKSPACE) loadMemories();
    });

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
    document.addEventListener('i18n:localeChanged', function () {
        renderProjectSelector();
        if (lastListData && lastListSnapshot && isCurrentSnapshot(lastListSnapshot)) {
            renderList(lastListData.items || [], lastListData.total || 0, lastListData.hasMore === true);
        }
    });
    window.GourdMemoryView = { remainingTtl: remainingTtl };
})();
