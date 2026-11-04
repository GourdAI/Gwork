/**
 * 已安装徽标判定：pure-function 级契约。
 *
 * 分层原则（本仓教训）：DOM 级行为已由浏览器实测矩阵覆盖
 * （.tmp/browser_badge_matrix.js：A旧裸唯一 / B旧裸歧义 / C限定精确 / D未安装，18/18）。
 * 这里只测能脱离 DOM 精确断言的判定逻辑 + 源码接线，**不再手写 DOM/jQuery 桩**
 * ——桩不保真会让缺陷以「桩报错/桩丢内容」的假象出现，比没有测试更误导。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS_PATH = path.resolve(__dirname, '../../main/resources/static/js/app-skills.js');
const SRC = fs.readFileSync(JS_PATH, 'utf8');

/** 提取含函数头的完整函数声明（body-only 版本驱动执行会 ReferenceError） */
function extractFunctionFull(source, name) {
    const start = source.indexOf('function ' + name + '(');
    assert.notStrictEqual(start, -1, '未找到函数 ' + name);
    let i = source.indexOf('{', start);
    assert.notStrictEqual(i, -1, name + ' 缺少函数体');
    let depth = 0;
    let inS = null, inLine = false, inBlock = false, esc = false;
    for (let p = i; p < source.length; p++) {
        const ch = source[p], nx = source[p + 1];
        if (inLine) { if (ch === '\n') inLine = false; continue; }
        if (inBlock) { if (ch === '*' && nx === '/') { inBlock = false; p++; } continue; }
        if (inS) {
            if (esc) { esc = false; continue; }
            if (ch === '\\') { esc = true; continue; }
            if (ch === inS) inS = null;
            continue;
        }
        if (ch === '/' && nx === '/') { inLine = true; p++; continue; }
        if (ch === '/' && nx === '*') { inBlock = true; p++; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { inS = ch; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return source.slice(start, p + 1); }
    }
    throw new Error(name + ' 函数体未闭合');
}

/** 在干净上下文里运行判定函数（只依赖 _installedIndex，不碰 DOM） */
function makeJudge(installed) {
    const index = {};
    installed.forEach(s => {
        index['name:' + s.name] = s;
        if (s.market && s.marketSlug) index['market:' + s.market + '|' + s.marketSlug] = s;
    });
    const sandbox = { console, String, _installedIndex: index };
    vm.createContext(sandbox);
    vm.runInContext(extractFunctionFull(SRC, 'findInstalledForMarket')
        + '\n' + extractFunctionFull(SRC, 'marketBareSlug')
        + '\nthis.__find = findInstalledForMarket; this.__bare = marketBareSlug;', sandbox);
    return {
        find: (market, slug, allowLegacy) => sandbox.__find(market, slug, allowLegacy),
        bare: (slug) => sandbox.__bare(slug)
    };
}

const BARE = { name: 'dev-expert', market: 'skillhub.cn', marketSlug: 'dev-expert' };
const QUALIFIED_B = { name: '_b_dev-expert', market: 'skillhub.cn', marketSlug: '@b/dev-expert' };

test('限定卡：元数据精确匹配（不带任何人肉回退）', () => {
    const j = makeJudge([QUALIFIED_B]);
    const hit = j.find('skillhub.cn', '@b/dev-expert', false);
    assert.ok(hit, '元数据逐字匹配必须命中');
    assert.strictEqual(hit.name, '_b_dev-expert');
});

test('限定卡：目录名形态（@ 与 / → _）也认，与后端 installDirName 同口径', () => {
    const j = makeJudge([{ name: '_b_dev-expert', market: '', marketSlug: '' }]);
    // 无 market 元数据（旧目录只有裸名的情况之外，还有一种：目录名是限定形态但元数据缺失）
    assert.ok(j.find('skillhub.cn', '@b/dev-expert', false), '目录名形态必须能认领');
});

test('误亮根除：裸 slug 安装记录不得在 allowLegacyBare=false 时点亮限定卡', () => {
    const j = makeJudge([BARE]);
    assert.strictEqual(j.find('skillhub.cn', '@a/dev-expert', false), null,
        '这就是用户报的 bug：装了一家，另一家跟着亮');
    assert.strictEqual(j.find('skillhub.cn', '@b/dev-expert', false), null,
        '歧义时任何一家都不能亮（无法确定装的是谁）');
});

test('旧安装认领：裸 slug 记录在唯一时可被限定卡认领（否则老用户集体漏亮）', () => {
    const j = makeJudge([BARE]);
    const hit = j.find('skillhub.cn', '@a/dev-expert', true);
    assert.ok(hit, '裸名唯一时旧安装必须能被认领，否则老用户市场页永远没有已安装标记');
    assert.strictEqual(hit.name, 'dev-expert');
});

test('裸 slug 形态卡：行为与改动前一致（历史目录不迁移）', () => {
    const j = makeJudge([{ name: 'agent-browser', market: 'skillhub.cn', marketSlug: 'agent-browser' }]);
    assert.ok(j.find('skillhub.cn', 'agent-browser', false), '裸 slug 精确匹配仍要命中');
});

test('marketBareSlug：@owner/s → s，裸 slug 原样', () => {
    const j = makeJudge([]);
    assert.strictEqual(j.bare('@a/dev-expert'), 'dev-expert');
    assert.strictEqual(j.bare('dev-expert'), 'dev-expert');
    assert.strictEqual(j.bare(''), '');
    assert.strictEqual(j.bare(null), '');
});

test('接线：索引刷新与渲染后都要重算徽标，且渲染必须传唯一性判定', () => {
    const n = (SRC.match(/syncInstalledBadges\(\);/g) || []).length;
    assert.ok(n >= 3, 'loadInstalledIndex 成功/失败 + renderMarketCards 都要重算，实际 ' + n + ' 处');
    assert.match(SRC, /findInstalledForMarket\(_currentView, slug, allowLegacyBare\)/,
        '卡片渲染必须把唯一性判定结果传进去');
    assert.match(SRC, /bareCounts\[marketBareSlug\(slug\)\] === 1/,
        '唯一性口径必须是「该裸 slug 在本列表恰好 1 张」');
});

test('接线：同步函数必须排除已安装视图的卡（它们本来就没有市场徽标）', () => {
    const start = SRC.indexOf('function syncInstalledBadges');
    assert.notStrictEqual(start, -1, 'syncInstalledBadges 必须存在');
    const body = extractFunctionFull(SRC, 'syncInstalledBadges');
    assert.ok(body.includes('.skill-card:not(.skill-card-installed)'),
        '必须排除已安装视图的卡，否则会凭空长出 + 按钮');
});
