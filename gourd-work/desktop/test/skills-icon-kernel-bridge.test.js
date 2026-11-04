/**
 * 契约测试：技能图标在桌面壳（Tauri）下必须可达。
 *
 * ── 缺陷现场（2026-10-28，用户报「技能图片未展示」）──────────────────────
 * 桌面壳用 asset 协议托管 frontendDist，页面源是 http://tauri.localhost，而
 * Rust 内核跑在 http://127.0.0.1:<随机端口>。kernel-bridge.js 改写了
 * fetch / XMLHttpRequest / WebSocket 三层，但技能图标是
 * `<img src="/web/settings/skills/icon?url=...">` —— **DOM 属性形态**，三层
 * 改写一个都拦不到。于是请求落到 tauri.localhost 的 SPA fallback，拿回
 * 200 + index.html，图片解码失败 → 业务代码的 onerror="this.remove()" 把
 * <img> 移除 → 图标永远只剩首字母底。
 *
 * 后端图标代理本身是好的（实测三市场图标全部 200 + image/*），所以这是纯
 * 前端寻址缺陷。
 *
 * ── 为什么不能用 MutationObserver 事后纠正 ────────────────────────────────
 * innerHTML 插入的 <img> 会立刻发起加载，失败即触发 onerror 移除元素，
 * observer 回调拿到的是已经被移除的节点。必须在**拼 HTML 字符串时**就写
 * 绝对地址，因此 kernel-bridge 暴露同步 helper `window.__gworkApiUrl`。
 *
 * ── 测试形态 ──────────────────────────────────────────────────────────────
 * 用 node:vm 在沙箱里真跑 kernel-bridge.js（不是源码字符串扫描），断言它
 * 暴露的 helper 与三层改写的实际行为。浏览器模式（无注入变量）必须零影响。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const uiRoot = path.resolve(__dirname, '../ui');
const readUi = (...parts) =>
    fs.readFileSync(path.join(uiRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');

const ORIGIN = 'http://127.0.0.1:51234';
const ICON_PATH = '/web/settings/skills/icon?url=https%3A%2F%2Fcdn%2Fi.png';

/**
 * 在沙箱里执行 kernel-bridge.js。
 *
 * @param {string|null} origin 注入的 __GWORK_KERNEL_ORIGIN__；null = 浏览器模式
 * @param {string} host 页面源 host（asset 协议下是 tauri.localhost）
 */
function loadBridge({ origin = ORIGIN, host = 'tauri.localhost' } = {}) {
    // bridge 只在对应全局存在时才包装，所以三样都要给最小可用形态。
    // 原生 open 在这里就记录调用：bridge 加载后会包装它，测试必须观察
    // 「包装层 → 原生层」的完整链路，事后再覆盖 prototype.open 会把 bridge
    // 的包装替换掉，测出来的是未改写的假象。
    const opened = [];
    function XMLHttpRequest() {}
    XMLHttpRequest.prototype.open = function (method, url) { opened.push(url); };
    function WebSocket() {}
    function fetch() {}

    const sandbox = { console, XMLHttpRequest, WebSocket, fetch, opened };
    sandbox.window = sandbox;
    sandbox.window.location = { host };
    if (origin) sandbox.window.__GWORK_KERNEL_ORIGIN__ = origin;

    vm.createContext(sandbox);
    vm.runInContext(readUi('js', 'kernel-bridge.js'), sandbox, { filename: 'kernel-bridge.js' });
    return sandbox;
}

test('桌面壳：__gworkApiUrl 把图标代理路径改写为内核绝对地址', () => {
    const w = loadBridge();
    assert.equal(typeof w.__gworkApiUrl, 'function', 'bridge 必须暴露同步 helper');
    assert.equal(w.__gworkApiUrl(ICON_PATH), ORIGIN + ICON_PATH);
});

test('桌面壳：改写后的地址不再落在 tauri.localhost（缺陷判据）', () => {
    const w = loadBridge();
    const abs = w.__gworkApiUrl(ICON_PATH);
    assert.ok(abs.startsWith('http://127.0.0.1:'), abs);
    assert.ok(!abs.includes('tauri.localhost'), abs);
    // 查询串必须原样保留，否则后端拿不到 url 参数会 404。
    assert.ok(abs.includes('url=https%3A%2F%2Fcdn%2Fi.png'), abs);
});

test('浏览器模式：helper 不存在，相对路径照常工作（零影响）', () => {
    const w = loadBridge({ origin: null });
    assert.equal(w.__gworkApiUrl, undefined, '未注入 origin 时不得激活');
    assert.equal(w.__GWORK_KERNEL_BRIDGE__, undefined);
    // 原生实现未被包装：业务代码的兜底分支返回相对路径即可正常工作。
    assert.equal(w.fetch.name, 'fetch');
});

test('静态资源不被改写（误改会让页面白屏）', () => {
    const w = loadBridge();
    for (const p of ['/js/app-skills.js', '/css/skills.css', '/locales/zh-CN.json', '/monaco/loader.js']) {
        assert.equal(w.__gworkApiUrl(p), p, `${p} 必须留在 asset 协议`);
    }
});

test('外部绝对地址原样放行', () => {
    const w = loadBridge();
    const ext = 'https://skillhub-1388575217.cos.accelerate.myqcloud.com/i.png';
    assert.equal(w.__gworkApiUrl(ext), ext);
});

test('三层改写未被 helper 的引入破坏（回归保护）', () => {
    const w = loadBridge();

    // XHR：jQuery $.ajax 全走这里，必须经包装层改写后才落到原生 open。
    const xhr = new w.XMLHttpRequest();
    xhr.open('GET', ICON_PATH);
    assert.deepEqual(w.opened, [ORIGIN + ICON_PATH], 'XHR 仍须改写');

    // WebSocket：app-streaming.js 用 location.host 现拼 ws:// URL。
    assert.equal(
        w.__GWORK_KERNEL_BRIDGE__.rewriteUrl('ws://tauri.localhost/web/gate'),
        'ws://127.0.0.1:51234/web/gate',
        'WS 仍须换 host'
    );

    // fetch：rewriteUrl 口径与 helper 一致（同一个函数）。
    assert.equal(w.__GWORK_KERNEL_BRIDGE__.rewriteUrl(ICON_PATH), w.__gworkApiUrl(ICON_PATH));
});

// ─── app-skills.js：图标地址必须经 helper 生成 ───────────────────────────────

const skillsJs = readUi('js', 'app-skills.js');

/** 去掉注释后的源码，避免注释里的字面量造成假绿。 */
function codeOnly(src) {
    return src
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
        .join('\n');
}

test('app-skills：不存在裸相对路径的图标 <img>（缺陷形态必须绝迹）', () => {
    const code = codeOnly(skillsJs);
    assert.ok(
        !code.includes('src="/web/settings/skills/icon'),
        '图标 src 不得再写死相对路径：桌面壳下会落到 SPA fallback'
    );
    assert.ok(
        !code.includes("src='/web/settings/skills/icon"),
        '单引号形态同样不得写死'
    );
});

test('app-skills：iconSrc 走 __gworkApiUrl 且浏览器模式兜底相对路径', () => {
    const code = codeOnly(skillsJs);
    assert.ok(code.includes('function iconSrc('), '必须有统一的图标地址生成函数');
    const body = code.slice(code.indexOf('function iconSrc('));
    const fn = body.slice(0, body.indexOf('\n    }'));
    assert.ok(fn.includes('/web/settings/skills/icon?url='), fn);
    assert.ok(fn.includes('window.__gworkApiUrl'), '桌面壳下必须取内核绝对地址');
    assert.ok(
        /typeof window\.__gworkApiUrl === 'function'/.test(fn),
        '必须做存在性判断，浏览器模式（helper 不存在）才能兜底相对路径'
    );
});

test('app-skills：卡片与详情弹窗两处图标都经 iconSrc', () => {
    const code = codeOnly(skillsJs);
    const uses = code.split('iconSrc(').length - 1;
    // 1 处定义 + 2 处调用（iconHtml 卡片图标、详情弹窗图标）
    assert.ok(uses >= 3, `iconSrc 至少要有定义与两处调用，实际出现 ${uses} 次`);
    assert.ok(code.includes('escapeAttr(iconSrc('), '图标地址必须做属性转义');
});

test('index.html 在业务脚本之前引入 kernel-bridge（否则改写来不及）', () => {
    const html = readUi('index.html');
    // 只认 <script src> 形态：注释里也提到 app-bootstrap.js，用裸 indexOf 会
    // 命中注释行，把顺序断言变成永真/永假的噪声。
    const scriptPos = (file) => html.indexOf(`<script src="${file}">`);
    const bridgeAt = scriptPos('/js/kernel-bridge.js');
    const bootAt = scriptPos('/js/app-bootstrap.js');
    assert.ok(bridgeAt > -1, 'index.html 必须以 <script src> 引入 kernel-bridge.js');
    assert.ok(bootAt > -1, 'index.html 必须以 <script src> 引入 app-bootstrap.js');
    assert.ok(bridgeAt < bootAt, 'bridge 必须早于业务脚本，否则首个请求就漏改写');
});
