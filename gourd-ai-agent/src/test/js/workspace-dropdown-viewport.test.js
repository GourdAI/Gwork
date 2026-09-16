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
 * 覆盖：
 * - app-workspace.js：函数存在、打开逻辑接线（先定位后渲染）、drop-up 切换、resize 重定位
 * - code.css：.project-selector.drop-up .project-dropdown 向上展开规则
 * - 行为：提取真实函数源码沙箱执行 —— 用户实测场景 / 翻转 / 双不足 / 保底 / 封顶
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

function runCase(vh, rectTop, rectBottom) {
    const toggles = [];
    const dd = { style: {} };
    const sel = {
        classList: { toggle(name, force) { toggles.push({ name, force }); } },
        querySelector(sub) {
            if (sub === '.workspace-selector-current') return { getBoundingClientRect: () => ({ top: rectTop, bottom: rectBottom }) };
            if (sub === '.workspace-dropdown') return dd;
            return null;
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

test('行为・用户实测复现：vh=503（原越界 141px 的窗口）→ 向下受限为 191px', () => {
    const r = runCase(503, 267, 300);
    assert.equal(r.dropUp, false);
    assert.equal(r.maxHeight, '191px');
});

test('行为・极矮窗口：下方不足且上方更宽裕 → 向上展开（drop-up），高度取上方空间', () => {
    const r = runCase(353, 249, 282);
    assert.equal(r.dropUp, true);
    assert.equal(r.maxHeight, '237px');
});

test('行为・上下均不足且上方不占优：维持向下、按下方空间限制', () => {
    const r = runCase(300, 100, 130);
    assert.equal(r.dropUp, false);
    assert.equal(r.maxHeight, '158px');
});

test('行为・极端窗口保底：可用空间过小不低于 80px', () => {
    const r = runCase(330, 50, 280);
    assert.equal(r.dropUp, false);
    assert.equal(r.maxHeight, '80px');
});

test('行为・宽裕窗口：不超过设计上限 340px', () => {
    const r = runCase(1000, 100, 130);
    assert.equal(r.dropUp, false);
    assert.equal(r.maxHeight, '340px');
});
