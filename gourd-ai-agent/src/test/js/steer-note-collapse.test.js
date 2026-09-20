/**
 * 契约测试：插话卡片（.steer-note）长文本折叠。
 *
 * 覆盖：
 * - app-message.js：steerNoteShouldCollapse 阈值（320 字 / 6 行边界）；
 *   appendSteerNote 行为（短文本原样；长文本加 .collapsed + 按钮；按钮切换展开/收起；
 *   字符超限但视觉不足 5 行时不折叠的高度校正口径；容器隐藏测不到高度时按阈值折叠；
 *   去重守卫仍最优先；正文指针推进与滚动保持原行为）
 * - app.css：折叠态限高 + 渐隐遮罩、按钮样式、--bg-card 背景兜底（104px 与 5 行对齐）
 * - 12 个语言包均提供 streaming.steer_expand_full（含 {0}）与 streaming.steer_collapse
 * - gourd-ai-tauri/ui 发布副本与 static 源保持同步（js/css/12 语言包）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const message = readStatic('js', 'app-message.js');
const appCss = readStatic('css', 'app.css');

const LOCALES = ['de', 'el', 'en', 'es', 'fr', 'ja', 'pt', 'ro', 'ru', 'vi', 'zh-CN', 'zh-TW'];

function sliceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, '未找到起始标记: ' + startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, '未找到结束标记: ' + endMarker);
    return source.slice(start, end + endMarker.length);
}

/* 从真实源码提取折叠区块（常量 + 判定 + 渲染），在沙箱中执行：
   微型 DOM/jQuery 桩只实现本区块用到的 API，行为断言全部跑真实源码逻辑。 */
const steerBlock = sliceBetween(message, '/* 插话长文本折叠', 'window.appendSteerNote = appendSteerNote;');

function createSteerSandbox(opts) {
    opts = opts || {};
    const env = {
        existingSteerIds: opts.existingSteerIds || [],
        nextTextScrollHeight: opts.textScrollHeight != null ? opts.textScrollHeight : 0,
        lineHeight: opts.lineHeight || '20.8px',
    };
    const calls = { finishThinkingBlock: 0, ensureAssistantBubble: 0, insertBeforeActions: 0, advanceBodyPointer: 0, scrollToBottom: 0 };
    let lastNote = null;

    function el(tag) {
        return {
            tagName: tag, className: '', textContent: '', innerHTML: '',
            attrs: {}, children: [], handlers: {}, scrollHeight: 0,
            setAttribute(k, v) { this.attrs[k] = v; },
            appendChild(c) { this.children.push(c); return c; },
            addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); },
        };
    }
    function wrap(elm) {
        const api = {
            0: elm,
            addClass(cls) {
                const set = (elm.className || '').split(/\s+/).filter(Boolean);
                if (set.indexOf(cls) < 0) set.push(cls);
                elm.className = set.join(' ');
                return api;
            },
            removeClass(cls) { elm.className = (elm.className || '').split(/\s+/).filter(c => c && c !== cls).join(' '); return api; },
            hasClass(cls) { return (elm.className || '').split(/\s+/).indexOf(cls) >= 0; },
            toggleClass(cls) { return api.hasClass(cls) ? api.removeClass(cls) : api.addClass(cls); },
            attr(k, v) { if (v === undefined) return elm.attrs[k]; elm.setAttribute(k, v); return api; },
            on(t, fn) { elm.addEventListener(t, fn); return api; },
            text(t) { if (t === undefined) return elm.textContent; elm.textContent = t; return api; },
            find(sel) {
                const steer = sel.match(/^\[data-steer-id="([^"]+)"\]$/);
                if (steer) return { length: env.existingSteerIds.indexOf(steer[1]) >= 0 ? 1 : 0, 0: undefined };
                if (sel === '.steer-note-text') {
                    if (!elm._textSpan) {
                        elm._textSpan = el('span');
                        elm._textSpan.scrollHeight = env.nextTextScrollHeight;
                        elm.children.push(elm._textSpan);
                    }
                    const span = elm._textSpan;
                    const f = { 0: span, length: 1, text(t) { span.textContent = t; return f; } };
                    return f;
                }
                return { length: 0, 0: undefined };
            },
        };
        return api;
    }
    function $(arg) {
        if (typeof arg === 'string') {
            const m = arg.match(/^<(\w+)>$/);
            assert.ok(m, '不支持的构造选择器: ' + arg);
            return wrap(el(m[1]));
        }
        return wrap(arg);
    }
    const sess = { container: el('div'), sessionId: 's1', activeRunId: opts.activeRunId || null };
    const win = { getComputedStyle: () => ({ lineHeight: env.lineHeight }) };
    const GourdI18n = { t: (k, p) => (p && p.length ? k + '#' + p.join(',') : k) };

    const factory = new Function(
        'window', '$', 'GourdI18n', 'escapeHtml', 'finishThinkingBlock', 'ensureAssistantBubble',
        'insertBeforeActions', 'advanceBodyPointer', 'activeSessionId', 'scrollToBottom', 'renderRoot',
        steerBlock + '\nreturn { steerNoteShouldCollapse: steerNoteShouldCollapse, appendSteerNote: appendSteerNote,'
        + ' STEER_COLLAPSE_MAX_CHARS: STEER_COLLAPSE_MAX_CHARS, STEER_COLLAPSE_MAX_LINES: STEER_COLLAPSE_MAX_LINES,'
        + ' STEER_COLLAPSE_VISIBLE_LINES: STEER_COLLAPSE_VISIBLE_LINES };'
    );
    const api = factory(
        win, $, GourdI18n, (s) => s,
        () => calls.finishThinkingBlock++,
        () => calls.ensureAssistantBubble++,
        (s, node) => { calls.insertBeforeActions++; lastNote = node; },
        () => calls.advanceBodyPointer++,
        's1',
        () => calls.scrollToBottom++,
        // 渲染落点访问器：回放期指向临时容器，平时即真实容器。此处返回会话容器替身即可
        (s) => (s && (s.renderTarget || s.container))
    );
    return { api, env, sess, calls, win, getLastNote: () => lastNote };
}

function toggleOf(note) {
    return (note.children || []).find(c => (c.className || '').split(/\s+/).indexOf('steer-note-toggle') >= 0);
}

test('steerNoteShouldCollapse：320 字 / 6 行边界判定', () => {
    const { api } = createSteerSandbox();
    assert.equal(api.STEER_COLLAPSE_MAX_CHARS, 320);
    assert.equal(api.STEER_COLLAPSE_MAX_LINES, 6);
    assert.equal(api.STEER_COLLAPSE_VISIBLE_LINES, 5);
    assert.equal(api.steerNoteShouldCollapse('短文本'), false);
    assert.equal(api.steerNoteShouldCollapse(''), false);
    assert.equal(api.steerNoteShouldCollapse(null), false);
    assert.equal(api.steerNoteShouldCollapse(undefined), false);
    assert.equal(api.steerNoteShouldCollapse('x'.repeat(320)), false, '恰好 320 字不折叠');
    assert.equal(api.steerNoteShouldCollapse('x'.repeat(321)), true, '超过 320 字折叠');
    assert.equal(api.steerNoteShouldCollapse('a\nb\nc\nd\ne\nf'), false, '恰好 6 行不折叠');
    assert.equal(api.steerNoteShouldCollapse('a\nb\nc\nd\ne\nf\ng'), true, '超过 6 行折叠');
});

test('appendSteerNote：短文本不折叠、无按钮，原有推进/滚动行为不变', () => {
    const h = createSteerSandbox();
    h.api.appendSteerNote(h.sess, { steerId: 'st1', text: '这里插一句，注意保留现有行为。' });
    const note = h.getLastNote();
    assert.ok(note, '卡片必须创建');
    assert.equal(note.attrs['data-steer-id'], 'st1');
    assert.ok(!(note.className || '').includes('collapsed'));
    assert.equal(toggleOf(note), undefined, '短文本不得出现展开按钮');
    assert.equal(h.calls.advanceBodyPointer, 1);
    assert.equal(h.calls.scrollToBottom, 1);
});

test('appendSteerNote：长文本折叠 + 按钮，点击切换展开/收起', () => {
    const h = createSteerSandbox({ textScrollHeight: 800 });
    const text = 'x'.repeat(500);
    h.api.appendSteerNote(h.sess, { steerId: 'st2', text: text });
    const note = h.getLastNote();
    assert.ok((note.className || '').includes('collapsed'), '长文本必须默认折叠');
    const btn = toggleOf(note);
    assert.ok(btn, '必须出现展开按钮');
    assert.equal(btn.attrs['aria-expanded'], 'false');
    assert.equal(btn.textContent, 'streaming.steer_expand_full#' + text.length, '按钮文案带全文字数');

    btn.handlers.click[0]();
    assert.ok(!(note.className || '').includes('collapsed'), '点击后展开');
    assert.equal(btn.attrs['aria-expanded'], 'true');
    assert.equal(btn.textContent, 'streaming.steer_collapse');

    btn.handlers.click[0]();
    assert.ok((note.className || '').includes('collapsed'), '再点后收起');
    assert.equal(btn.attrs['aria-expanded'], 'false');
    assert.equal(btn.textContent, 'streaming.steer_expand_full#' + text.length);
});

test('appendSteerNote：字符数超限但视觉不足 5 行时不折叠（高度校正口径）', () => {
    const h = createSteerSandbox({ textScrollHeight: 60 });
    h.api.appendSteerNote(h.sess, { steerId: 'st3', text: 'x'.repeat(400) });
    const note = h.getLastNote();
    assert.ok(!(note.className || '').includes('collapsed'), '视觉不足 5 行不得出现点了没变化的无效按钮');
    assert.equal(toggleOf(note), undefined);
});

test('appendSteerNote：容器隐藏（测不到高度）时按阈值折叠', () => {
    const h = createSteerSandbox({ textScrollHeight: 0 });
    h.api.appendSteerNote(h.sess, { steerId: 'st4', text: 'y'.repeat(400) });
    const note = h.getLastNote();
    assert.ok((note.className || '').includes('collapsed'), '回放/隐藏会话按阈值折叠，刷新后折叠态完整');
    assert.ok(toggleOf(note));
});

test('appendSteerNote：同 steerId 去重守卫最优先，不重复建卡', () => {
    const h = createSteerSandbox({ existingSteerIds: ['st1'] });
    h.api.appendSteerNote(h.sess, { steerId: 'st1', text: '重复帧' });
    assert.equal(h.calls.ensureAssistantBubble, 0);
    assert.equal(h.calls.insertBeforeActions, 0);
});

test('源码形态：折叠判定位于卡片插入之后、正文指针推进之前', () => {
    const iInsert = steerBlock.indexOf('insertBeforeActions(sess, note);');
    const iCollapse = steerBlock.indexOf('if (steerNoteShouldCollapse(text)) {');
    const iAdvance = steerBlock.indexOf('advanceBodyPointer(sess, sess,');
    assert.ok(iInsert >= 0 && iCollapse > iInsert && iAdvance > iCollapse,
        '折叠判定必须位于 insertBeforeActions 之后、advanceBodyPointer 之前（依赖已入 DOM 的真实高度）');
    assert.ok(!/\.text\(item\.text \|\| ''\)/.test(steerBlock), '旧的无校正文本写法不得回归');
    assert.match(steerBlock, /window\.appendSteerNote = appendSteerNote;/);
});

test('app.css：折叠限高 + 渐隐遮罩 + 按钮样式 + 背景兜底', () => {
    assert.match(appCss, /\.steer-note\.collapsed \.steer-note-text \{[^}]*max-height: 104px/);
    assert.match(appCss, /\.steer-note\.collapsed \.steer-note-text \{[^}]*mask-image/);
    assert.match(appCss, /\.steer-note-toggle \{[^}]*grid-column: 2/);
    assert.match(appCss, /\.steer-note-toggle:hover/);
    // --bg-card 在 theme.css 中未定义，必须回落到 --bg-main，否则 color-mix 失效呈透明
    assert.match(appCss, /\.steer-note \{[^}]*var\(--bg-card, var\(--bg-main\)\)/);
    const maxH = appCss.match(/\.steer-note\.collapsed \.steer-note-text \{[^}]*max-height:\s*(\d+)px/);
    assert.ok(maxH, '缺少折叠限高');
    assert.equal(Number(maxH[1]), Math.round(5 * 13 * 1.6),
        '104px 必须等于 5 行 × 13px 字号 × 1.6 行高（与 STEER_COLLAPSE_VISIBLE_LINES=5 对齐）');
});

test('12 个语言包均提供 steer_expand_full（含 {0}）与 steer_collapse', () => {
    for (const lang of LOCALES) {
        const raw = fs.readFileSync(path.join(staticRoot, 'locales', lang + '.json'), 'utf8').replace(/^\uFEFF/, '');
        const data = JSON.parse(raw);
        assert.ok(data.streaming, lang + ' 缺少 streaming 段');
        assert.ok(data.streaming.steer_expand_full && data.streaming.steer_expand_full.indexOf('{0}') >= 0,
            lang + ' steer_expand_full 缺失或缺少 {0} 占位符');
        assert.ok(data.streaming.steer_collapse, lang + ' steer_collapse 缺失');
    }
});

test('gourd-ai-tauri/ui 发布副本与 static 源保持同步（js/css/12 语言包）', () => {
    const mirrorRoot = path.resolve(__dirname, '../../../gourd-ai-tauri/ui');
    if (!fs.existsSync(mirrorRoot)) return;
    for (const parts of [['js', 'app-message.js'], ['css', 'app.css']]) {
        const src = fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
        const mirror = fs.readFileSync(path.join(mirrorRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
        assert.equal(mirror, src, 'gourd-ai-tauri/ui 副本已与 static 源不同步，请同步后再提交: ' + parts.join('/'));
    }
    for (const lang of LOCALES) {
        const rel = path.join('locales', lang + '.json');
        const src = fs.readFileSync(path.join(staticRoot, rel), 'utf8').replace(/^\uFEFF/, '');
        const mirror = fs.readFileSync(path.join(mirrorRoot, rel), 'utf8').replace(/^\uFEFF/, '');
        assert.equal(mirror, src, 'gourd-ai-tauri/ui 副本已与 static 源不同步，请同步后再提交: ' + rel);
    }
});
