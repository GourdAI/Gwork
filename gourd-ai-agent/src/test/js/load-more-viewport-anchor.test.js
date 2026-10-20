'use strict';
/* 上拉加载更多的视口锚定契约（2026-10-19 用户报障「上拉到顶被拽回底部」的防回归护栏；
   同日自审追加：P1-A stitch 删行锚点缺席修正、P1-B 贴顶停住自动分页入口）。
   三个根因各配行为/结构断言，并各带负对照（内存变异后断言必须变红），
   证明断言真有牙而不是恒绿摆设：
   R1 replayDoneCore 的兜底补偿必须受 atBottomBeforePrepend 门禁（拽底根因）；
      修正逻辑抽为纯函数 applyPrependViewportFix，行为沙箱四象限真执行；
   R1b stitch 删除用户正在看的行后，必须以目的行 + 删除前视觉偏移做锚点修正（P1-A）；
   R2 updateLoadMoreBtn 的 IntersectionObserver 自动触发必须用实时几何复核（过期
      intersecting 不得误触发），贴顶停住（按钮在视口顶之上、几何不相交）也必须能触发（P1-B）。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const historyPath = path.resolve(__dirname, '../../main/resources/static/js/app-history.js');
const historyJs = fs.readFileSync(historyPath, 'utf8').split(/\r\n|\n/).join('\n');

/* ---------- 源码块提取（括号配平扫描，忽略字符串/注释/模板） ---------- */
function extractBlock(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, '未找到起始标记: ' + startMarker);
  const braceStart = source.indexOf('{', start);
  let depth = 0, state = 'code', i = braceStart;
  for (; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; i++; continue; }
      if (c === '/' && next === '*') { state = 'block'; i++; continue; }
      if (c === "'") { state = 'single'; continue; }
      if (c === '"') { state = 'double'; continue; }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) break;
    } else if (state === 'line') { if (c === '\n') state = 'code'; }
    else if (state === 'block') { if (c === '*' && next === '/') { state = 'code'; i++; } }
    else if (state === 'single') { if (c === '\\') i++; else if (c === "'") state = 'code'; }
    else if (state === 'double') { if (c === '\\') i++; else if (c === '"') state = 'code'; }
  }
  assert.ok(depth === 0, '块括号未配平: ' + startMarker);
  return source.slice(start, i + 1);
}

const fixSrc = () => extractBlock(historyJs, 'function applyPrependViewportFix(');
const updateLoadMoreBtnSrc = () => extractBlock(historyJs, 'function updateLoadMoreBtn(sess) {');

/* ---------- R1/R1b 结构断言：三分支修正 + 门禁 + 守卫 ---------- */
function assertFixGated(src) {
  // ① 锚点分支必须带 document.contains 守卫（脱离文档的锚点行 rect 全 0，修正量是错值）
  assert.ok(/anchorEl && document\.contains\(anchorEl\)/.test(src), '锚点分支必须带 document.contains 守卫');
  // ② stitch 目的行分支：必须校验目的行在文档中且携带删除前视觉偏移
  assert.ok(/moved && document\.contains\(moved\) && stitchInfo\.removedVisualTop != null/.test(src), 'stitch 分支必须校验搬移节点在文档且带视觉偏移');
  // ③ 兜底补偿受贴底门禁且仅一处
  const compIdx = src.indexOf('wrap.scrollTop += (wrap.scrollHeight - scrollHeightBefore)');
  assert.ok(compIdx >= 0, '缺少兜底补偿写入');
  const gateIdx = src.lastIndexOf('if (atBottomBeforePrepend) {', compIdx);
  assert.ok(gateIdx >= 0 && gateIdx < compIdx, '兜底补偿必须位于 if (atBottomBeforePrepend) 分支内');
  const compCount = src.split('wrap.scrollTop += (wrap.scrollHeight - scrollHeightBefore)').length - 1;
  assert.strictEqual(compCount, 1, '兜底补偿写入必须恰好一处');
}

/* ---------- R1/R1b 行为沙箱：真执行三分支修正 ---------- */
function makeFixEnv() {
  // 极简 DOM 替身：rect 由用例指定；inDoc 集合决定 document.contains
  const inDoc = new Set();
  function el(top, id) {
    const node = { id: id, rectTop: top, getBoundingClientRect() { return { top: inDoc.has(node) ? node.rectTop : 0 }; } };
    return node;
  }
  const wrap = {
    _scrollTop: 0,
    get scrollTop() { return this._scrollTop; },
    set scrollTop(v) { this._scrollTop = Number(v); },
    scrollHeight: 0,
    getBoundingClientRect() { return { top: 0 }; }
  };
  const env = {
    document: { contains: n => inDoc.has(n) },
    _inDoc: inDoc,
    _el: el,
    _wrap: wrap
  };
  const runner = new Function('__env', 'with (__env) { ' + fixSrc() + '\nreturn applyPrependViewportFix; }')(env);
  return { env, wrap, el, inDoc, run: runner };
}

/* ---------- R2 结构断言：IO 触发前实时几何复核 + 贴顶停住即时触发 + 有界补抓 ---------- */
function assertIoGate(src) {
  const ioIdx = src.indexOf('new IntersectionObserver(');
  assert.ok(ioIdx >= 0, '缺少 IntersectionObserver 自动触发');
  const ioBlock = src.slice(ioIdx);
  assert.ok(/btnVisibleNow\(\)/.test(ioBlock), 'IO 回调必须用实时几何复核而非直接信 entry');
  assert.ok(/messagesWrap\.scrollTop\s*<=\s*240/.test(src), '复核必须含贴顶阈值');
  // P1-B：贴顶时按钮在视口顶之上（几何不相交），non-intersecting 分支必须即时复核触发
  const nonIntersectBlock = ioBlock.slice(0, ioBlock.indexOf('if (!_hasBeenHidden || _triggered) return;'));
  assert.ok(/btnAboveViewport\(\)/.test(nonIntersectBlock) && /fireLoad\(\)/.test(nonIntersectBlock),
    'non-intersecting 分支必须含「按钮已越过视口顶且贴顶」即时触发');
  assert.ok(/_recheckLeft\s*=\s*\d+/.test(src) && /scheduleRecheck\(\)/.test(ioBlock), '过期拒绝后必须有有界补抓窗口');
  assert.ok(/clearTimeout\(_recheckTimer\)/.test(src), '触发时必须清理补抓定时器');
}

/* ---------- IO 替身与行为沙箱 ---------- */
function makeIoEnv(opts) {
  const calls = { loadMore: 0, disconnected: 0 };
  let ioCallback = null;
  const btn = {
    rect: opts.btnRect,
    getBoundingClientRect() { return this.rect; },
    handlers: {},
    classes: new Set()
  };
  const wrap = {
    _scrollTop: opts.scrollTop,
    get scrollTop() { return this._scrollTop; },
    set scrollTop(v) { this._scrollTop = Number(v); },
    getBoundingClientRect() { return { top: 0, bottom: 900 }; }
  };
  const timers = [];
  const env = {
    messagesWrap: wrap,
    IntersectionObserver: function (cb) {
      ioCallback = cb;
      return {
        observe() {},
        disconnect() { calls.disconnected++; }
      };
    },
    document: { contains: () => true },
    setTimeout(cb, ms) { timers.push(cb); return timers.length; },
    clearTimeout() {},
    GourdI18n: { t: k => k },
    console: { error() {}, warn() {}, log() {} }
  };
  // 极简 jQuery 替身：只服务 updateLoadMoreBtn 的按钮分支
  const wrapper = {
    button: btn,
    inserted: false
  };
  function btnRef() {
    return {
      0: btn,
      get length() { return 1; },
      hasClass: n => btn.classes.has(n),
      addClass: n => { btn.classes.add(n); return this; },
      html() { return this; },
      on(ev, cb) { btn.handlers[ev] = cb; return this; },
      find() { return { length: 0, on() { return this; } }; }
    };
  }
  env.$ = function (value) {
    if (typeof value === 'string' && value.indexOf('<div') === 0) {
      return {
        0: btn,
        length: 1,
        insertBefore(container) { wrapper.inserted = container; return this; },
        find() { return btnRef(); }
      };
    }
    if (value && value.__container) {
      return { prev() { return { remove() {}, find() { return { length: 0 }; } }; } };
    }
    throw new Error('unexpected $ input');
  };
  env.loadMoreMessages = function () { calls.loadMore++; };
  const sess = { sessionId: 's1', container: { __container: true }, _replayHasMore: true, _replayRemainingRounds: 3 };
  env.activeSessionId = 's1';
  const code = updateLoadMoreBtnSrc() + '\nupdateLoadMoreBtn(__sess);';
  new Function('__env', '__sess', 'with (__env) { ' + code + ' }')(env, sess);
  return {
    calls,
    btn,
    wrap,
    fire(entries) { ioCallback(entries); },
    flushTimers() { const t = timers.splice(0); t.forEach(cb => cb()); return t.length; }
  };
}

/* ================= R1/R1b ================= */

test('R1 结构：三分支修正含门禁与双重 contains 守卫', () => {
  assertFixGated(fixSrc());
});

test('R1 行为：锚点在文档中 → 按锚点视觉偏移修正', () => {
  const h = makeFixEnv();
  const anchor = h.el(300, 'anchor');
  h.inDoc.add(anchor);
  h.run(h.wrap, anchor, 50, false, 1000, null);
  assert.strictEqual(h.wrap.scrollTop, 250, '锚点修正量 = newTop - anchorOffset');
});

test('R1b 行为：锚点脱离文档（stitch 已删）→ 以目的行 + 删除前偏移修正', () => {
  const h = makeFixEnv();
  const anchor = h.el(300, 'anchor');   // 故意不入 inDoc：模拟被 stitch 删除
  const dst = h.el(800, 'dst');
  h.inDoc.add(dst);
  h.run(h.wrap, anchor, 50, false, 1000, { firstMoved: dst, removedVisualTop: 100 });
  assert.strictEqual(h.wrap.scrollTop, 700, '搬移节点修正量 = movedTop - removedVisualTop');
});

test('R1 行为：锚点与目的行皆缺席且用户贴底 → 兜底补偿', () => {
  const h = makeFixEnv();
  h.wrap.scrollHeight = 2600;
  h.run(h.wrap, null, 0, true, 1000, null);
  assert.strictEqual(h.wrap.scrollTop, 1600, '贴底时补偿 scrollHeight 增量');
});

test('R1 行为：锚点与目的行皆缺席且用户不贴底 → 视口不动（拽底根因门禁）', () => {
  const h = makeFixEnv();
  h.wrap.scrollHeight = 2600;
  h.run(h.wrap, null, 0, false, 1000, null);
  assert.strictEqual(h.wrap.scrollTop, 0, '不贴底时禁止兜底补偿（否则拽回底部）');
});

test('R1 行为：锚点脱离且目的行也脱离且贴底 → 仍走兜底补偿', () => {
  const h = makeFixEnv();
  const anchor = h.el(300, 'anchor');
  h.wrap.scrollHeight = 2600;
  h.run(h.wrap, anchor, 50, true, 1000, { firstMoved: h.el(800, 'dst'), removedVisualTop: 100 });
  assert.strictEqual(h.wrap.scrollTop, 1600);
});

test('R1 负对照：门禁反置后「不贴底不动」象限必须变红', () => {
  const mutated = fixSrc().replace('if (atBottomBeforePrepend) {', 'if (true) {');
  assert.notStrictEqual(mutated, fixSrc(), '变异未命中');
  const runner = new Function('__env', 'with (__env) { ' + mutated + '\nreturn applyPrependViewportFix; }');
  const inDoc = new Set();
  const wrap = { _scrollTop: 0, get scrollTop() { return this._scrollTop; }, set scrollTop(v) { this._scrollTop = Number(v); }, scrollHeight: 2600, getBoundingClientRect() { return { top: 0 }; } };
  const env = { document: { contains: n => inDoc.has(n) } };
  runner(env)(wrap, null, 0, false, 1000, null);
  assert.notStrictEqual(wrap.scrollTop, 0, '门禁失效后不贴底也被补偿 = 拽底回归');
});

test('R1b 负对照：去掉锚点 contains 守卫后「stitch 场景」必须变红', () => {
  const mutated = fixSrc().replace('anchorEl && document.contains(anchorEl)', 'anchorEl');
  assert.notStrictEqual(mutated, fixSrc(), '变异未命中');
  const runner = new Function('__env', 'with (__env) { ' + mutated + '\nreturn applyPrependViewportFix; }');
  const inDoc = new Set();
  function el(top) { const n = { rectTop: top, getBoundingClientRect() { return { top: inDoc.has(n) ? n.rectTop : 0 }; } }; return n; }
  const wrap = { _scrollTop: 0, get scrollTop() { return this._scrollTop; }, set scrollTop(v) { this._scrollTop = Number(v); }, scrollHeight: 2600, getBoundingClientRect() { return { top: 0 }; } };
  const anchor = el(300);                 // 脱离文档
  const dst = el(800); inDoc.add(dst);
  const env = { document: { contains: n => inDoc.has(n) } };
  runner(env)(wrap, anchor, 50, false, 1000, { firstMoved: dst, removedVisualTop: 100 });
  assert.notStrictEqual(wrap.scrollTop, 700, '无守卫时读脱离节点 rect=0，修正量错值');
});

test('R1b 负对照：删掉 stitch 目的行分支后「stitch 场景」必须变红', () => {
  const mutated = fixSrc().replace(/var moved = stitchInfo && stitchInfo\.firstMoved;[\s\S]*?return;\n    \}/, 'if (false) { return; }');
  assert.notStrictEqual(mutated, fixSrc(), '变异未命中');
  const runner = new Function('__env', 'with (__env) { ' + mutated + '\nreturn applyPrependViewportFix; }');
  const inDoc = new Set();
  function el(top) { const n = { rectTop: top, getBoundingClientRect() { return { top: inDoc.has(n) ? n.rectTop : 0 }; } }; return n; }
  const wrap = { _scrollTop: 0, get scrollTop() { return this._scrollTop; }, set scrollTop(v) { this._scrollTop = Number(v); }, scrollHeight: 2600, getBoundingClientRect() { return { top: 0 }; } };
  const dst = el(800); inDoc.add(dst);
  const env = { document: { contains: n => inDoc.has(n) } };
  runner(env)(wrap, null, 0, false, 1000, { firstMoved: dst, removedVisualTop: 100 });
  assert.strictEqual(wrap.scrollTop, 0, '分支被删后 stitch 场景无修正 = P1-A 回归');
});

/* ================= R2 ================= */

test('R2 结构：IO 自动触发带实时几何复核、贴顶即时触发与有界补抓', () => {
  assertIoGate(updateLoadMoreBtnSrc());
});

test('R2 负对照：回调直接信 entry 时结构断言必须变红', () => {
  const mutated = updateLoadMoreBtnSrc().split('if (btnVisibleNow()) { fireLoad(); return; }').join('fireLoad();');
  assert.notStrictEqual(mutated, updateLoadMoreBtnSrc(), '变异未命中');
  assert.throws(() => assertIoGate(mutated), /实时几何复核|贴顶阈值/);
});

test('R2 负对照：删掉 non-intersecting 即时触发后结构断言必须变红', () => {
  const mutated = updateLoadMoreBtnSrc().replace('if (!_triggered && btnAboveViewport()) { fireLoad(); }', '');
  assert.notStrictEqual(mutated, updateLoadMoreBtnSrc(), '变异未命中');
  assert.throws(() => assertIoGate(mutated), /即时触发/);
});

test('R2 行为：过期 intersecting（用户未贴顶）不得触发分页', () => {
  const h = makeIoEnv({ scrollTop: 1495, btnRect: { top: 10, bottom: 60 } });
  h.fire([{ isIntersecting: false }]);          // 初始：按钮在视口外 → 门禁一置真
  h.fire([{ isIntersecting: true }]);           // 过期/抖动 intersecting：几何复核应拒绝
  assert.strictEqual(h.calls.loadMore, 0, '未贴顶时不得自动分页');
  assert.strictEqual(h.calls.disconnected, 0, '拒绝后观察器必须保留（用户之后到顶仍要能触发）');
});

test('R2 行为：补抓窗口内用户真到顶则自动分页', () => {
  const h = makeIoEnv({ scrollTop: 1495, btnRect: { top: 10, bottom: 60 } });
  h.fire([{ isIntersecting: false }]);
  h.fire([{ isIntersecting: true }]);           // 过期回调 → 启动有界补抓
  assert.strictEqual(h.calls.loadMore, 0);
  h.wrap.scrollTop = 0;                          // 用户随后真拉到顶
  let rounds = 0;
  while (h.calls.loadMore === 0 && rounds < 20) { if (h.flushTimers() === 0) break; rounds++; }
  assert.strictEqual(h.calls.loadMore, 1, '补抓窗口内到顶应触发一次分页');
  assert.strictEqual(h.calls.disconnected, 1, '触发后观察器应断开');
});

test('R2 行为：补抓窗口有界（用户始终不到顶则不触发）', () => {
  const h = makeIoEnv({ scrollTop: 1495, btnRect: { top: 10, bottom: 60 } });
  h.fire([{ isIntersecting: false }]);
  h.fire([{ isIntersecting: true }]);
  for (let i = 0; i < 40; i++) h.flushTimers();
  assert.strictEqual(h.calls.loadMore, 0, '补抓必须有界，永不触发');
});

test('R2 行为：真实到顶且按钮在视口内的 intersecting 立即触发', () => {
  const h = makeIoEnv({ scrollTop: 0, btnRect: { top: 10, bottom: 60 } });
  h.fire([{ isIntersecting: false }]);
  h.fire([{ isIntersecting: true }]);
  assert.strictEqual(h.calls.loadMore, 1, '贴顶且按钮可见应立即分页');
});

test('R2 行为（P1-B）：贴顶停住、按钮在视口顶之上 → non-intersecting 即时触发', () => {
  const h = makeIoEnv({ scrollTop: 0, btnRect: { top: -200, bottom: -150 } });
  h.fire([{ isIntersecting: false }]);          // 贴顶时几何本就不相交：这正是真到顶信号
  assert.strictEqual(h.calls.loadMore, 1, '贴顶停住必须能自动分页（否则入口消失）');
});

test('R2 行为：未贴顶且按钮在视口外 → non-intersecting 不触发', () => {
  const h = makeIoEnv({ scrollTop: 1495, btnRect: { top: -200, bottom: -150 } });
  h.fire([{ isIntersecting: false }]);
  h.fire([{ isIntersecting: true }]);
  for (let i = 0; i < 40; i++) h.flushTimers();
  assert.strictEqual(h.calls.loadMore, 0, '中部且按钮不可见不得分页');
});

test('R2 行为：按钮不在视口内且未贴顶的 intersecting 不触发', () => {
  const h = makeIoEnv({ scrollTop: 1495, btnRect: { top: -200, bottom: -150 } });
  h.fire([{ isIntersecting: false }]);
  h.fire([{ isIntersecting: true }]);
  for (let i = 0; i < 40; i++) h.flushTimers();
  assert.strictEqual(h.calls.loadMore, 0, '按钮不在视口内不得分页');
});
