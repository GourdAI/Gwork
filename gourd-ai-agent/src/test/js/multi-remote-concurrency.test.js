'use strict';
/* 契约：多远端并发（方案B，用户 2026-10-10 拍板）前端最小闭环。
 * 锁定五件事：
 * 1. app-remote.js 连接注册表化：connectionsById map + __GOURD_REMOTE__ 五方法 + LS 数组迁移
 * 2. 跨机误绑致命缺陷根因清除：scopeOfPath/scopeOfProjectPath 兜底不得再回 activeId
 * 3. WS per-scope 池：gateSockets Map 化 + 切工作区不关旧 socket
 * 4. 侧栏分组树 DOM 契约 class 齐全 + 折叠持久化键
 * 5. Rust 四处小补：remote_list 注册 + progress 带 id + reconnect 带 id + unregister 按 id 反查
 * 断言形态原则：验行为特征不锁属性顺序；源码切片断言必须带足够上下文全局唯一。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const STATIC = path.join(__dirname, '..', '..', 'main', 'resources', 'static');
const read = p => fs.readFileSync(path.join(STATIC, p), 'utf8');
const remote = read('js/app-remote.js');
const workspace = read('js/app-workspace.js');
const code = read('js/app-code.js');
const streaming = read('js/app-streaming.js');
const history = read('js/app-history.js');
const TAURI = path.resolve(__dirname, '../../../../gourd-ai-tauri/src-tauri/src');
const readRs = p => fs.readFileSync(path.join(TAURI, p), 'utf8');

function cutFn(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, '函数头必须存在: ' + head);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(at, i + 1); }
  }
  throw new Error('函数未闭合: ' + head);
}

test('app-remote：连接注册表化（connectionsById + 五方法读口 + LS 数组迁移）', () => {
  assert.match(remote, /var connectionsById = Object\.create\(null\)/,
    '必须有 id→条目 map（旧单变量 activeConnection 连第二台即覆盖丢失第一台）');
  for (const m of ['list:', 'activeId:', 'isActive:', 'get:', 'onConnectionsChanged:', 'pickConnection:']) {
    assert.match(remote, new RegExp(m.replace(':', ':\\s')), '__GOURD_REMOTE__ 缺方法: ' + m);
  }
  assert.match(remote, /window\.__GOURD_REMOTE__ = \{/, '全站唯一多连接读口必须挂载');
  /* LS 迁移：旧单值字符串读出来必须变 [v]（否则老用户升级后连接全丢） */
  const reader = cutFn(remote, 'function readActiveIds()');
  assert.match(reader, /charAt\(0\) !== '\['/, '旧单值字符串形态必须被识别并迁移');
  /* 事件：connections-changed 必须派发（WS 池/分组树/徽标都订阅它） */
  assert.match(remote, /remote:connections-changed/, '必须派发连接表变更事件');
  /* 兼容读口语义：__GOURD_REMOTE_ACTIVE__ = 有在线连接（「打开远程目录」门控需要后者） */
  assert.match(remote, /__GOURD_REMOTE_ACTIVE__ = function \(\) \{ return connEntries\(\)\.length > 0; \}/,
    'ACTIVE 读口语义必须从「有激活」改为「有在线连接」');
});

test('跨机误绑根因清除：scope 兜底不得再回 activeId（宁可回落本地绝不跳机）', () => {
  const wsScope = cutFn(workspace, 'function scopeOfPath(');
  assert.doesNotMatch(wsScope, /__GOURD_REMOTE_ACTIVE_ID__/,
    'scopeOfPath 兜底回 activeId = 连第二台后第一台已选工作区被静默改绑（跨机误操作根因）');
  const codeScope = cutFn(code, 'function scopeOfProjectPath(');
  assert.doesNotMatch(codeScope, /__GOURD_REMOTE_ACTIVE_ID__/,
    'code 模式同款兜底必须一并清除');
  /* 绑定自愈：查不到归属时不得重新 bind（旧逻辑会把 A 机目录绑到 B 隧道） */
  const heal = workspace.slice(workspace.indexOf('绑定自愈'), workspace.indexOf('绑定自愈') + 1200);
  assert.ok(heal.length > 100, '绑定自愈段必须存在');
  assert.doesNotMatch(heal, /bindWorkspaceScope\([^)]*scopeOfPath/,
    '自愈不得拿 scopeOfPath 结果直接重绑（null 时必须不动绑定）');
});

test('WS per-scope 池：gateSockets Map 化 + 切工作区不关旧 socket', () => {
  assert.match(streaming, /gateSockets/, '必须有 per-scope socket 池（单例 WS 是并发任务的物理瓶颈）');
  assert.match(streaming, /new Map\(\)/, '池必须是 Map（key=scopeKey）');
  /* 旧单例退役逻辑（if (webGateSocket && …) close()）全文不得再出现：
     池化后 close 只允许出现在回收/断连分支（按 entry 操作，不碰全局单例名）。 */
  assert.doesNotMatch(streaming, /if \(webGateSocket &&/, '不得再出现单例就绪判定（池化后按 entry 判定）');
  assert.doesNotMatch(streaming, /var webGateSocket = /, '全局单例变量必须移除');
  /* scope 参数进 URL：Rust route_for 第 2 级对 WS 生效的前提 */
  assert.match(streaming, /__scope=/, 'gate URL 必须能带 __scope（WS 面分流双保险）');
});

test('侧栏分组树 DOM 契约 class 齐全 + 折叠持久化', () => {
  for (const cls of ['ws-group', 'ws-group-head', 'ws-group-caret', 'ws-group-dot', 'ws-group-label', 'ws-group-body']) {
    assert.match(history, new RegExp(cls), '分组树缺契约 class: ' + cls);
  }
  assert.match(history, /aria-expanded/, '组头必须带 aria-expanded（可折叠的可访问性契约）');
  assert.match(history, /gourdai-wsgroup-collapsed/, '折叠态必须持久化');
  /* 对话 tab 零改动护栏：全局会话不进分组树（用户拍板） */
  assert.doesNotMatch(history, /ws-group[\s\S]{0,400}tab_chats/, '分组树不得侵入对话 tab 渲染');
});

test('Rust 四处小补：remote_list / progress 带 id / reconnect 带 id / unregister 按 id 反查', () => {
  const main = readRs('main.rs');
  /* ACL 授权在 capabilities/default.json（build.rs 只生成权限标识符，授予由 capability 完成）；
     build.rs 位于 src-tauri 根目录而非 src/ 下。 */
  const caps = fs.readFileSync(path.join(TAURI, '..', 'capabilities', 'default.json'), 'utf8');
  const bridge = readRs('ipc_bridge.rs');
  const mod = readRs('remote/mod.rs');
  const server = readRs('server.rs');
  assert.match(main, /remote_list/, 'main.rs 必须注册 remote_list 命令');
  assert.match(caps, /"allow-remote-list"/, 'capability 必须授予 allow-remote-list（缺则 remoteList 被 ACL 静默拒绝）');
  assert.match(bridge, /remoteList/, 'ipc_bridge 必须暴露 remoteList');
  /* progress 带 connectionId（并发连两台日志混流的根因） */
  const prog = mod.split('"remote-connect-progress"')[1] || '';
  assert.match(prog.slice(0, 400), /connectionId/, 'progress 事件载荷必须带 connectionId');
  /* reconnect 带 id（LAST_PARAMS 单值 = A 掉线重连 B 的根因） */
  assert.match(mod, /pub async fn remote_reconnect\([\s\S]{0,80}Option<String>/,
    'remote_reconnect 必须接可选 connectionId');
  /* unregister 存活判定按 connection_id 反查（端口判定在 WSL Direct 碰撞时误删他连接绑定） */
  const unreg = cutFn(server, 'pub fn unregister_remote_connection');
  assert.doesNotMatch(unreg, /HashSet<u16>/, '存活判定不得再用裸端口集合');
  assert.match(unreg, /by_id\.keys\(\)|port_to_id|id_of_port|connection_id/,
    '存活判定必须经 connection_id 反查');
});

test('断开/重连/镜像按 id 分账（多连接下不得互相串扰）', () => {
  const disc = cutFn(remote, 'function doDisconnect');
  assert.match(disc, /remoteDisconnect\((id|target), true\)/, '断开必须按 id 且 releaseAll=true');
  assert.match(remote, /var reconnectStates = Object\.create\(null\)/,
    '退避状态机必须 per-id（单例版两台同时掉线第二台永不重连）');
  const mirror = cutFn(remote, 'window.remoteMirrorSync = function');
  assert.match(mirror, /function \(id\)/, '镜像同步必须可按 id 指向任一在线连接');
  /* 事件守卫：注册表存在性（非 active 连接掉线不得静默） */
  const stateH = remote.slice(remote.indexOf('onRemoteState(function'), remote.indexOf('onRemoteState(function') + 900);
  assert.match(stateH, /connectionsById\[id\]/, '探活事件守卫必须查注册表');
});

/* ===== codereview 2026-10-10 防回归（本轮审查发现的 5 处缺陷修复的锚点） ===== */

test('审查修复：LS 迁移双形态 + 恢复链核实 + 互斥提示 + 监听零残留 + wrap 已删', () => {
  /* R3：旧版若存 JSON.stringify(单值)（带引号字符串），JSON.parse 成功但不进 catch——
     字符串形态必须在 try 分支内迁出，否则升级即丢连接记录 */
  const reader = cutFn(remote, 'function readActiveIds');
  assert.match(reader, /typeof v === 'string' && v/,
    'JSON 字符串形态必须在 try 分支内迁移（catch 捕不到 parse 成功的场景）');

  /* R2：remoteList 空列表 ≠ 断言「无在线连接」（ipc_bridge 把旧壳 invoke 失败降级成 []）。
     空列表必须先经 tryRestoreViaStateChain 用 remoteState 核实再决定清 LS。 */
  assert.ok(cutFn(remote, 'function tryRestoreViaStateChain').length > 0,
    '旧壳回退链必须是具名函数（空列表核实路径要复用它）');
  const emptyAt = remote.indexOf('if (!alive.length) {');
  assert.ok(emptyAt >= 0, 'alive 空分支必须存在');
  const emptyBranch = remote.slice(emptyAt, emptyAt + 400);
  assert.match(emptyBranch, /tryRestoreViaStateChain\(savedIds\)/,
    '空列表分支必须调用核实链（锚定调用形态：注释里提及函数名不算数，M2 变异曾杀死本断言的弱版本）');

  /* R4：连接互斥必须可感知（静默 return 是「按钮坏了」的感知形态） */
  const connect = cutFn(remote, 'function doConnect');
  assert.match(connect, /connect_in_progress/,
    'connecting 互斥时必须 toast 提示（不得静默）');

  /* R5：浮层/菜单 outside handler 必须在关闭时统一摘除（每次开关累积僵尸监听） */
  const closePick = cutFn(remote, 'function closeConnPicker');
  assert.match(closePick, /removeEventListener\('mousedown'/,
    'closeConnPicker 必须摘除 outside handler（零残留）');
  const closeMenu = cutFn(remote, 'function closeRemoteMenu');
  assert.match(closeMenu, /removeEventListener\('click'/,
    'closeRemoteMenu 必须摘除 outside handler（零残留）');

  /* R6：doDisconnect wrap 已删（本体已调 clearReconnectFor，wrap 是纯冗余） */
  assert.doesNotMatch(remote, /rawDisconnect/,
    'rawDisconnect wrap 不得回潮（doDisconnect 本体已调 clearReconnectFor）');
});

test('自查 P2 修复：activeId 必须有用户置位入口且两个选择链都已接线', () => {
  /* R7：activeId 曾是僵尸状态——setActiveId 是模块私有函数，注释声称「由工作区选择
     置位」但从未接线，remoteActiveOutcome 在选中远端工作区后仍返回启动旧值。 */
  assert.match(remote, /window\.__GOURD_REMOTE_SET_ACTIVE__ = function/,
    'activeId 必须暴露置位入口（否则 remoteActiveOutcome/旧壳降级读口恒为启动旧值）');
  const setter = cutFn(remote, 'window.__GOURD_REMOTE_SET_ACTIVE__ = function');
  assert.match(setter, /connectionsById\[id\]\) return/,
    '不存在的 id 必须静默忽略（不误清 active：那是断开路径的职责）');

  const ws = read('js/app-workspace.js');
  assert.match(ws, /__GOURD_REMOTE_SET_ACTIVE__\(\(actScope && actScope !== 'local'\) \? actScope : null\)/,
    'selectChatWorkspace 必须同步 activeId（选远端→该连接，选本地→null）');
  const code = read('js/app-code.js');
  assert.match(code, /__GOURD_REMOTE_SET_ACTIVE__\(\(projScope && projScope !== 'local'\) \? projScope : null\)/,
    'selectProject 必须同步 activeId（与 bind_scope 同步，两个选择链缺一不可）');
});
