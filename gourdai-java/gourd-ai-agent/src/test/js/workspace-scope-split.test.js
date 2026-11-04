'use strict';
/* 行为级验证：app-workspace.js 的 loadProjects 在「并存语义」（连接≠切换环境）下的真实执行。
 *
 * 语义（2026-10-07 拍板，ZCode 对齐）：
 *   - 主拉取恒为「本地那份」：/web/chat/projects?__scope=local（不随激活 scope 漂移）；
 *   - 连着远端时补拉 ?__scope=id:<rid> 一份，合并后每条带 _scope；
 *   - 主拉取失败：保持旧缓存原样、绝不与远端项合并（陈旧缓存+远端项=重复条目）；
 *   - settle 后若当前选中项能查到 _scope，重声明归属（绑定自愈：路由表丢失后
 *     不依赖用户重点一次）。
 *
 * 手法沿用本仓沙箱范式：从真实源码切出函数体，new Function 注入桩环境执行。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const STATIC = path.join(__dirname, '..', '..', 'main', 'resources', 'static');
const ws = fs.readFileSync(path.join(STATIC, 'js', 'app-workspace.js'), 'utf8').replace(/\r\n/g, '\n');
const base = fs.readFileSync(path.join(STATIC, 'js', 'app-base.js'), 'utf8').replace(/\r\n/g, '\n');

/** 从源码切出一个完整函数（含闭合大括号）。 */
function cutFn(src, header) {
  const at = src.indexOf(header);
  assert.ok(at >= 0, '函数缺失: ' + header);
  const body = src.slice(at);
  const end = body.search(/\n    \}\n/);
  assert.ok(end > 0, '函数收尾定位失败: ' + header);
  return body.slice(0, end + 6);
}

/** 切顶层函数（app-base.js 无 IIFE，闭合括号在第 0 列，cutFn 的四缩进规则不适用）。 */
function cutTopFn(src, header) {
  const at = src.indexOf(header);
  assert.ok(at >= 0, '顶层函数缺失: ' + header);
  const body = src.slice(at);
  const end = body.search(/\n\}/);
  assert.ok(end > 0, '顶层函数收尾定位失败: ' + header);
  return body.slice(0, end + 2);
}

/** 构造可执行沙箱：$.get 返回可控 deferred，projectsCache/applyChatWorkspace 由外部注入。 */
function sandbox(opts) {
  const state = {
    localData: opts.localData,            // undefined = 本地拉取失败
    remoteData: opts.remoteData,          // undefined = 远端拉取失败
    activeId: opts.activeId || null,
    currentSelection: opts.currentSelection || '',
    applyCalls: [],                       // applyChatWorkspace 调用记录（自愈【不得】再走它：会关下拉）
    bindCalls: [],                        // 绑定自愈的 remoteBindScope 声明记录
    renderCount: 0,
    cbArg: null,
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
  const $ = {};
  $.get = (url) => { const d = makeDeferred(); pendings.push({ url, d }); return d; };

  const src = [
    'var projectsCache = [];',
    /* 【绿色假象修正】上一版在这里硬写了一份旧的 pathKey 实现（无条件 lower）。
       生产代码后来改成「仅 Windows 路径降大小写」，而沙箱里的副本照旧 → 8/8 全绿
       但测的是抄件，不是真码。沙箱一律从真实源码切函数体，不得自己抄一份。 */
    cutTopFn(base, 'function pathScopeKey(p)'),
    /* 主机展示名 helper（app-base 顶层）：同样从真实源码切，不得在沙箱里写副本。
       上一轮踩过的坑（见下方【绿色假象修正】注释）：沙箱拄旧实现会 8/8 全绿
       但测的是拄件。 */
    cutTopFn(base, 'function remoteHostLabel(scope)'),
    'function trimTrail(p) { return (p || "").replace(/[\\\\/]+$/, ""); }',
    cutFn(ws, 'function pathKey(p)'),
    cutFn(ws, 'function scopeOfPath(path)'),
    cutFn(ws, 'function bindWorkspaceScope(path)'),
    cutFn(ws, 'function loadProjects(cb)'),
    'function renderSelectors(){ state.renderCount++; }',
    'return { loadProjects: loadProjects, getCache: function(){ return projectsCache; },',
    '  setCache: function(v){ projectsCache = v; } };',
  ].join('\n');
  const fn = new Function('window', 'state', '$', 'GourdI18n', 'showToast', 'esc', src);
  const win = {
    __GOURD_REMOTE_ACTIVE_ID__: () => state.activeId,
    __GOURD_REMOTE_ACTIVE__: () => !!state.activeId,
    /* 主机展示名由 app-remote 维护（连接 → user@host）；沙箱用可注入的映射桩，
       并记录调用以便断言「主机名确实取自连接而非硬编码」。 */
    __remoteHostLabel: (id) => {
      if (!id) return '';
      state.hostLabelCalls = (state.hostLabelCalls || 0) + 1;
      return (state.hostLabels && state.hostLabels[id]) || '';
    },
    currentChatWorkspace: state.currentSelection,
    applyChatWorkspace: (p, silent) => { state.applyCalls.push({ path: p, silent: !!silent }); },
    /* 壳绑定入口桩：bindWorkspaceScope 经它声明归属（记录 path/id 供断言） */
    __GOURD_IPC__: {
      remoteBindScope: (p, id) => { state.bindCalls.push({ path: p, id: id }); return Promise.resolve(true); },
    },
  };
  const core = fn(win, state, $, { t: (k) => k }, () => {}, (s) => String(s));
  const api = {
    loadProjects: core.loadProjects,
    getCache: core.getCache,
    setCache: core.setCache,
    pend: () => pendings,
  };
  return { api, state, settleAll: () => {
    for (const p of pendings) {
      const isLocal = p.url.includes('__scope=local');
      const ok = isLocal ? state.localData !== undefined : state.remoteData !== undefined;
      p.d._settle(ok, ok ? { code: 200, data: isLocal ? state.localData : state.remoteData } : null);
    }
  } };
}

test('本地态（无远程连接）：只发一个请求，且显式 __scope=local（主拉恒本地）', () => {
  const s = sandbox({ localData: [{ name: 'A', path: '/a' }] });
  let called = false;
  s.api.loadProjects(() => { called = true; });
  assert.equal(s.api.pend().length, 1, '本地态不得多发远端请求');
  assert.ok(s.api.pend()[0].url.includes('__scope=local'), '主拉取必须显式 __scope=local');
  s.settleAll();
  assert.equal(called, true, '回调必须触发');
  assert.equal(s.api.getCache()[0]._scope, 'local', '无连接时来源必须是 local');
});

test('远程态：主拉本地 + 补拉远端（id 编码），本地在前', () => {
  const s = sandbox({
    activeId: 'rc-h:22:u',
    localData: [{ name: 'L', path: '/home/u/local' }],
    remoteData: [{ name: 'R', path: '/srv/remote' }],
  });
  s.api.loadProjects();
  const urls = s.api.pend().map((p) => p.url);
  assert.equal(urls.length, 2, '必须拉两份');
  assert.ok(urls[0].includes('__scope=local'), '主拉取恒本地');
  assert.ok(urls[1].includes('__scope=id:'), '远端拉取必须带 __scope=id');
  assert.ok(urls[1].includes(encodeURIComponent('rc-h:22:u')), 'connectionId 必须 encodeURIComponent（冒号→%3A，代理侧解码查表）');
  s.settleAll();
  const c = s.api.getCache();
  assert.equal(c.length, 2);
  assert.equal(c[0].path, '/home/u/local', '本地在前（默认环境心智）');
  assert.equal(c[0]._scope, 'local');
  assert.equal(c[1].path, '/srv/remote');
  assert.equal(c[1]._scope, 'rc-h:22:u');
});

test('主拉取（本地）失败：绝不与远端项合并（陈旧缓存+远端项=重复条目）', () => {
  const s = sandbox({ activeId: 'rc-a', localData: undefined, remoteData: [{ name: 'R', path: '/srv/r' }] });
  s.api.setCache([{ name: 'STALE', path: '/stale/one' }]);
  s.api.loadProjects();
  s.settleAll();
  const c = s.api.getCache();
  assert.equal(c.length, 1, '必须保持旧缓存原样，不得混入远端项');
  assert.equal(c[0].name, 'STALE');
});

test('远端那份拉取失败：本地项仍可用', () => {
  const s = sandbox({ activeId: 'rc-a', localData: [{ name: 'L', path: '/home/u/x' }], remoteData: undefined });
  s.api.loadProjects();
  s.settleAll();
  const c = s.api.getCache();
  assert.equal(c.length, 1);
  assert.equal(c[0].path, '/home/u/x');
});

test('同路径同时存在于两台：方案B 并存（选中时按条目 _scope 精确绑定）', () => {
  /* 【契约翻转】旧断言「同路径去重保留本地」的前提是 by_cwd 一个键只能绑一个上游、
     用户选不到第二份。方案B 起选中即按条目 _scope 声明归属（bind_scope 精确到连接），
     两台同名目录是两个真实工作区，必须都可选（用户拍板：随意连接多个远端地址）。 */
  const s = sandbox({
    activeId: 'rc-a',
    localData: [{ name: 'L', path: '/dup/proj' }],
    remoteData: [{ name: 'R', path: '/dup/proj/' }],
  });
  s.api.loadProjects();
  s.settleAll();
  const c = s.api.getCache();
  assert.equal(c.length, 2, '同路径跨来源必须并存（去重键含 scope）');
  assert.equal(c[0]._scope, 'local', '本地那份在前');
  assert.equal(c[1]._scope, 'rc-a', '远端那份带自己的归属');
});

/* 【P1 回归】归一口径必须与 Rust 侧 scope_key 一致：只有 Windows 风格路径才降大小写。
   旧实现（以及本测试沙里拄的那份副本）无条件 lower，会把下面两个**真实存在的不同
   目录**当作同一个去重，连带把本地那个归给远端（跳机读写）。 */
test('POSIX 仅大小写不同的两个目录（本地/远端）必须各自保留，不被误去重', () => {
  const s = sandbox({
    activeId: 'rc-a',
    localData: [{ name: 'ProjLocal', path: '/home/u/Proj' }],
    remoteData: [{ name: 'ProjRemote', path: '/home/u/proj' }],
  });
  s.api.loadProjects();
  s.settleAll();
  const c = s.api.getCache();
  assert.equal(c.length, 2, '两个大小写不同的 POSIX 目录必须都被保留（合并列表不能丢项）');
  assert.equal(c[0]._scope, 'local', '本地那份在前');
  assert.equal(c[1]._scope, 'rc-a', '远端那份带自己的归属');
  assert.equal(c[0].path, '/home/u/Proj', '本地项必须保持原路径（大小写不得被改写）');
});

test('Windows 风格路径仍按旧语义归一（盘符大小写不敏感 + 分隔符可混用）', () => {
  const s = sandbox({
    activeId: 'rc-a',
    localData: [{ name: 'W', path: 'D:\\Work\\Proj' }],
    remoteData: [{ name: 'WSame', path: 'd:/work/proj/' }],
  });
  s.api.loadProjects();
  s.settleAll();
  const c = s.api.getCache();
  /* 【契约翻转·同上一案】归一后同键但来源不同：本地 D 盘目录与远端 d:/work/proj
     是两个真实工作区，方案B 起并存可选（选中时按 _scope 精确绑定，不会误写）。 */
  assert.equal(c.length, 2, '归一同键跨来源必须并存（去重键含 scope）');
  assert.equal(c[0]._scope, 'local', '本地那份在前');
  assert.equal(c[1]._scope, 'rc-a', '远端那份带自己的归属');
});

test('绑定自愈：选中远端工作区时 settle 后重声明归属（不用等用户重点）', () => {
  const s = sandbox({
    activeId: 'rc-a',
    currentSelection: '/srv/remote',
    localData: [{ name: 'L', path: '/home/u/local' }],
    remoteData: [{ name: 'R', path: '/srv/remote' }],
  });
  s.api.loadProjects();
  s.settleAll();
  assert.equal(s.state.bindCalls.length, 1, '选中项能查到 _scope 时必须重声明一次');
  assert.equal(s.state.bindCalls[0].path, '/srv/remote');
  assert.equal(s.state.bindCalls[0].id, 'rc-a', '归属必须是条目自己的 _scope（不是 activeId 兜底）');
  /* 【回归钉·远程态下拉闪现消失】自愈曾走 applyChatWorkspace → selectChatWorkspace
     的 closeAll 把刚打开的下拉关掉（下拉每次打开都重跑 loadProjects，远程态自愈必触发）。
     自愈唯一目的是向壳重声明归属，必须直调 bindWorkspaceScope、零 UI 副作用。 */
  assert.equal(s.state.applyCalls.length, 0,
    '自愈不得走 applyChatWorkspace：它进 selectChatWorkspace 会 closeAll 关掉正在打开的下拉');
});

test('绑定自愈不误触发：选本地目录/无选择时不重声明', () => {
  const s1 = sandbox({
    activeId: 'rc-a',
    currentSelection: '/home/u/local',
    localData: [{ name: 'L', path: '/home/u/local' }],
    remoteData: [{ name: 'R', path: '/srv/r' }],
  });
  s1.api.loadProjects();
  s1.settleAll();
  assert.equal(s1.state.bindCalls.length, 0, '选本地项不需要重声明（bind(local) 已幂等）');

  const s2 = sandbox({
    activeId: 'rc-a',
    currentSelection: '',
    localData: [{ name: 'L', path: '/l' }],
    remoteData: [{ name: 'R', path: '/r' }],
  });
  s2.api.loadProjects();
  s2.settleAll();
  assert.equal(s2.state.bindCalls.length, 0, '无选择不重声明');
});

test('两个请求都结算后才回调（不得只挂一个 always 导致永挂）', () => {
  const s = sandbox({ activeId: 'rc-a', localData: [{ name: 'L', path: '/l' }], remoteData: [{ name: 'R', path: '/r' }] });
  let called = 0;
  s.api.loadProjects(() => { called++; });
  s.api.pend()[0].d._settle(true, { code: 200, data: [{ name: 'L', path: '/l' }] });
  assert.equal(called, 0, '单请求完成不得提前回调');
  s.api.pend()[1].d._settle(true, { code: 200, data: [{ name: 'R', path: '/r' }] });
  assert.equal(called, 1);
});
