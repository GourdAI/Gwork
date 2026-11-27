'use strict';
/* 诊断：把【真实内核 rounds/messages 响应】喂进移动端 hook 的历史加载路径，
   然后用与 app-chat-bubble.uvue 完全等价的模板逻辑（visibleBlocks + segments）
   dump 出「用户在真机上实际会看到的行」。目标：定位历史任务只剩一个思考行的真因。 */
const fs = require('node:fs');
const path = require('node:path');
const APP = __dirname;

// 复用 sim 的模块装载与虚拟时钟
const sim = fs.readFileSync(path.join(APP, 'build', 'sim-mobile-runtime.cjs'), 'utf8');

/* ---- 从 sim 文件里摘出可复用的装载函数（避免改 sim 源码） ---- */
function evalSimExports() {
    // sim 在 main() 里跑场景；我们只需要 makeClock/loadHook/makeDevice。
    // 用 Function 包装，截断 main 调用。
    const cut = sim.indexOf('async function main() {');
    const head = sim.slice(0, cut);
    const mod = { exports: {} };
    const fn = new Function('module', 'exports', 'require', '__dirname', head + `
module.exports = { makeClock, loadHook, makeDevice, makeRuntime, seedRounds, lastAi, userTexts, aiTextOf, drainMicrotasks };
`);
    fn(mod, mod.exports, require, path.join(APP, 'build'));
    return mod.exports;
}

const S = evalSimExports();

const SESSIONS = [
    { id: 'work-cec8d486', rounds: '.tmp/realreplay/cec8d486-rounds.json', messages: '.tmp/realreplay/cec8d486-messages.json' },
    { id: 'work-mwqg9ldg', rounds: '.tmp/realreplay/mwqg9ldg-rounds.json', messages: '.tmp/realreplay/mwqg9ldg-messages.json' },
];

/* ---- 模板等价渲染（app-chat-bubble.uvue visibleBlocks + segments 逐条照搬） ---- */
function visibleBlocks(message) {
    let list = message.blocks.filter((b) => b.args !== 'fileChanges' && b.changes.length === 0);
    if (message.summary.length > 0 && !message.compactOpen) {
        return list.filter((b) => !b.process);
    }
    const collapsed = [];
    list.forEach((b) => { if (b.kind === 'batch' && b.batchCollapsed) collapsed.push(b.id); });
    return list.filter((b) => {
        if (b.kind === 'batch') return true;
        if (b.kind === 'agent') return true;
        return collapsed.indexOf(b.batchId) < 0;
    });
}

function renderRows(message) {
    const out = [];
    if (message.role === 'user') return ['[USER] ' + message.text.slice(0, 40)];
    if (message.summary.length > 0) out.push('[SUMMARY] ' + message.summary + ' counts=' + JSON.stringify(message.counts) + ' compactOpen=' + message.compactOpen);
    const vb = visibleBlocks(message);
    out.push('[AI status=' + message.status + ' blocks=' + message.blocks.length + ' visible=' + vb.length + ' text=' + message.text.length + ']');
    vb.forEach((b) => {
        if (b.kind === 'batch') out.push('   BATCH «' + b.label + '» collapsed=' + b.batchCollapsed + ' count=' + b.batchCount);
        else if (b.kind === 'thinking') out.push('   thinking «' + b.label + '» body=' + b.body.length + ' process=' + b.process + ' batchId=' + b.batchId.slice(0, 8));
        else if (b.kind === 'tool') out.push('   tool «' + b.label + '» body=' + b.body.length + ' process=' + b.process + ' status=' + b.status);
        else if (b.kind === 'agent') out.push('   agent «' + b.label + '» process=' + b.process);
        else if (b.kind === 'text') out.push('   text-seg body=' + b.body.length + ' process=' + b.process);
        else out.push('   ' + b.kind + ' «' + b.label + '» process=' + b.process + ' body=' + b.body.length);
    });
    if (message.text.length > 0) out.push('   FINAL-TEXT len=' + message.text.length);
    return out;
}

async function runSession(sess) {
    const roundsFile = path.join(APP, '..', sess.rounds);
    const msgsFile = path.join(APP, '..', sess.messages);
    const roundsJson = JSON.parse(fs.readFileSync(roundsFile, 'utf8'));
    const msgsJson = JSON.parse(fs.readFileSync(msgsFile, 'utf8'));

    const rt = await S.makeRuntime({ sessionId: sess.id });
    // 用真实内核响应替换 mock：dev.events 填真实帧，replay 走真实 rounds 响应
    rt.dev.events = roundsJson.data.events.map((e) => Object.assign({}, e));
    rt.dev.running = roundsJson.data.running === true;
    const realRounds = roundsJson;
    const realMessages = msgsJson;
    const origRequest = rt.dev.request;
    rt.dev.request = async (method, apiPath, query, body, root) => {
        rt.dev.requests.push({ method, path: apiPath, query: query || '', at: rt.clock.now() });
        if (rt.dev.latency > 0) await rt.clock.sleep(rt.dev.latency); else await S.drainMicrotasks();
        if (apiPath === '/web/chat/replay') {
            const q = new URLSearchParams(query || '');
            if (!q.has('rounds')) {
                // afterSeq 模式：真实逐帧（这里从真实帧数组按 seq 过滤，够诊断用）
                const after = Number(q.get('afterSeq') || 0);
                const limit = Number(q.get('limit') || 500);
                const rest = rt.dev.events.filter((e) => e.eventSeq > after);
                return { code: 200, data: { events: rest.slice(0, limit), runId: realRounds.data.runId, running: rt.dev.running, hasMore: rest.length > limit, latestSeq: rest.length ? rest[Math.min(limit, rest.length) - 1].eventSeq : after } };
            }
            // rounds 模式：第一页用真实响应原样返回；beforeSeq 翻页按真实帧裁剪模拟
            if (!q.has('beforeSeq')) return JSON.parse(JSON.stringify(realRounds));
            const before = Number(q.get('beforeSeq'));
            const pool = rt.dev.events.filter((e) => e.eventSeq < before);
            const starts = []; pool.forEach((e, i) => { if (e.type === 'user' || e.type === 'user_input') starts.push(i); });
            const n = Number(q.get('rounds') || 10);
            let from = 0, hasMore = false;
            if (starts.length > n) { from = starts[starts.length - n]; hasMore = true; }
            const page = pool.slice(from);
            return { code: 200, data: { events: page, runId: realRounds.data.runId, running: rt.dev.running, hasMore, latestSeq: rt.dev.events.length ? rt.dev.events[rt.dev.events.length - 1].eventSeq : 0, firstSeq: page.length ? page[0].eventSeq : 0 } };
        }
        if (apiPath === '/web/chat/messages') return JSON.parse(JSON.stringify(realMessages));
        if (apiPath === '/web/chat/pendingQuestion') return { code: 200, data: null };
        if (apiPath === '/web/chat/attachment/meta') return { code: 200, data: { items: [] } };
        if (apiPath === '/web/chat/sessions') return { code: 200, data: [{ sessionId: sess.id, label: 'sim', time: rt.clock.now() }] };
        if (apiPath === '/web/chat/projects') return { code: 200, data: [] };
        return { code: 200, data: null };
    };

    console.log('\n========== ' + sess.id + ' ==========');
    console.log('kernel rounds: frames=' + realRounds.data.events.length + ' latestSeq=' + realRounds.data.latestSeq + ' firstSeq=' + realRounds.data.firstSeq + ' hasMore=' + realRounds.data.hasMore + ' running=' + realRounds.data.running);
    const typeCount = {};
    realRounds.data.events.forEach((e) => { typeCount[e.type] = (typeCount[e.type] || 0) + 1; });
    console.log('frame types:', JSON.stringify(typeCount));

    rt.api.setActive(sess.id);
    await rt.clock.tick(2000);
    await rt.clock.tick(15000); // 等更早轮翻页 + 回填定时器

    const conv = rt.conv;
    console.log('\n--- rendered messages: ' + conv.messages.length + ' ---');
    conv.messages.forEach((m, i) => {
        renderRows(m).forEach((line) => console.log(String(i).padStart(2, '0') + ' ' + line));
    });
    console.log('\n--- requests ---');
    rt.dev.requests.forEach((r) => console.log('   ' + r.path + '?' + String(r.query).slice(0, 90)));
}

(async () => {
    for (const s of SESSIONS) {
        try { await runSession(s); } catch (e) { console.error('DIAG FAIL ' + s.id + ': ' + (e && e.stack || e)); }
    }
})();
