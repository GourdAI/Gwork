const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const moduleRoot = path.resolve(__dirname, '../../..');
const staticRoot = path.join(moduleRoot, 'src/main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');

const streaming = readStatic('js', 'app-streaming.js');
const message = readStatic('js', 'app-message.js');
const css = readStatic('css', 'app.css');
const localesDir = path.join(moduleRoot, 'src/main/resources/static/locales');

/* 真公共展示模型 + 真语言包：本文件不再自带「grep 应该显示成什么」的结论，
   只断言「心跳行必须等于用公共模型+当前语言算出的值」。否则测试会把
   「显示裸英文名」这个真实缺陷当契约锁死（上一版就是这样）。 */
const toolPresentation = require(path.join(staticRoot, 'js', 'app-tool-presentation.js'));

function readLocaleChat(locale) {
    return JSON.parse(fs.readFileSync(path.join(localesDir, locale + '.json'), 'utf8')
        .replace(/^\uFEFF/, '')).chat;
}
const localeCache = {};
function makeI18n(locale) {
    if (!localeCache[locale]) localeCache[locale] = readLocaleChat(locale);
    const chat = localeCache[locale];
    return {
        t: function (key) {
            const bare = key.replace(/^chat\./, '');
            return chat[bare] === undefined ? key : chat[bare];
        },
    };
}

/* ═══════════════════════════════════════════════════════════════════════════
   A+：background=true 的后台子代理帧在前端的安全消费。

   背景（勿凭感觉回退，以下每条都对应一个实测确定的失效形态）：
   后台子代理的帧由 WebGate 旁路直推，可能落在本轮 done 之后的【空闲窗口】
   （后台任务的生命周期恰恰跨越主 run 边界）。它走的是与前台子代理完全不同的
   时序前提，若不单独处理会踩四类坑：
     ① 伪造流：dispatchGateChunk 的通用分支无条件把会话拉进 isStreaming 并弹思考
        指示器，而后台帧没有配对 done 收尾 → 20s 后看门狗查到服务端 running=false
        → 强制 finishStream + 弹「强制结束」toast，用户以为后台任务出错了。
     ② 空指针：通用分支的 resetStreamState 会把 currentBubbleEl 置 null，而
        appendAgentBadge → insertBeforeActions 裸解引用 currentBubbleEl.parentNode
        → 抛 TypeError 被 onWebChunk 的 try/catch 静默吞掉，卡片根本建不出来。
     ③ 历史丢失：往【非活跃】会话容器里新建气泡会让 children.length !== 0，而
        重新进入该会话的重建判据正是 children.length === 0（evictInactiveSessions
        清空容器 → selectSession 据此触发 loadMessages）→ 用户切过去只看到一张
        孤儿卡，整个历史消息消失。
     ④ 误伤主代理：后台帧与主代理自己的流式帧【必然交错】（这正是 background 模式
        「主代理提交后继续推进」的目的）。若仍按前台帧处理，每个后台 start/end 帧
        都会把主代理【正在输出】的思考块强制定稿、把正文指针换掉，表现为思考块反复
        被打断、正文撕裂成两段。
   ═══════════════════════════════════════════════════════════════════════════ */

// ── 微型 DOM 桩（仿仓库既有范式，无 jsdom 依赖）────────────────────
function makeEl(tag, className) {
    const el = {
        tagName: (tag || 'div').toUpperCase(),
        className: className || '',
        children: [],
        parentNode: null,
        attributes: {},
        textContent: '',
        _listeners: {},
        classList: {
            _set: new Set((className || '').split(/\s+/).filter(Boolean)),
            add(c) { this._set.add(c); },
            remove(c) { this._set.delete(c); },
            toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); },
            contains(c) { return this._set.has(c); },
        },
        setAttribute(k, v) { this.attributes[k] = String(v); },
        getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; },
        // 真 DOM 元素必有 removeAttribute；tagToolName 对无 toolTitle/source/agentName 的展示
        // 模型会走 removeAttribute 分支，桩缺这个方法就是桩不合契约（会把产品代码的
        // 正常行为报成 TypeError，看起来像代码缺陷）。行为与真 DOM 一致：删键、不抛错。
        removeAttribute(k) { delete this.attributes[k]; },
        appendChild(child) {
            if (child && child.parentNode) {
                const p = child.parentNode.children;
                const i = p.indexOf(child);
                if (i >= 0) p.splice(i, 1);
            }
            child.parentNode = this;
            this.children.push(child);
            return child;
        },
        remove() {
            if (!this.parentNode) return;
            const arr = this.parentNode.children;
            const i = arr.indexOf(this);
            if (i >= 0) arr.splice(i, 1);
            this.parentNode = null;
        },
        find(sel) {
            // 支持 '.cls' 与 '.cls' 链式查找的极简实现：深度优先收集后代
            const out = [];
            const want = String(sel).replace(/^\./, '');
            const walk = (n) => {
                for (const c of n.children) {
                    if (c.classList && c.classList.contains(want)) out.push(c);
                    walk(c);
                }
            };
            walk(this);
            return {
                first: () => out[0] || null,
                each(fn) { out.forEach(fn); },
                remove() { out.forEach(e => e.remove()); },
                length: out.length,
                0: out[0],
            };
        },
        on(evt, fn) { (this._listeners[evt] = this._listeners[evt] || []).push(fn); },
        fire(evt) { (this._listeners[evt] || []).forEach(fn => fn.call(this)); },
        get offsetWidth() { return 100; },
    };
    el.classList = el.classList;
    return el;
}

/** 极简 jQuery 桩：只实现被测代码真正用到的那几个入口。
 *
 *  【保真约束】真实 jQuery 的 $(null) / $(undefined) 返回的是【长度为 0 的 jQuery 对象】，
 *  它依旧拥有完整的 API（append/before/find…）且全部静默 no-op，绝不抛错。
 *  桩必须同构：若让 $(null) 缺方法而抛 TypeError，那么「只判 null 不判 parentNode」
 *  的缺陷体会因【桩报错】而被杀，而不是因【元素被静默丢弃】这个真实后果被杀——
 *  在真浏览器里那个缺陷根本不抛错，只是卡片默默不出现，比抛错难查得多。 */
function makeJQuery() {
    const EMPTY_API = () => {
        const noop = () => api;
        const api = {
            0: null, length: 0, _el: null, _empty: true,
            addClass: noop, removeClass: noop, toggleClass: noop, hasClass: () => false,
            attr: () => api, text: () => api, html: () => api,
            append: noop, appendChild: noop, before: noop, after: noop, remove: noop,
            on: noop, each: () => {},
            find: () => EMPTY_API(),
            first: () => EMPTY_API(),
            closest: () => EMPTY_API(),
        };
        return api;
    };
    const wrap = (elOrHtml) => {
        let el = elOrHtml;
        if (typeof elOrHtml === 'string') {
            // $('<div>') / $('<span>')：只认这种单一标签形态，够用即可
            const m = /^\s*<\s*(\w+)\s*>\s*$/.exec(elOrHtml);
            el = m ? makeEl(m[1]) : makeEl('div');
            el._fromHtml = true;
        }
        if (!el) return EMPTY_API();
        const api = {
            0: el,
            length: 1,
            _el: el,
            addClass(c) { String(c).split(/\s+/).filter(Boolean).forEach(x => el.classList.add(x)); return api; },
            removeClass(c) { String(c).split(/\s+/).filter(Boolean).forEach(x => el.classList.remove(x)); return api; },
            toggleClass(c) { el.classList.toggle(c); return api; },
            hasClass(c) { return el.classList.contains(c); },
            attr(k, v) { if (v === undefined) return el.getAttribute(k); el.setAttribute(k, v); return api; },
            text(v) { if (v === undefined) return el.textContent; el.textContent = String(v); return api; },
            html(v) { if (v === undefined) return el.innerHTML || ''; el.innerHTML = v; return api; },
            append(child) {
                const c = child && child._el ? child._el : child;
                if (c) el.appendChild(c);
                return api;
            },
            appendChild(c) { el.appendChild(c); return api; },
            find(sel) {
                const r = el.find ? el.find(sel) : { first: () => null, each() {}, remove() {}, length: 0 };
                return {
                    // 必须恒返回 jQuery 包装对象（无匹配时 [0] 为 falsy），绝不能返回 null：
            // 被测代码写的是 $(x).find(sel).first()[0]，返回 null 会让 null[0] 抛
            // "Cannot read properties of null"，看起来像产品缺陷、实为桩不合契约。
            first: () => { const f = r.first ? r.first() : r[0]; return f ? wrap(f) : EMPTY_API(); },
                    each: r.each ? (fn) => r.each(fn) : () => {},
                    remove: () => { if (r.remove) r.remove(); return api; },
                    length: r.length || 0,
                    0: r[0] || null,
                    _raw: r,
                };
            },
            before(newEl) {
                const n = newEl && newEl._el ? newEl._el : newEl;
                if (!n || !el.parentNode) return api;
                const arr = el.parentNode.children;
                const i = arr.indexOf(el);
                n.parentNode = el.parentNode;
                arr.splice(i < 0 ? arr.length : i, 0, n);
                return api;
            },
            closest(sel) {
                const want = String(sel).replace(/^\./, '');
                let n = el;
                while (n) {
                    if (n.classList && n.classList.contains(want)) return wrap(n);
                    n = n.parentNode;
                }
                return EMPTY_API();
            },
            on: (evt, fn) => { el.on(evt, fn); return api; },
            get length0() { return 0; },
            // $(el)[0] 取原生元素
            ...(Array.isArray(elOrHtml) ? {} : {}),
        };
        Object.defineProperty(api, 'length', { value: 1, configurable: true });
        return api;
    };
    return wrap;
}

// ── 源码提取工具（与仓库既有测试同口径）────────────────────────
function balancedFrom(src, braceIndex) {
    if (braceIndex === -1) return null;
    let depth = 0;
    for (let p = braceIndex; p < src.length; p++) {
        if (src[p] === '{') depth++;
        else if (src[p] === '}') { depth--; if (depth === 0) return src.slice(braceIndex + 1, p); }
    }
    return null;
}
/** 只取函数体（不含声明）。用于「断言源码形态」类用例。 */
function extractFunction(src, name) {
    const re = new RegExp('function\\s+' + name + '\\s*\\(');
    const m = re.exec(src);
    assert.ok(m, '应能在源码中找到函数: ' + name);
    const body = balancedFrom(src, src.indexOf('{', m.index + m[0].length));
    assert.ok(body, '函数体应配平: ' + name);
    return body;
}

/**
 * 取【完整函数声明】（含 function name(params) 头）。
 *
 * <p>凡是把源码切片丢进 new Function 沙箱真跑的场景都必须用它：extractFunction 返回的是
 * body-only，直接拼 `body + 'return name;'` 会让 name 从未被声明 → ReferenceError；
 * 而 body 里裸用的形参（如 resolveAgentState 的 args）也会变成未定义全局变量。
 * 本轮 12 个用例失败全部源于此，故单独立函数并在此写明。</p>
 */
function extractFunctionFull(src, name) {
    const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
    const m = re.exec(src);
    assert.ok(m, '应能在源码中找到函数: ' + name);
    const body = balancedFrom(src, src.indexOf('{', m.index));
    assert.ok(body, '函数体应配平: ' + name);
    return m[0] + body + '\n}';
}

/* ══════════════════════════════════════════════════════════════════
   1. handleIdleAgentChunk：空闲态安全消费（真行为验证）
   ══════════════════════════════════════════════════════════════════ */

/**
 * 用受控替身驱动真实的 handleIdleAgentChunk 源码，断言其行为而非源码字符串。
 *
 * 桩里刻意区分三种会话态（未建 / 流式中 / 空闲）与两种会话身份（活跃 / 非活跃），
 * 因为该函数的全部价值就在于「按这些维度分派」——只测一条路径等于没测。
 */
function runHandleIdleAgentChunk(opts) {
    const { sessionMap, activeSessionId, chunk, sid } = opts;
    const calls = { onWebChunk: [], scrollToBottom: 0, reportError: [] };

    const fnSrc = extractFunctionFull(streaming, 'handleIdleAgentChunk');
    const factory = new Function(
        'sessionMap', 'activeSessionId', 'onWebChunk', 'scrollToBottom', 'reportStreamPipelineError',
        fnSrc + '\nreturn handleIdleAgentChunk;'
    );
    const fn = factory(
        sessionMap,
        activeSessionId,
        (sess, c) => { calls.onWebChunk.push({ sess, chunk: c }); },
        () => { calls.scrollToBottom++; },
        (tag, e, c) => { calls.reportError.push({ tag, msg: String(e && e.message), type: c && c.type }); }
    );

    const handled = fn(chunk, sid);
    return { handled, calls };
}

test('handleIdleAgentChunk：会话未建立时交回通用分支（返回 false）', () => {
    const { handled, calls } = runHandleIdleAgentChunk({
        sessionMap: {},                       // 会话不存在
        activeSessionId: 's-active',
        chunk: { type: 'agent_start', sessionId: 's-new', args: { background: true } },
        sid: 's-new',
    });
    assert.equal(handled, false,
        '会话未建时必须返回 false 交回 dispatchGateChunk 的通用分支：那条路径会 getOrCreateSession '
        + '并完成必要的 resetStreamState + showThinking，此处不存在 currentBubbleEl 空指针问题');
    assert.equal(calls.onWebChunk.length, 0, '未接管就不该自己渲染');
});

test('handleIdleAgentChunk：流式中/回放中交回原路径（返回 false）', () => {
    for (const [flag, label] of [['isStreaming', '流式中'], ['_replaying', '回放中']]) {
        const sess = { sessionId: 's-active', agentCards: {}, agentStates: {} };
        sess[flag] = true;
        const { handled, calls } = runHandleIdleAgentChunk({
            sessionMap: { 's-active': sess },
            activeSessionId: 's-active',
            chunk: { type: 'agent_start', args: { background: true } },
            sid: 's-active',
        });
        assert.equal(handled, false, label + '时原路径工作正常，不得抢占');
        assert.equal(calls.onWebChunk.length, 0, label + '时不得重复渲染（会与 onWebChunk 的 case 撞车）');
    }
});

test('handleIdleAgentChunk：非活跃会话必须丢弃，绝不渲染（防历史消息丢失）', () => {
    const bg = { sessionId: 's-bg', agentCards: {}, agentStates: {} };
    const { handled, calls } = runHandleIdleAgentChunk({
        sessionMap: { 's-bg': bg },
        activeSessionId: 's-active',            // 用户当前在看别的会话
        chunk: { type: 'agent_start', args: { background: true, invocationId: 'inv-1' } },
        sid: 's-bg',
    });
    assert.equal(handled, true, '必须返回 true 就地消费掉，绝不能落到通用分支去建会话态');
    assert.equal(calls.onWebChunk.length, 0,
        '非活跃会话必须丢弃该帧：往它的容器里新建气泡会让 children.length !== 0，'
        + '而重新进入时的重建判据正是 children.length === 0 → selectSession 不再触发 '
        + 'loadMessages → 用户切过去只看到一张孤儿卡，整个历史消息消失。'
        + '帧已由 emitToClient 落盘，切回时由回放完整重建，丢弃无损失。');
    assert.equal(calls.scrollToBottom, 0, '丢弃的帧不得触发滚动');
});

test('handleIdleAgentChunk：空闲态的活跃会话就地渲染，且不伪造流', () => {
    const sess = {
        sessionId: 's-active',
        isStreaming: false,                    // 关键前提：本轮已 done，界面空闲
        _replaying: false,
        currentBubbleEl: null,                 // finishStream 已置 null
        agentCards: {}, agentStates: {},
    };
    const chunk = { type: 'agent_start', args: { background: true, invocationId: 'inv-2' } };
    const { handled, calls } = runHandleIdleAgentChunk({
        sessionMap: { 's-active': sess },
        activeSessionId: 's-active',
        chunk, sid: 's-active',
    });
    assert.equal(handled, true, '空闲态活跃会话必须就地消费');
    assert.equal(calls.onWebChunk.length, 1, '必须真的把帧交给渲染');
    assert.equal(calls.onWebChunk[0].chunk, chunk, '帧必须原样透传');
    assert.equal(calls.scrollToBottom, 1, 'start/end 帧应滚到底让用户看见卡片');
    assert.equal(sess.isStreaming, false,
        '绝不能把会话拉进流式态：后台帧没有配对 done，isStreaming=true 会让 20s 后看门狗'
        + '查到服务端 running=false 从而强制 finishStream + 弹「强制结束」toast，'
        + '用户会误以为后台任务出错');
});

test('handleIdleAgentChunk：进度心跳不抢滚动条（高频帧）', () => {
    const sess = { sessionId: 's-active', isStreaming: false, agentCards: {}, agentStates: {} };
    const { calls } = runHandleIdleAgentChunk({
        sessionMap: { 's-active': sess },
        activeSessionId: 's-active',
        chunk: { type: 'agent_progress', args: { background: true, invocationId: 'i', toolName: 'grep' } },
        sid: 's-active',
    });
    assert.equal(calls.onWebChunk.length, 1, '心跳也要渲染（写卡片头部一行）');
    assert.equal(calls.scrollToBottom, 0,
        '心跳频率等于工具调用次数，逐次滚底会在用户上翻阅读时反复抢走滚动条');
});

test('handleIdleAgentChunk：渲染抛错必须留痕，且仍算已消费', () => {
    const sess = { sessionId: 's-active', isStreaming: false, agentCards: {}, agentStates: {} };
    // 用一个会让 onWebChunk 抛错的 chunk：桩里按 type 主动抛
    const fnSrc = extractFunctionFull(streaming, 'handleIdleAgentChunk');
    const errors = [];
    const factory = new Function(
        'sessionMap', 'activeSessionId', 'onWebChunk', 'scrollToBottom', 'reportStreamPipelineError',
        fnSrc + '\nreturn handleIdleAgentChunk;'
    );
    const fn = factory(
        { 's-active': sess }, 's-active',
        // eslint-disable-next-line no-unused-vars
        () => { throw new TypeError("Cannot read properties of null (reading 'parentNode')"); },
        () => {},
        (tag, e) => { errors.push({ tag, msg: String(e.message) }); }
    );
    const handled = fn({ type: 'agent_start', args: { background: true } }, 's-active');

    assert.equal(handled, true, '异常也要算已消费：否则帧会掉进通用分支二次处理，制造假流');
    assert.equal(errors.length, 1, '必须留痕');
    assert.equal(errors[0].tag, 'handleIdleAgentChunk', '留痕标签要能定位到这条路径');
    assert.match(errors[0].msg, /parentNode/,
        '这条异常正是本用例要守的真实形态：空捕获会让帧被逐条静默丢弃、卡片永不出现');
});

test('handleIdleAgentChunk：agentCards/agentStates 缺失时必须自建（两表口径一致）', () => {
    // evictInactiveSessions 会清空这两张表；若这里不补，appendAgentBadge 的登记会写进 undefined
    const sess = { sessionId: 's-active', isStreaming: false };
    const { handled } = runHandleIdleAgentChunk({
        sessionMap: { 's-active': sess },
        activeSessionId: 's-active',
        chunk: { type: 'agent_start', args: { background: true } },
        sid: 's-active',
    });
    assert.equal(handled, true);
    assert.ok(sess.agentCards && typeof sess.agentCards === 'object', 'agentCards 必须被补建');
    assert.ok(sess.agentStates && typeof sess.agentStates === 'object', 'agentStates 必须被补建');
});

/* ══════════════════════════════════════════════════════════════════
   2. dispatchGateChunk 的前置分支必须在通用「自动 streaming」之前
   ══════════════════════════════════════════════════════════════════ */

test('dispatchGateChunk：三类后台帧都在通用分支之前被拦截', () => {
    const dispatch = extractFunction(streaming, 'dispatchGateChunk');

    // 通用「自动进入 streaming 态」分支的位置（sess2 是它的局部变量名）
    const autoIdx = dispatch.indexOf('var sess2 = getOrCreateSession(sid);');
    assert.ok(autoIdx > 0, '应能定位到通用自动 streaming 分支');

    const guardIdx = dispatch.indexOf(
        "chunk.type === 'agent_start' || chunk.type === 'agent_end' || chunk.type === 'agent_progress'");
    assert.ok(guardIdx > 0, '必须有覆盖三类帧的前置守卫');
    assert.ok(guardIdx < autoIdx,
        '守卫必须排在通用分支之前：排后面就等于没拦，帧会先被拉进流式态');

    // 守卫必须调 handleIdleAgentChunk 并按其返回值决定是否 return
    assert.match(dispatch.slice(guardIdx, guardIdx + 300), /handleIdleAgentChunk\(chunk, sid\)/,
        '守卫必须真的委派给 handleIdleAgentChunk');
    assert.match(dispatch.slice(guardIdx, guardIdx + 300), /if \(handleIdleAgentChunk\(chunk, sid\)\) return;/,
        '必须按返回值 return：无条件 return 会让「会话未建」这类需要走通用分支的帧也被吞掉');
});

test('onWebChunk：agent_progress 必须早期短路，不得走完整帧处理路径', () => {
    const onWebChunk = extractFunction(streaming, 'onWebChunk');

    const progressIdx = onWebChunk.indexOf("chunk.type === 'agent_progress'");
    assert.ok(progressIdx > 0, '必须有 agent_progress 的短路分支');

    // 短路必须发生在「刷新 lastEventAt / 重置 silenceTimer / 相位推进」之前。
    // 必须搜【代码形态】而非裸标识符：短路分支自己的注释里就写了 inferPhaseFromType，
    // 搜裸名会先命中注释（idx 比 progressIdx 还小），得出「短路排在相位推进之后」的假结论。
    const lastEventIdx = onWebChunk.indexOf('sess.lastEventAt = Date.now()');
    const phaseIdx = onWebChunk.indexOf('var nextPhase = chunk.phase || inferPhaseFromType');
    assert.ok(phaseIdx > 0, '应能定位到相位推进的代码行（若失败说明该表达式形态已变，请同步修正）');
    const switchIdx = onWebChunk.indexOf('switch (chunk.type)');
    assert.ok(progressIdx < lastEventIdx,
        '必须在刷新 lastEventAt 之前短路：那是主流停滞检测的依据，而心跳反映的是【后台任务】'
        + '的活性，拿它喂主流的看门狗会掉真正的停滞信号');
    assert.ok(progressIdx < phaseIdx, '必须在相位推断之前短路，避免改写 sess.phase 污染主对话指示器');
    assert.ok(progressIdx < switchIdx, '必须在 switch 之前短路');

    // removeInlineThinking 会闪掉主代理正在显示的内联思考指示器
    const removeInlineIdx = onWebChunk.indexOf('removeInlineThinking(sess)');
    assert.ok(removeInlineIdx > 0, '应能定位 removeInlineThinking');
    assert.ok(progressIdx < removeInlineIdx,
        '必须在 removeInlineThinking 之前短路：否则后台心跳（频率等于工具调用次数）会反复'
        + '闪掉主代理正在显示的内联思考指示器，主代理下一帧到达才重建 → 可见的视觉抖动');

    assert.match(onWebChunk.slice(progressIdx, progressIdx + 200), /updateAgentProgress\(sess, chunk\);\s*\n\s*return;/,
        '短路分支必须渲染心跳并立即 return');
});

/* ══════════════════════════════════════════════════════════════════
   3. 后台帧不得误伤主代理正在输出的内容
   ══════════════════════════════════════════════════════════════════ */

test('onWebChunk：agent_start/agent_end 必须按 background 标记跳过收敛动作', () => {
    const onWebChunk = extractFunction(streaming, 'onWebChunk');

    /* 用「位置切片」而非正则捕获组：合并的 case 块内部还有一个 if 块，
       非贪婪的 `[\s\S]*?\r?\n\s*\}` 会先匹到那个内层 if 的闭合括号，把切片截断在
       appendAgentBadge 之前（本轮实测：切片拿不到建卡行，断言假报「建卡不受影响」失败）。
       改取「本 case 块 → 下一个 case」之间的文本，与缩进、嵌套层数均无关。 */
    const startIdx = onWebChunk.indexOf("case 'agent_start':");
    assert.ok(startIdx > 0, '应能找到 agent_start 分支');
    const endCaseIdx = onWebChunk.indexOf("case 'agent_end':", startIdx);
    assert.ok(endCaseIdx > startIdx,
        'agent_start 必须紧跟着合并的 agent_end 分支（两者共用同一套 background 判据）');
    // 切片末尾从 agent_end 【之后】再找下一个 case：从 startIdx+1 开始找会先命中
    // `case 'agent_end':` 自身（它同样以 "case '" 开头），切片就只剩 agent_start 一行。
    const endIdx = onWebChunk.indexOf("case '", endCaseIdx + 1);
    assert.ok(endIdx > endCaseIdx, 'agent_end 分支后应还有其它 case（用于界定切片末尾）');
    const body = onWebChunk.slice(startIdx, endIdx);

    assert.match(body, /case 'agent_end':/, '两类帧必须合并处理（同一套 background 判据）');
    assert.match(body, /var isBgAgentFrame = !!\(chunk\.args && chunk\.args\.background\);/,
        '必须以 args.background 为判据：它是后端区分「旁路推送的后台帧」与「经父 sink 的前台帧」的唯一信号');

    const guardIdx = body.indexOf('if (!isBgAgentFrame) {');
    assert.ok(guardIdx > 0, '必须有一个「非后台帧才收敛」的守卫');
    const guarded = body.slice(guardIdx, guardIdx + 260);
    assert.match(guarded, /finishThinkingBlock\(sess\); finishPendingTool\(sess\); clearRetryChunk\(sess\);/,
        '三个收敛动作必须都在守卫内：前台子代理帧到达时主代理正阻塞在 ACTION 段等它，收敛是对的；'
        + '而后台帧与主代理自己的流式帧必然交错，收敛会把主代理正在输出的思考块强制定稿');

    const badgeIdx = body.indexOf('appendAgentBadge(sess, chunk, chunk.type === \'agent_start\');');
    assert.ok(badgeIdx > 0, '建卡/收卡调用必须存在，且 isStart 由 chunk.type 推导');
    assert.ok(badgeIdx > guardIdx + guarded.indexOf('clearRetryChunk'),
        '建卡必须在守卫之外：两种帧都要渲染卡片，只是后台帧不做收敛动作');
    assert.ok(!/isBgAgentFrame/.test(body.slice(badgeIdx)),
        'appendAgentBadge 不得被 background 判据包住');
});

test('appendAgentBadge：后台 agent_end 不得重建主代理的正文指针', () => {
    const badge = extractFunction(message, 'appendAgentBadge');

    const m = /if \(\(chunk\.args && chunk\.args\.background\) !== true\) \{([\s\S]*?)\n            \}/.exec(badge);
    assert.ok(m, '收卡分支里的「恢复 currentBubbleEl」必须被 background 判据包住');
    const guarded = m[1];

    assert.match(guarded, /insertBeforeActions\(sess, newMdAfter\);/, '守卫内应重建指针');
    assert.match(guarded, /sess\.currentBubbleEl = newMdAfter;/, '守卫内应换指针');
    assert.match(guarded, /sess\.reasonBuffer = '';/, '守卫内应清缓冲');

    // 反向确认：这三行不得再出现在守卫之外（否则后台帧照样会撕裂主代理正文）
    const outsideGuard = badge.replace(m[0], '');
    assert.equal((outsideGuard.match(/sess\.currentBubbleEl = newMdAfter;/g) || []).length, 0,
        '换指针必须只存在于守卫内：后台 agent_end 到达时主代理可能正在往自己的 currentBubbleEl '
        + '流式输出，换指针会让 getStreamMd 的增量渲染器与元素脱钩，未 flush 的缓冲永久丢失，'
        + '一段连续正文被撕裂成两块');
    assert.equal((outsideGuard.match(/sess\.reasonBuffer = '';/g) || []).length, 0,
        '清缓冲必须只存在于守卫内，否则后台帧会吞掉主代理已累积未 flush 的正文');
});

/* ══════════════════════════════════════════════════════════════════
   4. insertBeforeActions 的空指针兜底（覆盖实时 + 回放 + 全部调用方）
   ══════════════════════════════════════════════════════════════════ */

test('insertBeforeActions：currentBubbleEl 为 null 时兜底重建，不得抛错', () => {
    const body = extractFunction(message, 'insertBeforeActions');

    const container = makeEl('div', 'messages-inner');
    let ensureCalls = 0;

    const factory = new Function(
        '$', 'ensureAssistantBubble', 'renderRoot',
        'function insertBeforeActions(sess, el) {' + body + '}\nreturn insertBeforeActions;'
    );
    const fn = factory(makeJQuery(), (sess) => {
        ensureCalls++;
        // 模拟真实 ensureAssistantBubble 的副作用：建出行、把指针指到 .md-content
        const bubble = makeEl('div', 'md-content');
        const row = makeEl('div', 'msg-row assistant');
        row.appendChild(bubble);
        container.appendChild(row);
        sess.currentBubbleEl = bubble;
    }, (sess) => sess.container);

    const sess = { container, currentBubbleEl: null, inlineThinkingEl: null };
    const card = makeEl('div', 'agent-card');

    assert.doesNotThrow(() => fn(sess, card),
        '空闲态（finishStream 后）与回放态（replaySession 遇 done 后）currentBubbleEl 都是 null，'
        + '旧代码在此裸解引用 parentNode 抛 TypeError 并被 onWebChunk 的 try/catch 静默吞掉，'
        + '表现为「卡片根本不出现」且控制台无有效报错');
    assert.equal(ensureCalls, 1, '必须走一次 ensureAssistantBubble 兜底');
    assert.ok(sess.currentBubbleEl, '兜底后指针必须可用');

    // 卡片必须真的落进容器（不是被静默丢弃）
    const found = [];
    const walk = (n) => { for (const c of n.children) { if (c === card) found.push(c); walk(c); } };
    walk(container);
    assert.equal(found.length, 1, '元素必须真的被插入 DOM');
});

test('insertBeforeActions：指针非 null 但已脱离文档时也必须兜底（否则静默丢弃）', () => {
    /* 这条是对「只判 !currentBubbleEl 不判 parentNode」的行为级守卫。

       为何不能只靠源码字符串断言：该判据在 insertBeforeActions 里出现【两次】
       （外层兜底入口 + 兜底后的二级校验），而「模式存在于某处」这类断言在只改其中
       一处时仍然能匹配到另一处 → 变异体存活，测试假绿（本轮变异验证 J13 实测抓到）。
       故改为驱动真实场景：evictInactiveSessions 会 empty() 容器，使已建好的气泡
       parentNode 变 null 而元素本身仍非 null——正是「非 null 但脱离文档」形态。 */
    const body = extractFunction(message, 'insertBeforeActions');
    const container = makeEl('div', 'messages-inner');
    let ensureCalls = 0;

    const factory = new Function(
        '$', 'ensureAssistantBubble', 'renderRoot',
        'function insertBeforeActions(sess, el) {' + body + '}\nreturn insertBeforeActions;'
    );
    const fn = factory(makeJQuery(), (sess) => {
        ensureCalls++;
        const bubble = makeEl('div', 'md-content');
        const row = makeEl('div', 'msg-row assistant');
        row.appendChild(bubble);
        container.appendChild(row);
        sess.currentBubbleEl = bubble;
    }, (sess) => sess.container);

    // 构造脱离文档的指针：元素非 null，但 parentNode 已被 empty() 抹掉
    const orphan = makeEl('div', 'md-content');
    assert.equal(orphan.parentNode, null, '前置：桩元素初始就不在文档里');

    const sess = { container, currentBubbleEl: orphan, inlineThinkingEl: null };
    const card = makeEl('div', 'agent-card');

    assert.doesNotThrow(() => fn(sess, card),
        '只判 null 会放过这个场景：随后 $(null).find(...) 在真 jQuery 下返回空集、'
        + '.first()[0] 是 undefined、$(undefined).append 静默失败——不抛错也不显示，'
        + '比抛 TypeError 更难查（卡片就是不出现，控制台一片干净）');
    assert.equal(ensureCalls, 1, '脱离文档同样必须走 ensureAssistantBubble 重建');

    let inserted = false;
    const walk = (n) => { for (const c of n.children) { if (c === card) inserted = true; walk(c); } };
    walk(container);
    assert.ok(inserted, '元素必须真的落进容器，绝不能被静默丢弃');
});

test('insertBeforeActions：兜底后仍失败时退回容器 append，绝不静默丢弃', () => {
    const body = extractFunction(message, 'insertBeforeActions');
    const container = makeEl('div', 'messages-inner');

    const factory = new Function(
        '$', 'ensureAssistantBubble', 'renderRoot',
        'function insertBeforeActions(sess, el) {' + body + '}\nreturn insertBeforeActions;'
    );
    // ensureAssistantBubble 也失效（极端异常）：兜底必须仍把元素放进容器
    const fn = factory(makeJQuery(), () => { /* 故意什么都不做 */ }, (sess) => sess.container);

    const sess = { container, currentBubbleEl: null, inlineThinkingEl: null };
    const el = makeEl('div', 'agent-card');
    assert.doesNotThrow(() => fn(sess, el), '二级兜底也不得抛错');
    assert.equal(container.children.indexOf(el) >= 0, true,
        '两级兜底都失败时必须退回容器 append：静默丢弃比位置不精确更糟');
});

test('insertBeforeActions：正常态（指针有效）行为不变', () => {
    const body = extractFunction(message, 'insertBeforeActions');
    let ensureCalls = 0;

    const factory = new Function(
        '$', 'ensureAssistantBubble', 'renderRoot',
        'function insertBeforeActions(sess, el) {' + body + '}\nreturn insertBeforeActions;'
    );
    const fn = factory(makeJQuery(), () => { ensureCalls++; }, () => null);

    // 构造正常态：bubble 的父节点是 msg-bubble，里面有 msg-meta-row 作页脚锚点
    const bubble = makeEl('div', 'md-content');
    const msgBubble = makeEl('div', 'msg-bubble');
    const footer = makeEl('div', 'msg-meta-row');
    msgBubble.appendChild(bubble);
    msgBubble.appendChild(footer);

    const sess = { currentBubbleEl: bubble, inlineThinkingEl: null };
    const card = makeEl('div', 'agent-card');
    fn(sess, card);

    assert.equal(ensureCalls, 0, '指针有效时不得触发兜底（会凭空多出一个空气泡）');
    const idxCard = msgBubble.children.indexOf(card);
    const idxFooter = msgBubble.children.indexOf(footer);
    assert.ok(idxCard >= 0, '卡片必须被插入');
    assert.ok(idxCard < idxFooter, '必须插在页脚（meta 行/操作按钮）之上，否则会被顶到消息顶部');
});

test('insertBeforeActions：存在内联等待指示器时插在其上方', () => {
    const body = extractFunction(message, 'insertBeforeActions');
    const factory = new Function(
        '$', 'ensureAssistantBubble', 'renderRoot',
        'function insertBeforeActions(sess, el) {' + body + '}\nreturn insertBeforeActions;'
    );
    const fn = factory(makeJQuery(), () => { throw new Error('不该走到兜底'); }, () => null);

    const parent = makeEl('div', 'msg-bubble');
    const indicator = makeEl('div', 'inline-thinking');
    parent.appendChild(indicator);

    const sess = { currentBubbleEl: null, inlineThinkingEl: indicator };
    const el = makeEl('div', 'agent-card');
    fn(sess, el);

    assert.ok(parent.children.indexOf(el) < parent.children.indexOf(indicator),
        '新内容必须插在常驻指示器上方，保证指示器始终在气泡底部');
});

test('兜底必须在 insertBeforeActions 内部（覆盖全部调用点），而非逐个调用点补', () => {
    const body = extractFunction(message, 'insertBeforeActions');
    // 注意：该判据在本函数内出现【两次】（外层入口 + 兜底后的二级校验），
    // 故只能断言「至少一次」且两处都要完整；真正的守卫由上一条行为级用例承担。
    const guardRe = /!sess\.currentBubbleEl \|\| !sess\.currentBubbleEl\.parentNode/g;
    const guards = (body.match(guardRe) || []).length;
    assert.ok(guards >= 1,
        '兜底判据必须同时覆盖 null 与「已脱离文档」（evictInactiveSessions 会 empty() 容器）');
    assert.equal((body.match(/!sess\.currentBubbleEl\)/g) || []).length, 0,
        '不得出现「只判 null」的退化形态');
    assert.match(body, /ensureAssistantBubble\(sess\)/, '兜底必须复用既有的 ensureAssistantBubble');

    // 调用点数量：兜底做在函数内部才能一次覆盖全部，逐个补必漏
    const callSites = (message.match(/insertBeforeActions\(/g) || []).length - 1; // 减去定义处
    assert.ok(callSites >= 5,
        `insertBeforeActions 有 ${callSites} 个调用点（appendAgentBadge 建卡/收卡、问答记录、HITL 卡等），`
        + '逐个补 ensureAssistantBubble 必漏；兜底必须做在函数内部');
});

/* ══════════════════════════════════════════════════════════════════
   5. updateAgentProgress：进度心跳渲染（真行为验证）
   ══════════════════════════════════════════════════════════════════ */

function buildAgentCard(agentId) {
    const card = makeEl('div', 'agent-card');
    const header = makeEl('div', 'agent-card-header');
    const bodyEl = makeEl('div', 'agent-card-body');
    card.appendChild(header);
    card.appendChild(bodyEl);
    return { card, header, bodyEl, agentId };
}

function runUpdateAgentProgress(sess, chunk, opts) {
    opts = opts || {};
    // 两个函数都必须用完整声明：resolveAgentState 的 body 里裸用形参 args，
    // 缺了 function 头就会 ReferenceError: args is not defined。
    const resolveSrc = extractFunctionFull(message, 'resolveAgentState');
    const progressSrc = extractFunctionFull(message, 'updateAgentProgress');
    const hintTextSrc = extractFunctionFull(message, 'agentProgressHintText');
    const presentSrc = extractFunctionFull(message, 'resolveToolPresentation');
    const tagSrc = extractFunctionFull(message, 'tagToolName');
    const factory = new Function(
        '$', 'escapeHtml', 'window', 'GourdI18n',
        resolveSrc + '\n' + hintTextSrc + '\n' + presentSrc + '\n' + tagSrc + '\n' + progressSrc
        + '\nreturn updateAgentProgress;'
    );
    const i18n = opts.i18n || makeI18n(opts.locale || 'zh-CN');
    const win = {
        GourdToolPresentation: opts.presentation || toolPresentation,
        // resolveToolPresentation 只读 window.GourdI18n，这里给真语言包的 chat 子集，
        // 使「心跳行显示中文还是裸英文名」由真实映射表决定，而不是测试自带结论。
        GourdI18n: i18n,
    };
    return factory(makeJQuery(),
        (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])),
        win, i18n)(sess, chunk);
}

test('updateAgentProgress：工具名走本地化展示名（不得直出英文注册名）', () => {
    const { card, header } = buildAgentCard('inv-1');
    const sess = {
        agentCards: { 'inv-1': card },
        agentStates: { 'inv-1': { id: 'inv-1', card, bodyEl: card.find('.agent-card-body').first() } },
    };

    runUpdateAgentProgress(sess, { type: 'agent_progress', args: { invocationId: 'inv-1', toolName: 'grep' } });

    const hint = header.children.find(c => c.classList.contains('agent-progress-hint'));
    assert.ok(hint, '必须在 header 里建出进度行');
    // 断言口径：必须等于「公共展示模型 + zh-CN 语言包」算出的值，测试不自带结论。
    // 必须显式传 translate：公共模型不传时 localized 回退裸名，那样这条期望值
    // 本身就会算出 '· grep'，与生产输出不一致时看起来像「代码错了」而非「测试搭错」。
    const i18n = makeI18n('zh-CN');
    const expect = '· ' + toolPresentation.resolveToolPresentation('grep', null, {
        nested: true, translate: (k) => i18n.t(k),
    }).displayName;
    assert.equal(hint.textContent, expect, '心跳必须用本地化展示名');
    assert.equal(hint.textContent, '· 搜索', 'zh-CN 下 grep 必须显示「搜索」而非裸英文名');
    assert.equal(hint.parentNode, header,
        '必须挂在 header 而非 body：body 默认折叠，心跳写进折叠区就完全不可见，'
        + '与「卡片卡死」无法区分');
});

test('updateAgentProgress：未登记的工具名回退裸名，不得显示成空', () => {
    // MCP/OpenAPI 工具名是运行期拼出来的（如 mcp__foo__bar），必然不在映射表里；
    // 此时只能回退裸名，但不能把整行弄空或弄成 key 串。
    const { card, header } = buildAgentCard('inv-unmapped');
    const sess = {
        agentCards: { 'inv-unmapped': card },
        agentStates: { 'inv-unmapped': { id: 'inv-unmapped', card } },
    };
    runUpdateAgentProgress(sess, {
        type: 'agent_progress', args: { invocationId: 'inv-unmapped', toolName: 'search_tools_xyz' },
    });
    const hint = header.children.find(c => c.classList.contains('agent-progress-hint'));
    assert.equal(hint.textContent, '· search_tools_xyz', '未知名必须原样回退');
});

test('updateAgentProgress：心跳行必须存原始工具名以供语言切换重译', () => {
    // 译文写死进文本节点后 translateDOM 扫不到；不存 data-i18n-tool 就等于「切语言后
    // 其余卡片都变了，只有这一行停在旧语言」。
    const { card, header } = buildAgentCard('inv-tag');
    const sess = {
        agentCards: { 'inv-tag': card },
        agentStates: { 'inv-tag': { id: 'inv-tag', card } },
    };
    runUpdateAgentProgress(sess, { type: 'agent_progress', args: { invocationId: 'inv-tag', toolName: 'todowrite' } });
    const hint = header.children.find(c => c.classList.contains('agent-progress-hint'));
    assert.equal(hint.getAttribute('data-i18n-tool'), 'todowrite',
        '必须存注册名（不是译文）才能重译');
    assert.equal(hint.getAttribute('data-i18n-tool-nested'), '1',
        '必须存 nested 标记，否则重译后凭空多出「来源/」前缀');
    assert.equal(hint.textContent, '· 任务清单', 'todowrite 与 todoread 共用一个语义键');
});

test('relocalizeDynamicLabels：必须重译 .agent-progress-hint', () => {
    const body = extractFunction(message, 'relocalizeDynamicLabels');
    assert.match(body, /querySelectorAll\('\.agent-progress-hint\[data-i18n-tool\]'\)/,
        '心跳行不在 .tool-name 里，少了这条选择器就是语言切换漏译');
    assert.match(body, /agentProgressHintText\(/,
        '重译必须复用同一个文案出口，不得在这里另写一份前缀拼接');
    assert.match(body, /nested:\s*true/,
        '重译时的 nested 必须与渲染时一致');
});

test('updateAgentProgress：复用同一行，不随工具调用次数无限增长', () => {
    const { card, header } = buildAgentCard('inv-2');
    const sess = {
        agentCards: { 'inv-2': card },
        agentStates: { 'inv-2': { id: 'inv-2', card } },
    };
    for (const tool of ['grep', 'read', 'bash', 'write']) {
        runUpdateAgentProgress(sess, { type: 'agent_progress', args: { invocationId: 'inv-2', toolName: tool } });
    }
    const hints = header.children.filter(c => c.classList.contains('agent-progress-hint'));
    assert.equal(hints.length, 1,
        '一次后台任务可能调上百次工具，每次新建一行会把 header 撑爆；必须复用同一行');
    assert.match(hints[0].textContent, /写入/, '必须显示最后一次的工具名');
});

test('updateAgentProgress：卡片不存在时静默忽略，绝不新建卡', () => {
    // agent_start 被回放分页的字节预算裁剪丢弃时，心跳会找不到归属卡
    const sess = { agentCards: {}, agentStates: {} };
    assert.doesNotThrow(() => runUpdateAgentProgress(sess,
        { type: 'agent_progress', args: { invocationId: 'ghost', toolName: 'grep' } }),
        '归属卡不存在时必须静默忽略');
    assert.equal(Object.keys(sess.agentCards).length, 0,
        '绝不能新建卡：心跳帧不含成败位，据此建出的卡会永远停在 loading 态');
});

test('updateAgentProgress：缺 toolName 时不动 DOM', () => {
    const { card, header } = buildAgentCard('inv-3');
    const sess = { agentCards: { 'inv-3': card }, agentStates: { 'inv-3': { id: 'inv-3', card } } };
    runUpdateAgentProgress(sess, { type: 'agent_progress', args: { invocationId: 'inv-3' } });
    assert.equal(header.children.length, 0, '没有工具名就没有可展示的信息，不该建空行');
});

test('updateAgentProgress：按 invocationId 归属，并行同名代理不串卡', () => {
    const a = buildAgentCard('inv-A');
    const b = buildAgentCard('inv-B');
    const sess = {
        agentCards: { 'inv-A': a.card, 'inv-B': b.card },
        agentStates: { 'inv-A': { id: 'inv-A', card: a.card }, 'inv-B': { id: 'inv-B', card: b.card } },
    };
    // 两个都叫 explore 的并行后台任务
    const base = { agentName: 'explore', description: '同名任务' };
    runUpdateAgentProgress(sess, { args: Object.assign({}, base, { invocationId: 'inv-A', toolName: 'grep' }) });
    runUpdateAgentProgress(sess, { args: Object.assign({}, base, { invocationId: 'inv-B', toolName: 'read' }) });

    const hintA = a.header.children.find(c => c.classList.contains('agent-progress-hint'));
    const hintB = b.header.children.find(c => c.classList.contains('agent-progress-hint'));
    assert.ok(hintA && /搜索/.test(hintA.textContent), 'A 卡必须显示 A 的工具');
    assert.ok(hintB && /读取/.test(hintB.textContent), 'B 卡必须显示 B 的工具');
    assert.ok(!/读取/.test(hintA.textContent), '同名代理不得串卡');
});

test('appendAgentBadge：收卡时必须清掉陈旧进度行', () => {
    const badge = extractFunction(message, 'appendAgentBadge');
    const updateBranch = badge.slice(0, badge.indexOf('// 创建容器型智能体卡片'));
    assert.match(updateBranch, /\$\(existCard\)\.find\('\.agent-progress-hint'\)\.remove\(\);/,
        '任务已结束后留着「· grep」会让用户以为子代理还在跑，而状态点已转 done/reject，'
        + '两者语义直接矛盾');
    // 清理必须在收卡分支内（agent_end 命中已登记容器的路径）
    const removeIdx = updateBranch.indexOf(".agent-progress-hint");
    const deleteIdx = updateBranch.indexOf('delete sess.agentCards[agentId]');
    assert.ok(removeIdx > 0 && deleteIdx > 0, '应能定位收卡分支的两个锚点');
});

/* ══════════════════════════════════════════════════════════════════
   6. CSS：进度行不得被描述挤没
   ══════════════════════════════════════════════════════════════════ */

test('app.css：.agent-progress-hint 必须 flex-shrink:0 且用中性色', () => {
    const m = /\.agent-progress-hint\s*\{([^}]*)\}/.exec(css);
    assert.ok(m, '.agent-progress-hint 规则必须存在');
    const decl = m[1];

    assert.match(decl, /order:\s*5/, '必须排在描述（order:4）之后');
    assert.match(decl, /flex-shrink:\s*0/,
        '刻意不让它被描述挤压：描述本就带 ellipsis 可截断，而心跳是唯一的「子代理还活着」信号，'
        + '被挤没就失去全部价值');
    assert.match(decl, /text-overflow:\s*ellipsis/, '超长工具名必须自己截断，不得反撑 header');
    assert.match(decl, /max-width:\s*\d+em/, '必须有宽度上限配合 ellipsis');
    assert.match(decl, /color:\s*var\(--text-tertiary\)/,
        '必须用中性 token：--accent 在 light 下近黑、dark 下近白，任何 alpha 都无法同时适配'
        + '两个主题，且会把弱状态抬到与正文同权重');
    assert.ok(!/color:\s*var\(--accent/.test(decl), '不得用 accent 派生色');
});

test('app.css：header 的 flex 布局与 overflow 前提未被破坏', () => {
    const m = /\.agent-card-header\s*\{([^}]*)\}/.exec(css);
    assert.ok(m, '.agent-card-header 规则必须存在');
    assert.match(m[1], /display:\s*flex/, '进度行靠 flex order 定位，header 必须是 flex');
    assert.match(m[1], /overflow:\s*hidden/, 'header 必须裁掉溢出，否则长工具名会撑破布局');
});
