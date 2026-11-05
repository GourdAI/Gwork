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

const api = require(path.join(__dirname, '..', 'ui', 'js', 'app-turn-compact.js'));

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
   不变量：盖子之前不得存在任何 [data-turn-process] 行；最终正文在所有过程行之后。 */
function assertLidOnTop(b, toggle) {
    const kids = b.children;
    const idxToggle = kids.indexOf(toggle);
    assert.ok(idxToggle >= 0, '应存在摘要按钮');
    for (let i = 0; i < idxToggle; i++) {
        assert.equal(kids[i].getAttribute('data-turn-process'), null,
            '盖子之前不得出现过程行（否则展开时内容显示到上面去了）');
    }
    let seenProcess = false;
    for (let i = idxToggle + 1; i < kids.length; i++) {
        const isProc = kids[i].getAttribute('data-turn-process') !== null;
        if (isProc) seenProcess = true;
        else if (seenProcess && kids[i]._classes.has('md-content')) {
            // 过程组之后的 md-content 只允许是最终正文（无折叠标记）
            assert.equal(kids[i].getAttribute('data-turn-process'), null);
        }
    }
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
