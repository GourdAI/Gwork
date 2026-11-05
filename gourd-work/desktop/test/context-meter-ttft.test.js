/**
 * 行为级测试：底部「上下文用量」明细卡的首 Token 延迟（TTFT）行。
 *
 * 用户要求把 TPS / 首 Token 延迟 / 总用时从尾部 hover 弹层收进用量卡。TPS 早已在
 * app-context.js 渲染，本轮补 TTFT：Rust 内核用 run 级 latch 测「起点 → 首个可见输出」
 * 并注入 context_size.args.ttftMs（与 TPS 同源、同落盘、同回放、同 createdAt 门禁）。
 *
 * 这里在 node:vm 沙箱里【真跑】app-context.js 的纯函数：不靠源码字符串匹配，
 * 而是断言数字、格式化口径、缺数据时的整行省略、以及新轮不串旧值。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const uiRoot = path.resolve(__dirname, '../ui');
const SRC = fs.readFileSync(path.join(uiRoot, 'js', 'app-context.js'), 'utf8');
const LOCALE = JSON.parse(fs.readFileSync(path.join(uiRoot, 'locales', 'zh-CN.json'), 'utf8'));

const sandbox = {
    console, Date, Math, isFinite, parseInt, String, Number, Object,
    GourdI18n: {
        t: (k) => k.split('.').reduce((o, p) => (o && o[p] !== undefined ? o[p] : undefined), LOCALE) || k
    },
    $: () => ({ length: 0, find: () => ({ length: 0 }) }),
    activeSessionId: undefined
};
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'app-context.js' });

const chunk = (args) => ({
    type: 'context_size',
    totalTokens: 9800,
    args: Object.assign({ contextLength: 1000000, turnStartMs: 1700000000000 }, args),
    text: '6'
});

test('内核帧带 ttftMs 时，用量卡显示「首 Token 延迟」行', () => {
    const html = sandbox.buildContextRows(chunk({
        ttftMs: 5390,
        generationMs: 4000,
        generatedTokens: 320
    }), {});
    assert.match(html, /首 Token 延迟/, '必须出现 TTFT 行（复用既有 i18n 键 chat.ttft）');
    assert.match(html, /5\.39s/, '5390ms → 5.39s');
    assert.match(html, /class="context-meter-label"[^>]*>首 Token 延迟</);
    assert.match(html, /class="context-meter-value"[^>]*>5\.39s</);
});

test('TTFT 格式化：不足 1s 用 ms，>=1s 用 2 位小数秒，0 合法', () => {
    assert.equal(sandbox.ctxTtftText({ ttftMs: 860 }), '860ms');
    assert.equal(sandbox.ctxTtftText({ ttftMs: 0 }), '0ms');
    assert.equal(sandbox.ctxTtftText({ ttftMs: 1690 }), '1.69s');
    assert.equal(sandbox.ctxTtftText({ ttftMs: 12345 }), '12.35s');
});

test('旧历史帧无 ttftMs 时整行省略（null 与「合法 0ms」必须可区分）', () => {
    const old = sandbox.buildContextRows(chunk({ generationMs: 4000, generatedTokens: 320 }), {});
    assert.ok(!old.includes('首 Token 延迟'), '无数据不得显示 TTFT 行');
    // 但 TPS 与常规行仍在
    assert.match(old, /输出速度/);
    assert.match(old, /已用/);
    // buildContextModel 用 hasOwnProperty 判存在，合法的 0 必须保留
    assert.equal(sandbox.buildContextModel(chunk({ ttftMs: 0 })).ttftMs, 0);
    assert.equal(sandbox.buildContextModel(chunk({})).ttftMs, null);
    const instant = sandbox.buildContextRows(chunk({ ttftMs: 0 }), {});
    assert.match(instant, /0ms/, '0ms 是真实首字延迟，不是缺数据');
});

test('非法/半值 ttftMs 一律省略，不把 Infinity/NaN 渲染到卡面', () => {
    for (const v of [null, undefined, -1, NaN, 'abc', Infinity]) {
        const html = sandbox.buildContextRows(chunk({ ttftMs: v }), {});
        assert.ok(!html.includes('首 Token 延迟'), '非法值不得显示: ' + String(v));
        assert.ok(!/Infinity|NaN/.test(html));
    }
});

test('三行共存且顺序稳定：输出速度 → 首 Token 延迟 → 任务耗时', () => {
    const html = sandbox.buildContextRows(chunk({
        generationMs: 4000, generatedTokens: 320, ttftMs: 5390
    }), { elapsedMs: 20000 });
    const a = html.indexOf('输出速度');
    const b = html.indexOf('首 Token 延迟');
    const c = html.indexOf('任务耗时');
    assert.ok(a > 0 && b > a && c > b, 'TPS < TTFT < 总用时');
    assert.match(html, /20s/, '任务耗时仍按 trace 定格值');
});

test('新一轮起步时 noteContextTurnStart 清理旧轮 ttftMs，避免显示旧延迟', () => {
    // 纯函数层：模拟 noteContextTurnStart 构造的新 args（它复制快照后 delete 三个键）
    const src = fs.readFileSync(path.join(uiRoot, 'js', 'app-context.js'), 'utf8');
    assert.match(src, /delete args\.ttftMs;/, '新轮重绘必须删掉旧轮 ttftMs');
    assert.match(src, /delete args\.generationMs;/);
    assert.match(src, /delete args\.generatedTokens;/);
    // 行为层：删掉后确实不显示（与缺数据用例一致，护栏不能只停在字符串）
    const fresh = sandbox.buildContextRows(chunk({
        turnStartMs: 1700000999999
    }), {});
    assert.ok(!fresh.includes('首 Token 延迟'));
});

test('12 语言包都已有 chat.ttft（不新增 i18n 键）', () => {
    const dir = path.join(uiRoot, 'locales');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 12);
    for (const f of files) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        assert.ok(j.chat && j.chat.ttft, f + ' 缺 chat.ttft');
    }
});

test('内核协议契约：context_size 帧下发 ttftMs，None 时省略', () => {
    const proto = fs.readFileSync(
        path.resolve(__dirname, '../../core/src/protocol/mod.rs'), 'utf8');
    assert.match(proto, /args\.insert\("ttftMs"/, '内核必须下发 ttftMs');
    assert.match(proto, /if let Some\(ttft\) = p\.ttft_ms/, 'None 不得下发伪造的 0');

    const react = fs.readFileSync(
        path.resolve(__dirname, '../../core/src/react/mod.rs'), 'utf8');
    assert.match(react, /ttft_ms: ttft_ms_since\(started_at, first_visible_at\)/,
        'react 必须把 run 级 TTFT 接进 context_size payload');
    assert.match(react, /fn ttft_ms_since\(/, '必须有可测的纯函数计量');
});
