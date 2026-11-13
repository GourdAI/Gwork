/**
 * 契约测试：智能体卡展开后的内容正文必须与【外部主对话正文】分列，
 * 明确归属于折叠卡（用户 2026-11 报「点击后展示的内容正文未和折叠对齐，和外部的对齐的」）。
 *
 * 真实 Chromium 量测（相对气泡左缘偏移，结束态 .turn-compact-open 展开）：
 *   外部正文 +10 / 折叠头状态点 +34 / 标签「智能体」+50 / 修复前卡内正文 +10 / 修复后 +26
 *   结果摘要文字 +29（其基线 border-left:3px 成功色竖条再内缩一层）/ code 模式同为 +26 与 +10
 *   运行态（.agent-card-streaming）卡片保留 2px 左竖条，展开正文 +28，结束后 +26（2px 跳变，量级极小）。
 *
 * 【本轮 codereview 修复】旧版测试是纯 `css.includes(整条规则字符串)` 断言，变异实验 3/4
 * 功能回退假绿：规则注释化 / 后发同特异性 !important 覆盖回 10px / 塞进 @media(max-width:1px)
 * 全部 PASS；另两条 `!css.includes(...)` 是恒真护栏（所查字符串在文件中从不存在）。
 * 现改为：剥离注释后按【顶层 CSS 块】解析规则，取目标选择器【最终生效】的声明值，
 * 并把"禁止引导线/死规则"改为基于解析后的声明检查，而非全文字符串搜。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const MIRRORS = [
    path.join('gourd-work', 'desktop', 'ui', 'css', 'app.css'),
    path.join('gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'css', 'app.css')
];

const SEL_BODY = '.msg-row.assistant .msg-bubble > .agent-card > .agent-card-body';
const SEL_SUMMARY = '.msg-row.assistant .msg-bubble > .agent-card > .agent-card-body > .agent-result-summary';
const SEL_OUTER = '.msg-row.assistant .msg-bubble > .md-content';
const SEL_INNER_MD_DEAD = '.agent-card-body > .md-content';

/**
 * 剥离注释，按顶层块解析 CSS 规则。
 * - 注释里的"假规则"会被剥掉（抓注释化变异）
 * - @media/@supports/@keyframes 等 at-rule 整块不收（抓 @media 空转变异）
 * - 同名选择器全部保留，由 lastDecl 取最后一条（抓后发覆盖变异）
 * - 引号内的 { } 不参与分块，避免 content:"{" 破坏扫描
 */
function parseTopLevelRules(css) {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const out = [];
    const n = clean.length;
    let i = 0, q = null;
    while (i < n) {
        let sel = '';
        while (i < n) {
            const c = clean[i];
            if (q) { sel += c; if (c === q && clean[i - 1] !== '\\') q = null; i++; continue; }
            if (c === '"' || c === "'") { q = c; sel += c; i++; continue; }
            if (c === '{' || c === '}') break;
            sel += c; i++;
        }
        if (i >= n) break;
        if (clean[i] === '}') { i++; continue; }
        i++;
        let body = '', d = 1; q = null;
        while (i < n && d > 0) {
            const c = clean[i];
            if (q) { body += c; if (c === q && clean[i - 1] !== '\\') q = null; i++; continue; }
            if (c === '"' || c === "'") { q = c; body += c; i++; continue; }
            if (c === '{') { d++; body += c; i++; continue; }
            if (c === '}') { d--; i++; if (d === 0) break; body += c; continue; }
            body += c; i++;
        }
        const s = sel.trim().replace(/\s+/g, ' ');
        if (s && s[0] !== '@') out.push({ selector: s, body });
    }
    return out;
}

/** 取目标选择器最终生效的某声明值（含 !important 标记）；无则返回 null。 */
function lastDecl(rules, selector, prop) {
    let val = null;
    for (const r of rules) {
        if (r.selector !== selector) continue;
        const re = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)', 'i');
        const m = re.exec(r.body);
        if (m) val = m[1].trim().replace(/\s+/g, ' ');
    }
    return val;
}

function loadRules(rel) {
    const f = path.join(REPO, rel);
    assert.ok(fs.existsSync(f), 'UI 镜像缺失: ' + rel);
    return parseTopLevelRules(fs.readFileSync(f, 'utf8'));
}

const num = (v) => v == null ? null : parseFloat(v);

test('★ 卡体缩进：两份镜像最终生效 padding-left 均为 26px，且不被注释/后发覆盖/@media 架空', () => {
    for (const rel of MIRRORS) {
        const rules = loadRules(rel);
        const v = lastDecl(rules, SEL_BODY, 'padding-left');
        assert.ok(v, rel + ' 未解析到卡体 padding-left 生效规则（注释化/塞进 @media 都会在此暴露）');
        assert.equal(num(v), 26, rel + ' 最终生效的卡体左内边距必须是 26px，实得: ' + v);
        assert.match(v, /!important/i, rel + ' 26px 必须带 !important（否则被 code.css:902 的 id 选择器压过）');
    }
});

test('★ 分列：外部正文仍为 10px，卡内 26px 与之相差 16px（不得靠改外部列来"对齐"）', () => {
    for (const rel of MIRRORS) {
        const rules = loadRules(rel);
        const outer = lastDecl(rules, SEL_OUTER, 'padding-left');
        const body = lastDecl(rules, SEL_BODY, 'padding-left');
        // ⑪ 用 padding 简写声明，单独取 padding-left 可能为空，故同时接受简写第二个值
        const outerVal = outer != null ? num(outer) : (() => {
            const p = lastDecl(rules, SEL_OUTER, 'padding');
            if (!p) return null;
            const parts = p.split(/\s+/);
            return parts.length >= 2 ? parseFloat(parts[1]) : parseFloat(parts[0]);
        })();
        assert.equal(outerVal, 10, rel + ' 外部正文基准列必须保持 10px，实得: ' + outerVal);
        assert.equal(num(body) - outerVal, 16, rel + ' 卡内正文必须相对外部正文内收 16px');
    }
});

test('★ 结果摘要：归零自身左内边距的生效规则存在；不再写恒真的字符串护栏', () => {
    for (const rel of MIRRORS) {
        const rules = loadRules(rel);
        const v = lastDecl(rules, SEL_SUMMARY, 'padding-left');
        assert.ok(v, rel + ' 未解析到结果摘要 padding-left 生效规则');
        assert.equal(num(v), 0, rel + ' 结果摘要自身左内边距须归零，实得: ' + v);
    }
});

test('★ 禁止装饰回潮/死规则：基于解析后的声明检查（旧版两条 !includes 恒真，从不触发）', () => {
    for (const rel of MIRRORS) {
        const rules = loadRules(rel);
        // 卡体规则内不得再出现 border-left 引导线（⑯ 已按用户要求抹平智能体卡装饰）
        for (const r of rules) {
            if (r.selector === SEL_BODY) {
                assert.ok(!/(?:^|;)\s*border-left\s*:/i.test(r.body),
                    rel + ' 卡体规则不得补 border-left 引导线（装饰回潮）');
            }
        }
        // 卡内 md 去 padding 是死规则（基线 padding:2px 0，⑪ 只命中气泡直接子级），不得写入
        const dead = lastDecl(rules, SEL_INNER_MD_DEAD, 'padding-left');
        assert.ok(dead == null || !/!important/i.test(dead),
            rel + ' 不得写入卡内 md 去 padding 的死规则');
    }
});

test('★ 两份镜像 app.css 仍严格一致（单侧修复会被同步冲掉）', () => {
    const a = fs.readFileSync(path.join(REPO, MIRRORS[0]), 'utf8');
    const b = fs.readFileSync(path.join(REPO, MIRRORS[1]), 'utf8');
    assert.equal(a, b, '两份 app.css 镜像必须逐字一致');
});

test('★ 解析器自检：能识别注释化、后发覆盖、@media 空转（防止护栏自身退化成字符串断言）', () => {
    const probe = [
        '/* .x { padding-left: 26px !important; } */',
        '.x { padding-left: 26px !important; }',
        '@media (max-width: 1px) { .y { padding-left: 26px !important; } }',
        '.y { padding-left: 10px !important; }',
        '.z { content: "{"; padding-left: 26px !important; }'
    ].join('\n');
    const r = parseTopLevelRules(probe);
    assert.equal(lastDecl(r, '.x', 'padding-left'), '26px !important', '注释里的假规则不得被计入');
    assert.equal(num(lastDecl(r, '.y', 'padding-left')), 10, '@media 内的规则不计，后发 10px 覆盖须胜出');
    assert.equal(num(lastDecl(r, '.z', 'padding-left')), 26, 'content 里的花括号不得破坏分块');
});
