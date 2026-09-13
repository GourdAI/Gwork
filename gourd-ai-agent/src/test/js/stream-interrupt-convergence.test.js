const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const moduleRoot = path.resolve(__dirname, '../../..');
const staticRoot = path.join(moduleRoot, 'src/main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const readJava = (...parts) => fs.readFileSync(path.join(moduleRoot, 'src/main/java', ...parts), 'utf8').replace(/^\uFEFF/, '');

/* ===== 回归背景 =====
   线上现象：有时点“暂停”暂停不了，随后整个会话像被暂停一样卡在「思考中」，
   耗时一路涨到几千秒。已定位为两个缺陷叠加：
   (1) 前端流式态只有一个收敛出口（done → finishStream），而 done 会在 runId 守卫处被静默丢弃，
       同时“停止”按钮对后端返回结果完全不消费、也无本地兜底；
   (2) 后端 Loop 同步入口在会话输入锁内阻塞等待整轮 run 结束，与流线程的 registerSteerRun /
       interruptSession 争用同一把锁，形成永久死锁（连“停止”请求都会挂起）。
   下列契约用于锁死修复，防止回退。 */

test('停止按钮消费后端 status，非 cancelled 时一律走服务端真值对账', () => {
    const js = readStatic('js', 'app-streaming.js');
    assert.match(js, /requestInterrupt\(sessionMap\[activeSessionId\], false\)/, '停止按钮应委托 requestInterrupt');
    assert.match(js, /function requestInterrupt\(sess, isRetry\)/, 'requestInterrupt 应存在');
    assert.match(js, /if \(status === 'cancelled'\) return;/, 'cancelled 才等 done 收敛');
    assert.match(js, /reconcileSessionRunning\(sess, \{ retryInterrupt: \(status === 'turn_changed'\) && !isRetry, force: true \}\)/);
    assert.match(js, /function reconcileSessionRunning\(sess, opts\)/, '对账函数应存在');
    // 旧实现：只有 .fail() 且完全忽略 status
    assert.doesNotMatch(js, /\.fail\(function\(\) \{\s*if \(typeof showToast === 'function'\) showToast\(GourdI18n\.t\('streaming\.steer_failed'\), 'error'\);\s*\}\);\s*\/\/ 等待服务端/, '不得回退为只挂 fail 的空处理');
});

test('done 帧 runId 不匹配时不得静默丢弃，必须按服务端真值对账收敛', () => {
    const js = readStatic('js', 'app-streaming.js');
    assert.doesNotMatch(js, /chunk\.runId !== sess\.activeRunId\) return;/, '旧的静默 return 必须移除');
    assert.match(js, /chunk\.runId !== sess\.activeRunId\) \{[\s\S]*?stale-run done ignored[\s\S]*?reconcileSessionRunning\(sess, \{ force: true \}\)/);
});

test('对账以 replay.running 为唯一真值：仅在服务端空闲时才强制收尾', () => {
    const js = readStatic('js', 'app-streaming.js');
    assert.match(js, /\/web\/chat\/replay\?sessionId=/, '对账必须读取服务端 replay');
    assert.match(js, /if \(data\.running\) \{[\s\S]*?retryInterrupt[\s\S]*?return;/, '服务端仍在跑时不得收尾');
    assert.match(js, /console\.warn\('\[WebGate\] reconcile: server idle, force finishStream for'[\s\S]*?finishStream\(sess\)/);
});

test('流式态看门狗常驻启动，长时无事件且服务端空闲时强制收敛', () => {
    const js = readStatic('js', 'app-streaming.js');
    assert.match(js, /function startStreamWatchdog\(\)/);
    assert.match(js, /window\._streamWatchdogTimer = setInterval\(function\(\) \{/);
    assert.match(js, /var STREAM_STALL_MS = \d+;/);
    // 看门狗必须只扫活跃流式会话，且跳过正在回放的会话
    assert.match(js, /if \(!sess \|\| !sess\.isStreaming \|\| sess\._replaying\) continue;/);
    // 必须在模块顶层（行首无缩进）无参调用，才算“常驻启动”
    assert.match(js, /^startStreamWatchdog\(\);$/m, '看门狗应在模块加载时顶层启动');
});

test('事件活跃时间戳在 onWebChunk 内推进（看门狗据此判断停摆）', () => {
    const js = readStatic('js', 'app-streaming.js');
    assert.match(js, /sess\.lastEventAt = Date\.now\(\);/);
});

test('resetStreamState 补齐 removeThinking 并记录流式起点', () => {
    const base = readStatic('js', 'app-base.js');
    const reset = base.match(/function resetStreamState\(sess\) \{[\s\S]*?\n\}/);
    assert.ok(reset, 'resetStreamState 应存在');
    assert.match(reset[0], /if \(typeof removeThinking === 'function'\) removeThinking\(sess\);/, '必须停掉消息区独立等待行的计时器');
    assert.match(reset[0], /sess\._streamStartAt = Date\.now\(\);/);
});

test('12 个语言包均包含 streaming.force_finished', () => {
    const dir = path.join(staticRoot, 'locales');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 12, '语言包数量应不少于 12');
    for (const f of files) {
        const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        assert.equal(typeof json.streaming.force_finished, 'string', f + ' 缺少 streaming.force_finished');
    }
});

test('后端 Loop 同步入口不得在会话输入锁内等待整轮 run 结束（死锁根因）', () => {
    const java = readJava('com/gourdai/core/portal/web/WebGate.java');
    // 拆分为「订阅（非阻塞）+ 锁外 await」
    assert.match(java, /private SyncRunHandle startSyncRun\(/, 'startSyncRun 应存在');
    assert.match(java, /return new SyncRunHandle\(countDownLatch, finalAnswerRef\);/);
    assert.doesNotMatch(java, /RunUtil\.runAndTry\(countDownLatch::await\);\s*\n\s*return finalAnswerRef\.get\(\);/, 'startSyncRun 内不得 await');
    // await 必须在 synchronized 块之外
    assert.match(java, /\}\s*\n\s*\/\/ 锁外等待[\s\S]*?return handle\.await\(\);/);
    // 旧的「锁内同步执行整轮」方法签名不得残留
    assert.doesNotMatch(java, /doSafeChatInputAndCaptureLoop\(/, '旧方法必须改名，不能在锁内执行整轮 run');
    assert.match(java, /doSafeChatInputAndCaptureLoopPrepare\(/, '准备阶段应拆出独立方法');
});

test('interruptSession 具备可停兜底：run 状态缺失但订阅仍活时必须真停并补 done', () => {
    const java = readJava('com/gourdai/core/portal/web/WebGate.java');
    assert.match(java, /interrupted via disposable fallback/);
    // 必须用带同实例判定的 remove(key, value) 原子摘取，否则并发下可能误摘后一个 run 的订阅
    assert.match(java, /Disposable orphan = \(Disposable\) session\.attrs\(\)\.get\("disposable"\);[\s\S]*?session\.attrs\(\)\.remove\("disposable", orphan\)[\s\S]*?orphan\.dispose\(\);[\s\S]*?emitToClient\(sessionId, WebChunk\.ofDone\(\)\);/);
});

test('停摆判定取「最近事件」与「本轮流起点」的较新者，避免误砍启动窗口内的新 run', () => {
    const js = readStatic('js', 'app-streaming.js');
    assert.match(js, /var lastActivity = Math\.max\(sess\.lastEventAt \|\| 0, sess\._streamStartAt \|\| 0\);/);
    assert.match(js, /var stalled = \(Date\.now\(\) - lastActivity\) >= STREAM_STALL_MS;/);
    // 看门狗也不得用可能陈旧的 lastEventAt 短路取值
    assert.doesNotMatch(js, /Date\.now\(\) - \(sess\.lastEventAt \|\| sess\._streamStartAt \|\| 0\)/, '不得再短路取陈旧的 lastEventAt');
    const base = readStatic('js', 'app-base.js');
    assert.match(base, /sess\.lastEventAt = 0;/, 'resetStreamState 必须清掉上一轮遗留的 lastEventAt');
});

test('对账重试前用服务端权威 runId 校准本地 activeRunId（否则重试仍带陈旧 runId）', () => {
    const js = readStatic('js', 'app-streaming.js');
    assert.match(js, /if \(data\.runId\) sess\.activeRunId = data\.runId;/);
    // 校准必须发生在重试之前，否则 turn_changed 会反复空转
    assert.match(js, /if \(data\.runId\) sess\.activeRunId = data\.runId;[\s\S]*?if \(data\.running\) \{[\s\S]*?requestInterrupt\(sess, true\)/);
});

test('replay 回传权威 runId，供前端校准被历史回放污染的 activeRunId', () => {
    const java = readJava('com/gourdai/core/portal/web/WebGate.java');
    assert.match(java, /public String getCurrentRunId\(String sessionId\)/);
    assert.match(java, /session\.attrs\(\)\.get\(SteerInterceptor\.ATTR_ACTIVE_RUN_ID\)/);
    const ctrl = readJava('com/gourdai/core/portal/web/WebController.java');
    assert.match(ctrl, /result\.put\("runId", webGate\.getCurrentRunId\(sessionId\)\)/);
});

test('对账强制收尾与正常 done 路径对齐：放行消息队列派发', () => {
    const js = readStatic('js', 'app-streaming.js');
    assert.match(js, /sess\._suppressQueueDispatch = false;\s*\n\s*finishStream\(sess\);/, '对账收尾前需复位 _suppressQueueDispatch');
});

test('死代码清理：会「锁内同步 await 整轮 run」的私有入口不得残留', () => {
    const java = readJava('com/gourdai/core/portal/web/WebGate.java');
    assert.doesNotMatch(java, /private String performAgentTaskSync\(/, '不得残留锁内同步执行入口（后人复用即重蹈死锁）');
    assert.match(java, /private SyncRunHandle startSyncRun\(/, '同步路径只保留非阻塞 startSyncRun');
});
