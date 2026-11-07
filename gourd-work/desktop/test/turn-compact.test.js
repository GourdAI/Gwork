/**
 * 契约测试：P2-6 按轮 Compact 折叠（app-turn-compact.js）。
 *
 * 纯函数在 Node 里真跑；DOM 副作用用极简假 DOM 验证（不引入 jsdom，保持零依赖）。
 * 重点护栏：
 *  - warn 状态点 / msg-trace 是回放常态，绝不能让整轮折叠失效（dsh #6250 同类坑）
 *  - 失败/无正文轮次保留全部过程证据，不许藏过程
 *  - 最后一轮进行中（lastTurnClosed=false）不折
 *  - prepend 的 scopeRows 不误折容器底部实时轮
 *  - 幂等：重复执行不重复插按钮、不重复计数
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const api = require(path.join(__dirname, '..', 'ui', 'js', 'app-turn-display.js'));

/* ---- 极简假 DOM：只实现模块用到的 API ---- */
function el(tag, classes, opts) {
    classes = classes || [];
    const node = {
        nodeType: 1, tagName: (tag || 'div').toUpperCase(),
        _classes: new Set(classes), _attrs: {}, children: [], parentNode: null,
        textContent: (opts && opts.text) || '',
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
            // 与真实 DOM 同语义：对已在文档中的节点 insertBefore = 移动（先摘原位置）。
            // 缺这一步会让「盖子归位」类用例插出重复节点（2026-11 自审补）。
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
    // :scope > .cls 与后代选择器都按 className 集合近似处理
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

/* compactBubble 会用 document.createElement 建摘要按钮。UMD 模块在 Node 下没有 window.document，
   装一个返回假节点的最小实现，覆盖全部 DOM 测试（末尾无需 delete，测试进程独立）。 */
global.document = { createElement: (t) => el(t, []) };

function bubble(childSpecs) {
    const b = el('div', ['msg-bubble']);
    childSpecs.forEach(s => {
        const n = el('div', s.cls || [], { text: s.text || '' });
        if (s.attrs) Object.keys(s.attrs).forEach(k => n.setAttribute(k, s.attrs[k]));
        if (s.inner) s.inner.forEach(ic => n.appendChild(el('div', ic, {})));
        b.appendChild(n);
    });
    return b;
}

const PROCESS = ['thinking-block', 'tool-card', 'tool-batch-group', 'agent-card'];

test('classifyChildren：最终正文之前的过程行收起，正文与页脚保留', () => {
    const b = bubble([
        { cls: ['thinking-block'] },
        { cls: ['tool-card'], inner: ['tool-status-icon'] },
        { cls: ['tool-card'], inner: ['tool-status-icon'] },
        { cls: ['md-content'], text: '这是最终正文' },
        { cls: ['msg-meta-row'] },
        { cls: ['msg-actions'] }
    ]);
    const d = api.classifyChildren(b.children);
    assert.ok(d, '应有折叠决策');
    assert.equal(d.process.length, 3);
    assert.ok(d.process.every(n => PROCESS.some(c => n._classes.has(c))));
    assert.ok(d.keep.some(n => n._classes.has('md-content')));
});

test('★ 回放常态 warn / msg-trace 不得让整轮折叠失效', () => {
    const b = bubble([
        { cls: ['thinking-block'] },
        // app-history.js:2345 把回放残留 loading 统一标 warn；msg-trace 是每轮耗时徽标
        { cls: ['tool-card'], inner: ['tool-status-icon', 'warn'] },
        { cls: ['msg-trace'] },
        { cls: ['md-content'], text: '正文' }
    ]);
    const d = api.classifyChildren(b.children);
    assert.ok(d, 'warn / msg-trace 是常态，不能因此整体放弃折叠');
    assert.equal(d.process.length, 2, '思考块 + 工具卡仍应被收起');
});

test('失败证据块（err-bubble/chunk-error）出现时整轮不折叠', () => {
    const b = bubble([
        { cls: ['thinking-block'] },
        { cls: ['err-bubble'], text: '工具执行失败' },
        { cls: ['md-content'], text: '正文' }
    ]);
    assert.equal(api.classifyChildren(b.children), null);
});

test('无最终正文的轮次保留全部过程证据', () => {
    const b = bubble([
        { cls: ['thinking-block'] },
        { cls: ['tool-card'] },
        { cls: ['md-content'], text: '   ' }   // 空壳
    ]);
    assert.equal(api.classifyChildren(b.children), null);
});

/* 【code review 回归 · 缺陷3】生产中 .msg-trace 挂在 .msg-meta-row 内部
   （app-message.js appendTraceBadge），不是气泡直接子级。旧实现只扫直接子级
   ⇒ 恒 false ⇒ 回放态「无正文成功轮」永远折不成一行摘要。此处钉死真实层级。 */
test('★ 无正文成功轮：msg-trace 嵌在 meta-row 内也必须识别为成功终态（深层查找）', () => {
    const b = bubble([
        { cls: ['tool-card'] },
        { cls: ['tool-card'] },
        { cls: ['md-content'], text: '  ' }
    ]);
    const meta = el('div', ['msg-meta-row']);
    const trace = el('span', ['msg-trace']);
    trace.setAttribute('data-turn-status', 'done');
    trace.setAttribute('data-elapsed-ms', '9000');
    meta.appendChild(trace);
    b.appendChild(meta);
    const d = api.classifyChildren(b.children, b);
    assert.ok(d, '深层 msg-trace(done) 必须被识别，否则无正文成功轮永远不折叠');
    assert.equal(d.final, null, '无最终正文 ⇒ final 为 null');
    assert.ok(d.process.length >= 2, '两张工具卡进过程区');
});

test('★ 无正文轮但 trace 为 stopped：仍保留全部过程证据（不许藏失败）', () => {
    const b = bubble([{ cls: ['tool-card'] }, { cls: ['tool-card'] }]);
    const meta = el('div', ['msg-meta-row']);
    const trace = el('span', ['msg-trace']);
    trace.setAttribute('data-turn-status', 'stopped');
    meta.appendChild(trace);
    b.appendChild(meta);
    assert.equal(api.classifyChildren(b.children, b), null);
});

test('★ compactBubble 真实层级：无正文成功轮折成一行摘要，且摘要读到耗时', () => {
    const b = bubble([{ cls: ['tool-card'] }, { cls: ['thinking-block'] }]);
    const meta = el('div', ['msg-meta-row']);
    const trace = el('span', ['msg-trace']);
    trace.setAttribute('data-turn-status', 'done');
    trace.setAttribute('data-elapsed-ms', '9000');
    meta.appendChild(trace);
    b.appendChild(meta);
    assert.equal(api.compactBubble(b, {}), true, '应折叠');
    const tg = b.querySelector('.turn-compact-toggle');
    assert.ok(tg, '摘要按钮存在');
    assert.match(tg.textContent, /已完成/, '状态词');
    assert.match(tg.textContent, /9s/, '耗时来自深层 trace');
    assert.equal(b.querySelector('.msg-trace'), trace, 'trace 徽标不被收起');
});

test('错误/HITL/文件变更卡自己保留可见，但不阻断其它过程行收起', () => {
    const b = bubble([
        { cls: ['thinking-block'] },
        { cls: ['hitl-card'] },
        { cls: ['msg-run-changes-card'] },
        { cls: ['tool-card'] },
        { cls: ['md-content'], text: '正文' }
    ]);
    const d = api.classifyChildren(b.children);
    assert.ok(d);
    assert.equal(d.process.length, 2, 'thinking + tool-card 收起');
    assert.ok(d.keep.filter(n => n._classes.has('hitl-card')).length === 1);
    assert.ok(d.keep.filter(n => n._classes.has('msg-run-changes-card')).length === 1);
});

test('buildSummary：批次组按成员数计，三类统计与全零回落', () => {
    const batch = el('div', ['tool-batch-group']);
    const items = el('div', ['batch-tool-items']);
    items.appendChild(el('div', ['tool-card']));
    items.appendChild(el('div', ['tool-card']));
    items.appendChild(el('div', ['tool-card']));
    batch.appendChild(items);
    const s = api.buildSummary([
        el('div', ['thinking-block']), batch,
        el('div', ['tool-card']), el('div', ['agent-card'])
    ]);
    assert.deepEqual(s, { tools: 4, thinking: 1, agents: 1, texts: 0 });
    const txt = api.summaryText(s, null);
    assert.match(txt, /^已完成/, '状态词恒在首位（WorkBuddy 状态行形态）');
    assert.match(txt, /4 次工具调用/);
    assert.match(txt, /1 段思考/);
    assert.match(txt, /1 次子代理/);
    // 全零统计不再回落「已思考」：状态词本身即摘要主体（「已完成」）
    assert.equal(api.summaryText({ tools: 0, thinking: 0, agents: 0, texts: 0 }, null), '已完成');
});

test('summaryText 走 i18n，缺键时回落中文而不显示裸 key', () => {
    const t = (k) => ({ 'chat.turn_tools': 'tool calls', 'chat.turn_thinking': 'thoughts' }[k] || k);
    // n=1 走单数键 chat.turn_thinking_one：mock 未提供 → 回落中文量词（中文单复数同形）
    assert.equal(api.summaryText({ tools: 2, thinking: 1, agents: 0 }, t), '已完成 · 2 tool calls · 1 段思考');
    assert.equal(api.summaryText({ tools: 1, thinking: 0, agents: 1 }, () => 'chat.turn_agents'), '已完成 · 1 次工具调用 · 1 次子代理');
});

test('★ 计数词单复数：n=1 用 _one 键，n>1 用复数键，缺单数键回落中文', () => {
    const t = (k) => ({
        'chat.turn_tools': 'tool calls', 'chat.turn_tools_one': 'tool call',
        'chat.turn_thinking': 'thinking blocks', 'chat.turn_thinking_one': 'thinking block'
    }[k] || k);
    assert.equal(api.summaryText({ tools: 1, thinking: 1, agents: 0 }, t), '已完成 · 1 tool call · 1 thinking block');
    assert.equal(api.summaryText({ tools: 2, thinking: 1, agents: 0 }, t), '已完成 · 2 tool calls · 1 thinking block');
    // 语言包缺 _one 键（旧包/异常）：回落中文量词，不显示裸 key、不显示复数误形
    const tNoOne = (k) => ({ 'chat.turn_tools': 'tool calls' }[k] || k);
    assert.equal(api.summaryText({ tools: 1, thinking: 0, agents: 0 }, tNoOne), '已完成 · 1 次工具调用');
});

test('★ 摘要状态词+耗时：meta 驱动，旧历史无 meta 回落「已完成」无耗时', () => {
    const s = { tools: 3, thinking: 0, agents: 0, texts: 0 };
    assert.equal(api.summaryText(s, null, { elapsedMs: 14200, status: 'done' }), '已完成 14s · 3 次工具调用');
    assert.equal(api.summaryText(s, null, { elapsedMs: 400, status: 'done' }), '已完成 <1s · 3 次工具调用', '亚秒不写 0s（四舍五入口径与 trace 徽标一致）');
    assert.equal(api.summaryText(s, null, { elapsedMs: 95000, status: 'stopped' }), '已停止 1min 35s · 3 次工具调用');
    assert.equal(api.summaryText(s, null, { status: 'suspended' }), '已挂起 · 3 次工具调用', '无耗时不编造数字');
    assert.equal(api.summaryText(s, null), '已完成 · 3 次工具调用', '旧历史无 meta 回落');
    assert.equal(api.summaryText(s, null, { elapsedMs: -5 }), '已完成 · 3 次工具调用', '负值忽略');
    assert.equal(api.formatElapsed(3600000), '1h');
    assert.equal(api.formatElapsed(3661000), '1h 1min 1s');
});

test('★ readTurnMeta 从 trace 徽标读 data 属性，无徽标/脏数据回落 {}', () => {
    const b = bubble([{ cls: ['md-content'], text: 'x' }]);
    assert.deepEqual(api.readTurnMeta(b), {});
    const badge = el('span', ['msg-trace']);
    badge.setAttribute('data-elapsed-ms', '14200');
    badge.setAttribute('data-turn-status', 'stopped');
    b.appendChild(badge);
    assert.deepEqual(api.readTurnMeta(b), { elapsedMs: 14200, status: 'stopped' });
    const bad = el('span', ['msg-trace']);
    bad.setAttribute('data-elapsed-ms', 'abc');
    const b2 = bubble([{ cls: ['md-content'], text: 'x' }]);
    b2.appendChild(bad);
    assert.deepEqual(api.readTurnMeta(b2), {}, '非数字耗时不得污染摘要');
});

test('applyTurnCompact：逐轮独立 —— 非最后一轮必折，最后一轮看 lastTurnClosed', () => {
    const container = el('div', []);
    const mkTurn = (text) => {
        const u = el('div', ['msg-row', 'user']); container.appendChild(u);
        const a = el('div', ['msg-row', 'assistant']); container.appendChild(a);
        a.appendChild(bubble([
            { cls: ['thinking-block'] }, { cls: ['tool-card'] },
            { cls: ['md-content'], text }
        ]));
        return a;
    };
    mkTurn('第一轮正文'); mkTurn('第二轮正文');
    let r = api.applyTurnCompact(container, { lastTurnClosed: false });
    assert.equal(r.turns, 2);
    assert.equal(r.compacted, 1, '进行中的最后一轮不折');
    r = api.applyTurnCompact(container, { lastTurnClosed: true });
    assert.equal(r.compacted, 2, '终态确认后两轮都折');
});

test('applyTurnCompact：scopeRows 只处理指定行（prepend 不误折实时轮）', () => {
    const container = el('div', []);
    const mk = (text) => {
        const u = el('div', ['msg-row', 'user']); container.appendChild(u);
        const a = el('div', ['msg-row', 'assistant']); container.appendChild(a);
        a.appendChild(bubble([{ cls: ['tool-card'] }, { cls: ['md-content'], text }]));
        return [u, a];
    };
    const older = mk('更早历史');
    const live = mk('正在流式输出');   // 进行中的实时轮，绝不能被折
    const r = api.applyTurnCompact(container, { lastTurnClosed: false, scopeRows: older });
    assert.equal(r.compacted, 1);
    const liveBubble = live[1].children[0];
    assert.equal(liveBubble.querySelectorAll('[data-turn-process]') .length, 0, '实时轮不得被标记');
    assert.equal(liveBubble.querySelector('.turn-compact-toggle'), null, '实时轮不得插摘要按钮');
});

test('compactBubble 幂等：重复执行不重复插按钮 / 不重复计数', () => {
    const b = bubble([
        { cls: ['thinking-block'] }, { cls: ['tool-card'] },
        { cls: ['tool-card'] }, { cls: ['md-content'], text: '正文' }
    ]);
    assert.equal(api.compactBubble(b, {}), true);
    const first = b.querySelector('.turn-compact-toggle');
    assert.ok(first);
    assert.equal(first.textContent, '已完成 · 2 次工具调用 · 1 段思考');
    assert.equal(api.compactBubble(b, {}), true);
    assert.equal(b.querySelectorAll('.turn-compact-toggle').length, 1, '只有一个摘要按钮');
    assert.equal(b.querySelector('.turn-compact-toggle'), first, '复用同一个按钮节点');
    assert.equal(b.querySelectorAll('[data-turn-process]').length, 3);
    // 展开：点击 toggle 切类，过程行标记仍在（不重排）
    first.click();
    assert.ok(b._classes.has('turn-compact-open'));
    assert.equal(b.querySelectorAll('[data-turn-process]').length, 3);
    api.clearTurnCompact(b);
    assert.equal(b.querySelectorAll('.turn-compact-toggle').length, 0);
    assert.equal(b.querySelectorAll('[data-turn-process]').length, 0);
});

test('compactBubble 在决策变为 null 时撤销已有折叠（内容补帧后可回退）', () => {
    const b = bubble([
        { cls: ['thinking-block'] }, { cls: ['md-content'], text: '正文' }
    ]);
    assert.equal(api.compactBubble(b, {}), true);
    // 补进一个失败证据 → 整轮必须恢复全可见
    b.insertBefore(el('div', ['err-bubble'], { text: '失败' }), b.children[0]);
    assert.equal(api.compactBubble(b, {}), false);
    assert.equal(b.querySelectorAll('[data-turn-process]').length, 0);
    assert.equal(b.querySelectorAll('.turn-compact-toggle').length, 0);
});

test('★ 自动折叠不得吞掉键盘焦点（dsh 踩过的坑）', () => {
    const b = bubble([
        { cls: ['thinking-block'] }, { cls: ['tool-card'] },
        { cls: ['md-content'], text: '正文' }
    ]);
    const focused = b.children[1];
    // 模拟焦点落在待隐藏的工具卡内
    global.document.activeElement = focused;
    assert.equal(api.compactBubble(b, {}), false, '焦点在过程行内时本轮保持全可见');
    assert.equal(b.querySelectorAll('[data-turn-process]').length, 0);
    assert.equal(b.querySelectorAll('.turn-compact-toggle').length, 0);
    // 焦点移走后即可正常折叠
    global.document.activeElement = null;
    assert.equal(api.compactBubble(b, {}), true);
    assert.equal(b.querySelectorAll('[data-turn-process]').length, 2);
    global.document.activeElement = null;
});

test('★ 过程正文归入折叠：最终正文之前含文本的 .md-content 必须收起', () => {
    // 真实一轮的形态：工具之间的解释性文字 = 多个 .md-content，最后一个才是最终答案
    const b = bubble([
        { cls: ['thinking-block'] },
        { cls: ['md-content'], text: '我先看一下项目结构' },      // 过程正文 ①
        { cls: ['tool-card'] },
        { cls: ['md-content'], text: '目录是空的，我从零搭一个' },  // 过程正文 ②
        { cls: ['tool-card'] },
        { cls: ['md-content'], text: '已完成，构建通过' }          // 最终正文（唯一 keep）
    ]);
    const d = api.classifyChildren(b.children);
    assert.ok(d, '应有折叠决策');
    const mds = d.process.filter(n => n._classes.has('md-content'));
    assert.equal(mds.length, 2, '两段过程正文都进折叠区');
    assert.equal(d.keep.filter(n => n._classes.has('md-content')).length, 1, '只留最终正文');
    assert.equal(buildProcessStats(d.process).texts, 2, '摘要统计两段过程');
});

test('★ 空壳 .md-content（指针推进残留）不计数但收起', () => {
    const b = bubble([
        { cls: ['md-content'], text: '   ' },   // 空壳
        { cls: ['tool-card'] },
        { cls: ['md-content'], text: '最终答案' }
    ]);
    const d = api.classifyChildren(b.children);
    assert.ok(d);
    assert.equal(buildProcessStats(d.process).texts, 0, '空壳不计入过程段数');
    assert.equal(d.process.filter(n => n._classes.has('md-content')).length, 1, '空壳仍被收起');
});

test('★ 过程行按类型打语义标记（供 CSS 分化 ◇/$/▸/DIM）', () => {
    const b = bubble([
        { cls: ['thinking-block'] },
        { cls: ['tool-card'] },
        { cls: ['md-content'], text: '过程文字' },
        { cls: ['md-content'], text: '最终答案' }
    ]);
    assert.equal(api.compactBubble(b, {}), true);
    const vals = b.querySelectorAll('[data-turn-process]').map(n => n.getAttribute('data-turn-process'));
    assert.ok(vals.includes('thinking'), '思考 → thinking');
    assert.ok(vals.includes('tool'), '工具 → tool');
    assert.ok(vals.includes('text'), '过程正文 → text');
    assert.ok(!vals.includes('1'), '不得再用无语义的固定值 1');
});

test('★ 摘要含「N 段过程」且 i18n 缺键回落中文，不显示裸 key', () => {
    const s = { tools: 2, thinking: 1, agents: 0, texts: 3 };
    assert.match(api.summaryText(s, null), /3 段过程/);
    const t = (k) => ({ 'chat.turn_tools': 'tool calls' }[k] || k);
    const out = api.summaryText(s, t);
    assert.match(out, /3 段过程/, '缺键回落中文');
    assert.ok(!out.includes('chat.turn_process_texts'), '不得把技术 key 显示给用户');
});

test('CSS 契约：折叠规则零包装层、且不命中任何用户气泡选择器', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'css', 'app.css'), 'utf8');
    assert.match(css, /\.msg-bubble > \[data-turn-process\] \{ display: none !important; \}/);
    assert.match(css, /\.msg-bubble\.turn-compact-open > \[data-turn-process\] \{ display: block !important; \}/);
    assert.match(css, /\.turn-compact-toggle \{/);
    // 本轮新增的 Compact 块里不得出现 .msg-row.user
    const block = css.slice(css.indexOf('P2-6 按轮 Compact 折叠'));
    assert.ok(!block.includes('.msg-row.user'), 'Compact CSS 绝不能碰用户气泡');
    assert.ok(!block.includes('is-codex-timeline'), '不得复活上一轮被回滚的作用域');
    // P2-6b 运行态/展开态：按类型分化的扁平语义轨迹
    assert.match(block, /\.msg-row\.assistant\.agent-live/, '运行态必须有 agent-live 作用域');
    assert.match(block, /\[data-turn-process="text"\]/, '过程正文须有专属语义选择器');
    assert.match(block, /content: '◇'/, '思考前缀 ◇');
    assert.match(block, /content: '\$'/, '工具前缀 $');
    assert.match(block, /content: '▸'/, '子代理前缀 ▸');
    assert.ok(!block.includes('content: \'│\''),
        '本实现选用 2px 细引导线而非字符竖线（设计决策，非「竞品不用」：Codex render.rs : EXEC_DISPLAY_LAYOUT 确有 "  │ " 用于多行命令续行）');
    // code review 修复：展开态内部层级也必须扁平，不能只抹直接子级
    assert.match(block, /\[data-turn-process="batch"\] \.batch-tool-items > \.tool-card/,
        '批次组内的子工具卡必须一并去卡片化（用户报「展开后还是卡片」的根因）');
    assert.match(block, /\.tool-card-body[\s\S]{0,400}border-top: 0/,
        '卡体自身的分隔线也要抹平');
});

/* ===== code review 回归（本轮新增） ===== */

test('★ 重跑折叠不得覆盖用户主动展开态，且 aria-expanded 与实际状态同步', () => {
    const b = bubble([
        { cls: ['thinking-block'] }, { cls: ['tool-card'] },
        { cls: ['md-content'], text: '最终正文' }
    ]);
    assert.equal(api.compactBubble(b, {}), true);
    const toggle = b.querySelector('.turn-compact-toggle');
    assert.ok(toggle);
    toggle.click();   // 用户点开
    assert.ok(b._classes.has('turn-compact-open'), '点击后展开');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    // 模拟 prepend / 回放重放再次调用同一轮
    assert.equal(api.compactBubble(b, {}), true);
    assert.ok(b._classes.has('turn-compact-open'), '重跑后仍保持用户展开态');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'aria 不得与实际可见性相反');
    assert.equal(b.querySelectorAll('.turn-compact-toggle').length, 1, '仍不重复插按钮');
});

test('★ 摘要按钮记录 stats 供语言切换重译（refreshTurnCompact 幂等、不改折叠态）', () => {
    const b = bubble([
        { cls: ['tool-card'] }, { cls: ['tool-card'] },
        { cls: ['md-content'], text: '正文' }
    ]);
    api.compactBubble(b, {});
    const toggle = b.querySelector('.turn-compact-toggle');
    const raw = toggle.getAttribute('data-turn-compact-stats');
    assert.ok(raw, '必须记录统计维度而非写死的文案');
    assert.deepEqual(JSON.parse(raw), { tools: 2, thinking: 0, agents: 0, texts: 0 });
    assert.equal(toggle.textContent, '已完成 · 2 次工具调用');
    // 切成英文翻译函数重译
    api.refreshTurnCompact(b, (k) => ({ 'chat.turn_tools': 'tool calls' }[k] || k));
    assert.equal(toggle.textContent, '已完成 · 2 tool calls', '新语言生效');
    assert.equal(b.querySelectorAll('.turn-compact-toggle').length, 1, '重译不插按钮');
    assert.equal(b.querySelectorAll('[data-turn-process]').length, 2, '重译不动过程行标记');
});

test('★ clearTurnCompact 完整回退：按钮 / 标记 / 展开类三者全清', () => {
    const b = bubble([
        { cls: ['thinking-block'] }, { cls: ['md-content'], text: '正文' }
    ]);
    api.compactBubble(b, {});
    b.querySelector('.turn-compact-toggle').click();
    assert.ok(b._classes.has('turn-compact-open'));
    api.clearTurnCompact(b);
    assert.equal(b.querySelectorAll('.turn-compact-toggle').length, 0);
    assert.equal(b.querySelectorAll('[data-turn-process]').length, 0);
    assert.ok(!b._classes.has('turn-compact-open'), '展开类一并清掉，避免残留悬空样式');
});

test('★ 关掉偏好后回放接线调用 clearTurnCompact（静态接线守护）', () => {
    const fs2 = require('fs');
    const hist = fs2.readFileSync(path.join(__dirname, '..', 'ui', 'js', 'app-history.js'), 'utf8');
    const stream = fs2.readFileSync(path.join(__dirname, '..', 'ui', 'js', 'app-streaming.js'), 'utf8');
    assert.match(hist, /tcApi && tcOff[\s\S]{0,300}clearTurnCompact\(realContainer\)/,
        '回放路径关开关必须撤销已渲染折叠');
    assert.match(stream, /tcApi && tcOff[\s\S]{0,300}clearTurnCompact\(liveBubbleOff\)/,
        '实时收口路径同样必须撤销');
});

/* 小工具：从 process 节点数组取 buildSummary 结果（测试侧复用生产纯函数） */
function buildProcessStats(processEls) {
    return api.buildSummary(processEls);
}

/* 回归：用户报「折叠展开的时候内容显示到上面去了」（两轮）。
    摘要行是 accordion 的【盖子】：必须位于过程组【最前】，展开时过程内容在盖子
    下方【向下】展开（WorkBuddy「已完成 14s ›」同向）。
    两次错位史：① 旧实现找「第一个有文本的 md-content」命中过程正文；
    ② 上一轮改成插在【最终正文】之前 → 盖子落到过程组【尾部】，展开后全部过程行
    显示在盖子上方 = 用户截图现象。
    258f0a0 连续区间重构后，本函数收紧为四条不变量：
      ① toggle 之前无任何【可见】节点（toggle 必须是气泡第一个直接子节点）；
      ② 所有 [data-turn-process] 节点构成【连续 DOM 区间】（中间不得夹无标记节点）；
      ③ 最终正文（唯一无标记且有文本的 .md-content）之后不得存在任何过程行；
      ④ 盖子紧贴第一个过程行，展开后过程行全部在盖子下方。 */
    function assertLidOnTop(b, toggle) {
    const kids = b.children;
    const idxToggle = kids.indexOf(toggle);
    assert.ok(idxToggle >= 0, '应存在摘要按钮');
    // ① toggle 之前无任何可见节点：收紧为 index 0（旧版只查 [data-turn-process]，
    //    页脚/未知块/缝合搬进来的杂散节点都能藏在 toggle 前面 = 「toggle 夹中间」）。
    assert.equal(idxToggle, 0, 'toggle 之前不得有任何可见节点（盖子必须是气泡首个直接子节点）');
        
    const marked = [];
    for (let i = 0; i < kids.length; i++) {
        if (kids[i].getAttribute('data-turn-process') !== null) marked.push(i);
    }
    assert.ok(marked.length > 0, '应有被折叠的过程行');
    // ② process 连续区间：首尾之间不得夹任何无标记节点
    for (let i = marked[0]; i <= marked[marked.length - 1]; i++) {
        assert.notEqual(kids[i].getAttribute('data-turn-process'), null,
            '过程行必须是连续 DOM 区间，第 ' + i + ' 个节点夹在区间中间');
    }
    assert.equal(marked[0], idxToggle + 1, '盖子必须紧贴第一个过程行');
    // ③ 最终正文之后无过程行：最后一个带标记节点之后不得再出现 [data-turn-process]
    const finalIdx = (() => {
        for (let i = kids.length - 1; i >= 0; i--) {
            if (kids[i]._classes.has('md-content') && (kids[i].textContent || '').trim()) return i;
        }
        return -1;
    })();
    assert.ok(finalIdx >= 0, '应存在最终正文');
    assert.ok(marked[marked.length - 1] < finalIdx,
        '最终正文之后不得残留任何过程行（旧 j > lastTextIdx keep 分支缺陷）');
    return idxToggle;
}

test('★ 摘要盖子在过程组最前：展开内容向下展开，不得显示到上面', () => {
    const b = bubble([
        { cls: ['md-content'], text: '过程说明：我先看一下目录' },
        { cls: ['tool-card'] },
        { cls: ['thinking-block'] },
        { cls: ['md-content'], text: 'FINAL-ANSWER 已优化完成' },
        { cls: ['msg-actions'] }
    ]);
    const kids0 = b.children.slice();
    const finalText = kids0[3];
    const processText = kids0[0];
    assert.equal(api.compactBubble(b, {}), true);
    const toggle = b.querySelector('.turn-compact-toggle');
    const idxToggle = assertLidOnTop(b, toggle);
    assert.equal(b.children[idxToggle + 1], processText, '盖子必须紧贴第一个过程行');
    assert.ok(b.children.indexOf(finalText) > b.children.indexOf(processText),
        '最终正文必须在过程行之后');
    assert.equal(finalText.getAttribute('data-turn-process'), null, '最终正文不得被折叠');
    assert.ok(processText.getAttribute('data-turn-process'), '过程正文应被折叠');
    // 展开态顺序：盖子 → 过程行 → 最终正文（模拟用户点击后的视觉顺序）
    toggle.click();
    assert.ok(b._classes.has('turn-compact-open'));
    assertLidOnTop(b, toggle);
});

test('★ 只有一段正文时盖子同样在过程组最前（anchor 退化回归保护）', () => {
    const b = bubble([
        { cls: ['tool-card'] },
        { cls: ['md-content'], text: '唯一的最终答案' }
    ]);
    const finalText = b.children[1];
    api.compactBubble(b, {});
    const toggle = b.querySelector('.turn-compact-toggle');
    assertLidOnTop(b, toggle);
    assert.equal(b.children.indexOf(toggle), 0, '盖子在气泡首位（过程组最前）');
    assert.ok(b.children.indexOf(finalText) > b.children.indexOf(toggle));
});

test('★ 运行态样式接线：legacy 历史行摘 agent-live、resume 末轮补挂（静态守护）', () => {
    const hist = fs.readFileSync(path.join(__dirname, '..', 'ui', 'js', 'app-history.js'), 'utf8');
    // B7：legacy 回退路径从不置 _replaying（门禁语义），ensureAssistantBubble 会给历史行
    // 挂上「本轮正在跑」样式且无人摘除 —— loadDone 必须整批摘掉。
    assert.match(hist, /querySelectorAll\('\.msg-row\.assistant\.agent-live'\)/,
        'legacy loadDone 必须摘除历史行的 agent-live');
    assert.match(hist, /classList\.remove\('agent-live'\)/, '摘除必须真调用 remove');
    // B8：回放 resume 的进行中末轮建于 _replaying 期（不挂类），恢复后实时帧续写同一行
    // 且不再重建 —— replayDoneCore 必须补挂，否则该轮实时过程行失去扁平轨迹样式。
    // 逐字钉住条件行：宽松「两片段邻近」断言会被 `if (false && ...)` 前缀绕过
    // （2026-11 变异 M4 实测 SURVIVED 后收紧）。
    assert.match(hist, /if \(resumeRow && resumeRow\.classList\) resumeRow\.classList\.add\('agent-live'\);/,
        'resume 分支必须给末轮行补挂 agent-live');
});

test('★ 缝合搬移后重跑折叠：盖子必须归位到过程组最前（不得留在组中部）', () => {
    // 模拟 app-history.js stitchPrependedRunRows：被删行气泡的内容子节点（含已插好的盖子）
    // 被搬进存活行气泡中部。重跑 compactBubble 后盖子必须重新紧贴第一个过程行。
    const b = bubble([
        { cls: ['md-content'], text: '过程A' },
        { cls: ['tool-card'] },
        { cls: ['md-content'], text: 'FINAL 最终答案' }
    ]);
    assert.equal(api.compactBubble(b, {}), true);
    const toggle = b.querySelector('.turn-compact-toggle');
    assert.equal(b.children.indexOf(toggle), 0);
    // 缝合：把盖子从首位搬到过程行之后（= 搬移循环的真实效果）
    const procA = b.children[1];
    b.insertBefore(toggle, b.children[3]); // 移到 FINAL 之前、过程组之后
    assert.ok(b.children.indexOf(toggle) > b.children.indexOf(procA), '前置条件：盖子已错位到组中部');
    // 重跑折叠（回放 prepend 后的统一折叠路径）
    assert.equal(api.compactBubble(b, {}), true);
    assertLidOnTop(b, toggle);
    assert.equal(b.children[b.children.indexOf(toggle) + 1], procA, '归位后盖子紧贴第一个过程行');
    // 同一个 toggle 实例（监听器保留）：点击仍能展开
    toggle.click();
    assert.ok(b._classes.has('turn-compact-open'));
});

/* ===== 258f0a0 连续区间重构契约（本轮新增） ===== */

test('★ 反例：最终正文之后还有 tool-card 必须收进过程区并重排到正文之前', () => {
    // 旧实现 classifyChildren 的 `j > lastTextIdx ⇒ keep` 分支会把这个过程行留在
    // 摘要下方（用户看到「下方散着 6+ 行」）。新实现按连续区间分类 + 目标顺序重排。
    const b = bubble([
        { cls: ['thinking-block'] },
        { cls: ['md-content'], text: 'FINAL 最终答案' },
        { cls: ['tool-card'], text: '尾部过程卡' },
        { cls: ['msg-actions'] }
    ]);
    const finalText = b.children[1];
    const tailCard = b.children[2];
    const d = api.classifyChildren(b.children);
    assert.ok(d, '应有折叠决策');
    assert.ok(d.process.includes(tailCard), '最终正文之后的过程行必须归入 process');
    assert.equal(d.final, finalText, 'final 是唯一最终正文');
    assert.ok(!d.keep.includes(tailCard), '尾部过程卡不再 keep');

    assert.equal(api.compactBubble(b, {}), true);
    const toggle = b.querySelector('.turn-compact-toggle');
    assertLidOnTop(b, toggle);
    assert.ok(b.children.indexOf(tailCard) < b.children.indexOf(finalText),
        '重排后尾部过程卡必须回到最终正文之前');
    assert.equal(tailCard.getAttribute('data-turn-process'), 'tool');
    // 折叠态顺序：toggle → process(含尾部卡) → final → msg-actions
    assert.ok(b.children.indexOf(b.querySelector('.msg-actions') || b.children[3]) > b.children.indexOf(finalText),
        '底部元信息仍排在最终正文之后');
});

test('★ 白名单夹在过程行中间：重排到 final 之后且常驻可见，process 仍连续', () => {
    const b = bubble([
        { cls: ['thinking-block'] },
        { cls: ['hitl-card'], text: '需要确认' },
        { cls: ['tool-card'] },
        { cls: ['msg-trace'] },
        { cls: ['md-content'], text: '过程正文' },
        { cls: ['tool-card'] },
        { cls: ['md-content'], text: 'FINAL 最终答案' },
        { cls: ['msg-meta-row'] },
        { cls: ['msg-actions'] }
    ]);
    const hitl = b.children[1];
    const trace = b.children[3];
    const finalText = b.children[6];
    const d = api.classifyChildren(b.children);
    assert.ok(d);
    assert.ok(d.keep.includes(hitl) && d.keep.includes(trace), '白名单不进 process');
    assert.ok(d.tail.includes(hitl) && d.tail.includes(trace), '白名单进入 tail');
    assert.equal(d.final, finalText);
    // 过程行 = thinking + 2 tool-card + 过程正文 = 4（连续、原相对顺序）
    assert.equal(d.process.length, 4);

    assert.equal(api.compactBubble(b, {}), true);
    const toggle = b.querySelector('.turn-compact-toggle');
    assertLidOnTop(b, toggle);
    assert.ok(b.children.indexOf(hitl) > b.children.indexOf(finalText), 'HITL 卡重排到最终正文之后');
    assert.ok(b.children.indexOf(trace) > b.children.indexOf(finalText), 'trace 徽标重排到最终正文之后');
    assert.equal(hitl.getAttribute('data-turn-process'), null, '白名单常驻可见（无折叠标记）');
    assert.equal(trace.getAttribute('data-turn-process'), null);
    // tail 内部保持原相对顺序
    assert.ok(b.children.indexOf(hitl) < b.children.indexOf(trace));
});

test('★ 多批次盖子与成员配对：有盖子时整轮摘要让位、不重排、配对不破', () => {
    const b = bubble([
        { cls: ['turn-batch-header'], attrs: { 'data-turn-process': '' } },
        { cls: ['tool-card'], attrs: { 'data-turn-batch': '1' } },
        { cls: ['tool-card'], attrs: { 'data-turn-batch': '1' } },
        { cls: ['hitl-card'], text: '批次间交互卡' },
        { cls: ['turn-batch-header'] },
        { cls: ['thinking-block'], attrs: { 'data-turn-batch': '1' } },
        { cls: ['md-content'], text: 'FINAL 最终答案' }
    ]);
    const h1 = b.children[0], h2 = b.children[4];
    const hitl = b.children[3];
    const finalText = b.children[6];
    // 先清掉第一个盖子上预置的标记（模拟真实运行：标记由 compactBubble 统一打）
    h1.removeAttribute('data-turn-process');
    const d = api.classifyChildren(b.children);
    assert.ok(d, '纯分类仍有决策（盖子是过程行）');
    assert.ok(d.process.includes(h1) && d.process.includes(h2), '两个盖子都进过程区');
    /* 【Qoder 多折叠组让位契约】气泡内已有批次盖子 ⇒ 不叠第二层整轮摘要：
       返回 false、不建 toggle、不重排（HITL 一级行留在两组之间 = Qoder 形态）。 */
    assert.equal(api.compactBubble(b, {}), false, '有批次盖子时整轮摘要让位');
    assert.equal(b.querySelector('.turn-compact-toggle'), null, '不得建整轮摘要盖子');
    const kids = b.children;
    // 模拟 app-turn-batch.js membersOf：盖子之后、下一个盖子之前的 data-turn-batch 成员
    const membersOf = (h) => {
        const out = [];
        const i0 = kids.indexOf(h);
        for (let i = i0 + 1; i < kids.length; i++) {
            if (kids[i]._classes.has('turn-batch-header')) break;
            if (kids[i].getAttribute('data-turn-batch') === '1') out.push(kids[i]);
        }
        return out;
    };
    assert.equal(membersOf(h1).length, 2, '第一批 2 个成员仍紧跟其盖子');
    assert.equal(membersOf(h2).length, 1, '第二批 1 个成员仍紧跟其盖子');
    assert.ok(kids.indexOf(hitl) < kids.indexOf(finalText), 'HITL 一级行原位常驻（不被重排）');
});

test('★ 缝合搬移 + 多批次：让位契约下不重排，盖子/成员兄弟区间不破', () => {
    const b = bubble([
        { cls: ['turn-batch-header'] },
        { cls: ['tool-card'], attrs: { 'data-turn-batch': '1' } },
        { cls: ['md-content'], text: 'FINAL 最终答案' },
        { cls: ['msg-actions'] }
    ]);
    const h = b.children[0];
    const member = b.children[1];
    const meta = b.children[3];
    assert.equal(api.compactBubble(b, {}), false, '有盖子时让位');
    // 模拟 stitchPrependedRunRows：把外来节点（页脚）搬进成员区中部
    b.insertBefore(meta, member);
    assert.equal(b.children.indexOf(meta), 1, '前置条件：外来节点已夹入批次区');
    assert.equal(api.compactBubble(b, {}), false, '缝合后重跑仍让位');
    assert.equal(b.children.indexOf(h), 0, '盖子不被搬移');
    assert.equal(b.children[2], member, '成员仍紧跟盖子（外来节点按属性跳过）');
    const membersOf = (hd) => {
        const out = [];
        for (let i = b.children.indexOf(hd) + 1; i < b.children.length; i++) {
            if (b.children[i]._classes.has('turn-batch-header')) break;
            if (b.children[i].getAttribute('data-turn-batch') === '1') out.push(b.children[i]);
        }
        return out;
    };
    assert.deepEqual(membersOf(h), [member], 'membersOf 配对不破');
});


/* ===== 智能体卡折叠契约（2026-11 用户拍板「最终态折叠」） ===== */
/* 未结束态（运行中 / 回放让位 / 缝合重跑）：智能体卡是常驻锚点 —— 不进过程区、
   不打折叠标记、保持原始时序位置（历史报障「智能体展示每次都在消息最后」的防线）。
   结束态（ended，finishStream 真收口 / 历史回放收尾）：智能体卡与工具/思考一样
   是过程证据，归入 process 折叠 —— 最终态只留最终正文（用户报障「最终态会把
   智能体全都放正文顶部展示」的修复）。 */
test('★ 未结束态：智能体卡常驻锚点 —— 不进过程区、不打标记、保持原始时序位置', () => {
    const b = bubble([
        { cls: ['thinking-block'] },
        { cls: ['tool-card'] },
        { cls: ['agent-card'], text: 'Explore · 子 Agent 已完成 185s' },
        { cls: ['md-content'], text: 'FINAL 最终答案' },
        { cls: ['msg-actions'] }
    ]);
    const agent = b.children[2];
    const finalText = b.children[3];
    const d = api.classifyChildren(b.children);
    assert.ok(d, '工具/思考仍可折叠，折叠决策应存在');
    assert.ok(!d.process.includes(agent), '未结束态智能体卡不得进过程区（锚点常驻）');
    assert.ok(d.keep.includes(agent), '未结束态智能体卡常驻可见');
    assert.ok(!d.tail.includes(agent), '智能体卡是锚点，不进 tail（不得被搬到最终正文之后）');
    assert.equal(d.final, finalText);
    assert.ok(!d.process.includes(finalText), '最终正文不得被折叠');

    assert.equal(api.compactBubble(b, {}), true);
    assert.equal(agent.getAttribute('data-turn-process'), null, '未结束态智能体卡绝不带 data-turn-process 标记');
    assert.ok(b.children.indexOf(agent) < b.children.indexOf(finalText),
        'final 之前的智能体卡保持原时序位置（不被重排到最终正文之后）');
    assert.equal(b.children[0]._classes.has('turn-compact-toggle'), true, 'toggle 仍在最前');
});

test('★ 最终态折叠：智能体卡归过程区折叠，最终态只留最终正文（用户拍板）', () => {
    // 用户报障场景：结束态智能体卡堆在正文顶部展示 —— 修复后必须随摘要收起
    const b = bubble([
        { cls: ['thinking-block'] },
        { cls: ['tool-card'] },
        { cls: ['agent-card'], text: 'Explore · 子 Agent 已完成 185s' },
        { cls: ['tool-card'] },
        { cls: ['agent-card'], text: 'general · 子 Agent 已完成 32s' },
        { cls: ['md-content'], text: 'FINAL 最终答案' },
        { cls: ['msg-actions'] }
    ]);
    const agent1 = b.children[2];
    const agent2 = b.children[4];
    const finalText = b.children[5];

    /* ended=true：智能体卡必须归 process（而不是 keep 常驻） */
    const d = api.classifyChildren(b.children, b, { ended: true });
    assert.ok(d, '结束态折叠决策应存在');
    assert.ok(d.process.includes(agent1) && d.process.includes(agent2),
        '最终态智能体卡归过程区（折叠除最终正文外其他都折叠）');
    assert.ok(!d.keep.includes(agent1) && !d.keep.includes(agent2), '最终态智能体卡不再常驻');
    assert.equal(d.final, finalText);

    assert.equal(api.compactBubble(b, { ended: true }), true, '结束态必须折叠');
    assert.equal(agent1.getAttribute('data-turn-process'), 'agent', '智能体卡带折叠标记');
    assert.equal(agent2.getAttribute('data-turn-process'), 'agent', '智能体卡带折叠标记');
    assert.equal(finalText.getAttribute('data-turn-process'), null, '最终正文保持可见');
    /* 摘要计数：agents 计入「N 次子代理」 */
    const raw = b.querySelector('.turn-compact-toggle').getAttribute('data-turn-compact-stats');
    assert.deepEqual(JSON.parse(raw), { tools: 2, thinking: 1, agents: 2, texts: 0 });
    assert.match(b.querySelector('.turn-compact-toggle').textContent, /2 次子代理/);
});

test('★ 最终态折叠：final 之后的智能体卡同样收起，不留正文之后的常驻行', () => {
    const b = bubble([
        { cls: ['tool-card'] },
        { cls: ['md-content'], text: '答案' },
        { cls: ['agent-card'], text: '收尾子代理' },
        { cls: ['msg-actions'] }
    ]);
    const agent = b.children[2];
    const answer = b.children[1];
    const d = api.classifyChildren(b.children, b, { ended: true });
    assert.ok(d);
    assert.ok(d.process.includes(agent), 'final 之后的智能体卡在 ended 态同样归过程区');
    assert.equal(api.compactBubble(b, { ended: true }), true);
    assert.equal(agent.getAttribute('data-turn-process'), 'agent');
    assert.equal(b.children[b.children.length - 2], answer, '最终正文是最后一个可见内容行');
});

test('★ 最终态无正文轮：智能体卡随纯工具轮一起折成一行摘要', () => {
    const b = bubble([
        { cls: ['tool-card'] },
        { cls: ['agent-card'], text: '子代理' },
        { cls: ['md-content'], text: '  ' }
    ]);
    const meta = el('div', ['msg-meta-row']);
    const trace = el('span', ['msg-trace']);
    trace.setAttribute('data-turn-status', 'done');
    meta.appendChild(trace);
    b.appendChild(meta);
    assert.equal(api.compactBubble(b, { ended: true }), true, '无正文成功轮结束态折叠');
    const agent = b.children.find(n => n._classes.has('agent-card'));
    assert.ok(agent, '智能体卡节点存在');
    assert.equal(agent.getAttribute('data-turn-process'), 'agent', '无正文轮的智能体卡也折叠');
});

test('★ 智能体卡不参与摘要计数（未结束态锚点）：摘要只统计工具/思考', () => {
    const b = bubble([
        { cls: ['tool-card'] },
        { cls: ['agent-card'], text: '子 Agent' },
        { cls: ['md-content'], text: '答案' }
    ]);
    const d = api.classifyChildren(b.children);
    assert.ok(d);
    const stats = api.buildSummary(d.process);
    assert.equal(stats.agents, 0, '未结束态智能体不进 process ⇒ 摘要 agents 计数为 0');
    assert.equal(stats.tools, 1);
});

/* ===== 折叠标头字号对齐（用户 2026-11 报「标头的字比下面的字小得多」） =====
   回放最终折叠态的摘要行 .turn-compact-toggle 基础是 P2-6 的 12px/1.5，而
   Qoder 对齐层已把过程行 / 正文 / 批次组头统一到 13px/1.6 —— 摘要行孤零零
   小一档。⑬ 覆盖规则把它对齐到 13px/1.6、前缀 ▸ 同步放大。三份 UI 镜像必须
   同步（历史事故：镜像同步会把单侧修复冲掉），且覆盖规则必须排在基础之后。 */
test('★ 折叠标头字号：三份 UI 镜像都对齐到 13px/1.6，且覆盖规则层叠生效', () => {
    const repo = path.resolve(__dirname, '..', '..', '..');
    const mirrors = [
        path.join('gourd-work', 'desktop', 'ui', 'css', 'app.css'),
        path.join('gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'css', 'app.css'),
        path.join('gourd-ai-tauri', 'ui', 'css', 'app.css')
    ];
    const fix = '.turn-compact-toggle { font: 13px/1.6 var(--font-sans, inherit) !important; padding: 5px 10px !important; }';
    const prefix = '.turn-compact-toggle::before { font-size: 13px !important; }';
    for (const rel of mirrors) {
        const f = path.join(repo, rel);
        assert.ok(fs.existsSync(f), 'UI 镜像缺失: ' + rel);
        const css = fs.readFileSync(f, 'utf8');
        const base = css.indexOf('font: 12px/1.5');
        assert.ok(base > 0, rel + ' 缺 12px/1.5 基础规则');
        assert.ok(css.lastIndexOf(fix) > base,
            rel + ' 13px 覆盖规则必须排在 12px 基础之后，否则层叠失效、字号仍偏小');
        assert.ok(css.lastIndexOf(prefix) > base, rel + ' 前缀 ▸ 必须同步放大到 13px');
        let bal = 0, ok = true;
        for (const ch of css) {
            if (ch === '{') bal++;
            else if (ch === '}') { bal--; if (bal < 0) ok = false; }
        }
        assert.ok(ok && bal === 0, rel + ' CSS 花括号不平衡（追加覆盖层破坏了结构）');
    }
});

/* ===== 任务结束态自动折叠（用户 2026-11 报「只有加载历史消息才会折叠」） =====
    真因：finishStream 有调 compactBubble，但旧版「有批次组头一律让位」把 live
    收口短路；回放不建批次组头 ⇒ 只有回放能折。用户拍板：真结束时与回放一致，
    折成「一行摘要 + 最终正文」，且点开摘要后保留运行态内部批次折叠。 */
const MIRRORS = [
    path.join('gourd-work', 'desktop', 'ui', 'css', 'app.css'),
    path.join('gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'css', 'app.css'),
    path.join('gourd-ai-tauri', 'ui', 'css', 'app.css')
];

test('★ 结束态：有批次组头也折成一行摘要 + 最终正文，组头/成员配对不破', () => {
    // 模拟 live 收口后的气泡：两个批次组 + 成员 + 中间过程正文 + 最终正文
    const b = bubble([
        { cls: ['turn-batch-header'], attrs: { 'data-batch-state': 'closed' } },
        { cls: ['tool-card'], attrs: { 'data-turn-batch': '1' } },
        { cls: ['md-content'], text: '中间过程叙述' },
        { cls: ['turn-batch-header'], attrs: { 'data-batch-state': 'closed' } },
        { cls: ['thinking-block'], attrs: { 'data-turn-batch': '1' } },
        { cls: ['md-content'], text: 'FINAL 最终答案' },
        { cls: ['msg-actions'] }
    ]);
    const h1 = b.children[0], h2 = b.children[3];
    const c1 = b.children[1], c2 = b.children[4];
    const finalText = b.children[5];
    // 运行态收口给成员打上的折叠类（用户要求展开后仍保持）
    c1.classList.add('turn-batch-collapsed');
    c2.classList.add('turn-batch-collapsed');

    /* 未传 ended（运行态 / 回放 / 缝合重跑）⇒ 旧让位契约不变 */
    assert.equal(api.compactBubble(b, {}), false, '未结束态仍让位');
    assert.equal(b.querySelector('.turn-compact-toggle'), null);

    /* 传 ended（finishStream 真收口）⇒ 必须折叠 */
    assert.equal(api.compactBubble(b, { ended: true }), true, '结束态必须放行整轮折叠');
    const toggle = b.querySelector('.turn-compact-toggle');
    assert.ok(toggle, '插入一行整轮摘要');
    assert.equal(b.children[0], toggle, '摘要在气泡最前');
    assert.equal(toggle.textContent, '已完成 · 1 次工具调用 · 1 段思考 · 1 段过程');
    assert.equal(finalText.getAttribute('data-turn-process'), null, '最终正文保持可见');
    assert.equal(b.children[b.children.length - 2], finalText, '最终正文排在过程区之后');
    // 组头/成员都进过程区（带标记 ⇒ 折叠态由 CSS 隐藏），且原相对顺序不拆散
    [h1, h2, c1, c2, b.children[2]].forEach(n => {
        assert.ok(n.getAttribute('data-turn-process') !== null, '过程行必须带折叠标记');
    });
    assert.ok(b.children.indexOf(h1) < b.children.indexOf(c1) && b.children.indexOf(c1) < b.children.indexOf(h2));
    // 内部批次折叠态绝不被摘掉（用户补充约束）
    assert.ok(c1.classList.contains('turn-batch-collapsed') && c2.classList.contains('turn-batch-collapsed'),
        '成员折叠类不得被 compactBubble 摊开');
});

test('★ 结束态无正文成功轮也折叠；停止/挂起徽标仍不藏过程证据', () => {
    const mk = (status) => {
        const b = bubble([
            { cls: ['turn-batch-header'] },
            { cls: ['tool-card'], attrs: { 'data-turn-batch': '1' } },
            { cls: ['msg-meta-row'] }
        ]);
        if (status) {
            const trace = el('span', ['msg-trace']);
            trace.setAttribute('data-turn-status', status);
            b.children[2].appendChild(trace);
        }
        return b;
    };
    assert.equal(api.compactBubble(mk(null), { ended: true }), true, '纯工具轮结束也折成一行摘要');
    const stopped = mk('stopped');
    assert.equal(api.compactBubble(stopped, { ended: true }), false, 'stopped 轮保留全部过程证据');
    const fatal = mk('done');
    fatal.appendChild(el('div', ['err-bubble'], { text: '失败' }));
    assert.equal(api.compactBubble(fatal, { ended: true }), false, '失败证据块仍触发 FATAL 护栏');
});

test('★ 接线形状锁：finishStream 收口必须传 ended:true', () => {
    const f = path.join(__dirname, '..', 'ui', 'js', 'app-streaming.js');
    const src = fs.readFileSync(f, 'utf8');
    const iCall = src.indexOf('tcApi.compactBubble(liveBubble');
    assert.ok(iCall > 0, 'finishStream 必须调用 compactBubble');
    const call = src.slice(iCall, iCall + 400);
    assert.match(call, /ended:\s*true/, '真收口必须传 ended:true，否则组头让位会把折叠短路');
});

test('★ 展开态保留内部批次折叠：三份 CSS 镜像都不许强制摊平成员', () => {
    const repo = path.resolve(__dirname, '..', '..', '..');
    const rule = '.msg-bubble.turn-compact-open > [data-turn-process].turn-batch-collapsed { display: none !important; }';
    for (const rel of MIRRORS) {
        const css = fs.readFileSync(path.join(repo, rel), 'utf8');
        assert.ok(css.includes(rule), rel + ' 展开态必须保留批次折叠（display:none）');
        assert.doesNotMatch(css, /\.msg-bubble\.turn-compact-open > \[data-turn-process\]\.turn-batch-collapsed \{ display: block !important; \}/,
            rel + ' 旧摊平规则会抹掉运行态内部批次折叠');
    }
});

/* 【2026-11 最终态折叠 · 用户报障「最终态会把智能体全都放正文顶部展示」】
   根因之一是 ⑨ 块 `.msg-bubble > [data-turn-process].agent-card { display:block !important }`
   强制智能体卡穿透折叠隐藏。形状锁：三壳 CSS 都不得再出现该强制常驻规则，
   否则最终态智能体卡会全部堆在正文上方。 */
test('★ 最终态折叠：三份 CSS 镜像都不许强制智能体卡常驻穿透折叠', () => {
    const repo = path.resolve(__dirname, '..', '..', '..');
    for (const rel of MIRRORS) {
        const css = fs.readFileSync(path.join(repo, rel), 'utf8');
        assert.ok(!css.includes('[data-turn-process].agent-card { display: block !important; }'),
            rel + ' 不得强制带折叠标记的智能体卡常驻（最终态必须随摘要收起）');
        assert.ok(!css.includes('[data-turn-process].agent-card{ display: block !important; }'),
            rel + ' 同上（无空格变体）');
    }
});
