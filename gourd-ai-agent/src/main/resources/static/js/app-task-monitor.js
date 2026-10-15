/* ===== app-task-monitor.js =====
   任务监控抽屉：右侧滑出面板，按会话展示五类信息——
   环境信息（git 变更/分支/远程同步/工作区）、产出（本会话被写改的文件）、
   来源（本会话上传的附件）、技能调用、记忆是否更新。

   数据全部走后端会话级汇总端点（WebController）：
   - /web/chat/git/status        既有：分支 + 变更统计
   - /web/chat/git/remote        新增：remote / upstream / ahead-behind
   - /web/chat/changes/session   新增：跨 run 合并的本会话产出文件
   - /web/chat/attachment/list   新增：本会话 uploads 目录清单
   - /web/chat/session/tool-usage 新增：记忆更新标记 + 技能调用统计
   （memory_extract 的工具帧被 WebToolVisibilityPolicy 主动过滤、不落 stream，
     前端永远收不到，故「记忆是否更新」只能由后端扫 messages.ndjson 反查。）

    刷新时机：打开时、会话/工作区变化时、打开期间 6s 轮询。
    【无头部】不设标题与刷新钮（用户参照稿形态）：开合由标题栏监控按钮承担，
    轮询 + 事件重拉已覆盖实时性，手动刷新钮属冗余控件。

    【默认显示策略】进入会话（对话视图）默认展示监控右栏；欢迎页（新建任务首页）
    没有执行中的任务，展示监控不合理——回欢迎页自动收起，且欢迎页上点按钮也不开
    （用户明确反馈）。偏好持久化在 localStorage 'tm-default-open'（'1'/'0'，缺省开）。 */
(function () {
    'use strict';

    var drawer = document.getElementById('taskMonitorDrawer');
    var envBody = document.getElementById('tmEnvBody');
    var outputsBody = document.getElementById('tmOutputsBody');
    var sourcesBody = document.getElementById('tmSourcesBody');
    var skillsBody = document.getElementById('tmSkillsBody');
    var memoryRow = document.getElementById('tmMemoryRow');
    var memoryLabel = document.getElementById('tmMemoryLabel');
    var memoryJumpBtn = document.getElementById('tmMemoryJumpBtn');
    if (!drawer) return;

    var POLL_MS = 6000;
    var pollTimer = null;
    var reqVersions = {};   // 每个端点一个版本号：旧响应晚到不得覆盖新响应（同 app-todos 纪律）

    function t(key, params) { return GourdI18n.t(key, params); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ---------- 会话 / 工作区根解析（与 app-todos.js resolveTodoRoot 同口径）----------
    function currentSessionId() {
        return typeof SESSION_ID !== 'undefined' ? SESSION_ID : null;
    }
    function resolveRoot(sid) {
        var sess = (typeof sessionMap !== 'undefined' && sessionMap) ? sessionMap[sid] : null;
        if (sess && sess.projectRoot) return sess.projectRoot;
        if (sid === currentSessionId() && typeof getSessionCwd === 'function') return getSessionCwd() || '';
        return '';
    }

    function fetchJson(url, root, slot) {
        reqVersions[slot] = (reqVersions[slot] || 0) + 1;
        var ver = reqVersions[slot];
        var headers = root ? { 'X-Session-Cwd': encodeSessionCwdHeader(root) } : {};
        return fetch(url, { headers: headers })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (res) {
                if (reqVersions[slot] !== ver) return null;           // 过期响应丢弃
                if (res && res.code !== undefined && res.code !== 0 && !res.data) throw new Error('biz ' + res.code);
                return (res && res.data) ? res.data : {};
            });
    }

    // ---------- 渲染小件 ----------
    var ICONS = {
        compare: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/></svg>',
        monitor: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>',
        branch: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
        commit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/></svg>',
        doc: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>',
        image: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
        skill: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>'
    };
    function row(iconKey, iconCls, textHtml, titleAttr) {
        return '<div class="tm-row"' + (titleAttr ? ' title="' + esc(titleAttr) + '"' : '') + '>' +
            '<span class="tm-row-icon ' + (iconCls || '') + '">' + (ICONS[iconKey] || ICONS.doc) + '</span>' +
            '<span class="tm-row-text">' + textHtml + '</span></div>';
    }
    function emptyRow(key) { return '<div class="tm-empty">' + esc(t(key)) + '</div>'; }
    function errorRow() { return '<div class="tm-error">' + esc(t('monitor.load_failed')) + '</div>'; }
    function shortPath(p) {
        var s = String(p || '').replace(/\\/g, '/');
        var i = s.lastIndexOf('/');
        return i >= 0 ? s.slice(i + 1) : s;
    }

    // ---------- 五类渲染 ----------
    function renderEnv(status, remote, root) {
        if (!envBody) return;
        if (status === undefined) { envBody.innerHTML = errorRow(); return; }
        var html = '';
        var changed = status ? ((status.changed || 0) + (status.staged || 0) + (status.untracked || 0)) : 0;
        html += row('compare', '', changed > 0
            ? esc(t('monitor.changes_count', [changed]))
            : esc(t('monitor.no_changes')));
        // 环境：本地 / 远端（按工作区根的归属口径，与终端 scope 同源）
        var envName = t('monitor.env_local');
        try {
            if (root && typeof window.__currentChatWorkspaceScope === 'function') {
                var sc = window.__currentChatWorkspaceScope();
                if (sc && sc !== 'local') envName = t('monitor.env_remote');
            }
        } catch (e) { /* 归属查不到按本地显示 */ }
        html += row('monitor', '', esc(envName) +
            (root ? '<span class="tm-row-sub">' + esc(shortPath(root)) + '</span>' : ''), root);
        if (status && status.gitAvailable && status.initialized !== false) {
            html += row('branch', '', esc(status.branch || 'main'));
        } else {
            html += row('branch', '', esc(t('monitor.no_git')));
        }
        // 远程同步态：无 remote / 无 upstream / ahead-behind
        var syncText;
        if (!remote || !remote.hasRemote) syncText = t('monitor.no_remote');
        else if (!remote.upstream) syncText = t('monitor.no_upstream');
        else if ((remote.ahead || 0) === 0 && (remote.behind || 0) === 0) syncText = t('monitor.synced');
        else syncText = t('monitor.ahead_behind', [remote.ahead || 0, remote.behind || 0]);
        html += row('commit', '', esc(syncText), remote && remote.remoteUrl ? remote.remoteUrl : '');
        envBody.innerHTML = html;
    }

    function renderOutputs(data) {
        if (!outputsBody) return;
        if (data === undefined) { outputsBody.innerHTML = errorRow(); return; }
        var files = (data && data.files) || [];
        if (!files.length) { outputsBody.innerHTML = emptyRow('monitor.empty_outputs'); return; }
        var html = '';
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            var sub = (f.additions || 0) || (f.deletions || 0)
                ? '<span class="tm-row-sub">+' + (f.additions || 0) + ' -' + (f.deletions || 0) + '</span>' : '';
            html += '<div class="tm-row tm-row-click" data-tm-path="' + esc(f.path) + '" title="' + esc(f.path) + '">' +
                '<span class="tm-row-icon tm-icon-doc">' + ICONS.doc + '</span>' +
                '<span class="tm-row-text">' + esc(shortPath(f.path)) + ' ' +
                '<span class="tm-row-sub">' + esc(f.changeType || '') + '</span>' + sub + '</span></div>';
        }
        outputsBody.innerHTML = html;
    }

    function renderSources(data) {
        if (!sourcesBody) return;
        if (data === undefined) { sourcesBody.innerHTML = errorRow(); return; }
        var items = (data && data.items) || [];
        if (!items.length) { sourcesBody.innerHTML = emptyRow('monitor.empty_sources'); return; }
        var html = '';
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            // 来源行不可点击跳转查看器：uploads/ 路径不在工作区文件树内，
            // openFileViewer 解析不到（附件预览走对话气泡内的缩略图链路）。
            html += '<div class="tm-row" title="' + esc(it.name) + '">' +
                '<span class="tm-row-icon ' + (it.image ? 'tm-icon-image' : 'tm-icon-doc') + '">' +
                (it.image ? ICONS.image : ICONS.doc) + '</span>' +
                '<span class="tm-row-text">' + esc(it.name) + '</span></div>';
        }
        sourcesBody.innerHTML = html;
    }

    function renderSkills(data) {
        if (!skillsBody) return;
        if (data === undefined) { skillsBody.innerHTML = errorRow(); return; }
        var skills = (data && data.skills) || [];
        if (!skills.length) { skillsBody.innerHTML = emptyRow('monitor.no_skills'); return; }
        var html = '';
        for (var i = 0; i < skills.length; i++) {
            var s = skills[i];
            html += row('skill', '', esc(s.name || s.toolName) +
                '<span class="tm-row-sub">×' + (s.count || 1) + '</span>');
        }
        skillsBody.innerHTML = html;
    }

    function renderMemory(data) {
        if (!memoryRow || !memoryLabel) return;
        var updated = !!(data && data.memory && data.memory.updated);
        memoryRow.classList.toggle('updated', updated);
        memoryLabel.textContent = t(updated ? 'monitor.memory_updated' : 'monitor.memory_not_updated');
    }

    // ---------- 汇总加载 ----------
    function loadAll() {
        var sid = currentSessionId();
        if (!sid) {
            // 未进入任何会话（欢迎页）：五区全空态，不发请求
            if (envBody) envBody.innerHTML = emptyRow('monitor.empty_env');
            if (outputsBody) outputsBody.innerHTML = emptyRow('monitor.empty_outputs');
            if (sourcesBody) sourcesBody.innerHTML = emptyRow('monitor.empty_sources');
            if (skillsBody) skillsBody.innerHTML = emptyRow('monitor.no_skills');
            renderMemory(null);
            return;
        }
        var root = resolveRoot(sid);
        var rq = root ? '&root=' + encodeURIComponent(root) : '';
        fetchJson('/web/chat/git/status?sessionId=' + encodeURIComponent(sid) + rq, root, 'env1')
            .then(function (d) { renderEnv(d || {}, undefined, root); }, function () { renderEnv(undefined, undefined, root); });
        fetchJson('/web/chat/git/remote?sessionId=' + encodeURIComponent(sid) + rq, root, 'env2')
            .then(function (d) { renderRemoteInto(d); }, function () { /* 远程态失败不整区报错 */ });
        fetchJson('/web/chat/changes/session?sessionId=' + encodeURIComponent(sid) + rq, root, 'out')
            .then(function (d) { renderOutputs(d || {}); }, function () { renderOutputs(undefined); });
        fetchJson('/web/chat/attachment/list?sessionId=' + encodeURIComponent(sid) + rq, root, 'src')
            .then(function (d) { renderSources(d || {}); }, function () { renderSources(undefined); });
        fetchJson('/web/chat/session/tool-usage?sessionId=' + encodeURIComponent(sid) + rq, root, 'tool')
            .then(function (d) { renderSkills(d || {}); renderMemory(d || {}); },
                function () { renderSkills(undefined); renderMemory(null); });
    }

    /* 远程态与 git status 是两个独立请求：status 先渲染、remote 后到时只补最后一行，
       不整区重绘（避免闪烁与覆盖 status 的降级空态）。 */
    var lastEnvStatus = null;
    var _renderEnv = renderEnv;
    renderEnv = function (status, remote, root) {
        if (status !== undefined) lastEnvStatus = { status: status, root: root };
        _renderEnv(status, remote, root);
    };
    function renderRemoteInto(remote) {
        if (!lastEnvStatus) return;
        _renderEnv(lastEnvStatus.status, remote, lastEnvStatus.root);
    }

    // ---------- 开合 ----------
    function isOpen() { return document.body.classList.contains('task-monitor-open'); }
    /* 欢迎页（新建任务首页）无执行任务：监控右栏无意义，禁止展示。
       判定口径与 app-ui.js 视图切换同源：chatView 带 .active 才是对话视图。 */
    function isWelcomePage() {
        var cv = document.getElementById('chatView');
        return !(cv && cv.classList.contains('active'));
    }
    function defaultOpenPref() {
        try { return localStorage.getItem('tm-default-open') !== '0'; } catch (e) { return true; }
    }
    function openMonitor(opts) {
        // 欢迎页门禁：手动点击与默认策略都不放行（用户：首页没执行任务，展示监控不合理）
        if (isWelcomePage()) return;
        document.body.classList.add('task-monitor-open');
        drawer.setAttribute('aria-hidden', 'false');
        if (opts && opts.user) { try { localStorage.setItem('tm-default-open', '1'); } catch (e) {} }
        loadAll();
        if (!pollTimer) pollTimer = setInterval(function () { if (isOpen()) loadAll(); }, POLL_MS);
    }
    function closeMonitor(opts) {
        document.body.classList.remove('task-monitor-open');
        drawer.setAttribute('aria-hidden', 'true');
        if (opts && opts.user) { try { localStorage.setItem('tm-default-open', '0'); } catch (e) {} }
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }
    function toggleMonitor() { if (isOpen()) closeMonitor({ user: true }); else openMonitor({ user: true }); }
    window.toggleTaskMonitor = toggleMonitor;
    window.closeTaskMonitor = closeMonitor;
    window.openTaskMonitor = openMonitor;

    /* 默认显示：进入会话自动开（偏好可关）；回欢迎页自动收起。
       视图切换由 app-ui.js 的 switchToChatMode/switchToWelcomeMode 驱动，二者都会
       增删 chatView 的 .active 类——以该类为唯一真源观察，不依赖调用顺序。 */
    function syncWithView() {
        if (isWelcomePage()) {
            if (isOpen()) closeMonitor();   // 回首页：收起（不写偏好，属场景门禁而非用户选择）
        } else if (!isOpen() && defaultOpenPref()) {
            openMonitor();
        }
    }
    var chatViewEl = document.getElementById('chatView');
    if (chatViewEl && window.MutationObserver) {
        new MutationObserver(syncWithView).observe(chatViewEl, {
            attributes: true, attributeFilter: ['class']
        });
    }
    syncWithView(); // 脚本装载时已在会话视图（如刷新页面）：补一次默认开

    // 关闭路径：标题栏按钮 toggle + Esc（无头部关闭钮：参照稿形态，头部已整体移除）
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && isOpen()) closeMonitor();
    });

    // ---------- 分区折叠 ----------
    var collapsedSecs = {};
    try { collapsedSecs = JSON.parse(localStorage.getItem('tm-sec-collapsed') || '{}') || {}; } catch (e) { collapsedSecs = {}; }
    (function initSections() {
        var heads = drawer.querySelectorAll('.tm-sec-head');
        for (var i = 0; i < heads.length; i++) {
            (function (head) {
                var key = head.getAttribute('data-tm-sec');
                var sec = head.parentNode;
                if (collapsedSecs[key]) sec.classList.add('collapsed');
                head.setAttribute('aria-expanded', collapsedSecs[key] ? 'false' : 'true');
                head.addEventListener('click', function () {
                    var nowCollapsed = sec.classList.toggle('collapsed');
                    head.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
                    collapsedSecs[key] = nowCollapsed;
                    try { localStorage.setItem('tm-sec-collapsed', JSON.stringify(collapsedSecs)); } catch (e) {}
                });
            })(heads[i]);
        }
    })();

    // ---------- 行点击：产出 → 文件查看器 ----------
    /* 【root 透传纪律】产出清单的 path 是【会话工作区根】的相对路径，而
       openFileViewer 缺省 root 取 code 模式当前项目（chat 模式为空→后端默认根）。
       会话根 ≠ 当前根时（chat 多工作区 / code 切了别的项目）必 404 File not found。
       故点击时必须把本面板解析到的会话根显式透传（与 app-file-changes.js 同纪律）。 */
    drawer.addEventListener('click', function (e) {
        var rowEl = e.target.closest ? e.target.closest('.tm-row-click') : null;
        if (!rowEl) return;
        var p = rowEl.getAttribute('data-tm-path');
        if (!p || typeof window.openFileViewer !== 'function') return;
        var sid = currentSessionId();
        var root = sid ? resolveRoot(sid) : '';
        window.openFileViewer(p, shortPath(p), root || undefined);
    });

    // ---------- 记忆跳转 ----------
    if (memoryJumpBtn) {
        memoryJumpBtn.addEventListener('click', function () {
            if (typeof window.openMemoryView === 'function') window.openMemoryView();
        });
    }

    // ---------- 实时性补充：工作区/会话变化时重拉 ----------
    // workspace:changed 在 document 上派发且不带 bubbles:true（app-workspace.js/app-code.js），
    // window 监听收不到——必须与全仓其余消费者一样挂 document。
    document.addEventListener('workspace:changed', function () { if (isOpen()) loadAll(); });
    document.addEventListener('i18n:localeChanged', function () { if (isOpen()) loadAll(); });
})();
