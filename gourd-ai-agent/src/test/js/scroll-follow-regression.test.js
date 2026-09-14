const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');

const base = readStatic('js', 'app-base.js');
const message = readStatic('js', 'app-message.js');
const streaming = readStatic('js', 'app-streaming.js');
const css = readStatic('css', 'app.css');

/**
 * 背景（滚动抖动复盘，勿凭感觉回退）：
 * 任务执行中、卡片全部折叠时，用户上滚仍被反复拽回底部。三条叠加根因：
 * 1) scrollToBottom 的 force 在「调度期」预清 userScrolledUp，且双 rAF 落地前不复查
 *    用户意图 → 用户上滚后残留帧仍把视口拉回底部，往复抖动；
 * 2) appendReasonChunkCore / appendBodyContentCore 直接同步写 messagesWrap.scrollTop，
 *    绕开 userScrolledUp / _skipScroll / 锚定锁三重保护；
 * 3) .inline-thinking.hidden-reserve 用 display:none，等待提示反复显隐时气泡高度
 *    真实变化 → 滚动位置跳动。
 * 本文件锁定修复后的源码形态，防止三条根因回潮。
 */

// —— 花括号配平提取函数体 ——
function balancedFrom(src, braceIndex) {
    if (braceIndex === -1) return null;
    let depth = 0;
    for (let p = braceIndex; p < src.length; p++) {
        if (src[p] === '{') depth++;
        else if (src[p] === '}') { depth--; if (depth === 0) return src.slice(braceIndex + 1, p); }
    }
    return null;
}
function extractFunction(src, name) {
    const re = new RegExp('function\\s+' + name + '\\s*\\(');
    const m = re.exec(src);
    if (!m) return null;
    return balancedFrom(src, src.indexOf('{', m.index + m[0].length));
}
// 变量式函数（var f = function(){}）
function extractAssignedFunction(src, name) {
    const re = new RegExp('var\\s+' + name + '\\s*=\\s*function\\s*\\([^)]*\\)');
    const m = re.exec(src);
    if (!m) return null;
    return balancedFrom(src, src.indexOf('{', m.index + m[0].length));
}
function extractScrollHandler(src) {
    const m = /\$\(messagesWrap\)\.on\('scroll',\s*function\s*\(\s*\)\s*\{/.exec(src);
    if (!m) return null;
    return balancedFrom(src, src.indexOf('{', m.index));
}

// —— 检测谓词（对「修复前」负样本必须判不合格，避免断言恒真）——
// 只取「调度期」代码：剔除落地回调 applyIfAllowed 的函数体，再截到首个 rAF 之前。
// 切记不能拿整个函数体去匹配 userScrolledUp=false —— 那会连「落地后复位」这个
// 必需的正确写法一起禁掉，把缺陷锁死（本仓库真出过这个问题）。
function schedulePrelude(body) {
    const src = String(body);
    const landing = extractAssignedFunction(src, 'applyIfAllowed');
    const marked = landing ? src.replace(landing, '') : src;
    const idx = marked.indexOf('requestAnimationFrame');
    return idx === -1 ? marked : marked.slice(0, idx);
}
function clearsUserFlagAtSchedule(body) {
    // force 在调度期预清 userScrolledUp：调度→落地之间夹进的上滚会被残留帧覆盖
    return /userScrolledUp\s*=\s*false/.test(schedulePrelude(body));
}
function resetsUserFlagOnLanding(body) {
    // 落地成功后复位：force 路径唯一的复位通道，缺失则标志永久停在 true
    const landing = extractAssignedFunction(String(body), 'applyIfAllowed');
    if (!landing) return false;
    const w = landing.search(/messagesWrap\.scrollTop\s*=/);
    const r = landing.search(/userScrolledUp\s*=\s*false/);
    return w !== -1 && r !== -1 && r > w;
}
function directOuterScrollWrite(body) {
    // 绕过协调器直接写外层滚动容器
    return /messagesWrap\.scrollTop\s*=/.test(String(body));
}
function hiddenReserveBreaksLayout(ruleBody) {
    // display:none 会让元素脱离布局，显隐即高度跳变
    return /display\s*:\s*none/.test(String(ruleBody));
}

test('负样本对照：旧写法必须被检测函数判定为不合格', () => {
    const legacyScheduler = 'if (!force && userScrolledUp) return;\n    if (force) userScrolledUp = false;';
    assert.equal(clearsUserFlagAtSchedule(legacyScheduler), true, '必须能识别调度期预清标志');
    const legacyDirectWrite = 'if (!userScrolledUp && messagesWrap) { messagesWrap.scrollTop = messagesWrap.scrollHeight; }';
    assert.equal(directOuterScrollWrite(legacyDirectWrite), true, '必须能识别直接外层滚动写入');
    assert.equal(hiddenReserveBreaksLayout(' display: none; '), true, '必须能识别 display:none 布局跳变');
    // 时间窗版落地回调：只标记时间戳、不复位标志 → 必须判不合格
    const legacyLanding = 'var applyIfAllowed = function() {\n  messagesWrap.scrollTop = messagesWrap.scrollHeight;\n  markProgrammaticScroll();\n};';
    assert.equal(resetsUserFlagOnLanding(legacyLanding), false, '必须能识别落地后缺失复位通道');
    // 新谓词不得把「落地后复位」误判为调度期预清
    const goodBody = 'var gen = ++_scrollGen;\n var applyIfAllowed = function() {\n  messagesWrap.scrollTop = 1;\n  userScrolledUp = false;\n };\n requestAnimationFrame(applyIfAllowed);';
    assert.equal(clearsUserFlagAtSchedule(goodBody), false, '落地复位不得被误判为调度期预清');
    assert.equal(resetsUserFlagOnLanding(goodBody), true, '应能识别合格的落地复位');
});

test('scrollToBottom 全局唯一定义（防旧缺陷实现以重复定义形式残留）', () => {
    const defs = (base.match(/function\s+scrollToBottom\s*\(/g) || []).length;
    assert.equal(defs, 1, 'app-base.js 中 scrollToBottom 应只定义一次（旧版双实现曾并存）');
    const others = [message, streaming, readStatic('js', 'app-history.js')]
        .flatMap(s => (s.match(/function\s+scrollToBottom\s*\(/g) || []));
    assert.equal(others.length, 0, '其它脚本文件不得重新定义 scrollToBottom');
});

test('scrollToBottom：force 不得在调度期预清 userScrolledUp，但必须在落地后复位', () => {
    const body = extractFunction(base, 'scrollToBottom');
    assert.ok(body, 'scrollToBottom 应存在');
    assert.equal(clearsUserFlagAtSchedule(body), false,
        'force 在调度期预清 userScrolledUp 会让排队帧抢回视口（抖动根因之一）');
    assert.equal(resetsUserFlagOnLanding(body), true,
        '落地成功后必须复位 userScrolledUp，否则 force 置底后标志永久停在 true，人在底部却不再跟随');
    // 入口 + 每一帧落地前都要复查锚定锁与用户意图
    const anchorChecks = (body.match(/isScrollAnchorHeld\(\)/g) || []).length;
    assert.ok(anchorChecks >= 2, '应至少两次复查锚定锁（入口 + 落地前），实际 ' + anchorChecks);
    const userChecks = (body.match(/!force\s*&&\s*userScrolledUp/g) || []).length;
    assert.ok(userChecks >= 2, '应至少两次复查用户上滚（入口 + 落地前），实际 ' + userChecks);
});

test('scrollToBottom：带 generation 作废旧世代挂起帧，双帧高度复查不丢失', () => {
    const body = extractFunction(base, 'scrollToBottom');
    assert.ok(body, 'scrollToBottom 应存在');
    assert.match(body, /var\s+gen\s*=\s*\+\+_scrollGen/, '每次请求应领取新的 generation');
    const staleGuards = (body.match(/gen\s*!==\s*_scrollGen/g) || []).length;
    assert.ok(staleGuards >= 2,
        '第一帧与第二帧落地前都必须校验世代（旧世代作废），实际 ' + staleGuards);
    assert.equal((body.match(/requestAnimationFrame\(/g) || []).length, 2,
        '应保持双帧结构（内容高度可能跨帧变化，单帧会停在旧高度）');
});

test('scroll 监听：不得用时间窗滤除「程序性」事件（会连用户滚轮一起吞掉）', () => {
    const handler = extractScrollHandler(base);
    assert.ok(handler, '外层滚动监听应存在');
    assert.match(handler, /userScrolledUp\s*=\s*gap\s*>\s*80/, '应根据实际 gap 裸判用户意图');
    // 时间窗回潮拦截：连续输出时每个 chunk 都刷新窗口 → 窗口恒常开启 →
    // 用户上滚事件被一并丢弃 → userScrolledUp 永远置不起来 → 跟随停不下来，抖动依旧。
    assert.doesNotMatch(handler, /Date\.now\(\)/,
        'scroll 监听不得做时间窗滤除（程序置底后 gap≈0，裸判自然得 false，无需过滤）');
    assert.doesNotMatch(handler, /return\s*;/,
        'scroll 监听不得有提前退出分支（任何按来源早退都会误吞用户事件）');
    assert.equal(/markProgrammaticScroll|lastProgrammaticScrollAt/.test(base), false,
        '程序滚动时间窗机制应已彻底移除，不得残留');
});

test('流式增量渲染不得直接写外层滚动容器，必须收敛到 scrollToBottom 协调器', () => {
    for (const fn of ['appendReasonChunkCore', 'appendBodyContentCore']) {
        const body = extractFunction(message, fn);
        assert.ok(body, fn + ' 应存在');
        assert.equal(directOuterScrollWrite(body), false,
            fn + ' 直接写 messagesWrap.scrollTop 会绕开 userScrolledUp/_skipScroll/锚定锁保护（抖动根因）');
        assert.match(body, /scrollToBottom\(\)/, fn + ' 应统一调用 scrollToBottom()');
        assert.match(body, /_skipScroll/, fn + ' 应保留回放场景的 _skipScroll 豁免');
    }
    // 内层容器（思考块体/智能体卡体）的限高跟随仍允许直接写，不受此约束 —— 仅外层不得越权
    assert.ok(/thinkingBodyWrapEl\.scrollTop\s*=/.test(message), '内层思考块体跟随应保持');
    assert.ok(/followAgentCardBody/.test(message), '智能体卡体跟随应保持');
});

test('finishStream：done 帧不得 force 抢回用户视口，回放收尾仍走 _skipScroll 豁免', () => {
    const body = extractFunction(streaming, 'finishStream');
    assert.ok(body, 'finishStream 应存在');
    const forced = (body.match(/scrollToBottom\(\s*true\s*\)/g) || []).length;
    assert.equal(forced, 0, 'done 帧 force 会无视 userScrolledUp 把用户拽回底部（任务运行期上滚即抖）');
    const guarded = body.match(/if\s*\(\s*!sess\._skipScroll\s*\)\s*scrollToBottom\(\)/);
    assert.ok(guarded, 'done 帧应在 _skipScroll 豁免下调用非 force 的 scrollToBottom()');
});

test('inline-thinking 隐藏态必须保留布局占位，显隐不得引起气泡高度跳变', () => {
    const m = css.match(/\.inline-thinking\.hidden-reserve\s*\{([^}]*)\}/);
    assert.ok(m, '.inline-thinking.hidden-reserve 规则应存在');
    const body = m[1];
    assert.equal(hiddenReserveBreaksLayout(body), false,
        'display:none 会让等待提示显隐时气泡高度真实变化（折叠卡片也会抖）');
    assert.match(body, /visibility\s*:\s*hidden/, '隐藏态应改用 visibility:hidden 保留占位');
    assert.match(body, /pointer-events\s*:\s*none/, '隐藏态应不可交互');
    // 显隐机制仍依赖类切换：占位元素常驻气泡，仅切换 hidden-reserve 类
    assert.match(message, /removeClass\('hidden-reserve'\)/, '显示时应摘除 hidden-reserve 类');
    assert.match(message, /addClass\('hidden-reserve'\)/, '隐藏时应加回 hidden-reserve 类');
});

/* ===== 行为级回归（不是形态断言） =====
   把源码里的 scrollToBottom 与 scroll 监听原文取出，放进受控沙箱执行：
   自造 messagesWrap（scrollTop 带写入计数）+ 可手动逐帧推进的 requestAnimationFrame。
   锁定的是「真实执行结果」：实现形态怎么改都行，只要行为对就绿。 */
function buildHarness() {
    const scrollBody = extractFunction(base, 'scrollToBottom');
    const handlerBody = extractScrollHandler(base);
    assert.ok(scrollBody && handlerBody, '沙箱需要 scrollToBottom 与 scroll 监听原文');

    const wrap = {
        _top: 0, scrollHeight: 1000, clientHeight: 400, writes: 0,
        get scrollTop() { return this._top; },
        // 浏览器会把 scrollTop 限幅到 [0, scrollHeight - clientHeight]；
        // 源码里直接赋 scrollHeight 就是依赖这个限幅语义，夹具必须对齐
        set scrollTop(v) {
            this._top = Math.max(0, Math.min(Number(v), this.scrollHeight - this.clientHeight));
            this.writes++;
        }
    };
    const env = { messagesWrap: wrap, userScrolledUp: false, _scrollGen: 0, anchorHeld: false, frames: [] };
    env.isScrollAnchorHeld = function() { return env.anchorHeld; };
    env.requestAnimationFrame = function(fn) { env.frames.push(fn); };

    const make = (args, body) =>
        new Function('__env', 'with(__env){ return function(' + args + '){' + body + '} }')(env);

    const api = {
        env, wrap,
        scrollToBottom: make('force', scrollBody),
        fireScroll: make('', handlerBody),
        bottom() { return wrap.scrollHeight - wrap.clientHeight; },
        // 推进一帧：只执行当前已排队的回调（帧内新排的进入下一帧）
        step() { const batch = env.frames; env.frames = []; batch.forEach(fn => fn()); },
        flush() { for (let i = 0; i < 5 && env.frames.length; i++) api.step(); },
        // 用户滚轮：改位置 + 同步派发 scroll
        userScrollTo(top) { wrap._top = top; api.fireScroll(); },
        // 浏览器对程序性置底的异步 scroll 回执
        browserEchoScroll() { api.fireScroll(); },
        landAtBottom() { wrap._top = api.bottom(); wrap.writes = 0; env.userScrolledUp = false; }
    };
    return api;
}

test('行为：流式输出中用户上滚后，后续 chunk 不得把视口抢回底部', () => {
    const h = buildHarness();
    h.landAtBottom();
    h.userScrollTo(100);
    assert.equal(h.env.userScrolledUp, true, '上滚应被识别为用户意图');
    h.wrap.writes = 0;
    h.scrollToBottom();
    h.flush();
    assert.equal(h.wrap.writes, 0, '后续 chunk 不得写入 scrollTop');
    assert.equal(h.wrap.scrollTop, 100, '视口应停在用户滚到的位置');
});

test('行为：程序置底紧接着的用户上滚必须生效（时间窗回潮拦截）', () => {
    const h = buildHarness();
    h.landAtBottom();
    // 一个 chunk 触发置底，浏览器随后派发 scroll 回执
    h.scrollToBottom();
    h.flush();
    h.browserEchoScroll();
    assert.equal(h.env.userScrolledUp, false, '程序置底的回执不应被误判为用户上滚');
    // 紧接着（旧实现的 32ms 窗口内）用户真的上滚了
    h.userScrollTo(100);
    assert.equal(h.env.userScrolledUp, true,
        '紧跟程序置底的用户上滚必须仍被识别；时间窗过滤会吞掉它，导致跟随停不下来');
    h.wrap.writes = 0;
    h.scrollToBottom();
    h.flush();
    assert.equal(h.wrap.writes, 0, '识别到上滚后不得继续置底');
});

test('行为：force 置底落地后复位标志，后续非 force 帧能恢复跟随', () => {
    const h = buildHarness();
    h.userScrollTo(100);
    assert.equal(h.env.userScrolledUp, true);
    h.scrollToBottom(true);
    h.flush();
    assert.equal(h.wrap.scrollTop, h.bottom(), 'force 应置底');
    assert.equal(h.env.userScrolledUp, false, 'force 落地后必须复位，否则人在底部却不再跟随');
    h.wrap.scrollHeight = 1400;
    h.scrollToBottom();
    h.flush();
    assert.equal(h.wrap.scrollTop, 1000, '复位后非 force 帧应恢复跟随到新底部');
});

test('行为：调度后、rAF 落地前发生上滚，挂起帧不得置底', () => {
    const h = buildHarness();
    h.landAtBottom();
    h.scrollToBottom();
    h.userScrollTo(100);
    h.wrap.writes = 0;
    h.flush();
    assert.equal(h.wrap.writes, 0, '挂起帧必须在落地前复查用户意图');
    assert.equal(h.wrap.scrollTop, 100, '视口不得被残留帧拉回');
});

test('行为：连续多次请求只保留最新世代，旧世代挂起帧作废', () => {
    const h = buildHarness();
    h.landAtBottom();
    h.wrap.scrollHeight = 2000;
    h.scrollToBottom();
    h.scrollToBottom();
    h.scrollToBottom();
    h.wrap.writes = 0;
    h.step();
    assert.equal(h.wrap.writes, 1, '同一帧内只应有最新世代落地一次，实际 ' + h.wrap.writes);
});

test('行为：锚定锁期间 force 也不得滚动', () => {
    const h = buildHarness();
    h.landAtBottom();
    h.wrap._top = 100;
    h.env.anchorHeld = true;
    h.wrap.writes = 0;
    h.scrollToBottom(true);
    h.flush();
    assert.equal(h.wrap.writes, 0, '历史翻页期间禁止一切自动滚动');
    assert.equal(h.wrap.scrollTop, 100, '视口应停在用户阅读位置');
});