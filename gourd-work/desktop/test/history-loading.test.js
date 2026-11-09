/**
 * 契约测试：历史会话恢复加载态（防白屏骨架屏）。
 *
 * ── 缺陷现场（2026-10-31，用户报「rust 版本打开历史会话会白屏」）──────────────
 * 侧栏点开历史会话 → doSwitchSession → loadMessages 发 /web/chat/replay。
 * 该初始请求【没有 timeout】，且长会话回放是「临时容器分片构建 → 一次性移入真实
 * 容器」：从请求发出到 DOM 落地，消息区整段空白。慢盘 / 大 session / 后端冷启动
 * 时窗口可达数秒，用户感知为白屏（深色主题是黑屏）。
 *
 * ── 为什么覆盖层不插进 sess.container ────────────────────────────────────────
 * 全项目 4 处把 `sess.container.children.length === 0` 当作「需要重新拉历史」的
 * 【唯一】判据（app-history.js doSwitchSession / openSessionById、app-base.js
 * evictInactiveSessions、app-streaming.js handleIdleAgentChunk 的注释链）。
 * 骨架节点混进容器 → 判据恒为 false → 切回会话只剩骨架、历史消息永久看不见。
 * 所以覆盖层挂 .messages-shell 而不是塞进正文容器。
 *  【2026-11-04 布局修正】.messages-shell 现【常驻】relative，作为 rail / 覆盖层的
 *  共同定位父级；旧契约「relative 只限加载态期间，永久 relative 会改写子树绝对元素
 *  的定位参考」已作废 —— 复核确认子树内其它 absolute 浮层都有更近 positioned 祖先，
 *  不受影响。下方用例反过来锁死「必须常驻 relative」。
 *
 * ── 测试形态 ──────────────────────────────────────────────────────────────
 * 在 node:vm 沙箱里真跑 app-history.js 的加载态区块（骨架 HTML 生成、show/hide
 * 归属校验、超时降级、shell class 同步、重试分发），配假 DOM 与假定时器；
 * 另用源码断言守住「五个收尾出口 + setActiveSession 汇聚点」的接线不丢失。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const uiRoot = path.resolve(__dirname, '../ui');
const HISTORY_SRC = fs.readFileSync(path.join(uiRoot, 'js', 'app-history.js'), 'utf8');
const BASE_SRC = fs.readFileSync(path.join(uiRoot, 'js', 'app-base.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(uiRoot, 'css', 'app.css'), 'utf8');
const LOCALE = JSON.parse(fs.readFileSync(path.join(uiRoot, 'locales', 'zh-CN.json'), 'utf8'));

/* 骨架周期行数：从源码里数模板行数，而非另写一份常量——写死副本会在
   模板增删行时静默失准，断言就变成了「测自己的常量」。 */
const HISTORY_ROW_COUNT = (() => {
    const at = HISTORY_SRC.indexOf('var HISTORY_SKELETON_ROWS = [');
    const end = HISTORY_SRC.indexOf('];', at);
    assert.ok(at > 0 && end > at, 'HISTORY_SKELETON_ROWS 模板丢失');
    return (HISTORY_SRC.slice(at, end).match(/\{ cls:/g) || []).length;
})();

/* ===== 区块提取：加载态 helper（标记注释起，到 loadMessages 定义前止） ===== */
function extractLoadingBlock(src) {
    const start = src.indexOf('/* ===== 历史会话恢复加载态（防白屏骨架屏） =====');
    const end = src.indexOf('function loadMessages(sess) {');
    assert.ok(start > 0 && end > start, '加载态区块边界丢失');
    return src.slice(start, end);
}

/* ===== 极简假 DOM：只实现被测路径用到的能力 ===== */
function makeEl(tag) {
    const el = {
        tagName: tag,
        children: [],
        attrs: {},
        style: {},
        dataset: {},
        _html: '',
        _classes: [],
        parent: null,
        set className(v) { this._classes = String(v).split(/\s+/).filter(Boolean); },
        get className() { return this._classes.join(' '); },
        set innerHTML(v) { this._html = String(v); },
        get innerHTML() { return this._html; },
        /* 记录「入文档那一刻」的 innerHTML。aria-live 只在【已存在于文档中】的 live
           region 内文本发生变化时播报；把一棵已带好文本的子树一次性 append 进去，
           多数读屏器视为「新节点」而非「内容变化」，不播报。
           这个快照是唯一能区分两种顺序的观测点。 */
        appendChild(c) { c._htmlAtAppend = c._html; c.parent = this; this.children.push(c); return c; },
        remove() {
            if (!this.parent) return;
            this.parent.children = this.parent.children.filter(x => x !== this);
            this.parent = null;
        },
        contains(o) { for (let p = o; p; p = p.parent) if (p === this) return true; return false; },
        querySelector(sel) {
            const tok = sel.replace(/^\./, '');
            const walk = (n) => {
                for (const c of n.children) {
                    if (c._classes.includes(tok)) return c;
                    const hit = walk(c);
                    if (hit) return hit;
                }
                return null;
            };
            return walk(this);
        },
        get textContent() { return this._html; },
    };
    el.classList = {
        add: (c) => { if (!el._classes.includes(c)) el._classes.push(c); },
        remove: (c) => { el._classes = el._classes.filter(x => x !== c); },
        contains: (c) => el._classes.includes(c),
        toggle: (c, on) => { if (on) el.classList.add(c); else el.classList.remove(c); },
        _owner: el,
    };
    el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
    return el;
}

function harness() {
    const shell = makeEl('div');
    shell._classes = ['messages-shell'];
    const timers = [];
    let now = 0;
    const events = [];
    let loadMessagesCalls = 0;

    const sandbox = {
        console,
        document: {
            getElementById: (id) => (id === 'messagesShell' ? shell : null),
            createElement: (tag) => makeEl(tag),
            contains: () => true,
            addEventListener: () => {},
        },
        // helper 假定 escapeHtml 由先装载的 app-base 提供（裸全局）
        escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        GourdI18n: { t: (k) => k.split('.').reduce((o, p) => (o && o[p] !== undefined ? o[p] : undefined), LOCALE) || k },
        messagesWrap: (() => { const w = makeEl('div'); shell.appendChild(w); return w; })(),
        sessionMap: {},
        activeSessionId: null,
        drainGateBuffer: () => {},
        loadMessages: () => { loadMessagesCalls++; },
        setTimeout: (fn, ms) => { const h = { fn, at: now + ms, cleared: false }; timers.push(h); return h; },
        clearTimeout: (h) => { if (h) h.cleared = true; },
        __tick: (ms) => {
            now += ms;
            const due = timers.filter(t => !t.cleared && t.at <= now);
            timers.splice(0, timers.length);
            due.forEach(t => t.fn());
            return due.length;
        },
        __timerCount: () => timers.filter(t => !t.cleared).length,
        __loadMessagesCalls: () => loadMessagesCalls,
    };
    // 极简 jQuery 面：只覆盖 helper 用到的调用形态
    sandbox.$ = function (arg) {
        if (arg === sandbox.document) {
            return { on: (ev, sel, fn) => { events.push({ ev, sel, fn }); } };
        }
        return {
            // closest 语义：从自身沿 parent 链找第一个匹配 class 的节点
            closest: (sel) => {
                const tok = sel.replace(/^\./, '');
                for (let p = arg; p; p = p.parent) if (p._classes && p._classes.includes(tok)) return { 0: p };
                return { 0: null };
            },
            parent: () => ({ 0: arg && arg.parent }),
        };
    };
    vm.createContext(sandbox);
    // 真实页面里顶层函数声明自动挂到 window；沙箱需显式自引用才能跑同一行赋值
    sandbox.window = sandbox;
    vm.runInContext(extractLoadingBlock(HISTORY_SRC), sandbox);
    return { shell, sandbox, events };
}

function mkSess(sandbox, sid, filled) {
    const container = makeEl('div');
    container._classes = ['messages-inner'];
    if (filled) container.appendChild(makeEl('div'));
    sandbox.sessionMap[sid] = { sessionId: sid, container };
    return sandbox.sessionMap[sid];
}

const overlayOf = (shell) => shell.querySelector('.chat-history-loading');

/* ===== 1. 白屏窗口被骨架层覆盖 ===== */
test('发请求前挂骨架：覆盖层落在 shell 上，不进 sess.container', () => {
    const { shell, sandbox } = harness();
    const sess = mkSess(sandbox, 'work-A', false);
    sandbox.showHistoryLoading(sess);

    const ov = overlayOf(shell);
    assert.ok(ov, '覆盖层必须存在（否则就是用户报的白屏）');
    assert.equal(ov.dataset.ownerSession, 'work-A');
    assert.ok(ov._html.includes('chl-row'), '骨架行必须存在');
    assert.equal(ov.attrs['aria-live'], 'polite', '读屏可达');
    // 关键反向锁死：容器判空是「要不要重拉历史」的唯一判据，骨架绝不能进容器
    assert.equal(sess.container.children.length, 0, 'sess.container 必须保持空');
    assert.equal(shell._classes.includes('has-history-loading'), true, '加载态期间必须挂上状态标记');
});

test('容器已有内容时不放骨架（不遮挡正文）', () => {
    const { shell, sandbox } = harness();
    const sess = mkSess(sandbox, 'work-B', true);
    sandbox.showHistoryLoading(sess);
    assert.equal(overlayOf(shell), null);
});

test('骨架文案来自 i18n', () => {
    const { shell, sandbox } = harness();
    const sess = mkSess(sandbox, 'work-C', false);
    sandbox.showHistoryLoading(sess);
    assert.ok(overlayOf(shell)._html.includes(LOCALE.history.msgLoading));
});

/* ===== 2. 收尾必须撤干净，且 shell class 不悬挂 ===== */
test('hide 正常路径：覆盖层移除 + shell 状态标记一并撤销', () => {
    const { shell, sandbox } = harness();
    const sess = mkSess(sandbox, 'work-D', false);
    sandbox.showHistoryLoading(sess);
    sandbox.hideHistoryLoading(sess);
    assert.equal(overlayOf(shell), null, '内容落地后不得残留骨架');
    assert.equal(shell._classes.includes('has-history-loading'), false, '不得悬挂状态标记');
    assert.equal(sandbox.__timerCount(), 0, '超时定时器必须随之清理');
});

/* ===== 3. 失败/超时降级：绝不静默留白，也绝不永久转圈 ===== */
test('请求超时 12s → 降级为失败卡 + 重试按钮（不永久转圈）', () => {
    const { shell, sandbox } = harness();
    const sess = mkSess(sandbox, 'work-E', false);
    sandbox.showHistoryLoading(sess);
    const fired = sandbox.__tick(sandbox.HISTORY_LOAD_TIMEOUT_MS);
    assert.equal(fired, 1, '超时必须真的触发一次');
    const ov = overlayOf(shell);
    assert.ok(ov._classes.includes('chl-failed'), '转为失败态');
    assert.ok(ov._html.includes(LOCALE.history.msgFailed));
    assert.ok(ov._html.includes('chl-retry-btn'), '必须提供重试入口');
});

test('超时前已收尾 → 定时器被清，不会事后亮出失败卡', () => {
    const { shell, sandbox } = harness();
    const sess = mkSess(sandbox, 'work-F', false);
    sandbox.showHistoryLoading(sess);
    sandbox.hideHistoryLoading(sess);
    sandbox.__tick(sandbox.HISTORY_LOAD_TIMEOUT_MS + 1000);
    assert.equal(overlayOf(shell), null);
});

test('失败语义 + 容器已有内容 → 只撤骨架，绝不叠失败卡', () => {
    const { shell, sandbox } = harness();
    const sess = mkSess(sandbox, 'work-G', false);
    sandbox.showHistoryLoading(sess);
    sess.container.appendChild(makeEl('div'));   // 回放异常但半成品已并入容器
    sandbox.hideHistoryLoading(sess, { failed: true });
    assert.equal(overlayOf(shell), null, '有可用内容时不该报「加载失败」');
});

test('失败语义 + 容器仍空 → 亮失败卡（不留白）', () => {
    const { shell, sandbox } = harness();
    const sess = mkSess(sandbox, 'work-H', false);
    sandbox.showHistoryLoading(sess);
    sandbox.hideHistoryLoading(sess, { failed: true });
    const ov = overlayOf(shell);
    assert.ok(ov && ov._classes.includes('chl-failed'));
    assert.equal(sess.container.children.length, 0, '失败卡同样不得进容器');
});

/* ===== 4. 跨会话竞态：迟到回调不许动别人的骨架 ===== */
test('旧会话迟到的 hide → 新会话正在显示的骨架不受影响', () => {
    const { shell, sandbox } = harness();
    const oldS = mkSess(sandbox, 'work-OLD', false);
    const cur = mkSess(sandbox, 'work-NEW', false);
    sandbox.showHistoryLoading(oldS);
    sandbox.dismissHistoryLoadingExcept('work-NEW');
    sandbox.showHistoryLoading(cur);
    sandbox.hideHistoryLoading(oldS, { failed: true });
    const ov = overlayOf(shell);
    assert.ok(ov, '新会话骨架必须还在');
    assert.equal(ov.dataset.ownerSession, 'work-NEW');
});

test('setActiveSession 汇聚钩子：只撤「不属于新活动会话」的残留层', () => {
    const { shell, sandbox } = harness();
    const a = mkSess(sandbox, 'work-A1', false);
    sandbox.showHistoryLoading(a);
    sandbox.dismissHistoryLoadingExcept('work-A1');
    assert.ok(overlayOf(shell), '同会话不得误撤（否则白屏回来了）');
    sandbox.dismissHistoryLoadingExcept('work-A2');
    assert.equal(overlayOf(shell), null, '切到别的会话必须撤干净');
    assert.equal(shell._classes.includes('has-history-loading'), false);
});

/* ===== 5. 重试链路：点重试 = 重走同一条加载管线 ===== */
test('重试按钮：摘卡 → 调 loadMessages（骨架由其重新放下）', () => {
    const { shell, sandbox, events } = harness();
    const sess = mkSess(sandbox, 'work-R', false);
    sandbox.showHistoryLoading(sess);
    sandbox.__tick(sandbox.HISTORY_LOAD_TIMEOUT_MS);
    const ov = overlayOf(shell);
    const handler = events.find(e => e.sel === '.chl-retry-btn');
    assert.ok(handler, '必须注册重试委托处理器');
    const btn = makeEl('button');
    btn._classes = ['chl-retry-btn'];
    ov.appendChild(btn);
    // 处理器内用 $(this).closest(...)：this 绑定为按钮
    handler.fn.call(btn);
    assert.equal(sandbox.__loadMessagesCalls(), 1, '重试必须真的重新发起加载');
    assert.equal(overlayOf(shell), null, '旧失败卡必须摘掉');
    assert.equal(shell._classes.includes('has-history-loading'), false);
});

/* ===== 6. 接线不丢失（源码级守卫）：五个出口 + setActiveSession 汇聚点 ===== */
test('收尾出口全部接线（漏一处就永远转圈）', () => {
    const checks = [
        ['    showHistoryLoading(sess);', 1],                                    // loadMessages 发请求前
        ['        hideHistoryLoading(sess);   // 内容即将移入真实容器', 1],          // replayDoneCore
        ['                hideHistoryLoading(sess);', 1],                        // legacy loadDone
        /* 5 处：回放兜底 + legacy catch + legacy fail + 超时定时器 + stall 盲兜底
           （2026-11 P0-2：回放卡死宽限耗尽后的强制收口出口）。
           超时分支必须复用 hideHistoryLoading，而不是自己写失败卡 ——
           后者会绕过「容器已有内容 ⇒ 绝不叠失败卡」这条守卫（缺陷已实测复现）。 */
        ['hideHistoryLoading(sess, { failed: true });', 5],
    ];
    for (const [needle, want] of checks) {
        const got = HISTORY_SRC.split(needle).length - 1;
        assert.equal(got, want, 'app-history 接线数量不符: ' + needle + ' got=' + got);
    }
    assert.ok(/hideHistoryLoading\(sess, \{ failed: true \}\);\s*\r?\n\s*drainGateBuffer\(sess\);/.test(HISTORY_SRC),
        'legacy 请求失败必须先撤加载态再释放门禁');
    assert.equal(BASE_SRC.split('window.dismissHistoryLoadingExcept(sessionId)').length - 1, 1,
        'setActiveSession 是唯一切换汇聚点，钩子必须在');
});

test('CSS 规格：主题变量驱动 + 减少动效偏好 + 位置修正后的定位父级', () => {
    /* 2026-11-04「滚动条和刻度位置反了」修复：刻度带从「与 wrap 并排的 flex 列」
        改为「叠在 wrap 右缘内侧的 absolute 覆盖层」，.messages-shell 因此必须常驻
        relative 作为 rail / 覆盖层的共同定位父级。旧契约（relative 只限加载态期间）
        随布局模型一并作废，这里反过来锁死「必须常驻」。 */
    assert.ok(/\.messages-shell \{[\s\S]*?position: relative;/.test(CSS_SRC),
        '.messages-shell 必须常驻 relative（rail 与加载覆盖层的定位父级）');
    assert.ok(/\.messages-shell > \.messages-wrap \{ position: absolute; inset: 0; \}/.test(CSS_SRC),
        '.messages-wrap 必须占满 shell（滚动条才能落在内容区最右）');
    assert.ok(/\.history-rail \{[\s\S]*?right: var\(--scrollbar-w, 0px\)/.test(CSS_SRC),
        '刻度带必须用实测滚动条宽度让位，把滚动条留在最右');

    /* 精确取「覆盖层主规则」的块体（不是 .chl-* 子元素、也不是 .chat-history-loading-in
       关键帧）：花括号配对切一次，断言只落在这一块内。
       WHY 严格：上一版用 [\s\S]{0,400}? 匹配底色，跨到了别的规定块——变异体把底色写成
       #ffffff 时测试照样通过（实测存活）。深色主题的覆盖层一旦写死白底，「打开历史会话
       = 白屏」会以新形式复活，这条必须真锁死。 */
    const marker = '.chat-history-loading {';
    const at = CSS_SRC.indexOf(marker);
    assert.ok(at > 0, '覆盖层主规则缺失');
    const bodyStart = at + marker.length;
    const bodyEnd = CSS_SRC.indexOf('}', bodyStart);
    assert.ok(bodyEnd > bodyStart, '覆盖层主规则块未闭合');
    const block = CSS_SRC.slice(bodyStart, bodyEnd);
    assert.ok(/background:\s*var\(--bg-main\)/.test(block),
        '底色必须走主题变量 var(--bg-main)（明暗主题与强调色自适应），禁止写死色值');
    assert.ok(!/#(?:fff|ffffff|000|000000)\b/i.test(block),
        '覆盖层主规则内不得出现写死的黑白色（深色主题会复现白屏）');

    assert.ok(/prefers-reduced-motion: reduce/.test(CSS_SRC), '尊重系统减少动效偏好');
    assert.ok(CSS_SRC.includes('chl-shimmer'), '骨架流光必须保留（加载信号的全部来源）');
    // reduced-motion 块必须真的含 .chl-line：骨架只剩流光这一种动效，
    // 漏掉它等于「减少动效」完全失效，而只断言存在 @media 是测不出来的
    const rmAt = CSS_SRC.lastIndexOf('@media (prefers-reduced-motion: reduce)');
    assert.ok(rmAt > 0, '加载态的 reduced-motion 块缺失');
    const rmBodyEnd = CSS_SRC.indexOf('}', CSS_SRC.indexOf('{', rmAt));
    const rmBlock = CSS_SRC.slice(rmAt, rmBodyEnd + 1);
    assert.match(rmBlock, /\.chl-line/, 'reduced-motion 必须把骨架流光一并停掉');
    assert.match(rmBlock, /\.chl-row/, 'reduced-motion 必须把逐行升起停掉');
    assert.match(rmBlock, /animation:\s*none/, 'reduced-motion 必须真的置 animation:none');
});

/* ===== 7. 加载态视觉：去掉「进度条+圆环+小字」三件套，骨架铺满全区 =====
   用户报「这有点丑」，截图红框正指向那一组三件套。实测量化根因：进度条填充
   对比度 17.72:1，而它代表的消息骨架只有 1.12~1.27:1 —— 装饰比内容抢眼 13.95 倍。
   这一组断言同时锁三层：①三件套不得复活；②行数按高度铺满而不是写死 4 行；
   ③删掉可见文案后 aria-live 不能变哑。 */
function cssRuleBody(sel) {
    const at = CSS_SRC.indexOf(sel + ' {');
    if (at < 0) return null;
    const s = at + sel.length + 2;
    const e = CSS_SRC.indexOf('}', s);
    return e > s ? CSS_SRC.slice(s, e) : null;
}
const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('三件套（进度条/圆环/可见文案）不得复活', () => {
    const js = stripJsComments(HISTORY_SRC);
    const skeleton = js.slice(js.indexOf('function historySkeletonHtml'), js.indexOf('function historyFailedHtml'));
    assert.ok(skeleton.length > 0, 'historySkeletonHtml 边界丢失');
    for (const cls of ['chl-bar', 'chl-ring', 'chl-text', 'chl-foot']) {
        assert.ok(!skeleton.includes(cls), '骨架模板不得再生成 .' + cls + '（用户已否决三件套）');
        assert.equal(cssRuleBody('.' + cls), null, 'CSS 不得为已删除的 .' + cls + ' 保留规则');
    }
    assert.ok(!CSS_SRC.includes('chl-indeterminate'), '不确定态进度条动画必须一并删除');
});

test('骨架行数按容器高度铺满，不得写死 4 行', () => {
    const fn = HISTORY_SRC.slice(HISTORY_SRC.indexOf('function historySkeletonRowsFor'), HISTORY_SRC.indexOf('function historySkeletonHtml'));
    assert.ok(fn.length > 0, 'historySkeletonRowsFor 缺失');
    // 必须真的用到传入高度；只写死常量就回到「只展示上半部分」的老缺陷
    assert.match(fn, /availH/, '行数计算必须使用可用高度参数');
    assert.match(fn, /HISTORY_SKELETON_ROW_HEIGHTS/, '必须按逐行实测行高累加，不能取均值');
    assert.match(fn, /HISTORY_SKELETON_ROW_GAP_PX/, '行间 margin 必须单独建模');
    assert.match(fn, /HISTORY_SKELETON_MAX_ROWS/, '必须有上限，否则超长容器会生成上千行');
    /* 【关键】「末行底边」与「下一行起点」必须是两个量。
       实测踩过：两者混用一个变量，641 容器算出含 gap 的 662 被误判达标，
       而真实 10 行只能盖到 634px，永远差 7px。 */
    assert.match(fn, /var cursor = HISTORY_SKELETON_TOP_PAD_PX;/, '必须有 cursor（下一行起点）');
    assert.match(fn, /var bottom = HISTORY_SKELETON_TOP_PAD_PX;/, '必须有 bottom（末行底边）——二者不得合并');
    /* 循环必须同时受高度与上限约束：只写 bottom < availH 时，availH=1e9 会跑
       约 2500 万次（实测 122ms）。上限写在循环条件里才是真的收敛。 */
    assert.match(fn, /while \(bottom < availH && need < HISTORY_SKELETON_MAX_ROWS\)/,
        '达标判据看 bottom，同时必须用 MAX_ROWS 刹住循环次数');
    assert.match(fn, /bottom = cursor \+ heights\[/, '末行底边 = 起点 + 行高（不含 gap）');
    assert.match(fn, /cursor = bottom \+ gap;/, '下一行起点 = 本行底边 + gap');
    // 拿不到高度（契约测试假 DOM / 内联未布局）必须仍有完整周期，绝不能退化成 0 行
    /* 用【行为】断言而非锁字面写法：守卫补了 isFinite 后变成
       「!(availH > 0) || !isFinite(availH)」，写死正则会让一次正确的加固变异成红。
       行为才是契约（真正的行为断言在下方 sandbox 就绪后）。 */

    // HEIGHTS 必须与模板行数等长（两处写死就会彼此漂移）
    const sm = HISTORY_SRC.match(/var HISTORY_SKELETON_ROW_HEIGHTS = \[([^\]]+)\]/);
    assert.ok(sm, 'HEIGHTS 常量缺失');
    const heights = sm[1].split(',').map(x => Number(x.trim()));
    assert.equal(heights.length, HISTORY_ROW_COUNT, 'HEIGHTS 必须与模板行数等长');
    // 模板里单行助手的行高应小于多行助手（否则说明模板或行高表错了）
    const lineCounts = (() => {
        const at = HISTORY_SRC.indexOf('var HISTORY_SKELETON_ROWS = [');
        const end = HISTORY_SRC.indexOf('];', at);
        const seg = HISTORY_SRC.slice(at, end);
        return [...seg.matchAll(/widths: \[([^\]]*)\]/g)].map(m => m[1].split(',').length);
    })();
    assert.equal(lineCounts.length, heights.length, '行高表必须与模板行一一对应');
    lineCounts.forEach((n, i) => {
        if (n === 1) assert.ok(heights[i] <= 32, `第 ${i} 行是单行，行高不应 > 32（实际 ${heights[i]}）`);
        if (n === 3) assert.ok(heights[i] >= 48, `第 ${i} 行是三行，行高不应 < 48（实际 ${heights[i]}）`);
    });

    // 真实行为：不同高度 → 不同行数，且单调不减
    const { sandbox } = harness();
    /* 【循环上限必须用耗时锁，返回值锁不住】
       把 while 条件里的 need < MAX_ROWS 删掉后，返回值依然被 return 处的 Math.min
       截到 64 —— 只断言返回值就会认为「行为等价」，上一轮因此把这道上限误删了。
       真实差异在运行时间：availH=1e9 时循环跑约 2500 万次、实测 122ms（纯 O(availH)），
       加回上限后降到 0.006ms。所以这里必须断言耗时。
       阈值取 3ms：基线实测 0.038ms，变异体（删掉循环上限）实测 12.45ms ——
       取 12ms 时只差 0.45ms，机器抖动就可能漏杀。3ms 对两边都有 78 倍/4 倍余量。 */
    {
        const t0 = process.hrtime.bigint();
        const nHuge = sandbox.historySkeletonRowsFor(1e9);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        assert.equal(nHuge, HISTORY_SRC.match(/var HISTORY_SKELETON_MAX_ROWS = (\d+)/)[1] * 1,
            '巨高容器必须返回上限值');
        assert.ok(ms < 3, '行数计算必须随容器高度收敛，实测 ' + ms.toFixed(3) + 'ms（无循环上限时约 12.45ms）');
    }

    /* 非有限值必须被拦住：Infinity 满足 availH > 0，缺守卫时会进 while 且 bottom
       永远追不上 —— 主线程死锁（已由耗时断言在 2500 万次量级上暴露）。
       【为什么 Infinity 只做源码断言、不做行为断言】行为断言会真的把测试进程挂死：
       守卫被删掉时得到的是「测试超时」而不是「断言失败」，变异验证无法区分
       「杀死了」与「卡死了」，这条护栏等于没有牙。源码断言则能在毫秒内红。
       负值与 NaN 不会死循环，可以做行为断言。 */
    assert.match(fn, /!isFinite\(availH\)/,
        '必须显式排除 Infinity（缺它则 while 永不终止，主线程死锁）');
    assert.equal(sandbox.historySkeletonRowsFor(-1), HISTORY_ROW_COUNT, '负高度必须回退完整周期');
    assert.equal(sandbox.historySkeletonRowsFor(NaN), HISTORY_ROW_COUNT, 'NaN 必须回退完整周期');
    const n540 = sandbox.historySkeletonRowsFor(540);
    const n1200 = sandbox.historySkeletonRowsFor(1200);
    // 641px = 用户截图实际容器高；540px 恰好只需一个周期（52+500=552>540），故用 641 做基准
    const n641 = sandbox.historySkeletonRowsFor(641);
    assert.ok(n641 > HISTORY_ROW_COUNT, '641px 应比一个周期多，实际 ' + n641);
    assert.ok(n1200 > n641, '更高的容器应有更多行（' + n1200 + ' vs ' + n641 + '）');
    assert.ok(n540 <= n641, '矮容器行数不得多于高容器');
    assert.equal(sandbox.historySkeletonRowsFor(0), HISTORY_ROW_COUNT, '无高度退化成一个完整周期');
    // 上限必须真的生效。期望值从源码常量推导（不写死，否则改上限就要同步改测试）：
    // MAX_ROWS 同时作用于 while 终止条件与 return 的 Math.min，两处漏一处都会走出界。
    const maxM = HISTORY_SRC.match(/var HISTORY_SKELETON_MAX_ROWS = (\d+)/);
    assert.ok(maxM, 'MAX_ROWS 常量缺失');
    const MAXROWS = Number(maxM[1]);
    assert.equal(sandbox.historySkeletonRowsFor(1e9), MAXROWS, '巨高容器必须被硬上限刹住');
    assert.equal(sandbox.historySkeletonRowsFor(1e6), MAXROWS, '百万 px 高度同样撞上限');
    // 反向：上限必须足够大，否则正常容器就铺不满
    assert.ok(MAXROWS >= 16, '上限过小会让 4K 容器铺不满，实际 ' + MAXROWS);

    // 行数必须是【精确值】：只断言「盖满」区分不了 TOP_PAD 误差——
    // TOP_PAD 42→52 时行数 11→10，但两者末行超出容器被裁，可见覆盖都是 641px。
    // 所以必须同时钉住行数，才能抓住 TOP_PAD 的偏移。
    assert.equal(n641, 11, '641px 容器精确需要 11 行（TOP_PAD/行高/gap 任一漂移都会改变它）');

    // 铺满验收：641px 容器必须至少盖到 641px。
    // 模型：TOP_PAD + Σ行高 + (行数-1)×gap —— 末行之后不加 gap
    const gapM = HISTORY_SRC.match(/var HISTORY_SKELETON_ROW_GAP_PX = (\d+)/);
    const padM = HISTORY_SRC.match(/var HISTORY_SKELETON_TOP_PAD_PX = (\d+)/);
    assert.ok(gapM && padM, 'GAP / TOP_PAD 常量缺失');
    // TOP_PAD 必须等于 CSS 的 padding-top + 首行 margin-top，不得多算动画 translateY
    assert.equal(Number(padM[1]), 42, 'TOP_PAD 必须为 28(padding-top)+14(首行 margin-top)，不得包含动画位移');
    let cover = Number(padM[1]);
    for (let i = 0; i < n641; i++) {
        cover += heights[i % heights.length];
        if (i < n641 - 1) cover += Number(gapM[1]);
    }
    assert.ok(cover >= 641, '641px 容器必须被骨架盖满，实际只盖到 ' + cover + 'px');
});

test('删掉可见文案后读屏仍能听到加载状态', () => {
    const { shell, sandbox } = harness();
    const sess = mkSess(sandbox, 'work-SR', false);
    sandbox.showHistoryLoading(sess);
    const ov = overlayOf(shell);
    // 覆盖层内必须还有可见文字之外的承载：sr-only 文案
    assert.ok(ov._html.includes('chl-sr'), '必须保留 sr-only 文案节点');
    assert.ok(ov._html.includes(LOCALE.history.msgLoading), 'sr-only 文本必须来自 i18n');
    // clip 而非 display:none —— 后者会让读屏也读不到，等于白写
    const sr = cssRuleBody('.chl-sr');
    assert.ok(sr, '.chl-sr 规则必须存在');
    assert.match(sr, /clip/, '读屏专用样式必须用 clip 系方案');
    assert.ok(!/display:\s*none/.test(sr), 'display:none 会连读屏一起隐藏');
    assert.ok(!/visibility:\s*hidden/.test(sr), 'visibility:hidden 会连读屏一起隐藏');
});

test('骨架不得画头像占位圆（真实消息不画头像）', () => {
    // 真实消息侧已注明 msg-avatar removed，骨架凭空多一列圆会造成加载前后跳变
    assert.equal(cssRuleBody('.chl-row-ai::before'), null, '不得再用 ::before 画头像位');
    assert.ok(!CSS_SRC.includes('.chl-row-ai::before'), '不得残留头像伪元素');
    // 反向确认真实消息侧确实没头像（否则本条的前提就错了）
    assert.ok(CSS_SRC.includes('msg-avatar removed'), '真实消息仍是「无头像」形态，本断言前提成立');
});

/* ===== 8. codereview 修复项：五条独立护栏 =====
   每条都对应一个真实缺陷，且都在修复前用真实浏览器/纯函数实测复现过。
   写成「行为断言」而不是「源码里有这行字」，否则实现换个写法就假绿。 */

test('超时降级必须复用 hideHistoryLoading（不得自己写失败卡）', () => {
    /* 缺陷：超时定时器原先直接 cur.innerHTML = historyFailedHtml()，绕过
       「容器已有内容 ⇒ 只撤骨架、绝不叠失败卡」守卫。而失败卡是 absolute inset:0，
       会把 drainGateBuffer 刚灌进来的正文整块盖住（真实浏览器实测复现）。 */
    const showFn = HISTORY_SRC.slice(
        HISTORY_SRC.indexOf('function showHistoryLoading'),
        HISTORY_SRC.indexOf('function hideHistoryLoading'));
    assert.ok(showFn.length > 0, 'showHistoryLoading 边界丢失');
    // 定时器回调内必须先排空缓冲、再交给 hideHistoryLoading 判定
    const timerBody = showFn.slice(showFn.indexOf('_historyLoadingTimers[sess.sessionId] = setTimeout'));
    assert.match(timerBody, /drainGateBuffer\(sess\)/, '超时分支必须先排空实时帧缓冲');
    assert.match(timerBody, /hideHistoryLoading\(sess, \{ failed: true \}\)/,
        '超时分支必须交给 hideHistoryLoading 判定（它是守卫的唯一定义处）');
    assert.ok(!/innerHTML\s*=\s*historyFailedHtml/.test(timerBody),
        '超时分支不得自己写失败卡（会绕过「有内容不叠卡」守卫）');

    // 行为级：超时那一刻缓冲灌入真实内容 → 不得出现失败卡
    const { shell, sandbox } = harness();
    const sess = mkSess(sandbox, 'work-TO', false);
    sandbox.drainGateBuffer = (s) => {
        if (s && s.container && s.container.children.length === 0) s.container.appendChild(makeEl('div'));
    };
    sandbox.showHistoryLoading(sess);
    sandbox.__tick(sandbox.HISTORY_LOAD_TIMEOUT_MS);
    assert.equal(overlayOf(shell), null,
        '缓冲已带来真实内容时，超时不得盖上失败卡（否则正文被整块遮挡）');
    assert.ok(sess.container.children.length > 0, '前提：真实内容确实已落地');
});

test('超时且容器仍空 → 仍要亮失败卡（守卫不能把兜底也吃掉）', () => {
    const { shell, sandbox } = harness();
    const sess = mkSess(sandbox, 'work-TO2', false);
    sandbox.showHistoryLoading(sess);
    sandbox.__tick(sandbox.HISTORY_LOAD_TIMEOUT_MS);
    const ov = overlayOf(shell);
    assert.ok(ov && ov._classes.includes('chl-failed'), '容器空时必须亮失败卡');
    assert.ok(ov._html.includes('chl-retry-btn'), '必须给重试入口');
});

test('live region 必须先入文档、再填内容（否则读屏不播报）', () => {
    /* 缺陷：原实现 el.innerHTML = ... 然后 appendChild(el)。读屏器把「带内容的
       新节点插入」当作节点创建而非 live region 内容变化 → sr-only 文案白写。 */
    const { shell, sandbox } = harness();
    const sess = mkSess(sandbox, 'work-LIVE', false);
    sandbox.showHistoryLoading(sess);
    const ov = overlayOf(shell);
    assert.ok(ov, '覆盖层必须存在');
    // 入文档那一刻 innerHTML 还是空的 → 说明内容是 append 之后才填的
    assert.equal(ov._htmlAtAppend, '', 'appendChild 时 live region 必须是空的');
    assert.ok(ov._html.includes('chl-sr'), '随后必须再填入 sr-only 文案');

    // 失败卡同样：走 hideHistoryLoading 的 failed 路径也要先入文档
    const h = harness();
    const s2 = mkSess(h.sandbox, 'work-LIVE2', false);
    h.sandbox.showHistoryLoading(s2);
    h.sandbox.hideHistoryLoading(s2, { failed: true });
    const f = overlayOf(h.shell);
    assert.ok(f && f._classes.includes('chl-failed'), '失败卡必须存在');
    assert.equal(f._htmlAtAppend, '', '失败卡的 live region 同样必须先入文档');
});

test('位置修正后覆盖层铺满 shell，刻度带用实测滚动条宽度让位', () => {
    /* 2026-11-04「滚动条和刻度位置反了」修复：旧模型里 wrap 被并排的 rail 挤窄
        railW，覆盖层必须同量让位才不横跳；新模型里 wrap 占满 shell、rail 只是叠在
        wrap 右缘内侧的透明覆盖层，骨架与真实版心本是同一个容器，无需也不该让位
        （再让位反而会让骨架比内容窄）。故契约改为「inset: 0 铺满」。 */
    const rule = cssRuleBody('.chat-history-loading');
    assert.ok(rule, '覆盖层主规则缺失');
    assert.match(rule, /position:\s*absolute;\s*inset:\s*0;/, '覆盖层必须铺满整个 shell');
    assert.ok(!/var\(--rail-w/.test(rule), '新布局下覆盖层不得再让出 rail 宽度');
    // 刻度带宽度仍走同源变量，且右让位量必须来自实测滚动条宽度
    const rail = cssRuleBody('.history-rail');
    assert.match(rail, /width:\s*var\(--rail-w/, '刻度带宽度必须走同一个 --rail-w');
    assert.match(rail, /right:\s*var\(--scrollbar-w, 0px\)/, '刻度带右让位量必须走 --scrollbar-w');
    assert.match(CSS_SRC, /--rail-w:\s*26px/, '--rail-w 必须有定义');
    // JS 必须真的把实测宽度写进变量（写死 15px 会在 overlay 滚动条平台压住正文）
    assert.match(HISTORY_SRC, /shell\.style\.setProperty\('--scrollbar-w', px\)/,
        '--scrollbar-w 必须由 JS 实测 offsetWidth-clientWidth 写入');
    /* ResizeObserver 走 relayoutHistoryRailTicks，不经过 renderHistoryRail：
       图片/代码高亮让正文撑高、滚动条从无到有时，漏测会让 --scrollbar-w 停在 0px，
       刻度带随即压住新出现的滚动条。锁死「两条路径同口径」。 */
    const relayoutAt = HISTORY_SRC.indexOf('function relayoutHistoryRailTicks');
    assert.ok(relayoutAt > 0, 'relayoutHistoryRailTicks 必须存在');
    const relayoutHead = HISTORY_SRC.slice(relayoutAt, relayoutAt + 900);
    assert.ok(relayoutHead.indexOf('syncRailScrollbarWidth();') > 0
            && relayoutHead.indexOf('syncRailScrollbarWidth();') < relayoutHead.indexOf('var $ticks'),
        'relayout 路径也必须在读几何前重测滚动条宽度');
});

test('各断点 padding-top 一致，TOP_PAD 模型才恒成立', () => {
    /* 缺陷：窄屏把 .chl-inner 的 padding-top 改成 16px，而 JS 的 TOP_PAD(42)
       仍按 28+14 推算 → 窄屏实测首行只到 30px，白算 12px，多渲染一行。 */
    const base = cssRuleBody('.chl-inner');
    assert.match(base, /padding:\s*28px/, '基准 padding-top 必须是 28px');
    const m = CSS_SRC.match(/@media \(max-width: 768px\) \{ \.chl-inner \{ padding: ([^}]+)\} \}/);
    assert.ok(m, '窄屏 .chl-inner 规则缺失');
    const top = m[1].trim().split(/\s+/)[0];
    assert.equal(top, '28px', '窄屏 padding-top 必须仍是 28px（TOP_PAD 模型跨断点恒定）');
    // TOP_PAD 本身也再锁一次
    const padM = HISTORY_SRC.match(/var HISTORY_SKELETON_TOP_PAD_PX = (\d+)/);
    assert.equal(Number(padM[1]), 28 + 14, 'TOP_PAD 必须 = 桌面 padding-top 28 + 首行 margin-top 14');
});

test('骨架不得残留无用过渡与错误注释', () => {
    /* 死代码：.chat-history-loading 上的 transition: opacity 没有任何消费方
       （JS 全仓不设置该元素的 opacity，只有 animation 驱动入场淡入）。
       注释漂移：行高注释原写「6px gap」，真实 CSS 是 8px。 */
    const rule = cssRuleBody('.chat-history-loading');
    assert.ok(!/transition:\s*opacity/.test(rule), '无用 transition 必须删除（无消费方）');
    const gapComment = HISTORY_SRC.match(/\+ (\d+)px gap×/);
    assert.ok(gapComment, '行高注释丢失');
    const cssGap = (cssRuleBody('.chl-row').match(/gap:\s*(\d+)px/) || [])[1];
    assert.equal(gapComment[1], cssGap, '注释里的 gap 必须与 .chl-row 的实际 gap 一致');
});

test('12 个语言包的三个文案键齐全', () => {
    const dir = path.join(uiRoot, 'locales');
    const files = fs.readdirSync(dir).filter(x => x.endsWith('.json'));
    assert.equal(files.length, 12, '语言包数量与 AVAILABLE_LOCALES 一致');
    for (const f of files) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const k of ['msgLoading', 'msgRetry', 'msgFailed']) {
            assert.ok(j.history && typeof j.history[k] === 'string' && j.history[k].length > 0,
                f + ' 缺 history.' + k);
        }
    }
});

/* ===== 2026-11 白屏止血回归钉：初始 replay 必须有 timeout / abort / 世代归属 =====
   缺陷现场：裸 $.get 无 timeout，12s 骨架兜底只换 UI 态不作废回调；切会话、
   点重试后旧请求带着 8 万帧回来仍会重建整页，形成失败卡 + 迟到内容交错。
   2026-11 契约对齐：修复只落在前端唯一源 gourd-work/desktop/ui；根级
   gourd-ai-tauri/ui 是已删除的构建期拷贝残骸（CI checkout 后不存在），
   Java 侧 static/js/app-history.js 自 2026-10-25 起未同步这批 replay 修复
   （8 项标记实测全为 0），锁它必然假红，故只锁唯一源。 */
test('★ 初始 replay 止血：timeout + abort + 世代/会话归属 + fragment 捞回', () => {
    const repo = path.resolve(__dirname, '..', '..', '..');
    const files = [
        path.join('gourd-work', 'desktop', 'ui', 'js', 'app-history.js')
    ];
    for (const rel of files) {
        const src = fs.readFileSync(path.join(repo, rel), 'utf8');
        /* P1-1：HTTP 超时必须宽于 UI watchdog（12s）。同值会竞态出「失败卡 +
           legacy 内容 + 二次骨架」三态交错。 */
        assert.match(src, /timeout:\s*HISTORY_HTTP_TIMEOUT_MS/, rel + ' 初始 replay 必须有真实 HTTP 超时（宽于 watchdog）');
        assert.match(src, /var HISTORY_HTTP_TIMEOUT_MS = 60000;/, rel + ' HTTP 超时常量必须存在且宽于 12s watchdog');
        /* P0-2：回放期 watchdog 不得一次性放手（保护真空 = 白屏），
           必须重排宽限 + stall hook 强制收口。 */
        assert.match(src, /REPLAY_STALL_GRACE_MS/, rel + ' 回放卡死必须有宽限重排，不得保护真空');
        assert.match(src, /__replayStalled/, rel + ' stall hook 标记必须在');
        assert.match(src, /stalledTarget/, rel + ' 盲兜底必须 salvage renderTarget 半成品，不得裸释放');
        assert.match(src, /_historyLoadGeneration/, rel + ' 必须有加载世代号，切会话/重试后旧响应作废');
        assert.match(src, /textStatus === 'abort'/, rel + ' abort 不得再叠二次 legacy 请求');
        assert.match(src, /pendingXhr\.abort\(\)/, rel + ' 12s 降级必须同时断开在途请求');
        assert.match(src, /replayFragment/, rel + ' fragment 必须提升到闭包作用域供异常兜底捞回');
        assert.match(src, /legacyFragment/, rel + ' legacy 路径同款兜底不得丢失');
        assert.match(src, /rp\.code && Number\(rp\.code\) !== 200/, rel + ' 后端 code:200 + 空 events 静默失败必须显式识别');
        /* P1-2：legacy 请求不得是裸 $.get（无 timeout、无 abort 句柄）。 */
        assert.match(src, /legacyXhr = \$\.ajax\(/, rel + ' legacy 请求必须是 $.ajax 且可 abort');
        assert.match(src, /sess\._historyLoadXhr = legacyXhr;/, rel + ' legacy 句柄必须注册给 watchdog');
    }
});