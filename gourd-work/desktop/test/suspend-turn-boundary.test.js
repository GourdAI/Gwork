/**
 * 契约测试：挂起 done（ask_user / HITL）轮边界收口 —— finishStream 挂起分支。
 *
 * ── 缺陷现场（2026-11 用户「ask 好像也有同样的问题」，附截图）──────────────
 * 落盘帧 work-mw4m8qep 逐字复原：
 *   seq 39794  action_start ask_user
 *   seq 39795  done  suspended=true  run-18ba47b8   ← 17:30:39 挂起
 *   seq 39797  question_answered                     ← 17:40:14 作答（等 9.6 分钟）
 *   seq 39799+ reason  run-fd81760b                  ← 恢复段新 runId
 * 屏幕上于是并存两个「正在执行中」：
 *   ① 挂起前旧气泡：「正在执行中 · 10min 12s / 向用户提问 [1项]」+ 右侧绿点；
 *   ② 恢复段新气泡：「正在执行中 · 26s / 思考中」+ 右侧绿点。
 *
 * 根因：finishStream 的 `keepBatchIndex`（挂起收尾）把两件不同的事绑死在同一
 * 门禁下 —— 会话级批次索引要保留（toolBatchesById / completedActionIds，供恢复
 * 后 action_end 认领原卡片容器），但 DOM 层运行态收口被 `!keepBatchIndex` 一并
 * 跳过；而 resetStreamState 照样把 currentBubbleEl 清成 null。用户作答后
 * appendQuestionAnswerRecord / 恢复段帧在 null 指针下另起新 assistant 气泡，
 * 旧气泡的 running 盖子从此无人收口，ticker 跨整个等待期持续累加。
 *
 * 修复：清指针【之前】复用 settleSteerTurnBoundary 做 DOM 层轮边界收口
 * （摘 agent-live / 显示 msg-actions / closeBatchFor 定格为「执行工具 N 次」），
 * 不动任何流式状态、缓冲、按钮态与批次索引；真收口分支仍保持 !keepBatchIndex，
 * 挂起段不得施加整轮 Compact（无终态正文 → revealAll 会把折叠重新摊开）。
 *
 * ── 测试形态 ────────────────────────────────────────────────────────────
 * 不做纯字符串断言：把 app-streaming.js 里新增的挂起分支源码【切出来】，与
 * app-message.js 里的真实 helper 源码一起装进 node:vm，配极简假 DOM 真跑。
 * 既有 steer-turn-boundary.test.js 覆盖 helper 自身行为；本文件覆盖【接线】。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.resolve(__dirname, '..', '..', '..');
const desktop = path.resolve(__dirname, '..');
const STREAM_SRC = fs.readFileSync(path.join(desktop, 'ui', 'js', 'app-streaming.js'), 'utf8');
const MSG_SRC = fs.readFileSync(path.join(desktop, 'ui', 'js', 'app-message.js'), 'utf8');

const BLOCK_ANCHOR = '/* 【挂起 done 的轮边界收口】';
const BLOCK_END = '// resetStreamState 会清空 buffer';
const blockStart = STREAM_SRC.indexOf(BLOCK_ANCHOR);
assert.ok(blockStart > 0, '挂起轮边界收口分支丢失');
const blockEnd = STREAM_SRC.indexOf(BLOCK_END, blockStart);
assert.ok(blockEnd > blockStart, 'resetStreamState 锚点丢失');
const SUSPEND_BLOCK = STREAM_SRC.slice(blockStart, blockEnd);

/* 从真实源码切出 helper（花括号配平，与 steer-turn-boundary.test.js 同口径） */
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

/* ===== 极简假 DOM（与 steer-turn-boundary.test.js 同口径） ===== */
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

/** 挂起前的旧 assistant 行：running 盖子 + agent-live + 隐藏的 msg-actions */
function makeSuspendedTurn() {
    const row = el(['msg-row', 'assistant', 'agent-live']);
    const bubble = el(['msg-bubble']);
    const header = el(['turn-batch-header']);
    header.getAttribute = () => 'running';       // 未收口的运行态盖子
    const toolCard = el(['tool-card']);
    const md = el(['md-content']);
    const actions = el(['msg-actions']);
    actions.style.display = 'none';
    row.appendChild(bubble);
    bubble.appendChild(header);
    bubble.appendChild(toolCard);
    bubble.appendChild(md);
    bubble.appendChild(actions);
    return { row, bubble, header, toolCard, md, actions };
}

/**
 * 真跑挂起分支：把真实 helper 与切出的分支源码装进同一个 vm，
 * closeBatchFor 用探针记录，验证条件门禁与 DOM 副作用。
 */
function runSuspendBlock(opts) {
    const o = opts || {};
    const t = makeSuspendedTurn();
    const calls = [];
    const sandbox = {
        console: { error() {} },
        localStorage: { getItem: k => (k === 'gourd.turnCompact' && o.turnCompactOff) ? '0' : null },
        isDetachedRenderTarget: () => !!o.detached,
        window: {
            GourdTurnBatch: {
                closeBatchFor: b => { calls.push('closeBatchFor'); assert.equal(b, t.bubble, '必须收口旧气泡'); },
                clearBatch: () => calls.push('clearBatch')
            },
            GourdTurnCompact: {
                compactBubble: () => calls.push('compactBubble'),
                clearTurnCompact: () => calls.push('clearTurnCompact')
            }
        },
        keepBatchIndex: o.keep !== false,
        sess: {
            currentBubbleEl: t.md,
            _replaying: !!o.replaying,
            _skipScroll: !!o.skipScroll
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(HELPER_SRC + '\nthis.__helper = settleSteerTurnBoundary;', sandbox);
    sandbox.settleSteerTurnBoundary = sandbox.__helper;
    // 分支源码里只有注释 + 一个 if 语句；包成函数以便重复执行
    vm.runInContext('this.__run = function(){' + SUSPEND_BLOCK + '\n};', sandbox);
    assert.doesNotThrow(() => sandbox.__run(), '挂起分支不得抛异常');
    return { t, calls };
}

test('★ 挂起 done：清指针前收口旧气泡（running 盖子 / agent-live / 操作按钮）', () => {
    const { t, calls } = runSuspendBlock({ keep: true });
    assert.deepEqual(calls, ['closeBatchFor'], '唯一的折叠动作是运行批次收口');
    assert.ok(!t.row._classes.has('agent-live'), '旧行必须退出运行态');
    assert.equal(t.actions.style.display, '', '旧行操作按钮必须恢复显示');
    assert.ok(!calls.includes('compactBubble'), '挂起段不得施加整轮 Compact（会 revealAll 摊开）');
    assert.ok(!calls.includes('clearBatch'), '不得拆掉已渲染的历史折叠');
});

test('★ 只有挂起收尾走轮边界收口：真收口（keepBatchIndex=false）不触发', () => {
    const { t, calls } = runSuspendBlock({ keep: false });
    assert.deepEqual(calls, [], '真收口由下方 closeBatchFor+compactBubble 分支负责，不得重复收口');
    assert.ok(t.row._classes.has('agent-live'), '真收口仍由下方分支摘 agent-live');
});

test('★ 回放 / prepend / 游离渲染容器一律跳过（与真收口分支护栏对齐）', () => {
    for (const o of [{ replaying: true }, { skipScroll: true }, { detached: true }]) {
        const { t, calls } = runSuspendBlock(o);
        assert.deepEqual(calls, [], '护栏场景不得触发收口: ' + JSON.stringify(o));
        assert.ok(t.row._classes.has('agent-live'));
        assert.equal(t.actions.style.display, 'none');
    }
});

test('★ 偏好关闭：只跳过批次收口，agent-live 与按钮仍复位', () => {
    const { t, calls } = runSuspendBlock({ turnCompactOff: true });
    assert.deepEqual(calls, []);
    assert.ok(!t.row._classes.has('agent-live'));
    assert.equal(t.actions.style.display, '');
});

test('★ 接线锁：挂起分支必须在 resetStreamState 之前，且真收口仍排除挂起', () => {
    const fnStart = STREAM_SRC.indexOf('function finishStream(sess, opts) {');
    assert.ok(fnStart > 0);
    const body = STREAM_SRC.slice(fnStart, STREAM_SRC.indexOf('\nfunction ', fnStart + 10));
    const iSuspend = body.indexOf('if (keepBatchIndex && !sess._replaying');
    const iSettle = body.indexOf('settleSteerTurnBoundary(sess);', iSuspend);
    const iReset = body.indexOf('resetStreamState(sess);', iSuspend);
    const iRealFold = body.indexOf('if (!keepBatchIndex && !sess._replaying', iReset);
    assert.ok(iSuspend > 0, '挂起轮边界收口分支必须存在');
    assert.ok(iSettle > iSuspend, '分支内必须调用 helper');
    assert.ok(iReset > iSettle, '必须在 resetStreamState 清指针【之前】收口');
    assert.ok(iRealFold > iReset, '真收口分支仍需在后面');
    assert.ok(body.indexOf('!keepBatchIndex', iRealFold) >= iRealFold, '挂起 done 不得走整轮 Compact');
});

/* 2026-11 契约对齐：根级 gourd-ai-tauri/ui 已删除且不入库，CI checkout 后不存在；
   只锁两份入库镜像。 */
test('★ 两份 UI 镜像同步：helper 定义 / 插话接线 / 泛化注释', () => {
    const mirrors = [
        path.join(desktop, 'ui', 'js', 'app-message.js'),
        path.join(repo, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'js', 'app-message.js')
    ];
    for (const f of mirrors) {
        assert.ok(fs.existsSync(f), '镜像缺失: ' + f);
        const src = fs.readFileSync(f, 'utf8');
        assert.ok(src.includes('function settleSteerTurnBoundary(sess) {'), '镜像缺 helper: ' + f);
        assert.ok(src.includes('settleSteerTurnBoundary(sess);'), '镜像缺插话接线: ' + f);
        assert.ok(src.includes('【轮边界收口】'), '镜像注释未泛化: ' + f);
        assert.ok(src.includes('挂起 done'), '镜像未说明挂起场景: ' + f);
        assert.ok(src.includes('[轮边界收口] 旧轮收口失败'), '镜像日志未统一: ' + f);
    }
});
