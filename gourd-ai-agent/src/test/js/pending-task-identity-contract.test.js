/**
 * 契约测试：批次 C1「问答卡前端状态与身份校验」。
 *
 * 覆盖三个已实证的缺陷：
 * - C1-a：加载旧历史（replay）时，历史里的 question / question_answered 帧【不得】清掉
 *   用户当前正在作答的问答卡（按 actionId 区分，只收同一道题的卡）
 * - C1-b：问答/HITL 提交必须携带 actionId，后端不匹配时拒绝（HITL 比问答更严），
 *   确认帧（question_answered）回传 actionId 形成闭环
 * - C1-c：挂起（等待作答/审批）而下发的 done 帧不得清空批次索引，
 *   否则恢复后同一批次会被拆成两组渲染
 *
 * 行为断言采用「从真实源码提取函数体 + 沙箱执行」的既有范式（见 ask-user-card-contract.test.js），
 * 不做纯文本 grep 的表面校验——纯 grep 挡不住逻辑写反。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const javaRoot = path.resolve(__dirname, '../../main/java');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const readJava = (rel) => fs.readFileSync(path.join(javaRoot, rel), 'utf8').replace(/^\uFEFF/, '');

const message = readStatic('js', 'app-message.js');
const streaming = readStatic('js', 'app-streaming.js');

function sliceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `未找到起始标记: ${startMarker}`);
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, `未找到结束标记: ${endMarker}`);
    return source.slice(start, end);
}

/* 提取单个函数体：从 `function name(` 起，按花括号配平截到函数结束 */
function fnBody(source, name) {
    const start = source.indexOf('function ' + name + '(');
    assert.ok(start >= 0, `未找到函数: ${name}`);
    let depth = 0;
    let seen = false;
    for (let i = start; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') { depth++; seen = true; } else if (ch === '}') {
            depth--;
            if (seen && depth === 0) return source.slice(start, i + 1);
        }
    }
    assert.fail(`函数体未配平: ${name}`);
}

/* ===== C1-a：回放历史不得清掉当前活跃问答卡 ===== */

/* 在沙箱里跑真实的 appendQuestionCard / handleQuestionAnsweredFrame。
   两者都会调用 syncQuestionCard（DOM），沙箱里以空函数替身注入；
   activeSessionId 设为与会话不同的值，天然走不到 DOM 分支。 */
function loadQuestionFrameHandlers() {
    const normalize = sliceBetween(message, 'function normalizeQuestionArgs', 'function questionAnswerFor');
    const createState = sliceBetween(message, 'function createQuestionCardState', 'function questionAnswerFor');
    const append = fnBody(message, 'appendQuestionCard');
    const answered = fnBody(message, 'handleQuestionAnsweredFrame');
    const src = normalize + createState + append + answered
        + '\nreturn { appendQuestionCard: appendQuestionCard, handleQuestionAnsweredFrame: handleQuestionAnsweredFrame,'
        + ' createQuestionCardState: createQuestionCardState, normalizeQuestionArgs: normalizeQuestionArgs };';
    // activeSessionId 与会话 id 不同 → 不触发 syncQuestionCard 的 DOM 路径
    return new Function('activeSessionId', 'syncQuestionCard', src)('__none__', function () {});
}

function newSess(id) {
    return { sessionId: id || 's1', _questionState: null, _replaying: false };
}

test('C1-a：回放历史的 question_answered 不得清掉当前正在作答的另一道题', () => {
    const api = loadQuestionFrameHandlers();
    const sess = newSess();

    // 用户当前正等待回答问题 B
    api.appendQuestionCard(sess, { actionId: 'call-B', args: { questions: [{ header: 'B?' }] } });
    assert.equal(sess._questionState.actionId, 'call-B');

    // 向上翻页加载历史：回放里问题 A 的应答帧到达
    sess._replaying = true;
    api.handleQuestionAnsweredFrame(sess, { actionId: 'call-A' });
    assert.ok(sess._questionState, '回放中他题的应答帧不得清掉当前卡');
    assert.equal(sess._questionState.actionId, 'call-B');

    // 历史帧没有 actionId（字段新增前落盘）：回放期同样不得清
    api.handleQuestionAnsweredFrame(sess, {});
    assert.ok(sess._questionState, '回放中无 actionId 的历史帧不得清掉当前卡');
    assert.equal(sess._questionState.actionId, 'call-B');

    // 回放结束后，问题 B 仍然在（不需要额外恢复动作，因为从未被改写）
    sess._replaying = false;
    assert.equal(sess._questionState.actionId, 'call-B');
});

test('C1-a：回放历史的 question 帧不得抢占当前未提交的活跃卡', () => {
    const api = loadQuestionFrameHandlers();
    const sess = newSess();

    api.appendQuestionCard(sess, { actionId: 'call-B', args: { questions: [{ header: 'B?' }] } });
    sess._questionState.answers[0] = { index: 0, text: '已选', skipped: false, custom: false };

    sess._replaying = true;
    api.appendQuestionCard(sess, { actionId: 'call-A', args: { questions: [{ header: 'A?' }] } });
    assert.equal(sess._questionState.actionId, 'call-B', '回放的历史提问不得替换当前活跃卡');
    assert.equal(sess._questionState.questions[0].header, 'B?');
    assert.equal(sess._questionState.answers[0].text, '已选', '已作答进度不得丢失');
});

test('C1-a：同一道题的应答帧仍然正常收卡（实时与回放都要收）', () => {
    const api = loadQuestionFrameHandlers();

    // 实时：同 actionId 闭环
    const live = newSess();
    api.appendQuestionCard(live, { actionId: 'call-B', args: { questions: [{ header: 'B?' }] } });
    api.handleQuestionAnsweredFrame(live, { actionId: 'call-B' });
    assert.equal(live._questionState, null, '同一道题的应答帧必须收卡');

    // 回放：同 actionId 也要收（历史中「问后有答」的自然闭环）
    const replay = newSess();
    replay._replaying = true;
    api.appendQuestionCard(replay, { actionId: 'call-A', args: { questions: [{ header: 'A?' }] } });
    api.handleQuestionAnsweredFrame(replay, { actionId: 'call-A' });
    assert.equal(replay._questionState, null, '回放中同一道题的应答帧必须收卡');
});

test('C1-a：实时无 actionId 的应答帧维持旧行为（无条件收卡），不破坏旧后端兼容', () => {
    const api = loadQuestionFrameHandlers();
    const sess = newSess();
    api.appendQuestionCard(sess, { actionId: 'call-B', args: { questions: [{ header: 'B?' }] } });
    api.handleQuestionAnsweredFrame(sess, {});
    assert.equal(sess._questionState, null, '实时链路上无 actionId 的应答帧应按旧行为收卡');
});

/* ===== C1-b：actionId 提交闭环 ===== */

test('C1-b：问答提交携带 actionId，且不得携带 input 键', () => {
    const submit = fnBody(message, 'handleQuestionResponse');
    assert.match(submit, /if \(state\.actionId\) fields\.actionId = String\(state\.actionId\);/,
        '问答提交必须带上本张卡的 actionId');
    assert.match(submit, /questionAnswer: JSON\.stringify\(buildQuestionAnswersPayload\(state\)\)/);
    assert.ok(!/input\s*:/.test(submit), '续轮路径不得携带 input 键');

    // 空 actionId 不入表：旧快照恢复的挂起任务本就没有 id，补空串会让它永远提交不了
    const guard = submit.indexOf('if (state.actionId)');
    const append = submit.indexOf('fields.actionId');
    assert.ok(guard >= 0 && append > guard, 'actionId 必须在存在性判断之后才写入');
});

test('C1-b：HITL 审批/拒绝都把卡片自己的 actionId 传给 handleHitlResponse', () => {
    const hitl = fnBody(message, 'appendHitlCard');
    assert.match(hitl, /handleHitlResponse\(sess, 'approve', actionId\);/,
        '批准必须带 actionId（误批准不可逆，身份必须可校验）');
    assert.match(hitl, /handleHitlResponse\(sess, 'reject', actionId\);/);

    const resp = fnBody(message, 'handleHitlResponse');
    assert.match(resp, /function handleHitlResponse\(sess, action, actionId\)/);
    assert.match(resp, /if \(actionId\) fields\.actionId = actionId;/);
    assert.ok(!/input\s*:/.test(resp), '续轮路径不得携带 input 键');
});

test('C1-b：后端读取 actionId 并在不匹配时以明确错误拒绝（不静默应用到别的任务）', () => {
    const controller = readJava('com/gourdai/core/portal/web/WebController.java');
    assert.match(controller, /String actionId = ctx\.param\("actionId"\);/, '控制器必须读取 actionId 参数');
    assert.match(controller, /WebGate\.InputResult\.ACTION_MISMATCH/, '控制器必须识别不匹配结果');
    assert.match(controller, /Result\.failure\(409,/, '不匹配必须返回明确错误（409 冲突），不得当成功');
    // busy 语义不得被顺带改掉
    assert.match(controller, /WebGate\.InputResult\.BUSY/);
    assert.match(controller, /return Result\.succeed\("busy"\);/);

    const gate = readJava('com/gourdai/core/portal/web/WebGate.java');
    assert.match(gate, /public enum InputResult \{/, '需要三态返回：受理 / 繁忙 / 身份不匹配');
    assert.match(gate, /ACTION_MISMATCH/);

    // HITL 更严：带了 id 就必须真的存在挂起任务且完全一致，否则拒绝
    const hitlBranch = sliceBetween(gate, '// HITL approve/reject handling', '// ask_user 结构化问答恢复处理');
    assert.match(hitlBranch, /if \(Assert\.isNotEmpty\(actionId\)\) \{/);
    assert.match(hitlBranch, /if \(task == null\) \{[\s\S]*?return InputResult\.ACTION_MISMATCH;/,
        'HITL 带 id 但无挂起任务必须拒绝（绝不能落到别的调用上）');
    assert.match(hitlBranch, /if \(!actionId\.equals\(task\.getActionId\(\)\)\) \{[\s\S]*?return InputResult\.ACTION_MISMATCH;/,
        'HITL id 不一致必须拒绝');
    // 批准动作必须在校验之后
    const strictIdx = hitlBranch.indexOf('Assert.isNotEmpty(actionId)');
    const approveIdx = hitlBranch.indexOf('HITL.approve(');
    assert.ok(strictIdx >= 0 && approveIdx > strictIdx, '校验必须早于 approve/reject 的执行');

    // 问答：仅在两边都有 id 且不同时拒绝（无挂起任务时仍需回确认帧，避免卡片永久卡死）
    const askBranch = sliceBetween(gate, '// ask_user 结构化问答恢复处理', '// Handle file upload');
    assert.match(askBranch, /Assert\.isNotEmpty\(actionId\) && task != null[\s\S]*?!actionId\.equals\(task\.getActionId\(\)\)/,
        '问答仅在两边都有 id 且不同时拒绝');
    assert.match(askBranch, /WebChunk\.ofQuestionAnswered\(AskUserTool\.TOOL_NAME,[\s\S]*?answeredActionId\)/,
        '确认帧必须回传 actionId 形成闭环');
    assert.match(askBranch, /WebChunk\.ofDone\(\)/, '无挂起任务时仍需补 done 收口');
});

test('C1-b：向后兼容——不传 actionId 时降级按旧逻辑执行，但必须留警告日志', () => {
    const gate = readJava('com/gourdai/core/portal/web/WebGate.java');
    assert.match(gate, /hitl decision without actionId for session \{\}/,
        '旧前端 HITL 提交必须留痕（这正是可能批错任务的唐突窗口）');
    assert.match(gate, /question answer without actionId for session \{\}/);
    // 降级路径仍然执行旧逻辑，不能直接拒绝
    const hitlBranch = sliceBetween(gate, '// HITL approve/reject handling', '// ask_user 结构化问答恢复处理');
    assert.match(hitlBranch, /\} else if \(task != null\) \{/, '不传 id 时走降级分支而非拒绝');
});

test('C1-b：question_answered 帧新增带 actionId 的工厂，旧两参工厂保留并委托', () => {
    const chunk = readJava('com/gourdai/core/portal/web/WebChunk.java');
    assert.match(chunk,
        /public static WebChunk ofQuestionAnswered\(String toolName, List<Map<String, Object>> answers\) \{\s*\n\s*return ofQuestionAnswered\(toolName, answers, null\);\s*\n\s*\}/,
        '旧两参工厂必须保留并委托，既有调用方与反序列化不受影响');
    assert.match(chunk,
        /public static WebChunk ofQuestionAnswered\(String toolName, List<Map<String, Object>> answers, String actionId\) \{[\s\S]*?tmp\.actionId = actionId;/,
        '新工厂必须把 actionId 投影到帧上');
});

/* ===== C1-c：挂起 done 不清批次索引 ===== */

/* 在沙箱里跑真实的 isSuspendedDone：它只读 chunk.suspended 与 sess.phase，无 DOM 依赖 */
function loadSuspendedDetector() {
    const src = "var PHASE_QUESTION = 'question'; var PHASE_HITL = 'hitl'; var PHASE_TEXT = 'text'; var PHASE_DONE = 'done';\n"
        + fnBody(streaming, 'isSuspendedDone')
        + '\nreturn isSuspendedDone;';
    return new Function(src)();
}

test('C1-c：挂起 done 的识别——显式标记优先，旧后端按相位降级', () => {
    const isSuspendedDone = loadSuspendedDetector();

    // 后端显式标记（WebChunk.suspended）
    assert.equal(isSuspendedDone({ phase: 'done' }, { type: 'done', suspended: true }), true);

    // 旧后端无该字段：靠上一帧相位降级判断（question/hitl 之后紧跟的 done）
    assert.equal(isSuspendedDone({ phase: 'question' }, { type: 'done' }), true);
    assert.equal(isSuspendedDone({ phase: 'hitl' }, { type: 'done' }), true);

    // 真正结束的 done 必须判为 false，否则批次索引永不清理（内存泄漏 + 跨轮串组）
    assert.equal(isSuspendedDone({ phase: 'done' }, { type: 'done' }), false);
    assert.equal(isSuspendedDone({ phase: 'text' }, { type: 'done' }), false);
    assert.equal(isSuspendedDone(null, { type: 'done' }), false);
    assert.equal(isSuspendedDone({ phase: 'question' }, { type: 'done', suspended: false }), true,
        'suspended=false 但相位仍是 question：降级判断仍应保守认定为挂起');
});

test('C1-c：finishStream 在挂起收尾时保留批次/卡片索引与已完成集合', () => {
    const fin = fnBody(streaming, 'finishStream');
    assert.match(fin, /function finishStream\(sess, opts\)/);
    assert.match(fin, /var keepBatchIndex = !!\(opts && opts\.keepBatchIndex\);/);

    // 三处索引清理都必须受 keepBatchIndex 门禁
    assert.match(fin, /if \(!keepBatchIndex\) \{\s*\n\s*sess\.toolBatchesById = \{\};\s*\n\s*sess\.toolCardsById = \{\};\s*\n\s*\}/,
        '挂起收尾不得清空批次与卡片索引');
    assert.match(fin, /if \(sess\.toolBatchesById && !keepBatchIndex\) \{/,
        '挂起收尾不得把仍在等待的批次标成 warn');
    // 扫尾容器已由 sess.container 改为渲染落点 renderRoot(sess)（回放期＝临时容器，
    // 实时期＝真实容器）。断言意图不变：挂起收尾仍不得把 loading 工具卡标成 warn。
    assert.match(fin, /var finishRoot = renderRoot\(sess\);/,
        '扫尾必须取渲染落点，而不是直接用 sess.container');
    assert.match(fin, /if \(finishRoot && !keepBatchIndex\) \{/,
        '挂起收尾不得把 loading 工具卡标成 warn（它们真的还在待执行）');
    assert.match(fin, /if \(!keepBatchIndex && typeof removeOrphanArgsStreamingCards === 'function'\)/,
        '挂起收尾不得删除参数生成期骨架卡（恢复后它们还会等到 action_start）');

    // completedActionIds 被 resetStreamState 清掉会导致恢复后重复建卡，必须快照回填
    assert.match(fin, /var keptCompletedActionIds = keepBatchIndex \? sess\.completedActionIds : null;/);
    assert.match(fin, /if \(keepBatchIndex\) sess\.completedActionIds = keptCompletedActionIds \|\| \{\};/);
    const resetIdx = fin.indexOf('resetStreamState(sess);');
    const restoreIdx = fin.indexOf('sess.completedActionIds = keptCompletedActionIds');
    assert.ok(resetIdx >= 0 && restoreIdx > resetIdx, '回填必须在 resetStreamState 之后');
});

test('C1-c：done 分发按挂起与否决定是否保留批次索引', () => {
    const dispatch = fnBody(streaming, 'dispatchGateChunk');
    assert.match(dispatch, /finishStream\(sess, \{ keepBatchIndex: isSuspendedDone\(sess, chunk\) \}\);/,
        'done 分发必须把挂起判定结果传给 finishStream');
});

test('C1-c：后端 done 帧在会话挂起时打上 suspended 标记', () => {
    const chunk = readJava('com/gourdai/core/portal/web/WebChunk.java');
    assert.match(chunk, /private Boolean suspended;/, 'WebChunk 需要可辨识的挂起标记字段');
    assert.match(chunk, /public static WebChunk ofDoneSuspended\(\) \{[\s\S]*?tmp\.suspended = true;/);

    const gate = readJava('com/gourdai/core/portal/web/WebGate.java');
    assert.match(gate, /if \(session\.isPending\(\) && line\.getSuspended\(\) == null\) \{\s*\n\s*line\.setSuspended\(true\);/,
        '出站 done 帧必须在会话挂起时补标记（不覆盖上游已显式设置的值）');
});
