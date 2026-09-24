/**
 * 回归：历史分页只由顶部按钮显式触发，且失败/切会话时请求状态完整收尾。
 *
 * 以受控 jQuery/jqXHR 与最小 DOM 替身执行 app-history.js 中真实的 loadMoreMessages、
 * updateLoadMoreBtn 和按钮 click handler；滚动入口也从同一真实源码区间加载并模拟。
 * 视口锁与 scrollToBottom 使用 app-base.js 的真实实现，覆盖在途手动滚动及 gate 收尾时
 * 可能发生的 force-scroll，不以源码字符串断言代替行为。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const historyJs = fs.readFileSync(
    path.resolve(__dirname, '../../main/resources/static/js/app-history.js'), 'utf8')
    .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const baseJs = fs.readFileSync(
    path.resolve(__dirname, '../../main/resources/static/js/app-base.js'), 'utf8')
    .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

/** Extract a real function declaration, balancing braces while ignoring comments and quoted strings. */
function extractFunction(source, name) {
    const marker = new RegExp('function\\s+' + name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '\\s*\\(');
    const match = marker.exec(source);
    assert.ok(match, `未找到函数 ${name}`);
    const open = source.indexOf('{', match.index);
    assert.ok(open >= 0, `${name} 没有函数体`);

    let depth = 0;
    let state = 'code';
    let escaped = false;
    for (let i = open; i < source.length; i++) {
        const c = source[i];
        const next = source[i + 1];
        if (state === 'single' || state === 'double' || state === 'template') {
            if (escaped) { escaped = false; continue; }
            if (c === '\\') { escaped = true; continue; }
            if ((state === 'single' && c === "'") || (state === 'double' && c === '"')
                    || (state === 'template' && c === '`')) state = 'code';
            continue;
        }
        if (state === 'line-comment') {
            if (c === '\n') state = 'code';
            continue;
        }
        if (state === 'block-comment') {
            if (c === '*' && next === '/') { state = 'code'; i++; }
            continue;
        }
        if (c === '/' && next === '/') { state = 'line-comment'; i++; continue; }
        if (c === '/' && next === '*') { state = 'block-comment'; i++; continue; }
        if (c === "'") { state = 'single'; continue; }
        if (c === '"') { state = 'double'; continue; }
        if (c === '`') { state = 'template'; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return source.slice(match.index, i + 1);
    }
    assert.fail(`${name} 函数体括号未配平`);
}

function extractHistoryPagingCode() {
    const configMatch = /var REPLAY_PAGE_ROUNDS\s*=\s*\d+;[\s\S]*?var _replayLoadMoreAnchorOwners\s*=\s*Object\.create\(null\);/.exec(historyJs);
    assert.ok(configMatch, '未找到分页配置及请求所有权状态');
    const declarations = [
        'drainReplayLoadMoreGate',
        'holdReplayLoadMoreAnchor',
        'startReplayLoadMoreAnchorRenewal',
        'stopReplayLoadMoreAnchorRenewal',
        'releaseReplayLoadMoreAnchor',
        'finishReplayLoadMore',
        'installReplayLoadMoreSessionHook',
        'loadMoreMessages',
        'updateLoadMoreBtn',
        'setLoadMoreBtnLoading',
        'beginGateBuffer',
        'drainGateBuffer',
        'loadMoreLoadingHtml'
    ].map(name => extractFunction(historyJs, name));

    const wiringStart = historyJs.indexOf('function updateLoadMoreBtn(sess) {');
    const wiringEnd = historyJs.indexOf('/* ===== 回放/实时流互斥门禁 =====', wiringStart);
    assert.ok(wiringStart >= 0 && wiringEnd > wiringStart, '未找到加载按钮与页面滚动入口源码区间');
    return [
        configMatch[0],
        'var REPLAY_PAGE_REQUEST_TIMEOUT_MS = 30000;',
        'var REPLAY_PAGE_ROUNDS = 5;',
        'var _replayLoadMoreRequestSeq = 0;',
        'var _replayLoadMoreAnchorOwners = Object.create(null);',
        'var REPLAY_PAGE_SCROLL_HOLD_REFRESH_MS = 4000;',
        'var setActiveSession = window.setActiveSession;',
        ...declarations,
        historyJs.slice(wiringStart, wiringEnd)
    ].join('\n\n');
}

function buildScrollHelpers(env) {
    const holdTimerMatch = /var _scrollAnchorHoldTimer\s*=\s*null\s*;/.exec(baseJs);
    assert.ok(holdTimerMatch, '未找到真实 scroll-anchor hold timer 声明');
    const code = [
        'var _scrollGen = 0;',
        'var _scrollAnchorHold = false;',
        holdTimerMatch[0],
        'var _scrollAnchorHoldGeneration = 0;',
        extractFunction(baseJs, 'scrollToBottom'),
        extractFunction(baseJs, 'holdScrollAnchor'),
        extractFunction(baseJs, 'releaseScrollAnchor'),
        extractFunction(baseJs, 'isScrollAnchorHeld'),
        'return { scrollToBottom: scrollToBottom, holdScrollAnchor: holdScrollAnchor,'
            + ' releaseScrollAnchor: releaseScrollAnchor, isScrollAnchorHeld: isScrollAnchorHeld };'
    ].join('\n\n');
    return new Function('__env', 'with (__env) { ' + code + ' }')(env);
}

function makeJqXHR() {
    let state = 'pending';
    let result;
    const doneCallbacks = [];
    const failCallbacks = [];
    const xhr = {
        done(callback) {
            if (state === 'resolved') callback.apply(null, result);
            else if (state === 'pending') doneCallbacks.push(callback);
            return xhr;
        },
        fail(callback) {
            if (state === 'rejected') callback.apply(null, result);
            else if (state === 'pending') failCallbacks.push(callback);
            return xhr;
        },
        resolve(value) {
            if (state !== 'pending') return;
            state = 'resolved';
            result = [value, 'success', xhr];
            doneCallbacks.slice().forEach(callback => callback.apply(null, result));
        },
        reject(status) {
            if (state !== 'pending') return;
            state = 'rejected';
            result = [xhr, status || 'error', new Error(status || 'request failed')];
            failCallbacks.slice().forEach(callback => callback.apply(null, result));
        },
        get state() { return state; }
    };
    return xhr;
}

function makeHarness() {
    const frames = [];
    const timers = new Map();
    let nextTimerId = 1;
    // 虚拟时钟：生产代码里的 Date.now()（分页看门狗）与定时器都由它推进，
    // 不用真 sleep，也能让「超时看门狗」这类时间语义变成可断言的行为。
    let clockMs = 0;
    const virtualDate = { now: () => clockMs };
    const requests = [];
    const legacyRequests = [];
    const replayCalls = [];
    const wrappers = new Map();
    const scrollHandlers = [];
    const wrap = {
        _scrollTop: 0,
        programmaticWrites: [],
        get scrollTop() { return this._scrollTop; },
        set scrollTop(value) {
            this._scrollTop = Number(value);
            this.programmaticWrites.push(this._scrollTop);
        },
        userScrollTo(value) {
            this._scrollTop = Number(value);
            scrollHandlers.slice().forEach(handler => handler.call(this));
        }
    };
    const env = {
        // 旧版「滚到顶部自动分页」钩子就搭在 messagesWrap 上；给宿土提供同一入口，
        // 测试才能用 userScrollTo 验证真没有白动路径（而不是只声明不存在）。
        messagesWrap: wrap,
        window: {
            setActiveSession: function (sessionId) {
                env.activeSessionId = sessionId;
                scroll.releaseScrollAnchor();
                return env.sessionMap[sessionId];
            }
        },
        document: { contains: element => !!element },
        activeSessionId: 'session-1',
        sessionMap: {},
        frames,
        requests,
        legacyRequests,
        replayCalls,
        scrollHandlers,
        anchorReleaseCalls: 0,
        holdDurations: [],
        ajaxThrows: false,
        Date: virtualDate,
        console: { error() {}, warn() {}, log() {} },
        GourdI18n: { t: key => key },
        sessionRootQ: sess => sess.projectRoot
            ? '&root=' + encodeURIComponent(sess.projectRoot) : '',
        requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
        setTimeout(callback, delay) {
            const id = nextTimerId++;
            timers.set(id, { callback, delay, repeat: false });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        setInterval(callback, delay) {
            const id = nextTimerId++;
            timers.set(id, { callback, delay, repeat: true });
            return id;
        },
        clearInterval(id) { timers.delete(id); },
        beginGateBuffer(sess) {
            if (!sess._gateBuffer) sess._gateBuffer = [];
            sess._gateBuffering = true;
        },
        drainGateBuffer(sess) {
            sess._gateBuffer = [];
            sess._gateBufferOverflowed = false;
            sess._gateBuffering = false;
            // 模拟实时 gate 排空过程中 done 帧触发的 force-scroll，必须受真实锚锁保护。
            if (sess._forceScrollOnDrain) env.scrollToBottom(true);
        },
        replaySession(sess, events, prepend) {
            replayCalls.push({ sess, events, prepend });
        }
    };

    function currentWrapper(container) { return wrappers.get(container) || null; }
    function buttonRef(button) {
        return {
            0: button,
            get length() { return button ? 1 : 0; },
            hasClass(name) { return !!button && button.classes.has(name); },
            addClass(name) { if (button) button.classes.add(name); return this; },
            html(value) {
                if (button && value !== undefined) button.html = value;
                return value === undefined ? (button ? button.html : undefined) : this;
            },
            on(event, callback) {
                if (button) button.handlers[event] = callback;
                return this;
            }
        };
    }
    function wrapperRef(wrapper) {
        return {
            get length() { return wrapper ? 1 : 0; },
            find() { return buttonRef(wrapper && wrapper.button); },
            insertBefore(container) {
                if (wrapper) {
                    wrapper.container = container;
                    wrapper.insertedBefore = container;
                    wrappers.set(container, wrapper);
                }
                return this;
            },
            remove() {
                if (wrapper && wrappers.get(wrapper.container) === wrapper) {
                    wrappers.delete(wrapper.container);
                    wrapper.removed = true;
                }
                return this;
            }
        };
    }
    function $(value) {
        if (typeof value === 'string' && value.indexOf('<div') === 0) {
            return wrapperRef({
                html: value,
                button: { __mockLoadMoreButton: true, classes: new Set(), handlers: {}, html: value }
            });
        }
        if (value === wrap) {
            return {
                on(event, callback) {
                    if (event === 'scroll') scrollHandlers.push(callback);
                    return this;
                }
            };
        }
        if (value && value.__mockLoadMoreButton) return buttonRef(value);
        if (value && value.__mockLoadMoreContainer) {
            return {
                prev() { return wrapperRef(currentWrapper(value)); }
            };
        }
        throw new Error('Unexpected jQuery test-double input');
    }
    $.ajax = options => {
        requests.push({ options, xhr: null });
        if (env.ajaxThrows) throw new Error('synchronous ajax failure');
        const xhr = makeJqXHR();
        requests[requests.length - 1].xhr = xhr;
        return xhr;
    };
    $.get = (url, success) => {
        const xhr = makeJqXHR();
        legacyRequests.push({ url, xhr });
        if (success) xhr.done(success);
        return xhr;
    };
    env.$ = $;
    // 必须在模块代码执行前捕获原始引用：installReplayLoadMoreSessionHook 会把 window.setActiveSession
    // 换成带锚锁续期钩子的 wrapper，执行后再读只会拿到 wrapper，造成 self-recursion。
    const baseSetActiveSession = env.window.setActiveSession;

    const scroll = buildScrollHelpers(env);
    env.scrollToBottom = scroll.scrollToBottom;
    env.holdScrollAnchor = function (duration) {
        env.holdDurations.push(duration);
        return scroll.holdScrollAnchor(duration);
    };
    env.releaseScrollAnchor = function () {
        env.anchorReleaseCalls++;
        return scroll.releaseScrollAnchor();
    };
    env.isScrollAnchorHeld = scroll.isScrollAnchorHeld;

    const api = new Function('__env', 'with (__env) { var setActiveSession = window.setActiveSession; '
        + extractHistoryPagingCode()
        + '\ninstallReplayLoadMoreSessionHook();'
        + '\nreturn { loadMoreMessages: loadMoreMessages, updateLoadMoreBtn: updateLoadMoreBtn,'
        + ' setLoadMoreBtnLoading: setLoadMoreBtnLoading, finishReplayLoadMore: finishReplayLoadMore,'
        + ' setActiveSession: setActiveSession, timeout: REPLAY_PAGE_REQUEST_TIMEOUT_MS,'
        + ' refreshMs: REPLAY_PAGE_SCROLL_HOLD_REFRESH_MS }; }')(env);

    function makeSession(sessionId, opts) {
        const session = Object.assign({
            sessionId,
            container: { __mockLoadMoreContainer: true, sessionId },
            _replayHasMore: true,
            _replayFirstSeq: 321,
            _replayRemainingRounds: 4,
            _gateBuffer: []
        }, opts || {});
        env.sessionMap[sessionId] = session;
        return session;
    }
    function currentButton(session) {
        const wrapper = currentWrapper(session.container);
        return wrapper && wrapper.button;
    }
    function clickButton(session) {
        const button = currentButton(session);
        assert.ok(button, `会话 ${session.sessionId} 应有顶部加载按钮`);
        const handler = button.handlers.click;
        assert.equal(typeof handler, 'function', '按钮应绑定真实 click handler');
        handler.call(button);
        return button;
    }
    function flushFrames() {
        for (let i = 0; i < 12 && frames.length; i++) {
            const batch = frames.splice(0, frames.length);
            batch.forEach(callback => callback());
        }
        assert.equal(frames.length, 0, '受控 rAF 应完成锚锁释放');
    }
    return {
        env, api, wrap, requests, legacyRequests, replayCalls, timers,
        makeSession, currentButton, clickButton, flushFrames,
        baseSetActiveSession,
        // 推进虚拟时钟（看门狗/锁安全阀的语义均基于此）
        advance(ms) { clockMs += ms; },
        // 触发指定 setInterval 的下一轮回调（仅对尚未被清理的句柄有效）
        fireInterval(id) {
            const timer = timers.get(id);
            assert.ok(timer, `定时器 ${id} 应仍存在`);
            assert.equal(timer.repeat, true, '只应手动触发重复定时器');
            timer.callback();
        },
        isAnchorHeld: scroll.isScrollAnchorHeld
    };
}

test('页面滚动不请求历史；点击顶部按钮才发起分页', () => {
    const h = makeHarness();
    const sess = h.makeSession('session-1');
    h.api.updateLoadMoreBtn(sess);

    h.wrap.userScrollTo(0);
    h.wrap.userScrollTo(900);
    h.wrap.userScrollTo(0);
    assert.equal(h.requests.length + h.legacyRequests.length, 0,
        '不论滚到顶部或向下滚动，页面 scroll 都不能自动加载历史');

    const button = h.clickButton(sess);
    assert.equal(h.requests.length, 1, '显式按钮 click 必须触发一次 replay 请求');
    assert.equal(h.legacyRequests.length, 0, '分页请求应使用带 timeout 的 $.ajax');
    assert.equal(h.requests[0].options.method, 'GET');
    assert.equal(h.requests[0].options.timeout, h.api.timeout);
    assert.equal(h.api.timeout, 30000);
    assert.equal(h.api.refreshMs, 4000);
    assert.match(h.requests[0].options.url, /beforeSeq=321/);
    assert.match(h.requests[0].options.url, /rounds=5/);
    assert.ok(button.classes.has('loading'), '请求在途期间按钮显示 loading');
    assert.match(button.html, /history\.loading/, '按钮 loading 内容应替换为空闲图标之外的 spinner 文案');
    assert.equal(sess._replayLoadMoreAnchorTimer != null, true, '请求中应启动锚锁续期定时器');
    assert.equal(sess._gateBuffering, true, '请求在途期间实时帧应缓冲');
    assert.equal(h.isAnchorHeld(), true, '请求在途期间自动滚动锚锁应保持');
    // 真实入口是 app-base.setActiveSession + 模块自己装上的 wrapper（api.setActiveSession）；
    // 不能拿测试替身直接覆盖 window，否则验证不到锚锁续期钩子。
    h.env.activeSessionId = 'session-other';
    h.api.setActiveSession('session-other');
    assert.equal(h.isAnchorHeld(), false, '切换到其他会话时全局锚锁应释放');
    h.env.activeSessionId = sess.sessionId;
    h.api.setActiveSession(sess.sessionId);
    assert.equal(h.isAnchorHeld(), true, '切回分页中的会话时 wrapper 必须恢复锚锁');
    assert.equal(h.api.loadMoreMessages(sess), false, '在途重复调用不得建立第二个请求');
    assert.equal(h.requests.length, 1);

    h.requests[0].xhr.reject('error');
    h.flushFrames();
});

test('分页事务看门狗：回放收尾缺席时自行解锁、恢复按钮并丢弃迟到响应', () => {
    const h = makeHarness();
    const sess = h.makeSession('session-1');
    h.api.updateLoadMoreBtn(sess);
    h.clickButton(sess);
    const request = h.requests[0];
    const timerId = sess._replayLoadMoreAnchorTimer;
    assert.ok(timerId, '在途请求应建立锁续期定时器');
    assert.equal(h.isAnchorHeld(), true);
    assert.equal(h.currentButton(sess).classes.has('loading'), true);

    // 超过看门狗上限（HTTP 超时 + 异步回放兼底余量）：模拟「响应已回但 replayDone 永不达」。
    h.advance(45001);
    h.fireInterval(timerId);

    assert.equal(sess._replayLoadingMore, false, '看门狗必须释放分页锁');
    assert.equal(sess._replayLoadingMoreToken, null);
    assert.equal(sess._replayLoadMoreAnchorTimer, null, '看门狗自身要停掉续期定时器');
    assert.equal(sess._gateBuffering, false, '看门狗要排空实时 gate');
    // 视口锁在收尾里由两帧 rAF 后释放（与 done 帧迟到的 force 滚动竞态相关），先推完帧。
    h.flushFrames();
    assert.equal(h.isAnchorHeld(), false, '看门狗必须释放视口锁，否则用户滚不回底部');
    assert.equal(h.currentButton(sess).classes.has('loading'), false,
        '按钮必须从「加载中」恢复为可点，不能永久停住 spinner');
    assert.equal(request.xhr.state, 'pending', '看门狗不强拆已发出的请求，仅释放 UI/锁');

    // 迟到成功响应：不得重新拿锁、不得再走 prepend 回放。
    request.xhr.resolve({ data: {
        events: [{ type: 'user', text: 'late page', eventSeq: 100 }],
        hasMore: true, remainingRounds: 3, firstSeq: 100
    } });
    assert.equal(h.replayCalls.length, 0, '超时后的迟到响应不得再写消息流');
    assert.equal(h.isAnchorHeld(), false, '迟到响应不得重新挂上视口锁');
    assert.equal(sess._replayLoadingMore, false);
    assert.equal(sess._replayLoadMoreAnchorTimer, null, '迟到响应不得重建续期定时器');

    // 看门狗后用户可自由回滚：手动滚到底部不会被任何收尾逻辑拉回顶部。
    h.wrap.userScrollTo(0);
    h.flushFrames();
    assert.equal(h.wrap.scrollTop, 0, '卡死解除后手动滚动必须生效');
    assert.deepEqual(h.wrap.programmaticWrites, [], '看门狗收尾不得写入 scrollTop');

    // 下一次点击仍能正常发起全新请求。
    assert.equal(h.api.loadMoreMessages(sess), true, '超时后入口应重新可用');
    assert.equal(h.requests.length, 2);
    h.requests[1].xhr.reject('error');
    h.flushFrames();
});

test('看门狗未到期时不得误伤在途请求', () => {
    const h = makeHarness();
    const sess = h.makeSession('session-1');
    h.api.updateLoadMoreBtn(sess);
    h.clickButton(sess);
    const timerId = sess._replayLoadMoreAnchorTimer;

    h.advance(40000);
    h.fireInterval(timerId);
    assert.equal(sess._replayLoadingMore, true, '未超 45s 的在途请求不应被看门狗取消');
    assert.equal(h.isAnchorHeld(), true);

    h.requests[0].xhr.reject('error');
    h.flushFrames();
});

test('网络失败与超时释放锁/gate、恢复按钮，并保留用户手动滚动位置', async t => {
    for (const failure of ['error', 'timeout']) {
        await t.test(failure, () => {
            const h = makeHarness();
            const sess = h.makeSession('session-1', { _forceScrollOnDrain: true });
            h.api.updateLoadMoreBtn(sess);
            h.clickButton(sess);
            const request = h.requests[0];
            assert.equal(request.options.timeout, 30000);

            h.wrap.userScrollTo(640);
            request.xhr.reject(failure);

            assert.equal(sess._replayLoadingMore, false, '失败后释放分页锁');
            assert.equal(sess._replayLoadMoreAnchorTimer, null, '失败后应停止定时续期');
            assert.equal(sess._gateBuffering, false, '失败后实时 gate 必须排空');
            assert.deepEqual(sess._gateBuffer, []);
            assert.equal(h.currentButton(sess).classes.has('loading'), false,
                '当前会话按钮应从 spinner 恢复为可点状态');
            assert.equal(h.wrap.scrollTop, 640, '失败 cleanup 不应覆盖用户手动滚动');

            // drainGateBuffer 中模拟一个 force-scroll done 帧，真实 app-base 锚锁应阻止它移位。
            h.flushFrames();
            assert.equal(h.isAnchorHeld(), false, '失败 cleanup 应最终释放滚动锚锁');
            assert.equal(h.wrap.scrollTop, 640, '释放锚锁前的 gate force-scroll 不得拉动用户视口');
            assert.deepEqual(h.wrap.programmaticWrites, [], '请求失败/收尾不得写入 scrollTop');
        });
    }
});

test('$.ajax 同步抛错也执行完整 cleanup', () => {
    const h = makeHarness();
    const sess = h.makeSession('session-1');
    h.api.updateLoadMoreBtn(sess);
    h.env.ajaxThrows = true;
    h.clickButton(sess);

    assert.equal(sess._replayLoadingMore, false);
    assert.equal(sess._replayLoadingMoreToken, null);
    assert.equal(sess._replayLoadMoreAnchorTimer, null, '请求结束需清除锚锁续期定时器');
    assert.equal(sess._gateBuffering, false);
    assert.deepEqual(sess._gateBuffer, []);
    assert.equal(h.currentButton(sess).classes.has('loading'), false);
    h.flushFrames();
    assert.equal(h.isAnchorHeld(), false);
});

test('旧分页的迟到锚锁续期回调不得清理同会话的新请求定时器', () => {
    const h = makeHarness();
    const sess = h.makeSession('session-1');
    h.api.updateLoadMoreBtn(sess);

    h.clickButton(sess);
    const firstRequest = h.requests[0];
    const firstTimerId = sess._replayLoadMoreAnchorTimer;
    const staleRenewal = h.timers.get(firstTimerId).callback;
    firstRequest.xhr.reject('error');
    h.flushFrames();
    assert.equal(sess._replayLoadMoreAnchorTimer, null);

    h.clickButton(sess);
    const secondRequest = h.requests[1];
    const secondTimerId = sess._replayLoadMoreAnchorTimer;
    assert.notEqual(secondTimerId, firstTimerId);
    assert.equal(h.timers.has(secondTimerId), true);

    staleRenewal();
    assert.equal(sess._replayLoadMoreAnchorTimer, secondTimerId,
        '旧事务的间隔回调不得覆盖或清理新事务的锚锁续期句柄');
    assert.equal(h.timers.has(secondTimerId), true);

    secondRequest.xhr.reject('error');
    h.flushFrames();
});

test('旧会话响应在切会话后只清理旧会话，不影响新请求/UI/锚锁', () => {
    const h = makeHarness();
    h.env.activeSessionId = 'session-old';
    const oldSession = h.makeSession('session-old');
    h.api.updateLoadMoreBtn(oldSession);
    h.clickButton(oldSession);
    const oldRequest = h.requests[0];

    const newSession = h.makeSession('session-new');
    h.env.activeSessionId = newSession.sessionId;
    h.env.releaseScrollAnchor(); // 与 setActiveSession 的会话切换语义一致
    h.api.updateLoadMoreBtn(newSession);
    h.clickButton(newSession);
    const newButton = h.currentButton(newSession);
    const newRequest = h.requests[1];
    assert.equal(newSession._replayLoadingMore, true);
    assert.equal(newButton.classes.has('loading'), true);
    assert.equal(h.isAnchorHeld(), true, '新会话请求应持有新的锚锁');

    oldRequest.xhr.resolve({ data: {
        events: [{ type: 'user', text: 'stale page', eventSeq: 1 }],
        hasMore: false, remainingRounds: 0, firstSeq: 1
    } });

    assert.equal(h.replayCalls.length, 0, '旧会话响应不可进入 replaySession 或改写活动会话');
    assert.equal(oldSession._replayLoadingMore, false);
    assert.equal(oldSession._gateBuffering, false);
    assert.equal(newSession._replayLoadingMore, true, '旧 cleanup 不可释放新会话分页锁');
    assert.equal(newSession._replayFirstSeq, 321);
    assert.equal(newSession._replayHasMore, true);
    assert.equal(h.currentButton(newSession), newButton);
    assert.equal(newButton.classes.has('loading'), true, '新会话 spinner 应保持');
    assert.equal(newRequest.xhr.state, 'pending');
    assert.equal(h.isAnchorHeld(), true, '旧会话 cleanup 不可释放新会话锚锁');

    newRequest.xhr.reject('error');
    h.flushFrames();
    assert.equal(h.isAnchorHeld(), false);
});

test('成功响应将真实分页事件交给 prepend replay，直到异步回放收尾才解锁', () => {
    const h = makeHarness();
    const sess = h.makeSession('session-1', { projectRoot: 'C:/work/project space' });
    h.api.updateLoadMoreBtn(sess);
    h.clickButton(sess);
    const request = h.requests[0];
    const events = [{ type: 'user', text: 'older message', eventSeq: 120 }];

    h.wrap.userScrollTo(480);
    request.xhr.resolve({ data: {
        events,
        hasMore: true,
        remainingRounds: 7,
        firstSeq: 120
    } });

    assert.deepEqual(h.replayCalls, [{ sess, events, prepend: true }]);
    assert.equal(sess._replayFirstSeq, 120);
    assert.equal(sess._replayRemainingRounds, 7);
    assert.equal(sess._replayLoadingMore, true, 'HTTP 成功不应早于异步 prepend replay 解锁');
    assert.equal(sess._gateBuffering, true, '实时 gate 保留到回放完成');
    assert.equal(h.isAnchorHeld(), true);
    assert.equal(h.wrap.scrollTop, 480, '网络请求完成本身不应改写用户滚动位置');

    // 模拟 replayDone：先排空 gate（其中可能有 force-scroll done 帧），再结束本次分页事务。
    h.env.drainGateBuffer(sess);
    h.api.finishReplayLoadMore(sess, sess._replayLoadingMoreToken, { drain: false, updateButton: true });
    assert.equal(sess._replayLoadingMore, false);
    assert.equal(h.currentButton(sess).classes.has('loading'), false);
    h.flushFrames();
    assert.equal(h.isAnchorHeld(), false);
    assert.equal(h.wrap.scrollTop, 480, '异步回放收尾不得把手动滚动位置拉回底部');
    assert.deepEqual(h.wrap.programmaticWrites, []);
});
