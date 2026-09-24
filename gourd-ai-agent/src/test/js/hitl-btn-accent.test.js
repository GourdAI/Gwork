/**
 * 契约测试：HITL 审批卡两个按钮的配色（approve 走 accent 派生，reject 降为中性描边）
 * + 全组合 WCAG 对比度门禁。
 *
 * 背景：这两个按钮曾各自铺 --color-success / --color-danger 高饱和实底并写死 #fff。
 * 全站中性色阶已收敛为 zinc 系（accent 默认=石墨黑灰）后，这一对红绿成了消息流里
 * 唯一的强彩色块，与灰阶卡片明显脱节。本次改为与全站主/次操作同构：
 *   approve = accent 实心主操作（同 .kd-btn-ok / 侧栏「立即安装」按钮族）
 *   reject  = 透明底 + 描边 + 二级文字的次操作，危险色只在 hover 现身
 *
 * 覆盖：
 * - approve 背景/文字/hover 全部来自 accent 派生令牌，且不得再出现 #fff 或 --color-success
 * - reject 静止态为中性（--border-input / --text-secondary），危险色仅存在于 :hover
 * - 两变体盒模型一致：边框宽度在基类统一给，变体不得回写 border: none（否则一高一矮）
 * - 规则内不得出现颜色字面量（色彩治理约定第 1 条：字面量只允许在 theme.css）
 * - 按钮引用的每个令牌必须在 theme.css 明暗两套主题都成套定义（漏一套 = 该主题下掉初始值）
 * - 【对比度门禁】5 accent × 2 主题 × 4 态（approve/reject 各静止+hover）文字对比度
 *   必须 ≥ WCAG AA 4.5（13px 属普通文本），已知基线偏差须显式登记
 * - 两处建卡仍复用同一对按钮类名（样式与 JS 不得漂移）
 * - gourd-ai-tauri/ui 发布副本与 static 源同步
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const appCss = readStatic('css', 'app.css');
const themeCss = readStatic('css', 'theme.css');

const BTN = '.hitl-btn';
const APPROVE = '.hitl-btn-approve';
const APPROVE_HOVER = '.hitl-btn-approve:hover';
const REJECT = '.hitl-btn-reject';
const REJECT_HOVER = '.hitl-btn-reject:hover';

/* 提取「选择器 + 紧随其后的声明块」，并剔除 /* ... *\/ 注释：
   注释里会解释「为什么不写 #fff / 为什么不铺淡红底」，若按原始文本匹配会让反向断言形同虚设。 */
function ruleBody(source, selector) {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
    const m = source.match(new RegExp(esc + '\\s*\\{([\\s\\S]*?)\\}'));
    assert.ok(m, '未找到样式规则: ' + selector);
    return m[1].replace(/\/\*[\s\S]*?\*\//g, '');
}

test('approve 为 accent 实心主操作，文字走 --accent-contrast', () => {
    const base = ruleBody(appCss, BTN);
    const approve = ruleBody(appCss, APPROVE);
    const hover = ruleBody(appCss, APPROVE_HOVER);

    assert.match(approve, /background:\s*var\(--accent\)/, 'approve 背景必须由 accent 派生（跟随用户强调色预设）');
    assert.match(approve, /color:\s*var\(--accent-contrast\)/, 'approve 文字必须用 --accent-contrast，不能写死 #fff');
    assert.match(hover, /background:\s*var\(--accent-hover\)/, 'approve 悬停必须加深到 accent-hover');

    // 写死白字在暗色主题下会随 accent 提亮而对比度崩塌（治理约定第 4 条）
    assert.doesNotMatch(approve, /color:\s*#(fff|FFF|ffffff|FFFFFF)/, 'approve 不得写死白色文字');
    // 语义回归护栏：改回绿色实底即视为本契约被破坏
    assert.doesNotMatch(approve, /--color-success/, 'approve 不得退回成功色实底');
    assert.doesNotMatch(hover, /--color-success/, 'approve 悬停不得退回成功色');

    // 弹性排布 / 圆角等既有规格不能被顺手改掉
    assert.match(base, /display:\s*flex/, '按钮基类必须保持弹性排布（图标 + 文字）');
    assert.match(base, /border-radius:\s*8px/, '基类圆角规格不得漂移');
});

test('reject 静止态为中性描边次操作，危险色只在 hover 现身', () => {
    const reject = ruleBody(appCss, REJECT);
    const hover = ruleBody(appCss, REJECT_HOVER);

    assert.match(reject, /background:\s*transparent/, 'reject 静止态必须透明底，不与主操作抢注意力');
    assert.match(reject, /border-color:\s*var\(--border-input\)/, 'reject 静止态描边取输入框边框色（中性）');
    assert.match(reject, /color:\s*var\(--text-secondary\)/, 'reject 静止态文字取二级色');

    assert.doesNotMatch(reject, /--color-danger/, 'reject 静止态不得出现危险色（否则仍是红块）');
    assert.doesNotMatch(reject, /color:\s*#(fff|FFF|ffffff|FFFFFF)/, 'reject 不得写死白色文字');

    // 拒绝的风险语义保留在 hover：指针指向时才让危险色现身
    assert.match(hover, /border-color:\s*var\(--color-danger\)/, 'reject 悬停描边必须变危险色（保留拒绝语义）');
    assert.match(hover, /color:\s*var\(--color-danger-hover\)/, 'reject 悬停文字取危险色深档（对比度达标需要）');
    /* 【实测钉死】hover 不得铺 --bg-danger-subtle：淡红底抬高背景亮度，
       红字落在其上仅 3.29:1（light 全 5 套 accent 均不达标），铺底反而救不回对比度。 */
    assert.doesNotMatch(hover,/--bg-danger-subtle/, 'reject 悬停不得铺淡红底（实测对比度掉到 3.29:1）');
    assert.doesNotMatch(hover, /background:\s*(?!none|transparent)var\(/, 'reject 悬停不应引入任何有色底');
});

test('两变体盒模型一致：边框在基类统一给，变体不得回写 border:none', () => {
    const base = ruleBody(appCss, BTN);
    const reject = ruleBody(appCss, REJECT);
    const approve = ruleBody(appCss, APPROVE);

    assert.match(base, /border:\s*1px solid/, '基类必须统一给 1px 边框衬，两变体才有同一盒模型');
    // 旧写法是基类 border:none + reject 加边框：border-box 下会让两钮高度差 2px
    assert.doesNotMatch(base, /border:\s*none/, '基类不得回退为 border:none（会让 reject 加边框后一高一矮）');
    assert.doesNotMatch(approve, /border:\s*none/, 'approve 不得单写 border:none（会破坏统一盒模型）');
    assert.doesNotMatch(reject, /border:\s*[^;]*solid/, 'reject 只应覆盖 border-color，不应重声明 border 简写');
});

test('按钮规则内不得出现颜色字面量', () => {
    // 色彩治理约定第 1 条：全站颜色字面量只允许出现在 theme.css。
    [BTN, APPROVE, APPROVE_HOVER, REJECT, REJECT_HOVER].forEach(function (sel) {
        const body = ruleBody(appCss, sel);
        assert.doesNotMatch(
            body, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/,
            '按钮样式不得硬编码颜色（应引用令牌）: ' + sel
        );
    });
});

/* ===================== 令牌成套 + 对比度门禁（解析真源，不依赖浏览器） ===================== */

const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '');
function cssBlocks(css) {
    const src = stripComments(css), out = [], re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(src))) out.push({ sel: m[1].replace(/\s+/g, ' ').trim(), body: m[2] });
    return out;
}
function declMap(body) {
    const d = {};
    body.split(';').forEach(part => {
        const i = part.indexOf(':');
        if (i < 0) return;
        const k = part.slice(0, i).trim().toLowerCase();
        if (k) d[k] = part.slice(i + 1).trim();
    });
    return d;
}
const themeBlocks = cssBlocks(themeCss);
/** 取某主题作用域的 token 表：基础 [data-theme=X] 先入，带 [data-accent=Y] 的预设块后入 = 覆盖 */
function tokensFor(themeName, accentName) {
    const vars = {};
    const absorb = b => b.body.split(';').forEach(part => {
        const i = part.indexOf(':');
        if (i < 0) return;
        const k = part.slice(0, i).trim();
        if (k.startsWith('--')) vars[k] = part.slice(i + 1).trim();
    });
    const hitsFor = needAccent => themeBlocks.filter(b => b.sel.split(',').map(s => s.trim()).some(s =>
        s.includes('[data-theme="' + themeName + '"]') && (needAccent ? s.includes('[data-accent="' + accentName + '"]') : !s.includes('[data-accent='))));
    hitsFor(false).forEach(absorb);
    hitsFor(true).forEach(absorb);
    return vars;
}
function resolve(value, vars, depth) {
    depth = depth || 0;
    if (depth > 8 || value == null) return value;
    const v = String(value).trim();
    const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]*)\s*)?\)$/.exec(v);
    if (m) {
        const hit = vars[m[1]];
        if (hit !== undefined) return resolve(hit, vars, depth + 1);
        if (m[2] !== undefined) return resolve(m[2], vars, depth + 1);
        return '__UNDEFINED_TOKEN(' + m[1] + ')__';
    }
    return v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_, name, fb) => {
        const hit = vars[name];
        if (hit !== undefined) return resolve(hit, vars, depth + 1);
        return fb !== undefined ? resolve(fb, vars, depth + 1) : '';
    });
}
function parseColor(str) {
    if (!str) return null;
    const s = String(str).trim();
    let m = /^#([0-9a-f]{3,8})$/i.exec(s);
    if (m) {
        let h = m[1];
        if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
        const v = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
        return { r: v[0], g: v[1], b: v[2], a: h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
        const p = m[1].split(/[,\s/]+/).filter(Boolean);
        const to255 = x => x.endsWith('%') ? parseFloat(x) * 255 / 100 : parseFloat(x);
        return { r: to255(p[0]), g: to255(p[1]), b: to255(p[2]), a: p[3] === undefined ? 1 : (p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3])) };
    }
    if (/^transparent$/i.test(s)) return { r: 0, g: 0, b: 0, a: 0 };
    return null;
}
const lin = c => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lumOf = col => 0.2126 * lin(col.r) + 0.7152 * lin(col.g) + 0.0722 * lin(col.b);
const blend = (fg, bg) => fg.a >= 1 ? { r: fg.r, g: fg.g, b: fg.b, a: 1 }
    : { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };
/** 文字色落在底色（半透明先合成到宿主底）上的 WCAG 对比度 */
function contrastRatio(fgStr, bgStr, hostStr) {
    const fg = parseColor(fgStr);
    let bg = parseColor(bgStr);
    const host = parseColor(hostStr) || { r: 255, g: 255, b: 255, a: 1 };
    if (!fg) return { ratio: null, note: 'fg 无法解析: ' + fgStr };
    if (!bg || bg.a < 1) bg = bg ? blend(bg, host) : host;      // 透明/半透明底 → 落宿主底
    const eff = blend(fg, bg);
    const l1 = lumOf(eff), l2 = lumOf(bg);
    return { ratio: Math.round((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) * 100) / 100 };
}

const THEMES = ['light', 'dark'];
const ACCENTS = ['graphite', 'teal', 'clay', 'sky', 'indigo'];
const AA_NORMAL = 4.5;   // 按钮文字 13px < 18.66px，属 WCAG「普通文本」口径

test('按钮引用的每个令牌必须在 theme.css 明暗两套主题都成套定义', () => {
    // 漏一套 = 该主题下 var() 解析失败掉成初始值（背景透明一类事故）
    const used = new Set();
    [BTN, APPROVE, APPROVE_HOVER, REJECT, REJECT_HOVER].forEach(sel => {
        const body = ruleBody(appCss, sel);
        (body.match(/var\(\s*(--[\w-]+)/g) || []).forEach(s => used.add(/(--)[\w-]+/.test(s) ? /--[\w-]+/.exec(s)[0] : s));
    });
    assert.ok(used.size >= 5, '应至少引用 accent/border/text/danger 令牌，实际: ' + [...used].join(','));
    const light = themeCss.match(/\[data-theme="light"\]\s*\{([\s\S]*?)\}/);
    const dark = themeCss.match(/\[data-theme="dark"\]\s*\{([\s\S]*?)\}/);
    assert.ok(light && dark, 'theme.css 缺少明/暗主题块');
    [...used].forEach(function (t) {
        const re = new RegExp(t.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\s*:');
        assert.match(light[1], re, '亮色主题缺少令牌: ' + t);
        assert.match(dark[1], re, '暗色主题缺少令牌: ' + t);
    });
});

test('对比度门禁：5 accent × 2 主题 × 4 态文字对比度 ≥ WCAG AA 4.5', () => {
    /* 【已知基线偏差】indigo 预设自身 accent token 的既有不足（非本按钮引入，
       .kd-btn-ok / 侧栏「立即安装」按钮同值同红，属主题预设色板的待办）：
       light/indigo #4f6ef7 + 白字 = 4.28；dark/indigo accent-hover #5a75e6 + 深字 = 4.44。
       登记在此而非静默放宽阈值：新增偏差必须显式记账，修好预设后应把本表清空。 */
    const KNOWN_BASELINE = {
        'light/indigo/approve': 4.28,
        'dark/indigo/approveHover': 4.44
    };

    const appr = ruleBody(appCss, APPROVE), apprH = ruleBody(appCss, APPROVE_HOVER);
    const rej = ruleBody(appCss, REJECT), rejH = ruleBody(appCss, REJECT_HOVER);
    const d = body => declMap(body);
    const A = d(appr), AH = d(apprH), R = d(rej), RH = d(rejH);

    /* 宿主底色候选（勿收敛回单点）：审批卡容器实际是 .tool-card.hitl-pending，
       而 .tool-card 自身没有 background（只有 border/radius），按钮落在哪个祖先底色上
       取决于渲染位置。旧实现硬编码赌 --bg-main 一个值——一旦宿主变化，整套数字失效而
       测试仍全绿（恒绿摆设）。改为对消息流中所有可能的祖先底色逐一核算，取最严者。
       实测敏感性确实存在：dark 下 reject 5.57(main) / 5.29(input-box|card)，
       rejectHover 4.75(main) / 4.51(input-box|card)。 */
    const HOSTS = ['--bg-main', '--bg-input-box', '--bg-card'];
    const failures = [];
    const samples = [];
    THEMES.forEach(t => ACCENTS.forEach(ac => {
        const vars = tokensFor(t, ac);
        const cases = {
            approve: [A['color'], A['background']],
            // hover 只改背景，color 沿基础规则级联沿用
            approveHover: [A['color'], AH['background']],
            reject: [R['color'], R['background']],
            rejectHover: [RH['color'], RH['background']]
        };
        Object.keys(cases).forEach(name => HOSTS.forEach(hk => {
            const host = resolve(vars[hk], vars);
            const c = contrastRatio(resolve(cases[name][0], vars), resolve(cases[name][1], vars), host);
            const key = t + '/' + ac + '/' + name;
            const tag = key + '@' + hk.replace('--bg-', '');
            samples.push(tag + '=' + (c.ratio === null ? c.note : c.ratio));
            if (c.ratio === null) { failures.push(tag + ' 无法解析（token 缺失？）: ' + c.note); return; }
            if (c.ratio >= AA_NORMAL) return;
            if (KNOWN_BASELINE[key] !== undefined && Math.abs(c.ratio - KNOWN_BASELINE[key]) < 0.02) return; // 已记账
            failures.push(tag + ' = ' + c.ratio + '（阈值 ' + AA_NORMAL + '）');
        }));
    }));
    assert.equal(failures.length, 0, '对比度不达标:\n  ' + failures.join('\n  '));
    // 反向自检：门禁必须真的在算，而不是恒绿（阈值提到 5 时应当有失败）
    const strict = samples.filter(s => {
        const v = parseFloat(s.split('=')[1]);
        return isFinite(v) && v < AA_NORMAL;
    });
    assert.ok(strict.length >= Object.keys(KNOWN_BASELINE).length,
        '已知基线登记表与实算不符，可能门禁未真正生效: ' + strict.join(','));
});

test('approve 与既有 accent 实底主按钮同 token（口径一致，不出现两套主按钮色）', () => {
    const ok = declMap(ruleBody(themeCss, '.kd-btn-ok'));
    const dl = declMap(ruleBody(appCss, '.sidebar-update-btn[data-state="downloaded"]'));
    assert.equal(ok['background'], 'var(--accent)', '.kd-btn-ok 参照失效，本测试的对照前提已变');
    assert.equal(dl['background'], 'var(--accent)', '侧栏下载按钮参照失效，本测试的对照前提已变');
    const appr = declMap(ruleBody(appCss, APPROVE));
    assert.equal(appr['background'], ok['background'], 'approve 必须与 .kd-btn-ok 同底色 token');
    assert.equal(appr['color'], ok['color'], 'approve 必须与 .kd-btn-ok 同文字色 token');
});

test('两处建卡仍复用同一对按钮类名（样式与 JS 不得漂移）', () => {
    const js = readStatic('js', 'app-message.js');
    const occurrences = js.match(/class="hitl-btn hitl-btn-approve"/g) || [];
    assert.equal(occurrences.length, 2, 'approve 按钮模板应恰好两处（审批卡 + 恢复待审态），改类名须同步本测试');
    assert.match(js, /\.hitl-btn-approve'\)\[0\];/, 'approve 事件绑定选择器不得改名');
    assert.match(js, /\.hitl-btn-reject'\)\[0\];/, 'reject 事件绑定选择器不得改名');
});

test('gourd-ai-tauri/ui 发布副本与 static 源保持同步', () => {
    // 仓库根：__dirname = gourd-ai-agent/src/test/js → 向上四级
    const mirrorRoot = path.resolve(__dirname, '../../../../gourd-ai-tauri/ui');
    if (!fs.existsSync(mirrorRoot)) return; // CI 干净检出时镜像不存在（被 .gitignore）
    const src = readStatic('css', 'app.css');
    const mirror = fs.readFileSync(path.join(mirrorRoot, 'css', 'app.css'), 'utf8').replace(/^\uFEFF/, '');
    assert.equal(mirror, src, 'gourd-ai-tauri/ui 副本已与 static 源不同步，请同步后再提交: css/app.css');
});
