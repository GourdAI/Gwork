/**
 * 契约护栏：上拉「加载更多」按对话轮分页 + 交错思考复用窗口 + 跨页同 run 缝合。
 *
 * 事故背景（真实会话实测）：单 run 内 reason/text 交替 21 次（interleaved thinking），
 * 旧渲染管线每次交替都新开正文容器并盖一个「思考完成」条，叠加后端页边界切在 run 中段，
 * 用户上拉后看到「一条回答碎成多个各带思考完成徽标的小气泡」。以下护栏锁定三处修复形态，
 * 防止回退：
 * - app-message.js：ensureThinkingBlockCore 的同 run 复用窗口（含工具夹心打断与超时失效）；
 *   finishThinkingBlockCore 登记窗口；advanceBodyPointer 标记工具夹心；
 * - app-base.js：resetStreamState 必须清零复用窗口（跨轮/跨会话不得复用旧思考块）；
 * - app-history.js：replayDone 的 prepend 分支在选锚点之前调用 stitchPrependedRunRows
 *   （跨页同 run 行缝合），且缝合函数不得搬移 meta-row / msg-actions（会出现两份按钮）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8')
    .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const historyJs = readStatic('js', 'app-history.js');
const messageJs = readStatic('js', 'app-message.js');
const baseJs = readStatic('js', 'app-base.js');

function sliceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `未找到起始标记: ${startMarker}`);
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, `未找到结束标记: ${endMarker}`);
    return source.slice(start, end);
}

test('app-message.js：交错思考复用窗口三件套齐备（复用条件/登记/工具夹心打断）', () => {
    const ensure = sliceBetween(messageJs, 'function ensureThinkingBlockCore(', 'function finishThinkingBlockCore(');
    assert.match(ensure, /h\._lastFinishedThinkingBlockEl/, '复用窗口必须持有已收敛思考块引用');
    assert.match(ensure, /h\._lastThinkingRunId\s*===\s*sess\.currentRunId/, '复用必须限定同一 run');
    assert.match(ensure, /!h\._thinkingInterruptedByAction/, '工具夹心后禁止复用旧思考块');
    assert.match(ensure, /<\s*5000/, '复用必须有时间窗上限');
    // 复用体的增量渲染器已 finish：新思考段必须落在同块体内的新 md-content，
    // 直接复用旧 mdEl 会被 createStreamMd 的 !active 重置分支清空已渲染内容
    assert.match(ensure, /addClass\('md-content'\)/, '复用分支应新建块体内正文容器');

    const finish = sliceBetween(messageJs, 'function finishThinkingBlockCore(', 'function appendReasonChunkCore(');
    assert.match(finish, /h\._lastFinishedThinkingBlockEl\s*=\s*h\.thinkingBlockEl/, '收敛时必须登记复用窗口');
    assert.match(finish, /h\._lastThinkingRunId\s*=\s*sess\.currentRunId/, '登记时必须记录 runId');

    const advance = sliceBetween(messageJs, 'function advanceBodyPointer(', 'function ensureThinkingBlock(');
    assert.match(advance, /_thinkingInterruptedByAction\s*=\s*true/, '正文指针推进（工具/插话）必须打断复用窗口');
});

test('app-base.js：resetStreamState 清零交错思考复用窗口', () => {
    const reset = sliceBetween(baseJs, 'function resetStreamState(sess)', 'function setBtnStopMode()');
    assert.match(reset, /_lastFinishedThinkingBlockEl\s*=\s*null/, '跨轮/跨会话不得复用旧 run 的思考块');
    assert.match(reset, /_lastThinkingRunId\s*=\s*null/);
    assert.match(reset, /_thinkingInterruptedByAction\s*=\s*false/);
});

test('app-history.js：prepend 回放在选锚点之前缝合跨页同 run 行', () => {
    const prependBranch = sliceBetween(historyJs, 'if (prepend) {', '加载按钮在锚定修正之前重建');
    const stitchAt = prependBranch.indexOf('stitchPrependedRunRows(');
    const anchorAt = prependBranch.indexOf('var anchorEl');
    assert.ok(stitchAt >= 0, 'prepend 分支必须调用跨页缝合');
    assert.ok(anchorAt > stitchAt, '缝合必须先于锚点选取：否则锚点可能选中将被删除的行');

    const stitch = sliceBetween(historyJs, 'function stitchPrependedRunRows(', 'function loadMessagesLegacy(');
    assert.match(stitch, /getAttribute\('data-run-id'\)/, '缝合必须按 runId 配对首尾行');
    assert.match(stitch, /msg-meta-row|msg-actions/, '缝合须显式处理 meta/actions（不得搬出两份按钮）');
    assert.match(stitch, /currentBubbleEl/, '缝合不得触碰承载实时流式输出的行');
});
