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

const batch = require(path.join(__dirname, '..', 'ui', 'js', 'app-turn-batch.js'));
const compact = require(path.join(__dirname, '..', 'ui', 'js', 'app-turn-compact.js'));

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

test('非过程行切断批次：后续过程行开新盖子（折叠不交错）', () => {
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
    assert.equal(h1.getAttribute('data-batch-state'), 'running', '旧批次未被收口，仍运行');
    assert.deepEqual(batch.membersOf(h1), [c1], '旧批次成员不含被切断后的行');
    assert.deepEqual(batch.membersOf(h2), [c2]);
    assert.equal(b.children.indexOf(h2), b.children.indexOf(c2) - 1, '新盖子紧贴新成员');
    assert.ok(!c2._classes.has('turn-batch-collapsed'));
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
    assert.equal(batch.labelText(h1, null), '已处理');
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

test('closeBatch：盖子变已处理、成员折叠、aria 同步', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const c1 = el('div', ['tool-card']); b.appendChild(c1);
    const h = batch.noteProcessInsert(sess, c1);
    assert.equal(batch.closeBatch(sess), true);
    assert.equal(h.getAttribute('data-batch-state'), 'closed');
    assert.ok(c1._classes.has('turn-batch-collapsed'), '成员应折叠');
    assert.equal(h.getAttribute('aria-expanded'), 'false');
    assert.equal(batch.labelText(h, null), '已处理');
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
test('turn-compact：盖子是过程行、摘要不对其计数、toggle 插在盖子前', () => {
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
    assert.ok(d.process.includes(h), '盖子应归入过程区');
    // 4 = 盖子 + 两成员 + mkSess 的空壳正文（classifyChildren 把空 .md-content 当过程噪声收起，
    // 与生产一致：finishStream 的 purgeEmptyMdBlocks 在真实链路里会先清掉它）
    assert.equal(d.process.length, 4, '盖子+两成员+空壳正文');
    const stats = compact.buildSummary(d.process);
    assert.equal(stats.tools, 2, '摘要按成员计数，盖子不计数');
    assert.ok(compact.compactBubble(b, {}));
    const toggle = b.children[0];
    assert.ok(toggle._classes.has('turn-compact-toggle'), 'toggle 应在最前（盖子之前）');
    assert.equal(b.children[1], h, '盖子紧随 toggle');
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
