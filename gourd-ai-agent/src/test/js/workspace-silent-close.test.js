'use strict';
/* 行为级回归：远程工作区下「工作区选择弹层闪现消失」。
 *
 * 用户实测缺陷（2026-10-17）：选中远程工作区后点「选择项目」，弹层闪现一下即消失。
 * 根因链（确定复现，非竞态）：
 *   下拉每次打开 → renderDropdown → loadProjects 多路扇出；
 *   settle 后「绑定自愈」分支在【选中项归属=远端 scope】时必触发（仅远程态，本地态不进）；
 *   旧自愈走 window.applyChatWorkspace(current, true) → selectChatWorkspace →
 *   函数头无条件 closeAll() → 把刚打开的下拉关掉（HTTP settle 后数十~数百 ms，观感=闪现）。
 * 修复两点：
 *   1) 自愈直调 bindWorkspaceScope（唯一目的=向壳重声明归属，零 UI 副作用）；
 *   2) selectChatWorkspace 的 closeAll 加门：silent 且选择未变 = 纯状态重声明，不关下拉
 *      （历史恢复/断开回退等程序化同值调用同样不再误关正在打开的下拉）。
 *
 * 手法沿用本仓沙箱范式：从真实源码切函数体 new Function 注入桩环境执行，
 * 禁止在沙箱里抄实现副本（workspace-scope-split.test.js 的【绿色假象修正】教训）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const STATIC = path.join(__dirname, '..', '..', 'main', 'resources', 'static');
const ws = fs.readFileSync(path.join(STATIC, 'js', 'app-workspace.js'), 'utf8').replace(/\r\n/g, '\n');
const base = fs.readFileSync(path.join(STATIC, 'js', 'app-base.js'), 'utf8').replace(/\r\n/g, '\n');

/** 从源码切出一个完整函数（含闭合大括号，四缩进顶层函数）。 */
function cutFn(src, header) {
  const at = src.indexOf(header);
  assert.ok(at >= 0, '函数缺失: ' + header);
  const body = src.slice(at);
  const end = body.search(/\n    \}\n/);
  assert.ok(end > 0, '函数收尾定位失败: ' + header);
  return body.slice(0, end + 6);
}

/** 切顶层函数（app-base.js 无 IIFE，闭合括号在第 0 列）。 */
function cutTopFn(src, header) {
  const at = src.indexOf(header);
  assert.ok(at >= 0, '顶层函数缺失: ' + header);
  const body = src.slice(at);
  const end = body.search(/\n\}/);
  assert.ok(end > 0, '顶层函数收尾定位失败: ' + header);
  return body.slice(0, end + 2);
}

/* ---------- 最小 DOM 桩 ---------- */
function makeEl(classes) {
  const set = new Set(classes || []);
  return {
    classList: {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle: (c, on) => { if (on) set.add(c); else set.delete(c); },
    },
    _classes: set,
  };
}

/** 沙箱：真实 selectChatWorkspace/closeAll/loadProjects/bindWorkspaceScope + DOM 桩。
 *  opts.currentSelection：window.currentChatWorkspace 初值；opts.open：下拉初始是否打开。 */
function sandbox(opts) {
  const state = {
    localData: opts.localData,
    remoteData: opts.remoteData,
    activeId: opts.activeId || null,
    bindCalls: [],
    renderCount: 0,
  };
  const sel = makeEl(['workspace-selector']);
  if (opts.open !== false) sel.classList.add('open');
  const doc = {
    querySelectorAll: (s) => (s === '.workspace-selector.open'
      ? (sel.classList.contains('open') ? [sel] : [])
      : []),
    dispatchEvent: () => {},
    addEventListener: () => {},
  };
  function makeDeferred() {
    const d = { _done: [], _always: [] };
    d.done = (f) => { d._done.push(f); return d; };
    d.always = (f) => { d._always.push(f); return d; };
    d._settle = (ok, payload) => {
      d.responseJSON = ok ? payload : undefined;
      if (ok) d._done.forEach((f) => f(payload));
      d._always.forEach((f) => f());
    };
    return d;
  }
  const pendings = [];
  const $ = { get: (url) => { const d = makeDeferred(); pendings.push({ url, d }); return d; } };

  const src = [
    'var projectsCache = [];',
    cutTopFn(base, 'function pathScopeKey(p)'),
    cutTopFn(base, 'function remoteHostLabel(scope)'),
    /* meta/defaultWorkspace/trimTrail/toSelection 四连（cutFn 止于 toSelection 闭合，
       一次切全，避免沙箱抄副本） */
    cutFn(ws, 'function meta()'),
    cutFn(ws, 'function pathKey(p)'),
    cutFn(ws, 'function persist()'),
    cutFn(ws, 'function scopeOfPath(path)'),
    cutFn(ws, 'function bindWorkspaceScope(path)'),
    cutFn(ws, 'function closeAll()'),
    cutFn(ws, 'function selectChatWorkspace(path, silent)'),
    'function renderSelectors(){ state.renderCount++; }',
    cutFn(ws, 'function loadProjects(cb)'),
    /* 与生产 window.applyChatWorkspace 同语义的包装（silent !== false 归一） */
    'function applyChatWorkspace(path, silent){ selectChatWorkspace(path, silent !== false); }',
    'return { loadProjects: loadProjects, selectChatWorkspace: selectChatWorkspace,',
    '  applyChatWorkspace: applyChatWorkspace, getCache: function(){ return projectsCache; },',
    '  setCache: function(v){ projectsCache = v; } };',
  ].join('\n');
  const fn = new Function('window', 'document', 'state', '$', 'GourdI18n', 'showToast', 'esc',
    'localStorage', 'CustomEvent', src);
  const win = {
    __appMeta: { workspace: '/home/u/global' },
    currentChatWorkspace: opts.currentSelection || '',
    __GOURD_REMOTE_ACTIVE_ID__: () => state.activeId,
    __GOURD_REMOTE__: { list: () => (state.activeId ? [{ connectionId: state.activeId, state: 'connected' }] : []) },
    __GOURD_IPC__: {
      remoteBindScope: (p, id) => { state.bindCalls.push({ path: p, id: id }); return Promise.resolve(true); },
    },
  };
  const ls = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const core = fn(win, doc, state, $, { t: (k) => k }, () => {}, (s) => String(s), ls,
    function CustomEvent() {});
  /* 生产的自愈/外部调用经 window.applyChatWorkspace 进选择链：构造后接线 */
  win.applyChatWorkspace = core.applyChatWorkspace;
  return {
    core, state, sel, win,
    settleAll: () => {
      for (const p of pendings) {
        const isLocal = p.url.includes('__scope=local');
        const ok = isLocal ? state.localData !== undefined : state.remoteData !== undefined;
        p.d._settle(ok, ok ? { code: 200, data: isLocal ? state.localData : state.remoteData } : null);
      }
    },
    pend: () => pendings,
  };
}

test('回归·远程态端到端：下拉打开中 loadProjects 自愈结算后下拉必须仍开着', () => {
  /* 缺陷现场全链复现：选中远端工作区 + 有在线连接 + 下拉打开 → 打开动作触发 loadProjects，
     settle 后自愈重声明归属；旧实现自愈走 applyChatWorkspace → closeAll → 弹层闪现消失。 */
  const s = sandbox({
    activeId: 'rc-a',
    currentSelection: '/srv/remote',
    localData: [{ name: 'L', path: '/home/u/local' }],
    remoteData: [{ name: 'R', path: '/srv/remote' }],
    open: true,
  });
  s.core.loadProjects(() => {});
  assert.equal(s.sel.classList.contains('open'), true, '结算前下拉应仍打开');
  s.settleAll();
  assert.equal(s.state.bindCalls.length, 1, '自愈必须重声明归属一次');
  assert.equal(s.state.bindCalls[0].id, 'rc-a', '归属必须是条目自己的 _scope');
  assert.equal(s.sel.classList.contains('open'), true,
    '自愈结算后下拉不得被关闭（用户实测「远程工作区弹层闪现消失」）');
});

test('silent + 同值 = 纯状态重声明：不得关下拉', () => {
  const s = sandbox({ currentSelection: '/srv/remote', open: true });
  s.core.selectChatWorkspace('/srv/remote', true);
  assert.equal(s.sel.classList.contains('open'), true, 'silent 同值调用不得关下拉');
});

test('silent + 不同值（程序化切换）：照关下拉', () => {
  const s = sandbox({ currentSelection: '/srv/remote', open: true });
  s.core.selectChatWorkspace('/home/u/other', true);
  assert.equal(s.sel.classList.contains('open'), false, 'silent 但选择变化仍须关下拉');
  assert.equal(s.win.currentChatWorkspace, '/home/u/other');
});

test('非 silent + 同值（用户重复点当前项）：照关下拉（原语义保持）', () => {
  const s = sandbox({ currentSelection: '/srv/remote', open: true });
  s.core.selectChatWorkspace('/srv/remote');
  assert.equal(s.sel.classList.contains('open'), false, '用户做出选择（含重复点当前项）须关下拉');
});

test('非 silent 清空选择：照关下拉', () => {
  const s = sandbox({ currentSelection: '/srv/remote', open: true });
  s.core.selectChatWorkspace('');
  assert.equal(s.sel.classList.contains('open'), false);
  assert.equal(s.win.currentChatWorkspace, '');
});

test('silent 清空且本就无选择（断开回退形态）：不得关下拉', () => {
  const s = sandbox({ currentSelection: '', open: true });
  s.core.selectChatWorkspace('', true);
  assert.equal(s.sel.classList.contains('open'), true, '同值重声明不得关正在打开的下拉');
});

/* ---------- 源码形状护栏（防沙箱与生产漂移之外的回潮） ---------- */

/* 剥离注释后再做词禁断言：WHY 注释里会出现被禁词本身（用来说明「不得走它」），
   不剥注释则护栏恒红/或为过护栏把注释改得含糊——两者都毁掉注释的价值。
   本切片字符串字面量不含 //（URL 均以 /web 开头），行注释可安全整段剥。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('形状护栏：loadProjects 内不得再出现 applyChatWorkspace（自愈回潮即关下拉）', () => {
  const lp = stripComments(ws.slice(ws.indexOf('function loadProjects(cb)'), ws.indexOf('function renderSelectors')));
  assert.ok(lp.length > 200 && lp.indexOf('function renderDropdown') < 0, '切片必须真切开');
  assert.doesNotMatch(lp, /applyChatWorkspace/,
    '自愈走 applyChatWorkspace 会经 selectChatWorkspace 的 closeAll 关掉正在打开的下拉');
  assert.match(lp, /bindWorkspaceScope\(window\.currentChatWorkspace\)/, '自愈必须直调 bindWorkspaceScope');
});

test('形状护栏：selectChatWorkspace 的 closeAll 必须带 silent-同值 门（不得裸调）', () => {
  const sel = ws.slice(ws.indexOf('function selectChatWorkspace(path, silent)'), ws.indexOf('/* 供 app-history 切换历史会话时恢复所属工作空间'));
  assert.ok(sel.indexOf('function bindWorkspaceScope') < 0, '切片必须真切开');
  assert.doesNotMatch(sel, /^\s*closeAll\(\);/m, '裸 closeAll 回潮 = 远程态弹层闪现消失复发');
  assert.match(sel, /if \(!\(silent && sel === window\.currentChatWorkspace\)\) closeAll\(\);/,
    'closeAll 必须门控：silent 且选择未变 = 纯重声明，不关下拉');
});
