/* ===== titlebar-task-contract.test.js =====
   标题栏拖拽条左端「当前任务名」展示位的契约测试。

   【取向】用户两次明确要求「前面的圆点不需要」，并否掉了鼠标悬停时的框选观感。
   因此这块东西的定位是【纯标题文字】，不是控件。本测试专门防止后人「好心」把它
   改回控件形态（加圆点、加 role=button、加 hover 底色/阴影、加 click），
   每一次回退都已在下面写清它会造成什么用户可见后果。

   断言分层：
   - 形态：无圆点节点、无按钮伪装、无交互属性；
   - 宽度：不得有硬编码上限，必须铺满到右侧控件前并省略号（用户 2026-10-31 反馈）；
   - 视觉：字号加粗、行高足量不裁字、无 hover/focus 装饰、不可框选；
   - 数据：不得回落到内部 sessionId，无活动会话必须 hidden；
   - 接线：三个真实汇聚点（切会话 / 离开会话 / 列表重绘）都要刷新；
   - 行为：vm 驱动真函数验幂等与回落；
   - 镜像：static ↔ gourd-work/desktop/ui 逐字节一致；gourd-ai-tauri/ui 是构建
     产物（gitignore + prepare-ui 再生），只验生成器接线。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const STATIC = path.resolve(__dirname, '../../main/resources/static');
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), 'utf8');

const indexHtml = read('index.html');
const appCss = read('css', 'app.css');
const codeCss = read('css', 'code.css');
const baseJs = read('js', 'app-base.js');
const histJs = read('js', 'app-history.js');
const bootJs = read('js', 'app-bootstrap.js');
const i18nJs = read('js', 'app-i18n.js');
const barActionsJs = read('js', 'app-titlebar-actions.js');
const taskJs = read('js', 'app-titlebar-task.js');
const repoRootForRs = path.resolve(__dirname, '../../../../../');
const rustBridge = fs.readFileSync(
    path.join(repoRootForRs, 'gourd-work', 'desktop', 'src-tauri', 'src', 'ipc_bridge.rs'), 'utf8');

/* 取出 .titlebar-drag-region 内的 markup（到 chip 闭合为止）。
   用 indexOf 找 'titlebar-task-label' 的闭合标签定位，不依赖行的具体缩进。 */
function dragRegionMarkup() {
    const open = indexHtml.indexOf('<div class="titlebar-drag-region">');
    assert.ok(open >= 0, '拖拽条容器必须存在');
    const labelAt = indexHtml.indexOf('id="titlebarTaskLabel"', open);
    assert.ok(labelAt > open, 'chip 内必须有 #titlebarTaskLabel');
    const close = indexHtml.indexOf('</div>', labelAt);
    return indexHtml.slice(open, close + 6);
}

// ---------- 形态：这是标题，不是控件 ----------
test('chip 在拖拽条内、初始 hidden', () => {
    const seg = dragRegionMarkup();
    assert.ok(seg.includes('id="titlebarTask"') && seg.includes('id="titlebarTaskLabel"'),
        '拖拽条内必须承载 #titlebarTask / #titlebarTaskLabel');
    assert.match(seg, /class="titlebar-task" id="titlebarTask" hidden/,
        'chip 初始必须 hidden（无活动会话时不占位）');
});

test('不得有状态圆点（用户两次要求去掉）', () => {
    const seg = dragRegionMarkup();
    assert.ok(!seg.includes('titlebar-task-dot'),
        'markup 中不得再有圆点节点——用户两次明确要求「前面的圆点不需要」');
    assert.doesNotMatch(appCss, /\.titlebar-task-dot\s*\{/,
        'CSS 不得残留 .titlebar-task-dot 规则（无宿主的死规则会误导后人以为圆点是设计的一部分）');
    assert.doesNotMatch(appCss, /titlebar-task-pulse/,
        '呼吸动画关键帧必须一并删除：圆点没了，动画无宿主');
    assert.doesNotMatch(appCss, /\.titlebar-task\.running/,
        '不得残留 .running 规则（运行态不再影响标题栏）');
    assert.doesNotMatch(taskJs, /isRunning|classList\.(add|toggle|remove)\(\s*'running'/,
        'JS 不得再有运行态判定：圆点删了，读 sessionMap.isStreaming 是纯浪费');
});

test('不得伪装成按钮（role/tabindex/click/keydown 一律不得出现）', () => {
    const seg = dragRegionMarkup();
    assert.ok(!/role="button"/.test(seg),
        'chip 不得带 role=button：它会让 :focus-visible 描边重新出现——用户说的「框选阴影」');
    assert.ok(!/tabindex/.test(seg),
        'chip 不得带 tabindex：不可聚焦才不会有聚焦描边，且它没有激活行为可执行');
    assert.ok(!seg.includes('<button'),
        '拖拽条内不得塞 button（skills/浏览器 code 模式随条隐藏而消失）');
    assert.doesNotMatch(taskJs, /addEventListener\(\s*'click'/,
        'JS 不得绑 click（曾用于展开侧栏，已按「纯标题」需求删除）');
    assert.doesNotMatch(taskJs, /addEventListener\(\s*'keydown'/,
        'JS 不得绑 keydown（无 role/tabindex 的键盘可达是伪承诺）');
});

// ---------- 视觉 ----------
test('标题必须更大更粗（用户要求「字体大一点，加粗」）', () => {
    // 【只能取真正的规则】app.css 里 .titlebar-task-label 也出现在注释中；
    // 直接 match「首个 .titlebar-task-label {」会把注释当成主规则。
    const rules = appCss.split('\r\n').filter((l) => /^\s*\.titlebar-task-label\s*\{/.test(l));
    assert.strictEqual(rules.length, 1, '应恰有一条 .titlebar-task-label 主规则，实际 ' + rules.length);
    // 该规则会换行续写，把后续两行拼上来再断言
    const at = appCss.indexOf('.titlebar-task-label {');
    const block = appCss.slice(at, appCss.indexOf('}', at) + 1);

    const sizeM = block.match(/font-size:\s*([\d.]+)px/);
    /* 下限 15：用户 2026-11-01 明确要求「字体再放大点」。旧下限 14 并非写错，
       但它会把「改回 14」也判成合规，护栏失去意义。 */
    assert.ok(sizeM && parseFloat(sizeM[1]) >= 15,
        '标题字号必须 ≥15px（14px 用户仍嫌小；侧栏商标文字 15px/600，标题靠 700 字重与之分层）。实际: ' + block);
    const weightM = block.match(/font-weight:\s*(\d+)/);
    assert.ok(weightM && parseInt(weightM[1], 10) >= 700,
        '标题必须加粗到 700（600 在中文小字号下与正文区分度不足）实际: ' + block);
    assert.match(block, /color:\s*var\(--text-primary\)/,
        '标题用 --text-primary（次级灰会被读成占位符/次要信息，与「标题」定位矛盾）');
});

test('行高必须足量，不得把字裁掉（这是「遮挡」的真因）', () => {
    const at = appCss.indexOf('.titlebar-task-label {');
    const block = appCss.slice(at, appCss.indexOf('}', at) + 1);
    const lh = block.match(/line-height:\s*([\d.]+)/);
    assert.ok(lh, 'label 必须显式声明数字 line-height（不能用 normal 后被别处覆盖）');
    const ratio = parseFloat(lh[1]);
    /* 实测：中日韩字形墨迹 ascent 11 + descent 3 = 14px（Latin 也吃 14px 的
       fontBoundingBox）。line-height × font-size 必须明显大于墨迹高度，否则
       overflow:hidden 会上下各裁 1px —— 用户报的「显示有遮挡」。 */
    const fontSize = parseFloat((block.match(/font-size:\s*([\d.]+)px/) || [0, 14])[1]);
    const boxH = ratio * fontSize;
    assert.ok(boxH >= fontSize + 4,
        'line-height 后盒高必须 ≥ 字号+4px（CJK 墨迹实测 19px@14px，字号变大同理要留足 leading），实际 ' + boxH + 'px');
});

test('鼠标悬停/聚焦不得有任何装饰（用户：「框选阴影太难看了」）', () => {
    const at = appCss.indexOf('.titlebar-task {');
    const block = appCss.slice(at, appCss.indexOf('}', at) + 1);
    assert.doesNotMatch(block, /background\s*:/,
        'chip 静止态不得有 background（空白顶条上凭空一块矩形＝用户说的「框选」）');
    // 全文件范围内，chip 相关的任何状态规则都不得带视觉装饰
    assert.doesNotMatch(appCss, /\.titlebar-task[^{,]*:hover[^{]*\{/,
        'chip 不得有 :hover 规则（哪怕只改颜色：抬亮/变色同样会被读成「有东西被选中」）');
    assert.doesNotMatch(appCss, /\.titlebar-task[^{,]*:focus[^{]*\{/,
        'chip 不得有 :focus/:focus-visible 规则（描边就是用户否掉的框选观感）');
    assert.doesNotMatch(appCss, /\.titlebar-task[^{]*\{[^}]*box-shadow/,
        'chip 任何状态都不得带 box-shadow');
    assert.doesNotMatch(appCss, /\.titlebar-task[^{]*\{[^}]*cursor:\s*pointer/,
        'chip 不得用 cursor:pointer：它不可点击，指针手型是欺骗性暗示');
});

test('标题不可框选、鼠标压上去即拖窗口', () => {
    const at = appCss.indexOf('.titlebar-task {');
    const block = appCss.slice(at, appCss.indexOf('}', at) + 1);
    assert.match(block, /pointer-events:\s*none/,
        'pointer-events:none 让鼠标穿透到拖拽条：既保证标题上能拖窗，也从根上杜绝选中文字出现蓝框');
    assert.match(block, /user-select:\s*none/,
        'user-select:none 是第二条独立防线（Java 的 Electron 壳与浏览器没有 Rust 壳的注入，必须自己兜住）');
    assert.match(block, /-webkit-user-select:\s*none/,
        '必须带 -webkit- 前缀（Electron/Chromium 老版本只认前缀版）');
});

/* ===== 宽度纪律（2026-10-31 用户反馈修正）=====
   用户原话：「你这显示长度也不对，太短了，应该一直到后面，然后省略号」，并给出参照稿
   （标题一路铺到窗控前）。像素级取证：用户红框标出我们的标题盒 x=8..451（444px），
   参照稿 x=91..757（占窗宽 73%）。Playwright 实测 1400px 窗下旧值 max-width:min(46%,420px)
   把标题盒卡死在 420px、右侧留 605px 死空白，长标题被无谓截断。
   下面三条钉住修正后的形态，任一回退都会重现用户报的问题。 */
test('chip 不得有硬编码宽度上限（旧值 min(46%,420px) 造成宽窗下 605px 死空白）', () => {
    const at = appCss.indexOf('.titlebar-task {');
    assert.ok(at >= 0, '.titlebar-task 主规则必须存在');
    const block = appCss.slice(at, appCss.indexOf('}', at) + 1);
    assert.doesNotMatch(block, /max-width/,
        'chip 不得写 max-width：任何硬编码上限都会在宽窗下重新造出右侧死空白'
        + '（旧值 min(46%,420px) 实测 1400px 窗下标题只占 420px、留 605px 空白）。实际: ' + block);
    /* 剥注释后再查全文：本条护栏只针对【代码】。注释里写「原先 min(46%,420px)」是
       有益的历史说明（防后人不知道为什么不能加回来），不能因为提到了就判红——
       首版直接 doesNotMatch(appCss, ...) 就因此自伤一次。 */
    const cssCodeOnly = appCss.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(cssCodeOnly, /min\(46%/,
        '剥离注释后 CSS 代码不得残留 min(46%...) 这个旧上限');
    assert.match(block, /flex:\s*1 1 auto/,
        'chip 必须 flex:1 1 auto 才能吃满拖拽条内容区。实际: ' + block);
    assert.match(block, /min-width:\s*0/,
        'chip 的 min-width:0 不可省：flex item 默认 min-width:auto 会拒绝收缩，'
        + '于是 label 的省略号永不触发、文字溢出压到右侧控件上。实际: ' + block);
});

test('label 必须可收缩，否则省略号失效（用户要求「一直到后面，然后省略号」）', () => {
    const at = appCss.indexOf('.titlebar-task-label {');
    const block = appCss.slice(at, appCss.indexOf('}', at) + 1);
    assert.match(block, /min-width:\s*0/,
        'label 作为 chip 的 flex item 必须 min-width:0，否则不收缩、text-overflow:ellipsis 不生效。实际: ' + block);
    assert.match(block, /flex:\s*0 1 auto/,
        'label 必须 flex:0 1 auto（可压缩、不放大）。实际: ' + block);
    assert.match(block, /text-overflow:\s*ellipsis/, '超出必须省略号截断');
    assert.match(block, /overflow:\s*hidden/, 'overflow:hidden 是省略号生效的前提');
    assert.match(block, /white-space:\s*nowrap/, 'nowrap 保证单行，换行会把顶条撑高、挤掉内容区（顶条高是跨栈契约，见高度一致性用例）');
});

test('拖拽条右侧让位必须由 JS 实测窗控+按钮组（CSS 写不死）', () => {
    /* 标题铺满后必须有人为右侧控件让位，否则文字压在终端/监控按钮底下——
       把「太短」换成「重叠」，等于没修。窗控宽（Tauri 102 / Electron 138 / mac 0）
       与按钮组宽（窄屏 @media 会压缩）都是运行时事实，只能在 JS 里量。 */
    assert.match(barActionsJs, /function applyDragRegionReserve\(/,
        '必须存在 applyDragRegionReserve：为拖拽条算右侧让位');
    /* 【M5 漏洞】只断言函数存在是不够的：把调用删掉、留个死函数，标题照样铺满压到
       按钮底下，测试却全绿（变异验证实测 SURVIVED）。必须钉住调用点在
       applyRightOffset 体内——那是唯一同时被 load / resize / body 类变化触发的入口。 */
    const offsetFn = barActionsJs.slice(barActionsJs.indexOf('function applyRightOffset()'));
    const offsetBody = offsetFn.slice(0, offsetFn.indexOf('\n    }') + 6);
    assert.match(offsetBody, /applyDragRegionReserve\(\s*stripW\s*\)/,
        'applyRightOffset 体内必须调用 applyDragRegionReserve：只留死函数不接线，'
        + '标题铺满会压到终端/监控按钮底下而测试全绿。实际: ' + offsetBody);
    assert.match(barActionsJs, /actions\.getBoundingClientRect\(\)/,
        '让位必须实测按钮组自身位置（原先【没有任何人为它让位】，标题铺满即压按钮）');
    /* 【M6 漏洞】只断言 getBoundingClientRect 存在同样不够：把它取到的 ar.left
       从 limit 计算里摘掉（只用窗控位置），标题就会压在按钮上，测试仍全绿。
       必须钉住 limit 同时受「按钮组左边界」和「窗控左边界」两者约束。 */
    const reserveFn = barActionsJs.slice(barActionsJs.indexOf('function applyDragRegionReserve('));
    const reserveBody = reserveFn.slice(0, reserveFn.indexOf('\n    }') + 6);
    assert.match(reserveBody, /limit[^;]*ar\.left/,
        'limit 必须包含 ar.left（按钮组左边界）：只用窗控位置算让位，标题会压在'
        + '终端/监控按钮底下。实际: ' + reserveBody);
    assert.match(reserveBody, /limit[^;]*window\.innerWidth\s*-\s*stripW/,
        'limit 必须包含窗控左边界（innerWidth - stripW）：漏了它标题会伸到窗控底下。实际: ' + reserveBody);
    assert.match(reserveBody, /Math\.min\(/,
        '必须用 Math.min 取两者中更靠左的：窗控与按钮组谁更靠左就为谁让位。实际: ' + reserveBody);
    assert.match(barActionsJs, /region\.style\.paddingRight/,
        '让位以 paddingRight 写回 region（内联 style 优先级高于 titlebar_ui.rs 注入的'
        + '「只算窗控」静态值，正好把它升级为「窗控+按钮」动态值）');
    assert.match(barActionsJs, /addEventListener\('resize',\s*applyRightOffset\)/,
        '必须监听 resize：窗口尺寸变化同时改变拖拽条宽与（窄屏媒体查询下的）按钮组宽');
    assert.match(barActionsJs, /function syncAll\(\)/,
        '必须挂 syncAll 到 body 类观察器：task-monitor-open 让 .main-area 内缩'
        + ' --task-monitor-width，拖拽条右边界随之内缩，让位宽要跟着重算');
    assert.match(barActionsJs, /new MutationObserver\(syncAll\)/,
        'MutationObserver 必须挂 syncAll 而非 syncButtons（只同步按钮态会漏掉让位重算）');
    assert.doesNotMatch(barActionsJs, /new MutationObserver\(syncButtons\)/,
        '不得仍挂 syncButtons：body 类变化时让位宽不会重算');
});

test('拖拽条 flex 化只写 padding-left，不得用 padding 简写吃掉窗控让位', () => {
    const rule = appCss.match(/body\.is-electron \.titlebar-drag-region \{[^}]*\}/);
    assert.ok(rule, 'body.is-electron .titlebar-drag-region 规则必须存在');
    assert.match(rule[0], /display: flex;/, '需 flex 才能让 label 的 margin-top 生效（顶格基线对齐，非居中）');
    assert.match(rule[0], /padding-left: 14px;/, '左内边距与侧栏内容对齐');
    assert.doesNotMatch(rule[0], /padding:\s/,
        'padding 简写会覆盖 titlebar_ui.rs 注入的 padding-right（自绘窗控让位，同特异性后序失效）');
    const codeRule = codeCss.match(/body\.is-electron\.code-mode \.titlebar-drag-region \{[^}]*\}/);
    assert.ok(codeRule && /display: flex;/.test(codeRule[0]),
        'code 模式拖拽条（absolute 通栏）同样要 flex，否则标题不跟随顶格基线');
});

test('标题顶格 12px 与商标同值；mac 例外必须已文档化（防止把普适契约当真）', () => {
    /* 【为何要这条】上一轮自审发现：「标题顶边不高于商标顶边」在 Windows/Linux 壳
       与浏览器下成立，但 macOS 下 .sidebar-header 被 is-mac 规则整体下移让位红绿灯，
       商标顶边落到 52px，而标题受 44px 顶条约束最高只能落在 12px——二者分属不同
       视觉带，对齐在几何上不可成立。若把它当普适契约「修齐」，标题会溢出顶条压进
       内容区。本用例把这个边界钉住：值本身、对齐来源、mac 让位规则、以及注释里
       对例外的明文声明，四者缺一即红。 */
    const at = appCss.indexOf('.titlebar-task-label {');
    const block = appCss.slice(at, appCss.indexOf('}', at) + 1);
    const mt = block.match(/margin-top:\s*([\d.]+)px/);
    assert.ok(mt, 'label 必须显式声明 margin-top（顶格定位不靠 align-items:center 的数值巧合）');

    const headerRule = appCss.match(/^\.sidebar-header \{[^}]*\}/m);
    assert.ok(headerRule, '.sidebar-header 主规则必须存在（顶格值的对齐来源）');
    const headerPad = headerRule[0].match(/padding:\s*([\d.]+)px/);
    assert.ok(headerPad,
        '.sidebar-header 必须显式声明顶部 padding，否则 label 的顶格值失去对齐依据：' + headerRule[0]);
    assert.strictEqual(parseFloat(mt[1]), parseFloat(headerPad[1]),
        '标题顶格值必须与 .sidebar-header 顶部 padding 同值（两者是独立布局链路，'
        + '靠同值而非巧合对齐）：label=' + mt[1] + ' header=' + headerPad[1]);

    const macRule = appCss.match(/body\.is-electron\.is-mac[^{]*\.sidebar-header \{[^}]*\}/);
    assert.ok(macRule,
        'macOS 下 .sidebar-header 的下移让位规则必须存在（红绿灯避让），不能改成全局加高顶条');
    assert.match(macRule[0], /padding-top:\s*(\d+)px/, 'mac 让位规则必须显式给出 padding-top');

    const doc = appCss.slice(0, at);
    assert.match(doc, /【适用边界[\s\S]*macOS/,
        '顶条注释必须声明该对齐契约的 macOS 适用边界（历史上注释把 mac 当成普适契约，'
        + '误导后人「修齐」而溢出顶条）');
    assert.match(doc, /红绿灯/, '注释必须说明 mac 下商标被下移的原因（红绿灯让位），而非只给结论');
});

test('Rust 壳拖拽白名单含 [role="button"]（通用 role 口径，不是给 chip 用的）', () => {
    /* chip 自己不再是 role=button 了，但白名单仍必须保留 [role="button"]：
       仓内还有别的 role=button 元素（ws-group-act / sidebar 空态提示等），
       且这是「通用 role 而非枚举业务类名」的纪律见证（枚举类名的历史教训见
       gourd-ai-desktop/main/preload.js）。 */
    assert.match(rustBridge, /\[role="button"\]/,
        'Rust 壳 isDragTarget 白名单必须保留 [role=button]（通用 role 口径，且修掉「点击被吞成拖窗」的历史缺陷）');
    assert.match(rustBridge, /不枚举业务类名|通用 role/,
        '白名单注释必须声明通用选择器纪律（枚举类名的历史教训）');
});

// ---------- 数据契约 ----------
test('名称来源：chatHistory 的 label；绝不回落内部 sessionId', () => {
    assert.match(taskJs, /window\.chatHistory/, '名称必须读 chatHistory（真源，不另存副本）');
    assert.match(taskJs, /entry\.label/, '必须取 entry.label');
    assert.doesNotMatch(taskJs, /name\s*=\s*entry\s*\?\s*entry\.label\s*:\s*sid/,
        '不得用 sessionId 兜底：work-xxx 是内部键，露在标题栏等于没给信息');
    /* 【用户明确要求】标题栏不出现「新对话」这类占位字样：未定名整块隐藏。
       此断言曾被写成「必须回落 i18n 文案」——那是追我上一轮自己的错误结论、
       不是用户原话。教训固化：测试里写「用户要求 X」时必须能追到用户原话，
       追不到就是编的。反向钉住，防止 fallbackName 被「好心」加回来。 */
    assert.doesNotMatch(taskJs, /function\s+fallbackName/,
        '不得存在回落文案函数：未定名走 hidden，不拿假名字顶在标题栏上');
    assert.doesNotMatch(taskJs, /history\.new_chat/,
        '标题栏不得引用 history.new_chat（它只属于侧栏条目兜底，app-history.js:407）');
    assert.match(taskJs, /if \(!sid \|\| !name\)/,
        '无会话或有会话但未定名都必须进入 hidden 分支（只判 !sid 会露出空标题）');
});

test('无活动会话必须 hidden（含 deactivateSession 路径）', () => {
    assert.match(taskJs, /chip\.hidden\s*=\s*true/, '无 activeSessionId 必须隐藏 chip');
    const deact = baseJs.slice(baseJs.indexOf('function deactivateSession()'),
        baseJs.indexOf('/* ===== Helpers ===== */'));
    assert.match(deact, /activeSessionId\s*=\s*null/, 'deactivateSession 必须把 activeSessionId 置空');
    assert.match(deact, /renderTitlebarTask\(\)/,
        'deactivateSession 必须刷新标题栏：置空后不刷新会让标题残留上一个会话名');
});

// ---------- 接线 ----------
test('三个汇聚点刷新标题栏（漏一处即静默失效）', () => {
    const setActive = baseJs.slice(baseJs.indexOf('function setActiveSession('),
        baseJs.indexOf('function deactivateSession('));
    assert.match(setActive, /renderTitlebarTask\(\)/, 'setActiveSession 尾部必须刷新（切会话）');

    const deact = baseJs.slice(baseJs.indexOf('function deactivateSession()'),
        baseJs.indexOf('/* ===== Helpers ===== */'));
    assert.match(deact, /renderTitlebarTask\(\)/, 'deactivateSession 必须刷新（离开会话）');

    const upd = histJs.slice(histJs.indexOf('function updateHistoryUI('),
        histJs.indexOf('function buildSidebar'));
    assert.match(upd, /renderTitlebarTask\(\)/,
        'updateHistoryUI 必须刷新（首条消息定名 / 重命名 / 删除都会改 label）');

    assert.match(bootJs, /'\/js\/app-titlebar-task\.js'/, '脚本必须登记进 APP_SCRIPTS');

    // 运行态不再是刷新点：setBtnStopMode/SendMode 里不该再有这行（无圆点可更新）
    const stopFn = baseJs.slice(baseJs.indexOf('function setBtnStopMode()'),
        baseJs.indexOf('function setBtnSendMode()'));
    const sendFn = baseJs.slice(baseJs.indexOf('function setBtnSendMode()'),
        baseJs.indexOf('/* ===== 任务执行中的键位提示'));
    assert.doesNotMatch(stopFn, /renderTitlebarTask/,
        'setBtnStopMode 不得再刷新标题栏：运行态已不影响展示，留着是每次收发消息的无效 DOM 写入');
    assert.doesNotMatch(sendFn, /renderTitlebarTask/, '同上：setBtnSendMode 不得再刷新标题栏');
});

test('i18n 事件名必须与派发方逐字一致', () => {
    // app-i18n.js 派发的是 document 上的 i18n:localeChanged
    assert.match(i18nJs, /new CustomEvent\('i18n:localeChanged'/, '派发方事件名（本测试的前提）');
    assert.match(taskJs, /'i18n:localeChanged'/,
        '监听事件名必须与派发方逐字一致（写成 i18n:changed 会永不触发，切换语言后回落文案不更新）');
});

// ---------- 行为（vm 驱动真函数） ----------
function makeEl() {
    return { hidden: false, textContent: '' };
}

function loadTaskScript(globals) {
    const chip = makeEl();
    const label = makeEl();
    const context = {
        console: { error() {}, warn() {}, log() {} },
        document: {
            getElementById(id) {
                return id === 'titlebarTask' ? chip : (id === 'titlebarTaskLabel' ? label : null);
            },
            addEventListener() {}
        }
    };
    /* 【沙箱保真】浏览器里 window === globalThis，脚本读 `GourdI18n`（不带 window.）
       和读 `window.chatHistory` 取到的是同一批绑定。vm 沙箱若给一个独立的普通对象
       当 window，两条写法会分裂：这里把 context 自身挂成 window，再用 defineProperty
       保持双向可写，重演浏览器语义。首版没这么做，导致「有 i18n 却仍回落字面兵」
       的假失败。 */
    context.window = context;
    const g = globals || {};
    for (const k of Object.keys(g)) {
        if (k === '__globals') {
            for (const kk of Object.keys(g[k])) context[kk] = g[k][kk];
        } else {
            context[k] = g[k];
        }
    }
    vm.createContext(context);
    vm.runInContext(taskJs, context, { filename: 'app-titlebar-task.js' });
    return { chip, label, ctx: context };
}

test('行为：无会话 hidden；有会话显示 label；未定名同样 hidden（不得出现占位字样）', () => {
    let r = loadTaskScript({});
    assert.strictEqual(r.chip.hidden, true, '无 activeSessionId 必须 hidden');
    assert.strictEqual(r.label.textContent, '', '空态不得残留文字');

    r = loadTaskScript({
        __globals: { activeSessionId: 'work-a' },
        chatHistory: [{ sessionId: 'work-a', label: '我的任务名' }]
    });
    assert.strictEqual(r.chip.hidden, false, '有活动会话必须显示');
    assert.strictEqual(r.label.textContent, '我的任务名');

    /* chatHistory 未登记（刚新建、首条消息还没发）→ 隐藏整块。
       取舍：宁可不显示，也不拿一个假名字顶在标题栏上；真名随首句定名后出现。 */
    r = loadTaskScript({ __globals: { activeSessionId: 'work-c' }, chatHistory: [] });
    assert.strictEqual(r.chip.hidden, true, '有会话但未定名必须 hidden');
    assert.strictEqual(r.label.textContent, '', '未定名不得写任何占位文案');
    assert.ok(!r.label.textContent.includes('work-c'), '内部 ID 绝不露在标题栏');

    // 即使 i18n 就绪也不得把译文顶到标题栏（该口径已从标题栏移除，只留侧栏）
    r = loadTaskScript({
        __globals: { activeSessionId: 'work-d' }, chatHistory: [],
        GourdI18n: { t: (k) => (k === 'history.new_chat' ? 'New chat' : k) }
    });
    assert.strictEqual(r.chip.hidden, true, 'i18n 就绪也不能回落占位译文');
    assert.strictEqual(r.label.textContent, '', 'i18n 就绪时同样不得写占位文案');
});

test('行为：renderTitlebarTask 幂等（重复调用不重复写 DOM）', () => {
    const chip = makeEl();
    const label = makeEl();
    let writes = 0;
    Object.defineProperty(label, 'textContent', {
        get() { return this._t || ''; },
        set(v) { writes++; this._t = v; }
    });
    const context = {
        console: { error() {}, warn() {}, log() {} },
        document: {
            getElementById(id) { return id === 'titlebarTask' ? chip : label; },
            addEventListener() {}
        },
        chatHistory: [{ sessionId: 'work-a', label: 'L' }],
        activeSessionId: 'work-a'
    };
    context.window = context; // 同 loadTaskScript：浏览器里 window === globalThis
    vm.createContext(context);
    vm.runInContext(taskJs, context, { filename: 'app-titlebar-task.js' });
    const afterFirst = writes;
    assert.ok(afterFirst >= 1, '首帧必须写入');
    context.window.renderTitlebarTask();
    context.window.renderTitlebarTask();
    assert.strictEqual(writes, afterFirst,
        '内容未变时不得重复写 label（updateHistoryUI 每帧 rAF 都会调进来）');
});

// ---------- 镜像与产物纪律 ----------
test('static ↔ desktop/ui 逐字节一致（Rust 壳真镜像，需手工同步）', () => {
    const mirrorRoot = path.join(repoRootForRs, 'gourd-work', 'desktop', 'ui');
    if (!fs.existsSync(mirrorRoot)) return; // CI 干净检出无镜像：显式跳过
    /* index.html 不在严格镜像名单：两份存在【结构性差异】——Rust 壳需要
       kernel-bridge.js（页面源 tauri.localhost、内核在 127.0.0.1:随机端口，必须
       改写 fetch/XHR/WS），Java 内核同源提供 static 因此不需要。由下方单独的
       「同构 + 允许差异」断言守护。 */
    /* app-settings-about.js / settings.css 加入名单的由来：Rust 壳缺 updater 能力时
       关于页需要降级文案，改动最初只落在 desktop/ui 单侧，而当时两份是逐字节一致的 ——
       下一次有人整体同步该目录就会把修复静默冲掉。这两个文件此前不在任何覆盖集里。 */
    const files = ['css/app.css', 'css/code.css', 'css/settings.css', 'js/app-base.js',
        'js/app-history.js', 'js/app-bootstrap.js', 'js/app-titlebar-task.js',
        'js/app-titlebar-actions.js', 'js/app-settings-about.js'];
    for (const rel of files) {
        const a = fs.readFileSync(path.join(STATIC, rel));
        const b = fs.readFileSync(path.join(mirrorRoot, rel));
        assert.strictEqual(
            crypto.createHash('sha256').update(a).digest('hex'),
            crypto.createHash('sha256').update(b).digest('hex'),
            'desktop/ui 镜像不同步: ' + rel + '（Rust 壳 frontendDist 真镜像，手工同步该目录）');
    }
});

test('index.html 双副本：允许 kernel-bridge 差异，其余必须同构', () => {
    const mirror = path.join(repoRootForRs, 'gourd-work', 'desktop', 'ui', 'index.html');
    if (!fs.existsSync(mirror)) return;

    const mirrorHtml = fs.readFileSync(mirror, 'utf8');
    assert.match(mirrorHtml, /<script src="\/js\/kernel-bridge\.js"><\/script>/,
        'Rust 壳 index.html 必须引入 kernel-bridge（内核端口随机，不改写就全部请求落空）');
    assert.ok(indexHtml.indexOf('kernel-bridge.js') < 0,
        'Java 内核 static 不得引入 kernel-bridge（同源，无需改写）');

    const a = indexHtml.split('\n'), b = mirrorHtml.split('\n');
    const onlyInStatic = a.filter((l) => b.indexOf(l) < 0).length;
    assert.strictEqual(onlyInStatic, 0,
        'static 不得有 desktop/ui 缺失的行：Rust 壳副本落后了（重新同步，仅 kernel-bridge 允许单侧存在）');
    const delta = b.length - a.length;
    assert.ok(delta > 0 && delta <= 12,
        'desktop/ui 只允许比 static 多出 kernel-bridge 那一段（实测 11 行），实际多 ' + delta + ' 行——副本已漂移');
});

test('tauri/ui 是构建产物而非镜像：gitignore + prepare-ui 从 static 再生', () => {
    /* Java 内核 UI 真身在 src/main/resources/static（Maven 资源 → jar classpath）；
       gourd-ai-tauri/ui 被 gitignore 整体忽略、打包期由 cmd/prepare-ui.js 从 static
       整拷再生，手工改/手工同步它不进任何产物。此处只断言生成器接线，防止退回到
       「手工同步 ui/」的错误模型。 */
    const tauriRoot = path.resolve(__dirname, '../../../../gourd-ai-tauri');
    const gitignore = fs.readFileSync(path.join(tauriRoot, '.gitignore'), 'utf8');
    assert.match(gitignore, /^\/ui\/\s*$/m, 'ui/ 必须被 gitignore 整体忽略（产物非源）');
    const prep = fs.readFileSync(path.join(tauriRoot, 'cmd', 'prepare-ui.js'), 'utf8');
    assert.match(prep, /'static'\s*\)/, 'prepare-ui 的 UI_SOURCE 必须落在 gourd-ai-agent 的 static');
    const conf = fs.readFileSync(path.join(tauriRoot, 'src-tauri', 'tauri.conf.json'), 'utf8');
    assert.match(conf, /prepare-ui\.js/, 'beforeDev/beforeBuild 必须跑 prepare-ui（打包期再生）');
});
