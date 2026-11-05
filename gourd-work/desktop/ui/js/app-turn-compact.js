/* ===== app-turn-compact.js ===== */
/* 按轮 Compact 折叠（P2-6）：对标 deepseek-harness 的 Normal/Compact 偏好（默认 Compact）。
 *
 * 语义：一轮结束（下一条 user 帧 / done / trace 到达）后，把「最终正文之前」的过程行
 *   —— 思考块、工具卡、并行批次组、子代理卡 —— 收起成一行统计摘要，只留最终正文。
 *   点击摘要行可展开该轮全部过程证据。用户气泡 / 系统提示 / 错误 / HITL / 文件变更卡不动。
 *
 * 为什么是「零包装层的属性标记」而不是给过程行套一个 <div class="turn-process">：
 *   app.css:825 有 `.agent-card-body > .thinking-block + .md-content` 这类相邻兄弟选择器，
 *   历史上插包装节点已导致过分组折叠静默失效（见 .gwork 侧栏分组折叠事故复盘）。
 *   故只在既有节点上写 data-turn-process="1"，由 CSS `[hidden]`/类规则隐藏，DOM 兄弟关系不变。
 *
 * 为什么逐轮独立判定、绝不做全局「hasMore ⇒ 禁用所有折叠」：
 *   dsh Discussion #6250 的 ChatNodeSeat.tsx 写了 `&& !historyIncomplete`，长会话首屏只加载
 *   尾部一页时 hasMore 恒 true → 所有轮次折叠全部失效，用户看到「改了但看起来没改」。
 *   本模块只问「这一轮自己是否完整」（有终态标记且在本页窗口内），不关心整个会话是否还有更早历史。
 *
 * UMD：浏览器挂 window.GourdTurnCompact，Node 走 module.exports，供契约测试真跑。
 * 纯函数式核心（classifyChildren / buildSummary）与 DOM 副作用（applyTurnCompact）分离，
 * 便于在 node:vm 沙箱里无 DOM 依赖地验证规则。 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.GourdTurnCompact = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    'use strict';

    /* 过程行：这些是「agent 干了什么」的证据，轮结束后可收起。
       注意 .tool-batch-group 自身内部还有 .tool-card，但它作为整体一个视觉单元计数一次。 */
    var PROCESS_SELECTOR = '.thinking-block, .tool-card, .tool-batch-group, .agent-card';

    /* 【自己保留可见】的元素：错误、max-token、系统提示、HITL / 问答交互卡、文件变更卡
       （app.css:684-692 记录过「刻意保留盒式」的踩坑），以及 turn-tail 行。
       报告原文是这些「留在过程组外」= 它们自己不收起，**不是**让整轮放弃折叠。

       ⚠️ 这里绝不能放 .tool-status-icon.warn / .msg-trace：
       app-history.js:2345 在回放收尾时把每张残留 loading 卡统一标成 warn（回放路径不会再有帧），
       .msg-trace 是每轮结束的耗时徽标 —— 两者在历史里是【常态】。若把它们当整轮否决条件，
       每一轮都会命中、折叠永远不会发生，正是「改了但看起来没改」。 */
    var KEEP_VISIBLE_SELECTOR = '.err-bubble, .chunk-error, .hitl-card, .question-card, '
        + '.system-notice-bubble, .msg-run-changes-card';

    /* 只有【真正的失败证据块】出现才整轮不折叠（失败/中断轮次不许把原因藏进摘要）。
       这是 dsh「没有最终正文的轮次保留全部过程证据」的等价护栏。 */
    var FATAL_SELECTOR = '.err-bubble, .chunk-error';

    /* 只有「含非空正文的块」才算最终正文边界。空 .md-content（流式指针推进遗留的空壳）
        与纯代码块占位不算，避免把整轮正文误判为不存在。 */
    function hasVisibleText(el) {
        if (!el) return false;
        var t = el.textContent || '';
        if (t.trim().length > 0) return true;
        // 图片/表格等无文本但有语义的内容也算正文
        return !!(el.querySelector && el.querySelector('img, table, pre, code, svg'));
    }

    function isMdContent(el) {
        return !!(el && el.classList && el.classList.contains('md-content'));
    }

    /* 纯函数：给定气泡的【直接子节点数组】，返回折叠决策。
        规则（对标 dsh Compact / Codex transcript_only）：一轮内 assistant 会在工具调用之间
        吐出多段【过程正文】（advanceBodyPointer 每次工具/思考后新开一个 .md-content），
        用户要的是「折叠区里只剩最终答案」—— 故：
          · 最后一个含非空正文的 .md-content = 最终正文边界（唯一 keep 的正文块）；
          · 边界【之前】所有含文本的 .md-content = 过程正文，与 thinking/tool 一起进折叠区；
          · 边界【之后】的过程行属于 turn-tail，保留；
          · 空的 .md-content 壳（指针推进残留）既不 keep 也不计数，直接视作过程噪声收起。
        返回 null = 该轮不折叠（无正文 / 有失败证据 / 过程行太少）。 */
    function classifyChildren(children) {
        var list = Array.prototype.slice.call(children || []);
        var lastTextIdx = -1;
        for (var i = 0; i < list.length; i++) {
            if (isMdContent(list[i]) && hasVisibleText(list[i])) lastTextIdx = i;
        }
        // 关闭时没有最终正文的轮次保留全部过程证据（失败/中断轮次不许藏过程）
        if (lastTextIdx < 0) return null;

        // 只把【真正的失败证据块】当整轮否决条件
        for (var f = 0; f < list.length; f++) {
            var fe = list[f];
            if (!fe || fe.nodeType !== 1 || !fe.matches) continue;
            if (fe.matches(FATAL_SELECTOR) || (fe.querySelector && fe.querySelector(FATAL_SELECTOR))) return null;
        }

        var keep = [];
        var process = [];
        for (var j = 0; j < list.length; j++) {
            var el = list[j];
            if (!el || el.nodeType !== 1) continue;
            // 摘要按钮本身（重复执行/重译后已存在）要幂等跳过
            if (el.classList && el.classList.contains('turn-compact-toggle')) { keep.push(el); continue; }
            // 自己保留可见：不收起，也不影响其它过程行
            if (el.matches && el.matches(KEEP_VISIBLE_SELECTOR)) { keep.push(el); continue; }
            if (el.classList.contains('msg-meta-row') || el.classList.contains('msg-actions')) {
                keep.push(el);
                continue;
            }
            if (isMdContent(el)) {
                // 最后一段非空正文才是最终答案；其余（含空壳）全部归入过程区。
                if (j === lastTextIdx) keep.push(el);
                else process.push(el);
                continue;
            }
            if (el.matches && el.matches(PROCESS_SELECTOR)) {
                if (j < lastTextIdx) process.push(el);
                else keep.push(el);   // 最终正文之后的过程行保留（turn-tail）
            } else {
                keep.push(el);        // 未知块保守保留
            }
        }
        if (process.length === 0) return null;
        return { process: process, keep: keep, lastTextIdx: lastTextIdx };
    }

    /* 纯函数：统计摘要（报告 P2-6：为 0 的段省略，四项全 0 显示「已思考」）。
        返回 {tools, thinking, agents, texts}。texts = 工具/思考之间吐出的【过程正文】段数，
        这类正文同样被收进折叠区，故摘要里必须体现，否则用户点了展开才发现「正文也在里面」。 */
    function buildSummary(processEls) {
        var tools = 0, thinking = 0, agents = 0, texts = 0;
        for (var i = 0; i < processEls.length; i++) {
            var el = processEls[i];
            var cl = el.classList || { contains: function () { return false; } };
            if (cl.contains('tool-batch-group')) {
                // 批次组按内部成员数计，才对得上「N 次工具调用」。
                // 遍历 .batch-tool-items 的直接子元素而非 querySelectorAll('.batch-tool-items > .tool-card')：
                // 复合子选择器在游离容器/回放临时容器里的行为不一致，且不便在无 DOM 的契约测试里验证。
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
            // 空壳 .md-content（指针推进残留）不计数，它只是噪声
        }
        return { tools: tools, thinking: thinking, agents: agents, texts: texts };
    }

    /* 纯函数：给过程行定【语义类型】，作为 data-turn-process 的属性值。
        CSS 据此按类型分化展开态形态（不是把所有过程行一律抹成同一种 $ 前缀 ——
        上一轮返工正是这么被用户否掉的）：
          thinking = 思考（◇ 引导、DIM）、tool/batch = 工具（$ 命令行）、
          agent = 子代理（▸ 作用域）、text = 过程正文（│ 竖线引导、DIM 弱化）。
        属性【存在】本身仍是折叠依据（CSS 用 [data-turn-process] 命中所有值），
        值只用于展开态的语义分化，二者互不干扰，可平滑升级既有标记。 */
    function processTypeOf(el) {
        var cl = el && el.classList ? el.classList : null;
        if (!cl) return 'other';
        if (cl.contains('tool-batch-group')) return 'batch';
        if (cl.contains('tool-card')) return 'tool';
        if (cl.contains('thinking-block')) return 'thinking';
        if (cl.contains('agent-card')) return 'agent';
        if (cl.contains('md-content')) return 'text';
        return 'other';
    }

    /* 摘要文案：i18n 优先，缺失/异常一律回落中文（与项目其它动态标签一致）。
       【为何不能只判 v !== key】GourdI18n.t 在不同语言包缺键时可能返回【另一个】裸 key，
       或返回空串/非字符串；只比对传入的 key 会把 `chat.turn_agents` 之类的技术标识
       直接显示给用户。故统一按「非空、字符串、且不像 i18n key」三重条件校验。 */
    function summaryText(stats, t) {
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
        if (stats.tools > 0) parts.push(String(stats.tools) + ' ' + tr('chat.turn_tools', '次工具调用'));
        if (stats.thinking > 0) parts.push(String(stats.thinking) + ' ' + tr('chat.turn_thinking', '段思考'));
        if (stats.agents > 0) parts.push(String(stats.agents) + ' ' + tr('chat.turn_agents', '次子代理'));
        if (stats.texts > 0) parts.push(String(stats.texts) + ' ' + tr('chat.turn_process_texts', '段过程'));
        if (parts.length === 0) return tr('chat.turn_thought_only', '已思考');
        return parts.join(' · ');
    }

    /* DOM 副作用：对单个已结束轮的 .msg-bubble 应用折叠。
       幂等：重复调用会先复用已有 toggle，不会重复插按钮 / 重复计数。
       【键盘焦点保护】dsh 的坑：自动折叠若隐藏了当前焦点所在元素，焦点会丢失、
       读屏用户被抛回文档开头。故折叠前检查 activeElement 是否落在待隐藏的过程行里，
       是则该轮直接跳过折叠（保持全可见），绝不动用户焦点。 */
    function compactBubble(bubble, options) {
        if (!bubble || !bubble.children) return false;
        var opts = options || {};
        var decision = classifyChildren(bubble.children);
        var existing = bubble.querySelector ? bubble.querySelector(':scope > .turn-compact-toggle') : null;

        if (!decision) {
            // 无正文/有例外：撤销已有的折叠标记，恢复全可见（轮次重放、内容补帧后会走到这里）
            var marked = bubble.querySelectorAll ? bubble.querySelectorAll(':scope > [data-turn-process]') : [];
            for (var m = 0; m < marked.length; m++) marked[m].removeAttribute('data-turn-process');
            if (existing) existing.parentNode.removeChild(existing);
            bubble.classList.remove('turn-compact-open');
            return false;
        }

        // 自动折叠不得吞掉键盘焦点：焦点在待隐藏过程行内时，本轮保持展开。
        // 已处于展开态（用户主动点过）不重复判断，否则每次重放都会误判。
        if (decision && !existing && typeof document !== 'undefined' && document.activeElement) {
            var active = document.activeElement;
            for (var fi = 0; fi < decision.process.length; fi++) {
                var pe = decision.process[fi];
                if (pe === active || (pe.contains && pe.contains(active))) return false;
            }
        }

        for (var i = 0; i < decision.process.length; i++) {
            var pe = decision.process[i];
            // 值 = 语义类型，供 CSS 按类型分化展开态形态（◇/$/▸/│）；
            // 存在性本身仍是折叠依据，CSS 用 [data-turn-process] 命中所有值。
            pe.setAttribute('data-turn-process', processTypeOf(pe));
        }

        var stats = buildSummary(decision.process);
        var label = summaryText(stats, opts.translate);
        var toggle = existing;
        var created = !toggle;
        if (!toggle) {
            toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'turn-compact-toggle';
            toggle.setAttribute('aria-expanded', 'false');
            // 插在最终正文之前：正文直出，摘要行是正文上方的一条细分隔带
            var anchor = decision.keep.filter(function (e) { return isMdContent(e); })[0];
            if (anchor && bubble.querySelector) {
                // 找第一个正文块在气泡里的位置（跳过已在正文前的 toggle）
                var firstText = null;
                for (var k = 0; k < bubble.children.length; k++) {
                    if (isMdContent(bubble.children[k]) && hasVisibleText(bubble.children[k])) { firstText = bubble.children[k]; break; }
                }
                if (firstText) bubble.insertBefore(toggle, firstText);
                else bubble.insertBefore(toggle, bubble.firstChild);
            } else {
                bubble.insertBefore(toggle, bubble.firstChild);
            }
            // 事件委托到气泡本身，避免每张卡各挂一个监听器；切换类即可，不改过程行 DOM
            toggle.addEventListener('click', function (ev) {
                ev.stopPropagation();
                var open = bubble.classList.toggle('turn-compact-open');
                toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            });
            toggle.setAttribute('data-turn-compact-bound', '1');
        }
        toggle.textContent = label;
        /* 记下统计维度（不是文案本身）：i18n:localeChanged 时据此按新语言重算文案，
           避免异步语言包就绪前落成的中文/回退文案在切换语言后一直残留。 */
        try { toggle.setAttribute('data-turn-compact-stats', JSON.stringify(stats)); } catch (e) { /* 忽略 */ }
        /* 重跑（prepend 补帧 / 回放重放 / 语言切换）不得覆盖用户主动展开态：
           只在【首次创建】时落到折叠态；已有按钮的展开/收起状态由用户点击决定，
           与 classifyChildren 的幂等刷新互不干扰。方案 9.4 第 2 条的轻量修复。
           aria-expanded 与类保持同步，避免读屏器读到的状态和实际可见性相反。 */
        if (created) {
            bubble.classList.remove('turn-compact-open');
            toggle.setAttribute('aria-expanded', 'false');
        } else {
            var isOpen = bubble.classList.contains('turn-compact-open');
            toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        }
        return true;
    }

    /* DOM 副作用：扫描容器内所有「已结束轮」并逐轮折叠。
       turn 的判定纯靠 DOM 顺序：一条 .msg-row.user 开启一轮，其后连续的
       .msg-row.assistant 属于该轮；遇到下一条 user 即证明上一轮已结束。
       最后一条轮次是否折叠由 options.lastTurnClosed 决定（回放响应里的 done/trace/running）。
       【逐轮独立】不看容器外是否还有更多历史，彻底避开 dsh #6250。 */
    function applyTurnCompact(container, options) {
        if (!container) return { turns: 0, compacted: 0 };
        var opts = options || {};
        /* scopeRows：prepend（加载更早历史）时只处理本次新插入的行。
           容器底部可能挂着正在实时流式的回复，绝不能因为「本页更早历史里出现过 done 帧」
           就把那条进行中的轮也折叠掉。搜不到 scopeRows 时退回全容器（初始加载）。 */
        var scoped = opts.scopeRows && opts.scopeRows.length ? opts.scopeRows.slice() : null;
        var rows = scoped || (container.children ? Array.prototype.slice.call(container.children) : []);
        var turns = [];
        var current = null;
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (!row || !row.classList) continue;
            // 跨页缝合会把部分节点并入真实容器已有的行；脱离本文档的跳过，绝不折它
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
            // 非最后一轮：后一条 user 帧已出现 ⇒ 必然已结束。
            // 最后一轮：scope 模式（更早历史分页）里它后面一定有真实容器中的下一轮，故也视为结束；
            // 全容器模式（初始加载）则由调用方按 keepOpen / 末帧终态明确告知。
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
        /* 调用方可能直接传【气泡本身】（finishStream 收口路径就是 row.querySelector('.msg-bubble')），
           querySelectorAll 不含容器自身 → 展开类会残留，样式悬空。容器自身也要清。 */
        if (container.classList && container.classList.contains('turn-compact-open')) {
            container.classList.remove('turn-compact-open');
        }
        if (container.removeAttribute && container.getAttribute
            && container.getAttribute('data-turn-process') !== null) {
            container.removeAttribute('data-turn-process');
        }
    }

    /* 摘要文案重译：语言包是异步加载的，首轮折叠可能早于 i18n ready 而落成中文/裸 key；
       语言切换后已渲染的按钮 textContent 不会自动更新（它们没有 data-i18n 标记）。
       故在 i18n:localeChanged 时按按钮上记录的 stats 重算文案，不改折叠状态。
       幂等：重复扫描只刷新 textContent，不插按钮、不动过程行标记。 */
    function refreshTurnCompact(container, translate) {
        if (!container || !container.querySelectorAll) return;
        var toggles = container.querySelectorAll('.turn-compact-toggle');
        for (var i = 0; i < toggles.length; i++) {
            var tg = toggles[i];
            var raw = tg.getAttribute('data-turn-compact-stats');
            if (!raw) continue;
            try {
                var s = JSON.parse(raw);
                tg.textContent = summaryText(s, translate);
            } catch (e) { /* 单个按钮脏数据不影响其余 */ }
        }
    }

    /* 语言切换：i18n 的 translateDOM 只处理 [data-i18n] 静态节点，摘要按钮是运行时动态
       创建的，没有该标记。故监听其 ready/变更事件，对容器内所有已渲染摘要重算文案。
       【一次绑定】模块本身只被 app-bootstrap.js 引一次；用模块级标志防重复注册。
       【绝不改折叠状态】只刷 textContent，用户点开的轮次保持展开。 */
    var i18nBound = false;
    function bindI18nRefresh() {
        if (i18nBound || typeof document === 'undefined' || !document.addEventListener) return;
        i18nBound = true;
        /* 首次 setLocale 完成 → translateDOM() → dispatch 'i18n:localeChanged'；
           之后每次切换语言同样 dispatch，故一个监听即可覆盖「首帧早于语言包」与「运行中切语言」。
           不依赖 window.GourdI18n 在模块加载时是否已就绪。 */
        document.addEventListener('i18n:localeChanged', function () {
            if (typeof document.querySelectorAll !== 'function') return;
            var containers = document.querySelectorAll('.messages-wrap, .messages-inner');
            var t = (typeof window !== 'undefined' && window.GourdI18n && window.GourdI18n.t)
                ? function (k) { return window.GourdI18n.t(k); } : null;
            for (var i = 0; i < containers.length; i++) refreshTurnCompact(containers[i], t);
        });
    }
    /* UMD 在浏览器里 root 就是 window；Node（契约测试）下无 document，自然跳过。 */
    if (typeof document !== 'undefined') bindI18nRefresh();

    return {
        PROCESS_SELECTOR: PROCESS_SELECTOR,
        KEEP_VISIBLE_SELECTOR: KEEP_VISIBLE_SELECTOR,
        classifyChildren: classifyChildren,
        buildSummary: buildSummary,
        summaryText: summaryText,
        compactBubble: compactBubble,
        applyTurnCompact: applyTurnCompact,
        clearTurnCompact: clearTurnCompact,
        refreshTurnCompact: refreshTurnCompact
    };
});
