/**
 * 行为级测试：上下文用量明细卡的「输出速度（TPS）」行。
 *
 * 用户报障：Rust 内核改造后输出速率不见了。根因是内核的 trace 帧只下发 elapsedMs，
 * 没有 generatedTokens/generationMs（旧 trace 弹层的速率计算字段），故改走 context_size 帧。
 * 本轮让内核把同口径的解码段累计值注入 context_size 帧的 args（与累计用量同源，
 * 天然参与历史回放与 createdAt 单调门禁），再由 app-context.js 渲染成明细卡的一行。
 *
 * 这里在 node:vm 沙箱里【真跑】app-context.js 的纯函数，而不是做源码字符串匹配：
 * 后者只能证明「函数被写了」，证明不了数字、口径或缺数据时的整行省略。
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
    console,
    Date,
    Math,
    isFinite,
    parseInt,
    String,
    Number,
    GourdI18n: {
        t: (k) => k.split('.').reduce((o, p) => (o && o[p] !== undefined ? o[p] : undefined), LOCALE) || k
    },
    // app-context.js 顶层的 jQuery 调用只在函数体内执行，纯函数测试不会触碰
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

test('内核帧带解码段累计值时，明细卡显示输出速度行', () => {
    const html = sandbox.buildContextRows(chunk({
        generationMs: 4000,
        generatedTokens: 320,
        totalInputTokens: 12300,
        totalOutputTokens: 74400,
        totalMessages: 6
    }), {});
    assert.match(html, /输出速度（TPS）/, '必须出现输出速度行（复用既有 i18n 键）');
    assert.match(html, /80 tokens\/秒/, '320 tokens / 4s = 80 tokens/s');
    // 与其余行同结构，不引入新 DOM 层级
    assert.match(html, /class="context-meter-label"[^>]*>输出速度（TPS）</);
    assert.match(html, /class="context-meter-value"[^>]*>80 tokens\/秒</);
});

test('速率按 <100 保留一位、>=100 取整，口径与原 trace 弹层一致', () => {
    const slow = sandbox.buildContextRows(chunk({ generationMs: 3000, generatedTokens: 25 }), {});
    assert.match(slow, /8\.3 tokens\/秒/, '25 / 3s ≈ 8.3');
    const fast = sandbox.buildContextRows(chunk({ generationMs: 2000, generatedTokens: 249 }), {});
    assert.match(fast, /125 tokens\/秒/, '249 / 2s = 124.5 → 125');
});

test('旧历史帧无解码段字段时整行省略，绝不拿 outputTokens ÷ elapsedMs 顶替', () => {
    const html = sandbox.buildContextRows(chunk({
        totalInputTokens: 12300, totalOutputTokens: 74400
    }), {});
    assert.ok(!html.includes('输出速度'), '缺字段时不得显示速率行');
    assert.ok(!html.includes('tokens/秒'), '更不得显示一个伪造的速率值');
    // 但累计输入/输出等常规行不能丢
    assert.match(html, /累计输入/);
    assert.match(html, /累计输出/);
});

test('半边字段 / 零分母 / 非法值一律省略，不产生 Infinity 或 0.0', () => {
    const cases = [
        { generationMs: 0, generatedTokens: 320 },
        { generationMs: 4000, generatedTokens: 0 },
        { generationMs: 4000 },
        { generatedTokens: 320 },
        { generationMs: -5, generatedTokens: 320 },
        { generationMs: 4000, generatedTokens: -1 }
    ];
    for (const c of cases) {
        const html = sandbox.buildContextRows(chunk(c), {});
        assert.ok(!html.includes('输出速度'), '非法组合不得显示：' + JSON.stringify(c));
        assert.ok(!/Infinity|NaN/.test(html), '不得把 Infinity/NaN 渲染到卡面');
    }
});

test('任务耗时与输出速度两行共存且顺序稳定（速率在耗时之前）', () => {
    const html = sandbox.buildContextRows(
        chunk({ generationMs: 4000, generatedTokens: 320 }),
        { elapsedMs: 20000 }
    );
    const atTps = html.indexOf('输出速度');
    const atElapsed = html.indexOf('任务耗时');
    assert.ok(atTps > 0 && atElapsed > atTps, '速率行必须在任务耗时行之前');
    assert.match(html, /20s/, '任务耗时仍按 trace 定格值显示');
});

test('ctxTpsText 纯函数：有效输入给文本，无效输入给空串', () => {
    assert.equal(sandbox.ctxTpsText({ generationMs: 1000, generatedTokens: 50 }), '50 tokens/秒');
    assert.equal(sandbox.ctxTpsText({ generationMs: 0, generatedTokens: 50 }), '');
    assert.equal(sandbox.ctxTpsText({}), '');
});

test('12 语言包都已有 output_tps / tps_unit（不新增 i18n 键）', () => {
    const dir = path.join(uiRoot, 'locales');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 12, '应有 12 个语言包');
    for (const f of files) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        assert.ok(j.chat && j.chat.output_tps, f + ' 缺 chat.output_tps');
        assert.ok(j.chat && j.chat.tps_unit && j.chat.tps_unit.includes('{n}'),
            f + ' 缺 chat.tps_unit 占位符');
    }
});

test('内核协议契约：context_size 帧的 args 必须注入两字段，零值时省略', () => {
    const proto = fs.readFileSync(
        path.resolve(__dirname, '../../core/src/protocol/mod.rs'), 'utf8');
    assert.match(proto, /args\.insert\("generationMs"/, '内核必须下发 generationMs');
    assert.match(proto, /args\.insert\("generatedTokens"/, '内核必须下发 generatedTokens');
    assert.match(proto, /if p\.generation_ms > 0 && p\.generated_tokens > 0/,
        '零值不得下发（否则前端会算出无穷大或 0）');
});
