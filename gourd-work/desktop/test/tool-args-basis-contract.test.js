/* 工具卡标题行「参数摘要挤压源」的契约（2026-11，经自审校准）
 *
 * 【本测试锁死的范围，勿过度解读】
 *   它证明的是：① 两条 order:3 的摘要元素（.tool-args 与骨架态
 *   .tool-args-progress）都固定为 flex:1 1 0、不会按全文宽度先占位；
 *   ② 四份 UI 副本的这两条规则同源；③ 参数串为空才不生成 .tool-args 的
 *   JS 数据源头仍在。它【不】证明用户截图里那块矩形白区已消失：
 *   像素采样显示该区域与页面背景同为 #FFFFFF（并非不透明覆盖层），
 *   工作区源码折叠态标题行所有子元素 background 均为 rgba(0,0,0,0)，
 *   elementFromPoint 无覆盖层，本机 Chrome 未复现。白区成因未闭环，
 *   须在用户实际运行的打包版上单独取证。
 *
 * 【已实证的机制，真实 Chrome 复现，非静态猜测】
 *   .tool-args 旧值 flex:0 1 auto 时 basis=auto = 整段参数 max-content 宽度，
 *   在 .tool-card-header 这一 flex 行里先占位。用长参数 + header 320/620px
 *   实测 .tool-file client/scroll = 14/66、34/66（被 overflow:hidden +
 *   text-overflow:ellipsis 裁断）；改 1 1 0 后两档均为 66/66，参数摘要仍
 *   伸展吃满剩余空间（620px 下 484→452px）。
 *
 * 【read/write 为何「看起来」例外，勿过度概括】
 *   ARG_SUPPRESSED 抑制 file_path/path/content/diff/todos。read/write 在
 *   【只传这些键】时 argsStr 为空 ⇒ createToolCardShell 不生成 .tool-args
 *   ⇒ 没有挤压源。但 read 带 offset/limit、write 带其它可选键时同样会生成。
 *   例外的是「参数串是否为空」，不是工具种类，也不是硬编码白名单。
 *
 * 【自审修复 2026-11】旧版 ③b 是自证循环：在测试体内手写一遍 ① 的断言再
 *   assert.throws，改掉 ① 它照样绿，护栏无牙。现改为真正 spawn 一个 node
 *   子进程、临时把磁盘副本回退成 0 1 auto、跑 ① 并断言退出码非 0，
 *   finally 无条件还原（含超时/异常路径），不污染工作区。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const COPIES = [
    path.join(ROOT, 'gourd-work', 'desktop', 'ui', 'css', 'app.css'),
    path.join(ROOT, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'css', 'app.css'),
    path.join(ROOT, 'gourdai-java', 'gourd-ai-agent', 'target', 'classes', 'static', 'css', 'app.css'),
    path.join(ROOT, 'gourdai-java', 'gourd-ai-tauri', 'ui', 'css', 'app.css'),
];
const MSG_JS = path.join(ROOT, 'gourd-work', 'desktop', 'ui', 'js', 'app-message.js');
// 两条 order:3 的摘要元素都必须锁死 basis:0，缺一（骨架态）就会留同类隐患
const RULES = ['.tool-args', '.tool-args-progress'];

function read(rel) { return fs.readFileSync(rel, 'utf8'); }
function ruleBody(css, selector) {
    // 精确抓基类规则体（不是派生选择器、也不是注释里的文字）
    const m = css.match(new RegExp(selector.replace('.', '\\.') + '\\s*\\{([^}]*)\\}'));
    assert.ok(m, '必须存在 ' + selector + ' 基类规则');
    return m[1];
}
function normalizedBody(css, selector) {
    return ruleBody(css, selector).replace(/\s+/g, ' ').trim();
}

test('① 两条摘要元素都必须是 flex: 1 1 0（basis=0，不按全文宽度先占位）', () => {
    const css = read(COPIES[0]);
    for (const sel of RULES) {
        const body = ruleBody(css, sel);
        assert.match(body, /flex:\s*1 1 0\s*;/,
            sel + ' 的 flex-basis 必须为 0（与 .preview-inline 同口径）');
        assert.doesNotMatch(body, /flex:\s*0 1 auto\s*;/,
            sel + ' 回退 0 1 auto 会把文件名压到 14px（320px 实测）');
    }
});

test('①b 修复注释须记录「参数串为空」例外与长参数实测数据', () => {
    const css = read(COPIES[0]);
    const idx = css.indexOf('.tool-args { display: block');
    const head = css.slice(Math.max(0, idx - 1800), idx);
    assert.match(head, /ARG_SUPPRESSED/, '注释须说明例外的数据源头');
    assert.match(head, /参数串是否为空/, '注释须明确例外不是工具种类');
    assert.match(head, /14\/66/, '注释须钉住 320px 长参数实测裁切数据');
    assert.match(head, /#FFFFFF/, '注释须如实说明白区与页面背景同色、未闭环');
});

test('② 四份 UI 副本的这两条规则逐条同源（不是整文件逐字同源）', () => {
    // 注意：这四份 CSS 的【整份文件】并不相同（tauri 3776 行 vs 权威源 4493 行），
    // 旧注释声称「4 副本逐字同源」是过度概括，本测试只锁这两条具体规则。
    for (const sel of RULES) {
        const base = normalizedBody(read(COPIES[0]), sel);
        for (let i = 1; i < COPIES.length; i++) {
            assert.equal(normalizedBody(read(COPIES[i]), sel), base,
                '副本 ' + path.relative(ROOT, COPIES[i]) + ' 的 ' + sel + ' 规则漂移');
        }
    }
});

test('②b 四份副本都是 CRLF 且无 BOM（修复不得引入行尾/编码回归）', () => {
    for (const p of COPIES) {
        const buf = fs.readFileSync(p);
        assert.ok(!(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF),
            path.relative(ROOT, p) + ' 出现 BOM');
        const txt = buf.toString('utf8');
        assert.ok(txt.indexOf('\r\n') > -1, path.relative(ROOT, p) + ' 不是 CRLF');
        assert.equal((txt.match(/(?<!\r)\n/g) || []).length, 0,
            path.relative(ROOT, p) + ' 混入裸 LF');
    }
});

test('③ JS 源头：ARG_SUPPRESSED 与「argsStr 非空才建 .tool-args」的接线仍在', () => {
    const js = read(MSG_JS);
    const m = js.match(/var ARG_SUPPRESSED\s*=\s*\{([^}]*)\}/);
    assert.ok(m, '必须存在 ARG_SUPPRESSED 表');
    for (const k of ['file_path', 'path', 'content', 'diff', 'todos']) {
        assert.match(m[1], new RegExp('\\b' + k + '\\b'), 'ARG_SUPPRESSED 缺少 ' + k);
    }
    assert.match(js, /Object\.keys\(args\)\.filter\(function\(k\)\s*\{\s*return\s*!ARG_SUPPRESSED\[k\]/,
        'formatToolArgsStr 必须按 ARG_SUPPRESSED 过滤');
    assert.match(js, new RegExp("argsStr\\s*\\?\\s*'<span class=\"tool-args\">"),
        'createToolCardShell 必须只在 argsStr 非空时生成 .tool-args');
});

test('③b 真变异对照：把磁盘副本回退成 0 1 auto，① 必须判红', () => {
    const target = COPIES[0];
    const original = fs.readFileSync(target);
    // 只回退 .tool-args 的 flex（不动 .tool-args-progress），验证 ① 单条即可拦下
    const reverted = Buffer.from(original.toString('utf8')
        .replace('.tool-args { display: block; order: 3; flex: 1 1 0;',
                 '.tool-args { display: block; order: 3; flex: 0 1 auto;'), 'utf8');
    assert.notEqual(reverted.toString('utf8'), original.toString('utf8'),
        '变异体必须与当前源不同（否则护栏自污染）');

    /* 【2026-11-10 codereview 修复】变异体写进【临时文件】，绝不写回生产源。

       旧写法 writeFileSync(target, reverted) → 子进程校验 → finally 还原 target。
       `npm run test:js` 跑的是 `node --test test/*.test.js`，node 按【文件】并行开
       多个进程，而本测试与 scrollbar-uniformity.test.js 变异的是【同一个】app.css。
       writeFileSync 先截断再写入、并非原子操作，于是并发的纯读取方（如
       turn-batch.test.js:687 的「缺 ⑭ 统一图标块」）会在「已截断、未写完」的窗口里
       读到半截文件，表现为偶发漂移失败（实测约十次一次）。
       更严重的风险是持久损坏：进程若在变异窗口内被杀，finally 来不及执行，
       app.css 就永久留在变异态。改用临时文件后两者一并消除，子进程仍真读真断言。 */
    const mutant = path.join(os.tmpdir(), 'tool-args-mutant-' + process.pid + '.css');
    try {
        fs.writeFileSync(mutant, reverted);
        // 真跑一个独立 node 进程执行 ① 的两条断言；不复用本测试内的手写副本
        const probe = [
            "const fs=require('fs'),assert=require('assert');",
            "const css=fs.readFileSync(" + JSON.stringify(mutant) + ",'utf8');",
            "const m=css.match(/\\.tool-args\\s*\\{([^}]*)\\}/);",
            "assert.ok(m,'no rule');",
            "assert.match(m[1],/flex:\\s*1 1 0\\s*;/);",
            "assert.doesNotMatch(m[1],/flex:\\s*0 1 auto\\s*;/);"
        ].join('\n');
        const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 15000 });
        assert.notEqual(r.status, 0,
            '回退到 0 1 auto 后 ① 必须判红（当前 status=' + r.status + '，说明护栏无牙）');
        assert.match((r.stderr || '') + (r.stdout || ''), /AssertionError|assert/,
            '必须因断言失败而非其它意外退出');
    } finally {
        fs.rmSync(mutant, { force: true });
    }
    // 生产源必须逐字未被触碰 —— 这条断言本身就是「变异不外溢」的护栏
    assert.equal(fs.readFileSync(target).toString('utf8'), original.toString('utf8'),
        '变异对照不得修改生产源文件 ' + COPIES[0]);
});
