/**
 * 契约测试：工作区下拉「底部动作按钮被裁切」修复（列表区双层可压缩）。
 *
 * 用户实测投诉：「现在有个这个打开远程目录的，把远程连接的按钮都挤下去了，导致底部有点遮挡了」
 *
 * 根因（Playwright 实测取证，探针 .tmp/ws_geom/probe_dropdown_occlusion.js）：
 * .workspace-dropdown 是 overflow:hidden 的竖向 flex，而 .workspace-actions 声明了
 * flex-shrink:0（三个动作按钮共 103px 寸步不让）；同时 .workspace-list-container 此前
 * 全仓【没有任何 CSS 规则】（裸 div）→ 作为 flex 项取默认 min-height:auto，它按内容
 * （内层 .workspace-list-scroll 的 max-height:210px）算出 210px 同样拒绝压缩。
 * 于是「搜索框 33 + 列表 210 + 动作 103 = 346px」撞上 positionDropdown 动态收紧的
 * max-height（设计上限 338px；窗口矮/选择器靠下时实测低至 255px）→ 末尾的「远程连接」
 * 按钮被 overflow:hidden 硬裁：默认场景切掉 4px、紧凑场景整条 87px 完全不可见；且
 * elementFromPoint 命中的是按钮【身后的宿主元素】→ 被裁部分既看不见也点不到，
 * overflow-y:hidden 又不提供滚动条自救。
 *
 * 这也是用户「远程工作空间打开了就连不了第二台」的真实根因：多连接注册表
 * （connectionsById）与「远程连接」入口本就存在且从不隐藏，只是那个入口被裁没了。
 *
 * 修复：列表区【两层一起】放开压缩。
 * - 只给 container 加 min-height:0（不够）：container 被压到 119px 而内层 scroll 仍
 *   固守 210px，多出的 91px 被 container 的 overflow:hidden 裁掉 → 按钮可见了，但
 *   列表最后一项同样点不到（实测 lastItemClickable=false）＝把一个遮挡换成另一个。
 * - 内层 scroll 同步 min-height:0 + flex:1 1 auto 才跟着收缩，收缩后由自身
 *   overflow-y:auto 接管滚动，列表项始终可达。
 * 修复后五个场景全部 lastBtnVisible=true，且 host=420px 紧凑场景 lastItemClickable
 * 由 false → true（双指标同时达标）。
 *
 * 覆盖：
 * - code.css：两层 min-height:0 双向门禁（缺任一层即失败，防退回单层修法）
 * - code.css：滚动能力保留（overflow-y:auto + max-height，防「为修复而删滚动」）
 * - code.css：动作区仍固定（flex-shrink:0）、下拉仍 column+overflow:hidden（设计意图）
 * - code.css：display:flex 仅挂在 .open 下（既有严重缺陷的防回退门禁）
 * - app-workspace.js：positionDropdown 仍动态限高（修复不得靠放大上限蒙混）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const codeCssRaw = readStatic('css', 'code.css');
const ws = readStatic('js', 'app-workspace.js');

/* 先剥离 CSS 注释再扫规则：本文件与 code.css 的修复说明里都出现了
   `.workspace-list-container`、`min-height:0` 等字样，直接扫会自匹配产生【假命中】
   ——把「注释里提到过」当成「规则里声明了」，测试恒绿却抓不到真实回退。 */
const codeCss = codeCssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

/* CSS 规则提取：【字符级大括号配对】而非正则捕获组，也而非行级扫描。
   WHY 不用正则：`([^{]+)\{([^{}]*)\}` 这类模式在 @media/@keyframes 嵌套处会错位
   （把内层块当顶层规则、或让选择器捕获组吃到上一条规则的残尾），得出「规则不存在」
   的假结论。WHY 不用行级：本仓大量规则写成【单行形态】（如
   `.workspace-dropdown { flex-direction: column; ... }`），按「遇 { 开块、遇 } 收尾」的
   行级状态机会在同一行内既开又关，极易漏存 body（本测试首版就因此让三条断言全挂）。
   字符级配对不受单行/多行/嵌套影响，且 at-rule 递归拆内部规则 → 媒体查询里的
   .workspace-* 也能被断言到，不会因嵌套而漏检。 */
function collectRules(css) {
    const out = [];
    let i = 0;
    while (i < css.length) {
        const open = css.indexOf('{', i);
        if (open < 0) break;
        /* 找与 open 匹配的 }（计数嵌套） */
        let d = 0, close = -1;
        for (let j = open; j < css.length; j++) {
            if (css[j] === '{') d++;
            else if (css[j] === '}') { d--; if (d === 0) { close = j; break; } }
        }
        if (close < 0) break;   // 大括号不配平：不猜，直接停（配平由体检另行保障）
        /* 选择器 = 本 { 之前、上一个 ; 或 } 或 { 之后的文本（跨行选择器也能完整取到） */
        let s = open - 1;
        while (s >= 0 && css[s] !== ';' && css[s] !== '}' && css[s] !== '{') s--;
        const selector = css.slice(s + 1, open).trim();
        const inner = css.slice(open + 1, close);
        if (selector.startsWith('@')) {
            out.push(...collectRules(inner));   // at-rule：递归取内部真实规则
        } else if (selector) {
            out.push({ selector, body: inner });
        }
        i = close + 1;
    }
    return out;
}

const allRules = collectRules(codeCss);

/* 取某个类名对应的全部规则（选择器按逗号拆分后逐段做「类名边界」匹配，
   避免 .workspace-list-scroll 误命中 .workspace-list-container 之类同前缀类）。 */
function ruleBodies(className) {
    const token = new RegExp('\\.' + className + '(?![\\w-])');
    return allRules.filter((r) => r.selector.split(',').some((p) => token.test(p.trim())));
}

/* 把一组规则的声明归一化成 {prop: value}（后出现的覆盖先出现的，与层叠同序） */
function declarations(className) {
    const decls = {};
    for (const r of ruleBodies(className)) {
        for (const part of r.body.split(';')) {
            const i = part.indexOf(':');
            if (i < 0) continue;
            const prop = part.slice(0, i).trim();
            if (!prop) continue;
            decls[prop] = part.slice(i + 1).trim();
        }
    }
    return decls;
}

/* flex-shrink 的等价判定：简写 flex:1 1 auto 与长写 flex-shrink:1 语义相同，
   不能只认某一种写法（否则把长写改简写就误报失败＝锁措辞而非锁行为）。 */
function flexShrinkAllows(decls) {
    if (decls['flex-shrink'] !== undefined) return decls['flex-shrink'] !== '0';
    const flex = decls['flex'];
    if (!flex) return true;                // 未声明 → 默认 flex-shrink:1（可压缩）
    const parts = flex.trim().split(/\s+/);
    return parts.length >= 2 ? parts[1] !== '0' : parts[0] !== '0';
}

/* 自检：解析器必须真的能读到本文件关心的规则，否则下面所有断言都是「在空集上恒真」
   ——这正是本项目反复踩到的假绿灯形态（路径算错/解析失效 + 容错跳过 = 永远通过）。 */
test('自检：CSS 解析器能读到工作区下拉的关键规则（防解析失效导致全测试假绿）', () => {
    const names = ['workspace-dropdown', 'workspace-list-container', 'workspace-list-scroll', 'workspace-actions'];
    for (const n of names) {
        const rules = ruleBodies(n);
        assert.ok(rules.length > 0, `解析器未读到 .${n} 的任何规则（解析失效，后续断言无意义）`);
    }
    /* 抽样校验声明确实被解析出来（不只是选择器命中） */
    assert.ok(Object.keys(declarations('workspace-actions')).length > 0, 'workspace-actions 声明解析为空');
    assert.equal(declarations('workspace-dropdown')['flex-direction'], 'column', '基础声明解析不正确');
});

test('code.css：.workspace-list-container 已有规则（不再是无样式的裸 div）', () => {
    assert.ok(ruleBodies('workspace-list-container').length > 0,
        '.workspace-list-container 全仓无规则 = 裸 div，flex 默认 min-height:auto 会按内容拒绝压缩（本缺陷根因）');
});

test('code.css：列表容器声明 min-height:0（放开 flex 项的自动最小尺寸）', () => {
    const decls = declarations('workspace-list-container');
    assert.equal(decls['min-height'], '0',
        '缺 min-height:0 → flex 项按内容（210px）算最小高度，空间不足时拒绝压缩，动作按钮被 overflow:hidden 裁掉');
});

test('code.css：列表容器允许收缩（flex-shrink 不为 0）', () => {
    const decls = declarations('workspace-list-container');
    assert.ok(flexShrinkAllows(decls), 'min-height:0 之外还必须允许收缩，否则 flex 布局仍不让位');
});

test('code.css：列表滚动区同样声明 min-height:0（双层门禁之一，防退回单层修法）', () => {
    /* 单向门禁不够：只压外层 container 时，内层 scroll 仍固守 max-height:210px，
       溢出部分被 container 的 overflow:hidden 裁掉 → 按钮可见但【列表最后一项点不到】
       （实测 lastItemClickable=false）。必须两层都放开，故此处独立断言内层。 */
    const decls = declarations('workspace-list-scroll');
    assert.equal(decls['min-height'], '0',
        '内层 .workspace-list-scroll 缺 min-height:0 → 外层被压缩后列表末项仍被裁且不可点（新缺陷）');
});

test('code.css：双层 min-height:0 缺一即失败（反向门禁，防「只修一半」的假绿）', () => {
    const container = declarations('workspace-list-container')['min-height'];
    const scroll = declarations('workspace-list-scroll')['min-height'];
    assert.deepEqual({ container, scroll }, { container: '0', scroll: '0' },
        '两层 min-height 必须同时为 0；单层修复会把「按钮被裁」换成「列表末项点不到」');
});

test('code.css：列表滚动区保留 overflow-y:auto 与 max-height（不得为修复而删滚动能力）', () => {
    const decls = declarations('workspace-list-scroll');
    assert.match(decls['overflow-y'] || '', /auto|scroll/,
        '列表被压缩后必须能滚动，否则项目多时底部项目永久不可达');
    assert.match(decls['max-height'] || '', /^\d+px$/,
        '缺 max-height 会让长列表把下拉撑破 positionDropdown 的设计上限');
});

test('code.css：动作区仍为 flex-shrink:0（固定，让位的是列表区而非按钮区）', () => {
    const decls = declarations('workspace-actions');
    assert.equal(decls['flex-shrink'], '0',
        '动作区若也参与压缩，按钮会被挤成两行/重叠；设计意图是「列表让位、按钮恒定可见」');
});

test('code.css：下拉容器仍为竖向 flex + overflow:hidden（修复不得改成 visible 让内容溢出宿主）', () => {
    const dd = declarations('workspace-dropdown');
    assert.equal(dd['flex-direction'], 'column');
    assert.equal(dd['overflow'], 'hidden',
        '改成 visible 会让内容溢出到 .welcome-view 之外（滚动容器下方溢出不可达），是另一种坏形态');
});

test('code.css：display:flex 仅挂在 .project-selector.open 下（防下拉常显的既有严重缺陷回退）', () => {
    /* 基础规则不得写 display:flex：.workspace-dropdown 同时带 .project-dropdown（display:none），
       无条件写 flex 会凭「同特异性·源序在后」覆盖隐藏规则 → 下拉常显、点外部关不掉。 */
    const base = ruleBodies('workspace-dropdown')
        .filter((r) => /^\.workspace-dropdown$/.test(r.selector.trim()));
    assert.ok(base.length > 0, '未找到 .workspace-dropdown 基础规则');
    for (const r of base) {
        assert.ok(!/display\s*:\s*flex/.test(r.body),
            '.workspace-dropdown 基础规则不得含 display:flex（必须仅由 .open 控制显隐）');
    }
    const openRule = allRules.find((r) => /\.project-selector\.open\s+\.workspace-dropdown/.test(r.selector));
    assert.ok(openRule && /display\s*:\s*flex/.test(openRule.body),
        '缺少 .project-selector.open .workspace-dropdown { display:flex } 规则');
});

test('app-workspace.js：positionDropdown 仍动态限高（修复不得靠放大 DESIGN_MAX 蒙混）', () => {
    /* 布局修复的正解是「让列表区可压缩」，不是「把上限调大到塞得下」——后者在
       紧凑窗口（实测内容盒仅 255px）下依然会裁，且会让宽裕窗口的下拉变得过高。 */
    assert.match(ws, /function positionDropdown\(selEl\)/);
    assert.match(ws, /var DESIGN_MAX = (\d+);/, '动态限高逻辑丢失');
    assert.match(ws, /dd\.style\.maxHeight = Math\.max\(80, Math\.min\(DESIGN_MAX, avail\)\)/,
        '必须按可用空间取 min(设计上限, 可用) 并保底 80px');
    assert.match(ws, /selEl\.classList\.toggle\('drop-up', openUp\)/, '翻转逻辑丢失');
});

test('app-workspace.js：三个动作按钮齐备且「远程连接」在最后（被裁时首当其冲的正是它）', () => {
    /* 顺序断言的意义：修复若失效，被 overflow:hidden 裁掉的必然是最后一个按钮，
       也就是用户报的「远程连接」——锁住顺序才能让该测试与用户可见症状对应。 */
    const order = ['workspace-add-btn', 'workspace-remote-open-btn', 'workspace-remote-btn'];
    let last = -1;
    for (const cls of order) {
        const i = ws.indexOf('workspace-action-btn ' + cls);
        assert.ok(i > 0, `缺少动作按钮 .${cls}`);
        assert.ok(i > last, `动作按钮顺序被打乱：.${cls} 应排在后面`);
        last = i;
    }
    /* 「打开远程目录」由 hasRemoteConnection() 门控条件渲染：无连接时不该占位，
       而它一旦出现就把内容高度从 314 推到 346（越过 338 上限）＝本缺陷的触发条件。 */
    assert.match(ws, /hasRemoteConnection\(\)[\s\S]{0,80}workspace-remote-open-btn/,
        '「打开远程目录」必须由 hasRemoteConnection() 门控条件渲染');
});
