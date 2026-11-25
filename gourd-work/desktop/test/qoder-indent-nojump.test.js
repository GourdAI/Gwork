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
 *  C. 展开内容层级【㉒ 2026-11-25 返工后口径】：层级由【卡体盒子】margin-left 26px
 *     承担（卡内未入批回退态 10px），灰底块内距回基线 14px。
 *     旧口径「灰底块 padding-left 50/34px 只推文字」已废 —— 盒子左缘仍在 0px，
 *     浅底盖住 16px 处的引导线且比标题栏左凸，正是用户二次报障的根因。
 *  D. 防跳动：showThinking / showInlineThinking 必须是 no-op（只清残留、不建 DOM、
 *     不启计时器、不 scrollToBottom）；看门狗（startStreamWatchdog）与停止按钮
 *     （setBtnStopMode）接线不得随指示器一起被删。
 *
 * 权威镜像（desktop / java static）逐字一致由既有契约（process-flat-contract ①）
 * 与本文件 D4 承担；构建产物副本另由 expand-scroll-and-indent D1 校验。
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

test('★ C1 ㉒ 层级由【卡体盒子】右移承担，灰底块内距回基线 14px（旧「只推文字」口径已废）', () => {
    /* 【㉒ 2026-11-25 用户二次报障】旧 C1 锁的是「灰底块 padding-left 50px 让文字与
       标签同列」——那恰恰是缺陷本身：盒子左缘仍在 0px，整块浅底盖住 16px 处的引导线，
       且比所属标题栏向左凸出。用户原话「展开的阴影都把前面线条都遮挡了，缩进都超出
       对应标题栏了」。Qoder 的层级是盒子整体右移一列，不是盒子不动只推文字。
       本条改为锁新口径：卡体 margin-left 承担层级 + 灰底块 padding 回基线。 */
    const outer = cssClean.match(/\.msg-row\.assistant \.msg-bubble \.tool-card \.bash-cmd,[\s\S]{0,900}?\{([^}]*)\}/);
    assert.ok(outer, '展开内容内距规则缺失');
    assert.match(outer[1], /padding-left:\s*14px/, '灰底块内距回基线 14px（层级已由卡体 margin 承担）');
    assert.doesNotMatch(outer[1], /padding-left:\s*(34|50|64)px/, '不得再用 padding 推文字冒充层级缩进');
    /* 层级本体：成员卡体右移 26px（= 成员 header padding-left，盒子左缘对齐图标列） */
    assert.match(cssClean,
        /\.msg-bubble > \.tool-card\[data-turn-batch="1"\]:not\(\.hitl-pending\) > \.tool-card-body[\s\S]{0,600}?\{[^}]*margin-left:\s*26px/,
        '外部成员卡体 margin-left 26px 缺失（层级本体）');
    /* 卡内两档：入批 26px（卡体已有 26 内距）、未入批回退态 10px */
    assert.match(cssClean,
        /\.agent-card-body > \.tool-card\[data-turn-batch="1"\]:not\(\.hitl-pending\) > \.tool-card-body[\s\S]{0,400}?\{[^}]*margin-left:\s*26px/,
        '卡内入批成员卡体 margin-left 26px');
    assert.match(cssClean,
        /\.agent-card-body > \.tool-card:not\(\[data-turn-batch="1"\]\) > \.tool-card-body[\s\S]{0,300}?\{[^}]*margin-left:\s*10px/,
        '卡内未入批回退态卡体 margin-left 10px');
    /* diff/grep 行同口径回基线 */
    assert.match(cssClean, /\.tool-card-body\.is-edit \.git-diff-line \{ padding-left: 14px; \}/);
    assert.match(cssClean, /\.tool-card \.grep-hit \{ padding-left: 28px; \}/);
    /* 反证：旧的「卡内 padding 34/50」例外块必须整体消失，不得与新 margin 叠成双重缩进 */
    assert.doesNotMatch(cssClean, /\.agent-card \.tool-card \.bash-cmd,/,
        '旧卡内 padding 例外块仍在 → 与卡体 margin 双重叠加');
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

test('★ D4 权威镜像同步：app-message/app-streaming/app-turn-display/app.css 逐字一致', () => {
    const ROOT = path.resolve(__dirname, '..', '..', '..');
    /* 【codereview 2026-11-25】原列表里的 `ROOT/gourd-ai-tauri/ui` 是幽灵路径：
       该目录已随「桌面端统一 rust 内核」删除，本仓 tauri 壳位于
       gourdai-java/gourd-ai-tauri，且其 ui/ 被 .gitignore 忽略（构建期由
       cmd/prepare-ui.js 从 static/ 拷贝生成）。故此处只钉唯一权威镜像
       java static；构建产物的同源由 expand-scroll-and-indent D1 四份校验承担。 */
    const mirrors = [
        path.join(ROOT, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static')
    ];
    for (const m of mirrors) {
        for (const f of ['js/app-message.js', 'js/app-streaming.js', 'js/app-turn-display.js', 'css/app.css']) {
            assert.equal(read(path.join(UI, f)), read(path.join(m, f)), m + ' ' + f + ' 漂移');
        }
    }
});
