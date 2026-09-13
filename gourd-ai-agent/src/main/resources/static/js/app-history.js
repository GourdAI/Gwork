/* ===== app-history.js ===== */
/* 数据管理：会话历史 + 命令系统 + 输入历史 + 模型选择 */
/* 依赖：app-base.js */

/* ===== History ===== */

/* 记住“当前活动会话”，刷新或下次打开时自动恢复 */
var ACTIVE_SESSION_KEY = 'gourdai-active-session';
function rememberActiveSession(sessionId) {
    try { if (sessionId) localStorage.setItem(ACTIVE_SESSION_KEY, sessionId); } catch (e) {}
}
function forgetActiveSession() {
    try { localStorage.removeItem(ACTIVE_SESSION_KEY); } catch (e) {}
}
window.rememberActiveSession = rememberActiveSession;
window.forgetActiveSession = forgetActiveSession;

/* 历史列表加载完成后，尝试恢复上次的活动会话 */
function restoreActiveSession() {
    var saved = null;
    try { saved = localStorage.getItem(ACTIVE_SESSION_KEY); } catch (e) {}
    if (!saved) return;
    for (var i = 0; i < chatHistory.length; i++) {
        if (chatHistory[i].sessionId === saved) {
            selectSession(i);
            return;
        }
    }
    /* 保存的会话不在当前视图列表（可能在另一视图/所属根下，如全局会话正显示项目视图）：
       保留记录不删，切换全局/项目视图或工作空间后列表重载时会再次尝试恢复。 */
}

/* ===== 历史会话视图（tab：项目 / 对话）===== */
/* 统一 work- 会话按有无所属根分两类：全局会话（安装目录，无根）/ 项目会话（项目根下）。
   侧栏提供两个 tab：
   - 项目 tab（'project'）：已登记项目为文件夹节点嵌套各自会话；绑定该项目的定时任务嵌套在对应项目节点下。
   - 对话 tab（'global'）：仅全局会话（非工作空间下），按时间倒序平铺；未绑定项目的定时任务追加在列表尾部。
   手动切换 tab 持久化；项目树不依赖工作空间选择。code 模式恒为项目视图（当前项目根平铺），tab 行隐藏。 */
var LS_HISTORY_SCOPE = 'gourdai-history-scope';
try { window.chatHistoryScope = localStorage.getItem(LS_HISTORY_SCOPE) || ''; } catch (e) { window.chatHistoryScope = ''; }

/* 默认视图恒为项目 tab（项目树不依赖工作空间选择，始终可渲染） */
function defaultHistoryScope() {
    return 'project';
}
/* 有效视图：code 恒项目；chat 取持久化值，缺省项目 */
function effectiveHistoryScope() {
    if (window.appMode === 'code') return 'project';
    return window.chatHistoryScope || defaultHistoryScope();
}
/* 切换视图（reload=false 供工作空间切换后由调用方统一重载列表） */
function setHistoryScope(scope, reload) {
    window.chatHistoryScope = scope;
    try { localStorage.setItem(LS_HISTORY_SCOPE, scope); } catch (e) {}
    updateHistoryScopeBar();
    if (reload !== false) loadSessionHistory();
}
window.setHistoryScope = setHistoryScope;

function historyScopeBaseName(p) {
    var t = (p || '').replace(/[\\\/]+$/, '');
    var i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
    return i >= 0 ? t.substring(i + 1) : t;
}
/* 渲染 tab 行：按有效视图切换两个 tab 的 .active */
function updateHistoryScopeBar() {
    var gBtn = document.getElementById('scopeGlobalBtn');
    var pBtn = document.getElementById('scopeProjectBtn');
    var scope = effectiveHistoryScope();
    if (gBtn) gBtn.classList.toggle('active', scope === 'global');
    if (pBtn) pBtn.classList.toggle('active', scope === 'project');
}
/* tab 切换委托（新 tab 按钮保留 data-scope，选择器随类名更新） */
$(document).on('click', '#historyScopeBar .history-tab', function () {
    var scope = this.getAttribute('data-scope');
    if (scope && scope !== effectiveHistoryScope()) setHistoryScope(scope);
});

/* 侧栏聚合数据（chat 模式）：{ projects: [{name,path,sessions:[entry]}], global: [entry] }。
   entry = { label, sessionId, projectRoot, time }；后端各列表已按 time 倒序。 */
var _sidebarData = null;
/* 单调递增的请求令牌：页面启动与 tab/工作空间切换都可能发请求，旧请求后到会覆盖新列表。用令牌丢弃过期响应。 */
var _sidebarReqToken = 0;
/* 项目节点展开状态：{ path: bool }；首次加载 undefined 时有会话默认展开 */
var _projExpanded = {};
/* code 模式单根加载令牌（防竞态，原逻辑） */
var _sessionsReqToken = 0;
/* 侧栏首屏加载失败标记：projects 接口失败时置位，buildSidebar 在当前视图无数据时渲染可点击重试提示；
   加载成功后清零。避免首屏失败后项目块空白无反馈、只能靠切 tab 自愈。 */
var _sidebarLoadFailed = false;


/* 后端会话列表 → 本地条目（projectRoot 由后端回填，切换历史会话时据此恢复所属根，
   保证发送时 X-Session-Cwd 指向该会话真实目录） */
function toSessionEntries(list) {
    var arr = [];
    for (var i = 0; i < (list || []).length; i++) {
        arr.push({ label: list[i].label, sessionId: list[i].sessionId, projectRoot: list[i].projectRoot || '', time: list[i].time || 0, loop: !!list[i].loop });
    }
    return arr;
}

/* 汇总完成：写入 _sidebarData，重建平铺（chatHistory），再尝试恢复活动会话 */
function finalizeSidebar(myToken, projects, globalSessions) {
    if (myToken !== _sidebarReqToken) return;
    for (var j = 0; j < projects.length; j++) {
        var p = projects[j].path;
        if (_projExpanded[p] === undefined) _projExpanded[p] = projects[j].sessions.length > 0;
    }
    _sidebarData = { projects: projects, global: globalSessions };
    chatHistory = []; // 由渲染重建
    buildSidebar();   // 同步重建 chatHistory/currentChatIndex，供下方 restoreActiveSession 遍历
    updateHistoryUI();
    updateHistoryScopeBar();
    restoreActiveSession();
}

function loadSessionHistory() {
    if (window.appMode === 'code') {
        // code 模式保持原单根逻辑：扫当前项目根
        var root = window.currentProjectRoot || '';
        var q = root ? ('?root=' + encodeURIComponent(root)) : '';
        var myToken = ++_sessionsReqToken;
        $.get('/web/chat/sessions' + q, function(resp) {
            try {
                // 已有更新的加载请求发出 → 本次响应过期，丢弃
                if (myToken !== _sessionsReqToken) return;
                chatHistory = toSessionEntries(resp.data);
                updateHistoryUI();
                updateHistoryScopeBar();
                restoreActiveSession();
            } catch (e) {}
        });
        return;
    }
    // chat 模式：先拉已登记项目列表，再对 global（不带 root）与每个 project.path 并行发会话请求，
    // 全部完成后汇总（任一路失败记为空数组，不阻塞其它路）。
    var myToken2 = ++_sidebarReqToken;
    $.get('/web/chat/projects', function (resp) {
        if (myToken2 !== _sidebarReqToken) return;
        _sidebarLoadFailed = false;
        var plist = (resp && resp.data) ? resp.data : [];
        var projects = [];
        for (var i = 0; i < plist.length; i++) {
            projects.push({ name: plist[i].name || historyScopeBaseName(plist[i].path || ''), path: plist[i].path || '', sessions: [] });
        }
        var globalSessions = [];
        var pending = 1 + projects.length; // global 一路 + 每项目一路
        var onOneDone = function () {
            if (--pending === 0) finalizeSidebar(myToken2, projects, globalSessions);
        };
        // 全局会话（不带 root，后端扫安装目录）
        $.get('/web/chat/sessions', function (resp) {
            if (myToken2 === _sidebarReqToken) globalSessions = toSessionEntries(resp && resp.data);
            onOneDone();
        }).fail(onOneDone);
        for (var pi = 0; pi < projects.length; pi++) {
            (function (proj) {
                $.get('/web/chat/sessions?root=' + encodeURIComponent(proj.path), function (resp) {
                    if (myToken2 === _sidebarReqToken) proj.sessions = toSessionEntries(resp && resp.data);
                    onOneDone();
                }).fail(onOneDone);
            })(projects[pi]);
        }
    }).fail(function () {
        // 项目列表获取失败：降级为仅渲染全局会话
        if (myToken2 !== _sidebarReqToken) return;
        // 标记加载失败：当前视图完全无数据时由 buildSidebar 渲染「点击重试」提示，
        // 否则默认「项目」tab 只由 projects 构建平铺，失败后是纯空白且无恢复路径
        _sidebarLoadFailed = true;
        $.get('/web/chat/sessions', function (resp) {
            finalizeSidebar(myToken2, [], toSessionEntries(resp && resp.data));
        }).fail(function () {
            finalizeSidebar(myToken2, [], []);
        });
    });
}

function saveChatToHistory(firstMsg) {
    ensureChatInHistory(SESSION_ID, firstMsg, true);
    rememberActiveSession(SESSION_ID);
}

/* chat 聚合视图的侧栏条目助手：按 sessionId / 所属根定位条目与所属项目 */
function findSidebarEntry(sessionId) {
    if (!_sidebarData) return null;
    var g = _sidebarData.global || [];
    for (var i = 0; i < g.length; i++) {
        if (g[i].sessionId === sessionId) return g[i];
    }
    var ps = _sidebarData.projects || [];
    for (var p = 0; p < ps.length; p++) {
        var ss = ps[p].sessions || [];
        for (var k = 0; k < ss.length; k++) {
            if (ss[k].sessionId === sessionId) return ss[k];
        }
    }
    return null;
}
function findSidebarProject(path) {
    if (!_sidebarData || !path) return null;
    var ps = _sidebarData.projects || [];
    for (var i = 0; i < ps.length; i++) {
        if (ps[i].path === path) return ps[i];
    }
    return null;
}
function removeSidebarEntry(sessionId) {
    if (!_sidebarData) return;
    var g = _sidebarData.global || [];
    for (var i = g.length - 1; i >= 0; i--) {
        if (g[i].sessionId === sessionId) g.splice(i, 1);
    }
    var ps = _sidebarData.projects || [];
    for (var p = 0; p < ps.length; p++) {
        var ss = ps[p].sessions || [];
        for (var k = ss.length - 1; k >= 0; k--) {
            if (ss[k].sessionId === sessionId) ss.splice(k, 1);
        }
    }
}

function ensureChatInHistory(sessionId, firstMsg, makeCurrent, opts) {
    if (!sessionId) return;
    var label = (firstMsg || GourdI18n.t('history.new_chat')).toString();
    label = label.length > 30 ? label.substring(0, 30) + '...' : label;
    var shouldMakeCurrent = (makeCurrent !== false) && (sessionId === SESSION_ID || sessionId === activeSessionId || currentChatIndex === -1);
    // opts: {root, silent} —— 自动化任务（Loop 定时任务）执行记录登记专用：
    // root 显式指定所属工作空间（不挂到用户当前所选下）；silent 不做视图联动（不切 tab、不抢焦点）
    var optRoot = (opts && typeof opts.root === 'string') ? opts.root : null;
    var silent = !!(opts && opts.silent);
    // loop：定时任务执行记录标记，侧栏条目名前渲染时钟小图标
    var optLoop = !!(opts && opts.loop);

    if (window.appMode !== 'code' && _sidebarData) {
        // chat 聚合视图：直接登记进 _sidebarData（不再 unshift chatHistory）；渲染会重建平铺
        // 并按 sessionId 修正 currentChatIndex，shouldMakeCurrent 的语义（SESSION_ID/activeSession）随之天然满足。
        var exist = findSidebarEntry(sessionId);
        if (exist) {
            exist.label = label;
            exist.time = Date.now();
            if (optLoop) exist.loop = true;
        } else {
            // 新会话所属根 = 当前所选工作空间；匹配已登记项目则归入该项目，否则归全局
            // 自动化任务经 opts.root 传入任务自身工作空间，保证执行记录落在对应项目/对话区
            var pr = (optRoot != null) ? optRoot : (window.currentChatWorkspace || '');
            var entry = { label: label, sessionId: sessionId, projectRoot: pr, time: Date.now() };
            if (optLoop) entry.loop = true;
            var owner = findSidebarProject(pr);
            if (owner) {
                owner.sessions.unshift(entry);
            } else {
                _sidebarData.global.unshift(entry);
                // 新会话归全局而当前停在项目 tab：联动切「对话」tab 保证新建会话可见（与欢迎页视图联动同一语义）；
                // silent 登记（自动化任务执行记录）不参与联动，避免切走用户当前视图
                if (!silent && effectiveHistoryScope() === 'project') setHistoryScope('global', false);
            }
        }
        updateHistoryUI();
        return;
    }

    // code 模式（或聚合数据未到达时）保持原平铺登记逻辑；
    // 自动化任务执行记录（带显式 root）仅当所属根即当前项目时登记，避免跨项目污染侧栏
    if (optRoot != null) {
        var trimTrailSep = function (p) { return String(p || '').replace(/[\\/]+$/, ''); };
        if (trimTrailSep(optRoot) !== trimTrailSep(window.currentProjectRoot)) return;
    }
    for (var i = 0; i < chatHistory.length; i++) {
        if (chatHistory[i].sessionId === sessionId) {
            if (shouldMakeCurrent) currentChatIndex = i;
            updateHistoryUI();
            return;
        }
    }
    // 新会话在本地登记：其所属根即当前所选（code=项目 / chat=工作空间，新会话正是在其下创建的）；
    // 自动化任务带显式 root 时以其为准。记入 chatHistory，使后续切走再切回时也能恢复出正确的工作空间上下文。
    var pr2 = (optRoot != null) ? optRoot
            : ((window.appMode === 'code') ? (window.currentProjectRoot || '') : (window.currentChatWorkspace || ''));
    var entry2 = { label: label, sessionId: sessionId, projectRoot: pr2 };
    if (optLoop) entry2.loop = true;
    chatHistory.unshift(entry2);
    if (chatHistory.length > 50) chatHistory.pop();
    if (shouldMakeCurrent) {
        currentChatIndex = 0;
    } else if (currentChatIndex >= 0) {
        currentChatIndex++;
        if (currentChatIndex >= chatHistory.length) currentChatIndex = chatHistory.length - 1;
    }
    updateHistoryUI();
}

/* 会话条目所属的工作空间根（rename/delete/replay 等定位用）。
   code 模式取当前所选项目；chat 模式取条目自身的 projectRoot：
   '' = 全局会话（后端对全局扫描不回填 projectRoot，本地登记也如此），语义唯一、不可回退——
   若回退到当前所选工作空间，会在选中其它工作空间时把全局会话删/改名定位到错误根
   （后端删错目录、真目录残留 → 会话“删除后复活”；改名则 404）。 */
function sessionRootOf(entry) {
    if (window.appMode === 'code') return window.currentProjectRoot || '';
    return (entry && entry.projectRoot) || '';
}
function sessionRootQ(entry) {
    var r = sessionRootOf(entry);
    return r ? '&root=' + encodeURIComponent(r) : '';
}

/* ===== Chat 侧栏条目渲染（tab 视图：项目树 / 对话平铺；code 模式平铺）===== */

function escAttr(s) {
    return escapeHtml(s == null ? '' : String(s)).replace(/"/g, '&quot;');
}

/* 相对时间（会话行右侧小字）：1 分钟内「刚刚」，其后按 分/时/天 粒度。
   注意：GourdI18n.t 仅在 params 为数组/对象时替换 {0} 占位符，故传数组。 */
function formatRelTime(ts) {
    if (!ts) return GourdI18n.t('app.sidebar.time_now');
    var m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return GourdI18n.t('app.sidebar.time_now');
    if (m < 60) return GourdI18n.t('app.sidebar.time_m', [m]);
    var h = Math.floor(m / 60);
    if (h < 24) return GourdI18n.t('app.sidebar.time_h', [h]);
    return GourdI18n.t('app.sidebar.time_d', [Math.floor(h / 24)]);
}

function sidebarItemHtml(i) {
    var sess = sessionMap[chatHistory[i].sessionId];
    var streaming = sess && sess.isStreaming;
    var cls = 'sidebar-item' + (i === currentChatIndex ? ' active' : '') + (streaming ? ' streaming' : '');

    var html = '<div class="' + cls + '" data-idx="' + i + '">';
    // 定时任务执行会话：条目名前时钟小图标（与旧任务行同款 feather clock）
    if (chatHistory[i].loop) {
        html += '<span class="sidebar-item-loop" title="' + escAttr(GourdI18n.t('app.sidebar.loop_mark')) + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>';
    }
    html += '<span class="sidebar-item-label">' + escapeHtml(chatHistory[i].label) + '</span>';
    // 任务进度 badge
    var todoInfo = window.sessionTodoMap && window.sessionTodoMap[chatHistory[i].sessionId];
    if (todoInfo && todoInfo.total > 0) {
        var doneClass = todoInfo.done === todoInfo.total ? ' done' : '';
        html += '<span class="sidebar-item-todo' + doneClass + '">' + todoInfo.done + '/' + todoInfo.total + '</span>';
    }
    if (streaming) {
        html += '<span class="sidebar-item-spinner" title="' + escAttr(GourdI18n.t('history.streaming')) + '"></span>';
    }
    // 相对时间小字（标签左、时间右）
    if (chatHistory[i].time) {
        html += '<span class="sidebar-item-time">' + formatRelTime(chatHistory[i].time) + '</span>';
    }
    // 右侧悬停操作组（重命名 / 删除）：与项目行 .proj-actions 同款悬浮规格，feather SVG 图标与项目行风格统一（样式见 app.css）
    html += '<span class="item-actions">'
        + '<button class="item-action-btn sidebar-item-rename" title="' + escAttr(GourdI18n.t('history.rename')) + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>'
        + '<button class="item-action-btn sidebar-item-del" title="' + escAttr(GourdI18n.t('history.delete_session')) + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
        + '</span>'
        + '</div>';
    return html;
}


/* 项目文件夹行：chevron + folder 图标 + 名称（点击切换展开，见列表点击委托）。
   右侧悬浮操作组 .proj-actions：新建任务 / 进入专注模式 / 从列表移除（样式见 app.css）。 */
function projNodeHtml(path, name, expanded) {
    return '<div class="proj-node' + (expanded ? ' expanded' : '') + '" data-proj="' + escAttr(path) + '" title="' + escAttr(path) + '">'
        + '<svg class="proj-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>'
        + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
        + '<span class="proj-name">' + escapeHtml(name || '') + '</span>'
        + '<span class="proj-actions">'
        + '<button class="proj-action-btn proj-new-chat" title="' + escAttr(GourdI18n.t('app.sidebar.new_task')) + '">'
        + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
        + '</button>'
        + '<button class="proj-action-btn proj-open-code" title="' + escAttr(GourdI18n.t('app.sidebar.open_in_code')) + '">'
        + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>'
        + '</button>'
        + '<button class="proj-action-btn proj-remove" title="' + escAttr(GourdI18n.t('app.sidebar.remove_project')) + '">'
        + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
        + '</button>'
        + '</span>'
        + '</div>';
}

/* Sidebar event delegation — single listener instead of per-item binding */
$(historyList).on('click', function(e) {
    var $target = $(e.target);
    // 侧栏加载失败提示：点击任意位置重试（重拉项目列表 + 会话）
    var $retryHint = $target.closest('.sidebar-load-failed-hint');
    if ($retryHint.length) {
        _sidebarLoadFailed = false;
        loadSessionHistory();
        return;
    }
    // 项目行「新建任务」图标：聊天工作空间切到该项目并回欢迎页开新会话（须置于 proj-node 分支之前，避免被展开/收起吸收）
    var $newChat = $target.closest('.proj-new-chat');
    if ($newChat.length) {
        var np = $newChat.closest('.proj-node').attr('data-proj');
        if (typeof window.startNewChatInWorkspace === 'function') window.startNewChatInWorkspace(np);
        return;
    }
    // 项目行「在代码模式中打开」图标：进入 code 模式并定位到该项目（须置于 proj-node 分支之前，避免被展开/收起吸收）
    var $openCode = $target.closest('.proj-open-code');
    if ($openCode.length) {
        var op = $openCode.closest('.proj-node').attr('data-proj');
        if (typeof window.openProjectInCodeMode === 'function') window.openProjectInCodeMode(op);
        return;
    }
    // 项目行「从列表移除」：仅解除登记，不删除磁盘目录（须置于 proj-node 分支之前）
    var $projDel = $target.closest('.proj-remove');
    if ($projDel.length) {
        var dp = $projDel.closest('.proj-node').attr('data-proj');
        if (typeof window.removeProjectFromList === 'function') window.removeProjectFromList(dp);
        return;
    }
    // 项目文件夹节点：切换展开/收起（置于 del/rename/item 分支之前）
    var $proj = $target.closest('.proj-node');
    if ($proj.length) {
        var p = $proj.attr('data-proj');
        _projExpanded[p] = !_projExpanded[p];
        updateHistoryUI();
        return;
    }
    var $delBtn = $target.closest('.sidebar-item-del');
    if ($delBtn.length) {
        e.stopPropagation();
        var idx = parseInt($delBtn.closest('.sidebar-item').attr('data-idx'));
        if (!isNaN(idx)) deleteSession(idx);
        return;
    }
    var $renameBtn = $target.closest('.sidebar-item-rename');
    if ($renameBtn.length) {
        e.stopPropagation();
        var idx = parseInt($renameBtn.closest('.sidebar-item').attr('data-idx'));
        if (!isNaN(idx)) startRename(idx);
        return;
    }
    var $item = $target.closest('.sidebar-item');
    if ($item.length) {
        var idx = parseInt($item.attr('data-idx'));
        if (!isNaN(idx)) selectSession(idx);
    }
});

/* 项目行「新建任务」：把聊天工作空间静默锚定到该项目（applyChatWorkspace silent 仅同步选择态/UI，
   不触发其内置重载），再按 newChatBtn 语义回欢迎页开新会话——switchToWelcomeMode 会生成新 sessionId
   并联动把历史视图切到「项目」（保证新会话可见）；同时展开该项目节点，首条消息发出后新会话直接可见。 */
window.startNewChatInWorkspace = function (path) {
    if (!path) return;
    if (typeof window.applyChatWorkspace === 'function') window.applyChatWorkspace(path, true);
    _projExpanded[path] = true;
    currentChatIndex = -1;
    if (typeof closeDiffViewer === 'function') closeDiffViewer();
    if (typeof switchToWelcomeMode === 'function') switchToWelcomeMode();
    updateHistoryUI();
};

var _updateHistoryUIPending = false;
function updateHistoryUI() {
    if (_updateHistoryUIPending) return;
    _updateHistoryUIPending = true;
    requestAnimationFrame(function() {
        _updateHistoryUIPending = false;
        var html = '';
        if (window.appMode !== 'code' && _sidebarData) {
            // chat 聚合视图：按 tab 渲染（项目树 / 对话平铺），内部重建 chatHistory/currentChatIndex
            html = buildSidebar();
        } else {
            // code 模式或聚合数据未到达：原平铺列表
            for (var i = 0; i < chatHistory.length; i++) html += sidebarItemHtml(i);
        }
        var $list = $(historyList);
        // 仅当 HTML 真正变化时才写入 DOM，避免无效重排
        if ($list.html() !== html) {
            $list.html(html);
            // 列表重建后按当前搜索关键字重新过滤，避免过滤态丢失
            if (typeof window.reapplySidebarFilter === 'function') window.reapplySidebarFilter();
        }
        // Code 模式：同步右栏会话下拉
        if (window.appMode === 'code' && typeof window.renderCodeSessions === 'function') {
            window.renderCodeSessions();
        }
    });
}

/* 侧栏条目排序：执行中的任务优先，其余按最近活动时间倒序；最后保持接口原顺序稳定。 */
function sortSidebarEntries(entries) {
    var decorated = (entries || []).map(function (entry, index) {
        var sess = (typeof sessionMap !== 'undefined' && sessionMap) ? sessionMap[entry.sessionId] : null;
        return { entry: entry, index: index, running: !!(sess && sess.isStreaming) };
    });
    decorated.sort(function (a, b) {
        if (a.running !== b.running) return a.running ? -1 : 1;
        var at = Number(a.entry.time) || 0;
        var bt = Number(b.entry.time) || 0;
        if (at !== bt) return bt - at;
        return a.index - b.index;
    });
    return decorated.map(function (item) { return item.entry; });
}

/* 构建 chat 聚合视图，返回 html 字符串。
   副作用：按渲染顺序重建 chatHistory 平铺并按 sessionId 修正 currentChatIndex——
   必须先于 HTML 生成完成，sidebarItemHtml 依赖 currentChatIndex 判定 active 样式
   （deleteSession/selectSession 等均依赖这两个全局量）。 */
function buildSidebar() {
    var flat = [];
    var scope = effectiveHistoryScope();
    var projects = (_sidebarData && _sidebarData.projects) || [];
    var global = (_sidebarData && _sidebarData.global) || [];
    var projMeta = [];
    var i, j;

    // —— 第一遍：按渲染顺序构建平铺（仅会话条目）——
    if (scope === 'project') {
        // 项目 tab：项目内执行中的任务置顶，其余按最近活动时间倒序
        for (i = 0; i < projects.length; i++) {
            var start = flat.length;
            var ss = sortSidebarEntries(projects[i].sessions || []);
            for (j = 0; j < ss.length; j++) flat.push(ss[j]);
            projMeta.push({ path: projects[i].path, name: projects[i].name, start: start, count: ss.length });
        }
    } else {
        // 对话 tab：仅全局会话（非工作空间下），执行中的任务置顶，其余按 time 倒序
        for (i = 0; i < global.length; i++) flat.push(global[i]);
        flat = sortSidebarEntries(flat);
    }

    // —— 重建全局量并修正激活下标 ——
    chatHistory = flat;
    var curId = activeSessionId || SESSION_ID;
    currentChatIndex = -1;
    for (i = 0; i < flat.length; i++) {
        if (flat[i].sessionId === curId) { currentChatIndex = i; break; }
    }

    // —— 第二遍：生成 HTML ——
    var html = '';
    if (scope === 'project') {
        html += '<div class="sidebar-section-title">' + GourdI18n.t('app.sidebar.section_projects') + '</div>';
        for (i = 0; i < projMeta.length; i++) {
            var pm = projMeta[i];
            var expanded = !!_projExpanded[pm.path];
            html += projNodeHtml(pm.path, pm.name, expanded);
            // 子列表始终入 DOM（收起态由 CSS 控制），保证搜索可过滤折叠项目的会话
            if (pm.count > 0) {
                html += '<div class="proj-sessions">';
                for (j = pm.start; j < pm.start + pm.count; j++) html += sidebarItemHtml(j);
                html += '</div>';
            }
        }
    } else {
        for (i = 0; i < flat.length; i++) html += sidebarItemHtml(i);
    }
    // 加载失败空态：当前视图一条条目都没有且此前记录过加载失败时，渲染可点击的重试提示。
    // 默认「项目」tab 的 flat 仅由 projects 构建，projects 接口失败时旧实现留下纯空白、
    // 全局会话兜底数据也不可见，用户无从自救（只能切 tab 碰运气）。
    if (_sidebarLoadFailed && flat.length === 0) {
        html += '<div class="sidebar-empty-hint sidebar-load-failed-hint" role="button" tabindex="0">'
            + escapeHtml(GourdI18n.t('app.sidebar.load_failed_retry'))
            + '</div>';
    }
    return html;
}

function startRename(idx) {
    var $item = $(historyList).find('.sidebar-item[data-idx="' + idx + '"]');
    if (!$item.length) return;
    var $labelEl = $item.find('.sidebar-item-label');
    if (!$labelEl.length) return;

    var currentLabel = chatHistory[idx].label.replace(/\.\.\.$/, '');
    var $input = $('<input>', {
        type: 'text',
        'class': 'sidebar-rename-input',
        maxlength: 50,
        val: currentLabel
    });

    $labelEl.hide();
    $item.find('.sidebar-item-rename').hide();
    $labelEl.before($input);
    $input[0].focus();
    $input[0].select();

    function finishRename() {
        var newLabel = $input.val().trim();
        if (newLabel && newLabel !== currentLabel) {
            newLabel = newLabel.length > 30 ? newLabel.substring(0, 30) + '...' : newLabel;
            chatHistory[idx].label = newLabel;

            $.post('/web/chat/sessions/rename', {
                sessionId: chatHistory[idx].sessionId,
                label: newLabel,
                root: sessionRootOf(chatHistory[idx])
            });
        }
        $input.remove();
        $labelEl.show();
        $item.find('.sidebar-item-rename').show();
        updateHistoryUI();
    }

    $input.on('blur', finishRename);
    $input.on('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); $input[0].blur(); }
        if (e.key === 'Escape') { $input.val(currentLabel); $input[0].blur(); }
    });
}

function deleteSession(idx) {
    var entry = chatHistory[idx];
    if (!entry) return;

    layConfirm(GourdI18n.t('history.confirm_delete') + ' "' + (entry.label || GourdI18n.t('history.untitled')) + '"', function() {
    var rootQ = sessionRootQ(entry);
    $.post('/web/chat/sessions/delete?sessionId=' + encodeURIComponent(entry.sessionId) + rootQ, function() {
        /* Clean up session state after server confirms */
        var sess = sessionMap[entry.sessionId];
        if (window.messageQueue) {
            try { window.messageQueue.clear(entry.sessionId); } catch (e) {}
        }
        if (typeof _queueProcessing !== 'undefined') _queueProcessing[entry.sessionId] = false;
        if (sess) {
            // 让在途 replay 回调/重试闭包立即失效，避免删除后继续请求并持有会话对象。
            sess._recoverGeneration = (sess._recoverGeneration || 0) + 1;
            sess._recovering = false;
            sess._gateBuffering = false;
            sess._gateBuffer = [];
            if (sess._recoverRetryTimer) { clearTimeout(sess._recoverRetryTimer); sess._recoverRetryTimer = null; }
            if (sess._resumePromise && typeof sess._resumePromise.abort === 'function') {
                try { sess._resumePromise.abort(); } catch (e) {}
            }
            sess._resumePromise = null;
            if (sess.eventSource) sess.eventSource.close();
            if (sess.silenceTimer) clearTimeout(sess.silenceTimer);
            if (typeof disposeSessionStreamMd === 'function') disposeSessionStreamMd(sess);
            // 释放未发送草稿及其附件大对象（删会话后草稿永无去处）
            if (typeof releaseSessionDraft === 'function') releaseSessionDraft(sess);
            $(sess.container).remove();
            delete sessionMap[entry.sessionId];
            // 删除会话时清理可能残留的加载按钮
            $(messagesWrap).find('.chat-load-more-wrapper').remove();
        }

        if (window.appMode !== 'code' && _sidebarData) {
            // chat 聚合视图：从 _sidebarData 移除，chatHistory/currentChatIndex 交由渲染重建修正
            removeSidebarEntry(entry.sessionId);
            if (entry.sessionId === SESSION_ID) {
                currentChatIndex = -1;
                switchToWelcomeMode();
            }
            updateHistoryUI();
            return;
        }

        chatHistory.splice(idx, 1);

        if (idx === currentChatIndex) {
            currentChatIndex = -1;
            if (window.appMode === 'code') {
                // Code 模式下欢迎页被隐藏，删除激活会话后需另选一个 tab，否则右栏空白
                if (chatHistory.length > 0) {
                    selectSession(Math.min(idx, chatHistory.length - 1)); // 激活顶上来的邻居
                } else if (typeof window.startFreshCodeSession === 'function') {
                    window.startFreshCodeSession();                        // 关掉最后一个 → 新建空会话
                }
            } else {
                switchToWelcomeMode();
            }
        } else if (idx < currentChatIndex) {
            currentChatIndex--;
        }

        updateHistoryUI();
    }).fail(function () {
        if (typeof showToast === 'function') {
            showToast(GourdI18n.t('history.delete_failed'), 'error');
        }
    });
    }); // layConfirm
}

function selectSession(idx) {
    if (idx === currentChatIndex && inChatMode) return;
    var entry = chatHistory[idx];
    if (!entry) return;

    // Code 模式：切换到历史会话时，把 window.currentProjectRoot 恢复为该会话的项目根。
    // 否则发送时 getSessionCwd() 仍返回上一个/空的项目根，X-Session-Cwd 错位，
    // 后端把该 code 会话重绑到错误目录（或回退安装目录）→ 会话无法定位 → 报网关错误。
    // 仅当该会话确有记录的项目根、且与当前不同才切换项目。
    var switchProject = (window.appMode === 'code' && entry.projectRoot && entry.projectRoot !== window.currentProjectRoot);
    // 跨项目切换会关闭全部打开文件；有未保存改动时先确认，用户取消则整体中止本次会话切换
    // （保持当前会话/项目/文件不变），避免静默丢弃编辑器里未保存的改动。
    if (switchProject && typeof window.confirmDiscardUnsavedIfAny === 'function'
            && !window.confirmDiscardUnsavedIfAny()) {
        return;
    }

    currentChatIndex = idx;
    SESSION_ID = entry.sessionId;
    rememberActiveSession(entry.sessionId);
    if (switchProject) {
        window.currentProjectRoot = entry.projectRoot;
        // 名称/下拉/文件树/Git/终端 + 持久化项目根，均由 syncProjectContext 统一处理（DRY，键名不在此重复）
        if (typeof window.syncProjectContext === 'function') window.syncProjectContext(entry.projectRoot);
    }
    // Chat 模式：切换到历史会话时恢复其所属工作空间（选择器 + X-Session-Cwd 随之），
    // 避免后续发送把消息绑到错误工作空间目录。silent 只同步状态/UI，不重载列表、不回欢迎页。
    if (window.appMode !== 'code' && typeof window.applyChatWorkspace === 'function') {
        window.applyChatWorkspace(entry.projectRoot || '', true);
    }
    // code 模式：中间 diff 与右栏对话正交，切换会话只换右栏，不能把中间 diff 顶掉重置；
    // 仅 chat 模式（diff 全屏覆盖）切会话才需先关掉 diff 露出对话。
    if (window.appMode !== 'code' && typeof closeDiffViewer === 'function') closeDiffViewer();
    if (!inChatMode) switchToChatMode();
    setActiveSession(entry.sessionId);
    // 记录会话所属工作空间根，供回放/删除/重命名/HITL 补发定位用
    if (sessionMap[entry.sessionId]) sessionMap[entry.sessionId].projectRoot = entry.projectRoot || '';
    updateHistoryUI();

    var sess = sessionMap[entry.sessionId];
    /* Only load from server if not streaming, not mid-replay, and container has no content
       (_gateBuffering = 等待回放响应期间，同样不得重复发起 loadMessages) */
    if (!sess.isStreaming && !sess._replaying && !sess._gateBuffering && sess.container.children.length === 0) {
        loadMessages(sess);
    } else {
        scrollToBottom(true);
        // 切回已有内容（或回放/缓冲中）的会话时，setActiveSession 清除了旧按钮，需重建。
        // 已加载完且不在回放/缓冲中：立即重建；回放/缓冲中：replayDone/drain 会处理，此处不调。
        if (!sess._replaying && !sess._gateBuffering) {
            if (typeof updateLoadMoreBtn === 'function') updateLoadMoreBtn(sess);
        }
    }
}

/* 按 sessionId 直接打开对话（用于不在侧栏列表中的会话，如定时任务运行时会话）：
   在当前 chatHistory 中则复用 selectSession；否则以临时条目直接打开（不插入侧栏列表）。
   root 为会话所属工作空间根：绑定项目的执行对话落盘在该项目根下，必须传入才能正确拉取历史；
   未绑定传 ''（全局区）。 */
function openSessionById(sessionId, label, root) {
    if (!sessionId) return false;
    for (var i = 0; i < chatHistory.length; i++) {
        if (chatHistory[i].sessionId === sessionId) { selectSession(i); return true; }
    }
    var r = (root == null) ? '' : root;
    currentChatIndex = -1;
    SESSION_ID = sessionId;
    // Chat 模式：恢复会话所属工作空间（绑定项目 → 该项目根；未绑定 → 全局），
    // 保证 replay/messages 拉取与后续发送的 X-Session-Cwd 指向真实所属目录（silent，不重载列表）
    if (window.appMode !== 'code' && typeof window.applyChatWorkspace === 'function') {
        window.applyChatWorkspace(r, true);
    }
    if (window.appMode !== 'code' && typeof closeDiffViewer === 'function') closeDiffViewer();
    if (!inChatMode) switchToChatMode();
    setActiveSession(sessionId);
    if (sessionMap[sessionId]) sessionMap[sessionId].projectRoot = r;
    updateHistoryUI();
    var sess = sessionMap[sessionId];
    if (!sess.isStreaming && !sess._replaying && !sess._gateBuffering && sess.container.children.length === 0) {
        loadMessages(sess);
    } else {
        scrollToBottom(true);
    }
    return true;
}
window.openSessionById = openSessionById;

/* tab 行三操作按钮：展开全部/收起全部、搜索（tab 行下方展开搜索条）、清空所有会话 */
$(document).on('click', '#expandAllBtn', function () {
    if (!_sidebarData) return;
    var ps = _sidebarData.projects || [];
    var anyCollapsed = false;
    for (var i = 0; i < ps.length; i++) {
        if (!_projExpanded[ps[i].path]) { anyCollapsed = true; break; }
    }
    // 存在未展开 → 全展开；否则全收起
    for (var j = 0; j < ps.length; j++) _projExpanded[ps[j].path] = anyCollapsed;
    updateHistoryUI();
});
$(document).on('click', '#clearAllBtn', function () {
    if (!_sidebarData) return;
    var entries = [];
    var i;
    var g = _sidebarData.global || [];
    for (i = 0; i < g.length; i++) entries.push(g[i]);
    var ps = _sidebarData.projects || [];
    for (i = 0; i < ps.length; i++) {
        var ss = ps[i].sessions || [];
        for (var k = 0; k < ss.length; k++) entries.push(ss[k]);
    }
    if (entries.length === 0) return;
    layConfirm(GourdI18n.t('app.sidebar.confirm_clear'), function () {
        var remaining = entries.length;
        var currentDeleted = false;
        var onOne = function (entry) {
            if (entry.sessionId === SESSION_ID) currentDeleted = true;
            if (--remaining === 0) {
                // 清理被清空会话的本地状态（对齐 deleteSession），避免残留孤儿容器
                for (var c = 0; c < entries.length; c++) {
                    var cs = sessionMap[entries[c].sessionId];
                    if (cs) {
                        if (cs.eventSource) cs.eventSource.close();
                        if (cs.silenceTimer) clearTimeout(cs.silenceTimer);
                        if (typeof disposeSessionStreamMd === 'function') disposeSessionStreamMd(cs);
                        if (typeof releaseSessionDraft === 'function') releaseSessionDraft(cs);
                        $(cs.container).remove();
                        delete sessionMap[entries[c].sessionId];
                    }
                }
                $(messagesWrap).find('.chat-load-more-wrapper').remove();
                _sidebarData = null;
                if (currentDeleted) {
                    currentChatIndex = -1;
                    switchToWelcomeMode();
                }
                loadSessionHistory();
            }
        };
        for (var d = 0; d < entries.length; d++) {
            (function (entry) {
                var rootQ = entry.projectRoot ? '&root=' + encodeURIComponent(entry.projectRoot) : '';
                $.post('/web/chat/sessions/delete?sessionId=' + encodeURIComponent(entry.sessionId) + rootQ)
                    .always(function () { onOne(entry); });
            })(entries[d]);
        }
    });
});

/* 历史分页配置：以「对话轮」为单位（一轮 = 一条用户消息 + 其后的全部 AI 过程）。
   不能用事件行数分页：text/reason 是 token 级增量，实测占全部事件的 ~92%
   （某会话 15383 行里 14190 行是增量，真实用户消息只有 11 条），
   按行分页时「一页 150 行」实际连半轮对话都不到，用户点一次几乎看不到新内容。 */
var REPLAY_PAGE_ROUNDS = 5;

function loadMessages(sess) {
    var rootQ = sessionRootQ(sess);
    // 发请求前即开启回放/实时互斥门禁：期间到达的同会话实时帧先入缓冲，
    // 回放完成后由 drainGateBuffer 统一去重喂入，避免「后端任务未结束 + UI 发起回放」
    // 竞态窗口内同一事件被两条管线各渲染一次。
    beginGateBuffer(sess);
    // 优先尝试「流式过程回放」：若该会话已落盘完整过程事件（工具卡片/思考/正文/trace），
    // 原样重建，历史里也能看到「做了哪些操作」。无回放数据时回退到旧的纯文本加载。
    // 初始只加载最后 REPLAY_PAGE_ROUNDS 轮对话。
    $.get('/web/chat/replay?sessionId=' + encodeURIComponent(sess.sessionId) + rootQ + '&rounds=' + REPLAY_PAGE_ROUNDS, function(rp) {
        var rpData = rp && rp.data;
        if (rpData && rpData.events && rpData.events.length > 0) {
            try {
                sess._replayHasMore = !!rpData.hasMore;
                sess._replayRemainingRounds = rpData.remainingRounds || 0;
                // 向上翻页游标：本页最早事件的 seq，下次只取比它更早的，不再重拉整段历史
                sess._replayFirstSeq = rpData.firstSeq || 0;
                // 快照覆盖集：标识「回放已渲染的事件」，供缓冲/迟到的实时帧去重（本轮 done 时清除）
                sess._replayCoverage = buildReplayCoverage(rpData.events);
                // 尾部快照中实际渲染的最大 eventSeq 才是稳定游标；不能使用 latestSeq（文件可能还有未渲染的新事件）。
                for (var rsi = 0; rsi < rpData.events.length; rsi++) {
                    var rseq = Number(rpData.events[rsi] && rpData.events[rsi].eventSeq || 0);
                    if (rseq) sess.lastEventSeq = Math.max(sess.lastEventSeq || 0, rseq);
                }
                replaySession(sess, rpData.events, false, !!rpData.running);
                return;
            } catch (e) {
                // 回放异常：清空可能的半成品，回退纯文本加载
                try { $(sess.container).html(''); } catch (e2) {}
            }
        }
        // replay 无事件（新对话）或异常：走纯文本加载路径（缓冲在 legacy 加载完成时统一排空）
        loadMessagesLegacy(sess, rootQ);
    }).fail(function() {
        loadMessagesLegacy(sess, rootQ);
    });
}

/**
 * 加载更早的历史消息（prepend 到现有内容之前）。
 * 按游标（_replayFirstSeq）向前取 REPLAY_PAGE_ROUNDS 轮，服务端只回传这一页，
 * 不会像旧实现那样每次从尾部重取「已加载 + 一页」导致越翻越慢。
 */
function loadMoreMessages(sess) {
    if (!sess || sess._replayLoadingMore || sess.sessionId !== activeSessionId) return;
    if (!sess._replayHasMore) return;
    sess._replayLoadingMore = true;
    // prepend 回放期间缓冲实时帧，避免混入临时容器（replayDone 后排空）
    beginGateBuffer(sess);
    // 翻页窗口内挂锁视口：任务执行中时，缓冲帧排空会触发 finishStream 的
    // scrollToBottom(true)，它会无视 userScrolledUp 把用户从旧内容处拽到底部。
    holdScrollAnchor();

    var rootQ = sessionRootQ(sess);
    var beforeQ = sess._replayFirstSeq ? '&beforeSeq=' + sess._replayFirstSeq : '';

    // 保留加载按钮并置为 loading：旧实现在发请求时就把按钮整个移除，响应返回前
    // 顶部凭空矮了一截（约 54px），内容当场上跳；现在交由 updateLoadMoreBtn 在
    // prepend 后、锚定修正前重建，高度变化能被锚点整体吸收。
    // 统一走 setLoadMoreBtnLoading 换环形 spinner：只加 .loading 类会让空闲态的
    // 上箭头图标原地旋转，观感是「箭头在转」而非加载。

    $.get('/web/chat/replay?sessionId=' + encodeURIComponent(sess.sessionId) + rootQ
            + '&rounds=' + REPLAY_PAGE_ROUNDS + beforeQ, function(rp) {
        // 请求返回后，如果用户已切换会话，丢弃结果 — 不污染新会话的滚动和 DOM
        if (sess.sessionId !== activeSessionId) { sess._replayLoadingMore = false; releaseScrollAnchor(); drainGateBuffer(sess); return; }
        var rpData = rp && rp.data;
        if (rpData && rpData.events && rpData.events.length > 0) {
            // 游标分页天然只返回「更早」的事件，无需再按 totalCount 增长做重叠区间修正：
            // 会话仍在流式时新事件的 seq 只会更大，不可能落进 beforeSeq 之前的窗口。
            sess._replayHasMore = !!rpData.hasMore;
            sess._replayRemainingRounds = rpData.remainingRounds || 0;
            if (rpData.firstSeq) sess._replayFirstSeq = rpData.firstSeq;
            // 标记为 prepend 模式：replayDone 会以视口顶部消息行为锚点恢复滚动位置（缓冲在 replayDone 排空）
            replaySession(sess, rpData.events, true);
        } else {
            // 没有更早的事件了：收起入口，避免留下永远点不出内容的按钮
            sess._replayHasMore = false;
            sess._replayRemainingRounds = 0;
            drainGateBuffer(sess);
            if (typeof updateLoadMoreBtn === 'function') updateLoadMoreBtn(sess);
            releaseScrollAnchor();
        }
        sess._replayLoadingMore = false;
    }).fail(function() {
        sess._replayLoadingMore = false;
        drainGateBuffer(sess);
        // 请求失败时恢复按钮，避免用户永久丢失加载入口
        if (typeof updateLoadMoreBtn === 'function') updateLoadMoreBtn(sess);
        releaseScrollAnchor();
    });
}

/**
 * 显示/隐藏"加载更多"按钮（插入到消息容器顶部）
 */
function updateLoadMoreBtn(sess) {
    // 非当前激活的会话不显示按钮（切换会话时旧按钮已在 setActiveSession 中被清除，
    // 但异步的 replayDone 可能在非激活态回调，此处加校验兜底）
    if (!sess || sess.sessionId !== activeSessionId) return;
    // 容器必须已在 DOM 树中
    if (!sess.container || !document.contains(sess.container)) return;

    // 只移除当前会话容器前的加载按钮
    $(sess.container).prev('.chat-load-more-wrapper').remove();

    if (sess._replayHasMore) {
        // 计数单位是「用户消息条数」，与用户在界面上数得出来的气泡一致；
        // 旧实现显示的是 ndjson 事件行数（含 token 级增量），既看不懂又会随流式增长而变大。
        // 文案改用单键占位符格式化：旧实现拼接 load_more_before + load_more_messages 两段，
        // 而多数语种两个键各自就是含 {0} 的完整句，拼出来是重复病句。
        var remaining = sess._replayRemainingRounds || 0;
        var label = remaining > 0
            ? GourdI18n.t('history.load_more_messages', ['<span class="load-more-count">' + remaining + '</span>'])
            : GourdI18n.t('history.load_more_earlier');
        var html = '<div class="chat-load-more-wrapper fade-enter">' +
            '<button class="chat-load-more-btn">' +
                '<svg class="load-more-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                    '<polyline points="18 15 12 9 6 15"></polyline>' +
                '</svg>' +
                label +
            '</button>' +
        '</div>';
        var $btn = $(html);
        $btn.insertBefore(sess.container);
        $btn.find('.chat-load-more-btn').on('click', function() {
            var $this = $(this);
            if ($this.hasClass('loading')) return;
            $this.addClass('loading').html(loadMoreLoadingHtml());
            loadMoreMessages(sess);
        });
    }
}

/* 加载更多按钮的加载态内容：环形 spinner（淡底全环 + 亮色弧段，旋转即经典加载环）+ 加载文案。
   旧实现里自动加载路径只加 .loading 类，CSS 旋转的是空闲态的上箭头图标——
   观感为「一个箭头原地转圈」，更像「返回上一页」的动作而非加载指示。
   现在点击、滚动自动加载、请求在途三处入口统一经 setLoadMoreBtnLoading 换成本内容。 */
function loadMoreLoadingHtml() {
    return '<svg class="load-more-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">' +
               '<circle cx="12" cy="12" r="9" stroke-opacity="0.25"></circle>' +
               '<path d="M21 12a9 9 0 0 0-9-9"></path>' +
           '</svg>' +
           GourdI18n.t('history.loading');
}
function setLoadMoreBtnLoading(sess) {
    if (!sess || !sess.container) return;
    var $btn = $(sess.container).prev('.chat-load-more-wrapper').find('.chat-load-more-btn');
    if (!$btn.length || $btn.hasClass('loading')) return;
    $btn.addClass('loading').html(loadMoreLoadingHtml());
}

/* 向上滚动到顶部附近时自动加载上一页（按钮保留作为显式入口与加载态提示）。
   仅在已渲染完当前页、且不处于回放/缓冲态时触发，避免与 prepend 的滚动补偿打架。 */
$(messagesWrap).on('scroll', function() {
    if (messagesWrap.scrollTop > 240) return;
    var sess = activeSessionId && sessionMap ? sessionMap[activeSessionId] : null;
    if (!sess || !sess._replayHasMore) return;
    if (sess._replayLoadingMore || sess._replaying || sess._gateBuffering) return;
    setLoadMoreBtnLoading(sess);
    loadMoreMessages(sess);
});

/* ===== 回放/实时流互斥门禁 =====
   新版事件携带 eventSeq：历史快照与实时缓冲统一按会话游标去重、排序；
   旧 stream 文件没有 eventSeq 时，继续使用指纹/时间与 (type,runId) 覆盖集兼容。 */
function beginGateBuffer(sess) {
    if (!sess._gateBuffer) sess._gateBuffer = [];
    sess._gateBuffering = true;
}
function gateChunkFp(c) {
    return (c.type || '') + '\u0001' + (c.createdAt || 0) + '\u0001' + (c.text || '') + '\u0001' + (c.toolName || '') + '\u0001' + (c.actionId || '');
}
function buildReplayCoverage(events) {
    var cov = { fps: {}, runs: {}, maxCreatedAt: 0 };
    for (var i = 0; i < events.length; i++) {
        var e = events[i];
        if (!e || !e.type) continue;
        if ((e.createdAt || 0) > cov.maxCreatedAt) cov.maxCreatedAt = e.createdAt;
        if (e.type === 'text' || e.type === 'reason') {
            cov.runs[e.type + '\u0001' + (e.runId || '')] = true;
        } else {
            cov.fps[gateChunkFp(e)] = true;
        }
    }
    return cov;
}
function replayCoverageHas(cov, c) {
    if (!cov || !c || !c.type) return false;
    if (c.type === 'text' || c.type === 'reason') {
        return !!cov.runs[c.type + '\u0001' + (c.runId || '')];
    }
    if (c.createdAt && c.createdAt <= cov.maxCreatedAt) return true;
    return !!cov.fps[gateChunkFp(c)];
}
function drainGateBuffer(sess) {
    var buf = sess._gateBuffer || [];
    sess._gateBuffer = [];
    sess._gateBufferOverflowed = false;
    // 缓冲中的 done 帧经 dispatchGateChunk 时，会把当前 _gateBuffering 视为「恢复进行中」，
    // 在 finishStream 后重新武装 _recovering/_gateBuffering（该语义本为防止恢复分页的中间轮
    // done 关闭恢复态）。排空场景下这次重武装是误伤：_recovering 残留 true 会让 onmessage
    // 把后续全部实时帧永久缓冲，流式界面卡死到下次重连。故排空前快照、排空后复原。
    var recoveringBefore = sess._recovering;
    var doneDrained = false;
    buf.sort(function(a, b) {
        return Number(a && a.eventSeq || 0) - Number(b && b.eventSeq || 0);
    });
    for (var i = 0; i < buf.length; i++) {
        var c = buf[i];
        if (c && c.type === 'done') doneDrained = true;
        try {
            if (c && c.eventSeq) {
                applySequencedGateChunk(sess, c);
            } else {
                if (sess._replayCoverage && replayCoverageHas(sess._replayCoverage, c)) continue;
                dispatchGateChunk(c);
            }
        } catch (e) {}
    }
    sess._recovering = recoveringBefore;
    sess._gateBuffering = false;
    // 缓冲里的 done 已借 finishStream 收尾本轮，但当时 _suppressQueueDispatch 抑制了队列派发；
    // 排空后若已不在流式/回放态，补一次派发（与 recoverStreamingSession 收尾对齐），
    // 避免排队消息因一次上拉加载而永久滞留。
    if (doneDrained && !sess.isStreaming && !sess._replaying
            && window.messageQueue && typeof processMessageQueue === 'function') {
        processMessageQueue(sess.sessionId);
    }
}

/* 快照会话「正在进行」的实时流渲染状态，供 prepend 回放结束后原样恢复。
   任务执行中用户上拉加载更早历史时，replaySession 的 resetStreamState 会清掉
   currentBubbleEl/reasonBuffer/思考块/工具卡等引用；若不快照，缓冲实时帧排空时会在
   容器尾部另起一个新气泡——进行中的回复被劈成「冻结半截 + 新开半截」，思考块与工具卡
   重复出现，即「上拉加载把正在对话的区域弄乱」的老问题残遗变体。
   无进行中的实时输出时返回 null，行为与旧版完全一致。 */
function captureLiveStreamState(sess) {
    var isLive = sess.isStreaming || sess.currentBubbleEl || sess.thinkingBlockEl || sess.pendingToolCard;
    if (!isLive) return null;
    return {
        wasStreaming: !!sess.isStreaming,
        currentBubbleEl: sess.currentBubbleEl,
        reasonBuffer: sess.reasonBuffer || '',
        thinkingBlockEl: sess.thinkingBlockEl,
        thinkingBodyMdEl: sess.thinkingBodyMdEl,
        thinkingBodyWrapEl: sess.thinkingBodyWrapEl,
        thinkingBuffer: sess.thinkingBuffer || '',
        currentRunId: sess.currentRunId,
        pendingToolCard: sess.pendingToolCard,
        pendingToolStarted: sess.pendingToolStarted,
        approvedToolCard: sess.approvedToolCard,
        toolCardsById: sess.toolCardsById,
        toolBatchesById: sess.toolBatchesById,
        completedActionIds: sess.completedActionIds,
        agentCards: sess.agentCards,
        agentStates: sess.agentStates,
        agentStateLast: sess._agentStateLast
    };
}

/* 流式过程回放：把 replay 事件序列喂给与实时流完全相同的渲染管线（onWebChunk + finishStream），
   在临时容器中批量重建 DOM，再一次性移入真实容器。以持久化的 createdAt 作为 _replayClock 还原
   并行批量分组的时序；user 事件独立渲染用户气泡；trace 为一轮结束边界，触发 finishStream 收尾。
   
   性能优化：采用分片异步执行（每帧处理最多 50 个事件），避免长对话一次性阻塞主线程导致 UI 假死。
   
   @param {Object} sess 会话对象
   @param {Array} events 事件列表
   @param {boolean} keepOpen 服务端任务是否仍在运行
   */
function replaySession(sess, events, prepend, keepOpen) {
    var realContainer = sess.container;
    // prepend 回放且会话存在进行中的实时流时先快照（replayDone 里恢复，见 captureLiveStreamState）；
    // 初始加载（prepend=false）走原有 resumeState 逻辑，不受影响。
    var liveState = prepend ? captureLiveStreamState(sess) : null;
    var tempDiv = document.createElement('div');
    sess.container = tempDiv;
    sess._replaying = true;
    if (!sess._gateBuffer) sess._gateBuffer = [];
    sess.isStreaming = false;
    // 回放期间禁止 finishStream 和渲染管线触发滚动，滚动在 replayDone 统一处理
    sess._skipScroll = true;
    resetStreamState(sess);

    function endTurn() {
        if (sess.currentBubbleEl || sess.thinkingBlockEl || sess.pendingToolCard) {
            // 回放期间不经过 finishStream（避免空 buffer 产生空气泡和 setAssistantTime 副作用），
            // 手动取消待渲染帧并强刷 buffer，然后清理状态。
            if (sess.reasonBuffer) {
                var el = ensureAssistantBubble(sess);
                el.setAttribute('data-md-raw', sess.reasonBuffer);
                getStreamMd(el).finish();
                if (typeof addCodeBlockButtons === 'function') addCodeBlockButtons(el);
            }
            removeThinking(sess);
            purgeInlineThinking(sess);
            finishThinkingBlock(sess);
            finishAgentThinkingBlock(sess);
            finishPendingTool(sess);
            // R10 修复：回放收尾必须与 finishStream 同等彻底。
            // 旧实现只清主线路思考块与待定工具卡，遗漏了工具卡 / 智能体卡的 loading 闪烁态，
            // 导致历史消息里固化了「绿点永久闪 + 计时器一直跳」——重开旧会话即可复现。
            // 回放路径不会再接收任何帧，故直接全量清 loading（包括批量卡，它不会再有批次完整性检查）。
            if (sess.container) {
                // 孤儿骨架卡先移除再标黄：它从未执行过，黄点空卡会被读成「工具失败」。
                // 回放路径理论上碰不到（action_draft / action_args 不落盘），但实时流与回放共用
                // 同一渲染管线，此处与 finishStream 保持同构，避免两条收尾路径语义不一致。
                if (typeof removeOrphanArgsStreamingCards === 'function') removeOrphanArgsStreamingCards(sess);
                $(sess.container).find('.tool-status-icon.loading').each(function() {
                    this.className = 'tool-status-icon warn';
                    this.innerHTML = '';
                });
                $(sess.container).find('.agent-status-icon.loading').each(function() {
                    this.className = 'agent-status-icon done';
                });
                $(sess.container).find('.agent-card-streaming').removeClass('agent-card-streaming');
                $(sess.container).find('.thinking-block.streaming').removeClass('streaming');
            }
            resetStreamState(sess);
            purgeEmptyMdBlocks(sess.container);
        }
    }

    var idx = 0;
    var CHUNK_SIZE = 50;  // 每帧处理的事件数量，平衡渲染性能与响应性

    function replayChunk() {
        var end = Math.min(idx + CHUNK_SIZE, events.length);

        try {
            for (; idx < end; idx++) {
                    var chunk = events[idx];
                    try {
                        if (!chunk || !chunk.type) continue;
                        sess._replayClock = (typeof chunk.createdAt === 'number') ? chunk.createdAt : (sess._replayClock || 0);

                        if (chunk.type === 'user' || chunk.type === 'user_input') {
                            endTurn();
                            resetStreamState(sess);
                            appendUserMessage(sess, chunk.text, null, null, chunk.createdAt);
                            continue;
                        }
                        if (chunk.type === 'done') { endTurn(); resetStreamState(sess); continue; }
                        /* file_changes 是被动 run 快照：回放时也不得为了复用渲染入口临时置
                           isStreaming=true，否则对账与流状态语义会被元数据事件污染。 */
                        if (chunk.type === 'file_changes') {
                            onWebChunk(sess, chunk);
                            continue;
                        }

                        sess.isStreaming = true;
                        onWebChunk(sess, chunk);
                        sess.isStreaming = false;
                        if (chunk.type === 'trace') { endTurn(); resetStreamState(sess); }
                    } catch (eventError) {
                        // 单条损坏事件不能卡死同一个 idx；for 的 idx++ 会继续下一条并最终释放 gate。
                        console.error('[replaySession] 跳过异常事件:', eventError);
                        sess.isStreaming = false;
                    }
                }
        } catch (e) {
            console.error('[replaySession] 回放异常:', e);
        }

        if (idx < events.length) {
            // 还有未处理的事件，下一帧继续
            sess._replayRafId = requestAnimationFrame(replayChunk);
        } else {
            // 全部事件处理完毕，执行收尾
            replayDone();
        }
    }

    function replayDone() {
        var resumeState = null;
        if (keepOpen && !prepend && (sess.currentBubbleEl || sess.thinkingBlockEl || sess.pendingToolCard)) {
            resumeState = {
                currentBubbleEl: sess.currentBubbleEl,
                reasonBuffer: sess.reasonBuffer,
                thinkingBlockEl: sess.thinkingBlockEl,
                thinkingBodyMdEl: sess.thinkingBodyMdEl,
                thinkingBodyWrapEl: sess.thinkingBodyWrapEl,
                thinkingBuffer: sess.thinkingBuffer,
                currentRunId: sess.currentRunId,
                pendingToolCard: sess.pendingToolCard,
                pendingToolStarted: sess.pendingToolStarted,
                approvedToolCard: sess.approvedToolCard,
                toolCardsById: sess.toolCardsById,
                toolBatchesById: sess.toolBatchesById,
                agentCards: sess.agentCards,
                agentStates: sess.agentStates,
                agentStateLast: sess._agentStateLast
            };
        } else {
            endTurn();
        }
        sess._replaying = false;
        sess._replayClock = null;
        sess.isStreaming = false;
        sess._replayRafId = null;
        sess._skipScroll = false;       // 回放结束，恢复滚动管线

        // 移入真实容器
        sess.container = realContainer;
        var fragment = document.createDocumentFragment();
        while (tempDiv.firstChild) { fragment.appendChild(tempDiv.firstChild); }
        // prepend 的空气泡清扫只能扫本页新插入的节点，故先留存引用（入 DOM 后 fragment 会被清空）
        var prependedRows = prepend ? Array.prototype.slice.call(fragment.childNodes) : null;

        if (prepend) {
            // 选锚点：当前视口顶部第一个可见消息行，以及它相对视口的偏移。
            // 不用 scrollHeight 差值：那个算法只在「高度变化全部发生在视口上方」时成立，
            // 而下面的空气泡清理会删除视口下方的行、回放期间流式内容也在长高，
            // 两者都会把 delta 算歪。锚定到具体元素则对任何位置的高度变化都免疫。
            var anchorEl = null, anchorOffset = 0;
            var wrapTop = messagesWrap.getBoundingClientRect().top;
            var rows = realContainer.children;
            for (var ai = 0; ai < rows.length; ai++) {
                var rect = rows[ai].getBoundingClientRect();
                // 第一个底边落在视口顶部下方的元素，即用户正在看的那一条
                if (rect.bottom > wrapTop) { anchorEl = rows[ai]; anchorOffset = rect.top - wrapTop; break; }
            }

            // prepend 插入到现有内容之前
            realContainer.insertBefore(fragment, realContainer.firstChild);

            // 清理回放过程中产生的空白助手消息（无内容、无工具卡、无思考块），
            // 这些是分片边界处 finishStream 强刷空 buffer 留下的空壳。
            // 只扫本页新插入的节点：旧实现扫全容器，会误删下方已有行——尤其是任务
            // 执行中那个「已创建但还没收到首个 token」的实时气泡，删掉它会让
            // sess.currentBubbleEl 指向脱离文档的节点，后续流式内容再也显示不出来。
            for (var pi = 0; pi < prependedRows.length; pi++) {
                var rowEl = prependedRows[pi];
                if (rowEl.nodeType !== 1) continue;
                var $row = $(rowEl);
                if (!$row.hasClass('msg-row') || !$row.hasClass('assistant')) continue;
                // 兜底：绝不清扫承载当前流式输出的节点
                if (sess.currentBubbleEl && (rowEl === sess.currentBubbleEl || rowEl.contains(sess.currentBubbleEl))) continue;
                var $bubble = $row.find('.msg-bubble');
                var hasContent = $bubble.find('.md-content').filter(function() { return $(this).text().trim().length > 0; }).length > 0;
                var hasTools = $row.find('.tool-card').length > 0;
                var hasThinking = $row.find('.thinking-block').length > 0;
                var hasBadge = $row.find('.agent-card, .err-bubble, .chunk-error, .hitl-card').length > 0;
                if (!hasContent && !hasTools && !hasThinking && !hasBadge) {
                    $row.remove();
                }
            }

            // 加载按钮在锚定修正之前重建：它插在容器顶部（高约 54px），若留到修正之后，
            // 这段高度会在锚点上方凭空出现，把刚对齐好的内容再顶下去。
            if (typeof updateLoadMoreBtn === 'function') updateLoadMoreBtn(sess);

            // 把锚点回弹到原来的视口偏移，用户眼中的内容纹丝不动
            if (anchorEl) {
                var newTop = anchorEl.getBoundingClientRect().top - messagesWrap.getBoundingClientRect().top;
                messagesWrap.scrollTop += (newTop - anchorOffset);
            }
        } else {
            // 初始加载模式：清空后移入
            $(realContainer).html('');
            realContainer.appendChild(fragment);
        }

        // 代码高亮和 mermaid 也分片执行，避免阻塞
        if (typeof highlightCodeBlocks === 'function') highlightCodeBlocks(realContainer);
        if (typeof processMermaidBlocks === 'function') processMermaidBlocks(realContainer);

        // 回放结束，清空 Markdown 缓存并清理临时流状态。
        if (typeof clearMdCache === 'function') clearMdCache();
        resetStreamState(sess);
        // 恢复进行中的渲染状态：初始加载用 resumeState（服务端任务仍在跑），
        // prepend 回放用 liveState（回放开始前对实时流的快照）。恢复后缓冲实时帧排空时
        // 会继续写回原气泡/思考块/工具卡，而不是在容器尾部另起炉灶把进行中的回复劈成两半。
        var restoreState = resumeState || liveState;
        if (restoreState) {
            sess.currentBubbleEl = restoreState.currentBubbleEl;
            sess.reasonBuffer = restoreState.reasonBuffer;
            sess.thinkingBlockEl = restoreState.thinkingBlockEl;
            sess.thinkingBodyMdEl = restoreState.thinkingBodyMdEl;
            sess.thinkingBodyWrapEl = restoreState.thinkingBodyWrapEl;
            sess.thinkingBuffer = restoreState.thinkingBuffer;
            sess.currentRunId = restoreState.currentRunId;
            sess.pendingToolCard = restoreState.pendingToolCard;
            sess.pendingToolStarted = restoreState.pendingToolStarted;
            sess.approvedToolCard = restoreState.approvedToolCard;
            sess.toolBatchesById = restoreState.toolBatchesById || {};
            sess.toolCardsById = restoreState.toolCardsById || {};
            sess.completedActionIds = restoreState.completedActionIds || {};
            sess.agentCards = restoreState.agentCards;
            sess.agentStates = restoreState.agentStates;
            sess._agentStateLast = restoreState.agentStateLast;
            var liveAgain = restoreState.wasStreaming !== false;
            sess.isStreaming = liveAgain;
            if (liveAgain && sess.sessionId === activeSessionId) { isStreaming = true; setBtnStopMode(); }
        }

        // 回放事件已经被渲染，更新稳定游标；否则下次断线恢复会重复渲染已回放事件。
        for (var si = 0; si < events.length; si++) {
            var replaySeq = Number(events[si] && events[si].eventSeq || 0);
            if (replaySeq) sess.lastEventSeq = Math.max(sess.lastEventSeq || 0, replaySeq);
        }

        // 排空回放期间累积的实时帧缓冲，按同一游标去重。
        // 注意：prepend 时视口锚锁仍生效——缓冲里的 done 帧会走 finishStream →
        // scrollToBottom(true)，不锁住就会把刚对齐的视口直接拽到底部。
        drainGateBuffer(sess);

        // 回放期新建的文件变更卡片在这里统一补对账。file_changes 是被动事件，不会临时进入
        // streaming 态；但回放 DOM 仍先建在临时容器中，所以必须等节点移入真实容器后再请求，
        // 确保对账响应回填时 upsert 能命中并原地更新已有卡片。
        if (typeof window.flushFileChangesReplayReconcile === 'function') window.flushFileChangesReplayReconcile(sess);

        if (!prepend) {
            // 初始加载：滚动到底部，然后显示/隐藏加载按钮
            if (sess.sessionId === activeSessionId) scrollToBottom(true);
            if (typeof updateLoadMoreBtn === 'function') updateLoadMoreBtn(sess);
        } else {
            // 按钮与滚动位置均已在 DOM 插入后处理完毕。
            // 锚锁延到下一帧再释放：排空缓冲时投递的 rAF 滚动帧尚未执行，
            // 此刻直接释放仍会被它们拽到底部。
            requestAnimationFrame(function() {
                requestAnimationFrame(function() { releaseScrollAnchor(); });
            });
        }

    }

    // 启动分片回放
    replayChunk();
}

function loadMessagesLegacy(sess, rootQ) {
    $.get('/web/chat/messages?sessionId=' + encodeURIComponent(sess.sessionId) + rootQ, function(resp) {
        try {
            var msgs = resp.data;
            var realContainer = sess.container;
            // 用临时容器批量构建 DOM，避免逐条 append 触发多次 layout
            var tempDiv = document.createElement('div');
            sess.container = tempDiv;
            resetStreamState(sess);
            
            var idx = 0;
            var CHUNK_SIZE = 20;  // 纯文本渲染含 Markdown 解析，每帧处理更少条

            function loadChunk() {
                var end = Math.min(idx + CHUNK_SIZE, msgs.length);
                for (; idx < end; idx++) {
                    try {
                        var m = msgs[idx];
                        if (m.role === 'USER') {
                            resetStreamState(sess);
                            appendUserMessage(sess, m.content, null, null, m.createdAt);
                        } else if (m.role === 'ASSISTANT') {
                            var isConsecutive = (idx > 0 && msgs[idx - 1].role === 'ASSISTANT');
                            if (!isConsecutive) resetStreamState(sess);
                            var el = ensureAssistantBubble(sess);
                            sess.reasonBuffer = isConsecutive ? sess.reasonBuffer + '\n\n' + m.content : m.content;
                            el.setAttribute('data-md-raw', sess.reasonBuffer);
                            $(el).html(renderMd(sess.reasonBuffer));
                            if (typeof addCodeBlockButtons === 'function') addCodeBlockButtons(el);
                            setAssistantTime(sess, m.createdAt);
                        }
                    } catch (eventError) {
                        console.error('[loadMessagesLegacy] 跳过异常消息:', eventError);
                    }
                }

                if (idx < msgs.length) {
                    sess._replayRafId = requestAnimationFrame(loadChunk);
                } else {
                    loadDone();
                }
            }

            function loadDone() {
                // 恢复真实容器，一次性移入所有子节点
                sess.container = realContainer;
                $(realContainer).html('');
                var fragment = document.createDocumentFragment();
                while (tempDiv.firstChild) {
                    fragment.appendChild(tempDiv.firstChild);
                }
                realContainer.appendChild(fragment);
                // 统一高亮所有代码块（user 消息的代码块已被 appendUserMessage 标记收集，不会重复）
                if (typeof highlightCodeBlocks === 'function') highlightCodeBlocks(realContainer);
                if (typeof processMermaidBlocks === 'function') processMermaidBlocks(realContainer);
                // 加载结束，清空 Markdown 缓存释放内存
                if (typeof clearMdCache === 'function') clearMdCache();
                resetStreamState(sess);
                if (sess.sessionId === activeSessionId) scrollToBottom(true);
                // 清理可能从上一会话残留的按钮
                if (typeof updateLoadMoreBtn === 'function') updateLoadMoreBtn(sess);
                // legacy 加载完成后统一排空回放缓冲（此路径无覆盖集，全部喂入）
                drainGateBuffer(sess);
            }

            loadChunk();
        } catch (e) {
            // 异常时确保容器恢复
            if (realContainer) sess.container = realContainer;
            drainGateBuffer(sess);
        }
    }).fail(function() {
        // legacy 请求失败也必须释放回放/实时互斥门禁；
        // 否则后续 WebSocket 帧会永久滞留在 _gateBuffer。
        drainGateBuffer(sess);
    });
}

/* Load on startup（桌面端等后端就绪再拉，避免冷启动占用连接；浏览器端立即执行）。
   先渲染全局/项目切换条（默认跟随工作空间选择），再拉会话列表。 */
__whenBackendReady(function () {
    updateHistoryScopeBar();
    loadSessionHistory();
});

/* 桌面端：后端恢复（首启失败重试成功 / 自动重启成功）后补拉首屏失败的数据。
   侧栏仅在此前失败过时补拉（避免每次重启都覆盖本地较新数据）；
   模型仅在没有可用列表时补拉（此前 reload 失败保留旧列表的场景，下次成功响应会自行重解析）。 */
if (window.__GOURD_IPC__ && typeof window.__GOURD_IPC__.onBackendReady === 'function') {
    window.__GOURD_IPC__.onBackendReady(function () {
        if (_sidebarLoadFailed) loadSessionHistory();
        if (!modelsLoaded) loadModels(null);
    });
}

/* ===== Command System ===== */
var commandList = []; // [{name, description, type}, ...]
var commandsLoaded = false;
var cmdTrigger = null; // '/' for commands, '@' for subagents, '$' for skills

function loadCommands() {
    $.get('/web/chat/hints', function(resp) {
        try {
            commandList = resp.data || [];
            commandsLoaded = true;
        } catch (e) {}
    });
}

__whenBackendReady(loadCommands);

var $welcomeCmdComplete = $('#welcomeCmdComplete');
var $chatCmdComplete = $('#chatCmdComplete');
var cmdActiveIndex = -1;
var cmdVisibleItems = [];

function getActiveCmdComplete() {
    return inChatMode ? $chatCmdComplete[0] : $welcomeCmdComplete[0];
}

/**
 * 关闭所有工具栏弹出面板（互斥核心）
 * 包括：命令补全、输入历史、循环任务、模型下拉、任务面板、变更面板、队列面板
 */
function closeAllToolbarPanels() {
    // 命令补全
    hideCmdComplete();
    // 输入历史
    if (typeof $chatHistoryPanel !== 'undefined' && $chatHistoryPanel) $chatHistoryPanel.removeClass('show');
    // 模型下拉
    $('#chatModelDropdown, #welcomeModelDropdown').removeClass('show');
    // 任务面板
    if (typeof window.hideTodoPanel === 'function') window.hideTodoPanel();
    // 变更面板
    if (typeof window.hideFileChangesPanel === 'function') window.hideFileChangesPanel();
    // 队列面板
    $('#message-queue-container').hide();
}
window.closeAllToolbarPanels = closeAllToolbarPanels;

function showCmdComplete(inputEl, completeEl, prefix) {
    if (!commandsLoaded || commandList.length === 0) return;
    closeAllToolbarPanels();
    var trigger = prefix.charAt(0);
    var query = prefix.substring(1).toLowerCase();
    var filterType = (trigger === '@') ? 'subagent' : (trigger === '$') ? 'skill' : 'command';
    cmdVisibleItems = [];
    var html = '';

    for (var i = 0; i < commandList.length; i++) {
        var cmd = commandList[i];
        // Filter by type based on trigger
        if (cmd.type !== filterType) continue;
        if (cmd.name.toLowerCase().indexOf(query) === 0 || query.length === 0) {
            cmdVisibleItems.push(cmd);
            var nameClass = (trigger === '@') ? 'cmd-name subagent' : (trigger === '$') ? 'cmd-name skill' : 'cmd-name';
            html += '<div class="cmd-complete-item" data-index="' + (cmdVisibleItems.length - 1) + '">'
                + '<span class="' + nameClass + '">' + escapeHtml(trigger + cmd.name) + '</span>'
                + '<span class="cmd-desc">' + escapeHtml(cmd.description || '') + '</span>'
                + '</div>';
        }
    }

    if (cmdVisibleItems.length === 0) {
        hideCmdComplete();
        return;
    }

    cmdTrigger = trigger;
    cmdActiveIndex = -1;
    $(completeEl).html(html).addClass('show');
}

function hideCmdComplete() {
    $welcomeCmdComplete.removeClass('show');
    $chatCmdComplete.removeClass('show');
    cmdActiveIndex = -1;
    cmdVisibleItems = [];
    cmdTrigger = null;
}

function applyCmdSelection(inputEl, completeEl) {
    if (cmdActiveIndex >= 0 && cmdActiveIndex < cmdVisibleItems.length) {
        var cmd = cmdVisibleItems[cmdActiveIndex];
        var trigger = cmdTrigger || '/';
        
        // 找到当前输入框中的命令前缀位置
        var val = inputEl.value;
        var prefixPos = -1;
        
        // 查找最近的命令前缀（/、@ 或 $）
        for (var i = val.length - 1; i >= 0; i--) {
            var ch = val.charAt(i);
            if (ch === '/' || ch === '@' || ch === '$') {
                prefixPos = i;
                break;
            }
        }
        
        if (prefixPos >= 0) {
            // 替换前缀及其后面的内容
            var textBefore = val.substring(0, prefixPos);
            var textAfter = val.substring(prefixPos);
            
            // 找到前缀后面的空格位置（如果有）
            var spaceIndex = textAfter.indexOf(' ');
            var argsStr = '';
            if (spaceIndex >= 0) {
                argsStr = textAfter.substring(spaceIndex);
            }
            
            // 构建新的值（命令/技能/子代理名称后追加空格）
            inputEl.value = textBefore + trigger + cmd.name + ' ' + argsStr;
            
            // 更新光标位置到命令和空格后面
            var newCursorPos = textBefore.length + trigger.length + cmd.name.length + 1;
            inputEl.setSelectionRange(newCursorPos, newCursorPos);
        } else {
            // 如果没有找到前缀，直接在开头插入
            inputEl.value = trigger + cmd.name + ' ' + val;
            inputEl.setSelectionRange(trigger.length + cmd.name.length + 1, trigger.length + cmd.name.length + 1);
        }
        
        autoResize(inputEl);
    }
    hideCmdComplete();
}

function navigateCmdComplete(e, inputEl, completeEl) {
    var $completeEl = $(completeEl);
    if (!$completeEl.hasClass('show')) return false;
    // 输入法组合中，不处理命令补全的回车
    if (e.isComposing) return false;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var $items = $completeEl.find('.cmd-complete-item');
        if ($items.length === 0) return true;

        // Remove old active
        if (cmdActiveIndex >= 0 && $items[cmdActiveIndex]) {
            $items.eq(cmdActiveIndex).removeClass('active');
        }

        if (e.key === 'ArrowDown') {
            cmdActiveIndex = (cmdActiveIndex + 1) % $items.length;
        } else {
            cmdActiveIndex = cmdActiveIndex <= 0 ? $items.length - 1 : cmdActiveIndex - 1;
        }

        $items.eq(cmdActiveIndex).addClass('active');
        $items[cmdActiveIndex].scrollIntoView({ block: 'nearest' });
        return true;
    }

    if (e.key === 'Tab' || (e.key === 'Enter' && cmdActiveIndex >= 0)) {
        e.preventDefault();
        applyCmdSelection(inputEl, completeEl);
        return true;
    }

    if (e.key === 'Escape') {
        hideCmdComplete();
        return true;
    }

    return false;
}

function handleInputForCommands(e) {
    var inputEl = e.target;
    var completeEl = (inputEl === welcomeInput) ? $welcomeCmdComplete[0] : $chatCmdComplete[0];
    var val = inputEl.value;

    if (val.indexOf('/') === 0 || val.indexOf('@') === 0 || val.indexOf('$') === 0) {
        // Only show completion when cursor is at the command/agent/skill name part (no spaces yet)
        var cursorPos = inputEl.selectionStart;
        var textBeforeCursor = val.substring(0, cursorPos);
        var spaceIndex = textBeforeCursor.indexOf(' ');
        if (spaceIndex === -1) {
            showCmdComplete(inputEl, completeEl, textBeforeCursor);
        } else {
            hideCmdComplete();
        }
    } else {
        hideCmdComplete();
        if (typeof $chatHistoryPanel !== 'undefined' && $chatHistoryPanel && $chatHistoryPanel.hasClass('show')) {
            hideHistoryPanel();
        }
    }
}

// History button handler (toolbar)
function onHistoryBtnClick(e) {
    if (typeof $chatHistoryPanel === 'undefined' || !$chatHistoryPanel) return;
    e.stopPropagation();
    if ($chatHistoryPanel.hasClass('show')) {
        hideHistoryPanel();
    } else {
        showHistoryPanel();
    }
}

// Command & Agent button handlers
function triggerCmdComplete(inputEl, completeEl, prefix) {
    // 保存当前光标位置
    var cursorPos = inputEl.selectionStart;
    var textBefore = inputEl.value.substring(0, cursorPos);
    var textAfter = inputEl.value.substring(cursorPos);
    
    // 在光标位置插入前缀（命令/子代理/技能符号后追加空格）
    inputEl.value = textBefore + prefix + ' ' + textAfter;
    
    // 更新光标位置到前缀和空格后面
    var newCursorPos = cursorPos + prefix.length + 1;
    inputEl.setSelectionRange(newCursorPos, newCursorPos);
    
    inputEl.focus();
    showCmdComplete(inputEl, completeEl, prefix);
}
$('#welcomeCmdBtn').on('click', function() {
    triggerCmdComplete(welcomeInput, $welcomeCmdComplete[0], '/');
});
$('#chatCmdBtn').on('click', function() {
    triggerCmdComplete(chatInput, $chatCmdComplete[0], '/');
});
$('#welcomeAgentBtn').on('click', function() {
    triggerCmdComplete(welcomeInput, $welcomeCmdComplete[0], '@');
});
$('#chatAgentBtn').on('click', function() {
    triggerCmdComplete(chatInput, $chatCmdComplete[0], '@');
});
$('#welcomeSkillBtn').on('click', function() {
    triggerCmdComplete(welcomeInput, $welcomeCmdComplete[0], '$');
});
$('#chatSkillBtn').on('click', function() {
    triggerCmdComplete(chatInput, $chatCmdComplete[0], '$');
});

$(welcomeInput).on('input', handleInputForCommands);
$(chatInput).on('input', handleInputForCommands);

// Keyboard navigation for command completion
$(welcomeInput).on('keydown', function(e) {
    // 输入法正在组合中（如拼音选词），不触发发送
    if (e.isComposing) return;
    var handled = navigateCmdComplete(e, welcomeInput, $welcomeCmdComplete[0]);
    if (handled) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
$(chatInput).on('keydown', function(e) {
    // 输入法正在组合中（如拼音选词），不触发发送
    if (e.isComposing) return;
    // 优先级1：命令补全导航
    var handled = navigateCmdComplete(e, chatInput, $chatCmdComplete[0]);
    if (handled) return;
    // 优先级2：历史面板导航（面板已打开时）
    handled = navigateHistory(e);
    if (handled) return;
    // 触发条件：输入框为空 + 上/下键 → 打开历史面板
    if (!chatInput.value.trim() && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        showHistoryPanel();
        return;
    }
    // Tab：任务执行中显式加入持久化队列（Enter 保留给即时插话）。
    if (e.key === 'Tab' && activeSessionId && sessionMap[activeSessionId] && sessionMap[activeSessionId].isStreaming) {
        e.preventDefault();
        sendMessage(true);
        return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(false); }
});

// Click on completion item
$welcomeCmdComplete.on('click', function(e) {
    var $item = $(e.target).closest('.cmd-complete-item');
    if ($item.length) {
        cmdActiveIndex = parseInt($item.attr('data-index'));
        applyCmdSelection(welcomeInput, $welcomeCmdComplete[0]);
        welcomeInput.focus();
    }
});
$chatCmdComplete.on('click', function(e) {
    var $item = $(e.target).closest('.cmd-complete-item');
    if ($item.length) {
        cmdActiveIndex = parseInt($item.attr('data-index'));
        applyCmdSelection(chatInput, $chatCmdComplete[0]);
        chatInput.focus();
    }
});

// Hide on outside click
$(document).on('click', function(e) {
    var $target = $(e.target);
    if (!$target.closest('.cmd-complete').length && !$target.closest('.history-panel').length && !$target.closest('textarea').length && !$target.closest('#welcomeCmdBtn').length && !$target.closest('#welcomeAgentBtn').length && !$target.closest('#chatCmdBtn').length && !$target.closest('#chatAgentBtn').length && !$target.closest('#welcomeSkillBtn').length && !$target.closest('#chatSkillBtn').length && !$target.closest('#chatHistoryBtn').length) {
        hideCmdComplete();
        hideHistoryPanel();
    }
});

/* ===== Input History Panel (chatInput only) ===== */
var $chatHistoryPanel = $('#chatHistoryPanel');
var historyActiveIndex = -1;
$('#chatHistoryBtn').on('click', onHistoryBtnClick);

/**
 * 从当前会话 DOM 中提取用户发送过的文本，倒序返回（最新在前）
 * 返回 [{text, idx, time}]
 */
function extractUserMessages() {
    var sess = activeSessionId ? sessionMap[activeSessionId] : null;
    if (!sess) return [];
    var $rows = $(sess.container).find('.msg-row.user');
    var items = [];
    for (var i = $rows.length - 1; i >= 0; i--) {
        var $row = $($rows[i]);
        var $bubble = $row.find('.msg-bubble');
        if (!$bubble.length) continue;
        var $lastSpan = $bubble.find('.user-msg-text');
        var rawMd = $lastSpan.length ? ($lastSpan.attr('data-md-raw') || '').trim() : '';
        var text = rawMd || ($lastSpan.length ? $lastSpan.text().trim() : '');
        if (!text) continue;
        // 去重
        var dup = false;
        for (var j = 0; j < items.length; j++) {
            if (items[j].text === text) { dup = true; break; }
        }
        if (dup) continue;
        var idx = parseInt($row.attr('data-user-msg-idx'));
        var time = $bubble.find('.msg-time').text() || '';
        items.push({ text: text, idx: isNaN(idx) ? -1 : idx, time: time });
    }
    return items;
}

function showHistoryPanel() {
    closeAllToolbarPanels();
    var messages = extractUserMessages();
    if (messages.length === 0) {
        $chatHistoryPanel.html('<div class="history-panel-empty">' + GourdI18n.t('history.no_input_history') + '</div>');
    } else {
        var html = '<div class="history-panel-search">'
            + '<input type="text" class="history-search-input" placeholder="' + GourdI18n.t('history.search_placeholder') + '" />'
            + '</div>';
        html += '<div class="history-panel-list">';
        for (var i = 0; i < messages.length; i++) {
            var display = messages[i].text.length > 80
                ? messages[i].text.substring(0, 80) + '...'
                : messages[i].text;
            var timeStr = messages[i].time ? '<span class="history-item-time">' + escapeHtml(messages[i].time) + '</span>' : '';
            html += '<div class="history-panel-item" data-index="' + i + '" data-msg-idx="' + messages[i].idx + '">'
                + '<span class="history-item-text">' + escapeHtml(display) + '</span>'
                + '<span class="history-item-actions">'
                + timeStr
                 + '<button class="history-locate-btn" title="' + GourdI18n.t('history.locate_message') + '">◎</button>'
                + '</span>'
                + '</div>';
        }
        html += '</div>';
        $chatHistoryPanel.html(html);

        // 绑定搜索过滤
        var $searchInput = $chatHistoryPanel.find('.history-search-input');
        $searchInput.on('input', function() {
            var query = this.value.trim().toLowerCase();
            var $items = $chatHistoryPanel.find('.history-panel-item');
            for (var k = 0; k < $items.length; k++) {
                var txt = $($items[k]).find('.history-item-text').text().toLowerCase();
                if (!query || txt.indexOf(query) >= 0) {
                    $($items[k]).show();
                } else {
                    $($items[k]).hide();
                }
            }
        });

        // 阻止搜索框按键冒泡，避免干扰历史面板导航
        $searchInput.on('keydown', function(e) {
            if (e.key === 'Escape') {
                hideHistoryPanel();
                chatInput.focus();
                e.stopPropagation();
                return;
            }
            e.stopPropagation();
        });
    }
    historyActiveIndex = -1;
    $chatHistoryPanel.addClass('show');
}

function hideHistoryPanel() {
    if (typeof $chatHistoryPanel !== 'undefined' && $chatHistoryPanel) $chatHistoryPanel.removeClass('show');
    historyActiveIndex = -1;
}

function applyHistorySelection() {
    var messages = extractUserMessages();
    if (historyActiveIndex >= 0 && historyActiveIndex < messages.length) {
        chatInput.value = messages[historyActiveIndex].text;
        autoResize(chatInput);
    }
    hideHistoryPanel();
}

/**
 * 定位到指定 idx 的用户消息，平滑滚动并高亮闪烁
 */
function locateUserMessage(msgIdx) {
    if (isNaN(msgIdx) || msgIdx < 0) return;
    var sess = activeSessionId ? sessionMap[activeSessionId] : null;
    if (!sess) return;
    var $target = $(sess.container).find('.msg-row.user[data-user-msg-idx="' + msgIdx + '"]');
    if (!$target.length) return;

    // 先关闭历史面板
    hideHistoryPanel();

    // 滚动到目标消息
    $target[0].scrollIntoView({ behavior: 'smooth', block: 'center' });

    // 高亮闪烁
    $target.addClass('msg-highlight');
    setTimeout(function() {
        $target.removeClass('msg-highlight');
    }, 1800);
}

/**
 * 处理历史面板内的键盘导航，返回 true 表示已消费事件
 */
function navigateHistory(e) {
    if (typeof $chatHistoryPanel === 'undefined' || !$chatHistoryPanel || !$chatHistoryPanel.hasClass('show')) return false;
    if (e.isComposing) return false;

    var $items = $chatHistoryPanel.find('.history-panel-item');

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        if ($items.length === 0) return true;
        if (historyActiveIndex >= 0 && $items[historyActiveIndex]) {
            $items.eq(historyActiveIndex).removeClass('active');
        }
        if (e.key === 'ArrowDown') {
            historyActiveIndex = (historyActiveIndex + 1) % $items.length;
        } else {
            historyActiveIndex = historyActiveIndex <= 0
                ? $items.length - 1
                : historyActiveIndex - 1;
        }
        $items.eq(historyActiveIndex).addClass('active');
        $items[historyActiveIndex].scrollIntoView({ block: 'nearest' });
        return true;
    }

    if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applyHistorySelection();
        chatInput.focus();
        return true;
    }

    if (e.key === 'Escape') {
        hideHistoryPanel();
        return true;
    }

    return false;
}

// Click on history item — text area fills input, locate button jumps to message
$chatHistoryPanel.on('click', function(e) {
    var $locateBtn = $(e.target).closest('.history-locate-btn');
    if ($locateBtn.length) {
        var $item = $locateBtn.closest('.history-panel-item');
        var msgIdx = parseInt($item.attr('data-msg-idx'));
        if (!isNaN(msgIdx)) locateUserMessage(msgIdx);
        return;
    }
    var $item = $(e.target).closest('.history-panel-item');
    if ($item.length) {
        historyActiveIndex = parseInt($item.attr('data-index'));
        applyHistorySelection();
        chatInput.focus();
    }
});

/* ===== Model Selector ===== */
var modelList = [];        // [{name, desc, contextLength, standard, thinkingLevels}, ...] (shared, only loaded once)
var modelsLoaded = false;  // whether model list holds usable data（会话级模型刷新的门闸语义）
var modelsListStale = false; // reload 失败但保留了旧列表：下次成功响应时强制重解析列表
var sessionModelMap = {};  // { sessionId: selectedModelName }
var sessionThinkingMap = {}; // { sessionId: thinkingDepth }  统一 5 档编码 / auto

// 思考深度档位——全局统一 5 档，可选项由后端按「模型推理能力」下发（策略 S2）。
//
// 后端 /web/chat/models 为每个模型下发 thinkingLevels：该模型【真正可区分】的档位编码，
// 由低到高、不含 auto。只渲染真实可区分的档位，用户就永远选不到无效档位：
//   现代 Claude                      → ["low","medium","high","xhigh","max"]
//   只支持单一 effort 值（gpt-5-pro） → ["high"]            （5 档全发同一个值，故只呈现 1 档）
//   仅开关 / 不可控（glm-4.6、M2）    → []                   （无可调档位，应隐藏选择器）
//
// 这里不再按接口类型硬编码档位表：推理能力天然是【按模型】而非按接口的——同属 anthropic
// 接口的 claude-sonnet-4-5 只认 budget_tokens、claude-sonnet-5 只认 output_config.effort，
// 按接口一刀切必然有一方 400。判定统一收归后端 ThinkingDepth，前端只消费结果。
//
// ⚠️ 国际化关键：档位文案必须在【渲染时】动态求值，不能在脚本解析期固化。
// 语言包由 app-i18n.js 异步 fetch，脚本顶层执行时可能尚未就绪 → GourdI18n.t() 会
// 回落成 key 字面量并被永久缓存进静态数组（历史 bug：思考下拉显示 history.thinking.xxx）。
// 因此下面是函数而非常量：每次调用都重新读取语言包。

// 默认档位编码：不注入任何思考参数、跟随模型默认行为。
// 旧名为 'off'，但其真实行为一直是「不注入」而非「关闭思考」，与 i18n 文案（"默认"）长期矛盾，
// 故更名消除歧义。历史落盘的 'off' / 'minimal' 由 normalizeThinkingCode() 与后端同口径归一。
var THINKING_AUTO = 'auto';

// 历史档位值归一（与后端 ThinkingDepth.normalize 同口径，仅影响回显，不回写）
function normalizeThinkingCode(depth) {
    var d = String(depth == null ? '' : depth).toLowerCase();
    if (!d || d === 'off') return THINKING_AUTO;
    if (d === 'minimal') return 'low';   // 统一 5 档不含 minimal（原厂支持率仅 14.7%），就近归入 low
    return d;
}

// 查某模型名对应的接口类型
function standardOfModel(modelName) {
    for (var i = 0; i < modelList.length; i++) {
        if (modelList[i].name === modelName) return modelList[i].standard || '';
    }
    return '';
}

// 查某模型「真正可区分的档位」编码表。
// 返回 null 与返回 [] 语义不同，不可混淆：
//   null = 后端没下发该字段（旧接口/模型未收录）→ 调用方走兜底档位集；
//   []   = 后端明确说该模型无可调档位          → 调用方应隐藏整个选择器。
function thinkingLevelsOfModel(modelName) {
    for (var i = 0; i < modelList.length; i++) {
        if (modelList[i].name === modelName) {
            var lv = modelList[i].thinkingLevels;
            return (Object.prototype.toString.call(lv) === '[object Array]') ? lv : null;
        }
    }
    return null;
}

// 兜底档位集（不含 auto）：仅当后端未下发 thinkingLevels 时使用
function fallbackThinkingLevels(standard) {
    var s = (standard || '').toLowerCase();
    if (s.indexOf('anthropic') >= 0 || s.indexOf('claude') >= 0) {
        return ['low', 'medium', 'high', 'xhigh', 'max'];
    }
    return ['low', 'medium', 'high'];
}

// 指定模型的思考档位选项集（每次调用都重建，保证国际化文案取最新语言包）
function thinkingOptionsForModel(modelName) {
    var t = function (k) { return GourdI18n.t(k); };
    var opts = [{
        value: THINKING_AUTO,
        label: t('history.thinking.auto.label'),
        desc: t('history.thinking.auto.desc')
    }];
    var levels = thinkingLevelsOfModel(modelName);
    if (levels == null) {
        levels = fallbackThinkingLevels(standardOfModel(modelName));
    }
    for (var i = 0; i < levels.length; i++) {
        var code = levels[i];
        if (!code || code === THINKING_AUTO) continue;
        opts.push({
            value: code,
            label: t('history.thinking.' + code + '.label'),
            desc: t('history.thinking.' + code + '.desc')
        });
    }
    return opts;
}

// 当前选中模型对应的思考档位选项集
function currentThinkingOptions() {
    return thinkingOptionsForModel(getSelectedModel());
}

// Get the effective selected model for current context
function getSelectedModel() {
    if (activeSessionId && sessionModelMap[activeSessionId]) {
        return sessionModelMap[activeSessionId];
    }
    return sessionModelMap['_default'] || '';
}

// Get the effective thinking depth for current context
function getSelectedThinking() {
    if (activeSessionId && sessionThinkingMap[activeSessionId]) {
        return sessionThinkingMap[activeSessionId];
    }
    return sessionThinkingMap['_default'] || THINKING_AUTO;
}

// 新建对话时，把「当前对话」已选的模型与思考档位继承给新会话，
// 避免新会话回落到全局默认（模型默认 + thinking=off）。
// 必须在生成新 SESSION_ID 之后、setActiveSession 之前调用：
// 先写入前端缓存以命中 refreshSessionModel 的缓存分支（不再拉后端默认覆盖），
// 再异步绑定到服务端，确保不经 /web/chat/input 的场景（如 /git、循环任务）也一致。
function inheritSelectionToSession(newSessionId) {
    if (!newSessionId) return;
    var model = getSelectedModel();
    var depth = getSelectedThinking();

    if (model) {
        sessionModelMap[newSessionId] = model;
        $.post('/web/chat/models/select', { sessionId: newSessionId, modelName: model })
            .fail(function (err) { console.error('Failed to inherit model to new session:', err); });
    }
    if (depth) {
        sessionThinkingMap[newSessionId] = depth;
        if (depth !== THINKING_AUTO) {
            $.post('/web/chat/thinking/select', { sessionId: newSessionId, depth: depth })
                .fail(function (err) { console.error('Failed to inherit thinking depth to new session:', err); });
        }
    }
}
window.inheritSelectionToSession = inheritSelectionToSession;

// Load model list (once) + selected model for given session
function loadModels(sessionId, callback) {
    var url = '/web/chat/models';
    if (sessionId) url += '?sessionId=' + encodeURIComponent(sessionId);

    $.get(url, function(resp) {
        try {
            // HTTP 200 ≠ 业务成功：后端未就绪/代理瞬态错误窗口可能拿到错误页或 {code:!=200}。
            // 旧实现无条件把空列表记为已加载（modelsLoaded=true），模型列表会被永久锁死、再无重试机会。
            if (!modelsResponseValid(resp)) {
                console.warn('Models response invalid (code=' + (resp && resp.code) + '), degrading to failure branch');
                degradeModelLoad();
                if (callback) callback(new Error('invalid models response'));
                return;
            }
            var data = resp.data;
            var selected = data.selected || '';

            // Store selected model per session
            if (sessionId) {
                sessionModelMap[sessionId] = selected;
            } else {
                sessionModelMap['_default'] = selected;
            }

            // Store selected thinking depth per session (mirrors model selection)
            var depth = normalizeThinkingCode(data.thinkingDepth);
            if (sessionId) {
                sessionThinkingMap[sessionId] = depth;
            } else {
                sessionThinkingMap['_default'] = depth;
            }

            // Only parse list once (it's the same for all sessions)；
            // modelsListStale=true（reload 失败保留旧列表）时同样强制重解析，保证与后端最终一致
            if (!modelsLoaded || modelsListStale) {
                modelList = [];
                var list = data.list || [];
                for (var i = 0; i < list.length; i++) {
                    modelList.push({ name: list[i].name || list[i].model, model: list[i].model || list[i].name, desc: list[i].description, contextLength: list[i].contextLength || 0, standard: list[i].standard || '', provider: list[i].provider || '', thinkingLevels: (Object.prototype.toString.call(list[i].thinkingLevels) === '[object Array]') ? list[i].thinkingLevels : null });
                }
                modelsLoaded = true;
                modelsListStale = false;
            }

            renderModelUI();
            if (callback) callback();
        } catch (e) {
            console.error('Failed to parse models:', e);
            // 解析失败也不能把欢迎页永久留在“加载中”状态。
            degradeModelLoad();
            if (callback) callback(e);
        }
    }).fail(function (xhr) {
        // Tauri 冷启动首批请求若遇到 503/代理瞬态错误，旧实现没有 fail 分支，
        // 按钮会永久停留在 chat.html 的“加载中...”；切换页面后再次加载才看似恢复。
        // 共享 backend_port 修复了根因，这里再做 UI 侧兜底：释放加载态并允许后续 reloadModels 重试。
        console.warn('Failed to load models:', xhr && xhr.status ? ('HTTP ' + xhr.status) : 'network error');
        degradeModelLoad();
        if (callback) callback(xhr || new Error('Failed to load models'));
    });
}

// 模型接口响应的业务校验：仅当 code===200 且 data.list 为数组才算成功。
// Tauri 冷启动竞态或代理降级时可能出现「HTTP 200 + 错误体」，不校验会把空列表锁成「已加载」。
function modelsResponseValid(resp) {
    if (!resp || typeof resp !== 'object') return false;
    if (resp.code !== 200) return false;
    var data = resp.data;
    return !!data && typeof data === 'object' && Array.isArray(data.list);
}

// 模型加载失败的统一出口：释放加载态；是否丢弃数据取决于有无「旧可用列表」：
// - reloadModels 失败（有旧列表）：保留旧列表且 modelsLoaded=true，标记 modelsListStale，
//   下拉与会话级模型刷新继续可用（避免「可用 → 未找到」的回归），下次成功响应再重解析；
// - 首次加载失败（无数据）：空列表 + modelsLoaded=false，renderModelUI 走空态，
//   等 backend-ready 补拉或 reloadModels 重试。
function degradeModelLoad() {
    if (modelList.length > 0) {
        modelsLoaded = true;
        modelsListStale = true;
    } else {
        modelsLoaded = false;
        modelsListStale = false;
    }
    renderModelUI();
}

function reloadModels(callback) {
    // 不预先清空 modelsLoaded/modelList：失败时由 degradeModelLoad 决定是否保留旧列表（见其注释）
    modelsListStale = true;
    loadModels(activeSessionId || null, callback);
}

// Refresh model UI for a specific session using local cache (no network request)
function refreshSessionModel(sessionId) {
    if (!sessionId) return;
    // If we haven't seen this session's model yet, fetch it from backend
    if (!sessionModelMap[sessionId]) {
        var url = '/web/chat/models?sessionId=' + encodeURIComponent(sessionId);
        $.get(url, function(resp) {
            try {
                var data = resp.data;
                sessionModelMap[sessionId] = data.selected || '';
                sessionThinkingMap[sessionId] = normalizeThinkingCode(data.thinkingDepth);
                renderModelUI();
            } catch (e) {
                console.error('Failed to parse session model:', e);
                renderModelUI();
            }
        }).fail(function (xhr) {
            // 会话切换期间接口失败不能让当前模型按钮保持旧的 loading 文案。
            console.warn('Failed to load session model:', xhr && xhr.status ? ('HTTP ' + xhr.status) : 'network error');
            renderModelUI();
        });
    } else {
        // Already cached — just re-render UI
        renderModelUI();
    }
}

// 去掉「供应商-」前缀的展示短名：模型名由供应商同步生成时为 provider + '-' + modelId，
// 分组标题已展示供应商，选项内不再重复该前缀
function modelShortName(m) {
    var p = m.provider || '';
    if (p && m.name && m.name.indexOf(p + '-') === 0) {
        var rest = m.name.substring(p.length + 1);
        if (rest) return rest;
    }
    return m.name;
}

// 模型下拉搜索：两处下拉（欢迎页/对话页）共用同一关键词，每次打开时清空
var modelFilterText = '';
// 当前过滤结果中的首个模型名，供搜索框回车直接选中
var modelFirstMatch = null;

function renderModelUI() {
    var $chatName = $('#chatModelName');
    var $welcomeName = $('#welcomeModelName');
    var $chatList = $('#chatModelList');
    var $welcomeList = $('#welcomeModelList');

    var currentModel = getSelectedModel();
    var currentEntry = null;
    for (var c = 0; c < modelList.length; c++) {
        if (modelList[c].name === currentModel) { currentEntry = modelList[c]; break; }
    }
    // 工具栏按钮显示去前缀短名，避免「GWork-xxx」过长截断
    var displaySource = currentEntry ? modelShortName(currentEntry) : currentModel;
    var displayName = displaySource.length > 24 ? displaySource.substring(0, 24) + '...' : displaySource;
    $chatName.text(displayName || GourdI18n.t('history.default_model'));
    $welcomeName.text(displayName || GourdI18n.t('history.default_model'));

    // 按钮内思考档位小标签：非默认（off）档位时显示；默认档位不显示，保持按钮简洁
    var tagLabel = thinkingButtonTagLabel();
    $('#chatModelThinkingTag').text(tagLabel).toggle(!!tagLabel);
    $('#welcomeModelThinkingTag').text(tagLabel).toggle(!!tagLabel);

    // 严格保持接口顺序；仅当 provider 与紧邻上一模型不同时插入标题（允许同一 provider 重复出现）
    var entries = ModelListOrder.buildEntries(modelList);
    // 折成分段后交给公共渲染器：统一处理搜索过滤、服务商折叠与空态
    var result = GourdModelDropdown.render({
        segments: GourdModelDropdown.toSegments(entries),
        query: modelFilterText,
        currentModel: currentModel,
        currentProvider: currentEntry ? (currentEntry.provider || '') : '',
        otherLabel: GourdI18n.t('history.model_group_other'),
        emptyText: GourdI18n.t('history.model_search_empty'),
        toggleTitle: GourdI18n.t('history.model_group_toggle'),
        itemHtml: function (m, active) {
            var ctxLen = m.contextLength ? (m.contextLength >= 1000000 && m.contextLength % 1000000 === 0 ? (m.contextLength / 1000000) + 'm' : (m.contextLength >= 1000 ? (m.contextLength / 1000) + 'k' : m.contextLength)) : '';
            var shortName = modelShortName(m);
            // 描述与模型ID相同时属冗余信息（名称行已展示），不再重复渲染第二行
            var desc = m.desc || '';
            if (desc && m.model && desc === m.model) desc = '';
            return '<div class="model-dropdown-item' + (active ? ' active' : '') + '" data-model="' + escapeHtml(m.name) + '">'
                + '<span class="model-item-name">' + escapeHtml(shortName) + (ctxLen ? '<span class="model-item-ctx">' + ctxLen + '</span>' : '') + '</span>'
                + (desc ? '<span class="model-item-desc">' + escapeHtml(desc) + '</span>' : '')
                // 关联选择：思考档位内嵌在当前选中模型项下，跟随所选模型展示
                + (active ? thinkingChipsHtml() : '')
                + '</div>';
        }
    });
    // 仅重绘列表层：搜索框是下拉内的静态节点，重绘会丢失输入内容与焦点
    $chatList.html(result.html);
    $welcomeList.html(result.html);
    modelFirstMatch = result.firstModel;
}

// 思考深度：在当前模型的档位集里查某值的短标签；查不到（默认档/模型不支持该档）返回默认
function thinkingShortLabel(value) {
    if (!value || value === THINKING_AUTO) return GourdI18n.t('history.thinking.default_label');
    var opts = currentThinkingOptions();
    for (var i = 0; i < opts.length; i++) {
        if (opts[i].value === value) return opts[i].label;
    }
    return GourdI18n.t('history.thinking.default_label');
}

// 按钮内思考档位小标签：当前值为默认（auto）或不在档位集内时不显示，其余显示短标签
function thinkingButtonTagLabel() {
    var current = getSelectedThinking();
    var opts = currentThinkingOptions();
    for (var k = 0; k < opts.length; k++) {
        if (opts[k].value === current && current !== THINKING_AUTO) return thinkingShortLabel(current);
    }
    return '';
}

// 关联思考档位区（内嵌在当前模型项下）：首项为「默认」（auto，跟随模型默认行为）
function thinkingChipsHtml() {
    var current = getSelectedThinking();
    var opts = currentThinkingOptions();

    // 当前档位是否在本模型可选档位内（切换模型后旧值可能不可区分 → 视作默认）
    var valid = THINKING_AUTO;
    for (var k = 0; k < opts.length; k++) {
        if (opts[k].value === current) { valid = current; break; }
    }

    var html = '<div class="model-thinking-opts"><span class="model-thinking-label">'
        + escapeHtml(GourdI18n.t('app.thinking_label')) + '</span>';
    for (var i = 0; i < opts.length; i++) {
        var o = opts[i];
        var cls = o.value === valid ? ' active' : '';
        html += '<span class="model-thinking-chip' + cls + '" data-thinking="' + escapeHtml(o.value) + '"'
            + (o.desc ? ' title="' + escapeHtml(o.desc) + '"' : '')
            + '>' + escapeHtml(o.label) + '</span>';
    }
    html += '</div>';
    return html;
}

// 思考档位已合并进模型下拉（关联选择）：渲染统一走 renderModelUI，此函数保留作兼容入口
function renderThinkingUI() {
    renderModelUI();
}

function selectModel(modelName) {
    var sid = activeSessionId || SESSION_ID;
    sessionModelMap[sid] = modelName;
    renderModelUI();

    // 立即通知服务端绑定模型选择，确保不走 /web/chat/input 的命令（如 /git、循环任务等）也能感知到模型变更
    $.post('/web/chat/models/select', {
        sessionId: sid,
        modelName: modelName
    }).fail(function(err) {
        console.error('Failed to select model on server:', err);
    });
}

function selectThinking(depth) {
    var sid = activeSessionId || SESSION_ID;
    sessionThinkingMap[sid] = depth;
    renderModelUI();

    // 立即通知服务端绑定档位（与模型选择同理，覆盖不走 /web/chat/input 的场景）
    $.post('/web/chat/thinking/select', {
        sessionId: sid,
        depth: depth
    }).fail(function(err) {
        console.error('Failed to select thinking depth on server:', err);
    });
}

// Toggle dropdown open/close
function initModelSelector(selectorId, currentId, dropdownId) {
    var $selector = $('#' + selectorId);
    var $current = $('#' + currentId);
    var $dropdown = $('#' + dropdownId);
    if (!$selector.length || !$current.length || !$dropdown.length) return;

    $current.on('click', function(e) {
        e.stopPropagation();
        // Close all other selectors (model + thinking)
        $('.model-selector.open').each(function() {
            if (this.id !== selectorId) $(this).removeClass('open');
        });
        var willOpen = !$selector.hasClass('open');
        $selector.toggleClass('open');
        // 每次打开都从完整列表开始：清空上次关键词并自动聚焦，可直接敲字筛选
        if (willOpen) {
            if (modelFilterText) { modelFilterText = ''; renderModelUI(); }
            $dropdown.find('.model-search-input').val('');
            $dropdown.find('.model-search-clear').hide();
            $dropdown.find('.model-dropdown-list').scrollTop(0);
            setTimeout(function () { try { $dropdown.find('.model-search-input').focus(); } catch (err) {} }, 0);
        }
    });

    // 搜索框：输入即过滤（只重绘列表层，不动搜索框，焦点与光标位置不丢）。
    // 用委托而非直接绑定：不依赖本函数执行时搜索框是否已在 DOM 中
    $dropdown.on('input', '.model-search-input', function () {
        modelFilterText = $(this).val() || '';
        $dropdown.find('.model-search-clear').toggle(!!modelFilterText);
        renderModelUI();
        $dropdown.find('.model-dropdown-list').scrollTop(0);
    });

    $dropdown.on('keydown', '.model-search-input', function (e) {
        if (e.key === 'Escape' || e.keyCode === 27) {
            e.stopPropagation();
            // 有关键词时先清空关键词，再按一次才收起下拉
            if (modelFilterText) {
                modelFilterText = '';
                $(this).val('');
                $dropdown.find('.model-search-clear').hide();
                renderModelUI();
            } else {
                $selector.removeClass('open');
            }
            return;
        }
        if (e.key === 'Enter' || e.keyCode === 13) {
            e.preventDefault();
            e.stopPropagation();
            // 回车选中当前过滤结果的首项；下拉保持打开以便继续选思考档位
            if (modelFirstMatch && modelFirstMatch !== getSelectedModel()) selectModel(modelFirstMatch);
            else $selector.removeClass('open');
        }
    });

    $dropdown.on('click', '.model-search-clear', function (e) {
        e.stopPropagation();
        modelFilterText = '';
        $dropdown.find('.model-search-input').val('').focus();
        $(this).hide();
        renderModelUI();
    });

    $dropdown.on('click', function(e) {
        // 下拉内部点击一律不冒泡到 document 收起器：
        // 否则点搜索框/组头/空白处会直接关闭下拉（搜索框将无法输入）
        e.stopPropagation();

        // 服务商组头：折叠/展开该组（状态持久化，跳页与重启后保留）
        var $group = $(e.target).closest('.model-dropdown-group');
        if ($group.length) {
            var $wrap = $group.closest('.model-dropdown-group-wrap');
            var collapsed = !$wrap.hasClass('collapsed');
            GourdModelDropdown.setCollapsed($group.attr('data-provider') || '', collapsed);
            // 两处下拉（欢迎页/对话页）共享折叠态：重绘保证两边一致
            renderModelUI();
            return;
        }

        // 关联的思考档位 chip：仅设置档位，不切模型；保持下拉打开便于连续调整
        var $chip = $(e.target).closest('.model-thinking-chip');
        if ($chip.length) {
            var depth = $chip.attr('data-thinking');
            if (depth != null && depth !== getSelectedThinking()) {
                selectThinking(depth);
            }
            return;
        }
        var $item = $(e.target).closest('.model-dropdown-item');
        if (!$item.length) return;
        var modelName = $item.attr('data-model');
        if (modelName && modelName !== getSelectedModel()) {
            selectModel(modelName);
            // 切换模型后保持下拉打开：让用户继续在新模型项下选择思考档位（关联选择）
            return;
        }
        // 点击当前已选模型项：视为「确认/收起」动作，关闭下拉
        $selector.removeClass('open');
    });
}

// Close all dropdowns on outside click
$(document).on('click', function() {
    $('.model-selector.open').removeClass('open');
});

// 国际化：语言包就绪 / 切换语言后，重新渲染模型选择器（模型 + 关联思考档位文案随语言变）
document.addEventListener('i18n:localeChanged', function () {
    // 空 catch 会吞掉 renderModelUI 的异常：一旦抛错，模型按钮将永久停留旧文案且无任何线索
    if (typeof renderModelUI === 'function') { try { renderModelUI(); } catch (e) { console.error('[i18n] renderModelUI failed:', e); } }
    updateHistoryUI();
    updateHistoryScopeBar();
});

initModelSelector('chatModelSelector', 'chatModelCurrent', 'chatModelDropdown');
initModelSelector('welcomeModelSelector', 'welcomeModelCurrent', 'welcomeModelDropdown');

window.reloadModels = reloadModels;
window.loadModels = loadModels;
// 思考深度档位单一真源：供自动化视图（app-automation.js）复用，避免重复维护档位表
window.thinkingOptionsForModel = thinkingOptionsForModel;

// Initial load (no specific session, get default selected)
__whenBackendReady(function () { loadModels(null); });
