/**
 * 契约测试：ask_user 问答卡「整卡折叠钮」的箭头方向（用户 2026-11 报障「缩放箭头反了」）。
 *
 * ── 判定依据 ────────────────────────────────────────────────────────────────
 * 折叠钮是纯图标（无文字），箭头表示【当前状态】，不是点击动作：
 *   展开态 ∨ 朝下（内容在头部下方铺开）、折叠态 ∧ 朝上（内容收进头部）。
 * 本仓其它折叠控件一律如此：.ws-group-caret / .proj-chevron / .model-group-arrow /
 * .filer-arrow 都是 expanded=true 时朝下，.turn-batch-chevron 的注释更明写
 * 「收起态指向右（展开态向下），与 Qoder 一致」。
 * 旧实现 `collapsed ? EXPAND : COLLAPSE` 按【下一步动作】取图，展开着的卡片反而
 * 显示 ∧，与整仓契约相反 —— 这就是用户看到的「反了」。
 *
 * tooltip（question_collapse / question_expand）按动作取文案是对的，detail 的
 * 「展开/收起」文字按钮配可旋转 chevron 也是动作型，二者均不在本次修正范围内，
 * 勿为了「看起来统一」把整卡钮改回动作型。
 *
 * ── 为什么只无条件锁「两份入库源」──────────────────────────────────────────
 * 同一份 app-message.js 的两份【入库源】是 gourd-work/desktop（Rust 桌面端）与
 * gourdai-java/gourd-ai-agent/.../static（Java 端），历史上多次出现只改一处漂移。
 * 根级 gourd-ai-tauri/ui/ 是被 .gitignore（/gourd-ai-tauri/）整体忽略、不入库的
 * 构建期拷贝残骸：CI（build-gourd-work.yml: node --test test/*.test.js）干净检出时
 * 该目录不存在。若主用例无条件 readFileSync 它，CI 必然 ENOENT 假红（本地因恰有
 * 残骸而全绿，掩盖了这一点）。故第三份放进独立 skip 子测试：仅当本地确实存在该
 * 残骸时顺带核对，不让它决定 CI 红绿（同 steer-note-collapse.test.js 的成熟做法）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..', '..', '..');
// 两份入库源：CI 干净检出必定存在，无条件强校验。
const sources = [
    'gourd-work/desktop/ui/js/app-message.js',
    'gourdai-java/gourd-ai-agent/src/main/resources/static/js/app-message.js'
];
// 构建期产物（gitignore 忽略、不入库）：仅本地存在时才顺带核对。
const tauriMirror = 'gourd-ai-tauri/ui/js/app-message.js';

function assertArrowContract(rel) {
    const src = fs.readFileSync(path.join(repo, rel), 'utf8').replace(/^\uFEFF/, '');
    assert.match(src, /var collapseSvg = collapsed \? QUESTION_CARD_SVG_COLLAPSE : QUESTION_CARD_SVG_EXPAND;/,
        rel + '：折叠钮必须按状态取箭头（展开态 EXPAND、折叠态 COLLAPSE）');

    const collapse = (src.match(/var QUESTION_CARD_SVG_COLLAPSE = '([^']*)'/) || [])[1] || '';
    const expand = (src.match(/var QUESTION_CARD_SVG_EXPAND = '([^']*)'/) || [])[1] || '';
    assert.match(collapse, /points="18 15 12 9 6 15"/, rel + '：COLLAPSE 须为上尖角 ∧（SVG y 轴向下）');
    assert.match(expand, /points="6 9 12 15 18 9"/, rel + '：EXPAND 须为下尖角 ∨');

    // tooltip 仍按动作取文案，不受箭头方向修正影响
    assert.match(src, /var collapseTitle = collapsed \? GourdI18n\.t\('chat\.question_expand'\) : GourdI18n\.t\('chat\.question_collapse'\);/,
        rel + '：tooltip 须保持按动作取文案');
}

test('ask 卡片折叠箭头：两份入库源均为「展开态 ∨ / 折叠态 ∧」的状态型映射', () => {
    for (const rel of sources) assertArrowContract(rel);
});

const mirrorPath = path.join(repo, tauriMirror);
const mirrorSkip = fs.existsSync(mirrorPath)
    ? false
    : '构建期产物 gourd-ai-tauri/ui 不存在（被 .gitignore 忽略、CI 干净检出无副本）';
test('ask 卡片折叠箭头：gourd-ai-tauri/ui 构建残骸（若存在）亦保持同映射', { skip: mirrorSkip }, () => {
    assertArrowContract(tauriMirror);
});

test('ask 卡片折叠箭头：真实 renderQuestionCard 两态产物使用正确箭头', () => {
    const src = fs.readFileSync(path.join(repo, sources[0]), 'utf8').replace(/^\uFEFF/, '');
    const start = src.indexOf('function renderQuestionCard(host, sess, state) {');
    assert.ok(start >= 0, 'renderQuestionCard 定义丢失');
    const end = src.indexOf('/* 焦点元素的稳定标识', start);
    assert.ok(end > start, 'renderQuestionCard 结束标记丢失');
    const renderFn = src.slice(start, end);

    const stubs = [
        'var escapeAttr = function(s){ return String(s==null?"":s).replace(/"/g, "&quot;"); };',
        'var escapeHtml = function(s){ return String(s==null?"":s); };',
        'var GourdI18n = { t: function(k){ return k; } };',
        'var questionAnswerFor = function(st,i){ return (st&&st.answers&&st.answers[i])||null; };',
        'var questionOptionSelected = function(){ return false; };',
        'var questionOptionView = function(o){ o=o||{}; return {label:o.label||"",title:o.label||"",desc:o.description||""}; };',
        'var questionDetailShouldCollapse = function(){ return false; };',
        'var questionSubmitMode = function(){ return "skip"; };',
        'var currentInputBoxText = function(){ return ""; };',
        'var QUESTION_SUBMIT_MODE_KEYS = {skip:"chat.question_skip",next:"chat.question_next",submit:"chat.question_submit"};',
        // 两支箭头给可区分标记，直接看渲染产物用哪一支
        'var QUESTION_CARD_SVG_PREV="<svg></svg>", QUESTION_CARD_SVG_NEXT="<svg></svg>", QUESTION_CARD_SVG_CLOSE="<svg></svg>", QUESTION_CARD_SVG_COLLAPSE="<svg data-arrow=up></svg>", QUESTION_CARD_SVG_EXPAND="<svg data-arrow=down></svg>", QUESTION_CARD_SVG_EDIT="<svg></svg>", QUESTION_CARD_SVG_CHEVRON="<svg></svg>";',
        'var questionCardFocusKeyIn = function(){ return ""; };',
        'var questionCardCaretIn = function(){ return null; };',
        'var questionCardScrollSnapshot = function(){ return null; };',
        'var questionCardRestoreView = function(){};',
        'var $ = function(){ return { hide:function(){}, show:function(){} }; };'
    ].join('\n');
    const renderQuestionCard = new Function(stubs + '\n' + renderFn + '\nreturn renderQuestionCard;')();

    const mkHost = () => ({ innerHTML: '', querySelector: () => null, querySelectorAll: () => [] });
    const mkState = () => ({ actionId: 'a', questions: [{ header: 'Q', detail: '', options: [{ label: 'o1' }] }], answers: {}, drafts: {}, detailOpen: {}, current: 0, submitted: false, collapsed: false });

    let host = mkHost();
    renderQuestionCard(host, {}, mkState());
    assert.match(host.innerHTML, /aria-expanded="true"/, '展开态 aria-expanded 须为 true');
    assert.match(host.innerHTML, /data-arrow=down/, '展开态箭头必须朝下 ∨');
    assert.doesNotMatch(host.innerHTML, /data-arrow=up/, '展开态不得出现上尖角');

    host = mkHost();
    const collapsed = mkState();
    collapsed.collapsed = true;
    renderQuestionCard(host, {}, collapsed);
    assert.match(host.innerHTML, /aria-expanded="false"/, '折叠态 aria-expanded 须为 false');
    assert.match(host.innerHTML, /data-arrow=up/, '折叠态箭头必须朝上 ∧');
    assert.doesNotMatch(host.innerHTML, /data-arrow=down/, '折叠态不得出现下尖角');
});
