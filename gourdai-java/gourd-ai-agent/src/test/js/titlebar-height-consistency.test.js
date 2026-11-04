/* ===== titlebar-height-consistency.test.js =====
   桌面壳顶条高度（现 44px）是一条【跨栈契约】：前端 4 个 CSS、两份 Rust 壳常量、
   Electron WCO 覆盖带共 9 个点位必须同源同值。历史上它被写死在多处，每改一次就要
   同步一轮，漏一处即出现肉眼可见回归（错位带 / 原生按钮压内容 / 右栏顶行色差）。

   【为什么不用 CSS 变量单点收口】titlebar-monitor-contract.test.js:611 明令
   doesNotMatch(/--titlebar-strip-h/)：曾把顶条高抽成变量并用于抽屉下移，结果桌面壳
   下右栏头顶露出一段 body 底色色差带（用户两轮报障）。而 Rust 常量与 Electron 的
   titleBarOverlay.height 由系统框架层消费，本就无法读 CSS 变量。所以字面量多点同步
   是既定约束，本测试的职责是把「多点必须一致」这条纪律变成可执行的护栏。

   【断言取向：派生，不钉像素】顶条高 H 一律从 app.css 解析出来，其余点位断言
   「等于 H」或「等于 H + 已声明的呼吸位」。这样：
   - 将来再改高度（44→52 等），本测试自动跟随，不会变成需要陪跑修改的死断言；
   - 但任何一处漏同步必然变红，且报错信息直接指出是哪个消费方漂移。
   唯一被钉死的语义是「标题顶边不得低于商标顶边」与「标题下方必须有留白」——
   它们是用户本轮的原始诉求，不是视觉偏好数值。
*/
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '../../../../../');
const STATIC = path.join(REPO, 'gourdai-java/gourd-ai-agent/src/main/resources/static');
const MIRROR = path.join(REPO, 'gourd-work/desktop/ui');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
const rd = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const appCss = rd(STATIC, 'css', 'app.css');
const codeCss = rd(STATIC, 'css', 'code.css');
const skillsCss = rd(STATIC, 'css', 'skills.css');
const monitorCss = rd(STATIC, 'css', 'task-monitor.css');

/* 取「真正的规则」而非注释里的同名串：app.css 的 .titlebar-task-label 也出现在注释中，
   直接 indexOf 会把注释当主规则（本仓历史踩坑，沿用 titlebar-task-contract 的做法）。 */
function soleRule(css, sel) {
    const re = new RegExp('^\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{', 'm');
    const m = css.match(re);
    assert.ok(m, '必须恰有一条 ' + sel + ' 规则（注释形态不计）');
    const at = css.indexOf(m[0]);
    return css.slice(at, css.indexOf('}', at) + 1);
}

/* ---------- 契约源头：顶条高 H ---------- */
const regionRule = appCss.match(/body\.is-electron \.titlebar-drag-region \{[^}]*\}/);
assert.ok(regionRule, 'body.is-electron .titlebar-drag-region 规则必须存在');
const H = Number((regionRule[0].match(/height:\s*(\d+(?:\.\d+)?)px/) || [])[1]);
test('顶条高必须能从 app.css 唯一解析出来（其余断言全部以此派生）', () => {
    assert.ok(H && H >= 36, '解析顶条高失败或异常小，实际: ' + regionRule[0]);
});

test('label 必须显式顶格，不再靠 align-items:center 居中', () => {
    assert.match(regionRule[0], /align-items:\s*flex-start/,
        '顶条必须 flex-start：居中时盒顶 =(H-盒高)/2，H=44/盒高 21 得 11.5px，'
        + '仍比商标 12px 高 0.5px，用户那句「比商标还高」不会消失');
    const label = soleRule(appCss, '.titlebar-task-label');
    assert.match(label, /margin-top:\s*(\d+(?:\.\d+)?)px/,
        'label 必须自己写 margin-top 顶格（实测 margin/padding 原均为 0，不会叠加）');
});

test('【核心语义】标题顶边不得低于商标顶边（用户：标题顶部不能超过前面的商标的顶部）', () => {
    const labelTop = Number((soleRule(appCss, '.titlebar-task-label').match(/margin-top:\s*([\d.]+)px/) || [])[1]);
    const headerPad = Number((appCss.match(/\.sidebar-header \{ padding:\s*([\d.]+)px/) || [])[1]);
    assert.ok(Number.isFinite(labelTop) && Number.isFinite(headerPad),
        '必须能解析 label margin-top 与 .sidebar-header padding-top');
    /* 商标顶边 = header padding-top（实测 logo 自身 margin/padding 均为 0，
       header-top 是 header 首子且 align-items:center 不产生额外偏移 → logo.top=12.00）。 */
    assert.ok(labelTop >= headerPad,
        '标题顶边（' + labelTop + 'px）必须 ≥ 商标顶边（' + headerPad + 'px），否则标题比商标还高');
});

test('【核心语义】标题下方必须有可感知留白（用户：不要看起来挤在一起）', () => {
    const label = soleRule(appCss, '.titlebar-task-label');
    const fs_ = Number((label.match(/font-size:\s*([\d.]+)px/) || [])[1]);
    const lhRatio = Number((label.match(/line-height:\s*([\d.]+)/) || [])[1]);
    const top = Number((label.match(/margin-top:\s*([\d.]+)px/) || [])[1]);
    assert.ok(fs_ && lhRatio && Number.isFinite(top), '字号/行高/顶格值必须齐全');
    const boxH = fs_ * lhRatio;
    const below = H - top - boxH;
    /* 不钉死具体像素，钉意图：留白必须存在且大到肉眼可辨（>=8px）。
       用户报的原始状态是「结构性留白 0.00px」（内容区 top 恒等于 region bottom，
       视觉那 8.2px 只是 line-height 的 leading），所以只要求 >0 是不够的。 */
    assert.ok(below >= 8,
        '标题底边到内容区必须有 ≥8px 留白（实际 ' + below.toFixed(2) +
        'px = 顶条 ' + H + ' - 顶格 ' + top + ' - 盒高 ' + boxH.toFixed(2) + '）');
});

/* ---------- 其余 8 个消费点：必须等于 H 或 H + 声明的呼吸位 ---------- */
test('【有效顶边】沿 markup 真实嵌套推导，任何一层居中都会吃掉 margin-top', () => {
    /* index.html 的三层嵌套：.titlebar-drag-region > .titlebar-task > .titlebar-task-label。
       label 的 margin-top 只有在【它的直接 flex 父级】是 flex-start 时才等于真实顶边；
       若 .titlebar-task 改成 align-items:center，label 会在 height:100% 的父级里居中，
       顶边 =(H - 盒高)/2 = 11.5px，比商标 12px 还高——正是用户那句「比商标还高」。
       旧断言只查外层 region 的 align-items，查不到这一层（变异 M3 双侧同改仍 SURVIVED 为证）。 */
    const taskRule = soleRule(appCss, '.titlebar-task');
    const ai = taskRule.match(/align-items:\s*([a-z-]+)/);
    assert.ok(ai, '.titlebar-task 必须显式声明 align-items（不能留给默认值 stretch）');
    assert.strictEqual(ai[1], 'flex-start',
        '.titlebar-task 必须是 flex-start：它是 label 的直接 flex 父级，居中会吃掉 margin-top');
    assert.match(taskRule, /height:\s*100%/,
        '.titlebar-task 保持 height:100%（顶格靠 label 的 margin-top 表达，不靠父级高度收缩）');

    // 有效顶边：flex-start 时 = margin-top；center 时 =(H - 盒高)/2 取两者较大者做兜底校验
    const label = soleRule(appCss, '.titlebar-task-label');
    const top = Number((label.match(/margin-top:\s*([\d.]+)px/) || [])[1]);
    const fs_ = Number((label.match(/font-size:\s*([\d.]+)px/) || [])[1]);
    const lh = Number((label.match(/line-height:\s*([\d.]+)/) || [])[1]);
    const boxH = fs_ * lh;
    const effectiveTop = ai[1] === 'flex-start' ? top : Math.min(top, (H - boxH) / 2);
    const headerPad = Number((appCss.match(/\.sidebar-header \{ padding:\s*([\d.]+)px/) || [])[1]);
    assert.ok(effectiveTop >= headerPad,
        '标题【有效】顶边（' + effectiveTop.toFixed(2) + 'px）必须 ≥ 商标顶边（' + headerPad +
        'px）；只看 margin-top 声明值会漏掉居中带来的偏移');
});

test('code.css：.main-area 让位与拖拽条高必须同值（否则通栏与内容露缝或重叠）', () => {
    const pad = Number((codeCss.match(/body\.is-electron\.code-mode \.main-area \{[^}]*padding-top:\s*(\d+)px/) || [])[1]);
    const h = Number((codeCss.match(/body\.is-electron\.code-mode \.titlebar-drag-region \{[\s\S]{0,200}?height:\s*(\d+)px/) || [])[1]);
    assert.strictEqual(pad, H, '.main-area padding-top 必须等于顶条高 ' + H);
    assert.strictEqual(h, H, 'code 模式拖拽条 height 必须等于 .main-area padding-top（两者错位即露缝）');
    assert.strictEqual(pad, h, '同文件内两处必须逐字同值');
});

test('code.css：悬浮展开按钮 top = 顶条高 + 22px 呼吸（不随动则挂在标题栏下沿）', () => {
    const top = Number((codeCss.match(/\.code-chat-expand-btn \{[^}]*top:\s*(\d+)px/) || [])[1]);
    assert.ok(Number.isFinite(top), '必须能解析 .code-chat-expand-btn 的 top');
    assert.strictEqual(top - H, 22,
        '展开按钮与顶条底边的呼吸位必须恒为 22px（顶条 36→44 时该值曾漏改，按钮贴到顶条下沿）');
});

test('task-monitor.css：动作组高与抽屉顶行色带高必须等于顶条高', () => {
    const actions = Number((monitorCss.match(/\.titlebar-actions \{[\s\S]{0,200}?height:\s*(\d+)px/) || [])[1]);
    const band = Number((monitorCss.match(/\.task-monitor-drawer::before \{[\s\S]{0,200}?height:\s*(\d+)px/) || [])[1]);
    assert.strictEqual(actions, H,
        '.titlebar-actions 高必须等于顶条高（否则终端/监控按钮与标题不同高，观感错位）');
    assert.strictEqual(band, H,
        '抽屉顶行色带高必须等于顶条高（差 8px 就在 44px 顶条里留下一段色差带，已实测确认）');
});

test('skills.css：头部 padding-top = 顶条高 + 4px 呼吸（让开原生窗口控件）', () => {
    const pt = Number((skillsCss.match(/body\.is-electron \.skills-head \.skills-inner \{ padding-top:\s*(\d+)px/) || [])[1]);
    assert.ok(Number.isFinite(pt), '必须能解析 skills-inner 的 padding-top');
    assert.strictEqual(pt - H, 4, 'skills 头部呼吸位必须恒为 4px（36+4=40 的旧口径已随顶条升级）');
    assert.ok(pt >= H, 'padding-top 必须 ≥ 顶条高，否则顶栏内容被原生窗口按钮遮挡');
});

test('Rust 两份壳的 TITLEBAR_HEIGHT 必须等于顶条高（自绘窗控 top:0;height 同源）', () => {
    const trees = [
        ['gourd-work/desktop/src-tauri/src/titlebar_ui.rs', true],
        ['gourdai-java/gourd-ai-tauri/src-tauri/src/titlebar_ui.rs', false],
    ];
    for (const [rel, required] of trees) {
        const p = path.join(REPO, rel.replace(/\//g, path.sep));
        if (!fs.existsSync(p)) {
            assert.ok(!required, '活跃 Rust 壳必须存在: ' + rel);
            continue;
        }
        const v = Number((rd(p).match(/const TITLEBAR_HEIGHT: u32 = (\d+);/) || [])[1]);
        assert.ok(Number.isFinite(v), rel + ' 必须保留 TITLEBAR_HEIGHT 声明');
        assert.strictEqual(v, H, rel + ' 的 TITLEBAR_HEIGHT 必须等于 app.css 顶条高 ' + H +
            '（注入脚本按它画 .__gourd_tb_strip 的 top:0;height，并写进 region 的 padding-right 基线）');
    }
});

test('Electron 的 titleBarOverlay.height 两主题都必须等于顶条高（WCO 由系统框架层消费）', () => {
    const jsPath = path.join(REPO, 'gourdai-java/gourd-ai-desktop/main/titlebar.js');
    if (!fs.existsSync(jsPath)) return; // 干净检出无 Electron 壳：显式跳过
    const t = rd(jsPath);
    const hs = [...t.matchAll(/height:\s*(\d+)/g)].map((m) => Number(m[1]));
    assert.strictEqual(hs.length, 2, 'THEME_COLORS 必须恰有 light/dark 两个 height，实际 ' + hs.join(','));
    for (const h of hs) {
        assert.strictEqual(h, H,
            'WCO 覆盖带高度必须等于顶条高：小于顶条则顶条下半截无法拖动且原生按钮上浮压内容，'
            + '大于顶条则控件带压进内容区');
    }
});

test('禁止把顶条高重新抽成 CSS 变量（与 titlebar-monitor-contract 的禁令呼应）', () => {
    /* 【只查代码，不查注释】本文件与 app.css 的注释都要提到这个变量名（解释为什么
       不能用它），首版直接 doesNotMatch(css) 把自己的说明文字判成违规——与
       titlebar-task-contract 首版搜 min(46% 自伤是同一类错误。 */
    for (const [name, css] of [['app.css', appCss], ['code.css', codeCss],
        ['skills.css', skillsCss], ['task-monitor.css', monitorCss]]) {
        const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
        assert.doesNotMatch(code, /--titlebar-strip-h/,
            name + ' 的代码里不得再出现 --titlebar-strip-h：该变量用于抽屉下移时会在右栏头顶露出色差带');
    }
});

/* ---------- 高度漂移：只认「顶条相关选择器的规则体内部数值」 ----------
   前几条派生断言已分别钉住 code / skills / task-monitor 各自的目标值，本条是跨文件的
   兜底冗余：任何选择器名带 titlebar / task-monitor-drawer::before / skills-inner 的规则，
   其 height / padding-top 只允许是 H、H+4、H+22 之一（或 0，指浏览器形态的不占位基准）。
   【为什么不再做文本扫描】首版想用正则区分「现状描述 vs 历史叙述」，结果把注释里的
   论证句「三条在 36px 内只能满足两条」和一堆与顶条无关的 width:36px 全判成失真。
   注释里的历史数字是有意保留的取证（防后人不知道为什么不能退回旧值），代码里的数值
   才是契约——所以只查代码，且只查这些选择器的规则体。 */
test('顶条相关规则体内的高度值不得漂回旧口径', () => {
    const ALLOWED = new Set([H, H + 4, H + 22, 0]);
    const corpus = [['app.css', appCss], ['code.css', codeCss],
        ['skills.css', skillsCss], ['task-monitor.css', monitorCss]];
    const offenders = [];
    for (const [file, css] of corpus) {
        const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
        /* 逐个规则体：选择器 + { 声明 } */
        const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
        let m;
        while ((m = ruleRe.exec(code)) !== null) {
            const sel = m[1].trim().split('\n').pop().trim();
            if (!/titlebar|task-monitor-drawer::before|skills-inner/.test(sel)) continue;
            /* 零件级不算顶条契约：.titlebar-action-btn 的 26px 与 Rust BUTTON_HEIGHT 逐字对齐，
               另有 monitor 契约专门钉住（不得撞满顶条高）。首版用 /titlebar/ 宽匹配把它误判成
               漂移；正解是收紧范围，【不是】把 26 放进 ALLOWED——那会连带放过“按钮撞满顶条、
               hover 底变成整条色带”这个真回归。 */
            if (/action-btn$/.test(sel)) continue;
            if (/\bdisplay:\s*none\b/.test(m[2])) continue; // skills 视图里整体隐藏的形态不占位
            for (const d of m[2].matchAll(/(?:^|[;\s])(height|padding-top):\s*(\d+(?:\.\d+)?)px/g)) {
                const v = Number(d[2]);
                if (!ALLOWED.has(v)) offenders.push(file + ' :: ' + sel + ' -> ' + d[1] + ': ' + v + 'px');
            }
        }
    }
    assert.deepStrictEqual(offenders, [],
        '以下顶条相关规则的高度值不等于 H=' + H + '（也不等于 H+4 / H+22 / 0），跨栈契约已漂移:\n' +
        offenders.join('\n'));
});

/* ---------- 镜像纪律：app.css 只能按区块比，整文件必然不同 ---------- */
test('Rust 壳真镜像 desktop/ui：顶条区块必须与 static 逐字节一致', () => {
    if (!fs.existsSync(MIRROR)) return; // CI 干净检出无镜像：显式跳过
    const A = '/* ===== Electron', B = '/* ===== Sidebar ===== */';
    const block = (t) => {
        const i = t.indexOf(A), j = t.indexOf(B, i);
        assert.ok(i >= 0 && j > i, '镜像与源都必须含顶条区块边界标记');
        return t.slice(i, j);
    };
    const mb = block(rd(MIRROR, 'css', 'app.css'));
    assert.strictEqual(sha(Buffer.from(block(appCss))), sha(Buffer.from(mb)),
        'desktop/ui 顶条区块与 static 不一致（Rust 壳 frontendDist 真镜像，手工同步）');
    /* 严禁整文件覆盖：mirror 的 app.css 比 static 多出并行主题内容（刻度带/骨架屏），
       覆盖会直接删掉别人的工作。这里断言差异确实存在且只在该区块之外。 */
    assert.ok(rd(MIRROR, 'css', 'app.css').length >= appCss.length - 1000,
        '镜像 app.css 若显著短于 static，说明有人做了整文件覆盖、丢了并行主题内容');
    for (const f of ['code.css', 'skills.css', 'task-monitor.css']) {
        assert.strictEqual(sha(rd(STATIC, 'css', f)), sha(rd(MIRROR, 'css', f)),
            'desktop/ui 镜像不同步: css/' + f);
    }
});
