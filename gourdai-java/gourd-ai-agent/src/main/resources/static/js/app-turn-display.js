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

    /* 【交互卡边界 · 2026-11 用户报障「只要展示 HITL/智能体这两个，页面就会错乱」】
       待审批 HITL 卡（.tool-card.hitl-pending）与问答记录（.qa-record）是【等用户拍板 /
       用户已拍板】的交互边界，不是「agent 干了什么」的过程证据：
       · 进批次成员 = 批次收口时随成员一起 .turn-batch-collapsed 隐藏 → 审批按钮 /
         问答记录整块消失（HITL 卡还带 .tool-card 类，isProcessRow 恒真，旧实现必吞）；
       · 进整轮 process = 被 data-turn-process 隐藏，且 compactBubble 重排把它搬离原位。
       二者都必须：切断当前运行批次（收口旧组）、自身永不进成员 / 永不进 process、
       其后的过程行开新盖子。与 .agent-card / 非空正文同级的第三类批次边界。
       注意只认【待审批】的 HITL 卡：批准 / 拒绝 / 放行后 .hitl-pending 被摘除，
       该卡回归普通工具结果卡语义（过程证据，可折叠）。 */
    function isInteractiveCard(el) {
        if (!el || !el.classList) return false;
        if (el.classList.contains('qa-record')) return true;
        return el.classList.contains('tool-card') && el.classList.contains('hitl-pending');
    }

    /* 【卡内穿透 · 2026-11 用户报障「只要展示 hitl 和智能体这两个，页面就会错乱」的
       另一半根因】交互卡可以落在【子代理卡体内】：appendHitlCard 接管骨架卡分支明确
       「节点已在消息流中（可能在智能体卡内）」，子代理派发 bash 等需授权工具时就是这形态。
       而 classifyChildren 只看气泡的【直接子节点】：ended 态 agent-card 归 process
       （用户拍板「最终态折叠除正文外都折叠」），CSS `.msg-bubble > [data-turn-process]
       { display:none !important }` 会把整张卡连带子树隐藏 —— 卡内那张【等用户拍板】的
       审批卡随之消失，用户既看不到也点不到「批准/拒绝」，任务永久卡死（挂起收尾
       settleSteerTurnBoundary 与回放 applyTurnCompact 传的都是 ended:true，两条路都中）。
       故：卡内只要还挂着交互卡，这张智能体卡就必须退回「常驻锚点」语义，不得进 process。
       审批放行后 .hitl-pending 被摘除 → 判定自动失效 → 该卡回归正常的最终态折叠，
       不会留下常驻残影（与 isInteractiveCard 只认待审批态同口径）。 */
    function hasInteractiveCardInside(el) {
        if (!el || !el.querySelectorAll) return false;
        var nodes = el.querySelectorAll('.tool-card, .qa-record');
        for (var i = 0; i < nodes.length; i++) {
            if (isInteractiveCard(nodes[i])) return true;
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

    /* 直接子级盖子列表（2026-11 方案A）：智能体卡体内也建盖子后，querySelectorAll
       会穿透到卡内——主气泡收口误关卡内 running 盖子、lastHeader 串到别的容器。
       所有「找本容器盖子」的场合一律只认直接子级。 */
    function childHeadersOf(container) {
        var out = [];
        if (!container || !container.children) return out;
        var kids = container.children;
        for (var i = 0; i < kids.length; i++) {
            if (kids[i].classList && kids[i].classList.contains('turn-batch-header')) out.push(kids[i]);
        }
        return out;
    }

    function lastHeader(bubble) {
        var hs = childHeadersOf(bubble);
        return hs.length ? hs[hs.length - 1] : null;
    }

    /* ====================================================================
     * 批次成员限高滚动窗（2026-11 用户拍板：运行中/历史展开一律限高约 8 行，
     * 超出内部滚动；新步骤自动跟随到底，用户上滑查看时暂停跟随，回到底部恢复）。
     *
     * 【绝不插包装层/垫片】app.css:825 相邻兄弟选择器、membersOf 兄弟区间、
     * noteProcessInsert 邻接校验、compact 分类全都假定「盖子之后是连续的成员
     * 直接子级」——历史上插包装节点出过分组折叠静默失效事故，插占位垫片同样
     * 会切断邻接判定（prev !== expected ⇒ 每个新成员切一个新批次）。
     * 因此滚动完全用【合成器绘制】实现，DOM 一根手指不动：
     *   · 每个可见成员 transform: translateY(-pos)（视觉位移，点击命中随视觉走，
     *     不影响布局）；
     *   · 每个可见成员 clip-path: inset(...)（按成员与固定视窗的相交区间裁剪，
     *     clip 在 transform 之前的本地坐标系计算）；
     *   · 批次总占位恒定：末成员 margin-bottom = 基值 - overflow（与 pos 无关；
     *     成员自身 margin 基值记在 _winMt/_winMb）。margin 只写在成员自身上，
     *     不新增节点，邻接/兄弟区间全部不受影响。
     *     【code review 修复 2026-11】写入必须带 !important：运行态
     *     `.agent-live .msg-bubble > .tool-card { margin:0 !important }`（app.css:4333）
     *     与展开态 `margin:2px 0 !important`（app.css:4296）会压死普通 inline margin，
     *     补偿失效 ⇒ 批次下方留出 overflow 高的空洞。inline !important 压过样式表 !important。
     * 滚轮：wheel 绑在容器（气泡/卡体）上按 ev.target 归属换算 pos；到边界放行
     * 给页面滚动。跟随策略：pos 距底部 ≤ FOLLOW_SLACK_PX 视为贴底，新成员到达
     * 时贴底自动跟到最新；用户上滑离开底部即停，滑回底部恢复。
     * 所有几何读取都有守卫：Node 契约测试的极简假 DOM 无布局 → 全链 no-op，
     * 测试看到的仍是原平铺 DOM 形态（零感知）。 */
    var WINDOW_MAX_PX = 232;      /* ≈ 8 行过程行（13px/1.6 + 上下 padding ≈ 29px/行） */
    var FOLLOW_SLACK_PX = 24;     /* 距底部小于该值视为贴底（跟随态） */

    /* 布局是否可测（浏览器真 DOM）；假 DOM / 游离节点一律不可测 → 全链 no-op。 */
    function measurable(el) {
        return !!(el && typeof el.getBoundingClientRect === 'function'
            && el.ownerDocument && el.ownerDocument.defaultView);
    }

    function px(n) { return (Math.round(Math.max(0, n) * 100) / 100) + 'px'; }

    /* 成员几何：rect.height 与 transform/clip 无关，可直接量；margin 用
       getComputedStyle 拿【基值】（首次量测记在 el._winMt/_winMb，之后复用，
       避免把自己写上去的补偿 margin 再量进来）。
       【布局顶必须用 offsetTop，绝不能用 rect.top（2026-11 真机探针实锤）】
       Chromium 对 transform 走合成器线程：getBoundingClientRect 返回的是
       【合成器位】= 布局位 + translateY，且清掉 inline transform 后合成器
       提交有延迟 —— 同一 JS 任务内 rect.top 仍带旧 -pos 偏移（探针：清样式后
       rect.top=-497 而 offsetTop=63）。offsetTop 是纯布局属性，不受 transform
       影响、读它必触发同步布局 flush，量到的才是未补偿布局位。
       rect.height 不受 transform 影响，继续用 rect。
       桩 DOM 无 offsetTop（undefined）→ 回落 rect.top（契约测试零布局兼容）。 */
    function memberMetrics(el) {
        var r = el.getBoundingClientRect();
        if (typeof el._winMt !== 'number') {
            var st = el.ownerDocument.defaultView.getComputedStyle
                ? el.ownerDocument.defaultView.getComputedStyle(el) : null;
            el._winMt = st ? parseFloat(st.marginTop) || 0 : 0;
            el._winMb = st ? parseFloat(st.marginBottom) || 0 : 0;
        }
        /* offsetTop 相对 offsetParent（最近 positioned 祖先）的 padding 边。
           同一批成员都是宿主容器直接子级、自身 static ⇒ 共享同一 offsetParent，
           坐标系一致；windowGeometry 全程差分（origin=首成员顶），常量偏移抵消。
           用 offsetParent.rect.top + border-top + padding-top 把 offsetTop 换算回
           视口坐标，与 rect 模型完全同纲（paintWindowScrollbar 拿 metrics[0].top
           与盖子 rect.top 直接差分也成立）。offsetParent 的 rect 不受成员 transform
           影响（成员位移不改容器布局），换算式干净。
           【必须减 offsetParent.scrollTop —— 2026-11-24 真机实锤的页面错乱根因】
           offsetTop 是【内容坐标】（不随容器滚动变），rect.top 是【视口坐标】
           （随滚动变）。offsetParent 恰是滚动容器（.messages-wrap，position:absolute
           + overflow 滚动）时，旧换算式漏减 scrollTop：滚过 N px 后量出的 top 全体
           虚高 N，而盖子 rect.top 是视口坐标 → trackTop = 成员顶 - 盖子顶 混纲，
           实测 scrollTop=670 时滚动条轨道被画到盖子下方 8358px（用户截图「右侧
           一大条空白沟 + 滚动条漂在远处」）；overflow/补偿同被污染，末成员负
           margin 多扣 ⇒ 后续正文整体上提、行与行互相叠压（「页面错乱」）。
           减掉 scrollTop 后两坐标同纲，滚动到任何位置量测都稳定。
           桩 DOM 无 offsetTop/offsetParent → 回落 rect.top（零布局兼容）。 */
        var top = r.top;
        if (typeof el.offsetTop === 'number' && el.offsetParent
                && typeof el.offsetParent.getBoundingClientRect === 'function') {
            var op = el.offsetParent;
            var opr = op.getBoundingClientRect();
            var ost = el.ownerDocument.defaultView.getComputedStyle
                ? el.ownerDocument.defaultView.getComputedStyle(op) : null;
            var inset = ost ? (parseFloat(ost.borderTopWidth) || 0) + (parseFloat(ost.paddingTop) || 0) : 0;
            top = el.offsetTop + opr.top + inset - (op.scrollTop || 0);
        }
        return { h: r.height, mt: el._winMt, mb: el._winMb, top: top };
    }

    /* 【code review 修复 2026-11 · margin 折叠】行位置绝不按 Σ(mt+h+mb) 加法推算：
       成员是普通块级兄弟，相邻 margin 会折叠（实际间距 = max(mb_i, mt_i+1)），
       加法模型每接缝多算 margin（卡体内 8px/缝，20 行偏差 ~150px，clip 逐行错位）。
       一律用 rect.top 差分实测。前提：refreshWindow 量测前已清掉全部补偿 margin
       （负 mb 会经折叠把末行布局位上提，污染 rect.top），此处量到的即未补偿布局。
       所有可见成员被同一 translateY(-pos) 位移，rect 差值与 pos 无关，天然免疫
       transform。origin = 首成员 top - mt0（成员区布局顶）。
       桩 DOM 所有 rect.top 恒 0（差分不可用）时回落加法模型（契约测试兼容）。 */
    function windowGeometry(visible, metrics) {
        var rows = [];
        /* 单成员没有差分对，rect 模型同样精确；≥2 成员全 top=0 视为零布局桩 → 加法回落 */
        var additive = visible.length > 1;
        for (var i = 1; i < visible.length; i++) {
            if (metrics[i].top !== metrics[0].top) { additive = false; break; }
        }
        var acc = 0;
        /* origin = 首成员 mt 上缘（含首 mt）：与加法模型 acc 同口径，
           保证 total 含首尾全部基值 margin，补偿后占位恒 = WIN。 */
        var origin = additive ? 0 : metrics[0].top - metrics[0].mt;
        for (var j = 0; j < visible.length; j++) {
            var m = metrics[j];
            var rowTop = additive ? acc + m.mt : m.top - origin;
            rows.push(rowTop);
            acc = rowTop + m.h + m.mb;
        }
        var last = metrics[metrics.length - 1];
        var total = additive ? acc : (last.top + last.h + last.mb) - origin;
        /* additive 标志必须随几何下发：paintWindow 的补偿口径要按【同一判定】分叉。
           旧实现用「首末 top 不等」二次推断 rect 模式 —— 单成员窗（一张展开的长思考卡
           就超 232px）首末是同一节点恒等，被误判 additive ⇒ comp 多扣 mt0（2px），
           后续内容整体上提 2px。单一事实来源，杜绝两处判定分叉。 */
        return { rows: rows, total: total, additive: additive };
    }

    /* inline 样式写入助手：margin-bottom 补偿必须带 !important（压过 app.css
       运行态/展开态的 margin !important，见文件头注释）；其余属性普通写入。
       桩 DOM 的 style 是裸对象（无 setProperty）→ 回落属性赋值，契约测试可量。 */
    function setStyle(el, prop, val, important) {
        if (!el.style) return;
        if (important && typeof el.style.setProperty === 'function') {
            if (val === '') el.style.removeProperty(prop);
            else el.style.setProperty(prop, val, 'important');
            return;
        }
        if (prop === 'margin-bottom') el.style.marginBottom = val;
        else if (prop === 'margin-top') el.style.marginTop = val;
        else if (prop === 'transform') el.style.transform = val;
        else if (prop === 'clip-path') el.style.clipPath = val;
    }

    /* 把滚动位置应用到 DOM：成员 translateY(-pos) + clip-path 裁窗 +
       末成员 margin-bottom = 基值 - overflow（把溢出高度从布局占位里吃掉）。
       行位置来自 windowGeometry 的 rect 差分实测（免疫兄弟 margin 折叠）：
         clip = inset( max(0, pos - rowTop_i) 0 max(0, rowBottom_i - (pos + WIN)) 0 )
       占位恒等式（total = 成员区实测总高含基值 margin，overflow = total - WIN）：
         成员布局位置完全不动（translate 是纯视觉位移，不改布局），
         末成员 margin-bottom = mbLast - overflow ⇒ 批次总占位恒 = WIN，
         后续内容（正文/页脚）位置与 pos 无关、绝不随滚动漂移。
       负 margin 合法：mbLast < overflow 时把后续内容上提，正是「吃掉溢出」语义。
       clip 在 transform 之前的本地坐标系计算，与 translateY 天然配套。
       【写放大抑制】值未变的成员跳过写入（几百成员 × 秒级 ticker × 滚轮 60Hz）。 */
    function paintWindow(header, visible, metrics, pos, overflow, geom) {
        var g = geom || windowGeometry(visible, metrics);
        for (var i = 0; i < visible.length; i++) {
            var el = visible[i];
            var m = metrics[i];
            var rowTop = g.rows[i];
            var rowBottom = rowTop + m.h;
            var clipTop = Math.max(0, pos - rowTop);
            var clipBottom = Math.max(0, rowBottom - (pos + WINDOW_MAX_PX));
            var tf = pos > 0 ? 'translateY(' + (-pos) + 'px)' : '';
            var cp = (clipTop > 0 || clipBottom > 0)
                ? 'inset(' + px(clipTop) + ' 0 ' + px(clipBottom) + ' 0)' : '';
            var isLast = i === visible.length - 1;
            /* 【rect 模式补偿口径】total 量的是「首成员 mt 上缘 → 末成员 mb 下缘」，
               但首成员 mt 与盖子的 mb 折叠后被盖子「吃掉」（不占成员区布局），
               末成员 mb 同理与后续兄弟折叠。真正可压缩的占位 = total - mt0 - mbLast
               + max(mbLast, mtNext) …… 精确建模折叠链成本过高。
               工程口径：补偿量 = overflow - mt0（首 mt 已被盖子折叠吸收，
               不该再压一次），末行 mb 写 mbLast - (overflow - mt0)。
               additive 桩无折叠，mt0 不吸收，保持原式。 */
            var comp = g.additive ? overflow : Math.max(0, overflow - metrics[0].mt);
            var mb = isLast
                ? (Math.round((m.mb - comp) * 100) / 100) + 'px'
                : px(m.mb);
            var cache = el._winPaint || (el._winPaint = {});
            if (cache.tf !== tf) { setStyle(el, 'transform', tf, false); cache.tf = tf; }
            if (cache.cp !== cp) { setStyle(el, 'clip-path', cp, false); cache.cp = cp; }
            if (cache.mb !== mb) { setStyle(el, 'margin-bottom', mb, true); cache.mb = mb; }
            /* 补偿量游标：下一轮量测前清 margin 用（记录上轮写入的偏移） */
            el._winCompMb = isLast ? -comp : 0;
        }
    }

    function clearWindowPaint(ms) {
        for (var i = 0; i < ms.length; i++) {
            var el = ms[i];
            if (el.style) {
                /* margin 一律清空交还样式表：写死基值会把样式表后续变更
                   （主题/紧凑层）钉死；清 inline 才是真还原。 */
                setStyle(el, 'transform', '', false);
                setStyle(el, 'clip-path', '', false);
                setStyle(el, 'margin-top', '', true);
                setStyle(el, 'margin-bottom', '', true);
            }
            el._winMt = undefined;
            el._winMb = undefined;
            el._winPaint = undefined;
            el._winCompMb = undefined;
        }
    }

    /* 刷新滚动窗：量总高 → 算 overflow → 应用 pos。
       follow=true（新成员到达/展开）时若原 pos 贴底则跟到最新。幂等可高频调。 */
    function refreshWindow(header, follow) {
        if (!header || !header.parentNode || !measurable(header)) return;
        var open = header.getAttribute('data-batch-open') === 'true';
        var ms = membersOf(header);
        var visible = [];
        for (var i = 0; i < ms.length; i++) {
            /* 交互卡（HITL 接管后仍带标记的残留/恢复路径）不进窗：常驻可见，
               与 applyMembers 的豁免同口径。 */
            if (isInteractiveCard(ms[i])) continue;
            if (!(ms[i].classList && ms[i].classList.contains('turn-batch-collapsed'))) visible.push(ms[i]);
        }
        if (!open || visible.length === 0) {
            teardownWindow(header);
            if (!open) clearBatchGuide(header);
            return;
        }
        /* 【量测前必须先清补偿 + 强制重排】负 margin-bottom 会经兄弟 margin 折叠
           把后续行布局位整体上提（rect.top 被污染）；上一轮补偿可能写在【旧末行】
           （新成员到达后它已不是末行，但补偿还挂在它身上）。按 _winVisible 旧缓存
           清全部曾入窗成员的 inline margin 与补偿游标，再【读一次布局强制同步
           重排】，之后量到的 rect 才是未补偿位。transform/clip 不动（rect 与它们
           无关）。读-写-读三段，每秒一次可接受。 */
        var toClear = header._winVisible || visible;
        for (var c = 0; c < toClear.length; c++) {
            setStyle(toClear[c], 'margin-top', '', true);
            setStyle(toClear[c], 'margin-bottom', '', true);
            /* 【必须同步清 transform】translateY(-pos) 是视觉位移，rect.top
               含它；只清 margin 不清 transform，量到的 top 仍带 -pos 偏移，
               origin 虽差分抵消，但末行 total 与 clip 行位全部错位 pos。
               清 transform 后 rect 即纯布局位（clip 不影响 rect）。 */
            setStyle(toClear[c], 'transform', '', false);
            if (toClear[c]._winPaint) { toClear[c]._winPaint.mb = undefined; toClear[c]._winPaint.tf = undefined; }
            toClear[c]._winCompMb = undefined;
        }
        for (var c2 = 0; c2 < visible.length; c2++) {
            if (toClear.indexOf(visible[c2]) >= 0) continue;
            setStyle(visible[c2], 'margin-top', '', true);
            setStyle(visible[c2], 'margin-bottom', '', true);
            setStyle(visible[c2], 'transform', '', false);
            if (visible[c2]._winPaint) { visible[c2]._winPaint.mb = undefined; visible[c2]._winPaint.tf = undefined; }
            visible[c2]._winCompMb = undefined;
        }
        void visible[0].getBoundingClientRect();   /* 强制 flush 布局 */
        var metrics = [];
        for (var v = 0; v < visible.length; v++) metrics.push(memberMetrics(visible[v]));
        var geom = windowGeometry(visible, metrics);
        var overflow = Math.max(0, geom.total - WINDOW_MAX_PX);
        /* 层级引导线：平铺态（未建窗）也要画。此刻补偿已清、布局已 flush，
           metrics 是纯布局位 —— 用几何差分（末行底 - 首行顶），与窗几何同源。 */
        if (overflow <= 0.5) {
            teardownWindow(header);
            var lastM = metrics[metrics.length - 1];
            var guideH = (lastM.top + lastM.h) - metrics[0].top;
            if (guideH > 0 && header.style && header.style.setProperty) {
                var gv = px(guideH);
                if (header._guideH !== gv) { header.style.setProperty('--batch-guide-h', gv); header._guideH = gv; }
            } else {
                clearBatchGuide(header);
            }
            return;
        }
        /* 【滚动条可见性 2026-11 用户报「固定高度，滚动条没显示」】clip+translate 是
           合成器绘制，浏览器不产原生滚动条 —— 必须自绘 thumb（绝对定位浮层，
           不参与布局，成员兄弟区间/邻接判定零影响）。 */
        /* pos 恢复/跟随：_winPos 是运行时游标（不落 DOM 属性，回放不会误读）。
           首窗：running 态贴底看最新；closed 态（历史/收口后点开）从头看更自然。 */
        var prevPos = header._winPos;
        var prevOverflow = header._winOverflow;
        var pos;
        if (typeof prevPos !== 'number') {
            pos = header.getAttribute('data-batch-state') === 'running' ? overflow : 0;
        } else {
            var pinned = (prevOverflow - prevPos) <= FOLLOW_SLACK_PX;
            pos = (follow && pinned) ? overflow : prevPos;
        }
        pos = Math.max(0, Math.min(overflow, pos));
        /* 离开窗口的旧成员（被折叠/删除）残留的位移与 margin 必须清掉 */
        if (header._winVisible) {
            var gone = [];
            for (var g = 0; g < header._winVisible.length; g++) {
                if (visible.indexOf(header._winVisible[g]) < 0) gone.push(header._winVisible[g]);
            }
            if (gone.length) clearWindowPaint(gone);
        }
        header._winPos = pos;
        header._winOverflow = overflow;
        header._winVisible = visible;
        header._winMetrics = metrics;
        header._winGeom = geom;
        header.classList.add('turn-batch-windowed');
        /* 滚动条几何必须在 paintWindow 之前量：metrics 是清补偿后的纯布局位，
           paint 之后 rect.top 含 translateY(-pos)，反解易错。 */
        paintWindowScrollbar(header, pos, overflow);
        paintWindow(header, visible, metrics, pos, overflow, geom);
        paintBatchGuide(header);
        bindWindowWheel(header);
        bindScrollbarDrag(header);
    }

    /* ===== 自绘滚动条（2026-11 用户报「收缩折叠固定高度，滚动条没显示」）=====
       合成滚动没有原生滚动条，用户无从感知「还有更多行」也无法拖动定位。
       【零 DOM 插入】滚动条画在【盖子自身的 ::after】上（button 可渲染伪元素）：
         · 盖子 position:relative（CSS），::after absolute 贴盖子右缘，
           top = 盖子高 + 盖子 mb 与首成员 mt 折叠后的间隙（成员区真实顶），
           height = WINDOW_MAX_PX；thumb 高按视窗/总高比例、位置按 pos/overflow
           比例，全部经 CSS 变量（--win-sb-top/-h/-thumb-h/-thumb-y）下发。
         · 兄弟区间/邻接校验/compact 分类零影响（没有新节点）；折叠时盖子
           display:none，滚动条随盖子一起消失，无残留清扫负担。
         · 拖动：pointerdown 命中盖子右缘 SB_HIT 区（thumb 轨道）时接管，
           pointermove 换算 pos 写游标 + paintWindow（与 wheel 同一绘制管线），
           并 stopPropagation 防止冒泡触发盖子的展开/收起 click。
         · wheel 高频路径只写 CSS 变量（纯算术），不读布局。 */
    var SB_W = 6;              /* 轨道视觉宽度 */
    var SB_HIT = 16;           /* 盖子右缘拖动命中区宽度（视觉 6px，命中 16px） */
    var SB_MIN_THUMB = 28;     /* thumb 最小高度：内容极长时仍可抓握 */

    /* 量测/重绘滚动条几何。metrics 是 refreshWindow 清补偿后、paintWindow 之前
       量的纯布局位（top 不含 translateY），首成员 mt 上缘即成员区顶。 */
    function paintWindowScrollbar(header, pos, overflow) {
        if (!header || !header.style || !header.style.setProperty || !measurable(header)) return;
        var ms = header._winVisible, metrics = header._winMetrics;
        if (!ms || !ms.length || !metrics || !metrics.length) return;
        var hr = header.getBoundingClientRect();
        if (!(hr.height > 0)) return;   /* 零布局桩：不写滚动条变量 */
        /* 成员区顶相对盖子顶 = 首成员布局顶 - 盖子布局顶。
           metrics[0].top 是 offsetTop 换算的【纯布局位】（不含 translateY），
           盖子自身无 transform，rect.top 即布局位 —— 直接差分，不再建模
           margin 折叠间隙（探针实测 gap 模型与真实布局差 2px）。 */
        var trackTop = metrics[0].top - hr.top;
        if (!(trackTop >= 0)) trackTop = hr.height;   /* 防御：异常几何回落盖子高 */
        var total = overflow + WINDOW_MAX_PX;
        var thumbH = Math.max(SB_MIN_THUMB, Math.round(WINDOW_MAX_PX * WINDOW_MAX_PX / total));
        var thumbTop = overflow > 0 ? Math.round((WINDOW_MAX_PX - thumbH) * pos / overflow) : 0;
        header.style.setProperty('--win-sb-top', px(trackTop));
        header.style.setProperty('--win-sb-h', px(WINDOW_MAX_PX));
        header.style.setProperty('--win-sb-thumb-h', px(thumbH));
        header.style.setProperty('--win-sb-thumb-y', px(thumbTop));
        header._winSbGeom = { trackTop: trackTop, thumbH: thumbH, headH: hr.height };
    }

    /* wheel / 拖动共用：只更新 thumb 位移变量（纯算术，不读布局）。 */
    function moveWindowScrollbar(header, pos, overflow) {
        var g = header._winSbGeom;
        if (!g || !header.style || !header.style.setProperty) return;
        var thumbTop = overflow > 0 ? Math.round((WINDOW_MAX_PX - g.thumbH) * pos / overflow) : 0;
        header.style.setProperty('--win-sb-thumb-y', px(thumbTop));
    }

    /* 拖动命中：盖子右缘 SB_HIT 宽、纵向落在轨道区间内。
       clientX/Y 与盖子 rect 差分；rect 每次 down 读一次（低频）。 */
    function scrollbarHit(header, ev) {
        var g = header._winSbGeom;
        if (!g || typeof ev.clientX !== 'number' || typeof ev.clientY !== 'number') return false;
        var hr = header.getBoundingClientRect();
        var x = ev.clientX - hr.left, y = ev.clientY - hr.top;
        return x >= hr.width - SB_HIT && x <= hr.width
            && y >= g.trackTop && y <= g.trackTop + WINDOW_MAX_PX;
    }

    /* 拖动绑在【宿主容器】上（与 wheel 同策略）：::after 伪元素 pointer-events:none，
       轨道区的 pointerdown 实际命中的是【成员行】而不是盖子 —— 绑盖子收不到事件。
       按 clientX/Y 几何判定落在哪个 windowed 盖子的轨道区（scrollbarHit），
       命中才接管；其余落点零干预（成员卡自己的展开 click 不受影响）。
       接管后 document 级 pointermove/up + header.setPointerCapture 双保险，
       拖动越出轨道也不丢手；click 吞掉用「容器 capture + 近期拖动标记」，
       防止松手时误触成员卡/盖子的 click。 */
    function bindScrollbarDrag(header) {
        var bubble = header.parentNode;
        if (!bubble || bubble._winSbDragBound || typeof bubble.addEventListener !== 'function') return;
        bubble._winSbDragBound = true;
        bubble.addEventListener('pointerdown', function (ev) {
            if (!ev) return;
            var hs = childHeadersOf(bubble);
            var h = null;
            for (var i = 0; i < hs.length; i++) {
                if (hs[i].classList && hs[i].classList.contains('turn-batch-windowed')
                        && scrollbarHit(hs[i], ev)) { h = hs[i]; break; }
            }
            if (!h) return;
            if (ev.stopPropagation) ev.stopPropagation();
            if (ev.preventDefault) ev.preventDefault();
            var overflow = h._winOverflow;
            var g = h._winSbGeom;
            if (!(overflow > 0) || !g) return;
            var startY = ev.clientY;
            var startPos = h._winPos || 0;
            var travel = WINDOW_MAX_PX - g.thumbH;
            var doc = h.ownerDocument;
            function onMove(e) {
                if (travel > 0) {
                    var dy = (e.clientY - startY);
                    var next = Math.max(0, Math.min(overflow, startPos + dy * overflow / travel));
                    h._winPos = next;
                    paintWindow(h, h._winVisible || [], h._winMetrics || [], next, overflow, h._winGeom);
                    moveWindowScrollbar(h, next, overflow);
                }
                bubble._winSbDragUntil = Date.now() + 250;
                if (e.preventDefault) e.preventDefault();
            }
            function onUp() {
                bubble._winSbDragUntil = Date.now() + 250;
                if (doc && doc.removeEventListener) {
                    doc.removeEventListener('pointermove', onMove, true);
                    doc.removeEventListener('pointerup', onUp, true);
                    /* 【code review 修复 2026-11】pointercancel 必须同路拆除：
                       触屏滚动接管 / 系统手势 / 设备拔除时浏览器只发 cancel 不发 up，
                       旧实现漏挂 ⇒ document 级 capture move 监听永久残留，
                       之后每次移动鼠标都按旧几何改 pos + 吞 click（整卡点不动）。 */
                    doc.removeEventListener('pointercancel', onUp, true);
                }
            }
            bubble._winSbDragUntil = Date.now() + 250;
            if (doc && doc.addEventListener) {
                doc.addEventListener('pointermove', onMove, true);
                doc.addEventListener('pointerup', onUp, true);
                doc.addEventListener('pointercancel', onUp, true);
            }
            if (h.setPointerCapture && ev.pointerId !== undefined) {
                try { h.setPointerCapture(ev.pointerId); } catch (e) { /* 桩 DOM */ }
            }
        }, true);
        /* 拖动刚结束的一瞬松手 click 不得触发盖子收起/成员卡展开。 */
        bubble.addEventListener('click', function (ev) {
            if (bubble._winSbDragUntil && Date.now() < bubble._winSbDragUntil) {
                if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
                else if (ev.stopPropagation) ev.stopPropagation();
                if (ev.preventDefault) ev.preventDefault();
            }
        }, true);
    }

    /* ===== 层级引导线（⑳ Qoder 缩进对齐，2026-11 用户「每个层级缩进一目了然」）=====
       盖子 ::before 画一条 1px 竖线贯穿成员区左列（CSS 见 app.css ⑳ 块），
       高度经 --batch-guide-h 下发。量测口径与滚动条同源：
         · 建窗态：恒 = WINDOW_MAX_PX（窗占位恒定，与 pos 无关）；
         · 平铺态：末成员布局底 - 首成员布局顶（memberMetrics 纯布局位差分，
           须在清补偿后的量测段调用；本函数自身只读 rect，不写布局）。
       零布局桩（Node 契约测试）measurable=false 直接 no-op，测试零感知。 */
    function paintBatchGuide(header) {
        if (!header || !header.style || !header.style.setProperty) return;
        if (header.getAttribute('data-batch-open') !== 'true') { clearBatchGuide(header); return; }
        /* 建窗态：窗占位恒 = WINDOW_MAX_PX，纯常量无需布局（桩 DOM 也可断言）。
           平铺态的高度在 refreshWindow 清补偿量测段内联下发（那里才有纯布局位），
           本函数不做第二次量测（paint 后 rect 含 translateY，量了就是错的）。 */
        if (!(header.classList && header.classList.contains('turn-batch-windowed'))) return;
        var v = px(WINDOW_MAX_PX);
        if (header._guideH !== v) {
            header.style.setProperty('--batch-guide-h', v);
            header._guideH = v;
        }
    }

    function clearBatchGuide(header) {
        if (!header || !header.style || !header.style.removeProperty) return;
        if (header._guideH !== undefined) {
            header.style.removeProperty('--batch-guide-h');
            header._guideH = undefined;
        }
    }

    /* 拆窗：位移/裁剪/margin 全部还原，类与游标清除（成员回原平铺位）。 */
    function teardownWindow(header) {
        if (!header) return;
        var had = header.classList && header.classList.contains('turn-batch-windowed');
        clearWindowPaint(header._winVisible || membersOf(header));
        if (header.classList) header.classList.remove('turn-batch-windowed');
        /* 拆窗不清引导线：平铺展开态仍需要它（refreshWindow 的平铺分支会重量下发）；
           收起态由 applyMembers / refreshWindow 的 !open 分支显式 clearBatchGuide。 */
        if (header.style && header.style.removeProperty) {
            header.style.removeProperty('--win-sb-top');
            header.style.removeProperty('--win-sb-h');
            header.style.removeProperty('--win-sb-thumb-h');
            header.style.removeProperty('--win-sb-thumb-y');
        }
        header._winPos = undefined;
        header._winOverflow = undefined;
        header._winVisible = undefined;
        header._winMetrics = undefined;
        header._winGeom = undefined;
        header._winSbGeom = undefined;
        return had;
    }

    /* 滚轮接管：wheel 绑在【气泡/卡体容器】上（成员不是盖子子节点，事件不经过
       盖子），按 ev.target 的 DOM 归属找到窗口批次。一容器一监听防重复。
       到边界放行（不 preventDefault）：页面继续滚，不吃掉整页滚动。 */
    function bindWindowWheel(header) {
        var bubble = header.parentNode;
        if (!bubble || bubble._winWheelBound || typeof bubble.addEventListener !== 'function') return;
        bubble._winWheelBound = true;
        bubble.addEventListener('wheel', function (ev) {
            if (!ev || typeof ev.deltaY !== 'number') return;
            var h = windowHeaderForEvent(bubble, ev);
            if (!h) return;
            var overflow = typeof h._winOverflow === 'number' ? h._winOverflow : 0;
            if (overflow <= 0) return;
            /* deltaMode 归一化：Firefox 滚轮默认 DOM_DELTA_LINE（deltaY≈±3），
               直接当 px 用每格只滚 3px，窗内滚动近乎不可用。 */
            var dy = ev.deltaY;
            if (ev.deltaMode === 1) dy *= 29;               /* 行 → 过程行高 */
            else if (ev.deltaMode === 2) dy *= WINDOW_MAX_PX; /* 页 → 视窗高 */
            var pos = typeof h._winPos === 'number' ? h._winPos : 0;
            var next = Math.max(0, Math.min(overflow, pos + dy));
            if (next === pos) return;   /* 已在边界：放行给页面 */
            h._winPos = next;
            paintWindow(h, h._winVisible || [], h._winMetrics || [], next, overflow, h._winGeom);
            moveWindowScrollbar(h, next, overflow);
            if (ev.preventDefault) ev.preventDefault();
        }, { passive: false });
    }

    function windowHeaderForEvent(bubble, ev) {
        var target = ev.target;
        if (!target) return null;
        var hs = childHeadersOf(bubble);
        for (var i = 0; i < hs.length; i++) {
            var h = hs[i];
            if (!h.classList || !h.classList.contains('turn-batch-windowed')) continue;
            if (h === target || (h.contains && h.contains(target))) return h;
            var ms = membersOf(h);
            for (var j = 0; j < ms.length; j++) {
                if (ms[j] === target || (ms[j].contains && ms[j].contains(target))) return h;
            }
        }
        return null;
    }

    /* 容器内全部滚动窗重算（流式正文/思考长高、窗口 resize 后调用；
       只动 open 的盖子，follow 语义与 noteProcessInsert 一致）。 */
    function refreshWindowsIn(container) {
        if (!container || !container.querySelectorAll || !measurable(container)) return;
        var hs = container.querySelectorAll('.turn-batch-header');
        for (var i = 0; i < hs.length; i++) {
            if (hs[i].getAttribute('data-batch-open') === 'true') refreshWindow(hs[i], true);
        }
    }

    /* 成员被回滚/purge 删除后的残窗清扫：refreshWindow 只认识还挂在 DOM 上的
       成员，被删节点的 inline transform/margin 随节点消失无所谓，但盖子的
       _winVisible 缓存可能指向游离节点、overflow 已失真 —— 对容器内全部
       windowed 盖子强制重量（sweepOrphanBatchHeaders 的调用方顺带受益）。 */
    function sweepWindows(container) {
        if (!container || !container.querySelectorAll || !measurable(container)) return;
        var hs = container.querySelectorAll('.turn-batch-header.turn-batch-windowed');
        for (var i = 0; i < hs.length; i++) refreshWindow(hs[i], false);
    }

    /* 【code review 修复 2026-11 · HITL 接管吞卡】骨架卡（action_draft）先入批，
       hitl 帧原地接管同一节点加 .hitl-pending —— 若不摘成员标记，收口时
       applyMembers(false) 给这张【待审批卡】加 .turn-batch-collapsed ⇒
       display:none!important，批准/拒绝按钮消失、任务表面卡死。
       交互卡转态时必须：摘 data-turn-batch + 摘折叠类 + 清残留窗绘制，
       再重算所属盖子的窗（成员少了一个，overflow/占位都要更新）。 */
    function detachInteractiveMember(el) {
        if (!el || !el.getAttribute || el.getAttribute('data-turn-batch') !== '1') return;
        var bubble = el.parentNode;
        var header = null;
        if (bubble && bubble.children) {
            var kids = bubble.children;
            var idx = Array.prototype.indexOf.call(kids, el);
            for (var i = idx - 1; i >= 0; i--) {
                var k = kids[i];
                if (k.classList && k.classList.contains('turn-batch-header')) { header = k; break; }
            }
        }
        el.removeAttribute('data-turn-batch');
        if (el.classList) el.classList.remove('turn-batch-collapsed');
        clearWindowPaint([el]);
        if (header) refreshWindow(header, false);
    }

    /* 成员可见性单一入口：open=true 移除折叠类，false 加上；盖子 aria / chevron 类同步。 */
    function applyMembers(header, open) {
        if (!header) return;
        var ms = membersOf(header);
        for (var i = 0; i < ms.length; i++) {
            /* 防御性豁免：入批后转交互态的成员（HITL 接管/恢复）绝不折叠——
               等用户拍板的卡必须常驻可见（与 detachInteractiveMember 双保险）。 */
            if (isInteractiveCard(ms[i])) {
                ms[i].classList.remove('turn-batch-collapsed');
                continue;
            }
            if (open) ms[i].classList.remove('turn-batch-collapsed');
            else ms[i].classList.add('turn-batch-collapsed');
        }
        if (open) header.classList.add('turn-batch-open');
        else header.classList.remove('turn-batch-open');
        header.setAttribute('aria-expanded', open ? 'true' : 'false');
        header.setAttribute('data-batch-open', open ? 'true' : 'false');
        /* 展开/收起都重算滚动窗：展开限高，收起拆窗（假 DOM no-op）。
           收起时 refreshWindow 可能因桩 DOM 提前返回，引导线在此兜底清除。 */
        refreshWindow(header, true);
        if (!open) clearBatchGuide(header);
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
            /* 拆窗必须在摘盖子之前：位移/裁剪/margin 补偿都挂在成员上，
               盖子没了就再也找不到归属，残留 transform 会让成员视觉错位。 */
            teardownWindow(hs[i]);
            clearBatchGuide(hs[i]);
            if (hs[i].parentNode) hs[i].parentNode.removeChild(hs[i]);
        }
        var ms = container.querySelectorAll('[data-turn-batch]');
        for (var j = 0; j < ms.length; j++) {
            ms[j].removeAttribute('data-turn-batch');
            if (ms[j].classList) ms[j].classList.remove('turn-batch-collapsed');
        }
    }

    /* 展开容器内全部批次成员（盖子同步回 open 态），但【不删】盖子。
       【2026-11 用户拍板后仅保留为导出 API / 测试用途】compactBubble 的失败轮分支
       不再自动调用它（失败轮保持批次折叠，错误块本就在批次外常驻可见）。 */
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
        /* 宿主白名单（2026-11 方案A 用户拍板：卡内与外部同构折叠）：
           · 主气泡 .msg-bubble（原行为）
           · 子代理卡体 .agent-card-body —— 卡内工具/思考同样进批次盖子，
             与外部消息共用同一份 noteProcessInsert/closeBatchFor/membersOf 逻辑，
             一处维护。盖子是卡体直接子级 button，不插任何包装节点，
             app.css:825 的相邻兄弟选择器不受影响（盖子不是 md/thinking 的兄弟定位锚）。 */
        var inAgentBody = !!(bubble.classList && bubble.classList.contains('agent-card-body'));
        if (!inAgentBody
                && !(bubble.classList && bubble.classList.contains('msg-bubble'))) return null;
        /* 【交互卡边界 · 2026-11 用户报障「只要展示 HITL/智能体这两个，页面就会错乱」】
           待审批 HITL 卡 / 问答记录是等用户拍板的交互边界：收口当前运行批次（与
           .agent-card 同口径），自身【永不】进成员区 —— 否则批次收口时审批按钮 /
           问答记录随成员一起隐藏（HITL 卡带 .tool-card 类，旧实现必吞）。
           必须在 isProcessRow 门禁【之前】判定：hitl-pending 卡同时带 tool-card 类。 */
        if (isInteractiveCard(el)) {
            /* 接管路径：骨架卡可能已带 data-turn-batch 入批 —— 先摘标记再收口，
               否则收口把待审批卡一并折叠隐藏（审批按钮消失，任务卡死）。 */
            detachInteractiveMember(el);
            closeBatchFor(bubble);
            return null;
        }
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
        } else {
            /* 新成员入窗：限高 + 贴底跟随（用户上滑离开底部后 refreshWindow 不跟）。
               假 DOM / 游离节点 measurable=false 全链 no-op。 */
            refreshWindow(header, true);
        }
        return header;
    }

    /* 收口：容器内【全部】运行批次 → 「已处理」+ 成员折叠（倒序遍历，收口不改变集合）。
       零成员的盖子直接移除（空壳比不显示更误导）。返回是否有批次被收口/移除。
       【方案A】容器既可以是主气泡，也可以是智能体卡体（childHeadersOf 只认直接子级，
       主气泡收口不会误关卡内的 running 盖子）。 */
    function closeBatchFor(bubble, nowMs) {
        if (!bubble || !bubble.querySelectorAll) return false;
        var hs = childHeadersOf(bubble);
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

    /* 会话级收口入口：正文 / 错误到达时调用（指针所在气泡）。
       【卡内批次收口】传 st（子代理状态）时收口该卡体内部的 running 盖子——
       子代理正文到达（appendBodyContentCore, h !== sess 分支）与 agent_end 收卡
       两条路径共用。不传 st 时维持原语义（主线路指针气泡）。 */
    function closeBatch(sess, nowMs, st) {
        if (!sess) return false;
        if (st && st.bodyEl) return closeBatchFor(st.bodyEl, nowMs);
        var bubble = sess.currentBubbleEl ? sess.currentBubbleEl.parentNode : null;
        return closeBatchFor(bubble, nowMs);
    }

    /* 孤儿清扫：成员被回滚 / purge 删光的盖子移除（流中断重传后必调）。
       【code review 修复 2026-11】顺带对存活 windowed 盖子强制重量：
       被删成员的 rect 已失真，_winVisible 缓存可能指向游离节点。 */
    function sweepOrphanBatchHeaders(container) {
        if (!container || !container.querySelectorAll) return 0;
        sweepWindows(container);
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
        /* 已有盖子 = 运行态延续的气泡（恢复流式）或重复调用：不重建，避免双盖子
           （只看直接子级：卡体内盖子不算本气泡已有盖子） */
        if (childHeadersOf(bubble).length > 0) return 0;
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
            /* 边界一·补：交互卡（待审批 HITL 卡 / 问答记录）—— 与运行态
               noteProcessInsert 的 isInteractiveCard 分支同口径：收口当前批、
               自身不是成员、也不是整轮过程行（classifyChildren 白名单同源）。 */
            if (isInteractiveCard(el)) {
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
                /* 【2026-11 用户报障：历史折叠态箭头方向错】createHeader 挂的 .turn-batch-open
                   类只摘属性不摘类时，CSS :not(.turn-batch-open) 的旋转规则（app.css:4373）
                   永不命中 → 历史折叠盖子的 chevron 一直朝下（展开态方向），与运行态收口后的
                   右向箭头不一致。applyMembers(header,false) 是唯一同时同步类/aria/data 的
                   单一入口，这里直接走它（成员折叠类已在下方循环统一补，重复 add 幂等）。 */
                applyMembers(header, false);
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
        /* 【方案A · 卡内历史批次】下钻智能体卡体：历史帧里的子代理工具/思考同样
           按 run 态规则补建 closed 态盖子。卡体边界规则与主气泡一致（非空正文切断
           批次），但卡内没有嵌套 agent-card（子代理不再嵌套派发），无边界一分支。 */
        var agentBodies = bubble.querySelectorAll('.agent-card-body');
        for (var ab = 0; ab < agentBodies.length; ab++) {
            built += rebuildBatches(agentBodies[ab], meta);
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

    /* 【自己保留可见】的元素：错误、max-token、系统提示、HITL / 问答交互卡、文件变更卡、
       上下文压缩分隔线（轮次边界标记，折叠后仍可见；且必须锚点化保位——它标的是
       「压缩前/后」的时序分界，被重排到正文上方就成了无归属的孤行，
       2026-11 用户截图报障「已压缩上下文夹在折叠盖子与正文之间，很明显有问题」）。 */
    var KEEP_VISIBLE_SELECTOR = '.err-bubble, .chunk-error, .hitl-card, .question-card, '
        + '.system-notice-bubble, .msg-run-changes-card, .fch-host, .context-compacted-divider';

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
        /* 结束态纯工具轮（无正文）也允许折叠，但停止/挂起终态徽标必须拦住。
           【刻意只读徽标、不读 readTurnMeta 的气泡覆盖位】markTurnStatus 写入的
           suspended 覆盖位是给【无徽标挂起段】补终态文案用的（标「已挂起」），
           它不得反过来在这里否决折叠 —— 否则挂起段永远折不动，与 2026-11 用户
           拍板的「挂起一并折、状态词标已挂起」直接矛盾。本护栏针对的是【后端已发
           trace 帧并明确标了 stopped/suspended】的轮次：那种轮次有权威终态证据，
           过程行必须留可见。真实挂起段不发 trace 帧（done_suspended 直接 return），
           走的是「无徽标 → endStatus=null → 放行」这一支。 */
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
            /* 【交互卡边界】待审批 HITL 卡 / 问答记录：等用户拍板 / 用户已拍板的证据，
               与智能体卡同级的不动点 —— 永不进 process（否则被折叠隐藏 + 重排搬离原位，
               用户 2026-11 报「只要展示这两个页面就错乱」的直接成因之一）。 */
            if (isInteractiveCard(el)) return true;
            /* 【最终态折叠】ended 时智能体卡不再常驻 —— 归入 process；
               仅未结束态保持锚点常驻（classifyChildren 的 agentFolds 分叉）。
               【卡内穿透例外】ended 态若卡内仍挂着待审批交互卡，整卡隐藏 = 审批按钮
               消失、用户无法放行（hasInteractiveCardInside 的注释有完整取证），
               此时必须退回常驻锚点。放行后该类被摘除，例外自动失效。 */
            if (el.matches && el.matches(AGENT_SELECTOR)
                    && (!agentFolds || hasInteractiveCardInside(el))) return true;
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
                /* 【agent / 交互卡 / 压缩分隔线锚点化】智能体卡、交互卡（待审批 HITL 卡 /
                   问答记录）与上下文压缩分隔线都不进 tail（不重排到 final 之后）：
                   它们是时序不动点 —— 分隔线标「压缩前/后」分界，搬走即失去归属语义；
                   其余白名单（HITL 旧卡 / 错误 / 页脚）仍由 compactBubble 统一搬到 final 之后。
                   【变更卡钉底 · 2026-11 用户报障「文件变更卡怎么跑到思考上面了」】
                   .fch-host / .msg-run-changes-card 进 tail 但【恒排页脚之前、其余 tail
                   之后】：卡片是整轮的收尾性总结，必须出现在全部正文/错误/交互记录之后
                   （compactBubble 的分区键给它们单独一档，见 isChangesCardAt）。 */
                if (!(el.classList && el.classList.contains('turn-compact-toggle'))
                        && !el.classList.contains('agent-card')
                        && !el.classList.contains('context-compacted-divider')
                        && !isInteractiveCard(el)) tail.push(el);
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

    /* 轮终态读取：徽标真值【优先】，气泡覆盖位仅作回落。
       · 徽标 .msg-trace[data-turn-status]：由 appendTraceBadge 在 trace 帧写入，是后端
         的权威终态（done / stopped / suspended）。
       · 覆盖位 .msg-bubble[data-turn-status]：由 markTurnStatus 写入，服务【无徽标轮】。
         挂起 done（ask_user / HITL）不发 trace 帧（core/src/react/mod.rs 的
         done_suspended 分支直接 return，全仓唯一的 Frame::trace 只在正常结束路径），
         故挂起段气泡永远没有徽标，readTurnMeta 恒返回空、statusWord 一律回落
         「已完成」——把等待作答的轮次谎报成已完成。
       【为何徽标优先】prepend 分页缝合（app-history.js stitchPrependedRunRows）会把收尾页
         的徽标过户给同 runId 的挂起段行（spawn_resume 沿用挂起 runId，两段必然同 runId）。
         缝合后该行承载的是【完整 run】的内容，徽标的 done 才是当下真值，覆盖位是缝合前
         的历史快照，必须让位。反之若覆盖位优先，缝合行会永久显示「已挂起」。 */
    function readTurnMeta(bubble) {
        if (!bubble) return {};
        var out = {};
        var badge = bubble.querySelector ? bubble.querySelector('.msg-trace') : null;
        if (badge && badge.getAttribute) {
            var ms = badge.getAttribute('data-elapsed-ms');
            if (ms != null && ms !== '' && isFinite(Number(ms))) out.elapsedMs = Number(ms);
            var st = badge.getAttribute('data-turn-status');
            if (st) out.status = st;
        }
        if (!out.status && bubble.getAttribute) {
            var ovr = bubble.getAttribute('data-turn-status');
            if (ovr) out.status = ovr;
        }
        return out;
    }

    /* 给【无徽标轮】补记终态，供 readTurnMeta 回落读取（当前唯一用途：挂起段标「已挂起」）。
       不建徽标 DOM：徽标同时承载耗时与时间文案，凭空造一个半截徽标会让页脚多出一枚
       没有耗时的空壳，且与 appendTraceBadge 的 innerHTML 重建逻辑抢同一节点。
       幂等：同值重复写无副作用；status 为空则清除覆盖位（回到「无终态信息」）。 */
    function markTurnStatus(bubble, status) {
        if (!bubble || !bubble.setAttribute) return false;
        if (status) bubble.setAttribute('data-turn-status', String(status));
        else if (bubble.removeAttribute) bubble.removeAttribute('data-turn-status');
        return true;
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
            /* 【2026-11 用户拍板：失败轮也必须保持折叠态】旧实现在此对失败/无终态轮
               revealAll()，把刚收口的批次成员全部摊开 —— 报错后整轮过程行以盒子形态
               平铺（用户报障「报错后折叠变默认展开、工具和思考又变卡片态」的直接根因）。
               失败证据（.err-bubble / .chunk-error）本就是 KEEP_VISIBLE 白名单，永远不被
               批次收口隐藏（isProcessRow 不认它们，appendErrorChunk 还会主动 closeBatch），
               故摊开成员对「看见错误」毫无增益，只制造卡片态回潮。现一律保持批次盖子
               的收口折叠：错误块可见 + 盖子可点开查看过程，两全。 */
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

        /* 【2026-11 codereview 修复 · 只加不删缺陷】重跑必须先清除【本次决策已不在
           process】的旧标记：classifyChildren 是纯函数，节点归属会随 .hitl-pending 类名
           增删而变（见 refreshInteractiveBoundary）。旧实现只 setAttribute 不清除，于是
           「上一轮被折、本轮应变常驻」的节点会残留 data-turn-process —— 失败回退
           restoreHitlCardPending 加回 hitl-pending 后，宿主智能体卡虽已按例外退回 keep，
           标记却还在 → CSS `.msg-bubble > [data-turn-process]{display:none!important}`
           仍生效 → 卡内审批按钮看不到也点不到，任务永久卡死（探针实测 CONFIRMED）。
           幂等性要求：重跑后 DOM 状态必须【等于】本次决策状态，而非只增不减。
           清除范围限气泡直接子节点，与上方 :861 / :881 两处同口径。 */
        var prevMarked = bubble.querySelectorAll ? bubble.querySelectorAll(':scope > [data-turn-process]') : [];
        for (var pm = 0; pm < prevMarked.length; pm++) {
            if (decision.process.indexOf(prevMarked[pm]) < 0) prevMarked[pm].removeAttribute('data-turn-process');
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
              · toggle（已存在）：minProcKey - 0.5 —— 【紧贴首个过程段】，不再恒最前。
                旧实现钉死 -1 + placeToggle 强制提到 children[0]，会把排在首个过程段
                【之前】的时序不动点锚（qa-record / 待审批 HITL 卡）挤到盖子下方 ——
                而盖子折叠的恰是锚【之后】的过程行，运行态时序被颠倒（用户 2026-11
                报障「先出 qa，执行一段时间后插话，折叠盖子却显示在 qa 卡上侧」；
                探针实测 toggle=0、qa=1）。无锚点轮 minProcKey=1 → 0.5 仍恒最前，
                与旧行为完全一致（零回归）。
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
        /* 不动点锚 = 智能体卡 + 交互卡（待审批 HITL 卡 / 问答记录）+ 上下文压缩分隔线：
           保持原始时序位置，过程行在锚之间分段收拢。交互卡与 agent 卡同权（2026-11
           用户报障：展示 HITL / 问答记录时页面错乱 = 被重排搬离原位 + 被折叠隐藏）；
           分隔线同权（2026-11 用户截图：压缩提示被搬到折叠盖子与正文之间成孤行 ——
           它必须钉在「压缩前过程 / 压缩后内容」的原时序分界上）。 */
        function isAgentAt(i) {
            var n = kidsAll[i];
            if (!n || !n.classList) return false;
            if (n.classList.contains('agent-card')) return true;
            if (n.classList.contains('context-compacted-divider')) return true;
            return isInteractiveCard(n);
        }
        /* 【变更卡钉底】宿主/卡片是整轮收尾性总结：tail 区内单独一档（2m+3.5），
           恒排其余 tail（错误/HITL 旧卡/未知块）之后、页脚（2m+3 中的 meta/actions
           原序）之前？——不：页脚必须仍是最后。页脚 meta/actions 用 2m+3.9 兜底档，
           变更卡 2m+3.5，其余 tail 2m+3。三档同侧保序：正文 → 错误/交互 → 变更卡 → 页脚。 */
        function isChangesCardAt(i) {
            var n = kidsAll[i];
            if (!n || !n.classList) return false;
            return n.classList.contains('fch-host') || n.classList.contains('msg-run-changes-card');
        }
        function isFooterAt(i) {
            var n = kidsAll[i];
            if (!n || !n.classList) return false;
            return n.classList.contains('msg-meta-row') || n.classList.contains('msg-actions')
                || n.classList.contains('msg-time') || n.classList.contains('msg-trace');
        }
        var finalIdx0 = finalNode0 ? kidsAll.indexOf(finalNode0) : -1;
        if (finalIdx0 < 0) finalIdx0 = len;
        /* 第一遍：给 final 之前的锚（agent / 交互卡）按原序编号 */
        var anchorNo = new Array(len);
        var m = 0;
        for (var c1 = 0; c1 < len; c1++) {
            if (isProc[c1] || isTail[c1] || c1 === finalIdx0) continue;
            if (isAgentAt(c1) && c1 < finalIdx0) { anchorNo[c1] = m; m++; }
        }
        /* 第二遍：分配分区键。
           【toggle 键 · 2026-11 修订】toggle 不再钉死 -1，而是【首个过程段键 - 0.5】：
           紧贴它真正折叠的那段过程行之前。锚（qa-record / 待审批 HITL 卡 / 未结束态
           agent-card）排在首个过程段之前时保持在 toggle 上方（时序不颠倒）；
           无锚点普通轮 minProcKey=1 → toggle=0.5，仍是第一个子节点（零回归）。
           toggle 可能出现在任意下标（缝合搬移），故先记录其位置，循环后统一回填。 */
        var keys = new Array(len);
        var seg = 0;
        var toggleIdx = -1;
        var minProcKey = Infinity;
        for (var c2 = 0; c2 < len; c2++) {
            if (isToggleAt(c2)) { toggleIdx = c2; continue; }
            if (isProc[c2]) {
                keys[c2] = 2 * seg + 1;
                if (keys[c2] < minProcKey) minProcKey = keys[c2];
                continue;
            }
            if (anchorNo[c2] !== undefined) { keys[c2] = 2 * anchorNo[c2] + 2; seg = anchorNo[c2] + 1; continue; }
            if (isAgentAt(c2)) { keys[c2] = 2 * m + 4 + c2; continue; }   // final 之后的 agent：tail 区之后按原序
            if (c2 === finalIdx0) { keys[c2] = 2 * m + 2; continue; }
            /* tail 区三档保序：其余白名单 2m+3 → 变更卡 2m+3.5 → 页脚 2m+3.9。
               变更卡恒钉在正文/错误/交互记录之后、时长徽章与操作按钮之前
               （2026-11 用户报障「文件变更卡怎么跑到思考上面了，之前不是在正文最后嘛」）。 */
            if (isTail[c2]) {
                if (isChangesCardAt(c2)) { keys[c2] = 2 * m + 3.5; continue; }
                if (isFooterAt(c2)) { keys[c2] = 2 * m + 3.9; continue; }
                keys[c2] = 2 * m + 3; continue;
            }
            /* 其余未分类节点：跟随当前段（段内 process 之后），避免被越过分区边界 */
            keys[c2] = 2 * seg + 1.5;
        }
        /* decision.process 恒非空（空则 classifyChildren 已返回 null），minProcKey
           必被赋值；Infinity 回落只是防御（假 DOM / 未来重构兜底）。 */
        if (toggleIdx >= 0) keys[toggleIdx] = (minProcKey === Infinity ? 1 : minProcKey) - 0.5;
        var pairs = keys.map(function (kv, ki) { return [kv, ki]; })
            .sort(function (a, b) { return a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : (a[1] < b[1] ? -1 : 1); });
        var refNode = null;
        for (var oi = pairs.length - 1; oi >= 0; oi--) {
            var nodeToPlace = kidsAll[pairs[oi][1]];
            bubble.insertBefore(nodeToPlace, refNode);
            refNode = nodeToPlace;
        }

        /* 【盖子不变量 · 2026-11 修订】toggle 必须【紧贴首个 [data-turn-process] 节点
           之前】，而不是恒为气泡第一个子节点。
           旧不变量（children[0]）会把排在首个过程段之前的时序锚（qa-record / 待审批
           HITL 卡 / 未结束态 agent-card）挤到盖子下方：盖子折叠的是锚之后的过程，
           视觉上却压在锚上方 = 运行态时序颠倒（用户报障 + 探针实测 toggle=0、qa=1）。
           上方重排循环已按分区键把 toggle 放到 minProcKey-0.5 的正确位置，这里只做
           缝合搬移后的防御性归位；锚点保持在 toggle 之前【不再】被当作杂散搬走。 */
        function placeToggle(tg) {
            var kids = Array.prototype.slice.call(bubble.children || []);
            var firstProc = null;
            for (var pi = 0; pi < kids.length; pi++) {
                var kn = kids[pi];
                if (kn !== tg && kn.getAttribute && kn.getAttribute('data-turn-process') !== null) {
                    firstProc = kn; break;
                }
            }
            var iTg = kids.indexOf(tg);
            var iProc = firstProc ? kids.indexOf(firstProc) : kids.length;
            if (iTg >= 0 && iTg === iProc - 1) return;   // 已紧贴首个过程行
            bubble.insertBefore(tg, firstProc);
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

    /* 【放行后重算折叠 · 2026-11 codereview 修复】摘除 / 加回 .hitl-pending 之后，
       卡内穿透例外（hasInteractiveCardInside）随之失效或重新成立，但 classifyChildren
       是【纯函数】：DOM 上的 data-turn-process 标记不会自动跟随重算。
       实测后果（探针：同级过程行 + 卡内待审批卡 + compactBubble(ended:true)）：
       挂起收尾时智能体卡因例外未被打标记 → 用户批准摘掉 hitl-pending → 此后无人重跑
       compactBubble → 该卡【永久常驻】，与同轮其余过程卡形态分叉（实时不折、刷新走
       回放才折），违背用户拍板的「最终态折叠除正文外都折叠」；失败回退 restore 加回
       hitl-pending 时反向同理 —— 若之前已折，例外重新成立却无人重算，卡内审批按钮
       仍被 display:none 藏住 = 任务卡死。故每个 hitl-pending 增删点都要重算一次。
       【保守门禁】只重算【已经折叠过】的气泡（存在 turn-compact-toggle）：从未折叠的
       气泡重跑会凭空插一个折叠按钮，属行为改变，绝不引入。
       入参可以是审批卡本身（向上找宿主气泡）。纯展示增强：任何异常都不得影响主链路。 */
    function refreshInteractiveBoundary(node, options) {
        if (!node) return false;
        var bubble = null, p = node;
        while (p) {
            if (p.classList && p.classList.contains && p.classList.contains('msg-bubble')) { bubble = p; break; }
            p = p.parentNode || null;
        }
        if (!bubble || !bubble.querySelector) return false;
        if (!bubble.querySelector(':scope > .turn-compact-toggle')) return false;
        var opts = options || {};
        if (opts.ended === undefined) opts.ended = true;
        return compactBubble(bubble, opts);
    }

    /* 【变更卡落位兜底 · 2026-11 用户连环报障「卡片还是插在中间 / 折叠都不对 /
       任务都执行结束了还显示正在执行中」】
       真因（真实帧日志 work-cec8d486 每轮 trace → done → file_changes(ready:true)）：
       dispatchGateChunk 对 file_changes 直接 return，卡片由 app-file-changes.js 的
       placeHostInBubble 裸插「页脚之前」；这一路径既不调 closeBatchFor，也不重跑
       compactBubble。于是只要 done 的收口链被任一守卫跳过（stale-run / 恢复缓冲 /
       liveFoldRow 为空 / 挂起边界），DOM 就永远停在：
         running 盖子（ticker 每秒累加「正在执行中 · Ns」）
         → 变更卡（钉在页脚前，压在思考/正文之间）
         → 未折叠的过程行（compact 从未跑或被后到的卡片搬运覆盖）。
       上版只改了「插入漏斗 + compact tail 三档」，恰恰没管这最后一帧，故「还是不对」。

       file_changes 是【轮级收尾快照】：runSettled 判定该轮已收口后才落卡。因此
       「卡片已落 DOM」本身就是权威终态信号，用它兜底收口链，不依赖 done 是否送达：
         ① closeBatchFor：把残留 running 盖子定格为「执行工具 N 次」（幂等，只动 running）；
         ② compactBubble(ended:true)：重跑 tail 三档，把卡片重排到最终正文之后、
            页脚之前，并生成整轮摘要（自身对失败轮/焦点/未 ended 有完备护栏）。
       两道护栏防误伤：① 已折过整轮（有 .turn-compact-toggle）一律不重跑，避免
       切会话/对账/i18n 反复改写用户手动展开态；② 回放的游离 tempDiv（未挂进
       document）只收 running 盖子，不抢在 app-history.js 的 applyTurnCompact
       之前凭空生成折叠。纯展示增强：异常一律吞掉。 */
    /* 【Rust 版真机实证修复 · 2026-11-25】判定「变更卡已落位」后是否仍需重跑整轮折叠。
       Rust 内核 forwarder 在 run 结束后仍继续推后台帧（core/src/server/mod.rs 的
       post_run_tx 保活 / drop(fwd_handle) 后继续 drain），done 的 compact 早已生成
       toggle，迟到的思考/工具/正文再插入时没有 data-turn-process 标记 → 平铺可见；
       卡片又由 placeHostInBubble 钉在页脚前，于是形成截图里的
       「摘要(1 段思考) → 变更卡 → 4 段可见思考 → 正文」坏形态。
       旧护栏「已有 toggle 一律不重跑」把这条自愈路径焊死；compactBubble 重跑时
       created=false 会保留 turn-compact-open 展开态，故重跑安全。
       本函数只做脏检查：正常轮零改动，切会话/对账/i18n 不反复改写已完成轮。 */
    function needsSettleAfterCard(bubble, host) {
        var kids = bubble.children ? Array.prototype.slice.call(bubble.children) : [];
        var i, n, lastTextIdx = -1;
        for (i = 0; i < kids.length; i++) {
            if (isMdContent(kids[i]) && hasVisibleText(kids[i])) lastTextIdx = i;
        }
        for (i = 0; i < kids.length; i++) {
            n = kids[i];
            if (!n || !n.classList || i === lastTextIdx) continue;   // 唯一最终正文
            if (n.getAttribute && n.getAttribute('data-turn-process') !== null) continue;
            if (n.classList.contains('turn-compact-toggle')) continue;
            if (n.classList.contains('fch-host') || n.classList.contains('msg-run-changes-card')) continue;
            if (n.matches && n.matches(FOOTER_SELECTOR)) continue;
            if (n.matches && n.matches(KEEP_VISIBLE_SELECTOR)) continue;
            if (isInteractiveCard(n)) continue;
            if (n.matches && n.matches(AGENT_SELECTOR) && hasInteractiveCardInside(n)) continue;
            /* 空正文壳是流式指针（rAF 尚未落盘），不算迟到内容：给它标 process
               会让随后写入的正文被隐藏。有可见文本的额外 md-content 才算迟到。 */
            if (isMdContent(n) && !hasVisibleText(n)) continue;
            return true;   // 任何未收编的内容 = compact 之后才到的帧
        }
        /* 卡片必须落在最终正文之后；历史脏 DOM（卡片压在正文之前）也要收敛。 */
        if (lastTextIdx >= 0) {
            for (i = 0; i < kids.length; i++) {
                n = kids[i];
                if (n === host || (n.classList && (n.classList.contains('fch-host')
                        || n.classList.contains('msg-run-changes-card')))) {
                    if (i < lastTextIdx) return true;
                }
            }
        }
        return false;
    }

    function settleChangesCard(bubble, options) {
        if (!bubble || !bubble.querySelectorAll) return false;
        var opts = options || {};
        var host = bubble.querySelector('.fch-host, .msg-run-changes-card');
        /* 【同 run 多气泡补洞】挂起恢复时卡片只在一条气泡上，另一条同样可能
           收到 Rust 后台迟到帧。旧实现「无卡直接 return」让逐气泡兜底静默失效，
           故改为：无卡时仍允许脏检查重算（host 可为 null）。 */
        var changed = false;
        try {
            if (closeBatchFor(bubble)) changed = true;
        } catch (e) { /* 展示增强 */ }
        /* 回放/游离容器由 app-history.js 统一收口，这里只收 running 盖子。 */
        if (typeof document !== 'undefined' && opts.allowDetached !== true
                && bubble.isConnected === false) return changed;
        /* 【Rust 版真机实证修复 · 2026-11-25】不再「有 toggle 一律不重跑」：
           Rust forwarder 在 run 结束后仍推后台子代理帧（post_run_tx 保活），
           compact 之后插入的思考/正文没有 data-turn-process 标记 → 平铺可见，
           卡片夹在摘要与过程区之间。compactBubble 重跑时 created=false 会
           【保留】turn-compact-open 展开态（见其尾部 isOpen 分支），旧护栏
           基于错误假设把自愈路径焊死了。脏检查命中才重跑：正常轮零改动。 */
        if (!needsSettleAfterCard(bubble, host)) return changed;
        /* 【失败轮护栏】compactBubble 在 classifyChildren 返回 null（错误证据轮 /
           无正文且非 done 终态）时会【撤销已有折叠】（删 toggle + 清标记），
           与本兜底「只收敛、绝不摊开」的语义冲突。重跑前先判定：失败轮一律
           不重跑；否则一次 file_changes 迟到帧就会把已折好的错误轮摊平。 */
        var kids0 = bubble.children ? Array.prototype.slice.call(bubble.children) : [];
        var fatal = false, textIdx = -1;
        for (var ki = 0; ki < kids0.length; ki++) {
            var kn = kids0[ki];
            if (!kn || !kn.classList) continue;
            if (kn.matches && kn.matches(FATAL_SELECTOR)) { fatal = true; break; }
            if (kn.querySelector && kn.querySelector(FATAL_SELECTOR)) { fatal = true; break; }
            if (isMdContent(kn) && hasVisibleText(kn)) textIdx = ki;
        }
        if (fatal) return changed;
        if (textIdx < 0) {
            var endBadge = bubble.querySelector ? bubble.querySelector('.msg-trace') : null;
            var endStatus = (endBadge && endBadge.getAttribute) ? endBadge.getAttribute('data-turn-status') : null;
            if (endStatus && endStatus !== 'done') return changed;
        }
        var compactOpts = {
            ended: true,
            translate: (typeof window !== 'undefined' && window.GourdI18n
                && window.GourdI18n.t) ? function (k) { return window.GourdI18n.t(k); } : null
        };
        try {
            if (compactBubble(bubble, compactOpts)) changed = true;
        } catch (e) { /* 展示增强 */ }
        return changed;
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
            for (var i = 0; i < hs.length; i++) {
                setLabel(hs[i], windowTranslate());
                /* 运行窗随内容长高：思考/工具正文流式增长不触发 noteProcessInsert
                   （同一节点内追加），只有周期重量才能把新高度算进 overflow。
                   贴底跟随/上滑暂停语义由 refreshWindow 内部维护。 */
                if (hs[i].classList && hs[i].classList.contains('turn-batch-windowed')) {
                    refreshWindow(hs[i], true);
                }
            }
            /* 【code review 修复 2026-11】历史（closed）展开窗也要周期重量：
               用户点开窗内工具卡/思考卡看结果（+320px 卡体）不经过任何批次入口，
               旧实现 metrics/overflow 一次定格 → 展开内容被裁/后续内容重叠且永不自愈。
               follow=false：历史回顾不强制贴底，只更新几何。 */
            var cs = document.querySelectorAll('.turn-batch-header.turn-batch-windowed[data-batch-state="closed"]');
            for (var j = 0; j < cs.length; j++) refreshWindow(cs[j], false);
        }, 1000);
        /* 窗口 resize：宽度变化改换行高度，所有 open 窗强制重量（防抖 200ms）。 */
        if (typeof window !== 'undefined' && window.addEventListener) {
            var rzTimer = null;
            window.addEventListener('resize', function () {
                if (rzTimer) clearTimeout(rzTimer);
                rzTimer = setTimeout(function () {
                    rzTimer = null;
                    var ws = document.querySelectorAll('.turn-batch-header.turn-batch-windowed');
                    for (var k = 0; k < ws.length; k++) refreshWindow(ws[k], false);
                }, 200);
            });
        }
    }

    if (typeof document !== 'undefined') {
        bindI18nRefresh();
        startTicker();
    }

    return {
        /* Part 1 批次折叠（原 GourdTurnBatch 出口面，键名不变） */
        PROCESS_CLASSES: PROCESS_CLASSES,
        isProcessRow: isProcessRow,
        isInteractiveCard: isInteractiveCard,
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
        /* 限高滚动窗（2026-11 用户拍板：约 8 行视窗 + 内部滚动 + 贴底跟随） */
        WINDOW_MAX_PX: WINDOW_MAX_PX,
        refreshWindow: refreshWindow,
        refreshWindowsIn: refreshWindowsIn,
        detachInteractiveMember: detachInteractiveMember,
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
        markTurnStatus: markTurnStatus,
        formatElapsed: formatElapsed,
        compactBubble: compactBubble,
        settleChangesCard: settleChangesCard,
        applyTurnCompact: applyTurnCompact,
        clearTurnCompact: clearTurnCompact,
        refreshInteractiveBoundary: refreshInteractiveBoundary,
        refreshTurnCompact: refreshTurnCompact
    };
});
