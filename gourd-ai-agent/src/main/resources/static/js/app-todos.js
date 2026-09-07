/* ===== app-todos.js ===== */
/* 任务面板：读取并展示当前会话的 TODO.md 任务清单 */

(function() {
    var todoBadge = document.getElementById('todoBadge');
    var todoList = document.getElementById('todoList');
    var todoEmpty = document.getElementById('todoEmpty');
    var todoStats = document.getElementById('todoStats');
    var todoRefreshBtn = document.getElementById('todoRefreshBtn');
    var todoChipWrap = document.getElementById('chatTodoChipWrap');
    var todoChip = document.getElementById('chatTodoChip');
    var todoPanel = document.getElementById('chatTodoPanel');

    function loadTodos() {
        var sid = typeof SESSION_ID !== 'undefined' ? SESSION_ID : null;
        if (!sid) return;

        fetch('/web/chat/todos?sessionId=' + encodeURIComponent(sid), {
            // code 会话的任务清单落在所选项目目录下，需随请求头带上项目根，
            // 否则后端按全局工作区解析路径查不到清单（桌面端表现为面板空、按钮隐藏）
            headers: (typeof getSessionCwd === 'function' && getSessionCwd())
                ? { 'X-Session-Cwd': getSessionCwd() } : {}
        })
            .then(function(r) { return r.json(); })
            .then(function(res) {
                renderTodos(res && res.data ? res.data : {});
            })
            .catch(function() {
                renderError();
            });
    }

    function renderTodos(data) {
        var items = data.items || [];
        var stats = data.stats || {};

        // badge
        if (todoBadge) {
            var pending = (stats.pending || 0) + (stats.inProgress || 0);
            todoBadge.textContent = pending;
            todoBadge.style.display = pending > 0 ? '' : 'none';
        }

        // 检查必需元素是否存在
        if (!todoList || !todoEmpty || !todoStats) {
            console.warn('[Todos] Required DOM elements not found');
            return;
        }

        // 三态区分：清单文件不存在 / 文件为空 / 文件有内容但一行任务也解析不出来（格式异常）。
        // 只有「确认没有清单」才允许收起 chip；格式异常要保持 chip 可见并在面板内给提示，
        // 否则用户点开面板后异步回包会立即把它关掉，表现为「任务按钮点击后闪消」。
        var raw = typeof data.raw === 'string' ? data.raw : '';
        var malformed = !!data.exists && items.length === 0 && raw.trim().length > 0;

        if (malformed) {
            renderMalformedTodos(raw);
            setTodoChipVisible(true);
            return;
        }

        // empty state
        if (!data.exists || items.length === 0) {
            todoList.innerHTML = '';
            todoEmpty.style.display = '';
            todoEmpty.textContent = data.exists ? GourdI18n.t('todos.no_tasks') : GourdI18n.t('todos.no_task_list');
            todoStats.style.display = 'none';
            // 只收起 chip，不走 showTodoChip(false)：面板由用户主动点开，异步回包无权关闭它
            setTodoChipVisible(false);
            // 清理会话级缓存
            var sid = typeof SESSION_ID !== 'undefined' ? SESSION_ID : null;
            if (sid) delete (window.sessionTodoMap || {})[sid];
            if (typeof updateHistoryUI === 'function') updateHistoryUI();
            return;
        }

        todoEmpty.style.display = 'none';
        todoStats.style.display = '';
        todoStats.textContent = '(' + stats.done + ' / ' + stats.total + ')';
        setTodoChipVisible(true);

        // 写入会话级缓存，驱动侧边栏 badge 更新
        window.sessionTodoMap = window.sessionTodoMap || {};
        var cacheSid = typeof SESSION_ID !== 'undefined' ? SESSION_ID : null;
        if (cacheSid) {
            window.sessionTodoMap[cacheSid] = { done: stats.done || 0, total: stats.total || 0 };
            if (typeof updateHistoryUI === 'function') updateHistoryUI();
        }

        renderTodoItems(items);
    }

    function statusIcon(status) {
        if (status === 'done') return '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><polyline points="20 6 9 17 4 12"/></svg>';
        if (status === 'in_progress') return '<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" stroke="none" style="vertical-align: middle;"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
        return '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><circle cx="12" cy="12" r="10"/></svg>';
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function(c) {
            return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
        });
    }

    // 仅渲染右侧任务面板的条目列表（不触发额外请求）
    function renderTodoItems(items) {
        if (!todoList) return;
        if (!items || items.length === 0) {
            todoList.innerHTML = '';
            todoEmpty.style.display = '';
            todoEmpty.textContent = GourdI18n.t('todos.no_tasks');
            return;
        }
        todoEmpty.style.display = 'none';
        var html = '';
        var lastGroup = '';
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (item.group && item.group !== lastGroup) {
                html += '<div class="todo-group">' + escapeHtml(item.group) + '</div>';
                lastGroup = item.group;
            }
            html += '<div class="todo-item todo-' + item.status + '">' +
                '<span class="todo-check">' + statusIcon(item.status) + '</span>' +
                '<span class="todo-text">' + escapeHtml(item.text) + '</span>' +
                '</div>';
        }
        todoList.innerHTML = html;
    }

    // 清单文件有内容、却一行任务也解析不出来（历史脏数据：JSON 外壳 + 字面换行塌成单行）。
    // 给出可见提示并附原始片段，取代「静默隐藏按钮」——让用户至少知道异常在哪。
    function renderMalformedTodos(raw) {
        var snippet = String(raw).trim().replace(/\s+/g, ' ');
        if (snippet.length > 400) snippet = snippet.slice(0, 400) + '…';
        todoList.innerHTML = '<div class="todo-malformed">' +
            '<div class="todo-malformed-title">' + escapeHtml(GourdI18n.t('todos.malformed')) + '</div>' +
            '<pre class="todo-malformed-raw">' + escapeHtml(snippet) + '</pre>' +
            '</div>';
        todoEmpty.style.display = 'none';
        todoStats.style.display = 'none';
    }

    // 从 todowrite 的原始 markdown 解析任务条目（与后端 /web/chat/todos 的解析逻辑保持一致）
    function parseTodoMarkdown(raw) {
        var items = [];
        var currentGroup = '';
        var lines = String(raw || '').split('\n');
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            // ## 标题作为分组
            if (/^\s*##\s+.+$/.test(line)) {
                currentGroup = line.replace(/^\s*##\s+/, '').trim();
                continue;
            }
            // checkbox 行: - [ ] / - [/] / - [x] / - [X]
            var m = line.match(/^\s*-\s*\[([ xX/])\]\s+(.+)$/);
            if (m) {
                var statusChar = m[1];
                var status = statusChar === ' ' ? 'pending'
                    : (statusChar === '/' ? 'in_progress' : 'done');
                items.push({ status: status, text: m[2].trim(), group: currentGroup });
            }
        }
        return items;
    }

    function renderError() {
        if (!todoList || !todoEmpty || !todoStats) return;
        todoList.innerHTML = '';
        todoEmpty.style.display = '';
        todoEmpty.textContent = GourdI18n.t('todos.load_failed');
        todoStats.style.display = 'none';
        if (todoBadge) todoBadge.style.display = 'none';
        // 请求失败（网络抖动 / 后端重启中）是瞬态，不能当成「确认没有清单」：
        // 这里刻意不动 chip 可见性。旧写法 setTodoChipVisible(false) 会把 chip 收走，
        // 而面板又不再联动关闭（两者是平级 DOM，见 chat.html:135 / :245）——用户一旦关掉
        // 面板就再也找不到任务入口，直到下一次成功轮询，与注释声称的「不让控件消失」相反。
    }

    // ---- 输入框上方任务 chip / 浮层 ----
    // 只负责 chip 与 wrap 的显隐，不联动面板。数据回包一律走这个函数，
    // 避免「异步结果反过来关掉用户刚主动打开的面板」。
    function setTodoChipVisible(show) {
        // 置位 todo chip 可见性，再由共享函数汇算 #chatTodoChipWrap 显隐
        // （wrap 同时承载 todo chip 与 queue chip，任一可见即显示）
        window._todoChipVisible = !!show;
        if (todoChip) todoChip.style.display = show ? '' : 'none';
        if (typeof window.updateChipWrapVisibility === 'function') {
            window.updateChipWrapVisibility();
        } else if (todoChipWrap) {
            todoChipWrap.style.display = show ? 'flex' : 'none';
        }
    }

    // 说明：这里刻意不保留「数据驱动地收起 chip 并关掉面板」的旧 showTodoChip(show) 包装——
    // 「回包为空就顺手关面板」正是本 Bug 的执行器；面板的开合由用户交互（chip 点击 / 点击外部）独占。
    function openTodoPanel() {
        if (!todoPanel) return;
        if (typeof window.closeAllToolbarPanels === 'function') window.closeAllToolbarPanels(); // \u4E92\u65A5
        loadTodos();
        todoPanel.style.display = '';
        todoPanel.classList.add('show');
    }
    function hideTodoPanel() {
        if (todoPanel) { todoPanel.classList.remove('show'); todoPanel.style.display = 'none'; }
    }
    window.hideTodoPanel = hideTodoPanel;

    if (todoChip) {
        todoChip.addEventListener('click', function(e) {
            e.stopPropagation();
            if (todoPanel && todoPanel.classList.contains('show')) hideTodoPanel();
            else openTodoPanel();
        });
    }
    // \u70B9\u51FB\u6D6E\u5C42/chip \u4E4B\u5916\u6536\u8D77
    document.addEventListener('click', function(e) {
        if (!todoPanel || !todoPanel.classList.contains('show')) return;
        if (e.target.closest('#chatTodoPanel') || e.target.closest('#chatTodoChip')) return;
        hideTodoPanel();
    });

    // refresh button
    if (todoRefreshBtn) {
        todoRefreshBtn.addEventListener('click', loadTodos);
    }

    // 监听 WebSocket action chunk，当 todowrite 完成时直接从返回值提取统计
    if (typeof window._todoChunkHandlers === 'undefined') {
        window._todoChunkHandlers = [];
    }
    window._todoChunkHandlers.push(function(chunk) {
        if (chunk && chunk.toolName === 'todowrite') {
            var rawText = chunk.text || '';

            // 直接从 chunk.text 提取统计，避免二次请求。
            // 注意：action_end 的 text 是工具**返回值**，而后端 buildProgressFooter 输出的
            // 是「[进度] total: N, done: N, in-progress: N, pending: N.」（无括号）；
            // 旧正则只认带括号形态，从未命中过，导致 stats.total 恒为 0、todowrite 后
            // chip 被误隐藏（并连带关掉面板）。两种形态现在都兼容。
            var match = rawText.match(/\[\u8fdb\u5ea6\]\s*total:\s*(\d+),\s*done:\s*(\d+),\s*in-progress:\s*(\d+),\s*pending:\s*(\d+)/)
                     || rawText.match(/\(total:\s*(\d+),\s*done:\s*(\d+),\s*in-progress:\s*(\d+),\s*pending:\s*(\d+)\)/);
            var stats;
            if (match) {
                stats = {
                    total: parseInt(match[1]),
                    done: parseInt(match[2]),
                    inProgress: parseInt(match[3]),
                    pending: parseInt(match[4])
                };
            } else {
                // 兜底：页脚缺失/格式变更时，从原始 markdown 直接统计 checkbox
                // 兜底：格式不匹配时从 raw markdown 直接解析 checkbox 统计
                var total = 0, done = 0, inProgress = 0;
                var lines = rawText.split('\n');
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i];
                    if (/\- \[[ x/]\]/.test(line)) {
                        total++;
                        if (/\- \[x\]/i.test(line)) done++;
                        else if (/\- \[\/\]/.test(line)) inProgress++;
                    }
                }
                stats = {
                    total: total,
                    done: done,
                    inProgress: inProgress,
                    pending: total - done - inProgress
                };
            }

            // 更新右侧面板统计
            if (todoBadge) {
                var pending = (stats.pending || 0) + (stats.inProgress || 0);
                todoBadge.textContent = pending;
                todoBadge.style.display = pending > 0 ? '' : 'none';
            }
            if (todoStats && stats.total > 0) {
                todoStats.style.display = '';
                todoStats.textContent = '(' + stats.done + ' / ' + stats.total + ')';
            }

            // 写入会话级缓存，驱动侧边栏 badge 更新（使用 chunk.sessionId 而非 SESSION_ID）
            window.sessionTodoMap = window.sessionTodoMap || {};
            var sid = chunk.sessionId;
            if (sid) {
                window.sessionTodoMap[sid] = { done: stats.done, total: stats.total };
                if (typeof updateHistoryUI === 'function') updateHistoryUI();
            }

            // 实时重渲染右侧任务面板条目列表（仅当 chunk 属于当前展示的会话时）
            var currentSid = typeof SESSION_ID !== 'undefined' ? SESSION_ID : null;
            if (sid && currentSid && sid === currentSid) {
                var parsed = parseTodoMarkdown(rawText);
                // 解析不出条目时保留面板现状（可能是入参形态异常），真正的格式判定
                // 交给 loadTodos → renderTodos 那条走后端解析的权威路径，不在这里下结论
                if (parsed.length > 0) {
                    renderTodoItems(parsed);
                }
                setTodoChipVisible(stats.total > 0);
            }
        }
    });

    // expose for external calls
    window.loadTodos = loadTodos;
})();
