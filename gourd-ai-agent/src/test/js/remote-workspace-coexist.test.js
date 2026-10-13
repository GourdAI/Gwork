'use strict';
/* 并存语义回归（2026-10-07 CR4 轮）：远程工作区连接后**不得覆盖本地工作区内容**。
 *
 * 本轮抓到的缺陷形态（全部是「本地内容被远端动作影响」）：
 *   P0-1 app-code.js 三处写操作用后端返回的【单一上游完整列表】直接覆盖 projects
 *        （`projects = resp.data`）→ 本地项目从下拉与欢迎页「最近项目」消失；
 *        且覆盖后 _scope 全丢 → scopeOfProjectPath 回落激活环境 → 本地项目被误绑
 *        远端（跳机读写）。
 *   P0-2 app-history.js code 模式拿「是否存在远程连接」当归属，而不是「当前项目属于
 *        哪台」→ 选着本地项目却连着远端时，会话请求带 scope=id 打到远端，本地会话
 *        列表被远端那份整个覆盖；且 root 为空时拼出两个 scope 参数，route_for 首个
 *        命中即返回 → 远端全局会话永远拉不到。
 *   P1-1 openDirPicker 的 scopeQ 以 `&` 起头，首次浏览 p 为空时 URL 无 `?` →
 *        拼出 `/browse&__scope=id:x`：scope 被当成路径段（代理回落激活上游）+ 404。
 *   P1-2 条目 title 的主机名靠 _scopeHost，而全仓零赋值点（空承诺）。
 *   P2-1 app-code.js 未监听 projects:changed（另 4 个视图都监听了）→ 断开后 code
 *        模式残留远端项目条目。
 *   P2-2 toSelection/defKey 无条件 toLowerCase 判默认工作区 → Linux 上 /home/u/Proj
 *        被当成默认区 /home/u/proj，选择被静默丢弃。
 *
 * 两条铁律（都是踩过才写进来的）：
 *   1) 沙箱一律从**真实源码**切函数体，不得在测试里抄一份实现（上一轮踩过：沙箱硬写
 *      旧副本 → 全绿但测的是抄件）。
 *   2) 源码契约断言必须先 stripComments：本仓注释里大量出现「禁止的旧形态」作为
 *      反面教材（例如解释为什么不能用某个已废弃的接口），直接对原文断言会**自匹配**
 *      ——正向断言假绿、反向断言假红。这个坑已踩过 4 次。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const STATIC = path.join(__dirname, '..', '..', 'main', 'resources', 'static');
/** 工作树是 CRLF（git i/lf w/crlf），统一成 LF 再切片，否则含裸 \n 的 endMark 永不匹配。 */
function readJs(rel) {
  return fs.readFileSync(path.join(STATIC, 'js', rel), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * 删除注释（供源码契约断言用）。
 *
 * 【为何不用字符级状态机】前两版都卡在同一个坑：JS 的 `/` 既是除号又是正则
 * 开头，字符级区分需要完整词法上下文。实测踩雷：`typeof x === 'function')` 里的
 * `/`（前一个非空字符是 `)`，不在允许集里）本该是除号/普通字符，但启发式
 * 一旦判错就把后续大片代码当正则吃掉 → 反向断言全假红。自研词法器不可靠。
 *
 * 【改用无歧义的极简方案】本仓所有「禁止词反面教材」都在块注释或纯行注释里
 * （已逐个核实：savedHosts()[0]、__scopeOfRemoteRoot、history 的旧归属词）。
 * 故只需：① 非贪婪删块注释；② 删 trim 后以 // 开头的整行。不碰行尾 // 注释
 * （本仓禁止词不在那里），从而完全避开字符串/正则里的 `//`（如 URL）误删。
 * 正则字面量不含 `/*`，不会被块注释正则误伤（下方自检锁定）。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')                                  // 块注释
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');        // 纯行注释行
}

const codeRaw = readJs('app-code.js');
const workspaceRaw = readJs('app-workspace.js');
const historyRaw = readJs('app-history.js');
const baseRaw = readJs('app-base.js');
const remoteRaw = readJs('app-remote.js');

/* 原文用于「切函数体进沙箱」（注释不影响执行）；剥离版用于源码契约断言。 */
const code = stripComments(codeRaw);
const workspace = stripComments(workspaceRaw);
const history = stripComments(historyRaw);
const base = stripComments(baseRaw);
const remote = stripComments(remoteRaw);

/** 切 IIFE 内四缩进函数（含闭合大括号）。 */
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

function sliceBetween(src, startMark, endMark) {
  const s = src.indexOf(startMark);
  assert.ok(s >= 0, '起始标记必须存在: ' + startMark);
  const e = src.indexOf(endMark, s + startMark.length);
  assert.ok(e > s, '结束标记必须存在: ' + endMark);
  return src.slice(s, e);
}

/* ---------- 剥注释自检：剥多了会把正文当注释吃掉，导致断言测空气 ---------- */
test('自检：stripComments 未吃掉正文（关键锚点全部仍在）', () => {
  for (const [name, src, anchors] of [
    ['app-code.js', code, ['function activeScope()', 'function browseQuery(p, scopeQ)', 'function removeProject(', "document.addEventListener('projects:changed'"]],
    ['app-workspace.js', workspace, ['function toSelection(path)', 'function strictScopeOfPath(path)', 'function pick(resp, scope)']],
    ['app-history.js', history, ['function projNodeHostLabel(path)', "if (window.appMode === 'code')"]],
    ['app-base.js', base, ['function pathScopeKey(p)', 'function remoteHostLabel(scope)']],
    ['app-remote.js', remote, ['window.__remoteHostLabel = function (connectionId)', 'function applyConnection(outcome)']],
  ]) {
    for (const a of anchors) assert.ok(src.includes(a), name + ' 剥注释后丢了锚点: ' + a);
  }
  /* 反向自检：注释里的「反面教材」必须已被删掉，否则反向断言仍会自匹配假红。
     注：app-code 的 __GOURD_REMOTE_ACTIVE_ID__ 不能列进来——它是 scopeOfProjectPath
     回落分支的【合法代码】（写操作过渡期需要），剥离后本就该存在。 */
  assert.ok(!remote.includes('savedHosts()[0]'), 'app-remote 注释里的旧形态必须被删掉');
  assert.ok(!history.includes('__scopeOfRemoteRoot'), 'app-history 注释里的死引用说明必须被删掉');
  /* 注：不能对 __GOURD_REMOTE_ACTIVE_ID__ 做全文反向自检——它在 app-history 的 chat
     模式分支（双源合并拉远端那份）是【合法代码】，剥离后本就该存在。「code 分支不得
     用它当归属」的验证在专门的 P0-2 用例里按 slice 范围做，不能提到全文级。 */
  /* 【删注释不得吃掉代码】不用手写正则文本断言（反斜杠转义已错 3 次），
     改用无歧义的强不变量：function / => 关键字数量在删注释前后必须一致。
     若块注释正则误伤了正文（把代码当注释删），这两个计数必下降。 */
  const countFn = (s) => (s.match(/\bfunction\b/g) || []).length;
  const countArrow = (s) => (s.match(/=>/g) || []).length;
  for (const [name, raw, stripped] of [
    ['app-code.js', codeRaw, code],
    ['app-workspace.js', workspaceRaw, workspace],
    ['app-history.js', historyRaw, history],
    ['app-base.js', baseRaw, base],
    ['app-remote.js', remoteRaw, remote],
  ]) {
    /* 注释里也可能写 function 字样，故 stripped <= raw；但删注释不可能【增加】代码关键字，
       且正文的 function 必须全部保留 → 用「正文函数定义锚点仍在」+「不误删」双向锁定。
       这里取强约束：stripped 的 function 数 >= raw 里【非注释行】的 function 数。 */
    const codeLinesFn = countFn(raw.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'));
    assert.ok(countFn(stripped) >= codeLinesFn,
      name + ' 删注释后 function 数(' + countFn(stripped) + ') 少于正文行数统计(' + codeLinesFn + ')，疑似吃掉代码');
    assert.ok(countArrow(stripped) > 0 || countArrow(raw) === 0, name + ' 箭头函数不应被误删');
  }
  /* 抽样：几个含正则字面量的函数体必须完整存活（正则不含 `/*`，不会被块注释正则误伤）。 */
  assert.ok(workspace.includes('function trimTrail(p)'), 'trimTrail（含正则字面量）必须存活');
  assert.ok(remote.includes("replace(/\"/g, '&quot;')"), 'esc 的正则字面量（含引号）必须完整保留');
  assert.ok(code.includes("replace(/^[&?]/, '')"), 'browseQuery 的正则字面量必须完整保留');
});

/* ========================================================================
 * app-code.js 沙箱：activeScope / scopeQueryFor / findProjectPath / browseQuery
 * ====================================================================== */
function codeSandbox(opts) {
  const state = {
    projects: opts.projects || [],
    currentProjectRoot: opts.currentProjectRoot || '',
    activeId: opts.activeId || null,
  };
  const src = [
    cutTopFn(base, 'function pathScopeKey(p)'),
    cutFn(code, 'function pathKey(p)'),
    'var projects = state.projects;',
    cutFn(code, 'function activeScope()'),
    cutFn(code, 'function scopeQueryFor(scope)'),
    cutFn(code, 'function findProjectPath(path)'),
    cutFn(code, 'function browseQuery(p, scopeQ)'),
    'return { activeScope: activeScope, scopeQueryFor: scopeQueryFor,',
    '  findProjectPath: findProjectPath, browseQuery: browseQuery };',
  ].join('\n');
  const fn = new Function('window', 'state', src);
  /* currentProjectRoot 必须经 window 注入：activeScope 读的是 window.currentProjectRoot，
     沙箱里不注入就恒为空串 → 每个用例都走「无选中」分支（假绿）。 */
  const win = {
    __GOURD_REMOTE_ACTIVE_ID__: () => state.activeId,
    currentProjectRoot: state.currentProjectRoot,
  };
  return fn(win, state);
}

/* connectionId 真实形态含冒号（rc-<host>:<port>:<user>），用它才能验出编码需求。 */
const RID = 'rc-10.0.0.8:22:dev';

test('P0-2 归属判定：选着【本地】项目时，即使存在远程连接也必须返回本地', () => {
  /* 这是 P0-2 的核心：归属是「当前项目属于哪台」，不是「有没有连着远端」。
     若改用 __GOURD_REMOTE_ACTIVE_ID__() 当归属，本用例会返回 RID（变异即可杀死）。 */
  const s = codeSandbox({
    activeId: RID,
    currentProjectRoot: '/home/u/local-proj',
    projects: [
      { path: '/home/u/local-proj', _scope: 'local' },
      { path: '/srv/remote-proj', _scope: RID },
    ],
  });
  assert.equal(s.activeScope(), null, '本地项目的归属必须是 null（本地），不得回落激活连接');
});

test('P0-2 归属判定：选着【远端】项目时返回该连接 id', () => {
  const s = codeSandbox({
    activeId: RID,
    currentProjectRoot: '/srv/remote-proj',
    projects: [
      { path: '/home/u/local-proj', _scope: 'local' },
      { path: '/srv/remote-proj', _scope: RID },
    ],
  });
  assert.equal(s.activeScope(), RID);
});

test('归属判定：无选中项目 → 本地（默认环境；宁可多点一次也不静默往远端写）', () => {
  const s = codeSandbox({ activeId: RID, currentProjectRoot: '', projects: [{ path: '/srv/x', _scope: RID }] });
  assert.equal(s.activeScope(), null, '无 cwd 时不得用「存在连接」当归属');
});

test('归属判定：项目列表里查不到（尚未加载完）→ 保守当本地，不得回落激活连接', () => {
  /* 读路径必须保守：回落激活环境会把本地项目判成远端 → 会话列表被远端覆盖。
     这正是 scopeOfProjectPath 的兜底不能用于 code 模式会话分流的原因。 */
  const s = codeSandbox({
    activeId: RID,
    currentProjectRoot: '/home/u/not-in-list',
    projects: [{ path: '/srv/x', _scope: RID }],
  });
  assert.equal(s.activeScope(), null, '查不到归属时必须回本地（宁空列表也不展现另一台机器的会话）');
});

test('归属判定：_scope 缺失的条目（旧数据）→ 本地，不得回落激活连接', () => {
  const s = codeSandbox({
    activeId: RID,
    currentProjectRoot: '/srv/x',
    projects: [{ path: '/srv/x' }],
  });
  assert.equal(s.activeScope(), null);
});

test('归属判定：Windows 路径盘符/大小写差异仍能命中同一条目', () => {
  const s = codeSandbox({
    activeId: RID,
    currentProjectRoot: 'D:\\Work\\Proj',
    projects: [{ path: 'd:/work/proj', _scope: RID }],
  });
  assert.equal(s.activeScope(), RID, 'Windows 盘符大小写与分隔符差异必须归一到同一条目');
});

test('scopeQueryFor：一律显式声明归属（连 local 也写出来，不落激活兜底）', () => {
  const s = codeSandbox({});
  assert.equal(s.scopeQueryFor(null), '?__scope=local');
  assert.equal(s.scopeQueryFor('local'), '?__scope=local');
  assert.equal(s.scopeQueryFor(RID), '?__scope=id:' + encodeURIComponent(RID));
  assert.ok(s.scopeQueryFor(RID).includes('%3A'), 'connectionId 的冒号必须编码（代理侧解码查表，否则静默失配）');
});

test('findProjectPath：按归一键找回服务端认可的完整路径（含尾斜杠差异）', () => {
  const s = codeSandbox({ projects: [{ path: '/srv/proj/' }, { path: '/home/u/Proj' }] });
  assert.equal(s.findProjectPath('/srv/proj'), '/srv/proj/', '尾斜杠差异必须归一命中');
  assert.equal(s.findProjectPath('/HOME/U/PROJ'), '', 'POSIX 保留大小写：不同大小写不是同一路径');
  assert.equal(s.findProjectPath(''), '', '空路径返回空串');
});

/* ---------- P1-1：browseQuery 首次浏览必须产出合法 `?query` ---------- */
test('P1-1 browseQuery：首次浏览（p 为空）必须仍以 `?` 开头——否则 scope 被当成路径段', () => {
  const s = codeSandbox({});
  const q = s.browseQuery('', '&__scope=id:' + encodeURIComponent(RID));
  assert.ok(q.startsWith('?'), '必须以 ? 开头：旧拼串在此处产出 `/browse&__scope=...`（404 + scope 失效）');
  assert.ok(q.includes('__scope=id:' + encodeURIComponent(RID)), 'scope 必须作为 query 参数出现（id: 冒号字面，RID 内部冒号已编码为 %3A）');
  assert.ok(!q.includes('&&') && !q.includes('?&'), '不得出现空段（前导 & 必须被剥掉）');
});

test('P1-1 browseQuery：带 path 时 path 在前、scope 在后，且 path 经 encodeURIComponent', () => {
  const s = codeSandbox({});
  const q = s.browseQuery('/srv/我的 项目', '&__scope=local');
  assert.equal(q, '?path=' + encodeURIComponent('/srv/我的 项目') + '&__scope=local');
});

test('P1-1 browseQuery：无参数时返回空串（不留裸 `?`）', () => {
  const s = codeSandbox({});
  assert.equal(s.browseQuery('', ''), '');
  assert.equal(s.browseQuery('', undefined), '');
  assert.equal(s.browseQuery('', null), '');
});

test('P1-1 browseQuery：调用方传 `?` 起头也接受（两种写法都归一）', () => {
  const s = codeSandbox({});
  assert.equal(s.browseQuery('', '?__scope=local'), '?__scope=local');
});

/* ========================================================================
 * P0-1：写操作不得用单上游响应覆盖合并列表
 * ====================================================================== */
/**
 * 「不得用写操作响应覆盖 projects」的检测不变量：
 * app-code.js 里 `projects = <rhs>;` 只允许出现在 loadProjects 的合并写入点
 * （rhs = merged）。任何 rhs 含 resp 的赋值都是缺陷——后端 add/create/remove
 * 返回的是【单一上游的完整列表】，直接赋值会抹掉另一环境的条目并丢 _scope。
 *
 * 用「含 resp 就报」而不是枚举具体写法：上一版枚举 `resp.data || []` 与
 * `(resp && resp.data) ? ... : []` 两种，结果【漏掉了三目形态】——正是被下方
 * 负对照抓出来的。检测不变量要锁「不该出现的东西」，不要锁「我记得的写法」。
 */
function projectsAssignments(src) {
  const out = [];
  const re = /\bprojects\s*=\s*[^;\n]+;/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[0]);
  return out;
}

test('P0-1 app-code.js 不得出现「用写操作响应覆盖 projects」的形态', () => {
  const all = projectsAssignments(code);
  const bad = all.filter((s) => /\bresp\b/.test(s));
  assert.deepEqual(bad, [], 'app-code.js 不得用写操作响应覆盖 projects：' + JSON.stringify(bad));
  /* 唯一允许的赋值点：loadProjects 的合并结果。 */
  assert.ok(all.some((s) => /projects = merged;/.test(s)), 'projects 必须由合并结果写入');
  /* 负对照：证明检测函数真能检出所有缺陷形态（否则是恒真断言）。 */
  const probe = projectsAssignments([
    'projects = resp.data || [];',
    'projects = (resp && resp.data) ? resp.data : [];',
    'projects = resp.data;',
    'var x = 1;',
  ].join('\n'));
  assert.equal(probe.filter((s) => /\bresp\b/.test(s)).length, 3, '检测必须覆盖全部三种覆盖形态（含三目）');
});

test('P0-1 三处写操作（add/create/remove）都必须显式声明归属', () => {
  /* endMark 一律用【代码】锚点：注释会被 stripComments 剥掉，拿注释当结束标记
     会报「结束标记必须存在」，看起来像实现缺失（实际只是锚点选了注释）。 */
  const addSeg = sliceBetween(code, 'function addProject()', 'function newProject()');
  assert.match(addSeg, /var scopeQ = scopeQueryFor\(scope\)/, 'add 的归属必须在打开选择器那一刻锁定');
  assert.match(addSeg, /projects\/add' \+ scopeQ/, 'add 必须带显式 scope');
  assert.match(addSeg, /openDirPicker\(doAdd, scopeQ\)/, 'add 的目录浏览必须用同一归属（浏览哪台就登记哪台）');
  /* 重拉失败时必须补临时 _scope 记录：否则兜底选中刚登记的 path 时，
     selectProject 内部 scopeOfProjectPath 查不到会回落激活连接，把本地新目录
     误绑远端（跳机读写）。与 create 分支、app-workspace 消歧候选处同款。 */
  assert.match(addSeg, /_scope: scope \|\| 'local'/, 'add 重拉失败时必须补带正确 _scope 的临时记录');
  assert.match(addSeg, /var addedPath = findProjectPath\(path\)/, 'add 选中目标必须先查合并列表（拿服务端认可的路径）');

  const createSeg = sliceBetween(code, 'function newProject()', 'function browseQuery(p, scopeQ)');
  /* 锁行为不锁措辞：归属必须在【对话框打开那一刻】取一次 activeScope（而不是提交时
     再取，那会随选择漂移），并由它派生 npScopeQ。不能写死 `scopeQueryFor(activeScope())`
     这一种拼法：实现里为了让 create 成功后补临时 _scope 记录复用了 npScope，
     拆成了两行——锁措辞会把「拆行复用」这个正确重构误判为缺陷。 */
  assert.match(createSeg, /var npScope = activeScope\(\)/, 'create 的归属必须在打开对话框那一刻锁定（activeScope 只取一次）');
  assert.match(createSeg, /var npScopeQ = scopeQueryFor\(npScope\)/, 'npScopeQ 必须由锁定的归属派生');
  assert.match(createSeg, /projects\/create' \+ npScopeQ/, 'create 必须带显式 scope');
  assert.match(createSeg, /openDirPicker\(function \(picked\) \{ if \(picked\) \$parent\.val\(picked\); \}, npScopeQ\)/,
    'create 的父目录浏览必须用同一归属（不得跨机拼接：浏览远端磁盘却在本地建目录）');
  /* 重拉失败时必须补临时 _scope 记录（防 selectProject 回落激活连接误绑远端）。 */
  assert.match(createSeg, /_scope: npScope \|\| 'local'/, 'create 重拉失败时必须补带正确 _scope 的临时记录');

  const rmSeg = sliceBetween(code, 'function removeProject(', 'function resetCodeProjectForChannel');
  assert.match(rmSeg, /projects\/remove' \+ scopeQueryFor\(scope\)/, 'remove 必须带显式 scope');
  assert.match(rmSeg, /declaredScope/, 'remove 必须接受调用方声明的归属（侧栏副本与本模块列表可能不同步）');
});

test('P0-1 写操作成功后必须重拉合并列表（而不是用响应覆盖）', () => {
  const addSeg = sliceBetween(code, 'function addProject()', 'function newProject()');
  assert.match(addSeg, /loadProjects\(function \(\)/, 'add 成功后必须走 loadProjects 重拉合并');
  assert.match(addSeg, /findProjectPath\(path\)/, '新增项必须按归一键在合并列表里找回（不得用本地拼的字串直接选中）');
  assert.doesNotMatch(addSeg, /projects = resp/, 'add 不得直接赋值 projects');

  const rmSeg = sliceBetween(code, 'function removeProject(', 'function resetCodeProjectForChannel');
  assert.match(rmSeg, /loadProjects\(function \(\)/, 'remove 后必须重拉合并');
  assert.match(rmSeg, /\.always\(function \(\)/, 'remove 必须用 always：失败也要重拉，让列表回到真实状态');
  assert.doesNotMatch(rmSeg, /projects = \(resp/, 'remove 不得直接赋值 projects');

  const createSeg = sliceBetween(code, 'function newProject()', 'function browseQuery(p, scopeQ)');
  assert.match(createSeg, /loadProjects\(function \(\)/, 'create 成功后必须重拉合并');
  assert.doesNotMatch(createSeg, /projects = resp/, 'create 不得直接赋值 projects');
});

test('P0-1 loadProjects 必须有请求纪元（并发重拉时旧响应不得覆盖新结果）', () => {
  const lp = sliceBetween(code, 'function loadProjects(cb)', 'function pathKey(p)');
  assert.match(lp, /var myToken = \+\+_projectsReqToken/, '必须取纪元');
  const guards = (lp.match(/if \(myToken !== _projectsReqToken\) \{ return; \}/g) || []).length;
  assert.ok(guards >= 3, '主拉/远端补拉/finish 三处都要校验纪元，实测守卫数=' + guards);
  assert.match(lp, /projects = merged;/, '合并结果才是唯一写入点');
});

test('P2-1 app-code.js 必须监听 projects:changed（断开后清掉残留的远端条目）', () => {
  assert.match(code, /document\.addEventListener\('projects:changed', function \(\) \{ loadProjects\(\); \}\)/,
    'code 模式必须与其它四个视图一样重拉合并列表');
});

/* ========================================================================
 * P0-2：app-history.js code 模式会话分流
 * ====================================================================== */
test('P0-2 code 模式会话归属必须取【当前项目】而非「是否存在远程连接」', () => {
  const seg = sliceBetween(history, "if (window.appMode === 'code')", 'var myToken2 = ++_sidebarReqToken');
  assert.match(seg, /window\.__currentProjectScope/, '必须用 app-code 暴露的当前项目归属');
  /* 反向断言只能作用于剥注释后的源码：原注释里正写着「为什么不能用它」，
     对原文断言会假红（这个坑已踩 4 次）。 */
  assert.doesNotMatch(seg, /__GOURD_REMOTE_ACTIVE_ID__/,
    'code 分支不得用「是否存在远程连接」当归属（选本地项目+连着远端时会话会打到远端）');
});

test('P0-2 code 模式会话请求的 scope 只能压入一次（重复参数会让后者永远无效）', () => {
  /* route_for 按 query 顺序扫到第一个 scope 命中即返回。旧实现在 root 为空时拼出
     `?__scope=local&__scope=id:RID` → local 先命中 → 远端全局会话永取不到。 */
  const seg = sliceBetween(history, "if (window.appMode === 'code')", 'var myToken2 = ++_sidebarReqToken');
  const qBuild = sliceBetween(seg, 'var qParts = []', 'var myToken');
  const pushes = (qBuild.match(/qParts\.push\(/g) || []).length;
  assert.equal(pushes, 2, 'root 一次 + scope 一次（三元二选一），实测 push 次数=' + pushes);
  assert.match(qBuild, /qParts\.push\(codeScope/, '归属必须作为单个参数压入（三元二选一）');
  assert.match(qBuild, /var q = '\?' \+ qParts\.join\('&'\)/, '必须 join 成单一 query');
  assert.doesNotMatch(qBuild, /\+ '\?__scope=local'\)/, '不得出现「root 段 + scope 段」两段拼接的旧形态');
});

test('P0-2 app-code.js 必须暴露 __currentProjectScope 且指向严格版归属（不回落激活环境）', () => {
  assert.match(code, /window\.__currentProjectScope = activeScope/, '必须暴露给 app-history');
  /* activeScope 的兜底必须是 null（本地），而不是激活连接 id。 */
  const as = sliceBetween(code, 'function activeScope()', 'function scopeQueryFor(scope)');
  assert.match(as, /return null;/, '查不到必须回本地');
  assert.doesNotMatch(as, /__GOURD_REMOTE_ACTIVE_ID__/,
    '严格版归属不得有「回落激活连接」的兜底（读路径回落会把本地判成远端）');
  /* 【方案B 契约翻转】scopeOfProjectPath 的回落语义已移除：旧注释说「写操作过渡期
     需要回落」，但过渡期实际由「登记成功后补临时 _scope 记录」承担（add 分支
     projectsCache.push({_scope})），回落兜底在多连接下是跨机误绑根因（连第二台后
     第一台已选项目的写操作打到新连接）。查不到一律 null=local。 */
  const loose = sliceBetween(code, 'function scopeOfProjectPath(path)', 'function activeScope()');
  assert.doesNotMatch(loose, /__GOURD_REMOTE_ACTIVE_ID__/, 'scopeOfProjectPath 不得回落激活环境（跨机误绑根因）');
  assert.match(loose, /return null;/, '查不到必须回本地');
});

test('P3 死引用清除：__scopeOfRemoteRoot 全仓不得再有消费点（只写不定义的幽灵接口）', () => {
  /* 同样只能查剥注释后的源码：注释里正写着「已删死引用 __scopeOfRemoteRoot」的说明。 */
  for (const [name, src] of [['app-history.js', history], ['app-workspace.js', workspace], ['app-code.js', code], ['app-remote.js', remote], ['app-base.js', base]]) {
    assert.doesNotMatch(src, /__scopeOfRemoteRoot/, name + ' 仍引用从未定义的 __scopeOfRemoteRoot');
  }
});

/* ========================================================================
 * P1-2：主机展示名（对标 ZCode formatRemoteWorkspaceDisplayLabel 的 `[SSH: alias]`）
 * ====================================================================== */
test('P1-2 app-remote.js 必须维护「连接 → 主机展示名」映射并暴露查询', () => {
  assert.match(remote, /var hostLabelByConnection = Object\.create\(null\)/, '必须有按 connectionId 索引的映射');
  assert.match(remote, /window\.__remoteHostLabel = function \(connectionId\)/, '必须暴露查询函数');
  const q = sliceBetween(remote, 'window.__remoteHostLabel = function', 'window.__GOURD_REMOTE_ACTIVE__ = function');
  assert.match(q, /return hostLabelByConnection\[connectionId\] \|\| ''/, '查不到必须回空串（绝不展示 connectionId 内部键）');
  /* 两条写入路径都要登记：新连接 + 启动恢复（否则页面重载后主机名全丢）。 */
  const applySeg = sliceBetween(remote, 'function applyConnection(outcome)', 'function doConnect(cfg)');
  assert.match(applySeg, /hostLabelByConnection\[id\] = hostLabelOf\(outcome\)/, '连接成功必须登记（方案B：经局部 id 变量登记同一映射）');
  const bootSeg = sliceBetween(remote, '(function restoreOnBoot()', 'window.remoteMirrorSync = function');
  assert.match(bootSeg, /hostLabelByConnection\[(savedId|st\.connectionId)\] = hostLabelOf\((connectionsById\[savedId\]|st)\)/,
    '启动恢复必须登记（方案B：remoteList 主路径按 st.connectionId、旧壳回退按 savedId，均取自 Rust 回传）');
  /* 反向断言：不得用「最近连过的那台」冒充当前连接的主机（多机场景报错主机，
     与徽标同根缺陷 P2-C 已修过一次）。注释里有反面教材，故查剥注释后的源码。 */
  assert.doesNotMatch(remote, /savedHosts\(\)\[0\]/, '不得用 savedHosts 首项冒充当前连接的主机');
  /* 徽标与条目必须同源（口径不一致就会出现「徽标报 A、条目报 B」）。 */
  const badge = sliceBetween(remote, 'window.refreshRemoteBadge = function', 'old.innerHTML =');
  assert.match(badge, /hostLabelByConnection\[primary\.connectionId\] \|\| hostLabelOf\(primary\)/,
    '徽标必须与条目同源（先查共享映射、回落 hostLabelOf，口径一致）');
});

test('P1-2 app-base.js 必须提供统一 helper（两处合并点各写 typeof 守卫必漏）', () => {
  assert.match(base, /function remoteHostLabel\(scope\)/, '必须在全站最先加载的 app-base.js 定义');
  assert.match(base, /window\.remoteHostLabel = remoteHostLabel/, '必须挂到 window 供各模块使用');
  const h = cutTopFn(base, 'function remoteHostLabel(scope)');
  assert.match(h, /scope === 'local'/, '本地 scope 必须回空串');
  assert.match(h, /typeof window\.__remoteHostLabel !== 'function'/, '旧壳/浏览器端必须静默降级');
});

test('P1-2 两处合并列表都必须给远端条目补主机名（_scopeHost）', () => {
  const wsPick = sliceBetween(workspace, 'function pick(resp, scope)', 'var primaryOk = false;');
  assert.match(wsPick, /var label = remoteHostLabel\(scope\)/, 'app-workspace.pick 必须查主机名');
  assert.match(wsPick, /if \(label\) e\._scopeHost = label/, '必须写进条目（渲染层 title 读它）');

  const hPush = sliceBetween(history, 'var pushList = function (list, scope)', 'pushList(plist, ');
  assert.match(hPush, /var label = remoteHostLabel\(scope\)/, 'app-history.pushList 必须查主机名');
  assert.match(hPush, /_scopeHost: label/, '必须写进条目');
});

test('P1-2 渲染层必须消费 _scopeHost（否则是空承诺）', () => {
  const dd = sliceBetween(workspace, 'var isRemote = ', 'html += \'<div class="project-dropdown-item');
  assert.match(dd, /p\._scopeHost/, '工作区下拉条目的 title 必须含主机名');
  assert.match(history, /function projNodeHostLabel\(path\)/, '侧栏项目行必须有主机名查询');
  const pn = sliceBetween(history, 'function projNodeHtml(path, name, expanded)', '+ \'<svg class="proj-chevron"');
  assert.match(pn, /projNodeHostLabel\(path\)/, '项目行 title 必须接主机名');
});

/* ========================================================================
 * P1-1 消费面：写操作与浏览必须锁同一台机器
 * ====================================================================== */
test('P1-1「打开文件夹」链路必须恒本地（locate 扫盘 + 消歧候选登记）', () => {
  const locate = sliceBetween(workspace, 'function locateFolder(name, children)', 'function fallbackInputPicker(onPicked)');
  assert.match(locate, /projects\/locate\?__scope=local/, 'locate 必须锁本地：否则选中远端工作区后会去远端扫本机目录名');
  const cand = sliceBetween(workspace, 'if (pendingCandidates && pendingCandidates.indexOf(p) >= 0)', 'selectChatWorkspace(p);');
  assert.match(cand, /projects\/add\?__scope=local/, '消歧候选来自本机扫盘，登记必须回本地');
  assert.match(cand, /_scope: 'local'/, '消歧候选登记后必须补临时 _scope=local（重拉是异步的，紧接着的选中会查旧缓存回落激活环境）');
});

test('P1-1 removeProject 的归属优先用调用方声明值（侧栏副本与本模块列表可能不同步）', () => {
  const rm = sliceBetween(code, 'function removeProject(', 'function resetCodeProjectForChannel');
  assert.match(rm, /var scope = \(declaredScope && declaredScope !== 'local'\)/, 'declaredScope 优先');
  assert.match(rm, /scopeOfProjectPath\(path\)/, '未声明才查本模块列表');
  /* 侧栏调用点必须把自己已知的归属传进来（它渲染时就拿着 _scope，是确定事实）。 */
  const call = sliceBetween(history, "var dp = $projDel.closest('.proj-node').attr('data-proj')", 'return;');
  assert.match(call, /removeProjectFromList\(dp, projNodeScopeOf\(dp\)\)/, '侧栏必须传 _sidebarData 里的归属');
});

test('P1-1 projNodeScopeOf 查不到必须回本地（不得回落激活环境）', () => {
  const f = sliceBetween(history, 'function projNodeScopeOf(path)', 'function projScopeQuery(scope)');
  const locals = (f.match(/return 'local';/g) || []).length;
  assert.ok(locals >= 2, '列表未加载与未命中两条路径都必须回本地，实测=' + locals);
  assert.doesNotMatch(f, /__GOURD_REMOTE_ACTIVE_ID__/, '侧栏归属不得回落激活连接');
});

/* ========================================================================
 * P2-2：默认工作区判定不得无条件 lower
 * ====================================================================== */
test('P2-2 toSelection 必须走 pathScopeKey（POSIX 大小写不同的目录不是同一个）', () => {
  const src = [
    cutTopFn(base, 'function pathScopeKey(p)'),
    'var __appMeta = state.meta;',
    'function meta() { return __appMeta || {}; }',
    "function defaultWorkspace() { return meta().workspace || ''; }",
    cutFn(workspace, 'function trimTrail(p)'),
    cutFn(workspace, 'function toSelection(path)'),
    'return { toSelection: toSelection };',
  ].join('\n');
  const fn = new Function('window', 'state', src);
  const mk = (defWorkspace) => fn({}, { meta: { workspace: defWorkspace } });

  /* Linux：默认区 /home/u/proj，选中 /home/u/Proj 是两个真实目录 → 必须保留选择 */
  const posix = mk('/home/u/proj');
  assert.equal(posix.toSelection('/home/u/Proj'), '/home/u/Proj', 'POSIX 大小写不同不得被当成默认区（旧实现无条件 lower 会静默丢弃选择）');
  assert.equal(posix.toSelection('/home/u/proj'), '', '完全相同的默认区仍归全局');
  assert.equal(posix.toSelection('/home/u/proj/'), '', '尾斜杠必须归一');
  assert.equal(posix.toSelection(''), '', '空选择保持空');

  /* Windows：盘符大小写与分隔符差异必须归一（NTFS 大小写不敏感） */
  const win = mk('D:\\Work\\App');
  assert.equal(win.toSelection('d:/work/app'), '', 'Windows 路径大小写/分隔符差异必须归一为默认区');
  assert.equal(win.toSelection('D:\\Work\\App\\'), '', '尾斜杠必须归一');
  assert.equal(win.toSelection('D:\\Work\\Other'), 'D:\\Work\\Other', '非默认区必须保留');
});

test('P2-2 renderFilteredList 的默认区过滤必须与 toSelection 同口径', () => {
  const seg = sliceBetween(workspace, 'var def = defaultWorkspace();', 'var cur = window.currentChatWorkspace;');
  assert.match(seg, /pathScopeKey\(def\)/, 'defKey 必须走 pathScopeKey');
  assert.doesNotMatch(seg, /toLowerCase\(\)/, '不得无条件 lower');
  assert.match(workspace, /if \(defKey && pathScopeKey\(p\.path\) === defKey\) continue;/, '过滤必须同口径');
});

test('P2-2 app-workspace 删除分支必须用严格归属（查不到回本地，不回落激活环境）', () => {
  const strict = cutFn(workspace, 'function strictScopeOfPath(path)');
  assert.match(strict, /return 'local';/, '查不到必须回本地（宁可少删不可错删）');
  assert.doesNotMatch(strict, /__GOURD_REMOTE_ACTIVE_ID__/, '严格版不得回落激活连接');
  const del = sliceBetween(workspace, "var del = t.closest('.workspace-dropdown .project-dropdown-item-del')", 'var add = t.closest');
  assert.match(del, /projects\/remove' \+ scopeQueryOf\(delPath\)/, '下拉删除必须带显式 scope');
});
