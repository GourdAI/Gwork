'use strict';
/* 远程工作区模型列表「归属声明 + 空表自愈 + 事件联动」契约（2026-10-20 轮）。
 *
 * 缺陷形态：
 *   - loadModels / refreshSessionModel 的 url 只拼 sessionId、不带 __scope → Tauri
 *     route_for 第 6 级兜底激活 scope，选中远端工作区时模型请求被打到远端后端，
 *     远端镜像丢失即返回空表，且空表被锁成「已加载」永不重试。
 *   - 远端空表是可疑态：应触发一次镜像重推自愈（remoteMirrorSync），成功重载、
 *     失败渲染专属文案；且必须防环（二次空表不再重推）。
 *   - 镜像同步成功 / 工作区切换 / 连接表变化都应让模型列表 stale 并去抖重载。
 *
 * 铁律（本仓踩过）：
 *   1) 沙箱一律从【真实源码】切函数体，不得在测试里抄实现（抄件 → 全绿但测的是副本）。
 *   2) 源码契约断言先 stripComments：注释里大量「禁止的旧形态」反面教材会自匹配。
 *   3) 断言锁行为不锁措辞：url 的参数计数、自愈次数、stale 标志、重载次数。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const STATIC = path.join(__dirname, '..', '..', 'main', 'resources', 'static');
/** 工作树是 CRLF（git i/lf w/crlf），统一成 LF 再切片，否则含裸 \n 的 endMark 永不匹配。 */
function readJs(rel) {
  return fs.readFileSync(path.join(STATIC, 'js', rel), 'utf8')
    .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

/** 删注释（供源码契约断言）：① 非贪婪删块注释；② 删 trim 后以 // 开头的整行。
 *  不碰行尾 // 注释，避开字符串/正则里的 //（如 URL）误删。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

const historyRaw = readJs('app-history.js');
const remoteRaw = readJs('app-remote.js');
const history = stripComments(historyRaw);
const remote = stripComments(remoteRaw);

/** 切顶层函数（app-history.js / app-remote.js 的顶层 function，闭合括号在第 0 列）。 */
function cutTopFn(src, header) {
  const at = src.indexOf(header);
  assert.ok(at >= 0, '顶层函数缺失: ' + header);
  const body = src.slice(at);
  const end = body.search(/\n\}/);
  assert.ok(end > 0, '顶层函数收尾定位失败: ' + header);
  return body.slice(0, end + 2);
}

/** 切 scheduleModelsReload 函数体之后、refreshSessionModel 之前的【事件注册块】
 *  （三行 addEventListener 是顶层语句，不在函数体内，cutTopFn 切不到）。
 *  从真实源码切，不抄实现。 */
function cutModelReloadRegistrations(src) {
  const fn = cutTopFn(src, 'function scheduleModelsReload()');
  const after = src.indexOf(fn) + fn.length;
  const end = src.indexOf('function refreshSessionModel(sessionId)');
  assert.ok(end > after, '未找到 scheduleModelsReload 与 refreshSessionModel 之间的注册块');
  return src.slice(after, end);
}

/* ---------- 剥注释自检：锚点仍在，反面教材已删 ---------- */
test('自检：stripComments 未吃掉正文（关键锚点仍在）', () => {
  for (const a of [
    'function modelsRequestScope()',
    'function modelsScopeSegment(scope)',
    'function loadModels(sessionId, callback)',
    'function handleRemoteEmptyModels(scope, sessionId, callback)',
    'function scheduleModelsReload()',
    'function refreshSessionModel(sessionId)',
  ]) assert.ok(history.includes(a), 'app-history 剥注释后丢了锚点: ' + a);
  assert.ok(remote.includes("window.dispatchEvent(new CustomEvent('gourd:mirror-synced'"),
    'app-remote 剥注释后丢了 mirror-synced dispatch');
});

/* ========================================================================
 * 沙箱：从真实源码切出模型加载相关函数，注入受控 $ / window / document / 时钟
 * ====================================================================== */
function makeSandbox(opts) {
  opts = opts || {};
  const getUrls = [];
  const responses = opts.responses || [];
  let getCount = 0;
  const mirrorCalls = [];
  const mirrorResult = opts.mirrorResult; // {synced} | undefined(无入口) | function(scope)
  const listeners = { win: {}, doc: {} };
  const timers = [];
  let clock = 0;
  let renderCalls = 0;
  let loadCalls = 0;

  function JqObj() { return { fail: function () { return this; } }; }
  const $ = {
    get: function (url, cb) {
      getUrls.push(url);
      const resp = (getCount < responses.length)
        ? responses[getCount]
        : { code: 200, data: { list: [], selected: '' } };
      getCount++;
      if (cb) cb(resp);
      return new JqObj();
    },
    post: function () { return new JqObj(); },
  };

  const win = {
    __currentProjectScope: opts.scopeFn,
    addEventListener: function (ev, fn) { (listeners.win[ev] = listeners.win[ev] || []).push(fn); },
  };
  if (mirrorResult !== undefined) {
    win.remoteMirrorSync = function (scope) {
      mirrorCalls.push(scope);
      return Promise.resolve(typeof mirrorResult === 'function' ? mirrorResult(scope) : mirrorResult);
    };
  }
  const doc = {
    addEventListener: function (ev, fn) { (listeners.doc[ev] = listeners.doc[ev] || []).push(fn); },
  };

  const src = [
    // ---- 状态（与真实源码同名同初值；healedByScope 为本次新增的模块级防环 map）----
    'var modelList = [];',
    'var modelsLoaded = false;',
    'var modelsListStale = false;',
    'var healedByScope = Object.create(null);',
    'var sessionModelMap = {};',
    'var sessionThinkingMap = {};',
    'var sessionContextMap = {};',
    'var sessionModelRequestMap = {};',
    'var activeSessionId = null;',
    'var _modelsReloadTimer = null;',
    // ---- 虚拟时钟（遮蔽全局 setTimeout/clearTimeout，供去抖断言）----
    'var __timers = __env.timers;',
    'var __clock = 0;',
    'function setTimeout(fn, ms) { var t = { fn: fn, at: __clock + (ms || 0), id: __timers.length + 1 }; __timers.push(t); return t.id; }',
    'function clearTimeout(id) { for (var i = 0; i < __timers.length; i++) { if (__timers[i].id === id) { __timers[i].cancelled = true; } } }',
    // ---- 真实源码切片（不抄实现）----
    cutTopFn(history, 'function modelsRequestScope()'),
    cutTopFn(history, 'function modelsScopeSegment(scope)'),
    cutTopFn(history, 'function modelsResponseValid(resp)'),
    cutTopFn(history, 'function loadModels(sessionId, callback)'),
    cutTopFn(history, 'function handleRemoteEmptyModels(scope, sessionId, callback)'),
    cutTopFn(history, 'function scheduleModelsReload()'),
    // ---- 事件注册块（真实源码切片：三行 addEventListener 接线）----
    cutModelReloadRegistrations(history),
    // ---- stub 依赖（非本次被测对象）----
    'function applyContextResponse() {}',
    'function normalizeThinkingCode() { return "auto"; }',
    'function hasSessionValue() { return false; }',
    'function renderModelUI() { __env.renderCalls++; }',
    'function degradeModelLoad() { modelsLoaded = false; modelsListStale = false; renderModelUI(); }',
    // ---- loadModels 计数包装（scheduleModelsReload 内部调用也经此计数）----
    'var __realLoad = loadModels;',
    'loadModels = function (sid, cb) { __env.loadCalls++; return __realLoad(sid, cb); };',
    'return {',
    '  loadModels: function (sid, cb) { return loadModels(sid, cb); },',
    '  scheduleModelsReload: scheduleModelsReload,',
    '  state: function () { return { modelsLoaded: modelsLoaded, modelsListStale: modelsListStale, modelList: modelList.slice(), healedByScope: healedByScope }; },',
    '  listeners: __env.listeners,',
    '  timers: __timers,',
    '  advance: function (ms) { __clock += ms; var due = __timers.filter(function (t) { return !t.cancelled && !t.fired && t.at <= __clock; }); due.forEach(function (t) { t.fired = true; t.fn(); }); },',
    '};',
  ].join('\n');

  const env = {
    timers: timers, listeners: listeners,
    get renderCalls() { return renderCalls; },
    get loadCalls() { return loadCalls; },
  };
  // renderCalls / loadCalls 由沙箱内自增写回 env：用闭包 getter 不够，改用直接对象引用
  const api = new Function('$', 'window', 'document', 'Promise', '__env', src)($, win, doc, Promise, env);
  // 沙箱内 __env.renderCalls++ / __env.loadCalls++ 直接改 env 上的普通属性
  Object.defineProperty(env, 'renderCalls', { get: () => renderCalls, set: (v) => { renderCalls = v; }, configurable: true });
  Object.defineProperty(env, 'loadCalls', { get: () => loadCalls, set: (v) => { loadCalls = v; }, configurable: true });

  return {
    api: api,
    getUrls: getUrls,
    mirrorCalls: mirrorCalls,
    listeners: listeners,
    advance: api.advance,
    state: api.state,
    renderCalls: function () { return renderCalls; },
    loadCalls: function () { return loadCalls; },
  };
}

/** connectionId 真实形态含冒号（rc-<host>:<port>:<user>），用它才能验出编码需求。 */
const RID = 'rc-10.0.0.8:22:dev';
const ENC_RID = encodeURIComponent(RID);
const NON_EMPTY = { code: 200, data: { list: [{ name: 'm1', model: 'm1' }], selected: 'm1' } };
const EMPTY = { code: 200, data: { list: [], selected: '' } };

function countOccur(s, sub) {
  let n = 0, i = 0;
  while ((i = s.indexOf(sub, i)) >= 0) { n++; i += sub.length; }
  return n;
}

/* ========================================================================
 * a) loadModels url 拼接：远端含 __scope=id: 且 sessionId/__scope 各一次；本地含 __scope=local
 * ====================================================================== */
test('a1 loadModels 远端 scope：url 含 __scope=id:<enc>，sessionId 与 __scope 各出现一次', () => {
  const sb = makeSandbox({ scopeFn: () => RID, responses: [NON_EMPTY] });
  sb.api.loadModels('sess-1');
  const url = sb.getUrls[0];
  assert.ok(url.startsWith('/web/chat/models?'), 'url 应以 /web/chat/models? 开头: ' + url);
  assert.ok(url.includes('__scope=id:' + ENC_RID), '远端应带编码后的 __scope=id: ' + url);
  assert.ok(url.includes('sessionId=sess-1'), '应带 sessionId: ' + url);
  assert.strictEqual(countOccur(url, '__scope='), 1, '__scope 必须恰好出现一次（重复参数坑）: ' + url);
  assert.strictEqual(countOccur(url, 'sessionId='), 1, 'sessionId 必须恰好出现一次: ' + url);
});

test('a2 loadModels 本地 scope（__currentProjectScope 回 null）：url 含 __scope=local', () => {
  const sb = makeSandbox({ scopeFn: () => null, responses: [NON_EMPTY] });
  sb.api.loadModels('sess-2');
  const url = sb.getUrls[0];
  assert.ok(url.includes('__scope=local'), '本地应带 __scope=local: ' + url);
  assert.strictEqual(countOccur(url, '__scope='), 1, '__scope 必须恰好一次: ' + url);
  assert.ok(!url.includes('id:'), '本地不得带 id: 形态: ' + url);
});

test('a3 loadModels 无 sessionId：仍带单一 __scope，不产生空 sessionId 参数', () => {
  const sb = makeSandbox({ scopeFn: () => RID, responses: [NON_EMPTY] });
  sb.api.loadModels(null);
  const url = sb.getUrls[0];
  assert.strictEqual(url, '/web/chat/models?__scope=id:' + ENC_RID, '无 sessionId 时 url 应只含 __scope: ' + url);
  assert.ok(!url.includes('sessionId='), '不应出现 sessionId 参数: ' + url);
});

/* ========================================================================
 * b) 空表 + 远端 → 自愈：remoteMirrorSync 恰好一次、synced=true 重载一次、二次空表不再自愈
 * ====================================================================== */
test('b1 远端空表：触发 remoteMirrorSync 恰好一次，synced=true 后重载一次，二次空表不再自愈（防环）', async () => {
  const sb = makeSandbox({ scopeFn: () => RID, responses: [EMPTY, EMPTY], mirrorResult: { synced: true } });
  sb.api.loadModels('s1');
  await null; // 让 remoteMirrorSync 的 then 微任务执行（内部重载 loadModels）
  assert.strictEqual(sb.mirrorCalls.length, 1, 'remoteMirrorSync 应恰好调用一次');
  assert.strictEqual(sb.mirrorCalls[0], RID, '应以远端 scope 调用 remoteMirrorSync');
  assert.strictEqual(sb.getUrls.length, 2, 'synced=true 后应重载一次（共两次 GET）');
  assert.strictEqual(sb.state().healedByScope[RID], true, 'healedByScope 应置位（防环）');
  // 二次空表（已自愈过）→ 不再触发 remoteMirrorSync
  sb.api.loadModels('s1');
  await null;
  assert.strictEqual(sb.mirrorCalls.length, 1, '二次空表不得再次自愈（防环）');
  assert.strictEqual(sb.getUrls.length, 3, '二次加载仍发 GET，但不重推镜像');
});

test('b2 远端空表 + synced=false：不重载，渲染空表（不静默），modelsLoaded 保持 false', async () => {
  const sb = makeSandbox({ scopeFn: () => RID, responses: [EMPTY], mirrorResult: { synced: false } });
  sb.api.loadModels('s1');
  await null;
  assert.strictEqual(sb.mirrorCalls.length, 1, '应尝试自愈一次');
  assert.strictEqual(sb.getUrls.length, 1, 'synced=false 不得重载');
  const st = sb.state();
  assert.strictEqual(st.modelsLoaded, false, '空表不得锁成已加载');
  assert.strictEqual(st.modelsListStale, true, '空表应标记 stale');
  assert.ok(sb.renderCalls() >= 1, '应渲染空表专属文案（renderModelUI 被调用）');
});

test('b3 远端空表 + 无 remoteMirrorSync 入口：渲染空表，不抛错，modelsLoaded=false', () => {
  const sb = makeSandbox({ scopeFn: () => RID, responses: [EMPTY] }); // mirrorResult undefined → 无入口
  sb.api.loadModels('s1');
  const st = sb.state();
  assert.strictEqual(st.modelsLoaded, false, '无自愈入口时不得锁成已加载');
  assert.ok(sb.renderCalls() >= 1, '应渲染空表文案');
});

test('b4 本地空表：维持原路径（不触发远端自愈），remoteMirrorSync 不被调用', () => {
  const sb = makeSandbox({ scopeFn: () => null, responses: [EMPTY], mirrorResult: { synced: true } });
  sb.api.loadModels('s1');
  assert.strictEqual(sb.mirrorCalls.length, 0, '本地空表不得触发远端镜像自愈');
  // 本地空表走正常解析分支：list 为空 → modelsLoaded=true（原行为，区别于远端可疑态）
  assert.strictEqual(sb.state().modelsLoaded, true, '本地空表维持原「已加载」语义');
});

/* ========================================================================
 * c) 事件联动：mirror-synced / workspace:changed / connections-changed → stale + 去抖重载
 * ====================================================================== */
test('c1 事件接线：三事件均注册到 scheduleModelsReload（mirror-synced/connections-changed 在 window，workspace:changed 在 document）', () => {
  const sb = makeSandbox({ scopeFn: () => null });
  assert.ok(sb.listeners.win['gourd:mirror-synced'], '应监听 window gourd:mirror-synced');
  assert.ok(sb.listeners.win['remote:connections-changed'], '应监听 window remote:connections-changed');
  assert.ok(sb.listeners.doc['workspace:changed'], '应监听 document workspace:changed');
});

test('c2 mirror-synced 事件：置 modelsListStale=true，300ms 去抖后重载一次', () => {
  const sb = makeSandbox({ scopeFn: () => RID, responses: [NON_EMPTY] });
  const before = sb.loadCalls();
  sb.listeners.win['gourd:mirror-synced'][0]({ detail: { connectionId: RID } });
  assert.strictEqual(sb.state().modelsListStale, true, '事件后应立即置 stale');
  assert.strictEqual(sb.loadCalls(), before, '去抖窗口内不得立即重载');
  sb.advance(299);
  assert.strictEqual(sb.loadCalls(), before, '299ms 时仍不应重载');
  sb.advance(1);
  assert.strictEqual(sb.loadCalls(), before + 1, '300ms 后应重载恰好一次');
});

test('c3 去抖防风暴：连续多次事件只重载一次', () => {
  const sb = makeSandbox({ scopeFn: () => RID, responses: [NON_EMPTY] });
  const before = sb.loadCalls();
  const h = sb.listeners.win['remote:connections-changed'][0];
  h({}); h({}); h({});
  sb.listeners.doc['workspace:changed'][0]({});
  sb.advance(1000);
  assert.strictEqual(sb.loadCalls(), before + 1, '多次事件经去抖只重载一次');
});

/* ========================================================================
 * d) 源码契约：refreshSessionModel 拼 __scope；app-remote synced 分支 dispatch
 * ====================================================================== */
test('d1 refreshSessionModel 用 modelsScopeSegment + join(&) 拼单一 __scope（不裸拼 url）', () => {
  const fn = cutTopFn(history, 'function refreshSessionModel(sessionId)');
  assert.ok(fn.includes('modelsRequestScope()'), 'refreshSessionModel 应解析归属');
  assert.ok(fn.includes('modelsScopeSegment(scope)'), 'refreshSessionModel 应经 modelsScopeSegment 拼 __scope');
  assert.ok(fn.includes(".join('&')"), 'refreshSessionModel 应用数组 join(&) 保证参数各一次');
  assert.ok(!fn.includes("'/web/chat/models?sessionId=' + encodeURIComponent(sessionId);"),
    '不得保留旧的裸 url 拼接形态');
});

test('d2 app-remote：onRemoteMirror 的 synced 分支 dispatch gourd:mirror-synced（带 connectionId）', () => {
  assert.ok(remote.includes("if (payload.synced) {"), 'synced 分支应存在');
  assert.ok(remote.includes("window.dispatchEvent(new CustomEvent('gourd:mirror-synced', { detail: { connectionId: payload.connectionId } }))"),
    'synced=true 应 dispatch gourd:mirror-synced 并带 connectionId');
});

test('d3 loadModels 远端空表分支：不置 modelsLoaded=true，置 stale，调 handleRemoteEmptyModels', () => {
  const fn = cutTopFn(history, 'function loadModels(sessionId, callback)');
  assert.ok(fn.includes("list.length === 0 && scope !== 'local'"), '应有「远端空表」判定');
  assert.ok(fn.includes('handleRemoteEmptyModels(scope, sessionId, callback)'), '应接入自愈入口');
  assert.ok(fn.includes('delete healedByScope[scope]'), '非空成功应清除自愈标记（允许日后真实回归再自愈）');
});
