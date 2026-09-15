/**
 * 契约测试：侧栏「展开全部/收起全部」按钮状态感知（方案 A）。
 *
 * 覆盖：
 * - index.html：#expandAllBtn 双态图标（expand-all-icon / collapse-all-icon），初始隐藏避免闪错态
 * - app-history.js：updateExpandAllBtn 按项目树状态翻转图标与提示（collapse-mode + i18n key 切换）；
 *   对话 tab / code 模式 / 空项目列表时隐藏；点击、单项目开合、tab 切换、列表重载、语言切换均刷新
 * - app.css：双态图标显隐规则
 * - 12 个语言包均提供 app.sidebar.collapse_all 且 JSON 合法、行尾无裸 LF
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const history = readStatic('js', 'app-history.js');
const indexHtml = readStatic('index.html');
const appCss = readStatic('css', 'app.css');

const LOCALES = ['de', 'el', 'en', 'es', 'fr', 'ja', 'pt', 'ro', 'ru', 'vi', 'zh-CN', 'zh-TW'];

function sliceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `未找到起始标记: ${startMarker}`);
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, `未找到结束标记: ${endMarker}`);
    return source.slice(start, end);
}

test('index.html：按钮含双态图标与初始隐藏（JS 就绪前不闪错态）', () => {
    const btn = sliceBetween(indexHtml, 'id="expandAllBtn"', 'id="filterListBtn"');
    assert.match(btn, /data-i18n-title="app\.sidebar\.expand_all"/);
    assert.match(btn, /style="display:none;"/);
    assert.match(btn, /class="expand-all-icon"/);
    assert.match(btn, /class="collapse-all-icon"/);
});

test('app-history.js：updateExpandAllBtn 按状态翻转图标/提示，并收敛不可用场景', () => {
    const fn = sliceBetween(history, 'function updateExpandAllBtn()', '/* tab 切换委托');
    assert.match(fn, /document\.getElementById\('expandAllBtn'\)/);
    assert.match(fn, /window\.appMode !== 'code'/);
    assert.match(fn, /effectiveHistoryScope\(\) === 'project'/);
    assert.match(fn, /ps\.length > 0/);
    assert.match(fn, /btn\.style\.display = 'none'/);
    assert.match(fn, /btn\.style\.display = ''/);
    assert.match(fn, /classList\.toggle\('collapse-mode', allExpanded\)/);
    assert.match(fn, /'app\.sidebar\.collapse_all'/);
    assert.match(fn, /'app\.sidebar\.expand_all'/);
    assert.match(fn, /setAttribute\('data-i18n-title', key\)/);
});

test('app-history.js：点击/单项目开合/新建任务/列表重载/语言切换均刷新按钮', () => {
    const scopeBar = sliceBetween(history, 'function updateHistoryScopeBar()', 'function anyProjectCollapsed()');
    assert.match(scopeBar, /updateExpandAllBtn\(\);/);
    const ui = sliceBetween(history, 'function updateHistoryUI()', 'function sortSidebarEntries');
    assert.match(ui, /updateExpandAllBtn\(\);/);
    const click = sliceBetween(history, "on('click', '#expandAllBtn'", "on('click', '#clearAllBtn'");
    assert.match(click, /anyProjectCollapsed\(\)/);
    assert.match(click, /updateHistoryUI\(\);/);
    assert.doesNotMatch(click, /var anyCollapsed = false/, '点击处理不应重复维护判定逻辑（应复用 anyProjectCollapsed）');
    const i18n = sliceBetween(history, "document.addEventListener('i18n:localeChanged'", "initModelSelector('chatModelSelector'");
    assert.match(i18n, /updateHistoryUI\(\);/);
    assert.match(i18n, /updateHistoryScopeBar\(\);/);
});

test('app.css：双态图标显隐规则（默认显示展开图标，collapse-mode 切到收拢图标）', () => {
    assert.match(appCss, /#expandAllBtn \.collapse-all-icon \{ display: none; \}/);
    assert.match(appCss, /#expandAllBtn\.collapse-mode \.expand-all-icon \{ display: none; \}/);
    assert.match(appCss, /#expandAllBtn\.collapse-mode \.collapse-all-icon \{ display: block; \}/);
});

test('12 个语言包均提供 app.sidebar.collapse_all（JSON 合法、行尾无裸 LF）', () => {
    for (const lang of LOCALES) {
        const raw = readStatic('locales', `${lang}.json`);
        const json = JSON.parse(raw);
        assert.equal(typeof json.app.sidebar.expand_all, 'string', `${lang} 缺少 app.sidebar.expand_all`);
        assert.equal(typeof json.app.sidebar.collapse_all, 'string', `${lang} 缺少 app.sidebar.collapse_all`);
        assert.ok(json.app.sidebar.collapse_all.trim().length > 0, `${lang} 的 collapse_all 为空`);
        const latin = fs.readFileSync(path.join(staticRoot, 'locales', `${lang}.json`), 'latin1');
        const loneLf = latin.split('\n').filter((line, i, arr) => i < arr.length - 1 && !line.endsWith('\r')).length;
        assert.equal(loneLf, 0, `${lang}.json 存在裸 LF 行，行尾被破坏`);
    }
});
