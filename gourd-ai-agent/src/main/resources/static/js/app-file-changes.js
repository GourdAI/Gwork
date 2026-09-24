/* ===== app-file-changes.js ===== */
/* Per-run file change summaries, snapshot review, undo and reapply controls.
   呈现形态：消息流中每轮（runId）消息节点组末尾的「变更卡片」（.msg-run-changes-card[data-run-id]）：
   头部 = 图标 + 「已编辑 N 个文件」+ 增删统计 + 审查/整轮撤销/重新应用；
    body = 文件行（kind 徽标 + 路径 + 增删统计，默认 3 行、其余折叠），
   行点击 = Monaco 快照 diff 审查查看器（唯一预览入口），头部审查 = 查看器轮文件列表。
   输入区不再渲染恒在 chip / 弹层；无文件变更/新增的 run 不渲染任何内容。 */
/* 契约对齐（后端 manifest summary）：
   summary: revision / status / ready / possiblyIncomplete / incompleteReasons[] /
            fileCount / additions / deletions / runApplyState(FULLY_APPLIED|PARTIALLY_UNDONE|FULLY_UNDONE) / files[]
   file:    path / changeType(ADDED|MODIFIED|DELETED) / binary / state(APPLIED|UNDONE) / additions / deletions
   diff:    status / path / changeType / binary / before / after / summary(嵌套 manifest summary)
   后端不提供 applyState / beforeExists / afterExists / beforeText / afterText / incompleteReason（单数）。 */
(function () {
    'use strict';

    var FILE_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 1.5h4.75l3.75 4.25v7.75a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.2"/><path d="M8.75 1.5v4.25h3.75" stroke="currentColor" stroke-width="1.2"/></svg>';
    var REVIEW_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4" stroke="currentColor" stroke-width="1.3"/><path d="m10 10 3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
    var OPEN_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 3.5h4l1.2 1.4H13v7.6H3z" stroke="currentColor" stroke-width="1.2"/><path d="m6 10 4-4m-2.5 0H10v2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var UNDO_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.5 4 2.5 7l3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 7h5.5a4 4 0 0 1 4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
    var REDO_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m10.5 4 3 3-3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 7H7.5a4 4 0 0 0-4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
    var CARET_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    /* changeType → 行首状态标记（CSS 类 kind-A/kind-M/kind-D 已在 app.css 中定义） */
    var KIND_BY_CHANGE_TYPE = { ADDED: 'A', MODIFIED: 'M', DELETED: 'D' };
    /* 后端状态枚举 → 本地化文案 key，禁止把裸枚举弹给用户 */
    var STATUS_MESSAGE_KEYS = {
        CONFLICT: 'error_conflict',
        NOT_FOUND: 'error_not_found',
        INVALID_REQUEST: 'error_invalid_request',
        ERROR_PARTIAL: 'error_partial',
        ERROR_COMPENSATED: 'error_compensated',
        ERROR: 'error_generic'
    };
    var RECONCILE_INTERVAL_MS = 3000;
    /* 卡片 body 默认展示行数，超出折叠为「再显示 N 个文件」 */
    var COLLAPSED_ROWS = 3;
    /* 审查请求代次：viewer 是全局单例，先点 A 再点 B 时，A 的慢响应回来会把 B 顶掉。
       所有 diff 响应必须校验代次，只有最后一次点击可以落到 viewer 上。 */
    var reviewGeneration = 0;
    var reviewAbort = null;

    function t(key, params) { return window.GourdI18n ? GourdI18n.t('file_changes.' + key, params) : key; }
    /* 仅用于「写操作 / 对账」响应：Result → data → （可选）嵌套 manifest summary。
       diff 响应不得走这里，否则会被下钻成嵌套 summary 而丢失 before/after/binary。 */
    function normalizeSummary(value) {
        var data = value && value.data !== undefined ? value.data : value;
        if (data && data.summary) data = data.summary;
        return data && typeof data === 'object' ? data : null;
    }
    function num(value) {
        if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
        var n = Number(value);
        return isFinite(n) ? n : null;
    }
    /* 文件级统计求和：全部缺失时返回 null（用于「无数据不渲染」） */
    function statSum(files, key) {
        var found = false, sum = 0;
        (files || []).forEach(function (file) {
            var value = num(file && file[key]);
            if (value != null) { found = true; sum += Math.max(0, value); }
        });
        return found ? sum : null;
    }
    /* 增删统计片段：无数据（或全为 0）时不渲染，避免出现无意义的 +0 -0 */
    function diffStatHtml(additions, deletions) {
        var add = num(additions), del = num(deletions);
        if (add == null && del == null) return '';
        add = Math.max(0, add || 0);
        del = Math.max(0, del || 0);
        if (!add && !del) return '';
        return '<span class="tool-diff-stat"><span class="add">+' + add + '</span><span class="del">-' + del + '</span></span>';
    }
    function rootFor(sess) { return (sess && sess.projectRoot) || ''; }
    /* root 为可选参数：有值才拼，空值不拼（不得因为空串放弃请求） */
    function rootQuery(sess) {
        var root = rootFor(sess);
        return root ? '&root=' + encodeURIComponent(root) : '';
    }
    function withRoot(sess, body) {
        var root = rootFor(sess);
        if (root) body.root = root;
        return body;
    }
    function operationId() {
        return 'file-change-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
    /* 状态标记只能来自 changeType（后端无 beforeExists/afterExists） */
    function fileKind(file) {
        var type = String((file && file.changeType) || '').toUpperCase();
        return KIND_BY_CHANGE_TYPE[type] || 'M';
    }
    function canOpenFile(file) {
        return String((file && file.changeType) || '').toUpperCase() !== 'DELETED';
    }
    function isUndoneState(state) {
        state = String(state || '').toUpperCase();
        return state.indexOf('UNDO') >= 0 || state === 'REVERTED' || state === 'ROLLED_BACK';
    }
    /* 文件撤销态字段为 file.state（APPLIED|UNDONE） */
    function isFileUndone(file) { return isUndoneState(file && file.state); }
    function canUndoFile(file) { return !isFileUndone(file); }
    /* 汇总撤销分布：优先按 files[].state 判定，缺失时回落 runApplyState / status */
    function undoStats(summary, files) {
        files = files || [];
        if (files.some(function (file) { return file && file.state != null; })) {
            var undone = files.filter(isFileUndone).length;
            return { undone: undone, applied: files.length - undone };
        }
        var runState = String((summary && (summary.runApplyState || summary.status)) || '').toUpperCase();
        if (runState === 'FULLY_UNDONE') return { undone: files.length, applied: 0 };
        if (isUndoneState(runState)) return { undone: files.length ? 1 : 0, applied: files.length };
        return { undone: 0, applied: files.length };
    }
    function incompleteText(summary) {
        var reasons = summary && summary.incompleteReasons;
        var list = (Array.isArray(reasons) ? reasons : (reasons ? [reasons] : []))
            .map(function (item) { return item == null ? '' : String(item).trim(); })
            .filter(Boolean);
        return list.length ? t('possibly_incomplete_detail', [list.join('; ')]) : t('possibly_incomplete');
    }
    function notify(key, type, params) {
        if (typeof window.showToast === 'function') window.showToast(t(key, params), type || 'info');
    }
    function statusOf(result) {
        var data = result && result.data;
        var status = (data && data.status) || (result && result.status);
        return String(status || '').toUpperCase();
    }
    /* 补充详情：后端 data.error.message 优先（ERROR_PARTIAL 等危险场景需要暴露给用户） */
    function detailOf(result) {
        var data = result && result.data;
        var detail = (data && data.error && data.error.message)
            || (data && data.message)
            || (result && (result.description || result.message));
        return typeof detail === 'string' ? detail.trim() : '';
    }
    function conflictMessage(result) {
        var data = result && result.data;
        var conflicts = data && data.conflicts;
        if (!Array.isArray(conflicts) || !conflicts.length) return t('error_conflict');
        var paths = conflicts.map(function (item) { return typeof item === 'string' ? item : ((item && item.path) || ''); }).filter(Boolean);
        return t('conflict', { count: conflicts.length, paths: paths.slice(0, 3).join(', ') });
    }
    /* 统一失败文案：枚举 → 本地化基础文案 + 可选详情，绝不裸露后端枚举 */
    function failureMessage(result) {
        var status = statusOf(result);
        var base = status === 'CONFLICT' ? conflictMessage(result)
            : (STATUS_MESSAGE_KEYS[status] ? t(STATUS_MESSAGE_KEYS[status]) : t('operation_failed'));
        var detail = detailOf(result);
        if (!detail || detail === status || detail === base) return base;
        return t('error_detail', [base, detail]);
    }
    function handleJson(response) {
        return response.json().catch(function () { return {}; }).then(function (result) {
            if (!response.ok || (result && result.code != null && result.code !== 200)) {
                var err = new Error(failureMessage(result));
                err.status = response.status;
                err.result = result;
                err.critical = statusOf(result) === 'ERROR_PARTIAL';
                throw err;
            }
            return result;
        });
    }
    function request(url, body) {
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(handleJson);
    }
    /* 操作响应回填：仅走 revision 单调门禁，不再回填 revision、不再 force 覆盖 */
    function applyResponse(sess, runId, result) {
        var summary = normalizeSummary(result);
        if (summary && Array.isArray(summary.files)) upsert(sess, runId, summary);
    }
    function reportFailure(sess, runId, err) {
        if (err && err.result) applyResponse(sess, runId, err.result);
        if (typeof window.showToast !== 'function') return;
        var message = (err && err.message) || t('operation_failed');
        window.showToast(message, 'error', err && err.critical ? 12000 : undefined);
    }

    function reviewFile(sess, runId, file, button, onOpened) {
        if (file.binary) { notify('binary_notice', 'info'); return; }
        if (button && button.disabled) return;
        if (button) button.disabled = true;
        /* Monaco 为 AMD 异步加载且首次加载昂贵；与网络请求并行预热，避免两段耗时串行叠加。 */
        if (typeof window.__monacoLoad === 'function') window.__monacoLoad(function () {});
        var gen = ++reviewGeneration;
        /* 取消上一次仍在途的审查请求：大文件 diff 响应可达十几 MB，不取消会一直占着带宽与解析线程。 */
        if (reviewAbort) { try { reviewAbort.abort(); } catch (e) {} }
        var controller = (typeof AbortController === 'function') ? new AbortController() : null;
        reviewAbort = controller;
        var url = '/web/chat/changes/diff?sessionId=' + encodeURIComponent(sess.sessionId)
            + '&runId=' + encodeURIComponent(runId) + '&path=' + encodeURIComponent(file.path || '')
            + rootQuery(sess);
        fetch(url, controller ? { signal: controller.signal } : undefined).then(handleJson).then(function (result) {
            if (gen !== reviewGeneration) return;
            /* diff 响应直接取 data，禁止再下钻到 summary，否则丢失 before/after/binary */
            var data = (result && result.data) || {};
            var nested = data.summary;
            if (nested && Array.isArray(nested.files)) upsert(sess, runId, nested);
            if (data.binary) { notify('binary_notice', 'info'); return; }
            var before = typeof data.before === 'string' ? data.before : null;
            var after = typeof data.after === 'string' ? data.after : null;
            if ((before !== null || after !== null) && typeof window.openSnapshotDiffViewer === 'function') {
                window.openSnapshotDiffViewer(data.path || file.path, before || '', after || '');
                /* 轮文件列表用这个回调挂「返回列表」；直接审查不传，查看器保持无返回态 */
                if (typeof onOpened === 'function') onOpened();
                return;
            }
            notify('diff_unavailable', 'info');
        }).catch(function (err) {
            if (gen !== reviewGeneration) return;          /* 被新点击取消，不算失败 */
            if (err && err.name === 'AbortError') return;
            notify('diff_failed', 'error', [(err && err.message) || '']);
        }).finally(function () {
            if (reviewAbort === controller) reviewAbort = null;
            if (button && button.isConnected) button.disabled = false;
        });
    }
    /* 查看器轮文件列表（app-gitdiff.js）行点击复用本模块的取数 + 代次防串链路 */
    window.reviewFileChange = reviewFile;

    function runOperation(sess, runId, endpoint, successKey, button) {
        if (button && button.disabled) return;
        if (button) button.disabled = true;
        request(endpoint, withRoot(sess, { sessionId: sess.sessionId, runId: runId, operationId: operationId() }))
            .then(function (result) { applyResponse(sess, runId, result); notify(successKey, 'success'); })
            .catch(function (err) { reportFailure(sess, runId, err); })
            .finally(function () { if (button && button.isConnected) button.disabled = false; });
    }
    function undoFile(sess, runId, file, button) {
        if (button && button.disabled) return;
        if (button) button.disabled = true;
        request('/web/chat/changes/undo/file', withRoot(sess, {
            sessionId: sess.sessionId, runId: runId, path: file.path, operationId: operationId()
        })).then(function (result) {
            applyResponse(sess, runId, result);
            notify('undo_file_success', 'success');
        }).catch(function (err) { reportFailure(sess, runId, err); })
            .finally(function () { if (button && button.isConnected) button.disabled = false; });
    }
    /* 对账刷新：会话切换/卡片首次渲染时校正被裁剪的 stream 状态；失败必须静默 */
    function reconcile(sess, runId) {
        if (!sess || !sess.sessionId || !runId) return;
        if (!sess._fileChangesReconciledAt) sess._fileChangesReconciledAt = {};
        var now = Date.now();
        if (now - (sess._fileChangesReconciledAt[runId] || 0) < RECONCILE_INTERVAL_MS) return;
        sess._fileChangesReconciledAt[runId] = now;
        fetch('/web/chat/changes/run?sessionId=' + encodeURIComponent(sess.sessionId)
            + '&runId=' + encodeURIComponent(runId) + rootQuery(sess))
            .then(function (response) {
                if (!response.ok) return null;
                return response.json().catch(function () { return null; });
            })
            .then(function (result) {
                if (!result || (result.code != null && result.code !== 200)) return;
                var summary = normalizeSummary(result);
                if (summary && Array.isArray(summary.files)) upsert(sess, String(runId), summary);
            })
            .catch(function () { /* 静默：对账失败不打扰用户 */ });
    }
    /* 回放在临时容器中重建 DOM；此时立即对账会让异步响应写入临时节点，甚至在节点迁移前
       又创建重复卡片。这里登记本次回放新建的 run，待 replayDone 将节点移入真实容器后，
       再由 flushReplayReconcile 统一触发一次对账（仍走 reconcile 自身的 3s 节流）。 */
    function deferReplayReconcile(sess, runId) {
        if (!sess._fileChangesReplayPending) sess._fileChangesReplayPending = {};
        sess._fileChangesReplayPending[runId] = true;
    }
    function flushReplayReconcile(sess) {
        var pending = sess && sess._fileChangesReplayPending;
        if (!pending) return;
        sess._fileChangesReplayPending = null;
        Object.keys(pending).forEach(function (runId) { reconcile(sess, runId); });
    }

    function actionButton(css, label, svg, handler) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'file-change-action ' + css;
        button.innerHTML = svg + '<span>' + label + '</span>';
        button.addEventListener('click', function (event) { event.stopPropagation(); handler(button); });
        return button;
    }
    function fileByPath(sess, runKey, path) {
        var summary = sess._fileChangesByRun && sess._fileChangesByRun[runKey];
        var files = summary && summary.files;
        if (!Array.isArray(files)) return null;
        for (var i = 0; i < files.length; i++) {
            if (files[i] && files[i].path === path) return files[i];
        }
        return null;
    }

    /* ===== 每轮变更卡片 =====
       卡片是消息容器内带 data-run-id 的兄弟节点，定位在该轮节点组末尾；
       回放期 renderRoot 指向临时容器，同一套逻辑天然随回放重建、随 rerun 删除。 */
    function cardsOf(sess) {
        if (!sess._fchCards) sess._fchCards = {};
        return sess._fchCards;
    }
    function cardCache(sess, runKey) {
        var map = cardsOf(sess);
        if (!map[runKey]) {
            map[runKey] = {
                el: null, headEl: null, titleEl: null, statEl: null, headActionsEl: null,
                bodyEl: null, toggleEl: null, warning: null,
                headSig: null, actionsSig: null, warningSig: undefined, toggleSig: null,
                rows: {}, expanded: false
            };
        }
        return map[runKey];
    }
    function createCardEl(sess, runKey) {
        var cache = cardCache(sess, runKey);
        var el = document.createElement('div');
        el.className = 'msg-run-changes-card';
        el.setAttribute('data-run-id', runKey);
        var head = document.createElement('div');
        head.className = 'fch-head';
        var icon = document.createElement('span');
        icon.className = 'fch-head-icon';
        icon.innerHTML = FILE_SVG;
        var title = document.createElement('span');
        title.className = 'fch-title';
        var stat = document.createElement('span');
        stat.className = 'fch-stat';
        var actions = document.createElement('span');
        actions.className = 'fch-head-actions';
        head.appendChild(icon);
        head.appendChild(title);
        head.appendChild(stat);
        head.appendChild(actions);
        var body = document.createElement('div');
        body.className = 'fch-body';
        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'fch-toggle';
        toggle.addEventListener('click', function () {
            cache.expanded = !cache.expanded;
            cache.toggleSig = null;
            renderCard(sess, runKey);
        });
        el.appendChild(head);
        el.appendChild(body);
        el.appendChild(toggle);
        cache.el = el;
        cache.headEl = head;
        cache.titleEl = title;
        cache.statEl = stat;
        cache.headActionsEl = actions;
        cache.bodyEl = body;
        cache.toggleEl = toggle;
        return el;
    }
    /* 该 run 的助手气泡：快路径用 currentBubbleEl（流式中就是当前气泡），
       慢路径（回放/迟到帧/会话切换）按 data-run-id 反查该 run 的最后一行气泡。 */
    function runBubbleOf(sess, runKey) {
        var bubble = sess.currentBubbleEl ? sess.currentBubbleEl.parentNode : null;
        var row = (bubble && bubble.closest) ? bubble.closest('.msg-row') : null;
        if (row && row.getAttribute('data-run-id') === runKey) return bubble;
        var root = (typeof renderRoot === 'function') ? renderRoot(sess) : null;
        if (!root || !root.querySelectorAll) return null;
        var rows = root.querySelectorAll('.msg-row.assistant[data-run-id="' + attrValueEscape(runKey) + '"]');
        if (!rows.length) return null;
        return $(rows[rows.length - 1]).find('.msg-bubble')[0] || rows[rows.length - 1];
    }
    /* ===== 卡片定位：该轮气泡的最底部 =====
       审查内容不参与正文流：卡片宿主恒为该轮助手气泡的最后一个子节点，位于 meta 行
       （结束时间）与操作按钮（复制/重跑/继续）之后——气泡内顺序固定为
       「正文 → 结束时间 → 操作按钮 → 变更卡片」。每轮各自持有一张卡，因此上拉到
       上一轮对话结尾时，那一轮的变更记录仍在原处可查，不会被后一轮替换。
       快路径：流式中 currentBubbleEl 就是该 run 的气泡；慢路径：回放/迟到帧/会话切换
       按 data-run-id 反查该 run 的最后一行气泡，不依赖 currentBubbleEl 指向。 */
    function runHostOf(sess, runKey) {
        if (!sess._fchHosts) sess._fchHosts = {};
        var host = sess._fchHosts[runKey];
        if (host && host.isConnected) return host;
        host = document.createElement('div');
        host.className = 'fch-host';
        sess._fchHosts[runKey] = host;
        var bubble = runBubbleOf(sess, runKey);
        if (bubble) bubble.appendChild(host);
        else {
            /* 气泡向未建（帧早于正文）：先落消息容器根，下次 positionCard 再迁入气泡 */
            var root0 = (typeof renderRoot === 'function') ? renderRoot(sess) : null;
            if (root0) root0.appendChild(host);
        }
        return host;
    }
    /* 定位：卡片入宿主；宿主恒在气泡末尾（收口后新节点可能晚于卡片插入，需重建末尾序）。 */
    function positionCard(sess, runKey) {
        var cache = cardsOf(sess)[runKey];
        var el = cache && cache.el;
        if (!el) return;
        var host = runHostOf(sess, runKey);
        if (el.parentNode !== host) host.appendChild(el);
        var bubble = runBubbleOf(sess, runKey);
        /* 已在末尾时 appendChild 虽是空操作，但会触发一次无谓的重排，故先判后搬 */
        if (bubble && (host.parentNode !== bubble || host.nextSibling)) bubble.appendChild(host);
    }

    window.repositionFileChangeCards = function (sess) {
        if (!sess || !sess._fileChangesByRun) return;
        flushPendingRenders(sess);
    };

    /* 行级签名：覆盖所有影响该行渲染与交互的后端字段。binary 不出现在 DOM 上，
       但决定点击/预览走 diff 还是二进制提示，必须计入，否则复用的行会拿旧值分流。 */
    function rowSignature(file) {
        return [file && file.path, file && file.changeType, file && file.state,
            num(file && file.additions), num(file && file.deletions),
            file && file.binary ? 1 : 0].join('\u0001');
    }
    function buildRow(sess, runKey, file) {
        var row = document.createElement('div');
        row.className = 'file-change-row' + (isFileUndone(file) ? ' is-undone' : '');
        row.title = file.path || '';
        var main = document.createElement('div');
        main.className = 'file-change-main';
        main.innerHTML = '<span class="file-change-kind kind-' + fileKind(file) + '">' + fileKind(file) + '</span>'
            + '<span class="file-change-path">' + escapeHtml(file.path || '') + '</span>'
            + diffStatHtml(file.additions, file.deletions);
        var actions = document.createElement('div');
        actions.className = 'file-change-row-actions';
        if (canUndoFile(file)) {
            /* 未撤销：提供 打开 / 撤销文件 两枚操作（审查=行点击，不再单独占按钮） */
            if (canOpenFile(file)) actions.appendChild(actionButton('open', t('open'), OPEN_SVG, function () {
                if (typeof window.openFileViewer === 'function') window.openFileViewer(file.path, (file.path || '').split(/[\\/]/).pop(), rootFor(sess));
            }));
            actions.appendChild(actionButton('undo-file', t('undo_file'), UNDO_SVG, function (button) {
                layConfirm(t('confirm_undo_file', [file.path || '']), function () { undoFile(sess, runKey, file, button); });
            }));
        }
        else {
            /* 已撤销：打开 / 撤销文件 均不再需要，仅保留「已撤销」状态标签 */
            var state = document.createElement('span');
            state.className = 'file-change-state';
            state.textContent = t('undone');
            actions.appendChild(state);
        }
        row.appendChild(main);
        row.appendChild(actions);
        row.addEventListener('click', function () {
            var current = fileByPath(sess, runKey, file.path) || file;
            reviewFile(sess, runKey, current, null);
        });
        return row;
    }

    /* 卡片渲染：头部/操作区/警告/行/折叠按钮各自签名增量更新，流式帧不全量重建 DOM。
       force=true 用于「后端字段没变但文案变了」的场景（语言切换）：签名不会变，必须绕过复用。 */
    /* 渲染时机：任务收口后才落卡。
       流式/回放期间只更新数据快照——中途变更会让卡片在正文底部反复增删跳动，且此刻用户
       关心的是模型在做什么，不是改了哪些文件。收口点 = finishStream / 回放 replayDone /
       会话切换补渲染。注意 file_changes 帧常在 run 收尾后才延迟到达（那时 isStreaming
       已是 false），此时直接渲染，不进待渲染登记。 */
    function renderAllowed(sess) { return !sess.isStreaming && !sess._replaying; }
    function markRenderPending(sess, runKey) {
        if (!sess._fchRenderPending) sess._fchRenderPending = {};
        sess._fchRenderPending[runKey] = true;
    }
    /* 收口：把流式/回放期登记的 run 一次性补渲染并定位（幂等，重复调用无副作用） */
    function flushPendingRenders(sess) {
        if (!sess || !sess._fileChangesByRun) return;
        var pending = sess._fchRenderPending;
        if (pending) sess._fchRenderPending = {};
        Object.keys(sess._fileChangesByRun).forEach(function (runKey) {
            if (pending && pending[runKey]) renderCard(sess, runKey);
            positionCard(sess, runKey);
        });
    }

    function renderCard(sess, runKey, force) {
        var summary = sess._fileChangesByRun ? sess._fileChangesByRun[runKey] : null;
        if (!summary || !Array.isArray(summary.files) || !summary.files.length) return;
        var cache = cardCache(sess, runKey);
        if (!cache.el || !cache.el.isConnected) {
            /* 节点被 rerun / 容器清空删除后重建：签名必须作废，否则新节点拿旧签名
               跳过填充，头部/操作区/折叠按钮会是空壳。 */
            cache.el = null;
            cache.rows = {};
            cache.warning = null;
            /* rerun 删除卡片但保留宿主（宿主无 data-run-id）：重建时清掉上一轮固化的
               结束时间，避免旧时间浮在新卡片上方 */
            var oldHost = sess._fchHosts && sess._fchHosts[runKey];
            if (oldHost) {
                var oldTime = oldHost.querySelector('.fch-run-time');
                if (oldTime && oldTime.parentNode) oldTime.parentNode.removeChild(oldTime);
            }
            cache.headSig = null;
            cache.actionsSig = null;
            cache.warningSig = undefined;
            cache.toggleSig = null;
            createCardEl(sess, runKey);
        }
        var files = summary.files;

        var additions = num(summary.additions), deletions = num(summary.deletions);
        var count = num(summary.fileCount) != null ? num(summary.fileCount) : files.length;
        var sumAdd = additions != null ? additions : statSum(files, 'additions');
        var sumDel = deletions != null ? deletions : statSum(files, 'deletions');
        var headSig = [count, sumAdd, sumDel].join('\u0001');
        if (force || cache.headSig !== headSig) {
            cache.headSig = headSig;
            cache.titleEl.textContent = t('edited_files', { count: count });
            cache.statEl.innerHTML = diffStatHtml(sumAdd, sumDel);
        }

        var stats = undoStats(summary, files);
        var actionsSig = 'V' + (stats.undone > 0 ? 'R' : '-') + (stats.applied > 0 ? 'U' : '-');
        if (force || cache.actionsSig !== actionsSig) {
            cache.actionsSig = actionsSig;
            cache.headActionsEl.innerHTML = '';
            cache.headActionsEl.appendChild(actionButton('review-run', t('review'), REVIEW_SVG, function () {
                if (typeof window.openRunChangesViewer === 'function') window.openRunChangesViewer(sess, runKey);
            }));
            if (stats.undone > 0) {
                cache.headActionsEl.appendChild(actionButton('reapply-run', t('reapply_run'), REDO_SVG, function (button) {
                    layConfirm(t('confirm_reapply_run'), function () { runOperation(sess, runKey, '/web/chat/changes/reapply/run', 'reapply_success', button); });
                }));
            }
            if (stats.applied > 0) {
                cache.headActionsEl.appendChild(actionButton('undo-run', t('undo_run'), UNDO_SVG, function (button) {
                    layConfirm(t('confirm_undo_run'), function () { runOperation(sess, runKey, '/web/chat/changes/undo/run', 'undo_run_success', button); });
                }));
            }
        }

        /* 不完整提示：始终占 body 之前一位，行列表跟在它后面 */
        var warningSig = summary.possiblyIncomplete ? incompleteText(summary) : '';
        if (force || cache.warningSig !== warningSig) {
            cache.warningSig = warningSig;
            if (cache.warning && cache.warning.parentNode === cache.el) cache.el.removeChild(cache.warning);
            cache.warning = null;
            if (warningSig) {
                var warning = document.createElement('div');
                warning.className = 'file-changes-warning';
                warning.textContent = warningSig;
                cache.el.insertBefore(warning, cache.bodyEl);
                cache.warning = warning;
            }
        }

        /* 行级增量：以 path 为复用键，签名相同的行原地复用（不重建、不重挂监听），
           只有变化/新增的行才重建，并按目标顺序就地插入。 */
        var bodyEl = cache.bodyEl;
        var visible = cache.expanded ? files : files.slice(0, COLLAPSED_ROWS);
        var keys = [], seen = {}, reuse = true, ki, key;
        for (ki = 0; ki < visible.length; ki++) {
            key = String((visible[ki] && visible[ki].path) || '');
            /* path 是复用键；后端正常不会在同一 run 内重复下发同一 path。
               真出现重复就放弃复用，否则同一节点会被插入两次而少渲染一行。 */
            if (seen[key]) { reuse = false; break; }
            seen[key] = true;
            keys.push(key);
        }
        if (!reuse) {
            for (ki = 0; ki < visible.length; ki++) keys[ki] = String((visible[ki] && visible[ki].path) || '');
            Object.keys(cache.rows).forEach(function (oldKey) {
                var el = cache.rows[oldKey].el;
                if (el.parentNode === bodyEl) bodyEl.removeChild(el);
            });
            cache.rows = {};
        }
        var nextRows = {};
        var cursor = null;
        visible.forEach(function (file, index) {
            var rowKey = keys[index];
            var sig = rowSignature(file);
            var prev = (!force && reuse) ? cache.rows[rowKey] : null;
            var row;
            if (prev && prev.sig === sig && prev.el.parentNode) {
                row = prev.el;
            } else {
                if (prev && prev.el.parentNode === bodyEl) bodyEl.removeChild(prev.el);
                row = buildRow(sess, runKey, file);
            }
            nextRows[rowKey] = { sig: sig, el: row };
            /* 位置不对才移动：insertBefore 对已挂载节点是移动，不会重建也不会丢监听 */
            var expected = cursor ? cursor.nextSibling : bodyEl.firstChild;
            if (row !== expected) bodyEl.insertBefore(row, expected);
            cursor = row;
        });
        /* 清掉本次不再展示的行（折叠收起 / 后端移除），以及 cursor 之后的任何残留 */
        Object.keys(cache.rows).forEach(function (oldKey) {
            if (nextRows[oldKey]) return;
            var el = cache.rows[oldKey].el;
            if (el.parentNode === bodyEl) bodyEl.removeChild(el);
        });
        if (cursor) { while (cursor.nextSibling) bodyEl.removeChild(cursor.nextSibling); }
        else { while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild); }
        cache.rows = nextRows;

        var toggleSig = (cache.expanded ? 1 : 0) + '\u0001' + files.length;
        if (force || cache.toggleSig !== toggleSig) {
            cache.toggleSig = toggleSig;
            if (files.length > COLLAPSED_ROWS) {
                cache.toggleEl.style.display = '';
                cache.toggleEl.className = 'fch-toggle' + (cache.expanded ? ' is-open' : '');
                cache.toggleEl.innerHTML = (cache.expanded
                    ? t('collapse_files')
                    : t('show_more_files', { count: files.length - COLLAPSED_ROWS }))
                    + '<span class="fch-caret" aria-hidden="true">' + CARET_SVG + '</span>';
                cache.toggleEl.setAttribute('aria-expanded', cache.expanded ? 'true' : 'false');
            } else {
                cache.toggleEl.style.display = 'none';
            }
        }
        positionCard(sess, runKey);
    }

    /* revision 单调门禁：任何来源（stream / 操作响应 / 对账）的旧 revision 一律丢弃；
       相同 revision 数据无变化，不重复渲染。 */
    function upsert(sess, runId, summary) {
        if (!sess || !runId || !summary) return;
        /* 空快照（没有任何文件变更/新增）不生成任何卡片：直接短路，不落缓存、不参与 revision 门禁。
           否则空 run（或流式早期的空帧）会留下「0 个文件」的空壳；
           且一旦空帧占用 revision，同 revision 的有效快照会被单调门禁误挡。 */
        if (!Array.isArray(summary.files) || !summary.files.length) return;
        if (!sess._fileChangesByRun) sess._fileChangesByRun = {};
        var runKey = String(runId);
        var previous = sess._fileChangesByRun[runKey];
        var revision = Number(summary.revision) || 0;
        var previousRevision = previous ? (Number(previous.revision) || 0) : -1;
        if (previous && revision <= previousRevision) return;
        sess._fileChangesByRun[runKey] = summary;

        if (renderAllowed(sess)) renderCard(sess, runKey);
        else markRenderPending(sess, runKey);
        /* 回放期间不发起对账：逐帧重建时逐条请求纯属浪费，登记后由 replayDone 收口统一触发
           （仍走 reconcile 自身 3s 节流）。 */
        if (!previous) {
            if (sess._replaying) deferReplayReconcile(sess, runKey);
            else if (!sess.isStreaming) reconcile(sess, runKey);
        }
    }

    window.onFileChangesChunk = function (sess, chunk) {
        var runId = chunk && chunk.runId;
        var summary = chunk && chunk.args;
        if (!runId || !summary || !Array.isArray(summary.files)) return;
        upsert(sess, String(runId), summary);
    };
    /* 会话切换时补渲染：帧早于容器创建到达的卡片在这里补齐（渲染增量幂等，重复调用无副作用） */
    window.renderSessionFileChangeCards = function (sess) {
        if (!sess || !sess._fileChangesByRun) return;
        flushPendingRenders(sess);
    };
    /* 回放收口点（app-history.js replayDone）调这个把回放期登记的对账补上 */
    /* 回放收口点（app-history.js replayDone）除了补对账，还要把回放期登记的卡片补渲染：
       回放期 _replaying 为真，卡片一律只登记不渲染，没有这一步历史会话的变更记录会整片消失。 */
    window.flushFileChangesReplayRender = function (sess) { flushPendingRenders(sess); };
    window.flushFileChangesReplayReconcile = flushReplayReconcile;

    document.addEventListener('i18n:localeChanged', function () {
        /* 文案经 i18n key 渲染：签名不变也必须重建（卡片头部/行/按钮/折叠文案） */
        if (typeof sessionMap === 'undefined' || !sessionMap) return;
        Object.keys(sessionMap).forEach(function (sid) {
            var sess = sessionMap[sid];
            if (!sess || !sess._fileChangesByRun) return;
            Object.keys(sess._fileChangesByRun).forEach(function (runKey) { renderCard(sess, runKey, true); });
        });
    });
})();
