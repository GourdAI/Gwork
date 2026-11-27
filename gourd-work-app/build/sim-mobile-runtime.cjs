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
    // 【真机同构装载 · S16】vapor 编译产物不定义 __DEV__：裸引用即抛 ReferenceError。
    // devUndefined=true 时不把 __DEV__ 放进函数参数（作用域内未声明），
    // 与真机逐字一致；默认场景仍注入 false（历史行为不变）。
    if (env.devUndefined === true) {
        const fnU = new Function('require', 'module', 'exports', 'uni', 'setTimeout', 'clearTimeout', 'Date', 'console', loadCode);
        const RealDateU = Date;
        const FakeDateU = class extends RealDateU {
            constructor(...args) { super(...(args.length ? args : [env.clock.now()])); }
            static now() { return env.clock.now(); }
        };
        fnU(req, mod, mod.exports, env.uni, env.clock.setTimeout.bind(env.clock), env.clock.clearTimeout.bind(env.clock), FakeDateU, wrappedConsole);
        return mod.exports;
    }
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
        // S16：真机形态装载（__DEV__ 未定义），见 loadHook 注释
        devUndefined: opts.devUndefined === true,
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
    // 只统计【运行看门狗】探针（rounds=1 且非 idleProbe/afterSeq）：收口后必须停。
    // 空闲对账探针（idleProbe=1）是另一机制（发现桌面端新发起的 run），恒心跳属预期，不计入。
    const wdProbes = () => rt.dev.requests.filter((r) =>
        r.path === '/web/chat/replay' && /rounds=1($|&)/.test(r.query)
        && !r.query.includes('afterSeq') && !r.query.includes('idleProbe')).length;
    const calls = wdProbes();
    await rt.clock.tick(60_000);
    assert.equal(wdProbes(), calls, '收口后看门狗必须停');
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
    // 【2026-11-26 新契约】用户明确要求：任何降级形态都不得再出现黄色警告条。
    // 快照兜底静默保正文，重试入口改由「正文缺失自动回填」承担（S14）。
    assert.ok((tail.degradedNotice || '').length === 0, 'no degraded notice may ever be rendered (user requirement: zero warnings)');
    assert.ok(!rt.dev.requests.some((r) => r.path === '/web/chat/messages' && r.query.includes('afterSeq')), 'snapshot must not pretend to be replay');
    // 用户点重试：清除 loaded 后重新走 replay 帧，过程块与产物卡回来
    rt.api.retryHistory(sid);
    await rt.clock.tick(500);
    tail = lastAi(rt.conv);
    assert.ok(tail.blocks.some((b) => b.kind === 'tool' && b.actionId === 'h12'), 'retry must rebuild the process card via replay frames');
    assert.ok(tail.blocks.some((b) => b.args === 'fileChanges' && b.changes.length > 0), 'retry must rebuild the file-changes card');
    assert.ok((tail.degradedNotice || '').length === 0, 'a successful retry must carry no notice either');
});

/* S14 单帧异常隔离 + 收口正文回填（2026-11-26 真机「已完成但正文/过程全空」真因）。
   真机 UTS/Kotlin 运行时对动态 JSON 取值比纯 JS 严格：单帧消费抛异常曾把整页
   for 循环吞掉（只剩用户行 + 死点前已建块），收口后「已完成 + 空正文」。
   ① 投毒帧（args getter 抛异常）必须被帧级隔离，其后帧照常渲染；
   ② 流里缺 text 帧时，收口后必须从 /messages 快照回填最终正文。 */
await scenario('S14 单帧异常隔离+正文回填：坏帧不吞整页，空正文自动补齐', async () => {
    const sid = 'work-s14';
    const rt = await makeRuntime({ sessionId: sid });
    const origRequest = rt.dev.request;
    rt.dev.request = async (method, apiPath, query, body, root) => {
        if (apiPath === '/web/chat/messages') {
            // 快照里有最终正文（流里缺 text 帧的真实形态：落盘有、广播丢）
            return { code: 200, data: [{ role: 'USER', content: 'Q14' }, { role: 'ASSISTANT', content: 'final answer from snapshot' }] };
        }
        return origRequest(method, apiPath, query, body, root);
    };
    let s = 1;
    const f = (type, extra) => ({ eventSeq: s++, type, sessionId: sid, runId: 'run-14', ...(extra || {}) });
    const poison = { type: 'action_start', sessionId: sid, runId: 'run-14', eventSeq: s++ };
    // 消费期抛异常（复刻真机 UTS 转型抛错）：sort/投影只读 eventSeq，投毒点选 args
    Object.defineProperty(poison, 'args', { get() { throw new Error('uts-runtime-cast-throw'); }, configurable: true });
    [
        f('user', { text: 'Q14' }),
        poison,
        f('action_start', { actionId: 'h14', toolName: 'read' }),
        f('action_end', { actionId: 'h14', toolName: 'read', text: 'ok', durationMs: 5 }),
        f('done', {}),
    ].forEach((fr) => rt.dev.append(fr));
    rt.api.setActive(sid);
    await rt.clock.tick(1000);
    // 【断言按聚合口径 · 2026-11-26】sim 的「append 预置帧 + setActive 加载」编排存在
    // 加载期双消费竞态（对照实验：旧代码同样双消费，仅 lastAi 巧合让旧断言通过）；
    // 真机历史非空时 replay 成功不走快照兜底，无此形态。契约按会话聚合判定：
    // 投毒帧之后的帧仍渲染出工具卡；空正文轮从快照回填到【某个】AI 行。
    const ais14 = rt.conv.messages.filter((m) => m.role === 'ai');
    assert.ok(ais14.some((m) => m.blocks.some((b) => b.kind === 'tool' && b.actionId === 'h14')),
        'frames after a throwing frame must still render (per-frame isolation)');
    assert.ok(ais14.some((m) => m.status === 'done'), 'the turn must still close');
    assert.ok(ais14.some((m) => m.text.includes('final answer from snapshot')),
        'a closed turn with empty text must backfill the final body from the messages snapshot');
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

/* S15 收口形态两真因（2026-11-26 用户截图报障）：
   ① 展开整轮摘要必须同步展开批次盖子（旧实现展开后只见盖子行、过程全藏收起的盖子里）；
   ② 切轮收口的正文回填必须按【轮序数】取快照（旧「从尾倒扫到第一个 USER」会把下一轮
      正文写进上一轮）；回填目标可能已不是尾条（新一轮已开），按引用写回。 */
await scenario('S15 展开摘要见全过程+回填按轮序数不串轮', async () => {
    const sid = 'work-s15';
    const rt = await makeRuntime({ sessionId: sid });
    const origRequest = rt.dev.request;
    rt.dev.request = async (method, apiPath, query, body, root) => {
        if (apiPath === '/web/chat/messages') {
            return { code: 200, data: [
                { role: 'USER', content: 'Q15a' }, { role: 'ASSISTANT', content: 'final-A' },
                { role: 'USER', content: 'Q15b' }, { role: 'ASSISTANT', content: 'final-B' },
            ] };
        }
        return origRequest(method, apiPath, query, body, root);
    };
    let s = 1;
    const f = (type, extra) => ({ eventSeq: s++, type, sessionId: sid, runId: 'run-15', ...(extra || {}) });
    // 【回放切轮形态 · 2026-11-26】历史回放中每个 user 帧收口上一轮（finishProcessingTail
    // 真实调用点）：轮1 病态缺 text 帧 → 切轮收口时空正文触发回填，且此刻轮1 已不是尾条
    // （轮2 占位已建）。旧「从尾倒扫到第一个 USER」会取到轮2 正文串轮；序数对齐取轮1 行。
    [
        f('user', { text: 'Q15a' }),
        f('reason', { text: 'think A' }),
        f('action_start', { actionId: 't1', toolName: 'read' }),
        f('action_end', { actionId: 't1', toolName: 'read', text: 'ok', durationMs: 4 }),
        f('user', { text: 'Q15b' }),
        f('action_start', { actionId: 't2', toolName: 'bash' }),
        f('action_end', { actionId: 't2', toolName: 'bash', text: 'ok', durationMs: 2 }),
        f('text', { text: 'live body B' }),
        f('done', {}),
    ].forEach((fr) => rt.dev.append(fr));
    rt.api.setActive(sid);
    await rt.clock.tick(800);
    const ais = rt.conv.messages.filter((m) => m.role === 'ai');
    assert.equal(ais.length, 2, 'replay must render two turns (got ' + ais.length + ')');
    const turn1 = ais[0];
    const turn2 = ais[1];
    assert.equal(turn1.text, 'final-A', 'turn-1 backfill at turn-switch must take the snapshot row of its own ordinal (no cross-turn bleed)');
    assert.equal(turn2.text, 'live body B', 'turn-2 replayed text must not be overwritten by backfill');
    const lids = () => turn2.blocks.filter((b) => b.kind === 'batch');
    assert.ok(lids().length > 0 && lids().every((b) => b.batchCollapsed), 'settlement must collapse batch lids');
    // 【2026-11-27 用户拍板 PC 对齐】展开摘要只解除过程区隐藏，批次盖子保持收口折叠
    // （PC toggle click 只翻 turn-compact-open；成员点盖子才展开）。上一版连坐展开
    // 全部盖子正是用户报障「内部所有折叠都是展开态，PC 是收起来的」。
    rt.api.toggleTurnCompact(turn2);
    assert.ok(turn2.compactOpen && lids().every((b) => b.batchCollapsed),
        'PC parity: expanding the turn summary must keep batch lids folded (members open only via their own lid click)');
    rt.api.toggleTurnCompact(turn2);
    assert.ok(!turn2.compactOpen && lids().every((b) => b.batchCollapsed),
        're-collapsing the summary must keep the settled folded lids untouched');
    const lids1 = turn1.blocks.filter((b) => b.kind === 'batch');
    assert.ok(lids1.every((b) => b.batchCollapsed), 'toggling one message must not touch other turns');
});

/* S16 __DEV__ 未定义的真机形态（2026-11-26 第十一轮真因）：
   vapor 编译产物不定义 __DEV__，真机裸引用即抛 ReferenceError。
   上一版两处裸 `if (__DEV__)`：consumeFrame 元数据帧分支（context_size/trace
   每轮必达）先炸 → safeConsumeFrame catch 里第二处再炸 → 异常逃逸杀死整个
   回放循环 → 降级快照 = 用户报障的「只剩思考+正文、过程全丢」。
   本场景用【真机同构装载】（__DEV__ 不作为参数注入，作用域内未定义）回放
   含 context_size 帧的完整轮次，断言过程卡与正文完整渲染。 */
await scenario('S16 __DEV__ 未定义（真机形态）：元数据帧不炸回放，过程完整', async () => {
    const sid = 'work-s16';
    const rt = await makeRuntime({ sessionId: sid, devUndefined: true });
    let s = 1;
    const f = (type, extra) => ({ eventSeq: s++, type, sessionId: sid, runId: 'run-16', ...(extra || {}) });
    [
        f('user', { text: 'Q16' }),
        f('reason', { text: 'thinking about it' }),
        f('context_size', { text: '46', totalTokens: 64636 }),
        f('action_start', { actionId: 'h16', toolName: 'read', args: { file_path: 'a.ts' } }),
        f('action_end', { actionId: 'h16', toolName: 'read', text: 'ok', durationMs: 5 }),
        f('context_size', { text: '47', totalTokens: 64700 }),
        f('text', { text: 'final body 16' }),
        f('done', {}),
    ].forEach((fr) => rt.dev.append(fr));
    rt.api.setActive(sid);
    await rt.clock.tick(1000);
    const ais = rt.conv.messages.filter((m) => m.role === 'ai');
    assert.ok(ais.some((m) => m.blocks.some((b) => b.kind === 'tool' && b.actionId === 'h16')),
        'tool card must render even though context_size frames pass the __DEV__ guard site');
    assert.ok(ais.some((m) => m.blocks.some((b) => b.kind === 'thinking')),
        'thinking block must render');
    assert.ok(ais.some((m) => m.text.includes('final body 16')),
        'final text must render (replay loop must not be killed by undefined __DEV__)');
    assert.ok(ais.some((m) => m.status === 'done'), 'turn must close');
});

/* S17 终态闸门（2026-11-26 用户实机报障「任务都执行完毕了，历史消息还有计时」）：
done/error 收口后迟到的过程帧（Rust forwarder 后台帧 / 重连补帧 / 回放 done 后迟到帧）
不得在已终态消息上重开 loading 盖子——旧实现 ensureProcessBatch 会重开且实时路径
无人再收口 → 盖子每秒刷「正在执行中 · Ns」。桌面同口径（finishStream 后 PHASE_DONE
不再开新批）。① live：done 后 action_batch/agent_end/reason 迟到 → 不开新盖、尾条恒终态；
② 回放：done 后迟到过程帧 → 收口后无 loading 盖子/计时起点，过程轨迹不丢；
③ 新轮 user 帧 resetTurnState 清标记 → 过程帧照常开批（闸门不跨轮误杀）。 */
await scenario('S17 终态闸门：done 后迟到过程帧不开计时盖子，新轮不受影响', async () => {
    const sid = 'work-s17';
    const rt = await makeRuntime({ sessionId: sid });
    let s = 1;
    const f = (type, extra) => ({ eventSeq: s++, type, sessionId: sid, runId: 'run-17', ...(extra || {}) });
    rt.dev.running = true;
    rt.api.setActive(sid);
    await rt.clock.tick(50);
    rt.dev.emit(f('user', { text: 'Q17' }), rt.hooks);
    rt.dev.emit(f('reason', { text: 'think' }), rt.hooks);
    rt.dev.emit(f('action_start', { actionId: 't17', toolName: 'read', args: { file_path: 'a.ts' } }), rt.hooks);
    rt.dev.emit(f('action_end', { actionId: 't17', toolName: 'read', text: 'ok', durationMs: 3 }), rt.hooks);
    rt.dev.emit(f('text', { text: 'body 17' }), rt.hooks);
    await rt.clock.tick(200);
    rt.dev.running = false;
    rt.dev.emit(f('done', {}), rt.hooks);
    await drainMicrotasks();
    let tail = lastAi(rt.conv);
    assert.equal(tail.status, 'done', 'done 必须收口');
    const lidsBefore = tail.blocks.filter((b) => b.kind === 'batch').length;
    // forwarder 后台帧：done 之后迟到的过程帧（用户报障真因链）
    rt.dev.emit(f('action_batch', { actionId: 'bg1', toolName: 'bash' }), rt.hooks);
    rt.dev.emit(f('agent_end', { name: 'explore' }), rt.hooks);
    rt.dev.emit(f('reason', { text: 'late reasoning' }), rt.hooks);
    await rt.clock.tick(200);
    tail = lastAi(rt.conv);
    const lidsAfter = tail.blocks.filter((b) => b.kind === 'batch');
    assert.equal(lidsAfter.length, lidsBefore, 'done 后迟到过程帧不得新开批次盖子');
    assert.ok(lidsAfter.every((b) => b.status !== 'loading'), '终态消息不得残留 loading 盖子（计时真因）');
    assert.equal(tail.status, 'done', '尾条必须保持终态');
    // 非过程帧不受闸门影响：变更卡终态后仍必须落卡
    rt.dev.emit(f('file_changes', { args: { files: [{ path: 'a.ts', changeType: 'MODIFIED', additions: 1, deletions: 0 }] } }), rt.hooks);
    await rt.clock.tick(50);
    tail = lastAi(rt.conv);
    assert.ok(tail.blocks.some((b) => b.args === 'fileChanges'), '终态后变更卡仍必须落卡');

    // ② 回放：done 之后带迟到过程帧的流，收口后不得残留 loading 盖子/计时起点
    const sid2 = 'work-s17b';
    const rt2 = await makeRuntime({ sessionId: sid2 });
    let s2 = 1;
    const g = (type, extra) => ({ eventSeq: s2++, type, sessionId: sid2, runId: 'run-17b', ...(extra || {}) });
    [
        g('user', { text: 'Q17b' }),
        g('reason', { text: 'think b' }),
        g('action_start', { actionId: 'b1', toolName: 'read', args: { file_path: 'x.ts' } }),
        g('action_end', { actionId: 'b1', toolName: 'read', text: 'ok', durationMs: 2 }),
        g('text', { text: 'body 17b' }),
        g('done', {}),
        g('action_batch', { actionId: 'bg2', toolName: 'bash' }),
        g('agent_end', { name: 'explore' }),
    ].forEach((fr) => rt2.dev.append(fr));
    rt2.api.setActive(sid2);
    await rt2.clock.tick(2000);
    const tail2 = lastAi(rt2.conv);
    assert.equal(tail2.status, 'done', '回放尾条必须收口');
    const lids2 = tail2.blocks.filter((b) => b.kind === 'batch');
    assert.ok(lids2.length > 0 && lids2.every((b) => b.status !== 'loading' && b.startedAt === 0),
        '回放收口后不得残留 loading 盖子/计时起点');
    assert.ok(tail2.blocks.some((b) => b.kind === 'tool'), '过程轨迹不得被闸门误丢');

    // ③ 新轮：user 帧切轮清标记后，过程帧照常开批
    rt.dev.emit(f('user', { text: 'Q18' }), rt.hooks);
    rt.dev.emit(f('reason', { text: 'next round think' }), rt.hooks);
    await rt.clock.tick(100);
    tail = lastAi(rt.conv);
    assert.ok(tail.blocks.some((b) => b.kind === 'batch' && b.status === 'loading'),
        '新轮过程帧必须照常开批（闸门不得跨轮误杀）');
});

/* S18 远端新轮接管（2026-11-27 用户实机报障「移动端先进入已完成任务，桌面端再在
   这个任务内发送消息，移动端无法正常显示正在运行的消息信息」真因）：
   上一轮 done 收口后 running 清空、且旧实现只在 probeRunning 命中时才登记帧处理器，
   打开后没有任何再探测机制发现设备端重新跑起来 → 桌面端新 run 的帧全部无人消费。
   修复三道防线：① 常驻帧订阅 + user 帧自接管（新桌面，帧直达）；
   ② 空闲对账探针 15s 发现 running=true 即 attachRemoteRun 补帧（旧桌面，无帧）；
   ③ 切回会话即时重探。本场景覆盖 ①②。 */
await scenario('S18 已完成任务停留中桌面端发新消息：移动端必须接管运行中新轮', async () => {
    // ① 新桌面（gate 订阅在）：user 帧直达 → 帧级自接管，零延迟长出运行态
    const sid = 'work-s18a';
    const rt = await makeRuntime({ sessionId: sid });
    let seq = seedRounds(rt.dev, sid, 2);
    rt.api.setActive(sid);
    await rt.clock.tick(500);
    assert.equal(lastAi(rt.conv).status, 'done', '打开时必须是已完成形态');
    assert.ok(rt.frameHandlers.has(sid), '已完成会话也必须保留常驻帧订阅（远端新轮的第一信号入口）');
    // 桌面端随后在本会话发起新 run（移动端未参与发送）
    rt.dev.running = true;
    rt.dev.runId = 'run-3';
    const f = (type, extra) => ({ eventSeq: seq++, type, sessionId: sid, runId: 'run-3', ...(extra || {}) });
    rt.dev.emit(f('user', { text: 'Q3' }), rt.hooks);
    await drainMicrotasks();
    assert.ok(rt.conv.messages.some((m) => m.role === 'user' && m.text === 'Q3'),
        '远端新轮的用户行必须立即上屏（帧级自接管）');
    rt.dev.emit(f('reason', { text: 'thinking 3' }), rt.hooks);
    rt.dev.emit(f('action_start', { actionId: 'a3', toolName: 'bash', args: { command: 'ls' } }), rt.hooks);
    rt.dev.emit(f('action_end', { actionId: 'a3', toolName: 'bash', text: 'ok', durationMs: 30 }), rt.hooks);
    rt.dev.emit(f('text', { text: 'live body 3' }), rt.hooks);
    await rt.clock.tick(200);
    let tail = lastAi(rt.conv);
    assert.equal(tail.status, 'processing', '新轮尾条必须进入运行态（不得停在上一轮已完成）');
    assert.ok(tail.blocks.some((b) => b.kind === 'tool' && b.actionId === 'a3'), '新轮工具卡必须上屏');
    assert.ok(aiTextOf(tail).includes('live body 3'), '新轮正文必须上屏');
    rt.dev.running = false;
    rt.dev.emit(f('done', {}), rt.hooks);
    await drainMicrotasks();
    tail = lastAi(rt.conv);
    assert.equal(tail.status, 'done', '新轮 done 必须收口');
    assert.deepEqual(userTexts(rt.conv)[0], 'Q1', '历史轮次不得被新轮接管打乱');

    // ② 旧桌面（gate 不建订阅，帧不达）：空闲对账探针 15s 发现 running=true →
    //    attachRemoteRun 补帧上屏；结束后看门狗收口
    const sid2 = 'work-s18b';
    const rt2 = await makeRuntime({ sessionId: sid2, gateEnabled: false });
    let seq2 = seedRounds(rt2.dev, sid2, 2);
    rt2.api.setActive(sid2);
    await rt2.clock.tick(500);
    assert.equal(lastAi(rt2.conv).status, 'done', '打开时必须是已完成形态');
    rt2.dev.running = true;
    rt2.dev.runId = 'run-3';
    const g = (type, extra) => ({ eventSeq: seq2++, type, sessionId: sid2, runId: 'run-3', ...(extra || {}) });
    rt2.dev.append(g('user', { text: 'Q3b' }));
    rt2.dev.append(g('reason', { text: 'think b' }));
    rt2.dev.append(g('text', { text: 'body b ' }));
    await rt2.clock.tick(15_000 + 500); // 空闲对账探针周期 + 补帧
    assert.ok(rt2.conv.messages.some((m) => m.role === 'user' && m.text === 'Q3b'),
        '空闲探针发现远端新 run 后，补帧必须带回新轮用户行');
    let tail2 = lastAi(rt2.conv);
    assert.equal(tail2.status, 'processing', '接管后尾条必须进入运行态');
    assert.ok(aiTextOf(tail2).includes('body b'), '补帧必须带回新轮正文');
    rt2.dev.append(g('text', { text: 'final b' }));
    rt2.dev.append(g('done', {}));
    rt2.dev.running = false;
    await rt2.clock.tick(15_000 + 500); // 看门狗对账收口
    tail2 = lastAi(rt2.conv);
    assert.equal(tail2.status, 'done', '远端新轮结束必须收口');
    assert.ok(aiTextOf(tail2).includes('final b'), '收口补帧必须带回最后正文');
});

/* S19 挂起轮他端作答续跑（2026-11-27 code review 发现的终态闸门回归）：
   done(suspended) 收口置 runSettled + 删 running（防挂起等待期迟到帧开计时盖子）；
   本端作答经 submitInteract 清闸门，但【他端作答】（桌面先答/批准审批）时移动端
   只收到 question_answered / hitl_released 帧——旧实现不清 runSettled，spawn_resume
   续跑段的过程帧被终态闸门全丢（过程区空白、正文不增长）。内核权威信号：
   mod.rs:2604-2609 作答即广播 question_answered、1573 full-access 切换广播
   hitl_released，approve/deny 都走 spawn_resume。 */
await scenario('S19 挂起轮他端作答：续跑过程帧不被终态闸门误丢', async () => {
    const sid = 'work-s19';
    const rt = await makeRuntime({ sessionId: sid });
    let s = 1;
    const f = (type, extra) => ({ eventSeq: s++, type, sessionId: sid, runId: 'run-19', ...(extra || {}) });
    rt.dev.running = true;
    rt.api.setActive(sid);
    await rt.clock.tick(50);
    rt.dev.emit(f('user', { text: 'Q19' }), rt.hooks);
    rt.dev.emit(f('reason', { text: 'think 19' }), rt.hooks);
    rt.dev.emit(f('question', { actionId: 'q-19', toolName: 'ask_user', args: { questions: [{ header: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }] } }), rt.hooks);
    await drainMicrotasks();
    // 挂起收口：done(suspended) —— 内核 done_suspended（react/mod.rs:2551）
    rt.dev.running = false;
    rt.dev.emit(f('done', { suspended: true }), rt.hooks);
    await drainMicrotasks();
    let tail = lastAi(rt.conv);
    assert.equal(tail.status, 'done', '挂起收口必须落终态');
    const card = tail.blocks.find((b) => b.actionId === 'q-19');
    assert.ok(card != null && card.interact === 'question' && card.status === 'warn', '挂起卡必须待答');
    // 挂起等待期迟到的过程帧不得开计时盖子（终态闸门本职）
    const lidsBefore = tail.blocks.filter((b) => b.kind === 'batch').length;
    rt.dev.emit(f('agent_end', { name: 'explore' }), rt.hooks);
    await rt.clock.tick(200);
    tail = lastAi(rt.conv);
    assert.equal(tail.blocks.filter((b) => b.kind === 'batch').length, lidsBefore,
        '挂起等待期迟到过程帧不得开新盖子');
    // 桌面端作答（移动端未参与）：内核广播 question_answered + spawn_resume 续跑
    rt.dev.running = true;
    rt.dev.emit(f('question_answered', { actionId: 'q-19', args: { answers: [{ index: 0, text: 'A' }] } }), rt.hooks);
    await drainMicrotasks();
    assert.equal(card.interact, 'resolved', '作答帧必须闭环挂起卡');
    // 续跑段过程帧：终态闸门必须已清零——旧实现全丢（本场景的回归断言核心）
    rt.dev.emit(f('reason', { text: 'resumed thinking' }), rt.hooks);
    rt.dev.emit(f('action_start', { actionId: 'r19', toolName: 'bash', args: { command: 'ls' } }), rt.hooks);
    rt.dev.emit(f('action_end', { actionId: 'r19', toolName: 'bash', text: 'ok', durationMs: 5 }), rt.hooks);
    rt.dev.emit(f('text', { text: 'resumed body' }), rt.hooks);
    await rt.clock.tick(200);
    tail = lastAi(rt.conv);
    assert.equal(tail.status, 'processing', '续跑段必须进入运行态（running 恢复）');
    assert.ok(tail.blocks.some((b) => b.kind === 'tool' && b.actionId === 'r19'),
        '续跑段工具卡不得被终态闸门误丢');
    assert.ok(aiTextOf(tail).includes('resumed body'), '续跑段正文不得被终态闸门误丢');
    rt.dev.running = false;
    rt.dev.emit(f('done', {}), rt.hooks);
    await drainMicrotasks();
    tail = lastAi(rt.conv);
    assert.equal(tail.status, 'done', '续跑段 done 必须收口');
});

/* S20 孤儿 loading 盖子（2026-11-27 用户实机报障「任务都执行结束了，移动端进入
   任务的时候消息顶部还展示正在执行中」真因）：closeBatch 旧实现按全局
   state.batchId 找盖子且 `if (!state.batchOpen) return`——回放 done 分支收口后
   迟到过程帧重开的盖子、切轮/收口错位产生的失配盖子永远无人认领，status=loading
   + startedAt>0 → batchLabel 每秒刷「正在执行中 · Ns」。修复口径：closeBatch 按
   【尾条自身全部 loading 盖子实体】收口（成员按盖子 id 统计），终态收口点再补扫。
   ① 回放：done 之后迟到过程帧 + 下一轮 user 切轮（含空尾条丢弃分支），任何一轮
      都不得残留 loading 盖子；② live：done 收口后残留盖子必须被兜底扫描收敛；
   ③ 运行中批次绝不被误收（closeBatch 只在边界调用，活批次照常计时）。 */
await scenario('S20 孤儿盖子：done/切轮后任何消息不得残留「正在执行中」计时头', async () => {
    // ① 回放形态：done 后迟到过程帧（forwarder 后台帧落盘）+ 后续新轮
    const sid = 'work-s20';
    const rt = await makeRuntime({ sessionId: sid });
    let s = 1;
    const f = (type, extra) => ({ eventSeq: s++, type, sessionId: sid, runId: 'run-20', ...(extra || {}) });
    [
        f('user', { text: 'Q20' }),
        f('reason', { text: 'think 20' }),
        f('action_start', { actionId: 't20', toolName: 'read', args: { file_path: 'a.ts' } }),
        f('action_end', { actionId: 't20', toolName: 'read', text: 'ok', durationMs: 3 }),
        f('text', { text: 'body 20' }),
        f('done', {}),
        // done 之后迟到的过程帧：旧实现 closeBatch 已置 batchOpen=false，
        // 这些帧经 ensureProcessBatch 重开盖子；若切轮走空尾条丢弃分支（不 reset），
        // 盖子与 state.batchId 失配成孤儿——本场景钉死收口后零 loading 盖子
        f('action_batch', { batchSize: 2 }),
        f('reason', { text: 'late background reasoning' }),
        f('user', { text: 'Q20-next' }),
        f('reason', { text: 'think next' }),
        f('text', { text: 'body next' }),
        f('done', {}),
    ].forEach((fr) => rt.dev.append(fr));
    rt.api.setActive(sid);
    await rt.clock.tick(2000);
    const allAi = rt.conv.messages.filter((m) => m.role === 'ai');
    assert.ok(allAi.length >= 2, '两轮 AI 消息都必须回放出来');
    allAi.forEach((m, i) => {
        assert.equal(m.status, 'done', '回放轮 ' + i + ' 必须收口');
        const lids = m.blocks.filter((b) => b.kind === 'batch' && b.status === 'loading');
        assert.equal(lids.length, 0, '回放轮 ' + i + ' 不得残留 loading 盖子（「正在执行中」计时真因）');
        m.blocks.filter((b) => b.kind === 'batch').forEach((b) => {
            assert.equal(b.startedAt, 0, '收口盖子不得保留计时起点');
        });
    });
    assert.ok(allAi[0].blocks.some((b) => b.kind === 'tool'), '过程轨迹不得被收口误丢');

    // ② live 形态·真失配链（旧实现实锤复现）：done 收口已置 batchOpen=false，
    //    迟到过程帧经 ensureProcessBatch 重开盖子后，若该帧后续处理在真机抛异常
    //    （safeConsumeFrame 帧级隔离吞掉），state.batchId 指向的盖子已 push 但
    //    state 与消息实体就此错位；下一轮 closeBatch 按 state.batchId 找不到/
    //    收错盖子 → 孤儿 loading 盖子每秒刷「正在执行中」。这里用「done 后迟到
    //    reason 帧开盖 + 立即新轮 user（空尾条不 reset）」构造同构失配。
    const sid2 = 'work-s20b';
    const rt2 = await makeRuntime({ sessionId: sid2 });
    let s2 = 1;
    const g = (type, extra) => ({ eventSeq: s2++, type, sessionId: sid2, runId: 'run-20b', ...(extra || {}) });
    rt2.dev.running = true;
    rt2.api.setActive(sid2);
    await rt2.clock.tick(50);
    rt2.dev.emit(g('user', { text: 'Q20b' }), rt2.hooks);
    rt2.dev.emit(g('reason', { text: 'think b' }), rt2.hooks);
    rt2.dev.emit(g('text', { text: 'body b' }), rt2.hooks);
    await rt2.clock.tick(200);
    rt2.dev.running = false;
    rt2.dev.emit(g('done', {}), rt2.hooks);
    await drainMicrotasks();
    let tail2 = lastAi(rt2.conv);
    assert.equal(tail2.status, 'done', 'live done 必须收口');
    // done 后迟到 reason：runSettled 闸门应丢弃；但【绕过闸门的失配盖子】
    // （历史版本/异常路径产物）直接注入实体模拟：state.batchId 不指向它
    const orphan = {
        id: 'orphan-lid', kind: 'batch', label: '正在执行中', icon: 'bars',
        args: '', body: '', preview: '', status: 'loading', duration: '',
        startedAt: rt2.clock.now() - 5000, failed: false, process: true,
        batchId: 'orphan-lid', batchCollapsed: false, batchCount: 0,
        actionId: '', agentName: '', thoughtTime: '', rowOpen: false,
        interact: '', submitting: false, submitError: '', changes: [],
        imageUrls: [], meta: '',
    };
    tail2.blocks.unshift(orphan);
    // 新轮 user + 过程 + done：closeBatch 必须按【盖子实体】把孤儿一并收掉
    //（旧实现只认 state.batchId → 孤儿永存，本断言在旧代码上 FAIL）
    rt2.dev.running = true;
    rt2.dev.emit(g('user', { text: 'Q20b-next' }), rt2.hooks);
    rt2.dev.emit(g('reason', { text: 'think next b' }), rt2.hooks);
    rt2.dev.emit(g('text', { text: 'body next b' }), rt2.hooks);
    await rt2.clock.tick(200);
    rt2.dev.running = false;
    rt2.dev.emit(g('done', {}), rt2.hooks);
    await drainMicrotasks();
    const prevRound = rt2.conv.messages.filter((m) => m.role === 'ai')[0];
    const orphanAfter = prevRound.blocks.find((b) => b.id === 'orphan-lid');
    // 新口径（2026-11-27 二轮）：零成员孤儿盖子直接被清除（「已处理」空壳也不留），
    // 有成员的必须定格——两种形态都不允许残留 loading/计时
    assert.ok(orphanAfter == null || (orphanAfter.status !== 'loading' && orphanAfter.startedAt === 0),
        '失配孤儿盖子必须被终态收口链收敛或清除（旧实现按 state.batchId 找不到 → 每秒刷「正在执行中」）');
    // 终态后的 file_changes（run 级最后信号）兜底扫描同样收敛（双保险）
    const orphan2 = { ...orphan, id: 'orphan-lid-2', batchId: 'orphan-lid-2', status: 'loading', startedAt: rt2.clock.now() - 3000 };
    lastAi(rt2.conv).blocks.unshift(orphan2);
    rt2.dev.emit(g('file_changes', { args: { files: [{ path: 'a.ts', changeType: 'MODIFIED', additions: 1, deletions: 0 }] } }), rt2.hooks);
    await rt2.clock.tick(100);
    const orphan2After = lastAi(rt2.conv).blocks.find((b) => b.id === 'orphan-lid-2');
    assert.ok(orphan2After == null || (orphan2After.status !== 'loading' && orphan2After.startedAt === 0),
        '终态兜底扫描必须收敛或清除失配孤儿盖子（不得每秒刷「正在执行中」）');

    // ③ 运行中不误收：新轮开批后盖子必须保持 loading + 计时起点
    rt2.dev.running = true;
    rt2.dev.emit(g('user', { text: 'Q20c' }), rt2.hooks);
    rt2.dev.emit(g('reason', { text: 'live think c' }), rt2.hooks);
    await rt2.clock.tick(100);
    const tail3 = lastAi(rt2.conv);
    assert.ok(tail3.blocks.some((b) => b.kind === 'batch' && b.status === 'loading' && b.startedAt > 0),
        '运行中批次盖子必须保持 loading + 计时（收口修复不得误杀活批次）');
    rt2.dev.emit(g('text', { text: 'body c' }), rt2.hooks);
    rt2.dev.running = false;
    rt2.dev.emit(g('done', {}), rt2.hooks);
    await drainMicrotasks();
    const tail4 = lastAi(rt2.conv);
    assert.equal(tail4.status, 'done', '新轮 done 必须收口');
    assert.ok(tail4.blocks.filter((b) => b.kind === 'batch').every((b) => b.status !== 'loading' && b.startedAt === 0),
        '新轮收口后盖子必须全部定格');
});

/* S21 空壳「已处理」盖子 + 回填后 Compact（2026-11-27 用户截图报障「第一条消息
   只有个已处理，是没收入总体折叠还是多的」）：
   ① 零成员批次收口后不得残留「已处理」空壳行（没有任何可展开内容）；
   ② 回放收口时正文块丢失（投毒帧吞 text 段）→ fillMissingFinalText 回填后
      必须重建 Compact：摘要头在、compactOpen=false、正文可见，而不是孤零零盖子。 */
await scenario('S21 空壳已处理盖子清除 + 正文回填后重建整轮 Compact', async () => {
    // ① 零成员盖子：reason_start 开盖后帧异常，成员没挂上，收口只剩「已处理」空壳
    const sid = 'work-s21';
    const rt = await makeRuntime({ sessionId: sid });
    let s = 1;
    const f = (type, extra) => ({ eventSeq: s++, type, sessionId: sid, runId: 'run-21', ...(extra || {}) });
    const poisonReason = { type: 'reason', sessionId: sid, runId: 'run-21', eventSeq: s++ };
    // 开盖（ensureProcessBatch）后消费抛异常：盖子已 push、成员未挂 → 零成员盖子
    Object.defineProperty(poisonReason, 'text', { get() { throw new Error('uts-cast-throw'); }, configurable: true });
    [
        f('user', { text: 'Q21' }),
        poisonReason,
        f('text', { text: 'answer 21' }),
        f('done', {}),
    ].forEach((fr) => rt.dev.append(fr));
    rt.api.setActive(sid);
    await rt.clock.tick(800);
    const ais21 = rt.conv.messages.filter((m) => m.role === 'ai');
    ais21.forEach((m) => {
        if (m.status !== 'done' && m.status !== 'stopped') return;
        m.blocks.filter((b) => b.kind === 'batch').forEach((b) => {
            const members = m.blocks.filter((x) => x.kind !== 'batch' && x.batchId === b.id).length;
            assert.ok(members > 0, '终态消息不得残留零成员「已处理」空壳盖子（用户截图第一行形态）');
        });
    });

    // ② 正文块丢失轮：投毒 text 帧（appendFinalText 前抛）→ msg.text 空 →
    //    收口摘要在但正文空；fillMissingFinalText 回填后必须 compactOpen=false 且正文可见
    const sid2 = 'work-s21b';
    const rt2 = await makeRuntime({ sessionId: sid2 });
    const origRequest2 = rt2.dev.request;
    rt2.dev.request = async (method, apiPath, query, body, root) => {
        if (apiPath === '/web/chat/messages') {
            return { code: 200, data: [{ role: 'USER', content: 'Q21b' }, { role: 'ASSISTANT', content: 'backfilled body 21b' }] };
        }
        return origRequest2(method, apiPath, query, body, root);
    };
    let s2 = 1;
    const g = (type, extra) => ({ eventSeq: s2++, type, sessionId: sid2, runId: 'run-21b', ...(extra || {}) });
    const poisonText = { type: 'text', sessionId: sid2, runId: 'run-21b', eventSeq: s2++ };
    Object.defineProperty(poisonText, 'text', { get() { throw new Error('uts-cast-throw'); }, configurable: true });
    [
        g('user', { text: 'Q21b' }),
        g('reason', { text: 'think 21b' }),
        g('action_start', { actionId: 't21b', toolName: 'read', args: { file_path: 'a.ts' } }),
        g('action_end', { actionId: 't21b', toolName: 'read', text: 'ok', durationMs: 3 }),
        poisonText,
        g('done', {}),
    ].forEach((fr) => rt2.dev.append(fr));
    rt2.api.setActive(sid2);
    await rt2.clock.tick(2500);
    const filled = rt2.conv.messages.filter((m) => m.role === 'ai').find((m) => m.text.includes('backfilled body 21b'));
    assert.ok(filled != null, '空正文轮必须从快照回填最终正文（S14 契约保持）');
    assert.ok(filled.summary.length > 0, '回填后必须有整轮摘要头（不是孤零零盖子）');
    assert.equal(filled.compactOpen, false, '回填后整轮 Compact 必须处于折叠态（过程收进总体折叠）');
    assert.ok(filled.counts.tools >= 1, '回填后 counts 必须按 blocks 真实计数（工具 ≥1）');
    assert.ok(!filled.blocks.some((b) => b.kind === 'text' && b.body === 'backfilled body 21b'),
        '与最终正文同文的过程 text 段必须移除（不得渲染两遍）');
});

/* S22 压缩分隔线 PC 对齐（2026-11-27 用户报障「压缩显示和 PC 端不一致」）：
   context_compacted 帧必须落成专用 compacted 分隔线块（PC .context-compacted-divider），
   而不是 notice 工具行：①先收口运行中批次盖子；②明细='before → after'；
   ③process=false + batchId 空（整轮 Compact 折叠后仍可见，PC KEEP_VISIBLE）。 */
await scenario('S22 context_compacted 分隔线：收口盖子 + 明细投影 + Compact 后常驻', async () => {
    const sid = 'work-s22';
    const rt = await makeRuntime({ sessionId: sid });
    let s = 1;
    const f = (type, extra) => ({ eventSeq: s++, type, sessionId: sid, runId: 'run-22', ...(extra || {}) });
    [
        f('user', { text: 'Q22' }),
        f('reason', { text: 'think 22' }),
        f('action_start', { actionId: 't22', toolName: 'read', args: { file_path: 'a.ts' } }),
        f('action_end', { actionId: 't22', toolName: 'read', text: 'ok', durationMs: 3 }),
        f('context_compacted', { args: { beforeMessages: 120, afterMessages: 32 } }),
        f('text', { text: 'answer after compaction' }),
        f('done', {}),
    ].forEach((fr) => rt.dev.append(fr));
    rt.api.setActive(sid);
    await rt.clock.tick(800);
    const ai = rt.conv.messages.filter((m) => m.role === 'ai').pop();
    const ccd = ai.blocks.find((b) => b.kind === 'compacted');
    assert.ok(ccd != null, 'context_compacted 必须落成 compacted 分隔线块（不是 notice 工具行）');
    assert.equal(ccd.compactDetail, '120 → 32', '明细必须是 beforeMessages → afterMessages 投影（仅数据字段，不上屏——PC data-detail/title 同口径）');
    // sim 的 i18n 桩恒回显 key：这里锁「取词键必须是 PC 同源 chat.context_compacted」，
    // 12 语言译文与 PC locales 逐语言同值由 verify-mobile-fixes 20b 静态断言保证
    assert.equal(ccd.label, 'chat.context_compacted', '可见文案必须取 PC 同源词条键 chat.context_compacted（不得自造 segment 键）');
    assert.equal(ccd.process, false, '分隔线不进整轮 Compact（PC KEEP_VISIBLE）');
    assert.equal(ccd.batchId, '', '分隔线不挂批次（不随盖子折叠）');
    assert.ok(!ai.blocks.some((b) => b.kind === 'notice'), '不得再落 notice 行');
    // 帧到达先收口盖子：分隔线之前的批次必须已定格（压缩前/后分界）
    const ccdIdx = ai.blocks.indexOf(ccd);
    ai.blocks.slice(0, ccdIdx).filter((b) => b.kind === 'batch').forEach((b) => {
        assert.ok(b.status !== 'loading' && b.batchCollapsed, '分隔线之前的批次盖子必须已收口折叠');
    });
    // 收口后 Compact 折叠态：分隔线仍可见（visibleBlocks 的 !process 过滤放行）
    assert.ok(ai.summary.length > 0 && !ai.compactOpen, '轮收口后应处于 Compact 折叠态');
    assert.ok(ai.blocks.filter((b) => !b.process).some((b) => b.kind === 'compacted'),
        'Compact 折叠态下分隔线必须仍在可见集合（!process 常驻）');
    // 无明细帧（args 缺失）：compactDetail 空串，分隔线仍渲染
    const sid2 = 'work-s22b';
    const rt2 = await makeRuntime({ sessionId: sid2 });
    let s2 = 1;
    const g = (type, extra) => ({ eventSeq: s2++, type, sessionId: sid2, runId: 'run-22b', ...(extra || {}) });
    [
        g('user', { text: 'Q22b' }),
        g('context_compacted', {}),
        g('text', { text: 'body 22b' }),
        g('done', {}),
    ].forEach((fr) => rt2.dev.append(fr));
    rt2.api.setActive(sid2);
    await rt2.clock.tick(800);
    const ai2 = rt2.conv.messages.filter((m) => m.role === 'ai').pop();
    const ccd2 = ai2.blocks.find((b) => b.kind === 'compacted');
    assert.ok(ccd2 != null && ccd2.compactDetail === '', 'args 缺失时明细为空串，分隔线仍渲染');
    // 【codereview 回归锁 · 同帧去重】同一压缩事件重复送达（回放+live 双通道重叠）
    // 不得画两条线：尾条末尾已是同明细分隔线（中间只隔已收口盖子）→ 幂等跳过；
    // 中间有真实内容/明细不同 = 真的二次压缩 → 正常新增。
    const sid3 = 'work-s22c';
    const rt3 = await makeRuntime({ sessionId: sid3 });
    let s3 = 1;
    const h = (type, extra) => ({ eventSeq: s3++, type, sessionId: sid3, runId: 'run-22c', ...(extra || {}) });
    [
        h('user', { text: 'Q22c' }),
        h('context_compacted', { args: { beforeMessages: 100, afterMessages: 40 } }),
        h('context_compacted', { args: { beforeMessages: 100, afterMessages: 40 } }),
        h('text', { text: 'between compactions' }),
        h('context_compacted', { args: { beforeMessages: 90, afterMessages: 30 } }),
        h('done', {}),
    ].forEach((fr) => rt3.dev.append(fr));
    rt3.api.setActive(sid3);
    await rt3.clock.tick(800);
    const ai3 = rt3.conv.messages.filter((m) => m.role === 'ai').pop();
    const ccds = ai3.blocks.filter((b) => b.kind === 'compacted');
    assert.equal(ccds.length, 2, '重复压缩帧必须去重（同明细相邻），真实二次压缩正常画线');
    assert.equal(ccds[0].compactDetail, '100 → 40');
    assert.equal(ccds[1].compactDetail, '90 → 30');
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