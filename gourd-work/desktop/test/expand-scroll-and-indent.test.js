/**
 * 护栏：内部滚动不外溢 + 展开内容层级缩进 + 自绘滚动条与全站同源（2026-11-25 用户报障）。
 *
 * ── 用户原话（三个问题）────────────────────────────────────────────────────
 * ① 「内部滚动的时候，会出现外部滚动条，正常外部滚动条只有整体超出才会展示的，
 *    不应该是内部元素滚动，外部出现滚动条，排查下是不是容器有问题」
 * ② 「工具、思考等展开阴影有问题……要按照 Qoder 那样能很明显的看出层级的样式展示，
 *    现在这展开的阴影都把前面线条都遮挡了，缩进都超出对应标题栏了」
 * ③ 「内部的滚动条，是不是没用统一的滚动条，怎么看的和别的不一样，
 *    上下端我记得是有弧度圆角的」
 *
 * ── 真实浏览器实证（Chromium + CDP Input.dispatchMouseEvent(mouseWheel)）────
 * 探针页加载真 theme.css/app.css/app-turn-display.js，思考卡体 scrollHeight 1125 /
 * clientHeight 300（内部可滚 825px），外层 .messages-wrap 可滚 1483px。
 * 指针停在卡体中心连发 5 次 deltaY=300 的真实滚轮：
 *   · overscroll-behavior: auto（旧）  outer 858→858→858→**1158→1458**（内部到底后整页被推走）
 *   · overscroll-behavior: contain（新）outer 858→858→858→858→858（纹丝不动）
 * 层级几何（相对气泡左缘）：引导线 16 < 卡体盒子 26 < 灰底块文字 40 < 标题头标签 50。
 * 旧口径灰底块盒子左缘 = 0，比引导线还左 16px ⇒ 浅底整条盖住引导线。
 *
 * ── 本测试锁什么 ───────────────────────────────────────────────────────────
 * 全部基于【剥离注释后的 CSS 声明】与【真实源码函数体】，不做「源码含某字符串」式
 * 恒真断言；四份副本逐字同源；并带真变异对照（改磁盘→子进程跑本文件→必须非 0→还原）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UI = path.join(ROOT, 'gourd-work', 'desktop', 'ui');
const COPIES = [
    { name: 'desktop', dir: UI },
    { name: 'java-static', dir: path.join(ROOT, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static') },
    { name: 'java-tauri', dir: path.join(ROOT, 'gourdai-java', 'gourd-ai-tauri', 'ui') },
    { name: 'java-target', dir: path.join(ROOT, 'gourdai-java', 'gourd-ai-agent', 'target', 'classes', 'static') },
];
const SELF = __filename;

function readRaw(f) { return fs.readFileSync(f, 'utf8'); }
function norm(s) { return s.replace(/\r\n/g, '\n'); }
function stripComments(s) { return norm(s).replace(/\/\*[\s\S]*?\*\//g, ''); }

/* 解析出全部「选择器 → 声明串」条目（剥注释后）。
   注意：同一选择器可能在文件里出现多次（如 .thinking-block-body 先有基础规则、
   后有限高补丁），必须【全部收集】再逐条判定，不能 indexOf 取第一个就下结论 ——
   本护栏首版正是踩了这个坑（命中 max-height:180px 的补丁规则，误报 contain 缺失）。 */
function parseRules(css) {
    const clean = stripComments(css);
    const out = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(clean)) !== null) {
        out.push({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
    }
    return out;
}
/* 精确选择器（整条选择器列表里逗号分隔的某一项完全相等）对应的全部规则体 */
function rulesFor(css, exactSelector) {
    return parseRules(css)
        .filter(r => r.selector.split(',').some(s => s.trim() === exactSelector))
        .map(r => r.body);
}
/* 兼容旧调用：取第一条匹配规则体（仅用于唯一规则） */
function ruleBody(css, selectorWithBrace) {
    const sel = selectorWithBrace.replace(/\s*\{$/, '').trim();
    const list = rulesFor(css, sel);
    return list.length ? list[0] : null;
}

/* ===== 一、内部滚动体必须 contain（问题①）===== */
const INNER_SCROLLER_SELECTORS = [
    '.tool-card-body',
    '.thinking-block-body',
    '.agent-card-body',
];

/* ── 口径断言的【唯一实现】──────────────────────────────────────────────────
   主测试与变异子进程共用同一份函数：变异体走 `node -e require(本文件).checkAll(UI)`，
   不经过 test runner（避免 node:test 递归跳过导致护栏空转），断言逻辑零复制。
   任何口径改动只改这里，主测试与变异对照自动同步。 */
function checkAll(dir) {
    const css = readRaw(path.join(dir, 'css', 'app.css'));
    const clean = stripComments(css);
    const js = norm(readRaw(path.join(dir, 'js', 'app-turn-display.js')));

    /* A1/A2 内部滚动体 contain + 仍可滚 */
    for (const sel of INNER_SCROLLER_SELECTORS) {
        const bodies = rulesFor(css, sel);
        assert.ok(bodies.length, sel + '：规则缺失');
        const all = bodies.join('\n');
        assert.match(all, /overscroll-behavior:\s*contain/, sel + '：必须 contain');
        assert.match(all, /max-height:\s*\d+px/, sel + '：限高丢失');
        assert.match(all, /overflow-y:\s*auto/, sel + '：滚动能力丢失');
        for (const b of bodies) {
            assert.doesNotMatch(b, /overscroll-behavior:\s*auto/, sel + '：auto 会外溢到整页');
        }
    }

    /* B1 层级由卡体 margin 承担 */
    assert.match(clean,
        /\.msg-bubble > \.tool-card\[data-turn-batch="1"\]:not\(\.hitl-pending\) > \.tool-card-body[\s\S]{0,600}?\{[^}]*margin-left:\s*26px/,
        '外部成员卡体 margin-left 26px 缺失');
    assert.match(clean,
        /\.agent-card-body > \.tool-card\[data-turn-batch="1"\]:not\(\.hitl-pending\) > \.tool-card-body[\s\S]{0,400}?\{[^}]*margin-left:\s*26px/,
        '卡内入批成员卡体 margin-left 26px 缺失');
    assert.match(clean,
        /\.agent-card-body > \.tool-card:not\(\[data-turn-batch="1"\]\) > \.tool-card-body[\s\S]{0,300}?\{[^}]*margin-left:\s*10px/,
        '卡内未入批回退态卡体 margin-left 10px 缺失');
    /* 思考体：只查「选择器出现过」不够 —— 变异实测把卡内入批思考体整条删掉仍全绿。
       改为逐条断言【选择器 + 同一规则块内的 margin 值】，外部/卡内两档都钉。 */
    assert.match(clean,
        /\.msg-bubble > \.thinking-block\[data-turn-batch="1"\] > \.thinking-block-body[\s\S]{0,600}?\{[^}]*margin-left:\s*26px/,
        '外部思考体未纳入层级缩进（或 margin 值不对）');
    assert.match(clean,
        /\.agent-card-body > \.thinking-block\[data-turn-batch="1"\] > \.thinking-block-body[\s\S]{0,400}?\{[^}]*margin-left:\s*26px/,
        '卡内入批思考体 margin-left 26px 缺失');
    assert.match(clean,
        /\.agent-card-body > \.thinking-block:not\(\[data-turn-batch="1"\]\) > \.thinking-block-body[\s\S]{0,300}?\{[^}]*margin-left:\s*10px/,
        '卡内未入批思考体 margin-left 10px 缺失');

    /* B2 灰底块内距回基线 */
    const grayBodies = parseRules(clean)
        .filter(r => r.selector.split(',').some(s => s.trim() === '.msg-row.assistant .msg-bubble .tool-card .bash-cmd')
            && r.selector.includes('.thinking-inner-out'))
        .map(r => r.body);
    assert.ok(grayBodies.length, '展开内容内距规则缺失');
    const gray = grayBodies.join('\n');
    assert.match(gray, /padding-left:\s*14px/, '灰底块内距必须回基线 14px');
    assert.doesNotMatch(gray, /padding-left:\s*(34|50|64)px/, '旧「只推文字」口径残留');
    assert.match(clean, /\.tool-card-body\.is-edit \.git-diff-line \{ padding-left: 14px; \}/, 'diff 行未同口径');
    assert.match(clean, /\.tool-card \.grep-hit \{ padding-left: 28px; \}/, 'grep 命中行未同口径');
    assert.doesNotMatch(clean, /\.agent-card \.tool-card \.bash-cmd,/, '旧卡内 padding 例外块仍在');

    /* B3 引导线严格在展开块盒子左侧之外 */
    const guide = ruleBody(clean, '.turn-batch-header.turn-batch-open::before');
    assert.ok(guide, '批次引导线规则缺失');
    const gm = guide.match(/left:\s*(\d+)px/);
    assert.ok(gm, '引导线 left 缺失');
    const boxRule = clean.match(/\.msg-bubble > \.tool-card\[data-turn-batch="1"\]:not\(\.hitl-pending\) > \.tool-card-body[\s\S]{0,600}?\{[^}]*margin-left:\s*(\d+)px/);
    assert.ok(boxRule, '卡体 margin 规则缺失');
    assert.ok(Number(gm[1]) < Number(boxRule[1]),
        '引导线 ' + gm[1] + 'px 必须严格小于展开块盒子左缘 ' + boxRule[1] + 'px');

    /* C1/C2 自绘滚动条与全站同源 */
    const sb = ruleBody(clean, '.turn-batch-header.turn-batch-windowed::after');
    assert.ok(sb, '自绘滚动条规则缺失');
    assert.match(sb, /width:\s*var\(--scrollbar-size/, '轨道宽必须取 --scrollbar-size');
    assert.match(sb, /border-radius:\s*var\(--scrollbar-radius/, '圆角必须取 --scrollbar-radius');
    assert.match(sb, /border-left:\s*var\(--scrollbar-thumb-inset/, '左内衬必须取 --scrollbar-thumb-inset');
    assert.match(sb, /border-right:\s*var\(--scrollbar-thumb-inset/, '右内衬同源');
    assert.match(sb, /background-clip:\s*padding-box/, '必须 padding-box');
    assert.doesNotMatch(sb, /border-radius:\s*3px/, '旧 3px 直角残留');
    assert.doesNotMatch(sb, /width:\s*6px/, '旧独立 6px 轨道宽残留');
    /* 【codereview 补】轨道右缘必须与原生同缘（right:0）。旧值 2px 会让自绘轨道
       比原生滚动条内缩 2px —— 变异实测：改回 2px 时本护栏原先全绿（漏抓）。 */
    assert.match(sb, /right:\s*0(?![\d.])/, '轨道右缘必须 right:0（与原生占位同缘）');
    assert.match(js, /scrollbarVar\(header,\s*'--scrollbar-thumb-min'/, '最小 thumb 高度必须读全站变量');
    assert.doesNotMatch(js, /var SB_MIN_THUMB = 28/, '旧硬编码 28 残留');
    assert.doesNotMatch(js, /Math\.max\(SB_MIN_THUMB,/, '仍在用旧常量算 thumb');
    /* 【codereview 补】变量读不到时的回落值也必须等于规范值 36。变异实测：
       改成 28 时本护栏原先全绿 —— 桩 DOM / 变量缺失环境会静默退回旧几何。 */
    assert.match(js, /var SB_MIN_THUMB_FALLBACK = 36;/, 'thumb 最小高回落值必须与 --scrollbar-thumb-min 同值 36');

    /* ===== D 组：内部滚动体优先（㉔ 合成窗不得抢滚轮）=====
       变异实测口径：把让位判定去掉 → 本函数必须抛。 */
    assert.match(js, /function innerScrollerForWheel\(target, dy\)/, '让位判定函数缺失');
    const guardCall = js.match(/if \(innerScrollerForWheel\(ev\.target, dy\)\) return;/);
    assert.ok(guardCall, 'bindWindowWheel 必须在算 pos 前让位给内部滚动体');
    /* 让位必须发生在 preventDefault 之前（否则原生滚动仍被吃掉） */
    const wheelFn = js.slice(js.indexOf('function bindWindowWheel('));
    const guardAt = wheelFn.indexOf('innerScrollerForWheel(ev.target, dy)');
    const pdAt = wheelFn.indexOf('ev.preventDefault()');
    assert.ok(guardAt >= 0 && pdAt > guardAt, '让位判定必须先于 preventDefault');
    /* 三类内部滚动体都要认（用户点名「工具、思考等」，子代理卡体同族） */
    for (const cls of ['tool-card-body', 'thinking-block-body', 'agent-card-body']) {
        assert.ok(js.includes("cls.contains('" + cls + "')"), '让位判定漏了 .' + cls);
    }
    /* 只在「该方向还有余量」时让位：到边界仍由窗接管，否则长输出上批次滚不动。
       字符串断言不够（变异 `if (canScroll) return node` 仍含余量表达式却不用它），
       故下面用真实函数跑行为对照，见 checkWheelBehavior。 */
    assert.match(js, /node\.scrollHeight - node\.clientHeight - node\.scrollTop/, '下滑余量判定缺失');
    checkWheelBehavior(dir);
    return true;
}

/* 行为口径的唯一实现：主测试 E1-E4 与变异子进程共用（零复制）。
   dir 可指向变异后的目录，保证「改磁盘 → 必须判红」是真求值不是字符串匹配。 */
function checkWheelBehavior(dir) {
    /* E1 内部还有余量 → 让位 */
    const a = wheelFixture({ scrollHeight: 1125, clientHeight: 300, scrollTop: 0 }, dir);
    assert.equal(a.fire(300).prevented, false, '内部有余量时窗不得吃掉滚轮');
    assert.equal(a.header._winPos, 300, '窗位置不得被内部滚轮推动');
    assert.equal(a.calls.painted, 0, '不得触发合成滚动重绘');
    /* E2 内部已到下滑边界 → 窗接管（去掉余量判定的变异体会在此判红） */
    const b = wheelFixture({ scrollHeight: 1125, clientHeight: 300, scrollTop: 825 }, dir);
    assert.equal(b.fire(300).prevented, true, '内部到边界后必须由窗接管，否则批次永远滚不动');
    assert.equal(b.header._winPos, 600, '窗按 delta 前进');
    /* E3 内部不可滚 → 窗接管 */
    const c = wheelFixture({ scrollHeight: 200, clientHeight: 300, scrollTop: 0 }, dir);
    assert.equal(c.fire(200).prevented, true, '不可滚的卡体不该拦窗');
    /* E4 上滑方向同样按余量判定 */
    const d = wheelFixture({ scrollHeight: 1125, clientHeight: 300, scrollTop: 0 }, dir);
    assert.equal(d.fire(-200).prevented, true, '卡体已在顶部，上滑应由窗接管');
    const e = wheelFixture({ scrollHeight: 1125, clientHeight: 300, scrollTop: 400 }, dir);
    assert.equal(e.fire(-200).prevented, false, '卡体上方还有余量，上滑归卡体');
    return true;
}
module.exports = { checkAll };

for (const c of COPIES) {
    test(`★ A1 [${c.name}] 三个内部滚动体都声明 overscroll-behavior: contain，且仍是可滚容器`, () => {
        const css = readRaw(path.join(c.dir, 'css', 'app.css'));
        for (const sel of INNER_SCROLLER_SELECTORS) {
            const bodies = rulesFor(css, sel);
            assert.ok(bodies.length, `${c.name}：规则 ${sel} 缺失`);
            const all = bodies.join('\n');
            assert.match(all, /overscroll-behavior:\s*contain/,
                `${c.name} ${sel}：必须 contain —— 内部滚到边界不得把滚轮交给整页消息区`);
            /* 防「修滚动条被做成不滚动」：限高 + overflow-y:auto 必须仍在 */
            assert.match(all, /max-height:\s*\d+px/, `${c.name} ${sel}：限高丢失`);
            assert.match(all, /overflow-y:\s*auto/, `${c.name} ${sel}：滚动能力丢失`);
        }
    });
}

test('★ A2 不得残留 overscroll-behavior: auto 的内部滚动体声明（含单行多声明写法）', () => {
    for (const c of COPIES) {
        const css = readRaw(path.join(c.dir, 'css', 'app.css'));
        for (const sel of INNER_SCROLLER_SELECTORS) {
            const bodies = rulesFor(css, sel);
            assert.ok(bodies.length, `${c.name} ${sel} 规则缺失`);
            for (const body of bodies) {
                assert.doesNotMatch(body, /overscroll-behavior:\s*auto/,
                    `${c.name} ${sel}：auto 会把内部滚动外溢到整页（用户报障根因）`);
            }
        }
    }
});

/* ===== 二、层级由卡体盒子右移承担（问题②）===== */
test('★ B1 成员卡体 margin-left 26px（外部/卡内入批），卡内未入批回退态 10px', () => {
    for (const c of COPIES) {
        const clean = stripComments(readRaw(path.join(c.dir, 'css', 'app.css')));
        assert.match(clean,
            /\.msg-bubble > \.tool-card\[data-turn-batch="1"\]:not\(\.hitl-pending\) > \.tool-card-body[\s\S]{0,600}?\{[^}]*margin-left:\s*26px/,
            `${c.name}：外部成员卡体 margin-left 26px 缺失`);
        assert.match(clean,
            /\.agent-card-body > \.tool-card\[data-turn-batch="1"\]:not\(\.hitl-pending\) > \.tool-card-body[\s\S]{0,400}?\{[^}]*margin-left:\s*26px/,
            `${c.name}：卡内入批成员卡体 margin-left 26px 缺失`);
        assert.match(clean,
            /\.agent-card-body > \.tool-card:not\(\[data-turn-batch="1"\]\) > \.tool-card-body[\s\S]{0,300}?\{[^}]*margin-left:\s*10px/,
            `${c.name}：卡内未入批回退态卡体 margin-left 10px 缺失`);
        /* 思考体同口径（用户明确点名「工具、思考等」）——三档都钉值，
           不是「选择器出现过」的恒真断言（codereview 变异实测：整条删掉曾全绿）。 */
        assert.match(clean,
            /\.msg-bubble > \.thinking-block\[data-turn-batch="1"\] > \.thinking-block-body[\s\S]{0,600}?\{[^}]*margin-left:\s*26px/,
            `${c.name}：外部思考体未纳入层级缩进（或 margin 值不对）`);
        assert.match(clean,
            /\.agent-card-body > \.thinking-block\[data-turn-batch="1"\] > \.thinking-block-body[\s\S]{0,400}?\{[^}]*margin-left:\s*26px/,
            `${c.name}：卡内入批思考体 margin-left 26px 缺失`);
        assert.match(clean,
            /\.agent-card-body > \.thinking-block:not\(\[data-turn-batch="1"\]\) > \.thinking-block-body[\s\S]{0,300}?\{[^}]*margin-left:\s*10px/,
            `${c.name}：卡内未入批思考体 margin-left 10px 缺失`);
    }
});

test('★ B2 灰底展开块内距回基线 14px；不得再用 padding 50/34px 冒充层级', () => {
    for (const c of COPIES) {
        const clean = stripComments(readRaw(path.join(c.dir, 'css', 'app.css')));
        /* 该规则是 8 个选择器的列表，用「列表里含某一项」定位，不能用整串相等 */
        const bodies = parseRules(clean)
            .filter(r => r.selector.split(',').some(s => s.trim() === '.msg-row.assistant .msg-bubble .tool-card .bash-cmd')
                && r.selector.includes('.thinking-inner-out'))
            .map(r => r.body);
        assert.ok(bodies.length, `${c.name}：展开内容内距规则缺失`);
        const body = bodies.join('\n');
        assert.match(body, /padding-left:\s*14px/, `${c.name}：灰底块内距必须回基线 14px`);
        assert.doesNotMatch(body, /padding-left:\s*(34|50|64)px/,
            `${c.name}：旧「只推文字」口径残留 → 盒子左缘仍在 0px，会盖住引导线`);
        assert.match(clean, /\.tool-card-body\.is-edit \.git-diff-line \{ padding-left: 14px; \}/,
            `${c.name}：diff 行未同口径`);
        assert.match(clean, /\.tool-card \.grep-hit \{ padding-left: 28px; \}/,
            `${c.name}：grep 命中行未同口径`);
        /* 旧卡内 padding 例外块必须整体消失，否则与卡体 margin 双重叠加 */
        assert.doesNotMatch(clean, /\.agent-card \.tool-card \.bash-cmd,/,
            `${c.name}：旧卡内 padding 例外块仍在`);
    }
});

test('★ B3 引导线仍在 16px，且小于卡体 margin 26px（线永远在灰底块左侧之外）', () => {
    for (const c of COPIES) {
        const clean = stripComments(readRaw(path.join(c.dir, 'css', 'app.css')));
        const guide = ruleBody(clean, '.turn-batch-header.turn-batch-open::before');
        assert.ok(guide, `${c.name}：批次引导线规则缺失`);
        const m = guide.match(/left:\s*(\d+)px/);
        assert.ok(m, `${c.name}：引导线 left 缺失`);
        const guideX = Number(m[1]);
        const bodyRule = clean.match(/\.msg-bubble > \.tool-card\[data-turn-batch="1"\]:not\(\.hitl-pending\) > \.tool-card-body[\s\S]{0,600}?\{[^}]*margin-left:\s*(\d+)px/);
        assert.ok(bodyRule, `${c.name}：卡体 margin 规则缺失`);
        const boxX = Number(bodyRule[1]);
        assert.ok(guideX < boxX,
            `${c.name}：引导线 ${guideX}px 必须严格小于展开块盒子左缘 ${boxX}px，否则又被浅底盖住`);
    }
});

/* ===== 三、自绘滚动条与全站规范同源（问题③）===== */
test('★ C1 自绘 thumb 全部引用 --scrollbar-* 变量，不得再写独立几何常量', () => {
    for (const c of COPIES) {
        const clean = stripComments(readRaw(path.join(c.dir, 'css', 'app.css')));
        const body = ruleBody(clean, '.turn-batch-header.turn-batch-windowed::after {');
        assert.ok(body, `${c.name}：自绘滚动条规则缺失`);
        assert.match(body, /width:\s*var\(--scrollbar-size/, `${c.name}：轨道宽必须取 --scrollbar-size`);
        assert.match(body, /border-radius:\s*var\(--scrollbar-radius/, `${c.name}：圆角必须取 --scrollbar-radius（两端胶囊弧度）`);
        assert.match(body, /border-left:\s*var\(--scrollbar-thumb-inset/, `${c.name}：左透明内衬必须取 --scrollbar-thumb-inset`);
        assert.match(body, /border-right:\s*var\(--scrollbar-thumb-inset/, `${c.name}：右透明内衬同源`);
        assert.match(body, /background-clip:\s*padding-box/, `${c.name}：必须 padding-box 才能让内衬收窄可见滑块`);
        assert.doesNotMatch(body, /border-radius:\s*3px/, `${c.name}：旧 3px 直角残留`);
        assert.doesNotMatch(body, /width:\s*6px/, `${c.name}：旧独立 6px 轨道宽残留`);
        /* codereview 补：轨道右缘与原生同缘（旧 2px 会内缩，变异曾漏抓） */
        assert.match(body, /right:\s*0(?![\d.])/, `${c.name}：轨道右缘必须 right:0`);
    }
});

test('★ C2 JS 最小 thumb 高度读 --scrollbar-thumb-min，不再硬编码 28', () => {
    for (const c of COPIES) {
        const js = norm(readRaw(path.join(c.dir, 'js', 'app-turn-display.js')));
        assert.match(js, /scrollbarVar\(header,\s*'--scrollbar-thumb-min'/,
            `${c.name}：最小 thumb 高度必须读全站变量`);
        assert.doesNotMatch(js, /var SB_MIN_THUMB = 28/, `${c.name}：旧硬编码 28 残留`);
        assert.doesNotMatch(js, /Math\.max\(SB_MIN_THUMB,/, `${c.name}：仍在用旧常量算 thumb`);
        /* codereview 补：回落值也要等于规范值（变异改 28 曾漏抓） */
        assert.match(js, /var SB_MIN_THUMB_FALLBACK = 36;/,
            `${c.name}：thumb 最小高回落值必须与 --scrollbar-thumb-min 同值 36`);
    }
});

/* ===== 三之二、内部滚动体优先（㉔ codereview 新增：合成窗抢滚轮）=====
   真实 Chromium + CDP 实测（指针命中 .thinking-inner-out，卡体可滚 825px）：
     修前 卡体 scrollTop 恒 0；批次 _winPos 300→500→673；窗到底后整页 632→832→1032
     修后 卡体自己滚，批次与整页不动
   本组用【真实源码函数 + 极简 DOM】跑行为，不是字符串存在性断言。 */
function loadWheelHandler(jsSrc, dir) {
    /* 从真实源码里取 innerScrollerForWheel + bindWindowWheel + windowHeaderForEvent，
       其余依赖注入桩，直接触发 wheel 监听器观察 preventDefault / pos 变化。 */
    function extract(name) {
        const i = jsSrc.indexOf('function ' + name + '(');
        assert.ok(i >= 0, '源码缺函数 ' + name);
        const open = jsSrc.indexOf('{', i);
        let d = 0;
        for (let j = open; j < jsSrc.length; j++) {
            if (jsSrc[j] === '{') d++;
            else if (jsSrc[j] === '}') { d--; if (d === 0) return jsSrc.slice(i, j + 1); }
        }
        throw new Error('括号不配平: ' + name);
    }
    const src = extract('innerScrollerForWheel') + '\n' + extract('bindWindowWheel') + '\n'
        + extract('windowHeaderForEvent') + '\nreturn { bindWindowWheel: bindWindowWheel };';
    const calls = { painted: 0 };
    const deps = {
        WINDOW_MAX_PX: 232,
        childHeadersOf: (b) => b._headers || [],
        membersOf: (h) => h._members || [],
        paintWindow: () => { calls.painted++; },
        moveWindowScrollbar: () => {},
        /* 【几何新鲜度 · 2026-11-25】wheel 消费缓存前差分实测：桩节点无
           getBoundingClientRect → windowExtentLive 不可差分（null）→
           语义上等于「无缓存」，这里按「无漂移」处理（不触发重算），
           E1~E4 断言的边界/让位行为不受影响。 */
        ensureWindowFresh: () => {},
        console
    };
    const names = Object.keys(deps);
    const api = new Function(...names, src)(...names.map(n => deps[n]));
    return { api, calls };
}
/* 极简节点：只实现 wheel 路径用到的 API */
function wNode(cls, opts) {
    opts = opts || {};
    const n = {
        nodeType: 1, parentNode: null, children: [],
        scrollHeight: opts.scrollHeight || 0,
        clientHeight: opts.clientHeight || 0,
        scrollTop: opts.scrollTop || 0,
        _classes: new Set((cls || '').split(/\s+/).filter(Boolean)),
        classList: { contains: (c) => n._classes.has(c) },
        contains: (o) => { let p = o; while (p) { if (p === n) return true; p = p.parentNode; } return false; },
        addEventListener: (ev, fn) => { (n._l = n._l || {})[ev] = fn; },
        appendChild: (c) => { c.parentNode = n; n.children.push(c); return c; }
    };
    return n;
}
function wheelFixture(innerOpts, dir) {
    const { api, calls } = loadWheelHandler(norm(readRaw(path.join(dir || UI, 'js', 'app-turn-display.js'))));
    const bubble = wNode('msg-bubble');
    const header = wNode('turn-batch-header turn-batch-windowed');
    const member = wNode('tool-card');
    const body = wNode('thinking-block-body', innerOpts);
    const inner = wNode('thinking-inner-out');
    bubble.appendChild(header); bubble.appendChild(member);
    member.appendChild(body); body.appendChild(inner);
    bubble._headers = [header]; header._members = [member];
    header._winOverflow = 673; header._winPos = 300;
    api.bindWindowWheel(header);
    const fire = (dy) => {
        const ev = { target: inner, deltaY: dy, deltaMode: 0, prevented: false, preventDefault() { this.prevented = true; } };
        bubble._l.wheel(ev);
        return ev;
    };
    return { fire, header, body, calls };
}

test('★ E1 指针在【仍可滚的内部卡体】上：合成窗必须让位（不 preventDefault、不动 pos）', () => {
    const f = wheelFixture({ scrollHeight: 1125, clientHeight: 300, scrollTop: 0 });
    const ev = f.fire(300);
    assert.equal(ev.prevented, false, '内部还有 825px 余量，窗不得吃掉滚轮（用户报障根因）');
    assert.equal(f.header._winPos, 300, '窗位置不得被内部滚轮推动');
    assert.equal(f.calls.painted, 0, '不得触发合成滚动重绘');
});

test('★ E2 内部卡体已到下滑边界：窗接管（否则长输出上批次永远滚不动）', () => {
    const f = wheelFixture({ scrollHeight: 1125, clientHeight: 300, scrollTop: 825 });
    const ev = f.fire(300);
    assert.equal(ev.prevented, true, '内部到边界后应由窗接管');
    assert.equal(f.header._winPos, 600, '窗按 delta 前进');
});

test('★ E3 内部卡体不可滚（内容未超限）：窗照常接管', () => {
    const f = wheelFixture({ scrollHeight: 200, clientHeight: 300, scrollTop: 0 });
    const ev = f.fire(200);
    assert.equal(ev.prevented, true, '不可滚的卡体不该拦窗');
    assert.equal(f.header._winPos, 500);
});

test('★ E4 上滑方向同样按余量判定：顶部上滑交给窗，中部上滑归卡体', () => {
    const top = wheelFixture({ scrollHeight: 1125, clientHeight: 300, scrollTop: 0 });
    assert.equal(top.fire(-200).prevented, true, '卡体已在顶部，上滑应由窗接管');
    const mid = wheelFixture({ scrollHeight: 1125, clientHeight: 300, scrollTop: 400 });
    assert.equal(mid.fire(-200).prevented, false, '卡体上方还有余量，上滑归卡体');
    assert.equal(mid.header._winPos, 300);
});

test('★ C3 theme.css 规范本体仍在（本护栏的锚，四份同源）', () => {
    const themes = COPIES.map(c => norm(readRaw(path.join(c.dir, 'css', 'theme.css'))));
    for (const t of themes) {
        assert.match(t, /--scrollbar-size:\s*12px/);
        assert.match(t, /--scrollbar-thumb-inset:\s*3px/);
        assert.match(t, /--scrollbar-radius:\s*8px/);
        assert.match(t, /--scrollbar-thumb-min:\s*36px/);
    }
    for (let i = 1; i < themes.length; i++) {
        assert.equal(themes[i], themes[0], COPIES[i].name + ' theme.css 与 desktop 漂移');
    }
});

/* ===== 四、四份副本逐字同源 ===== */
test('★ D1 四份 app.css / app-turn-display.js 逐字一致', () => {
    for (const f of ['css/app.css', 'js/app-turn-display.js']) {
        const base = norm(readRaw(path.join(UI, f)));
        for (let i = 1; i < COPIES.length; i++) {
            const p = path.join(COPIES[i].dir, f);
            assert.ok(fs.existsSync(p), COPIES[i].name + ' 缺 ' + f);
            assert.equal(norm(readRaw(p)), base, COPIES[i].name + ' ' + f + ' 漂移');
        }
    }
});

/* ===== 五、真变异对照：把磁盘改回旧口径，本文件必须失败 ===== */
const MUTATIONS = [
    {
        name: '内部滚动体改回 auto',
        file: 'css/app.css',
        from: '.thinking-block-body { padding: 0; font-size: 13px; color: var(--text-secondary); line-height: 1.7; max-height: 300px; overflow-y: auto; overscroll-behavior: contain; }',
        to: '.thinking-block-body { padding: 0; font-size: 13px; color: var(--text-secondary); line-height: 1.7; max-height: 300px; overflow-y: auto; overscroll-behavior: auto; }',
    },
    {
        name: '层级退回「只推文字」旧口径',
        file: 'css/app.css',
        from: '.msg-row.assistant .msg-bubble .tool-card .grep-hit { padding-left: 28px; }',
        to: '.msg-row.assistant .msg-bubble .tool-card .grep-hit { padding-left: 64px; }',
    },
    {
        /* 【修复 2026-11-25】锚点必须是【自绘滚动条 ::after 规则】内唯一形态：
           'border-radius: var(--scrollbar-radius, 8px);' 在 app.css 出现 2 次（第一处
           是 webkit-scrollbar-thumb 规则）。旧实现 String.replace（单次替换）只改到
           第一处 —— ::after 规则原样未动，护栏断言的是 ::after，变异体静默存活
           （实测 not ok：变异体未被抓住）。锚点补上 preceding 'border-right:' 行后
           全文唯一，replace 恰好命中 ::after 本体。 */
        name: '自绘滚动条退回独立 3px 圆角',
        file: 'css/app.css',
        from: "border-right: var(--scrollbar-thumb-inset, 3px) solid transparent;\r\n    border-radius: var(--scrollbar-radius, 8px);",
        to: "border-right: var(--scrollbar-thumb-inset, 3px) solid transparent;\r\n    border-radius: 3px;",
    },
];

/* 【codereview 2026-11-25 返工 · 变异不再污染权威源】
   旧实现直接改 desktop/ui 的真实文件再还原。node --test 默认并发跑多个测试文件，
   在「写入变异 → 子进程求值 → 还原」这段窗口里，别的测试文件读到的是被改坏的
   app.css / app-turn-display.js —— 本轮全量实测两次假红：
     · process-flat-contract ①「两份权威镜像逐字一致」
     · process-flat-contract ④「基类规则缺失: .tool-card-body」（读到写了一半的文件）
   现改为：把整个 ui 目录复制到临时沙箱，只在沙箱里变异，checkAll(沙箱) 求值。
   权威源全程零写入 ⇒ 并发零干扰，也不需要「先还原再断言」的补救顺序。 */
function makeSandbox() {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gourd-mut-'));
    fs.cpSync(UI, dir, { recursive: true });
    return dir;
}

for (const mut of MUTATIONS) {
    test(`★ M[${mut.name}] 变异体必须被本护栏抓住（沙箱变异 + 子进程求值，权威源零写入）`, () => {
        const sandbox = makeSandbox();
        try {
            const target = path.join(sandbox, mut.file);
            const original = readRaw(target);
            assert.ok(original.includes(mut.from), '变异锚点不存在，护栏会空转：' + mut.from.slice(0, 60));
            fs.writeFileSync(target, original.replace(mut.from, mut.to), 'utf8');
            assert.notEqual(readRaw(target), original, '变异未生效');
            /* 子进程跑 `node --test 本文件` 会被 node:test 判为递归而静默跳过，
               护栏空转。改用 `node -e` 直接 require 本文件的【纯断言函数】对沙箱求值：
               不经过 test runner，断言逻辑与主测试完全同源（含 E 组行为对照）。 */
            const probe = [
                "const m = require(" + JSON.stringify(SELF) + ");",
                "m.checkAll(process.argv[1]);"
            ].join('\n');
            const r = spawnSync(process.execPath, ['-e', probe, sandbox],
                { encoding: 'utf8', timeout: 120000 });
            const out = (r.stdout || '') + (r.stderr || '');
            assert.notEqual(r.status, 0, '变异体未被抓住：' + mut.name + '\n' + out.slice(-3000));
            assert.match(out, /AssertionError|assert/, '必须因断言失败而非其它意外退出：' + out.slice(-1500));
        } finally {
            fs.rmSync(sandbox, { recursive: true, force: true });
        }
    });
}

/* 权威源未被变异污染的自证：跑完全部变异后，真实 ui 仍与自身校验一致 */
test('★ M0 变异全程零污染：权威 ui 目录仍通过全部口径断言', () => {
    assert.equal(checkAll(UI), true);
});