/* e2e-context-store.probe.js — 会话选择器归属探针（手动运行，不进 node --test 默认集）
 *
 * 为什么需要它：思考等级 / 上下文长度「选完发消息就变回 默认 / 256K」的根因是
 * 同一会话的 context.json 被写进两个不同 sessions 根（选择器不带 X-Session-Cwd
 * → 落全局；/web/chat/input 带该头才绑定项目根 → 落项目），回显读已绑定后的项目
 * 那份，字段不在里面就静默回退默认值。这类「写进去但读不到」的缺陷只有真实内核
 * + 真实磁盘落点才能证明修好了，纯静态断言会假阳性。
 *
 * 运行：  node test/e2e-context-store.probe.js
 *        （或 npm run test:ctx，需先 cargo build -p gourd-work-cli）
 * 环境变量：
 *   GWORK_EXE      内核二进制路径（默认 <repo>/target/debug/gwork.exe）
 *   GWORK_PROBE_PORT  端口（默认 8791）
 *   GWORK_SETTINGS    复用哪份 settings.json（默认 ~/.gwork/settings.json）
 *
 * 隔离性：--home 把全局区重定向到临时目录，绝不读写你真实的 ~/.gwork 会话数据。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const EXE = process.env.GWORK_EXE || path.join(REPO, 'target', 'debug', 'gwork.exe');
const PORT = Number(process.env.GWORK_PROBE_PORT || 8791);
const BASE = 'http://127.0.0.1:' + PORT;
const HOME = path.join(os.tmpdir(), 'gw-probe-home');
const PROJ = path.join(os.tmpdir(), 'gw-probe-proj');
// 探针不写死模型名：从复用的 settings.json 里取第一个真实存在的 key。
// 硬编码过一次就够——换一台机器（settings 里没有那个模型）models/select 会返回
// 404，把「探针自身的环境假设」误报成「修复失效」。
const SETTINGS_SRC = process.env.GWORK_SETTINGS
    || path.join(os.homedir(), '.gwork', 'settings.json');
let MODEL_NAME = null;

const results = [];
const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   -> ' + detail : ''));
};
const skip = (name, why) => console.log('SKIP  ' + name + '   (' + why + ')');

const ctxPath = (root, sid) => path.join(root, '.gwork', 'sessions', sid, 'context.json');
const readCtx = p => (!fs.existsSync(p) ? null
    : (() => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return { __parse_error: e.message }; } })());

const post = async (url, body, headers) => {
    const r = await fetch(BASE + url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, headers || {}),
        body: new URLSearchParams(body).toString(),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
};
const get = async url => {
    const r = await fetch(BASE + url);
    return { status: r.status, json: await r.json().catch(() => null) };
};

function boot() {
    if (!fs.existsSync(EXE)) {
        console.error('内核二进制不存在：' + EXE + '\n先跑：cargo build -p gourd-work-cli');
        process.exit(1);
    }
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.rmSync(PROJ, { recursive: true, force: true });
    fs.mkdirSync(path.join(PROJ, 'nested'), { recursive: true });
    fs.mkdirSync(path.join(HOME, '.gwork'), { recursive: true });

    // 复用真实 settings 让 /web/chat/models 返回非空表；没有就退化成空表，
    // 与模型相关的断言标记 SKIP 而非伪造成 PASS。
    let haveModels = false;
    if (fs.existsSync(SETTINGS_SRC)) {
        const settings = JSON.parse(fs.readFileSync(SETTINGS_SRC, 'utf8'));
        const keys = Object.keys(settings.models || {});
        const visible = keys.filter(k => settings.models[k] && settings.models[k].enabled !== false);
        MODEL_NAME = visible[0] || keys[0] || null;
        haveModels = !!MODEL_NAME;
        fs.copyFileSync(SETTINGS_SRC, path.join(HOME, '.gwork', 'settings.json'));
    } else {
        fs.writeFileSync(path.join(HOME, '.gwork', 'settings.json'), '{}');
    }

    const child = spawn(EXE, ['--serve', String(PORT), '--home', HOME], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: PROJ, // workspace 取 current_dir()，必须在这里指定项目根
        windowsHide: true,
    });
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    return { child, haveModels, getLog: () => log };
}

async function waitReady(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try {
            const r = await get('/web/chat/models?__scope=local');
            if (r.status === 200 && r.json && r.json.code === 200) return true;
        } catch (e) { /* 还没起来 */ }
        await new Promise(r => setTimeout(r, 250));
    }
    return false;
}

(async () => {
    const { child, haveModels, getLog } = boot();
    let failed = 0;
    try {
        if (!(await waitReady(30000))) {
            console.log('内核启动失败，日志：\n' + getLog());
            process.exit(1);
        }
        console.log('内核已就绪 http://127.0.0.1:' + PORT + '（隔离 home=' + HOME + '）\n');
        const cwdHeader = { 'X-Session-Cwd': encodeURIComponent(PROJ) };

        // ── A. 带归属头（前端现在的实际请求形态）：三份选择必须落到同一份文件 ──
        const A = 'work-probeA';
        let r = await post('/web/chat/thinking/select', { sessionId: A, depth: 'high' }, cwdHeader);
        check('thinking/select 带头 -> 200', !!r.json && r.json.code === 200, JSON.stringify(r.json));
        r = await post('/web/chat/context/select', { sessionId: A, contextLength: '1000000' }, cwdHeader);
        check('context/select 带头 -> 200', !!r.json && r.json.code === 200, JSON.stringify(r.json));
        if (haveModels) {
            r = await post('/web/chat/models/select', { sessionId: A, modelName: MODEL_NAME }, cwdHeader);
            check('models/select 带头 -> 200', !!r.json && r.json.code === 200, JSON.stringify(r.json));
        } else {
            skip('models/select 带头', 'settings.json 无可用模型（思考/上下文断言不受影响）');
        }

        const projA = readCtx(ctxPath(PROJ, A));
        const homeA = readCtx(ctxPath(HOME, A));
        console.log('\n  [A] 项目 context.json: ' + JSON.stringify(projA));
        console.log('  [A] 全局 context.json: ' + JSON.stringify(homeA) + '\n');

        check('A: thinking 落在项目根', !!projA && projA.thinking === 'high', JSON.stringify(projA));
        check('A: context_length 落在项目根', !!projA && projA.context_length === 1000000, JSON.stringify(projA));
        check('A: 选择写进同一份文件（不再 split-brain）',
            !!projA && (!haveModels || projA.model === MODEL_NAME), JSON.stringify(projA));
        check('A: 全局根不得再出现该会话的 context', homeA === null, 'global = ' + JSON.stringify(homeA));

        // 回显路径：发消息后 refreshSessionModel 重新拉的就是这个接口
        const echo = await get('/web/chat/models?sessionId=' + A + '&__scope=local');
        const d = echo.json && echo.json.data;
        console.log('  [A] /web/chat/models 回显: thinkingDepth=' + (d && d.thinkingDepth)
            + ' contextLength=' + (d && d.contextLength) + ' selected=' + (d && d.selected) + '\n');
        check('A: 回显思考档位 = high（缺陷形态是 auto → UI 显示「默认」）',
            !!d && d.thinkingDepth === 'high', d && 'got ' + d.thinkingDepth);
        check('A: 回显上下文窗口 = 1000000（缺陷形态是 256000 → UI 显示 256K）',
            !!d && d.contextLength === 1000000, d && 'got ' + d.contextLength);

        // ── B. 不带归属头 → 仍落全局区（未选择工作区的既有语义不变）──
        const B = 'work-probeB';
        await post('/web/chat/thinking/select', { sessionId: B, depth: 'low' }, {});
        await post('/web/chat/context/select', { sessionId: B, contextLength: '512000' }, {});
        console.log('  [B] 项目 context.json: ' + JSON.stringify(readCtx(ctxPath(PROJ, B))));
        console.log('  [B] 全局 context.json: ' + JSON.stringify(readCtx(ctxPath(HOME, B))) + '\n');
        const homeB = readCtx(ctxPath(HOME, B));
        check('B: 无头 → 落全局区（语义未变）',
            !!homeB && homeB.thinking === 'low' && homeB.context_length === 512000, JSON.stringify(homeB));
        check('B: 无头 → 项目根不产生文件', readCtx(ctxPath(PROJ, B)) === null);

        // ── C. 连续两次保存不得互相覆盖（同一文档内合并）──
        const C = 'work-probeC';
        await post('/web/chat/thinking/select', { sessionId: C, depth: 'medium' }, cwdHeader);
        await post('/web/chat/context/select', { sessionId: C, contextLength: '128000' }, cwdHeader);
        const projC = readCtx(ctxPath(PROJ, C));
        check('C: 两次保存合并进一份文档（无 lost update）',
            !!projC && projC.thinking === 'medium' && projC.context_length === 128000, JSON.stringify(projC));

        // ── C2. *并发* 保存不得互相覆盖（真实缺陷形态）──
        // 切到新增任务页时 inheritSelectionToSession 会同时发出 models/thinking/context
        // 三个 select。旧内核每个请求 read_context→改一字段→整份 write_context，三者都
        // 读到空文档，最后落地的那个把其它两个字段抹掉，回显随即退回 auto + 256K。
        // 实测 30 轮三写 0/30 全字段保留，两写 30/30 正常（用户所见「只带上下文长度、
        // 没带思考等级」正是三写交叠的结果）。这里用 10 轮并发放大，锁死回归。
        let concurrentLost = 0;
        let firstLostDetail = '';
        for (let i = 0; i < 10; i++) {
            const sid = 'work-probeConcurrent' + i;
            const reqs = [
                post('/web/chat/thinking/select', { sessionId: sid, depth: 'high' }, cwdHeader),
                post('/web/chat/context/select', { sessionId: sid, contextLength: '1000000' }, cwdHeader),
            ];
            if (haveModels) {
                reqs.push(post('/web/chat/models/select', { sessionId: sid, modelName: MODEL_NAME }, cwdHeader));
            }
            await Promise.all(reqs);
            const c = readCtx(ctxPath(PROJ, sid));
            const ok = !!c && c.thinking === 'high' && c.context_length === 1000000
                && (!haveModels || c.model === MODEL_NAME);
            if (!ok) {
                concurrentLost++;
                if (!firstLostDetail) firstLostDetail = sid + ': ' + JSON.stringify(c);
            }
        }
        check('C2: 10 轮并发三写无 lost update（切新增任务页的真实时序）',
            concurrentLost === 0, concurrentLost + '/10 丢失, 首例 ' + firstLostDetail);

        // ── D. 改路由后路径穿越守卫必须仍然生效 ──
        r = await post('/web/chat/context/select',
            { sessionId: '..\\probe-escape', contextLength: '256000' }, cwdHeader);
        const esc = [HOME, PROJ].some(rt => fs.existsSync(path.join(rt, '.gwork', 'probe-escape', 'context.json')));
        check('D: 穿越 sessionId 仍被拒（400）', !!r.json && r.json.code === 400, JSON.stringify(r.json));
        check('D: 无文件逃逸 sessions 根', !esc);

        // ── E. 原子写：不得残留 *.tmp，且落盘必须是单个可解析文档 ──
        const dir = path.join(PROJ, '.gwork', 'sessions', A);
        const tmps = fs.readdirSync(dir).filter(n => n.includes('.tmp'));
        check('E: 写完后无 .tmp 残留（原子写）', tmps.length === 0, JSON.stringify(tmps));
        const raw = fs.readFileSync(path.join(dir, 'context.json'), 'utf8');
        let parseOk = true;
        try { JSON.parse(raw); } catch (e) { parseOk = false; }
        check('E: context.json 是完整单一文档（缺陷形态带尾随垃圾导致解析失败→静默回退默认）', parseOk);

        console.log('\n================ 汇总 ================');
        failed = results.filter(x => !x.ok).length;
        console.log((results.length - failed) + '/' + results.length + ' 项通过');
        if (failed) console.log('失败项:\n' + results.filter(x => !x.ok).map(b => '  - ' + b.name + ' :: ' + b.detail).join('\n'));
        process.exitCode = failed ? 1 : 0;
    } finally {
        child.kill();
    }
})();
