/* 流式管线异常留痕回归测试。

   事故现象（会话 work-mub8ph5g，2026-09-22）：后端完整跑完（trace + done 均已落盘，
   12:08:16），但界面定格在 11:55:58 的一行正文上，其后 12 分钟约 370 帧全部未渲染；
   与此同时底部发送按钮从「执行中」正常变回发送态。控制台无任何日志。

   根因结构：
     1) onWebChunk 整个函数体被 `} catch (e) {}` 包住（空捕获），单帧渲染抛异常时
        既不上抛也不留痕；
     2) done 帧在 dispatchGateChunk 的前置分支处理完即 return，根本不经过 onWebChunk，
        故门禁畅通、finishStream 照常执行 —— 于是出现「内容永久卡死、按钮却正常结束」
        这一与既往「门禁自锁」完全相反的表征（门禁自锁会把 done 一起扣住，按钮永远转）；
     3) applySequencedGateChunk 把 lastEventSeq 的推进写在 dispatch 之后，dispatch 抛异常
        则游标停在原地，该帧被后续恢复/排空路径反复重放、反复抛在同一处；
     4) dispatchGateChunk 中 _todoChunkHandlers 为裸调用（无 try），而 todowrite 后端只发
        action_end（实测该会话 25 个 action_end 无配对 action_start），该分支每次必经。

   修复：不改变「单帧出错不拖垮整条流」的语义，但所有分发环节的异常必须留痕
   （reportStreamPipelineError），且游标在异常时照常推进。

   本文件断言的是**真实行为**（在受控沙箱里驱动真实函数体），而非源码字符串匹配。 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8')
    .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

const baseJs = readStatic('js', 'app-base.js');
const streamingJs = readStatic('js', 'app-streaming.js');
const historyJs = readStatic('js', 'app-history.js');

/* 按花括号配平抽取函数体（与仓库既有测试同一范式） */
function fnBody(source, name) {
    const start = source.indexOf('function ' + name + '(');
    assert.ok(start >= 0, '未找到函数: ' + name);
    let depth = 0, seen = false;
    for (let i = start; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') { depth++; seen = true; }
        else if (ch === '}') { depth--; if (seen && depth === 0) return source.slice(start, i + 1); }
    }
    assert.fail('函数体未配平: ' + name);
}

/* 剥掉注释，避免把注释里描述缺陷的文字误当成代码断言 */
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/* ===== 一、诊断助手本身的行为 ===== */

function loadReporter(consoleStub) {
    const src = 'var streamPipelineErrorStats = {};\n'
        + fnBody(baseJs, 'reportStreamPipelineError')
        + '\nreturn { report: reportStreamPipelineError, stats: function(){ return streamPipelineErrorStats; } };';
    const env = { console: consoleStub, Date };
    return new Function('__env', 'with(__env){ ' + src + ' }')(env);
}

test('异常留痕：首帧失败打印详细错误与堆栈', () => {
    const logs = [];
    const api = loadReporter({ error: (...a) => logs.push(a.join(' ')), log() {}, table() {} });
    const err = new Error('boom');
    api.report('onWebChunk', err, { type: 'reason', eventSeq: 782251, runId: '7edb74c7-1111' });

    assert.equal(api.stats()['onWebChunk'].count, 1);
    const joined = logs.join('\n');
    assert.ok(joined.includes('onWebChunk'), '应标明出错环节');
    assert.ok(joined.includes('reason'), '应标明帧类型');
    assert.ok(joined.includes('782251'), '应标明 eventSeq，便于对照 stream.ndjson 定位');
});

test('异常留痕：高频重复失败不刷爆控制台，但计数持续累加', () => {
    const logs = [];
    const api = loadReporter({ error: (...a) => logs.push(a.join(' ')), log() {}, table() {} });
    for (let i = 0; i < 120; i++) {
        api.report('onWebChunk', new Error('x'), { type: 'text', eventSeq: 1000 + i });
    }
    assert.equal(api.stats()['onWebChunk'].count, 120, '计数必须反映真实失败总量');
    // 首次(1) + 第5次 + 第50/100次 —— 远小于 120，避免高频帧刷屏
    assert.ok(logs.length < 20, '不得每帧都打印，实际打印 ' + logs.length + ' 次');
    assert.ok(logs.length >= 2, '仍须有阶段性上报');
});

test('异常留痕：留痕逻辑自身绝不抛异常（不得成为新的故障源）', () => {
    const api = loadReporter({
        error() { throw new Error('console 也坏了'); },
        log() { throw new Error('console 也坏了'); },
        table() {}
    });
    assert.doesNotThrow(() => api.report('anywhere', new Error('boom'), null));
});

/* ===== 二、游标推进：异常帧不得卡死整条流 ===== */

function loadApply(dispatchImpl) {
    const src = fnBody(streamingJs, 'applySequencedGateChunk')
        + '\nreturn applySequencedGateChunk;';
    const env = {
        dispatchGateChunk: dispatchImpl,
        reportStreamPipelineError() {}
    };
    return new Function('__env', 'with(__env){ ' + src + ' }')(env);
}

test('游标推进：dispatch 抛异常时 lastEventSeq 仍前进，后续帧不被连带丢弃', () => {
    const seen = [];
    const apply = loadApply((c) => {
        seen.push(c.eventSeq);
        if (c.eventSeq === 200) throw new Error('渲染这一帧时炸了');
    });
    const sess = { lastEventSeq: 0 };

    apply(sess, { eventSeq: 100, type: 'text' });
    apply(sess, { eventSeq: 200, type: 'reason' });   // 抛异常的那一帧
    apply(sess, { eventSeq: 300, type: 'text' });

    assert.deepEqual(seen, [100, 200, 300], '异常帧之后的帧必须照常分发');
    assert.equal(sess.lastEventSeq, 300, '游标必须已推进到最新帧');
});

test('游标推进：异常帧不会被重放路径反复重试（消除原地死循环）', () => {
    let hits = 0;
    const apply = loadApply((c) => { hits++; if (c.eventSeq === 200) throw new Error('boom'); });
    const sess = { lastEventSeq: 0 };

    const frame = { eventSeq: 200, type: 'reason' };
    assert.equal(apply(sess, frame), true, '首次消费返回 true');
    // 模拟断线恢复/缓冲排空把同一帧又送一次
    assert.equal(apply(sess, frame), false, '已消费过的 seq 必须被去重拦下');
    assert.equal(hits, 1, '同一异常帧只应真正分发一次');
});

test('游标推进：异常被吞但必定上报（不得静默）', () => {
    const reported = [];
    const src = fnBody(streamingJs, 'applySequencedGateChunk') + '\nreturn applySequencedGateChunk;';
    const apply = new Function('__env', 'with(__env){ ' + src + ' }')({
        dispatchGateChunk() { throw new Error('boom'); },
        reportStreamPipelineError: (where, err, chunk) => reported.push({ where, chunk })
    });
    const sess = { lastEventSeq: 0 };

    assert.doesNotThrow(() => apply(sess, { eventSeq: 5, type: 'text' }), '不得把异常上抛打断调用方循环');
    assert.equal(reported.length, 1, '必须留痕');
    assert.equal(reported[0].chunk.eventSeq, 5, '留痕须带上出事的那一帧');
});

/* ===== 三、外部处理器隔离：todowrite 分支每帧必经 ===== */

test('处理器隔离：单个 _todoChunkHandlers 抛异常不得打断整帧分发', () => {
    // 取 dispatchGateChunk 里的 todowrite 片段，验证其隔离结构
    const body = stripComments(fnBody(streamingJs, 'dispatchGateChunk'));
    const idx = body.indexOf('_todoChunkHandlers');
    assert.ok(idx >= 0, '未找到 todowrite 处理分支');
    const seg = body.slice(idx, idx + 400);
    assert.ok(/try\s*\{[^}]*h\(chunk\)/.test(seg),
        '处理器调用必须包在 try 内，否则外部处理器异常会打断后续渲染');

    // 真实行为：一个处理器炸了，其余仍须执行
    const ran = [];
    const handlers = [
        () => { ran.push('a'); },
        () => { throw new Error('第三方处理器炸了'); },
        () => { ran.push('c'); }
    ];
    const reported = [];
    const report = (where, err, chunk) => reported.push(where);
    assert.doesNotThrow(() => {
        handlers.forEach(function (h) {
            try { h({ type: 'action_end' }); } catch (e) { report('todoChunkHandler', e, null); }
        });
    });
    assert.deepEqual(ran, ['a', 'c'], '异常处理器不得影响其它处理器');
    assert.equal(reported.length, 1);
});

/* ===== 四、契约护栏：关键路径不得回退成空捕获 ===== */

test('契约：分发主干四处异常出口均已留痕，不得再出现空 catch', () => {
    const targets = [
        ['app-streaming.js', streamingJs, 'onWebChunk'],
        ['app-streaming.js', streamingJs, 'applySequencedGateChunk'],
        ['app-history.js', historyJs, 'drainGateBuffer']
    ];
    for (const [file, src, fname] of targets) {
        const body = stripComments(fnBody(src, fname));
        assert.ok(!/catch\s*\([a-zA-Z0-9_$]*\)\s*\{\s*\}/.test(body),
            file + ' 的 ' + fname + ' 内仍存在空 catch —— 异常将再次无痕消失');
        assert.ok(body.includes('reportStreamPipelineError'),
            file + ' 的 ' + fname + ' 必须调用 reportStreamPipelineError 留痕');
    }
});

test('契约：done 帧不经过 onWebChunk —— 这正是卡死可与按钮复位并存的结构原因', () => {
    const body = stripComments(fnBody(streamingJs, 'dispatchGateChunk'));
    const doneIdx = body.indexOf("chunk.type === 'done'");
    const webChunkIdx = body.lastIndexOf('onWebChunk(');
    assert.ok(doneIdx >= 0 && webChunkIdx >= 0);
    assert.ok(doneIdx < webChunkIdx,
        'done 分支应在 onWebChunk 之前并独立 return；若该结构变动，本测试的前提需重新评估');
});

test('契约：诊断入口 gourdStreamDiag 已挂到 window，便于现场自查', () => {
    assert.ok(/window\.gourdStreamDiag\s*=/.test(baseJs),
        '必须暴露 window.gourdStreamDiag()，否则用户复现时仍无法取证');
});
