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
            .filter(Boolean)
            .filter(function(r) { return r !== 'bash was invoked and may have changed untracked files'; });
        return list.length ? t('possibly_incomplete_detail', [list.join('; ')]) : '';
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
    /* 未收口轮次的对账延后登记（与 _fileChangesReplayPending 刻意分开）：
       后者在 replayDone 无条件清空并全量对账，若把「仍在跑的轮次」混进去，
       回放一个运行中会话时活跃轮会被提前对账→提前回填→提前出卡。 */
    function markReconcilePending(sess, runKey) {
        if (!sess._fchReconcilePending) sess._fchReconcilePending = {};
        sess._fchReconcilePending[runKey] = true;
    }
    /* 轮次收口时补做被延后的对账（仍受 reconcile 自身 3s 节流） */
    function flushReconcilePending(sess, runKey) {
        var pending = sess && sess._fchReconcilePending;
        if (!pending || !pending[runKey]) return;
        delete pending[runKey];
        reconcile(sess, runKey);
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
    /* 属性选择器值转义（CSS.escape 不覆盖引号语义）：runId 是 UUID 恒安全，但本函数
       不应依赖任何未声明的全局——曾因引用未定义的 attrValueEscape 导致回放/切换后
       慢路径整体抛 ReferenceError，变更卡片在重启后永久消失（快路径 currentBubbleEl
       命中时永不执行，流式期看不出来）。 */
    function attrValueEscape(value) {
        return String(value == null ? '' : value)
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"');
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
    /* ===== 卡片定位：页脚（时长徽章/操作按钮）之上、正文之下 =====
       审查内容不参与正文流：卡片宿主锚定在该轮助手气泡的页脚之前——气泡内顺序固定为
       「正文 → 变更卡片 → 时长徽章 → 操作按钮」。总时长是整轮的收尾性总结，必须出现在
       卡片之后（此前曾把宿主追加到气泡末尾，导致时长徽章跑到审查卡片上方、按钮与卡片
       之间夹出一段空白）。每轮各自持有一张卡，因此上拉到上一轮对话结尾时，那一轮的
       变更记录仍在原处可查，不会被后一轮替换。
       快路径：流式中 currentBubbleEl 就是该 run 的气泡；慢路径：回放/迟到帧/会话切换
       按 data-run-id 反查该 run 的最后一行气泡，不依赖 currentBubbleEl 指向。 */
    /* 页脚锚点：气泡内首个 meta/actions 节点（ensureAssistantBubble 固定产出
       「正文 → msg-meta-row → msg-actions」）。页脚之前 = 正文流的末端。
       不用 jQuery $(bubble).find：路径性能无关紧要（收口期一次），且避免测试沙箱的 $ 桩
       find 实现差异导致宿主定位在沙箱与浏览器两套行为。 */
    function bubbleFooterOf(bubble) {
        if (!bubble) return null;
        for (var ci = 0; ci < bubble.childNodes.length; ci++) {
            var n = bubble.childNodes[ci];
            /* 用 classList 判别（真实 DOM 文本节点与沙箱桩文本节点都无 classList）：
               不能用 nodeType===1——测试沙箱桩元素不带 nodeType，会把页脚误判为不存在 */
            if (!n || !n.classList || !n.classList.contains) continue;
            if (n.classList.contains('msg-meta-row') || n.classList.contains('msg-actions')) return n;
        }
        return null;
    }
    /* 宿主入位：插到页脚之前；无页脚（异常结构）时退回气泡末尾。返回实际插入引用节点。 */
    function placeHostInBubble(bubble, host) {
        var footer = bubbleFooterOf(bubble);
        if (footer) {
            if (host.parentNode !== bubble || host.nextSibling !== footer) bubble.insertBefore(host, footer);
            return footer;
        }
        if (host.parentNode !== bubble || host.nextSibling) bubble.appendChild(host);
        return null;
    }
    function runHostOf(sess, runKey) {
        if (!sess._fchHosts) sess._fchHosts = {};
        var host = sess._fchHosts[runKey];
        if (host && host.isConnected) return host;
        host = document.createElement('div');
        host.className = 'fch-host';
        sess._fchHosts[runKey] = host;
        var bubble = runBubbleOf(sess, runKey);
        if (bubble) placeHostInBubble(bubble, host);
        else {
            /* 气泡向未建（帧早于正文）：先落消息容器根，下次 positionCard 再迁入气泡 */
            var root0 = (typeof renderRoot === 'function') ? renderRoot(sess) : null;
            if (root0) root0.appendChild(host);
        }
        return host;
    }
    /* 定位：卡片入宿主；宿主恒在页脚（时长徽章/操作按钮）之前（收口后新节点可能晚于
       卡片插入，需重建「正文 → 卡片 → 页脚」序）。 */
    function positionCard(sess, runKey) {
        var cache = cardsOf(sess)[runKey];
        var el = cache && cache.el;
        if (!el) return;
        var host = runHostOf(sess, runKey);
        if (el.parentNode !== host) host.appendChild(el);
        var bubble = runBubbleOf(sess, runKey);
        if (bubble) placeHostInBubble(bubble, host);
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
    /* 渲染时机：【该轮真收口】后才落卡。
        流式/回放期间只更新数据快照——中途变更会让卡片在正文底部反复增删跳动，且此刻用户
        关心的是模型在做什么，不是改了哪些文件。收口点 = finishStream / 回放 replayDone /
        会话切换补渲染。注意 file_changes 帧常在 run 收尾后才延迟到达（那时 isStreaming
        已是 false），此时直接渲染，不进待渲染登记。

        【为何不能只看 isStreaming（已实证的四条泄漏路径）】
        isStreaming 是「会话级」旗标，而卡片是「run 级」产物，两者粒度不匹配就会漏：
        1) 挂起态：ask_user 问答卡 / HITL 审批卡挂起时后端也发 done，finishStream 已把
           isStreaming 置 false，但引擎只是等用户拍板、随时会带同一 runId 继续跑。
           此时出卡 = 「任务还在运行中就展示了变更」（用户实际看到的缺陷）。
        2) 切回运行中的会话：setActiveSession → renderSessionFileChangeCards 无条件 flush，
           而该会话 isStreaming 仍为 true。
        3) 回放一个「仍在运行」的会话：replayDone 把 isStreaming 恢复为 true，但同一批
           flush 里既有已收口的历史轮（必须出卡，否则回归）、又有活跃轮（不得出卡）——
           会话级旗标无论怎么取都会顾此失彼。
        4) 首个帧就是 file_changes（Loop 定时任务 / 后端推送）：它走被动分支不推进
           currentRunId，currentRunId 仍为 null，无法区分它是不是当前活跃轮。
        故门禁下沉到 run 级（runSettled）：先问「这一轮还是不是活跃轮」，再问「活跃轮到底
        收没收口」。 */
    function runSettled(sess, runKey) {
        if (!sess || !runKey) return false;
        /* 回放中 DOM 写在临时容器里，一律延到 replayDone 收口后统一渲染 */
        if (sess._replaying) return false;
        /* 当前活跃轮未知（currentRunId 为空）时保守归为活跃轮：
           对应上面泄漏路径 4——file_changes 不推进 currentRunId，首个帧就可能是它。 */
        var current = String(sess.currentRunId || '');
        var isActiveRun = !current || current === String(runKey);
        if (!isActiveRun) return true;   /* 历史轮：已收口，不会再收到新帧 */
        if (sess.isStreaming) return false;
        /* 挂起态（等用户作答/审批）：isStreaming 已被 finishStream 置 false，但任务未结束。
           标记由 finishStream 按 keepBatchIndex 落盘（同一 runId 恢复后真收口时会被清掉）。 */
        if (sess._runSuspended) return false;
        return true;
    }
    function markRenderPending(sess, runKey) {
        if (!sess._fchRenderPending) sess._fchRenderPending = {};
        sess._fchRenderPending[runKey] = true;
    }
    /* 收口：把流式/回放期登记的 run 一次性补渲染并定位（幂等，重复调用无副作用）。
        【必须逐个 run 过 runSettled 门禁】本函数会被三个收口点调用，其中两个（回放 replayDone /
        会话切换）并不能保证任务已结束；无条件 renderCard 正是「运行中就展示」的直接成因。
        未收口的 run 重新登记，等下一个收口点重试（不丢卡）。 */
    function flushPendingRenders(sess) {
        if (!sess || !sess._fileChangesByRun) return;
        var pending = sess._fchRenderPending;
        if (pending) sess._fchRenderPending = {};
        Object.keys(sess._fileChangesByRun).forEach(function (runKey) {
            if (pending && pending[runKey]) {
                if (runSettled(sess, runKey)) {
                    renderCard(sess, runKey);
                    flushReconcilePending(sess, runKey);
                } else markRenderPending(sess, runKey);
            }
            /* 定位不受门禁限制：已渲染过的卡片（历史轮）仍需要收敛到气泡末尾；
               未渲染的 run 在 positionCard 内部因 el 为空自行短路。 */
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

        if (runSettled(sess, runKey)) {
            renderCard(sess, runKey);
            /* 本次帧到达即收口：若之前因未收口而延后过对账，这里补上。
               不放在 flushPendingRenders 里等：那里只在 pending 登记存在时才跑，
               而「迟到帧直接渲染」这条路根本没进过 pending。 */
            flushReconcilePending(sess, runKey);
        } else markRenderPending(sess, runKey);
        /* 回放期间不发起对账：逐帧重建时逐条请求纯属浪费，登记后由 replayDone 收口统一触发
            （仍走 reconcile 自身 3s 节流）。运行中也不对账：对账响应会回填 upsert，
            而未收口的轮次此时根本不该出现在界面上。 */
        if (!previous) {
            if (sess._replaying) deferReplayReconcile(sess, runKey);
            else if (runSettled(sess, runKey)) reconcile(sess, runKey);
            else markReconcilePending(sess, runKey);
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
