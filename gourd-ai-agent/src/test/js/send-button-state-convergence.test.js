/**
 * 契约测试：发送按钮状态收敛（「任务结束但按钮停在停止态」修复）
 *
 * 缺陷形态（用户可复现）：任务已结束，对话区发送按钮仍显示停止图标；
 * 切换会话再切回即恢复 —— 因为切换时 setActiveSession 按会话态重置了按钮，
 * 而全局 isStreaming / 按钮本体卡在了停止态。
 *
 * 根因：finishStream 把 sess.isStreaming = false 写在函数开头（第 904 行附近），
 * 而按钮复位（isStreaming = false; setBtnSendMode()）排在函数末尾（第 1029 行附近），
 * 中间隔着上百行 DOM 收尾链（强刷渲染/高亮/mermaid/孤儿卡清扫/批次收尾/resetStreamState）。
 * 链中任何一步抛异常（异常被 onmessage/applySequencedGateChunk/drainGateBuffer 吞掉只留痕），
 * 尾部复位就永远执行不到。且看门狗/对账都以 sess.isStreaming 为介入门槛 ——
 * 状态已置 false 的会话它们直接跳过，形成「永久卡死、无自愈」。
 *
 * 修复契约（方案A：前置复位）：
 * 1) finishStream 状态落盘后【立即】同步全局按钮态（syncSendButtonToSessionState），
 *    不再依赖函数尾部；
 * 2) DOM 收尾链（purgeEmptyMdBlocks / scrollToBottom / focus）包 try/catch，
 *    异常只留痕不上抛；
 * 3) 看门狗新增背离校正：会话已结束但全局按钮仍停止态 → 直接同步复位；
 *    【回归锁】回放守卫（_replaying）必须先于背离校正：回放期间（尤其流式进行中
 *    触发加载更多的 prepend 回放）「全局 true + 会话 false」是合法瞬态，分片回放
 *    跨多个 rAF 帧、后台标签页可达分钟级，若校正先于回放守卫执行，会把正在流式
 *    输出的会话按钮误复位成发送态；
 * 4) dispatchGateChunk 对「会话已删除」的 done 帧补最小复位（哑帧免疫）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');

const streaming = readStatic('js', 'app-streaming.js');
const base = readStatic('js', 'app-base.js');

/* 提取单个函数体：从 `function name(` 起，按花括号配平截到函数结束 */
function fnBody(source, name) {
    const start = source.indexOf('function ' + name + '(');
    assert.ok(start >= 0, `未找到函数: ${name}`);
    let depth = 0;
    let seen = false;
    for (let i = start; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') { depth++; seen = true; } else if (ch === '}') {
            depth--;
            if (seen && depth === 0) return source.slice(start, i + 1);
        }
    }
    assert.fail(`函数体未配平: ${name}`);
}

/* ===== 契约 1：收敛函数存在且行为正确 ===== */

test('收敛函数 syncSendButtonToSessionState：非活动会话不动全局态，活动会话按会话态同步', () => {
    const fn = fnBody(streaming, 'syncSendButtonToSessionState');
    assert.ok(fn, 'syncSendButtonToSessionState 应存在');
    // 非活动会话：早退（后台会话收尾不得动当前会话的按钮）
    assert.match(fn, /if \(!sess \|\| !sess\.sessionId \|\| sess\.sessionId !== activeSessionId\) return;/);
    // 活动会话：全局态跟随会话真值，双向（true→停止态 / false→发送态）
    assert.match(fn, /isStreaming = !!sess\.isStreaming;/);
    assert.match(fn, /if \(isStreaming\) setBtnStopMode\(\);/);
    assert.match(fn, /else setBtnSendMode\(\);/);
});

/* ===== 契约 2：finishStream 前置复位（本修复核心） ===== */

test('finishStream：状态落盘后立即同步按钮，复位不排在 DOM 收尾链之后', () => {
    const fin = fnBody(streaming, 'finishStream');
    // 状态落盘
    const stateIdx = fin.indexOf('sess.isStreaming = false;');
    assert.ok(stateIdx >= 0, 'finishStream 应落盘会话流式态');
    // 前置复位调用点必须存在，且紧跟状态落盘（之间不得夹任何 DOM 操作）
    const syncIdx = fin.indexOf('syncSendButtonToSessionState(sess);');
    assert.ok(syncIdx > stateIdx, '状态落盘后必须调用同步收敛');
    // 之间只允许 silenceTimer 清理等零 DOM 语句：用「首个 DOM 类调用」锚定
    const between = fin.slice(stateIdx, syncIdx);
    const domCalls = between.match(/\$(sess|finishRoot|renderRoot|sess\.currentBubbleEl)\.|ensureAssistantBubble|getStreamMd|highlightCodeBlocks|processMermaidBlocks|resetStreamState|purgeEmptyMdBlocks|removeThinking|finishPendingTool/);
    assert.equal(domCalls, null,
        '状态落盘与按钮同步之间不得夹任何 DOM 操作（否则异常仍会打断复位）: ' + between.replace(/\s+/g, ' ').slice(0, 120));
});

test('finishStream：DOM 收尾链包异常防护，尾部滚动/聚焦失败不再吞掉收尾语义', () => {
    const fin = fnBody(streaming, 'finishStream');
    // purgeEmptyMdBlocks 防护
    const purgeIdx = fin.indexOf('purgeEmptyMdBlocks(renderRoot(sess));');
    assert.ok(purgeIdx >= 0, 'purgeEmptyMdBlocks 调用应存在');
    const purgeTry = fin.lastIndexOf('try {', purgeIdx);
    assert.ok(purgeTry >= 0 && purgeTry > fin.indexOf('resetStreamState(sess);'),
        'purgeEmptyMdBlocks 应包在 resetStreamState 之后的 try 中');
    assert.match(fin, /catch \(e\) \{ reportStreamPipelineError\('finishStream:purge'/);
    // 尾部滚动/聚焦防护
    assert.match(fin, /try \{\s*if \(!sess\._skipScroll\) scrollToBottom\(\);\s*chatInput\.focus\(\);\s*\} catch \(e\) \{ reportStreamPipelineError\('finishStream:tail'/);
});

/* ===== 契约 3：看门狗背离校正 ===== */

test('看门狗：会话已结束但全局按钮卡停止态时，直接校正而非跳过', () => {
    const wd = fnBody(streaming, 'startStreamWatchdog');
    // 背离校正分支：isStreaming=false 的会话不再被整体 continue 吞掉
    assert.match(wd, /if \(!sess\.isStreaming\) \{[\s\S]*?syncSendButtonToSessionState\(sess\);[\s\S]*?continue;/,
        '看门狗必须对「已结束但按钮未复位」的会话做背离校正');
    // 校正只针对活动会话（后台会话的按钮态本就属于当前活动会话）
    assert.match(wd, /sess\.sessionId === activeSessionId && isStreaming/);
    // 旧的单行门槛断言必须消失（它把已结束会话排除在看门狗视野之外）
    assert.doesNotMatch(wd, /if \(!sess \|\| !sess\.isStreaming \|\| sess\._replaying\) continue;/);
});

test('看门狗：回放守卫必须先于背离校正（否则误杀流式中的 prepend 回放窗口）', () => {
    const wd = fnBody(streaming, 'startStreamWatchdog');
    const replayGuardIdx = wd.indexOf('if (sess._replaying) continue;');
    const divergenceIdx = wd.indexOf('if (!sess.isStreaming)');
    assert.ok(replayGuardIdx >= 0, '回放守卫应存在');
    assert.ok(divergenceIdx >= 0, '背离校正分支应存在');
    assert.ok(replayGuardIdx < divergenceIdx,
        '回放守卫必须在背离校正之前：回放期间 sess.isStreaming 由回放机制临时编排' +
        '（入口置 false，replayDone 按快照恢复），此时「全局 true + 会话 false」是合法瞬态，' +
        '先做校正会把正在流式输出的会话按钮误复位');
});

/* ===== 契约 4：哑帧免疫 ===== */

test('dispatchGateChunk：会话已删除时 done 帧仍能复位卡死的停止态按钮', () => {
    const dispatch = fnBody(streaming, 'dispatchGateChunk');
    assert.match(dispatch, /if \(!sess\) \{[\s\S]*?if \(sid === activeSessionId && isStreaming\) \{[\s\S]*?setBtnSendMode\(\);[\s\S]*?\}[\s\S]*?return;/,
        'done 帧对已删除会话需补最小复位');
});

/* ===== 契约 5：既有行为不回退 ===== */

test('setActiveSession 仍按会话态重置按钮（用户切回会话即恢复的既有通道，不得破坏）', () => {
    const setActive = fnBody(base, 'setActiveSession');
    assert.match(setActive, /isStreaming = sess\.isStreaming;/);
    assert.match(setActive, /if \(isStreaming\) setBtnStopMode\(\);/);
    assert.match(setActive, /else setBtnSendMode\(\);/);
});

test('语言包：setBtnStopMode 依赖的 base.stop_generating 键存在（前置复位不改 i18n 契约）', () => {
    const locales = fs.readdirSync(path.join(staticRoot, 'locales')).filter(f => f.endsWith('.json'));
    assert.ok(locales.length >= 12, '应有至少 12 个语言包');
    for (const f of locales) {
        const dict = JSON.parse(readStatic('locales', f));
        assert.ok(dict && dict.base && dict.base.stop_generating,
            f + ' 缺 base.stop_generating');
    }
});

/* ===== 行为级验证：沙箱执行 finishStream 的状态时序（防「前置复位只是文本摆设」） ===== */

test('行为验证：finishStream 中段抛异常时按钮仍被复位（旧代码在此场景卡死）', () => {
    // 从真实源码提取 finishStream + syncSendButtonToSessionState，最小桩环境执行
    const syncFn = fnBody(streaming, 'syncSendButtonToSessionState');
    const finFn = fnBody(streaming, 'finishStream');

    let mode = null; // 记录按钮最终态
    const calls = { purge: 0, scroll: 0 };
    const setStop = () => { mode = 'stop'; };
    const setSend = () => { mode = 'send'; };
    const stubs = {
        reportStreamPipelineError: () => {},
        clearRetryChunk: () => {},
        renderRoot: () => null,
        purgeEmptyMdBlocks: () => { calls.purge++; throw new Error('BOOM: DOM 收尾链中段异常'); },
        resetStreamState: () => {},
        scrollToBottom: () => { calls.scroll++; },
        chatInput: { focus: () => {} },
        updateHistoryUI: () => {},
        window: {},
        $: () => ({ find: () => ({ each: () => {} }) }),
        removeThinking: () => {}, purgeInlineThinking: () => {}, finishThinkingBlock: () => {},
        finishAgentThinkingBlock: () => {}, finishPendingTool: () => {},
        setAssistantTime: () => {},
    };
    const factory = new Function(
        'activeSessionId', 'isStreaming', 'PHASE_DONE', 'setBtnStopMode', 'setBtnSendMode',
        'reportStreamPipelineError', 'clearRetryChunk', 'renderRoot', 'purgeEmptyMdBlocks',
        'resetStreamState', 'scrollToBottom', 'chatInput', 'updateHistoryUI', 'window', '$',
        'removeThinking', 'purgeInlineThinking', 'finishThinkingBlock', 'finishAgentThinkingBlock',
        'finishPendingTool', 'setAssistantTime',
        syncFn + '\n' + finFn + '\nreturn { finishStream: finishStream };'
    );

    const sess = { sessionId: 's1', isStreaming: true, silenceTimer: null, phase: '', _skipScroll: false };

    const run = factory(
        's1', true, 'done', setStop, setSend,
        stubs.reportStreamPipelineError, stubs.clearRetryChunk, stubs.renderRoot, stubs.purgeEmptyMdBlocks,
        stubs.resetStreamState, stubs.scrollToBottom, stubs.chatInput, stubs.updateHistoryUI, stubs.window, stubs.$,
        stubs.removeThinking, stubs.purgeInlineThinking, stubs.finishThinkingBlock, stubs.finishAgentThinkingBlock,
        stubs.finishPendingTool, stubs.setAssistantTime
    );
    run.finishStream(sess, {});
    assert.equal(sess.isStreaming, false, '会话态应已结束');
    assert.equal(mode, 'send', 'DOM 收尾链中段异常时按钮仍应被复位为发送态（核心修复点）');
    assert.ok(calls.purge >= 1, '异常注入点应确实被执行到');
});

/* ===== 行为级验证：看门狗背离校正与回放守卫的时序（防「守卫顺序只是文本摆设」） ===== */

test('行为验证：回放窗口内看门狗不得误杀，回放结束后背离校正才生效', () => {
    // 从真实源码提取 startStreamWatchdog + syncSendButtonToSessionState，最小桩环境执行
    const syncFn = fnBody(streaming, 'syncSendButtonToSessionState');
    const wdFn = fnBody(streaming, 'startStreamWatchdog');

    let mode = 'stop'; // 模拟卡死的停止态
    const corrections = [];
    const setStop = () => { mode = 'stop'; };
    const setSend = () => { mode = 'send'; };

    // 桩 setInterval：把回调捕获到闭包变量（沙箱内声明，工厂返回 getter 读取）
    const stubsWindow = {};

    const factory = new Function(
        'activeSessionId', 'isStreaming', 'sessionMap', 'STREAM_STALL_MS', 'STREAM_WATCHDOG_INTERVAL',
        'setBtnStopMode', 'setBtnSendMode', 'console', 'window', 'setInterval',
        'Date', 'reconcileSessionRunning', 'syncSendButtonToSessionState',
        syncFn + '\n' + wdFn + '\nvar __tick = null;' +
        '\nreturn { startStreamWatchdog: function() { startStreamWatchdog(); }, tick: function() { if (__tick) __tick(); }, captureTick: function(fn) { __tick = fn; } };'
    );

    const sess = { sessionId: 's1', isStreaming: false, _replaying: true };
    const sessionMap = { s1: sess };

    const run = factory(
        's1', true, sessionMap, 20000, 15000,
        setStop, setSend, { warn: (m) => corrections.push(m) }, stubsWindow,
        // setInterval 桩：把 tick 回调捕获到沙箱内的 __tick
        (fn) => { run && run.captureTick(fn); return 1; },
        Date, () => { throw new Error('reconcile 不得在回放/已结束会话上触发'); }, (s) => {
            // 直接内联 sync 的行为，避免闭包引用问题：真实 sync 函数也已注入
            setSend();
            return true;
        }
    );

    run.startStreamWatchdog();

    // 场景1：回放中（_replaying=true，会话 isStreaming=false，全局 true）——合法背离，不得校正
    run.tick();
    assert.equal(mode, 'stop', '回放窗口内不得把正在流式输出的会话按钮误复位');
    assert.equal(corrections.length, 0, '回放窗口内不得触发背离校正告警');

    // 场景2：回放结束（_replaying 复位，liveState 恢复失败或恢复后仍 false 的残留）——应校正
    sess._replaying = false;
    sess.isStreaming = false;
    run.tick();
    assert.equal(mode, 'send', '回放结束后（真实残留）应立即校正为发送态');
    assert.ok(corrections.length >= 1, '应产生一次背离校正告警');
});
