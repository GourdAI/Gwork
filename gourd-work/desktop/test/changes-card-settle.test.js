/**
 * 契约测试：变更卡落位后的【轮级终态兜底】（2026-11 用户连环报障）。
 *
 * 用户原话：「任务都执行结束了，竟然还显示正在执行中的」「产物卡片应该放在
 * 最后面的啊，刚刚修改了下，还是有问题，导致折叠都不对」。
 *
 * 真因（真实帧日志 work-cec8d486：每轮 trace → done → file_changes(ready:true)）：
 * dispatchGateChunk 对 file_changes 直接 return，卡片由 app-file-changes.js 的
 * placeHostInBubble 裸插「页脚之前」；这一路径既不调 closeBatchFor，也不重跑
 * compactBubble。上一版只改了「插入漏斗越过 fch-host + compact tail 三档」，
 * 恰好没管这最后一帧 —— 只要 done 收口链被任一守卫跳过（stale-run / 恢复缓冲 /
 * liveFoldRow 为空 / 挂起边界），DOM 就永远停在截图里的坏形态：
 *   running 盖子（ticker 每秒累加「正在执行中 · 15min 5s」）
 *   → 变更卡压在思考与最终正文之间
 *   → 过程行未折叠（整轮摘要从未生成）。
 *
 * 修复：file_changes 只在 runSettled 为真时落卡，故「卡已落 DOM」是比 done
 * 更靠后的权威终态信号。positionCard → settleTurnAfterCard →
 * GourdTurnDisplay.settleChangesCard 兜底 closeBatchFor + compactBubble(ended:true)。
 *
 * 本文件用真模块 + 假 DOM 真跑，钉死截图形态一次性收敛为终态。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const UI = path.resolve(__dirname, '..', 'ui');
const api = require(path.join(UI, 'js', 'app-turn-display.js'));
const fchJs = fs.readFileSync(path.join(UI, 'js', 'app-file-changes.js'), 'utf8').replace(/^\uFEFF/, '');

/* 与 changes-card-order.test.js 同款极简假 DOM（补足 label/toggle/insertBefore） */
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
            toggle: (c) => { if (node._classes.has(c)) { node._classes.delete(c); return false; } node._classes.add(c); return true; }
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
        get childNodes() { return node.children; },
        get firstChild() { return node.children[0] || null; },
        get nextSibling() {
            if (!node.parentNode) return null;
            const sibs = node.parentNode.children;
            return sibs[sibs.indexOf(node) + 1] || null;
        },
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
        /* compactBubble 新建 toggle 时会绑 click（真实 DOM API）；桩不实现会让
           整轮折叠在 try/catch 里静默失败，正好掩盖本测试要钉的行为。 */
        addEventListener() {}
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
        function walk(n) {
            for (const c of n.children) {
                let hit = false;
                for (const w of want) if (c._classes.has(w)) hit = true;
                for (const w of wantAttr) if (c._attrs[w] !== undefined) hit = true;
                if (hit) out.push(c);
                walk(c);
            }
        }
        walk(root);
        return out;
    }
    return node;
}

/* compactBubble 会 document.createElement('button') 生成整轮折叠摘要；
   与 changes-card-order.test.js 同口径补最小 document 桩（其余逻辑全用假 DOM 真跑）。 */
global.document = global.document || { createElement: (tag) => el(tag, []) };

/* 截图形态：running 盖子 → 两行过程 → 变更卡（插在中间）→ 最终正文 → 页脚。
   注意 header 必须带 .turn-batch-label 子节点，closeBatchFor 的 setLabel 才生效。 */
function badBubble() {
    const b = el('div', ['msg-bubble']);
    const header = el('button', ['turn-batch-header']);
    header.setAttribute('data-batch-state', 'running');
    header.setAttribute('data-batch-start', String(Date.now() - 15 * 60 * 1000 - 5000));
    header.setAttribute('data-batch-open', 'true');
    const label = el('span', ['turn-batch-label']);
    label.textContent = '正在执行中 · 15min 5s';
    header.appendChild(label);

    const think = el('div', ['thinking-block']);
    think.setAttribute('data-turn-batch', '1');
    const tool = el('div', ['tool-card']);
    tool.setAttribute('data-turn-batch', '1');
    const host = el('div', ['fch-host']);
    host.appendChild(el('div', ['msg-run-changes-card']));
    const final = el('div', ['md-content'], { text: '这轮 codereview 发现并修复了 4 个真实问题' });
    const meta = el('div', ['msg-meta-row']);
    const actions = el('div', ['msg-actions']);
    [header, think, tool, host, final, meta, actions].forEach(n => b.appendChild(n));
    return { b, header, label, think, tool, host, final, meta, actions };
}

test('★ S1 settleChangesCard：残留 running 盖子定格 + 整轮折叠 + 变更卡钉底（截图形态真跑）', () => {
    const { b, header, label, host, final, meta, actions, think, tool } = badBubble();
    assert.equal(api.labelText(header), '正在执行中 · 15min 5s', '前置：running 文案与截图一致');
    assert.equal(api.settleChangesCard(b), true, '权威快照必须触发兜底');

    assert.equal(header.getAttribute('data-batch-state'), 'closed', 'running 盖子必须收口');
    assert.match(api.labelText(header), /执行工具 1 次/, '文案必须切成分类计数摘要');
    assert.doesNotMatch(label.textContent, /正在执行中/, 'ticker 下一秒也不再刷「正在执行中」');
    assert.ok(think.classList.contains('turn-batch-collapsed') && tool.classList.contains('turn-batch-collapsed'),
        '批次成员必须随收口折叠');

    const order = b.children.map(n => n.className);
    assert.ok(order.indexOf('turn-compact-toggle') >= 0, '必须补出整轮折叠摘要（此前从未生成）');
    assert.ok(order.indexOf('fch-host') > order.indexOf('md-content'), '变更卡必须在最终正文之后');
    assert.ok(order.indexOf('fch-host') < order.indexOf('msg-meta-row'), '变更卡必须在页脚之前');
    assert.ok(order.indexOf('msg-meta-row') < order.indexOf('msg-actions'), '页脚原序不动');
    assert.equal(final.getAttribute('data-turn-process'), null, '最终正文不得被标成过程行');

    /* 幂等：再跑一次不得重复插 toggle / 不许把用户手动展开的整轮重新收起 */
    const before = b.children.slice();
    assert.equal(api.settleChangesCard(b), false, '已有 toggle 时零改动');
    assert.deepEqual(b.children, before, '第二次调用零移动');
});

test('★ S2 回放/游离容器不得抢在 applyTurnCompact 之前折叠', () => {
    const { b, header } = badBubble();
    b.isConnected = false;
    b.closest = () => null;
    assert.equal(api.settleChangesCard(b), true, '游离容器仍允许收 running 盖子（纯属性变更）');
    assert.equal(header.getAttribute('data-batch-state'), 'closed', '残留 running 必须清掉');
    assert.equal(b.children.some(n => n.className === 'turn-compact-toggle'), false,
        '游离容器不得凭空生成整轮折叠（交给 app-history.js 统一收口）');
});

test('★ S3 接线锁：positionCard 落卡后必须调 settleTurnAfterCard；三镜像逐字一致', () => {
    assert.match(fchJs, /placeHostInBubble\(bubble, host\);[\s\S]{0,220}settleTurnAfterCard\(sess, runKey, bubble\)/,
        '卡片落位后必须触发轮级终态兜底');
    assert.match(fchJs, /sess\._replaying \|\| sess\._runSuspended \|\| sess\.isStreaming/,
        '回放/挂起/运行中不得误收口');
    /* 【2026-11-25 用户报「这个出来后，后续的工具执行啥的都不显示了」】
       真帧日志 work-mwur7bd8：done(seq=103420) 之后 80396 帧全属于下一个 run，
       旧 run 只剩 1 帧 file_changes。flushPendingRenders 会把所有历史卡重定位，
       旧卡重定位时 settleTurnAfterCard 若只判「旧 run 已收口」就放行，会在新 run
       正在跑工具时把当前气泡收口 + 整轮折叠 → 工具行 data-turn-process →
       CSS display:none。真浏览器 A/B 实测：旧行为 batchState=closed / oldTools
       =none/none；加活跃轮隔离后 running / block/block。 */
    assert.match(fchJs, /currentRun && currentRun !== String\(runKey\)\)\s*return/,
        '旧卡重定位时若会话已有其它活跃 run，必须跳过收口（保护在跑的工具）');
    assert.match(fchJs, /if \(!runSettled\(sess, runKey\)\) return;/,
        '必须按本卡片所属 run 逐轮判定终态，不能只看会话级 isStreaming');
    assert.match(fchJs, /settleChangesCard\(bubble\)/, '必须走统一折叠模块的兜底入口');
    assert.equal(typeof api.settleChangesCard, 'function', '出口面必须导出 settleChangesCard');

    const ROOT = path.resolve(__dirname, '..', '..', '..');
    /* gourd-ai-tauri 已随「桌面端统一 rust 内核」删除（7370119），不再是镜像目标 */
    const mirrors = [
        path.join(ROOT, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static')
    ];
    const read = p => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    for (const m of mirrors) {
        for (const f of ['js/app-file-changes.js', 'js/app-turn-display.js']) {
            assert.equal(read(path.join(UI, f)), read(path.join(m, f)), m + ' ' + f + ' 漂移');
        }
    }
});

/* ===== S7：活跃轮隔离行为级（2026-11-25 用户「产物卡出来后后续工具全不显示」）=====
   真帧日志 work-mwur7bd8：done(run-2dfe8c12) 之后 80396 帧全属于下一个 run，
   旧 run 只剩 1 帧 file_changes。flushPendingRenders 对【所有历史 runKey】
   无条件重跑 positionCard（i18n / 会话切换 / 对账回填）；旧卡重定位时若只判
   「旧 run 已收口」就放行，会在新 run 正跑工具时把当前气泡收口 + 整轮折叠
   → 工具行 data-turn-process → CSS display:none。真浏览器 A/B：旧行为
   batchState=closed / oldTools=none/none；加活跃轮隔离后 running/block/block。
   本用例抽取真实函数体真跑，钉死「活跃 run 与卡片 run 不一致时零收口」。 */
test('★ S7 活跃轮隔离：历史卡重定位不得收口正在跑工具的当前轮', () => {
    /* 从真实源码抽出 settleTurnAfterCard / runSettled 两段函数体（花括号配对） */
    function extract(name) {
        const start = fchJs.indexOf('function ' + name + '(');
        assert.ok(start >= 0, '源码必须含 ' + name);
        let depth = 0, open = -1;
        for (let i = start; i < fchJs.length; i++) {
            if (fchJs[i] === '{') { if (depth === 0) open = i; depth++; }
            else if (fchJs[i] === '}') { depth--; if (depth === 0) return fchJs.slice(start, i + 1); }
        }
        throw new Error(name + ' 花括号不配对');
    }
    const calls = { close: 0, settle: 0 };
    const fakeApi = {
        closeBatchFor: () => { calls.close++; },
        settleChangesCard: () => { calls.settle++; }
    };
    /* 最小桩：renderRoot 返回带 querySelectorAll 的对象，$(row).find 返回 [气泡] */
    const bubble = el('div', ['msg-bubble']);
    const row = el('div', ['msg-row']);
    const $ = () => ({ find: () => [bubble] });
    const renderRoot = () => ({ querySelectorAll: () => [row] });
    const run = new Function(
        'window', '$', 'renderRoot', 'document', 'attrValueEscape',
        extract('runSettled') + '\n' + extract('settleTurnAfterCard')
        + '\nreturn { runSettled, settleTurnAfterCard };'
    )({ GourdTurnDisplay: fakeApi }, $, renderRoot, undefined, (s) => String(s));

    /* ① 会话正在跑新 run（currentRunId=RUN-NEW），重定位旧卡 RUN-OLD：
       isStreaming=false（done 已收）、旧 run 已收口，但活跃轮不同 → 零收口。 */
    const sessNew = { isStreaming: false, currentRunId: 'RUN-NEW', activeRunId: 'RUN-NEW',
        _replaying: false, _runSuspended: false };
    calls.close = 0; calls.settle = 0;
    run.settleTurnAfterCard(sessNew, 'RUN-OLD', bubble);
    assert.equal(calls.close, 0, '活跃轮是别的 run 时，不得 closeBatchFor 当前气泡');
    assert.equal(calls.settle, 0, '活跃轮是别的 run 时，不得 settleChangesCard 当前气泡');

    /* ② 正常终态：活跃 run 就是本卡所属 run，且已收口 → 允许收口（S1 既有语义不回归） */
    const sessSelf = { isStreaming: false, currentRunId: 'RUN-OLD', activeRunId: '',
        _replaying: false, _runSuspended: false };
    calls.close = 0; calls.settle = 0;
    run.settleTurnAfterCard(sessSelf, 'RUN-OLD', bubble);
    assert.ok(calls.close > 0 && calls.settle > 0, '本轮真终态仍必须正常走收口链');

    /* ③ 会话仍在流式（新 run 的帧在跑）→ 第一道门禁即拦下 */
    const sessStreaming = { isStreaming: true, currentRunId: 'RUN-OLD', activeRunId: 'RUN-OLD',
        _replaying: false, _runSuspended: false };
    calls.close = 0; calls.settle = 0;
    run.settleTurnAfterCard(sessStreaming, 'RUN-OLD', bubble);
    assert.equal(calls.close + calls.settle, 0, 'isStreaming 时零收口');
});

/* ===== S4：Rust 版真机复现（2026-11-25）=====
   用户截图硬矛盾：摘要写「已完成 · 1 段思考」，屏幕上却平铺 4 段可见思考，
   产物卡夹在摘要与思考之间。真因 = Rust forwarder 在 run 结束后继续推后台
   子代理帧（core/src/server/mod.rs 的 post_run_tx 保活），done 的 compact 先
   生成 toggle，迟到帧插入时没有 data-turn-process 标记；卡片落位触发的
   settleChangesCard 旧护栏「有 toggle 一律不重跑」把自愈路径焊死。
   本用例真跑模块，钉死「卡片落位后迟到帧必须被收编 + 卡片必须回到正文之后」。 */
test('★ S4 Rust 后台迟到帧：已有 toggle 也必须脏检查重算（摘要计数/卡片钉底/展开态保留）', () => {
    const b = el('div', ['msg-bubble']);
    const header = el('button', ['turn-batch-header']);
    header.setAttribute('data-batch-state', 'running');
    header.setAttribute('data-batch-start', String(Date.now() - 1000));
    header.appendChild(el('span', ['turn-batch-label']));
    const think1 = el('div', ['thinking-block']);
    think1.setAttribute('data-turn-batch', '1');
    const final = el('div', ['md-content'], { text: '最终正文' });
    const meta = el('div', ['msg-meta-row']);
    const actions = el('div', ['msg-actions']);
    [header, think1, final, meta, actions].forEach(n => b.appendChild(n));

    // ① done 收口：compact 生成摘要（此时只有 1 段思考）
    assert.equal(api.compactBubble(b, { ended: true }), true, 'done 应先折成整轮摘要');
    const toggle = b.children.find(n => n.classList.contains('turn-compact-toggle'));
    assert.ok(toggle, '前置：toggle 已存在');
    assert.match(toggle.textContent, /1 段思考/, '前置：摘要只统计到 1 段思考');

    // ② Rust 特有：run 结束后后台帧继续推流，3 段思考插入页脚之前（未打标记）
    const late = [];
    for (let k = 0; k < 3; k++) {
        const n = el('div', ['thinking-block'], { text: 'late-' + k });
        late.push(n);
        b.insertBefore(n, meta);
    }
    // ③ file_changes 最后到达：宿主落在页脚之前
    const host = el('div', ['fch-host']);
    host.appendChild(el('div', ['msg-run-changes-card']));
    b.insertBefore(host, meta);

    // ④ 用户展开过摘要：重跑不得把它收回去
    b.classList.add('turn-compact-open');
    assert.equal(api.settleChangesCard(b), true, '迟到帧脏检查必须命中并触发重算');

    for (const n of late) {
        assert.ok(n.getAttribute('data-turn-process'), '迟到思考必须补上折叠标记');
    }
    assert.match(toggle.textContent, /4 段思考/, '摘要计数必须随迟到帧刷新');
    assert.ok(b.classList.contains('turn-compact-open'), '重跑必须保留用户手动展开态');
    const order = b.children.map(n => n.className);
    assert.ok(order.indexOf('fch-host') > order.indexOf('md-content'), '卡片必须回到最终正文之后');
    assert.ok(order.indexOf('fch-host') < order.indexOf('msg-meta-row'), '卡片必须仍在页脚之前');
    assert.equal(b.children.filter(n => n.classList.contains('turn-compact-toggle')).length, 1,
        '重跑不得重复插 toggle');

    // ⑤ 幂等：干净状态再跑零改动（切会话/对账/i18n 不反复改写）
    assert.equal(api.settleChangesCard(b), false, '自愈后再次调用零改动');
});


/* ===== S5：失败轮护栏 —— 迟到帧不得把已折好的错误轮摊开 ===== */
test('★ S5 失败证据轮：卡片落位后重算不得撤销已有折叠（compactBubble null 分支护栏）', () => {
    const b = el('div', ['msg-bubble']);
    const header = el('button', ['turn-batch-header']);
    header.setAttribute('data-batch-state', 'running');
    header.appendChild(el('span', ['turn-batch-label']));
    const think = el('div', ['thinking-block']);
    think.setAttribute('data-turn-process', 'thinking');
    const err = el('div', ['err-bubble'], { text: 'boom' });
    const final = el('div', ['md-content'], { text: '错误说明' });
    const meta = el('div', ['msg-meta-row']);
    [header, think, err, final, meta].forEach(n => b.appendChild(n));
    const toggle = el('button', ['turn-compact-toggle']);
    b.insertBefore(toggle, header);

    const host = el('div', ['fch-host']);
    host.appendChild(el('div', ['msg-run-changes-card']));
    b.insertBefore(host, meta);
    // 模拟 compact 之后迟到的工具帧（无标记）
    const late = el('div', ['tool-card'], { text: 'late tool' });
    b.insertBefore(late, meta);

    api.settleChangesCard(b);   // 返回值含 closeBatchFor 的合法收口，不据此判定
    assert.ok(b.children.indexOf(toggle) >= 0, 'toggle 必须保留（不得摊开整轮）');
    assert.equal(think.getAttribute('data-turn-process'), 'thinking', '既有折叠标记不得清除');
});

/* ===== S6：同 run 多气泡 —— 无卡气泡也必须自愈 ===== */
test('★ S6 同 run 另一条气泡无卡片时仍须收编迟到帧', () => {
    const b = el('div', ['msg-bubble']);
    const toggle = el('button', ['turn-compact-toggle']);
    const think0 = el('div', ['thinking-block']);
    think0.setAttribute('data-turn-process', 'thinking');
    const final = el('div', ['md-content'], { text: '挂起段正文' });
    const meta = el('div', ['msg-meta-row']);
    [toggle, think0, final, meta].forEach(n => b.appendChild(n));
    const late = el('div', ['thinking-block'], { text: 'late thinking' });
    b.insertBefore(late, meta);

    assert.equal(api.settleChangesCard(b), true, '无卡气泡的迟到帧也须重算');
    assert.ok(late.getAttribute('data-turn-process'), '迟到思考必须补标记');
    assert.equal(b.children.filter(n => n.classList.contains('turn-compact-toggle')).length, 1,
        '不得重复插 toggle');
});
