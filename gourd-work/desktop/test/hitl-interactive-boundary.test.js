/**
 * 契约测试：交互卡（待审批 HITL 卡 / 问答记录）是批次与整轮折叠的【边界】，
 * 既不进批次成员、也不进整轮 process，且保持原始时序位置（不动点锚）。
 *
 * 用户 2026-11 报障「只要展示 HITL 和智能体这两个，页面就会错乱；ask 有的时候也会」：
 *  · 待审批 HITL 卡带 .tool-card 类 → 旧实现被 noteProcessInsert 收进批次成员，
 *    批次收口时随 .turn-batch-collapsed 隐藏 = 审批按钮整块消失；
 *  · 问答记录 .qa-record 非过程行但也不是白名单 → 旧实现被 classifyChildren
 *    归入 process（隐藏）+ compactBubble 重排搬离原位 = 「页面错乱」观感；
 *  · 运行态扁平化 ① 的 border:0 !important 抹掉 .hitl-pending 警示边框。
 * 本文件把三条语义锁成契约：模块行为（假 DOM 真跑）+ CSS 形状 + 双镜像同步。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const desktop = path.join(__dirname, '..');
const repo = path.join(desktop, '..', '..');
const display = require(path.join(desktop, 'ui', 'js', 'app-turn-display.js'));

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

test('★ 待审批 HITL 卡不是批次成员：落 DOM 收口运行批次、自身不进成员区', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const t1 = el('div', ['tool-card']);
    b.insertBefore(t1, sess.currentBubbleEl);
    display.noteProcessInsert(sess, t1);
    const header = b.children[0];
    assert.ok(header._classes.has('turn-batch-header'), '首个工具卡应建运行盖子');
    assert.equal(header.getAttribute('data-batch-state'), 'running');

    // 待审批 HITL 卡（带 tool-card 类！）落 DOM
    const hitl = el('div', ['tool-card', 'hitl-pending', 'expanded']);
    b.insertBefore(hitl, sess.currentBubbleEl);
    display.noteProcessInsert(sess, hitl);

    assert.equal(hitl.getAttribute('data-turn-batch'), null, '审批卡不得带成员标记');
    assert.equal(header.getAttribute('data-batch-state'), 'closed', '审批卡是边界：旧批次必须收口');
    assert.ok(t1._classes.has('turn-batch-collapsed'), '旧成员随收口折叠');
    assert.ok(!hitl._classes.has('turn-batch-collapsed'), '审批卡自身绝不能被折叠隐藏');
});

test('★ 问答记录 qa-record 同口径：收口运行批次、自身常驻可见', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const t1 = el('div', ['tool-card']);
    b.insertBefore(t1, sess.currentBubbleEl);
    display.noteProcessInsert(sess, t1);
    const qa = el('div', ['qa-record']);
    b.insertBefore(qa, sess.currentBubbleEl);
    display.noteProcessInsert(sess, qa);
    assert.equal(qa.getAttribute('data-turn-batch'), null);
    assert.ok(!qa._classes.has('turn-batch-collapsed'));
    const header = b.children[0];
    assert.equal(header.getAttribute('data-batch-state'), 'closed');
});

test('★ 交互卡之后的过程行开新批次（多折叠组边界语义与智能体卡一致）', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const t1 = el('div', ['tool-card']);
    b.insertBefore(t1, sess.currentBubbleEl);
    display.noteProcessInsert(sess, t1);
    const hitl = el('div', ['tool-card', 'hitl-pending']);
    b.insertBefore(hitl, sess.currentBubbleEl);
    display.noteProcessInsert(sess, hitl);
    const t2 = el('div', ['tool-card']);
    b.insertBefore(t2, sess.currentBubbleEl);
    display.noteProcessInsert(sess, t2);
    const headers = b.children.filter(c => c._classes.has('turn-batch-header'));
    assert.equal(headers.length, 2, '交互卡前后应各一个批次盖子');
    assert.equal(t2.getAttribute('data-turn-batch'), '1', '交互卡后的工具卡归新批次');
    assert.equal(display.membersOf(headers[1]).length, 1);
});

test('★ 放行后的 HITL 卡回归过程行语义（摘掉 hitl-pending 即普通工具卡）', () => {
    const b = mkBubble();
    const sess = mkSess(b);
    const released = el('div', ['tool-card']);   // 已批准/拒绝：无 hitl-pending
    b.insertBefore(released, sess.currentBubbleEl);
    display.noteProcessInsert(sess, released);
    assert.equal(released.getAttribute('data-turn-batch'), '1', '放行卡是过程证据，可进批次');
});

test('★ 卡内穿透：子代理卡体内挂着待审批卡时，ended 态整卡不得进 process（P0）', () => {
    /* 用户报障「只要展示 hitl 和智能体这两个，页面就会错乱」的另一半根因：
       appendHitlCard 接管骨架卡分支的节点【可能在智能体卡内】（子代理派发 bash 等
       需授权工具）。classifyChildren 只看气泡直接子节点，ended 态 agent-card 归 process
       → CSS `.msg-bubble > [data-turn-process]{display:none!important}` 整卡连带子树隐藏
       → 卡内【等用户拍板】的审批按钮消失，任务永久卡死。
       挂起收尾 settleSteerTurnBoundary 与回放 applyTurnCompact 传的都是 ended:true，两路都中。 */
    const bubble = mkBubble();
    const tool = el('div', ['tool-card']);
    const agent = el('div', ['agent-card']);
    const body = el('div', ['agent-card-body']);
    const hitlInAgent = el('div', ['tool-card', 'hitl-pending', 'expanded']);
    const final = el('div', ['md-content']); final.textContent = '最终答案';
    agent.appendChild(body);
    body.appendChild(hitlInAgent);
    bubble.appendChild(tool); bubble.appendChild(agent); bubble.appendChild(final);

    const d = display.classifyChildren(bubble.children, bubble, { ended: true });
    assert.ok(d, '有最终正文应产出折叠决策');
    assert.ok(d.process.indexOf(agent) < 0,
        '卡内还有待审批卡时，智能体卡必须退回常驻锚点，不得进 process');
    assert.ok(d.keep.indexOf(agent) >= 0, '智能体卡应常驻可见');
    assert.ok(d.process.indexOf(tool) >= 0, '同轮的普通工具卡仍照常折叠');

    assert.ok(display.compactBubble(bubble, { ended: true }), '应产出整轮折叠');
    assert.equal(agent.getAttribute('data-turn-process'), null,
        '智能体卡不得被打过程标记（打了就被 display:none 整卡藏掉）');
    assert.equal(tool.getAttribute('data-turn-process'), 'tool', '普通工具卡照常打标记');
});

test('★ 卡内穿透例外会自动失效：放行后智能体卡回归最终态折叠', () => {
    /* 例外只认【待审批】：批准后 .hitl-pending 被摘除，智能体卡必须照用户拍板的
       「最终态折叠除正文外都折叠」归入 process，不得留下常驻残影。 */
    const bubble = mkBubble();
    const agent = el('div', ['agent-card']);
    const body = el('div', ['agent-card-body']);
    const released = el('div', ['tool-card']);      // 已放行：无 hitl-pending
    const final = el('div', ['md-content']); final.textContent = '答案';
    agent.appendChild(body); body.appendChild(released);
    bubble.appendChild(agent); bubble.appendChild(final);

    const d = display.classifyChildren(bubble.children, bubble, { ended: true });
    assert.ok(d.process.indexOf(agent) >= 0, '放行后智能体卡应归入 process 折叠');
});

test('★ classifyChildren：待审批卡 / 问答记录永不进 process 与 tail（不动点锚）', () => {
    const mk = (cls, txt) => { const n = el('div', cls); if (txt) n.textContent = txt; return n; };
    const tool = mk(['tool-card']);
    const hitl = mk(['tool-card', 'hitl-pending']);
    const qa = mk(['qa-record']);
    const final = mk(['md-content'], '最终答案');
    const children = [tool, hitl, qa, final];
    const d = display.classifyChildren(children, null, { ended: true });
    assert.ok(d, '有最终正文应产出折叠决策');
    assert.ok(d.process.indexOf(tool) >= 0, '普通工具卡仍是过程行');
    assert.ok(d.process.indexOf(hitl) < 0, '待审批卡不得进 process（否则被折叠隐藏）');
    assert.ok(d.process.indexOf(qa) < 0, '问答记录不得进 process');
    assert.ok(d.keep.indexOf(hitl) >= 0 && d.keep.indexOf(qa) >= 0, '二者必须常驻可见');
    assert.ok(d.tail.indexOf(hitl) < 0 && d.tail.indexOf(qa) < 0,
        '二者是时序不动点：不得被重排到 final 之后');
});

test('★ compactBubble 重排后交互卡保持原始时序位置（页面不错乱）', () => {
    const b = mkBubble();
    const tool = el('div', ['tool-card']);
    const hitl = el('div', ['tool-card', 'hitl-pending']);
    const qa = el('div', ['qa-record']);
    const final = el('div', ['md-content']); final.textContent = '答案';
    b.appendChild(tool); b.appendChild(hitl); b.appendChild(qa); b.appendChild(final);
    const ok = display.compactBubble(b, { ended: true });
    assert.ok(ok, '应产出整轮折叠');
    const order = b.children.filter(c => [tool, hitl, qa, final].indexOf(c) >= 0);
    assert.deepEqual(order, [tool, hitl, qa, final], '交互卡不得被搬离原位');
    assert.equal(hitl.getAttribute('data-turn-process'), null, '交互卡不得打过程标记');
    assert.equal(qa.getAttribute('data-turn-process'), null);
    assert.equal(tool.getAttribute('data-turn-process'), 'tool');
});

test('★ rebuildBatches：交互卡是历史重建的批次边界（前后各成一组）', () => {
    const b = mkBubble();
    const t1 = el('div', ['tool-card']);
    const hitl = el('div', ['tool-card', 'hitl-pending']);
    const t2 = el('div', ['tool-card']);
    const final = el('div', ['md-content']); final.textContent = 'x';
    b.appendChild(t1); b.appendChild(hitl); b.appendChild(t2); b.appendChild(final);
    const built = display.rebuildBatches(b, {});
    assert.equal(built, 2, '交互卡前后各一个 closed 盖子');
    assert.equal(hitl.getAttribute('data-turn-batch'), null, '交互卡不是成员');
    const headers = b.children.filter(c => c._classes.has('turn-batch-header'));
    assert.ok(headers.every(h => h.getAttribute('data-batch-state') === 'closed'));
    assert.equal(display.membersOf(headers[0]).length, 1);
    assert.equal(display.membersOf(headers[1]).length, 1);
});

test('★ CSS 形状锁：两份镜像都恢复待审批卡整圈警示边框（①-b 规则）', () => {
    const files = [
        path.join(desktop, 'ui', 'css', 'app.css'),
        path.join(repo, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'css', 'app.css')
    ];
    for (const f of files) {
        const css = fs.readFileSync(f, 'utf8');
        assert.ok(css.includes('.msg-row.assistant.agent-live .msg-bubble > .tool-card.hitl-pending,'),
            '镜像缺运行态待审批卡边框恢复: ' + f);
        /* 【codereview 补】必须含【卡内】选择器：子代理派发需授权工具时审批卡落在
           agent-card-body 内，命中 app.css 的
           `.msg-row.assistant .msg-bubble > .agent-card .tool-card { border:0 !important }`
           （该规则不带 .agent-live，挂起收尾摘掉运行态类后依然生效）。
           只锁前两条选择器 = 用户报障的「hitl + 智能体」组合场景完全没被覆盖。 */
        assert.ok(css.includes('.msg-row.assistant .msg-bubble > .agent-card .tool-card.hitl-pending {'),
            '镜像缺【卡内】待审批卡边框恢复（①-b 第3条）: ' + f);
        // 取整个选择器列表 → 声明块，断言块内形状（选择器顺序变化不应误伤）
        const i = css.indexOf('.msg-row.assistant.agent-live .msg-bubble > .tool-card.hitl-pending,');
        assert.ok(i >= 0, '①-b 选择器列表起点缺失: ' + f);
        const declOpen = css.indexOf('{', i);
        const block = css.slice(declOpen, css.indexOf('}', declOpen));
        assert.ok(/border:\s*1px solid var\(--color-warning\) !important/.test(block), '边框必须 !important: ' + f);
        assert.ok(/border-radius:\s*6px !important/.test(block), '圆角必须恢复: ' + f);
        // 必须排在扁平化 ① 之后才能压过其 border:0 !important
        const flat = css.indexOf('.msg-row.assistant.agent-live .msg-bubble > .tool-card,');
        assert.ok(flat >= 0 && flat < i, '①-b 必须排在 ① 之后: ' + f);
        /* 【codereview 修复 + 断言加固】默认态警示色不得被覆盖。
           缺陷形态：:601 给出 var(--color-warning)，但后段（原 :3709）又声明了一条
           同特异性 0,2,0 的 `.tool-card.hitl-pending { border-color: var(--border-color) }`，
           按 CSS 层叠「同特异性后者胜」把警示色【抹成中性色】—— 与紧邻上方
           「审批不能弱化」的注释直接自相矛盾。默认态正是挂起收尾已摘 .agent-live、
           等用户拍板的主场景，此时审批卡与普通过程卡同形。
           修法是把那条覆盖规则【整条删除】（改成与 :601 同值只会留下冗余重复声明）。
           ★ 旧断言只检查「存在一处警示色」：:601 恒存在 → 无论后段怎么覆盖都恒绿
             （变异体 M5 SURVIVED）。现改为收集【全部】同选择器声明，断言唯一且为警示色，
             冗余与中性色覆盖两种形态都会红。 */
        const pendingDecl = /\.tool-card\.hitl-pending\s*\{\s*border-color:\s*([^;]+);/g;
        const decls = [];
        let pm;
        while ((pm = pendingDecl.exec(css)) !== null) decls.push(pm[1].trim());
        assert.equal(decls.length, 1,
            '默认态警示色声明应唯一（:601），多于 1 处即存在覆盖或冗余: ' +
            JSON.stringify(decls) + ' @ ' + f);
        assert.equal(decls[0], 'var(--color-warning)',
            '默认态必须是警示色，不得是中性色: ' + f);
        // 反向锁：中性色覆盖形态不得复活（哪怕只加一处，上面的 length 断言也会红）
        assert.ok(!/\.tool-card\.hitl-pending\s*\{\s*border-color:\s*var\(--border-color\)/.test(css),
            '默认态警示色被中性色覆盖: ' + f);
    }
});

test('★ 双镜像同步：交互卡判定 / 漏斗接线 / 接管接线（desktop 与 java static）', () => {
    const mirrors = [
        path.join(desktop, 'ui', 'js', 'app-message.js'),
        path.join(repo, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'js', 'app-message.js')
    ];
    const displays = [
        path.join(desktop, 'ui', 'js', 'app-turn-display.js'),
        path.join(repo, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'js', 'app-turn-display.js')
    ];
    for (const f of mirrors) {
        const src = fs.readFileSync(f, 'utf8');
        /* 漏斗接线按基线条件断言：java static 镜像的提交基线没有运行态批次漏斗
           （HEAD 的 app-message.js 无 noteBatchInsert，live 批次/整轮折叠只走回放路径），
           故「有漏斗则必须带交互卡分支」；desktop 基线有漏斗，无条件断言。 */
        const hasFunnel = src.includes('window.GourdTurnBatch.noteProcessInsert(sess, el)');
        if (f.indexOf('gourd-work') >= 0) {
            assert.ok(hasFunnel, 'desktop 基线必须有运行态批次漏斗: ' + f);
        }
        if (hasFunnel) {
            assert.ok(src.includes('function noteInteractiveInsert(sess, el) {'), '镜像缺交互卡接线 helper: ' + f);
            assert.ok(src.includes('window.GourdTurnBatch.isInteractiveCard(el)'), '漏斗缺交互卡分支: ' + f);
            assert.ok(src.includes('noteInteractiveInsert(sess, card);'), 'appendHitlCard 缺接管接线: ' + f);
        }
    }
    for (const f of displays) {
        /* 两份镜像行尾可能不同（CRLF/LF），字符串断言前先归一化 */
        const src = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
        assert.ok(src.includes('function isInteractiveCard(el) {'), '模块缺交互卡判定: ' + f);
        assert.ok(src.includes('isInteractiveCard: isInteractiveCard,'), '模块出口缺判定: ' + f);
        assert.ok(src.includes('if (isInteractiveCard(el)) {\n            closeBatchFor(bubble);'), '运行态缺边界分支: ' + f);
    }
});

/* ============================================================================
 * 【2026-11 codereview 新增】DOM 序列测试
 *
 * 上一轮测试的结构性缺陷（被 codereview 抓出）：所有断言都打【纯函数】
 * classifyChildren，或打【单次】compactBubble，从不跑「折叠 → 改类名 → 重算」
 * 的真实时序。于是 hasInteractiveCardInside 的「例外自动失效」只验证了
 * 纯函数会改判，却掩盖了 DOM 上的 data-turn-process 标记【根本没人重算】
 * —— 探针实测：放行后智能体卡永久常驻；失败回退后审批卡永久 display:none。
 * 本节把时序锁成契约，任何一侧回归都会红。
 * ========================================================================== */

function mkFoldScenario(opts) {
    opts = opts || {};
    const bubble = el('div', ['msg-bubble']);
    const t1 = el('div', ['tool-card']);                    // 同级过程行：保证 process 非空、折叠真发生
    const agent = el('div', ['agent-card']);
    const body = el('div', ['agent-card-body']);
    const hitl = el('div', ['tool-card'].concat(opts.pending === false ? [] : ['hitl-pending', 'expanded']));
    const fin = el('div', ['md-content']); fin.textContent = '最终答案';
    agent.appendChild(body); body.appendChild(hitl);
    bubble.appendChild(t1); bubble.appendChild(agent); bubble.appendChild(fin);
    return { bubble, t1, agent, body, hitl, fin };
}

test('★ DOM 序列·方向1：摘除 hitl-pending 后重算，宿主智能体卡必须重新折叠', () => {
    /* 用户批准 / 拒绝 / hitl_released 放行：例外失效 → 该轮应回到「最终态全折叠」，
       否则智能体卡永久常驻，与同轮其余过程卡形态分叉（实时不折、刷新走回放才折）。 */
    const s = mkFoldScenario();
    assert.ok(display.compactBubble(s.bubble, { ended: true }), '挂起收尾应产出整轮折叠');
    assert.equal(s.agent.getAttribute('data-turn-process'), null, '卡内有待审批卡：整卡必须常驻');

    s.hitl._classes.delete('hitl-pending');                 // removeClass('hitl-pending')
    assert.ok(display.refreshInteractiveBoundary(s.hitl, { ended: true }), '重算应生效');
    assert.equal(s.agent.getAttribute('data-turn-process'), 'agent', '例外失效后智能体卡应重新折叠');
    assert.equal(s.t1.getAttribute('data-turn-process'), 'tool', '同级过程卡照常折叠');
});

test('★ DOM 序列·方向2：加回 hitl-pending 后重算，宿主智能体卡必须恢复常驻（P0）', () => {
    /* 提交失败 restoreHitlCardPending / 接管位于已折叠智能体卡内的骨架卡：
       例外【重新成立】。旧实现 compactBubble 只 setAttribute 从不清除旧标记，
       于是智能体卡退回 keep 后标记仍残留 → CSS display:none 仍生效 →
       卡内那张【等用户拍板】的审批卡看不到也点不到 = 任务永久卡死。 */
    const s = mkFoldScenario({ pending: false });            // 起始无 pending：会被折进 process
    assert.ok(display.compactBubble(s.bubble, { ended: true }));
    assert.equal(s.agent.getAttribute('data-turn-process'), 'agent', '无待审批卡时智能体卡应被折叠');

    s.hitl._classes.add('hitl-pending');                     // addClass('hitl-pending')
    assert.ok(display.refreshInteractiveBoundary(s.hitl, { ended: true }), '重算应生效');
    assert.equal(s.agent.getAttribute('data-turn-process'), null,
        '例外重新成立后必须清掉旧标记，否则审批卡被 display:none 藏住 = 卡死');
});

test('★ compactBubble 幂等性：重跑后 DOM 状态必须【等于】本次决策（只加不删缺陷护栏）', () => {
    /* 反向夹逼：只测方向1会漏掉「残留旧标记」，只测方向2会漏掉「该折不折」。
       本条用「重跑 == 全新决策」的双向不变量同时夹住两侧。 */
    const run = (pendingAtFirst, pendingAtSecond) => {
        const s = mkFoldScenario({ pending: pendingAtFirst });
        display.compactBubble(s.bubble, { ended: true });
        if (pendingAtSecond) s.hitl._classes.add('hitl-pending'); else s.hitl._classes.delete('hitl-pending');
        display.compactBubble(s.bubble, { ended: true });    // 直接重跑（不经 refresh）
        return s.agent.getAttribute('data-turn-process');
    };
    const fresh = (pending) => {
        const s = mkFoldScenario({ pending });
        display.compactBubble(s.bubble, { ended: true });
        return s.agent.getAttribute('data-turn-process');
    };
    assert.equal(run(false, false), fresh(false), '恒 false：应等于全新决策');
    assert.equal(run(true, true), fresh(true), '恒 true：应等于全新决策');
    assert.equal(run(true, false), fresh(false), '摘除后应等于「无 pending」的全新决策');
    assert.equal(run(false, true), fresh(true), '加回后应等于「有 pending」的全新决策');
});

test('★ refreshInteractiveBoundary 保守门禁：未折叠气泡不得凭空插入折叠按钮', () => {
    /* 只对【已折叠过】的气泡重算：从未折叠的气泡重跑 compactBubble 会插一个
       turn-compact-toggle，属行为改变（普通新建审批卡场景），绝不引入。
       【codereview 修正断言强度】旧写法的气泡里只有 [交互卡, 正文]：交互卡恒进 keep
       → process 为空 → compactBubble 本就返回 false，门禁【根本没被行使】，
       删掉门禁测试也照样绿（变异体 SURVIVED）。现改为放一张【会进 process】的普通
       工具卡 + 正文，确保「若没有门禁，compactBubble 必然返回 true 并插入 toggle」，
       于是本条断言真正咬住门禁。 */
    const bubble = el('div', ['msg-bubble']);
    const tool = el('div', ['tool-card']);                 // 会进 process：无门禁时折叠必然发生
    const hitl = el('div', ['tool-card', 'hitl-pending']);
    const fin = el('div', ['md-content']); fin.textContent = '最终答案';
    bubble.appendChild(tool); bubble.appendChild(hitl); bubble.appendChild(fin);

    // 前置自检：证明这个场景确实「可折叠」，否则本条断言仍是空转
    const dec = display.classifyChildren(bubble.children, bubble, { ended: true });
    assert.ok(dec && dec.process.indexOf(tool) >= 0, '前置条件：普通工具卡应可进 process');
    assert.equal(bubble.querySelector('.turn-compact-toggle'), null, '前置条件：气泡尚未折叠');

    const before = bubble.children.length;
    assert.equal(display.refreshInteractiveBoundary(hitl, { ended: true }), false, '无 toggle 应直接返回 false');
    assert.equal(bubble.children.length, before, '不得插入任何节点');
    assert.equal(bubble.querySelector('.turn-compact-toggle'), null, '不得凭空插入折叠按钮');
    assert.equal(tool.getAttribute('data-turn-process'), null, '不得给过程行打折叠标记');

    // 反向对照：已折叠过的同一形态气泡，门禁放行、重算必须生效
    assert.ok(display.compactBubble(bubble, { ended: true }), '手动折叠应成功（证明门禁是唯一拦截者）');
    assert.ok(bubble.querySelector('.turn-compact-toggle'), '折叠后应存在 toggle');
    hitl._classes.delete('hitl-pending');
    assert.ok(display.refreshInteractiveBoundary(hitl, { ended: true }), '已折叠气泡必须放行重算');
});

test('★ refreshInteractiveBoundary 从卡内节点向上定位宿主气泡（入参是审批卡而非气泡）', () => {
    const s = mkFoldScenario();
    display.compactBubble(s.bubble, { ended: true });
    s.hitl._classes.delete('hitl-pending');
    // 传最内层节点，应逐层 parentNode 找到 .msg-bubble
    assert.ok(display.refreshInteractiveBoundary(s.hitl, { ended: true }));
    assert.equal(s.agent.getAttribute('data-turn-process'), 'agent');
    // 找不到宿主气泡时必须安全返回，绝不抛异常（主链路只留痕不阻断）
    const orphan = el('div', ['tool-card', 'hitl-pending']);
    assert.equal(display.refreshInteractiveBoundary(orphan, { ended: true }), false);
    assert.equal(display.refreshInteractiveBoundary(null, { ended: true }), false);
});

test('★ 双镜像同步：hitl-pending 每个增删点都必须接 refreshHitlFoldBoundary', () => {
    /* 【codereview 抓出的漏接】desktop 侧 restoreHitlCardPending 内部【重绑定】的
       approve/reject 处理器与 appendHitlCard 初始绑定是镜像关系（源码注释明写
       「两处如改一处必须同步另一处」），上一轮只接了初始绑定侧，漏了重绑定侧 2 处。
       本条按【计数】锁：接线点数量必须等于增删点数量，任何一侧漏接都会红。 */
    const mirrors = [
        path.join(desktop, 'ui', 'js', 'app-message.js'),
        path.join(repo, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'js', 'app-message.js')
    ];
    for (const f of mirrors) {
        const src = fs.readFileSync(f, 'utf8');
        if (!src.includes('function refreshHitlFoldBoundary(card) {')) {
            // java 侧基线无运行态批次漏斗，但 HITL 增删点与折叠模块同样存在，必须同样接线
            assert.ok(false, '镜像缺 refreshHitlFoldBoundary 定义: ' + f);
        }
        // 增删点：addClass/removeClass('hitl-pending...') 的全部出现
        const mutations = (src.match(/(?:addClass|removeClass)\('hitl-pending/g) || []);
        // 接线点：实际【调用】（带分号），排除 `function refreshHitlFoldBoundary(card) {` 定义行
        const wired = (src.match(/refreshHitlFoldBoundary\((?:card|releasedCards\[ri\])\);/g) || []);
        /* 计数口径：新建分支 `$('<div>').addClass('tool-card hitl-pending expanded')` 引号后
           紧跟 tool-card，【不匹配】上面的 mutations 正则，无需从计数中排除 —— 它是全新节点，
           接线由紧随 if(!card.parentNode) 之后的 refreshHitlFoldBoundary(card) 统一覆盖。
           于是增删点与接线点必须严格 1:1（各 7 处）：
             appendHitlCard 接管 / approve / reject / restore 加回 /
             restore 重绑定 approve / restore 重绑定 reject / releaseHitlCards 批量放行。
           任何一侧漏接都会红（上一轮正是漏了 restore 重绑定的 2 处镜像）。 */
        assert.equal(wired.length, mutations.length,
            `接线点数(${wired.length}) != hitl-pending 增删点数(${mutations.length})，存在漏接: ` + f);
        assert.equal(mutations.length, 7, '增删点总数应为 7: ' + f);
        // 放行路径必须【遍历后】统一重算（遍历中重排会把改类名与搬节点交织）
        assert.ok(src.includes('var releasedCards = [];'), 'releaseHitlCards 缺收集数组: ' + f);
        assert.ok(src.includes('for (var ri = 0; ri < releasedCards.length; ri++) refreshHitlFoldBoundary(releasedCards[ri]);'),
            'releaseHitlCards 缺遍历后批量重算: ' + f);
    }
});

test('★ noteBatchInsert 交互卡分支：宿主判定下放模块（卡内 agent-card-body 不得静默失效）', () => {
    /* 上一轮该分支只认 el.parentNode 为 .msg-bubble 才 closeBatchFor，否则提前 return：
       卡内待审批卡（子代理派发需授权工具）既不收口卡内 running 盖子、也落不到模块的
       边界分支 = 静默失效。模块 noteProcessInsert 的宿主白名单本就含 agent-card-body，
       故正确做法是整体下放，不再在 app-message.js 本地复刻宿主判定。 */
    const mirrors = [
        path.join(desktop, 'ui', 'js', 'app-message.js'),
        path.join(repo, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'js', 'app-message.js')
    ];
    const src = fs.readFileSync(mirrors[0], 'utf8');
    assert.ok(src.includes('window.GourdTurnBatch.noteProcessInsert(sess, el);'),
        '交互卡分支应下放模块 noteProcessInsert（含 agent-card-body 宿主白名单）');
    // 反向：不得再保留「只认 msg-bubble」的本地复刻（那正是漏判形态）
    const iStart = src.indexOf('if (window.GourdTurnBatch.isInteractiveCard');
    const iEnd = src.indexOf('if (el.classList.contains(\'agent-card\'))', iStart);
    const branch = src.slice(iStart, iEnd);
    assert.ok(!branch.includes("ib.classList.contains('msg-bubble')"),
        '交互卡分支仍残留「只认 msg-bubble」的本地宿主判定（卡内静默失效）');

    // 模块侧真跑：卡内待审批卡必须收口卡内 running 批次
    const body = el('div', ['agent-card-body']);
    const running = el('div', ['tool-card']);
    const hitl = el('div', ['tool-card', 'hitl-pending', 'expanded']);
    body.appendChild(running); body.appendChild(hitl);
    const sess = { currentBubbleEl: null, _replaying: false };
    display.noteProcessInsert(sess, running);
    const header = body.children[0];
    assert.ok(header && header._classes && header._classes.has('turn-batch-header'), '卡内应建运行盖子');
    assert.equal(header.getAttribute('data-batch-state'), 'running');
    display.noteProcessInsert(sess, hitl);                    // 边界分支
    assert.equal(hitl.getAttribute('data-turn-batch'), null, '卡内审批卡不得成为批次成员');
    assert.equal(header.getAttribute('data-batch-state'), 'closed', '卡内审批卡同样收口批次');
    assert.ok(!hitl._classes.has('turn-batch-collapsed'), '卡内审批卡绝不能被折叠隐藏');
    assert.ok(mirrors.every(f => fs.existsSync(f)), '镜像文件应存在');
});
