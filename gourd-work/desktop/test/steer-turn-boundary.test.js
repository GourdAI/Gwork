/**
 * 契约测试：插话（steer）轮边界收口 —— settleSteerTurnBoundary。
 *
 * ── 缺陷现场（2026-11 用户「现在插话后会出问题」，附截图三个红框）────────────
 * appendSteerNote 在运行中补发消息时，把 sess.currentBubbleEl 清空并另起一条
 * 全新 assistant 气泡；但任务【没有结束】，后端继续跑，稍后的 done 帧只会让
 * finishStream 收口【新】气泡（liveFoldRow 取自 currentBubbleEl）。被抛弃的旧
 * 气泡从此无人收口，屏幕上留下三处残形态：
 *   ① 运行态批次盖子 data-batch-state="running" 永远停在「正在执行中 · Ns」，
 *      ticker 每秒还在改文案，而它下面早就是历史过程行 —— 用户红框②配文
 *      「是历史消息的最终折叠的折叠态，你看看」正是「运行态 vs 最终折叠态」的落差；
 *   ② 旧行仍挂 .agent-live，过程行保持实时展开的扁平轨迹；
 *   ③ 流式中被 hide 的 .msg-actions 永远不显示（finishStream 只显示当前行）。
 * 插话后的新气泡再开一个「正在执行中」盖子（红框③）是正常的新轮运行态；
 * 缺陷是【旧盖子不收口】导致屏幕上同时并存两个「正在执行中」。
 *
 * ── 测试形态 ────────────────────────────────────────────────────────────
 * 从真实 app-message.js 里切出 helper 源码（不复制实现，避免测副本），在
 * node:vm 里配极简假 DOM 真跑；另用源码断言守住 appendSteerNote 的接线
 * （helper 必须定义在清 currentBubbleEl 之前被调用）与两份 UI 镜像的一致性，
 * 并钉死「绝不调用 compactBubble / clearBatch」——旧轮没有终态正文，
 * compactBubble 会走 !decision → revealAll 把刚收好的批次重新摊开。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.resolve(__dirname, '..', '..', '..');
const desktop = path.resolve(__dirname, '..');
const MSG_SRC = fs.readFileSync(path.join(desktop, 'ui', 'js', 'app-message.js'), 'utf8');

/* ===== 从真实源码切出 helper（花括号配平，与 stale-agent-frame.test.js 同口径） ===== */
function extractFn(src, anchor) {
    const start = src.indexOf(anchor);
    assert.ok(start >= 0, 'helper 定义丢失: ' + anchor);
    let depth = 0;
    let i = src.indexOf('{', start);
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    assert.equal(depth, 0, 'helper 花括号不配平');
    return src.slice(start, i + 1);
}
const HELPER_SRC = extractFn(MSG_SRC, 'function settleSteerTurnBoundary(sess) {');

/* ===== 极简假 DOM（与 turn-batch.test.js 同口径） ===== */
function el(classes) {
    const node = {
        _classes: new Set(classes || []), children: [], parentNode: null, style: {},
        classList: {
            contains: c => node._classes.has(c),
            add: c => node._classes.add(c),
            remove: c => node._classes.delete(c)
        },
        appendChild(c) { c.parentNode = node; node.children.push(c); return c; },
        querySelectorAll(sel) {
            const want = sel.replace(/^\./, '');
            const out = [];
            (function walk(n) {
                for (const c of n.children) {
                    if (c._classes.has(want)) out.push(c);
                    walk(c);
                }
            })(node);
            return out;
        }
    };
    return node;
}

/** 造一条正在运行的旧 assistant 行：msg-row.agent-live > msg-bubble > (md + actions) */
function makeRunningTurn() {
    const row = el(['msg-row', 'assistant', 'agent-live']);
    const bubble = el(['msg-bubble']);
    const md = el(['md-content']);
    const actions = el(['msg-actions']);
    actions.style.display = 'none';       // 流式中被 hide() 的 inline 态
    row.appendChild(bubble);
    bubble.appendChild(md);
    bubble.appendChild(actions);
    return { row, bubble, md, actions };
}

/** 在 vm 沙箱里装载 helper，返回 {fn, calls}；calls 记录所有收口调用 */
function loadHelper(opts) {
    const o = opts || {};
    const calls = [];
    const sandbox = {
        console: { error() {} },
        localStorage: { getItem: k => (k === 'gourd.turnCompact' && o.turnCompactOff) ? '0' : null },
        isDetachedRenderTarget: () => !!o.detached,
        window: {
            /* 探针：compactBubble / clearBatch 一旦被调用就是回归（会把收好的批次摊开） */
            GourdTurnBatch: o.noBatch ? undefined : {
                closeBatchFor: () => { calls.push('closeBatchFor'); if (o.throwBatch) throw new Error('batch boom'); },
                clearBatch: () => calls.push('clearBatch')
            },
            GourdTurnCompact: o.noCompact ? undefined : {
                compactBubble: () => calls.push('compactBubble'),
                clearTurnCompact: () => calls.push('clearTurnCompact')
            }
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(HELPER_SRC + '\nthis.__helper = settleSteerTurnBoundary;', sandbox);
    assert.equal(typeof sandbox.__helper, 'function', 'helper 未成功装载');
    return { fn: sandbox.__helper, calls };
}

test('★ 插话轮边界：旧批次收口、旧行退出运行态、操作按钮恢复显示', () => {
    const t = makeRunningTurn();
    const { fn, calls } = loadHelper({});
    fn({ currentBubbleEl: t.md, _replaying: false });
    assert.deepEqual(calls, ['closeBatchFor'], '唯一的折叠动作就是运行批次收口');
    assert.ok(!t.row._classes.has('agent-live'), '旧行必须摘掉 agent-live（否则过程行永远实时展开）');
    assert.equal(t.actions.style.display, '', '旧行 .msg-actions 必须恢复显示（此后无 finishStream 会来显示它）');
});

test('★ 回归钉 A：绝不调 compactBubble（旧轮无终态正文，会 revealAll 抵消收口）', () => {
    const t = makeRunningTurn();
    const { fn, calls } = loadHelper({});
    fn({ currentBubbleEl: t.md });
    assert.ok(!calls.includes('compactBubble'), 'compactBubble 会把刚折叠的批次重新摊开');
    assert.ok(!calls.includes('clearTurnCompact'));
    assert.ok(!calls.includes('clearBatch'), 'clearBatch 同样会摊开已渲染的历史过程行');
});

test('★ 回归钉 B：缺少 turn-compact 模块时批次仍必须收口（盖子不能谎报「正在执行中」）', () => {
    const t = makeRunningTurn();
    const { fn, calls } = loadHelper({ noCompact: true });
    fn({ currentBubbleEl: t.md });
    assert.deepEqual(calls, ['closeBatchFor'], '批次收口不得挂在 tcApi 存在性分支下');
});

test('★ 模块缺失 / 收口抛异常：静默降级，agent-live 与按钮仍已复位', () => {
    for (const o of [{ noBatch: true }, { throwBatch: true }]) {
        const t = makeRunningTurn();
        const { fn } = loadHelper(o);
        assert.doesNotThrow(() => fn({ currentBubbleEl: t.md }), '纯展示增强不得上抛');
        assert.ok(!t.row._classes.has('agent-live'));
        assert.equal(t.actions.style.display, '');
    }
});

test('★ 回放态 / 游离渲染容器一律跳过：不重复折叠、不碰未入文档的 DOM', () => {
    for (const o of [{ detached: true }, {}]) {
        const t = makeRunningTurn();
        const { fn, calls } = loadHelper(o);
        const sess = { currentBubbleEl: t.md, _replaying: !o.detached };
        fn(sess);
        assert.deepEqual(calls, [], '回放/游离态不得触发任何收口');
        assert.ok(t.row._classes.has('agent-live'), '回放态由 applyTurnCompact 统一处理，此处不得提前摘标记');
        assert.equal(t.actions.style.display, 'none', '回放态不得动操作按钮');
    }
});

test('★ 偏好关闭：只跳过收口，不主动拆已有折叠标记（一键回退不摊开历史）', () => {
    const t = makeRunningTurn();
    const { fn, calls } = loadHelper({ turnCompactOff: true });
    fn({ currentBubbleEl: t.md });
    assert.deepEqual(calls, []);
    assert.ok(!t.row._classes.has('agent-live'), '偏好关闭也要退出运行态');
    assert.equal(t.actions.style.display, '', '偏好关闭也要恢复操作按钮');
});

test('无 currentBubbleEl / 旧气泡已脱离文档：静默 no-op，不抛异常', () => {
    const { fn, calls } = loadHelper({});
    fn(null);
    fn({});
    const orphan = el(['md-content']);   // 无 parentNode
    fn({ currentBubbleEl: orphan });
    assert.deepEqual(calls, []);
});

/* ===== 接线锁：helper 必须在清 currentBubbleEl 之前被调用，且两份 UI 镜像一致 ===== */
test('★ 接线锁：appendSteerNote 在清指针前调用 settleSteerTurnBoundary', () => {
    const bodyStart = MSG_SRC.indexOf('function appendSteerNote(sess, item) {');
    assert.ok(bodyStart > 0);
    const body = MSG_SRC.slice(bodyStart, MSG_SRC.indexOf('window.appendSteerNote', bodyStart));
    const iSettle = body.indexOf('settleSteerTurnBoundary(sess);');
    const iClear = body.indexOf('sess.currentBubbleEl = null;');
    const iEnsure = body.indexOf('ensureAssistantBubble(sess);');
    assert.ok(iSettle > 0, 'appendSteerNote 必须调用收口 helper');
    assert.ok(iClear > 0 && iEnsure > iClear, '清指针 → 新建气泡的顺序不得变');
    assert.ok(iSettle < iClear, '收口必须在清指针之前：清了就再也找不到旧气泡');
});

/* 2026-11 契约对齐：根级 gourd-ai-tauri/ui 是 7370119 已删除、.gitignore 忽略的
   构建期拷贝残骸，CI checkout 后不存在；只锁两份入库镜像。 */
test('★ 两份 UI 镜像同步：gourd-work / gourdai-java 的插话收口接线', () => {
    const mirrors = [
        path.join(desktop, 'ui', 'js', 'app-message.js'),
        path.join(repo, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'js', 'app-message.js')
    ];
    for (const f of mirrors) {
        assert.ok(fs.existsSync(f), '镜像缺失: ' + f);
        const src = fs.readFileSync(f, 'utf8');
        assert.ok(src.indexOf('function settleSteerTurnBoundary(sess) {') > 0, '镜像缺 helper: ' + f);
        assert.ok(src.indexOf('settleSteerTurnBoundary(sess);') > 0, '镜像缺接线: ' + f);
        assert.doesNotMatch(src, /插话以【用户消息气泡】形态呈现\s*\n\s*\n\/\* 插话以/, '镜像残留悬空注释: ' + f);
    }
});
