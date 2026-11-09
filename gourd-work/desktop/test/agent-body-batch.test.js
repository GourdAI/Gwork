/**
 * 契约测试：智能体卡内批次折叠（2026-11 方案A 用户拍板「卡内与外部同构」）。
 *
 * 背景：此前 noteProcessInsert 只认主气泡 .msg-bubble，子代理卡体（.agent-card-body）
 * 内的工具/思考不建盖子——智能体卡展开后过程行逐条平铺，与外部消息形态不一致。
 * 方案A：卡体成为合法批次宿主，盖子建在卡体内直接子级，与外部共用同一份
 * noteProcessInsert / closeBatchFor / rebuildBatches 逻辑（一处维护）。
 *
 * 重点护栏：
 *  - 卡内工具卡落 DOM → 建盖子（agent-card-body 为合法宿主）
 *  - 卡内正文到达 → closeBatch(st) 收口卡内盖子（不动主气泡批次）
 *  - agent_end 收卡 → closeBatchFor(卡体) 定格全部 running 盖子
 *  - 主气泡收口不得误关卡内的 running 盖子（childHeadersOf 只认直接子级）
 *  - rebuildBatches 历史重建下钻卡体（历史 = 运行态）
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const batch = require(path.join(__dirname, '..', 'ui', 'js', 'app-turn-display.js'));

/* ---- 极简假 DOM（与 turn-batch.test.js 同口径） ---- */
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
/* 主气泡 + 一张智能体卡（卡体 bodyEl 模拟 sess.agentStates[x].bodyEl） */
function mkAgentCard(bubble) {
    const card = el('div', ['agent-card']);
    const header = el('div', ['agent-card-header']);
    const body = el('div', ['agent-card-body']);
    card.appendChild(header);
    card.appendChild(body);
    bubble.appendChild(card);
    return { card: card, bodyEl: body };
}

test('★ 卡内工具落 DOM 建盖子：agent-card-body 是合法批次宿主（方案A）', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const ag = mkAgentCard(b);
    const c1 = el('div', ['tool-card']);
    ag.bodyEl.appendChild(c1);
    const h = batch.noteProcessInsert(sess, c1);
    assert.ok(h, '卡内首个过程行必须建盖子');
    assert.equal(h.parentNode, ag.bodyEl, '盖子必须是卡体直接子级');
    assert.equal(c1.getAttribute('data-turn-batch'), '1', '卡内工具成为批次成员');
    const c2 = el('div', ['tool-card']);
    ag.bodyEl.appendChild(c2);
    const h2 = batch.noteProcessInsert(sess, c2);
    assert.equal(h2, h, '后续卡内过程行归同一运行盖子');
});

test('★ 卡内思考块同样进批次（与外部同构）', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const ag = mkAgentCard(b);
    const think = el('div', ['thinking-block']);
    ag.bodyEl.appendChild(think);
    const h = batch.noteProcessInsert(sess, think);
    assert.ok(h, '卡内思考块必须建盖子');
    assert.equal(batch.membersOf(h)[0], think, '思考块是首个成员');
});

test('★ 卡内正文到达收口卡内批次：closeBatch(sess, null, st) 不动主气泡', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const ag = mkAgentCard(b);
    const c1 = el('div', ['tool-card']);
    ag.bodyEl.appendChild(c1);
    const agentHeader = batch.noteProcessInsert(sess, c1);
    // 主气泡侧也有自己的 running 批次
    const m1 = el('div', ['tool-card']);
    b.insertBefore(m1, sess.currentBubbleEl);
    const mainHeader = batch.noteProcessInsert(sess, m1);
    // 卡内正文到达：收口卡内批次（st 带 bodyEl）
    const st = { bodyEl: ag.bodyEl };
    batch.closeBatch(sess, null, st);
    assert.equal(agentHeader.getAttribute('data-batch-state'), 'closed', '卡内盖子收口');
    assert.equal(mainHeader.getAttribute('data-batch-state'), 'running', '主气泡批次不受影响');
    assert.ok(c1._classes.has('turn-batch-collapsed'), '卡内成员折叠');
});

test('★ agent_end 收卡：closeBatchFor(卡体) 定格全部 running 盖子', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const ag = mkAgentCard(b);
    const c1 = el('div', ['tool-card']);
    ag.bodyEl.appendChild(c1);
    const h1 = batch.noteProcessInsert(sess, c1);
    // 卡内正文到达（appendBodyContentCore 链路）：closeBatch(st) 收口第一组
    const md = el('div', ['md-content']);
    md.textContent = '中间正文';
    ag.bodyEl.appendChild(md);
    batch.closeBatch(sess, null, { bodyEl: ag.bodyEl });
    assert.equal(h1.getAttribute('data-batch-state'), 'closed', '正文边界收口第一组');
    // 正文后新工具落 DOM：邻接校验失败 → 开新盖子（真实链路时序）
    const c2 = el('div', ['tool-card']);
    ag.bodyEl.appendChild(c2);
    const h2 = batch.noteProcessInsert(sess, c2);
    assert.ok(h2 && h2 !== h1, '收口后新工具开新盖子');
    // agent_end：收口卡体（兜底：即便漏了正文收口，这里也会定格）
    batch.closeBatchFor(ag.bodyEl);
    const hs = ag.bodyEl.querySelectorAll('.turn-batch-header');
    assert.equal(hs.length, 2, '正文边界切分两个批次');
    for (const h of hs) {
        assert.equal(h.getAttribute('data-batch-state'), 'closed', '卡内盖子全部收口');
    }
    assert.ok(c1._classes.has('turn-batch-collapsed') && c2._classes.has('turn-batch-collapsed'), '成员折叠');
});

test('★ 主气泡收口不得误关卡内 running 盖子（childHeadersOf 只认直接子级）', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const ag = mkAgentCard(b);
    // 卡内有 running 批次（后台子代理仍在跑）
    const ac = el('div', ['tool-card']);
    ag.bodyEl.appendChild(ac);
    const agentHeader = batch.noteProcessInsert(sess, ac);
    // 主气泡正文到达收口主批次
    batch.closeBatch(sess);
    assert.equal(agentHeader.getAttribute('data-batch-state'), 'running',
        '主气泡 closeBatch 不得穿透关闭卡内 running 盖子');
});

test('★ rebuildBatches 历史重建下钻卡体：历史卡内批次 = 运行态形态', () => {
    const b = el('div', ['msg-bubble']);
    const ag = mkAgentCard(b);
    const t1 = el('div', ['tool-card']); ag.bodyEl.appendChild(t1);
    const shell = el('div', ['md-content']); ag.bodyEl.appendChild(shell);
    const body = el('div', ['md-content']); body.textContent = '卡内正文'; ag.bodyEl.appendChild(body);
    const t2 = el('div', ['tool-card']); ag.bodyEl.appendChild(t2);
    const built = batch.rebuildBatches(b);
    assert.ok(built >= 2, '卡体历史批次被补建（正文前后各一组），实建 ' + built);
    const hs = ag.bodyEl.querySelectorAll('.turn-batch-header');
    assert.equal(hs.length, 2, '历史卡内两个批次组');
    for (const h of hs) {
        assert.equal(h.getAttribute('data-batch-state'), 'closed', '历史批次一律 closed');
        assert.equal(h.getAttribute('data-batch-open'), 'false', '历史批次默认收起');
    }
    assert.ok(t1._classes.has('turn-batch-collapsed') && t2._classes.has('turn-batch-collapsed'), '历史成员折叠');
});
