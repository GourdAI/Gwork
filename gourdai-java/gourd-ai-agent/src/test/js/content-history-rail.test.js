/**
 * 内容区右侧「会话导航刻度带」（Content History Rail）契约。
 *
 * 背景：本模块在 2026-10 从一个「输入框上方的历史消息浮层」（搜索框 + 列表 + 回填/定位按钮）
 * 整体重做为「内容区右缘的竖排刻度带」。因此这个测试文件不是增量补充，而是替换：
 * 旧面板的每一条断言在新形态下都已不成立（容器、类名、交互模型全变）。
 *
 * 为什么必须用源码级断言钉住这些点 —— 每一条的失手都会造成真实可见退化，
 * 而它们都不会让 JS 抛错、也不会让编译失败：
 *
 * 1) 刻度纵向位置必须【只依赖序号与轨道高】：固定步距 + 整簇居中（computeRailTops）。
 *    【这条模型被推翻过两次】v1 按「消息在全文中的真实比例」摆位（缩略地图）；
 *    v2 改等距但铺满整条轨道，8 条消息拉开成 96px 一根 —— 用户拿参照稿说「你间隔这么大
 *    干嘛」否掉 v2；而 v1 的「按内容高度摆位」早先也因图片加载/代码高亮引起的分部重排
 *    会拖动刻度而被否。共同禁忌：不得读 scrollHeight、不得测消息行 DOM 位置。
 * 2) active 判据 = 「scrollTop 已越过顶沿断点的最后一条」（与等距刻度同一坐标系），
 *    并且末条断点必须钳位到可滚动上限。
 *    【这条也被推翻过】v1/v2 用滚动进度或「视口中线锚点」(scrollTop + clientHeight/2)，
 *    刻度改成固定步距后两者不再同源 —— 实测点第 0~4 根 active 全部落到末根，
 *    因为 scrollIntoView(block:'start') 后 midline 早已越过后面好几条。中线锚点是 P0 根因，
 *    不得回退；「滚到底停在第 3 根」那个老缺陷则由末条钳位解决。
 * 3) 必须有 ResizeObserver。【理由与 v1 不同】等距后刻度位置不再随内容高度漂移
 *    （「偏差 2.42%」是 v1 按比例摆位时代的缺陷，现已不存在），但正文异步撑高会改变
 *    「当前读到哪里」的答案，active 仍必须重算，容器高度变化也要重算居中偏移与命中区。
 *    另：relayout 必须尊重点击锚定 —— 见护栏「所有画 active 的调用点必须走同一入口」，
 *    那正是本轮 codereview 实测出的缺陷（点第 3 根后内容撑高，active 被冲成 0）。
 * 4) 轨道必须是滚动区的【兄弟 flex 列】，不能是绝对定位覆盖层：
 *    覆盖层会压住 .messages-wrap 的原生滚动条，挡住拖动。
 * 5) 摘要浮层现在是【可交互列表卡】，pointer-events 必须是 auto（none 是旧单行摘要时代
 *    的做法）；随之而来的「指针跨过 2px 间隙就灭」改由 JS 延迟隐藏（160ms）解决，
 *    不得改回 none —— 那会让卡片里的行无法悬停与点击。
 * 6) 摘要浮层必须完全让到刻度左侧（right > 轨道宽 26px），否则压住刻度（实测重叠 6px）。
 * 7) 动效必须尊重 prefers-reduced-motion。
 * 8) 绝对不得回退成弹窗：容器 #chatHistoryPanel / 类名 .history-panel /
 *    「+」菜单里的历史入口都已删除，回退即用户明确否掉的形态。
 * 9) 消息过多时必须采样（保留首末条），封顶会让后半段对话失去导航。
 * 10) 刻度只做导航，【没有】回填输入框的能力，也不存在什么「↑ 键 recallHistoryDraft」——
 *     旧浮层的 applyHistorySelection 按用户明确要求随浮层一并删除，当前无替代实现。
 *     这条写在这里是为了防止后人再次把它当成「还在某处生效」而不去补。
 * 11) active 判定必须全程待在内容像素坐标系，且【不得】把「视口中线锚点」
 *     (scrollTop + clientHeight/2) 与像素断点混用 —— 两者不同源。
 *     【本条曾把缺陷写成契约】旧文本把 midline 当成正确锚点，实际它是本轮 P0 的根因；
 *     它同时否定的「两个不同尺度归一化后相减」才是真禁忌（那样只有两端正确，
 *     中间段系统性错，实测 7 个采样点 4 个错）。
 * 12) 摘要浮层的 top 必须由 getBoundingClientRect 相减得出（刻度与浮层的包含块不是
 *     同一个元素：刻度 offsetParent 是 track，浮层包含块是带 padding 的 rail），
 *     用 offsetTop 会恒定偏高（实测 7.5px，满密度时贴到相邻刻度上）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STATIC = path.resolve(__dirname, '../../main/resources/static');
// 本仓源文件是纯 CRLF（app.css / app-history.js / chat.html 实测 0 个裸 LF）。
// 读取后统一归一化为 LF 再断言，否则 `\n}\n` 这类块边界永远匹不上——
// 本仓多次踩过：切片失败时表现为「缺函数」而非语法错误，极具迷惑性。
const norm = (s) => s.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const css = norm(fs.readFileSync(path.join(STATIC, 'css/app.css'), 'utf8'));
const js = norm(fs.readFileSync(path.join(STATIC, 'js/app-history.js'), 'utf8'));
const chatHtml = norm(fs.readFileSync(path.join(STATIC, 'chat.html'), 'utf8'));
const appBase = norm(fs.readFileSync(path.join(STATIC, 'js/app-base.js'), 'utf8'));
const appMessage = norm(fs.readFileSync(path.join(STATIC, 'js/app-message.js'), 'utf8'));
const appStreaming = norm(fs.readFileSync(path.join(STATIC, 'js/app-streaming.js'), 'utf8'));

/** 去掉 // 与 /* *\/ 注释，避免「注释里提到某词」导致断言假通过或假失败。
 *  本仓反复踩过这个坑（护栏被自己写的注释绊倒），故所有「某词必须存在/必须不存在」
 *  类断言一律跑在 codeOnly 结果上。 */
function codeOnly(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

/** 取出某个顶层 function 的函数体（闭合括号在第 0 列）。 */
function fnBody(src, name) {
    const start = src.indexOf('function ' + name + '(');
    assert.ok(start >= 0, 'app-history.js 缺少顶层 function ' + name);
    const end = src.indexOf('\n}\n', start);
    assert.ok(end > start, 'function ' + name + ' 未按约定以第 0 列的 } 闭合');
    return src.slice(start, end + 3);
}

/** 取一条 CSS 规则的声明块（按花括号配平，不用「到下一个换行」——
 *  新 CSS 是多行规则，按换行切只会切到 `{`）。 */
function cssRule(selector) {
    const idx = css.indexOf(selector + ' {');
    assert.ok(idx >= 0, 'app.css 缺少规则 ' + selector);
    let depth = 0;
    for (let i = idx; i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') {
            depth--;
            if (depth === 0) return css.slice(idx, i + 1);
        }
    }
    throw new Error('规则 ' + selector + ' 花括号未闭合');
}

/* ============ 1. 绝不回退成弹窗 ============ */

test('chat.html 不再有历史消息浮层容器', () => {
    assert.ok(!chatHtml.includes('chatHistoryPanel'),
        '旧浮层容器 #chatHistoryPanel 不得回归（用户明确要求「去掉弹窗」）');
    assert.ok(!/class="[^"]*\bhistory-panel\b/.test(chatHtml),
        '不得再出现 .history-panel 类（旧浮层形态）');
});

test('「+」菜单里不再有历史消息入口（会话态与欢迎页都不得回归）', () => {
    assert.ok(!chatHtml.includes('chatHistoryBtn'),
        '#chatHistoryBtn 不得回归：「历史消息」不再是菜单项，导航常驻在内容区右侧');
    assert.ok(!chatHtml.includes('welcomeHistoryBtn'),
        '#welcomeHistoryBtn 不得回归（它是一个长期 disabled 的死按钮）');
    assert.ok(!chatHtml.includes('app.history_msg'),
        'app.history_msg 文案不得再出现在 markup 里');
});

test('app-history.js 不再保留旧浮层的任何函数或状态', () => {
    const code = codeOnly(js);
    for (const gone of ['showHistoryPanel', 'hideHistoryPanel', 'navigateHistory',
        'onHistoryBtnClick', 'historyPanelTexts', 'historyActiveIndex',
        'extractUserMessages', '$chatHistoryPanel', 'historySearchText',
        'moveHistoryActive', 'commitHistoryActive']) {
        assert.ok(!code.includes(gone),
            '旧浮层符号 ' + gone + ' 不得残留（死代码会被误接回去）');
    }
});

test('app-streaming.js 的点击豁免名单已去掉 .history-panel', () => {
    const code = codeOnly(appStreaming);
    const idx = code.indexOf("$('.input-box').on('click'");
    assert.ok(idx > 0, '未找到 input-box 点击委托');
    const block = code.slice(idx, idx + 700);
    assert.ok(!block.includes("closest('.history-panel')"),
        '浮层已删除，豁免名单里的 .history-panel 是死引用');
    // 既有豁免必须保留，不能因为删一条就整段重写
    for (const keep of ['button', '.loop-panel', '.todo-float-panel', '.workspace-selector']) {
        assert.ok(block.includes("closest('" + keep + "')"), '既有豁免被误删: ' + keep);
    }
});

/* ============ 2. 新结构 ============ */

test('chat.html 提供 messages-shell / messagesWrap / rail / track / tip 五个锚点', () => {
    assert.match(chatHtml, /<div class="messages-shell" id="messagesShell">/,
        '缺少 .messages-shell（刻度带与滚动区的共同定位容器）');
    assert.match(chatHtml, /<div class="messages-wrap" id="messagesWrap">/,
        'messagesWrap 的 id 被其他模块大量引用，不得改名');
    assert.match(chatHtml, /<div class="history-rail" id="chatHistoryRail">/,
        '缺少刻度带宿主');
    assert.match(chatHtml, /<div class="history-rail-track" id="chatHistoryRailTrack">/,
        '缺少轨道容器');
    assert.match(chatHtml, /<div class="history-rail-tip" id="chatHistoryRailTip">/,
        '缺少摘要浮层宿主');
    // 宿主不得带 hidden 属性：显隐由 .is-visible 类控制，hidden 会与 display:flex 打架
    assert.ok(!/<div class="history-rail"[^>]*\shidden\b/.test(chatHtml),
        'history-rail 不得带 hidden 属性（会与 .is-visible 的 display:flex 冲突）');
});

test('messagesWrap 必须包在 messages-shell 内（并排而非覆盖）', () => {
    const shellIdx = chatHtml.indexOf('id="messagesShell"');
    const wrapIdx = chatHtml.indexOf('id="messagesWrap"');
    const railIdx = chatHtml.indexOf('id="chatHistoryRail"');
    assert.ok(shellIdx > 0 && wrapIdx > shellIdx && railIdx > wrapIdx,
        '顺序必须是 shell → messagesWrap → rail（同父并排）');
});

test('CSS：.messages-shell 是 flex 行且两个 min-* 约束齐全', () => {
    const rule = cssRule('.messages-shell');
    assert.match(rule, /display:\s*flex/, '.messages-shell 必须是 flex 容器');
    assert.match(rule, /min-height:\s*0/, '缺 min-height:0：flex 子项默认 auto 会被内容撑高，输入框被顶出视口');
    assert.match(rule, /min-width:\s*0/, '缺 min-width:0：同理横向溢出');
    // 滚动区在其中必须 flex:1
    assert.match(css, /\.messages-shell > \.messages-wrap \{[^}]*flex:\s*1/,
        '滚动区必须在 shell 内 flex:1');
});

test('CSS：轨道是固定宽度的 flex 列，不是绝对定位覆盖层', () => {
    const rule = cssRule('.history-rail');
    assert.match(rule, /flex:\s*0 0 auto/, '轨道必须是不伸缩的固定列');
    assert.match(rule, /width:\s*26px/, '轨道宽度应为 26px');
    assert.ok(!/position:\s*(absolute|fixed)/.test(rule),
        '轨道不得用 absolute/fixed：那会压住 .messages-wrap 的原生滚动条，挡住拖动');
    assert.match(rule, /display:\s*none/, '默认必须隐藏（无消息时不占位）');
    assert.match(cssRule('.history-rail.is-visible'), /display:\s*flex/,
        '有消息时必须显示为 flex 列');
});

/* ============ 3. 等距定位（每条消息一根，固定间距） ============ */

test('刻度按固定步距排列：消息几条就几根，与正文高度无关', () => {
    const body = fnBody(js, 'computeRailTops');
    /* 【语义两次演进】v1 是 offset/scrollHeight 缩略地图（已否）；
       v2 是「铺满轨道的等距」（0%~100%）；v3（当前）用户拿参照稿指出
       「你间隔这么大干嘛，按照后面的间隔就行了」—— 参照稿是一排紧凑短横。
       现在的位置模型 = 固定步距 + 整簇居中，核心约束仍是「只依赖序号与轨道高」。 */
    assert.ok(!/scrollHeight/.test(codeOnly(body)),
        '刻度定位不得读 scrollHeight：位置只依赖序号与轨道高，与正文高度无关');
    assert.ok(!/getBoundingClientRect/.test(codeOnly(body)),
        '不得测消息行 DOM 位置：图片/代码高亮导致的分部重排会让刻度抖动');
    /* 步距必须是常量而非「轨道高/(n-1)」：后者是铺满模型，8 条消息就会拉开成 96px 一根。
       断言的是「步距有上限」这个设计意图，不钉具体像素值。 */
    assert.match(codeOnly(body), /Math\.min\(\s*HISTORY_RAIL_STEP_PX\s*,/,
        '步距必须取 min(HISTORY_RAIL_STEP_PX, 可用高度/(n-1))：' +
        '既保证稀疏时紧凑（对齐参照稿），又保证密集时不溢出轨道。实际实现：' + body);
    /* 整簇居中：首根位置 = (轨道高 - 步距*(n-1))/2，而不是写死的 0。 */
    assert.match(codeOnly(body), /\(trackH - step \* \(n - 1\)\) \/ 2/,
        '整簇必须垂直居中（首根留出 (trackH - 簇高)/2），否则刻度会贴在轨道顶边');
});

test('【行为】computeRailTops 真实输出：固定步距、整簇居中、密集时压缩不溢出', () => {
    const body = fnBody(js, 'computeRailTops');
    /* 【步距不写死】具体像素是视觉决策，会随参照稿调整（16→32 已发生过一次）。
       测试若钉死数值，每次调样式都要改测试，久而久之就是「把断言改成新值陪跑」。
       改为从源码提取常量，断言的是【行为契约】：恒定步距 + 居中 + 装不下才压缩。 */
    const STEP = Number(/var HISTORY_RAIL_STEP_PX = (\d+);/.exec(js)[1]);
    assert.ok(STEP > 0, '必须声明 HISTORY_RAIL_STEP_PX 常量');
    const sandbox = { HISTORY_RAIL_STEP_PX: STEP };
    vm.runInNewContext(body + '\nthis.__tops = computeRailTops;', sandbox);
    /* 【必须 Array.from】vm 里的数组属于另一个 realm，deepEqual 严格模式会因
       Array.prototype 不同而失败，且报告只有“[]”这种看不出所以然的值。 */
    const tops = (h, n) => Array.from(sandbox.__tops(h, n));
    const TRACK = 676;

    assert.deepEqual(tops(TRACK, 0), [], '空集合返回空数组');
    assert.deepEqual(tops(0, 5), [], '轨道未布局（高 0）时返回空：调用方据此跳过写样式');
    assert.deepEqual(tops(TRACK, 1), [TRACK / 2],
        '单根放在轨道正中（放顶边会因 translateY(-50%) 一半溢出）');

    /* 【本轮的验收口径】8 条消息不再拉开成 96px 一根：
       间距必须恒为 STEP（当前 32px，见 HISTORY_RAIL_STEP_PX），截图上的「间隔这么大」就此消失。
       【不在注释里写死数值】STEP 已从 16 调过 32，钉死数字的注释当时就对不上实现，
       下一个人会照着注释「修回 16」—— 注释里的具体值必须写成对常量的引用。 */
    const eight = tops(TRACK, 8);
    const gaps8 = eight.slice(1).map((v, i) => v - eight[i]);
    assert.deepEqual(gaps8.map((g) => +g.toFixed(4)), new Array(7).fill(STEP),
        '8 条时间距必须恒为 ' + STEP + 'px（铺满模型下这里是 96.57px），实测=' + JSON.stringify(gaps8));
    /* 这条是用户抱怨的直接验收项：「你间隔这么大干嘛」——间距不得随条数变化。 */
    assert.deepEqual(tops(TRACK, 3).slice(1).map((v, i) => +(v - tops(TRACK, 3)[i]).toFixed(4)),
        [STEP, STEP], '3 条时间距同样是 ' + STEP + 'px：间距与条数无关（否则 3 条会拉开成 338px）');

    /* 整簇居中：首尾到轨道两端的留白必须相等（这是「一小簇居中」而非「铺满」的判据）。 */
    const headGap = eight[0];
    const tailGap = TRACK - eight[eight.length - 1];
    assert.ok(Math.abs(headGap - tailGap) < 1e-6,
        '整簇必须垂直居中：上留白 ' + headGap + ' vs 下留白 ' + tailGap);

    /* 与消息内容无关：文本长度悬殊不得影响位置。 */
    assert.deepEqual(tops(TRACK, 2), tops(TRACK, 2), '同参数必须确定性输出');

    /* 密集时必须压缩到刚好铺满而不是溢出：60 根 × STEP > 676px。 */
    const many = tops(TRACK, 60);
    assert.equal(many.length, 60, '60 条必须产生 60 根刻度');
    assert.ok(many[0] >= 0 && many[59] <= TRACK + 1e-6,
        '密集时不得溢出轨道：首=' + many[0].toFixed(2) + ' 末=' + many[59].toFixed(2));
    assert.equal(+many[0].toFixed(4), 0, '装不下时整簇铺满轨道：首根贴顶（0）');
    assert.equal(+many[59].toFixed(4), TRACK, '装不下时整簇铺满轨道：末根贴底（= 轨道高）');
    const gaps60 = many.slice(1).map((v, i) => v - many[i]);
    assert.ok(gaps60.every((g) => Math.abs(g - gaps60[0]) < 1e-6),
        '压缩后仍必须严格等距，实测=' + JSON.stringify(gaps60.slice(0, 3)));
});

test('渲染时刻度用 css top 写成像素（与 computeRailTops 同源）', () => {
    const body = fnBody(js, 'renderHistoryRail');
    /* 百分比表达不了「固定步距」：只能铺满 0~100。改用像素后，
       「一小簇居中」才可能实现（首根不是 0%）。 */
    assert.match(body, /top:' \+ topPx\.toFixed\(2\) \+ 'px/,
        '刻度必须用 top:<px> 定位，且与 tops 同源（否则画法与算法会漂移）');
    assert.match(body, /data-rail-top=/, '必须把像素位置写进 data-rail-top，供重算与断言核对');
    /* 【时序护栏】px 定位依赖容器已布局：display:none 时 clientHeight 恒为 0，
       算出的 tops 全是 0，全部刻度叠在顶边。必须先 addClass('is-visible') 再测高。 */
    const code = codeOnly(body);
    const vis = code.indexOf("addClass('is-visible')");
    const measure = code.indexOf('clientHeight');
    assert.ok(vis >= 0 && measure >= 0 && vis < measure,
        '必须先让轨道可见再读 clientHeight（否则 display:none 下测到 0，刻度全叠顶边）：' +
        'addClass@' + vis + ' clientHeight@' + measure);
});

test('刻度命中区与视觉线分离（裸 2px 线点不中），且命中区由变量控制防重叠', () => {
    const tickRule = cssRule('.history-rail-tick');
    assert.match(tickRule, /width:\s*26px/, '命中区宽度 26px');
    /* 命中区高度不钉具体像素（视觉决策），但必须满足两件事：
       ① 明显大于视觉线（否则 2px 细线无法可靠点击）；
       ② 【本轮新增】必须是可被 JS 收窄的变量 —— 等距下刻度间距 = 轨道高/(N-1)，
          N 大时间距会小于固定高度，相邻命中区重叠，点击归属由 DOM 顺序决定。
          实测 N=60 / 轨道 680px 时间距 11.45px < 固定 12px，重叠 0.55px，真实浏览器已复现。 */
    const hitH = /height:\s*var\(\s*--tick-hit\s*,\s*(\d+)px\s*\)/.exec(tickRule);
    assert.ok(hitH, '命中区高度必须是 var(--tick-hit, <回退值>)：变量缺省时回退到少量刻度的舒适尺寸' +
        '，存在时由 JS 按实际间距收窄以避免重叠。实际规则：' + tickRule);
    const lineRule = cssRule('.history-rail-tick-line');
    const lineH = /height:\s*(\d+)px/.exec(lineRule);
    assert.ok(lineH, '视觉线必须有显式高度');
    assert.ok(Number(hitH[1]) >= Number(lineH[1]) * 4,
        '回退命中区须明显大于视觉线（否则 2px 细线无法可靠点击）：' + hitH[1] + ' vs ' + lineH[1]);
    assert.match(tickRule, /position:\s*absolute/, '刻度须绝对定位到 --pct 对应位置');
    assert.match(tickRule, /transform:\s*translateY\(-50%\)/, '须以自身中心对齐百分比位置');
    assert.match(lineRule, /height:\s*2px/, '视觉线 2px');
    /* 普通刻度长度：只要「短于 active」，不钉具体值 */
    const baseW = /width:\s*(\d+)px/.exec(lineRule);
    assert.ok(baseW, '普通刻度必须有显式宽度');
    const activeRule = cssRule('.history-rail-tick.is-active .history-rail-tick-line');
    const activeW = /width:\s*(\d+)px/.exec(activeRule);
    assert.ok(activeW && Number(activeW[1]) > Number(baseW[1]),
        'active 必须比普通刻度长：' + (activeW && activeW[1]) + ' vs ' + baseW[1]);
    /* 命中区高度必须真的被写入（写了变量名却没人赋值 ≡ 从未生效） */
    assert.match(fnBody(js, 'applyRailTickHitHeight'), /setProperty\(\s*'--tick-hit'/, '必须由 applyRailTickHitHeight 写入 --tick-hit');
    const hitCalc = fnBody(js, 'computeRailTickHitHeight');
    assert.match(hitCalc, /trackH\s*\/\s*\(\s*count\s*-\s*1\s*\)/,
        '可用高度必须 = 轨道高/(根数-1)，否则算不出真实间距');
});

test('刻度右对齐成隐形基线（靠右而不是靠左）', () => {
    /* 【本仓 CRLF 坑】app.css 是纯 CRLF，正则里写 \n 会永远匹不上。
       这里用 [^}]* 跳过空白，不关心具体换行。 */
    const tickRule = cssRule('.history-rail-tick');
    assert.match(tickRule, /justify-content:\s*flex-end/,
        '刻度必须右对齐（justify-content: flex-end）—— 改为 flex-start 会让长短不一的刻度左缘对齐、' +
        '右缘器差不齐，整排看起来像意外而非底座');
    assert.match(tickRule, /right:\s*0/, '刻度必须贴轨道右缘（right: 0）');
});

test('active 只靠长度与颜色区分，不加粗（对齐参照稿）', () => {
    const rule = cssRule('.history-rail-tick.is-active .history-rail-tick-line');
    assert.match(rule, /background:\s*var\(--text-primary\)/,
        'active 必须用 --text-primary（与普通刻度的 --text-tertiary 拉开两个阶）—— ' +
        '只断言存在 background 不够：写成与普通刻度同色时，active 就只剩长度差异，滚动中极难识别');
    /* 【设计约束】参照稿里当前项与其余刻度厚度完全一致，只是更长更深。
       一旦给 active 写 height 就会变成「一条被高亮的线」，破坏「同一排里的一根」的观感。
       这条断言钉的是设计意图，不是具体像素。 */
    assert.ok(!/height:/.test(rule),
        'active 不得改 height：加粗会把它从「同一排里的一根」变成「被高亮的独立线」');
    const base = cssRule('.history-rail-tick-line');
    assert.match(base, /transition:[^;]*width/, '长度变化须有过渡，否则悬停跳变');
});

test('轨道不画贯穿竖线（参照稿只有一排悬浮短横）', () => {
    const trackRule = cssRule('.history-rail-track');
    /* 竖线会让整条轨道看起来像滚动条，暗示「可拖动」，而它只是导航刻度。
       断言「规则体里没有 background」，而不是去断言 ::after 不存在 ——
       cssRule 只取主规则体，::after 是另一条规则。 */
    assert.ok(!/background/.test(trackRule), '.history-rail-track 本体不得画背景（会被读成滚动条轴）');
    const full = css;
    const afterRule = /\.history-rail-track::after\s*\{([^}]*)\}/.exec(full);
    assert.ok(!afterRule || !/background/.test(afterRule[1]),
        '不得用 ::after 画贯穿竖线');
});

/* ============ 4. active 跟随滚动 ============ */

test('active 判定用「视口顶沿断点」，不得回到中线锚点或跨尺度归一化', () => {
    const body = fnBody(js, 'resolveRailActiveIdx');
    assert.match(body, /scrollTop/, '必须用 scrollTop 参与判定');
    /* 【语义变更】上一版用 anchor = scrollTop + clientH/2（视口中线）。刻度按内容真实比例
       摆位时那是对的；但刻度改成【等距】后两套坐标系不同源：刻度位置回答「第几条」，
       中线锚点回答「内容滚到哪」。实测（真实浏览器）点击第 0~4 根后 active 全部落到末根
       —— 因为 scrollIntoView(block:'start') 后 scrollTop = 消息顶边，
       而 midline = 顶边 + 350px 早已越过后面好几条消息。点第 3 根高亮第 6 根。
       现改用「scrollTop 越过各消息顶边」的像素断点，天然满足点击自洽。 */
    assert.ok(!/anchor\s*=\s*scrollTop\s*\+\s*clientH\s*\/\s*2/.test(body),
        '不得再用视口中线作锚点：等距刻度下它与序号坐标不同源，点击后会高亮到别的消息');
    assert.ok(!/clientHeight\s*\/\s*2/.test(body),
        '不得出现 clientHeight/2 的任何变形（中线锚点的标志）');
    assert.match(body, /breakpoint/, '必须用「断点」概念（消息顶边在内容坐标系里的位置）');
    assert.match(body, /getBoundingClientRect\(\)\.top/, 
        '断点必须由 getBoundingClientRect().top 算出（内容坐标系）');
    /* 反模式一：把滚动进度与内容比例两个不同尺度归一化后相减 */
    assert.ok(!/scrollTop\s*\/\s*denom|\/\s*\(\s*scrollH\s*-\s*clientH\s*\)/.test(body),
        '不得再出现 scrollTop/(scrollHeight-clientHeight) 这类「滚动进度」归一化');
    assert.ok(!/Math\.abs\(q\s*-\s*p\)/.test(body),
        '不得再把两个不同尺度的归一化量相减取距离');
    /* 反模式二：未钳位的末条断点 —— 末条顶边超出可滚动上限时该断点永不达达 */
    assert.match(body, /Math\.min\(\s*offset\s*,\s*denom\s*\)/,
        '末条断点必须钳到 Math.min(offset, denom)：其顶边超出可滚动上限时否则永远不可达，' +
        '表现为「滚到底 active 停在倒数第二条」');
});

/* ============ 4b. 真实行为（跑真函数，不是猜源码） ============
   源码正则只能证明「写了什么形状」，证明不了「算出来对不对」。
   下面两条用 vm 载入真实的 resolveRailActiveIdx / showHistoryRailTip，
   配可控 DOM 桩跑一遍，断言数值结果本身。
   DOM 桩范式沿用本仓既有做法（file-changes-ui.test.js 的手写 makeEl），不引入 jsdom。 */

/** 造一个滚动容器桩：scrollH / clientH / scrollTop 可控，wrapTop 固定。
 *  行桩按「内容坐标 offset」反推 getBoundingClientRect().top，
 *  与真实浏览器一致：rect.top = wrapTop + offset − scrollTop。 */
function makeWrapStub(o) {
    const wrapTop = o.wrapTop == null ? 100 : o.wrapTop;
    return {
        wrapTop,
        scrollHeight: o.scrollH,
        clientHeight: o.clientH,
        scrollTop: o.scrollTop,
        getBoundingClientRect() { return { top: wrapTop }; },
    };
}
function makeRowStub(offset, wrap) {
    return {
        offset,
        getBoundingClientRect() { return { top: wrap.wrapTop + offset - wrap.scrollTop }; },
    };
}
/** 宽松几何：8 条用户消息（各 200px）夹 8 条回答（各 400px）→ user i 偏移 = i*600，总高 4800。 */
function makeRailScene(scrollTop, clientH) {
    const wrap = makeWrapStub({ scrollH: 4800, clientH: clientH == null ? 600 : clientH, scrollTop });
    const items = [];
    for (let i = 0; i < 8; i++) items.push({ msgIdx: i, row: makeRowStub(i * 600, wrap) });
    return { wrap, items };
}

/** 密集几何：复刻真实浏览器实测值（scrollH=1571 / clientH=741 / 8 条消息，每条仅约 196px）。
 *  【为什么必须单独有这个场景】宽松几何下 clientH/2 = 300 < 消息间距 600，
 *  端点会【侥幸】成立，于是掩盖了「消息密集时中线规则两端失效」这个真实回归：
 *    · 滚到顶 anchor=370.5，而第 2 条 offset≈196 已越过它 → 误选 msg1；
 *    · 滚到底 anchor=1200.5，而末条 offset≈1372 > anchor → 够不到，停在 msg6。
 *  测试几何若比真实场景宽松，就等于没测。 */
function makeDenseRailScene(scrollTop) {
    const scrollH = 1571, clientH = 741;
    const wrap = makeWrapStub({ scrollH, clientH, scrollTop });
    const step = scrollH / 8;                       // ≈196.4，与真实实测同量级
    const items = [];
    for (let i = 0; i < 8; i++) items.push({ msgIdx: i, row: makeRowStub(i * step, wrap) });
    return { wrap, items, scrollH, clientH, denom: scrollH - clientH };
}
/** 用 vm 载入真实函数，注入 messagesWrap 桩。 */
function loadRealActiveResolver(wrap) {
    const body = fnBody(js, 'resolveRailActiveIdx');
    const sandbox = { messagesWrap: wrap };
    vm.runInNewContext(body + '\nthis.__resolve = resolveRailActiveIdx;', sandbox);
    return (items) => sandbox.__resolve(items);
}

test('【行为】active 与「视口顶沿已越过的最后一条」一致（等距轨道的唯一自洽语义）', () => {
    const fracs = [0, 0.2, 0.35, 0.5, 0.7, 0.85, 1];
    const rows = [];
    for (const f of fracs) {
        const denom = 4800 - 600;
        const scrollTop = Math.round(f * denom);
        const { wrap, items } = makeRailScene(scrollTop, 600);
        const resolve = loadRealActiveResolver(wrap);
        const got = resolve(items);
        /* 真值：内容坐标里「顶边已被 scrollTop 越过」的最后一条。
           这与等距刻度的「第几条」语义同源：点击第 i 根 → scrollTop = o_i → active = i。 */
        let truth = 0;
        for (const it of items) {
            const bp = it.msgIdx === items.length - 1 ? Math.min(it.row.offset, denom) : it.row.offset;
            if (bp <= scrollTop + 0.5) truth = it.msgIdx;
        }
        if (scrollTop <= 0) truth = 0;
        else if (denom - scrollTop <= 1) truth = items[items.length - 1].msgIdx;
        rows.push({ f, scrollTop, got, truth });
    }
    const bad = rows.filter((r) => r.got !== r.truth);
    assert.equal(bad.length, 0,
        'active 与顶沿断点不一致的采样点: ' + JSON.stringify(bad) +
        ' 全部: ' + rows.map((r) => r.f + '→' + r.got).join(' '));
});

test('【行为·核心回归】点击第 i 根刻度后 active 必须是第 i 根（中线锚点下会跑到末根）', () => {
    /* 这是本轮 codereview 最重要的回归锁。真实浏览器实测（修复前）：
       S1 矮消息+长尾巴：点第 0~4 根，active 全部变成末根（错 5/6）；
       S2 长回答在前：点第 1~5 根，active 全变成第 3 根（错 4/6）；
       根因就是中线锚点：scrollIntoView(block:'start') 把消息顶边对齐到视口顶，
       而 midline = 顶边 + clientH/2 早已越过后面好几条。

       【几何前提】本测试构造的是「每条消息都真的能滚到顶沿」的会话：
       末尾有足够长的尾部占位（模拟长回答），所以每条消息的顶边都 < 可滚动上限。
       这是 resolveRailActiveIdx 能独立保证点击自洽的充要条件。
       消息挤在底部（顶边超过可滚动上限）的会话确实无法只靠几何区分 ——
       那一类靠 historyRailPinnedIdx（点击锚定）解决，详见下一个测试。 */
    const scenes = [
        { label: '矮消息+长尾巴', heights: [40, 40, 40, 40, 40, 40], tail: 4000, clientH: 700 },
        { label: '均匀+长尾巴', heights: [300, 300, 300, 300, 300, 300], tail: 2000, clientH: 700 },
        { label: '全是长消息', heights: [700, 700, 700, 700, 700, 700], tail: 0, clientH: 700 },
    ];
    const failures = [];
    for (const sc of scenes) {
        const offsets = [];
        let acc = 0;
        for (const h of sc.heights) { offsets.push(acc); acc += h; }
        const scrollH = acc + sc.tail;
        const denom = scrollH - sc.clientH;
        for (let i = 0; i < offsets.length; i++) {
            if (offsets[i] > denom + 0.5) continue; // 该消息根本滚不到顶沿，不属本测试管辖
            const wrap = makeWrapStub({ scrollH, clientH: sc.clientH, scrollTop: offsets[i] });
            const items = offsets.map((off, k) => ({ msgIdx: k, row: makeRowStub(off, wrap) }));
            const got = loadRealActiveResolver(wrap)(items);
            if (got !== i) failures.push({ scene: sc.label, click: i, active: got, scrollTop: offsets[i] });
        }
    }
    assert.equal(failures.length, 0,
        '点击刻度后 active 必须锁定在同一根（否则导航失效）：' + JSON.stringify(failures));
});

test('【卫生·防复发】源码与注释不得泄漏本机主目录', () => {
    /* 本轮 codereview 抓到的真实污染：注释原写「0%~100%」，补丁是在 PowerShell 内联命令里
       拼字符串提交的，PS 会把 ~ 展开成当前用户目录，于是源码注释变成
       「0% C:\<Users>\<用户名> 100%」。性质比一般笔误重两级：
       ① 注释不再是作者想表达的事实，而下一个人会把它当文档；
       ② 把本地用户名/机器名写进仓库。
       既有测试【不会】因此变红 —— 没有一条断言会看注释里的路径，所以必须显式立一条。 */

    /* 【名单绝不硬编码】不把具体用户名写进本测试，否则这条测试自身又把名字写进了仓库。
       改为从 os.homedir() 动态取：在任何开发机与 CI 上都能抓住同类污染，
       并且天然覆盖 Windows / Linux / macOS 三种主目录布局。 */
    const os = require('node:os');
    const home = os.homedir();
    const user = path.basename(home);
    const homeParent = path.dirname(home);
    const targets = [
        ['app-history.js', js],
        ['app.css', css],
        ['chat.html', chatHtml],
        ['app-base.js', appBase],
    ];

    /* 1) 绝不允许出现「本机主目录」本身 */
    for (const pair of targets) {
        assert.ok(!pair[1].includes(home),
            pair[0] + ' 含本机主目录（' + home + '）：源码不得携带构建机路径。'
            + '根因：补丁在 PowerShell 内联命令里拼字符串时 ~ 会被展开成该路径并写进文件。'
            + '做法：补丁一律落成脚本文件再用 node 执行。');
    }

    /* 2) 也不允许出现「别人机器上的」用户目录形态（换台机器照样中招） */
    const userDirRe = /[\\/]Users[\\/][A-Za-z0-9_.-]{2,}[\\/]|[\\/]home[\\/][A-Za-z0-9_.-]{2,}[\\/]|[\\/]Users[\\/][A-Za-z0-9_.-]{2,}(?![\\/])|[\\/]home[\\/][A-Za-z0-9_.-]{2,}(?![\\/])/;
    for (const pair of targets) {
        assert.ok(!userDirRe.test(pair[1]),
            pair[0] + ' 含用户目录形状的路径（疑似构建机信息泄漏，父目录=' + homeParent + '）');
    }

    /* 3) 自证（本仓多次踩过的坑：正则写错时护栏沉默常绿）
       —— 把真实主目录塞进一段样本文本，必须被上面的式子命中。 */
    const probeWin = homeParent + '\\' + user + '\\x.txt';
    const probeUnix = '/home/' + (user || 'someone') + '/x.txt';
    assert.ok(userDirRe.test(probeWin) || userDirRe.test(probeUnix),
        '检测必须能命中真实主目录形态，否则本护栏是假绿（home=' + home + '）');
});

test('【护栏·跨调用点】所有画 active 的地方都必须走同一入口，不得有人绕过锚定', () => {
    /* 本轮 codereview 实测出的真实缺陷（不是理论风险）：
       paintRailActive 有四个调用点，其中三处先读 historyRailPinnedIdx，
       唯独 relayoutHistoryRailTicks 直接调 resolveRailActiveIdx。
       真实浏览器后果：点第 3 根刻度 → active=3，随后内容异步撑高触发 ResizeObserver
       → relayout → active 被冲成 0。用户刚点的那一根自己跳走了。
       修法不是给 relayout 补一个 if（那是第四处 if，下一处新增调用点还会漏），
       而是把判定收敛成 railActiveIdxFor() 唯一入口，并用本测试钉住：
       ① 源码里不得再有「paintRailActive(x, resolveRailActiveIdx(x))」这种绕过形态；
       ② 每个 paintRailActive 调用的第二参必须是 railActiveIdxFor 或字面量/变量锚定值；
       ③ 自证：确实扫到了 >= 4 个调用点，防止正则失配导致护栏恒绿。 */
    const code = codeOnly(js);
    const bypass = /paintRailActive\s*\([^)]*resolveRailActiveIdx/s;
    assert.ok(!bypass.test(code),
        '存在绕过统一入口的 paintRailActive(...resolveRailActiveIdx(...))：' +
        '点击锚定会在该路径被冲掉（实测 3→0）。');

    /* 【必须排除函数定义本身】/paintRailActive\s*\(/ 会同时命中
       「function paintRailActive(items, msgIdx) {」这一行定义 —— 实测第一轮就把它
       当成违规调用点，护栏自己恒红。护栏恒红和恒绿一样有害：下一个真缺陷会被
       既定噪声淹没。判据改为「前面不是 function 关键字」。 */
    const callRe = /paintRailActive\s*\(/g;
    const sites = [];
    let m;
    while ((m = callRe.exec(code))) {
        const before = code.slice(Math.max(0, m.index - 12), m.index);
        if (/function\s*$/.test(before)) continue;          // 定义，不是调用
        const seg = code.slice(m.index, code.indexOf(';', m.index));
        sites.push(seg);
    }
    assert.ok(sites.length >= 4,
        '自证：必须扫到 >= 4 个 paintRailActive 调用点，只扫到 1~2 个说明正则失配、护栏是假绿。实际=' + sites.length);
    const bad = sites.filter((seg) => !/railActiveIdxFor|collectSampledRailItems\(\)\s*,\s*msgIdx/.test(seg));
    assert.deepEqual(bad, [],
        '每个 paintRailActive 都必须经 railActiveIdxFor 决定 active（点击定位那处的 msgIdx 本身就是锚定值，合法）。');

    /* relayout 是本轮缺陷本体，单独钉一次，避免它以后被改名或合并进别的函数而漏网。 */
    const relayout = fnBody(js, 'relayoutHistoryRailTicks');
    assert.match(relayout, /railActiveIdxFor\s*\(sampled\)/,
        'relayoutHistoryRailTicks 必须走统一入口（内容撑高不得把用户刚点的刻度冲掉）');
    /* 反向护栏：不得用「加个 if 就地补」的方式回退成四处各写一遍 */
    assert.ok(!/historyRailPinnedIdx\s*>=\s*0\s*\?/.test(codeOnly(relayout)),
        'relayout 里不得重写一遍锚定三元式 —— 那会重新造出口径漂移的面，必须复用入口');
});

test('【行为·锚定失效】平滑滚动途中不得提前失效；到达后滚离才交还几何判据', () => {
    /* 我第一版的失效条件是「目标行还在视口内才保持锚定」，看起来合理，实际会把
       另一条设计目标弄坏：smooth 滚动还没到位时目标行不在视口内 → 锚定被判失效 →
       高亮先跳到「半路」那条、到位后再跳回来。而「不会先跳到别处再回来」正是加锚定的理由。
       所以实现改成两段式：historyRailPinArrived 记录「到达过」；未到达一律保持锚定，
       到达过且已离开视口才释放。本测试用真实源码切片把这条时序跑出来。 */
    const src = js;
    const relevant = fnBody(src, 'railPinStillRelevant');
    const entry = fnBody(src, 'railActiveIdxFor');

    /* 静态契约： arrived 位必须存在、必须在三处被正确维护 */
    assert.match(src, /var\s+historyRailPinArrived\s*=\s*false/, '必须存在 historyRailPinArrived 状态位');
    assert.match(fnBody(src, 'locateUserMessage'), /historyRailPinArrived\s*=\s*false/,
        '每次新点击必须重置「已到达」，否则上一轮的到达状态会污染新一轮滚动途中');
    assert.match(relevant, /historyRailPinArrived\s*=\s*true/, '命中视口时必须置位「已到达」');
    assert.match(relevant, /return\s+inView\s*\|\|\s*!historyRailPinArrived/,
        '失效判据必须是「到达过 且 已离开视口」，不能是裸的 inView（那会造成滚动途中提前失效）');
    assert.match(fnBody(src, 'releaseRailPin'), /historyRailPinArrived\s*=\s*false/,
        'wheel/touchmove 释放锚定时必须一并重置到达位');

    /* 行为：用桩把三种真实几何跑一遍（滚动途中 / 到达 / 到达后滚离） */
    const mkWrap = (top, bottom) => ({ getBoundingClientRect: () => ({ top, bottom }) });
    const mkItem = (msgIdx, rTop, rBottom) => ({ msgIdx, row: { getBoundingClientRect: () => ({ top: rTop, bottom: rBottom }) } });
    const load = () => {
        const box = {
            messagesWrap: null, historyRailPinnedIdx: -1, historyRailPinArrived: false,
            resolveRailActiveIdx: (items) => items.length ? items[items.length - 1].msgIdx : -1,
        };
        const code = 'var historyRailPinArrived = false;\n'
            + 'var historyRailPinnedIdx = -1;\n'
            + 'var messagesWrap = { getBoundingClientRect: function(){ return __wrapRect; } };\n'
            + relevant + '\n' + entry + '\n'
            + 'this.__call = function(idx, arrived, items){ historyRailPinnedIdx = idx; historyRailPinArrived = arrived; return railActiveIdxFor(items); };'
            + 'this.__rel = function(idx, arrived, items){ historyRailPinnedIdx = idx; historyRailPinArrived = arrived; return railPinStillRelevant(items); };';
        vm.runInNewContext(code, Object.assign(box, { __wrapRect: { top: 0, bottom: 700 } }), { filename: 'rail-pin-stub' });
        return box;
    };

    const b = load();
    /* 场景 1：滚动途中 —— 目标行在视口外（还没滚到），未到达 → 必须仍返回锚定值 */
    const mid = [mkItem(0, 0, 100), mkItem(3, 2000, 2400)];   // wrap 是 0..700，3 在视口外
    assert.equal(b.__rel(3, false, mid), true,
        '滚动途中（未到达 + 目标不在视口）锚定必须仍然有效，否则高亮会先跳别处再回来');
    assert.equal(b.__call(3, false, mid), 3, '滚动途中 active 必须仍是用户点的那根');

    /* 场景 2：到达 —— 目标行进入视口 → 有效，且到达位被置起 */
    assert.equal(b.__rel(3, false, [mkItem(0, 0, 100), mkItem(3, 600, 900)]), true, '到达后必须有效');
    assert.equal(b.historyRailPinArrived, true, '命中视口必须置「已到达」位');

    /* 场景 3：到达过又滚离（例如拖原生滚动条 / 新消息自动滚到底）—— 必须交还几何判据
       这正是旧实现的漏网场景：它不发 wheel，所以 releaseRailPin 永远不会被调到。 */
    const left = b.__rel(3, true, [mkItem(3, -4000, -3600)]);
    assert.equal(left, false, '到达过且已离开视口 → 锚定必须失效（否则 active 永久钉死在旧位置）');
    assert.equal(b.__call(3, true, [mkItem(0, 0, 100), mkItem(5, 100, 200)]), 5,
        '锚定失效后必须回退几何判据（这里桩里返回末条）而不是继续返回 3');

    /* 场景 4：集合里已经没有那条（切会话/整批替换）→ 失效，不得去高亮不存在的刻度 */
    assert.equal(b.__rel(99, true, [mkItem(0, 0, 100)]), false, '锚定指向已不存在的消息时必须作废');
});

test('【行为·点击锚定】消息挤在底部时几何无法区分，必须由 historyRailPinnedIdx 接管', () => {
    /* 为什么必须有锚定：末条消息的顶边可以【超过】可滚动上限（首条很高的会话里，
       后面几条都贴不到顶沿），此时它们全部对应同一个 scrollTop（= denom）。
       几何上无解 —— 任何纯几何规则都无法区分“点第 2 根”与“点第 5 根”。
       唯一正确的答案是「用户刚点的那一根」。

       本测试锁两件事：① 源码里确实存在这个锚定变量并参与滚动跟随；
       ② 锚定只在手动滚动（wheel/touchmove/翻页键）时释放，不靠定时器猜。 */
    assert.match(js, /var\s+historyRailPinnedIdx\s*=\s*-1/,
        '必须存在 historyRailPinnedIdx 锚定变量');
    assert.match(fnBody(js, 'locateUserMessage'), /historyRailPinnedIdx\s*=\s*msgIdx/,
        '点击定位必须先写锚定 —— 否则平滑滚动过程中高亮会先跳到别处再回来');
    /* 【断言对象从「形状」升级为「行为」】旧写法直接匹配 historyRailPinnedIdx >= 0，
       那是把旧的代码形状钉成正确形状：本轮把「该高亮哪一根」的判定收敛成
       railActiveIdxFor() 单一入口后，锚定读取搬进了那个函数，旧断言立刻假红。
       现在钉的是行为契约：滚动回调必须走统一入口，且统一入口本身必须优先读锚定。
       这样重构（搬位置）不再触发假红，而「绕过入口直接算」仍会被抓。 */
    const scrollHandler = js.slice(js.indexOf('$(messagesWrap).on(\'scroll\''));
    assert.match(scrollHandler.slice(0, 1200), /railActiveIdxFor\s*\(/,
        '滚动跟随必须走 railActiveIdxFor 统一入口（不得自行调 resolveRailActiveIdx）');
    assert.ok(!/resolveRailActiveIdx\s*\(/.test(scrollHandler.slice(0, 1200)),
        '滚动回调里不得出现第二处 resolveRailActiveIdx —— 那等于绕过锚定');
    const entryBody = fnBody(js, 'railActiveIdxFor');
    assert.match(entryBody, /historyRailPinnedIdx\s*>=\s*0/,
        '统一入口必须优先读锚定值（锚定的语义就在这里）');
    assert.match(entryBody, /resolveRailActiveIdx\s*\(items\)/,
        '锚定不适用时必须回退几何判据');
    /* 释放时机：手动滚动信号，不是定时器 */
    assert.match(js, /on\(\s*'wheel touchmove'\s*/,
        '手动滚动（wheel/touchmove）必须释放锚定');
    assert.match(js, /releaseRailPin\(\)/, '必须存在 releaseRailPin 入口');
    assert.ok(!/historyRailPinnedIdx\s*=\s*-1[\s\S]{0,80}setTimeout/.test(
        js.slice(js.indexOf('function releaseRailPin'), js.indexOf('function releaseRailPin') + 300)),
        '释放不得靠定时器：慢速设备会过早/过晚失效');
    /* 会话切换/集合重建时锚定必须失效（msgIdx 是会话内序号，跨会话复用会命中别人的消息） */
    const renderBody = fnBody(js, 'renderHistoryRail');
    assert.match(renderBody, /historyRailPinnedIdx\s*=\s*-1/,
        '空集合/会话切换时必须清锚定，否则旧 msgIdx 会命中新会话的别条消息');
    /* 【更强的一条】光有赋值不够：必须确认它在【不可见分支】里执行，且重建后
       不直接用锚定值画画（集合换了，那个 msgIdx 可能不存在了）。 */
    assert.match(renderBody, /if\s*\(\s*!visible\s*\)\s*\{[\s\S]{0,400}historyRailPinnedIdx\s*=\s*-1/,
        '锚定清零必须在「轨道隐藏」分支内（会话切走/无消息时）');
    /* 【行为意图不变，断言对象随实现搬家】原断言钉的是 renderHistoryRail 里的
       sampled.some(...)；本轮把「锚定是否仍适用」收敛进 railActiveIdxFor /
       railPinStillRelevant 单一入口（在 renderHistoryRail 里再写一遍就是第五处口径，
       正是本轮缺陷的成因）。所以这里改断【统一入口具备该保护】，
       并断 renderHistoryRail 不再自行重写它。继续钉旧位置等于禁止这个正确的重构。
       【命名避让】同一测试内 A1 已声明 entryBody，重名会直接 SyntaxError。 */
    const pinRelevantBody = codeOnly(fnBody(js, 'railPinStillRelevant'));
    assert.match(pinRelevantBody, /if\s*\(\s*!rec\s*\)\s*return\s+false/,
        '统一入口必须校验锚定 msgIdx 仍在采样集合里；不在就回退几何判据（否则去高亮一条不存在的刻度）');
    assert.ok(!/sampled\.some\(/.test(codeOnly(renderBody)),
        'renderHistoryRail 不得再自行重写一遍锚定存在性校验（口径必须只有一处）');
});

test('【行为】手动滚动释放锚定：wheel/touchmove/翻页键都必须释放，定时器不得代劳', () => {
    /* 光有 releaseRailPin 函数定义不够 —— 变异体把 wheel 处理改成空函数后测试仍绿，
       说明旧断言只查了「名字存在」。这里逐条钉住触发源。
       切片用「到下一个 $(messagesWrap).on 为止」而不是固定长度：固定长度会因注释变长而截断，
       表现为假红（本轮已踩：+260 不够长，处理体末尾被切掉）。 */
    const wheelStart = js.indexOf("$(messagesWrap).on('wheel touchmove'");
    assert.ok(wheelStart > 0, '必须绑定 wheel/touchmove');
    const wheelEnd = js.indexOf('$(messagesWrap).on(', wheelStart + 10);
    const wheelBlock = js.slice(wheelStart, wheelEnd > 0 ? wheelEnd : wheelStart + 800);
    assert.match(wheelBlock, /releaseRailPin\(\)/,
        'wheel/touchmove 处理体内必须真的调 releaseRailPin（否则用户手动滚动后锚定永久不释放，' +
        '表现为「点一次刻度之后就再也不跟着滚动了」）。实际块：' + wheelBlock);
    const keyStart = js.indexOf("$(messagesWrap).on('keydown'");
    const keyEnd = js.indexOf('$(messagesWrap).on(', keyStart + 10);
    const keyBlock = js.slice(keyStart, keyEnd > 0 ? keyEnd : keyStart + 800);
    assert.match(keyBlock, /releaseRailPin\(\)/, 'keydown 处理体内必须调 releaseRailPin');
    /* 覆盖的按键必须是真的会改变浏览位置的那几个 */
    for (const k of ['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown']) {
        assert.ok(keyBlock.includes("'" + k + "'"), '释放锚定的按键名单必须含 ' + k);
    }
    /* 释放不得靠定时器：慢设备上会过早/过晚失效，而“用户亲自滚了”是确定信号 */
    const relBody = fnBody(js, 'releaseRailPin');
    assert.ok(!/setTimeout/.test(relBody), 'releaseRailPin 不得依赖定时器');
});

test('【行为·密集几何】顶沿断点在密集消息下仍成立，且端点不被钳位吃掉', () => {
    const scene = makeDenseRailScene(0);
    const rows = [];
    for (const f of [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.88, 1]) {
        const scrollTop = Math.round(f * scene.denom);
        const s = makeDenseRailScene(scrollTop);
        const got = loadRealActiveResolver(s.wrap)(s.items);
        let truth = 0;
        for (const it of s.items) {
            if (it.row.offset <= scrollTop + 0.5) truth = it.msgIdx;
        }
        if (scrollTop <= 0) truth = 0;
        else if (s.denom - scrollTop <= 1) truth = s.items[s.items.length - 1].msgIdx;
        rows.push({ f, scrollTop, got, truth });
    }
    const bad = rows.filter((r) => r.got !== r.truth);
    assert.equal(bad.length, 0,
        '密集几何下不一致的采样点: ' + JSON.stringify(bad) +
        ' 全部: ' + rows.map((r) => r.f + '→' + r.got).join(' '));
});

test('【行为】两端点成立：滚到顶=首条，滚到底=末条（导航最少见但必须可用的两端）', () => {
    /* 宽松几何 */
    const top = makeRailScene(0, 600);
    assert.equal(loadRealActiveResolver(top.wrap)(top.items), 0, '滚到顶必须高亮首条');
    const bottom = makeRailScene(4800 - 600, 600);
    assert.equal(loadRealActiveResolver(bottom.wrap)(bottom.items), 7, '滚到底必须高亮末条');

    /* 密集几何（真实值）—— 宽松几何下这两条会侥幸通过，掩盖端点回归 */
    const dTop = makeDenseRailScene(0);
    assert.equal(loadRealActiveResolver(dTop.wrap)(dTop.items), 0,
        '密集消息滚到顶必须高亮首条（中线规则在此会误选第 2 条）');
    const dBottom = makeDenseRailScene(dTop.denom);
    assert.equal(loadRealActiveResolver(dBottom.wrap)(dBottom.items), 7,
        '密集消息滚到底必须高亮末条（末条 offset 超过可滚动距离，就近规则够不到）');
    /* 紧贴端点的内侧一点：钳位不得吃掉一大段区间（与具体规则无关的宽断言） */
    const dNear = makeDenseRailScene(dTop.denom - 40);
    const nearGot = loadRealActiveResolver(dNear.wrap)(dNear.items);
    assert.ok(nearGot >= 4, '距底 40px 时不应被钳位强拉成首条/末条以外的小值，实测=' + nearGot);
});
test('【行为·内容塌缩瞬态】denom===0 但 scrollTop 仍>0 时必须首条，不得高亮末条', () => {
    /* 真实场景：折叠工具卡 / 图片收缩会让 scrollHeight 掉到 clientHeight，
       而 scrollTop 尚未被浏览器钳回 0 —— 这一帧里 denom===0 且 scrollTop>0 确实存在。
       此时「内容装得下 → 首条守卫必须先命中」。若守卫写成 denom<0，就会一路落到
       末端钳位（denom-scrollTop = -50 <= 1 成立）而高亮【末条】，明显错误。 */
    const wrap = makeWrapStub({ scrollH: 741, clientH: 741, scrollTop: 50 });
    const items = [];
    for (let i = 0; i < 8; i++) items.push({ msgIdx: i, row: makeRowStub(i * 90, wrap) });
    assert.equal(loadRealActiveResolver(wrap)(items), 0,
        'denom===0 的塌缩瞬态必须回落首条（写成 denom<0 会误高亮末条）');
});

test('【行为】端点钳位不得伸进可滚动区间（距底 40px 仍由顶沿断点规则管辖）', () => {
    /* 钳位的语义是「用户已在端点上」。40px 距底显然不是端点，必须由断点规则决定；
       若容差放宽到 40px，就会提前跳到末条。
       旧断言写成 `nearGot >= 5` 对 1px 与 40px 容差都成立，等于没有牙。 */
    const scene = makeDenseRailScene(0);
    const step = scene.scrollH / 8;
    const breakpointOnly = (scrollTop) => {
        let v = 0;
        for (let i = 0; i < 8; i++) {
            const bp = i === 7 ? Math.min(i * step, scene.denom) : i * step;
            if (bp <= scrollTop + 0.5) v = i;
        }
        return v;
    };
    // 端点上必须钳位
    const atEnd = makeDenseRailScene(scene.denom);
    assert.equal(loadRealActiveResolver(atEnd.wrap)(atEnd.items), 7, '恰好在底部必须钳到末条');
    const near1 = makeDenseRailScene(scene.denom - 1);
    assert.equal(loadRealActiveResolver(near1.wrap)(near1.items), 7, '距底 1px 仍应钳到末条');
    // 距底 40px 必须【不】被末端钳位接管，取断点规则的值
    const far40 = makeDenseRailScene(scene.denom - 40);
    const expect40 = breakpointOnly(scene.denom - 40);
    assert.equal(loadRealActiveResolver(far40.wrap)(far40.items), expect40,
        '距底 40px 不是端点，必须由断点规则管辖（容差被放宽时这里会变成末条）；期望=' + expect40);
    assert.ok(expect40 !== 7, '期望值本身不能是 7，否则这条断言又变成永真');
});

test('【行为·亚像素】距底 0.5px 必须钳到末条（容差为 0 时末条刻度永不点亮）', () => {
    /* scrollTop 常是小数。若容差写成 <=0，则 denom-0.5 处不钳位，断点规则给出 6 ——
       表现为「滚到最底，最后一根刻度永远不高亮」。1px 容差正是为吸收这个亚像素误差。 */
    const scene = makeDenseRailScene(0);
    const sub = makeDenseRailScene(scene.denom - 0.5);
    const got = loadRealActiveResolver(sub.wrap)(sub.items);
    assert.equal(got, 7, '距底 0.5px 应钳到末条，实测=' + got);
    // 反证：不钳位时断点规则会给别的值，证明这条断言不是永真
    const step = scene.scrollH / 8;
    let bpOnly = 0;
    for (let i = 0; i < 8; i++) {
        const bp = i === 7 ? Math.min(i * step, scene.denom) : i * step;
        if (bp <= (scene.denom - 0.5) + 0.5) bpOnly = i;
    }
    /* 注意：断点规则本身在末条断点被钳到 denom 后，距底 0.5px 也能命中末条 ——
       这意味着末端钳位与断点规则在这一带上语义重叠。保留钳位的理由：
       钳位保证「子像素误差下仍稳定」，且与顶部首条钳位对称。
       这里改为断言「钳位与断点规则在末条上一致」，而不是造一个虚假的反证。 */
    assert.equal(bpOnly, 7, '顶沿断点规则应同样给出末条（两套规则在端点同向，不矛盾）');
});

test('【行为】内容装得下（无滚动条）时回落首条，不抛错也不返回 -1', () => {
    const { wrap, items } = makeRailScene(0, 6000); // clientH > scrollH
    /* 没有滚动条时所有消息都在屏幕上，讨论「读到哪」没有意义。
       必须显式回落首条，所以这条断言是在钉那个 denom<=0 守卫的存在。 */
    assert.equal(loadRealActiveResolver(wrap)(items), 0,
        '内容装得下时必须回落首条（否则可能高亮到中段某条，打开会话瞬间就跳到中间）');
    const empty = makeRailScene(0, 600);
    assert.equal(loadRealActiveResolver(empty.wrap)([]), -1, '空集合必须返回 -1');
});

/** jQuery 风格桩：只实现 showHistoryRailTip 真正用到的那几个方法。 */
function jqStub(el, extra) {
    return Object.assign({ length: 1, 0: el }, extra || {});
}
test('【行为】computeRailTipTop 与刻度精确居中对齐，随 rail padding/border 变化仍成立', () => {
    const body = fnBody(js, 'computeRailTipTop');
    const sandbox = {};
    vm.runInNewContext(body + '\nthis.__top = computeRailTipTop;', sandbox);
    const computeTop = sandbox.__top;

    const railTop = 100;
    const tickH = 12;
    const tickCenter = 200;                        // 刻度在视口里的【视觉中心】
    const tickRect = { top: tickCenter - tickH / 2, height: tickH };

    for (const c of [{ border: 0 }, { border: 2 }, { border: 1 }]) {
        /* hostH=0 关掉钳位，先把纯对齐算术单独钉死。
           padding 根本不出现在函数签名里 —— 这正是修复的核心：
           padding 在盒【内】，不参与绝对定位原点，旧实现把它当基准多算了 12px。 */
        const written = computeTop(tickRect, { top: railTop }, c.border, 0, 0);
        assert.ok(isFinite(written), 'border=' + c.border + '：必须返回有限值');
        /* 还原浏览器行为：绝对定位 top 相对【padding box】，原点 = railRect.top + borderTop；
           再加浮层自身 translateY(-50%)，故浮层中心的视口 y = 原点 + written。 */
        const tipCenter = railTop + c.border + written;
        assert.ok(Math.abs(tipCenter - tickCenter) <= 0.01,
            'border=' + c.border + '：浮层中心与刻度中心必须重合，实测 delta=' +
            (tipCenter - tickCenter).toFixed(3) + '（writtenTop=' + written + '）');
    }
});

test('【行为】大卡片靠边时 top 被钳进轨道，不溢出上下边界', () => {
    const body = fnBody(js, 'computeRailTipTop');
    const sandbox = {};
    vm.runInNewContext(body + '\nthis.__top = computeRailTipTop;', sandbox);
    const computeTop = sandbox.__top;

    /* 新卡片最高 260px 列表 + padding。轨道高 400px 时，刻度在顶边附近（center=20）
       居中会让卡片上半部分溢出轨道顶部；旧单行卡（高约 30px）不会碰到这个情况，
       所以这是等距改造引入的新约束，必须单独钉。 */
    const hostH = 400, tipH = 260, railTop = 100;
    const topAtEdge = computeTop({ top: railTop + 20 - 6, height: 12 }, { top: railTop }, 0, hostH, tipH);
    assert.ok(topAtEdge - tipH / 2 >= -0.01,
        '刻度在上边附近时，卡片顶边不得越过轨道顶（实测 top-half=' + (topAtEdge - tipH / 2) + '）');
    assert.equal(topAtEdge, tipH / 2, '应恰好贴齐（top = tipH/2），实测=' + topAtEdge);

    const bottomCenter = hostH - 20;
    const topAtBottom = computeTop({ top: railTop + bottomCenter - 6, height: 12 }, { top: railTop }, 0, hostH, tipH);
    assert.ok(topAtBottom + tipH / 2 <= hostH + 0.01,
        '刻度在下边附近时，卡片底边不得越过轨道底（实测 top+half=' + (topAtBottom + tipH / 2) + '）');
    assert.equal(topAtBottom, hostH - tipH / 2, '应恰好贴齐（top = hostH - tipH/2）');

    /* 中间段不得被钳位动到：钳位只应作用于靠边情形 */
    const midCenter = hostH / 2;
    const topMid = computeTop({ top: railTop + midCenter - 6, height: 12 }, { top: railTop }, 0, hostH, tipH);
    assert.equal(topMid, midCenter, '刻度在正中时必须原样居中，不被钳位影响');

    /* 卡片比轨道还高时跳过钳位（硬塑会产生负 top，比溢出更难看） */
    const topHuge = computeTop({ top: railTop + midCenter - 6, height: 12 }, { top: railTop }, 0, 200, 400);
    assert.equal(topHuge, midCenter, '卡比轨高时不做钳位');
});

test('【行为·反证】旧 offsetTop 写法确实会偏移（证明上面的对齐断言有牙，不是永真）', () => {
    /* 用同一场景跑旧公式：top = offsetTop + offsetHeight/2，其中 offsetTop 相对 track。
       关键：offsetTop 是【布局】属性，忽略 transform —— 所以它等于「布局顶边 − track 顶边」，
       而布局顶边 === 视觉中心（因为 translateY(-50%) 正好把它抬了半个高度）。
       第一版我从 rectTop 推 offsetTop，等于把 −50% 算了两次，会得出 −12 这个错的数。
       期望偏移 = tickH/2 − pad = 4.5 − 12 = −7.5，与浏览器实测 −7.3/−7.5/−7.69 一致。 */
    const railTop = 100, pad = 12, border = 0, tickH = 9;
    const tickCenter = 200;
    const trackTop = railTop + border + pad;       // track 在 rail 内，顶边低 12px
    const offsetTop = tickCenter - trackTop;       // offsetTop 忽略 transform
    const writtenOld = offsetTop + tickH / 2;
    const tipCenterOld = railTop + border + writtenOld;
    const delta = tipCenterOld - tickCenter;
    assert.equal(delta, tickH / 2 - pad,
        '旧公式的偏移量必须正好是「半个刻度高 − rail padding」，实测 delta=' + delta);
    assert.ok(Math.abs(delta) > 2,
        '旧公式应当明显偏移（本断言用于证明新断言不是永真），实测 delta=' + delta);
    assert.ok(delta < 0, '旧公式偏高（delta 为负），与实测 −7.5px 方向一致');
});

test('滚动事件用 rAF 合并且只更新 active，不重建 DOM', () => {
    const idx = js.indexOf("$(messagesWrap).on('scroll'");
    assert.ok(idx > 0, '缺少滚动监听');
    const block = js.slice(idx, idx + 900);
    assert.match(block, /requestAnimationFrame/, '滚动里必须 rAF 合并（scroll 每帧可触发多次）');
    assert.match(block, /paintRailActive/, '滚动只更新 active');
    assert.ok(!/\.html\(/.test(block), '滚动里不得重建 DOM（会打断 hover 与入场动画）');
});

test('内容高度变化必须重算比例（ResizeObserver，window.resize 覆盖不到）', () => {
    const code = codeOnly(js);
    assert.ok(code.includes('ResizeObserver'),
        '必须用 ResizeObserver：字体/图片/代码高亮/Mermaid 完成后行高变化，window.resize 不触发');
    assert.match(code, /\.observe\(/, '必须真的 observe 目标容器');
    assert.ok(code.includes('relayoutHistoryRailTicks'),
        '重算必须走 relayoutHistoryRailTicks（只改位置、不重建 DOM）');
    const body = fnBody(js, 'relayoutHistoryRailTicks');
    assert.ok(!/\.html\(/.test(body), 'relayout 不得重建 DOM');
    assert.match(body, /css\('top'/, 'relayout 必须更新 top');
});

/* ============ 5. 交互 ============ */

test('点击刻度平滑滚动并复用既有 msg-highlight 高亮', () => {
    const body = fnBody(js, 'locateUserMessage');
    assert.match(body, /scrollIntoView\(\{\s*behavior:\s*'smooth'/, '必须平滑滚动');
    assert.match(body, /msg-highlight/, '高亮必须复用既有 .msg-highlight（app.css 已有动画）');
    assert.match(body, /removeClass\('msg-highlight'\)[\s\S]*addClass\('msg-highlight'\)/,
        '必须先移除再加：连续点同一根时类名没变过，浏览器不会重播动画');
});

test('刻度是原生 button（键盘可达），且用事件委托', () => {
    const body = fnBody(js, 'renderHistoryRail');
    assert.match(body, /<button type="button" class="history-rail-tick/, '刻度必须是原生 button');
    assert.ok(!/<div class="history-rail-tick/.test(body), '不得用 div（键盘不可达）');
    const code = codeOnly(js);
    assert.match(code, /\$historyRailTrack\.on\('click',\s*'\.history-rail-tick'/,
        '刻度是动态重建的，必须用事件委托');
    assert.match(code, /\$historyRailTrack\.on\('focusin'/,
        '必须处理 focusin：:hover 不会因聚焦触发，键盘用户看不到摘要');
});

test('刻度 aria-label 必须能区分不同消息（全同名 = 屏幕阅读器听到 N 个相同按钮）', () => {
    /* 本轮实测：修复前 6 根刻度的 aria-label 全是「定位到该消息」，
       屏幕阅读器用户无法知道哪根对应哪条 —— 导航对键盘用户直接失效。
       断言的是「标签里包含可变部分」而不是具体文案（文案跟语言包走）。 */
    const body = fnBody(js, 'renderHistoryRail');
    const labelLine = body.split('\n').find((l) => l.includes('aria-label') && l.includes('locate_message'));
    assert.ok(labelLine, '刻度必须有 aria-label');
    /* 断言整行（含后续插值），而不是切到第一个右括号 —— 那样会把插值部分全切掉。 */
    assert.match(labelLine, /\(\s*j\s*\+\s*1\s*\)|\b\w+\s*\+\s*1\b/,
        'aria-label 必须含序号（否则所有刻度同名，屏幕阅读器无法区分）：' + labelLine.trim());
    assert.ok(/sampled\.length|items\.length/.test(labelLine),
        'aria-label 必须含总数（「第 N 条 / 共 M 条」才能定位相对位置）');
    assert.match(labelLine, /a11ySummary|data-tip|railFlatText/,
        'aria-label 必须带消息摘要，否则同序号语义下无法听出是哪条');
});

test('摘要浮层是多行列表卡，且靠延迟隐藏而非 pointer-events:none 防闪烁', () => {
    const rule = cssRule('.history-rail-tip');
    assert.match(rule, /position:\s*absolute/, '浮层须绝对定位');
    // right 必须大于轨道宽度，否则浮层落进轨道内压住刻度（实测 20px 时重叠 6px）
    const m = rule.match(/right:\s*(\d+)px/);
    assert.ok(m, '浮层必须用 right 定位');
    assert.ok(parseInt(m[1], 10) >= 27,
        '浮层 right 必须 > 轨道宽 26px，否则压住刻度（实测 20px 时 gap=-6px）');

    /* 【设计变更】旧版是一行 nowrap 摘要，必须 pointer-events:none 否则鼠标进入就闪烁。
       新版行本身可悬停/可点，必须能拿到指针事件 —— 所以改成 auto，
       防闪烁不靠 none，而是靠 JS 的延迟隐藏（160ms 窗口）。
       这里把两件事都钉住：必须 auto（可交互）、必须存在延迟隐藏。 */
    assert.match(rule, /pointer-events:\s*auto/,
        '列表卡的行要可点，pointer-events 必须为 auto（旧版 none 是单行摘要的写法）');
    assert.ok(!/pointer-events:\s*none/.test(rule), '不得回到 none：那样行无法点击/悬停');

    const code = codeOnly(js);
    assert.ok(code.includes('scheduleRailTipHide'),
        '必须有不立即隐藏的路径（scheduleRailTipHide）：刻度与卡片之间隔着 2px，' +
        '一离开就隐藏会让鼠标永远进不了卡片');
    assert.match(code, /HISTORY_RAIL_TIP_HIDE_DELAY/, '延迟窗口必须是具名常量，不能是散落的魔数');
    const hideBody = fnBody(js, 'scheduleRailTipHide');
    assert.match(hideBody, /cancelRailTipHide\(\)/, '重新调度前必须先取消上一个隐藏定时器');
    assert.match(hideBody, /setTimeout/, '必须真的延迟隐藏');
    // 进入卡片必须取消隐藏
    assert.match(code, /\$historyRailTip\.on\('mouseenter'[\s\S]{0,120}cancelRailTipHide/,
        '鼠标进入卡片时必须取消隐藏，否则指针刚到卡片就灭了');
});

test('定位仍必须由 rect 相减得出（跨包含块，offsetTop 不同源）', () => {
    /* 算术已抽到 computeRailTipTop，所以断言拆两处：
       纯函数负责算术，showHistoryRailTip 负责取基准（offsetParent + borderTopWidth）。 */
    const topBody = fnBody(js, 'computeRailTipTop');
    /* 参数名不参与断言（下一轮改名就会假红）：看算术形状 ——
       必须把第三个实参（border-top）从基准里减掉。 */
    assert.match(topBody, /-\s*\(\s*hostBorderTop\s*\|\|\s*0\s*\)|--\s*hostBorderTop|-\s*hostBorderTop/,
        '纯函数必须补偿包含块的 border-top（绝对定位 top 相对 padding box，rect.top 是 border box 外缘）');
    assert.match(topBody, /tickRect\.top\s*\+\s*tickRect\.height\s*\/\s*2/,
        '刻度中心必须是 rect.top + rect.height/2（视觉中心恒等式，与 transform 无关）');
    assert.ok(!/\boffsetTop\b/.test(codeOnly(topBody)),
        '不得用 offsetTop：它与浮层的包含块不同源，会恒定偏移');

    const body = fnBody(js, 'showHistoryRailTip');
    assert.match(body, /getBoundingClientRect\(\)/,
        '浮层 top 必须由 rect 相减得出（跨包含块，offsetTop 不同源）');
    /* 【必须跑在 codeOnly 上】函数内的解释性注释正提到旧写法 `offsetTop + offsetHeight/2`，
       直接对 body 断言「不得含 offsetTop」会被自己的注释绊倒而假红。
       本仓反复踩过这个坑，codeOnly() 就是为此而存在。 */
    assert.ok(!/\boffsetTop\b/.test(codeOnly(body)),
        '不得再用 offsetTop 定位浮层：它与浮层的包含块不同源，会恒定偏移');
    assert.match(body, /offsetParent/, '必须取浮层真实的包含块（offsetParent）作为 rect 基准');
    assert.match(body, /borderTopWidth/,
        '必须补偿包含块的 border-top：绝对定位 top 相对 padding box，rect.top 是 border box 外缘');
    assert.match(body, /computeRailTipTop/, '算术必须走抽出的纯函数，不得内联两份');
    assert.match(body, /is-shown/, '显隐必须用类切换');
});

/* ============ 6. 采样与容量 ============ */

test('消息过多时采样且保留首末条（封顶会丢后半段导航）', () => {
    assert.match(js, /var HISTORY_RAIL_MAX_TICKS = 60;/, '刻度上限常量缺失');
    const body = fnBody(js, 'railSampleIndices');
    assert.match(body, /count\s*<=\s*limit/, '未超限时必须全部保留');
    assert.match(body, /count - 1/, '采样步长必须按 count-1 计算，才能保证末条入选');
    assert.match(body, /limit - 1/, '分母必须是 limit-1');
});

/* ============ 7. 动效与无障碍 ============ */

test('入场动画由 CSS 变量驱动，且尊重 prefers-reduced-motion', () => {
    assert.match(css, /@keyframes history-rail-in/, '缺轨道入场动画');
    assert.match(css, /@keyframes history-tick-in/, '缺刻度入场动画');
    const tickRule = cssRule('.history-rail-tick.is-new');
    assert.match(tickRule, /animation-delay:\s*calc\(min\(var\(--i, 0\), 10\)/,
        '交错延迟必须由 --i 驱动并封顶（不封顶时几十条会等到秒级）');
    /* 【陷阱】app.css 里有多个 @media (prefers-reduced-motion: reduce) 块（别的模块也在用）。
       用 indexOf 取第一个会命中无关块，断言永远为假——本仓已踩过多次。
       也不能只用 lastIndexOf 回溯：那只能保证「某处有 @media」，不能保证
       .history-rail 的关闭规则就在块内。正确判据：**把每个 @media 块切出来，
       检查含轨道选择器的那个块的相对位置确实落在它内部**。 */
    const rmBlocks = [];
    const rmHead = '@media (prefers-reduced-motion: reduce)';
    let cursor = 0;
    while (true) {
        const at = css.indexOf(rmHead, cursor);
        if (at < 0) break;
        let depth = 0, end = at;
        for (let i = at; i < css.length; i++) {
            if (css[i] === '{') depth++;
            else if (css[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        rmBlocks.push({ at, end, text: css.slice(at, end) });
        cursor = end;
    }
    assert.ok(rmBlocks.length > 0, '必须尊重 reduced-motion');
    const railRm = rmBlocks.find(b => b.text.includes('.history-rail'));
    assert.ok(railRm, '必须有一个 @media (prefers-reduced-motion: reduce) 块专门处理轨道动效');
    assert.ok(railRm.text.includes('.history-rail.is-visible > .history-rail-track'),
        'reduced-motion 必须关掉轨道入场动画');
    assert.ok(railRm.text.includes('.history-rail-tick.is-new'),
        'reduced-motion 必须关掉刻度入场动画');
    assert.ok(railRm.text.includes('animation: none'),
        'reduced-motion 块内必须真的写 animation: none');
    // 反向护栏：这三条规则不得只在块外出现（否则系统偏好形同虚设）
    const outside = css.slice(0, railRm.at) + css.slice(railRm.end);
    assert.ok(!/\.history-rail-tick\.is-new\s*\{[^}]*animation:\s*none/.test(outside),
        '轨道的动画关闭规则不得只写在 reduced-motion 块外（那样普通用户也看不到动画）');
});

test('窄屏隐藏轨道（导航非必需，正文空间更值钱）', () => {
    const idx = css.indexOf('@media (max-width: 720px)');
    assert.ok(idx > 0, '缺少窄屏隐藏规则');
    const block = css.slice(idx, idx + 200);
    assert.match(block, /\.history-rail \{ display: none !important; \}/, '窄屏必须隐藏轨道');
});

/* ============ 8. 接线（否则功能静默不生效） ============ */

test('会话切换 / 离开会话都重建轨道', () => {
    const code = codeOnly(appBase);
    const calls = code.split('refreshHistoryRail').length - 1;
    assert.ok(calls >= 2,
        'app-base.js 至少要有两处 refreshHistoryRail（setActiveSession 与 deactivateSession），实际 ' + calls);
});

test('回放结束重建轨道（消息集合被整体替换）', () => {
    const code = codeOnly(js);
    const idx = code.indexOf('flushFileChangesReplayReconcile');
    assert.ok(idx > 0, '未找到回放收尾钩子');
    const around = code.slice(idx, idx + 900);
    assert.ok(around.includes('refreshHistoryRail'),
        '回放把整批消息搬进真实容器后必须重建轨道');
});

test('新增用户消息 / 插话后轨道刷新', () => {
    const code = codeOnly(appMessage);
    const calls = code.split('refreshHistoryRail').length - 1;
    assert.ok(calls >= 2,
        'appendUserMessage 与 appendSteerNote 都要刷新（插话也是用户消息），实际 ' + calls);
});

test('对外入口有 try/catch 兜底（增强功能不得打断消息渲染）', () => {
    const body = fnBody(js, 'refreshHistoryRail');
    assert.match(body, /try\s*\{/, 'refreshHistoryRail 必须 try/catch');
    // window 挂载写在函数体之外（紧跟在函数定义之后），故查整份源码而非 fnBody
    assert.match(codeOnly(js), /window\.refreshHistoryRail = refreshHistoryRail/,
        '必须挂到 window（app-base / app-message 早于本文件装载，靠 typeof 守卫调用）');
});

/* ============ 9. 浮层列表卡（2026-11-01 新增形态） ============

   用户描述：「弹框里面也有选择渐变动画」，并确认卡片要「多行列表卡」。
   下面这些用例钉的是「卡片是列表而非单行摘要」这件结构事实 ——
   它不会抛错、不会报错、也不会让页面崩，所以只能靠源码级断言守住。 */

test('浮层必须是列表：一条刻度一行，不是单行摘要', () => {
    const body = fnBody(js, 'renderRailTipList');
    assert.match(body, /history-rail-tip-row/, '每行必须有 .history-rail-tip-row');
    /* 【关键】数据源必须是轨道刻度，不是重新遍历消息 DOM。
       两处各自收集会漂移（卡片第 3 行 ≠ 轨道第 3 根），而这种漂移在
       「消息数刚好等于刻度数」时看不出来，一旦触发采样就全错。 */
    assert.match(body, /\.history-rail-tick/, '列表必须由轨道刻度驱动（同一数据源，避免两处漂移）');
    assert.ok(!/collectRailMessages/.test(codeOnly(body)),
        '不得自己重新收集消息：与轨道各收一份必然漂移');
    // 每行既要文本也要行尾刻度（对齐参照稿）
    assert.match(body, /history-rail-tip-text/, '行内必须有文本节点');
    assert.match(body, /history-rail-tip-tick/, '行尾必须有同款刻度');
    // 行可点 => 必须是 button
    assert.match(body, /<button type="button" class="history-rail-tip-row/, '行必须是原生 button（可点且键盘可达）');
    
    /* 【这里必须订到「真的会被执行」而不是「字符串存在」】
       首轮变异体在 html 拼接前插了一句 `return;`（后面的行构建变成死代码），
       字符串断言仍然全绿 —— 因为那些类名还在函数体里，只是不再被执行。
       两处补强：① 行循环边界必须是 $ticks.length（砍成 1 就让列表退化成单行）；
       ② html 必须真的被写进 tip（死代码不会走到 .html(html)）。 */
    assert.match(body, /j\s*<\s*\$ticks\.length/, '行循环边界必须是实际刻度数（写成固定值=数据源漂移）');
    assert.match(body, /\$historyRailTip\.html\(html\)/, '行 html 必须真的写进卡片（否则整个列表是死代码）');
    const loopAt = body.indexOf('for (var j = 0;');
    const htmlAt = body.indexOf('$historyRailTip.html(html)');
    assert.ok(loopAt > 0 && htmlAt > loopAt,
        '行构建循环必须写在 .html(html) 之前（否则永远不执行）');
    assert.ok(!/;\s*return;\s*var\s/.test(body),
        '不得在 html 拼接中间插 return（后面会变成永不执行的死代码，而字符串断言仍然全绿）');
});

test('列表行文本必须转义（消息正文是用户数据，可含尖括号与引号）', () => {
    const body = fnBody(js, 'renderRailTipList');
    assert.match(body, /escapeHtml\(text\)/, '行文本必须 escapeHtml：用户消息里写 <script> 不能进 DOM');
    assert.match(body, /escAttr\(/, '属性值必须 escAttr（引号会截断属性）');
});

test('列表只在刻度集合变化时重建行 DOM（否则选中动画会每次重播）', () => {
    const body = fnBody(js, 'renderRailTipList');
    assert.match(body, /historyRailTipSig/, '必须有行签名，避免每次 hover 都重建');
    assert.match(body, /return;/, '签名未变时必须提前返回');
    /* 【仅断言「有 return」不够】首轮变异体把它改成 `if (false) return;`，
       字符串仍含 historyRailTipSig 与 return，断言全绿，但签名彻底失效 ——
       每次 hover 都重建行，选中动画反复重播。必须订住「签名参与了比较」。 */
    assert.match(body, /sig\s*===\s*historyRailTipSig/,
        '提前返回的条件必须真的拿当前签名与上次签名比较（写 if(false) 等于没有签名）');
    assert.match(body, /historyRailTipSig\s*=\s*sig/,
        '比完必须回写签名，否则下次永远不相等（表现为每次 hover 都重建）');
    /* 进入卡片、在行间移动都不应重建：重建会让行入场动画重播，
       表现为「鼠标一动整张卡在闪」。 */
    const show = fnBody(js, 'showHistoryRailTip');
    assert.match(show, /renderRailTipList\(\)/, '显示时必须确保行已建好');
    assert.match(show, /setRailTipCursor/, '显示时必须把选中定位到所悬停的那条');
});

test('选中切换必须有动画：滑动指示条 + 位移过渡（用户明确要求）', () => {
    /* 【为何用一条绝对定位的「指示条」而不是给行加 :hover 背景】
       行各自变背景是「两个东西先后亮」，看不出「选中移动到哪」；
       一条会滑动的背景才是「选中移到了这里」。用户要的是后者。 */
    const cursorRule = cssRule('.history-rail-tip-cursor');
    assert.match(cursorRule, /position:\s*absolute/, '指示条必须绝对定位（供 JS 写 transform）');
    assert.match(cursorRule, /pointer-events:\s*none/, '指示条不得挡行点击');
    assert.match(cursorRule, /transition:[^;]*transform/,
        '指示条必须有 transform 过渡（没有过渡就是瞬移，不是用户要的动画）');

    const body = fnBody(js, 'setRailTipCursor');
    assert.match(body, /translateY\(/, '必须写 transform: translateY（位移驱动，不是改 top）');
    assert.match(body, /cursor\.style\.height/, '必须同时写高度：行高不同（换行/字体）时纯位移会错位');
    /* 写在 transform 而「不是 top」的理由：改 top 每帧触发重排，
       改 transform 只走合成。列表滚动时更是如此。 */
    assert.ok(!/cursor\.style\.top\s*=/.test(codeOnly(body)),
        '指示条必须用 transform 位移，不得直接改 top（每帧重排，滚动时会掉帧）');
});

test('光标移动不得引入强制同步布局（卡顿的可量化根因）', () => {
    /* 用户报「弹层里面的光标移动效果也有点卡顿」。
       真实浏览器实测（Performance.getMetrics，鼠标扫过 8 行）：
         · 改前 layoutCount 增量 70、RecalcStyle 87（8.75 次布局 / 跨行）
         · 改后 layoutCount 增量 16（2 次 / 跨行，仅剩卡片首帧与必要重绘）
       三个具体缺陷，每个都必须被钉住 —— 它们都不会报错，只会让人觉得「有点卡」。 */
    const body = codeOnly(fnBody(js, 'setRailTipCursor'));

    /* ① 不得全量 removeClass：旧写法 $rows.removeClass('is-cursor') 让 N 行失效，
          紧接着读几何就是一次全量同步重排。必须只摘掉「残留选中且不是目标」的那一个。 */
    assert.ok(!/\$rows\.removeClass\(\s*'is-cursor'\s*\)/.test(body),
        '不得对全部行 removeClass(is-cursor)：会让 N 个元素失效，随后的几何读取就成了一次全量强制重排');
    assert.match(body, /filter\(\s*'\.is-cursor'\s*\)/,
        '必须只摘掉残留选中行（filter(.is-cursor)），把失效面从 N 降到 1');

    /* ② 不得在读几何后再写样式，也不得逐行现读 offsetTop/offsetHeight ——
          必须走 measureRailTipRowGeo 的缓存。 */
    assert.ok(!/\$target\[0\]\.offset(Top|Height)/.test(body),
        '不得现读 $target[0].offsetTop/offsetHeight：那是在写样式之后的同步布局读取');
    assert.match(body, /historyRailTipRowGeo/,
        '必须使用行几何缓存（historyRailTipRowGeo），不是每次现测');

    /* ③ height 只在真的不同时才写：height 是布局属性，每帧变就是每帧重排。
          行高恒定时这条判断让写入次数降为 0。 */
    assert.match(body, /__railH/,
        'height 必须按需写入（同一个值不重复写）：height 过渡会每帧触发布局');

    /* ④ 缓存必须由单一的测量函数生成，且只依赖相对 offsetParent 的量
          （offsetTop/offsetHeight 与列表 scrollTop 无关，所以缓存生命周期内成立）。 */
    const measure = codeOnly(fnBody(js, 'measureRailTipRowGeo'));
    assert.match(measure, /offsetTop/, '缓存测量必须用 offsetTop（相对 offsetParent，与列表滚动无关）');
    assert.match(measure, /offsetHeight/, '缓存测量必须用 offsetHeight');
    assert.match(measure, /list\.clientHeight|clientHeight/,
        '必须同时记下列表可视高：否则把行滚进视野时又得现读 clientHeight（同样会强制布局）');

    /* ⑤ 列表重建后才允许重新测量（行 DOM 全换了，缓存必然失效）。 */
    const list = codeOnly(fnBody(js, 'renderRailTipList'));
    assert.match(list, /measureRailTipRowGeo\(\)/,
        '列表重建后必须重建几何缓存（行 DOM 已换，旧缓存指向不存在的节点）');
});

test('滚动/悬停高频路径不得做全量失效（失效面必须降到 1 个元素）', () => {
    /* 三处「功能正常但会顿」的实现缺陷，全部靠源码形状守 ——
       它们都不会报错，只在长会话（60 根刻度）里表现为「滚动/移动有点卡」。 */

    /* ① paintRailActive：滚动时每帧都跑。旧写法遍历所有刻度 toggleClass，
          60 根就是每次换位让 60 个元素失效。必须只动旧的与新的一根。 */
    const paint = codeOnly(fnBody(js, 'paintRailActive'));
    assert.ok(!/for\s*\([^)]*\)\s*\{[\s\S]*?toggleClass/.test(paint),
        'paintRailActive 不得遍历所有刻度 toggleClass（60 根时每次换位全量失效）。实际：' + paint);
    assert.match(paint, /filter\(\s*'\[data-msg-idx="' \+ prev \+ '"\]'\s*\)/,
        '必须只清掉「上一根」的 is-active（把失效面压到 1 个元素）');
    assert.match(paint, /filter\(\s*'\[data-msg-idx="' \+ msgIdx \+ '"\]'\s*\)/,
        '必须只给「当前根」加 is-active');
    /* 重建后的首次绘制（prev === -1）仍要清一遍残留，否则重建会留下多根高亮。 */
    assert.match(paint, /prev === -1[\s\S]{0,200}filter\(\s*'\.is-active'\s*\)/,
        '首次绘制（prev === -1）必须清掉残留 is-active：重建后旧高亮会留在 DOM 上');

    /* ② markRailTipCurrent：滚动时每帧都被 paintRailActive 调用。
          没有早退就是每帧 N 行 removeClass + filter addClass。 */
    const mark = codeOnly(fnBody(js, 'markRailTipCurrent'));
    assert.match(mark, /msgIdx === historyRailTipCurrentIdx\) return/,
        'markRailTipCurrent 必须早退：当前行没变时不得重复全量改类（滚动时每帧都会进来）');
    assert.ok(!/\$rows\.removeClass\(/.test(mark),
        '不得对全部行 removeClass：只摘掉 .is-current 那一行（filter(.is-current)）');
    /* 早退状态必须真的被写入，否则恒为 -1 → 等于没有早退。 */
    assert.match(mark, /historyRailTipCurrentIdx = msgIdx/,
        '早退判据的状态必须被更新，否则恒为初值、早退永不生效');

    /* ③ computeRailTickHitHeight 的步距口径必须与 computeRailTops 一致。
          固定步距后间距不再是 trackH/(n-1)：40 条时旧公式给 9.4px（把命中区
          无谓压窄），真实间距是 16px。两处口径漂移不会报错，只会让命中区变小。 */
    const hit = codeOnly(fnBody(js, 'computeRailTickHitHeight'));
    const top = codeOnly(fnBody(js, 'computeRailTops'));
    const usesStep = (s) => /Math\.min\(\s*HISTORY_RAIL_STEP_PX\s*,/.test(s);
    assert.equal(usesStep(hit), usesStep(top),
        '命中区与刻度定位必须用同一个步距口径（都取 min(STEP, trackH/(n-1))）：' +
        '两处各自算会让命中区与真实间距不一致。hit=' + usesStep(hit) + ' top=' + usesStep(top));
    assert.ok(usesStep(hit), '命中区必须按 min(HISTORY_RAIL_STEP_PX, ...) 算间距');
});

test('CSS：指示条与行尾刻度只做合成层动画，不动布局属性', () => {
    /* 两大动效都曾用布局属性驱动：
       · 指示条过渡 height（每帧重算卡片布局）
       · 行尾刻度过渡 width（flex 行每帧重排）
       实测这两条是「光标移动卡顿」的第二大来源。改为 transform 后零布局。 */
    const cur = cssRule('.history-rail-tip-cursor');
    assert.ok(!/transition:[^;]*\bheight\b/.test(cur),
        '指示条不得过渡 height（布局属性，每帧重排）。实际：' + cur);
    assert.match(cur, /transition:[^;]*transform/, '指示条仍必须有 transform 过渡（保留用户要的滑动动画）');

    const tick = cssRule('.history-rail-tip-tick');
    assert.ok(!/transition:[^;]*\bwidth\b/.test(tick),
        '行尾刻度不得过渡 width（flex 行每帧重排）。实际：' + tick);
    assert.match(tick, /transform:\s*scaleX\(/,
        '行尾刻度的长度变化必须用 transform: scaleX（合成层，零布局）');
    assert.match(tick, /transform-origin:\s*right/,
        'scaleX 必须以右缘为原点：否则刻度会向两侧生长，与轨道右对齐基线错位');

    /* 选中态必须回到 scaleX(1)，与默认态的缩放形成「变长」的视觉语义。 */
    const active = css.slice(css.indexOf('.history-rail-tip-row.is-cursor .history-rail-tip-tick'));
    assert.match(active.slice(0, 200), /scaleX\(1\)/,
        '选中行的行尾刻度必须回到 scaleX(1)（这是「变长」的实现方式）');
});

test('【行为】setRailTipCursor 真实输出：指示条位移/高度与被选行对齐', () => {
    const body = fnBody(js, 'setRailTipCursor');
    /* 手写最小 jQuery 桩：只需 find/filter/removeClass/addClass/first/长度。
       断言的是「写进 cursor.style 的值」而非某种实现细节。 */
    const makeRow = (idx, top, h) => {
        const cls = new Set();
        return {
            el: { offsetTop: top, offsetHeight: h },
            attr: (k) => (k === 'data-msg-idx' ? String(idx) : null),
            addClass(c) { cls.add(c); return this; },
            removeClass(c) { cls.delete(c); return this; },
            has: (c) => cls.has(c),
            _cls: cls,
        };
    };
    const rows = [makeRow(10, 0, 30), makeRow(20, 30, 30), makeRow(30, 60, 44)];
    const cursorEl = { style: {} };
    const tipEl = { _cls: new Set(), _jq: null };

    /* 【桩的形态必须跟着产品走】setRailTipCursor 现在吃几何缓存（historyRailTipRowGeo），
       由 measureRailTipRowGeo 一次性填入，不再逐行读 offsetTop。
       所以桩要提供的是「一批可被 find('.history-rail-tip-row') 遍历的行」，
       而不是「filter 单个选择器时能返回元素」。 */
    const $rows = {
        length: rows.length,
        removeClass() { rows.forEach((r) => r.removeClass('is-cursor')); return this; },
        /* 产品代码里 filter 只用于两件事：找残留选中行、按 msgIdx 找目标行。
           按选择器形态分派：.is-cursor → 已选中的；[data-msg-idx="N"] → 目标。 */
        filter(sel) {
            let hit;
            if (sel === '.is-cursor') {
                hit = rows.filter((r) => r.has('is-cursor'));
            } else {
                const m = /data-msg-idx="(\d+)"/.exec(sel);
                hit = m ? rows.filter((r) => r.attr('data-msg-idx') === m[1]) : [];
            }
            /* 【关键】返回项的 0 必须是【DOM 元素】而不是 jQuery 包装对象 ——
               真 jQuery 里 $(sel)[0] 就是元素；桩里若返回包装对象，
               读 offsetHeight 会得到 undefined，断言变成 'undefinedpx' 这种
               看上去像产品 bug 的假红。 */
            const wrapped = hit.map((r) => r.el);
            const out = {
                length: hit.length,
                0: wrapped[0] || null,
                _hit: hit,
                addClass(c) { hit.forEach((r) => r.addClass(c)); return this; },
                removeClass(c) { hit.forEach((r) => r.removeClass(c)); return this; },
                /* 【桩必须覆盖 .not()】产品代码现在写 `$rows.filter('.is-cursor').not($target)`：
                   只摘掉「残留选中但不是目标」的那一个（把失效面从 N 行降到 1 行，
                   否则紧接着的几何读取会变成一次全量强制重排）。缺这个方法会抛 TypeError，
                   而报错信息指向的不是「桩缺方法」而是「产品代码有问题」，极具迷惑性。 */
                not(other) {
                    const excl = (other && other._hit) || [];
                    const kept = hit.filter((r) => excl.indexOf(r) < 0);
                    const kw = kept.map((r) => r.el);
                    return {
                        length: kept.length,
                        0: kw[0] || null,
                        _hit: kept,
                        addClass(c) { kept.forEach((r) => r.addClass(c)); return this; },
                        removeClass(c) { kept.forEach((r) => r.removeClass(c)); return this; },
                    };
                },
            };
            return out;
        },
    };
    const $cursor = { length: 1, 0: cursorEl };
    const $list = { length: 1, 0: { scrollTop: 0, clientHeight: 100 } };
    /* measureRailTipRowGeo 用 $rows.length + $rows[i] 逐项读 offsetHeight/offsetTop，
       并要求元素能 getAttribute('data-msg-idx')。 */
    for (let i = 0; i < rows.length; i++) $rows[i] = rows[i].el;
    rows.forEach((r) => { r.el.getAttribute = (k) => (k === 'data-msg-idx' ? r.attr('data-msg-idx') : null); });
    const $tip = {
        length: 1,
        find(sel) {
            if (sel === '.history-rail-tip-row') return $rows;
            if (sel === '.history-rail-tip-cursor') return $cursor;
            if (sel === '.history-rail-tip-list') return $list;
            return { length: 0 };
        },
        addClass(c) { tipEl._cls.add(c); return this; },
    };

    const sandbox = {
        $historyRailTip: $tip, historyRailTipIdx: -1, historyRailTipCurrentIdx: -1,
        historyRailTipRowGeo: null,
    };
    /* setRailTipCursor 会调 scrollRailTipRowIntoView（把选中行滚进列表视窗），
       必须一并载入，否则 vm 里报 is not defined —— 而这个错误只会在
       真跑函数时暴露，光看源码形状完全不觉得缺东西。 */
    const scrollBody = fnBody(js, 'scrollRailTipRowIntoView');
    const measureBody = fnBody(js, 'measureRailTipRowGeo');
    vm.runInNewContext(
        'var historyRailTipRowGeo = null;\n' + measureBody + '\n' + scrollBody + '\n' + body +
        '\nthis.__set = setRailTipCursor; this.__getIdx = function(){return historyRailTipIdx;};' +
        '\nthis.__measure = measureRailTipRowGeo;',
        sandbox);

    sandbox.__set(30);
    assert.equal(cursorEl.style.height, '44px', '指示条高度必须等于被选行高，实测=' + cursorEl.style.height);
    /* 【本轮新增·几何缓存的真实生效证据】首次调用时必须惰性填充缓存（之前是 null），
       且缓存内容必须与 DOM 上的 offsetTop/offsetHeight 完全一致 ——
       否则「用缓存」会变成「用一份错的缓存」，位移看起来对、实际错位。
       【不能写成 assert.ok(x || true)】那是永真断言（绿色假象），本仓踩过。 */
    const geo = sandbox.historyRailTipRowGeo;
    assert.ok(geo && geo.rows && geo.rows.length === 3,
        '首次 setRailTipCursor 必须惰性填充几何缓存（3 行），实际=' + JSON.stringify(geo));
    assert.deepEqual(
        Array.from(geo.rows).map((r) => [r.idx, r.top, r.h]),
        [[10, 0, 30], [20, 30, 30], [30, 60, 44]],
        '缓存必须逐行记录 msgIdx/offsetTop/offsetHeight（这是位移与高度唯一的数据源）');
    assert.equal(geo.listH, 100, '缓存必须记下列表可视高：滚动进视野时不再现读 clientHeight');
    assert.equal(cursorEl.style.transform, 'translateY(60px)', '指示条位移必须等于行的 offsetTop');
    assert.ok(tipEl._cls.has('has-cursor'), '选中后必须加 has-cursor（CSS 靠它显示指示条）');
    assert.ok(rows[2].has('is-cursor'), '被选行必须加 is-cursor');
    assert.ok(!rows[0].has('is-cursor'), '未选行必须清掉 is-cursor');

    sandbox.__set(10);
    assert.equal(cursorEl.style.transform, 'translateY(0px)', '移到第一行时位移归零');
    assert.ok(rows[0].has('is-cursor') && !rows[2].has('is-cursor'), '选中必须唯一');

    /* 【本轮新增·杀死“早退优化”变异体】
       曾经的实现里有 `if (historyRailTipIdx === msgIdx) return;`。它看似是「已经选中就不动」
       的优化，实际是一个真实缺陷：卡片隐藏时 scheduleRailTipHide 会移除 has-cursor，
       但【不会】重置 historyRailTipIdx。于是「悬停第 3 根 → 移开 → 再悬停第 3 根」时，
       函数在第一步就 return，has-cursor 再也不会加回来 —— 卡片能显示、is-cursor 也正确，
       但滑动指示条的 computed opacity 恒为 0。真实浏览器实测：第一次 op=1，第二次 op=0。
       所以必须验证「重置 has-cursor 后重复选中同一行，仍会重新点亮」。 */
    tipEl._cls.delete('has-cursor');
    sandbox.__set(30);  // 与上一行 msgIdx 相同的连续调用才是早退的触发形状
    assert.ok(tipEl._cls.has('has-cursor'),
        '重复选中同一行时必须重新点亮 has-cursor：早退会让「二次悬停」的指示条永远不出现');
    assert.ok(rows[2].has('is-cursor'), '重复选中同一行时 is-cursor 也必须仍在');
    /* 【必须连续两次相同】上面第一次 __set(30) 时内部 idx 还是 10，不构成早退；
       这一行才是真触发：idx 已是 30，再选 30。曾因测试漏了这一层，
       变异体（把早退加回去）竟能 SURVIVED —— 测试自己的形状不对，等于没测。 */
    tipEl._cls.delete('has-cursor');
    sandbox.__set(30);  // idx 已=30，再选 30 → 真正的早退路径
    assert.ok(tipEl._cls.has('has-cursor'),
        '连续两次选中同一行时，has-cursor 必须仍然被重新点亮（早退实现到此就会丢');
});

/* ============ 10. 等距布局与点击定位的一致性 ============ */

test('等距下点击任意刻度都必须落到对应消息（采样后仍需逐一可点）', () => {
    /* 采样会跳过中间条：轨道第 3 根可能对应 messages[7]。
       点击必须读 data-msg-idx，不能按下标去猜 —— 猜就会跳错消息，
       而「跳错」在长对话里极难被用户归因为「导航 bug」。 */
    const clickHandler = js.slice(js.indexOf("$historyRailTrack.on('click', '.history-rail-tick'"));
    assert.match(clickHandler.slice(0, 300), /data-msg-idx/,
        '点击必须用 data-msg-idx 定位，不能按第几根推算');
    const rowClick = js.slice(js.indexOf("$historyRailTip.on('click', '.history-rail-tip-row'"));
    assert.match(rowClick.slice(0, 300), /data-msg-idx/, '卡片行点击同理必须用 data-msg-idx');
});

test('卡片行与轨道刻度共用同一套跳转逻辑（不得各写一份）', () => {
    const code = codeOnly(js);
    const calls = code.split('locateUserMessage(').length - 1;
    /* 定义 1 处 + 刻度点击 1 处 + 卡片行点击 1 处 = 3。
       多于 3 说明有人另写了一条跳转路径（两套滚动/高亮规则必然漂移）。 */
    assert.equal(calls, 3, 'locateUserMessage 应被复用（定义 1 + 两处调用），实际出现 ' + calls + ' 次');
});

test('CSS：卡片退场时 visibility 必须延迟，否则淡出被瞬间切断', () => {
    /* 基类规则是「退场」时生效的那一份。若 transition 里没有 visibility 的延迟，
       移除 .is-shown 后 visibility 在同一帧变 hidden，浏览器立即不再绘制 ——
       而 opacity 过渡还在跑。真实浏览器实测（修复前）：
         t=150ms vis=visible op=1
         t=175ms vis=hidden  op=0.899   ← 这里已经被切断
         t=200ms vis=hidden  op=0.686   ← opacity 在变，但用户什么也看不到
       即入场有动画、退场「啪」地消失。
       断言用「transition 必须包含 visibility 且带非零 delay」表达意图，不钉具体数值。 */
    const rule = cssRule('.history-rail-tip');
    const trans = /transition:\s*([^;]+);/.exec(rule);
    assert.ok(trans, '卡片必须有 transition');
    const decl = trans[1];
    assert.ok(/visibility/.test(decl),
        '基类 transition 必须声明 visibility：不写它时退场瞬间变 hidden，淡出徒劳（实测 op=0.899 时已 hidden）');
    /* visibility 那一项必须带 delay（形如 `visibility 0s .16s` 或 `visibility .16s`） */
    const visPart = /visibility\s+([^,]+)/.exec(decl);
    assert.ok(visPart, 'visibility 必须在 transition 列表里单独一项');
    const visDecl = visPart[1].trim();
    const hasDelay = /\s[\d.]+m?s\s*$/.test(' ' + visDecl) || /^\s*[\d.]+m?s\s+[\d.]+m?s/.test(visDecl);
    assert.ok(hasDelay,
        'visibility 必须带延迟（如 `visibility 0s .16s`），否则隐藏与淡出同帧开始，' +
        '等于把过渡切断；实测声明为：visibility ' + visDecl);

    /* 入场那份必须【零】延迟：否则会出现「淡入动画先跑、元素还不可见」的一帧空白 */
    const shownRule = cssRule('.history-rail-tip.is-shown');
    const shownTrans = /transition:\s*([^;]+);/.exec(shownRule);
    assert.ok(shownTrans, '.is-shown 必须单独声明 transition');
    const shownVis = /visibility\s+([^,]+)/.exec(shownTrans[1]);
    assert.ok(shownVis, '.is-shown 的 transition 必须含 visibility');
    assert.ok(!/\s[\d.]+m?s\s*$/.test(' ' + shownVis[1].trim()) || /^0s$/.test(shownVis[1].trim()),
        '入场时 visibility 必须零延迟，实测：' + shownVis[1].trim());
});

test('CSS：卡片有固定宽度与内部滚动（消息多时不能无限长）', () => {
    const rule = cssRule('.history-rail-tip');
    const w = /width:\s*(\d+)px/.exec(rule);
    assert.ok(w, '卡片必须有固定宽度（内容自适应会随最长一条消息撑到遮住正文）');
    assert.ok(Number(w[1]) >= 260 && Number(w[1]) <= 460,
        '卡片宽度应在 260~460px 之间，实测=' + w[1]);
    const listRule = cssRule('.history-rail-tip-list');
    assert.match(listRule, /max-height:\s*\d+px/, '列表必须有 max-height，否则 60 条会拉成一条长条');
    assert.match(listRule, /overflow-y:\s*auto/, '超出时必须内部滚动');
    assert.match(listRule, /overflow-x:\s*hidden/,
        '横向必须 hidden：行内文本是 nowrap + ellipsis，溢出会形成横向滚条');
});

test('CSS：行文本单行省略且右对齐（与轨道右缘同一基线）', () => {
    const textRule = cssRule('.history-rail-tip-text');
    assert.match(textRule, /white-space:\s*nowrap/, '单行：卡片行不该换行（换行会让行高不一致，指示条位移对不上）');
    assert.match(textRule, /text-overflow:\s*ellipsis/, '必须省略号');
    assert.match(textRule, /min-width:\s*0/,
        'flex 子项必须 min-width:0，否则 nowrap 文本会把行撑破、ellipsis 失效');
    const rowRule = cssRule('.history-rail-tip-row');
    assert.match(rowRule, /text-align:\s*right/, '文本右对齐（对齐参照稿的右缘基线）');
});

test('减少动效时卡片与指示条的过渡也要关掉（新增元素不得漏配）', () => {
    /* 【漏配风险】新增了 cursor / row / text / tick 四条过渡规则，
       若只把旧的两个选择器留在 reduced-motion 块里，系统偏好就会被绕过。 */
    const rmBlocks = [];
    const rmHead = '@media (prefers-reduced-motion: reduce)';
    let cursor = 0;
    while (true) {
        const at = css.indexOf(rmHead, cursor);
        if (at < 0) break;
        let depth = 0, end = at;
        for (let i = at; i < css.length; i++) {
            if (css[i] === '{') depth++;
            else if (css[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        rmBlocks.push(css.slice(at, end));
        cursor = end;
    }
    const railRm = rmBlocks.find((b) => b.includes('.history-rail-tip-cursor'));
    assert.ok(railRm, 'reduced-motion 块必须包含 .history-rail-tip-cursor（指示条是滑动动画的主角）');
    for (const sel of ['.history-rail-tip', '.history-rail-tip-row', '.history-rail-tip-text', '.history-rail-tip-tick']) {
        assert.ok(railRm.includes(sel), 'reduced-motion 块缺少 ' + sel);
    }
    /* 【本轮真缺陷的护栏】.history-rail-tip.is-shown 是两个类（特性度 0,2,0），
       会盖过 reduced-motion 块里单类的 .history-rail-tip（0,1,0）。
       漏掉它的真实后果：开了系统「减少动效」后卡片仍跑 0.16s 的 opacity/transform 过渡
       （实测过），而卡片正是这轮新增的最大动效载体。 */
    assert.ok(railRm.includes('.history-rail-tip.is-shown'),
        'reduced-motion 必须单独列出 .history-rail-tip.is-shown：它特性度更高，' +
        '单写 .history-rail-tip 盖不住它');
    /* 【同样必须订到「真的会生效」】.history-rail-tip-cursor 单独一行存在，
       但若 .has-cursor .history-rail-tip-cursor 也写了一份 transition:none，
       那么删掉基类那行后（同样的 computed 结果）会出现「护栏红了但行为正确」的假阳性。
       反过来也成立：只剩兜底那行时，若兜底被删就真的漏了。
       所以要求两条都在：基类覆盖直接命中，兜底覆盖 .has-cursor 态。 */
    assert.ok(railRm.includes('.history-rail-tip.has-cursor .history-rail-tip-cursor'),
        'reduced-motion 必须显式覆盖 .has-cursor 下的指示条（它是滑动动画的实际作用态）');
    /* 超集校验：凡在本轮新增样式里对 tip 家族声明过 transition/animation 的选择器，
       都必须在 reduced-motion 块里有一条禁用规则。这条可以防止「日后新增一个
       .history-rail-tip-xxx 却忘了关动效」。 */
    const declared = new Set();
    const declRe = /(\.history-rail[^{}]*)\{([^}]*)\}/g;
    let m;
    while ((m = declRe.exec(css))) {
        if (/transition\s*:|animation\s*:/.test(m[2])) {
            const sel = m[1].trim().split(',').pop().trim();
            if (sel.startsWith('.history-rail')) declared.add(sel);
        }
    }
    const reducedText = rmBlocks.join('\n');
    const missing = [...declared].filter((sel) => {
        // 基类选择器在 reduced 块里以「XX,」或「XX {」或「XX }」形式出现即算覆盖
        const base = sel.replace(/\.is-shown$/, '').replace(/\.is-new$/, '').replace(':hover', '');
        return !reducedText.includes(base.replace(':hover', ''));
    });
    assert.equal(missing.length, 0,
        '以下选择器声明了动效但 reduced-motion 未覆盖（新增动效时最易漏）: ' + JSON.stringify(missing));
});
