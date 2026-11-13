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
/* 渲染 tab 行：按有效视图切换两个 tab 的 .active，并同步「展开/收起全部」按钮状态 */
function updateHistoryScopeBar() {
    var gBtn = document.getElementById('scopeGlobalBtn');
    var pBtn = document.getElementById('scopeProjectBtn');
    var scope = effectiveHistoryScope();
    if (gBtn) gBtn.classList.toggle('active', scope === 'global');
    if (pBtn) pBtn.classList.toggle('active', scope === 'project');
    updateExpandAllBtn();
}

/* 是否存在收起状态的项目（仅统计有会话的项目）：
   无会话项目没有可展开/收起的内容，不参与按钮状态判定——否则「隐形收起」会让按钮误显示为
   「展开全部」，首次点击变成无感的展开。按钮点击逻辑与图标状态共用同一判定口径。 */
function anyProjectCollapsed() {
    var ps = (_sidebarData && _sidebarData.projects) || [];
    for (var i = 0; i < ps.length; i++) {
        if (!(ps[i].sessions && ps[i].sessions.length > 0)) continue;
        if (!_projExpanded[ps[i].path]) return true;
    }
    return false;
}

/* 「展开全部/收起全部」按钮状态感知（图标 + 提示随项目树状态翻转）：
   - 仅「项目」tab 且存在「有会话的项目」时显示；对话 tab / code 模式 / 全部项目均无会话时隐藏，避免隐形空操作
   - 存在收起（有会话的）项目 → 展示「展开全部」图标与提示；全部展开 → 翻转为「收起全部」 */
function updateExpandAllBtn() {
    var btn = document.getElementById('expandAllBtn');
    if (!btn) return;
    var ps = (_sidebarData && _sidebarData.projects) || [];
    /* 有会话的项目才参与展示判定：无会话项目没有可开合的内容 */
    var hasSessions = false;
    for (var i = 0; i < ps.length; i++) {
        if (ps[i].sessions && ps[i].sessions.length > 0) { hasSessions = true; break; }
    }
    var showable = window.appMode !== 'code' && effectiveHistoryScope() === 'project' && hasSessions;
    if (!showable) {
        btn.style.display = 'none';
        return;
    }
    btn.style.display = '';
    var allExpanded = !anyProjectCollapsed();
    btn.classList.toggle('collapse-mode', allExpanded);
    var key = allExpanded ? 'app.sidebar.collapse_all' : 'app.sidebar.expand_all';

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
   保证发送时 X-Session-Cwd 指向该会话真实目录）。scope：调用方声明的归属（'local' 或
   connectionId）——合并列表后删/改/回放都必须按它路由，代理对无 root 的全局会话
   无键可查。 */
function toSessionEntries(list, scope) {
    var arr = [];
    for (var i = 0; i < (list || []).length; i++) {
        arr.push({ label: list[i].label, sessionId: list[i].sessionId, projectRoot: list[i].projectRoot || '', time: list[i].time || 0, loop: !!list[i].loop, _scope: scope || 'local' });
    }
    return arr;
}

/* 汇总完成：写入 _sidebarData，重建平铺（chatHistory），再尝试恢复活动会话。
   extra = 本轮扇出的分组上下文 { conns, globalByScope }：
   - conns：连接表快照，组序与在线态（dot 颜色）都以它为准；
   - globalByScope：全局会话按 scope 分桶，项目 tab 组顶「全局对话」子节按桶取。
   WHY 存快照而不是渲染时再查读口：数据是按快照扇出拉的，渲染时重新 list() 会在
   连接刚断的瞬间出现「有数据的组画不出来 / 画出来的组没有数据」的错位。
   加载失败兜底路径没有 extra，按空处理（只渲染全局会话）。 */
function finalizeSidebar(myToken, projects, globalSessions, extra) {
    if (myToken !== _sidebarReqToken) return;
    for (var j = 0; j < projects.length; j++) {
        var p = projects[j].path;
        if (_projExpanded[p] === undefined) _projExpanded[p] = projects[j].sessions.length > 0;
    }
    _sidebarData = {
        projects: projects,
        global: globalSessions,
        globalByScope: (extra && extra.globalByScope) || {},
        conns: (extra && extra.conns) || []
    };
    chatHistory = []; // 由渲染重建
    buildSidebar();   // 同步重建 chatHistory/currentChatIndex，供下方 restoreActiveSession 遍历
    updateHistoryUI();
    updateHistoryScopeBar();
    restoreActiveSession();
}

function loadSessionHistory() {
    if (window.appMode === 'code') {
        // code 模式：扫当前项目根，归属 = 【当前项目】的归属。
        var root = window.currentProjectRoot || '';
        /* 【归属为何不能用 __GOURD_REMOTE_ACTIVE_ID__】它只回答「有没有连着远端」。
           选着【本地】项目时它仍返回连接 id，而显式 __scope 在 route_for 里的优先级
           【高于 cwd 安全栏】——于是本属本地的会话请求被强制打到远端，本地会话列表
           被远端那份整个覆盖。改用当前项目的真实归属（查不到保守当本地）。 */
        var codeScope = (typeof window.__currentProjectScope === 'function')
            ? window.__currentProjectScope() : null;
        /* 【单一 __scope】route_for 按 query 顺序扫到第一个命中即返回，重复参数会让
           后一个永远无效：旧实现在 root 为空时拼出 `?__scope=local&__scope=id:RID`，
           local 先命中 → 远端全局会话永远拉不到。 */
        var qParts = [];
        if (root) qParts.push('root=' + encodeURIComponent(root));
        qParts.push(codeScope
            ? ('__scope=id:' + encodeURIComponent(codeScope))
            : '__scope=local');
        var q = '?' + qParts.join('&');
        var myToken = ++_sessionsReqToken;
        $.get('/web/chat/sessions' + q, function(resp) {
            try {
                // 已有更新的加载请求发出 → 本次响应过期，丢弃
                if (myToken !== _sessionsReqToken) return;
                chatHistory = toSessionEntries(resp.data, codeScope || 'local');
                updateHistoryUI();
                updateHistoryScopeBar();
                restoreActiveSession();
            } catch (e) {}
        });
        return;
    }
    // chat 模式（并存语义：本地+远端双源合并）：先拉本地登记表（__scope=local 恒本地），
    // 连着远端时再拉远端那份（__scope=id:<rid>）；两份合并后，对 global（不带 root）与
    // 每个 project.path 并行发会话请求——远端项目的请求带 __scope=id 让代理路由到该
    // 连接（root= 参数代理本就按 by_cwd 分流，双保险）。全部完成后汇总（任一路失败
    // 记为空数组，不阻塞其它路）。
    var myToken2 = ++_sidebarReqToken;
    /* 在线连接 id 列表（方案B 扇出）：旧版只拉单个 activeId，连第二台后第一台的
       项目/会话从侧栏整个消失（用户看到的「同时只能有一台」）。无 __GOURD_REMOTE__
       时降级单 activeId（无壳/浏览器/旧壳不退化）。 */
    var connIds = [];
    /* 本轮连接表快照：扇出拉数据与分组渲染（组序/在线态）必须用同一份，否则连接刚断
       的瞬间会出现「有数据的组画不出来 / 画出来的组没有数据」。变化交给
       connections-changed 触发新一轮加载，令牌会把本轮响应整个丢弃。 */
    var connSnap = [];
    var remoteApi = window.__GOURD_REMOTE__;
    if (remoteApi && typeof remoteApi.list === 'function') {
        var conns = remoteApi.list() || [];
        for (var ci = 0; ci < conns.length; ci++) {
            var cid = conns[ci] && conns[ci].connectionId;
            if (!cid || connIds.indexOf(cid) >= 0) continue;
            connIds.push(cid);
            /* 只认 connected：探活掉线/重连中一律按 down 画（红点 + 条目置灰保留） */
            connSnap.push({
                id: cid,
                state: (conns[ci].state === 'connected') ? 'connected' : 'down',
                label: conns[ci].label || remoteHostLabel(cid)
            });
        }
    } else {
        /* 读口不存在（旧桌面壳 / 浏览器直开）降级单 activeId = 本次改造前的形态。
           WHY 不直接空表：读口缺失只说明壳旧，不代表没连远端；空表会让远端项目整片
           从侧栏消失，比少画一个分组严重得多。 */
        var onlyRid = (typeof window.__GOURD_REMOTE_ACTIVE_ID__ === 'function')
            ? window.__GOURD_REMOTE_ACTIVE_ID__() : null;
        if (onlyRid) {
            connIds.push(onlyRid);
            connSnap.push({ id: onlyRid, state: 'connected', label: remoteHostLabel(onlyRid) });
        }
    }
    $.get('/web/chat/projects?__scope=local', function (resp) {
        if (myToken2 !== _sidebarReqToken) return;
        _sidebarLoadFailed = false;
        var plist = (resp && resp.data) ? resp.data : [];
        var startMerge = function (extraLists) {
            if (myToken2 !== _sidebarReqToken) return;
            var projects = [];
            var seen = {};
            var i, pkey;
            var pushList = function (list, scope) {
                var label = remoteHostLabel(scope);   // 本地 scope 返回空串
                for (var k = 0; k < list.length; k++) {
                    if (!list[k] || !list[k].path) continue;
                    // 归一必须走全局 pathScopeKey（仅 Windows 路径降大小写）：无条件
                    // lower 会把 /home/u/Proj（本地）与 /home/u/proj（远端）当作同一个
                    // 去重掉，两个真实存在的不同目录就少了一个（Linux/macOS）
                    // 【方案B】去重键叠加 scope：同路径跨来源并存（两台同名目录是
                    // 两个真实工作区，选中时按条目 _scope 精确绑定，不再二选一）。
                    pkey = pathScopeKey(list[k].path) + '@' + (scope || 'local');
                    if (seen[pkey]) continue;   // 同一来源内重复路径去重
                    seen[pkey] = true;
                    projects.push({
                        name: list[k].name || historyScopeBaseName(list[k].path || ''),
                        path: list[k].path || '',
                        sessions: [],
                        _scope: scope,
                        /* 主机展示名：项目行 title 靠它区分同屏的本地/远端条目
                           （_scope 是 rc-host:port:user 内部键，不能直接给用户看）。 */
                        _scopeHost: label
                    });
                }
            };
            pushList(plist, 'local');
            for (var xi = 0; xi < extraLists.length; xi++) pushList(extraLists[xi].list, extraLists[xi].scope);
            var globalSessions = [];
            /* 全局会话分桶（契约 §5.3）：按 scope 各存一份，项目 tab 组顶「全局对话」
               子节按桶渲染。桶里与 globalSessions 装的是同一批对象引用，删/改一处两处同步。 */
            var globalByScope = {};
            /* 全局会话扇出：本地一路 + 每在线连接一路（对话 tab 的合并数据源）。
               pending 动态化：1(global 本地) + connIds.length(global 远端) + projects.length。 */
            var pending = 1 + connIds.length + projects.length;
            var onOneDone = function () {
                if (--pending === 0) {
                    /* 合并后全局会话按时间倒序（多源各自有序，合并后需重排）；
                       必须在 finalize 消费前同步排好（异步排会晚于渲染）。 */
                    globalSessions.sort(function (a, b) { return (b.time || 0) - (a.time || 0); });
                    finalizeSidebar(myToken2, projects, globalSessions, {
                        conns: connSnap,
                        globalByScope: globalByScope
                    });
                }
            };
            $.get('/web/chat/sessions?__scope=local', function (resp) {
                if (myToken2 === _sidebarReqToken) {
                    var arrLocal = toSessionEntries(resp && resp.data, 'local');
                    globalByScope[wsScopeKey('local')] = arrLocal;
                    globalSessions = globalSessions.concat(arrLocal);
                }
                onOneDone();
            }).fail(onOneDone);
            for (var gi = 0; gi < connIds.length; gi++) {
                (function (gid) {
                    $.get('/web/chat/sessions?__scope=id:' + encodeURIComponent(gid), function (r2) {
                        if (myToken2 === _sidebarReqToken) {
                            var arrRemote = toSessionEntries(r2 && r2.data, gid);
                            globalByScope[wsScopeKey(gid)] = arrRemote;
                            globalSessions = globalSessions.concat(arrRemote);
                        }
                        onOneDone();
                    }).fail(onOneDone);
                })(connIds[gi]);
            }
            for (var pi = 0; pi < projects.length; pi++) {
                (function (proj) {
                    var scopeQ = (proj._scope && proj._scope !== 'local')
                        ? '&__scope=id:' + encodeURIComponent(proj._scope) : '&__scope=local';
                    $.get('/web/chat/sessions?root=' + encodeURIComponent(proj.path) + scopeQ, function (resp) {
                        if (myToken2 === _sidebarReqToken) proj.sessions = toSessionEntries(resp && resp.data, proj._scope);
                        onOneDone();
                    }).fail(onOneDone);
                })(projects[pi]);
            }
        };
        if (!connIds.length) { startMerge([]); return; }
        /* 每在线连接一路补拉项目登记表（某路失败只少那台条目） */
        var extras = [];
        var remDone = 0;
        var onRemDone = function () {
            if (++remDone === connIds.length) startMerge(extras);
        };
        for (var ri = 0; ri < connIds.length; ri++) {
            (function (rid2) {
                $.get('/web/chat/projects?__scope=id:' + encodeURIComponent(rid2), function (r2) {
                    if (myToken2 === _sidebarReqToken) extras.push({ scope: rid2, list: (r2 && r2.data) ? r2.data : [] });
                    onRemDone();
                }).fail(function () { extras.push({ scope: rid2, list: [] }); onRemDone(); });
            })(connIds[ri]);
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
    /* 分组桶必须同步删：项目 tab 组顶的「全局对话」子节从桶渲染，只删合并列表的话
       已删会话会在项目 tab 上继续挂着（用户看到「明明删了还在」，再点进去就是 404）。 */
    var byScope = _sidebarData.globalByScope || {};
    for (var bkey in byScope) {
        if (!Object.prototype.hasOwnProperty.call(byScope, bkey)) continue;
        var bucket = byScope[bkey] || [];
        for (var b = bucket.length - 1; b >= 0; b--) {
            if (bucket[b].sessionId === sessionId) bucket.splice(b, 1);
        }
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
    /* 归属 scope：远端项目的会话必须打到登记它的连接（代理按 by_cwd 的 root 分流
       本可自动命中，但全局会话（无 root）无键可查——远端全局会话必须显式声明；
       本地侧一律 __scope=local，防激活 scope 指向远端时误路由）。 */
    var scope = sessionScopeOf(entry);
    var scopeQ = (scope && scope !== 'local')
        ? '&__scope=id:' + encodeURIComponent(scope) : '&__scope=local';
    return (r ? '&root=' + encodeURIComponent(r) : '') + scopeQ;
}
/* 会话条目的归属连接（'local' 或 connectionId）：侧栏合并列表后条目带 _scope；
   查不到（全局会话未带/旧数据）时保守视为本地。

   【已删死引用 __scopeOfRemoteRoot】旧实现在 _scope 缺失时调它反查归属，但全仓
   从未定义过该函数（只写不定义的幽灵接口，与上轮抓到的 refreshRemoteBadge 同型）。
   typeof 守卫使它不报错，但这条分支永远进不去：看起来「查不到还能再救一下」，
   实际什么都没做。保守回本地是唯一真实语义（且侧栏条目本就都带 _scope）。 */
function sessionScopeOf(entry) {
    if (entry && entry._scope) return entry._scope;
    return 'local';
}

/* ===== Chat 侧栏条目渲染（tab 视图：项目树 / 对话平铺；code 模式平铺）===== */

/* 拖动排序（2026-11 用户诉求：左侧的任务和项目空间可以拖着排序）。
   顺序层是独立 UMD 模块：纯函数可单测、localStorage 只存本机展示顺序、不改后端数据。
   app-bootstrap.js 保证它在本文件之前加载；此处做一次防御式兜底，避免旧壳/单测
   未加载该脚本时整份侧栏渲染抛错（DnD 降级为不可用，原有功能不受影响）。 */
var GourdSidebarOrder = window.GourdSidebarOrder || null;

/* 【架构】drop 只把「当前容器内的 id 顺序」写进 localStorage，然后触发一次重绘；
   重绘时（buildSidebar / updateHistoryUI）统一用 sortBySaved 把内存数组按保存顺序排好，
   再生成 HTML。好处：拖拽全程不改动 DOM 结构（只加 data-drag-* 属性与行内手柄），
   因此 .proj-node.expanded + .proj-sessions、.ws-group-head ~ .ws-group-body
   这些兄弟选择器完全不受影响；排序逻辑也全部收敛到纯函数，可单测。
   无保存记录时 sortBySaved 返回原数组引用 —— 默认展示逐字不变（执行中置顶 + 时间倒序）。

   稳定 id 与容器 key 分开：
   - 项目 id：沿用 pushList 去重的 pathScopeKey(path) + '@' + scope —— 同名目录分属
     两台机器时不会串。
   - 会话 id：sessionId（后端唯一）；缺 id 时回落 label|time，只影响极端脏数据。
   - 分组 id：DOM 的 data-scope（'local' / 'id:<rid>'）。
   容器 key 与 DOM 的「同父」边界一一对应：drop 时 rowsOf(parent,type) 只收集同父同类行，
   所以同一 key 只能被同一个容器写入，不会串到别的项目 / 别的 tab。 */
function sidebarOrder() { return window.GourdSidebarOrder || GourdSidebarOrder; }
function projectScopeOf(proj) {
    return (proj && proj._scope && proj._scope !== 'local') ? proj._scope : 'local';
}
function projectOrderId(proj) {
    return pathScopeKey(proj.path) + '@' + projectScopeOf(proj);
}
function projectContainerKeyOfScope(scopeKey) { return 'projects@' + scopeKey; }
function sessionOrderId(entry) {
    return (entry && entry.sessionId) ? String(entry.sessionId)
        : ('noid:' + ((entry && entry.label) || '') + '|' + ((entry && entry.time) || 0));
}
function sessionContainerKeyForProject(proj) { return 'sessions@' + projectOrderId(proj); }
function sessionContainerKeyForScope(scopeKey) { return 'sessions@' + scopeKey; }
/* 对话 tab / code 平铺：会话行直接挂在 #historyList 下，全体同父 = 一个容器。 */
function sessionContainerKeyFlat() { return 'sessions@__flat'; }
/* 会话所在容器的顺序 key：由渲染处按归属写入 window.__sidebarSessionKey。
   项目树内 = sessions@<项目稳定 id>；远端「全局对话」子节 = sessions@<scopeKey>；
   对话 tab / code 平铺 = sessions@__flat。会话行渲染是共用的 sidebarItemHtml(i)，
   靠这个当前值区分容器，避免把 A 项目的拖拽顺序串到 B 项目。 */
function currentSessionOrderKey() {
    return window.__sidebarSessionKey || sessionContainerKeyFlat();
}
function applySessionOrder(entries, key) {
    var SO = sidebarOrder();
    if (!SO) return entries;
    /* unknownFirst=true：新会话/新登记项目仍置顶，符合「最近使用置顶」的既有语义 */
    return SO.sortBySaved(entries, key, sessionOrderId, true);
}
function applyProjectOrder(items, key) {
    var SO = sidebarOrder();
    if (!SO) return items;
    return SO.sortBySaved(items, key, projectOrderId, true);
}
function applyGroupOrder(groups) {
    var SO = sidebarOrder();
    if (!SO) return groups;
    /* unknownFirst=false：拖过的组按用户顺序在前，新连接稳定追加末尾 */
    return SO.sortBySaved(groups, 'groups', function (g) { return g.scopeKey; }, false);
}
function dragTitle() { return GourdI18n.t('app.sidebar.drag_to_sort'); }
function withSessionContainer(key, fn) {
    var prev = window.__sidebarSessionKey;
    window.__sidebarSessionKey = key;
    try { return fn(); } finally { window.__sidebarSessionKey = prev; }
}

/* 拖拽手柄：只认「按住手柄」才发起 HTML5 拖拽（见 app-sidebar-order.js 的 mousedown 绑定）。
   手柄一律塞进该行【已有的】操作区（.item-actions / .proj-actions / .ws-group-acts），
   绝不新增兄弟节点。role=button + tabindex 让它键盘可达；不写 draggable 属性——
   那是 mousedown 命中手柄时才临时加的。 */
function dragHandleHtml(type, title) {
    var SO = sidebarOrder();
    if (!SO) return '';
    return '<span class="sidebar-drag-handle" data-drag-handle="' + escAttr(type) + '"'
        + ' role="button" tabindex="0" title="' + escAttr(title) + '" aria-label="' + escAttr(title) + '">'
        + '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">'
        + '<circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/>'
        + '<circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>'
        + '<circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>'
        + '</svg></span>';
}
/* 行的拖拽元数据。type 决定同容器判定，key 决定存哪份顺序，id 是稳定标识。
   模块未加载时不输出任何属性，DOM 与改造前逐字一致。 */
function dragRowAttrs(type, key, id) {
    var SO = sidebarOrder();
    if (!SO) return '';
    return ' data-drag-type="' + escAttr(type) + '" data-drag-key="' + escAttr(key) + '"'
        + ' data-drag-id="' + escAttr(id) + '"';
}

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
    /* 远端会话标识（并存语义）：合并列表后远端条目打 data-remote（CSS 小徽） */
    var isRemote = !!(chatHistory[i]._scope && chatHistory[i]._scope !== 'local');
    if (isRemote) cls += ' remote';

    /* 容器 key 由 buildSidebar / updateHistoryUI 的 withSessionContainer 写入当前值：
       项目树内各项目、全局子节、对话 tab 平铺各自独立，互不串序。 */
    var sKey = currentSessionOrderKey();
    var sId = sessionOrderId(chatHistory[i]);

    var html = '<div class="' + cls + '" data-idx="' + i + '"' + (isRemote ? ' data-remote="1"' : '')
        + dragRowAttrs('session', sKey, sId) + '>';
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
    // 拖动手柄并入已有操作区：不新增兄弟节点，.proj-node.expanded + .proj-sessions 不受影响
    html += '<span class="item-actions">'
        + dragHandleHtml('session', dragTitle())
        + '<button class="item-action-btn sidebar-item-rename" title="' + escAttr(GourdI18n.t('history.rename')) + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>'
        + '<button class="item-action-btn sidebar-item-del" title="' + escAttr(GourdI18n.t('history.delete_session')) + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
        + '</span>'
        + '</div>';
    return html;
}


/* 项目文件夹行：chevron + folder 图标 + 名称（点击切换展开，见列表点击委托）。
   右侧悬浮操作组 .proj-actions：新建任务 / 进入专注模式 / 重命名显示名 / 从列表移除（样式见 app.css）。 */
function projNodeHtml(path, name, expanded) {
    /* 远端项目行同样打 data-remote 小徽（buildSidebar 按 _scope 判断后传入）；
       title 附主机名，使「同名目录分属两台机器」在悬停时可区分。 */
    var hostLabel = projNodeHostLabel(path);
    var nodeTitle = path + (hostLabel ? (' · ' + hostLabel) : '');
    /* 项目行的容器 = 所属分组的 scope（同组内拖动）；id 用 path@scope 稳定去重。 */
    var pScope = projNodeScopeOf(path);
    var pKey = projectContainerKeyOfScope(wsScopeKey(pScope));
    var pId = pathScopeKey(path) + '@' + pScope;
    return '<div class="proj-node' + (expanded ? ' expanded' : '') + '" data-proj="' + escAttr(path) + '"' + (projNodeIsRemote(path) ? ' data-remote="1"' : '')
        + dragRowAttrs('project', pKey, pId) + ' title="' + escAttr(nodeTitle) + '">'
        + '<svg class="proj-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>'
        + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
        + '<span class="proj-name">' + escapeHtml(name || '') + '</span>'
        + '<span class="proj-actions">'
        + dragHandleHtml('project', dragTitle())
        + '<button class="proj-action-btn proj-new-chat" title="' + escAttr(GourdI18n.t('app.sidebar.new_task')) + '">'
        + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
        + '</button>'
        + '<button class="proj-action-btn proj-open-code" title="' + escAttr(GourdI18n.t('app.sidebar.open_in_code')) + '">'
        + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>'
        + '</button>'
        + '<button class="proj-action-btn proj-rename" title="' + escAttr(GourdI18n.t('app.sidebar.rename_project')) + '">'
        + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>'
        + '</button>'
        + '<button class="proj-action-btn proj-remove" title="' + escAttr(GourdI18n.t('app.sidebar.remove_project')) + '">'
        + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
        + '</button>'
        + '</span>'
        + '</div>';
}

/* 项目行是否远端（buildSidebar 的 _sidebarData.projects 带 _scope；查不到视为本地） */
function projNodeIsRemote(path) {
    if (!_sidebarData || !_sidebarData.projects) return false;
    for (var i = 0; i < _sidebarData.projects.length; i++) {
        if (_sidebarData.projects[i].path === path) {
            return !!(_sidebarData.projects[i]._scope && _sidebarData.projects[i]._scope !== 'local');
        }
    }
    return false;
}

/* 项目行 title 的主机名后缀（同屏双源时的区分线索，对标 ZCode 的
   formatRemoteWorkspaceDisplayLabel）。合并列表时就已把 _scopeHost 算好存在
   _sidebarData 上，这里只取；拿不到回空串（不展示 connectionId 内部键）。 */
function projNodeHostLabel(path) {
    if (!_sidebarData || !_sidebarData.projects) return '';
    for (var i = 0; i < _sidebarData.projects.length; i++) {
        if (_sidebarData.projects[i].path === path) {
            return _sidebarData.projects[i]._scopeHost || '';
        }
    }
    return '';
}

/* 项目行的归属连接（'local' / connectionId）：供同族写操作（rename / remove）显式
   声明分流。侧栏渲染的项目必定在 _sidebarData 里且带 _scope（pushList 无条件设），
   故查不到只可能是异常态——保守回本地（宁可不改远端，也不把写操作打到错机器）。 */
function projNodeScopeOf(path) {
    if (!_sidebarData || !_sidebarData.projects) return 'local';
    for (var i = 0; i < _sidebarData.projects.length; i++) {
        if (_sidebarData.projects[i].path === path) {
            var s = _sidebarData.projects[i]._scope;
            return (s && s !== 'local') ? s : 'local';
        }
    }
    return 'local';
}

/* 归属 → 路由 query（与 app-code.scopeQueryFor 同口径）：写操作一律显式声明，
   不声明就落到代理的「激活 scope 兑底」，而它随用户选择漂移。 */
function projScopeQuery(scope) {
    return (scope && scope !== 'local')
        ? '?__scope=id:' + encodeURIComponent(scope)
        : '?__scope=local';
}

/* Sidebar event delegation — single listener instead of per-item binding */
$(historyList).on('click', function(e) {
    var $target = $(e.target);
    /* 拖动手柄：显式在本委派最先拦掉，不依赖 jQuery「委托 handler 先于直接 handler、
       stopPropagation 切断后续分组」的内部 dispatch 细节。手柄是 span[role=button]，
       点它会冒泡到这里被当成「展开项目 / 选中会话」；拖拽结束 mouseup→click 那一下
       尤其容易误触。stopPropagation 同时挡住 document 上「点别处关闭浮层」类委派。 */
    if ($target.closest('.sidebar-drag-handle').length) {
        e.stopPropagation();
        e.preventDefault();
        return;
    }
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
    // 项目行「重命名」：原位编辑显示名（须置于 proj-node 分支之前，避免被展开/收起吸收）
    var $projRename = $target.closest('.proj-rename');
    if ($projRename.length) {
        var rnp = $projRename.closest('.proj-node').attr('data-proj');
        if (rnp) startProjectRename(rnp);
        return;
    }
    // 项目行「从列表移除」：仅解除登记，不删除磁盘目录（须置于 proj-node 分支之前）
    var $projDel = $target.closest('.proj-remove');
    if ($projDel.length) {
        var dp = $projDel.closest('.proj-node').attr('data-proj');
        /* 传入本侧栏已知的归属（_sidebarData 的 _scope）：app-code 的 projects 副本
           在从未进过 code 模式时尚未加载，它会回落激活环境——删本地项目却打到远端。 */
        if (typeof window.removeProjectFromList === 'function') window.removeProjectFromList(dp, projNodeScopeOf(dp));
        return;
    }
    // 项目文件夹节点：切换展开/收起（置于 del/rename/item 分支之前）
    var $proj = $target.closest('.proj-node');
    if ($proj.length) {
        // 重命名输入框上的点击不参与展开/收起（列表重建会打断编辑）
        if ($target.closest('.sidebar-rename-input').length) return;
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
            // code 模式或聚合数据未到达：原平铺列表（同父 = 一个容器）
            html = withSessionContainer(sessionContainerKeyFlat(), function () {
                /* 用「有序索引」渲染而非改 chatHistory 本身：code 模式的 chatHistory
                   由 toSessionEntries 直接赋值、未经 buildSidebar，若原地重排会让
                   selectSession/deleteSession 的下标契约错位。sortBySaved 对下标数组
                   排序，data-idx 仍是原下标，行为完全兼容。 */
                var SO = sidebarOrder();
                var indices = [];
                for (var n = 0; n < chatHistory.length; n++) indices.push(n);
                if (SO) indices = SO.sortBySaved(indices, sessionContainerKeyFlat(), function (ix) {
                    return sessionOrderId(chatHistory[ix]);
                }, true);
                var out = '';
                for (var m = 0; m < indices.length; m++) out += sidebarItemHtml(indices[m]);
                return out;
            });
        }
        var $list = $(historyList);
        // 仅当 HTML 真正变化时才写入 DOM，避免无效重排
        if ($list.html() !== html) {
            $list.html(html);
            // 列表重建后按当前搜索关键字重新过滤，避免过滤态丢失
            if (typeof window.reapplySidebarFilter === 'function') window.reapplySidebarFilter();
        }
        // 「展开/收起全部」按钮：图标/提示/显隐随项目树状态同步（点按钮、单项目开合、新建任务后均经此处刷新）
        updateExpandAllBtn();
        // Code 模式：同步右栏会话下拉
        if (window.appMode === 'code' && typeof window.renderCodeSessions === 'function') {
            window.renderCodeSessions();
        }
        // 标题栏「当前任务名」：列表重绘即 label 可能变（首条消息定名/重命名/删除），
        // 在此汇聚刷新，避免各处调用方各自记得同步（typeof 守卫同 updateMessageQueueUI 纪律）
        if (typeof window.renderTitlebarTask === 'function') window.renderTitlebarTask();
    });
}

/* ===== 拖放绑定（一次性委托，绑定在静态 #historyList 上）=====
   innerHTML 重建不会丢事件：所有 drag 事件都冒泡到这个容器。drop 只写顺序 +
   触发 updateHistoryUI 重绘（重绘时 buildSidebar 用 sortBySaved 应用新顺序）。
   模块未加载时完全不绑定 —— 旧壳/单测降级为「不可拖动」，渲染不受影响。 */
(function bindSidebarOrder() {
    var SO = sidebarOrder();
    if (!SO || !historyList) return;
    SO.bind(historyList, function () { updateHistoryUI(); });
})();

/* 手柄 click 已在上方行点击委派开头显式 early return 拦截（见 740 行附近）；
   这里不再重复注册委托 handler，避免同一事件被处理两次、也避免依赖 jQuery 的
   委托 dispatch 顺序（不同 jQuery 版本行为不保证一致）。 */

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

/* ================= 分组树辅助（契约 §5） ================= */

/* scope（'local' | connectionId）→ DOM data-scope 与持久化共用的 scope 串。
   契约 §5.1 明确远端组用 'id:<rid>' 形态（与 WS 池 scopeKey、__scope=id: 同口径）；
   写裸 connectionId 会让「分组键」与全站其它归属键不同型，跨模块比对必然踩空。 */
function wsScopeKey(scope) {
    return (!scope || scope === 'local') ? 'local' : ('id:' + scope);
}
/* data-scope 串 → connectionId（'local' 返回 null） */
function wsScopeId(scopeKey) {
    return (!scopeKey || scopeKey === 'local') ? null : scopeKey.replace(/^id:/, '');
}

/* 组标题：本地组用 remote.group_local；远端组用连接展示名（user@host）。
   拿不到展示名时回落 remote.badge（「远程」）——绝不回落 connectionId：
   那是 rc-host:port:user 形态的内部键，给用户看等于没给信息。 */
function wsGroupLabelOf(conn) {
    if (!conn) return GourdI18n.t('remote.group_local');
    return conn.label || remoteHostLabel(conn.id) || GourdI18n.t('remote.badge');
}

var LS_WS_GROUP_COLLAPSED = 'gourdai-wsgroup-collapsed';
/* 折叠态持久化（契约 §5.2）：JSON 数组 of scope 串。记「已折叠」而不是「已展开」——
   默认展开是常态，数组里只留用户手动收起的少数组，新连接进来天然是展开态，无需补记录。 */
function wsGroupCollapsedSet() {
    try {
        var v = JSON.parse(localStorage.getItem(LS_WS_GROUP_COLLAPSED) || '[]');
        return Object.prototype.toString.call(v) === '[object Array]' ? v : [];
    } catch (e) { return []; }
}
function wsGroupCollapsed(scopeKey) {
    return wsGroupCollapsedSet().indexOf(scopeKey) >= 0;
}
function wsGroupToggle(scopeKey) {
    var set = wsGroupCollapsedSet();
    var i = set.indexOf(scopeKey);
    if (i >= 0) set.splice(i, 1); else set.push(scopeKey);
    try { localStorage.setItem(LS_WS_GROUP_COLLAPSED, JSON.stringify(set)); } catch (e) {}
}

/* 组序（契约 §5.1）：本地组恒第一（哪怕本地一个项目都没有——它是常驻组，藏掉会让
   侧栏空掉）→ 在线连接按 list() 序 → 仍有项目残留的掉线连接（dot=down，置灰保留）。
   WHY 掉线组保留：连接抖一下就让整台机器的工作区凭空消失，用户会以为登记丢了；
   置灰 + 红点表达的是「暂时不可达」，语义完全不同。
   返回 [{ scopeKey, conn, state, label, items:[project], globals:[entry], meta:[] }] */
function wsGroupOrder(projects) {
    var conns = (_sidebarData && _sidebarData.conns && _sidebarData.conns.length !== undefined)
        ? _sidebarData.conns : [];
    var byScope = (_sidebarData && _sidebarData.globalByScope) || {};
    var groups = [];
    var indexOf = {};
    var addGroup = function (scopeKey, conn) {
        var g = {
            scopeKey: scopeKey,
            conn: conn,
            state: conn ? (conn.state === 'connected' ? 'connected' : 'down') : 'local',
            label: wsGroupLabelOf(conn),
            items: [],
            /* 「全局对话」子节只给远端组：本地全局对话已由「对话」tab 承载，再进分组树
               就是同一批条目在两个 tab 各画一遍（用户拍板：全局对话还是对话）。 */
            globals: conn ? (byScope[scopeKey] || []) : [],
            meta: [],
            globalStart: 0,
            globalCount: 0
        };
        indexOf[scopeKey] = g;
        groups.push(g);
        return g;
    };
    addGroup('local', null);
    for (var c = 0; c < conns.length; c++) addGroup(wsScopeKey(conns[c].id), conns[c]);
    for (var p = 0; p < projects.length; p++) {
        var key = wsScopeKey(projects[p]._scope);
        var g2 = indexOf[key];
        if (!g2) {
            /* 项目归属的连接已不在本轮快照里（刚断开、重载还没跑完）：兜进本地组会把它
               标成「本机目录」，后续写操作会打到错的机器上——宁可单立一个 down 组。 */
            g2 = addGroup(key, { id: wsScopeId(key), state: 'down', label: remoteHostLabel(wsScopeId(key)) });
        }
        g2.items.push(projects[p]);
    }
    return groups;
}

/* 组顶「全局对话」子节（契约 §5.3）：这台远端上「没选工作区」的对话。
   与「对话」tab 的全局列表互不影响——那边是本地+远端合并态，这边只装该连接那份。 */
function wsGroupGlobalHtml(g) {
    if (!g.conn || !g.globalCount) return '';
    /* 子节折叠态只存内存：契约只要求分组本身持久化，子节默认展开。 */
    var collapsed = !!_wsGlobalCollapsed[g.scopeKey];
    var html = '<div class="ws-group-global' + (collapsed ? ' ws-group-global-collapsed' : '') + '"'
        + ' data-scope="' + escAttr(g.scopeKey) + '">'
        + '<button type="button" class="ws-group-global-head" aria-expanded="' + (collapsed ? 'false' : 'true') + '">'
        + '<span class="ws-group-caret"></span>'
        + '<span class="ws-group-global-label">' + escapeHtml(GourdI18n.t('remote.group_global')) + '</span>'
        + '<span class="ws-group-count">' + g.globalCount + '</span>'
        + '</button>'
        + '<div class="ws-group-global-body">';
    for (var i = g.globalStart; i < g.globalStart + g.globalCount; i++) html += sidebarItemHtml(i);
    return html + '</div></div>';
}

/* 分组 DOM（契约 §5.1 逐字对齐）：
   .ws-group[data-scope] > button.ws-group-head[aria-expanded] >
       .ws-group-caret + .ws-group-dot[data-state] + .ws-group-label + .ws-group-count
   后接 .ws-group-body（组顶「全局对话」子节 + 现有项目行）。
   head 用 <button> 而不是 <div>：开合在可访问性语义上就是按钮（键盘可达 + 读屏播报），
   aria-expanded 必须与折叠态同步——读屏与契约测试都只认这个属性。
   count 报项目数：这一行回答的是「这台机器上我登记了几个工作区」。 */
/* 分组头快捷动作（2026-10-16 用户诉求）：不必回主页工作区下拉，在分组头上直接
   「＋」新增本组归属的工作空间。本地组 = 本机对话框 + __scope=local 登记；
   在线远端组 = 浏览该台远端磁盘 + __scope=id:<rid> 登记（与下拉入口同机闭合）。
   掉线组不渲染「＋」（browse 必失败，给了入口只会撞墙）；远端组另带「⋯」
   连接动作菜单（同步镜像/重连/断开）——徽标下线后这是连接级动作的唯一入口。
   按钮是 head（<button>）内的嵌套交互元素：HTML 不允许 button 套 button，
   故用 span[role=button] + tabindex，键盘可达性由 role 承担。 */
function wsGroupActsHtml(g) {
    var isLocal = !g.conn;
    var isDown = !isLocal && g.state === 'down';
    var addTitle = GourdI18n.t('remote.group_add');
    var html = '<span class="ws-group-acts">';
    /* 分组拖动手柄并入已有操作区（acts 是 head 的兄弟，绝对定位）：不新增兄弟节点，
       .ws-group-head[aria-expanded] ~ .ws-group-body 的通用兄弟规则不受影响。 */
    html += dragHandleHtml('group', dragTitle());
    if (!isDown) {
        html += '<span class="ws-group-act ws-group-add" role="button" tabindex="0"'
            + ' data-scope="' + escAttr(g.scopeKey) + '" title="' + escAttr(addTitle) + '"'
            + ' aria-label="' + escAttr(addTitle) + '">'
            + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
            + '</span>';
    }
    if (!isLocal) {
        var moreTitle = GourdI18n.t('remote.group_actions');
        html += '<span class="ws-group-act ws-group-more" role="button" tabindex="0"'
            + ' data-conn="' + escAttr(g.conn.id) + '" title="' + escAttr(moreTitle) + '"'
            + ' aria-label="' + escAttr(moreTitle) + '">'
            + '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>'
            + '</span>';
    }
    return html + '</span>';
}

function wsGroupHtml(g) {
    var isLocal = !g.conn;
    var isDown = !isLocal && g.state === 'down';
    var collapsed = wsGroupCollapsed(g.scopeKey);
    var html = '<div class="ws-group' + (collapsed ? ' ws-group-collapsed' : '')
        + (isDown ? ' ws-group-down' : '') + '"'
        + ' data-scope="' + escAttr(g.scopeKey) + '"'
        + dragRowAttrs('group', 'groups', g.scopeKey)
        + (isDown ? ' data-state="down"' : '') + '>'
        + '<button type="button" class="ws-group-head" aria-expanded="' + (collapsed ? 'false' : 'true') + '"'
        + ' title="' + escAttr(g.label) + '">'
        + '<span class="ws-group-caret"></span>'
        + '<span class="ws-group-dot" data-state="' + escAttr(g.state) + '"></span>'
        + '<span class="ws-group-label">' + escapeHtml(g.label) + '</span>'
        + '<span class="ws-group-count">' + g.items.length + '</span>'
        + '</button>'
        /* acts 是 head 按钮的【兄弟节点】（绝对定位盖在组头右上）而不是塞进
           button 内部：① <button> 的内容模型禁止交互后代（span[role=button]
           塞进去是非法 HTML，读屏会播报嵌套按钮）；② 兄弟定位后点击天然不
           经过 head 的折叠委派，不需要 stopPropagation 防误折叠。 */
        + wsGroupActsHtml(g)
        + '<div class="ws-group-body">';
    /* 组顶「全局对话」子节：会话容器 = sessions@<scopeKey> */
    html += withSessionContainer(sessionContainerKeyForScope(g.scopeKey), function () {
        return wsGroupGlobalHtml(g);
    });
    for (var i = 0; i < g.meta.length; i++) {
        var pm = g.meta[i];
        html += projNodeHtml(pm.path, pm.name, !!_projExpanded[pm.path]);
        // 子列表始终入 DOM（收起态由 CSS 控制），保证搜索可过滤折叠项目的会话
        if (pm.count > 0) {
            /* 每个项目是独立容器：drop 时 rowsOf 只收集这个 .proj-sessions 下的行 */
            html += '<div class="proj-sessions">';
            html += withSessionContainer(pm.sessionKey || sessionContainerKeyFlat(), (function (s, e) {
                return function () {
                    var out = '';
                    for (var j = s; j < s + e; j++) out += sidebarItemHtml(j);
                    return out;
                };
            })(pm.start, pm.count));
            html += '</div>';
        }
    }
    /* 在线但 0 项目的远端组：留占位而不是整组消失，否则用户分不清「这台没有工作区」
       与「这台没连上/渲染挂了」（契约 §5.1）。本地组不占位：改造前本地空列表本就
       什么都不画，凭空多一行灰字反而是新噪声。 */
    if (!isLocal && !g.meta.length && !g.globalCount) {
        html += '<div class="ws-group-empty">' + escapeHtml(GourdI18n.t('remote.group_empty')) + '</div>';
    }
    return html + '</div></div>';
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
    var groups = [];
    var i, j, k;

    // —— 第一遍：按渲染顺序构建平铺（仅会话条目）——
    if (scope === 'project') {
        /* 项目 tab = 分组树（契约 §5.1）：组序本地第一、远端按连接表序；组内顺序 =
           组顶「全局对话」子节在前（§5.3），其后是该 scope 的项目行。
           平铺必须包含子节里的会话：selectSession/deleteSession/startRename 全部按
           chatHistory 下标定位，漏进去就等于那些会话点不开、也删不掉。 */
        groups = applyGroupOrder(wsGroupOrder(projects));
        for (i = 0; i < groups.length; i++) {
            var g = groups[i];
            g.globalStart = flat.length;
            var gl = applySessionOrder(sortSidebarEntries(g.globals || []), sessionContainerKeyForScope(g.scopeKey));
            for (j = 0; j < gl.length; j++) flat.push(gl[j]);
            g.globals = gl;
            g.globalCount = gl.length;
            /* 分组内的项目行：按该 scope 保存的顺序重排（同组内拖动） */
            g.items = applyProjectOrder(g.items, projectContainerKeyOfScope(g.scopeKey));
            for (j = 0; j < g.items.length; j++) {
                var proj = g.items[j];
                var start = flat.length;
                // 项目内执行中的任务置顶，其余按最近活动时间倒序；再叠加用户自定义顺序
                var ss = applySessionOrder(sortSidebarEntries(proj.sessions || []), sessionContainerKeyForProject(proj));
                for (k = 0; k < ss.length; k++) flat.push(ss[k]);
                g.meta.push({ path: proj.path, name: proj.name, start: start, count: ss.length,
                    sessionKey: sessionContainerKeyForProject(proj), scopeKey: g.scopeKey });
            }
        }
    } else {
        /* 对话 tab：仅全局会话（非工作空间下），执行中的任务置顶，其余按 time 倒序。
           【零改动 · 契约 §5.4】分组树只组织项目/工作区，全局对话仍在这里平铺。 */
        for (i = 0; i < global.length; i++) flat.push(global[i]);
        flat = applySessionOrder(sortSidebarEntries(flat), sessionContainerKeyFlat());
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
        /* 2026-10-11 用户反馈：「这个项目不要，本身上面就有项目了，下面这个重复了。
           tab 名就叫「项目」，组头又全是机器名/本地，这行 section-title 纯重复占位，删。 */
        /* wsGroupHtml 内部按「全局子节 / 各项目 proj-sessions」分别切换
           __sidebarSessionKey，让共用的 sidebarItemHtml 落到正确容器。 */
        for (i = 0; i < groups.length; i++) html += wsGroupHtml(groups[i]);
    } else {
        html += withSessionContainer(sessionContainerKeyFlat(), function () {
            var out = '';
            for (var n = 0; n < flat.length; n++) out += sidebarItemHtml(n);
            return out;
        });
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

/* ===== 分组交互：折叠 / 子节折叠 / 搜索协同 ===== */
/* 组顶「全局对话」子节折叠态：只存内存（契约只要求分组本身持久化），默认展开 */
var _wsGlobalCollapsed = {};

/* 组头点击：折叠/展开 + aria-expanded 同步（契约 §5.2）。
   就地改属性而不整表重渲染：body 显隐与 caret 旋转全部由 CSS 按 [aria-expanded] 驱动，
   省掉一次 innerHTML 重建（也就不会冲掉当前搜索过滤态与滚动位置）。
   委托绑定在 document 上：列表 innerHTML 重建后不丢事件。 */
/* 组头快捷动作（「＋」新增本组工作空间 / 「⋯」连接动作菜单）：acts 是 head 的
   兄弟节点，点击不经过 head 的折叠委派（天然不互扰）；stopPropagation 只为了
   不让这次点击被 document 上的其它委派（如下拉外点关闭）当成「点了别处」。 */
$(document).on('click', '.ws-group-act', function (e) {
    e.stopPropagation();
    if ($(this).hasClass('ws-group-add')) {
        var addScope = $(this).attr('data-scope');
        if (addScope && typeof window.sidebarAddWorkspace === 'function') {
            window.sidebarAddWorkspace(addScope);
        }
    } else if ($(this).hasClass('ws-group-more')) {
        var cid = $(this).attr('data-conn');
        if (cid && typeof window.openRemoteConnMenu === 'function') {
            window.openRemoteConnMenu(this, cid);
        }
    }
});

$(document).on('click', '.ws-group-head', function (e) {
    if ($(e.target).closest('.proj-node').length) return;
    var scopeKey = $(this).closest('.ws-group').attr('data-scope');
    if (!scopeKey) return;
    var expanded = $(this).attr('aria-expanded') === 'true';
    $(this).attr('aria-expanded', expanded ? 'false' : 'true');
    $(this).closest('.ws-group').toggleClass('ws-group-collapsed', expanded);
    wsGroupToggle(scopeKey);
});
/* 组顶「全局对话」子节：同款就地开合（内存态，不持久化） */
$(document).on('click', '.ws-group-global-head', function () {
    var $sec = $(this).closest('.ws-group-global');
    var scopeKey = $sec.attr('data-scope');
    if (!scopeKey) return;
    var collapsed = !_wsGlobalCollapsed[scopeKey];
    _wsGlobalCollapsed[scopeKey] = collapsed;
    $(this).attr('aria-expanded', collapsed ? 'false' : 'true');
    $sec.toggleClass('ws-group-global-collapsed', collapsed);
});
/* 组头快捷动作的键盘可达性：span[role=button] 不是原生 button，Enter/Space
   必须手动触发 click（组头本身是 <button>，键盘原生可达，无需此处理）。
   【必须 triggerHandler 而非 trigger】：jQuery 的 trigger 跑完 jQuery 处理器后
   还会调原生方法（elem[type]() → elem.click()），原生 click 再冒泡到 document
   命中上面那条 click 委派 = 同一次按键动作执行两遍（「＋」连开两次目录对话框、
   「⋯」开了又关看起来像坏了）。triggerHandler 只跑 jQuery 处理器、不冒泡、
   不触发原生方法；keydown 里的 stopPropagation 只防 keydown 冒泡，拦不住
   trigger 自造的原生 click，故不能靠它兜。 */
$(document).on('keydown', '.ws-group-act', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    $(this).triggerHandler('click');
});

/* 搜索过滤 × 分组（契约 §5.7）：过滤器本体在 app-ui.js（不在本模块所有权范围内），
   它只认 .sidebar-item/.proj-node，过滤后整组可能一条不剩却仍留着 head；清空关键字
   与关闭搜索条时它又只恢复条目、不认分组容器。这里在同样的入口上再收敛一层组/子节显隐。

   WHY 不用 :visible / offsetParent 判定——折叠组的 body 是 CSS 级隐藏，offsetParent
   对组内所有行恒为 null，一搜索就把用户手动收起的组连 head 一起藏掉。改用「过滤器
   唯一会写的 inline display」为准，与折叠态彻底解耦。
   WHY 挂捕获阶段 + setTimeout(0)：app-ui.js 的处理器绑在输入框元素本身，捕获阶段
   document 先于它执行，同步读到的会是上一轮过滤结果；让一拍再判定即为当轮结果。 */
function wsRowFilteredOut(el) {
    var node = el;
    while (node && node !== historyList) {
        if (node.style && node.style.display === 'none') return true;
        node = node.parentNode;
    }
    return false;
}
function wsAnyRowVisible(container, selector) {
    var rows = container.querySelectorAll(selector);
    for (var i = 0; i < rows.length; i++) {
        if (!wsRowFilteredOut(rows[i])) return true;
    }
    return false;
}
function syncWsGroupFilterVisibility() {
    if (!historyList) return;
    var groups = historyList.querySelectorAll('.ws-group');
    if (!groups.length) return;
    /* 「过滤中」= 过滤器已在某些行上写了 inline display:none（清空/关闭搜索条时 app-ui
       会 show() 掉它们，此时本函数把组显隐一并复原，不会误判成过滤态）。 */
    var filtering = historyList.querySelectorAll(
        '.sidebar-item[style*="display: none"], .proj-node[style*="display: none"]').length > 0;
    for (var i = 0; i < groups.length; i++) {
        var keep = !filtering || wsAnyRowVisible(groups[i], '.sidebar-item, .proj-node');
        groups[i].style.display = keep ? '' : 'none';
        // 组顶「全局对话」子节同口径：过滤后无命中就整节隐藏，别留一个空标题
        var secs = groups[i].querySelectorAll('.ws-group-global');
        for (var s = 0; s < secs.length; s++) {
            var hit = !filtering || wsAnyRowVisible(secs[s], '.sidebar-item');
            secs[s].style.display = hit ? '' : 'none';
        }
    }
}
document.addEventListener('input', function (e) {
    if (!e.target || e.target.id !== 'sidebarSearchInput') return;
    setTimeout(syncWsGroupFilterVisibility, 0);
}, true);
/* 过滤器的另外两个直接入口（清空按钮 / 搜索条开关）也要跟着复原组显隐：
   app-ui.js 的 restoreSidebarFilter 只恢复 .sidebar-item/.proj-node，不认分组容器——
   不补这一层，用户关一次搜索条，被过滤隐藏的组就永久回不来了。 */
$(document).on('click', '#filterListBtn, #sidebarSearchClear', function () {
    setTimeout(syncWsGroupFilterVisibility, 0);
});
/* 列表重建（updateHistoryUI）后按当前关键字重新过滤，分组收敛必须紧随其后，
   否则重建瞬间空组 head 会闪回来。app-ui.js 先于本模块加载（见 app-bootstrap.js
   APP_SCRIPTS 顺序），此处取到的一定是它的原实现；它没装时退化为纯分组收敛。 */
var _reapplySidebarFilterBase = window.reapplySidebarFilter;
window.reapplySidebarFilter = function () {
    if (typeof _reapplySidebarFilterBase === 'function') _reapplySidebarFilterBase();
    syncWsGroupFilterVisibility();
};

/* 连接表变化（连上/断开/探活掉线/恢复完成）→ 重拉侧栏：分组数、组内在线态、
   各组的项目与「全局对话」全部以连接表为准，不订阅就只能等下次手动刷新才对得上
   （典型漏网场景：探活把某条连接判掉线，只改 state 不走 applyConnection/doDisconnect，
   不订阅则分组红点永远不亮）。
   两条通道都接：
   - window 事件（契约 §2.3）：与脚本加载序无关。app-remote.js 在本模块之后加载，
     首屏时读口还不存在，事件是唯一可靠的兜底；
   - 读口回调 onConnectionsChanged（契约 §2.2）：读口已就位时用它，语义更直接。
   两条同时到达由 rAF 合并成一轮加载（令牌还会丢弃过期响应）。 */
var _wsConnReloadQueued = false;
function scheduleSidebarReloadForConnections() {
    if (_wsConnReloadQueued) return;
    _wsConnReloadQueued = true;
    requestAnimationFrame(function () {
        _wsConnReloadQueued = false;
        /* code 模式侧栏是「当前项目根平铺」，没有分组树，不参与重拉
           （它由 app-code 的项目切换自行驱动）。 */
        if (window.appMode === 'code') return;
        loadSessionHistory();
    });
}
(function subscribeConnectionsChanged() {
    var R = window.__GOURD_REMOTE__;
    if (R && typeof R.onConnectionsChanged === 'function') {
        try { R.onConnectionsChanged(scheduleSidebarReloadForConnections); } catch (e) {}
    }
    window.addEventListener('remote:connections-changed', scheduleSidebarReloadForConnections);
})();


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

/* 项目行重命名：原位编辑显示名（复刻会话重命名交互）。
   仅修改 projects.json 中的展示名，不改动磁盘目录与真实路径；
   成功后即时刷新侧栏，其它界面（欢迎页、专注模式标题等）在下次加载时读取新名字。 */
function startProjectRename(path) {
    var $node = null;
    $(historyList).find('.proj-node').each(function () {
        if ($(this).attr('data-proj') === path) { $node = $(this); return false; }
    });
    if (!$node || !$node.length) return;
    var $nameEl = $node.find('.proj-name');
    if (!$nameEl.length) return;

    var currentName = $nameEl.text();
    var $input = $('<input>', {
        type: 'text',
        'class': 'sidebar-rename-input',
        maxlength: 50,
        val: currentName
    });

    $nameEl.hide();
    $node.find('.proj-rename').hide();
    $nameEl.before($input);
    $input[0].focus();
    $input[0].select();

    function finishProjectRename() {
        var newName = $input.val().trim();
        if (newName && newName !== currentName) {
            /* 与 projects/add|remove|create 同族接口一致：必须 JSON 正文调用
               （后端 @Body + ONode.ofJson 解析；$.post 默认 form 编码会解析失败返回 500）。 */
            $.ajax({
                url: '/web/chat/projects/rename' + projScopeQuery(projNodeScopeOf(path)),
                method: 'POST', contentType: 'application/json',
                data: JSON.stringify({ path: path, name: newName })
            }).done(function (resp) {
                if (resp && resp.code === 200) {
                    updateProjectDisplayName(path, newName);
                } else {
                    if (typeof showToast === 'function') showToast(GourdI18n.t('app.sidebar.rename_failed'), 'error');
                }
            }).fail(function () {
                if (typeof showToast === 'function') showToast(GourdI18n.t('app.sidebar.rename_failed'), 'error');
            });
        }
        $input.remove();
        $nameEl.show();
        $node.find('.proj-rename').show();
    }

    $input.on('blur', finishProjectRename);
    $input.on('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); $input[0].blur(); }
        if (e.key === 'Escape') { $input.val(currentName); $input[0].blur(); }
    });
}

/* 项目显示名本地更新：改 _sidebarData 中的 name 并刷新侧栏（避免为改名重拉整个侧栏数据）。
   同时广播 projects:changed，让其它持有项目列表副本的视图（欢迎页工作空间选择器、
   记忆页项目选择器、自动化工作空间选择器）即时跟上新名字，而不是等下次打开才刷新。 */
function updateProjectDisplayName(path, name) {
    if (_sidebarData && _sidebarData.projects) {
        for (var i = 0; i < _sidebarData.projects.length; i++) {
            if (_sidebarData.projects[i].path === path) {
                _sidebarData.projects[i].name = name;
                break;
            }
        }
    }
    updateHistoryUI();
    if (typeof window.notifyProjectsChanged === 'function') window.notifyProjectsChanged();
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
            // 容器即将被移除：先中止回放，否则分片 rAF 会继续渲染一个已被删除的会话
            if (typeof abortReplay === 'function') abortReplay(sess);
            $(sess.container).remove();
            delete sessionMap[entry.sessionId];
            clearHistoryLoadingTimer(entry.sessionId);   // 删除会话：撤其加载定时器
            hideHistoryLoading(sess);              // 撤其覆盖层（仅归属匹配时生效，绝不误伤其它会话）
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
    // 确认是异步的（应用内弹窗）→ 续体包进 proceed 回调，取消回调为空。
    if (switchProject && typeof window.confirmDiscardUnsavedIfAny === 'function') {
        window.confirmDiscardUnsavedIfAny(function () { doSwitchSession(idx, switchProject); }, function () {});
        return;
    }
    doSwitchSession(idx, switchProject);
}

/* WHY switchProject 必须显式传参：doSwitchSession 是顶层函数，其作用域链只有全局，
   不含 selectSession 的局部变量。上一轮把同步 confirm 包成异步回调时漏传该参 →
   函数体 if (switchProject) 抛 ReferenceError → 点击侧栏会话静默失败（用户报障根因）。
   回调里能直接写 switchProject 是因为回调是 selectSession 作用域内的闭包，
   但被调用的 doSwitchSession 不是——两者作用域链不同，必须传参。 */
function doSwitchSession(idx, switchProject) {
    var entry = chatHistory[idx];
    if (!entry) return;

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
    // 非 work- 前缀或尚未缓存的会话也要恢复其模型/上下文；在途请求由 refreshSessionModel 合并。
    refreshSessionModel(entry.sessionId);
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
    refreshSessionModel(sessionId);
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
    // 存在未展开（有会话的）项目 → 全展开；否则全收起
    var anyCollapsed = anyProjectCollapsed();
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
                        if (typeof abortReplay === 'function') abortReplay(cs);
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
var REPLAY_PAGE_ROUNDS = 10;
var REPLAY_PAGE_REQUEST_TIMEOUT_MS = 30000;
// 锚锁沿用 app-base.js 的 8 秒安全阀，由短周期续期覆盖请求/异步回放的整个活动窗口。
var REPLAY_PAGE_SCROLL_HOLD_REFRESH_MS = 4000;
// 看门狗上限：HTTP 自身有 30s 超时，这里只兜「响应已回但异步 prepend 回放永远没走到收尾」
// （会话切走/异常中断致 replayDone 缺席）——不封顶的话分页锁与 spinner 无限残留，
// 表现为按钮一直是「加载中」且用户滚不回底部。
var REPLAY_PAGE_MAX_HOLD_MS = 45000;
var _replayLoadMoreRequestSeq = 0;
var _replayLoadMoreAnchorOwners = Object.create(null);
window._replayLoadMoreAnchorOwners = _replayLoadMoreAnchorOwners;

function drainReplayLoadMoreGate(sess) {
    if (!sess) return;
    try {
        if (typeof drainGateBuffer === 'function') drainGateBuffer(sess);
        else {
            sess._gateBuffer = [];
            sess._gateBuffering = false;
        }
    } catch (e) {
        // drainGateBuffer 的逐帧分发已有独立兜底；这里覆盖其自身收尾也意外抛错的情况。
        sess._gateBuffer = [];
        sess._gateBufferOverflowed = false;
        sess._gateBuffering = false;
        try { console.error('[loadMoreMessages] Failed to drain replay gate buffer:', e); } catch (ignore) {}
    }
}

function holdReplayLoadMoreAnchor(sess, requestId) {
    if (!sess) return false;
    var owner = _replayLoadMoreAnchorOwners[sess.sessionId];
    if (!owner || owner.requestId !== requestId) return false;
    if (sess.sessionId !== activeSessionId) return false;
    holdScrollAnchor();
    return true;
}

function startReplayLoadMoreAnchorRenewal(sess, requestId) {
    if (!sess) return;
    if (sess._replayLoadMoreAnchorTimer) clearInterval(sess._replayLoadMoreAnchorTimer);
    var renewalTimer = setInterval(function () {
        if (sess._replayLoadingMoreToken !== requestId || !sess._replayLoadingMore) {
            // 旧 timer 的队列回调可能晚于新事务建立；只能清理自己，不能误停新 timer。
            if (sess._replayLoadMoreAnchorTimer === renewalTimer) {
                clearInterval(renewalTimer);
                sess._replayLoadMoreAnchorTimer = null;
            }
            return;
        }
        if (Date.now() - (sess._replayLoadingMoreStartedAt || 0) > REPLAY_PAGE_MAX_HOLD_MS) {
            // 看门狗命中：走与正常收尾完全相同的路径（停 timer、解锁、排空 gate、恢复按钮），
            // 迟到的响应/回放回调会被 token 校验自动丢弃。
            finishReplayLoadMore(sess, requestId, { updateButton: true });
            return;
        }
        holdReplayLoadMoreAnchor(sess, requestId);
    }, REPLAY_PAGE_SCROLL_HOLD_REFRESH_MS);
    sess._replayLoadMoreAnchorTimer = renewalTimer;
}

function stopReplayLoadMoreAnchorRenewal(sess, requestId) {
    if (!sess || sess._replayLoadingMoreToken !== requestId) return;
    if (sess._replayLoadMoreAnchorTimer) {
        clearInterval(sess._replayLoadMoreAnchorTimer);
        sess._replayLoadMoreAnchorTimer = null;
    }
}

function releaseReplayLoadMoreAnchor(sess, requestId) {
    if (!sess) return;
    var owner = _replayLoadMoreAnchorOwners[sess.sessionId];
    if (!owner || owner.requestId !== requestId) return;
    // setActiveSession 已经释放旧会话的全局锚锁。仅丢弃旧会话自己的 owner，不触碰活动会话的锁。
    if (sess.sessionId !== activeSessionId) {
        delete _replayLoadMoreAnchorOwners[sess.sessionId];
        return;
    }
    var release = function () {
        if (_replayLoadMoreAnchorOwners[sess.sessionId] !== owner) return;
        delete _replayLoadMoreAnchorOwners[sess.sessionId];
        if (sess.sessionId === activeSessionId && typeof releaseScrollAnchor === 'function') {
            releaseScrollAnchor();
        }
    };
    try {
        // scrollToBottom 的两帧回调先在锚锁下完成，防止失败/收尾时迟到的 force 滚动覆盖用户位置。
        requestAnimationFrame(function () { requestAnimationFrame(release); });
    } catch (e) {
        release();
    }
}

function finishReplayLoadMore(sess, requestId, options) {
    if (!sess || sess._replayLoadingMoreToken !== requestId) return false;
    stopReplayLoadMoreAnchorRenewal(sess, requestId);
    sess._replayLoadingMore = false;
    sess._replayLoadingMoreToken = null;
    var opts = options || {};
    try {
        // 会话曾切走又切回时 setActiveSession 会释放旧锚锁；当前仍是该会话则在排空前重新锁定，
        // 防止 done 帧的 force scroll 在异步 cleanup 窗口内覆盖用户刚调整的位置。
        if (sess.sessionId === activeSessionId) holdReplayLoadMoreAnchor(sess, requestId);
        if (opts.drain !== false) drainReplayLoadMoreGate(sess);
    } finally {
        try {
            if (opts.updateButton !== false && sess.sessionId === activeSessionId
                    && typeof updateLoadMoreBtn === 'function') {
                try { updateLoadMoreBtn(sess); } catch (e) { console.error('[loadMoreMessages] Failed to refresh button:', e); }
            }
        } finally {
            releaseReplayLoadMoreAnchor(sess, requestId);
        }
    }
    return true;
}

function installReplayLoadMoreSessionHook() {
    if (!window || typeof window.setActiveSession !== 'function') return;
    var original = window.setActiveSession;
    if (original._replayLoadMoreAnchorHook) return;
    var wrapped = function (sessionId) {
        var result = original.apply(this, arguments);
        var sess = sessionId && sessionMap ? sessionMap[sessionId] : null;
        if (sess && sess._replayLoadingMoreToken != null) {
            // setActiveSession 内会先释放全局锚锁；若当前分页仍有效则立即为该会话续上，
            // 否则保持新会话滚动自由，不让迟到请求残留状态锁住视口。
            if (sess._replayLoadingMore) holdReplayLoadMoreAnchor(sess, sess._replayLoadingMoreToken);
        }
        return result;
    };
    wrapped._replayLoadMoreAnchorHook = true;
    window.setActiveSession = wrapped;
    if (typeof setActiveSession !== 'undefined') setActiveSession = wrapped;
}
installReplayLoadMoreSessionHook();

/* ===== 历史会话恢复加载态（防白屏骨架屏） =====
   根因与视觉规格见 app.css 同名区块。生命周期：
   - showHistoryLoading：loadMessages 发请求前挂覆盖层（归属 sessionId）；
   - hideHistoryLoading：内容落到真实容器的各收尾出口撤销（replay 正常/兜底、
     legacy 正常/异常/失败共 5 处，漏一处就永远转圈）；
   - 超时兜底：/web/chat/replay 初始请求没有 timeout，12s 无响应降级为失败+重试卡，
     绝不静默留白也绝不永久转圈；
   - setActiveSession 经 window.dismissHistoryLoadingExcept 撤掉「不属于新活动
     会话」的残留覆盖层（切回已缓存会话不再发请求，没有 show/hide 配对）。
   WHY 覆盖层不进 sess.container：children.length===0 是全项目「需要重拉历史」的
   唯一判据，骨架节点混入会让切回会话只剩骨架、历史永久消失。 */
var HISTORY_LOAD_TIMEOUT_MS = 12000;
/* 【P1-1 修复 2026-11】HTTP 超时必须宽于 UI watchdog，两者同值会竞态：
   HTTP 先到点触发 error('timeout') → legacy 二次请求 → UI watchdog 随后又盖
   失败卡，三态交错（失败卡 + legacy 内容 + 二次骨架）。watchdog 先行 abort 后，
   迟到的 error('abort') 已被显式忽略，这里只是悬挂请求的网络级兜底。 */
var HISTORY_HTTP_TIMEOUT_MS = 60000;
/* 【P0-2 修复 2026-11】回放卡死宽限：12s watchdog 命中回放态（_replaying）时
   不再一次性 return（旧实现保护真空：rAF 链一旦卡死，门禁与覆盖层永久残留
   = 白屏），而是重排到该截止点；届时仍未收尾则强制收口（__replayStalled）。 */
var REPLAY_STALL_GRACE_MS = 30000;
var _historyLoadingTimers = {};

function historyOverlayHost() {
    return document.getElementById('messagesShell') || $(messagesWrap).parent()[0] || null;
}

/* 覆盖层存在期间给 shell 挂 has-history-loading 标记。
    【2026-11-04 位置修正后的现状】shell 已常驻 relative（rail 与覆盖层的共同定位父级），
    该标记不再承载 CSS 规则，仅作为「当前有加载态」的可查询状态保留：DOM 探针与
    测试仍用它断言覆盖层的生命周期。不要因为「找不到同名 CSS 规则」就删掉调用点。 */
function updateHistoryLoadingShellClass(host) {
    if (!host) return;
    var has = !!host.querySelector('.chat-history-loading');
    host.classList.toggle('has-history-loading', has);
}

/* 骨架行模板：一个周期 8 行，覆盖「用户短句 / 助手段落 / 用户一句话 / 助手长回答」
   的真实节奏。宽度百分比相对 820px 版心。 */
var HISTORY_SKELETON_ROWS = [
    { cls: 'chl-row-me', widths: ['42%'] },
    { cls: 'chl-row-ai', widths: ['74%', '58%'] },
    { cls: 'chl-row-me', widths: ['30%'] },
    { cls: 'chl-row-ai', widths: ['80%', '66%', '40%'] },
    { cls: 'chl-row-ai', widths: ['68%', '52%'] },
    { cls: 'chl-row-me', widths: ['36%'] },
    { cls: 'chl-row-ai', widths: ['76%', '60%', '44%'] },
    { cls: 'chl-row-ai', widths: ['58%'] }
];
/* 每行【行盒高度】实测值（= .chl-line 高度之和 + 8px gap×(n-1)，gap 取自 .chl-row）。
   模板行高：单行用户/单行助手 32/12，三行助手 52。
   模型：首行从 padding-top + margin-top 开始；每行占高 = height（往上加上 margin 由 ROW_GAP 描述）。
   【为何不能存 pitch（相邻 top 差）】pitch 含上一行的 marginBottom，直接用会把末行的
   外边距也算成覆盖高度，多算 14px → 少生成半行，末行恰好差几个 px 盖不到底边
   （实测踩过：末行 bottom=634 vs 容器 641）。 */
var HISTORY_SKELETON_ROW_HEIGHTS = [32, 32, 32, 52, 32, 32, 52, 12];
var HISTORY_SKELETON_ROW_GAP_PX = 28;       // 行间 margin（14 上 + 14 下）
var HISTORY_SKELETON_TOP_PAD_PX = 42;       // inner padding-top 28 + 首行 margin-top 14
var HISTORY_SKELETON_MAX_ROWS = 64;
/* 交错升起序号封顶：不封顶时 40 行 × 70ms = 2.8s，最后几行迟迟不出现。 */
var HISTORY_SKELETON_STAGGER_CAP = 8;

/** 按容器可用高度算需要多少行骨架。availH<=0（契约测试的假 DOM 没有 clientHeight）
    时返回一个完整周期 —— 拿不到高度也绝不能退化成不渲染。
    【必须同时排除非有限值】availH = Infinity 满足 availH > 0，会进 while 且 bottom 永远
    追不上，直接死循环卡死主线程；NaN 已被 !(availH > 0) 拦住。clientHeight 当前不会返回
    Infinity，但这是零成本的结构性防护，宁可多这一道。 */
function historySkeletonRowsFor(availH) {
    var cycle = HISTORY_SKELETON_ROWS.length;
    if (!(availH > 0) || !isFinite(availH)) return cycle;
    var heights = HISTORY_SKELETON_ROW_HEIGHTS;
    var gap = HISTORY_SKELETON_ROW_GAP_PX;
    /* 【上限必须同时约束循环，不能只在 return 处兜底】
       上一轮把循环里的 need < MAX_ROWS 当成「冗余防御」删了，理由是删掉后
       变异体存活 = 行为等价。这个推理是错的：变异体存活只说明【当时的测试观察不到
       行为差异】，不等于行为相同 —— 差异落在运行时间上。实测 availH=1e9 时
       循环要跑约 2500 万次、耗时 122ms（纯 O(availH)），而 64 行就够用了。
       现实里 clientHeight 不会这么大，但这是零成本的确定性收敛，不该留。
       对应契约测试用【耗时】而非返回值来锁它 —— 返回值两种写法完全一样。 */
    var need = 0;
    /* 两个量必须分开，首版混用导致 641 容器永远差 7px：
       - cursor：下一行盒的起点（= 上一行底边 + gap）
       - bottom：当前末行的底边（= 上一行底边 + 行高）
       达标只能看 bottom。 */
    var cursor = HISTORY_SKELETON_TOP_PAD_PX;
    var bottom = HISTORY_SKELETON_TOP_PAD_PX;
    while (bottom < availH && need < HISTORY_SKELETON_MAX_ROWS) {
        bottom = cursor + heights[need % heights.length];
        need++;
        cursor = bottom + gap;
    }
    // 至少一个完整周期：极矮容器也不能只剩一行孤零零的骨架
    return Math.max(cycle, Math.min(need, HISTORY_SKELETON_MAX_ROWS));
}

function historySkeletonHtml(availH) {
    var tpl = HISTORY_SKELETON_ROWS;
    var total = historySkeletonRowsFor(availH);
    var html = '<div class="chl-inner">';
    for (var r = 0; r < total; r++) {
        var row = tpl[r % tpl.length];
        var i = Math.min(r, HISTORY_SKELETON_STAGGER_CAP);
        html += '<div class="chl-row ' + row.cls + '" style="--i:' + i + '" aria-hidden="true">';
        for (var w = 0; w < row.widths.length; w++) {
            html += '<div class="chl-line" style="width:' + row.widths[w] + '"></div>';
        }
        html += '</div>';
    }
    /* 读屏文案：进度条/spinner/可见文案三件套已按用户要求移除，覆盖层内再无任何可见
       文字；没有这段 sr-only 文本，aria-live 区域就是空的，读屏用户只能听到「空白」。 */
    html += '<span class="chl-sr">' + escapeHtml(GourdI18n.t('history.msgLoading')) + '</span>';
    html += '</div>';
    return html;
}

function historyFailedHtml() {
    return '<div class="chl-failed-card">'
        + '<svg class="chl-failed-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
        + '<span>' + escapeHtml(GourdI18n.t('history.msgFailed')) + '</span>'
        + '<button type="button" class="chl-retry-btn">' + escapeHtml(GourdI18n.t('history.msgRetry')) + '</button>'
        + '</div>';
}

function clearHistoryLoadingTimer(sessionId) {
    if (_historyLoadingTimers[sessionId]) {
        clearTimeout(_historyLoadingTimers[sessionId]);
        delete _historyLoadingTimers[sessionId];
    }
}

function showHistoryLoading(sess) {
    if (!sess || !sess.container) return;
    // 容器已有真实内容（理论上走不到——调用方先判空）：不遮挡正文
    if (sess.container.children.length > 0) return;
    var host = historyOverlayHost();
    if (!host) return;
    clearHistoryLoadingTimer(sess.sessionId);
    var old = host.querySelector('.chat-history-loading');
    if (old) old.remove();
    var el = document.createElement('div');
    el.className = 'chat-history-loading';
    el.setAttribute('aria-live', 'polite');
    el.dataset.ownerSession = sess.sessionId;
    /* 【顺序不可换】先入文档、再填内容。aria-live 只在「已存在于文档中的 live region
       内文本发生变化」时播报；把一棵已经带好文本的子树一次性 appendChild 进去，
       多数读屏器视为「内容与节点同时出现」，不触发播报 —— 等于 sr-only 文案白写。
       el 是 position:absolute，不参与 shell 的 flex 布局，提前 append 不影响
       下面 clientHeight 的读数。 */
    host.appendChild(el);
    // 按 shell 实际高度决定骨架行数（拿不到高度时 helper 内部自己兜底）
    el.innerHTML = historySkeletonHtml(host.clientHeight || 0);
    updateHistoryLoadingShellClass(host);
    // 超时兜底：请求悬挂（无 timeout 参数）时降级为失败+重试，不留永久转圈
    _historyLoadingTimers[sess.sessionId] = setTimeout(function () {
        delete _historyLoadingTimers[sess.sessionId];
        var host2 = historyOverlayHost();
        var cur = host2 && host2.querySelector('.chat-history-loading');
        if (!cur || cur.dataset.ownerSession !== sess.sessionId) return;   // 已被撤销/被新会话接管
        /* 【不能在这里直接换失败卡】先排空缓冲：在途的实时帧可能已经带着真实内容，
           排空后 sess.container 就不再是空的。直接写 innerHTML 会绕过
           「容器已有内容 ⇒ 只撤骨架、绝不叠失败卡」这条守卫，把成功的加载误报成
           失败卡，而且失败卡是 absolute inset:0，会把刚到的正文整块盖住（已实测复现）。
           统一交给 hideHistoryLoading 判定 —— 它是这条守卫的唯一定义处。 */
        /* 【P0-2 修复 2026-11】请求已成功、正在分片回放（_replaying）时，12s 定时器
            不再直接放手（旧实现把定时器消费掉且永不重排，此后 rAF 链一旦卡死，
            门禁/覆盖层/骨架永久残留 = 白屏）。改为：重排一次宽限定时器，宽限内仍未
            收尾（_replaying 仍为真）则强制收口——replayChunk 的 stall hook 会执行
            finishReplayFallback（salvage 半成品 + 释放门禁 + 撤骨架）。 */
        if (sess._replaying) {
            _historyLoadingTimers[sess.sessionId] = setTimeout(function () {
                delete _historyLoadingTimers[sess.sessionId];
                var host3 = historyOverlayHost();
                var cur3 = host3 && host3.querySelector('.chat-history-loading');
                if (!cur3 || cur3.dataset.ownerSession !== sess.sessionId) return;   // 已被撤销/被新会话接管
                if (!sess._replaying) {
                    /* 宽限期间恰好收尾完成：replayDoneCore 已撤骨架，无事可做。 */
                    return;
                }
                console.error('[history] 回放分片链卡死（宽限 ' + REPLAY_STALL_GRACE_MS + 'ms 内无收尾），强制收口');
                /* 通知 replayChunk：下一帧分片回调进入时直接走 fallback 收尾，
                    半成品由 finishReplayFallback salvage 入真实容器，绝不白屏。
                    不 cancel rAF：挂着的那帧正是 stall hook 的载体，掐了它就只剩
                    下面的盲收口（无 salvage）。 */
                sess.__replayStalled = true;
                /* 盲兜底：250ms 后 stall hook 仍未生效（rAF 链彻底死透，连挂起帧
                    都没有），只能就地强制释放门禁与骨架。renderTarget 仍指向 tempDiv
                    （回放期渲染落点），把里面的半成品 salvage 进真实容器，尽量保内容。 */
                setTimeout(function () {
                    if (!sess._replaying) return;   // stall 标记生效后已被正常收尾
                    console.error('[history] stall 标记未生效，强制释放回放门禁与加载态');
                    sess.__replayStalled = false;
                    sess._replaying = false;
                    sess._gateBuffering = false;
                    sess._skipScroll = false;
                    sess.isStreaming = false;
                    try {
                        /* 回放期 sess.renderTarget 正是 replaySession 的 tempDiv（游离
                            半成品容器）；salvage 它而非引用局部变量（此处拿不到）。 */
                        var stalledTarget = sess.renderTarget;
                        if (stalledTarget && stalledTarget !== sess.container
                                && stalledTarget.firstChild && sess.container) {
                            sess.container.appendChild(stalledTarget);
                        }
                    } catch (eSalv) { /* salvage 失败不阻断收口 */ }
                    sess.renderTarget = null;
                    hideHistoryLoading(sess, { failed: true });
                    try { drainGateBuffer(sess); } catch (e1) {}
                }, 250);
            }, REPLAY_STALL_GRACE_MS);
            return;
        }
        try { drainGateBuffer(sess); } catch (e) {}
        /* 【超时即断流 2026-11】12s 已降级成失败+重试卡，必须同时 abort 在途 replay。
            旧实现只换 UI 态、不作废回调：请求几十秒后带着 8 万帧回来仍会进 done
            重建整页，形成「失败卡 → 迟到内容 → 二次骨架」交错。
            abort 触发的 .fail('abort') 由 loadMessages 显式忽略，不再叠加二次请求。
            sess 上没有句柄时（契约沙箱 / 纯展示调用）整段短路，行为与改前一致。 */
        try {
            var pendingXhr = sess._historyLoadXhr;
            if (pendingXhr && typeof pendingXhr.abort === 'function' && pendingXhr.readyState !== 4) {
                pendingXhr.abort();
            }
        } catch (abortErr) { /* abort 失败不阻断降级卡 */ }
        hideHistoryLoading(sess, { failed: true });
    }, HISTORY_LOAD_TIMEOUT_MS);
}

/** 撤掉 sess 的加载态。归属校验：迟到的旧会话收尾回调不得撤掉新会话正在显示的覆盖层。
    opts.failed=true：换成失败+重试卡（请求确实终结且无内容）。 */
function hideHistoryLoading(sess, opts) {
    if (!sess) return;
    clearHistoryLoadingTimer(sess.sessionId);
    var host = historyOverlayHost();
    if (!host) return;
    var el = host.querySelector('.chat-history-loading');
    var mine = (el && el.dataset.ownerSession === sess.sessionId) ? el : null;
    if (!opts || !opts.failed) {
        if (mine) { mine.remove(); updateHistoryLoadingShellClass(host); }
        return;
    }
    // failed：先撤骨架，再看真实容器有没有落地内容——有内容绝不叠失败卡（回放收尾异常
    // 或半成品 salvaging 后容器可能已有可用内容，叠卡会误导成「加载失败」）；
    // 容器仍空才放重试卡。归属不符（迟到回调）时什么都不做，绝不碰新会话的覆盖层。
    if (!mine) return;
    mine.remove();
    // 容器已有落地内容：只撤骨架，绝不叠失败卡（回放收尾异常/半成品 salvaging 后
    // 容器可能已可用，叠卡会把「成功」误报成「加载失败」）。
    if (sess.container && sess.container.children.length > 0) {
        updateHistoryLoadingShellClass(host);
        return;
    }
    var f = document.createElement('div');
    f.className = 'chat-history-loading chl-failed';
    f.setAttribute('aria-live', 'polite');
    f.dataset.ownerSession = sess.sessionId;
    // 同 showHistoryLoading：先入文档再填内容，否则读屏不播报失败态
    host.appendChild(f);
    f.innerHTML = historyFailedHtml();
    updateHistoryLoadingShellClass(host);
}

/** 撤掉「不属于 sessionId」的残留覆盖层（setActiveSession 钩子，见文件头注释）。 */
function dismissHistoryLoadingExcept(sessionId) {
    var host = historyOverlayHost();
    if (!host) return;
    var el = host.querySelector('.chat-history-loading');
    if (el && el.dataset.ownerSession !== sessionId) {
        clearHistoryLoadingTimer(el.dataset.ownerSession);
        el.remove();
        updateHistoryLoadingShellClass(host);
    }
}
window.dismissHistoryLoadingExcept = dismissHistoryLoadingExcept;

/* 失败卡重试：委托到 document（覆盖层随撤销即销毁，无需解绑）。
   归属 sessionId 存 data-owner-session，按它反查 sessionMap；
   重试 = 摘卡 → 重新走与首次进入完全相同的管线（loadMessages 会重新放骨架）。 */
$(document).on('click', '.chl-retry-btn', function () {
    var overlay = $(this).closest('.chat-history-loading')[0];
    if (!overlay) return;
    var sid = overlay.dataset.ownerSession;
    clearHistoryLoadingTimer(sid);
    var sess = sessionMap[sid];
    var host = historyOverlayHost();
    overlay.remove();
    updateHistoryLoadingShellClass(host);
    if (sess) loadMessages(sess);
});

function loadMessages(sess) {
    if (!sess || !sess.container) return;
    var rootQ = sessionRootQ(sess);
    /* 【2026-11 白屏止血 · 请求世代号】旧实现是裸 $.get：切会话/点重试后旧请求
        的 done 仍会改游标并起一次 replaySession，两个回放共用 renderTarget 与
        _replayRafId。每次加载自增代号，done/fail 只在自己仍是当前代时生效。 */
    var gen = (sess._historyLoadGeneration || 0) + 1;
    sess._historyLoadGeneration = gen;
    /* 重试前先作废并断开上一次请求（失败卡重试点得快时尤其关键）。 */
    try {
        var prevXhr = sess._historyLoadXhr;
        if (prevXhr && prevXhr.readyState !== 4 && typeof prevXhr.abort === 'function') prevXhr.abort();
    } catch (e0) { /* 断开失败不阻断重新加载 */ }
    // 发请求前即开启回放/实时互斥门禁：期间到达的同会话实时帧先入缓冲，
    // 回放完成后由 drainGateBuffer 统一去重喂入，避免「后端任务未结束 + UI 发起回放」
    // 竞态窗口内同一事件被两条管线各渲染一次。
    beginGateBuffer(sess);
    // 优先尝试「流式过程回放」：若该会话已落盘完整过程事件（工具卡片/思考/正文/trace），
    // 原样重建，历史里也能看到「做了哪些操作」。无回放数据时回退到旧的纯文本加载。
    // 初始只加载最后 REPLAY_PAGE_ROUNDS 轮对话。
    showHistoryLoading(sess);
    var replayXhr = $.ajax({
        url: '/web/chat/replay?sessionId=' + encodeURIComponent(sess.sessionId) + rootQ + '&rounds=' + REPLAY_PAGE_ROUNDS,
        method: 'GET',
        /* 真实 HTTP 超时：与 12s 骨架兜底同口径。旧实现没有 timeout，大会话响应
           悬挂时只能靠 UI 定时器降级，而回调仍然有效 → 失败卡与迟到内容打架。 */
        /* timeout 用宽口径（watchdog 先行降级并 abort；同值会触发 P1-1 三态交错竞态）。 */
        timeout: HISTORY_HTTP_TIMEOUT_MS,
        success: function (rp) {
            if (sess._historyLoadGeneration !== gen || (typeof sessionMap !== 'undefined' && sessionMap[sess.sessionId] !== sess)) return;
            var rpData = rp && rp.data;
            /* 后端文件读失败 / 坏行会静默回 code:200 + events:[]（core/session/mod.rs
               :240-242/:344-346）。前端必须先看 code，否则「加载失败」被误当新对话
               走 legacy，用户只看到过程消息凭空消失。 */
            if (rp && rp.code && Number(rp.code) !== 200) {
                console.error('[loadMessages] replay 返回错误码:', rp.code, rp.description || '');
                replayXhr = null;
                loadMessagesLegacy(sess, rootQ, gen);
                return;
            }
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
                    /* HTTP 已终结，句柄清空；回放由 replaySession 自己的收尾链负责。 */
                    sess._historyLoadXhr = null;
                    replaySession(sess, rpData.events, false, !!rpData.running);
                    return;
                } catch (e) {
                    /* 回放异常：清空可能的半成品，回退纯文本加载。
                        这里必须清真实容器——旧实现执行到此处时 sess.container 已被 replaySession
                        换成临时容器，清空操作打在孤儿节点上，真实容器里的半成品原样留着。
                        容器语义恒定后该问题自然消失，同时显式中止回放，释放门禁与渲染落点。*/
                    try { if (typeof abortReplay === 'function') abortReplay(sess); } catch (e3) {}
                    try { $(sess.container).html(''); } catch (e2) {}
                }
            }
            // replay 无事件（新对话）或异常：走纯文本加载路径（缓冲在 legacy 加载完成时统一排空）
            sess._historyLoadXhr = null;
            loadMessagesLegacy(sess, rootQ, gen);
        },
        error: function (xhr, textStatus) {
            /* abort（切会话 / 超时兜底 / 重试作废）不是失败：当前代已被顶掉或已被
               降级卡处理，绝不能再叠一次 legacy 请求与失败卡。 */
            if (textStatus === 'abort') return;
            if (sess._historyLoadGeneration !== gen || (typeof sessionMap !== 'undefined' && sessionMap[sess.sessionId] !== sess)) return;
            console.error('[loadMessages] replay 请求失败:', textStatus, xhr && xhr.status);
            sess._historyLoadXhr = null;
            loadMessagesLegacy(sess, rootQ, gen);
        }
    });
    sess._historyLoadXhr = replayXhr;
}

/**
 * 加载更早的历史消息（prepend 到现有内容之前）。
 * 按游标（_replayFirstSeq）向前取 REPLAY_PAGE_ROUNDS 轮，服务端只回传这一页，
 * 不会像旧实现那样每次从尾部重取「已加载 + 一页」导致越翻越慢。
 */
function loadMoreMessages(sess) {
    if (!sess || sess._replayLoadingMore || sess._replaying || sess._gateBuffering
            || sess._recovering || sess.sessionId !== activeSessionId) return false;
    if (!sess._replayHasMore) return false;

    var requestId = ++_replayLoadMoreRequestSeq;
    sess._replayLoadingMore = true;
    sess._replayLoadingMoreToken = requestId;
    sess._replayLoadingMoreStartedAt = Date.now();
    _replayLoadMoreAnchorOwners[sess.sessionId] = { sessionId: sess.sessionId, requestId: requestId };
    var rootQ;
    var beforeQ;
    var requestHandled = false;
    function finishCancelledRequest() {
        if (sess._replayLoadingMoreToken !== requestId) return;
        stopReplayLoadMoreAnchorRenewal(sess, requestId);
        var owner = _replayLoadMoreAnchorOwners[sess.sessionId];
        if (owner && owner.requestId === requestId) delete _replayLoadMoreAnchorOwners[sess.sessionId];
        sess._replayLoadingMore = false;
        sess._replayLoadingMoreToken = null;
        // 只清这个会话自己的 gate；不做 drain，避免销毁路径上的实时帧写入已移除容器。
        sess._gateBuffer = [];
        sess._gateBufferOverflowed = false;
        sess._gateBuffering = false;
        if (sess.sessionId === activeSessionId) {
            if (typeof updateLoadMoreBtn === 'function') updateLoadMoreBtn(sess);
            if (typeof releaseScrollAnchor === 'function') releaseScrollAnchor();
        }
    }
    function onSuccess(rp) {
        if (requestHandled) return;
        if (sess._replayLoadingMoreToken !== requestId) return;
        if (!sess._replayLoadingMore) {
            // abortReplay 等销毁路径可能已取消分页；迟到成功响应只负责释放请求 bookkeeping。
            finishCancelledRequest();
            requestHandled = true;
            return;
        }
        requestHandled = true;

        // 切换会话后丢弃响应。旧会话只做自身 gate/锁清理，不触碰当前会话的滚动锁。
        if (sess.sessionId !== activeSessionId) {
            if (sess._replayLoadingMore) finishReplayLoadMore(sess, requestId, { updateButton: false });
            return;
        }

        try {
            var rpData = rp && rp.data;
            if (rpData && rpData.events && rpData.events.length > 0) {
                // 游标分页天然只返回「更早」的事件，无需再按 totalCount 增长做重叠区间修正：
                // 会话仍在流式时新事件的 seq 只会更大，不可能落进 beforeSeq 之前的窗口。
                sess._replayHasMore = !!rpData.hasMore;
                sess._replayRemainingRounds = rpData.remainingRounds || 0;
                if (rpData.firstSeq) sess._replayFirstSeq = rpData.firstSeq;
                // 会话可能切走后又切回；当前响应开始 prepend 时接管锚锁所有权。
                _replayLoadMoreAnchorOwners[sess.sessionId] = { sessionId: sess.sessionId, requestId: requestId };
                holdReplayLoadMoreAnchor(sess, requestId);
                // 请求锁和视口锚锁延续到异步 prepend 回放、元素锚点恢复及 gate 排空完成。
                replaySession(sess, rpData.events, true);
                return;
            }

            // 没有更早的事件了：收起入口，避免留下永远点不出内容的按钮。
            sess._replayHasMore = false;
            sess._replayRemainingRounds = 0;
            finishReplayLoadMore(sess, requestId, { updateButton: true });
        } catch (e) {
            console.error('[loadMoreMessages] Failed to process replay page:', e);
            // replaySession 若在同步初始化阶段抛错，还没能进入自身 rAF/fallback 收尾。
            // 先复位其临时渲染落点与回放 gate，再结束分页事务。
            if (sess._replaying && typeof abortReplay === 'function') {
                try { abortReplay(sess); } catch (abortError) {
                    console.error('[loadMoreMessages] Failed to abort replay after initialization error:', abortError);
                }
            }
            finishReplayLoadMore(sess, requestId, { updateButton: true });
        }
    }
    function onFailure() {
        if (requestHandled) return;
        if (sess._replayLoadingMoreToken !== requestId) return;
        if (!sess._replayLoadingMore) {
            // 请求中止/已由其它 cleanup 收尾；迟到的 fail 回调只负责释放请求 bookkeeping。
            finishCancelledRequest();
            requestHandled = true;
            return;
        }
        requestHandled = true;
        finishReplayLoadMore(sess, requestId, { updateButton: true });
    }

    try {
        rootQ = sessionRootQ(sess);
        beforeQ = sess._replayFirstSeq ? '&beforeSeq=' + sess._replayFirstSeq : '';
        beginGateBuffer(sess);
        holdReplayLoadMoreAnchor(sess, requestId);
        startReplayLoadMoreAnchorRenewal(sess, requestId);
        setLoadMoreBtnLoading(sess);

        var request = $.ajax({
            url: '/web/chat/replay?sessionId=' + encodeURIComponent(sess.sessionId) + rootQ
                + '&rounds=' + REPLAY_PAGE_ROUNDS + beforeQ,
            method: 'GET',
            timeout: REPLAY_PAGE_REQUEST_TIMEOUT_MS
        });
        request.done(onSuccess);
        request.fail(onFailure);
    } catch (e) {
        if (sess._replaying && typeof abortReplay === 'function') {
            try { abortReplay(sess); } catch (abortError) {
                console.error('[loadMoreMessages] Failed to abort replay after synchronous error:', abortError);
            }
        }
        // 包括 $.ajax 同步抛错及 jqXHR 回调绑定失败；与网络/超时共用完整 cleanup。
        onFailure();
    }
    return true;
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

    // 只移除当前会话容器前的加载按钮；先断开旧观察器，防止孤立回调触发加载
    if (sess._loadMoreObserver) {
        sess._loadMoreObserver.disconnect();
        sess._loadMoreObserver = null;
    }
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
            loadMoreMessages(sess);
        });
        if (sess._replayLoadingMore) setLoadMoreBtnLoading(sess);
        if (typeof IntersectionObserver !== 'undefined' && !sess._replayLoadingMore) {
            // 防无限自激：按钮被程序性插入视口时不自动触发。
            // 必须先离开视口（_hasBeenHidden）再回来，才判定为用户主动滚到此处。
            // _triggered 一次性保护防止边界情况下的重复触发。
            // 门禁二（实测补）：触发前用实时几何复核「按钮真在视口内且视口真在消息区顶部」。
            // IO 的 entry 是异步投递的旧快照：初始加载收尾瞬间按钮短暂可见→首个
            // non-intersecting 回调把 _hasBeenHidden 置真→随后一条【过期】的 intersecting
            // 回调在用户还在底部/中部时就误触发分页（实测 +100ms 误触发，随后 prepend 收尾
            // 把视口拽走，即「没拉也跳」）。故回调里不直接信 entry，用 getBoundingClientRect
            // 复核；复核不过则启动有界轮询补抓「用户随后真拉到顶」的那一刹（IO 只在阈值
            // 交叉时回调，过期拒绝后可能不再有交叉事件）。
            var _triggered = false, _hasBeenHidden = false, _recheckLeft = 0, _recheckTimer = null;
            // 贴顶判定（实测 P1-B 修正）：按钮 DOM 上位于内容容器【之前】，用户真贴顶
            // （scrollTop=0）时按钮在视口顶之上、getBoundingClientRect 与视口矩形【不相交】，
            // 「按钮在视口内」旧条件此时恒假——贴顶停住的用户永远触发不了自动分页，
            // 且按钮不可见不可点（分页入口消失）。故主门禁用 scrollTop（用户位置是唯一
            // 真源）；几何条件作 sanity：按钮在视口内（路过顶部区）或已越过视口顶（贴顶）
            // 二者必居其一，都不满足说明几何异常，拒绝。
            var btnVisibleNow = function () {
                var b = $btn[0];
                if (!b || !document.contains(b)) return false;
                if (messagesWrap.scrollTop > 240) return false;
                var r = b.getBoundingClientRect();
                var wr = messagesWrap.getBoundingClientRect();
                return (r.bottom > wr.top && r.top < wr.bottom) || r.bottom <= wr.top;
            };
            // 按钮已滚过视口顶（在视口上方）：用户已越过入口，同样视为到达分页位。
            var btnAboveViewport = function () {
                var b = $btn[0];
                if (!b || !document.contains(b)) return false;
                return b.getBoundingClientRect().bottom <= messagesWrap.getBoundingClientRect().top
                    && messagesWrap.scrollTop <= 240;
            };
            var fireLoad = function () {
                if (_triggered) return;
                _triggered = true;
                if (_recheckTimer) { clearTimeout(_recheckTimer); _recheckTimer = null; }
                obs.disconnect();
                sess._loadMoreObserver = null;
                loadMoreMessages(sess);
            };
            var scheduleRecheck = function () {
                if (_triggered || _recheckLeft <= 0) return;
                if (_recheckTimer) return;
                _recheckTimer = setTimeout(function () {
                    _recheckTimer = null;
                    _recheckLeft--;
                    if (_triggered) return;
                    if (btnVisibleNow()) { fireLoad(); return; }
                    scheduleRecheck();
                }, 160);
            };
            var obs = new IntersectionObserver(function(entries) {
                var e = entries[0];
                if (!e.isIntersecting) {
                    _hasBeenHidden = true;
                    // 实测 P1-B：non-intersecting 也可能是「用户贴顶、按钮在视口顶之上」
                    // （几何上不相交）。此时若等 intersecting 回调则永远等不到（按钮不会
                    // 再进视口），分页入口静默消失。故即时复核：贴顶且按钮已越过视口顶
                    // = 用户真到了分页位，立即触发。
                    if (!_triggered && btnAboveViewport()) { fireLoad(); }
                    return;
                }
                if (!_hasBeenHidden || _triggered) return;
                if (btnVisibleNow()) { fireLoad(); return; }
                // 过期/布局抖动产生的 intersecting：给用户 160ms×12 的窗口补抓真到顶
                _recheckLeft = 12;
                scheduleRecheck();
            }, { threshold: 0.5 });
            obs.observe($btn[0]);
            sess._loadMoreObserver = obs;
        }
    }
}

/* 加载更多分页主入口：IntersectionObserver 监听按钮进入视口自动触发；也保留手动点击。 */
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
        } catch (e) {
            // 不中断排空（剩余缓冲帧必须继续喂完），但不得静默：排空期的异常同样会表现为「界面少了一段」
            reportStreamPipelineError('drainGateBuffer', e, c);
        }
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
    var replayLoadMoreToken = prepend ? sess._replayLoadingMoreToken : null;
    // prepend 回放且会话存在进行中的实时流时先快照（replayDone 里恢复，见 captureLiveStreamState）；
    // 初始加载（prepend=false）走原有 resumeState 逻辑，不受影响。
    var liveState = prepend ? captureLiveStreamState(sess) : null;
    var tempDiv = document.createElement('div');
    /* 【2026-11 白屏止血】fragment 必须提升到闭包作用域：旧实现是 replayDoneCore 的
        局部变量，「抽空 tempDiv → 抽到 fragment → 入真实容器」这段窗口内一旦抛错
        （endTurn / stitch / getBoundingClientRect / html('') 任一），覆盖层已先撤，
        finishReplayFallback 又只捞已空的 tempDiv ⇒ 内容既不在 DOM 也不在临时容器、
        失败卡因 !mine 补不上 ⇒ 真空白。提升后兜底可把未入 DOM 的 fragment 一并捞回。 */
    var replayFragment = null;
    /* 只切换渲染落点，不动 sess.container（见 app-base.js 的 renderRoot 注释）。
       回放期间 sess.container 仍是文档里的真实容器，因此「加载更多」按钮的相对定位、
       会话判空、异常兜底清空这些依赖真实容器的逻辑全程有效；而回放中断也不再可能
       让渲染落点永久悬空——最坏情况只是落点没还原，下面的 finishReplay 会兜住。*/
    sess.renderTarget = tempDiv;
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
            /* 扫的是本轮回放刚建出来的节点，必须用渲染落点（回放期＝临时容器）。
               若用真实容器，prepend 回放会把文档里已有行上的 loading 态一并抹掉，
               甚至误伤正在流式输出的卡片——这正是下方「空壳清扫只能扫本页新插入节点」
               注释记录过的同一类教训。*/
            var turnRoot = renderRoot(sess);
            if (turnRoot) {
                // 孤儿骨架卡先移除再标黄：它从未执行过，黄点空卡会被读成「工具失败」。
                // 回放路径理论上碰不到（action_draft / action_args 不落盘），但实时流与回放共用
                // 同一渲染管线，此处与 finishStream 保持同构，避免两条收尾路径语义不一致。
                if (typeof removeOrphanArgsStreamingCards === 'function') removeOrphanArgsStreamingCards(sess);
                $(turnRoot).find('.tool-status-icon.loading').each(function() {
                    this.className = 'tool-status-icon warn';
                    this.innerHTML = '';
                });
                $(turnRoot).find('.agent-status-icon.loading').each(function() {
                    this.className = 'agent-status-icon done';
                });
                $(turnRoot).find('.agent-card-streaming').removeClass('agent-card-streaming');
                $(turnRoot).find('.thinking-block.streaming').removeClass('streaming');
            }
            resetStreamState(sess);
            purgeEmptyMdBlocks(renderRoot(sess));
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
                            // user 帧携带的附件路径（新落盘帧才有）：回放时还原为真实缩略图，
                            // 旧帧无该字段则保持纯文本气泡，与改前一致。
                            var rpImages = chunk.imagePaths || [];
                            var rpFiles = chunk.filePaths || [];
                            appendUserMessage(sess, chunk.text, null, null, chunk.createdAt,
                                (rpImages.length || rpFiles.length)
                                    ? { imagePaths: rpImages, filePaths: rpFiles } : null);
                            continue;
                        }
                        /* 挂起 done（ask_user / HITL）：回放也要落「已挂起」状态覆盖位。
                           实时侧由 finishStream 的挂起分支传 opts.status 完成（app-streaming.js），
                           回放侧不经 finishStream，若不同步打标，刷新/切会话后同一挂起段会从
                           「已挂起」变回「已完成」—— 正是本次要消除的那种实时/回放分叉。
                           必须在 endTurn() 之前：它内部 resetStreamState 会清 currentBubbleEl，
                           清了就再也定位不到该段气泡。挂起段不发 trace 帧（后端 done_suspended
                           直接 return），气泡无徽标，故用覆盖位回落；缝合过户徽标时徽标真值
                           优先（readTurnMeta 已按此排序），不会误挂。 */
                        if (chunk.type === 'done') {
                            if (chunk.suspended === true && sess.currentBubbleEl) {
                                var susBubble = sess.currentBubbleEl.parentNode;
                                var tcApiSus = (typeof window !== 'undefined') ? window.GourdTurnCompact : null;
                                if (susBubble && tcApiSus && tcApiSus.markTurnStatus) {
                                    try { tcApiSus.markTurnStatus(susBubble, 'suspended'); }
                                    catch (susErr) { console.error('[replayChunk] 挂起轮状态标记失败:', susErr); }
                                }
                            }
                            endTurn(); resetStreamState(sess); continue;
                        }
                        /* file_changes 是被动 run 快照：回放时也不得为了复用渲染入口临时置
                           isStreaming=true，否则对账与流状态语义会被元数据事件污染。 */
                        if (chunk.type === 'file_changes') {
                            onWebChunk(sess, chunk);
                            continue;
                        }

                        /* steer_applied 回放专用分支：不得把它交给 onWebChunk。
                           ①幂等：onWebChunk 会先查/写 sess.steerResolved，而回放路径上该集合可能
                              残留着已淘汰会话/上一轮的旧键，会把本该渲染的插话吞掉；回放的去重
                              靠 appendSteerNote 内部的 data-steer-id DOM 判定（同一容器内已存在即跳过）。
                           ②相位：onWebChunk 会用帧上的 phase/runId 覆写会话状态，而 steer 帧不属于正文
                              推进，让它改 activeRunId/phase 会污染本轮流式语义（done 对账也会跟着偏）。
                           故在本分支就地还原插话气泡，不进入通用路径。 */
                        if (chunk.type === 'steer_applied') {
                            sess.isStreaming = true;
                            var sItems = (chunk.args && chunk.args.items) || [];
                            for (var sk = 0; sk < sItems.length; sk++) {
                                if (sItems[sk] && sItems[sk].steerId) appendSteerNote(sess, sItems[sk]);
                            }
                            sess.isStreaming = false;
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
            /* 【P0-2 修复 2026-11】stall hook：watchdog 宽限耗尽时置 __replayStalled，
                此处检测到即直接走 fallback 收尾（salvage 半成品 + 释放门禁），
                而不是继续喂帧——卡死的 rAF 链若还在动，也能在下一帧被拦下。 */
            if (sess.__replayStalled) {
                finishReplayFallback(new Error('replay stalled (watchdog grace exhausted)'));
                return;
            }
            /* 还有未处理的事件，下一帧继续。
               回调整体兜底：rAF 回调抛出的异常无人接管，会直接终止分片链，
               replayDone 永不执行 → 门禁永不释放（与旧版 cancelAnimationFrame 同样的僵死后果）。*/
            sess._replayRafId = requestAnimationFrame(function() {
                try {
                    replayChunk();
                } catch (err) {
                    finishReplayFallback(err);
                }
            });
        } else {
            // 全部事件处理完毕，执行收尾
            replayDone();
        }
    }

    /* 回放收尾的统一出口。无论正常跑完还是中途抛异常，都必须还原渲染落点并释放
       _replaying / _gateBuffering 门禁、排空实时帧缓冲——少做任何一步，后续实时帧都会
       被永久扣在缓冲区里，表现为「后端在跑、界面不动」。 */
    function finishReplayFallback(err) {
        try { sess.__replayStalled = false; } catch (eStall) {}
        // 兜底：半成品若已并入容器则静默撤骨架；容器仍空才亮失败卡（见 hideHistoryLoading）
        hideHistoryLoading(sess, { failed: true });
        console.error('[replaySession] 回放收尾异常，执行兜底:', err);
        try {
            sess.renderTarget = null;
            sess._replaying = false;
            sess._replayClock = null;
            sess._replayRafId = null;
            sess._skipScroll = false;
            sess.isStreaming = false;
            // 半成品仍在临时容器里，直接并入真实容器尾部，避免这一页内容凭空消失
            if (tempDiv && tempDiv.firstChild && realContainer) {
                var salvage = document.createDocumentFragment();
                while (tempDiv.firstChild) salvage.appendChild(tempDiv.firstChild);
                if (prepend) realContainer.insertBefore(salvage, realContainer.firstChild);
                else realContainer.appendChild(salvage);
            }
            /* 【2026-11 白屏止血】异常发生在「已抽空 tempDiv、fragment 尚未入 DOM」窗口时，
                上面的 salvage 捞不到任何东西（tempDiv 已空），旧实现就此留下空容器 + 无
                骨架 + 无失败卡（覆盖层已被 replayDoneCore 先撤且 !mine 补不上）。
                此时 replayFragment 仍持有尚未落地的全部行，直接并入即可保住内容。
                入 DOM 后 fragment 自身会被清空，故不会重复插入。 */
            if (replayFragment && replayFragment.firstChild && realContainer) {
                if (prepend) realContainer.insertBefore(replayFragment, realContainer.firstChild);
                else realContainer.appendChild(replayFragment);
            }
            replayFragment = null;
        } catch (e) { /* 兜底本身不得再抛 */ }
        try { drainGateBuffer(sess); } catch (e) {}
        if (prepend && replayLoadMoreToken != null) {
            // 上面的统一收尾已复位 renderTarget/_replaying；无需调用会全局释放锚锁的 abortReplay，
            // 以免非活动旧会话的迟到回放错误解除新会话持有的锚锁。
            try { finishReplayLoadMore(sess, replayLoadMoreToken, { drain: false, updateButton: true }); } catch (e) {}
        } else {
            try { if (typeof updateLoadMoreBtn === 'function') updateLoadMoreBtn(sess); } catch (e) {}
            try {
                if (sess.sessionId === activeSessionId && typeof releaseScrollAnchor === 'function') {
                    releaseScrollAnchor();
                }
            } catch (e) {}
        }
    }

    function replayDone() {
        try {
            replayDoneCore();
        } catch (err) {
            finishReplayFallback(err);
        }
    }

    function replayDoneCore() {
        try { sess.__replayStalled = false; } catch (eStall) {}
        hideHistoryLoading(sess);   // 内容即将移入真实容器，先撤覆盖层
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
        /* resume 末轮补挂运行态样式：该行建于 _replaying=true 期（ensureAssistantBubble
           刻意不挂 agent-live），恢复后实时帧继续写入同一行且不再重建行，
           若不补挂，该轮实时过程行会失去扁平轨迹样式（B8）。
           只补类、不动 _replaying（门禁语义，20+ 消费方）。 */
        if (resumeState && resumeState.currentBubbleEl && resumeState.currentBubbleEl.closest) {
            var resumeRow = resumeState.currentBubbleEl.closest('.msg-row');
            if (resumeRow && resumeRow.classList) resumeRow.classList.add('agent-live');
        }
        sess._replaying = false;
        sess._replayClock = null;
        sess.isStreaming = false;
        sess._replayRafId = null;
        sess._skipScroll = false;       // 回放结束，恢复滚动管线

        // 回放结束：还原渲染落点，后续一律写真实容器
        sess.renderTarget = null;
        var fragment = document.createDocumentFragment();
        replayFragment = fragment;
        while (tempDiv.firstChild) { fragment.appendChild(tempDiv.firstChild); }
        // prepend 的空气泡清扫只能扫本页新插入的节点，故先留存引用（入 DOM 后 fragment 会被清空）
        var prependedRows = prepend ? Array.prototype.slice.call(fragment.childNodes) : null;

        if (prepend) {
            // 用户在 prepend 前是否贴着底部（gap<=80 与 app-base.js userScrolledUp 阈值同口径）：
            // 决定下方 anchorEl 缺席时的兜底补偿是否允许执行。必须在插入前采集（插入后 scrollHeight 即变）。
            // WHY：兜底补偿 scrollTop += ΔscrollHeight 的语义是「把视口留在底部」，只对原本就在底部的
            // 用户成立；用户在顶部/中部时这行会把视口直接拽到底部——「上拉到顶被拽回底部」的根因
            // （实测栈：replayDoneCore 的 else 兜底，cur=0 时写入 v=scrollHeight-clientHeight）。
            var atBottomBeforePrepend = (messagesWrap.scrollHeight - messagesWrap.scrollTop - messagesWrap.clientHeight) <= 80;
            // 跨页缝合必须在选锚点之前：缝合会删除真实容器里的首行（内容并入本页末行），
            // 若锚点先选中了它，修正时读的是脱离文档的节点，视口会跳。
            // 缝合返回值携带「被删行删除前的视觉偏移 + 内容目的行」：单行会话场景下
            // 被删行正是用户正在看的唯一行，锚点循环随后必然落空（rows=0），
            // 需靠目的行在插入后做锚点修正（见 applyPrependViewportFix）。
            var stitchInfo = stitchPrependedRunRows(fragment, realContainer, sess);

            // 选锚点：当前视口顶部第一个可见的旧消息行及其相对偏移。
            var anchorEl = null, anchorOffset = 0;
            var wrapTop = messagesWrap.getBoundingClientRect().top;
            var rows = realContainer.children;
            for (var ai = 0; ai < rows.length; ai++) {
                var rect = rows[ai].getBoundingClientRect();
                // 第一个底边落在视口顶部下方的元素，即用户正在看的那一条
                if (rect.bottom > wrapTop) { anchorEl = rows[ai]; anchorOffset = rect.top - wrapTop; break; }
            }

            // prepend 插入到现有内容之前；先记录 scrollHeight，供 anchorEl 缺席时兜底修正视口。
            var scrollHeightBefore = messagesWrap.scrollHeight;
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
                // 耗时徽标本身就是有效内容：一轮「只调工具无正文」的对话，其助手行可能只剩 trace，
                // 漏算它会让这些历史行在「加载更多」后被当成空壳删掉（连同耗时详情一起消失）。
                var hasTrace = $row.find('.msg-trace').length > 0;
                if (!hasContent && !hasTools && !hasThinking && !hasBadge && !hasTrace) {
                    $row.remove();
                }
            }

            // 请求和分片回放期间的续期已覆盖到这里；停止续期并把锚定锁交还给收尾阶段。
            if (replayLoadMoreToken != null) stopReplayLoadMoreAnchorRenewal(sess, replayLoadMoreToken);
            // 加载按钮在锚定修正之前重建：它插在容器顶部（高约 54px），若留到修正之后，
            // 这段高度会在锚点上方凭空出现，把刚对齐好的内容再顶下去。
            if (typeof updateLoadMoreBtn === 'function') updateLoadMoreBtn(sess);

            // 锚点在异步分片回放收尾时才选取，因此它对应用户此刻正在看的行（含请求在途中的手动滚动）；
            // prepend 后仅修正这条仍可见的旧行，不恢复请求开始时的绝对 scrollTop。
            applyPrependViewportFix(messagesWrap, anchorEl, anchorOffset, atBottomBeforePrepend, scrollHeightBefore, stitchInfo);
        } else {
            // 初始加载模式：清空后移入
            $(realContainer).html('');
            realContainer.appendChild(fragment);
        }

        /* P2-6 按轮 Compact 折叠：一轮结束时把思考/工具过程行收起成一行统计摘要，
           只留最终正文。必须在 fragment 移入真实容器之后（要量 DOM 子节点）、
           高亮/mermaid/插话补测与滚动锚定修正之前（折叠会改变行高，先滚后折会错位）。
           【逐轮独立】lastTurnClosed 只描述本页最后一轮自身是否结束，与「是否还有更早历史」
           无关 —— dsh #6250 的 `!historyIncomplete` 全局门控会让长会话折叠全部失效。
           进行中的最后一轮（keepOpen）必须保留全部过程证据，不许折叠。
           偏好开关：localStorage 的 gourd.turnCompact === '0' 时完全不启用（可一键回退）。 */
        try {
            var tcApi = (typeof window !== 'undefined') ? window.GourdTurnCompact : null;
            var tcOff = false;
            try { tcOff = (typeof localStorage !== 'undefined') && localStorage.getItem('gourd.turnCompact') === '0'; } catch (tcLsErr) { /* 隐私模式忽略 */ }
            if (tcApi && tcOff) {
                /* 关掉偏好后必须撤销【已渲染】的折叠，否则只是「不再新增」，
                   屏幕上仍留着上一轮插好的摘要按钮和隐藏标记 = 回退名不副实。
                   clearTurnCompact 幂等：无标记时是空扫描。 */
                tcApi.clearTurnCompact(realContainer);
                /* 运行态批次盖子与 turn-compact 共用同一偏好开关：关掉时一并撤销，
                   否则历史里仍留着「已处理」盖子与折叠成员 = 回退名不副实。 */
                var tbApiOff = (typeof window !== 'undefined') ? window.GourdTurnBatch : null;
                if (tbApiOff && tbApiOff.clearBatch) tbApiOff.clearBatch(realContainer);
            } else if (tcApi) {
                /* 【历史 = 运行态】回放重建的历史气泡没有批次盖子（noteProcessInsert 有
                   _replaying 门禁，运行期不建盖子）。点开整轮摘要后过程行会逐条平铺，
                   与运行态的 Qoder 多折叠组形态对不上（用户 2026-11 报障）。
                   故在 applyTurnCompact 之前按运行态同一套边界规则补建 closed 态批次组
                   —— compact 的分类要看到已收口的盖子形态，顺序不能反。
                   幂等：气泡已有盖子（运行态延续/重复调用）时跳过。 */
                try {
                    var tbRebuild = (typeof window !== 'undefined') ? window.GourdTurnBatch : null;
                    if (tbRebuild && tbRebuild.rebuildBatchesIn) {
                         tbRebuild.rebuildBatchesIn(realContainer, {
                             scopeRows: prepend ? (prependedRows || []) : null,
                             // 盖子文案 i18n（与 applyTurnCompact 的 translate 同口径）
                             translate: (typeof GourdI18n !== 'undefined' && GourdI18n.t) ? function (k) { return GourdI18n.t(k); } : null
                         });
                    }
                } catch (rebuildErr) {
                    console.error('[replaySession] 历史批次重建失败:', rebuildErr);
                }
                var lastClosed = !keepOpen;
                if (!lastClosed) {
                    for (var tci = events.length - 1; tci >= 0; tci--) {
                        var tcType = events[tci] && events[tci].type;
                        if (tcType === 'user' || tcType === 'user_input') break;
                        if (tcType === 'done' || tcType === 'trace') { lastClosed = true; break; }
                    }
                }
                tcApi.applyTurnCompact(realContainer, {
                    lastTurnClosed: lastClosed,
                    /* 【code review 修复 2026-11】回放轮全部是已发生的历史，必须与运行态
                       finishStream 真收口同口径传 ended:true —— 否则「批次盖子让位」
                       门禁（compactBubble 只在 ended 时放行）会把带盖子的历史轮全部
                       短路，历史无正文轮永不折成整轮摘要，与运行态形态分叉。
                       keepOpen 的进行中轮由 lastTurnClosed 排除，不会被误折。 */
                    ended: true,
                    // prepend 只折本次新插入的更早历史轮，绝不碰容器底部正在实时流式的回复
                    scopeRows: prepend ? (prependedRows || []) : null,
                    translate: (typeof GourdI18n !== 'undefined' && GourdI18n.t) ? function (k) { return GourdI18n.t(k); } : null
                });
            }
        } catch (tcErr) {
            // 纯展示增强，任何异常都不许影响历史消息本身的可用性
            console.error('[replaySession] 按轮 Compact 折叠失败:', tcErr);
        }

        // 代码高亮和 mermaid 也分片执行，避免阻塞
        if (typeof highlightCodeBlocks === 'function') highlightCodeBlocks(realContainer);
        if (typeof processMermaidBlocks === 'function') processMermaidBlocks(realContainer);

        /* 插话折叠补测：回放期节点在游离临时容器里测不到高度（getComputedStyle/scrollHeight 均为 0），
           只能按阈值初判并打上 data-steer-collapse-pending。现在 fragment 已移入真实容器，
           逐行真实测量一次：视觉不足 5 行的撤掉折叠与展开按钮（否则留下「点了没变化」的
           无效按钮），仍超长的补上。必须在下方滚动收尾之前：补测会改变行高，先滚后量会错位。 */
        if (typeof steerCollapseRemeasure === 'function') {
            var pendingSteerRows = $(realContainer).find('.steer-note[data-steer-collapse-pending]');
            for (var psi = 0; psi < pendingSteerRows.length; psi++) {
                var pendingSteerRow = pendingSteerRows[psi];
                pendingSteerRow.removeAttribute('data-steer-collapse-pending');
                try {
                    steerCollapseRemeasure(pendingSteerRow);
                } catch (steerErr) {
                    console.error('[replaySession] 插话折叠补测失败:', steerErr);
                }
            }
        }

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
        if (prepend && replayLoadMoreToken != null) holdReplayLoadMoreAnchor(sess, replayLoadMoreToken);
        drainGateBuffer(sess);

        // 回放期新建的文件变更卡片在这里统一补对账。file_changes 是被动事件，不会临时进入
        // streaming 态；但回放 DOM 仍先建在临时容器中，所以必须等节点移入真实容器后再请求，
        // 确保对账响应回填时 upsert 能命中并原地更新已有卡片。
        // 回放期 _replaying 为真，变更卡片一律只登记不渲染。节点现已移入真实容器，
        // 这里一次性补渲染，否则历史会话看不到任何变更记录。
        if (typeof window.flushFileChangesReplayRender === 'function') window.flushFileChangesReplayRender(sess);
        if (typeof window.flushFileChangesReplayReconcile === 'function') window.flushFileChangesReplayReconcile(sess);

        /* 回放把整批消息搬进真实容器（初始加载=整体替换 / prepend=前插），
           刻度带的消息集合随之变化，必须重建。放在滚动收尾之前：
           比例依赖 scrollHeight，而下方 scrollToBottom 会改 scrollTop（不改 scrollHeight，
           但 prepend 分支的锚点修正会插入/删除节点，故统一放在它之前更安全）。 */
        if (typeof window.refreshHistoryRail === 'function') window.refreshHistoryRail(true);

        if (!prepend) {
            // 初始加载：滚动到底部，然后显示/隐藏加载按钮
            if (sess.sessionId === activeSessionId) scrollToBottom(true);
            if (typeof updateLoadMoreBtn === 'function') updateLoadMoreBtn(sess);
        } else {
            // 按钮与滚动位置均已在 DOM 插入后处理完毕。
            // 锚锁延到下一帧再释放：排空缓冲时投递的 rAF 滚动帧尚未执行，
            // 此刻直接释放仍会被它们拽到底部。
            requestAnimationFrame(function() {
                requestAnimationFrame(function() {
                    if (replayLoadMoreToken != null) {
                        finishReplayLoadMore(sess, replayLoadMoreToken, { drain: false, updateButton: true });
                    } else {
                        releaseScrollAnchor();
                    }
                });
            });
        }

    }

    // 启动分片回放。首帧是同步执行的，它抛异常会直接把异常抛回 loadMessages 的
    // ajax 回调（那里只 catch 了自己的同步段），门禁同样释放不掉，故一并兜底。
    try {
        replayChunk();
    } catch (err) {
        finishReplayFallback(err);
    }
}

/* prepend 收尾的视口修正（2026-10-19 自审从内联代码抽出为纯函数，供契约测试行为级断言）。
   三分支，按可信度递降：
   ① anchorEl 在文档中：用户正在看的旧行仍在，按其视觉偏移修正（常规路径）。
      contains 守卫：锚点行若已被缝合删除（单行会话场景），getBoundingClientRect
      读脱离文档节点会得 0，修正量变成 -anchorOffset 的错值，必须降级到②。
   ② stitchInfo 首个搬移节点在文档中：缝合删掉的正是用户正在看的行（其内容已搬入
      目的行），按「搬移后首个内容节点的视觉顶 - 被删行删除前的视觉顶」修正——
      否则分页后视口显示新页顶、用户原阅读内容沉到视口外（实测 P1-A 视觉跳变）。
      注意锚点必须是搬移的内容节点而非目的行本身：目的行顶部是新页内容的起点，
      原内容在其下方（页脚之前），用行顶做锚会把原内容留在视口外。
   ③ 两者皆缺席且用户原本贴底：scrollHeight 增量即 prepend 内容高度，补偿 scrollTop
      让视口继续留在底部。用户不贴底时 prepend 内容全在视口上方，浏览器不移动可见区，
      保持不动即不跳——旧实现此处无条件补偿，是「上拉到顶被拽回底部」的根因。 */
function applyPrependViewportFix(wrap, anchorEl, anchorOffset, atBottomBeforePrepend, scrollHeightBefore, stitchInfo) {
    var wrapTop = wrap.getBoundingClientRect().top;
    if (anchorEl && document.contains(anchorEl)) {
        var newTop = anchorEl.getBoundingClientRect().top - wrapTop;
        wrap.scrollTop += (newTop - anchorOffset);
        return;
    }
    var moved = stitchInfo && stitchInfo.firstMoved;
    if (moved && document.contains(moved) && stitchInfo.removedVisualTop != null) {
        wrap.scrollTop += (moved.getBoundingClientRect().top - wrapTop) - stitchInfo.removedVisualTop;
        return;
    }
    if (atBottomBeforePrepend) {
        wrap.scrollTop += (wrap.scrollHeight - scrollHeightBefore);
    }
}

/* prepend 回放的跨页同 run 缝合：后端页边界（字节预算截断、旧数据无游标等）偶尔会落在某条
   assistant run 的中段，于是本页末行与真实容器首行属于同一个 runId——不缝合的话同一条回答
   在 DOM 上是「上方碎片行 + 下方残段行」两行，且每次上拉都可能再切一刀。
   缝合规则：把下方行 .msg-bubble 的内容子节点（正文/思考块/工具卡等，按原序）搬入上方行气泡，
   下方行的耗时徽标与时间先过户再整行删除。meta-row / msg-actions 不搬（上方行自带一套，
   搬过去会出现两份复制/重跑按钮）。
   返回值：未缝合返回 null；缝合成功返回 { firstMoved, removedVisualTop }——被删行
   删除前相对视口顶的视觉偏移，与首个被搬移的内容节点引用（插入文档后调用方可实测
   其视觉顶）。单行会话场景下被删行就是用户正在看的唯一行，调用方需靠 firstMoved
   在插入后做锚点修正，否则视口内容被换页。 */
function stitchPrependedRunRows(fragment, realContainer, sess) {
    var kids = fragment.childNodes;
    var lastRow = null;
    for (var i = kids.length - 1; i >= 0; i--) {
        var n = kids[i];
        if (n.nodeType === 1 && n.classList && n.classList.contains('msg-row') && n.classList.contains('assistant')) { lastRow = n; break; }
    }
    if (!lastRow) return null;
    var runId = lastRow.getAttribute('data-run-id');
    if (!runId) return null;
    var firstRow = null;
    var rows = realContainer.children;
    for (var j = 0; j < rows.length; j++) {
        var r = rows[j];
        if (r.nodeType === 1 && r.classList && r.classList.contains('msg-row') && r.classList.contains('assistant')) { firstRow = r; break; }
    }
    if (!firstRow || firstRow === lastRow) return null;
    if (firstRow.getAttribute('data-run-id') !== runId) return null;
    // 绝不动承载实时流式输出的行：删掉它会让 sess.currentBubbleEl 指向脱离文档的节点
    if (sess && sess.currentBubbleEl && (firstRow === sess.currentBubbleEl || firstRow.contains(sess.currentBubbleEl))) return null;
    var srcBubble = $(firstRow).find('.msg-bubble')[0];
    var dstBubble = $(lastRow).find('.msg-bubble')[0];
    if (!srcBubble || !dstBubble || srcBubble === dstBubble) return null;
    // 被删行删除前的视觉偏移：此刻容器尚未变动，实测即准（调用方在选锚点前调用本函数）。
    var removedVisualTop = firstRow.getBoundingClientRect().top - messagesWrap.getBoundingClientRect().top;

    // 徽标/时间过户：下方行是本 run 的收尾页，耗时徽标与完成时间在它身上
    var srcMeta = $(firstRow).find('.msg-meta-row')[0];
    var dstMeta = $(lastRow).find('.msg-meta-row')[0];
    if (srcMeta && dstMeta) {
        var srcTrace = $(srcMeta).find('.msg-trace')[0];
        if (srcTrace && !$(dstMeta).find('.msg-trace')[0]) {
            dstMeta.appendChild(srcTrace);
        }
        var srcTime = $(srcMeta).find('.msg-time')[0];
        var dstTime = $(dstMeta).find('.msg-time')[0];
        if (srcTime && dstTime && (srcTime.textContent || '').trim() && !(dstTime.textContent || '').trim()) {
            dstTime.textContent = srcTime.textContent;
            dstTime.style.display = srcTime.style.display;
        }
    }
    // 内容按原序搬移：反复取 src 的首个子元素插到 dst 页脚之前（跳过 meta/actions）。
    // 页脚（时长徽章/操作按钮）必须永远在正文流末端——直接 appendChild 会把缝合内容
    // 压到页脚之后，出现「时长徽章在上、卡片在下」的错序（与 positionCard 同源的缺陷）。
    var dstFooter = null;
    for (var fi = 0; fi < dstBubble.childNodes.length; fi++) {
        var fn = dstBubble.childNodes[fi];
        if (fn && fn.classList && (fn.classList.contains('msg-meta-row') || fn.classList.contains('msg-actions'))) { dstFooter = fn; break; }
    }
    var firstMoved = null;
    while (srcBubble.firstElementChild) {
        var child = srcBubble.firstElementChild;
        if (child.classList && (child.classList.contains('msg-meta-row') || child.classList.contains('msg-actions'))) {
            child.parentNode.removeChild(child);
            continue;
        }
        if (firstMoved === null) firstMoved = child;
        if (dstFooter) dstBubble.insertBefore(child, dstFooter);
        else dstBubble.appendChild(child);
    }
    $(firstRow).remove();
    return { firstMoved: firstMoved, removedVisualTop: removedVisualTop };
}

/* 【2026-11】historyGen：由 loadMessages 传入的加载世代号。切会话/重试后旧请求
    迟到时直接丢弃，不再把上一代内容盖进当前会话。旧调用方不传则恒为 undefined，
    undefined === undefined 通过，行为完全向后兼容。 */
function loadMessagesLegacy(sess, rootQ, historyGen) {
    /* 【P1-2 修复 2026-11】裸 $.get → $.ajax + timeout + abort 句柄：
       旧实现无 timeout（请求可无限悬挂）、无 abort（watchdog 12s abort 只对
       replay XHR 生效，legacy XHR 悬挂时旧响应 done 仍会重建整页）。
       gen 校验只挡迟到写入，挡不住连接悬挂。timeout 用宽口径（watchdog 先行）。 */
    var legacyXhr = $.ajax({
        url: '/web/chat/messages?sessionId=' + encodeURIComponent(sess.sessionId) + rootQ,
        method: 'GET',
        timeout: HISTORY_HTTP_TIMEOUT_MS,
        success: function (resp) {
            /* 请求完成即摘句柄：watchdog 的 abort 不再指向已终结的请求。 */
            if (sess._historyLoadXhr === legacyXhr) sess._historyLoadXhr = null;
        if (historyGen !== undefined && sess._historyLoadGeneration !== historyGen) return;
        if (typeof sessionMap !== 'undefined' && sessionMap[sess.sessionId] !== sess) return;
        // 声明提到 try 外：异常兜底分支要用到，放在 try 内会踩 var 提升的 undefined 陷阱
        var realContainer = null;
        var tempDiv = null;
        /* 【2026-11 白屏止血】与 replaySession 同款：fragment 提到闭包作用域，
            「html('') → 抽空 tempDiv → appendChild」窗口内抛错时兜底仍能捞回内容。 */
        var legacyFragment = null;
        try {
            var msgs = resp.data;
            realContainer = sess.container;
            // 用临时容器批量构建 DOM，避免逐条 append 触发多次 layout。
            // 同 replaySession：只切渲染落点，sess.container 始终是真实容器。
            tempDiv = document.createElement('div');
            sess.renderTarget = tempDiv;
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
                hideHistoryLoading(sess);
                // 回放结束：还原渲染落点，一次性移入所有子节点
                sess.renderTarget = null;
                $(realContainer).html('');
                var fragment = document.createDocumentFragment();
                legacyFragment = fragment;
                while (tempDiv.firstChild) {
                    fragment.appendChild(tempDiv.firstChild);
                }
                realContainer.appendChild(fragment);
                legacyFragment = null;
                /* legacy 路径从不置 _replaying（它是门禁语义，20+ 消费方，不能借），
                   而 ensureAssistantBubble 只在 _replaying 为真时省略 agent-live ——
                   于是这条回退路径的历史行全部带着「本轮正在跑」的运行态样式，
                   且没有 finishStream 来摘除。纯样式修正：历史行一律摘掉（B7）。
                   本路径只渲染正文（无思考/工具过程行），折叠在此天然 no-op，不需接。 */
                var liveRows = realContainer.querySelectorAll('.msg-row.assistant.agent-live');
                for (var lr = 0; lr < liveRows.length; lr++) liveRows[lr].classList.remove('agent-live');
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
            /* 异常时确保渲染落点复位。
               旧实现写的是 if (realContainer) sess.container = realContainer，而 realContainer
               声明在 try 内部：若异常发生在赋值之前（如 resp.data 取值抛错），它是 undefined，
               兜底整个失效、容器永久悬空。现在落点复位无条件执行，不依赖任何局部变量。*/
            hideHistoryLoading(sess, { failed: true });
            sess.renderTarget = null;
            /* 【2026-11 白屏止血】旧 catch 只复位落点、无 salvage：中途异常时
                tempDiv 已抽空、fragment 未入 DOM，且覆盖层已被 loadDone 先撤 ⇒
                真空白且无失败卡。这里把两处半成品都并入真实容器。 */
            try {
                if (realContainer) {
                    if (tempDiv && tempDiv.firstChild) {
                        var salvageLegacy = document.createDocumentFragment();
                        while (tempDiv.firstChild) salvageLegacy.appendChild(tempDiv.firstChild);
                        realContainer.appendChild(salvageLegacy);
                    }
                    if (legacyFragment && legacyFragment.firstChild) {
                        realContainer.appendChild(legacyFragment);
                    }
                }
            } catch (salvageErr) { /* 兜底本身不得再抛 */ }
            legacyFragment = null;
            drainGateBuffer(sess);
        }
        },
        error: function(xhr, textStatus) {
        if (sess._historyLoadXhr === legacyXhr) sess._historyLoadXhr = null;
        /* watchdog/loadMessages abort 的不是失败：当前代已被顶掉或已降级处理。 */
        if (textStatus === 'abort') return;
        // legacy 请求失败也必须释放回放/实时互斥门禁；
        // 否则后续 WebSocket 帧会永久滞留在 _gateBuffer。
        if (historyGen !== undefined && sess._historyLoadGeneration !== historyGen) return;
        hideHistoryLoading(sess, { failed: true });
        drainGateBuffer(sess);
        }
    });
    /* 注册句柄：loadMessages 重试 / watchdog 12s 降级时能 abort 这条悬挂请求。 */
    sess._historyLoadXhr = legacyXhr;
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
var cmdTrigger = null; // '/' for skills, '@' for subagents

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
// 当前展示候选集的面板元素（欢迎页 / 对话页 / 自动化页共用同一份全局状态）。
// 多宿主复用后必须记住「这份状态属于谁」：否则自动化页收起自己的面板时
// 会把聊天页正在展示的候选集一并清空（反之亦然）。
var cmdActivePanel = null;

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
    // 模型下拉
    $('#chatModelDropdown, #welcomeModelDropdown').removeClass('show');
    // 访问控制档位气泡（工具栏左区，与其余浮层互斥）
    $('.access-selector').removeClass('open');
    // 任务面板
    if (typeof window.hideTodoPanel === 'function') window.hideTodoPanel();
    // 队列面板
    $('#message-queue-container').hide();
}
window.closeAllToolbarPanels = closeAllToolbarPanels;

function showCmdComplete(inputEl, completeEl, prefix) {
    if (!commandsLoaded || commandList.length === 0) return;
    closeAllToolbarPanels();
    var trigger = prefix.charAt(0);
    var query = prefix.substring(1).toLowerCase();
    /* 「/」专属于技能（2026-10 收敛）：它是最显眼、最不用切换键盘的符号，
       内建命令（/clear /compact …）仍可手写，但不再占用补全面板——
       面板一开就只给用户看他要找的技能，不用先在一堆命令里排除。
       「$」入口已删除（旧习惯者输入 $xxx 会当普通文本，不上技能）。 */
    var filterType = (trigger === '@') ? 'subagent' : 'skill';
    cmdVisibleItems = [];
    var html = '';

    for (var i = 0; i < commandList.length; i++) {
        var cmd = commandList[i];
        // Filter by type based on trigger
        if (cmd.type !== filterType) continue;
        /* 技能行展示「显示名」而非目录 id（如 _user_xxx_pdf）：id 对用户不可读，
           与市场卡片也对不上。displayName 由后端按市场元数据口径给出，缺失时回退 id。
           过滤同时匹配 id 与显示名：面板改成显示名后，只按 id 过滤会让中文输入永远筛不中。 */
        var display = (cmd.type === 'skill' && cmd.displayName) ? cmd.displayName : cmd.name;
        if (cmd.name.toLowerCase().indexOf(query) === 0
                || display.toLowerCase().indexOf(query) === 0
                || query.length === 0) {
            cmdVisibleItems.push(cmd);
            var nameClass = (trigger === '@') ? 'cmd-name subagent' : 'cmd-name skill';
            html += '<div class="cmd-complete-item" data-index="' + (cmdVisibleItems.length - 1) + '">'
                + '<span class="' + nameClass + '">' + escapeHtml(trigger + display) + '</span>'
                + (cmd.type === 'skill' ? '<span class="cmd-id-tag" title="' + escapeAttr(cmd.name) + '">' + escapeHtml(cmd.name) + '</span>' : '')
                + '<span class="cmd-desc">' + escapeHtml(cmd.description || '') + '</span>'
                + '</div>';
        }
    }

    if (cmdVisibleItems.length === 0) {
        hideCmdCompleteFor(completeEl);
        return;
    }

    cmdTrigger = trigger;
    cmdActiveIndex = -1;
    cmdActivePanel = completeEl;
    $(completeEl).html(html).addClass('show');
}

function hideCmdComplete() {
    $welcomeCmdComplete.removeClass('show');
    $chatCmdComplete.removeClass('show');
    cmdActiveIndex = -1;
    cmdVisibleItems = [];
    cmdTrigger = null;
    cmdActivePanel = null;
}

/**
 * 参数化收起：只收起指定面板，并在全局候选集确属该面板时一并清空。
 *
 * 供其它宿主页（自动化表单的 #autoCmdComplete）复用命令补全时调用：
 * 直接调 hideCmdComplete() 会漏收这些非聊天页面板（它只认两个固定 id），
 * 而无条件清空全局状态又会误伤聊天页正在展示的候选集。
 * 不传 el 时等同 hideCmdComplete()。
 */
function hideCmdCompleteFor(el) {
    if (!el) { hideCmdComplete(); return; }
    $(el).removeClass('show');
    if (!cmdActivePanel || cmdActivePanel === el) {
        cmdActiveIndex = -1;
        cmdVisibleItems = [];
        cmdTrigger = null;
        cmdActivePanel = null;
    }
}

/* ===== 技能小卡片（chip）=====
   选中技能后不再把 "/技能id" 文本回填进 textarea（旧实现的问题：id 不可读、
   且触发符占住行首导致一次输入只能触发一个技能），改为在输入框上方的独立
   chip 行插入一枚小卡片：表面显示技能名，内部 data-skill-id 隐藏真实 id。
   发送时由 app-streaming.js 把 chip 的 id 以 "/id " 前缀注入消息文本——
   后端斜杠技能协议（SkillInvocation / Java runSkill）只认 id，展示名不参与路由。
   多个 chip 的 id 依次前置，服务端按序注入各技能规约。

   容器刻意独立于附件区（.attachments-wrap），理由见 app.css 的 .skill-chips 注释：
   附件区默认隐藏且被 renderAttachmentsWrap 全量 html('') 重建，chip 寄生其中会
   既看不见又被附件操作顺手抹掉。这里 chip 只受本文件的增删函数管理。 */
function chipWrapFor(inputEl) {
    return (inputEl === welcomeInput) ? '#welcomeSkillChips' : '#chatSkillChips';
}

/* 维护容器可见性：有 chip 才显形（.has-chips）。增删后统一调它，避免遗漏。 */
function syncSkillChipsVisibility($wrap) {
    $wrap.toggleClass('has-chips', $wrap.find('.skill-chip').length > 0);
}

function addSkillChip(inputEl, cmd) {
    var id = cmd.name;
    var display = cmd.displayName || cmd.name;
    var $wrap = $(chipWrapFor(inputEl));
    // 同一技能不重复挂卡：重复触发只会让用户困惑「到底生效几个」
    if ($wrap.find('.skill-chip[data-skill-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]').length) {
        return false;
    }
    var $chip = $('<span class="skill-chip" contenteditable="false"></span>')
        .attr('data-skill-id', id)
        .attr('title', id)
        .append('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>')
        .append($('<span class="skill-chip-name"></span>').text(display))
        .append('<button type="button" class="skill-chip-x" aria-label="remove">&#10005;</button>');
    $wrap.append($chip);
    syncSkillChipsVisibility($wrap);
    return true;
}

/* 读取输入框关联的全部技能 chip：[{id, name}]。
   id 是路由键（发送时前置为 "/id "），name 是展示名（气泡回显用人读形态）。
   一次读全，避免发送链路里分两处查 DOM —— 两处之间任何一次重渲染都会让
   id 与展示名对不上号。 */
function getSkillChips(inputEl) {
    var out = [];
    $(chipWrapFor(inputEl)).find('.skill-chip').each(function () {
        var id = $(this).attr('data-skill-id');
        if (!id) return;
        out.push({ id: id, name: $(this).find('.skill-chip-name').text() || id });
    });
    return out;
}

/* 读取输入框关联的全部技能 chip id（发送时注入用） */
function getSkillChipIds(inputEl) {
    return getSkillChips(inputEl).map(function (c) { return c.id; });
}

/* 发送后清空 chip（与 clearInput 同语义）。chat/welcome 两个容器分别清。 */
function clearSkillChips(fromWelcome) {
    var $chat = $('#chatSkillChips').empty();
    syncSkillChipsVisibility($chat);
    if (fromWelcome) {
        var $welcome = $('#welcomeSkillChips').empty();
        syncSkillChipsVisibility($welcome);
    }
}
window.getSkillChipIds = getSkillChipIds;
window.getSkillChips = getSkillChips;
window.clearSkillChips = clearSkillChips;

/* chip 的删除按钮：委托到 document，删后同步所属容器可见性 */
$(document).on('click', '.skill-chip-x', function (e) {
    e.stopPropagation();
    var $chip = $(this).closest('.skill-chip');
    var $wrap = $chip.parent();
    $chip.remove();
    syncSkillChipsVisibility($wrap);
});

/* 用 replacement 替换输入框中的触发段 [token.start, token.end)，光标停在替换文本末尾。
   技能选中后 replacement 为空串（触发段消失，技能以 chip 形式存在）；
   子代理选中后为 "@name"（保留旧的文本协议）。 */
function replaceCmdToken(inputEl, token, replacement) {
    var val = inputEl.value;
    var before = val.substring(0, token.start);
    var after = val.substring(token.end);
    /* 回填文本后必须留一个空格分隔，且【after 为空串时同样要补】—— 这正是子代理
       选完就失效的病根：后端子代理路由（WebGate/WsGate/CliShell）一律按
       `input.startsWith("@")` + `indexOf(" ")` 剥 agentName，剥不出就当普通文本。
       旧条件多写了一个 `after &&`，而选完候选时光标通常在末尾（after === ''，falsy）
       → 不补空格 → 用户接着输入就粘成 "@general帮我查一下" → 后端 indexOf(" ") == -1
       → agentName 恒为 null，子代理从未被调用，整串还被当提示词发给主代理。 */
    if (replacement && !/^\s/.test(after)) replacement += ' ';
    inputEl.value = before + replacement + after;
    var pos = before.length + replacement.length;
    inputEl.setSelectionRange(pos, pos);
    autoResize(inputEl);
}

function applyCmdSelection(inputEl, completeEl) {
    if (cmdActiveIndex >= 0 && cmdActiveIndex < cmdVisibleItems.length) {
        var cmd = cmdVisibleItems[cmdActiveIndex];
        /* chip 形态只属于聊天页两个输入框；自动化页（#autoPrompt）等外部宿主
           复用本函数时仍走旧的文本回填，否则技能会落到聊天页的 chip 行上、
           宿主自己拿不到（它的 prompt 存在表单里，发送链路不经 sendMessage）。 */
        var useChip = (inputEl === welcomeInput || inputEl === chatInput);
        var token = findCmdTriggerToken(inputEl);
        if (cmd.type === 'skill' && useChip) {
            // 技能：生成小卡片（展示名 + 隐藏 id），触发段从文本中移除，
            // textarea 保持干净，可继续输入请求内容、可再触发第二个技能
            addSkillChip(inputEl, cmd);
            if (token) replaceCmdToken(inputEl, token, '');
        } else if (token) {
            /* 回填符号取 token.trigger（现算），不取 cmdTrigger（面板弹出时缓存）：
               面板开着时点击 textarea 移动光标并不触发 input，cmdTrigger 不会刷新，
               用缓存值会把 '@agent' 的候选以 '/' 插进新位置的触发段。 */
            replaceCmdToken(inputEl, token, token.trigger + cmd.name);
        } else {
            // 兜底：面板在无触发段的情况下被 apply（外部宿主直接调用），按旧语义前插
            var trigger = cmdTrigger || '/';
            inputEl.value = trigger + cmd.name + ' ' + inputEl.value;
            inputEl.setSelectionRange(trigger.length + cmd.name.length + 1, trigger.length + cmd.name.length + 1);
            autoResize(inputEl);
        }
    }
    // 按面板收起：同一函数既服务聊天页两个面板，也服务自动化页面板
    hideCmdCompleteFor(completeEl);
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
        hideCmdCompleteFor(completeEl);
        return true;
    }

    return false;
}

/* 定位光标所在（或紧邻光标前）的 / 或 @ 触发段。
   旧实现只认「整串以 / 开头且无空格」，于是输入框里一旦有了内容（或已选过一个技能），
   再打 / 就永远唤不出面板——即用户报的「只能触发一次」。

   现口径分两步（A 优先，B 兜底）：
   A. 从光标向左扫到最近的空白/串首得到 token；token 本身以 / 或 @ 开头即为触发段。
      这条同时照顾两级组织技能名（design/lanhu 整段命中，不会被名字内部的 / 截断）。
   B. token 不以触发符开头时，取 token 内【最后一个】/ 或 @ 作为触发段起点 —— 中文场景
      必须走这条：「帮我写/」里 token 是整串（中文不带空格分词），只认 A 就永远弹不出面板。
      同理「+ → 技能」按钮在已有文字后插入 /，随后每敲一个字都要靠 B 续住面板。
      B 加一道护栏：触发符前一个字符若是 ASCII 字母数字或 : / . - _（URL 与文件路径的
      构成字符），判为非触发 —— 否则 http://x.com、src/main 这类输入会误弹面板。 */
function findCmdTriggerToken(inputEl) {
    var val = inputEl.value;
    var cursor = inputEl.selectionStart == null ? val.length : inputEl.selectionStart;
    var start = cursor;
    while (start > 0 && !/\s/.test(val.charAt(start - 1))) start--;
    if (start >= cursor) return null; // 光标前无 token（空或紧贴空白）
    /* 统一回扫：从光标往回找【最后一个】真正的触发符，规则对 A/B 两种形态一致 ——
       ① i === start：token 就以触发符开头，整段都是正在输入的候选名（技能名可含 /，
          两级组织如 design/lanhu 必须整段命中，否则回填会算错前缀位置）；
       ② 触发符前一个字符是名字字符（字母/数字/斜杠/点/横线）：那是 URL 或文件路径
          的一段，不是触发段，继续往回找；
       ③ 其余（前一个是中文、空白等）：这是用户新打的触发符，就地成段。

       ⚠ 不能像旧实现那样「token 以 @ 开头就无条件整段命中」。中文不按空格分词，
       回填出来的 "@general" 与紧接输入的正文会粘成同一个 token（"@general帮我查一下"），
       此后用户再打的 "@" 永远被这段旧 token 遮住 —— 表现正是「子代理只能触发一次」。
       必须回扫到【最后】一个触发符，规则 ③ 才接得住。
       反过来也不能只认规则 ③：`/设计稿` 这类按中文展示名筛选的输入，token 以 / 开头、
       内部再无触发符，只有规则 ① 能让它成立。 */
    for (var i = cursor - 1; i >= start; i--) {
        var c = val.charAt(i);
        if (c !== '/' && c !== '@') continue;
        if (i === start) return { start: start, end: cursor, trigger: c };
        if (/[A-Za-z0-9:/._-]/.test(val.charAt(i - 1))) continue;   // URL / 路径，不是触发段
        return { start: i, end: cursor, trigger: c };
    }
    return null;
}

function handleInputForCommands(e) {
    var inputEl = e.target;
    var completeEl = (inputEl === welcomeInput) ? $welcomeCmdComplete[0] : $chatCmdComplete[0];
    var token = findCmdTriggerToken(inputEl);
    if (token) {
        showCmdComplete(inputEl, completeEl, inputEl.value.substring(token.start, token.end));
    } else {
        hideCmdComplete();
    }
}

// 命令 & Agent 按钮处理器
function triggerCmdComplete(inputEl, completeEl, prefix) {
    // 保存当前光标位置
    var cursorPos = inputEl.selectionStart;
    var textBefore = inputEl.value.substring(0, cursorPos);
    var textAfter = inputEl.value.substring(cursorPos);

    /* 光标前已贴着同种触发符（连点两次按钮）时不重复插入，只开面板；
       否则「+ 菜单 → 技能」连点会堆出 "/ / " 这样的垃圾 token。 */
    if (textBefore.charAt(textBefore.length - 1) !== prefix) {
        // 在光标位置插入前缀（不补空格：补了空格 token 即被截断，面板会立刻收起）
        inputEl.value = textBefore + prefix + textAfter;
        var newCursorPos = cursorPos + prefix.length;
        inputEl.setSelectionRange(newCursorPos, newCursorPos);
    }

    inputEl.focus();
    showCmdComplete(inputEl, completeEl, prefix);
}
$('#welcomeSkillBtn').on('click', function() {
    triggerCmdComplete(welcomeInput, $welcomeCmdComplete[0], '/');
});
$('#chatSkillBtn').on('click', function() {
    triggerCmdComplete(chatInput, $chatCmdComplete[0], '/');
});
$('#welcomeAgentBtn').on('click', function() {
    triggerCmdComplete(welcomeInput, $welcomeCmdComplete[0], '@');
});
$('#chatAgentBtn').on('click', function() {
    triggerCmdComplete(chatInput, $chatCmdComplete[0], '@');
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
    // 命令补全导航
    var handled = navigateCmdComplete(e, chatInput, $chatCmdComplete[0]);
    if (handled) return;
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
    if (!$target.closest('.cmd-complete').length && !$target.closest('textarea').length && !$target.closest('#welcomeAgentBtn').length && !$target.closest('#chatAgentBtn').length && !$target.closest('#welcomeSkillBtn').length && !$target.closest('#chatSkillBtn').length) {
        hideCmdComplete();
    }
});

/* ===== Content History Rail —— 内容区右侧的会话导航刻度带 =====
   取代旧「输入框上方的历史消息浮层」。旧浮层把「导航」当成「输入辅助」来设计，
   于是既要输入区面积、又遮挡正文，还只能靠「+ 菜单 → 历史消息」唤起。

   现形态：内容区右缘一条竖轨，每条用户消息一根刻度，位置按【固定步距 + 整簇垂直
   居中】计算（见 computeRailTops：只依赖序号与轨道高，与正文长度无关，所以间距恒定）；
   当前阅读位置那根【加长、加深，但粗细不变】并随滚动实时跟随；悬停/聚焦浮出摘要卡片，
   点击平滑滚动到该消息并复用既有 .msg-highlight 闪烁。
   【本段曾被整体写错】旧文本说位置「按消息在滚动内容里的真实比例计算、间距天然不等、
   是整段对话的缩略地图」—— 那是 v1 模型，已被 v2（铺满等距）和 v3（固定步距）两次推翻。
   总述是模块的第一句，写错就等于给下一个读者发放一份错误地图，故单独修。

   【职责边界】本模块只做导航（跳转 + 当前位置指示），不承担「回填输入框」。
   旧浮层曾有回填能力（applyHistorySelection 把选中条目写进 chatInput.value），
   按用户 2026-10-31 的明确要求「旧弹框不要了」随浮层一并移除，**当前没有替代实现**：
   chatInput 的 keydown 只处理命令补全 / Tab / Enter，↑ 键在补全面板未开时不响应，
   全仓也不存在 recallHistoryDraft 之类的函数。若日后要恢复回填，需另立需求，
   不要以为它还在某处生效。 */

/* 刻度数量上限：超过即均匀采样。
   WHY 采样而不是封顶显示前 N 条：封顶会让「后半段对话」在轨道上完全没有刻度，
   导航直接失效。采样降级的是「覆盖全部消息」的精度，不降级「跳得中」的能力。
   【与固定步距的关系】间距恒为 min(HISTORY_RAIL_STEP_PX, 轨道高/(n-1))：
    条数少时取步距（16px，紧凑一簇），条数多时装不下才压缩到 轨道高/(n-1)。
    压缩分支下 60 根在 676px 轨道上间距约 11.45px，已贴近 12px 命中区上限，
   再往上就不是「变密」而是「点不准相邻刻度」，所以上限保持 60 ——
   超过 60 条用户消息的会话，轨道表示的是「按时间均匀抽样」，不是逐条。
   【上一版这里写的是「等距后单根占的纵向空间固定（轨道高/(N-1)）」】那是 v2 把等距
    等同于铺满时的公式；按它算 8 根会得到 96px，与实际的 16px 不符 —— 口径必须含 min()。 */
var HISTORY_RAIL_MAX_TICKS = 60;

/* 刻度的固定步距（像素）。
   【为什么是固定像素而不是铺满轨道】上一版把刻度按「0%~100%」铺满整条轨道，
   8 条消息时就变成 96px 一根 —— 截图上是散落的几个小横线，完全失去「这是一排刻度」的整体感。
   参照稿里它们是紧凑的一小簇：间距恒定、整簇垂直居中、只占轨道中段一段。
    【为什么是 16】2026-11-04 用户对照参照稿指出「刻度的间距太长了」：
    32px 时 8 条消息拉成 224px 的一长串，散得像几根孤零零的小横线。
    参照稿里是紧凑一小簇（相邻中心距约 16~18px），8 条只占约 112px。
    取 16 且保留 min() 压缩分支：条数多时装不下会自动收窄到 trackH/(n-1)。 */
var HISTORY_RAIL_STEP_PX = 16;

/* 浮层列表每行文本的截断长度。
   卡片宽约 340px、字号 12.5px，单行视觉容量约 24 个汉字；取 48 字是为了
   「即使被省略号截掉，也还能认出是哪一条」，同时保证长短差异明显的消息
   在右对齐时不会因为省略号位置太靠右而看起来像空行。 */
var HISTORY_RAIL_TIP_TEXT_MAX = 48;

/* 浮层延迟隐藏的时间窗（毫秒）。
   刻度右缘与卡片左缘之间有 2px 间隙，鼠标从刻度移向卡片必然跨过它；
   不延迟的话指针一离开刻度卡片就隐藏，随后进入的是空白 → 又回到刻度 →
   显示/隐藏高频抖动。160ms 足够跨过 2px，又短到不产生「卡住了」的迟滞感。 */
var HISTORY_RAIL_TIP_HIDE_DELAY = 160;

var $historyRail = $('#chatHistoryRail');
var $historyRailTrack = $('#chatHistoryRailTrack');
var $historyRailTip = $('#chatHistoryRailTip');

/** 浮层隐藏的定时器句柄（hover-intent）。null 表示当前没有待执行的隐藏。 */
var historyRailTipHideTimer = null;
/** 浮层列表里当前高亮的行下标（对应采样下标，-1 = 无高亮）。
 *  与 historyRailActiveIdx 的区别：后者是「当前阅读位置」，前者是「鼠标/焦点指向哪一行」
 *  好让用户从刻度进入列表时，列表马上就指出「你指的那根对应哪一条」。 */
var historyRailTipIdx = -1;
/** 列表里被标了 is-current 的那一行（当前阅读位置）的 msgIdx，-1 = 无。
 *  markRailTipCurrent 靠它早退 —— 滚动时它每帧都会被调，全量改类没有意义。 */
var historyRailTipCurrentIdx = -1;

/** 每次重建的世代号：滚动监听里丢弃过期回调，避免「上一轮的刻度」被当成当前刻度。 */
var historyRailBuildSeq = 0;
/** 当前活动刻度对应的用户消息序号（data-user-msg-idx），-1 表示尚未定位。 */
var historyRailActiveIdx = -1;
/** 上一次渲染的消息签名：只在「消息集合真的变了」时重建 DOM，
 *  否则滚动时的 active 更新会被整段重建吞掉（表现为刻度一直闪、悬停浮层一跳就灭）。 */
var historyRailSignature = '';

/** 取当前活动会话的用户消息列表（按 DOM 顺序，即时间正序）。
 *  与旧 extractUserMessages 的区别：旧的是给「回填输入框」用的倒序去重列表，
 *  导航需要的是【完整、有序、可定位】的集合，重复文本也各占一根刻度。 */
function collectRailMessages() {
    var sess = activeSessionId ? sessionMap[activeSessionId] : null;
    if (!sess) return [];
    var $rows = $(sess.container).find('.msg-row.user');
    var items = [];
    for (var i = 0; i < $rows.length; i++) {
        var $row = $($rows[i]);
        var msgIdx = parseInt($row.attr('data-user-msg-idx'), 10);
        if (isNaN(msgIdx)) continue;
        // 正文优先取原始 Markdown（data-md-raw）：渲染后的 DOM 里代码块/表格会被展开成
        // 大段结构，text() 读出来是「一堆等宽字符」，做摘要可读性很差。
        var $textEl = $row.find('.user-msg-text');
        var raw = $textEl.length ? ($textEl.attr('data-md-raw') || '') : '';
        var text = (raw || ($textEl.length ? $textEl.text() : '')).trim();
        if (!text) {
            // 纯附件消息没有正文：给一句可辨认的占位，否则浮层是空白卡片
            var attachCount = $row.find('.user-attach-imgs img, .user-attach-file').length;
            if (!attachCount) continue;
            text = GourdI18n.t('history.rail_attachment_only');
        }
        items.push({ msgIdx: msgIdx, row: $rows[i], text: text });
    }
    return items;
}

/** 折叠换行：摘要卡片是单行 nowrap，多行原文会带出突兀的大段空白。 */
function railFlatText(text) {
    return String(text).replace(/\s*\r?\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** 按码点安全截断（`😀` 是代理对，substring 切在中间会留下孤立高位代理 → 渲染成 \uFFFD）。 */
function railTruncateByCodePoint(text, max) {
    var chars = Array.from(text);
    if (chars.length <= max) return text;
    return chars.slice(0, max).join('') + '…';
}

/** 均匀采样：把 n 条压到 limit 条，且必须保留【首条与末条】——
 *  它们是「对话起点」和「最新进展」两个最有导航价值的位置。 */
function railSampleIndices(count, limit) {
    var out = [];
    if (count <= 0) return out;
    if (count <= limit) {
        for (var i = 0; i < count; i++) out.push(i);
        return out;
    }
    for (var k = 0; k < limit; k++) {
        out.push(Math.round(k * (count - 1) / (limit - 1)));
    }
    // Math.round 可能产生重复下标（两端挤在一起时），去重后再交给调用方
    var seen = {};
    var dedup = [];
    for (var j = 0; j < out.length; j++) {
        if (seen[out[j]]) continue;
        seen[out[j]] = true;
        dedup.push(out[j]);
    }
    return dedup;
}

/** 计算每根刻度的纵向位置（像素，相对轨道顶边 = 刻度中心所在 y）。
 *
 *  【模型演进·两次都是用户明确要求】v1「缩略地图」按消息在全文的真实比例摆位；
 *  v2 改为等距，但等距是**铺满轨道**的（0%~100%），8 条消息就拉开成 96px 一根；
 *  v3（当前）用户拿着参照稿指出「你间隔这么大干嘛，按照后面的间隔就行了」——
 *  参照稿里是一排紧凑短横。于是位置改为「固定步距 + 整簇居中」：
 *    step  = min(HISTORY_RAIL_STEP_PX, trackH / (n - 1))   ← 装不下时才压缩
 *    first = (trackH - step * (n - 1)) / 2                  ← 整簇垂直居中
 *
 *  三种模型的共性：都【只依赖序号与轨道高】，绝不读 scrollHeight / 消息真实高度。
 *  一旦依赖内容高度，图片加载、代码高亮完成引起的分部重排就会让刻度抖动。
 *
 *  【返回值是 px 而不是百分比】百分比只能表达「铺满」，无法表达「固定步距」；
 *  居中偏移也没法用受限的 0~100 区间表达（簇比轨道矮时首根不会是 0%）。
 *  刻度用 translateY(-50%) 自居中对齐，所以这里给的正是「刻度中心」的 y。 */
function computeRailTops(trackH, count) {
    var n = count || 0;
    if (!(trackH > 0) || n <= 0) return [];
    /* 单根放在轨道正中：放在顶边会因为 translateY(-50%) 一半溢出轨道。 */
    if (n === 1) return [trackH / 2];
    var step = Math.min(HISTORY_RAIL_STEP_PX, trackH / (n - 1));
    var first = (trackH - step * (n - 1)) / 2;
    var out = [];
    for (var i = 0; i < n; i++) out.push(first + step * i);
    return out;
}

/** 当前阅读位置对应的消息：**视口顶沿已越过的那条**（与等距刻度同一坐标系）。
 *
 *  【为什么必须用「视口顶沿」而不是「视口中线】——这是本轮 codereview 的核心结论。
 *  上一版用 anchor = scrollTop + clientHeight/2（视口中线）判断「正在读哪条」，
 *  在刻度按内容真实比例摆位时是合理的；但刻度改成等距后，两套坐标系不再同源：
 *  刻度的位置回答「第几条」，而中线锚点回答「内容滚到哪」，两者对不上。
 *  实测（6 条消息，真实浏览器）点击第 0~4 根刻度后 active 全部落到【末根】：
 *  因为点击 scrollIntoView(block:'start') 后 scrollTop = 该消息顶边，
 *  而 midline = 顶边 + 350px 早已越过后面好几条消息。
 *  点第 3 根却高亮第 6 根 —— 导航直接失效，属于必修缺陷。
 *
 *  【现在的判据】断点 = 各消息顶边在内容坐标系里的位置 o_i；
 *  scrollTop 越过 o_i 即认为「第 i 条成为当前」，取越过的最后一条。
 *  这天然满足【点击自洽】：点第 i 根 → scrollTop = o_i → 恰好越过 o_i、未越过 o_{i+1} → active = i。
 *  也符合文档目录的通例（标题滚过顶沿即高亮该节），且单调无抖动。
 *
 *  【末条断点必须钳位】末条消息的顶边可能【超出】可滚动上限（会话最后一条答案是短回答时，
 *  它根本滚不到顶沿）。不钳位的话这个断点永远不可达，滚到底 active 停在倒数第二条 ——
 *  正是上一版注释里记录过的老缺陷。故 b_last = min(o_last, scrollHeight - clientHeight)。
 *
 *  【两端显式钳位】不是特例凑数：
 *    · scrollTop <= 0：位于顶部时首条必然是当前（此时 o_0 可能因上方有欢迎区而 > 0）；
 *    · denom - scrollTop <= 1：滚到底必然是末条，1px 容差吸收亚像素 scrollTop。
 *
 *  【容差】scrollHeight <= clientHeight（内容装得下）时无滚动可言，直接取首条。 */
function resolveRailActiveIdx(items) {
    if (!items.length) return -1;
    var scrollH = messagesWrap.scrollHeight || 0;
    if (scrollH <= 0) return items[0].msgIdx;

    /* 【判定必须全程待在内容像素坐标系里，不能归一化后再比】
       旧写法把两个不同尺度的量相减：
         p = scrollTop / (scrollHeight - clientHeight)   分母是「可滚动距离」
         q = offset / scrollHeight                       分母是「内容总高」
       两者只在两端（0 和 1）恰好相等，中间段系统性失真 —— 两端正确正是它没被契约
       测试发现的原因（旧测试只断言两端）。
       同理，也不得把中线锚点（scrollTop + clientH/2）与像素断点混用，两者不同源。
       全程用像素：断点 = 消息顶边相对内容原点的位置，判据 = scrollTop 越过断点。 */
    var clientH = messagesWrap.clientHeight || 0;
    var scrollTop = messagesWrap.scrollTop || 0;
    var denom = scrollH - clientH;
    /* 内容装得下（没有滚动条）时，所有消息都在屏幕上，讨论「读到哪」没有意义 —— 直接取首条。 */
    if (denom <= 0) return items[0].msgIdx;
    /* 端点钳位：留 1px 容差吸收亚像素滚动（scrollTop 常是小数，直接比 denom 会差一点点）。 */
    if (scrollTop <= 0) return items[0].msgIdx;
    if (denom - scrollTop <= 1) return items[items.length - 1].msgIdx;

    var wrapTop = messagesWrap.getBoundingClientRect().top;
    var lastIdx = items.length - 1;
    var best = items[0].msgIdx;
    for (var i = 0; i < items.length; i++) {
        var offset = items[i].row.getBoundingClientRect().top - wrapTop + scrollTop;
        /* 末条断点钳到可滚动上限：顶边超出上限时它永不可达，会导致「跳不到最新」。 */
        var breakpoint = (i === lastIdx) ? Math.min(offset, denom) : offset;
        /* 0.5px 容差：smooth 滚动停下时 scrollTop 可能有小数，严格 <= 会漏掉刚点的那根。 */
        if (breakpoint <= scrollTop + 0.5) {
            best = items[i].msgIdx;
        } else {
            break; // items 按 DOM 顺序即时间正序，offset 单调递增，越过后不必再扫
        }
    }
    return best;
}

/** 点击锚定是否已经「到达过」它对应的那一行。
 *
 *  【为什么需要这个位】我第一版想用「目标行还在视口内」当作锚定的失效条件，
 *  但它会把另一条已写进设计目标的行为弄坏：平滑滚动【途中】目标行还没进视口，
 *  锚定就被判为失效 → 高亮先跳到「半路」那一条、到达后再跳回来 ——
 *  而「不会先跳到别处再回来」正是加锚定的理由。
 *  所以分成两段：未到达前一律保持锚定（滚动在路上）；
 *  到达过一次之后，目标行离开视口 = 用户已在看别处 → 交还几何判据。
 *  每次新点击重置该位（见 locateUserMessage）。 */
var historyRailPinArrived = false;

/** 「当前该高亮哪一根」的唯一口径入口。
 *
 *  【为什么必须有】本轮 codereview 实测出的真实缺陷：paintRailActive 有四个调用点，
 *  其中三处都先读 historyRailPinnedIdx（点击锚定优先），唯独 relayoutHistoryRailTicks
 *  直接调 resolveRailActiveIdx —— 于是「内容异步撑高 → ResizeObserver → relayout」
 *  会把用户刚点的那一根冲掉：实测 afterClick=3 → afterRelayout=0。
 *  同族判断散落在四处、靠人肉同步，正是口径漂移的温床；收敛成一个函数后，
 *  「加了第五个调用点却忘了读锚定」变成可被机械护栏抓住的事（见契约测试）。
 *
 *  【顺带补的洞】锚定原先只由 wheel/touchmove/键盘释放，而【拖原生滚动条】与
 *  【程序化滚动】（新消息自动滚到底等）两者都不发 wheel ——
 *  实测直接改 scrollTop 后 pinned 与 active 都还钉在 3，用户明明已在看别处。
 *  「到达过 + 已离开视口」是与事件类型无关的判据，能兜住这两类。 */
function railPinStillRelevant(items) {
    if (historyRailPinnedIdx < 0) return false;
    var rec = null;
    for (var i = 0; i < items.length; i++) {
        if (items[i].msgIdx === historyRailPinnedIdx) { rec = items[i]; break; }
    }
    if (!rec) return false;            // 消息集合已不含它（切会话/整批替换）→ 锚定作废
    var wr = messagesWrap.getBoundingClientRect();
    var r = rec.row.getBoundingClientRect();
    var inView = r.bottom > wr.top && r.top < wr.bottom;
    if (inView) historyRailPinArrived = true;
    return inView || !historyRailPinArrived;
}

function railActiveIdxFor(items) {
    if (historyRailPinnedIdx >= 0) {
        if (railPinStillRelevant(items)) return historyRailPinnedIdx;
        historyRailPinnedIdx = -1;   // 用户已滚离那条，锚定作废，交还几何判据
    }
    return resolveRailActiveIdx(items);
}

/** 只更新 active 态与浮层跟随，不重建 DOM。
 *  滚动事件里每帧都可能走到这里，必须足够轻。 */
function paintRailActive(items, msgIdx) {
    if (msgIdx === historyRailActiveIdx) return;
    var prev = historyRailActiveIdx;
    historyRailActiveIdx = msgIdx;
    var $ticks = $historyRailTrack.find('.history-rail-tick');
    /* 【增量而不是全量 toggle】旧写法遍历所有刻度 toggleClass：60 根时每次换位
       都要让 60 个元素失效，而滚动本身已经在改布局，叠一层全量失效就是可感知的顿。
       现在只动「旧的那一根」和「新的那一根」，其余元素不受影响。
       重建后的首次绘制（prev === -1）仍需扫一遍清残留，但那只发生在重建时。 */
    if (prev === -1) {
        $ticks.filter('.is-active').removeClass('is-active').removeAttr('aria-current');
    } else if (prev !== msgIdx) {
        $ticks.filter('[data-msg-idx="' + prev + '"]').removeClass('is-active').removeAttr('aria-current');
    }
    if (msgIdx >= 0) {
        $ticks.filter('[data-msg-idx="' + msgIdx + '"]').addClass('is-active').attr('aria-current', 'true');
    }
    /* 列表开着时同步「当前阅读位置」标记：滚动时卡片里那行要跟着走，
       否则用户一边滚正文、一边看卡片，卡片里的高亮会停在打开时的位置。 */
    if ($historyRailTip.hasClass('is-shown')) markRailTipCurrent(msgIdx);
}

/** 计算命中区高度：必须【小于实际步距】否则相邻命中区重叠，
 *  重叠带的点击归属由 DOM 顺序决定 —— 用户点上一根可能跳到下一根
 *  （实测 N=60、轨道高 676px 时间距 11.45px < 固定 12px，重叠 0.55px）。
 *  【步距口径必须与 computeRailTops 完全一致】固定步距后间距不再是 trackH/(n-1)：
 *  8 条时真实间距是 16px，用旧公式会算成 96px 再被上限 12px 截住 ——
 *  虽然结果同样是 12px，但 N 介于两者之间时（如 40 条）会算出 9.4px，
 *  而真实间距是 16px，命中区被无谓地压窄。所以这里复用同一个 min() 口径。
 *  取「间距 -1px」作为安全边距，上限 12px（少量刻度时的舒适命中区），
 *  下限 4px（再小就点不中，宁可重叠也不能完全不可点）。
 *  返回 null 表示「算不出来」（轨道未布局）—— 调用方保留 12px 默认值。 */
function computeRailTickHitHeight(trackH, count) {
    if (!(trackH > 0) || !(count > 1)) return null;
    var gap = Math.min(HISTORY_RAIL_STEP_PX, trackH / (count - 1));
    return Math.max(4, Math.min(12, gap - 1));
}

/** 把命中区高度写到轨道上的 CSS 变量（刻度通过 var(--tick-hit) 继承）。
 *  写在 track 而不是每个刻度上：一次 DOM 写入而不是 N 次，且新建刻度自动继承。 */
function applyRailTickHitHeight(count) {
    if (!$historyRailTrack.length) return;
    var trackH = $historyRailTrack[0].clientHeight || 0;
    var h = computeRailTickHitHeight(trackH, count);
    if (h == null) return;
    /* 保留 2 位小数：亚像素并不影响命中判定，但避免无意义的重新样式计算 */
    $historyRailTrack[0].style.setProperty('--tick-hit', h.toFixed(2) + 'px');
}

/** 点击定位的显式锚定：>= 0 时滚动跟随不再用几何推导，而是直接沿用该 msgIdx。
 *
 *  【为什么必须有】「最后一条已越过顶沿的消息」这个几何判据有两类它推不出来的场景：
 *   ① 消息挤在底部：第 0 条很高（2000px）而其后几条各 100px 时，后几条的顶边
 *      （2000/2100/...）全部【超过】可滚动上限（如 1800），滚到底也无法把它们贴到顶沿。
 *      此时几何上无法区分它们（点 1~5 都会得到同一个 scrollTop），高亮会全部落到末条；
 *   ② 点击快捷：平滑滚动未结束时 scrollTop 还在路上，中途重算会得到“半路”的结果。
 *  这两类下唯一正确的答案就是用户刚刚点的那一根 —— 用户已经用鼠标告诉我们了。
 *
 *  【清空时机】不靠定时器猜「滚动什么时候结束」，而是用户一旦【手动滚动】
 *  （wheel / touchstart / 键盘）就交还给几何判据。定时器会在慢速设备上过早/过晚失效；
 *  而「手动滚动」是确定的用户意图切换点。 */
var historyRailPinnedIdx = -1;

/** 手动滚动/键盘接管时清掉锚定（点击定位→继续手动浏览）。 */
function releaseRailPin() {
    historyRailPinnedIdx = -1;
    historyRailPinArrived = false;
}

/** 实测滚动条宽度并写到 .messages-shell 的 --scrollbar-w，供 .history-rail 的
 *  right 让位使用。2026-11-04「滚动条和刻度位置反了」修复的一环：刻度带改为
 *  叠在滚动区右缘内侧，必须用真实滚动条宽度（Windows ~15px / macOS overlay 0px）
 *  把刻度让到滚动条左边；写死 15px 会在 overlay 滚动条平台压住正文右缘。
 *  offsetWidth - clientWidth 含 border，这里 wrap 无边框，差值即滚动条宽。
 *  只在值变化时写，避免无谓的样式失效。
 *  【2026-11-04 review 加固】宿主必须与 historyOverlayHost() 同源：优先按 id 取
 *  #messagesShell，再退回 parentNode。旧版只写 wrap.parentNode，若 DOM 中插入了
 *  中间 wrapper（或测试桩无 parentNode），变量会静默写到错误元素 / 干脆不写，
 *  而 rail 读的是 shell 自身声明的 0px —— 表现就是「刻度压住滚动条且不报错」。 */
function syncRailScrollbarWidth() {
    var wrap = typeof messagesWrap !== 'undefined' && messagesWrap ? messagesWrap : null;
    if (!wrap) return;
    var shell = typeof document !== 'undefined' && document.getElementById
        ? document.getElementById('messagesShell')
        : null;
    if (!shell) shell = wrap.parentNode || (wrap.parent && wrap.parent[0]) || null;
    if (!shell || !shell.style) return;
    var w = Math.max(0, wrap.offsetWidth - wrap.clientWidth);
    var px = w + 'px';
    if (shell.style.getPropertyValue('--scrollbar-w') !== px) {
        shell.style.setProperty('--scrollbar-w', px);
    }
}

/** 重建轨道。items 为空则整条轨道隐藏。 */
function renderHistoryRail(force) {
    if (!$historyRail.length) return;
    /* 位置修正：轨道是 absolute 覆盖层，右让位量必须跟着滚动条宽度走。
       每次重建（含窗口 resize）都刷一次，overlay 滚动条启停时也能对齐。 */
    syncRailScrollbarWidth();
    var sess = activeSessionId ? sessionMap[activeSessionId] : null;
    var items = collectRailMessages();

    /* 签名的组成：会话 id + 消息序号序列 + 各自文本长度。
       为什么不含文本内容：重建只需要知道「集合变没变」，正文编辑会连带改长度，仍能触发；
       而把全文拼进签名会让每次滚动都做一次 O(总字数) 的字符串拼接。 */
    var sigParts = [activeSessionId || '', items.length];
    for (var i = 0; i < items.length; i++) sigParts.push(items[i].msgIdx + ':' + items[i].text.length);
    var signature = sigParts.join('|');

    // 采样式渲染：先决定「哪些条上轨」，再按固定步距落到像素位置
    var sampleIdx = railSampleIndices(items.length, HISTORY_RAIL_MAX_TICKS);
    var sampled = sampleIdx.map(function (k) { return items[k]; });

    var visible = !!sess && sampled.length > 0;
    var wasVisible = $historyRail.hasClass('is-visible');

    if (!visible) {
        // 清空并收起：保留最后签名，避免下次同样的空集合反复走重建分支
        historyRailSignature = '';
        $historyRail.removeClass('is-visible');
        $historyRailTrack.empty();
        historyRailTipSig = '';
        /* 锚定必须跟着清：msgIdx 是会话内序号，切到新会话后旧值可能恰好命中别的消息 */
        historyRailPinnedIdx = -1;
        historyRailPinArrived = false;
        hideHistoryRailTip();
        return;
    }

    /* 【时序反转·像素定位后的新约束】必须先让轨道可见再读 clientHeight：
       display:none 时它恒为 0，算出来的 tops 全是 0，所有刻度会叠在顶边。
       旧实现用百分比时不受这条约束（百分比与容器高度无关），所以时序可以随意；
       改成像素定位后，这一行是正确性的前提，不是优化。 */
    if (!wasVisible) $historyRail.addClass('is-visible');
    var railTrackH = $historyRailTrack.length ? ($historyRailTrack[0].clientHeight || 0) : 0;
    var tops = computeRailTops(railTrackH, sampled.length);

    var changed = force || signature !== historyRailSignature;
    if (changed) {
        historyRailSignature = signature;
        var html = '';
        for (var j = 0; j < sampled.length; j++) {
            var it = sampled[j];
            var topPx = tops[j] || 0;
            // 入轨交错只作用于本轮新增：分辨「本次重建有没有多出来」靠比较 data-msg-idx 集合，
            // 但为控制复杂度（刻度最多 60 个）此处统一标记——轨道只在首次出现/消息集合变化时
            // 才重建，重建本身就是用户可感知的「新内容到达」，集体入轨是合理的动效语义。
            /* aria-label 必须能区分不同刻度：6 根全叫「定位到该消息」时，
               屏幕阅读器用户听到的是 6 个完全相同的按钮，无法知道哪根对应哪条。
               取序号 + 摘要前 20 字作为标题（序号用「第 N 条」形式，不依赖 i18n 插值）。 */
            var a11ySummary = railTruncateByCodePoint(railFlatText(it.text), 20);
            html += '<button type="button" class="history-rail-tick is-new"'
                + ' data-msg-idx="' + it.msgIdx + '"'
                + ' data-rail-top="' + topPx.toFixed(2) + '"'
                + ' data-tip="' + escAttr(railTruncateByCodePoint(railFlatText(it.text), HISTORY_RAIL_TIP_TEXT_MAX)) + '"'
                + ' style="top:' + topPx.toFixed(2) + 'px;--i:' + Math.min(j, 10) + '"'
                + ' aria-label="' + escAttr(GourdI18n.t('history.locate_message') + ' ' + (j + 1) + '/' + sampled.length + ': ' + a11ySummary) + '">'
                + '<span class="history-rail-tick-line" aria-hidden="true"></span>'
                + '</button>';
        }
        $historyRailTrack.html(html);
        /* 刻度集合变了 → 列表行也得重建（否则卡片还停在旧消息上）。
           直接清签名并隐藏，下次 hover 时 renderRailTipList 会自动重建。 */
        historyRailTipSig = '';
        hideHistoryRailTip();

        /* is-new 在动画结束后移除：它同时驱动 animation-delay 与入场关键帧，
           留着会让后续任何重排（例如窗口 resize 后的重新定位）重播动画。 */
        var $newTicks = $historyRailTrack.find('.history-rail-tick.is-new');
        setTimeout(function() { $newTicks.removeClass('is-new'); }, 600);
    } else {
        /* 未变化时只同步位置：轨道高变了（窗口 resize）时整簇的居中偏移也要跟着变。 */
        var $ticks = $historyRailTrack.find('.history-rail-tick');
        for (var t = 0; t < $ticks.length && t < tops.length; t++) {
            var $tk = $ticks.eq(t);
            var p = tops[t];
            if (typeof p === 'number' && isFinite(p)) {
                $tk.attr('data-rail-top', p.toFixed(2)).css('top', p.toFixed(2) + 'px');
            }
        }
    }

    /* 轨道此刻一定已可见（见上方时序说明），命中区高度可以直接测。 */
    applyRailTickHitHeight(sampled.length);
    historyRailActiveIdx = -1;
    /* 锚定有效性（消息集合已不含它时作废）已收敛进 railActiveIdxFor；
       这里再写一遍就是第五处口径，下一轮改动必然漏改。 */
    paintRailActive(sampled, railActiveIdxFor(sampled));
}

/** 浮层列表的行签名：仅在「上轨的消息集合变了」时重建行 DOM。
 *  点同一根刻度、在相邻刻度间来回移动时列表内容完全一样，只需要移动高亮 ——
 *  重建会让行入场动画重播，看起来像整张卡在闪。 */
var historyRailTipSig = '';

/** 取消待执行的隐藏（指针回到了刻度或进入卡片）。 */
function cancelRailTipHide() {
    if (historyRailTipHideTimer) {
        clearTimeout(historyRailTipHideTimer);
        historyRailTipHideTimer = null;
    }
}

/** 延迟隐藏：指针离开刻度/卡片后不立刻关。
 *  刻度右缘与卡片左缘之间隔着 2px（right:28px vs 轨道宽 26px），
 *  鼠标从刻度移向卡片必然跨过它 —— 不延迟的话指针一离开刻度卡片就隐藏，
 *  随后进入的是空白，于是「显示→消失→显示」高频抖动。 */
function scheduleRailTipHide() {
    cancelRailTipHide();
    historyRailTipHideTimer = setTimeout(function() {
        historyRailTipHideTimer = null;
        $historyRailTip.removeClass('is-shown');
    }, HISTORY_RAIL_TIP_HIDE_DELAY);
}

/** 立即关闭（切换会话 / 跳转 / 轨道重建这些「确定要关」的场景）。 */
function hideHistoryRailTip() {
    cancelRailTipHide();
    if ($historyRailTip.length) $historyRailTip.removeClass('is-shown');
}

/** 构建/更新浮层列表：每行 = 一条历史消息 + 行尾同款刻度。
 *  数据源是轨道上已有的刻度（DOM 顺序 = 消息时间正序），不重新遍历消息 DOM ——
 *  两处各自收集会出现「卡片第 3 行 ≠ 轨道第 3 根」这种漂移。 */
function renderRailTipList() {
    var $ticks = $historyRailTrack.find('.history-rail-tick');
    if (!$ticks.length) return;

    var sigParts = [];
    for (var i = 0; i < $ticks.length; i++) {
        sigParts.push($ticks.eq(i).attr('data-msg-idx') + ':' + ($ticks.eq(i).attr('data-tip') || ''));
    }
    var sig = sigParts.join('|');
    if (sig === historyRailTipSig && $historyRailTip.find('.history-rail-tip-row').length) return;
    historyRailTipSig = sig;

    var html = '<div class="history-rail-tip-list">';
    for (var j = 0; j < $ticks.length; j++) {
        var $t = $ticks.eq(j);
        var text = $t.attr('data-tip') || '';
        html += '<button type="button" class="history-rail-tip-row"'
            + ' data-msg-idx="' + escAttr($t.attr('data-msg-idx')) + '"'
            + ' aria-label="' + escAttr(text) + '">'
            + '<span class="history-rail-tip-text">' + escapeHtml(text) + '</span>'
            + '<span class="history-rail-tip-tick" aria-hidden="true"></span>'
            + '</button>';
    }
    html += '</div>';
    $historyRailTip.html(html);
    historyRailTipIdx = -1;
    historyRailTipCurrentIdx = -1;
    /* 新建的行全部是新的 DOM，缓存必须重建；这里读一次几何（会触发一次必要布局），
       之后所有跨行切换都吃缓存，不再有「写样式后立刻读布局」的强制重排。 */
    measureRailTipRowGeo();
}

/** 行几何缓存（相对 .history-rail-tip-list 的 offsetTop/offsetHeight）。
 *
 *  【为什么必须缓存】原实现每次跨行都读 $target[0].offsetHeight / offsetTop，
 *  而它上一行刚做过 removeClass/addClass（写样式）——「写 → 同步读布局」会让浏览器
 *  强制重排整张卡片。真实浏览器实测：鼠标扫过 8 行共触发 70 次 LayoutCount
 *  （8.75 次/跨行），这就是用户报的「光标移动有点卡顿」。
 *  【为什么可以缓存】offsetTop/offsetHeight 相对 offsetParent（.history-rail-tip-list），
 *  与列表自身的 scrollTop 无关，行高又恒定（同样 padding + 单行 nowrap 文本），
 *  所以一次测量在整个列表生命周期内都成立。 */
var historyRailTipRowGeo = null;

/** 测量列表里每一行的几何。只在列表重建后调用一次。 */
function measureRailTipRowGeo() {
    var list = $historyRailTip.find('.history-rail-tip-list')[0];
    if (!list) { historyRailTipRowGeo = null; return; }
    var $rows = $historyRailTip.find('.history-rail-tip-row');
    var rows = new Array($rows.length);
    var maxH = 0;
    for (var i = 0; i < $rows.length; i++) {
        var el = $rows[i];
        var h = el.offsetHeight;
        rows[i] = {
            idx: parseInt(el.getAttribute('data-msg-idx'), 10),
            top: el.offsetTop,
            h: h
        };
        if (h > maxH) maxH = h;
    }
    historyRailTipRowGeo = { rows: rows, listH: list.clientHeight, maxH: maxH };
}

/** 把列表里的某一行滚进可视区（只滚列表自己，不连带滚动页面/正文）。
 *  视口高度用 measureRailTipRowGeo 记下的 listH：这里若现读 clientHeight，
 *  它【可能】是强制同步布局 —— 本函数刚写过 .is-cursor / top，样式可能已失效。
 *
 *  【本轮自审纠正的论断】原来这里写着「scrollTop 是滚动偏移而非布局值，读它不触发重排」，
 *  这句是错的：scrollTop/scrollLeft 和 scrollHeight 一样在「What forces layout」清单上。
 *  A/B 对照实测（同一段代码只把那次读换成缓存值，140 次调用）：
 *    LayoutCount 两组都 0（本例前置写只改 color/transform，不脏化布局），
 *    RecalcStyleCount 真读 141 vs 缓存 71 —— 确实强制了样式重算，
 *    但实测成本约 14ns/次，不是用户可感知的卡顿源。
 *  代码保持读 scrollTop：列表可能被用户自己滚动，缓存它反而会算错该不该滚。
 *  教训：性能论断必须有 A/B 数据，不能靠「它不是布局值」这种推理写成事实。 */
function scrollRailTipRowIntoView(rec, geo) {
    var list = $historyRailTip.find('.history-rail-tip-list')[0];
    if (!list || !rec) return;
    var viewH = (geo && geo.listH) || list.clientHeight || 0;
    var st = list.scrollTop;
    if (rec.top < st) list.scrollTop = rec.top;
    else if (rec.top + rec.h > st + viewH) list.scrollTop = rec.top + rec.h - viewH;
}

/** 移动列表里的选中行：行文本变黑 + 行尾真实加宽刻度把文字往前挤。
 *  按参照稿没有滑动指示条、没有阴影背景；宽度带过渡（占布局，所以文字确实前移），
 *  颜色直接切换不做淡化 —— 参照稿的动感来自刻度推字，而不是两个高亮先后亮灭。 */
function setRailTipCursor(msgIdx) {
    if (isNaN(msgIdx)) return;
    var $rows = $historyRailTip.find('.history-rail-tip-row');
    if (!$rows.length) return;
    var $target = $rows.filter('[data-msg-idx="' + msgIdx + '"]');
    if (!$target.length) return;
    /* 【不能早退】曾经写 `if (historyRailTipIdx === msgIdx) return;`，看似是「已经选中就不动」
       的优化，实际是一个真实缺陷：卡片隐藏后不重置 historyRailTipIdx，
       于是「悬停第 3 根 → 移开 → 再回来悬停第 3 根」时函数第一步就 return，
       选中态再也不会补回来。故其余状态全部幂等重写。 */
    historyRailTipIdx = msgIdx;

    /* 【只清残留、不做全量 removeClass】旧写法 $rows.removeClass('is-cursor') 让 N 行
       全部失效，紧接着读 offsetTop 就是一次全量同步重排。改成只摘掉「原本选中但不是目标」
       的那一行（正常情况下就是 1 个），失效面从 N 降到 1。 */
    var $stale = $rows.filter('.is-cursor').not($target);
    if ($stale.length) $stale.removeClass('is-cursor');
    $target.addClass('is-cursor');

    /* 几何全部吃缓存：一次测量，整轮扫描零强制布局。 */
    if (!historyRailTipRowGeo) measureRailTipRowGeo();
    var geo = historyRailTipRowGeo;
    var rec = null;
    if (geo) {
        for (var i = 0; i < geo.rows.length; i++) {
            if (geo.rows[i].idx === msgIdx) { rec = geo.rows[i]; break; }
        }
    }
    /* 选中态由行自身的 .is-cursor 表达（文字变黑 + 行尾刻度变长），无滑动指示条：
       2026-11-04 按参照稿移除后，DOM 与相关写入已一并删掉，避免对 display:none
       元素做无意义的几何测量。这里只把目标行滚进列表可视区。 */
    scrollRailTipRowIntoView(rec, geo);
}

/** 将列表里位于【当前阅读位置】的那行标上 is-current（与鼠标选中区分）。
 *  用户从刻度进入列表时，第一眼就能看到「你指的那根」与「你正在读的那条"。 */
function markRailTipCurrent(msgIdx) {
    /* 滚动时每帧都会走到这里（paintRailActive → markRailTipCurrent）。
       全量 removeClass + filter addClass 会让 N 行反复失效；当前行没变时直接返回。 */
    if (msgIdx === historyRailTipCurrentIdx) return;
    var $rows = $historyRailTip.find('.history-rail-tip-row');
    if (!$rows.length) return;
    historyRailTipCurrentIdx = msgIdx;
    $rows.filter('.is-current').removeClass('is-current');
    $rows.filter('[data-msg-idx="' + msgIdx + '"]').addClass('is-current');
}

/** 计算浮层 top（相对包含块 padding box 的像素值）。
 *
 *  【为什么抽成纯函数】showHistoryRailTip 现在要先建列表、再定位，正体跑起来需要
 *  大半个 DOM + jQuery；真正的「坐标系对齐」算术只在这几行。抽出来后：
 *    · 可以传任意 padding / border / 高度组合直接验证，不用造假 DOM；
 *    · 变异验证能把「漏减 borderTop」「漏钳位」单独打死，不被其他逻辑干扰。
 *
 *  【坐标系的三个关键点】
 *  ① 绝对定位的 top 相对包含块的【padding box】，而 rect.top 是 border box 外缘 —— 故必须减 borderTop；
 *  ② padding 在盒内、不参与原点，所以绝不能把 padding 加进基准（我第一版就是这么错的，多算了 12px）；
 *  ③ 刻度自带 translateY(-50%)，但那是【视觉】变换；视觉中心恒等式 tickCenter === rect.top + rect.height/2
 *     与 transform 无关，故直接用 rect 算中心，不必建模 transform。
 */
function computeRailTipTop(tickRect, hostRect, hostBorderTop, hostH, tipH) {
    var top = tickRect.top + tickRect.height / 2 - hostRect.top - (hostBorderTop || 0);
    /* 卡片比旧版单行摘要高得多（最多 260px 列表），居中到刻度上会上下溢出：
       靠边时把中心往回收，保证整张卡落在轨道高度内。
       约束不成立（hostH 未知 / 卡比轨还高）时跳过钳位，而不是硬塑。 */
    if (hostH > 0 && tipH > 0 && tipH < hostH) {
        var half = tipH / 2;
        if (top - half < 0) top = half;
        else if (top + half > hostH) top = hostH - half;
    }
    return top;
}

/** 浮层显示：定位到所悬停/聚焦的刻度，列表高亮到该条。 */
function showHistoryRailTip($tick) {
    if (!$tick || !$tick.length || !$historyRailTip.length) return;
    var msgIdx = parseInt($tick.attr('data-msg-idx'), 10);
    if (isNaN(msgIdx)) return;

    cancelRailTipHide();
    renderRailTipList();
    markRailTipCurrent(historyRailActiveIdx);
    setRailTipCursor(msgIdx);

    /* 【定位必须用 getBoundingClientRect 相减，不能用 offsetTop】
       刻度的 offsetParent 是 .history-rail-track，而浮层的包含块是 .history-rail，
       两者不是同一个元素 —— rail 带 padding:12px 0，track 顶边比 rail 低 12px。
       旧写法 `top = offsetTop + offsetHeight/2` 把两个坐标系当同一个用，
       实测浮层恒定偏高 7.5px（= 多加的半个刻度高 4.5 − 漏掉的 padding 12）。
       算术细节与钳位规则全在 computeRailTipTop 里（独立纯函数，可直接测）。 */
    var tipEl = $historyRailTip[0];
    var host = tipEl.offsetParent || $historyRail[0];
    if (!host) return;
    var hostRect = host.getBoundingClientRect();
    var hostBorderTop = parseFloat(getComputedStyle(host).borderTopWidth) || 0;
    var tickRect = $tick[0].getBoundingClientRect();
    if (!tickRect.height && !tickRect.top) return; // 刻度不可见（轨道隐藏中），别把浮层钉到 0

    var top = computeRailTipTop(tickRect, hostRect, hostBorderTop,
        host.clientHeight || 0, tipEl.offsetHeight || 0);
    $historyRailTip.css('top', top + 'px');
    $historyRailTip.addClass('is-shown');
}

/** 定位到指定用户消息：平滑滚动 + 复用既有 .msg-highlight 闪烁。 */
function locateUserMessage(msgIdx) {
    if (isNaN(msgIdx) || msgIdx < 0) return;
    var sess = activeSessionId ? sessionMap[activeSessionId] : null;
    if (!sess) return;
    var $target = $(sess.container).find('.msg-row.user[data-user-msg-idx="' + msgIdx + '"]');
    if (!$target.length) return;

    hideHistoryRailTip();

    /* 【显式锚定】用户点的是哪一根，就是当前哪一根 —— 不靠几何推导。
       原因见 historyRailPinnedIdx 的注释：消息挤在底部时几何判据无法区分，
       且平滑滚动中途重算会得到“半路”的中间结果。先写锚定再滚，
       保证滚动过程中每一帧的高亮都是用户点的那一根，不会先跳到别处再回来。 */
    historyRailPinnedIdx = msgIdx;
    historyRailPinArrived = false;  // 新一轮滚动在路上：未到达前不得提前判失效
    historyRailActiveIdx = -1; // 强制 paintRailActive 生效（它见到相同值会早退）
    paintRailActive(collectSampledRailItems(), msgIdx);

    $target[0].scrollIntoView({ behavior: 'smooth', block: 'start' });

    /* 高亮沿用 .msg-highlight（app.css 已有 msg-locate-pulse 动画）。
       先移除再强制回流再加：连续点同一根刻度时，类名没变过浏览器不会重播动画。 */
    $target.removeClass('msg-highlight');
    void $target[0].offsetWidth;
    $target.addClass('msg-highlight');
    setTimeout(function() {
        $target.removeClass('msg-highlight');
    }, 1800);
}

/** 取当前上轨的消息集合（采样后）。滚动跟随、点击锚定、resize 校正三处共用，
 *  避免“三处各写一遍采样，口径漂移”。 */
function collectSampledRailItems() {
    var items = collectRailMessages();
    if (!items.length) return [];
    var sampleIdx = railSampleIndices(items.length, HISTORY_RAIL_MAX_TICKS);
    return sampleIdx.map(function (k) { return items[k]; });
}

/* ---- 事件接线 ---- */

// 轨道事件委托（刻度是动态重建的，不能逐个绑定）
$historyRailTrack.on('click', '.history-rail-tick', function(e) {
    e.preventDefault();
    locateUserMessage(parseInt($(this).attr('data-msg-idx'), 10));
});
$historyRailTrack.on('mouseenter', '.history-rail-tick', function() {
    showHistoryRailTip($(this));
});
$historyRailTrack.on('mouseleave', '.history-rail-tick', function() {
    scheduleRailTipHide();
});
// 键盘可达：焦点落在刻度上时也显示摘要（:hover 不会因聚焦触发）
$historyRailTrack.on('focusin', '.history-rail-tick', function() {
    showHistoryRailTip($(this));
});
$historyRailTrack.on('focusout', '.history-rail-tick', function() {
    scheduleRailTipHide();
});

/* 卡片本体：进入则取消隐藏（否则鼠标刚到卡片就灭了），离开则延迟隐藏。
   鼠标在【行之间】移动时靠 mouseover 委托刷新选中 —— 用 mouseover 而不是 mousemove：
   mousemove 每秒可触发几十次，而行间的选中切换只需要「跨行」这一下。 */
$historyRailTip.on('mouseenter', function() {
    cancelRailTipHide();
});
$historyRailTip.on('mouseleave', function() {
    scheduleRailTipHide();
});
$historyRailTip.on('mouseover', '.history-rail-tip-row', function() {
    setRailTipCursor(parseInt($(this).attr('data-msg-idx'), 10));
});
/* 点行 = 跳转（与点刻度同一语义，不另外做「回填输入框」）。
   用 click 而非 mousedown：键盘 Enter 在 button 上也会发 click，两种输入共用一条路径。
   焦点从刻度转到卡片时 focusout 会触发延迟隐藏（160ms），click 在此之前到达，
   所以不会出现「点上去时卡片已经被收掉」。 */
$historyRailTip.on('click', '.history-rail-tip-row', function(e) {
    e.preventDefault();
    locateUserMessage(parseInt($(this).attr('data-msg-idx'), 10));
});

/* 滚动跟随：用 rAF 合并，滚动事件本身每帧可触发多次。
   不直接重建 DOM（重建会打断 hover 与入场动画），只更新 active。 */
var historyRailScrollRaf = null;
$(messagesWrap).on('scroll', function() {
    if (!$historyRail.hasClass('is-visible')) return;
    if (historyRailScrollRaf != null) return;
    historyRailScrollRaf = requestAnimationFrame(function() {
        historyRailScrollRaf = null;
        var sampled = collectSampledRailItems();
        if (!sampled.length) return;
        /* 点击锚定优先：用户刚点的那根就是答案，几何推导在“消息挤在底部 / 平滑滚动中途”
           两类场景下会算出别的结果（详见 historyRailPinnedIdx）。
           锚定只由【手动滚动】释放，不由定时器释放。 */
        paintRailActive(sampled, railActiveIdxFor(sampled));
    });
});

/* 手动滚动 = 用户接管浏览位置，交还给几何判据。
   wheel/touchmove 是「用户亲自在滚」的确定信号；键盘 PageUp/PageDown/Home/End 同理。
   不用 scroll 事件本身判定：点击引起的 smooth 滚动也发 scroll，无法区分。 */
$(messagesWrap).on('wheel touchmove', function() {
    releaseRailPin();
});
$(messagesWrap).on('keydown', function(e) {
    /* PageUp/PageDown/Home/End/方向键：都是改变浏览位置的按键 */
    if (e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Home' || e.key === 'End'
            || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        releaseRailPin();
    }
});

/** 重算刻度位置（等距下位置不随内容高度漂移，此函数保留为「幂等校正」）。
 *
 *  【为什么等距后还需要它】看起来位置只依赖序号、不需要重算，但两个真实场景仍会要求校正：
 *  ① 采样数变化（消息数跳变时轨道根数变）；
 *  ② 容器高度变化后（窗口 resize 改了轨道高），固定步距下的居中偏移必须跟着变；
 *     此时 active 对应的滚动位置也跟着变，必须重新定位 active。
 *  保留 ResizeObserver 的另一个原因：正文异步撑高（图片/代码高亮/Mermaid）会让
 *  「当前读到哪里」的答案变化 —— 即使刻度不动，active 也得重算。 */
function relayoutHistoryRailTicks() {
    if (!$historyRail.hasClass('is-visible')) return;
    /* 【必须与 renderHistoryRail 同口径重测滚动条宽度】内容异步撑高（图片/代码高亮/
       Mermaid）会让 .messages-wrap 从「不溢出」变成「溢出」，原生滚动条从无到有；
       此路径不经过 renderHistoryRail，漏测就会让 --scrollbar-w 停留在 0px，
       刻度带随即压住新出现的滚动条。只在值变化时写入，不产生额外样式失效。 */
    syncRailScrollbarWidth();
    var $ticks = $historyRailTrack.find('.history-rail-tick');
    if (!$ticks.length) return;
    var items = collectRailMessages();
    if (!items.length) return;
    var sampleIdx = railSampleIndices(items.length, HISTORY_RAIL_MAX_TICKS);
    var sampled = sampleIdx.map(function (k) { return items[k]; });
    /* 轨道高变了 → 整簇的居中偏移与（装不下时的）压缩步距都要重算。 */
    var tops = computeRailTops($historyRailTrack[0].clientHeight || 0, sampled.length);
    for (var i = 0; i < $ticks.length && i < tops.length; i++) {
        var p = tops[i];
        if (typeof p !== 'number' || !isFinite(p)) continue;
        $ticks.eq(i).attr('data-rail-top', p.toFixed(2)).css('top', p.toFixed(2) + 'px');
    }
    /* 轨道高度随窗口/resize 变化 → 间距变 → 命中区高度必须跟着重算，
       否则缩小窗口后命中区又叠在一起。 */
    applyRailTickHitHeight(sampled.length);
    paintRailActive(sampled, railActiveIdxFor(sampled));
}

/* 窗口尺寸变化会改变轨道可用高度：装得下时是居中偏移变，装不下时是步距变，
   两者都要重算；命中区高度随间距变，一并刷新。 */
var historyRailResizeTimer = null;
$(window).on('resize', function() {
    if (historyRailResizeTimer) clearTimeout(historyRailResizeTimer);
    historyRailResizeTimer = setTimeout(function() {
        historyRailResizeTimer = null;
        renderHistoryRail(false);
    }, 140);
});

/* 内容高度监听：字体/图片/代码高亮/Mermaid 完成后行高变化，window.resize 不会触发。
   监听当前的 .messages-inner 容器（会话切换时重新绑定）。 */
var historyRailRO = null;
var historyRailROTarget = null;
function bindHistoryRailResizeObserver() {
    if (typeof ResizeObserver !== 'function') return;
    var sess = activeSessionId ? sessionMap[activeSessionId] : null;
    var target = sess ? sess.container : null;
    if (target === historyRailROTarget) return;
    if (historyRailRO) { historyRailRO.disconnect(); historyRailRO = null; }
    historyRailROTarget = target || null;
    if (!target) return;
    historyRailRO = new ResizeObserver(function() {
        // 内容高度变化可能连着来多次（图片逐张加载），rAF 合并
        if (historyRailResizeTimer) clearTimeout(historyRailResizeTimer);
        historyRailResizeTimer = setTimeout(function() {
            historyRailResizeTimer = null;
            try { relayoutHistoryRailTicks(); } catch (e) { /* 增强功能，不打断主流程 */ }
        }, 60);
    });
    try { historyRailRO.observe(target); } catch (e) { historyRailRO = null; }
}

/** 对外入口：会话切换 / 消息增删 / 回放结束后重建轨道。
 *  force=true 用于「同一会话但内容被整体替换」（回放、切回会话）。 */
function refreshHistoryRail(force) {
    try {
        renderHistoryRail(!!force);
        bindHistoryRailResizeObserver();
    } catch (err) {
        // 导航是增强功能：绝不能因为它抛错而中断消息渲染主流程
        console.error('[refreshHistoryRail]', err);
    }
}
window.refreshHistoryRail = refreshHistoryRail;

/* 首屏与切换会话时建一次（此处 activeSessionId 可能仍为空，渲染会得到隐藏态，
   真正的首次可见由 setActiveSession / 回放结束触发）。 */
refreshHistoryRail(true);

/* ===== Model Selector ===== */
var modelList = [];        // [{name, desc, standard, thinkingLevels}, ...] (shared, only loaded once)
var modelsLoaded = false;  // whether model list holds usable data（会话级模型刷新的门闸语义）
var modelsListStale = false; // reload 失败但保留了旧列表：下次成功响应时强制重解析列表
var healedByScope = Object.create(null); // scope → true：该 scope 已触发过镜像重推自愈（防环，二次空表不再重推）
var sessionModelMap = {};  // { sessionId: selectedModelName }
var sessionThinkingMap = {}; // { sessionId: thinkingDepth }  统一 5 档编码 / auto

// 上下文窗口是会话级选择，不再绑定在模型配置项上。
// 后端缺少上下文字段时始终回退到 256K，保证新旧接口的 UI 都稳定。
var DEFAULT_CONTEXT_LENGTH = 256000;
var CONTEXT_LENGTH_OPTIONS = [128000, 256000, 512000, 1000000];
var CONTEXT_OPTIONS = CONTEXT_LENGTH_OPTIONS;
var CONTEXT_LENGTH_LABELS = {
    128000: '128K',
    256000: '256K',
    512000: '512K',
    1000000: '1M'
};
var sessionContextMap = {}; // { sessionId: contextLength }
var contextOptions = CONTEXT_LENGTH_OPTIONS.slice(0);
var sessionModelRequestMap = {}; // 防止会话切换与 refreshSessionModel 并发重复请求

function hasSessionValue(map, sessionId) {
    return !!(sessionId && Object.prototype.hasOwnProperty.call(map, sessionId)
        && map[sessionId] != null);
}

// 接受后端常见的数字、"256K"、"1M" 表示，最终统一为 token 数。
function parseContextLengthValue(value) {
    if (typeof value === 'number' && isFinite(value)) return Math.round(value);
    var raw = String(value == null ? '' : value).trim().replace(/[, _]/g, '');
    if (!raw) return 0;
    var matchK = raw.match(/^(\d+(?:\.\d+)?)k$/i);
    var matchM = raw.match(/^(\d+(?:\.\d+)?)m$/i);
    if (matchK) return Math.round(parseFloat(matchK[1]) * 1000);
    if (matchM) return Math.round(parseFloat(matchM[1]) * 1000000);
    var parsed = Number(raw);
    return isFinite(parsed) ? Math.round(parsed) : 0;
}

// 后端可选下发可用项；未知项不进入聊天选择器，缺失/无有效项时回退固定四档。
function normalizeContextOptions(raw) {
    var source = (Object.prototype.toString.call(raw) === '[object Array]' && raw.length)
        ? raw : CONTEXT_LENGTH_OPTIONS;
    var result = [];
    var seen = {};
    for (var i = 0; i < source.length; i++) {
        var candidate = source[i];
        if (candidate && typeof candidate === 'object') {
            candidate = candidate.value != null ? candidate.value : candidate.contextLength;
        }
        var value = parseContextLengthValue(candidate);
        var allowed = false;
        for (var j = 0; j < CONTEXT_LENGTH_OPTIONS.length; j++) {
            if (CONTEXT_LENGTH_OPTIONS[j] === value) { allowed = true; break; }
        }
        if (allowed && !seen[value]) {
            seen[value] = true;
            result.push(value);
        }
    }
    return result.length ? result : CONTEXT_LENGTH_OPTIONS.slice(0);
}

function setContextOptions(raw) {
    contextOptions = normalizeContextOptions(raw);
    return contextOptions;
}

function normalizeContextLength(value, options) {
    var parsed = parseContextLengthValue(value);
    var opts = options || contextOptions || CONTEXT_LENGTH_OPTIONS;
    for (var i = 0; i < opts.length; i++) {
        if (opts[i] === parsed) return parsed;
    }
    // data.contextLength 缺失、为 0 或不在可选集内时，一律回退产品默认 256K。
    return DEFAULT_CONTEXT_LENGTH;
}

function contextLengthLabel(value) {
    var normalized = parseContextLengthValue(value);
    return CONTEXT_LENGTH_LABELS[normalized] || String(normalized);
}

function applyContextResponse(data, sessionId) {
    var options = setContextOptions(data && data.contextOptions);
    var selected = normalizeContextLength(data && data.contextLength, options);
    if (sessionId) sessionContextMap[sessionId] = selected;
    else sessionContextMap['_default'] = selected;
    return selected;
}

window.DEFAULT_CONTEXT_LENGTH = DEFAULT_CONTEXT_LENGTH;
window.CONTEXT_OPTIONS = CONTEXT_OPTIONS;
window.CONTEXT_LENGTH_OPTIONS = CONTEXT_LENGTH_OPTIONS;
window.sessionContextMap = sessionContextMap;

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

// Get the effective context window for current context
function getSelectedContext() {
    if (activeSessionId && hasSessionValue(sessionContextMap, activeSessionId)) {
        return normalizeContextLength(sessionContextMap[activeSessionId]);
    }
    if (typeof SESSION_ID !== 'undefined' && SESSION_ID
            && hasSessionValue(sessionContextMap, SESSION_ID)) {
        return normalizeContextLength(sessionContextMap[SESSION_ID]);
    }
    if (hasSessionValue(sessionContextMap, '_default')) {
        return normalizeContextLength(sessionContextMap['_default']);
    }
    return DEFAULT_CONTEXT_LENGTH;
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
    var contextLength = getSelectedContext();

    var cwdHeaders = sessionCwdHeaders(newSessionId);
    if (model) {
        sessionModelMap[newSessionId] = model;
        $.ajax({
            url: '/web/chat/models/select',
            type: 'POST',
            headers: cwdHeaders,
            data: { sessionId: newSessionId, modelName: model }
        }).fail(function (err) { console.error('Failed to inherit model to new session:', err); });
    }
    if (depth) {
        sessionThinkingMap[newSessionId] = depth;
        if (depth !== THINKING_AUTO) {
            $.ajax({
                url: '/web/chat/thinking/select',
                type: 'POST',
                headers: cwdHeaders,
                data: { sessionId: newSessionId, depth: depth }
            }).fail(function (err) { console.error('Failed to inherit thinking depth to new session:', err); });
        }
    }

    // 上下文始终继承并落到服务端，即使当前值是默认 256K 也不能省略保存。
    sessionContextMap[newSessionId] = contextLength;
    $.ajax({
        url: '/web/chat/context/select',
        type: 'POST',
        headers: cwdHeaders,
        data: { sessionId: newSessionId, contextLength: contextLength }
    }).fail(function (err) {
        console.error('Failed to inherit context length to new session:', err);
    });
}
window.inheritSelectionToSession = inheritSelectionToSession;

/* 模型列表请求的归属解析（与 app-streaming 的 strict 读口同口径）：code 模式取
   当前项目根的真实归属（__currentProjectScope 查不到保守回本地），其余回 'local'。
   不显式声明就会落到代理 route_for 的「激活 scope 兜底」——选中远端工作区时模型
   请求被打到远端后端，远端镜像丢失即返回空表。 */
function modelsRequestScope() {
    var s = null;
    if (typeof window.__currentProjectScope === 'function') {
        try { s = window.__currentProjectScope(); } catch (e) { s = null; }
    }
    return (s && s !== 'local') ? s : 'local';
}

/* 归属 → 路由 query 段（与 projScopeQuery / app-code.scopeQueryFor 同口径）。
   返回不含 '?' 的 '__scope=...' 片段，由调用方用数组 join('&') 拼接，
   保证 sessionId 与 __scope 各出现一次（本仓踩过重复 __scope 参数坑：
   route_for 按 query 顺序扫到第一个命中即返回，重复参数会让后一个永远无效）。 */
function modelsScopeSegment(scope) {
    return (scope && scope !== 'local')
        ? '__scope=id:' + encodeURIComponent(scope)
        : '__scope=local';
}

// Load model list (once) + selected model for given session
function loadModels(sessionId, callback) {
    var scope = modelsRequestScope();
    var qParts = [];
    if (sessionId) qParts.push('sessionId=' + encodeURIComponent(sessionId));
    qParts.push(modelsScopeSegment(scope));
    var url = '/web/chat/models?' + qParts.join('&');

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
            var list = data.list || [];
            // 远端空模型表 = 可疑态（远端镜像可能丢失）：不锁死「已加载」，标记 stale，
            // 触发一次镜像重推自愈（healedByScope 防环）；本地空表维持原 degrade 路径。
            if (list.length === 0 && scope !== 'local') {
                // 远端权威空表：清掉可能残留的上一 scope 列表，否则下拉会展示旧环境的模型，
                // 且空表专属文案的渲染条件（列表总量 0）永远不成立。
                modelList = [];
                modelsLoaded = false;
                modelsListStale = true;
                handleRemoteEmptyModels(scope, sessionId, callback);
                return;
            }
            var selected = data.selected || '';
            // 会话上下文由响应顶层提供；旧后端缺少字段时稳定回退到 256K。
            applyContextResponse(data, sessionId);

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
                for (var i = 0; i < list.length; i++) {
                    modelList.push({ name: list[i].name || list[i].model, model: list[i].model || list[i].name, desc: list[i].description, standard: list[i].standard || '', provider: list[i].provider || '', thinkingLevels: (Object.prototype.toString.call(list[i].thinkingLevels) === '[object Array]') ? list[i].thinkingLevels : null });
                }
                modelsLoaded = true;
                modelsListStale = false;
                // 非空成功 → 清除该 scope 的自愈标记：日后若再次空表（真实回归）仍可自愈一次
                delete healedByScope[scope];
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

/* 远端空模型表自愈：本 scope 尚未自愈过 → 触发一次镜像重推（window.remoteMirrorSync）。
   synced=true 重新 loadModels 一次（此次若仍空，healedByScope 已置位 → 不再重推，防环）；
   synced=false / 无入口 → 释放加载态并渲染空表专属文案（不静默）。
   本地 scope 空表不走这里（维持 degradeModelLoad 原路径）。 */
function handleRemoteEmptyModels(scope, sessionId, callback) {
    if (healedByScope[scope]) {
        // 已自愈过仍空：渲染专属文案，不再重推（防环）
        renderModelUI();
        if (callback) callback();
        return;
    }
    healedByScope[scope] = true;
    if (typeof window.remoteMirrorSync !== 'function') {
        renderModelUI();
        if (callback) callback();
        return;
    }
    Promise.resolve(window.remoteMirrorSync(scope)).then(function (res) {
        if (res && res.synced) {
            loadModels(sessionId, callback);   // 重推成功 → 重新拉一次
        } else {
            renderModelUI();
            if (callback) callback();
        }
    }, function () {
        renderModelUI();
        if (callback) callback();
    });
}

/* 镜像同步成功 / 工作区切换 / 连接表变化 → 模型列表归属或内容可能已变，
   标记 stale 并去抖重载。300ms 去抖防风暴：connections-changed 与 mirror-synced
   可能同批到达（连接建立后 Rust 自动推镜像 → 两个事件几乎同时触发）。 */
var _modelsReloadTimer = null;
function scheduleModelsReload() {
    modelsListStale = true;
    if (_modelsReloadTimer) clearTimeout(_modelsReloadTimer);
    _modelsReloadTimer = setTimeout(function () {
        _modelsReloadTimer = null;
        loadModels(activeSessionId || null);
    }, 300);
}
window.addEventListener('gourd:mirror-synced', scheduleModelsReload);
document.addEventListener('workspace:changed', scheduleModelsReload);
window.addEventListener('remote:connections-changed', scheduleModelsReload);

// Refresh model UI for a specific session using local cache (no network request)
function refreshSessionModel(sessionId) {
    if (!sessionId) return;
    // 模型与上下文分别缓存：任一缺失都要向后端恢复，避免只缓存模型时上下文仍显示旧会话值。
    var needsFetch = !sessionModelMap[sessionId]
        || !hasSessionValue(sessionContextMap, sessionId);
    if (needsFetch) {
        // setActiveSession 与显式会话切换都可能触发刷新，合并同一会话的在途请求。
        if (sessionModelRequestMap[sessionId]) return;
        sessionModelRequestMap[sessionId] = true;
        var scope = modelsRequestScope();
        var url = '/web/chat/models?' + ['sessionId=' + encodeURIComponent(sessionId), modelsScopeSegment(scope)].join('&');
        $.get(url, function(resp) {
            try {
                var data = (resp && resp.data) || {};
                sessionModelMap[sessionId] = data.selected || '';
                sessionThinkingMap[sessionId] = normalizeThinkingCode(data.thinkingDepth);
                applyContextResponse(data, sessionId);
                // 访问控制档位回显（会话级）：与模型/思考/上下文同一次响应携带，
                // 同一会话重新打开（刷新后）时恢复用户上次档位；新建会话不会走这里（无缓存 + 后端也回 default）。
                if (window.GourdAccessMode && typeof window.GourdAccessMode.applyServerMode === 'function') {
                    window.GourdAccessMode.applyServerMode(sessionId, data.accessMode);
                }
                // Loop 执行取证提示条恢复：执行会话 composer 回显的是会话自己的旧值（任务参数
                // transient 不写会话），刷新后/任意入口打开执行会话都靠这里从 /web/chat/loop-run
                // 拉「最近一次 Loop 执行的实际生效参数」重建提示条；无取证则清除。
                restoreLoopRunBanner(sessionId);
                renderModelUI();
            } catch (e) {
                console.error('Failed to parse session model:', e);
                if (!hasSessionValue(sessionContextMap, sessionId)) sessionContextMap[sessionId] = DEFAULT_CONTEXT_LENGTH;
                renderModelUI();
            }
            delete sessionModelRequestMap[sessionId];
        }).fail(function (xhr) {
            // 会话切换期间接口失败不能让当前模型按钮保持旧的 loading 文案。
            console.warn('Failed to load session model:', xhr && xhr.status ? ('HTTP ' + xhr.status) : 'network error');
            if (!hasSessionValue(sessionContextMap, sessionId)) sessionContextMap[sessionId] = DEFAULT_CONTEXT_LENGTH;
            delete sessionModelRequestMap[sessionId];
            renderModelUI();
        });
    } else {
        // Already cached — just re-render UI
        renderModelUI();
    }
}

// 从后端取证端点恢复「任务运行参数」提示条（刷新后/任意入口打开执行会话的唯一恢复路径）。
// 数据源是会话快照里的 Loop 轮取证键（本轮实际生效值），任务被删除也不影响回看。
function restoreLoopRunBanner(sessionId) {
    if (!sessionId) return;
    $.get('/web/chat/loop-run?sessionId=' + encodeURIComponent(sessionId), function (resp) {
        var info = (resp && resp.code === 200) ? resp.data : null;
        if (info && typeof window.setLoopRunBanner === 'function') {
            window.setLoopRunBanner(sessionId, info);
        } else if (typeof window.clearLoopRunBanner === 'function') {
            window.clearLoopRunBanner(sessionId);
        }
    });
}
window.restoreLoopRunBanner = restoreLoopRunBanner;

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

    // 按钮内上下文窗口小标签：与思考标签不同，上下文**总有有效值**（默认 256K），
    // 因此不做「默认即隐藏」处理——否则抽屉里选了 1M、收起后按钮上完全看不出来。
    var contextTagLabel = contextLengthLabel(getSelectedContext());
    $('#chatModelContextTag').text(contextTagLabel).toggle(!!contextTagLabel);
    $('#welcomeModelContextTag').text(contextTagLabel).toggle(!!contextTagLabel);

    // 严格保持接口顺序；仅当 provider 与紧邻上一模型不同时插入标题（允许同一 provider 重复出现）
    var entries = ModelListOrder.buildEntries(modelList);
    // 折成分段后交给公共渲染器：统一处理搜索过滤、服务商折叠与空态
    var result = GourdModelDropdown.render({
        segments: GourdModelDropdown.toSegments(entries),
        query: modelFilterText,
        currentModel: currentModel,
        currentProvider: currentEntry ? (currentEntry.provider || '') : '',
        otherLabel: GourdI18n.t('history.model_group_other'),
        // 空态文案区分：列表总量 0 且当前归属为远端 → 「远程未同步」专属文案；
        // 其余（搜索无命中）仍用原「未找到匹配的模型」。
        emptyText: (modelList.length === 0 && modelsRequestScope() !== 'local')
            ? GourdI18n.t('history.models_remote_not_synced')
            : GourdI18n.t('history.model_search_empty'),
        toggleTitle: GourdI18n.t('history.model_group_toggle'),
        itemHtml: function (m, active) {
            var shortName = modelShortName(m);
            // 描述与模型ID相同时属冗余信息（名称行已展示），不再重复渲染第二行
            var desc = m.desc || '';
            if (desc && m.model && desc === m.model) desc = '';
            return '<div class="model-dropdown-item' + (active ? ' active' : '') + '" data-model="' + escapeHtml(m.name) + '">'
                + '<span class="model-item-name">' + escapeHtml(shortName) + '</span>'
                + (desc ? '<span class="model-item-desc">' + escapeHtml(desc) + '</span>' : '')
                // 关联选择：思考档位与上下文窗口内嵌在当前选中模型项下，跟随所选模型展示
                + (active ? thinkingChipsHtml() + contextChipsHtml() : '')
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

// 关联上下文窗口区（内嵌在当前模型项下）：会话级保存，固定显示可用档位
window.sessionCwdHeaders = sessionCwdHeaders;

function contextChipsHtml() {
    var current = getSelectedContext();
    var opts = contextOptions && contextOptions.length ? contextOptions : CONTEXT_LENGTH_OPTIONS;
    var html = '<div class="model-context-opts"><span class="model-context-label">'
        + escapeHtml(GourdI18n.t('app.context_label')) + '</span>';
    for (var i = 0; i < opts.length; i++) {
        var value = opts[i];
        var cls = value === current ? ' active' : '';
        html += '<span class="model-context-chip' + cls + '" data-context="' + value + '"'
            + ' title="' + escapeHtml(contextLengthLabel(value)) + '"'
            + '>' + escapeHtml(contextLengthLabel(value)) + '</span>';
    }
    html += '</div>';
    return html;
}

// 思考档位已合并进模型下拉（关联选择）：渲染统一走 renderModelUI，此函数保留作兼容入口
function renderThinkingUI() {
    renderModelUI();
}

/* 会话选择器（模型 / 思考 / 上下文 / 访问档位）写盘归属头。
   后端 /web/chat/{models,thinking,context,access}/select 把 SessionContext 落在
   「该会话绑定的工作区根」下的 context.json；不带本头时，一个尚未发过消息的新会话
   没有绑定 → 后端回退全局根，于是选择写进全局那份，而 /web/chat/input 带 X-Session-Cwd
   时才绑定项目根、把上下文写进项目那份 —— 同一会话两份 context.json（实测两份字段互相
   缺失）。回显的 /web/chat/models 读的是已绑定后的项目那份，thinking / context_length
   不在里面就回退成「默认」+ 256K。所以四个 select 都必须与 app-streaming 的发送请求
   携带同一归属头（同一真源：会话自己的 projectRoot，回退当前所选工作区）。
   未选择工作区时 getSessionCwd() 为空串 → 不带头，与发送路径「空 cwd 不带头」的既有
   约定逐字一致（裸放路径也不行：中文工作区会让 setRequestHeader 直接抛异常）。 */
function sessionCwdHeaders(sid) {
    var cwd = '';
    if (typeof getOrCreateSession === 'function' && sid && typeof sessionMap !== 'undefined' && sessionMap[sid]) {
        cwd = sessionMap[sid].projectRoot || '';
    }
    if (!cwd && typeof getSessionCwd === 'function') cwd = getSessionCwd() || '';
    var enc = (typeof encodeSessionCwdHeader === 'function') ? encodeSessionCwdHeader(cwd) : '';
    return enc ? { 'X-Session-Cwd': enc } : {};
}

function selectModel(modelName) {
    var sid = activeSessionId || SESSION_ID;
    sessionModelMap[sid] = modelName;
    renderModelUI();

    // 立即通知服务端绑定模型选择，确保不走 /web/chat/input 的命令（如 /git、循环任务等）也能感知到模型变更
    $.ajax({
        url: '/web/chat/models/select',
        type: 'POST',
        headers: sessionCwdHeaders(sid),
        data: { sessionId: sid, modelName: modelName }
    }).fail(function(err) {
        console.error('Failed to select model on server:', err);
    });
}

function selectThinking(depth) {
    var sid = activeSessionId || SESSION_ID;
    sessionThinkingMap[sid] = depth;
    renderModelUI();

    // 立即通知服务端绑定档位（与模型选择同理，覆盖不走 /web/chat/input 的场景）
    $.ajax({
        url: '/web/chat/thinking/select',
        type: 'POST',
        headers: sessionCwdHeaders(sid),
        data: { sessionId: sid, depth: depth }
    }).fail(function(err) {
        console.error('Failed to select thinking depth on server:', err);
    });
}

function selectContext(contextLength) {
    var sid = activeSessionId || SESSION_ID;
    var selected = normalizeContextLength(contextLength);
    sessionContextMap[sid] = selected;
    // 先乐观重绘两处模型下拉，再异步保存；失败只记录日志，不回滚本地选择。
    renderModelUI();

    // 上下文窗口是进度环的分母：不同步就会出现「模型按钮已显 1M、环还按 256K 算占用率」
    // 的矛盾态（甚至停在告警色），直到下一轮 context_size 帧到达才自愈。
    if (typeof applyContextLength === 'function') {
        applyContextLength(typeof getOrCreateSession === 'function' ? getOrCreateSession(sid) : null, selected);
    }

    $.ajax({
        url: '/web/chat/context/select',
        type: 'POST',
        headers: sessionCwdHeaders(sid),
        data: { sessionId: sid, contextLength: selected }
    }).fail(function(err) {
        console.error('Failed to select context length on server:', err);
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
            // 打开即定位到当前选中模型（居中）；无选中项/所在组被折叠时退回置顶
            var listEl = $dropdown.find('.model-dropdown-list')[0];
            if (listEl && !GourdModelDropdown.scrollToActive(listEl)) listEl.scrollTop = 0;
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

        // 关联的上下文窗口 chip：仅设置当前会话上下文，不切模型；保持下拉打开便于连续调整
        var $contextChip = $(e.target).closest('.model-context-chip');
        if ($contextChip.length) {
            var contextLength = normalizeContextLength($contextChip.attr('data-context'));
            if (contextLength !== getSelectedContext()) {
                selectContext(contextLength);
            }
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
window.getSelectedContext = getSelectedContext;
window.selectContext = selectContext;
// 思考深度档位单一真源：供自动化视图（app-automation.js）复用，避免重复维护档位表
window.thinkingOptionsForModel = thinkingOptionsForModel;

/* 命令补全（/ 技能、@ 子代理）对外接口：供自动化表单的指令区完整复用，
   避免在 app-automation.js 里再实现一份候选集过滤/键盘导航（两份必然漂移）。
   宿主需自备面板元素并自行处理「点击候选项」与「点击外部收起」（见 app-automation.js）。 */
window.GourdCmdComplete = {
    show: showCmdComplete,
    hide: hideCmdCompleteFor,
    apply: applyCmdSelection,
    navigate: navigateCmdComplete,
    trigger: triggerCmdComplete,
    // 触发段判定（任意位置的 / 或 @）：外部宿主接 input 事件时必须走这个，
    // 别自己再写「以 / 开头且无空格」——那正是「技能只能触发一次」的病根。
    findToken: findCmdTriggerToken,
    // 供外部宿主在「点击候选项」时先定位再 apply（cmdActiveIndex 是本模块私有，
    // 无法从外部直接赋值；与 app-history.js 自己的面板点击处理同范式）
    setIndex: function (i) { cmdActiveIndex = i; }
};

// Initial load (no specific session, get default selected)
__whenBackendReady(function () { loadModels(null); });
