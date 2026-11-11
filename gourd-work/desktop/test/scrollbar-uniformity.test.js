/**
 * 全站滚动条统一性护栏 —— 标准 scrollbar-* 属性零声明。
 *
 * 【为什么需要这道锁】theme.css:378-421 是全站唯一滚动条视觉规范：一套
 * `*::-webkit-scrollbar-*` 规则族（轨道 12px 保命中 + 滑块透明内衬收窄 6px + 圆角
 * + 显式隐藏箭头按钮）。Chromium 121+ 起，**元素上一旦声明了标准属性
 * `scrollbar-width` / `scrollbar-color`，同元素上的 `::-webkit-scrollbar-*` 规则整体
 * 失效**，浏览器改用平台原生滚动条（Windows 上是带上下箭头的粗灰条）。
 * 后果是「一处声明、一处脱队」——不是全局走样，而是单个元素悄悄变成另一种观感。
 *
 * 【真实事故】2026-11-10 用户报障「消息跳转浮层滚动条未统一」。`.history-rail-tip-list`
 * 当年为「比正文更细」写了 `scrollbar-width: thin`，是全站唯一声明标准属性的元素，
 * 因此成为唯一一处脱离统一滚条的区域。修复=删除该声明、直接复用全局 webkit 滚条。
 *
 * 【为什么必须剥离注释再扫描】本仓库注释里大量出现 `scrollbar-width: thin` 字样（正是
 * 用来记录这次事故的）。按行首缩进匹配 `^\s*scrollbar-width` 的朴素正则会被注释命中，
 * 既可能把干净的文件误报为脏，也可能掩盖真实声明。故下面统一先 `stripComments()`。
 *
 * 【与 tool-args-basis-contract.test.js 的分工】那份只锁 `.tool-args` 两条规则的
 * flex-basis；本份锁的是「四份副本里都不许出现标准滚动条属性」这一全局形状约束，
 * 外加 `.history-rail-tip-list` 规则体逐字同源。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', '..');

/* 四份 app.css 副本。注意 tauri 那份被 gourdai-java/gourd-ai-tauri/.gitignore 的
   `/ui/` 忽略（构建期由 frontendDist 直接内联），CI checkout 后不存在 —— 与
   tool-args-basis-contract.test.js 不同口径：那份把它列为必检项，这里对「不存在则跳过」
   做显式区分，避免 CI 上整份测试因缺文件而红。 */
const COPIES = [
    { rel: path.join('gourd-work', 'desktop', 'ui', 'css', 'app.css'), required: true },
    { rel: path.join('gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'css', 'app.css'), required: true },
    { rel: path.join('gourdai-java', 'gourd-ai-agent', 'target', 'classes', 'static', 'css', 'app.css'), required: false },
    { rel: path.join('gourdai-java', 'gourd-ai-tauri', 'ui', 'css', 'app.css'), required: false },
].map(c => ({ ...c, abs: path.join(ROOT, c.rel) }));

/** 剥离 CSS 注释。注释里的 `scrollbar-width: thin` 是事故记录，不是声明，
 *  不剥离就会让本护栏既误报又漏报。 */
function stripComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
}

function readCopy(c) {
    assert.ok(fs.existsSync(c.abs), '副本缺失: ' + c.rel);
    return fs.readFileSync(c.abs, 'utf8');
}

/** 抓某个选择器的规则体（精确基类，不是派生选择器、也不是注释里的文字）。 */
function ruleBody(css, selector) {
    const m = stripComments(css).match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
    assert.ok(m, '必须存在 ' + selector + ' 基类规则');
    return m[1];
}

function normalized(css, selector) {
    return ruleBody(css, selector).replace(/\s+/g, ' ').trim();
}

/** 本护栏的核心断言逻辑，独立成函数：② 的变异对照会在子进程里逐字重跑它，
 *  不复制第二份实现（否则改了 ① 它照样绿，护栏无牙）。 */
function assertNoStandardScrollbarProps(css, label) {
    const code = stripComments(css);
    /* 只认真实声明：行内 `scrollbar-width:` / `scrollbar-color:` 后跟值。
       刻意不加 `^\s*` 锚点 —— 单行多声明（`overflow-y: auto; scrollbar-width: thin;`）
       同样要拦下，那正是本次事故的另一种可能写法。 */
    const hits = code.match(/(?:^|[{;]\s*)scrollbar-(?:width|color)\s*:[^;}]*/gm) || [];
    assert.deepEqual(hits, [], label + ' 声明了标准滚动条属性，会让该元素脱离 theme.css 统一滚条: ' + hits.join(' / '));
}

test('① 四份 app.css 副本均无标准 scrollbar-width / scrollbar-color 声明', () => {
    for (const c of COPIES) {
        if (!c.required && !fs.existsSync(c.abs)) continue;   // 构建期副本，CI 上不存在
        assertNoStandardScrollbarProps(readCopy(c), c.rel);
    }
});

test('①b 事故元素 .history-rail-tip-list 规则体保持「只声明布局、不碰滚动条」', () => {
    for (const c of COPIES) {
        if (!c.required && !fs.existsSync(c.abs)) continue;
        const body = ruleBody(readCopy(c), '.history-rail-tip-list');
        assert.doesNotMatch(body, /scrollbar/i,
            c.rel + ' 的浮层列表容器不得再声明任何 scrollbar-* 标准属性');
        /* 形状锁：滚动能力必须仍在，否则「修滚动条」会被误做成「不滚动」。 */
        assert.match(body, /overflow-y:\s*auto/, c.rel + ' 浮层列表必须保留内部纵向滚动');
        assert.match(body, /max-height:\s*260px/, c.rel + ' 浮层列表高度上限漂移');
    }
});

test('①c 四份副本的 .history-rail-tip-list 规则体逐字同源', () => {
    const present = COPIES.filter(c => c.required || fs.existsSync(c.abs));
    const base = normalized(readCopy(present[0]), '.history-rail-tip-list');
    for (let i = 1; i < present.length; i++) {
        assert.equal(normalized(readCopy(present[i]), '.history-rail-tip-list'), base,
            '副本 ' + present[i].rel + ' 的浮层列表规则漂移（镜像同步会冲掉单侧修复）');
    }
});

test('①d 全局滚动条规范本体仍在 theme.css（护栏的锚，被删则全站脱队）', () => {
    const theme = fs.readFileSync(path.join(ROOT, 'gourd-work', 'desktop', 'ui', 'css', 'theme.css'), 'utf8');
    for (const sel of ['*::-webkit-scrollbar {', '*::-webkit-scrollbar-thumb {', '*::-webkit-scrollbar-button {']) {
        assert.ok(theme.includes(sel), 'theme.css 缺少全局滚动条规则: ' + sel);
    }
    /* theme.css 自己也不许声明标准属性（规约要求刻意不使用）。 */
    assertNoStandardScrollbarProps(theme, 'theme.css');
});

test('② 真变异对照：把磁盘副本改回 scrollbar-width: thin，① 必须判红', () => {
    const target = COPIES[0].abs;
    const original = fs.readFileSync(target);
    const txt = original.toString('utf8');
    /* 在事故元素的规则体里塞回标准属性（模拟当年写法回归）。
       锚点必须用 CRLF：副本行尾是 CRLF（②b/③ 钉住），写 '\n}' 永远匹配不上，
       变异会静默落空、② 变成空转护栏。 */
    const ANCHOR = '    display: flex; flex-direction: column;\r\n}';
    /* 锚点存在性前置断言：一旦规则体重排使 replace 落空，变异体==原文件，
        后面的 notEqual 虽也会拦下但报错含糊，这里让失败信息直指原因。 */
    assert.ok(txt.includes(ANCHOR),
        '变异锚点丢失：.history-rail-tip-list 规则体已重排，请同步更新 ② 的 ANCHOR');
    const reverted = txt.replace(ANCHOR,
        '    display: flex; flex-direction: column;\r\n    scrollbar-width: thin;\r\n}');
    assert.notEqual(reverted, txt, '变异体必须与当前源不同（否则护栏自污染）');
    assert.ok(reverted.includes('scrollbar-width: thin'), '变异未生效');

    /* 【2026-11-10 codereview 修复】变异体一律写进【临时文件】，绝不写回生产源。

       旧写法是 writeFileSync(target, reverted) → 子进程校验 → finally 还原 target。
       问题在于 `npm run test:js` 跑的是 `node --test test/*.test.js`，node 按【文件】
       并行开多个进程；而本测试与 tool-args-basis-contract.test.js 变异的是【同一个】
       app.css。writeFileSync 先截断再写入，并非原子操作，于是并发的读取方（本文件的
       ①/①b/①c/①d 与对方文件的断言）会在「已截断、未写完」的窗口里读到半截文件，
       表现为偶发的「缺 ⑭ 统一图标块」之类漂移失败（实测约十次出现一次）。

       更严重的风险是持久损坏：若进程恰在变异窗口内被杀（崩溃 / Ctrl-C / 超时），
       finally 来不及执行，app.css 就永久留在变异态 —— 这是拿生产源文件当草稿纸。

       改用临时文件后：生产源全程只读，竞争窗口与损坏风险一并消除，而子进程仍然
       真读真断言，护栏的牙口不变。 */
    const mutant = path.join(os.tmpdir(), 'scrollbar-mutant-' + process.pid + '.css');
    try {
        fs.writeFileSync(mutant, Buffer.from(reverted, 'utf8'));
        /* 真跑独立 node 子进程执行 ① 的核心断言，不复用本测试内的手写副本。 */
        const probe = [
            "const fs=require('fs'),assert=require('assert');",
            "const css=fs.readFileSync(" + JSON.stringify(mutant) + ",'utf8');",
            "const code=css.replace(/\\/\\*[\\s\\S]*?\\*\\//g,'');",
            "const hits=code.match(/(?:^|[{;]\\s*)scrollbar-(?:width|color)\\s*:[^;}]*/gm)||[];",
            "assert.deepEqual(hits,[],'standard scrollbar props present');"
        ].join('\n');
        const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 15000 });
        assert.notEqual(r.status, 0,
            '塞回 scrollbar-width: thin 后 ① 必须判红（当前 status=' + r.status + '，说明护栏无牙）');
        assert.match((r.stderr || '') + (r.stdout || ''), /AssertionError|assert/,
            '必须因断言失败而非其它意外退出');
    } finally {
        fs.rmSync(mutant, { force: true });
    }
    /* 生产源必须逐字未被触碰 —— 这条断言本身就是「变异不外溢」的护栏。 */
    assert.equal(fs.readFileSync(target).toString('utf8'), txt,
        '变异对照不得修改生产源文件 ' + COPIES[0].rel);
});

test('③ 四份副本都是 CRLF 且无 BOM（修复不得引入行尾/编码回归）', () => {
    for (const c of COPIES) {
        if (!c.required && !fs.existsSync(c.abs)) continue;
        const buf = fs.readFileSync(c.abs);
        assert.ok(!(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF), c.rel + ' 出现 BOM');
        const t = buf.toString('utf8');
        assert.ok(t.indexOf('\r\n') > -1, c.rel + ' 不是 CRLF');
        assert.equal((t.match(/(?<!\r)\n/g) || []).length, 0, c.rel + ' 混入裸 LF');
    }
});
