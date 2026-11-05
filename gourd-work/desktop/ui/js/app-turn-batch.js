/* ===== app-turn-batch.js ===== */
/* 运行态批次折叠（对标 Qoder 运行态消息展示）。
 *
 * 语义：一轮运行中，思考块 / 工具卡 / 并行批次组 / 子代理卡等「过程行」归入一个批次盖子
 *   （button.turn-batch-header，气泡直接子级）之下：
 *     · 运行中：盖子显示「正在执行中 · Ns」（秒级 ticking），成员实时展开；
 *     · 批次收口（正文到达 / 错误到达 / 轮结束）：盖子变「已处理」，成员自动折叠；
 *     · 点击盖子：展开 / 收起该批成员（aria-expanded 同步）。
 *   收口后再出现的过程行开启【新】批次（旧批次保持折叠）——与 Qoder 多批次并列形态一致。
 *
 * 为什么盖子是「气泡直接子级的独立行」而不是包装容器：
 *   app.css:825 有 `.agent-card-body > .thinking-block + .md-content` 这类相邻兄弟选择器，
 *   历史上插包装节点导致过分组折叠静默失效（见 app-turn-compact.js 头注）。盖子只是一行
 *   button，成员仍是气泡直接子级，兄弟关系不变；成员可见性由成员自身类
 *   .turn-batch-collapsed 控制（JS 管理），CSS 只有一条极窄的隐藏规则。
 *
 * 与按轮 Compact（app-turn-compact.js）的分工：
 *   本模块管【运行态 / 轮内批次】的实时折叠；轮彻底结束后 turn-compact 把整轮（含批次盖子）
 *   收成一行统计摘要。故盖子在 turn-compact 的 classifyChildren 里被视作过程行（见该模块
 *   PROCESS_SELECTOR），buildSummary 不对其计数（它不是工具/思考证据本身）。
 *
 * 回放（sess._replaying）不建盖子：历史由事件重建，无批次帧；旧会话自然无盖子，不补造。
 *
 * UMD：浏览器挂 window.GourdTurnBatch，Node 走 module.exports，供契约测试真跑。
 * 计时 ticker 仅在 window 存在时启动（Node 测试只装 document 不装 window，避免悬挂定时器）。 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.GourdTurnBatch = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    'use strict';

    /* 过程行类名：与 app-turn-compact.js 的 PROCESS_SELECTOR 同口径（不含盖子自身）。 */
    var PROCESS_CLASSES = ['thinking-block', 'tool-card', 'tool-batch-group', 'agent-card'];

    /* 向下 chevron（展开态）；收起态由 CSS 旋转 -90deg 表达，不换图形 */
    var CHEVRON_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" '
        + 'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg>';

    function isProcessRow(el) {
        if (!el || !el.classList) return false;
        for (var i = 0; i < PROCESS_CLASSES.length; i++) {
            if (el.classList.contains(PROCESS_CLASSES[i])) return true;
        }
        return false;
    }

    /* 耗时文本：与 trace 徽标 / turn-compact 摘要同口径（亚秒不写 0s）。 */
    function formatBatchElapsed(ms) {
        if (ms == null || !(ms >= 0)) return null;
        var s = Math.round(ms / 1000);
        if (s < 1) return '<1s';
        if (s >= 3600) {
            var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
            return h + 'h' + (m > 0 ? ' ' + m + 'min' : '') + (r > 0 ? ' ' + r + 's' : '');
        }
        if (s >= 60) { var mm = Math.floor(s / 60), rr = s % 60; return rr > 0 ? mm + 'min ' + rr + 's' : mm + 'min'; }
        return s + 's';
    }

    /* i18n 回落：与 turn-compact 的三重校验同口径（缺键可能返回裸 key / 空串 / 非字符串）。 */
    function makeTr(translate) {
        var trans = typeof translate === 'function' ? translate : null;
        return function (key, fallback) {
            if (!trans) return fallback;
            var v;
            try { v = trans(key); } catch (e) { return fallback; }
            if (typeof v !== 'string' || !v.trim()) return fallback;
            if (/^(chat|app|history|queue|settings)\.[\w.]+$/.test(v.trim())) return fallback;
            return v;
        };
    }

    function windowTranslate() {
        return (typeof window !== 'undefined' && window.GourdI18n && window.GourdI18n.t)
            ? function (k) { return window.GourdI18n.t(k); } : null;
    }

    /* 盖子文案：运行中 = 「正在执行中 · Ns」；收口 = 「已处理」。
       收口态刻意不带耗时：轮级耗时已有 trace 徽标与 turn-compact 摘要两处落点，
       批次再叠一个数字只会制造第三个口径。 */
    function labelText(header, translate) {
        if (!header || !header.getAttribute) return '';
        var tr = makeTr(translate);
        if (header.getAttribute('data-batch-state') === 'closed') {
            return tr('chat.batch_done', '已处理');
        }
        var base = tr('chat.batch_running', '正在执行中');
        var start = Number(header.getAttribute('data-batch-start'));
        if (!isFinite(start) || start <= 0) return base;
        var elapsed = formatBatchElapsed(Date.now() - start);
        return elapsed ? base + ' · ' + elapsed : base;
    }

    function setLabel(header, translate) {
        if (!header || !header.querySelector) return;
        var span = header.querySelector('.turn-batch-label');
        if (span) span.textContent = labelText(header, translate);
    }

    /* 批次成员 = 盖子之后、下一个盖子之前的直接子级过程行（带 data-turn-batch 标记）。
       用兄弟区间而非全局 querySelectorAll：一个气泡内允许多个先后批次并存。 */
    function membersOf(header) {
        var out = [];
        if (!header || !header.parentNode) return out;
        var kids = header.parentNode.children || [];
        var seen = false;
        for (var i = 0; i < kids.length; i++) {
            var el = kids[i];
            if (el === header) { seen = true; continue; }
            if (!seen) continue;
            if (el.classList && el.classList.contains('turn-batch-header')) break;
            if (el.getAttribute && el.getAttribute('data-turn-batch') === '1') out.push(el);
        }
        return out;
    }

    function lastHeader(bubble) {
        if (!bubble || !bubble.querySelectorAll) return null;
        var hs = bubble.querySelectorAll('.turn-batch-header');
        return hs && hs.length ? hs[hs.length - 1] : null;
    }

    /* 成员可见性单一入口：open=true 移除折叠类，false 加上；盖子 aria / chevron 类同步。 */
    function applyMembers(header, open) {
        if (!header) return;
        var ms = membersOf(header);
        for (var i = 0; i < ms.length; i++) {
            if (open) ms[i].classList.remove('turn-batch-collapsed');
            else ms[i].classList.add('turn-batch-collapsed');
        }
        if (open) header.classList.add('turn-batch-open');
        else header.classList.remove('turn-batch-open');
        header.setAttribute('aria-expanded', open ? 'true' : 'false');
        header.setAttribute('data-batch-open', open ? 'true' : 'false');
    }

    /* 新建盖子必须紧贴【首个成员】上方：插 firstChild 会越过已存在的正文/旧盖子，
       把新批次的顶盖挂到气泡最顶（旧批次成员反而落在盖子外面）。复用运行盖子不移动。 */
    function createHeader(bubble, beforeEl) {
        var h = document.createElement('button');
        h.type = 'button';
        h.className = 'turn-batch-header turn-batch-open';
        h.setAttribute('aria-expanded', 'true');
        h.setAttribute('data-batch-state', 'running');
        h.setAttribute('data-batch-open', 'true');
        h.setAttribute('data-batch-start', String(Date.now()));
        h.innerHTML = '<span class="turn-batch-chevron">' + CHEVRON_SVG + '</span>'
            + '<span class="turn-batch-label"></span>';
        h.addEventListener('click', function (ev) {
            if (ev && ev.stopPropagation) ev.stopPropagation();
            var open = h.getAttribute('data-batch-open') === 'true';
            applyMembers(h, !open);
            setLabel(h, windowTranslate());
        });
        if (bubble.insertBefore) bubble.insertBefore(h, beforeEl || bubble.firstChild);
        setLabel(h, windowTranslate());
        return h;
    }

    /* 偏好开关：与按轮 Compact 共用 gourd.turnCompact === '0'（一键回退同一口径）。
       用户关掉折叠偏好时，运行态批次盖子也不得新建——否则「回退」只回退了一半。 */
    function batchDisabled() {
        try {
            return (typeof localStorage !== 'undefined') && localStorage.getItem('gourd.turnCompact') === '0';
        } catch (e) { return false; }
    }

    /* 一键回退：移除容器内全部盖子与成员标记（偏好关闭 / 回放重跑前调用）。
       成员本身不动，只摘批次归属，恢复为全可见平铺。 */
    function clearBatch(container) {
        if (!container || !container.querySelectorAll) return;
        var hs = container.querySelectorAll('.turn-batch-header');
        for (var i = hs.length - 1; i >= 0; i--) {
            if (hs[i].parentNode) hs[i].parentNode.removeChild(hs[i]);
        }
        var ms = container.querySelectorAll('[data-turn-batch]');
        for (var j = 0; j < ms.length; j++) {
            ms[j].removeAttribute('data-turn-batch');
            if (ms[j].classList) ms[j].classList.remove('turn-batch-collapsed');
        }
    }

    /* 展开容器内全部批次成员（盖子同步回 open 态），但【不删】盖子。
       用于失败/无正文轮：turn-compact 放弃折叠时，过程证据也不得被批次收口藏住。
       与 clearBatch 的区别：保留盖子与归属标记（轮结束后它仍会被 turn-compact 收起）。 */
    function revealAll(container) {
        if (!container || !container.querySelectorAll) return 0;
        var hs = container.querySelectorAll('.turn-batch-header');
        for (var i = 0; i < hs.length; i++) applyMembers(hs[i], true);
        return hs.length;
    }

    /* 过程行【落 DOM 之后】调用：归入当前运行批次；无运行批次则新开一个盖子，
       盖子必须紧贴该行上方（批次组的顶盖）。 */
    function noteProcessInsert(sess, el) {
        if (!sess || sess._replaying || !el || !el.setAttribute) return null;
        if (batchDisabled()) return null;
        var bubble = el.parentNode;
        if (!bubble || !bubble.querySelector) return null;
        // 只认主气泡：子代理卡体（.agent-card-body）内的过程行不建盖子
        if (!bubble.classList || !bubble.classList.contains('msg-bubble')) return null;
        /* 成员门禁：只有四类过程行能进批次。正文 md-content / 错误 / HITL / 问答卡 /
           文件变更卡 / trace 徽标等一律不是成员（它们在盖子外保持可见）。
           漏了这道门，正文块会被盖上 data-turn-batch 并被收口折叠 = 答案被藏。 */
        if (!isProcessRow(el)) return null;
        var header = lastHeader(bubble);
        if (header && header.getAttribute('data-batch-state') === 'running') {
            /* 【邻接校验】成员区必须是盖子之后的连续一段：本行的前一个兄弟必须恰为
               「末成员（无成员时即盖子）」。错误 / HITL / 重试提示等非成员行夹入后，
               再来的过程行若仍挂旧盖子，折叠时隐藏行与可见行会交错穿插（盖子与成员
               在屏幕上分离）。不邻接 = 批次已被非过程行切断 → 开新批次。 */
            var ms = membersOf(header);
            var expected = ms.length ? ms[ms.length - 1] : header;
            var kids = bubble.children || [];
            var iEl = Array.prototype.indexOf.call(kids, el);
            var prev = iEl > 0 ? kids[iEl - 1] : null;
            if (prev !== expected) header = null;
        } else {
            header = null;
        }
        if (!header) header = createHeader(bubble, el);
        el.setAttribute('data-turn-batch', '1');
        return header;
    }

    /* 收口：气泡内【全部】运行批次 → 「已处理」+ 成员折叠（倒序遍历，收口不改变集合）。
       只收最后一个会漏掉被非成员行切断后并存的早前运行批次：它们的盖子会永远停在
       「正在执行中 · Ns」，轮结束后文案撒谎。零成员的盖子直接移除（空壳比不显示更
       误导，与孤儿骨架卡同一哲学）。返回是否有批次被收口/移除。 */
    function closeBatchFor(bubble, nowMs) {
        if (!bubble || !bubble.querySelectorAll) return false;
        var hs = bubble.querySelectorAll('.turn-batch-header');
        var now = typeof nowMs === 'number' ? nowMs : Date.now();
        var changed = false;
        for (var i = hs.length - 1; i >= 0; i--) {
            var header = hs[i];
            if (!header.getAttribute || header.getAttribute('data-batch-state') !== 'running') continue;
            var ms = membersOf(header);
            if (ms.length === 0) {
                if (header.parentNode) header.parentNode.removeChild(header);
                changed = true;
                continue;
            }
            var start = Number(header.getAttribute('data-batch-start'));
            if (isFinite(start) && start > 0) {
                header.setAttribute('data-batch-elapsed', String(Math.max(0, now - start)));
            }
            header.setAttribute('data-batch-state', 'closed');
            header.classList.add('turn-batch-closed');
            applyMembers(header, false);
            setLabel(header, windowTranslate());
            changed = true;
        }
        return changed;
    }

    /* 会话级收口入口：正文 / 错误到达时调用（指针所在气泡）。 */
    function closeBatch(sess, nowMs) {
        if (!sess) return false;
        var bubble = sess.currentBubbleEl ? sess.currentBubbleEl.parentNode : null;
        return closeBatchFor(bubble, nowMs);
    }

    /* 孤儿清扫：成员被回滚 / purge 删光的盖子移除（流中断重传后必调）。 */
    function sweepOrphanBatchHeaders(container) {
        if (!container || !container.querySelectorAll) return 0;
        var hs = container.querySelectorAll('.turn-batch-header');
        var removed = 0;
        for (var i = hs.length - 1; i >= 0; i--) {
            if (membersOf(hs[i]).length === 0 && hs[i].parentNode) {
                hs[i].parentNode.removeChild(hs[i]);
                removed++;
            }
        }
        return removed;
    }

    /* 语言切换重译：盖子文案是运行时动态文本，无 data-i18n 标记，需按现态重算。 */
    function refreshBatchLabels(container, translate) {
        if (!container || !container.querySelectorAll) return;
        var hs = container.querySelectorAll('.turn-batch-header');
        for (var i = 0; i < hs.length; i++) setLabel(hs[i], translate);
    }

    var i18nBound = false;
    function bindI18nRefresh() {
        if (i18nBound || typeof document === 'undefined' || !document.addEventListener) return;
        i18nBound = true;
        document.addEventListener('i18n:localeChanged', function () {
            if (typeof document.querySelectorAll !== 'function') return;
            var containers = document.querySelectorAll('.messages-wrap, .messages-inner');
            for (var i = 0; i < containers.length; i++) refreshBatchLabels(containers[i], windowTranslate());
        });
    }

    /* 秒级 ticking：只刷运行中盖子的文案。window 不存在（Node 契约测试）不启动，
       避免 setInterval 悬挂测试进程的事件循环。 */
    var tickerStarted = false;
    function startTicker() {
        if (tickerStarted || typeof window === 'undefined' || typeof document === 'undefined') return;
        if (!document.querySelectorAll) return;
        tickerStarted = true;
        setInterval(function () {
            var hs = document.querySelectorAll('.turn-batch-header[data-batch-state="running"]');
            for (var i = 0; i < hs.length; i++) setLabel(hs[i], windowTranslate());
        }, 1000);
    }

    if (typeof document !== 'undefined') {
        bindI18nRefresh();
        startTicker();
    }

    return {
        PROCESS_CLASSES: PROCESS_CLASSES,
        isProcessRow: isProcessRow,
        formatBatchElapsed: formatBatchElapsed,
        labelText: labelText,
        membersOf: membersOf,
        batchDisabled: batchDisabled,
        noteProcessInsert: noteProcessInsert,
        closeBatch: closeBatch,
        closeBatchFor: closeBatchFor,
        clearBatch: clearBatch,
        revealAll: revealAll,
        sweepOrphanBatchHeaders: sweepOrphanBatchHeaders,
        refreshBatchLabels: refreshBatchLabels
    };
});
