/**
 * 契约测试：运行态批次折叠（app-turn-batch.js）+ 与 app-turn-compact.js 的协作。
 *
 * 纯函数与 DOM 副作用都在极简假 DOM 里真跑（不引入 jsdom，零依赖），
 * 假 DOM 复用 turn-compact.test.js 的口径（classList/attrs/children/insertBefore）。
 * 重点护栏：
 *  - 正文/错误/交互卡绝不能成为批次成员（否则答案被折叠藏住）
 *  - 收口后新过程行开新批次，旧批次保持折叠
 *  - 零成员盖子必须移除（孤儿盖子比不显示更误导）
 *  - 偏好 gourd.turnCompact==='0' 时不建盖子
 *  - turn-compact 放弃折叠（无正文/失败轮）时批次成员必须被 revealAll 展开
 *  - turn-compact 分类把盖子当过程行、摘要不对盖子计数
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const batch = require(path.join(__dirname, '..', 'ui', 'js', 'app-turn-display.js'));
const compact = batch;   // 合并后同一出口（GourdTurnBatch / GourdTurnCompact 皆为兼容别名）

/* ---- 极简假 DOM ---- */
function el(tag, classes) {
    classes = classes || [];
    const node = {
        nodeType: 1, tagName: (tag || 'div').toUpperCase(),
        _classes: new Set(classes), _attrs: {}, children: [], parentNode: null,
        textContent: '',
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
        /* 【code review 自审补】createHeader 用 innerHTML 写入 chevron/label 两个 span；
           桩缺此属性时盖子没有 .turn-batch-label，setLabel 全部 no-op。最小实现：
           只解析 <span class="X">…</span> 形态（本模块盖子仅此形态），内嵌 svg 标签丢弃。 */
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
            // 与真实 DOM 同语义：对已在文档中的节点 insertBefore = 移动（先摘原位置）。
            // 缺这一步会让「盖子归位 / 缝合搬移」类用例插出重复节点
            //（与 turn-compact.test.js:50-59 同口径，2026-11 自审补）。
            const old = node.children.indexOf(c);
            if (old >= 0) node.children.splice(old, 1);
            c.parentNode = node;
            const i = ref ? node.children.indexOf(ref) : -1;
            if (i < 0) node.children.push(c); else node.children.splice(i, 0, c);
            return c;
        },
        removeChild(c) { const i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); c.parentNode = null; return c; },
        addEventListener(ev, fn) { (node._listeners = node._listeners || {})[ev] = fn; },
        click() { if (node._listeners && node._listeners.click) node._listeners.click({ stopPropagation() {} }); }
    };
    function queryAll(root, sel) {
        const out = [];
        const parts = sel.split(',').map(s => s.trim());
        const want = new Set();
        const wantAttr = new Set();
        parts.forEach(p => {
            const m = p.match(/\.([\w-]+)/);
            if (m) want.add(m[1]);
            const a = p.match(/\[([\w-]+)(?:=|\])/);
            if (a) wantAttr.add(a[1]);
        });
        function walk(n, direct) {
            for (const c of n.children) {
                let hit = false;
                for (const w of want) if (c._classes.has(w)) hit = true;
                for (const w of wantAttr) if (c._attrs[w] !== undefined) hit = true;
                if (hit) out.push(c);
                if (!direct) walk(c, false);
            }
        }
        const direct = sel.indexOf(':scope >') >= 0;
        walk(root, direct);
        return out;
    }
    return node;
}
global.document = { createElement: (t) => el(t, []) };

function mkBubble() { return el('div', ['msg-bubble']); }
function mkSess(bubble) {
    const md = el('div', ['md-content']);
    bubble.appendChild(md);
    return { currentBubbleEl: md, _replaying: false };
}

test('noteProcessInsert：首个过程行建盖子且盖子紧贴其上方', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const card = el('div', ['tool-card']);
    b.insertBefore(card, sess.currentBubbleEl);
    const h = batch.noteProcessInsert(sess, card);
    assert.ok(h, '应创建批次盖子');
    assert.equal(b.children[0], h, '盖子必须在成员上方');
    assert.equal(b.children[1], card);
    assert.equal(card.getAttribute('data-turn-batch'), '1');
    assert.equal(h.getAttribute('data-batch-state'), 'running');
    assert.match(batch.labelText(h, null), /正在执行中/);
});

test('同批次第二个过程行复用运行盖子，不新建', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    // 模拟生产插入顺序：过程行落在正文指针 md 之前（= 盖子之后）
    const c1 = el('div', ['tool-card']); b.insertBefore(c1, sess.currentBubbleEl);
    const h1 = batch.noteProcessInsert(sess, c1);
    const t1 = el('div', ['thinking-block']); b.insertBefore(t1, sess.currentBubbleEl);
    const h2 = batch.noteProcessInsert(sess, t1);
    assert.equal(h1, h2, '运行批次应复用');
    assert.equal(b.querySelectorAll('.turn-batch-header').length, 1);
    assert.equal(batch.membersOf(h1).length, 2);
});

test('非过程行切断批次：旧批次收口、后续过程行开新盖子（Qoder 多折叠组）', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const c1 = el('div', ['tool-card']); b.insertBefore(c1, sess.currentBubbleEl);
    const h1 = batch.noteProcessInsert(sess, c1);
    // 错误块不是成员，插在成员与后续过程行之间 = 批次被切断
    const err = el('div', ['chunk-error']); b.insertBefore(err, sess.currentBubbleEl);
    assert.equal(batch.noteProcessInsert(sess, err), null);
    const c2 = el('div', ['tool-card']); b.insertBefore(c2, sess.currentBubbleEl);
    const h2 = batch.noteProcessInsert(sess, c2);
    assert.notEqual(h1, h2, '被非成员行切断后必须开新批次');
    assert.equal(b.querySelectorAll('.turn-batch-header').length, 2);
    assert.equal(h1.getAttribute('data-batch-state'), 'closed', '旧批次随切断收口（Qoder 多折叠组）');
    assert.ok(c1._classes.has('turn-batch-collapsed'), '旧批次成员折叠进组');
    assert.deepEqual(batch.membersOf(h1), [c1], '旧批次成员不含被切断后的行');
    assert.deepEqual(batch.membersOf(h2), [c2]);
    assert.equal(b.children.indexOf(h2), b.children.indexOf(c2) - 1, '新盖子紧贴新成员');
    assert.ok(!c2._classes.has('turn-batch-collapsed'));
});

test('★ 正文是批次边界：正文落 DOM 收口运行批次，其后过程行开新组（Qoder 多折叠组）', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const c1 = el('div', ['tool-card']); b.insertBefore(c1, sess.currentBubbleEl);
    const h1 = batch.noteProcessInsert(sess, c1);
    // 模拟 noteBatchInsert：正文壳落 DOM → closeBatchFor 收口
    const md = el('div', ['md-content']); md.textContent = '过程正文';
    b.insertBefore(md, sess.currentBubbleEl);
    assert.equal(batch.closeBatchFor(b), true);
    assert.equal(h1.getAttribute('data-batch-state'), 'closed');
    assert.ok(c1._classes.has('turn-batch-collapsed'), '第一组成员折叠');
    // 正文之后的工具行开第二组
    const c2 = el('div', ['tool-card']); b.insertBefore(c2, sess.currentBubbleEl);
    const h2 = batch.noteProcessInsert(sess, c2);
    assert.notEqual(h1, h2, '正文之后必须开新折叠组');
    assert.equal(h2.getAttribute('data-batch-state'), 'running');
    assert.ok(!c2._classes.has('turn-batch-collapsed'), '新组成员运行态展开');
    assert.deepEqual(batch.membersOf(h1), [c1]);
    assert.deepEqual(batch.membersOf(h2), [c2]);
    // 正文本身不是任何组的成员，常驻可见
    assert.equal(md.getAttribute('data-turn-batch'), null);
    assert.ok(!md._classes.has('turn-batch-collapsed'));
});

/* 【code review 回归 · 缺陷1/2】生产时序：每个 action_end 都 advanceBodyPointer 插一个
   【空】.md-content 指针壳，它必然夹在上一张工具卡与下一张之间。旧实现把空壳当批次
   边界（noteBatchInsert 见 md 就 closeBatchFor + 邻接校验遇 md 就切组），纯工具轮被
   切成 N 个「执行工具 1 次」碎组（实证：4 工具 → 5 组），正是用户报的碎组形态。
   修复后：空壳既不触发收口、邻接校验也跳过它 ⇒ 连续工具归同一组；
   真正文（写进既有壳、由 appendBodyContentCore closeBatch）仍是边界，契约不变。 */
test('★ 指针空壳不切碎批次：纯工具轮 4 张卡归同一组（生产时序）', () => {
    const b = mkBubble();
    const footer = el('div', ['msg-meta-row']); b.appendChild(footer);
    let md = el('div', ['md-content']); b.insertBefore(md, footer);
    const sess = { currentBubbleEl: md, _replaying: false };
    const headers = [];
    for (let i = 0; i < 4; i++) {
        const card = el('div', ['tool-card']);
        b.insertBefore(card, footer);
        headers.push(batch.noteProcessInsert(sess, card));
        // advanceBodyPointer：删空壳指针、在 footer 前插新空壳（模拟 insertBeforeActions）
        const prev = sess.currentBubbleEl;
        if (prev && !(prev.textContent || '').trim() && prev.parentNode) prev.parentNode.removeChild(prev);
        const fresh = el('div', ['md-content']);   // 空壳，无文本
        b.insertBefore(fresh, footer);
        sess.currentBubbleEl = fresh;
    }
    const uniq = [...new Set(headers.filter(Boolean))];
    assert.equal(uniq.length, 1, '4 张工具卡必须归同一组，空壳不得切组');
    assert.equal(b.querySelectorAll('.turn-batch-header').length, 1, '只允许一个盖子');
    assert.equal(batch.membersOf(uniq[0]).length, 4, '组成员 = 4 张卡');
    assert.equal(uniq[0].getAttribute('data-batch-state'), 'running', '纯工具轮运行中不收口');
});

test('★ 空壳夹在卡间后真正文到达：仍按正文边界收口开新组', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const c1 = el('div', ['tool-card']); b.insertBefore(c1, sess.currentBubbleEl);
    const h1 = batch.noteProcessInsert(sess, c1);
    // 指针空壳夹入（不收口、不切组）
    const shell = el('div', ['md-content']); b.insertBefore(shell, sess.currentBubbleEl);
    const c2 = el('div', ['tool-card']); b.insertBefore(c2, sess.currentBubbleEl);
    const h2 = batch.noteProcessInsert(sess, c2);
    assert.equal(h1, h2, '空壳不切组：两卡同组');
    // 真正文写进壳 → appendBodyContentCore 调 closeBatch
    shell.textContent = '过程正文';
    assert.equal(batch.closeBatch(sess), true);
    assert.equal(h1.getAttribute('data-batch-state'), 'closed');
    // 正文之后的工具开新组
    const c3 = el('div', ['tool-card']); b.insertBefore(c3, sess.currentBubbleEl);
    const h3 = batch.noteProcessInsert(sess, c3);
    assert.notEqual(h1, h3, '真正文之后开新组');
    assert.deepEqual(batch.membersOf(h1), [c1, c2]);
    assert.deepEqual(batch.membersOf(h3), [c3]);
});

test('closeBatchFor 收口气泡内全部运行盖子（切断后并存批次不撒谎）', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const c1 = el('div', ['tool-card']); b.insertBefore(c1, sess.currentBubbleEl);
    const h1 = batch.noteProcessInsert(sess, c1);
    const err = el('div', ['chunk-error']); b.insertBefore(err, sess.currentBubbleEl);
    const c2 = el('div', ['tool-card']); b.insertBefore(c2, sess.currentBubbleEl);
    const h2 = batch.noteProcessInsert(sess, c2);
    assert.equal(batch.closeBatchFor(b), true);
    assert.equal(h1.getAttribute('data-batch-state'), 'closed', '早前运行批次必须一并收口');
    assert.equal(h2.getAttribute('data-batch-state'), 'closed');
    /* 无 i18n 时用中文 fallback：数字来自真实工作量（1 张工具卡），不再是旧的
       「已处理」——2026-11 用户报「折叠标头数字对不上」后改为 countBatchWork 口径。 */
    assert.equal(batch.labelText(h1, null), '执行工具 1 次');
    assert.ok(c1._classes.has('turn-batch-collapsed'));
    assert.ok(c2._classes.has('turn-batch-collapsed'));
    assert.equal(batch.closeBatchFor(b), false, '无运行盖子时幂等 no-op');
});

test('正文/错误/交互卡不是批次成员（答案绝不被折叠）', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const md = el('div', ['md-content']); b.appendChild(md);
    assert.equal(batch.noteProcessInsert(sess, md), null);
    assert.equal(md.getAttribute('data-turn-batch'), null);
    const err = el('div', ['chunk-error']); b.appendChild(err);
    assert.equal(batch.noteProcessInsert(sess, err), null);
    const hitl = el('div', ['hitl-card']); b.appendChild(hitl);
    assert.equal(batch.noteProcessInsert(sess, hitl), null);
    assert.equal(b.querySelectorAll('.turn-batch-header').length, 0, '非过程行不得建盖子');
});

test('closeBatch：盖子收口为真实工作量、成员折叠、aria 同步', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const c1 = el('div', ['tool-card']); b.appendChild(c1);
    const h = batch.noteProcessInsert(sess, c1);
    assert.equal(batch.closeBatch(sess), true);
    assert.equal(h.getAttribute('data-batch-state'), 'closed');
    assert.ok(c1._classes.has('turn-batch-collapsed'), '成员应折叠');
    assert.equal(h.getAttribute('aria-expanded'), 'false');
    assert.equal(batch.labelText(h, null), '执行工具 1 次');
    assert.ok(h.getAttribute('data-batch-elapsed') !== null, '应记录定格耗时');
});

test('收口后再来的过程行开新批次，旧批次保持折叠', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const c1 = el('div', ['tool-card']); b.appendChild(c1);
    const h1 = batch.noteProcessInsert(sess, c1);
    batch.closeBatch(sess);
    const c2 = el('div', ['tool-card']); b.insertBefore(c2, sess.currentBubbleEl);
    const h2 = batch.noteProcessInsert(sess, c2);
    assert.notEqual(h1, h2);
    assert.equal(b.querySelectorAll('.turn-batch-header').length, 2);
    assert.equal(h1.getAttribute('data-batch-state'), 'closed');
    assert.equal(h2.getAttribute('data-batch-state'), 'running');
    assert.ok(c1._classes.has('turn-batch-collapsed'));
    assert.ok(!c2._classes.has('turn-batch-collapsed'), '新批次成员应展开');
    assert.equal(b.children.indexOf(h2), b.children.indexOf(c2) - 1, '新盖子紧贴新成员');
});

test('零成员盖子在收口时移除（孤儿盖子不留）', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const c1 = el('div', ['tool-card']); b.appendChild(c1);
    batch.noteProcessInsert(sess, c1);
    b.removeChild(c1);   // 模拟回滚删成员
    assert.equal(batch.closeBatch(sess), true);
    assert.equal(b.querySelectorAll('.turn-batch-header').length, 0);
});

test('sweepOrphanBatchHeaders 清扫已收口的孤儿盖子', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const c1 = el('div', ['tool-card']); b.appendChild(c1);
    batch.noteProcessInsert(sess, c1);
    batch.closeBatch(sess);
    b.removeChild(c1);
    assert.equal(batch.sweepOrphanBatchHeaders(b), 1);
    assert.equal(b.querySelectorAll('.turn-batch-header').length, 0);
});

test('点击盖子切换展开/收起（aria 与成员类同步）', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const c1 = el('div', ['tool-card']); b.appendChild(c1);
    const h = batch.noteProcessInsert(sess, c1);
    batch.closeBatch(sess);
    h.click();
    assert.equal(h.getAttribute('data-batch-open'), 'true');
    assert.ok(!c1._classes.has('turn-batch-collapsed'));
    h.click();
    assert.equal(h.getAttribute('data-batch-open'), 'false');
    assert.ok(c1._classes.has('turn-batch-collapsed'));
});

test('revealAll 展开全部成员但保留盖子（失败轮护栏）', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const c1 = el('div', ['tool-card']); b.appendChild(c1);
    const h = batch.noteProcessInsert(sess, c1);
    batch.closeBatch(sess);
    assert.equal(batch.revealAll(b), 1);
    assert.ok(!c1._classes.has('turn-batch-collapsed'));
    assert.equal(b.querySelectorAll('.turn-batch-header').length, 1, '盖子保留');
});

test('clearBatch 移除盖子与归属标记（偏好一键回退）', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const c1 = el('div', ['tool-card']); b.appendChild(c1);
    batch.noteProcessInsert(sess, c1);
    batch.closeBatch(sess);
    batch.clearBatch(b);
    assert.equal(b.querySelectorAll('.turn-batch-header').length, 0);
    assert.equal(c1.getAttribute('data-turn-batch'), null);
    assert.ok(!c1._classes.has('turn-batch-collapsed'));
});

test('偏好 gourd.turnCompact=0 时不建盖子', () => {
    global.localStorage = { getItem: () => '0' };
    try {
        const b = mkBubble();
        const sess = mkSess(b);
        const c1 = el('div', ['tool-card']); b.appendChild(c1);
        assert.equal(batch.noteProcessInsert(sess, c1), null);
        assert.equal(b.querySelectorAll('.turn-batch-header').length, 0);
        assert.equal(batch.batchDisabled(), true);
    } finally { delete global.localStorage; }
    const b2 = mkBubble();
    const sess2 = mkSess(b2);
    const c2 = el('div', ['tool-card']); b2.appendChild(c2);
    assert.ok(batch.noteProcessInsert(sess2, c2), '恢复偏好后应正常建盖子');
});

test('回放态不建盖子', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    sess._replaying = true;
    const c1 = el('div', ['tool-card']); b.appendChild(c1);
    assert.equal(batch.noteProcessInsert(sess, c1), null);
});

test('formatBatchElapsed 口径与 trace 徽标一致', () => {
    assert.equal(batch.formatBatchElapsed(400), '<1s');
    assert.equal(batch.formatBatchElapsed(5000), '5s');
    assert.equal(batch.formatBatchElapsed(65000), '1min 5s');
    assert.equal(batch.formatBatchElapsed(3661000), '1h 1min 1s');
    assert.equal(batch.formatElapsedCompat === undefined, true);
    assert.equal(batch.formatBatchElapsed(-1), null);
});

/* ---- 与 turn-compact 的协作 ---- */
test('turn-compact：盖子是过程行、摘要不对其计数；有盖子时整轮摘要让位', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    // 生产插入顺序：两个成员都落在正文指针之前（成员区连续，同属一个批次）
    const c1 = el('div', ['tool-card']); b.insertBefore(c1, sess.currentBubbleEl);
    const h = batch.noteProcessInsert(sess, c1);
    const c2 = el('div', ['tool-card']); b.insertBefore(c2, sess.currentBubbleEl);
    assert.equal(batch.noteProcessInsert(sess, c2), h, '连续成员同批');
    batch.closeBatch(sess);
    const finalMd = el('div', ['md-content']); finalMd.textContent = '最终答案';
    b.appendChild(finalMd);
    const d = compact.classifyChildren(b.children);
    assert.ok(d, '应有折叠决策');
    // 【区间断言】不再把 process.length 锁成单批次理想形态的 4（含空壳正文）。
    // 只钉结构性不变量：盖子与两名成员都进过程区，且过程区按原相对顺序连续。
    assert.ok(d.process.includes(h), '盖子应归入过程区');
    assert.ok(d.process.includes(c1) && d.process.includes(c2), '两名成员都归入过程区');
    assert.ok(d.process.indexOf(h) < d.process.indexOf(c1) && d.process.indexOf(c1) < d.process.indexOf(c2),
        '盖子 → 成员保持原相对顺序，membersOf 配对不被拆散');
    assert.equal(d.final, finalMd, '唯一最终正文');
    assert.ok(!d.process.includes(finalMd), '最终正文不得被折叠');
    const stats = compact.buildSummary(d.process);
    assert.equal(stats.tools, 2, '摘要按成员计数，盖子不计数');
    /* 【Qoder 多折叠组让位契约】气泡内已有运行态批次盖子时，compactBubble 不得再叠
       第二层整轮摘要（用户 2026-11：不要「已完成 14s ›」+ N 个「执行工具 N 次」并存）：
       返回 false、不建 toggle、不展开批次已收口的成员、不打 data-turn-process 标记。 */
    c1._classes.add('turn-batch-collapsed');
    c2._classes.add('turn-batch-collapsed');
    assert.equal(compact.compactBubble(b, {}), false, '有批次盖子时整轮摘要让位');
    assert.equal(b.querySelector('.turn-compact-toggle'), null, '不得建整轮摘要盖子');
    assert.ok(c1._classes.has('turn-batch-collapsed'), '不得展开批次已收口的成员');
    assert.equal(c1.getAttribute('data-turn-process'), null, '不得打 compact 标记');
});

test('★ 多批次 + 缝合搬移后盖子/成员配对不破（让位契约下重跑稳定）', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    // 第一批：h1 + c1；中间夹一张 HITL 卡（非成员，切断批次并收口第一批）；第二批：h2 + c2
    const c1 = el('div', ['tool-card']); b.insertBefore(c1, sess.currentBubbleEl);
    const h1 = batch.noteProcessInsert(sess, c1);
    const hitl = el('div', ['hitl-card']); b.insertBefore(hitl, sess.currentBubbleEl);
    const c2 = el('div', ['tool-card']); b.insertBefore(c2, sess.currentBubbleEl);
    const h2 = batch.noteProcessInsert(sess, c2);
    assert.notEqual(h1, h2, '被 HITL 卡切断后确为两个批次');
    assert.equal(h1.getAttribute('data-batch-state'), 'closed', '切断即收口第一批（Qoder 多折叠组）');
    batch.closeBatch(sess);
    const finalMd = el('div', ['md-content']); finalMd.textContent = '最终答案';
    b.insertBefore(finalMd, sess.currentBubbleEl);
    const meta = el('div', ['msg-actions']); b.appendChild(meta);

    const d = compact.classifyChildren(b.children);
    assert.ok(d, '应有折叠决策');
    assert.equal(d.final, finalMd);
    assert.ok(d.process.includes(h1) && d.process.includes(h2), '两个盖子都进过程区');
    assert.ok(d.keep.includes(hitl), 'HITL 卡白名单常驻');
    assert.ok(!d.process.includes(hitl), 'HITL 卡不得夹在过程区内');
    /* 让位契约：有盖子不叠整轮摘要；HITL 卡作为一级常驻行留在两组之间（Qoder 形态） */
    assert.equal(compact.compactBubble(b, {}), false);
    assert.equal(b.querySelector('.turn-compact-toggle'), null);
    const kids = b.children;

    // membersOf 等价区间校验：盖子之后、下一个盖子之前的 data-turn-batch 成员
    const membersOf = (h) => {
        const out = [];
        for (let i = kids.indexOf(h) + 1; i < kids.length; i++) {
            if (kids[i]._classes.has('turn-batch-header')) break;
            if (kids[i].getAttribute('data-turn-batch') === '1') out.push(kids[i]);
        }
        return out;
    };
    assert.deepEqual(membersOf(h1), [c1], '第一批成员仍紧跟 h1');
    assert.deepEqual(membersOf(h2), [c2], '第二批成员仍紧跟 h2');

    // 模拟 stitchPrependedRunRows：把外来节点（HITL 卡）搬进第二批成员区中部。
    // 让位契约下 compactBubble 不再重排 ⇒ 盖子与成员的兄弟区间保持原样不破。
    b.insertBefore(hitl, c2);
    assert.ok(kids.indexOf(hitl) > kids.indexOf(h2) && kids.indexOf(hitl) < kids.indexOf(c2),
        '前置条件：外来节点已夹进批次区中部');
    assert.equal(compact.compactBubble(b, {}), false, '缝合后重跑仍让位');
    assert.deepEqual(membersOf(h1), [c1], '缝合搬移后第一批配对不破');
    assert.deepEqual(membersOf(h2), [c2], '缝合搬移不拆散盖子与成员的兄弟区间');
});

test('接线形状锁：finishStream 的批次收口不挂在 tcApi 存在性分支下', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'js', 'app-streaming.js'), 'utf8');
    // 回归钉：旧缺陷把收口写在 `else if (tcApi && !tcOff ...)` 里，turn-compact 模块
    // 缺失时批次永远不收口（盖子谎报「正在执行中」）。收口必须先于且独立于 compactBubble。
    assert.doesNotMatch(src, /else if \(tcApi && !tcOff/);
    assert.match(src, /else if \(!tcOff && liveFoldRow\.querySelector\)/);
    const iClose = src.indexOf('tbApi.closeBatchFor(liveBubble)');
    const iCompact = src.indexOf('tcApi.compactBubble(liveBubble');
    assert.ok(iClose > 0 && iCompact > 0, '两处调用都必须在位');
    assert.ok(iClose < iCompact, '批次收口必须先于按轮 compact');
});

test('turn-compact 放弃折叠时批次成员被展开（失败轮不藏证据）', () => {
    global.window = { GourdTurnBatch: batch };
    try {
        const b = mkBubble();
        const sess = mkSess(b);
        const c1 = el('div', ['tool-card']); b.appendChild(c1);
        batch.noteProcessInsert(sess, c1);
        batch.closeBatch(sess);
        assert.ok(c1._classes.has('turn-batch-collapsed'));
        // 无最终正文 → classifyChildren 返回 null → compactBubble 走 !decision 分支
        assert.equal(compact.compactBubble(b, {}), false);
        assert.ok(!c1._classes.has('turn-batch-collapsed'), '失败轮成员必须展开');
    } finally { delete global.window; }
});


/* ===== Qoder 智能体一级化契约（子代理卡是独立一级行，不进批次组） ===== */
test('★ 智能体卡不是批次成员：不建盖子、不带 data-turn-batch', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const agent = el('div', ['agent-card']);
    b.insertBefore(agent, sess.currentBubbleEl);
    assert.equal(batch.noteProcessInsert(sess, agent), null, '智能体卡不得触发批次组');
    assert.equal(agent.getAttribute('data-turn-batch'), null, '智能体卡不得成为批次成员');
    assert.equal(b.querySelectorAll('.turn-batch-header').length, 0, '不得为智能体建「执行工具 N 次」盖子');
});

test('★ 智能体卡是批次边界：前后工具各归自己的组，一级行不被夹进成员区', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const c1 = el('div', ['tool-card']); b.insertBefore(c1, sess.currentBubbleEl);
    const h1 = batch.noteProcessInsert(sess, c1);
    const agent = el('div', ['agent-card']); b.insertBefore(agent, sess.currentBubbleEl);
    batch.noteProcessInsert(sess, agent);   // 一级行：no-op
    const c2 = el('div', ['tool-card']); b.insertBefore(c2, sess.currentBubbleEl);
    const h2 = batch.noteProcessInsert(sess, c2);
    assert.ok(h1 && h2);
    assert.notEqual(h1, h2, '智能体一级行切断批次，前后工具分属两个组');
    assert.deepEqual(batch.membersOf(h1), [c1], '第一组仅含 c1');
    assert.deepEqual(batch.membersOf(h2), [c2], '第二组仅含 c2');
    assert.equal(agent.getAttribute('data-turn-batch'), null, '智能体始终不是成员');
});

/* ===== 2026-11 统一展现改造新增契约（app-turn-display.js 合一后） ===== */

test('★ 用户收起运行中盖子后，后到成员继承折叠态（不逃逸到折叠区外）', () => {
    // 用户报障：运行中的折叠手动收缩后，内部新到的工具/思考直接展示到折叠外面。
    // 根因：noteProcessInsert 归入 running 批次时只打标记不继承 .turn-batch-collapsed。
    const b = mkBubble();
    const sess = mkSess(b);
    const c1 = el('div', ['tool-card']); b.insertBefore(c1, sess.currentBubbleEl);
    const h = batch.noteProcessInsert(sess, c1);
    assert.ok(h, '首个成员建盖子');
    assert.equal(h.getAttribute('data-batch-open'), 'true', '新建盖子默认展开');
    // 用户手动点击收起（模拟 createHeader 内 click 监听器的逻辑路径）
    h.setAttribute('data-batch-open', 'false');
    h._classes.delete('turn-batch-open');
    c1._classes.add('turn-batch-collapsed');
    // 后到的工具卡落 DOM（生产时序：仍属同一 running 批次）
    const c2 = el('div', ['tool-card']); b.insertBefore(c2, sess.currentBubbleEl);
    const h2 = batch.noteProcessInsert(sess, c2);
    assert.equal(h2, h, '仍归同一运行盖子');
    assert.ok(c2._classes.has('turn-batch-collapsed'),
        '收起态盖子下新落的过程行必须继承折叠类，否则视觉上逃逸到折叠区外');
    // 对照：盖子展开态时新成员不带折叠类（running 常态平铺）
    h.setAttribute('data-batch-open', 'true');
    const c3 = el('div', ['tool-card']); b.insertBefore(c3, sess.currentBubbleEl);
    batch.noteProcessInsert(sess, c3);
    assert.ok(!c3._classes.has('turn-batch-collapsed'), '展开态下新成员保持平铺');
});

test('★ rebuildBatches：历史气泡按运行态规则补建 closed 态批次组', () => {
    // 用户报障：历史消息点开整轮摘要后，思考/工具逐条平铺，与运行态形态不一致。
    // 根因：回放路径被 _replaying 门禁排除批次折叠，历史气泡无任何盖子。
    // rebuildBatches 在回放收尾按同一套边界规则补建 closed 态批次组。
    const b = el('div', ['msg-bubble']);
    // 模拟回放重建的历史气泡时序：工具 → 空壳正文 → 思考 → 正文 → 工具 → agent → 工具
    const t1 = el('div', ['tool-card']); b.appendChild(t1);
    const shell = el('div', ['md-content']); b.appendChild(shell);   // 指针空壳：不切批次
    const think = el('div', ['thinking-block']); b.appendChild(think);
    const body = el('div', ['md-content']); body.textContent = '中间正文'; b.appendChild(body);  // 非空正文：边界
    const t2 = el('div', ['tool-card']); b.appendChild(t2);
    const agent = el('div', ['agent-card']); b.appendChild(agent);   // 智能体卡：边界
    const t3 = el('div', ['tool-card']); b.appendChild(t3);

    const built = batch.rebuildBatches(b);
    assert.equal(built, 3, '三段批次：[t1+think] / [t2] / [t3]，正文与智能体是边界');
    const hs = b.querySelectorAll('.turn-batch-header');
    assert.equal(hs.length, 3);
    for (const h of hs) {
        assert.equal(h.getAttribute('data-batch-state'), 'closed', '历史批次一律 closed 态');
        assert.equal(h.getAttribute('data-batch-open'), 'false', '历史批次默认收起（与运行态收口一致）');
        // 【2026-11 用户报障：历史折叠态箭头方向错】CSS 旋转只认 .turn-batch-open 类
        //（app.css `:not(.turn-batch-open)` rotate(-90deg)），不认 data-batch-open 属性。
        // createHeader 建盖子即挂该类；rebuildBatches 只改属性不摘类时，历史折叠盖子的
        // chevron 恒朝下（展开态方向），与运行态收口的右向箭头不一致。
        assert.ok(!h._classes.has('turn-batch-open'),
            '历史折叠盖子必须摘掉 turn-batch-open 类（否则 CSS 箭头旋转永不命中）');
        assert.ok(h._classes.has('turn-batch-closed'), '历史盖子带 closed 类');
    }
    assert.equal(t1.getAttribute('data-turn-batch'), '1');
    assert.equal(think.getAttribute('data-turn-batch'), '1');
    assert.equal(t2.getAttribute('data-turn-batch'), '1');
    assert.equal(t3.getAttribute('data-turn-batch'), '1');
    assert.equal(agent.getAttribute('data-turn-batch'), null, '智能体卡不是成员');
    assert.equal(body.getAttribute('data-turn-batch'), null, '非空正文不是成员');
    assert.equal(shell.getAttribute('data-turn-batch'), null, '空壳正文不切批次也不入成员');
    assert.ok(t1._classes.has('turn-batch-collapsed'), '历史成员默认折叠（与运行态收口一致）');
    // 幂等：重复调用不重建
    assert.equal(batch.rebuildBatches(b), 0, '已有盖子时幂等跳过');
});

test('★ rebuildBatches 后盖子成员配对：membersOf 语义与运行态一致', () => {
    const b = el('div', ['msg-bubble']);
    const t1 = el('div', ['tool-card']); b.appendChild(t1);
    const t2 = el('div', ['tool-card']); b.appendChild(t2);
    const body = el('div', ['md-content']); body.textContent = '答案正文'; b.appendChild(body);
    const t3 = el('div', ['tool-card']); b.appendChild(t3);
    batch.rebuildBatches(b);
    const hs = b.querySelectorAll('.turn-batch-header');
    assert.equal(hs.length, 2, '正文切成两批');
    assert.deepEqual(batch.membersOf(hs[0]), [t1, t2], '第一批含正文前两个工具');
    assert.deepEqual(batch.membersOf(hs[1]), [t3], '第二批含正文后工具');
    // 盖子文案按真实工作量统计（与运行态收口同口径）
    assert.match(batch.labelText(hs[0], null), /2 次/, '第一批统计 2 次工具');
    assert.match(batch.labelText(hs[1], null), /1 次/, '第二批统计 1 次工具');
});

/* ===== 【code review 2026-11 自审修复】三处回归钉 ===== */

test('★ 历史批次盖子文案必须是收口态（不得残留「正在执行中」）', () => {
    // 缺陷A回归钉：createHeader 建盖子时 label 按 running 态写入「正在执行中」，
    // rebuildBatches 随即把属性改成 closed，若不重算 label，历史盖子永远显示
    // 「正在执行中」—— 与运行态收口形态对不上的残留分叉。
    const b = el('div', ['msg-bubble']);
    const t1 = el('div', ['tool-card']); b.appendChild(t1);
    const think = el('div', ['thinking-block']); b.appendChild(think);
    const body = el('div', ['md-content']); body.textContent = '答案'; b.appendChild(body);
    batch.rebuildBatches(b);
    const h = b.querySelector('.turn-batch-header');
    assert.ok(h, '应建历史批次盖子');
    // 钉的是【DOM 上的实际文案】，不是 labelText 的纯函数返回值
    const labelSpan = h.querySelector('.turn-batch-label');
    assert.ok(labelSpan, '盖子应有 label span');
    assert.equal(labelSpan.textContent, '执行工具 1 次 · 思考 1 次',
        '历史盖子文案必须是收口统计，绝不残留「正在执行中」');
    assert.equal(h.getAttribute('data-batch-start'), null,
        '历史批次无 running 语义，必须摘掉计时起点（ticker 不再命中）');
});

test('★ 历史重建透传 translate：盖子文案走 i18n 而非中文回落', () => {
    const b = el('div', ['msg-bubble']);
    const t1 = el('div', ['tool-card']); b.appendChild(t1);
    const body = el('div', ['md-content']); body.textContent = '答案'; b.appendChild(body);
    const calls = [];
    const tr = (k) => { calls.push(k); return k === 'chat.batch_done_count' ? 'TOOLS:{count}' : 'x'; };
    batch.rebuildBatches(b, { translate: tr });
    const h = b.querySelector('.turn-batch-header');
    assert.equal(h.querySelector('.turn-batch-label').textContent, 'TOOLS:1',
        '盖子文案必须用 meta.translate 填充（否则 i18n 环境回落中文默认值）');
    assert.ok(calls.length > 0, 'translate 被真实调用');
});

/* 2026-11 契约对齐：根级 gourd-ai-tauri/ui 已删除且不入库（CI checkout 后不存在），
   Java 侧 static/js/app-history.js 自 2026-10-25 起未同步回放收口的 ended:true
   （applyTurnCompact(realContainer 接线实测为 0），故只锁前端唯一源。 */
test('★ 接线形状锁：历史回放 applyTurnCompact 必须传 ended:true', () => {
    // 缺陷C回归钉：compactBubble 的「批次盖子让位」门禁只在 ended 时放行整轮折叠。
    // 历史回放不传 ended ⇒ 带盖子的历史无正文轮永不折成整轮摘要（与运行态 finishStream
    // 分叉）。形状锁与 turn-compact.test.js 的 finishStream ended:true 锁同口径。
    const repo = path.resolve(__dirname, '..', '..', '..');
    const files = [
        path.join('gourd-work', 'desktop', 'ui', 'js', 'app-history.js')
    ];
    for (const rel of files) {
        const src = require('node:fs').readFileSync(path.join(repo, rel), 'utf8');
        const iApply = src.indexOf('applyTurnCompact(realContainer');
        assert.ok(iApply > 0, rel + '：找不到 applyTurnCompact(realContainer 接线');
        const seg = src.slice(iApply, iApply + 400);
        assert.match(seg, /ended:\s*true/,
            rel + '：回放收口必须传 ended:true，否则盖子让位门禁把历史轮折叠短路');
    }
});

test('★ CSS 形状锁：accent 强调块必须带 !important 且排在 ⑭ 统一块之后（两份镜像同步）', () => {
    // 缺陷B回归钉：⑭ 统一图标块 color:var(--text-tertiary) !important 会压过
    // 无 !important 的 ⑧ accent 规则（层叠无条件败北），运行中活动行图标变灰。
    // 修复=文件尾 ⑮ 块：同特异性 + 同 !important + 更靠后 ⇒ accent 恢复。
    const repo = path.resolve(__dirname, '..', '..', '..');
    const mirrors = [
        path.join('gourd-work', 'desktop', 'ui', 'css', 'app.css'),
        path.join('gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'css', 'app.css')
    ];
    const fsx = require('node:fs');
    for (const rel of mirrors) {
        const css = fsx.readFileSync(path.join(repo, rel), 'utf8');
        const iUnify = css.indexOf('⑭');
        const iAccent = css.lastIndexOf('color: var(--accent) !important');
        assert.ok(iUnify > 0, rel + '：缺 ⑭ 统一图标块');
        assert.ok(iAccent > iUnify,
            rel + '：accent !important 块（⑮）必须排在 ⑭ 之后，否则层叠被压、运行中图标变灰');
        // 花括号平衡（追加层不得破坏结构）
        let bal = 0, ok = true;
        for (const ch of css) {
            if (ch === '{') bal++;
            else if (ch === '}') { bal--; if (bal < 0) ok = false; }
        }
        assert.ok(ok && bal === 0, rel + '：CSS 花括号不平衡');
    }
});
