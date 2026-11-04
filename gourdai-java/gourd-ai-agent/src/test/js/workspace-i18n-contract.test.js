/**
 * 契约测试：欢迎页工作空间下拉 i18n 键齐备（防「UI 裸露原始 key」回归）。
 *
 * 背景（用户实测截图缺陷）：app-workspace.js 的下拉渲染引用了
 *   app.chat_workspace.search_placeholder / search_no_results / remote_connect / locate_multiple
 * 四个键，但 12 个语言包的 app.chat_workspace 块只有 switch / clear 两个键。
 * GourdI18n.getMessage 取不到键时【原样返回 key 字符串】→ 下拉里直接显示
 * 「app.chat_workspace.search_placeholder」这类技术字面量。
 *
 * 本测试的核心防回归断言【从源码正则派生】，不硬编码键清单：
 * 扫 static/js/*.js + html 中全部 app.chat_workspace.* 字面量引用，
 * 断言每个引用键 ⊆ 每个语言包提供的键集 → 以后开发者新增引用键而漏配文案，
 * 12 个语言包哪个缺了哪条断言都会红，不会再出现裸 key 上线。
 *
 * 另锁定：12 语言包 chat_workspace 键集完全一致（防只补一种语言）、
 * JSON 合法、无 BOM、行尾无裸 LF（与 model-selector.test.js 同口径）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const LOCALES = ['de', 'el', 'en', 'es', 'fr', 'ja', 'pt', 'ro', 'ru', 'vi', 'zh-CN', 'zh-TW'];

function readStatic(...parts) {
    return fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
}

/* ── 1. 从源码派生引用键集（静态目录全部 js + html，不硬编码清单）────────── */
function collectUsedKeys() {
    const keys = new Map(); // key -> Set(files)
    const visit = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { visit(p); continue; }
            if (!/\.(js|html)$/.test(e.name)) continue;
            const src = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
            const rel = path.relative(staticRoot, p);
            const patterns = [
                /t\(\s*'app\.chat_workspace\.([a-z_]+)'\s*[,)]/g,          // t() / GourdI18n.t()：两段式匹配见下
                /data-i18n(?:-[a-z]+)?="app\.chat_workspace\.([a-z_]+)"/g,
            ];
            for (const re of patterns) {
                let m;
                while ((m = re.exec(src))) {
                    if (!keys.has(m[1])) keys.set(m[1], new Set());
                    keys.get(m[1]).add(rel);
                }
            }
            /* GourdI18n.t('…') 会被上面的 \bt( 覆盖（t 前是 . 时 \b 仍成立），无需单列 */
        }
    };
    visit(staticRoot);
    return keys;
}

test('源码存在 chat_workspace 引用（防测试空转：一条引用都没有时本测试即失效）', () => {
    const used = collectUsedKeys();
    assert.ok(used.size >= 6, `app.chat_workspace 引用键数量异常: ${[...used.keys()].join(',')}`);
    /* 截图缺陷涉及的两个键必须仍被引用（若重构改名，须同步语言包——本测试会强制红） */
    assert.ok(used.has('search_placeholder'), 'search_placeholder 引用消失？重构后请同步本测试');
    assert.ok(used.has('remote_connect'), 'remote_connect 引用消失？重构后请同步本测试');
});

test('核心契约：源码引用的每个 app.chat_workspace.* 键，12 个语言包必须全部提供（非空字符串）', () => {
    const used = collectUsedKeys();
    for (const lang of LOCALES) {
        const raw = readStatic('locales', `${lang}.json`);
        const json = JSON.parse(raw);
        const cw = json.app && json.app.chat_workspace;
        assert.ok(cw && typeof cw === 'object', `${lang}.json 缺少 app.chat_workspace 块`);
        for (const [key, files] of used) {
            assert.ok(
                typeof cw[key] === 'string' && cw[key].trim().length > 0,
                `${lang}.json 缺少 app.chat_workspace.${key}（引用自: ${[...files].join(', ')}）`
            );
        }
    }
});

test('12 语言包 chat_workspace 键集完全一致（防「只补一种语言」）', () => {
    const keySets = new Map();
    for (const lang of LOCALES) {
        const json = JSON.parse(readStatic('locales', `${lang}.json`));
        keySets.set(lang, Object.keys(json.app.chat_workspace).sort());
    }
    const [first, ...rest] = [...keySets.values()];
    for (const [lang, ks] of keySets) {
        assert.deepEqual(ks, first, `${lang}.json 的 chat_workspace 键集与其它语言包不一致`);
    }
});

test('12 语言包：JSON 合法、无 BOM、行尾无裸 LF（补键不得破坏行尾契约）', () => {
    for (const lang of LOCALES) {
        const file = path.join(staticRoot, 'locales', `${lang}.json`);
        const buf = fs.readFileSync(file);
        assert.ok(!(buf.slice(0, 3).toString('hex') === 'efbbbf'), `${lang}.json 不应带 BOM`);
        const latin = buf.toString('latin1');
        const lines = latin.split('\n');
        const loneLf = lines.filter((line, i) => i < lines.length - 1 && !line.endsWith('\r')).length;
        assert.equal(loneLf, 0, `${lang}.json 存在裸 LF 行（行尾契约被破坏）`);
        assert.doesNotThrow(() => JSON.parse(buf.toString('utf8')), `${lang}.json JSON 不合法`);
    }
});
