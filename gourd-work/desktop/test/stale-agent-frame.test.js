/**
 * 契约测试：陈旧子代理帧不得干扰新一轮（Stop 后迟到的 agent_end 专项）。
 *
 * ── 缺陷现场（2026-10-31）────────────────────────────────────────────────────
 * 用户报「停止按钮要点两次」。修好之后仍留一个伴生缺陷，且被那次修复放大：
 * 前台子代理的委派现在跑在 detach 的任务上（core/src/tools/agent.rs 前台分支），
 * 父 run 被取消/结束后它仍会跑完收尾。于是它的 agent_end 可能迟到——落在
 * 「用户已发下一条消息、新一轮正在流式输出」之后。
 *
 * 两处判据原先只看 `args.background`，而那个标志描述的是**帧的来源**，
 * 危险却来自**帧的到达时机**。迟到的前台帧 background=false，于是：
 *   ① app-streaming.js:928 照常 finishThinkingBlock → 把新 run 正在输出的
 *      思考块强制定稿（文案改「思考完成」、清计时器、清空 buffer）；
 *   ② app-message.js:2746 照常重建 currentBubbleEl 并清 reasonBuffer →
 *      新 run 已累积未 flush 的增量丢失，正文被撕裂成「旧 div + 新 div」两块。
 *
 * 修法：抽出唯一判据 isStaleAgentFrame（卡片建房时记下的 data-run-id ≠ 当前
 * runId 即为陈旧），两处消费点共用，避免判据漂移。
 *
 * ── 测试形态 ────────────────────────────────────────────────────────────────
 * 该 helper 是纯函数（只读 sess/args），故在 node:vm 里真跑其函数体，配假卡片；
 * 另用源码断言守住「两个消费点确实都走这个 helper」——判据若被改回只看
 * background，行为测试会绿（因为 helper 本身没变）而线上缺陷复发，这一层是必要的。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const uiRoot = path.resolve(__dirname, '../ui');
const MSG_SRC = fs.readFileSync(path.join(uiRoot, 'js', 'app-message.js'), 'utf8');
const STREAM_SRC = fs.readFileSync(path.join(uiRoot, 'js', 'app-streaming.js'), 'utf8');

/* ===== 从真实源码里切出 helper（不复制一份实现，否则测的是副本） ===== */
function extractHelper(src) {
    const anchor = 'function isStaleAgentFrame(sess, args) {';
    const start = src.indexOf(anchor);
    assert.ok(start >= 0, 'isStaleAgentFrame 定义丢失');
    let depth = 0;
    let i = src.indexOf('{', start);
    const bodyStart = i;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) break;
        }
    }
    assert.ok(depth === 0, 'helper 花括号不配平');
    return src.slice(start, i + 1);
}

const HELPER_SRC = extractHelper(MSG_SRC);

function makeHelper() {
    const sandbox = { result: null };
    vm.createContext(sandbox);
    vm.runInContext(HELPER_SRC + '\nthis.result = isStaleAgentFrame;', sandbox);
    assert.equal(typeof sandbox.result, 'function', 'helper 未成功装载');
    return sandbox.result;
}

/* 假卡片：只需要 getAttribute('data-run-id') */
function card(runId) {
    return {
        getAttribute(name) {
            return name === 'data-run-id' ? (runId == null ? null : runId) : null;
        }
    };
}

/* 假会话：agentCards 按 key 索引 */
function sess(currentRunId, cards) {
    return { currentRunId: currentRunId, agentCards: cards || {} };
}

const isStale = makeHelper();

/* ===== 一、核心判据 ===== */

test('同一轮的卡片不是陈旧帧：正常前台场景不得被误杀', () => {
    // 这是最要紧的一条。正常前台子代理期间主代理仍 isStreaming=true，
    // 旧实现一度想用 sess.isStreaming 当判据——那会把**必要**的收敛一并跳过，
    // 造成「卡片收不掉、正文跑进卡片」的反向回归。
    const s = sess('run-1', { 'task-1': card('run-1') });
    assert.equal(isStale(s, { invocationId: 'task-1' }), false);
});

test('上一轮的卡片是陈旧帧：迟到帧必须被拦', () => {
    // 用户停止后立刻发新消息：卡片属 run-1，主代理已在 run-2。
    const s = sess('run-2', { 'task-1': card('run-1') });
    assert.equal(isStale(s, { invocationId: 'task-1' }), true);
});

test('currentRunId 已被迟到帧自己覆写时仍能认出陈旧（首版漏掉的真实场景）', () => {
    // 真实浏览器探针抓出的根因：onWebChunk 在进入 switch 前无条件执行
    //   if (chunk.runId) sess.currentRunId = chunk.runId
    // （app-streaming.js:838）。于是迟到帧一到，currentRunId 就是它自己的 runId，
    // 拿 card-run-id 比 currentRunId 恒相等 → 首版判据完全没生效（真浏览器 3 条断言红）。
    // activeRunId 被那段代码刻意排除在 agent 帧之外（:840-841），才代表主代理真实在跑哪一轮。
    const s = { activeRunId: 'run-2', currentRunId: 'run-1', agentCards: { 'task-1': card('run-1') } };
    assert.equal(isStale(s, { invocationId: 'task-1' }), true);
});

test('activeRunId 缺失时回退到 currentRunId（不得因缺字段而失效）', () => {
    const s = { currentRunId: 'run-2', agentCards: { 'task-1': card('run-1') } };
    assert.equal(isStale(s, { invocationId: 'task-1' }), true);
});

test('卡片尚未建房时不是陈旧帧（agent_start 的常态）', () => {
    // agent_start 到达时卡片还没建，此前恒为「查不到卡」。
    // 若这里返回 true，所有 agent_start 的收敛都会被跳过 → 新回归。
    const s = sess('run-1', {});
    assert.equal(isStale(s, { invocationId: 'task-1', agentName: 'explore' }), false);
});

test('缺任一侧 run 信息时退回旧行为（宁可不拦，也不误杀）', () => {
    // 当前无 runId
    assert.equal(isStale(sess(null, { 'task-1': card('run-1') }), { invocationId: 'task-1' }), false);
    assert.equal(isStale(sess('', { 'task-1': card('run-1') }), { invocationId: 'task-1' }), false);
    // 卡片没有 data-run-id（旧帧 / 回放重建的卡）
    assert.equal(isStale(sess('run-2', { 'task-1': card(null) }), { invocationId: 'task-1' }), false);
    // 参数或会话缺失
    assert.equal(isStale(sess('run-2', {}), null), false);
    assert.equal(isStale(null, { invocationId: 'task-1' }), false);
    // 会话无 agentCards 表
    assert.equal(isStale({ currentRunId: 'run-2' }, { invocationId: 'task-1' }), false);
});

test('keys 解析与 resolveAgentState 同源：invocationId 优先，name:desc 兜底', () => {
    // 主键命中
    const s1 = sess('run-2', { 'inv-9': card('run-1') });
    assert.equal(isStale(s1, { invocationId: 'inv-9', agentName: 'explore' }), true);
    // 命中主键但卡片无 run-id（回放重建的卡）时保守返回 false：不因缺信息而误拦
    const s2 = sess('run-2', {
        'inv-9': card(null),
        'explore:扫日志': card('run-1')
    });
    assert.equal(
        isStale(s2, { invocationId: 'inv-9', agentName: 'explore', description: '扫日志' }),
        false,
        '主键卡片已存在时不得改走 legacy 键：保守不拦，避免拿别的卡去比对'
    );
    // 主键完全查不到时，才回退到 legacy 键
    const s2b = sess('run-2', { 'explore:扫日志': card('run-1') });
    assert.equal(isStale(s2b, { invocationId: 'inv-9', agentName: 'explore', description: '扫日志' }), true);
    // description 缺省按空串处理（与 appendAgentBadge 的 agentId 构造一致）
    const s3 = sess('run-2', { 'explore:': card('run-1') });
    assert.equal(isStale(s3, { agentName: 'explore' }), true);
});

/* ===== 二、接线：两个消费点都必须走这个 helper =====
   行为测试只证明 helper 本身对。若有人把调用点改回只看 args.background，
   上面全绿而线上缺陷复发——这一层断言就是为那种「假绿」准备的。 */

test('两处消费点都经由 isStaleAgentFrame 判定，判据不得漂移', () => {
    // app-streaming.js：agent_start/agent_end 的收敛分支
    const streamCase = STREAM_SRC.slice(
        STREAM_SRC.indexOf("case 'agent_start':"),
        STREAM_SRC.indexOf("case 'agent_start':") + 1200
    );
    assert.ok(streamCase.includes('isBgAgentFrame'), '收敛分支丢了后台帧判据');
    assert.ok(
        streamCase.includes('isStaleAgentFrame(sess, chunk.args)'),
        '收敛分支未接入陈旧帧判据：迟到的前台 agent_end 会再次把新一轮思考块提前定稿'
    );

    // app-message.js：收卡时重建正文指针的分支
    const badgeStart = MSG_SRC.indexOf('function appendAgentBadge');
    assert.ok(badgeStart > 0, 'appendAgentBadge 定义丢失');
    const badge = MSG_SRC.slice(badgeStart, badgeStart + 8000);
    assert.ok(badge.includes('isStaleAgentFrame(sess, chunk.args)'), '收卡分支未接入陈旧帧判据');
    // 重建必须同时让两条路径受限，否则 reasonBuffer 仍会被清空
    assert.ok(
        /!agentCardStaleRun/.test(badge),
        '重建指针必须同时受陈旧帧判据约束，否则新 run 的 reasonBuffer 仍会被清空'
    );
});

test('helper 只有一份实现，且定义在顶层作用域（可被 onWebChunk 调用）', () => {
    const defs = MSG_SRC.split('function isStaleAgentFrame(').length - 1;
    assert.equal(defs, 1, 'helper 出现多份实现 → 判据会漂移');
    assert.ok(
        MSG_SRC.includes('\nfunction isStaleAgentFrame('),
        'helper 必须顶格定义：嵌在别的函数体里会让 app-streaming.js 调用时 ReferenceError，'
        + '并被 onWebChunk 的 try/catch 静默吞掉'
    );
});
