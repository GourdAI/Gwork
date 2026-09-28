/* 孤儿 agent_end 兜底回归：agent_start 被分页裁剪丢弃时，agent_end 到达前端会兜底新建
   一张容器卡；若把 resultSummary 只追加在「已登记容器」分支，这张兜底卡的卡体永远为空，
   被 `.agent-card-body:empty { display: none }` 挡死——「智能体点击展开打不开」的直接成因
   （2026-09-27 浏览器实测量化：点击后 expanded=true 但 body display:none、children=0）。
   本测试锁两条防线：
     1) 共用 helper appendAgentResultSummary 的行为（追加内容 / 无 summary 静默 / 无卡体静默）；
     2) appendAgentBadge 两个调用点的接线（既有卡路径 + 孤儿 end 创建路径）。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MESSAGE_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../main/resources/static/js/app-message.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' source not found');
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(name + ' closing brace not found');
}

/* 目标级 DOM 桩：只实现 helper 用到的 API（$ 工厂 / addClass 链 / [0] 取元素 / appendChild）。
   若 helper 改用其它 jQuery 方法，桩会直接抛错而不是静默返回错误节点。 */
function makeDom() {
  const body = { children: [], appendChild(ch) { this.children.push(ch); } };
  const card = { body };
  const $ = function (sel) {
    if (typeof sel === 'string' && sel.charAt(0) === '<') {
      const el = { tagName: sel.slice(1, -1), className: '', innerHTML: '' };
      const api = {
        0: el,
        addClass(c) { el.className = (el.className ? el.className + ' ' : '') + c; return api; }
      };
      return api;
    }
    if (sel === card) return { find() { return { 0: body }; } };
    return { find() { return { 0: null }; }, 0: null };
  };
  return { $, card, body };
}

function loadHelper(dom, hooks) {
  const src = extractFunction(MESSAGE_SRC, 'appendAgentResultSummary')
    + '\nreturn appendAgentResultSummary;';
  return Function('$', 'renderMd', 'addCodeBlockButtons', 'highlightCodeBlocks', 'processMermaidBlocks', src)(
    dom.$,
    (t) => 'RENDERED:' + t,
    hooks.buttons, hooks.highlight, hooks.mermaid
  );
}

test('helper：有 summary 时把 .agent-result-summary 追加到卡体并走三个增强钩子', () => {
  const dom = makeDom();
  const calls = [];
  const fn = loadHelper(dom, {
    buttons: (el) => calls.push(['buttons', el]),
    highlight: (el) => calls.push(['highlight', el]),
    mermaid: (el) => calls.push(['mermaid', el])
  });

  const ok = fn(dom.card, { args: { resultSummary: '## 报告' } });

  assert.equal(ok, true, '有 summary 必须返回 true');
  assert.equal(dom.body.children.length, 1, '摘要节点必须追加到卡体');
  const node = dom.body.children[0];
  assert.equal(node.className, 'md-content agent-result-summary', '类名口径必须与既有路径一致');
  assert.equal(node.innerHTML, 'RENDERED:## 报告');
  assert.deepEqual(calls.map(c => c[0]), ['buttons', 'highlight', 'mermaid'],
    '三个渲染增强钩子都必须收到摘要节点（漏掉 highlight 会让代码块停在无高亮裸文本）');
});

test('helper：无 summary / 空 body / 空 card 一律静默 false，不得抛错', () => {
  const dom = makeDom();
  const fn = loadHelper(dom, {
    buttons() { throw new Error('不应被调用'); },
    highlight() { throw new Error('不应被调用'); },
    mermaid() { throw new Error('不应被调用'); }
  });
  assert.equal(fn(dom.card, { args: {} }), false);
  assert.equal(fn(dom.card, { args: { resultSummary: '' } }), false);
  assert.equal(fn(dom.card, null), false);
  assert.equal(fn(null, { args: { resultSummary: 'x' } }), false);
  assert.equal(fn({}, { args: { resultSummary: 'x' } }), false, '无 .agent-card-body 的卡必须静默');
  assert.equal(dom.body.children.length, 0, '任何静默分支都不得产生半截节点');
});

test('接线：孤儿 agent_end 创建卡后必须走兜底追加；既有卡路径共用同一 helper', () => {
  const badge = extractFunction(MESSAGE_SRC, 'appendAgentBadge');
  const createAt = badge.indexOf('// 创建容器型智能体卡片');
  const orphanCall = badge.indexOf('appendAgentResultSummary(card, chunk)');
  assert.ok(createAt > 0 && orphanCall > createAt,
    '孤儿 end 兜底必须接在【创建容器型智能体卡片】之后（先有卡体才能落摘要）');
  assert.match(badge, /if\s*\(!isStart\)\s*\{\s*appendAgentResultSummary\(card, chunk\);/,
    '兜底必须在 !isStart 分支内接线');
  assert.ok(badge.indexOf('appendAgentResultSummary(existCard, chunk)') > 0,
    '既有卡路径必须共用 helper，不得保留内联副本（两条路径规则漂移的源头）');
  assert.doesNotMatch(badge, /summaryMd\s*\.\s*innerHTML/,
    '内联追加逻辑必须已迁入 helper，badge 内不得残留第二份实现');
});

test('helper 位于顶层作用域且在 badge 之前定义（勿依赖跨块函数提升的误读）', () => {
  const helperAt = MESSAGE_SRC.indexOf('function appendAgentResultSummary(');
  const badgeAt = MESSAGE_SRC.indexOf('function appendAgentBadge(');
  assert.ok(helperAt > 0, 'helper 必须存在');
  assert.ok(badgeAt > 0, 'appendAgentBadge 必须存在');
  assert.ok(helperAt < badgeAt, 'helper 必须定义在 badge 之前，阅读顺序即执行依赖顺序');
});
