/*
 * 队列 UI 会话归属与缓存新鲜度契约（「每个对话都会被加进队列」观感修复）。
 *
 * 排查实证：队列本体（后端 queue.json / API）健康，观感来自三个叠加缺陷——
 *   A) setActiveSession 切会话不刷新队列 UI：chip/badge 渲染的是上一个会话的队列数，
 *      切到空队列会话仍显示非零计数（幽灵计数跨会话残留）；
 *   B) MessageQueue.caches 无失效策略：另一实例（桌面版与 dev 同时在线、共享同一批
 *      会话目录）shift/clear 后本实例缓存不失效，stale 快照可无限期命中；
 *   C) steer_dropped 事件后端已入队但前端刷新仍可能命中本实例旧缓存。
 *
 * 本文件锁三组契约：
 *   1) setActiveSession 必须在切换时以 force 强制重拉队列并重渲染（治 A）；
 *   2) getQueue 必须支持 force 绕过缓存 + 缓存带 TTL 上限（治 B）；
 *   3) steer_dropped 的 UI 刷新必须强制绕过缓存（治 C）。
 *
 * 风格对齐既有静态契约测试（node:test + fs.readFileSync 文本断言，不引入 DOM 模拟）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STATIC = path.resolve(__dirname, '../../main/resources/static');
const BASE_SRC = fs.readFileSync(path.join(STATIC, 'js/app-base.js'), 'utf8');
const UI_SRC = fs.readFileSync(path.join(STATIC, 'js/app-ui.js'), 'utf8');
const MQ_SRC = fs.readFileSync(path.join(STATIC, 'js/message-queue.js'), 'utf8');
const STREAMING_SRC = fs.readFileSync(path.join(STATIC, 'js/app-streaming.js'), 'utf8');

/* ---------- 提取函数体（花括号配平，容忍字符串字面量内的花括号由代码风格保证不含） ---------- */
function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' source not found');
  const bodyStart = source.indexOf('{', start);
  let depth = 0, i = bodyStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  assert.ok(depth === 0, name + ' braces unbalanced');
  return source.slice(start, i + 1);
}

/* ========== 契约 1：setActiveSession 切会话必须强制刷新队列 UI ========== */

test('setActiveSession 切会话时以 force 强制重拉队列（幽灵计数不跨会话残留）', () => {
  const fn = extractFunction(BASE_SRC, 'setActiveSession');
  // 必须调用队列 UI 刷新，且传 force:true 绕过缓存——不传 force 时缓存里是
  // 上一个会话（或本会话的过期快照），重渲染等于把 stale 数据画到新会话上。
  assert.match(fn, /updateMessageQueueUI\s*\(\s*\{\s*force:\s*true\s*\}\s*\)/,
    'setActiveSession 应调用 updateMessageQueueUI({ force: true })');
  // 调用点必须在 activeSessionId 已更新之后（否则拉的仍是旧会话的队列）。
  const callIdx = fn.indexOf('updateMessageQueueUI');
  const activeIdx = fn.indexOf('activeSessionId = sessionId');
  assert.ok(callIdx > activeIdx, '队列刷新必须在 activeSessionId 赋值之后');
});

test('setActiveSession 对 app-ui.js 的加载顺序做了 typeof 守卫（app-base 先加载）', () => {
  const fn = extractFunction(BASE_SRC, 'setActiveSession');
  // app-bootstrap.js 的加载顺序是 app-base.js → message-queue.js → app-ui.js，
  // 运行期函数必在，但守卫对齐 syncQuestionCard 的既有模式（缺函数不得抛错）。
  assert.match(fn, /typeof\s+window\.updateMessageQueueUI\s*===\s*'function'/,
    '应使用 typeof window.updateMessageQueueUI === \'function\' 守卫');
});

/* ========== 契约 2：缓存新鲜度（TTL + force） ========== */

test('getQueue 支持 force 形参并绕过缓存命中分支', () => {
  const m = MQ_SRC.match(/getQueue\s*\(\s*sessionId\s*,\s*force\s*\)\s*\{/);
  assert.ok(m, 'getQueue 应声明 (sessionId, force) 形参');
  // 落地缓存命中分支必须被 force 短路（在飞复用分支不受 force 影响：
  // 那段复用的是未落定的服务端真值，见「单一飞行」行为测试）。
  assert.match(MQ_SRC, /if\s*\(!force\s*&&\s*cache\s*&&\s*cache\.items\s*!==\s*undefined\)/,
    '落地缓存命中分支必须以 !force 短路');
});

test('缓存命中受 TTL 上限约束（跨实例 stale 快照最长存活 CACHE_TTL_MS）', () => {
  assert.match(MQ_SRC, /static\s+CACHE_TTL_MS\s*=\s*\d+\s*;/,
    'MessageQueue 应定义 static CACHE_TTL_MS 常量');
  assert.match(MQ_SRC, /Date\.now\(\)\s*-\s*cache\.fetchedAt\)\s*<\s*MessageQueue\.CACHE_TTL_MS/,
    '命中缓存前必须校验 fetchedAt 未超 TTL');
  assert.match(MQ_SRC, /cache\.fetchedAt\s*=\s*Date\.now\(\)/,
    '成功拉取后必须记录 fetchedAt');
});

test('updateMessageQueueUI 接受 opts.force 并透传给 getQueue', () => {
  assert.match(UI_SRC, /async function updateMessageQueueUI\s*\(\s*opts\s*\)\s*\{/,
    'updateMessageQueueUI 应声明 (opts) 形参');
  assert.match(UI_SRC, /getQueue\s*\(\s*sessionId\s*,\s*force\s*\)/,
    'updateMessageQueueUI 内 getQueue 调用必须透传 force');
  assert.match(UI_SRC, /var\s+force\s*=\s*!!\s*\(\s*opts\s*&&\s*opts\.force\s*\)/,
    'force 必须从 opts 安全解包（undefined 不炸）');
});

/* ========== 契约 3：steer_dropped 强刷绕过缓存 ========== */

test('steer_dropped 事件的队列 UI 刷新强制绕过缓存', () => {
  // 后端已按 originSteerId 幂等入 queue.json；若刷新命中旧缓存，chip 计数不动。
  // 锚点用分支体（if (chunk.type === 'steer_dropped') {）而非联合条件行，避免命中上方三类型判断。
  const i = STREAMING_SRC.indexOf("if (chunk.type === 'steer_dropped') {");
  assert.ok(i >= 0, 'app-streaming.js 应处理 steer_dropped 分支');
  const seg = STREAMING_SRC.slice(i, i + 900);
  assert.match(seg, /updateMessageQueueUI\s*\(\s*\{\s*force:\s*true\s*\}\s*\)/,
    'steer_dropped 刷新应传 { force: true }');
});

/* ========== 行为级验证：TTL 与 force 的真实语义（非纯文本断言） ========== */

test('getQueue 行为：缓存命中 / TTL 过期重拉 / force 绕过（mock $.ajax）', async () => {
  // 在 Node vm 沙箱里执行 MessageQueue 类：注入全局 $ 与窗口环境。
  let fetchCount = 0;
  let serverItems = [{ content: 'a' }];
  const sandbox = {
    $: { ajax: function () { fetchCount++; return Promise.resolve({ code: 200, data: { items: serverItems } }); } },
    window: {},
    console: console
  };
  const vm = require('node:vm');
  const MessageQueue = vm.runInNewContext(
    fs.readFileSync(path.join(STATIC, 'js/message-queue.js'), 'utf8') + '\nMessageQueue;',
    sandbox, { filename: 'message-queue.js' }
  );
  const mq = new MessageQueue();

  // 1) 首次拉取走网络
  let r1 = await mq.getQueue('s1');
  assert.equal(fetchCount, 1);
  assert.equal(r1.length, 1);

  // 2) TTL 内二次读取命中缓存（无新请求）
  await mq.getQueue('s1');
  assert.equal(fetchCount, 1);

  // 3) force 绕过缓存（服务端真值已变：模拟另一实例 clear）
  serverItems = [];
  let r3 = await mq.getQueue('s1', true);
  assert.equal(fetchCount, 2);
  assert.equal(r3.length, 0, 'force 必须拿到服务端最新值');

  // 4) TTL 过期后自动重拉（把 fetchedAt 拨回过去）
  mq.caches['s1'].fetchedAt = Date.now() - MessageQueue.CACHE_TTL_MS - 1;
  serverItems = [{ content: 'b' }, { content: 'c' }];
  let r4 = await mq.getQueue('s1');
  assert.equal(fetchCount, 3);
  assert.equal(r4.length, 2, 'TTL 过期后应重新拉取');
});

test('getQueue 行为：loading 中的请求不因 TTL/force 被打断（单一飞行）', async () => {
  let pending = [];
  const sandbox = {
    $: { ajax: function () { return new Promise(resolve => pending.push(resolve)); } },
    window: {},
    console: console
  };
  const vm = require('node:vm');
  const MessageQueue = vm.runInNewContext(
    fs.readFileSync(path.join(STATIC, 'js/message-queue.js'), 'utf8') + '\nMessageQueue;',
    sandbox, { filename: 'message-queue.js' }
  );
  const mq = new MessageQueue();

  const p1 = mq.getQueue('s2');
  const p2 = mq.getQueue('s2', true); // 第二次带 force，但第一次仍在飞行
  assert.equal(pending.length, 1, 'loading 中的缓存槽不应触发第二个并行请求');
  pending[0]({ code: 200, data: { items: [] } });
  await Promise.all([p1, p2]);
});
