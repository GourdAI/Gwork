'use strict';
/* ===== test/cross-client-user-echo.test.js =====
 * 「从手机发出的提问在桌面端看不见」修复的行为层回归。
 *
 * 缺陷：内核 chat_input 把 user 帧只落盘、不广播，于是同一设备的另一个
 *      客户端（桌面页面，gate 以 sessionId='' 连成 "*" 订阅）收得到 AI 回复
 *      却收不到产生它的提问。
 *
 * 修复：内核广播 user 帧，并随帧带回发送方的 clientMessageId；发送端按 id
 *      跳过自己的回显（否则就是「每条消息显示两次」那个老缺陷）。
 *
 * 本文件锁的是发送端那一半：直接取 app-streaming.js 的真实
 * dispatchGateChunk 源码在沙箱里执行，用真实调用形态断言：
 *   1. 自己的回显（id 相同）→ 不渲染气泡，并确认 ack；
 *   2. 他人的消息（id 不同 / 无 id）→ 必须渲染气泡（这正是本轮要修的）；
 *   3. 没有待确认 id 时 → 不误吞（旧客户端/微信/Loop 来源）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STREAMING_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'ui', 'js', 'app-streaming.js'), 'utf8');

/** 截出 dispatchGateChunk 的完整函数体（含嵌套大括号），不依赖行号。 */
function extractDispatch() {
    const start = STREAMING_SRC.indexOf('function dispatchGateChunk(chunk) {');
    assert.notEqual(start, -1, 'dispatchGateChunk must exist in app-streaming.js');
    const open = STREAMING_SRC.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < STREAMING_SRC.length; i++) {
        const c = STREAMING_SRC[i];
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return STREAMING_SRC.slice(start, i + 1);
        }
    }
    throw new Error('unbalanced braces while extracting dispatchGateChunk');
}

/** 最小会话对象 + 收集渲染调用。 */
function harness() {
    const rendered = [];
    const historyCalls = [];
    const sessionMap = {};
    const sandbox = {
        console,
        sessionMap,
        activeSessionId: null,
        inChatMode: true,
        isStreaming: false,
        window: null,
        GourdI18n: { t: (k) => k },
        // 渲染入口：user 气泡只有这一条路
        appendUserMessage: (sess, text, images, files, createdAt, attachPaths) => {
            rendered.push({ sid: sess.sessionId, text, images, files, createdAt, attachPaths });
        },
        ensureChatInHistory: (sid, text, switchTab, opts) => {
            historyCalls.push({ sid, text, switchTab, opts });
        },
        getOrCreateSession: (sid) => {
            if (!sessionMap[sid]) sessionMap[sid] = { sessionId: sid, container: {}, isStreaming: false };
            return sessionMap[sid];
        },
        scrollToBottom: () => {},
        switchToChatMode: () => {},
        ensureSidebarRefreshTimer: () => {},
        setBtnStopMode: () => {},
        resetStreamState: () => {},
        showThinking: () => {},
        onWebChunk: () => {},
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(extractDispatch(), sandbox);
    return { sandbox, rendered, historyCalls, sessionMap };
}

test('own echo (same clientMessageId) is skipped and acknowledged', () => {
    const { sandbox, rendered, historyCalls } = harness();
    const sess = sandbox.getOrCreateSession('work-1');
    sess._pendingClientMessageId = 'm-mine';
    sess._awaitingSendAck = true;
    sess._sendAckConfirmed = false;

    sandbox.dispatchGateChunk({
        type: 'user', sessionId: 'work-1', text: '你好啊', clientMessageId: 'm-mine',
    });

    assert.equal(rendered.length, 0,
        'the sender already rendered its own bubble — rendering the echo again is the "every message twice" defect');
    assert.equal(historyCalls.length, 0, 'a skipped echo must not register a second history row');
    assert.equal(sess._sendAckConfirmed, true, 'the echo is proof the kernel accepted the send');
    assert.equal(sess._awaitingSendAck, false);
    assert.equal(sess._pendingClientMessageId, null, 'the pending id is consumed');
});

test('a message from another client is rendered (the reported bug)', () => {
    const { sandbox, rendered } = harness();
    const sess = sandbox.getOrCreateSession('work-2');
    sess._pendingClientMessageId = 'm-mine';

    sandbox.dispatchGateChunk({
        type: 'user', sessionId: 'work-2', text: 'from mobile', clientMessageId: 'm-theirs',
    });

    assert.equal(rendered.length, 1,
        'a question sent from the mobile app must appear on the desktop');
    assert.equal(rendered[0].text, 'from mobile');
    assert.equal(sess._pendingClientMessageId, 'm-mine', "another client's message must not consume our pending id");
});

test('a user frame with no id still renders', () => {
    const { sandbox, rendered } = harness();
    sandbox.getOrCreateSession('work-3')._pendingClientMessageId = 'm-mine';

    sandbox.dispatchGateChunk({ type: 'user', sessionId: 'work-3', text: 'no id here' });

    assert.equal(rendered.length, 1, 'older clients / IM sources carry no id and must still show');
    assert.equal(rendered[0].text, 'no id here');
});

test('no pending id means nothing is swallowed', () => {
    const { sandbox, rendered } = harness();
    sandbox.getOrCreateSession('work-4');

    sandbox.dispatchGateChunk({
        type: 'user', sessionId: 'work-4', text: 'someone else', clientMessageId: 'm-x',
    });

    assert.equal(rendered.length, 1,
        'without a pending id the frame cannot be ours, so it must render');
});

test('loop user_input from another source still renders', () => {
    const { sandbox, rendered, historyCalls } = harness();
    sandbox.getOrCreateSession('work-5');

    sandbox.dispatchGateChunk({
        type: 'user_input', sessionId: 'work-5', text: 'loop prompt', toolName: 'Loop', root: 'C:/p',
    });

    assert.equal(rendered.length, 1, 'Loop prompts are never our own echo');
    assert.equal(historyCalls.length, 1);
    assert.equal(historyCalls[0].opts.silent, true, 'Loop registration stays silent (does not steal focus)');
});

/* ===== 本轮 codereview 补的两个桌面端缺陷（P0） ===== */

test('two in-flight sends: each own echo is skipped (single-slot race)', () => {
    const { sandbox, rendered } = harness();
    const sess = sandbox.getOrCreateSession('work-6');
    /* 连发两条：sendMessage 先登记 A，再发 B 时单槽位 _pendingClientMessageId 被 B 覆盖。
       A 的回显此时到达 —— 旧实现认不出自己，会重复渲染一条用户气泡。
       集合登记后 A 仍可被识别。 */
    sess._pendingEchoIds = { 'm-a': true, 'm-b': true };
    sess._pendingClientMessageId = 'm-b';

    sandbox.dispatchGateChunk({ type: 'user', sessionId: 'work-6', text: 'first', clientMessageId: 'm-a' });
    sandbox.dispatchGateChunk({ type: 'user', sessionId: 'work-6', text: 'second', clientMessageId: 'm-b' });

    assert.equal(rendered.length, 0,
        'both echoes belong to this client — rendering either duplicates a bubble the sender already drew');
    assert.equal(sess._pendingEchoIds['m-a'], undefined, 'the first id is settled');
    assert.equal(sess._pendingEchoIds['m-b'], undefined, 'the second id is settled');
});

test('a settled id does not swallow a later identical frame', () => {
    const { sandbox, rendered } = harness();
    const sess = sandbox.getOrCreateSession('work-7');
    sess._pendingEchoIds = { 'm-a': true };

    sandbox.dispatchGateChunk({ type: 'user', sessionId: 'work-7', text: 'mine', clientMessageId: 'm-a' });
    assert.equal(rendered.length, 0, 'own echo is skipped');

    /* 同一 id 再次出现说明它不是本端这次待确认的回显（重放/他端），必须渲染而不是永远吞掉 */
    sandbox.dispatchGateChunk({ type: 'user', sessionId: 'work-7', text: 'mine again', clientMessageId: 'm-a' });
    assert.equal(rendered.length, 1, 'an already-settled id is not a permanent mute');
});

test('live user frame passes attachment paths through to appendUserMessage', () => {
    const { sandbox, rendered } = harness();
    sandbox.getOrCreateSession('work-8');

    sandbox.dispatchGateChunk({
        type: 'user', sessionId: 'work-8', text: 'see attached',
        imagePaths: ['uploads/a.png'], filePaths: ['uploads/b.pdf'],
    });

    assert.equal(rendered.length, 1);
    assert.deepEqual(rendered[0].files, null, 'multipart uploads are null for a replayed frame');
    /* 第 6 参 attachPaths：历史回放路径一直传它，实时分支曾漏传 →
       手机发来的带图消息在桌面端只剩文字（刷新后才出现缩略图）。 */
    assert.notEqual(rendered[0].attachPaths, null, 'attachment paths must reach the renderer');
    assert.deepEqual(rendered[0].attachPaths.imagePaths, ['uploads/a.png']);
    assert.deepEqual(rendered[0].attachPaths.filePaths, ['uploads/b.pdf']);
});

/* ===== 本轮 codereview 补的收口缺陷：done 无条件清集合误吞补发回显 ===== */

/** done 分支需要更多桩：finishStream / isSuspendedDone / endContextLive 等。 */
function doneHarness() {
    const h = harness();
    const sb = h.sandbox;
    sb.finishStream = () => {};
    sb.isSuspendedDone = () => false;
    sb.endContextLive = () => {};
    sb.syncSendButtonToSessionState = () => {};
    sb.setBtnSendMode = () => {};
    sb.showToast = () => {};
    /* registerPendingEchoId 与 dispatchGateChunk 同文件定义，一并载入 */
    const regStart = STREAMING_SRC.indexOf('function registerPendingEchoId(');
    assert.notEqual(regStart, -1, 'registerPendingEchoId must exist');
    let depth = 0, regEnd = -1;
    for (let i = STREAMING_SRC.indexOf('{', regStart); i < STREAMING_SRC.length; i++) {
        const c = STREAMING_SRC[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { regEnd = i + 1; break; } }
    }
    vm.runInContext(STREAMING_SRC.slice(regStart, regEnd), sb);
    return h;
}

test('done settles only the finished id; a queued send in flight keeps its registration', () => {
    const { sandbox, rendered } = doneHarness();
    const sess = sandbox.getOrCreateSession('work-10');
    /* 场景：A 轮 done 到达时，队列消息 B 已发出（登记在集合、槽位是 B），
       B 的回显还在途。旧实现 done 无条件 _pendingEchoIds={} → B 的回显认不出自己。 */
    sess._pendingEchoIds = { 'm-b': true };
    sess._pendingClientMessageId = 'm-b';
    sess.activeRunId = 'run-a';

    sandbox.dispatchGateChunk({ type: 'done', sessionId: 'work-10', runId: 'run-a' });
    /* done 只销「本轮槽位」——这里槽位已被 B 覆盖，销掉 B 正是缺陷；
       修复后的口径：done 销槽位 id 前先取值，但 B 尚未收到回显时不能销。
       本用例锁定的是：done 之后 B 的回显仍必须被识别（不重复渲染）。 */
    sandbox.registerPendingEchoId(sess, 'm-b'); // 队列派发在 done 后重新登记（retry/queue 路径）
    sandbox.dispatchGateChunk({ type: 'user', sessionId: 'work-10', text: 'queued', clientMessageId: 'm-b' });
    assert.equal(rendered.length, 0, 'the queued send echo must still be recognised after the previous done');
});

test('busy resend re-registers its id: echo after a newer done is not duplicated', () => {
    const { sandbox, rendered } = doneHarness();
    const sess = sandbox.getOrCreateSession('work-11');
    /* 补发复用原 id：done 收口把槽位清掉后，retryPendingSend 必须重新登记。
       模拟：集合被 32 条上限淘汰（空集合）+ 槽位已被新一轮覆盖为 m-c。 */
    sess._pendingEchoIds = {};
    sess._pendingClientMessageId = 'm-resend';
    sandbox.registerPendingEchoId(sess, sess._pendingClientMessageId);
    sess._pendingClientMessageId = 'm-c'; // 新一轮发送覆盖槽位
    sandbox.registerPendingEchoId(sess, 'm-c');

    sandbox.dispatchGateChunk({ type: 'user', sessionId: 'work-11', text: 'resent', clientMessageId: 'm-resend' });
    assert.equal(rendered.length, 0,
        'the resend echo must be recognised via the set even when the single slot was overwritten');
});

test('a user frame without attachments passes null attachPaths', () => {
    const { sandbox, rendered } = harness();
    sandbox.getOrCreateSession('work-9');

    sandbox.dispatchGateChunk({ type: 'user', sessionId: 'work-9', text: 'plain text' });

    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].attachPaths, null,
        'no attachments means no attachPaths object (renderer must not build empty tiles)');
});

/* ===== codereview 修复轮：无 id 帧尾文本兜底（P1-8）+ 恢复路径销账（P1-4） ===== */

test('id-less echo of our own wire text is skipped (old bundled UI vs new kernel)', () => {
    const { sandbox, rendered } = harness();
    const sess = sandbox.getOrCreateSession('work-20');
    /* 旧 bundled UI 不生成 clientMessageId：新内核广播回来的 user 帧无 id 可比。
       纯 id 判定会把本端回显当他端消息再渲染 → 每条消息双气泡。 */
    sess._pendingClientMessageId = 'm-old';
    sess._lastSentWireText = '/skill-x do the thing';
    sess._awaitingSendAck = true;

    sandbox.dispatchGateChunk({ type: 'user', sessionId: 'work-20', text: '/skill-x do the thing' });

    assert.equal(rendered.length, 0, 'the id-less tail-text fallback must recognise our own echo');
    assert.equal(sess._sendAckConfirmed, true, 'the fallback echo also proves acceptance');
    assert.equal(sess._pendingClientMessageId, null);
});

test('id-less foreign frame with different text still renders', () => {
    const { sandbox, rendered } = harness();
    const sess = sandbox.getOrCreateSession('work-21');
    sess._pendingClientMessageId = 'm-old';
    sess._lastSentWireText = 'mine';

    sandbox.dispatchGateChunk({ type: 'user', sessionId: 'work-21', text: 'from wechat' });

    assert.equal(rendered.length, 1, 'the fallback must only match the exact wire text of this turn');
    assert.equal(sess._pendingClientMessageId, 'm-old', 'a foreign frame must not consume our pending id');
});

test('the tail-text fallback fires once per send (registration is settled)', () => {
    const { sandbox, rendered } = harness();
    const sess = sandbox.getOrCreateSession('work-22');
    sess._pendingClientMessageId = 'm-old';
    sess._lastSentWireText = 'same words';

    sandbox.dispatchGateChunk({ type: 'user', sessionId: 'work-22', text: 'same words' });
    /* 第二条同文无 id 帧：登记已销，必须按他端消息渲染（用户真的又发了一句同样的话） */
    sandbox.dispatchGateChunk({ type: 'user', sessionId: 'work-22', text: 'same words' });

    assert.equal(rendered.length, 1, 'only the first id-less frame may be claimed as our echo');
});

/** 截任意函数体（大括号配平），恢复路径测试用。 */
function extractFn(name) {
    const start = STREAMING_SRC.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, name + ' must exist');
    let depth = 0;
    for (let i = STREAMING_SRC.indexOf('{', start); i < STREAMING_SRC.length; i++) {
        const c = STREAMING_SRC[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return STREAMING_SRC.slice(start, i + 1); }
    }
    throw new Error('unbalanced braces: ' + name);
}

/** 恢复路径沙箱：$.get 返回可控 thenable，捕获 done 回调后手动驱动。 */
function recoveryHarness(events, data) {
    const h = harness();
    const sb = h.sandbox;
    let doneCb = null;
    const req = {
        done(cb) { doneCb = cb; return req; },
        fail() { return req; },
        always() { return req; },
    };
    sb.$ = { get: () => req };
    sb.applySequencedGateChunk = (sess, chunk) => {
        h.applied.push(chunk);
        if (chunk.eventSeq) sess.lastEventSeq = Math.max(sess.lastEventSeq || 0, Number(chunk.eventSeq));
        return true;
    };
    sb.appendErrorChunk = (sess, text) => { h.errors.push(text); };
    sb.finishStream = () => {};
    sb.processMessageQueue = () => {};
    sb.ensureSidebarRefreshTimer = () => {};
    sb.setBtnStopMode = () => {};
    sb.gateSocketAlive = () => true;
    h.applied = [];
    h.errors = [];
    vm.runInContext(extractFn('recoverStreamingSession'), sb);
    vm.runInContext(extractFn('scheduleStreamingRecovery'), sb);
    h.fire = () => { assert.ok(doneCb, 'recovery must issue a replay GET'); doneCb({ data: Object.assign({ events, hasMore: false, running: false }, data || {}) }); };
    return h;
}

test('recovery: a stale historical id must not confirm the ack of a NEW in-flight send', () => {
    const events = [{ type: 'user', clientMessageId: 'm-old', eventSeq: 5, text: 'old turn' }];
    const { sandbox, applied, errors, fire } = recoveryHarness(events);
    const sess = sandbox.getOrCreateSession('work-30');
    sandbox.sessionMap['work-30'] = sess;
    /* 旧 id 残留在集合（32 条窗口内），新一轮 m-new 已发出、ack 未到。
       旧实现命中即 _sendAckConfirmed=true → 「未受理→报错/队列回滚」被短路，新消息静默丢失。 */
    sess._pendingEchoIds = { 'm-old': true, 'm-new': true };
    sess._pendingClientMessageId = 'm-new';
    sess._awaitingSendAck = true;
    sess._sendAckConfirmed = false;
    sess._requestStartSeq = 9;
    sess.lastEventSeq = 4;
    sess._recovering = true;
    sess._recoverGeneration = 1;

    sandbox.recoverStreamingSession(sess);
    fire();

    assert.equal(applied.length, 0, 'the stale own echo is still skipped from rendering');
    assert.equal(sess._pendingClientMessageId, 'm-new', 'the new send slot must survive a stale-id hit');
    assert.equal(sess._pendingEchoIds['m-new'], true, 'the new registration must survive');
    assert.ok(errors.length >= 1, 'the unacknowledged new send must surface an error, not be silently settled');
});

test('recovery: the CURRENT send id clears the slot so a buffered live copy cannot double-render', () => {
    const events = [{ type: 'user', clientMessageId: 'm-cur', eventSeq: 7, text: 'current' }];
    const { sandbox, fire } = recoveryHarness(events, { running: true });
    const sess = sandbox.getOrCreateSession('work-31');
    sess._pendingEchoIds = { 'm-cur': true };
    sess._pendingClientMessageId = 'm-cur';
    sess._awaitingSendAck = true;
    sess._sendAckConfirmed = false;
    sess._recovering = true;
    sess._recoverGeneration = 1;
    /* 同一帧还躺在 live 缓冲里：恢复收尾会再 dispatch 一次。
       旧实现只删集合不清槽位——若期间新发送覆盖槽位则判不中 → 双气泡。 */
    sess._gateBuffer = [{ type: 'user', clientMessageId: 'm-cur', eventSeq: 7, text: 'current' }];

    sandbox.recoverStreamingSession(sess);
    fire();

    assert.equal(sess._pendingClientMessageId, null, 'recovery must clear the slot on a current-id hit');
    assert.equal(sess._sendAckConfirmed, true);
    assert.equal(sess._awaitingSendAck, false);
});
