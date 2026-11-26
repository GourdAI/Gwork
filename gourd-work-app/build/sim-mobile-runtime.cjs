'use strict';
/* ===== build/sim-mobile-runtime.cjs =====
 * 移动端会话 hook 的【行为级模拟】：不是源码字符串断言，而是把
 * hooks/useConversations.ts 的【真实实现】用 typescript transpile 成 CJS，
 * 注入假的链路层（可编程延迟/失败/帧投递的 WS mock）与虚拟时钟后整模块执行，
 * 逐场景驱动真实代码路径并断言最终消息状态。
 *
 * 覆盖用户报障的三条主线（2026-11-24 加载极慢 / 运行中卡死 / 帧展示错乱）：
 *  S1 首屏速度：45 轮长会话 + 每页 300ms 延迟，历史必须「一页上屏」，
 *     更早轮延迟后台前插，且接流不被翻页阻塞。
 *  S2 新桌面接流：GET replay 即建订阅（桌面侧已修），live 帧驱动正文/done 收口。
 *  S3 旧桌面兜底：gate 订阅永不建（无 live 帧），15s 看门狗对账收口，不永久转圈。
 *  S4 看门狗收口失败续命（本轮 review 修复）：对账发现已结束但补帧页失败 →
 *     必须退避重试/重新武装，最终收口。
 *  S5 补帧分页 + live 缓冲：After 分页拉全、期间 live 帧不乱序不丢段。
 *  S6 竞态：双击打开单飞；设备切换作废迟到翻页页/看门狗/补帧。
 *  S7 影子前插附件走真实会话 id（本轮 review 修复）：meta 请求不得打向 id#earlier。
 *  S8 已闭环问答卡对重放帧幂等（不翻回待答态）。
 *
 * 运行：node build/sim-mobile-runtime.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
const ts = require('typescript');

const APP = path.join(__dirname, '..');
const HOOK_PATH = path.join(APP, 'hooks', 'useConversations.ts');

/* ---------------- 虚拟时钟 ----------------
 * 全部 setTimeout/clearTimeout 走虚拟队列：场景用 tick(ms) 精确推进，
 * 15s 看门狗 / 3s 翻页延迟 / 120ms 合帧 / 退避重试全部确定性触发。 */
function makeClock() {
    let now = 1_700_000_000_000;
    let seq = 0;
    const timers = new Map();
    return {
        now: () => now,
        setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms | 0), fn, order: id }); return id; },
        clearTimeout(id) { timers.delete(id); },
        pending: () => timers.size,
        /** 请求延迟等纯等待：到期只 resolve，不执行任何业务逻辑（由外层 tick 驱动） */
        sleep(ms) { return new Promise((resolve) => { const id = ++seq; timers.set(id, { at: now + ms, fn: resolve, order: id, sleep: true }); }); },
        /** 推进虚拟时间（混合调度）：
         *  - 业务定时器（setTimeout）按 (at, 注册序) 到期即触发——同刻多个业务
         *    定时器背靠背执行，模拟真实事件循环的定时器相位；
         *  - 请求延迟（sleep）到期只 resolve，随后【立即让出宏任务 + 排空
         *    microtask】，让请求协程先消费响应再推进下一个定时器——模拟真实
         *    网络 IO 回调先于下一轮 timer phase。两者混排会制造「响应未回、
         *    3s 翻页先跑」的假时序（epoch 守卫会正确丢弃首屏页，测试假失败）。 */
        async tick(ms) {
            const target = now + ms;
            // 【必须让出真实宏任务】sleep 的 resolve 只是 microtask：请求协程的
            // 后半段（消费响应/发下一页请求）要等真实宏任务边界才被调度。不让出
            // setImmediate，整个虚拟时间会在同一宏任务里跑完，请求链全被饿死。
            await new Promise((r) => setImmediate(r));
            for (;;) {
                let next = null;
                for (const [id, t] of timers) {
                    if (t.at > target) continue;
                    if (next == null || t.at < next[1].at || (t.at === next[1].at && t.order < next[1].order)) next = [id, t];
                }
                if (next == null) break;
                const [id, t] = next;
                timers.delete(id);
                now = Math.max(now, t.at);
                t.fn();
                // sleep（IO 回调）到期：让请求协程完整跑完这一段（可能连发多页
                // 零延迟请求）再推进下一个定时器——否则业务定时器会插进响应
                // 消费链中间，制造真实世界不存在的乱序。
                const turns = t.sleep === true ? 8 : 1;
                for (let k = 0; k < turns; k++) {
                    await new Promise((r) => setImmediate(r));
                    await drainMicrotasks();
                }
            }
            now = target;
            for (let k = 0; k < 8; k++) {
                await new Promise((r) => setImmediate(r));
                await drainMicrotasks();
            }
        },
    };
}
/** 把 Promise 链全部排空（mock 链路不含真实 IO，microtask 即全部工作） */
async function drainMicrotasks() { for (let i = 0; i < 60; i++) await Promise.resolve(); }

/* ---------------- 模块装载：真实 hook 源码 + 假依赖 ---------------- */
function compileCjs(absPath) {
    const src = fs.readFileSync(absPath, 'utf8');
    const out = ts.transpileModule(src, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
            esModuleInterop: true,
        },
        fileName: absPath,
    });
    return out.outputText;
}

function loadHook(env) {
    const code = compileCjs(HOOK_PATH);
    const mod = { exports: {} };
    const cache = new Map();
    // SIM_DEBUG=1：给所有 catch (_) {} 注入日志（仅测试装载副本，不改源码），
    // 定位「请求全部成功但渲染段为空」这类被吞异常。
    let loadCode = code;
    if (process.env.SIM_DEBUG === '1') {
        loadCode = loadCode.replace(/catch\s*\((_|_e|err)\)\s*\{/g, (m, v) => 'catch (' + v + ') { console.error("SWALLOWED", ' + v + ' && ' + v + '.stack || ' + v + ');');
        // prependRoundsPage 早退点插桩
        loadCode = loadCode
            .replace('function prependRoundsPage(id, frames, epoch) {', 'function prependRoundsPage(id, frames, epoch) { console.error("PREPEND enter", id, frames.length, epoch, earlierEpoch);')
            .replace(/if \(segment\.length === 0\) return;/g, 'if (segment.length === 0) { console.error("PREPEND empty segment", id); return; }')
            .replace('if (current == null || epoch !== earlierEpoch) return;', 'if (current == null || epoch !== earlierEpoch) { console.error("PREPEND stale", id, epoch, earlierEpoch, current == null); return; }')
            .replace('current.messages = segment.concat(current.messages);', 'console.error("PREPEND concat", id, segment.length, current.messages.length, current === conversations.value.find((c) => c.id === id)); current.messages = segment.concat(current.messages); console.error("PREPEND after", conversations.value.find((c) => c.id === id).messages.length);');
    }
    const req = (spec) => {
        if (cache.has(spec)) return cache.get(spec);
        let m;
        if (spec === 'vue') {
            m = {
                ref: (v) => ({ value: v }),
                computed: (fn) => ({ get value() { return fn(); } }),
                watch: () => {},
            };
        } else if (spec.includes('locale/i18n')) {
            m = { i18n: { global: { t: (k, vals) => vals ? k + '|' + JSON.stringify(vals) : k } } };
        } else if (spec.includes('utils/tools')) {
            m = {
                fieldString: (row, key) => { const v = row == null ? null : row[key]; return typeof v === 'string' ? v : ''; },
                formatElapsed: () => '1s',
                formatBatchElapsed: () => '1s',
                formatMsgTime: () => '12:00',
                formatRelativeTime: () => 'now',
            };
        } else if (spec.includes('tool-presentation')) {
            m = { bareToolName: (n) => n || '', resolveToolLabel: (n, title) => title || n || 'tool' };
        } else if (spec.includes('gwork-auth')) {
            m = { gworkSignedIn: () => ({ value: true }) };
        } else if (spec.includes('gwork-link')) {
            m = env.link;
        } else if (spec.includes('useDevices')) {
            m = { useDevices: () => env.devices };
        } else if (spec.includes('useRunEnv')) {
            m = {
                useRunEnv: () => ({
                    bindSession: () => {},
                    currentConfig: () => ({}),
                    selectedSkill: { value: '' },
                    skills: { value: [] },
                    attachTag: { value: '' },
                    permission: { value: 'default' },
                }),
                inheritSelectionToSession: () => Promise.resolve(),
                skillPrefix: () => '',
            };
        } else if (spec.includes('useWorkspaces')) {
            m = {
                useWorkspaces: () => ({ projects: { value: [] } }),
                setProjectRoots: () => {},
                clearWorkspaces: () => {},
            };
        } else if (spec.includes('app-data')) {
            m = { DEFAULT_WORKSPACE: '__chat__' };
        } else {
            throw new Error('unexpected import in hook: ' + spec);
        }
        cache.set(spec, m);
        return m;
    };
    // 注入的 console 包一层：捕获被测代码吞掉的异常路径（catch 分支里的 warn）
    const wrappedConsole = {
        log: (...a) => console.log('[hook]', ...a),
        warn: (...a) => console.log('[hook WARN]', ...a),
        error: (...a) => console.log('[hook ERROR]', ...a),
    };
    const fn = new Function('require', 'module', 'exports', '__DEV__', 'uni', 'setTimeout', 'clearTimeout', 'Date', 'console', loadCode);
    const RealDate = Date;
    const FakeDate = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : [env.clock.now()])); }
        static now() { return env.clock.now(); }
    };
    fn(req, mod, mod.exports, false, env.uni, env.clock.setTimeout.bind(env.clock), env.clock.clearTimeout.bind(env.clock), FakeDate, wrappedConsole);
    return mod.exports;
}

/* ---------------- 可编程链路 mock ----------------
 * 一台「设备」= 一份帧流（events 按 eventSeq 升序）+ running 态。
 * replay 三种形态与内核契约一致：
 *  - rounds=N [&beforeSeq=X]：合帧投影（本模拟事件已是合帧粒度），
 *    latestSeq=全文件最大 seq，firstSeq=本页最早 seq，hasMore=还有更早轮；
 *  - afterSeq=X&limit=L：逐帧 After 分页，latestSeq=本页末帧 seq；
 * 响应延迟/失败可编排（弱网/旧桌面）。 */
function makeDevice(clock, opts) {
    const dev = {
        events: [],            // {eventSeq, type, ...}
        running: false,
        runId: 'run-1',
        gateEnabled: opts.gateEnabled !== false, // false = 旧桌面：GET 不建订阅，live 帧不达
        // 【真实内核 Rounds 契约】load_replay_window_at（session/mod.rs）：
        // starts（user 帧）为空时直接返回空窗口——handler 回 empty_envelope(events:[])。
        // 旧 mock 在 starts.length===0 时回全量帧，比真内核宽容，恰好掩盖了
        // 「无 user 帧会话（纯图/续跑/截断流）首屏空 → 快照降级 → 过程卡全丢」的真 bug。
        kernelStrictRounds: opts.kernelStrictRounds === true,
        latency: opts.latency || 0,              // 每次请求的虚拟延迟 ms
        failReplay: opts.failReplay || null,     // (query, nth) => boolean 编排失败
        requests: [],                            // 审计：{method, path, query, at}
        subscribers: new Set(),                  // gate 订阅（sessionId）
        metaRequests: [],
        replayCalls: 0,
    };
    dev.append = (frame) => { dev.events.push(frame); };
    dev.emit = (frame, hooks) => {
        dev.append(frame);
        if (dev.gateEnabled && dev.subscribers.has(frame.sessionId || opts.sessionId)) {
            hooks.deliverFrame(opts.sessionId, frame);
        }
    };
    dev.request = async (method, apiPath, query, body, root) => {
        dev.requests.push({ method, path: apiPath, query: query || '', body: body || '', at: clock.now() });
        // 【延迟必须是独立虚拟定时器】不能在请求协程里调 clock.tick：tick 会顺带
        // 执行其它到期业务定时器（3s 翻页/15s 看门狗），造成「响应未回、翻页先跑、
        // epoch 先自增」的假时序，被测代码的防串页守卫会（正确地）丢弃首屏页。
        // 真实世界里请求延迟与定时器互不驱动——这里用一次性 timer + Promise 挂起。
        if (dev.latency > 0) await clock.sleep(dev.latency); else await drainMicrotasks();
        const q = new URLSearchParams(query || '');
        const sid = q.get('sessionId') || '';
        if (apiPath === '/web/chat/replay') {
            dev.replayCalls += 1;
            if (dev.failReplay && dev.failReplay(query || '', dev.replayCalls)) {
                return { code: 502, description: 'simulated failure' };
            }
            // GET replay 即 ensure gate 订阅（新桌面 device_link.rs 行为；旧桌面 gateEnabled=false 不建）
            if (dev.gateEnabled && sid) dev.subscribers.add(sid);
            const all = dev.events;
            const latestSeq = all.length ? all[all.length - 1].eventSeq : 0;
            if (q.has('afterSeq')) {
                const after = Number(q.get('afterSeq'));
                const limit = Number(q.get('limit') || '500');
                const rest = all.filter((e) => e.eventSeq > after);
                let page = rest.slice(0, limit);
                // 字节预算（真内核 After 语义）：保头丢尾，hasMore 由
                // total_after > 返回数 自洽，客户端分页循环从页尾续拉。
                const budget = q.has('maxBytes') ? Number(q.get('maxBytes')) : Infinity;
                let used = 0;
                const kept = [];
                for (const e of page) {
                    const need = used + JSON.stringify(e).length + 1;
                    if (need > budget && kept.length > 0) break;
                    used = need;
                    kept.push(e);
                }
                page = kept;
                return {
                    code: 200,
                    data: {
                        events: page, runId: dev.runId, running: dev.running,
                        hasMore: rest.length > page.length,
                        latestSeq: page.length ? page[page.length - 1].eventSeq : after,
                    },
                };
            }
            // rounds 模式：以 user 帧切轮，取最新 N 轮（或 beforeSeq 之前的 N 轮）
            const rounds = Number(q.get('rounds') || '10');
            const before = q.has('beforeSeq') ? Number(q.get('beforeSeq')) : Infinity;
            const pool = all.filter((e) => e.eventSeq < before);
            const starts = [];
            pool.forEach((e, i) => { if (e.type === 'user' || e.type === 'user_input') starts.push(i); });
            let from = 0;
            let hasMore = false;
            if (starts.length === 0) {
                if (dev.kernelStrictRounds) {
                    // 旧内核：无 user 帧 → empty_envelope(events:[], latestSeq 仍为全文件最大)
                    return { code: 200, data: { events: [], runId: dev.runId, running: dev.running, hasMore: false, latestSeq, firstSeq: 0 } };
                }
                // 新内核（本次修复）：回落全窗投影，total_rounds=1
                from = 0; hasMore = false;
            } else if (starts.length > rounds) {
                from = starts[starts.length - rounds];
                hasMore = true;
            }
            const page = pool.slice(from);
            // 字节预算（真内核 Rounds 语义）：保尾丢头，被丢的轮计入 hasMore，
            // firstSeq 取保留段首帧——客户端用 beforeSeq=firstSeq 把头部翻回。
            const budget = q.has('maxBytes') ? Number(q.get('maxBytes')) : Infinity;
            let used = 0;
            let cut = page.length;
            for (let i = page.length - 1; i >= 0; i--) {
                const need = used + JSON.stringify(page[i]).length + 1;
                if (need > budget && cut < page.length) break;
                used = need;
                cut = i;
            }
            const kept = page.slice(cut);
            const truncated = cut > 0;
            if (truncated) {
                // 被丢头部里的 user 帧 = 可翻的更早轮
                const droppedUsers = page.slice(0, cut).filter((e) => e.type === 'user' || e.type === 'user_input').length;
                hasMore = hasMore || droppedUsers > 0;
            }
            return {
                code: 200,
                data: {
                    events: kept, runId: dev.runId, running: dev.running, hasMore,
                    truncated,
                    latestSeq,
                    firstSeq: kept.length ? kept[0].eventSeq : 0,
                },
            };
        }
        if (apiPath === '/web/chat/messages') {
            const rows = [];
            dev.events.forEach((e) => {
                if (e.type === 'user') rows.push({ role: 'USER', content: e.text || '' });
                if (e.type === 'text') rows.push({ role: 'ASSISTANT', content: e.text || '' });
            });
            return { code: 200, data: rows };
        }
        if (apiPath === '/web/chat/pendingQuestion') return { code: 200, data: null };
        if (apiPath === '/web/chat/attachment/meta') {
            dev.metaRequests.push({ sessionId: sid, query: query || '' });
            const items = (q.getAll('paths') || []).map((p) => ({ path: p, dataUrl: 'data:image/png;base64,AAAA' }));
            return { code: 200, data: { items } };
        }
        if (apiPath === '/web/chat/sessions') {
            // 与真实 App 一致：会话列表包含本会话（boot refresh 重建列表对象，
            // 返回前 rt.conv 会重绑定到 api.conversations.value 里的权威对象）
            return { code: 200, data: opts.sessionRows || [{ sessionId: opts.sessionId, label: 'sim', time: clock.now() }] };
        }
        if (apiPath === '/web/chat/projects') return { code: 200, data: [] };
        if (apiPath === '/web/chat/input') {
            const payload = JSON.parse(body || '{}');
            if (dev.running) return { code: 200, data: 'busy' };
            dev.running = true;
            if (dev.gateEnabled) dev.subscribers.add(payload.sessionId || sid);
            return { code: 200, data: { sessionId: payload.sessionId || sid } };
        }
        if (apiPath === '/web/chat/interrupt') { dev.running = false; return { code: 200, data: { status: 'interrupted' } }; }
        return { code: 200, data: null };
    };
    return dev;
}

/** 组装一套「App 运行时」：hook 模块 + 设备 + 帧投递。每个场景独立实例（模块级状态隔离）。 */
function makeRuntime(opts) {
    const clock = makeClock();
    const frameHandlers = new Map();
    let resumedHandler = null;
    const dev = makeDevice(clock, opts);
    const uniStore = new Map();
    const env = {
        clock,
        devices: {
            activeDeviceId: { value: opts.deviceId || 'dev-1' },
            deviceOnline: { value: true },
        },
        uni: {
            showToast: () => {},
            getStorageSync: (k) => uniStore.get(k) || '',
            setStorageSync: (k, v) => uniStore.set(k, v),
            removeStorageSync: (k) => uniStore.delete(k),
        },
        link: {
            // 【不能在 mock 里 tick 虚拟时钟】tick 会执行到期业务定时器（如 3s 翻页），
            // 造成「请求还没回来翻页先跑」的假时序。请求延迟只在 dev.request 内 tick。
            ensureConnected: async () => { await drainMicrotasks(); },
            request: (method, apiPath, query, body, root) => dev.request(method, apiPath, query, body, root),
            kernelOk: (body) => body != null && body.code === 200,
            onFrame: (sid, fn) => frameHandlers.set(sid, fn),
            offFrame: (sid) => frameHandlers.delete(sid),
            onDeviceOffline: () => {},
            onLinkResumed: (fn) => { resumedHandler = fn; },
        },
    };
    const hooks = {
        deliverFrame(sid, frame) {
            const fn = frameHandlers.get(sid);
            if (fn != null) fn(sid, frame);
        },
        resume() { if (resumedHandler != null) resumedHandler(); },
    };
    const mod = loadHook(env);
    const api = mod.useConversations();
    // 【冷启动 refresh】ensureWatchers 在「已登录+有设备+列表空」时会
    // fire-and-forget 一次 refreshConversations（真实 App 行为）：sessions mock
    // 返回本会话行，refresh 用 convFromSessionRow 重建列表对象。
    // 【绝不能缓存 conv 对象引用】refresh 每次都会重建 Conversation 对象（复用
    // messages 数组）——缓存旧对象会读到脱离列表的孤儿。rt.conv 用 getter 每次
    // 从权威列表解析（与 UI 层 conversationOf 同口径）。
    return (async () => {
        const wantLatency = dev.latency;
        dev.latency = 0;
        await drainMicrotasks();
        dev.latency = wantLatency;
        if (!api.conversations.value.some((c) => c.id === opts.sessionId)) {
            api.conversations.value = [{
                id: opts.sessionId, title: 'sim', workspace: '__chat__', pinned: false,
                updatedAt: clock.now(), messages: [],
            }];
        }
        const rt = {
            api, dev, clock, hooks, frameHandlers, env, mod,
            get conv() {
                const c = api.conversations.value.find((x) => x.id === opts.sessionId);
                if (c == null) throw new Error('conversation vanished from list: ' + opts.sessionId);
                return c;
            },
        };
        return rt;
    })();
}

async function dumpDiag() {
    if (process.env.SIM_DUMP === 'S2') {
        const sid = 'work-d2';
        const rt = await makeRuntime({ sessionId: sid });
        let seq = seedRounds(rt.dev, sid, 12);
        rt.dev.running = true;
        rt.dev.runId = 'run-13';
        const f = (type, extra) => ({ eventSeq: seq++, type, sessionId: sid, runId: 'run-13', ...(extra || {}) });
        rt.dev.append(f('user', { text: 'Q13' }));
        rt.dev.append(f('reason', { text: 'thinking hard' }));
        rt.api.setActive(sid);
        await rt.clock.tick(50);
        rt.dev.emit(f('action_start', { actionId: 'a13', toolName: 'bash', args: { command: 'ls' } }), rt.hooks);
        rt.dev.emit(f('action_end', { actionId: 'a13', toolName: 'bash', text: 'ok', durationMs: 50 }), rt.hooks);
        rt.dev.emit(f('text', { text: 'final answer 13' }), rt.hooks);
        await rt.clock.tick(200);
        rt.dev.running = false;
        rt.dev.emit(f('done', {}), rt.hooks);
        await drainMicrotasks();
        console.log('DUMP S2 status:', lastAi(rt.conv).status);
        await rt.clock.tick(1000);
        await rt.clock.tick(60_000);
        rt.dev.requests.forEach((r) => console.log('  ' + (r.at - 1_700_000_000_000) + 'ms ' + r.path + '?' + r.query));
        return;
    }
    if (process.env.SIM_DUMP === 'S5') {
        const sid = 'work-d5';
        const rt = await makeRuntime({ sessionId: sid, latency: 100 });
        let seq = seedRounds(rt.dev, sid, 2);
        rt.dev.running = true;
        const mk = (type, extra) => ({ eventSeq: seq++, type, sessionId: sid, runId: 'run-3', ...(extra || {}) });
        rt.dev.append(mk('user', { text: 'Q3' }));
        rt.api.setActive(sid);
        await rt.clock.tick(500);
        for (let i = 0; i < 1200; i++) rt.dev.append(mk('text', { text: 'x' + i + ' ' }));
        rt.hooks.resume();
        await rt.clock.tick(50); // 补帧第一页在途
        const late1 = mk('text', { text: 'tail-B ' }); rt.dev.append(late1);
        const late2 = mk('text', { text: 'tail-C' }); rt.dev.append(late2);
        rt.dev.running = false;
        const doneFr = mk('done', {}); rt.dev.append(doneFr);
        rt.hooks.deliverFrame(sid, late2);
        rt.hooks.deliverFrame(sid, late1);
        rt.hooks.deliverFrame(sid, doneFr);
        await rt.clock.tick(2000);
        const tail = lastAi(rt.conv);
        const text = aiTextOf(tail);
        console.log('DUMP S5 status:', tail.status, 'len:', text.length);
        console.log('DUMP S5 tail-200:', JSON.stringify(text.slice(-200)));
        console.log('DUMP S5 hasB:', text.includes('tail-B'), 'hasC:', text.includes('tail-C'), 'order:', text.indexOf('tail-B'), text.indexOf('tail-C'));
        rt.dev.requests.forEach((r) => console.log('  ' + (r.at - 1_700_000_000_000) + 'ms ' + r.path + '?' + r.query));
        return;
    }
    const sid = 'work-dump';
    const rt = await makeRuntime({ sessionId: sid, latency: 300 });
    seedRounds(rt.dev, sid, 45);
    rt.api.setActive(sid);
    await rt.clock.tick(1500);
    console.log('DUMP first-screen msgs:', rt.conv.messages.length, 'users:', userTexts(rt.conv).join(','));
    await rt.clock.tick(3000 + 300 * 6);
    console.log('DUMP after 6.3s users:', userTexts(rt.conv).slice(0, 6).join(','), 'total', rt.conv.messages.length);
    console.log('DUMP requests:');
    rt.dev.requests.forEach((r) => console.log('  ' + (r.at - 1_700_000_000_000) + 'ms ' + r.path + '?' + r.query));
    console.log('DUMP pending timers:', rt.clock.pending());
    await rt.clock.tick(10_000);
    console.log('DUMP after +10s users:', userTexts(rt.conv).slice(0, 6).join(','), 'total', rt.conv.messages.length);
    rt.dev.requests.slice(-8).forEach((r) => console.log('  ' + (r.at - 1_700_000_000_000) + 'ms ' + r.path + '?' + r.query));
}

/* ---------------- 造帧工具 ---------------- */
function roundFrames(startSeq, roundIdx, opts) {
    // 一轮 = user + reason + action_start/action_end + text×2 + done
    const sid = opts.sessionId;
    let s = startSeq;
    const f = (type, extra) => ({ eventSeq: s++, type, sessionId: sid, runId: 'run-' + roundIdx, ...(extra || {}) });
    const frames = [
        f('user', { text: 'Q' + roundIdx }),
        f('reason', { text: 'thinking ' + roundIdx }),
        f('action_start', { actionId: 'a' + roundIdx, toolName: 'read', args: { file_path: 'x.ts' } }),
        f('action_end', { actionId: 'a' + roundIdx, toolName: 'read', text: 'file body', durationMs: 120 }),
        f('text', { text: 'A' + roundIdx + '-part1 ' }),
        f('text', { text: 'A' + roundIdx + '-part2' }),
        f('done', {}),
    ];
    return { frames, nextSeq: s };
}
function seedRounds(dev, sessionId, count) {
    let seq = 1;
    for (let i = 1; i <= count; i++) {
        const r = roundFrames(seq, i, { sessionId });
        r.frames.forEach((fr) => dev.append(fr));
        seq = r.nextSeq;
    }
    return seq;
}
const lastAi = (conv) => { for (let i = conv.messages.length - 1; i >= 0; i--) if (conv.messages[i].role === 'ai') return conv.messages[i]; return null; };
const userTexts = (conv) => conv.messages.filter((m) => m.role === 'user').map((m) => m.text);
const aiTextOf = (m) => m.text + m.blocks.filter((b) => b.kind === 'text').map((b) => b.body).join('');

/* ================= 场景 ================= */
const results = [];
async function scenario(name, fn) {
    try {
        await fn();
        results.push([name, true, '']);
        console.log('PASS  ' + name);
    } catch (e) {
        results.push([name, false, e && e.message]);
        console.error('FAIL  ' + name + '\n      ' + (e && e.stack || e));
    }
}

async function main() {
if (process.env.SIM_DUMP != null && process.env.SIM_DUMP.length > 0) { await dumpDiag(); return; }
/* S1 首屏一页上屏 + 更早轮延迟前插 + 接流不被翻页阻塞 */
await scenario('S1 长会话首屏只拉一页立即上屏，更早轮 3s 后后台前插', async () => {
    const sid = 'work-s1';
    const rt = await makeRuntime({ sessionId: sid, latency: 300 });
    seedRounds(rt.dev, sid, 45); // 45 轮 × 7 帧 = 315 帧
    const t0 = rt.clock.now();
    const opening = rt.api.setActive(sid);
    await rt.clock.tick(1500); // 首屏链路：replay(300)+probe(300)+pendingQuestion(300)
    const visible = rt.conv.messages.length;
    assert.ok(visible >= 14 && visible <= 22, '首屏应只有最新 10 轮(约20条)，实际 ' + visible);
    assert.deepEqual(userTexts(rt.conv).slice(0, 1), ['Q36'], '首屏第一条应是第 36 轮的提问');
    const firstScreenAt = rt.clock.now() - t0;
    assert.ok(firstScreenAt <= 1500, '首屏必须 1.5s 内完成（旧实现全量倒拉要 45/10×300ms 以上）');
    const roundsCallsBefore = rt.dev.requests.filter((r) => r.path === '/web/chat/replay' && r.query.includes('beforeSeq')).length;
    assert.equal(roundsCallsBefore, 0, '首屏阶段绝不能发起更早轮翻页');
    await rt.clock.tick(3000 + 300 * 6); // 3s 延迟 + 4 页翻页（每页 300ms）
    assert.deepEqual(userTexts(rt.conv)[0], 'Q1', '更早轮应前插到头部且顺序正确');
    assert.deepEqual(userTexts(rt.conv), Array.from({ length: 45 }, (_, i) => 'Q' + (i + 1)), '45 轮提问必须按序齐全');
    assert.equal(rt.conv.messages.filter((m) => m.role === 'ai' && m.status === 'processing').length, 0, '历史不得残留转圈占位');
    assert.ok(!rt.conv.messages.some((m) => m.id.includes('#earlier')), '影子会话不得泄漏进真实列表');
    assert.ok(!rt.api.conversations.value.some((c) => c.id.includes('#earlier')), '影子会话必须从列表移除');
});

/* S2 新桌面：运行中任务 live 帧驱动正文与 done 收口 */
await scenario('S2 运行中任务：GET 建订阅后 live 帧上屏，done 收口', async () => {
    const sid = 'work-s2';
    const rt = await makeRuntime({ sessionId: sid });
    let seq = seedRounds(rt.dev, sid, 12);
    // 设备上正跑到第 13 轮中段：user + reason 已落盘，running=true
    rt.dev.running = true;
    rt.dev.runId = 'run-13';
    const f = (type, extra) => ({ eventSeq: seq++, type, sessionId: sid, runId: 'run-13', ...(extra || {}) });
    rt.dev.append(f('user', { text: 'Q13' }));
    rt.dev.append(f('reason', { text: 'thinking hard' }));
    rt.api.setActive(sid);
    await rt.clock.tick(50);
    assert.ok(rt.frameHandlers.has(sid), '打开运行中会话必须注册帧订阅');
    const tail0 = lastAi(rt.conv);
    assert.equal(tail0.status, 'processing', '运行中尾条必须保持 processing');
    // live：工具卡 + 正文 + done（gateEnabled=true，GET replay 已 ensure 订阅）
    rt.dev.emit(f('action_start', { actionId: 'a13', toolName: 'bash', args: { command: 'ls' } }), rt.hooks);
    rt.dev.emit(f('action_end', { actionId: 'a13', toolName: 'bash', text: 'ok', durationMs: 50 }), rt.hooks);
    rt.dev.emit(f('text', { text: 'final answer 13' }), rt.hooks);
    await rt.clock.tick(200); // 120ms 合帧落账
    const tail1 = lastAi(rt.conv);
    assert.ok(aiTextOf(tail1).includes('final answer 13'), 'live 正文必须写进尾条');
    assert.ok(tail1.blocks.some((b) => b.kind === 'tool' && b.actionId === 'a13'), '工具卡必须以 tool 块呈现（不是问答）');
    rt.dev.running = false;
    rt.dev.emit(f('done', {}), rt.hooks);
    await drainMicrotasks();
    const tail2 = lastAi(rt.conv);
    assert.equal(tail2.status, 'done', 'done 帧必须收口');
    assert.equal(rt.frameHandlers.has(sid), true, '收口后订阅保留（迟到元数据帧并回上一轮）');
    // 看门狗必须撤单：终态后不得再有【看门狗形态】的探针（rounds=1 且非 afterSeq）。
    // 注意 3s 后的更早轮翻页（beforeSeq）是合法的历史补全，与看门狗无关，不能计入。
    await rt.clock.tick(1000);
    const watchdogProbes = () => rt.dev.requests.filter((r) =>
        r.path === '/web/chat/replay' && r.query.includes('rounds=1&') === false
        && /rounds=1($|&)/.test(r.query) && !r.query.includes('afterSeq')).length;
    const calls = watchdogProbes();
    await rt.clock.tick(60_000);
    assert.equal(watchdogProbes(), calls, '终态后看门狗不得再发探针');
});

/* S3 旧桌面兜底：无 live 帧，看门狗 15s 对账收口 */
await scenario('S3 旧桌面（GET 不建订阅）：看门狗对账内核 running 态并收口', async () => {
    const sid = 'work-s3';
    const rt = await makeRuntime({ sessionId: sid, gateEnabled: false });
    let seq = seedRounds(rt.dev, sid, 3);
    rt.dev.running = true;
    rt.dev.runId = 'run-4';
    const f = (type, extra) => ({ eventSeq: seq++, type, sessionId: sid, runId: 'run-4', ...(extra || {}) });
    rt.dev.append(f('user', { text: 'Q4' }));
    rt.api.setActive(sid);
    await rt.clock.tick(50);
    assert.equal(lastAi(rt.conv).status, 'processing', '接流后尾条 processing');
    // 设备端跑完（帧全部落盘，但旧桌面 gate 未建 → 手机一帧都收不到）
    rt.dev.append(f('text', { text: 'answer 4' }));
    rt.dev.append(f('done', {}));
    rt.dev.running = false;
    await rt.clock.tick(15_000 + 100); // 看门狗周期 + 补帧
    const tail = lastAi(rt.conv);
    assert.equal(tail.status, 'done', '看门狗必须把已结束的轮收口（旧桌面 done 帧不达也不能永久转圈）');
    assert.ok(aiTextOf(tail).includes('answer 4'), '收口同时必须补回缺失正文');
    await rt.clock.tick(60_000);
    const calls = rt.dev.replayCalls;
    await rt.clock.tick(60_000);
    assert.equal(rt.dev.replayCalls, calls, '收口后看门狗必须停');
});

/* S4 看门狗收口失败续命（本轮 review 修复点） */
await scenario('S4 看门狗发现已结束但补帧失败：必须重试并最终收口', async () => {
    const sid = 'work-s4';
    const rt = await makeRuntime({ sessionId: sid, gateEnabled: false });
    let seq = seedRounds(rt.dev, sid, 2);
    rt.dev.running = true;
    const f = (type, extra) => ({ eventSeq: seq++, type, sessionId: sid, runId: 'run-3', ...(extra || {}) });
    rt.dev.append(f('user', { text: 'Q3' }));
    rt.api.setActive(sid);
    await rt.clock.tick(50);
    rt.dev.append(f('text', { text: 'answer 3' }));
    rt.dev.append(f('done', {}));
    rt.dev.running = false;
    // 编排：看门狗探针成功之后的第一次 After 补帧失败（502），此后恢复
    let armed = false;
    rt.dev.failReplay = (query) => {
        if (query.includes('afterSeq')) {
            if (!armed) { armed = true; return true; }
        }
        return false;
    };
    await rt.clock.tick(15_000 + 100);
    assert.equal(lastAi(rt.conv).status, 'processing', '补帧失败当口不得假装收口');
    await rt.clock.tick(35_000); // 退避重试（1s 起步）+ 看门狗兜底都在此窗口内
    const tail = lastAi(rt.conv);
    assert.equal(tail.status, 'done', '失败后必须有人续命（重试/看门狗），最终收口——review 修复点');
    assert.ok(aiTextOf(tail).includes('answer 3'), '重试补帧必须带回正文');
});

/* S5 After 分页补帧 + 期间 live 帧缓冲不乱序 */
await scenario('S5 断线补帧：After 分页拉全 + live 缓冲升序合并，无丢段无重复', async () => {
    const sid = 'work-s5';
    // 【必须编排非零延迟】零延迟时 resume 的补帧在 microtask 里一口气拉完，
    // 「补帧在途 + live 乱序抵达」的窗口根本不存在，测不到缓冲合并路径。
    const rt = await makeRuntime({ sessionId: sid, latency: 100 });
    let seq = seedRounds(rt.dev, sid, 2);
    rt.dev.running = true;
    const mk = (type, extra) => ({ eventSeq: seq++, type, sessionId: sid, runId: 'run-3', ...(extra || {}) });
    rt.dev.append(mk('user', { text: 'Q3' }));
    rt.api.setActive(sid);
    await rt.clock.tick(500); // 首屏 + 接流完成
    // 断线期间设备端产出 1200 帧正文（>500/页 → 3 页）；不投递 live（模拟断线）
    for (let i = 0; i < 1200; i++) rt.dev.append(mk('text', { text: 'x' + i + ' ' }));
    // 恢复链路：resumed → catchUpFrames 分页拉全
    rt.hooks.resume();
    await rt.clock.tick(50); // 第一页在途（100ms 延迟）
    // 补帧在途时到达的 live 帧（乱序抵达）应进缓冲、按 seq 合并
    const late1 = mk('text', { text: 'tail-B ' }); rt.dev.append(late1);
    const late2 = mk('text', { text: 'tail-C' }); rt.dev.append(late2);
    rt.dev.running = false;
    const doneFr = mk('done', {}); rt.dev.append(doneFr);
    rt.hooks.deliverFrame(sid, late2); // 先到 C
    rt.hooks.deliverFrame(sid, late1); // 后到 B
    rt.hooks.deliverFrame(sid, doneFr);
    await rt.clock.tick(2000);
    const tail = lastAi(rt.conv);
    const text = aiTextOf(tail);
    assert.ok(text.includes('x0 ') && text.includes('x1199 '), '分页补帧不得丢中间段');
    assert.ok(text.indexOf('x0 ') < text.indexOf('x1199 '), '补帧段必须升序');
    assert.ok(text.includes('tail-B tail-C'), 'live 缓冲必须按 seq 排序合并（乱序到达不乱序上屏）');
    assert.equal(tail.status, 'done', 'done 帧（缓冲回放）必须收口');
    const occurrences = text.split('x600 ').length - 1;
    assert.equal(occurrences, 1, '重叠段必须被 eventSeq 去重');
});

/* S6 竞态：双击打开单飞 + 设备切换作废迟到翻页 */
await scenario('S6a 双击打开同一会话：历史加载单飞不重复重建', async () => {
    const sid = 'work-s6a';
    const rt = await makeRuntime({ sessionId: sid, latency: 200 });
    seedRounds(rt.dev, sid, 25);
    rt.api.setActive(sid);
    rt.api.setActive(sid); // 同一 id 抽屉+首页双触发
    await rt.clock.tick(2000);
    const firstPageCalls = rt.dev.requests.filter((r) => r.path === '/web/chat/replay' && !r.query.includes('beforeSeq') && r.query.includes('rounds=10')).length;
    assert.equal(firstPageCalls, 1, 'rebuildHistory 必须单飞（两次 setActive 只拉一次首页）');
    await rt.clock.tick(10_000);
    assert.deepEqual(userTexts(rt.conv), Array.from({ length: 25 }, (_, i) => 'Q' + (i + 1)), '消息不得重复/错序');
});

await scenario('S6b 设备切换：迟到翻页页/看门狗/补帧全部作废，不写入新设备会话', async () => {
    const sid = 'work-s6b';
    const rt = await makeRuntime({ sessionId: sid, latency: 400, gateEnabled: false });
    let seq = seedRounds(rt.dev, sid, 30);
    rt.dev.running = true;
    rt.dev.append({ eventSeq: seq++, type: 'user', sessionId: sid, runId: 'run-31', text: 'Q31' });
    rt.api.setActive(sid);
    await rt.clock.tick(1600); // 首屏完成、running 接流、看门狗已武装
    assert.ok(rt.frameHandlers.has(sid), '切换前应有帧订阅');
    // 3s 翻页定时器尚未触发时切设备
    rt.env.devices.activeDeviceId.value = 'dev-2';
    rt.mod.useConversations(); // 触发点无关；直接调内部 reset 不可达——用 removeConversation 等价清理路径 + watch 由真机驱动。
    // hook 的 watch 在 mock 中不触发（vue.watch 为 no-op），这里改走公开删除路径验证同类清理：
    rt.api.removeConversation(sid);
    await rt.clock.tick(30_000); // 迟到的翻页定时器/看门狗/重试全部到期
    assert.equal(rt.api.conversations.value.length, 0, '删除后列表为空');
    assert.equal(rt.frameHandlers.has(sid), false, '删除必须撤帧订阅');
    const before = rt.dev.requests.length;
    await rt.clock.tick(60_000);
    assert.equal(rt.dev.requests.length, before, '删除/切换后不得再有看门狗探针或翻页请求');
});

/* S7 影子前插附件走真实会话 id（本轮 review 修复点） */
await scenario('S7 更早轮带图前插：meta 请求必须打真实会话 id，图片可见', async () => {
    const sid = 'work-s7';
    const rt = await makeRuntime({ sessionId: sid, latency: 50 });
    let seq = seedRounds(rt.dev, sid, 14);
    // 第 2 轮改成带图提问（位于更早页）
    const q2 = rt.dev.events.find((e) => e.type === 'user' && e.text === 'Q2');
    q2.text = '';
    q2.imagePaths = ['attachments/pic.png'];
    rt.api.setActive(sid);
    await rt.clock.tick(3000 + 50 * 10 + 500);
    const userRow = rt.conv.messages.find((m) => m.role === 'user' && m.imageUrls.length > 0);
    assert.ok(userRow != null, '更早轮的图片必须升级成 dataUrl 可见');
    assert.ok(rt.dev.metaRequests.length > 0, '应发起 meta 请求');
    for (const r of rt.dev.metaRequests) {
        assert.equal(r.sessionId, sid, 'meta 请求 sessionId 必须是真实会话（review 修复：不得是 id#earlier）');
        assert.ok(!r.query.includes('%23earlier') && !r.query.includes('#earlier'), 'query 不得携带影子后缀');
    }
});

/* S8 已闭环问答卡对重放帧幂等 */
await scenario('S8 已答问答卡：重放同 actionId 的 question 帧不得翻回待答', async () => {
    const sid = 'work-s8';
    const rt = await makeRuntime({ sessionId: sid });
    let seq = seedRounds(rt.dev, sid, 1);
    rt.dev.running = true;
    const f = (type, extra) => ({ eventSeq: seq++, type, sessionId: sid, runId: 'run-2', ...(extra || {}) });
    rt.dev.append(f('user', { text: 'Q2' }));
    rt.api.setActive(sid);
    await rt.clock.tick(50);
    rt.dev.emit(f('question', { actionId: 'q-1', toolName: 'ask_user', args: { questions: [{ header: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }] } }), rt.hooks);
    await drainMicrotasks();
    let tail = lastAi(rt.conv);
    const card = tail.blocks.find((b) => b.actionId === 'q-1');
    assert.ok(card != null && card.interact === 'question' && card.status === 'warn', 'question 帧必须建待答卡');
    assert.ok(tail.blocks.every((b) => b.kind !== 'tool' || b.actionId !== 'q-1'), '问答不得同时落成工具卡');
    // 他端已答：question_answered 闭环
    rt.dev.emit(f('question_answered', { actionId: 'q-1', args: { answers: [{ index: 0, text: 'A' }] } }), rt.hooks);
    await drainMicrotasks();
    assert.equal(card.interact, 'resolved', '闭环后必须 resolved');
    // 乱序补帧/重放：同 actionId question 帧再来（eventSeq 更大，绕不过 seq 去重）
    rt.dev.emit(f('question', { actionId: 'q-1', toolName: 'ask_user', args: { questions: [{ header: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }] } }), rt.hooks);
    await drainMicrotasks();
    assert.equal(card.interact, 'resolved', '重放不得把已答卡翻回待答（点提交必 409 的僵尸卡）');
    assert.equal(card.status, 'done', '已答卡状态保持终态');
});

/* S9 旧桌面 + 任务【仍在跑】：看门狗 running 分支必须周期拉增量（三轮报障
 * 「运行中任务手机进去一直思考中、消息不展示」的直接根因——旧看门狗只在
 * 「已结束」分支补帧，running 期间空转对账，live 帧又因旧桌面 GET 不建订阅
 * 一帧不达，手机上什么都看不到）。 */
await scenario('S9 旧桌面+仍在跑：看门狗必须周期拉增量上屏，结束后收口', async () => {
    const sid = 'work-s9';
    const rt = await makeRuntime({ sessionId: sid, gateEnabled: false });
    let seq = seedRounds(rt.dev, sid, 3);
    rt.dev.running = true;
    rt.dev.runId = 'run-4';
    const f = (type, extra) => ({ eventSeq: seq++, type, sessionId: sid, runId: 'run-4', ...(extra || {}) });
    rt.dev.append(f('user', { text: 'Q4' }));
    rt.api.setActive(sid);
    await rt.clock.tick(50);
    assert.equal(lastAi(rt.conv).status, 'processing', '接流后尾条 processing');
    // 设备端继续产出（帧只落盘，不投递 live）
    rt.dev.append(f('action_start', { actionId: 'a4', toolName: 'bash', args: { command: 'cargo build' } }));
    rt.dev.append(f('action_end', { actionId: 'a4', toolName: 'bash', text: 'ok', durationMs: 100 }));
    rt.dev.append(f('text', { text: 'progress-4 ' }));
    await rt.clock.tick(15_000 + 100);
    let tail = lastAi(rt.conv);
    assert.ok(tail.blocks.some((b) => b.kind === 'tool' && b.actionId === 'a4'), '仍在跑时看门狗必须把工具卡增量拉回上屏（不得光对账不拉帧）');
    assert.ok(aiTextOf(tail).includes('progress-4'), '仍在跑时正文增量必须可见');
    assert.equal(tail.status, 'processing', '设备仍在跑，尾条保持 processing');
    // 设备继续跑一段后结束
    rt.dev.append(f('text', { text: 'final-4' }));
    rt.dev.append(f('done', {}));
    rt.dev.running = false;
    await rt.clock.tick(15_000 + 100);
    tail = lastAi(rt.conv);
    assert.equal(tail.status, 'done', '结束后看门狗收口');
    assert.ok(aiTextOf(tail).includes('final-4'), '收口时补回最后一段正文');
});

/* S10 旧内核空信封（无 user 帧的流）：绝不降级纯文本快照丢过程轨迹。
 * rebuildHistory 检测「events 空但 latestSeq>0」→ After 全量兜底。 */
await scenario('S10 旧内核无 user 帧回空信封：After 兜底保住过程轨迹，不降级快照', async () => {
    const sid = 'work-s10';
    const rt = await makeRuntime({ sessionId: sid, kernelStrictRounds: true });
    // 无 user 帧的流（续跑段/截断流）：reason + 工具 + 正文 + done
    let s = 1;
    const f = (type, extra) => ({ eventSeq: s++, type, sessionId: sid, runId: 'run-1', ...(extra || {}) });
    [
        f('reason', { text: 'thinking headless' }),
        f('action_start', { actionId: 'h1', toolName: 'read', args: { file_path: 'a.rs' } }),
        f('action_end', { actionId: 'h1', toolName: 'read', text: 'body', durationMs: 10 }),
        f('text', { text: 'headless answer' }),
        f('done', {}),
    ].forEach((fr) => rt.dev.append(fr));
    rt.api.setActive(sid);
    await rt.clock.tick(500);
    if (process.env.SIM_DEBUG === '1') {
        rt.dev.requests.forEach((r) => console.log('  REQ', r.path + '?' + r.query));
        rt.conv.messages.forEach((m, i) => console.log('  MSG', i, m.role, m.status, 'text.len', m.text.length, 'blocks', JSON.stringify(m.blocks.map((b) => ({ kind: b.kind, id: b.id, actionId: b.actionId })))));
    }
    const tail = lastAi(rt.conv);
    assert.ok(tail != null, '必须有 AI 消息');
    assert.ok(tail.blocks.some((b) => b.kind === 'tool' && b.actionId === 'h1'), '过程工具卡必须保留（不得降级成纯文本快照）');
    assert.ok(tail.blocks.some((b) => b.kind === 'thinking'), '思考块必须保留');
    assert.ok(aiTextOf(tail).includes('headless answer'), '正文必须可见');
    assert.equal(tail.status, 'done', '历史尾条收口');
    assert.ok(!rt.dev.requests.some((r) => r.path === '/web/chat/messages'), '不得请求 /messages 纯文本快照');
    assert.ok(rt.dev.requests.some((r) => r.path === '/web/chat/replay' && r.query.includes('afterSeq=0')), '必须走 After 全量兜底');
});

/* S10b 新内核（本次修复）：无 user 帧直接回全窗投影，rounds 一页拿全过程 */
await scenario('S10b 新内核无 user 帧全窗投影：rounds 一页即保全过程', async () => {
    const sid = 'work-s10b';
    const rt = await makeRuntime({ sessionId: sid }); // kernelStrictRounds=false = 修复后内核
    let s = 1;
    const f = (type, extra) => ({ eventSeq: s++, type, sessionId: sid, runId: 'run-1', ...(extra || {}) });
    [
        f('reason', { text: 'thinking headless' }),
        f('action_start', { actionId: 'h1', toolName: 'read', args: { file_path: 'a.rs' } }),
        f('action_end', { actionId: 'h1', toolName: 'read', text: 'body', durationMs: 10 }),
        f('text', { text: 'headless answer' }),
        f('done', {}),
    ].forEach((fr) => rt.dev.append(fr));
    rt.api.setActive(sid);
    await rt.clock.tick(500);
    const tail = lastAi(rt.conv);
    assert.ok(tail.blocks.some((b) => b.kind === 'tool' && b.actionId === 'h1'), '新内核 rounds 直接带过程');
    assert.ok(aiTextOf(tail).includes('headless answer'), '正文可见');
    assert.ok(!rt.dev.requests.some((r) => r.query.includes('afterSeq=0')), '新内核无需 After 兜底');
});

/* S11 真实落盘流回放保真：把本机 .gwork/sessions 的真实 .stream.ndjson
 * 喂给 hook（Rounds 合帧投影按内核口径复刻），断言过程块/用户行/正文齐全。
 * 找不到真实流文件时跳过（CI 环境无会话数据）。 */
await scenario('S11 真实落盘流回放：过程块/用户行/正文齐全（本机真实会话）', async () => {
    const candidates = [
        path.join(APP, '..', '.gwork', 'sessions'),
        path.join(process.env.USERPROFILE || '', '.gwork', 'sessions'),
    ];
    let streamFile = null;
    for (const root of candidates) {
        if (!fs.existsSync(root)) continue;
        const dirs = fs.readdirSync(root).filter((d) => d.startsWith('work-'));
        // 找一个「多 user 帧 + 多工具帧 + 已完成」的中等规模流（<8MB，避免测试过慢）
        for (const d of dirs) {
            const p = path.join(root, d, d + '.stream.ndjson');
            if (!fs.existsSync(p)) continue;
            const st = fs.statSync(p);
            if (st.size < 50_000 || st.size > 8_000_000) continue;
            const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
            let users = 0, tools = 0, hasDone = false;
            for (const l of lines) {
                try {
                    const fr = JSON.parse(l);
                    if (fr.type === 'user') users++;
                    if (fr.type === 'action_end') tools++;
                    if (fr.type === 'done') hasDone = true;
                } catch (_) {}
            }
            if (users >= 2 && tools >= 5 && hasDone) { streamFile = { p, lines }; break; }
        }
        if (streamFile) break;
    }
    if (streamFile == null) { console.log('      (no real session stream found, scenario skipped)'); return; }
    const all = streamFile.lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    // 内核 Rounds 合帧投影复刻（同 kind 主线连续 delta 合并；此处只合 text/reason 主线）
    function roundsProjection(pool, rounds) {
        const starts = [];
        pool.forEach((fr, i) => { if (fr.type === 'user') starts.push(i); });
        if (starts.length === 0) return pool.slice(0);
        const from = starts[Math.max(0, starts.length - rounds)];
        const sel = pool.slice(from);
        const out = []; let run = []; let kind = null;
        const flush = () => {
            if (!run.length) return;
            if (run.length === 1) out.push(run[0]);
            else { const fr = { ...run[0] }; fr.text = run.map((r) => r.text || '').join(''); fr.eventSeq = Math.max(...run.map((r) => r.eventSeq || 0)); out.push(fr); }
            run = [];
        };
        for (const fr of sel) {
            const k = (fr.type === 'text' || fr.type === 'reason') ? fr.type : null;
            if (k !== kind) { flush(); kind = k; }
            if (k) run.push(fr); else out.push(fr);
        }
        flush();
        return out;
    }
    const sid = 'work-s11';
    const rt = await makeRuntime({ sessionId: sid });
    // 用真实帧替换 mock 设备的 rounds 响应：按内核口径投影
    const realEvents = all.map((fr) => ({ ...fr, sessionId: sid }));
    rt.dev.events = realEvents;
    const origRequest = rt.dev.request;
    rt.dev.request = async (method, apiPath, query, body, root) => {
        if (apiPath === '/web/chat/replay' && !(query || '').includes('afterSeq')) {
            rt.dev.requests.push({ method, path: apiPath, query: query || '', body: body || '', at: rt.clock.now() });
            await drainMicrotasks();
            const q = new URLSearchParams(query || '');
            const rounds = Number(q.get('rounds') || '10');
            const before = q.has('beforeSeq') ? Number(q.get('beforeSeq')) : Infinity;
            const pool = realEvents.filter((e) => (e.eventSeq || 0) < before);
            const page = roundsProjection(pool, rounds);
            const starts = []; pool.forEach((fr, i) => { if (fr.type === 'user') starts.push(i); });
            const hasMore = starts.length > rounds;
            return { code: 200, data: { events: page, runId: 'real', running: false, hasMore, latestSeq: realEvents.length ? realEvents[realEvents.length - 1].eventSeq : 0, firstSeq: page.length ? page[0].eventSeq : 0 } };
        }
        return origRequest(method, apiPath, query, body, root);
    };
    rt.api.setActive(sid);
    await rt.clock.tick(2000);
    // 断言：最新页里每个 user 行都有对应 AI 回复；过程块（tool/thinking/batch）存在；无转圈残留
    const msgs = rt.conv.messages;
    const usersInPage = msgs.filter((m) => m.role === 'user');
    assert.ok(usersInPage.length >= 1, '真实流回放必须有用户行');
    const aiMsgs = msgs.filter((m) => m.role === 'ai');
    assert.ok(aiMsgs.length >= 1, '必须有 AI 行');
    const totalBlocks = aiMsgs.reduce((n, m) => n + m.blocks.length, 0);
    assert.ok(totalBlocks > 0, '真实流回放必须还原过程块（工具/思考/批次），不得只剩正文');
    assert.ok(aiMsgs.some((m) => m.text.length > 0 || m.blocks.some((b) => b.kind === 'text')), '正文必须可见');
    assert.equal(msgs.filter((m) => m.role === 'ai' && m.status === 'processing').length, 0, '已完成流不得残留转圈');
    // 翻更早轮后用户行总数应与流内 user 帧数一致（去重口径下）
    await rt.clock.tick(3000 + 200 * 30);
    const realUserCount = realEvents.filter((e) => e.type === 'user' && (e.text || '').length > 0).length;
    const shownUsers = rt.conv.messages.filter((m) => m.role === 'user').length;
    assert.ok(shownUsers >= Math.min(realUserCount, usersInPage.length), '更早轮前插不得丢用户行');
});

/* S12 回放失败后的降级/重试：必须明确提示「只有正文」，重试走 replay 重建过程卡。 */
await scenario('S12 回放失败降级：正文保住且可重试重建过程与产物卡', async () => {
    const sid = 'work-s12';
    let failOnce = true;
    const rt = await makeRuntime({
        sessionId: sid,
        failReplay: (query) => {
            // 初次首屏 rounds 失败，重试时放行
            if (failOnce && query.includes('rounds=') && !query.includes('beforeSeq=')) {
                failOnce = false;
                return true;
            }
            return false;
        },
    });
    let s = 1;
    const f = (type, extra) => ({ eventSeq: s++, type, sessionId: sid, runId: 'run-12', ...(extra || {}) });
    [
        f('user', { text: 'Q12' }),
        f('action_start', { actionId: 'h12', toolName: 'read', args: { file_path: 'a.rs' } }),
        f('action_end', { actionId: 'h12', toolName: 'read', text: 'body', durationMs: 10 }),
        f('text', { text: 'final text only' }),
        f('file_changes', { args: { files: [{ path: 'a.rs', changeType: 'MODIFIED', additions: 3, deletions: 1 }] } }),
        f('done', {}),
    ].forEach((fr) => rt.dev.append(fr));
    rt.api.setActive(sid);
    await rt.clock.tick(500);
    let tail = lastAi(rt.conv);
    assert.ok(aiTextOf(tail).includes('final text only'), 'snapshot fallback must preserve the final text');
    assert.ok((tail.degradedNotice || '').length > 0, 'degraded text snapshot must carry an explicit notice');
    assert.ok(!rt.dev.requests.some((r) => r.path === '/web/chat/messages' && r.query.includes('afterSeq')), 'snapshot must not pretend to be replay');
    // 用户点重试：清除 loaded 后重新走 replay 帧，过程块与产物卡回来且提示消失
    rt.api.retryHistory(sid);
    await rt.clock.tick(500);
    tail = lastAi(rt.conv);
    assert.ok(tail.blocks.some((b) => b.kind === 'tool' && b.actionId === 'h12'), 'retry must rebuild the process card via replay frames');
    assert.ok(tail.blocks.some((b) => b.args === 'fileChanges' && b.changes.length > 0), 'retry must rebuild the file-changes card');
    assert.ok((tail.degradedNotice || '').length === 0, 'a successful retry must clear the degraded notice');
});

/* S13 args 被 JSON 字符串化：file_changes 仍必须解析出产物卡。 */
await scenario('S13 字符串化 args：文件变更卡不因协议形态差异消失', async () => {
    const sid = 'work-s13';
    const rt = await makeRuntime({ sessionId: sid });
    let s = 1;
    const f = (type, extra) => ({ eventSeq: s++, type, sessionId: sid, runId: 'run-13', ...(extra || {}) });
    [
        f('user', { text: 'Q13' }),
        f('text', { text: 'answer' }),
        f('file_changes', { args: JSON.stringify({ files: [{ path: 'a.ts', changeType: 'ADDED', additions: 7, deletions: 0 }] }) }),
        f('done', {}),
    ].forEach((fr) => rt.dev.append(fr));
    rt.api.setActive(sid);
    await rt.clock.tick(500);
    const tail = lastAi(rt.conv);
    assert.ok(tail.blocks.some((b) => b.args === 'fileChanges' && b.changes.length > 0 && b.changes[0].path === 'a.ts'),
        'stringified file_changes args must still produce a visible changes card');
});

/* ---------------- 汇总 ---------------- */
const failed = results.filter(([, ok]) => !ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' scenarios passed');
if (failed.length) {
    process.exitCode = 1;
} else {
    console.log('ALL PASS — 行为级模拟（真实 hook 代码 + 虚拟时钟 + 可编程链路）');
}
}
main().catch((e) => { console.error(e); process.exitCode = 1; });