/**
 * 契约测试：Chat 欢迎页工作区下拉「可关闭」与「列表项单行化」。
 *
 * 背景（用户实测严重缺陷）：下拉打开后关不掉——点外部、再点按钮均无效。
 * 根因：DOM 上弹窗元素同时带 .project-dropdown 与 .workspace-dropdown 两个类；
 * code.css 中 `.project-dropdown { display:none }`（隐藏开关）与
 * `.workspace-dropdown { display:flex }`（新布局）特异性相同(0,1,0)，
 * 后者源序在后 → 无条件覆盖隐藏规则 → 下拉常显，.open 的增删不再影响可见性。
 * 修复：基础规则只写布局属性，display:flex 仅挂在
 * `.project-selector.open .workspace-dropdown`（与 `.open .project-dropdown`
 * 同特异性(0,2,0)且源序在后 → 打开时 flex 列布局真正生效）。
 *
 * 同期视觉修复（用户实测「搜索框小、选项大」）：列表项由双行（名称+整路径）
 * 改单行（文件夹图标+名称），路径挂 title 悬停查看，与搜索框同视觉量级。
 *
 * 覆盖：
 * - code.css：.workspace-dropdown 基础规则禁含 display（防回归核心断言）
 * - code.css：.project-selector.open .workspace-dropdown { display:flex } 存在
 *   且源序晚于 .project-selector.open .project-dropdown（同特异性靠源序取胜）
 * - code.css：单行条目配套规则（.workspace-dropdown .project-dropdown-item padding）
 * - app-workspace.js：renderFilteredList 不再输出双行路径子元素，改输出图标+title
 * - app-workspace.js：搜索框 Escape 关闭下拉
 * - app-workspace.js：focusout 延迟关闭（含 setTimeout 防系统对话框误关守卫）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const ws = readStatic('js', 'app-workspace.js');
const codeCss = readStatic('css', 'code.css');

/* 提取 CSS 规则块：从选择器起点到配对右花括号（本文件无嵌套规则） */
function ruleBlock(css, selectorText) {
    const i = css.indexOf(selectorText);
    assert.ok(i >= 0, `未找到选择器: ${selectorText}`);
    const open = css.indexOf('{', i);
    assert.ok(open > i, `选择器后无规则块: ${selectorText}`);
    let depth = 0;
    for (let j = open; j < css.length; j++) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') { depth--; if (depth === 0) return css.slice(open + 1, j); }
    }
    assert.fail(`规则块花括号不配平: ${selectorText}`);
}

test('code.css：.workspace-dropdown 基础规则不得含 display（关不掉的根因防回归）', () => {
    const body = ruleBlock(codeCss, '.workspace-dropdown {');
    assert.doesNotMatch(body, /(^|[^-a-z])display\s*:/,
        '基础规则含 display 会凭同特异性+源序在后覆盖 .project-dropdown 的 display:none → 下拉常显关不掉');
    // 布局属性仍须在（flex 列方向/内边距/溢出）
    assert.match(body, /flex-direction:\s*column/);
    assert.match(body, /overflow:\s*hidden/);
});

test('code.css：打开态 display:flex 挂在 .open 下，且源序晚于 .open .project-dropdown', () => {
    const openBody = ruleBlock(codeCss, '.project-selector.open .workspace-dropdown {');
    assert.match(openBody, /display:\s*flex/);
    const iBaseOpen = codeCss.indexOf('.project-selector.open .project-dropdown {');
    const iWsOpen = codeCss.indexOf('.project-selector.open .workspace-dropdown {');
    assert.ok(iBaseOpen >= 0, '.open .project-dropdown 显示开关规则须保留');
    assert.ok(iWsOpen > iBaseOpen,
        '同特异性(0,2,0)下靠源序取胜：workspace 打开规则必须晚于通用打开规则，否则打开时仍是 block、flex 列布局失效');
});

test('code.css：隐藏开关 .project-dropdown { display:none } 仍为首条显示规则', () => {
    const body = ruleBlock(codeCss, '.project-dropdown {');
    assert.match(body, /display:\s*none/);
});

test('code.css：单行条目配套规则（下拉内条目内边距收紧 + 图标色）', () => {
    const itemBody = ruleBlock(codeCss, '.workspace-dropdown .project-dropdown-item {');
    assert.match(itemBody, /padding:\s*6px 8px/);
    const iconBody = ruleBlock(codeCss, '.workspace-item-icon {');
    assert.match(iconBody, /flex-shrink:\s*0/);
});

test('app-workspace.js：列表项单行化——不再输出整路径子元素，路径改挂 title', () => {
    const render = ws.slice(ws.indexOf('function renderFilteredList'), ws.indexOf('/* ================= 系统原生文件夹选择'));
    assert.doesNotMatch(render, /project-dropdown-item-path/,
        '双行（名称+整路径）使条目高度约为搜索框两倍，比例失调');
    assert.match(render, /class="workspace-item-icon"/);
});

test('app-workspace.js：搜索框 Escape 关闭下拉', () => {
    const kd = ws.slice(ws.indexOf("document.addEventListener('keydown'"), ws.indexOf('/* 焦点离开下拉即关闭'));
    assert.match(kd, /workspace-search-input/);
    assert.match(kd, /e\.key === 'Escape'/);
    assert.match(kd, /closeAll\(\)/);
});

test('app-workspace.js：focusout 延迟关闭且带系统对话框误关守卫', () => {
    const fo = ws.slice(ws.indexOf("document.addEventListener('focusout'"), ws.indexOf('function boot()'));
    assert.match(fo, /closest\('\.workspace-selector'\)/);
    assert.match(fo, /setTimeout\(function \(\)/, '须延迟到焦点落定后再判定，否则点「打开文件夹」瞬间 blur 会误关');
    assert.match(fo, /sel\.contains\(document\.activeElement\)/, '焦点仍在下拉内（ Tab 到条目/按钮）不得关闭');
    assert.match(fo, /closeAll\(\)/);
});

test('app-workspace.js：删除按钮点击后下拉保持打开（ajax 完成恢复 open 再重渲染）', () => {
    /* 用户实测「点删除整个选择框关闭」：删除按钮是可聚焦 <button>，mousedown 聚焦它使
       搜索框 focusout，守卫在 ajax 返回前关下拉。修复：点击时记 open 态，
       ajax 完成后先复位选择（删的是当前项时 selectChatWorkspace 内部 closeAll）
       再恢复 open + 重渲染列表。 */
    const del = ws.slice(ws.indexOf("var del = t.closest('.workspace-dropdown .project-dropdown-item-del')"), ws.indexOf("var add = t.closest('.workspace-dropdown .workspace-add-btn')"));
    assert.match(del, /delWasOpen/, '点击时须记录打开态，供 ajax 回调恢复');
    assert.match(del, /delSel\.classList\.add\('open'\)/, 'ajax 完成后须恢复 open（删除≠做出选择，下拉不得关）');
    assert.match(del, /renderDropdown\(dd\)/, '恢复 open 后须重渲染列表以移除被删项');
    const iReset = del.indexOf("selectChatWorkspace('', true)");
    const iRestore = del.indexOf("delSel.classList.add('open')");
    assert.ok(iReset >= 0 && iRestore > iReset,
        '恢复 open 须在复位选择之后：selectChatWorkspace 内部 closeAll，先恢复会被其关掉');
});

test('app-workspace.js：focusout 守卫跳过因 DOM 移除而失焦的目标', () => {
    /* 重渲染会删掉聚焦中的删除按钮 → focusout 的 target 已脱离文档，
       这不是用户离开下拉，不得据此关闭（否则删除后的重渲染被自己的 focusout 关掉）。 */
    const fo = ws.slice(ws.indexOf("document.addEventListener('focusout'"), ws.indexOf('function boot()'));
    assert.match(fo, /e\.target\.isConnected === false/, '脱离文档的失焦目标须豁免');
});

test('app-workspace.js：焦点纪元守卫——重渲染后排队的 focusout 不得关下拉', () => {
    /* 插桩实证时序：删除后恢复 open 与 renderDropdown 同 tick（+1490ms），
       innerHTML 重建销毁聚焦中的删除按钮并同步派发 focusout（此时 isConnected 仍为 true，
       上述豁免拦不住）→ 守卫 setTimeout(0) 在 +1495ms 把刚恢复的下拉关掉。
       修复：renderDropdown 重建时纪元+1，守卫回调见纪元不符即知失焦是自伤的、放弃关闭。 */
    const rd = ws.slice(ws.indexOf('function renderDropdown'), ws.indexOf('/* 渲染过滤后的列表'));
    assert.match(rd, /_wsEpoch = \(epochSel\._wsEpoch \|\| 0\) \+ 1/, '重建列表 DOM 须推进纪元');
    const fo = ws.slice(ws.indexOf("document.addEventListener('focusout'"), ws.indexOf('function boot()'));
    assert.match(fo, /\(sel\._wsEpoch \|\| 0\) !== epoch/, '守卫回调须校验纪元未变');
});

test('app-workspace.js：指针按压窗口守卫——mousedown 在选择器内时 focusout 不得关下拉', () => {
    /* 用户实测「点列表项没反应」根因：列表项是不可聚焦 div，鼠标在其上按下时搜索框
       focusout → 守卫 setTimeout(0) 关下拉 → mouseup/click 时刻条目 DOM 已消失，
       click 落到 underlying 页面。故 mousedown 落在选择器内须记账、该窗口内禁止关闭。 */
    const region = ws.slice(ws.indexOf('var pointerDownInside'), ws.indexOf('function boot()'));
    assert.match(region, /document\.addEventListener\('mousedown'/);
    assert.match(region, /closest\('\.workspace-selector'\)/, '记账条件：按压点在选择器内');
    assert.match(region, /document\.addEventListener\('mouseup'/, 'mouseup 须清账，否则守卫永久生效');
    const fo = region.slice(region.indexOf("document.addEventListener('focusout'"));
    assert.match(fo, /if \(pointerDownInside\) return;/,
        '指针按压窗口内 focusout 不得关闭，否则 click 永远落不到列表项');
});
