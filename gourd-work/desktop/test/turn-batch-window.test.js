/**
 * 契约测试：批次成员限高滚动窗（app-turn-display.js · 2026-11 用户拍板
 * 「正在执行中限高 + 内部滚动 + 自动跟随；历史展开也限高」）。
 *
 * 与 turn-batch.test.js 的零布局假 DOM 不同，本文件给节点补【可测布局】
 * （getBoundingClientRect / ownerDocument.defaultView.getComputedStyle / style），
 * 让 refreshWindow 真跑，钉死以下不变量：
 *  1) 成员总高超过视窗（WINDOW_MAX_PX）才建窗；不足时不建、残留窗必须拆干净
 *  2) DOM 零插入：建窗前后容器 children 完全一致（邻接校验/兄弟区间不破）
 *  3) 批次总占位恒定：末成员 marginBottom = 基值 - overflow（带 !important，压过
 *     app.css 运行态/展开态的 margin !important），成员 translateY(-pos) +
 *     clip-path 裁剪 —— 总高恒等于视窗高、与 pos 无关
 *  4) running 首窗贴底（看最新）；closed 首窗从头（回顾过程）
 *  5) 贴底时新成员到达自动跟随；用户上滑离开底部后不跟；滑回底部恢复跟随
 *  6) 收起/一键回退（clearBatch）必须拆窗：transform/clip/margin 全还原
 *  7) wheel 在窗内滚动、到边界放行（不 preventDefault）
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const batch = require(path.join(__dirname, '..', 'ui', 'js', 'app-turn-display.js'));

/* ---- 可测布局的假 DOM：在 turn-batch.test.js 极简桩上补几何 ---- */
const VIEW = { getComputedStyle: () => ({ marginTop: '2px', marginBottom: '2px' }) };
const DOC = { defaultView: VIEW };

function el(tag, classes, height) {
    classes = classes || [];
    const node = {
        nodeType: 1, tagName: (tag || 'div').toUpperCase(),
        _classes: new Set(classes), _attrs: {}, children: [], parentNode: null,
        textContent: '', _h: height || 0,
        style: {
            /* 真 DOM 的 CSSStyleDeclaration 子集：!important 写入走 setProperty，
               removeProperty 清空。裸属性赋值（transform/clipPath）保持可直读。 */
            setProperty(p, v, prio) {
                const camel = p.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                node.style[camel] = v;
                (node._prios = node._prios || {})[p] = prio || '';
            },
            removeProperty(p) {
                const camel = p.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                node.style[camel] = '';
                if (node._prios) delete node._prios[p];
            }
        },
        ownerDocument: DOC,
        /* 几何：parentNode 链上有 _layoutVer 时按【兄弟 margin 折叠】语义现算
           布局位（每次读 rect 都重算，写样式后无需手动 relayout）；rect.top =
           布局位 + translateY 视觉位移（与真 DOM 一致）。无 _layoutVer 的旧桩
           top 恒 0 → 实现回落加法模型（兼容既有零布局用例）。 */
        getBoundingClientRect() {
            let ty = 0;
            const m = /translateY\((-?[\d.]+)px\)/.exec(node.style.transform || '');
            if (m) ty = parseFloat(m[1]);
            let top = ty;
            let p = node.parentNode;
            while (p) { if (p._layoutVer) { top += layoutTopOf(p, node); break; } p = p.parentNode; }
            return { height: node._h, top, bottom: top + node._h };
        },
        contains(n) {
            if (n === node) return true;
            for (const c of node.children) if (c.contains && c.contains(n)) return true;
            return false;
        },
        classList: {
            contains: (c) => node._classes.has(c),
            add: (c) => node._classes.add(c),
            remove: (c) => node._classes.delete(c),
            toggle: (c) => {
                if (node._classes.has(c)) { node._classes.delete(c); return false; }
                node._classes.add(c); return true;
            }
        },
        get className() { return Array.from(node._classes).join(' '); },
        set className(v) { node._classes = new Set(String(v || '').split(/\s+/).filter(Boolean)); },
        set innerHTML(v) {
            node.children = [];
            const re = /<span class="([\w-]+)"[^>]*>([\s\S]*?)<\/span>/g;
            let m;
            while ((m = re.exec(String(v)))) {
                const c = el('span', m[1].split(/\s+/));
                c.textContent = m[2].replace(/<[^>]*>/g, '');
                c.parentNode = node;
                node.children.push(c);
            }
        },
        setAttribute(k, v) { node._attrs[k] = String(v); },
        getAttribute(k) { return node._attrs[k] === undefined ? null : node._attrs[k]; },
        removeAttribute(k) { delete node._attrs[k]; },
        matches(sel) {
            return sel.split(',').map(s => s.trim()).some(s => {
                if (s.startsWith('.')) return node._classes.has(s.slice(1).split(/\s|>|\./)[0]);
                return false;
            });
        },
        querySelector(sel) { return queryAll(node, sel)[0] || null; },
        querySelectorAll(sel) { return queryAll(node, sel); },
        appendChild(c) { c.parentNode = node; node.children.push(c); return c; },
        insertBefore(c, ref) {
            const old = node.children.indexOf(c);
            if (old >= 0) node.children.splice(old, 1);
            c.parentNode = node;
            const i = ref ? node.children.indexOf(ref) : -1;
            if (i < 0) node.children.push(c); else node.children.splice(i, 0, c);
            return c;
        },
        removeChild(c) { const i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); c.parentNode = null; return c; },
        addEventListener(ev, fn) { (node._listeners = node._listeners || {})[ev] = fn; },
        click() { if (node._listeners && node._listeners.click) node._listeners.click({ stopPropagation() {} }); },
        wheel(target, deltaY, deltaMode) {
            const fn = node._listeners && node._listeners.wheel;
            if (!fn) return null;
            const ev = { target, deltaY, deltaMode: deltaMode || 0, prevented: false, preventDefault() { this.prevented = true; } };
            fn(ev);
            return ev;
        }
    };
    function queryAll(root, sel) {
        const out = [];
        const parts = sel.split(',').map(s => s.trim());
        parts.forEach(p => {
            const classes = (p.match(/\.([\w-]+)/g) || []).map(s => s.slice(1));
            const attrM = p.match(/\[([\w-]+)(?:="([^"]*)")?\]/);
            function walk(n) {
                for (const c of n.children) {
                    let hit = classes.length > 0 && classes.every(cl => c._classes.has(cl));
                    if (attrM) {
                        const v = c._attrs[attrM[1]];
                        hit = attrM[2] !== undefined ? v === attrM[2] : v !== undefined;
                    }
                    if (hit) out.push(c);
                    walk(c);
                }
            }
            walk(root);
        });
        return out;
    }
    return node;
}
global.document = { createElement: (t) => el(t, []) };

const WIN = batch.WINDOW_MAX_PX;
const ROW = 29;   // 每行几何：h=25 + mt2 + mb2 = 29px 占位

function mkBubble() { return el('div', ['msg-bubble'], 0); }
function mkSess(bubble) {
    const md = el('div', ['md-content'], 0);
    bubble.appendChild(md);
    return { currentBubbleEl: md, _replaying: false };
}
function addRow(b, sess, h) {
    const card = el('div', ['tool-card'], h === undefined ? 25 : h);
    b.insertBefore(card, sess.currentBubbleEl);
    return { card, header: batch.noteProcessInsert(sess, card) };
}
function num(v) { return parseFloat(v) || 0; }

/* 按【真实 CSS 兄弟 margin 折叠】语义现算 container 内 target 的布局顶：
   相邻间距 = max(正部) + Σ(负部)（正 margin 折叠取大者；末成员负 mb 与
   后续正 mt 的折叠恰好加法语义）。inline 补偿带 !important 视为生效值；
   未写 inline 用基值 2px（盖子 margin 记 0，与主气泡运行态 margin:0 同形）。 */
function layoutTopOf(container, target) {
    const mval = (n, prop) => {
        const v = n.style[prop];
        return (v === '' || v === undefined) ? 2 : num(v);
    };
    const collapse = (a, c) => Math.max(a, 0) + Math.max(c, 0)
        - Math.min(Math.max(a, 0), Math.max(c, 0)) + Math.min(a, 0) + Math.min(c, 0);
    let y = 0, prevMb = null;
    for (const c of container.children) {
        if (c._classes.has('turn-batch-collapsed')) continue;
        /* 桩几何只模拟过程行：盖子/正文壳记 0 高 0 margin（真实盖子高未桩化，
           而实现的 rect 差分原点取首成员，与盖子几何无关，两边口径一致） */
        const isRow = c._classes.has('tool-card') || c._classes.has('thinking-block');
        /* 非过程行（盖子/正文壳）在真实 CSS 里是零高零 margin 的折叠穿透体：
           完全跳过，让过程行兄弟直接相邻折叠（mb_prev 与 mt_next 取 max）。
           旧桩把盖子当 0 margin 实体断链，末行负 mb 被「吞」掉不传播，
           与真实浏览器（负 margin 穿过空壳作用于下一实体兄弟）不符。 */
        if (!isRow) continue;
        const mt = mval(c, 'marginTop');
        y += prevMb === null ? mt : collapse(prevMb, mt);
        if (c === target) return y;
        y += c._h;
        prevMb = mval(c, 'marginBottom');
    }
    return 0;
}
/* 成员区真实布局总高（首成员布局顶 → 末成员底 + 末 mb），折叠语义。
   口径与实现 windowGeometry.total 一致：末行 mb 下缘（含负值）——
   负 mb 把后续内容上提，正是「吃掉溢出」的补偿语义，必须计入。 */
function layoutSpanOf(rows) {
    if (!rows.length) return 0;
    const b = rows[0].parentNode;
    const firstTop = layoutTopOf(b, rows[0]);
    const last = rows[rows.length - 1];
    const mbv = last.style.marginBottom;
    const mb = (mbv === '' || mbv === undefined) ? 2 : num(mbv);
    return layoutTopOf(b, last) + last._h + mb - firstTop;
}

test('★ 超过视窗才建窗：8 行以内平铺、第 9 行起 windowed', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    let h = null;
    const rows = [];
    for (let i = 0; i < 8; i++) { const r = addRow(b, sess); rows.push(r.card); h = r.header; }
    assert.ok(!h._classes.has('turn-batch-windowed'), '8×29=232 恰等于视窗，不建窗');
    const ninth = addRow(b, sess);
    assert.equal(ninth.header, h, '仍同一批次');
    assert.ok(h._classes.has('turn-batch-windowed'), '9 行超限必须建窗');
    assert.equal(h._winOverflow, 9 * ROW - WIN);
});

test('★ DOM 零插入：建窗前后容器 children 完全一致（邻接/兄弟区间不破）', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    let h = null;
    for (let i = 0; i < 12; i++) h = addRow(b, sess).header;
    assert.ok(h._classes.has('turn-batch-windowed'));
    // 盖子 + 12 成员 + 正文指针壳 = 14，无任何垫片/包装
    assert.equal(b.children.length, 14, '不得插入垫片或包装节点');
    assert.equal(batch.membersOf(h).length, 12, '成员区间完整');
    // 建窗后新成员仍归同一批（邻接校验没被破坏）
    const next = addRow(b, sess);
    assert.equal(next.header, h, '建窗后新成员不得被迫切成新批次');
});

test('★ 批次总占位恒定 = 视窗高：末 margin -= overflow、translateY(-pos)，与 pos 无关', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    let h = null;
    const rows = [];
    for (let i = 0; i < 12; i++) { const r = addRow(b, sess); rows.push(r.card); h = r.header; }
    const overflow = h._winOverflow;
    const pos = h._winPos;
    const first = rows[0], last = rows[rows.length - 1];
    assert.equal(num(last.style.marginBottom), 2 - overflow, '末成员 marginBottom = 基值 - overflow');
    assert.equal(first.style.transform, 'translateY(' + (-pos) + 'px)');
    // 注意 num('0px')=0 是 falsy：空串判断必须显式，不能用 || 回落
    const mval = (v) => (v === '' || v === undefined) ? 2 : num(v);
    const totalOf = () => rows.reduce((s, r) =>
        s + 25 + mval(r.style.marginTop) + mval(r.style.marginBottom), 0);
    assert.equal(totalOf(), WIN, '窗口态批次总占位必须恒等于视窗高');
    // 滚到中间：占位不随 pos 漂移
    b.wheel(h._winVisible[5], -60);
    assert.notEqual(h._winPos, pos);
    assert.equal(totalOf(), WIN, '滚动中占位仍恒定（后续内容不漂移）');
});

test('★ running 首窗贴底看最新；closed 首窗从头回顾', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    let h = null;
    for (let i = 0; i < 12; i++) h = addRow(b, sess).header;
    assert.equal(h._winPos, h._winOverflow, 'running 首窗必须贴底');
    // 收口 → 点开：closed 首窗 pos=0
    batch.closeBatch(sess);
    h.click();   // 展开
    assert.equal(h.getAttribute('data-batch-state'), 'closed');
    assert.equal(h._winPos, 0, 'closed 批次点开后从头看');
});

test('★ 贴底自动跟随；上滑离开底部后暂停；滑回底部恢复', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    let h = null;
    for (let i = 0; i < 12; i++) h = addRow(b, sess).header;
    assert.equal(h._winPos, h._winOverflow);
    // 贴底态新成员到达 → 跟到最新
    addRow(b, sess);
    assert.equal(h._winPos, h._winOverflow, '贴底态必须跟随新成员');
    // 用户上滑（wheel 负向，量小于 overflow 保证不越界）
    const before = h._winPos;
    const delta = Math.min(60, before);
    const ev = b.wheel(h._winVisible[5], -delta);
    assert.ok(ev && ev.prevented, '窗内滚动必须吃掉 wheel');
    assert.equal(h._winPos, before - delta);
    // 离开底部后新成员到达 → 不跟
    const stay = h._winPos;
    addRow(b, sess);
    assert.equal(h._winPos, stay, '用户上滑查看时不得强行拉回底部');
    // 滑回底部 → 恢复跟随
    b.wheel(h._winVisible[5], 100000);
    assert.equal(h._winPos, h._winOverflow);
    addRow(b, sess);
    assert.equal(h._winPos, h._winOverflow, '回到底部后恢复自动跟随');
});

test('★ wheel 到边界放行：顶部继续上滑 / 底部继续下滑都不 preventDefault', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    let h = null;
    for (let i = 0; i < 12; i++) h = addRow(b, sess).header;
    // 先到顶
    b.wheel(h._winVisible[5], -100000);
    assert.equal(h._winPos, 0);
    const evTop = b.wheel(h._winVisible[5], -50);
    assert.ok(evTop && !evTop.prevented, '顶部边界必须放行给页面滚动');
    // 再到底
    b.wheel(h._winVisible[5], 100000);
    const evBottom = b.wheel(h._winVisible[5], 50);
    assert.ok(evBottom && !evBottom.prevented, '底部边界必须放行给页面滚动');
});

test('★ 收起拆窗：transform/clip/margin 全还原，再展开重建', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    let h = null;
    const rows = [];
    for (let i = 0; i < 12; i++) { const r = addRow(b, sess); rows.push(r.card); h = r.header; }
    h.click();   // 收起
    assert.ok(!h._classes.has('turn-batch-windowed'), '收起必须拆窗');
    for (const r of rows) {
        assert.equal(r.style.transform, '', 'transform 必须还原');
        assert.equal(r.style.clipPath, '', 'clip 必须还原');
        assert.equal(r.style.marginTop, '', 'margin 补偿必须还原');
        assert.equal(r.style.marginBottom, '', 'margin 补偿必须还原');
    }
    h.click();   // 再展开
    assert.ok(h._classes.has('turn-batch-windowed'), '再展开重建窗');
});

test('★ clearBatch 一键回退：拆窗 + 摘盖子，成员回到裸平铺', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const rows = [];
    for (let i = 0; i < 12; i++) rows.push(addRow(b, sess).card);
    batch.clearBatch(b);
    assert.equal(b.querySelectorAll('.turn-batch-header').length, 0);
    for (const r of rows) {
        assert.equal(r.style.transform, '');
        assert.equal(r.style.clipPath, '');
        assert.equal(r.style.marginTop, '');
        assert.equal(r.style.marginBottom, '');
        assert.equal(r.getAttribute('data-turn-batch'), null);
    }
});

test('★ 内容长高后 refreshWindow 重量：overflow 变大且贴底跟随', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    let h = null;
    const rows = [];
    for (let i = 0; i < 12; i++) { const r = addRow(b, sess); rows.push(r.card); h = r.header; }
    const before = h._winOverflow;
    rows[rows.length - 1]._h += 100;   // 末行结果体长高（流式追加）
    batch.refreshWindow(h, true);
    assert.equal(h._winOverflow, before + 100, '长高必须计入 overflow');
    assert.equal(h._winPos, h._winOverflow, '贴底态跟随长高');
});

test('★ 历史批次（rebuildBatches）点开后同样限高', () => {
    const b = el('div', ['msg-bubble'], 0);
    for (let i = 0; i < 12; i++) b.appendChild(el('div', ['tool-card'], 25));
    batch.rebuildBatches(b);
    const h = b.querySelector('.turn-batch-header');
    assert.ok(h, '历史批次应建盖子');
    h.click();   // 点开
    assert.ok(h._classes.has('turn-batch-windowed'), '历史展开同样限高（用户拍板：全部限高）');
    assert.equal(h._winPos, 0, '历史从头看');
});

/* ═══ code review 修复回归（2026-11）：真实折叠几何 / !important / HITL 接管 / deltaMode ═══ */

function mkLayoutBubble() {
    const b = mkBubble();
    b._layoutVer = 1;   // 开启「兄弟 margin 折叠」真实几何桩
    return b;
}

test('★ 折叠几何：margin 按 max 折叠（非加法）时 overflow/占位仍精确', () => {
    const b = mkLayoutBubble();
    const sess = mkSess(b);
    let h = null;
    const rows = [];
    for (let i = 0; i < 12; i++) { const r = addRow(b, sess); rows.push(r.card); h = r.header; }
    assert.ok(h._classes.has('turn-batch-windowed'));
    // 真实折叠布局：12×25 + 11×max(2,2)=22 + 首mt2 + 末mb2 = 326（加法模型会算 348）
    const natural = 12 * 25 + 11 * 2 + 2 + 2;
    assert.equal(h._winOverflow, natural - WIN, 'overflow 必须按折叠后真实高度算（不得多算 margin）');
    // 补偿后成员区真实布局总高恒 = WIN（用折叠语义独立复算，不与实现共享公式）
    assert.equal(layoutSpanOf(rows), WIN, '折叠几何下批次占位仍恒等于视窗高');
    // 滚动中占位不漂移
    b.wheel(h._winVisible[5], -60);
    assert.equal(layoutSpanOf(rows), WIN, '滚动中折叠占位仍恒定');
    // clip 行位置抽查：第 6 行 rect 差分位置 = 2 + 5×27 = 137，clipTop = pos - 137
    const pos = h._winPos;
    const row5Top = 2 + 5 * 27;
    const expectClip = Math.max(0, pos - row5Top);
    const cp = rows[5].style.clipPath || '';
    if (expectClip > 0) assert.ok(cp.indexOf('inset(' + expectClip) === 0, 'clip 必须按折叠实测行位裁（加法模型此处会偏 10px）');
});

test('★ margin 补偿必须带 !important：压过样式表运行态/展开态 margin !important', () => {
    const b = mkLayoutBubble();
    const sess = mkSess(b);
    let h = null;
    const rows = [];
    for (let i = 0; i < 12; i++) { const r = addRow(b, sess); rows.push(r.card); h = r.header; }
    const last = rows[rows.length - 1];
    assert.equal(last._prios && last._prios['margin-bottom'], 'important',
        '末成员 margin-bottom 补偿必须 setProperty(..., important)，否则被 app.css margin:0 !important 压死');
    // 拆窗后 !important 一并清除（removeProperty）
    h.click();
    assert.equal(last.style.marginBottom, '', '拆窗必须清补偿');
    assert.ok(!last._prios || !last._prios['margin-bottom'], '拆窗必须清 !important 优先级');
});

test('★ HITL 接管入批骨架卡：摘成员标记，收口不得隐藏审批卡', () => {
    const b = mkLayoutBubble();
    const sess = mkSess(b);
    let h = null;
    const rows = [];
    for (let i = 0; i < 12; i++) { const r = addRow(b, sess); rows.push(r.card); h = r.header; }
    // 第 6 张骨架卡被 hitl 帧原地接管（同节点加 hitl-pending）
    const taken = rows[5];
    taken._classes.add('hitl-pending');
    batch.noteProcessInsert(sess, taken);   // 走 isInteractiveCard 边界分支
    assert.equal(taken.getAttribute('data-turn-batch'), null, '接管后必须摘成员标记');
    assert.ok(!taken._classes.has('turn-batch-collapsed'), '接管即收口，审批卡不得被折叠');
    assert.equal(taken.style.transform, '', '接管卡的窗绘制必须清除');
    assert.equal(batch.membersOf(h).indexOf(taken), -1, '审批卡不再是批次成员');
    // 再次收口/折叠也不得吞掉它（applyMembers 防御豁免）
    h.click();   // 收起剩余成员
    assert.ok(!taken._classes.has('turn-batch-collapsed'), '收起批次不得隐藏待审批卡');
    h.click();   // 再展开
    assert.ok(batch.membersOf(h).indexOf(taken) < 0);
});

test('★ wheel deltaMode 归一化：行模式×29、页模式×窗高', () => {
    const b = mkLayoutBubble();
    const sess = mkSess(b);
    let h = null;
    for (let i = 0; i < 12; i++) h = addRow(b, sess).header;
    b.wheel(h._winVisible[5], -100000);   // 到顶
    assert.equal(h._winPos, 0);
    b.wheel(h._winVisible[5], 3, 1);      // Firefox 行模式 3 行
    assert.equal(h._winPos, 3 * 29, '行模式必须换算成像素（旧实现只滚 3px）');
    const before = h._winPos;
    b.wheel(h._winVisible[5], 1, 2);      // 页模式 1 页
    assert.equal(h._winPos, Math.min(h._winOverflow, before + WIN), '页模式按视窗高换算');
});

test('★ closed 窗内成员长高（点开卡体）：refreshWindow(false) 重测几何且不强制贴底', () => {
    const b = mkLayoutBubble();
    const sess = mkSess(b);
    let h = null;
    const rows = [];
    for (let i = 0; i < 12; i++) { const r = addRow(b, sess); rows.push(r.card); h = r.header; }
    batch.closeBatch(sess);
    h.click();   // 历史展开，pos=0
    assert.equal(h._winPos, 0);
    const before = h._winOverflow;
    rows[2]._h += 320;   // 用户点开第 3 张卡的结果体
    batch.refreshWindow(h, false);
    assert.equal(h._winOverflow, before + 320, 'closed 窗必须能量到成员长高');
    assert.equal(h._winPos, 0, '历史回顾不强制贴底');
    assert.equal(layoutSpanOf(rows), WIN, '长高后占位仍恒定');
});

/* ★ 滚动容器坐标回归（2026-11-24 用户报障「页面错乱」真因）：
   offsetParent 恰是滚动容器（.messages-wrap）时，offsetTop 是内容坐标、
   rect.top 是视口坐标，换算必须减 op.scrollTop。旧实现漏减 → 滚过 N px 后
   量出的成员 top 全体虚高 N：滚动条轨道被画到盖子下方数千 px（截图「右侧
   空白沟」）、overflow/补偿被污染 → 正文叠压。本用例给桩补 offsetTop /
   offsetParent / scrollTop 三件套，钉死「滚动到任何位置量测结果不变」。 */
test('★ offsetParent 是滚动容器：量测必须扣除 scrollTop（滚动位置无关性）', () => {
    const b = mkLayoutBubble();
    const sess = mkSess(b);
    let h = null;
    const rows = [];
    for (let i = 0; i < 12; i++) { const r = addRow(b, sess); rows.push(r.card); h = r.header; }
    const overflowAt0 = h._winOverflow;
    const spanAt0 = layoutSpanOf(rows);

    /* 把气泡挂进一个「滚动容器」桩：offsetParent = 容器，offsetTop = 内容坐标
       （layoutTopOf + 固定内容偏移），容器 rect.top 固定（视口位），scrollTop 可变。
       成员 rect.top 必须 = offsetTop - scrollTop + 容器视口顶（真实浏览器语义）。 */
    const SCROLL_VIEW_TOP = 100;   // 容器在视口里的顶
    const CONTENT_BASE = 500;      // 成员区在内容里的基准偏移
    const scroller = el('div', ['messages-wrap'], 0);
    scroller.scrollTop = 0;
    scroller.getBoundingClientRect = () => ({ top: SCROLL_VIEW_TOP, height: 700, bottom: SCROLL_VIEW_TOP + 700 });
    b.parentNode = scroller;
    for (const r of rows) {
        r.offsetParent = scroller;
        Object.defineProperty(r, 'offsetTop', {
            get: () => CONTENT_BASE + layoutTopOf(b, r)
        });
        /* 覆盖 rect：内容坐标 - scrollTop + 容器视口顶（+ 自身 translateY） */
        r.getBoundingClientRect = () => {
            let ty = 0;
            const m = /translateY\((-?[\d.]+)px\)/.exec(r.style.transform || '');
            if (m) ty = parseFloat(m[1]);
            const top = CONTENT_BASE + layoutTopOf(b, r) - scroller.scrollTop + SCROLL_VIEW_TOP + ty;
            return { height: r._h, top, bottom: top + r._h };
        };
    }
    /* 盖子的 rect 也用视口坐标（成员区顶上方 34px，与真实盖子高+间隙一致） */
    h.getBoundingClientRect = () => {
        const firstTop = CONTENT_BASE + layoutTopOf(b, rows[0]) - scroller.scrollTop + SCROLL_VIEW_TOP;
        return { height: 32, top: firstTop - 34, bottom: firstTop - 2 };
    };

    /* 滚到 670px（真机报障时的 scrollTop）再量：overflow / 占位 / 滚动条轨道
       必须与 scrollTop=0 完全一致 —— 坐标换算漏减 scrollTop 时这里全崩。 */
    scroller.scrollTop = 670;
    batch.refreshWindow(h, false);
    assert.equal(h._winOverflow, overflowAt0,
        '滚动后 overflow 不得漂移（漏减 scrollTop 会虚高 670）');
    assert.equal(layoutSpanOf(rows), spanAt0, '滚动后批次占位必须不变');
    const sbTop = parseFloat(h.style.getPropertyValue ? h.style.getPropertyValue('--win-sb-top') : h.style['--win-sb-top']) || 0;
    assert.ok(sbTop >= 0 && sbTop < 100,
        '滚动条轨道必须紧贴盖子（实测漏减时 sbTop=8358px，画到几千 px 外）');
    /* 再滚一段，结论不变（任意滚动位置稳定） */
    scroller.scrollTop = 2400;
    batch.refreshWindow(h, false);
    assert.equal(h._winOverflow, overflowAt0, '任意滚动位置量测结果必须一致');
});
