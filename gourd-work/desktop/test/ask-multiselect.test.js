/**
 * 契约测试：ask_user 问答卡 multiSelect（契约 PLAN-ask-summary-contract.md §5.1/§5.2）。
 *
 * ── 契约要点 ────────────────────────────────────────────────────────────────
 * ① normalizeQuestionArgs 收下 questions[].multiSelect（!! 收敛，默认 false，旧帧兼容）；
 * ② 多选题勾选为数组累积（checkbox 语义，再点已选项取消该项），单选题保持互斥现状；
 * ③ 提交 payload：多选题 answers 元素在冻结四键 {index,text,skipped,custom} 之上追加
 *    可选 texts:[label,...]；text 为选中 label 以「、」连接；旧内核只读 text 仍可用；
 * ④ 自由输入（custom/supplement）在多选题作为【附加项】追加进 texts 与 text，
 *    不得顶掉已勾选集合（与单选「（补充：…）」注解形态刻意不同）；
 * ⑤ qa-record 作答记录多选展示「label1、label2」。
 *
 * ── 手法（沿用 ask-card-collapse-arrow / hitl-suspend-boundary 的提取执行惯例）──
 * 状态机区块带注释「行为测试整段提取执行，区块内不得引用 DOM/全局」：从【两份入库源】
 * 各自切出该区块装进 node:vm 真跑（不造 DOM 桩），双源参数化断言保证 Rust 桌面端与
 * Java Web 端镜像一致；渲染层用与 ask-card-collapse-arrow.test.js 相同的最小 stub 集
 * 提取 renderQuestionCard 断言 checkbox 语义产物。B 侧无独立 js 测试基础设施
 * （gourdai-java 下无 static 测试脚本），故镜像校验由本文件的双源参数化承担。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.resolve(__dirname, '..', '..', '..');
// 两份入库源：CI 干净检出必定存在，无条件强校验（同 ask-card-collapse-arrow.test.js）。
const SOURCES = [
    ['Rust桌面端', 'gourd-work/desktop/ui/js/app-message.js'],
    ['JavaWeb端', 'gourdai-java/gourd-ai-agent/src/main/resources/static/js/app-message.js']
];

const BLOCK_START = '/* ---- 问答卡状态机（纯函数；行为测试整段提取执行，区块内不得引用 DOM/全局） ---- */';
const BLOCK_END = '/* ---- 问答卡 DOM 渲染 ---- */';

/* 整段提取纯函数区块并装进 vm。区块纪律：不得引用 DOM/全局——若有人往区块里
   塞了 document/window 引用，这里加载即抛，测试直接红。 */
function loadStateMachine(rel) {
    const src = fs.readFileSync(path.join(repo, rel), 'utf8').replace(/^\uFEFF/, '');
    const start = src.indexOf(BLOCK_START);
    assert.ok(start >= 0, rel + '：状态机区块起始注释丢失');
    const end = src.indexOf(BLOCK_END, start);
    assert.ok(end > start, rel + '：状态机区块结束注释丢失');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(src.slice(start, end), sandbox, { filename: rel });
    /* vm 跨 realm 陷阱：沙箱内创建的数组/对象原型链属于另一 realm，主 realm 的
       assert.deepEqual 严格比对原型会假红。统一经 JSON 往返归一到主 realm 再断言
       （状态机数据全部可 JSON 化，无信息损失）。 */
    const norm = function(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); };
    return { api: sandbox, norm: norm };
}

function mkMultiState(env, opts) {
    const questions = env.api.normalizeQuestionArgs({
        questions: [{
            header: '选择要启用的能力',
            multiSelect: true,
            options: (opts || ['甲', '乙', '丙']).map(function(l) { return { label: l }; })
        }]
    });
    return env.api.createQuestionCardState('act-multi', questions);
}

function mkSingleState(env) {
    const questions = env.api.normalizeQuestionArgs({
        questions: [{ header: '单选', options: [{ label: 'A' }, { label: 'B' }] }]
    });
    return env.api.createQuestionCardState('act-single', questions);
}

for (const [name, rel] of SOURCES) {
    test(`[${name}] normalizeQuestionArgs：multiSelect 以 !! 收敛，默认 false（旧帧兼容）`, () => {
        const api = loadStateMachine(rel).api;
        const qs = api.normalizeQuestionArgs({ questions: [
            { header: 'q1', multiSelect: true, options: [{ label: 'x' }] },
            { header: 'q2', options: [{ label: 'y' }] },
            { header: 'q3', multiSelect: 'yes' },
            { header: 'q4', multiSelect: 0 }
        ] });
        assert.equal(qs[0].multiSelect, true);
        assert.equal(qs[1].multiSelect, false, '缺字段必须默认 false');
        assert.equal(qs[2].multiSelect, true, 'truthy 收敛为 true');
        assert.equal(qs[3].multiSelect, false);
    });

    test(`[${name}] 多选勾选：数组累积、再点取消、不推进光标、顺序保持点选序`, () => {
        const env = loadStateMachine(rel);
        const api = env.api;
        const st = mkMultiState(env);
        api.applyQuestionOptionAnswer(st, 0, '乙');
        assert.deepEqual(env.norm(api.questionSelectedLabels(st, 0)), ['乙']);
        assert.equal(st.current, 0, '多选不推进光标：攒够再走，翻页由底部按钮承担');
        api.applyQuestionOptionAnswer(st, 0, '甲');
        assert.deepEqual(env.norm(api.questionSelectedLabels(st, 0)), ['乙', '甲'], '按点选顺序累积');
        assert.equal(api.questionOptionSelected(st, 0, '甲'), true);
        assert.equal(api.questionOptionSelected(st, 0, '乙'), true);
        assert.equal(api.questionOptionSelected(st, 0, '丙'), false);
        const a = api.questionAnswerFor(st, 0);
        assert.equal(a.text, '乙、甲', 'text 为选中 label 以「、」连接');
        assert.deepEqual(env.norm(a.texts), ['乙', '甲']);
        api.applyQuestionOptionAnswer(st, 0, '乙');   // 再点已选项 = 取消该项
        assert.deepEqual(env.norm(api.questionSelectedLabels(st, 0)), ['甲']);
        api.applyQuestionOptionAnswer(st, 0, '甲');   // 最后一项也取消
        assert.equal(api.questionAnswerFor(st, 0), null, '集合清空且无自由输入 → 回到未作答态');
        assert.equal(api.questionSubmitMode(st, ''), 'skip');
    });

    test(`[${name}] 单选回归：互斥改选、再点取消、点选推进光标（现状不得被多选改造挤掉）`, () => {
        const api = loadStateMachine(rel).api;
        const questions = api.normalizeQuestionArgs({
            questions: [
                { header: 'q1', options: [{ label: 'A' }, { label: 'B' }] },
                { header: 'q2', options: [{ label: 'C' }] }
            ]
        });
        const st = api.createQuestionCardState('act', questions);
        api.applyQuestionOptionAnswer(st, 0, 'A');
        assert.equal(st.current, 1, '单选点完即答完，推进下一题');
        st.current = 0;
        api.applyQuestionOptionAnswer(st, 0, 'B');
        const a = api.questionAnswerFor(st, 0);
        assert.equal(a.selectedLabel, 'B', '单选互斥：改选顶掉旧项');
        assert.equal(a.text, 'B');
        assert.equal(a.texts, undefined, '单选答案不带 texts（协议零改动）');
        st.current = 0;
        api.applyQuestionOptionAnswer(st, 0, 'B');   // 再点已选项 = 整条撤回
        assert.equal(api.questionAnswerFor(st, 0), null);
        const payload = api.buildQuestionAnswersPayload(st).answers;
        assert.deepEqual(Object.keys(payload[0]).sort(), ['custom', 'index', 'skipped', 'text'],
            '单选出站仍严格四键');
    });

    test(`[${name}] 自由输入并存：先勾选后补充 / 先补充后勾选，附加项不顶掉勾选集合`, () => {
        const env = loadStateMachine(rel);
        const api = env.api;
        const st = mkMultiState(env);
        api.applyQuestionOptionAnswer(st, 0, '甲');
        api.applyQuestionOptionAnswer(st, 0, '乙');
        api.applyQuestionCustomAnswer(st, 0, '再加一句');   // 已有勾选 → 转附加项
        const a = api.questionAnswerFor(st, 0);
        assert.deepEqual(env.norm(api.questionSelectedLabels(st, 0)), ['甲', '乙'], '勾选集合不得被自由输入顶掉');
        assert.equal(a.text, '甲、乙、再加一句');
        assert.deepEqual(env.norm(a.texts), ['甲', '乙', '再加一句']);
        assert.equal(a.custom, false, '有勾选时自由输入是附加项，不是纯自定义');
        // 清空附加项：只撤自由输入，勾选保留
        api.applyQuestionSupplement(st, 0, '');
        const b = api.questionAnswerFor(st, 0);
        assert.equal(b.text, '甲、乙');
        assert.deepEqual(env.norm(b.texts), ['甲', '乙']);
        // 反向次序：先写自由输入再勾选
        const st2 = mkMultiState(env);
        api.applyQuestionCustomAnswer(st2, 0, '先说一句');
        assert.equal(api.questionAnswerFor(st2, 0).custom, true, '无勾选时纯手写 = 自定义');
        assert.deepEqual(env.norm(api.questionAnswerFor(st2, 0).texts), ['先说一句'], '纯自定义也带单元素 texts');
        api.applyQuestionOptionAnswer(st2, 0, '丙');
        const c = api.questionAnswerFor(st2, 0);
        assert.equal(c.text, '丙、先说一句', '自由输入作为附加项保留在串尾');
        assert.deepEqual(env.norm(c.texts), ['丙', '先说一句']);
        assert.equal(c.custom, false);
        // 撤掉全部勾选：自由输入降级为纯自定义答案（与单选 unselect 同构，不丢字）
        api.applyQuestionOptionAnswer(st2, 0, '丙');
        const d = api.questionAnswerFor(st2, 0);
        assert.equal(d.custom, true);
        assert.equal(d.text, '先说一句');
    });

    test(`[${name}] F4：已跳过的多选题不被点选静默复活（与 unselect 同纪律）`, () => {
        const env = loadStateMachine(rel);
        const api = env.api;
        const st = mkMultiState(env);
        api.skipQuestionAnswer(st);
        assert.equal(api.questionAnswerFor(st, 0).skipped, true);
        api.applyQuestionOptionAnswer(st, 0, '甲');   // 点选项不得复活 skipped
        const a = api.questionAnswerFor(st, 0);
        assert.equal(a.skipped, true, 'skipped 标记不得被点选无提示改写');
        assert.deepEqual(env.norm(api.questionSelectedLabels(st, 0)), [], '不得产生勾选');
        // 单选题既有语义保持：明确点另一选项 = 改答（可覆盖 skipped，现状不回归）
        const single = mkSingleState(env);
        api.skipQuestionAnswer(single);
        api.applyQuestionOptionAnswer(single, 0, 'A');
        assert.equal(api.questionAnswerFor(single, 0).skipped, false, '单选改选覆盖语义保持不变');
    });

    test(`[${name}] F5：多选纯自由输入 Enter 不推进光标（攒够再走）；单选照常推进`, () => {
        const env = loadStateMachine(rel);
        const api = env.api;
        const qs = api.normalizeQuestionArgs({ questions: [
            { header: 'm1', multiSelect: true, options: [{ label: '甲' }] },
            { header: 'm2', multiSelect: true, options: [{ label: '乙' }] }
        ] });
        const st = api.createQuestionCardState('act-f5', qs);
        api.applyQuestionCustomAnswer(st, 0, '先打字后勾选');
        assert.equal(st.current, 0, '多选题纯手写 Enter 不得翻页（否则用户得翻回来继续勾）');
        assert.deepEqual(env.norm(api.questionAnswerFor(st, 0).texts), ['先打字后勾选']);
        // 单选对照：点完即答完，推进语义不变
        const single = mkSingleState(env);
        api.applyQuestionCustomAnswer(single, 0, '自定义回答');
        assert.equal(single.current, 0, '单题场景无下一题可推进（环绕回自身）');
        const qs2 = api.normalizeQuestionArgs({ questions: [
            { header: 's1', options: [{ label: 'A' }] },
            { header: 's2', options: [{ label: 'B' }] }
        ] });
        const st2 = api.createQuestionCardState('act-f5b', qs2);
        api.applyQuestionCustomAnswer(st2, 0, '手写');
        assert.equal(st2.current, 1, '单选题 Enter 照常推进下一题');
    });

    test(`[${name}] 提交 payload：多选带 texts、跳过不带、旧状态缺 texts 回退拆 text`, () => {
        const env = loadStateMachine(rel);
        const api = env.api;
        const questions = api.normalizeQuestionArgs({ questions: [
            { header: '多选', multiSelect: true, options: [{ label: '甲' }, { label: '乙' }] },
            { header: '单选', options: [{ label: 'A' }] },
            { header: '多选跳过', multiSelect: true, options: [{ label: '丙' }] }
        ] });
        const st = api.createQuestionCardState('act', questions);
        api.applyQuestionOptionAnswer(st, 0, '甲');
        api.applyQuestionOptionAnswer(st, 0, '乙');
        api.applyQuestionSupplement(st, 0, '补充项');
        api.applyQuestionOptionAnswer(st, 1, 'A');
        api.fillUnansweredAsSkipped(st);
        const payload = env.norm(api.buildQuestionAnswersPayload(st).answers);
        assert.equal(payload[0].text, '甲、乙、补充项');
        assert.deepEqual(payload[0].texts, ['甲', '乙', '补充项']);
        assert.equal(payload[0].skipped, false);
        assert.equal(payload[0].custom, false);
        assert.equal(payload[1].texts, undefined, '单选协议零改动');
        assert.equal(payload[2].skipped, true);
        assert.equal(payload[2].texts, undefined, '跳过的多选不带 texts');
        assert.deepEqual(Object.keys(payload[2]).sort(), ['custom', 'index', 'skipped', 'text']);
        // 旧状态兼容：answers 只有 text（无本地 texts 语义位）→ 按「、」拆
        const legacy = api.createQuestionCardState('act-old', questions);
        legacy.answers[0] = { index: 0, text: '甲、乙', skipped: false, custom: false };
        const lp = env.norm(api.buildQuestionAnswersPayload(legacy).answers);
        assert.deepEqual(lp[0].texts, ['甲', '乙']);
    });

    test(`[${name}] 翻页/跳过/草稿兼容：drafts 存自由输入草稿，多选题照常收割与跳过`, () => {
        const env = loadStateMachine(rel);
        const api = env.api;
        const st = mkMultiState(env);
        st.drafts[0] = '打了字没回车';
        assert.equal(api.questionHasPendingInput(st, ''), true, '草稿让按钮离开 skip 态');
        assert.equal(api.questionSubmitMode(st, ''), 'submit', '单题场景收割后可直接提交');
        api.applyQuestionSupplement(st, 0, st.drafts[0]);   // 收割路径（harvest 的纯函数内核）
        assert.deepEqual(env.norm(api.questionAnswerFor(st, 0).texts), ['打了字没回车']);
        // 跳过语义不受多选影响
        const st2 = mkMultiState(env);
        api.skipQuestionAnswer(st2);
        assert.equal(api.questionAnswerFor(st2, 0).skipped, true);
        assert.equal(api.questionSubmitMode(st2, ''), 'submit');
        // 多选翻页游标：nextUnansweredQuestionIndex 环绕找待办题
        const qs = api.normalizeQuestionArgs({ questions: [
            { header: 'm1', multiSelect: true, options: [{ label: 'x' }] },
            { header: 'm2', multiSelect: true, options: [{ label: 'y' }] }
        ] });
        const st3 = api.createQuestionCardState('act3', qs);
        api.applyQuestionOptionAnswer(st3, 0, 'x');
        assert.equal(st3.current, 0);
        assert.equal(api.nextUnansweredQuestionIndex(st3, 0), 1);
        st3.current = 1;
        api.applyQuestionOptionAnswer(st3, 1, 'y');
        assert.equal(api.questionIsAllAnswered(st3), true);
        assert.equal(api.questionSubmitMode(st3, ''), 'submit');
    });

    test(`[${name}] qa-record：多选展示「label1、label2」，长 label 反查短标题，自由输入原样保留`, () => {
        const api = loadStateMachine(rel).api;
        const q = api.normalizeQuestionArgs({ questions: [{
            header: 'h', multiSelect: true,
            options: [{ label: '方案甲：解释一段' }, { label: '乙' }]
        }] })[0];
        const rec = api.formatQuestionAnswerForRecord(q, {
            index: 0, text: '方案甲：解释一段、乙、手写项',
            texts: ['方案甲：解释一段', '乙', '手写项'], skipped: false, custom: false
        });
        assert.equal(rec.skipped, false);
        assert.equal(rec.title, '方案甲、乙、手写项', '选项反查短标题 + 附加项原样，以「、」连接');
        assert.equal(rec.custom, false);
        // 无 texts 的旧帧：回退拆 text
        const rec2 = api.formatQuestionAnswerForRecord(q, { index: 0, text: '乙、手写项', skipped: false, custom: false });
        assert.equal(rec2.title, '乙、手写项');
        // 跳过态不受多选分支影响
        const rec3 = api.formatQuestionAnswerForRecord(q, { index: 0, text: '', skipped: true, custom: false });
        assert.equal(rec3.skipped, true);
        // 单选记录回归：仍是「短标题 +（补充：…）」拆解
        const sq = api.normalizeQuestionArgs({ questions: [{ header: 'h', options: [{ label: '方案A：说明' }] }] })[0];
        const rec4 = api.formatQuestionAnswerForRecord(sq, { index: 0, text: '方案A：说明（补充：一句）', skipped: false, custom: false });
        assert.equal(rec4.title, '方案A');
        assert.equal(rec4.supplement, '一句');
    });
}

/* ── 渲染层：checkbox 语义（提取 renderQuestionCard + 最小 stub，同折叠箭头测试手法）── */

function extractRenderFn(rel) {
    const src = fs.readFileSync(path.join(repo, rel), 'utf8').replace(/^\uFEFF/, '');
    const start = src.indexOf('function renderQuestionCard(host, sess, state) {');
    assert.ok(start >= 0, rel + '：renderQuestionCard 定义丢失');
    const end = src.indexOf('/* 焦点元素的稳定标识', start);
    assert.ok(end > start, rel + '：renderQuestionCard 结束标记丢失');
    return src.slice(start, end);
}

function buildRenderer(rel, api) {
    const stubs = [
        'var escapeAttr = function(s){ return String(s==null?"":s).replace(/"/g, "&quot;"); };',
        'var escapeHtml = function(s){ return String(s==null?"":s); };',
        'var GourdI18n = { t: function(k){ return k; } };',
        // 判定/整形函数直接用同源码提取的真实现，渲染断言与状态机行为同源
        'var questionAnswerFor = ' + api.questionAnswerFor.toString() + ';',
        'var questionIsMultiSelect = ' + api.questionIsMultiSelect.toString() + ';',
        'var questionSelectedLabels = ' + api.questionSelectedLabels.toString() + ';',
        'var questionOptionSelected = ' + api.questionOptionSelected.toString() + ';',
        'var questionOptionView = function(o){ o=o||{}; return {label:o.label||"",title:o.label||"",desc:o.description||""}; };',
        'var questionDetailShouldCollapse = function(){ return false; };',
        'var questionSubmitMode = function(){ return "skip"; };',
        'var currentInputBoxText = function(){ return ""; };',
        'var QUESTION_SUBMIT_MODE_KEYS = {skip:"chat.question_skip",next:"chat.question_next",submit:"chat.question_submit"};',
        'var QUESTION_CARD_SVG_PREV="<svg></svg>", QUESTION_CARD_SVG_NEXT="<svg></svg>", QUESTION_CARD_SVG_CLOSE="<svg></svg>", QUESTION_CARD_SVG_COLLAPSE="<svg></svg>", QUESTION_CARD_SVG_EXPAND="<svg></svg>", QUESTION_CARD_SVG_EDIT="<svg></svg>", QUESTION_CARD_SVG_CHEVRON="<svg></svg>";',
        'var questionCardFocusKeyIn = function(){ return ""; };',
        'var questionCardCaretIn = function(){ return null; };',
        'var questionCardScrollSnapshot = function(){ return null; };',
        'var questionCardRestoreView = function(){};',
        'var $ = function(){ return { hide:function(){}, show:function(){} }; };'
    ].join('\n');
    return new Function(stubs + '\n' + extractRenderFn(rel) + '\nreturn renderQuestionCard;')();
}

for (const [name, rel] of SOURCES) {
    test(`[${name}] 渲染：多选题 checkbox 语义 + 「可多选」提示；单选题保持 aria-pressed`, () => {
        const env = loadStateMachine(rel);
        const api = env.api;
        const render = buildRenderer(rel, api);
        const mkHost = () => ({ innerHTML: '', querySelector: () => null, querySelectorAll: () => [] });

        const st = mkMultiState(env);
        api.applyQuestionOptionAnswer(st, 0, '甲');
        let host = mkHost();
        render(host, {}, st);
        assert.match(host.innerHTML, /question-card-multi-tag/, '多选题必须挂「可多选」提示胶囊');
        assert.match(host.innerHTML, /chat\.question_multi_hint/, '提示文案必须走 GourdI18n.t');
        assert.match(host.innerHTML, /question-card-option multi/, '多选选项须带 multi 修饰类');
        assert.match(host.innerHTML, /role="checkbox"/, '多选选项须为 checkbox 语义');
        assert.match(host.innerHTML, /aria-checked="true"/, '已勾选项 aria-checked=true');
        assert.match(host.innerHTML, /aria-checked="false"/, '未勾选项 aria-checked=false');
        assert.doesNotMatch(host.innerHTML, /aria-pressed/, '多选选项不得再用单选 aria-pressed');

        const single = mkSingleState(env);
        host = mkHost();
        render(host, {}, single);
        assert.match(host.innerHTML, /aria-pressed="false"/, '单选保持现状 aria-pressed');
        assert.doesNotMatch(host.innerHTML, /role="checkbox"/, '单选不得挂 checkbox 语义');
        assert.doesNotMatch(host.innerHTML, /question-card-multi-tag/, '单选不得挂多选提示');
        assert.doesNotMatch(host.innerHTML, /question-card-option multi/, '单选不得带 multi 修饰类');
    });
}

/* ── 镜像一致性：两份入库源的状态机区块必须逐字一致（B 侧无 js 测试设施，由此承担镜像校验）── */

test('两份入库源的问答卡状态机区块逐字一致（含 multiSelect 改造）', () => {
    const blocks = SOURCES.map(([, rel]) => {
        const src = fs.readFileSync(path.join(repo, rel), 'utf8').replace(/^\uFEFF/, '');
        const start = src.indexOf(BLOCK_START);
        const end = src.indexOf(BLOCK_END, start);
        assert.ok(start >= 0 && end > start, rel + '：区块标记丢失');
        return src.slice(start, end).replace(/\r\n/g, '\n');
    });
    assert.equal(blocks[0], blocks[1],
        'Rust 桌面端与 Java Web 端的状态机区块发生漂移——纯函数区块必须双份镜像逐字一致');
});