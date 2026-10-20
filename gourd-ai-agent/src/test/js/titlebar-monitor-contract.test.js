/* ===== titlebar-monitor-contract.test.js =====
   标题栏动作组（终端/任务监控按钮）+ 任务监控抽屉 + 终端全局化 的契约测试。

   断言取向：验行为与结构契约，不锁属性顺序/文案措辞——
   - 终端全局化：面板 markup 必须在 index.html（body 级）且不在 code.html；
     CSS 显隐必须由 body.terminal-open 驱动（不得再被 code-mode 门控，否则
     chat 模式点标题栏按钮无面板）；fixed 底栏 + 窄屏隐藏。
   - 标题栏按钮：body 级 fixed 容器（不得塞进 .titlebar-drag-region——该条在
     skills/浏览器 code 模式隐藏，按钮会消失）；右偏移按平台分流。
   - 监控抽屉：五区 + 记忆行 + 五端点 + 版本防覆盖 + Esc 关闭（灯箱 Esc 层级见下）。
   - i18n：12 语言包 monitor.* 23 键齐全非空。
   - 镜像同步：新增/修改文件与 gourd-ai-tauri/ui 逐字节一致（镜像存在才比对）。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATIC = path.resolve(__dirname, '../../main/resources/static');
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), 'utf8');

const indexHtml = read('index.html');
const codeHtml = read('code.html');
const codeCss = read('css', 'code.css');
const monitorCss = read('css', 'task-monitor.css');
const themeCss = read('css', 'theme.css');
const termJs = read('js', 'app-terminal.js');
const barJs = read('js', 'app-titlebar-actions.js');
const monJs = read('js', 'app-task-monitor.js');
const bootJs = read('js', 'app-bootstrap.js');
const baseJs = read('js', 'app-base.js');
const codeJs = read('js', 'app-code.js');
const histJs = read('js', 'app-history.js');
const gateJava = fs.readFileSync(path.resolve(__dirname, '../../main/java/com/gourdai/core/portal/web/TerminalGate.java'), 'utf8');
const msgJs = read('js', 'app-message.js');

// ---------- 终端全局化 ----------
test('终端面板 markup 在 index.html 的 body 级，且已从 code.html 移除', () => {
    for (const id of ['codeTerminalPane', 'codeTerminalTabs', 'codeTerminalNewBtn', 'codeTerminalResizeHandle']) {
        assert.ok(indexHtml.includes('id="' + id + '"'), 'index.html 必须承载 #' + id);
        assert.ok(!codeHtml.includes('id="' + id + '"'), 'code.html 不得再承载 #' + id + '（双份 id 会让 getElementById 取到先注入者）');
    }
    // 单实例时代的静态输出/输入节点已废弃：多实例下每 tab 自带 bufEl/inEl，
    // 静态再留一份会让 getElementById 拿到无主节点（写进去的输出永远不可见）
    assert.ok(!indexHtml.includes('id="codeTerminalOutput"') && !indexHtml.includes('id="codeTerminalInput"'),
        '静态 #codeTerminalOutput/#codeTerminalInput 不得回归（多实例下输出/输入是 per-tab 动态节点）');
    // 面板在 body 级 = 位于 .main-area 容器之外（index.html 中 main-area 的 div 已闭合之后）
    const mainAreaClose = indexHtml.indexOf('</div>', indexHtml.indexOf('<div class="main-area">'));
    assert.ok(indexHtml.indexOf('id="codeTerminalPane"') > mainAreaClose,
        '终端面板必须挂在 .main-area 之外（body 级），否则仍受视图 flex 布局挤压');
});

test('终端显隐由 body.terminal-open 驱动，不再被 code-mode 门控', () => {
    assert.match(codeCss, /body\.terminal-open \.code-terminal-pane \{ display: flex; \}/);
    assert.doesNotMatch(codeCss, /body\.code-mode\.terminal-open \.code-terminal-pane/,
        'code-mode 门控会让 chat 模式打开终端时面板不出现（本次全局化的核心回归点）');
    assert.match(codeCss, /\.code-terminal-pane \{[\s\S]{0,240}?position: fixed;/,
        '面板必须 fixed 钉底：流内挂载需要每个视图各注入一份容器');
    assert.match(codeCss, /@media \(max-width: 900px\) \{[\s\S]{0,200}?\.code-terminal-pane,[\s\S]{0,80}?display: none !important;/,
        '窄屏必须隐藏全局终端（底部空间不足）');
});

test('终端 cwd 归属：会话根优先 → 工作区选择器 → 空（全局区）', () => {
    const wsUrl = termJs.slice(termJs.indexOf('function wsUrl('), termJs.indexOf('// ---------- 输出渲染'));
    assert.match(wsUrl, /cwd \|\| ''/, 'wsUrl 的根来自 tab 快照（tab.cwd），非实时视图状态');
    const termCwd = termJs.slice(termJs.indexOf('function termCwd('), termJs.indexOf('function wsUrl('));
    assert.match(termCwd, /currentProjectRoot/, 'code 模式项目根优先');
    // 【用户报障回归护栏】getSessionCwd 只读工作区选择器（currentChatWorkspace），
    // 会话自带的根（sessionMap[sid].projectRoot）优先于它：否则切到带根的会话后
    // 新 tab 落默认工作区、tab 名退化为语言包键。
    assert.match(termCwd, /sessionMap\[sid\][\s\S]{0,120}?projectRoot/,
        'chat 模式必须先取当前会话根（与 app-todos/app-task-monitor 同口径）');
    assert.ok(termCwd.indexOf('sessionMap[sid]') < termCwd.indexOf('getSessionCwd'),
        '会话根必须在 getSessionCwd 之前取（选择器只是兑底）');
    // tab 名回落键必须是真实存在的键：terminal.title 在 12 包都不存在，
    // 写错会让 tab 名直接显示裸键（用户实测报障）。
    const baseName = termJs.slice(termJs.indexOf('function baseNameOf('), termJs.indexOf('function buildInput('));
    assert.match(baseName, /GourdI18n\.t\('code\.terminal\.title'\)/, '无 cwd 回落键必须是 code.terminal.title');
    assert.doesNotMatch(baseName, /t\('terminal\.title'\)/, 'terminal.title 不存在于任何语言包，禁止使用');
});

test('终端快捷键与启动恢复不再限 code 模式', () => {
    const kd = termJs.slice(termJs.indexOf("addEventListener('keydown'"), termJs.indexOf('// ---------- 拖拽调高'));
    assert.doesNotMatch(kd, /classList\.contains\('code-mode'\)/,
        'Ctrl+` 若仍门控 code-mode，chat 模式快捷键失效（与标题栏按钮行为不一致）');
    const boot = termJs.slice(termJs.indexOf('恢复上次开关态'));
    assert.doesNotMatch(boot.slice(0, 400), /classList\.contains\('code-mode'\)/,
        '启动恢复若门控 code-mode，chat 用户上次开着的终端重启后消失');
});

// ---------- 终端多实例 ----------
test('多实例：tab 在创建时快照 cwd/scope，切项目/切会话不劫持已有 shell', () => {
    const createTab = termJs.slice(termJs.indexOf('function createTab('), termJs.indexOf('function socketLive('));
    assert.match(createTab, /cwd: termCwd\(\)/, 'cwd 必须是创建时快照（一个 shell 一个工作目录）');
    assert.match(createTab, /scopeKey: termScopeKey\(\)/, 'scope 同样创建时固定');
    const projHook = termJs.slice(termJs.indexOf('window.onCodeProjectChanged'));
    assert.doesNotMatch(projHook.slice(0, 300), /connectTab|killSocket/,
        '切项目不得重建/劫持已有 tab：正在跑的构建会被静默换目录（要新 cwd 请新建 tab）');
    assert.doesNotMatch(termJs, /addEventListener\('workspace:changed'/,
        'chat 切会话同样不得劫持：tab 归属固定，劫持会让长任务输出接进另一个目录的 shell');
});

test('多实例：输出/输入是 per-tab 缓冲，切换不丢、后台帧不串面板', () => {
    const append = termJs.slice(termJs.indexOf('function appendOutputTo('), termJs.indexOf('function appendSystemTo('));
    assert.match(append, /tab\.bufEl\.insertAdjacentHTML/, '输出必须写进 tab 自己的缓冲子树');
    assert.match(append, /tab === activeTab/, '非激活 tab 不得碰面板滚动/挂载（切回挂回即见）');
    const mount = termJs.slice(termJs.indexOf('function mountTabBody('), termJs.indexOf('function renderTabs('));
    assert.match(mount, /appendChild\(tab\.bufEl\)[\s\S]{0,80}?appendChild\(tab\.inEl\)/,
        '激活 = 把该 tab 的 buf+input 挂回 body（detach 保留，不重建不丢输出）');
    // 【用户报障回归护栏】滚动位置 per-tab：共享 body 不存就会把 A 的位置带给 B。
    assert.match(mount, /activeTab\.scrollTop = body\.scrollTop/, '切走前必须存当前滚动位');
    assert.match(mount, /body\.scrollTop = [\s\S]{0,60}?tab\.scrollTop/, '切回必须恢复该 tab 的滚动位');
    const msg = termJs.slice(termJs.indexOf('socket.onmessage'), termJs.indexOf('socket.onclose'));
    assert.match(msg, /if \(tab\.socket !== socket\) return;/, '被回收/顶替的旧 socket 残帧不得写入');
    assert.doesNotMatch(termJs, /getElementById\('codeTerminalOutput'\)|getElementById\('codeTerminalInput'\)/,
        'JS 不得再取单实例静态节点（多实例下它们不存在）');
    // 【用户报障回归护栏】缓冲必须 inline：块级会把输入框挤到下一行（「命令行换行」）。
    assert.match(codeCss, /\.code-terminal-tabbuf\s*\{[^}]*display:\s*inline;/,
        '输出缓冲必须 display:inline，与输入框行内相接');
});

test('多实例：连接池上限只回收后台 tab 的连接，tab 与输出保留', () => {
    const pool = termJs.slice(termJs.indexOf('function enforcePoolLimit('), termJs.indexOf('function mountTabBody('));
    assert.match(pool, /tb === protectTab \|\| tb === activeTab/, '眼前 tab 与正在重连者不得被回收');
    assert.match(pool, /lastUsedAt < victim\.lastUsedAt/, 'LRU：回收最久未用者');
    assert.match(pool, /killSocket\(victim\)/, '回收只断连接');
    assert.doesNotMatch(pool, /tabs\.splice/, '回收不得删 tab（输出与身份保留，切回懒重连）');
    assert.match(termJs, /TERM_POOL_MAX = 4/, '上限语义保留（每条连接=一个常驻 shell 子进程）');
    assert.match(termJs, /TERM_MAX_TABS = 8/, 'tab 数需封顶（防误连点产出几十个空壳标签）');
});

test('多实例：关 tab 需确认运行中 shell；关最后一个 tab = 关面板且不悬空', () => {
    const req = termJs.slice(termJs.indexOf('function requestCloseTab('), termJs.indexOf('function closeTab('));
    // 2026-10-14 语义升级：判据从「连接存活」改为「后端 busyQuery 命中存活后代进程」
    // （常驻 cmd 永远活着，旧判据把空闲终端误报成仍在运行）；确认走应用内 layConfirm。
    assert.match(req, /queryBusy\(tab/, '忙闲必须问后端（连接存活≠在跑）');
    assert.match(req, /if \(!busy\) \{ closeTab\(tab\); return; \}/, '空闲 shell 静默关闭（用户报障回归点）');
    assert.match(req, /layConfirm/, '忙时确认必须应用内弹窗（禁原生 confirm）');
    const close = termJs.slice(termJs.indexOf('function closeTab('), termJs.indexOf('// ---------- 打开 / 关闭'));
    assert.match(close, /killSocket\(tab\)/, '关 tab 先断其 shell');
    assert.match(close, /activeTab = null;/, '关最后一个 tab 必须清空 activeTab（防重开面板复活已关闭 tab）');
    assert.match(close, /closeTerminal\(\);/, '最后一个 tab 关闭 = 面板关闭');
    assert.match(close, /activateTab\(tabs\[Math\.min\(idx, tabs\.length - 1\)\]\)/, '关中间 tab 激活邻居');
    // 两条关闭路径语义不得合并：面板隐藏保留 tab（重开回现场），
    // tab × 销毁 tab（重开全新 shell）。合并会让「关面板」误杀所有 shell，
    // 或让「关最后一个 tab」后重开复活已销毁的输出。
    const hide = termJs.slice(termJs.indexOf('function closeTerminal('), termJs.indexOf('function toggleTerminal('));
    assert.doesNotMatch(hide, /tabs\.splice|tabs\.length = 0|tabs = \[\]/,
        'closeTerminal（面板隐藏）不得销毁 tab：只断连接，缓冲与身份保留');
    assert.match(hide, /killSocket\(tabs\[i\]\)/, '面板隐藏仍须断全部子进程（防后台 shell 泄漏）');
});

test('多实例标签栏 markup 与样式：chips 容器 + 新建钮，旧单实例标题移除', () => {
    assert.match(indexHtml, /<div class="code-terminal-tabs" id="codeTerminalTabs"><\/div>/, '标签容器静态留空，由 renderTabs 填充');
    assert.match(indexHtml, /id="codeTerminalNewBtn" data-i18n-title="terminal\.new_tab"/, '新建钮带 i18n title');
    const actions = indexHtml.slice(indexHtml.indexOf('id="codeTerminalTabs"'), indexHtml.indexOf('code-terminal-body'));
    const iNew = actions.indexOf('codeTerminalNewBtn');
    const iClear = actions.indexOf('codeTerminalClearBtn');
    const iRestart = actions.indexOf('codeTerminalRestartBtn');
    const iClose = actions.indexOf('codeTerminalCloseBtn');
    assert.ok(iNew >= 0 && iNew < iClear && iClear < iRestart && iRestart < iClose,
        '动作钮顺序：新建 → 清屏 → 重启 → 关面板（对齐参照稿）');
    assert.match(codeCss, /\.code-terminal-tabs \{[\s\S]{0,200}?overflow-x: auto;/, 'tab 多了横滚不挤压');
    assert.match(codeCss, /\.code-terminal-tab\.active \{/, '激活态可视');
    assert.doesNotMatch(codeCss, /\.code-terminal-title/, '旧单实例标题样式移除');
    assert.doesNotMatch(codeCss, /\.code-terminal-output/, '旧单实例输出 span 样式移除');
    assert.match(codeCss, /\.code-terminal-tabbuf \{/, 'per-tab 缓冲子树样式');
});

test('多实例 i18n：12 语言包 terminal 新 5 键齐全，占位符一致', () => {
    const dir = path.join(STATIC, 'locales');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    assert.strictEqual(files.length, 12, '语言包数量');
    const NEW_KEYS = ['new_tab', 'tab_close_confirm', 'tab_limit', 'tab_conn_recycled', 'scope_adopted'];
    const zh = JSON.parse(fs.readFileSync(path.join(dir, 'zh-CN.json'), 'utf8').replace(/^\uFEFF/, '')).terminal;
    for (const f of files) {
        const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, '')).terminal;
        for (const k of NEW_KEYS) {
            assert.ok(typeof t[k] === 'string' && t[k].length > 0, f + ' 缺 terminal.' + k);
        }
        const nZh = (zh.tab_limit.match(/\{\d\}/g) || []).length;
        const nLoc = (t.tab_limit.match(/\{\d\}/g) || []).length;
        assert.strictEqual(nLoc, nZh, f + ' tab_limit 占位符数量不一致');
    }
});

// ---------- 标题栏动作组 ----------
test('标题栏按钮在 body 级 fixed 容器，未塞进 .titlebar-drag-region', () => {
    assert.match(indexHtml, /<div class="titlebar-actions" id="titlebarActions">/);
    assert.ok(indexHtml.indexOf('id="titlebarActions"') > indexHtml.indexOf('</div>', indexHtml.indexOf('<div class="main-area">')),
        '动作组必须 body 级：.titlebar-drag-region 在 skills/浏览器 code 模式隐藏，塞进去按钮会消失');
    assert.match(indexHtml, /<div class="titlebar-drag-region"><\/div>/,
        '拖拽条必须保持空容器：按钮塞进去会在 skills/浏览器 code 模式随条隐藏而消失');
    assert.match(monitorCss, /\.titlebar-actions \{[\s\S]{0,160}?position: fixed;/);
    assert.match(monitorCss, /-webkit-app-region: drag;/, '容器保持可拖');
    assert.match(monitorCss, /\.titlebar-action-btn \{[\s\S]{0,120}?-webkit-app-region: no-drag;/,
        '按钮必须 no-drag（通用元素白名单口径：preload/ipc_bridge 只认 button 等元素选择器）');
});

test('右偏移按平台分流：Tauri 消费注入控件条总宽，Electron 退 138，mac/浏览器不让位', () => {
    assert.match(barJs, /__GOURD_TITLEBAR_STRIP_W__/, 'Tauri 壳：左组偏移必须消费注入脚本暴露的控件条总宽（单一真源，防两处硬编码漂移）');
    assert.match(barJs, /138/, 'Electron 原生 overlay 无暴露变量：退 3×46=138 兜底');
    assert.match(barJs, /is-mac/, 'mac 红绿灯在左上，右侧不让位');
    assert.match(barJs, /setProperty\('--titlebar-actions-right'/, '偏移写入 CSS 变量而非硬编码 style.right');
    assert.match(barJs, /MutationObserver/, '按钮高亮态必须观察 body 类（面板可被多条路径关闭）');
    assert.match(barJs, /attributeFilter: \['class'\]/);
});

// ---------- 窗口按钮与左组同款 chip（跨模块一致性护栏）----------
/* 用户反馈「缩放/关闭钮与左侧两钮阴影大小不一致」后的固化护栏：
   Tauri 自绘窗控（titlebar_ui.rs 注入脚本）与 .titlebar-action-btn 必须逐项同规格。
   数字从 Rust 常量解析而非写死，改尺寸时本护栏随真实源码走。 */
const tbRs = fs.readFileSync(path.resolve(__dirname, '../../../../gourd-ai-tauri/src-tauri/src/titlebar_ui.rs'), 'utf8');

/* 【注入脚本的可执行性护栏】
   TITLEBAR_JS 是写在 Rust 原始字符串（r#"…"#）里的 JS：它不是 Rust 代码，
   cargo check 完全看不到里面的语法错误；而现有的图标断言全是文本正则，如果脚本
   语法被改坏（引号不成对、括号不匹配、误引入 "#），测试依旧全绿、安装包一启动就白屏。
   因此这里真抽出来做三件事：① vm.Script 编译；② 占位符全部被替换且无残留；③ 沙箱里真执行一遍。 */
const TITLEBAR_JS_SRC = (() => {
    const marker = 'const TITLEBAR_JS: &str = r#"';
    const start = tbRs.indexOf(marker);
    assert.ok(start >= 0, 'titlebar_ui.rs 必须保留 const TITLEBAR_JS 的 r#" 原始字符串声明');
    const bodyStart = start + marker.length;
    const end = tbRs.indexOf('"#;', bodyStart);
    assert.ok(end > bodyStart, 'TITLEBAR_JS 原始字符串必须正常闭合（缺 "#; 会吞掉后续全部 Rust 代码）');
    return tbRs.slice(bodyStart, end);
})();

// 与 Rust 侧 init_script() 的 replace 口径逐项对应
const TB_SUBST = {
    __GOURD_PLATFORM__: 'win32', __TB_HEIGHT__: '36', __BTN_WIDTH__: '30',
    __BTN_HEIGHT__: '26', __BTN_GAP__: '2', __PAD_X__: '4', __MAC_INSET__: '80',
};
const renderTitlebarJs = () => Object.entries(TB_SUBST)
    .reduce((s, [k, v]) => s.split(k).join(v), TITLEBAR_JS_SRC);

test('TITLEBAR_JS 注入脚本必须语法可编译且无占位符残留', () => {
    const vm = require('vm');
    const js = renderTitlebarJs();
    assert.doesNotThrow(() => new vm.Script(js, { filename: 'TITLEBAR_JS.js' }),
        'TITLEBAR_JS 必须能被 JS 引擎编译（原始字符串里的语法错误 cargo check 发现不了）');

    // 替换目标清单必须与 Rust 侧一一对应：Rust 改了名字而这里没跟就会残留
    const declared = [...tbRs.matchAll(/\.replace\("([^"]+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(Object.keys(TB_SUBST).sort(), declared.sort(),
        'TB_SUBST 必须与 Rust init_script() 的 replace 目标完全一致');

    /* 残留判定只看「赋值/引用位置上的 __大写__」，不误伤 window.__GOURD_TITLEBAR__ 这类合法标识符：
       合法标识符总以点号前缀出现（window.__X__），而占位符出现在值位置（= __X__ / ' __X__'）。 */
    const residue = [...js.matchAll(/(^|[^.\w$])(__[A-Z][A-Z0-9_]*__)/g)].map((m) => m[2]);
    assert.deepStrictEqual([...new Set(residue)], [],
        'TITLEBAR_JS 不得残留未替换占位符（残留会让注入脚本直接 ReferenceError）');
});

test('TITLEBAR_JS 能在沙箱里真执行并挂出预期全局（防改坏运行时逻辑）', () => {
    const vm = require('vm');
    const listeners = {};
    const appended = [];
    const fakeEl = (tag) => ({
        tagName: tag, id: '', className: '', type: '', title: '', textContent: '', innerHTML: '',
        style: { setProperty() {} },
        setAttribute(k, v) { this[k] = v; },
        appendChild(c) { appended.push(c); if (c.id) this[c.id] = c; return c; },
        addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    });
    const body = fakeEl('body');
    body.classList = { add() {}, toggle() {}, contains() { return false; } };
    const sandbox = {
        window: { __TAURI_INTERNALS__: { invoke: () => Promise.resolve() }, addEventListener() {} },
        document: {
            readyState: 'complete',
            documentElement: fakeEl('html'),
            head: fakeEl('head'),
            body,
            createElement: fakeEl,
            getElementById: () => null,
            addEventListener(t, f) { listeners[t] = f; },
        },
        navigator: { language: 'zh-CN' },
        console: { warn() {}, log() {}, error() {} },
        setTimeout, clearTimeout,
    };
    sandbox.window.document = sandbox.document;
    sandbox.window.navigator = sandbox.navigator;
    sandbox.globalThis = sandbox;

    assert.doesNotThrow(() => vm.runInNewContext(renderTitlebarJs(), vm.createContext(sandbox), { timeout: 5000 }),
        'TITLEBAR_JS 必须在最小 DOM 沙箱里零异常跑完（报错则整个标题栏控件层不渲染）');
    assert.strictEqual(typeof sandbox.window.__GOURD_TITLEBAR__, 'object',
        '执行后必须导出 window.__GOURD_TITLEBAR__（Rust 侧状态同步靠它）');
    assert.strictEqual(typeof sandbox.window.__GOURD_TITLEBAR__.apply, 'function',
        '__GOURD_TITLEBAR__ 必须带 apply（最大化/失焦状态经此下发）');
    assert.strictEqual(typeof sandbox.window.__GOURD_TITLEBAR_SCRIM__, 'function',
        '执行后必须导出 __GOURD_TITLEBAR_SCRIM__（遮罩压暗联动）');
    assert.strictEqual(sandbox.window.__GOURD_TITLEBAR_STRIP_W__, 102,
        'STRIP_W 必须由 3×30+2×2+2×4 推导为 102（前端左组偏移靠它）');
});

test('Tauri 自绘窗口按钮与左组同款 chip：30x26 / 圆角6 / hover 走 --bg-hover', () => {
    assert.match(tbRs, /const BUTTON_WIDTH: u32 = 30;/, '按钮宽与 .titlebar-action-btn 同 30px');
    assert.match(tbRs, /const BUTTON_HEIGHT: u32 = 26;/, '按钮高与 .titlebar-action-btn 同 26px');
    assert.match(tbRs, /border-radius:6px;/, '圆角与左组同 6px');
    assert.match(tbRs, /__gourd_tb_btn:hover\{background:var\(--bg-hover/, 'hover 底色与左组同源主题令牌');
    assert.match(tbRs, /__gourd_tb_close:hover\{background:#c42b1c/, '关闭钮 hover 保留 Win11 标准红（用户拍板）');
    // 左组规格逐项对照（task-monitor.css）
    assert.match(monitorCss, /\.titlebar-action-btn \{[\s\S]{0,200}?width: 30px; height: 26px;[\s\S]{0,80}?border-radius: 6px;/);
    assert.match(monitorCss, /\.titlebar-action-btn:hover \{ background: var\(--bg-hover\);/);
});

/* 【图标同尺寸护栏（2026-10-20 用户报障）】
   报障：「这图标大小都不一致，看起来好奇怪…右侧三个图标优化下，大小和左侧两个保持一致」。
   根因：窗控组用「10x10 视口 / 12px / stroke 1」而左组用「24 网格 / 15px / stroke 2」，
   旧注释用「窗控符号笔画更简，12px 即等效」自证——实测不成立：同一标题栏并排时，
   窗控墨迹 12.00px vs 左组 12.50px，一眼可见偏小（12px/10 视口 → 满铺，15px/24 视口 → 20 单位）。
   本组用源码解析出的真实数字校验两边同契约，改一侧而不改另一侧即变红。 */
const tbIcons = () => {
    const block = tbRs.slice(tbRs.indexOf('var ICONS = {'), tbRs.indexOf('/* ───────── 样式 ─────────'));
    /* 【必须带词边界】属性名互相包含：不加边界时 /width="…"/ 会命中 stroke-width="2"，
       一旦有人把属性改序（完全合法的重构）就会把 15px 误读成 2px，测试报假失败并把人带偏。 */
    const attrOf = (seg, k) => {
        const m = seg.match(new RegExp('(?:^|\\s)' + k + '="([^"]+)"'));
        return m ? m[1] : null;
    };
    const parse = (name) => {
        const i = block.indexOf(name + ':');
        if (i < 0) return null;
        // 截止到该图标自身的 </svg>，避免多行拼接时吃进下一个图标的属性
        const seg = block.slice(i, block.indexOf('</svg>', i));
        return {
            w: attrOf(seg, 'width'), h: attrOf(seg, 'height'), viewBox: attrOf(seg, 'viewBox'),
            strokeWidth: attrOf(seg, 'stroke-width'), stroke: attrOf(seg, 'stroke'),
            fill: attrOf(seg, 'fill'), rx: attrOf(seg, 'rx'), seg,
        };
    };
    return { parse, names: ['minimize', 'maximize', 'restore', 'close'] };
};

test('窗控图标与标题栏左组同尺寸：15px / 24 网格 / stroke-width 2 / fill=none', () => {
    const { parse, names } = tbIcons();
    // 左组基准：从 index.html 的实际 markup 解析，不写死数字
    const btnSvg = indexHtml.match(/id="titlebarTerminalBtn"[\s\S]{0,300}?(<svg[^>]*>)/);
    assert.ok(btnSvg, 'index.html 必须能解析出 #titlebarTerminalBtn 的 svg');
    const leftTag = btnSvg[1];
    const leftW = (leftTag.match(/(?:^|\s)width="(\d+)"/) || [])[1];
    const leftVb = (leftTag.match(/viewBox="([^"]+)"/) || [])[1];
    const leftSw = (leftTag.match(/stroke-width="([^"]+)"/) || [])[1];
    // 左组 rect 圆角：同尺寸下半径不同也会显得"不一样"，因此也必须对齐
    const leftRx = (indexHtml.match(/id="titlebarTerminalBtn"[\s\S]{0,300}?<rect[^>]*rx="([^"]+)"/) || [])[1];
    assert.ok(leftW && leftVb && leftSw && leftRx, '左组 svg 必须带 width/viewBox/stroke-width，rect 必须带 rx');

    for (const n of names) {
        const ic = parse(n);
        assert.ok(ic, 'ICONS.' + n + ' 必须存在');
        assert.strictEqual(ic.w, leftW, 'ICONS.' + n + ' 渲染宽度必须与左组同为 ' + leftW + 'px（曾被用户报障偏小）');
        assert.strictEqual(ic.h, leftW, 'ICONS.' + n + ' 渲染高度必须与左组同为 ' + leftW + 'px');
        assert.strictEqual(ic.viewBox, leftVb, 'ICONS.' + n + ' 必须与左组共享 ' + leftVb + ' 网格（否则同等外框下墨迹大小不同）');
        assert.strictEqual(ic.strokeWidth, leftSw, 'ICONS.' + n + ' 线宽必须与左组同为 ' + leftSw + '（线宽不同会直接看得出粗细不一致）');
        assert.strictEqual(ic.stroke, 'currentColor', 'ICONS.' + n + ' 必须用 currentColor 以跟随主题/hover 前景色');
        assert.strictEqual(ic.fill, 'none', 'ICONS.' + n + ' 必须 fill="none"（否则 stroke 图形会被实心填充）');
        if (ic.rx) {
            assert.strictEqual(ic.rx, leftRx, 'ICONS.' + n + ' 的 rect 圆角必须与左组同为 rx=' + leftRx + '（半径不同时同尺寸也会显出形状不一致）');
        }
    }
});

test('窗控图标不得回退到 10 视口 / 12px / stroke-width 1 旧形态', () => {
    const { parse, names } = tbIcons();
    for (const n of names) {
        const ic = parse(n);
        assert.ok(ic, 'ICONS.' + n + ' 必须存在');
        assert.notStrictEqual(ic.viewBox, '0 0 10 10',
            'ICONS.' + n + ' 不得回退 10x10 视口：满铺视口 + 12px 渲染会让墨迹只有 12.00px，比左组 12.5px 小一圈');
        assert.notStrictEqual(ic.w, '12', 'ICONS.' + n + ' 不得回退 12px 渲染（用户报障尺寸不一致的直接成因）');
        assert.notStrictEqual(ic.strokeWidth, '1', 'ICONS.' + n + ' 不得回退 stroke-width 1（比左组 2 细一半）');
    }
});

/* restore 的“两框咬合”几何护栏：墨迹 bbox 量不出端点浮空（浮空不改变极值），必须直接校验路径端点。
   后框被前框遮断，两个断口必须分别压在前框的上边缘 (y=8) 与右边缘 (x=16) 上；
   曾误写成 M8 6 / h-1，断口各自悬空 2 单位，15px 渲染下就是两根脱节短笔。 */
test('restore 图标的两个断口必须锚在前框相邻边上（不得浮空）', () => {
    const { parse } = tbIcons();
    const ic = parse('restore');
    assert.ok(ic, 'ICONS.restore 必须存在');
    const rect = ic.seg.match(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/);
    assert.ok(rect, 'restore 必须含 rect 前框');
    const [rx0, ry0, rw] = rect.slice(1, 4).map(Number);
    const topEdge = ry0, rightEdge = rx0 + rw;
    const d = (ic.seg.match(/ d="([^"]+)"/) || [])[1];
    assert.ok(d, 'restore 必须含 path 后框');
    const start = d.match(/^M([\d.]+) ([\d.]+)/);
    assert.ok(start, 'restore 的 path 必须以绝对 M 起笔（相对起笔无法静态校验锚点）');
    assert.strictEqual(Number(start[2]), topEdge,
        '后框起笔 y 必须压在前框上边缘 y=' + topEdge + '（满前值 ' + start[2] + '，悬空即脱节）');

    /* 逐段回放 path，求出终点 x。本图标只用 M/V/H/v/h/A/a，足够覆盖。 */
    const segs = d.match(/[A-Za-z][^A-Za-z]*/g) || [];
    let curX = Number(start[1]), curY = Number(start[2]);
    for (const s of segs) {
        const cmd = s[0];
        const nums = (s.slice(1).match(/-?[\d.]+/g) || []).map(Number);
        if (cmd === 'H') curX = nums[nums.length - 1];
        else if (cmd === 'h') curX += nums[nums.length - 1];
        else if (cmd === 'V') curY = nums[nums.length - 1];
        else if (cmd === 'v') curY += nums[nums.length - 1];
        else if (cmd === 'A' || cmd === 'a') {
            const ex = nums[nums.length - 2], ey = nums[nums.length - 1];
            if (cmd === 'A') { curX = ex; curY = ey; } else { curX += ex; curY += ey; }
        }
    }
    assert.strictEqual(curX, rightEdge,
        '后框收尾 x 必须压在前框右边缘 x=' + rightEdge + '（满前值 ' + curX + '，悬空即脱节）');
});

test('控件条总宽单一真源：Rust 常量推导 = 注入脚本 STRIP_W = 拖拽让位 = 左组偏移源', () => {
    const w = Number((tbRs.match(/const BUTTON_WIDTH: u32 = (\d+);/) || [])[1]);
    const h = Number((tbRs.match(/const BUTTON_HEIGHT: u32 = (\d+);/) || [])[1]);
    const gap = Number((tbRs.match(/const BUTTON_GAP: u32 = (\d+);/) || [])[1]);
    const pad = Number((tbRs.match(/const STRIP_PAD_X: u32 = (\d+);/) || [])[1]);
    assert.ok([w, h, gap, pad].every((n) => Number.isFinite(n) && n > 0), '四个尺寸常量必须可解析');
    assert.strictEqual(h, 26, '高度不得回归（曾为 100% 撞满控件条）');
    assert.strictEqual(w * 3 + gap * 2 + pad * 2, 102, '控件条总宽 = 3 钮 + 2 间距 + 2 内边距');
    // 注入脚本从同组常量推导总宽（禁止再出现硬编码 138/102 的第二份认知）
    assert.match(tbRs, /var STRIP_W = BTN_W \* 3 \+ BTN_GAP \* 2 \+ PAD_X \* 2;/);
    assert.match(tbRs, /window\.__GOURD_TITLEBAR_STRIP_W__ = USE_CUSTOM_CONTROLS \? STRIP_W : 0;/, '总宽对外暴露且 mac 归零');
    assert.match(tbRs, /padding-right:' \+ STRIP_W \+ 'px;/, '拖拽条让位从 STRIP_W 推导');
    assert.match(tbRs, /USE_CUSTOM_CONTROLS \? STRIP_W \+ 6 : 6/, '首帧兜底偏移同样推导（mac 不让位）');
    assert.doesNotMatch(tbRs, /height:100%;/, '按钮不得回归撞满控件条高（hover 底会变整条色带）');
});

// ---------- 任务监控右栏 ----------
test('右栏结构：五区 + 记忆行；无头部（标题/关闭/刷新钮均不得回归）', () => {
    for (const id of ['taskMonitorDrawer', 'tmEnvBody', 'tmOutputsBody', 'tmSourcesBody', 'tmSkillsBody', 'tmMemoryRow', 'tmMemoryDot']) {
        assert.ok(indexHtml.includes('id="' + id + '"'), 'index.html 必须承载 #' + id);
    }
    // 用户参照稿形态：监控栏无头部。标题/刷新是冗余控件（开合由标题栏按钮承担、
    // 轮询+事件重拉覆盖实时性）；关闭钮随头部一并移除，Esc 与标题栏 toggle 足够。
    assert.ok(!indexHtml.includes('taskMonitorCloseBtn'), '关闭钮不得回归（头部已整体移除）');
    assert.ok(!indexHtml.includes('task-monitor-head'), '头部容器不得回归');
    assert.ok(!indexHtml.includes('task-monitor-title'), '「任务监控」标题不得回归');
    assert.doesNotMatch(monJs, /addRefreshBtn|taskMonitorCloseBtn/,
        'JS 不得再创建刷新钮或绑定已删除的关闭钮（querySelector 空引用虽不报错但是死代码）');
    assert.match(indexHtml, /data-tm-sec="env"[\s\S]{0,700}?data-tm-sec="outputs"[\s\S]{0,700}?data-tm-sec="sources"[\s\S]{0,700}?data-tm-sec="skills"/,
        '四个折叠区顺序：环境/产出/来源/技能');
});

test('监控是版式内右栏而非遮罩抽屉：主区让宽 + 底缘 dock 终端', () => {
    assert.match(monitorCss, /body\.task-monitor-open \.main-area \{ margin-right: var\(--task-monitor-width\); \}/,
        '不遮挡的核心机制：打开时主区让出宽度，内容被压缩而非被盖');
    // 基准规则块精确切片（到首个 } 为止），避免媒体块里的 left 干扰断言
    const baseRule = monitorCss.slice(monitorCss.indexOf('.task-monitor-drawer {'));
    const base = baseRule.slice(0, baseRule.indexOf('}'));
    assert.match(base, /position: fixed;/);
    assert.match(base, /right: 0; bottom: 0;/, '右缘锚定 + 定宽：左缘与主区让宽后右缘同变量天然对齐');
    assert.doesNotMatch(base, /(^|[\s;])left\s*:/,
        '基准规则不得设 left 属性：left+right+width 同设时 LTR 下 right 被忽略（过约束），右栏会漂到侧栏右缘（border-left 不算）');
    // 【头部色差回归护栏】顶缘恒 0（与主区顶行齐平）+ 栏身/顶行色带底色均与内容区同源。
    // 曾用 top:var(--titlebar-strip-h,36px) 下移：桌面壳下右栏头顶露底色色带；
    // 曾用 --bg-sidebar：右栏像第二根侧栏，与内容区色差（用户两轮报障）。
    // 色带还曾误铺 --bg-body：strip 透明段在 .main-area 内、透出的是 --bg-main，
    // --bg-body（暗 #131315/亮 #fafafa）与 --bg-main（暗 #17171a/亮 #fff）不同色，
    // 色带自身即成新色差缝（code review 抓出），故色带必须与栏身同用 --bg-main。
    assert.match(base, /top: 0;/, '顶缘必须恒 0：下移会在桌面壳下露出底色头部色带');
    assert.doesNotMatch(monitorCss, /--titlebar-strip-h/, '下移变量已废弃，不得回归');
    assert.match(base, /background: var\(--bg-main\);/, '底色必须与内容区一致（--bg-main），不得用 --bg-sidebar');
    assert.match(monitorCss, /body\.is-electron \.task-monitor-drawer::before \{[\s\S]{0,200}?height: 36px;[\s\S]{0,80}?background: var\(--bg-main\);/,
        '桌面壳顶行色带必须与栏身/内容区同源（--bg-main）：strip 透出的是 .main-area 底色而非 body 底色');
    assert.doesNotMatch(monitorCss, /\.task-monitor-drawer::before \{[\s\S]{0,200}?--bg-body/,
        '色带严禁 --bg-body：与左列顶行透出的 --bg-main 不同色，会自造色差缝');
    assert.match(monitorCss, /body\.terminal-open \.task-monitor-drawer \{ bottom: var\(--code-terminal-height, 0px\); \}/,
        'dock 必须门控 terminal-open：关终端后高度变量仍在，无门控右栏会悬空 240px');
    assert.doesNotMatch(monitorCss, /translateX\(100%\)/, '滑出抽屉形态已废弃（浮层会遮挡内容）');
    assert.doesNotMatch(monitorCss, /\.task-monitor-head/);
});

// 【P1 遮挡护栏】终端是 fixed 覆盖层：主区必须压 height 让高（margin-bottom 对
// 显式定高盒无效），否则 chat 输入区/发送按钮被整块盖住（实测复现过）。
test('终端打开时主区让出底部高度，窄屏隐藏同步归位', () => {
    assert.match(codeCss, /body\.terminal-open \.main-area\s*\{\s*height:\s*calc\(100vh - var\(--code-terminal-height/,
        '主区让高必须是 height:calc(100vh - 终端高)：margin 对定高盒不产生让位');
    assert.doesNotMatch(codeCss, /body\.terminal-open \.main-area\s*\{[^}]*margin-bottom/,
        'margin-bottom 对 height:100vh 的盒无效（只会推出视口），禁止用作让高手段');
    const narrow = codeCss.slice(codeCss.indexOf('窄屏侧栏退为浮层'));
    assert.match(narrow, /body\.terminal-open \.main-area\s*\{\s*height:\s*100vh;/,
        '窄屏终端隐藏时让高必须归位，否则主区白白矮一截');
});

test('终端左缘让开侧栏：面板与调高手柄同变量，JS 实测同步', () => {
    const paneRule = codeCss.slice(codeCss.indexOf('.code-terminal-pane {'));
    assert.match(paneRule.slice(0, 600), /left: var\(--terminal-left, var\(--sidebar-width\)\); right: 0;/,
        '终端不得再 left:0 全宽盖住侧栏（用户参照稿：终端在主区底部）');
    const handleRule = codeCss.slice(codeCss.indexOf('.code-terminal-resize-handle {'));
    assert.match(handleRule.slice(0, 400), /left: var\(--terminal-left, var\(--sidebar-width\)\)/,
        '手柄必须与面板同左缘，否则拖拽热区伸进侧栏');
    assert.match(termJs, /setProperty\('--terminal-left'/, '左缘变量由 JS 实测侧栏宽度写入');
    assert.match(termJs, /querySelector\('\.sidebar'\)/, '实测对象是 .sidebar（可拖拽改宽，CSS 算不出）');
    assert.match(termJs, /addEventListener\('resize', syncTerminalLeft\)/);
});

test('监控数据走五个后端端点，且带版本防覆盖与 X-Session-Cwd', () => {
    for (const ep of ['/web/chat/git/status', '/web/chat/git/remote', '/web/chat/changes/session', '/web/chat/attachment/list', '/web/chat/session/tool-usage']) {
        assert.ok(monJs.includes(ep), '必须请求 ' + ep);
    }
    assert.match(monJs, /reqVersions\[slot\] !== ver/, '旧响应晚到不得覆盖新响应（同 app-todos 纪律）');
    assert.match(monJs, /X-Session-Cwd/, '工作区归属头');
    assert.match(monJs, /encodeSessionCwdHeader/);
    assert.match(monJs, /POLL_MS = 6000/, '打开期间轮询刷新');
    assert.match(monJs, /e\.key === 'Escape'/, 'Esc 关闭右栏');
    assert.match(monJs, /window\.toggleTaskMonitor = toggleMonitor/, '标题栏按钮的调用面');
});

// 【默认显示 + 首页门禁】用户反馈两轮：监控默认要显示；但新建任务首页没有执行
// 任务，展示监控不合理。契约：会话视图默认开（偏好可关）、欢迎页禁开且自动收起。
test('监控默认显示：会话内默认开，欢迎页门禁禁开且自动收起', () => {
    assert.match(monJs, /function isWelcomePage\(\)/, '欢迎页判定必须显式建模');
    assert.match(monJs, /getElementById\('chatView'\)[\s\S]{0,120}?classList\.contains\('active'\)/,
        '欢迎页判定以 chatView.active 为唯一真源（与 app-ui.js 视图切换同源）');
    assert.match(monJs, /if \(isWelcomePage\(\)\) return;/, 'openMonitor 必须有欢迎页门禁（手动点击也不放行）');
    assert.match(monJs, /new MutationObserver\(syncWithView\)\.observe\(chatViewEl/,
        '视图切换必须观察 chatView 的 class 变化（不依赖调用顺序）');
    assert.match(monJs, /if \(isOpen\(\)\) closeMonitor\(\);/, '回欢迎页自动收起');
    assert.match(monJs, /defaultOpenPref\(\)/, '进入会话默认开受偏好控制');
    assert.match(monJs, /tm-default-open/, '偏好持久化键');
    assert.match(monJs, /window\.openTaskMonitor = openMonitor/, '默认开入口对外暴露');
});

test('产出行点击必须透传会话根，否则跨工作区必 404', () => {
    const clickBlock = monJs.slice(monJs.indexOf("closest('.tm-row-click')"));
    assert.match(clickBlock, /resolveRoot\(sid\)/, '点击时重新解析会话根（不用缓存，防会话切换后陈旧）');
    assert.match(clickBlock, /openFileViewer\(p, shortPath\(p\), root \|\| undefined\)/,
        'root 必须透传：openFileViewer 缺省取 code 当前项目根，会话根≠当前根时 filer/read 必 404');
});

test('记忆行：updated 类驱动圆点与文案，跳转走 openMemoryView', () => {
    assert.match(monJs, /classList\.toggle\('updated', updated\)/);
    assert.match(monJs, /memory\.updated/, '更新态文案键');
    assert.match(monJs, /openMemoryView/, '右上跳转箭头必须真跳转，不是装饰');
    assert.match(monitorCss, /\.tm-memory-row\.updated \.tm-memory-dot \{ background: var\(--accent\); \}/,
        '更新态圆点必须强调色（参照稿蓝点语义）');
});

/* 【来源区：缩略图 + 友好名 + 点击预览（2026-10-15 用户改进需求）】
   机器长名（pasted-image-<毫秒戳>-<随机>.png）直接展示必被截断；图片行现改展示
   「monitor.image · 相对时间」+ meta 拉回的真实缩略图，点击走全站灯箱。
   本组用例锁：① 图片行不再以存储名做主文案；② meta 结果为异步升级且带
   版本守卫（旧响应不得回写新 DOM）；③ 点击链路（fetchAttachmentMeta → openLightbox）
   与降级 toast；④ 缩略图容器 CSS 不得溢出 30px 图标盒。 */
test('来源区图片行：友好名 + 缩略图升级 + 点击灯箱预览（含降级提示）', () => {
    const src = monJs.slice(monJs.indexOf('function renderSources('), monJs.indexOf('function renderSkills('));
    /* ① 图片行文案用 i18n 键 monitor.image，不再 esc(it.name) 做正文（title 仍保留原名） */
    assert.match(src, /t\('monitor\.image'\)/, '图片行主文案必须是 monitor.image（不得直接展示机器存储名）');
    assert.match(src, /tm-row-preview/, '图片行必须带可预览标记类（供点击委托/可选光标样式命中）');
    assert.match(src, /data-tm-source=/, '图片行必须带 data-tm-source 路径锚点（meta 结果指向替换）');
    assert.match(src, /title="' \+ esc\(it\.name\)/, '原存储名必须收进 title（悬停可见，不可直接丢弃）');
    /* ② 缩略图异步升级：版本号守卫（轮询重渲染后旧 meta 结果必须丢弃） */
    assert.match(src, /upgradeSourceThumbs\(imagePaths\)/, '渲染后必须启动缩略图异步升级');
    assert.match(src, /srcThumbSeq/, '必须有版本号守卫（6s 轮询重渲染覆盖旧行后，旧响应不得回写）');
    assert.match(src, /mySeq !== srcThumbSeq/, '守卫比较必须真实存在（只声明不比较是死变量）');
    assert.match(src, /tm-src-thumb/, '缩略图 img 必须带 tm-src-thumb 类（CSS 尺寸口径）');
    /* ③ 点击链路：fetchAttachmentMeta（复用常驻缓存）→ openLightbox；失败 toast */
    assert.match(src, /fetchAttachmentMeta/, '点击必须复用 fetchAttachmentMeta（缓存/在途合并在此层复用）');
    assert.match(src, /openLightbox/, '必须走全站灯箱（对话区附件同款交互）');
    assert.match(src, /preview_load_failed/, '拉不到 dataUrl 时必须 toast 提示（不得静默）');
    assert.match(src, /addEventListener\('click'/, '点击委托必须挂载');
    /* ④ CSS：缩略图不得溢出 30px 图标盒 */
    assert.match(monitorCss, /\.tm-row-icon \{[^}]*overflow: hidden;/, '图标盒必须 overflow:hidden（缩略图裁切不外溢）');
    assert.match(monitorCss, /\.tm-row-icon \.tm-src-thumb \{ width: 100%; height: 100%; object-fit: cover;/, '缩略图必须铺满图标盒并 object-fit 裁切');
    assert.match(monitorCss, /\.tm-row-preview \{ cursor: zoom-in; \}/, '可预览行光标必须 zoom-in（点击 affordance）');
});

/* 【Esc 层级纪律（2026-10-15 实测缺陷修复）】
   CDP 实测复现：从监控「来源」区点开图片灯箱后按 Esc，灯箱与整个监控抽屉
   被同一发事件一起关闭（旧实现 jQuery 冒泡监听与抽屉的 document Esc 监听竞跑）。
   契约：openLightbox 必须在【捕获阶段】消费 Esc 并 stopPropagation —— 最顶层模态
   先关，不得穿透到下层（抽屉/diff viewer/向导）。同时开放层不得再冒出冒泡版监听。 */
test('Esc 层级：灯箱捕获阶段消费（防穿透关闭下层抽屉）', () => {
    const lb = msgJs.slice(msgJs.indexOf('function openLightbox('), msgJs.indexOf('window.openLightbox'));
    assert.ok(lb.length > 100, 'openLightbox 切片必须真实命中的函数（而非空段）');
    assert.match(lb, /document\.addEventListener\('keydown', onKey, true\)/,
        '灯箱 Esc 监听必须注册在【捕获阶段】（第三参 true）——否则同发与抽屉竞跑');
    assert.match(lb, /e\.stopPropagation\(\)/, '捕获命中后必须 stopPropagation，阻止穿透到下层消费者');
    assert.match(lb, /document\.removeEventListener\('keydown', onKey, true\)/,
        'close 必须在同一捕获相位移除监听（第三参必须一致，否则监听泄漏累积）');
    assert.doesNotMatch(lb, /\$\(document\)\.on\('keydown', onKey\)/,
        '不得回退为冒泡版 jQuery 监听（本次缺陷形态）');
});

// ---------- 装配 ----------
test('APP_SCRIPTS 登记：新脚本在 app-terminal.js 之后', () => {
    const list = bootJs.slice(bootJs.indexOf('var APP_SCRIPTS = ['), bootJs.indexOf('];', bootJs.indexOf('var APP_SCRIPTS = [')));
    const iTerm = list.indexOf('/js/app-terminal.js');
    const iBar = list.indexOf('/js/app-titlebar-actions.js');
    const iMon = list.indexOf('/js/app-task-monitor.js');
    assert.ok(iTerm > 0 && iBar > iTerm && iMon > iBar,
        '顺序：terminal → titlebar-actions（依赖 toggleCodeTerminal）→ task-monitor');
});

test('index.html 必须 link task-monitor.css', () => {
    assert.match(indexHtml, /<link rel="stylesheet" href="\/css\/task-monitor\.css"\/>/);
});

// ---------- i18n ----------
const MONITOR_KEYS = ['title','env','outputs','sources','skills','image','memory_updated','memory_not_updated','open_memory',
    'no_changes','changes_count','no_git','no_remote','no_upstream','synced','ahead_behind',
    'env_local','env_remote','empty_env','empty_outputs','empty_sources','no_skills','load_failed'];
test('12 语言包 monitor.* 23 键齐全非空', () => {
    const dir = path.join(STATIC, 'locales');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    assert.strictEqual(files.length, 12, '语言包数量');
    for (const f of files) {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, ''));
        assert.ok(data.monitor, f + ' 缺 monitor 段');
        for (const k of MONITOR_KEYS) {
            assert.ok(typeof data.monitor[k] === 'string' && data.monitor[k].length > 0, f + ' 缺 monitor.' + k);
        }
    }
    // 占位符一致性：带参键在各语言的 {n} 数量必须与 zh-CN 相同（否则运行时替换错位）
    const zh = JSON.parse(fs.readFileSync(path.join(dir, 'zh-CN.json'), 'utf8').replace(/^\uFEFF/, '')).monitor;
    for (const f of files) {
        const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, '')).monitor;
        for (const k of ['changes_count', 'ahead_behind']) {
            const nZh = (zh[k].match(/\{\d\}/g) || []).length;
            const nLoc = (m[k].match(/\{\d\}/g) || []).length;
            assert.strictEqual(nLoc, nZh, f + ' ' + k + ' 占位符数量不一致');
        }
    }
});

// ---------- 桌面端规约：禁原生对话框（用户 2026-10-14 报障：带「localhost:4808 显示」抬头的原生 confirm） ----------
test('全仓禁原生 confirm/alert/prompt（桌面端规约）', () => {
    const dir = path.join(STATIC, 'js');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.endsWith('.min.js'));
    const offenders = [];
    for (const f of files) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        // 词边界排除 layConfirm/fallbackConfirm 等同族标识符（前接字母无边界）与成员调用
        const re = /(?<![.\w$])(confirm|alert|prompt)\s*\(/g;
        let m;
        while ((m = re.exec(src))) {
            offenders.push(f + ' @' + m.index);
        }
    }
    assert.deepStrictEqual(offenders, [],
        '原生对话框带浏览器来源抬头（如 localhost:4808 显示），桌面端违和；一律 layConfirm/layAlert');
});

test('layConfirm/layAlert 内置无 layer 兜底，绝不回落原生', () => {
    assert.match(baseJs, /function getLayerRef\(\)/);
    const lc = baseJs.slice(baseJs.indexOf('function layConfirm('), baseJs.indexOf('function layAlert('));
    assert.match(lc, /fallbackConfirm\(msg, yesFn, noFn\)/, 'layer 缺失必须走应用内 DOM 兜底弹窗');
    const la = baseJs.slice(baseJs.indexOf('function layAlert('), baseJs.indexOf('function fallbackConfirm('));
    assert.match(la, /fallbackAlert\(msg\)/);
    assert.match(baseJs, /function fallbackConfirm\(msg, yesFn, noFn\)/);
    assert.match(themeCss, /\.kd-fallback-overlay \{/, '兜底遮罩样式必须存在且跟随主题令牌');
    // noFn 取消回调两条路径都必须接通（异步确认的取消分支依赖它）
    assert.match(lc, /noFn\(\)/, 'layer 路径必须触发取消回调');
    const fb = baseJs.slice(baseJs.indexOf('function fallbackConfirm('), baseJs.indexOf('function fallbackAlert('));
    assert.match(fb, /noFn\(\)/, '兜底路径必须触发取消回调');
    assert.match(fb, /Escape/, '兜底弹窗必须支持 Esc 关闭');
});

test('终端关 tab：busyQuery 判忙闲，空闲静默关、忙时应用内确认', () => {
    const rc = termJs.slice(termJs.indexOf('function requestCloseTab('), termJs.indexOf('function closeTab('));
    assert.match(rc, /queryBusy\(tab/, '必须问后端忙闲（连接存活≠在跑：常驻 cmd 永远活着）');
    assert.match(rc, /layConfirm/, '确认必须应用内弹窗');
    assert.doesNotMatch(rc, /window\.confirm/, '原生 confirm 禁令');
    const qb = termJs.slice(termJs.indexOf('function queryBusy('), termJs.indexOf('function requestCloseTab('));
    assert.match(qb, /busyQuery/, '协议帧类型');
    assert.match(qb, /setTimeout/, '超时必须兜底（查询失败不得卡死关闭路径）');
    // 后端：忙 = shell 存在存活后代进程；chcp 走 /K 启动参数（禁 stdin 注入幽灵命令）
    assert.match(gateJava, /descendants\(\)/, '忙闲判定必须看进程树');
    assert.match(gateJava, /"\/K", "chcp 65001 >nul"/, '代码页必须经启动参数');
    assert.doesNotMatch(gateJava, /write\("chcp 65001/, 'stdin 注入 chcp 会被 cmd 回显成幽灵命令');
    assert.match(gateJava, /"busyQuery"\.equals\(type\)/, '后端必须处理 busyQuery 帧');
});

test('code/history 未保存确认改异步回调式（原生 confirm 清零）', () => {
    const cf = codeJs.slice(codeJs.indexOf('function confirmDiscardUnsavedIfAny('), codeJs.indexOf('window.confirmDiscardUnsavedIfAny'));
    assert.match(cf, /layConfirm\(/);
    assert.match(cf, /proceed, cancel/, '回调式签名（同步 return 布尔已不可能）');
    const sp = codeJs.slice(codeJs.indexOf('function selectProject('), codeJs.indexOf('function doSelectProject('));
    assert.match(sp, /confirmDiscardUnsavedIfAny\(function \(\) \{ doSelectProject/, '续体必须包进 proceed');
    const hs = histJs.slice(histJs.indexOf('confirmDiscardUnsavedIfAny'), histJs.indexOf('function doSwitchSession('));
    /* 【本条曾把回归形态锁成契约 —— 2026-10-14 事故复盘】
       原断言是 /doSwitchSession\(idx\); \}, function \(\) \{\}\)/，与「漏传 switchProject」
       的错误代码形状【完全一致】→ 上一轮 27/27 全绿其实在为致命 bug 保驾，
       而 bug 表现为「点击任何会话都静默失败 + ReferenceError」。
       教训：把同步 confirm 改异步续体时，「续体包进回调」只是形状，
       「续体函数拿得到它需要的全部变量」才是行为。形状断言必须同时锁住
       【调用点传了什么】与【被调函数声明了什么】，缺一侧就会锁错形态。
       真正的行为护栏见下方 vm 真执行用例（那条才杀得死本缺陷）。 */
    assert.match(hs, /confirmDiscardUnsavedIfAny\(function \(\) \{ doSwitchSession\(idx, switchProject\); \}/,
        '切会话续体必须包进 proceed，且必须把 switchProject 显式传给续体函数');
    assert.match(hs, /doSwitchSession\(idx, switchProject\);\s*$/m,
        '非续体路径（无未保存改动直接切）同样必须传 switchProject');
    const sigLine = histJs.slice(histJs.indexOf('function doSwitchSession(')).split('\n')[0];
    assert.match(sigLine, /function doSwitchSession\(idx, switchProject\)/,
        'doSwitchSession 必须把 switchProject 声明为形参：它是顶层函数，作用域链只有全局，' +
        '拿不到 selectSession 的局部变量（漏声明即 ReferenceError，且抛在函数中段 → 半切换脏状态）');
    assert.doesNotMatch(codeJs, /window\.confirm\(/, 'app-code.js 原生 confirm 全清零');
});

/* ===== 真执行护栏：作用域链断裂只能靠执行暴露 =====
   WHY 不能只靠字符串断言：本次缺陷是「顶层续体函数裸引用外层函数的局部变量」，
   它在语法层完全合法（node --check 通过）、在字符串层极易被形状断言放行，
   只有【真的跑一遍】才会抛 ReferenceError。故把 .tmp 里的一次性 vm 验证
   固化进契约：从源码提取真实的 selectSession/doSwitchSession，在 vm 里以
   与浏览器 <script> 同构的「顶层函数」语义执行（函数声明进全局作用域，
   其作用域链只有全局），断言 chat / code 两条路径都零异常且分支语义正确。
   这条用例对本缺陷是【唯一杀得死】的护栏：把签名退回 doSwitchSession(idx)
   后它必然变红，而所有形状断言都可能被绕过。 */
test('真执行：点击会话切换零 ReferenceError（作用域链护栏）', () => {
    const vm = require('vm');
    /* 源码是 CRLF，正则带 \n 会 0 命中（本仓反复踩）→ 按行数组提取 */
    const lines = histJs.split(/\r?\n/);
    const extract = (name) => {
        let start = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].indexOf('function ' + name + '(') === 0) { start = i; break; }
        }
        assert.ok(start >= 0, 'app-history.js 必须存在顶层 function ' + name + '(');
        let depth = 0;
        const out = [];
        for (let i = start; i < lines.length; i++) {
            out.push(lines[i]);
            for (const ch of lines[i]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
            if (i > start && depth === 0) break;
        }
        return out.join('\n');
    };
    const selectSrc = extract('selectSession');
    const doSwitchSrc = extract('doSwitchSession');

    const run = (mode, idx) => {
        const calls = { syncProjectContext: [], setActiveSession: [], loadMessages: 0, updateHistoryUI: 0 };
        const sandbox = {
            chatHistory: [
                { sessionId: 'work-aaa', label: 'A', projectRoot: 'D:/proj/a' },
                { sessionId: 'work-bbb', label: 'B', projectRoot: 'D:/proj/b' }
            ],
            currentChatIndex: 0, SESSION_ID: 'work-aaa', inChatMode: true,
            sessionMap: {
                'work-aaa': { container: { children: { length: 3 } }, isStreaming: false },
                'work-bbb': { container: { children: { length: 0 } }, isStreaming: false }
            },
            rememberActiveSession() {}, updateHistoryUI() { calls.updateHistoryUI++; },
            setActiveSession(id) { calls.setActiveSession.push(id); },
            refreshSessionModel() {}, loadMessages() { calls.loadMessages++; },
            scrollToBottom() {}, updateLoadMoreBtn() {}, closeDiffViewer() {},
            switchToChatMode() { sandbox.inChatMode = true; },
            window: null
        };
        sandbox.window = {
            appMode: mode,
            currentProjectRoot: mode === 'code' ? 'D:/proj/a' : '',
            syncProjectContext(r) { calls.syncProjectContext.push(r); },
            applyChatWorkspace() {},
            confirmDiscardUnsavedIfAny(proceed) { proceed(); }
        };
        const ctx = vm.createContext(sandbox);
        let err = null;
        try {
            vm.runInContext(doSwitchSrc + '\n' + selectSrc + '\nselectSession(' + idx + ');', ctx, { timeout: 5000 });
        } catch (e) { err = e; }
        /* 【跨 realm 陷阱】vm 沙箱里抛的 ReferenceError 与宿主的不是同一构造器，
           instanceof 恒 false（首次跑验证脚本因此误报）→ 一律用 constructor.name 判定。 */
        return { err, errKind: err && err.constructor ? err.constructor.name : 'none',
            errMsg: err ? String(err.message) : '', sandbox, calls };
    };

    const chat = run('chat', 1);
    assert.strictEqual(chat.err, null,
        'chat 模式点击会话必须零异常（实际 ' + chat.errKind + ': ' + chat.errMsg + '）');
    assert.strictEqual(chat.sandbox.SESSION_ID, 'work-bbb', '会话必须真切到被点击的那条');
    assert.deepStrictEqual(chat.calls.setActiveSession, ['work-bbb'], '必须激活新会话容器');
    assert.strictEqual(chat.calls.loadMessages, 1, '必须加载新会话历史');
    assert.strictEqual(chat.calls.syncProjectContext.length, 0,
        'chat 模式 switchProject=false：不得误触项目同步（条件语义未被放宽）');

    const code = run('code', 1);
    assert.strictEqual(code.err, null,
        'code 模式跨项目切会话必须零异常（实际 ' + code.errKind + ': ' + code.errMsg + '）');
    assert.deepStrictEqual(code.calls.syncProjectContext, ['D:/proj/b'],
        'code 模式 switchProject=true：必须真的同步到目标项目根');
    assert.strictEqual(code.sandbox.window.currentProjectRoot, 'D:/proj/b',
        'currentProjectRoot 必须跟上（否则后续发送的 X-Session-Cwd 错位）');

    const same = run('code', 0);
    assert.strictEqual(same.err, null);
    assert.strictEqual(same.calls.syncProjectContext.length, 0,
        'code 模式切到同项目会话不得触发项目同步（传参不能把条件写成恒真）');
});

// ---------- 镜像同步（gourd-ai-tauri/ui 存在才比对）----------
test('新增/修改文件与 tauri 镜像逐字节一致', () => {
    const mirrorRoot = path.resolve(__dirname, '../../../../gourd-ai-tauri/ui');
    if (!fs.existsSync(mirrorRoot)) return; // CI 干净检出无镜像：显式跳过
    const files = ['index.html', 'code.html', 'css/code.css', 'css/task-monitor.css', 'css/theme.css',
        'js/app-terminal.js', 'js/app-titlebar-actions.js', 'js/app-task-monitor.js', 'js/app-bootstrap.js',
        'js/app-base.js', 'js/app-code.js', 'js/app-history.js', 'js/app-access-mode.js',
        'js/app-automation.js', 'js/app-memory.js', 'js/app-settings-permission.js',
        'js/app-message.js', 'js/app-ui.js'];
    for (const rel of files) {
        const a = fs.readFileSync(path.join(STATIC, rel));
        const b = fs.readFileSync(path.join(mirrorRoot, rel));
        assert.strictEqual(crypto.createHash('sha256').update(a).digest('hex'),
            crypto.createHash('sha256').update(b).digest('hex'),
            '镜像不同步: ' + rel + '（跑 node gourd-ai-tauri/cmd/prepare-ui.js）');
    }
});
