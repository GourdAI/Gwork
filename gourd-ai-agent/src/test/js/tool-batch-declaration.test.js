const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const moduleRoot = path.resolve(__dirname, '../../..');
const staticRoot = path.join(moduleRoot, 'src/main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const readJava = (...parts) => fs.readFileSync(path.join(moduleRoot, 'src/main/java', ...parts), 'utf8').replace(/^\uFEFF/, '');

/* 取顶层函数体：项目里的函数都以列 0 的 '}' 收尾，与既有测试的切片手法一致 */
function fnBody(src, name) {
    const re = new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}');
    const m = src.match(re);
    assert.ok(m, name + ' 应存在于源码中');
    return m[0];
}

/* ===== 回归背景 =====
   旧链路：批次元数据只随各工具的 action_start 逐一到达，而写工具串行执行——
   第二张卡要等第一个工具执行完才收到自己的 start 帧，前端呈现
   「单卡先出 → 容器后到 → 逐张搬入」的中间态跳变（用户截图：容器 0/2 + 一张骨架卡在外）。
   修复（方案 A）：后端在整批执行前补发 action_batch 声明帧（batchId/size/有序成员清单），
   前端收到即把已存在的成员骨架卡一次性收编进容器，此后 start 帧只做原地转正。
   下列契约锁死该链路，防止回退成「逐张搬入的中间态」或「空容器残留」。 */

test('ActionTask：批次声明紧随 createVisibleBatch，且整批执行前下发（成员按 batchIndex 归位）', () => {
    const action = readJava('com/gourdai/agent/react/task/ActionTask.java');
    // 声明时机：必须紧随 createVisibleBatch（此刻模型流已结束、全部 draft 已发出），且在串行/并行执行之前
    assert.match(action, /Map<ToolCall, BatchMetadata> batchByCall = createVisibleBatch\(calls\);\s*\n\s*\/\/ 批次声明/,
        'announceVisibleBatch 必须紧跟 createVisibleBatch');
    assert.match(action, /announceVisibleBatch\(trace, batchByCall\);/);
    const createIdx = action.indexOf('Map<ToolCall, BatchMetadata> batchByCall = createVisibleBatch(calls);');
    const announceIdx = action.indexOf('announceVisibleBatch(trace, batchByCall);');
    const execIdx = action.indexOf('runCallsSerial(calls, trace, toolResults, aliasIdsByPrimaryId, batchByCall);');
    assert.ok(createIdx >= 0 && announceIdx > createIdx && execIdx > announceIdx,
        '下发顺序必须是 createVisibleBatch → announceVisibleBatch → 执行');

    // 空批次、无 sink 时静默跳过（与其余流式帧同规约）
    assert.match(action, /if \(batchByCall\.isEmpty\(\) \|\| trace\.getOptions\(\)\.getStreamSink\(\) == null\) \{\s*return;\s*\}/);
    // 成员三元组：与 doAction 的 actionId 同源（原生 id），index/toolName 供槽位归位
    assert.match(action, /member\.put\("actionId", entry\.getKey\(\)\.getId\(\)\);/);
    assert.match(action, /member\.put\("index", entry\.getValue\(\)\.batchIndex\);/);
    assert.match(action, /member\.put\("toolName", entry\.getKey\(\)\.getName\(\)\);/);
    // IdentityHashMap 迭代无序：必须按 batchIndex 归位重建有序清单，不能按迭代顺序直出
    assert.match(action, /members\.set\(entry\.getValue\(\)\.batchIndex, member\);/);
    assert.match(action, /new ToolCallBatchEvent\(trace, batchId, batchSize, members\)/);
});

test('ToolCallBatchEvent：继承工具事件基类并携带有序成员清单', () => {
    const evt = readJava('com/gourdai/agent/event/ToolCallBatchEvent.java');
    assert.match(evt, /public class ToolCallBatchEvent extends AbsToolCallEvent \{/);
    assert.match(evt, /private final transient List<Map<String, Object>> members;/);
    assert.match(evt, /public List<Map<String, Object>> getMembers\(\) \{\s*return members;\s*\}/);
    // 批次级事件：不绑定单个工具（toolName/actionId 为 null），batchId/size 进基类字段
    assert.match(evt, /super\(trace, null, null, ChatMessage\.ofAssistant\(""\), null, batchId, null, batchSize\);/);
    // 瞬态帧语义写进 javadoc，防止后续被误落盘
    assert.match(evt, /与 \{\@link ToolCallDraftEvent\} 同类，不落盘/);
});

test('WebChunk.ofActionBatch：factory 字段与协议文档表同步', () => {
    const chunk = readJava('com/gourdai/core/portal/web/WebChunk.java');
    assert.match(chunk, /private List<Map<String, Object>> batchMembers;/);
    assert.match(chunk, /public static WebChunk ofActionBatch\(String batchId, Integer batchSize, List<Map<String, Object>> members\) \{/);
    assert.match(chunk, /tmp\.type = "action_batch";/);
    assert.match(chunk, /tmp\.batchMembers = members;/);
    // 类级 type 枚举表必须收录三种瞬态工具帧，避免文档表再次漏项
    assert.match(chunk, /\{@code action_draft\}<\/td>/);
    assert.match(chunk, /\{@code action_args\}<\/td>/);
    assert.match(chunk, /\{@code action_batch\}<\/td>/);
});

test('WebStreamBuilder：映射分支 + 子代理归属透传 + 相位推进', () => {
    const builder = readJava('com/gourdai/core/portal/web/WebStreamBuilder.java');
    assert.match(builder, /if \(chunk instanceof ToolCallBatchEvent\) \{\s*\n\s*return oneFrame\(onToolCallBatchEvent\(\(ToolCallBatchEvent\) chunk\)\);\s*\n\s*\}/);
    assert.match(builder, /WebChunk\.ofActionBatch\(event\.getBatchId\(\), event\.getBatchSize\(\), event\.getMembers\(\)\)/);
    // 子代理批次：按 __parentAgentName 透传归属，容器才能建进智能体卡片内部
    assert.match(builder, /if \(event\.hasMeta\("__parentAgentName"\)\) \{\s*\n\s*Map<String, Object> args = new LinkedHashMap<>\(\);\s*\n\s*args\.put\("agentName", event\.getMeta\(\)\.get\("__parentAgentName"\)\);/);
    // 相位：批次声明期引擎已在「弄工具」，必须与 draft/args 同为 PHASE_TOOL（否则底部误显「输出中」）
    assert.match(builder, /event instanceof ToolCallDraftEvent \|\| event instanceof ToolCallArgsDeltaEvent\s*\n\s*\|\| event instanceof ToolCallBatchEvent/);
});

test('WsGate 双通道对等：/ws 同样下发 action_batch（含 batchMembers 数组）', () => {
    const ws = readJava('com/gourdai/core/portal/desktop/WsGate.java');
    assert.match(ws, /else if \(chunk instanceof ToolCallBatchEvent\) \{\s*\n\s*msg = onToolCallBatchEvent\(\(ToolCallBatchEvent\) chunk, sessionId\);/);
    assert.match(ws, /if \(chunk\.getMembers\(\) == null \|\| chunk\.getMembers\(\)\.isEmpty\(\)\) \{\s*\n\s*return null;\s*\n\s*\}/);
    assert.match(ws, /\.set\("type", "action_batch"\)/);
    assert.match(ws, /\.set\("batchMembers", membersNode\);/);
    // 子代理归属：非主引擎的帧带 agentName（与 reason 帧同约定）
    assert.match(ws, /if \(!engine\.getName\(\)\.equals\(chunk\.getAgentName\(\)\)\) \{\s*\n\s*node\.set\("agentName", chunk\.getAgentName\(\)\);/);
});

test('SessionStreamStore：action_batch 与 draft/args 同为瞬态帧，不落盘', () => {
    const store = readJava('com/gourdai/core/portal/web/SessionStreamStore.java');
    assert.match(store, /return "action_draft"\.equals\(type\) \|\| "action_args"\.equals\(type\) \|\| "action_batch"\.equals\(type\);/,
        'action_batch 必须加入瞬态帧白名单，否则历史文件与回放规模失控');
});

test('TaskTalent：子代理批次声明帧与 start 同等放行（归属由 stampParentAgent 统一加盖）', () => {
    const talent = readJava('com/gourdai/harness/agent/TaskTalent.java');
    assert.match(talent, /} else if \(chunk instanceof ToolCallBatchEvent\) \{[\s\S]*?sink\.next\(chunk\);[\s\S]*?\} else if \(chunk instanceof ToolCallDraftEvent \|\| chunk instanceof ToolCallArgsDeltaEvent\) \{/,
        '批次声明帧必须加入子代理转发白名单（置于 start 与 draft 之间）');
});

test('前端分发：case action_batch 与 action_draft/action_start 完全对齐的归属路由', () => {
    const js = readStatic('js', 'app-streaming.js');
    assert.match(js, /case 'action_batch': finishThinkingBlock\(sess\); clearRetryChunk\(sess\);/);
    assert.match(js, /case 'action_batch'[\s\S]*?var batchOwnerState = resolveAgentState\(sess, chunk\.args\);[\s\S]*?if \(batchOwnerState\) \{ finishAgentThinkingBlock\(sess, batchOwnerState\); \}/);
    assert.match(js, /applyActionBatchChunk\(sess, chunk, batchOwnerState \? batchOwnerState\.bodyEl : null\);/);
    const dispatch = js.match(/switch \(chunk\.type\) \{[\s\S]*?\n        \}/);
    assert.ok(dispatch, 'onWebChunk 的 switch 应存在');
    assert.match(dispatch[0], /case 'action_batch':/);
});

test('applyActionBatchChunk：一次性收编骨架卡；未建卡成员留空槽；零收编不预建空容器', () => {
    const msg = readStatic('js', 'app-message.js');
    assert.match(msg, /function applyActionBatchChunk\(sess, chunk, insertAgentBody\) \{/);
    assert.match(msg, /window\.applyActionBatchChunk = applyActionBatchChunk;/);
    const fn = fnBody(msg, 'applyActionBatchChunk');
    // 批次元数据复用归一化器（batchSize>=2 等前置校验一处维护）
    assert.match(fn, /var meta = normalizeBatchMeta\(\{ batchId: chunk\.batchId, batchSize: chunk\.batchSize \}\);\s*\n\s*if \(!meta\) return;/);
    assert.match(fn, /var members = \(chunk\.batchMembers && chunk\.batchMembers\.length\) \? chunk\.batchMembers : \[\];/);
    // 只收编「已存在且未归组」的成员卡；缺 actionId / 无卡 / 已归组一律跳过
    assert.match(fn, /var card = sess\.toolCardsById && sess\.toolCardsById\[actionId\];/);
    assert.match(fn, /if \(!card \|\| !card\.parentNode\) continue;/);
    assert.match(fn, /if \(card\.getAttribute\('data-batch-key'\)\) continue;/);
    // 归组走共享的 appendCardToBatch（槽位规则唯一），而不是第二套搬卡逻辑
    assert.match(fn, /appendCardToBatch\(sess, card, \{\s*\n\s*batchId: meta\.batchId,\s*\n\s*batchIndex: \(isFinite\(idx\) && Math\.floor\(idx\) === idx\) \? idx : null,\s*\n\s*batchSize: meta\.batchSize\s*\n\s*\}, insertAgentBody\);/);
});

test('ensureBatchGroup 抽取：三条归组路径（start/end/batch）共用同一容器口径', () => {
    const msg = readStatic('js', 'app-message.js');
    assert.match(msg, /function batchKeyFor\(sess, batchId\) \{\s*\n\s*return \(sess\.currentRunId \|\| ''\) \+ '\|' \+ batchId;\s*\n\}/);
    const ensure = fnBody(msg, 'ensureBatchGroup');
    assert.match(ensure, /if \(batch && document\.contains\(batch\.groupEl\)\) return batch;/);
    assert.match(ensure, /sess\.toolBatchesById\[batchKey\] = batch;/);
    assert.match(ensure, /updateBatchGroupHeaderExplicit\(batch\);/);
    // appendCardToBatch 必须走 ensureBatchGroup，不得保留第二份建组代码
    const append = fnBody(msg, 'appendCardToBatch');
    assert.match(append, /var batch = ensureBatchGroup\(sess, meta, insertAgentBody\);/);
    assert.doesNotMatch(append, /group\.innerHTML = '<div class="tool-batch-header">'/, '建组 DOM 只允许存在于 ensureBatchGroup');
});

test('HITL 接管：审批卡必须从批量容器摘出（容器默认折叠，折叠态子卡不可见）', () => {
    const msg = readStatic('js', 'app-message.js');
    const takeover = fnBody(msg, 'takeoverArgsStreamingCard');
    assert.match(takeover, /var group = \$\(found\)\.closest\('\.tool-batch-group'\)\[0\];/);
    // 摘出同时清槽位与批次标记，避免继续参与该批次计数
    assert.match(takeover, /if \(isFinite\(idx\) && batch\.slots\[idx\] === found\) batch\.slots\[idx\] = null;/);
    assert.match(takeover, /found\.removeAttribute\('data-batch-key'\);/);
    assert.match(takeover, /\$\(group\)\.before\(found\);/);
    // 原有接管语义不得丢：按 actionId 精确命中、解除登记与骨架标记仍在
    assert.match(takeover, /clearArgsStreamingMark\(found\);/);
    assert.match(takeover, /delete sess\.toolCardsById\[foundId\];/);
});

test('finishStream：空批量容器直接移除（空壳比不显示更误导）', () => {
    const js = readStatic('js', 'app-streaming.js');
    // 清理必须发生在「完整性检查/标黄」之前，否则空容器先被染成 warn 再残留
    assert.match(js, /if \(\$\(b\.groupEl\)\.find\('\.tool-card'\)\.length === 0\) \{\s*\n\s*\$\(b\.groupEl\)\.remove\(\);\s*\n\s*delete sess\.toolBatchesById\[key\];\s*\n\s*return;\s*\n\s*\}\s*\n\s*var present = b\.slots \? b\.slots\.filter\(Boolean\)\.length : 0;/);
});

test('回放零变化：action_batch 不落盘，回放管线不识别也不需要该帧', () => {
    const history = readStatic('js', 'app-history.js');
    assert.doesNotMatch(history, /'action_batch'/, '回放层不得为瞬态批次帧新增特判分支');
});
