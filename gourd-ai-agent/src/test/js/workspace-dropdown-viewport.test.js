/**
 * 契约测试：Chat 欢迎页「选择项目」下拉的视口自适应定位。
 *
 * 背景（用户实测）：「项目一多」，.project-dropdown 撑满 max-height:340px、固定向下展开，
 * 窗口矮时弹窗底部越出窗口，被 body{overflow:hidden} 裁剪——弹窗自身滚动也无法把
 * 底部「打开文件夹」/末尾项目带入可视区（headless 实测 vh=503：越界 141px，
 * 滚动到底后按钮仍完全在窗口外，不可见不可点）。
 *
 * 修复：app-workspace.js 新增 positionDropdown —— 打开与 resize 时动态限制 max-height，
 * 下方空间不足且上方更宽裕时切换 drop-up 向上展开（code.css 配套定位规则）。
 *
 * 修复2（用户二次实测）：旧翻转门槛「下方<160px」过苛——欢迎页输入框在窗口中下部，
 * 下方常余 200~300px（够不到设计高度 340 却又超过 160）→ 永不翻转，弹窗被塞进窗口
 * 底部窄带贴边裁切、上方大片空白浪费。门槛改为与设计高度比较：
 * below < DESIGN_MAX 且 above >= below 即向上展开。
 * 修复3（codereview 实查）：裁剪边界不是视口而是宿主盒——弹窗是 .welcome-view
 * （overflow-y:auto）后代，向上越出其盒顶即不可达（滚动容器上方溢出不可滚），
 * 桌面端盒顶还被 36px 标题栏下推；按视口算 above 会多算 36px → 向上态顶部被裁。
 * 边界改取 closest('.welcome-view') 盒顶/盒底，无宿主（会话模式）退化为视口。
 *
 * 覆盖：
 * - app-workspace.js：函数存在、打开逻辑接线（先定位后渲染）、drop-up 切换、resize 重定位
 * - code.css：.project-selector.drop-up .project-dropdown 向上展开规则
 * - 行为：提取真实函数源码沙箱执行 —— 截图实测场景 / 翻转 / 下方放得下不翻 / 上方更窄不翻 / 平局偏好向上 / 保底 / 封顶
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const ws = readStatic('js', 'app-workspace.js');
const codeCss = readStatic('css', 'code.css');

function sliceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `未找到起始标记: ${startMarker}`);
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, `未找到结束标记: ${endMarker}`);
    return source.slice(start, end);
}

/* —— 沙箱：提取真实 positionDropdown 源码执行（mock classList / querySelector / window）—— */
const fnSrc = sliceBetween(ws, 'function positionDropdown(selEl)', '/* 窗口尺寸变化');

/* host：{top,bottom} 模拟 .welcome-view 宿主盒（undefined = 无滚动容器祖先，边界退化为视口） */
function runCase(vh, rectTop, rectBottom, host) {
    const toggles = [];
    const dd = { style: {} };
    const sel = {
        classList: { toggle(name, force) { toggles.push({ name, force }); } },
        querySelector(sub) {
            if (sub === '.workspace-selector-current') return { getBoundingClientRect: () => ({ top: rectTop, bottom: rectBottom }) };
            if (sub === '.workspace-dropdown') return dd;
            return null;
        },
        closest(s) {
            if (s !== '.welcome-view') return null;
            return host ? { getBoundingClientRect: () => ({ top: host.top, bottom: host.bottom }) } : null;
        }
    };
    const fn = new Function('window', fnSrc + '\nreturn positionDropdown;')({ innerHeight: vh });
    fn(sel);
    return { maxHeight: dd.style.maxHeight, dropUp: toggles.some(t => t.name === 'drop-up' && t.force === true) };
}

test('app-workspace.js：positionDropdown 定义并接入打开逻辑（先定位、后渲染内容）', () => {
    assert.match(ws, /function positionDropdown\(selEl\)/);
    assert.match(ws, /if \(!cur \|\| !dd\) return;/);
    assert.match(ws, /classList\.toggle\('drop-up', openUp\)/);
    const openBlock = sliceBetween(ws, 'if (!wasOpen) {', 'e.stopPropagation();');
    assert.match(openBlock, /positionDropdown\(selEl\);/);
    const i1 = openBlock.indexOf('positionDropdown(selEl);');
    const i2 = openBlock.indexOf('renderDropdown(');
    assert.ok(i1 >= 0 && i2 > i1, '应先调用 positionDropdown 再 renderDropdown');
});

test('app-workspace.js：resize 时对已打开的下拉重新定位', () => {
    const resize = sliceBetween(ws, "window.addEventListener('resize'", 'function renderDropdown');
    assert.match(resize, /querySelectorAll\('\.workspace-selector\.open'\)/);
    assert.match(resize, /positionDropdown\(sels\[i\]\)/);
});

test('code.css：drop-up 向上展开规则（锚定按钮上缘）', () => {
    assert.match(codeCss, /\.project-selector\.drop-up \.project-dropdown \{ top: auto; bottom: 100%; margin-top: 0; margin-bottom: 4px; \}/);
});

test('行为・用户截图实测复现：vh=563 按钮 bottom=330（下方余 221 放不下 340、上方 285 更宽裕）→ 向上展开', () => {
    const r = runCase(563, 297, 330);
    assert.equal(r.dropUp, true);
    assert.equal(r.maxHeight, '285px');
});

test('行为・旧门槛盲区：下方 191px（>旧 MIN_BELOW 160 但 <340）且上方更宽裕 → 必须向上（旧逻辑在此永不翻转）', () => {
    const r = runCase(503, 267, 300);
    assert.equal(r.dropUp, true);
    assert.equal(r.maxHeight, '255px');
});

test('行为・极矮窗口：下方不足且上方更宽裕 → 向上展开（drop-up），高度取上方空间', () => {
    const r = runCase(353, 249, 282);
    assert.equal(r.dropUp, true);
    assert.equal(r.maxHeight, '237px');
});

test('行为・上下均不足且上方更窄：维持向下、按下方空间限制', () => {
    const r = runCase(300, 100, 130);
    assert.equal(r.dropUp, false);
    assert.equal(r.maxHeight, '158px');
});

test('行为・下方放不下设计高度但上方更窄：维持向下（不为了翻转而翻转）', () => {
    const r = runCase(600, 60, 300);
    assert.equal(r.dropUp, false);
    assert.equal(r.maxHeight, '288px');
});

test('行为・上下平局且均放不下设计高度：偏好向上（上方空白更整）', () => {
    const r = runCase(330, 50, 280);
    assert.equal(r.dropUp, true);
    assert.equal(r.maxHeight, '80px');
});

test('行为・下方放得下设计高度（即使上方更宽裕）：维持向下，符合下拉直觉', () => {
    const r = runCase(1000, 500, 530);
    assert.equal(r.dropUp, false);
    assert.equal(r.maxHeight, '340px');
});

test('行为・宽裕窗口：不超过设计上限 340px', () => {
    const r = runCase(1000, 100, 130);
    assert.equal(r.dropUp, false);
    assert.equal(r.maxHeight, '340px');
});

test('行为・桌面端宿主盒：welcome 顶被标题栏下推 36px，向上限高按盒顶算（249 而非视口口径 285）', () => {
    const r = runCase(563, 297, 330, { top: 36, bottom: 563 });
    assert.equal(r.dropUp, true);
    assert.equal(r.maxHeight, '249px');
});

test('行为・宿主盒顶下推后上方仍更宽裕：向上且限高扣掉标题栏（252 而非视口口径 288）', () => {
    const r = runCase(400, 300, 330, { top: 36, bottom: 400 });
    assert.equal(r.dropUp, true);
    assert.equal(r.maxHeight, '252px');
});

test('行为・宿主盒顶下推后上方反比下方窄：维持向下（视口口径会误翻向上）', () => {
    const r = runCase(600, 300, 330, { top: 36, bottom: 600 });
    assert.equal(r.dropUp, false);
    assert.equal(r.maxHeight, '258px');
});
