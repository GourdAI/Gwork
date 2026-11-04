/**
 * 不变量测试：DOM 属性形态的 API 地址必须经 kernel-bridge 的 helper 取绝对地址。
 *
 * ── 这个不变量为什么存在 ──────────────────────────────────────────────────
 * 桌面壳（Tauri）用 asset 协议托管前端，页面源是 http://tauri.localhost，而
 * Rust 内核在 http://127.0.0.1:<随机端口>。kernel-bridge.js 改写了
 * fetch / XMLHttpRequest / WebSocket 三层，但 **DOM 属性形态**的地址
 * （`<img src>`、`<iframe src>`、`<audio src>`、`<video src>`、`<a href>`、
 * `<form action>`）不经过这三层，浏览器直接按页面源解析 → 落到 SPA fallback
 * → 拿回 200 + index.html。
 *
 * 后果按资源类型不同，但都是静默的：
 *   · 图片  → 解码失败，onerror 移除元素，图标永远只剩首字母底；
 *   · PDF   → iframe 里套娃渲染整个应用；
 *   · 音视频 → 不播放，且无报错。
 *
 * 2026-10-28 用户报「技能图片未展示」即此根因（技能图标）；同批排查发现
 * 代码预览（app-code.js rawUrl，四种预览类型共用）是同一缺陷的另一处表现。
 *
 * ── 为什么是「全 UI 扫描」而不是逐处断言 ──────────────────────────────────
 * 逐处断言只能锁住已知的两个调用点，未来任何新写的 `<img src="/web/...">`
 * 都会静默复发。这里改为扫描整个 UI 目录：**任何** JS/HTML 里出现「DOM 属性
 * = /web/ 开头的字面量」都判失败，逼新代码走 helper。
 *
 * 例外白名单只有 kernel-bridge.js 自身（它的文档注释里必须写这个形态来说明
 * 问题）与测试文件本身。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const uiRoot = path.resolve(__dirname, '../ui');

/** 递归收集 UI 目录下的 js/html 文件（跳过第三方库目录）。 */
function collectFiles(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            // monaco / layui / highlight 是第三方产物，不含本项目 API 调用。
            if (['monaco', 'layui', 'highlight'].includes(e.name)) continue;
            collectFiles(p, out);
        } else if (/\.(js|html)$/.test(e.name)) {
            out.push(p);
        }
    }
    return out;
}

/** 去掉注释行，避免文档里的示例形态造成假红。 */
function codeLines(src) {
    return src
        .split('\n')
        .map((line, i) => ({ no: i + 1, text: line }))
        .filter(({ text }) => {
            const t = text.trim();
            return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('<!--');
        });
}

/**
 * DOM 属性形态的 API 地址：属性名 = 引号 + /web/ 开头。
 * 覆盖 src / href / poster / action / data（HTML 与 JS 字符串拼接两种写法）。
 */
const DOM_ATTR_API = /(?:\bsrc|\bhref|\bposter|\baction|\bdata)\s*=\s*(["'`])\s*\/web\//;

test('全 UI 不存在裸相对路径的 DOM 属性 API 地址', () => {
    const offenders = [];
    for (const file of collectFiles(uiRoot)) {
        const rel = path.relative(uiRoot, file).replace(/\\/g, '/');
        // bridge 自身的文档注释需要写这个形态来解释问题。
        if (rel === 'js/kernel-bridge.js') continue;
        const src = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        for (const { no, text } of codeLines(src)) {
            if (DOM_ATTR_API.test(text)) {
                offenders.push(`${rel}:${no}: ${text.trim().slice(0, 120)}`);
            }
        }
    }
    assert.deepEqual(
        offenders,
        [],
        'DOM 属性形态的 API 地址必须经 window.__gworkApiUrl 取内核绝对地址，' +
            '否则桌面壳下会落到 tauri.localhost 的 SPA fallback：\n' +
            offenders.join('\n')
    );
});

test('kernel-bridge 暴露同步 helper（DOM 属性形态的唯一出路）', () => {
    const src = fs.readFileSync(path.join(uiRoot, 'js', 'kernel-bridge.js'), 'utf8');
    assert.ok(
        src.includes('window.__gworkApiUrl = function'),
        'bridge 必须暴露 __gworkApiUrl；DOM 属性不经过 fetch/XHR/WS，没有同步 helper 就无法改写'
    );
    // helper 必须复用 rewriteUrl，否则两套口径会漂移。
    const tail = src.slice(src.indexOf('window.__gworkApiUrl = function'));
    assert.ok(tail.slice(0, 200).includes('rewriteUrl(path)'), 'helper 必须复用 rewriteUrl');
});

test('代码预览（四种类型共用 rawUrl）经 helper 取绝对地址', () => {
    const src = fs
        .readFileSync(path.join(uiRoot, 'js', 'app-code.js'), 'utf8')
        .replace(/^\uFEFF/, '');
    const at = src.indexOf('function rawUrl(');
    assert.ok(at > -1, 'rawUrl 必须存在');
    const body = src.slice(at, src.indexOf('\n    }', at));
    assert.ok(body.includes('/web/chat/filer/raw?path='), body);
    assert.ok(body.includes('window.__gworkApiUrl'), 'rawUrl 必须经 helper 改写');
    assert.ok(
        /typeof window\.__gworkApiUrl === 'function'/.test(body),
        '必须做存在性判断，浏览器模式才能兜底相对路径'
    );
});

test('技能图标（卡片 + 详情弹窗）经 helper 取绝对地址', () => {
    const src = fs
        .readFileSync(path.join(uiRoot, 'js', 'app-skills.js'), 'utf8')
        .replace(/^\uFEFF/, '');
    const at = src.indexOf('function iconSrc(');
    assert.ok(at > -1, 'iconSrc 必须存在');
    const body = src.slice(at, src.indexOf('\n    }', at));
    assert.ok(body.includes('/web/settings/skills/icon?url='), body);
    assert.ok(body.includes('window.__gworkApiUrl'), 'iconSrc 必须经 helper 改写');
    // 两处调用点：iconHtml（卡片）与详情弹窗。
    const uses = src.split('iconSrc(').length - 1;
    assert.ok(uses >= 3, `iconSrc 至少要有定义与两处调用，实际 ${uses} 次`);
});
