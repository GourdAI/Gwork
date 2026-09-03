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
    var socket = null;
    var connected = false;
    var opened = false;
    var history = [];
    var historyIdx = -1;      // -1 表示当前未浏览历史
    var pendingDraft = '';    // 浏览历史时暂存正在输入的内容
    var reconnectTimer = null;
    var restartToken = 0;     // 重启代次：每次重启递增，用于作废旧一轮的回调/超时

    // ---------- WebSocket ----------
    function wsUrl() {
        var protocol = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
        var root = window.currentProjectRoot || '';
        var q = root ? ('?cwd=' + encodeURIComponent(root)) : '';
        return protocol + '//' + window.location.host + '/web/terminal' + q;
    }

    function connect(onReady) {
        // onReady(ok): WebSocket 打开成功回调 true，连接失败回调 false（仅触发一次）
        var readyFired = false;
        function fireReady(ok) {
            if (readyFired) return;
            readyFired = true;
            if (typeof onReady === 'function') onReady(ok);
        }
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) { fireReady(true); return; }
        try {
            socket = new WebSocket(wsUrl());
        } catch (e) {
            appendSystem(GourdI18n.t('terminal.connect_failed') + ' ' + (e && e.message ? e.message : e));
            fireReady(false);
            return;
        }
        socket.onopen = function () {
            connected = true;
            fireReady(true);
        };
        socket.onmessage = function (ev) {
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
            connected = false;
            fireReady(false);
        };
        socket.onerror = function () {
            connected = false;
            fireReady(false);
        };
    }

    function disconnect() {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (socket) {
            try { socket.close(); } catch (e) {}
            socket = null;
        }
        connected = false;
    }

    function sendInput(text) {
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

    function restartTerminal() {
        disconnect();
        output.innerHTML = '';
        appendSystem(GourdI18n.t('terminal.restarting'));
        var myToken = ++restartToken;   // 本轮代次；后续任何一轮重启都会使它过期
        var timer = setTimeout(function () {
            if (myToken !== restartToken) return;   // 已被新一轮重启接管
            disconnect();
            appendSystem(GourdI18n.t('terminal.restart_timeout'));
        }, 8000);
        connect(function (ok) {
            if (myToken !== restartToken) return;   // 过期回调，丢弃
            clearTimeout(timer);
            appendSystem(ok ? GourdI18n.t('terminal.restarted') : GourdI18n.t('terminal.restart_failed'));
        });
        setTimeout(function () { if (input) input.focus(); }, 30);
    }

    // 切换项目时若终端开着，重连到新项目目录
    window.onCodeProjectChanged = function () {
        if (opened) {
            disconnect();
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
