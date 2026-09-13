/* ===== app-file-changes.js ===== */
/* Per-run file change summaries, snapshot review, undo and reapply controls.
   呈现形态：输入区 chip 行中、紧随「任务」chip 的「变更按钮」（图标 + 文案 + 数量徽标 + 增删统计）；
   点击在输入区上方弹出变更面板（与任务面板同构：文件列表 + 审查/打开/撤销文件 + 整轮撤销/重新应用）。
   消息流不再渲染任何变更节点；无文件变更/新增的 run 不渲染任何内容。 */
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

    function reviewFile(sess, runId, file, button) {
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
    /* ===== 变更入口（输入区 chip 行，任务 chip 旁）+ 弹出面板 =====
       入口形态与「任务」chip 同族：图标 + 文案 + 数量徽标 + 增删统计；
       点击展开的变更面板与任务面板同构（点外收起、与其他工具栏面板互斥开合）。
       DOM 位于 chat.html 模板（#chatFileChangesChip / #chatFileChangesPanel），
       bootstrap 注入时机不保证早于本模块加载：元素一律延迟查找，节点被重挂后自动重取。 */
    var chipEl = null, panelEl = null, panelBodyEl = null, panelActionsEl = null;
    function ensureEls() {
        if (!chipEl || !chipEl.isConnected) chipEl = document.getElementById('chatFileChangesChip');
        if (!panelEl || !panelEl.isConnected) panelEl = document.getElementById('chatFileChangesPanel');
        if (!panelBodyEl || !panelBodyEl.isConnected) panelBodyEl = document.getElementById('fileChangesPanelBody');
        if (!panelActionsEl || !panelActionsEl.isConnected) panelActionsEl = document.getElementById('fileChangesPanelActions');
    }
    var panelOpen = false;
    /* chip 显隐先置位、再由共享汇算函数裁决容器显隐（与 todo / queue / 键位提示同一口径） */
    function setChipVisible(show) {
        ensureEls();
        window._fileChangesChipVisible = !!show;
        if (chipEl) chipEl.style.display = show ? '' : 'none';
        if (typeof window.updateChipWrapVisibility === 'function') window.updateChipWrapVisibility();
    }
    function hideFileChangesPanel() {
        ensureEls();
        panelOpen = false;
        if (panelEl) { panelEl.classList.remove('show'); panelEl.style.display = 'none'; }
    }
    window.hideFileChangesPanel = hideFileChangesPanel;
    function showFileChangesPanel() {
        ensureEls();
        if (!panelEl) return;
        panelOpen = true;
        panelEl.style.display = '';
        panelEl.classList.add('show');
    }
    /* 面板开合由 chip 点击独占（与任务面板同一套规则：互斥打开、点外收起）；
       刻意不做「数据驱动关闭」——异步回包不得收走用户刚打开的面板。 */
    function toggleFileChangesPanel() {
        if (panelOpen) { hideFileChangesPanel(); return; }
        var sess = (typeof sessionMap !== 'undefined' && sessionMap) ? sessionMap[activeSessionId] : null;
        var runKey = sess && sess._fileChangesLatestRun;
        var summary = (sess && runKey && sess._fileChangesByRun) ? sess._fileChangesByRun[runKey] : null;
        if (!summary) return;
        if (typeof window.closeAllToolbarPanels === 'function') window.closeAllToolbarPanels(); // 互斥
        showFileChangesPanel();
        renderPanel(sess, runKey);
        /* 打开时对账一次（3s 节流内静默跳过），补齐被裁剪的流式帧 */
        reconcile(sess, runKey);
    }
    /* 入口收敛为单 chip：同时只展示「最新一轮」的变更（见 upsert 的 updatedAt 门禁），
       展开态即面板开合本身（面板是全局单例，不再需要按 runId 记忆展开态）。 */
    /* 行级签名：覆盖所有影响该行渲染与交互的后端字段。binary 不出现在 DOM 上，
       但决定 reviewFile 走预览还是走二进制提示，必须计入，否则复用的行会拿旧值分流。 */
    function rowSignature(file) {
        return [file && file.path, file && file.changeType, file && file.state,
            num(file && file.additions), num(file && file.deletions),
            file && file.binary ? 1 : 0].join('\u0001');
    }
    /* chip 文本签名：计数与增删总量（含缺失时按 files 回落求和）变了才重写 chip.innerHTML */
    function headerSignature(summary, files) {
        return [num(summary.fileCount) != null ? num(summary.fileCount) : files.length,
            num(summary.additions), num(summary.deletions),
            statSum(files, 'additions'), statSum(files, 'deletions')].join('\u0001');
    }
    /* 操作区签名：只关心「该出现哪几个按钮」。与计数分开后，流式帧只刷文本不重建按钮，
       操作进行中的 button.disabled 不会被下一帧吞掉。 */
    function headActionsSignature(stats) {
        return (stats.undone > 0 ? 'R' : '-') + (stats.applied > 0 ? 'U' : '-');
    }
    /* chip 内容：图标 + 文案 + 数量徽标 + 增删统计，形态与「任务」chip 对齐（chip 本体即按钮）。 */
    function chipInnerHtml(summary, files) {
        var additions = num(summary.additions);
        var deletions = num(summary.deletions);
        var count = num(summary.fileCount) != null ? num(summary.fileCount) : files.length;
        return '<span class="tool-type-icon">' + FILE_SVG + '</span>'
            + '<span class="tool-name">' + t('title') + '</span>'
            + '<span class="file-changes-badge">' + count + '</span>'
            + diffStatHtml(additions != null ? additions : statSum(files, 'additions'),
                deletions != null ? deletions : statSum(files, 'deletions'));
    }
    function fillHeadActions(sess, runId, headActions, stats) {
        headActions.innerHTML = '';
        if (stats.undone > 0) {
            headActions.appendChild(actionButton('reapply-run', t('reapply_run'), REDO_SVG, function (button) {
                layConfirm(t('confirm_reapply_run'), function () { runOperation(sess, runId, '/web/chat/changes/reapply/run', 'reapply_success', button); });
            }));
        }
        if (stats.applied > 0) {
            headActions.appendChild(actionButton('undo-run', t('undo_run'), UNDO_SVG, function (button) {
                layConfirm(t('confirm_undo_run'), function () { runOperation(sess, runId, '/web/chat/changes/undo/run', 'undo_run_success', button); });
            }));
        }
    }
    function buildRow(sess, runId, file) {
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
            /* 未撤销：提供 审查 / 打开 / 撤销文件 三枚操作 */
            actions.appendChild(actionButton('review', t('review'), REVIEW_SVG, function (button) { reviewFile(sess, runId, file, button); }));
            if (canOpenFile(file)) actions.appendChild(actionButton('open', t('open'), OPEN_SVG, function () {
                if (typeof window.openFileViewer === 'function') window.openFileViewer(file.path, (file.path || '').split(/[\\/]/).pop(), rootFor(sess));
            }));
            actions.appendChild(actionButton('undo-file', t('undo_file'), UNDO_SVG, function (button) {
                layConfirm(t('confirm_undo_file', [file.path || '']), function () { undoFile(sess, runId, file, button); });
            }));
        }
        else {
            /* 已撤销：审查 / 打开 / 撤销文件 均不再需要，仅保留「已撤销」状态标签 */
            var state = document.createElement('span');
            state.className = 'file-change-state';
            state.textContent = t('undone');
            actions.appendChild(state);
        }
        row.appendChild(main);
        row.appendChild(actions);
        return row;
    }

    /* ===== 渲染：chip（常显）与面板（打开时）=====
       chip 只在签名变化时重写 innerHTML；面板行以 path 为复用键做增量更新，
       行缓存挂模块级（同时只有一个面板），换 run / 强制重建时整体作废。
       force=true 用于「后端字段没变但文案变了」的场景（语言切换）：签名不会变，必须绕过复用。 */
    var chipSig = null;
    var renderedChip = null;   // { runKey, revision } —— chip 正在展示的快照标识
    var panelCache = null;     // { runKey, actionsSig, warningSig, warning, rows }
    function renderChip(runKey, summary, force) {
        ensureEls();
        var files = Array.isArray(summary.files) ? summary.files : [];
        renderedChip = { runKey: runKey, revision: Number(summary.revision) || 0 };
        if (!chipEl) return;
        var sig = runKey + '\u0001' + headerSignature(summary, files);
        if (sig === chipSig && !force) return;
        chipSig = sig;
        chipEl.innerHTML = chipInnerHtml(summary, files);
    }
    function renderPanel(sess, runKey, force) {
        ensureEls();
        if (!panelBodyEl || !panelActionsEl) return;
        var summary = sess._fileChangesByRun ? sess._fileChangesByRun[runKey] : null;
        if (!summary) return;
        var files = Array.isArray(summary.files) ? summary.files : [];
        var stats = undoStats(summary, files);
        /* 换 run 或强制重建：行复用键是 path，跨 run 复用会把旧 run 的动作错挂到新行上 */
        if (force || !panelCache || panelCache.runKey !== runKey) {
            panelBodyEl.innerHTML = '';
            panelCache = { runKey: runKey, actionsSig: null, warningSig: undefined, warning: null, rows: {} };
        }
        var aSig = headActionsSignature(stats);
        if (panelCache.actionsSig !== aSig) {
            panelCache.actionsSig = aSig;
            fillHeadActions(sess, runKey, panelActionsEl, stats);
        }

        /* 不完整提示：始终占 body 首位，行列表跟在它后面 */
        var wSig = summary.possiblyIncomplete ? incompleteText(summary) : '';
        if (panelCache.warningSig !== wSig) {
            panelCache.warningSig = wSig;
            if (panelCache.warning && panelCache.warning.parentNode === panelBodyEl) panelBodyEl.removeChild(panelCache.warning);
            panelCache.warning = null;
            if (wSig) {
                var warning = document.createElement('div');
                warning.className = 'file-changes-warning';
                warning.textContent = wSig;
                panelBodyEl.insertBefore(warning, panelBodyEl.firstChild);
                panelCache.warning = warning;
            }
        }

        /* 行级增量：以 path 为复用键，签名相同的行原地复用（不重建、不重挂监听），
           只有变化/新增的行才重建，并按目标顺序就地插入。一个改 50 个文件的 run 里，
           每帧通常只有最后一个文件在长增删行数，于是每帧从 O(n) 全量重建降为 O(1) 重建。 */
        var keys = [], seen = {}, reuse = true, ki, key;
        for (ki = 0; ki < files.length; ki++) {
            key = String((files[ki] && files[ki].path) || '');
            /* path 是复用键；后端正常不会在同一 run 内重复下发同一 path。
               真出现重复就放弃复用，否则同一节点会被插入两次而少渲染一行。 */
            if (seen[key]) { reuse = false; break; }
            seen[key] = true;
            keys.push(key);
        }
        if (!reuse) {
            for (ki = 0; ki < files.length; ki++) keys[ki] = String((files[ki] && files[ki].path) || '');
            Object.keys(panelCache.rows).forEach(function (oldKey) {
                var el = panelCache.rows[oldKey].el;
                if (el.parentNode === panelBodyEl) panelBodyEl.removeChild(el);
            });
            panelCache.rows = {};
        }

        var nextRows = {};
        var cursor = panelCache.warning || null;   // 行始终排在 warning 之后
        files.forEach(function (file, index) {
            var rowKey = keys[index];
            var sig = rowSignature(file);
            var prev = reuse ? panelCache.rows[rowKey] : null;
            var row;
            if (prev && prev.sig === sig && prev.el.parentNode) {
                row = prev.el;
            } else {
                if (prev && prev.el.parentNode === panelBodyEl) panelBodyEl.removeChild(prev.el);
                row = buildRow(sess, runKey, file);
            }
            nextRows[rowKey] = { sig: sig, el: row };
            /* 位置不对才移动：insertBefore 对已挂载节点是移动，不会重建也不会丢监听 */
            var expected = cursor ? cursor.nextSibling : panelBodyEl.firstChild;
            if (row !== expected) panelBodyEl.insertBefore(row, cursor ? cursor.nextSibling : panelBodyEl.firstChild);
            cursor = row;
        });
        /* 摧掉本轮不再存在的行，以及 cursor 之后的任何残留 */
        Object.keys(panelCache.rows).forEach(function (oldKey) {
            if (nextRows[oldKey]) return;
            var el = panelCache.rows[oldKey].el;
            if (el.parentNode === panelBodyEl) panelBodyEl.removeChild(el);
        });
        if (cursor) { while (cursor.nextSibling) panelBodyEl.removeChild(cursor.nextSibling); }
        else { while (panelBodyEl.firstChild) panelBodyEl.removeChild(panelBodyEl.firstChild); }
        panelCache.rows = nextRows;
    }

    /* 统一渲染入口：chip 常显；面板仅在打开时刷新。无任何变更时 chip 隐藏、面板收起。 */
    function renderEverything(sess, force) {
        var runKey = sess && sess._fileChangesLatestRun;
        var summary = (sess && runKey && sess._fileChangesByRun) ? sess._fileChangesByRun[runKey] : null;
        if (!summary || !Array.isArray(summary.files) || !summary.files.length) {
            setChipVisible(false);
            hideFileChangesPanel();
            return;
        }
        setChipVisible(true);
        renderChip(runKey, summary, force);
        if (panelOpen) renderPanel(sess, runKey, force);
    }

    /* revision 单调门禁：任何来源（stream / 操作响应 / 对账）的旧 revision 一律丢弃。
       相同 revision 已由 chip 展示时不重复渲染；「最新一轮」由 updatedAt 决定归属，
       迟到的旧 run 对账 / 回放补帧不得把入口翻回上一轮。 */
    function chipShows(runKey, revision) {
        return !!renderedChip && renderedChip.runKey === runKey && renderedChip.revision === revision;
    }
    function upsert(sess, runId, summary) {
        if (!sess || !runId || !summary) return;
        /* 空快照（没有任何文件变更/新增）不生成任何入口：直接短路，不落缓存、不参与 revision 门禁。
           否则空 run（或流式早期的空帧）会留下「0 个文件」的空壳；
           且一旦空帧占用 revision，同 revision 的有效快照会被单调门禁误挡。 */
        if (!Array.isArray(summary.files) || !summary.files.length) return;
        if (!sess._fileChangesByRun) sess._fileChangesByRun = {};
        var runKey = String(runId);
        var previous = sess._fileChangesByRun[runKey];
        var revision = Number(summary.revision) || 0;
        var previousRevision = previous ? (Number(previous.revision) || 0) : -1;
        if (previous && revision < previousRevision) return;
        if (previous && revision === previousRevision && chipShows(runKey, revision)) return;
        sess._fileChangesByRun[runKey] = summary;

        /* 「最新一轮」门禁：无 updatedAt（后端旧版）时宽松放行，否则只有不早于当前展示轮的快照能接管。 */
        var ts = num(summary.updatedAt);
        var latestSummary = sess._fileChangesLatestRun ? sess._fileChangesByRun[sess._fileChangesLatestRun] : null;
        var latestTs = latestSummary ? num(latestSummary.updatedAt) : null;
        var isLatest = (sess._fileChangesLatestRun == null) || ts == null || latestTs == null || ts >= latestTs;
        if (isLatest) sess._fileChangesLatestRun = runKey;

        var created = !previous;
        if (isLatest && sess.sessionId === activeSessionId) renderEverything(sess);
        /* 回放期间不发起对账：逐帧重建时逐条请求纯属浪费，登记后由 replayDone 收口统一触发
           （仍走 reconcile 自身 3s 节流）。 */
        if (isLatest) {
            if (created && sess._replaying) deferReplayReconcile(sess, runKey);
            else if (created && !sess.isStreaming) reconcile(sess, runKey);
        }
    }

    window.onFileChangesChunk = function (sess, chunk) {
        var runId = chunk && chunk.runId;
        var summary = chunk && chunk.args;
        if (!runId || !summary || !Array.isArray(summary.files)) return;
        upsert(sess, String(runId), summary);
    };
    window.__fileChangesNormalizeSummary = normalizeSummary;
    window.refreshFileChangesRun = reconcile;
    /* 回放收口点（app-history.js replayDone）调这个把回放期登记的对账补上 */
    window.flushFileChangesReplayReconcile = flushReplayReconcile;
    /* 会话切换（app-streaming.js setActiveSession）调这个把入口切到新会话的「最新一轮」 */
    window.refreshFileChangesChip = function (sid) {
        var sess = (typeof sessionMap !== 'undefined' && sessionMap) ? sessionMap[sid] : null;
        if (!sess) { setChipVisible(false); hideFileChangesPanel(); return; }
        renderEverything(sess);
    };

    /* chip / 面板的点击交互：委托到 document，模板注入时机与重复挂载都不影响绑定。
       chip 点击 = 开/关面板；点面板与 chip 之外收起（与任务面板同规则）。 */
    document.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || typeof target.closest !== 'function') return;
        if (target.closest('#chatFileChangesChip')) {
            toggleFileChangesPanel();
            return;
        }
        if (!panelOpen) return;
        if (target.closest('#chatFileChangesPanel')) return;
        /* layui 确认弹层位于 body 下：确认撤销/重新应用期间不得收走面板 */
        if (target.closest('.layui-layer')) return;
        hideFileChangesPanel();
    });

    document.addEventListener('i18n:localeChanged', function () {
        /* 文案经 i18n key 渲染：签名不变也必须重建（chip 文本 + 打开中的面板行/按钮） */
        chipSig = null;
        if (panelCache) panelCache.runKey = null;
        var sess = (typeof sessionMap !== 'undefined' && sessionMap && typeof activeSessionId !== 'undefined') ? sessionMap[activeSessionId] : null;
        if (sess) renderEverything(sess, true);
    });
})();
