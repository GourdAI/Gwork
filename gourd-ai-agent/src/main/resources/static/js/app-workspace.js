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

    /* 路径比较键：Windows 盘符路径大小写不敏感且分隔符可混用，与 app-memory.js pathKey 同口径 */
    function pathKey(p) {
        var t = trimTrail(String(p == null ? '' : p));
        var win = /^[a-zA-Z]:[\\/]/.test(t) || /^[\\/]{2}[^\\/]/.test(t);
        return win ? t.replace(/\//g, '\\').toLowerCase() : t;
    }

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

    /* 拉取登记项目列表并刷新缓存；成功/失败都回调（失败时缓存保持旧值，按钮回退目录名） */
    function loadProjects(cb) {
        $.get('/web/chat/projects', function (resp) {
            var list = (resp && resp.data) ? resp.data : [];
            projectsCache = [];
            for (var i = 0; i < list.length; i++) {
                if (list[i] && list[i].path) projectsCache.push(list[i]);
            }
        }).always(function () {
            renderSelectors();
            if (typeof cb === 'function') cb(projectsCache);
        });
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
            + '<button class="workspace-action-btn workspace-remote-btn" disabled>'
            + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v6m0 6v6M5.64 5.64l4.24 4.24m4.24 4.24l4.24 4.24M1 12h6m6 0h6M5.64 18.36l4.24-4.24m4.24-4.24l4.24-4.24"/></svg>'
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
        var defKey = trimTrail(def).toLowerCase();
        var cur = window.currentChatWorkspace;
        var kw = (keyword || '').toLowerCase().trim();
        var html = '';
        var matchCount = 0;

        // 全局（默认工作区）不是可选项：不选即全局，列表不再展示该项
        for (var i = 0; i < list.length; i++) {
            var p = list[i];
            if (defKey && trimTrail(p.path).toLowerCase() === defKey) continue;

            // 搜索过滤：匹配名称或路径
            if (kw) {
                var nameMatch = p.name.toLowerCase().indexOf(kw) >= 0;
                var pathMatch = p.path.toLowerCase().indexOf(kw) >= 0;
                if (!nameMatch && !pathMatch) continue;
            }

            matchCount++;
            /* 单行条目（图标+名称）：与搜索框同视觉量级，路径仅挂 title 悬停查看，
               双行（名称+整路径）会让条目高度约为搜索框两倍、比例失调（用户实测）。 */
            html += '<div class="project-dropdown-item' + (p.path === cur ? ' active' : '') + '" data-path="' + esc(p.path) + '">'
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
       失败一律 resolve(null) 而不 reject：调用方据此走降级链，避免未捕获的 rejection。 */
    function locateFolder(name, children) {
        return new Promise(function (resolve) {
            $.ajax({
                url: '/web/chat/projects/locate', method: 'POST', contentType: 'application/json',
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
       不再走 showDirectoryPicker：Chromium 会先弹「允许此网站查看和复制文件？」权限条（用户实测反感）。 */
    function pickSystemFolder(onPicked) {
        if (window.__GOURD_IPC__ && typeof window.__GOURD_IPC__.pickDirectory === 'function') {
            Promise.resolve(window.__GOURD_IPC__.pickDirectory()).then(function (p) {
                if (typeof p === 'string' && p) onPicked(p);
            }, function () { /* 取消或 IPC 异常：静默 */ });
            return;
        }
        fallbackInputPicker(onPicked);
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
                    url: '/web/chat/projects/remove', method: 'POST', contentType: 'application/json',
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
            /* 系统原生对话框为主路径；拿到绝对路径后的登记 + 选中逻辑与原 openDirPicker 回调一致 */
            pickSystemFolder(function (picked) {
                $.ajax({
                    url: '/web/chat/projects/add', method: 'POST', contentType: 'application/json',
                    data: JSON.stringify({ path: picked })
                }).done(function () {
                    if (typeof window.notifyProjectsChanged === 'function') window.notifyProjectsChanged(); // 新增登记：同步记忆页/自动化等持有项目列表的视图
                    selectChatWorkspace(picked);
                }).fail(function () {
                    if (typeof showToast === 'function') showToast(GourdI18n.t('code.dir_access_failed'), 'error');
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
                    url: '/web/chat/projects/add', method: 'POST', contentType: 'application/json',
                    data: JSON.stringify({ path: p })
                }).done(function () {
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
