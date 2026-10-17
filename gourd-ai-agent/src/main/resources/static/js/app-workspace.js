/* app-workspace.js — Chat 模式工作空间选择器。
   会话按所属根隔离存储（与 code 模式统一）：所选工作空间根写入 window.currentChatWorkspace，
   全链路（发送/todos/memory/queue）经 getSessionCwd() 自动带 X-Session-Cwd；
   '' 表示不选工作空间 = 全局对话（/web/chat/meta 返回的 workspace，即安装目录全局区）。
   选择器仅欢迎页一个实例（进入对话后不再显示，切换工作空间=回欢迎页开新会话）；
   状态持久化 localStorage；侧栏历史由 app-history 的全局/项目视图切换控制。 */
(function () {
    var LS_CHAT_WS = 'gourdai-chat-workspace';

    /* 已登记项目缓存（[{name, path}]）：按钮显示名必须用登记名（projects.json 的 name），
       否则侧栏改名后这里仍按路径末段渲染，出现「侧栏 gost-test / 按钮 gost」的永久性不一致
       （重命名只改展示名、不动磁盘目录，故靠 baseName(path) 永远读不到新名字）。 */
    var projectsCache = [];

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
        /* 归一必须走 pathScopeKey（仅 Windows 路径降大小写）：无条件 lower 在
           Linux/macOS 上会把 /home/u/Proj 当成默认工作区 /home/u/proj，
           于是选中它被当「回到全局区」——选择被静默丢弃。 */
        if (def && pathScopeKey(p) === pathScopeKey(def)) return '';
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

    /* 路径比较键：Windows 盘符路径大小写不敏感且分隔符可混用，与 app-memory.js pathKey 同口径 */
    function pathKey(p) { return pathScopeKey(p); }

    /* 登记名优先，未登记（或列表尚未就绪）回退目录名：
       与侧栏项目行、下拉列表项、code 模式选择器口径一致。 */
    function nameOf(path) {
        var key = pathKey(path);
        for (var i = 0; i < projectsCache.length; i++) {
            var p = projectsCache[i];
            if (p && pathKey(p.path) === key && p.name) return p.name;
        }
        return baseName(path);
    }

    function displayName() {
        /* 不选工作空间 = 全局（默认）：按钮仅提示「选择项目」，不展示全局信息 */
        if (!window.currentChatWorkspace) return GourdI18n.t('code.select_project');
        return nameOf(window.currentChatWorkspace);
    }

    /* 拉取登记项目列表并刷新缓存；成功/失败都回调（失败时缓存保持旧值，按钮回退目录名）。

       【按工作区分流：多路扇出合并（多远端并发·方案B）】本地恒为主拉：/web/chat/projects
       无归属信息时走激活 scope，而激活 scope 在「选中远端工作区」时指向远端——主拉结果的
       归属会随选择漂移，不能当「本地那份」用。要稳定拿本地那份必须显式 ?__scope=local；
       远端则【每个在线连接各补拉一路】?__scope=id:<connectionId>。合并后每条带 _scope，
       选中时按它声明归属（scopeOfPath）。
       WHY 扇出（旧实现只补拉单个 activeId）：连上第二台后第一台的登记项目从列表里
       整个消失（用户看到的形态就是「同时只能有一台」），且它的选中项在缓存里查不到
       归属 → 触发 scopeOfPath 兜底 → 跨机误绑。扇出后每台各有一份，归属可查。

       【去重键叠加 scope】键 = pathScopeKey(path) + '@' + (_scope||'local')。
       WHY：旧键只有路径，/srv/proj 在 A、B 两台同时存在时被当成同一条去重掉——
       用户永远选不到 B 的那份，而两台上的同名目录是两个真实不同的工作区。
       现在只在【同一来源内】合并重复路径（同一份列表里的脏数据），跨来源一律并存，
       条目 title 的 _scopeHost 负责告诉用户这条属于哪台机器。

       【绑定自愈】页面重载/断线重连后路由表的 by_cwd 绑定可能丢失（连接重建会重登记
       但绑定需重新声明）。每次扇出 settle 后：若当前选中项能查到【远端】_scope，重新走
       applyChatWorkspace（内部幂等调 bindWorkspaceScope）——不依赖用户重新点一次。
       查不到归属（scopeOfPath 返回 null）时【不动现有绑定】：旧实现在这里拿到的是
       兜底回落的 activeId，连上第二台后会用 B 的 id 重新 bind A 机的目录（跨机误绑）。 */
    function loadProjects(cb) {
        /* 在线连接 id 列表【内联取，不抽 helper】：本函数会被契约测试切进沙箱执行
           （workspace-scope-split.test.js 只注入 pathScopeKey / remoteHostLabel /
           pathKey / scopeOfPath），调模块内新增函数会 ReferenceError。
           WHY 降级：无壳/浏览器/旧壳没有 __GOURD_REMOTE__ 时退回单 activeId 兜一条，
           保证扇出改造不让远端工作区在这些环境里整个消失。 */
        var ids = [];
        var remoteApi = window.__GOURD_REMOTE__;
        if (remoteApi && typeof remoteApi.list === 'function') {
            var conns = remoteApi.list() || [];
            for (var ci = 0; ci < conns.length; ci++) {
                var cid = conns[ci] && conns[ci].connectionId;
                if (cid && ids.indexOf(cid) < 0) ids.push(cid);
            }
        } else {
            var onlyActive = (typeof window.__GOURD_REMOTE_ACTIVE_ID__ === 'function')
                ? window.__GOURD_REMOTE_ACTIVE_ID__() : null;
            if (onlyActive) ids.push(onlyActive);
        }
        function pick(resp, scope) {
            var out = [];
            var list = (resp && resp.data) ? resp.data : [];
            var label = remoteHostLabel(scope);   // 本地 scope 返回空串
            for (var i = 0; i < list.length; i++) {
                if (list[i] && list[i].path) {
                    var e = list[i];
                    e._scope = scope;
                    /* 主机展示名（条目 title 的唯一区分线索）：同屏双源时用户靠它
                       知道这条属于哪台机器。_scope 只是内部键，不能直接展示。 */
                    if (label) e._scopeHost = label;
                    out.push(e);
                }
            }
            return out;
        }
        /* 每个在线连接一路补拉。形参名沿用 activeId：URL 拼装口径与旧单路版完全一致
           （__scope=id: + encodeURIComponent，冒号→%3A 由代理侧解码查表）。 */
        function fetchRemote(activeId) {
            return $.get('/web/chat/projects?__scope=id:' + encodeURIComponent(activeId));
        }
        /* 主拉取（本地那份，恒定）失败时【必须保持旧缓存原样、不得做合并】：否则
           陈旧缓存 + 新拉的远端项会拼出重复条目。这与改造前「失败时缓存保持旧值，
           按钮回退目录名」的语义一致。 */
        var primaryOk = false;
        var fetched = [];   // 主拉取的成功结果（拉到再写全局，避免中途读到半成品）
        var primary = $.get('/web/chat/projects?__scope=local');
        primary.done(function (resp) { primaryOk = true; fetched = pick(resp, 'local'); });
        if (!ids.length) {
            primary.always(function () {
                if (primaryOk) projectsCache = fetched;
                renderSelectors();
                if (typeof cb === 'function') cb(projectsCache);
            });
            return;
        }
        /* 有在线连接：每台各补拉一路（某路失败只少那台的条目，不破坏本地与其它连接）。
           请求在循环里一次性发出，真并发而不是串行等待——扇出的意义就在于此。 */
        var remotes = [];
        for (var ri = 0; ri < ids.length; ri++) {
            remotes.push({ id: ids[ri], req: fetchRemote(ids[ri]) });
        }
        var done = 0;
        /* 结算门槛动态化：pending = 本地主拉 1 路 + 每在线连接 1 路。
           WHY 不能写死 2：连 3 台时第 2 路就结算（丢第三台条目），只连 1 台时
           永远等不到第二次 always（下拉一直转圈）。 */
        var pending = 1 + remotes.length;
        function settle() {
            if (++done < pending) return;
            if (!primaryOk) {
                renderSelectors();
                if (typeof cb === 'function') cb(projectsCache);
                return;
            }
            projectsCache = fetched;
            /* 去重键 = 归一路径 + '@' + 归属：只在同一来源内合并重复路径 */
            var seen = Object.create(null);
            for (var k = 0; k < projectsCache.length; k++) {
                seen[pathKey(projectsCache[k].path) + '@' + (projectsCache[k]._scope || 'local')] = true;
            }
            var merged = [];
            for (var m = 0; m < remotes.length; m++) {
                var rid = remotes[m].id;
                var remoteList = [];
                try { remoteList = pick(remotes[m].req.responseJSON || {}, rid); } catch (e) { remoteList = []; }
                for (var n = 0; n < remoteList.length; n++) {
                    var ent = remoteList[n];
                    var rk = pathKey(ent.path) + '@' + (ent._scope || 'local');
                    if (seen[rk]) continue;   // 同一来源内路径重复（脏数据）才丢；
                                              // 跨来源同路径 = 两台机器上两个真实目录，必须并存
                    seen[rk] = true;
                    merged.push(ent);
                }
            }
            // 本地在前、远端在后（与「默认环境是本地」的心智一致）；远端各连接按 list() 顺序
            projectsCache = projectsCache.concat(merged);
            renderSelectors();
            /* 绑定自愈：当前选中项能查到【远端】_scope 才重声明（applyChatWorkspace
               内部幂等调 bindWorkspaceScope；路由表丢失/页面重载后不用等用户重点一次）。
               查不到（null）时【不动绑定】：兜底回落 activeId 会把 A 机目录改绑到
               刚连上的 B 机隧道（跨机误绑，UI 无提示），故这里 null 直接跳过。
               选本地/无选择不重声明：本地绑定本就幂等、无选择无 cwd，重声明只会多一次
               无意义的页面副作用（silent 也可能触发列表重拉）。 */
            if (window.currentChatWorkspace) {
                var scope = scopeOfPath(window.currentChatWorkspace);
                if (scope && scope !== 'local' && typeof window.applyChatWorkspace === 'function') {
                    try { window.applyChatWorkspace(window.currentChatWorkspace, true); } catch (e) {}
                }
            }
            if (typeof cb === 'function') cb(projectsCache);
        }
        primary.always(settle);
        for (var si = 0; si < remotes.length; si++) remotes[si].req.always(settle);
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

    /* 视口自适应定位：下方放不下设计高度且上方更宽裕时改为向上展开（drop-up），
       并动态限制弹窗高度，保证弹窗（含底部「打开文件夹」）始终完整落在窗口内、其余内容可滚动可达。
       修复1：下拉固定向下展开 340px，窗口矮时底部越出窗口被裁——滚动到底也看不到底部项。
       修复2：旧翻转门槛「下方<160px」过苛——欢迎页输入框位于窗口中下部，下方空间常为
       200~300px（够不到 340 却又超过 160）→ 永不翻转，弹窗被塞进窗口底部窄带贴边裁切，
       而上方大片空白浪费（用户实测截图即此形态）。门槛改与设计高度比较：
       下方放不下 DESIGN_MAX 且上方不比下方窄即翻转。*/
    function positionDropdown(selEl) {
        var cur = selEl.querySelector('.workspace-selector-current');
        var dd = selEl.querySelector('.workspace-dropdown');
        if (!cur || !dd) return;
        var GAP = 4;            // 弹窗与按钮的间距（CSS margin-top/bottom）
        var SAFE = 8;           // 距窗口边缘的安全间距
        var DESIGN_MAX = 340;   // 设计上限（与 CSS .project-dropdown 的 max-height 一致）
        var rect = cur.getBoundingClientRect();
        var vh = window.innerHeight || document.documentElement.clientHeight;
        /* 裁剪边界取真实宿主盒而非视口：弹窗是 .welcome-view（overflow-y:auto）的后代，
           向上越出其盒顶即不可达（滚动容器上方溢出不可滚），而桌面端盒顶还被 36px 标题栏下推；
           下边界为 welcome 盒底（80px 底 padding 属滚动视口、不裁剪）。会话模式选择器不在
           欢迎页内（无滚动容器祖先），边界退化为视口（body overflow:hidden）。 */
        var host = selEl.closest ? selEl.closest('.welcome-view') : null;
        var topBound = 0;
        var bottomBound = vh;
        if (host) {
            var hr = host.getBoundingClientRect();
            topBound = hr.top;
            bottomBound = hr.bottom;
        }
        var below = bottomBound - rect.bottom - GAP - SAFE;
        var above = rect.top - topBound - GAP - SAFE;
        /* 翻转条件：下方放不下设计高度（向下展开必然被压缩裁切）且上方不比下方窄
           （相等时偏好向上：欢迎页视觉重心偏上，上方空白更整）。下方放得下时保持向下，符合下拉直觉。*/
        var openUp = below < DESIGN_MAX && above >= below;
        var avail = openUp ? above : below;
        selEl.classList.toggle('drop-up', openUp);
        dd.style.maxHeight = Math.max(80, Math.min(DESIGN_MAX, avail)) + 'px';
    }

    /* 窗口尺寸变化：已打开的下拉重新定位（防止弹窗底部再次越出窗口） */
    window.addEventListener('resize', function () {
        var sels = document.querySelectorAll('.workspace-selector.open');
        for (var i = 0; i < sels.length; i++) positionDropdown(sels[i]);
    });

    /* 下拉列表与按钮显示名同源：统一走 loadProjects 刷新 projectsCache，
        避免「列表显示新名、收起来按钮又变旧名」的双数据源不一致。 */
    /* 是否连着远端（决定下拉是否展示「打开远程目录」入口）。
       WHY 改读连接表 list().length（契约 §2.8）：多连接下这个门控要回答的是「有没有
       在线连接」，而 activeId 只是「当前选中哪台」——用户选着本地工作区时它可能为 null，
       旧口径会把入口误隐（明明连着两台却看不到「打开远程目录」）。
       无 __GOURD_REMOTE__（浏览器/旧壳）时降级到 __GOURD_REMOTE_ACTIVE__，绝不抛错。 */
    function hasRemoteConnection() {
        var api = window.__GOURD_REMOTE__;
        if (api && typeof api.list === 'function') {
            try { return (api.list() || []).length > 0; } catch (e) { return false; }
        }
        return !!(typeof window.__GOURD_REMOTE_ACTIVE__ === 'function' && window.__GOURD_REMOTE_ACTIVE__());
    }

    /* 在线连接里挑一台（契约 §4.4）：多条弹选择层，仅 1 条由主代理内部直返不弹层
       （零额外点击）；rid=null 表示用户取消或无在线连接，调用方必须静默返回。
       取口顺序：window.__GOURD_REMOTE_PICK_CONN__（契约命名）→ __GOURD_REMOTE__.pickConnection
       （主代理在 app-remote.js 的实际暴露名）→ 降级取单 activeId（无壳/浏览器不炸）。 */
    function pickRemoteConn(cb) {
        if (typeof window.__GOURD_REMOTE_PICK_CONN__ === 'function') {
            window.__GOURD_REMOTE_PICK_CONN__(cb);
            return;
        }
        var api = window.__GOURD_REMOTE__;
        if (api && typeof api.pickConnection === 'function') {
            api.pickConnection(cb);
            return;
        }
        cb((typeof window.__GOURD_REMOTE_ACTIVE_ID__ === 'function')
            ? window.__GOURD_REMOTE_ACTIVE_ID__() : null);
    }

    /* 远程目录选择器：openDirPicker（app-code.js）+ 显式 scope 参数，强制浏览远端磁盘
       （browse 打到指定连接，列出远端目录；选出的路径与远端登记端点同机）。 */
    function openRemoteDirPicker(rid, onPicked) {
        window.openDirPicker(onPicked, '&__scope=id:' + encodeURIComponent(rid));
    }

    function renderDropdown(dd) {
        // 构建搜索框 + 列表容器结构
        var searchHtml = '<div class="workspace-search-box">'
            + '<svg class="workspace-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>'
            + '<input type="text" class="workspace-search-input" placeholder="' + esc(GourdI18n.t('app.chat_workspace.search_placeholder')) + '" autocomplete="off" spellcheck="false" />'
            + '</div>'
            + '<div class="workspace-list-container">'
            + '<div class="workspace-list-scroll"><div class="project-dropdown-empty">' + esc(GourdI18n.t('app.loading')) + '</div></div>'
            + '</div>'
            + '<div class="workspace-actions">'
            + '<button class="workspace-action-btn workspace-add-btn">'
            + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
            + '<span>' + esc(GourdI18n.t('code.open_folder')) + '</span>'
            + '</button>'
            + (hasRemoteConnection()
                ? '<button class="workspace-action-btn workspace-remote-open-btn">'
                    + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>'
                    + '<span>' + esc(GourdI18n.t('app.chat_workspace.open_remote_folder')) + '</span>'
                    + '</button>'
                : '')
            + '<button class="workspace-action-btn workspace-remote-btn">'
            + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>'
            + '<span>' + esc(GourdI18n.t('app.chat_workspace.remote_connect')) + '</span>'
            + '</button>'
            + '</div>';
        dd.innerHTML = searchHtml;
        pendingCandidates = null;   // 重开下拉即退出消歧态，避免残留候选误判后续点击
        /* 焦点纪元：innerHTML 重建会销毁聚焦中的元素（如删除按钮）并触发 focusout，
           该失焦不是用户离开下拉。纪元+1 后，重建前排队的 focusout 守卫见纪元不符即放弃关闭
           （插桩实证：删除后恢复 open 与重渲染同 tick，紧随的 focusout 守卫会把刚恢复的下拉关掉）。 */
        var epochSel = dd.closest('.workspace-selector');
        if (epochSel) epochSel._wsEpoch = (epochSel._wsEpoch || 0) + 1;

        var listScroll = dd.querySelector('.workspace-list-scroll');
        var searchInput = dd.querySelector('.workspace-search-input');

        loadProjects(function (list) {
            // 缓存完整列表到容器上，供搜索过滤使用
            dd._fullList = list;
            renderFilteredList(dd, list, '');
            /* 动作按钮区是 innerHTML 重建的，「连接中」指示器类名（is-connecting）会随
               重建丢失 → 向导收起期间重开下拉就看不到「有个连接在跑」。渲染完补刷一次
               （幂等；无 app-remote 时 typeof 守卫静默）。 */
            if (typeof window.refreshRemoteEntryIndicator === 'function') {
                try { window.refreshRemoteEntryIndicator(); } catch (e) {}
            }

            // 搜索框聚焦
            if (searchInput && typeof searchInput.focus === 'function') {
                setTimeout(function() { searchInput.focus(); }, 50);
            }
        });
    }

    /* 渲染过滤后的列表（搜索或初始加载） */
    function renderFilteredList(dd, list, keyword) {
        var listScroll = dd.querySelector('.workspace-list-scroll');
        if (!listScroll) return;

        if (!list.length) {
            listScroll.innerHTML = '<div class="project-dropdown-empty">' + esc(GourdI18n.t('code.no_projects')) + '</div>';
            return;
        }

        var def = defaultWorkspace();
        var defKey = def ? pathScopeKey(def) : '';   // 同 toSelection：不得无条件 lower
        var cur = window.currentChatWorkspace;
        var kw = (keyword || '').toLowerCase().trim();
        var html = '';
        var matchCount = 0;

        // 全局（默认工作区）不是可选项：不选即全局，列表不再展示该项
        for (var i = 0; i < list.length; i++) {
            var p = list[i];
            if (defKey && pathScopeKey(p.path) === defKey) continue;

            // 搜索过滤：匹配名称或路径
            if (kw) {
                var nameMatch = p.name.toLowerCase().indexOf(kw) >= 0;
                var pathMatch = p.path.toLowerCase().indexOf(kw) >= 0;
                if (!nameMatch && !pathMatch) continue;
            }

            matchCount++;
            /* 单行条目（图标+名称）：与搜索框同视觉量级，路径仅挂 title 悬停查看，
               双行（名称+整路径）会让条目高度约为搜索框两倍、比例失调（用户实测）。
               远端条目打 data-remote（CSS 小徽标识）+ title 附远端主机名（同屏
               双源时用户唯一的区分线索）。 */
            var isRemote = !!(p._scope && p._scope !== 'local');
            var itemTitle = p.path + (isRemote ? (' · ' + (p._scopeHost || GourdI18n.t('app.chat_workspace.remote_item'))) : '');
            html += '<div class="project-dropdown-item' + (p.path === cur ? ' active' : '') + '" data-path="' + esc(p.path) + '"' + (isRemote ? ' data-remote="1"' : '') + ' title="' + esc(itemTitle) + '">'
                + '<svg class="workspace-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
                + '<div class="project-dropdown-item-info">'
                + '<div class="project-dropdown-item-name">' + esc(p.name) + '</div>'
                + '</div>'
                + '<button class="project-dropdown-item-del" data-path="' + esc(p.path) + '">'
                + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
                + '</button>'
                + '</div>';
        }

        if (matchCount === 0) {
            listScroll.innerHTML = '<div class="project-dropdown-empty">' + esc(GourdI18n.t('app.chat_workspace.search_no_results')) + '</div>';
        } else {
            listScroll.innerHTML = html;
        }
    }

    /* ================= 系统原生文件夹选择 =================
       「打开文件夹」不再以自绘的服务端目录浏览器（window.openDirPicker）为主路径：
       桌面端走 IPC 原生对话框（直接给绝对路径）；浏览器端走 <input webkitdirectory>——
       它唤起的同样是操作系统原生文件夹选择框，且【不弹任何站点权限提示】。
       刻意不用 File System Access API（showDirectoryPicker）：Chromium 在它之前会先弹
       「允许此网站查看和复制文件？」权限条（用户实测反感），且非用户手势链路上还可能被静默拦截。
       浏览器拿不到绝对路径（安全边界），故把「目录名 + 含文件的子目录名指纹」交给同机后端
       POST /web/chat/projects/locate 反查绝对路径（登记表中已有则阶段一直接命中，免扫描）。
       降级链：IPC 原生对话框 → webkitdirectory → 后端定位失败时退回旧自绘浏览器（finalFallback）→ 提示失败。 */

    /* 同名目录消歧候选：locate 返回多条时暂存，等用户在下拉里点选后再登记 */
    var pendingCandidates = null;

    /* 请求后端按「目录名 + 子目录指纹」定位绝对路径。
       失败一律 resolve(null) 而不 reject：调用方据此走降级链，避免未捕获的 rejection。

       【必须显式 __scope=local】本链只服务「打开文件夹」按钮，而它的语义是
       本地恒为主路径（注释见 pickSystemFolder）：浏览器选的是本机目录，指纹只能
       由本机磁盘反查。不声明就会落激活兑底——选中远端工作区后去远端扫盘，
       用本机目录名在远端定位出一个同名目录并登记（跳机登记）。 */
    function locateFolder(name, children) {
        return new Promise(function (resolve) {
            $.ajax({
                url: '/web/chat/projects/locate?__scope=local', method: 'POST', contentType: 'application/json',
                data: JSON.stringify({ name: name, children: children })
            }).done(function (resp) {
                var c = (resp && resp.data && resp.data.candidates) ? resp.data.candidates : null;
                resolve(c);
            }).fail(function () {
                resolve(null);
            });
        });
    }

    /* 浏览器主路径选择器：<input webkitdirectory> 唤起系统原生文件夹选择框（无权限提示），
       再从返回文件的相对路径反推根目录名与「根下含文件的子目录名」指纹。
       注意空子目录不会出现在文件列表里 → 指纹天然是实际指纹的子集，后端 isMatch 用子集语义容忍。 */
    function fallbackInputPicker(onPicked) {
        var input = document.createElement('input');
        input.type = 'file';
        input.style.display = 'none';
        input.setAttribute('webkitdirectory', '');
        input.setAttribute('directory', '');
        input.multiple = true;
        input.addEventListener('change', function () {
            var files = input.files;
            var root = '';
            var children = [];
            var seen = {};
            if (files && files.length) {
                root = String(files[0].webkitRelativePath || '').split('/')[0] || '';
                for (var i = 0; i < files.length; i++) {
                    var seg = String(files[i].webkitRelativePath || '').split('/');
                    if (seg.length > 2) {   // 根/子目录/…：seg[1] 才是根下子目录名
                        var d = seg[1];
                        if (d && d.charAt(0) !== '.' && !seen[d]) { seen[d] = true; children.push(d); }
                    }
                }
            }
            if (input.parentNode) input.parentNode.removeChild(input);
            if (!files || !files.length) return;   // 用户取消：静默返回，不打扰
            locateAndFinish(root, children, onPicked);
        });
        document.body.appendChild(input);
        input.click();
    }

    /* 渲染同名目录消歧列表：条目结构与 renderFilteredList 一致（不带删除按钮，因为这些路径尚未登记），
       顶部加一条说明；同时清空 _fullList，防止搜索框输入事件用旧的项目列表覆盖掉消歧结果。 */
    function renderCandidateList(dd, candidates) {
        var listScroll = dd.querySelector('.workspace-list-scroll');
        if (!listScroll) return;
        dd._fullList = null;
        var html = '<div class="project-dropdown-empty">' + esc(GourdI18n.t('app.chat_workspace.locate_multiple')) + '</div>';
        for (var i = 0; i < candidates.length; i++) {
            var c = candidates[i];
            html += '<div class="project-dropdown-item" data-path="' + esc(c) + '">'
                + '<div class="project-dropdown-item-info">'
                + '<div class="project-dropdown-item-name">' + esc(baseName(c)) + '</div>'
                + '<div class="project-dropdown-item-path">' + esc(c) + '</div>'
                + '</div>'
                + '</div>';
        }
        listScroll.innerHTML = html;
    }

    /* 定位结果分流：唯一命中直接回调；多命中重开下拉做消歧；零命中/请求失败走最终兜底。 */
    function locateAndFinish(name, children, onPicked) {
        locateFolder(name, children).then(function (candidates) {
            if (candidates === null) { finalFallback(onPicked); return; }
            if (candidates.length === 1) { onPicked(candidates[0]); return; }
            if (candidates.length >= 2) {
                pendingCandidates = candidates;
                /* 选择器为欢迎页单实例，点「打开文件夹」时已 closeAll，但弹窗 DOM 结构仍在，
                   恢复 open 态后直接覆盖列表区即可；找不到宿主时才退回兜底。 */
                var sel = document.querySelector('.workspace-selector');
                var dd = sel ? sel.querySelector('.workspace-dropdown') : null;
                if (sel && dd) {
                    sel.classList.add('open');
                    positionDropdown(sel);
                    renderCandidateList(dd, candidates);
                } else {
                    finalFallback(onPicked);
                }
                return;
            }
            finalFallback(onPicked);   // 扫描无命中（目录在忽略清单内 / 磁盘已移除）
        }, function () {
            finalFallback(onPicked);
        });
    }

    /* 最终安全网：后端定位不可用时退回旧自绘目录浏览器（若仍加载），否则只提示失败。 */
    function finalFallback(onPicked) {
        if (typeof window.openDirPicker === 'function') { window.openDirPicker(onPicked); return; }
        if (typeof showToast === 'function') showToast(GourdI18n.t('code.dir_access_failed'), 'error');
    }

    /* 主入口：桌面端 IPC 原生对话框（直接给绝对路径）→ 浏览器 webkitdirectory 系统选择框。
       用户主动取消一律静默返回（不提示、不降级）。
       不再走 showDirectoryPicker：Chromium 会先弹「允许此网站查看和复制文件？」权限条（用户实测反感）。

       【本地恒为主路径（并存语义）】不论连没连远端，这个按钮永远打开本机对话框、
       选本机目录——本地环境的添加入口不因远程连接而改变（正是「远程覆盖本地」
       投诉的反面：选远程目录有专属入口 renderDropdown 的 workspace-remote-btn，
       走服务端浏览器浏览远端磁盘）。登记端点 /web/chat/projects/add 会带
       X-Session-Cwd？不——登记无 cwd，走激活 scope；但这里选出的路径是本地路径，
       若激活指向远端就会登记失败（远端无此路径）。故对齐：本地登记走显式本地通道
       —— 登记请求带上 __scope=local（代理强制本地），登记完从 _scope 标记为 local。 */
    function pickSystemFolder(onPicked) {
        if (window.__GOURD_IPC__ && typeof window.__GOURD_IPC__.pickDirectory === 'function') {
            Promise.resolve(window.__GOURD_IPC__.pickDirectory()).then(function (p) {
                if (typeof p === 'string' && p) onPicked(p);
            }, function () { /* 取消或 IPC 异常：静默 */ });
            return;
        }
        fallbackInputPicker(onPicked);
    }

    /* 把工作区归属告知桌面壳（按工作区分流，方案 §十二）：这个目录属于本地还是当前远端连接。
       为什么必需：代理看到带 X-Session-Cwd 的请求无法从路径形状判断归属，而两个方向猜错
       都会坏：远端目录误回本地（本地无此路径 → 创建/发消息失败）；本地目录误给远端
       （跳机读写，更危险）。「这个列表是从哪个后端拉的」只有前端确定，故由前端声明。
       浏览器端（无 IPC）与未装新壳（无 remoteBindScope）静默降级：行为退回「未分流」，
       即整机切换语义（与改造前一致），不会报错也不会路由错。

       【为何可以一律给「激活环境」而不会误绑本地目录】本不变量依赖一个事实：
       无 cwd 的列表类请求（/web/chat/projects）同样走激活 scope。于是下拉里能看到的
       每个条目，必然来自当前激活环境——选它就绑它，不存在「连着远端却从列表里
       选出一个本地目录」（远程态下 openDirPicker 浏览的也是远端磁盘）。
        【归属从哪来】不是「一律给激活环境」：合并列表后同一屏里同时有本地与远端条目，
        给激活环境会把本地条目误绑到远端（跳机读写）。每个条目在 loadProjects 里带了
        _scope（这条记录来自哪个后端就是哪个，是确定事实），绑定时按路径查回。
        查不到（刚登记的新目录 / 非登记项）一律返回 **null**：调用方按 local 处理。
        WHY 不再兜底 activeId：多连接下 activeId 只是「当前选中的那台」，与待查目录的
        归属无关——连上第二台 B 后，若 A 机目录的条目不在缓存里（列表尚未扇出/拉取失败），
        旧兜底会把 A 机目录判成 B，随后 bind_scope 把 A 的 cwd 改绑到 B 的隧道
        （跨机读写，且 UI 全程无提示）。返回 null 让调用方保守地当本地：宁可少绑
        也不能跳机绑；真需要绑定新登记目录时，登记分支会先往缓存补一条带 _scope 的
        临时记录（见 projects/add 两处分支），查得到就不会落到这里。
        断开路径同理：doDisconnect 按 id 摘除连接后列表重拉，归属查不到即回本地。*/
    /* 登记一个【刚新增】的目录到 projectsCache，带明确归属（scopeId：'local' 或 connectionId）。
       WHY 必需：add 请求成功后紧接着就 selectChatWorkspace → scopeOfPath 查归属，而
       notifyProjectsChanged 触发的重拉是【异步】的，此刻缓存里还没有这条 → 查到 null。
       虽然 null 会被调用方按 local 处理（不再跳机），但补临时记录能让归属成为【确定事实】
       而不是靠兜底推出来的；且列表渲染（title 主机名）与后续删除的归属也依赖条目在缓存里。
       远端目录尤其不能省：两台同时在线时 scopeId 必须是【选定那台】而非 activeId，
       写错会让该目录后续读写跳到另一台机器（本仓已修过同款缺陷两处）。
       幂等：同路径已有记录则更新 _scope（重拉竞态下可能出现重复 push）。 */
    function registerProjectScope(path, scopeId) {
        if (!path) return;
        var pk = pathKey(path);
        var scope = (scopeId && scopeId !== 'local') ? scopeId : 'local';
        if (!Array.isArray(projectsCache)) return;
        for (var i = 0; i < projectsCache.length; i++) {
            var p = projectsCache[i];
            if (p && pathKey(p.path) === pk) { p._scope = scope; return; }
        }
        projectsCache.push({ path: path, name: baseName(path), _scope: scope });
    }
    /* app-remote.js 的一体化向导（选定远端目录后登记）与本模块的「打开远程目录」分支
       共用此入口：两个模块各有 projectsCache 副本是不可能的（本模块是唯一持有者），
       故必须经 window 暴露。 */
    window.__gourdRegisterRemoteProject = function (path, scopeId) {
        try { registerProjectScope(path, scopeId); } catch (e) { /* 静默：不得阻断选择 */ }
    };

    function scopeOfPath(path) {
        var pk = pathKey(path);
        for (var i = 0; i < projectsCache.length; i++) {
            var p = projectsCache[i];
            if (p && pathKey(p.path) === pk && p._scope) return p._scope;
        }
        return null;   // 查不到归属：调用方按 local 处理（与 strictScopeOfPath 口径统一）
    }

    /* 当前选中 chat 工作区的归属连接 id（'local'|connectionId|null）。
       暴露给 app-remote：断开/探活失败时判断「用户选着的工作区是否归属被断连接」，
       多连接下选着 A 的工作区时断 B 不得误清 A 的选择（旧语义靠 __lastRemoteWorkspace
       布尔记忆做不到精确归属）。
       WHY 返回 'local' 而不是 null：scopeOfPath 现在查不到归属返回 null（契约 §4.2），
       而本函数回答的是「这个选择算不算某台远端的」——null 与 'local' 在这里同义，
       归一为 'local' 让调用方只需做一次「=== 被断 id」比较，也不会把未登记目录误判成远端。 */
    window.__currentChatWorkspaceScope = function () {
        var sel = window.currentChatWorkspace;
        if (!sel) return null;
        var sc = scopeOfPath(sel);
        return sc || 'local';
    };

    /* 写操作的归属声明（与 scopeOfPath 分开）：查不到时回【本地】而非激活环境。
       删除/新增/重命名都是写操作，拿激活环境兑底会把本地条目的写打到远端（误删
       远端登记/远端无此路径而建失败）。待删的条目必定在 projectsCache 里（下拉
       就渲染自它），故回本地只可能在异常态出现——宁可少删不可错删。 */
    function strictScopeOfPath(path) {
        var pk = pathKey(path);
        for (var i = 0; i < projectsCache.length; i++) {
            var p = projectsCache[i];
            if (p && pathKey(p.path) === pk && p._scope) {
                return (p._scope !== 'local') ? p._scope : 'local';
            }
        }
        return 'local';
    }

    /* 归属 → 路由 query（与 app-code.scopeQueryFor / app-history.projScopeQuery 同口径）：
       写操作一律显式声明，不声明就落到代理的激活兑底（随选择漂移）。 */
    function scopeQueryOf(path) {
        var s = strictScopeOfPath(path);
        return (s && s !== 'local')
            ? '?__scope=id:' + encodeURIComponent(s)
            : '?__scope=local';
    }

    /* 归属声明（bind_scope 用）：scopeOfPath 现在查不到返回 null，此处按 local 处理
       （id=null 在 Rust 侧即「解绑回本地」）。null 不得被当成某个连接 id 传给壳——
       那正是跨机误绑的形态。 */
    function bindWorkspaceScope(path) {
        var ipc = window.__GOURD_IPC__;
        if (!ipc || typeof ipc.remoteBindScope !== 'function') return;
        /* 空选择（回全局区）无需登记：代理对无 cwd 请求走激活 scope，本就正确 */
        if (!path) return;
        var id = scopeOfPath(path);
        /* null（查不到归属）与 'local' 一律归一为 null：宁可按本地解绑，也不把
           「当前选中的那台连接」当归属（多连接下它可能是另一台机器） */
        if (!id || id === 'local') id = null;
        try {
            Promise.resolve(ipc.remoteBindScope(path || '', id)).then(function (ok) {
                /* false = 声明的 connectionId 未登记（连接刚掉）：不静默吞掉，
                   否则用户会拿到「目录存在但发消息必败」这种最难查的失败形态 */
                if (ok === false && id && typeof showToast === 'function') {
                    showToast(GourdI18n.t('remote.scope_bind_failed'), 'error');
                }
            }, function () { /* IPC 异常：静默（不阻断选择） */ });
        } catch (e) { /* 静默 */ }
    }

    /* 切换 chat 工作空间。silent=true 仅同步状态与 UI（恢复历史会话时用），
       否则回欢迎页开新会话 + 重载侧栏列表（仿 code 模式 selectProject 语义）。 */
    function selectChatWorkspace(path, silent) {
        var sel = toSelection(path);
        closeAll();
        /* 归属声明先于任何带 X-Session-Cwd 的请求（下面的事件广播会触发拉取） */
        bindWorkspaceScope(sel);
        /* 【activeId 同步（自查 P2）】选中远端工作区 = 前端「当前环境」切到该连接、
           选本地/清空 = 回 null。与 Rust 侧 bind_scope 置位 RemoteRoute.active 同步：
           不同步则 remoteActiveOutcome/旧壳降级读口（pickRemoteConn / loadProjects
           的 ACTIVE_ID 兜底）拿到的是启动时的旧值。旧 app-remote 无此入口时静默跳过。 */
        if (typeof window.__GOURD_REMOTE_SET_ACTIVE__ === 'function') {
            try {
                var actScope = sel ? scopeOfPath(sel) : null;
                window.__GOURD_REMOTE_SET_ACTIVE__((actScope && actScope !== 'local') ? actScope : null);
            } catch (e) {}
        }
        /* 远端选择记忆（app-remote 断开/探活失败回位用）：选中远端工作区时记下，
            选回本地/清空时释放。经 window 暴露（app-remote 闭包内读不到本模块变量）。 */
        try {
            var selScope = sel ? scopeOfPath(sel) : null;
            if (selScope && selScope !== 'local') {
                window.__lastRemoteWorkspace = sel;
            } else {
                window.__lastRemoteWorkspace = null;
            }
        } catch (e) {}
        if (sel !== window.currentChatWorkspace) {
            var previous = window.currentChatWorkspace;
            window.currentChatWorkspace = sel;
            /* 长连接跟着换上游：/web/gate 已按 ?cwd= 分流，工作区变了而不重连就会
               出现「HTTP 打到新环境、事件流仍在旧环境」的跳机聊。必须在
               currentChatWorkspace 赋值之后调（否则 gate 带的是旧 cwd）。
               connectWebGate 自带旧连接退役，可重复调用。 */
            if (typeof window.connectWebGate === 'function') {
                try { window.connectWebGate(); } catch (e) {}
            }
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
                positionDropdown(selEl);
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
                /* 删除是「管理列表」动作而非「做出选择」：下拉必须保持打开、仅刷新列表。
                   但删除按钮是可聚焦 <button>，mousedown 聚焦它会使搜索框 focusout，
                   focusout 守卫在 ajax 返回前就把下拉关了（用户实测「点删除整个框关闭」）。
                   故点击时记下 open 态，ajax 完成后恢复 open 再重渲染。 */
                var delSel = del.closest('.workspace-selector');
                var delWasOpen = !!(delSel && delSel.classList.contains('open'));
                var dd = del.closest('.workspace-dropdown');
                $.ajax({
                    /* 归属按这条记录自己的 _scope 声明（查不到才回落 scopeOfPath）：
                       不带 __scope 就落到代理的激活兑底——选中远端工作区后删本地条目
                       会打到远端（远端登记被误删、本地那条还在，看着像“删不掉”）。 */
                    url: '/web/chat/projects/remove' + scopeQueryOf(delPath),
                    method: 'POST', contentType: 'application/json',
                    data: JSON.stringify({ path: delPath })
                }).always(function () {
                    if (typeof window.notifyProjectsChanged === 'function') window.notifyProjectsChanged(); // 移除登记：同步其它持有项目列表的视图
                    /* 删的是当前选中项：先复位选择（其内部 closeAll 会关下拉），
                       随后统一恢复 open——保证「删除任意项下拉都保持打开」。 */
                    if (window.currentChatWorkspace === delPath) selectChatWorkspace('', true);
                    if (dd && delWasOpen && delSel) {
                        delSel.classList.add('open');
                        positionDropdown(delSel);
                        renderDropdown(dd);
                    }
                });
            }
            return;
        }

        var add = t.closest('.workspace-dropdown .workspace-add-btn');
        if (add) {
            closeAll();
            /* 本地添加（并存语义）：本机对话框选本机目录，登记请求带 __scope=local
               强制打到本地后端（激活 scope 可能指向远端，不带就会去远端校验本地路径
               → 必然失败）。选中时 _scope 查不到（刚登记还没重拉）——scopeOfPath
               现在回 null，调用方按 local 处理，方向恰好正确；但列表渲染（title 主机名）
               与后续删除的归属仍需要条目在缓存里，故登记成功后先补一条
               _scope=local 的临时记录，选中与渲染立即拿到确定归属（不靠任何兜底）。 */
            pickSystemFolder(function (picked) {
                $.ajax({
                    url: '/web/chat/projects/add?__scope=local', method: 'POST', contentType: 'application/json',
                    data: JSON.stringify({ path: picked })
                }).done(function (resp) {
                    /* Solon Result：失败也回 HTTP 200，业务码在 body.code。不校验就会
                       静默选中一个后端不存在的路径 */
                    if (resp && resp.code !== 200) {
                        if (typeof showToast === 'function') showToast(GourdI18n.t('code.add_failed_no_dir'), 'error');
                        return;
                    }
                    /* 新登记的本地路径：补临时 _scope=local（缓存重拉前的过渡记录，
                       让紧接着的 selectChatWorkspace → scopeOfPath 查到正确归属） */
                    projectsCache.push({ path: picked, name: picked.split(/[\\/]/).pop() || picked, _scope: 'local' });
                    if (typeof window.notifyProjectsChanged === 'function') window.notifyProjectsChanged(); // 新增登记：同步记忆页/自动化等持有项目列表的视图
                    selectChatWorkspace(picked);
                }).fail(function () {
                    if (typeof showToast === 'function') showToast(GourdI18n.t('code.dir_access_failed'), 'error');
                });
            });
            return;
        }

        var remoteOpen = t.closest('.workspace-dropdown .workspace-remote-open-btn');
        if (remoteOpen) {
            closeAll();
            /* 打开远程目录（并存语义专属入口）：先挑连接，再 openRemoteDirPicker → openDirPicker
               （带 __scope=id:<选定连接>），browse 强制打到那台远端列出磁盘，
               选出的路径与登记端点（同样带 scope）同机，语义闭合。
               WHY 不再写死 activeId（契约 §4.4）：连两台时 activeId 只是「当前选中的那台」，
               用户想往另一台登记目录就只能先切工作区（或断开重连）——入口必须先问「哪一台」。
               无在线连接时按钮本就不渲染（hasRemoteConnection 门控）。 */
            if (typeof window.openDirPicker !== 'function') {
                if (typeof showToast === 'function') showToast(GourdI18n.t('remote.unsupported'), 'error');
                return;
            }
            pickRemoteConn(function (rid) {
                if (!rid) return;   // 用户取消（或无在线连接）：静默，不打扰
                openRemoteDirPicker(rid, function (picked) {
                    $.ajax({
                        url: '/web/chat/projects/add?__scope=id:' + encodeURIComponent(rid), method: 'POST', contentType: 'application/json',
                        data: JSON.stringify({ path: picked })
                    }).done(function (resp) {
                        if (resp && resp.code !== 200) {
                            if (typeof showToast === 'function') showToast(GourdI18n.t('code.add_failed_no_dir'), 'error');
                            return;
                        }
                        /* 新登记的远端路径：补临时 _scope（同 add 分支理由，防选中时误绑）。
                           _scope 必须是【选定的那台 rid】而不是 activeId：两台同时在线时二者
                           不同，写错就会把该目录后续读写跳到另一台机器。
                           改走 registerProjectScope：与一体化向导（app-remote.finishWizardWithDir）
                           共用同一实现，避免两处内联 push 日后漂移（含 name 计算口径不一致）。 */
                        registerProjectScope(picked, rid);
                        if (typeof window.notifyProjectsChanged === 'function') window.notifyProjectsChanged();
                        selectChatWorkspace(picked);
                    }).fail(function () {
                        if (typeof showToast === 'function') showToast(GourdI18n.t('code.dir_access_failed'), 'error');
                    });
                });
            });
            return;
        }

        var item = t.closest('.workspace-dropdown .project-dropdown-item');
        if (item) {
            var p = item.getAttribute('data-path') || '';
            /* 消歧列表命中：该路径尚未登记，先登记再选中（与 add-btn 同一 ajax 结构） */
            if (pendingCandidates && pendingCandidates.indexOf(p) >= 0) {
                pendingCandidates = null;
                $.ajax({
                    /* 消歧候选来自 locateFolder（已强制本地），故登记也必须回本地：
                       不声明就落激活兑底，会把本机路径登记到远端（远端无此路径）。 */
                    url: '/web/chat/projects/add?__scope=local', method: 'POST', contentType: 'application/json',
                    data: JSON.stringify({ path: p })
                }).done(function (resp) {
                    /* 与 add-btn 分支同一口径校 body.code（P2 补完）：Solon 的失败也是
                       HTTP 200 + body.code=400，不校就会静默选中一个不存在的路径。
                       消歧候选来自刚刚扫盘结果，远端把它删掉的窗口极窄但仍存在
                       （远程模式下这个窗口更大：本地扫描根本看不到远端磁盘）。 */
                    if (resp && resp.code !== 200) {
                        if (typeof showToast === 'function') showToast(GourdI18n.t('code.add_failed_no_dir'), 'error');
                        return;
                    }
                     /* 同 add-btn 分支：必须补临时 _scope=local。notifyProjectsChanged
                        触发的重拉是异步的，而下一行的 selectChatWorkspace → scopeOfPath
                        查的是【旧缓存】（还没有这条）。旧实现在这里会回落激活环境，
                        「激活=远端」时把本地新目录误绑到远端（后续读写全跳机）；
                        现在 scopeOfPath 回 null（按 local）不再跳机，但补临时记录仍是
                        必需：它让归属成为【确定事实】而不是靠兜底推出来的本地。
                        这里与 add-btn 是同一条缺陷的两个副本，修一处必须修两处。 */
                    if (projectsCache && projectsCache.push) {
                        projectsCache.push({ path: p, name: baseName(p), _scope: 'local' });
                    }
                    if (typeof window.notifyProjectsChanged === 'function') window.notifyProjectsChanged(); // 新增登记：同步记忆页/自动化等持有项目列表的视图
                    selectChatWorkspace(p);
                }).fail(function () {
                    if (typeof showToast === 'function') showToast(GourdI18n.t('code.dir_access_failed'), 'error');
                });
                return;
            }
            selectChatWorkspace(p);
            return;
        }

        if (!t.closest('.workspace-selector')) closeAll();
    });

    /* 搜索框输入事件（实时过滤） */
    document.addEventListener('input', function (e) {
        var searchInput = e.target;
        if (!searchInput.classList.contains('workspace-search-input')) return;

        var dd = searchInput.closest('.workspace-dropdown');
        if (!dd || !dd._fullList) return;

        var keyword = searchInput.value;
        renderFilteredList(dd, dd._fullList, keyword);
    });

    /* 搜索框键盘事件：阻止冒泡避免触发其他快捷键；Escape 关闭下拉（下拉类控件通用预期） */
    document.addEventListener('keydown', function (e) {
        var searchInput = e.target;
        if (!searchInput.classList.contains('workspace-search-input')) return;
        e.stopPropagation();
        if (e.key === 'Escape') {
            e.preventDefault();
            closeAll();
        }
    });

    /* 指针按压守卫：列表项/操作按钮多为不可聚焦元素，鼠标在它们上面按下时搜索框会先
       focusout；若 focusout 守卫在 setTimeout(0) 里关下拉，mouseup/click 时刻列表项 DOM
       已消失 → click 落到 underlying 页面（实测落到 welcome-view），「点列表项没反应」。
       故 mousedown 落在选择器内时记账，该窗口内 focusout 守卫不得关闭；mouseup 清账。
       键盘 Tab 离开不经过 mousedown，仍由 focusout 守卫正常关闭。 */
    var pointerDownInside = false;
    document.addEventListener('mousedown', function (e) {
        pointerDownInside = !!(e.target && e.target.closest && e.target.closest('.workspace-selector'));
    }, true);
    document.addEventListener('mouseup', function () { pointerDownInside = false; }, true);

    /* 焦点离开下拉即关闭：键盘用户 Tab 走后即视为结束操作。
       刻意不用 blur 即时关：点「打开文件夹」会先 blur 搜索框再弹系统对话框，
       若 blur 即关，多候选消歧列表（locateAndFinish 恢复 open）会被自己的 blur 关掉。 */
    document.addEventListener('focusout', function (e) {
        var sel = e.target && e.target.closest ? e.target.closest('.workspace-selector') : null;
        if (!sel || !sel.classList.contains('open')) return;
        /* 焦点因元素被移出 DOM 而丢失（如重渲染删掉了聚焦中的删除按钮）不是用户离开，
           不得据此关闭下拉——否则删除后的重渲染会被自己的 focusout 关掉（用户实测）。 */
        if (e.target.isConnected === false) return;
        var epoch = sel._wsEpoch || 0;
        setTimeout(function () {
            if (!sel.classList.contains('open')) return;
            if ((sel._wsEpoch || 0) !== epoch) return;   // 期间重建过列表 DOM：失焦是自伤的，不关
            if (pointerDownInside) return;   // 指针正按在选择器内：等 click 落定再说
            if (sel.contains(document.activeElement)) return;
            closeAll();
        }, 0);
    });

    function boot() {
        // meta 就绪后把选择态归一（默认工作区路径 → ''）并渲染
        window.currentChatWorkspace = toSelection(window.currentChatWorkspace);
        persist();
        renderSelectors(); // 先用回退名即时上屏，避免白屏/闪空
        // 选了工作空间时预拉登记列表，把按钮文案换成登记名（不选时文案恒为「选择项目」，无需请求）
        if (window.currentChatWorkspace) loadProjects();
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

    /* 项目登记表变更（侧栏重命名 / 新增 / 移除 / 新建）：重拉缓存并刷新按钮显示名，
       使欢迎页无需刷新页面即可跟上新名字。 */
    document.addEventListener('projects:changed', function () { loadProjects(); });

    /* 语言切换后重渲染选择器文案 */
    document.addEventListener('i18n:localeChanged', function () { renderSelectors(); });
})();
