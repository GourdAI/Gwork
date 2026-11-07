/**
 * 行为级测试：上下文用量明细卡接入 tps_progress 实时 TPS / TTFT。
 *
 * 帧契约（内核已实现，前端不得改）：
 *   { type:'tps_progress', sessionId, runId, eventSeq, createdAt,
 *     generationMs, generatedTokens, ttftMs|undefined, live:true }
 *   首字帧 (0,0,ttftMs) 只锁存 TTFT；之后每 ≥500ms 一帧是真实测量窗口。
 *   context_size 结算帧的 args 是权威累计值，覆盖实时值并结束 live。
 *
 * 测试分三层：
 *   ① vm 沙箱真跑 app-context.js 纯函数（buildContextRows / ctxTpsText）；
 *   ② 源码契约断言（app-streaming.js 两处前置短路、app-context.js 入口与定向 DOM 标记）；
 *   ③ 可变 $ 桩跑 DOM 行为（局部插行、定向改字、rAF 合帧、结算覆盖、语言切换重译）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const uiRoot = path.resolve(__dirname, '../ui');
const SRC = fs.readFileSync(path.join(uiRoot, 'js', 'app-context.js'), 'utf8');
const STREAMING_SRC = fs.readFileSync(path.join(uiRoot, 'js', 'app-streaming.js'), 'utf8');
const ZH = JSON.parse(fs.readFileSync(path.join(uiRoot, 'locales', 'zh-CN.json'), 'utf8'));
const EN = JSON.parse(fs.readFileSync(path.join(uiRoot, 'locales', 'en.json'), 'utf8'));

const tOf = (dict) => (k, params) => {
    let s = k.split('.').reduce((o, p) => (o && o[p] !== undefined ? o[p] : undefined), dict);
    if (typeof s !== 'string') s = k;
    if (params && typeof params === 'object') {
        for (const p in params) s = s.split('{' + p + '}').join(String(params[p]));
    }
    return s;
};

/* ===== 纯函数沙箱：与既有两个测试文件同一构造（不注入 window/document） ===== */
function pureSandbox() {
    const sandbox = {
        console, Date, Math, isFinite, parseInt, String, Number, Object,
        GourdI18n: { t: tOf(ZH) },
        $: () => ({ length: 0, find: () => ({ length: 0 }) }),
        activeSessionId: undefined
    };
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox, { filename: 'app-context.js' });
    return sandbox;
}

const chunk = (args) => ({
    type: 'context_size',
    totalTokens: 9800,
    args: Object.assign({ contextLength: 1000000, turnStartMs: 1700000000000 }, args),
    text: '6'
});

const LIVE = { generationMs: 500, generatedTokens: 40, ttftMs: 860 };

/* ===== 1. buildContextRows 的 liveMetrics 回填 ===== */
test('传 opts.liveMetrics 时 TPS/TTFT 行出现，且顺序在任务耗时之前', () => {
    const s = pureSandbox();
    // 结算快照缺 generationMs/generatedTokens/ttftMs（典型首轮实时窗口）
    const html = s.buildContextRows(chunk({}), { elapsedMs: 20000, liveMetrics: LIVE });
    const a = html.indexOf(ZH.chat.output_tps);
    const b = html.indexOf(ZH.chat.ttft);
    const c = html.indexOf(ZH.context.task_elapsed);
    assert.ok(a > 0 && b > a && c > b, '输出速度 → 首 Token 延迟 → 任务耗时');
    assert.match(html, /80 tokens\/秒/, '40 / 0.5s = 80');
    assert.match(html, /860ms/, 'TTFT 用既有 ctxTtftText');
    assert.match(html, /data-ctx-tps="1"/);
    assert.match(html, /data-ctx-ttft="1"/);
    assert.match(html, /data-ctx-tps-n="40"/);
    assert.match(html, /data-ctx-tps-ms="500"/);
    assert.match(html, /20s/, '耗时行仍按 trace 定格值显示');
    // 结构必须与 ctxRow 产出一致，不引入新 DOM 层级
    assert.match(html, /class="context-meter-row"/);
    assert.match(html, /class="context-meter-label"[^>]*>输出速度/);
    assert.match(html, /class="context-meter-value" data-ctx-tps="1"/);
});

test('liveMetrics 优先于 chunk 的旧结算值，且首字帧 (0,0) 显示 --', () => {
    const s = pureSandbox();
    const html = s.buildContextRows(chunk({
        generationMs: 4000, generatedTokens: 320, ttftMs: 5390
    }), { liveMetrics: LIVE });
    assert.ok(html.includes('80 tokens/秒'), '实时滑窗速率覆盖旧结算值');
    assert.ok(html.includes('860ms'), '实时 TTFT 覆盖旧结算值');
    assert.ok(!html.includes('5.39s'));

    const first = s.buildContextRows(chunk({}), {
        liveMetrics: { generationMs: 0, generatedTokens: 0, ttftMs: 860 }
    });
    assert.match(first, /data-ctx-tps="1"[^>]*>--</, '首字帧无速率显示 --');
    assert.match(first, /860ms/, '首字帧已锁存 TTFT');

    const noTtft = s.buildContextRows(chunk({}), {
        liveMetrics: { generationMs: 0, generatedTokens: 0, ttftMs: undefined }
    });
    assert.match(noTtft, /data-ctx-ttft="1">--</, '无 TTFT 值显示 --');
});

test('不传 liveMetrics 时行为与旧版一致（缺数据整行省略，有数据才出现）', () => {
    const s = pureSandbox();
    const empty = s.buildContextRows(chunk({}), {});
    assert.ok(!empty.includes(ZH.chat.output_tps), '缺数据整行省略');
    assert.ok(!empty.includes(ZH.chat.ttft));
    assert.ok(!empty.includes('data-ctx-tps'));
    assert.ok(!empty.includes('data-ctx-ttft'));
    // opts.live 的既有语义不动：只有它和 elapsedMs 时不影响 TPS/TTFT 行
    const liveOnly = s.buildContextRows(chunk({}), { live: true });
    assert.ok(!liveOnly.includes(ZH.chat.output_tps));
    const settled = s.buildContextRows(chunk({
        generationMs: 4000, generatedTokens: 320, ttftMs: 5390
    }), {});
    assert.match(settled, /80 tokens\/秒/);
    assert.match(settled, /5\.39s/);
    assert.ok(settled.indexOf(ZH.chat.output_tps) < settled.indexOf(ZH.chat.ttft));
});

test('ctxTpsText 既有公式不变，且非法值不产生 Infinity/NaN', () => {
    const s = pureSandbox();
    assert.equal(s.ctxTpsText({ generationMs: 1000, generatedTokens: 50 }), '50 tokens/秒');
    assert.equal(s.ctxTpsText({ generationMs: 0, generatedTokens: 50 }), '');
    assert.equal(s.ctxTpsText({}), '');
    const bad = s.buildContextRows(chunk({}), {
        liveMetrics: { generationMs: -1, generatedTokens: NaN, ttftMs: -1 }
    });
    assert.ok(!/Infinity|NaN/.test(bad));
});

/* ===== 2. 分发契约（行为验证，取代源码正则自证） ===== */
test('app-streaming.js 两处前置短路，且 dispatch 带 scope 过滤与不建陌生会话', () => {
    const hits = STREAMING_SRC.match(/chunk\.type === 'tps_progress'/g) || [];
    assert.equal(hits.length, 2, '恰好两处：dispatchGateChunk 与 onWebChunk');
    const dispatchAt = STREAMING_SRC.indexOf('function dispatchGateChunk(chunk)');
    const onWebAt = STREAMING_SRC.indexOf('function onWebChunk(sess, chunk)');
    const autoAt = STREAMING_SRC.indexOf('var sess2 = getOrCreateSession(sid);', dispatchAt);
    const lastEventAt = STREAMING_SRC.indexOf('sess.lastEventAt = Date.now();', onWebAt);
    const d = STREAMING_SRC.indexOf("chunk.type === 'tps_progress'", dispatchAt);
    const o = STREAMING_SRC.indexOf("chunk.type === 'tps_progress'", onWebAt);
    assert.ok(d > dispatchAt && d < autoAt, 'dispatch 短路必须在通用自动 streaming 分支之前');
    assert.ok(o > onWebAt && o < lastEventAt, 'onWebChunk 短路必须在通用前奏之前');
    const dispatchBody = STREAMING_SRC.slice(d, autoAt);
    for (const body of [dispatchBody, STREAMING_SRC.slice(o, lastEventAt)]) {
        assert.match(body, /window\.updateContextTpsLive/);
        assert.match(body, /return;/);
    }
    assert.match(dispatchBody, /gateFrameScopeMismatch\(chunk\)/, 'dispatch 短路必须补 scope 过滤');
    assert.match(dispatchBody, /sessionMap\[sid\]/, '迟到尾帧不得为陌生 sid 新建会话');
});

test('入口拒绝非 live 帧与已结算 run 的尾帧，且不写权威快照', () => {
    const h = domHarness();
    const sess = { sessionId: 'work-A' };
    const bad = { type: 'tps_progress', generationMs: 500, generatedTokens: 40, runId: 'run-1' };
    h.sandbox.updateContextTpsLive(sess, bad);
    assert.equal(sess._ctxLive, undefined, '缺 live:true 的脏帧不得重建实时态');
    assert.equal(h.sandbox.$('.context-meter').find('[data-ctx-tps]').length, 0);

    h.sandbox.updateContextTpsLive(sess, Object.assign({}, bad, { live: true }));
    assert.ok(sess._ctxLive, '合法实时帧进入 live');
    h.sandbox.endContextLive(sess, { runId: 'run-1' });
    assert.equal(sess._ctxLive, undefined, '结算收口清态');
    h.sandbox.updateContextTpsLive(sess, Object.assign({}, bad, { live: true }));
    assert.equal(sess._ctxLive, undefined, '已结算 run 的迟到尾帧不得复活实时值');
    assert.equal(sess.lastContextChunk, undefined, '绝不写回 lastContextChunk');

    // 新 run 的帧必须重新放行（封印只作用于旧 run）
    h.sandbox.updateContextTpsLive(sess, {
        type: 'tps_progress', live: true, runId: 'run-2',
        generationMs: 1000, generatedTokens: 50, ttftMs: 860
    });
    assert.ok(sess._ctxLive, '新 run 解除封印');
});

test('结算 / 新轮 / 恢复 / reset 统一收口：清态、取消 rAF、不复活', () => {
    const h = domHarness({ withRaf: true });
    const sess = { sessionId: 'work-A' };
    h.sandbox.updateContextTpsLive(sess, {
        type: 'tps_progress', live: true, generationMs: 500, generatedTokens: 40, ttftMs: 860
    });
    assert.equal(h.rafQueue.length, 1);
    h.sandbox.endContextLive(sess, { runId: 'run-1' });
    assert.equal(sess._ctxLive, undefined);
    assert.equal(h.rafCancelled.length, 1, '挂起的 rAF 必须取消');
    assert.equal(h.flushRaf(), 0, '取消后不再执行回调');
    assert.equal(h.sandbox.$('.context-meter').find('[data-ctx-tps]').length, 0, '旧值不落 DOM');
    // settleContextElapsed 不得清态（trace 可能早于 context_size）
    const s2 = domHarness();
    const sess2 = { sessionId: 'work-A' };
    s2.sandbox.updateContextTpsLive(sess2, {
        type: 'tps_progress', live: true, generationMs: 500, generatedTokens: 40, ttftMs: 860
    });
    s2.sandbox.settleContextElapsed(sess2, 1234);
    assert.ok(sess2._ctxLive, 'trace 定格耗时不得清实时态');
    // 恢复有快照的会话也必须清（后台结算残留不得覆盖权威值）
    const s3 = domHarness();
    const sess3 = { sessionId: 'work-A', lastContextChunk: chunk({ generationMs: 4000, generatedTokens: 320 }) };
    s3.sandbox.updateContextTpsLive(sess3, {
        type: 'tps_progress', live: true, generationMs: 500, generatedTokens: 40, ttftMs: 860
    });
    s3.sandbox.restoreContextIndicator(sess3);
    assert.equal(sess3._ctxLive, undefined, 'restore 必须结束实时态');
    assert.match(s3.bodyHtml(), /80 tokens\/秒/, '显示权威结算值而非残留滑窗值');
});

/* ===== 3. DOM 行为沙箱（可变 $ 桩，参照 history-loading.test.js 的写法） ===== */
function domHarness(opts) {
    opts = opts || {};
    opts = opts || {};
    let locale = ZH;
    const listeners = {};
    const rafQueue = [];
    const rafCancelled = [];
    const injectedHtml = [];

    function mkNode(cls, attrs) {
        const node = {
            classes: String(cls || '').split(/\s+/).filter(Boolean),
            attrs: Object.assign({}, attrs || {}),
            _text: '',
            _html: '',
            children: [],
            parent: null,
            attr(k, v) {
                if (v === undefined) return this.attrs[k];
                this.attrs[k] = String(v);
                return this;
            },
            text(v) {
                if (v === undefined) return this._text;
                this._text = String(v);
                return this;
            },
            html(v) {
                if (v === undefined) return this._html;
                this._html = String(v);
                return this;
            },
            append(html) { this._html += String(html); return this; },
            before(html) {
                if (!this.parent) return this;
                const at = this.parent.children.indexOf(this);
                // 局部插入：桩里把 HTML 解析成真实行节点，插到该行之前的容器内
                // （与真实 jQuery 的 .closest('.row').before(html) 同语义）
                injectedHtml.push(String(html));
                parseRowsAt(String(html), at, this.parent);
                return this;
            },
            closest(sel) {
                const tok = String(sel || '').replace(/^\./, '');
                for (let p = this; p; p = p.parent) {
                    if (p.classes && p.classes.includes(tok)) return wrap([p]);
                }
                return wrap([]);
            },
            addClass(c) { this.classes.push(c); return this; },
            removeClass() { return this; },
            css(k, v) {
                if (k === 'display') this.hidden = (v === 'none');
                return this;
            },
            hide() { this.hidden = true; return this; },
            empty() { this._html = ''; this.children = []; return this; },
            find(sel) { return wrap(query(this, sel)); },
        };
        return node;
    }

    const meter = mkNode('context-meter');
    meter.hidden = !!(opts && opts.hidden);
    const body = mkNode('context-meter-pop-body');
    body.parent = meter;
    meter.children.push(body);
    const elapsedRow = mkNode('context-meter-row');
    const elapsedVal = mkNode('context-meter-value', { 'data-ctx-elapsed': '1' });
    elapsedRow.children.push(elapsedVal);
    elapsedVal.parent = elapsedRow;
    elapsedRow.parent = body;
    body.children.push(elapsedRow);
    // 从 HTML 字符串生成行节点（只解析本模块产出的固定结构）
    function parseRows(html) { parseRowsAt(html, body.children.length, body); }
    function parseRowsAt(html, at, parent) {
        const nodes = [];
        const re = /<div class="context-meter-row">([\s\S]*?)<\/div>/g;
        let m;
        while ((m = re.exec(html))) {
            const row = mkNode('context-meter-row');
            const labelM = /<span class="context-meter-label"([^>]*)>/.exec(m[1]);
            const valueM = /<span class="context-meter-value"([^>]*)>([\s\S]*?)<\/span>/.exec(m[1]);
            const attrsOf = (s) => {
                const out = {};
                const ar = /([\w-]+)="([^"]*)"/g;
                let a;
                while ((a = ar.exec(s || ''))) out[a[1]] = a[2];
                return out;
            };
            if (labelM) {
                const n = mkNode('context-meter-label', attrsOf(labelM[1]));
                n.parent = row; row.children.push(n);
            }
            if (valueM) {
                const n = mkNode('context-meter-value', attrsOf(valueM[1]));
                n._text = valueM[2]; n.parent = row; row.children.push(n);
            }
            row.parent = parent;
            nodes.push(row);
        }
        parent.children.splice(at, 0, ...nodes);
    }
    function query(root, sel) {
        const out = [];
        const walk = (n) => {
            for (const c of n.children) {
                if (!c) continue;
                if (c.classes && (sel === '.' + c.classes.join('.') || c.classes.some(k => sel === '.' + k))) out.push(c);
                if (c.attrs && Object.prototype.hasOwnProperty.call(c.attrs, sel.replace(/^\[|\]$/g, ''))) out.push(c);
                if (c.children) walk(c);
            }
        };
        if (root === meter || root === body) walk(root);
        return out;
    }
    function wrap(nodes) {
        const list = Array.isArray(nodes) ? nodes : [nodes];
        const w = {
            length: list.length,
            0: list[0],
            find: (sel) => wrap(list.length ? query(list[0], sel) : []),
            closest: (sel) => {
                const tok = String(sel || '').replace(/^\./, '');
                for (let p = list[0]; p; p = p.parent) {
                    if (p.classes && p.classes.includes(tok)) return wrap([p]);
                }
                return wrap([]);
            },
            text: (v) => { if (v === undefined) return list.length ? list[0]._text : ''; list.forEach(n => n._text = String(v)); return w; },
            attr: (k, v) => {
                if (v === undefined) return list.length ? list[0].attrs[k] : undefined;
                list.forEach(n => n.attrs[k] = String(v)); return w;
            },
            html: (v) => {
                if (v === undefined) return list.length ? list[0]._html : '';
                list.forEach(n => {
                    n._html = String(v);
                    // 真实 jQuery .html() 会替换内容：先清掉旧的解析行再重建
                    if (n === body) { n.children = []; parseRows(String(v)); }
                });
                return w;
            },
            append: (v) => { list.forEach(n => { n._html += String(v); if (n === body) parseRows(String(v)); }); return w; },
            before: (v) => { list.forEach(n => n.before(v)); return w; },
            addClass: () => w, removeClass: () => w,
            css: (k, v) => { list.forEach(n => n.css(k, v)); return w; },
            hide: () => { list.forEach(n => n.hide()); return w; },
            empty: () => { list.forEach(n => n.empty()); return w; },
            _nodes: list
        };
        return w;
    }

    const sandbox = {
        console, Date, Math, isFinite, parseInt, String, Number, Object,
        GourdI18n: { t: (k, p) => tOf(locale)(k, p) },
        setInterval: () => 1,
        clearInterval: () => {},
        activeSessionId: opts.sid || 'work-A',
        document: {
            addEventListener: (ev, fn) => { listeners[ev] = fn; }
        }
    };
    sandbox.$ = (sel) => {
        if (sel === '.context-meter') return wrap([meter]);
        return wrap([]);
    };
    if (opts.withRaf) {
        // 句柄 → 回调映射：cancelAnimationFrame 必须真的把回调从队列移除，
        // 否则「取消挂起帧」的行为测试会把已取消的回调又执行一遍（假绿）。
        const rafById = new Map();
        sandbox.requestAnimationFrame = (fn) => {
            const id = rafQueue.length + 1;
            rafById.set(id, fn);
            rafQueue.push(fn);
            return id;
        };
        sandbox.cancelAnimationFrame = (h) => {
            rafCancelled.push(h);
            const fn = rafById.get(h);
            if (fn) {
                const i = rafQueue.indexOf(fn);
                if (i >= 0) rafQueue.splice(i, 1);
                rafById.delete(h);
            }
        };
    }
    vm.createContext(sandbox);
    // 真实页面里顶层函数声明自动挂到 window；沙箱需显式自引用
    sandbox.window = sandbox;
    vm.runInContext(SRC, sandbox, { filename: 'app-context.js' });
    return {
        sandbox, meter, body, listeners, rafQueue, rafCancelled,
        setLocale: (dict) => { locale = dict; },
        flushRaf: () => { const q = rafQueue.splice(0); q.forEach(fn => fn()); return q.length; },
        parseRows,
        bodyHtml: () => body._html,
        injected: () => injectedHtml.join('')
    };
}

test('全新会话首轮：卡片初始 hidden，首个实时帧必须显示卡片并落字', () => {
    const h = domHarness({ hidden: true });
    const sess = { sessionId: 'work-A', isStreaming: true };
    assert.equal(h.meter.hidden, true, 'chat.html 初始 display:none');
    h.sandbox.updateContextTpsLive(sess, {
        type: 'tps_progress', live: true, generationMs: 500,
        generatedTokens: 40, ttftMs: 860, turnStartMs: 1700000000000
    });
    assert.equal(h.meter.hidden, false, '首帧必须建立骨架并显示卡片（P1-1）');
    const tps = h.sandbox.$('.context-meter').find('[data-ctx-tps]');
    assert.equal(tps.text(), '80 tokens/秒', '首帧就能看到实时速度');
    assert.equal(h.sandbox.$('.context-meter').find('[data-ctx-ttft]').text(), '860ms');
    assert.equal(sess.lastContextChunk, undefined, '骨架绝不能污染权威快照');
    // 后续帧不得再次整卡重绘（hover 闪烁）：骨架只建一次，行数不再增加
    const rowsAfterFirst = h.body.children.length;
    h.sandbox.updateContextTpsLive(sess, {
        type: 'tps_progress', live: true, generationMs: 1000, generatedTokens: 50, ttftMs: 860
    });
    assert.equal(h.body.children.length, rowsAfterFirst, '稳态帧不得重复插行/整卡重绘');
    assert.equal(h.sandbox.$('.context-meter').find('[data-ctx-tps]').length, 1, 'TPS 行恰好一行');
    assert.equal(h.sandbox.$('.context-meter').find('[data-ctx-ttft]').length, 1, 'TTFT 行恰好一行');
    assert.equal(h.sandbox.$('.context-meter').find('[data-ctx-tps]').text(), '50 tokens/秒');
});

test('已有权威快照的会话：不建骨架，只局部插行，绝不整卡重绘', () => {
    const h = domHarness();
    // 模拟上一轮已结算：卡片已由 context_size 渲染过，含耗时行供局部插行定位
    const sess = {
        sessionId: 'work-A', isStreaming: true,
        lastContextChunk: chunk({ generationMs: 4000, generatedTokens: 320 })
    };
    h.body._html = '<div class="context-meter-row"><span class="context-meter-label">已用</span>'
        + '<span class="context-meter-value">9,800 / 1,000,000</span></div>'
        + '<div class="context-meter-row"><span class="context-meter-label">任务耗时</span>'
        + '<span class="context-meter-value" data-ctx-elapsed="1">1.2s</span></div>';
    h.body.children = [];
    h.parseRows(h.body._html);
    const before = h.bodyHtml();
    h.sandbox.updateContextTpsLive(sess, {
        type: 'tps_progress', generationMs: 500, generatedTokens: 40, ttftMs: 860, live: true
    });
    assert.equal(h.bodyHtml(), before, '不得整卡重绘 .context-meter-pop-body');
    assert.equal(sess._ctxLiveSkeletonDone, undefined, '有权威快照时不得建骨架');
    const injected = h.injected();
    assert.match(injected, /data-ctx-tps="1"/);
    assert.match(injected, /data-ctx-ttft="1"/);
    assert.match(injected, /80 tokens\/秒/);
    assert.match(injected, /860ms/);
    assert.match(injected, /class="context-meter-row"/);
    assert.match(injected, /class="context-meter-label"/);
    assert.match(injected, /class="context-meter-value"/);
    // 顺序：插入行在耗时行之前
    const rows = h.body.children;
    const atInjected = rows.findIndex(r => r && r.children && r.children.some(c => c.attrs && c.attrs['data-ctx-tps']));
    const atElapsed = rows.findIndex(r => r && r.children && r.children.some(c => c.attrs && c.attrs['data-ctx-elapsed']));
    assert.ok(atInjected >= 0 && atElapsed > atInjected, '两行插在任务耗时行之前');
    // vm 沙箱对象跨 realm：deepStrictEqual 会因原型不同而误判，逐字段断言
    assert.equal(sess._ctxLive.generationMs, 500);
    assert.equal(sess._ctxLive.generatedTokens, 40);
    assert.equal(sess._ctxLive.ttftMs, 860);
    assert.equal(sess.lastContextChunk.type, 'context_size', '既有权威快照不得被实时帧改写');
    assert.equal(sess.lastContextChunk.args.generatedTokens, 320, '结算值原样保留');
});

test('首字帧 (0,0) 显示 -- 并锁存 TTFT；后续帧定向改字', () => {
    const h = domHarness();
    const sess = { sessionId: 'work-A' };
    h.sandbox.updateContextTpsLive(sess, {
        type: 'tps_progress', generationMs: 0, generatedTokens: 0, ttftMs: 860, live: true
    });
    let tps = h.sandbox.$('.context-meter').find('[data-ctx-tps]');
    let ttft = h.sandbox.$('.context-meter').find('[data-ctx-ttft]');
    assert.equal(tps.text(), '--');
    assert.equal(ttft.text(), '860ms');
    assert.equal(tps.attr('data-ctx-tps-n'), '0');
    assert.equal(tps.attr('data-ctx-tps-ms'), '0');

    h.sandbox.updateContextTpsLive(sess, {
        type: 'tps_progress', generationMs: 1000, generatedTokens: 50, ttftMs: 860, live: true
    });
    tps = h.sandbox.$('.context-meter').find('[data-ctx-tps]');
    assert.equal(tps.text(), '50 tokens/秒');
    assert.equal(tps.attr('data-ctx-tps-n'), '50');
    assert.equal(tps.attr('data-ctx-tps-ms'), '1000');
    // 后续帧 ttftMs 缺失时保留已锁存值
    h.sandbox.updateContextTpsLive(sess, {
        type: 'tps_progress', generationMs: 500, generatedTokens: 20, live: true
    });
    assert.equal(sess._ctxLive.ttftMs, 860);
    assert.equal(h.sandbox.$('.context-meter').find('[data-ctx-ttft]').text(), '860ms');
});

test('后台 / 回放帧不得写单例 DOM，也不得写 sess._ctxLive', () => {
    const h = domHarness();
    const frame = { type: 'tps_progress', live: true, generationMs: 500, generatedTokens: 40, ttftMs: 860 };
    const before = h.bodyHtml();
    h.sandbox.updateContextTpsLive({ sessionId: 'work-B' }, frame);
    assert.equal(h.bodyHtml(), before, 'activeSessionId 不匹配：静默返回');
    h.sandbox.updateContextTpsLive({ sessionId: 'work-A', _replaying: true }, frame);
    assert.equal(h.bodyHtml(), before, '_replaying：静默返回');
    assert.equal(h.sandbox.$('.context-meter').find('[data-ctx-tps]').length, 0);
    assert.doesNotThrow(() => h.sandbox.updateContextTpsLive(null, frame), '异常静默');
});

test('rAF 合帧：同一动画帧内多次到达只落一次 DOM，无 rAF 时同步回退', () => {
    const h = domHarness({ withRaf: true });
    const sess = { sessionId: 'work-A' };
    for (let i = 1; i <= 3; i++) {
        h.sandbox.updateContextTpsLive(sess, {
            type: 'tps_progress', generationMs: 500 * i, generatedTokens: 40 * i, ttftMs: 860, live: true
        });
    }
    assert.equal(h.rafQueue.length, 1, '三次到达只注册一个 rAF');
    assert.equal(h.sandbox.$('.context-meter').find('[data-ctx-tps]').length, 0, 'rAF 前不动 DOM');
    assert.equal(h.flushRaf(), 1);
    const tps = h.sandbox.$('.context-meter').find('[data-ctx-tps]');
    assert.equal(tps.text(), '80 tokens/秒', '取最后一帧的滑窗值');
    assert.equal(tps.attr('data-ctx-tps-n'), '120');
    const sync = domHarness();  // 不注入 requestAnimationFrame
    sync.sandbox.updateContextTpsLive(sess, {
        type: 'tps_progress', generationMs: 1000, generatedTokens: 50, live: true
    });
    assert.equal(sync.sandbox.$('.context-meter').find('[data-ctx-tps]').text(), '50 tokens/秒');
});

test('结算 context_size 覆盖实时值并结束 live；createdAt 门禁早退不清', () => {
    const h = domHarness();
    const sess = { sessionId: 'work-A' };
    h.sandbox.updateContextTpsLive(sess, {
        type: 'tps_progress', generationMs: 500, generatedTokens: 40, ttftMs: 860, live: true
    });
    assert.equal(h.sandbox.$('.context-meter').find('[data-ctx-tps]').text(), '80 tokens/秒');
    const stale = { type: 'context_size', totalTokens: 1, args: { createdAt: undefined }, createdAt: 1 };
    sess.lastContextChunk = { createdAt: 999 };
    h.sandbox.updateContextIndicator(stale, sess);
    assert.ok(sess._ctxLive, '单调门禁早退：尚无权威帧，实时值保留');
    assert.equal(sess._ctxLive.generationMs, 500);
    assert.equal(sess._ctxLive.generatedTokens, 40);
    assert.equal(sess._ctxLive.ttftMs, 860);

    h.sandbox.updateContextIndicator(Object.assign(chunk({
        generationMs: 4000, generatedTokens: 320, ttftMs: 5390
    }), { createdAt: 1000 }), sess);
    assert.equal(sess._ctxLive, undefined, '权威累计值结束 live');
    assert.equal(sess.lastContextChunk.args.generatedTokens, 320);
    // 整卡重绘后回填的是结算值（buildContextRows 走 m，不再走 liveMetrics）
    assert.match(h.bodyHtml(), /80 tokens\/秒/);
    assert.match(h.bodyHtml(), /5\.39s/);
});

test('切语言重译：行节点属性留数值，i18n:localeChanged 钩子按新语言重算', () => {
    const h = domHarness();
    const sess = { sessionId: 'work-A' };
    h.sandbox.updateContextTpsLive(sess, {
        type: 'tps_progress', generationMs: 1000, generatedTokens: 50, ttftMs: 860, live: true
    });
    assert.equal(h.sandbox.$('.context-meter').find('[data-ctx-tps]').text(), '50 tokens/秒');
    assert.equal(typeof h.listeners['i18n:localeChanged'], 'function', '钩子必须挂上');
    h.setLocale(EN);
    h.listeners['i18n:localeChanged']();
    assert.equal(h.sandbox.$('.context-meter').find('[data-ctx-tps]').text(), '50 tokens/s');
    assert.equal(h.sandbox.$('.context-meter').find('[data-ctx-tps-label]').text(), EN.chat.output_tps);
    assert.equal(h.sandbox.$('.context-meter').find('[data-ctx-ttft-label]').text(), EN.chat.ttft);
});
