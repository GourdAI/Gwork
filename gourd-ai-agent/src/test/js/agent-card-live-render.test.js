/* 子智能体卡片「状态点在闪、内部不再加载消息」回归测试。
   覆盖两个独立成因：
     A) resetStreamState 全量清空 agentStates/agentCards，使后续帧失去归属、agent_end 收不掉卡；
     B) 卡体滚动跟随被自身置底/内容增长误判为「用户上翻」而永久自锁，视口定格。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MESSAGE_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../main/resources/static/js/app-message.js'), 'utf8');
const BASE_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../main/resources/static/js/app-base.js'), 'utf8');

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

/* ===== 缺陷 A：活跃子代理不得被主线路重置误清 ===== */

// clearAgentState 依赖 document.contains / stopThinkingTimer，用最小替身注入。
function loadClearAgentState(liveCards, stoppedTimers) {
  const src = extractFunction(MESSAGE_SRC, 'isAgentStateAlive')
    + '\n' + extractFunction(MESSAGE_SRC, 'clearAgentState')
    + '\nreturn { clearAgentState: clearAgentState, isAgentStateAlive: isAgentStateAlive };';
  return Function('document', 'stopThinkingTimer', src)(
    { contains: (el) => liveCards.has(el) },
    (st) => { if (stoppedTimers) stoppedTimers.push(st && st.id); }
  );
}

function makeState(id, card) {
  return { id, card, bodyEl: {}, currentBubbleEl: null, thinkingBodyMdEl: null };
}

test('A: keepActive 保留仍在文档中的活跃子代理（状态与卡片同时存活）', () => {
  const cardA = { tag: 'A' };
  const live = new Set([cardA]);
  const { clearAgentState } = loadClearAgentState(live);
  const stA = makeState('inv-a', cardA);
  const sess = { agentStates: { 'inv-a': stA }, agentCards: { 'inv-a': cardA }, _agentStateLast: stA };

  clearAgentState(sess, null, { keepActive: true });

  assert.equal(sess.agentStates['inv-a'], stA, '活跃子代理状态被误清 → 后续帧将失去归属');
  assert.equal(sess.agentCards['inv-a'], cardA, 'agentCards 被误清 → agent_end 收不掉卡，状态点永久闪烁');
  assert.equal(sess._agentStateLast, stA);
});

test('A: keepActive 仍清理已离开文档的陈旧子代理（不泄漏 DOM 强引用）', () => {
  const stale = { tag: 'stale' };
  const { clearAgentState } = loadClearAgentState(new Set()); // 全都不在文档里
  const sess = {
    agentStates: { 'inv-stale': makeState('inv-stale', stale) },
    agentCards: { 'inv-stale': stale },
    _agentStateLast: null
  };

  clearAgentState(sess, null, { keepActive: true });

  assert.deepEqual(sess.agentStates, {}, '离开文档的状态应被回收');
  assert.deepEqual(sess.agentCards, {}, '离开文档的卡片引用应被回收，否则内存不降');
});

test('A: 不传 opts 时保持原有全量清理语义（销毁路径不受影响）', () => {
  const cardA = { tag: 'A' };
  const { clearAgentState } = loadClearAgentState(new Set([cardA])); // 即使还在文档中
  const sess = {
    agentStates: { 'inv-a': makeState('inv-a', cardA) },
    agentCards: { 'inv-a': cardA },
    _agentStateLast: null
  };

  clearAgentState(sess);

  assert.deepEqual(sess.agentStates, {}, '全量清理语义被破坏');
  assert.deepEqual(sess.agentCards, {}, '全量清理语义被破坏');
});

test('A: 回放期间（_replaying）强制全量清理，历史帧不得写进实时卡', () => {
  const liveCard = { tag: 'live' };
  const { clearAgentState } = loadClearAgentState(new Set([liveCard]));
  // 回放期间 sess.container 仍在文档里，活跃卡恒为 alive；若还保留，同名同描述的
  // 历史子代理帧会按 agentName+':'+desc 撞键，把历史内容写进正在跑的那张卡。
  const sess = {
    _replaying: true,
    agentStates: { 'explore:审查': makeState('explore:审查', liveCard) },
    agentCards: { 'explore:审查': liveCard },
    _agentStateLast: null
  };

  clearAgentState(sess, null, { keepActive: true });

  assert.deepEqual(sess.agentStates, {}, '回放期间必须全量清理（实时状态由 captureLiveStreamState 快照负责）');
  assert.deepEqual(sess.agentCards, {}, '回放期间保留卡片会导致历史帧归属污染');
});

test('A: 保留的活跃子代理不得被停掉思考计时器，被清的必须停', () => {
  const liveCard = { tag: 'live' };
  const deadCard = { tag: 'dead' };
  const stopped = [];
  const { clearAgentState } = loadClearAgentState(new Set([liveCard]), stopped);
  const sess = {
    agentStates: {
      'inv-live': makeState('inv-live', liveCard),
      'inv-dead': makeState('inv-dead', deadCard)
    },
    agentCards: { 'inv-live': liveCard, 'inv-dead': deadCard },
    _agentStateLast: null
  };

  clearAgentState(sess, null, { keepActive: true });

  assert.deepEqual(stopped, ['inv-dead'],
    '离开文档的必须停计时器（否则泄漏），活跃的不得被停（否则计时停走）');
});

test('A: _agentStateLast 不得指向被裁掉的孤儿状态', () => {
  const orphanCard = { tag: 'orphan' };
  const { clearAgentState } = loadClearAgentState(new Set([orphanCard]));
  const orphanState = makeState('inv-orphan', orphanCard);
  const sess = {
    // 状态存活，但 agentCards 里没有它（丢帧/异常留下的半残留）→ 会被两表对齐裁掉
    agentStates: { 'inv-orphan': orphanState },
    agentCards: {},
    _agentStateLast: orphanState
  };

  clearAgentState(sess, null, { keepActive: true });

  assert.equal(sess._agentStateLast, null,
    '兜底归属指向已不再登记的卡 → 内容会写进一张游离的卡片');
});

test('A: evictInactiveSessions 销毁前必须以 destroying 调用，且两表同步清空', () => {
  const body = extractFunction(BASE_SRC, 'evictInactiveSessions');
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const call = code.match(/resetStreamState\s*\(\s*sess\s*,[^)]*\)/);
  assert.ok(call, 'evictInactiveSessions 应以额外参数调用 resetStreamState');
  assert.match(call[0], /destroying/,
    '销毁前必须传 destroying：此时卡片仍在文档中，keepActive 会把它们留到 empty() 之后泄漏');
  assert.match(code, /sess\.agentStates\s*=\s*\{\}/,
    'agentStates 必须与 agentCards 同步清空，否则钉住已摘除的卡片子树');
});

test('A: destroying 时即使卡片仍在文档中也全量清理', () => {
  const src = extractFunction(BASE_SRC, 'resetStreamState');
  const call = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    .match(/clearAgentState\s*\(\s*sess\s*,\s*null\s*,\s*\{[^}]*\}\s*\)/);
  assert.ok(call, 'resetStreamState 应调用 clearAgentState');
  // 直接求值该实参表达式，验证 destroying 真的能关掉 keepActive
  const argExpr = call[0].match(/\{[^}]*\}/)[0];
  const evalArg = (opts) => Function('opts', 'return ' + argExpr + ';')(opts);
  assert.equal(evalArg({ destroying: true }).keepActive, false,
    'destroying 时 keepActive 必须为 false');
  assert.equal(evalArg(undefined).keepActive, true,
    '普通路径（发消息/作答）必须保留活跃子代理');
});

test('A: agentStates 与 agentCards 两表口径严格一致（不产生「有卡无态」）', () => {
  const cardA = { tag: 'A' };
  const orphanCard = { tag: 'orphan' };
  const live = new Set([cardA, orphanCard]);
  const { clearAgentState } = loadClearAgentState(live);
  const sess = {
    agentStates: { 'inv-a': makeState('inv-a', cardA) },
    // inv-orphan 只有卡、没有对应 state（丢帧/异常留下的半残留）
    agentCards: { 'inv-a': cardA, 'inv-orphan': orphanCard },
    _agentStateLast: null
  };

  clearAgentState(sess, null, { keepActive: true });

  assert.deepEqual(Object.keys(sess.agentStates), ['inv-a']);
  assert.deepEqual(Object.keys(sess.agentCards), ['inv-a'],
    '无对应 state 的孤儿卡片必须被清掉，两表口径必须一致');
});

test('A: resetStreamState 调用 clearAgentState 时必须带 keepActive', () => {
  const body = extractFunction(BASE_SRC, 'resetStreamState');
  // 剥注释后再断言，避免把说明文字里的字样当成代码
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const call = code.match(/clearAgentState\s*\([^)]*\)/);
  assert.ok(call, 'resetStreamState 应调用 clearAgentState');
  assert.match(call[0], /keepActive/,
    'resetStreamState 必须以 keepActive 调用，否则发消息/作答/上拉加载会清掉正在跑的子代理');
});

/* ===== 缺陷 B：卡体滚动跟随不得被自身置底或内容增长自锁 ===== */

// 取出 scroll 监听体，在受控替身上驱动，断言真实行为而非源码字符串。
function loadScrollHandler() {
  const start = MESSAGE_SRC.indexOf("$(agentCardBody).on('scroll'");
  assert.ok(start >= 0, 'agentCardBody scroll listener not found');
  const fnStart = MESSAGE_SRC.indexOf('function()', start);
  const bodyStart = MESSAGE_SRC.indexOf('{', fnStart);
  let depth = 0, end = -1;
  for (let i = bodyStart; i < MESSAGE_SRC.length; i++) {
    if (MESSAGE_SRC[i] === '{') depth++;
    else if (MESSAGE_SRC[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const body = MESSAGE_SRC.slice(bodyStart, end);
  return Function('agentCardBody', 'agentState', body.slice(1, -1));
}

const followBody = Function('bodyEl', 'st',
  extractFunction(MESSAGE_SRC, 'followAgentCardBody').replace(/^function [^{]*\{/, '').replace(/\}$/, ''));

test('B: 程序置底 + 内容异步撑高，不得停掉自动跟随', () => {
  const handler = loadScrollHandler();
  const st = {};
  const body = { scrollHeight: 1000, clientHeight: 420, scrollTop: 580 }; // 已在底部

  // 模拟：置底后代码高亮/mermaid 异步把内容撑高 300px，随后 scroll 事件才被派发
  body.scrollHeight = 1300;
  handler(body, st);

  assert.notEqual(st.bodyUserScrolledUp, true,
    '内容异步撑高被误判为「用户上翻」→ 跟随自锁，卡片视口将永久定格');
});

test('B: 流式追加内容（scrollTop 不变、scrollHeight 变大）不得停掉跟随', () => {
  const handler = loadScrollHandler();
  const st = {};
  const body = { scrollHeight: 1000, clientHeight: 420, scrollTop: 580 };
  handler(body, st); // 建立基线

  for (let i = 0; i < 5; i++) {        // 连续 5 次流式追加
    body.scrollHeight += 200;
    handler(body, st);
  }

  assert.notEqual(st.bodyUserScrolledUp, true, '纯内容增长不得被当作用户上翻');
});

test('B: 用户真实向上滚动时停止跟随', () => {
  const handler = loadScrollHandler();
  const st = {};
  const body = { scrollHeight: 1300, clientHeight: 420, scrollTop: 880 };
  handler(body, st);          // 基线：底部

  body.scrollTop = 200;       // 用户往回翻
  handler(body, st);

  assert.equal(st.bodyUserScrolledUp, true, '用户上翻时必须停止自动跟随，否则会被强行拽回底部');
});

test('B: 用户滚回底部后恢复跟随（自锁必须可解除）', () => {
  const handler = loadScrollHandler();
  const st = {};
  const body = { scrollHeight: 1300, clientHeight: 420, scrollTop: 880 };
  handler(body, st);

  body.scrollTop = 200;                 // 上翻 → 停跟随
  handler(body, st);
  assert.equal(st.bodyUserScrolledUp, true);

  body.scrollTop = 880;                 // 滚回底部 → 恢复
  handler(body, st);
  assert.equal(st.bodyUserScrolledUp, false, '滚回底部必须恢复跟随，否则停跟随状态不可逆');
});

test('B: followAgentCardBody 在未停跟随时置底、已停跟随时不动', () => {
  const body = { scrollHeight: 1300, clientHeight: 420, scrollTop: 0 };
  followBody(body, {});
  assert.equal(body.scrollTop, 1300, '未停跟随时应置底，否则新内容隐在视口下方');

  const parked = { scrollHeight: 1300, clientHeight: 420, scrollTop: 100 };
  followBody(parked, { bodyUserScrolledUp: true });
  assert.equal(parked.scrollTop, 100, '用户正在翻看时不得强行拽回底部');
});
