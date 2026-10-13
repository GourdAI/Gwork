/* ===== app-terminal.js =====
   Code 模式本地终端：底部可切换的终端面板 + WebSocket 双向流。
   依赖：app-base.js（window.currentProjectRoot）、jQuery（layui.$）。
   后端网关：/web/terminal（见 TerminalGate.java）。

   设计：
   - 常驻 shell 子进程由后端按连接维持，cd 等状态天然保留。
   - 输出块原样追加到 #codeTerminalOutput（做 HTML 转义，保留换行）。
   - 命令输入走单行 input（回车发送），支持 ↑↓ 历史。
    - 未开终端时通过文件树面板顶部入口切换；Ctrl+` 快捷切换。 */
(function () {
    'use strict';

    var LS_OPEN = 'code-terminal-open';
    var LS_HEIGHT = 'code-terminal-height';
    var TERM_MIN_HEIGHT = 120;
    var TERM_MAX_HEIGHT = 640;

    // ---------- DOM ----------
    var pane = document.getElementById('codeTerminalPane');
    var handle = document.getElementById('codeTerminalResizeHandle');
    var output = document.getElementById('codeTerminalOutput');
    var input = document.getElementById('codeTerminalInput');
    var body = document.getElementById('codeTerminalBody');
    var clearBtn = document.getElementById('codeTerminalClearBtn');
    var restartBtn = document.getElementById('codeTerminalRestartBtn');
    var closeBtn = document.getElementById('codeTerminalCloseBtn');
    var filerTerminalBtn = document.getElementById('filerTerminalBtn');

    if (!pane) return; // code.html 片段未注入则跳过

    // ---------- 状态 ----------
    /* 终端连接池（契约 §3.5）：与 app-streaming 的 gateSockets 同款 Map 化。

       为什么终端也要池：旧实现全站一个 socket，切项目就 disconnect + 重建——
       而 code 模式下两个环境的项目可能同时在跑长命令（本地构建 + 远端部署），
       切一下就把另一边的 shell 杀了（子进程随连接关闭而终止，输出丢失）。
       池化后：每个环境各留一条 shell，面板展示当前 activeScope 那一条的输出。

       key = scopeKey：'local' | 'id:<connectionId>'（与 gate 池同口径）。 */
    var termSockets = new Map();
    var activeScope = 'local';
    /* 上限 4 条：与 gate 池同档（后台常驻 shell 占的是远端/本地两侧的子进程，比 WS 更贵）。 */
    var TERM_POOL_MAX = 4;
    var connected = false;
    var opened = false;
    var history = [];
    var historyIdx = -1;      // -1 表示当前未浏览历史
    var pendingDraft = '';    // 浏览历史时暂存正在输入的内容
    var reconnectTimer = null;
    var restartToken = 0;     // 重启代次：每次重启递增，用于作废旧一轮的回调/超时

    // ---------- 归属（scope）----------
    /* 当前项目根属于哪个环境（'local' | 'id:<rid>'）。

       优先级：① app-code 已暴露的 __currentProjectScope（它就是 code 模式项目根的
       strict 归属口径，查不到返回 null）；② 'local'。

       WHY 不再回退到 app-workspace 的 scopeOfPath：那是个 IIFE 闭包内的私有函数，
       全仓从未挂到 window 上（导出面只有契约 §8 的 __currentChatWorkspaceScope），
       拿它当兜底恒为 undefined，只会把「查不到」伪装成「已查过且属本地」。
       终端只服务 code 模式，__currentProjectScope 已是该模式下的权威 strict 口径。

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

    // ---------- WebSocket ----------
    function wsUrl(scopeKey) {
        var protocol = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
        var root = window.currentProjectRoot || '';
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

    function connect(onReady) {
        // onReady(ok): WebSocket 打开成功回调 true，连接失败回调 false（仅触发一次）
        var scopeKey = termScopeKey();
        activeScope = scopeKey;
        var readyFired = false;
        function fireReady(ok) {
            if (readyFired) return;
            readyFired = true;
            if (typeof onReady === 'function') onReady(ok);
        }
        var socket = termSockets.get(scopeKey) || null;
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
            connected = true;
            fireReady(true);
            return;
        }
        /* 退役本桶已死的旧 socket（CLOSING/CLOSED）：先摘回调再 close，
           否则旧 onmessage 会把残帧写进当前面板、旧 onclose 会误标 connected=false。
           其它桶一律不动（并发的核心）。 */
        if (socket) {
            try {
                socket.onopen = null;
                socket.onmessage = null;
                socket.onclose = null;
                socket.onerror = null;
                socket.close();
            } catch (e) {}
            termSockets.delete(scopeKey);
        }
        try {
            socket = new WebSocket(wsUrl(scopeKey));
        } catch (e) {
            appendSystem(GourdI18n.t('terminal.connect_failed') + ' ' + (e && e.message ? e.message : e));
            fireReady(false);
            return;
        }
        termSockets.set(scopeKey, socket);
        enforceTermPoolLimit(scopeKey);
        socket.onopen = function () {
            if (termSockets.get(scopeKey) !== socket) return;   // 已被回收/顶替：不接管
            connected = (activeScope === scopeKey);
            fireReady(true);
        };
        socket.onmessage = function (ev) {
            /* 非当前展示桶的输出不得写进面板：池化后另一个环境的 shell 仍可能吐帧，
               写进来就是「本地终端里混进远端构建日志」（无法区分且无法回溯）。 */
            if (termSockets.get(scopeKey) !== socket || scopeKey !== activeScope) return;
            var msg;
            try { msg = JSON.parse(ev.data); } catch (e) { return; }
            if (msg.type === 'output') {
                appendOutput(msg.data || '');
            } else if (msg.type === 'exit') {
                appendSystem('\n' + GourdI18n.t('terminal.process_exit', msg.code));
                connected = false;
            }
        };
        socket.onclose = function () {
            if (termSockets.get(scopeKey) !== socket) return;   // 主动回收/顶替引发：不连带改全局态
            termSockets.delete(scopeKey);
            if (scopeKey === activeScope) connected = false;
            fireReady(false);
        };
        socket.onerror = function () {
            if (scopeKey === activeScope) connected = false;
            fireReady(false);
        };
    }

    /* 池上限守门：超 4 条时关最早入池且非当前展示者（LRU）。
       终端比 WS 更贵：每条对应一个常驻 shell 子进程（可能在远端机器上），
       不封顶就是逐个项目切一轮就泄漏一批进程。 */
    function enforceTermPoolLimit(protectScope) {
        if (termSockets.size <= TERM_POOL_MAX) return;
        var keys = [];
        termSockets.forEach(function (s, k) {
            if (k !== protectScope && k !== activeScope) keys.push(k);
        });
        var over = termSockets.size - TERM_POOL_MAX;
        for (var i = 0; i < over && i < keys.length; i++) closeScope(keys[i]);
    }

    function closeScope(scopeKey) {
        var s = termSockets.get(scopeKey);
        termSockets.delete(scopeKey);
        if (!s) return;
        try {
            s.onopen = null;
            s.onmessage = null;
            s.onclose = null;
            s.onerror = null;
            s.close();
        } catch (e) {}
        if (scopeKey === activeScope) connected = false;
    }

    /* 连接死亡摘除（与 gate 池同时机）：'remote:connections-changed' 的 detail.ids
       不含该 id 就关该桶。若关的正是当前展示桶，面板回落到 local 并重连（开着才重）。 */
    function pruneDeadScopes(aliveIds) {
        var victims = [];
        termSockets.forEach(function (s, k) {
            if (!k || k === 'local') return;
            var rid = k.slice(3);
            var alive = aliveIds ? (aliveIds.indexOf(rid) >= 0) : scopeAlive(k);
            if (!alive) victims.push(k);
        });
        for (var i = 0; i < victims.length; i++) closeScope(victims[i]);
        return victims.indexOf(activeScope) >= 0;
    }

    window.addEventListener('remote:connections-changed', function (ev) {
        try {
            var activeDied = pruneDeadScopes((ev && ev.detail && ev.detail.ids) || null);
            if (activeDied && opened) {
                output.innerHTML = '';
                appendSystem(GourdI18n.t('terminal.not_connected'));
                connect();
            }
        } catch (e) { /* 摘除失败不得影响其它监听者 */ }
    });

    function disconnect() {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        /* 关全部桶（不只当前）：本函数只在【面板隐藏/重启】时调用，
           语义是「终端不再存在」——后台常驻 shell 必须随之收尾（防泄漏），
           与改造前一致。并发保留是【切项目】的事（那条路径不调 disconnect）。 */
        var keys = [];
        termSockets.forEach(function (s, k) { keys.push(k); });
        for (var i = 0; i < keys.length; i++) closeScope(keys[i]);
        connected = false;
    }

    function sendInput(text) {
        var socket = termSockets.get(activeScope) || null;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            appendSystem(GourdI18n.t('terminal.not_connected'));
            return;
        }
        try {
            socket.send(JSON.stringify({ type: 'input', data: text }));
        } catch (e) {
            appendSystem(GourdI18n.t('terminal.send_failed') + ' ' + (e && e.message ? e.message : e));
        }
    }

    // ---------- 输出渲染 ----------
    function escHtml(s) {
        var d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    /* 终端回滚缓冲上限（子节点个数）。
       输出区原本只追加不裁剪，跑一次 mvn build 就是数万个节点常驻，只能手动点「清空」释放。
       注：TERM_MAX_HEIGHT 是面板像素高度，与回滚量无关，不能当上限用。 */
    var TERM_MAX_NODES = 4000;
    function trimOutputBuffer() {
        // 超限时从头部成批移除，保留最新输出（终端语义：旧输出可丢）
        while (output.childNodes.length > TERM_MAX_NODES) {
            output.removeChild(output.firstChild);
        }
    }

    // 追加原始输出（保留换行/空白，做 HTML 转义，剥离常见 ANSI 转义序列）
    function appendOutput(text) {
        var clean = stripAnsi(text);
        var atBottom = isScrolledToBottom();
        output.insertAdjacentHTML('beforeend', escHtml(clean));
        trimOutputBuffer();
        if (atBottom) scrollToBottom();
    }

    function appendSystem(text) {
        var atBottom = isScrolledToBottom();
        output.insertAdjacentHTML('beforeend',
            '<span class="code-terminal-sys">' + escHtml(text) + '\n</span>');
        trimOutputBuffer();
        if (atBottom) scrollToBottom();
    }

    // 剥离最常见的 ANSI CSI 序列（颜色/光标），保留可读文本。
    function stripAnsi(s) {
        // eslint-disable-next-line no-control-regex
        return String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
            // eslint-disable-next-line no-control-regex
            .replace(/\x1b[\]P][^\x07\x1b]*(\x07|\x1b\\)?/g, '')
            .replace(/\r(?!\n)/g, '');
    }

    // 滚动容器为 body（output 现为内联 span，不单独滚动）
    function isScrolledToBottom() {
        return body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    }
    function scrollToBottom() {
        body.scrollTop = body.scrollHeight;
    }

    // 让输入框宽度随内容自适应，使光标紧贴提示符（等宽字体按字符数估算）
    function syncInputWidth() {
        if (input) input.size = Math.max(1, input.value.length + 1);
    }

    // ---------- 打开 / 关闭 ----------
    function openTerminal(focus) {
        opened = true;
        document.body.classList.add('terminal-open');
        try { localStorage.setItem(LS_OPEN, '1'); } catch (e) {}
        connect();
        if (typeof window.refreshCodeEditor === 'function') window.refreshCodeEditor();
        if (focus !== false) setTimeout(function () { if (input) input.focus(); }, 30);
    }

    function closeTerminal() {
        opened = false;
        document.body.classList.remove('terminal-open');
        try { localStorage.setItem(LS_OPEN, '0'); } catch (e) {}
        // 隐藏即断开子进程，避免后台常驻 shell 泄漏
        disconnect();
        if (typeof window.refreshCodeEditor === 'function') window.refreshCodeEditor();
    }

    function toggleTerminal() {
        if (opened) closeTerminal(); else openTerminal(true);
    }
    window.toggleCodeTerminal = toggleTerminal;

    /* 重启只重建【当前展示桶】的 shell：池化后 disconnect() 会把另一环境
       正在跑的构建/部署一并杀掉，而用户点「重启」的意图只是重启眼前这个。 */
    function restartTerminal() {
        closeScope(activeScope);
        connected = false;
        output.innerHTML = '';
        appendSystem(GourdI18n.t('terminal.restarting'));
        var myToken = ++restartToken;   // 本轮代次；后续任何一轮重启都会使它过期
        var timer = setTimeout(function () {
            if (myToken !== restartToken) return;   // 已被新一轮重启接管
            closeScope(activeScope);
            connected = false;
            appendSystem(GourdI18n.t('terminal.restart_timeout'));
        }, 8000);
        connect(function (ok) {
            if (myToken !== restartToken) return;   // 过期回调，丢弃
            clearTimeout(timer);
            appendSystem(ok ? GourdI18n.t('terminal.restarted') : GourdI18n.t('terminal.restart_failed'));
        });
        setTimeout(function () { if (input) input.focus(); }, 30);
    }

    /* 切项目时若终端开着：切到【新项目所属环境】的桶，旧桶保留。
       为什么不再 disconnect()：那是单例时代的「一个 shell 换一个 cwd」做法，
       池化后 disconnect 会把另一环境正在跑的构建/部署一并杀掉（子进程随连接终止）。
       旧桶的去向：要么被 LRU（>4 条）汰，要么随面板隐藏（disconnect）收尾。 */
    window.onCodeProjectChanged = function () {
        if (opened) {
            var next = termScopeKey();
            output.innerHTML = '';
            activeScope = next;
            var s = termSockets.get(next) || null;
            /* 同环境切项目（cwd 变了但 scope 未变）：旧 shell 的 cwd 仍是旧项目，
               必须重建（终端语义：一个 shell 一个工作目录）。跳环境切则保留旧桶。 */
            if (s) closeScope(next);
            connected = false;
            connect();
        }
    };

    // 远程工作区（P0-2 修复）：远程连接建立/断开时，本地 UI 服务器的 WS 代理
    // 上游已切换（远端 ⇄ 本地），旧终端连接指向已失效上游。面板打开着才重建
    // （隐藏时 socket 本就断开，openTerminal 会自行重连）。
    /* 池化后只重建【当前展示桶】：另一环境的 shell 并未因本连接变化而失效，
       杀它只会白丢一个正在跑的子进程。连接真正死亡时的整桶摘除由
       'remote:connections-changed' 监听器负责（pruneDeadScopes）。 */
    window.onRemoteChannelChanged = function () {
        if (opened) {
            closeScope(activeScope);   // 只重建当前展示桶（其余桶的上游未变）
            connected = false;
            output.innerHTML = '';
            connect();
        }
    };

    // ---------- 输入交互 ----------
    if (input) {
        input.addEventListener('input', syncInputWidth);
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                var cmd = input.value;
                // 不本地回显：cmd/bash 会自行回显命令行（避免重复两次）
                if (cmd.trim()) {
                    history.push(cmd);
                    if (history.length > 200) history.shift();
                }
                historyIdx = -1;
                pendingDraft = '';
                sendInput(cmd + '\n');
                input.value = '';
                syncInputWidth();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (history.length === 0) return;
                if (historyIdx === -1) { pendingDraft = input.value; historyIdx = history.length; }
                if (historyIdx > 0) historyIdx--;
                input.value = history[historyIdx] || '';
                syncInputWidth();
                moveCaretEnd();
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (historyIdx === -1) return;
                historyIdx++;
                if (historyIdx >= history.length) {
                    historyIdx = -1;
                    input.value = pendingDraft;
                } else {
                    input.value = history[historyIdx] || '';
                }
                syncInputWidth();
                moveCaretEnd();
            } else if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
                // Ctrl+C：无选中文本时向子进程发送中断信号（ETX）
                if (!window.getSelection || String(window.getSelection()) === '') {
                    e.preventDefault();
                    sendInput('\x03');
                    input.value = '';
                    syncInputWidth();
                }
            }
        });
        syncInputWidth();
    }

    function moveCaretEnd() {
        setTimeout(function () {
            try { var v = input.value; input.value = ''; input.value = v; } catch (e) {}
        }, 0);
    }

    // 点击输出区自动聚焦输入框，模拟终端体验
    if (body) {
        body.addEventListener('mousedown', function (e) {
            if (e.target === output || e.target === body) {
                // 有文本选中时不抢焦点，方便复制
                if (!window.getSelection || String(window.getSelection()) === '') {
                    setTimeout(function () { if (input) input.focus(); }, 0);
                }
            }
        });
    }

    // ---------- 按钮 ----------

    if (filerTerminalBtn) filerTerminalBtn.addEventListener('click', function () { toggleTerminal(); });
    if (closeBtn) closeBtn.addEventListener('click', closeTerminal);
    if (clearBtn) clearBtn.addEventListener('click', function () { output.innerHTML = ''; if (input) input.focus(); });
    if (restartBtn) restartBtn.addEventListener('click', restartTerminal);

    // Ctrl+` 全局快捷键（仅 code 模式生效）
    document.addEventListener('keydown', function (e) {
        if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === '`' || e.code === 'Backquote')) {
            if (document.body.classList.contains('code-mode')) {
                e.preventDefault();
                toggleTerminal();
            }
        }
    });

    // ---------- 拖拽调高 ----------
    function setHeight(px) {
        var h = Math.max(TERM_MIN_HEIGHT, Math.min(TERM_MAX_HEIGHT, px));
        document.documentElement.style.setProperty('--code-terminal-height', h + 'px');
        return h;
    }
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

    // ---------- 启动：恢复上次开关态（仅 code 模式）----------
    setTimeout(function () {
        var wasOpen = false;
        try { wasOpen = localStorage.getItem(LS_OPEN) === '1'; } catch (e) {}
        if (wasOpen && document.body.classList.contains('code-mode')) {
            openTerminal(false);
        }
    }, 300);
})();
