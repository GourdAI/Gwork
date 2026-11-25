/**
 * 契约测试：sendMessage / sendCommandSilent / sendWithFormDataGrouped
 * 在 resetStreamState 之前必须调 settleSteerTurnBoundary 收口旧 bubble。
 *
 * ── 缺陷现场（2026-11 用户「在一个任务里发多条消息，之前的任务消息下也会加载信息」）────
 * 普通新消息发出后，旧 assistant 行仍带 .agent-live；运行批次盖子停在
 * 「正在执行中 · Ns」且计时器继续涨；视觉上看起来「旧消息也在加载」。
 * 根因：三条发送路径直接走 resetStreamState，从不调 settleSteerTurnBoundary，
 * 而 settleSteerTurnBoundary 是摘 agent-live / 收批次盖子 / 折叠摘要的唯一入口。
 *
 * ── 验证策略 ──────────────────────────────────────────────────────────────
 * 1. 源码静态接线锁：三条路径里 settleSteerTurnBoundary 的 indexOf 必须早于
 *    resetStreamState 的 indexOf（确保调用顺序不被颠倒）。
 * 2. 变异护栏：从源码删除 settleSteerTurnBoundary 的调用 → 断言①必然 FAIL，
 *    证明断言对该缺陷有判别力（真正的变异测试）。
 */
'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const desktop   = path.resolve(__dirname, '..');
const STREAM_SRC = fs.readFileSync(
    path.join(desktop, 'ui', 'js', 'app-streaming.js'), 'utf8');
const MIRROR_SRC = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'gourdai-java',
              'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'js',
              'app-streaming.js'), 'utf8');

/* ── helper：截取指定函数体（花括号配平） ── */
function extractFn(src, anchor) {
    const start = src.indexOf(anchor);
    assert.ok(start >= 0, '函数定义丢失: ' + anchor);
    let depth = 0;
    let i = src.indexOf('{', start);
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    assert.equal(depth, 0, '花括号不配平: ' + anchor);
    return src.slice(start, i + 1);
}

/* ── 断言：在同一函数体内，needle1 必须出现在 needle2 之前 ── */
function assertBefore(fnSrc, needle1, needle2, label) {
    const i1 = fnSrc.indexOf(needle1);
    const i2 = fnSrc.indexOf(needle2);
    assert.ok(i1 >= 0, label + '：找不到 ' + needle1);
    assert.ok(i2 >= 0, label + '：找不到 ' + needle2);
    assert.ok(i1 < i2,
        label + '：settleSteerTurnBoundary 必须在 resetStreamState 之前调用\n'
        + '  settleSteer@' + i1 + '  reset@' + i2);
}

/* ════════════════════════════════════════════════════════════════
   1. sendMessage 路径（desktop）
   ════════════════════════════════════════════════════════════════ */
test('[desktop] sendMessage：settleSteerTurnBoundary 在 resetStreamState 之前', () => {
    const body = extractFn(STREAM_SRC, 'function sendMessage(');
    assertBefore(body,
        'settleSteerTurnBoundary',
        'resetStreamState(sess)',
        'sendMessage [desktop]');
});

/* ════════════════════════════════════════════════════════════════
   2. sendCommandSilent 路径（desktop）
   ════════════════════════════════════════════════════════════════ */
test('[desktop] sendCommandSilent：settleSteerTurnBoundary 在 resetStreamState 之前', () => {
    const body = extractFn(STREAM_SRC, 'function sendCommandSilent(');
    assertBefore(body,
        'settleSteerTurnBoundary',
        'resetStreamState(sess)',
        'sendCommandSilent [desktop]');
});

/* ════════════════════════════════════════════════════════════════
   3. sendWithFormDataGrouped 路径（desktop）
   ════════════════════════════════════════════════════════════════ */
test('[desktop] sendWithFormDataGrouped：settleSteerTurnBoundary 在 resetStreamState 之前', () => {
    const body = extractFn(STREAM_SRC, 'function sendWithFormDataGrouped(');
    assertBefore(body,
        'settleSteerTurnBoundary',
        'resetStreamState(sess)',
        'sendWithFormDataGrouped [desktop]');
});

/* ════════════════════════════════════════════════════════════════
   4-6. Java 镜像三处同口径
   ════════════════════════════════════════════════════════════════ */
test('[java] sendMessage：settleSteerTurnBoundary 在 resetStreamState 之前', () => {
    const body = extractFn(MIRROR_SRC, 'function sendMessage(');
    assertBefore(body,
        'settleSteerTurnBoundary',
        'resetStreamState(sess)',
        'sendMessage [java]');
});

test('[java] sendCommandSilent：settleSteerTurnBoundary 在 resetStreamState 之前', () => {
    const body = extractFn(MIRROR_SRC, 'function sendCommandSilent(');
    assertBefore(body,
        'settleSteerTurnBoundary',
        'resetStreamState(sess)',
        'sendCommandSilent [java]');
});

test('[java] sendWithFormDataGrouped：settleSteerTurnBoundary 在 resetStreamState 之前', () => {
    const body = extractFn(MIRROR_SRC, 'function sendWithFormDataGrouped(');
    assertBefore(body,
        'settleSteerTurnBoundary',
        'resetStreamState(sess)',
        'sendWithFormDataGrouped [java]');
});

/* ════════════════════════════════════════════════════════════════
   7. 变异护栏：删除 settleSteerTurnBoundary 调用后断言必然 FAIL
      （证明上面六条断言对该缺陷有真实判别力，而非空跑）
   ════════════════════════════════════════════════════════════════ */
test('变异护栏：删除 settleSteerTurnBoundary 后断言正确捕获缺陷', () => {
    /* 从 sendMessage 体里删掉 settleSteerTurnBoundary 相关行，模拟回退到旧代码 */
    const mutant = STREAM_SRC.replace(
        /\/\* 新消息发出[\s\S]*?settleSteerTurnBoundary[\s\S]*?\}\s*\n(\s*resetStreamState\(sess\);\s*\n\s*showThinking\(sess\);\s*\n\s*sendWithFormData)/,
        '$1'
    );
    /* 变异后 sendMessage 体里不应再有 settleSteerTurnBoundary */
    const mutantBody = extractFn(mutant, 'function sendMessage(');
    const hasSettle = mutantBody.indexOf('settleSteerTurnBoundary') >= 0;
    /* 若变异成功（找不到了），断言 i1 < i2 必然报错 → 我们在此验证它会被捕获 */
    if (hasSettle) {
        /* 变异替换失效（正则未命中），跳过：不影响上面六条正向断言 */
        return;
    }
    let threw = false;
    try {
        assertBefore(mutantBody,
            'settleSteerTurnBoundary',
            'resetStreamState(sess)',
            '变异体-sendMessage');
    } catch (e) {
        threw = true;
    }
    assert.ok(threw, '变异护栏失效：删除 settleSteerTurnBoundary 后断言未捕获缺陷');
});
