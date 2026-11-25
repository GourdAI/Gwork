/**
 * 契约测试：Qoder 式层级缩进 + 底部「思考中」指示器退役（2026-11 用户拍板）。
 *
 * 用户原话：
 *  ①「展示信息好乱，按照 Qoder 的这种展示优化，每个层级缩进都一目了然」；
 *  ②「底部的那个思考中啥的看看不要再展示了，不然整个页面总是一跳一跳的」。
 *
 * 钉死的契约：
 *  A. 缩进：批次成员行（data-turn-batch="1"）header 左内距 26px（盖子 chevron 列
 *     10+16），带 !important（压过 ② 的 padding 5px 10px !important 与 code.css
 *     id 选择器）；HITL 待审批卡显式 :not(.hitl-pending) 豁免（审批卡形态不得弱化）。
 *  B. 引导线：画在盖子自身 ::before（零 DOM 插入），高度经 --batch-guide-h 下发；
 *     JS 侧建窗态恒 WINDOW_MAX_PX、收起/一键回退必须清变量（残线防回潮）。
 *  C. 展开内容对齐：灰底块左内距 50px（26+16+8 与成员标签同列）；
 *     智能体卡内未入批行 34px / 入批行 50px（卡体自带 26px 不双重叠加）。
 *  D. 防跳动：showThinking / showInlineThinking 必须是 no-op（只清残留、不建 DOM、
 *     不启计时器、不 scrollToBottom）；看门狗（startStreamWatchdog）与停止按钮
 *     （setBtnStopMode）接线不得随指示器一起被删。
 *
 * 三份镜像（desktop / java static / tauri ui）逐字一致由既有契约
 * （process-flat-contract ①、connector-picker-contract ⑧）承担，本文件只钉形态。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const UI = path.resolve(__dirname, '..', 'ui');
const read = p => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '');

const css = read(path.join(UI, 'css', 'app.css'));
const cssClean = stripComments(css);
const msgJs = read(path.join(UI, 'js', 'app-message.js'));
const msgClean = stripComments(msgJs);
const streamJs = read(path.join(UI, 'js', 'app-streaming.js'));
const displayJs = read(path.join(UI, 'js', 'app-turn-display.js'));

/* 取函数体（首匹配 function name(...) { 到平衡花括号收口，剥注释后解析）。 */
function fnBody(src, name) {
    const clean = stripComments(src);
    const i = clean.indexOf('function ' + name + '(');
    assert.ok(i >= 0, '函数缺失: ' + name);
    const open = clean.indexOf('{', i);
    let d = 1, j = open + 1;
    while (j < clean.length && d > 0) {
        if (clean[j] === '{') d++;
        else if (clean[j] === '}') d--;
        j++;
    }
    return clean.slice(open + 1, j - 1);
}

/* ===== A. 成员行缩进 ===== */

test('★ A1 批次成员 header 左内距 26px !important（工具/思考/并行组成员，主气泡+卡内）', () => {
    const rules = cssClean.match(/[^{}]+\{[^{}]*\}/g) || [];
    const hit = rules.filter(r => {
        const i = r.indexOf('{');
        const sel = r.slice(0, i);
        const body = r.slice(i);
        return /\[data-turn-batch="1"\]/.test(sel)
            && /(tool-card-header|thinking-block-header)/.test(sel)
            && /padding-left:\s*26px\s*!important/.test(body);
    });
    assert.ok(hit.length >= 2, '成员缩进规则缺失（主气泡与卡内/历史展开态都要覆盖）');
    const all = hit.map(r => r.slice(0, r.indexOf('{'))).join('\n');
    assert.match(all, /\.msg-bubble > \.tool-card\[data-turn-batch="1"\]/, '主气泡工具成员');
    assert.match(all, /\.msg-bubble > \.thinking-block\[data-turn-batch="1"\]/, '主气泡思考成员');
    assert.match(all, /\.agent-card-body > \.tool-card\[data-turn-batch="1"\]/, '智能体卡内工具成员');
    assert.match(all, /turn-compact-open > \.tool-batch-group\[data-turn-batch="1"\]/, '历史展开态并行组成员');
});

test('★ A2 HITL 待审批卡豁免：所有成员缩进选择器对 tool-card 都带 :not(.hitl-pending)', () => {
    const rules = cssClean.match(/[^{}]+\{[^{}]*\}/g) || [];
    for (const r of rules) {
        const i = r.indexOf('{');
        const sel = r.slice(0, i);
        const body = r.slice(i);
        if (!/\[data-turn-batch="1"\]/.test(sel)) continue;
        if (!/padding-left:\s*(26px|50px|64px)/.test(body)) continue;
        /* 每个命中 .tool-card[data-turn-batch] 的选择器分支都必须带豁免 */
        for (const branch of sel.split(',')) {
            if (/\.tool-card\[data-turn-batch="1"\]/.test(branch)) {
                assert.match(branch, /:not\(\.hitl-pending\)/,
                    '成员缩进不得命中待审批 HITL 卡: ' + branch.trim());
            }
        }
    }
});

/* ===== B. 引导线（零 DOM 插入 + 残线清理） ===== */

test('★ B1 引导线画在盖子 ::before，高度走 --batch-guide-h，缺省 0 不渲染', () => {
    assert.match(cssClean, /\.turn-batch-header\.turn-batch-open\s*\{\s*position:\s*relative/,
        '展开态盖子必须常驻 position:relative（历史展开批次也要定位参照）');
    const m = cssClean.match(/\.turn-batch-header\.turn-batch-open::before\s*\{([^}]*)\}/);
    assert.ok(m, '引导线 ::before 规则缺失');
    assert.match(m[1], /height:\s*var\(--batch-guide-h,\s*0px\)/, '高度必须由 JS 下发，缺省 0');
    assert.match(m[1], /pointer-events:\s*none/, '引导线不得挡点击');
    assert.match(m[1], /width:\s*1px/, '引导线是 1px 细线（不是卡片竖条）');
});

test('★ B2 JS 接线：建窗态下发 WINDOW_MAX_PX；收起/一键回退清 --batch-guide-h', () => {
    assert.match(displayJs, /function paintBatchGuide\(header\)/, 'paintBatchGuide 必须存在');
    const pg = fnBody(displayJs, 'paintBatchGuide');
    assert.match(pg, /WINDOW_MAX_PX/, '建窗态引导线高 = 窗占位（与 pos 无关）');
    assert.match(pg, /--batch-guide-h/, '经 CSS 变量下发');
    /* 收起路径：applyMembers(!open) 与 refreshWindow(!open) 都要清 */
    const am = fnBody(displayJs, 'applyMembers');
    assert.match(am, /if\s*\(!open\)\s*clearBatchGuide\(header\)/, '收起必须清引导线');
    const cb = fnBody(displayJs, 'clearBatch');
    assert.match(cb, /clearBatchGuide\(/, '一键回退必须清引导线');
    /* 平铺态：refreshWindow 量测段内联下发（清补偿后的纯布局位） */
    assert.match(displayJs, /--batch-guide-h/, '平铺态也要下发高度');
    const rw = fnBody(displayJs, 'refreshWindow');
    assert.match(rw, /guideH/, '平铺分支按末行底-首行顶差分下发');
});

/* ===== C. 展开内容对齐 ===== */

test('★ C1 灰底展开块与成员标签同列：外部 50px、卡内未入批 34px、卡内入批 50px', () => {
    /* 外部（⑲ 主规则）：50px = 成员 header 26 + 图标 16 + gap 8 */
    const outer = cssClean.match(/\.msg-row\.assistant \.msg-bubble \.tool-card \.bash-cmd,[\s\S]{0,900}?\{([^}]*)\}/);
    assert.ok(outer, '⑲ 展开内容对齐规则缺失');
    assert.match(outer[1], /padding-left:\s*50px/, '外部灰底块必须 50px（旧 34px 已随成员缩进过时）');
    /* 卡内例外两档都在 */
    assert.match(cssClean, /\.agent-card \.tool-card \.bash-cmd,[\s\S]{0,900}?padding-left:\s*34px/,
        '卡内未入批行灰底块 34px（卡体 26 + header 10 + 16 + 8 = 60 同列）');
    assert.match(cssClean, /\.agent-card \.tool-card\[data-turn-batch="1"\]:not\(\.hitl-pending\) \.bash-cmd,[\s\S]{0,1200}?padding-left:\s*50px/,
        '卡内入批行灰底块 50px（卡体 26 + header 26 + 16 + 8 = 76 同列）');
    /* diff/grep 行同口径 */
    assert.match(cssClean, /\.tool-card-body\.is-edit \.git-diff-line \{ padding-left: 50px; \}/);
    assert.match(cssClean, /\.tool-card \.grep-hit \{ padding-left: 64px; \}/);
});

/* ===== D. 底部指示器退役（防跳动） ===== */

test('★ D1 showThinking 是 no-op：只清残留，不建 DOM/不启计时器/不滚动', () => {
    const body = fnBody(msgJs, 'showThinking');
    assert.match(body, /removeThinking\(sess\)/, '保留残留清理');
    assert.ok(!/thinking-row/.test(body), '不得再创建 .thinking-row');
    assert.ok(!/startThinkingTimer/.test(body), '不得再启动计时器');
    assert.ok(!/scrollToBottom/.test(body), '不得再触发置底（跳动源）');
    assert.ok(!/innerHTML/.test(body), '不得再写 DOM');
});

test('★ D2 showInlineThinking 是 no-op：不再 ensure/显隐/计时/置底', () => {
    const body = fnBody(msgJs, 'showInlineThinking');
    assert.match(body, /removeInlineThinking\(sess\)/, '保留残留清理');
    assert.ok(!/ensureInlineThinking/.test(body), '不得再创建常驻指示器');
    assert.ok(!/startThinkingTimer/.test(body), '不得再启动计时器');
    assert.ok(!/scrollToBottom/.test(body), '不得再触发置底');
    assert.ok(!/removeClass\('hidden-reserve'\)/.test(body), '不得再显示指示器');
});

/* 【code review 修复 2026-11-24】指示器退役曾漏掉 ensureInlineThinking：函数体
   仍创建 hidden-reserve 占位行（visibility:hidden 仍占高 ~35px），且被
   ensureAssistantBubble 流式分支调用——收尾 purge 整行移除时气泡塌陷，跳动复发。
   钉死：ensure 函数体不得建任何 DOM；流式分支不得再预建占位。 */
test('★ D2b ensureInlineThinking 也是 no-op：不得创建 hidden-reserve 幽灵占位行', () => {
    const body = fnBody(msgJs, 'ensureInlineThinking');
    assert.ok(!/innerHTML/.test(body), '不得再写指示器 DOM（幽灵占位行 = purge 时高度塌陷）');
    assert.ok(!/hidden-reserve/.test(body), '不得再创建 visibility:hidden 占位（仍占高）');
    assert.ok(!/inlineThinkingEl\s*=\s*el/.test(body), '不得再登记指示器元素');
    /* 流式分支只藏操作按钮，不再预建占位 */
    assert.ok(!/ensureInlineThinking\(sess\);/.test(msgClean),
        '任何调用点都不得再触发指示器创建（showInlineThinking 只清残留）');
});

test('★ D3 运行反馈三层保留：停止按钮 / 看门狗 / 批次盖子计时不得连坐删除', () => {
    assert.match(stripComments(streamJs), /setBtnStopMode\(\)/, '停止按钮接线保留');
    assert.match(stripComments(streamJs), /startStreamWatchdog\(\)/, '看门狗启动保留');
    assert.match(displayJs, /chat\.batch_running/, '批次盖子「正在执行中」文案保留');
    /* removeThinking / purgeInlineThinking 清理函数必须保留（各收尾路径仍调用） */
    assert.match(msgClean, /function removeThinking\(sess\)/);
    assert.match(msgClean, /function purgeInlineThinking\(sess\)/);
});

test('★ D4 双镜像 + tauri 壳同步：app-message/app-streaming/app-turn-display 逐字一致', () => {
    const ROOT = path.resolve(__dirname, '..', '..', '..');
    const mirrors = [
        path.join(ROOT, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static'),
        path.join(ROOT, 'gourd-ai-tauri', 'ui')
    ];
    for (const m of mirrors) {
        for (const f of ['js/app-message.js', 'js/app-streaming.js', 'js/app-turn-display.js', 'css/app.css']) {
            assert.equal(read(path.join(UI, f)), read(path.join(m, f)), m + ' ' + f + ' 漂移');
        }
    }
});
