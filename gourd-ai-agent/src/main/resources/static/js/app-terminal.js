/* ===== app-terminal.js =====
   全局本地终端：底部可切换的终端面板 + WebSocket 双向流（chat/code 等全视图可用），
   支持多实例（标签页）：每个 tab 一个独立 shell、独立输出缓冲与命令历史。
   依赖：app-base.js（window.currentProjectRoot / getSessionCwd）、jQuery（layui.$）。
   后端网关：/web/terminal（见 TerminalGate.java）。

   设计：
   - 常驻 shell 子进程由后端按连接维持，cd 等状态天然保留。
   - 多实例模型（参照 VSCode/Qoder 集成终端）：
     · 每个 tab 在【创建时】固定 cwd 与 scope（termCwd/termScopeKey 快照）。
       切项目/切会话不劫持已有 tab（一个 shell 一个工作目录是终端语义；
       要新 cwd 就新建 tab），避免正在跑的构建被静默换目录。
     · tab 的输出缓冲是 detached DOM 子树（tab.bufEl），切走不丢、不重建；
       切换只是把 bufEl + inEl 挂回 #codeTerminalBody。
     · 连接（shell 子进程）比 tab 贵：socket 池上限 TERM_POOL_MAX，超限按
       lastUsedAt LRU 回收【后台 tab】的连接（tab 与输出保留，切回懒重连）。
     · 关闭 tab 时若 shell 仍连接需 confirm（子进程随连接终止，防误杀长任务）；
       关闭最后一个 tab = 关闭面板。面板隐藏只断连、不丢 tab（重开即回现场）。
   - 命令输入走单行 input（回车发送），支持 ↑↓ 历史（每 tab 独立）。
   - 入口：标题栏终端按钮（app-titlebar-actions.js）/ code 模式文件树顶栏 / Ctrl+`。
   - 面板 markup 在 index.html 的 body 级 fixed 底栏（全局化，不再随 code 视图生灭）。
   - cwd 归属：code 模式用项目根；chat 模式用会话工作区根（getSessionCwd）；
     两者皆空（全局区新会话）用 ''，后端回退默认工作区。 */
(function () {
    'use strict';

    var LS_OPEN = 'code-terminal-open';
    var LS_HEIGHT = 'code-terminal-height';
    var TERM_MIN_HEIGHT = 120;
    var TERM_MAX_HEIGHT = 640;

    // ---------- DOM ----------
    var pane = document.getElementById('codeTerminalPane');
    var handle = document.getElementById('codeTerminalResizeHandle');
    var body = document.getElementById('codeTerminalBody');
    var tabsEl = document.getElementById('codeTerminalTabs');
    var newBtn = document.getElementById('codeTerminalNewBtn');
    var clearBtn = document.getElementById('codeTerminalClearBtn');
    var restartBtn = document.getElementById('codeTerminalRestartBtn');
    var closeBtn = document.getElementById('codeTerminalCloseBtn');
    var filerTerminalBtn = document.getElementById('filerTerminalBtn');

    if (!pane) return; // index.html 片段未注入则跳过

    // ---------- 状态 ----------
    /* tab 列表：[{id, name, cwd, scopeKey, socket, connected, dead,
                   bufEl, inEl, history, historyIdx, pendingDraft, restartToken,
                   bannerSeen, lastUsedAt}]
       socket 为 null 表示该 tab 当前无连接（未连/被回收/已断开），切回时懒重建。 */
    var tabs = [];
    var activeTab = null;
    var tabSeq = 0;
    var opened = false;

    /* 连接池上限：每条连接 = 一个常驻 shell 子进程（可能在远端机器上），
       不封顶就是逐次点「+」泄漏一批进程。超限回收后台 tab 的连接而非拒建新 tab
       （tab 本身很便宜：只是 DOM 缓冲）。 */
    var TERM_POOL_MAX = 4;
    /* tab 上限：防误连点产出几十个空壳标签（标签栏会挤成不可读的一条）。 */
    var TERM_MAX_TABS = 8;

    /* 终端回滚缓冲上限（单 tab 子节点个数）。
       输出区原本只追加不裁剪，跑一次 mvn build 就是数万个节点常驻，只能手动点「清空」释放。
       注：TERM_MAX_HEIGHT 是面板像素高度，与回滚量无关，不能当上限用。 */
    var TERM_MAX_NODES = 4000;

    // ---------- 归属（scope）----------
    /* 当前项目根属于哪个环境（'local' | 'id:<rid>'）。

       优先级：① app-code 已暴露的 __currentProjectScope（它就是 code 模式项目根的
       strict 归属口径，查不到返回 null）；② 'local'。

       WHY 不再回退到 app-workspace 的 scopeOfPath：那是个 IIFE 闭包内的私有函数，
       全仓从未挂到 window 上（导出面只有契约 §8 的 __currentChatWorkspaceScope），
       拿它当兜底恒为 undefined，只会把「查不到」伪装成「已查过且属本地」。

       为何不直接拿 __GOURD_REMOTE_ACTIVE_ID__()：它只回答「有没有连着远端」，
       而用户完全可能连着远端却在本地项目里开终端——拿它当归属会把本地命令
       打到远端机器上执行（比读错危险得多）。无壳/浏览器直开时 ① 拿不到，
       恒返回 'local' = 单桶 = 改造前的行为。 */
    function termScopeKey() {
        var root = window.currentProjectRoot || '';
        if (!root) return 'local';
        if (typeof window.__currentProjectScope === 'function') {
            var s = null;
            try { s = window.__currentProjectScope(); } catch (e) { s = null; }
            if (s && s !== 'local') return 'id:' + s;
            if (s === 'local') return 'local';
        }
        /* null（项目登记表未加载完/未登记项）：保守当本地。宁可在本地 shell 里
           少执行一条命令，也不能静默跑到远端机器上。 */
        return 'local';
    }

    function scopeQueryOf(scopeKey) {
        if (!scopeKey || scopeKey === 'local') return '';
        return '&__scope=id:' + encodeURIComponent(scopeKey.slice(3));
    }

    function remoteRegistry() {
        var r = window.__GOURD_REMOTE__;
        return (r && typeof r.list === 'function') ? r : null;
    }

    /* 该连接是否仍在线；无注册表时一律视为在线（降级：浏览器直开只有 local 桶）。 */
    function scopeAlive(scopeKey) {
        if (!scopeKey || scopeKey === 'local') return true;
        var reg = remoteRegistry();
        if (!reg) return true;
        var rid = scopeKey.slice(3);
        var arr = [];
        try { arr = reg.list() || []; } catch (e) { return true; }
        for (var i = 0; i < arr.length; i++) {
            if (arr[i] && arr[i].connectionId === rid) return true;
        }
        return false;
    }

    /* 终端 cwd 归属（全局化后）：code 模式的项目根优先（终端语义=一个 shell 一个工作目录）；
       chat 模式无项目根概念，用会话工作区根；皆空（全局区未选工作区的新会话）返回 ''，
       后端回退默认工作区。
       【会话根优先于工作区选择器】getSessionCwd 只读 currentChatWorkspace（工作区选择器），
       而会话可以带着自己的根（sessionMap[sid].projectRoot，与 app-todos/app-task-monitor
       同口径）：切到一个属于 gourdai 的会话但选择器未联动时，只读选择器会让新 tab
       落在默认工作区、tab 名退化成语言包键。故先取当前会话根，再退选择器。 */
    function termCwd() {
        if (window.currentProjectRoot) return window.currentProjectRoot;
        var sid = (typeof SESSION_ID !== 'undefined') ? SESSION_ID : null;
        if (sid && typeof sessionMap !== 'undefined' && sessionMap) {
            var sess = sessionMap[sid];
            if (sess && typeof sess.projectRoot === 'string' && sess.projectRoot) return sess.projectRoot;
        }
        if (typeof getSessionCwd === 'function') return getSessionCwd() || '';
        return '';
    }

    function wsUrl(scopeKey, cwd) {
        var protocol = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
        var root = cwd || '';
        /* 无 root（全局区）时 URL 里没有 '?'，直接拼 '&__scope=' 会得到
           '/web/terminal&__scope=id:x' —— 代理读不到任何 query，归属静默丢失。 */
        var q = root ? ('?cwd=' + encodeURIComponent(root)) : '';
        /* 叠一层显式归属：远端项目的 shell 必须打到登记它的那条连接。
           只靠 ?cwd= 不行：by_cwd 未登记时代理会回落激活 scope，而激活随用户选择漂移
           ——命令就会在另一台机器上执行。local 不拼（URL 与改造前逐字节相同）。 */
        var scopeSeg = scopeQueryOf(scopeKey);
        if (scopeSeg) q += (q.indexOf('?') >= 0 ? scopeSeg : ('?' + scopeSeg.slice(1)));
        return protocol + '//' + window.location.host + '/web/terminal' + q;
    }

    // ---------- 输出渲染（per-tab 缓冲）----------
    function escHtml(s) {
        var d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    // 剥离最常见的 ANSI CSI 序列（颜色/光标），保留可读文本。
    function stripAnsi(s) {
        // eslint-disable-next-line no-control-regex
        return String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
            // eslint-disable-next-line no-control-regex
            .replace(/\x1b[\]P][^\x07\x1b]*(\x07|\x1b\\)?/g, '')
            .replace(/\r(?!\n)/g, '');
    }

    function trimBuf(tab) {
        // 超限时从头部成批移除，保留最新输出（终端语义：旧输出可丢）
        while (tab.bufEl.childNodes.length > TERM_MAX_NODES) {
            tab.bufEl.removeChild(tab.bufEl.firstChild);
        }
    }

    // 滚动容器为 body（各 tab 的 bufEl 现为块级子树，不单独滚动）
    function isScrolledToBottom() {
        return body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    }
    function scrollToBottom() {
        body.scrollTop = body.scrollHeight;
    }

    /* 追加原始输出（保留换行/空白，做 HTML 转义，剥离常见 ANSI 转义序列）。
       写入目标恒为 tab 自己的 bufEl：非激活 tab 收到帧时不碰面板 DOM
       （切回时挂回即见），激活 tab 且在底时才自动滚底。 */
    function appendOutputTo(tab, text) {
        var clean = stripAnsi(text);
        var atBottom = (tab === activeTab) ? isScrolledToBottom() : true;
        tab.bufEl.insertAdjacentHTML('beforeend', escHtml(clean));
        trimBuf(tab);
        if (tab === activeTab && atBottom) scrollToBottom();
    }

    function appendSystemTo(tab, text) {
        var atBottom = (tab === activeTab) ? isScrolledToBottom() : true;
        tab.bufEl.insertAdjacentHTML('beforeend',
            '<span class="code-terminal-sys">' + escHtml(text) + '\n</span>');
        trimBuf(tab);
        if (tab === activeTab && atBottom) scrollToBottom();
    }

    // 让输入框宽度随内容自适应，使光标紧贴提示符（等宽字体按字符数估算）
    function syncInputWidth(el) {
        if (el) el.size = Math.max(1, el.value.length + 1);
    }

    function moveCaretEnd(el) {
        setTimeout(function () {
            try { var v = el.value; el.value = ''; el.value = v; } catch (e) {}
        }, 0);
    }

    // ---------- tab 生命周期 ----------
    function baseNameOf(cwd) {
        /* 无 cwd（全局区）用 i18n 标题。键必须是 code.terminal.title：
           terminal.title 在 12 语言包都不存在，写错会让 tab 名直接显示裸键
           「terminal.title」（用户实测报障）。 */
        if (!cwd) return GourdI18n.t('code.terminal.title');
        var parts = String(cwd).replace(/\\/g, '/').split('/');
        for (var i = parts.length - 1; i >= 0; i--) {
            if (parts[i]) return parts[i];
        }
        return cwd;
    }

    function buildInput(tab) {
        var el = document.createElement('input');
        el.type = 'text';
        el.className = 'code-terminal-input';
        el.autocomplete = 'off';
        el.autocapitalize = 'off';
        el.spellcheck = false;
        el.addEventListener('input', function () { syncInputWidth(el); });
        el.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                var cmd = el.value;
                // 不本地回显：cmd/bash 会自行回显命令行（避免重复两次）
                if (cmd.trim()) {
                    tab.history.push(cmd);
                    if (tab.history.length > 200) tab.history.shift();
                }
                tab.historyIdx = -1;
                tab.pendingDraft = '';
                sendInputTo(tab, cmd + '\n');
                el.value = '';
                syncInputWidth(el);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (tab.history.length === 0) return;
                if (tab.historyIdx === -1) { tab.pendingDraft = el.value; tab.historyIdx = tab.history.length; }
                if (tab.historyIdx > 0) tab.historyIdx--;
                el.value = tab.history[tab.historyIdx] || '';
                syncInputWidth(el);
                moveCaretEnd(el);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (tab.historyIdx === -1) return;
                tab.historyIdx++;
                if (tab.historyIdx >= tab.history.length) {
                    tab.historyIdx = -1;
                    el.value = tab.pendingDraft;
                } else {
                    el.value = tab.history[tab.historyIdx] || '';
                }
                syncInputWidth(el);
                moveCaretEnd(el);
            } else if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
                // Ctrl+C：无选中文本时向子进程发送中断信号（ETX）
                if (!window.getSelection || String(window.getSelection()) === '') {
                    e.preventDefault();
                    sendInputTo(tab, '\x03');
                    el.value = '';
                    syncInputWidth(el);
                }
            }
        });
        return el;
    }

    function createTab() {
        var tab = {
            id: ++tabSeq,
            cwd: termCwd(),
            scopeKey: termScopeKey(),
            socket: null,
            connected: false,
            dead: false,          // 原远端归属已断开：下次激活时采纳当前归属
            bufEl: document.createElement('div'),
            inEl: null,
            history: [],
            historyIdx: -1,
            pendingDraft: '',
            restartToken: 0,
            /* 本 tab 是否已展示过 Windows 版本 banner。后端对每条新连接都补发
               一次 banner（cmd /K 形态自身不打印），而本模块关面板只断连、
               保留输出缓冲，重连即懒重建 → 不抑制则每「开→关→开」一轮就在
               回滚缓冲里叠一份 banner+提示符（用户实测截图 3 份）。首帧放行、
               后续精确丢弃；restart 清屏时重置（用户主动重启=要全新会话）。 */
            bannerSeen: false,
            lastUsedAt: Date.now()
        };
        tab.name = baseNameOf(tab.cwd);
        tab.bufEl.className = 'code-terminal-tabbuf';
        tab.inEl = buildInput(tab);
        tabs.push(tab);
        return tab;
    }

    function socketLive(tab) {
        return !!tab.socket &&
            (tab.socket.readyState === WebSocket.OPEN || tab.socket.readyState === WebSocket.CONNECTING);
    }

    function killSocket(tab) {
        if (!tab.socket) return;
        var s = tab.socket;
        tab.socket = null;
        tab.connected = false;
        try {
            s.onopen = null;
            s.onmessage = null;
            s.onclose = null;
            s.onerror = null;
            s.close();
        } catch (e) {}
    }

    function connectTab(tab, onReady) {
        // onReady(ok): WebSocket 打开成功回调 true，连接失败回调 false（仅触发一次）
        var readyFired = false;
        function fireReady(ok) {
            if (readyFired) return;
            readyFired = true;
            if (typeof onReady === 'function') onReady(ok);
        }
        /* 退役本 tab 已死的旧 socket（CLOSING/CLOSED）：先摘回调再 close，
           否则旧 onmessage 会把残帧写进缓冲、旧 onclose 会误标 connected=false。
           其它 tab 一律不动（并发的核心）。 */
        if (tab.socket) killSocket(tab);
        var socket;
        try {
            socket = new WebSocket(wsUrl(tab.scopeKey, tab.cwd));
        } catch (e) {
            appendSystemTo(tab, GourdI18n.t('terminal.connect_failed') + ' ' + (e && e.message ? e.message : e));
            fireReady(false);
            return;
        }
        tab.socket = socket;
        enforcePoolLimit(tab);
        /* 连接级首帧标记：TerminalGate.start() 在 reader 线程启动前发送 banner，
           故 banner 恒为【本连接首条 output 帧】（协议契约）。去重窗口收窄到首帧，
           消除「seen 之后任何时刻命中形态都丢」的误吞窗口——用户 cat 一个内容恰为
           两行 banner 的文件时，该回显不是首帧，必须展示。 */
        var firstFrame = true;
        socket.onopen = function () {
            if (tab.socket !== socket) return;   // 已被回收/顶替：不接管
            tab.connected = true;
            fireReady(true);
        };
        socket.onmessage = function (ev) {
            if (tab.socket !== socket) return;
            var msg;
            try { msg = JSON.parse(ev.data); } catch (e) { return; }
            if (msg.type === 'output') {
                /* banner 去重：后端每条连接首帧补发 Windows 版本横幅，关面板只断连、
                   保留缓冲、重连懒重建 → 不抑制则每「开→关→开」叠一份（用户截图缺陷）。
                   仅首帧识别 banner（协议契约）；判据与后端切片同口径：以版本行开头、
                   恰两行、换行收尾。非首帧的 banner 形态一律当用户输出展示。 */
                var d = msg.data || '';
                if (firstFrame) {
                    firstFrame = false;
                    if (isWindowsBanner(d)) {
                        if (tab.bannerSeen) return;   // 重连补发：缓冲已有一份，丢弃
                        tab.bannerSeen = true;        // 首次展示：落标记
                    }
                }
                appendOutputTo(tab, d);
            } else if (msg.type === 'exit') {
                appendSystemTo(tab, '\n' + GourdI18n.t('terminal.process_exit', msg.code));
                tab.connected = false;
            }
        };
        socket.onclose = function () {
            if (tab.socket !== socket) return;   // 主动回收/顶替引发：不连带改态
            tab.socket = null;
            tab.connected = false;
            fireReady(false);
        };
        socket.onerror = function () {
            tab.connected = false;
            fireReady(false);
        };
    }

    /* 连接池守门：超上限时回收最久未用【后台 tab】的连接（LRU）。
       保护两者：传入的 protectTab（正在新建/重连者）与 activeTab（用户眼前的）。
       被回收的 tab 保留输出与身份，切回时懒重连（socket=null 即该语义）。 */
    function enforcePoolLimit(protectTab) {
        function liveCount() {
            var n = 0;
            for (var i = 0; i < tabs.length; i++) if (socketLive(tabs[i])) n++;
            return n;
        }
        while (liveCount() > TERM_POOL_MAX) {
            var victim = null;
            for (var i = 0; i < tabs.length; i++) {
                var tb = tabs[i];
                if (tb === protectTab || tb === activeTab) continue;
                if (!socketLive(tb)) continue;
                if (!victim || tb.lastUsedAt < victim.lastUsedAt) victim = tb;
            }
            if (!victim) return;   // 只剩受保护者：不再强杀（上限语义让位于眼前体验）
            killSocket(victim);
            appendSystemTo(victim, GourdI18n.t('terminal.tab_conn_recycled'));
        }
    }

    /* 滚动位置 per-tab 保存：body 是共享滚动容器，切走前不存就会把 A 的
       滚动位置带给 B（且 A 切回时永远回顶部，长输出翻不回去）。 */
    function mountTabBody(tab) {
        if (activeTab && activeTab !== tab) activeTab.scrollTop = body.scrollTop;
        body.innerHTML = '';
        body.appendChild(tab.bufEl);
        body.appendChild(tab.inEl);
        syncInputWidth(tab.inEl);
        body.scrollTop = (typeof tab.scrollTop === 'number') ? tab.scrollTop : body.scrollHeight;
    }

    function renderTabs() {
        if (!tabsEl) return;
        tabsEl.innerHTML = '';
        for (var i = 0; i < tabs.length; i++) {
            (function (tab) {
                var chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'code-terminal-tab' + (tab === activeTab ? ' active' : '');
                chip.setAttribute('data-tab-id', String(tab.id));
                chip.title = tab.cwd || tab.name;
                chip.innerHTML =
                    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>' +
                    '<span class="code-terminal-tab-name"></span>' +
                    '<span class="code-terminal-tab-close" role="button" data-i18n-title="code.close">' +
                    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
                    '</span>';
                chip.querySelector('.code-terminal-tab-name').textContent = tab.name;
                var closeEl = chip.querySelector('.code-terminal-tab-close');
                closeEl.setAttribute('aria-label', GourdI18n.t('code.close'));
                chip.addEventListener('click', function (e) {
                    var t = e.target;
                    if (t && typeof t.closest === 'function' && t.closest('.code-terminal-tab-close')) return;
                    switchTab(tab);
                });
                closeEl.addEventListener('click', function (e) {
                    e.stopPropagation();
                    requestCloseTab(tab);
                });
                tabsEl.appendChild(chip);
            })(tabs[i]);
        }
    }

    function activateTab(tab, opts) {
        if (!tab) return;
        activeTab = tab;
        tab.lastUsedAt = Date.now();
        /* 原远端归属已断开：采纳当前归属再连（旧 scope 的连接永远等不到对端）。 */
        if (tab.dead) {
            tab.dead = false;
            tab.scopeKey = termScopeKey();
            appendSystemTo(tab, GourdI18n.t('terminal.scope_adopted'));
        }
        mountTabBody(tab);
        renderTabs();
        if (opened && !socketLive(tab)) connectTab(tab);
        if (!opts || opts.focus !== false) {
            setTimeout(function () { if (activeTab === tab && tab.inEl) tab.inEl.focus(); }, 30);
        }
    }

    function switchTab(tab) {
        if (tab && tab !== activeTab) activateTab(tab);
    }

    function newTab() {
        if (tabs.length >= TERM_MAX_TABS) {
            if (activeTab) appendSystemTo(activeTab, GourdI18n.t('terminal.tab_limit', TERM_MAX_TABS));
            return null;
        }
        var tab = createTab();
        activateTab(tab);
        return tab;
    }

    /* 向本 tab 的 shell 查询忙闲：后端以「shell 是否存在存活后代进程」判定。
       cb(busy)：连接不可用/超时按空闲处理（宁可少问一次，不卡死关闭路径）。 */
    function queryBusy(tab, cb) {
        if (!tab || !tab.socket || tab.socket.readyState !== WebSocket.OPEN) { cb(false); return; }
        var id = 'bq' + Date.now() + Math.floor(Math.random() * 1e6);
        var done = false;
        function finish(busy) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (tab.socket === s) s.onmessage = prev;
            cb(busy);
        }
        var s = tab.socket;
        var prev = s.onmessage;
        var timer = setTimeout(function () { finish(false); }, 1500);
        s.onmessage = function (ev) {
            var msg;
            try { msg = JSON.parse(ev.data); } catch (e) { return; }
            if (msg && msg.type === 'busy' && msg.id === id) { finish(!!msg.busy); return; }
            if (typeof prev === 'function') prev(ev);
        };
        try {
            s.send(JSON.stringify({ type: 'busyQuery', id: id }));
        } catch (e) {
            finish(false);
        }
    }

    /* 关 tab：仅当 shell 正在跑命令（busyQuery 命中存活后代进程）才确认——
       子进程随连接终止，正在跑的构建/部署会被一并杀掉（比丢输出严重得多）。
       空闲 shell 静默关闭：常驻 cmd/bash 永远「活着」，拿连接存活当判据会把
       什么都没跑的终端误报成「仍在运行」。确认框走应用内 layConfirm
       （桌面端规约禁原生 confirm）。 */
    function requestCloseTab(tab) {
        if (!tab) return;
        if (!socketLive(tab)) { closeTab(tab); return; }
        queryBusy(tab, function (busy) {
            if (!busy) { closeTab(tab); return; }
            if (typeof window.layConfirm === 'function') {
                window.layConfirm(GourdI18n.t('terminal.tab_close_confirm'), function () { closeTab(tab); });
            } else {
                closeTab(tab);
            }
        });
    }

    function closeTab(tab) {
        var idx = tabs.indexOf(tab);
        if (idx < 0) return;
        killSocket(tab);
        tabs.splice(idx, 1);
        if (tab === activeTab) {
            if (tabs.length === 0) {
                activeTab = null;   // 防悬空引用：重开面板时不得复活已关闭的 tab
                renderTabs();       // DOM 同步清空：面板隐藏期间不留幽灵 chip
                closeTerminal();   // 最后一个 tab 关闭 = 面板关闭
                return;
            }
            activateTab(tabs[Math.min(idx, tabs.length - 1)]);
        } else {
            renderTabs();
        }
    }

    // ---------- 打开 / 关闭 ----------
    function openTerminal(focus) {
        opened = true;
        document.body.classList.add('terminal-open');
        try { localStorage.setItem(LS_OPEN, '1'); } catch (e) {}
        syncTerminalLeft();
        if (tabs.length === 0) createTab();
        activateTab(activeTab || tabs[0], { focus: focus });
        if (typeof window.refreshCodeEditor === 'function') window.refreshCodeEditor();
    }

    function closeTerminal() {
        opened = false;
        if (activeTab) activeTab.scrollTop = body.scrollTop;   // 隐藏前存滚动位，重开回现场
        document.body.classList.remove('terminal-open');
        try { localStorage.setItem(LS_OPEN, '0'); } catch (e) {}
        /* 隐藏即断开全部子进程，避免后台常驻 shell 泄漏。
           tab 与输出缓冲保留：重开面板即回现场（连接懒重建）。 */
        for (var i = 0; i < tabs.length; i++) killSocket(tabs[i]);
        if (typeof window.refreshCodeEditor === 'function') window.refreshCodeEditor();
    }

    function toggleTerminal() {
        if (opened) closeTerminal(); else openTerminal(true);
    }
    window.toggleCodeTerminal = toggleTerminal;

    /* 后端首帧 banner 的形态（TerminalGate.windowsBanner 取无参 cmd 输出首两行）：
       「Microsoft Windows [版本 ...]」+「(c) Microsoft Corporation...」+ 换行收尾。
       前后端各持一份判据：后端负责切片采集，前端负责重连去重，口径必须一致——
       后端切片约束为 substring(0, idx2+1) 且 idx2>idx+1、raw[idx+1]!='\n'，
       等价于「恰两行、第二行非空、换行收尾」；少锁任一条都会把用户输出误判成
       banner（三行/单行形态后端永不产出）。 */
    function isWindowsBanner(text) {
        if (typeof text !== 'string') return false;
        if (text.indexOf('Microsoft Windows') !== 0) return false;
        if (text.charAt(text.length - 1) !== '\n') return false;
        var firstNl = text.indexOf('\n');
        if (firstNl <= 0) return false;
        var secondNl = text.indexOf('\n', firstNl + 1);
        return secondNl === text.length - 1 && secondNl > firstNl + 1;
    }

    /* 重启只重建【当前 tab】的 shell：多实例下其它 tab 的子进程与本页无关，
       用户点「重启」的意图只是重启眼前这个。 */
    function restartTerminal() {
        var tab = activeTab;
        if (!tab) return;
        killSocket(tab);
        tab.bufEl.innerHTML = '';
        tab.bannerSeen = false;   // 清屏=全新会话：新连接的首帧 banner 应重新展示
        appendSystemTo(tab, GourdI18n.t('terminal.restarting'));
        var myToken = ++tab.restartToken;   // 本轮代次；后续任何一轮重启都会使它过期
        var timer = setTimeout(function () {
            if (myToken !== tab.restartToken) return;   // 已被新一轮重启接管
            if (tabs.indexOf(tab) < 0) return;          // tab 已关闭：不向孤儿缓冲写提示
            killSocket(tab);
            appendSystemTo(tab, GourdI18n.t('terminal.restart_timeout'));
        }, 8000);
        connectTab(tab, function (ok) {
            if (myToken !== tab.restartToken) return;   // 过期回调，丢弃
            clearTimeout(timer);
            appendSystemTo(tab, ok ? GourdI18n.t('terminal.restarted') : GourdI18n.t('terminal.restart_failed'));
        });
        setTimeout(function () { if (tab.inEl) tab.inEl.focus(); }, 30);
    }

    /* 切项目/切会话：已有 tab 的 cwd 是创建时快照，不劫持（一个 shell 一个工作目录，
       正在跑的构建不能被静默换目录；要新 cwd 请新建 tab——标签栏「+」）。
       保留空实现以维持外部调用点（app-code 等）的既有契约。 */
    window.onCodeProjectChanged = function () { /* tabs 固定归属，无需重建 */ };

    // 远程工作区（P0-2 修复）：远程连接建立/断开时，本地 UI 服务器的 WS 代理
    // 上游已切换（远端 ⇄ 本地），旧终端连接指向已失效上游。
    /* 多实例下：全部 tab 的旧连接都失效（上游换了），统一摘除；
       眼前 tab 立即重连恢复体验，后台 tab 懒重连（不白烧子进程）。 */
    window.onRemoteChannelChanged = function () {
        for (var i = 0; i < tabs.length; i++) killSocket(tabs[i]);
        if (opened && activeTab) connectTab(activeTab);
    };

    /* 连接死亡摘除（与 gate 池同时机）：'remote:connections-changed' 的 detail.ids
       不含该 id 就把对应 tab 标记 dead（摘连接、留身份）。
       dead tab 下次激活时采纳当前归属重连（activateTab 内处理）。 */
    function markDeadScopes(aliveIds) {
        for (var i = 0; i < tabs.length; i++) {
            var tab = tabs[i];
            if (!tab.scopeKey || tab.scopeKey === 'local') continue;
            var rid = tab.scopeKey.slice(3);
            var alive = aliveIds ? (aliveIds.indexOf(rid) >= 0) : scopeAlive(tab.scopeKey);
            if (alive) continue;
            killSocket(tab);
            tab.dead = true;
            if (tab === activeTab && opened) {
                appendSystemTo(tab, GourdI18n.t('terminal.not_connected'));
            }
        }
    }

    window.addEventListener('remote:connections-changed', function (ev) {
        try {
            markDeadScopes((ev && ev.detail && ev.detail.ids) || null);
        } catch (e) { /* 摘除失败不得影响其它监听者 */ }
    });

    /* 发送目标显式绑定到输入框所属 tab（而非 activeTab）：
       挂载关系保证二者此刻相同，但显式传参让「输入进 A 却发给 B」这类
       串线在结构上不可能发生。 */
    function sendInputTo(tab, text) {
        if (!tab) return;
        if (!tab.socket || tab.socket.readyState !== WebSocket.OPEN) {
            appendSystemTo(tab, GourdI18n.t('terminal.not_connected'));
            return;
        }
        tab.lastUsedAt = Date.now();
        try {
            tab.socket.send(JSON.stringify({ type: 'input', data: text }));
        } catch (e) {
            appendSystemTo(tab, GourdI18n.t('terminal.send_failed') + ' ' + (e && e.message ? e.message : e));
        }
    }

    // ---------- 按钮 ----------
    if (filerTerminalBtn) filerTerminalBtn.addEventListener('click', function () { toggleTerminal(); });
    if (closeBtn) closeBtn.addEventListener('click', closeTerminal);
    if (newBtn) newBtn.addEventListener('click', function () { newTab(); });
    if (clearBtn) clearBtn.addEventListener('click', function () {
        if (activeTab) {
            activeTab.bufEl.innerHTML = '';
            // 清屏=全新屏幕（与 restart 同语义）：重连首帧 banner 应重新展示，
            // 不重置则清屏后重连的补发 banner 被静默吞掉、屏顶缺横幅。
            activeTab.bannerSeen = false;
        }
        if (activeTab && activeTab.inEl) activeTab.inEl.focus();
    });
    if (restartBtn) restartBtn.addEventListener('click', restartTerminal);

    // Ctrl+` 全局快捷键（全视图生效：终端已全局化，不再限 code 模式）
    document.addEventListener('keydown', function (e) {
        if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === '`' || e.code === 'Backquote')) {
            e.preventDefault();
            toggleTerminal();
        }
    });

    // 点击输出区自动聚焦输入框，模拟终端体验
    if (body) {
        body.addEventListener('mousedown', function (e) {
            var tab = activeTab;
            if (!tab) return;
            if (e.target === tab.inEl) return;
            if (!(e.target === body || tab.bufEl.contains(e.target))) return;
            // 有文本选中时不抢焦点，方便复制
            if (!window.getSelection || String(window.getSelection()) === '') {
                setTimeout(function () { if (activeTab === tab && tab.inEl) tab.inEl.focus(); }, 0);
            }
        });
    }

    // ---------- 拖拽调高 ----------
    function setHeight(px) {
        var h = Math.max(TERM_MIN_HEIGHT, Math.min(TERM_MAX_HEIGHT, px));
        document.documentElement.style.setProperty('--code-terminal-height', h + 'px');
        return h;
    }

    /* ---------- 终端左缘：让开主侧栏 ----------
       终端/监控右栏都是 body 级 fixed，左缘需等于侧栏右缘。侧栏宽度可被
       #sidebarResizeHandle 拖拽改写内联 style（app-ui.js），CSS 变量算不出
       offsetWidth，故在此实测写入 --terminal-left（终端面板与调高手柄、
       监控右栏三处共用该变量）。
       同步时机：启动 + 窗口 resize + 打开终端时；侧栏拖拽结束由 document mouseup
       与 window resize 兜底补一次（拖拽期间不跟随：侧栏宽度只在 mouseup 落定）。 */
    function syncTerminalLeft() {
        var sb = document.querySelector('.sidebar');
        var w = (sb && sb.offsetWidth > 0) ? sb.offsetWidth : 0;
        document.documentElement.style.setProperty('--terminal-left', w + 'px');
    }
    syncTerminalLeft();
    window.addEventListener('resize', syncTerminalLeft);
    document.addEventListener('mouseup', syncTerminalLeft);   // 侧栏拖拽结束兑底
    (function initHeight() {
        try {
            var saved = parseInt(localStorage.getItem(LS_HEIGHT), 10);
            if (saved) setHeight(saved);
        } catch (e) {}
    })();

    if (handle && pane) {
        var dragging = false, startY = 0, startH = 0;
        handle.addEventListener('mousedown', function (e) {
            if (!opened) return;
            dragging = true;
            startY = e.clientY;
            startH = pane.offsetHeight;
            document.body.style.cursor = 'row-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });
        document.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            // 终端在下方：手柄向上拖（clientY 变小）→ 变高
            setHeight(startH + (startY - e.clientY));
        });
        document.addEventListener('mouseup', function () {
            if (!dragging) return;
            dragging = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            try { localStorage.setItem(LS_HEIGHT, pane.offsetHeight); } catch (e) {}
            if (typeof window.refreshCodeEditor === 'function') window.refreshCodeEditor();
        });
    }

    // ---------- 启动：恢复上次开关态（全视图；面板已全局化不再限 code 模式）----------
    setTimeout(function () {
        var wasOpen = false;
        try { wasOpen = localStorage.getItem(LS_OPEN) === '1'; } catch (e) {}
        if (wasOpen) {
            openTerminal(false);
        }
    }, 300);
})();
