/* ===== app-turn-display.js ===== */
/* 统一展现折叠模块（app-turn-batch.js + app-turn-compact.js 合一，2026-11 用户拍板：
 * 「历史消息和运行态为什么搞两个文件？搞一套才好维护」）。
 *
 * 一套管线，两个层次：
 *   1) 【轮内批次折叠】（原 app-turn-batch.js，对标 Qoder 多折叠组）：
 *      一轮运行中，思考块 / 工具卡 / 并行批次组等「过程行」归入一个批次盖子
 *      （button.turn-batch-header，气泡直接子级）之下：
 *        · 运行中：盖子显示「正在执行中 · Ns」（秒级 ticking），成员实时展开；
 *        · 批次收口（正文到达 / 错误到达 / 轮结束）：盖子变「已处理」，成员自动折叠；
 *        · 点击盖子：展开 / 收起该批成员（aria-expanded 同步）。
 *      收口后再出现的过程行开启【新】批次（旧批次保持折叠）——与 Qoder 多批次并列形态一致。
 *      正文（.md-content 非空）/ 智能体卡（.agent-card）是批次【边界】。
 *   2) 【整轮 Compact 折叠】（原 app-turn-compact.js，P2-6，对标 dsh Compact）：
 *      轮彻底结束后把整轮（含批次盖子）收成一行统计摘要，只留最终正文。
 *
 * 【历史 = 运行态（本合并的核心目标）】旧实现回放路径被 _replaying 门禁排除批次折叠，
 *   历史气泡没有任何批次盖子，点开整轮摘要后过程行逐条平铺，与运行态展开形态不一致。
 *   现由 rebuildBatches 在回放收尾按运行态同一套边界规则补建批次组，历史与运行态
 *   共用一份折叠形态。运行态与回放渲染本就共用 onWebChunk 管线（app-history.js
 *   replaySession），折叠层此前是唯一分叉 —— 合并后彻底归一。
 *
 * 【为什么盖子是「气泡直接子级的独立行」而不是包装容器】：
 *   app.css:825 有 `.agent-card-body > .thinking-block + .md-content` 这类相邻兄弟选择器，
 *   历史上插包装节点导致过分组折叠静默失效（见 .gwork 侧栏分组折叠事故复盘）。盖子只是一行
 *   button，成员仍是气泡直接子级，兄弟关系不变；成员可见性由成员自身类
 *   .turn-batch-collapsed 控制（JS 管理），CSS 只有一条极窄的隐藏规则。
 *
 * 【为什么逐轮独立判定、绝不做全局「hasMore ⇒ 禁用所有折叠」】：
 *   dsh Discussion #6250 的 ChatNodeSeat.tsx 写了 `&& !historyIncomplete`，长会话首屏只加载
 *   尾部一页时 hasMore 恒 true → 所有轮次折叠全部失效，用户看到「改了但看起来没改」。
 *   本模块只问「这一轮自己是否完整」（有终态标记且在本页窗口内），不关心整个会话是否还有更早历史。
 *
 * UMD：浏览器挂 window.GourdTurnBatch / window.GourdTurnCompact / window.GourdTurnDisplay
 *   （前两个为兼容别名，调用方无需改动），Node 走 module.exports，供契约测试真跑。
 * 计时 ticker 仅在 window 存在时启动（Node 测试只装 document 不装 window，避免悬挂定时器）。 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.GourdTurnBatch = api;
        root.GourdTurnCompact = api;
        root.GourdTurnDisplay = api;
    }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    'use strict';

    /* ====================================================================
     * Part 1 · 轮内批次折叠（原 app-turn-batch.js）
     * ==================================================================== */

    /* 过程行类名：与整轮 Compact 的 PROCESS_SELECTOR 同口径（不含盖子自身）。
       [Qoder 多折叠组] .agent-card 是【与正文平级的一级常驻行】：不进批次（它自带
       状态点/耗时/可展开卡体，内部工具是第二层级），同时它还是批次的天然边界
       （邻接判定遇到非成员兄弟即切组）。 */
    var PROCESS_CLASSES = ['thinking-block', 'tool-card', 'tool-batch-group'];

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

    /* i18n 回落：与 turn-compact 的三重校验同口径（缺键可能返回裸 key / 空串 / 非字符串）。
       params 原样透传：批次盖子文案带 {count} 占位符，GourdI18n.t(key, params) 才填得上。 */
    function makeTr(translate) {
        var trans = typeof translate === 'function' ? translate : null;
        return function (key, fallback, params) {
            if (!trans) return fallback;
            var v;
            try { v = trans(key, params); } catch (e) { return fallback; }
            if (typeof v !== 'string' || !v.trim()) return fallback;
            if (/^(chat|app|history|queue|settings)\.[\w.]+$/.test(v.trim())) return fallback;
            return v;
        };
    }

    function windowTranslate() {
        return (typeof window !== 'undefined' && window.GourdI18n && window.GourdI18n.t)
            ? function (k) { return window.GourdI18n.t(k); } : null;
    }

    /* 收口盖子上的【真实工作量】统计（用户 2026-11「数字对不上」）。
       口径（用户拍板）：工具数逐个数到并行组【内部】每张 .tool-card，思考单独计数。
       与 turn-compact.buildSummary 的 tools 口径一致（那里同样是展开内部成员数）。 */
    function countBatchWork(header) {
        var out = { tools: 0, thinking: 0 };
        var ms = membersOf(header);
        for (var i = 0; i < ms.length; i++) {
            var el = ms[i];
            var cl = el.classList;
            if (!cl) continue;
            if (cl.contains('tool-batch-group')) {
                /* 并行组：按 .batch-tool-items 的直接子级工具卡计数。组内为空时按 1 计，
                   与 buildSummary 的 `n || 1` 一致：组节点本身就是一次调用证据。 */
                var n = 0;
                var items = el.querySelectorAll ? el.querySelectorAll('.batch-tool-items') : [];
                for (var q = 0; q < items.length; q++) {
                    var kids = items[q].children || [];
                    for (var w = 0; w < kids.length; w++) {
                        var kc = kids[w].classList;
                        if (kc && kc.contains && kc.contains('tool-card')) n++;
                    }
                }
                out.tools += n || 1;
            } else if (cl.contains('tool-card')) out.tools += 1;
            else if (cl.contains('thinking-block')) out.thinking += 1;
        }
        return out;
    }

    /* 盖子文案（Qoder「执行工具 N 次」形态）：
         · 运行中 = 「正在执行中 · Ns」（秒级 ticking），成员实时展开；
         · 收口 = 「执行工具 N 次」+ 有思考时「 · 思考 M 次」，N/M 来自 countBatchWork
           的真实工作量（不是成员节点数）。两项全 0 时回落「已处理」。 */
    function labelText(header, translate) {
        if (!header || !header.getAttribute) return '';
        var tr = makeTr(translate);
        if (header.getAttribute('data-batch-state') === 'closed') {
            var work = countBatchWork(header);
            if (!work.tools && !work.thinking) return tr('chat.batch_done', '已处理');
            var parts = [];
            if (work.tools > 0) {
                var t = tr('chat.batch_done_count', '执行工具 {count} 次', { count: work.tools });
                parts.push(t.replace(/\{count\}/g, String(work.tools)));
            }
            if (work.thinking > 0) {
                var s = tr('chat.batch_thinking_count', '思考 {count} 次', { count: work.thinking });
                parts.push(s.replace(/\{count\}/g, String(work.thinking)));
            }
            return parts.join(' · ');
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

    /* 偏好开关：与按轮 Compact 共用 gourd.turnCompact === '0'（一键回退同一口径）。 */
    function batchDisabled() {
        try {
            return (typeof localStorage !== 'undefined') && localStorage.getItem('gourd.turnCompact') === '0';
        } catch (e) { return false; }
    }

    /* 一键回退：移除容器内全部盖子与成员标记（偏好关闭 / 回放重跑前调用）。 */
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
       用于失败/无正文轮：turn-compact 放弃折叠时，过程证据也不得被批次收口藏住。 */
    function revealAll(container) {
        if (!container || !container.querySelectorAll) return 0;
        var hs = container.querySelectorAll('.turn-batch-header');
        for (var i = 0; i < hs.length; i++) applyMembers(hs[i], true);
        return hs.length;
    }

    /* 过程行【落 DOM 之后】调用：归入当前运行批次；无运行批次则新开一个盖子。
       【Qoder 多折叠组】正文（.md-content）/ 智能体卡（.agent-card）是批次的【边界】：
       它们出现即把当前运行批次收口（成员折叠成组），随后的过程行开【新】盖子。 */
    function noteProcessInsert(sess, el) {
        if (!sess || sess._replaying || !el || !el.setAttribute) return null;
        if (batchDisabled()) return null;
        var bubble = el.parentNode;
        if (!bubble || !bubble.querySelector) return null;
        // 只认主气泡：子代理卡体（.agent-card-body）内的过程行不建盖子
        if (!bubble.classList || !bubble.classList.contains('msg-bubble')) return null;
        /* 成员门禁：只有三类过程行能进批次。正文 md-content / 错误 / HITL / 问答卡 /
           文件变更卡 / trace 徽标等一律不是成员（它们在盖子外保持可见）。 */
        if (!isProcessRow(el)) return null;
        var header = lastHeader(bubble);
        if (header && header.getAttribute('data-batch-state') === 'running') {
            /* 【邻接校验】成员区必须是盖子之后的连续一段：本行的前一个兄弟必须恰为
               「末成员（无成员时即盖子）」。非成员行夹入后再来的过程行若仍挂旧盖子，
               折叠时隐藏行与可见行会交错穿插。不邻接 = 批次已被切断 → 收口旧批 + 开新批。
               【指针空壳豁免】advanceBodyPointer 在每个 action_end 都会插一个【空】
               .md-content 指针壳；跳过它，纯工具轮才不会被空壳切成 N 个碎组。 */
            var ms = membersOf(header);
            var expected = ms.length ? ms[ms.length - 1] : header;
            var kids = bubble.children || [];
            var iEl = Array.prototype.indexOf.call(kids, el);
            var prev = iEl > 0 ? kids[iEl - 1] : null;
            while (prev && prev.classList && prev.classList.contains('md-content')) {
                var pi = Array.prototype.indexOf.call(kids, prev);
                prev = pi > 0 ? kids[pi - 1] : null;
            }
            if (prev !== expected) {
                closeBatchFor(bubble);
                header = null;
            }
        } else {
            header = null;
        }
        if (!header) header = createHeader(bubble, el);
        el.setAttribute('data-turn-batch', '1');
        /* 【继承盖子折叠态】（用户 2026-11 报障：运行中手动收起盖子后，新到的工具/思考
           直接展示在折叠外面）。盖子 open 态时成员平铺（running 常态）；用户手动收起后
           （data-batch-open=false），后到成员必须同样带上 .turn-batch-collapsed，
           否则新成员视觉上「逃逸」到折叠区之外。 */
        if (header.getAttribute('data-batch-open') === 'false') {
            el.classList.add('turn-batch-collapsed');
        }
        return header;
    }

    /* 收口：气泡内【全部】运行批次 → 「已处理」+ 成员折叠（倒序遍历，收口不改变集合）。
       零成员的盖子直接移除（空壳比不显示更误导）。返回是否有批次被收口/移除。 */
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

    /* ====================================================================
     * Part 1.5 · 历史批次重建（历史 = 运行态 的桥梁）
     * ==================================================================== */

    /* 按运行态同一套边界规则，为【回放重建的历史气泡】补建批次组。
       调用时机：replaySession 收尾、fragment 移入真实容器之后、applyTurnCompact 之前
       （compact 的分类要看到已收口的盖子形态）。
       规则与 noteProcessInsert 完全一致（正文/智能体卡是边界、非成员行切断批次），
       但历史批次一律直接建为 closed 态（事件早已发生，无 running 语义、无耗时 ticker）。
       幂等：气泡内已有批次盖子时跳过（prepend 缝合 / 重复调用不重建）。
       @param {HTMLElement} bubble 历史助手气泡（.msg-bubble）
       @param {Object} meta 可选 { nowMs, translate }：closed 态的 data-batch-elapsed 不编造，
              留空（盖子文案只按真实工作量统计，不显示耗时）。 */
    function rebuildBatches(bubble, meta) {
        if (!bubble || !bubble.children || !bubble.querySelectorAll) return 0;
        if (batchDisabled()) return 0;
        /* 已有盖子 = 运行态延续的气泡（恢复流式）或重复调用：不重建，避免双盖子 */
        if (bubble.querySelectorAll('.turn-batch-header').length > 0) return 0;
        var kids = bubble.children || [];
        var built = 0;
        var header = null;
        var builtHeaders = [];   // 收尾统一重算文案（见循环后说明）
        for (var i = 0; i < kids.length; i++) {
            var el = kids[i];
            if (!el || el.nodeType !== 1 || !el.classList) continue;
            /* 边界一：智能体卡 —— 收口当前批，本身不是成员 */
            if (el.classList.contains('agent-card')) {
                if (header) { header = null; }
                continue;
            }
            /* 边界二：非空正文 —— 收口当前批（空壳 .md-content 跳过，与邻接校验豁免同源） */
            if (el.classList.contains('md-content')) {
                if (el.textContent && el.textContent.trim()) {
                    if (header) { header = null; }
                }
                continue;
            }
            if (!isProcessRow(el)) continue;
            /* 无运行盖子（历史重建恒如此）→ 开新盖子，紧贴本行上方。
               【code review 修复 2026-11】createHeader 建盖子时 label 按 running 态
               写成「正在执行中」；历史批次随即改为 closed，若不重算文案，历史盖子
               将永远显示「正在执行中」（与运行态形态对不上的残留分叉）。 */
            if (!header) {
                header = createHeader(bubble, el);
                header.setAttribute('data-batch-state', 'closed');
                header.classList.add('turn-batch-closed');
                header.setAttribute('data-batch-open', 'false');
                header.setAttribute('aria-expanded', 'false');
                header.removeAttribute('data-batch-start');   // 历史批次无 running 语义，去掉计时起点
                builtHeaders.push(header);
                built++;
            }
            el.setAttribute('data-turn-batch', '1');
            el.classList.add('turn-batch-collapsed');
        }
        /* 空盖子清扫：零成员盖子直接移除（与 closeBatchFor 同哲学） */
        if (built > 0) sweepOrphanBatchHeaders(bubble);
        /* 文案必须在【成员全部打上标记后】重算：labelText → countBatchWork →
           membersOf 依赖 data-turn-batch 标记，循环内首个成员尚未落标时统计恒 0。 */
        for (var b2 = 0; b2 < builtHeaders.length; b2++) {
            setLabel(builtHeaders[b2], meta && meta.translate ? meta.translate : windowTranslate());
        }
        return built;
    }

    /* 容器版历史重建入口：扫容器内全部 .msg-bubble 逐个重建。
       @param {HTMLElement} container 消息容器（或气泡本身）
       @param {Object} options { scopeRows } 只处理本次新插入的行（prepend 分页） */
    function rebuildBatchesIn(container, options) {
        if (!container || !container.querySelectorAll) return 0;
        var opts = options || {};
        var total = 0;
        if (container.classList && container.classList.contains('msg-bubble')) {
            return rebuildBatches(container, opts);
        }
        var scope = null;
        if (opts.scopeRows && opts.scopeRows.length) {
            /* 只重建本次插入行内的气泡：scopeRows 是 .msg-row 列表 */
            scope = [];
            for (var r = 0; r < opts.scopeRows.length; r++) {
                var row = opts.scopeRows[r];
                if (!row || !row.querySelectorAll) continue;
                var bubbles = row.classList && row.classList.contains('msg-bubble')
                    ? [row] : row.querySelectorAll('.msg-bubble');
                for (var bi = 0; bi < bubbles.length; bi++) scope.push(bubbles[bi]);
            }
        }
        var targets = scope || container.querySelectorAll('.msg-bubble');
        for (var i = 0; i < targets.length; i++) {
            total += rebuildBatches(targets[i], opts);
        }
        return total;
    }

    /* 语言切换重译：盖子文案是运行时动态文本，无 data-i18n 标记，需按现态重算。 */
    function refreshBatchLabels(container, translate) {
        if (!container || !container.querySelectorAll) return;
        var hs = container.querySelectorAll('.turn-batch-header');
        for (var i = 0; i < hs.length; i++) setLabel(hs[i], translate);
    }

    /* ====================================================================
     * Part 2 · 整轮 Compact 折叠（原 app-turn-compact.js）
     * ==================================================================== */

    /* 过程行：这些是「agent 干了什么」的证据，轮结束后可收起。
       .turn-batch-header 是运行态批次盖子：它本身也是过程证据的一行入口，
       轮结束后随成员一起收起；buildSummary 不对其计数。
       【最终态折叠】.agent-card 不在常驻选择器里（ended 时由 classifyChildren
       的 agentFolds 分叉归入 process；未结束态它是常驻锚点，不折叠）。 */
    var PROCESS_SELECTOR = '.thinking-block, .tool-card, .tool-batch-group, .turn-batch-header';

    /* 【自己保留可见】的元素：错误、max-token、系统提示、HITL / 问答交互卡、文件变更卡。 */
    var KEEP_VISIBLE_SELECTOR = '.err-bubble, .chunk-error, .hitl-card, .question-card, '
        + '.system-notice-bubble, .msg-run-changes-card';

    /* 【底部元信息】轮结束后的耗时徽标 / 时间 / 操作栏：必须常驻可见，且排在最终正文之后。 */
    var FOOTER_SELECTOR = '.msg-meta-row, .msg-actions, .msg-time, .msg-trace';

    /* 只有【真正的失败证据块】出现才整轮不折叠（失败/中断轮次不许把原因藏进摘要）。 */
    var FATAL_SELECTOR = '.err-bubble, .chunk-error';

    var AGENT_SELECTOR = '.agent-card';

    function hasVisibleText(el) {
        if (!el) return false;
        var t = el.textContent || '';
        if (t.trim().length > 0) return true;
        return !!(el.querySelector && el.querySelector('img, table, pre, code, svg'));
    }

    function isMdContent(el) {
        return !!(el && el.classList && el.classList.contains('md-content'));
    }

    /* 无最终正文的轮次是否允许收成一行统计摘要：只认【带明确成功终态】的 trace 徽标。 */
    function hasSuccessfulTerminal(list, bubble) {
        var badge = (bubble && bubble.querySelector) ? bubble.querySelector('.msg-trace') : null;
        if (badge) {
            var bst = badge.getAttribute ? badge.getAttribute('data-turn-status') : null;
            return !bst || bst === 'done';
        }
        for (var i = 0; i < list.length; i++) {
            var el = list[i];
            if (!el || !el.classList || !el.classList.contains('msg-trace')) continue;
            var st = el.getAttribute ? el.getAttribute('data-turn-status') : null;
            if (!st || st === 'done') return true;
        }
        return false;
    }

    /* 纯函数：给定气泡的【直接子节点数组】，返回折叠决策。
       · 最后一个含非空正文的 .md-content = 最终正文边界（唯一 final）；
       · 边界【之前】的全部直接子节点（除显式白名单）一律归入 process —— 连续区间；
       · 边界【之后】的过程行（PROCESS_SELECTOR / 其余 md-content）同样归入 process；
       · 返回 null = 该轮不折叠（无正文 / 有失败证据 / 过程行太少）。
        【智能体卡：最终态折叠 / 运行态锚点 · 2026-11 用户拍板】「最终态折叠，应该
        是折叠除最终正文外其他都折叠」—— ended 时智能体卡与工具/思考一样是过程证据，
        归入 process 折叠（摘要计数「N 次子代理」），最终态只留最终正文。未结束态
        （运行中 / 回放让位 / 缝合重跑）仍是「锚点」：保持原始 DOM 位置不动，
        process 重排以它为界分段保序 —— 否则智能体卡全部聚到气泡末尾（时序形态
        与运行态对不上的旧报障）。
        返回 { process, keep, tail, final, boundaryIdx, lastTextIdx }：
          process = 折叠区间（未结束态可能被 agent 锚点分隔成多段，但各段内部保序）；
          keep = 全部保持可见节点（兼容既有契约断言；未结束态含 agent 锚点）；
          tail = 排在 final 之后的白名单/元信息/未知块（原相对顺序，不含 agent）；
          final = 唯一最终正文。 */
    function classifyChildren(children, bubble, opts) {
        var ended = !!(opts && opts.ended);
        /* ended（最终态）：智能体卡归 process 折叠；未结束态：智能体卡是常驻锚点 */
        var agentFolds = ended;
        var list = Array.prototype.slice.call(children || []);
        var lastTextIdx = -1;
        for (var i = 0; i < list.length; i++) {
            if (isMdContent(list[i]) && hasVisibleText(list[i])) lastTextIdx = i;
        }
        /* noFinal = 本轮没有最终正文。
           · 未结束态：有批次组头（Qoder 多折叠组让位）或没有 done 终态 trace 徽标时
             一律不折叠，保留全部过程证据（运行中/失败/挂起/无终态轮）。
           · 结束态：finishStream 本身就是成功终态信号，纯工具轮（无正文）也允许
             折成一行统计摘要，与回放一致。 */
        var noFinal = lastTextIdx < 0;
        if (noFinal && !ended) {
            var hasBatchHeader = false;
            for (var bh = 0; bh < list.length; bh++) {
                if (list[bh] && list[bh].classList && list[bh].classList.contains('turn-batch-header')) {
                    hasBatchHeader = true; break;
                }
            }
            if (hasBatchHeader || !hasSuccessfulTerminal(list, bubble)) return null;
        }
        /* 结束态纯工具轮（无正文）也允许折叠，但停止/挂起终态徽标必须拦住。 */
        if (noFinal && ended) {
            var endBadge = (bubble && bubble.querySelector) ? bubble.querySelector('.msg-trace') : null;
            if (!endBadge) {
                for (var ei = 0; ei < list.length; ei++) {
                    if (list[ei] && list[ei].classList && list[ei].classList.contains('msg-trace')) {
                        endBadge = list[ei]; break;
                    }
                }
            }
            var endStatus = (endBadge && endBadge.getAttribute) ? endBadge.getAttribute('data-turn-status') : null;
            if (endStatus && endStatus !== 'done') return null;
        }

        // 只把【真正的失败证据块】当整轮否决条件
        for (var f = 0; f < list.length; f++) {
            var fe = list[f];
            if (!fe || fe.nodeType !== 1 || !fe.matches) continue;
            if (fe.matches(FATAL_SELECTOR) || (fe.querySelector && fe.querySelector(FATAL_SELECTOR))) return null;
        }

        function isAlwaysVisible(el) {
            if (!el || el.nodeType !== 1) return false;
            if (el.classList && el.classList.contains('turn-compact-toggle')) return true;
            if (el.matches && el.matches(FOOTER_SELECTOR)) return true;
            if (el.matches && el.matches(KEEP_VISIBLE_SELECTOR)) return true;
            /* 【最终态折叠】ended 时智能体卡不再常驻 —— 归入 process；
               仅未结束态保持锚点常驻（classifyChildren 的 agentFolds 分叉）。 */
            if (!agentFolds && el.matches && el.matches(AGENT_SELECTOR)) return true;
            return false;
        }

        var process = [];
        var keep = [];
        var tail = [];
        var finalNode = noFinal ? null : list[lastTextIdx];
        for (var j = 0; j < list.length; j++) {
            var el = list[j];
            if (!el || el.nodeType !== 1) continue;
            if (el === finalNode) { keep.push(el); continue; }   // 唯一最终正文
            if (isAlwaysVisible(el)) {
                keep.push(el);
                /* 【agent 锚点化】智能体卡不再进 tail（不重排到 final 之后）；
                   其余白名单（HITL/错误/页脚）仍由 compactBubble 统一搬到 final 之后。 */
                if (!(el.classList && el.classList.contains('turn-compact-toggle'))
                        && !el.classList.contains('agent-card')) tail.push(el);
                continue;
            }
            if (noFinal || j < lastTextIdx) { process.push(el); continue; }
            if (isMdContent(el) || (el.matches && el.matches(PROCESS_SELECTOR))) {
                process.push(el);
                continue;
            }
            /* 【最终态折叠】final 之后的智能体卡同样是过程证据，归入 process
               （未结束态它已在上面 isAlwaysVisible 命中，走不到这里）。 */
            if (agentFolds && el.matches && el.matches(AGENT_SELECTOR)) { process.push(el); continue; }
            keep.push(el);
            tail.push(el);
        }
        if (process.length === 0) return null;
        return {
            process: process,
            keep: keep,
            tail: tail,
            final: finalNode,
            boundaryIdx: lastTextIdx,
            lastTextIdx: lastTextIdx
        };
    }

    /* 纯函数：统计摘要（为 0 的段省略）。
       【最终态折叠】ended 时智能体卡在 process，agents 计数真实生效
       （「已完成 · N 次工具调用 · M 次子代理」）；未结束态 agent 是锚点
       不进 process，agents 恒 0，保留字段兼容既有断言。 */
    function buildSummary(processEls) {
        var tools = 0, thinking = 0, agents = 0, texts = 0;
        for (var i = 0; i < processEls.length; i++) {
            var el = processEls[i];
            var cl = el.classList || { contains: function () { return false; } };
            if (cl.contains('tool-batch-group')) {
                var n = 0;
                var items = el.querySelectorAll ? el.querySelectorAll('.batch-tool-items') : [];
                for (var q = 0; q < items.length; q++) {
                    var kids = items[q].children || [];
                    for (var w = 0; w < kids.length; w++) {
                        var kc = kids[w].classList;
                        if (kc && kc.contains && kc.contains('tool-card')) n++;
                    }
                }
                tools += n || 1;
            } else if (cl.contains('tool-card')) tools += 1;
            else if (cl.contains('thinking-block')) thinking += 1;
            else if (cl.contains('agent-card')) agents += 1;
            else if (cl.contains('md-content') && hasVisibleText(el)) texts += 1;
        }
        return { tools: tools, thinking: thinking, agents: agents, texts: texts };
    }

    /* 纯函数：给过程行定【语义类型】，作为 data-turn-process 的属性值。 */
    function processTypeOf(el) {
        var cl = el && el.classList ? el.classList : null;
        if (!cl) return 'other';
        if (cl.contains('tool-batch-group')) return 'batch';
        if (cl.contains('tool-card')) return 'tool';
        if (cl.contains('thinking-block')) return 'thinking';
        if (cl.contains('agent-card')) return 'agent';
        if (cl.contains('turn-batch-header')) return 'batch-header';
        if (cl.contains('md-content')) return 'text';
        return 'other';
    }

    function formatElapsed(ms) {
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

    function statusWord(status, tr) {
        if (status === 'stopped') return tr('chat.turn_stopped', '已停止');
        if (status === 'suspended') return tr('chat.turn_suspended', '已挂起');
        return tr('chat.turn_done', '已完成');
    }

    function summaryText(stats, t, meta) {
        var trans = typeof t === 'function' ? t : null;
        var parts = [];
        function tr(key, fallback) {
            if (!trans) return fallback;
            var v;
            try { v = trans(key); } catch (e) { return fallback; }
            if (typeof v !== 'string' || !v.trim()) return fallback;
            if (/^(chat|app|history|queue|settings)\.[\w.]+$/.test(v.trim())) return fallback;
            return v;
        }
        var head = statusWord(meta && meta.status, tr);
        var elapsed = formatElapsed(meta && meta.elapsedMs);
        if (elapsed) head += ' ' + elapsed;
        parts.push(head);
        function countPart(n, keyOne, keyMany, fbOne, fbMany) {
            if (n === 1) return '1 ' + tr(keyOne, fbOne);
            return String(n) + ' ' + tr(keyMany, fbMany);
        }
        if (stats.tools > 0) parts.push(countPart(stats.tools, 'chat.turn_tools_one', 'chat.turn_tools', '次工具调用', '次工具调用'));
        if (stats.thinking > 0) parts.push(countPart(stats.thinking, 'chat.turn_thinking_one', 'chat.turn_thinking', '段思考', '段思考'));
        if (stats.agents > 0) parts.push(countPart(stats.agents, 'chat.turn_agents_one', 'chat.turn_agents', '次子代理', '次子代理'));
        if (stats.texts > 0) parts.push(countPart(stats.texts, 'chat.turn_process_texts_one', 'chat.turn_process_texts', '段过程', '段过程'));
        return parts.join(' · ');
    }

    function readTurnMeta(bubble) {
        if (!bubble || !bubble.querySelector) return {};
        var badge = bubble.querySelector('.msg-trace');
        if (!badge || !badge.getAttribute) return {};
        var out = {};
        var ms = badge.getAttribute('data-elapsed-ms');
        if (ms != null && ms !== '' && isFinite(Number(ms))) out.elapsedMs = Number(ms);
        var st = badge.getAttribute('data-turn-status');
        if (st) out.status = st;
        return out;
    }

    /* DOM 副作用：对单个已结束轮的 .msg-bubble 应用折叠。幂等。
       【分段重排】以 agent 锚点为界，process 各段在锚点之间原位保序收拢：
       不再「toggle → 全部process → final → tail」一把梭（那会把智能体卡全部
       挤到气泡末尾），而是 toggle 提到最前，agent 锚点保持原始位置，
       其两侧的过程行向各自段首收拢，final/tail 仍在气泡尾部。 */
    function compactBubble(bubble, options) {
        if (!bubble || !bubble.children) return false;
        var opts = options || {};
        var decision = classifyChildren(bubble.children, bubble, opts);
        var existing = bubble.querySelector ? bubble.querySelector(':scope > .turn-compact-toggle') : null;

        if (!decision) {
            // 无正文/有例外：撤销已有的折叠标记，恢复全可见（轮次重放、内容补帧后会走到这里）
            var marked = bubble.querySelectorAll ? bubble.querySelectorAll(':scope > [data-turn-process]') : [];
            for (var m = 0; m < marked.length; m++) marked[m].removeAttribute('data-turn-process');
            if (existing) existing.parentNode.removeChild(existing);
            bubble.classList.remove('turn-compact-open');
            /* 失败/无正文轮的过程证据不得被批次收口藏住。成功收口的无正文轮已有
               批次盖子负责折叠，绝不 revealAll；只有失败/中断/无终态轮才展开。 */
            var hasTerminalTrace = !!(bubble.querySelector && bubble.querySelector('.msg-trace'));
            var hasFatal = !!(bubble.querySelector && bubble.querySelector(FATAL_SELECTOR));
            if (!hasTerminalTrace || hasFatal) {
                if (revealAll) {
                    try { revealAll(bubble); } catch (e) { /* 展示增强 */ }
                }
            }
            return false;
        }

        /* 【Qoder 多折叠组让位 · 仅未结束态】运行态 / 回放 / 缝合重跑时，批次盖子
           （「执行工具 N 次」）已经把过程行按段折好，本模块不再叠第二层整轮摘要。
           轮【真正结束】时（finishStream 传 ended:true）放行整轮折叠，与加载历史一致。 */
        if (!opts.ended && bubble.querySelector && bubble.querySelector(':scope > .turn-batch-header')) {
            var stale = bubble.querySelectorAll ? bubble.querySelectorAll(':scope > [data-turn-process]') : [];
            for (var sm = 0; sm < stale.length; sm++) stale[sm].removeAttribute('data-turn-process');
            if (existing) existing.parentNode.removeChild(existing);
            bubble.classList.remove('turn-compact-open');
            return false;
        }

        // 自动折叠不得吞掉键盘焦点：焦点在待隐藏过程行内时，本轮保持展开。
        if (decision && !existing && typeof document !== 'undefined' && document.activeElement) {
            var active = document.activeElement;
            for (var fi = 0; fi < decision.process.length; fi++) {
                var pe = decision.process[fi];
                if (pe === active || (pe.contains && pe.contains(active))) return false;
            }
        }

        for (var i = 0; i < decision.process.length; i++) {
            var pe = decision.process[i];
            pe.setAttribute('data-turn-process', processTypeOf(pe));
        }

        var stats = buildSummary(decision.process);
        var meta = readTurnMeta(bubble);
        var label = summaryText(stats, opts.translate, meta);
        var toggle = existing;
        var created = !toggle;
        if (!toggle) {
            toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'turn-compact-toggle';
            toggle.setAttribute('aria-expanded', 'false');
            toggle.addEventListener('click', function (ev) {
                ev.stopPropagation();
                var open = bubble.classList.toggle('turn-compact-open');
                toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            });
            toggle.setAttribute('data-turn-compact-bound', '1');
        }

        /* 【分段重排算法（agent 锚点化 · 仅未结束态）】
           旧行为：ordered = [toggle, ...process, final, ...tail] 一把重排 → 智能体卡
           全部被挤到 final 之后，历史形态与运行态对不上（用户 2026-11 报障：
           「历史消息的智能体展示每次都是在消息最后」）。
           未结束态行为：智能体卡（.agent-card）是【不动点锚】——保持原始 DOM 时刻位置，
           其余仍按旧契约收拢（无 agent 时与旧行为完全一致：toggle → process 连续
           区间 → final → tail）。
           【最终态折叠 · 2026-11 用户拍板】ended 时 agent-card 已归 process（分类
           分叉 agentFolds），isAgentAt 对 process 成员恒 false（isProc 优先短路），
           锚点编号循环自动退化为「无锚」路径 —— 重排结果 = toggle → 全部 process
           （含智能体卡）→ final → tail，即「折叠除最终正文外其他都折叠」。
           分区键（稳定排序，同键保持原相对顺序）：
              · toggle（已存在）：-1（恒最前，缝合搬移后重跑自动归位）；
              · process 节点：按其前面有几个【final 之前的 agent 锚】分段，段内保序；
                最后一段（含原本排在 final 之后的尾部过程行）统一收拢到 final 之前
                ——与旧「尾部过程卡回正文之前」契约一致；
              · agent 锚（final 之前）：2i+2，i 为其在锚序列中的序号；
              · final：2m+2（m = final 前的锚数）；
              · tail（白名单/页脚）：2m+3，段内保序（与旧契约一致：HITL/错误/页脚
                仍重排到 final 之后）；
              · agent 锚（final 之后）：2m+4 起，原序——它本就在答案之后，与 tail 同侧。 */
        var finalNode0 = decision.final || null;
        var kidsAll = Array.prototype.slice.call(bubble.children || []);
        var len = kidsAll.length;
        var isProc = new Array(len), isTail = new Array(len);
        for (var c0 = 0; c0 < len; c0++) {
            isProc[c0] = decision.process.indexOf(kidsAll[c0]) >= 0;
            isTail[c0] = decision.tail.indexOf(kidsAll[c0]) >= 0;
        }
        function isToggleAt(i) {
            var n = kidsAll[i];
            return !!(n.classList && n.classList.contains('turn-compact-toggle'));
        }
        function isAgentAt(i) {
            var n = kidsAll[i];
            return !!(n.classList && n.classList.contains('agent-card'));
        }
        var finalIdx0 = finalNode0 ? kidsAll.indexOf(finalNode0) : -1;
        if (finalIdx0 < 0) finalIdx0 = len;
        /* 第一遍：给 final 之前的 agent 锚按原序编号 */
        var anchorNo = new Array(len);
        var m = 0;
        for (var c1 = 0; c1 < len; c1++) {
            if (isProc[c1] || isTail[c1] || c1 === finalIdx0) continue;
            if (isAgentAt(c1) && c1 < finalIdx0) { anchorNo[c1] = m; m++; }
        }
        /* 第二遍：分配分区键 */
        var keys = new Array(len);
        var seg = 0;
        for (var c2 = 0; c2 < len; c2++) {
            if (isToggleAt(c2)) { keys[c2] = -1; continue; }
            if (isProc[c2]) { keys[c2] = 2 * seg + 1; continue; }
            if (anchorNo[c2] !== undefined) { keys[c2] = 2 * anchorNo[c2] + 2; seg = anchorNo[c2] + 1; continue; }
            if (isAgentAt(c2)) { keys[c2] = 2 * m + 4 + c2; continue; }   // final 之后的 agent：tail 区之后按原序
            if (c2 === finalIdx0) { keys[c2] = 2 * m + 2; continue; }
            if (isTail[c2]) { keys[c2] = 2 * m + 3; continue; }
            /* 其余未分类节点：跟随当前段（段内 process 之后），避免被越过分区边界 */
            keys[c2] = 2 * seg + 1.5;
        }
        var pairs = keys.map(function (kv, ki) { return [kv, ki]; })
            .sort(function (a, b) { return a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : (a[1] < b[1] ? -1 : 1); });
        var refNode = null;
        for (var oi = pairs.length - 1; oi >= 0; oi--) {
            var nodeToPlace = kidsAll[pairs[oi][1]];
            bubble.insertBefore(nodeToPlace, refNode);
            refNode = nodeToPlace;
        }

        /* 【盖子不变量】toggle 必须是气泡第一个元素子节点；不满足则把挡路的
           杂散节点统一搬到过程组之后、再把 toggle 提到最前。 */
        function placeToggle(tg) {
            var kids = bubble.children || [];
            var iTg = Array.prototype.indexOf.call(kids, tg);
            if (iTg === 0) return;
            var before = Array.prototype.slice.call(kids, 0, iTg < 0 ? kids.length : iTg);
            for (var bi = 0; bi < before.length; bi++) {
                var stray = before[bi];
                if (stray !== tg && stray.parentNode === bubble) bubble.insertBefore(stray, null);
            }
            var first = (bubble.children && bubble.children[0]) || null;
            bubble.insertBefore(tg, first);
        }
        placeToggle(toggle);
        toggle.textContent = label;
        try { toggle.setAttribute('data-turn-compact-stats', JSON.stringify(stats)); } catch (e) { /* 忽略 */ }
        /* 重跑不得覆盖用户主动展开态：只在【首次创建】时落到折叠态。 */
        if (created) {
            bubble.classList.remove('turn-compact-open');
            toggle.setAttribute('aria-expanded', 'false');
        } else {
            var isOpen = bubble.classList.contains('turn-compact-open');
            toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        }
        return true;
    }

    /* DOM 副作用：扫描容器内所有「已结束轮」并逐轮折叠。逐轮独立，不看容器外是否还有更多历史。 */
    function applyTurnCompact(container, options) {
        if (!container) return { turns: 0, compacted: 0 };
        var opts = options || {};
        var scoped = opts.scopeRows && opts.scopeRows.length ? opts.scopeRows.slice() : null;
        var rows = scoped || (container.children ? Array.prototype.slice.call(container.children) : []);
        var turns = [];
        var current = null;
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (!row || !row.classList) continue;
            if (scoped && row.parentNode !== container) continue;
            if (row.classList.contains('msg-row') && row.classList.contains('user')) {
                if (current) turns.push(current);
                current = { assistants: [] };
            } else if (row.classList.contains('msg-row') && row.classList.contains('assistant') && current) {
                current.assistants.push(row);
            }
        }
        if (current) turns.push(current);

        var compacted = 0;
        for (var t = 0; t < turns.length; t++) {
            var closed = scoped ? true : (t !== turns.length - 1 ? true : !!opts.lastTurnClosed);
            if (!closed) continue;
            var as = turns[t].assistants;
            for (var a = 0; a < as.length; a++) {
                var bubble = as[a].querySelector ? as[a].querySelector('.msg-bubble') : null;
                if (bubble && compactBubble(bubble, opts)) compacted++;
            }
        }
        return { turns: turns.length, compacted: compacted };
    }

    /* 撤销：用于用户关掉偏好 / 回放重跑前，保证可完全回退。 */
    function clearTurnCompact(container) {
        if (!container || !container.querySelectorAll) return;
        var toggles = container.querySelectorAll('.turn-compact-toggle');
        for (var i = 0; i < toggles.length; i++) toggles[i].parentNode.removeChild(toggles[i]);
        var marked = container.querySelectorAll('[data-turn-process]');
        for (var j = 0; j < marked.length; j++) marked[j].removeAttribute('data-turn-process');
        var bubbles = container.querySelectorAll('.turn-compact-open');
        for (var k = 0; k < bubbles.length; k++) bubbles[k].classList.remove('turn-compact-open');
        if (container.classList && container.classList.contains('turn-compact-open')) {
            container.classList.remove('turn-compact-open');
        }
        if (container.removeAttribute && container.getAttribute
            && container.getAttribute('data-turn-process') !== null) {
            container.removeAttribute('data-turn-process');
        }
    }

    /* 摘要文案重译：语言切换后按按钮上记录的 stats 重算文案，不改折叠状态。 */
    function refreshTurnCompact(container, translate) {
        if (!container || !container.querySelectorAll) return;
        var toggles = container.querySelectorAll('.turn-compact-toggle');
        for (var i = 0; i < toggles.length; i++) {
            var tg = toggles[i];
            var raw = tg.getAttribute('data-turn-compact-stats');
            if (!raw) continue;
            try {
                var s = JSON.parse(raw);
                tg.textContent = summaryText(s, translate, readTurnMeta(tg.parentNode));
            } catch (e) { /* 单个按钮脏数据不影响其余 */ }
        }
    }

    /* ====================================================================
     * Part 3 · 语言切换 / 秒级 ticker / 出口
     * ==================================================================== */

    var i18nBound = false;
    function bindI18nRefresh() {
        if (i18nBound || typeof document === 'undefined' || !document.addEventListener) return;
        i18nBound = true;
        document.addEventListener('i18n:localeChanged', function () {
            if (typeof document.querySelectorAll !== 'function') return;
            var containers = document.querySelectorAll('.messages-wrap, .messages-inner');
            for (var i = 0; i < containers.length; i++) {
                refreshBatchLabels(containers[i], windowTranslate());
                refreshTurnCompact(containers[i], windowTranslate());
            }
        });
    }

    /* 秒级 ticking：只刷运行中盖子的文案。Node 契约测试不启动（避免悬挂定时器）。 */
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
        /* Part 1 批次折叠（原 GourdTurnBatch 出口面，键名不变） */
        PROCESS_CLASSES: PROCESS_CLASSES,
        isProcessRow: isProcessRow,
        formatBatchElapsed: formatBatchElapsed,
        labelText: labelText,
        countBatchWork: countBatchWork,
        membersOf: membersOf,
        batchDisabled: batchDisabled,
        noteProcessInsert: noteProcessInsert,
        closeBatch: closeBatch,
        closeBatchFor: closeBatchFor,
        clearBatch: clearBatch,
        revealAll: revealAll,
        sweepOrphanBatchHeaders: sweepOrphanBatchHeaders,
        refreshBatchLabels: refreshBatchLabels,
        /* 历史重建（新增） */
        rebuildBatches: rebuildBatches,
        rebuildBatchesIn: rebuildBatchesIn,
        /* Part 2 整轮折叠（原 GourdTurnCompact 出口面，键名不变） */
        PROCESS_SELECTOR: PROCESS_SELECTOR,
        KEEP_VISIBLE_SELECTOR: KEEP_VISIBLE_SELECTOR,
        classifyChildren: classifyChildren,
        buildSummary: buildSummary,
        summaryText: summaryText,
        readTurnMeta: readTurnMeta,
        formatElapsed: formatElapsed,
        compactBubble: compactBubble,
        applyTurnCompact: applyTurnCompact,
        clearTurnCompact: clearTurnCompact,
        refreshTurnCompact: refreshTurnCompact
    };
});
