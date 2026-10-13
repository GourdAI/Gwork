/**
 * 契约测试：深色模式令牌合规 + WCAG 对比度门禁（远程工作区向导/徽标/菜单）。
 *
 * 背景（用户反馈「深色模式下，显示存在问题」的实测根因，两类独立缺陷）：
 *  1) 【静默串色】远程区块遍地写 `var(--token, #浅色字面量)`，其中 --overlay / --bg-panel /
 *     --danger 三个 token 在 theme.css **从未定义** → 第二个参数恒生效。那是浅色值，
 *     深色主题下面板底色算出 rgb(255,255,255)、菜单同理，实测文字对比度 **1.27:1**
 *     （近白字压在近白底上 = 内容隐形），且不报错、不告警。
 *  2) 【accent 上写死白字】.remote-connect-btn / .remote-auth-tab.active /
 *     .remote-channel-tab.active 三处 `color: #fff`。默认 accent 为石墨系，
 *     深色主题 --accent = 近白 #e4e4e7，白字压在近白底上实测 **1.27:1**。
 *     全站其余 44 处主操作（.send-btn / .kd-btn-ok / .hitl-btn-approve …）早已走
 *     --accent-contrast（深色下是深字 #18181b = 13.96:1），远程区块是唯一的漏网分支。
 *
 * 覆盖：
 * - 远程区块（app.css「远程工作区」节起）内不得出现任何颜色字面量（治理约定第 1 条）
 * - 该区块引用的每个 token 必须在 theme.css 明暗两套主题都成套定义
 * - accent 实心底的文字必须 --accent-contrast，禁止 #fff / white
 * - --overlay 明暗成对且**取值不同**（同值 = 深色下遮罩与近黑底色不分离，等于没盖住）
 * - 【对比度门禁】12 个文字/底色组合 × 5 accent × 2 主题，一律从 CSS 源码正则派生
 *   （不硬编码「我以为写了什么」），暗色主题零例外 ≥ 4.5
 * - light/indigo 的既有色板偏差显式登记（同 hitl-btn-accent 口径），修好预设应清空
 * - 【第四族】文本口径 hover 前景必须随底色成套（四处 hover 接线 + 明暗派生对比度 ≥ 4.5）
 * - 反向自检：门禁必须真的在算，样本数与登记表面板不符即判失败
 * - gourd-ai-tauri/ui 发布副本与 static 源同步
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const appCssRaw = readStatic('css', 'app.css');
const themeCss = readStatic('css', 'theme.css');

const SECTION_MARK = '/* ============ 远程工作区';
const sectionStart = appCssRaw.indexOf(SECTION_MARK);
assert.ok(sectionStart >= 0, 'app.css 缺少「远程工作区」分节标记，本测试的作用域前提已变');
const remoteCss = appCssRaw.slice(sectionStart);

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const remoteSrc = stripComments(remoteCss);

/** 解析「选择器 → 声明 map」，只吃远程区块 */
function parseRules(src) {
    const out = new Map();
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(src))) {
        const sel = m[1].replace(/\s+/g, ' ').trim();
        const decls = {};
        m[2].split(';').forEach((part) => {
            const i = part.indexOf(':');
            if (i < 0) return;
            const k = part.slice(0, i).trim().toLowerCase();
            if (k) decls[k] = part.slice(i + 1).trim();
        });
        out.set(sel, decls);
    }
    return out;
}
const RULES = parseRules(remoteSrc);
function rule(sel) {
    const r = RULES.get(sel);
    assert.ok(r, '未找到远程区块样式规则: ' + sel);
    return r;
}

test('远程区块内不得出现任何颜色字面量（色彩治理约定第 1 条）', () => {
    // 只检查**声明值**，不检查属性名：white-space / text-overflow 里的 white 不是颜色。
    // 允许 color-mix() 的百分数与非颜色关键字，禁 #hex / rgb() / rgba() / hsl()。
    const offenders = [];
    for (const [sel, decls] of RULES) {
        for (const [prop, val] of Object.entries(decls)) {
            if (/#([0-9a-f]{3,8})\b/i.test(val) || /\brgba?\(/i.test(val) || /\bhsla?\(/i.test(val)) {
                offenders.push(sel + ' { ' + prop + ': ' + val + ' }');
            }
        }
    }
    assert.deepEqual(offenders, [], '远程区块必须全部引用令牌，颜色字面量只允许在 theme.css:\n  ' + offenders.join('\n  '));
});

test('远程区块禁止 var(--token, 兜底) 写法（兜底恒生效 = 静默串色的根因）', () => {
    /* 为什么连「token 存在时的冗余兜底」也禁：兜底值一律是浅色字面量，
       一旦某主题忘了赋值就当场掉回浅色，而这类「只坏一个主题」的缺陷
       正是本次事故形态。令牌成套性由下一条测试守，兜底在这里只有坏处。 */
    const withFallback = [];
    for (const [sel, decls] of RULES) {
        for (const [prop, val] of Object.entries(decls)) {
            if (/var\(\s*--[\w-]+\s*,/.test(val)) withFallback.push(sel + ' { ' + prop + ': ' + val + ' }');
        }
    }
    assert.deepEqual(withFallback, [], '禁止给令牌写兜底值:\n  ' + withFallback.join('\n  '));
});

test('远程区块引用的每个令牌必须在 theme.css 明暗两套主题都成套定义', () => {
    const used = new Set();
    for (const decls of RULES.values()) {
        for (const val of Object.values(decls)) {
            for (const m of String(val).matchAll(/var\(\s*(--[\w-]+)/g)) used.add(m[1]);
        }
    }
    assert.ok(used.size >= 10, '远程区块应引用成组主题令牌，实际仅: ' + [...used].join(','));
    const themes = {};
    ['light', 'dark'].forEach((th) => {
        const m = themeCss.match(new RegExp('\\[data-theme="' + th + '"\\]\\s*\\{([\\s\\S]*?)\\n\\}'));
        assert.ok(m, 'theme.css 缺少 ' + th + ' 主题块');
        themes[th] = stripComments(m[1]);
    });
    const missing = [];
    [...used].sort().forEach((t) => {
        const re = new RegExp(t.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\s*:');
        if (!re.test(themes.light)) missing.push(t + ' @light');
        if (!re.test(themes.dark)) missing.push(t + ' @dark');
    });
    assert.deepEqual(missing, [], '令牌缺少主题赋值（该主题下 var() 解析失败 → 掉初始值）:\n  ' + missing.join('\n  '));
});

test('accent 实心底的文字必须走 --accent-contrast，禁止写死白字', () => {
    const SOLID = ['.remote-connect-btn', '.remote-auth-tab.active', '.remote-channel-tab.active'];
    SOLID.forEach((sel) => {
        const r = rule(sel);
        assert.match(String(r['background']), /^var\(--accent\)$/, sel + ' 底色必须是 --accent（跟随用户强调色预设）');
        assert.equal(r['color'], 'var(--accent-contrast)', sel + ' 文字必须用 --accent-contrast；写死 #fff 在暗色主题（accent=近白）下实测 1.27:1 = 文字隐形');
    });
});

test('.remote-connect-btn:hover 改底色而非 filter（filter 不作用于文字，暗色下会整体发灰）', () => {
    const h = rule('.remote-connect-btn:hover');
    assert.equal(h['background'], 'var(--accent-hover)', '悬停必须切到 accent-hover，与全站主按钮同一手法');
});

test('--overlay 遮罩令牌明暗成对且取值不同', () => {
    /* 同值即失效：暗色页面底色本身已近黑（#131315 / #17171a），
       沿用明度的浅遮罩等于什么都没盖住，浮层与背景不分离。 */
    const val = (th) => {
        const m = themeCss.match(new RegExp('\\[data-theme="' + th + '"\\]\\s*\\{([\\s\\S]*?)\\n\\}'));
        const d = m[1].match(/--overlay\s*:\s*([^;]+);/);
        assert.ok(d, th + ' 主题缺少 --overlay');
        return d[1].trim();
    };
    const L = val('light'), D = val('dark');
    const alpha = (s) => { const m = s.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)/); assert.ok(m, '非 rgba 遮罩写法: ' + s); return parseFloat(m[1]); };
    assert.ok(alpha(D) > alpha(L), '--overlay 暗色必须比明色更深（明 ' + alpha(L) + ' / 暗 ' + alpha(D) + '）');
    assert.match(rule('.remote-wizard-backdrop')['background'], /^var\(--overlay\)$/, '向导遮罩必须引用 --overlay 令牌');
});

/* ===================== 对比度门禁（解析真源，不依赖浏览器） ===================== */

function cssBlocks(css) {
    const src = stripComments(css), out = [], re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(src))) out.push({ sel: m[1].replace(/\s+/g, ' ').trim(), body: m[2] });
    return out;
}
const themeBlocks = cssBlocks(themeCss);
/** 某主题作用域的 token 表：基础 [data-theme=X] 先入，带 [data-accent=Y] 的预设块后入 = 覆盖 */
function tokensFor(themeName, accentName) {
    const vars = {};
    const absorb = (b) => b.body.split(';').forEach((part) => {
        const i = part.indexOf(':');
        if (i < 0) return;
        const k = part.slice(0, i).trim();
        if (k.startsWith('--')) vars[k] = part.slice(i + 1).trim();
    });
    const hitsFor = (needAccent) => themeBlocks.filter((b) => b.sel.split(',').map((s) => s.trim()).some((s) =>
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
        if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
        const v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
        return { r: v[0], g: v[1], b: v[2], a: h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
        const p = m[1].split(/[,\s/]+/).filter(Boolean);
        const to255 = (x) => (x.endsWith('%') ? parseFloat(x) * 255 / 100 : parseFloat(x));
        return { r: to255(p[0]), g: to255(p[1]), b: to255(p[2]), a: p[3] === undefined ? 1 : (p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3])) };
    }
    if (/^transparent$/i.test(s)) return { r: 0, g: 0, b: 0, a: 0 };
    return null;
}
const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lumOf = (col) => 0.2126 * lin(col.r) + 0.7152 * lin(col.g) + 0.0722 * lin(col.b);
const blend = (fg, bg) => (fg.a >= 1
    ? { r: fg.r, g: fg.g, b: fg.b, a: 1 }
    : { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
function contrastRatio(fgStr, bgStr, hostStr) {
    const fg = parseColor(fgStr);
    let bg = parseColor(bgStr);
    const host = parseColor(hostStr) || { r: 255, g: 255, b: 255, a: 1 };
    if (!fg) return { ratio: null, note: 'fg 无法解析: ' + fgStr };
    if (!bg || bg.a < 1) bg = bg ? blend(bg, host) : host;
    const eff = blend(fg, bg);
    const l1 = lumOf(eff), l2 = lumOf(bg);
    return { ratio: Math.round((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) * 100) / 100 };
}

/* 文字/底色配对：一律从 CSS 源码派生。host 项是该规则未自铺底色时的实际祖先底色。 */
const CASES = [
    // [名称, 取文字色的规则, 取底色的规则（同规则即自铺底）, 无底色时的宿主 token]
    ['panelTitle',      '.remote-wizard-panel',      '.remote-wizard-panel',      null,                '--text-primary'],
    ['badge',           '.remote-badge',             '.remote-badge',             null],
    ['channelActive',   '.remote-channel-tab.active','.remote-channel-tab.active', null],
    ['authActive',      '.remote-auth-tab.active',   '.remote-auth-tab.active',   null],
    ['connectBtn',      '.remote-connect-btn',       '.remote-connect-btn',       null],
    ['connectLog',      '.remote-connect-log',       '.remote-connect-log',       null],
    ['channelIdle',     '.remote-channel-tab',       '.remote-channel-switch',    '.remote-wizard-panel'],
    ['hostMeta',        '.remote-host-meta',         '.remote-wizard-panel',      null],
    ['sectionLabel',    '.remote-section-label',     '.remote-wizard-panel',      null],
    ['jumpToggle',      '.remote-jump-toggle',       '.remote-wizard-panel',      null],
    ['menuItem',        '.remote-menu-item',         '.remote-menu',              null],
    ['menuDanger',      '.remote-menu-item.remote-menu-danger', '.remote-menu',   null],
    ['inputText',       '.remote-wizard-body .remote-select-wrap .layui-input', '.remote-wizard-body .remote-select-wrap .layui-input', null],
];

const THEMES = ['light', 'dark'];
const ACCENTS = ['graphite', 'teal', 'clay', 'sky', 'indigo'];
const AA_NORMAL = 4.5;   // 11–13px 属 WCAG「普通文本」口径

/* 【既有基线偏差登记 · 仅 light/indigo】indigo 是旧版默认色（蓝紫），其 accent 色板
   自身在浅底上就不到 4.5 —— 与本次修复无关，全站同 token 同范式组件（.sidebar-item.active、
   .kd-btn-ok、hitl approve 按钮，见 hitl-btn-accent.test.js 同名登记）同值同红。
   记账而非静默放宽阈值：暗色主题（用户投诉现场）一律零例外；修好预设应清空本表。 */
const KNOWN_BASELINE = {
    'light/indigo/channelActive': 4.28,
    'light/indigo/authActive': 4.28,
    'light/indigo/connectBtn': 4.28,
    'light/indigo/jumpToggle': 4.28,
};

test('对比度门禁：13 组合 × 5 accent × 2 主题，暗色零例外 ≥ AA 4.5', () => {
    const failures = [];
    const samples = [];
    THEMES.forEach((t) => ACCENTS.forEach((ac) => {
        const vars = tokensFor(t, ac);
        CASES.forEach(([name, fgSel, bgSel, panelSel, fgTokenFallback]) => {
            const fgDecl = fgTokenFallback ? ('var(' + fgTokenFallback + ')') : rule(fgSel)['color'];
            assert.ok(fgDecl || fgTokenFallback, name + ' 无法确定文字色');
            let bgDecl = rule(bgSel)['background'] || rule(bgSel)['background-color'];
            if (!bgDecl && panelSel) bgDecl = rule(panelSel)['background'];
            const host = resolve(vars['--bg-card'], vars);
            const c = contrastRatio(
                resolve(fgDecl, vars),
                resolve(bgDecl || 'transparent', vars),
                host
            );
            const key = t + '/' + ac + '/' + name;
            samples.push(key + '=' + (c.ratio === null ? c.note : c.ratio));
            if (c.ratio === null) { failures.push(key + ' 无法解析（token 缺失？）: ' + c.note); return; }
            if (c.ratio >= AA_NORMAL) return;
            if (KNOWN_BASELINE[key] !== undefined && Math.abs(c.ratio - KNOWN_BASELINE[key]) < 0.02) return;
            failures.push(key + ' = ' + c.ratio + '（阈值 ' + AA_NORMAL + '）');
        });
    }));
    assert.equal(failures.length, 0, '对比度不达标:\n  ' + failures.join('\n  '));
    // 反向自检：门禁必须真的在算，而不是恒绿摆设
    const registered = Object.keys(KNOWN_BASELINE).length;
    const below = samples.filter((s) => { const v = parseFloat(s.split('=')[1]); return isFinite(v) && v < AA_NORMAL; });
    assert.equal(below.length, registered,
        '实算低于阈值的样本数(' + below.length + ') 与登记表(' + registered + ')不符，门禁或登记表已失效: ' + below.join(','));
    assert.ok(samples.length === THEMES.length * ACCENTS.length * CASES.length,
        '样本总数异常（应为 ' + THEMES.length * ACCENTS.length * CASES.length + '，实际 ' + samples.length + '）—— CASES 与门禁未同步');
});

test('暗色主题下 accent 派生底色必须成套抬升（--accent-light 不能沿用浅色值）', () => {
    /* .remote-badge 2026-10-11 起改素底胶囊（--bg-hover + --border-color），不再用
       --accent-light——但「暗色 --accent-light 必须单独赋值」的约定本身仍要守：
       .sidebar-item.active / .model-dropdown-item.active 等同范式组件还在用它。 */
    const pick = (th) => {
        const m = themeCss.match(new RegExp('\\[data-theme="' + th + '"\\]\\s*\\{([\\s\\S]*?)\\n\\}'));
        return m[1].match(/--accent-light\s*:\s*([^;]+);/)[1].trim();
    };
    const L = pick('light'), D = pick('dark');
    assert.notEqual(L, D, '--accent-light 明暗必须各异（暗色复用浅色值 = active 态底色发白）');
    assert.match(rule('.remote-badge')['background'], /^var\(--bg-card\)$/,
        '.remote-badge 底色应走 --bg-card（2026-10-11 素底化：徽标是 chrome 不是 active 态，accent 底太抢眼）');
    assert.match(rule('.remote-badge')['color'], /^var\(--text-secondary\)$/,
        '.remote-badge 文字应走 --text-secondary（新形态：次要文本权重）');
    /* rule() 解析的是简写 border（非 border-color 键）：写 border 简写才能被解析到 */
    assert.match(rule('.remote-badge')['border'], /var\(--border-color\)$/,
        '.remote-badge 必须带描边（素底需边界与背景分离）');
});

test('危险动作文字统一走 --error-text，不用 --color-danger', () => {
    /* 实测：--color-danger 浅色主题 = #ef4444，落在卡片底上仅 3.76:1；
       --error-text（#dc2626 / #f87171）与全站错误文字同口径，明暗均 ≥ 4.5。 */
    ['.remote-host-remove:hover', '.remote-menu-item.remote-menu-danger'].forEach((sel) => {
        assert.equal(rule(sel)['color'], 'var(--error-text)', sel + ' 危险文字必须用 --error-text');
    });
});

test('输入控件底色走 --bg-input-box 而非 --bg-main（浮层内需要再抬一层）', () => {
    ['.remote-form-row input:not([type="checkbox"])', '.remote-wizard-body .remote-select-wrap .layui-input'].forEach((sel) => {
        const r = rule(sel);
        assert.equal(r['background'], 'var(--bg-input-box)', sel + ' 底色必须是 --bg-input-box');
        assert.equal(r['border'].includes('var(--border-input)'), true, sel + ' 描边应取 --border-input（输入框专用，比 --border-color 更可见）');
    });
});

test('WSL 发行版下拉必须走 layui select 范式（禁退回原生 select 系统面板）', () => {
    /* 用户实测反馈原生 <select> 展开是系统灰底菜单、「好丑」；定时任务「推送通道」
       已立 layui 范式（.layui-form 包层 + lay-filter + form.render('select')）。
       护栏三层：JS 结构（包层/lay-filter/托管函数/禁旧 class）、CSS 口径（盒高对齐输入框）、
       事件回调只绑一次（重复 bind 会叠加）。 */
    const js = readStatic('js', 'app-remote.js');
    assert.match(js, /layui-form remote-select-wrap/, '下拉必须用 .layui-form 包层 + .remote-select-wrap');
    assert.match(js, /lay-filter="remoteDistroForm"/, '包层必须带 lay-filter 供 form.render 定向刷新');
    assert.match(js, /<select id="remoteDistro" lay-filter="remoteDistro">/, '原生 select 必须带 lay-filter 供 form.on 订阅');
    assert.ok(!js.includes('class="remote-select"'), '禁退回原生 .remote-select（系统绘制面板）');
    assert.match(js, /function renderDistroSelect\(\)/, '必须有统一的 render 托管函数');
    assert.match(js, /layui\.form\.render\('select', 'remoteDistroForm'\)/, 'render 必须定向到本包层 filter');
    assert.match(js, /layui\.form\.on\('select\(remoteDistro\)'/, '选中事件必须经 layui form.on 回写镜像');
    assert.match(js, /bindDistroSelectOnce\.bound/, 'form.on 必须有只绑一次闸门（面板 DOM 重建但回调全局注册，重复 bind 会叠加）');
    const css = rule('.remote-wizard-body .remote-select-wrap .layui-input');
    assert.equal(css['height'], '34px', '盒高必须对齐远程向导输入框口径');
    assert.equal(css['font-size'], '13px', '字号必须对齐远程向导输入框口径');
    /* 特异性前缀护栏：index.html 里 app.css 先于 settings.css 加载，同特异性（0,2,0）
       会被全局 .layui-form .layui-input 覆盖（浏览器实测抓到盒高 38px 而非 34px）；
       源码派生门禁看不到加载序覆盖，只能在这里锁选择器形态。 */
    assert.match(remoteSrc, /\.remote-wizard-body \.remote-select-wrap \.layui-input \{/, '盒样式必须带 .remote-wizard-body 前缀抬特异性（防被 settings.css 全局同特异性覆盖）');
    assert.match(remoteSrc, /\.remote-wizard-body \.remote-select-wrap \.layui-edge \{/, '箭头垂直居中同样需要特异性前缀');
});

/* ===================== 第二族：全站 on-solid 前景（用户拍板全修） =====================
   背景：白字压在高饱和功能色/品牌色上，浅色主题本就不达标（实测 2.28–4.28），
   暗色主题功能色提亮后白字崩到 1.74–2.97。修复 = theme.css 成套 on-* 前景令牌 +
   13 处接线。以下三条把「全站任何地方」都纳入护栏，不再只盯远程区块。 */

const CSS_FILES = ['css/app.css', 'css/settings.css', 'css/model-settings.css', 'css/code.css', 'css/automation.css', 'css/channel.css', 'css/memory-view.css', 'css/usage-stats.css', 'css/skills.css'];
const FUNC_BG = /var\(--accent\)|var\(--color-(?:danger|success|feishu|dingtalk|wechat|warning)|var\(--brand-/;
const WHITE_TEXT = /(^|[^-\w])(#fff\b|#FFF\b|#ffffff\b|#FFFFFF\b|white\b)/;

test('全站：accent/功能色/品牌色实心底不得写死白字', () => {
    const offenders = [];
    CSS_FILES.forEach((rel) => {
        const src = stripComments(readStatic(...rel.split('/')));
        for (const [sel, decls] of parseRules(src)) {
            const bg = decls['background'] || decls['background-color'] || '';
            const col = decls['color'] || '';
            if (FUNC_BG.test(bg) && WHITE_TEXT.test(col)) offenders.push(rel + '  ' + sel);
        }
    });
    assert.deepEqual(offenders, [], '功能色实底必须用成套 on-* 前景令牌（白字在暗色提亮后的底色上实测 1.74–2.97）:\n  ' + offenders.join('\n  '));
});

test('on-* 前景令牌明暗成套定义，且与底色对比度 ≥ AA 4.5', () => {
    const PAIRS = [
        ['--color-danger', '--on-danger'],
        ['--color-danger-hover', '--on-danger-hover'],
        ['--color-success', '--on-success'],
        ['--color-feishu', '--on-feishu'],
        ['--color-feishu-hover', '--on-feishu-hover'],
        ['--color-dingtalk', '--on-dingtalk'],
        ['--color-dingtalk-hover', '--on-dingtalk-hover'],
        ['--color-warning', '--on-warning'],
        ['--brand-wechat', '--on-wechat'],
        ['--brand-feishu', '--on-feishu-icon'],
        ['--brand-dingtalk', '--on-dingtalk-icon'],
    ];
    const failures = [];
    THEMES.forEach((t) => {
        const vars = tokensFor(t, 'graphite');
        PAIRS.forEach(([bgTok, fgTok]) => {
            const bgRaw = vars[bgTok], fgRaw = vars[fgTok];
            if (bgRaw === undefined || fgRaw === undefined) { failures.push(t + ' 缺令牌 ' + (bgRaw === undefined ? bgTok : fgTok)); return; }
            const c = contrastRatio(fgRaw, bgRaw, '#ffffff');
            if (c.ratio === null) { failures.push(t + ' ' + fgTok + ' on ' + bgTok + ' 无法解析'); return; }
            if (c.ratio < AA_NORMAL) failures.push(t + ' ' + fgTok + ' on ' + bgTok + ' = ' + c.ratio);
        });
    });
    assert.deepEqual(failures, [], 'on-solid 前景对比度不达标:\n  ' + failures.join('\n  '));
});

test('on-* 与 brand-* 令牌在两套主题均定义（品牌色值明暗同值，但必须显式声明）', () => {
    const toks = ['--on-danger', '--on-danger-hover', '--on-success', '--on-feishu', '--on-feishu-hover', '--on-dingtalk', '--on-dingtalk-hover', '--on-warning', '--on-wechat', '--on-feishu-icon', '--on-dingtalk-icon', '--brand-wechat', '--brand-feishu', '--brand-dingtalk'];
    const themes = {};
    ['light', 'dark'].forEach((th) => {
        const m = themeCss.match(new RegExp('\\[data-theme="' + th + '"\\]\\s*\\{([\\s\\S]*?)\\n\\}'));
        themes[th] = stripComments(m[1]);
    });
    const missing = [];
    toks.forEach((t) => {
        const re = new RegExp(t.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\s*:');
        if (!re.test(themes.light)) missing.push(t + ' @light');
        if (!re.test(themes.dark)) missing.push(t + ' @dark');
    });
    assert.deepEqual(missing, [], 'on-*/brand-* 令牌缺主题赋值:\n  ' + missing.join('\n  '));
});

test('品牌色 hex 字面量只允许出现在 theme.css（治理约定第 1 条的全站延伸）', () => {
    /* 背景：品牌色原先硬编码在 app.css 的 .channel-card-icon.* 里（#07c160/#3370ff/#0089ff），
       本次已令牌化为 --brand-*。若只守远程区块的字面量禁令，别处再写品牌色 hex 无人管
       （变异 M16 实测 SURVIVED 暴露此缺口）。品牌色是「主题不变」的识别色，
       但它的**唯一定义处**仍必须是 theme.css。 */
    const BRAND_HEX = /#07c160\b|#3370ff\b|#0089ff\b/i;
    const offenders = [];
    CSS_FILES.forEach((rel) => {
        const src = stripComments(readStatic(...rel.split('/')));
        src.split(/\r?\n/).forEach((ln, i) => { if (BRAND_HEX.test(ln)) offenders.push(rel + ':' + (i + 1) + ' ' + ln.trim().slice(0, 90)); });
    });
    assert.deepEqual(offenders, [], '品牌色 hex 必须只定义在 theme.css（--brand-*），其余文件引用令牌:\n  ' + offenders.join('\n  '));
});

test('gourd-ai-tauri/ui 发布副本与 static 源保持同步', () => {
    const mirrorRoot = path.resolve(__dirname, '../../../../gourd-ai-tauri/ui');
    if (!fs.existsSync(mirrorRoot)) return; // CI 干净检出时镜像不存在（被 .gitignore）
    ['css/app.css', 'css/theme.css'].forEach((rel) => {
        const src = readStatic(...rel.split('/'));
        const mirror = fs.readFileSync(path.join(mirrorRoot, ...rel.split('/')), 'utf8').replace(/^\uFEFF/, '');
        /* 失败消息只报「首个差异位置 + 行号」：这两个文件 16 万+ 字符，
           直接把全文塞进 assert 会把测试输出刷屏（实际事故：一次失败输出 32 万字符）。 */
        if (mirror === src) return;
        let at = 0;
        const n = Math.min(mirror.length, src.length);
        while (at < n && mirror[at] === src[at]) at++;
        const line = src.slice(0, at).split('\n').length;
        assert.fail('gourd-ai-tauri/ui 副本已与 static 源不同步，跑 prepare-ui 后再提交: ' + rel + '（首个差异在第 ' + line + ' 行，偏移 ' + at + '）');
    });
});

/* ===================== 第三族：实心危险钮图形口径（用户实测黑点回归） =====================
   背景：第二族把全站 on-* 深色前景统一接线到实心底时，把【纯图形】按钮也一并接入文本口径：
   停止按钮中心 12×12 方块（无任何文字）从 #fff 改成 --on-danger #200404 →
   用户看到「红色停止钮中心黑点」。图形对象走 WCAG 1.4.11 门槛 3:1，红底白图形 3.76 达标。
   修复：新增 danger-solid 图形口径令牌组（明暗同值不提亮：提亮档上白图形仅 2.77 不达标），
   停止/录音两处纯图形钮接线；文本类（断网条/审批按钮/附件删除钮）继续用 on-* 文本口径。 */

test('实心危险钮图形口径：stop/recording 必须接 danger-solid 令牌，禁止回退文本口径 on-danger', () => {
    const appCssAll = stripComments(appCssRaw);
    const blocks = cssBlocks(appCssAll);
    const decls = (sel) => {
        const b = blocks.find((x) => x.sel === sel);
        assert.ok(b, 'app.css 缺规则: ' + sel);
        const d = {};
        b.body.split(';').forEach((part) => {
            const i = part.indexOf(':');
            if (i < 0) return;
            d[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
        });
        return d;
    };
    // 停止钮：红底 + 白方块（图标为 background: currentColor，颜色由 color 驱动）
    const stop = decls('.send-btn.stop-mode');
    assert.match(String(stop['background']), /^var\(--color-danger-solid\)$/, '停止钮底色必须用 --color-danger-solid（图形口径，明暗同值不提亮）');
    assert.equal(stop['color'], 'var(--on-danger-icon)', '停止钮方块色必须用 --on-danger-icon（白色）；接 --on-danger 会变成黑点（用户实测）');
    const stopHover = decls('.send-btn.stop-mode:hover');
    assert.match(String(stopHover['background']), /^var\(--color-danger-solid-hover\)$/, '停止钮 hover 底色必须用 --color-danger-solid-hover');
    // 录音钮：纯麦克风 svg（fill: currentColor），同样不得接文本口径深色前景
    const rec = decls('.voice-btn.recording');
    assert.match(String(rec['background']), /^var\(--color-danger-solid\)$/, '录音钮底色必须用 --color-danger-solid');
    assert.equal(rec['color'], 'var(--on-danger-icon)', '录音钮麦克风图标色必须用 --on-danger-icon；接 --on-danger 会变成黑麦克风');
    const recHover = decls('.voice-btn.recording:hover');
    assert.match(String(recHover['background']), /^var\(--color-danger-solid-hover\)$/, '录音钮 hover 底色必须用 --color-danger-solid-hover');
    assert.equal(recHover['color'], 'var(--on-danger-icon)', '录音钮 hover 图标色保持 --on-danger-icon（不得回落 on-danger-hover）');
    // 停止方块仍以 currentColor 绘制（颜色由规则 color 驱动，改画法需同步本测试）
    const stopIcon = decls('.send-btn.stop-mode .stop-icon');
    assert.match(String(stopIcon['background']), /currentColor/, '停止方块以 currentColor 绘制，改画法需同步本测试');
});

test('图形口径令牌组成对定义且白图形 ≥ 3:1（WCAG 1.4.11）', () => {
    const toks = ['--color-danger-solid', '--color-danger-solid-hover', '--on-danger-icon'];
    const missing = [];
    THEMES.forEach((t) => {
        const vars = tokensFor(t, 'graphite');
        toks.forEach((tk) => { if (vars[tk] === undefined) missing.push(t + ' 缺 ' + tk); });
    });
    assert.deepEqual(missing, [], '\u56fe\u5f62\u53e3\u5f84\u4ee4\u724c\u7ec4\u660e\u6697\u5747\u987b\u5b9a\u4e49:\n  ' + missing.join('\n  '));
    const pairs = [
        ['light --on-danger-icon on --color-danger-solid'],
        ['light --on-danger-icon on --color-danger-solid-hover'],
        ['dark --on-danger-icon on --color-danger-solid'],
        ['dark --on-danger-icon on --color-danger-solid-hover'],
    ];
    const failures = [];
    pairs.forEach(([label]) => {
        const th = label.split(' ')[0];
        const vars = tokensFor(th, 'graphite');
        const fg = vars['--on-danger-icon'], bg = vars['--color-danger-solid' + (label.includes('hover') ? '-hover' : '')];
        const c = contrastRatio(fg, bg, '#ffffff');
        if (c.ratio === null) { failures.push(label + ' 无法解析'); return; }
        if (c.ratio < 3) failures.push(label + ' = ' + c.ratio + '（低于图形门槛 3:1）');
    });
    assert.deepEqual(failures, [], '\u767d\u56fe\u5f62\u5728\u5b9e\u5fc3\u7ea2\u5e95\u4e0a\u987b ≥ 3:1:\n  ' + failures.join('\n  '));
    // 暗色底不得提亮：提亮档 #f87171 上白图形仅 2.77，不达图形门槛
    const darkSolid = tokensFor('dark', 'graphite')['--color-danger-solid'];
    const lightSolid = tokensFor('light', 'graphite')['--color-danger-solid'];
    assert.equal(darkSolid, lightSolid, 'danger-solid 明暗同值（实心块对暗背景 4.71 已醒目，提亮是给暗底红文字用的，会让白图形跌破门槛）');
    assert.equal(darkSolid, '#ef4444', 'danger-solid 必须是未提亮档 #ef4444（白图形 3.76 达标）；换值需同步重算门槛');
});

test('文本口径接线不得被图形口径反向污染：断网条/审批/附件删除钮保持 on-* 深色前景', () => {
    /* 与上一条互为反向护栏：用户拍板「附件暂时别动」，且断网条/审批按钮是【文字】场景，
       AA 4.5 深色前景是正确口径，禁止有人顺手把这套也换成白色图标/文字。 */
    const appCssAll = stripComments(appCssRaw);
    const blocks = cssBlocks(appCssAll);
    const decls = (sel) => {
        const b = blocks.find((x) => x.sel === sel);
        assert.ok(b, 'app.css 缺规则: ' + sel);
        const d = {};
        b.body.split(';').forEach((part) => {
            const i = part.indexOf(':');
            if (i < 0) return;
            d[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
        });
        return d;
    };
    const net = decls('.network-bar.disconnected');
    assert.equal(net['color'], 'var(--on-danger)', '断网条是文字场景，保持文本口径 --on-danger');
    const attach = decls('.attachment-item-remove');
    assert.equal(attach['color'], 'var(--on-danger)', '附件删除钮（用户拍板暂不动）：×符号为字体字形，保持文本口径 --on-danger');
    const hitl = decls('.hitl-btn-reject:hover');
    assert.match(String(hitl['border-color'] || '') + ' ' + String(hitl['color'] || ''), /--color-danger/, '审批拒绝钮 hover 态保持红描边/红字口径（基础态为中性描边，见 L673）');
});

/* ===================== 第四族：文本口径 hover 前景必须随底色成套（浅色 hover 回归） =====================
   背景：on-* 深色前景全站接线时，hover 规则只改底色（沿用 HEAD 形态）、前景留在基础态深色：
   浅色 hover 底是更深档（#dc2626/#2960e6/#0070dd），基础态深色前景压其上实测 3.75–4.02，
   低于 AA 4.5（HEAD 白字 4.81–5.37 本是达标的）——改造引入的隐性回归。
   修复：--on-danger-hover 本就存在只是没接线，补 --on-feishu-hover/--on-dingtalk-hover 令牌，
   四处 hover 接成套前景。暗色相反：hover 底是提亮档，深色前景达标、白字反而崩。 */

test('文本口径 hover：四处 hover 规则必须接成套 hover 前景令牌，且明暗双主题对比度 ≥ AA', () => {
    const appCssAll = stripComments(appCssRaw);
    const blocks = cssBlocks(appCssAll);
    const decls = (sel) => {
        const b = blocks.find((x) => x.sel === sel);
        assert.ok(b, 'app.css 缺规则: ' + sel);
        const d = {};
        b.body.split(';').forEach((part) => {
            const i = part.indexOf(':');
            if (i < 0) return;
            d[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
        });
        return d;
    };
    const WIRING = [
        ['.im-bind-confirm-btn.feishu:hover', '--color-feishu-hover', '--on-feishu-hover'],
        ['.im-bind-confirm-btn.dingtalk:hover', '--color-dingtalk-hover', '--on-dingtalk-hover'],
        ['.attachment-item-remove:hover', '--color-danger-hover', '--on-danger-hover'],
        ['.access-confirm-btns .access-allow-btn:hover', '--color-danger-hover', '--on-danger-hover'],
    ];
    const failures = [];
    WIRING.forEach(([sel, bgTok, fgTok]) => {
        const d = decls(sel);
        const bg = String(d['background'] || '');
        const fg = String(d['color'] || '');
        if (bg !== 'var(' + bgTok + ')') failures.push(sel + ' background=' + bg + '（预期 var(' + bgTok + ')）');
        if (fg !== 'var(' + fgTok + ')') failures.push(sel + ' color=' + (fg || '(缺失)') + '（预期 var(' + fgTok + ')）；hover 不接前景则基础态深色前景压在更深 hover 底上低于 AA');
        // 对比度门禁：把这条接线在明暗两主题解析成真实色值核算（从源码派生，不硬编码）
        THEMES.forEach((th) => {
            const vars = tokensFor(th, 'graphite');
            const c = contrastRatio(vars[fgTok], vars[bgTok], '#ffffff');
            if (c.ratio === null) { failures.push(th + ' ' + sel + ' 无法解析'); return; }
            if (c.ratio < AA_NORMAL) failures.push(th + ' ' + sel + ' = ' + c.ratio + '（< ' + AA_NORMAL + '）');
        });
    });
    assert.deepEqual(failures, [], '文本口径 hover 前景未随底色成套 / 对比度不达标:\n  ' + failures.join('\n  '));
});
