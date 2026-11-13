/* process-flat-contract.test.js —— 过程行「彻底无卡片态」契约（2026-11 用户拍板）
 *
 * 用户报障：报错后整轮折叠变默认展开，工具/思考行又回到「左竖条 + 圆角 + hover 灰底」
 * 的卡片形态，要求「彻底把卡片态的样式都删除，不要再出现这种的」。
 *
 * 本契约钉三层，防止回潮：
 *  ① CSS【全选择器扫描】：剥注释后枚举 app.css 里所有规则；凡选择器命中四基类
 *     （.tool-card / .thinking-block / .agent-card / .tool-batch-group）的，规则体内
 *     不得出现 border-left*（竖条）/ border-radius（圆角）/ --bg-hover（灰底）等
 *     卡片残料。豁免仅限待审批 HITL 卡（.hitl-pending 的警示描边/圆角，产品口径
 *     「审批不能弱化」）。
 *     【为何是扫描而非固定选择器清单】2026-11 codereview 变异实证：旧版只查行首
 *     `^\.cls {` 基类 + 5 个固定 hover 选择器，往带前缀的
 *     `.msg-row.assistant.agent-live ... .tool-card:hover` 或
 *     `.msg-row.assistant ... .agent-card` 规则里加回灰底/竖条，84 项测试全绿
 *     SURVIVED。带 !important 的展开态覆盖（.turn-compact-open / .agent-live）
 *     恰是「报错摊开 → 卡片态回潮」的第二条路径，必须被覆盖。
 *  ② JS 接线【双镜像】：compactBubble 的 !decision（失败/无正文轮）分支不得调用
 *     revealAll —— 那是「报错后折叠变默认展开」的直接根因；revealAll 仅保留为导出
 *     API。desktop 与 java static 两份 app-turn-display.js 逐字一致（HEAD 本一致）。
 *  ③ 过程行卡体分隔线：.tool-card-body / .thinking-block-body 不得有 border-top。
 *
 * 四份 app.css 副本中只钉【两份权威镜像】（desktop 与 java static），tauri/target 副本
 * 是构建期产物（prepare-ui.js 明确 static/ 为唯一源），既有口径不作第三份 required。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CSS_FILES = [
    path.join(__dirname, '..', 'ui', 'css', 'app.css'),
    path.join(ROOT, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'css', 'app.css')
];
const DISPLAY_JS = [
    path.join(__dirname, '..', 'ui', 'js', 'app-turn-display.js'),
    path.join(ROOT, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'js', 'app-turn-display.js')
];

const BASE_CLASS = /\.(tool-card|thinking-block|agent-card|tool-batch-group)(?![\w-])/;
/* 卡片残料声明：竖条 / 圆角 / 灰底。值为 0 / none / transparent 的归零声明允许。 */
const RESIDUE = /^(border-left(?:-color|-width|-style)?|border-radius|background(?:-color)?)\s*:\s*(.+)$/i;
const CLEAN_VALUE = /^(0|none|transparent)(\s*!important)?$/i;

/* 取基类规则体：精确匹配行首 `.cls {`，用于 ③ 的卡体分隔线检查。 */
function baseRule(css, cls) {
    const re = new RegExp('^\\.' + cls.replace(/[-]/g, '\\-') + '\\s*\\{([^}]*)\\}', 'm');
    const m = css.match(re);
    assert.ok(m, '基类规则缺失: .' + cls);
    return m[1];
}
function declValue(body, prop) {
    const re = new RegExp('(?:^|[;\\s])' + prop + '\\s*:\\s*([^;}]+)');
    const m = body.match(re);
    return m ? m[1].trim() : null;
}
function isCardResidue(v) {
    if (v == null) return false;
    return v !== '0' && v !== 'none' && v !== 'transparent';
}
/* 剥块注释，避免注释里的历史声明 / 说明文字被当成规则体或选择器。 */
function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ''); }

test('① 两份权威镜像 CSS 逐字一致（单侧修复会被同步冲掉）', () => {
    const a = fs.readFileSync(CSS_FILES[0], 'utf8');
    const b = fs.readFileSync(CSS_FILES[1], 'utf8');
    assert.equal(a, b, 'desktop 与 java static 的 app.css 必须逐字一致');
    const ja = fs.readFileSync(DISPLAY_JS[0], 'utf8');
    const jb = fs.readFileSync(DISPLAY_JS[1], 'utf8');
    assert.equal(ja, jb, 'desktop 与 java static 的 app-turn-display.js 必须逐字一致');
});

test('② 全选择器扫描：过程行四基类不得有任何卡片残料（含带前缀 / !important 覆盖）', () => {
    for (const f of CSS_FILES) {
        const css = stripComments(fs.readFileSync(f, 'utf8'));
        const rules = css.match(/[^{}]+\{[^{}]*\}/g) || [];
        assert.ok(rules.length > 100, '规则解析异常: ' + f);
        const violations = [];
        for (const r of rules) {
            const i = r.indexOf('{');
            const sel = r.slice(0, i).trim().replace(/\s+/g, ' ');
            const body = r.slice(i + 1, r.lastIndexOf('}'));
            if (!BASE_CLASS.test(sel)) continue;
            /* 唯一豁免：待审批 HITL 卡保留整圈警示描边 + 6px 圆角（产品口径，不得弱化） */
            if (/\.hitl-pending/.test(sel)) continue;
            for (const d of body.split(';')) {
                const m = d.trim().match(RESIDUE);
                if (!m) continue;
                const prop = m[1].toLowerCase(), v = m[2].trim();
                if (prop === 'background' || prop === 'background-color') {
                    if (/--bg-hover/.test(v)) violations.push(sel + ' -> ' + d.trim());
                } else if (!CLEAN_VALUE.test(v)) {
                    violations.push(sel + ' -> ' + d.trim());
                }
            }
        }
        assert.deepEqual(violations, [], f + ' 存在卡片残料（竖条/圆角/灰底）:\n' + violations.join('\n'));
    }
});

test('③ 流式强调不得再画左竖条色（任何选择器、任何颜色变量）', () => {
    for (const f of CSS_FILES) {
        const css = stripComments(fs.readFileSync(f, 'utf8'));
        for (const r of css.match(/[^{}]+\{[^{}]*\}/g) || []) {
            const i = r.indexOf('{');
            const sel = r.slice(0, i).trim().replace(/\s+/g, ' ');
            if (!BASE_CLASS.test(sel) || /\.hitl-pending/.test(sel)) continue;
            assert.ok(!/border-left-color\s*:/i.test(r.slice(i)),
                f + ' ' + sel + ' 不得用左竖条色表达强调（竖条已整体删除）');
        }
    }
});

test('④ 过程行卡体不得有顶部分隔线（用户报过「每个折叠上都有个横条」）', () => {
    for (const f of CSS_FILES) {
        const css = fs.readFileSync(f, 'utf8');
        for (const cls of ['tool-card-body', 'thinking-block-body']) {
            const body = baseRule(css, cls);
            assert.ok(!isCardResidue(declValue(body, 'border-top')),
                f + ' .' + cls + ' 不得有顶部分隔线（卡片态残料）');
        }
    }
});

test('⑤ 失败轮不得 revealAll 摊开批次（双镜像；报错后「默认展开 + 卡片态」根因已除）', () => {
    for (const f of DISPLAY_JS) {
        const src = fs.readFileSync(f, 'utf8');
        const iDec = src.indexOf('if (!decision) {');
        assert.ok(iDec > 0, f + ' compactBubble 的 !decision 分支必须存在');
        const iEnd = src.indexOf('/* 【Qoder 多折叠组让位', iDec);
        assert.ok(iEnd > iDec, f + ' !decision 分支终点锚点缺失');
        /* 先剥块注释：分支内的决策记录注释会提到 revealAll 字样，只钉【真实调用】 */
        const branch = src.slice(iDec, iEnd).replace(/\/\*[\s\S]*?\*\//g, '');
        assert.ok(!/revealAll\s*\(/.test(branch),
            f + ' !decision（失败/无正文轮）分支不得调用 revealAll：摊开批次是卡片态回潮根因');
        /* revealAll 仍作为导出 API 保留（测试/手动展开用），不得整函数删除 */
        assert.ok(/function revealAll\(container\)/.test(src), f + ' revealAll 导出 API 必须保留');
        assert.ok(/revealAll:\s*revealAll/.test(src), f + ' revealAll 必须仍在模块出口');
    }
});
