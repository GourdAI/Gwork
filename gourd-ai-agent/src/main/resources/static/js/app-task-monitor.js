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

    刷新时机：打开时、会话切换时（事件驱动，见 window.refreshTaskMonitor）、
    工作区变化时、打开期间 6s 轮询（兑底）。
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

    /* ---------- 会话切换即时刷新（2026-10 用户报障：切会话后监控等 2-3s 才变） ----------
       根因：本面板刷新触发只有「打开时 / workspace:changed / 6s 轮询」，而
       workspace:changed 仅在工作区真变化时派发（app-workspace.js 的 sel!==current 门禁），
       同工作区内切会话不派发 → 面板只能等轮询 tick（0-6s 均匀、均值 3s）。
       修法（用户拍板方案A）：
       ① app-base.js setActiveSession（全部切换入口的唯一汇聚点）在 switching 分支
          调 window.refreshTaskMonitor() → 切换即重拉，不等轮询；
       ② git 两接口结果只依赖 root、与 sessionId 无关（实测每次 ~1s、9 个 git 子进程），
          root 未变时复用上次结果、切换只发 3 个会话级毫秒接口 → 环境区也即时；
       ③ 切换瞬间先给五区上 loading 态，杜绝「显示旧会话内容」的误导（次因B）。 */
    var lastEnvRoot = null;      // 上次成功渲染环境区所用的 root（git 结果复用键）
    var lastRemoteData = null;   // 上次 /git/remote 的成功响应（undefined=失败态，不缓存）
    var lastRemoteRoot = null;   // lastRemoteData 对应的 root（缓存不得跨 root 串台）

    /* ---------- 无变化不闪（2026-10 用户反馈：「已同步」每几秒闪一次） ----------
       闪烁由三个叠加机制造成，逐一拆除：
       ① 轮询也闪 loading：loadAll 只要 reuse=false 就 showLoading()，而 6s 轮询 /
          workspace:changed 都是 reuse=false → 每 6s 四区被换成呼吸动画再换回。
          修法：loading 门禁收窄到「会话切换 / root 变化 / 首开」（旧内容可能冒充
          新会话的场景）；轮询与 workspace 变化保留旧内容，数据到达后原地更新。
       ② 同步行文案翻转：轮询时 git/status 先回包且 remote 传 undefined → 同步行
          先翻成「未配置远程」，git/remote 晚到再翻回「已同步」，每轮一次跳变。
          修法：remote 缓存按 root 复用，status 渲染时带上同 root 的旧 remote。
       ③ 内容没变也整棵重写 innerHTML（hover/缩略图/滚动状态白丢）。
          修法：setBodyHtml 逐区缓存 html，与上轮相同则跳过写 DOM。 */
    function setBodyHtml(el, html) {
        if (!el) return;
        if (el.__tmHtml === html) return;   // 值未变：不碰 DOM，杜绝无谓重绘闪烁
        el.__tmHtml = html;
        el.innerHTML = html;
    }

    function loadingRow() { return '<div class="tm-empty tm-loading">' + esc(t('common.loading')) + '</div>'; }
    function showLoading() {
        // 同步清缓存标记：loading 行必须真的写进 DOM（不得被 setBodyHtml 的同值跳过）
        if (envBody) { envBody.__tmHtml = null; envBody.innerHTML = loadingRow(); }
        if (outputsBody) { outputsBody.__tmHtml = null; outputsBody.innerHTML = loadingRow(); }
        if (sourcesBody) { sourcesBody.__tmHtml = null; sourcesBody.innerHTML = loadingRow(); }
        if (skillsBody) { skillsBody.__tmHtml = null; skillsBody.innerHTML = loadingRow(); }
    }
    /* loading 在飞标记曾以 loadingOn 变量实现，但全仓零读取（只写不读的死状态，
       2026-10 自审删除）：门禁真源是 envStale（lastEnvRoot vs root），showLoading
       只在 stale 路径调用、各 render 成功/失败两路都解除，无需额外标记。 */
    function clearLoading() { }

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
        // 错误行也必须走 setBodyHtml：raw 写会让 __tmHtml 缓存与 DOM 失步——
        // 瞬断恢复后若新 html 与错误前同值，同值跳过会把「加载失败」行永久卡住
        if (status === undefined) { clearLoading(); setBodyHtml(envBody, errorRow()); return; }
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
        // remote 缺省（status 先到、remote 在飞/失败）时回落到同 root 的缓存：
        // 否则每轮轮询同步行都会「已同步 → 未配置远程 → 已同步」翻一次（用户报的闪）
        var rm = remote;
        if (rm === undefined && lastRemoteData && lastRemoteRoot === root) rm = lastRemoteData;
        if (!rm || !rm.hasRemote) syncText = t('monitor.no_remote');
        else if (!rm.upstream) syncText = t('monitor.no_upstream');
        else if ((rm.ahead || 0) === 0 && (rm.behind || 0) === 0) syncText = t('monitor.synced');
        else syncText = t('monitor.ahead_behind', [rm.ahead || 0, rm.behind || 0]);
        html += row('commit', '', esc(syncText), rm && rm.remoteUrl ? rm.remoteUrl : '');
        clearLoading();
        setBodyHtml(envBody, html);
    }

    function renderOutputs(data) {
        if (!outputsBody) return;
        if (data === undefined) { clearLoading(); setBodyHtml(outputsBody, errorRow()); return; }
        var files = (data && data.files) || [];
        if (!files.length) { setBodyHtml(outputsBody, emptyRow('monitor.empty_outputs')); return; }
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
        setBodyHtml(outputsBody, html);
    }

    /* 来源区（本会话上传过的附件清单）。
       2026-10-15 用户反馈：机器长名（pasted-image-1792059457204-k3x9q.png）必被截断
       且无从辨识，且要点开看大图。改造：
       ① 图片行显示「图片 · <相对时间>」+ 真实缩略图（meta 拉回 dataUrl 后替换图标位），
          不再展示存储名（原存储名收进 title，悬停可见；新上传已是短随机名 image-<随机>.png）；
       ② 点击图片行 → 复用全站灯箱 openLightbox 看大图（对话区附件同款交互）；
          点击时按需拉 meta（fetchAttachmentMeta 带常驻缓存，重复点击零网络开销），
          拉不到（缺失/超限/读盘失败）toast 明确提示，不静默；
       ③ 文件行保持纯展示（名称 + 大小）；uploads/ 路径不在工作区文件树内，不可跳文件查看器。 */
    function renderSources(data) {
        if (!sourcesBody) return;
        if (data === undefined) { clearLoading(); setBodyHtml(sourcesBody, errorRow()); return; }
        var items = (data && data.items) || [];
        if (!items.length) { setBodyHtml(sourcesBody, emptyRow('monitor.empty_sources')); return; }
        var imagePaths = [];
        var html = '';
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var sizeSub = (it.size > 0)
                ? '<span class="tm-row-sub">' + esc(formatFileSize(it.size)) + '</span>' : '';
            if (it.image) {
                imagePaths.push(it.path);
                /* 「图片 · <相对时间>」：不用存储名做主文案（机器名无可读性）；
                   原存储名与大小收进 title。时间口径与侧栏会话行 formatRelTime 同源。 */
                var when = (it.updatedAt && typeof formatRelTime === 'function')
                    ? '<span class="tm-row-sub">' + esc(formatRelTime(it.updatedAt)) + '</span>' : sizeSub;
                html += '<div class="tm-row tm-row-preview" data-tm-source="' + esc(it.path) + '" title="' + esc(it.name) + '">' +
                    '<span class="tm-row-icon tm-icon-image">' + ICONS.image + '</span>' +
                    '<span class="tm-row-text">' + esc(t('monitor.image')) + ' ' + when + '</span></div>';
            } else {
                html += '<div class="tm-row" title="' + esc(it.name) + '">' +
                    '<span class="tm-row-icon tm-icon-doc">' + ICONS.doc + '</span>' +
                    '<span class="tm-row-text">' + esc(it.name) + ' ' + sizeSub + '</span></div>';
            }
        }
        setBodyHtml(sourcesBody, html);
        upgradeSourceThumbs(imagePaths);
    }

    /* 缩略图异步升级：meta 结果晚于下一次轮询重渲染时必须丢弃（版本号守卫，
       与 loadAll 的 reqVersions 同一纪律——旧行已被新 DOM 取代）。 */
    var srcThumbSeq = 0;
    function upgradeSourceThumbs(paths) {
        if (!paths || !paths.length) return;
        if (typeof fetchAttachmentMeta !== 'function') return;
        var sid = currentSessionId();
        if (!sid) return;
        srcThumbSeq++;
        var mySeq = srcThumbSeq;
        fetchAttachmentMeta({ sessionId: sid, projectRoot: resolveRoot(sid) }, paths).then(function (results) {
            if (mySeq !== srcThumbSeq) return;
            var byPath = {};
            for (var i = 0; i < (results || []).length; i++) {
                var r = results[i];
                if (r && r.path && r.dataUrl) byPath[r.path] = r;
            }
            var rows = sourcesBody.querySelectorAll('.tm-row-preview');
            for (var j = 0; j < rows.length; j++) {
                var meta = byPath[rows[j].getAttribute('data-tm-source')];
                if (!meta) continue;
                var icon = rows[j].querySelector('.tm-row-icon');
                if (!icon) continue;
                // 同值不闪纪律的延伸：DOM 未重写时行节点是上一轮的，缩略图可能已就位；
                // src 相同则跳过，避免每轮轮询把同一张图摘了重挂（无谓重绘）
                var exist = icon.querySelector ? icon.querySelector('img.tm-src-thumb') : null;
                if (exist && exist.src === meta.dataUrl) continue;
                var img = document.createElement('img');
                img.className = 'tm-src-thumb';
                img.src = meta.dataUrl;
                img.alt = '';
                icon.textContent = '';
                icon.appendChild(img);
            }
        });
    }

    /* 点击图片行 → 灯箱看大图。meta 未命中就现拉一次；仍无 dataUrl（缺失/超限/读盘
       失败）toast 提示。openLightbox 由 app-message.js 暴露，做存在性守卫，
       宁可不打开也不抛。 */
    if (sourcesBody) {
        sourcesBody.addEventListener('click', function (e) {
            var rowEl = e.target.closest ? e.target.closest('.tm-row-preview') : null;
            if (!rowEl) return;
            var path = rowEl.getAttribute('data-tm-source');
            if (!path) return;
            var sid = currentSessionId();
            if (!sid || typeof fetchAttachmentMeta !== 'function') return;
            fetchAttachmentMeta({ sessionId: sid, projectRoot: resolveRoot(sid) }, [path]).then(function (results) {
                var r = results && results[0];
                if (r && r.dataUrl && typeof window.openLightbox === 'function') {
                    window.openLightbox(r.dataUrl);
                } else if (typeof window.showToast === 'function') {
                    window.showToast(t('code.preview_load_failed'), 'error');
                }
            });
        });
    }

    function renderSkills(data) {
        if (!skillsBody) return;
        if (data === undefined) { clearLoading(); setBodyHtml(skillsBody, errorRow()); return; }
        var skills = (data && data.skills) || [];
        if (!skills.length) { setBodyHtml(skillsBody, emptyRow('monitor.no_skills')); return; }
        var html = '';
        for (var i = 0; i < skills.length; i++) {
            var s = skills[i];
            /* 【展示名优先】技能行的 name 是 skillread 的参数值 = 安装目录名
               （namespace 限定 slug 会落成 _user_xxx_yyy），直接渲染是用户看不懂的名字，
               而且在技能页里同一个技能已经显示成展示名/裸尾名了——两地对不上。
               2026-10 已发生过这个真实缺陷（技能页修好、监控漏修）。
               目录名不丢：收进 title，悬停仍可看到真实标识。 */
            var label = s.displayName || s.name || s.toolName;
            /* 目录名不丢：仅在展示名生效且与 name 不同时收进 title（悬停可看真实标识） */
            var rawName = (s.displayName && s.name && s.name !== s.displayName) ? s.name : '';
            html += row('skill', '', esc(label) +
                '<span class="tm-row-sub">×' + (s.count || 1) + '</span>', rawName);
        }
        setBodyHtml(skillsBody, html);
    }

    function renderMemory(data) {
        if (!memoryRow || !memoryLabel) return;
        var updated = !!(data && data.memory && data.memory.updated);
        memoryRow.classList.toggle('updated', updated);
        memoryLabel.textContent = t(updated ? 'monitor.memory_updated' : 'monitor.memory_not_updated');
    }

    // ---------- 汇总加载 ----------
    /* reuseGit=true（会话切换触发）且 root 与上次环境区渲染相同时，git 两接口
       直接复用缓存：它们只依赖 root（实测每次 ~1s、9 个 git 子进程串行），
       与 sessionId 无关，同 root 下重拉是纯浪费；会话级 3 接口（毫秒级）仍必发。
       轮询/打开/workspace:changed 传 false：git 工作区状态需保持新鲜。 */
    function loadAll(reuseGit) {
        var sid = currentSessionId();
        if (!sid) {
            // 未进入任何会话（欢迎页）：五区全空态，不发请求
            clearLoading();
            setBodyHtml(envBody, emptyRow('monitor.empty_env'));
            setBodyHtml(outputsBody, emptyRow('monitor.empty_outputs'));
            setBodyHtml(sourcesBody, emptyRow('monitor.empty_sources'));
            setBodyHtml(skillsBody, emptyRow('monitor.no_skills'));
            renderMemory(null);
            return;
        }
        var root = resolveRoot(sid);
        var rq = root ? '&root=' + encodeURIComponent(root) : '';
        var reuse = reuseGit === true && lastEnvRoot !== null && lastEnvRoot === root;
        /* loading 门禁（2026-10 闪烁修复）：只有「会话/root 真切换或首开」才闪 loading——
           那些场景旧内容可能冒充新会话；轮询与 workspace:changed 保留旧内容原地更新，
           数据没变时 setBodyHtml 连 DOM 都不碰（用户：值没变更就不要闪）。 */
        var envStale = lastEnvRoot === null || lastEnvRoot !== root;
        if (envStale) showLoading();
        if (reuse) {
            // 环境区立即用缓存重绘（含上次 remote 结果）：切换零等待
            renderEnv(lastEnvStatus ? lastEnvStatus.status : {}, lastRemoteData || undefined, root);
        } else {
            fetchJson('/web/chat/git/status?sessionId=' + encodeURIComponent(sid) + rq, root, 'env1')
                .then(function (d) { renderEnv(d || {}, undefined, root); }, function () { renderEnv(undefined, undefined, root); });
            fetchJson('/web/chat/git/remote?sessionId=' + encodeURIComponent(sid) + rq, root, 'env2')
                // lastRemoteRoot 必须同写：轮询时 git/status 先回包（remote=undefined）靠
                // 「同 root 的 remote 缓存」回落，缺它则同步行每轮先翻 no_remote 再翻回
                // （用户所指「已同步每几秒闪一次」的另一半根因）
                .then(function (d) { lastRemoteData = d || {}; lastRemoteRoot = root; renderRemoteInto(d); },
                    function () { /* 远程态失败不整区报错，也不缓存失败态 */ });
        }
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
        if (status !== undefined) { lastEnvStatus = { status: status, root: root }; lastEnvRoot = root; }
        // 成功响应才入缓存：失败态（undefined）不得污染同步行文案的回落值
        if (remote !== undefined) { lastRemoteData = remote || {}; lastRemoteRoot = root; }
        _renderEnv(status, remote, root);
    };
    function renderRemoteInto(remote) {
        if (!lastEnvStatus) return;
        // 守卫：remote 晚到时若会话/root 已切走，不得把旧 root 的环境区绘回新会话
        if (lastEnvStatus.root !== lastEnvRoot) return;
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
    /* 会话切换即时刷新入口：app-base.js setActiveSession 的 switching 分支调用。
       面板关着或还在欢迎页时 no-op（openMonitor/syncWithView 会在进入时自拉）。 */
    window.refreshTaskMonitor = function () {
        if (!isOpen() || isWelcomePage()) return;
        loadAll(true);
    };

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
