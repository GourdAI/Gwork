/* 外链点击守卫契约：消息里的网页链接绝不能在应用窗口内导航
 *
 * 缺陷机制：消息正文由 marked 渲染成 <a href="https://…">（不带 target）。点击这种锚点
 * 的默认行为是「当前窗口导航」——浏览器 / WebGate 直连模式下没有桌面壳的 on_navigation
 * 守卫，当前标签会被外部网页整个替换。app-ui.js 的 EXTERNAL-LINK-GUARD 在 document
 * capture 阶段统一 preventDefault + window.open('_blank')，桌面壳的 on_new_window 会把
 * 它交给系统浏览器，浏览器端则开新标签，应用页面始终保留。
 *
 * 本测试把守卫代码块从三份同源 UI 里各自抽出，用最小 DOM 桩真实执行 handler，
 * 断言「该拦的拦、不该拦的放行」，并覆盖多份源码的同步性（防单点漏改）。
 *
 * 【为什么 UI_FILES 只有两份】gourd-ai-tauri/ui/js/app-ui.js 被 .gitignore 忽略
 * （/gourd-ai-tauri/ 整目录），是 gourdai-java/gourd-ai-tauri/cmd/prepare-ui.js
 * 打包期从 static 源拷出的构建产物，干净 clone / CI 上根本不存在。若把它列进
 * UI_FILES 并直接 readFileSync，test:js 在任何干净 checkout 上都会 ENOENT 红灯
 * ——测试自己成了不可复现的假失败。故只断言两份 tracked 源，构建产物改为
 * 机会性校验：存在时比对同步性，不存在时跳过。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..', '..');
const UI_FILES = [
    'gourd-work/desktop/ui/js/app-ui.js',
    'gourdai-java/gourd-ai-agent/src/main/resources/static/js/app-ui.js',
];
// 构建期镜像：非版本库文件，存在才校验（见文件头说明）。
const OPTIONAL_MIRROR = 'gourd-ai-tauri/ui/js/app-ui.js';
const START = '/*EXTERNAL-LINK-GUARD-START*/';
const END = '/*EXTERNAL-LINK-GUARD-END*/';

function guardBlockOf(rel) {
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, '');
    const i = raw.indexOf(START);
    const j = raw.indexOf(END);
    assert.ok(i >= 0, rel + ' 缺少 EXTERNAL-LINK-GUARD-START');
    assert.ok(j > i, rel + ' 缺少 EXTERNAL-LINK-GUARD-END');
    return raw.substring(i, j + END.length);
}

/* 用最小 DOM 桩执行守卫，返回注册的 handler 与 window.open 调用记录。 */
function loadGuard(block) {
    const opens = [];
    let handler = null;
    let capture = null;
    const sandbox = {
        window: {
            location: { hostname: 'gwork.local' },
            open(url, target, features) {
                opens.push({ url, target, features });
                return null;
            },
        },
        document: {
            addEventListener(type, fn, cap) {
                if (type === 'click') { handler = fn; capture = cap; }
            },
        },
        console,
    };
    vm.runInNewContext(block, sandbox, { timeout: 2000 });
    return { opens, handler, capture };
}

/* 构造一个满足守卫读取面的 <a> 桩（protocol/hostname/getAttribute/hasAttribute）。 */
function anchor(href, opts) {
    opts = opts || {};
    let u = null;
    try { u = new URL(href, 'https://gwork.local/app/index.html'); } catch (e) { /* 非法 URL 保留原串 */ }
    const attrs = {};
    if (Object.prototype.hasOwnProperty.call(opts, 'target')) attrs.target = opts.target;
    return {
        href: u ? u.href : href,
        protocol: u ? u.protocol : '',
        hostname: u ? u.hostname : '',
        getAttribute(n) { return (n === 'target' && 'target' in attrs) ? attrs.target : null; },
        hasAttribute(n) { return n === 'download' ? !!opts.download : false; },
    };
}

function fire(g, a, evOpts) {
    g.opens.length = 0;
    evOpts = evOpts || {};
    const ev = {
        defaultPrevented: !!evOpts.defaultPrevented,
        button: evOpts.button === undefined ? 0 : evOpts.button,
        ctrlKey: !!evOpts.ctrlKey,
        shiftKey: !!evOpts.shiftKey,
        altKey: !!evOpts.altKey,
        metaKey: !!evOpts.metaKey,
        target: {
            closest(sel) { return sel === 'a[href]' ? a : null; },
        },
        preventDefault() { this.defaultPrevented = true; },
    };
    if (a === null) ev.target.closest = () => null;
    g.handler(ev);
    return { prevented: ev.defaultPrevented, opens: g.opens.slice() };
}

test('两份 tracked 同源 UI 都含外链守卫且代码块完全一致', () => {
    const blocks = UI_FILES.map(guardBlockOf);
    for (let i = 1; i < blocks.length; i++) {
        assert.strictEqual(
            blocks[i].replace(/\r\n/g, '\n'), blocks[0].replace(/\r\n/g, '\n'),
            UI_FILES[i] + ' 的守卫块与 desktop 版漂移'
        );
    }
});

test('构建期镜像（被 .gitignore 忽略）：存在时须与源同步，不存在则跳过', () => {
    const abs = path.join(ROOT, OPTIONAL_MIRROR);
    if (!fs.existsSync(abs)) return; // 干净 checkout / CI 上没有该文件，属正常
    const mirror = guardBlockOf(OPTIONAL_MIRROR).replace(/\r\n/g, '\n');
    const source = guardBlockOf(UI_FILES[0]).replace(/\r\n/g, '\n');
    assert.strictEqual(mirror, source, OPTIONAL_MIRROR + ' 与 tracked 源漂移（重跑 prepare-ui.js）');
});

for (const rel of UI_FILES) {
    const g = loadGuard(guardBlockOf(rel));
    const tag = '[' + rel + '] ';

    test(tag + '注册在 capture 阶段（先于业务 click，杜绝被 stopPropagation 绕过）', () => {
        assert.strictEqual(typeof g.handler, 'function', '未注册 click handler');
        assert.strictEqual(g.capture, true, '必须是 capture=true');
    });

    test(tag + '外部 http(s) 链接：preventDefault + window.open(_blank, noopener)', () => {
        for (const href of [
            'https://github.com/tauri-apps/tauri',
            'http://example.com/',
            'https://www.gourdwork.com/',
            'https://evil.com/?q=tauri.localhost',
            'https://tauri.localhost.evil.com/', // 后缀伪装域名必须当外部
        ]) {
            const r = fire(g, anchor(href));
            assert.strictEqual(r.prevented, true, href + ' 必须掐断应用内导航');
            assert.strictEqual(r.opens.length, 1, href + ' 必须恰好打开一次外部窗口');
            assert.strictEqual(r.opens[0].target, '_blank', href + ' 目标须为 _blank');
            assert.match(String(r.opens[0].features), /noopener/, href + ' 须带 noopener');
        }
    });

    test(tag + '内部/同源/回环/壳自定义源一律放行（不能误伤）', () => {
        for (const href of [
            'https://gwork.local/page',          // 同源
            '/js/app-ui.js',                      // 相对链接
            '#section',                          // 页内锚点
            'mailto:a@b.c',
            'javascript:void(0)',
            'file:///C:/Windows/explorer.exe',
            'data:text/html,<p>x',
            'blob:abc123',
            'http://localhost:8080/',
            'http://127.0.0.1:49713/chat',       // 内核随机端口
            'http://[::1]:5173/',
            'http://tauri.localhost/',
            'https://x.tauri.localhost/index.html',
        ]) {
            const r = fire(g, anchor(href));
            assert.strictEqual(r.prevented, false, href + ' 不应被拦截');
            assert.strictEqual(r.opens.length, 0, href + ' 不应打开外部窗口');
        }
    });

    test(tag + '只有 target=_blank 放行；_self/_top/_parent/命名窗口一律接管', () => {
        // marked 未开 sanitize，消息正文允许 raw HTML，可注入 <a target="_top"> 之类链接；
        // 无父框架时这些 target 都等价于当前窗口导航，必须掐断。
        const blank = fire(g, anchor('https://www.gourdwork.com/', { target: '_blank' }));
        assert.strictEqual(blank.prevented, false, '_blank 沿用既有链路');
        assert.strictEqual(blank.opens.length, 0);
        for (const tgt of [undefined, '_self', '_top', '_parent', 'namedWindow', '_BLANK']) {
            const r = fire(g, anchor('https://www.gourdwork.com/', { target: tgt }));
            if (tgt === '_BLANK') {
                assert.strictEqual(r.prevented, false, 'target 大小写不敏感，_BLANK 也应放行');
                continue;
            }
            assert.strictEqual(r.prevented, true, 'target=' + String(tgt) + ' 仍须防止应用内导航');
            assert.strictEqual(r.opens.length, 1, 'target=' + String(tgt) + ' 必须打开一次外部窗口');
        }
    });

    test(tag + 'download / 非主键 / 修饰键 / 已默认阻止 / 非链接元素：全部放行', () => {
        assert.strictEqual(fire(g, anchor('https://example.com/f.zip', { download: true })).prevented, false);
        assert.strictEqual(fire(g, anchor('https://example.com/'), { button: 2 }).prevented, false);
        // 修饰键点击交浏览器原生语义（后台新标签/新窗口），本就不会替换当前页；
        // 也让 window.open 免于被 popup blocker 拦成「点了没反应」。
        for (const opts of [{ ctrlKey: true }, { shiftKey: true }, { altKey: true }, { metaKey: true }]) {
            const r = fire(g, anchor('https://example.com/'), opts);
            assert.strictEqual(r.prevented, false, JSON.stringify(opts) + ' 不应被拦截');
            assert.strictEqual(r.opens.length, 0, JSON.stringify(opts) + ' 不应打开外部窗口');
        }
        // 业务层已 preventDefault 的场景：守卫按设计早退，不应再重复 window.open。
        // 注意此事件桩的 defaultPrevented 本就是 true，断言该字段无意义，应断言 opens 为空。
        const already = fire(g, anchor('https://example.com/'), { defaultPrevented: true });
        assert.strictEqual(already.opens.length, 0, '已默认阻止的点击不应再打开外部窗口');
        const r = fire(g, null);
        assert.strictEqual(r.prevented, false);
        assert.strictEqual(r.opens.length, 0);
    });

    test(tag + '守卫源码不含任何应用内导航回退（location 赋值等）', () => {
        const block = guardBlockOf(rel);
        assert.doesNotMatch(block, /location\s*\.\s*(href|assign|replace)\s*=/, '禁止退回应用内导航');
        assert.match(block, /preventDefault\(\)/, '必须显式 preventDefault');
        assert.match(block, /window\.open\([^)]*_blank/, '必须走 window.open(_blank)');
    });
}
