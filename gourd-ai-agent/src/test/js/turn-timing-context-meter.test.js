/**
 * 契约测试：输入框工具栏重排（L1）+ 上下文用量进度圈（C1）+ 轮次耗时详情卡（T2）。
 *
 * 覆盖：
 * - chat.html：双份工具栏（欢迎页 / 对话页）左区只剩 +，模型选择器移入右区；
 *   对话页右区顺序 = 上下文环 → 模型 → 语音 → 发送；旧的 .context-status 整行已移除
 * - app.css / code.css：右区下拉改右对齐、环的 dasharray 与 JS 常量一致、
 *   dashoffset 不得由 CSS 声明（级联覆盖回归护栏）、悬停卡显隐与间隙桥接、窄屏与 code 模式收缩
 * - app-context.js（真实函数沙箱执行）：用量模型归一、进度圈 dashoffset 与分色档位、
 *   明细行 0 值省略、无数据时隐藏而非显示空环、旧帧时间戳门禁
 * - app-message.js（真实函数沙箱执行）：耗时毫秒优先/旧帧回退、TPS 扣除 TTFT 与除零防护、
 *   TTFT 格式化、详情卡只用 span（span 内嵌 div 会被 HTML 解析器拆散）、数据不足时退回原生 title
 * - 12 个语言包均提供新增键且 JSON 合法、无裸 LF、保留既有 context.length/cache 键
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
// 行尾归一：chat.html / app.css / code.css 在工作区是 CRLF，js 是 LF。
// 不归一的话跳行标记与多行正则会在 CRLF 文件上假失败（行尾本身的校验在 i18n 用例里单独做）。
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8')
    .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const chatHtml = readStatic('chat.html');
const appCss = readStatic('css', 'app.css');
const codeCss = readStatic('css', 'code.css');
const contextJs = readStatic('js', 'app-context.js');
const messageJs = readStatic('js', 'app-message.js');

const LOCALES = ['de', 'el', 'en', 'es', 'fr', 'ja', 'pt', 'ro', 'ru', 'vi', 'zh-CN', 'zh-TW'];
const CHAT_KEYS = ['turn_timing', 'elapsed_total', 'output_tps', 'ttft'];
const CTX_KEYS = ['meter_title', 'used', 'percent', 'cache_read', 'cache_write', 'turn_input', 'turn_output', 'messages'];

function sliceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `未找到起始标记: ${startMarker}`);
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, `未找到结束标记: ${endMarker}`);
    return source.slice(start, end);
}

/* ===================== 一、结构（chat.html） ===================== */

test('chat.html：对话页工具栏左区只剩 +，右区顺序为 上下文环 → 模型 → 语音 → 发送', () => {
    const toolbar = sliceBetween(chatHtml, '<div class="input-toolbar">', '<!-- 任务面板');
    const left = sliceBetween(toolbar, '<div class="toolbar-left">', '<div class="toolbar-right">');
    assert.ok(!left.includes('chatModelSelector'), '模型选择器不应再留在左区');
    assert.ok(left.includes('id="chatPlusBtn"'), '左区应保留 + 按钮');

    const right = toolbar.slice(toolbar.indexOf('<div class="toolbar-right">'));
    const order = ['id="chatContextMeter"', 'id="chatModelSelector"', 'id="chatVoiceBtn"', 'id="chatSendBtn"'];
    let prev = -1;
    for (const token of order) {
        const at = right.indexOf(token);
        assert.ok(at > prev, `右区顺序错误，${token} 未排在前一项之后`);
        prev = at;
    }
});

test('chat.html：欢迎页工具栏同构（模型移右区、左区留 +）', () => {
    const toolbar = sliceBetween(chatHtml, '<div class="welcome-toolbar">', 'welcome-message-queue-container');
    const left = sliceBetween(toolbar, '<div class="toolbar-left">', '<div class="toolbar-right">');
    assert.ok(!left.includes('welcomeModelSelector'), '欢迎页模型选择器不应留在左区');
    assert.ok(left.includes('id="welcomePlusBtn"'));

    const right = toolbar.slice(toolbar.indexOf('<div class="toolbar-right">'));
    assert.ok(right.indexOf('id="welcomeModelSelector"') >= 0, '欢迎页模型选择器应在右区');
    assert.ok(right.indexOf('id="welcomeModelSelector"') < right.indexOf('id="welcomeVoiceBtn"'));
    // 欢迎页没有会话，不展示上下文环
    assert.ok(!toolbar.includes('context-meter'), '欢迎页不应出现上下文环');
});

test('chat.html：旧的上下文文本行已移除，进度圈含环/百分比/悬停卡三件套', () => {
    assert.ok(!chatHtml.includes('class="context-status"'), '.context-status 整行应已删除');
    assert.ok(!chatHtml.includes('chatContextStatus'));

    const meter = sliceBetween(chatHtml, '<div class="context-meter"', '<div class="model-selector" id="chatModelSelector">');
    assert.match(meter, /style="display:none"/, '无数据时应默认隐藏');
    assert.match(meter, /class="context-meter-track"/);
    assert.match(meter, /class="context-meter-fill"/);
    assert.match(meter, /transform="rotate\(-90 10 10\)"/, '0% 起点须落在 12 点方向');
    assert.match(meter, /id="chatContextMeterPct"/);
    assert.match(meter, /id="chatContextMeterRows"/);
    assert.match(meter, /data-i18n-title="context\.meter_title"/);
    assert.match(meter, /data-i18n="context\.meter_title"/);

    // CSS 不再提供 dashoffset 初值（见样式侧回归护栏），空环初态改由 attribute 保证：
    // JS 运行前/无数据兜底都必须是一致的「空环 50.27」，否则满圆会闪一帧。
    const initAttr = /stroke-dashoffset="([\d.]+)"/.exec(meter);
    assert.ok(initAttr, 'fill 圆须带初始 stroke-dashoffset attribute（空环初值）');
    const jsCirc2 = /CONTEXT_RING_CIRCUMFERENCE\s*=\s*([\d.]+)/.exec(contextJs);
    assert.equal(initAttr[1], jsCirc2[1], '初始属性值须等于环周长常量');
});

/* ===================== 二、样式（app.css / code.css） ===================== */

test('app.css：右区下拉右对齐 + 环周长与 JS 常量一致 + 悬停卡桥接间隙', () => {
    assert.match(appCss, /\.toolbar-right \.model-dropdown \{ left: auto; right: 0; \}/,
        '右区模型下拉必须改右对齐，否则 320px 面板会溢出右边界');

    const ringRule = sliceBetween(appCss, '.context-meter-fill {', '}');
    const cssCirc = /stroke-dasharray:\s*([\d.]+)/.exec(ringRule);
    assert.ok(cssCirc, '环须声明 stroke-dasharray');
    const jsCirc = /CONTEXT_RING_CIRCUMFERENCE\s*=\s*([\d.]+)/.exec(contextJs);
    assert.ok(jsCirc, 'JS 须定义环周长常量');
    assert.equal(cssCirc[1], jsCirc[1], 'CSS 周长与 JS 常量必须严格相等，否则进度不准');

    // 回归护栏（真实事故）：样式表里的 stroke-dashoffset 声明会按级联优先级覆盖 JS 用 .attr()
    // 写入的 presentation attribute，把环锁死在初始值（弧永远画不出来）。进度只能由 JS 驱动，
    // 空环初值走 chat.html 的 attribute。
    assert.ok(!/[;{]\s*stroke-dashoffset\s*:/.test(ringRule),
        'CSS 不得声明 stroke-dashoffset：会覆盖 JS 写入的 presentation attribute，把进度环锁死为空');
    assert.match(ringRule, /transition:\s*stroke-dashoffset 0\.35s ease/,
        '环的过渡声明须保留：attribute 变更可触发 transition（已实证），是进度变化的动画来源');

    // 悬停/键盘聚焦均可展开；伪元素桥接间隙，避免鼠标移向卡片途中 hover 中断
    assert.match(appCss, /\.context-meter:hover \.context-meter-pop/);
    assert.match(appCss, /\.context-meter-btn:focus-visible ~ \.context-meter-pop \{ display: block; \}/);
    assert.match(appCss, /\.context-meter-pop::after \{ content: ''/);
    assert.match(appCss, /\.context-meter\.is-warn \.context-meter-fill/);
    assert.match(appCss, /\.context-meter\.is-crit \.context-meter-fill/);
    // 百分比数字平时隐藏，仅告警档现身
    assert.match(appCss, /\.context-meter-pct \{ display: none;/);
    assert.match(appCss, /\.context-meter\.is-warn \.context-meter-pct \{ display: inline;/);
});

test('app.css：trace 详情卡显隐与弱化口径（opacity 落在 trace-item 而非容器）', () => {
    assert.match(appCss, /\.msg-trace \.trace-item \{[^}]*opacity: 0\.5/,
        '视觉弱化必须放在 trace-item：放容器会让悬停展开的卡片也变半透明');
    assert.ok(!/\.msg-trace \{[^}]*opacity:/.test(appCss), '.msg-trace 容器不应再设 opacity');
    assert.match(appCss, /\.msg-trace \.trace-item:hover, \.msg-trace \.trace-item:focus-within \{ opacity: 1; \}/);
    assert.match(appCss, /\.msg-trace \.trace-item\.has-pop \{ position: relative;/);
    assert.match(appCss, /\.trace-pop \{ position: absolute; bottom: 100%; right: 0;/);
    assert.match(appCss, /\.trace-pop::after \{ content: ''/);
    // 三种触发共用同一套展现规则：hover（鼠标）/ focus-within（键盘）/ is-open（触屏点击）。
    // 缺了 is-open 那一支，触屏用户无法稳定展开/关闭卡片。
    assert.match(appCss, /\.msg-trace \.trace-item\.has-pop:hover \.trace-pop,\s*\n\.msg-trace \.trace-item\.has-pop:focus-within \.trace-pop,\s*\n\.msg-trace \.trace-item\.has-pop\.is-open \.trace-pop \{ display: block; \}/);
    // 弹层宽度需有上限，否则长语言下会溢出视口
    assert.match(appCss, /\.trace-pop \{[^}]*max-width: min\(320px, calc\(100vw - 32px\)\)/);
    // 块级布局全靠 CSS（元素是 span）
    assert.match(appCss, /\.trace-pop-row \{ display: flex;/);
});

test('app.css / code.css：窄屏与 code 模式的右区收缩，且无 .context-status 残留', () => {
    const narrow = sliceBetween(appCss, '@media (max-width: 768px) {\n    .model-dropdown.has-search', '}\n\n/* Attachments');
    assert.match(narrow, /\.toolbar-right \.model-selector-current \{ max-width: \d+px/);
    assert.match(narrow, /\.context-meter-pop \{ min-width: 0;/);

    // 注意用规则形式匹配而非裸字符串：新代码的注释里会提到旧类名 .context-status（说明迁移来源）
    assert.ok(!/\.context-status\s*[,{]/.test(appCss), 'app.css 不应再有 .context-status 规则');
    assert.ok(!/\.context-status\s*[,{]/.test(codeCss), 'code.css 不应再有 .context-status 规则');
    assert.match(codeCss, /body\.code-mode #chatView \.toolbar-right \.model-selector-current \{ max-width: \d+px/);
    assert.match(codeCss, /body\.code-mode #chatView \.context-meter-pop/);
    assert.match(codeCss, /body\.code-mode #chatView \.trace-pop/);
});

/* ===================== 三、行为：上下文进度圈（真实函数） ===================== */

function loadContextApi($) {
    const i18n = { t: (key) => key };
    const factory = new Function('$', 'GourdI18n', `${contextJs}
        return { buildContextModel, buildContextRows, renderContextMeter, restoreContextIndicator,
                 updateContextIndicator, applyContextLength, ctxFmtK, CONTEXT_RING_CIRCUMFERENCE };`);
    return factory($, i18n);
}

/** 极简 jQuery 替身：只记录 renderContextMeter 实际写入的 class / 属性 / HTML。 */
function makeMeterStub(present = true) {
    const state = { classes: new Set(), attrs: {}, texts: {}, htmls: {}, display: null, hidden: false };
    const node = {
        length: 1,
        find(sel) {
            return {
                attr: (k, v) => { state.attrs[sel + '@' + k] = v; },
                text: (v) => { state.texts[sel] = v; },
                html: (v) => { state.htmls[sel] = v; },
                empty: () => { state.htmls[sel] = ''; }
            };
        },
        removeClass(c) { String(c).split(' ').forEach((x) => state.classes.delete(x)); return node; },
        addClass(c) { state.classes.add(c); return node; },
        css(k, v) { if (k === 'display') { state.display = v; state.hidden = false; } return node; },
        hide() { state.hidden = true; return node; }
    };
    const $ = (sel) => (present && sel === '.context-meter' ? node : { length: 0 });
    return { $, state };
}

test('app-context.js：用量模型归一（messageCount 取 text 字段，缺分母不臆造占用率）', () => {
    const { $ } = makeMeterStub();
    const api = loadContextApi($);

    const m = api.buildContextModel({
        totalTokens: 46700, inputTokens: 45100, outputTokens: 1600,
        cacheReadTokens: 28700, cacheCreationTokens: 1200, cacheRate: 69.2,
        text: '38', args: { contextLength: 1000000 }
    });
    assert.equal(m.tokens, 46700);
    assert.equal(m.contextLength, 1000000);
    assert.equal(m.percent, 5);
    assert.equal(m.messageCount, 38);
    assert.equal(api.ctxFmtK(m.tokens), '46.7k');
    assert.equal(api.ctxFmtK(m.contextLength), '1m');

    const noDenom = api.buildContextModel({ totalTokens: 1234, text: 'x' });
    assert.equal(noDenom.percent, 0, '无 contextLength 时不得臆造占用率');
    assert.equal(noDenom.messageCount, 0, 'text 非数字须归零而非 NaN');
});

test('app-context.js：进度圈 dashoffset 与分色档位（含 >100% 夹取）', () => {
    const cases = [
        { percent: 0, cls: null },
        { percent: 5, cls: null },
        { percent: 60, cls: 'is-warn' },
        { percent: 85, cls: 'is-crit' },
        { percent: 140, cls: 'is-crit', clampedPct: 100 }
    ];
    for (const c of cases) {
        const { $, state } = makeMeterStub();
        const api = loadContextApi($);
        api.renderContextMeter({ totalTokens: c.percent, args: { contextLength: 100 } });

        const circ = api.CONTEXT_RING_CIRCUMFERENCE;
        const pct = c.clampedPct != null ? c.clampedPct : c.percent;
        const expect = String(Math.round(circ * (1 - pct / 100) * 100) / 100);
        assert.equal(state.attrs['.context-meter-fill@stroke-dashoffset'], expect,
            `${c.percent}% 的 dashoffset 计算错误`);
        assert.equal([...state.classes].join(','), c.cls || '', `${c.percent}% 的分色档位错误`);
        assert.equal(state.texts['.context-meter-pct'], c.percent + '%', '百分比文字应为真实值（不夹取）');
        assert.equal(state.display, '', '有数据时必须可见');
    }
});

test('app-context.js：明细行省略 0 值指标，主语义两行恒在', () => {
    const { $, state } = makeMeterStub();
    const api = loadContextApi($);

    const full = api.buildContextRows({
        totalTokens: 46700, inputTokens: 45100, outputTokens: 1600,
        cacheReadTokens: 28700, cacheCreationTokens: 1200, cacheRate: 69.2,
        text: '38', args: { contextLength: 1000000 }
    });
    for (const key of ['context.used', 'context.percent', 'context.cache_read', 'context.cache_write',
        'context.turn_input', 'context.turn_output', 'context.messages']) {
        assert.ok(full.includes(key), `完整数据应含 ${key}`);
    }
    assert.ok(full.includes('46.7k / 1m'), '已用行应为「已用 / 上限」形式');
    assert.ok(full.includes('28.7k (69.2%)'), '缓存读取应带命中率');

    const lean = api.buildContextRows({ totalTokens: 900, inputTokens: 900, outputTokens: 0, text: '0' });
    assert.ok(lean.includes('context.used') && lean.includes('context.percent'), '主语义两行恒在');
    assert.ok(!lean.includes('context.cache_read'), '缓存读取为 0 时整行省略');
    assert.ok(!lean.includes('context.cache_write'), '缓存写入为 0 时整行省略');
    assert.ok(!lean.includes('context.messages'), '消息条数为 0 时整行省略');
    assert.ok(lean.includes('--'), '无分母时上限显示占位符');

    // 渲染入口把明细写进 pop-body
    api.renderContextMeter({ totalTokens: 900, args: { contextLength: 9000 } });
    assert.ok(String(state.htmls['.context-meter-pop-body']).includes('context.used'));
});

test('app-context.js：无用量数据时隐藏整环；旧帧不得回退新帧', () => {
    const { $, state } = makeMeterStub();
    const api = loadContextApi($);

    api.restoreContextIndicator(null);
    assert.equal(state.hidden, true, '无数据必须隐藏，空环会被读成「占用 0%」');
    assert.equal(state.attrs['.context-meter-fill@stroke-dashoffset'], String(api.CONTEXT_RING_CIRCUMFERENCE));
    assert.equal(state.htmls['.context-meter-pop-body'], '');

    // 时间戳门禁：历史回放的早期小值不得覆盖已渲染的新值（取 70% 档，便于同时校验分色与环长未被回退）
    const sess = {};
    const newer = { createdAt: 2000, totalTokens: 70, args: { contextLength: 100 } };
    const older = { createdAt: 1000, totalTokens: 10, args: { contextLength: 100 } };
    api.updateContextIndicator(newer, sess);
    api.updateContextIndicator(older, sess);
    assert.equal(sess.lastContextChunk, newer, '旧帧不得覆盖会话快照');
    assert.equal([...state.classes].join(','), 'is-warn', '仍应保持新帧（70%）的档位');
    assert.equal(state.attrs['.context-meter-fill@stroke-dashoffset'],
        String(Math.round(api.CONTEXT_RING_CIRCUMFERENCE * 0.3 * 100) / 100), '环长不得被旧帧回退');
    assert.equal(state.texts['.context-meter-pct'], '70%');

    // DOM 缺失（欢迎页）时静默返回，不抛错
    const absent = loadContextApi(makeMeterStub(false).$);
    absent.renderContextMeter({ totalTokens: 1, args: { contextLength: 2 } });
    absent.restoreContextIndicator({ lastContextChunk: { totalTokens: 1 } });
});

/* ===================== 四、行为：轮次耗时详情卡（真实函数） ===================== */

function loadTraceApi() {
    const block = sliceBetween(messageJs, 'function traceEsc(s)', 'function appendTraceBadge(sess, chunk)');
    const fmtSec = sliceBetween(messageJs, '    function fmtSec(s) {', '    // 图标化');
    const factory = new Function('GourdI18n', 'TRACE_TIME_SVG', `${block}
        ${fmtSec}
        return { traceElapsedText, traceTpsText, traceTtftText, buildTracePop, fmtSec };`);
    // 单位键返回带占位符的真实模板，其余键回显键名（便于断言文案来源）
    const t = (key) => (key === 'chat.tps_unit' ? '{n} tokens/s' : key);
    return factory({ t }, '<svg class="mock-clock"></svg>');
}

test('app-message.js：耗时文本毫秒优先、亚秒不写 0s、旧历史帧回退整秒', () => {
    const api = loadTraceApi();
    assert.equal(api.traceElapsedText({ elapsedMs: 27600, elapsedSeconds: 27 }, api.fmtSec), '28s',
        '毫秒四舍五入优先于旧的向下截断');
    assert.equal(api.traceElapsedText({ elapsedMs: 420 }, api.fmtSec), '<1s');
    assert.equal(api.traceElapsedText({ elapsedMs: 95000 }, api.fmtSec), '1min 35s');
    assert.equal(api.traceElapsedText({ elapsedSeconds: 28 }, api.fmtSec), '28s', '旧帧回退整秒');
    assert.equal(api.traceElapsedText({}, api.fmtSec), null, '无任何耗时字段返回 null');
});

test('app-message.js：TPS 只用 generationMs/generatedTokens 同口径，缺失即整行省略', () => {
    const api = loadTraceApi();
    // 1410 tokens / 5s = 282 tokens/s —— 分子分母都来自「模型真正在解码」的那段
    assert.equal(api.traceTpsText({ generatedTokens: 1410, generationMs: 5000 }), '{n} tokens/s'.replace('{n}', 282));
    // 三位数取整，两位数保留一位小数
    assert.equal(api.traceTpsText({ generatedTokens: 100, generationMs: 2000 }), '{n} tokens/s'.replace('{n}', 50));
    assert.equal(api.traceTpsText({ generatedTokens: 45, generationMs: 2000 }), '{n} tokens/s'.replace('{n}', 22.5));

    // 关键回归：绝不允许用整轮累计 outputTokens 与总时长凑出一个「看起来像 TPS」的数。
    // 这两个字段统计范围不同（outputTokens 含子代理、elapsedMs 含工具执行），
    // 旧实现正是这样制造了误导性数值。
    assert.equal(api.traceTpsText({ outputTokens: 8000, elapsedMs: 30000, ttftMs: 1690 }), null,
        '仅有整轮累计口径时必须返回 null，不得退回估算');
    assert.equal(api.traceTpsText({ outputTokens: 8000, elapsedSeconds: 28 }), null);

    // 数据不足一律 null（含 0 分母、0 分子）
    assert.equal(api.traceTpsText({ generationMs: 5000 }), null);
    assert.equal(api.traceTpsText({ generatedTokens: 1410 }), null);
    assert.equal(api.traceTpsText({ generatedTokens: 0, generationMs: 5000 }), null);
    assert.equal(api.traceTpsText({ generatedTokens: 1410, generationMs: 0 }), null);
    assert.equal(api.traceTpsText({}), null);
});

test('app-message.js：TTFT 格式化（ms / 2 位小数秒），缺失时返回 null', () => {
    const api = loadTraceApi();
    assert.equal(api.traceTtftText({ ttftMs: 1690 }), '1.69s');
    assert.equal(api.traceTtftText({ ttftMs: 860 }), '860ms');
    assert.equal(api.traceTtftText({ ttftMs: 0 }), '0ms');
    assert.equal(api.traceTtftText({ ttftMs: 12345 }), '12.35s');
    assert.equal(api.traceTtftText({}), null, '旧历史帧无该字段，整行须省略');
});

test('app-message.js：详情卡只用 span、三行齐备；数据不足时退回原生 title', () => {
    const api = loadTraceApi();
    const pop = api.buildTracePop({ generatedTokens: 1410, generationMs: 5000, ttftMs: 1690 }, '28s');
    assert.ok(!/<div/.test(pop), 'span 宿主内不得出现 div，否则 HTML 解析器会把卡片抛出徽标外');
    assert.match(pop, /class="trace-pop"/);
    assert.ok(pop.includes('chat.turn_timing'), '应含标题');
    assert.ok(pop.includes('mock-clock'), '标题应复用时钟图标');
    assert.ok(pop.includes('chat.elapsed_total') && pop.includes('28s'));
    assert.ok(pop.includes('chat.output_tps') && pop.includes('282'));
    assert.ok(pop.includes('chat.ttft') && pop.includes('1.69s'));

    // 只有 TTFT 或只有 TPS 时仍建卡（有增量信息）
    assert.ok(api.buildTracePop({ ttftMs: 900 }, '3s').includes('chat.ttft'));
    assert.ok(api.buildTracePop({ generatedTokens: 50, generationMs: 5000 }, '5s').includes('chat.output_tps'));
    // 旧历史帧：两项都缺 → 不建只有一行的重复卡片
    assert.equal(api.buildTracePop({ elapsedSeconds: 28 }, '28s'), '');
    // 旧口径字段不得复活 TPS 行（防回归：曾经用整轮累计凑数）
    assert.equal(api.buildTracePop({ outputTokens: 8000, elapsedMs: 30000 }, '30s'), '');

    // 徽标装配：有卡走 has-pop + 可聚焦 + ARIA disclosure 语义，无卡退回原生 title
    const badge = sliceBetween(messageJs, 'function item(icon, val, pop)', 'var parts = []');
    assert.match(badge, /tabindex="0" role="button" aria-expanded="false"/,
        '触屏与读屏软件依赖显式语义，不能只靠 CSS :hover');
    assert.match(badge, /title="' \+ esc\(GourdI18n\.t\('chat\.elapsed_time'\)\)/);
    assert.ok(!/has-pop" tabindex/.test(badge),
        '属性拼接不得再用「三元表达式接半截引号」的写法，漏一个引号就生成破碎 HTML');
    const assemble = sliceBetween(messageJs, 'var parts = [];', 'if (parts.length === 0) return;');
    assert.match(assemble, /traceElapsedText\(chunk, fmtSec\)/);
    assert.match(assemble, /buildTracePop\(chunk, elapsedTxt\)/);
});

/* ===================== 五、新增行为：触屏开合 / 分母同步 / 历史清理 ===================== */

test('app-message.js：耗时卡支持点击开合、外部点击与 Escape 关闭', () => {
    // 纯 CSS :hover 在触屏上需要二次点击且无法关闭，必须有显式开合层
    assert.match(messageJs, /\$\(document\)\.on\('click', '\.trace-item\.has-pop'/,
        '需用 document 委托：徽标会被流式渲染与历史回放反复重建，直接绑定会失效');
    assert.match(messageJs, /function closeAllTracePops\(exceptEl\)/);
    // 开合时须同步 aria-expanded，否则读屏软件拿不到展开态
    assert.match(messageJs, /\.attr\('aria-expanded', willOpen \? 'true' : 'false'\)/);
    // 卡片内部点击（如选中数值）不得关闭卡片
    assert.match(messageJs, /if \(\$\(e\.target\)\.closest\('\.trace-pop'\)\.length\) return;/);
    // Escape 与外部点击两条关闭路径
    assert.match(messageJs, /\$\(document\)\.on\('click', function \(\) \{ closeAllTracePops\(null\); \}\)/);
    assert.match(messageJs, /e\.key === 'Escape'\) closeAllTracePops\(null\)/);
    // 键盘可达：Enter/Space 开合
    assert.match(messageJs, /e\.key === 'Enter' \|\| e\.key === ' '/);
});

test('app-context.js：切换上下文窗口后立即按新分母重算（不再等下一轮用量帧）', () => {
    const stub = makeMeterStub(true);
    const api = loadContextApi(stub.$);
    const state = stub.state;

    // 200k / 256k = 78%（告警态）
    const sess = { sessionId: 's1', lastContextChunk: { createdAt: 10, totalTokens: 200000, args: { contextLength: 256000 } } };
    api.updateContextIndicator(sess.lastContextChunk, sess);
    assert.equal(state.texts['.context-meter-pct'], '78%');
    assert.ok([...state.classes].includes('is-warn'));

    // 用户在模型下拉里改成 1M：环必须立即跟随，否则会出现
    // 「按钮已显 1M、环还按 256K 算且停在告警色」的矛盾态
    api.applyContextLength(sess, 1000000);
    assert.equal(state.texts['.context-meter-pct'], '20%', '分母须换成新窗口');
    assert.ok(![...state.classes].includes('is-warn'), '占用率降下来后告警色须清除');
    assert.equal(sess.lastContextChunk.args.contextLength, 1000000, '快照分母须同步，否则切会话回来又变旧值');
    assert.equal(sess.lastContextChunk.totalTokens, 200000, '真实用量是模型上报值，不得被窗口切换篡改');

    // 无快照 / 非法值时静默返回，不招错
    api.applyContextLength({ sessionId: 's2' }, 512000);
    api.applyContextLength(sess, 0);
    api.applyContextLength(null, 512000);
});

test('app-history.js：只有耗时徽标的助手行不得被当空壳清理', () => {
    const historyJs = readStatic('js', 'app-history.js');
    const cleanup = sliceBetween(historyJs, 'var hasContent = $bubble.find', 'if (typeof updateLoadMoreBtn');
    // 一轮「只调工具无正文」的对话，其助手行可能只剩 trace 徽标；
    // 漏算它会让这些行在「加载更多」后被删，连同耗时详情一起消失
    assert.match(cleanup, /var hasTrace = \$row\.find\('\.msg-trace'\)\.length > 0;/);
    assert.match(cleanup, /!hasContent && !hasTools && !hasThinking && !hasBadge && !hasTrace/);
});

test('app-history.js：selectContext 同步刷新进度环分母', () => {
    const historyJs = readStatic('js', 'app-history.js');
    const fn = sliceBetween(historyJs, 'function selectContext(contextLength)', '\n}');
    assert.match(fn, /applyContextLength\(/, '改窗口后必须联动重算占用率');
    assert.match(fn, /getOrCreateSession/, '须取真实会话对象，否则快照改不到');
    // 乐观更新不回滚的旧行为不得被破坏
    assert.match(fn, /renderModelUI\(\)/);
});

/* ===================== 六、i18n ===================== */

test('12 个语言包：新增键齐备、JSON 合法、无裸 LF、旧键未被破坏', () => {
    for (const lang of LOCALES) {
        const file = path.join(staticRoot, 'locales', `${lang}.json`);
        const raw = fs.readFileSync(file, 'latin1');
        assert.ok(!raw.startsWith('\u00ef\u00bb\u00bf'), `${lang}.json 不应带 BOM`);
        const crlf = (raw.match(/\r\n/g) || []).length;
        const lf = (raw.match(/\n/g) || []).length;
        assert.equal(crlf, lf, `${lang}.json 存在裸 LF（行尾混用）`);

        const json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        for (const k of CHAT_KEYS) {
            assert.ok(json.chat && typeof json.chat[k] === 'string' && json.chat[k].trim(),
                `${lang}.json 缺少 chat.${k}`);
        }
        for (const k of CTX_KEYS) {
            assert.ok(json.context && typeof json.context[k] === 'string' && json.context[k].trim(),
                `${lang}.json 缺少 context.${k}`);
        }
        assert.ok(json.chat.elapsed_time, `${lang}.json 的 chat.elapsed_time 兜底提示不应被删除`);
        assert.ok(json.context.cache && json.context.length, `${lang}.json 的既有 context 键不应被破坏`);
    }
});
