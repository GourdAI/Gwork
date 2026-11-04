'use strict';
/* 契约：侧栏分组头快捷动作（2026-10-16）。
 *
 * 用户诉求两条：
 *  1) logo 行右侧的全局远程徽标下线（多连接下它只能报「其中一台/台数」，与分组树
 *     信息重复且更弱）——连接状态唯一展现面 = 分组树；
 *  2) 分组头（本地组 / 每个远端组）加「＋」就地新增本组工作空间，不必回主页面
 *     工作区下拉；远端组另加「⋯」承接原徽标菜单的连接级动作（同步镜像/重连/断开）。
 *
 * 本套件锁的是「实现形状 + 行为语义」双侧：
 *  - 形状：acts 必须是组头 <button> 的紧邻兄弟（button 内容模型禁止交互后代，
 *    塞进去是非法 HTML；兄弟 + 绝对定位才不经过 head 的折叠委派）；
 *  - 行为：本地组走本机对话框 + __scope=local；远端组走该连接的远端浏览 +
 *    __scope=id:<rid>；登记完【只登记不选中】（不打断用户当前环境）；
 *    掉线组不渲染「＋」；点击动作不得连带触发组的折叠切换。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const STATIC = path.join(__dirname, '..', '..', 'main', 'resources', 'static');
const readJs = (name) => fs.readFileSync(path.join(STATIC, 'js', name), 'utf8');
const readCss = (name) => fs.readFileSync(path.join(STATIC, 'css', name), 'utf8');

/* 行尾归一：本仓 js 主源存在 CRLF/LF 双约定（app-remote 纯 LF、app-history/
   app-workspace 纯 CRLF），切片标记含裸 \n 时在 CRLF 文件里恒失配（假红教训）。 */
function lf(s) { return String(s).replace(/\r\n/g, '\n'); }

/* 行级注释剥离（本仓已验证手法）：非贪婪删块注释 + 删 trim 后以 // 开头的整行。
   不用字符级状态机：JS 的 / 既是除号又是正则开头，自研启发式曾把 typeof 行里的
   / 误判为正则起点吞掉大片代码（CR4 度量工具自欺教训）。 */
function strip(src) {
  return lf(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function sliceBetween(src, startMark, endMark) {
  const s = lf(src);
  const a = s.indexOf(lf(startMark));
  assert.ok(a >= 0, '起始标记必须存在: ' + startMark);
  const b = s.indexOf(lf(endMark), a + lf(startMark).length);
  assert.ok(b > a, '结束标记必须存在: ' + endMark);
  return s.slice(a, b);
}

const historyRaw = readJs('app-history.js');
const workspaceRaw = readJs('app-workspace.js');
const remoteRaw = readJs('app-remote.js');
const history = strip(historyRaw);
const workspace = strip(workspaceRaw);
const remote = strip(remoteRaw);
const appCss = lf(readCss('app.css'));

/* ========================================================================
 * 1. 分组头渲染：acts 必须在 <button class="ws-group-head"> 内部
 * ====================================================================== */
test('组头 acts 是 head 按钮的紧邻兄弟（不得塞进 button 内部）', () => {
  const g = sliceBetween(history, 'function wsGroupHtml(g)', 'function buildSidebar');
  const headOpen = g.indexOf('<button type="button" class="ws-group-head"');
  assert.ok(headOpen >= 0, '组头必须仍是 button（可访问性契约：aria-expanded 只认 button）');
  const btnClose = g.indexOf("+ '</button>'", headOpen);
  const actsAt = g.indexOf('+ wsGroupActsHtml(g)');
  const bodyAt = g.indexOf("+ '<div class=\"ws-group-body\">'");
  assert.ok(btnClose > headOpen, 'head 必须闭合');
  assert.ok(actsAt > btnClose, 'acts 必须在 </button> 之后（button 内容模型禁止交互后代，塞进去是非法 HTML）');
  assert.ok(bodyAt > actsAt, 'acts 必须在 body 之前（紧邻 head，CSS 兄弟选择器 + 绝对定位才成立）');
});

test('wsGroupActsHtml：本地组只有「＋」；远端组「＋」+「⋯」；掉线组无「＋」', () => {
  const body = sliceBetween(history, 'function wsGroupActsHtml(g)', 'function wsGroupHtml(g)');
  /* 掉线门控：add 按钮包在 !isDown 里（掉线组浏览远端磁盘必失败，不给假入口） */
  assert.match(body, /if \(!isDown\) \{/, '「＋」必须被 isDown 门控');
  /* 本地门控：more 只给远端组（本地没有连接级动作可言） */
  assert.match(body, /if \(!isLocal\) \{/, '「⋯」必须只给远端组');
  /* 归属与连接 id 必须落到 data-*（点击委派靠它路由，不得靠闭包/全局态） */
  assert.match(body, /data-scope="' \+ escAttr\(g\.scopeKey\)/, '「＋」必须带本组 scopeKey');
  assert.match(body, /data-conn="' \+ escAttr\(g\.conn\.id\)/, '「⋯」必须带本组连接 id');
  /* 可访问性：span 充当按钮必须 role=button + tabindex + aria-label */
  assert.match(body, /role="button" tabindex="0"/, 'span 动作必须键盘可达');
  assert.match(body, /aria-label="/, '图标按钮必须有读屏名');
});

/* ========================================================================
 * 2. 点击委派：动作命中即消费，不得连带折叠
 * ====================================================================== */
test('动作点击独立委派：不经过 head 折叠链，路由到登记/菜单两入口', () => {
  const actHandler = sliceBetween(history, "$(document).on('click', '.ws-group-act', function (e)", "$(document).on('click', '.ws-group-head'");
  assert.match(actHandler, /e\.stopPropagation\(\)/, '动作点击不得冒泡到 document 级「点别处关闭」委派');
  assert.match(actHandler, /window\.sidebarAddWorkspace\(addScope\)/, '「＋」必须路由到 workspace 的登记入口');
  assert.match(actHandler, /window\.openRemoteConnMenu\(this, cid\)/, '「⋯」必须路由到连接动作菜单（传触发元素做锚点）');
  /* head 的折叠委派不得再含动作分支（两链分离 = 点「＋」绝不连带折叠） */
  const headHandler = sliceBetween(history, "$(document).on('click', '.ws-group-head', function (e)", 'ws-group-global-head');
  assert.doesNotMatch(headHandler, /ws-group-act/, '折叠链不得再判动作命中（动作已是独立委派，双判 = 双触发）');
  assert.match(headHandler, /wsGroupToggle\(scopeKey\)/, '折叠链本体必须保持原语义');
});

test('组头动作键盘可达：Enter/Space 触发 click 且防冒泡', () => {
  /* 结束标记必须是【代码锚点】：本文件的 history 是剥注释后的源码，拿注释当
     endMark 会恒失配（报「标记必须存在」看似实现缺失，实为锚点选错）。 */
  const kd = sliceBetween(history, "$(document).on('keydown', '.ws-group-act'", 'function wsRowFilteredOut(el)');
  assert.match(kd, /e\.preventDefault\(\)/, 'Space 不得同时滚动页面');
  assert.match(kd, /e\.stopPropagation\(\)/, '不得冒泡到 head 的 keydown（会双触发折叠）');
  /* 必须 triggerHandler 而非 trigger：trigger 跑完 jQuery 处理器后还会调
     原生 elem.click()，原生 click 再冒泡命中 click 委派 = 同一次按键双触发
     （「＋」连开两次对话框、「⋯」开了又关像坏了）。triggerHandler 不冒泡、
     不触发原生方法，是键盘复用 click 链的唯一安全写法。 */
  assert.match(kd, /triggerHandler\('click'\)/, '键盘必须用 triggerHandler 复用 click 链（trigger 会原生再派发=双触发）');
  assert.doesNotMatch(kd, /\$\(this\)\.trigger\('click'\)/, 'trigger 会触发原生 click 再冒泡=双触发，禁用');
});

/* ========================================================================
 * 3. 登记入口：sidebarAddWorkspace 的归属与「只登记不选中」
 * ====================================================================== */
test('sidebarAddWorkspace：本地/远端两分支归属正确且只登记不选中', () => {
  const fn = sliceBetween(workspace, 'window.sidebarAddWorkspace = function (scopeKey)', 'function renderDropdown');
  /* 本地分支：本机对话框 + 本地登记（__scope=local 在 registerWorkspacePath 内） */
  assert.match(fn, /pickSystemFolder\(function \(picked\) \{ registerWorkspacePath\(picked, null, false\); \}\)/,
    '本地组必须走本机对话框且 autoSelect=false');
  /* 远端分支：该连接的远端磁盘浏览（browse 与登记同机） */
  assert.match(fn, /openRemoteDirPicker\(rid, function \(picked\) \{ registerWorkspacePath\(picked, rid, false\); \}\)/,
    '远端组必须浏览该连接磁盘且登记到同一台');
  /* 掉线第二道闸：连接不在注册表/非 connected 时不发请求，但必须 toast
     （能走到这里=渲染后刚掉线的竞态，静默 return 用户以为按钮坏了） */
  assert.match(fn, /state === 'connected'/, '必须有在线判定（UI 门控之外的第二道闸）');
  assert.match(fn, /if \(!alive\) \{/, '掉线不得发起必失败的 browse');
  assert.match(fn, /GourdI18n\.t\('remote\.group_add_down'\)/, '掉线竞态必须给反馈（group_add_down 键的唯一消费点）');
  /* 「只登记不选中」是本入口与下拉入口的唯一差异：函数体内不得出现选中调用 */
  assert.doesNotMatch(fn, /selectChatWorkspace/, '分组头「＋」不得切换用户当前工作区（会打断在用的会话）');
});

test('registerWorkspacePath：单点登记链（scope 声明 + 临时记录 + 不复制实现）', () => {
  const fn = sliceBetween(workspace, 'function registerWorkspacePath(picked, scopeId, autoSelect)', 'window.sidebarAddWorkspace');
  /* 归属显式声明：local 与 id:<rid> 两形态，绝不落激活兜底（跳机读写根因） */
  assert.match(fn, /\?__scope=local/, '本地登记必须显式锁本地');
  assert.match(fn, /\?__scope=id:' \+ encodeURIComponent\(scopeId\)/, '远端登记必须锁选定连接');
  /* 临时 _scope 记录两分支都走 registerProjectScope（带幂等去重；内联 push
     无去重，重拉竞态下会留重复条目——缓存重拉是异步的，选中/渲染/删除立刻要归属） */
  assert.match(fn, /registerProjectScope\(picked, scopeId \|\| 'local'\)/, '两分支临时记录必须单点走 registerProjectScope');
  assert.doesNotMatch(fn, /projectsCache\.push\(/, '登记链内不得内联 push（无幂等去重=重复条目回流）');
  /* autoSelect 是唯一分叉点：下拉入口 true、分组头 false */
  assert.match(fn, /if \(autoSelect\) selectChatWorkspace\(picked\);/, '选中必须由参数门控');
  /* 三个入口共用本函数：下拉两入口不得再内联 ajax（防「同缺陷两副本」复发） */
  const ws = workspace;
  const addAjax = (ws.match(/\/web\/chat\/projects\/add/g) || []).length;
  assert.equal(addAjax, 1, '登记 ajax 必须收敛到 registerWorkspacePath 单点（出现多处即复制实现回流）');
});

/* ========================================================================
 * 4. 连接动作菜单：入口改挂分组头，菜单本体保留
 * ====================================================================== */
test('openRemoteConnMenu：单连接菜单 + toggle 语义 + 锚点定位', () => {
  const fn = sliceBetween(remote, 'function openRemoteConnMenu(anchor, connId)', 'function menuActsHtml');
  assert.match(fn, /if \(existing\) \{ closeRemoteMenu\(\); return; \}/, '再点同一锚点必须关闭（toggle）');
  assert.match(fn, /getBoundingClientRect\(\)/, '菜单必须锚定触发按钮定位');
  assert.match(fn, /menuActsHtml\(\)/, '三动作（同步镜像/重连/断开）必须保留');
});

/* ========================================================================
 * 5. CSS：默认隐藏 + 悬停/键盘焦点显隐 + 动作尺寸
 * ====================================================================== */
test('组头动作样式：默认隐藏、悬停/自身悬停/焦点显隐、20px 命中区', () => {
  assert.match(appCss, /\.ws-group-acts \{[\s\S]{0,200}display: none;/, '默认必须隐藏（常驻图标打碎组头扫读节奏）');
  assert.match(appCss, /\.ws-group-head:hover ~ \.ws-group-acts, \.ws-group-acts:hover, \.ws-group-acts:focus-within \{ display: inline-flex; \}/,
    '组头悬停、指针移入 acts 自身、键盘聚焦三者都必须显隐（移过去就消失 = 永远点不着）');
  /* 悬停显隐必须用通用兄弟 ~：与折叠规则同一纪律。实测在 head 与 acts 之间插一个
     兄弟后，用 + 时悬停 head 完全不显形（动作整体不可达），而 ~ 不受中间节点影响。 */
  assert.doesNotMatch(appCss, /\.ws-group-head:hover \+ \.ws-group-acts/,
    '悬停显隐不得用相邻兄弟 +（中间插兄弟即失效，与折叠规则同源脆性）');
  assert.match(appCss, /\.ws-group-act \{[\s\S]{0,240}width: 20px; height: 20px;/, '动作必须有足够命中区（20px）');
  assert.match(appCss, /\.ws-group-act:focus-visible \{ outline:/, '键盘焦点必须有可见环');
  assert.match(appCss, /\.ws-group \{ margin: 2px 0; position: relative; \}/, '组容器必须 relative（acts 绝对定位的参照）');
});

/* ========================================================================
 * 6. i18n：新键 12 语言包齐全
 * ====================================================================== */
test('i18n：group_add / group_actions / group_add_down 12 语言包齐全', () => {
  const dir = path.join(STATIC, 'locales');
  const langs = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(langs.length, 12, '必须 12 个语言包');
  for (const lang of langs) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, lang), 'utf8'));
    for (const key of ['group_add', 'group_actions', 'group_add_down']) {
      assert.ok(data.remote && typeof data.remote[key] === 'string' && data.remote[key].trim().length > 0,
        lang + '.remote.' + key + ' 缺失或为空（运行时会退成显示键名）');
    }
  }
});
/* ========================================================================
 * 7. 折叠规则：head 与 body 之间夹着 acts，必须用通用兄弟 ~（回归）
 * ====================================================================== */
/* 2026-10-20 99ca548 给组头加了 .ws-group-acts 快捷动作，它是 head 的兄弟、插在
   head 与 .ws-group-body 之间。折叠规则原写 `.ws-group-head[aria-expanded="false"]
   + .ws-group-body`，相邻兄弟选择器从此永远命中不到 → 点组头只转 caret、body 常驻
   展开，用户报「收缩不起来」。本组断言就是那次回归的护栏。

   为什么断言 ~ 而不是 +：+ 依赖「head 与 body 紧邻」这一结构事实，而结构会随需求
   变（已经变过一次），选择器不该跟着脆。~ 表达「body 在 head 之后」，中间夹几个
   兄弟都成立。若将来有人改回 +，即使当次结构恰好紧邻（测试仍绿），下次插兄弟就会
   复发——故直接锁 ~。

   反向断言 +：防止两者并存时 + 先手命中造成歧义（同选择器优先级下由书写顺序决定，
   属于脆性陷阱），故明确禁止 + 形态存在。
*/
test('分组折叠：head→body 跨 acts 仍能收起（必须用 ~，禁用 +）', () => {
  assert.match(appCss, /\.ws-group-head\[aria-expanded="false"\] ~ \.ws-group-body \{ display: none; \}/,
    '分组折叠必须用通用兄弟 ~：acts 夹在 head 与 body 之间，+ 永远命中不到（收缩失灵回归）');
  assert.doesNotMatch(appCss, /\.ws-group-head\[aria-expanded="false"\] \+ \.ws-group-body/,
    '不得保留相邻兄弟 + 形态（与 ~ 并存会产生优先级歧义，且下次插兄弟即复发）');
});

test('全局会话子节折叠：同样用 ~，与分组折叠同一纪律', () => {
  assert.match(appCss, /\.ws-group-global-head\[aria-expanded="false"\] ~ \.ws-group-global-body \{ display: none; \}/,
    '子节折叠也必须用 ~（与 .ws-group-body 统一，不依赖紧邻结构）');
  assert.doesNotMatch(appCss, /\.ws-group-global-head\[aria-expanded="false"\] \+ \.ws-group-global-body/,
    '不得保留相邻兄弟 + 形态');
});

/* 结构性证据：DOM 生成顺序确实是 head → acts → body（即上面两选择器要跨的那个兄弟）。
   这条把「为什么不能用 +」的原因也锁进测试：哪天 acts 被挪走/删掉，本断言先红，
   提醒维护者回头审视折叠选择器是否还能简化——避免原因与实现脱节。 */
test('DOM 顺序证据：acts 确实夹在 head 与 body 之间（+ 不适用的根因）', () => {
  const g = sliceBetween(history, 'function wsGroupHtml(g)', 'function buildSidebar');
  const headOpen = g.indexOf('<button type="button" class="ws-group-head"');
  const btnClose = g.indexOf("+ '</button>'", headOpen);
  const actsAt = g.indexOf('+ wsGroupActsHtml(g)');
  const bodyAt = g.indexOf("+ '<div class=\"ws-group-body\">'");
  assert.ok(headOpen >= 0 && btnClose > headOpen, '组头结构基线必须成立');
  assert.ok(actsAt > btnClose && bodyAt > actsAt,
    'acts 必须夹在 head 与 body 之间——正是它让「+.ws-group-body」失效的根因');
});
