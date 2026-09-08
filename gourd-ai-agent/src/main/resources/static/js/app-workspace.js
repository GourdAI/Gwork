/* app-workspace.js — Chat 模式工作空间选择器。
   会话按所属根隔离存储（与 code 模式统一）：所选工作空间根写入 window.currentChatWorkspace，
   全链路（发送/todos/memory/queue）经 getSessionCwd() 自动带 X-Session-Cwd；
   '' 表示不选工作空间 = 全局对话（/web/chat/meta 返回的 workspace，即安装目录全局区）。
   选择器仅欢迎页一个实例（进入对话后不再显示，切换工作空间=回欢迎页开新会话）；
   状态持久化 localStorage；侧栏历史由 app-history 的全局/项目视图切换控制。 */
(function () {
    var LS_CHAT_WS = 'gourdai-chat-workspace';

    /* 解析期同步恢复选择（localStorage 同步可读），保证 app-history 启动加载会话列表时即带上正确 root */
    try {
        window.currentChatWorkspace = localStorage.getItem(LS_CHAT_WS) || '';
    } catch (e) { window.currentChatWorkspace = window.currentChatWorkspace || ''; }

    function esc(s) {
        var d = document.createElement('div');
        d.textContent = (s == null ? '' : String(s));
        return d.innerHTML.replace(/"/g, '&quot;');
    }

    function meta() { return window.__appMeta || {}; }
    function defaultWorkspace() { return meta().workspace || ''; }
    function trimTrail(p) { return (p || '').replace(/[\\\/]+$/, ''); }

    /* 后端回填的 projectRoot 归一为选择态（全局区路径 → ''） */
    function toSelection(path) {
        var p = trimTrail((path || '').trim());
        var def = trimTrail(defaultWorkspace());
        if (!p) return '';
        if (def && p.toLowerCase() === def.toLowerCase()) return '';
        return p;
    }

    function persist() {
        try {
            if (window.currentChatWorkspace) localStorage.setItem(LS_CHAT_WS, window.currentChatWorkspace);
            else localStorage.removeItem(LS_CHAT_WS);
        } catch (e) {}
    }

    function baseName(p) {
        var t = trimTrail(p);
        var i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
        return i >= 0 ? t.substring(i + 1) : t;
    }

    function displayName() {
        /* 不选工作空间 = 全局（默认）：按钮仅提示「选择项目」，不展示全局信息 */
        if (!window.currentChatWorkspace) return GourdI18n.t('code.select_project');
        return baseName(window.currentChatWorkspace);
    }

    function renderSelectors() {
        var name = displayName();
        var title = window.currentChatWorkspace || '';
        var els = document.querySelectorAll('.workspace-selector-name');
        for (var i = 0; i < els.length; i++) {
            els[i].textContent = name;
            els[i].title = title;
            var root = els[i].closest('.workspace-selector');
            if (root) root.classList.toggle('ws-has-selection', !!window.currentChatWorkspace);
        }
    }

    function closeAll() {
        var sels = document.querySelectorAll('.workspace-selector.open');
        for (var i = 0; i < sels.length; i++) sels[i].classList.remove('open');
    }

    function renderDropdown(dd) {
        dd.innerHTML = '<div class="project-dropdown-empty">' + esc(GourdI18n.t('app.loading')) + '</div>';
        $.get('/web/chat/projects', function (resp) {
            var list = (resp && resp.data) ? resp.data : [];
            var def = defaultWorkspace();
            var defKey = trimTrail(def).toLowerCase();
            var cur = window.currentChatWorkspace;
            var html = '';
            // 全局（默认工作区）不是可选项：不选即全局，列表不再展示该项
            for (var i = 0; i < list.length; i++) {
                var p = list[i];
                if (defKey && trimTrail(p.path).toLowerCase() === defKey) continue;
                html += '<div class="project-dropdown-item' + (p.path === cur ? ' active' : '') + '" data-path="' + esc(p.path) + '">'
                    + '<div class="project-dropdown-item-info">'
                    + '<div class="project-dropdown-item-name">' + esc(p.name) + '</div>'
                    + '<div class="project-dropdown-item-path">' + esc(p.path) + '</div>'
                    + '</div>'
                    + '<button class="project-dropdown-item-del" title="' + esc(GourdI18n.t('code.remove_no_delete')) + '" data-path="' + esc(p.path) + '">'
                    + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
                    + '</button>'
                    + '</div>';
            }
            html += '<div class="project-dropdown-add workspace-add-btn">'
                + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
                + esc(GourdI18n.t('code.open_folder')) + '</div>';
            dd.innerHTML = html;
        }).fail(function () {
            dd.innerHTML = '<div class="project-dropdown-empty">' + esc(GourdI18n.t('code.no_projects')) + '</div>';
        });
    }

    /* 切换 chat 工作空间。silent=true 仅同步状态与 UI（恢复历史会话时用），
       否则回欢迎页开新会话 + 重载侧栏列表（仿 code 模式 selectProject 语义）。 */
    function selectChatWorkspace(path, silent) {
        var sel = toSelection(path);
        closeAll();
        if (sel !== window.currentChatWorkspace) {
            var previous = window.currentChatWorkspace;
            window.currentChatWorkspace = sel;
            persist();
            renderSelectors();
            document.dispatchEvent(new CustomEvent('workspace:changed', {
                detail: { mode: 'chat', cwd: sel, previousCwd: previous }
            }));
            if (sel && typeof window.notifyWatchRoot === 'function') window.notifyWatchRoot(sel);
            if (!silent) {
                if (typeof switchToWelcomeMode === 'function') switchToWelcomeMode();
                // 切换工作空间后，历史视图重置为默认（选了工作空间→项目，未选→全局）
                if (typeof window.setHistoryScope === 'function') {
                    window.setHistoryScope(sel ? 'project' : 'global', false);
                }
                if (typeof loadSessionHistory === 'function') loadSessionHistory();
            }
        } else {
            renderSelectors();
        }
    }

    /* 供 app-history 切换历史会话时恢复所属工作空间（默认 silent） */
    window.applyChatWorkspace = function (path, silent) {
        selectChatWorkspace(path, silent !== false);
    };

    /* 事件委托（欢迎页单实例） */
    document.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.closest) return;

        var clr = t.closest('.workspace-selector-clear');
        if (clr) {
            e.stopPropagation();
            selectChatWorkspace('');
            return;
        }

        var cur = t.closest('.workspace-selector-current');
        if (cur) {
            var selEl = cur.parentNode;
            var wasOpen = selEl.classList.contains('open');
            closeAll();
            if (!wasOpen) {
                selEl.classList.add('open');
                renderDropdown(selEl.querySelector('.workspace-dropdown'));
            }
            e.stopPropagation();
            return;
        }

        var del = t.closest('.workspace-dropdown .project-dropdown-item-del');
        if (del) {
            e.stopPropagation();
            var delPath = del.getAttribute('data-path');
            if (delPath) {
                $.ajax({
                    url: '/web/chat/projects/remove', method: 'POST', contentType: 'application/json',
                    data: JSON.stringify({ path: delPath })
                }).always(function () {
                    var dd = del.closest('.workspace-dropdown');
                    if (dd) renderDropdown(dd);
                    if (window.currentChatWorkspace === delPath) selectChatWorkspace('', true);
                });
            }
            return;
        }

        var add = t.closest('.workspace-dropdown .workspace-add-btn');
        if (add) {
            closeAll();
            if (typeof window.openDirPicker === 'function') {
                window.openDirPicker(function (picked) {
                    $.ajax({
                        url: '/web/chat/projects/add', method: 'POST', contentType: 'application/json',
                        data: JSON.stringify({ path: picked })
                    }).done(function () {
                        selectChatWorkspace(picked);
                    }).fail(function () {
                        if (typeof showToast === 'function') showToast(GourdI18n.t('code.dir_access_failed'), 'error');
                    });
                });
            }
            return;
        }

        var item = t.closest('.workspace-dropdown .project-dropdown-item');
        if (item) {
            selectChatWorkspace(item.getAttribute('data-path') || '');
            return;
        }

        if (!t.closest('.workspace-selector')) closeAll();
    });

    function boot() {
        // meta 就绪后把选择态归一（默认工作区路径 → ''）并渲染
        window.currentChatWorkspace = toSelection(window.currentChatWorkspace);
        persist();
        renderSelectors();
        if (window.currentChatWorkspace && typeof window.notifyWatchRoot === 'function') {
            window.notifyWatchRoot(window.currentChatWorkspace);
        }
    }

    window.__whenBackendReady(function () {
        if (window.__appMeta) { boot(); return; }
        fetch('/web/chat/meta').then(function (r) { return r.json(); }).then(function (res) {
            window.__appMeta = (res && res.data) ? res.data : (res || {});
            boot();
        }).catch(function () { boot(); });
    });

    /* 语言切换后重渲染选择器文案 */
    document.addEventListener('i18n:localeChanged', function () { renderSelectors(); });
})();
