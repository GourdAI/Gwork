/**
 * 契约测试：命令授权（HITL）挂起 → 恢复，必须复用 ask 场景的两轮修复。
 *
 * ── 报障现场（2026-11 用户「命令授权的那个也有同样的问题」）─────────────
 * 落盘帧 work-mw4m8qep L139845-139888 逐字复原：
 *   action_start bash  actionId=chatcmpl-tool-9ede4134641af581
 *   hitl               phase=hitl  command=<powershell probe>   ← 审批卡
 *   done               suspended=true  run-fd81760b              ← 挂起
 *   ... 用户批准 ...
 *   action_start       run-717f870a                              ← 恢复段（新 runId）
 * 该会话跑的是 17:25 之前的旧二进制，恢复段确实 mint 了新 runId；这正是
 * 「两张已编辑卡 / 两个正在执行中」的现场。
 *
 * ── 本文件要钉死的结论（code review 回归护栏）───────────────────────────
 * HITL 与 ask_user 共用同一条挂起/恢复链路，因此前两轮修复【已经覆盖】：
 *   ① 后端 handle_hitl_action 的 approve/deny 两条分支都调 spawn_resume，
 *      而 spawn_resume 沿用 sp.run_id 并 reopen ledger → 一张累计文件卡；
 *   ② 前端 isSuspendedDone 认 done.suspended=true（HITL 帧实证带该字段），
 *      旧后端无该字段时降级认 PHASE_HITL → finishStream(keepBatchIndex)
 *      → 挂起分支的 settleSteerTurnBoundary 收口旧气泡（见
 *      suspend-turn-boundary.test.js，那里用真实假 DOM 跑通了收口动作）。
 * 之前的测试只覆盖了 ask 的帧时序，HITL 一个字都没有：任何人把
 * `|| sess.phase === PHASE_HITL` 删掉、或把 deny 分支改成不 spawn_resume，
 * 全量测试依旧全绿而用户又会在授权场景看到两个「正在执行中」。
 *
 * 本文件不做「读运行时会话数据」的测试（会话目录不属于构建产物）；
 * 前端两个判定函数从真实源码切出、装进 node:vm 真跑，后端做生产源码接线锁。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.resolve(__dirname, '..', '..', '..');
const desktop = path.resolve(__dirname, '..');
const STREAM_SRC = fs.readFileSync(path.join(desktop, 'ui', 'js', 'app-streaming.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(repo, 'gourd-work', 'core', 'src', 'server', 'mod.rs'), 'utf8');

/* 从真实源码按花括号配平切出一个函数定义（与 steer/suspend 两份契约测试同口径） */
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

const PHASES_SRC = [
    "var PHASE_WAITING = 'waiting', PHASE_THINKING = 'thinking', PHASE_TEXT = 'text',",
    "    PHASE_TOOL = 'tool', PHASE_HITL = 'hitl', PHASE_QUESTION = 'question',",
    "    PHASE_RETRY = 'retry', PHASE_DONE = 'done';"
].join('\n');

/* ── 前端：HITL 帧必须被识别为「挂起轮」，否则收口分支根本不会触发 ────── */

test('★ inferPhaseFromType：hitl 帧推进到 hitl 相位（旧帧 fallback 的前提）', () => {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(PHASES_SRC + '\n' + extractFn(STREAM_SRC, 'function inferPhaseFromType'), sandbox);
    assert.equal(sandbox.inferPhaseFromType('hitl'), 'hitl', 'hitl 帧必须把相位推到 PHASE_HITL');
    assert.equal(sandbox.inferPhaseFromType('question'), 'question');
    assert.equal(sandbox.inferPhaseFromType('done'), 'done');
});

test('★ isSuspendedDone：HITL 挂起 done 与旧帧 fallback 都判为挂起，真收口不误判', () => {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(PHASES_SRC + '\n' + extractFn(STREAM_SRC, 'function isSuspendedDone(sess, chunk) {'), sandbox);
    const f = sandbox.isSuspendedDone;
    // 真实落盘帧 work-mw4m8qep L139847: {"type":"done","suspended":true}
    assert.equal(f({}, { type: 'done', suspended: true }), true, 'HITL 挂起 done 必须走 keepBatchIndex');
    // 旧后端 / 历史回放帧不带 suspended：靠相位降级，HITL 与 ask 并列在门禁里
    assert.equal(f({ phase: 'hitl' }, { type: 'done' }), true, 'HITL 必须在相位 fallback 里');
    assert.equal(f({ phase: 'question' }, { type: 'done' }), true, 'ask 不得被 HITL 修复挤掉');
    // 真正结束的轮不得误判成挂起（否则走不到 compactBubble / ended:true）
    assert.equal(f({ phase: 'done' }, { type: 'done' }), false);
    assert.equal(f({ phase: 'tool' }, { type: 'done' }), false);
});

test('★ 接线锁：done 分支把 isSuspendedDone 的结果作为 keepBatchIndex 传给 finishStream', () => {
    assert.ok(
        STREAM_SRC.includes('finishStream(sess, { keepBatchIndex: isSuspendedDone(sess, chunk) })'),
        'HITL/ask 挂起判定与 finishStream 的接线断开会让收口分支永不触发'
    );
});

test('★ 接线锁：挂起轮边界收口分支覆盖 HITL（注释口径 + 复位顺序）', () => {
    const fnStart = STREAM_SRC.indexOf('function finishStream(sess, opts) {');
    assert.ok(fnStart > 0);
    const body = STREAM_SRC.slice(fnStart, STREAM_SRC.indexOf('\nfunction ', fnStart + 10));
    const iSuspend = body.indexOf('if (keepBatchIndex && !sess._replaying');
    const iSettle = body.indexOf("settleSteerTurnBoundary(sess, { status: 'suspended' });", iSuspend);
    const iReset = body.indexOf('resetStreamState(sess);', iSuspend);
    assert.ok(iSuspend > 0 && iSettle > iSuspend && iReset > iSettle,
        '挂起收口必须在清指针之前（HITL 与 ask 共用这一处）');
    assert.ok(/ask_user \/ HITL/.test(body), '分支注释必须同时声明两类挂起，防止被窄化成 ask 专用');
});

/* ── 后端：批准 / 拒绝两条分支都必须沿用挂起时的 runId + reopen ───────── */

test('★ 后端：handle_hitl_action 的 approve 与 deny 都走 spawn_resume（一张累计文件卡）', () => {
    // 断言字面量写在本 JS 文件里，不会出现在 SERVER_SRC 中，故无 include_str! 自匹配陷阱；
    // 仍只取生产半段，避免将来有人在 Rust 测试模块里写同名字符串把断言喂饱。
    const prod = SERVER_SRC.split('#[cfg(test)]')[0];
    const start = prod.indexOf('async fn handle_hitl_action(');
    assert.ok(start > 0, 'handle_hitl_action 缺失');
    const end = prod.indexOf('async fn auto_approve_and_resume(', start);
    assert.ok(end > start, '函数边界锚点缺失（共享放行尾巴必须紧随其后）');
    const body = prod.slice(start, end);
    /* 【2026-11 重构】approve 分支收敛进共享尾巴 auto_approve_and_resume（切完全
       访问自动放行复用同一实现），deny 仍直调 spawn_resume。语义不变：两条分支
       都必须以「执行/拒绝 + spawn_resume（沿用 runId + reopen）」收尾。 */
    assert.equal((body.match(/^\s*auto_approve_and_resume\(/gm) || []).length, 1,
        'approve 必须走共享放行尾巴（与切档自动放行同一实现）');
    assert.equal((body.match(/^\s*spawn_resume\(/gm) || []).length, 1,
        'deny 必须直调 spawn_resume；漏掉会让拒绝分支 mint 新 runId / 漏 reopen');
    assert.ok(!body.includes('new_run_id()'), 'HITL 决策分支不得自行铸造 runId');
    // 共享尾巴本身必须真的续跑（不是只收卡的空壳）
    const aStart = prod.indexOf('async fn auto_approve_and_resume(');
    assert.ok(aStart > 0, '共享放行尾巴缺失');
    const aEnd = prod.indexOf('fn format_answers_for_llm(', aStart);
    const aBody = prod.slice(aStart, aEnd > aStart ? aEnd : undefined);
    assert.ok(aBody.includes('spawn_resume('), '共享尾巴必须 spawn_resume 续跑');
    assert.ok(aBody.includes('execute_approved_command('), '共享尾巴必须真实执行被批准的命令');
    assert.ok(!aBody.includes('new_run_id()'), '共享尾巴不得自行铸造 runId');
});

/* ── 2026-11 用户报障「切了完全访问还弹授权框；批了一次后又弹」 ────────────
 * 根因：run 的 access_mode 是启动时快照。① 运行中切 full 对已 spawn 的 run 不生效
 * （下一张 hitl 卡照弹）；② 挂起中切 full 只收卡不续跑（挂起悬空，模型重试同一命令
 * 再弹一卡）；③ 恢复 run 沿用挂起快照 default，批准后的新命令又被门控。
 * 三层修复的接线在此钉死。 */

test('★ 后端：run 内档位活读——ReActConfig.access_override 必须接到 ToolContext', () => {
    const fs = require('node:fs');
    const reactSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'core', 'src', 'react', 'mod.rs'), 'utf8');
    const prod = reactSrc.split('#[cfg(test)]')[0];
    assert.ok(/pub access_override:/.test(prod), 'ReActConfig 缺活读句柄字段');
    const i = prod.indexOf('let tool_ctx = ToolContext {');
    assert.ok(i > 0, 'tool_ctx 构造点缺失');
    const lit = prod.slice(i, prod.indexOf('};', i));
    assert.ok(lit.includes('access_override: config.access_override.clone()'),
        '活读句柄没有传进 ToolContext：门控仍读启动快照，切档对运行中 run 不生效');
    const regSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'core', 'src', 'tools', 'registry.rs'), 'utf8');
    const regProd = regSrc.split('#[cfg(test)]')[0];
    assert.ok(/pub fn live_access_mode\(&self\) -> String/.test(regProd), '缺 live_access_mode 单点解析');
    const ar = regProd.indexOf('pub fn approval_required(');
    const arBody = regProd.slice(ar, regProd.indexOf('}', ar));
    assert.ok(arBody.includes('live_access_mode()'), 'approval_required 必须活读档位');
    const so = regProd.indexOf('pub fn space_open(');
    const soBody = regProd.slice(so, regProd.indexOf('}', so));
    assert.ok(soBody.includes('live_access_mode()'), 'space_open 必须与审批门同一档位口径');
});

test('★ 后端：挂起中切 full 必须自动执行并续跑（不是只收卡）', () => {
    const prod = SERVER_SRC.split('#[cfg(test)]')[0];
    const start = prod.indexOf('async fn chat_access_select(');
    assert.ok(start > 0, 'chat_access_select 缺失');
    const end = prod.indexOf('fn resolve_access_mode(', start);
    const body = prod.slice(start, end > start ? end : undefined);
    assert.ok(body.includes('auto_approve_and_resume('),
        '切 full 消费挂起后必须自动执行命令并续跑；只发 hitl_released 会把 run 悬空');
    assert.ok(body.includes('Frame::hitl_released('), '收卡帧仍必须发（前端收掉待审批态）');
});

test('★ 前端：hitl 帧到达时按会话档位兜底自动放行（双镜像 + 三重门禁）', () => {
    const fs = require('node:fs');
    const mirrors = [
        path.join(__dirname, '..', 'ui', 'js', 'app-streaming.js'),
        path.join(__dirname, '..', '..', '..', 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'js', 'app-streaming.js')
    ];
    for (const f of mirrors) {
        const src = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
        /* dispatch switch 的 hitl 分支带渲染调用；相位映射表里还有一个字面同形的
           `case 'hitl': return PHASE_HITL;`（更靠前），必须锚定渲染调用那处。 */
        const i = src.indexOf("case 'hitl':   finishThinkingBlock");
        assert.ok(i > 0, 'hitl 渲染分支缺失: ' + f);
        const branch = src.slice(i, src.indexOf("case 'hitl_released'", i));
        assert.ok(branch.includes('modeForSession(sess.sessionId)'), '必须按会话查档位: ' + f);
        assert.ok(branch.includes('!sess._replaying'), '回放帧不得自动放行: ' + f);
        assert.ok(branch.includes('_autoApprovedHitlIds'), '每 actionId 只自动提交一次: ' + f);
        assert.ok(branch.includes('data-hitl-action-id'), '必须按 actionId 精确寻卡: ' + f);
        assert.ok(/trigger\('click'\)/.test(branch), '必须走与点击批准相同的路径: ' + f);
    }
});

test('★ 后端：spawn_resume 沿用挂起 runId 并 reopen ledger（HITL 与 ask 同一入口）', () => {
    const prod = SERVER_SRC.split('#[cfg(test)]')[0];
    const start = prod.indexOf('fn spawn_resume(');
    assert.ok(start > 0);
    const end = prod.indexOf('/// Execute a full ReAct session run.', start);
    const body = prod.slice(start, end > start ? end : undefined);
    assert.ok(body.includes('let run_id = sp.run_id.clone();'), '恢复必须沿用挂起 runId');
    assert.ok(!body.includes('let run_id = new_run_id();'), '恢复不得 mint 新 runId');
    assert.ok(body.includes('state.change_ledger.reopen(&session_id, &run_id)'),
        '挂起段已 finish(ready=true)，不 reopen 则恢复段写的文件永远发不出帧');
});
