/* ===== task-monitor-session-refresh.test.js =====
   任务监控「会话切换即时刷新」契约测试（2026-10 用户报障：切会话后右栏等 2-3s 才变）。

   根因回顾：面板刷新触发只有「打开时 / workspace:changed / 6s 轮询」，而
   workspace:changed 仅在工作区真变化时派发（app-workspace.js 的 sel!==current 门禁），
   同工作区内切会话不派发 → 面板只能等轮询 tick（0-6s 均匀分布、均值 3s）。

   断言取向（双层）：
   - 源码契约：切换通知挂在 setActiveSession 的 switching 分支（全部切换入口的唯一
     汇聚点）；面板暴露 window.refreshTaskMonitor 且带开合/欢迎页门禁；git 两接口
     在 root 未变时复用（它们只依赖 root、实测每次 ~1s）；loading 态四区覆盖且
     每个 render 都解除；轮询兜底保留。
   - vm 行为级：把 app-task-monitor.js 真跑进沙箱（stub DOM/fetch），断言
     ① 首开 5 请求；② 同 root 切会话只发 3 个会话级请求且环境区同步用缓存重绘；
      ③ root 变化时 git 两请求恢复；④ 面板关闭时 refresh 零请求；
      ⑤ 轮询 tick 数据未变：不闪 loading、同步行文案不翻转、innerHTML 零重写（闪烁修复）。
     行为断言与排序解耦：按 URL 集合断言，不依赖 fetch 调用顺序。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.resolve(__dirname, '../../main/resources/static');
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), 'utf8');

const baseJs = read('js', 'app-base.js');
const monJs = read('js', 'app-task-monitor.js');
const monCss = read('css', 'task-monitor.css');

// ---------- 源码契约：切换通知挂在唯一汇聚点 ----------
test('setActiveSession 的 switching 分支必须通知任务监控刷新', () => {
    const fn = baseJs.slice(baseJs.indexOf('function setActiveSession(sessionId)'),
        baseJs.indexOf('/* ===== 任务执行会话的运行参数提示条'));
    assert.match(fn, /var switching = \(sessionId !== activeSessionId\);/,
        'switching 判定必须存在（同会话重复激活不得触发无谓重拉）');
    assert.match(fn, /if \(switching && typeof window\.refreshTaskMonitor === 'function'\) window\.refreshTaskMonitor\(\);/,
        '切换分支必须调 window.refreshTaskMonitor（typeof 守卫对齐 updateMessageQueueUI 纪律）');
    // 通知必须在 switching 门禁内：无条件调用会让「发送消息/流式回跳」等同会话
    // 激活也重拉五端点（每轮对话白白多 5 个请求，git 两接口各 ~1s）
    assert.doesNotMatch(fn, /(?<!switching && )typeof window\.refreshTaskMonitor === 'function'\) window\.refreshTaskMonitor\(\);(?!\s*$)/m,
        'refreshTaskMonitor 调用不得脱离 switching 门禁');
});

test('面板暴露 refreshTaskMonitor：开合与欢迎页门禁 + 走 git 复用路径', () => {
    assert.match(monJs, /window\.refreshTaskMonitor = function \(\)/, '切换通知的接收面必须对外暴露');
    const entry = monJs.slice(monJs.indexOf('window.refreshTaskMonitor = function'));
    assert.match(entry, /if \(!isOpen\(\) \|\| isWelcomePage\(\)\) return;/,
        '面板关着/欢迎页时 no-op（openMonitor/syncWithView 会在进入时自拉）');
    assert.match(entry, /loadAll\(true\)/, '切换路径必须传 reuseGit=true（git 结果按 root 复用）');
});

test('loadAll：root 未变复用 git 缓存，root 变或轮询必重拉', () => {
    const fn = monJs.slice(monJs.indexOf('function loadAll(reuseGit)'), monJs.indexOf('var lastEnvStatus'));
    assert.match(fn, /var reuse = reuseGit === true && lastEnvRoot !== null && lastEnvRoot === root;/,
        '复用条件三要素：调用方声明 + 有过成功渲染 + root 相同（缺一即退化为全量重拉或错用缓存）');
    // loading 门禁（2026-10 闪烁修复）：只有「首开 / 会话、root 真切换」才闪——
    // 轮询与 workspace:changed 虽 reuse=false 但 root 未变，上 loading 会让整栏
    // 每 6s 呼吸一次（用户反馈：闪来闪去看着怪）
    assert.match(fn, /var envStale = lastEnvRoot === null \|\| lastEnvRoot !== root;/,
        'loading 门禁必须按「环境区是否 stale」（首开或 root 变化）判定');
    assert.match(fn, /if \(envStale\) showLoading\(\);/, '只有 stale 路径才允许上 loading');
    assert.doesNotMatch(fn, /if \(!reuse\) showLoading\(\);/,
        '轮询/workspace 变化（reuse=false 同 root）不得上 loading（闪烁根因1）');
    assert.match(fn, /renderEnv\(lastEnvStatus \? lastEnvStatus\.status : \{\}, lastRemoteData \|\| undefined, root\)/,
        '复用路径环境区同步用缓存重绘（含上次 remote），切换零等待');
    // git 两 fetch 必须在 else 分支内（reuse 时不得发）：以分支边界切片区断言
    const iReuse = fn.indexOf('if (reuse) {');
    const iElse = fn.indexOf('} else {', iReuse);
    const iSess = fn.indexOf("fetchJson('/web/chat/changes/session");
    assert.ok(iReuse > 0 && iElse > iReuse && iSess > iElse, 'loadAll 分支结构必须可定位');
    const reuseBranch = fn.slice(iReuse, iElse);
    assert.match(reuseBranch, /renderEnv\(lastEnvStatus/, 'reuse 分支只做缓存重绘');
    assert.doesNotMatch(reuseBranch, /fetchJson\('/, 'reuse 分支不得发任何请求（git 两接口在 else 内）');
    const elseBranch = fn.slice(iElse, iSess);
    assert.match(elseBranch, /fetchJson\('\/web\/chat\/git\/status/, '非复用路径 git/status 必发');
    assert.match(elseBranch, /fetchJson\('\/web\/chat\/git\/remote/, '非复用路径 git/remote 必发');
    assert.match(fn, /lastRemoteData = d \|\| \{\};/, 'remote 成功响应必须入缓存供复用');
    // 会话级三接口无条件发（它们才是会话维度的数据）
    for (const ep of ['/web/chat/changes/session', '/web/chat/attachment/list', '/web/chat/session/tool-usage']) {
        assert.match(fn, new RegExp("fetchJson\\('" + ep.replace(/[/.]/g, '\\$&')), ep + ' 必须每轮都发');
    }
});

test('remote 晚到守卫：root 已切走不得把旧环境区绘回新会话', () => {
    const fn = monJs.slice(monJs.indexOf('function renderRemoteInto(remote)'), monJs.indexOf('// ---------- 开合'));
    assert.match(fn, /if \(lastEnvStatus\.root !== lastEnvRoot\) return;/,
        '缺守卫时：切会话瞬间旧 root 的 remote 晚到 → 环境区被绘回旧 root（跨会话串台）');
});

test('loading 态：四区覆盖、每个 render 都解除、CSS 与 reduced-motion 齐备', () => {
    assert.match(monJs, /function showLoading\(\)/, 'showLoading 必须存在');
    const sl = monJs.slice(monJs.indexOf('function showLoading()'), monJs.indexOf('function clearLoading()'));
    for (const body of ['envBody', 'outputsBody', 'sourcesBody', 'skillsBody']) {
        assert.match(sl, new RegExp(body + '\\.innerHTML = loadingRow\\(\\)'), body + ' 必须上 loading');
    }
    // 每个 render 的成功/失败两路都要解除 loading：否则在飞标记残留、下次切换不闪 loading
    for (const fnName of ['renderEnv', 'renderOutputs', 'renderSources', 'renderSkills']) {
        const fn = monJs.slice(monJs.indexOf('function ' + fnName + '('), monJs.indexOf('function ', monJs.indexOf('function ' + fnName + '(') + 10));
        assert.match(fn, /clearLoading\(\)/, fnName + ' 必须解除 loading 态');
    }
    assert.match(monJs, /t\('common\.loading'\)/, 'loading 文案复用 common.loading（12 包已有，零新增键）');
    assert.match(monCss, /\.tm-loading \{/, 'loading 行样式必须存在');
    assert.match(monCss, /@media \(prefers-reduced-motion: reduce\) \{ \.tm-loading \{ animation: none; \} \}/,
        '呼吸动画必须尊重 reduced-motion');
    // 轮询兜底不得被事件驱动取代而删除（流式期间产出/技能仍在增长）
    assert.match(monJs, /POLL_MS = 6000/, '6s 轮询兜底保留');
});

test('common.loading 在 12 语言包齐全非空（复用键防误删）', () => {
    const dir = path.join(STATIC, 'locales');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    assert.strictEqual(files.length, 12, '语言包数量');
    for (const f of files) {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, ''));
        assert.ok(data.common && typeof data.common.loading === 'string' && data.common.loading.length > 0,
            f + ' 缺 common.loading（监控 loading 态文案依赖它）');
    }
});

// ---------- vm 行为级：真跑面板 IIFE，断言请求集合与缓存重绘 ----------
function makeEl(id) {
    // chatView 初始不带 active（=欢迎页）：IIFE 装载时 syncWithView 不得自开面板，
    // 否则测试还没开始就发了 5 个请求、计数全乱；各用例自行按需加 active。
    const classes = new Set();
    const el = {
        id: id,
        textContent: '',
        classList: {
            add: c => classes.add(c),
            remove: c => classes.delete(c),
            toggle: (c, force) => { if (force === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); } else if (force) classes.add(c); else classes.delete(c); return classes.has(c); },
            contains: c => classes.has(c)
        },
        setAttribute: () => {},
        getAttribute: () => null,
        addEventListener: () => {},
        querySelectorAll: () => [],
        querySelector: () => null,
        appendChild: () => {},
        _classes: classes,
        _htmlWrites: 0
    };
    // innerHTML 写计数：闪烁修复的契约是「值未变不碰 DOM」，字符串相等证明不了
    // 「没重写」——必须经 setter 旁路计数才可观测
    let html = '';
    Object.defineProperty(el, 'innerHTML', {
        get: function () { return html; },
        set: function (v) { html = String(v); el._htmlWrites++; }
    });
    return el;
}

function runMonitorSandbox(overrides) {
    const els = {};
    for (const id of ['taskMonitorDrawer', 'tmEnvBody', 'tmOutputsBody', 'tmSourcesBody', 'tmSkillsBody', 'tmMemoryRow', 'tmMemoryLabel', 'tmMemoryJumpBtn', 'chatView']) {
        els[id] = makeEl(id);
    }
    const bodyEl = makeEl('body');
    const documentStub = {
        getElementById: id => els[id] || null,
        addEventListener: () => {},
        body: bodyEl
    };
    const fetchCalls = [];
    const pollFns = [];
    const responses = {
        '/web/chat/git/status': { gitAvailable: true, initialized: true, branch: 'feat-cached', changed: 2, staged: 0, untracked: 0 },
        '/web/chat/git/remote': { gitAvailable: true, hasRemote: true, remoteUrl: 'git@x:r.git', upstream: 'origin/main', ahead: 0, behind: 0 },
        '/web/chat/changes/session': { files: [] },
        '/web/chat/attachment/list': { items: [] },
        '/web/chat/session/tool-usage': { skills: [], memory: { updated: false } }
    };
    // 用例可覆盖单个端点的响应（如自定义 skills 行），其余保持默认
    Object.assign(responses, overrides || {});
    const fetchStub = (url) => {
        const key = Object.keys(responses).find(k => url.indexOf(k) === 0);
        fetchCalls.push(url);
        if (!key) return Promise.reject(new Error('unexpected url ' + url));
        const data = responses[key];
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ code: 0, data: data }) });
    };
    const sandbox = {
        document: documentStub,
        window: null,
        localStorage: { getItem: () => null, setItem: () => {} },
        setInterval: (fn) => { pollFns.push(fn); return pollFns.length; },
        clearInterval: () => {},
        fetch: fetchStub,
        GourdI18n: { t: (k) => k },
        encodeSessionCwdHeader: (r) => 'enc:' + r,
        MutationObserver: function () { this.observe = () => {}; },
        SESSION_ID: 'work-s1',
        sessionMap: { 'work-s1': { projectRoot: 'D:/ws/a' }, 'work-s2': { projectRoot: 'D:/ws/a' }, 'work-s3': { projectRoot: 'D:/ws/b' } },
        console: console
    };
    sandbox.window = sandbox;   // 面板里 window.X = ... 与裸全局同源（浏览器 window 即全局）
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(monJs, sandbox, { filename: 'app-task-monitor.js' });
    return { sandbox, els, fetchCalls, bodyEl, pollFns };
}

const urlsOf = calls => calls.map(u => Object.keys({ '/web/chat/git/status': 1, '/web/chat/git/remote': 1, '/web/chat/changes/session': 1, '/web/chat/attachment/list': 1, '/web/chat/session/tool-usage': 1 }).find(k => u.indexOf(k) === 0));
const sorted = a => a.slice().sort();
const GIT_EPS = ['/web/chat/git/remote', '/web/chat/git/status'];
const SESS_EPS = ['/web/chat/attachment/list', '/web/chat/changes/session', '/web/chat/session/tool-usage'];

const flush = async () => { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); };

/* 进入会话视图 + 首开面板（真实流程：syncWithView/openMonitor），flush 后清空请求计数，
   供后续「切换」阶段断言增量请求集合。 */
async function openInSessionView(sandbox, els, bodyEl) {
    els.chatView._classes.add('active');        // 进入会话视图（门禁放行）
    sandbox.window.openTaskMonitor();
    await flush();
    assert.ok(bodyEl._classes.has('task-monitor-open'), '前置：面板已开');
}

test('行为：首开发五端点；同 root 切会话只发三会话级且环境区同步缓存重绘', async () => {
    const { sandbox, els, fetchCalls } = runMonitorSandbox();
    await openInSessionView(sandbox, els, sandbox.document.body);
    assert.deepStrictEqual(sorted(urlsOf(fetchCalls)), sorted(GIT_EPS.concat(SESS_EPS)), '首开五端点齐发');
    fetchCalls.length = 0;                      // 只看切换阶段的增量
    sandbox.SESSION_ID = 'work-s2';             // 同 root（D:/ws/a）的另一个会话
    sandbox.window.refreshTaskMonitor();        // setActiveSession switching 分支会调它
    await flush();
    assert.deepStrictEqual(sorted(urlsOf(fetchCalls)), sorted(SESS_EPS),
        '同 root 切换不得重发 git 两接口（实测每次 ~1s、9 个 git 子进程）');
    assert.ok(els.tmEnvBody.innerHTML.indexOf('feat-cached') >= 0,
        '环境区必须同步用缓存重绘（首开渲染的分支名仍在），切换零等待');
});

test('行为：root 变化时 git 两接口恢复重发（缓存不得跨 root 串台）', async () => {
    const { sandbox, els, fetchCalls } = runMonitorSandbox();
    await openInSessionView(sandbox, els, sandbox.document.body);
    fetchCalls.length = 0;
    sandbox.SESSION_ID = 'work-s3';             // 会话根 D:/ws/b ≠ 上次 D:/ws/a
    sandbox.window.refreshTaskMonitor();
    await flush();
    assert.deepStrictEqual(sorted(urlsOf(fetchCalls)), sorted(GIT_EPS.concat(SESS_EPS)),
        'root 变了仍复用 git 缓存 = 把 A 工作区的分支/同步态显示在 B 工作区会话上');
});

test('行为：面板关闭时 refresh 零请求（no-op 门禁）', async () => {
    const { sandbox, fetchCalls, bodyEl } = runMonitorSandbox();
    assert.ok(!bodyEl._classes.has('task-monitor-open'), '前置：面板未开');
    sandbox.window.refreshTaskMonitor();
    await flush();
    assert.strictEqual(fetchCalls.length, 0, '关着的面板不得偷发请求（openMonitor 进入时自拉）');
});

test('行为：首开（openMonitor）发五端点且 loading 先于响应出现', async () => {
    const { sandbox, els, fetchCalls } = runMonitorSandbox();
    // 延迟响应：让 loading 态可观察
    const origFetch = sandbox.fetch;
    sandbox.fetch = (url) => { const p = origFetch(url); return new Promise(res => setTimeout(() => res(p), 5)); };
    els.chatView._classes.add('active');
    sandbox.window.openTaskMonitor();
    assert.ok(els.tmOutputsBody.innerHTML.indexOf('common.loading') >= 0,
        '首开在飞期间产出区必须是 loading 态（旧内容/空态不得冒充在拉数据）');
    await new Promise(r => setTimeout(r, 20));
    assert.deepStrictEqual(sorted(urlsOf(fetchCalls)), sorted(GIT_EPS.concat(SESS_EPS)), '首开五端点齐发');
    assert.ok(els.tmOutputsBody.innerHTML.indexOf('common.loading') < 0, '响应到达后 loading 必须解除');
});

/* 闪烁修复行为级护栏（2026-10 用户反馈：「已同步」每几秒闪一次）。
   轮询 tick = loadAll() 无参（reuse=false）：同 root 下不得闪 loading、
   在飞期间同步行不得翻成 no_remote、数据未变时四区 innerHTML 零重写。 */
test('行为：轮询 tick 数据未变——不闪 loading、同步行不翻转、innerHTML 零重写', async () => {
    const { sandbox, els, fetchCalls, bodyEl, pollFns } = runMonitorSandbox();
    await openInSessionView(sandbox, els, bodyEl);
    assert.strictEqual(pollFns.length, 1, '前置：openMonitor 注册了轮询');
    assert.ok(els.tmEnvBody.innerHTML.indexOf('monitor.synced') >= 0, '前置：同步行已渲染为已同步');
    const beforeEnv = els.tmEnvBody.innerHTML;
    const writesBefore = els.tmEnvBody._htmlWrites + els.tmOutputsBody._htmlWrites +
        els.tmSourcesBody._htmlWrites + els.tmSkillsBody._htmlWrites;
    fetchCalls.length = 0;
    pollFns[0]();                                    // 模拟一次 6s 轮询 tick
    assert.ok(els.tmEnvBody.innerHTML.indexOf('common.loading') < 0,
        '轮询不得闪 loading（整栏呼吸动画是用户所指闪烁的一半根因）');
    assert.ok(els.tmEnvBody.innerHTML.indexOf('monitor.synced') >= 0,
        '轮询在飞期间同步行不得翻成 no_remote（git/status 先回包不得丢 remote 缓存）');
    await flush();
    assert.strictEqual(els.tmEnvBody.innerHTML, beforeEnv, '轮询后环境区文案必须逐字不变');
    const writes = (els.tmEnvBody._htmlWrites + els.tmOutputsBody._htmlWrites +
        els.tmSourcesBody._htmlWrites + els.tmSkillsBody._htmlWrites) - writesBefore;
    assert.strictEqual(writes, 0,
        '数据未变时轮询不得重写任何 innerHTML（setBodyHtml 同值跳过是闪烁根因2的修复）');
    assert.strictEqual(fetchCalls.length, 5, '轮询仍发五端点（新鲜度不让步，只去掉视觉闪）');
});

test('行为：跨 root 切换仍先上 loading（旧工作区内容不得冒充新会话）', async () => {
    const { sandbox, els, bodyEl } = runMonitorSandbox();
    await openInSessionView(sandbox, els, bodyEl);
    sandbox.SESSION_ID = 'work-s3';                  // root D:/ws/b ≠ 上次 D:/ws/a
    sandbox.window.refreshTaskMonitor();
    assert.ok(els.tmEnvBody.innerHTML.indexOf('common.loading') >= 0,
        'root 变化必须同步上 loading：旧工作区的分支/同步态不得冒充新会话');
    await flush();
    assert.ok(els.tmEnvBody.innerHTML.indexOf('common.loading') < 0, '响应到达后 loading 解除');
    /* 产出/技能区在跨 root 切换前后 html 可能逐字相同（两会话都空态）：
       showLoading 若不清 __tmHtml 缓存标记，同值跳过会把 loading 行永久卡住
       （变异 M3 的杀手场景，2026-10 自审补强） */
    assert.ok(els.tmOutputsBody.innerHTML.indexOf('common.loading') < 0,
        '产出区 loading 必须解除：html 与切换前同值时同值跳过不得吞掉 loading 行的清除');
    assert.ok(els.tmSkillsBody.innerHTML.indexOf('common.loading') < 0,
        '技能区 loading 必须解除（同上，空态跨 root 同值场景）');
});

/* 同值跳过缓存的镜像纪律（2026-10 自审 P1）：__tmHtml 是 DOM 的镜像，任何绕过
   setBodyHtml 的 raw 写都会让缓存与 DOM 失步。失步的真实后果：git 两接口瞬断
   （错误行 raw 写、缓存仍停旧正常值）→ 恢复轮询的新 html 与错误前同值 → 同值
   跳过命中 → 「加载失败」行永久卡住，直到 root 变化或重开面板。 */
test('源码契约：四区 innerHTML 直写仅限 showLoading 四行（其余必须走 setBodyHtml）', () => {
    const writes = monJs.match(/[A-Za-z]+Body\.innerHTML\s*=/g) || [];
    assert.strictEqual(writes.length, 4,
        '四区直写 innerHTML 必须只有 showLoading 内四行（它同步清缓存标记），实际=' + writes.join(','));
    const sl = monJs.slice(monJs.indexOf('function showLoading()'), monJs.indexOf('function clearLoading()'));
    for (const w of writes) assert.ok(sl.indexOf(w) >= 0, w + ' 必须位于 showLoading 内');
});

test('行为：git 两接口瞬断后轮询恢复，错误行必须被清除（缓存不得吞掉恢复渲染）', async () => {
    const { sandbox, els, bodyEl, pollFns } = runMonitorSandbox();
    await openInSessionView(sandbox, els, bodyEl);
    assert.ok(els.tmEnvBody.innerHTML.indexOf('monitor.synced') >= 0, '前置：环境区正常渲染');
    const origFetch = sandbox.fetch;
    // git 两接口同时瞬断（status 单独断会被 remote 晚到的补绘掩盖，测不出失步）
    sandbox.fetch = (url) => (url.indexOf('/web/chat/git/status') === 0 || url.indexOf('/web/chat/git/remote') === 0)
        ? Promise.reject(new Error('transient')) : origFetch(url);
    pollFns[0]();
    await flush();
    assert.ok(els.tmEnvBody.innerHTML.indexOf('monitor.load_failed') >= 0,
        '瞬断必须如实显示错误行（不得拿旧内容冒充在拉数据）');
    sandbox.fetch = origFetch;
    pollFns[0]();
    await flush();
    assert.ok(els.tmEnvBody.innerHTML.indexOf('monitor.load_failed') < 0,
        '恢复轮询必须清除错误行：同值跳过不得因缓存-DOM 失步吞掉这次恢复渲染');
    assert.ok(els.tmEnvBody.innerHTML.indexOf('monitor.synced') >= 0, '恢复后环境区回到同步态');
});

/* ===== 技能区展示名（2026-10 用户报障：技能页与任务监控两处名字不一样）=====
   根因：技能行的 name 是 skillread 的参数值 = 安装目录名（namespace 限定 slug 会
   落成 _user_xxx_yyy）。技能页已改成显示 displayName，监控这边仍直接渲染 name。
   本组用例走 vm 行为级：把 displayName 真送进 renderSkills，断言最终写进 DOM
   的 html 是展示名，且目录名不丢（收进 title）。 */
test('行为：技能行渲染展示名，目录名收进 title（不丢）', async () => {
    const { sandbox, els, bodyEl } = runMonitorSandbox({
        '/web/chat/session/tool-usage': {
            skills: [{ name: '_user_3b5e1511_lawyer-letter5399', displayName: '示例展示名.Skill', toolName: 'skillread', count: 2 }],
            memory: { updated: false }
        }
    });
    await openInSessionView(sandbox, els, bodyEl);
    const html = els.tmSkillsBody.innerHTML;
    assert.ok(html.indexOf('示例展示名.Skill') >= 0,
        '监控必须显示展示名（与技能页同一个名字），实际: ' + html);
    /* 只验【正文】：目录名本来就该出现在 title 属性里（那是刻意保留的），
       对整段 html 断言「不含目录名」会把正确实现判成缺陷 */
    const textOnly = html.replace(/<[^>]*>/g, '');
    assert.ok(textOnly.indexOf('_user_3b5e1511_lawyer-letter5399') < 0,
        '目录名不得出现在正文（用户看不懂的那个名字），实际正文: ' + textOnly);
    assert.ok(html.indexOf('title="_user_3b5e1511_lawyer-letter5399"') >= 0,
        '目录名必须收进 title：悬停仍可看到真实标识（排查时可对照账本）');
    assert.ok(textOnly.indexOf('×2') >= 0, '调用次数照旧渲染');
});

test('行为：无 displayName 时回退 name（旧后端/已卸载技能不得渲染成空行）', async () => {
    const { sandbox, els, bodyEl } = runMonitorSandbox({
        '/web/chat/session/tool-usage': {
            skills: [{ name: '_owner_gone-skill', toolName: 'skillread', count: 1 }],
            memory: { updated: false }
        }
    });
    await openInSessionView(sandbox, els, bodyEl);
    const html = els.tmSkillsBody.innerHTML;
    assert.ok(html.indexOf('_owner_gone-skill') >= 0,
        '无展示名必须回退 name（技能已卸载时算不出展示名），实际: ' + html);
    assert.ok(html.indexOf('undefined') < 0, '不得渲染出 undefined，实际: ' + html);
});

test('行为：无参技能（skilllist/skillrefresh）用 toolName 兜底，不得渲染空行', async () => {
    const { sandbox, els, bodyEl } = runMonitorSandbox({
        '/web/chat/session/tool-usage': {
            skills: [{ toolName: 'skilllist', count: 1 }],
            memory: { updated: false }
        }
    });
    await openInSessionView(sandbox, els, bodyEl);
    assert.ok(els.tmSkillsBody.innerHTML.indexOf('skilllist') >= 0,
        '既无 displayName 又无 name 时必须回退 toolName，实际: ' + els.tmSkillsBody.innerHTML);
});
