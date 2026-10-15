/* ===== dialog-visual-contract.test.js =====
   应用内确认弹窗（.kd-* 家族）视觉契约。
   背景：用户反馈「这种提示框……你这中提示肯定有问题」（原生 confirm 带 localhost 来源标题，
   桌面端穿帮）→ 全仓改走 layConfirm/layAlert；随后反馈「这个不需要去掉，看的还丑」→
   保留弹窗、精修视觉。本契约锁住精修成果，防回退。

   锁定的客观缺陷（浏览器取证确证，非主观审美）：
   ① 阴影硬编码 rgba(0,0,0,.14) 两主题同值 → 暗色底色近黑，阴影不可见，卡片与遮罩糊成一块；
   ② 遮罩硬编码 rgba(0,0,0,.3) → 令牌 --overlay（light .45 / dark .62）被无视；
   ③ layui 默认 layer-bounceIn 弹跳入场 → 桌面端确认框显得轻浮；
   ④ hover 用 filter: brightness(0.95) → 暗色下等于【变暗】，底色 #232327 本已接近页面底，更难辨认；
   ⑤ 无显式 focus 环（只靠全局 *:focus-visible）→ 主按钮是 accent 实底，单靠 outline 几乎看不出边界；
   ⑥ 取消钮铺 --bg-hover 实底 → 与主操作一样重，主次不分；
   ⑦ .kd-confirm 用 min-width/max-width 内容撑宽 → 短句 302px / 长句 340px，弹窗宽窄不一；
   ⑧ 两条渲染路径（layui layer / 无 layer 兜底）观感不一致。

   色彩治理约定：本块（Custom layer dialogs）不得出现颜色/阴影字面量，一律走 theme.css 令牌。
   硬约束：.kd-btn-ok 的 background/color 不得改——hitl-btn-accent.test.js 拿它当
   HITL approve 按钮的【参照基准】（断言两者同 token）。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATIC = path.resolve(__dirname, '../../main/resources/static');
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), 'utf8');
const themeCss = read('css', 'theme.css');

/* 取某主题的令牌块（[data-theme="x"] { ... }） */
function themeBlock(theme) {
    const i = themeCss.indexOf('[data-theme="' + theme + '"]');
    assert.ok(i >= 0, 'theme.css 必须有 [data-theme="' + theme + '"] 作用域');
    const end = themeCss.indexOf('\n}', i);
    assert.ok(end > i, '主题块必须闭合');
    return themeCss.slice(i, end);
}
/* 取某选择器的规则体（取第一处；用于 .kd-* 家族） */
function ruleBody(sel) {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = themeCss.match(new RegExp(esc + '\\s*\\{([^}]*)\\}'));
    assert.ok(m, '必须存在规则：' + sel);
    return m[1];
}
/* 剥块注释（色彩字面量禁令只在真实声明上判定；注释里解释旧缺陷会提到旧值） */
function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ''); }
/* 弹窗块（从 "Custom layer dialogs" 到文件尾） */
function dialogBlock() {
    const i = themeCss.indexOf('/* ===== Custom layer dialogs =====');
    assert.ok(i >= 0, 'theme.css 必须保留 Custom layer dialogs 块标记');
    return themeCss.slice(i);
}
function alphaOf(rgba) {
    const m = String(rgba).match(/rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*([\d.]+)\s*)?\)/);
    assert.ok(m, '无法解析 alpha: ' + rgba);
    return m[1] === undefined ? 1 : parseFloat(m[1]);
}

// ---------- ① 阴影令牌 ----------
test('--shadow-modal 明暗成套且暗色显著更重（弹窗专用阴影）', () => {
    const L = themeBlock('light').match(/--shadow-modal\s*:\s*([^;]+);/);
    const D = themeBlock('dark').match(/--shadow-modal\s*:\s*([^;]+);/);
    assert.ok(L, 'light 主题缺少 --shadow-modal');
    assert.ok(D, 'dark 主题缺少 --shadow-modal');
    assert.notStrictEqual(L[1].trim(), D[1].trim(),
        '明暗必须取值不同：同值 = 暗色下阴影不可见（底色近黑），卡片与遮罩糊成一块（本次精修的①号缺陷）');
    /* 暗色必须比明色重：取首个 rgba 的 alpha 比较 */
    const la = alphaOf(L[1].match(/rgba?\([^)]*\)/)[0]);
    const da = alphaOf(D[1].match(/rgba?\([^)]*\)/)[0]);
    assert.ok(da > la + 0.2, '暗色阴影必须显著更重（light ' + la + ' → dark ' + da + '）');
});

test('两条渲染路径的可见框阴影均取自 --shadow-modal（不得硬编码）', () => {
    assert.match(ruleBody('.kd-layer.layui-layer'), /box-shadow:\s*var\(--shadow-modal\)\s*!important/,
        'layui 外壳必须用 --shadow-modal');
    assert.match(ruleBody('.kd-fallback-overlay .kd-confirm'), /box-shadow:\s*var\(--shadow-modal\)/,
        '兜底卡片必须用 --shadow-modal（与 layui 路径同源，否则同一产品两种观感）');
});

// ---------- ② 遮罩 ----------
test('遮罩走 --overlay 令牌，且 layui 遮罩双属性覆盖', () => {
    assert.match(ruleBody('.kd-fallback-overlay'), /background:\s*var\(--overlay\)/,
        '兜底遮罩必须走 --overlay（旧实现写死 rgba(0,0,0,.3)，两主题同值 = ②号缺陷）');
    const shade = ruleBody('.layui-layer-shade');
    assert.match(shade, /background:\s*var\(--overlay\)\s*!important/, 'layui 遮罩背景必须覆盖为令牌');
    /* layui 把 shade 的透明度写在 inline style，只改 background 会被 inline opacity 再乘一道 */
    assert.match(shade, /opacity:\s*1\s*!important/,
        '必须同时覆盖 inline opacity，否则 background 会被 layui 的 shade 值再乘一次 → 暗色仍偏浅');
    /* --overlay 本身明暗成对且暗色更深（dark-theme-token-contract 已有门禁，此处只确认存在） */
    const L = themeBlock('light').match(/--overlay\s*:\s*([^;]+);/);
    const D = themeBlock('dark').match(/--overlay\s*:\s*([^;]+);/);
    assert.ok(L && D, '--overlay 必须明暗成套');
    assert.ok(alphaOf(D[1]) > alphaOf(L[1]), '暗色遮罩必须更深，否则卡片无法从近黑背景分离');
});

// ---------- ③ 入场动效 ----------
test('入场动效用 kd-dialog-in 淡入上浮，layui 默认弹跳不得回归', () => {
    assert.match(themeCss, /@keyframes kd-dialog-in\s*\{/, '必须定义 kd-dialog-in');
    assert.match(themeCss, /@keyframes kd-overlay-in\s*\{/, '必须定义 kd-overlay-in（兜底遮罩淡入）');
    assert.match(ruleBody('.kd-layer.layui-layer'), /animation:\s*kd-dialog-in\s+\.18s/,
        'layui 外壳入场必须替换为 kd-dialog-in');
    assert.match(ruleBody('.kd-fallback-overlay .kd-confirm'), /animation:\s*kd-dialog-in/,
        '兜底卡片入场必须与 layui 路径一致');
    /* 弹跳回归禁令：全文件不得再出现 bounce（layui 默认 layer-bounceIn） */
    assert.doesNotMatch(stripComments(themeCss), /bounce/i,
        '不得回归 layui 弹跳入场（桌面端确认框用弹跳显得轻浮）');
    /* 尊重系统减弱动效偏好（既有 a11y 规则必须仍覆盖弹窗） */
    assert.match(themeCss, /@media \(prefers-reduced-motion: reduce\)/, 'reduced-motion 兜底不得被删');
});

// ---------- ④⑥ hover 与主次 ----------
test('取消钮为 ghost（透明底+描边），hover 走令牌切背景', () => {
    const base = ruleBody('.kd-btn');
    assert.match(base, /background:\s*transparent/,
        '取消钮必须透明底：旧实现铺 var(--bg-hover) 实底，与主操作一样重 → 主次不分（⑥号缺陷）');
    assert.match(base, /border:\s*1px solid var\(--border-color\)/, 'ghost 仍须有描边（保留可点感）');
    assert.match(base, /min-width:\s*72px/, '按钮须有最小宽度（避免「取消/确定」宽度不齐）');
    const hover = ruleBody('.kd-btn:hover');
    assert.match(hover, /background:\s*var\(--bg-hover\)/, 'hover 必须走令牌切背景');
    /* brightness 回归禁令：暗色下 brightness(0.95) = 变暗，底色 #232327 本已接近页面底，hover 反而更难辨认 */
    assert.doesNotMatch(stripComments(dialogBlock()), /filter:\s*brightness/,
        '不得用 filter: brightness 做 hover（暗色下等于变暗，④号缺陷）');
    /* 主操作 hover 也须走令牌，不得用 opacity 淡化（淡底在浅背景上会发灰） */
    const okHover = ruleBody('.kd-btn-ok:hover');
    assert.match(okHover, /background:\s*var\(--accent-hover\)/, '主按钮 hover 必须走 --accent-hover');
    assert.doesNotMatch(okHover, /opacity/, '主按钮 hover 不得用 opacity 淡化');
});

test('.kd-btn-ok 的 background/color 保持 HITL approve 参照基准', () => {
    /* WHY 这条存在：hitl-btn-accent.test.js 断言 approve 按钮与 .kd-btn-ok 同 token，
       拿它当【参照基准】。精修时若顺手改了主按钮配色，会连带打破那份契约而不报错在此处。 */
    const ok = ruleBody('.kd-btn-ok');
    assert.match(ok, /background:\s*var\(--accent\)/, '.kd-btn-ok 底色必须是 var(--accent)');
    assert.match(ok, /color:\s*var\(--accent-contrast\)/, '.kd-btn-ok 文字必须是 var(--accent-contrast)');
});

// ---------- ⑤ focus 环 ----------
test('按钮有显式双层焦点环（键盘可达性）', () => {
    const fv = ruleBody('.kd-btn:focus-visible');
    assert.match(fv, /outline:\s*none/, '焦点环改用 box-shadow，须先关掉 outline 避免双环');
    assert.match(fv, /box-shadow:\s*0 0 0 2px var\(--bg-primary\), 0 0 0 4px var\(--accent\)/,
        '必须双层：内层用卡片底色隔出间隙，否则单靠 outline 在主按钮（accent 实底）上几乎看不出边界（⑤号缺陷）');
});

// ---------- ⑦⑧ 卡片规格与两路径一致 ----------
test('卡片定宽（两路径一致），不再内容撑宽', () => {
    const card = ruleBody('.kd-confirm');
    assert.match(card, /width:\s*340px/, '必须定宽 340（旧实现内容撑宽：短句 302 / 长句 340 → ⑦号缺陷）');
    assert.match(card, /max-width:\s*calc\(100vw - 32px\)/, '窄屏不得溢出视口');
    assert.match(card, /box-sizing:\s*border-box/, '定宽 + padding 必须 border-box，否则实际宽 = 340+44');
    assert.doesNotMatch(card, /min-width:\s*260px/, '旧的 min-width 撑宽形态不得回归');
    /* 两路径圆角一致（⑧号缺陷：观感必须一致） */
    assert.match(ruleBody('.kd-layer.layui-layer'), /border-radius:\s*14px\s*!important/, 'layui 外壳圆角 14px');
    assert.match(ruleBody('.kd-fallback-overlay .kd-confirm'), /border-radius:\s*14px/, '兜底卡片圆角必须同为 14px');
});

// ---------- 色彩治理：字面量禁令 ----------
test('弹窗块零颜色/阴影字面量（一律走 theme.css 令牌）', () => {
    const stripped = stripComments(dialogBlock());
    const hits = stripped.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}\b/g) || [];
    assert.deepStrictEqual(hits, [],
        '弹窗块声明里不得出现颜色字面量（注释里解释旧缺陷可以提，故先剥注释）。命中: ' + JSON.stringify(hits));
    /* 旧遗留的 dark msg 覆盖必须也已走令牌 */
    assert.doesNotMatch(stripped, /#2a2d33|#444\b/, '旧的 #2a2d33 / #444 非全站 zinc 色阶，不得残留');
});

test('弹窗引用的令牌在两主题均成套定义（漏一套 = 该主题掉初始值）', () => {
    const used = new Set();
    for (const m of dialogBlock().matchAll(/var\(--([a-z0-9-]+)\)/g)) used.add(m[1]);
    assert.ok(used.size >= 8, '弹窗块应引用足够多的令牌，实际 ' + used.size + ': ' + [...used].join(','));
    for (const t of ['light', 'dark']) {
        const blk = themeBlock(t);
        for (const name of used) {
            assert.match(blk, new RegExp('--' + name.replace(/-/g, '\\-') + '\\s*:'),
                t + ' 主题缺少令牌 --' + name + '（弹窗会掉回初始值）');
        }
    }
});

// ---------- 原生对话框禁令（上一轮的规约，不得回退） ----------
test('全仓 static/js 无裸原生 confirm/alert/prompt（桌面端规约）', () => {
    const jsDir = path.join(STATIC, 'js');
    const offenders = [];
    for (const f of fs.readdirSync(jsDir).filter(x => x.endsWith('.js'))) {
        const src = stripComments(fs.readFileSync(path.join(jsDir, f), 'utf8'));
        for (const re of [/(?<![\w.])window\.confirm\s*\(/g, /(?<![\w.])window\.alert\s*\(/g, /(?<![\w.])window\.prompt\s*\(/g,
            /(?<![\w.$])confirm\s*\((?!Discard)/g, /(?<![\w.$])alert\s*\(/g]) {
            const m = src.match(re);
            if (m) offenders.push(f + ' x' + m.length + ' :: ' + re.source);
        }
    }
    assert.deepStrictEqual(offenders, [], '原生对话框会在桌面壳里暴露 localhost 来源标题（穿帮）: ' + JSON.stringify(offenders));
});

test('layConfirm/layAlert 内置无 layer 兜底，绝不回落原生', () => {
    const base = read('js', 'app-base.js');
    assert.match(base, /function layConfirm\(/, 'layConfirm 必须存在');
    assert.match(base, /fallbackConfirm\(/, 'layConfirm 必须在无 layer 时走自建兜底');
    assert.match(base, /kd-fallback-overlay/, '兜底遮罩类名必须与 theme.css 对齐');
    /* 兜底里不得出现原生 confirm */
    const fb = base.slice(base.indexOf('function fallbackConfirm('), base.indexOf('function layAlert('));
    assert.doesNotMatch(fb, /window\.confirm|[^.\w]confirm\(/, '兜底实现内部不得回落原生 confirm');
});

// ---------- 镜像同步 ----------
test('theme.css 与 tauri 镜像逐字节一致', () => {
    const mirror = path.resolve(__dirname, '../../../../gourd-ai-tauri/ui/css/theme.css');
    if (!fs.existsSync(mirror)) return;   // CI 干净检出无镜像：显式跳过
    const a = fs.readFileSync(path.join(STATIC, 'css', 'theme.css'));
    const b = fs.readFileSync(mirror);
    assert.strictEqual(crypto.createHash('sha256').update(a).digest('hex'),
        crypto.createHash('sha256').update(b).digest('hex'),
        '镜像不同步: css/theme.css（跑 node gourd-ai-tauri/cmd/prepare-ui.js）');
});
