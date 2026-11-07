/**
 * 契约测试：折叠组标头「数字对不上」修复（用户 2026-11 截图）。
 *
 * 缺陷：labelText(closed) 用 membersOf(header).length 当「执行工具 N 次」的 N，
 * 那是【批次成员节点数】，与屏幕完全不符：
 *   · CSS 把 .tool-batch-header 隐藏、.batch-tool-items 恒展开，
 *     一个并行组节点在屏幕上其实是多张工具卡；
 *   · .thinking-block（「已思考」）根本不是工具调用。
 * 实测截图场景：1 个内含 3 工具的并行组 + 1 个思考块
 *   → 成员节点数 2 → 旧标签「执行工具 2 次」
 *   → 屏幕却是 3 行工具 + 1 行思考。
 *
 * 用户拍板口径：工具数要【逐个数到并行组内部每张卡】，思考单独列，
 *   形态「执行工具 N 次 · 思考 M 次」（无思考时只显示工具）。
 * 实现：countBatchWork(header) → {tools, thinking}；labelText 组合两项。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..', '..', '..');
const desktop = path.resolve(__dirname, '..');
const batch = require(path.join(desktop, 'ui', 'js', 'app-turn-display.js'));

/* 复用 turn-batch.test.js 同款极简假 DOM（真实源码在 node:vm 之外直接 require） */
global.document = { createElement: t => el(t, []) };
function el(tag, classes) {
    classes = classes || [];
    const node = {
        nodeType: 1, tagName: (tag || 'div').toUpperCase(), _classes: new Set(classes),
        _attrs: {}, children: [], parentNode: null, textContent: '', style: {},
        classList: {
            contains: c => node._classes.has(c), add: c => node._classes.add(c), remove: c => node._classes.delete(c),
            toggle: c => { if (node._classes.has(c)) { node._classes.delete(c); return false; } node._classes.add(c); return true; }
        },
        get className() { return Array.from(node._classes).join(' '); },
        set className(v) { node._classes = new Set(String(v || '').split(/\s+/).filter(Boolean)); },
        setAttribute(k, v) { node._attrs[k] = String(v); },
        getAttribute(k) { return node._attrs[k] === undefined ? null : node._attrs[k]; },
        removeAttribute(k) { delete node._attrs[k]; },
        matches(s) { return s.split(',').map(x => x.trim()).some(x => x.startsWith('.') && node._classes.has(x.slice(1).split(/\s|>|\./)[0])); },
        querySelector(s) { return q(node, s)[0] || null; },
        querySelectorAll(s) { return q(node, s); },
        appendChild(c) { c.parentNode = node; node.children.push(c); return c; },
        insertBefore(c, ref) {
            const o = node.children.indexOf(c); if (o >= 0) node.children.splice(o, 1);
            c.parentNode = node;
            const i = ref ? node.children.indexOf(ref) : -1;
            if (i < 0) node.children.push(c); else node.children.splice(i, 0, c);
            return c;
        },
        removeChild(c) { const i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); c.parentNode = null; return c; },
        addEventListener() {}
    };
    function q(root, sel) {
        const out = [], want = new Set(), wa = new Set();
        sel.split(',').map(s => s.trim()).forEach(p => {
            const m = p.match(/\.([\w-]+)/); if (m) want.add(m[1]);
            const a = p.match(/\[([\w-]+)(?:=|\])/); if (a) wa.add(a[1]);
        });
        const direct = sel.indexOf(':scope >') >= 0;
        (function w(n, d) {
            for (const c of n.children) {
                let hit = false;
                for (const x of want) if (c._classes.has(x)) hit = true;
                for (const x of wa) if (c._attrs[x] !== undefined) hit = true;
                if (hit) out.push(c);
                if (!d) w(c, false);
            }
        })(root, direct);
        return out;
    }
    return node;
}
function mkBubble() {
    const b = el('div', ['msg-bubble']);
    const md = el('div', ['md-content']); b.appendChild(md);
    return { b, md, sess: { currentBubbleEl: md, _replaying: false } };
}
/** 造一个并行工具组：items 内 n 张 tool-card（组头本身一条，CSS 隐藏） */
function mkGroup(n) {
    const g = el('div', ['tool-batch-group']);
    g.appendChild(el('div', ['tool-batch-header']));
    const items = el('div', ['batch-tool-items']);
    for (let i = 0; i < n; i++) items.appendChild(el('div', ['tool-card']));
    g.appendChild(items);
    return g;
}
/** 中文 i18n：走真实语言包值（带 {count}，由 makeTr 透传 params 插值） */
function zhTr(k, params) {
    const j = JSON.parse(fs.readFileSync(path.join(desktop, 'ui', 'locales', 'zh-CN.json'), 'utf8').replace(/^\uFEFF/, ''));
    let v = (j.chat || {})[k.replace(/^chat\./, '')];
    if (typeof v !== 'string') return k;
    if (params) for (const p in params) v = v.replace(new RegExp('\\{' + p + '\\}', 'g'), String(params[p]));
    return v;
}

/** 用真实管线建一批次 → 收口 → 返回 {header, label(无i18n), labelZh} */
function buildAndClose(members) {
    const { b, md, sess } = mkBubble();
    let h = null;
    for (const m of members) {
        b.insertBefore(m, md);
        h = batch.noteProcessInsert(sess, m) || h;
    }
    batch.closeBatchFor(b);
    return { h, label: batch.labelText(h, null), labelZh: batch.labelText(h, zhTr) };
}

test('★ 截图场景：1 个并行组(内含3工具) + 1 思考块 → 工具3 · 思考1（旧版谎报 2）', () => {
    const r = buildAndClose([mkGroup(3), el('div', ['thinking-block'])]);
    assert.deepEqual(batch.countBatchWork(r.h), { tools: 3, thinking: 1 });
    assert.equal(batch.membersOf(r.h).length, 2, '旧口径=2，正是用户看到的错数');
    assert.equal(r.label, '执行工具 3 次 · 思考 1 次');
    assert.equal(r.labelZh, '执行工具 3 次 · 思考 1 次');
});

test('★ 并行组内部逐卡计数：2 个组(2+4 张卡) → 工具 6，不能按组数算成 2', () => {
    const r = buildAndClose([mkGroup(2), mkGroup(4)]);
    assert.deepEqual(batch.countBatchWork(r.h), { tools: 6, thinking: 0 });
    assert.equal(r.label, '执行工具 6 次', '无思考时不出现「思考 0 次」');
});

test('★ 独立工具卡 + 思考混排：3 工具 + 2 思考 → 工具3 · 思考2', () => {
    const members = [];
    for (let i = 0; i < 3; i++) members.push(el('div', ['tool-card']));
    members.push(el('div', ['thinking-block']));
    members.push(el('div', ['thinking-block']));
    const r = buildAndClose(members);
    assert.deepEqual(batch.countBatchWork(r.h), { tools: 3, thinking: 2 });
    assert.equal(r.label, '执行工具 3 次 · 思考 2 次');
});

test('★ 只有思考块：只显示「思考 N 次」，不谎报工具', () => {
    const r = buildAndClose([el('div', ['thinking-block']), el('div', ['thinking-block'])]);
    assert.deepEqual(batch.countBatchWork(r.h), { tools: 0, thinking: 2 });
    assert.equal(r.label, '思考 2 次');
});

test('★ 空批次 / 无成员：回落「已处理」，与既有契约一致', () => {
    const h = el('div', ['turn-batch-header']);
    h.setAttribute('data-batch-state', 'closed');
    assert.equal(batch.labelText(h, null), '已处理');
    // 空并行组按 1 计（组节点自身就是一次调用证据，与 turn-compact.buildSummary 的 n||1 一致）
    const r = buildAndClose([mkGroup(0)]);
    assert.deepEqual(batch.countBatchWork(r.h), { tools: 1, thinking: 0 });
});

test('★ 运行中盖子文案不受改动：仍是「正在执行中 · Ns」', () => {
    const h = el('div', ['turn-batch-header']);
    h.setAttribute('data-batch-state', 'running');
    assert.match(batch.labelText(h, null), /正在执行中/);
});

test('★ i18n 占位符：{count} 由 params 插值，不残留字面量', () => {
    const r = buildAndClose([mkGroup(3), el('div', ['thinking-block'])]);
    assert.equal(r.labelZh.includes('{count}'), false);
    assert.match(r.labelZh, /3 次/);
    assert.match(r.labelZh, /1 次/);
});

/* 2026-11 契约对齐：前端唯一源是 gourd-work/desktop/ui，Java 侧 static 为历史镜像；
   根级 gourd-ai-tauri/ui 是 7370119 已删除、.gitignore 忽略的构建期拷贝残骸，
   CI checkout 后不存在，绝不能再作为第三份镜像锁进契约。 */
test('★ 两份 UI 镜像的 app-turn-display.js 完全一致（旧 turn-batch/turn-compact 已合并删除）', () => {
    const files = [
        path.join(desktop, 'ui', 'js', 'app-turn-display.js'),
        path.join(repo, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'js', 'app-turn-display.js')
    ];
    const hashes = files.map(f => {
        assert.ok(fs.existsSync(f), '镜像缺失: ' + f);
        return require('crypto').createHash('md5').update(fs.readFileSync(f)).digest('hex');
    });
    assert.equal(new Set(hashes).size, 1, '两份 turn-display 实现必须一致');
    // 旧文件必须彻底删除（bootstrap 已只加载 app-turn-display.js，留旧文件会造成双模块双盖子）
    const legacy = [
        path.join(desktop, 'ui', 'js', 'app-turn-batch.js'),
        path.join(desktop, 'ui', 'js', 'app-turn-compact.js'),
        path.join(repo, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'js', 'app-turn-batch.js'),
        path.join(repo, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'js', 'app-turn-compact.js')
    ];
    for (const f of legacy) {
        assert.ok(!fs.existsSync(f), '旧模块必须删除，防双加载: ' + f);
    }
    // 两份 bootstrap 加载链都只引用新模块
    const boots = [
        path.join(desktop, 'ui', 'js', 'app-bootstrap.js'),
        path.join(repo, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'js', 'app-bootstrap.js')
    ];
    for (const f of boots) {
        const src = fs.readFileSync(f, 'utf8');
        assert.ok(src.includes('/js/app-turn-display.js'), 'bootstrap 必须加载统一模块: ' + f);
        assert.ok(!src.includes('/js/app-turn-batch.js') && !src.includes('/js/app-turn-compact.js'),
            'bootstrap 不得再加载旧模块: ' + f);
    }
});

test('★ 12 份语言包（desktop）都有 chat.batch_thinking_count 且键集一致', () => {
    const dir = path.join(desktop, 'ui', 'locales');
    const langs = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    assert.equal(langs.length, 12);
    const keySets = [];
    for (const f of langs) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, ''));
        assert.ok(j.chat && typeof j.chat.batch_thinking_count === 'string', f + ' 缺 chat.batch_thinking_count');
        assert.match(j.chat.batch_thinking_count, /\{count\}/, f + ' 缺 {count} 占位符');
        keySets.push(Object.keys(j).sort().join('|') + '#' + Object.keys(j.chat).sort().join('|'));
    }
    assert.equal(new Set(keySets).size, 1, '12 份语言包键集必须一致（locale-parity 契约）');
});

test('★ 24 份语言包 JSON 全部有效', () => {
    const dirs = [
        path.join(desktop, 'ui', 'locales'),
        path.join(repo, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'locales')
    ];
    let n = 0;
    for (const d of dirs) for (const f of fs.readdirSync(d).filter(x => x.endsWith('.json'))) {
        assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8').replace(/^\uFEFF/, '')), d + '/' + f);
        n++;
    }
    assert.equal(n, 24);
});
