/**
 * 契约测试：pendingQuestion 兜底拉取（契约 PLAN-ask-summary-contract.md §6 / §3.4）。
 *
 * ── 契约要点 ────────────────────────────────────────────────────────────────
 * 端点冻结：GET /web/chat/pendingQuestion?sessionId=<sid>
 *   200 → {"code":200,"data":null}（无挂起）或 {"code":200,"data":{actionId,questions}}。
 * 会话加载完成（loadMessages→replaySession 收尾 / legacy loadDone）后：
 *   ① sess._questionState 为空或已 submitted → 发探测；
 *   ② data 非 null 且 actionId 与现状态不同 → 构造 {type:'question',actionId,
 *      toolName:'ask_user',args:{questions}} 走 appendQuestionCard 同构入口建卡；
 *   ③ data 为 null 且本地有未提交状态 → 清 _questionState 并 syncQuestionCard 收卡（防僵尸卡）；
 *   ④ 请求失败静默忽略；回放隔离规则不变；同一会话同一时刻只发一次
 *      （_pendingQuestionProbe 防抖标记，完成后清）。
 *
 * ── 手法 ────────────────────────────────────────────────────────────────────
 * 沿用 hitl-suspend-boundary.test.js：probePendingQuestion 从【两份入库源】按花括号
 * 配平切出、装进 node:vm 真跑（fetch/appendQuestionCard/syncQuestionCard 以桩注入，
 * 不造 DOM）；appendQuestionCard 也从真实源码切出（其内部依赖的 normalizeQuestionArgs/
 * createQuestionCardState 用状态机区块真实现），保证「同构入口」断言测的是生产代码。
 * 接线锁：replayDoneCore 与 legacy loadDone 两处收尾必须调 window.probePendingQuestion，
 * 且 replay 路径带 !prepend 门禁（上拉加载更早历史不得触发探测）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.resolve(__dirname, '..', '..', '..');
const SOURCES = [
    ['Rust桌面端', 'gourd-work/desktop/ui/js/app-message.js', 'gourd-work/desktop/ui/js/app-history.js'],
    ['JavaWeb端', 'gourdai-java/gourd-ai-agent/src/main/resources/static/js/app-message.js',
        'gourdai-java/gourd-ai-agent/src/main/resources/static/js/app-history.js']
];

/* 按花括号配平切出一个函数定义（与 hitl-suspend-boundary.test.js 同口径） */
function extractFn(src, anchor) {
    const start = src.indexOf(anchor);
    assert.ok(start >= 0, '定义丢失: ' + anchor);
    let depth = 0;
    let i = src.indexOf('{', start);
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    assert.equal(depth, 0, '花括号不配平: ' + anchor);
    return src.slice(start, i + 1);
}

const BLOCK_START = '/* ---- 问答卡状态机（纯函数；行为测试整段提取执行，区块内不得引用 DOM/全局） ---- */';
const BLOCK_END = '/* ---- 问答卡 DOM 渲染 ---- */';

/* 组装可运行的 probe 环境：
   - 状态机区块 + appendQuestionCard 用真实源码（同构入口不造假）；
   - fetch 桩返回可控响应并记录调用；appendQuestionCard 的活动会话渲染桩掉 syncQuestionCard；
   - sessionMap/activeSessionId 挂 sandbox，模拟真实全局。 */
function buildProbeEnv(messageRel, opts) {
    const src = fs.readFileSync(path.join(repo, messageRel), 'utf8').replace(/^\uFEFF/, '');
    const bStart = src.indexOf(BLOCK_START);
    const bEnd = src.indexOf(BLOCK_END, bStart);
    assert.ok(bStart >= 0 && bEnd > bStart, messageRel + '：状态机区块标记丢失');
    const stateMachine = src.slice(bStart, bEnd);
    const appendFn = extractFn(src, 'function appendQuestionCard(sess, chunk) {');
    const probeFn = extractFn(src, 'function probePendingQuestion(sess) {');

    const calls = { fetch: [], append: [], sync: 0 };
    const sandbox = {
        window: {},
        sessionMap: {},
        activeSessionId: (opts && opts.activeSessionId) || 's1',
        encodeSessionCwdHeader: function(s) { return 'enc:' + s; },
        console: { error: function() {} },
        fetch: function(url, init) {
            calls.fetch.push({ url: url, init: init });
            const resp = (opts && opts.respond) ? opts.respond(url) : { ok: true, code: 200, data: null };
            if (resp instanceof Error) return Promise.reject(resp);
            return Promise.resolve({
                ok: resp.ok !== false,
                status: resp.status || 200,
                json: function() { return Promise.resolve({ code: resp.code, data: resp.data }); }
            });
        },
        syncQuestionCard: function() { calls.sync++; }
    };
    vm.createContext(sandbox);
    vm.runInContext(stateMachine + '\n' + appendFn + '\n' + probeFn, sandbox, { filename: messageRel });
    // appendQuestionCard 内部调 syncQuestionCard：包一层记录调用（不改生产逻辑）
    vm.runInContext(
        'var __realAppend = appendQuestionCard;' +
        'appendQuestionCard = function(sess, chunk) { __calls.append.push(chunk); return __realAppend(sess, chunk); };',
        Object.assign(sandbox, { __calls: calls })
    );
    // 重新注入被覆盖前的引用链：probe 闭包里的 appendQuestionCard 是全局查找，覆盖即生效
    sandbox.__calls = calls;
    return { sandbox, calls, probe: sandbox.probePendingQuestion };
}

/* 等微任务队列排空（probe 的 fetch promise 链） */
function flush() { return new Promise(function(resolve) { setImmediate(resolve); }); }

const QUESTIONS = [{ header: '挂起的提问', multiSelect: true, options: [{ label: '甲' }, { label: '乙' }] }];

for (const [name, messageRel, historyRel] of SOURCES) {
    test(`[${name}] 空状态 + data 非空：走 appendQuestionCard 同构入口建卡（multiSelect 透传）`, async () => {
        const env = buildProbeEnv(messageRel, {
            respond: () => ({ ok: true, code: 200, data: { actionId: 'act-9', questions: QUESTIONS } })
        });
        const sess = { sessionId: 's1', projectRoot: 'C:/proj' };
        env.sandbox.sessionMap.s1 = sess;
        env.probe(sess);
        assert.equal(env.calls.fetch.length, 1, '空状态必须发探测');
        assert.match(env.calls.fetch[0].url, /^\/web\/chat\/pendingQuestion\?sessionId=s1$/, '端点与参数冻结');
        assert.equal(env.calls.fetch[0].init.headers['X-Session-Cwd'], 'enc:C:/proj', '与 todos 同口径带会话根头');
        assert.equal(sess._pendingQuestionProbe, true, '在途期间防抖标记必须置位');
        await flush();
        assert.equal(env.calls.append.length, 1, '必须走 appendQuestionCard 同构入口');
        const chunk = env.calls.append[0];
        assert.equal(chunk.type, 'question');
        assert.equal(chunk.actionId, 'act-9');
        assert.equal(chunk.toolName, 'ask_user');
        assert.deepEqual(chunk.args.questions, QUESTIONS, '题面原样透传（normalize 在入口内做）');
        assert.ok(sess._questionState, '状态已建立');
        assert.equal(sess._questionState.actionId, 'act-9');
        assert.equal(sess._questionState.questions[0].multiSelect, true, 'normalizeQuestionArgs 收下 multiSelect');
        assert.equal(sess._pendingQuestionProbe, false, '完成后清防抖标记');
        assert.ok(env.calls.sync > 0, '活动会话建卡后必须 syncQuestionCard 渲染');
    });

    test(`[${name}] F3：未提交活跃卡 + data:null → 清僵尸卡（旧实现此分支不可达）`, async () => {
        const env = buildProbeEnv(messageRel, { respond: () => ({ ok: true, code: 200, data: null }) });
        const sess = { sessionId: 's1' };
        env.sandbox.sessionMap.s1 = sess;
        // 本地残留一张【未提交】活跃卡（他端已作答但 answered 帧丢失的场景）
        sess._questionState = env.sandbox.createQuestionCardState('act-zombie',
            env.sandbox.normalizeQuestionArgs({ questions: QUESTIONS }));
        env.probe(sess);
        assert.equal(env.calls.fetch.length, 1, 'F3：活跃卡也探测（前置门禁已放行）');
        await flush();
        assert.equal(sess._questionState, null, '后端已无挂起 → 僵尸卡必须收掉');
        assert.ok(env.calls.sync > 0, '收卡后必须 syncQuestionCard 刷新界面');
        assert.equal(env.calls.append.length, 0, 'null 响应绝不建卡');
        assert.equal(sess._pendingQuestionProbe, false);
    });

    test(`[${name}] 已提交快照 + data:null：保持不动（已提交卡归提交流程收）`, async () => {
        const env = buildProbeEnv(messageRel, { respond: () => ({ ok: true, code: 200, data: null }) });
        const sess = { sessionId: 's1' };
        env.sandbox.sessionMap.s1 = sess;
        sess._questionState = env.sandbox.createQuestionCardState('act-old',
            env.sandbox.normalizeQuestionArgs({ questions: QUESTIONS }));
        sess._questionState.submitted = true;
        env.probe(sess);
        await flush();
        assert.ok(sess._questionState, '已提交快照遇 data:null 保持不动（清卡只针对未提交态）');
        assert.equal(sess._questionState.actionId, 'act-old');
        assert.equal(sess._pendingQuestionProbe, false);
        assert.equal(env.calls.append.length, 0, 'null 响应绝不建卡');
    });

    test(`[${name}] F3：未提交活跃卡 + 同 actionId 响应 → 保留作答进度不抢占`, async () => {
        const env = buildProbeEnv(messageRel, {
            respond: () => ({ ok: true, code: 200, data: { actionId: 'act-live', questions: QUESTIONS } })
        });
        const sess = { sessionId: 's1' };
        env.sandbox.sessionMap.s1 = sess;
        sess._questionState = env.sandbox.createQuestionCardState('act-live',
            env.sandbox.normalizeQuestionArgs({ questions: QUESTIONS }));
        // 用户已勾了第一项：探测不得把作答进度冲掉
        env.sandbox.toggleQuestionMultiOption(sess._questionState, 0, '甲');
        env.probe(sess);
        assert.equal(env.calls.fetch.length, 1, 'F3：活跃卡也探测');
        await flush();
        assert.equal(env.calls.append.length, 0, '同 actionId 不得重建卡');
        assert.equal(sess._questionState.actionId, 'act-live');
        // vm realm 数组与宿主数组原型不同，deepEqual 前 JSON 归一（与多选测试同手法）
        assert.deepEqual(JSON.parse(JSON.stringify(sess._questionState.answers[0].texts)), ['甲'], '作答进度必须保留');
    });

    test(`[${name}] 防抖：同一会话在途只发一次；完成后可再探`, async () => {
        const env = buildProbeEnv(messageRel, { respond: () => ({ ok: true, code: 200, data: null }) });
        const sess = { sessionId: 's1' };
        env.sandbox.sessionMap.s1 = sess;
        env.probe(sess);
        env.probe(sess);
        env.probe(sess);
        assert.equal(env.calls.fetch.length, 1, '在途期间重复调用必须被防抖吞掉');
        await flush();
        env.probe(sess);
        assert.equal(env.calls.fetch.length, 2, '完成清标记后允许下一次探测');
        await flush();
    });

    test(`[${name}] 回放期间不探测；迟到响应遇活跃卡/换代会话不得越权`, async () => {
        // ① _replaying=true 直接早退
        const env = buildProbeEnv(messageRel, {
            respond: () => ({ ok: true, code: 200, data: { actionId: 'act-x', questions: QUESTIONS } })
        });
        const sess = { sessionId: 's1', _replaying: true };
        env.sandbox.sessionMap.s1 = sess;
        env.probe(sess);
        assert.equal(env.calls.fetch.length, 0, '回放期间不得探测（回放隔离规则不变）');
        // ② 响应迟到时会话已换代（sessionMap 换了对象）→ 丢弃
        const env2 = buildProbeEnv(messageRel, {
            respond: () => ({ ok: true, code: 200, data: { actionId: 'act-x', questions: QUESTIONS } })
        });
        const stale = { sessionId: 's1' };
        env2.sandbox.sessionMap.s1 = stale;
        env2.probe(stale);
        env2.sandbox.sessionMap.s1 = { sessionId: 's1' };   // 切代
        await flush();
        assert.equal(stale._questionState, undefined, '迟到响应不得写已切代会话');
        assert.equal(env2.calls.append.length, 0);
        // ③ 响应迟到时用户已开始作答另一张卡 → 不覆盖
        const env3 = buildProbeEnv(messageRel, {
            respond: () => ({ ok: true, code: 200, data: { actionId: 'act-x', questions: QUESTIONS } })
        });
        const sess3 = { sessionId: 's1' };
        env3.sandbox.sessionMap.s1 = sess3;
        env3.probe(sess3);
        sess3._questionState = env3.sandbox.createQuestionCardState('act-user',
            env3.sandbox.normalizeQuestionArgs({ questions: [{ header: '用户正在答的题' }] }));
        await flush();
        assert.equal(sess3._questionState.actionId, 'act-user', '不得覆盖用户正在作答的卡');
        assert.equal(env3.calls.append.length, 0);
    });

    test(`[${name}] actionId 与现状态相同：不重复建卡（契约「不同才建」）`, async () => {
        const env = buildProbeEnv(messageRel, {
            respond: () => ({ ok: true, code: 200, data: { actionId: 'act-same', questions: QUESTIONS } })
        });
        const sess = { sessionId: 's1' };
        env.sandbox.sessionMap.s1 = sess;
        sess._questionState = env.sandbox.createQuestionCardState('act-same',
            env.sandbox.normalizeQuestionArgs({ questions: QUESTIONS }));
        sess._questionState.submitted = true;   // 已提交快照 → 允许探测
        env.probe(sess);
        await flush();
        assert.equal(env.calls.append.length, 0, '同 actionId 不得重复建卡');
        assert.equal(sess._questionState.actionId, 'act-same', '原状态保持不动');
    });

    test(`[${name}] 请求失败/非 200：静默忽略、清防抖标记、不动本地状态`, async () => {
        // 网络层失败
        const env = buildProbeEnv(messageRel, { respond: () => new Error('network down') });
        const sess = { sessionId: 's1' };
        env.sandbox.sessionMap.s1 = sess;
        env.probe(sess);
        await flush();
        assert.equal(sess._pendingQuestionProbe, false, '失败也必须清防抖标记');
        assert.equal(sess._questionState, undefined, '失败不得动本地状态');
        assert.equal(env.calls.append.length, 0);
        // HTTP 4xx/5xx（fetch 不 reject，须 r.ok 拦截）
        const env2 = buildProbeEnv(messageRel, { respond: () => ({ ok: false, status: 500, code: 500, data: null }) });
        const sess2 = { sessionId: 's1' };
        env2.sandbox.sessionMap.s1 = sess2;
        env2.probe(sess2);
        await flush();
        assert.equal(sess2._pendingQuestionProbe, false);
        assert.equal(env2.calls.append.length, 0);
        // 业务码非 200
        const env3 = buildProbeEnv(messageRel, { respond: () => ({ ok: true, code: 400, data: null }) });
        const sess3 = { sessionId: 's1' };
        env3.sandbox.sessionMap.s1 = sess3;
        sess3._questionState = env3.sandbox.createQuestionCardState('a',
            env3.sandbox.normalizeQuestionArgs({ questions: QUESTIONS }));
        sess3._questionState.submitted = true;
        env3.probe(sess3);
        await flush();
        assert.ok(sess3._questionState, '业务失败不得清本地状态（与 data:null 语义区分）');
    });

    test(`[${name}] 接线锁：replayDoneCore（!prepend）与 legacy loadDone 均调 probePendingQuestion`, () => {
        const hist = fs.readFileSync(path.join(repo, historyRel), 'utf8').replace(/^\uFEFF/, '');
        // replayDoneCore：初始加载收尾必须探测，prepend（上拉加载更早历史）不得触发
        const coreStart = hist.indexOf('function replayDoneCore() {');
        assert.ok(coreStart > 0, 'replayDoneCore 丢失');
        const coreEnd = hist.indexOf('\n    // 启动分片回放', coreStart);
        assert.ok(coreEnd > coreStart, 'replayDoneCore 边界锚点丢失');
        const core = hist.slice(coreStart, coreEnd);
        assert.ok(core.includes("if (!prepend && typeof window.probePendingQuestion === 'function') window.probePendingQuestion(sess);"),
            'replayDoneCore 必须在排空缓冲后按 !prepend 门禁探测');
        const iDrain = core.indexOf('drainGateBuffer(sess);');
        const iProbe = core.indexOf('window.probePendingQuestion(sess);');
        assert.ok(iDrain > 0 && iProbe > iDrain, '探测必须在回放收尾排空缓冲之后（先回放重建、后兜底）');
        // legacy loadDone：同口径接线
        const legacyStart = hist.indexOf('function loadDone() {');
        assert.ok(legacyStart > 0, 'legacy loadDone 丢失');
        const legacyEnd = hist.indexOf('loadChunk();', legacyStart);
        assert.ok(legacyEnd > legacyStart, 'legacy loadDone 边界锚点丢失');
        const legacy = hist.slice(legacyStart, legacyEnd);
        assert.ok(legacy.includes("if (typeof window.probePendingQuestion === 'function') window.probePendingQuestion(sess);"),
            'legacy 回退路径同样是会话加载完成，必须接线');
    });
}

/* ── 镜像一致性：probe 函数与接线两份入库源逐字一致 ── */

test('两份入库源的 probePendingQuestion 函数逐字一致', () => {
    const fns = SOURCES.map(([, rel]) => {
        const src = fs.readFileSync(path.join(repo, rel), 'utf8').replace(/^\uFEFF/, '');
        return extractFn(src, 'function probePendingQuestion(sess) {').replace(/\r\n/g, '\n');
    });
    assert.equal(fns[0], fns[1], 'probePendingQuestion 双端漂移——必须逐字镜像');
});

test('两份入库源的 appendQuestionCard 同构入口逐字一致（probe 依赖的建卡路径）', () => {
    const fns = SOURCES.map(([, rel]) => {
        const src = fs.readFileSync(path.join(repo, rel), 'utf8').replace(/^\uFEFF/, '');
        return extractFn(src, 'function appendQuestionCard(sess, chunk) {').replace(/\r\n/g, '\n');
    });
    assert.equal(fns[0], fns[1], 'appendQuestionCard 双端漂移');
});